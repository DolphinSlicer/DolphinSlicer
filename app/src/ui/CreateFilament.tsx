// Create a filament, as desktop's Create Filament dialog does: "<vendor> <type> <serial>" presets,
// one per chosen printer and for that printer alone, copied from a filament of that type
// ("Create Based on Current Filament") or from a preset per printer ("Copy Current Filament
// Preset"), all with one new filament id.
// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useMemo, useState } from 'react';
import type { FilamentSource } from '../engine/protocol';
import { t } from '../i18n/i18n';
import { printerInLibrary } from '../presets/library';
import { BAD_NAME_CHARS } from '../presets/renamePrinter';
import { createFilament, filamentSources, PresetsExist } from '../state/actions';
import { notify, useApp } from '../state/store';
import { ask } from './Confirm';
import desktop from './createFilamentLists.json';
import { describeError } from './errors';
import { Select } from './Select';

type Mode = 'filament' | 'preset';

export function CreateFilament({ onCreated, onCancel }: { onCreated: (names: string[]) => void; onCancel: () => void }) {
  const presets = useApp((s) => s.presets);
  const lib = useApp((s) => s.library);
  const [sources, setSources] = useState<FilamentSource[]>([]);
  useEffect(() => {
    filamentSources()
      .then(setSources)
      .catch((e) => notify({ kind: 'error', ...describeError(e) }));
  }, []);
  const [vendor, setVendor] = useState('');
  const [customVendor, setCustomVendor] = useState<string | null>(null);
  const [type, setType] = useState('');
  const [serial, setSerial] = useState('');
  const [mode, setMode] = useState<Mode>('filament');
  const [base, setBase] = useState('');
  /** Printer → the preset copied for it (ticked rows only). */
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => setError(null), [vendor, customVendor, type, serial, mode, base, picked]);

  // The printers shown in the pickers (desktop: the visible printers).
  const printers = useMemo(
    () =>
      presets.printers
        .filter((p) => printerInLibrary(lib, p))
        .map((p) => p.name)
        .sort(),
    [presets.printers, lib],
  );
  const fits = (f: FilamentSource) => (f.printers.length ? f.printers.filter((p) => printers.includes(p)) : printers);
  const usable = sources.filter((f) => f.visible || f.user);

  // "Create Based on Current Filament": filaments of the type, one per filament id, by name.
  const choices = useMemo(() => {
    const byId = new Map<string, FilamentSource[]>();
    for (const f of usable) if (!f.inherits && f.type === type) byId.set(f.filament_id, [...(byId.get(f.filament_id) ?? []), f]);
    const seen = new Map<string, number>();
    return [...byId.entries()]
      .map(([id, list]) => {
        const name = list[0]!.name.split(' @')[0]!;
        const n = seen.get(name) ?? 0;
        seen.set(name, n + 1);
        return { id, label: n ? `${name}_${n}` : name, list };
      })
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [usable, type]);
  const baseRows = useMemo(() => {
    const rows = new Map<string, string>();
    for (const f of choices.find((c) => c.id === base)?.list ?? []) for (const p of fits(f)) if (!rows.has(p)) rows.set(p, f.name);
    return [...rows];
  }, [choices, base, printers]);
  // "Copy Current Filament Preset": per printer, the presets of the type made for it.
  const presetRows = useMemo(() => {
    const rows = new Map<string, string[]>();
    for (const f of usable) if (f.type === type) for (const p of fits(f)) rows.set(p, [...(rows.get(p) ?? []), f.name]);
    return [...rows].sort(([a], [b]) => a.localeCompare(b));
  }, [usable, type, printers]);
  useEffect(() => setPicked({}), [mode, type, base]);

  const create = async (overwrite = false) => {
    const v = (customVendor ?? vendor).trim();
    if (customVendor === null && !vendor) return setError(t('Vendor is not selected; please reselect vendor.'));
    if (customVendor !== null && !v) return setError(t('Custom vendor missing; please input custom vendor.'));
    if (v === 'Bambu' || v === 'Generic') return setError(t('"Bambu" or "Generic" cannot be used as a Vendor for custom filaments.'));
    if (!type) return setError(t('Filament type is not selected, please reselect type.'));
    if (!serial.trim()) return setError(t('Filament serial missing; please input serial.'));
    if (BAD_NAME_CHARS.test(v) || BAD_NAME_CHARS.test(serial))
      return setError(t('There may be disallowed characters in the vendor or serial input of the filament. Please delete and re-enter.'));
    if (customVendor !== null && /^\d+$/.test(v)) return setError(t('The vendor cannot be a number; please re-enter.'));
    const items = Object.entries(picked).map(([printer, preset]) => ({ printer, preset }));
    if (!items.length) return setError(t('You have not selected a printer or preset yet. Please select at least one.'));
    const name = `${v} ${type === 'PLA-AERO' ? 'PLA Aero' : type} ${serial.trim()}`;
    if (
      !overwrite &&
      sources.some((f) => f.alias === name) &&
      !(await ask(t('A filament named {name} exists already. Create it anyway?', { name }), { confirm: t('Create') }))
    )
      return;
    setBusy(true);
    let replace = false;
    try {
      onCreated(await createFilament({ name, vendor: v, type, items, overwrite }));
    } catch (e) {
      if (e instanceof PresetsExist)
        replace = await ask(t('These presets exist already: {names}. Replace them?', { names: e.names.join(', ') }), {
          confirm: t('Replace'),
        });
      else notify({ kind: 'error', ...describeError(e) });
    } finally {
      setBusy(false);
    }
    if (replace) void create(true);
  };

  const tick = (printer: string, preset: string | null) => {
    setError(null);
    setPicked(({ [printer]: _, ...rest }) => (preset ? { ...rest, [printer]: preset } : rest));
  };

  return (
    <div className="create-printer" data-testid="create-filament" aria-busy={busy}>
      <div className="create-form">
        <div className="row">
          <span className="caption">{t('Vendor')}</span>
          {customVendor === null ? (
            <Select
              value={vendor}
              onChange={setVendor}
              aria-label={t('Select Vendor')}
              data-testid="filament-vendor"
              items={[
                { value: '', label: t('Select Vendor') },
                ...[...desktop.vendors]
                  .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
                  .map((x) => ({ value: x, label: x })),
              ]}
            />
          ) : (
            <input
              type="text"
              value={customVendor}
              maxLength={50}
              onChange={(e) => setCustomVendor(e.target.value)}
              placeholder={t('Input Custom Vendor')}
              aria-label={t('Input Custom Vendor')}
              data-testid="filament-custom-vendor"
            />
          )}
          <label className="check">
            <input
              type="checkbox"
              checked={customVendor !== null}
              onChange={(e) => setCustomVendor(e.target.checked ? '' : null)}
              data-testid="filament-vendor-custom"
            />
            {t("Can't find vendor I want")}
          </label>
        </div>
        <div className="row">
          <span className="caption">{t('Type')}</span>
          <Select
            value={type}
            onChange={(v) => {
              setType(v);
              setBase('');
            }}
            aria-label={t('Select Type')}
            data-testid="filament-type"
            items={[{ value: '', label: t('Select Type') }, ...desktop.types.map((x) => ({ value: x, label: x }))]}
          />
        </div>
        <div className="row">
          <span className="caption">{t('Serial')}</span>
          <input
            type="text"
            value={serial}
            maxLength={50}
            onChange={(e) => setSerial(e.target.value)}
            aria-label={t('Serial')}
            data-testid="filament-serial"
          />
          <span className="muted small">{t('e.g. Basic, Matte, Silk, Marble')}</span>
        </div>
        <fieldset className="radios">
          <legend>{t('Filament Preset')}</legend>
          <label>
            <input type="radio" checked={mode === 'filament'} onChange={() => setMode('filament')} />
            {t('Create Based on Current Filament')}
          </label>
          <label>
            <input type="radio" checked={mode === 'preset'} onChange={() => setMode('preset')} />
            {t('Copy Current Filament Preset ').trim()}
          </label>
        </fieldset>
        {mode === 'filament' && (
          <>
            <div className="row">
              <span className="caption">{t('Filament Preset')}</span>
              <Select
                value={base}
                onChange={setBase}
                disabled={!type}
                aria-label={t('Select Filament Preset')}
                data-testid="filament-base"
                items={[{ value: '', label: t('Select Filament Preset') }, ...choices.map((c) => ({ value: c.id, label: c.label }))]}
              />
            </div>
            {base && (
              <ul className="printer-checks" data-testid="filament-printers">
                {baseRows.map(([printer, preset]) => (
                  <li key={printer}>
                    <label>
                      <input
                        type="checkbox"
                        checked={!!picked[printer]}
                        onChange={(e) => tick(printer, e.target.checked ? preset : null)}
                      />
                      <span>{printer}</span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
        {mode === 'preset' && type && (
          <ul className="printer-checks" data-testid="filament-presets">
            {presetRows.map(([printer, names]) => (
              <li key={printer}>
                <label>
                  <input type="checkbox" checked={!!picked[printer]} onChange={(e) => tick(printer, e.target.checked ? names[0]! : null)} />
                  <span>{printer}</span>
                </label>
                <Select
                  value={picked[printer] ?? names[0]!}
                  onChange={(v) => tick(printer, v)}
                  aria-label={t('Filament Preset')}
                  items={names.map((n) => ({ value: n, label: n }))}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="create-foot">
        {error && (
          <span className="wizard-hint" role="alert" data-testid="create-error">
            {error}
          </span>
        )}
        {busy && <span className="spinner" aria-label={t('Loading')} />}
        <button type="button" className="btn ghost" onClick={onCancel} disabled={busy}>
          {t('Cancel')}
        </button>
        <button type="button" className="btn primary" onClick={() => void create()} disabled={busy} data-testid="filament-create">
          {t('Create')}
        </button>
      </div>
    </div>
  );
}
