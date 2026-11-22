// Comparing the edited preset with another one, side by side on the settings page: what a
// setting's field shows for each, and the other one's value as text.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { tr } from '../i18n/i18n';
import type { EditKind, OptionDef } from './schema';

type Value = string | string[] | undefined;

/** The text a setting's field shows for these values: a list as lines, one element, or the value. */
export function fieldText(kind: EditKind, value: Value, index: number): string | undefined {
  if (value === undefined) return undefined;
  const elems = Array.isArray(value) ? value : [value];
  if (kind === 'list') return elems.join('\n');
  if (kind === 'element') return elems[Math.min(index, elems.length - 1)] ?? '';
  return value as string;
}

/** Whether a setting's field shows something else for the other preset. */
export function differs(kind: EditKind, mine: Value, other: Value, index: number): boolean {
  const o = fieldText(kind, other, index);
  return o !== undefined && o !== fieldText(kind, mine, index);
}

/** The other preset's value of a field, as text (desktop's comparison writes them so too). */
export function formatSetting(key: string, def: OptionDef, text: string): string {
  if (text === 'nil') return tr('N/A');
  if (key === 'compatible_printers' || key === 'compatible_prints') return text || tr('All');
  if (def.enum_values && def.enum_labels?.length) {
    const i = def.enum_values.indexOf(text);
    if (i >= 0 && def.enum_labels[i]) return tr(def.enum_labels[i]!);
  }
  // Single strings are kept in config-file form (escaped line breaks).
  if (def.type === 'string') return text.replace(/\\(.)/gs, (_, c: string) => (c === 'n' ? '\n' : c === 'r' ? '\r' : c));
  return text;
}

/** A field's text as an edit of the setting (orca_presets_edit): a list's lines, one element, or the value. */
export function commitValue(
  kind: EditKind,
  text: string,
  index: number,
  value: string | string[] | undefined,
): string | { index: number; value: string } | { elements: string[] } {
  if (kind === 'list')
    return {
      elements: text
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean),
    };
  if (kind === 'element') return { index: Math.min(index, (Array.isArray(value) ? value.length : 1) - 1), value: text };
  return text;
}
