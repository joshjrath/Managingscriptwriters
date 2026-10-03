// The Control Center's sound (client/src/control/sound.ts): it must let the audio device rest when
// sound is off or the Control Center is left, without cutting a hum that's switched straight back on.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

class FakeParam { value = 0; cancelScheduledValues() { return this; } setTargetAtTime(v: number) { this.value = v; return this; } setValueAtTime() { return this; } linearRampToValueAtTime() { return this; } exponentialRampToValueAtTime() { return this; } }
class FakeNode { gain = new FakeParam(); frequency = new FakeParam(); type = ''; connect<T>(n: T) { return n; } disconnect() {} }
const oscs: FakeOsc[] = [];
class FakeOsc extends FakeNode { running = false; start() { this.running = true; } stop() { this.running = false; } constructor() { super(); oscs.push(this); } }
class FakeCtx {
  state: 'running' | 'suspended' = 'suspended'; currentTime = 0; destination = new FakeNode();
  resumes = 0; suspends = 0;
  resume() { this.resumes++; this.state = 'running'; return Promise.resolve(); }
  suspend() { this.suspends++; this.state = 'suspended'; return Promise.resolve(); }
  createGain() { return new FakeNode(); } createBiquadFilter() { return new FakeNode(); } createOscillator() { return new FakeOsc(); }
}
let made: FakeCtx[] = [];

describe('Control Center sound', () => {
  beforeEach(() => {
    vi.useFakeTimers(); vi.resetModules(); made = []; oscs.length = 0;
    vi.stubGlobal('window', { AudioContext: class extends FakeCtx { constructor() { super(); made.push(this); } } });
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('suspends the audio context once sound is off, and resumes it when it comes back', async () => {
    const { sound } = await import('../client/src/control/sound');
    sound.setEnabled(true);
    expect(made[0].state).toBe('running');
    sound.setEnabled(false);
    vi.advanceTimersByTime(1000);
    expect(made[0].state).toBe('suspended');
    sound.setEnabled(true);
    expect(made[0].state).toBe('running');
    expect(oscs.filter((o) => o.running)).toHaveLength(4);
  });

  it('keeps the hum when sound is turned off and on again quickly', async () => {
    const { sound } = await import('../client/src/control/sound');
    sound.setEnabled(true);
    sound.setEnabled(false);
    vi.advanceTimersByTime(300);
    sound.setEnabled(true);
    vi.advanceTimersByTime(2000);
    expect(made[0].state).toBe('running');
    expect(oscs.filter((o) => o.running)).toHaveLength(4);
  });

  it('plays no tones while asleep, so none pile up for the next wake', async () => {
    const { sound } = await import('../client/src/control/sound');
    sound.setEnabled(true);
    sound.setEnabled(false);
    sound.enabled = true; // as if left on: only the sleep is in the way
    vi.advanceTimersByTime(1000);
    const before = oscs.length;
    sound.select();
    expect(oscs.length).toBe(before);
    sound.wake();
    sound.select();
    expect(oscs.length).toBeGreaterThan(before);
  });
});
