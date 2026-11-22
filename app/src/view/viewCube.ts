// The view cube: a small cube in the lower left corner of the 3D view that turns with the camera,
// as CAD programs have it. Its sides are named; a click on a side, an edge or a corner looks at
// the plate from there, and dragging it turns the view. The X/Y/Z axes run along its edges from
// the front-left-bottom corner, in the bed's colors, with arrowheads.
// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BoxGeometry,
  BufferGeometry,
  type Camera,
  CanvasTexture,
  ConeGeometry,
  CylinderGeometry,
  Float32BufferAttribute,
  Group,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  OrthographicCamera,
  Raycaster,
  Scene,
  SRGBColorSpace,
  Vector2,
  Vector3,
  type WebGLRenderer,
} from 'three';

export type CubeSide = 'top' | 'bottom' | 'front' | 'rear' | 'left' | 'right';
export type CubeLabels = Record<CubeSide, string>;

// BoxGeometry's material order (+X, −X, +Y, −Y, +Z, −Z) in its own Y-up frame, turned so +Y is
// up (+Z) and +Z is the front (−Y): right, left, top, bottom, front, rear.
const SIDES: CubeSide[] = ['right', 'left', 'top', 'bottom', 'front', 'rear'];
const LOOK = {
  light: { face: '#e9edf2', text: '#3d4450', edge: 0x8b95a3, hover: 0x3b82f6 },
  dark: { face: '#353b45', text: '#e1e5eb', edge: 0x6b7484, hover: 0x60a5fa },
};
/** How far into a side its edges and corners reach (the cube is 1 across). */
const BAND = 0.22;

export class ViewCube {
  /** Size and distance from the canvas' lower left corner, in CSS pixels. */
  size = 110;
  left = 8;
  bottom = 8;
  private scene = new Scene();
  private camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  private cube: Mesh<BoxGeometry, MeshBasicMaterial[]>;
  private edges: LineSegments;
  private highlight: Mesh<BoxGeometry, MeshBasicMaterial>;
  private ray = new Raycaster();
  private labels: CubeLabels = { top: 'Top', bottom: 'Bottom', front: 'Front', rear: 'Rear', left: 'Left', right: 'Right' };
  private dark = false;
  private hovered = '';
  private anisotropy = 1;

  constructor() {
    this.cube = new Mesh(
      new BoxGeometry(1, 1, 1),
      SIDES.map(() => new MeshBasicMaterial({ transparent: true, opacity: 0.88, depthWrite: false })),
    );
    this.cube.rotation.x = Math.PI / 2;
    const h = 0.5;
    const e: number[] = [];
    for (const a of [-h, h]) for (const b of [-h, h]) e.push(-h, a, b, h, a, b, a, -h, b, a, h, b, a, b, -h, a, b, h);
    this.edges = new LineSegments(new BufferGeometry(), new LineBasicMaterial({ color: LOOK.light.edge }));
    this.edges.geometry.setAttribute('position', new Float32BufferAttribute(e, 3));
    // The hovered side, edge or corner: a patch just over the cube's surface.
    this.highlight = new Mesh(
      new BoxGeometry(1, 1, 1),
      new MeshBasicMaterial({ color: LOOK.light.hover, transparent: true, opacity: 0.45, depthWrite: false }),
    );
    this.highlight.visible = false;
    this.highlight.renderOrder = 1;
    // The axes: along the edges from the front-left-bottom corner to a little past the cube.
    const axes = new Group();
    const LEN = 1.18,
      HEAD = 0.16,
      R = 0.022;
    for (const [color, dir] of [
      [0xd92b2b, new Vector3(1, 0, 0)],
      [0x2bb32b, new Vector3(0, 1, 0)],
      [0x2b4fd9, new Vector3(0, 0, 1)],
    ] as const) {
      const mat = new MeshBasicMaterial({ color });
      const shaft = new Mesh(new CylinderGeometry(R, R, LEN - HEAD, 8), mat);
      const tip = new Mesh(new ConeGeometry(R * 3, HEAD, 12), mat);
      shaft.position.copy(dir).multiplyScalar((LEN - HEAD) / 2);
      tip.position.copy(dir).multiplyScalar(LEN - HEAD / 2);
      for (const m of [shaft, tip]) {
        m.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), dir);
        axes.add(m);
      }
    }
    axes.position.set(-h, -h, -h);
    this.scene.add(this.cube, this.edges, this.highlight, axes);
    // Everything fades together (see setActive).
    this.scene.traverse((o) => {
      for (const m of [(o as Mesh).material].flat()) {
        if (!m) continue;
        const mat = m as MeshBasicMaterial;
        mat.transparent = true;
        this.parts.push({ m: mat, base: mat.opacity });
      }
    });
    for (const p of this.parts) p.m.opacity = p.base * this.fade;
    this.paint();
  }

  /**
   * The whole cube (sides, edges, axes) fades: faint while the pointer is elsewhere, solid on it,
   * over 0.15 s. `fade` runs from IDLE to 1; each part's own opacity is scaled by it.
   */
  static readonly IDLE = 0.4;
  private fade = ViewCube.IDLE;
  private fadeTo = ViewCube.IDLE;
  private fadeAt = 0;
  private parts: { m: MeshBasicMaterial | LineBasicMaterial; base: number }[] = [];
  /** Whether the pointer is on the cube. Returns whether a fade started. */
  setActive(on: boolean): boolean {
    const to = on ? 1 : ViewCube.IDLE;
    if (to === this.fadeTo) return false;
    this.fadeTo = to;
    this.fadeAt = 0;
    return true;
  }
  /** Advance the fade to `now` (ms); true while it still runs. */
  step(now: number): boolean {
    const dt = this.fadeAt ? now - this.fadeAt : 16;
    this.fadeAt = now;
    const k = Math.min(1, dt / 150) * (1 - ViewCube.IDLE);
    this.fade = this.fadeTo > this.fade ? Math.min(this.fadeTo, this.fade + k) : Math.max(this.fadeTo, this.fade - k);
    for (const p of this.parts) p.m.opacity = p.base * this.fade;
    return this.fade !== this.fadeTo;
  }

  setLabels(labels: CubeLabels) {
    this.labels = labels;
    this.paint();
  }
  setDark(dark: boolean) {
    this.dark = dark;
    this.paint();
  }

  /** Draw each side's name onto its own texture. */
  private paint() {
    const look = this.dark ? LOOK.dark : LOOK.light;
    (this.edges.material as LineBasicMaterial).color.set(look.edge);
    this.highlight.material.color.set(look.hover);
    this.cube.material.forEach((m, i) => {
      // Large enough for a sharp side on high-density screens.
      const N = 512;
      const c = document.createElement('canvas');
      c.width = c.height = N;
      const g = c.getContext('2d')!;
      g.fillStyle = look.face;
      g.fillRect(0, 0, N, N);
      g.fillStyle = look.text;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      const text = this.labels[SIDES[i]!].toUpperCase();
      let px = 96;
      g.font = `600 ${px}px system-ui, sans-serif`;
      while (px > 48 && g.measureText(text).width > N * 0.86) g.font = `600 ${(px -= 2)}px system-ui, sans-serif`;
      g.fillText(text, N / 2, N * 0.52);
      m.map?.dispose();
      m.map = new CanvasTexture(c);
      m.map.colorSpace = SRGBColorSpace;
      // Sharp also on the sides seen at a slant.
      m.map.anisotropy = this.anisotropy;
      m.needsUpdate = true;
    });
  }

  /** The cube's square on the canvas (CSS pixels from the top left). */
  private rect(canvas: HTMLCanvasElement) {
    return { x: this.left, y: canvas.clientHeight - this.bottom - this.size, w: this.size, h: this.size };
  }

  /** Whether a point on the page is on the cube's square. */
  contains(canvas: HTMLCanvasElement, clientX: number, clientY: number): boolean {
    const b = canvas.getBoundingClientRect(),
      r = this.rect(canvas);
    const x = clientX - b.left - r.x,
      y = clientY - b.top - r.y;
    return x >= 0 && y >= 0 && x <= r.w && y <= r.h;
  }

  /**
   * The direction to look from for a point on the page: a side (one axis), an edge (two) or a
   * corner (three), as a vector of −1, 0 and 1; null off the cube, undefined off its square.
   */
  directionAt(canvas: HTMLCanvasElement, main: Camera, clientX: number, clientY: number): Vector3 | null | undefined {
    if (!this.contains(canvas, clientX, clientY)) return undefined;
    const b = canvas.getBoundingClientRect(),
      r = this.rect(canvas);
    const x = clientX - b.left - r.x,
      y = clientY - b.top - r.y;
    this.pose(main);
    this.ray.setFromCamera(new Vector2((x / r.w) * 2 - 1, -(y / r.h) * 2 + 1), this.camera);
    const hit = this.ray.intersectObject(this.cube, false)[0];
    if (!hit) return null;
    const p = hit.point;
    const part = (v: number) => (v > 0.5 - BAND ? 1 : v < -0.5 + BAND ? -1 : 0);
    return new Vector3(part(p.x), part(p.y), part(p.z));
  }

  /** Highlight the part of the cube for a direction (null: none). Returns whether that changed anything. */
  hover(dir: Vector3 | null): boolean {
    const key = dir ? dir.toArray().join(',') : '';
    if (key === this.hovered) return false;
    this.hovered = key;
    this.highlight.visible = !!dir;
    if (dir) {
      // Along each axis the direction points to: the band at that end; along the others, the
      // side's middle.
      const lift = 0.006;
      const size = dir.toArray().map((d) => (d ? BAND + lift : 1 - 2 * BAND));
      const at = dir.toArray().map((d) => (d ? d * (0.5 - BAND / 2 + lift / 2) : 0));
      this.highlight.scale.set(size[0]!, size[1]!, size[2]!);
      this.highlight.position.set(at[0]!, at[1]!, at[2]!);
    }
    return true;
  }

  /** Look at the cube as `main` looks at the scene: its turn, from the same side. */
  private pose(main: Camera) {
    this.camera.quaternion.copy(main.quaternion);
    this.camera.position.set(0, 0, 3).applyQuaternion(main.quaternion);
    // A corner turned to the camera reaches √3/2 from the center, the axes a little further.
    const s = 0.95;
    this.camera.left = this.camera.bottom = -s;
    this.camera.right = this.camera.top = s;
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld();
  }

  /** Draw over the 3D view. */
  render(renderer: WebGLRenderer, main: Camera, canvas: HTMLCanvasElement) {
    const aniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    if (aniso !== this.anisotropy) {
      this.anisotropy = aniso;
      for (const m of this.cube.material)
        if (m.map) {
          m.map.anisotropy = aniso;
          m.map.needsUpdate = true;
        }
    }
    this.pose(main);
    const r = this.rect(canvas);
    const y = canvas.clientHeight - r.y - r.h;
    // Over the scene: only the depth is cleared (a clear would also clear the color here).
    const auto = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setScissorTest(true);
    renderer.setScissor(r.x, y, r.w, r.h);
    renderer.setViewport(r.x, y, r.w, r.h);
    renderer.clearDepth();
    renderer.render(this.scene, this.camera);
    renderer.setScissorTest(false);
    renderer.autoClear = auto;
    renderer.setViewport(0, 0, canvas.clientWidth, canvas.clientHeight);
  }

  dispose() {
    this.scene.traverse((o) => {
      const m = o as Mesh;
      if (!m.geometry) return;
      m.geometry.dispose();
      for (const mat of [m.material].flat()) {
        (mat as MeshBasicMaterial).map?.dispose();
        (mat as MeshBasicMaterial).dispose();
      }
    });
  }
}
