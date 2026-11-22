// Copy desktop OrcaSlicer's calibration test models (resources/calib at the pinned tag) for the
// Calibration menu: public/calib/<hash>/<path as in resources/calib>, and public/calib-manifest.json
// naming that folder. The app fetches a test's files when it is started and gives them to the
// engine (orca_presets_calib), which reads them as desktop does.
// Source: ORCA_SRC, default ../.work/orca-src.
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const app = resolve(import.meta.dirname, '..');
const src = join(process.env.ORCA_SRC ?? resolve(app, '../.work/orca-src'), 'resources/calib');
if (!existsSync(src)) {
  console.error(`copy-calib: ${src} not found (run engine/scripts/prepare-orca.sh)`);
  process.exit(1);
}

// The models the menu's tests load (Plater::calib_*); the rest of the folder is for Bambu's
// printer calibration and the belt tower generator.
const used = (rel) =>
  /^(cornering|input_shaping|retraction|vfa|volumetric_speed)\/.*\.drc$/.test(rel) ||
  /^pressure_advance\/(pressure_advance_test|tower_with_seam)\.drc$/.test(rel) ||
  /^temperature_tower\/(temperature_tower\.drc|belt_temp_tower_\d+_\d+\.stl)$/.test(rel) ||
  /^filament_flow\/(Orca-LinearFlow|Orca-LinearFlow_fine|flowrate-test-pass1|flowrate-test-pass2)\.3mf$/.test(rel);

const files = [];
(function walk(dir, rel) {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name),
      r = rel ? `${rel}/${name}` : name;
    if (statSync(p).isDirectory()) walk(p, r);
    else if (used(r)) files.push(r);
  }
})(src, '');

const hash = createHash('sha256');
for (const r of files) hash.update(r).update(readFileSync(join(src, r)));
const id = hash.digest('hex').slice(0, 16);
const out = join(app, 'public/calib');
if (existsSync(out)) for (const d of readdirSync(out)) if (d !== id) rmSync(join(out, d), { recursive: true, force: true });
for (const r of files) {
  const to = join(out, id, r);
  if (existsSync(to)) continue;
  mkdirSync(dirname(to), { recursive: true });
  writeFileSync(to, readFileSync(join(src, r)));
}
writeFileSync(join(app, 'public/calib-manifest.json'), `${JSON.stringify({ base: `calib/${id}/`, files }, null, 1)}\n`);
console.log(`copy-calib: ${files.length} files → public/calib/${id}`);
