// Headless driver for the WASM engine (Node). Used by the parity test and for manual runs:
//   node engine/test/run-engine.mjs <st|mt> <model.3mf> <settings.json> <out.gcode>
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const ORCA = { OK: 0, RUNNING: 1 };

export async function loadEngine(distDir, variant) {
  const mod = await import(resolve(distDir, `slicer-${variant}.mjs`));
  const stderr = [];
  const M = await mod.default({ print: () => {}, printErr: (s) => stderr.push(s) });
  M._stderr = stderr;
  return M;
}

function lastError(M, e) {
  return JSON.parse(M.UTF8ToString(M._orca_last_error(e)));
}

/** Slice one plate. Returns { gcode, result, ms: {load, config, slice} }. */
export async function slice(M, modelBytes, configText, { plate = 1, onProgress, calib } = {}) {
  const e = M._orca_create();
  try {
    M.FS.mkdirTree('/in');
    M.FS.writeFile('/in/model.3mf', modelBytes);
    const t0 = performance.now();
    let rc = M.ccall('orca_load_model', 'number', ['number', 'string', 'string'], [e, '/in/model.3mf', '3mf']);
    if (rc !== ORCA.OK) throw Object.assign(new Error('load failed'), { detail: lastError(M, e) });
    const t1 = performance.now();
    rc = M.ccall('orca_set_config', 'number', ['number', 'string'], [e, configText]);
    if (rc !== ORCA.OK) throw Object.assign(new Error('config failed'), { detail: lastError(M, e) });
    if (calib) {
      rc = M.ccall('orca_set_calib', 'number', ['number', 'string'], [e, JSON.stringify(calib)]);
      if (rc !== ORCA.OK) throw Object.assign(new Error('calib failed'), { detail: lastError(M, e) });
    }
    const t2 = performance.now();
    const out = `/out/plate_${plate}.gcode`;
    rc = M.ccall('orca_slice_start', 'number', ['number', 'number', 'string'], [e, plate, out]);
    while (rc === ORCA.RUNNING) {
      await new Promise((r) => setTimeout(r, 25));
      if (onProgress) onProgress(JSON.parse(M.UTF8ToString(M._orca_progress(e))));
      rc = M._orca_slice_poll(e);
    }
    const t3 = performance.now();
    if (rc !== ORCA.OK) throw Object.assign(new Error('slice failed'), { detail: lastError(M, e) });
    const gcode = M.FS.readFile(out, { encoding: 'utf8' });
    M.FS.unlink(out);
    return { gcode, result: JSON.parse(M.UTF8ToString(M._orca_result(e))),
      ms: { load: t1 - t0, config: t2 - t1, slice: t3 - t2 } };
  } finally {
    M._orca_destroy(e);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [variant, model, settings, outPath] = process.argv.slice(2);
  const dist = process.env.ENGINE_DIST ?? resolve(import.meta.dirname, `../../.work/build-engine-${variant}/dist`);
  const M = await loadEngine(dist, variant);
  console.error(M.UTF8ToString(M._orca_engine_info()));
  try {
    const r = await slice(M, readFileSync(model), readFileSync(settings, 'utf8'));
    writeFileSync(outPath, r.gcode);
    console.error(JSON.stringify({ result: r.result, ms: r.ms }));
    process.exit(0);
  } catch (err) {
    console.error(err.message, JSON.stringify(err.detail ?? {}), M._stderr.slice(-20).join('\n'));
    process.exit(1);
  }
}
