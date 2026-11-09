/**
 * An invented drive, made from a seed. Not a real car: a little physics (gears, throttle, a
 * driver chasing target speeds) is enough to give every gauge something believable to do.
 *
 * Same seed, same drive, always. Different seeds launch harder or softer and shift earlier or
 * later, which is what makes a before/after comparison between two demo drives interesting.
 */

import { type Drive, type Sample, DEMO_LABEL } from './log';

export const DEMO_SECONDS = 120;
export const DEMO_STEP_S = 0.2;
/** A fixed date, so the same seed gives byte-for-byte the same drive. */
export const DEMO_STARTED = '2026-01-01T12:00:00.000Z';

/** A small seeded random number generator (mulberry32): the same seed always gives the same sequence. */
export function mulberry32(seed: number): () => number {
  let a = (Number.isFinite(seed) ? Math.trunc(seed) : 0) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Engine revs per km/h in each gear (a small 5-speed car), and the push each gear can give.
const RPM_PER_KPH = [100, 58, 40, 30, 24];
const PUSH = [3.4, 2.4, 1.7, 1.2, 0.85]; // m/s^2 at full throttle

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const r2 = (v: number): number => Math.round(v * 100) / 100;

export function makeDemoDrive(seed = 1, started: string = DEMO_STARTED, seconds: number = DEMO_SECONDS): Drive {
  const rand = mulberry32(seed);
  const launch = 0.65 + rand() * 0.35; // how hard the first pull-away is
  const shiftRpm = 2800 + rand() * 900;
  const baro = Math.round(98 + rand() * 3);

  // The driver's plan: hold a target speed for a while, then the next one.
  const plan: { until: number; target: number }[] = [{ until: 3, target: 0 }];
  const targets = [80, 45, 100, 60, 30, 90, 55, 110];
  let at = 3;
  let first = true;
  while (at < seconds + 30) {
    at += first ? 22 : 10 + rand() * 14;
    plan.push({ until: at, target: first ? 85 : (targets[Math.floor(rand() * targets.length)] ?? 60) });
    first = false;
  }

  const samples: Sample[] = [];
  const dt = 0.05;
  let speed = 0; // m/s
  let gear = 0;
  let coolant = 58 + rand() * 6;
  let fuel = 60 + rand() * 20;
  const steps = Math.round(seconds / dt);
  const every = Math.round(DEMO_STEP_S / dt);

  for (let i = 0; i <= steps; i++) {
    const t = i * dt;
    const target = (plan.find((p) => t < p.until) ?? plan[plan.length - 1])?.target ?? 0;
    const kph = speed * 3.6;
    const error = target - kph;
    const throttle = error > 0 ? clamp(error / 25, 0.04, t < 12 ? launch : 0.85) : 0.02;
    const brake = error < -6 ? clamp(-error / 40, 0, 0.8) : 0;
    const accel = throttle * (PUSH[gear] ?? 0.8) - brake * 5 - 0.0009 * speed * speed - 0.05;
    speed = clamp(speed + accel * dt, 0, 62);

    let rpm = Math.max(800, speed * 3.6 * (RPM_PER_KPH[gear] ?? 24));
    if (rpm > shiftRpm && gear < RPM_PER_KPH.length - 1) gear++;
    else if (rpm < 1400 && gear > 0 && speed > 0.5) gear--;
    rpm = Math.max(800, speed * 3.6 * (RPM_PER_KPH[gear] ?? 24));
    if (speed < 0.5) gear = 0;

    coolant += (88 - coolant) * (dt / 70);
    fuel -= dt * 0.004 * (0.5 + throttle);

    if (i % every !== 0) continue;
    const wobble = (rand() - 0.5) * 30;
    const thrPct = throttle < 0.05 ? rand() * 4 : throttle * 100;
    samples.push({
      t_s: r2(t),
      rpm: r2(Math.round(clamp(rpm + wobble, 600, 7000) * 4) / 4),
      speed_kph: Math.round(clamp(speed * 3.6, 0, 255)),
      coolant_c: Math.round(coolant),
      intake_c: Math.round(28 + (coolant - 60) * 0.1 + kph * 0.02),
      throttle_pct: r2(clamp(thrPct, 0, 100)),
      load_pct: r2(clamp(14 + throttle * 62 + rpm / 400, 0, 100)),
      map_kpa: Math.round(clamp(28 + throttle * 72, 20, 105)),
      baro_kpa: baro,
      volts: r2(clamp(speed < 0.5 ? 13.7 + rand() * 0.2 : 14.0 + rand() * 0.3, 11, 15)),
      fuel_pct: r2(clamp(fuel, 0, 100)),
    });
  }

  return { id: `demo-${seed}`, started, label: DEMO_LABEL, source: 'demo', samples };
}
