// The app's dropdown, in place of the browser's <select>: options in groups, color swatches, a
// search box for long lists and actions after the options. Keyboard and screen readers work as
// with a select (WAI-ARIA combobox with a listbox popup).
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Check, Search } from 'lucide-react';
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { t } from '../i18n/i18n';

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
  swatch?: string;
  lang?: string;
}
export interface SelectGroup {
  group: string;
  options: SelectOption[];
}
export type SelectItem = SelectOption | SelectGroup;
export interface SelectAction {
  label: string;
  onSelect: () => void;
}

export interface SelectProps {
  value: string;
  items: SelectItem[];
  onChange: (value: string) => void;
  /** Rows after the options that run something instead of choosing a value. */
  actions?: SelectAction[];
  disabled?: boolean;
  /** Shown closed in place of the selected option's label. */
  display?: string;
  id?: string;
  className?: string;
  'aria-label'?: string;
  'aria-labelledby'?: string;
  'data-testid'?: string;
}

/** Lists this long get a search box. */
const SEARCH_FROM = 12;
const GAP = 4;
const MARGIN = 8;
/** Lists with this many rows draw only those in view (all the presets to compare with: thousands). */
const VIRTUAL_FROM = 300;
/** Row heights in such lists (styles.css sets them): option (in a sheet), group title, separator. */
const OPT_H = 30,
  SHEET_OPT_H = 40,
  GROUP_H = 26,
  SEP_H = 9;
/** Rows drawn above and below the view, in pixels. */
const OVERSCAN = 300;

type Entry = { kind: 'option'; opt: SelectOption } | { kind: 'action'; action: SelectAction };
type Row = { kind: 'group'; label: string; rows: Row[] } | (Entry & { nav: number }) | { kind: 'separator' };

const isGroup = (i: SelectItem): i is SelectGroup => 'group' in i;
const allOptions = (items: SelectItem[]) => items.flatMap((i) => (isGroup(i) ? i.options : [i]));
const fold = (s: string) => s.toLocaleLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');
const lineCount = (rows: Row[]) => rows.reduce((n, r) => n + (r.kind === 'group' ? 1 + r.rows.length : 1), 0);

const NO_ACTIONS: SelectAction[] = [];

export function Select({ value, items, onChange, actions = NO_ACTIONS, disabled, display, id, className, ...aria }: SelectProps) {
  const uid = useId();
  const listId = `${uid}-list`;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(-1);
  const trigger = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const typed = useRef({ text: '', at: 0 });
  /** The list's scroll position and height, for drawing only the rows in view. */
  const [view, setView] = useState({ top: 0, height: 380 });

  const options = useMemo(() => allOptions(items), [items]);
  const selected = options.find((o) => o.value === value);
  const searchable = options.length >= SEARCH_FROM;
  // A long list draws only the rows in view; its width doesn't follow them, it is the widest.
  const fixedWidth = options.length >= VIRTUAL_FROM;

  // What the open list shows (filtered by the search), and the rows the keys move through.
  const searchText = useMemo(() => new WeakMap<SelectOption, string>(), [items]);
  const { rows, nav } = useMemo(() => {
    const terms = fold(query).split(/\s+/).filter(Boolean);
    const text = (o: SelectOption, group: string) => {
      let s = searchText.get(o);
      if (s === undefined) searchText.set(o, (s = fold(`${group} ${o.label}`)));
      return s;
    };
    const match = (o: SelectOption, group = '') => !terms.length || terms.every((w) => text(o, group).includes(w));
    const nav: Entry[] = [];
    const entry = (e: Entry): Row => {
      const disabledRow = e.kind === 'option' && e.opt.disabled;
      if (!disabledRow) nav.push(e);
      return { ...e, nav: disabledRow ? -1 : nav.length - 1 };
    };
    const rows: Row[] = [];
    for (const i of items) {
      if (isGroup(i)) {
        const opts = i.options.filter((o) => match(o, i.group));
        if (opts.length) rows.push({ kind: 'group', label: i.group, rows: opts.map((opt) => entry({ kind: 'option', opt })) });
      } else if (match(i)) rows.push(entry({ kind: 'option', opt: i }));
    }
    if (actions.length && !terms.length) {
      if (rows.length) rows.push({ kind: 'separator' });
      for (const action of actions) rows.push(entry({ kind: 'action', action }));
    }
    return { rows, nav };
  }, [items, actions, query, searchText]);

  // A long list: where each row is (rows of fixed heights), to draw only those in view.
  const sheet = open && window.matchMedia('(max-width: 600px)').matches;
  const virtual = open && lineCount(rows) >= VIRTUAL_FROM;
  const layout = useMemo(() => {
    if (!virtual) return null;
    const optH = sheet ? SHEET_OPT_H : OPT_H;
    const navTop: number[] = [];
    let y = 0;
    const tops = rows.map((r) => {
      const top = y;
      if (r.kind === 'group') {
        y += GROUP_H;
        for (const o of r.rows) {
          if ('nav' in o && o.nav >= 0) navTop[o.nav] = y;
          y += optH;
        }
      } else if (r.kind === 'separator') y += SEP_H;
      else {
        if (r.nav >= 0) navTop[r.nav] = y;
        y += optH;
      }
      return top;
    });
    return { tops, navTop, optH, total: y };
  }, [virtual, sheet, rows]);
  useLayoutEffect(() => {
    const el = list.current;
    if (!open || !el) return;
    const next = { top: el.scrollTop, height: el.clientHeight || 380 };
    setView((v) => (v.top === next.top && v.height === next.height ? v : next));
  }, [open, rows]);

  const selectedNav = nav.findIndex((e) => e.kind === 'option' && e.opt.value === value);
  const optionId = (n: number) => `${uid}-o${n}`;

  const close = (focus = true) => {
    setOpen(false);
    setQuery('');
    if (focus) trigger.current?.focus();
  };
  const openList = (q = '') => {
    if (disabled) return;
    setQuery(q);
    setOpen(true);
  };
  const commit = (e: Entry | undefined) => {
    if (!e) return;
    close();
    if (e.kind === 'action') e.action.onSelect();
    else if (e.opt.value !== value) onChange(e.opt.value);
  };

  // On opening and on each search, the selected option (or the first match) is the active one.
  useEffect(() => {
    if (open) setActive(selectedNav >= 0 ? selectedNav : nav.length ? 0 : -1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, query]);

  // Show the list in the top layer (above dialogs, outside clipped containers), next to the field.
  useLayoutEffect(() => {
    const el = pop.current,
      tr = trigger.current;
    if (!open || !el || !tr) return;
    if (!el.matches(':popover-open')) el.showPopover?.();
    const place = () => {
      const r = tr.getBoundingClientRect();
      const vw = window.innerWidth,
        vh = window.innerHeight;
      if (window.matchMedia('(max-width: 600px)').matches) {
        el.dataset.sheet = '';
        Object.assign(el.style, { top: '', left: '', bottom: '', width: '', minWidth: '', maxWidth: '', maxHeight: '' });
        return;
      }
      delete el.dataset.sheet;
      el.style.minWidth = `${r.width}px`;
      el.style.maxWidth = `${Math.min(vw - 2 * MARGIN, Math.max(r.width, 460))}px`;
      el.style.width = fixedWidth ? el.style.maxWidth : '';
      const below = vh - r.bottom - GAP - MARGIN,
        above = r.top - GAP - MARGIN;
      el.style.maxHeight = '';
      const natural = Math.min(el.scrollHeight, 380);
      const down = below >= natural || below >= above;
      el.style.maxHeight = `${Math.min(380, down ? below : above)}px`;
      if (down) delete el.dataset.up;
      else el.dataset.up = '';
      el.style.top = down ? `${r.bottom + GAP}px` : '';
      el.style.bottom = down ? '' : `${vh - r.top + GAP}px`;
      el.style.left = `${Math.max(MARGIN, Math.min(r.left, vw - el.offsetWidth - MARGIN))}px`;
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
    if (searchable) search.current?.focus();
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', onScroll, true);
      document.removeEventListener('pointerdown', onDown, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, searchable, fixedWidth]);

  // Keep the active option in view (in a long list, where it is drawn once it is in view).
  useEffect(() => {
    const el = list.current;
    if (open && active >= 0 && layout && el) {
      const top = layout.navTop[active] ?? 0,
        padding = 4;
      if (top + padding < el.scrollTop) el.scrollTop = top + padding;
      else if (top + layout.optH + padding > el.scrollTop + el.clientHeight) el.scrollTop = top + layout.optH + padding - el.clientHeight;
    } else if (open && active >= 0) document.getElementById(optionId(active))?.scrollIntoView({ block: 'nearest' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, active, rows]);

  // A disabled dropdown closes. One disabled while it has the focus (a choice loading) gets the
  // focus back when it is enabled again, unless the focus moved on.
  const refocus = useRef(false);
  useLayoutEffect(() => {
    if (disabled) {
      if (open) close(false);
      if (document.activeElement === trigger.current || pop.current?.contains(document.activeElement)) refocus.current = true;
    } else if (refocus.current) {
      refocus.current = false;
      if (!document.activeElement || document.activeElement === document.body) trigger.current?.focus();
    }
  }, [disabled]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Typing a name's first letters moves to it (without a search box). */
  const typeAhead = (ch: string) => {
    const now = Date.now();
    const text = now - typed.current.at > 600 ? ch : typed.current.text + ch;
    typed.current = { text, at: now };
    const start = text.length === 1 ? active + 1 : Math.max(active, 0);
    const label = (e: Entry) => fold(e.kind === 'option' ? e.opt.label : e.action.label);
    for (let k = 0; k < nav.length; k++) {
      const n = (start + k) % nav.length;
      if (label(nav[n]!).startsWith(fold(text))) return n;
    }
    return -1;
  };

  const onKey = (e: React.KeyboardEvent) => {
    const printable = e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey;
    if (!open) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) {
        e.preventDefault();
        openList();
      } else if (printable) {
        e.preventDefault();
        if (searchable) openList(e.key);
        else {
          openList();
          const n = typeAhead(e.key);
          if (n >= 0) requestAnimationFrame(() => setActive(n));
        }
      }
      return;
    }
    const move = (n: number) => {
      e.preventDefault();
      if (nav.length) setActive(Math.max(0, Math.min(nav.length - 1, n)));
    };
    switch (e.key) {
      case 'ArrowDown':
        return move(active + 1);
      case 'ArrowUp':
        if (!e.altKey) return move(active - 1);
        e.preventDefault();
        return commit(nav[active]);
      case 'PageDown':
        return move(active + 10);
      case 'PageUp':
        return move(active - 10);
      case 'Home':
        if (!searchable) move(0);
        return;
      case 'End':
        if (!searchable) move(nav.length - 1);
        return;
      case 'Enter':
        e.preventDefault();
        return commit(nav[active]);
      case 'Escape':
        e.preventDefault();
        e.stopPropagation();
        return close();
      case 'Tab':
        return close(false);
      case ' ':
        if (!searchable && Date.now() - typed.current.at > 600) {
          e.preventDefault();
          return commit(nav[active]);
        }
    }
    if (printable && !searchable) {
      e.preventDefault();
      const n = typeAhead(e.key);
      if (n >= 0) setActive(n);
    }
  };

  const renderRow = (r: Row, k: number): React.ReactNode => {
    if (r.kind === 'separator') return <div key={`s${k}`} role="separator" className="select-sep" />;
    if (r.kind === 'group') {
      const gid = `${uid}-g${k}`;
      return (
        <div key={gid} role="group" aria-labelledby={gid}>
          <div id={gid} role="presentation" className="select-group">
            {r.label}
          </div>
          {r.rows.map(renderRow)}
        </div>
      );
    }
    const isSel = r.kind === 'option' && r.opt.value === value;
    const dis = r.kind === 'option' && r.opt.disabled;
    const label = r.kind === 'option' ? r.opt.label : r.action.label;
    return (
      <div
        key={r.kind === 'option' ? `o:${r.opt.value}` : `a${k}`}
        id={r.nav >= 0 ? optionId(r.nav) : undefined}
        role="option"
        aria-selected={isSel}
        aria-disabled={dis || undefined}
        data-value={r.kind === 'option' ? r.opt.value : undefined}
        data-active={r.nav === active && r.nav >= 0 ? '' : undefined}
        className={r.kind === 'action' ? 'select-opt action' : 'select-opt'}
        lang={r.kind === 'option' ? r.opt.lang : undefined}
        data-tip={label}
        onPointerMove={() => r.nav >= 0 && r.nav !== active && setActive(r.nav)}
        onClick={() => !dis && commit(r)}
      >
        <span className="select-check" aria-hidden>
          {isSel && <Check size={14} />}
        </span>
        {r.kind === 'option' && r.opt.swatch !== undefined && <Swatch color={r.opt.swatch} />}
        <span className="select-label">{label}</span>
      </div>
    );
  };

  /** The rows in view of a long list, with empty space for the others (groups keep their titles' place). */
  const renderInView = ({ tops, optH, total }: NonNullable<typeof layout>): React.ReactNode[] => {
    const from = view.top - OVERSCAN,
      to = view.top + view.height + OVERSCAN;
    const out: React.ReactNode[] = [];
    let gap = 0;
    const space = (key: string) => {
      if (gap > 0) out.push(<div key={key} aria-hidden style={{ height: gap }} />);
      gap = 0;
    };
    rows.forEach((r, k) => {
      const top = tops[k]!,
        end = k + 1 < tops.length ? tops[k + 1]! : total;
      if (end < from || top > to) {
        gap += end - top;
        return;
      }
      space(`gap${k}`);
      if (r.kind !== 'group') {
        out.push(renderRow(r, k));
        return;
      }
      const gid = `${uid}-g${k}`;
      const first = Math.max(0, Math.floor((from - top - GROUP_H) / optH));
      const last = Math.min(r.rows.length, Math.ceil((to - top - GROUP_H) / optH));
      out.push(
        <div key={gid} role="group" aria-labelledby={gid}>
          <div id={gid} role="presentation" className="select-group">
            {r.label}
          </div>
          {first > 0 && <div aria-hidden style={{ height: first * optH }} />}
          {r.rows.slice(first, last).map((o, i) => renderRow(o, first + i))}
          {last < r.rows.length && <div aria-hidden style={{ height: (r.rows.length - last) * optH }} />}
        </div>,
      );
    });
    space('gap-end');
    return out;
  };

  return (
    <span className={`select${className ? ` ${className}` : ''}`}>
      <button
        ref={trigger}
        type="button"
        id={id}
        role="combobox"
        className="select-trigger"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        {...aria}
        data-value={value}
        aria-activedescendant={open && !searchable && active >= 0 ? optionId(active) : undefined}
        onClick={() => (open ? close() : openList())}
        onKeyDown={onKey}
        onBlur={(e) => {
          if (open && !searchable && !pop.current?.contains(e.relatedTarget as Node)) close(false);
        }}
      >
        {isColor(selected?.swatch) && <Swatch color={selected!.swatch!} />}
        <span className="select-value" lang={selected?.lang}>
          {display ?? selected?.label ?? ''}
        </span>
      </button>
      {open && (
        <div
          ref={pop}
          popover="manual"
          className="select-pop"
          onMouseDown={(e) => {
            if (e.target !== search.current) e.preventDefault();
          }}
        >
          {searchable && (
            <div className="select-search">
              <Search size={14} aria-hidden />
              <input
                ref={search}
                type="search"
                aria-label={t('Search')}
                placeholder={t('Search')}
                value={query}
                aria-controls={listId}
                aria-autocomplete="list"
                aria-activedescendant={active >= 0 ? optionId(active) : undefined}
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={onKey}
                onBlur={(e) => {
                  if (!pop.current?.contains(e.relatedTarget as Node) && e.relatedTarget !== trigger.current) close(false);
                }}
              />
            </div>
          )}
          <div
            ref={list}
            id={listId}
            role="listbox"
            className="select-list"
            aria-label={aria['aria-label']}
            aria-labelledby={aria['aria-labelledby']}
            data-virtual={layout ? '' : undefined}
            onScroll={layout ? (e) => setView({ top: e.currentTarget.scrollTop, height: e.currentTarget.clientHeight }) : undefined}
          >
            {layout ? renderInView(layout) : rows.map(renderRow)}
            {!nav.length && <div className="select-empty">{t('No matches.')}</div>}
          </div>
        </div>
      )}
    </span>
  );
}

const isColor = (c: string | undefined) => !!c && /^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(c);

/** A filament color; without one, an empty space that keeps the names in the list aligned. */
function Swatch({ color }: { color: string }) {
  return (
    <span className="select-swatch" aria-hidden style={isColor(color) ? { background: color.slice(0, 7) } : { visibility: 'hidden' }} />
  );
}
