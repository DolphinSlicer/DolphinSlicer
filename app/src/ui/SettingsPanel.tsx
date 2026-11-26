// Settings editor for the selected printer / filament / process preset, generated from
// OrcaSlicer's option definitions (schema) and the desktop tab layout. No hand-written forms.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { ArrowLeft, Ban, Download, GitCompareArrows, Pencil, RotateCcw, Save, Search, Trash2, Undo2, Upload, X } from 'lucide-react';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { PresetEntry, PresetType, PresetValues } from '../engine/protocol';
import { N_, t, tr } from '../i18n/i18n';
import { type PresetCatalog, presetCatalog, profilesManifest } from '../presets/profiles';
import { commitValue, differs, fieldText, formatSetting } from '../settings/compare';
import { docPath } from '../settings/docs';
import {
  editKind,
  layout,
  loadSchema,
  MODES,
  type OptionDef,
  type Schema,
  type SettingsMode,
  TYPE_LABEL,
  visibleInMode,
} from '../settings/schema';
import {
  allPresetsOf,
  deletePreset,
  editSetting,
  editSettings,
  exportPreset,
  importPresets,
  MAX_MODEL_NAME,
  nameProblem,
  presetValues,
  presetValuesOf,
  readNow,
  renamePreset,
  renamePrinter,
  resetSettings,
  savePreset,
  userPresetExists,
} from '../state/actions';
import { currencySymbol } from '../state/prefs';
import { updatePrefs } from '../state/prefsActions';
import { notify, useApp } from '../state/store';
import { BED_KEYS, type BedKey, BedSettingControl } from './BedEditor';
import { CodeArea } from './CodeArea';
import { ColorPicker } from './ColorPicker';
import { ComboInput, type ComboOption } from './ComboInput';
import { CompatiblePrintersControl } from './CompatiblePrinters';
import { ask } from './Confirm';
import { DocsPanel } from './DocsPanel';
import { describeError } from './errors';
import { type Group, groupBy, PresetSelect, usePresetPicker } from './PresetPanel';
import { SegmentThumb } from './SegmentThumb';
import type { SelectItem } from './Select';
import { Select } from './Select';
import { discardEditsOk, replacePresetsOk } from './unsaved';

const MODE_LABEL: Record<SettingsMode, [string, string]> = {
  simple: [N_('Simple'), N_('Simple settings')],
  advanced: [N_('Advanced'), N_('Advanced settings')],
  expert: [N_('Expert'), N_('Expert settings')],
};

/** The page each preset type was left on: kept while the app is open, also across the other views. */
let lastPages: Record<PresetType, number> = { print: 0, filament: 0, printer: 0 };

/** The preset files Import takes: desktop's JSON presets and bundles, PrusaSlicer's .ini. */
export const PRESET_FILES = '.json,.orca_printer,.orca_filament,.orca_bundle,.ini';

/** Import presets from files (Settings' Import button, the quick search), saying what came in. */
export async function importPresetFiles(files: ReturnType<typeof readNow>) {
  const { imported, canceled } = await importPresets(files, discardEditsOk, replacePresetsOk);
  if (canceled) return;
  notify({
    kind: 'info',
    title: imported.length ? t('Imported') : t('Nothing imported'),
    message: imported.map((i) => i.name).join(', ') || t('The file contained no presets.'),
  });
}

export function SettingsPanel({ type: chosen, onType }: { type: PresetType; onType: (t: PresetType) => void }) {
  const setType = onType;
  const [schema, setSchema] = useState<Schema | null>(null);
  const [values, setValues] = useState<PresetValues | null>(null);
  // The type shown is the one of the values: another type's page replaces this one when its values are there (no empty page between).
  const type = values?.type ?? chosen;
  const wanted = useRef(chosen);
  wanted.current = chosen;
  // Each preset type keeps its page, as desktop's tabs do.
  const [pageOf, setPageOf] = useState(lastPages);
  const page = pageOf[type];
  const setPage = (i: number) => setPageOf((p) => (lastPages = { ...p, [type]: i }));
  const [query, setQuery] = useState('');
  const mode = useApp((s) => s.prefs.settingsMode);
  const setMode = (m: SettingsMode) => void updatePrefs({ settingsMode: m });
  const [naming, setNaming] = useState<string | null>(null);
  /** Renaming a custom printer: its brand and model. */
  const [renaming, setRenaming] = useState<{ brand: string; model: string } | null>(null);
  /** Renaming one of the user's print settings or filaments: the new name. */
  const [renamingTo, setRenamingTo] = useState<string | null>(null);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  /** Comparing side by side (for each type, while switching between them), and with which preset of each type. */
  const [compareOn, setCompareOn] = useState(false);
  const [compareWith, setCompareWith] = useState<Partial<Record<PresetType, string>>>({});
  /** Only the settings that differ from the compared preset. */
  const [onlyDiff, setOnlyDiff] = useState(false);
  /** Every preset of the type to compare with, not only those of the dropdowns (desktop's "Show all presets"). */
  const [showAll, setShowAll] = useState(false);
  const [allPresets, setAllPresets] = useState<{ type: PresetType; list: PresetEntry[] } | null>(null);
  /** Every vendor's presets, also of vendors not loaded (those are loaded aside to compare with). */
  const [catalog, setCatalog] = useState<{ presets: PresetCatalog; library: string } | null>(null);
  const [other, setOther] = useState<{ type: PresetType; name: string; values: Record<string, string | string[]> } | null>(null);
  /** The nozzle shown of a printer with several: on its Extruder page, and where a setting has a value for each. */
  const [extruder, setExtruder] = useState(0);
  const importInput = useRef<HTMLInputElement>(null);

  const picker = usePresetPicker();
  // What applies (greyed, hidden) follows the shown nozzle's values, as on desktop.
  const shownNozzle = useRef(extruder);
  shownNozzle.current = extruder;
  const reload = useCallback(
    async (ty = chosen) => {
      const v = await presetValues(ty, ty === 'printer' ? 0 : shownNozzle.current);
      // Another type chosen meanwhile: its values come next.
      if (ty === wanted.current) setValues(v);
    },
    [chosen],
  );
  useEffect(() => {
    loadSchema().then(setSchema, (e) => notify({ kind: 'error', ...describeError(e) }));
  }, []);
  useEffect(() => {
    setErrors({});
    setRenamingTo(null);
    setRenameError(null);
    setRenaming(null);
    setNaming(null);
    void reload(chosen);
  }, [chosen, reload]);
  // Another preset picked (here or in Prepare), saved or deleted: show its values.
  const selection = picker.p.state;
  const first = useRef(true);
  // Another nozzle shown: what applies to its values.
  useEffect(() => {
    if (chosen !== 'printer' && !first.current) void reload();
  }, [extruder]); // eslint-disable-line react-hooks/exhaustive-deps
  // A change made here reloads the values itself: not once more for the selection it leaves.
  const own = useRef<{ busy: boolean; state: unknown }>({ busy: false, state: null });
  const acting = async (f: () => Promise<unknown>) => {
    own.current.busy = true;
    try {
      await f();
    } finally {
      own.current = { busy: false, state: useApp.getState().presets.state };
    }
  };
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (!own.current.busy && selection !== own.current.state) void reload();
  }, [selection]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = async (f: () => Promise<unknown>) => {
    try {
      await acting(f);
    } catch (e) {
      notify({ kind: 'error', ...describeError(e) });
    }
    await reload();
  };

  const pages = layout[type];
  // The documentation shown beside the settings; `n` starts a new panel (history) per setting.
  const [docs, setDocs] = useState<{ path: string; label: string; text: string; n: number } | null>(null);
  /** The pages with settings to show (in this mode, matching the search). */
  const listed = useMemo(() => {
    if (!schema) return [];
    const q = query.trim().toLowerCase();
    const hidden = values?.states.hidden ?? {};
    const match = (k: string, line = '') => {
      const d = schema.options[k];
      // A search finds the settings of every mode.
      if (!d || k in hidden || !visibleInMode(d, q ? 'expert' : mode)) return false;
      // English and the shown language both match.
      return (
        !q ||
        k.includes(q) ||
        [d.label, d.full_label, d.tooltip, line].some((x) => x.toLowerCase().includes(q) || tr(x).toLowerCase().includes(q))
      );
    };
    return pages
      .map((p, i) => ({
        ...p,
        i,
        groups: p.groups
          .map((g) => {
            // Desktop hides a row as a whole: with one of its options hidden, the others go too.
            const off = (line: string) => g.keys.some((o) => g.lines![o] === line && o in hidden);
            const keys = g.keys.filter((k) => {
              const line = g.lines?.[k];
              return !(line && off(line)) && match(k, line);
            });
            // One row left of several (one bed type's temperatures): its name says nothing.
            const rows = new Set(Object.values(g.lines ?? {}));
            const lines = rows.size > 1 && [...rows].filter((l) => !off(l)).length === 1 ? undefined : g.lines;
            return { ...g, keys, lines };
          })
          .filter((g) => g.keys.length),
      }))
      .filter((p) => p.groups.length);
  }, [schema, pages, query, mode, values]);

  // A setting picked in the quick search: its page, in a mode that shows it, then it scrolled to and lit.
  const focus = useApp((s) => s.settingsFocus);
  const [flash, setFlash] = useState<string | null>(null);
  useEffect(() => {
    if (!focus || !schema || values?.type !== focus.type) return;
    const def = schema.options[focus.key];
    const i = layout[focus.type].findIndex((p) => p.groups.some((g) => g.keys.includes(focus.key)));
    useApp.setState({ settingsFocus: null });
    if (!def || i < 0) return;
    setQuery('');
    setOnlyDiff(false);
    if (!visibleInMode(def, mode)) setMode(def.mode as SettingsMode);
    setPageOf((p) => (lastPages = { ...p, [focus.type]: i }));
    if (!(focus.key in values.states.hidden)) setFlash(focus.key);
  }, [focus, schema, values?.type]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!flash) return;
    const el = document.querySelector<HTMLElement>(`.settings-content .field[data-key="${flash}"]`);
    if (!el) return;
    el.scrollIntoView({ block: 'center' });
    el.querySelector<HTMLElement>('.control input, .control button, .control textarea')?.focus({ preventScroll: true });
    el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 1600);
    setFlash(null);
  });

  const commit = async (key: string, value: Parameters<typeof editSetting>[2]) => {
    try {
      const problem = schema?.options[key] ? numberProblem(key, schema.options[key]!, value) : null;
      if (problem) throw new Error(problem);
      await acting(() => editSetting(type, key, value));
      setErrors(({ [key]: _, ...rest }) => rest);
    } catch (e) {
      setErrors((x) => ({ ...x, [key]: describeError(e).message }));
    }
    await reload();
  };

  // As desktop: presets others are based on stay; a custom printer takes its own presets along.
  const remove = async (v: PresetValues) => {
    if (v.children.length) {
      notify({
        kind: 'warning',
        title: t('Presets inherited by other presets cannot be deleted!'),
        message: t('Based on it: {names}', { names: v.children.join(', ') }),
      });
      return;
    }
    const attached = v.attached.filament + v.attached.print > 0;
    if (
      await ask(
        attached
          ? t('Delete {name} and the print settings and filaments made for it?', { name: v.name })
          : t('Delete {name}?', { name: v.name }),
        { confirm: t('Delete'), danger: true },
      )
    ) {
      void run(() => deletePreset(type, v.name));
    }
  };

  // One value of a list (a nozzle's, a filament's) is reported as "key#index".
  const whole = (keys: string[] = []) => new Set(keys.map((k) => k.replace(/#\d+$/, '')));
  const dirty = whole(values?.dirty);
  const fromSystem = whole(values?.from_system);
  /** Saves under the typed name; what is wrong with it shows by the field. */
  const saveAs = async () => {
    const n = (naming ?? '').trim().replace(/\s+/g, ' ');
    if (!n || !values) return;
    try {
      // The preset's own name is fine as it is (it has a file already).
      const problem = n === values.name ? null : nameProblem(n);
      if (problem) throw new Error(problem);
      if (
        n !== values.name &&
        (await userPresetExists(type, n)) &&
        !(await ask(t('These presets exist already: {names}. Replace them?', { names: n }), { confirm: t('Replace') }))
      )
        return;
      await savePreset(type, n);
      setNaming(null);
      setRenameError(null);
    } catch (e) {
      setRenameError(describeError(e).message);
    }
    await reload();
  };
  const escCloses = (close: () => void) => (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  };
  const variantKeys = new Set(values?.variant_keys ?? []);
  // A printer with several nozzles: its Extruder page shows one of them (desktop has a page for each).
  // Print settings and filaments with other values for each nozzle show one nozzle's (desktop's switch).
  const extruders = values?.extruders ?? [];
  const nozzle = (type === 'printer' ? extruders.length > 1 : new Set(extruders).size > 1) ? Math.min(extruder, extruders.length - 1) : -1;
  type Shown = { title: string; groups: { keys: string[] }[] };
  const perNozzle = (p: Shown) =>
    nozzle >= 0 && (type === 'printer' ? p.title === 'Extruder' : p.groups.some((g) => g.keys.some((k) => variantKeys.has(k))));
  /** A setting's value to show: the chosen nozzle's where there is a choice, else the first (or the variant's). */
  const indexOf = (k: string, p: Shown) =>
    !perNozzle(p)
      ? variantKeys.has(k)
        ? values!.variant_index
        : 0
      : variantKeys.has(k)
        ? extruders[nozzle]!
        : type === 'printer'
          ? nozzle
          : 0;
  // Compared with another preset: its values beside these.
  const comparing = compareOn ? compareWith[type] : undefined;
  const loadedVendors = picker.p.loadedVendors;
  /** Presets of vendors not loaded: name → vendor. */
  const unloaded = useMemo(() => {
    const out = new Map<string, string>();
    if (!catalog) return out;
    const loaded = new Set([...loadedVendors, catalog.library]);
    const inLoaded = new Set([...loaded].flatMap((v) => catalog.presets[v]?.[type] ?? []));
    for (const [v, lists] of Object.entries(catalog.presets))
      if (!loaded.has(v)) for (const n of lists[type]) if (!inLoaded.has(n) && !out.has(n)) out.set(n, v);
    return out;
  }, [catalog, loadedVendors, type]);
  const comparingVendor = comparing ? unloaded.get(comparing) : undefined;
  useEffect(() => {
    if (!comparing) {
      setOther(null);
      return;
    }
    let live = true;
    presetValuesOf(type, comparing, comparingVendor).then(
      (r) => {
        if (live) setOther({ type, name: comparing, values: r.values });
      },
      (e) => {
        if (!live) return;
        notify({ kind: 'error', ...describeError(e) });
        setCompareWith((c) => ({ ...c, [type]: undefined }));
        setCompareOn(false);
      },
    );
    return () => {
      live = false;
    };
  }, [type, comparing, comparingVendor, values]);
  const otherValues = comparing && other?.type === type && other.name === comparing ? other.values : null;
  const kindOf = (k: string) => editKind(k, schema!.options[k]!);
  const differsAt = (k: string, p: Shown) =>
    !!(otherValues && values && schema) && differs(kindOf(k), values.values[k], otherValues[k], indexOf(k, p));
  const filtering = onlyDiff && !!otherValues;
  const narrowed = filtering
    ? listed
        .map((p) => ({
          ...p,
          groups: p.groups.map((g) => ({ ...g, keys: g.keys.filter((k) => differsAt(k, p)) })).filter((g) => g.keys.length),
        }))
        .filter((p) => p.groups.length)
    : listed;
  // A search (or only the differences) shows every page with a match; else one page, the first when the chosen one has nothing in this mode.
  const shown =
    query.trim() || filtering
      ? narrowed
      : listed
          .filter((p) => p.i === page)
          .concat(listed.slice(0, 1))
          .slice(0, 1);
  /** The compared preset's values of every setting that differs (on any page, in this mode and search). */
  const differences = () => {
    const out = new Map<string, Commit>();
    if (!otherValues || !values) return out;
    for (const p of listed)
      for (const g of p.groups)
        for (const k of g.keys) {
          if (out.has(k) || !differsAt(k, p) || schema!.options[k]!.readonly) continue;
          const text = fieldText(kindOf(k), otherValues[k], indexOf(k, p))!;
          out.set(k, commitValue(kindOf(k), text, indexOf(k, p), values.values[k]));
        }
    return out;
  };
  useEffect(() => {
    if (!showAll || !comparing) return;
    let live = true;
    const failed = (e: unknown) => {
      if (live) notify({ kind: 'error', ...describeError(e) });
    };
    allPresetsOf(type).then((list) => {
      if (live) setAllPresets({ type, list });
    }, failed);
    if (!catalog)
      Promise.all([presetCatalog(), profilesManifest()]).then(([presets, m]) => {
        if (live) setCatalog({ presets, library: m.library });
      }, failed);
    return () => {
      live = false;
    };
  }, [showAll, !!comparing, type, picker.p.state]);
  // Every preset: those that fit as in the dropdowns, then the others by printer vendor (those
  // of vendors not loaded too).
  const compareGroups = useMemo((): Group[] => {
    if (!showAll || allPresets?.type !== type || !catalog) return picker.groups[type];
    const mine = t('My presets');
    const brand = (e: PresetEntry) => picker.vendorNames[e.vendor] ?? e.vendor;
    const fits = (e: PresetEntry) => e.user || type === 'printer' || e.compatible !== false;
    const others = [
      ...allPresets.list.filter((e) => !fits(e)),
      ...[...unloaded].map(([name, vendor]): PresetEntry => ({ name, alias: '', system: true, user: false, inherits: '', vendor })),
    ];
    const top = allPresets.list.filter(fits);
    const first: Group[] =
      type === 'print'
        ? [[null, top]]
        : groupBy(
            type === 'printer' ? [...top, ...others] : top,
            (e) => (e.user ? mine : type === 'filament' ? e.filament_vendor || t('Other') : brand(e)),
            [mine],
          );
    return type === 'printer' ? first : [...first, ...groupBy(others, brand)];
  }, [showAll, allPresets, catalog, unloaded, type, picker.groups, picker.vendorNames]);
  const compareItems = useMemo((): SelectItem[] => {
    const items = compareGroups.flatMap(([g, list]): SelectItem[] => {
      const opts = list.map((e) => ({
        value: e.name,
        label: e.name,
        swatch: type === 'filament' ? (e.default_filament_colour ?? '') : undefined,
      }));
      return g === null ? opts : [{ group: g, options: opts }];
    });
    const listed = new Set(compareGroups.flatMap(([, l]) => l.map((e) => e.name)));
    return comparing && !listed.has(comparing) ? [{ value: comparing, label: comparing }, ...items] : items;
  }, [compareGroups, type, comparing]);
  // A type compared for the first time: at first with the system preset one of the user's is
  // based on, else with another one of the list.
  useEffect(() => {
    if (!compareOn || !values || compareWith[values.type]) return;
    const others = picker.groups[values.type].flatMap(([, l]) => l.map((e) => e.name)).filter((n) => n !== values.name);
    setCompareWith((c) => ({ ...c, [values.type]: (values.user && values.inherits) || others[0] || values.name }));
  }, [compareOn, values, compareWith, picker.groups]);
  const marked = (all: Set<string>, list: string[] | undefined, k: string, p: Shown) =>
    perNozzle(p) && list?.some((x) => x.startsWith(`${k}#`)) ? list.includes(`${k}#${indexOf(k, p)}`) : all.has(k);
  // Desktop's names: the two nozzles of a Bambu Lab printer by their side, else the tool's number.
  const nozzleName = (i: number) =>
    type === 'printer'
      ? `${tr('Extruder')} ${i + 1}`
      : values?.sides && extruders.length === 2
        ? tr(i ? 'Right Nozzle' : 'Left Nozzle')
        : `T${i + 1}`;

  return (
    <div className={`settings${otherValues ? ' comparing' : ''}`} role="dialog" aria-label={t('Settings')} data-testid="settings">
      <div className="settings-head">
        <nav className="segmented" role="tablist" aria-label={t('Preset type')}>
          <SegmentThumb />
          {(['print', 'filament', 'printer'] as PresetType[]).map((ty) => (
            <button key={ty} role="tab" aria-selected={ty === chosen} onClick={() => setType(ty)}>
              {t(TYPE_LABEL[ty])}
            </button>
          ))}
        </nav>
        <div className="preset-name">
          <PresetSelect
            type={type}
            picker={picker}
            modified={!!values?.dirty.length}
            aria-label={t(TYPE_LABEL[type])}
            data-testid="settings-preset"
          />
        </div>
        <div className="settings-actions">
          {renaming ? (
            <form
              className="name-form"
              data-testid="rename-form"
              onKeyDown={escCloses(() => {
                setRenaming(null);
                setRenameError(null);
              })}
              onSubmit={(e) => {
                e.preventDefault();
                const model = `${renaming.brand} ${renaming.model}`.trim();
                if (!values || !model) return;
                // Renaming rebuilds the presets, which drops unsaved edits of the other types. What is
                // wrong with the name shows by the field.
                void discardEditsOk().then((ok) =>
                  ok
                    ? renamePrinter(values.name, model).then(
                        () => {
                          setRenaming(null);
                          setRenameError(null);
                          return reload();
                        },
                        (err) => setRenameError(describeError(err).message),
                      )
                    : undefined,
                );
              }}
            >
              <input
                type="text"
                autoFocus
                value={renaming.brand}
                maxLength={MAX_MODEL_NAME}
                onChange={(e) => {
                  setRenaming({ ...renaming, brand: e.target.value });
                  setRenameError(null);
                }}
                placeholder={t('Input Custom Vendor')}
                aria-label={t('Input Custom Vendor')}
                data-testid="rename-vendor"
              />
              <span className="name-field">
                <input
                  type="text"
                  value={renaming.model}
                  maxLength={MAX_MODEL_NAME}
                  onChange={(e) => {
                    setRenaming({ ...renaming, model: e.target.value });
                    setRenameError(null);
                  }}
                  placeholder={t('Input Custom Model')}
                  aria-label={t('Input Custom Model')}
                  data-testid="rename-model"
                  aria-invalid={!!renameError}
                  aria-describedby={renameError ? 'rename-error' : undefined}
                />
                {renameError && (
                  <span className="field-bubble" id="rename-error" role="alert" data-testid="rename-error">
                    {renameError}
                  </span>
                )}
              </span>
              <button type="submit" className="btn primary">
                {t('Rename')}
              </button>
              <button
                type="button"
                className="btn ghost"
                onClick={() => {
                  setRenaming(null);
                  setRenameError(null);
                }}
              >
                {t('Cancel')}
              </button>
            </form>
          ) : renamingTo !== null ? (
            <form
              className="name-form"
              data-testid="rename-preset-form"
              onKeyDown={escCloses(() => {
                setRenamingTo(null);
                setRenameError(null);
              })}
              onSubmit={(e) => {
                e.preventDefault();
                const n = renamingTo.trim();
                if (!values || !n || type === 'printer') return;
                // Renaming rebuilds the presets, which drops unsaved edits of the other types. Why not
                // (a name taken, a character a file name can't have) shows by the field.
                void discardEditsOk().then((ok) =>
                  ok
                    ? renamePreset(type, values.name, n).then(
                        () => {
                          setRenamingTo(null);
                          setRenameError(null);
                          return reload();
                        },
                        (err) => setRenameError(tr(String((err as Error)?.message ?? err))),
                      )
                    : undefined,
                );
              }}
            >
              <span className="name-field">
                <input
                  type="text"
                  autoFocus
                  value={renamingTo}
                  onChange={(e) => {
                    setRenamingTo(e.target.value);
                    setRenameError(null);
                  }}
                  aria-label={t('Preset name')}
                  data-testid="rename-name"
                  aria-invalid={!!renameError}
                  aria-describedby={renameError ? 'rename-error' : undefined}
                />
                {renameError && (
                  <span className="field-bubble" id="rename-error" role="alert" data-testid="rename-error">
                    {renameError}
                  </span>
                )}
              </span>
              <button type="submit" className="btn primary">
                {t('Rename')}
              </button>
              <button
                type="button"
                className="btn ghost"
                onClick={() => {
                  setRenamingTo(null);
                  setRenameError(null);
                }}
              >
                {t('Cancel')}
              </button>
            </form>
          ) : naming === null ? (
            <>
              <button
                className="btn primary"
                onClick={() =>
                  values && (values.user ? run(() => savePreset(type, values.name)) : setNaming(t('{name} - Copy', { name: values.name })))
                }
                disabled={!values || (values.user && !values.dirty.length)}
                data-testid="settings-save"
              >
                <Save size={15} />
                {t('Save')}
              </button>
              <button
                className="btn"
                onClick={() => values && setNaming(values.user ? values.name : t('{name} - Copy', { name: values.name }))}
                disabled={!values}
              >
                {t('Save as…')}
              </button>
              <button
                className="btn ghost"
                onClick={() => run(() => resetSettings(type, undefined, 'saved'))}
                disabled={!values?.dirty.length}
              >
                <Undo2 size={15} />
                {t('Discard changes')}
              </button>
              {type === 'printer' && values?.user && values.base && (
                // A custom printer: brand and model make its name (desktop's Create Printer).
                <button
                  className="btn"
                  data-testid="settings-rename"
                  disabled={!!values.dirty.length}
                  data-tip={values.dirty.length ? t('Save first') : undefined}
                  onClick={() => {
                    const m = String(values.values.printer_model ?? '');
                    const i = m.indexOf(' ');
                    setRenaming(i < 0 ? { brand: m, model: '' } : { brand: m.slice(0, i), model: m.slice(i + 1) });
                  }}
                >
                  <Pencil size={15} />
                  {t('Rename…')}
                </button>
              )}
              {type !== 'printer' && values?.user && (
                // The user's own print settings and filaments (desktop only has Save as).
                <button
                  className="btn"
                  data-testid="settings-rename"
                  disabled={!!values.dirty.length}
                  data-tip={values.dirty.length ? t('Save first') : undefined}
                  onClick={() => setRenamingTo(values.name)}
                >
                  <Pencil size={15} />
                  {t('Rename…')}
                </button>
              )}
              <span className="sep" />
              <button
                className={`icon-btn${compareOn ? ' on' : ''}`}
                aria-label={tr('Compare presets')}
                aria-pressed={compareOn}
                data-tip={tr('Compare presets')}
                onClick={() => setCompareOn((on) => !on)}
                disabled={!values}
                data-testid="settings-compare"
              >
                <GitCompareArrows size={16} />
              </button>
              <button
                className="icon-btn"
                aria-label={t('Import…')}
                data-tip={t('Import presets')}
                onClick={() => importInput.current?.click()}
              >
                <Upload size={16} />
              </button>
              <button
                className="icon-btn"
                aria-label={t('Export')}
                data-tip={values?.dirty.length ? t('Save first') : t('Export preset')}
                onClick={() => run(() => exportPreset(type))}
                disabled={!values?.user || !!values?.dirty.length}
              >
                <Download size={16} />
              </button>
              <button
                className="icon-btn danger"
                aria-label={t('Delete')}
                data-tip={t('Delete preset')}
                onClick={() => values && void remove(values)}
                disabled={!values?.user}
              >
                <Trash2 size={16} />
              </button>
            </>
          ) : (
            <form
              className="name-form"
              data-testid="save-as-form"
              onKeyDown={escCloses(() => {
                setNaming(null);
                setRenameError(null);
              })}
              onSubmit={(e) => {
                e.preventDefault();
                void saveAs();
              }}
            >
              <span className="name-field">
                <input
                  type="text"
                  autoFocus
                  value={naming}
                  onChange={(e) => {
                    setNaming(e.target.value);
                    setRenameError(null);
                  }}
                  aria-label={t('Preset name')}
                  data-testid="settings-name"
                  aria-invalid={!!renameError}
                  aria-describedby={renameError ? 'save-as-error' : undefined}
                />
                {renameError && (
                  <span className="field-bubble" id="save-as-error" role="alert" data-testid="save-as-error">
                    {renameError}
                  </span>
                )}
              </span>
              <button type="submit" className="btn primary">
                {t('Save')}
              </button>
              <button
                type="button"
                className="btn ghost"
                onClick={() => {
                  setNaming(null);
                  setRenameError(null);
                }}
              >
                {t('Cancel')}
              </button>
            </form>
          )}
          <input
            ref={importInput}
            type="file"
            hidden
            multiple
            accept={PRESET_FILES}
            data-testid="settings-import"
            onChange={(e) => {
              const files = readNow([...(e.target.files ?? [])]);
              e.target.value = '';
              void run(() => importPresetFiles(files));
            }}
          />
        </div>
      </div>
      <div className="settings-tools">
        {values?.user && values.inherits && (
          <span className="based-on muted" data-testid="settings-based-on">
            {t('Based on {name}', { name: values.inherits })}
          </span>
        )}
        <label className="search">
          <Search size={15} />
          <input
            type="search"
            placeholder={t('Search settings')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label={t('Search settings')}
            data-testid="settings-search"
          />
        </label>
        <div className="segmented" role="radiogroup" aria-label={t('Settings mode')} data-testid="settings-mode">
          <SegmentThumb />
          {MODES.map((m) => (
            <button
              type="button"
              key={m}
              role="radio"
              aria-checked={mode === m}
              aria-selected={mode === m}
              data-tip={t(MODE_LABEL[m][1])}
              onClick={() => setMode(m)}
              data-testid={`settings-mode-${m}`}
            >
              {t(MODE_LABEL[m][0])}
            </button>
          ))}
        </div>
        {comparing && (
          <div className="compare-bar" data-testid="settings-compare-bar">
            <span className="caption" id="compare-with-label">
              {t('Compare with')}
            </span>
            <Select
              value={comparing}
              items={compareItems}
              onChange={(v) => setCompareWith((c) => ({ ...c, [type]: v }))}
              aria-labelledby="compare-with-label"
              data-testid="settings-compare-with"
            />
            <label className="switch-label">
              <input
                type="checkbox"
                className="switch"
                checked={showAll}
                onChange={(e) => setShowAll(e.target.checked)}
                data-testid="settings-compare-all"
              />
              {t('Show all presets')}
            </label>
            <label className="switch-label">
              <input
                type="checkbox"
                className="switch"
                checked={onlyDiff}
                onChange={(e) => setOnlyDiff(e.target.checked)}
                data-testid="settings-only-diff"
              />
              {t('Only differences')}
            </label>
            <button
              className="btn"
              disabled={!otherValues || !differences().size}
              data-testid="settings-copy-all"
              onClick={() => {
                const d = differences();
                if (d.size) void run(() => editSettings(type, Object.fromEntries(d)));
              }}
            >
              <ArrowLeft size={15} />
              {t('Copy all')}
            </button>
            <button className="icon-btn" aria-label={t('Close')} data-tip={t('Close')} onClick={() => setCompareOn(false)}>
              <X size={16} />
            </button>
          </div>
        )}
      </div>
      <div className="settings-body">
        {!query && !filtering && (
          <ul className="settings-pages">
            {(listed.length ? listed : pages.map((p, i) => ({ ...p, i }))).map((p) => (
              <li key={p.title}>
                <button aria-current={p.i === (shown[0]?.i ?? page)} onClick={() => setPage(p.i)}>
                  {tr(p.title)}
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="settings-content">
          {!schema || !values ? (
            <span className="spinner large" />
          ) : (
            shown.map((p) => (
              <section key={p.title}>
                {(query || filtering) && <h3 className="page-title">{tr(p.title)}</h3>}
                {perNozzle(p) && (
                  <div className="segmented extruder-switch" role="radiogroup" aria-label={tr('Extruder')} data-testid="settings-extruder">
                    <SegmentThumb />
                    {extruders.map((_, i) => (
                      <button
                        type="button"
                        key={i}
                        role="radio"
                        aria-checked={i === nozzle}
                        aria-selected={i === nozzle}
                        onClick={() => setExtruder(i)}
                      >
                        {nozzleName(i)}
                      </button>
                    ))}
                  </div>
                )}
                {p.groups.map((g) => (
                  <fieldset key={g.title} className="settings-group">
                    {g.title && <legend>{tr(g.title)}</legend>}
                    {g.keys.map((k) => (
                      <Field
                        key={k}
                        k={k}
                        def={schema.options[k]!}
                        value={values.values[k]}
                        index={indexOf(k, p)}
                        off={values.states.disabled[k] ?? conditionOff(k, values.values)}
                        labelOverride={values.states.labels[k]}
                        line={g.lines?.[k]}
                        choices={values.states.enums[k]}
                        all={values.values}
                        other={otherValues ? (otherValues[k] ?? null) : undefined}
                        canNil={type === 'filament' && OVERRIDES.has(k)}
                        dirty={marked(dirty, values.dirty, k, p)}
                        fromSystem={marked(fromSystem, values.from_system, k, p)}
                        error={errors[k]}
                        onCommit={(v) => commit(k, v)}
                        onUndo={() => run(() => resetSettings(type, [k], 'saved'))}
                        onReset={() => run(() => resetSettings(type, [k], 'system'))}
                        onHelp={(label, text) => setDocs((d) => ({ path: docPath(k) ?? '', label, text, n: (d?.n ?? 0) + 1 }))}
                      />
                    ))}
                  </fieldset>
                ))}
              </section>
            ))
          )}
          {schema && values && !shown.length && <p className="muted">{t('No matching settings.')}</p>}
        </div>
        {docs && (
          <DocsPanel
            key={docs.n}
            path={docs.path}
            label={docs.label}
            text={docs.text}
            onOpen={(path) => setDocs((d) => d && { ...d, path })}
            onClose={() => setDocs(null)}
          />
        )}
      </div>
    </div>
  );
}

export type Commit = Parameters<typeof editSetting>[2];

/** The filament's "Setting Overrides" page: the only options with a "use the printer's value" state (as desktop's check boxes there). */
const OVERRIDES = new Set(layout.filament.filter((p) => p.title === 'Setting Overrides').flatMap((p) => p.groups.flatMap((g) => g.keys)));
const NUMERIC = ['float', 'int', 'percent', 'float_or_percent'];
/** A decimal comma typed as on the user's keyboard ("0,3"). */
const decimalPoint = (v: string) => v.trim().replace(/^([+-]?\d*),(\d+%?)$/, '$1.$2');
/** These are sliced with: zero is no value for them (desktop puts 0.2 back). */
const ABOVE_ZERO = new Set(['layer_height', 'initial_layer_print_height']);

/**
 * What is wrong with a typed number (untranslated), or null: not a number, or outside the
 * option's limits (desktop's Field: "Invalid numeric.", "Value is out of range.").
 */
export function numberProblem(k: string, def: OptionDef, value: Commit): string | null {
  const base = def.type.replace(/s$/, '').replace(/^floats_or_percent$/, 'float_or_percent');
  // One point of a list ("XxY").
  if (base === 'point' && typeof value !== 'string' && 'value' in value) {
    return /^\s*[+-]?(\d+\.?\d*|\.\d+)x[+-]?(\d+\.?\d*|\.\d+)\s*$/.test(value.value) ? null : N_('Invalid numeric.');
  }
  if (!NUMERIC.includes(base) || def.enum_values) return null;
  const texts = typeof value === 'string' ? [value] : 'elements' in value ? value.elements : [value.value];
  for (const text of texts) {
    const x = text.trim();
    if (!x || x === 'nil') continue;
    const percent = x.endsWith('%');
    if (percent && base !== 'percent' && base !== 'float_or_percent') return N_('Invalid numeric.');
    const digits = percent ? x.slice(0, -1).trim() : x;
    if (!(base === 'int' ? /^[+-]?\d+$/ : /^[+-]?(\d+\.?\d*|\.\d+)$/).test(digits)) return N_('Invalid numeric.');
    const n = Number(digits);
    // A share of another setting has its own limits.
    if (percent && base === 'float_or_percent') continue;
    if ((def.min !== undefined && n < def.min) || (def.max !== undefined && n > def.max) || (ABOVE_ZERO.has(k) && n <= 0))
      return N_('Value is out of range.');
  }
  return null;
}

/** For a field's text: the values it was last loaded from, and whether its own edit was refused. */
const Shown = createContext<{ stamp: unknown; refused: boolean }>({ stamp: null, refused: false });

export function Field({
  k,
  def,
  value,
  index,
  canNil,
  dirty,
  fromSystem,
  error,
  off,
  labelOverride,
  line,
  choices,
  all,
  other,
  onCommit,
  onUndo,
  onReset,
  onHelp,
}: {
  k: string;
  def: OptionDef;
  value: string | string[] | undefined;
  index: number;
  dirty: boolean;
  fromSystem: boolean;
  /** Comparing with another preset: its value (null: it has none), shown beside with a button that takes it. */
  other?: string | string[] | null;
  /** One of the filament's overrides of a printer setting: it can be handed back to the printer. */
  canNil: boolean;
  error?: string;
  off?: string;
  labelOverride?: string;
  line?: string;
  choices?: string[];
  all: Record<string, string | string[]>;
  onCommit: (v: Commit) => void;
  onUndo: () => void;
  onReset: () => void;
  /** Show the setting's documentation: its wiki page, or else its description (none: the description is the name's tooltip only). */
  onHelp?: (label: string, text: string) => void;
}) {
  const kind = editKind(k, def);
  // In a row of several options the option's label ("First layer") only names its part.
  const own = labelOverride || def.label;
  const label = line ? (own && own !== line ? `${tr(line)} – ${tr(own)}` : tr(line)) : tr(own || def.full_label || k);
  const currency = useApp((s) => s.prefs.currency);
  const lang = useApp((s) => s.lang);
  if (value === undefined) return null;
  const elems = Array.isArray(value) ? value : [value];
  const current = fieldText(kind, value, index)!;
  const send = (v: string) => onCommit(commitValue(kind, v, index, value));
  const nil = current === 'nil';
  // The element type of a list ("floats" → "float", "floats_or_percents" → "float_or_percent").
  const base = def.type.replace(/s$/, '').replace(/^floats_or_percent$/, 'float_or_percent');

  // Points the desktop shows on one line ("XxY, XxY, …").
  const oneLine = kind === 'list' && def.type === 'points' && def.gui_type === 'one_string';
  let input: React.ReactNode;
  if (BED_KEYS.has(k)) {
    input = <BedSettingControl k={k as BedKey} all={all} onCommit={onCommit} />;
  } else if (k === 'compatible_printers') {
    input = <CompatiblePrintersControl value={elems} onCommit={onCommit} />;
  } else if (oneLine) {
    input = (
      <TextInput
        line
        value={elems.join(', ')}
        placeholder="0x0, 20x0, 20x20, 0x20"
        onCommit={(v) =>
          onCommit({
            elements: v
              .split(',')
              .map((x) => x.trim())
              .filter(Boolean),
          })
        }
      />
    );
  } else if (def.nullable && nil) {
    input = (
      <button
        className="btn small"
        onClick={() => send(def.default?.split(',')[0] && def.default !== 'nil' ? def.default.split(',')[0]! : '0')}
      >
        {t('Override')}
      </button>
    );
  } else if (base === 'bool') {
    input = (
      <input
        type="checkbox"
        className="switch"
        checked={current === '1'}
        disabled={def.readonly}
        onChange={(e) => send(e.target.checked ? '1' : '0')}
      />
    );
  } else if (base === 'enum' && def.enum_values) {
    input = (
      <Select
        value={current}
        disabled={def.readonly}
        onChange={send}
        aria-label={tr(def.label || k)}
        items={def.enum_values.flatMap((v, i) =>
          !choices || choices.includes(v) || v === current ? [{ value: v, label: tr(def.enum_labels?.[i] || v) }] : [],
        )}
      />
    );
  } else if (def.gui_type === 'color') {
    input = <ColorPicker value={current} disabled={def.readonly} aria-label={tr(def.label || k)} onChange={send} />;
  } else if (kind === 'list' || def.multiline || def.is_code) {
    // Single strings come in config-file form (escaped line breaks); lists come verbatim.
    const esc = def.type === 'string';
    input = (
      <TextArea
        value={esc ? unescapeString(current) : current}
        code={def.is_code || def.multiline}
        gcode={k.endsWith('_gcode') && kind !== 'list'}
        onCommit={(v) => send(esc ? escapeString(v) : v)}
        rows={kind === 'list' ? 4 : 6}
      />
    );
  } else {
    // Desktop's editable combo box: its values to pick, or any other.
    const suggestions =
      def.enum_values && def.gui_type?.endsWith('_open')
        ? def.enum_values.map((v, i) => ({ value: v, label: def.enum_labels?.[i] ? tr(def.enum_labels[i]) : undefined }))
        : undefined;
    // Percentages show as the number, the unit beside it (desktop's OptionsGroup); a typed "%"
    // is fine. They are stored with the "%".
    const percent = base === 'percent';
    const numeric = NUMERIC.includes(base);
    input = (
      <TextInput
        value={percent ? current.replace(/%$/, '') : current}
        options={suggestions}
        readOnly={def.readonly}
        onCommit={(v) => {
          v = numeric ? decimalPoint(v) : v;
          send(percent && v.trim() !== '' ? `${v.trim().replace(/%$/, '')}%` : v);
        }}
        numeric={numeric}
      />
    );
  }
  const wide =
    !BED_KEYS.has(k) && k !== 'compatible_printers' && !oneLine && (kind === 'list' || def.multiline || def.is_code || def.full_width);
  // The description on the name (and first why the setting doesn't apply now).
  const help = [off ? tr(off) : '', def.tooltip ? tr(def.tooltip) : ''].filter(Boolean).join('\n\n');
  // The compared preset's value, where it is another.
  const otherText = other === undefined ? undefined : fieldText(kind, other ?? undefined, index);
  const differ = otherText !== undefined && otherText !== current;
  let shownOther: React.ReactNode = null;
  if (differ) {
    if (base === 'bool') shownOther = <input type="checkbox" className="switch" checked={otherText === '1'} disabled aria-label={label} />;
    else {
      const text = formatSetting(k, def, base === 'percent' ? otherText.replace(/%$/, '') : otherText);
      shownOther = (
        <span className={`other-text${wide || kind === 'list' ? ' block' : ''}${def.is_code || def.multiline ? ' code' : ''}`}>
          {def.gui_type === 'color' && <span className="swatch" style={{ background: otherText }} />}
          {text}
          {def.sidetext && !wide && otherText !== 'nil' ? (
            <span className="sidetext"> {sidetext(def.sidetext, currency, lang)}</span>
          ) : null}
        </span>
      );
    }
  }
  return (
    <div
      className={`field${wide ? ' wide' : ''}${dirty ? ' dirty' : ''}${fromSystem ? ' changed' : ''}${off !== undefined ? ' off' : ''}${differ ? ' differs' : ''}`}
      data-key={k}
    >
      <div className="field-label">
        {/* The name shows the description as its tooltip; a click opens the documentation (the wiki page, or else the description). */}
        {!onHelp ? (
          <span className={`name${help ? ' help' : ''}`} data-tip={help || undefined}>
            {label}
          </span>
        ) : help || docPath(k) ? (
          <button
            type="button"
            className="name help"
            aria-description={help || undefined}
            data-tip={help || undefined}
            onClick={() => onHelp(label, help)}
          >
            {label}
          </button>
        ) : (
          <label className="name">{label}</label>
        )}
      </div>
      <div className="control">
        <fieldset className="input" disabled={off !== undefined}>
          <Shown.Provider value={{ stamp: all, refused: !!error }}>{input}</Shown.Provider>
        </fieldset>
        {def.sidetext && !wide && <span className="sidetext">{sidetext(def.sidetext, currency, lang)}</span>}
        {def.nullable && canNil && !nil && (
          <button
            className="icon-btn small"
            data-tip={t('Use the printer’s value')}
            aria-label={t('Remove override')}
            onClick={() => send('nil')}
          >
            <Ban size={14} />
          </button>
        )}
        {dirty && (
          <button
            className="icon-btn small"
            data-tip={t('Undo change')}
            aria-label={t('Undo {setting}', { setting: label })}
            onClick={onUndo}
          >
            <Undo2 size={14} />
          </button>
        )}
        {fromSystem && (
          <button
            className="icon-btn small accent"
            data-tip={t('Reset to the system value')}
            aria-label={t('Reset {setting}', { setting: label })}
            onClick={onReset}
          >
            <RotateCcw size={14} />
          </button>
        )}
      </div>
      {other !== undefined && (
        <div className="other" data-testid="other-value">
          {differ && (
            <button
              type="button"
              className="icon-btn small"
              data-tip={t('Use this value')}
              aria-label={t('Use this value')}
              disabled={def.readonly}
              onClick={() => send(otherText)}
              data-testid="use-other"
            >
              <ArrowLeft size={14} />
            </button>
          )}
          {shownOther}
        </div>
      )}
      {error && <div className="error small">{error}</div>}
    </div>
  );
}

/** As desktop: the compatibility condition applies only to "All" printers. */
function conditionOff(k: string, all: Record<string, string | string[]>): string | undefined {
  if (k !== 'compatible_printers_condition') return undefined;
  const list = all.compatible_printers;
  return Array.isArray(list) && list.length
    ? N_('Select "All" to edit the compatibility condition instead of using an explicit profile list.')
    : undefined;
}

/** Desktop's escape_string_cstyle / unescape_string_cstyle (config files keep strings on one line). */
const escapeString = (v: string) => v.replace(/[\\\r\n]/g, (c) => (c === '\n' ? '\\n' : c === '\r' ? '\\r' : '\\\\'));
const unescapeString = (v: string) => v.replace(/\\(.)/gs, (_, c: string) => (c === 'n' ? '\n' : c === 'r' ? '\r' : c));

/** Units after a field; desktop's "money" is the chosen currency. */
function sidetext(text: string, currency: string, lang: string): string {
  if (text.startsWith('money/')) return `${currencySymbol(currency, lang.replace('_', '-'))}/${text.slice(6)}`;
  return tr(text);
}

function TextInput({
  value,
  onCommit,
  numeric,
  options,
  readOnly,
  placeholder,
  line,
}: {
  value: string;
  onCommit: (v: string) => void;
  numeric?: boolean;
  /** Values to pick from, besides typing one. */
  options?: ComboOption[];
  readOnly?: boolean;
  placeholder?: string;
  line?: boolean;
}) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  const { stamp, refused } = useContext(Shown);
  // What was typed gives way to the value it became ("0.20" is 0.2), unless it was refused and waits to be put right.
  const sent = useRef(false);
  useEffect(() => {
    if (sent.current && !refused) setV(value);
    sent.current = false;
  }, [stamp]); // eslint-disable-line react-hooks/exhaustive-deps
  const done = (next = v) => {
    if (next !== value) {
      sent.current = true;
      onCommit(next);
    }
  };
  const props = {
    inputMode: numeric ? ('decimal' as const) : undefined,
    className: numeric ? 'num' : line ? 'line' : undefined,
    readOnly,
    placeholder,
    onBlur: () => done(),
    onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') done();
      if (e.key === 'Escape') setV(value);
    },
  };
  if (options) return <ComboInput {...props} value={v} options={options} onChange={setV} onPick={done} />;
  return <input type="text" {...props} value={v} onChange={(e) => setV(e.target.value)} />;
}

function TextArea({
  value,
  onCommit,
  code,
  gcode,
  rows,
}: {
  value: string;
  onCommit: (v: string) => void;
  code?: boolean;
  gcode?: boolean;
  rows: number;
}) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  if (gcode)
    return (
      <CodeArea
        value={v}
        rows={rows}
        onChange={setV}
        onBlur={() => {
          if (v !== value) onCommit(v);
        }}
      />
    );
  return (
    <textarea
      className={code ? 'code' : undefined}
      rows={rows}
      value={v}
      spellCheck={false}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => {
        if (v !== value) onCommit(v);
      }}
    />
  );
}
