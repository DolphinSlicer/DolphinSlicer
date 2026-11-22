// G-code preview mesh: one instanced draw call for all extrusion segments. Each instance is a
// segment (start, end, width, height, role, color, layer); the vertex shader builds its geometry, so the
// GPU holds ~40 bytes per segment and the CPU does no per-frame work.
// Layer range and feature visibility are uniforms; segments above the top layer are not drawn
// at all (instanceCount), segments below the bottom layer are collapsed in the shader.
// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  InstancedInterleavedBuffer,
  InterleavedBufferAttribute,
  LineSegments,
  Mesh,
  ShaderMaterial,
  Sphere,
  Vector3,
} from 'three';
import { autoView, colorize, SPEED_VIEWS, type ViewType } from '../gcode/colors';
import { ROLES } from '../gcode/parse';
import type { PreviewData } from '../gcode/preview';

// Segment rendering ported from OrcaSlicer's libvgcode (src/libvgcode/src/ShadersES.hpp,
// Segments_Vertex_Shader_ES, and SegmentTemplate.cpp; Copyright (c) Prusa Research 2023 Enrico Turri,
// Pavel Mikuš, with OrcaSlicer changes; AGPL-3.0-or-later like this project), so the preview looks
// like the desktop one:
// - every segment is the same 8-vertex template (a body and a spike at each end);
// - the vertex shader turns it into the side or the top of the extrusion box, whichever faces the
//   camera more, and the end spikes fill the outside of a turn from the turning angle at the joint
//   (or form a pointed cap where the path ends);
// - lighting is per vertex (Gouraud) with libvgcode's lights: a top light and a front light fixed
//   relative to the camera, a top specular highlight, ambient 0.3 and emission 0.15.
// Differences: positions and sizes come from per-instance attributes instead of textures (one
// width/height per segment), and the turning angle from the neighbour directions the parser
// records. The libvgcode "realistic view" (shadow map, gloss, translucency) is not ported.
const VERT = /* glsl */ `
attribute float vid;          // template vertex id 0..7 (0-3 at the start, 4-7 at the end)
attribute vec3 iStart;
attribute vec3 iEnd;
attribute vec2 iWH;           // width, height
attribute float iRole;
attribute vec3 iColor;        // the segment's color in the current view
attribute float iLayer;
attribute vec3 iPrev;         // direction of the previous segment on the path, or 0
attribute vec3 iNext;         // direction of the next segment on the path, or 0
uniform float roleVisible[${ROLES.length}];
uniform vec2 layerRange;
varying vec3 vColor;

const vec3  light_top_dir = vec3(-0.4574957, 0.4574957, 0.7624929);
const float light_top_diffuse = 0.6 * 0.8;
const float light_top_specular = 0.6 * 0.25;
const float light_top_shininess = 20.0;
const vec3  light_front_dir = vec3(0.6985074, 0.1397015, 0.6985074);
const float light_front_diffuse = 0.6 * 0.3;
const float ambient = 0.3;
const float emission = 0.15;
const vec3 UP = vec3(0.0, 0.0, 1.0);

float direct_lighting(vec3 eye_position, vec3 eye_normal) {
  float top_diffuse = light_top_diffuse * max(dot(eye_normal, light_top_dir), 0.0);
  float front_diffuse = light_front_diffuse * max(dot(eye_normal, light_front_dir), 0.0);
  float top_specular = light_top_specular * pow(max(dot(-normalize(eye_position), reflect(-light_top_dir, eye_normal)), 0.0), light_top_shininess);
  return top_diffuse + front_diffuse + top_specular;
}

// Signed turning angle at a joint (libvgcode's height_width_angle.z), 0 where the path ends.
float turn(vec3 into, vec3 onto) {
  if (dot(into, into) < 0.25) return 0.0;
  return atan(into.x * onto.y - into.y * onto.x, dot(into, onto));
}

void main() {
  int r = int(iRole + 0.5);
  if (iLayer < layerRange.x || iLayer > layerRange.y || roleVisible[r] < 0.5) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);   // outside the clip volume: culled
    vColor = vec3(0.0);
    return;
  }
  int vertex_id = int(vid + 0.5);
  // The bead's centre line runs half a layer below the nozzle (the G-code position).
  vec3 pos_a = iStart - vec3(0.0, 0.0, 0.5 * iWH.y);
  vec3 pos_b = iEnd - vec3(0.0, 0.0, 0.5 * iWH.y);
  vec3 line = pos_b - pos_a;
  float line_len = length(line);
  vec3 line_dir = line_len < 1e-4 ? vec3(1.0, 0.0, 0.0) : line / line_len;
  vec3 line_right_dir;
  if (abs(dot(line_dir, UP)) > 0.9)
    line_right_dir = normalize(cross(vec3(1.0, 0.0, 0.0), line_dir));
  else
    line_right_dir = normalize(cross(line_dir, UP));
  vec3 line_up_dir = normalize(cross(line_right_dir, line_dir));

  const vec2 signs_array[16] = vec2[](
    // horizontal view (from right)
    vec2(1.0, 0.0), vec2(0.0, 1.0), vec2(0.0, 0.0), vec2(0.0, -1.0),
    vec2(0.0, -1.0), vec2(1.0, 0.0), vec2(0.0, 1.0), vec2(0.0, 0.0),
    // vertical view (from top)
    vec2(0.0, 1.0), vec2(-1.0, 0.0), vec2(0.0, 0.0), vec2(1.0, 0.0),
    vec2(1.0, 0.0), vec2(0.0, 1.0), vec2(-1.0, 0.0), vec2(0.0, 0.0));

  bool at_a = vertex_id < 4;
  vec3 endpoint_pos = at_a ? pos_a : pos_b;
  float angle = at_a ? turn(iPrev, line_dir) : turn(line_dir, iNext);
  float height = iWH.y, width = iWH.x;

  vec3 closer_pos = dot(cameraPosition - pos_a, cameraPosition - pos_a) < dot(cameraPosition - pos_b, cameraPosition - pos_b) ? pos_a : pos_b;
  vec3 camera_view_dir = normalize(closer_pos - cameraPosition);
  vec3 diagonal_dir_border = normalize(height * line_up_dir + width * line_right_dir);
  bool is_vertical_view = abs(dot(camera_view_dir, line_up_dir)) / abs(dot(diagonal_dir_border, line_up_dir)) >
    abs(dot(camera_view_dir, line_right_dir)) / abs(dot(diagonal_dir_border, line_right_dir));
  vec2 signs = signs_array[vertex_id + 8 * int(is_vertical_view)];
  float view_right_sign = sign(dot(-camera_view_dir, line_right_dir));
  float view_top_sign = sign(dot(-camera_view_dir, line_up_dir));
  float half_height = 0.5 * height;
  float half_width = 0.5 * width;
  vec3 horizontal_dir = half_width * line_right_dir;
  vec3 vertical_dir = half_height * line_up_dir;
  vec3 pos = endpoint_pos + signs.x * view_right_sign * horizontal_dir + signs.y * view_top_sign * vertical_dir;
  if (vertex_id == 2 || vertex_id == 7) {
    float line_dir_sign = vertex_id == 2 ? -1.0 : 1.0;
    if (angle == 0.0) {
      // Pointed cap where the path does not continue (or continues straight on).
      pos += line_dir_sign * line_dir * half_width;
    } else {
      pos += line_dir_sign * line_dir * half_width * sin(abs(angle) * 0.5);
      pos += sign(angle) * horizontal_dir * cos(abs(angle) * 0.5);
    }
  }
  vec3 eye_position = (viewMatrix * vec4(pos, 1.0)).xyz;
  vec3 eye_normal = (viewMatrix * vec4(normalize(pos - endpoint_pos), 0.0)).xyz;
  vec3 color_base = iColor;
  vColor = color_base * (ambient + emission) + color_base * direct_lighting(eye_position, eye_normal);
  gl_Position = projectionMatrix * vec4(eye_position, 1.0);
}`;

const FRAG = /* glsl */ `
varying vec3 vColor;
void main() {
  gl_FragColor = vec4(vColor, 1.0);
}`;

const TRAVEL_VERT = /* glsl */ `
attribute float aLayer;
attribute vec3 aColor;
uniform vec2 layerRange;
varying vec3 vColor;
void main() {
  vColor = aColor;
  if (aLayer < layerRange.x || aLayer > layerRange.y) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const TRAVEL_FRAG = /* glsl */ `varying vec3 vColor; void main() { gl_FragColor = vec4(vColor, 1.0); }`;

function segmentGeometry(): BufferGeometry {
  // libvgcode SegmentTemplate: 8 vertices (ids), 8 triangles.
  const g = new BufferGeometry();
  g.setAttribute('vid', new Float32BufferAttribute([0, 1, 2, 3, 4, 5, 6, 7], 1));
  // three.js needs a position attribute for bookkeeping; the shader ignores it.
  g.setAttribute('position', new Float32BufferAttribute(new Array(24).fill(0), 3));
  g.setIndex([
    0,
    1,
    2,
    0,
    2,
    3, // front spike
    0,
    3,
    4,
    0,
    4,
    5, // right/bottom body
    0,
    5,
    6,
    0,
    6,
    1, // left/top body
    5,
    4,
    7,
    5,
    7,
    6, // back spike
  ]);
  return g;
}

/** A color per travel move, for both ends of its line. */
function lineColors(c: Uint8Array, n: number): Uint8Array {
  const out = new Uint8Array(n * 6);
  for (let i = 0; i < n; i++) for (let j = 0; j < 3; j++) out[i * 6 + j] = out[i * 6 + 3 + j] = c[i * 3 + j]!;
  return out;
}

const ROLE_CUSTOM = ROLES.indexOf('Custom');

export class GcodeLayer {
  readonly group = new Group();
  private mesh: Mesh<InstancedBufferGeometry, ShaderMaterial> | null = null;
  private travel: LineSegments<BufferGeometry, ShaderMaterial> | null = null;
  private data: PreviewData | null = null;
  readonly roleVisible = new Float32Array(ROLES.length).fill(1);
  private range: [number, number] = [0, 0];
  showTravel = false;
  /** The color view (desktop's view type). */
  view: ViewType = 'feature';
  /** Desktop's automatic view is applied again only when it would change (a view picked by hand survives a new slice). */
  private autoFor = '';

  set(data: PreviewData | null) {
    this.dispose();
    this.data = data;
    if (!data || data.segCount === 0) return;
    const auto = autoView(data);
    if (auto !== this.autoFor) {
      this.autoFor = auto;
      this.view = auto;
    }
    const colors = this.colors();
    const geo = new InstancedBufferGeometry();
    const base = segmentGeometry();
    geo.index = base.index;
    geo.setAttribute('vid', base.getAttribute('vid'));
    geo.setAttribute('position', base.getAttribute('position'));
    const seg = new InstancedInterleavedBuffer(data.seg, 6, 1);
    geo.setAttribute('iStart', new InterleavedBufferAttribute(seg, 3, 0));
    geo.setAttribute('iEnd', new InterleavedBufferAttribute(seg, 3, 3));
    geo.setAttribute('iWH', new InstancedBufferAttribute(data.wh, 2));
    const join = new InstancedInterleavedBuffer(data.join, 6, 1);
    geo.setAttribute('iPrev', new InterleavedBufferAttribute(join, 3, 0, true));
    geo.setAttribute('iNext', new InterleavedBufferAttribute(join, 3, 3, true));
    // Shader output is not colour-managed: the colors are used as sRGB directly.
    // Float attributes for role/layer: WebGL1-safe, and exact for layer counts < 2^24.
    geo.setAttribute('iRole', new InstancedBufferAttribute(Float32Array.from(data.role), 1));
    geo.setAttribute('iColor', new InstancedBufferAttribute(colors.seg, 3, true));
    geo.setAttribute('iLayer', new InstancedBufferAttribute(Float32Array.from(data.layer), 1));
    geo.instanceCount = data.segCount;
    const [mn, mx] = [new Vector3(...data.bbox.min), new Vector3(...data.bbox.max)];
    geo.boundingSphere = new Sphere(mn.clone().add(mx).multiplyScalar(0.5), mn.distanceTo(mx) / 2 + 1);
    const mat = new ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      side: DoubleSide, // libvgcode draws segments with face culling off (ViewerImpl.cpp)
      uniforms: {
        roleVisible: { value: this.roleVisible },
        layerRange: { value: [0, data.layerCount - 1] },
      },
    });
    this.mesh = new Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.group.add(this.mesh);

    if (data.travelCount) {
      const tg = new BufferGeometry();
      tg.setAttribute('position', new BufferAttribute(data.travel, 3));
      const tl = new Float32Array(data.travelCount * 2);
      for (let i = 0; i < data.travelCount; i++) tl[2 * i] = tl[2 * i + 1] = data.travelLayer[i]!;
      tg.setAttribute('aLayer', new BufferAttribute(tl, 1));
      tg.setAttribute('aColor', new BufferAttribute(lineColors(colors.travel, data.travelCount), 3, true));
      const tm = new ShaderMaterial({
        vertexShader: TRAVEL_VERT,
        fragmentShader: TRAVEL_FRAG,
        uniforms: { layerRange: mat.uniforms.layerRange! },
      });
      this.travel = new LineSegments(tg, tm);
      this.travel.frustumCulled = false;
      this.travel.visible = this.showTravel;
      this.group.add(this.travel);
    }
    this.setRange(0, data.layerCount - 1);
  }

  private colors() {
    return colorize(this.data!, this.view, { travel: this.showTravel, custom: this.roleVisible[ROLE_CUSTOM] !== 0 });
  }

  /** Color the segments as another view does. */
  setView(view: ViewType) {
    this.view = view;
    this.recolor();
  }

  private recolor() {
    if (!this.data?.segCount) return;
    const colors = this.colors();
    if (this.mesh) {
      const a = this.mesh.geometry.getAttribute('iColor') as InstancedBufferAttribute;
      (a.array as Uint8Array).set(colors.seg);
      a.needsUpdate = true;
    }
    if (this.travel) {
      const a = this.travel.geometry.getAttribute('aColor') as BufferAttribute;
      (a.array as Uint8Array).set(lineColors(colors.travel, this.data?.travelCount ?? 0));
      a.needsUpdate = true;
    }
  }

  /** Show layers lo..hi (inclusive, 0-based). */
  setRange(lo: number, hi: number) {
    const d = this.data;
    if (!d || !this.mesh) return;
    hi = Math.max(0, Math.min(d.layerCount - 1, hi));
    lo = Math.max(0, Math.min(hi, lo));
    this.range = [lo, hi];
    (this.mesh.material.uniforms.layerRange!.value as number[])[0] = lo;
    (this.mesh.material.uniforms.layerRange!.value as number[])[1] = hi;
    // Nothing above the top layer is submitted to the GPU.
    this.mesh.geometry.instanceCount = d.layerSegStart[hi + 1]!;
    if (this.travel) this.travel.geometry.setDrawRange(0, d.layerTravelStart[hi + 1]! * 2);
  }

  get layerRange() {
    return this.range;
  }

  setRoleVisible(role: number, visible: boolean) {
    this.roleVisible[role] = visible ? 1 : 0;
    // Width and flow ranges leave out hidden custom G-code.
    if (role === ROLE_CUSTOM && (this.view === 'width' || this.view === 'flow' || this.view === 'actualFlow')) this.recolor();
  }

  setTravel(visible: boolean) {
    this.showTravel = visible;
    // The speed views' ranges take in the travel moves when they are shown.
    if (SPEED_VIEWS.has(this.view)) this.recolor();
    if (this.travel) this.travel.visible = visible;
  }

  dispose() {
    for (const o of [this.mesh, this.travel]) {
      if (!o) continue;
      this.group.remove(o);
      o.geometry.dispose();
      o.material.dispose();
    }
    this.mesh = null;
    this.travel = null;
    this.data = null;
  }
}
