// Editors for the bed geometry settings: printable area (bed shape), excluded bed area and
// toolhead collision volumes. Each setting row shows a summary; "Edit" opens one dialog with a
// live preview of the whole bed. Values are read and written in desktop's formats
// (settings/bedGeometry.ts).
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Circle, Pencil, Plus, Shapes, Square, Trash2, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { N_, t } from '../i18n/i18n';
import {
  asRect,
  type BedShape,
  bbox,
  detectShape,
  fmt,
  formatVolumes,
  isPolygon,
  type Pt,
  parsePoint,
  parsePoints,
  parseVolumes,
  type Rect,
  rectPoints,
  shapePoints,
  toElements,
  type Volume,
} from '../settings/bedGeometry';
import { Presence } from './Presence';
import { SegmentThumb } from './SegmentThumb';
import { useModal } from './useModal';

export type BedKey = 'printable_area' | 'bed_exclude_area' | 'bed_exclude_volumes';
export const BED_KEYS = new Set<string>(['printable_area', 'bed_exclude_area', 'bed_exclude_volumes']);
type Commit = string | { elements: string[] };

const TITLE: Record<BedKey, string> = {
  printable_area: N_('Bed shape'),
  bed_exclude_area: N_('Excluded bed area'),
  bed_exclude_volumes: N_('Toolhead collision volumes'),
};

interface BedValues {
  area: Pt[];
  exclude: Pt[];
  volumes: string;
  height: number;
}

function readValues(all: Record<string, string | string[]>): BedValues {
  const list = (k: string) => {
    const v = all[k];
    return Array.isArray(v) ? v : v ? v.split(',') : [];
  };
  return {
    area: parsePoints(list('printable_area')) ?? [],
    exclude: parsePoints(list('bed_exclude_area')) ?? [],
    volumes: typeof all.bed_exclude_volumes === 'string' ? all.bed_exclude_volumes : '',
    height: Number(all.printable_height) || 0,
  };
}

const excludeIsNone = (pts: Pt[]) => !isPolygon(pts);
const corners = (n: number) => (n === 1 ? t('{n} corner', { n }) : t('{n} corners', { n }));

function summary(key: BedKey, v: BedValues): string {
  if (key === 'printable_area') {
    const s = detectShape(v.area);
    if (s.kind === 'rect') {
      const size = `${fmt(s.w)} × ${fmt(s.h)} mm`;
      return s.ox || s.oy ? t('{size} · origin {x}, {y}', { size, x: fmt(s.ox), y: fmt(s.oy) }) : size;
    }
    if (s.kind === 'circle') return t('Round, Ø {d} mm', { d: fmt(Number(s.d.toFixed(2))) });
    return t('Custom, {corners}', { corners: corners(s.points.length) });
  }
  if (key === 'bed_exclude_area') {
    if (excludeIsNone(v.exclude)) return t('None');
    const r = asRect(v.exclude);
    return r ? t('{w} × {h} mm at {x}, {y}', { w: fmt(r.w), h: fmt(r.h), x: fmt(r.x), y: fmt(r.y) }) : corners(v.exclude.length);
  }
  const vols = parseVolumes(v.volumes);
  if (!vols) return t('Custom text');
  if (!vols.length) return t('None');
  return vols.length === 1 ? t('{n} volume', { n: 1 }) : t('{n} volumes', { n: vols.length });
}

/** The settings row control: thumbnail, summary and an Edit button. */
export function BedSettingControl({
  k,
  all,
  onCommit,
}: {
  k: BedKey;
  all: Record<string, string | string[]>;
  onCommit: (v: Commit) => void;
}) {
  const [open, setOpen] = useState(false);
  const v = readValues(all);
  return (
    <>
      <button type="button" className="bed-summary" onClick={() => setOpen(true)} data-testid={`edit-${k}`}>
        <BedPreview values={v} focus={k} mini />
        <span>{summary(k, v)}</span>
        <Pencil size={14} className="edit-icon" />
      </button>
      <Presence>
        {open && (
          <BedDialog
            k={k}
            values={v}
            onClose={() => setOpen(false)}
            onApply={(c) => {
              setOpen(false);
              onCommit(c);
            }}
          />
        )}
      </Presence>
    </>
  );
}

// ── Dialog ─────────────────────────────────────────────────────────────────────────────────
function BedDialog({ k, values, onClose, onApply }: { k: BedKey; values: BedValues; onClose: () => void; onApply: (v: Commit) => void }) {
  const [shape, setShape] = useState<BedShape>(() => detectShape(values.area));
  const [exclude, setExclude] = useState<ExcludeDraft>(() => excludeDraft(values.exclude));
  const parsedVolumes = useMemo(() => parseVolumes(values.volumes), [values.volumes]);
  const [volumes, setVolumes] = useState<VolumeDraft[]>(parsedVolumes ?? []);
  const [volumeText, setVolumeText] = useState<string | null>(parsedVolumes ? null : values.volumes);

  const modal = useModal<HTMLDivElement>();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // The preview shows the draft of the edited setting and the saved values of the others.
  const draft: BedValues = {
    ...values,
    ...(k === 'printable_area' ? { area: shapePoints(shape) } : {}),
    ...(k === 'bed_exclude_area' ? { exclude: excludePoints(exclude) } : {}),
    ...(k === 'bed_exclude_volumes' ? { volumes: volumeText ?? formatVolumes(volumes) } : {}),
  };
  const problem =
    k === 'printable_area'
      ? shapeProblem(shape)
      : k === 'bed_exclude_area'
        ? excludeProblem(exclude)
        : volumeText !== null
          ? volumeText.trim() && !parseVolumes(volumeText)
            ? t('Check the format.')
            : null
          : volumesProblem(volumes);

  const apply = () => {
    if (problem) return;
    if (k === 'printable_area') onApply({ elements: toElements(shapePoints(shape)) });
    else if (k === 'bed_exclude_area') onApply({ elements: exclude.mode === 'none' ? ['0x0'] : toElements(excludePoints(exclude)) });
    else onApply(volumeText ?? formatVolumes(volumes));
  };

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal bed-dialog" role="dialog" ref={modal} aria-modal="true" aria-labelledby="bed-dialog-title">
        <div className="bed-dialog-head">
          <h2 id="bed-dialog-title">{t(TITLE[k])}</h2>
          <button type="button" className="icon-btn" aria-label={t('Close')} onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        <div className="bed-dialog-body">
          <div className="bed-preview-wrap">
            <BedPreview values={draft} focus={k} />
          </div>
          <form
            className="bed-form"
            onSubmit={(e) => {
              e.preventDefault();
              apply();
            }}
          >
            {k === 'printable_area' && <ShapeForm shape={shape} onChange={setShape} />}
            {k === 'bed_exclude_area' && <ExcludeForm draft={exclude} onChange={setExclude} bed={draft.area} />}
            {k === 'bed_exclude_volumes' &&
              (volumeText !== null ? (
                <VolumeTextForm
                  text={volumeText}
                  onChange={setVolumeText}
                  onVisual={
                    parseVolumes(volumeText)
                      ? () => {
                          setVolumes(parseVolumes(volumeText)!);
                          setVolumeText(null);
                        }
                      : undefined
                  }
                />
              ) : (
                <VolumesForm
                  volumes={volumes}
                  onChange={setVolumes}
                  bed={draft.area}
                  height={values.height}
                  onText={() => setVolumeText(formatVolumes(volumes))}
                />
              ))}
            <div className="bed-form-foot">
              {problem && (
                <span className="error small" role="alert">
                  {problem}
                </span>
              )}
              <button type="button" className="btn ghost" onClick={onClose}>
                {t('Cancel')}
              </button>
              <button type="submit" className="btn primary" disabled={!!problem} data-testid="bed-apply">
                {t('Apply')}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}

// ── Bed shape ──────────────────────────────────────────────────────────────────────────────
function shapeProblem(s: BedShape): string | null {
  if (s.kind === 'rect') return s.w > 0 && s.h > 0 ? null : t('Enter a width and depth above zero.');
  if (s.kind === 'circle') return s.d > 0 ? null : t('Enter a diameter above zero.');
  return isPolygon(s.points) ? null : t('A custom bed needs at least 3 corners that enclose an area.');
}

function ShapeForm({ shape, onChange }: { shape: BedShape; onChange: (s: BedShape) => void }) {
  // Switching keeps the size: a rectangle becomes the circle that fits in it, and so on.
  const pts = shapePoints(shape);
  const b = pts.length ? bbox(pts) : { min: [0, 0] as Pt, max: [200, 200] as Pt };
  const w = b.max[0] - b.min[0] || 200,
    h = b.max[1] - b.min[1] || 200;
  const to = (kind: BedShape['kind']) => {
    if (kind === shape.kind) return;
    if (kind === 'rect') onChange({ kind, w, h, ox: -b.min[0], oy: -b.min[1] });
    // Like desktop, a round bed is centered on X0 Y0.
    else if (kind === 'circle') onChange({ kind, d: Math.min(w, h), cx: 0, cy: 0 });
    else onChange({ kind, points: pts.length >= 3 ? pts : rectPoints({ x: 0, y: 0, w, h }) });
  };
  return (
    <>
      <Segmented
        value={shape.kind}
        onChange={to}
        options={[
          { value: 'rect', label: t('Rectangular'), icon: <Square size={14} /> },
          { value: 'circle', label: t('Round'), icon: <Circle size={14} /> },
          { value: 'custom', label: t('Custom'), icon: <Shapes size={14} /> },
        ]}
      />
      {shape.kind === 'rect' && (
        <>
          <div className="bed-grid2">
            <Num label={t('Width')} unit="mm" value={shape.w} min={0} onChange={(v) => onChange({ ...shape, w: v })} testid="bed-width" />
            <Num label={t('Depth')} unit="mm" value={shape.h} min={0} onChange={(v) => onChange({ ...shape, h: v })} testid="bed-depth" />
          </div>
          <h3>
            {t('Origin')} <span className="muted">{t('where X0 Y0 is, from the front-left corner')}</span>
          </h3>
          <div className="bed-grid2">
            <Num label="X" unit="mm" value={shape.ox} onChange={(v) => onChange({ ...shape, ox: v })} />
            <Num label="Y" unit="mm" value={shape.oy} onChange={(v) => onChange({ ...shape, oy: v })} />
          </div>
          <div className="chips">
            <button
              type="button"
              className={`chip${shape.ox === 0 && shape.oy === 0 ? ' on' : ''}`}
              onClick={() => onChange({ ...shape, ox: 0, oy: 0 })}
            >
              {t('Front left')}
            </button>
            <button
              type="button"
              className={`chip${shape.ox === shape.w / 2 && shape.oy === shape.h / 2 ? ' on' : ''}`}
              onClick={() => onChange({ ...shape, ox: shape.w / 2, oy: shape.h / 2 })}
            >
              {t('Center')}
            </button>
          </div>
        </>
      )}
      {shape.kind === 'circle' && (
        <>
          <Num
            label={t('Diameter')}
            unit="mm"
            value={Number(shape.d.toFixed(4))}
            min={0}
            onChange={(v) => onChange({ ...shape, d: v })}
            testid="bed-diameter"
          />
          <p className="muted small">
            {shape.cx || shape.cy
              ? t('X0 Y0 is the center of the bed (here {x}, {y}).', { x: fmt(shape.cx), y: fmt(shape.cy) })
              : t('X0 Y0 is the center of the bed.')}
          </p>
        </>
      )}
      {shape.kind === 'custom' && <PointsEditor points={shape.points} onChange={(p) => onChange({ kind: 'custom', points: p })} />}
    </>
  );
}

// ── Excluded bed area ──────────────────────────────────────────────────────────────────────
type ExcludeDraft = { mode: 'none' } | { mode: 'rect'; rect: Rect } | { mode: 'custom'; points: Pt[] };

function excludeDraft(pts: Pt[]): ExcludeDraft {
  if (excludeIsNone(pts)) return { mode: 'none' };
  const r = asRect(pts);
  return r ? { mode: 'rect', rect: r } : { mode: 'custom', points: pts };
}
const excludePoints = (d: ExcludeDraft): Pt[] => (d.mode === 'none' ? [] : d.mode === 'rect' ? rectPoints(d.rect) : d.points);
function excludeProblem(d: ExcludeDraft): string | null {
  if (d.mode === 'rect') return d.rect.w > 0 && d.rect.h > 0 ? null : t('Enter a width and depth above zero.');
  if (d.mode === 'custom') return isPolygon(d.points) ? null : t('An area needs at least 3 corners that enclose it.');
  return null;
}

/** A starting rectangle: the front-left corner of the bed, a fifth of its size. */
function defaultRect(bed: Pt[]): Rect {
  const b = bed.length ? bbox(bed) : { min: [0, 0] as Pt, max: [200, 200] as Pt };
  const w = Math.round((b.max[0] - b.min[0]) / 5),
    h = Math.round((b.max[1] - b.min[1]) / 5);
  return { x: b.min[0], y: b.min[1], w: w || 20, h: h || 20 };
}

function ExcludeForm({ draft, onChange, bed }: { draft: ExcludeDraft; onChange: (d: ExcludeDraft) => void; bed: Pt[] }) {
  const to = (mode: ExcludeDraft['mode']) => {
    if (mode === draft.mode) return;
    const pts = excludePoints(draft);
    if (mode === 'none') onChange({ mode });
    else if (mode === 'rect') onChange({ mode, rect: pts.length ? (asRect(pts) ?? boxRect(pts)) : defaultRect(bed) });
    else onChange({ mode, points: pts.length ? pts : rectPoints(defaultRect(bed)) });
  };
  return (
    <>
      <p className="muted small">{t('An area of the bed nothing may be printed on, for example where a filament cutter sits.')}</p>
      <Segmented
        value={draft.mode}
        onChange={to}
        options={[
          { value: 'none', label: t('None') },
          { value: 'rect', label: t('Rectangle'), icon: <Square size={14} /> },
          { value: 'custom', label: t('Custom'), icon: <Shapes size={14} /> },
        ]}
      />
      {draft.mode === 'rect' && <RectFields rect={draft.rect} onChange={(rect) => onChange({ mode: 'rect', rect })} />}
      {draft.mode === 'custom' && <PointsEditor points={draft.points} onChange={(points) => onChange({ mode: 'custom', points })} />}
    </>
  );
}

/** The n-th new volume: next to the previous ones along the front, then further back. */
function staggered(r: Rect, n: number, bed: Pt[]): Rect {
  const b = bed.length ? bbox(bed) : { min: [0, 0] as Pt, max: [200, 200] as Pt };
  const perRow = Math.max(1, Math.floor((b.max[0] - b.min[0]) / (r.w * 1.25)));
  return { ...r, x: r.x + (n % perRow) * r.w * 1.25, y: r.y + Math.floor(n / perRow) * r.h * 1.25 };
}

function boxRect(pts: Pt[]): Rect {
  const b = bbox(pts);
  return { x: b.min[0], y: b.min[1], w: b.max[0] - b.min[0], h: b.max[1] - b.min[1] };
}

function RectFields({ rect, onChange }: { rect: Rect; onChange: (r: Rect) => void }) {
  return (
    <div className="bed-grid2">
      <Num label="X" unit="mm" value={rect.x} onChange={(v) => onChange({ ...rect, x: v })} />
      <Num label="Y" unit="mm" value={rect.y} onChange={(v) => onChange({ ...rect, y: v })} />
      <Num label={t('Width')} unit="mm" value={rect.w} min={0} onChange={(v) => onChange({ ...rect, w: v })} />
      <Num label={t('Depth')} unit="mm" value={rect.h} min={0} onChange={(v) => onChange({ ...rect, h: v })} />
    </div>
  );
}

// ── Toolhead collision volumes ─────────────────────────────────────────────────────────────
function volumesProblem(vs: Volume[]): string | null {
  for (const [i, v] of vs.entries()) {
    if (!isPolygon(v.points)) return t('Volume {n} needs at least 3 corners that enclose an area.', { n: i + 1 });
    if (v.z && v.z.min !== null && v.z.max !== null && v.z.min >= v.z.max)
      return t('Volume {n}: the top must be above the bottom.', { n: i + 1 });
  }
  return null;
}

/** A volume being edited; `custom` keeps the corner list even when it happens to be a rectangle. */
type VolumeDraft = Volume & { custom?: boolean };

function VolumesForm({
  volumes,
  onChange,
  bed,
  height,
  onText,
}: {
  volumes: VolumeDraft[];
  onChange: (v: VolumeDraft[]) => void;
  bed: Pt[];
  height: number;
  onText: () => void;
}) {
  const set = (i: number, v: VolumeDraft) => onChange(volumes.map((x, j) => (j === i ? v : x)));
  return (
    <>
      <p className="muted small">
        {t('Parts of the printer the toolhead must not hit, such as clips or a camera. Moves avoid them, and nothing is printed there.')}
      </p>
      {volumes.length === 0 && <p className="bed-empty">{t('No collision volumes.')}</p>}
      {volumes.map((v, i) => {
        const r = asRect(v.points);
        return (
          <fieldset key={i} className="bed-volume">
            <legend>
              <span className="swatch" style={{ background: VOLUME_COLORS[i % VOLUME_COLORS.length] }} />
              {t('Volume {n}', { n: i + 1 })}
              <button
                type="button"
                className="icon-btn small danger"
                aria-label={t('Remove volume {n}', { n: i + 1 })}
                onClick={() => onChange(volumes.filter((_, j) => j !== i))}
              >
                <Trash2 size={14} />
              </button>
            </legend>
            <Segmented
              value={r && !v.custom ? 'rect' : 'custom'}
              small
              onChange={(m) =>
                set(i, m === 'rect' ? { ...v, points: rectPoints(r ?? boxRect(v.points)), custom: false } : { ...v, custom: true })
              }
              options={[
                { value: 'rect', label: t('Rectangle') },
                { value: 'custom', label: t('Custom') },
              ]}
            />
            {r && !v.custom ? (
              <RectFields rect={r} onChange={(rect) => set(i, { ...v, points: rectPoints(rect) })} />
            ) : (
              <PointsEditor points={v.points} onChange={(points) => set(i, { ...v, points })} />
            )}
            <Segmented
              value={v.z ? 'range' : 'full'}
              small
              onChange={(m) => set(i, { ...v, z: m === 'full' ? null : { min: 0, max: height || 10 } })}
              options={[
                { value: 'full', label: t('Full height') },
                { value: 'range', label: t('Height range') },
              ]}
            />
            {v.z && (
              <div className="bed-grid2">
                <Num label={t('From')} unit="mm" value={v.z.min ?? 0} min={0} onChange={(x) => set(i, { ...v, z: { ...v.z!, min: x } })} />
                <Num
                  label={t('To')}
                  unit="mm"
                  value={v.z.max ?? height}
                  min={0}
                  onChange={(x) => set(i, { ...v, z: { ...v.z!, max: x } })}
                />
              </div>
            )}
          </fieldset>
        );
      })}
      <div className="bed-row">
        <button
          type="button"
          className="btn"
          onClick={() => onChange([...volumes, { points: rectPoints(staggered(defaultRect(bed), volumes.length, bed)), z: null }])}
          data-testid="bed-add-volume"
        >
          <Plus size={15} />
          {t('Add volume')}
        </button>
        <button type="button" className="btn ghost" onClick={onText}>
          {t('Edit as text')}
        </button>
      </div>
    </>
  );
}

function VolumeTextForm({ text, onChange, onVisual }: { text: string; onChange: (text: string) => void; onVisual?: () => void }) {
  return (
    <>
      <p className="muted small">
        {t('One volume per line: corners as {corners}, optionally after a height range {range}', {
          corners: 'XxY, XxY, …',
          range: 'from..to;',
        })}
      </p>
      <textarea
        className="code"
        rows={6}
        spellCheck={false}
        value={text.split(/\s*\|\s*/).join('\n')}
        placeholder={'0x0, 30x0, 30x20, 0x20\n5..40;100x100, 120x100, 120x120'}
        onChange={(e) =>
          onChange(
            e.target.value
              .split('\n')
              .map((l) => l.trim())
              .filter(Boolean)
              .join(' | '),
          )
        }
        aria-label={t('Collision volumes')}
      />
      {onVisual && (
        <div className="bed-row">
          <button type="button" className="btn ghost" onClick={onVisual}>
            {t('Edit visually')}
          </button>
        </div>
      )}
    </>
  );
}

// ── Shared form pieces ─────────────────────────────────────────────────────────────────────
function Segmented<T extends string>({
  value,
  onChange,
  options,
  small,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string; icon?: React.ReactNode }[];
  small?: boolean;
}) {
  return (
    <div className={`segmented bed-seg${small ? ' small' : ''}`} role="radiogroup">
      <SegmentThumb />
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          aria-selected={o.value === value}
          onClick={() => onChange(o.value)}
        >
          {o.icon}
          {o.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Number input. The value is used when the field is left or Enter is pressed, not on every
 * keystroke: typing 300 must not show a 3 mm and then a 30 mm bed on the way.
 */
function Num({
  label,
  unit,
  value,
  min,
  onChange,
  testid,
}: {
  label: string;
  unit?: string;
  value: number;
  min?: number;
  onChange: (v: number) => void;
  testid?: string;
}) {
  const [text, setText] = useState(fmt(value));
  useEffect(() => setText(fmt(value)), [value]);
  const commit = () => {
    const n = Number(text.replace(',', '.'));
    if (text.trim() !== '' && Number.isFinite(n) && (min === undefined || n >= min)) {
      if (n !== value) onChange(n);
    } else setText(fmt(value));
  };
  return (
    <label className="bed-num">
      <span>{label}</span>
      <span className="bed-num-input">
        <input
          type="text"
          inputMode="decimal"
          className="num"
          value={text}
          data-testid={testid}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          // Enter updates the preview; Apply is a separate step.
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commit();
            }
            if (e.key === 'Escape') {
              setText(fmt(value));
            }
          }}
        />
        {unit && <span className="sidetext">{unit}</span>}
      </span>
    </label>
  );
}

function PointsEditor({ points, onChange }: { points: Pt[]; onChange: (p: Pt[]) => void }) {
  const [asText, setAsText] = useState(false);
  const [text, setText] = useState('');
  const set = (i: number, p: Pt) => onChange(points.map((x, j) => (j === i ? p : x)));
  if (asText) {
    const parsed = text.split(',').map(parsePoint);
    const ok = parsed.every(Boolean) && parsed.length >= 3;
    return (
      <div className="points-text">
        <textarea
          className="code"
          rows={3}
          spellCheck={false}
          value={text}
          onChange={(e) => setText(e.target.value)}
          aria-label={t('Corners as text')}
        />
        <div className="bed-row">
          <span className="muted small">{t('Corners as {format}', { format: 'XxY, XxY, …' })}</span>
          <button
            type="button"
            className="btn small"
            disabled={!ok}
            onClick={() => {
              onChange(parsed as Pt[]);
              setAsText(false);
            }}
          >
            {t('Use these')}
          </button>
          <button type="button" className="btn small ghost" onClick={() => setAsText(false)}>
            {t('Cancel')}
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="points">
      <div className="points-head">
        <span>#</span>
        <span>X</span>
        <span>Y</span>
        <span />
      </div>
      {points.map((p, i) => (
        <div key={i} className="points-row">
          <span className="muted">{i + 1}</span>
          <Num label="" unit="" value={p[0]} onChange={(x) => set(i, [x, p[1]])} />
          <Num label="" unit="" value={p[1]} onChange={(y) => set(i, [p[0], y])} />
          <button
            type="button"
            className="icon-btn small"
            aria-label={t('Remove corner {n}', { n: i + 1 })}
            disabled={points.length <= 3}
            onClick={() => onChange(points.filter((_, j) => j !== i))}
          >
            <Trash2 size={13} />
          </button>
        </div>
      ))}
      <div className="bed-row">
        <button
          type="button"
          className="btn small"
          onClick={() => {
            // New corner halfway along the closing edge, so the shape stays sensible.
            const a = points[points.length - 1] ?? [0, 0],
              b = points[0] ?? [0, 0];
            onChange([...points, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]]);
          }}
        >
          <Plus size={14} />
          {t('Add corner')}
        </button>
        <button
          type="button"
          className="btn small ghost"
          onClick={() => {
            setText(points.map(([x, y]) => `${fmt(x)}x${fmt(y)}`).join(', '));
            setAsText(true);
          }}
        >
          {t('Edit as text')}
        </button>
      </div>
    </div>
  );
}

// ── Preview ────────────────────────────────────────────────────────────────────────────────
const VOLUME_COLORS = ['#e8a33d', '#c46be0', '#3dbde8', '#e86b9a'];

/** The bed seen from above (Y up, as on the printer), with grid, origin, excluded area and volumes. */
export function BedPreview({ values, focus, mini }: { values: BedValues; focus: BedKey; mini?: boolean }) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<Pt | null>(null);
  const vols = parseVolumes(values.volumes) ?? [];
  const excl = excludeIsNone(values.exclude) ? null : values.exclude;
  const all = [...values.area, ...(excl ?? []), ...vols.flatMap((v) => v.points), [0, 0] as Pt];
  const b = all.length ? bbox(all) : { min: [0, 0] as Pt, max: [200, 200] as Pt };
  const size = Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1], 10);
  const pad = size * (mini ? 0.06 : 0.1);
  // SVG y points down: flip by drawing at (x, -y).
  const vb = [b.min[0] - pad, -b.max[1] - pad, b.max[0] - b.min[0] + 2 * pad, b.max[1] - b.min[1] + 2 * pad];
  const path = (pts: Pt[]) => (pts.length ? `M${pts.map(([x, y]) => `${x},${-y}`).join('L')}Z` : '');
  const bed = path(values.area);
  const grid = useMemo(() => {
    if (mini || !values.area.length) return null;
    const bb = bbox(values.area);
    const step = niceStep(size / 12),
      lines: React.ReactNode[] = [];
    for (let x = Math.ceil(bb.min[0] / step) * step; x <= bb.max[0]; x += step)
      lines.push(
        <line key={`x${x}`} x1={x} x2={x} y1={-bb.min[1]} y2={-bb.max[1]} className={Math.round(x / step) % 5 === 0 ? 'major' : ''} />,
      );
    for (let y = Math.ceil(bb.min[1] / step) * step; y <= bb.max[1]; y += step)
      lines.push(
        <line key={`y${y}`} y1={-y} y2={-y} x1={bb.min[0]} x2={bb.max[0]} className={Math.round(y / step) % 5 === 0 ? 'major' : ''} />,
      );
    return lines;
  }, [values.area, size, mini]);
  const axis = size * 0.12,
    font = size * 0.035;
  const dims = !mini && values.area.length ? bbox(values.area) : null;

  const onMove = (e: React.MouseEvent) => {
    const svg = svgRef.current,
      m = svg?.getScreenCTM();
    if (!svg || !m) return;
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse());
    setHover([p.x, -p.y]);
  };

  return (
    <div className={`bed-preview${mini ? ' mini' : ''}`}>
      <svg
        ref={svgRef}
        viewBox={vb.join(' ')}
        preserveAspectRatio="xMidYMid meet"
        aria-hidden={mini}
        role={mini ? undefined : 'img'}
        aria-label={mini ? undefined : t('Bed preview')}
        onMouseMove={mini ? undefined : onMove}
        onMouseLeave={() => setHover(null)}
      >
        <defs>
          <clipPath id={`bed-clip${mini ? '-mini' : ''}`}>
            <path d={bed} />
          </clipPath>
        </defs>
        <path d={bed} className={`bed-surface${focus === 'printable_area' ? ' focus' : ''}`} />
        {grid && (
          <g className="bed-gridlines" clipPath="url(#bed-clip)">
            {grid}
          </g>
        )}
        {excl && <path d={path(excl)} className={`bed-exclude${focus === 'bed_exclude_area' ? ' focus' : ''}`} />}
        {vols.map((v, i) => (
          <path
            key={i}
            d={path(v.points)}
            className={`bed-volume-shape${focus === 'bed_exclude_volumes' ? ' focus' : ''}`}
            style={{ stroke: VOLUME_COLORS[i % VOLUME_COLORS.length], fill: VOLUME_COLORS[i % VOLUME_COLORS.length] }}
          />
        ))}
        {!mini && (
          <g className="bed-axes">
            <line x1={0} y1={0} x2={axis} y2={0} className="ax-x" />
            <line x1={0} y1={0} x2={0} y2={-axis} className="ax-y" />
            <circle cx={0} cy={0} r={size * 0.008} className="ax-o" />
            <text x={axis + font * 0.6} y={font * 0.35} fontSize={font} className="ax-x">
              X
            </text>
            <text x={-font * 0.3} y={-axis - font * 0.7} fontSize={font} className="ax-y">
              Y
            </text>
          </g>
        )}
        {dims && (
          <g className="bed-dims" fontSize={font}>
            <text x={(dims.min[0] + dims.max[0]) / 2} y={-dims.min[1] + font * 1.6} textAnchor="middle">
              {fmt(Number((dims.max[0] - dims.min[0]).toFixed(2)))} mm
            </text>
            <text transform={`translate(${dims.min[0] - font * 0.9} ${-(dims.min[1] + dims.max[1]) / 2}) rotate(-90)`} textAnchor="middle">
              {fmt(Number((dims.max[1] - dims.min[1]).toFixed(2)))} mm
            </text>
          </g>
        )}
      </svg>
      {!mini && (
        <div className="bed-coords" aria-live="off">
          {hover ? `X ${hover[0].toFixed(1)}   Y ${hover[1].toFixed(1)}` : t('Front of the printer is at the bottom')}
        </div>
      )}
    </div>
  );
}

function niceStep(raw: number): number {
  const p = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 2, 5, 10]) if (m * p >= raw) return m * p;
  return 10 * p;
}
