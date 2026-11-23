// The print settings changed most often, beside the plate in Prepare and Preview (as PrusaSlicer's
// and Cura's sidebars have them). Edits are unsaved edits of the selected print settings, as in
// the Settings tab; everything else is there. Collapsed until opened; this browser remembers it.
// SPDX-License-Identifier: AGPL-3.0-or-later
import { ChevronDown } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { PresetValues } from '../engine/protocol';
import { t, tr } from '../i18n/i18n';
import { loadSchema, type Schema } from '../settings/schema';
import { editSetting, presetValues, resetSettings } from '../state/actions';
import { notify, useApp } from '../state/store';
import { describeError } from './errors';
import { type Commit, Field, numberProblem } from './SettingsPanel';

const GROUPS: { title?: string; keys: string[] }[] = [
  { keys: ['layer_height', 'wall_loops', 'sparse_infill_density', 'brim_type'] },
  { title: 'Support', keys: ['enable_support', 'support_type', 'support_on_build_plate_only'] },
];

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
      </div>
      <div id="quick-settings-body" hidden={!open}>
        {GROUPS.map((g) => {
          const keys = g.keys.filter((k) => schema.options[k] && !(k in hidden));
          if (!keys.length) return null;
          return (
            <fieldset key={g.title ?? ''} className="quick-group">
              {g.title && <legend>{tr(g.title)}</legend>}
              {keys.map((k) => (
                <Field
                  key={k}
                  k={k}
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
          );
        })}
      </div>
    </section>
  );
}
