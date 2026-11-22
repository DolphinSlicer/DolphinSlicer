// Messages between the main thread and engine.worker.ts.
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { PreviewMeta } from '../gcode/preview';
import type { EngineInfo, Layout, Mat4, ModelFile, PaintData, Progress, SliceErrorData, SliceJob, SliceStats } from './types';

export interface ObjectInfo {
  name: string;
  parts: number;
  modifiers: number;
  triangles: number;
  has_config: boolean;
  /** Support enforcers or blockers painted (a desktop project's). */
  painted: boolean;
  bbox: { min: [number, number, number]; max: [number, number, number] };
  instances: { matrix: number[]; printable: boolean }[];
}

export interface ModelInfo {
  objects: ObjectInfo[];
  plates: { index: number; name: string }[];
  bbl_3mf: boolean;
}

export interface MeshData {
  positions: Float32Array;
  indices: Uint32Array;
}

export interface PresetEntry {
  name: string;
  alias: string;
  system: boolean;
  user: boolean;
  inherits: string;
  vendor: string;
  model?: string;
  variant?: string;
  filament_type?: string;
  filament_vendor?: string;
  filament_id?: string;
  /** Filament presets: the color desktop shows next to the name (#RRGGBB, or empty). */
  default_filament_colour?: string;
  /** Print and filament presets: false for the selected one when it doesn't fit the printer
   *  (presetsAll: whether each one fits). */
  compatible?: boolean;
}

export interface PresetState {
  printer: string;
  process: string;
  filaments: string[];
  processes: PresetEntry[];
  filament_presets: PresetEntry[];
  /** Presets with unsaved edits; selecting another preset of that type discards them. */
  dirty: Record<PresetType, boolean>;
  /** The printer's variants (nozzles) of its model, and its own; picking one switches the printer. */
  printer_variants: { variants: string[]; variant: string };
  /** The plate types it offers (curr_bed_type values); none when it has a single bed type. */
  bed_types: string[];
  /** The plate type sliced with. */
  bed_type: string;
}

export interface PresetSelection {
  printer?: string;
  /** The printer preset of the same model with this variant (nozzle). */
  variant?: string;
  /** A plate type (curr_bed_type value) the printer offers. */
  bed_type?: string;
  process?: string;
  filaments?: string[];
  /** Use the printer's default process/filament unless given (first selection of a printer). */
  defaults?: boolean;
}

export type PresetType = 'print' | 'filament' | 'printer';

/** The edited preset of one type (orca_presets_values). Vector options are arrays of element
 *  strings; scalars are strings. */
export interface PresetValues {
  type: PresetType;
  name: string;
  system: boolean;
  user: boolean;
  inherits: string;
  /** A root: a system preset, or a user preset with no parent (desktop's custom root preset). */
  base: boolean;
  /** User presets that inherit from this one. */
  children: string[];
  /** Presets made for this custom printer alone, deleted along with it. */
  attached: { filament: number; print: number };
  file: string;
  dirty: string[];
  from_system: string[];
  variant_index: number;
  /** For each of the printer's nozzles, its index in the settings that have one value per nozzle kind. */
  extruders: number[];
  /** The printer's two nozzles go by their side (Bambu Lab's left and right). */
  sides: boolean;
  variant_keys: string[];
  values: Record<string, string | string[]>;
  /** Which settings apply, from the desktop's own toggle rules. */
  states: OptionStates;
}

export interface OptionStates {
  /** Greyed out: key → reason. */
  disabled: Record<string, string>;
  /** Not shown: key → reason. */
  hidden: Record<string, string>;
  /** Renamed for the current values (e.g. brim width → brim ear radius). */
  labels: Record<string, string>;
  /** Choices offered for an enum option. */
  enums: Record<string, string[]>;
}

/** User preset files (desktop format) by path relative to /orca/user/default. */
export type UserFiles = Record<string, string>;

/** A vendor bundle as served from public/profiles/<hash>/<Vendor>.json. */
export interface VendorBundle {
  id: string;
  files: Record<string, string>;
}

/** Desktop's Create Printer dialog (engine orca_presets_create_printer). */
export interface CreatePrinterSpec {
  /** printer_model, e.g. "Acme Cube"; the printer is named "<model> <nozzle> nozzle". */
  model: string;
  nozzle: string;
  /** The printer whose settings the new one starts from. */
  template: string;
  /** Started from a template (not the current printer): process copies are adapted to the nozzle. */
  from_template: boolean;
  /** Bed corners ("0x0,200x0,…") and height, or the bed of an existing printer. */
  area?: string;
  height?: number;
  bed_from?: string;
  /** A new nozzle for the user's own printer: a child of it (its root), which follows its changes. */
  link?: boolean;
  processes: string[];
  filaments: string[];
  /** The user's presets the new printer is added to (a variant shares its model's), not copied. */
  share?: string[];
  overwrite?: boolean;
}

/** A filament preset as desktop's Create Filament dialog lists it (engine orca_presets_filament_list). */
export interface FilamentSource {
  name: string;
  alias: string;
  filament_id: string;
  user: boolean;
  visible: boolean;
  inherits: string;
  /** Its own filament_type, or its parent's. */
  type: string;
  /** compatible_printers; empty = any printer. */
  printers: string[];
}

/** Desktop's Create Filament (engine orca_presets_create_filament). */
export interface CreateFilamentSpec {
  /** "<vendor> <type> <serial>"; the presets are named "<name> @<printer>". */
  name: string;
  vendor: string;
  type: string;
  /** One copy per printer, of the given preset. */
  items: { printer: string; preset: string }[];
  overwrite?: boolean;
}

/** Desktop's calibration tests (Calib_Params); `mode` names the test. */
export interface CalibParams {
  mode:
    | 'pa_line'
    | 'pa_pattern'
    | 'pa_tower'
    | 'flow_rate'
    | 'temp_tower'
    | 'vol_speed_tower'
    | 'vfa_tower'
    | 'retraction_tower'
    | 'input_shaping_freq'
    | 'input_shaping_damp'
    | 'cornering';
  start?: number;
  end?: number;
  step?: number;
  print_numbers?: boolean;
  freqStartX?: number;
  freqEndX?: number;
  freqStartY?: number;
  freqEndY?: number;
  test_model?: number;
  shaper_type?: string;
  accelerations?: number[];
  speeds?: number[];
  vfa_layer_height?: number;
  nozzle_based_resize?: boolean;
}

/** A calibration test to start (engine orca_presets_calib). `flow`: the flow ratio test's kind. */
export interface CalibRequest {
  params: CalibParams;
  flow?: { linear: boolean; pass: 1 | 2; pattern: 'archimedeanchords' | 'monotonic' };
}

/** A fact the test was made with that desktop tells about (the PA pattern's defaults). */
export interface CalibNotice {
  kind: 'accel' | 'speed';
  value: number;
}

/** The engine's preview data: the vertices (orca_export_preview's file) and what goes with them. */
export interface EnginePreview {
  bin: ArrayBuffer;
  meta: PreviewMeta;
}

export type Request =
  | { op: 'init'; moduleUrl: string }
  | { op: 'slice'; job: SliceJob }
  | { op: 'cancel' }
  | { op: 'inspect'; files: ModelFile[] }
  /** Read a G-code file for the preview, as desktop's G-code viewer does. */
  | { op: 'gcodePreview'; bytes: ArrayBuffer }
  | { op: 'arrange'; files: ModelFile[]; layout: Layout; config: string }
  | { op: 'presetsLoad'; vendors: VendorBundle[]; userFiles: UserFiles }
  | { op: 'presetsSelect'; selection: PresetSelection }
  /** The preset types whose unsaved edits that selection would drop (it changes nothing). */
  | { op: 'presetsSelectLoses'; selection: PresetSelection }
  | { op: 'presetsConfig' }
  /** `extruder`: which of the printer's nozzles the settings are shown for (the first if absent). */
  | { op: 'presetsValues'; type: PresetType; extruder?: number }
  | { op: 'presetsEdit'; type: PresetType; values: Record<string, string | { index: number; value: string }> }
  | { op: 'presetsReset'; type: PresetType; keys?: string[]; to: 'saved' | 'system' }
  | { op: 'presetsSave'; type: PresetType; name: string }
  | { op: 'presetsDelete'; type: PresetType; name: string }
  | { op: 'presetsImport'; files: { name: string; bytes: ArrayBuffer }[]; replace?: string[] }
  | { op: 'presetsTemplates'; printer: string }
  | { op: 'presetsCreatePrinter'; spec: CreatePrinterSpec }
  | { op: 'presetsLinked'; model: string }
  | { op: 'presetsFilamentList' }
  | { op: 'presetsCreateFilament'; spec: CreateFilamentSpec }
  | { op: 'presetsUserFiles' }
  | { op: 'presetsPrinters' }
  | { op: 'presetsPresetValues'; type: PresetType; name: string; vendor?: string }
  | { op: 'presetsLoadAside'; vendor: string; vendors: VendorBundle[] }
  | { op: 'presetsAll'; type: PresetType }
  | { op: 'presetsCalib'; request: CalibRequest; assets: { path: string; bytes: ArrayBuffer }[] }
  | { op: 'presetsCalibVfa'; start: number; end: number; step: number; nozzle_based_resize: boolean }
  | { op: 'paintOpen'; file: ModelFile; object: number; instances: Mat4[]; supports?: PaintData }
  | { op: 'paintEvent'; event: PaintEvent }
  | { op: 'paintGap'; preview?: number | null; apply?: number }
  | { op: 'paintReset' }
  /** Other paint on the same object (undo); none: as the file has it. */
  | { op: 'paintSet'; supports?: PaintData }
  | { op: 'paintRender' }
  | { op: 'paintData' }
  | { op: 'paintClose' };

/**
 * A pointer event of support painting (orca_paint_event). `rays` in world coordinates: the
 * pointer's, then back along its path to the last point that hit (desktop's stroke).
 */
export interface PaintEvent {
  action: 'move' | 'down' | 'drag' | 'clear';
  button?: 'left' | 'right';
  erase?: boolean;
  tool: 'circle' | 'sphere' | 'fill';
  rays: number[][];
  camera: [number, number, number];
  radius: number;
  smart_fill_angle: number;
  /** Paint only on overhangs this steep (desktop's limit), or 0. */
  overhang_limit: number;
  instances?: Mat4[];
}

/**
 * The painted triangles to draw that changed, by block of the object's triangles (`full`: all of
 * them, the blocks shown before go). Each block's groups, in object coordinates (3 floats a
 * corner): enforcers, blockers; the fill tool's preview over unpainted, enforcer and blocker
 * triangles. A block with all groups empty has nothing drawn any more.
 */
export interface PaintRender {
  full: boolean;
  blocks: { key: string; groups: Float32Array[] }[];
}

export type ResponseValue = {
  init: EngineInfo;
  /** `preview`: the moves for the preview (null if the engine could not give them). */
  slice: { gcode: ArrayBuffer; preview: EnginePreview | null; stats: SliceStats; ms: { total: number; slice: number }; heapBytes: number };
  cancel: null;
  inspect: { info: ModelInfo; meshes: ArrayBuffer };
  gcodePreview: EnginePreview;
  /** Per layout object, its instances: the new matrix, and the bed (0: the plate; more: further plates to its right; -1: not placed). */
  arrange: { objects: { instances: { matrix: number[]; bed: number }[] }[] };
  presetsLoad: { printers: PresetEntry[]; warnings: string; ms: number };
  presetsSelect: PresetState;
  presetsSelectLoses: PresetType[];
  presetsConfig: string;
  presetsValues: PresetValues;
  presetsEdit: null;
  presetsReset: null;
  presetsSave: { name: string; file: string; userFiles: UserFiles };
  presetsDelete: { userFiles: UserFiles };
  presetsImport: {
    imported: { type: PresetType; name: string; file: string }[] /** Presets of these names exist already and were kept. */;
    existing: string[];
    userFiles: UserFiles;
  };
  presetsTemplates: { processes: PresetEntry[]; filaments: PresetEntry[] };
  presetsCreatePrinter: { printer: string; created: string[]; process: string; filament: string; userFiles: UserFiles };
  presetsLinked: { processes: PresetEntry[]; filaments: PresetEntry[] };
  presetsFilamentList: FilamentSource[];
  presetsCreateFilament: { created: string[]; filament_id: string; userFiles: UserFiles };
  presetsUserFiles: UserFiles;
  presetsPrinters: PresetEntry[];
  /** Any preset's settings (orca_presets_preset_values), to compare it with the edited one. */
  presetsPresetValues: { name: string; values: Record<string, string | string[]>; unloaded?: true };
  presetsLoadAside: void;
  /** Every visible preset of a type, `compatible` with the selected printer (orca_presets_all). */
  presetsAll: PresetEntry[];
  /** The test's plate (a 3MF), and what its slices need (none for some tests). */
  presetsCalib: { file: ArrayBuffer; calib: CalibParams | null; notices: CalibNotice[] };
  /** The VFA test's end speed against the filament's max volumetric speed (orca_presets_calib_vfa). */
  presetsCalibVfa: {
    exceeds: boolean;
    max_vol_speed: number;
    default_lh: number;
    limit: number;
    chosen_lh: number;
    min_lh: number;
    new_end: number;
  };
  paintOpen: PaintRender;
  paintEvent: { hit: boolean; point?: [number, number, number]; normal?: [number, number, number]; changed: boolean };
  paintRender: PaintRender;
  paintGap: PaintRender;
  paintReset: PaintRender;
  paintSet: PaintRender;
  paintData: PaintData;
  paintClose: void;
};

export type WorkerMessage =
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; error: SliceErrorData; fatal: boolean }
  | { id: number; progress: Progress };

export type { Layout };
