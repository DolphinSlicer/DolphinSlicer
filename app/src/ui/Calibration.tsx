// Desktop's Calibration menu (MainFrame's calib_menu) and its dialogs (GUI/calib_dlg.cpp): each
// test asks for its range, then replaces the plate with its test model and changes the presets
// for it (startCalibration), as desktop does.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { BookOpen, Crosshair, X } from 'lucide-react';
import { type ReactNode, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { CalibParams, CalibRequest } from '../engine/protocol';
import { N_, t } from '../i18n/i18n';
import { wikiUrl } from '../settings/docs';
import { checkVfaSpeed, isBeltPrinter, startCalibration } from '../state/actions';
import { notify, set, useApp } from '../state/store';
import { ask } from './Confirm';
import { Presence } from './Presence';
import { Select } from './Select';
import { useModal } from './useModal';

export type Kind = 'temp' | 'max_flowrate' | 'pa' | 'flow_ratio' | 'retraction' | 'cornering' | 'is_freq' | 'is_damp' | 'vfa';

/** The menu, in desktop's order. */
export const MENU: (null | { kind: Kind; label: string })[] = [
  { kind: 'temp', label: N_('Temperature') },
  { kind: 'max_flowrate', label: N_('Max flowrate') },
  { kind: 'pa', label: N_('Pressure advance') },
  { kind: 'flow_ratio', label: N_('Flow ratio') },
  { kind: 'retraction', label: N_('Retraction') },
  { kind: 'cornering', label: N_('Cornering') },
  { kind: 'is_freq', label: N_('Input Shaping Frequency') },
  { kind: 'is_damp', label: N_('Input Shaping Damping/zeta factor') },
  { kind: 'vfa', label: N_('VFA') },
  null,
];

/** A desktop label ("Start PA: ") without its colon. */
const label = (s: string) => t(s).replace(/\s*[:：]\s*$/, '');
/** A number as desktop's dialogs read it; NaN when it isn't one. */
const num = (s: string) => {
  const v = Number(s.trim().replace(',', '.'));
  return s.trim() !== '' && Number.isFinite(v) ? v : Number.NaN;
};
/** Desktop's printf-style message: %s, %d and %.Nf in order. */
const printf = (fmt: string, ...args: (string | number)[]) => {
  let i = 0;
  return fmt.replace(/%(\.(\d+))?[fsd]/g, (_m, _p, digits?: string) => {
    const a = args[i++];
    return typeof a === 'number' && digits !== undefined ? a.toFixed(Number(digits)) : String(a ?? '');
  });
};

/** The printer config values the dialogs look at (the first of a list). */
function useCfg() {
  const config = useApp((s) => s.presets.config);
  const cfg = config ? (JSON.parse(config) as Record<string, unknown>) : {};
  const get = (k: string) => {
    const v = cfg[k];
    return String(Array.isArray(v) ? (v[0] ?? '') : (v ?? ''));
  };
  return { get, belt: isBeltPrinter(config) };
}

/** The Objects card's Calibration button and its menu (desktop's Calibration menu). */
export function CalibrationButton() {
  const ready = useApp((s) => !!s.presets.state && !s.importing);
  const [menu, setMenu] = useState<DOMRect | null>(null);
  // In the store: the quick search opens a test's dialog too.
  const kind = useApp((s) => s.calibrationDialog as Kind | null);
  const setKind = (k: Kind | null) => set({ calibrationDialog: k });
  return (
    <>
      <button
        type="button"
        className="icon-btn"
        aria-label={t('Calibration')}
        data-tip={t('Calibration')}
        aria-haspopup="menu"
        aria-expanded={!!menu}
        disabled={!ready}
        onClick={(e) => setMenu(menu ? null : e.currentTarget.getBoundingClientRect())}
        data-testid="open-calibration"
      >
        <Crosshair size={16} />
      </button>
      {/* On the page itself: a card's blur would be what fixed positions are relative to. */}
      {menu &&
        createPortal(
          <CalibMenu
            at={menu}
            onClose={() => setMenu(null)}
            onPick={(k) => {
              setMenu(null);
              setKind(k);
            }}
          />,
          document.body,
        )}
      {createPortal(<Presence>{kind && <CalibDialog kind={kind} onClose={() => setKind(null)} />}</Presence>, document.body)}
    </>
  );
}

function CalibMenu({ at, onPick, onClose }: { at: DOMRect; onPick: (k: Kind) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  // Below the button, inside the window, the first item focused.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth,
      h = el.offsetHeight;
    setPos({ x: Math.max(4, Math.min(at.left, innerWidth - w - 4)), y: Math.max(4, Math.min(at.bottom + 4, innerHeight - h - 4)) });
    el.querySelector<HTMLButtonElement>('button')?.focus();
  }, [at]);
  const move = (e: React.KeyboardEvent, by: number) => {
    const list = [...ref.current!.querySelectorAll<HTMLButtonElement>('button')];
    const i = list.indexOf(document.activeElement as HTMLButtonElement);
    list[(i + by + list.length) % list.length]?.focus();
    e.preventDefault();
  };
  return (
    <div
      className="menu-backdrop"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        className="menu"
        role="menu"
        aria-label={t('Calibration')}
        data-testid="calibration-menu"
        style={{ left: pos?.x ?? 0, top: pos?.y ?? 0, visibility: pos ? 'visible' : 'hidden' }}
        onKeyDown={(e) => {
          if (e.key === 'Escape' || e.key === 'Tab') {
            e.preventDefault();
            onClose();
          }
          if (e.key === 'ArrowDown') move(e, 1);
          if (e.key === 'ArrowUp') move(e, -1);
        }}
      >
        {MENU.map((m, i) =>
          m ? (
            <button key={m.kind} type="button" role="menuitem" onClick={() => onPick(m.kind)} data-testid={`calib-${m.kind}`}>
              <span />
              <span>{t(m.label)}</span>
            </button>
          ) : (
            <hr key={i} />
          ),
        )}
        <button
          type="button"
          role="menuitem"
          onClick={() => {
            onClose();
            window.open(wikiUrl('calibration_guide'), '_blank', 'noopener');
          }}
        >
          <BookOpen size={15} />
          <span>{t('Calibration Guide')}</span>
        </button>
      </div>
    </div>
  );
}

// ── The dialogs ─────────────────────────────────────────────────────────────────────────────

/** What a dialog's OK starts: the test and the plate's name (desktop's project name). */
type Start = { request: CalibRequest; title: string } | null;

function CalibDialog({ kind, onClose }: { kind: Kind; onClose: () => void }) {
  const D = {
    temp: TempDialog,
    max_flowrate: MaxFlowrateDialog,
    pa: PaDialog,
    flow_ratio: FlowRatioDialog,
    retraction: RetractionDialog,
    cornering: CorneringDialog,
    is_freq: ShapingFreqDialog,
    is_damp: ShapingDampDialog,
    vfa: VfaDialog,
  }[kind];
  return (
    <D
      onStart={(s) => {
        if (!s) return;
        onClose();
        void startCalibration(s.request, s.title);
      }}
      onClose={onClose}
    />
  );
}

type DialogProps = { onStart: (s: Start) => void; onClose: () => void };

function Shell({
  title,
  wiki,
  error,
  onOk,
  onClose,
  children,
}: {
  title: string;
  wiki: string;
  error: string | null;
  onOk: () => void | Promise<void>;
  onClose: () => void;
  children: ReactNode;
}) {
  const modal = useModal<HTMLDivElement>();
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="modal calib-dialog"
        role="dialog"
        ref={modal}
        aria-modal="true"
        aria-labelledby="calib-title"
        data-testid="calib-dialog"
        onKeyDown={(e) => {
          if (e.key === 'Escape' && !document.querySelector('dialog:modal')) {
            e.stopPropagation();
            onClose();
          }
        }}
      >
        <div className="bed-dialog-head">
          <h2 id="calib-title">{title}</h2>
          <button type="button" className="icon-btn" aria-label={t('Close')} onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        <form
          className="create-form calib-form"
          onSubmit={(e) => {
            e.preventDefault();
            void onOk();
          }}
        >
          {children}
          <div className="bed-form-foot">
            {error && (
              <span className="error small" role="alert">
                {error}
              </span>
            )}
            <a
              className="btn ghost"
              href={wikiUrl(wiki)}
              target="_blank"
              rel="noreferrer"
              data-tip={`${t('Wiki Guide')}\n${wikiUrl(wiki)}`}
            >
              <BookOpen size={15} />
              {t('Wiki Guide')}
            </a>
            <button type="submit" className="btn primary" data-testid="calib-ok">
              {t('OK')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function Field({
  name,
  value,
  onChange,
  unit,
  disabled,
  tip,
  onBlur,
  second,
}: {
  name: string;
  value: string;
  onChange: (v: string) => void;
  unit?: string;
  disabled?: boolean;
  tip?: string;
  onBlur?: () => void;
  /** A second value on the row ("Start / End"). */
  second?: { value: string; onChange: (v: string) => void; name: string };
}) {
  return (
    <div className="row">
      <span className="caption">{name}</span>
      <input
        type="text"
        inputMode="decimal"
        className="num"
        value={value}
        disabled={disabled}
        aria-label={second ? `${name} 1` : name}
        data-tip={tip}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
      />
      {second && (
        <input
          type="text"
          inputMode="decimal"
          className="num"
          value={second.value}
          aria-label={second.name}
          data-tip={tip}
          onChange={(e) => second.onChange(e.target.value)}
        />
      )}
      {unit && <span className="muted">{unit}</span>}
    </div>
  );
}

function Radios({
  legend,
  options,
  value,
  onChange,
  disabled,
}: {
  legend: string;
  options: string[];
  value: number;
  onChange: (i: number) => void;
  /** Options that can't be chosen, with why. */
  disabled?: (i: number) => string | null;
}) {
  return (
    <fieldset className="radios">
      <legend>{legend}</legend>
      {options.map((o, i) => {
        const why = disabled?.(i) ?? null;
        return (
          <label key={o} data-tip={why ?? undefined}>
            <input type="radio" checked={value === i} disabled={!!why} onChange={() => onChange(i)} />
            {o}
          </label>
        );
      })}
    </fieldset>
  );
}

function Check({
  name,
  value,
  onChange,
  tip,
  disabled,
}: {
  name: string;
  value: boolean;
  onChange: (v: boolean) => void;
  tip?: string;
  disabled?: boolean;
}) {
  return (
    <label className="check-row" data-tip={tip}>
      <input type="checkbox" checked={value} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      {name}
    </label>
  );
}

const Note = ({ children }: { children: ReactNode }) => <p className="muted small calib-note">{children}</p>;

const SCALE_TIP = N_(
  'This model is designed around a 0.4 mm nozzle with a 0.2 mm layer height.\nWhen the scaling option is enabled (recommended), it dynamically resizes to match your current nozzle diameter and an appropriate layer height, making the test both accurate and easy to read.\nTurn scaling off only if you wish to print the reference model exactly as-is.',
);

// Temp_Calibration_Dlg. Its filament types set the range (desktop's list is one off after TPU,
// which gave PA-CF the TPU range; each here gets its own).
const FILAMENTS: [string, number, number][] = [
  ['PLA', 230, 190],
  ['ABS/ASA', 270, 230],
  ['PETG', 250, 230],
  ['PCTG', 280, 240],
  ['TPU', 240, 210],
  ['PA-CF', 320, 280],
  ['PET-CF', 320, 280],
  [N_('Custom'), 230, 190],
];

function TempDialog({ onStart, onClose }: DialogProps) {
  const { belt } = useCfg();
  const [type, setType] = useState(0);
  const [model, setModel] = useState(0);
  const [start, setStart] = useState('230');
  const [end, setEnd] = useState('190');
  const [resize, setResize] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Within 155–500 °C, in steps of 5 (desktop checks a field when it is left).
  const fix = (v: string, setV: (v: string) => void) => {
    if (!/^\d+$/.test(v.trim())) return;
    let n = Number(v);
    if (n > 500 || n < 155) {
      setError(printf(t('Supported range: 170%s - 500%s'), '℃', '℃'));
      n = n > 500 ? 500 : 155;
    }
    setV(String(Math.floor(n / 5) * 5));
  };
  return (
    <Shell
      title={t('Temperature calibration')}
      wiki="temp_calib"
      error={error}
      onClose={onClose}
      onOk={() => {
        const s = /^\d+$/.test(start.trim()) ? Number(start) : Number.NaN,
          e = /^\d+$/.test(end.trim()) ? Number(end) : Number.NaN;
        if (!(s <= 500) || !(e >= 155) || e > s - 5)
          return setError(t('Please input valid values:\nStart temp: <= 500\nEnd temp: >= 155\nStart temp >= End temp + 5'));
        onStart({
          request: { params: { mode: 'temp_tower', start: s, end: e, nozzle_based_resize: resize, test_model: belt ? model : 0 } },
          title: t('Nozzle temperature test'),
        });
      }}
    >
      <Radios
        legend={t('Filament type')}
        options={FILAMENTS.map((f) => t(f[0]))}
        value={type}
        onChange={(i) => {
          setType(i);
          setStart(String(FILAMENTS[i]![1]));
          setEnd(String(FILAMENTS[i]![2]));
        }}
      />
      {belt && <Radios legend={t('Test model')} options={[t('Standard'), t('Overhang')]} value={model} onChange={setModel} />}
      <Field name={label('Start temp: ')} value={start} onChange={setStart} unit="℃" onBlur={() => fix(start, setStart)} />
      <Field name={label('End temp: ')} value={end} onChange={setEnd} unit="℃" onBlur={() => fix(end, setEnd)} />
      <Field name={label('Temp step: ')} value="5" onChange={() => {}} unit="℃" disabled />
      <Check name={t('Auto-scale for nozzle')} value={resize} onChange={setResize} tip={t(SCALE_TIP)} />
    </Shell>
  );
}

// MaxVolumetricSpeed_Test_Dlg
function MaxFlowrateDialog({ onStart, onClose }: DialogProps) {
  const [start, setStart] = useState('5');
  const [end, setEnd] = useState('20');
  const [step, setStep] = useState('0.5');
  const [error, setError] = useState<string | null>(null);
  return (
    <Shell
      title={t('Max volumetric speed test')}
      wiki="volumetric_speed_calib"
      error={error}
      onClose={onClose}
      onOk={() => {
        const [s, e, st] = [num(start), num(end), num(step)];
        if (!(s > 0) || !(st > 0) || !(e >= s + st))
          return setError(t('Please input valid values:\nstart > 0\nstep >= 0\nend > start + step'));
        onStart({ request: { params: { mode: 'vol_speed_tower', start: s, end: e, step: st } }, title: t('Max volumetric speed test') });
      }}
    >
      <Field name={label('Start volumetric speed: ')} value={start} onChange={setStart} unit="mm³/s" />
      <Field name={label('End volumetric speed: ')} value={end} onChange={setEnd} unit="mm³/s" />
      <Field name={t('Step')} value={step} onChange={setStep} unit="mm³/s" />
    </Shell>
  );
}

/** Desktop's ParseStringValues: the whole positive numbers of a comma-separated list. */
function parseList(text: string): number[] {
  const out: number[] = [];
  for (const tok of text.replace(/,/g, ' ').trim().split(/\s+/)) {
    const m = /^[+-]?\d+/.exec(tok);
    if (!m) break;
    out.push(Number(m[0]));
    if (m[0].length < tok.length) break;
  }
  return out.filter((x) => x > 0);
}

// PA_Calibration_Dlg
function PaDialog({ onStart, onClose }: DialogProps) {
  const { belt } = useCfg();
  const [bowden, setBowden] = useState(false);
  const [method, setMethod] = useState(0);
  const defaults = (m: number, b: boolean) => ({
    start: '0',
    end: b ? '1' : m === 2 ? '0.08' : '0.1',
    step: b ? (m === 2 ? '0.05' : '0.02') : m === 2 ? '0.005' : '0.002',
    numbers: m !== 0,
  });
  const [v, setV] = useState(defaults(0, false));
  const [accels, setAccels] = useState('');
  const [speeds, setSpeeds] = useState('');
  const [error, setError] = useState<string | null>(null);
  const reset = (m: number, b: boolean) => setV(defaults(m, b));
  const beltOnly = t('Not enabled yet on belt printers — use the PA Tower method instead.');
  return (
    <Shell
      title={t('PA Calibration')}
      wiki="pressure_advance_calib"
      error={error}
      onClose={onClose}
      onOk={() => {
        const [s, e, st] = [num(v.start), num(v.end), num(v.step)];
        if (!(s >= 0) || !(st >= 10 * 1e-6) || !(e >= s + st))
          return setError(t('Please input valid values:\nStart PA: >= 0.0\nEnd PA: > Start PA\nPA step: >= 0.001'));
        if (belt && method !== 0)
          return setError(t('PA Line and PA Pattern tests are not enabled yet on belt printers.\nPlease use the PA Tower method instead.'));
        const a = method === 2 ? parseList(accels) : [],
          sp = method === 2 ? parseList(speeds) : [];
        if (a.length && sp.length && Math.min(...a) <= Math.max(...sp))
          return setError(t('Acceleration values must be greater than speed values.\nPlease verify the inputs.'));
        const mode: CalibParams['mode'] = method === 1 ? 'pa_line' : method === 2 ? 'pa_pattern' : 'pa_tower';
        onStart({
          request: { params: { mode, start: s, end: e, step: st, print_numbers: v.numbers, accelerations: a, speeds: sp } },
          title: t('Pressure Advance Test'),
        });
      }}
    >
      <Radios
        legend={t('Extruder type')}
        options={[t('DDE'), t('Bowden')]}
        value={bowden ? 1 : 0}
        onChange={(i) => {
          setBowden(i === 1);
          reset(method, i === 1);
        }}
      />
      <Radios
        legend={t('Method')}
        options={[t('PA Tower'), t('PA Line'), t('PA Pattern')]}
        value={method}
        disabled={(i) => (belt && i !== 0 ? beltOnly : null)}
        onChange={(i) => {
          setMethod(i);
          reset(i, bowden);
        }}
      />
      <Field name={label('Start PA: ')} value={v.start} onChange={(x) => setV({ ...v, start: x })} />
      <Field name={label('End PA: ')} value={v.end} onChange={(x) => setV({ ...v, end: x })} />
      <Field name={label('PA step: ')} value={v.step} onChange={(x) => setV({ ...v, step: x })} />
      <Check name={t('Print numbers')} value={v.numbers} onChange={(x) => setV({ ...v, numbers: x })} disabled={method !== 1} />
      <div className="row">
        <span className="caption">{label('Accelerations: ')}</span>
        <input
          type="text"
          inputMode="numeric"
          value={accels}
          disabled={method !== 2}
          aria-label={label('Accelerations: ')}
          data-tip={t('Comma-separated list of printing accelerations')}
          onChange={(e) => setAccels(e.target.value.replace(/[^\d,]/g, ''))}
        />
      </div>
      <div className="row">
        <span className="caption">{label('Speeds: ')}</span>
        <input
          type="text"
          inputMode="numeric"
          value={speeds}
          disabled={method !== 2}
          aria-label={label('Speeds: ')}
          data-tip={t('Comma-separated list of printing speeds')}
          onChange={(e) => setSpeeds(e.target.value.replace(/[^\d,]/g, ''))}
        />
      </div>
    </Shell>
  );
}

// FlowRateCalibrationDialog
function FlowRatioDialog({ onStart, onClose }: DialogProps) {
  const [type, setType] = useState(2);
  const [pattern, setPattern] = useState<'archimedeanchords' | 'monotonic'>('archimedeanchords');
  return (
    <Shell
      title={t('Flow Ratio Calibration')}
      wiki="flow_ratio_calib"
      error={null}
      onClose={onClose}
      onOk={() => {
        const linear = type >= 2;
        const pass = ((type % 2) + 1) as 1 | 2;
        const title = linear
          ? pass === 2
            ? t('Orca YOLO Flow Calibration - Perfectionist version')
            : t('Orca YOLO Flow Calibration')
          : printf(t('Flowrate Test - Pass%d'), pass);
        onStart({ request: { params: { mode: 'flow_rate' }, flow: { linear, pass, pattern } }, title });
      }}
    >
      <Radios
        legend={t('Calibration Test Type')}
        options={[t('Pass 1 (Coarse)'), t('Pass 2 (Fine)'), t('YOLO (Recommended)'), t('YOLO (Perfectionist)')]}
        value={type}
        onChange={setType}
      />
      <div className="row">
        <span className="caption">{t('Top Surface Pattern')}</span>
        <Select
          value={pattern}
          onChange={(v) => setPattern(v as typeof pattern)}
          aria-label={t('Top Surface Pattern')}
          items={[
            { value: 'archimedeanchords', label: t('Archimedean Chords') },
            { value: 'monotonic', label: t('Monotonic') },
          ]}
        />
      </div>
    </Shell>
  );
}

// Retraction_Test_Dlg
function RetractionDialog({ onStart, onClose }: DialogProps) {
  const [start, setStart] = useState('0');
  const [end, setEnd] = useState('2');
  const [step, setStep] = useState('0.1');
  const [error, setError] = useState<string | null>(null);
  return (
    <Shell
      title={t('Retraction')}
      wiki="retraction_calib"
      error={error}
      onClose={onClose}
      onOk={() => {
        const [s, e, st] = [num(start), num(end), num(step)];
        if (!(s >= 0) || !(st > 0) || !(e >= s + st))
          return setError(t('Please input valid values:\nstart > 0\nstep >= 0\nend > start + step'));
        onStart({ request: { params: { mode: 'retraction_tower', start: s, end: e, step: st } }, title: t('Retraction') });
      }}
    >
      <Field name={label('Start retraction length: ')} value={start} onChange={setStart} unit={t('mm')} />
      <Field name={label('End retraction length: ')} value={end} onChange={setEnd} unit={t('mm')} />
      <Field name={t('Step')} value={step} onChange={setStep} unit={t('mm')} />
    </Shell>
  );
}

/** Marlin 2 with a maximum junction deviation set: the cornering test is of that, not jerk. */
const junctionDeviation = (get: (k: string) => string) =>
  get('gcode_flavor') === 'marlin2' && Number(get('machine_max_junction_deviation')) > 0;

// Cornering_Test_Dlg
function CorneringDialog({ onStart, onClose }: DialogProps) {
  const { get } = useCfg();
  const jd = junctionDeviation(get);
  const flavor = get('gcode_flavor');
  const [model, setModel] = useState(0);
  const [start, setStart] = useState(jd ? '0.000' : '1.000');
  const [end, setEnd] = useState(jd ? '0.250' : '15.000');
  const [error, setError] = useState<string | null>(null);
  const unit = jd ? t('mm') : t('mm/s');
  const note2 =
    flavor === 'marlin2'
      ? jd
        ? t("Marlin 2 Junction Deviation detected:\nTo test Classic Jerk, set 'Maximum Junction Deviation' in Motion ability to 0.")
        : t(
            "Marlin 2 Classic Jerk detected:\nTo test Junction Deviation, set 'Maximum Junction Deviation' in Motion ability to a value > 0.",
          )
      : flavor === 'reprapfirmware'
        ? t('RepRap detected: Jerk in mm/s.\nOrcaSlicer will convert the values to mm/min when necessary.')
        : null;
  return (
    <Shell
      title={t('Cornering test')}
      wiki="cornering_calib"
      error={error}
      onClose={onClose}
      onOk={() => {
        const [s, e] = [num(start), num(end)];
        const max = jd ? 0.3 : 100,
          warn = jd ? 0.25 : 20;
        if (!(s >= 0) || !(e <= max) || !(s < e))
          return setError(printf(t('Please input valid values:\n(0 <= Cornering <= %s)'), max.toFixed(3)));
        if (e > warn) notify({ kind: 'warning', title: printf(t('NOTE: High values may cause Layer shift (>%s)'), warn.toFixed(3)) });
        onStart({ request: { params: { mode: 'cornering', start: s, end: e, test_model: model } }, title: t('Cornering test') });
      }}
    >
      <Radios legend={t('Test model')} options={[t('Ringing Tower'), t('Fast Tower'), t('SCV-V2')]} value={model} onChange={setModel} />
      <Field name={label('Start: ')} value={start} onChange={setStart} unit={unit} />
      <Field name={label('End: ')} value={end} onChange={setEnd} unit={unit} />
      <Note>{t('Note: Lower values = sharper corners but slower speeds.')}</Note>
      {note2 && <Note>{note2}</Note>}
    </Shell>
  );
}

/** The input shaper types the printer's firmware has (Tab's input_shaper_types_for_flavor), less Disable. */
function shaperTypes(flavor: string): string[] {
  if (flavor === 'klipper') return ['Default', 'ZV', 'MZV', 'ZVD', 'EI', '2HUMP_EI', '3HUMP_EI'];
  if (flavor === 'reprapfirmware') return ['Default', 'MZV', 'ZVD', 'ZVDD', 'ZVDDD', 'EI2', 'EI3', 'DAA'];
  if (flavor === 'marlin2') return ['ZV'];
  return ['Default'];
}

function firmwareNote(flavor: string, fallback: string) {
  if (flavor === 'marlin2' || flavor === 'marlin') return t('Marlin version => 2.1.2\nFixed-Time motion not yet implemented.');
  if (flavor === 'klipper') return t('Klipper version => 0.9.0');
  if (flavor === 'reprapfirmware')
    return t('RepRapFirmware version => 3.4.0\nCheck your firmware documentation for supported shaper types.');
  return fallback;
}

// Input_Shaping_Freq_Test_Dlg
function ShapingFreqDialog({ onStart, onClose }: DialogProps) {
  const { get } = useCfg();
  const flavor = get('gcode_flavor');
  const rrf = flavor === 'reprapfirmware';
  const types = shaperTypes(flavor);
  const [model, setModel] = useState(0);
  const [type, setType] = useState(0);
  const [x, setX] = useState(['15', '110']);
  const [y, setY] = useState(['15', '110']);
  const [damp, setDamp] = useState('0.150');
  const [error, setError] = useState<string | null>(null);
  const sameTip = rrf ? t('RepRapFirmware uses the same frequency range for both axes.') : undefined;
  return (
    <Shell
      title={t('Input shaping Frequency test')}
      wiki="input_shaping_calib"
      error={error}
      onClose={onClose}
      onOk={() => {
        const [sx, ex] = x.map(num) as [number, number];
        const [sy, ey] = rrf ? [sx, ex] : (y.map(num) as [number, number]);
        const d = num(damp);
        if (Number.isNaN(d) || !(sx >= 0) || !(ex <= 500) || !(sy >= 0) || !(ey <= 500) || !(sx < ex) || !(sy < ey))
          return setError(t('Please input valid values:\n(0 < FreqStart < FreqEnd < 500)'));
        if (!(d >= 0 && d < 1)) return setError(t('Please input a valid damping factor (0 < Damping/zeta factor <= 1)'));
        onStart({
          request: {
            params: {
              mode: 'input_shaping_freq',
              freqStartX: sx,
              freqEndX: ex,
              freqStartY: sy,
              freqEndY: ey,
              start: d,
              shaper_type: types[type] ?? '',
              test_model: model === 0 ? 0 : 1,
            },
          },
          title: t('Input shaping Frequency test'),
        });
      }}
    >
      <Radios legend={t('Test model')} options={[t('Ringing Tower'), t('Fast Tower')]} value={model} onChange={setModel} />
      <Radios legend={t('Input shaper type')} options={types.map((x) => t(x))} value={type} onChange={setType} />
      <Note>{firmwareNote(flavor, t('Please ensure the selected type is compatible with your firmware version.'))}</Note>
      <Field
        name={label(rrf ? 'Frequency (Start / End): ' : 'X Start / End: ')}
        value={x[0]!}
        onChange={(v) => setX([v, x[1]!])}
        second={{ value: x[1]!, onChange: (v) => setX([x[0]!, v]), name: t('End') }}
        unit={t('Hz')}
        tip={sameTip}
      />
      {!rrf && (
        <Field
          name={label('Y Start / End: ')}
          value={y[0]!}
          onChange={(v) => setY([v, y[1]!])}
          second={{ value: y[1]!, onChange: (v) => setY([y[0]!, v]), name: t('End') }}
          unit={t('Hz')}
        />
      )}
      <Field name={label('Damp: ')} value={damp} onChange={setDamp} />
      <Note>{t("Recommended: Set Damp to 0.\nThis will use the printer's default or saved value.")}</Note>
    </Shell>
  );
}

// Input_Shaping_Damp_Test_Dlg
function ShapingDampDialog({ onStart, onClose }: DialogProps) {
  const { get } = useCfg();
  const flavor = get('gcode_flavor');
  const rrf = flavor === 'reprapfirmware';
  const types = shaperTypes(flavor);
  const [model, setModel] = useState(0);
  const [type, setType] = useState(0);
  const [freq, setFreq] = useState(['30', '30']);
  const [damp, setDamp] = useState(['0.000', '0.400']);
  const [error, setError] = useState<string | null>(null);
  return (
    <Shell
      title={t('Input shaping Damp test')}
      wiki="input_shaping_calib"
      error={error}
      onClose={onClose}
      onOk={() => {
        const fx = num(freq[0]!),
          fy = rrf ? fx : num(freq[1]!);
        const [s, e] = damp.map(num) as [number, number];
        if (Number.isNaN(s) || Number.isNaN(e) || !(fx >= 0 && fx <= 500) || !(fy >= 0 && fy <= 500))
          return setError(t('Please input valid values:\n(0 < Freq < 500)'));
        if (!(s >= 0) || !(e <= 1) || !(s < e))
          return setError(t('Please input a valid damping factor (0 <= DampingStart < DampingEnd <= 1)'));
        onStart({
          request: {
            params: {
              mode: 'input_shaping_damp',
              freqStartX: fx,
              freqStartY: fy,
              start: s,
              end: e,
              shaper_type: types[type] ?? '',
              test_model: model === 0 ? 0 : 1,
            },
          },
          title: t('Input shaping Damping test'),
        });
      }}
    >
      <Radios legend={t('Test model')} options={[t('Ringing Tower'), t('Fast Tower')]} value={model} onChange={setModel} />
      <Radios legend={t('Input shaper type')} options={types.map((x) => t(x))} value={type} onChange={setType} />
      <Note>{firmwareNote(flavor, t('Check firmware compatibility.'))}</Note>
      <Field
        name={label(rrf ? 'Frequency: ' : 'Frequency X / Y: ')}
        value={freq[0]!}
        onChange={(v) => setFreq([v, freq[1]!])}
        {...(rrf ? {} : { second: { value: freq[1]!, onChange: (v: string) => setFreq([freq[0]!, v]), name: 'Y' } })}
        unit={t('Hz')}
        tip={rrf ? t('RepRapFirmware uses the same frequency for both axes.') : undefined}
      />
      <Field
        name={label('Damp (Start / End): ')}
        value={damp[0]!}
        onChange={(v) => setDamp([v, damp[1]!])}
        second={{ value: damp[1]!, onChange: (v) => setDamp([damp[0]!, v]), name: t('End') }}
      />
      <Note>{t('Note: Use previously calculated frequencies.')}</Note>
    </Shell>
  );
}

// VFA_Test_Dlg
function VfaDialog({ onStart, onClose }: DialogProps) {
  const [start, setStart] = useState('40');
  const [end, setEnd] = useState('200');
  const [step, setStep] = useState('10');
  const [resize, setResize] = useState(true);
  const [adjust, setAdjust] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const adjustTip = t(
    "If the end speed would exceed the filament's maximum volumetric speed, automatically lower the layer height (keeping standard values and staying within the machine's limits) to reach it. If even the minimum layer height is not enough, lower the end speed instead.",
  );
  return (
    <Shell
      title={t('VFA test')}
      wiki="vfa_calib"
      error={error}
      onClose={onClose}
      onOk={async () => {
        const [s, e, st] = [num(start), num(end), num(step)];
        if (!(s > 10) || !(st > 0) || !(e >= s + st))
          return setError(t('Please input valid values:\nstart > 10\nstep >= 0\nend > start + step'));
        // Above the filament's max volumetric speed the outer wall speed is clamped, so the upper
        // blocks would all print at one speed: lower the layer height (or the end speed), or warn.
        let endSpeed = e,
          layer = 0;
        const c = await checkVfaSpeed(s, e, st, resize);
        const clamp = (question: string) =>
          ask(
            printf(
              t(
                "The end speed (%.0f mm/s) exceeds the filament's maximum volumetric speed (%.1f mm³/s), which limits the outer wall to about %.0f mm/s at this line width and layer height.\nSpeeds above this will be clamped, so the upper blocks of the tower will not print at the requested speed.\n\n%s",
              ),
              e,
              c.max_vol_speed,
              c.limit,
              question,
            ),
            { confirm: t('Yes') },
          );
        if (c.exceeds) {
          if (adjust && resize) {
            if (c.chosen_lh > 0) {
              layer = c.chosen_lh;
              notify({
                kind: 'info',
                title: t('VFA test'),
                message: printf(
                  t(
                    "The end speed (%.0f mm/s) exceeds the filament's maximum volumetric speed (%.1f mm³/s) at the default layer height (%.2f mm).\n\nThe layer height has been reduced to %.2f mm (a value used by this printer's profiles) so the tower can reach the requested speed.",
                  ),
                  e,
                  c.max_vol_speed,
                  c.default_lh,
                  c.chosen_lh,
                ),
              });
            } else if (c.min_lh > 0) {
              const ok = await ask(
                printf(
                  t(
                    "Even at the smallest layer height used by this printer's profiles (%.2f mm) the end speed (%.0f mm/s) exceeds the filament's maximum volumetric speed (%.1f mm³/s).\n\nThe layer height will be set to %.2f mm and the end speed lowered to %.0f mm/s.\n\nContinue?",
                  ),
                  c.min_lh,
                  e,
                  c.max_vol_speed,
                  c.min_lh,
                  c.new_end,
                ),
                { confirm: t('Yes') },
              );
              if (!ok) return;
              endSpeed = c.new_end;
              layer = c.min_lh;
            } else if (!(await clamp(t('Continue anyway?')))) return;
          } else if (
            !(await clamp(
              resize
                ? t('Enable "Auto-adjust" to fix this automatically, or continue anyway?')
                : t('Enable "Auto-scale for nozzle" and "Auto-adjust" to fix this automatically, or continue anyway?'),
            ))
          )
            return;
        }
        onStart({
          request: {
            params: { mode: 'vfa_tower', start: s, end: endSpeed, step: st, nozzle_based_resize: resize, vfa_layer_height: layer },
          },
          title: t('VFA test'),
        });
      }}
    >
      <Field name={label('Start speed: ')} value={start} onChange={setStart} unit={t('mm/s')} />
      <Field name={label('End speed: ')} value={end} onChange={setEnd} unit={t('mm/s')} />
      <Field name={t('Step')} value={step} onChange={setStep} unit={t('mm/s')} />
      <Check name={t('Auto-scale for nozzle')} value={resize} onChange={setResize} tip={t(SCALE_TIP)} />
      <Check name={t('Auto-adjust to max volumetric speed')} value={adjust} onChange={setAdjust} tip={adjustTip} />
    </Shell>
  );
}
