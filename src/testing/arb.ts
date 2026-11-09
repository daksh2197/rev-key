/** Random drives for property tests, made from a seed so they are cheap to generate and easy to replay. */

import fc from 'fast-check';
import { mulberry32 } from '../core/demo';
import { CHANNELS, type Drive, type Sample } from '../core/log';
import { PIDS } from '../obd/pids';

/** Sparse drive: each channel is reported with its own probability, times rise by random steps. */
export function randomDrive(seed: number, count: number, opts: { startMs?: number } = {}): Drive {
  const rand = mulberry32(seed);
  const present = new Map(CHANNELS.map((ch) => [ch, rand() < 0.15 ? 0 : rand()] as const));
  const samples: Sample[] = [];
  let ms = opts.startMs ?? 0;
  for (let i = 0; i < count; i++) {
    ms += 1 + Math.floor(rand() * 400);
    const s: Sample = { t_s: ms / 1000 };
    for (const pid of PIDS) {
      if (rand() < (present.get(pid.channel) ?? 0)) {
        const lo = Math.max(pid.min, -1000);
        const v = Math.round((lo + rand() * (pid.max - lo)) * 100) / 100;
        s[pid.channel] = v === 0 ? 0 : v; // never minus zero
      }
    }
    samples.push(s);
  }
  return { id: `r-${seed}`, started: '2026-02-03T04:05:06.000Z', label: `Car ${seed}`, source: 'car', samples };
}

export const seedArb = fc.integer({ min: 0, max: 2 ** 31 - 1 });
export const countArb = fc.integer({ min: 0, max: 2000 });
