// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { commitValue, differs, fieldText, formatSetting } from '../src/settings/compare';
import type { OptionDef } from '../src/settings/schema';

const def = (type: string, extra: Partial<OptionDef> = {}): OptionDef => ({
  type,
  label: '',
  full_label: '',
  category: '',
  tooltip: '',
  sidetext: '',
  mode: 'simple',
  ...extra,
});

describe('comparing presets side by side', () => {
  it('compares what the fields show: a value, the shown element of a list, or a whole list', () => {
    expect(differs('scalar', '0.2', '0.12', 0)).toBe(true);
    expect(differs('scalar', '0.2', '0.2', 0)).toBe(false);
    // The second nozzle's value is shown: only it counts.
    expect(differs('element', ['0.4', '0.4'], ['0.6', '0.4'], 1)).toBe(false);
    expect(differs('element', ['0.4', '0.4'], ['0.6', '0.4'], 0)).toBe(true);
    expect(differs('list', ['0x0', '200x0'], ['0x0', '250x0'], 0)).toBe(true);
    // A setting the other preset doesn't have: nothing to show.
    expect(differs('scalar', '1', undefined, 0)).toBe(false);
    expect(fieldText('element', ['a', 'b'], 5)).toBe('b');
  });

  it('turns the other value into the edit of the setting', () => {
    expect(commitValue('scalar', '0.12', 0, '0.2')).toBe('0.12');
    expect(commitValue('element', '0.6', 1, ['0.4', '0.4'])).toEqual({ index: 1, value: '0.6' });
    expect(commitValue('list', '0x0\n250x0', 0, [])).toEqual({ elements: ['0x0', '250x0'] });
  });

  it('writes the value as the field would: enum labels, line breaks, "All" printers', () => {
    expect(
      formatSetting('wall_generator', def('enum', { enum_values: ['classic', 'arachne'], enum_labels: ['Classic', 'Arachne'] }), 'arachne'),
    ).toBe('Arachne');
    expect(formatSetting('machine_start_gcode', def('string'), 'G28\\nG1 Z5')).toBe('G28\nG1 Z5');
    expect(formatSetting('compatible_printers', def('strings'), '')).toBe('All');
    expect(formatSetting('nozzle_temperature', def('ints'), 'nil')).toBe('N/A');
  });
});
