// Engine-facing types shared by the UI, the workers and any future backend.
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { CalibParams, EnginePreview } from './protocol';

export type EngineFlavor = 'st' | 'mt';

export interface EngineInfo {
  api: number;
  orca_version: string;
  orca_sha: string;
  threads: boolean;
  build: EngineFlavor;
}

/** A model or project file. The first file of a job is opened as the project (a 3MF keeps its
 *  plates and per-object settings); later files are added as geometry. */
export interface ModelFile {
  name: string;
  bytes: ArrayBuffer;
}

/** 4×4 column-major matrix (three.js `Matrix4.elements` order). */
export type Mat4 = number[];

/**
 * Painted supports of an object, per model part: desktop's 3MF form of each painted triangle
 * ([triangle, "hex"]). orca_paint_data writes it, orca_set_layout applies it.
 */
export type PaintData = [number, string][][];

/** Desktop's generic shapes (Add support blocker / enforcer). */
export type SupportShape = 'cube' | 'cylinder' | 'sphere' | 'cone' | 'disc' | 'torus';

/**
 * A support blocker or enforcer: a generic shape of an object. `size` as desktop's size dialog
 * has it (cube: x y z; cylinder, cone, disc: diameter height; sphere: diameter; torus: inner
 * diameter, tube diameter); the shape centred on its origin, placed by `matrix` in the object's
 * coordinates (the instance's matrix applies on top).
 */
export interface SupportVolume {
  type: 'support_blocker' | 'support_enforcer';
  shape: SupportShape;
  size: number[];
  matrix: Mat4;
}

/** A support volume of the object as loaded (a project's), by its number: kept, placed by `matrix`. */
export interface LoadedSupportVolume {
  type: SupportVolume['type'];
  loaded: number;
  matrix: Mat4;
}

export interface LayoutObject {
  /** Index of the object in load order (all objects of file 0, then file 1, …). Listed again: a copy. */
  index: number;
  instances: { matrix: Mat4 }[];
  /** Painted supports (absent: as loaded). */
  supports?: PaintData;
  /**
   * Its support blockers and enforcers, all of them: shapes added, and its own as loaded by number
   * (one not listed goes). Absent: as loaded.
   */
  volumes?: (SupportVolume | LoadedSupportVolume)[];
}

export interface Layout {
  objects: LayoutObject[];
}

/** Everything needed to slice one plate. Plain data, so a remote backend could take it too. */
export interface Thumbnail {
  width: number;
  height: number;
  rgba: Uint8Array;
}

export interface SliceJob {
  files: ModelFile[];
  layout?: Layout;
  /** Full config JSON (OrcaSlicer project_settings format). */
  config: string;
  /** 1-based plate index. */
  plate: number;
  /** The calibration test the plate is (desktop's calibration menu), for its G-code. */
  calib?: CalibParams | null;
  /**
   * The G-code thumbnails, rendered by the app (desktop renders them with OpenGL, which the
   * engine lacks): RGBA, bottom row first. The engine writes the sizes the printer's
   * "thumbnails" setting asks for; a size not given here is left out.
   */
  thumbnails?: Thumbnail[];
  /** Test hooks, only honoured in debug mode. */
  debug?: { reserveHeapMB?: number };
}

export interface Progress {
  percent: number;
  message: string;
  heapBytes?: number;
}

export interface SliceStats {
  print_time_s: number;
  filament_mm: number;
  filament_cm3: number;
  filament_g: number;
  cost: number;
  warnings: string[];
  /** Desktop's name for the file, from the printer's "Filename format". */
  file_name?: string;
}

export interface SliceResult {
  gcode: Blob;
  /** The moves for the preview, as the engine gives them (null if it could not). */
  preview: EnginePreview | null;
  stats: SliceStats;
  ms: { total: number; slice: number };
  heapBytes: number;
}

export type SliceErrorCode =
  | 'INVALID_INPUT'
  | 'INVALID_CONFIG'
  | 'VALIDATE_ERROR'
  | 'SLICE_FAILED'
  | 'CANCELLED'
  | 'OOM'
  | 'EMPTY_PLATE'
  | 'INTERNAL'
  | 'ENGINE_LOAD';

export const STATUS_TO_CODE: Record<number, SliceErrorCode> = {
  [-1]: 'INVALID_INPUT',
  [-2]: 'INVALID_CONFIG',
  [-3]: 'VALIDATE_ERROR',
  [-4]: 'SLICE_FAILED',
  [-5]: 'CANCELLED',
  [-6]: 'OOM',
  [-7]: 'EMPTY_PLATE',
  [-8]: 'INTERNAL',
};

export interface SliceErrorData {
  code: SliceErrorCode;
  message: string;
  detail?: string;
}

export class SliceError extends Error {
  readonly code: SliceErrorCode;
  readonly detail: string;
  constructor(data: SliceErrorData) {
    super(data.message);
    this.name = 'SliceError';
    this.code = data.code;
    this.detail = data.detail ?? '';
  }
  /** True if retrying (possibly with other input/settings) can succeed in this session. */
  get recoverable(): boolean {
    return this.code !== 'ENGINE_LOAD' && this.code !== 'INTERNAL';
  }
}

/** A way to slice. Today: WebAssembly in a worker. Later possibly a remote service. */
export interface SliceBackend {
  readonly kind: string;
  info(): Promise<EngineInfo>;
  slice(job: SliceJob, opts: { signal?: AbortSignal; onProgress?: (p: Progress) => void }): Promise<SliceResult>;
  /** Read a G-code file for the preview, as desktop's G-code viewer does. */
  gcodePreview(bytes: ArrayBuffer): Promise<EnginePreview>;
  dispose(): Promise<void>;
}
