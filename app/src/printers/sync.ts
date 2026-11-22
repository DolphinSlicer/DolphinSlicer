// Google Drive sync of the printers the user chose to sync: "DolphinSlicer/printers.json" holds
// them, API keys included. Printers not synced stay on their device; a printer whose sync was
// turned off leaves only its id in Drive, so the other devices stop syncing it too and keep
// their copy.
//
// Entries merge by id: the newer `modified` wins. Deletions stay in the file, so they reach the
// other devices.
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { PrinterConfig } from './connectors';

/** A printer in Drive: its settings, or none (sync turned off), or deleted. */
export interface PrinterEntry {
  id: string;
  modified: number;
  deleted?: true;
  printer?: Omit<PrinterConfig, 'id' | 'sync' | 'modified'>;
}
export interface PrintersFile {
  version: 1;
  printers: PrinterEntry[];
}
/** A synced printer deleted on this device, until the deletion is in Drive. */
export interface Removed {
  id: string;
  modified: number;
}

const settings = ({ id: _id, sync: _sync, modified: _modified, ...rest }: PrinterConfig) => rest;

/** Merge this device's printers with Drive's. Pure; Drive's entries come out sorted by id. */
export function mergePrinters(
  local: PrinterConfig[],
  removed: Removed[],
  remote: PrinterEntry[],
): { local: PrinterConfig[]; remote: PrinterEntry[] } {
  const out = new Map(remote.map((r) => [r.id, r]));
  const mine: PrinterEntry[] = [
    ...local.map((p): PrinterEntry => ({ id: p.id, modified: p.modified ?? 0, ...(p.sync ? { printer: settings(p) } : {}) })),
    ...removed.map((r): PrinterEntry => ({ id: r.id, modified: r.modified, deleted: true })),
  ];
  for (const m of mine) {
    const r = out.get(m.id);
    // Not in Drive yet: only a synced printer goes there.
    if (!r) {
      if (m.printer) out.set(m.id, m);
      continue;
    }
    if (m.modified > r.modified) out.set(m.id, m);
  }
  const result: PrinterConfig[] = [];
  for (const p of local) {
    const r = out.get(p.id);
    if (!r) result.push(p);
    else if (r.deleted) continue;
    else if (r.printer) result.push({ ...r.printer, id: p.id, sync: true, modified: r.modified });
    else result.push({ ...p, sync: false, modified: Math.max(p.modified ?? 0, r.modified) });
  }
  const here = new Set(local.map((p) => p.id));
  for (const r of out.values()) if (r.printer && !here.has(r.id)) result.push({ ...r.printer, id: r.id, sync: true, modified: r.modified });
  return { local: result, remote: [...out.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) };
}
