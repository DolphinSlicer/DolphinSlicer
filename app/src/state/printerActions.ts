// Printers: the list (on this device, and in Drive for the ones synced), sending G-code, print
// controls and status polling.
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Drive } from '../drive/api';
import { t } from '../i18n/i18n';
import { newId } from '../library/store';
import { connect, type PrinterConfig, PrinterHttpError, type PrinterInfo, type PrinterStatus } from '../printers/connectors';
import { blockedAsMixedContent, lanPermission } from '../printers/net';
import { mergePrinters, type PrinterEntry, type PrintersFile, type Removed } from '../printers/sync';
import { gcodeBlob, gcodeFileName } from './actions';
import { requestSync } from './driveActions';
import { get, notify, set } from './store';

const KEY = 'dolphin-slicer.printers.v1';
interface Saved {
  printers: PrinterConfig[];
  last?: string;
  removed?: Removed[];
}

export function loadPrinters(): Saved {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Saved | null;
    if (v && Array.isArray(v.printers)) return v;
  } catch {
    /* none */
  }
  return { printers: [] };
}
function save(v: Saved) {
  try {
    localStorage.setItem(KEY, JSON.stringify(v));
  } catch {
    /* this session only */
  }
  set((s) => ({ printers: { ...s.printers, list: v.printers, last: v.last } }));
}

export function initPrinters() {
  const v = loadPrinters();
  set((s) => ({ printers: { ...s.printers, list: v.printers, last: v.last } }));
}

export function savePrinter(p: Omit<PrinterConfig, 'id'> & { id?: string }): PrinterConfig {
  const v = loadPrinters();
  const printer: PrinterConfig = { ...p, id: p.id || newId(), modified: Date.now() };
  if (!p.apiKey) delete printer.apiKey;
  const i = v.printers.findIndex((x) => x.id === printer.id);
  // Synced before: Drive needs to hear that it isn't any more.
  if (i >= 0 ? printer.sync || v.printers[i]!.sync : printer.sync) requestSync();
  if (i >= 0) v.printers[i] = printer;
  else v.printers.push(printer);
  save({ ...v, last: v.last ?? printer.id });
  return printer;
}

export function removePrinter(id: string) {
  const v = loadPrinters();
  const synced = v.printers.find((p) => p.id === id)?.sync;
  const removed = [...(v.removed ?? []), ...(synced ? [{ id, modified: Date.now() }] : [])];
  save({
    printers: v.printers.filter((p) => p.id !== id),
    ...(v.last && v.last !== id ? { last: v.last } : {}),
    ...(removed.length ? { removed } : {}),
  });
  if (synced) requestSync();
  set((s) => {
    const status = { ...s.printers.status };
    delete status[id];
    return { printers: { ...s.printers, status } };
  });
}

/** Whether G-code sliced with the printer profile `preset` is for printer `p` (unknown: any printer). */
export const printerFits = (p: PrinterConfig, preset: string | null) => !preset || !!p.presets?.includes(preset);

/** Printer profiles were renamed (old → new): the printers linked to them follow. */
export function renamePrinterLinks(renamed: Record<string, string>) {
  const v = loadPrinters();
  let changed = false;
  const printers = v.printers.map((p) => {
    if (!p.presets?.some((n) => renamed[n])) return p;
    changed = true;
    return { ...p, presets: p.presets.map((n) => renamed[n] ?? n), modified: Date.now() };
  });
  if (!changed) return;
  save({ ...v, printers });
  if (printers.some((p) => p.sync)) requestSync();
}

/**
 * A printer profile was added for a model (another nozzle): the printers linked to that model's
 * other profiles get it too. `siblings`: the model's other printer profiles.
 */
export function addPrinterLink(name: string, siblings: string[]) {
  const v = loadPrinters();
  let changed = false;
  const printers = v.printers.map((p) => {
    if (!p.presets || p.presets.includes(name) || !p.presets.some((n) => siblings.includes(n))) return p;
    changed = true;
    return { ...p, presets: [...p.presets, name], modified: Date.now() };
  });
  if (!changed) return;
  save({ ...v, printers });
  if (printers.some((p) => p.sync)) requestSync();
}

/** Sync the printers chosen for it with "DolphinSlicer/printers.json" in Drive. */
export async function syncPrinters(drive: Drive) {
  const before = loadPrinters();
  const app = await drive.folder('root', 'DolphinSlicer');
  const file = (await drive.children(app)).find((f) => f.name === 'printers.json' && !f.mimeType.endsWith('folder'));
  let remoteText = '';
  let remote: PrinterEntry[] = [];
  if (file) {
    remoteText = await drive.download(file.id);
    try {
      const v = JSON.parse(remoteText) as Partial<PrintersFile>;
      if (Array.isArray(v.printers)) remote = v.printers.filter((e) => e && typeof e.id === 'string' && typeof e.modified === 'number');
    } catch {
      /* unreadable: rebuilt from this device */
    }
  }
  const r = mergePrinters(before.printers, before.removed ?? [], remote);
  const text = `${JSON.stringify({ version: 1, printers: r.remote } satisfies PrintersFile, null, 1)}\n`;
  if (text !== remoteText && (file || r.remote.length)) {
    if (file) await drive.update(file.id, text);
    else await drive.create(app, 'printers.json', text);
  }
  // Changed here while syncing: the next sync merges that.
  if (JSON.stringify(loadPrinters()) !== JSON.stringify(before)) {
    requestSync();
    return;
  }
  const last = before.last && r.local.some((p) => p.id === before.last) ? before.last : undefined;
  save({ printers: r.local, ...(last ? { last } : {}) });
}

/** What went wrong, in words the user can act on. */
export async function explainError(p: PrinterConfig, e: unknown): Promise<string> {
  if (e instanceof PrinterHttpError) {
    // Uploading over the file being printed: Moonraker answers 403 "Forbidden" (the cause, "File is
    // loaded, upload not permitted", only in its traceback), OctoPrint 409.
    if (
      (p.kind === 'moonraker' && e.status === 403 && /file is loaded|file currently in use/i.test(e.body)) ||
      (p.kind === 'octoprint' && e.status === 409)
    )
      return t('This file is being printed. Use another file name.');
    // Moonraker answers 401 when it needs a key; its 403 is about the request itself.
    if (p.kind === 'octoprint' ? e.status === 401 || e.status === 403 : e.status === 401)
      return p.kind === 'octoprint' ? t('The printer refused the API key.') : t('The printer asks for an API key.');
    if (e.status === 404)
      return t('This address doesn’t look like {server}.', { server: p.kind === 'octoprint' ? 'OctoPrint' : 'Moonraker' });
    return t('The printer answered: {message}', { message: e.message });
  }
  if ((e as Error)?.name === 'TimeoutError') return t('The printer didn’t answer.');
  if ((e as Error)?.name === 'AbortError') return t('Canceled');
  const permission = await lanPermission();
  if (blockedAsMixedContent(p.url, permission)) {
    return permission === 'unsupported'
      ? t('This browser can’t reach http:// printers from this https:// page. Use Chrome or Edge, or run DolphinSlicer on your printer.')
      : t('Use the printer’s IP address (or its .local name) here: Chrome allows http:// printers only by address.');
  }
  if (permission === 'denied')
    return t('Access to your local network is blocked. Allow it in the site settings (the icon left of the address), then try again.');
  return t('Could not reach the printer. Check the address, and that the printer allows this site (see the setup notes).');
}

/** Test a connection (from the form). */
export async function testPrinter(p: PrinterConfig): Promise<{ ok: true; info: PrinterInfo } | { ok: false; message: string }> {
  try {
    return { ok: true, info: await connect(p).info() };
  } catch (e) {
    return { ok: false, message: await explainError(p, e) };
  }
}

const setStatus = (id: string, v: PrinterStatus | { error: string }) =>
  set((s) => ({ printers: { ...s.printers, status: { ...s.printers.status, [id]: v } } }));

export async function refreshStatus(p: PrinterConfig) {
  try {
    setStatus(p.id, await connect(p).status());
  } catch (e) {
    setStatus(p.id, { error: await explainError(p, e) });
  }
}

let timer = 0;
let users = 0;
/** Poll the status of every printer while something shows it. Returns the stop function. */
export function watchPrinters(): () => void {
  users++;
  const tick = async () => {
    await Promise.all(get().printers.list.map(refreshStatus));
    if (users > 0) timer = window.setTimeout(() => void tick(), 3000);
  };
  if (users === 1) void tick();
  return () => {
    users--;
    if (!users) clearTimeout(timer);
  };
}

/** Send the sliced G-code. Returns true when it was sent. */
export async function sendToPrinter(id: string, name: string, start: boolean, signal?: AbortSignal): Promise<boolean> {
  const p = get().printers.list.find((x) => x.id === id);
  if (!p || !gcodeBlob) return false;
  const file = /\.gcode$/i.test(name) ? name : `${name}.gcode`;
  set((s) => ({ printers: { ...s.printers, sending: id } }));
  try {
    await connect(p).upload(gcodeBlob, file, start, signal);
    save({ ...loadPrinters(), last: id });
    notify({
      kind: 'info',
      title: start ? t('Printing on {printer}', { printer: p.name }) : t('Sent to {printer}', { printer: p.name }),
      message: file,
    });
    void refreshStatus(p);
    return true;
  } catch (e) {
    if ((e as Error)?.name !== 'AbortError')
      notify({ kind: 'error', title: t('Could not send to {printer}', { printer: p.name }), message: await explainError(p, e) });
    return false;
  } finally {
    set((s) => ({ printers: { ...s.printers, sending: null } }));
  }
}

export const defaultFileName = () => gcodeFileName();

export async function printerCommand(id: string, cmd: 'pause' | 'resume' | 'cancel') {
  const p = get().printers.list.find((x) => x.id === id);
  if (!p) return;
  try {
    await connect(p)[cmd]();
  } catch (e) {
    notify({ kind: 'error', title: p.name, message: await explainError(p, e) });
  }
  await refreshStatus(p);
}
