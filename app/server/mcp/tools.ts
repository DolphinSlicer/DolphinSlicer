// The MCP server's tools: the user's setup and presets (from their Google Drive), OrcaSlicer's
// system profiles and setting definitions, and saving a preset.
// SPDX-License-Identifier: AGPL-3.0-or-later
import { BAD_NAME_CHARS } from '../../src/presets/renamePrinter';
import {
  escapeConfig,
  ownValues,
  PRESET_TYPES,
  type PresetJson,
  type PresetType,
  type Profiles,
  type Value,
  type Values,
} from './profiles';
import type { UserData } from './userData';
import { checkValue, FIXED_KEYS, sameValue } from './values';

/** A tool failed in a way the assistant can fix (shown to it as the result). */
export class ToolError extends Error {}

export interface ToolContext {
  profiles: Profiles;
  user: UserData;
}

interface Tool {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: { readOnlyHint: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint: boolean };
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<unknown>;
}

const TYPE_PROP = {
  type: 'string',
  enum: PRESET_TYPES,
  description: 'printer, filament or print (print settings, called "process" in OrcaSlicer files)',
};
const KEYS_PROP = {
  type: 'array',
  items: { type: 'string' },
  description: 'Only these settings (keys like "layer_height"). Default: all.',
};

const SETTINGS_ID: Record<PresetType, string> = {
  printer: 'printer_settings_id',
  filament: 'filament_settings_id',
  print: 'print_settings_id',
};

function str(args: Record<string, unknown>, key: string, required = true): string {
  const v = args[key];
  if (typeof v === 'string' && v.trim()) return v.trim();
  if (v === undefined && !required) return '';
  throw new ToolError(`${key} is required`);
}
function presetType(args: Record<string, unknown>): PresetType {
  const t = args.type;
  if (typeof t === 'string' && (PRESET_TYPES as readonly string[]).includes(t)) return t as PresetType;
  throw new ToolError('type must be printer, filament or print');
}
function keyList(args: Record<string, unknown>): string[] | null {
  const k = args.keys;
  if (k === undefined) return null;
  if (!Array.isArray(k) || !k.every((x) => typeof x === 'string')) throw new ToolError('keys must be a list of setting keys');
  return k as string[];
}
function pick(values: Values, keys: string[] | null): Values {
  if (!keys) return values;
  const out: Values = {};
  for (const k of keys) if (k in values) out[k] = values[k]!;
  return out;
}

interface Preset {
  name: string;
  type: PresetType;
  source: 'user' | 'system';
  /** The system preset it is based on (user presets). */
  inherits?: string;
  vendor?: string;
  /** A user preset's own settings (what it changes). */
  own?: Values;
  json: PresetJson;
  values: Values;
}

/** A preset by name: the user's own first, then a system one. */
async function loadPreset(ctx: ToolContext, type: PresetType, name: string, depth = 0): Promise<Preset | null> {
  const s = await ctx.profiles.schema();
  const json = depth > 8 ? null : await ctx.user.preset(type, name);
  if (json) {
    const own = ownValues(json, s, type);
    const inherits = typeof json.inherits === 'string' ? json.inherits : '';
    // A system preset, or a custom printer of the user's (its other nozzles inherit from it).
    const parent = inherits ? await loadPreset(ctx, type, inherits, depth + 1) : null;
    if (inherits && !parent) throw new ToolError(`${name} is based on ${inherits}, which is missing`);
    const values = { ...(parent?.values ?? (await ctx.profiles.defaults(type))), ...own };
    return { name, type, source: 'user', ...(inherits ? { inherits } : {}), own, json, values };
  }
  const sys = await ctx.profiles.resolve(name);
  if (!sys) return null;
  if (sys.type !== type) throw new ToolError(`${name} is a ${sys.type} preset, not a ${type} preset`);
  return { name, type, source: 'system', vendor: sys.vendor, json: sys.json, values: sys.values };
}

async function mustLoad(ctx: ToolContext, type: PresetType, name: string): Promise<Preset> {
  const p = await loadPreset(ctx, type, name);
  if (!p) throw new ToolError(`No ${type} preset named "${name}". get_setup lists the user's presets, find_profiles the system ones.`);
  return p;
}

async function settingInfo(profiles: Profiles, key: string) {
  const s = await profiles.schema();
  const d = s.options[key];
  if (!d) return null;
  const types = PRESET_TYPES.filter((t) => s[t].includes(key));
  return {
    key,
    label: d.full_label || d.label,
    ...(d.category ? { category: d.category } : {}),
    preset_type: types.join(', ') || 'none',
    value_type: d.type,
    ...(d.sidetext ? { unit: d.sidetext } : {}),
    default: d.default,
    ...(d.min !== undefined ? { min: d.min } : {}),
    ...(d.max !== undefined ? { max: d.max } : {}),
    ...(d.enum_values ? { options: d.enum_values.map((v, i) => ({ value: v, label: d.enum_labels?.[i] ?? v })) } : {}),
    ...(d.nullable ? { nullable: true } : {}),
    ...(d.readonly || FIXED_KEYS.has(key) ? { read_only: true } : {}),
    mode: d.mode,
    tooltip: d.tooltip,
  };
}

export const TOOLS: Tool[] = [
  {
    name: 'get_setup',
    title: 'Get my setup',
    description:
      "The user's DolphinSlicer setup as last synced to Google Drive: the selected printer, filament and print settings, the printers and filaments in their library, their own presets by type, units and currency.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
    async run(_args, ctx) {
      const [settings, presets] = await Promise.all([ctx.user.settings(), ctx.user.presetNames()]);
      if (!settings && !Object.values(presets).some((l) => l.length))
        return {
          note: 'No DolphinSlicer data in Google Drive. The user can turn on Google Drive sync in DolphinSlicer (Preferences) to share their setup.',
        };
      const sel = settings?.selection;
      return {
        selected: sel ? { printer: sel.printer, filament: sel.filament, print: sel.process } : null,
        library: settings?.library ? { printers: settings.library.printers ?? [], filaments: settings.library.filaments ?? [] } : null,
        user_presets: presets,
        ...(settings?.units ? { units: settings.units } : {}),
        ...(settings?.currency ? { currency: settings.currency } : {}),
        ...(settings?.bedTypes ? { plate_types: settings.bedTypes } : {}),
      };
    },
  },
  {
    name: 'get_preset',
    title: 'Get a preset',
    description:
      'A printer, filament or print preset\'s settings, with every value resolved through its parents. For the user\'s own presets, `own` lists what they set themselves on top of the system preset they inherit from. Values are as in OrcaSlicer\'s preset files: strings, lists for per-extruder settings, booleans as "1"/"0".',
    inputSchema: {
      type: 'object',
      properties: { type: TYPE_PROP, name: { type: 'string', description: 'The preset name' }, keys: KEYS_PROP },
      required: ['type', 'name'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    async run(args, ctx) {
      const keys = keyList(args);
      const p = await mustLoad(ctx, presetType(args), str(args, 'name'));
      return {
        name: p.name,
        type: p.type,
        source: p.source,
        ...(p.inherits ? { inherits: p.inherits } : {}),
        ...(p.vendor ? { vendor: p.vendor } : {}),
        ...(p.own ? { own: pick(p.own, keys) } : {}),
        values: pick(p.values, keys),
      };
    },
  },
  {
    name: 'compare_presets',
    title: 'Compare presets',
    description: 'The settings that differ between two presets of one type (user or system presets).',
    inputSchema: {
      type: 'object',
      properties: {
        type: TYPE_PROP,
        a: { type: 'string', description: 'The first preset' },
        b: { type: 'string', description: 'The second preset' },
        keys: KEYS_PROP,
      },
      required: ['type', 'a', 'b'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    async run(args, ctx) {
      const type = presetType(args);
      const keys = keyList(args);
      const [a, b] = await Promise.all([mustLoad(ctx, type, str(args, 'a')), mustLoad(ctx, type, str(args, 'b'))]);
      const s = await ctx.profiles.schema();
      const differences = [];
      for (const k of keys ?? s[type]) {
        if (k === 'inherits' || k === SETTINGS_ID[type] || sameValue(a.values[k], b.values[k])) continue;
        const d = s.options[k];
        differences.push({ key: k, label: d ? d.full_label || d.label : k, a: a.values[k], b: b.values[k] });
      }
      return { a: a.name, b: b.name, differences };
    },
  },
  {
    name: 'explain_setting',
    title: 'Explain a setting',
    description:
      'What an OrcaSlicer setting does: its label, tooltip, unit, limits, default and options. Give `key` for one setting, or `search` to find settings by words in their key, label or tooltip.',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'A setting key, like "sparse_infill_density"' },
        search: { type: 'string', description: 'Words to look for' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    async run(args, ctx) {
      const key = str(args, 'key', false);
      if (key) {
        const info = await settingInfo(ctx.profiles, key);
        if (!info) throw new ToolError(`No setting "${key}". Use search to find it.`);
        return info;
      }
      const words = str(args, 'search').toLowerCase().split(/\s+/);
      const s = await ctx.profiles.schema();
      const matches: { key: string; label: string; score: number }[] = [];
      for (const [k, d] of Object.entries(s.options)) {
        if (!PRESET_TYPES.some((t) => s[t].includes(k))) continue;
        const label = d.full_label || d.label;
        const head = `${k.replace(/_/g, ' ')} ${label}`.toLowerCase();
        const all = `${head} ${d.tooltip}`.toLowerCase();
        if (!words.every((w) => all.includes(w))) continue;
        matches.push({ key: k, label, score: words.filter((w) => head.includes(w)).length });
      }
      matches.sort((x, y) => y.score - x.score || x.key.localeCompare(y.key));
      const top = await Promise.all(matches.slice(0, 15).map((m) => settingInfo(ctx.profiles, m.key)));
      return { matches: top, ...(matches.length > 15 ? { more: matches.length - 15 } : {}) };
    },
  },
  {
    name: 'find_profiles',
    title: 'Find system profiles',
    description:
      'OrcaSlicer\'s built-in presets: printers, filaments and print settings by vendor. Without search or vendor, lists the vendors. Names of filaments and print settings end in "@<printer>" when they are made for one printer.',
    inputSchema: {
      type: 'object',
      properties: {
        type: TYPE_PROP,
        search: { type: 'string', description: 'Words that must all be in the name' },
        vendor: { type: 'string', description: 'A vendor, like "Voron" or "BBL" (Bambu Lab)' },
      },
      required: ['type'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    async run(args, ctx) {
      const type = presetType(args);
      const search = str(args, 'search', false).toLowerCase();
      const vendor = str(args, 'vendor', false).toLowerCase();
      const catalog = await ctx.profiles.catalog();
      if (!search && !vendor)
        return {
          vendors: Object.entries(catalog)
            .map(([v, c]) => ({ vendor: v, count: c[type].length }))
            .filter((v) => v.count),
        };
      const words = search.split(/\s+/).filter(Boolean);
      const found: { name: string; vendor: string }[] = [];
      for (const [v, c] of Object.entries(catalog)) {
        if (vendor && v.toLowerCase() !== vendor) continue;
        for (const n of c[type]) if (words.every((w) => n.toLowerCase().includes(w))) found.push({ name: n, vendor: v });
      }
      return { presets: found.slice(0, 60), ...(found.length > 60 ? { more: found.length - 60 } : {}) };
    },
  },
  {
    name: 'save_preset',
    title: 'Save a preset',
    description:
      "Save one of the user's own presets to their DolphinSlicer: change settings of an existing user preset (leave out `base`), or make a new one from `base`, a system or user preset. Only settings that differ from the system preset it inherits from are stored, as OrcaSlicer does. DolphinSlicer picks it up at its next Google Drive sync (when its tab is reopened or reloaded); the user still selects it there. Ask the user before saving.",
    inputSchema: {
      type: 'object',
      properties: {
        type: TYPE_PROP,
        name: { type: 'string', description: 'The user preset to save' },
        base: { type: 'string', description: 'For a new preset: the preset to start from' },
        changes: {
          type: 'object',
          description:
            'Settings to change, by key: a value as text or number ("0.16", 215, "15%", true, an option value), or a list for per-extruder settings. One value for a list setting sets every element.',
          additionalProperties: true,
        },
      },
      required: ['type', 'name', 'changes'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    async run(args, ctx) {
      const type = presetType(args);
      const name = str(args, 'name').replace(/\s+/g, ' ');
      const baseName = str(args, 'base', false);
      const changes = args.changes;
      if (!changes || typeof changes !== 'object' || Array.isArray(changes)) throw new ToolError('changes must be an object of settings');
      if (BAD_NAME_CHARS.test(name)) throw new ToolError('A preset name cannot contain \\ / : * ? " < > |');
      if (name.length > 120) throw new ToolError('The name is too long');
      if (await ctx.profiles.find(name)) throw new ToolError(`"${name}" is a system preset name; choose another name`);

      const existing = await ctx.user.preset(type, name);
      if (existing && baseName && baseName !== name)
        throw new ToolError(`A ${type} preset named "${name}" exists. Leave out base to change it, or choose another name.`);
      if (!existing && !baseName) throw new ToolError(`There is no user ${type} preset named "${name}". Give base to make a new one.`);
      const base = existing ? await mustLoad(ctx, type, name) : await mustLoad(ctx, type, baseName);
      if (base.source === 'system' && String(base.json.instantiation) !== 'true')
        throw new ToolError(`${base.name} is a base profile; start from a preset find_profiles lists`);

      // The preset the new one inherits from: a system preset, a custom printer, or none.
      const inherits = base.source === 'system' ? base.name : (base.inherits ?? '');
      const parent = inherits ? (base.source === 'system' ? base : await loadPreset(ctx, type, inherits)) : null;
      const s = await ctx.profiles.schema();
      const allowed = new Set(s[type]);
      const own: Values = { ...(base.own ?? {}) };
      const errors: string[] = [];
      for (const [k, v] of Object.entries(changes as Record<string, unknown>)) {
        const d = s.options[k];
        if (!d || !allowed.has(k)) {
          errors.push(`${k}: not a ${type} setting`);
          continue;
        }
        try {
          own[k] = checkValue(k, d, v, base.values[k]);
        } catch (e) {
          errors.push((e as Error).message);
        }
      }
      if (errors.length) throw new ToolError(`Nothing was saved. ${errors.join('; ')}`);
      if (parent) for (const k of Object.keys(own)) if (sameValue(own[k], parent.values[k])) delete own[k];

      // The file as desktop writes it: the base's other fields (version, extruder layout), the
      // identity, then the settings, keys sorted.
      const json: Record<string, unknown> = {};
      const keep = base.source === 'user' ? base.json : { version: base.json.version };
      for (const [k, v] of Object.entries(keep)) if (!allowed.has(k) || FIXED_KEYS.has(k)) json[k] = v;
      for (const [k, v] of Object.entries(own)) json[k] = s.options[k]?.type === 'string' && typeof v === 'string' ? escapeConfig(v) : v;
      Object.assign(json, { name, from: 'User', [SETTINGS_ID[type]]: type === 'filament' ? [name] : name });
      if (inherits) json.inherits = inherits;
      else delete json.inherits;
      delete json.setting_id;
      delete json.instantiation;
      delete json.type;
      if (json.version === undefined) delete json.version;
      const sorted = Object.fromEntries(
        Object.keys(json)
          .sort()
          .map((k) => [k, json[k]]),
      );
      const result = await ctx.user.savePreset(type, name, `${JSON.stringify(sorted, null, '\t')}\n`, !inherits);
      const changed: Record<string, Value | undefined> = {};
      for (const k of Object.keys(changes as object)) changed[k] = own[k] ?? parent?.values[k];
      return {
        saved: name,
        type,
        result,
        ...(inherits ? { inherits } : {}),
        changed,
        note: 'DolphinSlicer picks this up at its next Google Drive sync. The user selects the preset there.',
      };
    },
  },
];
