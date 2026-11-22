// Reaching printers on the local network from the browser.
//
// Chrome (142+) asks the user before a public site may talk to devices on the local network
// ("Local Network Access"). A fetch says where it is going with `targetAddressSpace`; for private
// IP addresses and .local names this also lets an https:// page call an http:// printer once
// the permission is granted (otherwise that is blocked as mixed content). Chrome 145 split the
// permission into 'local-network' and 'loopback-network'. Firefox and Safari have no such
// permission and block http:// from https:// pages: there the self-hosted build is the way
// (docs/SELF_HOST_PI.md).
// SPDX-License-Identifier: AGPL-3.0-or-later

export type AddressSpace = 'loopback' | 'local' | 'public' | 'unknown';

/** The address space of a host name, as far as the name tells. DNS names are 'unknown'. */
export function addressSpace(host: string): AddressSpace {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h === '::1' || /^127\.\d+\.\d+\.\d+$/.test(h)) return 'loopback';
  if (h.endsWith('.local')) return 'local';
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127)
    )
      return 'local';
    return 'public';
  }
  if (h.includes(':')) return /^(fc|fd|fe[89ab])/.test(h) ? 'local' : 'public';
  return 'unknown';
}

/** fetch() for a printer: tells Chrome it goes to the local network when the address says so. */
export function lanFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const space = addressSpace(new URL(url).hostname);
  const target = space === 'loopback' || space === 'local' ? { targetAddressSpace: space } : {};
  return fetch(url, { ...init, ...target } as RequestInit);
}

export type LanPermission = 'granted' | 'denied' | 'prompt' | 'unsupported';

/** The Local Network Access permission, or 'unsupported' in browsers without it. */
export async function lanPermission(): Promise<LanPermission> {
  try {
    const s = await navigator.permissions.query({ name: 'local-network' as PermissionName });
    return s.state;
  } catch {
    return 'unsupported';
  }
}

/** True when the browser will block this printer address as mixed content, whatever the user allows. */
export function blockedAsMixedContent(url: string, permission: LanPermission): boolean {
  if (location.protocol !== 'https:' || new URL(url).protocol !== 'http:') return false;
  if (permission === 'unsupported') return true;
  // Chrome lifts the block only for IP addresses and .local names.
  const space = addressSpace(new URL(url).hostname);
  return space === 'unknown' || space === 'public';
}

/** "192.168.1.5" → "http://192.168.1.5"; no trailing slash. */
export function normalizeUrl(input: string): string {
  let s = input.trim();
  // Not an address: words, or another kind of link ("ftp://…").
  if (/\s/.test(s) || (/^[a-z][a-z\d+.-]*:\/\//i.test(s) && !/^https?:\/\//i.test(s))) throw new Error('Not an address');
  if (!/^https?:\/\//i.test(s)) s = `http://${s}`;
  const u = new URL(s);
  return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`;
}
