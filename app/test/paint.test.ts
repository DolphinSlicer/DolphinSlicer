// SPDX-License-Identifier: AGPL-3.0-or-later

import { BoxGeometry, Matrix4 } from 'three';
import { describe, expect, it } from 'vitest';
import type { PaintData } from '../src/engine/types';
import { engineLayout } from '../src/state/engineLayout';
import type { SceneObject } from '../src/state/store';
import { overhangs, PaintLayer } from '../src/view/paintLayer';

const obj = (id: string, index: number, x: number, supports?: PaintData): SceneObject => ({
  id,
  index,
  name: id,
  triangles: 12,
  parts: 1,
  modifiers: 0,
  hasConfig: false,
  painted: !!supports,
  instances: [new Matrix4().makeTranslation(x, 0, 0).toArray()],
  ...(supports ? { supports } : {}),
});

describe('support painting', () => {
  it('copies are instances of one engine object, unless painted otherwise', () => {
    const paint: PaintData = [[[0, '4']]];
    const a = obj('a', 0, 0, paint),
      copy = obj('b', 0, 50, paint),
      other = obj('c', 0, 100, [[[1, '8']]]),
      plain = obj('d', 0, 150);
    const layout = engineLayout([a, copy, other, plain]);
    expect(layout.map((o) => [o.index, o.instances.length, o.supports])).toEqual([
      [0, 2, paint],
      [0, 1, [[[1, '8']]]],
      [0, 1, undefined],
    ]);
    expect('supports' in layout[2]!).toBe(false);
  });

  it('highlights the faces that point down more steeply than the limit, and those on the bed', () => {
    // A 10 mm cube from z = 0 to 10: its bottom is on the bed.
    const cube = new BoxGeometry(10, 10, 10).translate(0, 0, 5);
    const limit = -Math.cos((46 * Math.PI) / 180);
    let [red, blue] = overhangs(cube, new Matrix4(), limit);
    expect([red.length / 9, blue.length / 9]).toEqual([0, 2]);
    // Lifted: the bottom is an overhang.
    [red, blue] = overhangs(cube, new Matrix4().makeTranslation(0, 0, 5), limit);
    expect([red.length / 9, blue.length / 9]).toEqual([2, 0]);
    // Upside down, mirrored: still its (now lower) face.
    [red] = overhangs(cube, new Matrix4().makeScale(1, 1, -1).setPosition(0, 0, 20), limit);
    expect(red.length / 9).toBe(2);
  });

  it('draws only the blocks of paint that changed', () => {
    const layer = new PaintLayer();
    layer.show(new BoxGeometry(10, 10, 10), [new Matrix4().toArray(), new Matrix4().makeTranslation(20, 0, 0).toArray()], 0);
    const tri = () => new Float32Array(9);
    const empty = () => new Float32Array();
    const meshes = () => layer.group.children.filter((g) => g.type === 'Group' && g.children.length > 2).map((g) => g.children.length - 2);
    layer.setRender({
      full: true,
      blocks: [
        { key: '0:0', groups: [tri(), empty(), empty(), empty(), empty()] },
        { key: '0:1', groups: [empty(), tri(), empty(), empty(), empty()] },
      ],
    });
    expect(meshes()).toEqual([10, 10]);
    // One block changed: the other stays as it was.
    layer.setRender({ full: false, blocks: [{ key: '0:1', groups: [empty(), empty(), empty(), empty(), empty()] }] });
    expect(meshes()).toEqual([5, 5]);
    // Shown again (the object moved): its blocks come along.
    layer.show(new BoxGeometry(10, 10, 10), [new Matrix4().toArray()], 0);
    expect(meshes()).toEqual([5]);
    layer.setRender({ full: true, blocks: [] });
    expect(meshes()).toEqual([]);
  });
});
