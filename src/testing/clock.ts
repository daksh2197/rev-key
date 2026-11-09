/** A clock the tests wind by hand, so a minute of conversation takes a blink. Used by tests only. */

import type { Clock } from '../obd/session';

export class ManualClock implements Clock {
  private time = 0;
  private timers: { at: number; seq: number; fn: () => void }[] = [];
  private seq = 0;

  now(): number {
    return this.time;
  }

  after(ms: number, fn: () => void): () => void {
    const timer = { at: this.time + Math.max(0, ms), seq: this.seq++, fn };
    this.timers.push(timer);
    return () => {
      this.timers = this.timers.filter((t) => t !== timer);
    };
  }

  /** Move time forward, firing everything that falls due, in order. */
  advance(ms: number): void {
    const target = this.time + ms;
    for (;;) {
      const due = this.timers.filter((t) => t.at <= target).sort((a, b) => a.at - b.at || a.seq - b.seq)[0];
      if (!due) break;
      this.timers = this.timers.filter((t) => t !== due);
      this.time = Math.max(this.time, due.at);
      due.fn();
    }
    this.time = target;
  }
}

/** Let pending promise callbacks run (they hop through a few microtasks). */
export function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Wind the clock in small steps until the promise settles or `maxMs` of fake time passes.
 * Returns whether it settled; a hang shows up as false instead of a stuck test.
 */
export async function runUntilSettled<T>(
  clock: ManualClock,
  promise: Promise<T>,
  maxMs = 600_000,
  stepMs = 10,
): Promise<{ settled: boolean; value?: T }> {
  let settled = false;
  let value: T | undefined;
  void promise.then((v) => {
    settled = true;
    value = v;
  });
  for (let t = 0; t < maxMs && !settled; t += stepMs) {
    await flush();
    clock.advance(stepMs);
  }
  await flush();
  return settled ? { settled, value: value as T } : { settled };
}
