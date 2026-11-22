// What the MCP server tells assistants about DolphinSlicer itself: what to call it, where things
// are in its interface, and where each setting is on its settings pages (the desktop tab layout
// the app uses, src/settings/layout.json). Keep in step with the UI: the tabs (ui/App.tsx), the
// "Printer & material" card (ui/PresetPanel.tsx) and the calibration menu (ui/Calibration.tsx).
// SPDX-License-Identifier: AGPL-3.0-or-later
import layoutJson from '../../src/settings/layout.json';
import type { OptionDef, PresetType } from './profiles';

export const INSTRUCTIONS = `Call the app DolphinSlicer when talking to the user. It is built on OrcaSlicer and uses its engine, settings and profiles, but mention OrcaSlicer only when the user asks about it or about OrcaSlicer files. Don't describe OrcaSlicer's menus or tell the user to do anything in OrcaSlicer: DolphinSlicer's interface is its own, described below.

These tools read the user's setup and presets as DolphinSlicer last saved them to the user's Google Drive, DolphinSlicer's built-in profiles and setting help, and save presets. Start with get_setup. Ask before saving. A saved preset reaches DolphinSlicer at its next sync, when its tab is shown again or reloaded; the user then selects it.

Where things are in DolphinSlicer:
- Tabs at the top: Prepare (the plate and its objects), Preview (the sliced G-code), Library (saved models), Settings (every setting of the selected printer, filament and print settings, in Simple, Advanced or Expert mode). explain_setting gives each setting's page and the modes that show it.
- Prepare, "Printer & material" card: pickers for the printer (and its nozzle), filament, print settings and bed type, each with a button that opens it in Settings. The printer and filament pickers have "Add or remove printers…" / "Add or remove filaments…"; "Create variant…" adds another nozzle to a printer of the user's own.
- Prepare, "Objects" card: Import, and the Calibration menu with these tests: Temperature, Max flowrate, Pressure advance, Flow ratio, Retraction, Cornering, Input Shaping Frequency, Input Shaping Damping/zeta factor, VFA. There are no other calibration tests.
- Top right: Printers (send G-code to Klipper or OctoPrint printers and see their status), Preferences (language, units, currency, Google Drive sync), About.`;

const TYPE_LABEL: Record<PresetType, string> = { printer: 'Printer', filament: 'Filament', print: 'Print settings' };

type Layout = Record<PresetType, { title: string; groups: { title: string; keys: string[] }[] }[]>;
const layout = layoutJson as unknown as Layout;

/** Each setting's place on the settings pages, by type. */
const places = new Map<string, string>();
for (const type of ['printer', 'filament', 'print'] as const)
  for (const page of layout[type])
    for (const group of page.groups)
      for (const key of group.keys) places.set(`${type}:${key}`, `Settings → ${TYPE_LABEL[type]} → ${page.title} → ${group.title}`);

export const settingLocation = (type: PresetType, key: string) => places.get(`${type}:${key}`);

/** The settings modes that show a setting. */
export function shownInModes(d: OptionDef): string {
  switch (d.mode) {
    case 'simple':
      return 'Simple, Advanced and Expert';
    case 'advanced':
      return 'Advanced and Expert';
    case 'expert':
      return 'Expert';
    default:
      return 'none (not shown)';
  }
}
