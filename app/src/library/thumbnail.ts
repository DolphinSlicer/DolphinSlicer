// Library thumbnails: the model's objects rendered from the front-right, above, with a
// transparent background (it sits on the card's color in both themes). Small WebP (PNG where
// the browser can't encode WebP), kept in the library index so listing needs no model files.
// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  AmbientLight,
  Box3,
  type BufferGeometry,
  DirectionalLight,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  Scene,
  Vector3,
  WebGLRenderer,
} from 'three';
import type { Mat4 } from '../engine/types';

export const THUMB_SIZE = 192;

let renderer: WebGLRenderer | null | undefined;
function getRenderer(): WebGLRenderer | null {
  if (renderer !== undefined) return renderer;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = THUMB_SIZE;
    renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
    renderer.setClearColor(0x000000, 0);
  } catch {
    renderer = null; // No WebGL: cards show an icon instead.
  }
  return renderer;
}

/** A data URL, or '' when it can't be drawn. */
export function renderThumbnail(objects: { geometry: BufferGeometry; matrix: Mat4 }[]): string {
  const r = getRenderer();
  if (!r || !objects.length) return '';
  const scene = new Scene();
  const material = new MeshStandardMaterial({ color: 0x4a9bd1, metalness: 0.05, roughness: 0.75, flatShading: true });
  const box = new Box3();
  for (const o of objects) {
    const mesh = new Mesh(o.geometry, material);
    mesh.matrixAutoUpdate = false;
    mesh.matrix.copy(new Matrix4().fromArray(o.matrix));
    mesh.updateMatrixWorld(true);
    box.expandByObject(mesh);
    scene.add(mesh);
  }
  if (box.isEmpty()) return '';
  scene.add(new AmbientLight(0xffffff, 0.55));
  const key = new DirectionalLight(0xffffff, 2.2);
  key.position.set(1, -2, 3);
  scene.add(key);
  const fill = new DirectionalLight(0xffffff, 0.8);
  fill.position.set(-2, 1, 1);
  scene.add(fill);

  const center = box.getCenter(new Vector3());
  const radius = Math.max(box.getSize(new Vector3()).length() / 2, 1e-3);
  const camera = new PerspectiveCamera(30, 1, radius / 100, radius * 100);
  camera.up.set(0, 0, 1);
  const dir = new Vector3(1, -1.4, 1).normalize();
  const dist = (radius / Math.sin((camera.fov * Math.PI) / 360)) * 1.02;
  camera.position.copy(center).addScaledVector(dir, dist);
  camera.lookAt(center);
  r.render(scene, camera);
  material.dispose();
  const canvas = r.domElement;
  const webp = canvas.toDataURL('image/webp', 0.85);
  return webp.startsWith('data:image/webp') ? webp : canvas.toDataURL('image/png');
}
