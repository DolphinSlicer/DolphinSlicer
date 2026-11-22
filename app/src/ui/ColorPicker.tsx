// The app's color field, in place of the browser's: a swatch with the hex code that opens a
// picker (saturation and brightness area, hue slider, hex code and, where the browser has one,
// the eyedropper). The color is set when a drag or key press ends, not on every move.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Pipette } from 'lucide-react';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { t } from '../i18n/i18n';

/** Hue 0–360, saturation and brightness 0–1. */
export interface Hsv {
  h: number;
  s: number;
  v: number;
}

const HEX = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i;

/** "#RRGGBB" or "#RGB", with or without the "#"; null for anything else. */
export function parseHex(text: string): string | null {
  const m = HEX.exec(text.trim());
  if (!m) return null;
  const d = m[1]!.length === 3 ? [...m[1]!].map((c) => c + c).join('') : m[1]!;
  return `#${d.toUpperCase()}`;
}

export function hexToHsv(hex: string): Hsv {
  const d = parseHex(hex) ?? '#000000';
  const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(d.slice(i, i + 2), 16) / 255) as [number, number, number];
  const max = Math.max(r, g, b),
    c = max - Math.min(r, g, b);
  let h = 0;
  if (c > 0) {
    if (max === r) h = ((g - b) / c) % 6;
    else if (max === g) h = (b - r) / c + 2;
    else h = (r - g) / c + 4;
    h = (h * 60 + 360) % 360;
  }
  return { h, s: max ? c / max : 0, v: max };
}

export function hsvToHex({ h, s, v }: Hsv): string {
  const f = (n: number) => {
    const k = (n + h / 60) % 6;
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
  };
  return `#${[f(5), f(3), f(1)]
    .map((x) =>
      Math.round(x * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')
    .toUpperCase()}`;
}

const clamp = (x: number) => Math.min(1, Math.max(0, x));
const GAP = 4,
  MARGIN = 8;

interface EyeDropperApi {
  open(): Promise<{ sRGBHex: string }>;
}
const EyeDropper = (globalThis as unknown as { EyeDropper?: new () => EyeDropperApi }).EyeDropper;

/** The eyedropper's color: "#rrggbb", or "rgb(r, g, b)" in older browsers. */
function pickedHex(s: string): string | null {
  const rgb = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(s);
  if (!rgb) return parseHex(s);
  return `#${rgb
    .slice(1, 4)
    .map((n) => Number(n).toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase()}`;
}

export function ColorPicker({
  value,
  onChange,
  disabled,
  'aria-label': label,
}: {
  /** "#RRGGBB"; anything else (none set) shows as black, and black can be chosen. */
  value: string;
  onChange: (hex: string) => void;
  disabled?: boolean;
  'aria-label'?: string;
}) {
  const uid = useId();
  const [open, setOpen] = useState(false);
  const [hsv, setHsv] = useState(() => hexToHsv(value));
  const current = useRef(hsv);
  current.current = hsv;
  const valueHex = parseHex(value);
  const hex = hsvToHex(hsv);
  const [hexText, setHexText] = useState(hex);
  const trigger = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const area = useRef<HTMLDivElement>(null);
  // For the listeners set up when the picker opened.
  const latest = useRef({ valueHex, onChange });
  latest.current = { valueHex, onChange };

  // The value from outside, unless it is the color shown (a gray keeps the hue it was picked with).
  useEffect(() => {
    const shown = valueHex ?? '#000000';
    if (hsvToHex(current.current) !== shown) setHsv(hexToHsv(shown));
  }, [valueHex]);
  useEffect(() => setHexText(hex), [hex]);

  /** The color as it is now becomes the value (a drag or key press ended). */
  const settle = (next = current.current) => {
    const h = hsvToHex(next);
    if (h !== latest.current.valueHex) latest.current.onChange(h);
  };
  const update = (next: Hsv, now = false) => {
    current.current = next;
    setHsv(next);
    if (now) settle(next);
  };

  const close = (focus = true) => {
    settle();
    setOpen(false);
    if (focus) trigger.current?.focus();
  };

  // In the top layer next to the field: below it, or above if there is more room there.
  useLayoutEffect(() => {
    const el = pop.current,
      tr = trigger.current;
    if (!open || !el || !tr) return;
    if (!el.matches(':popover-open')) el.showPopover?.();
    const place = () => {
      const r = tr.getBoundingClientRect();
      const vw = window.innerWidth,
        vh = window.innerHeight,
        h = el.offsetHeight;
      const down = vh - r.bottom - GAP - MARGIN >= h || vh - r.bottom > r.top;
      el.style.top = `${Math.max(MARGIN, down ? r.bottom + GAP : r.top - GAP - h)}px`;
      el.style.left = `${Math.max(MARGIN, Math.min(r.left, vw - el.offsetWidth - MARGIN))}px`;
      if (down) delete el.dataset.up;
      else el.dataset.up = '';
    };
    place();
    const onScroll = (e: Event) => {
      if (!el.contains(e.target as Node)) place();
    };
    const onDown = (e: PointerEvent) => {
      const n = e.target as Node;
      if (!el.contains(n) && !tr.contains(n)) close(false);
    };
    window.addEventListener('resize', place);
    window.addEventListener('scroll', onScroll, true);
    document.addEventListener('pointerdown', onDown, true);
    area.current?.focus();
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', onScroll, true);
      document.removeEventListener('pointerdown', onDown, true);
    };
  }, [open]);

  useEffect(() => {
    if (disabled && open) close(false);
  }, [disabled]);

  // The area: across is saturation, up is brightness.
  const fromPointer = (e: React.PointerEvent) => {
    const r = area.current!.getBoundingClientRect();
    update({ ...current.current, s: clamp((e.clientX - r.left) / r.width), v: clamp(1 - (e.clientY - r.top) / r.height) });
  };
  const areaKey = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 0.1 : 0.01;
    const { s, v } = current.current;
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [s - step, v],
      ArrowRight: [s + step, v],
      ArrowUp: [s, v + step],
      ArrowDown: [s, v - step],
      Home: [0, v],
      End: [1, v],
      PageUp: [s, 1],
      PageDown: [s, 0],
    };
    const m = moves[e.key];
    if (!m) return;
    e.preventDefault();
    update({ ...current.current, s: clamp(m[0]), v: clamp(m[1]) });
  };

  const typedHex = () => {
    const h = parseHex(hexText);
    if (h) update(hexToHsv(h), true);
    else setHexText(hex);
  };

  const pick = async () => {
    try {
      const h = pickedHex((await new EyeDropper!().open()).sRGBHex);
      if (h) update(hexToHsv(h), true);
    } catch {
      /* canceled */
    }
  };

  const hueColor = hsvToHex({ h: hsv.h, s: 1, v: 1 });
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="color-trigger"
        disabled={disabled}
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? uid : undefined}
        onClick={() => (open ? close() : setOpen(true))}
      >
        <span className="color-swatch" style={{ background: hex }} />
        <span className="color-code">{hex}</span>
      </button>
      {open && (
        <div
          ref={pop}
          id={uid}
          popover="manual"
          role="dialog"
          aria-label={label}
          className="color-pop"
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              close();
            }
          }}
        >
          <div
            ref={area}
            className="color-area"
            role="slider"
            tabIndex={0}
            aria-label={`${t('Saturation')} / ${t('Brightness')}`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(hsv.s * 100)}
            aria-valuetext={`${t('Saturation')} ${Math.round(hsv.s * 100)}%, ${t('Brightness')} ${Math.round(hsv.v * 100)}%`}
            style={{ backgroundColor: hueColor }}
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId);
              e.currentTarget.focus();
              fromPointer(e);
            }}
            onPointerMove={(e) => {
              if (e.currentTarget.hasPointerCapture(e.pointerId)) fromPointer(e);
            }}
            onPointerUp={() => settle()}
            onKeyDown={areaKey}
            onKeyUp={() => settle()}
          >
            <span className="color-thumb" style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%`, background: hex }} />
          </div>
          <div className="color-row">
            {EyeDropper && (
              <button type="button" className="icon-btn" onClick={pick} aria-label={t('Pick from screen')} data-tip={t('Pick from screen')}>
                <Pipette size={16} />
              </button>
            )}
            <input
              type="range"
              className="hue-slider"
              min={0}
              max={359}
              step={1}
              value={Math.round(hsv.h) % 360}
              aria-label={t('Hue')}
              style={{ '--thumb': hueColor } as React.CSSProperties}
              onChange={(e) => update({ ...current.current, h: Number(e.target.value) })}
              onPointerUp={() => settle()}
              onKeyUp={() => settle()}
            />
          </div>
          <div className="color-row">
            <span className="color-preview" style={{ background: hex }} />
            <input
              type="text"
              className="color-hex"
              value={hexText}
              spellCheck={false}
              maxLength={7}
              aria-label={label}
              onChange={(e) => setHexText(e.target.value)}
              onBlur={typedHex}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  typedHex();
                }
              }}
            />
          </div>
        </div>
      )}
    </>
  );
}
