import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { PIDS } from '../obd/pids';
import { DEMO_SECONDS, makeDemoDrive, mulberry32 } from './demo';
import { CHANNELS, DEMO_LABEL, channelsPresent, duration } from './log';

describe('the invented demo drive', () => {
  it('is the same drive for the same seed', () => {
    expect(makeDemoDrive(7)).toEqual(makeDemoDrive(7));
  });
  it('is the same drive for the same seed, wherever it is asked from (property)', () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 1e6 }), (seed) => JSON.stringify(makeDemoDrive(seed, undefined, 20)) === JSON.stringify(makeDemoDrive(seed, undefined, 20))), { numRuns: 100 });
  }, 30_000);
  it('differs between seeds', () => {
    expect(makeDemoDrive(1).samples).not.toEqual(makeDemoDrive(2).samples);
  });
  it('is labelled as invented, not a real car', () => {
    const d = makeDemoDrive(1);
    expect(d.label).toBe('Invented demo drive, not a real car');
    expect(d.label).toBe(DEMO_LABEL);
    expect(d.source).toBe('demo');
    expect(d.id).toBe('demo-1');
  });
  it('lasts the demo length', () => expect(duration(makeDemoDrive(1))).toBeCloseTo(DEMO_SECONDS, 5));
  it('reports every channel', () => expect(channelsPresent(makeDemoDrive(1))).toEqual([...CHANNELS]));
  it('keeps every value within the PID range', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1e6 }), (seed) => {
        const d = makeDemoDrive(seed, undefined, 60);
        return d.samples.every((s) => PIDS.every((p) => {
          const v = s[p.channel];
          return v !== undefined && Number.isFinite(v) && v >= p.min && v <= p.max;
        }));
      }),
      { numRuns: 100 },
    );
  }, 30_000);
  it('never has NaN, Infinity or minus zero in a sample', () => {
    for (const s of makeDemoDrive(3).samples) {
      for (const v of Object.values(s)) {
        expect(Number.isFinite(v)).toBe(true);
        expect(Object.is(v, -0)).toBe(false);
      }
    }
  });
  it('has rising times', () => {
    const times = makeDemoDrive(1).samples.map((s) => s.t_s);
    expect(times.every((t, i) => i === 0 || t > (times[i - 1] ?? 0))).toBe(true);
  });
  it('idles near the start and moves later', () => {
    const d = makeDemoDrive(1);
    expect(d.samples[0]?.speed_kph).toBe(0);
    expect(Math.max(...d.samples.map((s) => s.speed_kph ?? 0))).toBeGreaterThan(60);
  });
  it('warms the coolant up over the drive', () => {
    const d = makeDemoDrive(1);
    expect((d.samples.at(-1)?.coolant_c ?? 0)).toBeGreaterThan(d.samples[0]?.coolant_c ?? 999);
  });
  it('reaches 60 km/h in every seed', () => {
    for (let seed = 0; seed < 20; seed++) {
      expect(Math.max(...makeDemoDrive(seed).samples.map((s) => s.speed_kph ?? 0))).toBeGreaterThanOrEqual(60);
    }
  });
  it('accepts a start time', () => {
    expect(makeDemoDrive(1, '2026-05-05T05:05:05.000Z').started).toBe('2026-05-05T05:05:05.000Z');
  });
  it('copes with a seed that is not a number', () => {
    expect(() => makeDemoDrive(NaN, undefined, 5)).not.toThrow();
  });
});

describe('the seeded random generator', () => {
  it('gives numbers from 0 up to but not including 1', () => {
    const r = mulberry32(5);
    for (let i = 0; i < 1000; i++) {
      const v = r();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
  it('repeats for a seed', () => {
    const a = mulberry32(9);
    const b = mulberry32(9);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });
});
