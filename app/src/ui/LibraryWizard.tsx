// The printer and filament wizard: pick printers (model + nozzle) and filaments for the pickers,
// like desktop OrcaSlicer's setup wizard, and import presets from other slicers.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Check, FileUp, FolderUp, Plus, Printer, Search, Spool, TriangleAlert, Upload, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { t, tr } from '../i18n/i18n';
import type { ConvertedPreset } from '../presets/convert/prusa';
import { filamentAlias, type Library, libraryVendors, type PrinterPick, samePick } from '../presets/library';
import { profilesManifest, type VendorInfo } from '../presets/profiles';
import { applySelection, importPresets, loadPresets, preferLibraryFilament, readNow, setLibrary } from '../state/actions';
import { notify, set, useApp } from '../state/store';
import { ask } from './Confirm';
import { CreateFilament } from './CreateFilament';
import { CreatePrinter } from './CreatePrinter';
import { describeError } from './errors';
import { discardEditsOk, replacePresetsOk } from './unsaved';
import { useModal } from './useModal';

type Page = 'printers' | 'filaments' | 'import';

/** Whether a name has every word of a search, in any order ("mk4 prusa"). */
const hasWords = (name: string, q: string) => {
  const n = name.toLowerCase();
  return q.split(/\s+/).every((w) => n.includes(w));
};

export function LibraryWizard({ page }: { page: Page }) {
  const library = useApp((s) => s.library);
  const presets = useApp((s) => s.presets);
  const [draft, setDraft] = useState<Library>(library);
  const [busy, setBusy] = useState(false);
  /** Why the wizard cannot be left yet, shown next to its buttons. */
  const [hint, setHint] = useState<string | null>(null);
  /** The Create Printer / Create Filament form is open (on its page). */
  const variantOf = useApp((s) => s.createVariant);
  const [creating, setCreating] = useState<null | 'printer' | 'filament'>(variantOf ? 'printer' : null);
  // Opened to add a variant: once, then the wizard as usual.
  useEffect(() => {
    if (variantOf) set({ createVariant: null });
  }, [variantOf]);
  useEffect(() => setHint(null), [draft.printers.length, page]);
  const [vendors, setVendors] = useState<VendorInfo[]>([]);
  useEffect(() => {
    profilesManifest()
      .then((m) => setVendors(m.vendors.filter((v) => v.models.length).sort((a, b) => a.name.localeCompare(b.name))))
      .catch(() => {});
  }, []);
  const go = (p: Page | null) => set({ wizard: p });

  const modal = useModal<HTMLDivElement>();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) {
        if (creating) setCreating(null);
        else void leave(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  /** Apply the draft, then go to another page (or close). */
  const leave = async (next: Page | null) => {
    const printersChanged = JSON.stringify(draft.printers) !== JSON.stringify(library.printers);
    const filamentsChanged = JSON.stringify(draft.filaments) !== JSON.stringify(library.filaments);
    if (!printersChanged && !filamentsChanged) {
      go(next);
      return;
    }
    // Your own (imported) printer presets count too.
    const hasPrinter = draft.printers.length > 0 || useApp.getState().presets.printers.some((e) => e.user);
    if (!hasPrinter) {
      // Closing without a printer drops the changes; the filaments page needs a printer to fit.
      if (next === null) {
        setDraft(library);
        go(null);
        return;
      }
      if (next === 'filaments') {
        setHint(t('Pick at least one printer.'));
        return;
      }
      go(next);
      return;
    }
    const newVendors = libraryVendors(draft).filter((v) => !presets.loadedVendors.includes(v));
    const st = presets.state;
    const lost = st
      ? (['printer', 'print', 'filament'] as const)
          .filter((k) => st.dirty?.[k])
          .map((k) => (k === 'printer' ? st.printer : k === 'print' ? st.process : st.filaments[0]))
      : [];
    // Loading another vendor's profiles rebuilds the presets, which drops unsaved edits.
    if (
      newVendors.length &&
      lost.length &&
      !(await ask(t('Discard unsaved changes to {names}?', { names: lost.join(', ') }), { confirm: t('Discard') }))
    )
      return;
    setBusy(true);
    try {
      // Newly added printer models bring their default filaments, as on desktop.
      const added = draft.printers.filter((p) => !library.printers.some((q) => samePick(p, q)));
      const materials = added.flatMap(
        (p) => vendors.find((v) => v.id === p.vendor)?.models.find((m) => m.name === p.model)?.materials ?? [],
      );
      const lib = { ...draft, filaments: [...new Set([...draft.filaments, ...(filamentsChanged ? [] : materials)])] };
      setLibrary(lib);
      setDraft(lib);
      // Switch to the first printer just added, as desktop does after its wizard.
      const first = added[0];
      const entry =
        first &&
        useApp
          .getState()
          .presets.printers.find(
            (e) => !e.user && e.vendor === first.vendor && e.model === first.model && Number(e.variant) === Number(first.nozzle),
          );
      await loadPresets(lib, entry ? { printer: entry.name } : undefined);
      if (first && !entry) {
        const e = useApp
          .getState()
          .presets.printers.find(
            (x) => !x.user && x.vendor === first.vendor && x.model === first.model && Number(x.variant) === Number(first.nozzle),
          );
        if (e) await loadPresets(lib, { printer: e.name });
      }
      await preferLibraryFilament();
      go(next);
    } catch (e) {
      notify({ kind: 'error', ...describeError(e) });
    } finally {
      setBusy(false);
    }
  };

  const nav: [Page, string, React.ReactNode, string][] = [
    ['printers', t('Printers'), <Printer size={16} key="p" />, String(draft.printers.length)],
    ['filaments', t('Filaments'), <Spool size={16} key="f" />, String(draft.filaments.length)],
    ['import', t('Import'), <Upload size={16} key="i" />, ''],
  ];
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) void leave(null);
      }}
    >
      <div className="modal wizard" role="dialog" ref={modal} aria-modal="true" aria-labelledby="wizard-title" data-testid="wizard">
        <div className="wizard-head">
          <h2 id="wizard-title">{t('Printers and filaments')}</h2>
          <button type="button" className="icon-btn" aria-label={t('Close')} onClick={() => void leave(null)} disabled={busy}>
            <X size={18} />
          </button>
        </div>
        <div className="wizard-body">
          <nav className="wizard-nav" aria-label={t('Printers and filaments')}>
            {nav.map(([p, label, icon, count]) => (
              <button
                key={p}
                aria-current={page === p}
                onClick={() => {
                  setCreating(null);
                  void leave(p);
                }}
                disabled={busy}
              >
                {icon}
                <span>{label}</span>
                {count && <span className="count">{count}</span>}
              </button>
            ))}
          </nav>
          <div className="wizard-page">
            {page === 'printers' && creating === 'printer' && (
              <CreatePrinter
                vendors={vendors}
                variantOf={variantOf}
                onCancel={() => setCreating(null)}
                onCreated={() => {
                  setCreating(null);
                  void leave(null);
                }}
              />
            )}
            {page === 'printers' && creating !== 'printer' && (
              <PrintersPage
                vendors={vendors}
                picks={draft.printers}
                onChange={(printers) => setDraft({ ...draft, printers })}
                onCreate={() => setCreating('printer')}
              />
            )}
            {page === 'filaments' && creating === 'filament' && (
              <CreateFilament
                onCancel={() => setCreating(null)}
                onCreated={(names) => {
                  // As desktop: the dialog closes. The new filament is used when it fits the selected printer.
                  setCreating(null);
                  const mine = names.find((n) => n.endsWith(` @${presets.state?.printer}`));
                  void leave(null).then(async () => {
                    const st = useApp.getState().presets.state;
                    if (mine && st) await applySelection({ printer: st.printer, process: st.process, filaments: [mine] });
                    notify({ kind: 'info', title: t('Create Filament'), message: names.join(', ') });
                  });
                }}
              />
            )}
            {page === 'filaments' && creating !== 'filament' && (
              <FilamentsPage
                chosen={draft.filaments}
                onChange={(filaments) => setDraft({ ...draft, filaments })}
                onCreate={() => setCreating('filament')}
              />
            )}
            {page === 'import' && <ImportPage />}
          </div>
        </div>
        {!((creating === 'printer' && page === 'printers') || (creating === 'filament' && page === 'filaments')) && (
          <div className="wizard-foot">
            {busy && <span className="spinner" aria-label={t('Loading')} />}
            {hint && (
              <span className="wizard-hint" role="alert" data-testid="wizard-hint">
                <TriangleAlert size={15} />
                {hint}
              </span>
            )}
            {page === 'printers' && (
              <button className="btn primary" onClick={() => void leave('filaments')} disabled={busy} data-testid="wizard-next">
                {t('Next: filaments')}
              </button>
            )}
            {page !== 'printers' && (
              <button className="btn primary" onClick={() => void leave(null)} disabled={busy} data-testid="wizard-done">
                {t('Done')}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Printers ─────────────────────────────────────────────────────────────────────────────
function PrintersPage({
  vendors,
  picks,
  onChange,
  onCreate,
}: {
  vendors: VendorInfo[];
  picks: PrinterPick[];
  onChange: (p: PrinterPick[]) => void;
  onCreate: () => void;
}) {
  // The user's own printers (made here, imported or saved): always listed, edited in Settings.
  const mine = useApp((s) => s.presets.printers).filter((p) => p.user);
  const [query, setQuery] = useState('');
  const [vendor, setVendor] = useState<string | null>(null);
  const q = query.trim().toLowerCase();
  const shown = useMemo(() => {
    if (q)
      return vendors.map((v) => ({ v, models: v.models.filter((m) => hasWords(`${v.name} ${m.name}`, q)) })).filter((x) => x.models.length);
    if (vendor) return vendors.filter((v) => v.id === vendor).map((v) => ({ v, models: v.models }));
    // "Your printers": the vendors and models already picked.
    return vendors
      .map((v) => ({ v, models: v.models.filter((m) => picks.some((p) => p.vendor === v.id && p.model === m.name)) }))
      .filter((x) => x.models.length);
  }, [q, vendor, vendors, picks]);
  const has = (p: PrinterPick) => picks.some((x) => samePick(x, p));
  const toggle = (p: PrinterPick) => onChange(has(p) ? picks.filter((x) => !samePick(x, p)) : [...picks, p]);
  const count = (id: string) => picks.filter((p) => p.vendor === id).length;
  return (
    <div className="wizard-printers">
      <label className="search">
        <Search size={15} />
        <input
          type="search"
          placeholder={t('Search printers')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label={t('Search printers')}
          data-testid="wizard-search"
        />
      </label>
      <div className="wizard-split">
        <ul className="wizard-vendors">
          <li>
            <button
              aria-current={!q && vendor === null}
              onClick={() => {
                setQuery('');
                setVendor(null);
              }}
            >
              <span>{t('Your printers')}</span>
              <span className="count">{picks.length + mine.length}</span>
            </button>
          </li>
          <li>
            <button className="create" onClick={onCreate} data-testid="wizard-create-printer">
              <Plus size={15} />
              <span>{t('Create Printer')}</span>
            </button>
          </li>
          {vendors.map((v) => (
            <li key={v.id}>
              <button
                aria-current={!q && vendor === v.id}
                onClick={() => {
                  setQuery('');
                  setVendor(v.id);
                }}
              >
                <span>{v.name}</span>
                {count(v.id) > 0 && <span className="count">{count(v.id)}</span>}
              </button>
            </li>
          ))}
        </ul>
        <div className="wizard-models">
          {!q && vendor === 'Custom' && (
            <div className="wizard-create-card">
              <div>
                <strong>{t('Create Printer')}</strong>
                <p className="muted small">{t('Your own printer, not based on another one.')}</p>
              </div>
              <button type="button" className="btn primary" onClick={onCreate}>
                <Plus size={15} />
                {t('Create Printer')}
              </button>
            </div>
          )}
          {!q && vendor === null && mine.length > 0 && (
            <section data-testid="wizard-my-printers">
              <h3>{t('My presets')}</h3>
              {mine.map((p) => (
                <div key={p.name} className="wizard-model on" data-model={p.name}>
                  <span className="name">{p.name}</span>
                  <span className="muted small">{p.inherits ? t('Based on {name}', { name: p.inherits }) : t('Custom printer')}</span>
                </div>
              ))}
            </section>
          )}
          {!shown.length && !(vendor === null && mine.length) && vendor !== 'Custom' && (
            <p className="muted">{q ? t('No printers found.') : t('No printers yet. Pick a brand on the left or search.')}</p>
          )}
          {shown.map(({ v, models }) => (
            <section key={v.id}>
              {(q || vendor === null) && <h3>{v.name}</h3>}
              {models.map((m) => (
                <div
                  key={m.name}
                  className={`wizard-model${m.nozzles.some((n) => has({ vendor: v.id, model: m.name, nozzle: n })) ? ' on' : ''}`}
                  data-model={m.name}
                >
                  <span className="name">{m.name}</span>
                  <span className="nozzles" role="group" aria-label={t('Nozzle diameters for {model}', { model: m.name })}>
                    {m.nozzles.map((n) => {
                      const p = { vendor: v.id, model: m.name, nozzle: n };
                      return (
                        <button
                          key={n}
                          type="button"
                          className={`chip${has(p) ? ' on' : ''}`}
                          aria-pressed={has(p)}
                          onClick={() => toggle(p)}
                        >
                          {has(p) && <Check size={12} />}
                          {n} mm
                        </button>
                      );
                    })}
                  </span>
                </div>
              ))}
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Filaments ────────────────────────────────────────────────────────────────────────────
function FilamentsPage({ chosen, onChange, onCreate }: { chosen: string[]; onChange: (f: string[]) => void; onCreate: () => void }) {
  const state = useApp((s) => s.presets.state);
  const [query, setQuery] = useState('');
  const [type, setType] = useState<string | null>(null);
  // One row per filament name; system presets only (the user's own always show).
  const rows = useMemo(() => {
    const m = new Map<string, { alias: string; vendor: string; type: string }>();
    for (const f of state?.filament_presets ?? []) {
      if (f.user) continue;
      const alias = filamentAlias(f);
      if (!m.has(alias)) m.set(alias, { alias, vendor: f.filament_vendor || t('Other'), type: f.filament_type ?? '' });
    }
    return [...m.values()];
  }, [state]);
  const types = useMemo(() => [...new Set(rows.map((r) => r.type).filter(Boolean))].sort(), [rows]);
  const q = query.trim().toLowerCase();
  const shown = rows.filter((r) => (!type || r.type === type) && (!q || hasWords(`${r.alias} ${r.vendor} ${r.type}`, q)));
  const byVendor = new Map<string, typeof rows>();
  for (const r of shown) byVendor.set(r.vendor, [...(byVendor.get(r.vendor) ?? []), r]);
  const groups = [...byVendor.entries()].sort(([a], [b]) => (a === 'Generic' ? -1 : b === 'Generic' ? 1 : a.localeCompare(b)));
  const toggle = (alias: string) => onChange(chosen.includes(alias) ? chosen.filter((x) => x !== alias) : [...chosen, alias]);
  return (
    <div className="wizard-filaments">
      <div className="wizard-intro">
        <p className="muted small">
          {t('Filaments that fit {printer}. What you pick here shows for all your printers it fits.', { printer: state?.printer ?? '' })}
        </p>
        <button type="button" className="btn" onClick={onCreate} data-testid="wizard-create-filament">
          <Plus size={15} />
          {t('Create Filament')}
        </button>
      </div>
      <div className="wizard-tools">
        <label className="search">
          <Search size={15} />
          <input
            type="search"
            placeholder={t('Search filaments')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label={t('Search filaments')}
            data-testid="wizard-filament-search"
          />
        </label>
        <div className="chips">
          <button type="button" className={`chip${type === null ? ' on' : ''}`} onClick={() => setType(null)}>
            {t('All')}
          </button>
          {types.map((ty) => (
            <button key={ty} type="button" className={`chip${type === ty ? ' on' : ''}`} onClick={() => setType(ty === type ? null : ty)}>
              {ty}
            </button>
          ))}
        </div>
      </div>
      <div className="wizard-filament-list">
        {groups.map(([vendor, list]) => (
          <section key={vendor}>
            <h3>{vendor}</h3>
            <ul>
              {list.map((r) => (
                <li key={r.alias}>
                  <label>
                    <input type="checkbox" checked={chosen.includes(r.alias)} onChange={() => toggle(r.alias)} />
                    <span>{r.alias}</span>
                    {r.type && <span className="tag">{r.type}</span>}
                  </label>
                </li>
              ))}
            </ul>
          </section>
        ))}
        {!groups.length && <p className="muted">{t('No filaments found.')}</p>}
      </div>
    </div>
  );
}

// ── Import ───────────────────────────────────────────────────────────────────────────────
const ACCEPT = '.json,.orca_printer,.orca_filament,.orca_bundle,.zip,.ini,.gcode';

/** From a chosen folder: preset files only, not desktop's caches, system profiles or snapshots. */
function presetFiles(list: File[]): File[] {
  return list.filter((f) => {
    const path = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
    if (/(^|\/)(vendor|cache|snapshots|system|physical_printer|sla_print|sla_material|shapes|log)\//i.test(path)) return false;
    return /\.(json|orca_printer|orca_filament|orca_bundle|zip|ini|gcode)$/i.test(f.name);
  });
}

function ImportPage() {
  const files = useRef<HTMLInputElement>(null);
  const folder = useRef<HTMLInputElement>(null);
  const [result, setResult] = useState<{ names: string[]; converted: ConvertedPreset[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (list: File[]) => {
    const picked = presetFiles(list);
    if (!picked.length) {
      setResult({ names: [], converted: [] });
      return;
    }
    setBusy(true);
    try {
      const { imported, converted, canceled } = await importPresets(readNow(picked), discardEditsOk, replacePresetsOk);
      if (canceled) return;
      setResult({ names: imported.map((i) => i.name), converted: converted.filter((c) => imported.some((i) => i.name === c.name)) });
    } catch (e) {
      notify({ kind: 'error', ...describeError(e) });
    } finally {
      setBusy(false);
    }
  };
  const buttons = (
    <div className="prefs-row">
      <button className="btn" onClick={() => files.current?.click()} disabled={busy} data-testid="wizard-import-files">
        <FileUp size={15} />
        {t('Choose files…')}
      </button>
      <button className="btn" onClick={() => folder.current?.click()} disabled={busy}>
        <FolderUp size={15} />
        {t('Choose a folder…')}
      </button>
    </div>
  );
  return (
    <div className="wizard-import">
      <p className="muted small">
        {t('Bring your own presets from another slicer. They show up next to the printers and filaments you added.')}
      </p>
      <input
        ref={files}
        type="file"
        hidden
        multiple
        accept={ACCEPT}
        data-testid="wizard-import-input"
        onChange={(e) => {
          void run([...(e.target.files ?? [])]);
          e.target.value = '';
        }}
      />
      <input
        ref={folder}
        type="file"
        hidden
        {...{ webkitdirectory: '' }}
        onChange={(e) => {
          void run([...(e.target.files ?? [])]);
          e.target.value = '';
        }}
      />
      {busy && (
        <p className="small muted">
          <span className="spinner" /> {t('Importing…')}
        </p>
      )}
      {result && <ImportReport names={result.names} converted={result.converted} />}

      <section className="import-card">
        <h3>OrcaSlicer</h3>
        <ol className="small">
          <li>{t('In OrcaSlicer, choose File → Export → Export Preset Bundle… and save the bundle.')}</li>
          <li>{t('Or use the preset files themselves: the folder {folder} in OrcaSlicer’s data folder.', { folder: 'user/default' })}</li>
        </ol>
        <Paths app="OrcaSlicer" sub="user/default" />
        {buttons}
      </section>

      <section className="import-card">
        <h3>Bambu Studio</h3>
        <ol className="small">
          <li>
            {t('Bambu Studio keeps your presets as files in its data folder, under {folder} (your account number, or “default”).', {
              folder: 'user/<…>',
            })}
          </li>
          <li>{t('Choose that folder, or the files from its machine, filament and process folders.')}</li>
        </ol>
        <Paths app="BambuStudio" sub="user" />
        {buttons}
      </section>

      <section className="import-card">
        <h3>PrusaSlicer, SuperSlicer</h3>
        <ol className="small">
          <li>{t('Choose File → Export → Export Config Bundle… to export all your presets, or Export Config… for the ones in use.')}</li>
          <li>{t('Or choose the slicer’s data folder, or a G-code file sliced with it: it contains the settings used.')}</li>
        </ol>
        <Paths app="PrusaSlicer" sub="" alt="SuperSlicer" />
        <p className="small muted">
          {t('The settings are converted to OrcaSlicer’s. Those that have no exact equivalent are listed after the import.')}
        </p>
        {buttons}
      </section>

      <section className="import-card muted-card">
        <h3>Cura</h3>
        <p className="small">
          {t(
            'Cura’s settings work differently and cannot be converted. Add the same printer under Printers, then copy over the settings you changed.',
          )}
        </p>
      </section>
    </div>
  );
}

/** What was imported, and for converted presets, what did not carry over exactly. */
function ImportReport({ names, converted }: { names: string[]; converted: ConvertedPreset[] }) {
  if (!names.length)
    return (
      <p className="small warning" role="status" data-testid="wizard-import-result">
        {t('No presets found in these files.')}
      </p>
    );
  const kindLabel = { print: t('Print settings'), filament: t('Filament'), printer: t('Printer') };
  return (
    <div className="import-report" role="status" data-testid="wizard-import-result">
      <p className="small">{t('Imported: {names}', { names: names.join(', ') })}</p>
      {converted.map((c) => {
        const approx = c.notes.filter((n) => n.kind === 'approx'),
          dropped = c.notes.filter((n) => n.kind === 'dropped');
        return (
          <details key={`${c.kind}:${c.name}`} className="import-converted" open={converted.length === 1} data-testid="wizard-converted">
            <summary>
              <span className="tag">{kindLabel[c.kind]}</span> <strong>{c.name}</strong>
              <span className="muted small"> · {t('converted from {app}', { app: c.app })}</span>
              {c.notes.length > 0 ? (
                <span className="warning small">
                  {' '}
                  · <TriangleAlert size={13} />{' '}
                  {c.notes.length === 1 ? t('{n} setting to check', { n: 1 }) : t('{n} settings to check', { n: c.notes.length })}
                </span>
              ) : (
                <span className="small ok">
                  {' '}
                  · <Check size={13} /> {t('All settings carried over')}
                </span>
              )}
            </summary>
            {approx.length > 0 && (
              <>
                <h4>{t('Converted, but not exactly the same')}</h4>
                <ul>
                  {approx.map((n, i) => (
                    <li key={i}>
                      <strong>{tr(n.label)}</strong>: {t(n.message, n.vars)}
                    </li>
                  ))}
                </ul>
              </>
            )}
            {dropped.length > 0 && (
              <>
                <h4>{t('Not carried over')}</h4>
                <ul>
                  {dropped.map((n, i) => (
                    <li key={i}>
                      <strong>{tr(n.label)}</strong>: {t(n.message, n.vars)}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </details>
        );
      })}
    </div>
  );
}

function Paths({ app, sub, alt }: { app: string; sub: string; alt?: string }) {
  const apps = alt ? [app, alt] : [app];
  const join = (sep: string, ...parts: string[]) => parts.filter(Boolean).join(sep);
  const list = (f: (a: string) => string) => apps.flatMap((a, i) => [...(i ? [<br key={i} />] : []), <code key={a}>{f(a)}</code>]);
  return (
    <dl className="import-paths small">
      <dt>Windows</dt>
      <dd>{list((a) => join('\\', '%APPDATA%', a, sub.replace(/\//g, '\\')))}</dd>
      <dt>macOS</dt>
      <dd>{list((a) => join('/', '~/Library/Application Support', a, sub))}</dd>
      <dt>Linux</dt>
      <dd>{list((a) => join('/', '~/.config', a, sub))}</dd>
    </dl>
  );
}
