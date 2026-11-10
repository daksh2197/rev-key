import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { engineNote, midiFromHz } from './engine';
import { bestShift, DEFAULT_LOCK, KeyLock, type KeyLockOptions } from './keylock';

/** Feed a steady RPM for `ms` milliseconds at 50 ms steps, starting at time `from`. */
function hold(lock: KeyLock, rpm: number, ms: number, from = 0, wobble = 0): number {
  let t = from;
  let i = 0;
  for (; t <= from + ms; t += 50, i++) lock.update({ t, rpm: rpm + (i % 2 ? wobble : -wobble) });
  return t;
}

/** The RPM at which the V6's firing note is exactly `midi`. */
function rpmForMidi(midi: number): number {
  const hz = 440 * Math.pow(2, (midi - 69) / 12);
  return (hz * 60) / 3;
}

describe('bestShift', () => {
  const o = { songRoot: 45, targets: ['root', 'fifth'] as const, maxShift: 2, fine: false };

  it('an engine note on the root needs no shift', () => {
    expect(bestShift(45, o)).toEqual({ shift: 0, target: 'root' });
    expect(bestShift(33, o)).toEqual({ shift: 0, target: 'root' }); // any octave
  });

  it('an engine note on the fifth needs no shift either', () => {
    expect(bestShift(52, o)).toEqual({ shift: 0, target: 'fifth' });
  });

  it('one semitone above the root: move the song up one', () => {
    expect(bestShift(46, o)).toEqual({ shift: 1, target: 'root' });
  });

  it('picks the fifth when it is the smaller move', () => {
    // 51 is a semitone under the fifth (52) and six above the root: move down 1 to land on the fifth.
    expect(bestShift(51, o)).toEqual({ shift: -1, target: 'fifth' });
  });

  it('refuses a move bigger than maxShift', () => {
    // 48/49 are 3 and 4 above the root, and 4 and 3 below the fifth: nothing within 2.
    expect(bestShift(48, o)).toBeNull();
    expect(bestShift(49, o)).toBeNull();
  });

  it('root only: the fifth is not an option', () => {
    expect(bestShift(52, { ...o, targets: ['root'] })).toBeNull();
  });

  it('fine mode keeps the fraction so the drone sits dead on the note', () => {
    expect(bestShift(45.4, { ...o, fine: true })?.shift).toBeCloseTo(0.4, 9);
    expect(bestShift(44.7, { ...o, fine: true })?.shift).toBeCloseTo(-0.3, 9);
  });

  it('fine mode refuses 2.1 while whole-semitone mode rounds it to 2', () => {
    expect(bestShift(47.1, { ...o, fine: true })).toBeNull();
    expect(bestShift(47.1, o)).toEqual({ shift: 2, target: 'root' });
  });

  it('NaN is no note', () => {
    expect(bestShift(Number.NaN, o)).toBeNull();
  });

  it('never shifts further than maxShift, for any note and any settings (property)', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 127, noNaN: true }),
        fc.integer({ min: 0, max: 127 }),
        fc.integer({ min: 0, max: 6 }),
        fc.boolean(),
        fc.constantFrom<readonly ('root' | 'fifth')[]>(['root'], ['fifth'], ['root', 'fifth']),
        (midi, root, max, fine, targets) => {
          const r = bestShift(midi, { songRoot: root, targets, maxShift: max, fine });
          return r === null || Math.abs(r.shift) <= max + 1e-9;
        },
      ),
    );
  });

  it('after the shift, the song note it chose matches the engine pitch class (property)', () => {
    fc.assert(
      fc.property(fc.double({ min: 12, max: 120, noNaN: true }), fc.integer({ min: 0, max: 127 }), (midi, root) => {
        const r = bestShift(midi, { songRoot: root, targets: ['root', 'fifth'], maxShift: 6, fine: true });
        if (r === null) return true;
        const landed = root + r.shift + (r.target === 'fifth' ? 7 : 0);
        const diff = Math.abs(((landed - midi) % 12) + 12) % 12;
        return diff < 1e-6 || Math.abs(diff - 12) < 1e-6;
      }),
    );
  });
});

describe('KeyLock', () => {
  it('starts waiting, with no shift', () => {
    const lock = new KeyLock();
    expect(lock.current.phase).toBe('waiting');
    expect(lock.current.shift).toBe(0);
  });

  it('idles below the minimum rpm', () => {
    const lock = new KeyLock();
    hold(lock, 800, 3000);
    expect(lock.current.phase).toBe('idle');
  });

  it('does not lock before the revs have been steady for a second', () => {
    const lock = new KeyLock();
    hold(lock, 2200, 900);
    expect(lock.current.phase).toBe('waiting');
    expect(lock.current.steadyMs).toBeGreaterThan(800);
  });

  it('locks after a steady second at cruise and reports the shift', () => {
    const lock = new KeyLock();
    const rpm = rpmForMidi(46); // exactly one semitone above A
    hold(lock, rpm, 1100);
    expect(lock.current.phase).toBe('locked');
    expect(lock.current.shift).toBeCloseTo(1, 6);
    expect(lock.current.target).toBe('root');
    expect(lock.current.lockedRpm).toBe(rpm);
  });

  it('a wobble inside the steady band still counts as steady', () => {
    const lock = new KeyLock();
    hold(lock, 2200, 1100, 0, 30); // ±30 rpm, band is 80
    expect(lock.current.phase).toBe('locked');
  });

  it('a wobble wider than the band resets the steady clock', () => {
    const lock = new KeyLock();
    hold(lock, 2200, 1100, 0, 60); // ±60 means a 120 rpm range
    expect(lock.current.phase).toBe('waiting');
  });

  it('a pull through the revs never locks', () => {
    const lock = new KeyLock();
    for (let t = 0; t <= 3000; t += 50) lock.update({ t, rpm: 1500 + t });
    expect(lock.current.phase).toBe('waiting');
  });

  it('holds the lock through small wobble, then lets go on a real change', () => {
    const lock = new KeyLock();
    const end = hold(lock, 2200, 1100);
    expect(lock.current.phase).toBe('locked');
    lock.update({ t: end + 50, rpm: 2300 }); // 100 away: inside the 120 release band
    expect(lock.current.phase).toBe('locked');
    lock.update({ t: end + 100, rpm: 2600 }); // 400 away: gone
    expect(lock.current.phase).toBe('waiting');
    expect(lock.current.shift).toBe(0);
  });

  it('a wobble that carries the note a hair past the limit keeps the lock and the last shift', () => {
    // 2,469 rpm on the V6 is note 47, exactly two semitones above A. A ±40 rpm wobble stays inside
    // the 80 rpm steady band but swings the note between 1.7 and 2.3 semitones. Once locked, it stays locked.
    const lock = new KeyLock();
    hold(lock, 2469, 1100, 0, 40);
    expect(lock.current.phase).toBe('locked');
    let t = 1150;
    for (let i = 0; i < 40; i++, t += 50) {
      const st = lock.update({ t, rpm: 2469 + (i % 2 ? 40 : -40) });
      expect(st.phase).toBe('locked');
      expect(Math.abs(st.shift)).toBeGreaterThan(1.5);
    }
  });

  it('says out of reach when the drone is between the root and the fifth', () => {
    const lock = new KeyLock();
    hold(lock, rpmForMidi(48.5), 1100); // 3.5 above A, 3.5 below E
    expect(lock.current.phase).toBe('out-of-reach');
    expect(lock.current.shift).toBe(0);
  });

  it('turned off, it reports off and no shift, and comes back to waiting', () => {
    const lock = new KeyLock();
    hold(lock, 2200, 1100);
    lock.setEnabled(false);
    expect(lock.current.phase).toBe('off');
    expect(lock.current.shift).toBe(0);
    lock.update({ t: 5000, rpm: 2200 });
    expect(lock.current.phase).toBe('off');
    lock.setEnabled(true);
    expect(lock.current.phase).toBe('waiting');
  });

  it('a clock that jumps backwards does not break the window', () => {
    const lock = new KeyLock();
    hold(lock, 2200, 1100);
    lock.update({ t: 10, rpm: 2200 });
    expect(['locked', 'waiting']).toContain(lock.current.phase);
    expect(Number.isFinite(lock.current.steadyMs)).toBe(true);
  });

  it('junk samples are treated as zero rpm, not as a crash', () => {
    const lock = new KeyLock();
    lock.update({ t: Number.NaN, rpm: Number.NaN });
    lock.update({ t: 50, rpm: Number.POSITIVE_INFINITY });
    expect(lock.current.phase).toBe('idle');
  });

  it('a settings change while locked re-aims at the same note or lets go', () => {
    const lock = new KeyLock();
    hold(lock, rpmForMidi(46), 1100);
    expect(lock.current.shift).toBeCloseTo(1, 6);
    lock.configure({ songRoot: 44 }); // now two semitones away: still allowed
    expect(lock.current.phase).toBe('locked');
    expect(lock.current.shift).toBeCloseTo(2, 6);
    lock.configure({ maxShift: 1 });
    expect(lock.current.phase).toBe('out-of-reach');
  });

  it('reset forgets the window and the lock', () => {
    const lock = new KeyLock();
    hold(lock, 2200, 1100);
    lock.reset();
    expect(lock.current.phase).toBe('waiting');
    expect(lock.current.steadyMs).toBe(0);
  });

  it('whatever it is fed, the shift is within maxShift and the phase is one of five (property)', () => {
    const phases = new Set(['off', 'idle', 'waiting', 'out-of-reach', 'locked']);
    fc.assert(
      fc.property(
        fc.array(fc.record({ dt: fc.integer({ min: 0, max: 400 }), rpm: fc.double({ min: -100, max: 9000, noNaN: true }) }), { maxLength: 200 }),
        fc.integer({ min: 0, max: 4 }),
        (steps, max) => {
          const options: KeyLockOptions = { ...DEFAULT_LOCK, maxShift: max };
          const lock = new KeyLock(options);
          let t = 0;
          for (const s of steps) {
            t += s.dt;
            const st = lock.update({ t, rpm: s.rpm });
            if (!phases.has(st.phase)) return false;
            if (Math.abs(st.shift) > max + 1e-9) return false;
            if (st.phase !== 'locked' && st.shift !== 0) return false;
          }
          return true;
        },
      ),
    );
  });

  it('the locked note really is the engine note (the one example from the board)', () => {
    // Board example: V6 at highway cruise. 2,200 rpm is 110 Hz, an A2 exactly: no shift at all.
    expect(midiFromHz(110)).toBeCloseTo(45, 9);
    const lock = new KeyLock();
    hold(lock, 2200, 1100);
    expect(engineNote(2200).name).toBe('A2');
    expect(lock.current.phase).toBe('locked');
    expect(lock.current.shift).toBeCloseTo(0, 9);
  });
});
