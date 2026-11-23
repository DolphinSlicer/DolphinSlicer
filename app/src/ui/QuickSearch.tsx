// Quick search (Cmd+K / Ctrl+K): the app's actions, every setting, the presets and the library's
// models in one list. Picking a setting opens it in the Settings tab (SettingsPanel's settingsFocus).
// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BookmarkPlus,
  Box,
  Crosshair,
  Download,
  FileCode2,
  Info,
  Layers,
  Library,
  Play,
  Printer,
  Search,
  Send,
  Settings,
  SlidersHorizontal,
  Upload,
} from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import type { PresetType } from '../engine/protocol';
import { N_, t, tr } from '../i18n/i18n';
import { layout, loadSchema, MODES, type Schema, type SettingsMode, TYPE_LABEL, visibleInMode } from '../settings/schema';
import { downloadGcode, presetValues, slice } from '../state/actions';
import { addPlateToLibrary, openModel } from '../state/libraryActions';
import { set, useApp } from '../state/store';
import { MENU as CALIBRATIONS } from './Calibration';
import { usePresetPicker } from './PresetPanel';
import { useModal } from './useModal';

type Group = 'actions' | 'settings' | 'presets' | 'library';
const GROUP_LABEL: Record<Group, string> = {
  actions: N_('Actions'),
  settings: N_('Settings'),
  presets: N_('Presets'),
  library: N_('Library'),
};
/** The most shown of each group (all actions). */
const LIMIT: Record<Group, number> = { actions: Number.POSITIVE_INFINITY, settings: 8, presets: 6, library: 6 };

interface Item {
  id: string;
  group: Group;
  label: string;
  detail?: string;
  icon?: ReactNode;
  thumb?: string;
  disabled?: boolean;
  /** What the item is found by: its names, ids (a setting's key, a file name), descriptions; in that order of rank. */
  names: string[];
  ids?: string[];
  more?: string[];
  /** Among equal matches, the lower first (a setting's mode: Simple before Expert). */
  rank?: number;
  run: () => void;
}

export interface AppActions {
  send: () => void;
  printers: () => void;
  preferences: () => void;
  about: () => void;
}

const TYPES: PresetType[] = ['print', 'filament', 'printer'];

/** A hidden file input of the Objects card (it stays on the page in every view). */
const clickInput = (testid: string) => document.querySelector<HTMLInputElement>(`[data-testid="${testid}"]`)?.click();

const lower = (x: string) => x.toLocaleLowerCase();
const wordsOf = (x: string) => x.split(/[\s\-–/()_.,:;'"]+/).filter(Boolean);

/**
 * How well the item fits the search: 4 a name starting with it, 3 every word starting a word of a
 * name, 2 every word in a name or id, 1 in its description too; 0 none.
 */
function score(item: Item, query: string, words: string[]): number {
  const names = item.names.map(lower);
  if (names.some((n) => n.startsWith(query))) return 4;
  if (names.some((n) => words.every((w) => wordsOf(n).some((nw) => nw.startsWith(w))))) return 3;
  const ids = [...names, ...(item.ids ?? []).map(lower)];
  if (ids.some((n) => words.every((w) => n.includes(w)))) return 2;
  const all = [...ids, ...(item.more ?? []).map(lower)].join('\n');
  return words.every((w) => all.includes(w)) ? 1 : 0;
}

export function QuickSearch({ onClose, actions }: { onClose: () => void; actions: AppActions }) {
  const modal = useModal<HTMLDivElement>();
  const list = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [schema, setSchema] = useState<Schema | null>(null);
  /** The settings that don't apply to the selected presets (not on the settings pages now). */
  const [hidden, setHidden] = useState<Partial<Record<PresetType, Set<string>>>>({});
  const picker = usePresetPicker();
  const objects = useApp((s) => s.objects.length);
  const sliceState = useApp((s) => s.slice.state);
  const calibReady = useApp((s) => !!s.presets.state && !s.importing);
  const models = useApp((s) => s.models.entries);

  useEffect(() => {
    loadSchema().then(setSchema, () => undefined);
    for (const type of TYPES)
      presetValues(type).then(
        (v) => setHidden((h) => ({ ...h, [type]: new Set(Object.keys(v.states.hidden)) })),
        () => undefined,
      );
  }, []);

  const both = (s: string) => [s, tr(s)];
  const items = useMemo((): Item[] => {
    const done = sliceState === 'done';
    const action = (id: string, label: string, icon: ReactNode, run: () => void, disabled = false): Item => ({
      id: `a:${id}`,
      group: 'actions',
      label: t(label),
      icon,
      disabled,
      names: both(label),
      run,
    });
    const out: Item[] = [
      action('prepare', 'Prepare', <Box size={15} />, () => set({ view: 'prepare' })),
      action('preview', 'Preview', <Layers size={15} />, () => set({ view: 'preview' }), !done),
      action('library', 'Library', <Library size={15} />, () => set({ view: 'library' })),
      action('settings', 'Settings', <SlidersHorizontal size={15} />, () => set({ view: 'settings' })),
      action('slice', 'Slice plate', <Play size={15} />, () => void slice(), !objects || sliceState === 'running'),
      action('export', 'Export G-code', <Download size={15} />, downloadGcode, !done),
      action('send', 'Send to printer', <Send size={15} />, actions.send, !done),
      action('import', 'Import models', <Upload size={15} />, () => clickInput('file-input')),
      action('gcode', 'Open G-code', <FileCode2 size={15} />, () => clickInput('gcode-input')),
      action('add-to-library', 'Add to library', <BookmarkPlus size={15} />, () => void addPlateToLibrary(), !objects),
      action('printers-wizard', 'Add or remove printers…', <Printer size={15} />, () => set({ wizard: 'printers' })),
      action('filaments-wizard', 'Add or remove filaments…', <Printer size={15} />, () => set({ wizard: 'filaments' })),
      ...CALIBRATIONS.flatMap((m) =>
        m
          ? [
              {
                ...action(
                  `calib:${m.kind}`,
                  m.label,
                  <Crosshair size={15} />,
                  () => set({ view: 'prepare', calibrationDialog: m.kind }),
                  !calibReady,
                ),
                detail: t('Calibration'),
                names: [...both(m.label), ...both('Calibration').map((c) => `${c} ${t(m.label)}`)],
              },
            ]
          : [],
      ),
      action('printers', 'Printers', <Printer size={15} />, actions.printers),
      action('preferences', 'Preferences', <Settings size={15} />, actions.preferences),
      action('about', 'About', <Info size={15} />, actions.about),
    ];

    if (schema) {
      const seen = new Set<string>();
      for (const type of TYPES)
        for (const page of layout[type])
          for (const g of page.groups)
            for (const k of g.keys) {
              const d = schema.options[k];
              const id = `s:${type}:${k}`;
              if (!d || seen.has(id) || !visibleInMode(d, 'expert') || hidden[type]?.has(k)) continue;
              seen.add(id);
              // As on the settings pages: an option of a row of several is named with the row.
              const line = g.lines?.[k];
              const own = d.label || d.full_label || k;
              const label = line && own !== line ? `${tr(line)} – ${tr(own)}` : tr(line || own);
              out.push({
                id,
                group: 'settings',
                label,
                detail: [t(TYPE_LABEL[type]), tr(page.title), g.title ? tr(g.title) : ''].filter(Boolean).join(' › '),
                names: [label, own, line ? `${line} ${own}` : '', d.full_label].filter(Boolean),
                ids: [k],
                more: d.tooltip ? both(d.tooltip) : [],
                rank: MODES.indexOf(d.mode as SettingsMode),
                run: () => set({ view: 'settings', settingsType: type, settingsFocus: { type, key: k, n: Date.now() } }),
              });
            }
    }

    for (const type of TYPES)
      for (const [, entries] of picker.groups[type])
        for (const e of entries)
          out.push({
            id: `p:${type}:${e.name}`,
            group: 'presets',
            label: e.name,
            detail: t(TYPE_LABEL[type]),
            names: [e.name, e.alias].filter(Boolean),
            run: () => void picker.pick(type, e.name),
          });

    for (const m of models)
      out.push({
        id: `m:${m.id}`,
        group: 'library',
        label: m.name,
        detail: m.tags.join(', '),
        thumb: m.thumb || undefined,
        names: [m.name],
        ids: [m.file],
        more: m.tags,
        run: () => void openModel(m.id),
      });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schema, hidden, picker.groups, models, objects, sliceState, calibReady, actions]);

  /** What is shown: the actions without a search; else the best matches of each group. */
  const shown = useMemo(() => {
    const q = query.trim().toLocaleLowerCase();
    if (!q) return items.filter((i) => i.group === 'actions');
    const words = q.split(/\s+/);
    // Among the names that start with the words, the settings of the simpler modes first (the common ones).
    const good = (x: number) => (x >= 3 ? 1 : 0);
    const groups = (Object.keys(GROUP_LABEL) as Group[]).map((group) =>
      items
        .filter((i) => i.group === group)
        .map((i) => ({ i, s: score(i, q, words) }))
        .filter((x) => x.s > 0)
        .sort((a, b) => good(b.s) - good(a.s) || (a.i.rank ?? 0) - (b.i.rank ?? 0) || b.s - a.s || a.i.label.length - b.i.label.length)
        .slice(0, LIMIT[group]),
    );
    // The group with the best match first (the list's order otherwise).
    return groups
      .filter((g) => g.length)
      .sort((a, b) => b[0]!.s - a[0]!.s)
      .flatMap((g) => g.map((x) => x.i));
  }, [items, query]);

  const usable = shown.filter((i) => !i.disabled);
  const current = usable[Math.min(active, usable.length - 1)];
  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    if (current) list.current?.querySelector(`[data-id="${CSS.escape(current.id)}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [current]);

  const choose = (item: Item) => {
    onClose();
    item.run();
  };

  let lastGroup: Group | null = null;
  return (
    <div
      className="modal-backdrop quick-search-backdrop"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="quick-search" role="dialog" aria-modal="true" aria-label={t('Quick search')} ref={modal} data-testid="quick-search">
        <label className="quick-search-input">
          <Search size={16} />
          <input
            type="text"
            autoFocus
            value={query}
            placeholder={t('Search')}
            role="combobox"
            aria-expanded="true"
            aria-controls="quick-search-list"
            aria-activedescendant={current ? `qs-${current.id}` : undefined}
            aria-label={t('Quick search')}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                const n = usable.length;
                if (n) setActive((Math.min(active, n - 1) + (e.key === 'ArrowDown' ? 1 : -1) + n) % n);
              } else if (e.key === 'Enter') {
                e.preventDefault();
                if (current) choose(current);
              } else if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                onClose();
              }
            }}
          />
        </label>
        <div className="quick-search-list" id="quick-search-list" role="listbox" ref={list} aria-label={t('Quick search')}>
          {shown.map((item) => {
            const head = item.group !== lastGroup ? GROUP_LABEL[item.group] : null;
            lastGroup = item.group;
            return (
              <div key={item.id} role="presentation">
                {head && (
                  <div className="quick-search-group" role="presentation">
                    {t(head)}
                  </div>
                )}
                <div
                  id={`qs-${item.id}`}
                  data-id={item.id}
                  role="option"
                  aria-selected={item === current}
                  aria-disabled={item.disabled || undefined}
                  className="quick-search-item"
                  onPointerMove={() => {
                    const i = usable.indexOf(item);
                    if (i >= 0 && i !== active) setActive(i);
                  }}
                  onClick={() => {
                    if (!item.disabled) choose(item);
                  }}
                >
                  {item.thumb ? <img className="thumb" src={item.thumb} alt="" /> : <span className="icon">{item.icon}</span>}
                  <span className="label">{item.label}</span>
                  {item.detail && <span className="detail">{item.detail}</span>}
                </div>
              </div>
            );
          })}
          {!shown.length && <p className="muted quick-search-empty">{t('No results')}</p>}
        </div>
      </div>
    </div>
  );
}
