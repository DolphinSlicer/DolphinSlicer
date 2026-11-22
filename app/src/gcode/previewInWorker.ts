// SPDX-License-Identifier: AGPL-3.0-or-later
import type { EnginePreview } from '../engine/protocol';
import type { PreviewData } from './preview';

let worker: Worker | null = null;
let nextId = 1;

/** Build the preview's segments from the engine's data in a worker (reused; calls queue). The data's buffer is handed over. */
export function previewInWorker(p: EnginePreview): Promise<{ result: PreviewData; ms: number }> {
  worker ??= new Worker(new URL('./gcode.worker.ts', import.meta.url), { type: 'module', name: 'gcode-preview' });
  const w = worker;
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const onMsg = (ev: MessageEvent) => {
      const m = ev.data;
      if (m.id !== id) return;
      w.removeEventListener('message', onMsg);
      if (m.error) reject(new Error(m.error));
      else resolve({ result: m.result, ms: m.ms });
    };
    w.addEventListener('message', onMsg);
    w.postMessage({ id, bin: p.bin, meta: p.meta }, [p.bin]);
  });
}
