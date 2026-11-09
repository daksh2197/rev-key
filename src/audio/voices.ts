/**
 * The instruments: small Web Audio voices, one function each. Every voice takes the time it
 * should sound (on the audio clock), the bus to play into and what to play, builds its nodes,
 * starts them and lets them stop themselves. Nothing here keeps state between notes.
 *
 * Volumes are deliberately low. The master bus has a compressor acting as a limiter, and the
 * driver's cap sits above that, so nothing here can get loud on its own.
 */

import type { NoteEvent } from '../core/patterns';
import { hzFromMidi } from '../core/engine';

export interface VoiceContext {
  ctx: AudioContext;
  /** One second of white noise, made once. */
  noise: AudioBuffer;
}

/** Attack to a peak, then an exponential tail. Exponential ramps cannot reach 0, hence the tiny floor. */
function envelope(gain: GainNode, t: number, attack: number, peak: number, decay: number): void {
  const p = Math.max(0.0002, peak);
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(p, t + attack);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
}

function kick(v: VoiceContext, t: number, bus: AudioNode, vel: number): void {
  const o = v.ctx.createOscillator();
  const g = v.ctx.createGain();
  o.frequency.setValueAtTime(140, t);
  o.frequency.exponentialRampToValueAtTime(42, t + 0.12);
  envelope(g, t, 0.003, 0.9 * vel, 0.32);
  o.connect(g).connect(bus);
  o.start(t);
  o.stop(t + 0.45);
}

function noiseHit(v: VoiceContext, t: number, bus: AudioNode, type: BiquadFilterType, freq: number, q: number, vel: number, decay: number): void {
  const s = v.ctx.createBufferSource();
  const f = v.ctx.createBiquadFilter();
  const g = v.ctx.createGain();
  s.buffer = v.noise;
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q;
  envelope(g, t, 0.002, vel, decay);
  s.connect(f).connect(g).connect(bus);
  s.start(t);
  s.stop(t + decay + 0.05);
}

function tone(
  v: VoiceContext,
  t: number,
  bus: AudioNode,
  type: OscillatorType,
  hz: number,
  vel: number,
  attack: number,
  decay: number,
  lowpass?: number,
): void {
  const o = v.ctx.createOscillator();
  const g = v.ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(Math.max(20, hz), t);
  envelope(g, t, attack, vel, decay);
  if (lowpass) {
    const f = v.ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = lowpass;
    o.connect(f).connect(g);
  } else {
    o.connect(g);
  }
  g.connect(bus);
  o.start(t);
  o.stop(t + attack + decay + 0.05);
}

/** A soft-clipped sine for the 808-style bass. The curve is built once. */
let softClip: Float32Array<ArrayBuffer> | null = null;
function clipCurve(): Float32Array<ArrayBuffer> {
  if (!softClip) {
    softClip = new Float32Array(256);
    for (let i = 0; i < 256; i++) softClip[i] = Math.tanh(1.8 * (i / 128 - 1));
  }
  return softClip;
}

function bass(v: VoiceContext, t: number, bus: AudioNode, hz: number, seconds: number, vel: number, glideToHz?: number): void {
  const o = v.ctx.createOscillator();
  const g = v.ctx.createGain();
  const shaper = v.ctx.createWaveShaper();
  shaper.curve = clipCurve();
  o.type = 'sine';
  o.frequency.setValueAtTime(Math.max(20, hz), t);
  if (glideToHz) {
    o.frequency.setValueAtTime(Math.max(20, hz), t + seconds * 0.55);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, glideToHz), t + seconds * 0.8);
  }
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.55 * vel, t + 0.005);
  g.gain.setTargetAtTime(0.0001, t + seconds * 0.7, seconds * 0.15);
  o.connect(shaper).connect(g).connect(bus);
  o.start(t);
  o.stop(t + seconds + 0.3);
}

/**
 * Play one event. `rootMidi` is the song's root after the key lock's shift (fractional is fine),
 * `stepSeconds` turns the event's length in steps into time.
 */
export function play(v: VoiceContext, bus: AudioNode, event: NoteEvent, at: number, rootMidi: number, stepSeconds: number): void {
  const t = at + ((event.thirds ?? 0) * stepSeconds) / 3;
  const pitch = hzFromMidi(rootMidi + event.interval + 12 * event.octave);
  const seconds = event.steps * stepSeconds;
  const vel = Math.min(1, Math.max(0, event.velocity));
  switch (event.voice) {
    case 'kick':
      return kick(v, t, bus, vel);
    case 'snare':
      noiseHit(v, t, bus, 'bandpass', 1900, 0.8, 0.65 * vel, 0.16);
      return noiseHit(v, t, bus, 'highpass', 3000, 1, 0.3 * vel, 0.08);
    case 'hat':
      return noiseHit(v, t, bus, 'highpass', 8000, 1, 0.25 * vel, 0.04);
    case 'open-hat':
      return noiseHit(v, t, bus, 'highpass', 5000, 1, 0.45 * vel, Math.max(0.3, seconds));
    case 'bass':
      return bass(v, t, bus, pitch, seconds, vel, event.glideTo === undefined ? undefined : hzFromMidi(rootMidi + event.glideTo + 12 * event.octave));
    case 'pad':
      return tone(v, t, bus, 'triangle', pitch, 0.1 * vel, 0.4, seconds, 1400);
    case 'pluck':
      return tone(v, t, bus, 'triangle', pitch, 0.16 * vel, 0.003, 0.35, 3200);
    case 'tom':
      return tone(v, t, bus, 'sine', pitch, 1.0 * vel, 0.004, 0.18);
    case 'stab':
      return tone(v, t, bus, 'square', pitch, 0.1 * vel, 0.003, 0.2, 2400);
  }
}

export function makeNoise(ctx: AudioContext): AudioBuffer {
  const buffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  // A fixed seed, so two page loads sound the same; mulberry32 as in the demo drive.
  let a = 0x9e3779b9;
  for (let i = 0; i < data.length; i++) {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = a;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    data[i] = (((x ^ (x >>> 14)) >>> 0) / 4294967296) * 2 - 1;
  }
  return buffer;
}
