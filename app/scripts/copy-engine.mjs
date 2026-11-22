// Copy the built engine (engine/scripts/build-engine.sh st|mt) into public/engine/<hash>/ and
// write public/engine-manifest.json. The directory is named by content hash so the files can be
// cached forever. Sources: ENGINE_DIST_ST / ENGINE_DIST_MT, default ../.work/build-engine-*/dist.
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const app = resolve(import.meta.dirname, '..');
const repo = resolve(app, '..');
const out = resolve(app, 'public/engine');
const manifest = { builds: {} };
const hash = createHash('sha256');
const found = [];
for (const v of ['st', 'mt']) {
  const dist = process.env[`ENGINE_DIST_${v.toUpperCase()}`] ?? resolve(repo, `.work/build-engine-${v}/dist`);
  const files = [`slicer-${v}.mjs`, `slicer-${v}.wasm`].map((f) => resolve(dist, f));
  if (!files.every(existsSync)) {
    console.warn(`copy-engine: no ${v} build in ${dist}`);
    continue;
  }
  for (const f of files) hash.update(readFileSync(f));
  found.push({ v, dist, files });
}
if (!found.some((b) => b.v === 'st')) {
  console.error('copy-engine: the single-threaded engine is required (engine/scripts/build-engine.sh st)');
  process.exit(1);
}
const id = hash.digest('hex').slice(0, 16);
rmSync(out, { recursive: true, force: true });
mkdirSync(resolve(out, id), { recursive: true });
for (const { v, files } of found) {
  for (const f of files) cpSync(f, resolve(out, id, f.split('/').pop()));
  manifest.builds[v] = { module: `engine/${id}/slicer-${v}.mjs`, wasmBytes: statSync(files[1]).size };
}
writeFileSync(resolve(app, 'public/engine-manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`copy-engine: ${found.map((b) => b.v).join('+')} → public/engine/${id}`);
