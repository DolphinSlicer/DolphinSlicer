// Turns the engine's preview data into the renderer's segments off the main thread, and transfers
// the typed arrays back.
// SPDX-License-Identifier: AGPL-3.0-or-later
/// <reference lib="webworker" />
import { buildPreview, type PreviewData, type PreviewMeta } from './preview';

self.onmessage = (ev: MessageEvent<{ id: number; bin: ArrayBuffer; meta: PreviewMeta }>) => {
  const { id, bin, meta } = ev.data;
  try {
    const t0 = performance.now();
    const d: PreviewData = buildPreview(bin, meta);
    const ms = performance.now() - t0;
    const arrays = [
      d.seg,
      d.wh,
      d.role,
      d.layer,
      d.join,
      d.travel,
      d.travelLayer,
      d.layerSegStart,
      d.layerTravelStart,
      d.layerZ,
      d.layerGrey,
      d.path.end,
      d.path.t0,
      d.path.t1,
      d.path.ref,
      d.layerPathStart,
      d.layerPathTime,
      ...Object.values(d.values),
      ...Object.values(d.travelValues),
    ];
    (self as DedicatedWorkerGlobalScope).postMessage(
      { id, result: d, ms },
      arrays.map((a) => a.buffer as ArrayBuffer),
    );
  } catch (err) {
    postMessage({ id, error: String((err as Error)?.message ?? err) });
  }
};
