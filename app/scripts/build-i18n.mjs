// Build the translation files the app loads: public/i18n/<code>.json, one per language, mapping
// English text to the translation.
//   - Desktop OrcaSlicer's translations (localization/i18n/<code>/OrcaSlicer_<code>.po), limited to
//     the text this app can show: setting names, tooltips, units, enum labels and page/group titles
//     (settings schema and layout), messages from libslic3r and the desktop toggle rules, and the
//     preview's legend.
//   - The app's own text (src/i18n/app/<code>.json), which wins where both have a string.
// Also writes src/i18n/strings.json: every string the app passes to t() or N_(), for translators
// and the coverage test.
// Source: ORCA_SRC, default ../.work/orca-src.
// SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const app = resolve(import.meta.dirname, '..');
const orca = process.env.ORCA_SRC ?? resolve(app, '../.work/orca-src');
const poDir = join(orca, 'localization/i18n');
if (!existsSync(poDir)) {
  console.error(`build-i18n: ${poDir} not found (run engine/scripts/prepare-orca.sh)`);
  process.exit(1);
}

const LANGUAGES = [
  'ca',
  'cs',
  'de',
  'es',
  'eu',
  'fr',
  'hu',
  'it',
  'ja',
  'ko',
  'lt',
  'nl',
  'pl',
  'pt_BR',
  'ru',
  'sv',
  'th',
  'tr',
  'uk',
  'vi',
  'zh_CN',
  'zh_TW',
];

const files = (dir, ext) =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p, ext) : ext.test(n) ? [p] : [];
  });

// ── The app's own strings ────────────────────────────────────────────────────────────────
const unescapeJs = (s) => s.replace(/\\(.)/g, (_, c) => ({ n: '\n', t: '\t' })[c] ?? c);
const appStrings = new Set();
for (const f of files(join(app, 'src'), /\.(ts|tsx)$/)) {
  // Single- or double-quoted (text with an apostrophe).
  for (const m of readFileSync(f, 'utf8').matchAll(/\b(?:t|N_)\(\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")/g))
    appStrings.add(unescapeJs(m[1] ?? m[2]));
}
const strings = [...appStrings].sort();
writeFileSync(join(app, 'src/i18n/strings.json'), `${JSON.stringify(strings, null, 2)}\n`);

// ── Desktop text the app can show ─────────────────────────────────────────────────────────
const wanted = new Set(strings);
const schema = JSON.parse(readFileSync(join(app, 'public/settings-schema.json'), 'utf8'));
for (const d of Object.values(schema.options)) {
  for (const k of ['label', 'full_label', 'tooltip', 'category', 'sidetext']) if (d[k]) wanted.add(d[k]);
  for (const l of d.enum_labels ?? []) if (l) wanted.add(l);
}
const layout = JSON.parse(readFileSync(join(app, 'src/settings/layout.json'), 'utf8'));
for (const type of ['print', 'filament', 'printer'])
  for (const p of layout[type]) {
    wanted.add(p.title);
    for (const g of p.groups) if (g.title) wanted.add(g.title);
    for (const g of p.groups) for (const l of Object.values(g.lines ?? {})) wanted.add(l);
  }
// Messages: libslic3r (progress, errors, warnings) and the toggle rules compiled into the engine.
const unescapeC = (s) => s.replace(/\\(.)/g, (_, c) => ({ n: '\n', t: '\t' })[c] ?? c);
const msgSources = [
  ...files(join(orca, 'src/libslic3r'), /\.(cpp|hpp|h)$/),
  join(orca, 'src/slic3r/GUI/ConfigManipulation.cpp'),
  join(orca, 'src/slic3r/GUI/Tab.cpp'),
  // The preview's views and legend.
  join(orca, 'src/slic3r/GUI/GCodeViewer.cpp'),
  // Compare presets.
  join(orca, 'src/slic3r/GUI/UnsavedChangesDialog.cpp'),
  join(orca, 'src/slic3r/GUI/ConfigValueFormatter.cpp'),
  // Support painting.
  join(orca, 'src/slic3r/GUI/Gizmos/GLGizmoFdmSupports.cpp'),
];
for (const f of msgSources) {
  for (const m of readFileSync(f, 'utf8').matchAll(/\b(?:L|_L|_u8L|L_CONTEXT)\(\s*((?:"(?:[^"\\]|\\.)*"\s*)+)/g)) {
    wanted.add(unescapeC([...m[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((x) => x[1]).join('')));
  }
}

// ── .po parsing ───────────────────────────────────────────────────────────────────────────
function parsePo(text) {
  const out = new Map();
  for (const block of text.split(/\r?\n\r?\n/)) {
    if (/^#,.*\bfuzzy\b/m.test(block)) continue;
    const e = {};
    let cur = null;
    for (const line of block.split(/\r?\n/)) {
      const m = /^(msgctxt|msgid_plural|msgid|msgstr(?:\[\d+\])?)\s+"(.*)"\s*$/.exec(line);
      if (m) {
        cur = m[1];
        e[cur] = m[2];
        continue;
      }
      const c = /^"(.*)"\s*$/.exec(line);
      if (c && cur) e[cur] += c[1];
    }
    if (!e.msgid || e.msgctxt !== undefined) continue;
    const un = (s) => s.replace(/\\(.)/g, (_, ch) => ({ n: '\n', t: '\t', r: '\r' })[ch] ?? ch);
    const one = e.msgstr ?? e['msgstr[0]'];
    if (one) out.set(un(e.msgid), un(one));
    if (e.msgid_plural && e['msgstr[1]']) out.set(un(e.msgid_plural), un(e['msgstr[1]']));
  }
  return out;
}

const outDir = join(app, 'public/i18n');
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
let total = 0;
const report = [];
for (const code of LANGUAGES) {
  const po = join(poDir, code, `OrcaSlicer_${code}.po`);
  const desktop = existsSync(po) ? parsePo(readFileSync(po, 'utf8')) : new Map();
  const dict = {};
  for (const [k, v] of desktop) if (wanted.has(k) && v !== k) dict[k] = v;
  const own = join(app, 'src/i18n/app', `${code}.json`);
  const ownDict = existsSync(own) ? JSON.parse(readFileSync(own, 'utf8')) : {};
  Object.assign(dict, ownDict);
  const missing = strings.filter((s) => !dict[s]).length;
  const text = JSON.stringify(dict);
  writeFileSync(join(outDir, `${code}.json`), text);
  total += text.length;
  report.push(`${code} ${Object.keys(dict).length}${missing ? ` (${missing} app strings untranslated)` : ''}`);
}
console.log(`build-i18n: ${strings.length} app strings; ${LANGUAGES.length} languages, ${(total / 1048576).toFixed(1)} MiB → public/i18n/`);
console.log(`  ${report.join(', ')}`);
