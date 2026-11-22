// The user's printer and filament library: which system presets show in the pickers. Like
// desktop's printer and filament selection (AppConfig "models" and "filaments"), printers are
// added by model and nozzle and filaments by name without the "@printer" suffix, so one choice
// covers every printer's variant of a filament. User presets always show.
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { PresetEntry } from '../engine/protocol';

export interface PrinterPick {
  vendor: string;
  model: string;
  nozzle: string;
}
export interface Library {
  printers: PrinterPick[];
  /** Filament names without the "@…" suffix (preset alias). */
  filaments: string[];
  /** Vendors to load for user presets that inherit from them (imports, Drive). */
  vendors: string[];
}

const KEY = 'dolphin-slicer.library.v1';

/** A printer that slices out of the box, until the user picks their own. */
export const DEFAULT_LIBRARY: Library = {
  printers: [{ vendor: 'Custom', model: 'Generic Klipper Printer', nozzle: '0.4' }],
  filaments: ['Generic PLA', 'Generic PETG', 'Generic ABS', 'Generic ASA', 'Generic TPU'],
  vendors: [],
};

/** The saved library; null on first start (the wizard opens then). */
export function loadLibrary(): Library | null {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<Library> | null;
    if (!v || !Array.isArray(v.printers)) return null;
    return {
      printers: v.printers,
      filaments: Array.isArray(v.filaments) ? v.filaments : [],
      vendors: Array.isArray(v.vendors) ? v.vendors : [],
    };
  } catch {
    return null;
  }
}

export function saveLibrary(l: Library) {
  try {
    localStorage.setItem(KEY, JSON.stringify(l));
  } catch {
    /* this session only */
  }
}

export const samePick = (a: PrinterPick, b: PrinterPick) => a.vendor === b.vendor && a.model === b.model && a.nozzle === b.nozzle;

/** A preset's name without the "@…" suffix ("Bambu PLA Basic @BBL X1C" → "Bambu PLA Basic"). */
export const filamentAlias = (e: PresetEntry) => e.alias || e.name.replace(/\s*@.*$/, '');

export function printerInLibrary(l: Library, e: PresetEntry): boolean {
  if (e.user) return true;
  return l.printers.some((p) => p.vendor === e.vendor && p.model === e.model && Number(p.nozzle) === Number(e.variant));
}

export function filamentInLibrary(l: Library, e: PresetEntry): boolean {
  return e.user || l.filaments.includes(filamentAlias(e));
}

/** Vendors whose profiles must be loaded for this library. */
export const libraryVendors = (l: Library) => [...new Set([...l.printers.map((p) => p.vendor), ...l.vendors])];

/**
 * Printer presets that are variants (nozzles) of a model: system ones, the user's own printers
 * with no parent (Create Printer) and their children with another nozzle (Create variant…). A
 * copy with edits (same nozzle) is a preset of its own, as on desktop.
 */
export function isModelVariant(e: PresetEntry, printers: readonly PresetEntry[]): boolean {
  if (!e.model) return false;
  if (e.system || (e.user && !e.inherits)) return true;
  const parent = e.user ? printers.find((x) => x.name === e.inherits) : undefined;
  return !!parent && parent.user && !parent.inherits && parent.model === e.model && parent.variant !== e.variant;
}
