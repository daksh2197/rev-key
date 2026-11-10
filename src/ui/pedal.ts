/**
 * A USB racing wheel's pedals, read through the Gamepad API.
 *
 * Wheels report their pedals as axes, and every make puts them somewhere different, with the
 * resting value at +1 on some and -1 on others. Rather than ship a table of wheels, this learns:
 * the first readings are "rest", the furthest the axis travels is "full", and the pedal that
 * moves first becomes the throttle. The second pedal to move becomes the brake. A gamepad's
 * right trigger works too; it is just another axis or an analogue button. The steering axis
 * (axis 0, with axis 1 on some wheels) is never a candidate, so turning the wheel first does
 * not make steering the throttle.
 *
 * Nothing in here knows about sound or cars. `pedalValue` in the core does the arithmetic.
 */

import { pedalValue } from '../core/sim';

interface AxisMemory {
  rest: number;
  full: number;
}

export interface PedalReading {
  connected: boolean;
  /** 0 to 1. */
  throttle: number;
  brake: number;
  /** The wheel's own name, for the screen. */
  name: string;
  /** How many pedals have been learned so far. */
  learned: 0 | 1 | 2;
}

export class Pedals {
  private memory = new Map<string, AxisMemory>();
  private throttleKey: string | null = null;
  private brakeKey: string | null = null;

  reset(): void {
    this.memory.clear();
    this.throttleKey = null;
    this.brakeKey = null;
  }

  read(): PedalReading {
    const pads = typeof navigator.getGamepads === 'function' ? navigator.getGamepads() : [];
    const pad = Array.from(pads).find((p): p is Gamepad => p !== null && p.connected);
    if (!pad) return { connected: false, throttle: 0, brake: 0, name: '', learned: this.learnedCount() };

    const channels: { key: string; value: number }[] = [];
    // Axes 0 and 1 are the steering wheel on a wheel and the left stick on a pad, in every
    // mapping seen so far. They travel the full range too, so they are never offered as pedals.
    pad.axes.forEach((value, i) => {
      if (i >= 2) channels.push({ key: `a${i}`, value });
    });
    pad.buttons.forEach((b, i) => {
      // Analogue buttons (triggers) read 0 at rest and 1 pressed; only those with travel count.
      if (typeof b.value === 'number' && b.value > 0.02) channels.push({ key: `b${i}`, value: b.value });
    });

    for (const c of channels) {
      const m = this.memory.get(c.key);
      if (!m) {
        this.memory.set(c.key, { rest: c.value, full: c.value });
        continue;
      }
      if (Math.abs(c.value - m.rest) > Math.abs(m.full - m.rest)) m.full = c.value;
      const travel = Math.abs(m.full - m.rest);
      if (travel > 0.4 && c.key !== this.throttleKey && c.key !== this.brakeKey) {
        if (this.throttleKey === null) this.throttleKey = c.key;
        else if (this.brakeKey === null) this.brakeKey = c.key;
      }
    }

    const value = (key: string | null): number => {
      if (!key) return 0;
      const m = this.memory.get(key);
      const c = channels.find((x) => x.key === key);
      return m && c ? pedalValue(c.value, m.rest, m.full) : 0;
    };

    return { connected: true, throttle: value(this.throttleKey), brake: value(this.brakeKey), name: pad.id, learned: this.learnedCount() };
  }

  private learnedCount(): 0 | 1 | 2 {
    return this.brakeKey ? 2 : this.throttleKey ? 1 : 0;
  }
}
