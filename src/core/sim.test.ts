import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { DEFAULT_ENGINE } from './engine';
import { AUTO_SCRIPT, AUTO_SECONDS, autoDrive, CarSim, pedalValue } from './sim';

describe('CarSim', () => {
  it('idles at the engine idle speed in first gear', () => {
    const car = new CarSim();
    expect(car.state).toEqual({ rpm: DEFAULT_ENGINE.idleRpm, speedKph: 0, gear: 1, throttlePct: 0 });
  });

  it('full throttle from a standstill climbs through the gears and never passes the redline by more than 200', () => {
    const car = new CarSim();
    let maxRpm = 0;
    let maxGear = 1;
    for (let i = 0; i < 20 * 30; i++) {
      const s = car.step(1 / 30, 1);
      maxRpm = Math.max(maxRpm, s.rpm);
      maxGear = Math.max(maxGear, s.gear);
    }
    expect(maxGear).toBeGreaterThanOrEqual(3);
    expect(maxRpm).toBeLessThanOrEqual(DEFAULT_ENGINE.redlineRpm + 200);
    expect(car.state.speedKph).toBeGreaterThan(80);
  });

  it('an upshift is a fall in rpm with the throttle still down (what the shift detector listens for)', () => {
    const car = new CarSim();
    let prev = car.state.rpm;
    let biggestDrop = 0;
    for (let i = 0; i < 15 * 30; i++) {
      const s = car.step(1 / 30, 1);
      biggestDrop = Math.max(biggestDrop, prev - s.rpm);
      prev = s.rpm;
    }
    expect(biggestDrop).toBeGreaterThan(900);
  });

  it('braking brings it back to a standstill and first gear', () => {
    const car = new CarSim();
    for (let i = 0; i < 10 * 30; i++) car.step(1 / 30, 1);
    for (let i = 0; i < 30 * 30; i++) car.step(1 / 30, 0, 1);
    expect(car.state.speedKph).toBe(0);
    expect(car.state.gear).toBe(1);
  });

  it('a blip of throttle at a standstill revs the engine without moving far', () => {
    const car = new CarSim();
    for (let i = 0; i < 15; i++) car.step(1 / 30, 1, 1); // throttle and brake together
    expect(car.state.rpm).toBeGreaterThan(DEFAULT_ENGINE.idleRpm + 500);
    expect(car.state.speedKph).toBeLessThan(5);
  });

  it('never produces NaN or negative numbers for any pedal input (property)', () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ dt: fc.double({ noNaN: false }), thr: fc.double({ noNaN: false }), brk: fc.double({ noNaN: false }) }), {
          maxLength: 200,
        }),
        (steps) => {
          const car = new CarSim();
          for (const s of steps) {
            const st = car.step(s.dt, s.thr, s.brk);
            if (![st.rpm, st.speedKph, st.gear, st.throttlePct].every((v) => Number.isFinite(v) && v >= 0)) return false;
            if (st.gear < 1 || st.gear > 5) return false;
          }
          return true;
        },
      ),
    );
  });
});

describe('autoDrive', () => {
  it('starts at idle and loops', () => {
    expect(autoDrive(0)).toEqual({ rpm: 800, throttlePct: 0 });
    expect(autoDrive(AUTO_SECONDS)).toEqual(autoDrive(0));
    expect(autoDrive(AUTO_SECONDS + 3)).toEqual(autoDrive(3));
  });

  it('hits the script points exactly and moves in straight lines between them', () => {
    for (const [t, rpm, thr] of AUTO_SCRIPT.slice(0, -1)) {
      expect(autoDrive(t).rpm).toBeCloseTo(rpm, 9);
      expect(autoDrive(t).throttlePct).toBeCloseTo(thr, 9);
    }
    expect(autoDrive(4).rpm).toBeCloseTo(2200 + ((5800 - 2200) * (4 - 2.4)) / (5.5 - 2.4), 9);
  });

  it('holds a steady cruise long enough for the key lock', () => {
    expect(autoDrive(14).rpm).toBe(2150);
    expect(autoDrive(21).rpm).toBe(2150);
  });

  it('is finite for any time, including junk', () => {
    for (const t of [Number.NaN, -5, 1e9, Number.POSITIVE_INFINITY]) {
      const v = autoDrive(t);
      expect(Number.isFinite(v.rpm)).toBe(true);
      expect(Number.isFinite(v.throttlePct)).toBe(true);
    }
  });
});

describe('pedalValue', () => {
  it('maps rest to 0 and floored to 1, whichever direction the axis runs', () => {
    expect(pedalValue(1, 1, -1)).toBe(0);
    expect(pedalValue(-1, 1, -1)).toBe(1);
    expect(pedalValue(0, 1, -1)).toBe(0.5);
    expect(pedalValue(0.5, -1, 1)).toBe(0.75);
  });

  it('reads 0 until the pedal has been pressed far enough to learn its direction', () => {
    expect(pedalValue(1, 1, 1.02)).toBe(0);
  });

  it('stays in 0..1 for any input (property)', () => {
    fc.assert(
      fc.property(fc.double({ noNaN: false }), fc.double({ noNaN: false }), fc.double({ noNaN: false }), (a, r, f) => {
        const v = pedalValue(a, r, f);
        return v >= 0 && v <= 1;
      }),
    );
  });
});
