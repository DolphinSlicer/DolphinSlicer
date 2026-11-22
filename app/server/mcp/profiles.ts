// OrcaSlicer's system profiles and setting definitions for the MCP server, read from the site's
// own static files: profiles-manifest.json, the profile bundle's catalog and name-sharded
// presets (shard.ts), settings-schema.json and settings-defaults.json (scripts/dump-schema.mjs).
// Presets are resolved as desktop's PresetBundle does it: the type's default preset, then each
// parent from the root of the inherits chain down, then the preset's own values.
// SPDX-License-Identifier: AGPL-3.0-or-later
import { presetShard } from './shard';

/** The site's static files (Cloudflare's ASSETS binding, or the files on disk in Vite). */
export interface Assets {
  fetch(path: string): Promise<Response>;
}

export type PresetType = 'printer' | 'filament' | 'print';
export const PRESET_TYPES: readonly PresetType[] = ['printer', 'filament', 'print'];
/** The folder of each type in desktop's user preset files ("machine/Name.json"). */
export const TYPE_DIR: Record<PresetType, string> = { printer: 'machine', filament: 'filament', print: 'process' };
const TYPE_OF_FILE: Record<string, PresetType> = { machine: 'printer', filament: 'filament', process: 'print' };

export type Value = string | string[];
export type Values = Record<string, Value>;
export type PresetJson = Record<string, unknown> & { name?: string; inherits?: string; type?: string };

export interface OptionDef {
  category: string;
  default: string;
  label: string;
  full_label: string;
  mode: string;
  sidetext: string;
  tooltip: string;
  type: string;
  min?: number;
  max?: number;
  enum_values?: string[];
  enum_labels?: string[];
  nullable?: boolean;
  readonly?: boolean;
}
export interface Schema {
  options: Record<string, OptionDef>;
  print: string[];
  filament: string[];
  printer: string[];
  orca_version: string;
}

interface Manifest {
  base: string;
  library: string;
  catalog: string;
  vendors: { id: string; name: string; models: { name: string; nozzles: string[] }[] }[];
}
export type Catalog = Record<string, Record<PresetType, string[]>>;
type Shard = Record<string, Record<string, string>>;

export interface Resolved {
  name: string;
  type: PresetType;
  vendor: string;
  /** The preset's file, as in the profiles. */
  json: PresetJson;
  values: Values;
}

// Per isolate: the files are content-addressed or change only with a deploy.
const cache = new Map<string, Promise<unknown>>();
const SHARDS_KEPT = 64;

export class Profiles {
  constructor(private readonly assets: Assets) {}

  private load<T>(path: string, keep = true): Promise<T> {
    const hit = cache.get(path);
    if (hit) {
      // Most recently used last, so the oldest shards are dropped first.
      cache.delete(path);
      cache.set(path, hit);
      return hit as Promise<T>;
    }
    const p = this.assets.fetch(`/${path}`).then((r) => {
      if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
      return r.json() as Promise<T>;
    });
    p.catch(() => cache.delete(path));
    cache.set(path, p);
    if (!keep) {
      const shards = [...cache.keys()].filter((k) => k.includes('/presets/'));
      for (const k of shards.slice(0, Math.max(0, shards.length - SHARDS_KEPT))) cache.delete(k);
    }
    return p;
  }

  manifest = () => this.load<Manifest>('profiles-manifest.json');
  schema = () => this.load<Schema>('settings-schema.json');
  private allDefaults = () => this.load<Record<PresetType, Values>>('settings-defaults.json');
  async catalog(): Promise<Catalog> {
    return this.load<Catalog>((await this.manifest()).catalog);
  }
  private async shard(name: string): Promise<Record<string, string>> {
    const m = await this.manifest();
    return (await this.load<Shard>(`${m.base}/presets/${presetShard(name)}.json`, false))[name] ?? {};
  }

  /** The system preset's file and vendor, or null. `vendor`: the one to prefer (a parent's own vendor). */
  async find(name: string, vendor?: string): Promise<{ vendor: string; json: PresetJson } | null> {
    const byVendor = await this.shard(name);
    const vendors = Object.keys(byVendor);
    if (!vendors.length) return null;
    const lib = (await this.manifest()).library;
    const v = vendor && byVendor[vendor] ? vendor : vendors.length === 1 || !byVendor[lib] ? vendors[0]! : lib;
    return { vendor: v, json: JSON.parse(byVendor[v]!) as PresetJson };
  }

  /** The values of a type's default preset (desktop's "Default Printer", …). */
  async defaults(type: PresetType): Promise<Values> {
    return structuredClone((await this.allDefaults())[type]);
  }

  /** A system preset with every value resolved, or null. */
  async resolve(name: string, vendor?: string): Promise<Resolved | null> {
    const chain: { vendor: string; json: PresetJson }[] = [];
    let next: string | undefined = name;
    let v = vendor;
    while (next) {
      if (chain.length > 16 || chain.some((c) => c.json.name === next)) throw new Error(`Inheritance loop at ${next}`);
      const hit = await this.find(next, v);
      if (!hit) {
        if (!chain.length) return null;
        throw new Error(`${chain[chain.length - 1]!.json.name} inherits from ${next}, which is missing`);
      }
      chain.push(hit);
      v = hit.vendor;
      next = typeof hit.json.inherits === 'string' && hit.json.inherits ? hit.json.inherits : undefined;
    }
    const first = chain[0]!;
    const type = TYPE_OF_FILE[String(first.json.type)];
    if (!type) return null;
    const s = await this.schema();
    const defaults = await this.defaults(type);
    const values = structuredClone(defaults);
    for (const c of chain.reverse()) {
      // Templates a preset includes (Bambu Lab's G-code): their settings over the parent's, in order.
      const includes = c.json.include;
      for (const inc of Array.isArray(includes) ? includes : typeof includes === 'string' ? [includes] : []) {
        const t = typeof inc === 'string' ? await this.resolve(inc, c.vendor) : null;
        if (t) for (const [k, v] of Object.entries(t.values)) if (JSON.stringify(v) !== JSON.stringify(defaults[k])) values[k] = v;
      }
      Object.assign(values, ownValues(c.json, s, type));
    }
    return { name, type, vendor: first.vendor, json: first.json, values };
  }

  /** The type of a system preset that can be picked (not a base), or null. */
  async typeOf(name: string): Promise<PresetType | null> {
    const hit = await this.find(name);
    if (!hit || String(hit.json.instantiation) !== 'true') return null;
    return TYPE_OF_FILE[String(hit.json.type)] ?? null;
  }
}

/** The settings a preset file sets itself (its keys that are settings of its type), read as the engine reads them. */
export function ownValues(json: PresetJson, s: Schema, type: PresetType): Values {
  const keys = new Set(s[type]);
  const out: Values = {};
  for (const [k, v] of Object.entries(json)) {
    const d = s.options[k];
    if (k === 'inherits' || !keys.has(k) || !d) continue;
    if (typeof v === 'string') {
      // A list written as one value: its elements (comma-separated, or the text itself).
      if (isVector(d)) out[k] = d.type === 'strings' ? splitStrings(v) : v.split(',');
      else out[k] = d.type === 'string' ? unescapeConfig(v) : v;
    } else if (Array.isArray(v) && v.every((x) => typeof x === 'string')) out[k] = isVector(d) ? (v as string[]) : (v[0] ?? '');
  }
  return out;
}

export const isVector = (d: OptionDef) => d.type.endsWith('s');

/** A list of strings written as one config value: `"a";"b"` or a;b (desktop's unescape_strings_cstyle). */
function splitStrings(v: string): string[] {
  if (!v) return [];
  const out: string[] = [];
  let i = 0;
  while (i <= v.length) {
    if (v[i] === '"') {
      let item = '';
      for (i++; i < v.length && v[i] !== '"'; i++) item += v[i] === '\\' && i + 1 < v.length ? unescapeConfig(`\\${v[++i]}`) : v[i];
      out.push(item);
      i += 2;
    } else {
      const end = v.indexOf(';', i);
      out.push(v.slice(i, end < 0 ? v.length : end));
      i = end < 0 ? v.length + 1 : end + 1;
    }
  }
  return out;
}

// Single strings in preset files are escaped as in config files ("\\n" for a line break) when
// desktop writes them; the engine unescapes every one it reads.
export const unescapeConfig = (v: string) => v.replace(/\\(.)/gs, (_, c: string) => (c === 'n' ? '\n' : c === 'r' ? '\r' : c));
export const escapeConfig = (v: string) => v.replace(/[\\"\r\n]/g, (c) => (c === '\n' ? '\\n' : c === '\r' ? '\\r' : `\\${c}`));
