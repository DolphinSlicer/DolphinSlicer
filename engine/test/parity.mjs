// Acceptance test: slice every fixture with the WASM engine and compare with the
// desktop OrcaSlicer reference G-code.
//   node engine/test/parity.mjs st|mt [--write-report]
// Exit code 0 only if every fixture is byte-identical after normalization.
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { resolve } from 'node:path';
import { loadEngine, slice } from './run-engine.mjs';
import { compareGcode } from './gcode-compare.mjs';

const here = import.meta.dirname;
const variant = process.argv[2] ?? 'st';
const dist = process.env.ENGINE_DIST ?? resolve(here, `../../.work/build-engine-${variant}/dist`);
const fixtures = JSON.parse(readFileSync(resolve(here, 'fixtures/fixtures.json'), 'utf8')).fixtures;

const M = await loadEngine(dist, variant);
const info = JSON.parse(M.UTF8ToString(M._orca_engine_info()));
const wasmBytes = statSync(resolve(dist, `slicer-${variant}.wasm`)).size;
const report = { variant, info, wasmBytes, jsBytes: statSync(resolve(dist, `slicer-${variant}.mjs`)).size,
  node: process.version, fixtures: [] };

const repeat = Number((process.argv.find((a) => a.startsWith('--repeat=')) ?? '--repeat=1').split('=')[1]);
let allOk = true;
for (const fx of fixtures) {
  const model = readFileSync(resolve(here, `fixtures/${fx.name}.3mf`));
  const settings = readFileSync(resolve(here, `fixtures/ref/${fx.name}.settings.json`), 'utf8');
  const ref = gunzipSync(readFileSync(resolve(here, `fixtures/ref/${fx.name}.gcode.gz`))).toString('utf8');
  let entry;
  try {
    // Repeat to check run-to-run determinism (threads) and take the best time.
    let r, cmp, times = [];
    for (let i = 0; i < repeat; i++) {
      const ri = await slice(M, model, settings);
      const ci = compareGcode(ref, ri.gcode);
      times.push(ri.ms.slice);
      if (!r || !ci.identical) { r = ri; cmp = ci; }
      if (!ci.identical) break;
    }
    entry = { name: fx.name, ok: cmp.identical, ms: r.ms, sliceMsRuns: times.map((t) => Math.round(t)),
      heapBytes: M.HEAPU8.length, bytes: r.gcode.length, result: r.result, cmp };
    if (!cmp.identical) mkdirSync(resolve(here, '../../.work/parity'), { recursive: true }),
      writeFileSync(resolve(here, `../../.work/parity/${variant}-${fx.name}.gcode`), r.gcode);
  } catch (err) {
    entry = { name: fx.name, ok: false, error: err.message, detail: err.detail, stderr: M._stderr.slice(-30) };
  }
  // A fixture may carry a documented, exactly specified known difference: it passes only if the
  // comparison matches that classification exactly (anything new or anything fixed fails).
  const known = fx.known_difference;
  if (known && entry.cmp && !entry.cmp.identical) {
    const c = entry.cmp;
    entry.known = c.numericOnly === known.numericOnly && c.structural === known.structural && c.maxNumericDelta <= known.maxNumericDelta;
    entry.ok = entry.known;
  }
  allOk &&= entry.ok;
  const c = entry.cmp;
  console.log(`${entry.ok ? (entry.known ? 'KNOWN' : 'PASS') : 'FAIL'} ${variant} ${fx.name}` +
    (entry.ms ? ` slice=${entry.sliceMsRuns.join('/')}ms heap=${(entry.heapBytes / 2 ** 20).toFixed(0)}MiB` : '') +
    (c && !c.identical ? ` firstDiff=${c.firstDiff} numericOnly=${c.numericOnly} (max Δ ${c.maxNumericDelta}) structural=${c.structural}` : '') +
    (entry.error ? ` ${entry.error}: ${JSON.stringify(entry.detail)}` : ''));
  if (c && !c.identical && !entry.known) for (const s of c.samples.slice(0, 8)) console.log(`   L${s.line}\n     ref: ${s.ref}\n     got: ${s.got}`);
  report.fixtures.push(entry);
}

if (process.argv.includes('--write-report')) {
  const slim = { ...report, fixtures: report.fixtures.map(({ cmp, ...f }) => ({ ...f, identical: cmp?.identical, firstDiff: cmp?.firstDiff })) };
  writeFileSync(resolve(here, `../../.work/parity-${variant}.json`), JSON.stringify(slim, null, 2));
}
process.exit(allOk ? 0 : 1);
