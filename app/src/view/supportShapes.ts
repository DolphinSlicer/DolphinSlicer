// The meshes of support blockers and enforcers (desktop's generic shapes) as the engine makes
// them (orca_engine.cpp, generic_shape): centred on their origin, Z up.
// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CylinderGeometry,
  Float32BufferAttribute,
  SphereGeometry,
  TorusGeometry,
} from 'three';
import type { SupportShape } from '../engine/types';
import type { SceneVolume } from '../state/store';

/** The meshes of support volumes a model came with, by key (copies of the object share them). */
const loaded = new Map<string, BufferGeometry>();
let nextMesh = 1;

/** Keep a model's own support volume mesh (its coordinates); returns its key. */
export function registerSupportMesh(positions: number[], indices: number[]): string {
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(positions, 3));
  // No normals: the material is flat shaded (each triangle's own, from the screen).
  g.setIndex(new BufferAttribute(Uint32Array.from(indices), 1));
  const key = `m${nextMesh++}`;
  loaded.set(key, g);
  return key;
}

/** A support volume's mesh: its generic shape, or the one the model came with. */
export function volumeGeometry(v: SceneVolume): BufferGeometry {
  return v.shape === 'mesh' ? (loaded.get(v.mesh ?? '') ?? new BufferGeometry()) : supportShapeGeometry(v.shape, v.size);
}

const cache = new Map<string, BufferGeometry>();

export function supportShapeGeometry(shape: SupportShape, size: number[]): BufferGeometry {
  const key = `${shape}:${size.join(',')}`;
  let g = cache.get(key);
  if (g) return g;
  const [a = 1, b = 1, c = 1] = size;
  switch (shape) {
    case 'cube':
      g = new BoxGeometry(a, b, c);
      break;
    case 'sphere':
      g = new SphereGeometry(a / 2, 48, 24);
      break;
    case 'torus':
      // In the XY plane, as its_make_torus.
      g = new TorusGeometry(a / 2 + b / 2, b / 2, 24, 64);
      break;
    case 'cone':
      // three.js builds along Y: turned so the tip points up (Z).
      g = new CylinderGeometry(0, a / 2, b, 64).rotateX(Math.PI / 2);
      break;
    default:
      g = new CylinderGeometry(a / 2, a / 2, b, 64).rotateX(Math.PI / 2);
  }
  if (cache.size > 64) cache.clear();
  cache.set(key, g);
  return g;
}
