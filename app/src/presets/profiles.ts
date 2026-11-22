// System profiles: the vendor catalog (public/profiles-manifest.json) and lazily fetched vendor
// bundles, loaded into OrcaSlicer's PresetBundle inside the auxiliary engine worker.
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { VendorBundle } from '../engine/protocol';

export interface VendorInfo {
  id: string;
  name: string;
  version: string;
  /** Printer models; materials = default filaments (names without the "@…" suffix). */
  models: { name: string; nozzles: string[]; family: string; materials: string[] }[];
  printers: number;
  filaments: number;
  bytes: number;
}

export interface ProfilesManifest {
  base: string;
  library: string;
  /** Preset name → the vendor that defines it (names unique to one vendor). */
  index: string;
  /** Each vendor's presets one can pick, by type (PresetCatalog). */
  catalog: string;
  vendors: VendorInfo[];
}

let manifest: Promise<ProfilesManifest> | null = null;
export function profilesManifest(): Promise<ProfilesManifest> {
  manifest ??= fetch(new URL('profiles-manifest.json', document.baseURI)).then((r) => {
    if (!r.ok) throw new Error(`profiles-manifest.json: HTTP ${r.status}`);
    return r.json() as Promise<ProfilesManifest>;
  });
  return manifest;
}

const bundles = new Map<string, Promise<VendorBundle>>();
export async function vendorBundle(id: string): Promise<VendorBundle> {
  let p = bundles.get(id);
  if (!p) {
    p = profilesManifest().then(async (m) => {
      const r = await fetch(new URL(`${m.base}/${encodeURIComponent(id)}.json`, document.baseURI));
      if (!r.ok) throw new Error(`Profiles for ${id}: HTTP ${r.status}`);
      const j = (await r.json()) as { files: Record<string, string> };
      return { id, files: j.files };
    });
    p.catch(() => bundles.delete(id));
    bundles.set(id, p);
  }
  return p;
}

let index: Promise<Record<string, string>> | null = null;
/** Preset name → vendor, for presets that only one vendor defines. */
export function presetVendorIndex(): Promise<Record<string, string>> {
  index ??= profilesManifest().then(async (m) => {
    const r = await fetch(new URL(m.index, document.baseURI));
    if (!r.ok) throw new Error(`Preset index: HTTP ${r.status}`);
    return r.json() as Promise<Record<string, string>>;
  });
  index.catch(() => {
    index = null;
  });
  return index;
}

/** Vendor id → its presets one can pick, by type. */
export type PresetCatalog = Record<string, Record<'printer' | 'filament' | 'print', string[]>>;
let catalog: Promise<PresetCatalog> | null = null;
/** Every vendor's presets, loaded or not: to compare with any of them. */
export function presetCatalog(): Promise<PresetCatalog> {
  catalog ??= profilesManifest().then(async (m) => {
    const r = await fetch(new URL(m.catalog, document.baseURI));
    if (!r.ok) throw new Error(`Preset catalog: HTTP ${r.status}`);
    return r.json() as Promise<PresetCatalog>;
  });
  catalog.catch(() => {
    catalog = null;
  });
  return catalog;
}
