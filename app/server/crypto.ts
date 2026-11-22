// Sealed values: text encrypted and authenticated (AES-GCM) with a key derived from the Google
// client secret, so only the server can read or make them, and changing the secret voids them.
// The sign-in cookies (googleAuth.ts) and the MCP server's tokens (mcp/oauth.ts) are sealed values.
// SPDX-License-Identifier: AGPL-3.0-or-later

/** A key for one use (`purpose`), derived from the client secret. */
export async function sealKey(secret: string, purpose: string): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: new TextEncoder().encode(purpose) },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function seal(key: CryptoKey, text: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(text)));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv);
  out.set(ct, iv.length);
  return b64url(out);
}

/** The sealed text (parsed when it is a JSON object), or null when it was not sealed with this key. */
export async function open<T>(key: CryptoKey, sealed: string | undefined | null): Promise<T | null> {
  if (!sealed) return null;
  try {
    const bytes = fromB64url(sealed);
    const text = new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12) }, key, bytes.slice(12)));
    return (text.startsWith('{') ? JSON.parse(text) : text) as T;
  } catch {
    return null;
  }
}

export function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromB64url(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/** The PKCE S256 challenge of a verifier. */
export async function s256(verifier: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
}

export const randomId = (bytes = 32) => b64url(crypto.getRandomValues(new Uint8Array(bytes)));
