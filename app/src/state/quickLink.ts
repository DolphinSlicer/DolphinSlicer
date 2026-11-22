// "Slice now" links: https://dolphinslicer.app/?model=<url of an STL/3MF/OBJ/AMF file> opens
// the app with that model on the plate. Other sites put such a link (or button) on a model page
// (docs/QUICK_LINK.md).
//
// The browser downloads the file directly from the other site, so that site has to allow it
// (CORS: Access-Control-Allow-Origin). There is no proxy, by design.
//
// Parameters: model=<url> (repeatable, one per file); name=<file name> (repeatable, in the same
// order) for links whose path has no file name, e.g. /download?id=123.
// SPDX-License-Identifier: AGPL-3.0-or-later
import { t } from '../i18n/i18n';
import { importFiles, isModelFile } from './actions';
import { get, notify, set, useApp } from './store';

export interface QuickLink {
  url: string;
  name?: string;
}

/** The models a page address asks for (http and https only). */
export function parseQuickLinks(search: string): QuickLink[] {
  const q = new URLSearchParams(search);
  const names = q.getAll('name');
  return q.getAll('model').flatMap((raw, i) => {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      return [];
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return [];
    return [{ url: u.href, ...(names[i] ? { name: names[i] } : {}) }];
  });
}

/** "model.stl" from Content-Disposition (filename*= or filename=), if any. */
export function dispositionName(header: string | null): string | null {
  if (!header) return null;
  const star = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(header);
  if (star) {
    try {
      return decodeURIComponent(star[1]!.trim());
    } catch {
      /* fall through */
    }
  }
  const plain = /filename\s*=\s*"?([^";]+)"?/.exec(header);
  return plain ? plain[1]!.trim() : null;
}

/** The file type from its first bytes, for links without a usable name. */
export function sniffExtension(bytes: ArrayBuffer): string | null {
  const b = new Uint8Array(bytes, 0, Math.min(bytes.byteLength, 512));
  if (b[0] === 0x50 && b[1] === 0x4b) return '3mf'; // zip
  const head = new TextDecoder().decode(b).trimStart().toLowerCase();
  if (head.startsWith('solid') && /facet|endsolid/.test(head)) return 'stl';
  if (head.startsWith('<?xml') || head.startsWith('<amf')) return head.includes('<amf') ? 'amf' : null;
  if (/^(v|vn|vt|f|o|g|mtllib|#)\s/m.test(head) && /^v\s/m.test(head)) return 'obj';
  // Binary STL: 80-byte header, triangle count, 50 bytes per triangle.
  if (bytes.byteLength >= 84) {
    const n = new DataView(bytes).getUint32(80, true);
    if (84 + n * 50 === bytes.byteLength) return 'stl';
  }
  return null;
}

/** The name to import a downloaded file under. */
export function fileNameFor(link: QuickLink, disposition: string | null, bytes: ArrayBuffer): string | null {
  // A lone "%" in the address is no escape: it stays as it is, the real escapes around it are decoded.
  const last = new URL(link.url).pathname.split('/').pop() ?? '';
  const fromPath = last.replace(/(?:%[0-9a-f]{2})+/gi, (m) => {
    try {
      return decodeURIComponent(m);
    } catch {
      return m;
    }
  });
  for (const n of [link.name, dispositionName(disposition), fromPath]) if (n && isModelFile(n)) return n.replace(/[\\/]/g, '_');
  const ext = sniffExtension(bytes);
  if (!ext) return null;
  const base = (link.name || fromPath || 'model').replace(/\.[^.]*$/, '').replace(/[\\/]/g, '_') || 'model';
  return `${base}.${ext}`;
}

const MAX_BYTES = 512 * 1024 ** 2;

async function download(link: QuickLink): Promise<{ name: string; bytes: ArrayBuffer } | null> {
  const host = new URL(link.url).host;
  let r: Response;
  try {
    r = await fetch(link.url, { mode: 'cors', credentials: 'omit', redirect: 'follow' });
  } catch {
    // The browser hides why; almost always the site doesn't allow other sites to download it.
    notify({
      kind: 'error',
      title: t('Could not open the model from {host}', { host }),
      message: t('{host} doesn’t let other sites download this file. Download it yourself and drop it here.', { host }),
    });
    return null;
  }
  if (!r.ok) {
    notify({
      kind: 'error',
      title: t('Could not open the model from {host}', { host }),
      message: t('{host} answered: HTTP {status}', { host, status: String(r.status) }),
    });
    return null;
  }
  if (Number(r.headers.get('Content-Length') ?? 0) > MAX_BYTES) {
    notify({ kind: 'error', title: t('Could not open the model from {host}', { host }), message: t('The file is larger than 512 MB.') });
    return null;
  }
  const bytes = await r.arrayBuffer();
  const name = fileNameFor(link, r.headers.get('Content-Disposition'), bytes);
  if (!name) {
    notify({
      kind: 'error',
      title: t('Could not open the model from {host}', { host }),
      message: t('This link is not an STL, 3MF, OBJ or AMF file.'),
    });
    return null;
  }
  return { name, bytes };
}

/** Open the models a "Slice now" link asks for. Call once at start. */
export async function openQuickLinks() {
  const links = parseQuickLinks(location.search);
  if (!links.length) return;
  // A reload should not add them again.
  const clean = new URL(location.href);
  clean.searchParams.delete('model');
  clean.searchParams.delete('name');
  history.replaceState(history.state, '', clean.href);

  set({ importing: true });
  let files: { name: string; bytes: ArrayBuffer }[] = [];
  try {
    files = (await Promise.all(links.map(download))).filter((f): f is { name: string; bytes: ArrayBuffer } => !!f);
    // Place them on the selected printer's bed: wait for the presets.
    if (get().presets.status === 'loading') {
      await new Promise<void>((resolve) => {
        const unsub = useApp.subscribe((s) => {
          if (s.presets.status !== 'loading') {
            unsub();
            resolve();
          }
        });
      });
    }
  } finally {
    set({ importing: false });
  }
  if (!files.length) return;
  set({ view: 'prepare' });
  await importFiles(files.map((f) => ({ name: f.name, bytes: Promise.resolve(f.bytes) })));
}
