// Support painting in the 3D view (desktop's GLGizmoFdmSupports and TriangleSelectorGUI): the
// painted triangles on each instance of the object, the overhangs highlighted, and the brush.
// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BufferAttribute,
  BufferGeometry,
  type Camera,
  Color,
  DoubleSide,
  Group,
  type Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  RingGeometry,
  SphereGeometry,
  Vector3,
} from 'three';

// Desktop's colors: enforcers, blockers (TriangleSelectorGUI), the fill tool's preview a quarter
// lighter (get_seed_fill_color) over the unpainted (GLVolume::NEUTRAL_COLOR), enforcers, blockers.
const GROUP_COLORS = [0x80ff80, 0xff8080, 0xffffff, 0xa0ffa0, 0xffa0a0];
/** The object while painting: desktop's neutral gray. */
export const NEUTRAL = new MeshStandardMaterial({ color: 0xcccccc, metalness: 0.05, roughness: 0.75, flatShading: true });
// The overhang highlight (mm_gouraud.fs): half LightRed over the color; faces on the bed LightBlue.
const LIGHT_RED = new Color(0.78, 0, 0),
  LIGHT_BLUE = new Color(0.73, 1, 1);
const EPSILON = 0.0001;

const surface = (color: number | Color, offset: number, extra: object = {}) =>
  new MeshStandardMaterial({
    color,
    metalness: 0.05,
    roughness: 0.75,
    flatShading: true,
    polygonOffset: true,
    polygonOffsetFactor: offset,
    polygonOffsetUnits: offset,
    ...extra,
  });

export class PaintLayer {
  readonly group = new Group();
  /** The paint by block of the object's triangles: a geometry per group (only blocks with paint). */
  private blocks = new Map<string, BufferGeometry[]>();
  private materials = GROUP_COLORS.map((c) => surface(c, -1));
  private overhangRed = surface(LIGHT_RED, -2, { transparent: true, opacity: 0.5, depthWrite: false });
  private overhangBlue = surface(LIGHT_BLUE, -2);
  private instances: Group[] = [];
  private overhangs: BufferGeometry[] = [];
  private cursor = new Group();
  private ring = new Mesh(
    new RingGeometry(0.92, 1, 64),
    new MeshBasicMaterial({ color: 0xffffff, side: DoubleSide, depthTest: false, transparent: true, opacity: 0.9 }),
  );
  private sphere = new Mesh(
    new SphereGeometry(1, 32, 16),
    new MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.25, depthWrite: false }),
  );

  constructor() {
    this.group.visible = false;
    this.cursor.visible = false;
    this.ring.renderOrder = 10;
    this.cursor.add(this.ring, this.sphere);
    this.group.add(this.cursor);
  }

  /** Painting on an object with these instances; the overhangs of its mesh as they stand. */
  show(base: BufferGeometry, instances: number[][], highlightLimit: number) {
    this.hide();
    this.group.visible = true;
    instances.forEach((m) => {
      const g = new Group();
      g.matrixAutoUpdate = false;
      g.matrix.fromArray(m);
      const red = new BufferGeometry(),
        blue = new BufferGeometry();
      this.overhangs.push(red, blue);
      const reds = new Mesh(red, this.overhangRed),
        blues = new Mesh(blue, this.overhangBlue);
      reds.frustumCulled = blues.frustumCulled = false;
      g.add(reds, blues);
      g.userData = { base, red, blue, blocks: new Map<string, Mesh[]>() };
      this.group.add(g);
      this.instances.push(g);
      for (const [key, geos] of this.blocks) this.addBlockMeshes(g, key, geos);
    });
    this.setHighlight(highlightLimit);
  }

  /** An instance's meshes of a block: flat shaded (no normals needed), never culled (no bounds to keep up). */
  private addBlockMeshes(g: Group, key: string, geos: BufferGeometry[]) {
    const meshes = geos.map((geo, i) => {
      const m = new Mesh(geo, this.materials[i]);
      m.frustumCulled = false;
      g.add(m);
      return m;
    });
    (g.userData.blocks as Map<string, Mesh[]>).set(key, meshes);
  }

  private removeBlock(key: string) {
    for (const g of this.instances) {
      const map = g.userData.blocks as Map<string, Mesh[]>;
      for (const m of map.get(key) ?? []) g.remove(m);
      map.delete(key);
    }
    for (const geo of this.blocks.get(key) ?? []) geo.dispose();
    this.blocks.delete(key);
  }

  /** No paint shown (painting ended). */
  clear() {
    for (const key of [...this.blocks.keys()]) this.removeBlock(key);
  }

  hide() {
    for (const g of this.instances) this.group.remove(g);
    for (const o of this.overhangs) o.dispose();
    this.instances = [];
    this.overhangs = [];
    this.group.visible = false;
    this.cursor.visible = false;
  }

  /** The paint of the blocks that changed (orca_paint_render, object coordinates). */
  setRender(r: { full: boolean; blocks: { key: string; groups: Float32Array[] }[] }) {
    if (r.full) this.clear();
    for (const { key, groups } of r.blocks) {
      if (groups.every((a) => a.length === 0)) {
        this.removeBlock(key);
        continue;
      }
      let geos = this.blocks.get(key);
      if (!geos) {
        geos = GROUP_COLORS.map(() => new BufferGeometry());
        this.blocks.set(key, geos);
        for (const g of this.instances) this.addBlockMeshes(g, key, geos);
      }
      groups.forEach((a, i) => geos![i]!.setAttribute('position', new BufferAttribute(a, 3)));
    }
  }

  /**
   * Desktop's overhang highlight (the slope view): faces that point down more steeply than the
   * limit, and those on the bed, for each instance as it stands. 0: none.
   */
  setHighlight(limitDeg: number) {
    const normalZ = -Math.cos((limitDeg * Math.PI) / 180);
    for (const g of this.instances) {
      const { base, red, blue } = g.userData as { base: BufferGeometry; red: BufferGeometry; blue: BufferGeometry };
      const [r, b] = limitDeg > 0 ? overhangs(base, g.matrix, normalZ) : [new Float32Array(), new Float32Array()];
      red.setAttribute('position', new BufferAttribute(r, 3));
      blue.setAttribute('position', new BufferAttribute(b, 3));
    }
  }

  /** The brush at a point of the surface (world): a ring facing the camera, or a sphere. */
  setCursor(at: { point: Vector3; radius: number; shape: 'circle' | 'sphere'; color: number } | null, camera: Camera) {
    this.cursor.visible = !!at;
    if (!at) return;
    this.cursor.position.copy(at.point);
    this.cursor.scale.setScalar(at.radius);
    this.cursor.quaternion.copy(camera.quaternion);
    this.ring.visible = at.shape === 'circle';
    this.sphere.visible = at.shape === 'sphere';
    (this.ring.material as MeshBasicMaterial).color.setHex(at.color);
    (this.sphere.material as MeshBasicMaterial).color.setHex(at.color);
  }

  dispose() {
    this.hide();
    this.clear();
    for (const m of [...this.materials, this.overhangRed, this.overhangBlue]) m.dispose();
  }
}

/** The faces of `base` (object coordinates) that are overhangs, and those on the bed, under `m`. */
export function overhangs(base: BufferGeometry, m: Matrix4, normalZ: number): [Float32Array, Float32Array] {
  const pos = base.getAttribute('position') as BufferAttribute;
  const index = base.getIndex();
  const n = index ? index.count : pos.count;
  const mirrored = m.determinant() < 0;
  const a = new Vector3(),
    b = new Vector3(),
    c = new Vector3(),
    wa = new Vector3(),
    wb = new Vector3(),
    wc = new Vector3(),
    nrm = new Vector3();
  const red: number[] = [],
    blue: number[] = [];
  for (let i = 0; i + 2 < n; i += 3) {
    const ia = index ? index.getX(i) : i,
      ib = index ? index.getX(i + 1) : i + 1,
      ic = index ? index.getX(i + 2) : i + 2;
    a.fromBufferAttribute(pos, ia);
    b.fromBufferAttribute(pos, ib);
    c.fromBufferAttribute(pos, ic);
    wa.copy(a).applyMatrix4(m);
    wb.copy(b).applyMatrix4(m);
    wc.copy(c).applyMatrix4(m);
    const out = Math.abs(wa.z) < 0.1 && Math.abs(wb.z) < 0.1 && Math.abs(wc.z) < 0.1 ? blue : null;
    nrm.subVectors(wb, wa).cross(new Vector3().subVectors(wc, wa));
    if (mirrored) nrm.negate();
    const len = nrm.length();
    const list = out ?? (len > 0 && nrm.z / len < normalZ - EPSILON ? red : null);
    if (list) list.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
  }
  return [new Float32Array(red), new Float32Array(blue)];
}
