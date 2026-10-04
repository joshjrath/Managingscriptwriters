// Optional sound, off by default: a very low hum, a soft tone on
// authorization, a tick on selection, a quiet pulse when a transfer lands.
// All synthesized; no files, nothing loud, never a "computer beep".

const KEY = 'cc.sound';

class Sound {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private hum: { stop: () => void } | null = null;
  /** the pending end of a fade-out, and whether the audio has been put to sleep (suspended) */
  private sleepTimer: ReturnType<typeof setTimeout> | null = null;
  private asleep = false;
  /** whether the hum was playing when the tab was hidden, so showing the tab brings it back */
  private hiddenAwake = false;
  enabled = false;

  constructor() {
    try { this.enabled = localStorage.getItem(KEY) === 'on'; } catch { /* private mode */ }
  }

  private ensure(): AudioContext | null {
    if (this.ctx) return this.ctx;
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    this.ctx = new Ctor();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0;
    this.master.connect(this.ctx.destination);
    return this.ctx;
  }

  /** Must be called from a user gesture the first time. */
  setEnabled(on: boolean) {
    this.enabled = on;
    try { localStorage.setItem(KEY, on ? 'on' : 'off'); } catch { /* ignore */ }
    if (on) this.wake();
    else this.sleep();
  }

  wake() {
    if (!this.enabled) return;
    const ctx = this.ensure();
    if (!ctx || !this.master) return;
    if (this.sleepTimer) { clearTimeout(this.sleepTimer); this.sleepTimer = null; }
    this.asleep = false;
    void ctx.resume();
    this.master.gain.cancelScheduledValues(ctx.currentTime);
    this.master.gain.setTargetAtTime(0.5, ctx.currentTime, 0.6);
    if (!this.hum) this.hum = this.startHum(ctx, this.master);
  }

  sleep() {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    this.master.gain.setTargetAtTime(0, ctx.currentTime, 0.25);
    // once faded out, stop the hum and suspend the audio so the device can rest
    // (kept from the first call if sleep comes twice, so a later wake can always cancel it)
    this.sleepTimer ??= setTimeout(() => { this.sleepTimer = null; this.asleep = true; this.hum?.stop(); this.hum = null; void ctx.suspend(); }, 900);
  }

  /**
   * The tab was hidden or shown: rest while hidden, and on return wake only a hum that was playing
   * (sound left on from an earlier visit still waits for the first touch or key: showing a tab isn't one).
   */
  visibility(hidden: boolean) {
    if (hidden) {
      this.hiddenAwake ||= this.hum !== null && this.sleepTimer === null;
      this.sleep();
    } else if (this.hiddenAwake) {
      this.hiddenAwake = false;
      this.wake();
    }
  }

  private startHum(ctx: AudioContext, out: GainNode) {
    const g = ctx.createGain();
    g.gain.value = 0.028;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 180;
    const a = ctx.createOscillator(); a.frequency.value = 55;
    const b = ctx.createOscillator(); b.frequency.value = 55.35;
    const c = ctx.createOscillator(); c.frequency.value = 82.6; c.type = 'sine';
    const cg = ctx.createGain(); cg.gain.value = 0.35;
    const lfo = ctx.createOscillator(); lfo.frequency.value = 0.07;
    const lg = ctx.createGain(); lg.gain.value = 0.012;
    lfo.connect(lg).connect(g.gain);
    a.connect(lp); b.connect(lp); c.connect(cg).connect(lp);
    lp.connect(g).connect(out);
    for (const o of [a, b, c, lfo]) o.start();
    return { stop: () => { for (const o of [a, b, c, lfo]) { try { o.stop(); } catch { /* already */ } } g.disconnect(); } };
  }

  private tone(freq: number, dur: number, gain: number, type: OscillatorType = 'sine', glide?: number) {
    // asleep the output is silent and the clock stopped: a tone would only queue up for the next wake
    if (!this.enabled || this.asleep) return;
    const ctx = this.ensure();
    if (!ctx || !this.master) return;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (glide) o.frequency.exponentialRampToValueAtTime(glide, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  select() { this.tone(1320, 0.07, 0.035, 'sine', 990); }
  hover() { this.tone(2200, 0.03, 0.01); }
  transfer() { this.tone(520, 0.5, 0.04, 'sine', 780); }
  mode() { this.tone(180, 0.6, 0.03, 'sine', 120); }
  authorized() {
    this.tone(440, 0.5, 0.035);
    setTimeout(() => this.tone(660, 0.8, 0.03), 140);
  }
  denied() { this.tone(160, 0.35, 0.04, 'triangle', 120); }
}

export const sound = new Sound();
