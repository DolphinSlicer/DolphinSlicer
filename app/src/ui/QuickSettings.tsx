// The print settings changed most often, beside the plate in Prepare and Preview (as PrusaSlicer's
// and Cura's sidebars have them). Edits are unsaved edits of the selected print settings, as in
// the Settings tab; everything else is there. Which settings: the user's choice (a preference,
// synced). Collapsed until opened; this browser remembers it.
// SPDX-License-Identifier: AGPL-3.0-or-later
import { ChevronDown, Search, SlidersHorizontal } from 'lucide-react';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { PresetValues } from '../engine/protocol';
import { t, tr } from '../i18n/i18n';
import { layout, loadSchema, type OptionDef, type Schema } from '../settings/schema';
import { editSetting, presetValues, resetSettings } from '../state/actions';
import { DEFAULT_QUICK_SETTINGS } from '../state/prefs';
import { updatePrefs } from '../state/prefsActions';
import { notify, useApp } from '../state/store';
import { describeError } from './errors';
import { Presence } from './Presence';
import { type Commit, Field, numberProblem } from './SettingsPanel';
import { useModal } from './useModal';

/** A print setting where the settings page has it. */
interface Placed {
  key: string;
  page: string;
  group: string;
  /** The labeled row it is part of. */
  line?: string;
}
/** The print settings in the settings page's order (each once). */
const PLACED: Placed[] = (() => {
  const seen = new Set<string>();
  return layout.print.flatMap((p) =>
    p.groups.flatMap((g) =>
      g.keys.filter((k) => !seen.has(k) && seen.add(k)).map((key) => ({ key, page: p.title, group: g.title, line: g.lines?.[key] })),
    ),
  );
})();

/** The name as the settings page shows it, in English. */
const englishLabel = (p: Placed, def: OptionDef, own = def.label || def.full_label || p.key) =>
  p.line && own !== p.line ? `${p.line} – ${own}` : p.line || own;
const label = (p: Placed, def: OptionDef, own = def.label || def.full_label || p.key) =>
  p.line && own !== p.line ? `${tr(p.line)} – ${tr(own)}` : tr(p.line || own);

/** Not in a narrow card: G-code and other text boxes. */
const fits = (def: OptionDef) => !def.multiline && !def.is_code && !def.full_width;

const stems = (s: string) =>
  s
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((w) => w.length > 2)
    .map((w) => w.slice(0, 4));
/** The name says what it is without its group's title ("Wall loops" in Walls, not "Type" in Support). */
const saysGroup = (p: Placed, def: OptionDef) => {
  const g = stems(p.group);
  return stems(englishLabel(p, def)).some((w) => g.includes(w));
};

/**
 * The card's sections: settings named well enough by themselves first, untitled; then the others
 * under their group's title, as on the settings page.
 */
function sections(keys: Set<string>, options: Record<string, OptionDef>) {
  const groups = new Map<string, Placed[]>();
  for (const p of PLACED) {
    if (!keys.has(p.key) || !options[p.key]) continue;
    const id = `${p.page}/${p.group}`;
    groups.set(id, [...(groups.get(id) ?? []), p]);
  }
  const loose: Placed[] = [];
  const titled: { id: string; title: string; items: Placed[] }[] = [];
  for (const [id, items] of groups) {
    if (items.length === 1 && saysGroup(items[0]!, options[items[0]!.key]!)) loose.push(items[0]!);
    else titled.push({ id, title: items[0]!.group, items });
  }
  return [...(loose.length ? [{ id: '', title: '', items: loose }] : []), ...titled];
}

const OPEN_KEY = 'dolphin-slicer.quick-settings.v1';

function storedOpen(): boolean {
  try {
    return localStorage.getItem(OPEN_KEY) === 'open';
  } catch {
    return false;
  }
}

export function QuickSettings() {
  const [open, setOpen] = useState(storedOpen);
  const toggle = () => {
    setOpen(!open);
    try {
      localStorage.setItem(OPEN_KEY, open ? 'closed' : 'open');
    } catch {
      /* private mode: this session only */
    }
  };
  const config = useApp((s) => s.presets.config);
  const chosen = useApp((s) => s.prefs.quickSettings);
  const [choosing, setChoosing] = useState(false);
  const [schema, setSchema] = useState<Schema | null>(null);
  const [values, setValues] = useState<PresetValues | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    loadSchema().then(setSchema, (e) => notify({ kind: 'error', ...describeError(e) }));
  }, []);
  const reload = async () => {
    const v = await presetValues('print').catch(() => null);
    if (v) setValues(v);
  };
  // Any edit, save or other selection (here, in Prepare or in Settings) changes the config.
  useEffect(() => {
    if (config) void reload();
  }, [config]);

  if (!schema || !values || !config) return null;

  const run = async (f: () => Promise<unknown>) => {
    try {
      await f();
    } catch (e) {
      notify({ kind: 'error', ...describeError(e) });
    }
  };
  const commit = async (key: string, value: Commit) => {
    try {
      const problem = numberProblem(key, schema.options[key]!, value);
      if (problem) throw new Error(problem);
      await editSetting('print', key, value);
      setErrors(({ [key]: _, ...rest }) => rest);
    } catch (e) {
      setErrors((x) => ({ ...x, [key]: describeError(e).message }));
    }
    await reload();
  };
  // One value of a list (a nozzle's) is reported as "key#index".
  const whole = (keys: string[]) => new Set(keys.map((k) => k.replace(/#\d+$/, '')));
  const dirty = whole(values.dirty);
  const fromSystem = whole(values.from_system);
  const variantKeys = new Set(values.variant_keys);
  const hidden = values.states.hidden;
  const shown = sections(new Set(chosen.filter((k) => !(k in hidden))), schema.options);

  return (
    <section className={`card quick-settings${open ? '' : ' collapsed'}`} data-testid="quick-settings">
      <div className="card-head">
        <h2>
          <button
            type="button"
            className="card-toggle"
            aria-expanded={open}
            aria-controls="quick-settings-body"
            onClick={toggle}
            data-testid="quick-settings-toggle"
          >
            <ChevronDown size={14} aria-hidden="true" />
            {t('Quick settings')}
          </button>
        </h2>
        {open && (
          <div className="card-tools">
            <button
              type="button"
              className="icon-btn"
              aria-label={t('Choose quick settings')}
              data-tip={t('Choose quick settings')}
              aria-haspopup="dialog"
              onClick={() => setChoosing(true)}
              data-testid="quick-settings-choose"
            >
              <SlidersHorizontal size={15} />
            </button>
          </div>
        )}
      </div>
      <div id="quick-settings-body" hidden={!open}>
        {shown.map((g) => (
          <fieldset key={g.id} className="quick-group">
            {g.title && <legend>{tr(g.title)}</legend>}
            {g.items.map(({ key: k, line }) => (
              <Field
                key={k}
                k={k}
                line={line}
                def={schema.options[k]!}
                value={values.values[k]}
                index={variantKeys.has(k) ? values.variant_index : 0}
                off={values.states.disabled[k]}
                labelOverride={values.states.labels[k]}
                choices={values.states.enums[k]}
                all={values.values}
                canNil={false}
                dirty={dirty.has(k)}
                fromSystem={fromSystem.has(k)}
                error={errors[k]}
                onCommit={(v) => void commit(k, v)}
                onUndo={() => void run(() => resetSettings('print', [k], 'saved'))}
                onReset={() => void run(() => resetSettings('print', [k], 'system'))}
              />
            ))}
          </fieldset>
        ))}
      </div>
      {/* On the page itself: the dock's blur would be what fixed positions are relative to. */}
      {createPortal(<Presence>{choosing && <ChooseDialog schema={schema} onClose={() => setChoosing(false)} />}</Presence>, document.body)}
    </section>
  );
}

/** Which print settings the card shows: all that fit in it, by page and group, to tick. */
function ChooseDialog({ schema, onClose }: { schema: Schema; onClose: () => void }) {
  const chosen = useApp((s) => s.prefs.quickSettings);
  const [query, setQuery] = useState('');
  const modal = useModal<HTMLDivElement>();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const picked = new Set(chosen);
  const toggle = (k: string) => {
    if (picked.has(k)) picked.delete(k);
    else picked.add(k);
    void updatePrefs({ quickSettings: PLACED.map((p) => p.key).filter((x) => picked.has(x)) });
  };
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const groups = new Map<string, { page: string; group: string; items: { key: string; text: string }[] }>();
  for (const p of PLACED) {
    const def = schema.options[p.key];
    if (!def || !fits(def)) continue;
    const text = label(p, def);
    const names = [text, englishLabel(p, def), p.page, tr(p.page), p.group, tr(p.group)].join(' ').toLowerCase();
    if (!words.every((w) => names.includes(w))) continue;
    const id = `${p.page}/${p.group}`;
    if (!groups.has(id)) groups.set(id, { page: p.page, group: p.group, items: [] });
    groups.get(id)!.items.push({ key: p.key, text });
  }
  const isDefault = chosen.length === DEFAULT_QUICK_SETTINGS.length && DEFAULT_QUICK_SETTINGS.every((k) => picked.has(k));
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal quick-choose"
        role="dialog"
        ref={modal}
        aria-modal="true"
        aria-labelledby="quick-choose-title"
        onClick={(e) => e.stopPropagation()}
        data-testid="quick-choose"
      >
        <h2 id="quick-choose-title">{t('Quick settings')}</h2>
        <label className="search">
          <Search size={15} />
          <input
            type="search"
            placeholder={t('Search settings')}
            aria-label={t('Search settings')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            data-testid="quick-choose-search"
          />
        </label>
        <div className="quick-choose-list">
          {[...groups.values()].map((g) => (
            <section key={`${g.page}/${g.group}`}>
              <h3>
                {tr(g.page)} › {tr(g.group)}
              </h3>
              <ul>
                {g.items.map((i) => (
                  <li key={i.key}>
                    <label>
                      <input type="checkbox" checked={picked.has(i.key)} onChange={() => toggle(i.key)} data-key={i.key} />
                      <span>{i.text}</span>
                    </label>
                  </li>
                ))}
              </ul>
            </section>
          ))}
          {!groups.size && <p className="muted">{t('No results')}</p>}
        </div>
        <div className="quick-choose-actions">
          <button
            type="button"
            className="btn ghost"
            disabled={isDefault}
            onClick={() => void updatePrefs({ quickSettings: DEFAULT_QUICK_SETTINGS })}
          >
            {t('Reset to defaults')}
          </button>
          <button type="button" className="btn" onClick={onClose}>
            {t('Close')}
          </button>
        </div>
      </div>
    </div>
  );
}
