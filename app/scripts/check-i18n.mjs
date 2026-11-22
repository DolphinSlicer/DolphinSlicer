// Check the app's translations (src/i18n/app/<code>.json) against src/i18n/strings.json:
// valid JSON, no unknown keys, the same {placeholders} as the English text, and every app string
// translated (here or by desktop OrcaSlicer's .po, see build-i18n.mjs). Run after build-i18n.
// Usage: node scripts/check-i18n.mjs [code …]   (default: all languages)
// SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const app = resolve(import.meta.dirname, '..');
const strings = JSON.parse(readFileSync(join(app, 'src/i18n/strings.json'), 'utf8'));
const known = new Set(strings);
const codes = process.argv.slice(2).length
  ? process.argv.slice(2)
  : readdirSync(join(app, 'public/i18n')).map((f) => f.replace(/\.json$/, ''));
const holders = (s) =>
  [...s.matchAll(/\{(\w+)\}/g)]
    .map((m) => m[1])
    .sort()
    .join(',');
let bad = 0;
for (const code of codes) {
  const problems = [];
  const ownPath = join(app, 'src/i18n/app', `${code}.json`);
  let own = {};
  if (existsSync(ownPath)) {
    try {
      own = JSON.parse(readFileSync(ownPath, 'utf8'));
    } catch (e) {
      problems.push(`invalid JSON: ${e.message}`);
    }
  }
  for (const [k, v] of Object.entries(own)) {
    if (!known.has(k)) problems.push(`unknown key: ${JSON.stringify(k)}`);
    else if (typeof v !== 'string' || !v.trim()) problems.push(`empty: ${JSON.stringify(k)}`);
    else if (holders(k) !== holders(v)) problems.push(`placeholders differ: ${JSON.stringify(k)} → ${JSON.stringify(v)}`);
  }
  const built = JSON.parse(readFileSync(join(app, 'public/i18n', `${code}.json`), 'utf8'));
  const merged = { ...built, ...own };
  for (const s of strings) if (!merged[s]) problems.push(`missing: ${JSON.stringify(s)}`);
  if (problems.length) {
    bad++;
    console.log(`${code}: ${problems.length} problem(s)\n  ${problems.join('\n  ')}`);
  } else console.log(`${code}: ok`);
}
process.exit(bad ? 1 : 0);
