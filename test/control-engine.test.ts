// The Control Center's engine pieces that run without a GPU: the work it saves
// must give exactly what it gave before (see the What's new entry of 2026-10-03).

import { describe, expect, it, vi } from 'vitest';
import { BufferAttribute, Mesh, Quaternion } from 'three';
import { coverageOf, localClock, metricsOf } from '../shared/control';
import { simulatedWorld } from '../server/control/simulated';
import { geoStore } from '../client/src/control/geo';
import { blinkDim, breathe, easeInOut } from '../client/src/control/pulse';
import { deadlineOrbit, projectOrbit } from '../client/src/control/engine/layout';
import { ORBIT_EXTENT, orbitExtent, orbitReaches } from '../client/src/control/engine/rings';
import { landMask } from '../client/src/control/engine/landmask';
import { buildAtmosphere, buildCore, buildShell } from '../client/src/control/engine/globe';
import { NodesLayer } from '../client/src/control/engine/nodes';

const AT = new Date('2026-09-30T05:24:18Z');

describe('the pointer readout', () => {
  it('tells its readers only when the four decimals shown would change', () => {
    const geo = geoStore();
    const seen = vi.fn();
    geo.subscribe(seen);
    geo.set(null);
    expect(seen).not.toHaveBeenCalled();
    geo.set({ lat: 40.71281, lon: -74.00601 });
    geo.set({ lat: 40.71284, lon: -74.00598 }); // the same digits on screen
    expect(seen).toHaveBeenCalledTimes(1);
    geo.set({ lat: 40.7129, lon: -74.006 });
    geo.set(null);
    expect(seen).toHaveBeenCalledTimes(3);
    expect(geo.get()).toBeNull();
  });
});

describe('the brand dot and pressure marks', () => {
  it('ease in and out exactly as CSS does', () => {
    // the reference: cubic-bezier(0.42, 0, 0.58, 1) solved by bisection
    const ref = (x: number) => {
      const bx = (t: number) => 3 * (1 - t) ** 2 * t * 0.42 + 3 * (1 - t) * t * t * 0.58 + t ** 3;
      let lo = 0, hi = 1;
      for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; if (bx(m) < x) lo = m; else hi = m; }
      const t = (lo + hi) / 2;
      return 3 * (1 - t) * t * t + t ** 3;
    };
    for (let x = 0; x <= 1.0001; x += 0.01) expect(easeInOut(x)).toBeCloseTo(ref(Math.min(1, x)), 9);
    expect(easeInOut(0.5)).toBeCloseTo(0.5, 12);
  });

  it('breathe over 3.4 s and blink bright 0.45 s, dim 0.9 s, bright 0.45 s', () => {
    expect([breathe(0), breathe(1700), breathe(3400)]).toEqual([0, 1, 0]);
    expect(breathe(850)).toBeCloseTo(breathe(2550), 12);
    expect([0, 449, 450, 1349, 1350, 1799, 1800].map(blinkDim)).toEqual([false, false, true, true, false, false, false]);
  });
});

describe('deadline orbits', () => {
  it('put a project closer, and twice as fast, in its last day', () => {
    const far = projectOrbit({ deadline: '2026-10-20T21:00:00Z', archived: false }, AT);
    const near = projectOrbit({ deadline: '2026-09-30T15:00:00Z', archived: false }, AT);
    expect(far).toEqual({ orbitR: deadlineOrbit('2026-10-20T21:00:00Z', AT).radius, orbitW: 0.05 / Math.pow(far.orbitR, 1.5), urgent: false });
    expect(near.urgent).toBe(true);
    expect(near.orbitW).toBeCloseTo((0.05 / Math.pow(near.orbitR, 1.5)) * 2, 12);
    expect(projectOrbit({ deadline: '2026-09-30T15:00:00Z', archived: true }, AT).urgent).toBe(false);
  });

  it('draw each ring on a square just past it, never bigger than before', () => {
    for (const r of [0, 1.3, 2.4, 3.2, 3.3, 5]) {
      const e = orbitExtent(r);
      expect(e).toBeLessThanOrEqual(ORBIT_EXTENT);
      if (r + 0.2 <= ORBIT_EXTENT) expect(e).toBeGreaterThanOrEqual(r + 0.2);
    }
    expect(orbitReaches(3, orbitExtent(3))).toBe(true);
    expect(orbitReaches(6, orbitExtent(6))).toBe(false);
  });
});

describe('clocks and headline numbers', () => {
  it('read a zone once a second, with the same answer as reading it fresh', () => {
    const spy = vi.spyOn(Intl.DateTimeFormat.prototype, 'formatToParts');
    const t = Date.UTC(2026, 2, 29, 0, 59, 59); // a second before London's clocks go forward
    const a = localClock('Europe/London', new Date(t));
    localClock('Asia/Tokyo', new Date(t + 10));
    expect(localClock('Europe/London', new Date(t + 999))).toBe(a);
    const next = localClock('Europe/London', new Date(t + 1000));
    expect([a.time, next.time, a.offset, next.offset]).toEqual(['00:59:59', '02:00:00', 0, 60]);
    expect(spy).toHaveBeenCalledTimes(3);
    spy.mockRestore();
    expect(localClock('UTC', new Date(-1500)).time).toBe('23:59:58');
  });

  it('are the same whether coverage is worked out once or each time', () => {
    const world = simulatedWorld(AT, 'Test');
    expect(metricsOf(world, AT, coverageOf(world.writers, AT))).toEqual(metricsOf(world, AT));
  });
});

describe('the globe', () => {
  it('decodes the land afresh each time rather than keeping a copy', () => {
    const a = landMask(), b = landMask();
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
    expect(a.reduce((n, x) => n + x, 0) / a.length).toBeCloseTo(0.331, 3);
  });

  it('shares one sphere between the core, halo and rim, each at its own size', () => {
    const shell = buildShell();
    const core = buildCore(shell);
    const atmo = buildAtmosphere(shell);
    expect(shell.getAttribute('uv')).toBeUndefined();
    expect([core.mesh, atmo.haloMesh, atmo.rimMesh].every((m: Mesh) => m.geometry === shell)).toBe(true);
    expect([core.mesh.scale.x, atmo.haloMesh.scale.x, atmo.rimMesh.scale.x]).toEqual([0.994, 1.2, 1.006]);
  });

  it('sends the GPU only the people in view, not every slot', () => {
    const nodes = new NodesLayer(128);
    nodes.setCount(5);
    nodes.update(1, 1, new Quaternion());
    expect(nodes.glyphs.instanceMatrix.updateRanges).toEqual([{ start: 0, count: 5 * 16 }]);
    expect((nodes.cores.geometry.getAttribute('position') as BufferAttribute).updateRanges).toEqual([{ start: 0, count: 5 * 3 }]);
    expect((nodes.beams.geometry.getAttribute('position') as BufferAttribute).updateRanges).toEqual([{ start: 0, count: 5 * 2 * 3 }]);
  });
});
