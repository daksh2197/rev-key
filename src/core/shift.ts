/**
 * Gear changes, seen and foreseen.
 *
 * An upshift is easy to spot after the fact: under throttle, the RPM falls by hundreds in a
 * fraction of a second. But sound over Bluetooth arrives late, typically a few hundred
 * milliseconds after the phone plays it. A beat drop triggered when the shift is seen lands
 * after the shift. So this detector does two things:
 *
 *   1. Sees shifts. A drop of `dropRpm` or more inside `windowMs`, with the throttle on, is an
 *      upshift. It also remembers the RPM each shift started from and keeps a running median:
 *      that is where this driver, in this car, likes to shift.
 *   2. Foresees them. While the revs climb under throttle, it draws a straight line through the
 *      last `windowMs` of samples and asks: at this rate, when do we reach the usual shift RPM?
 *      If the answer is inside the audio lead time, it fires a `predicted` event once, so the
 *      drop can be scheduled early enough to be heard on the shift.
 *
 * Both are rules on a list of numbers, so both are tested without a car.
 */

export interface ShiftOptions {
  /** How far back the detector looks for a drop and a slope. */
  windowMs: number;
  /** A fall of at least this many RPM inside the window is an upshift. */
  dropRpm: number;
  /** Below this throttle a falling RPM is just lifting off, not a shift. 0 to 100. */
  minThrottlePct: number;
  /** After an event, ignore the next shifts for this long. */
  cooldownMs: number;
  /** How far ahead a predicted event may fire. Set this to the measured audio delay. */
  leadMs: number;
  /** Where to expect the first shifts, until the driver has shown where they shift. */
  defaultShiftRpm: number;
  /** How many seen shifts to remember for the running median. */
  memory: number;
}

export const DEFAULT_SHIFT: ShiftOptions = {
  windowMs: 350,
  dropRpm: 900,
  minThrottlePct: 35,
  cooldownMs: 900,
  leadMs: 0,
  defaultShiftRpm: 5800,
  memory: 8,
};

export interface ShiftSample {
  /** Milliseconds, any origin, increasing. */
  t: number;
  rpm: number;
  throttlePct: number;
}

export interface ShiftEvent {
  /** `seen`: the RPM just fell. `predicted`: it is about to, in roughly `inMs`. */
  kind: 'seen' | 'predicted';
  t: number;
  /** For a prediction: how far ahead the shift is expected. 0 for a seen shift. */
  inMs: number;
  /** The RPM the shift started from (seen) or is expected at (predicted). */
  fromRpm: number;
}

const clean = (n: number, fallback = 0): number => (Number.isFinite(n) ? n : fallback);

/** Middle value of a list; the mean of the two middle values for an even count. */
export function median(values: readonly number[]): number {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0) return Number.NaN;
  const mid = n >> 1;
  return n % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Least-squares slope of RPM against time, in RPM per second. 0 for fewer than two distinct times. */
export function slopeRpmPerSecond(samples: readonly ShiftSample[]): number {
  if (samples.length < 2) return 0;
  let st = 0;
  let sr = 0;
  for (const s of samples) {
    st += s.t;
    sr += s.rpm;
  }
  const mt = st / samples.length;
  const mr = sr / samples.length;
  let num = 0;
  let den = 0;
  for (const s of samples) {
    num += (s.t - mt) * (s.rpm - mr);
    den += (s.t - mt) * (s.t - mt);
  }
  if (den === 0) return 0;
  const perMs = num / den;
  return perMs * 1000;
}

export class ShiftDetector {
  private window: ShiftSample[] = [];
  private seenFrom: number[] = [];
  private lastEventAt = Number.NEGATIVE_INFINITY;
  /** True once a prediction fired for the current climb; cleared when the revs stop climbing. */
  private armed = true;

  constructor(private options: ShiftOptions = DEFAULT_SHIFT) {}

  get settings(): ShiftOptions {
    return this.options;
  }

  configure(patch: Partial<ShiftOptions>): void {
    this.options = { ...this.options, ...patch };
  }

  /** Where this driver shifts: the median of the shifts seen so far, or the default until then. */
  get shiftRpm(): number {
    const m = median(this.seenFrom);
    return Number.isFinite(m) ? m : this.options.defaultShiftRpm;
  }

  get shiftsSeen(): number {
    return this.seenFrom.length;
  }

  reset(): void {
    this.window = [];
    this.lastEventAt = Number.NEGATIVE_INFINITY;
    this.armed = true;
  }

  /** Feed one sample. Returns an event when one happens, else null. */
  push(raw: ShiftSample): ShiftEvent | null {
    const o = this.options;
    const t = clean(raw.t, this.window.at(-1)?.t ?? 0);
    const sample: ShiftSample = { t, rpm: Math.max(0, clean(raw.rpm)), throttlePct: Math.min(100, Math.max(0, clean(raw.throttlePct))) };
    this.window = this.window.filter((s) => s.t <= t && t - s.t <= o.windowMs);
    this.window.push(sample);

    const coolingDown = t - this.lastEventAt < o.cooldownMs;
    const throttleOn = sample.throttlePct >= o.minThrottlePct;

    // 1. A shift we can see: the highest RPM in the window minus the one we have now.
    let peak = sample.rpm;
    for (const s of this.window) if (s.rpm > peak) peak = s.rpm;
    if (throttleOn && peak - sample.rpm >= o.dropRpm) {
      // Learn from every shift, even one whose drop was already played early by a prediction.
      this.remember(peak);
      this.armed = true;
      this.window = [sample];
      if (coolingDown) return null;
      this.lastEventAt = t;
      return { kind: 'seen', t, inMs: 0, fromRpm: peak };
    }

    // 2. A shift we can foresee: climbing under throttle toward the usual shift point.
    const slope = slopeRpmPerSecond(this.window);
    if (slope <= 0 || !throttleOn) {
      this.armed = true; // the next climb may predict again
      return null;
    }
    if (coolingDown || !this.armed || o.leadMs <= 0) return null;
    const target = this.shiftRpm;
    if (sample.rpm >= target) return null; // already past it; the drop itself will be seen
    const inMs = ((target - sample.rpm) / slope) * 1000;
    if (inMs <= o.leadMs) {
      this.armed = false;
      this.lastEventAt = t;
      return { kind: 'predicted', t, inMs: Math.round(inMs), fromRpm: target };
    }
    return null;
  }

  private remember(fromRpm: number): void {
    this.seenFrom.push(fromRpm);
    if (this.seenFrom.length > this.options.memory) this.seenFrom.shift();
  }
}
