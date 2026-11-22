// Token service for Google Drive sign-in. Google gives browser-only apps tokens that last an hour
// and no way to renew them (a hidden-frame renewal is blocked by the page's cross-origin
// isolation). This handler runs the authorization code flow with the app's client secret, so
// Google also returns a refresh token, which stays here: in an encrypted, HttpOnly cookie that
// page scripts cannot read. The page asks for a new access token when it needs one. Nothing is
// stored on the server, and preset files never pass through it (the page talks to Drive itself).
//
// Runs as a Cloudflare Pages Function (functions/api/auth/[[path]].ts) and in Vite's dev and
// preview servers (server/vitePlugin.ts). Only web platform APIs, so it runs on both.
//
//   GET  /api/auth/config     {enabled: true}: the page uses the service (else the popup-only flow)
//   GET  /api/auth/start      the sign-in popup starts here (?state=…&hint=…)
//   GET  /api/auth/callback   Google returns here; hands the access token to /oauth.html
//   POST /api/auth/token      a new access token from the refresh token cookie (401: sign in)
//   POST /api/auth/logout     revoke the refresh token and drop the cookie
// SPDX-License-Identifier: AGPL-3.0-or-later
import { CLIENT_ID, SCOPE } from '../src/drive/google';

export interface AuthEnv {
  GOOGLE_CLIENT_SECRET?: string;
  /** Another OAuth client (e.g. a fork's); default: the app's. */
  GOOGLE_CLIENT_ID?: string;
}

export const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
const GOOGLE_REVOKE = 'https://oauth2.googleapis.com/revoke';

/** The refresh token. Strict: only sent with the app's own requests. */
const RT_COOKIE = 'ds_rt';
/** The sign-in in progress (state and PKCE verifier). Lax: sent when Google redirects back. */
const FLOW_COOKIE = 'ds_flow';
const COOKIE_PATH = '/api/auth';
/** Chrome caps cookie lifetimes at 400 days; each renewal extends it. */
const RT_MAX_AGE = 400 * 24 * 3600;

interface Flow {
  state: string;
  verifier: string;
  hint: string;
  consent: boolean;
}

export async function handleAuth(req: Request, env: AuthEnv): Promise<Response> {
  const url = new URL(req.url);
  const secret = env.GOOGLE_CLIENT_SECRET;
  if (!secret) return json({ error: 'not_configured' }, 404);
  const clientId = env.GOOGLE_CLIENT_ID || CLIENT_ID;
  const callbackUri = `${url.origin}${COOKIE_PATH}/callback`;
  const key = await cookieKey(secret);
  const cookies = parseCookies(req.headers.get('cookie') ?? '');
  const route = url.pathname.slice(COOKIE_PATH.length + 1);

  // The sign-in popup: to Google, remembering state and the PKCE verifier for the callback.
  const toGoogle = async (flow: Omit<Flow, 'verifier'>, extra: Headers = new Headers()) => {
    const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
    const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
    const q = new URLSearchParams({
      client_id: clientId,
      redirect_uri: callbackUri,
      response_type: 'code',
      scope: SCOPE,
      state: flow.state,
      access_type: 'offline',
      include_granted_scopes: 'true',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    if (flow.hint) q.set('login_hint', flow.hint);
    // Google returns a refresh token only with consent; asked for when the first try had none.
    if (flow.consent) q.set('prompt', 'consent');
    extra.append('Set-Cookie', cookie(FLOW_COOKIE, await seal(key, JSON.stringify({ ...flow, verifier })), 600, 'Lax'));
    return redirect(`${GOOGLE_AUTH}?${q}`, extra);
  };

  if (req.method === 'GET' && route === 'config') return json({ enabled: true });

  if (req.method === 'GET' && route === 'start') {
    const state = url.searchParams.get('state') ?? '';
    const hint = url.searchParams.get('hint') ?? '';
    if (!/^[\w-]{8,64}$/.test(state) || hint.length > 320) return json({ error: 'bad_request' }, 400);
    return toGoogle({ state, hint, consent: false });
  }

  if (req.method === 'GET' && route === 'callback') {
    const flow = await open<Flow>(key, cookies[FLOW_COOKIE]);
    const state = url.searchParams.get('state') ?? '';
    // Without the cookie from /start (or another sign-in's state), this is not our sign-in.
    if (!flow || flow.state !== state) return json({ error: 'bad_request' }, 400);
    const headers = new Headers({ 'Set-Cookie': cookie(FLOW_COOKIE, '', 0, 'Lax') });
    const back = (fields: Record<string, string>) =>
      redirect(`${url.origin}/oauth.html#${new URLSearchParams({ ...fields, state })}`, headers);
    const error = url.searchParams.get('error');
    if (error) return back({ error });
    const r = await fetch(GOOGLE_TOKEN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: url.searchParams.get('code') ?? '',
        client_id: clientId,
        client_secret: secret,
        redirect_uri: callbackUri,
        grant_type: 'authorization_code',
        code_verifier: flow.verifier,
      }),
    });
    if (!r.ok) return back({ error: 'token_exchange_failed' });
    const t = (await r.json()) as TokenResponse;
    if (!t.refresh_token && !flow.consent) {
      // Access was granted earlier without a refresh token (e.g. by the popup-only flow): ask again.
      return toGoogle({ state, hint: flow.hint, consent: true }, headers);
    }
    if (t.refresh_token) headers.append('Set-Cookie', cookie(RT_COOKIE, await seal(key, t.refresh_token), RT_MAX_AGE, 'Strict'));
    return back({ access_token: t.access_token, expires_in: String(t.expires_in ?? 3600), scope: t.scope ?? '', token_type: 'Bearer' });
  }

  if (req.method === 'POST' && (route === 'token' || route === 'logout')) {
    // Only the app's own pages (SameSite=Strict already keeps other sites' requests cookieless).
    if (req.headers.get('origin') !== url.origin) return json({ error: 'forbidden' }, 403);
    const refresh = await open<string>(key, cookies[RT_COOKIE]);
    const clear = { 'Set-Cookie': cookie(RT_COOKIE, '', 0, 'Strict') };
    if (route === 'logout') {
      if (refresh) await revokeToken(refresh);
      return new Response(null, { status: 204, headers: clear });
    }
    if (!refresh) return json({ error: 'signed_out' }, 401);
    const r = await fetch(GOOGLE_TOKEN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ refresh_token: refresh, client_id: clientId, client_secret: secret, grant_type: 'refresh_token' }),
    });
    if (r.status === 400 || r.status === 401) {
      // Revoked by the user, expired, or the client secret changed: sign in again.
      return json({ error: 'signed_out' }, 401, clear);
    }
    if (!r.ok) return json({ error: 'google_unavailable' }, 502);
    const t = (await r.json()) as TokenResponse;
    // Renewing keeps the cookie for another 400 days.
    const keep = { 'Set-Cookie': cookie(RT_COOKIE, await seal(key, t.refresh_token ?? refresh), RT_MAX_AGE, 'Strict') };
    return json({ access_token: t.access_token, expires_in: t.expires_in ?? 3600, scope: t.scope ?? '' }, 200, keep);
  }

  return json({ error: 'not_found' }, 404);
}

interface TokenResponse {
  access_token: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
}

async function revokeToken(token: string) {
  try {
    await fetch(GOOGLE_REVOKE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }),
    });
  } catch {
    /* best effort */
  }
}

function json(v: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(v), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  });
}

function redirect(location: string, headers: Headers) {
  headers.set('Location', location);
  headers.set('Cache-Control', 'no-store');
  return new Response(null, { status: 302, headers });
}

function cookie(name: string, value: string, maxAge: number, sameSite: 'Strict' | 'Lax') {
  return `${name}=${value}; Max-Age=${maxAge}; Path=${COOKIE_PATH}; HttpOnly; Secure; SameSite=${sameSite}`;
}

function parseCookies(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

// Cookie contents are encrypted (AES-GCM) with a key derived from the client secret, so the
// refresh token is unreadable outside the service, and changing the secret signs everyone out.
async function cookieKey(secret: string): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: new TextEncoder().encode('dolphin-slicer auth cookie v1') },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

async function seal(key: CryptoKey, text: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(text)));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv);
  out.set(ct, iv.length);
  return b64url(out);
}

async function open<T>(key: CryptoKey, sealed: string | undefined): Promise<T | null> {
  if (!sealed) return null;
  try {
    const bytes = fromB64url(sealed);
    const text = new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12) }, key, bytes.slice(12)));
    return (text.startsWith('{') ? JSON.parse(text) : text) as T;
  } catch {
    return null;
  }
}

function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
