// Printer connections: Klipper through Moonraker's HTTP API, and OctoPrint's REST API. Both are
// polled for status (every few seconds while the printer list is shown); no WebSocket, so the
// same code serves both and nothing stays open in the background.
// SPDX-License-Identifier: AGPL-3.0-or-later
import { lanFetch } from './net';

export type PrinterKind = 'moonraker' | 'octoprint';

export interface PrinterConfig {
  id: string;
  name: string;
  kind: PrinterKind;
  /** "http://192.168.1.50" (Moonraker's port 7125, or its web UI's address, which proxies the API). */
  url: string;
  /** OctoPrint: required. Moonraker: only when it asks for one. */
  apiKey?: string;
  /** The printer profiles G-code for it is sliced with (desktop's physical printer presets). */
  presets?: string[];
  /** Kept in Google Drive too (printers/sync.ts). */
  sync?: boolean;
  /** When it was last changed (ms), to merge with Drive. */
  modified?: number;
}

export type PrintState = 'ready' | 'printing' | 'paused' | 'done' | 'cancelled' | 'error' | 'busy' | 'offline';

export interface PrinterStatus {
  state: PrintState;
  /** The printer's own words, when it isn't ready. */
  message?: string;
  file?: string;
  /** 0–1. */
  progress?: number;
  /** Seconds. */
  elapsed?: number;
  remaining?: number;
  temps: { name: 'nozzle' | 'bed'; actual: number; target: number }[];
}

export interface PrinterInfo {
  server: string;
  version: string;
}

export interface PrinterConnector {
  /** Checks the address and key. */
  info(): Promise<PrinterInfo>;
  status(): Promise<PrinterStatus>;
  /** Upload G-code; with `start`, it starts printing right away. */
  upload(gcode: Blob, name: string, start: boolean, signal?: AbortSignal): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  cancel(): Promise<void>;
}

/** The printer answered with an error. `body`: the whole answer (Moonraker puts the cause in its traceback). */
export class PrinterHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body = '',
  ) {
    super(message);
  }
}

const TIMEOUT_MS = 15_000;

async function call(p: PrinterConfig, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (p.apiKey) headers.set('X-Api-Key', p.apiKey);
  // A printer that hangs must not hang the app: give up after a while (uploads have their own signal).
  const r = await lanFetch(`${p.url}${path}`, { signal: AbortSignal.timeout(TIMEOUT_MS), ...init, headers });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    let msg = text.slice(0, 300);
    try {
      const j = JSON.parse(text) as { error?: string | { message?: string } };
      msg = typeof j.error === 'string' ? j.error : (j.error?.message ?? msg);
    } catch {
      /* plain text */
    }
    throw new PrinterHttpError(r.status, msg || `HTTP ${r.status}`, text);
  }
  return r;
}
const json = async <T>(p: PrinterConfig, path: string, init?: RequestInit) => (await call(p, path, init)).json() as Promise<T>;
const post = (p: PrinterConfig, path: string, body?: unknown) =>
  call(p, path, {
    method: 'POST',
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });

const temp = (name: 'nozzle' | 'bed', t?: { temperature?: number; target?: number; actual?: number } | null) =>
  t ? [{ name, actual: t.temperature ?? t.actual ?? 0, target: t.target ?? 0 }] : [];

// ── Moonraker (Klipper) ────────────────────────────────────────────────────────────────────
// https://moonraker.readthedocs.io/en/latest/external_api/
class Moonraker implements PrinterConnector {
  constructor(private readonly p: PrinterConfig) {}

  async info(): Promise<PrinterInfo> {
    const r = await json<{ result: { moonraker_version?: string } }>(this.p, '/server/info');
    return { server: 'Moonraker', version: r.result.moonraker_version ?? '' };
  }

  async status(): Promise<PrinterStatus> {
    type Obj = Record<string, number | string | undefined>;
    let s: Record<string, Obj>;
    try {
      s = (
        await json<{ result: { status: Record<string, Obj> } }>(
          this.p,
          '/printer/objects/query?webhooks&print_stats&virtual_sdcard&extruder&heater_bed',
        )
      ).result.status;
    } catch (e) {
      // Moonraker is up but Klipper isn't (yet).
      if (!(e instanceof PrinterHttpError)) throw e;
      const info = await json<{ result: { klippy_state?: string; state_message?: string } }>(this.p, '/server/info').catch(() => null);
      return { state: 'offline', message: info?.result.state_message ?? info?.result.klippy_state ?? e.message, temps: [] };
    }
    const temps = [...temp('nozzle', s.extruder as never), ...temp('bed', s.heater_bed as never)];
    const hook = String(s.webhooks?.state ?? 'ready');
    if (hook !== 'ready')
      return { state: hook === 'startup' ? 'busy' : 'error', message: String(s.webhooks?.state_message ?? hook), temps };
    const ps = s.print_stats ?? {};
    const states: Record<string, PrintState> = {
      standby: 'ready',
      printing: 'printing',
      paused: 'paused',
      complete: 'done',
      cancelled: 'cancelled',
      error: 'error',
    };
    const state: PrintState = states[String(ps.state)] ?? 'ready';
    const progress = Number(s.virtual_sdcard?.progress ?? 0);
    const elapsed = Number(ps.print_duration ?? 0);
    return {
      state,
      temps,
      ...(ps.filename ? { file: String(ps.filename) } : {}),
      ...(state !== 'ready' ? { progress } : {}),
      ...(elapsed ? { elapsed } : {}),
      ...(state === 'printing' && progress > 0.005 ? { remaining: elapsed / progress - elapsed } : {}),
      ...(state === 'error' && ps.message ? { message: String(ps.message) } : {}),
    };
  }

  async upload(gcode: Blob, name: string, start: boolean, signal?: AbortSignal) {
    const form = new FormData();
    form.append('root', 'gcodes');
    form.append('print', start ? 'true' : 'false');
    form.append('file', gcode, name);
    await call(this.p, '/server/files/upload', { method: 'POST', body: form, signal });
  }
  async pause() {
    await post(this.p, '/printer/print/pause');
  }
  async resume() {
    await post(this.p, '/printer/print/resume');
  }
  async cancel() {
    await post(this.p, '/printer/print/cancel');
  }
}

// ── OctoPrint ──────────────────────────────────────────────────────────────────────────────
// https://docs.octoprint.org/en/master/api/
class OctoPrint implements PrinterConnector {
  constructor(private readonly p: PrinterConfig) {}

  async info(): Promise<PrinterInfo> {
    const r = await json<{ server?: string; text?: string }>(this.p, '/api/version');
    return { server: 'OctoPrint', version: r.server ?? r.text ?? '' };
  }

  async status(): Promise<PrinterStatus> {
    const job = await json<{
      state: string;
      error?: string;
      job?: { file?: { name?: string | null } };
      progress?: { completion?: number | null; printTime?: number | null; printTimeLeft?: number | null };
    }>(this.p, '/api/job');
    // 409 while no printer is connected to OctoPrint.
    const printer = await json<{ temperature?: { tool0?: { actual: number; target: number }; bed?: { actual: number; target: number } } }>(
      this.p,
      '/api/printer?exclude=sd,state',
    ).catch(() => null);
    const temps = [...temp('nozzle', printer?.temperature?.tool0), ...temp('bed', printer?.temperature?.bed)];
    const text = job.state ?? '';
    const completion = job.progress?.completion ?? null;
    let state: PrintState;
    if (/^Printing/.test(text)) state = 'printing';
    else if (/^Paused/.test(text)) state = 'paused';
    // On their way: resuming or canceling is accepted only once it is there.
    else if (/^(Pausing|Resuming|Cancelling|Starting|Finishing)/.test(text)) state = 'busy';
    else if (/^(Operational|Ready)/.test(text)) state = completion !== null && completion >= 100 ? 'done' : 'ready';
    else if (/^(Offline|Closed)/.test(text) || !printer) state = /error/i.test(text) ? 'error' : 'offline';
    else if (/error/i.test(text)) state = 'error';
    else state = 'busy';
    const file = job.job?.file?.name ?? undefined;
    return {
      state,
      temps,
      ...(state === 'ready' ? {} : { message: text }),
      ...(file && state !== 'ready' && state !== 'offline' ? { file } : {}),
      ...(completion !== null && state !== 'ready' ? { progress: completion / 100 } : {}),
      ...(job.progress?.printTime ? { elapsed: job.progress.printTime } : {}),
      ...(job.progress?.printTimeLeft && state === 'printing' ? { remaining: job.progress.printTimeLeft } : {}),
    };
  }

  async upload(gcode: Blob, name: string, start: boolean, signal?: AbortSignal) {
    const form = new FormData();
    form.append('file', gcode, name);
    form.append('select', start ? 'true' : 'false');
    form.append('print', start ? 'true' : 'false');
    await call(this.p, '/api/files/local', { method: 'POST', body: form, signal });
  }
  async pause() {
    await post(this.p, '/api/job', { command: 'pause', action: 'pause' });
  }
  async resume() {
    await post(this.p, '/api/job', { command: 'pause', action: 'resume' });
  }
  async cancel() {
    await post(this.p, '/api/job', { command: 'cancel' });
  }
}

export function connect(p: PrinterConfig): PrinterConnector {
  return p.kind === 'octoprint' ? new OctoPrint(p) : new Moonraker(p);
}
