// Checking setting values an assistant wants to save, and turning them into preset-file form
// (strings, lists as arrays, booleans as "1"/"0"), as the settings page would accept them.
// SPDX-License-Identifier: AGPL-3.0-or-later
import { isVector, type OptionDef, type Value } from './profiles';

/** Settings an assistant cannot change: the preset's identity and its extruder layout. */
export const FIXED_KEYS = new Set([
  'inherits',
  'print_settings_id',
  'filament_settings_id',
  'printer_settings_id',
  'print_extruder_id',
  'print_extruder_variant',
  'filament_extruder_variant',
  'printer_extruder_id',
  'printer_extruder_variant',
  'extruder_variant_list',
  'master_extruder_id',
  'printer_variant',
]);

const NUMBER = /^-?(\d+\.?\d*|\.\d+)$/;

/** One element of a setting, checked; throws with a message for the assistant. */
function element(key: string, d: OptionDef, input: unknown): string {
  const base = d.type.replace(/s$/, '');
  if (input === 'nil' && d.nullable) return 'nil';
  if (base === 'bool') {
    if (input === true || input === 1 || input === '1' || input === 'true') return '1';
    if (input === false || input === 0 || input === '0' || input === 'false') return '0';
    throw new Error(`${key}: use true or false`);
  }
  if (typeof input !== 'string' && typeof input !== 'number') throw new Error(`${key}: expected a ${base} value`);
  const text = String(input).trim();
  if (base === 'string') return String(input);
  if (base === 'enum') {
    const values = d.enum_values ?? [];
    if (values.includes(text)) return text;
    const i = (d.enum_labels ?? []).findIndex((l) => l.toLowerCase() === text.toLowerCase());
    if (i >= 0 && values[i] !== undefined) return values[i]!;
    throw new Error(`${key}: one of ${values.join(', ')}`);
  }
  if (base === 'point') {
    if (/^-?\d+(\.\d+)?x-?\d+(\.\d+)?$/.test(text)) return text;
    throw new Error(`${key}: a point like 0x0`);
  }
  if (/^-?\d+,\d+%?$/.test(text)) throw new Error(`${key}: use a dot as the decimal separator`);
  const percent = text.endsWith('%');
  const num = percent ? text.slice(0, -1).trim() : text;
  if (!NUMBER.test(num)) throw new Error(`${key}: expected a number${base === 'float_or_percent' ? ' or a percentage' : ''}`);
  if (base === 'int' && !/^-?\d+$/.test(num)) throw new Error(`${key}: expected a whole number`);
  if (percent && base !== 'percent' && base !== 'float_or_percent') throw new Error(`${key}: expected a number, not a percentage`);
  const n = Number(num);
  // A percent setting's limits are in percent; a float-or-percent setting's only apply to the number.
  if (!percent || base === 'percent') {
    if (d.min !== undefined && n < d.min) throw new Error(`${key}: at least ${d.min}`);
    if (d.max !== undefined && n > d.max) throw new Error(`${key}: at most ${d.max}`);
  }
  return base === 'percent' ? `${num}%` : percent ? `${num}%` : num;
}

/**
 * A setting's new value. A single value for a list setting is used for every element (the
 * current list's length; elements that are "nil" stay so).
 */
export function checkValue(key: string, d: OptionDef, input: unknown, current: Value | undefined): Value {
  if (d.readonly || FIXED_KEYS.has(key) || d.type === 'points_groups') throw new Error(`${key} cannot be changed here`);
  if (!isVector(d)) {
    if (Array.isArray(input)) {
      if (input.length !== 1) throw new Error(`${key}: expected one value, not a list`);
      return element(key, d, input[0]);
    }
    return element(key, d, input);
  }
  if (Array.isArray(input)) {
    if (!input.length && d.type !== 'strings') throw new Error(`${key}: the list is empty`);
    return input.map((x) => element(key, d, x));
  }
  const v = element(key, d, input);
  const cur = Array.isArray(current) && current.length ? current : [''];
  return cur.map((c) => (c === 'nil' ? 'nil' : v));
}

export const sameValue = (a: Value | undefined, b: Value | undefined) => JSON.stringify(a) === JSON.stringify(b);
