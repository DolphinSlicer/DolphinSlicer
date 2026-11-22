// Pick the system preset combinations for the preset parity test (presets-parity.mjs):
// printers from as many vendors as possible (a few candidates per slot), each with a process and a filament the engine lists
// as compatible (as the desktop's pickers do). The choice is deterministic, so the list only
// changes with the profiles.
//   node engine/test/presets-pick.mjs [count]   -> engine/test/fixtures/presets/combos.json
// Then generate the desktop references: python3 -I engine/scripts/make-preset-refs.py
// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadEngine } from './run-engine.mjs';

const here = import.meta.dirname;
const count = Number(process.argv[2] ?? 50);
const ALTERNATES = 5;
const profiles = resolve(here, '../../.work/orca-src/resources/profiles');

/** Load one vendor (plus the shared filament library) into a fresh PresetBundle, without user presets. */
export function loadVendor(M, profiles, vendor) {
  const writeTree = (src, dst) => {
    M.FS.mkdirTree(dst);
    for (const n of readdirSync(src)) {
      const s = join(src, n);
      if (statSync(s).isDirectory()) writeTree(s, `${dst}/${n}`);
      else if (n.endsWith('.json')) M.FS.writeFile(`${dst}/${n}`, readFileSync(s));
    }
  };
  const rm = (p) => {
    for (const n of M.FS.readdir(p)) {
      if (n === '.' || n === '..') continue;
      const c = `${p}/${n}`;
      if (M.FS.isDir(M.FS.stat(c).mode)) { rm(c); M.FS.rmdir(c); } else M.FS.unlink(c);
    }
  };
  // Only this vendor's system presets: no other vendor, no user presets from an earlier load.
  for (const d of ['/orca/system', '/orca/user']) { M.FS.mkdirTree(d); rm(d); }
  for (const v of new Set([vendor, 'OrcaFilamentLibrary'])) {
    M.FS.writeFile(`/orca/system/${v}.json`, readFileSync(join(profiles, `${v}.json`)));
    writeTree(join(profiles, v), `/orca/system/${v}`);
  }
  const P = M._orca_presets_create();
  const rc = M.ccall('orca_presets_load', 'number', ['number', 'string'], [P, '/orca']);
  if (rc !== 0) throw new Error(`${vendor}: ${M.UTF8ToString(M._orca_presets_last_error(P))}`);
  return P;
}

// FNV-1a: a stable "random" index per name.
export const hash = (s) => { let h = 0x811c9dc5; for (const c of s) h = Math.imul(h ^ c.codePointAt(0), 0x01000193) >>> 0; return h; };
const pick = (list, seed) => list[hash(seed) % list.length];

if (import.meta.url === `file://${process.argv[1]}`) {
  const M = await loadEngine(process.env.ENGINE_DIST ?? resolve(here, '../../.work/build-engine-st/dist'), 'st');
  const vendors = readdirSync(profiles)
    .filter((f) => f.endsWith('.json') && f !== 'OrcaFilamentLibrary.json')
    .map((f) => f.slice(0, -5))
    .filter((v) => statSync(join(profiles, v), { throwIfNoEntry: false })?.isDirectory())
    .sort();
  // Vendors with the most printers first (a rough measure of how common they are), each once,
  // then again, until `count`.
  const candidates = [];
  for (const vendor of vendors) {
    const P = loadVendor(M, profiles, vendor);
    const printers = JSON.parse(M.UTF8ToString(M._orca_presets_list(P))).printers.filter((p) => p.system && p.vendor === vendor);
    M._orca_presets_destroy(P);
    if (printers.length) candidates.push({ vendor, printers: printers.map((p) => p.name) });
  }
  candidates.sort((a, b) => b.printers.length - a.printers.length || a.vendor.localeCompare(b.vendor));
  const rounds = [];
  for (let round = 0; rounds.length < count; round++) {
    const left = candidates.filter((c) => c.printers.length > round);
    if (!left.length) break;
    for (const c of left) if (rounds.length < count) rounds.push({ vendor: c.vendor, round });
  }
  rounds.sort((a, b) => a.vendor.localeCompare(b.vendor) || a.round - b.round);
  // Each slot lists a few candidates; make-preset-refs.py uses the first one the desktop CLI can
  // load and slice (its file loader refuses some vendor files that the desktop app loads).
  const slots = [];
  for (const { vendor, round } of rounds) {
    const P = loadVendor(M, profiles, vendor);
    const all = JSON.parse(M.UTF8ToString(M._orca_presets_list(P))).printers.filter((p) => p.system && p.vendor === vendor);
    const taken = new Set(slots.filter((s) => s.vendor === vendor).flatMap((s) => s.candidates.map((c) => c.printer)));
    const candidates = [];
    for (let k = 0; k < ALTERNATES && candidates.length < all.length - taken.size; k++) {
      const free = all.filter((p) => !taken.has(p.name) && !candidates.some((c) => c.printer === p.name));
      if (!free.length) break;
      // Mostly the common 0.4 mm nozzle, as most people print with it.
      const nozzle04 = free.filter((p) => p.variant === '0.4');
      const printer = pick(nozzle04.length && round % 2 === 0 ? nozzle04 : free, `${vendor}#${round}#${k}`).name;
      const sel = (j) => M.ccall('orca_presets_select', 'number', ['number', 'string'], [P, JSON.stringify(j)]);
      if (sel({ printer, defaults: true }) !== 0) throw new Error(`${printer}: ${M.UTF8ToString(M._orca_presets_last_error(P))}`);
      const st = JSON.parse(M.UTF8ToString(M._orca_presets_state(P)));
      const process = pick(st.processes.filter((p) => p.system), `${printer}/process`).name;
      const filament = pick(st.filament_presets.filter((f) => f.system), `${printer}/filament`).name;
      candidates.push({ printer, process, filament });
    }
    M._orca_presets_destroy(P);
    slots.push({ vendor, candidates });
    console.log(`${slots.length}. ${vendor}: ${candidates.map((c) => c.printer).join(' / ')}`);
  }
  mkdirSync(resolve(here, 'fixtures/presets'), { recursive: true });
  writeFileSync(resolve(here, 'fixtures/presets/combos.json'), JSON.stringify({
    _comment: 'System preset combinations for presets-parity.mjs, chosen by presets-pick.mjs. Desktop references: engine/scripts/make-preset-refs.py.',
    model: 'cube.stl', slots }, null, 2) + '\n');
}
