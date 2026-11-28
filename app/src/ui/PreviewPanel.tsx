// G-code preview controls: color view and its legend, layer range, feature visibility, travel moves, statistics.
// SPDX-License-Identifier: AGPL-3.0-or-later
import { Pause, Play } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { debugMode } from '../engine/capabilities';
import { hexColor, RANGE_COLORS, rangeValues, SPEED_VIEWS, VIEWS, type ViewType, viewRange } from '../gcode/colors';
import { ROLE_COLORS, ROLES } from '../gcode/parse';
import type { PreviewData } from '../gcode/preview';
import { bcp47, N_, t, tr } from '../i18n/i18n';
import { onPreviewData, parsedGcode } from '../state/actions';
import { formatLength, formatMoney, formatNumber, formatWeight, type Prefs } from '../state/prefs';
import { isStale, useApp } from '../state/store';
import { formatBytes, formatDuration } from './format';
import { Select } from './Select';
import { viewport } from './ViewportView';

const CUSTOM = ROLES.indexOf('Custom');

/** A range view's legend, highest value first (desktop's append_range); null for the other views. */
function rangeLegend(g: PreviewData, view: ViewType, shown: { travel: boolean; custom: boolean }) {
  const vr = viewRange(g, view, shown);
  if (!vr) return null;
  const digits = VIEWS.find((v) => v.id === view)!.decimals ?? 0;
  const values = rangeValues(vr.range, vr.log);
  const last = RANGE_COLORS.length - 1;
  const colorOf = (i: number) => RANGE_COLORS[values.length === 2 ? (i ? last : 0) : i]!;
  return values.map((v, i) => ({ color: colorOf(i), label: formatNumber(v, digits) })).reverse();
}

/** The Filament view's legend: each filament used, its color and how much of it (desktop's ColorPrint rows). */
function FilamentLegend({ g, prefs }: { g: PreviewData; prefs: Prefs }) {
  const used = g.meta.filaments.filter((f) => g.extrudersUsed.includes(f.id));
  const amount = (m: number, grams: number) => `${formatLength(m * 1000, prefs.units, 'filament')} · ${formatWeight(grams, prefs.units)}`;
  return (
    <ul className="legend values" data-testid="preview-filaments">
      {g.extrudersUsed.map((id) => {
        const f = used.find((x) => x.id === id);
        return (
          <li key={id}>
            <span className="swatch" style={{ background: `rgb(${hexColor(g.meta.tool_colors[id]).join(',')})` }} />
            <span>{id + 1}</span>
            {f && <span className="amount">{amount(f.m, f.g)}</span>}
          </li>
        );
      })}
      {used.length > 1 && (
        <li>
          <span className="swatch none" />
          <span>{tr('Total')}</span>
          <span className="amount">
            {amount(
              used.reduce((a, f) => a + f.m, 0),
              used.reduce((a, f) => a + f.g, 0),
            )}
          </span>
        </li>
      )}
    </ul>
  );
}

/** The line types switched off in the 3D view. */
function hiddenRoles(): Set<number> {
  const shown = viewport()?.gcode.roleVisible;
  return new Set(shown ? [...shown].flatMap((v, i) => (v ? [] : [i])) : []);
}

export function PreviewPanel() {
  const preview = useApp((s) => s.preview);
  const sliceState = useApp((s) => s.slice);
  const stale = useApp(isStale);
  const prefs = useApp((s) => s.prefs);
  const lang = bcp47(useApp((s) => s.lang));
  // What is shown lives in the 3D view (it outlives this panel): the layers and the boxes start from it.
  const [range, setRange] = useState<[number, number]>(() => [...(viewport()?.gcode.layerRange ?? [0, 0])] as [number, number]);
  const [hidden, setHidden] = useState<Set<number>>(hiddenRoles);
  const [travel, setTravel] = useState(() => viewport()?.gcode.showTravel ?? false);
  /** Seconds into the top layer the print is shown up to (Infinity: all of it). */
  const [time, setTime] = useState(Infinity);
  const [playing, setPlaying] = useState(false);
  const [, force] = useState(0);
  const [bench, setBench] = useState<string | null>(null);

  useEffect(() => {
    const off = onPreviewData(() => {
      const n = parsedGcode?.layerCount ?? 0;
      setRange([0, Math.max(0, n - 1)]);
      setTime(Infinity);
      setPlaying(false);
      setHidden(hiddenRoles());
      setTravel(viewport()?.gcode.showTravel ?? false);
      force((x) => x + 1);
    });
    return () => {
      off();
    };
  }, []);
  useEffect(() => {
    const vp = viewport();
    if (!vp) return;
    vp.gcode.setRange(range[0], range[1], time);
    vp.invalidate();
  }, [range, time, preview.ready]);

  // Playing: the clock runs in real time; at a layer's end the next one begins.
  const now = useRef({ range, time });
  now.current = { range, time };
  useEffect(() => {
    if (!playing) return;
    let last = performance.now(),
      frame = 0;
    const tick = (at: number) => {
      const g = parsedGcode;
      if (!g) return setPlaying(false);
      let [lo, hi] = now.current.range;
      let next = (now.current.time === Infinity ? 0 : now.current.time) + (at - last) / 1000;
      last = at;
      while (next >= g.layerPathTime[hi]! && hi < g.layerCount - 1) next -= g.layerPathTime[hi++]!;
      if (next >= g.layerPathTime[hi]!) {
        setTime(Infinity);
        setPlaying(false);
        return;
      }
      if (hi !== now.current.range[1]) setRange([lo, hi]);
      setTime(next);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing]);
  // A layer picked by hand: shown whole.
  const pickLayers = useCallback((v: [number, number]) => {
    setPlaying(false);
    setTime(Infinity);
    setRange(v);
  }, []);

  const g = parsedGcode;
  const n = g?.layerCount ?? 0;
  const toggle = (r: number) => {
    const next = new Set(hidden);
    if (next.has(r)) next.delete(r);
    else next.add(r);
    setHidden(next);
    viewport()?.gcode.setRoleVisible(r, !next.has(r));
    viewport()?.invalidate();
  };
  const stats = sliceState.state === 'done' ? sliceState.stats : null;
  // The color view lives in the 3D view too.
  const view: ViewType = viewport()?.gcode.view ?? 'feature';
  const pickView = (v: ViewType) => {
    viewport()?.gcode.setView(v);
    viewport()?.invalidate();
    force((x) => x + 1);
  };
  const setTravelShown = (on: boolean) => {
    setTravel(on);
    viewport()?.gcode.setTravel(on);
    viewport()?.invalidate();
  };
  const travelItem = (
    <li>
      <label>
        <input type="checkbox" checked={travel} onChange={(e) => setTravelShown(e.target.checked)} />
        <span className="swatch" style={{ background: 'rgb(56,72,155)' }} />
        {t('Travel')}
      </label>
    </li>
  );
  const scale = g ? rangeLegend(g, view, { travel, custom: !hidden.has(CUSTOM) }) : null;
  const z = (i: number) => (g && g.layerZ[i] !== undefined ? formatLength(g.layerZ[i]!, prefs.units, 'size') : '');

  return (
    <>
      <div className="preview-legend card" data-testid="preview-legend">
        {g && (
          <>
            <Select
              className="view-type"
              value={view}
              onChange={(v) => pickView(v as ViewType)}
              aria-label={tr('Preview')}
              data-testid="preview-view"
              items={VIEWS.map((v) => ({ value: v.id, label: tr(v.name) }))}
            />
            {view === 'feature' && (
              <ul className="legend">
                {g.rolesPresent.map((r) => (
                  <li key={r}>
                    <label>
                      <input type="checkbox" checked={!hidden.has(r)} onChange={() => toggle(r)} />
                      <span className="swatch" style={{ background: `rgb(${ROLE_COLORS[r]!.join(',')})` }} />
                      {tr(ROLES[r]!)}
                    </label>
                  </li>
                ))}
                {travelItem}
              </ul>
            )}
            {view === 'filament' && <FilamentLegend g={g} prefs={prefs} />}
            {scale && (
              <>
                <h3>{tr(VIEWS.find((v) => v.id === view)!.title!)}</h3>
                <ul className="legend values" data-testid="preview-range">
                  {scale.map((it, i) => (
                    <li key={i}>
                      <span className="swatch" style={{ background: `rgb(${it.color.join(',')})` }} />
                      {it.label}
                    </li>
                  ))}
                </ul>
                {SPEED_VIEWS.has(view) && <ul className="legend">{travelItem}</ul>}
              </>
            )}
          </>
        )}
        {stale && <p className="warning small">{t('The plate changed since this slice.')}</p>}
        {stats && stats.print_time_s > 0 && (
          <dl className="stats">
            <dt>{t('Print time')}</dt>
            <dd>{formatDuration(stats.print_time_s)}</dd>
            <dt>{t('Filament')}</dt>
            <dd>
              {formatLength(stats.filament_mm, prefs.units, 'filament')} · {formatWeight(stats.filament_g, prefs.units)}
            </dd>
            {stats.cost > 0 && (
              <>
                <dt>{t('Cost')}</dt>
                <dd>{formatMoney(stats.cost, prefs.currency, lang)}</dd>
              </>
            )}
          </dl>
        )}
        {g && (
          <>
            {debugMode() && (
              <p className="small">
                <button
                  onClick={async () => {
                    setBench('measuring…');
                    const r = await viewport()?.benchmark(120);
                    setBench(r ? `${r.fps.toFixed(0)} fps (p50 ${r.p50.toFixed(1)} ms, p95 ${r.p95.toFixed(1)} ms)` : 'no viewport');
                  }}
                  data-testid="bench"
                >
                  Measure frame rate
                </button>{' '}
                {bench}
              </p>
            )}
            {debugMode() && (
              <p className="muted small">
                {g.segCount.toLocaleString()} moves · {sliceState.state === 'done' ? formatBytes(sliceState.gcodeBytes) : ''}
                {preview.parseMs !== undefined ? ` · read in ${(preview.parseMs / 1000).toFixed(2)} s` : ''}
              </p>
            )}
          </>
        )}
      </div>
      {g && n > 0 && (
        <div className="layer-slider card" data-testid="layer-slider">
          <div className="layer-label">
            {range[1] + 1}
            <span className="of"> / {n}</span>
            <br />
            <span className="muted small">{z(range[1])}</span>
          </div>
          <LayerRange count={n} value={range} onChange={pickLayers} />
          <div className="layer-label">
            {range[0] + 1}
            <br />
            <span className="muted small">{z(range[0])}</span>
          </div>
        </div>
      )}
      {g && n > 0 && (
        <LayerPlayer
          g={g}
          layer={range[1]}
          time={time}
          playing={playing}
          onTime={(v) => {
            setPlaying(false);
            setTime(v);
          }}
          onPlay={(on) => {
            // From the layer's start when all of it is shown.
            if (on && (time === Infinity || time >= (g.layerPathTime[range[1]] ?? 0))) setTime(0);
            setPlaying(on);
          }}
        />
      )}
    </>
  );
}

/**
 * The top layer's moves in time: a play button that prints it in real time (going on with the
 * next layers), and a slider to any moment of it. Arrow keys step from move to move.
 */
function LayerPlayer({
  g,
  layer,
  time,
  playing,
  onTime,
  onPlay,
}: {
  g: PreviewData;
  layer: number;
  time: number;
  playing: boolean;
  onTime: (t: number) => void;
  onPlay: (on: boolean) => void;
}) {
  const track = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const total = g.layerPathTime[layer] ?? 0;
  const cur = Math.min(time, total);
  const pct = total > 0 ? (cur / total) * 100 : 100;
  const first = g.layerPathStart[layer]!,
    end = g.layerPathStart[layer + 1]!;

  const at = (clientX: number) => {
    const r = track.current!.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    return f >= 1 ? Infinity : f * total;
  };
  /** The end of the next (or previous) move from the time shown. */
  const step = (dir: 1 | -1) => {
    const t1 = g.path.t1;
    if (dir > 0) {
      for (let m = first; m < end; m++) if (t1[m]! > cur + 1e-6) return onTime(m === end - 1 ? Infinity : t1[m]!);
      return onTime(Infinity);
    }
    for (let m = end - 1; m >= first; m--) if (t1[m]! < cur - 1e-6) return onTime(t1[m]!);
    onTime(0);
  };
  const key = (e: React.KeyboardEvent) => {
    switch (e.key) {
      case 'ArrowRight':
      case 'ArrowUp':
        step(1);
        break;
      case 'ArrowLeft':
      case 'ArrowDown':
        step(-1);
        break;
      case 'Home':
        onTime(0);
        break;
      case 'End':
        onTime(Infinity);
        break;
      default:
        return;
    }
    e.preventDefault();
  };
  const label = tr(N_('Play'));
  return (
    <div className="layer-player card" data-testid="layer-player">
      <button
        type="button"
        className="icon-btn"
        aria-label={playing ? t('Pause') : label}
        data-tip={playing ? t('Pause') : label}
        aria-pressed={playing}
        onClick={() => onPlay(!playing)}
        disabled={!total}
        data-testid="play"
      >
        {playing ? <Pause size={16} /> : <Play size={16} />}
      </button>
      <div
        className="hrange"
        ref={track}
        onPointerDown={(e) => {
          dragging.current = true;
          onTime(at(e.clientX));
          track.current!.setPointerCapture(e.pointerId);
          track.current!.querySelector<HTMLElement>('.thumb')?.focus();
        }}
        onPointerMove={(e) => {
          if (dragging.current) onTime(at(e.clientX));
        }}
        onPointerUp={(e) => {
          dragging.current = false;
          if (track.current!.hasPointerCapture(e.pointerId)) track.current!.releasePointerCapture(e.pointerId);
        }}
        onWheel={(e) => step(e.deltaY < 0 ? 1 : -1)}
      >
        <div className="rail" />
        <div className="fill" style={{ width: `${pct}%` }} />
        <div
          className="thumb"
          role="slider"
          tabIndex={0}
          aria-label={t('Time in the layer')}
          aria-valuemin={0}
          aria-valuemax={Math.round(total)}
          aria-valuenow={Math.round(cur)}
          aria-valuetext={`${formatDuration(cur)} / ${formatDuration(total)}`}
          style={{ left: `${pct}%` }}
          onKeyDown={key}
          data-testid="layer-time"
        />
      </div>
      <span className="player-time" data-testid="layer-time-label">
        {formatDuration(cur)} <span className="muted">/ {formatDuration(total)}</span>
      </span>
    </div>
  );
}

/**
 * One vertical track with two handles: the bottom and top visible layer (0-based, inclusive).
 * Drag a handle, click the track to move the nearest handle there, or use the keyboard (arrows,
 * Page Up/Down, Home/End) on a focused handle. The wheel over the slider moves the top handle.
 */
function LayerRange({ count, value, onChange }: { count: number; value: [number, number]; onChange: (v: [number, number]) => void }) {
  const track = useRef<HTMLDivElement>(null);
  const drag = useRef<0 | 1 | null>(null);
  const max = Math.max(1, count - 1);
  const [lo, hi] = value;
  const pct = (v: number) => (v / max) * 100;

  const valueAt = (clientY: number) => {
    const r = track.current!.getBoundingClientRect();
    const f = 1 - (clientY - r.top) / r.height; // bottom = layer 0
    return Math.round(Math.min(1, Math.max(0, f)) * max);
  };
  const set = (which: 0 | 1, v: number) => {
    v = Math.max(0, Math.min(max, v));
    if (which === 1) onChange([Math.min(lo, v), v]);
    else onChange([v, Math.max(hi, v)]);
  };
  const startDrag = (which: 0 | 1, e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    drag.current = which;
    (e.target as HTMLElement).focus();
    track.current!.setPointerCapture(e.pointerId);
  };
  const key = (which: 0 | 1, e: React.KeyboardEvent) => {
    const cur = which === 1 ? hi : lo;
    const page = Math.max(1, Math.round(count / 10));
    const next = {
      ArrowUp: cur + 1,
      ArrowRight: cur + 1,
      ArrowDown: cur - 1,
      ArrowLeft: cur - 1,
      PageUp: cur + page,
      PageDown: cur - page,
      Home: 0,
      End: max,
    }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    set(which, next);
  };
  const thumb = (which: 0 | 1, v: number, label: string) => (
    <div
      className={`thumb${which === 1 ? ' top' : ''}`}
      role="slider"
      tabIndex={0}
      aria-label={label}
      aria-valuemin={1}
      aria-valuemax={count}
      aria-valuenow={v + 1}
      aria-orientation="vertical"
      style={{ bottom: `${pct(v)}%` }}
      onPointerDown={(e) => startDrag(which, e)}
      onKeyDown={(e) => key(which, e)}
    />
  );
  return (
    <div
      className="range"
      ref={track}
      onPointerDown={(e) => {
        // Click on the track: move the nearest handle there and keep dragging it.
        const v = valueAt(e.clientY);
        const which: 0 | 1 = Math.abs(v - hi) <= Math.abs(v - lo) ? 1 : 0;
        set(which, v);
        drag.current = which;
        track.current!.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (drag.current !== null) set(drag.current, valueAt(e.clientY));
      }}
      onPointerUp={(e) => {
        drag.current = null;
        if (track.current!.hasPointerCapture(e.pointerId)) track.current!.releasePointerCapture(e.pointerId);
      }}
      onWheel={(e) => set(1, hi + (e.deltaY < 0 ? 1 : -1))}
    >
      <div className="rail" />
      <div className="fill" style={{ bottom: `${pct(lo)}%`, height: `${pct(hi) - pct(lo)}%` }} />
      {thumb(0, lo, t('Bottom layer'))}
      {thumb(1, hi, t('Top layer'))}
    </div>
  );
}
