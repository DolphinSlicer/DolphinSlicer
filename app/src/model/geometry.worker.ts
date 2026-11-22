// Heavy geometry off the page's thread: auto orient and the sides for lay on face. Keeps the
// convex hulls of the last meshes it saw.
// SPDX-License-Identifier: AGPL-3.0-or-later
import { Matrix4, Vector3 } from 'three';
import type { GeometryRequest } from './geometryWorker';
import { convexHull, type Hull, type MeshData } from './hull';
import { layOnFacePlanes } from './layOnFace';
import { orientRotation } from './orient';

const hulls = new Map<string, Hull>();
function hullOf(key: string, mesh: MeshData): Hull {
  let h = hulls.get(key);
  if (h) {
    hulls.delete(key);
    hulls.set(key, h);
    return h;
  }
  h = convexHull(mesh);
  hulls.set(key, h);
  if (hulls.size > 16) hulls.delete(hulls.keys().next().value!);
  return h;
}

self.onmessage = (ev: MessageEvent<GeometryRequest>) => {
  const r = ev.data;
  try {
    const hull = hullOf(r.key, r.mesh);
    const linear = new Matrix4().fromArray(r.linear);
    if (r.op === 'orient') {
      const fan = r.fan ? new Vector3(...r.fan) : null;
      const m = orientRotation(r.mesh, hull, linear, { overhangAngle: r.overhangAngle, coolingDirection: fan });
      self.postMessage({ id: r.id, result: m.toArray() });
    } else {
      self.postMessage({ id: r.id, result: layOnFacePlanes(hull, linear) });
    }
  } catch (e) {
    self.postMessage({ id: r.id, error: String((e as Error)?.message ?? e) });
  }
};
