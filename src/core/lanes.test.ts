import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { DEFAULT_ENGINE, ENGINES } from './engine';
import { CITY_PUMP_CAP, COUNTER_STEER_VOLUME, intensity, laneGains, mixLanes, overLimit } from './lanes';

describe('intensity', () => {
  it('is 0 at idle with no throttle and 1 at the redline with the pedal down', () => {
    expect(intensity(DEFAULT_ENGINE.idleRpm, 0)).toBe(0);
    expect(intensity(DEFAULT_ENGINE.redlineRpm, 100)).toBe(1);
  });

  it('weights revs 60% and throttle 40%', () => {
    expect(intensity(DEFAULT_ENGINE.redlineRpm, 0)).toBeCloseTo(0.6, 9);
    expect(intensity(DEFAULT_ENGINE.idleRpm, 100)).toBeCloseTo(0.4, 9);
  });

  it('stays between 0 and 1 for any input (property)', () => {
    fc.assert(
      fc.property(fc.double({ noNaN: false }), fc.double({ noNaN: false }), fc.constantFrom(...ENGINES), (rpm, thr, e) => {
        const v = intensity(rpm, thr, e);
        return v >= 0 && v <= 1;
      }),
    );
  });
});

describe('mixLanes', () => {
  it('cruising on the highway is the calm lane', () => {
    const out = mixLanes({ rpm: 2200, throttlePct: 15, place: 'highway' });
    expect(out.reason).toBe('calm');
    expect(out.counterSteer).toBe(false);
    expect(out.volume).toBe(1);
  });

  it('a highway pull opens the pump lane with the revs', () => {
    const a = mixLanes({ rpm: 4000, throttlePct: 70, place: 'highway' });
    const b = mixLanes({ rpm: 5500, throttlePct: 90, place: 'highway' });
    expect(a.reason).toBe('pull');
    expect(b.pump).toBeGreaterThan(a.pump);
  });

  it('in the city the pump lane is capped at a third', () => {
    const out = mixLanes({ rpm: 4000, throttlePct: 50, place: 'city' });
    expect(out.reason).toBe('city-cap');
    expect(out.pump).toBeLessThanOrEqual(CITY_PUMP_CAP);
  });

  it('hard throttle in the city is counter-steer: calm lane, volume down', () => {
    const out = mixLanes({ rpm: 3000, throttlePct: 75, place: 'city' });
    expect(out.reason).toBe('counter-steer');
    expect(out.pump).toBe(0);
    expect(out.volume).toBe(COUNTER_STEER_VOLUME);
  });

  it('high revs in the city are counter-steer even with light throttle', () => {
    const out = mixLanes({ rpm: 5000, throttlePct: 10, place: 'city' });
    expect(out.counterSteer).toBe(true);
  });

  it('over the posted limit is counter-steer anywhere, highway included', () => {
    const out = mixLanes({ rpm: 2500, throttlePct: 20, place: 'highway', speedKph: 121, limitKph: 110 });
    expect(out.counterSteer).toBe(true);
    const ok = mixLanes({ rpm: 2500, throttlePct: 20, place: 'highway', speedKph: 108, limitKph: 110 });
    expect(ok.counterSteer).toBe(false);
  });

  it('no speed or no limit means the limit rule cannot fire', () => {
    expect(overLimit(null, 100)).toBe(false);
    expect(overLimit(150, null)).toBe(false);
    expect(overLimit(150, 0)).toBe(false);
    expect(overLimit(Number.NaN, 100)).toBe(false);
  });

  it('never raises the volume above the cap and never leaves 0..1 (property)', () => {
    fc.assert(
      fc.property(
        fc.double({ noNaN: false }),
        fc.double({ noNaN: false }),
        fc.constantFrom<'city' | 'highway'>('city', 'highway'),
        fc.option(fc.double({ min: 0, max: 300, noNaN: true }), { nil: null }),
        fc.option(fc.double({ min: 0, max: 200, noNaN: true }), { nil: null }),
        (rpm, thr, place, speed, limit) => {
          const out = mixLanes({ rpm, throttlePct: thr, place, speedKph: speed, limitKph: limit });
          return out.volume <= 1 && out.volume > 0 && out.pump >= 0 && out.pump <= 1 && (!out.counterSteer || out.pump === 0);
        },
      ),
    );
  });
});

describe('laneGains', () => {
  it('is all calm at 0 and all pump at 1', () => {
    expect(laneGains(0)).toEqual({ calm: 1, pump: 0 });
    expect(laneGains(1).calm).toBeCloseTo(0, 9);
    expect(laneGains(1).pump).toBeCloseTo(1, 9);
  });

  it('keeps constant power through the crossfade (property)', () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 1, noNaN: true }), (p) => {
        const g = laneGains(p);
        return Math.abs(g.calm * g.calm + g.pump * g.pump - 1) < 1e-9;
      }),
    );
  });
});
