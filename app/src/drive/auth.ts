// Google sign-in for Drive sync, without Google's sign-in script: the page is cross-origin
// isolated (COOP same-origin, for the multithreaded engine), which cuts the popup off from its
// opener, so the script's popup flow cannot report back. Instead the sign-in runs in a plain
// popup that ends on public/oauth.html (same origin), which passes the token back on a
// BroadcastChannel.
//
// With the token service (server/googleAuth.ts) the popup goes through /api/auth, which
// keeps a refresh token in an HttpOnly cookie; refreshToken() then renews the hour-long access
// token without asking. Without it (static hosting only) the popup gets a token from Google
// directly (implicit grant), and the user signs in again after an hour.
// SPDX-License-Identifier: AGPL-3.0-or-later
import { N_ } from '../i18n/i18n';

import { CLIENT_ID, SCOPE } from './google';

export { CLIENT_ID, SCOPE };

const CHANNEL = 'dolphin-slicer-oauth';
const KEY = 'dolphin-slicer.drive.v1';

export interface DriveAccount {
  email: string;
  token: string;
  /** ms since epoch; a minute before Google's expiry. */
  expires: number;
}

export function loadAccount(): DriveAccount | null {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? 'null') as DriveAccount | null;
  } catch {
    return null;
  }
}
export function saveAccount(a: DriveAccount | null) {
  try {
    if (a) localStorage.setItem(KEY, JSON.stringify(a));
    else localStorage.removeItem(KEY);
  } catch {
    /* this session only */
  }
}
export const tokenValid = (a: DriveAccount | null): a is DriveAccount => !!a && a.expires > Date.now();

export const redirectUri = () => new URL('oauth.html', document.baseURI).href;
const serviceUrl = (path: string) => new URL(`api/auth/${path}`, document.baseURI).href;

let service: Promise<boolean> | null = null;
let hasService = false;
/** Whether the token service is there. Call early: signIn() must open its popup without waiting. */
export function probeService(): Promise<boolean> {
  service ??= fetch(serviceUrl('config'), { cache: 'no-store' })
    .then(async (r) => r.ok && (r.headers.get('content-type') ?? '').includes('json') && (await r.json()).enabled === true)
    .catch(() => false)
    .then((v) => (hasService = v));
  return service;
}

/**
 * A new access token from the token service, without asking the user. Null when the user has to
 * sign in (no service, never signed in on this browser, or access was revoked).
 */
export async function refreshToken(): Promise<{ token: string; expires: number } | null> {
  if (!(await probeService())) return null;
  const r = await fetch(serviceUrl('token'), { method: 'POST', cache: 'no-store' });
  if (r.status === 401) return null;
  if (!r.ok) throw new Error(`Sign-in service: HTTP ${r.status}`);
  const t = (await r.json()) as { access_token: string; expires_in: number };
  return { token: t.access_token, expires: Date.now() + (t.expires_in - 60) * 1000 };
}

export class SignInError extends Error {}

/** Open Google's sign-in popup. Must be called from a click (pop-up blockers). */
export function signIn(hint?: string, signal?: AbortSignal): Promise<{ token: string; expires: number }> {
  const state = crypto.randomUUID();
  let url: URL;
  if (hasService) {
    url = new URL(serviceUrl('start'));
    url.search = new URLSearchParams({ state, ...(hint ? { hint } : {}) }).toString();
  } else {
    url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.search = new URLSearchParams({
      client_id: CLIENT_ID,
      redirect_uri: redirectUri(),
      response_type: 'token',
      scope: SCOPE,
      state,
      include_granted_scopes: 'true',
      ...(hint ? { login_hint: hint } : {}),
    }).toString();
  }
  const channel = new BroadcastChannel(CHANNEL);
  return new Promise((resolve, reject) => {
    const done = () => {
      channel.close();
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    };
    const abort = () => {
      done();
      reject(new SignInError(N_('Sign-in was canceled.')));
    };
    const timer = setTimeout(abort, 5 * 60_000);
    signal?.addEventListener('abort', abort);
    channel.onmessage = (e: MessageEvent<Record<string, string>>) => {
      if (e.data?.state !== state) return;
      done();
      if (e.data.error || !e.data.access_token) {
        reject(
          new SignInError(e.data.error === 'access_denied' ? N_('Google Drive access was not allowed.') : (e.data.error ?? 'no token')),
        );
        return;
      }
      if (!(e.data.scope ?? '').split(' ').includes(SCOPE)) {
        reject(new SignInError(N_('Google Drive access was not allowed.')));
        return;
      }
      resolve({ token: e.data.access_token, expires: Date.now() + (Number(e.data.expires_in || 3600) - 60) * 1000 });
    };
    const w = window.open(url, 'dolphin-slicer-signin', 'popup,width=480,height=640');
    if (!w) {
      done();
      reject(new SignInError(N_('The sign-in window was blocked. Allow pop-ups for this site and try again.')));
    }
  });
}

/** Sign out: the token service drops its refresh token, and Google revokes access (best effort). */
export async function revoke(token: string) {
  if (hasService) {
    try {
      await fetch(serviceUrl('logout'), { method: 'POST' });
    } catch {
      /* the cookie stays until it is replaced */
    }
  }
  try {
    await fetch('https://oauth2.googleapis.com/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }),
    });
  } catch {
    /* the token expires within the hour anyway */
  }
}
