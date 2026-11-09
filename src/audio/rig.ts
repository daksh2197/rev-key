/**
 * The rig: everything that makes sound, behind a small interface the screen can drive.
 *
 *   master cap ─ highpass 32 Hz ─ limiter ─ speakers
 *     ├─ calm lane bus
 *     ├─ pump lane bus
 *     └─ engine (two oscillators through a lowpass, so the demo has a drone to lock to)
 *
 * The band is scheduled ahead of time. Every 25 ms a timer asks `stepsDue` which sixteenth
 * notes fall inside the next 120 ms of audio-clock time and books their notes with the
 * AudioContext. The browser then plays them at exactly those times, whatever the main thread is
 * doing. A notes-when-the-timer-fires approach would stutter the moment a Bluetooth packet or a
 * heavy frame delayed the timer; booking ahead is what keeps the beat straight.
 *
 * The rig never starts on its own: browsers only allow sound after a user gesture, and the
 * `start()` call must come from one.
 */

import { laneGains } from '../core/lanes';
import { DROP, eventsAt, type ScheduleCursor, STEP_SECONDS, stepsDue } from '../core/patterns';
import { makeNoise, play, type VoiceContext } from './voices';

/** How far ahead notes are booked, in seconds. */
export const LOOKAHEAD_S = 0.12;
/** How often the scheduler runs. */
export const TICK_MS = 25;

export interface EngineSound {
  hz: number;
  /** 0 to 1. */
  throttle: number;
  /** 0 to 1, the "engine in cabin" slider. */
  level: number;
}

export class Rig {
  private ctx: AudioContext | null = null;
  private voices: VoiceContext | null = null;
  private master!: GainNode;
  private calmBus!: GainNode;
  private pumpBus!: GainNode;
  private engineGain!: GainNode;
  private engineFilter!: BiquadFilterNode;
  private engineOsc1!: OscillatorNode;
  private engineOsc2!: OscillatorNode;
  private cursor: ScheduleCursor = { nextTime: 0, step: 0 };
  private timer: number | null = null;
  private rootMidi = 45;
  private cap = 0.7;
  private volumeFraction = 1;
  private pendingDropAt: number | null = null;

  get running(): boolean {
    return this.timer !== null;
  }

  /** Seconds between booking a sound and the speaker making it, as far as the browser knows. */
  get outputLatencySeconds(): number {
    if (!this.ctx) return 0;
    const base = Number.isFinite(this.ctx.baseLatency) ? this.ctx.baseLatency : 0;
    const out = 'outputLatency' in this.ctx && Number.isFinite(this.ctx.outputLatency) ? this.ctx.outputLatency : 0;
    return base + out;
  }

  /** Build the graph. Call from a click handler. Throws if the browser has no Web Audio. */
  private build(): void {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) throw new Error('This browser has no Web Audio.');
    const ctx = new Ctor({ latencyHint: 'interactive' });
    this.ctx = ctx;
    this.voices = { ctx, noise: makeNoise(ctx) };

    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -10;
    limiter.knee.value = 6;
    limiter.ratio.value = 12;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.2;
    const highpass = ctx.createBiquadFilter();
    highpass.type = 'highpass';
    highpass.frequency.value = 32; // keep the sub out of trouble on small speakers
    this.master = ctx.createGain();
    this.master.gain.value = this.cap * this.volumeFraction;
    this.master.connect(highpass).connect(limiter).connect(ctx.destination);

    this.calmBus = ctx.createGain();
    this.pumpBus = ctx.createGain();
    this.pumpBus.gain.value = 0;
    this.calmBus.connect(this.master);
    this.pumpBus.connect(this.master);

    this.engineOsc1 = ctx.createOscillator();
    this.engineOsc1.type = 'sawtooth';
    this.engineOsc2 = ctx.createOscillator();
    this.engineOsc2.type = 'triangle';
    this.engineFilter = ctx.createBiquadFilter();
    this.engineFilter.type = 'lowpass';
    this.engineFilter.Q.value = 2;
    this.engineGain = ctx.createGain();
    this.engineGain.gain.value = 0;
    const half = ctx.createGain();
    half.gain.value = 0.6;
    this.engineOsc1.connect(this.engineFilter);
    this.engineOsc2.connect(half).connect(this.engineFilter);
    this.engineFilter.connect(this.engineGain).connect(this.master);
    this.engineOsc1.start();
    this.engineOsc2.start();
  }

  /** Start (or resume) sound. Resolves false if the browser refused. */
  async start(): Promise<boolean> {
    if (!this.ctx) this.build();
    const ctx = this.ctx!;
    try {
      await ctx.resume();
    } catch {
      return false;
    }
    if (ctx.state !== 'running') return false;
    if (this.timer === null) {
      this.cursor = { nextTime: ctx.currentTime + 0.05, step: 0 };
      this.timer = window.setInterval(() => this.tick(), TICK_MS);
    }
    return true;
  }

  /** Pause: the graph stays built so the next start is instant. */
  async stop(): Promise<void> {
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
    this.pendingDropAt = null;
    await this.ctx?.suspend().catch(() => undefined);
  }

  /** The song's root after the key lock's shift. Notes booked from now on use it. */
  setRoot(midi: number): void {
    if (Number.isFinite(midi)) this.rootMidi = midi;
  }

  /** 0 = all calm lane, 1 = all pump lane. Smoothed over 50 ms. */
  setMix(pump: number): void {
    if (!this.ctx) return;
    const g = laneGains(pump);
    const t = this.ctx.currentTime;
    this.calmBus.gain.setTargetAtTime(g.calm, t, 0.05);
    this.pumpBus.gain.setTargetAtTime(g.pump, t, 0.05);
  }

  /** The driver's cap, 0 to 1. The only control that can raise the volume. */
  setCap(cap: number): void {
    this.cap = Math.min(1, Math.max(0, Number.isFinite(cap) ? cap : 0));
    this.applyVolume(0.1);
  }

  /** Fraction of the cap to play at (counter-steer lowers it). Never above 1. */
  setVolumeFraction(fraction: number): void {
    this.volumeFraction = Math.min(1, Math.max(0, Number.isFinite(fraction) ? fraction : 1));
    this.applyVolume(0.3);
  }

  private applyVolume(seconds: number): void {
    if (!this.ctx) return;
    this.master.gain.setTargetAtTime(this.cap * this.volumeFraction, this.ctx.currentTime, seconds);
  }

  setEngine(sound: EngineSound): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const hz = Math.max(1, Number.isFinite(sound.hz) ? sound.hz : 1);
    const thr = Math.min(1, Math.max(0, sound.throttle));
    const level = Math.min(1, Math.max(0, sound.level));
    this.engineOsc1.frequency.setTargetAtTime(hz, t, 0.02);
    this.engineOsc2.frequency.setTargetAtTime(hz / 2, t, 0.02);
    this.engineFilter.frequency.setTargetAtTime(hz * 3 + thr * 1200, t, 0.03);
    this.engineGain.gain.setTargetAtTime(level * (0.1 + thr * 0.12), t, 0.05);
  }

  /**
   * Book the shift drop `inSeconds` from now, snapped to the next eighth note at or after that
   * moment so it lands with the music. A pending drop is replaced, never doubled. Steps inside
   * the look-ahead window are already booked, so the soonest a drop can sound is one window
   * away: that is why the shift detector is given a lead time.
   */
  drop(inSeconds: number): void {
    if (!this.ctx || !this.running) return;
    const at = this.ctx.currentTime + Math.max(0, Number.isFinite(inSeconds) ? inSeconds : 0);
    this.pendingDropAt = at;
  }

  private tick(): void {
    const ctx = this.ctx;
    const voices = this.voices;
    if (!ctx || !voices) return;
    const { due, cursor } = stepsDue(this.cursor, ctx.currentTime, LOOKAHEAD_S);
    this.cursor = cursor;
    for (const d of due) {
      for (const e of eventsAt('calm', d.step)) play(voices, this.calmBus, e, d.nextTime, this.rootMidi, STEP_SECONDS);
      for (const e of eventsAt('pump', d.step)) play(voices, this.pumpBus, e, d.nextTime, this.rootMidi, STEP_SECONDS);
      // The drop waits for an eighth note (every second step) at or after its requested time.
      if (this.pendingDropAt !== null && d.step % 2 === 0 && d.nextTime >= this.pendingDropAt - STEP_SECONDS / 2) {
        for (const e of DROP) play(voices, this.master, e, d.nextTime, this.rootMidi, STEP_SECONDS);
        this.pendingDropAt = null;
      }
    }
  }
}
