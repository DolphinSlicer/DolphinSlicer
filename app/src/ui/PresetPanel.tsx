// Printer / process / filament pickers, backed by OrcaSlicer's PresetBundle in the engine.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Settings, Undo2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { PresetEntry, PresetSelection, PresetType } from '../engine/protocol';
import { t, tr } from '../i18n/i18n';
import { filamentInLibrary, isModelVariant, printerInLibrary } from '../presets/library';
import { profilesManifest } from '../presets/profiles';
import { loadSchema } from '../settings/schema';
import { applySelection, aux, preferLibraryFilament, resetSettings } from '../state/actions';
import { notify, set, useApp } from '../state/store';
import { ask } from './Confirm';
import { describeError } from './errors';
import { Select, type SelectItem, type SelectOption, type SelectProps } from './Select';

const ALL: PresetType[] = ['printer', 'print', 'filament'];

export type Group = [label: string | null, entries: PresetEntry[]];

/** Groups sorted by name, those in `first` ahead in that order. */
export function groupBy(list: PresetEntry[], key: (e: PresetEntry) => string, first: string[] = [], last = ''): Group[] {
  const m = new Map<string, PresetEntry[]>();
  for (const e of list) m.set(key(e), [...(m.get(key(e)) ?? []), e]);
  const rank = (g: string) => (g === last ? first.length + 1 : first.includes(g) ? first.indexOf(g) : first.length);
  return [...m.entries()].sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b));
}

/**
 * The printer, filament and print settings choices, and switching between them. Printers and
 * filaments are those in the user's library (and their own presets), plus the selected one.
 */
export function usePresetPicker() {
  const p = useApp((s) => s.presets);
  const lib = useApp((s) => s.library);
  const [vendorNames, setVendorNames] = useState<Record<string, string>>({});
  useEffect(() => {
    profilesManifest()
      .then((m) => setVendorNames(Object.fromEntries(m.vendors.map((v) => [v.id, v.name]))))
      .catch(() => {});
  }, []);
  const s = p.state;
  const value: Record<PresetType, string> = { printer: s?.printer ?? '', print: s?.process ?? '', filament: s?.filaments[0] ?? '' };
  const groups = useMemo((): Record<PresetType, Group[]> => {
    const mine = t('My presets');
    const custom = t('Custom printers');
    // Custom printers: the user's own with no parent (Create Printer), and their children.
    const userPrinters = new Set(p.printers.filter((x) => x.user).map((x) => x.name));
    const isCustom = (x: PresetEntry) => x.user && (!x.inherits || userPrinters.has(x.inherits));
    const printers = p.printers.filter((x) => printerInLibrary(lib, x) || x.name === value.printer);
    // A nozzle the user made for a listed system printer (Create variant…) is one more variant of that printer.
    const madeFor = new Map(printers.filter((x) => x.system && x.model).map((x) => [x.model!, vendorNames[x.vendor] ?? x.vendor]));
    const filaments = (s?.filament_presets ?? []).filter((x) => filamentInLibrary(lib, x) || x.name === value.filament);
    // As desktop: the selected one stays listed when it doesn't fit the printer (after its
    // compatible printers were changed), apart.
    const unsupported = t('Unsupported presets');
    const processes = s?.processes ?? [];
    const off = processes.filter((x) => x.compatible === false);
    return {
      printer: groupBy(
        printers,
        (e) =>
          madeFor.get(e.model ?? '') && isModelVariant(e, p.printers)
            ? madeFor.get(e.model!)!
            : isCustom(e)
              ? custom
              : e.user
                ? mine
                : (vendorNames[e.vendor] ?? e.vendor),
        [custom, mine],
      ),
      filament: groupBy(
        filaments,
        (e) => (e.compatible === false ? unsupported : e.user ? mine : e.filament_vendor || t('Other')),
        [mine],
        unsupported,
      ),
      print: off.length
        ? [
            [null, processes.filter((x) => x.compatible !== false)],
            [unsupported, off],
          ]
        : [[null, processes]],
    };
  }, [p.printers, s, lib, vendorNames, value.printer, value.filament]);
  const busy = p.status === 'loading';
  const run = (f: () => Promise<unknown>) => f().catch((e) => notify({ kind: 'error', ...describeError(e) }));
  /**
   * Ask before a switch discards unsaved edits: the printer's when it is another printer, the
   * print settings' and filament's only when they don't fit it (desktop's Tab::select_preset).
   */
  const discardOk = async (selection: PresetSelection) => {
    if (!s || !ALL.some((ty) => s.dirty?.[ty])) return true;
    const lost = (await aux.call('presetsSelectLoses', { selection })).map((ty) => value[ty]);
    return !lost.length || ask(t('Discard unsaved changes to {names}?', { names: lost.join(', ') }), { confirm: t('Discard') });
  };
  // A printer switch can replace the print settings and filament too (when they do not fit the new one).
  const pick = async (type: PresetType, name: string) => {
    if (!s) return;
    const selection: PresetSelection =
      type === 'printer'
        ? { printer: name }
        : type === 'filament'
          ? { printer: s.printer, process: s.process, filaments: [name] }
          : { printer: s.printer, process: name, filaments: s.filaments };
    if (!(await discardOk(selection))) return;
    if (type === 'printer')
      run(async () => {
        await applySelection(selection);
        await preferLibraryFilament();
      });
    else run(() => applySelection(selection));
  };
  return { p, busy, groups, value, pick, run, discardOk, vendorNames };
}

type PassProps = Pick<SelectProps, 'aria-label' | 'aria-labelledby' | 'data-testid' | 'className'>;

/**
 * A dropdown of the presets of one type; picking one switches to it. `byModel` (the sidebar's
 * printer): one entry per printer model, the variant picked beside it.
 */
export function PresetSelect({
  type,
  picker,
  modified,
  byModel,
  ...rest
}: PassProps & { type: PresetType; picker: ReturnType<typeof usePresetPicker>; modified?: boolean; byModel?: boolean }) {
  const { p, busy, groups, value, pick } = picker;
  const grouped = byModel && type === 'printer';
  // Desktop's sidebar lists a model once, its variants picked beside it.
  const isVariant = (e: PresetEntry) => isModelVariant(e, p.printers);
  const items = useMemo((): SelectItem[] => {
    const option = (e: PresetEntry): SelectOption => ({
      value: e.name,
      label: e.name,
      swatch: type === 'filament' ? (e.default_filament_colour ?? '') : undefined,
    });
    const options = (list: PresetEntry[]): SelectOption[] => {
      if (!grouped) return list.map(option);
      // A model's entry stands for the selected printer when it is one of them.
      const byKey = new Map<string, SelectOption>();
      const out: SelectOption[] = [];
      for (const e of list) {
        const variant = isModelVariant(e, p.printers);
        const key = variant ? `model:${e.model}` : `name:${e.name}`;
        const o = byKey.get(key);
        if (!o) {
          const n = { value: e.name, label: variant ? e.model! : e.name };
          byKey.set(key, n);
          out.push(n);
        } else if (e.name === value.printer) o.value = e.name;
      }
      return out;
    };
    return groups[type].flatMap(([g, list]): SelectItem[] => (g === null ? options(list) : [{ group: g, options: options(list) }]));
  }, [groups, type, grouped, value.printer, p.printers]);
  // Another model: its printer with the nozzle in use, when it has one (desktop's
  // get_similar_printer_preset keeps the variant too).
  const choose = (v: string) => {
    if (!grouped) return pick(type, v);
    const e = p.printers.find((x) => x.name === v);
    const cur = p.printers.find((x) => x.name === value.printer);
    const variant = p.state?.printer_variants.variant;
    const same =
      e && isVariant(e) && variant ? p.printers.find((x) => isVariant(x) && x.model === e.model && x.variant === variant) : undefined;
    // The entry of the selected printer's own model: nothing to switch (a copy of it is its own entry).
    return pick(type, e && cur && isVariant(e) && isVariant(cur) && cur.model === e.model ? value.printer : (same?.name ?? v));
  };
  // The sidebar's printer shows as its model.
  const current = grouped ? p.printers.find((x) => x.name === value.printer) : undefined;
  const shownName = current && isVariant(current) ? current.model! : value[type];
  const manage = type === 'printer' ? t('Add or remove printers…') : type === 'filament' ? t('Add or remove filaments…') : null;
  const actions = useMemo(
    () => (manage ? [{ label: manage, onSelect: () => set({ wizard: type === 'printer' ? 'printers' : 'filaments' }) }] : []),
    [manage, type],
  );
  return (
    <Select
      {...rest}
      value={value[type]}
      items={items}
      actions={actions}
      disabled={busy || !p.state}
      display={modified ? t('{name} (modified)', { name: shownName }) : undefined}
      onChange={(v) => void choose(v)}
    />
  );
}

export function PresetPanel() {
  const picker = usePresetPicker();
  const { p, busy } = picker;

  return (
    <section className="card presets" aria-busy={busy}>
      <div className="card-head">
        <h2>
          {t('Printer & material')} {busy && <span className="spinner" aria-label={t('Loading')} />}
        </h2>
      </div>
      {(
        [
          ['printer', t('Printer')],
          ['filament', t('Filament')],
          ['print', t('Print settings')],
        ] as const
      ).map(([type, caption]) => {
        const id = type === 'print' ? 'process' : type;
        return (
          <div className="preset-field" key={type}>
            <div className="preset-head">
              <span className="caption" id={`preset-${id}-label`}>
                {caption}
              </span>
              {/* Above the settings button. */}
              {p.state?.dirty?.[type] && <DiscardButton type={type} name={picker.value[type]} picker={picker} />}
            </div>
            <div className="select-row">
              <PresetSelect
                type={type}
                picker={picker}
                byModel
                modified={!!p.state?.dirty?.[type]}
                data-testid={id}
                aria-labelledby={`preset-${id}-label`}
              />
              {type === 'printer' && <VariantSelect picker={picker} />}
              <EditButton type={type} disabled={busy || !p.state} />
            </div>
            {type === 'printer' && <BedTypeSelect picker={picker} />}
          </div>
        );
      })}
      {p.status === 'error' && <p className="error small">{p.message}</p>}
    </section>
  );
}

/**
 * The printer's variant (nozzle), beside it: the printer variants of its model, as desktop's
 * sidebar lists them; a pick switches the printer preset. Desktop's caption "Variant" is its
 * tooltip, as not every variant is a size ("0.4HF").
 */
function VariantSelect({ picker }: { picker: ReturnType<typeof usePresetPicker> }) {
  const { p, busy, run, discardOk } = picker;
  if (!p.state) return null;
  const { variants, variant } = p.state.printer_variants;
  const pick = async (v: string) => {
    if (v === variant || !(await discardOk({ variant: v }))) return;
    run(async () => {
      await applySelection({ variant: v });
      await preferLibraryFilament();
    });
  };
  const printer = p.state.printer;
  const model = p.printers.find((e) => e.name === printer)?.model;
  // Desktop's "Create Nozzle for Existing Printer", for this printer.
  const actions = model ? [{ label: t('Create variant…'), onSelect: () => set({ wizard: 'printers', createVariant: model }) }] : [];
  return (
    <span className="variant-select" data-tip={t('Variant')}>
      <Select
        value={variant}
        items={variants.map((v) => ({ value: v, label: v }))}
        actions={actions}
        disabled={busy}
        onChange={(v) => void pick(v)}
        aria-label={t('Variant')}
        data-testid="nozzle"
      />
    </span>
  );
}

/** The plate type sliced with, under the printer when it offers several (as desktop's sidebar). */
function BedTypeSelect({ picker }: { picker: ReturnType<typeof usePresetPicker> }) {
  const { p, busy, run } = picker;
  const [plates, setPlates] = useState<Record<string, string>>({});
  useEffect(() => {
    loadSchema().then(
      (sc) => {
        const d = sc.options.curr_bed_type;
        setPlates(Object.fromEntries((d?.enum_values ?? []).map((v, i) => [v, d?.enum_labels?.[i] ?? v])));
      },
      () => {},
    );
  }, []);
  const s = p.state;
  if (!s?.bed_types.length) return null;
  return (
    <div className="bed-type-field">
      <span className="caption" id="preset-bed-label">
        {t('Bed type')}
      </span>
      <div className="select-row">
        <Select
          value={s.bed_type}
          items={s.bed_types.map((v) => ({ value: v, label: tr(plates[v] ?? v) }))}
          disabled={busy}
          onChange={(v) => run(() => applySelection({ bed_type: v }))}
          aria-labelledby="preset-bed-label"
          data-testid="bed-type"
        />
        {/* Lined up with the pickers above, which end at their settings button. */}
        <span className="edit-spacer" />
      </div>
    </div>
  );
}

/** Shown while the preset has unsaved changes: back to it as saved, after asking. */
function DiscardButton({ type, name, picker }: { type: PresetType; name: string; picker: ReturnType<typeof usePresetPicker> }) {
  const { busy, run } = picker;
  return (
    <button
      type="button"
      className="icon-btn discard"
      aria-label={t('Discard changes')}
      data-tip={t('Discard changes')}
      disabled={busy}
      data-testid={`discard-${type}`}
      onClick={async () => {
        if (await ask(t('Discard unsaved changes to {names}?', { names: name }), { confirm: t('Discard') }))
          run(() => resetSettings(type, undefined, 'saved'));
      }}
    >
      <Undo2 size={12} />
    </button>
  );
}

function EditButton({ type, disabled }: { type: 'print' | 'filament' | 'printer'; disabled: boolean }) {
  const label = { print: t('Edit print settings'), filament: t('Edit filament settings'), printer: t('Edit printer settings') }[type];
  return (
    <button
      type="button"
      className="btn edit"
      aria-label={label}
      data-tip={label}
      disabled={disabled}
      data-testid={`edit-${type}`}
      onClick={(e) => {
        e.preventDefault();
        set({ view: 'settings', settingsType: type });
      }}
    >
      <Settings size={16} />
    </button>
  );
}
