// Sign-in for the MCP server: an OAuth 2.1 authorization server in front of Google, as MCP
// clients (Claude, ChatGPT, …) expect it. Nothing is stored: client registrations, codes and
// tokens are sealed values (../crypto.ts) that carry what the server needs.
//
//   GET  /.well-known/oauth-protected-resource[/mcp]  where to sign in for /mcp (RFC 9728)
//   GET  /.well-known/oauth-authorization-server      this server's endpoints (RFC 8414)
//   POST /mcp/register    dynamic client registration (RFC 7591): the client id is the sealed registration
//   GET  /mcp/authorize   the consent page: which app asks, and where it returns to
//   POST /mcp/authorize   allowed (on to Google's sign-in) or canceled (back to the app)
//   GET  /api/auth/callback?state=mcp.…  Google returns here (the redirect URI Google knows)
//   POST /mcp/token       codes and refresh tokens for access tokens
//
// Clients are registered (above) or named by a client ID metadata document: an https URL as the
// client id, whose JSON lists the client's name and redirect URIs. An access token holds a
// Google access token of the drive.file scope (only the files DolphinSlicer made) and expires
// with it; a refresh token holds Google's refresh token. Revoking DolphinSlicer's access in the
// Google account ends both.
// SPDX-License-Identifier: AGPL-3.0-or-later
import { CLIENT_ID, SCOPE } from '../../src/drive/google';
import { open, randomId, s256, seal, sealKey } from '../crypto';
import { GOOGLE_AUTH, GOOGLE_TOKEN } from '../googleAuth';

export interface OAuthEnv {
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_CLIENT_ID?: string;
}

export const MCP_SCOPE = 'presets';
const FLOW_COOKIE = 'ds_mcp_flow';
const CONSENT_COOKIE = 'ds_mcp_consent';
const CODE_TTL = 300;
const CONSENT_TTL = 1800;

/** What a client asked for at /mcp/authorize, checked. */
interface AuthRequest {
  cid: string;
  name: string;
  redirect: string;
  state: string;
  challenge: string;
  scope: string;
}
interface Registration {
  redirect_uris: string[];
  client_name: string;
}
interface Code {
  cid: string;
  redirect: string;
  challenge: string;
  scope: string;
  gat: string;
  grt: string;
  gexp: number;
  exp: number;
}
export interface AccessToken {
  aud: string;
  cid: string;
  scope: string;
  gat: string;
  exp: number;
}
interface RefreshToken {
  aud: string;
  cid: string;
  scope: string;
  grt: string;
}

const keys = new Map<string, Promise<CryptoKey>>();
function key(env: OAuthEnv, purpose: 'client' | 'consent' | 'flow' | 'code' | 'access' | 'refresh') {
  const k = `${purpose}:${env.GOOGLE_CLIENT_SECRET}`;
  if (!keys.has(k)) keys.set(k, sealKey(env.GOOGLE_CLIENT_SECRET ?? '', `dolphin-slicer mcp ${purpose} v1`));
  return keys.get(k)!;
}

export const resourceUrl = (origin: string) => `${origin}/mcp`;
export const resourceMetadataUrl = (origin: string) => `${origin}/.well-known/oauth-protected-resource/mcp`;

export const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers':
    'Authorization, Content-Type, Accept, MCP-Protocol-Version, Mcp-Method, Mcp-Name, Mcp-Session-Id, Last-Event-ID',
  'Access-Control-Expose-Headers': 'WWW-Authenticate',
};

export function json(v: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(v), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...CORS, ...headers },
  });
}

const oauthError = (error: string, description: string, status = 400) => json({ error, error_description: description }, status);

/** The access token of a request to /mcp, or null (missing, not ours, for another resource, or expired). */
export async function accessToken(env: OAuthEnv, req: Request, origin: string): Promise<AccessToken | null> {
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.get('authorization') ?? '');
  const t = m ? await open<AccessToken>(await key(env, 'access'), m[1]) : null;
  if (!t || t.aud !== resourceUrl(origin) || t.exp * 1000 <= Date.now()) return null;
  return t;
}

/** A loopback redirect URI (any port is allowed, RFC 8252). */
function loopback(u: URL) {
  return u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
}
function validRedirect(uri: string): boolean {
  try {
    const u = new URL(uri);
    return !u.hash && (u.protocol === 'https:' || loopback(u));
  } catch {
    return false;
  }
}
function redirectMatches(registered: string[], uri: string): boolean {
  if (registered.includes(uri)) return true;
  try {
    const u = new URL(uri);
    if (!loopback(u)) return false;
    return registered.some((r) => {
      const x = new URL(r);
      return loopback(x) && x.hostname === u.hostname && x.pathname === u.pathname && x.search === u.search;
    });
  } catch {
    return false;
  }
}

/** The client's name and redirect URIs: from its sealed registration or its metadata document. */
async function client(env: OAuthEnv, cid: string): Promise<Registration | null> {
  if (/^https:\/\//.test(cid)) {
    try {
      const u = new URL(cid);
      if (u.pathname === '/' || u.hash) return null;
      // Cloudflare's fetch has no redirect: 'error'; a redirect is refused here instead.
      const r = await fetch(cid, { headers: { Accept: 'application/json' }, redirect: 'manual', signal: AbortSignal.timeout(5000) });
      const text = r.status === 200 ? await r.text() : '';
      if (!text || text.length > 65536) throw new Error(`HTTP ${r.status}, ${text.length} bytes`);
      const doc = JSON.parse(text) as Partial<Registration> & { client_id?: string };
      if (doc.client_id !== cid) throw new Error(`its client_id is ${doc.client_id}`);
      // Only https and loopback redirects can be used (a desktop app may list its own scheme too).
      const uris = Array.isArray(doc.redirect_uris) ? doc.redirect_uris.filter((x) => typeof x === 'string' && validRedirect(x)) : [];
      if (!uris.length) throw new Error('no usable redirect_uris');
      return {
        redirect_uris: uris,
        client_name: typeof doc.client_name === 'string' && doc.client_name ? doc.client_name : u.host,
      };
    } catch (e) {
      console.error(`MCP client metadata ${cid}: ${(e as Error).message}`);
      return null;
    }
  }
  return open<Registration>(await key(env, 'client'), cid);
}

export function protectedResourceMetadata(origin: string) {
  return json({
    resource: resourceUrl(origin),
    authorization_servers: [origin],
    scopes_supported: [MCP_SCOPE],
    bearer_methods_supported: ['header'],
    resource_name: 'DolphinSlicer',
  });
}

export function authorizationServerMetadata(origin: string) {
  return json({
    issuer: origin,
    authorization_endpoint: `${origin}/mcp/authorize`,
    token_endpoint: `${origin}/mcp/token`,
    registration_endpoint: `${origin}/mcp/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: [MCP_SCOPE],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
  });
}

export async function register(env: OAuthEnv, req: Request): Promise<Response> {
  let body: Partial<Registration> & Record<string, unknown>;
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return oauthError('invalid_client_metadata', 'The body is not JSON');
  }
  const uris = body.redirect_uris;
  if (!Array.isArray(uris) || !uris.length || uris.length > 10 || !uris.every((u) => typeof u === 'string' && validRedirect(u)))
    return oauthError('invalid_redirect_uri', 'Redirect URIs must be https or loopback http URLs');
  const name =
    typeof body.client_name === 'string' && body.client_name.trim() ? body.client_name.trim().slice(0, 80) : new URL(uris[0]!).host;
  const reg: Registration = { redirect_uris: uris, client_name: name };
  const cid = await seal(await key(env, 'client'), JSON.stringify(reg));
  return json(
    {
      client_id: cid,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_name: name,
      redirect_uris: uris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    },
    201,
  );
}

function back(redirect: string, params: Record<string, string>, origin: string, headers = new Headers()) {
  const u = new URL(redirect);
  for (const [k, v] of Object.entries({ ...params, iss: origin })) u.searchParams.set(k, v);
  headers.set('Location', u.toString());
  headers.set('Cache-Control', 'no-store');
  return new Response(null, { status: 302, headers });
}

/** GET /mcp/authorize: check the request, then ask the user. */
export async function authorize(env: OAuthEnv, req: Request, origin: string): Promise<Response> {
  const q = new URL(req.url).searchParams;
  const cid = q.get('client_id') ?? '';
  const redirect = q.get('redirect_uri') ?? '';
  const reg = cid ? await client(env, cid) : null;
  // Without a known client and one of its redirect URIs, nothing may be sent back: show the error.
  if (!reg) return page('This app is not registered correctly.', 400);
  if (!redirectMatches(reg.redirect_uris, redirect)) return page('This app asked to return to an address it did not register.', 400);
  const state = q.get('state') ?? '';
  const fail = (error: string, description: string) =>
    back(redirect, { error, error_description: description, ...(state ? { state } : {}) }, origin);
  if (q.get('response_type') !== 'code') return fail('unsupported_response_type', 'Only the code flow is supported');
  const challenge = q.get('code_challenge') ?? '';
  if (q.get('code_challenge_method') !== 'S256' || !/^[\w-]{43,128}$/.test(challenge))
    return fail('invalid_request', 'PKCE with S256 is required');
  const resource = q.get('resource');
  if (resource && resource.replace(/\/$/, '') !== resourceUrl(origin))
    return fail('invalid_target', `The resource is ${resourceUrl(origin)}`);
  const request: AuthRequest = { cid, name: reg.client_name, redirect, state, challenge, scope: MCP_SCOPE };
  const nonce = randomId(16);
  const sealed = await seal(await key(env, 'consent'), JSON.stringify({ request, nonce, exp: Date.now() / 1000 + CONSENT_TTL }));
  const to = new URL(redirect);
  return page(
    null,
    200,
    { name: reg.client_name, host: to.host, origin: to.origin, sealed },
    `${CONSENT_COOKIE}=${nonce}; Max-Age=${CONSENT_TTL}; Path=/mcp/authorize; HttpOnly; Secure; SameSite=Strict`,
  );
}

/** POST /mcp/authorize: the user's answer. */
export async function consent(env: OAuthEnv, req: Request, origin: string): Promise<Response> {
  const form = await req.formData().catch(() => null);
  const c = await open<{ request: AuthRequest; nonce: string; exp: number }>(await key(env, 'consent'), String(form?.get('request') ?? ''));
  const nonce = /(?:^|;\s*)ds_mcp_consent=([\w-]+)/.exec(req.headers.get('cookie') ?? '')?.[1];
  // Only this browser's own consent page (the cookie it set) counts.
  if (!c || c.exp < Date.now() / 1000 || !nonce || nonce !== c.nonce) return page('This page has expired. Start again from your app.', 400);
  const r = c.request;
  const headers = new Headers({ 'Set-Cookie': `${CONSENT_COOKIE}=; Max-Age=0; Path=/mcp/authorize; HttpOnly; Secure; SameSite=Strict` });
  if (form?.get('allow') !== '1')
    return back(r.redirect, { error: 'access_denied', ...(r.state ? { state: r.state } : {}) }, origin, headers);
  const verifier = randomId();
  const state = `mcp.${randomId(16)}`;
  const flow = await seal(await key(env, 'flow'), JSON.stringify({ request: r, verifier, state }));
  headers.append('Set-Cookie', `${FLOW_COOKIE}=${flow}; Max-Age=900; Path=/api/auth; HttpOnly; Secure; SameSite=Lax`);
  const g = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID || CLIENT_ID,
    redirect_uri: `${origin}/api/auth/callback`,
    response_type: 'code',
    scope: SCOPE,
    state,
    access_type: 'offline',
    // Each connected app gets its own refresh token.
    prompt: 'consent',
    code_challenge: await s256(verifier),
    code_challenge_method: 'S256',
  });
  headers.set('Location', `${GOOGLE_AUTH}?${g}`);
  headers.set('Cache-Control', 'no-store');
  return new Response(null, { status: 302, headers });
}

/** Google's answer to an MCP sign-in (state "mcp.…"), at the app's registered callback. */
export async function callback(env: OAuthEnv, req: Request, origin: string): Promise<Response> {
  const url = new URL(req.url);
  const sealed = /(?:^|;\s*)ds_mcp_flow=([\w-]+)/.exec(req.headers.get('cookie') ?? '')?.[1];
  const flow = await open<{ request: AuthRequest; verifier: string; state: string }>(await key(env, 'flow'), sealed);
  if (!flow || flow.state !== url.searchParams.get('state')) return page('This sign-in has expired. Start again from your app.', 400);
  const r = flow.request;
  const headers = new Headers({ 'Set-Cookie': `${FLOW_COOKIE}=; Max-Age=0; Path=/api/auth; HttpOnly; Secure; SameSite=Lax` });
  const st: Record<string, string> = r.state ? { state: r.state } : {};
  if (url.searchParams.get('error')) return back(r.redirect, { error: 'access_denied', ...st }, origin, headers);
  const t = await fetch(GOOGLE_TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code: url.searchParams.get('code') ?? '',
      client_id: env.GOOGLE_CLIENT_ID || CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET ?? '',
      redirect_uri: `${origin}/api/auth/callback`,
      grant_type: 'authorization_code',
      code_verifier: flow.verifier,
    }),
  })
    .then((x) => (x.ok ? (x.json() as Promise<GoogleTokens>) : null))
    .catch(() => null);
  if (!t?.access_token || !t.refresh_token)
    return back(r.redirect, { error: 'server_error', error_description: 'Google sign-in failed', ...st }, origin, headers);
  if (!(t.scope ?? '').split(' ').includes(SCOPE))
    return back(r.redirect, { error: 'access_denied', error_description: 'Google Drive access was not granted', ...st }, origin, headers);
  const now = Date.now() / 1000;
  const code: Code = {
    cid: r.cid,
    redirect: r.redirect,
    challenge: r.challenge,
    scope: r.scope,
    gat: t.access_token,
    grt: t.refresh_token,
    gexp: now + (t.expires_in ?? 3600),
    exp: now + CODE_TTL,
  };
  return back(r.redirect, { code: await seal(await key(env, 'code'), JSON.stringify(code)), ...st }, origin, headers);
}

interface GoogleTokens {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
}

async function tokens(env: OAuthEnv, origin: string, cid: string, scope: string, gat: string, gexp: number, grt: string) {
  const aud = resourceUrl(origin);
  // A minute early, so a request never reaches Google with an expired token.
  const exp = Math.floor(gexp - 60);
  const access: AccessToken = { aud, cid, scope, gat, exp };
  const refresh: RefreshToken = { aud, cid, scope, grt };
  return json({
    access_token: await seal(await key(env, 'access'), JSON.stringify(access)),
    token_type: 'Bearer',
    expires_in: Math.max(0, Math.floor(exp - Date.now() / 1000)),
    refresh_token: await seal(await key(env, 'refresh'), JSON.stringify(refresh)),
    scope,
  });
}

/** POST /mcp/token */
export async function token(env: OAuthEnv, req: Request, origin: string): Promise<Response> {
  const form = await req.formData().catch(() => null);
  if (!form) return oauthError('invalid_request', 'Expected a form body');
  const f = (k: string) => String(form.get(k) ?? '');
  const resource = f('resource');
  if (resource && resource.replace(/\/$/, '') !== resourceUrl(origin))
    return oauthError('invalid_target', `The resource is ${resourceUrl(origin)}`);
  const grant = f('grant_type');
  if (grant === 'authorization_code') {
    const c = await open<Code>(await key(env, 'code'), f('code'));
    if (!c || c.exp < Date.now() / 1000) return oauthError('invalid_grant', 'The code is invalid or expired');
    if (c.cid !== f('client_id') || c.redirect !== f('redirect_uri'))
      return oauthError('invalid_grant', 'The code was issued to another client');
    if (!f('code_verifier') || (await s256(f('code_verifier'))) !== c.challenge)
      return oauthError('invalid_grant', 'PKCE verification failed');
    return tokens(env, origin, c.cid, c.scope, c.gat, c.gexp, c.grt);
  }
  if (grant === 'refresh_token') {
    const r = await open<RefreshToken>(await key(env, 'refresh'), f('refresh_token'));
    if (!r || r.aud !== resourceUrl(origin)) return oauthError('invalid_grant', 'The refresh token is invalid');
    if (f('client_id') && f('client_id') !== r.cid) return oauthError('invalid_grant', 'The refresh token was issued to another client');
    const g = await fetch(GOOGLE_TOKEN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        refresh_token: r.grt,
        client_id: env.GOOGLE_CLIENT_ID || CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET ?? '',
        grant_type: 'refresh_token',
      }),
    });
    // Revoked in the Google account, or expired: the app has to sign in again.
    if (g.status === 400 || g.status === 401) return oauthError('invalid_grant', 'Access was revoked; sign in again');
    if (!g.ok) return oauthError('temporarily_unavailable', 'Google is not available', 503);
    const t = (await g.json()) as GoogleTokens;
    return tokens(env, origin, r.cid, r.scope, t.access_token ?? '', Date.now() / 1000 + (t.expires_in ?? 3600), t.refresh_token ?? r.grt);
  }
  return oauthError('unsupported_grant_type', 'Use authorization_code or refresh_token');
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The consent page, or an error page. */
function page(
  error: string | null,
  status: number,
  ask?: { name: string; host: string; origin: string; sealed: string },
  cookie?: string,
): Response {
  const body = ask
    ? `<h1>Connect ${esc(ask.name)} to DolphinSlicer?</h1>
<p><strong>${esc(ask.name)}</strong> will be able to read and change your printer, filament and print settings that DolphinSlicer keeps in your Google Drive.</p>
<p class="small">Next, you sign in with Google. Then you return to <strong>${esc(ask.host)}</strong>.</p>
<form method="post" action="/mcp/authorize">
<input type="hidden" name="request" value="${esc(ask.sealed)}">
<button name="allow" value="0">Cancel</button>
<button name="allow" value="1" class="primary">Allow</button>
</form>
<p class="small">You can remove access at any time in your Google account, under DolphinSlicer. <a href="/privacy" target="_blank">Privacy policy</a></p>`
    : `<h1>Can't connect</h1><p>${esc(error ?? '')}</p>`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect to DolphinSlicer</title><link rel="icon" href="/dolphin-slicer-mark.svg">
<style>
:root{color-scheme:light dark;--bg:#f6f7f9;--card:#fff;--fg:#1d2430;--muted:#5b6575;--line:#d9dee5;--accent:#0b7a75}
@media (prefers-color-scheme:dark){:root{--bg:#14171c;--card:#1d2128;--fg:#e6e9ee;--muted:#9aa3b0;--line:#323844;--accent:#2bb3a9}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 Inter,ui-sans-serif,system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;padding:16px;box-sizing:border-box}
main{background:var(--card);border:1px solid var(--line);border-radius:12px;max-width:440px;width:100%;padding:28px;box-sizing:border-box}
img{width:40px;height:40px}h1{font-size:20px;margin:12px 0}p{margin:12px 0}.small{color:var(--muted);font-size:13px}a{color:var(--accent)}
form{display:flex;gap:8px;justify-content:flex-end;margin:20px 0}
button{font:inherit;padding:8px 18px;border-radius:8px;border:1px solid var(--line);background:transparent;color:var(--fg);cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}
</style></head><body><main><img src="/dolphin-slicer-mark.svg" alt="">${body}</main></body></html>`;
  const headers: Record<string, string> = {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Frame-Options': 'DENY',
    // The form leads to Google's sign-in, or (canceled) back to the app.
    'Content-Security-Policy': `default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; form-action 'self' https://accounts.google.com${ask ? ` ${ask.origin}` : ''}; frame-ancestors 'none'`,
    'Referrer-Policy': 'no-referrer',
  };
  if (cookie) headers['Set-Cookie'] = cookie;
  return new Response(html, { status, headers });
}
