// Bundle OrcaSlicer's system profiles (resources/profiles at the pinned tag) for the browser:
//   public/profiles/<hash>/<Vendor>.json   {"files": {"<Vendor>.json": "…", "<Vendor>/machine/x.json": "…"}}
//   public/profiles-manifest.json          vendor catalog (names, printer models) + bundle paths
//   public/profiles/<hash>/catalog.json    each vendor's presets by type (comparing with any preset)
//   public/profiles/<hash>/presets/<n>.json the presets by name, for the MCP server (server/mcp/shard.ts)
// The engine writes a bundle's files into MEMFS at /orca/system/ and loads them with
// PresetBundle (see engine/bridge/orca_presets.cpp). File contents are kept byte-for-byte.
// Source: ORCA_PROFILES, default ../.work/orca-src/resources/profiles.
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { presetShard, SHARDS } from '../server/mcp/shard.ts';

const app = resolve(import.meta.dirname, '..');
const src = process.env.ORCA_PROFILES ?? resolve(app, '../.work/orca-src/resources/profiles');
if (!existsSync(src)) {
  console.error(`bundle-profiles: ${src} not found (run engine/scripts/prepare-orca.sh)`);
  process.exit(1);
}

function collect(dir, rel, files) {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name),
      r = `${rel}/${name}`;
    if (statSync(p).isDirectory()) collect(p, r, files);
    else if (name.endsWith('.json')) files[r] = readFileSync(p, 'utf8');
  }
}

const vendors = readdirSync(src)
  .filter((f) => f.endsWith('.json'))
  .map((f) => f.slice(0, -5))
  .sort();
const bundles = [];
const presetVendors = {};
/** Each shard's presets: name → vendor → file text. */
const shards = Array.from({ length: SHARDS }, () => ({}));
/** Each vendor's presets one can pick (instantiation), by type: to compare with any of them. */
const catalog = {};
const TYPE = { machine: 'printer', filament: 'filament', process: 'print' };
for (const id of vendors) {
  const indexText = readFileSync(join(src, `${id}.json`), 'utf8');
  const index = JSON.parse(indexText);
  const files = { [`${id}.json`]: indexText };
  if (existsSync(join(src, id))) collect(join(src, id), id, files);
  const models = (index.machine_model_list ?? []).map((m) => {
    const f = files[`${id}/${m.sub_path}`];
    const j = f ? JSON.parse(f) : {};
    // Default filaments by name without the "@…" printer suffix, as the filament picker groups them.
    const materials = [
      ...new Set(
        String(j.default_materials ?? '')
          .split(';')
          .map((n) => n.replace(/\s*@.*$/, '').trim())
          .filter(Boolean),
      ),
    ];
    return {
      name: m.name,
      nozzles: String(j.nozzle_diameter ?? '')
        .split(';')
        .filter(Boolean),
      family: j.family ?? '',
      materials,
    };
  });
  const cat = (catalog[id] = { printer: [], filament: [], print: [] });
  for (const [path, t] of Object.entries(files)) {
    const m = /\/(machine|filament|process)\//.exec(path);
    if (!m) continue;
    try {
      const j = JSON.parse(t);
      if (j.name && String(j.instantiation) === 'true' && j.type === m[1]) cat[TYPE[m[1]]].push(j.name);
    } catch {
      /* not a preset */
    }
  }
  // Which vendor defines each preset, for imports that inherit from a vendor not loaded yet.
  if (id !== 'OrcaFilamentLibrary')
    for (const [path, t] of Object.entries(files)) {
      if (!/\/(machine|filament|process)\//.test(path)) continue;
      try {
        const j = JSON.parse(t);
        if (j.name && j.type !== 'machine_model') (presetVendors[j.name] ??= new Set()).add(id);
      } catch {
        /* not a preset */
      }
    }
  for (const [path, t] of Object.entries(files)) {
    if (!/\/(machine|filament|process)\//.test(path)) continue;
    try {
      const j = JSON.parse(t);
      if (j.name && j.type !== 'machine_model') (shards[presetShard(j.name)][j.name] ??= {})[id] = t;
    } catch {
      /* not a preset */
    }
  }
  const text = JSON.stringify({ files });
  bundles.push({
    id,
    name: index.name ?? id,
    version: index.version ?? '',
    models,
    text,
    printers: (index.machine_list ?? []).length,
    filaments: (index.filament_list ?? []).length,
  });
}
const hash = createHash('sha256');
for (const b of bundles) hash.update(b.id).update(b.text);
const dirId = hash.digest('hex').slice(0, 16);
const out = resolve(app, 'public/profiles');
rmSync(out, { recursive: true, force: true });
mkdirSync(resolve(out, dirId), { recursive: true });
// Names defined by exactly one vendor (shared base presets resolve in any vendor).
const index = Object.fromEntries(
  Object.entries(presetVendors)
    .filter(([, v]) => v.size === 1)
    .map(([n, v]) => [n, [...v][0]]),
);
writeFileSync(resolve(out, dirId, 'index.json'), JSON.stringify(index));
writeFileSync(resolve(out, dirId, 'catalog.json'), JSON.stringify(catalog));
mkdirSync(resolve(out, dirId, 'presets'));
shards.forEach((s, i) => writeFileSync(resolve(out, dirId, 'presets', `${i}.json`), JSON.stringify(s)));
let total = 0;
for (const b of bundles) {
  writeFileSync(resolve(out, dirId, `${b.id}.json`), b.text);
  total += b.text.length;
}
const manifest = {
  source: 'OrcaSlicer resources/profiles',
  base: `profiles/${dirId}`,
  library: 'OrcaFilamentLibrary',
  index: `profiles/${dirId}/index.json`,
  catalog: `profiles/${dirId}/catalog.json`,
  vendors: bundles.filter((b) => b.id !== 'OrcaFilamentLibrary').map(({ text, ...b }) => ({ ...b, bytes: text.length })),
};
writeFileSync(resolve(app, 'public/profiles-manifest.json'), JSON.stringify(manifest));
console.log(`bundle-profiles: ${bundles.length} bundles, ${(total / 1e6).toFixed(1)} MB → public/profiles/${dirId}`);
