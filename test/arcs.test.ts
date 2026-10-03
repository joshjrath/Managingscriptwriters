// Handoff packets on the globe's arcs (client/src/control/engine/arcs.ts): a packet that
// never lands must say so, or its label is left behind.

import { describe, expect, it, vi } from 'vitest';
import { Color, Vector3 } from 'three';
import { ArcsLayer, type ArcDef } from '../client/src/control/engine/arcs';

const arc = (key: string, x: number): ArcDef => ({ key, from: new Vector3(1, 0, 0), to: new Vector3(0, x, 1).normalize(), color: new Color(1, 1, 1) });

describe('handoff packets', () => {
  it('tells a packet it was dropped when another takes its arc', () => {
    const layer = new ArcsLayer();
    layer.setArcs([arc('a|b', 0.1), arc('a|c', 0.5)]);
    const first = { arrive: vi.fn(), cancel: vi.fn() };
    const second = { arrive: vi.fn(), cancel: vi.fn() };
    layer.launch(0, false, 0, 2.8, first.arrive, first.cancel);
    layer.update(1, 1 / 60, 1, 1);
    layer.launch(0, false, 1, 2.8, second.arrive, second.cancel);
    expect(first.cancel).toHaveBeenCalledOnce();
    layer.update(4, 1 / 60, 1, 1);
    expect(first.arrive).not.toHaveBeenCalled();
    expect(second.arrive).toHaveBeenCalledOnce();
    expect(second.cancel).not.toHaveBeenCalled();
  });

  it('keeps a packet on its own arc when the arcs are rebuilt, and drops it when its arc goes', () => {
    const layer = new ArcsLayer();
    layer.setArcs([arc('a|b', 0.1), arc('a|c', 0.5)]);
    const cancel = vi.fn();
    layer.launch(1, false, 0, 2.8, undefined, cancel);
    layer.setArcs([arc('a|d', 0.9), arc('a|b', 0.1), arc('a|c', 0.5)]);
    const out = new Vector3();
    expect(layer.packetPosition(layer.indexOf('a|c'), 1, out)).not.toBeNull();
    expect(layer.packetPosition(layer.indexOf('a|b'), 1, out)).toBeNull();
    layer.setArcs([arc('a|d', 0.9)]);
    expect(cancel).toHaveBeenCalledOnce();
    expect(layer.busy).toBe(false);
  });
});
