// Dump OrcaSlicer's option definitions from the built engine (orca_config_schema) to
// public/settings-schema.json, served next to the app and loaded when the settings open.
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
