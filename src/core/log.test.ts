import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { countArb, randomDrive, seedArb } from '../testing/arb';
import {
  appendSample,
  channelsPresent,
  cleanSample,
  DEMO_LABEL,
  duration,
  exportFileName,
  holdValue,
  mapMinusBaro,
  newDrive,
  normalizeDrive,
  seriesOf,
  slug,
  valueAt,
  type Drive,
} from './log';

const base = (): Drive => newDrive('x', '2026-10-20T14:03:05.000Z', 'Eclipse', 'car');

describe('cleaning a sample', () => {
  it('keeps finite numbers on known channels', () => {
    expect(cleanSample({ t_s: 1, rpm: 900, speed_kph: 0 })).toEqual({ t_s: 1, rpm: 900, speed_kph: 0 });
  });
  it('drops NaN and Infinity values', () => {
    expect(cleanSample({ t_s: 1, rpm: NaN, speed_kph: Infinity, volts: 12 })).toEqual({ t_s: 1, volts: 12 });
  });
  it('drops unknown fields', () => expect(cleanSample({ t_s: 1, boost: 3 })).toEqual({ t_s: 1 }));
  it('drops text pretending to be numbers', () => expect(cleanSample({ t_s: 1, rpm: '900' })).toEqual({ t_s: 1 }));
  it('refuses a sample with no usable time', () => {
    expect(cleanSample({ rpm: 1 })).toBeNull();
    expect(cleanSample({ t_s: NaN })).toBeNull();
    expect(cleanSample({ t_s: -1 })).toBeNull();
    expect(cleanSample(null)).toBeNull();
    expect(cleanSample('x')).toBeNull();
  });
  it('turns minus zero into zero', () => {
    const s = cleanSample({ t_s: -0, rpm: -0 });
    expect(Object.is(s?.t_s, 0)).toBe(true);
    expect(Object.is(s?.rpm, 0)).toBe(true);
  });
  it('drops absurdly large values', () => expect(cleanSample({ t_s: 1, rpm: 1e12 })).toEqual({ t_s: 1 }));
});

describe('building a drive', () => {
  it('appends samples in time order', () => {
    const d = base();
    expect(appendSample(d, { t_s: 0, rpm: 1 })).toBe(true);
    expect(appendSample(d, { t_s: 1, rpm: 2 })).toBe(true);
    expect(d.samples).toHaveLength(2);
  });
  it('refuses a sample that goes back in time', () => {
    const d = base();
    appendSample(d, { t_s: 5 });
    expect(appendSample(d, { t_s: 4 })).toBe(false);
    expect(d.samples).toHaveLength(1);
  });
  it('accepts two samples with the same time', () => {
    const d = base();
    appendSample(d, { t_s: 5 });
    expect(appendSample(d, { t_s: 5 })).toBe(true);
  });
  it('refuses junk', () => expect(appendSample(base(), { t_s: 'a' })).toBe(false));
  it('measures duration from first to last sample', () => {
    const d = base();
    appendSample(d, { t_s: 2 });
    appendSample(d, { t_s: 12.5 });
    expect(duration(d)).toBe(10.5);
  });
  it('has duration 0 for an empty drive or a single sample', () => {
    const d = base();
    expect(duration(d)).toBe(0);
    appendSample(d, { t_s: 3 });
    expect(duration(d)).toBe(0);
  });
  it('lists only the channels that were reported', () => {
    const d = base();
    appendSample(d, { t_s: 0, rpm: 1 });
    appendSample(d, { t_s: 1, volts: 12 });
    expect(channelsPresent(d)).toEqual(['rpm', 'volts']);
  });
  it('lists no channels for an empty drive', () => expect(channelsPresent(base())).toEqual([]));
});

describe('values between samples', () => {
  const series = [
    { t: 0, v: 0 },
    { t: 10, v: 100 },
    { t: 20, v: 50 },
  ];
  it('draws a straight line between two points', () => expect(valueAt(series, 5)).toBe(50));
  it('gives the exact value at a point', () => expect(valueAt(series, 10)).toBe(100));
  it('gives null before the first point', () => expect(valueAt(series, -1)).toBeNull());
  it('gives null after the last point', () => expect(valueAt(series, 21)).toBeNull());
  it('gives the value at the very last point', () => expect(valueAt(series, 20)).toBe(50));
  it('gives null for an empty series', () => expect(valueAt([], 1)).toBeNull());
  it('gives null for a time that is not a number', () => expect(valueAt(series, NaN)).toBeNull());
  it('holds the last value for a gauge between slow readings', () => {
    expect(holdValue(series, 14)).toBe(100);
    expect(holdValue(series, 99)).toBe(50);
    expect(holdValue(series, -1)).toBeNull();
  });
  it('never gives NaN for any time', () => {
    fc.assert(
      fc.property(seedArb, fc.double(), (seed, t) => {
        const s = seriesOf(randomDrive(seed, 50), 'rpm');
        const v = valueAt(s, t);
        const h = holdValue(s, t);
        return (v === null || Number.isFinite(v)) && (h === null || Number.isFinite(h));
      }),
      { numRuns: 300 },
    );
  });
  it('stays between the two neighbouring values', () => {
    fc.assert(
      fc.property(seedArb, fc.double({ min: 0, max: 1, noNaN: true }), (seed, f) => {
        const s = seriesOf(randomDrive(seed, 40), 'speed_kph');
        if (s.length < 2) return true;
        const a = s[0];
        const b = s[1];
        if (!a || !b) return true;
        const v = valueAt(s, a.t + f * (b.t - a.t));
        return v !== null && v >= Math.min(a.v, b.v) - 1e-9 && v <= Math.max(a.v, b.v) + 1e-9;
      }),
      { numRuns: 300 },
    );
  });
});

describe('boost-like value', () => {
  it('is MAP minus barometric pressure when both are reported', () => expect(mapMinusBaro(150, 100)).toBe(50));
  it('can be negative (vacuum)', () => expect(mapMinusBaro(40, 100)).toBe(-60));
  it('is null when MAP is missing', () => expect(mapMinusBaro(undefined, 100)).toBeNull());
  it('is null when barometric pressure is missing', () => expect(mapMinusBaro(100, null)).toBeNull());
  it('is zero, never minus zero, when they are equal', () => expect(Object.is(mapMinusBaro(100, 100), 0)).toBe(true));
});

describe('file names', () => {
  it('slugs a label', () => expect(slug('Mitsubishi Eclipse GSX!')).toBe('mitsubishi-eclipse-gsx'));
  it('slugs nothing to "drive"', () => expect(slug('???')).toBe('drive'));
  it('names a car drive with its label and start time', () => {
    expect(exportFileName(base(), 'csv')).toBe('eclipse-20261020140305.csv');
  });
  it('starts a demo drive file name with demo-', () => {
    const d: Drive = { ...base(), source: 'demo', label: DEMO_LABEL };
    expect(exportFileName(d, 'csv')).toBe('demo-open-gauge-20261020140305.csv');
    expect(exportFileName(d, 'json')).toMatch(/^demo-.*\.json$/);
  });
  it('copes with a missing start time', () => {
    expect(exportFileName({ ...base(), started: '' }, 'csv')).toBe('eclipse-undated.csv');
  });
  it('never makes a car drive file start with demo- by accident', () => {
    fc.assert(
      fc.property(fc.string(), (label) => !exportFileName({ ...base(), label: 'x' + label }, 'csv').startsWith('demo-')),
      { numRuns: 300 },
    );
  });
});

describe('reading a drive back from disk', () => {
  it('rebuilds a drive', () => {
    const d = randomDrive(3, 20);
    expect(normalizeDrive(JSON.parse(JSON.stringify(d)))).toEqual(d);
  });
  it('refuses a record with no id or no samples', () => {
    expect(normalizeDrive({ samples: [] })).toBeNull();
    expect(normalizeDrive({ id: 'a' })).toBeNull();
    expect(normalizeDrive(null)).toBeNull();
    expect(normalizeDrive(7)).toBeNull();
  });
  it('drops bad samples and sorts the rest', () => {
    const d = normalizeDrive({ id: 'a', samples: [{ t_s: 2 }, { t_s: NaN }, { t_s: 1 }, 'x'] });
    expect(d?.samples.map((s) => s.t_s)).toEqual([1, 2]);
  });
  it('fills in a missing label and source', () => {
    const d = normalizeDrive({ id: 'a', samples: [] });
    expect(d?.label).toBe('drive');
    expect(d?.source).toBe('car');
  });
  it('keeps the demo flag', () => expect(normalizeDrive({ id: 'a', samples: [], source: 'demo' })?.source).toBe('demo'));
  it('makes durations non-negative for any drive', () => {
    fc.assert(fc.property(seedArb, countArb, (seed, n) => duration(randomDrive(seed, n)) >= 0), { numRuns: 300 });
  });
});
