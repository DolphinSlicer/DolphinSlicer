// Support painting (desktop's GLGizmoFdmSupports): a session on one object in the auxiliary
// engine (orca_paint_*), its strokes as plate changes (undo, the next slice), and the tool's
// settings. The 3D view sends the pointer's rays and draws what comes back (onPaintRender).
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { PaintEvent, PaintRender } from '../engine/protocol';
import type { Mat4, PaintData } from '../engine/types';
import { describeError } from '../ui/errors';
import { aux } from './actions';
import { loadedCounts, remember } from './history';
import { get, notify, type PaintSettings, type SceneObject, set, touchPlate, useApp } from './store';

/** Desktop's limits (GLGizmoPainterBase, TriangleSelectorPatch). */
export const PAINT_LIMITS = {
  radius: { min: 0.4, max: 8, step: 0.2 },
  smartFillAngle: { min: 0, max: 90, step: 1 },
  gapArea: { min: 0, max: 5, step: 0.2 },
  highlightAngle: { min: 0, max: 90, step: 1 },
} as const;

let session: { id: string; data: PaintData | undefined } | null = null;
const listeners = new Set<(r: PaintRender | null) => void>();
/** The painted triangles to draw (null: painting ended). */
export function onPaintRender(fn: (r: PaintRender | null) => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
const emit = (r: PaintRender | null) => {
  for (const fn of listeners) fn(r);
};

/**
 * The paint changed: draw it again, at most once a frame. The engine takes requests in order, so
 * the triangles fetched include every stroke sent before.
 */
let renderWanted = false,
  rendering = false;
function redraw() {
  renderWanted = true;
  if (rendering) return;
  rendering = true;
  requestAnimationFrame(async () => {
    try {
      while (renderWanted && session) {
        renderWanted = false;
        const r = await aux.call('paintRender', {});
        if (session) emit(r);
      }
    } catch {
      /* painting ended */
    } finally {
      rendering = false;
      renderWanted = false;
    }
  });
}

const object = (id: string) => get().objects.find((o) => o.id === id);

/** The file an object is from, and its index in that file. */
function source(o: SceneObject) {
  let first = 0;
  for (let i = 0; i < loadedCounts.length; i++) {
    if (o.index < first + loadedCounts[i]!) return { file: get().files[i]!, local: o.index - first };
    first += loadedCounts[i]!;
  }
  return null;
}

/**
 * Desktop's starting highlight: the support threshold angle when supports are generated
 * automatically, else none (GLGizmoFdmSupports::get_selection_support_threshold_angle).
 */
function supportThreshold(): number {
  let cfg: Record<string, unknown> = {};
  try {
    cfg = JSON.parse(get().presets.config ?? '{}') as Record<string, unknown>;
  } catch {
    /* none */
  }
  const on = cfg.enable_support === true || cfg.enable_support === '1' || cfg.enable_support === 1;
  const auto = String(cfg.support_type ?? '').endsWith('(auto)');
  const angle = Number(cfg.support_threshold_angle);
  return on && auto && Number.isFinite(angle) ? angle : 0;
}

/** Desktop's get_highlight_angle_limit_deg: one degree more, so the threshold counts. */
export const overhangLimit = (angle: number) => (angle > 0 ? Math.min(angle + 1, 90) : 0);

async function open(o: SceneObject) {
  const src = source(o);
  if (!src) throw new Error('The object’s file is not on the plate');
  const r = await aux.call('paintOpen', {
    file: { name: src.file.name, bytes: src.file.bytes },
    object: src.local,
    instances: o.instances,
    supports: o.supports,
  });
  session = { id: o.id, data: o.supports };
  const s = get().paint;
  if (s.tool === 'gap_fill') emit(await aux.call('paintGap', { preview: s.gapArea }));
  else emit(r);
}

/** Desktop's support painting on the selected object (the L key). */
export async function startPainting() {
  const s = get();
  const o = s.selected.length === 1 ? object(s.selected[0]!) : undefined;
  if (!o || s.view !== 'prepare') return;
  set({ painting: o.id, layOnFace: false, menu: null, paint: { ...s.paint, highlightAngle: supportThreshold() } });
  try {
    await open(o);
  } catch (e) {
    notify({ kind: 'error', ...describeError(e) });
    stopPainting();
  }
}

export function stopPainting() {
  if (!get().painting && !session) return;
  session = null;
  set({ painting: null });
  emit(null);
  void aux.call('paintClose', {}).catch(() => {
    /* gone with the engine */
  });
}

export const togglePainting = () => (get().painting ? stopPainting() : void startPainting());

/** The paint as it is now in the engine: a step of the plate's history. */
async function commit() {
  const id = session?.id;
  if (!id) return;
  const data = await aux.call('paintData', {});
  const o = object(id);
  if (!o || session?.id !== id) return;
  // Nothing changed (a click beside the paint, say): no step.
  if (JSON.stringify(data) === JSON.stringify(o.supports ?? (o.painted ? null : data.map(() => [])))) {
    session.data = o.supports;
    return;
  }
  remember();
  const painted = data.some((part) => part.length > 0);
  session.data = data;
  set((s) => ({ objects: s.objects.map((x) => (x.id === id ? { ...x, supports: data, painted } : x)) }));
  touchPlate();
}

/** The 3D view's pointer over the painted object: hover, press and drag (desktop's gizmo_event). */
export async function paintPointer(ev: {
  action: PaintEvent['action'];
  button?: 'left' | 'right';
  erase?: boolean;
  rays: number[][];
  camera: [number, number, number];
}) {
  const id = session?.id;
  const o = id ? object(id) : undefined;
  const s = get().paint;
  if (!o || s.tool === 'gap_fill') return null;
  const tool = s.tool;
  try {
    const r = await aux.call('paintEvent', {
      event: {
        ...ev,
        tool,
        radius: s.radius,
        smart_fill_angle: s.smartFillAngle,
        overhang_limit: s.overhangsOnly ? overhangLimit(s.highlightAngle) : 0,
        instances: o.instances as Mat4[],
      },
    });
    if (r.changed && session?.id === id) {
      redraw();
      if (ev.action !== 'move') strokeChanged = true;
    }
    return r;
  } catch (e) {
    notify({ kind: 'error', ...describeError(e) });
    return null;
  }
}

/** The stroke touched the paint (a press beside the object didn't). */
let strokeChanged = false;

/** A stroke ended (the button let go). */
export function endStroke() {
  if (!strokeChanged) return;
  strokeChanged = false;
  void commit().catch((e) => notify({ kind: 'error', ...describeError(e) }));
}

/** Desktop's Erase all. */
export async function eraseAllPaint() {
  if (!session) return;
  emit(await aux.call('paintReset', {}));
  if (get().paint.tool === 'gap_fill') emit(await aux.call('paintGap', { preview: get().paint.gapArea }));
  await commit();
}

/** Gap fill's Apply. */
export async function applyGapFill() {
  if (!session) return;
  const area = get().paint.gapArea;
  emit(await aux.call('paintGap', { apply: area, preview: area }));
  await commit();
}

export function setPaint(patch: Partial<PaintSettings>) {
  const prev = get().paint;
  const next = { ...prev, ...patch };
  // Vertical and Horizontal exclude each other, as on desktop.
  if (patch.vertical) next.horizontal = false;
  if (patch.horizontal) next.vertical = false;
  set({ paint: next });
  if (!session) return;
  // Another tool or fill angle: the fill's preview goes (desktop clears it then).
  if (
    prev.tool === 'fill' &&
    (next.tool !== 'fill' || next.smartFillAngle !== prev.smartFillAngle || next.overhangsOnly !== prev.overhangsOnly)
  )
    void aux
      .call('paintEvent', {
        event: { action: 'clear', tool: 'fill', rays: [], camera: [0, 0, 0], radius: 0, smart_fill_angle: 0, overhang_limit: 0 },
      })
      .then(
        (r) => {
          if (r.changed) redraw();
        },
        () => {},
      );
  // Gap fill shows what it would do; the other tools show the paint as it is.
  if (next.tool === 'gap_fill' && (prev.tool !== 'gap_fill' || next.gapArea !== prev.gapArea))
    void aux.call('paintGap', { preview: next.gapArea }).then(emit, () => {});
  else if (prev.tool === 'gap_fill' && next.tool !== 'gap_fill') void aux.call('paintGap', { preview: null }).then(emit, () => {});
}

/** Ctrl and the mouse wheel: the brush's size, the fill's angle or the gap area (desktop's). */
export function paintWheel(up: boolean) {
  const s = get().paint;
  const step = (k: 'radius' | 'smartFillAngle' | 'gapArea') => {
    const l = PAINT_LIMITS[k];
    setPaint({ [k]: Math.round(Math.min(l.max, Math.max(l.min, s[k] + (up ? l.step : -l.step))) * 100) / 100 });
  };
  if (s.tool === 'circle' || s.tool === 'sphere') step('radius');
  else if (s.tool === 'fill') step('smartFillAngle');
  else step('gapArea');
}

// The session follows the plate: undo and redo give the object other paint; another selection,
// view or the object gone ends it.
useApp.subscribe((s, prev) => {
  if (!s.painting) return;
  const o = object(s.painting);
  if (!o || s.view !== 'prepare' || s.selected.length !== 1 || s.selected[0] !== s.painting) {
    stopPainting();
    return;
  }
  if (session && s.objects !== prev.objects && o.supports !== session.data) {
    // The object stays open in the engine; only its paint changes.
    session.data = o.supports;
    void aux
      .call('paintSet', { supports: o.supports })
      .then((r) => {
        if (session?.id === o.id) emit(r);
      })
      .catch((e) => {
        notify({ kind: 'error', ...describeError(e) });
        stopPainting();
      });
  }
});
