// A setting's documentation from the OrcaSlicer wiki (github.com/OrcaSlicer/OrcaSlicer_WIKI), the
// page desktop's "open wiki" opens. Fetched when shown, not bundled: the wiki has no license that
// lets us copy it. The page's Markdown is cut to the setting's section (desktop links
// "page#anchor"), rendered and sanitized; its links and pictures point back at the wiki.
// SPDX-License-Identifier: AGPL-3.0-or-later

import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { t } from '../i18n/i18n';
import { layout } from './schema';
import wikiPages from './wikiPages.json';

const RAW = 'https://raw.githubusercontent.com/OrcaSlicer/OrcaSlicer_WIKI/main/';
const pages = wikiPages as Record<string, string>;

/** The wiki path desktop links a setting to ("page#anchor"), if the wiki has that page. */
export function docPath(key: string): string | undefined {
  const path = layout.docs[key];
  return path && pages[path.split('#')[0]!] ? path : undefined;
}

/** The page on the wiki's site, as desktop opens it (OptionsGroup::get_url). */
export const wikiUrl = (path: string) => `https://www.orcaslicer.com/wiki/${path}`;

/** GitHub's heading anchors: lower case, punctuation dropped, spaces as dashes. */
export const slug = (heading: string) =>
  heading
    .trim()
    .toLowerCase()
    .replace(/<[^>]+>/g, '')
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');

const sources = new Map<string, Promise<string>>();
function source(page: string): Promise<string> {
  let s = sources.get(page);
  if (!s) {
    s = fetch(RAW + pages[page]!).then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.text();
    });
    s.catch(() => sources.delete(page)); // Try again next time.
    sources.set(page, s);
  }
  return s;
}

/** The section under the heading `anchor` (to the next heading of its level or above), or the whole page. */
export function section(md: string, anchor: string): { title: string; body: string } {
  const lines = md.split('\n');
  const headings: { at: number; level: number; text: string }[] = [];
  let fence = false;
  lines.forEach((l, at) => {
    if (/^\s*(```|~~~)/.test(l)) fence = !fence;
    const h = !fence && /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(l);
    if (h) headings.push({ at, level: h[1]!.length, text: h[2]! });
  });
  const i = anchor ? headings.findIndex((h) => slug(h.text) === anchor) : -1;
  if (i < 0) {
    const top = headings[0];
    return { title: top?.level === 1 ? top.text : '', body: top?.level === 1 ? lines.slice(top.at + 1).join('\n') : md };
  }
  const h = headings[i]!;
  const end = headings.slice(i + 1).find((n) => n.level <= h.level)?.at ?? lines.length;
  return { title: h.text, body: lines.slice(h.at + 1, end).join('\n') };
}

/** A reference line of an option's entry: "[Mode](option_mode): `Simple`.", "[Variable](…): `seam_position`." */
const REFERENCE = /^\[([^\]]+)\]\(([^)]*)\):\s*(`.*?)\.?\s*$/;
const escapeHtml = (s: string) =>
  s.replace(/[&<>"]/g, (c) => `&${({ '&': 'amp', '<': 'lt', '>': 'gt', '"': 'quot' } as Record<string, string>)[c]};`);

/**
 * The wiki starts each option's entry with its reference (mode, variable, type, options, CLI
 * example). That is folded into a collapsed "Details" after the entry's text (before its next
 * heading), so the description comes first.
 */
export function foldReference(md: string): string {
  const out: string[] = [];
  let rows: string[] = [],
    fence = false;
  const flush = () => {
    if (!rows.length) return;
    out.push('', `<details class="docs-ref"><summary>${escapeHtml(t('Details'))}</summary><table>${rows.join('')}</table></details>`, '');
    rows = [];
  };
  for (const line of md.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const ref = !fence && REFERENCE.exec(line);
    if (ref) {
      rows.push(
        `<tr><th>${marked.parseInline(`[${ref[1]}](${ref[2]})`, { async: false })}</th><td>${marked.parseInline(ref[3]!, { async: false })}</td></tr>`,
      );
      continue;
    }
    if (!fence && /^#{1,6}\s/.test(line)) flush();
    out.push(line);
  }
  flush();
  return out.join('\n');
}

export interface Doc {
  title: string;
  html: string;
}

/** The documentation for a wiki path, as safe HTML. Links: see DocsPanel. */
export async function loadDoc(path: string): Promise<Doc> {
  const [page, anchor = ''] = path.split('#') as [string, string?];
  const { title, body } = section(await source(page), anchor.toLowerCase());
  const html = DOMPurify.sanitize(await marked.parse(foldReference(body), { gfm: true }), { ADD_ATTR: ['target'] });
  // Pictures and links relative to the page's file in the repository.
  const base = new URL(pages[page]!, RAW);
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  for (const img of doc.querySelectorAll('img')) {
    // The wiki links its pictures as github.com/…/blob/…?raw=true, a redirect without the
    // Cross-Origin-Resource-Policy header the cross-origin isolated app needs; the file itself has it.
    img.src = new URL(img.getAttribute('src') ?? '', base).href.replace(
      /^https:\/\/github\.com\/([^/]+\/[^/]+)\/(?:blob|raw)\/([^?#]+)(?:\?raw=true)?$/,
      'https://raw.githubusercontent.com/$1/$2',
    );
    img.loading = 'lazy';
  }
  // GitHub's callouts ("> [!NOTE]"), as boxes.
  for (const q of doc.querySelectorAll('blockquote')) {
    const first = q.firstElementChild;
    const m = first && /^\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/i.exec(first.innerHTML);
    if (!m) continue;
    q.className = `callout ${m[1]!.toLowerCase()}`;
    first.innerHTML = first.innerHTML.slice(m[0].length);
  }
  for (const a of doc.querySelectorAll('a')) {
    const href = a.getAttribute('href') ?? '';
    // Wiki links name pages ("option_mode", "#aligned", "page#anchor", now and then with a folder
    // or ".md"); the panel opens every wiki page, and the browser everything else.
    const [p, h = ''] = href.split('#') as [string, string?];
    const name = p.replace(/^.*\//, '').replace(/\.md$/i, '');
    const local = !/^[a-z][\w+.-]*:/i.test(href) && !href.startsWith('//');
    if (local && (name === '' || pages[name])) {
      a.dataset.doc = `${name || page}${h ? `#${h}` : ''}`;
      a.href = wikiUrl(a.dataset.doc);
    } else if (local) a.href = wikiUrl(href);
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
  }
  return { title, html: doc.body.innerHTML };
}
