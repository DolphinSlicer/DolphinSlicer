// Hosts one OrcaSlicer WebAssembly engine (slicer-st or slicer-mt) in a module worker.
// The main thread talks to it through engineClient.ts; see protocol.ts for the messages.
//
// Single-threaded build: orca_slice_start() blocks this worker until the slice ends, so cancel
// means terminating the worker (the client does that). Progress arrives through
// Module.onOrcaProgress, called synchronously from C++; postMessage still reaches the main
// thread because the main thread is not blocked.
// Multithreaded build: the slice runs on a pthread; this worker polls and handles cancel.
// SPDX-License-Identifier: AGPL-3.0-or-later
/// <reference lib="webworker" />

import type { PreviewMeta } from '../gcode/preview';
import type { EnginePreview, ModelInfo, PaintRender, Request, ResponseValue, WorkerMessage } from './protocol';
import { type EngineInfo, type ModelFile, type SliceErrorData, STATUS_TO_CODE } from './types';

interface OrcaModule {
  FS: {
    mkdirTree(p: string): void;
    writeFile(p: string, data: Uint8Array | string): void;
    readFile(p: string): Uint8Array;
    unlink(p: string): void;
    rmdir(p: string): void;
    readdir(p: string): string[];
    analyzePath(p: string): { exists: boolean };
    isDir(mode: number): boolean;
    stat(p: string): { mode: number };
  };
  HEAPU8: Uint8Array;
  wasmMemory: WebAssembly.Memory;
  UTF8ToString(ptr: number): string;
  ccall(name: string, ret: 'number' | 'string' | null, types: string[], args: unknown[]): unknown;
  onOrcaProgress?: (percent: number, message: string) => void;
  _orca_engine_info(): number;
  _orca_create(): number;
  _orca_destroy(e: number): void;
  _orca_slice_poll(e: number): number;
  _orca_cancel(e: number): void;
  _orca_progress(e: number): number;
  _orca_result(e: number): number;
  _orca_last_error(e: number): number;
  _orca_model_info(e: number): number;
  _orca_presets_create(): number;
  _orca_presets_destroy(p: number): void;
  _orca_paint_close(p: number): void;
  _orca_paint_reset(p: number): void;
  _orca_paint_render(p: number): number;
  _orca_paint_data(p: number): number;
  _orca_presets_list(p: number): number;
  _orca_presets_state(p: number): number;
  _orca_presets_last_error(p: number): number;
  _orca_config_schema(): number;
  _malloc(n: number): number;
  _free(p: number): void;
}

const ORCA_OK = 0;
const ORCA_RUNNING = 1;

let M: OrcaModule | null = null;
let info: EngineInfo | null = null;
let aborted: string | null = null;
let presets = 0;
/** Presets of another vendor kept aside, to compare with (presetsLoadAside), and its id. */
let aside = 0;
let asideVendor = '';
/** The open support painting (orca_paint_open), if any. */
let painter = 0;
let running = 0; // engine handle of the slice in progress (MT)
let inFlight = 0; // request id being handled (for failures reported from onAbort)

const post = (m: WorkerMessage, transfer: Transferable[] = []) => (self as DedicatedWorkerGlobalScope).postMessage(m, transfer);

class EngineFailure extends Error {
  constructor(
    readonly data: SliceErrorData,
    readonly fatal = false,
  ) {
    super(data.message);
  }
}

function isOom(err: unknown): boolean {
  const s = String((err as Error)?.message ?? err);
  return err instanceof RangeError || /out of memory|OOM|Cannot enlarge memory|could not allocate/i.test(s);
}

/** Heap within 64 MiB of the wasm32 limit. In the multithreaded build mimalloc's operator new
 *  aborts on allocation failure instead of throwing std::bad_alloc (Emscripten 6.0.13), so an
 *  abort with a full heap is how out-of-memory shows up there. */
function heapExhausted(): boolean {
  return heapBytes() >= 4 * 2 ** 30 - 64 * 2 ** 20;
}

/** Current wasm heap size. (HEAPU8 can be a stale view in the multithreaded build after another
 *  thread grew the memory.) */
function heapBytes(): number {
  return M ? M.wasmMemory.buffer.byteLength : 0;
}

function wrapError(err: unknown): EngineFailure {
  if (err instanceof EngineFailure) return err;
  if (isOom(err) || (aborted && isOom(aborted)) || heapExhausted())
    return new EngineFailure({ code: 'OOM', message: 'Out of memory', detail: String((err as Error)?.message ?? err) }, true);
  // Anything else thrown out of wasm (trap, abort) leaves the module in an unknown state.
  return new EngineFailure({ code: 'INTERNAL', message: 'The slicing engine crashed', detail: String((err as Error)?.stack ?? err) }, true);
}

function lastError(e: number): EngineFailure {
  const j = JSON.parse(M!.UTF8ToString(M!._orca_last_error(e))) as { code: number; message: string; detail: string };
  const code = STATUS_TO_CODE[j.code] ?? 'INTERNAL';
  return new EngineFailure({ code, message: j.message, detail: j.detail }, code === 'OOM');
}

/** The engine's moves of its last slice or G-code file, for the preview (orca_export_preview). */
function exportPreview(e: number): EnginePreview {
  const m = M!;
  const out = m.ccall('orca_export_preview', 'number', ['number'], [e]) as number;
  if (!out) throw lastError(e);
  const { data, bytes, ...meta } = JSON.parse(m.UTF8ToString(out)) as PreviewMeta & { data: number; bytes: number };
  // Copied straight out of the engine's memory (the current buffer: it may have grown).
  const bin = new Uint8Array(m.wasmMemory.buffer, data, bytes).slice().buffer;
  return { bin, meta };
}

function rmTree(path: string) {
  const fs = M!.FS;
  if (!fs.analyzePath(path).exists) return;
  for (const name of fs.readdir(path)) {
    if (name === '.' || name === '..') continue;
    const p = `${path}/${name}`;
    if (fs.isDir(fs.stat(p).mode)) rmTree(p);
    else fs.unlink(p);
  }
  fs.rmdir(path);
}

const USER_DIR = '/orca/user/default';

function closePainter() {
  if (painter) M!._orca_paint_close(painter);
  painter = 0;
}
function needPainter(): number {
  if (!painter) throw new EngineFailure({ code: 'INVALID_INPUT', message: 'Not painting' });
  return painter;
}
/** The painted triangles that changed, copied out of the engine's memory (orca_paint_render). */
function paintRender(): PaintRender {
  const m = M!;
  const r = JSON.parse(m.UTF8ToString(m._orca_paint_render(painter))) as {
    ptr: number;
    full: boolean;
    blocks: { part: number; block: number; counts: number[] }[];
  };
  let at = r.ptr;
  // The current buffer: the memory may have grown.
  const take = (n: number) => {
    const a = new Float32Array(m.wasmMemory.buffer, at, n).slice();
    at += n * 4;
    return a;
  };
  return { full: r.full, blocks: r.blocks.map((b) => ({ key: `${b.part}:${b.block}`, groups: b.counts.map(take) })) };
}

function presetsError(handle = presets): EngineFailure {
  const err = JSON.parse(M!.UTF8ToString(M!._orca_presets_last_error(handle))) as { message: string; detail: string };
  return new EngineFailure({ code: 'INVALID_CONFIG', message: err.message, detail: err.detail });
}

/** User preset files (desktop layout under /orca/user/default), for storage outside the engine. */
function readUserFiles(): Record<string, string> {
  const fs = M!.FS,
    out: Record<string, string> = {};
  const walk = (dir: string, rel: string) => {
    if (!fs.analyzePath(dir).exists) return;
    for (const name of fs.readdir(dir)) {
      if (name === '.' || name === '..') continue;
      const p = `${dir}/${name}`,
        r = rel ? `${rel}/${name}` : name;
      if (fs.isDir(fs.stat(p).mode)) walk(p, r);
      else if (/\.(json|info)$/.test(name)) out[r] = new TextDecoder().decode(fs.readFile(p));
    }
  };
  walk(USER_DIR, '');
  return out;
}

function writeUserFiles(files: Record<string, string>) {
  for (const [rel, text] of Object.entries(files)) {
    if (rel.split('/').some((p) => p === '..' || p === '')) continue;
    const full = `${USER_DIR}/${rel}`;
    M!.FS.mkdirTree(full.slice(0, full.lastIndexOf('/')));
    M!.FS.writeFile(full, text);
  }
}

function ext(name: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(name);
  return m ? m[1]!.toLowerCase() : '';
}

/** Load all files into a fresh engine instance. Returns the engine handle. */
function loadFiles(files: ModelFile[]): number {
  const m = M!;
  rmTree('/in');
  m.FS.mkdirTree('/in');
  const e = m._orca_create();
  if (!e) throw new EngineFailure({ code: 'OOM', message: 'Out of memory' }, true);
  try {
    files.forEach((f, i) => {
      // OrcaSlicer names objects after the file (it shows up in the G-code as
      // "; printing object <name>"), so keep the real name in a per-file folder.
      const safe = f.name.replace(/[/\\\0]/g, '_') || `model.${ext(f.name) || 'bin'}`;
      m.FS.mkdirTree(`/in/${i}`);
      const path = `/in/${i}/${safe}`;
      m.FS.writeFile(path, new Uint8Array(f.bytes));
      const rc = m.ccall(
        i === 0 ? 'orca_load_model' : 'orca_add_model',
        'number',
        ['number', 'string', 'string'],
        [e, path, ext(f.name)],
      ) as number;
      m.FS.unlink(path);
      if (rc !== ORCA_OK) {
        const err = lastError(e);
        err.data.message = `${f.name}: ${err.data.message}`;
        throw err;
      }
    });
    return e;
  } catch (err) {
    m._orca_destroy(e);
    throw err;
  }
}

const handlers: { [K in Request['op']]: (req: Extract<Request, { op: K }>, id: number) => Promise<ResponseValue[K]> } = {
  async init(req) {
    if (info) return info;
    const mod = (await import(/* @vite-ignore */ req.moduleUrl)) as { default: (o: object) => Promise<OrcaModule> };
    M = await mod.default({
      print: () => {},
      printErr: (s: string) => console.debug('[engine]', s),
      // An abort (in the multithreaded build also from a pthread, e.g. mimalloc on allocation
      // failure) kills the module. Fail the request in flight right away with the right code;
      // the client then replaces this worker.
      onAbort: (what: unknown) => {
        aborted = String(what);
        failInFlight(aborted);
      },
    });
    info = JSON.parse(M.UTF8ToString(M._orca_engine_info())) as EngineInfo;
    return info;
  },

  async slice(req, id) {
    const m = M!;
    const { job } = req;
    const t0 = performance.now();
    const reserved: number[] = [];
    let e = 0;
    try {
      // Debug hook: hold back heap so a normal slice runs out of memory (OOM UX test).
      for (let mb = job.debug?.reserveHeapMB ?? 0; mb > 0; mb -= 256) {
        const p = m._malloc(Math.min(mb, 256) * 2 ** 20);
        if (!p) break;
        reserved.push(p);
      }
      e = loadFiles(job.files);
      if (job.layout) {
        const rc = m.ccall('orca_set_layout', 'number', ['number', 'string'], [e, JSON.stringify(job.layout)]) as number;
        if (rc !== ORCA_OK) throw lastError(e);
      }
      // Read by the engine's thumbnail callback (orca_engine.cpp, read_thumbnails).
      m.FS.mkdirTree('/thumbs');
      for (const f of m.FS.readdir('/thumbs')) if (f !== '.' && f !== '..') m.FS.unlink(`/thumbs/${f}`);
      for (const th of job.thumbnails ?? []) m.FS.writeFile(`/thumbs/${th.width}x${th.height}.rgba`, th.rgba);
      let rc = m.ccall('orca_set_config', 'number', ['number', 'string'], [e, job.config]) as number;
      if (rc !== ORCA_OK) throw lastError(e);
      if (job.calib) {
        rc = m.ccall('orca_set_calib', 'number', ['number', 'string'], [e, JSON.stringify(job.calib)]) as number;
        if (rc !== ORCA_OK) throw lastError(e);
      }
      const out = `/out/plate_${job.plate}.gcode`;
      let lastPct = -1;
      m.onOrcaProgress = (percent, message) => {
        if (percent === lastPct) return;
        lastPct = percent;
        post({ id, progress: { percent, message, heapBytes: heapBytes() } });
      };
      const t1 = performance.now();
      running = e;
      rc = m.ccall('orca_slice_start', 'number', ['number', 'number', 'string'], [e, job.plate, out]) as number;
      while (rc === ORCA_RUNNING) {
        await new Promise((r) => setTimeout(r, 50));
        const p = JSON.parse(m.UTF8ToString(m._orca_progress(e))) as { percent: number; message: string };
        m.onOrcaProgress(p.percent, p.message);
        rc = m._orca_slice_poll(e);
      }
      running = 0;
      const t2 = performance.now();
      if (rc !== ORCA_OK) throw lastError(e);
      const bytes = m.FS.readFile(out);
      m.FS.unlink(out);
      const stats = JSON.parse(m.UTF8ToString(m._orca_result(e)));
      // readFile returns a view on a fresh ArrayBuffer of exactly this size; transfer it.
      const gcode =
        bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? (bytes.buffer as ArrayBuffer) : bytes.slice().buffer;
      // Without the preview the G-code is still there to save or send.
      let preview: EnginePreview | null = null;
      try {
        preview = exportPreview(e);
      } catch {
        /* none */
      }
      return { gcode, preview, stats, ms: { total: t2 - t0, slice: t2 - t1 }, heapBytes: heapBytes() };
    } finally {
      running = 0;
      m.onOrcaProgress = undefined;
      if (e) m._orca_destroy(e);
      for (const p of reserved) m._free(p);
    }
  },

  async cancel() {
    if (running) M!._orca_cancel(running);
    return null;
  },

  async export3mf(req) {
    const m = M!;
    const e = loadFiles(req.files);
    try {
      let rc = m.ccall('orca_set_layout', 'number', ['number', 'string'], [e, JSON.stringify(req.layout)]) as number;
      if (rc !== ORCA_OK) throw lastError(e);
      rc = m.ccall('orca_set_config', 'number', ['number', 'string'], [e, req.config]) as number;
      if (rc !== ORCA_OK) throw lastError(e);
      rc = m.ccall('orca_export_3mf', 'number', ['number', 'string'], [e, '/out/plate.3mf']) as number;
      if (rc !== ORCA_OK) throw lastError(e);
      const bytes = m.FS.readFile('/out/plate.3mf');
      m.FS.unlink('/out/plate.3mf');
      return bytes.slice().buffer;
    } finally {
      m._orca_destroy(e);
    }
  },

  async arrange(req) {
    const m = M!;
    const e = loadFiles(req.files);
    try {
      let rc = m.ccall('orca_set_layout', 'number', ['number', 'string'], [e, JSON.stringify(req.layout)]) as number;
      if (rc !== ORCA_OK) throw lastError(e);
      rc = m.ccall('orca_set_config', 'number', ['number', 'string'], [e, req.config]) as number;
      if (rc !== ORCA_OK) throw lastError(e);
      const out = m.ccall('orca_arrange', 'number', ['number'], [e]) as number;
      if (!out) throw lastError(e);
      return JSON.parse(m.UTF8ToString(out));
    } finally {
      m._orca_destroy(e);
    }
  },

  async gcodePreview(req) {
    const m = M!;
    const e = m._orca_create();
    try {
      m.FS.mkdirTree('/in');
      m.FS.writeFile('/in/preview.gcode', new Uint8Array(req.bytes));
      const rc = m.ccall('orca_process_gcode', 'number', ['number', 'string'], [e, '/in/preview.gcode']) as number;
      m.FS.unlink('/in/preview.gcode');
      if (rc !== ORCA_OK) throw lastError(e);
      return exportPreview(e);
    } finally {
      m._orca_destroy(e);
    }
  },

  async inspect(req) {
    const m = M!;
    const e = loadFiles(req.files);
    try {
      const info = JSON.parse(m.UTF8ToString(m._orca_model_info(e))) as ModelInfo;
      const rc = m.ccall('orca_export_meshes', 'number', ['number', 'string'], [e, '/out/meshes.bin']) as number;
      if (rc !== ORCA_OK) throw lastError(e);
      const bytes = m.FS.readFile('/out/meshes.bin');
      m.FS.unlink('/out/meshes.bin');
      return { info, meshes: bytes.slice().buffer };
    } finally {
      m._orca_destroy(e);
    }
  },

  async presetsLoad(req) {
    const m = M!;
    const t0 = performance.now();
    rmTree('/orca/system');
    rmTree(USER_DIR);
    writeUserFiles(req.userFiles);
    for (const v of req.vendors)
      for (const [path, text] of Object.entries(v.files)) {
        const full = `/orca/system/${path}`;
        m.FS.mkdirTree(full.slice(0, full.lastIndexOf('/')));
        m.FS.writeFile(full, text);
      }
    if (presets) m._orca_presets_destroy(presets);
    presets = m._orca_presets_create();
    const rc = m.ccall('orca_presets_load', 'number', ['number', 'string'], [presets, '/orca']) as number;
    const err = JSON.parse(m.UTF8ToString(m._orca_presets_last_error(presets))) as { code: number; message: string; detail: string };
    if (rc !== ORCA_OK) throw new EngineFailure({ code: STATUS_TO_CODE[rc] ?? 'INTERNAL', message: err.message, detail: err.detail });
    const printers = JSON.parse(m.UTF8ToString(m._orca_presets_list(presets))).printers;
    return { printers, warnings: err.detail, ms: performance.now() - t0 };
  },

  async presetsSelect(req) {
    const m = M!;
    const rc = m.ccall('orca_presets_select', 'number', ['number', 'string'], [presets, JSON.stringify(req.selection)]) as number;
    if (rc !== ORCA_OK) {
      const err = JSON.parse(m.UTF8ToString(m._orca_presets_last_error(presets)));
      throw new EngineFailure({ code: 'INVALID_CONFIG', message: `${err.message}: ${err.detail}` });
    }
    return JSON.parse(m.UTF8ToString(m._orca_presets_state(presets)));
  },

  async presetsLoadProject(req) {
    const m = M!;
    const text = m.ccall(
      'orca_presets_load_project',
      'string',
      ['number', 'string'],
      [presets, JSON.stringify({ name: req.name, config: req.config })],
    ) as string | null;
    if (!text) throw presetsError();
    return { state: JSON.parse(m.UTF8ToString(m._orca_presets_state(presets))), gcode: JSON.parse(text).gcode };
  },

  async presetsSelectLoses(req) {
    const text = M!.ccall('orca_presets_select_loses', 'string', ['number', 'string'], [presets, JSON.stringify(req.selection)]) as
      | string
      | null;
    if (!text) throw presetsError();
    return JSON.parse(text).lost;
  },

  async presetsValues(req) {
    const text = M!.ccall('orca_presets_values', 'string', ['number', 'string', 'number'], [presets, req.type, req.extruder ?? 0]) as
      | string
      | null;
    if (!text) throw presetsError();
    return JSON.parse(text);
  },

  async presetsEdit(req) {
    const rc = M!.ccall(
      'orca_presets_edit',
      'number',
      ['number', 'string'],
      [presets, JSON.stringify({ type: req.type, values: req.values })],
    ) as number;
    if (rc !== ORCA_OK) throw presetsError();
    return null;
  },

  async presetsReset(req) {
    const rc = M!.ccall(
      'orca_presets_reset',
      'number',
      ['number', 'string'],
      [presets, JSON.stringify({ type: req.type, keys: req.keys, to: req.to })],
    ) as number;
    if (rc !== ORCA_OK) throw presetsError();
    return null;
  },

  async presetsSave(req) {
    const text = M!.ccall(
      'orca_presets_save',
      'string',
      ['number', 'string'],
      [presets, JSON.stringify({ type: req.type, name: req.name })],
    ) as string | null;
    if (!text) throw presetsError();
    return { ...JSON.parse(text), userFiles: readUserFiles() };
  },

  async presetsDelete(req) {
    const rc = M!.ccall(
      'orca_presets_delete',
      'number',
      ['number', 'string'],
      [presets, JSON.stringify({ type: req.type, name: req.name })],
    ) as number;
    if (rc !== ORCA_OK) throw presetsError();
    return { userFiles: readUserFiles() };
  },

  async presetsImport(req) {
    const m = M!;
    rmTree('/import');
    m.FS.mkdirTree('/import');
    const paths = req.files.map((f, i) => {
      const path = `/import/${i}-${f.name.replace(/[/\\\0]/g, '_')}`;
      m.FS.writeFile(path, new Uint8Array(f.bytes));
      return path;
    });
    const text = m.ccall(
      'orca_presets_import',
      'string',
      ['number', 'string'],
      [presets, JSON.stringify({ files: paths, replace: req.replace ?? [] })],
    ) as string | null;
    rmTree('/import');
    if (!text) throw presetsError();
    return { ...JSON.parse(text), userFiles: readUserFiles() };
  },

  async presetsTemplates(req) {
    const text = M!.ccall('orca_presets_templates', 'string', ['number', 'string'], [presets, JSON.stringify({ printer: req.printer })]) as
      | string
      | null;
    if (!text) throw presetsError();
    return JSON.parse(text);
  },

  async presetsCreatePrinter(req) {
    const text = M!.ccall('orca_presets_create_printer', 'string', ['number', 'string'], [presets, JSON.stringify(req.spec)]) as
      | string
      | null;
    if (!text) throw presetsError();
    return { ...JSON.parse(text), userFiles: readUserFiles() };
  },

  async presetsLinked(req) {
    const text = M!.ccall('orca_presets_linked', 'string', ['number', 'string'], [presets, JSON.stringify({ model: req.model })]) as
      | string
      | null;
    if (!text) throw presetsError();
    return JSON.parse(text);
  },

  async presetsFilamentList() {
    const text = M!.ccall('orca_presets_filament_list', 'string', ['number'], [presets]) as string | null;
    if (!text) throw presetsError();
    return JSON.parse(text);
  },

  async presetsCreateFilament(req) {
    const text = M!.ccall('orca_presets_create_filament', 'string', ['number', 'string'], [presets, JSON.stringify(req.spec)]) as
      | string
      | null;
    if (!text) throw presetsError();
    return { ...JSON.parse(text), userFiles: readUserFiles() };
  },

  async presetsUserFiles() {
    return readUserFiles();
  },

  async presetsPresetValues(req) {
    // Another vendor's preset: from those kept aside, when that vendor's are.
    if (req.vendor && req.vendor !== asideVendor) return { name: req.name, values: {}, unloaded: true };
    const handle = req.vendor ? aside : presets;
    const text = M!.ccall(
      'orca_presets_preset_values',
      'string',
      ['number', 'string'],
      [handle, JSON.stringify({ type: req.type, name: req.name })],
    ) as string | null;
    if (!text) throw presetsError(handle);
    return JSON.parse(text);
  },

  async presetsLoadAside(req) {
    const m = M!;
    asideVendor = '';
    if (aside) m._orca_presets_destroy(aside);
    aside = 0;
    rmTree('/orca-aside');
    for (const v of req.vendors)
      for (const [path, text] of Object.entries(v.files)) {
        const full = `/orca-aside/system/${path}`;
        m.FS.mkdirTree(full.slice(0, full.lastIndexOf('/')));
        m.FS.writeFile(full, text);
      }
    const h = m._orca_presets_create();
    const rc = m.ccall('orca_presets_load_aside', 'number', ['number', 'string'], [h, '/orca-aside']) as number;
    if (rc !== ORCA_OK) {
      const e = presetsError(h);
      m._orca_presets_destroy(h);
      throw e;
    }
    aside = h;
    asideVendor = req.vendor;
  },

  async paintOpen(req) {
    const m = M!;
    closePainter();
    const e = loadFiles([req.file]);
    try {
      const p = m.ccall(
        'orca_paint_open',
        'number',
        ['number', 'string'],
        [e, JSON.stringify({ object: req.object, instances: req.instances, ...(req.supports ? { supports: req.supports } : {}) })],
      ) as number;
      if (!p) throw lastError(e);
      painter = p;
    } finally {
      m._orca_destroy(e);
    }
    return paintRender();
  },

  async paintEvent(req) {
    const p = needPainter();
    const r = JSON.parse(
      M!.ccall('orca_paint_event', 'string', ['number', 'string'], [p, JSON.stringify(req.event)]) as string,
    ) as ResponseValue['paintEvent'] & { error?: string };
    if (r.error) throw new EngineFailure({ code: 'INVALID_INPUT', message: 'Painting failed', detail: r.error });
    return r;
  },

  async paintRender() {
    needPainter();
    return paintRender();
  },

  async paintGap(req) {
    const p = needPainter();
    M!.ccall(
      'orca_paint_gap',
      'number',
      ['number', 'string'],
      [
        p,
        JSON.stringify({
          ...(req.preview !== undefined ? { preview: req.preview } : {}),
          ...(req.apply !== undefined ? { apply: req.apply } : {}),
        }),
      ],
    );
    return paintRender();
  },

  async paintReset() {
    M!._orca_paint_reset(needPainter());
    return paintRender();
  },

  async paintSet(req) {
    const rc = M!.ccall(
      'orca_paint_set',
      'number',
      ['number', 'string'],
      [needPainter(), JSON.stringify({ supports: req.supports ?? null })],
    ) as number;
    if (rc !== ORCA_OK)
      throw new EngineFailure({ code: 'INVALID_INPUT', message: 'Painting failed', detail: 'The painted facets don’t fit the object' });
    return paintRender();
  },

  async paintData() {
    return JSON.parse(M!.UTF8ToString(M!._orca_paint_data(needPainter())));
  },

  async paintClose() {
    closePainter();
  },

  async presetsAll(req) {
    const text = M!.ccall('orca_presets_all', 'string', ['number', 'string'], [presets, JSON.stringify({ type: req.type })]) as
      | string
      | null;
    if (!text) throw presetsError();
    return JSON.parse(text);
  },

  async presetsCalib(req) {
    const m = M!;
    for (const a of req.assets) {
      const full = `/calib/${a.path}`;
      m.FS.mkdirTree(full.slice(0, full.lastIndexOf('/')));
      m.FS.writeFile(full, new Uint8Array(a.bytes));
    }
    const out = '/out/calib.3mf';
    const text = m.ccall(
      'orca_presets_calib',
      'string',
      ['number', 'string'],
      [presets, JSON.stringify({ ...req.request, assets: '/calib', out })],
    ) as string | null;
    if (!text) throw presetsError();
    const bytes = m.FS.readFile(out);
    m.FS.unlink(out);
    const r = JSON.parse(text);
    return { file: bytes.slice().buffer, calib: r.calib, notices: r.notices };
  },

  async presetsCalibVfa(req) {
    const { start, end, step, nozzle_based_resize } = req;
    const text = M!.ccall(
      'orca_presets_calib_vfa',
      'string',
      ['number', 'string'],
      [presets, JSON.stringify({ start, end, step, nozzle_based_resize })],
    ) as string | null;
    if (!text) throw presetsError();
    return JSON.parse(text);
  },

  async presetsPrinters() {
    return JSON.parse(M!.UTF8ToString(M!._orca_presets_list(presets))).printers;
  },

  async presetsConfig() {
    const text = M!.ccall('orca_presets_full_config', 'string', ['number'], [presets]) as string | null;
    if (!text) {
      const err = JSON.parse(M!.UTF8ToString(M!._orca_presets_last_error(presets)));
      throw new EngineFailure({ code: 'INVALID_CONFIG', message: err.message, detail: err.detail });
    }
    return text;
  },
};

// Uncaught errors here or forwarded from a pthread worker (Emscripten re-throws those in this
// worker) end this engine. Report them on the request in flight before the worker dies.
function failInFlight(detail: string) {
  if (!inFlight) return;
  const oom = isOom(detail) || heapExhausted();
  post({
    id: inFlight,
    ok: false,
    fatal: true,
    error: oom ? { code: 'OOM', message: 'Out of memory', detail } : { code: 'INTERNAL', message: 'The slicing engine crashed', detail },
  });
  inFlight = 0;
}
self.addEventListener('error', (ev) => failInFlight(String(ev.error?.stack ?? ev.message ?? ev)));
self.addEventListener('unhandledrejection', (ev) => failInFlight(String(ev.reason?.stack ?? ev.reason)));

self.onmessage = async (ev: MessageEvent<Request & { id: number }>) => {
  const { id, ...req } = ev.data;
  try {
    if (req.op !== 'init' && req.op !== 'cancel' && !M)
      throw new EngineFailure({ code: 'ENGINE_LOAD', message: 'Engine not initialised' }, true);
    if (aborted && req.op !== 'cancel')
      throw new EngineFailure(
        { code: isOom(aborted) || heapExhausted() ? 'OOM' : 'INTERNAL', message: 'The engine stopped', detail: aborted },
        true,
      );
    const handler = handlers[req.op] as (r: Request, id: number) => Promise<unknown>;
    if (req.op !== 'cancel') inFlight = id;
    const value = await handler(req as Request, id);
    if (req.op !== 'cancel') {
      if (inFlight !== id) return; // already failed from onAbort
      inFlight = 0;
    }
    const transfer: Transferable[] = [];
    if (req.op === 'slice') transfer.push((value as ResponseValue['slice']).gcode);
    if (req.op === 'inspect') transfer.push((value as ResponseValue['inspect']).meshes);
    if (req.op === 'export3mf') transfer.push(value as ResponseValue['export3mf']);
    if (req.op === 'gcodePreview') transfer.push((value as ResponseValue['gcodePreview']).bin);
    // Painted triangles: the arrays' buffers.
    const render =
      req.op === 'paintOpen' || req.op === 'paintGap' || req.op === 'paintReset' || req.op === 'paintSet' || req.op === 'paintRender'
        ? (value as PaintRender)
        : undefined;
    if (render) for (const b of render.blocks) transfer.push(...b.groups.map((a) => a.buffer as ArrayBuffer));
    if (req.op === 'slice' && (value as ResponseValue['slice']).preview) transfer.push((value as ResponseValue['slice']).preview!.bin);
    post({ id, ok: true, value }, transfer);
  } catch (err) {
    if (req.op !== 'cancel') {
      if (inFlight !== id) return; // already failed from onAbort
      inFlight = 0;
    }
    const f =
      req.op === 'init'
        ? new EngineFailure(
            { code: 'ENGINE_LOAD', message: 'Could not load the slicing engine', detail: String((err as Error)?.message ?? err) },
            true,
          )
        : wrapError(err);
    post({ id, ok: false, error: f.data, fatal: f.fatal || !!aborted });
  }
};
