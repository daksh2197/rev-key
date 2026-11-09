import { describe, expect, it } from 'vitest';
import { toCsv } from './csv';
import { makeDemoDrive } from './demo';
import type { Drive } from './log';
import { fromDrive, readReplay } from './replay';

const drive: Drive = {
  id: 'd1',
  started: '2026-10-19T00:00:00.000Z',
  label: 'test car',
  source: 'car',
  samples: [
    { t_s: 0, rpm: 800, throttle_pct: 0, speed_kph: 0 },
    { t_s: 1, rpm: 2000, throttle_pct: 40 },
    { t_s: 2.5, rpm: 3000, speed_kph: 50 },
    { t_s: 4, rpm: 2200, throttle_pct: 15, speed_kph: 90 },
  ],
};

describe('Replay', () => {
  it('holds the last reported value between samples, like the car did', () => {
    const r = fromDrive(drive);
    if (!r.ok) throw new Error(r.error);
    expect(r.replay.at(0.5).rpm).toBe(800);
    expect(r.replay.at(1).rpm).toBe(2000);
    expect(r.replay.at(2.4).rpm).toBe(2000);
    expect(r.replay.at(2.5).rpm).toBe(3000);
    expect(r.replay.at(99).rpm).toBe(2200);
  });

  it('channels a sample did not report hold their own last value', () => {
    const r = fromDrive(drive);
    if (!r.ok) throw new Error(r.error);
    expect(r.replay.at(2.6).throttlePct).toBe(40); // throttle missing at 2.5
    expect(r.replay.at(1.5).speedKph).toBe(0); // speed missing at 1
  });

  it('before the first sample it is the first sample; junk time is time zero', () => {
    const r = fromDrive(drive);
    if (!r.ok) throw new Error(r.error);
    expect(r.replay.at(-3).rpm).toBe(800);
    expect(r.replay.at(Number.NaN).rpm).toBe(800);
  });

  it('knows its length, label and sample count', () => {
    const r = fromDrive(drive);
    if (!r.ok) throw new Error(r.error);
    expect(r.replay.duration).toBe(4);
    expect(r.replay.label).toBe('test car');
    expect(r.replay.samples).toBe(4);
  });

  it('refuses a log with no rpm', () => {
    const r = fromDrive({ ...drive, samples: [{ t_s: 0, speed_kph: 10 }, { t_s: 1, speed_kph: 20 }] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/rpm/);
  });
});

describe('readReplay', () => {
  it('reads an Open Gauge JSON export', () => {
    const r = readReplay(JSON.stringify(drive));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.replay.at(1).rpm).toBe(2000);
  });

  it('reads a bare samples array', () => {
    const r = readReplay(JSON.stringify(drive.samples));
    expect(r.ok).toBe(true);
  });

  it('reads an Open Gauge CSV export', () => {
    const r = readReplay(toCsv(drive));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.replay.at(2.5).rpm).toBe(3000);
      expect(r.replay.duration).toBe(4);
    }
  });

  it('reads the invented demo drive and it is long enough to cruise', () => {
    const r = readReplay(JSON.stringify(makeDemoDrive(1)));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.replay.source).toBe('demo');
      expect(r.replay.duration).toBeGreaterThan(60);
    }
  });

  it('says what is wrong with junk', () => {
    expect(readReplay('')).toEqual({ ok: false, error: 'The file is empty.' });
    expect(readReplay('{not json')).toEqual({ ok: false, error: 'That is not valid JSON.' });
    expect(readReplay('{"hello":1}').ok).toBe(false);
    expect(readReplay('a,b,c\n1,2,3').ok).toBe(false);
  });
});
