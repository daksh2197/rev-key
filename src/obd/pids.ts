/**
 * The PIDs this app reads, and the arithmetic that turns the car's bytes into numbers.
 *
 * Source: the public OBD-II PID list (SAE J1979, as published on the Wikipedia "OBD-II PIDs"
 * page, fetched Oct 20, 2026). A and B are the first and second data bytes of the answer.
 * Each PID also knows how to run backwards (encode) so the fake adapter can speak real bytes.
 */

import type { Channel } from '../core/log';

export type PollRate = 'fast' | 'slow';

export interface Pid {
  id: number;
  channel: Channel;
  name: string;
  unit: string;
  /** How many data bytes the car sends back. */
  bytes: 1 | 2;
  /** The value the PID can never go below or above, from the formula alone. */
  min: number;
  max: number;
  /** Decimals worth showing. */
  digits: number;
  /** 'fast' PIDs are asked every cycle; 'slow' ones every tenth. */
  rate: PollRate;
  decode(a?: number, b?: number): number;
  /** The nearest bytes for a value (clamped into range). */
  encode(value: number): number[];
}

const byte = (n: number): number => Math.min(255, Math.max(0, Math.round(Number.isFinite(n) ? n : 0)));
const word = (n: number): number[] => {
  const v = Math.min(65535, Math.max(0, Math.round(Number.isFinite(n) ? n : 0)));
  return [v >> 8, v & 255];
};

/** Bytes outside 0..255 are masked, so no input can make a value leave its range. */
const u8 = (n: number | undefined): number => (n === undefined || !Number.isFinite(n) ? 0 : Math.trunc(n) & 255);

export const PIDS: readonly Pid[] = [
  {
    id: 0x0c,
    channel: 'rpm',
    name: 'Engine speed',
    unit: 'rpm',
    bytes: 2,
    min: 0,
    max: 16383.75,
    digits: 0,
    rate: 'fast',
    decode: (a, b) => (256 * u8(a) + u8(b)) / 4,
    encode: (v) => word(v * 4),
  },
  {
    id: 0x0d,
    channel: 'speed_kph',
    name: 'Vehicle speed',
    unit: 'km/h',
    bytes: 1,
    min: 0,
    max: 255,
    digits: 0,
    rate: 'fast',
    decode: (a) => u8(a),
    encode: (v) => [byte(v)],
  },
  {
    id: 0x11,
    channel: 'throttle_pct',
    name: 'Throttle position',
    unit: '%',
    bytes: 1,
    min: 0,
    max: 100,
    digits: 0,
    rate: 'fast',
    decode: (a) => (u8(a) * 100) / 255,
    encode: (v) => [byte((v * 255) / 100)],
  },
  {
    id: 0x0b,
    channel: 'map_kpa',
    name: 'Manifold pressure',
    unit: 'kPa',
    bytes: 1,
    min: 0,
    max: 255,
    digits: 0,
    rate: 'fast',
    decode: (a) => u8(a),
    encode: (v) => [byte(v)],
  },
  {
    id: 0x05,
    channel: 'coolant_c',
    name: 'Coolant temperature',
    unit: '°C',
    bytes: 1,
    min: -40,
    max: 215,
    digits: 0,
    rate: 'slow',
    decode: (a) => u8(a) - 40,
    encode: (v) => [byte(v + 40)],
  },
  {
    id: 0x0f,
    channel: 'intake_c',
    name: 'Intake air temperature',
    unit: '°C',
    bytes: 1,
    min: -40,
    max: 215,
    digits: 0,
    rate: 'slow',
    decode: (a) => u8(a) - 40,
    encode: (v) => [byte(v + 40)],
  },
  {
    id: 0x42,
    channel: 'volts',
    name: 'Control module voltage',
    unit: 'V',
    bytes: 2,
    min: 0,
    max: 65.535,
    digits: 1,
    rate: 'slow',
    decode: (a, b) => (256 * u8(a) + u8(b)) / 1000,
    encode: (v) => word(v * 1000),
  },
  {
    id: 0x2f,
    channel: 'fuel_pct',
    name: 'Fuel level',
    unit: '%',
    bytes: 1,
    min: 0,
    max: 100,
    digits: 0,
    rate: 'slow',
    decode: (a) => (u8(a) * 100) / 255,
    encode: (v) => [byte((v * 255) / 100)],
  },
  {
    id: 0x04,
    channel: 'load_pct',
    name: 'Engine load',
    unit: '%',
    bytes: 1,
    min: 0,
    max: 100,
    digits: 0,
    rate: 'slow',
    decode: (a) => (u8(a) * 100) / 255,
    encode: (v) => [byte((v * 255) / 100)],
  },
  {
    id: 0x33,
    channel: 'baro_kpa',
    name: 'Barometric pressure',
    unit: 'kPa',
    bytes: 1,
    min: 0,
    max: 255,
    digits: 0,
    rate: 'slow',
    decode: (a) => u8(a),
    encode: (v) => [byte(v)],
  },
];

/** The "which PIDs do you support" questions: 00 covers 01-20, 20 covers 21-40, 40 covers 41-60. */
export const BITMAP_PIDS = [0x00, 0x20, 0x40] as const;

/** Slow PIDs are asked on every tenth cycle. */
export const SLOW_EVERY = 10;

export function pidById(id: number): Pid | undefined {
  return PIDS.find((p) => p.id === id);
}

export function pidForChannel(ch: Channel): Pid | undefined {
  return PIDS.find((p) => p.channel === ch);
}

export function hex2(n: number): string {
  return (n & 255).toString(16).toUpperCase().padStart(2, '0');
}

/** The request line for a PID: mode 01 plus the PID, e.g. "010C". */
export function requestFor(pidId: number): string {
  return `01${hex2(pidId)}`;
}

/** Turn the four data bytes of a bitmap answer into the list of PIDs they announce. */
export function decodeSupported(base: number, bytes: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < 32; i++) {
    const b = bytes[i >> 3];
    if (b === undefined) break;
    if ((b >> (7 - (i & 7))) & 1) out.push(base + 1 + i);
  }
  return out;
}

/** The opposite: build the four bitmap bytes for a base from a set of PID numbers. */
export function encodeSupported(base: number, pids: Iterable<number>): number[] {
  const out = [0, 0, 0, 0];
  for (const p of pids) {
    const i = p - base - 1;
    if (i >= 0 && i < 32) out[i >> 3] = (out[i >> 3] ?? 0) | (0x80 >> (i & 7));
  }
  return out;
}
