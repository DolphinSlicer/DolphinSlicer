// What the UI can do: import models, choose presets, edit the plate, slice, download.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { BufferAttribute, BufferGeometry, Matrix4, Vector3 } from 'three';
import { chooseFlavor, debugMode, threadSupport } from '../engine/capabilities';
import { EngineClient } from '../engine/engineClient';
import { type Mat4, type SliceBackend, SliceError } from '../engine/types';
import { WasmWorkerBackend } from '../engine/wasmWorkerBackend';
import { renderGcodeThumbnails, thumbnailSizes } from '../view/gcodeThumbnails';
import { engineLayout, engineLayoutWithOwners } from './engineLayout';
import { automatically, noteChange, settingsLive } from './settingsMeta';

export { engineLayout };

import type {
  CalibRequest,
  CreateFilamentSpec,
  CreatePrinterSpec,
  EnginePreview,
  ModelInfo,
  PresetSelection,
  PresetType,
  PresetValues,
  ResponseValue,
  UserFiles,
} from '../engine/protocol';
import { printerSettingsId } from '../gcode/parse';
import type { PreviewData } from '../gcode/preview';
import { previewInWorker } from '../gcode/previewInWorker';
import { N_, t, tr } from '../i18n/i18n';
import { bedFromConfig, keepBed, placeFootprint, type Rect } from '../model/bed';
import { type ConvertedPreset, convertPresets, isSourceConfig, parseSourceFile } from '../presets/convert/prusa';
import {
  DEFAULT_LIBRARY,
  filamentInLibrary,
  type Library,
  libraryVendors,
  loadLibrary,
  printerInLibrary,
  saveLibrary,
} from '../presets/library';
import { presetVendorIndex, profilesManifest, vendorBundle } from '../presets/profiles';
import { BAD_NAME_CHARS, renamePresetFiles, renamePrinterFiles } from '../presets/renamePrinter';
import { loadUserFiles, saveUserFiles } from '../presets/userStore';
import { loadSchema } from '../settings/schema';
import { ask } from '../ui/Confirm';
import { describeError } from '../ui/errors';
import { loadedCounts, onCollect, remember } from './history';
import { addPrinterLink, renamePrinterLinks } from './printerActions';
import { BED_KEY, dismissAbout, get, notify, type SceneObject, type SourceFile, set, touchPlate } from './store';
import { loadedVolumes } from './supportVolumes';

// ── services ─────────────────────────────────────────────────────────────────────────────
/** Auxiliary engine (always single-threaded): model inspection and presets. */
export const aux = new EngineClient('st');
let backend: SliceBackend | null = null;

export const geometries = new Map<string, BufferGeometry>();
export let gcodeBlob: Blob | null = null;
export let parsedGcode: PreviewData | null = null;
const listeners = new Set<() => void>();
/** Subscribe to G-code preview data changes (the viewport rebuilds its meshes). */
export function onPreviewData(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

const SELECTION_KEY = 'dolphin-slicer.selection.v1';
/** The last selection (vendor: before the printer library, the vendor picker's choice). */
export interface SavedSelection {
  vendor?: string;
  printer: string;
  process?: string;
  filament?: string;
}
export function loadSaved(): SavedSelection | null {
  try {
    return JSON.parse(localStorage.getItem(SELECTION_KEY) ?? 'null');
  } catch {
    return null;
  }
}
function save(sel: SavedSelection) {
  try {
    localStorage.setItem(SELECTION_KEY, JSON.stringify(sel));
  } catch {
    /* storage unavailable */
  }
  noteChange('selection', sel);
}

/**
 * The plate type last picked per printer, as desktop keeps it in its app config. A model's
 * variants (nozzles) share it: they have the same plates.
 */
const BED_TYPES_KEY = 'dolphin-slicer.bedTypes.v1';
export function bedTypes(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(BED_TYPES_KEY) ?? '{}') ?? {};
  } catch {
    return {};
  }
}
/** What a printer's plate type is kept under: its model, or its own name without one. */
function bedTypeKey(printer: string): string {
  const e = get().presets.printers.find((x) => x.name === printer);
  return e?.model ? `model:${e.user ? 'user' : e.vendor}:${e.model}` : printer;
}
function rememberBedType(printer: string, type: string) {
  saveBedTypes({ ...bedTypes(), [printer]: type });
}
export function saveBedTypes(m: Record<string, string>) {
  try {
    localStorage.setItem(BED_TYPES_KEY, JSON.stringify(m));
  } catch {
    /* storage unavailable */
  }
  noteChange('bedTypes', m);
}
/** The key the current printer's plate type is kept under. */
export const currentBedTypeKey = () => {
  const st = get().presets.state;
  return st ? bedTypeKey(st.printer) : null;
};

export async function startApp() {
  const flavor = chooseFlavor();
  set({ engine: { flavor, reason: threadSupport().reason, info: null } });
  const b = (backend = new WasmWorkerBackend(flavor));
  // The slicing engine is not needed until the first slice: start it once the presets (which
  // run in the auxiliary engine) are up, so it does not compete with them for the CPU at load.
  // A slice before that starts it itself.
  const warmUp = () =>
    b.info().then(
      (i) => set((s) => ({ engine: { ...s.engine, info: `OrcaSlicer ${i.orca_version} (${i.build})` } })),
      (e) => notify({ kind: 'error', ...describeError(e) }),
    );
  const saved = loadSaved();
  let lib = loadLibrary();
  if (!lib) {
    // First start (or the first since the library existed): open the wizard, and keep the
    // printer chosen before, if any.
    lib = { ...DEFAULT_LIBRARY, vendors: saved?.vendor ? [saved.vendor] : [] };
    set({ wizard: 'printers' });
  }
  set({ library: lib });
  try {
    await loadPresets(lib, saved ?? undefined);
    if (!loadLibrary()) adoptCurrentPrinter();
  } catch (e) {
    if (saved) {
      // A stale saved selection should not lock the user out.
      try {
        await loadPresets(DEFAULT_LIBRARY);
        return;
      } catch {
        /* fall through */
      }
    }
    set((s) => ({ presets: { ...s.presets, status: 'error', message: String((e as Error).message) } }));
    notify({ kind: 'error', ...describeError(e) });
  } finally {
    // What the app chose while starting is not a change of the user's (settingsMeta.ts).
    settingsLive();
    void warmUp();
  }
}

/** Put the selected printer into the library (first start with a printer chosen before). */
function adoptCurrentPrinter() {
  const s = get();
  const e = s.presets.printers.find((x) => x.name === s.presets.state?.printer);
  const lib = s.library;
  if (e && !e.user && e.model && e.variant && !printerInLibrary(lib, e))
    setLibrary({ ...lib, printers: [...lib.printers, { vendor: e.vendor, model: e.model, nozzle: e.variant }] });
  else saveLibrary(lib);
}

// ── presets ──────────────────────────────────────────────────────────────────────────────
/** Save the library; the pickers follow it. Load profiles of new vendors with loadPresets. */
export function setLibrary(lib: Library) {
  saveLibrary(lib);
  noteChange('library', lib);
  set({ library: lib });
}

/**
 * Load the profiles the library needs (OrcaSlicer's filament library plus each vendor of an
 * added printer) and select a printer from the library: the given one, else the current one,
 * else the first. Rebuilding the preset bundle drops unsaved edits; callers ask first.
 */
export async function loadPresets(lib: Library = get().library, sel?: Partial<SavedSelection>) {
  const p = get().presets;
  set({ presets: { ...p, status: 'loading' } });
  // The engine starts while the profiles download.
  const started = aux.start();
  started.catch(() => {
    /* thrown where it is awaited */
  });
  const m = await profilesManifest();
  const known = new Set(m.vendors.map((v) => v.id));
  const want = libraryVendors(lib).filter((v) => known.has(v));
  // Vendors stay loaded once loaded, so presets from earlier choices stay resolvable.
  const loaded = [...new Set([...p.loadedVendors, ...want])];
  let printers = p.printers;
  const reload = loaded.length !== p.loadedVendors.length || !p.state;
  if (reload) {
    const [bundles, userFiles] = await Promise.all([Promise.all([m.library, ...loaded].map(vendorBundle)), loadUserFiles(), started]);
    printers = (await aux.call('presetsLoad', { vendors: bundles, userFiles })).printers;
  } else await started;
  set((s) => ({ presets: { ...s.presets, loadedVendors: loaded, printers } }));
  const visible = printers.filter((x) => printerInLibrary(lib, x));
  const cur = p.state;
  const pickName =
    [sel?.printer, cur?.printer].find((n) => n && visible.some((x) => x.name === n)) ?? visible[0]?.name ?? printers[0]?.name;
  if (!pickName) throw new Error('No printers');
  if (pickName === cur?.printer) {
    // Same printer: keep the print settings and filament (the bundle may have been rebuilt).
    if (reload) await applySelection({ printer: pickName, process: cur.process, filaments: cur.filaments });
    // Nothing to reload (e.g. only a filament added): done loading all the same.
    else set((s) => ({ presets: { ...s.presets, status: 'ready' } }));
  } else {
    await applySelection({
      printer: pickName,
      defaults: true,
      ...(sel?.process ? { process: sel.process } : {}),
      ...(sel?.filament ? { filaments: [sel.filament] } : {}),
    });
    if (!sel?.filament) await preferLibraryFilament();
  }
}

/**
 * After a printer switch the printer's default filament is selected. If it is not in the
 * library but a library filament fits the printer, use that one instead.
 */
export async function preferLibraryFilament() {
  const s = get();
  const st = s.presets.state;
  // A filament with unsaved edits stays (they would be lost).
  if (!st || st.dirty?.filament) return;
  const all = st.filament_presets;
  const current = all.find((f) => f.name === st.filaments[0]);
  if (current && filamentInLibrary(s.library, current)) return;
  const alt = all.find((f) => filamentInLibrary(s.library, f));
  if (alt) await applySelection({ printer: st.printer, process: st.process, filaments: [alt.name] });
}

export async function applySelection(selection: PresetSelection) {
  set((s) => ({ presets: { ...s.presets, status: 'loading' } }));
  try {
    // Print settings or a filament the printer doesn't have (deleted, or not on this device) are
    // not fatal: the printer's defaults, but those asked for that it has, and a library filament.
    let state: ResponseValue['presetsSelect'];
    try {
      state = await aux.call('presetsSelect', { selection });
    } catch {
      state = await aux.call('presetsSelect', { selection: selection.printer ? { printer: selection.printer, defaults: true } : {} });
      const lib = get().library;
      const process =
        selection.process && state.processes.some((x) => x.name === selection.process && x.compatible !== false)
          ? selection.process
          : undefined;
      const want = selection.filaments?.[0];
      const fits = state.filament_presets.filter((f) => f.compatible !== false);
      const now = state.filaments[0];
      const filament =
        want && fits.some((f) => f.name === want)
          ? want
          : fits.some((f) => f.name === now && filamentInLibrary(lib, f))
            ? undefined
            : fits.find((f) => filamentInLibrary(lib, f))?.name;
      if (process || filament)
        state = await aux.call('presetsSelect', {
          selection: { ...(process ? { process } : {}), ...(filament ? { filaments: [filament] } : {}) },
        });
    }
    // Another printer starts on its default plate; the one last picked for it, when it has one.
    // (Kept under the printer's own name by earlier versions.)
    const key = bedTypeKey(state.printer);
    const kept = bedTypes()[key] ?? bedTypes()[state.printer];
    if (selection.bed_type) rememberBedType(key, state.bed_type);
    else if ((selection.printer || selection.variant) && kept && kept !== state.bed_type && state.bed_types.includes(kept))
      state = await aux.call('presetsSelect', { selection: { bed_type: kept } });
    const config = await aux.call('presetsConfig', {});
    const bed = keepBed(get().presets.bed, bedFromConfig(JSON.parse(config)));
    set((s) => ({ presets: { ...s.presets, status: 'ready', state, config, bed, message: undefined } }));
    try {
      localStorage.setItem(BED_KEY, JSON.stringify(bed));
    } catch {
      /* storage unavailable */
    }
    save({ printer: state.printer, process: state.process, filament: state.filaments[0] });
    touchPlate();
  } catch (e) {
    set((s) => ({ presets: { ...s.presets, status: 'error', message: String((e as Error).message) } }));
    throw e;
  }
}

/**
 * Load changed user presets (from Drive sync) into the engine, keeping the selection where the
 * presets still exist. Unsaved edits are lost, so the caller only does this without any.
 */
export async function reloadUserPresets(files: UserFiles, mtimes: Record<string, number>) {
  // What the app selects or adds to the library meanwhile is not the user's (settingsMeta.ts).
  await automatically(() => reloadUserPresetsNow(files, mtimes));
}

async function reloadUserPresetsNow(files: UserFiles, mtimes: Record<string, number>) {
  await saveUserFiles(files, mtimes);
  await addVendorsFor(files);
  const p = get().presets;
  const edits = await unsavedEdits();
  const m = await profilesManifest();
  const bundles = await Promise.all([m.library, ...p.loadedVendors].map(vendorBundle));
  const r = await aux.call('presetsLoad', { vendors: bundles, userFiles: files });
  set((s) => ({ presets: { ...s.presets, printers: r.printers } }));
  const st = p.state;
  try {
    await applySelection(st ? { printer: st.printer, process: st.process, filaments: st.filaments } : {});
  } catch {
    // The selected printer was deleted on another device.
    await loadPresets(get().library, {});
  }
  // The unsaved edits again, on the presets still selected.
  const now = get().presets.state;
  const selected = { printer: now?.printer, print: now?.process, filament: now?.filaments[0] };
  const again = edits.filter((e) => selected[e.type] === e.name);
  for (const e of again) await aux.call('presetsEdit', { type: e.type, values: e.values as Record<string, string> });
  if (again.length) await refreshConfig();
}

type Edit = string | { elements: string[] };
/** The selected presets' unsaved edits: the edited settings' values. */
async function unsavedEdits(): Promise<{ type: PresetType; name: string; values: Record<string, Edit> }[]> {
  const dirty = get().presets.state?.dirty;
  const out: { type: PresetType; name: string; values: Record<string, Edit> }[] = [];
  for (const type of ['printer', 'print', 'filament'] as const) {
    if (!dirty?.[type]) continue;
    const v = await presetValues(type);
    const values: Record<string, Edit> = {};
    // One value of a list (a nozzle's) is reported as "key#index": the whole list is kept.
    for (const k of new Set(v.dirty.map((x) => x.replace(/#\d+$/, '')))) {
      const x = v.values[k];
      if (x !== undefined) values[k] = Array.isArray(x) ? { elements: x } : x;
    }
    if (Object.keys(values).length) out.push({ type, name: v.name, values });
  }
  return out;
}

/**
 * The user's files of the selected presets with unsaved edits (a Drive sync leaves them as they
 * are until the edits are saved or discarded).
 */
export function editedPresetFiles(files: UserFiles): Set<string> {
  const st = get().presets.state;
  const out = new Set<string>();
  if (!st) return out;
  const edited: [string, string | undefined][] = [
    ['machine/', st.dirty.printer ? st.printer : undefined],
    ['process/', st.dirty.print ? st.process : undefined],
    ['filament/', st.dirty.filament ? st.filaments[0] : undefined],
  ];
  for (const [path, text] of Object.entries(files)) {
    if (!path.endsWith('.json')) continue;
    let name: unknown;
    try {
      name = (JSON.parse(text) as { name?: unknown }).name;
    } catch {
      continue;
    }
    if (!edited.some(([dir, n]) => n && path.startsWith(dir) && name === n)) continue;
    out.add(path);
    out.add(path.replace(/\.json$/, '.info'));
  }
  return out;
}

/**
 * User presets inherit from system presets; make sure their vendors are in the library (and
 * loaded by the next loadPresets). Returns true if any vendor was added.
 */
async function addVendorsFor(files: UserFiles | { name: string; text: string }[], ok?: () => Promise<boolean>): Promise<boolean | null> {
  const texts = Array.isArray(files) ? files.map((f) => f.text) : Object.values(files);
  const names = new Set<string>();
  for (const t of texts) {
    try {
      const j = JSON.parse(t) as { inherits?: string };
      if (j.inherits) names.add(j.inherits);
    } catch {
      /* bundles and .info files */
    }
  }
  if (!names.size) return false;
  const index = await presetVendorIndex().catch(() => ({}) as Record<string, string>);
  const lib = get().library;
  const extra = [...new Set([...names].map((n) => index[n]).filter((v): v is string => !!v))].filter(
    (v) => !libraryVendors(lib).includes(v) && !get().presets.loadedVendors.includes(v),
  );
  if (!extra.length) return false;
  // The caller rebuilds the presets for them, which drops unsaved edits: null when that is refused.
  if (ok && !(await ok())) return null;
  setLibrary({ ...lib, vendors: [...lib.vendors, ...extra] });
  const m = await profilesManifest();
  const p = get().presets;
  const loaded = [...new Set([...p.loadedVendors, ...extra.filter((v) => m.vendors.some((x) => x.id === v))])];
  set((s) => ({ presets: { ...s.presets, loadedVendors: loaded } }));
  return true;
}

// ── settings (edit, save, delete, import, export) ───────────────────────────────────────
/** Re-read the selection and the composed config after an edit (the next slice uses it). */
async function refreshConfig() {
  const state = await aux.call('presetsSelect', { selection: {} });
  const config = await aux.call('presetsConfig', {});
  set((s) => ({ presets: { ...s.presets, state, config, bed: keepBed(s.presets.bed, bedFromConfig(JSON.parse(config))) } }));
  touchPlate();
}

export function presetValues(type: PresetType, extruder = 0): Promise<PresetValues> {
  return aux.call('presetsValues', { type, extruder });
}

export async function editSetting(
  type: PresetType,
  key: string,
  value: string | { index: number; value: string } | { elements: string[] },
) {
  await aux.call('presetsEdit', { type, values: { [key]: value as string } });
  await refreshConfig();
}

/** Another preset's settings, to show beside the edited one's (the selected one as edited). */
/** A preset's settings; one of a vendor not loaded (`vendor`) from its presets loaded aside. */
export async function presetValuesOf(type: PresetType, name: string, vendor?: string) {
  const r = await aux.call('presetsPresetValues', { type, name, vendor });
  if (!r.unloaded || !vendor) return r;
  const m = await profilesManifest();
  const vendors = await Promise.all([...new Set([m.library, vendor])].map(vendorBundle));
  await aux.call('presetsLoadAside', { vendor, vendors });
  return aux.call('presetsPresetValues', { type, name, vendor });
}

/** Every preset of a type, also those that don't fit the printer (to compare with). */
export function allPresetsOf(type: PresetType) {
  return aux.call('presetsAll', { type });
}

/** Several settings edited at once (e.g. another preset's values copied over). */
export async function editSettings(
  type: PresetType,
  values: Record<string, string | { index: number; value: string } | { elements: string[] }>,
) {
  await aux.call('presetsEdit', { type, values: values as Record<string, string> });
  await refreshConfig();
}

export async function resetSettings(type: PresetType, keys: string[] | undefined, to: 'saved' | 'system') {
  await aux.call('presetsReset', { type, ...(keys ? { keys } : {}), to });
  await refreshConfig();
}

export async function savePreset(type: PresetType, name: string) {
  const r = await aux.call('presetsSave', { type, name });
  await saveUserFiles(r.userFiles);
  await refreshPrinterList();
  await refreshConfig();
  rememberSelection();
  return r.name;
}

export async function deletePreset(type: PresetType, name: string) {
  const r = await aux.call('presetsDelete', { type, name });
  await saveUserFiles(r.userFiles);
  await refreshPrinterList();
  await refreshConfig();
  // The engine picks the next printer among all it has loaded: take one of the library instead.
  const p = get().presets;
  if (type === 'printer' && p.state && !p.printers.some((x) => x.name === p.state!.printer && printerInLibrary(get().library, x))) {
    const first = p.printers.find((x) => printerInLibrary(get().library, x));
    if (first) {
      await applySelection({ printer: first.name, defaults: true });
      await preferLibraryFilament();
    }
  }
  rememberSelection();
}

/**
 * Import preset files: OrcaSlicer/Bambu Studio presets and bundles as they are, PrusaSlicer and
 * SuperSlicer configs (.ini, or the settings in their G-code) converted first. Returns what was
 * imported, and the conversions with their notes. Presets whose names exist already are kept
 * unless replaceOk agrees to replace them (desktop asks the same).
 */
export async function importPresets(
  files: { name: string; bytes: Promise<ArrayBuffer> }[],
  discardOk?: () => Promise<boolean>,
  replaceOk?: (names: string[]) => Promise<boolean>,
): Promise<{ imported: { type: string; name: string }[]; converted: ConvertedPreset[]; canceled?: boolean }> {
  let read = await Promise.all(files.map(async (f) => ({ name: f.name, bytes: await f.bytes })));
  const sources = read
    .filter((f) => /\.(ini|gcode|gco|g)$/i.test(f.name))
    .map((f) => ({ name: f.name, text: new TextDecoder().decode(f.bytes) }))
    .filter((f) => isSourceConfig(f.name, f.text));
  let converted: ConvertedPreset[] = [];
  if (sources.length) {
    const schema = await loadSchema();
    converted = convertPresets(
      sources.flatMap((f) => parseSourceFile(f.name, f.text)),
      schema,
      `${schema.orca_version.replace(/[^\d.].*$/, '')}.0`,
    );
    const enc = new TextEncoder();
    read = [
      ...read.filter((f) => !sources.some((x) => x.name === f.name)),
      ...converted.map((c) => ({
        name: `${c.name.replace(/[\\/:*?"<>|]/g, '_')}.json`,
        bytes: enc.encode(JSON.stringify(c.json, null, 4)).buffer as ArrayBuffer,
      })),
    ];
  }
  if (!read.length) return { imported: [], converted };
  // Presets inherit from system presets: load their vendors first, or the import cannot resolve them.
  let texts = read.filter((f) => /\.json$/i.test(f.name)).map((f) => ({ name: f.name, text: new TextDecoder().decode(f.bytes) }));
  // A preset's file is named after it: one with a name no file can have would be lost on the next start.
  const unusable = texts.filter((f) => {
    let name: unknown;
    try {
      name = (JSON.parse(f.text) as { name?: unknown }).name;
    } catch {
      return false;
    }
    const problem = typeof name === 'string' ? nameProblem(name) : null;
    if (problem) notify({ kind: 'warning', title: f.name, message: t(problem) });
    return !!problem;
  });
  if (unusable.length) {
    read = read.filter((f) => !unusable.some((x) => x.name === f.name));
    texts = texts.filter((f) => !unusable.includes(f));
    if (!read.length) return { imported: [], converted, canceled: true };
  }
  // Another vendor's profiles rebuild the presets, which drops unsaved edits: discardOk asks first.
  const added = await addVendorsFor(texts, discardOk);
  if (added === null) return { imported: [], converted, canceled: true };
  if (added) await reloadWithVendors();
  let r = await aux.call('presetsImport', { files: read });
  if (r.existing.length && replaceOk && (await replaceOk(r.existing))) {
    const again = await aux.call('presetsImport', { files: read, replace: r.existing });
    r = { ...again, imported: [...r.imported, ...again.imported] };
  }
  await saveUserFiles(r.userFiles);
  await refreshPrinterList();
  await refreshConfig();
  return { imported: r.imported, converted, canceled: !r.imported.length && r.existing.length > 0 };
}

/** The user preset file of the selected preset of a type (desktop format), for download. */
export async function exportPreset(type: PresetType) {
  const v = await presetValues(type);
  if (!v.user || !v.file) throw new Error(N_('Save the preset first.'));
  const files = await aux.call('presetsUserFiles', {});
  const rel = v.file.replace(/^\/orca\/user\/default\//, '');
  const text = files[rel];
  if (text === undefined) throw new Error(N_('Preset file not found.'));
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  a.download = rel.split('/').pop()!;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

async function refreshPrinterList() {
  const printers = await aux.call('presetsPrinters', {});
  set((s) => ({ presets: { ...s.presets, printers } }));
}

function rememberSelection() {
  const s = get().presets;
  if (s.state) save({ printer: s.state.printer, process: s.state.process, filament: s.state.filaments[0] });
}

// ── custom printers (desktop's Create Printer dialog) ─────────────────────────────────
/** The print settings and filaments a new printer can start from: those that fit this printer. */
export function printerTemplates(printer: string) {
  return aux.call('presetsTemplates', { printer });
}

/** The user's print settings and filaments made for a printer model (a new variant shares them). */
export function linkedPresets(model: string) {
  return aux.call('presetsLinked', { model });
}

/**
 * Load a printer maker's profiles for this session (to start a new printer from one of theirs),
 * without adding the maker to the library: the new printer copies what it needs.
 */
export async function loadVendorProfiles(vendor: string) {
  if (get().presets.loadedVendors.includes(vendor)) return;
  set((s) => ({ presets: { ...s.presets, loadedVendors: [...s.presets.loadedVendors, vendor] } }));
  await reloadWithVendors();
}

/**
 * Create a custom printer (a user preset with no parent) with copies of the chosen print settings
 * and filaments made for it, and switch to it. Throws {@link PresetsExist} when presets with the
 * new names exist, unless overwrite is set.
 */
export async function createPrinter(spec: CreatePrinterSpec) {
  let r: ResponseValue['presetsCreatePrinter'];
  try {
    r = await aux.call('presetsCreatePrinter', { spec });
  } catch (e) {
    const detail = (e as { detail?: string }).detail ?? '';
    if (!spec.overwrite && detail.startsWith('[')) throw new PresetsExist(JSON.parse(detail) as string[]);
    throw e;
  }
  await saveUserFiles(r.userFiles);
  await refreshPrinterList();
  // Another nozzle of a model: the printers sent to with the model's profiles take it too.
  const all = get().presets.printers;
  const model = all.find((e) => e.name === r.printer)?.model;
  if (model)
    addPrinterLink(
      r.printer,
      all.filter((e) => e.model === model && e.name !== r.printer).map((e) => e.name),
    );
  await applySelection({ printer: r.printer, process: r.process, filaments: [r.filament] });
  rememberSelection();
  return r.printer;
}

/** The longest printer brand and model: its presets' names ("<setting> @<model> <nozzle> nozzle") hold it. */
export const MAX_MODEL_NAME = 100;

/**
 * Why a preset can't have this name (untranslated), or null. Its file is named after it: no
 * characters a file name can't have, and the length desktop's Save dialog allows.
 */
export function nameProblem(name: string, max = 150): string | null {
  // eslint-disable-next-line no-control-regex
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it refuses
  if (!name.trim() || BAD_NAME_CHARS.test(name) || /[\x00-\x1f\x7f]/.test(name)) return N_('Use letters, numbers and spaces in the name.');
  if (name.length > max || new TextEncoder().encode(name).length > 230) return N_('The name is too long.');
  return null;
}

/** Whether the user has a preset of this type and name. */
export async function userPresetExists(type: PresetType, name: string): Promise<boolean> {
  const dir = type === 'print' ? 'process/' : type === 'filament' ? 'filament/' : 'machine/';
  return Object.entries(await loadUserFiles()).some(([path, text]) => {
    if (!path.startsWith(dir) || !path.endsWith('.json')) return false;
    try {
      return (JSON.parse(text) as { name?: unknown }).name === name;
    } catch {
      return false;
    }
  });
}

/**
 * Rename a custom printer to "<model> <nozzle> nozzle", with its own print settings and
 * filaments and every preset that refers to it (in the files, then reloaded). Unsaved edits are
 * lost, so the caller only does this without any. Returns the new name.
 */
export async function renamePrinter(oldName: string, model: string) {
  model = model.trim().replace(/\s+/g, ' ');
  const problem = nameProblem(model, MAX_MODEL_NAME);
  if (problem) throw new Error(problem);
  const r = renamePrinterFiles(await loadUserFiles(), oldName, model);
  if (r.name === oldName) return oldName;
  if (get().presets.printers.some((x) => x.name === r.name)) throw new Error(N_('A printer with this name exists already.'));
  await saveUserFiles(r.files);
  renamePrinterLinks(r.renamed);
  const st = get().presets.state;
  const m = (n: string) => r.renamed[n] ?? n;
  const manifest = await profilesManifest();
  const bundles = await Promise.all([manifest.library, ...get().presets.loadedVendors].map(vendorBundle));
  const loaded = await aux.call('presetsLoad', { vendors: bundles, userFiles: r.files });
  set((s) => ({ presets: { ...s.presets, printers: loaded.printers } }));
  await applySelection(
    st ? { printer: m(st.printer), process: m(st.process), filaments: st.filaments.map(m) } : { printer: r.name, defaults: true },
  );
  rememberSelection();
  return r.name;
}

/**
 * Rename one of the user's print settings or filaments (desktop has no rename): its file, presets
 * of its type based on it, and filaments naming it as compatible print settings follow. Unsaved
 * edits are lost, so the caller only does this without any. Returns the new name.
 */
export async function renamePreset(type: 'print' | 'filament', oldName: string, newName: string) {
  newName = newName.trim().replace(/\s+/g, ' ');
  const problem = nameProblem(newName);
  if (problem) throw new Error(problem);
  if (newName === oldName) return oldName;
  const st = get().presets.state;
  const before = await loadUserFiles();
  // Its type's names: the user's (for any printer) and those listed (system ones too).
  const dir = type === 'print' ? 'process/' : 'filament/';
  const own = Object.entries(before)
    .filter(([path]) => path.startsWith(dir) && path.endsWith('.json'))
    .map(([, text]) => {
      try {
        return String((JSON.parse(text) as { name?: unknown }).name ?? '');
      } catch {
        return '';
      }
    });
  const listed = type === 'print' ? (st?.processes ?? []).map((x) => x.name) : (await filamentSources()).map((f) => f.name);
  // And every system preset: one of a printer not chosen now would hide it on that printer.
  const system = Object.keys(await presetVendorIndex().catch(() => ({})));
  if ([...own, ...listed, ...system].includes(newName)) throw new Error(N_('A preset with this name exists already.'));
  const files = renamePresetFiles(before, type, oldName, newName);
  await saveUserFiles(files);
  const m = (n: string) => (n === oldName ? newName : n);
  const manifest = await profilesManifest();
  const bundles = await Promise.all([manifest.library, ...get().presets.loadedVendors].map(vendorBundle));
  const loaded = await aux.call('presetsLoad', { vendors: bundles, userFiles: files });
  set((s) => ({ presets: { ...s.presets, printers: loaded.printers } }));
  if (st)
    await applySelection({
      printer: st.printer,
      process: type === 'print' ? m(st.process) : st.process,
      filaments: type === 'filament' ? st.filaments.map(m) : st.filaments,
    });
  rememberSelection();
  return newName;
}

/** Every filament preset, with what desktop's Create Filament dialog needs to list them. */
export function filamentSources() {
  return aux.call('presetsFilamentList', {});
}

/**
 * Create a filament as desktop's Create Filament dialog does: "<name> @<printer>" copies for the
 * chosen printers. Throws {@link PresetsExist} when presets with the new names exist, unless
 * overwrite is set. Returns the presets made.
 */
export async function createFilament(spec: CreateFilamentSpec) {
  let r: ResponseValue['presetsCreateFilament'];
  try {
    r = await aux.call('presetsCreateFilament', { spec });
  } catch (e) {
    const detail = (e as { detail?: string }).detail ?? '';
    if (!spec.overwrite && detail.startsWith('[')) throw new PresetsExist(JSON.parse(detail) as string[]);
    throw e;
  }
  await saveUserFiles(r.userFiles);
  await refreshConfig();
  rememberSelection();
  return r.created;
}

export class PresetsExist extends Error {
  constructor(readonly names: string[]) {
    super('Presets with these names exist');
  }
}

/** Rebuild the preset bundle with every vendor in loadedVendors, keeping the selection. */
async function reloadWithVendors() {
  const p = get().presets;
  const m = await profilesManifest();
  const bundles = await Promise.all([m.library, ...p.loadedVendors].map(vendorBundle));
  const r = await aux.call('presetsLoad', { vendors: bundles, userFiles: await loadUserFiles() });
  set((s) => ({ presets: { ...s.presets, printers: r.printers } }));
  const st = p.state;
  if (st) await applySelection({ printer: st.printer, process: st.process, filaments: st.filaments });
}

/**
 * The auxiliary engine starts over after a crash (a file it cannot read, no memory left): the
 * presets go into the new one, selected as they were. Unsaved edits were in the old one.
 */
let reviving: Promise<void> | null = null;
function auxReady(): Promise<void> {
  if (aux.running) return reviving ?? Promise.resolve();
  return (reviving ??= (async () => {
    const st = get().presets.state;
    await aux.start();
    if (!st) return;
    const lost = [st.dirty?.printer && st.printer, st.dirty?.filament && st.filaments[0], st.dirty?.print && st.process].filter(
      (n): n is string => !!n,
    );
    await reloadWithVendors();
    if (lost.length) notify({ kind: 'warning', title: t('Unsaved changes to {names} were lost.', { names: lost.join(', ') }) });
  })()
    .catch((e) => {
      notify({ kind: 'error', ...describeError(e) });
    })
    .finally(() => {
      reviving = null;
    }));
}
aux.onCrash = () => {
  void auxReady();
};

// ── models ───────────────────────────────────────────────────────────────────────────────
let nextObjectId = 1;
/** A new object id (its mesh goes into `geometries` under it). */
export const newObjectId = () => `o${nextObjectId++}`;

function meshesToGeometries(buf: ArrayBuffer, count: number): BufferGeometry[] {
  const out: BufferGeometry[] = [];
  const dv = new DataView(buf);
  let off = 0;
  for (let k = 0; k < count; k++) {
    const nv = dv.getUint32(off, true),
      nt = dv.getUint32(off + 4, true);
    off += 8;
    const pos = new Float32Array(buf.slice(off, off + nv * 12));
    off += nv * 12;
    const idx = new Uint32Array(buf.slice(off, off + nt * 12));
    off += nt * 12;
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(pos, 3));
    g.setIndex(new BufferAttribute(idx, 1));
    g.computeBoundingBox();
    g.computeBoundingSphere();
    out.push(g);
  }
  return out;
}

const SUPPORTED = /\.(stl|3mf|obj|amf)$/i;

/**
 * Start reading files immediately. Call this synchronously in the drop/change event, before any
 * await: archive tools such as WinRAR hand over a temporary extracted copy and delete it as soon
 * as the drag ends, so a read that starts later fails with NotReadableError.
 */
export function readNow(list: File[]): { name: string; bytes: Promise<ArrayBuffer> }[] {
  return list.map((f) => {
    const bytes = f.arrayBuffer();
    bytes.catch(() => {}); // reported where awaited
    return { name: f.name, bytes };
  });
}

function unreadable(name: string, e: unknown) {
  const gone = (e as Error)?.name === 'NotReadableError' || (e as Error)?.name === 'NotFoundError';
  notify({
    kind: 'error',
    title: t('Could not read {name}', { name }),
    message: gone ? t('Extract the file first, then try again.') : String((e as Error)?.message ?? e),
  });
}

export async function importFiles(list: { name: string; bytes: Promise<ArrayBuffer> }[]) {
  const accepted = list.filter((f) => SUPPORTED.test(f.name));
  for (const f of list.filter((f) => !SUPPORTED.test(f.name))) {
    const step = /\.(step|stp)$/i.test(f.name);
    notify({
      kind: 'warning',
      title: t('{name} was not imported', { name: f.name }),
      message: step ? t('STEP isn’t supported yet. Use STL or 3MF.') : t('Supported formats: STL, 3MF, OBJ, AMF.'),
    });
  }
  if (!accepted.length) return;
  set({ importing: true });
  try {
    await aux.start();
    let added = false;
    for (const file of accepted) {
      let bytes: ArrayBuffer;
      try {
        bytes = await file.bytes;
      } catch (e) {
        unreadable(file.name, e);
        continue;
      }
      let r: { info: ModelInfo; meshes: ArrayBuffer };
      try {
        r = await inspect(file.name, bytes);
      } catch (e) {
        notify({ kind: 'error', ...describeError(e), title: t('Could not open {name}', { name: file.name }) });
        continue;
      }
      // An OrcaSlicer (Bambu Studio) project opened on an empty plate: its settings too.
      const settings =
        r.info.bbl_3mf && get().objects.length === 0 && is3mfProject({ name: file.name, bytes }) ? r.info.project_config : undefined;
      // All the files of one import are one step to undo.
      addInspected({ name: file.name, bytes }, r.info, meshesToGeometries(r.meshes, r.info.objects.length), added);
      added = true;
      if (settings) await loadProjectSettings(file.name, settings);
    }
    // Shown where they went (a drop on the preview or the settings).
    if (added && get().view !== 'prepare' && get().view !== 'library') set({ view: 'prepare' });
  } catch (e) {
    notify({ kind: 'error', ...describeError(e) });
  } finally {
    set({ importing: false });
  }
}

/** The files of desktop's resources/calib a calibration test loads (as Plater::calib_* do). */
function calibFiles(request: CalibRequest, belt: boolean): string[] {
  const p = request.params;
  switch (p.mode) {
    case 'pa_line':
      return ['pressure_advance/pressure_advance_test.drc'];
    case 'pa_pattern':
      return [];
    case 'pa_tower':
      return ['pressure_advance/tower_with_seam.drc'];
    case 'flow_rate': {
      const f = request.flow;
      const name = f?.linear
        ? f.pass === 2
          ? 'Orca-LinearFlow_fine'
          : 'Orca-LinearFlow'
        : f?.pass === 2
          ? 'flowrate-test-pass2'
          : 'flowrate-test-pass1';
      return [`filament_flow/${name}.3mf`];
    }
    case 'temp_tower':
      return belt && (p.test_model ?? 0) >= 1
        ? [`temperature_tower/belt_temp_tower_${Math.round(p.start ?? 0)}_${Math.round(p.end ?? 0)}.stl`]
        : ['temperature_tower/temperature_tower.drc'];
    case 'vol_speed_tower':
      return ['volumetric_speed/SpeedTestStructure.drc'];
    case 'vfa_tower':
      return ['vfa/vfa.drc'];
    case 'retraction_tower':
      return ['retraction/retraction_tower.drc'];
    case 'input_shaping_freq':
    case 'input_shaping_damp':
      return [(p.test_model ?? 0) < 1 ? 'input_shaping/ringing_tower.drc' : 'input_shaping/fast_tower_test.drc'];
    case 'cornering':
      return [
        p.test_model === 0
          ? 'input_shaping/ringing_tower.drc'
          : p.test_model === 1
            ? 'input_shaping/fast_tower_test.drc'
            : 'cornering/SCV-V2.drc',
      ];
  }
}

let calibManifest: Promise<{ base: string; files: string[] }> | null = null;
function loadCalibManifest() {
  calibManifest ??= fetch(new URL('calib-manifest.json', document.baseURI)).then((r) => {
    if (!r.ok) throw new Error(`calib-manifest.json: HTTP ${r.status}`);
    return r.json();
  });
  calibManifest.catch(() => {
    calibManifest = null;
  });
  return calibManifest;
}

/** A calibration test is for a belt printer (some of them differ there, as on desktop). */
export function isBeltPrinter(config: string | null): boolean {
  if (!config) return false;
  const v = (JSON.parse(config) as Record<string, unknown>).belt_printer;
  return v === '1' || v === 'true' || v === true;
}

/**
 * Start one of desktop's calibration tests (its Calibration menu): its model replaces the plate
 * (desktop starts a new project with it) and the presets are changed for it as desktop does (they
 * show as modified, to save or discard). `title` names the plate, as desktop's project.
 */
export async function startCalibration(request: CalibRequest, title: string) {
  const s = get();
  if (!s.presets.state || s.importing) return;
  set({ importing: true });
  try {
    await aux.start();
    const m = await loadCalibManifest();
    const assets: { path: string; bytes: ArrayBuffer }[] = [];
    for (const path of calibFiles(request, isBeltPrinter(s.presets.config))) {
      // Desktop's belt temperature towers are embossed for some ranges only.
      if (!m.files.includes(path) && request.params.mode === 'temp_tower') {
        notify({
          kind: 'error',
          title: t('Temperature tower'),
          message: t(
            'No belt temperature tower is available for the range %1% to %2%℃. Use a range the tower models cover, for example 230 to 190.',
          )
            .replace('%1%', String(Math.round(request.params.start ?? 0)))
            .replace('%2%', String(Math.round(request.params.end ?? 0))),
        });
        return;
      }
      const r = await fetch(new URL(m.base + path, document.baseURI));
      if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
      assets.push({ path, bytes: await r.arrayBuffer() });
    }
    const r = await aux.call('presetsCalib', { request, assets });
    await refreshConfig();
    const file: SourceFile = { name: `${title}.3mf`, bytes: r.file };
    const ins = await inspect(file.name, file.bytes);
    // One step to undo: the plate before the test.
    remember();
    loadedCounts.length = 0;
    set({ files: [], objects: [], selected: [], layOnFace: false });
    addInspected(file, ins.info, meshesToGeometries(ins.meshes, ins.info.objects.length), true, true);
    set({ calibration: r.calib ? { file, params: r.calib } : null, view: 'prepare' });
    for (const n of r.notices)
      notify({
        kind: 'info',
        title:
          n.kind === 'accel'
            ? t('No accelerations provided for calibration. Use default acceleration value %1%mm/s²').replace('%1%', String(n.value))
            : t('No speeds provided for calibration. Use default optimal speed %1%mm/s').replace('%1%', String(n.value)),
      });
  } catch (e) {
    notify({ kind: 'error', ...describeError(e) });
  } finally {
    set({ importing: false });
  }
}

/** The VFA test's end speed against the filament's max volumetric speed (VFA_Test_Dlg::on_start). */
export async function checkVfaSpeed(start: number, end: number, step: number, nozzle_based_resize: boolean) {
  await aux.start();
  return aux.call('presetsCalibVfa', { start, end, step, nozzle_based_resize });
}

/** Read a model in the engine: its objects (with placement) and their meshes. Throws on failure. */
export async function inspectModel(name: string, bytes: ArrayBuffer): Promise<{ info: ModelInfo; geometries: BufferGeometry[] }> {
  await aux.start();
  const r = await inspect(name, bytes);
  return { info: r.info, geometries: meshesToGeometries(r.meshes, r.info.objects.length) };
}

/** Read a model file in the engine. One it cannot read is said to be that (not a crash to try again after). */
async function inspect(name: string, bytes: ArrayBuffer): Promise<{ info: ModelInfo; meshes: ArrayBuffer }> {
  // A 3MF is a zip archive that holds a model file (the entry names are stored as they are).
  if (
    /\.3mf$/i.test(name) &&
    !(new Uint8Array(bytes, 0, Math.min(2, bytes.byteLength)).join() === '80,75' && latin1.decode(bytes).includes('.model'))
  )
    throw new SliceError({ code: 'INVALID_INPUT', message: N_('The file does not contain any geometry data.') });
  await auxReady();
  try {
    return await aux.call('inspect', { files: [{ name, bytes }] });
  } catch (e) {
    if (e instanceof SliceError && e.code === 'INTERNAL')
      throw new SliceError({ code: 'INVALID_INPUT', message: N_('The file is corrupted, please check and try again.'), detail: e.detail });
    throw e;
  }
}

export const isModelFile = (name: string) => SUPPORTED.test(name);

const latin1 = new TextDecoder('latin1');
/**
 * A 3MF with slicer settings (OrcaSlicer, Bambu Studio or PrusaSlicer): a project, laid out on
 * that slicer's bed. Other 3MFs (CAD exports) are plain models, as desktop's is_project_file
 * (it has a config only when the archive holds one of these files). Zip entry names are stored
 * uncompressed, so the bytes are searched for them.
 */
export function is3mfProject(file: SourceFile): boolean {
  if (!/\.3mf$/i.test(file.name)) return false;
  const text = latin1.decode(file.bytes);
  return text.includes('Metadata/project_settings.config') || text.includes('Metadata/Slic3r_PE.config');
}

function addInspected(file: SourceFile, info: ModelInfo, geos: BufferGeometry[], sameStep = false, keep = false) {
  if (!sameStep) remember();
  const s = get();
  // Desktop keeps a project's positions; a plain model, like an STL, goes where there is room
  // (keeping its objects' layout, as desktop's center_instances_around_point).
  // A project added to a plate that already has objects is a plain model too (its own
  // positions would put it on top of them).
  const keepPositions = keep || (is3mfProject(file) && s.objects.length === 0);
  const isProject = keepPositions;
  // Engine indices are load order over all files, including objects deleted since.
  const firstIndex = s.files.length === 0 ? 0 : countLoaded();
  const bed = s.presets.bed;
  const taken: Rect[] = s.objects.flatMap((o) => o.instances.map((m) => footprint(o.id, m)));
  info.objects.forEach((_, k) => geometries.set(`o${nextObjectId + k}`, geos[k]!));
  // A plain 3MF's objects move together, keeping their layout.
  const group = !keepPositions && bed && /\.3mf$/i.test(file.name) ? groupShift(info, nextObjectId, bed, taken) : null;
  const added: SceneObject[] = info.objects.map((o, k) => {
    const id = `o${nextObjectId++}`;
    let instances = o.instances.map((i) => i.matrix);
    if (!keepPositions && bed && !group) {
      instances = instances.map((m) => {
        const fp = footprint(id, m);
        const [x, y] = placeFootprint(bed, taken, fp.x1 - fp.x0, fp.y1 - fp.y0);
        const placed = translateTo(id, m, x, y);
        taken.push(footprint(id, placed));
        return placed;
      });
    }
    // Each object rests on the bed by itself (desktop's ensure_on_bed).
    if (group)
      instances = instances.map((m) => {
        const out = m.slice();
        out[12]! += group.x;
        out[13]! += group.y;
        out[14]! -= footprint(id, m).zMin;
        return out;
      });
    return {
      id,
      index: firstIndex + k,
      name: o.name || file.name,
      triangles: o.triangles,
      parts: o.parts,
      modifiers: o.modifiers,
      hasConfig: o.has_config,
      instances,
      painted: o.painted,
      ...(o.support_volumes?.length ? { volumes: loadedVolumes(o.support_volumes) } : {}),
    };
  });
  loadedCounts.push(info.objects.length);
  // Loading a model ends a calibration test (desktop's load_files).
  set({
    files: [...s.files, file],
    objects: [...s.objects, ...added],
    selected: added[0] ? [added[0].id] : s.selected,
    layOnFace: false,
    calibration: null,
  });
  if (isProject && info.plates.length > 1)
    notify({
      kind: 'warning',
      title: t('Multi-plate project'),
      message: t('Only plate 1 of {count} can be sliced for now.', { count: info.plates.length }),
    });
  touchPlate();
}

/** The shift that puts all of a file's instances, together, where there is room. */
function groupShift(info: ModelInfo, firstId: number, bed: NonNullable<ReturnType<typeof get>['presets']['bed']>, taken: Rect[]) {
  const fps = info.objects.flatMap((o, k) => o.instances.map((i) => footprint(`o${firstId + k}`, i.matrix)));
  const x0 = Math.min(...fps.map((f) => f.x0)),
    x1 = Math.max(...fps.map((f) => f.x1));
  const y0 = Math.min(...fps.map((f) => f.y0)),
    y1 = Math.max(...fps.map((f) => f.y1));
  const [x, y] = placeFootprint(bed, taken, x1 - x0, y1 - y0);
  const shift = { x: x - (x0 + x1) / 2, y: y - (y0 + y1) / 2 };
  for (const f of fps) taken.push({ x0: f.x0 + shift.x, x1: f.x1 + shift.x, y0: f.y0 + shift.y, y1: f.y1 + shift.y });
  return shift;
}

const countLoaded = () => loadedCounts.reduce((a, b) => a + b, 0);

/**
 * What the engine is given: the files that still have an object on the plate, and the objects
 * with their engine index among those files alone (a deleted object's file stays for undo,
 * and is not loaded and read again on every slice).
 */
export function liveFiles(s: Pick<ReturnType<typeof get>, 'files' | 'objects'> = get()): {
  files: SourceFile[];
  objects: SceneObject[];
  counts: number[];
} {
  const used = new Set(s.objects.map((o) => o.index));
  const files: SourceFile[] = [];
  const counts: number[] = [];
  const moved = new Map<number, number>();
  let first = 0,
    dropped = 0;
  loadedCounts.forEach((n, i) => {
    let live = false;
    for (let k = first; k < first + n; k++) if (used.has(k)) live = true;
    if (live) {
      files.push(s.files[i]!);
      counts.push(n);
      for (let k = first; k < first + n; k++) moved.set(k, k - dropped);
    } else dropped += n;
    first += n;
  });
  // The instance arrays stay the same ones (arrangeAll tells instances apart by them).
  return { files, counts, objects: dropped ? s.objects.map((o) => ({ ...o, index: moved.get(o.index) ?? o.index })) : s.objects };
}

const _v = new Vector3();
/** Axis-aligned XY footprint and min Z of an object instance under matrix m. */
export function footprint(id: string, m: Mat4): Rect & { zMin: number; zMax: number } {
  const g = geometries.get(id)!;
  const pos = g.getAttribute('position') as BufferAttribute;
  const mat = new Matrix4().fromArray(m);
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity,
    zMin = Infinity,
    zMax = -Infinity;
  // Large meshes: sample (the footprint only steers placement; slicing uses the exact mesh).
  const step = Math.max(1, Math.floor(pos.count / 200000));
  for (let i = 0; i < pos.count; i += step) {
    _v.fromBufferAttribute(pos, i).applyMatrix4(mat);
    if (_v.x < x0) x0 = _v.x;
    if (_v.x > x1) x1 = _v.x;
    if (_v.y < y0) y0 = _v.y;
    if (_v.y > y1) y1 = _v.y;
    if (_v.z < zMin) zMin = _v.z;
    if (_v.z > zMax) zMax = _v.z;
  }
  return { x0, y0, x1, y1, zMin, zMax };
}

/** Move an instance so its footprint is centred on (x, y) and it rests on the bed. */
export function translateTo(id: string, m: Mat4, x: number, y: number): Mat4 {
  const fp = footprint(id, m);
  const out = m.slice();
  out[12]! += x - (fp.x0 + fp.x1) / 2;
  out[13]! += y - (fp.y0 + fp.y1) / 2;
  out[14]! -= fp.zMin;
  return out;
}

/** Place an instance. `key`: see remember (changes with the same key in a row are one undo step). */
export function setInstance(id: string, k: number, m: Mat4, key = '') {
  remember(key);
  set((s) => ({ objects: s.objects.map((o) => (o.id === id ? { ...o, instances: o.instances.map((x, i) => (i === k ? m : x)) } : o)) }));
  touchPlate();
}

export function deleteObject(id: string) {
  deleteObjects([id]);
}

export function deleteObjects(ids: string[]) {
  if (!ids.length) return;
  remember();
  const gone = new Set(ids);
  const s = get();
  // The files of objects that are gone stay with the undo steps alone (which drop them in time).
  const live = liveFiles({ files: s.files, objects: s.objects.filter((o) => !gone.has(o.id)) });
  loadedCounts.splice(0, loadedCounts.length, ...live.counts);
  set({ files: live.files, objects: live.objects, selected: s.selected.filter((x) => !gone.has(x)), layOnFace: false });
  touchPlate();
}

/** Remove everything (desktop's Delete all). The meshes stay while undo can bring them back. */
export function clearPlate() {
  if (!get().objects.length) return;
  remember();
  loadedCounts.length = 0;
  set({ files: [], objects: [], selected: [], layOnFace: false });
  touchPlate();
}

// Free the meshes no state (the plate, undo, redo) refers to any more.
onCollect((live) => {
  const kept = new Set<BufferGeometry>();
  for (const [id, g] of geometries) if (live.has(id)) kept.add(g);
  for (const [id, g] of [...geometries]) {
    if (live.has(id)) continue;
    geometries.delete(id);
    if (!kept.has(g)) g.dispose();
  }
});

/** Rotate the selected object about Z around its own centre and drop it to the bed. */
export function rotateZ(id: string, degrees: number) {
  const o = get().objects.find((x) => x.id === id);
  if (!o) return;
  const m = o.instances[0]!;
  const fp = footprint(id, m);
  const cx = (fp.x0 + fp.x1) / 2,
    cy = (fp.y0 + fp.y1) / 2;
  const r = new Matrix4().makeRotationZ((degrees * Math.PI) / 180);
  const t = new Matrix4()
    .makeTranslation(cx, cy, 0)
    .multiply(r)
    .multiply(new Matrix4().makeTranslation(-cx, -cy, 0));
  const next = t.multiply(new Matrix4().fromArray(m)).toArray();
  setInstance(id, 0, translateTo(id, next, cx, cy));
}

/**
 * Desktop's Arrange (A): its own arranger (libslic3r's Arrange, libnest2d) in the engine, with
 * the arrange dialog's defaults. Instances changed meanwhile keep their place.
 */
export async function arrangeAll() {
  const s = get();
  if (!s.objects.length || !s.presets.config || s.arranging) return;
  const live = liveFiles(s);
  const { layout, owners } = engineLayoutWithOwners(live.objects);
  set({ arranging: true });
  try {
    await auxReady();
    const r = await aux.call('arrange', {
      files: live.files.map((f) => ({ name: f.name, bytes: f.bytes })),
      layout: { objects: layout },
      config: s.presets.config,
    });
    // The new matrix per instance (by its old matrix, which is unique to it).
    const placed = new Map<Mat4, Mat4>();
    let offPlate = 0;
    r.objects.forEach((o, i) =>
      o.instances.forEach((inst, k) => {
        if (inst.bed < 0) return;
        if (inst.bed > 0) offPlate++;
        placed.set(owners[i]![k]!.m, inst.matrix);
      }),
    );
    const now = get().objects;
    if (!now.some((o) => o.instances.some((m) => placed.has(m)))) return;
    remember();
    set({
      objects: now.map((o) =>
        o.instances.some((m) => placed.has(m)) ? { ...o, instances: o.instances.map((m) => placed.get(m) ?? m) } : o,
      ),
    });
    touchPlate();
    if (offPlate)
      notify({
        kind: 'warning',
        title: t('Arrange'),
        message: t('Not everything fits on the plate. Objects off the plate are not sliced.'),
      });
    const unplaced = r.objects.flatMap((o, i) => o.instances.flatMap((inst, k) => (inst.bed < 0 ? [owners[i]![k]!.id] : [])));
    if (unplaced.length) {
      const names = [...new Set(unplaced.map((id) => now.find((o) => o.id === id)?.name ?? ''))].join('\n');
      notify({
        kind: 'warning',
        title: t('Arrange'),
        message: t("Arrangement ignored the following objects which can't fit into a single bed:\n%s").replace('%s', names),
      });
    }
  } catch (e) {
    notify({ kind: 'error', ...describeError(e), title: t('Arrange') });
  } finally {
    set({ arranging: false });
  }
}

/** Whether an instance is inside the print volume: on the bed, and no taller than the printer prints. */
export function isOnBed(id: string, m: Mat4): boolean {
  const bed = get().presets.bed;
  if (!bed) return true;
  const fp = footprint(id, m);
  return (
    fp.x0 >= bed.min[0] - 0.01 && fp.y0 >= bed.min[1] - 0.01 && fp.x1 <= bed.max[0] + 0.01 && fp.y1 <= bed.max[1] + 0.01 && !tooTall(fp)
  );
}
const tooTall = (fp: { zMax: number }) => fp.zMax > (get().presets.bed?.height ?? Infinity) + 0.01;
/** Whether an object on the plate is taller than the printer prints. */
export const anyTooTall = () => get().objects.some((o) => geometries.has(o.id) && o.instances.some((m) => tooTall(footprint(o.id, m))));

// ── slicing ──────────────────────────────────────────────────────────────────────────────
let abort: AbortController | null = null;

export async function slice() {
  const s = get();
  if (!backend || s.slice.state === 'running') return;
  if (!s.objects.length) {
    notify({ kind: 'info', title: t('Nothing to slice'), message: t('Import a model first.') });
    return;
  }
  if (!s.presets.config) {
    notify({
      kind: 'error',
      title: t('No printer selected'),
      message: s.presets.message ? tr(s.presets.message) : t('Presets are still loading.'),
    });
    return;
  }
  abort = new AbortController();
  const version = s.plateVersion;
  const live = liveFiles(s);
  // Named after the first object that is sliced (one off the bed is not).
  const named = s.objects.find((o) => o.instances.some((m) => isOnBed(o.id, m))) ?? s.objects[0];
  const startView = s.view;
  dismissAbout('slice');
  set({ slice: { state: 'running', progress: { percent: 0, message: t('Starting engine') }, startedAt: performance.now() } });
  const dbg = debugMode() ? Number(new URLSearchParams(location.search).get('reserveHeapMB') ?? 0) : 0;
  try {
    const r = await backend.slice(
      {
        files: live.files.map((f) => ({ name: f.name, bytes: f.bytes })),
        layout: { objects: engineLayout(live.objects) },
        config: s.presets.config,
        plate: 1,
        calib: s.calibration && live.files.includes(s.calibration.file) ? s.calibration.params : null,
        thumbnails: gcodeThumbnails(s),
        ...(dbg ? { debug: { reserveHeapMB: dbg } } : {}),
      },
      {
        signal: abort.signal,
        onProgress: (p) => set((st) => (st.slice.state === 'running' ? { slice: { ...st.slice, progress: p } } : {})),
      },
    );
    gcodeBlob = r.gcode;
    set({
      slice: { state: 'done', stats: r.stats, gcodeBytes: r.gcode.size, ms: r.ms.total, heapBytes: r.heapBytes },
      slicedVersion: version,
      gcodeFromFile: false,
      gcodePrinter: s.presets.state?.printer ?? null,
      gcodeName: named?.name ?? null,
      // The result is shown, unless the user went on to something else meanwhile (the settings, say).
      ...(get().view === startView ? { view: 'preview' as const } : {}),
    });
    for (const w of r.stats.warnings ?? []) notify({ kind: 'warning', title: t('Slicing warning'), message: tr(w), about: 'slice' });
    void loadPreview(async () => {
      if (!r.preview) throw new Error('');
      return r.preview;
    });
  } catch (e) {
    const err = e instanceof SliceError ? e : new SliceError({ code: 'INTERNAL', message: String((e as Error)?.message ?? e) });
    set({ slice: err.code === 'CANCELLED' ? { state: 'idle' } : { state: 'error', code: err.code } });
    if (err.code !== 'CANCELLED')
      notify({
        kind: 'error',
        ...describeError(err),
        ...(err.code === 'EMPTY_PLATE' && anyTooTall()
          ? { message: t('An object is too tall for the printer. Make it smaller or turn it.') }
          : {}),
        about: 'slice',
      });
  } finally {
    abort = null;
  }
}

/** The G-code thumbnails the printer asks for: the objects on the plate, as desktop renders them. */
function gcodeThumbnails(s: ReturnType<typeof get>) {
  try {
    const cfg = JSON.parse(s.presets.config!) as { thumbnails?: unknown; filament_colour?: unknown };
    const sizes = typeof cfg.thumbnails === 'string' ? thumbnailSizes(cfg.thumbnails) : [];
    const colour = Array.isArray(cfg.filament_colour) ? String(cfg.filament_colour[0] ?? '') : undefined;
    const objects = s.objects.flatMap((o) =>
      o.instances.filter((m) => isOnBed(o.id, m)).map((matrix) => ({ geometry: geometries.get(o.id)!, matrix })),
    );
    return renderGcodeThumbnails(objects, sizes, colour);
  } catch {
    return []; // No thumbnails rather than no G-code.
  }
}

export function cancelSlice() {
  abort?.abort();
}

/** Counts the previews asked for: one that another has replaced by the time it is read is dropped. */
let previewTurn = 0;
/** Show the moves the engine gives (from a slice, or read from a G-code file) in the preview. */
export async function loadPreview(from: () => Promise<EnginePreview>) {
  const turn = ++previewTurn;
  set({ preview: { ready: false, parsing: true, layers: 0, segments: 0 } });
  parsedGcode = null;
  listeners.forEach((f) => f());
  try {
    const p = await from();
    if (turn !== previewTurn) return;
    const { result, ms } = await previewInWorker(p);
    if (turn !== previewTurn) return;
    parsedGcode = result;
    set({ preview: { ready: true, parsing: false, parseMs: ms, layers: result.layerCount, segments: result.segCount } });
    listeners.forEach((f) => f());
  } catch (e) {
    if (turn !== previewTurn) return;
    set({ preview: { ready: false, parsing: false, layers: 0, segments: 0 } });
    notify({ kind: 'error', title: t('Preview failed'), message: String((e as Error).message) });
  }
}

let openTurn = 0;
/** Open a G-code file for preview only (no slicing). Pass the result of readNow(). */
export async function openGcode(file: { name: string; bytes: Promise<ArrayBuffer> }) {
  // A running slice would replace the file's preview when it ends.
  if (get().slice.state === 'running') return;
  // Of files opened one right after the other, the last one shows.
  const turn = ++openTurn;
  let blob: Blob;
  try {
    blob = new Blob([await file.bytes], { type: 'text/x.gcode' });
  } catch (e) {
    unreadable(file.name, e);
    return;
  }
  if (get().slice.state === 'running') return;
  // Not G-code (empty, or some other file): nothing to show or to send to a printer.
  if (!(await hasMoves(blob))) {
    notify({ kind: 'warning', title: t('Could not open {name}', { name: file.name }), message: t('The file contains no G-code.') });
    return;
  }
  if (turn !== openTurn || get().slice.state === 'running') return;
  gcodeBlob = blob;
  set(() => ({
    view: 'preview',
    gcodeFromFile: true,
    gcodePrinter: null,
    gcodeName: file.name,
    slice: {
      state: 'done',
      stats: { print_time_s: 0, filament_mm: 0, filament_cm3: 0, filament_g: 0, cost: 0, warnings: [] },
      gcodeBytes: blob.size,
      ms: 0,
      heapBytes: 0,
    },
  }));
  const printer = await gcodePrinterOf(blob);
  if (gcodeBlob === blob) set({ gcodePrinter: printer });
  await loadPreview(async () => {
    if (!backend) throw new Error('');
    const p = await backend.gcodePreview(await blob.arrayBuffer());
    // The file's print time and filament, as desktop shows them for an opened file.
    const m = p.meta;
    if (gcodeBlob === blob)
      set((st) =>
        st.slice.state === 'done'
          ? {
              slice: {
                ...st.slice,
                stats: {
                  ...st.slice.stats,
                  print_time_s: m.time_s,
                  filament_mm: m.filament_m * 1000,
                  filament_g: m.filament_g,
                  cost: m.cost,
                },
              },
            }
          : {},
      );
    return p;
  });
}

/** Whether the file has a move command at all (a G0–G3 line; binary data and other text have none). */
async function hasMoves(blob: Blob): Promise<boolean> {
  const SPAN = 4 << 20;
  for (let at = 0; at < blob.size; at += SPAN)
    if (/^[ \t]*(?:N\d+[ \t]*)?G0*[0-3](?:[ \t;]|$)/im.test(await blob.slice(at, at + SPAN + 64).text())) return true;
  return false;
}

/** The printer preset a G-code file was sliced with, when it says (see {@link printerSettingsId}). */
export async function gcodePrinterOf(blob: Blob): Promise<string | null> {
  // The settings are at the end, or for Bambu printers at the start.
  const SPAN = 2 << 20;
  for (const part of [blob.slice(Math.max(0, blob.size - SPAN)), blob.slice(0, SPAN)]) {
    const id = printerSettingsId(await part.text());
    if (id) return id;
  }
  return null;
}

/**
 * The file name of the G-code shown: an opened file keeps its own; a slice has the name the
 * printer's "Filename format" gives it, as on desktop (or else its first object's and its printer's).
 */
export function gcodeFileName(): string {
  const s = get();
  if (s.gcodeFromFile && s.gcodeName) return s.gcodeName;
  const named = s.slice.state === 'done' ? s.slice.stats.file_name?.split(/[\\/]/).pop() : undefined;
  if (named) return named;
  const clean = (x: string) => x.replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '');
  const base = clean((s.gcodeName ?? s.objects[0]?.name ?? 'plate').replace(/\.(stl|3mf|obj|amf|step|stp)$/i, '')) || 'plate';
  const printer = clean(s.gcodePrinter ?? s.presets.state?.printer ?? '');
  return `${base}${printer ? `_${printer}` : ''}.gcode`;
}

/**
 * The plate as a project 3MF in OrcaSlicer's format: the objects as placed, with their support
 * blockers, painted supports and own settings, and the printer, filament and print settings in
 * use, so OrcaSlicer and this app open it as it is. Named after its first object.
 */
export async function plate3mf(): Promise<{ name: string; bytes: ArrayBuffer } | null> {
  const s = get();
  if (!s.objects.length || !s.presets.config) return null;
  const live = liveFiles(s);
  await auxReady();
  const bytes = await aux.call('export3mf', {
    files: live.files.map((f) => ({ name: f.name, bytes: f.bytes })),
    layout: { objects: engineLayout(live.objects) },
    config: s.presets.config,
  });
  const base = (s.objects[0]!.name || 'plate').replace(/\.[^./]+$/, '').replace(/[/\\\0]/g, '_');
  return { name: `${base}.3mf`, bytes };
}

/** Download the plate as a project 3MF (Ctrl+S, as desktop's Save Project). */
export async function download3mf() {
  try {
    const r = await plate3mf();
    if (!r) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([r.bytes], { type: 'model/3mf' }));
    a.download = r.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  } catch (e) {
    notify({ kind: 'error', ...describeError(e), title: t('Could not save the plate') });
  }
}

/**
 * A project's settings, as OrcaSlicer opens a project: the printer, filament and print settings
 * it names selected, what it changes kept as unsaved edits (asking first when there are unsaved
 * edits already). The G-code it changes is pointed out, to be checked before printing.
 */
export async function loadProjectSettings(name: string, config: Record<string, string>) {
  const st = get().presets.state;
  if (!st || !Object.keys(config).length) return;
  const edited = [st.dirty?.printer && st.printer, st.dirty?.filament && st.filaments[0], st.dirty?.print && st.process].filter(
    (n): n is string => !!n,
  );
  if (edited.length && !(await ask(t('Discard unsaved changes to {names}?', { names: edited.join(', ') }), { confirm: t('Discard') })))
    return;
  set((s) => ({ presets: { ...s.presets, status: 'loading' } }));
  try {
    await auxReady();
    const r = await aux.call('presetsLoadProject', { name, config });
    // A printer the project names that isn't here comes from its settings: listed too.
    await refreshPrinterList();
    const cfg = await aux.call('presetsConfig', {});
    const bed = keepBed(get().presets.bed, bedFromConfig(JSON.parse(cfg)));
    set((s) => ({ presets: { ...s.presets, status: 'ready', state: r.state, config: cfg, bed, message: undefined } }));
    save({ printer: r.state.printer, process: r.state.process, filament: r.state.filaments[0] });
    touchPlate();
    if (r.gcode.length) {
      const schema = await loadSchema().catch(() => null);
      notify({
        kind: 'warning',
        title: tr(N_('The 3MF has the following modified G-code in filament or printer presets:')),
        message: `${r.gcode.map((k) => tr(schema?.options[k]?.label || k)).join(', ')}. ${tr(N_('Please confirm that all modified G-code is safe to prevent any damage to the machine!'))}`,
      });
    }
  } catch (e) {
    set((s) => ({ presets: { ...s.presets, status: 'ready' } }));
    notify({ kind: 'error', ...describeError(e), title: t('Could not load the project’s settings') });
  }
}

export function downloadGcode() {
  if (!gcodeBlob) return;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(gcodeBlob);
  a.download = gcodeFileName();
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}
