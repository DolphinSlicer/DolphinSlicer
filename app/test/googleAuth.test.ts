// The Google sign-in token service (server/googleAuth.ts) against a fake Google token endpoint.
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GOOGLE_AUTH, GOOGLE_TOKEN, handleAuth } from '../server/googleAuth';

const ORIGIN = 'https://dolphinslicer.test';
const env = { GOOGLE_CLIENT_SECRET: 'test-secret' };

/** A browser's cookie jar for the service's path. */
class Jar {
  cookies = new Map<string, string>();
  take(r: Response) {
    for (const c of r.headers.getSetCookie()) {
      const [nv] = c.split(';');
      const [n, v] = nv!.split('=') as [string, string];
      if (/Max-Age=0\b/.test(c)) this.cookies.delete(n);
      else this.cookies.set(n, v);
      expect(c).toMatch(/HttpOnly; Secure; SameSite=(Strict|Lax)/);
    }
    return r;
  }
  header() {
    return [...this.cookies].map(([n, v]) => `${n}=${v}`).join('; ');
  }
}

function google(responses: Array<(body: URLSearchParams) => Response>) {
  const calls: URLSearchParams[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      if (url !== GOOGLE_TOKEN) return new Response('{}');
      const body = new URLSearchParams(String(init.body));
      calls.push(body);
      return responses.shift()!(body);
    }),
  );
  return calls;
}
const tokenJson = (v: object) => new Response(JSON.stringify(v), { headers: { 'Content-Type': 'application/json' } });

async function call(jar: Jar, path: string, init: RequestInit & { origin?: string } = {}) {
  const headers = new Headers({ cookie: jar.header(), ...(init.origin ? { origin: init.origin } : {}) });
  return jar.take(await handleAuth(new Request(`${ORIGIN}/api/auth/${path}`, { ...init, headers }), env));
}

async function signIn(jar: Jar, state = 'state-123456') {
  const start = await call(jar, `start?state=${state}&hint=a@example.com`);
  expect(start.status).toBe(302);
  const to = new URL(start.headers.get('location')!);
  expect(`${to.origin}${to.pathname}`).toBe(GOOGLE_AUTH);
  expect(to.searchParams.get('access_type')).toBe('offline');
  expect(to.searchParams.get('code_challenge_method')).toBe('S256');
  expect(to.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/api/auth/callback`);
  expect(to.searchParams.get('login_hint')).toBe('a@example.com');
  return to;
}

afterEach(() => vi.unstubAllGlobals());

describe('Google sign-in token service', () => {
  it('signs in, keeps the refresh token in a cookie, and renews the access token', async () => {
    const jar = new Jar();
    expect(await (await call(jar, 'config')).json()).toEqual({ enabled: true });
    await signIn(jar);
    const calls = google([() => tokenJson({ access_token: 'at1', expires_in: 3599, refresh_token: 'rt1', scope: 'drive' })]);
    const cb = await call(jar, 'callback?state=state-123456&code=c1');
    expect(cb.status).toBe(302);
    const back = new URL(cb.headers.get('location')!);
    expect(back.pathname).toBe('/oauth.html');
    expect(Object.fromEntries(new URLSearchParams(back.hash.slice(1)))).toMatchObject({
      access_token: 'at1',
      expires_in: '3599',
      state: 'state-123456',
    });
    expect(calls[0]!.get('client_secret')).toBe('test-secret');
    expect(calls[0]!.get('code_verifier')).toBeTruthy();
    // The refresh token is in the cookie, encrypted.
    expect(jar.cookies.get('ds_flow')).toBeUndefined();
    expect(jar.cookies.get('ds_rt')).toBeTruthy();
    expect(jar.cookies.get('ds_rt')).not.toContain('rt1');

    google([(b) => tokenJson({ access_token: b.get('refresh_token') === 'rt1' ? 'at2' : 'wrong', expires_in: 3599 })]);
    const t = await call(jar, 'token', { method: 'POST', origin: ORIGIN });
    expect(await t.json()).toMatchObject({ access_token: 'at2', expires_in: 3599 });
  });

  it('asks for consent again when Google returns no refresh token', async () => {
    const jar = new Jar();
    await signIn(jar);
    google([() => tokenJson({ access_token: 'at1', expires_in: 3599 })]);
    const cb = await call(jar, 'callback?state=state-123456&code=c1');
    const to = new URL(cb.headers.get('location')!);
    expect(to.searchParams.get('prompt')).toBe('consent');
    expect(to.searchParams.get('state')).toBe('state-123456');
    google([() => tokenJson({ access_token: 'at2', expires_in: 3599, refresh_token: 'rt' })]);
    const cb2 = await call(jar, 'callback?state=state-123456&code=c2');
    expect(cb2.headers.get('location')).toContain('access_token=at2');
    expect(jar.cookies.get('ds_rt')).toBeTruthy();
  });

  it('rejects callbacks of other sign-ins and requests from other sites', async () => {
    const jar = new Jar();
    expect((await call(jar, 'callback?state=state-123456&code=c1')).status).toBe(400);
    await signIn(jar);
    expect((await call(jar, 'callback?state=other-state-1&code=c1')).status).toBe(400);
    expect((await call(jar, 'token', { method: 'POST' })).status).toBe(403);
    expect((await call(jar, 'token', { method: 'POST', origin: 'https://evil.test' })).status).toBe(403);
    expect((await call(jar, 'start?state=x')).status).toBe(400);
  });

  it('passes Google errors back to the page', async () => {
    const jar = new Jar();
    await signIn(jar);
    const cb = await call(jar, 'callback?state=state-123456&error=access_denied');
    expect(cb.headers.get('location')).toBe(`${ORIGIN}/oauth.html#error=access_denied&state=state-123456`);
  });

  it('asks to sign in when there is no session or access was revoked', async () => {
    const jar = new Jar();
    expect((await call(jar, 'token', { method: 'POST', origin: ORIGIN })).status).toBe(401);
    await signIn(jar);
    google([() => tokenJson({ access_token: 'at1', expires_in: 3599, refresh_token: 'rt1' })]);
    await call(jar, 'callback?state=state-123456&code=c1');
    google([() => new Response('{"error":"invalid_grant"}', { status: 400 })]);
    expect((await call(jar, 'token', { method: 'POST', origin: ORIGIN })).status).toBe(401);
    expect(jar.cookies.has('ds_rt')).toBe(false);
  });

  it('signs out', async () => {
    const jar = new Jar();
    await signIn(jar);
    google([() => tokenJson({ access_token: 'at1', expires_in: 3599, refresh_token: 'rt1' })]);
    await call(jar, 'callback?state=state-123456&code=c1');
    expect((await call(jar, 'logout', { method: 'POST', origin: ORIGIN })).status).toBe(204);
    expect(jar.cookies.has('ds_rt')).toBe(false);
  });

  it('is off without the client secret', async () => {
    const r = await handleAuth(new Request(`${ORIGIN}/api/auth/config`), {});
    expect(r.status).toBe(404);
  });
});
