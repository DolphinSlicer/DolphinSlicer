// The 3D view: bed, objects (prepare) and G-code (preview), with orbit camera and drag-to-move.
// Renders on demand; `benchmark()` renders continuously to measure frame times.
// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  AmbientLight,
  Box3,
  BoxGeometry,
  BufferGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DirectionalLight,
  DoubleSide,
  Euler,
  Float32BufferAttribute,
  Group,
  LineBasicMaterial,
  LineLoop,
  LineSegments,
  type Material,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  MOUSE,
  type Object3D,
  PerspectiveCamera,
  Plane,
  Quaternion,
  Raycaster,
  Scene,
  Shape,
  ShapeGeometry,
  TorusGeometry,
  Vector2,
  Vector3,
  WebGLRenderer,
  WebGLRenderTarget,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { Bed } from '../model/bed';
import type { AxisHint, SceneObject } from '../state/store';
import { GcodeLayer } from './gcodeLayer';
import { NEUTRAL, PaintLayer } from './paintLayer';
import { supportShapeGeometry } from './supportShapes';
import { type CubeLabels, ViewCube } from './viewCube';

export interface ViewportEvents {
  /** A click on an object (null: on nothing); `toggle` with Ctrl or Cmd held. */
  select(id: string | null, toggle: boolean): void;
  /** Instances dragged to new places. */
  moved(changes: { id: string; k: number; matrix: number[] }[]): void;
  isOnBed(id: string, matrix: number[]): boolean;
  /** A right click on an object (selected first) or on nothing, at a point on the page. */
  menu(id: string | null, x: number, y: number): void;
  /** A click on a side shown by lay on face. */
  layOnFace(id: string, normal: Vector3): void;
  /** A click on a support blocker or enforcer of an object. */
  selectVolume(id: string, volume: string): void;
  /** A support blocker or enforcer dragged by (dx, dy) in the world. */
  volumeMoved(id: string, volume: string, dx: number, dy: number): void;
  /**
   * Support painting: the pointer over the painted object (rays in world coordinates: the
   * pointer's, then back along its path to the last one sent). Resolves with where it is.
   */
  paint(ev: {
    action: 'move' | 'down' | 'drag';
    button?: 'left' | 'right';
    erase?: boolean;
    rays: number[][];
    camera: [number, number, number];
  }): Promise<{ hit: boolean; point?: [number, number, number] } | null>;
  /** The button let go: the stroke is done. */
  paintEnd(): void;
  /** Ctrl and the mouse wheel while painting. */
  paintWheel(up: boolean): void;
}

/** The support painting tool as the 3D view needs it. */
export interface PaintBrush {
  tool: 'circle' | 'sphere' | 'fill' | 'gap_fill';
  radius: number;
  vertical: boolean;
  horizontal: boolean;
}

/** A side the selected object can be laid on (model/layOnFace.ts): its normal and outline (3 numbers per corner). */
export interface FacePlaneView {
  normal: [number, number, number];
  outline: number[];
}

const MAT = {
  // Flat shading (per-face normals from screen-space derivatives), like the desktop app: the
  // meshes are indexed, and smoothed vertex normals would round off every sharp edge.
  normal: new MeshStandardMaterial({ color: 0x4a9bd1, metalness: 0.05, roughness: 0.75, flatShading: true }),
  // Yellow: none of the axis colors, so the axis hint shows on it.
  selected: new MeshStandardMaterial({ color: 0xffdb4d, metalness: 0.05, roughness: 0.75, emissive: 0x2e2606, flatShading: true }),
  outside: new MeshStandardMaterial({ color: 0xc8c8c8, metalness: 0, roughness: 0.9, transparent: true, opacity: 0.6, flatShading: true }),
};

/** Support blockers and enforcers: desktop's colours (GLVolume), seen through; brighter selected. */
const VOLUME_MAT = {
  support_blocker: new MeshStandardMaterial({ color: 0xff3333, transparent: true, opacity: 0.45, depthWrite: false }),
  support_enforcer: new MeshStandardMaterial({ color: 0x4d4dff, transparent: true, opacity: 0.45, depthWrite: false }),
  support_blocker_selected: new MeshStandardMaterial({
    color: 0xff3333,
    transparent: true,
    opacity: 0.75,
    depthWrite: false,
    emissive: 0x401010,
  }),
  support_enforcer_selected: new MeshStandardMaterial({
    color: 0x4d4dff,
    transparent: true,
    opacity: 0.75,
    depthWrite: false,
    emissive: 0x101040,
  }),
};

/** Scene colours per colour scheme (set by the app to match the page's theme). */
const THEMES = {
  light: { background: 0xe2e1dc, plate: 0xf6f5f2, grid: 0xcdcac3, outline: 0x95918a, exclude: 0xefc8c2 },
  dark: { background: 0x121211, plate: 0x1e1e1d, grid: 0x3b3b38, outline: 0x6b6963, exclude: 0x4a2b27 },
};

export class Viewport {
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera(40, 1, 1, 20000);
  readonly controls: OrbitControls;
  readonly gcode = new GcodeLayer();
  private bedGroup = new Group();
  private objectsGroup = new Group();
  private meshes = new Map<string, Mesh[]>();
  private bed: Bed | null = null;
  private frame = 0;
  private mode: 'prepare' | 'preview' = 'prepare';
  private drag: { start: Vector3; meshes: { id: string; k: number; mesh: Mesh; matrix: Matrix4 }[] } | null = null;
  /** Support blockers and enforcers, a mesh per volume and instance. */
  private volumesGroup = new Group();
  /** The selected support volume (its object is the one selected): the axis hint goes on it. */
  private selectedVolume: { object: string; volume: string } | null = null;
  private volumeDrag: { id: string; volume: string; start: Vector3; meshes: { mesh: Mesh; matrix: Matrix4 }[] } | null = null;
  private ray = new Raycaster();
  private resizeObs: ResizeObserver;
  private selected = new Set<string>();
  /** Corner brackets around the selected object's bounding box, like the desktop app. */
  private selectionCorners = new Group();
  private cornerMaterial = new LineBasicMaterial({ color: 0xffffff });
  /** The axis the object panel's focused field acts on, through the selected object's center. */
  private axisHint: AxisHint | null = null;
  private axisGroup = new Group();
  private axisGizmo = new Group();
  private axisSpin: Group | null = null;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly events: ViewportEvents,
  ) {
    this.renderer = new WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.applyTheme();
    this.camera.up.set(0, 0, 1);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = false;
    // Like the desktop app: left drag orbits, middle and right drag pan, the wheel zooms.
    this.controls.mouseButtons = { LEFT: MOUSE.ROTATE, MIDDLE: MOUSE.PAN, RIGHT: MOUSE.PAN };
    this.controls.addEventListener('change', () => this.invalidate());
    this.controls.addEventListener('start', () => this.stopCameraAnimation());
    // Mostly directional light so neighbouring faces read clearly (a key light from the front
    // left and above, a weaker fill from the back right, little ambient).
    this.scene.add(new AmbientLight(0xffffff, 0.45));
    const key = new DirectionalLight(0xffffff, 2.4);
    key.position.set(-1, -1.6, 2.2);
    this.scene.add(key);
    const fill = new DirectionalLight(0xffffff, 0.9);
    fill.position.set(1.5, 1, 0.6);
    this.scene.add(fill);
    this.scene.add(this.bedGroup, this.objectsGroup, this.gcode.group);
    this.objectsGroup.add(this.selectionCorners, this.axisGroup, this.volumesGroup);
    this.axisGroup.add(this.axisGizmo);
    this.resizeObs = new ResizeObserver(() => this.resize());
    this.resizeObs.observe(canvas);
    this.watchPixelRatio();
    canvas.addEventListener('pointerdown', this.onCubeDown, { capture: true });
    canvas.addEventListener('pointermove', this.onCubeMove, { capture: true });
    canvas.addEventListener('pointerup', this.onCubeUp, { capture: true });
    canvas.addEventListener('pointercancel', this.onCubeUp, { capture: true });
    canvas.addEventListener('pointerdown', this.onDown);
    canvas.addEventListener('pointermove', this.onMove);
    canvas.addEventListener('pointerup', this.onUp);
    canvas.addEventListener('pointercancel', this.onUp);
    canvas.addEventListener('pointermove', this.onHoverMove);
    canvas.addEventListener('pointerleave', this.onHoverLeave);
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    // Ctrl and the wheel change the painting tool's size (before the controls zoom).
    canvas.addEventListener('wheel', this.onPaintWheel, { capture: true, passive: false });
    this.objectsGroup.add(this.paintLayer.group);
    this.objectsGroup.add(this.facesGroup);
    this.resize();
  }

  private theme = THEMES.light;
  private dark = false;
  /** Switch between the light and dark scene colours. */
  setDark(dark: boolean) {
    if (dark === this.dark) return;
    this.dark = dark;
    this.cube.setDark(dark);
    this.applyTheme();
    this.setBed(this.bed);
  }
  private applyTheme() {
    this.theme = this.dark ? THEMES.dark : THEMES.light;
    this.scene.background = new Color(this.theme.background);
    this.invalidate();
  }

  dispose() {
    cancelAnimationFrame(this.frame);
    this.resizeObs.disconnect();
    this.pixelRatioQuery?.removeEventListener('change', this.onPixelRatio);
    this.controls.dispose();
    this.paintLayer.dispose();
    this.gcode.dispose();
    this.pickTarget.dispose();
    this.cube.dispose();
    for (const m of this.pickMaterials) m.dispose();
    this.renderer.dispose();
  }

  invalidate() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.render();
    });
  }

  private gridMats: LineBasicMaterial[] = [];
  private gridMat(color: number): LineBasicMaterial {
    const m = new LineBasicMaterial({ color, depthWrite: false });
    this.gridMats.push(m);
    return m;
  }

  render() {
    const below = this.camera.position.z < 0;
    for (const m of this.gridMats) m.depthTest = !below;
    this.poseAxisHint();
    this.renderer.render(this.scene, this.camera);
    this.cube.render(this.renderer, this.camera, this.canvas);
  }

  // ── view cube ────────────────────────────────────────────────────────────────────────
  readonly cube = new ViewCube();
  setCubeLabels(labels: CubeLabels) {
    this.cube.setLabels(labels);
    this.invalidate();
  }
  /** Where the cube sits: this far from the canvas' left edge (beside the panels over it). */
  setCubeAt(left: number, bottom: number) {
    if (left === this.cube.left && bottom === this.cube.bottom) return;
    this.cube.left = left;
    this.cube.bottom = bottom;
    this.invalidate();
  }
  private onCube = false;
  // The cube's pointer events are captured before the orbit controls see them: a click looks
  // from the side, edge or corner under it; a drag turns the view as the orbit does.
  private cubeDrag: { x: number; y: number; lastX: number; lastY: number; travel: number; moved: boolean; wasLocked: boolean } | null =
    null;
  private locked = () => document.pointerLockElement === this.canvas;
  private onCubeDown = (ev: PointerEvent) => {
    if (this.mode !== 'prepare' && this.mode !== 'preview') return;
    if (!this.cube.contains(this.canvas, ev.clientX, ev.clientY)) return;
    ev.stopImmediatePropagation();
    ev.preventDefault();
    if (ev.button !== 0) return;
    this.stopCameraAnimation();
    this.cubeDrag = { x: ev.clientX, y: ev.clientY, lastX: ev.clientX, lastY: ev.clientY, travel: 0, moved: false, wasLocked: false };
    this.canvas.setPointerCapture(ev.pointerId);
  };
  private onCubeMove = (ev: PointerEvent) => {
    const d = this.cubeDrag;
    if (d) {
      ev.stopImmediatePropagation();
      // Locked, the pointer does not move: its movement is all there is.
      const locked = this.locked();
      const dx = locked ? ev.movementX : ev.clientX - d.lastX,
        dy = locked ? ev.movementY : ev.clientY - d.lastY;
      d.lastX = ev.clientX;
      d.lastY = ev.clientY;
      // Chrome's first movement once the pointer is locked can be a bogus jump (and so can a
      // stray one later): skip those rather than swing the view.
      const first = locked && !d.wasLocked;
      d.wasLocked = locked;
      if (first || Math.abs(dx) > 250 || Math.abs(dy) > 250) return;
      d.travel += Math.hypot(dx, dy);
      if (!d.moved && d.travel < 3) return;
      if (!d.moved) {
        // Turning, the pointer is hidden and stays put: letting go shows it where the drag began
        // (pointer lock, from here: a click alone would flash the browser's notice about it).
        // Where the browser refuses, the drag works with the pointer in view.
        try {
          void (this.canvas.requestPointerLock() as Promise<void> | undefined)?.catch?.(() => {});
        } catch {
          /* no pointer lock */
        }
      }
      d.moved = true;
      if (!locked) this.canvas.style.cursor = 'grabbing';
      this.orbitBy(dx, dy);
      return;
    }
    if (ev.buttons) return;
    const dir = this.cube.directionAt(this.canvas, this.camera, ev.clientX, ev.clientY);
    if (this.cube.hover(dir ?? null)) this.invalidate();
    if (this.cube.setActive(dir !== undefined)) this.fadeCube();
    if (dir !== undefined) {
      ev.stopImmediatePropagation();
      this.canvas.style.cursor = dir ? 'pointer' : 'grab';
      this.setHovered(null);
    } else if (this.onCube) this.canvas.style.cursor = '';
    this.onCube = dir !== undefined;
  };
  private onCubeUp = (ev: PointerEvent) => {
    const d = this.cubeDrag;
    if (!d) return;
    ev.stopImmediatePropagation();
    this.cubeDrag = null;
    if (this.locked()) document.exitPointerLock();
    if (this.canvas.hasPointerCapture(ev.pointerId)) this.canvas.releasePointerCapture(ev.pointerId);
    this.canvas.style.cursor = '';
    if (!this.cube.contains(this.canvas, d.x, d.y)) {
      if (this.cube.hover(null)) this.invalidate();
      if (this.cube.setActive(false)) this.fadeCube();
    }
    if (d.moved) return;
    const dir = this.cube.directionAt(this.canvas, this.camera, d.x, d.y);
    if (dir) this.lookFrom(dir);
  };

  /** Run the cube's fade, a frame at a time. */
  private cubeFade = 0;
  private fadeCube() {
    if (this.cubeFade) return;
    const tick = (now: number) => {
      const more = this.cube.step(now);
      this.invalidate();
      this.cubeFade = more ? requestAnimationFrame(tick) : 0;
    };
    this.cubeFade = requestAnimationFrame(tick);
  }

  /** Turn the view about its target as the orbit controls do for a left drag (pixels). */
  private orbitBy(dx: number, dy: number) {
    const t = this.controls.target,
      off = this.camera.position.clone().sub(t);
    const r = off.length();
    let theta = Math.atan2(off.y, off.x),
      phi = Math.acos(Math.min(1, Math.max(-1, off.z / r)));
    const h = this.canvas.clientHeight || 1;
    theta -= (2 * Math.PI * dx) / h;
    phi = Math.min(Math.PI - 1e-4, Math.max(1e-4, phi - (2 * Math.PI * dy) / h));
    this.camera.position.set(t.x + r * Math.sin(phi) * Math.cos(theta), t.y + r * Math.sin(phi) * Math.sin(theta), t.z + r * Math.cos(phi));
    this.controls.update();
    this.invalidate();
  }

  /** The most pixels drawn: a 4K screen's. Zoomed in, the page has more pixels per CSS pixel but
   *  fewer CSS pixels, so the canvas stays sharp; only very large screens draw fewer. */
  private static readonly MAX_PIXELS = 3840 * 2160;
  private pixelRatioQuery: MediaQueryList | null = null;
  private onPixelRatio = () => {
    this.resize();
    this.watchPixelRatio();
  };
  /** The screen's pixels per CSS pixel change with the browser's zoom and from one screen to another. */
  private watchPixelRatio() {
    this.pixelRatioQuery?.removeEventListener('change', this.onPixelRatio);
    this.pixelRatioQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    this.pixelRatioQuery.addEventListener('change', this.onPixelRatio);
  }

  /** The canvas's size is the style sheet's (beside the sidebar on wide screens); its pixels follow
   *  it, one per screen pixel. */
  private resize() {
    const w = this.canvas.clientWidth,
      h = this.canvas.clientHeight;
    if (!w || !h) return;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, Math.sqrt(Viewport.MAX_PIXELS / (w * h))));
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.invalidate();
  }

  setMode(mode: 'prepare' | 'preview') {
    this.mode = mode;
    if (mode !== 'prepare') this.setHovered(null);
    this.objectsGroup.visible = mode === 'prepare';
    this.gcode.group.visible = mode === 'preview';
    this.invalidate();
  }

  setBed(bed: Bed | null) {
    const old = this.bed,
      first = !old;
    this.bed = bed;
    this.gridMats = [];
    for (const c of [...this.bedGroup.children]) {
      this.bedGroup.remove(c);
      c.traverse((o) => (o as Mesh).geometry?.dispose());
    }
    if (!bed) return;
    const shape = new Shape(bed.polygon.map(([x, y]) => new Vector2(x, y)));
    const plate = new Mesh(
      new ShapeGeometry(shape),
      new MeshBasicMaterial({ color: this.theme.plate, side: DoubleSide, depthWrite: false }),
    );
    plate.position.z = -0.05;
    this.bedGroup.add(plate);
    // 10 mm grid, clipped to the bed's bounding box.
    const pts: number[] = [];
    const [x0, y0] = bed.min,
      [x1, y1] = bed.max;
    for (let x = Math.ceil(x0 / 10) * 10; x <= x1; x += 10) pts.push(x, y0, 0, x, y1, 0);
    for (let y = Math.ceil(y0 / 10) * 10; y <= y1; y += 10) pts.push(x0, y, 0, x1, y, 0);
    const grid = new BufferGeometry();
    grid.setAttribute('position', new Float32BufferAttribute(pts, 3));
    const gridLines = new LineSegments(grid, this.gridMat(this.theme.grid));
    const outline = new BufferGeometry();
    outline.setAttribute(
      'position',
      new Float32BufferAttribute(
        bed.polygon.flatMap(([x, y]) => [x, y, 0.01]),
        3,
      ),
    );
    const outlineLoop = new LineLoop(outline, this.gridMat(this.theme.outline));
    for (const ex of bed.exclude) {
      const m = new Mesh(
        new ShapeGeometry(new Shape(ex.map(([x, y]) => new Vector2(x, y)))),
        new MeshBasicMaterial({ color: this.theme.exclude, side: DoubleSide, depthWrite: false }),
      );
      m.position.z = -0.02;
      this.bedGroup.add(m);
    }
    // Like the desktop app, the bed never hides anything: it is drawn first and writes no depth,
    // so the axes and objects show through it (e.g. seen from below).
    // (Children only: a Group's own renderOrder would order the whole group before the objects.)
    for (const c of this.bedGroup.children) c.renderOrder = -1;
    // Grid lines draw after the objects. Seen from above they are depth-tested (objects cover
    // them); seen from below they overlay everything, like the desktop app (see render()).
    gridLines.renderOrder = outlineLoop.renderOrder = 1;
    this.bedGroup.add(gridLines, outlineLoop);
    this.bedGroup.add(this.axes(Math.max(15, 0.135 * Math.max(x1 - x0, y1 - y0))));
    if (first) this.resetCamera();
    else {
      // Another printer's bed grows or shrinks about its center: the view moves with the center,
      // so the bed stays where it was on the screen.
      const dx = (x0 + x1 - old.min[0] - old.max[0]) / 2,
        dy = (y0 + y1 - old.min[1] - old.max[1]) / 2;
      if (dx || dy) {
        this.stopCameraAnimation();
        const by = new Vector3(dx, dy, 0);
        this.controls.target.add(by);
        this.camera.position.add(by);
        this.controls.update();
      }
    }
    // No zooming out until the bed is a dot (or beyond what is drawn), nor in to nothing.
    const size = Math.max(x1 - x0, y1 - y0);
    this.camera.near = size / 200;
    this.camera.far = size * 50;
    this.camera.updateProjectionMatrix();
    this.controls.minDistance = size / 100;
    this.controls.maxDistance = Math.min(size * 25, this.camera.far / 2);
    this.invalidate();
  }

  /** X/Y/Z arrows at the bed origin, as in the desktop app (red, green, blue). */
  private axes(len: number): Group {
    const g = new Group();
    const r = len * 0.018,
      head = len * 0.16;
    const arrow = (color: number, rotate: (m: Mesh) => void) => {
      // Partly self-lit, so the sides turned away from the light keep their color.
      const mat = new MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.55, roughness: 0.6, metalness: 0 });
      const shaft = new Mesh(new CylinderGeometry(r, r, len - head, 16), mat);
      shaft.position.y = (len - head) / 2;
      const tip = new Mesh(new ConeGeometry(r * 2.6, head, 20), mat);
      tip.position.y = len - head / 2;
      const a = new Group();
      a.add(shaft, tip);
      rotate(a as unknown as Mesh);
      g.add(a);
    };
    // Cylinders and cones point along +Y by default.
    arrow(0xd92b2b, (a) => a.rotateZ(-Math.PI / 2)); // X
    arrow(0x2bb32b, () => {}); // Y
    arrow(0x2b4fd9, (a) => a.rotateX(Math.PI / 2)); // Z
    return g;
  }

  /** The view the page starts with: the bed's center, from the front and above. */
  private homePose() {
    const bed = this.bed;
    const cx = bed ? (bed.min[0] + bed.max[0]) / 2 : 100,
      cy = bed ? (bed.min[1] + bed.max[1]) / 2 : 100;
    const size = bed ? Math.max(bed.max[0] - bed.min[0], bed.max[1] - bed.min[1]) : 200;
    return {
      size,
      target: new Vector3(cx, cy, 0),
      position: new Vector3(cx, cy, 0).addScaledVector(Viewport.HOME_DIRECTION, size * Math.hypot(1.4, 1.1)),
    };
  }

  /** Back to the view the page starts with (the home button, the 0 key), moving there. */
  home() {
    const p = this.homePose();
    this.animateCamera(p.target, p.position);
  }

  resetCamera() {
    const { size, target, position } = this.homePose();
    this.controls.target.copy(target);
    this.camera.position.copy(position);
    this.camera.near = size / 200;
    this.camera.far = size * 50;
    this.camera.updateProjectionMatrix();
    this.controls.update();
    this.invalidate();
  }

  setObjects(
    objects: SceneObject[],
    geometries: Map<string, BufferGeometry>,
    selected: string[],
    selectedVolume: { object: string; volume: string } | null = null,
  ) {
    this.selected = new Set(selected);
    this.selectedVolume = selectedVolume;
    this.setVolumes(objects, selectedVolume);
    const seen = new Set<string>();
    for (const o of objects) {
      seen.add(o.id);
      const geo = geometries.get(o.id);
      if (!geo) continue;
      let list = this.meshes.get(o.id) ?? [];
      while (list.length > o.instances.length) this.objectsGroup.remove(list.pop()!);
      while (list.length < o.instances.length) {
        // Each mesh has its own material so its hover glow can animate independently.
        const m = new Mesh(geo, MAT.normal.clone());
        m.matrixAutoUpdate = false;
        m.userData = { id: o.id, k: list.length };
        this.objectsGroup.add(m);
        list = [...list, m];
      }
      this.meshes.set(o.id, list);
      o.instances.forEach((mat, k) => {
        const mesh = list[k]!;
        mesh.matrix.fromArray(mat);
        mesh.matrixWorldNeedsUpdate = true;
        this.applyLook(
          mesh,
          this.painting?.id === o.id
            ? NEUTRAL
            : this.selected.has(o.id)
              ? MAT.selected
              : this.events.isOnBed(o.id, mat)
                ? MAT.normal
                : MAT.outside,
        );
      });
    }
    for (const [id, list] of this.meshes) {
      if (seen.has(id)) continue;
      for (const m of list) {
        this.objectsGroup.remove(m);
        (m.material as MeshStandardMaterial).dispose();
      }
      this.meshes.delete(id);
      this.hoverT.delete(id);
    }
    this.updateSelectionCorners();
    this.placeFaces();
    this.refreshPaintInstances();
    this.invalidate();
  }

  /** The objects' support blockers and enforcers, drawn anew (there are few). */
  private setVolumes(objects: SceneObject[], selected: { object: string; volume: string } | null) {
    this.volumesGroup.clear();
    for (const o of objects)
      for (const v of o.volumes ?? []) {
        const on = selected?.object === o.id && selected.volume === v.id;
        const geo = supportShapeGeometry(v.shape, v.size);
        o.instances.forEach((inst, k) => {
          const mesh = new Mesh(geo, VOLUME_MAT[on ? (`${v.type}_selected` as const) : v.type]);
          mesh.matrixAutoUpdate = false;
          mesh.matrix.fromArray(inst).multiply(new Matrix4().fromArray(v.matrix));
          mesh.renderOrder = 1;
          mesh.userData = { id: o.id, volume: v.id, k };
          this.volumesGroup.add(mesh);
        });
      }
  }

  // ── support painting ─────────────────────────────────────────────────────────────────
  private paintLayer = new PaintLayer();
  private painting: { id: string; brush: PaintBrush; limit: number } | null = null;
  /** The stroke being painted: its button, and where it started. */
  private stroke: { button: 'left' | 'right'; erase: boolean; start: [number, number]; pointerId: number } | null = null;
  /** Where the stroke was last sent. */
  private strokeLast: [number, number] | null = null;
  /** A paint event is with the engine; the latest pointer event waits for it. */
  private paintBusy = false;
  private paintQueue: { action: 'move' | 'down' | 'drag'; x: number; y: number; button?: 'left' | 'right'; erase?: boolean } | null = null;
  /** The stroke ended while its events were still waiting. */
  private strokeEnded = false;

  /** Support painting on this object (null: not painting), with the overhangs highlighted. */
  setPainting(p: { id: string; brush: PaintBrush; highlightLimit: number } | null) {
    const was = this.painting?.id;
    this.painting = p ? { id: p.id, brush: p.brush, limit: p.highlightLimit } : null;
    // The support volumes would be in the brush's way.
    this.volumesGroup.visible = !p;
    if (!p) {
      this.paintLayer.hide();
      this.paintLayer.clear();
      this.stroke = null;
      this.paintQueue = null;
    } else if (was !== p.id) {
      this.paintAt = '';
      this.refreshPaintInstances();
    }
    this.setPaintCursor(null);
    // The object's look and its corners follow (neutral, none).
    for (const [id, list] of this.meshes)
      for (const mesh of list)
        if (id === p?.id || id === was) this.applyLook(mesh, id === p?.id ? NEUTRAL : this.selected.has(id) ? MAT.selected : MAT.normal);
    this.updateSelectionCorners();
    this.invalidate();
  }

  setPaintBrush(brush: PaintBrush) {
    if (!this.painting) return;
    this.painting.brush = brush;
    if (brush.tool === 'fill' || brush.tool === 'gap_fill') this.setPaintCursor(null);
    this.invalidate();
  }

  setPaintRender(r: { full: boolean; blocks: { key: string; groups: Float32Array[] }[] }) {
    this.paintLayer.setRender(r);
    this.invalidate();
  }

  setPaintHighlight(limitDeg: number) {
    if (this.painting) this.painting.limit = limitDeg;
    this.paintLayer.setHighlight(limitDeg);
    this.invalidate();
  }

  /** The painted object's instances as they are now (moved, added): the layer follows. */
  private refreshPaintInstances() {
    const p = this.painting;
    const list = p ? (this.meshes.get(p.id) ?? []) : [];
    const at = list.map((m) => m.matrix.toArray().join()).join('|');
    if (!p || !list[0] || at === this.paintAt) return;
    this.paintAt = at;
    this.paintLayer.show(
      list[0].geometry,
      list.map((m) => m.matrix.toArray()),
      p.limit,
    );
  }
  private paintAt = '';

  private setPaintCursor(point: [number, number, number] | null) {
    const p = this.painting;
    const brush = p?.brush;
    const shown = !!point && !!brush && (brush.tool === 'circle' || brush.tool === 'sphere');
    const color = this.stroke ? (this.stroke.erase ? 0xcccccc : this.stroke.button === 'left' ? 0x80ff80 : 0xff8080) : 0xffffff;
    this.paintLayer.setCursor(
      shown ? { point: new Vector3(...point!), radius: brush!.radius, shape: brush!.tool as 'circle' | 'sphere', color } : null,
      this.camera,
    );
    this.invalidate();
  }

  /** The ray under a point of the page, in world coordinates. */
  private rayAt(x: number, y: number): number[] {
    const r = this.canvas.getBoundingClientRect();
    this.ray.setFromCamera(new Vector2(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1), this.camera);
    const o = this.ray.ray.origin,
      d = this.ray.ray.direction;
    return [o.x, o.y, o.z, d.x, d.y, d.z];
  }

  /**
   * Send the pointer to the engine (one event at a time; the latest position waits). A drag
   * goes back along the pointer's path to the last position sent, a pixel apart, as desktop's.
   */
  private sendPaint(action: 'move' | 'down' | 'drag', x: number, y: number, button?: 'left' | 'right', erase?: boolean) {
    if (this.paintBusy) {
      // The stroke's events go before hovering; a press before the drags after it.
      const q = this.paintQueue;
      if (q && q.action !== 'move' && (action === 'move' || (action === 'drag' && q.action === 'down'))) return;
      this.paintQueue = { action, x, y, button, erase };
      return;
    }
    const points: [number, number][] = [[x, y]];
    if (action === 'down') this.strokeLast = null;
    if (action === 'drag' && this.strokeLast) {
      const [lx, ly] = this.strokeLast;
      const steps = Math.floor(Math.hypot(x - lx, y - ly));
      if (steps > 0) {
        for (let i = 1; i <= steps; i++) points.push([x + ((lx - x) * i) / (steps + 1), y + ((ly - y) * i) / (steps + 1)]);
        points.push([lx, ly]);
      }
    }
    if (action !== 'move') this.strokeLast = [x, y];
    this.paintBusy = true;
    const c = this.camera.position;
    this.events
      .paint({
        action,
        ...(action !== 'move' ? { button, erase } : {}),
        rays: points.map(([px, py]) => this.rayAt(px, py)),
        camera: [c.x, c.y, c.z],
      })
      .then((r) => {
        this.setPaintCursor(r?.hit && r.point ? r.point : null);
      })
      .finally(() => {
        this.paintBusy = false;
        const q = this.paintQueue;
        this.paintQueue = null;
        if (q && this.painting) this.sendPaint(q.action, q.x, q.y, q.button, q.erase);
        else if (this.strokeEnded) {
          this.strokeEnded = false;
          this.events.paintEnd();
        }
      });
  }

  /** A press while painting: a stroke on the object; elsewhere the camera moves as usual. */
  private paintDown(ev: PointerEvent): boolean {
    const p = this.painting!;
    if ((ev.button !== 0 && ev.button !== 2) || p.brush.tool === 'gap_fill') return true;
    const mesh = this.hitTest(ev);
    if ((mesh?.userData as { id?: string } | undefined)?.id !== p.id) return true;
    const s = (this.stroke = {
      button: ev.button === 2 ? 'right' : 'left',
      erase: ev.shiftKey,
      start: [ev.clientX, ev.clientY],
      pointerId: ev.pointerId,
    });
    this.controls.enabled = false;
    this.canvas.setPointerCapture(ev.pointerId);
    this.sendPaint('down', ev.clientX, ev.clientY, s.button, s.erase);
    return true;
  }

  private paintMove(ev: PointerEvent) {
    const s = this.stroke;
    if (!s) return;
    // Vertical or Horizontal: the brush keeps to the line it started on.
    const b = this.painting!.brush;
    const brushTool = b.tool === 'circle' || b.tool === 'sphere';
    const x = brushTool && b.vertical ? s.start[0] : ev.clientX,
      y = brushTool && b.horizontal ? s.start[1] : ev.clientY;
    this.sendPaint('drag', x, y, s.button, s.erase);
  }

  private paintUp(ev: PointerEvent) {
    const s = this.stroke;
    if (!s || ev.pointerId !== s.pointerId) return;
    this.stroke = null;
    this.controls.enabled = true;
    if (this.canvas.hasPointerCapture(ev.pointerId)) this.canvas.releasePointerCapture(ev.pointerId);
    if (this.paintBusy) this.strokeEnded = true;
    else this.events.paintEnd();
  }

  private onPaintWheel = (ev: WheelEvent) => {
    if (!this.painting || this.mode !== 'prepare' || !(ev.ctrlKey || ev.metaKey)) return;
    ev.preventDefault();
    ev.stopImmediatePropagation();
    if (ev.deltaY !== 0) this.events.paintWheel(ev.deltaY < 0);
  };

  // ── lay on face ──────────────────────────────────────────────────────────────────────
  private facesGroup = new Group();
  private faces: { id: string; planes: FacePlaneView[] } | null = null;
  private hoveredFace = -1;
  private static readonly FACE = { color: 0xdedede, opacity: 0.5 };
  private static readonly FACE_HOVER = { color: 0x56a9ff, opacity: 0.75 };

  /** Show the sides of an object's first instance it can be laid on (null: none), as desktop's flatten gizmo. */
  setLayOnFace(faces: { id: string; planes: FacePlaneView[] } | null) {
    for (const c of this.facesGroup.children as Mesh[]) {
      c.geometry.dispose();
      (c.material as Material).dispose();
    }
    this.facesGroup.clear();
    this.faces = faces;
    this.hoveredFace = -1;
    for (const p of faces?.planes ?? []) {
      // Slightly inside its outline and off the surface, as desktop draws them.
      const corners = Array.from({ length: p.outline.length / 3 }, (_, i) => new Vector3().fromArray(p.outline, i * 3));
      const c = corners.reduce((a, v) => a.add(v), new Vector3()).divideScalar(corners.length);
      const lift = new Vector3(...p.normal).multiplyScalar(0.1);
      const pts = corners.map((v) => v.clone().multiplyScalar(0.9).addScaledVector(c, 0.1).add(lift));
      const pos: number[] = [];
      for (let i = 1; i + 1 < pts.length; i++) for (const v of [pts[0]!, pts[i]!, pts[i + 1]!]) pos.push(v.x, v.y, v.z);
      const g = new BufferGeometry();
      g.setAttribute('position', new Float32BufferAttribute(pos, 3));
      const m = new Mesh(
        g,
        new MeshBasicMaterial({
          color: Viewport.FACE.color,
          transparent: true,
          opacity: Viewport.FACE.opacity,
          side: DoubleSide,
          depthWrite: false,
          polygonOffset: true,
          polygonOffsetFactor: -2,
          polygonOffsetUnits: -2,
        }),
      );
      m.renderOrder = 5;
      m.matrixAutoUpdate = false;
      this.facesGroup.add(m);
    }
    this.placeFaces();
    this.invalidate();
  }

  /** Follow the first instance's position (the sides are under its rotation, without its offset). */
  private placeFaces() {
    const mesh = this.faces ? this.meshes.get(this.faces.id)?.[0] : undefined;
    this.facesGroup.visible = !!mesh;
    if (!mesh) return;
    const at = new Vector3().setFromMatrixPosition(mesh.matrix);
    for (const c of this.facesGroup.children) {
      c.matrix.makeTranslation(at.x, at.y, at.z);
      c.matrixWorldNeedsUpdate = true;
    }
  }

  private faceAt(ev: PointerEvent): number {
    if (!this.faces || !this.facesGroup.visible || !this.facesGroup.children.length) return -1;
    this.ray.setFromCamera(this.pointer(ev), this.camera);
    const hit = this.ray.intersectObjects(this.facesGroup.children, false)[0];
    return hit ? this.facesGroup.children.indexOf(hit.object) : -1;
  }

  private setHoveredFace(i: number) {
    if (i === this.hoveredFace) return;
    this.hoveredFace = i;
    this.facesGroup.children.forEach((c, k) => {
      const m = (c as Mesh).material as MeshBasicMaterial,
        look = k === i ? Viewport.FACE_HOVER : Viewport.FACE;
      m.color.setHex(look.color);
      m.opacity = look.opacity;
    });
    this.invalidate();
  }

  // ── hover ────────────────────────────────────────────────────────────────────────────
  private hovered: string | null = null;
  private hoverT = new Map<string, number>();
  private hoverFrame = 0;
  private hoverLast = 0;
  private hoverPending: PointerEvent | null = null;
  private static readonly HOVER_GLOW = new Color(0x56a9ff);

  /** Copy a base look (normal / selected / outside the bed) into a mesh's own material. */
  private applyLook(mesh: Mesh, base: MeshStandardMaterial) {
    const m = mesh.material as MeshStandardMaterial;
    m.color.copy(base.color);
    m.roughness = base.roughness;
    m.metalness = base.metalness;
    m.transparent = base.transparent;
    m.opacity = base.opacity;
    mesh.userData.baseEmissive = base.emissive.clone();
    this.paintHover(mesh, this.hoverT.get((mesh.userData as { id: string }).id) ?? 0);
  }

  private paintHover(mesh: Mesh, t: number) {
    const m = mesh.material as MeshStandardMaterial;
    m.emissive.copy(mesh.userData.baseEmissive as Color).lerp(Viewport.HOVER_GLOW, 0.14 * t);
  }

  /** Object under the pointer, on its surface (not its bounding box), for the hover glow.
   *  GPU picking: the objects are drawn into the one pixel under the pointer, each in its own
   *  colour, and that pixel is read back. Exact, and its cost hardly depends on the triangle
   *  count (a raycast over a million triangles takes too long for every pointer move). */
  private hitTest(ev: PointerEvent): Mesh | null {
    const meshes = this.objectsGroup.children.filter((o) => (o as Mesh).isMesh && o.visible) as Mesh[];
    if (!meshes.length) return null;
    const r = this.canvas.getBoundingClientRect();
    const x = Math.floor(ev.clientX - r.left),
      y = Math.floor(ev.clientY - r.top);
    if (x < 0 || y < 0 || x >= r.width || y >= r.height) return null;

    while (this.pickMaterials.length < meshes.length) {
      const id = this.pickMaterials.length + 1;
      const m = new MeshBasicMaterial({ toneMapped: false });
      // Raw channel values (no colour-space conversion): the id comes back byte for byte.
      m.color.r = (id & 0xff) / 255;
      m.color.g = ((id >> 8) & 0xff) / 255;
      m.color.b = ((id >> 16) & 0xff) / 255;
      this.pickMaterials.push(m);
    }
    const materials = new Map<Mesh, Material | Material[]>();
    const hidden: Object3D[] = [];
    meshes.forEach((m, i) => {
      materials.set(m, m.material);
      m.material = this.pickMaterials[i]!;
    });
    for (const o of this.objectsGroup.children)
      if (!(o as Mesh).isMesh && o.visible) {
        o.visible = false;
        hidden.push(o);
      }
    const clear = this.renderer.getClearColor(new Color()),
      alpha = this.renderer.getClearAlpha();
    const prevTarget = this.renderer.getRenderTarget();
    try {
      this.camera.setViewOffset(r.width, r.height, x, y, 1, 1);
      this.renderer.setRenderTarget(this.pickTarget);
      this.renderer.setClearColor(0x000000, 1);
      this.renderer.clear();
      this.renderer.render(this.objectsGroup, this.camera);
      this.renderer.readRenderTargetPixels(this.pickTarget, 0, 0, 1, 1, this.pickPixel);
    } finally {
      this.camera.clearViewOffset();
      this.renderer.setRenderTarget(prevTarget);
      this.renderer.setClearColor(clear, alpha);
      for (const [m, mat] of materials) m.material = mat;
      for (const o of hidden) o.visible = true;
    }
    const id = this.pickPixel[0]! | (this.pickPixel[1]! << 8) | (this.pickPixel[2]! << 16);
    return meshes[id - 1] ?? null;
  }
  private pickTarget = new WebGLRenderTarget(1, 1);
  private pickPixel = new Uint8Array(4);
  private pickMaterials: MeshBasicMaterial[] = [];

  private onHoverMove = (ev: PointerEvent) => {
    if (this.mode !== 'prepare' || this.drag || ev.buttons) return;
    // Painting: where the brush is, and the fill's preview.
    if (this.painting) {
      if (this.painting.brush.tool !== 'gap_fill') this.sendPaint('move', ev.clientX, ev.clientY);
      return;
    }
    this.hoverPending = ev;
    if (this.hoverFrame) return;
    this.hoverFrame = requestAnimationFrame((now) => {
      this.hoverFrame = 0;
      const e = this.hoverPending;
      this.hoverPending = null;
      if (e) {
        const face = this.faceAt(e);
        this.setHoveredFace(face);
        this.setHovered(face >= 0 ? null : ((this.hitTest(e)?.userData as { id?: string } | undefined)?.id ?? null));
        if (face >= 0) this.canvas.style.cursor = 'pointer';
      }
      this.animateHover(now);
    });
  };

  private onHoverLeave = () => {
    if (this.painting && !this.stroke) this.setPaintCursor(null);
    if (!this.cubeDrag) {
      if (this.cube.hover(null)) this.invalidate();
      if (this.cube.setActive(false)) this.fadeCube();
    }
    if (!this.drag) {
      this.setHovered(null);
      this.setHoveredFace(-1);
    }
  };

  private setHovered(id: string | null) {
    if (id === this.hovered) return;
    this.hovered = id;
    this.canvas.style.cursor = id ? 'grab' : '';
    this.hoverLast = 0;
    requestAnimationFrame((now) => this.animateHover(now));
  }

  /** Ease each object's glow toward its target (~150 ms) and render while anything moves. */
  private animateHover(now: number) {
    const dt = this.hoverLast ? Math.min(64, now - this.hoverLast) : 16;
    this.hoverLast = now;
    let moving = false;
    for (const [id, list] of this.meshes) {
      const target = id === this.hovered && this.mode === 'prepare' ? 1 : 0;
      const cur = this.hoverT.get(id) ?? 0;
      if (cur === target) continue;
      const next = target > cur ? Math.min(1, cur + dt / 150) : Math.max(0, cur - dt / 220);
      this.hoverT.set(id, next);
      for (const m of list) this.paintHover(m, next * next * (3 - 2 * next));
      if (next !== target) moving = true;
    }
    this.invalidate();
    if (moving) requestAnimationFrame((t) => this.animateHover(t));
    else this.hoverLast = 0;
  }

  /** Rebuild the corner brackets for every instance of the selected object. */
  private updateSelectionCorners() {
    for (const c of this.selectionCorners.children as LineSegments[]) c.geometry.dispose();
    this.selectionCorners.clear();
    // One set per instance, so a dragged instance's corners go along with it alone.
    // Not while painting (desktop shows none in its painting tools).
    for (const mesh of this.painting ? [] : [...this.selected].flatMap((id) => this.meshes.get(id) ?? [])) {
      const pts: number[] = [];
      mesh.updateMatrixWorld(true);
      // Exact (the transformed vertices), so kept for as long as the mesh stays where it is.
      const at = mesh.matrixWorld.elements.join();
      let kept = mesh.userData.box as { at: string; geometry: BufferGeometry; box: Box3 } | undefined;
      if (!kept || kept.at !== at || kept.geometry !== mesh.geometry)
        mesh.userData.box = kept = { at, geometry: mesh.geometry, box: new Box3().setFromObject(mesh, true) };
      const b = kept.box;
      if (b.isEmpty()) continue;
      const lo = b.min,
        hi = b.max;
      const len = [hi.x - lo.x, hi.y - lo.y, hi.z - lo.z].map((d) => Math.max(d * 0.2, 0.5));
      for (const x of [lo.x, hi.x])
        for (const y of [lo.y, hi.y])
          for (const z of [lo.z, hi.z]) {
            const sx = x === lo.x ? 1 : -1,
              sy = y === lo.y ? 1 : -1,
              sz = z === lo.z ? 1 : -1;
            pts.push(x, y, z, x + sx * len[0]!, y, z);
            pts.push(x, y, z, x, y + sy * len[1]!, z);
            pts.push(x, y, z, x, y, z + sz * len[2]!);
          }
      const g = new BufferGeometry();
      g.setAttribute('position', new Float32BufferAttribute(pts, 3));
      const lines = new LineSegments(g, this.cornerMaterial);
      lines.renderOrder = 10;
      lines.frustumCulled = false;
      lines.userData = { mesh };
      this.selectionCorners.add(lines);
    }
    this.updateAxisHint();
  }

  setAxisHint(hint: AxisHint | null) {
    this.axisHint = hint;
    this.updateAxisHint();
    this.invalidate();
  }

  private static readonly AXIS_COLORS = [0xe5484d, 0x30a46c, 0x3e7bfa];
  /**
   * The focused field's axis, drawn over the object: an arrow towards the positive direction
   * (move), a line with a cube at each end (scale, size), the mirror plane with an arrowhead
   * towards it from each side (mirror), or arcs about the axis with arrowheads towards the
   * positive angle (rotate; counterclockwise seen from the axis' positive end). Built in screen pixels and scaled in render(), so it has the same
   * size on screen for any model and zoom, as the gizmos of other 3D programs.
   */
  private updateAxisHint() {
    const g = this.axisGizmo;
    g.traverse((c) => {
      const m = c as Mesh;
      if (m.isMesh) {
        m.geometry.dispose();
        (m.material as Material).dispose();
      }
    });
    g.clear();
    this.axisSpin = null;
    this.axisGroup.position.set(0, 0, 0);
    const only = this.selected.size === 1 ? [...this.selected][0]! : null;
    const sv = this.selectedVolume;
    // On the selected support volume (its first instance's), else on the object.
    const volumeMesh = sv
      ? (this.volumesGroup.children as Mesh[]).find((m) => {
          const d = m.userData as { id: string; volume: string; k: number };
          return d.id === sv.object && d.volume === sv.volume && d.k === 0;
        })
      : undefined;
    const hint = this.axisHint,
      mesh = volumeMesh ?? (only ? this.meshes.get(only)?.[0] : undefined);
    if (!hint || !mesh) return;
    mesh.updateMatrixWorld(true);
    const box = new Box3().setFromObject(mesh, true);
    if (box.isEmpty()) return;
    g.position.copy(box.getCenter(new Vector3()));
    // The direction: a world axis; the object's own (its rotation applied); or, for rotation
    // angles (R = Rz·Ry·Rx), the axis each angle turns about: Z, then Rz·Y, then Rz·Ry·X.
    const q = new Quaternion();
    mesh.matrixWorld.decompose(new Vector3(), q, new Vector3());
    const dir = new Vector3().setComponent(hint.axis, 1);
    if (hint.frame === 'object') dir.applyQuaternion(q);
    else if (hint.frame === 'euler') {
      const e = new Euler().setFromQuaternion(q, 'ZYX');
      const partial = new Euler(0, hint.axis === 0 ? e.y : 0, hint.axis < 2 ? e.z : 0, 'ZYX');
      dir.applyEuler(partial);
    }
    // The gizmo's own frame: the axis is +Z; with all three axes, the object's own.
    const all = hint.kind === 'scale' && !!hint.all;
    if (all) g.quaternion.copy(q);
    else g.quaternion.setFromUnitVectors(new Vector3(0, 0, 1), dir.normalize().multiplyScalar(hint.reverse ? -1 : 1));
    const mat = new MeshBasicMaterial({ color: Viewport.AXIS_COLORS[hint.axis], depthTest: false, transparent: true, opacity: 0.92 });
    const Y = new Vector3(0, 1, 0);
    /** Cylinders and cones point along +Y; turn them towards `along`. */
    const add = (geo: BufferGeometry, at: Vector3, along?: Vector3, to: Group = g) => {
      const m = new Mesh(geo, mat.clone());
      m.position.copy(at);
      if (along) m.quaternion.setFromUnitVectors(Y, along);
      m.renderOrder = 11;
      to.add(m);
    };
    const Z = new Vector3(0, 0, 1),
      O = new Vector3();
    const HEAD = 18,
      HEAD_R = 7; // px
    if (hint.kind === 'rotate') {
      const R = 58,
        ARC = (150 * Math.PI) / 180;
      add(new CylinderGeometry(1, 1, R * 2.5, 8), O, Z);
      // Two arcs, each ending in a head along its tangent. render() turns them about the axis
      // so the heads sit nearest to and farthest from the camera, where they show from the side.
      const spin = (this.axisSpin = new Group());
      g.add(spin);
      for (const end of [0, Math.PI]) {
        const arc = new TorusGeometry(R, 1.7, 8, 48, ARC);
        arc.rotateZ(end - HEAD / 2 / R - ARC);
        add(arc, O, undefined, spin);
        add(
          new ConeGeometry(HEAD_R, HEAD, 16),
          new Vector3(Math.cos(end) * R, Math.sin(end) * R, 0),
          new Vector3(-Math.sin(end), Math.cos(end), 0),
          spin,
        );
      }
    } else if (hint.kind === 'move') {
      // One arrow, towards the positive direction; a short tail behind the center.
      const LEN = 96,
        TAIL = 26;
      add(new CylinderGeometry(1.7, 1.7, LEN - HEAD + TAIL, 8), new Vector3(0, 0, (LEN - HEAD - TAIL) / 2), Z);
      add(new ConeGeometry(HEAD_R, HEAD, 16), new Vector3(0, 0, LEN - HEAD / 2), Z);
    } else if (hint.kind === 'scale') {
      // A line with a cube at each end, as the scale gizmos of other 3D programs. Scaling
      // uniformly, all three axes show, the focused one stronger.
      const HALF = 80,
        CUBE = 11;
      for (const axis of all ? [0, 1, 2] : [hint.axis]) {
        const along = all ? new Vector3().setComponent(axis, 1) : Z;
        const from = g.children.length;
        add(new CylinderGeometry(1.7, 1.7, 2 * HALF, 8), O, along);
        for (const s of [1, -1]) add(new BoxGeometry(CUBE, CUBE, CUBE), along.clone().multiplyScalar(s * HALF));
        for (const m of g.children.slice(from) as Mesh<BufferGeometry, MeshBasicMaterial>[]) {
          m.material.color.setHex(Viewport.AXIS_COLORS[axis]!);
          if (axis !== hint.axis) {
            m.material.opacity = 0.4;
            m.renderOrder = 10;
          }
        }
      }
    } else {
      // The mirror plane, with an arrowhead towards it from each side.
      const SIDE = 84,
        GAP = 20;
      add(new BoxGeometry(SIDE, SIDE, 1.5), O);
      const plane = g.children[g.children.length - 1] as Mesh<BufferGeometry, MeshBasicMaterial>;
      plane.material.opacity = 0.4;
      plane.renderOrder = 8;
      // Its border.
      for (const [x, y] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        add(new BoxGeometry(x ? 1.5 : SIDE + 1.5, y ? 1.5 : SIDE + 1.5, 1.5), new Vector3((x * SIDE) / 2, (y * SIDE) / 2, 0));
        const bar = g.children[g.children.length - 1] as Mesh<BufferGeometry, MeshBasicMaterial>;
        bar.renderOrder = 8;
      }
      for (const s of [1, -1]) {
        add(new CylinderGeometry(1.7, 1.7, 30, 8), new Vector3(0, 0, s * (GAP + HEAD + 15)), Z);
        add(new ConeGeometry(HEAD_R, HEAD, 16), new Vector3(0, 0, s * (GAP + HEAD / 2)), new Vector3(0, 0, -s));
      }
    }
    mat.dispose();
  }

  /** Scale the axis hint so its pixel sizes hold at its distance from the camera, and turn its arrowheads into view. */
  private poseAxisHint() {
    const g = this.axisGizmo;
    if (!g.children.length) return;
    const h = this.canvas.clientHeight || 1;
    const at = g.getWorldPosition(new Vector3());
    const depth = at.sub(this.camera.position).dot(this.camera.getWorldDirection(new Vector3()));
    g.scale.setScalar((2 * Math.max(depth, this.camera.near) * Math.tan((this.camera.fov * Math.PI) / 360)) / this.camera.zoom / h);
    if (this.axisSpin) {
      g.updateWorldMatrix(true, false);
      const eye = g.worldToLocal(this.camera.position.clone());
      if (Math.hypot(eye.x, eye.y) > 1e-6) this.axisSpin.rotation.z = Math.atan2(eye.y, eye.x);
    }
  }

  // ── picking and dragging (prepare mode) ─────────────────────────────────────────────────
  private pointer(ev: PointerEvent): Vector2 {
    const r = this.canvas.getBoundingClientRect();
    return new Vector2(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
  }

  private pickBedPoint(ev: PointerEvent, z: number): Vector3 | null {
    this.ray.setFromCamera(this.pointer(ev), this.camera);
    const p = new Vector3();
    return this.ray.ray.intersectPlane(new Plane(new Vector3(0, 0, 1), -z), p) ? p : null;
  }

  private onDown = (ev: PointerEvent) => {
    if (this.mode !== 'prepare') return;
    if (this.painting) {
      this.paintDown(ev);
      return;
    }
    if (ev.button === 2) {
      this.rightDown = { x: ev.clientX, y: ev.clientY };
      return;
    }
    if (ev.button !== 0) return;
    const face = this.faceAt(ev);
    if (face >= 0 && this.faces) {
      this.events.layOnFace(this.faces.id, new Vector3(...this.faces.planes[face]!.normal));
      return;
    }
    this.ray.setFromCamera(this.pointer(ev), this.camera);
    // A support blocker or enforcer: selected, and dragged in a level plane through where it was taken.
    const vhit = this.volumesGroup.visible ? this.ray.intersectObjects(this.volumesGroup.children, false)[0] : undefined;
    if (vhit) {
      const { id, volume } = vhit.object.userData as { id: string; volume: string };
      this.events.selectVolume(id, volume);
      const start = this.pickBedPoint(ev, vhit.point.z);
      if (!start) return;
      const meshes = (this.volumesGroup.children as Mesh[])
        .filter((m) => (m.userData as { volume: string }).volume === volume && (m.userData as { id: string }).id === id)
        .map((mesh) => ({ mesh, matrix: mesh.matrix.clone() }));
      this.volumeDrag = { id, volume, start, meshes };
      this.canvas.style.cursor = 'grabbing';
      this.controls.enabled = false;
      this.canvas.setPointerCapture(ev.pointerId);
      return;
    }
    const hit = this.ray.intersectObjects(
      this.objectsGroup.children.filter((o) => (o as Mesh).isMesh && o.parent === this.objectsGroup),
      false,
    )[0];
    if (!hit) {
      this.downOnEmpty = { x: ev.clientX, y: ev.clientY };
      return;
    }
    const mesh = hit.object as Mesh;
    const { id, k } = mesh.userData as { id: string; k: number };
    // Ctrl (Cmd) adds to or takes from the selection, as desktop.
    if (ev.ctrlKey || ev.metaKey) {
      this.events.select(id, true);
      return;
    }
    // The object itself, also when one of its support volumes was selected.
    if (!this.selected.has(id) || this.selectedVolume) this.events.select(id, false);
    const start = this.pickBedPoint(ev, 0);
    if (!start) return;
    // Several objects selected: they move together. One: the instance clicked.
    const meshes =
      this.selected.size > 1
        ? [...this.selected].flatMap((sid) =>
            (this.meshes.get(sid) ?? []).map((m) => ({ id: sid, k: (m.userData as { k: number }).k, mesh: m, matrix: m.matrix.clone() })),
          )
        : [{ id, k, mesh, matrix: mesh.matrix.clone() }];
    this.drag = { start, meshes };
    this.canvas.style.cursor = 'grabbing';
    this.controls.enabled = false;
    this.canvas.setPointerCapture(ev.pointerId);
  };
  private downOnEmpty: { x: number; y: number } | null = null;
  private rightDown: { x: number; y: number } | null = null;

  private onMove = (ev: PointerEvent) => {
    if (this.stroke) {
      this.paintMove(ev);
      return;
    }
    const vd = this.volumeDrag;
    if (vd) {
      const p = this.pickBedPoint(ev, vd.start.z);
      if (!p) return;
      for (const x of vd.meshes) {
        x.mesh.matrix.copy(x.matrix);
        x.mesh.matrix.elements[12]! += p.x - vd.start.x;
        x.mesh.matrix.elements[13]! += p.y - vd.start.y;
        x.mesh.matrixWorldNeedsUpdate = true;
      }
      this.invalidate();
      return;
    }
    const d = this.drag;
    if (!d) return;
    const p = this.pickBedPoint(ev, 0);
    if (!p) return;
    for (const x of d.meshes) {
      const m = x.matrix.clone();
      m.elements[12]! += p.x - d.start.x;
      m.elements[13]! += p.y - d.start.y;
      x.mesh.matrix.copy(m);
      x.mesh.matrixWorldNeedsUpdate = true;
    }
    // The dragged instances' corners, and the axis hint and lay-on-face sides when their
    // instance (the first of the one selected object) is dragged.
    const by = new Vector3(p.x - d.start.x, p.y - d.start.y, 0);
    const dragged = new Set(d.meshes.map((x) => x.mesh));
    for (const c of this.selectionCorners.children) if (dragged.has((c.userData as { mesh: Mesh }).mesh)) c.position.copy(by);
    const only = this.selected.size === 1 ? this.meshes.get([...this.selected][0]!)?.[0] : undefined;
    const first = only && dragged.has(only) ? by : new Vector3();
    this.axisGroup.position.copy(first);
    this.facesGroup.position.copy(first);
    this.invalidate();
  };

  private onUp = (ev: PointerEvent) => {
    if (this.painting) {
      this.paintUp(ev);
      return;
    }
    if (this.rightDown && ev.button === 2) {
      // A right click (not a drag, which pans): the menu, for the object under the pointer.
      const moved = Math.hypot(ev.clientX - this.rightDown.x, ev.clientY - this.rightDown.y);
      this.rightDown = null;
      if (moved < 4) {
        const id = (this.hitTest(ev)?.userData as { id?: string } | undefined)?.id ?? null;
        if (id && !this.selected.has(id)) this.events.select(id, false);
        this.events.menu(id, ev.clientX, ev.clientY);
      }
      return;
    }
    if (this.downOnEmpty) {
      const moved = Math.hypot(ev.clientX - this.downOnEmpty.x, ev.clientY - this.downOnEmpty.y);
      this.downOnEmpty = null;
      if (moved < 4) this.events.select(null, false);
    }
    const vd = this.volumeDrag;
    if (vd) {
      this.volumeDrag = null;
      this.controls.enabled = true;
      this.canvas.style.cursor = '';
      if (this.canvas.hasPointerCapture(ev.pointerId)) this.canvas.releasePointerCapture(ev.pointerId);
      const first = vd.meshes[0];
      if (!first) return;
      const dx = first.mesh.matrix.elements[12]! - first.matrix.elements[12]!,
        dy = first.mesh.matrix.elements[13]! - first.matrix.elements[13]!;
      if (Math.hypot(dx, dy) > 1e-6) this.events.volumeMoved(vd.id, vd.volume, dx, dy);
      return;
    }
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    this.controls.enabled = true;
    this.canvas.style.cursor = this.hovered ? 'grab' : '';
    this.facesGroup.position.set(0, 0, 0);
    if (this.canvas.hasPointerCapture(ev.pointerId)) this.canvas.releasePointerCapture(ev.pointerId);
    const changed = d.meshes.filter((x) => !x.mesh.matrix.equals(x.matrix));
    if (changed.length) this.events.moved(changed.map((x) => ({ id: x.id, k: x.k, matrix: x.mesh.matrix.toArray() })));
  };

  /**
   * Render `frames` frames, one per animation frame, and report the interval between frames
   * (ms). Chrome runs WebGL in a separate GPU process and gl.finish() does not wait for it, so
   * the frame-to-frame interval is the meaningful number. For benchmarks/tests.
   */
  async benchmark(frames = 120, orbit = true): Promise<{ fps: number; p50: number; p95: number }> {
    const times: number[] = [];
    const t = this.controls.target.clone();
    const r = this.camera.position.clone().sub(t);
    const raf = () => new Promise<number>((res) => requestAnimationFrame(res));
    let last = await raf();
    for (let i = 0; i < frames; i++) {
      if (orbit) {
        const a = (i / frames) * Math.PI * 2;
        this.camera.position.set(t.x + r.x * Math.cos(a) - r.y * Math.sin(a), t.y + r.x * Math.sin(a) + r.y * Math.cos(a), t.z + r.z);
        this.camera.lookAt(t);
      }
      this.render();
      const now = await raf();
      times.push(now - last);
      last = now;
    }
    this.camera.position.copy(t.clone().add(r));
    this.controls.update();
    times.sort((a, b) => a - b);
    const p50 = times[Math.floor(times.length / 2)]!,
      p95 = times[Math.min(times.length - 1, Math.floor(times.length * 0.95))]!;
    return { fps: 1000 / p50, p50, p95 };
  }

  /**
   * Desktop's camera views (Camera::select_view): look at the current target from a side, at the
   * current distance; "plate" from where the page starts looking. (Desktop's side views are
   * orthographic; here the camera stays perspective.)
   */
  setView(view: 'plate' | 'top' | 'bottom' | 'front' | 'rear' | 'left' | 'right') {
    this.lookFrom(
      {
        plate: Viewport.HOME_DIRECTION.clone(),
        top: new Vector3(0, 0, 1),
        bottom: new Vector3(0, 0, -1),
        front: new Vector3(0, -1, 0),
        rear: new Vector3(0, 1, 0),
        left: new Vector3(-1, 0, 0),
        right: new Vector3(1, 0, 0),
      }[view],
    );
  }

  /** Look at the current target from a direction (the view cube's side, edge or corner), at the current distance. */
  lookFrom(dir: Vector3) {
    const d = dir.clone().normalize();
    // Straight up or down would leave the orbit's up direction undefined: a hair off it, from the front.
    if (Math.abs(d.z) > 0.9999) d.set(0, -1e-4, Math.sign(d.z)).normalize();
    const t = this.controls.target.clone();
    this.animateCamera(t, t.clone().addScaledVector(d, this.camera.position.distanceTo(t)));
  }

  // ── camera transitions ───────────────────────────────────────────────────────────────
  private cameraAnim = 0;
  private stopCameraAnimation() {
    cancelAnimationFrame(this.cameraAnim);
    this.cameraAnim = 0;
  }

  /**
   * Move the camera to look at `target` from `position` over ~0.35 s, turning about the target
   * (not straight through the scene); at once with reduced motion. Any orbit, pan or zoom stops it.
   */
  private animateCamera(target: Vector3, position: Vector3) {
    this.stopCameraAnimation();
    const t0 = this.controls.target.clone();
    const sph = (p: Vector3, t: Vector3) => {
      const o = p.clone().sub(t),
        r = o.length();
      return { r, theta: Math.atan2(o.y, o.x), phi: Math.acos(Math.min(1, Math.max(-1, o.z / r))) };
    };
    const a = sph(this.camera.position, t0),
      b = sph(position, target);
    // The shorter way round.
    let dTheta = b.theta - a.theta;
    dTheta = Math.atan2(Math.sin(dTheta), Math.cos(dTheta));
    const set = (k: number) => {
      const tt = t0.clone().lerp(target, k);
      const r = a.r + (b.r - a.r) * k,
        theta = a.theta + dTheta * k,
        phi = a.phi + (b.phi - a.phi) * k;
      this.controls.target.copy(tt);
      this.camera.position.set(
        tt.x + r * Math.sin(phi) * Math.cos(theta),
        tt.y + r * Math.sin(phi) * Math.sin(theta),
        tt.z + r * Math.cos(phi),
      );
      this.controls.update();
      this.invalidate();
    };
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return set(1);
    const start = performance.now(),
      MS = 350;
    const step = (now: number) => {
      const k = Math.min(1, (now - start) / MS);
      set(k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2);
      this.cameraAnim = k < 1 ? requestAnimationFrame(step) : 0;
    };
    this.cameraAnim = requestAnimationFrame(step);
  }

  /** The start view's direction: from the front and above. Fit view frames from here too. */
  static readonly HOME_DIRECTION = new Vector3(0, -1.4, 1.1).normalize();

  /** Frame the objects with these ids (desktop's zoom_to_selection), or the bed when none; from `dir`, or as now. */
  fitObjects(ids: string[], dir?: Vector3) {
    const box = new Box3();
    for (const id of ids)
      for (const m of this.meshes.get(id) ?? []) {
        m.updateMatrixWorld(true);
        box.expandByObject(m);
      }
    if (!box.isEmpty()) return this.frameBox({ min: box.min.toArray(), max: box.max.toArray() }, dir);
    this.fitBed(dir);
  }

  /** Frame the bed (desktop's zoom_to_bed); from `dir`, or keeping the viewing direction. */
  fitBed(dir?: Vector3) {
    const b = this.bed;
    if (!b) return this.resetCamera();
    this.frameBox({ min: [b.min[0], b.min[1], 0], max: [b.max[0], b.max[1], 0] }, dir);
  }

  /** Point the camera at a box (the G-code's extent); from `from`, or keeping the current viewing direction. */
  frameBox(bbox: { min: number[]; max: number[] } | null, from?: Vector3) {
    if (!bbox) return this.resetCamera();
    const min = new Vector3(bbox.min[0], bbox.min[1], bbox.min[2]);
    const max = new Vector3(bbox.max[0], bbox.max[1], bbox.max[2]);
    const c = min.clone().add(max).multiplyScalar(0.5);
    const radius = Math.max(min.distanceTo(max) / 2, 5);
    const dir = (from ?? this.camera.position.clone().sub(this.controls.target)).clone().normalize();
    const dist = (radius / Math.sin((this.camera.fov * Math.PI) / 360)) * 1.15;
    this.animateCamera(c, c.clone().add(dir.multiplyScalar(dist)));
  }
}
