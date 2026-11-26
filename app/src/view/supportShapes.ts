// The meshes of support blockers and enforcers (desktop's generic shapes) as the engine makes
// them (orca_engine.cpp, generic_shape): centred on their origin, Z up.
// SPDX-License-Identifier: AGPL-3.0-or-later
import { BoxGeometry, type BufferGeometry, CylinderGeometry, SphereGeometry, TorusGeometry } from 'three';
import type { SupportShape } from '../engine/types';

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
