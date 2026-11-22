// Which printer presets are nozzle variants of a model (one entry per model in the sidebar).
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { PresetEntry } from '../src/engine/protocol';
import { isModelVariant } from '../src/presets/library';

const entry = (name: string, o: Partial<PresetEntry>): PresetEntry => ({
  name,
  alias: '',
  system: false,
  user: true,
  inherits: '',
  vendor: '',
  model: 'Acme Cube',
  ...o,
});
const root = entry('Acme Cube 0.4 nozzle', { variant: '0.4' });
const variant = entry('Acme Cube 0.6 nozzle', { variant: '0.6', inherits: root.name });
const copy = entry('Acme Cube fast', { variant: '0.4', inherits: root.name });
const system = entry('MyKlipper 0.4 nozzle', { system: true, user: false, model: 'MyKlipper', variant: '0.4' });
const tuned = entry('MyKlipper tuned', { model: 'MyKlipper', variant: '0.6', inherits: system.name });
const printers = [root, variant, copy, system, tuned];

describe('printer model variants', () => {
  it('counts system printers, custom roots and their children with another nozzle', () => {
    expect(printers.filter((p) => isModelVariant(p, printers)).map((p) => p.name)).toEqual([root.name, variant.name, system.name]);
  });
});
