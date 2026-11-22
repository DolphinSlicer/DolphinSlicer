// The settings layout extracted from desktop Tab.cpp, checked against the engine's schema.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const app = resolve(import.meta.dirname, '..');
const layout = JSON.parse(readFileSync(resolve(app, 'src/settings/layout.json'), 'utf8'));
const schemaPath = resolve(app, 'public/settings-schema.json');
const hidden = JSON.parse(readFileSync(resolve(app, 'test/fixtures/hidden-keys.json'), 'utf8'));
const types = ['print', 'filament', 'printer'] as const;
const placed = (t: string) => new Set<string>(layout[t].flatMap((p: { groups: { keys: string[] }[] }) => p.groups.flatMap((g) => g.keys)));

describe('settings layout', () => {
  it.skipIf(!existsSync(resolve(app, '../.work/orca-src/src/slic3r/GUI/Tab.cpp')))(
    'matches a fresh extraction from the pinned Tab.cpp',
    () => {
      execFileSync('node', ['scripts/extract-layout.mjs', '--check'], { cwd: app, stdio: 'pipe' });
    },
  );

  it('has the desktop tab pages', () => {
    expect(layout.print.map((p: { title: string }) => p.title)).toEqual([
      'Quality',
      'Strength',
      'Speed',
      'Support',
      'Multimaterial',
      'Others',
      'Dependencies',
    ]);
    expect(layout.filament.map((p: { title: string }) => p.title)).toContain('Setting Overrides');
    expect(layout.printer.at(-1).title).toBe('Notes');
  });

  describe.skipIf(!existsSync(schemaPath))('against the engine schema (npm run assets)', () => {
    const schema = existsSync(schemaPath) ? JSON.parse(readFileSync(schemaPath, 'utf8')) : null;
    it.each(types)('%s: every placed key exists and belongs to the tab', (t) => {
      const own = new Set(schema[t]);
      for (const k of placed(t)) {
        expect(schema.options[k], k).toBeTruthy();
        expect(own.has(k), `${k} is not a ${t} option`).toBe(true);
      }
    });
    it.each(types)('%s: keys the desktop tab does not show are exactly the pinned list', (t) => {
      const p = placed(t);
      expect([...new Set<string>(schema[t])].filter((k) => !p.has(k)).sort()).toEqual(hidden[t]);
    });
  });
});
