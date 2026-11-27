// Application state (zustand). Heavy data (meshes, parsed G-code) lives outside the store in
// registries keyed by id, so state updates stay cheap.
// SPDX-License-Identifier: AGPL-3.0-or-later
import { create } from 'zustand';
import type { CalibParams, PresetEntry, PresetState } from '../engine/protocol';
import type { Mat4, PaintData, Progress, SliceErrorCode, SliceStats, SupportVolume } from '../engine/types';
import type { Language } from '../i18n/i18n';
import type { LibraryEntry } from '../library/store';
import type { Bed } from '../model/bed';
import { DEFAULT_LIBRARY, type Library } from '../presets/library';
import type { PrinterConfig, PrinterStatus } from '../printers/connectors';
import { loadPrefs, type Prefs } from './prefs';

export const BED_KEY = 'dolphin-slicer.bed.v1';
function lastBed(): Bed | null {
  try {
    return JSON.parse(localStorage.getItem(BED_KEY) ?? 'null');
  } catch {
    return null;
  }
}

export interface SourceFile {
  name: string;
  bytes: ArrayBuffer;
}

/**
 * An axis to show on the selected object: a line along it (move, scale) or a ring about it
 * (rotate); along the world's axes, the object's own, or those its rotation angles turn about.
 */
/**
 * `all`: the change applies to all three axes (uniform scale); `axis` is the one in focus.
 * `reverse`: towards the negative direction (a turn by a negative angle).
 */
export interface AxisHint {
  kind: 'move' | 'rotate' | 'scale' | 'mirror';
  axis: 0 | 1 | 2;
  frame: 'world' | 'object' | 'euler';
  all?: boolean;
  reverse?: boolean;
}

/** Desktop's support painting tool and its settings (GLGizmoFdmSupports). */
export interface PaintSettings {
  tool: 'circle' | 'sphere' | 'fill' | 'gap_fill';
  /** The brush's radius, mm. */
  radius: number;
  /** The brush moves only up and down, or only sideways, on the screen. */
  vertical: boolean;
  horizontal: boolean;
  /** Smart fill: the largest angle between neighboring faces filled together, °. */
  smartFillAngle: number;
  /** Gap fill: patches smaller than this, mm², take the state around them. */
  gapArea: number;
  /** Paint only on the highlighted overhangs. */
  overhangsOnly: boolean;
  /** Overhangs this steep are highlighted, ° (0: none). */
  highlightAngle: number;
}

export interface SceneObject {
  id: string;
  /** Index in load order (objects of file 0, then file 1, …), what the engine calls it. */
  index: number;
  name: string;
  triangles: number;
  parts: number;
  modifiers: number;
  hasConfig: boolean;
  instances: Mat4[];
  /** Painted support enforcers and blockers (absent: as the file has them). */
  supports?: PaintData;
  /** Support enforcers or blockers are painted. */
  painted: boolean;
  /** Support blockers and enforcers added in the app (desktop's Add support blocker / enforcer). */
  volumes?: SceneVolume[];
}

/**
 * A support blocker or enforcer of an object; `id` is unique within the object. A generic shape,
 * or one the model came with (a project's): `shape` 'mesh', `size` its mesh's extent, `loaded`
 * its number in the object, `mesh` the key of its mesh (view/supportShapes.ts), `name` the file's.
 */
export interface SceneVolume extends Omit<SupportVolume, 'shape'> {
  id: string;
  shape: SupportVolume['shape'] | 'mesh';
  loaded?: number;
  mesh?: string;
  name?: string;
}

export interface Notice {
  id: number;
  kind: 'error' | 'warning' | 'info';
  title: string;
  message?: string;
  detail?: string;
  code?: SliceErrorCode | string;
  /** A button on the notice (it closes the notice too). */
  action?: { label: string; run: () => void };
  /** What it is about: notices about a slice go when the next one starts. */
  about?: 'slice';
}

export interface DriveUi {
  /** The signed-in Google account, if Drive sync is on. */
  email: string | null;
  /** Synced with the storage folder of the server that hosts the app (instead of Drive). */
  server?: boolean;
  status: 'off' | 'signing-in' | 'idle' | 'syncing' | 'expired' | 'error';
  lastSync?: number;
  message?: string;
  /** Changes from Drive waiting for unsaved edits to be saved or discarded. */
  waiting?: number;
}

export interface ModelsUi {
  /** Not deleted, newest first. */
  entries: LibraryEntry[];
  loaded: boolean;
  /** Models being added (file names). */
  adding: string[];
  /** Models being downloaded to open (ids). */
  opening: string[];
}

export interface PrintersUi {
  list: PrinterConfig[];
  /** The printer G-code was last sent to (preselected next time). */
  last?: string;
  /** Last known status, or why it couldn't be read. */
  status: Record<string, PrinterStatus | { error: string }>;
  /** The printer G-code is being sent to. */
  sending: string | null;
}

export type SliceStatus =
  | { state: 'idle' }
  | { state: 'running'; progress: Progress; startedAt: number }
  | { state: 'done'; stats: SliceStats; gcodeBytes: number; ms: number; heapBytes: number }
  | { state: 'error'; code: SliceErrorCode | string };

export interface PresetsUi {
  status: 'loading' | 'ready' | 'error';
  loadedVendors: string[];
  printers: PresetEntry[];
  state: PresetState | null;
  config: string | null;
  bed: Bed | null;
  message?: string;
}

export interface AppState {
  view: 'prepare' | 'preview' | 'settings' | 'library';
  /** Preset type shown in the Settings tab. */
  settingsType: 'print' | 'filament' | 'printer';
  /** A setting for the Settings tab to show (picked in the quick search); `n` tells picks apart. */
  settingsFocus: { type: 'print' | 'filament' | 'printer'; key: string; n: number } | null;
  /** The calibration test whose dialog is open (Calibration.tsx's kinds). */
  calibrationDialog: string | null;
  files: SourceFile[];
  objects: SceneObject[];
  /** Selected objects (ids); the object panel shows when there is one. */
  selected: string[];
  /** A support blocker or enforcer of the selected object, selected in it (its panel shows). */
  selectedVolume: { object: string; volume: string } | null;
  /** Lay on face (desktop's flatten gizmo) is on for the one selected object. */
  layOnFace: boolean;
  /** Support painting (desktop's paint-on supports) on this object, and its tool's settings. */
  painting: string | null;
  paint: PaintSettings;
  /** Undo and redo are possible (the history is in plate.ts). */
  history: { undo: boolean; redo: boolean };
  /** Something is on the clipboard to paste. */
  canPaste: boolean;
  /** Auto orient is working (in the geometry worker). */
  orienting: boolean;
  /** Arrange is working (in the engine). */
  arranging: boolean;
  /** The plate's context menu, open at a point on the page (for an object, or the plate). */
  menu: { id: string | null; x: number; y: number } | null;
  /** The axis the object panel's focused field acts on, shown on the selected object. */
  axisHint: AxisHint | null;
  importing: boolean;
  presets: PresetsUi;
  slice: SliceStatus;
  /** Bumped whenever the plate or settings change after a slice (the G-code is stale). */
  plateVersion: number;
  slicedVersion: number;
  /** The preview shows a G-code file the user opened, not a slice of this plate. */
  gcodeFromFile: boolean;
  /** The printer profile the G-code is for: the one sliced with, or named in an opened file (null: unknown). */
  gcodePrinter: string | null;
  /** What the G-code is named after: the opened file, or the first object sliced. */
  gcodeName: string | null;
  engine: { flavor: 'st' | 'mt'; reason: string | null; info: string | null };
  notices: Notice[];
  preview: { ready: boolean; parsing: boolean; parseMs?: number; layers: number; segments: number };
  drive: DriveUi;
  /** Printers and filaments the user added (what the pickers show). */
  library: Library;
  /** The model library. */
  models: ModelsUi;
  printers: PrintersUi;
  /** The printer/filament wizard, open at a page. */
  wizard: null | 'printers' | 'filaments' | 'import';
  /** The wizard opened on Create Printer, to add a nozzle (variant) to this printer model. */
  createVariant: string | null;
  /**
   * The calibration test the plate is (desktop's Calibration menu): its file, and what slices of
   * it give the engine. Loading another model ends it, as on desktop.
   */
  calibration: { file: SourceFile; params: CalibParams } | null;
  prefs: Prefs;
  /** The language the UI is shown in (loaded). */
  lang: Language;
}

export const useApp = create<AppState>()(() => ({
  view: 'prepare',
  settingsType: 'print',
  settingsFocus: null,
  calibrationDialog: null,
  files: [],
  objects: [],
  selected: [],
  selectedVolume: null,
  layOnFace: false,
  painting: null,
  paint: {
    tool: 'circle',
    radius: 1,
    vertical: false,
    horizontal: false,
    smartFillAngle: 30,
    gapArea: 0,
    overhangsOnly: false,
    highlightAngle: 0,
  },
  history: { undo: false, redo: false },
  canPaste: false,
  orienting: false,
  arranging: false,
  menu: null,
  axisHint: null,
  importing: false,
  // The last bed is drawn right away; the presets confirm or replace it once loaded.
  presets: { status: 'loading', loadedVendors: [], printers: [], state: null, config: null, bed: lastBed() },
  slice: { state: 'idle' },
  plateVersion: 0,
  slicedVersion: -1,
  gcodeFromFile: false,
  gcodePrinter: null,
  gcodeName: null,
  engine: { flavor: 'st', reason: null, info: null },
  notices: [],
  preview: { ready: false, parsing: false, layers: 0, segments: 0 },
  drive: { email: null, status: 'off' },
  library: DEFAULT_LIBRARY,
  models: { entries: [], loaded: false, adding: [], opening: [] },
  printers: { list: [], status: {}, sending: null },
  wizard: null,
  createVariant: null,
  calibration: null,
  prefs: loadPrefs(),
  lang: 'en',
}));

export const set = useApp.setState;
export const get = useApp.getState;
// Test/benchmark hook (also without WebGL; the viewport adds itself to it).
(globalThis as unknown as { __orca?: object }).__orca = { store: useApp };

let noticeId = 1;
export function notify(n: Omit<Notice, 'id'>) {
  const id = noticeId++;
  // Said again: the earlier one goes, so the same notice never stacks.
  const same = (o: Notice) => o.kind === n.kind && o.title === n.title && o.message === n.message;
  set((s) => ({ notices: [...s.notices.filter((o) => !same(o)).slice(-4), { ...n, id }] }));
  return id;
}
/** Drop the notices about something (see Notice.about). */
export function dismissAbout(about: NonNullable<Notice['about']>) {
  set((s) => (s.notices.some((n) => n.about === about) ? { notices: s.notices.filter((n) => n.about !== about) } : {}));
}
export function dismiss(id: number) {
  set((s) => ({ notices: s.notices.filter((n) => n.id !== id) }));
}

/** True when the current G-code was sliced from an earlier state of the plate. */
export const isStale = (s: AppState) => !s.gcodeFromFile && s.slice.state === 'done' && s.plateVersion !== s.slicedVersion;

/** Mark the plate as changed (geometry, layout or settings). */
export function touchPlate() {
  set((s) => ({ plateVersion: s.plateVersion + 1 }));
}
