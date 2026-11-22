// OrcaSlicer's option definitions (dumped from the engine) and the desktop tab layout
// (extracted from Tab.cpp), and how each option is edited.
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { PresetType } from '../engine/protocol';
import { N_ } from '../i18n/i18n';
import layoutJson from './layout.json';

export interface OptionDef {
  type: string;
  label: string;
  full_label: string;
  category: string;
  tooltip: string;
  sidetext: string;
  mode: 'simple' | 'advanced' | 'expert' | 'develop';
  default?: string;
  enum_values?: string[];
  enum_labels?: string[];
  min?: number;
  max?: number;
  gui_type?: string;
  multiline?: boolean;
  full_width?: boolean;
  is_code?: boolean;
  readonly?: boolean;
  height?: number;
  nullable?: boolean;
}

export interface Schema {
  orca_version: string;
  options: Record<string, OptionDef>;
  print: string[];
  filament: string[];
  printer: string[];
}

/** `lines`: for options desktop shows together in one labeled row, that row's label. */
export interface LayoutGroup {
  title: string;
  keys: string[];
  lines?: Record<string, string>;
}
export interface LayoutPage {
  title: string;
  groups: LayoutGroup[];
}
/** `docs`: each option's page in the OrcaSlicer wiki ("page#anchor"), as desktop links it. */
export type Layout = Record<PresetType, LayoutPage[]> & { docs: Record<string, string> };

export const layout = layoutJson as unknown as Layout;

let schema: Promise<Schema> | null = null;
export function loadSchema(): Promise<Schema> {
  schema ??= fetch(new URL('settings-schema.json', document.baseURI)).then((r) => {
    if (!r.ok) throw new Error(`settings-schema.json: HTTP ${r.status}`);
    return r.json() as Promise<Schema>;
  });
  return schema;
}

/**
 * How a value is edited:
 * - scalar: the option's own serialization;
 * - element: one element of a per-extruder / per-variant vector;
 * - list: the whole vector (bed shape points, script lists, compatibility lists, groups).
 */
export type EditKind = 'scalar' | 'element' | 'list';

const LIST_KEYS = new Set([
  'post_process',
  'compatible_printers',
  'compatible_prints',
  'slicing_pipeline_plugin',
  'small_area_infill_flow_compensation_model',
  'extruder_bed_exclude_volumes',
]);

export function editKind(key: string, def: OptionDef): EditKind {
  const vector = /s$|_groups$/.test(def.type) && def.type !== 'float_or_percent';
  if (!vector) return 'scalar';
  // One point per nozzle, shown with the nozzle's other settings.
  if (key === 'extruder_offset') return 'element';
  if (def.type === 'points' || def.type.endsWith('_groups') || def.gui_type === 'one_string' || LIST_KEYS.has(key)) return 'list';
  return 'element';
}

/** Desktop's settings modes, each showing its own options and those of the modes before it. */
export const MODES = ['simple', 'advanced', 'expert'] as const;
export type SettingsMode = (typeof MODES)[number];

/** Whether an option shows in a mode (develop options never: desktop's developer mode). */
export function visibleInMode(def: OptionDef, mode: SettingsMode): boolean {
  const rank = (MODES as readonly string[]).indexOf(def.mode);
  return rank >= 0 && rank <= MODES.indexOf(mode);
}

/** Untranslated: show with t(). */
export const TYPE_LABEL: Record<PresetType, string> = { print: N_('Print settings'), filament: N_('Filament'), printer: N_('Printer') };
