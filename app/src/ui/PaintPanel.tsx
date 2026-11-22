// Desktop's Support Painting tool window (GLGizmoFdmSupports::on_render_input_window): the tool,
// its size or angle, painting on overhangs only, the overhang highlight, Erase all and Done. It
// takes the object panel's place while painting.
// SPDX-License-Identifier: AGPL-3.0-or-later
import { Circle, Globe, Info, PaintBucket, SquareDashed } from 'lucide-react';
import { tr } from '../i18n/i18n';
import { applyGapFill, eraseAllPaint, PAINT_LIMITS, setPaint, stopPainting } from '../state/paintActions';
import { formatNumber } from '../state/prefs';
import { type PaintSettings, useApp } from '../state/store';
import { isMac } from './plateCommands';

const TOOLS: [PaintSettings['tool'], string, typeof Circle, string][] = [
  ['circle', 'Circle', Circle, 'C'],
  ['sphere', 'Sphere', Globe, 'S'],
  ['fill', 'Fill', PaintBucket, 'F'],
  ['gap_fill', 'Gap Fill', SquareDashed, 'G'],
];

/** A slider with its value typed beside it, as desktop's (bbl_slider_float_style and BBLDragFloat). */
function Slider({
  label,
  k,
  digits,
  unit,
  tip,
}: {
  label: string;
  k: 'radius' | 'smartFillAngle' | 'gapArea' | 'highlightAngle';
  digits: number;
  unit?: string;
  tip?: string;
}) {
  const value = useApp((s) => s.paint[k]);
  const l = PAINT_LIMITS[k];
  const put = (v: number) => {
    if (Number.isFinite(v)) setPaint({ [k]: Math.min(l.max, Math.max(l.min, v)) });
  };
  return (
    <label className="paint-row" data-tip={tip}>
      <span className="paint-label">{label}</span>
      <input
        type="range"
        min={l.min}
        max={l.max}
        step={l.step}
        value={value}
        style={{ '--pct': `${((value - l.min) / (l.max - l.min)) * 100}%` } as React.CSSProperties}
        onChange={(e) => put(Number(e.target.value))}
        data-testid={`paint-${k}`}
      />
      <span className="paint-value">
        {formatNumber(value, digits)}
        {unit}
      </span>
    </label>
  );
}

export function PaintPanel() {
  const p = useApp((s) => s.paint);
  const painted = useApp((s) => s.objects.find((o) => o.id === s.painting)?.painted ?? false);
  const brush = p.tool === 'circle' || p.tool === 'sphere';
  const ctrl = isMac ? '⌘' : 'Ctrl+';
  // Desktop's shortcut list (its "?" button).
  const shortcuts = [
    [tr('Left mouse button'), tr('Enforce supports')],
    [tr('Right mouse button'), tr('Block supports')],
    [`Shift+${tr('Left mouse button')}`, tr('Erase')],
    [`${ctrl}${tr('Mouse wheel')}`, brush ? tr('Brush size') : p.tool === 'fill' ? tr('Smart fill angle') : tr('Gap area')],
  ]
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
  return (
    <section className="card object-panel paint-panel" aria-label={tr('Support Painting')} data-testid="paint-panel">
      <div className="card-head">
        <h2 className="op-name">{tr('Support Painting')}</h2>
        <div className="card-tools">
          <span className="icon-btn small" tabIndex={0} role="note" aria-label={shortcuts} data-tip={shortcuts}>
            <Info size={15} />
          </span>
        </div>
      </div>
      <div className="paint-row">
        <span className="paint-label">{tr('Tool type')}</span>
        <div className="paint-tools" role="radiogroup" aria-label={tr('Tool type')}>
          {TOOLS.map(([tool, name, Icon, key]) => (
            <button
              key={tool}
              type="button"
              role="radio"
              aria-checked={p.tool === tool}
              className={`icon-btn${p.tool === tool ? ' on' : ''}`}
              aria-label={tr(name)}
              data-tip={`${tr(name)} (${key})`}
              onClick={() => setPaint({ tool })}
              data-testid={`paint-tool-${tool}`}
            >
              <Icon size={16} />
            </button>
          ))}
        </div>
      </div>
      {brush && (
        <>
          <Slider label={tr('Brush size')} k="radius" digits={2} />
          <div className="paint-row">
            <span className="paint-label" />
            <div className="paint-checks">
              <label className="check">
                <input
                  type="checkbox"
                  checked={p.vertical}
                  onChange={(e) => setPaint({ vertical: e.target.checked })}
                  data-testid="paint-vertical"
                />
                {tr('Vertical')}
              </label>
              <label className="check">
                <input
                  type="checkbox"
                  checked={p.horizontal}
                  onChange={(e) => setPaint({ horizontal: e.target.checked })}
                  data-testid="paint-horizontal"
                />
                {tr('Horizontal')}
              </label>
            </div>
          </div>
        </>
      )}
      {p.tool === 'fill' && <Slider label={tr('Smart fill angle')} k="smartFillAngle" digits={0} unit="°" />}
      {p.tool === 'gap_fill' && (
        <div className="paint-gap">
          <Slider label={tr('Gap area')} k="gapArea" digits={2} />
          <button type="button" className="btn" onClick={() => void applyGapFill()} data-testid="paint-gap-apply">
            {tr('Apply')}
          </button>
        </div>
      )}
      {p.tool !== 'gap_fill' && (
        <label
          className="check paint-overhangs"
          data-tip={tr('Allows painting only on facets selected by: "%1%"').replace('%1%', tr('Highlight overhangs'))}
        >
          <input
            type="checkbox"
            checked={p.overhangsOnly}
            onChange={(e) => setPaint({ overhangsOnly: e.target.checked })}
            data-testid="paint-overhangs-only"
          />
          {tr('On highlighted overhangs only')}
        </label>
      )}
      <Slider
        label={tr('Highlight overhangs')}
        k="highlightAngle"
        digits={0}
        unit="°"
        tip={tr('Highlight faces according to overhang angle.')}
      />
      <div className="paint-actions">
        <button type="button" className="btn" disabled={!painted} onClick={() => void eraseAllPaint()} data-testid="paint-erase-all">
          {tr('Erase all')}
        </button>
        <button type="button" className="btn primary" onClick={stopPainting} data-testid="paint-done">
          {tr('Done')}
        </button>
      </div>
    </section>
  );
}
