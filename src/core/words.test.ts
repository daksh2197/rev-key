import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { engineNote } from './engine';
import * as f from './format';
import { INITIAL_LOCK } from './keylock';
import { mixLanes } from './lanes';
import { keyName, laneLine, lockLine, shiftLine } from './words';

describe('format', () => {
  it('never prints NaN, Infinity, undefined or minus zero', () => {
    const bad = /NaN|Infinity|undefined|-0\b/;
    for (const v of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -0, -0.04, 0]) {
      for (const s of [f.rpm(v), f.hz(v), f.semitones(v), f.percent(v), f.kph(v), f.clock(v), f.ms(v)]) {
        expect(s).not.toMatch(bad);
      }
    }
  });

  it('semitones carry a sign and drop the decimal on whole numbers', () => {
    expect(f.semitones(1)).toBe('+1 st');
    expect(f.semitones(-2)).toBe('−2 st');
    expect(f.semitones(0)).toBe('0 st');
    expect(f.semitones(1.26)).toBe('+1.3 st');
    expect(f.semitones(-0.04)).toBe('0 st');
  });

  it('rpm is rounded to tens with a thousands separator', () => {
    expect(f.rpm(2213)).toBe('2,210');
    expect(f.rpm(805)).toBe('810');
    expect(f.rpm(0)).toBe('0');
  });

  it('hertz shows a decimal below 100', () => {
    expect(f.hz(40)).toBe('40.0 Hz');
    expect(f.hz(120.4)).toBe('120 Hz');
  });

  it('speed shows a dash when the source does not report it', () => {
    expect(f.kph(null)).toBe('—');
    expect(f.kph(88.4)).toBe('88 km/h');
  });

  it('clock and milliseconds', () => {
    expect(f.clock(83)).toBe('1:23');
    expect(f.clock(-4)).toBe('0:00');
    expect(f.ms(249.6)).toBe('250 ms');
  });

  it('semitones is finite text for any number (property)', () => {
    fc.assert(fc.property(fc.double({ noNaN: false }), (v) => /^(\+|−)?\d+(\.\d)? st$/.test(f.semitones(v))));
  });
});

describe('words', () => {
  it('names the key after the shift', () => {
    expect(keyName(45, 0)).toBe('A minor');
    expect(keyName(45, 1)).toBe('A# minor');
    expect(keyName(45, -2)).toBe('G minor');
    expect(keyName(45, 0.4)).toBe('A minor');
    expect(keyName(45, 0.6)).toBe('A# minor');
  });

  it('has a sentence for every lock phase', () => {
    const note = engineNote(2200);
    for (const phase of ['off', 'idle', 'waiting', 'out-of-reach', 'locked'] as const) {
      const line = lockLine({ ...INITIAL_LOCK, phase, shift: 1, target: 'root', lockedRpm: 2200 }, note);
      expect(line.length).toBeGreaterThan(10);
      expect(line).not.toMatch(/NaN|undefined/);
    }
  });

  it('tells the fifth from the root when locked', () => {
    const note = engineNote(3300); // E3: the fifth of A
    expect(lockLine({ ...INITIAL_LOCK, phase: 'locked', target: 'fifth', shift: 0, lockedRpm: 3300 }, note)).toMatch(/fifth/);
    expect(lockLine({ ...INITIAL_LOCK, phase: 'locked', target: 'root', shift: 0, lockedRpm: 2200 }, note)).toMatch(/root/);
  });

  it('counts the steady time while waiting', () => {
    expect(lockLine({ ...INITIAL_LOCK, phase: 'waiting', steadyMs: 640 }, engineNote(2200))).toMatch(/0\.6s/);
  });

  it('has a sentence for every lane reason', () => {
    for (const input of [
      { rpm: 2000, throttlePct: 10, place: 'highway' as const },
      { rpm: 5000, throttlePct: 80, place: 'highway' as const },
      { rpm: 3000, throttlePct: 40, place: 'city' as const },
      { rpm: 3000, throttlePct: 90, place: 'city' as const },
    ]) {
      expect(laneLine(mixLanes(input)).length).toBeGreaterThan(10);
    }
  });

  it('describes seen and predicted shifts', () => {
    expect(shiftLine({ kind: 'seen', t: 0, inMs: 0, fromRpm: 5800 })).toMatch(/landed/);
    expect(shiftLine({ kind: 'predicted', t: 0, inMs: 240, fromRpm: 5800 })).toMatch(/240 ms/);
  });
});
