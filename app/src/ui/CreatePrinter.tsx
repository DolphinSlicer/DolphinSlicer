// Create a custom printer, as desktop's "Create Printer/Nozzle" dialog does: a printer preset of the
// user's own with no parent (all values its own), started from a template printer or the current
// one, with copies of the chosen print settings and filaments made for it alone. A new nozzle for
// the user's own printer is a child of it instead, so it follows that printer's later changes.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Search } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { PresetEntry } from '../engine/protocol';
import { t, tr } from '../i18n/i18n';
import { isModelVariant } from '../presets/library';
import type { VendorInfo } from '../presets/profiles';
import {
  createPrinter,
  linkedPresets,
  loadVendorProfiles,
  MAX_MODEL_NAME,
  nameProblem,
  PresetsExist,
  printerTemplates,
} from '../state/actions';
import { notify, useApp } from '../state/store';
import { ask } from './Confirm';
import { describeError } from './errors';
import { Select } from './Select';

/** Desktop's nozzle choices (CreatePresetsDialog nozzle_diameter_vec). */
const NOZZLES = ['0.4', '0.15', '0.2', '0.25', '0.3', '0.35', '0.5', '0.6', '0.75', '0.8', '1.0', '1.2', '1.75'];

type Kind = 'printer' | 'nozzle';
type Source = 'template' | 'current';

/** `variantOf`: a printer model to add a nozzle to (the variant picker's "Create variant…"). */
export function CreatePrinter({
  vendors,
  variantOf,
  onCreated,
  onCancel,
}: {
  vendors: VendorInfo[];
  variantOf?: string | null;
  onCreated: (name: string) => void;
  onCancel: () => void;
}) {
  const presets = useApp((s) => s.presets);
  const [step, setStep] = useState<1 | 2>(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Page 1: the printer.
  const [kind, setKind] = useState<Kind>(variantOf ? 'nozzle' : 'printer');
  const [brand, setBrand] = useState('');
  const [model, setModel] = useState('');
  const [existing, setExisting] = useState('');
  const [nozzle, setNozzle] = useState('0.4');
  const [size, setSize] = useState({ x: '200', y: '200' });
  const [origin, setOrigin] = useState({ x: '0', y: '0' });
  const [height, setHeight] = useState('200');

  // Page 2: what it starts from.
  // A variant starts from the printer it is a variant of (the current one, from the variant picker).
  const [source, setSource] = useState<Source>(variantOf ? 'current' : 'template');
  const [tplVendor, setTplVendor] = useState('');
  const [tplModel, setTplModel] = useState('');
  const [tplPrinter, setTplPrinter] = useState('');
  const [templates, setTemplates] = useState<{ processes: PresetEntry[]; filaments: PresetEntry[] } | null>(null);
  const [processes, setProcesses] = useState<Set<string>>(new Set());
  const [filaments, setFilaments] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState('');
  // A new nozzle (variant) shares the user's presets made for its model, all by default.
  const [linked, setLinked] = useState<{ processes: PresetEntry[]; filaments: PresetEntry[] } | null>(null);

  // Printers a nozzle can be added to: system printers and the user's own roots, one per model.
  const basePrinters = useMemo(() => {
    const m = new Map<string, PresetEntry>();
    for (const p of presets.printers) if ((p.system || (p.user && !p.inherits)) && p.model && !m.has(p.model)) m.set(p.model, p);
    return [...m.values()].sort((a, b) => a.model!.localeCompare(b.model!));
  }, [presets.printers]);
  // The variant picker's printer, once the printers are listed.
  useEffect(() => {
    const base = variantOf ? basePrinters.find((p) => p.model === variantOf) : undefined;
    if (base) setExisting((e) => e || base.name);
  }, [variantOf, basePrinters]);
  const variantModel = kind === 'nozzle' ? basePrinters.find((p) => p.name === existing)?.model : undefined;
  useEffect(() => {
    if (step !== 2 || !variantModel) {
      setLinked(null);
      return;
    }
    let live = true;
    linkedPresets(variantModel).then(
      (r) => {
        if (live) setLinked(r);
      },
      (e) => notify({ kind: 'error', ...describeError(e) }),
    );
    return () => {
      live = false;
    };
  }, [step, variantModel]);
  const linkedNames = new Set([...(linked?.processes ?? []), ...(linked?.filaments ?? [])].map((x) => x.name));
  const brandModels = vendors.find((v) => v.name.toLowerCase() === brand.trim().toLowerCase())?.models ?? [];
  // Template printers of the chosen maker, once its profiles are loaded.
  const tplEntries = presets.printers.filter((p) => p.system && p.vendor === tplVendor);
  const tplModels = [...new Set(tplEntries.map((p) => p.model!))].sort();
  const tplNozzles = tplEntries.filter((p) => p.model === tplModel);
  const template = source === 'current' ? (presets.state?.printer ?? '') : tplPrinter;

  useEffect(() => {
    if (step !== 2 || !template) {
      setTemplates(null);
      return;
    }
    let live = true;
    setTemplates(null);
    printerTemplates(template)
      .then((r) => {
        if (live) {
          setTemplates(r);
          setProcesses(new Set());
          setFilaments(new Set());
        }
      })
      .catch((e) => notify({ kind: 'error', ...describeError(e) }));
    return () => {
      live = false;
    };
  }, [step, template]);

  const pickVendor = async (id: string) => {
    setTplVendor(id);
    setTplModel('');
    setTplPrinter('');
    if (!id) return;
    setBusy(true);
    try {
      await loadVendorProfiles(id);
    } catch (e) {
      notify({ kind: 'error', ...describeError(e) });
    } finally {
      setBusy(false);
    }
  };

  // Plain decimal numbers only (Number() also takes "Infinity", "0x10" and "1e3").
  const num = (s: string) => {
    const x = s.trim().replace(',', '.');
    return /^[+-]?(\d+\.?\d*|\.\d+)$/.test(x) ? Number(x) : NaN;
  };
  const next = () => {
    if (kind === 'printer') {
      if (!brand.trim() || !model.trim())
        return setError(t('You have not selected the vendor and model or input the custom vendor and model.'));
      // The printer's presets are files named after it.
      const problem = nameProblem(`${brand.trim()} ${model.trim()}`, MAX_MODEL_NAME);
      if (problem) return setError(tr(problem));
      const [x, y, ox, oy] = [num(size.x), num(size.y), num(origin.x), num(origin.y)];
      if (!(x > 0 && y > 0) || !(ox < x && oy < y) || [ox, oy].some(Number.isNaN) || !(num(height) > 0))
        return setError(t('Please check bed printable shape and origin input.'));
    } else if (!existing) {
      return setError(t('You have not yet selected the printer to replace the nozzle for; please choose a printer.'));
    }
    if (!(num(nozzle) > 0)) return setError(t('Please check the nozzle diameter.'));
    if (
      kind === 'nozzle' &&
      presets.printers.some((p) => p.model === variantModel && isModelVariant(p, presets.printers) && Number(p.variant) === num(nozzle))
    ) {
      return setError(t('The printer has this nozzle already.'));
    }
    setError(null);
    setStep(2);
  };

  const create = async (overwrite = false) => {
    if (!template)
      return setError(
        t('You have not yet chosen which printer preset to create based on. Please choose the vendor and model of the printer'),
      );
    // A variant uses all of its model's presets: those of its printer come with being its child
    // (OrcaSlicer's parent rule), the others name it among their printers.
    // The ones in use first: the variant starts with the first it shares.
    const inUse = new Set([presets.state?.process, presets.state?.filaments[0]]);
    const sharing = linked
      ? [...linked.processes, ...linked.filaments].map((x) => x.name).sort((a, b) => Number(inUse.has(b)) - Number(inUse.has(a)))
      : [];
    if (!filaments.size && !linked?.filaments.length) return setError(t('You need to select at least one filament preset.'));
    if (!processes.size && !linked?.processes.length) return setError(t('You need to select at least one process preset.'));
    setError(null);
    const base = basePrinters.find((p) => p.name === existing);
    const [x, y, ox, oy] = [num(size.x), num(size.y), num(origin.x), num(origin.y)];
    const spec = {
      model: kind === 'printer' ? `${brand.trim()} ${model.trim()}` : base!.model!,
      nozzle: String(num(nozzle)),
      template,
      from_template: source === 'template',
      ...(kind === 'printer'
        ? {
            area: [
              [-ox, -oy],
              [x - ox, -oy],
              [x - ox, y - oy],
              [-ox, y - oy],
            ]
              .map(([a, b]) => `${a}x${b}`)
              .join(','),
            height: num(height),
          }
        : { bed_from: base!.name, link: true }),
      processes: [...processes],
      filaments: [...filaments],
      share: sharing,
      overwrite,
    };
    setBusy(true);
    let replace = false;
    try {
      onCreated(await createPrinter(spec));
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

  // A changed choice answers the last message.
  useEffect(() => setError(null), [processes, filaments, template, kind, brand, model, existing]);
  const toggle = (set: Set<string>, update: (s: Set<string>) => void, name: string) => {
    const s = new Set(set);
    if (s.has(name)) s.delete(name);
    else s.add(name);
    update(s);
  };
  const q = filter.trim().toLowerCase();
  // Copies of the shared presets would only repeat them.
  const shownFilaments = (templates?.filaments ?? []).filter((f) => !linkedNames.has(f.name) && (!q || f.name.toLowerCase().includes(q)));
  const shownProcesses = (templates?.processes ?? []).filter((x) => !linkedNames.has(x.name));

  return (
    <div className="create-printer" data-testid="create-printer" aria-busy={busy}>
      {step === 1 && (
        <div
          className="create-form"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && e.target instanceof HTMLInputElement && e.target.type === 'text') next();
          }}
        >
          <fieldset className="radios">
            <legend>{t('Create Type')}</legend>
            <label>
              <input type="radio" checked={kind === 'printer'} onChange={() => setKind('printer')} />
              {t('Create Printer')}
            </label>
            <label>
              <input type="radio" checked={kind === 'nozzle'} onChange={() => setKind('nozzle')} />
              {t('Create Nozzle for Existing Printer')}
            </label>
          </fieldset>
          {kind === 'printer' ? (
            <div className="row">
              <span className="caption">{t('Printer')}</span>
              <input
                type="text"
                list="create-brands"
                placeholder={t('Input Custom Vendor')}
                aria-label={t('Input Custom Vendor')}
                value={brand}
                onChange={(e) => setBrand(e.target.value)}
                data-testid="create-vendor"
              />
              <input
                type="text"
                list="create-models"
                placeholder={t('Input Custom Model')}
                aria-label={t('Input Custom Model')}
                value={model}
                onChange={(e) => setModel(e.target.value)}
                data-testid="create-model"
              />
              <datalist id="create-brands">
                {vendors.map((v) => (
                  <option key={v.id} value={v.name} />
                ))}
              </datalist>
              <datalist id="create-models">
                {brandModels.map((m) => (
                  <option key={m.name} value={m.name} />
                ))}
              </datalist>
            </div>
          ) : (
            <div className="row">
              <span className="caption">{t('Printer')}</span>
              <Select
                value={existing}
                onChange={setExisting}
                aria-label={t('Select Printer')}
                data-testid="create-existing"
                items={[
                  { value: '', label: t('Select Printer') },
                  ...basePrinters.map((p) => ({ value: p.name, label: p.model ?? p.name })),
                ]}
              />
            </div>
          )}
          <div className="row">
            <span className="caption">{t('Nozzle Diameter')}</span>
            <input
              type="text"
              inputMode="decimal"
              list="create-nozzles"
              className="num"
              value={nozzle}
              onChange={(e) => setNozzle(e.target.value)}
              aria-label={t('Nozzle Diameter')}
              data-testid="create-nozzle"
            />
            <span className="muted">{t('mm')}</span>
            <datalist id="create-nozzles">
              {NOZZLES.map((n) => (
                <option key={n} value={n} />
              ))}
            </datalist>
          </div>
          {kind === 'printer' && (
            <>
              <div className="row">
                <span className="caption">{t('Printable Space')}</span>
                <input
                  type="text"
                  inputMode="decimal"
                  className="num"
                  value={size.x}
                  onChange={(e) => setSize({ ...size, x: e.target.value })}
                  aria-label="X"
                  data-testid="create-size-x"
                />
                <span className="muted">×</span>
                <input
                  type="text"
                  inputMode="decimal"
                  className="num"
                  value={size.y}
                  onChange={(e) => setSize({ ...size, y: e.target.value })}
                  aria-label="Y"
                  data-testid="create-size-y"
                />
                <span className="muted">{t('mm')}</span>
              </div>
              <div className="row">
                <span className="caption">{t('Origin')}</span>
                <input
                  type="text"
                  inputMode="decimal"
                  className="num"
                  value={origin.x}
                  onChange={(e) => setOrigin({ ...origin, x: e.target.value })}
                  aria-label="X"
                />
                <span className="muted">×</span>
                <input
                  type="text"
                  inputMode="decimal"
                  className="num"
                  value={origin.y}
                  onChange={(e) => setOrigin({ ...origin, y: e.target.value })}
                  aria-label="Y"
                />
                <span className="muted">{t('mm')}</span>
              </div>
              <div className="row">
                <span className="caption">{t('Max Print Height')}</span>
                <input
                  type="text"
                  inputMode="decimal"
                  className="num"
                  value={height}
                  onChange={(e) => setHeight(e.target.value)}
                  aria-label={t('Max Print Height')}
                  data-testid="create-height"
                />
                <span className="muted">{t('mm')}</span>
              </div>
            </>
          )}
        </div>
      )}

      {step === 2 && (
        <div className="create-form">
          {linked && variantModel && (linked.processes.length > 0 || linked.filaments.length > 0) && (
            <>
              <p className="muted">{t('The new variant uses these presets of {model} too.', { model: variantModel })}</p>
              <div className="create-templates">
                <TemplateList title={t('Print settings')} entries={linked.processes} testid="create-shared-processes" />
                <TemplateList title={t('Filaments')} entries={linked.filaments} testid="create-shared-filaments" />
              </div>
            </>
          )}
          <fieldset className="radios">
            <legend>{t('Presets')}</legend>
            <label>
              <input type="radio" checked={source === 'template'} onChange={() => setSource('template')} />
              {t('Create from Template')}
            </label>
            <label>
              <input type="radio" checked={source === 'current'} onChange={() => setSource('current')} disabled={!presets.state} />
              {t('Create Based on Current Printer')}
            </label>
          </fieldset>
          {source === 'template' ? (
            <div className="row">
              <span className="caption">{t('Printer Preset')}</span>
              <Select
                value={tplVendor}
                onChange={(v) => void pickVendor(v)}
                aria-label={t('Select Vendor')}
                data-testid="create-tpl-vendor"
                items={[{ value: '', label: t('Select Vendor') }, ...vendors.map((v) => ({ value: v.id, label: v.name }))]}
              />
              <Select
                value={tplModel}
                onChange={(v) => {
                  setTplModel(v);
                  setTplPrinter('');
                }}
                disabled={!tplModels.length}
                aria-label={t('Select Model')}
                data-testid="create-tpl-model"
                items={[{ value: '', label: t('Select Model') }, ...tplModels.map((m) => ({ value: m, label: m }))]}
              />
              <Select
                value={tplPrinter}
                onChange={setTplPrinter}
                disabled={!tplNozzles.length}
                aria-label={t('Nozzle Diameter')}
                data-testid="create-tpl-nozzle"
                items={[
                  { value: '', label: t('Nozzle Diameter') },
                  ...tplNozzles.map((p) => ({ value: p.name, label: `${p.variant} ${t('mm')}` })),
                ]}
              />
            </div>
          ) : (
            <p className="muted">{presets.state?.printer}</p>
          )}
          {templates && (
            <div className="create-templates">
              {/* All of them shared: nothing left to copy. */}
              {shownProcesses.length > 0 && (
                <TemplateList
                  title={t('Process Preset Template')}
                  entries={shownProcesses}
                  chosen={processes}
                  onToggle={(n) => toggle(processes, setProcesses, n)}
                  onAll={(on) => setProcesses(on ? new Set(shownProcesses.map((p) => p.name)) : new Set())}
                  testid="create-processes"
                />
              )}
              <TemplateList
                title={t('Filament Preset Template')}
                entries={shownFilaments}
                chosen={filaments}
                onToggle={(n) => toggle(filaments, setFilaments, n)}
                onAll={(on) =>
                  setFilaments(
                    on
                      ? new Set([...filaments, ...shownFilaments.map((f) => f.name)])
                      : new Set([...filaments].filter((n) => !shownFilaments.some((f) => f.name === n))),
                  )
                }
                testid="create-filaments"
                tools={
                  <label className="search">
                    <Search size={14} />
                    <input
                      type="search"
                      placeholder={t('Search filaments')}
                      aria-label={t('Search filaments')}
                      value={filter}
                      onChange={(e) => setFilter(e.target.value)}
                    />
                  </label>
                }
              />
            </div>
          )}
        </div>
      )}

      <div className="create-foot">
        {error && (
          <span className="wizard-hint" role="alert" data-testid="create-error">
            {error}
          </span>
        )}
        {busy && <span className="spinner" aria-label={t('Loading')} />}
        <button
          type="button"
          className="btn ghost"
          onClick={
            step === 1
              ? onCancel
              : () => {
                  setError(null);
                  setStep(1);
                }
          }
          disabled={busy}
        >
          {step === 1 ? t('Cancel') : t('Back')}
        </button>
        {step === 1 ? (
          <button type="button" className="btn primary" onClick={next} data-testid="create-next">
            {t('Next')}
          </button>
        ) : (
          <button type="button" className="btn primary" onClick={() => void create()} disabled={busy} data-testid="create-submit">
            {t('Create')}
          </button>
        )}
      </div>
    </div>
  );
}

function TemplateList({
  title,
  entries,
  chosen,
  onToggle,
  onAll,
  tools,
  testid,
}: {
  title: string;
  entries: PresetEntry[];
  /** Without: a list to read, not to choose from. */
  chosen?: Set<string>;
  onToggle?: (name: string) => void;
  onAll?: (on: boolean) => void;
  tools?: React.ReactNode;
  testid: string;
}) {
  return (
    <section className="template-list" data-testid={testid}>
      <div className="template-head">
        <h3>{title}</h3>
        {onAll && (
          <>
            <button type="button" className="link" onClick={() => onAll(true)}>
              {t('Select All')}
            </button>
            <button type="button" className="link" onClick={() => onAll(false)}>
              {t('Deselect All')}
            </button>
          </>
        )}
      </div>
      {tools}
      <ul>
        {entries.map((e) => (
          <li key={e.name}>
            {chosen ? (
              <label>
                <input type="checkbox" checked={chosen.has(e.name)} onChange={() => onToggle?.(e.name)} />
                <span>{e.name}</span>
              </label>
            ) : (
              <span>{e.name}</span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
