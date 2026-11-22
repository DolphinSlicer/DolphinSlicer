// SliceBackend over the WebAssembly engine in a worker.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { brandGcode } from './brand';
import { EngineClient } from './engineClient';
import type { EnginePreview } from './protocol';
import { type EngineFlavor, type EngineInfo, type Progress, type SliceBackend, SliceError, type SliceJob, type SliceResult } from './types';

export class WasmWorkerBackend implements SliceBackend {
  readonly kind: string;
  private client: EngineClient;
  private busy = false;
  /** A G-code file being read: a slice waits for it. */
  private reading: Promise<unknown> = Promise.resolve();

  constructor(readonly flavor: EngineFlavor) {
    this.kind = `wasm-${flavor}`;
    this.client = new EngineClient(flavor);
  }

  info(): Promise<EngineInfo> {
    return this.client.start();
  }

  async slice(job: SliceJob, opts: { signal?: AbortSignal; onProgress?: (p: Progress) => void } = {}): Promise<SliceResult> {
    if (this.busy) throw new SliceError({ code: 'INTERNAL', message: 'A slice is already running' });
    const { signal, onProgress } = opts;
    await this.reading.catch(() => {});
    if (signal?.aborted) throw new SliceError({ code: 'CANCELLED', message: 'Canceled' });
    this.busy = true;
    const onAbort = () => {
      if (this.flavor === 'mt') this.client.notify('cancel');
      // The single-threaded worker is blocked inside the slice: stop it. The next slice starts
      // a fresh worker (the compiled module comes from the HTTP cache).
      else this.client.terminate(new SliceError({ code: 'CANCELLED', message: 'Canceled' }));
    };
    signal?.addEventListener('abort', onAbort);
    try {
      await this.client.start();
      // Files are copied (not transferred) so the caller keeps its buffers for the next slice.
      const r = await this.client.call('slice', { job }, onProgress);
      return {
        gcode: new Blob(brandGcode(r.gcode), { type: 'text/x.gcode' }),
        preview: r.preview,
        stats: r.stats,
        ms: r.ms,
        heapBytes: r.heapBytes,
      };
    } finally {
      signal?.removeEventListener('abort', onAbort);
      this.busy = false;
    }
  }

  gcodePreview(bytes: ArrayBuffer): Promise<EnginePreview> {
    if (this.busy) return Promise.reject(new SliceError({ code: 'INTERNAL', message: 'A slice is running' }));
    const read = this.reading
      .catch(() => {})
      .then(async () => {
        await this.client.start();
        return this.client.call('gcodePreview', { bytes });
      });
    this.reading = read;
    return read;
  }

  async dispose() {
    this.client.terminate();
  }
}
