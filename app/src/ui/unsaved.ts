// Asking before an action drops unsaved setting edits.
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { PresetType } from '../engine/protocol';
import { t } from '../i18n/i18n';
import { useApp } from '../state/store';
import { ask } from './Confirm';

const ALL: PresetType[] = ['printer', 'print', 'filament'];

/** Whether unsaved edits of these preset types (all by default) may be dropped: asks when there are any. */
export async function discardEditsOk(types: PresetType[] = ALL): Promise<boolean> {
  const st = useApp.getState().presets.state;
  if (!st) return true;
  const name = { printer: st.printer, print: st.process, filament: st.filaments[0] ?? '' };
  const lost = types.filter((ty) => st.dirty?.[ty]).map((ty) => name[ty]);
  return !lost.length || ask(t('Discard unsaved changes to {names}?', { names: lost.join(', ') }), { confirm: t('Discard') });
}

/** Whether imported presets may replace those of the same names (desktop asks the same). */
export const replacePresetsOk = (names: string[]): Promise<boolean> =>
  ask(t('These presets exist already: {names}. Replace them?', { names: names.join(', ') }), { confirm: t('Replace') });
