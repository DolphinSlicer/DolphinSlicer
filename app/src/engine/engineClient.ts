// Main-thread side of engine.worker.ts: request/response over postMessage, worker restarts.
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Request, ResponseValue, WorkerMessage } from './protocol';
import { type EngineFlavor, type EngineInfo, type Progress, SliceError } from './types';

export interface EngineManifest {
  builds: Partial<Record<EngineFlavor, { module: string; wasmBytes: number }>>;
}

let manifestPromise: Promise<EngineManifest> | null = null;
export function engineManifest(): Promise<EngineManifest> {
  manifestPromise ??= fetch(new URL('engine-manifest.json', document.baseURI)).then((r) => {
    if (!r.ok) throw new Error(`engine-manifest.json: HTTP ${r.status}`);
    return r.json() as Promise<EngineManifest>;
  });
  return manifestPromise;
}

type Pending = { resolve: (v: unknown) => void; reject: (e: unknown) => void; onProgress?: ((p: Progress) => void) | undefined };

/** One engine worker. `restart()` replaces it (after cancel in ST, or after a fatal error). */
export class EngineClient {
  private worker: Worker | null = null;
  private ready: Promise<EngineInfo> | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();

  /** Called after a crash took the worker (and all the engine held) away. */
  onCrash: (() => void) | undefined;

  constructor(readonly flavor: EngineFlavor) {}

  /** Whether there is a worker (none before start(), nor after a crash until the next start()). */
  get running(): boolean {
    return !!this.worker;
  }

  start(): Promise<EngineInfo> {
    if (this.ready) return this.ready;
    const worker = new Worker(new URL('./engine.worker.ts', import.meta.url), { type: 'module', name: `orca-engine-${this.flavor}` });
    this.worker = worker;
    worker.onmessage = (ev: MessageEvent<WorkerMessage>) => this.onMessage(ev.data);
    let started = false;
    // An uncaught error kills the worker's engine: fail what is pending and start over next time.
    worker.onerror = (ev) =>
      this.worker === worker &&
      this.terminate(
        new SliceError(
          started
            ? { code: 'INTERNAL', message: 'The slicing engine crashed', detail: ev.message }
            : { code: 'ENGINE_LOAD', message: 'The engine worker failed to start', detail: ev.message },
        ),
      );
    this.ready = engineManifest().then((m) => {
      const b = m.builds[this.flavor];
      if (!b) throw new SliceError({ code: 'ENGINE_LOAD', message: `No ${this.flavor} engine in this deployment` });
      return this.call('init', { moduleUrl: new URL(b.module, document.baseURI).href });
    });
    this.ready.then(
      () => {
        started = true;
      },
      () => this.terminate(),
    );
    return this.ready;
  }

  async call<K extends Request['op']>(
    op: K,
    args: Omit<Extract<Request, { op: K }>, 'op'>,
    onProgress?: (p: Progress) => void,
    transfer: Transferable[] = [],
  ): Promise<ResponseValue[K]> {
    if (!this.worker) throw new SliceError({ code: 'ENGINE_LOAD', message: 'Engine not started' });
    const id = this.nextId++;
    return new Promise<ResponseValue[K]>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, onProgress });
      this.worker!.postMessage({ id, op, ...args }, transfer);
    });
  }

  /** Send a request without waiting (used for cancel while a slice is in flight). */
  notify(op: 'cancel') {
    this.worker?.postMessage({ id: 0, op });
  }

  terminate(reason?: SliceError) {
    this.worker?.terminate();
    this.worker = null;
    this.ready = null;
    this.failAll(reason ?? new SliceError({ code: 'CANCELLED', message: 'Canceled' }));
    if (reason && reason.code !== 'ENGINE_LOAD' && reason.code !== 'CANCELLED') this.onCrash?.();
  }

  private failAll(err: SliceError) {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }

  private onMessage(m: WorkerMessage) {
    const p = this.pending.get(m.id);
    if (!p) return;
    if ('progress' in m) {
      p.onProgress?.(m.progress);
      return;
    }
    this.pending.delete(m.id);
    if (m.ok) p.resolve(m.value);
    else {
      const err = new SliceError(m.error);
      p.reject(err);
      // OOM or a trap: the wasm heap cannot shrink and state is unknown. Start over next time.
      if (m.fatal) this.terminate(err);
    }
  }
}
