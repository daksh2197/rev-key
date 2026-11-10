/**
 * The key lock: when the engine holds a steady note, move the song so that note is the song's
 * root (or its fifth), then let go when the revs move again.
 *
 * Three rules, all tunable from `KeyLockOptions`:
 *
 *   1. Steady first. The lock only engages after the RPM has stayed inside a narrow band for
 *      `steadyMs`. A pull through the gears never locks; a highway cruise does within a second.
 *   2. Smallest move wins. The song can land its root or its fifth on the drone. Whichever needs
 *      the smaller shift is chosen, and a shift beyond `maxShift` semitones is refused: the song
 *      would sound wrong, so it stays in its own key and the screen says "out of reach".
 *   3. Sticky, then gone. Once locked, small wobbles (inside `releaseBandRpm` of the locked RPM)
 *      keep the lock, even if they carry the note a hair past the shift limit. Only a real change
 *      in revs releases it, and then the song glides back to its key.
 *
 * The lock is a pure function of its inputs: feed it samples, read the state. Nothing in here
 * touches audio or the screen, so every rule above is a unit test.
 */

import { type EngineSpec, DEFAULT_ENGINE, engineNote, wrapSemitones } from './engine';

export type LockTarget = 'root' | 'fifth';

export interface KeyLockOptions {
  /** The song's root as a note number. 45 is A2, the demo's key. */
  songRoot: number;
  /** Which notes of the song the drone is allowed to land on. */
  targets: readonly LockTarget[];
  /** Largest shift the lock will apply, in semitones. */
  maxShift: number;
  /** The RPM has to stay inside `steadyBandRpm` for this long before locking. */
  steadyMs: number;
  steadyBandRpm: number;
  /** Below this the engine is idling and the lock stays off. */
  minRpm: number;
  /** Once locked, the lock survives RPM wobble up to this far from the locked RPM. */
  releaseBandRpm: number;
  /** True: shift by the exact fraction so the drone sits dead on the root. False: whole semitones. */
  fine: boolean;
  engine: EngineSpec;
}

export const DEFAULT_LOCK: KeyLockOptions = {
  songRoot: 45,
  targets: ['root', 'fifth'],
  maxShift: 2,
  steadyMs: 1000,
  steadyBandRpm: 80,
  minRpm: 1200,
  releaseBandRpm: 120,
  fine: true,
  engine: DEFAULT_ENGINE,
};

export type LockPhase =
  /** The user turned Rev Key off. The song stays in its own key. */
  | 'off'
  /** Engine below `minRpm`: nothing to lock to. */
  | 'idle'
  /** Revs are moving, or have not been steady for long enough. */
  | 'waiting'
  /** Steady, but the nearest root or fifth is more than `maxShift` away. Song stays put. */
  | 'out-of-reach'
  | 'locked';

export interface KeyLockState {
  phase: LockPhase;
  /** Semitones the song is shifted right now. 0 unless locked. */
  shift: number;
  /** Which note of the song the drone sits on, when locked. */
  target: LockTarget | null;
  /** The RPM the lock engaged at, when locked. */
  lockedRpm: number | null;
  /** The engine's note at the last sample (NaN when off). */
  engineMidi: number;
  /** Milliseconds the revs have been steady, for the screen's progress hint. */
  steadyMs: number;
}

export const INITIAL_LOCK: KeyLockState = {
  phase: 'waiting',
  shift: 0,
  target: null,
  lockedRpm: null,
  engineMidi: Number.NaN,
  steadyMs: 0,
};

export interface LockSample {
  /** Milliseconds, any origin, increasing. */
  t: number;
  rpm: number;
}

/**
 * For a steady engine note, the smallest shift that lands the song's root or fifth on it.
 * Returns null when every allowed target is further than `maxShift`.
 */
export function bestShift(
  engineMidi: number,
  options: Pick<KeyLockOptions, 'songRoot' | 'targets' | 'maxShift' | 'fine'>,
): { shift: number; target: LockTarget } | null {
  if (!Number.isFinite(engineMidi)) return null;
  let best: { shift: number; target: LockTarget } | null = null;
  for (const target of options.targets) {
    const songNote = options.songRoot + (target === 'fifth' ? 7 : 0);
    const raw = engineMidi - songNote;
    const shift = options.fine ? wrapFine(raw) : wrapSemitones(Math.round(raw));
    if (Math.abs(shift) > options.maxShift + 1e-9) continue;
    if (!best || Math.abs(shift) < Math.abs(best.shift)) best = { shift, target };
  }
  return best;
}

/** Like wrapSemitones but keeps the fraction: -6 < result <= 6. */
function wrapFine(diff: number): number {
  let d = ((diff % 12) + 12) % 12;
  if (d > 6) d -= 12;
  return Math.abs(d) < 1e-9 ? 0 : d;
}

/** The lock's memory between samples. Create one per source; reset it when the source changes. */
export class KeyLock {
  private window: LockSample[] = [];
  private state: KeyLockState = INITIAL_LOCK;
  private enabled = true;

  constructor(private options: KeyLockOptions = DEFAULT_LOCK) {}

  get current(): KeyLockState {
    return this.state;
  }

  get settings(): KeyLockOptions {
    return this.options;
  }

  /** Change a setting mid-run. The lock re-evaluates on the next sample. */
  configure(patch: Partial<KeyLockOptions>): void {
    this.options = { ...this.options, ...patch };
    if (this.state.phase === 'locked') {
      // Re-aim at the same engine note under the new rules, or let go if it no longer fits.
      const best = bestShift(this.state.engineMidi, this.options);
      this.state = best
        ? { ...this.state, shift: best.shift, target: best.target }
        : { ...this.state, phase: 'out-of-reach', shift: 0, target: null, lockedRpm: null };
    }
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (!on) this.state = { ...this.state, phase: 'off', shift: 0, target: null, lockedRpm: null };
    else if (this.state.phase === 'off') this.state = { ...this.state, phase: 'waiting' };
  }

  reset(): void {
    this.window = [];
    this.state = this.enabled ? INITIAL_LOCK : { ...INITIAL_LOCK, phase: 'off' };
  }

  /** Feed one sample. Returns the new state. */
  update(sample: LockSample): KeyLockState {
    const o = this.options;
    const rpm = Number.isFinite(sample.rpm) ? Math.max(0, sample.rpm) : 0;
    const t = Number.isFinite(sample.t) ? sample.t : (this.window.at(-1)?.t ?? 0);

    // Keep the last `steadyMs` of samples; drop anything older or from a clock that went backwards.
    this.window = this.window.filter((s) => s.t <= t && t - s.t <= o.steadyMs);
    this.window.push({ t, rpm });

    const note = engineNote(rpm, o.engine);
    const span = this.window.length > 1 ? t - this.window[0]!.t : 0;
    let lo = Number.POSITIVE_INFINITY;
    let hi = Number.NEGATIVE_INFINITY;
    for (const s of this.window) {
      if (s.rpm < lo) lo = s.rpm;
      if (s.rpm > hi) hi = s.rpm;
    }
    const inBand = hi - lo <= o.steadyBandRpm;
    const steadyFor = inBand ? span : 0;
    if (!inBand) this.window = [{ t, rpm }];

    const base = { engineMidi: note.midi, steadyMs: steadyFor };

    if (!this.enabled) {
      this.state = { ...base, phase: 'off', shift: 0, target: null, lockedRpm: null };
      return this.state;
    }
    if (rpm < o.minRpm) {
      this.state = { ...base, phase: 'idle', shift: 0, target: null, lockedRpm: null };
      return this.state;
    }

    const prev = this.state;
    if (prev.phase === 'locked' && prev.lockedRpm !== null && Math.abs(rpm - prev.lockedRpm) <= o.releaseBandRpm) {
      // Hold the lock through small wobble, keeping the shift exact for the note we hear now. If the
      // wobble carries the note a hair past the limit, keep the last shift rather than let go: the
      // only way out of a lock is the RPM band, so the song never jumps back and forth at the edge.
      const best = bestShift(note.midi, o);
      this.state = best
        ? { ...base, phase: 'locked', shift: best.shift, target: best.target, lockedRpm: prev.lockedRpm }
        : { ...base, phase: 'locked', shift: prev.shift, target: prev.target, lockedRpm: prev.lockedRpm };
      return this.state;
    }

    if (steadyFor >= o.steadyMs) {
      const best = bestShift(note.midi, o);
      this.state = best
        ? { ...base, phase: 'locked', shift: best.shift, target: best.target, lockedRpm: rpm }
        : { ...base, phase: 'out-of-reach', shift: 0, target: null, lockedRpm: null };
      return this.state;
    }

    this.state = { ...base, phase: 'waiting', shift: 0, target: null, lockedRpm: null };
    return this.state;
  }
}
