// When each synced setting last changed on this device (settingsSync.ts compares that with
// Drive's copy). Kept apart from the sync so the places that change a setting can note it
// without importing the sync and its dependencies.
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The settings synced through Drive. */
export const SETTING_KEYS = ['theme', 'language', 'currency', 'units', 'settingsMode', 'library', 'selection', 'bedTypes'] as const;
export type SettingKey = (typeof SETTING_KEYS)[number];

/**
 * Each setting's value (as JSON) when it last changed or was synced, and when (0: not known).
 * `tried`: Drive's value, applied here, that gave this one instead (a selected preset this device
 * doesn't have): not applied again until Drive's changes.
 */
export type SettingsMeta = Partial<Record<SettingKey, { json: string; modified: number; tried?: string }>>;

const KEY = 'dolphin-slicer.settings-sync.v1';

export function loadMeta(): SettingsMeta {
  try {
    return (JSON.parse(localStorage.getItem(KEY) ?? '{}') as SettingsMeta) ?? {};
  } catch {
    return {};
  }
}
export function saveMeta(m: SettingsMeta) {
  try {
    localStorage.setItem(KEY, JSON.stringify(m));
  } catch {
    /* compared again at the next sync */
  }
}

let live = false;
let listener: (() => void) | null = null;
let applying = 0;

/**
 * From now on, changes are the user's. What the app picks by itself while starting (a default
 * printer, say) keeps the time known before, so it doesn't win over a choice made on another device.
 */
export function settingsLive() {
  live = true;
}

/** Settings from Drive being applied: no sync asked for (the sync applying them notes them). */
export async function applyingSettings<T>(fn: () => Promise<T>): Promise<T> {
  applying++;
  try {
    return await fn();
  } finally {
    applying--;
  }
}

let automatic = 0;
/**
 * What the app changes by itself meanwhile (a selection made again after presets came from Drive)
 * is not the user's: it keeps the time known before, so it doesn't win over a choice in Drive.
 */
export async function automatically<T>(fn: () => Promise<T>): Promise<T> {
  automatic++;
  try {
    return await fn();
  } finally {
    automatic--;
  }
}

/** Called after a setting changed (to sync soon). */
export function onSettingChange(fn: () => void) {
  listener = fn;
}

/** A setting changed on this device. */
export function noteChange(key: SettingKey, value: unknown) {
  const json = JSON.stringify(value ?? null);
  const m = loadMeta();
  const prev = m[key];
  if (prev?.json === json) return;
  m[key] = { json, modified: live && !applying && !automatic ? Date.now() : (prev?.modified ?? 0) };
  saveMeta(m);
  if (live && !applying) listener?.();
}
