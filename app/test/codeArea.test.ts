// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { tokenizeLine } from '../src/ui/CodeArea';

describe('G-code highlighting', () => {
  it('colors commands, parameters, placeholders and comments', () => {
    expect(tokenizeLine('G1 X10 E[retract] ; move')).toEqual([
      ['G1', 'cmd'],
      [' ', null],
      ['X', 'param'],
      ['10 ', null],
      ['E', 'param'],
      ['[retract]', 'var'],
      [' ', null],
      ['; move', 'comment'],
    ]);
  });
  it('colors Klipper macros and their KEY= arguments; ; inside expressions is not a comment', () => {
    expect(tokenizeLine('PRINT_START BED={bed_temperature[0]; 1}')).toEqual([
      ['PRINT_START', 'macro'],
      [' ', null],
      ['BED=', 'param'],
      ['{bed_temperature[0]; 1}', 'var'],
    ]);
  });
  it('colors a command after {if …}', () => {
    expect(tokenizeLine('{if x > 1}M106 S0{endif}')).toEqual([
      ['{if x > 1}', 'var'],
      ['M106', 'cmd'],
      [' ', null],
      ['S', 'param'],
      ['0', null],
      ['{endif}', 'var'],
    ]);
  });
  it('keeps the text unchanged', () => {
    const line = '  {if layer_z > 1}M106 S255{endif} ;x;y';
    expect(
      tokenizeLine(line)
        .map(([s]) => s)
        .join(''),
    ).toBe(line);
  });
});
