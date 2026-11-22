// 50 system preset combinations across vendors. For each, the engine's
// PresetBundle composes the config (as the app does) and slices the model desktop arranged for
// that printer; the G-code must equal desktop OrcaSlicer's for the same presets.
// Combinations desktop refuses to slice must be refused by the engine with the same message.
//   node engine/test/presets-parity.mjs st|mt [NN ...]
// References: engine/test/presets-pick.mjs, then engine/scripts/make-preset-refs.py.
// Report: .work/presets-parity-<variant>.json
//
// What may differ, and nothing else:
// - the date line, the config block (where the variant arrays are echoed), and object label
//   ids (the CLI labels objects with the id stored in the 3MF, the desktop app and the engine
//   with the object's id in memory), mapped one to one;
// - config keys that are project settings or CLI metadata (listed below) and variant arrays the
//   CLI leaves unresolved, each checked to be the selected variant's element. Any other config
//   difference is reported and fails;
// - exactly the pinned differences in fixtures/presets/known.json.
// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { loadEngine, slice } from './run-engine.mjs';
import { compareGcode } from './gcode-compare.mjs';
import { loadVendor } from './presets-pick.mjs';

const here = import.meta.dirname;
const variant = process.argv[2] ?? 'st';
const only = new Set(process.argv.slice(3));
const dist = process.env.ENGINE_DIST ?? resolve(here, `../../.work/build-engine-${variant}/dist`);
const profiles = resolve(here, '../../.work/orca-src/resources/profiles');
const dir = resolve(here, 'fixtures/presets');
const refs = JSON.parse(readFileSync(resolve(dir, 'refs.json'), 'utf8'));
const known = JSON.parse(readFileSync(resolve(dir, 'known.json'), 'utf8')).known;
const M = await loadEngine(dist, variant);
const gz = (f) => gunzipSync(readFileSync(resolve(dir, f))).toString('utf8');

// Project settings: the CLI takes them from the 3MF it slices (desktop's defaults for a new
// project), the app from its plate. Aligned to desktop's before slicing.
const PROJECT_KEYS = ['curr_bed_type', 'enable_prime_tower', 'filament_colour'];
// Also project or plate state, not taken from presets (not aligned: the G-code shows whether
// they matter).
const PROJECT_STATE = ['filament_colour_type', 'filament_multi_colour', 'filament_nozzle_map', 'flush_volumes_vector',
  'flush_volumes_matrix', 'filament_plugin_config_overrides'];
// Written by the CLI's own loader, not by the desktop app's PresetBundle::full_config().
const CLI_METADATA = ['compatible_machine_expression_group', 'compatible_process_expression_group', 'compatible_printers_condition',
  'different_settings_to_system', 'inherits_group', 'filament_ids', 'print_compatible_printers'];
// Option defaults (the engine's schema dump, npm run assets in app/).
const schema = JSON.parse(readFileSync(resolve(here, '../../app/public/settings-schema.json'), 'utf8')).options;
// The dump writes enum-list defaults as ""; this one is nvtStandard (PrintConfig.cpp).
const DEFAULTS = { default_nozzle_volume_type: 'Standard' };
const VARIANT_LISTS = ['print_extruder_variant', 'printer_extruder_variant', 'filament_extruder_variant'];
const VARIANT_IDS = ['print_extruder_id', 'printer_extruder_id'];
// full_fff_config() clamps these filament numbers to the number of filaments; the CLI does not.
const FILAMENT_NUMBERS = ['support_filament', 'support_interface_filament', 'wipe_tower_filament'];

/** The keys that differ, each with the reason it may (kind), or kind 'other'. */
function configDiff(ours, ref) {
  return [...new Set([...Object.keys(ours), ...Object.keys(ref)])].sort()
    .filter((k) => JSON.stringify(ours[k]) !== JSON.stringify(ref[k]))
    .map((key) => {
      const kind = PROJECT_KEYS.includes(key) || PROJECT_STATE.includes(key) ? 'project'
        : CLI_METADATA.includes(key) ? 'cli-metadata'
        : VARIANT_LISTS.includes(key) || VARIANT_IDS.includes(key) || isResolvedVariant(ours, ref, key) ? 'variant'
        : FILAMENT_NUMBERS.includes(key) && Number(ours[key]) === Math.min(Math.max(Number(ref[key]), 0), ours.filament_settings_id.length)
          ? 'filament-number-clamped'
        // Machine limits hold normal and silent mode; a printer that sets neither gets the
        // one-element default, which the desktop app's preset has for both modes.
        : key.startsWith('machine_max_') && Array.isArray(ref[key]) && ref[key].length === 1
          && ours[key].length === 2 && ours[key].every((v) => v === ref[key][0]) ? 'machine-limit-modes'
        // Not in the CLI's export when no preset file sets it: slicing then uses the default.
        : !(key in ref) && isDefault(key, ours[key]) ? 'cli-absent-default'
        // The CLI clamps it when it loads a file (normalize_fdm); the app's Print::apply does the
        // same before slicing (normalize_fdm_1), so only the echo differs.
        : key === 'resolution' && Number(ref[key]) === Math.max(Number(ours[key]), 0.001) ? 'cli-normalized'
        : 'other';
      return { key, kind, ours: ours[key], desktop: ref[key] };
    });
}

// The CLI keeps the elements of every variant (nozzle volume type), the desktop app's
// full_config() those of the selected variants (one per extruder). Machine limits have a fixed
// number of elements per variant (normal and silent mode). True if ours is exactly desktop's
// elements at the selected variants' positions.
function isResolvedVariant(ours, ref, key) {
  const a = ours[key], d = ref[key];
  if (!Array.isArray(a) || !Array.isArray(d)) return false;
  return VARIANT_LISTS.some((list) => {
    const all = ref[list], picked = ours[list];
    if (!Array.isArray(all) || !Array.isArray(picked) || !all.length || d.length % all.length) return false;
    const stride = d.length / all.length;
    // Extruders with the same variant name: try distinct positions first, then the first match.
    return [true, false].some((distinct) => {
      const used = new Set();
      const idx = picked.map((v) => { const i = all.findIndex((x, j) => x === v && !(distinct && used.has(j))); used.add(i); return i; });
      if (idx.some((i) => i < 0)) return false;
      const want = idx.flatMap((i) => d.slice(i * stride, (i + 1) * stride));
      return JSON.stringify(want) === JSON.stringify(a);
    });
  });
}

/** Whether a value equals the option's default (serialized in the schema, e.g. '"a","b"' or '0,0'). */
function isDefault(key, v) {
  const def = DEFAULTS[key] ?? schema[key]?.default;
  if (def === undefined) return false;
  const parts = String(def).split(',').map((x) => x.replace(/^"|"$/g, ''));
  if (!Array.isArray(v)) return v === def || v === parts.join(',');
  return v.length > 0 && v.every((x, i) => x === parts[i % parts.length]);
}

// Object label ids, renumbered in order of first appearance.
function relabel(g) {
  const ids = new Map();
  const id = (n) => { if (!ids.has(n)) ids.set(n, ids.size + 1); return `#${ids.get(n)}`; };
  return g.replace(/^(; model label id: )([\d,]+)$/gm, (_, p, list) => p + list.split(',').map(id).join(','))
    .replace(/^(; (?:start|stop) printing object, unique label id: )(\d+)$/gm, (_, p, n) => p + id(n));
}
const body = (g) => relabel(g.replace(/; CONFIG_BLOCK_START[\s\S]*?; CONFIG_BLOCK_END\n?/, ''));

function compose(c) {
  const P = loadVendor(M, profiles, c.vendor);
  try {
    const sel = { printer: c.printer, process: c.process, filaments: [c.filament] };
    if (M.ccall('orca_presets_select', 'number', ['number', 'string'], [P, JSON.stringify(sel)]) !== 0)
      throw new Error(`select: ${M.UTF8ToString(M._orca_presets_last_error(P))}`);
    const st = JSON.parse(M.UTF8ToString(M._orca_presets_state(P)));
    const got = { printer: st.printer, process: st.process, filaments: st.filaments };
    if (JSON.stringify(got) !== JSON.stringify(sel)) throw new Error(`selected ${JSON.stringify(got)}`);
    return JSON.parse(M.ccall('orca_presets_full_config', 'string', ['number'], [P]));
  } finally {
    M._orca_presets_destroy(P);
  }
}

const id = (c) => `${c.printer} | ${c.process} | ${c.filament}`;
const report = { variant, combos: [], refused: [] };
const projectDefaults = {};
let failed = 0;
for (const c of refs.combos) {
  if (only.size && !only.has(c.nn)) continue;
  const entry = { nn: c.nn, printer: c.printer, process: c.process, filament: c.filament };
  try {
    const ours = compose(c);
    const ref = JSON.parse(gz(`${c.nn}.settings.json.gz`));
    entry.configDiff = configDiff(ours, ref);
    for (const k of PROJECT_KEYS) {
      ours[k] = ref[k];
      if (k !== 'filament_colour') (projectDefaults[k] ??= new Set()).add(JSON.stringify(ref[k]));
    }
    const r = await slice(M, readFileSync(resolve(dir, `${c.nn}.3mf`)), JSON.stringify(ours));
    const cmp = compareGcode(body(gz(`${c.nn}.gcode.gz`)), body(r.gcode), { maxSamples: 10 });
    const pinned = known.find((k) => k.combo === id(c));
    entry.gcodeOk = cmp.identical || (!!pinned && JSON.stringify(cmp.samples) === JSON.stringify(pinned.samples)
      && cmp.structural === pinned.structural && cmp.numericOnly === pinned.numericOnly);
    if (pinned) entry.known = cmp.identical ? 'fixed: remove it from known.json' : pinned.note;
    if (!cmp.identical) entry.gcode = cmp;
    entry.ok = entry.gcodeOk && !(pinned && cmp.identical) && !entry.configDiff.some((d) => d.kind === 'other');
  } catch (e) {
    entry.ok = false;
    entry.error = `${e.message} ${JSON.stringify(e.detail ?? '')}`;
  }
  failed += entry.ok ? 0 : 1;
  report.combos.push(entry);
  const other = entry.configDiff?.filter((d) => d.kind === 'other') ?? [];
  console.log(`${entry.ok ? (entry.known ? 'KNOWN' : 'ok   ') : 'FAIL '} ${c.nn} ${id(c)}` +
    (other.length ? `\n       config differs: ${other.map((d) => `${d.key}: ${JSON.stringify(d.ours)} vs desktop ${JSON.stringify(d.desktop)}`).join('; ')}` : '') +
    (entry.error ? `\n       ${entry.error}` : '') +
    (entry.known ? `\n       ${entry.known}` : '') +
    (entry.gcode && !entry.gcodeOk ? `\n       G-code differs from line ${entry.gcode.firstDiff} (${entry.gcode.structural} structural, ${entry.gcode.numericOnly} numeric)\n` +
      entry.gcode.samples.map((s) => `         L${s.line}\n           desktop: ${s.ref}\n           engine:  ${s.got}`).join('\n') : ''));
}

// Refused by desktop: the engine must refuse with the same message, with the project settings
// desktop had (the same for every reference, checked here).
const cube = readFileSync(resolve(here, 'fixtures/cube.3mf'));
for (const [k, values] of Object.entries(projectDefaults))
  if (values.size !== 1) throw new Error(`desktop's ${k} differs between references: ${[...values]}`);
for (const c of refs.refused) {
  if (only.size && !only.has(c.nn)) continue;
  const entry = { nn: c.nn, printer: c.printer, process: c.process, filament: c.filament, desktop: c.message };
  try {
    const ours = compose(c);
    for (const [k, values] of Object.entries(projectDefaults)) ours[k] = JSON.parse([...values][0]);
    await slice(M, cube, JSON.stringify(ours));
    entry.ok = false;
    entry.engine = '(sliced)';
  } catch (e) {
    entry.engine = e.detail?.message ?? e.message;
    entry.ok = entry.engine.trim() === c.message.trim();
  }
  failed += entry.ok ? 0 : 1;
  report.refused.push(entry);
  console.log(`${entry.ok ? 'ok   ' : 'FAIL '} ${c.nn} refused: ${id(c)}` +
    (entry.ok ? '' : `\n       desktop: ${JSON.stringify(c.message)}\n       engine:  ${JSON.stringify(entry.engine)}`));
}

mkdirSync(resolve(here, '../../.work'), { recursive: true });
writeFileSync(resolve(here, `../../.work/presets-parity-${variant}.json`), JSON.stringify(report, null, 2));
const n = report.combos.length + report.refused.length;
const kinds = {};
for (const e of report.combos) for (const d of e.configDiff ?? []) kinds[d.kind] = (kinds[d.kind] ?? 0) + 1;
console.log(`\n${n - failed}/${n} match desktop: ${report.combos.filter((e) => e.ok).length}/${report.combos.length} sliced alike ` +
  `(${report.combos.filter((e) => e.ok && e.known).length} with a pinned known difference), ` +
  `${report.refused.filter((e) => e.ok).length}/${report.refused.length} refused alike. ` +
  `Config differences by kind: ${JSON.stringify(kinds)}`);
process.exit(failed ? 1 : 0);
