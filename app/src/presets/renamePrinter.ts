// Renaming a custom printer (a user printer with no parent) in the user preset files.
// Other presets refer to it by name: the print settings and filaments made for it list it in
// compatible_printers and carry it in their own names ("0.20mm Standard @Acme Cube 0.4 nozzle"),
// and its children name it in inherits. All of it changes together, in desktop's file format.
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { UserFiles } from '../engine/protocol';

/** Characters a preset name cannot have (it is a file name too). */
export const BAD_NAME_CHARS = /[\\/:*?"<>|]/;

/** The name desktop's Create Printer gives a printer: "<model> <nozzle> nozzle". */
export const printerName = (model: string, nozzle: string) => `${model} ${nozzle} nozzle`;

type PresetJson = Record<string, unknown> & {
  name?: string;
  inherits?: string;
  compatible_printers?: string[];
  compatible_prints?: string[];
};

function parse(files: UserFiles): Map<string, PresetJson> {
  const parsed = new Map<string, PresetJson>();
  for (const [path, text] of Object.entries(files)) {
    if (!path.endsWith('.json')) continue;
    try {
      parsed.set(path, JSON.parse(text) as PresetJson);
    } catch {
      /* not a preset */
    }
  }
  return parsed;
}

/**
 * Rename the custom printer `oldName` to "<model> <nozzle> nozzle" (its printer_model becomes
 * `model`). Returns the new files and every preset name that changed (old → new).
 */
export function renamePrinterFiles(
  files: UserFiles,
  oldName: string,
  model: string,
): { files: UserFiles; name: string; renamed: Record<string, string> } {
  const parsed = parse(files);
  const printerPath = [...parsed].find(([path, j]) => path.startsWith('machine/') && j.name === oldName)?.[0];
  const printer = printerPath ? parsed.get(printerPath)! : null;
  if (!printer || printer.inherits) throw new Error('Not a custom printer');
  const nozzle = String(printer.printer_variant || (printer.nozzle_diameter as string[] | undefined)?.[0] || '0.4');
  const name = printerName(model, nozzle);
  const renamed: Record<string, string> = { [oldName]: name };
  // The presets made for it: named "… @<printer>", for it alone.
  for (const [path, j] of parsed) {
    if (path.startsWith('machine/') || !j.name?.endsWith(` @${oldName}`)) continue;
    if (!(j.compatible_printers ?? []).includes(oldName)) continue;
    renamed[j.name] = `${j.name.slice(0, -oldName.length)}${name}`;
  }
  const out = rewrite(files, parsed, renamed, (j, next) => {
    if (j === printer) next.printer_model = model;
  });
  return { files: out, name, renamed };
}

/**
 * The files with presets renamed (old → new): their files (.json and .info) and every reference
 * to them (inherits, compatible printers and print settings, the *_settings_id keys).
 */
function rewrite(
  files: UserFiles,
  parsed: Map<string, PresetJson>,
  renamed: Record<string, string>,
  patch?: (j: PresetJson, next: PresetJson) => void,
): UserFiles {
  const out: UserFiles = {};
  for (const [path, text] of Object.entries(files)) {
    const base = path.replace(/\.(json|info)$/, '');
    const dir = base.slice(0, base.lastIndexOf('/') + 1);
    const own = parsed.get(`${base}.json`)?.name;
    const newName = own !== undefined ? renamed[own] : undefined;
    const newPath = newName ? `${dir}${newName}${path.slice(base.length)}` : path;
    const j = parsed.get(path);
    if (!j) {
      out[newPath] = text;
      continue;
    }
    const r = (s: unknown) => (typeof s === 'string' ? (renamed[s] ?? s) : s);
    const next: PresetJson = { ...j };
    next.name = r(j.name) as string;
    if (j.inherits) next.inherits = r(j.inherits) as string;
    if (Array.isArray(j.compatible_printers)) next.compatible_printers = j.compatible_printers.map((p) => r(p) as string);
    if (Array.isArray(j.compatible_prints)) next.compatible_prints = j.compatible_prints.map((p) => r(p) as string);
    for (const k of ['printer_settings_id', 'print_settings_id', 'filament_settings_id']) {
      if (Array.isArray(j[k])) next[k] = (j[k] as unknown[]).map(r);
      else if (k in j) next[k] = r(j[k]);
    }
    patch?.(j, next);
    // Untouched files stay byte for byte (or the sync would upload them again).
    out[newPath] = JSON.stringify(next) === JSON.stringify(j) ? text : JSON.stringify(next, null, 4);
  }
  return out;
}

/**
 * Rename one of the user's print settings or filaments. Presets of its type based on it follow,
 * and filaments that name print settings as compatible keep naming it. Only its own type changes:
 * a filament may have a print preset's name. Desktop has no rename (only Save as).
 */
export function renamePresetFiles(files: UserFiles, type: 'print' | 'filament', oldName: string, newName: string): UserFiles {
  const parsed = parse(files);
  const dir = type === 'print' ? 'process/' : 'filament/';
  const idKey = type === 'print' ? 'print_settings_id' : 'filament_settings_id';
  if (![...parsed].some(([path, j]) => path.startsWith(dir) && j.name === oldName)) throw new Error('Not a user preset');
  const r = (v: unknown) => (v === oldName ? newName : v);
  const out: UserFiles = {};
  for (const [path, text] of Object.entries(files)) {
    const base = path.replace(/\.(json|info)$/, '');
    const own = path.startsWith(dir) && parsed.get(`${base}.json`)?.name === oldName;
    const newPath = own ? `${base.slice(0, base.lastIndexOf('/') + 1)}${newName}${path.slice(base.length)}` : path;
    const j = parsed.get(path);
    if (!j) {
      out[newPath] = text;
      continue;
    }
    const next: PresetJson = { ...j };
    if (path.startsWith(dir)) {
      next.name = r(j.name) as string;
      if (j.inherits) next.inherits = r(j.inherits) as string;
      if (Array.isArray(j[idKey])) next[idKey] = (j[idKey] as unknown[]).map(r);
      else if (idKey in j) next[idKey] = r(j[idKey]);
    }
    if (type === 'print' && path.startsWith('filament/') && Array.isArray(j.compatible_prints))
      next.compatible_prints = j.compatible_prints.map((x) => r(x) as string);
    out[newPath] = JSON.stringify(next) === JSON.stringify(j) ? text : JSON.stringify(next, null, 4);
  }
  return out;
}
