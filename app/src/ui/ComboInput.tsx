// A text field with suggestions, in place of the browser's <input list> (whose popup can't be
// styled): type anything, or pick from the list (a click on the field shows it all; typing narrows
// it). Desktop's editable combo box. The list looks and is placed like the dropdown's (Select.tsx).
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Check } from 'lucide-react';
import { type InputHTMLAttributes, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { fold, placePopup } from './Select';

export interface ComboOption {
  value: string;
  /** Shown in place of the value. */
  label?: string;
}

type InputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'list' | 'role' | 'type'>;

export interface ComboInputProps extends InputProps {
  value: string;
  options: ComboOption[];
  /** Each change, typed or picked. */
  onChange: (value: string) => void;
  /** A suggestion was picked (after onChange). */
  onPick?: (value: string) => void;
  'data-testid'?: string;
}

export function ComboInput({
  value,
  options,
  onChange,
  onPick,
  className,
  onKeyDown,
  onBlur,
  readOnly,
  disabled,
  ...input
}: ComboInputProps) {
  const uid = useId();
  const listId = `${uid}-list`;
  const optionId = (n: number) => `${uid}-o${n}`;
  const wrap = useRef<HTMLSpanElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  /** Narrow the list to the text: after typing, not when opened with the arrow. */
  const [filter, setFilter] = useState(false);
  const [active, setActive] = useState(-1);

  const shown = useMemo(() => {
    const terms = filter ? fold(value).split(/\s+/).filter(Boolean) : [];
    return options.filter((o) => terms.every((w) => fold(`${o.label ?? ''} ${o.value}`).includes(w)));
  }, [options, value, filter]);
  // Nothing to suggest beyond what is typed: no list (as the browser's).
  const visible = open && shown.length > 0 && !(filter && shown.length === 1 && shown[0]!.value === value);

  const close = () => {
    setOpen(false);
    setActive(-1);
  };
  const show = (narrow: boolean) => {
    if (readOnly || disabled) return;
    setFilter(narrow);
    setOpen(true);
    setActive(-1);
  };
  const pick = (o: ComboOption) => {
    close();
    onChange(o.value);
    onPick?.(o.value);
  };

  useLayoutEffect(() => {
    const el = pop.current,
      anchor = wrap.current;
    if (!visible || !el || !anchor) return;
    if (!el.matches(':popover-open')) el.showPopover?.();
    // Next to the field even on a phone: a sheet would cover the field while typing.
    const place = () => placePopup(el, anchor, { anchored: true });
    place();
    const onScroll = (e: Event) => {
      if (!el.contains(e.target as Node)) place();
    };
    const onDown = (e: PointerEvent) => {
      if (!el.contains(e.target as Node) && !anchor.contains(e.target as Node)) close();
    };
    window.addEventListener('resize', place);
    window.addEventListener('scroll', onScroll, true);
    document.addEventListener('pointerdown', onDown, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', onScroll, true);
      document.removeEventListener('pointerdown', onDown, true);
    };
  }, [visible, shown]);

  useEffect(() => {
    if (visible && active >= 0) document.getElementById(optionId(active))?.scrollIntoView({ block: 'nearest' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, active]);

  const keys = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const move = (n: number) => {
      e.preventDefault();
      if (!visible) return show(false);
      setActive(Math.max(0, Math.min(shown.length - 1, n)));
    };
    switch (e.key) {
      case 'ArrowDown':
        return move(active + 1);
      case 'ArrowUp':
        return visible ? move(active - 1) : undefined;
      case 'Enter':
        if (visible && active >= 0) {
          e.preventDefault();
          pick(shown[active]!);
          return;
        }
        close();
        break;
      case 'Escape':
        if (visible) {
          // Only the list closes, not the dialog the field is in.
          e.preventDefault();
          e.stopPropagation();
          close();
          return;
        }
        break;
      case 'Tab':
        close();
    }
    onKeyDown?.(e);
  };

  return (
    <span ref={wrap} className="combo" data-empty={options.length ? undefined : ''}>
      <input
        {...input}
        className={className}
        type="text"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={visible}
        aria-controls={listId}
        aria-activedescendant={visible && active >= 0 ? optionId(active) : undefined}
        autoComplete="off"
        value={value}
        readOnly={readOnly}
        disabled={disabled}
        onChange={(e) => {
          onChange(e.target.value);
          show(true);
        }}
        onClick={() => (visible ? close() : show(false))}
        onKeyDown={keys}
        onBlur={(e) => {
          if (!pop.current?.contains(e.relatedTarget as Node)) close();
          onBlur?.(e);
        }}
      />
      {visible && (
        <div ref={pop} popover="manual" className="select-pop" onMouseDown={(e) => e.preventDefault()}>
          <div id={listId} role="listbox" className="select-list" aria-label={input['aria-label']}>
            {shown.map((o, n) => (
              <div
                key={o.value}
                id={optionId(n)}
                role="option"
                aria-selected={o.value === value}
                data-value={o.value}
                data-active={n === active ? '' : undefined}
                className="select-opt"
                onPointerMove={() => n !== active && setActive(n)}
                onClick={() => pick(o)}
              >
                <span className="select-check" aria-hidden>
                  {o.value === value && <Check size={14} />}
                </span>
                <span className="select-label">{o.label || o.value}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </span>
  );
}
