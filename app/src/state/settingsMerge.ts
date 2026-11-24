// Merging the app's settings with Drive's copy (settingsSync.ts): for each setting the newer change.
// SPDX-License-Identifier: AGPL-3.0-or-later
import { LANGUAGES } from '../i18n/i18n';
import type { Library } from '../presets/library';
import { MODES } from '../settings/schema';
import { isStrings } from './prefs';
import { SETTING_KEYS, type SettingKey, type SettingsMeta } from './settingsMeta';

/** The selection kept in Drive: the printer, print settings and filament picked. */
export interface SyncedSelection {
  vendor?: string;
  printer: string;
  process?: string;
  filament?: string;
}

export interface Stamped {
  value: unknown;
  modified: number;
}
export interface SettingsFile {
  version: 1;
  settings: Partial<Record<SettingKey, Stamped>>;
}
export type Values = Partial<Record<SettingKey, unknown>>;

/** Whether a value from Drive can be used (another version of the app may have written it). */
export function validSetting(k: SettingKey, v: unknown): boolean {
  switch (k) {
    case 'theme':
      return v === 'system' || v === 'light' || v === 'dark';
    case 'language':
      return v === 'auto' || (LANGUAGES as readonly unknown[]).includes(v);
    case 'currency':
      return typeof v === 'string' && /^[A-Z]{3}$/.test(v);
    case 'units':
      return v === 'metric' || v === 'imperial';
    case 'settingsMode':
      return (MODES as readonly unknown[]).includes(v);
    case 'quickSettings':
      return isStrings(v);
    case 'library': {
      const l = v as Library | null;
      return (
        !!l &&
        Array.isArray(l.printers) &&
        l.printers.every((p) => p && typeof p.vendor === 'string' && typeof p.model === 'string' && typeof p.nozzle === 'string') &&
        isStrings(l.filaments) &&
        isStrings(l.vendors)
      );
    }
    case 'selection': {
      const s = v as SyncedSelection | null;
      return (
        !!s &&
        typeof s.printer === 'string' &&
        (s.process === undefined || typeof s.process === 'string') &&
        (s.filament === undefined || typeof s.filament === 'string')
      );
    }
    case 'bedTypes':
      return !!v && typeof v === 'object' && !Array.isArray(v) && Object.values(v).every((x) => typeof x === 'string');
  }
}

/**
 * This device's settings against Drive's: for each, the newer one (Drive's when both are as old,
 * so devices agree). A setting changed here without being noted counts as changed now; one never
 * changed here (a default) as older than any in Drive. Values that are null (not chosen here)
 * are not written to Drive.
 */
export function mergeSettings(local: Values, meta: SettingsMeta, remote: SettingsFile['settings'], now: number) {
  const apply: Values = {};
  const file: SettingsFile['settings'] = {};
  const next: SettingsMeta = {};
  for (const k of SETTING_KEYS) {
    const json = JSON.stringify(local[k] ?? null);
    const m = meta[k];
    const modified = !m ? 0 : m.json === json ? m.modified : now;
    const r = remote[k] && typeof remote[k]!.modified === 'number' && validSetting(k, remote[k]!.value) ? remote[k] : undefined;
    if (r && (r.modified >= modified || local[k] == null)) {
      const rj = JSON.stringify(r.value);
      // Applied here before, giving what this device has now: not again until Drive's changes.
      const tried = rj !== json && m?.tried === rj && m.json === json;
      if (rj !== json && !tried) apply[k] = r.value;
      file[k] = r;
      next[k] = tried ? m : { json: rj, modified: r.modified };
    } else if (local[k] != null) {
      file[k] = { value: local[k], modified };
      next[k] = { json, modified };
    }
  }
  return { apply, file, meta: next };
}
