// Extract the desktop settings layout (tabs → pages → groups → option keys) from OrcaSlicer's
// src/slic3r/GUI/Tab.cpp at the pinned tag, so the web settings UI is generated from the same
// structure as the desktop one instead of being hand-written.
//
//   node scripts/extract-layout.mjs [--check]   → src/settings/layout.json (committed)
//
// --check fails if the committed file differs from a fresh extraction (run in CI and in the unit
// tests), so an Orca version bump that changes Tab.cpp shows up as a reviewable diff.
//
// What is recognised inside the scanned functions (comments removed first):
//   add_options_page(L("Title") …)             a page
//   new_optgroup(L("Title") …)                  a group in the current page
//   append_single_option_line("key" …)          an option row
//   get_option("key" …)                         an option used in a custom row (Line) or widget
//   line = { L("Label") … } … append_line(line)   a labeled row of several options: the group's
//                                               `lines` maps each of its keys to the row's label
//   the wiki path after an option's key, and line.label_path = "…"   → `docs` (key → "page#anchor"),
//                                               desktop's "open wiki" link (OptionsGroup::get_url)
//   append_option_line(optgroup, "key" …)       an option row (printer tab helper)
//   create_line_with_widget(optgroup.get(), "key" …)   an option with a custom widget
//   "prefix_" + axis  inside  for (… axis : axes)       expanded with the vector's literal values
//   for (const std::string k : { "a", "b" }) …          every literal is an option row
//   add_filament_overrides_page();                     inlined (it builds the "Setting Overrides" page)
//   for (… opt : publishable_printer_*_options())       the keys listed in libslic3r/PublishSettings.cpp
// SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const app = resolve(import.meta.dirname, '..');
const orcaSrc = process.env.ORCA_SRC ?? resolve(app, '../.work/orca-src/src');
const tabCpp = resolve(orcaSrc, 'slic3r/GUI/Tab.cpp');
const publishCpp = resolve(orcaSrc, 'libslic3r/PublishSettings.cpp');
const out = resolve(app, 'src/settings/layout.json');

/** Body of `Class::fn(...)` as text, from the opening brace to its matching close. */
function functionBody(src, signature) {
  const at = src.indexOf(signature);
  if (at < 0) throw new Error(`Tab.cpp: ${signature} not found`);
  let i = src.indexOf('{', at),
    depth = 0;
  const start = i;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === '"') {
      i++;
      while (src[i] !== '"') {
        if (src[i] === '\\') i++;
        i++;
      }
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`Tab.cpp: unbalanced braces in ${signature}`);
}

function stripComments(s) {
  let outStr = '',
    i = 0;
  while (i < s.length) {
    if (s[i] === '"') {
      let j = i + 1;
      while (s[j] !== '"') {
        if (s[j] === '\\') j++;
        j++;
      }
      outStr += s.slice(i, j + 1);
      i = j + 1;
    } else if (s.startsWith('//', i)) {
      while (i < s.length && s[i] !== '\n') i++;
    } else if (s.startsWith('/*', i)) {
      const e = s.indexOf('*/', i + 2);
      i = e < 0 ? s.length : e + 2;
    } else outStr += s[i++];
  }
  return outStr;
}

/** String-vector literals defined in a body: `std::vector<std::string> axes{ "x", "y" }`. */
function vectors(body) {
  const v = {};
  for (const m of body.matchAll(/(?:std::vector<std::string>|const\s+std::vector<std::string>)\s*&?\s*(\w+)\s*(?:=\s*)?\{([^}]*)\}/g))
    v[m[1]] = [...m[2].matchAll(/"([^"]*)"/g)].map((x) => x[1]);
  return v;
}

/** Option key → desktop's wiki path ("page#anchor"), filled by scan(). */
const docs = {};

/** Scan bodies in order; returns pages [{ title, groups: [{ title, keys }] }]. */
function scan(bodies, allBodiesForVectors) {
  const vecs = Object.assign({}, ...allBodiesForVectors.map(vectors));
  const pages = [];
  let page = null,
    group = null,
    line = null;
  const addKey = (k) => {
    if (!group) {
      group = { title: '', keys: [] };
      (page ?? newPage('')).groups.push(group);
    }
    if (!group.keys.includes(k)) group.keys.push(k);
    if (line && !line.keys.includes(k)) line.keys.push(k);
  };
  // The options' own labels ("First layer", "Other layers") only make sense under the row's.
  const endLine = () => {
    if (line?.path) for (const k of line.keys) docs[k] ??= line.path;
    if (line?.label && line.keys.length > 1 && group) for (const k of line.keys) (group.lines ??= {})[k] = line.label;
    line = null;
  };
  const newPage = (title) => {
    page = { title, groups: [] };
    pages.push(page);
    group = null;
    return page;
  };
  const token =
    /add_options_page\(\s*L\("([^"]+)"\)|new_optgroup\(\s*L\("([^"]*)"\)|append_single_option_line\(\s*"([\w]+)"|get_option\(\s*"([\w]+)"|append_option_line\(\s*\w+\s*,\s*"([\w]*)"\s*(\+\s*(\w+))?|create_line_with_widget\(\s*[\w.()]+\s*,\s*"([\w]+)"|for\s*\(\s*const\s+std::string\s*&\s*(\w+)\s*:\s*(\w+)\s*\)|for\s*\(\s*const\s+std::string\s*&?\s*\w+\s*:\s*\{([^}]*)\}\s*\)|\b\w*line\s*=?\s*(?:Line)?\s*\{\s*(?:L\("([^"]*)"\)|(""))|(append_line\()|label_path\s*=\s*"([^"]*)"/g;
  for (const body of bodies) {
    const loops = {}; // loop variable → vector name (last seen; loops are not nested here)
    for (const m of body.matchAll(token)) {
      // The wiki path an option row is given: the string argument after the key.
      const path = /^\s*,\s*"([^"]+)"/.exec(body.slice(m.index + m[0].length))?.[1];
      const doc = (k) => {
        if (path && !docs[k]) docs[k] = path;
      };
      if (m[15] !== undefined) {
        if (line) line.path = m[15];
      } else if (m[1] !== undefined) {
        endLine();
        newPage(m[1]);
      } else if (m[12] !== undefined || m[13] !== undefined) line = { label: m[12] ?? '', keys: [] };
      else if (m[14]) endLine();
      else if (m[2] !== undefined) {
        endLine();
        group = { title: m[2], keys: [] };
        (page ?? newPage('')).groups.push(group);
      } else if (m[3]) {
        addKey(m[3]);
        doc(m[3]);
      } else if (m[4]) addKey(m[4]);
      else if (m[5] !== undefined && m[7])
        for (const v of vecs[loops[m[7]]] ?? []) {
          addKey(m[5] + v);
          doc(m[5] + v);
        }
      else if (m[5]) {
        addKey(m[5]);
        doc(m[5]);
      } else if (m[8]) {
        addKey(m[8]);
        doc(m[8]);
      } else if (m[9]) loops[m[9]] = m[10];
      else if (m[11] !== undefined) for (const k of m[11].matchAll(/"([\w]+)"/g)) addKey(k[1]);
    }
  }
  return pages.map((p) => ({ ...p, groups: p.groups.filter((g) => g.keys.length) })).filter((p) => p.groups.length);
}

/** Keys of a `publishable_printer_*_options()` list in PublishSettings.cpp, as a brace list. */
function publishableList(pub, fn) {
  const body = stripComments(functionBody(pub, `const std::vector<PublishablePrinterOption>& ${fn}()`));
  return `{ ${[...body.matchAll(/\{\s*"([\w]+)"/g)].map((m) => `"${m[1]}"`).join(', ')} }`;
}

function extract(src, pub) {
  const body = (sig) =>
    stripComments(functionBody(src, sig)).replace(
      /for\s*\(\s*const\s+PublishablePrinterOption\s*&\s*\w+\s*:\s*(publishable_printer_\w+_options)\(\)\s*\)/g,
      (_all, fn) => `for (const std::string opt : ${publishableList(pub, fn)})`,
    );
  const printer = [
    body('void TabPrinter::build_fff()'),
    body('PageShp TabPrinter::build_kinematics_page()'),
    body('void TabPrinter::build_unregular_pages('),
  ];
  // append_option_line(optgroup, speed_axis, …) uses the loop variable itself as the key.
  const kin = printer[1].replace(/append_option_line\(\s*optgroup\s*,\s*(\w+)\s*,/g, (all, v) =>
    /^"/.test(v) ? all : `append_option_line(optgroup, "" + ${v},`,
  );
  printer[1] = kin;
  let printerPages = scan(printer, printer);
  // Desktop shows Notes last (the unregular pages are inserted before it).
  printerPages = [...printerPages.filter((p) => p.title !== 'Notes'), ...printerPages.filter((p) => p.title === 'Notes')];
  return {
    source: 'OrcaSlicer src/slic3r/GUI/Tab.cpp',
    // Desktop has the print Dependencies page commented out ("the UI is not ready yet"); the app
    // shows it, as the filament’s.
    print: [
      ...scan([body('void TabPrint::build()')], []),
      { title: 'Dependencies', groups: [{ title: 'Compatible printers', keys: ['compatible_printers', 'compatible_printers_condition'] }] },
    ],
    filament: scan(
      [
        body('void TabFilament::build()').replace(/add_filament_overrides_page\(\)\s*;/, () =>
          body('void TabFilament::add_filament_overrides_page()'),
        ),
      ],
      [],
    ),
    printer: printerPages,
    docs: Object.fromEntries(Object.entries(docs).sort(([a], [b]) => a.localeCompare(b))),
  };
}

if (!existsSync(tabCpp)) {
  console.error(`extract-layout: ${tabCpp} not found (engine/scripts/prepare-orca.sh)`);
  process.exit(1);
}
const layout = extract(readFileSync(tabCpp, 'utf8'), readFileSync(publishCpp, 'utf8'));
const text = `${JSON.stringify(layout, null, 1)}\n`;
if (process.argv.includes('--check')) {
  const cur = existsSync(out) ? readFileSync(out, 'utf8') : '';
  if (cur !== text) {
    console.error('extract-layout: src/settings/layout.json is out of date; run node scripts/extract-layout.mjs');
    process.exit(1);
  }
  console.log('extract-layout: up to date');
} else {
  writeFileSync(out, text);
  const count = (t) => layout[t].reduce((n, p) => n + p.groups.reduce((m, g) => m + g.keys.length, 0), 0);
  console.log(
    `extract-layout: print ${count('print')}, filament ${count('filament')}, printer ${count('printer')} keys → src/settings/layout.json`,
  );
}
