// Printers: the list with live status and print controls, the add/edit form, and sending G-code.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Pause, Pencil, Play, Plus, Send, Square, Trash2, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { N_, t } from '../i18n/i18n';
import type { PrinterConfig, PrinterKind, PrinterStatus, PrintState } from '../printers/connectors';
import { type LanPermission, lanPermission, normalizeUrl } from '../printers/net';
import {
  defaultFileName,
  printerCommand,
  printerFits,
  removePrinter,
  savePrinter,
  sendToPrinter,
  testPrinter,
  watchPrinters,
} from '../state/printerActions';
import { useApp } from '../state/store';
import { usePrinterChoices } from './CompatiblePrinters';
import { ask } from './Confirm';
import { formatDuration } from './format';
import { SegmentThumb } from './SegmentThumb';
import { Select } from './Select';
import { useModal } from './useModal';

function useEscape(onClose: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
}

const STATE_LABEL: Record<PrintState, string> = {
  ready: N_('Ready'),
  printing: N_('Printing'),
  paused: N_('Paused'),
  done: N_('Finished'),
  cancelled: N_('Canceled'),
  error: N_('Error'),
  busy: N_('Busy'),
  offline: N_('Offline'),
};

export function PrintersDialog({ onClose }: { onClose: () => void }) {
  const list = useApp((s) => s.printers.list);
  const [editing, setEditing] = useState<PrinterConfig | 'new' | null>(list.length ? null : 'new');
  useEffect(() => watchPrinters(), []);
  useEscape(onClose);
  const modal = useModal<HTMLDivElement>();
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal printers"
        role="dialog"
        ref={modal}
        aria-modal="true"
        aria-labelledby="printers-title"
        onClick={(e) => e.stopPropagation()}
        data-testid="printers"
      >
        <div className="wizard-head">
          <h2 id="printers-title">{editing === 'new' ? t('Add printer') : editing ? t('Edit printer') : t('Printers')}</h2>
          <button className="icon-btn" aria-label={t('Close')} onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        {editing ? (
          <PrinterForm
            printer={editing === 'new' ? undefined : editing}
            onDone={() => setEditing(null)}
            onCancel={list.length ? () => setEditing(null) : onClose}
          />
        ) : (
          <>
            <ul className="printer-list" data-testid="printer-list">
              {list.map((p) => (
                <PrinterRow key={p.id} p={p} onEdit={() => setEditing(p)} />
              ))}
            </ul>
            <div className="create-foot">
              <button className="btn" onClick={() => setEditing('new')} data-testid="printer-add">
                <Plus size={15} />
                {t('Add printer')}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function PrinterRow({ p, onEdit }: { p: PrinterConfig; onEdit: () => void }) {
  const st = useApp((s) => s.printers.status[p.id]);
  const status = st && !('error' in st) ? st : null;
  const active = status?.state === 'printing' || status?.state === 'paused';
  return (
    <li className="printer-row" data-testid="printer-row" data-state={status?.state ?? (st ? 'unreachable' : 'unknown')}>
      <div className="printer-row-head">
        <div className="printer-title">
          <strong>{p.name}</strong>
          <span className="muted small">
            {p.kind === 'octoprint' ? 'OctoPrint' : 'Klipper'} · {p.url.replace(/^https?:\/\//, '')}
          </span>
        </div>
        {st && (
          <span className={`state-badge ${status?.state ?? 'error'}`} data-testid="printer-state">
            {status ? t(STATE_LABEL[status.state]) : t('Unreachable')}
          </span>
        )}
        <button
          className="icon-btn small"
          onClick={onEdit}
          aria-label={t('Edit {name}', { name: p.name })}
          data-tip={t('Edit')}
          data-testid="printer-edit"
        >
          <Pencil size={14} />
        </button>
        <button
          className="icon-btn small"
          aria-label={t('Delete {name}', { name: p.name })}
          data-tip={t('Delete')}
          data-testid="printer-remove"
          onClick={async () => {
            if (await ask(t('Remove {name} from the printers?', { name: p.name }), { confirm: t('Remove'), danger: true }))
              removePrinter(p.id);
          }}
        >
          <Trash2 size={14} />
        </button>
      </div>
      {st && 'error' in st && (
        <p className="small error" data-testid="printer-error">
          {st.error}
        </p>
      )}
      {status && <StatusLine s={status} />}
      {active && (
        <div className="printer-controls">
          {status.state === 'printing' ? (
            <button className="btn small" onClick={() => void printerCommand(p.id, 'pause')} data-testid="printer-pause">
              <Pause size={14} />
              {t('Pause')}
            </button>
          ) : (
            <button className="btn small" onClick={() => void printerCommand(p.id, 'resume')} data-testid="printer-resume">
              <Play size={14} />
              {t('Resume')}
            </button>
          )}
          <button
            className="btn small danger"
            data-testid="printer-cancel"
            onClick={async () => {
              if (await ask(t('Stop printing {file}?', { file: status.file ?? '' }), { confirm: t('Stop'), danger: true }))
                void printerCommand(p.id, 'cancel');
            }}
          >
            <Square size={13} />
            {t('Stop')}
          </button>
        </div>
      )}
    </li>
  );
}

function StatusLine({ s }: { s: PrinterStatus }) {
  const pct = s.progress !== undefined ? Math.round(s.progress * 100) : null;
  return (
    <div className="printer-status small">
      {s.message && s.state !== 'printing' && s.state !== 'paused' && s.state !== 'done' && <div className="muted">{s.message}</div>}
      {s.file && (
        <div className="printer-job">
          <span className="printer-file" data-tip={s.file}>
            {s.file}
          </span>
          {pct !== null && (
            <span className="pct" data-testid="printer-progress">
              {pct}%
            </span>
          )}
        </div>
      )}
      {pct !== null && (s.state === 'printing' || s.state === 'paused') && (
        <div className="bar">
          <div style={{ width: `${pct}%` }} />
        </div>
      )}
      <div className="muted printer-facts">
        {s.temps.map((x) => (
          <span key={x.name}>
            {x.name === 'nozzle' ? t('Nozzle') : t('Bed')} {Math.round(x.actual)}°{x.target ? ` / ${Math.round(x.target)}°` : ''}
          </span>
        ))}
        {s.elapsed !== undefined && s.state === 'printing' && <span>{formatDuration(s.elapsed)}</span>}
        {s.remaining !== undefined && <span>{t('{time} left', { time: formatDuration(s.remaining) })}</span>}
      </div>
    </div>
  );
}

const PI_BUILD = import.meta.env.VITE_TARGET === 'pi';

export function PrinterForm({
  printer,
  preset,
  onDone,
  onCancel,
}: {
  printer?: PrinterConfig /** The printer preset a new printer starts with (else the one in use). */;
  preset?: string | null;
  onDone: (p: PrinterConfig) => void;
  onCancel: () => void;
}) {
  // The Pi build is usually served by the printer's own web server, next to Moonraker.
  const [name, setName] = useState(printer?.name ?? '');
  const [kind, setKind] = useState<PrinterKind>(printer?.kind ?? 'moonraker');
  const [url, setUrl] = useState(printer?.url ?? (PI_BUILD ? location.origin : ''));
  const [apiKey, setApiKey] = useState(printer?.apiKey ?? '');
  // The printer profiles G-code for it is sliced with; a new one starts with the one in use.
  const current = useApp((s) => s.presets.state?.printer);
  const [presets, setPresets] = useState<string[]>(() => printer?.presets ?? [preset ?? current].filter((n): n is string => !!n));
  const profiles = usePrinterChoices(presets);
  const [sync, setSync] = useState(printer?.sync ?? false);
  const drive = useApp((s) => !!s.drive.email);
  // Self-hosted with a storage folder: printers sync there instead.
  const server = useApp((s) => !!s.drive.server);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [lan, setLan] = useState<LanPermission>('unsupported');
  useEffect(() => {
    void lanPermission().then(setLan);
  }, []);
  useEffect(() => setResult(null), [kind, url, apiKey, presets]);

  const config = (): PrinterConfig | null => {
    if (!url.trim()) {
      setResult({ ok: false, text: t('Enter the printer’s address.') });
      return null;
    }
    let u: string;
    try {
      u = normalizeUrl(url);
    } catch {
      setResult({ ok: false, text: t('Enter the printer’s address.') });
      return null;
    }
    if (kind === 'octoprint' && !apiKey.trim()) {
      setResult({ ok: false, text: t('OctoPrint needs an API key.') });
      return null;
    }
    if (!presets.length) {
      setResult({ ok: false, text: t('Choose at least one printer preset.') });
      return null;
    }
    const host = new URL(u).hostname;
    return {
      id: printer?.id ?? '',
      name: name.trim() || host,
      kind,
      url: u,
      ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      presets,
      ...(sync ? { sync } : {}),
    };
  };
  // Saving doesn't need the printer to answer (it may be off); Test connection checks it.
  const test = async () => {
    const c = config();
    if (!c) return;
    setBusy(true);
    const r = await testPrinter(c);
    setBusy(false);
    setResult(
      r.ok
        ? { ok: true, text: t('Connected to {server} {version}', { server: r.info.server, version: r.info.version }) }
        : { ok: false, text: r.message },
    );
  };
  const saveIt = () => {
    const c = config();
    if (c) onDone(savePrinter({ ...c, id: printer?.id }));
  };
  const origin = location.origin;
  return (
    <form
      className="printer-form"
      onSubmit={(e) => {
        e.preventDefault();
        saveIt();
      }}
      data-testid="printer-form"
    >
      <div className="prefs-grid">
        <span className="caption" id="printer-kind">
          {t('Type')}
        </span>
        <div className="segmented" role="radiogroup" aria-labelledby="printer-kind">
          <SegmentThumb />
          {(
            [
              ['moonraker', t('Klipper (Moonraker)')],
              ['octoprint', 'OctoPrint'],
            ] as const
          ).map(([v, label]) => (
            <button
              type="button"
              key={v}
              role="radio"
              aria-checked={kind === v}
              aria-selected={kind === v}
              onClick={() => setKind(v)}
              data-testid={`printer-kind-${v}`}
            >
              {label}
            </button>
          ))}
        </div>
        <label className="caption" htmlFor="printer-url">
          {t('Address')}
        </label>
        <input
          type="text"
          id="printer-url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="192.168.1.50"
          autoFocus={!printer}
          data-testid="printer-url"
        />
        <label className="caption" htmlFor="printer-key">
          {t('API key')}
        </label>
        <input
          type="text"
          id="printer-key"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          placeholder={kind === 'octoprint' ? t('Required') : t('Optional')}
          data-testid="printer-key"
        />
        <label className="caption" htmlFor="printer-name">
          {t('Name')}
        </label>
        <input
          type="text"
          id="printer-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('Optional')}
          data-testid="printer-name"
        />
        <span className="caption top" id="printer-presets">
          {t('Printer presets')}
        </span>
        <ul className="printer-checks" aria-labelledby="printer-presets" data-testid="printer-presets">
          {profiles.map((n) => (
            <li key={n}>
              <label>
                <input
                  type="checkbox"
                  checked={presets.includes(n)}
                  onChange={(e) => setPresets((l) => (e.target.checked ? [...l, n] : l.filter((x) => x !== n)))}
                />
                <span>{n}</span>
              </label>
            </li>
          ))}
        </ul>
        {(drive || server || printer?.sync) && (
          <>
            <span />
            <div>
              <label className="switch-label">
                <input
                  type="checkbox"
                  className="switch"
                  checked={sync}
                  onChange={(e) => setSync(e.target.checked)}
                  data-testid="printer-sync"
                />
                {server ? t('Sync with server storage') : t('Sync with Google Drive')}
              </label>
              {sync && apiKey.trim() && (
                <p className="hint small muted" data-testid="printer-sync-key">
                  {server ? t('The API key is stored on the server too.') : t('The API key is stored in Google Drive too.')}
                </p>
              )}
            </div>
          </>
        )}
      </div>
      <details className="printer-help">
        <summary>{t('Setup notes')}</summary>
        {kind === 'moonraker' ? (
          <>
            <p>{t('Allow this site in moonraker.conf, then restart Moonraker:')}</p>
            <pre>{`[authorization]\ncors_domains:\n    ${origin}`}</pre>
            <p>{t('The address is the one you open Mainsail or Fluidd with, or the printer’s IP address with port 7125.')}</p>
          </>
        ) : (
          <p>
            {t(
              'In OctoPrint, turn on Settings › API › Allow Cross Origin Resource Sharing (CORS) and restart it. Create the API key under Settings › Application Keys.',
            )}
          </p>
        )}
        {location.protocol === 'https:' &&
          (lan === 'unsupported' ? (
            <p>
              {t(
                'This browser can’t reach http:// printers from this https:// page. Use Chrome or Edge, or run DolphinSlicer on your printer.',
              )}
            </p>
          ) : (
            <p>{t('Chrome asks to let this site reach devices on your local network. Allow it.')}</p>
          ))}
      </details>
      {result && (
        <p className={`small ${result.ok ? 'ok' : 'error'}`} role={result.ok ? 'status' : 'alert'} data-testid="printer-result">
          {result.text}
        </p>
      )}
      <div className="create-foot">
        {busy && <span className="spinner" />}
        <button type="button" className="btn ghost" onClick={onCancel} disabled={busy}>
          {t('Cancel')}
        </button>
        <button type="button" className="btn" onClick={() => void test()} disabled={busy} data-testid="printer-test">
          {t('Test connection')}
        </button>
        <button type="submit" className="btn primary" disabled={busy} data-testid="printer-save">
          {t('Save')}
        </button>
      </div>
    </form>
  );
}

export function SendDialog({ onClose }: { onClose: () => void }) {
  const list = useApp((s) => s.printers.list);
  const last = useApp((s) => s.printers.last);
  const sending = useApp((s) => s.printers.sending);
  // Only the printers the G-code was sliced for (desktop: the physical printer's presets).
  const preset = useApp((s) => s.gcodePrinter);
  const fits = list.filter((p) => printerFits(p, preset));
  const [adding, setAdding] = useState(!list.length);
  const [picked, setId] = useState(fits.find((p) => p.id === last)?.id ?? fits[0]?.id ?? '');
  const id = fits.some((p) => p.id === picked) ? picked : (fits[0]?.id ?? '');
  const [file, setFile] = useState(defaultFileName);
  const [start, setStart] = useState(true);
  const [ctrl, setCtrl] = useState<AbortController | null>(null);
  useEscape(onClose);
  const modal = useModal<HTMLDivElement>();
  const send = async () => {
    const c = new AbortController();
    setCtrl(c);
    const ok = await sendToPrinter(id, file.trim() || defaultFileName(), start, c.signal);
    setCtrl(null);
    if (ok) onClose();
  };
  return (
    <div className="modal-backdrop" onClick={sending ? undefined : onClose}>
      <div
        className="modal printers"
        role="dialog"
        ref={modal}
        aria-modal="true"
        aria-labelledby="send-title"
        onClick={(e) => e.stopPropagation()}
        data-testid="send-dialog"
      >
        <div className="wizard-head">
          <h2 id="send-title">{adding ? t('Add printer') : t('Send to printer')}</h2>
          <button
            className="icon-btn"
            aria-label={t('Close')}
            onClick={() => {
              ctrl?.abort();
              onClose();
            }}
          >
            <X size={18} />
          </button>
        </div>
        {adding ? (
          <PrinterForm
            preset={preset}
            onDone={(p) => {
              setId(p.id);
              setAdding(false);
            }}
            onCancel={list.length ? () => setAdding(false) : onClose}
          />
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
          >
            <div className="prefs-grid">
              <label className="caption" htmlFor="send-printer">
                {t('Printer')}
              </label>
              <div className="send-printer">
                <Select
                  id="send-printer"
                  value={id}
                  onChange={setId}
                  data-testid="send-printer"
                  items={list.map((p) => ({ value: p.id, label: p.name, disabled: !printerFits(p, preset) }))}
                />
                <button
                  type="button"
                  className="icon-btn"
                  onClick={() => setAdding(true)}
                  aria-label={t('Add printer')}
                  data-tip={t('Add printer')}
                >
                  <Plus size={16} />
                </button>
              </div>
              {preset && fits.length < list.length && (
                <>
                  <span />
                  <p className={`hint small ${fits.length ? 'muted' : 'error'}`} data-testid="send-fits">
                    {fits.length
                      ? t('Sliced for {preset}. Printers without this preset are left out.', { preset })
                      : t('Sliced for {preset}. Add this preset to a printer to send it.', { preset })}
                  </p>
                </>
              )}
              <label className="caption" htmlFor="send-file">
                {t('File name')}
              </label>
              <input type="text" id="send-file" value={file} onChange={(e) => setFile(e.target.value)} data-testid="send-file" />
              <span />
              <label className="check">
                <input type="checkbox" checked={start} onChange={(e) => setStart(e.target.checked)} data-testid="send-start" />
                {t('Start printing')}
              </label>
            </div>
            <div className="create-foot">
              {sending && <span className="spinner" aria-label={t('Sending')} />}
              <button
                type="button"
                className="btn ghost"
                onClick={() => {
                  ctrl?.abort();
                  onClose();
                }}
              >
                {t('Cancel')}
              </button>
              <button type="submit" className="btn primary" disabled={!!sending || !id} data-testid="send-submit">
                <Send size={14} />
                {start ? t('Print') : t('Upload')}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
