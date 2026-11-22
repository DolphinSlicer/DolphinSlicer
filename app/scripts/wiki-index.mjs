// Index of the OrcaSlicer wiki's pages: page name → file in the OrcaSlicer_WIKI repository
// (desktop's links and the wiki's own name pages only, e.g. "quality_settings_seam"; the site
// flattens the folders). All pages, so links between them open in the app's docs panel. Names only: the pages themselves are fetched by the app when
// shown (src/ui/DocsPanel.tsx), as the wiki has no license that would let us copy them.
//
//   node scripts/wiki-index.mjs   → src/settings/wikiPages.json (committed; rerun when the layout's docs change)
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const app = resolve(import.meta.dirname, '..');
const layout = JSON.parse(readFileSync(resolve(app, 'src/settings/layout.json'), 'utf8'));
const wanted = new Set(Object.values(layout.docs).map((p) => p.split('#')[0]));
const r = await fetch('https://api.github.com/repos/OrcaSlicer/OrcaSlicer_WIKI/git/trees/main?recursive=1', {
  headers: { 'User-Agent': 'dolphin-slicer-build' },
});
if (!r.ok) throw new Error(`GitHub: HTTP ${r.status}`);
const files = (await r.json()).tree.map((t) => t.path).filter((p) => p.endsWith('.md'));
const byName = new Map(files.map((p) => [p.slice(p.lastIndexOf('/') + 1, -3), p]));
// Documentation pages only (not the repository's README, templates or developer notes' tooling).
const pages = [...byName].filter(([, p]) => p.includes('/') && !p.startsWith('.github/'));
const index = Object.fromEntries(pages.sort(([a], [b]) => a.localeCompare(b)));
const missing = [...wanted].filter((name) => !index[name]).sort();
writeFileSync(resolve(app, 'src/settings/wikiPages.json'), `${JSON.stringify(index, null, 1)}\n`);
console.log(
  `wiki-index: ${Object.keys(index).length} pages → src/settings/wikiPages.json${missing.length ? `; not in the wiki: ${missing.join(', ')}` : ''}`,
);
