/**
 * Replaying a recorded drive, parked.
 *
 * The safest way to tune music to a car is on a recording of the car. Open Gauge (the author's
 * OBD-II dashboard) saves drives as a JSON or CSV log with an `rpm` channel. This module reads
 * one back and answers "what were the revs at second 41.3?" for any time, holding the last
 * reported value until the next one, the way the car itself reported it.
 *
 * A log without RPM is refused rather than guessed from speed: a gear would have to be assumed,
 * and a wrong assumption would lock the song to a note the engine never made.
 */

import { importCsv } from './csv';
import { type Drive, type Point, holdValue, normalizeDrive, seriesOf } from './log';

export type ReplayRead = { ok: true; replay: Replay } | { ok: false; error: string };

export interface ReplayFrame {
  rpm: number;
  throttlePct: number | null;
  speedKph: number | null;
}

export class Replay {
  private readonly rpm: Point[];
  private readonly throttle: Point[];
  private readonly speed: Point[];
  readonly duration: number;
  readonly label: string;
  readonly source: Drive['source'];
  readonly samples: number;

  constructor(drive: Drive) {
    this.rpm = seriesOf(drive, 'rpm');
    this.throttle = seriesOf(drive, 'throttle_pct');
    this.speed = seriesOf(drive, 'speed_kph');
    this.duration = this.rpm.at(-1)?.t ?? 0;
    this.label = drive.label;
    this.source = drive.source;
    this.samples = this.rpm.length;
  }

  /** The car's state at `seconds` from the start. Before the first sample it is the first sample. */
  at(seconds: number): ReplayFrame {
    const t = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
    const first = this.rpm[0];
    const rpm = holdValue(this.rpm, t) ?? first?.v ?? 0;
    return {
      rpm,
      throttlePct: holdValue(this.throttle, t) ?? (this.throttle[0]?.v ?? null),
      speedKph: holdValue(this.speed, t) ?? (this.speed[0]?.v ?? null),
    };
  }
}

/** Read a drive from Open Gauge JSON or CSV text. */
export function readReplay(text: string): ReplayRead {
  const trimmed = text.trim();
  if (trimmed === '') return { ok: false, error: 'The file is empty.' };
  let drive: Drive | null = null;
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const raw: unknown = JSON.parse(trimmed);
      drive = normalizeDrive(Array.isArray(raw) ? { id: 'pasted', started: '', label: 'pasted drive', source: 'car', samples: raw } : raw);
    } catch {
      return { ok: false, error: 'That is not valid JSON.' };
    }
    if (!drive) return { ok: false, error: 'This JSON is not an Open Gauge drive: it needs a samples list with t_s times.' };
  } else {
    const csv = importCsv(trimmed);
    if (!csv.ok) return { ok: false, error: csv.error };
    drive = { id: 'csv', started: '', label: 'log file', source: 'car', samples: csv.samples };
  }
  return fromDrive(drive);
}

export function fromDrive(drive: Drive): ReplayRead {
  const replay = new Replay(drive);
  if (replay.samples < 2) return { ok: false, error: 'This log has fewer than two RPM readings. Rev Key needs the rpm channel.' };
  if (replay.duration <= 0) return { ok: false, error: 'This log has no time span.' };
  return { ok: true, replay };
}
