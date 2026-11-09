import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SHIFT, median, ShiftDetector, type ShiftEvent, slopeRpmPerSecond } from './shift';

/** Climb from `from` to `to` rpm over `ms` with the throttle on, 50 ms steps. Returns events and the end time. */
function climb(d: ShiftDetector, from: number, to: number, ms: number, start = 0, thr = 80): { events: ShiftEvent[]; t: number } {
  const events: ShiftEvent[] = [];
  let t = start;
  for (; t <= start + ms; t += 50) {
    const e = d.push({ t, rpm: from + ((to - from) * (t - start)) / ms, throttlePct: thr });
    if (e) events.push(e);
  }
  return { events, t };
}

describe('median and slope', () => {
  it('median of an odd and an even list', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(Number.isNaN(median([]))).toBe(true);
  });

  it('slope of a straight climb is its rate', () => {
    const s = [0, 100, 200, 300].map((t) => ({ t, rpm: 2000 + t * 4, throttlePct: 50 }));
    expect(slopeRpmPerSecond(s)).toBeCloseTo(4000, 6);
  });

  it('slope needs two different times', () => {
    expect(slopeRpmPerSecond([])).toBe(0);
    expect(slopeRpmPerSecond([{ t: 1, rpm: 100, throttlePct: 0 }])).toBe(0);
    expect(slopeRpmPerSecond([{ t: 1, rpm: 100, throttlePct: 0 }, { t: 1, rpm: 300, throttlePct: 0 }])).toBe(0);
  });
});

describe('seeing a shift', () => {
  it('a 1,000 rpm fall under throttle is an upshift', () => {
    const d = new ShiftDetector();
    d.push({ t: 0, rpm: 5800, throttlePct: 80 });
    const e = d.push({ t: 150, rpm: 4700, throttlePct: 80 });
    expect(e?.kind).toBe('seen');
    expect(e?.fromRpm).toBe(5800);
  });

  it('the same fall with the foot off is lifting, not shifting', () => {
    const d = new ShiftDetector();
    d.push({ t: 0, rpm: 5800, throttlePct: 10 });
    expect(d.push({ t: 150, rpm: 4700, throttlePct: 10 })).toBeNull();
  });

  it('a slow decline over a second is not a shift', () => {
    const d = new ShiftDetector();
    for (let t = 0; t <= 1000; t += 50) expect(d.push({ t, rpm: 5800 - t, throttlePct: 80 })).toBeNull();
  });

  it('one shift gives one event, not one per sample of the drop', () => {
    const d = new ShiftDetector();
    let count = 0;
    d.push({ t: 0, rpm: 5800, throttlePct: 80 });
    for (let t = 50; t <= 400; t += 50) if (d.push({ t, rpm: 5800 - t * 6, throttlePct: 80 })) count++;
    expect(count).toBe(1);
  });

  it('learns where the driver shifts from the shifts it has seen', () => {
    const d = new ShiftDetector();
    expect(d.shiftRpm).toBe(DEFAULT_SHIFT.defaultShiftRpm);
    for (const [start, from] of [[0, 6000], [5000, 6200], [10000, 6100]] as const) {
      d.push({ t: start, rpm: from, throttlePct: 80 });
      d.push({ t: start + 150, rpm: from - 1100, throttlePct: 80 });
    }
    expect(d.shiftsSeen).toBe(3);
    expect(d.shiftRpm).toBe(6100);
  });

  it('remembers only the last few shifts', () => {
    const d = new ShiftDetector({ ...DEFAULT_SHIFT, memory: 2 });
    for (let i = 0; i < 5; i++) {
      d.push({ t: i * 5000, rpm: 5000 + i * 100, throttlePct: 80 });
      d.push({ t: i * 5000 + 150, rpm: 3000, throttlePct: 80 });
    }
    expect(d.shiftsSeen).toBe(2);
    expect(d.shiftRpm).toBe(5350);
  });
});

describe('foreseeing a shift', () => {
  it('with no lead time it never predicts', () => {
    const d = new ShiftDetector();
    const { events } = climb(d, 3000, 5700, 1500);
    expect(events).toEqual([]);
  });

  it('with a 250 ms lead it predicts once, about 250 ms before the usual shift rpm', () => {
    const d = new ShiftDetector({ ...DEFAULT_SHIFT, leadMs: 250 });
    // 3,000 to 6,000 over 1.5 s: 2,000 rpm/s, so 5,800 is reached at t = 1,400.
    const { events } = climb(d, 3000, 6000, 1500);
    const predicted = events.filter((e) => e.kind === 'predicted');
    expect(predicted).toHaveLength(1);
    const p = predicted[0]!;
    expect(p.inMs).toBeLessThanOrEqual(250);
    expect(p.inMs).toBeGreaterThan(0);
    expect(p.t + p.inMs).toBeGreaterThan(1300);
    expect(p.t + p.inMs).toBeLessThan(1500);
    expect(p.fromRpm).toBe(DEFAULT_SHIFT.defaultShiftRpm);
  });

  it('a prediction silences the seen event for that shift, but the shift is still learned', () => {
    const d = new ShiftDetector({ ...DEFAULT_SHIFT, leadMs: 250 });
    const { events, t } = climb(d, 3000, 6000, 1500);
    const after = d.push({ t: t + 50, rpm: 4600, throttlePct: 80 });
    expect(after).toBeNull();
    expect(events.filter((e) => e.kind === 'seen')).toHaveLength(0);
    expect(d.shiftsSeen).toBe(1);
  });

  it('does not predict while cruising, because the revs are not climbing', () => {
    const d = new ShiftDetector({ ...DEFAULT_SHIFT, leadMs: 400 });
    for (let t = 0; t <= 3000; t += 50) expect(d.push({ t, rpm: 2200 + (t % 100 ? 5 : -5), throttlePct: 20 })).toBeNull();
  });

  it('re-arms for the next climb after a fall', () => {
    const d = new ShiftDetector({ ...DEFAULT_SHIFT, leadMs: 250 });
    const first = climb(d, 3000, 6000, 1500);
    d.push({ t: first.t + 50, rpm: 4000, throttlePct: 80 });
    const second = climb(d, 4000, 6000, 1000, first.t + 1200);
    expect(first.events.filter((e) => e.kind === 'predicted')).toHaveLength(1);
    expect(second.events.filter((e) => e.kind === 'predicted')).toHaveLength(1);
  });

  it('junk samples never produce a NaN event (property)', () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ dt: fc.integer({ min: 0, max: 500 }), rpm: fc.double({ noNaN: false }), thr: fc.double({ noNaN: false }) }), {
          maxLength: 300,
        }),
        fc.integer({ min: 0, max: 600 }),
        (steps, lead) => {
          const d = new ShiftDetector({ ...DEFAULT_SHIFT, leadMs: lead });
          let t = 0;
          for (const s of steps) {
            t += s.dt;
            const e = d.push({ t, rpm: s.rpm, throttlePct: s.thr });
            if (e && (!Number.isFinite(e.inMs) || !Number.isFinite(e.fromRpm) || e.inMs < 0 || e.inMs > lead)) return false;
          }
          return Number.isFinite(d.shiftRpm);
        },
      ),
    );
  });
});
