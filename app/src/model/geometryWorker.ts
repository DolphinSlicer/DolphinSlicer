// The geometry worker (geometry.worker.ts): auto orient and lay-on-face sides, without
// freezing the page on large meshes. Calls queue in one worker.
// SPDX-License-Identifier: AGPL-3.0-or-later
import { type BufferAttribute, type BufferGeometry, Matrix4 } from 'three';
import type { MeshData } from './hull';
import type { FacePlane } from './layOnFace';

export type GeometryRequest = { id: number; key: string; mesh: MeshData; linear: number[] } & (
  | { op: 'orient'; overhangAngle: number; fan: [number, number, number] | null }
  | { op: 'planes' }
);

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

type WithoutId<T> = T extends unknown ? Omit<T, 'id'> : never;

function call<T>(req: WithoutId<GeometryRequest>): Promise<T> {
  if (!worker) {
    worker = new Worker(new URL('./geometry.worker.ts', import.meta.url), { type: 'module', name: 'geometry' });
    worker.onmessage = (ev) => {
      const m = ev.data as { id: number; result?: unknown; error?: string };
      const p = pending.get(m.id);
      pending.delete(m.id);
      if (m.error !== undefined) p?.reject(new Error(m.error));
      else p?.resolve(m.result);
    };
  }
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    worker!.postMessage({ ...req, id });
  });
}

/** The mesh's triangles, copied for the worker; `key` names it for the worker's hull cache. */
function meshOf(g: BufferGeometry): { key: string; mesh: MeshData } {
  const pos = g.getAttribute('position') as BufferAttribute,
    idx = g.getIndex();
  return { key: g.uuid, mesh: { positions: pos.array as Float32Array, index: idx ? (idx.array as Uint32Array) : null } };
}

/** Auto orient's rotation for a mesh shown under `linear` (premultiply it). */
export async function orientInWorker(
  g: BufferGeometry,
  linear: Matrix4,
  overhangAngle: number,
  fan: [number, number, number] | null,
): Promise<Matrix4> {
  const r = await call<number[]>({ op: 'orient', ...meshOf(g), linear: linear.toArray(), overhangAngle, fan });
  return new Matrix4().fromArray(r);
}

/** The sides a mesh shown under `linear` can be laid on. */
export function planesInWorker(g: BufferGeometry, linear: Matrix4): Promise<FacePlane[]> {
  return call<FacePlane[]>({ op: 'planes', ...meshOf(g), linear: linear.toArray() });
}
