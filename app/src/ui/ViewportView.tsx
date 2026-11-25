// SPDX-License-Identifier: AGPL-3.0-or-later

import { House } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Matrix4 } from 'three';
import { planesInWorker } from '../model/geometryWorker';
import type { FacePlane } from '../model/layOnFace';
import { geometries, isOnBed, onPreviewData, parsedGcode } from '../state/actions';
import { endStroke, onPaintRender, overhangLimit, paintPointer, paintWheel } from '../state/paintActions';
import { layOnFace, moveInstances, select } from '../state/plate';
import { set, useApp } from '../state/store';

/** Lay-on-face sides per mesh and rotation (the last few). */
const planeCache = new Map<string, FacePlane[]>();

import { t } from '../i18n/i18n';
import { isDark, onSystemScheme } from '../state/prefs';
import { Viewport } from '../view/Viewport';

let current: Viewport | null = null;
/** The live viewport (for the preview controls and for benchmarks/tests). */
export const viewport = () => current;

export function ViewportView() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const home = useRef<HTMLButtonElement>(null);
  const view = useApp((s) => s.view);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    let vp: Viewport;
    try {
      vp = createViewport(canvas.current!);
    } catch (e) {
      // No WebGL (disabled, blocklisted GPU, some VMs): everything except the 3D view still works.
      setFailed(String((e as Error)?.message ?? e));
      return;
    }
    return bindViewport(vp, home.current!);
  }, []);
  return (
    <>
      <canvas ref={canvas} className="viewport" data-testid="viewport" hidden={!!failed} />
      {/* Back to the default view (the 0 key), at the view cube's corner (placed in bindViewport). */}
      <button
        ref={home}
        type="button"
        className="icon-btn small view-home"
        hidden={!!failed || (view !== 'prepare' && view !== 'preview')}
        aria-label={t('Default view')}
        data-tip={`${t('Default view')} (0)`}
        data-testid="view-home"
        onClick={() => current?.home()}
      >
        <House size={15} />
      </button>
      {failed && (
        <div className="no-webgl" role="note" data-testid="no-webgl">
          <p>
            <strong>{t('3D view unavailable')}</strong>
          </p>
          <p className="muted">
            {t(
              'This browser could not start WebGL, so models and G-code cannot be shown. Importing, slicing and exporting G-code still work.',
            )}
          </p>
          <details>
            <summary>{t('Details')}</summary>
            <pre>{failed}</pre>
          </details>
        </div>
      )}
    </>
  );
}

function createViewport(canvas: HTMLCanvasElement): Viewport {
  return new Viewport(canvas, {
    select: (id, toggle) => select(id, toggle ? 'toggle' : 'replace'),
    // Dragging only translates in XY, so the objects stay on the bed.
    moved: moveInstances,
    isOnBed,
    menu: (id, x, y) => set({ menu: { id, x, y } }),
    layOnFace,
    paint: (ev) => paintPointer(ev),
    paintEnd: endStroke,
    paintWheel,
  });
}

function bindViewport(vp: Viewport, home: HTMLButtonElement): () => void {
  current = vp;
  // Test/benchmark hook: the live viewport and store.
  (window as unknown as { __orca?: object }).__orca = { viewport: vp, store: useApp };
  const scheme = () => vp.setDark(isDark(useApp.getState().prefs.theme));
  const offScheme = onSystemScheme(scheme);
  const apply = () => {
    const s = useApp.getState();
    scheme();
    vp.setBed(s.presets.bed);
    vp.setObjects(s.objects, geometries, s.selected);
    if (s.view === 'prepare' || s.view === 'preview') vp.setMode(s.view);
  };
  apply();
  vp.setAxisHint(useApp.getState().axisHint);
  // Support painting: the object, the tool, the overhangs and the paint.
  const painting = () => {
    const s = useApp.getState();
    vp.setPainting(s.painting ? { id: s.painting, brush: s.paint, highlightLimit: overhangLimit(s.paint.highlightAngle) } : null);
  };
  painting();
  const offPaint = onPaintRender((r) => {
    if (r) vp.setPaintRender(r);
  });
  // The view cube: its sides' names, and its place in the lower left corner beside the panels
  // (above them on narrow screens, where they sit at the bottom).
  const cubeLabels = () =>
    vp.setCubeLabels({ top: t('Top'), bottom: t('Bottom'), front: t('Front'), rear: t('Rear'), left: t('Left'), right: t('Right') });
  cubeLabels();
  const placeCube = () => {
    const c = vp.renderer.domElement.getBoundingClientRect();
    const cards = [...document.querySelectorAll('.dock > *')].map((e) => e.getBoundingClientRect()).filter((r) => r.height > 0);
    if (!c.width) return;
    // In the corner, unless a panel covers it: then beside the panels, or above them on narrow
    // screens (where they sit at the bottom).
    const size = vp.cube.size,
      gap = 8;
    const covered = cards.some((r) => r.bottom > c.bottom - gap - size && r.left < c.left + gap + size && r.right > c.left);
    const side = cards.length > 0 && cards[0]!.right < c.left + c.width / 2;
    if (!covered) vp.setCubeAt(gap, gap);
    else if (side) vp.setCubeAt(Math.round(Math.max(...cards.map((r) => r.right)) - c.left + 12), gap);
    else vp.setCubeAt(gap, Math.round(c.bottom - Math.min(...cards.map((r) => r.top)) + 12));
    home.style.left = `${vp.cube.left}px`;
    home.style.bottom = `${vp.cube.bottom + vp.cube.size - 12}px`;
  };
  const cubeObs = new ResizeObserver(placeCube);
  cubeObs.observe(vp.renderer.domElement);
  for (const card of document.querySelectorAll('.dock > *')) cubeObs.observe(card);
  requestAnimationFrame(placeCube);
  const unsub = useApp.subscribe((s, prev) => {
    if (s.presets.bed !== prev.presets.bed) vp.setBed(s.presets.bed);
    if (s.objects !== prev.objects || s.selected !== prev.selected || s.presets.bed !== prev.presets.bed)
      vp.setObjects(s.objects, geometries, s.selected);
    if (s.view !== prev.view && (s.view === 'prepare' || s.view === 'preview')) vp.setMode(s.view);
    if (s.prefs.theme !== prev.prefs.theme) scheme();
    if (s.axisHint !== prev.axisHint) vp.setAxisHint(s.axisHint);
    if (s.lang !== prev.lang) cubeLabels();
    if (s.objects.length !== prev.objects.length) requestAnimationFrame(placeCube);
    if (s.layOnFace !== prev.layOnFace || (s.layOnFace && (s.objects !== prev.objects || s.selected !== prev.selected))) faces();
    if (s.painting !== prev.painting) painting();
    else if (s.painting && s.paint !== prev.paint) {
      vp.setPaintBrush(s.paint);
      if (s.paint.highlightAngle !== prev.paint.highlightAngle) vp.setPaintHighlight(overhangLimit(s.paint.highlightAngle));
    }
  });
  // Lay on face: the sides of the selected object's first instance, under its rotation and scale
  // (worked out in the geometry worker; kept per mesh and rotation, so moving it costs nothing).
  let asked = '';
  const faces = () => {
    const s = useApp.getState();
    const o = s.layOnFace && s.selected.length === 1 ? s.objects.find((x) => x.id === s.selected[0]) : undefined;
    const g = o && geometries.get(o.id);
    if (!o || !g) {
      asked = '';
      vp.setLayOnFace(null);
      return;
    }
    const linear = new Matrix4().fromArray(o.instances[0]!).setPosition(0, 0, 0);
    const shape = `${g.uuid}|${linear.elements.join(',')}`,
      key = `${o.id}|${shape}`;
    if (key === asked) return;
    asked = key;
    vp.setLayOnFace(null);
    const cached = planeCache.get(shape);
    const done = (planes: FacePlane[]) => {
      planeCache.set(shape, planes);
      if (planeCache.size > 8) planeCache.delete(planeCache.keys().next().value!);
      if (asked === key) vp.setLayOnFace({ id: o.id, planes });
    };
    if (cached) done(cached);
    else
      planesInWorker(g, linear).then(done, () => {
        if (asked === key) asked = '';
      });
  };
  const unsubPreview = onPreviewData(() => {
    vp.gcode.set(parsedGcode);
    // A sliced plate's G-code is where the objects were: keep the user's view. An opened file
    // can be anywhere, so frame it.
    if (parsedGcode?.segCount && useApp.getState().gcodeFromFile) vp.frameBox(parsedGcode.bbox);
    vp.invalidate();
  });
  return () => {
    unsub();
    unsubPreview();
    offPaint();
    offScheme();
    cubeObs.disconnect();
    vp.dispose();
    current = null;
  };
}
