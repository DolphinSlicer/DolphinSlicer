// The thumbnails written into the G-code, which printers (Mainsail, Fluidd, screens) show. Desktop
// renders them with OpenGL (GLCanvas3D::render_thumbnail_internal); the engine has no OpenGL,
// so they are rendered here the same way and handed to the engine with the slice job:
// the objects on the plate only, in their filament color, lit like desktop's gouraud_light shader,
// from desktop's default view with an orthographic camera fitted to them, on a transparent
// background. RGBA, bottom row first, as glReadPixels gives it.
// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  Box3,
  type BufferGeometry,
  Color,
  GLSL3,
  LinearSRGBColorSpace,
  Matrix4,
  Mesh,
  OrthographicCamera,
  Scene,
  ShaderMaterial,
  Vector3,
  WebGLRenderer,
} from 'three';
import type { Mat4, Thumbnail } from '../engine/types';

/** The sizes in the printer's "thumbnails" setting, e.g. "32x32/PNG, 300x300/PNG". */
export function thumbnailSizes(setting: string): { width: number; height: number }[] {
  const sizes: { width: number; height: number }[] = [];
  for (const item of setting.split(',')) {
    // As desktop (GCodeThumbnails::make_and_check_thumbnail_list): "WxH/FORMAT"; the engine
    // checks the setting and reports a bad one.
    const m = /^\s*(\d+(?:\.\d+)?)\s*x\s*(\d+(?:\.\d+)?)/i.exec(item);
    if (!m) continue;
    const width = Math.round(Number(m[1])),
      height = Math.round(Number(m[2]));
    if (width < 1 || height < 1 || width > 2048 || height > 2048) continue;
    if (!sizes.some((s) => s.width === width && s.height === height)) sizes.push({ width, height });
  }
  return sizes;
}

// gouraud_light.vs/.fs: two lights fixed to the camera, ambient, a specular highlight, and the
// emission factor render_thumbnail_internal sets (0.1). Face normals, as the meshes' facets.
const material = () =>
  new ShaderMaterial({
    glslVersion: GLSL3,
    uniforms: { color: { value: new Color() } },
    vertexShader: `
    out vec3 eyePos;
    void main() {
      vec4 p = modelViewMatrix * vec4(position, 1.0);
      eyePos = p.xyz;
      gl_Position = projectionMatrix * p;
    }`,
    fragmentShader: `
    precision highp float;
    uniform vec3 color;
    in vec3 eyePos;
    out vec4 outColor;
    const vec3 LIGHT_TOP_DIR = vec3(-0.4574957, 0.4574957, 0.7624929);
    const vec3 LIGHT_FRONT_DIR = vec3(0.6985074, 0.1397015, 0.6985074);
    void main() {
      vec3 n = normalize(cross(dFdx(eyePos), dFdy(eyePos)));
      float d = 0.3 + max(dot(n, LIGHT_TOP_DIR), 0.0) * 0.8 * 0.6 + max(dot(n, LIGHT_FRONT_DIR), 0.0) * 0.3 * 0.6;
      float s = 0.125 * 0.6 * pow(max(dot(-normalize(eyePos), reflect(-LIGHT_TOP_DIR, n)), 0.0), 20.0);
      outColor = vec4(vec3(s) + color * (d + 0.1), 1.0);
    }`,
  });

let renderer: WebGLRenderer | null | undefined;
function getRenderer(): WebGLRenderer | null {
  if (renderer !== undefined) return renderer;
  try {
    // Not premultiplied: read back, the edges keep their color and only lose opacity.
    renderer = new WebGLRenderer({
      canvas: document.createElement('canvas'),
      antialias: true,
      alpha: true,
      premultipliedAlpha: false,
      preserveDrawingBuffer: true,
    });
    renderer.setClearColor(0x000000, 0);
    // Desktop shades in the color's own values: no conversion to and from linear.
    renderer.outputColorSpace = LinearSRGBColorSpace;
  } catch {
    renderer = null; // No WebGL: the G-code has no thumbnails.
  }
  return renderer;
}

/** Desktop's adjust_color_for_rendering: near-black is lifted so the shading shows. */
function filamentColor(hex: string | undefined): Color {
  const c = new Color();
  const m = /^#?([0-9a-f]{6})/i.exec(hex ?? '');
  c.setHex(m ? parseInt(m[1]!, 16) : 0x00ae42, LinearSRGBColorSpace);
  if (c.r < 0.2 && c.g < 0.2 && c.b < 0.2) c.setRGB(0.2, 0.2, 0.2, LinearSRGBColorSpace);
  return c;
}

export function renderGcodeThumbnails(
  objects: { geometry: BufferGeometry; matrix: Mat4 }[],
  sizes: { width: number; height: number }[],
  colour: string | undefined,
): Thumbnail[] {
  const r = sizes.length && objects.length ? getRenderer() : null;
  if (!r) return [];
  const mat = material();
  mat.uniforms.color!.value = filamentColor(colour);
  const scene = new Scene();
  const box = new Box3();
  for (const o of objects) {
    const mesh = new Mesh(o.geometry, mat);
    mesh.matrixAutoUpdate = false;
    mesh.matrix.copy(new Matrix4().fromArray(o.matrix));
    mesh.updateMatrixWorld(true);
    box.expandByObject(mesh);
    scene.add(mesh);
  }
  if (box.isEmpty()) {
    mat.dispose();
    return [];
  }
  // Camera::set_default_orientation: 45° from above, from the front left, Z up.
  const center = box.getCenter(new Vector3());
  const radius = Math.max(box.getSize(new Vector3()).length(), 1);
  const s = Math.sin(-Math.PI / 4);
  const dir = new Vector3(s * Math.sin(Math.PI / 4), s * Math.cos(Math.PI / 4), Math.cos(-Math.PI / 4)).normalize();
  const camera = new OrthographicCamera();
  camera.up.set(0, 0, 1);
  camera.position.copy(center).addScaledVector(dir, radius * 2);
  camera.lookAt(center);
  camera.updateMatrixWorld(true);
  // Camera::zoom_to_box: the box's corners fill the view, with a 2.5% margin.
  const view = camera.matrixWorldInverse;
  let hx = 0,
    hy = 0;
  for (let i = 0; i < 8; i++) {
    const p = new Vector3(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).applyMatrix4(view);
    hx = Math.max(hx, Math.abs(p.x));
    hy = Math.max(hy, Math.abs(p.y));
  }
  camera.near = radius * 0.05;
  camera.far = radius * 6;

  const out: Thumbnail[] = [];
  const gl = r.getContext();
  for (const { width, height } of sizes) {
    r.setSize(width, height, false);
    const zoom = Math.min(width / (2 * hx * 1.025), height / (2 * hy * 1.025));
    camera.left = -width / 2 / zoom;
    camera.right = width / 2 / zoom;
    camera.bottom = -height / 2 / zoom;
    camera.top = height / 2 / zoom;
    camera.updateProjectionMatrix();
    r.render(scene, camera);
    const rgba = new Uint8Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
    out.push({ width, height, rgba });
  }
  mat.dispose();
  return out;
}
