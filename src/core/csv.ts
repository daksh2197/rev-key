/**
 * The Open Gauge log v1 file: one row per sample cycle, a fixed header, an empty cell for
 * anything the car did not report in that cycle.
 *
 *   t_s,rpm,speed_kph,coolant_c,intake_c,throttle_pct,load_pct,map_kpa,baro_kpa,volts,fuel_pct
 *
 * No comment lines: the first line of the file is the header and it is what the importer checks.
 * Import is forgiving (CRLF, a BOM, a trailing newline, columns in any order, unknown columns,
 * junk rows) and never throws.
 */

import { CHANNELS, type Channel, type Drive, type Sample, isChannel } from './log';

export const CSV_HEADER = ['t_s', ...CHANNELS].join(',');

/** More than this many rows is not a drive from a phone; the rest are counted as dropped. */
export const MAX_ROWS = 500_000;

const LIMIT = 1e9;

/** A number with up to `digits` decimals and no trailing zeros, never "-0" or "1e+21". */
function num(v: number, digits: number): string {
  const s = v.toFixed(digits);
  if (Number(s) === 0) return '0';
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
}

/** t_s with exactly 3 decimals, as the layout says. */
function time(v: number): string {
  const s = v.toFixed(3);
  return Number(s) === 0 ? '0.000' : s;
}

export function toCsv(drive: Drive): string {
  const lines = [CSV_HEADER];
  for (const s of drive.samples) {
    const cells = [time(s.t_s)];
    for (const ch of CHANNELS) {
      const v = s[ch];
      cells.push(typeof v === 'number' && Number.isFinite(v) && Math.abs(v) < LIMIT ? num(v, 2) : '');
    }
    lines.push(cells.join(','));
  }
  return lines.join('\n') + '\n';
}

export type CsvImport =
  | { ok: true; samples: Sample[]; dropped: number; truncated: boolean }
  | { ok: false; error: string };

function parseNumber(cell: string | undefined): number | null {
  if (cell === undefined) return null;
  const t = cell.trim();
  if (t === '' || !/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) && Math.abs(n) < LIMIT ? n : null;
}

/**
 * Read a log file. The first line must be a header that contains `t_s`. Rows whose `t_s` is not a
 * number are dropped and counted. A last row cut short (fewer cells than the header and no line
 * ending after it) is treated as a truncated file: dropped, counted, and `truncated` is true.
 */
export function importCsv(input: string): CsvImport {
  const text = typeof input === 'string' ? input.replace(/^﻿/, '') : '';
  if (text.trim() === '') return { ok: false, error: 'The file is empty.' };

  const endsWithNewline = /[\r\n]$/.test(text);
  const lines = text.split(/\r\n|\r|\n/);
  const headerLine = lines[0] ?? '';
  const header = headerLine.split(',').map((h) => h.trim().toLowerCase());
  const tIndex = header.indexOf('t_s');
  if (tIndex === -1) {
    return { ok: false, error: 'This is not an Open Gauge log: the first line must be a header with a t_s column.' };
  }
  const columns: { index: number; channel: Channel }[] = [];
  header.forEach((name, index) => {
    if (isChannel(name) && !columns.some((c) => c.channel === name)) columns.push({ index, channel: name });
  });

  const samples: Sample[] = [];
  let dropped = 0;
  let truncated = false;
  const last = lines.length - 1;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line.trim() === '') continue;
    if (samples.length + dropped >= MAX_ROWS) {
      dropped++;
      continue;
    }
    const cells = line.split(',');
    if (i === last && !endsWithNewline && cells.length < header.length) {
      dropped++;
      truncated = true;
      continue;
    }
    const t = parseNumber(cells[tIndex]);
    if (t === null || t < 0) {
      dropped++;
      continue;
    }
    const sample: Sample = { t_s: t === 0 ? 0 : t };
    for (const { index, channel } of columns) {
      const v = parseNumber(cells[index]);
      if (v !== null) sample[channel] = v === 0 ? 0 : v;
    }
    samples.push(sample);
  }
  samples.sort((a, b) => a.t_s - b.t_s); // stable: equal times keep file order
  return { ok: true, samples, dropped, truncated };
}
