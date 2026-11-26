// The selected object's operations, as desktop's object manipulation panel: position, rotation,
// scale and size, mirror and reset; in world or object coordinates; quick turns and delete; and
// its volume and triangles. The focused field's axis is shown on the object in the 3D view.
// Lengths in inches with imperial units (desktop's "use_inches").
// SPDX-License-Identifier: AGPL-3.0-or-later

import { FlipHorizontal2, FlipVertical2, Lock, RotateCcw, RotateCw, Trash2, Unlock } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { t, tr } from '../i18n/i18n';
import { deleteObject, rotateZ } from '../state/actions';
import { type Axis, type Coordinates, manipulation, mirror, resetScale, scaleBy3, setPosition, setRotation } from '../state/manipulate';
import { formatNumber } from '../state/prefs';
import { type AxisHint, set, useApp } from '../state/store';
import { deleteVolume, SHAPE_NAMES, selectedVolume, setVolumeMatrix, volumeMatrixFor, volumeWorld } from '../state/supportVolumes';
import { Select } from './Select';

const IN = 25.4;
const AXES = ['X', 'Y', 'Z'] as const;
/** Desktop's largest size and position (its MAX_NUM), and the smallest size the fields show. */
const MAX_MM = 9999.99,
  MIN_MM = 0.01;
const round = (n: number, digits: number) => Number(n.toFixed(digits));

/**
 * Show `hint` in the 3D view while the field or button has focus or the pointer. The pointer's
 * hint goes first; when it leaves, the focused field's shows again.
 */
const shown: { focus: AxisHint | null; hover: AxisHint | null } = { focus: null, hover: null };
const sync = () => set({ axisHint: shown.hover ?? shown.focus });
const showAxis = (hint: AxisHint, by: 'focus' | 'hover' = 'focus') => {
  shown[by] = hint;
  sync();
};
const hideAxis = (hint: AxisHint, by: 'focus' | 'hover' = 'focus') => {
  if (shown[by] === hint) {
    shown[by] = null;
    sync();
  }
};
const hintProps = (hint: AxisHint) => ({
  onFocus: () => showAxis(hint),
  onBlur: () => hideAxis(hint),
  onMouseEnter: () => showAxis(hint, 'hover'),
  onMouseLeave: () => hideAxis(hint, 'hover'),
});
// The quick turns are about the world's Z axis.
const TURN: AxisHint = { kind: 'rotate', axis: 2, frame: 'world' };
const TURN_BACK: AxisHint = { ...TURN, reverse: true };

/** A number field that commits on Enter or leaving it; Escape puts the value back. */
function NumField({
  value,
  digits,
  onCommit,
  label,
  disabled,
  testid,
  hint,
}: {
  value: number;
  digits: number;
  onCommit: (n: number) => void;
  label: string;
  disabled?: boolean;
  testid: string;
  /** The axis to show on the object while the field has the focus. */
  hint?: AxisHint;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = String(round(value, digits));
  const commit = () => {
    if (draft === null) return;
    // A plain decimal number (a comma is read as the point); anything else puts the value back.
    const text = draft.trim().replace(',', '.');
    const n = /^[+-]?(\d+\.?\d*|\.\d+)$/.test(text) ? Number(text) : NaN;
    setDraft(null);
    if (Number.isFinite(n) && String(round(n, digits)) !== shown) onCommit(n);
  };
  return (
    <input
      type="text"
      inputMode="decimal"
      className="num"
      aria-label={label}
      disabled={disabled}
      data-testid={testid}
      value={draft ?? shown}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        commit();
        if (hint) hideAxis(hint);
      }}
      onFocus={(e) => {
        e.target.select();
        if (hint) showAxis(hint);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          commit();
          (e.target as HTMLInputElement).select();
        }
        if (e.key === 'Escape' && draft !== null) {
          e.stopPropagation();
          setDraft(null);
        }
      }}
    />
  );
}

export function ObjectPanel() {
  const sel = useApp((s) => (s.selected.length === 1 ? s.objects.find((o) => o.id === s.selected[0]) : undefined));
  const imperial = useApp((s) => s.prefs.units === 'imperial');
  const [coords, setCoords] = useState<Coordinates>('world');
  const [uniform, setUniform] = useState(true);
  const matrix = sel?.instances[0];
  const info = useMemo(() => (sel && matrix ? manipulation(sel.id, matrix, coords) : null), [sel, matrix, coords]);
  // One hint object per field, so a blur clears only its own.
  const hints = useMemo(() => {
    const per = (kind: AxisHint['kind'], frame: AxisHint['frame'], all = false) =>
      ([0, 1, 2] as Axis[]).map((axis): AxisHint => ({ kind, axis, frame, ...(all && { all }) }));
    const along = coords === 'world' ? 'world' : 'object';
    return {
      position: per('move', along),
      mirror: per('mirror', along),
      rotation: per('rotate', 'euler'),
      scale: per('scale', 'object', uniform),
      size: per('scale', 'object', uniform),
    };
  }, [coords, uniform]);
  useEffect(
    () => () => {
      shown.focus = shown.hover = null;
      sync();
    },
    [sel?.id],
  );
  if (!sel || !info) return null;
  const id = sel.id;
  const k = imperial ? 1 / IN : 1;
  const unit = imperial ? 'in' : t('mm');
  const row = (key: string, label: React.ReactNode, unitText: string, cells: (a: Axis) => React.ReactNode, reset?: React.ReactNode) => (
    <>
      <span className="op-label" id={`op-${key}`}>
        {label}
      </span>
      {([0, 1, 2] as Axis[]).map((a) => (
        <span key={a}>{cells(a)}</span>
      ))}
      <span className="op-unit">{unitText}</span>
      <span>{reset}</span>
    </>
  );
  const resetBtn = (label: string, show: boolean, onClick: () => void, testid: string) =>
    show && (
      <button type="button" className="icon-btn small op-reset" data-tip={label} aria-label={label} onClick={onClick} data-testid={testid}>
        <RotateCcw size={13} />
      </button>
    );
  // Ratios along the object's own axes; the lock scales all three alike.
  // No size beyond desktop's largest (9999.99 mm) or below what the fields show.
  const scaleTo = (a: Axis, ratio: number) => {
    const axes = ([0, 1, 2] as Axis[]).filter((i) => uniform || i === a);
    const r = Math.max(Math.min(ratio, ...axes.map((i) => MAX_MM / info.size[i])), ...axes.map((i) => MIN_MM / info.size[i]));
    scaleBy3(id, [0, 1, 2].map((i) => (axes.includes(i as Axis) ? r : 1)) as [number, number, number]);
  };
  // A move straight up or down does nothing: the object drops back to the bed (as on desktop).
  const upright = (a: Axis) =>
    coords === 'world' ? a === 2 : Math.hypot(matrix![a * 4]!, matrix![a * 4 + 1]!) < 1e-9 * Math.abs(matrix![a * 4 + 2]!);
  const lock = (
    <button
      type="button"
      className={`icon-btn small op-lock${uniform ? ' on' : ''}`}
      aria-pressed={uniform}
      data-tip={t('Uniform scale')}
      aria-label={t('Uniform scale')}
      onClick={() => setUniform((u) => !u)}
      data-testid="op-uniform"
    >
      {uniform ? <Lock size={14} /> : <Unlock size={14} />}
    </button>
  );
  const MIRROR = [t('Mirror along the X axis'), t('Mirror along the Y axis'), t('Mirror along the Z axis')];
  return (
    <section className="card object-panel" aria-label={t('Object operations')} data-testid="object-panel">
      <div className="card-head">
        <h2 className="op-name" data-tip={sel.name}>
          {sel.name}
        </h2>
        <div className="card-tools">
          <button
            type="button"
            className="icon-btn small"
            onClick={() => rotateZ(id, -90)}
            data-tip={t('Rotate −90°')}
            aria-label={t('Rotate left')}
            {...hintProps(TURN_BACK)}
          >
            <RotateCcw size={15} />
          </button>
          <button
            type="button"
            className="icon-btn small"
            onClick={() => rotateZ(id, 90)}
            data-tip={t('Rotate 90°')}
            aria-label={t('Rotate right')}
            {...hintProps(TURN)}
          >
            <RotateCw size={15} />
          </button>
          <button
            type="button"
            className="icon-btn small danger"
            onClick={() => deleteObject(id)}
            data-tip={t('Delete')}
            aria-label={t('Delete object')}
            data-testid="op-delete"
          >
            <Trash2 size={15} />
          </button>
        </div>
      </div>
      <div className="op-grid">
        <Select
          value={coords}
          onChange={(v) => setCoords(v as Coordinates)}
          className="op-coords"
          aria-label={t('Coordinate system used for transform actions.')}
          items={[
            { value: 'world', label: t('World') },
            { value: 'object', label: t('Object') },
          ]}
          data-testid="op-coords"
        />
        {AXES.map((x, i) => (
          <span key={x} className={`op-axis a${i}`}>
            {x}
            {/* Along the world's axis or the object's own, as the coordinates chosen. */}
            <button
              type="button"
              className="icon-btn small op-mirror"
              data-tip={MIRROR[i]}
              aria-label={MIRROR[i]}
              onClick={() => mirror(id, coords, i as Axis)}
              data-testid={`op-mirror-${i}`}
              {...hintProps(hints.mirror[i]!)}
            >
              {/* lucide names these by the mirror line: X and Y flip side to side, Z top to bottom. */}
              {i === 2 ? <FlipHorizontal2 size={13} /> : <FlipVertical2 size={13} />}
            </button>
          </span>
        ))}
        <span />
        <span />
        {row('position', t('Position'), unit, (a) => (
          <NumField
            value={info.position[a] * k}
            digits={2}
            label={`${t('Position')} ${AXES[a]}`}
            testid={`op-position-${a}`}
            hint={hints.position[a]!}
            disabled={upright(a)}
            onCommit={(n) => setPosition(id, coords, a, Math.max(-MAX_MM, Math.min(MAX_MM, n / k)))}
          />
        ))}
        {row(
          'rotation',
          t('Rotation'),
          '°',
          (a) => (
            <NumField
              value={info.rotation[a]}
              digits={2}
              label={`${t('Rotation')} ${AXES[a]}`}
              testid={`op-rotation-${a}`}
              hint={hints.rotation[a]!}
              onCommit={(n) => setRotation(id, [0, 1, 2].map((i) => (i === a ? n : null)) as [number | null, number | null, number | null])}
            />
          ),
          resetBtn(
            t('Reset rotation'),
            info.rotation.some((r) => r !== 0),
            () => setRotation(id, [0, 0, 0]),
            'op-reset-rotation',
          ),
        )}
        {row(
          'scale',
          <>
            {t('Scale')}
            {lock}
          </>,
          '%',
          (a) => (
            <NumField
              value={info.scale[a]}
              digits={2}
              label={`${t('Scale')} ${AXES[a]}`}
              testid={`op-scale-${a}`}
              hint={hints.scale[a]!}
              onCommit={(n) => {
                if (n > 0) scaleTo(a, n / info.scale[a]);
              }}
            />
          ),
          resetBtn(
            t('Reset scale'),
            info.scale.some((r) => Math.abs(r - 100) > 1e-3),
            () => resetScale(id),
            'op-reset-scale',
          ),
        )}
        {row('size', t('Size'), unit, (a) => (
          <NumField
            value={info.size[a] * k}
            digits={2}
            label={`${t('Size')} ${AXES[a]}`}
            testid={`op-size-${a}`}
            hint={hints.size[a]!}
            onCommit={(n) => {
              if (n > 0) scaleTo(a, n / k / info.size[a]);
            }}
          />
        ))}
      </div>
      <dl className="op-info">
        <dt>{t('Volume:')}</dt>
        <dd data-testid="op-volume">
          {imperial ? `${formatNumber(info.volume / IN ** 3, 2)} in³` : `${formatNumber(info.volume, 2)} mm³`}
        </dd>
        <dt>{t('Triangles:')}</dt>
        <dd>{sel.triangles.toLocaleString()}</dd>
      </dl>
    </section>
  );
}

/**
 * The selected support blocker or enforcer: where it is, its rotation and size, in the world (the
 * object's first instance), as desktop's manipulation panel shows a part.
 */
export function VolumePanel() {
  // Stable parts of the state (a selector returning a new object each time would render forever).
  const selectedV = useApp((s) => s.selectedVolume);
  const selected = useApp((s) => s.selected);
  const objects = useApp((s) => s.objects);
  const sel = selectedVolume({ selectedVolume: selectedV, selected, objects });
  const imperial = useApp((s) => s.prefs.units === 'imperial');
  const [uniform, setUniform] = useState(true);
  if (!sel) return null;
  const { object, volume } = sel;
  const at = volumeWorld(object, volume);
  const k = imperial ? 1 / IN : 1;
  const unit = imperial ? 'in' : t('mm');
  const name = tr(SHAPE_NAMES[volume.shape]);
  const place = (change: Partial<{ position: number[]; rotation: number[]; size: number[] }>, key: string) =>
    setVolumeMatrix(
      object.id,
      volume.id,
      volumeMatrixFor(object, volume, {
        position: (change.position ?? at.position) as [number, number, number],
        rotation: (change.rotation ?? at.rotation) as [number, number, number],
        size: (change.size ?? at.size) as [number, number, number],
      }),
      key,
    );
  const row = (label: React.ReactNode, unitText: string, cells: (a: Axis) => React.ReactNode) => (
    <>
      <span className="op-label">{label}</span>
      {([0, 1, 2] as Axis[]).map((a) => (
        <span key={a}>{cells(a)}</span>
      ))}
      <span className="op-unit">{unitText}</span>
      <span />
    </>
  );
  const set3 = (list: readonly number[], a: Axis, n: number) => list.map((x, i) => (i === a ? n : x));
  return (
    <section
      className="card object-panel"
      aria-label={tr(volume.type === 'support_blocker' ? 'Support Blocker' : 'Support Enforcer')}
      data-testid="volume-panel"
    >
      <div className="card-head">
        <h2 className="op-name" data-tip={name}>
          {name} <span className="count">{tr(volume.type === 'support_blocker' ? 'Support Blocker' : 'Support Enforcer')}</span>
        </h2>
        <div className="card-tools">
          <button
            type="button"
            className="icon-btn small"
            onClick={() => deleteVolume(object.id, volume.id)}
            data-tip={t('Delete')}
            aria-label={t('Delete {name}', { name })}
            data-testid="volume-delete"
          >
            <Trash2 size={15} />
          </button>
        </div>
      </div>
      <div className="op-grid">
        <span />
        {AXES.map((x, i) => (
          <span key={x} className={`op-axis a${i}`}>
            {x}
          </span>
        ))}
        <span />
        <span />
        {row(t('Position'), unit, (a) => (
          <NumField
            value={at.position[a] * k}
            digits={2}
            label={`${t('Position')} ${AXES[a]}`}
            testid={`volume-position-${a}`}
            onCommit={(n) => place({ position: set3(at.position, a, Math.max(-MAX_MM, Math.min(MAX_MM, n / k))) }, `vpos${a}`)}
          />
        ))}
        {row(t('Rotation'), '°', (a) => (
          <NumField
            value={at.rotation[a]}
            digits={2}
            label={`${t('Rotation')} ${AXES[a]}`}
            testid={`volume-rotation-${a}`}
            onCommit={(n) => place({ rotation: set3(at.rotation, a, n) }, `vrot${a}`)}
          />
        ))}
        {row(
          <>
            {t('Size')}
            <button
              type="button"
              className={`icon-btn small op-lock${uniform ? ' on' : ''}`}
              aria-pressed={uniform}
              data-tip={t('Uniform scale')}
              aria-label={t('Uniform scale')}
              onClick={() => setUniform((u) => !u)}
              data-testid="volume-uniform"
            >
              {uniform ? <Lock size={14} /> : <Unlock size={14} />}
            </button>
          </>,
          unit,
          (a) => (
            <NumField
              value={at.size[a] * k}
              digits={2}
              label={`${t('Size')} ${AXES[a]}`}
              testid={`volume-size-${a}`}
              onCommit={(n) => {
                const mm = Math.min(MAX_MM, n / k);
                if (!(mm >= MIN_MM)) return;
                const r = mm / at.size[a];
                place({ size: uniform ? at.size.map((x) => x * r) : set3(at.size, a, mm) }, `vsize${a}`);
              }}
            />
          ),
        )}
      </div>
    </section>
  );
}
