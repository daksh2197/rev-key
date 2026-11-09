/**
 * What a drive is, in memory: a list of samples, each stamped with seconds from the start.
 *
 * A sample only carries the channels the car actually reported in that cycle. A channel that
 * is missing is missing: nothing in here ever fills a gap with a guess.
 */

export const CHANNELS = [
  'rpm',
  'speed_kph',
  'coolant_c',
  'intake_c',
  'throttle_pct',
  'load_pct',
  'map_kpa',
  'baro_kpa',
  'volts',
  'fuel_pct',
] as const;

export type Channel = (typeof CHANNELS)[number];

export type Sample = { t_s: number } & Partial<Record<Channel, number>>;

export type DriveSource = 'car' | 'demo';

export interface Drive {
  id: string;
  /** ISO 8601 time the recording started. */
  started: string;
  /** The car label the user typed ("Eclipse"), or the demo label. */
  label: string;
  source: DriveSource;
  samples: Sample[];
}

export const DEMO_LABEL = 'Invented demo drive, not a real car';

/** Values beyond this are treated as junk: no OBD-II quantity gets near it. */
const LIMIT = 1e9;

export function isChannel(name: string): name is Channel {
  return (CHANNELS as readonly string[]).includes(name);
}

function finite(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && Math.abs(n) < LIMIT;
}

/** Keep only finite numbers on known channels. Returns null when there is no usable time. */
export function cleanSample(raw: unknown): Sample | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const src = raw as Record<string, unknown>;
  const t = src.t_s;
  if (!finite(t) || t < 0) return null;
  const out: Sample = { t_s: t === 0 ? 0 : t };
  for (const ch of CHANNELS) {
    const v = src[ch];
    if (finite(v)) out[ch] = v === 0 ? 0 : v; // 0 and not -0
  }
  return out;
}

export function newDrive(id: string, started: string, label: string, source: DriveSource): Drive {
  return { id, started, label, source, samples: [] };
}

/** Add a sample if it is usable and not earlier than the last one. Returns whether it was added. */
export function appendSample(drive: Drive, raw: unknown): boolean {
  const s = cleanSample(raw);
  if (!s) return false;
  const last = drive.samples[drive.samples.length - 1];
  if (last && s.t_s < last.t_s) return false;
  drive.samples.push(s);
  return true;
}

/** Seconds from the first sample to the last. 0 for fewer than two samples. */
export function duration(drive: Drive): number {
  const first = drive.samples[0];
  const last = drive.samples[drive.samples.length - 1];
  if (!first || !last) return 0;
  return Math.max(0, last.t_s - first.t_s);
}

export function channelsPresent(drive: Drive): Channel[] {
  const seen = new Set<Channel>();
  for (const s of drive.samples) for (const ch of CHANNELS) if (finite(s[ch])) seen.add(ch);
  return CHANNELS.filter((ch) => seen.has(ch));
}

export interface Point {
  t: number;
  v: number;
}

/** Every reported value of one channel, in time order. */
export function seriesOf(drive: Drive, ch: Channel): Point[] {
  const out: Point[] = [];
  for (const s of drive.samples) {
    const v = s[ch];
    if (finite(v)) out.push({ t: s.t_s, v });
  }
  return out;
}

/** Index of the last point with t <= time, or -1. */
function lastAtOrBefore(series: Point[], time: number): number {
  let lo = 0;
  let hi = series.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const p = series[mid];
    if (p && p.t <= time) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

/**
 * The value at `time`, drawn as a straight line between the two reported points around it.
 * Outside the reported range the answer is null: the series is never stretched past its ends.
 */
export function valueAt(series: Point[], time: number): number | null {
  if (!Number.isFinite(time) || series.length === 0) return null;
  const i = lastAtOrBefore(series, time);
  const a = series[i];
  if (!a) return null;
  if (a.t === time) return a.v;
  const b = series[i + 1];
  if (!b) return null;
  const span = b.t - a.t;
  if (span <= 0) return a.v;
  return a.v + ((b.v - a.v) * (time - a.t)) / span;
}

/** The last reported value at or before `time` (what a gauge shows between slow readings). */
export function holdValue(series: Point[], time: number): number | null {
  if (!Number.isFinite(time)) return null;
  const p = series[lastAtOrBefore(series, time)];
  return p ? p.v : null;
}

/** Boost-like reading: manifold pressure minus barometric pressure, only when both are reported. */
export function mapMinusBaro(map: number | null | undefined, baro: number | null | undefined): number | null {
  if (!finite(map) || !finite(baro)) return null;
  const d = map - baro;
  return d === 0 ? 0 : d;
}

export function slug(text: string): string {
  const s = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return s || 'drive';
}

/** "demo-" in front of anything that is not a real car, so a demo file can never pass for a recording. */
export function exportFileName(drive: Drive, ext: 'csv' | 'json'): string {
  const stamp = drive.started.replace(/[^0-9]/g, '').slice(0, 14) || 'undated';
  const name = slug(drive.source === 'demo' ? 'open-gauge' : drive.label);
  return `${drive.source === 'demo' ? 'demo-' : ''}${name}-${stamp}.${ext}`;
}

/** Rebuild a drive from something read off disk. Anything unusable is dropped; a record with no id is refused. */
export function normalizeDrive(raw: unknown): Drive | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || r.id === '' || !Array.isArray(r.samples)) return null;
  const samples: Sample[] = [];
  for (const item of r.samples) {
    const s = cleanSample(item);
    if (s) samples.push(s);
  }
  samples.sort((a, b) => a.t_s - b.t_s);
  return {
    id: r.id,
    started: typeof r.started === 'string' ? r.started : '',
    label: typeof r.label === 'string' ? r.label : 'drive',
    source: r.source === 'demo' ? 'demo' : 'car',
    samples,
  };
}
