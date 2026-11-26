// Support blockers and enforcers: desktop's sizes, where they are in the world, and the engine's
// layout with them.
// SPDX-License-Identifier: AGPL-3.0-or-later
import { Matrix4, Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { engineLayout } from '../src/state/engineLayout';
import type { SceneObject, SceneVolume } from '../src/state/store';
import { defaultSize, shapeExtent, volumeMatrixFor, volumeWorld } from '../src/state/supportVolumes';

const object = (id: string, index: number, instance: Matrix4, volumes?: SceneVolume[]): SceneObject => ({
  id,
  index,
  name: id,
  triangles: 12,
  parts: 1,
  modifiers: 0,
  hasConfig: false,
  instances: [instance.toArray()],
  painted: false,
  ...(volumes ? { volumes } : {}),
});
const cube = (id: string, matrix = new Matrix4()): SceneVolume => ({
  id,
  type: 'support_blocker',
  shape: 'cube',
  size: [10, 10, 10],
  matrix: matrix.toArray(),
});

describe('support volumes', () => {
  it('have desktop’s sizes', () => {
    expect(defaultSize('cube', 25)).toEqual([25, 25, 25]);
    expect(defaultSize('cylinder', 25)).toEqual([25, 25]);
    expect(defaultSize('sphere', 25)).toEqual([25]);
    expect(defaultSize('disc', 25)).toEqual([25, 0.2]);
    expect(defaultSize('torus', 20)).toEqual([15, 5]);
    expect(shapeExtent('torus', [15, 5])).toEqual([25, 25, 5]);
    expect(shapeExtent('cone', [20, 30])).toEqual([20, 20, 30]);
  });

  it('are placed in the world through a rotated and scaled object', () => {
    const inst = new Matrix4().compose(
      new Vector3(100, 80, 10),
      new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), Math.PI / 3),
      new Vector3(2, 2, 2),
    );
    const o = object('a', 0, inst, [cube('v')]);
    const v = o.volumes![0]!;
    const at = {
      position: [120, 70, 15] as [number, number, number],
      rotation: [0, 0, 30] as [number, number, number],
      size: [40, 20, 10] as [number, number, number],
    };
    const moved = { ...v, matrix: volumeMatrixFor(o, v, at) };
    const w = volumeWorld(o, moved);
    w.position.forEach((x, i) => expect(x).toBeCloseTo(at.position[i]!, 6));
    w.rotation.forEach((x, i) => expect(x).toBeCloseTo(at.rotation[i]!, 6));
    w.size.forEach((x, i) => expect(x).toBeCloseTo(at.size[i]!, 6));
  });

  it('go to the engine with their object; copies with other volumes are objects of their own', () => {
    const at = new Matrix4().makeTranslation(50, 50, 0);
    const layout = engineLayout([
      object('a', 0, at, [cube('v1')]),
      object('b', 0, at, [cube('v1')]),
      object('c', 0, at, [cube('v1', new Matrix4().makeTranslation(5, 0, 0))]),
      object('d', 0, at),
    ]);
    expect(layout.map((e) => [e.index, e.instances.length, e.volumes?.length ?? 0])).toEqual([
      [0, 2, 1],
      [0, 1, 1],
      [0, 1, 0],
    ]);
    // Without the app's ids.
    expect(Object.keys(layout[0]!.volumes![0]!).sort()).toEqual(['matrix', 'shape', 'size', 'type']);
  });
});
