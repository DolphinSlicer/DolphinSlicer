// Dump OrcaSlicer's option definitions from the built engine (orca_config_schema) to
// public/settings-schema.json, served next to the app and loaded when the settings open, and
// each preset type's default values (desktop's "Default Printer", "Default Filament" and
// "Default Setting", what presets inherit at the root) to public/settings-defaults.json for the
// MCP server (server/mcp/profiles.ts).
// SPDX-License-Identifier: AGPL-3.0-or-later
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const app = resolve(import.meta.dirname, '..');
const dist = process.env.ENGINE_DIST_ST ?? resolve(app, '../.work/build-engine-st/dist');
const mod = await import(resolve(dist, 'slicer-st.mjs'));
const M = await mod.default({ print: () => {}, printErr: () => {} });
const text = M.UTF8ToString(M._orca_config_schema());
writeFileSync(resolve(app, 'public/settings-schema.json'), text);
const s = JSON.parse(text);
console.log(`dump-schema: ${Object.keys(s.options).length} options → public/settings-schema.json`);

M.FS.mkdirTree('/defaults/system');
const P = M._orca_presets_create();
const err = () => M.UTF8ToString(M._orca_presets_last_error(P));
if (M.ccall('orca_presets_load', 'number', ['number', 'string'], [P, '/defaults']) !== 0) throw new Error(err());
// Single strings come escaped as in config files ("\\n"); preset files hold them as text.
const unescapeConfig = (v) => v.replace(/\\(.)/gs, (_, c) => (c === 'n' ? '\n' : c === 'r' ? '\r' : c));
const defaults = {};
for (const [type, name] of [
  ['printer', 'Default Printer'],
  ['filament', 'Default Filament'],
  ['print', 'Default Setting'],
]) {
  const out = M.ccall('orca_presets_preset_values', 'string', ['number', 'string'], [P, JSON.stringify({ type, name })]);
  if (!out) throw new Error(err());
  const values = JSON.parse(out).values;
  for (const [k, v] of Object.entries(values)) if (s.options[k]?.type === 'string' && typeof v === 'string') values[k] = unescapeConfig(v);
  defaults[type] = values;
}
writeFileSync(resolve(app, 'public/settings-defaults.json'), JSON.stringify(defaults));
console.log('dump-schema: default values → public/settings-defaults.json');
