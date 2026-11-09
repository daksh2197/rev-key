import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { BPM, DROP, eventsAt, LOOP_STEPS, STEP_SECONDS, stepsDue } from './patterns';

const PITCHED = new Set(['bass', 'pad', 'pluck', 'tom', 'stab']);

describe('patterns', () => {
  it('a sixteenth at 140 bpm is 107.14 ms', () => {
    expect(BPM).toBe(140);
    expect(STEP_SECONDS).toBeCloseTo(60 / 140 / 4, 12);
  });

  it('both lanes put a kick on the first beat of each bar', () => {
    for (const lane of ['calm', 'pump'] as const) {
      expect(eventsAt(lane, 0).some((e) => e.voice === 'kick')).toBe(true);
      expect(eventsAt(lane, 16).some((e) => e.voice === 'kick')).toBe(true);
    }
  });

  it('the pump lane has a snare on the third beat and a bass on the downbeat', () => {
    expect(eventsAt('pump', 8).some((e) => e.voice === 'snare')).toBe(true);
    expect(eventsAt('pump', 0).some((e) => e.voice === 'bass' && e.interval === 0)).toBe(true);
  });

  it('every pitched note stays in the minor pentatonic or the chord, so any key shift keeps it in tune', () => {
    const allowed = new Set([0, 3, 5, 7, 10, 12, 15, -2]);
    for (const lane of ['calm', 'pump'] as const) {
      for (let s = 0; s < LOOP_STEPS; s++) {
        for (const e of eventsAt(lane, s)) {
          if (!PITCHED.has(e.voice)) continue;
          expect(allowed.has(e.interval)).toBe(true);
          if (e.glideTo !== undefined) expect(allowed.has(e.glideTo)).toBe(true);
        }
      }
    }
  });

  it('every event is finite and in range (property over every step)', () => {
    fc.assert(
      fc.property(fc.constantFrom<'calm' | 'pump'>('calm', 'pump'), fc.integer(), (lane, step) => {
        return eventsAt(lane, step).every(
          (e) => e.velocity > 0 && e.velocity <= 1 && e.steps > 0 && Number.isFinite(e.interval) && Number.isFinite(e.octave) && (e.thirds ?? 0) <= 2,
        );
      }),
    );
  });

  it('wraps around the loop and treats junk as step 0', () => {
    expect(eventsAt('calm', LOOP_STEPS)).toEqual(eventsAt('calm', 0));
    expect(eventsAt('pump', -1)).toEqual(eventsAt('pump', LOOP_STEPS - 1));
    expect(eventsAt('pump', Number.NaN)).toEqual(eventsAt('pump', 0));
  });

  it('the drop hits the drums and the bass on the root', () => {
    expect(DROP.some((e) => e.voice === 'kick')).toBe(true);
    expect(DROP.some((e) => e.voice === 'bass' && e.interval === 0)).toBe(true);
  });
});

describe('stepsDue (the look-ahead scheduler)', () => {
  it('returns the steps that fall inside the look-ahead window and moves the cursor past them', () => {
    const { due, cursor } = stepsDue({ nextTime: 10, step: 0 }, 10, 0.3);
    expect(due.map((d) => d.step)).toEqual([0, 1, 2]);
    expect(cursor.step).toBe(3);
    expect(cursor.nextTime).toBeCloseTo(10 + 3 * STEP_SECONDS, 9);
  });

  it('returns nothing when the next step is still beyond the window', () => {
    const { due, cursor } = stepsDue({ nextTime: 10.5, step: 7 }, 10, 0.1);
    expect(due).toEqual([]);
    expect(cursor).toEqual({ nextTime: 10.5, step: 7 });
  });

  it('after a long sleep it jumps to now instead of replaying the gap', () => {
    const { due, cursor } = stepsDue({ nextTime: 0, step: 0 }, 100, 0.1);
    expect(due.length).toBeLessThan(3);
    expect(cursor.nextTime).toBeGreaterThanOrEqual(100);
  });

  it('never schedules a step in the past of the window start and never loops forever (property)', () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 1e6, noNaN: true }), fc.double({ min: 0, max: 1e6, noNaN: true }), fc.double({ min: 0, max: 2, noNaN: true }), (next, now, look) => {
        const { due, cursor } = stepsDue({ nextTime: next, step: 0 }, now, look);
        return due.length <= 1000 && cursor.nextTime >= now - 1 - 1e-9 && due.every((d) => d.nextTime < now + look);
      }),
    );
  });

  it('junk time schedules nothing', () => {
    expect(stepsDue({ nextTime: 1, step: 0 }, Number.NaN, 0.1).due).toEqual([]);
  });
});
