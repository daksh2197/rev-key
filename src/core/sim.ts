/**
 * A small car to drive from the page: a throttle, a brake and a five-speed automatic.
 *
 * It exists so the key lock, the lanes and the shift detector can be heard without a car.
 * The numbers are a small hatchback's, borrowed from the demo drive in Open Gauge; they are
 * not a model of any real car. The same five-speed shape also makes the auto-drive script and
 * the pedal of a USB racing wheel behave like the real thing: pull, shift, pull, shift, cruise.
 */

import { type EngineSpec, DEFAULT_ENGINE } from './engine';

/** Engine revs per km/h in each gear, and the push each gear gives at full throttle (m/s²). */
const RPM_PER_KPH = [100, 60, 42, 31, 24] as const;
const PUSH = [3.4, 2.4, 1.7, 1.3, 0.95] as const;
const TOP_SPEED_MPS = 62;
/** Air drag, m/s² per (m/s)²: lets fourth gear reach its shift point before the air wins. */
const DRAG = 0.00035;

const clamp = (v: number, lo: number, hi: number): number => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo);

export interface CarState {
  rpm: number;
  speedKph: number;
  /** 1 to 5. */
  gear: number;
  throttlePct: number;
}

export class CarSim {
  private speed = 0; // m/s
  private gearIndex = 0;
  private rpm: number;
  private throttle = 0;

  constructor(private readonly engine: EngineSpec = DEFAULT_ENGINE) {
    this.rpm = engine.idleRpm;
  }

  get state(): CarState {
    return { rpm: this.rpm, speedKph: this.speed * 3.6, gear: this.gearIndex + 1, throttlePct: this.throttle * 100 };
  }

  reset(): void {
    this.speed = 0;
    this.gearIndex = 0;
    this.rpm = this.engine.idleRpm;
    this.throttle = 0;
  }

  /**
   * Advance by `dt` seconds with the pedals at `throttle` and `brake` (0 to 1).
   * The gearbox upshifts near the redline under heavy throttle and lower when driven gently.
   */
  step(dt: number, throttle: number, brake: number = 0): CarState {
    const step = clamp(dt, 0, 0.25);
    const thr = clamp(throttle, 0, 1);
    const brk = clamp(brake, 0, 1);
    this.throttle = thr;

    const accel = thr * (PUSH[this.gearIndex] ?? 0.95) - brk * 5 - DRAG * this.speed * this.speed - 0.05;
    this.speed = clamp(this.speed + accel * step, 0, TOP_SPEED_MPS);

    const kph = this.speed * 3.6;
    const redline = this.engine.redlineRpm;
    const shiftUp = thr > 0.5 ? redline - 700 : 2600 + thr * 2400;
    let rpm = kph * (RPM_PER_KPH[this.gearIndex] ?? 24);
    if (rpm > shiftUp && this.gearIndex < RPM_PER_KPH.length - 1) this.gearIndex++;
    else if (rpm < 1400 && this.gearIndex > 0) this.gearIndex--;
    if (this.speed < 0.5) this.gearIndex = 0;

    rpm = kph * (RPM_PER_KPH[this.gearIndex] ?? 24);
    // At a standstill the engine idles; a blip of throttle revs it in neutral.
    const idleTarget = this.engine.idleRpm + thr * (redline - this.engine.idleRpm) * 0.8;
    const target = this.speed < 0.5 ? idleTarget : Math.max(this.engine.idleRpm, rpm);
    this.rpm = clamp(this.rpm + (target - this.rpm) * Math.min(1, step * 16), 0, redline + 200);
    return this.state;
  }
}

/** One point of the scripted drive: seconds, rpm, throttle %. */
type Waypoint = readonly [number, number, number];

/**
 * The auto-drive script: idle, two pulls with a shift each, settle to cruise, back to idle.
 * It loops. Linear between points, so the revs move smoothly and the key lock gets its
 * steady second at cruise.
 */
export const AUTO_SCRIPT: readonly Waypoint[] = [
  [0, 800, 0],
  [2, 820, 0],
  [2.4, 2200, 80],
  [5.5, 5800, 85],
  [5.8, 3600, 70],
  [8.6, 5600, 80],
  [8.9, 3900, 60],
  [11, 2900, 30],
  [13, 2150, 18],
  [22, 2150, 18],
  [24, 900, 0],
  [26, 800, 0],
];

export const AUTO_SECONDS = AUTO_SCRIPT[AUTO_SCRIPT.length - 1]![0];

export function autoDrive(seconds: number): { rpm: number; throttlePct: number } {
  const total = AUTO_SECONDS;
  const t = Number.isFinite(seconds) ? ((seconds % total) + total) % total : 0;
  for (let i = 1; i < AUTO_SCRIPT.length; i++) {
    const [t1, r1, p1] = AUTO_SCRIPT[i]!;
    if (t <= t1) {
      const [t0, r0, p0] = AUTO_SCRIPT[i - 1]!;
      const u = t1 === t0 ? 1 : (t - t0) / (t1 - t0);
      return { rpm: r0 + (r1 - r0) * u, throttlePct: p0 + (p1 - p0) * u };
    }
  }
  return { rpm: 800, throttlePct: 0 };
}

/**
 * A pedal axis as the Gamepad API reports it (-1 to 1, with the resting value depending on the
 * wheel) mapped to 0 (foot off) to 1 (floored). `rest` and `full` are learned from the first
 * seconds of use: whatever the axis reads at rest, and the furthest it has been pressed.
 */
export function pedalValue(axis: number, rest: number, full: number): number {
  if (!Number.isFinite(axis) || !Number.isFinite(rest) || !Number.isFinite(full)) return 0;
  const range = full - rest;
  if (Math.abs(range) < 0.05) return 0; // not pressed far enough yet to know which way is down
  return clamp((axis - rest) / range, 0, 1);
}
