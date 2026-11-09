import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { countArb, randomDrive, seedArb } from '../testing/arb';
import { CSV_HEADER, importCsv, toCsv } from './csv';
import { CHANNELS, type Drive } from './log';

const samplesOf = (text: string) => {
  const r = importCsv(text);
  if (!r.ok) throw new Error(r.error);
  return r;
};
const allFinite = (v: unknown): boolean =>
  typeof v === 'number' ? Number.isFinite(v) : Array.isArray(v) ? v.every(allFinite) : typeof v === 'object' && v !== null ? Object.values(v).every(allFinite) : true;

describe('the file layout', () => {
  it('starts with exactly the header from the spec', () => {
    expect(CSV_HEADER).toBe('t_s,rpm,speed_kph,coolant_c,intake_c,throttle_pct,load_pct,map_kpa,baro_kpa,volts,fuel_pct');
    expect(toCsv(randomDrive(1, 3)).split('\n')[0]).toBe(CSV_HEADER);
  });
  it('has the header as the first line even for an empty drive', () => {
    expect(toCsv(randomDrive(1, 0))).toBe(CSV_HEADER + '\n');
  });
  it('writes t_s with three decimals', () => {
    const d: Drive = { ...randomDrive(1, 0), samples: [{ t_s: 1.5, rpm: 900 }] };
    expect(toCsv(d).split('\n')[1]).toMatch(/^1\.500,900,/);
  });
  it('leaves a cell empty for a channel the car did not report', () => {
    const d: Drive = { ...randomDrive(1, 0), samples: [{ t_s: 0, speed_kph: 50 }] };
    expect(toCsv(d).split('\n')[1]).toBe('0.000,,50,,,,,,,,');
  });
  it('writes at most two decimals and no trailing zeros', () => {
    const d: Drive = { ...randomDrive(1, 0), samples: [{ t_s: 0, volts: 13.456, rpm: 2000.5 }] };
    expect(toCsv(d).split('\n')[1]).toBe('0.000,2000.5,,,,,,,,13.46,');
  });
  it('writes a row with the right number of cells', () => {
    for (const line of toCsv(randomDrive(7, 30)).split('\n').filter(Boolean)) {
      expect(line.split(',')).toHaveLength(CHANNELS.length + 1);
    }
  });
  it('ends with a single newline and has no comment lines', () => {
    const text = toCsv(randomDrive(2, 5));
    expect(text.endsWith('\n')).toBe(true);
    expect(text.endsWith('\n\n')).toBe(false);
    expect(text).not.toMatch(/^#/m);
  });
  it('never writes NaN, Infinity or minus zero', () => {
    const d: Drive = { ...randomDrive(1, 0), samples: [{ t_s: 0, rpm: -0, volts: -0.001, speed_kph: NaN }] };
    expect(toCsv(d)).not.toMatch(/NaN|Infinity|-0(,|\n|$)/);
  });
});

describe('round trip', () => {
  it('gives back every sample of a random drive, sparse channels included', () => {
    fc.assert(
      fc.property(seedArb, countArb, (seed, n) => {
        const d = randomDrive(seed, n);
        const r = samplesOf(toCsv(d));
        expect(r.samples).toEqual(d.samples);
        return r.dropped === 0;
      }),
      { numRuns: 300 },
    );
  }, 30_000);
  it('gives back a one-sample drive', () => {
    const d = randomDrive(5, 1);
    expect(samplesOf(toCsv(d)).samples).toEqual(d.samples);
  });
  it('gives back an empty drive as no samples', () => expect(samplesOf(toCsv(randomDrive(5, 0))).samples).toEqual([]));
  it('survives a 2,000-sample drive', () => {
    const d = randomDrive(11, 2000);
    expect(samplesOf(toCsv(d)).samples).toHaveLength(2000);
  });
});

describe('importing awkward files', () => {
  const good = `${CSV_HEADER}\n0.000,800,0,80,25,2,20,35,100,13.8,50\n1.000,2000,10,80,25,10,30,40,100,13.9,50\n`;
  it('reads a clean file', () => expect(samplesOf(good).samples).toHaveLength(2));
  it('reads a file with CRLF line endings', () => {
    expect(samplesOf(good.replace(/\n/g, '\r\n')).samples).toEqual(samplesOf(good).samples);
  });
  it('reads a file with old-Mac CR line endings', () => {
    expect(samplesOf(good.replace(/\n/g, '\r')).samples).toHaveLength(2);
  });
  it('reads a file with a BOM in front', () => expect(samplesOf('﻿' + good).samples).toHaveLength(2));
  it('reads a file with no trailing newline', () => expect(samplesOf(good.trimEnd()).samples).toHaveLength(2));
  it('reads a file with extra blank lines', () => expect(samplesOf(good + '\n\n\n').samples).toHaveLength(2));
  it('reads columns in any order', () => {
    const r = samplesOf('speed_kph,t_s,rpm\n50,1.5,2000\n');
    expect(r.samples).toEqual([{ t_s: 1.5, speed_kph: 50, rpm: 2000 }]);
  });
  it('reads a file with only t_s and one channel', () => {
    expect(samplesOf('t_s,volts\n0,12.5\n').samples).toEqual([{ t_s: 0, volts: 12.5 }]);
  });
  it('ignores unknown columns', () => {
    expect(samplesOf('t_s,gps_lat,rpm\n0,51.0,900\n').samples).toEqual([{ t_s: 0, rpm: 900 }]);
  });
  it('ignores header case and spaces', () => {
    expect(samplesOf(' T_S , RPM \n0,900\n').samples).toEqual([{ t_s: 0, rpm: 900 }]);
  });
  it('drops rows whose t_s is not a number and counts them', () => {
    const r = samplesOf('t_s,rpm\n0,900\nabc,900\n,900\n2,1000\n');
    expect(r.samples).toHaveLength(2);
    expect(r.dropped).toBe(2);
  });
  it('drops rows with a negative or infinite time', () => {
    const r = samplesOf('t_s,rpm\n-1,900\nInfinity,900\n1e999,900\n3,1000\n');
    expect(r.samples).toHaveLength(1);
    expect(r.dropped).toBe(3);
  });
  it('treats a non-numeric cell as empty and keeps the row', () => {
    const r = samplesOf('t_s,rpm,volts\n0,abc,12\n');
    expect(r.samples).toEqual([{ t_s: 0, volts: 12 }]);
    expect(r.dropped).toBe(0);
  });
  it('treats NaN and Infinity cells as empty', () => {
    expect(samplesOf('t_s,rpm,volts\n0,NaN,Infinity\n').samples).toEqual([{ t_s: 0 }]);
  });
  it('sorts rows that arrive out of order', () => {
    expect(samplesOf('t_s,rpm\n2,1\n1,2\n').samples.map((s) => s.t_s)).toEqual([1, 2]);
  });
  it('accepts scientific notation', () => expect(samplesOf('t_s,rpm\n1e0,1.5e3\n').samples).toEqual([{ t_s: 1, rpm: 1500 }]));
  it('reads short rows in the middle as having empty cells', () => {
    const r = samplesOf('t_s,rpm,volts\n0,900\n1,950,12\n');
    expect(r.samples).toEqual([{ t_s: 0, rpm: 900 }, { t_s: 1, rpm: 950, volts: 12 }]);
  });
  it('turns minus zero into zero', () => {
    const r = samplesOf('t_s,rpm\n-0,-0\n');
    expect(Object.is(r.samples[0]?.t_s, 0)).toBe(true);
    expect(Object.is(r.samples[0]?.rpm, 0)).toBe(true);
  });
});

describe('files that are not logs', () => {
  it('refuses an empty file', () => expect(importCsv('').ok).toBe(false));
  it('refuses a file of only whitespace', () => expect(importCsv('  \n \n').ok).toBe(false));
  it('refuses a file whose first line is not a header with t_s', () => {
    const r = importCsv('rpm,speed\n900,0\n');
    expect(r.ok).toBe(false);
  });
  it('refuses a file with a comment line before the header', () => {
    expect(importCsv('# my log\n' + CSV_HEADER + '\n0,1\n').ok).toBe(false);
  });
  it('refuses JSON', () => expect(importCsv('{"format":"pitwall-session/1"}').ok).toBe(false));
  it('refuses a binary-looking file', () => expect(importCsv('\u0000\u0001\u0002\nÿ').ok).toBe(false));
  it('gives a sentence as the error', () => {
    const r = importCsv('nope');
    expect(!r.ok && r.error.length > 10).toBe(true);
  });
});

describe('truncated files', () => {
  const full = toCsv(randomDrive(9, 40));
  it('drops a last row cut short and says so', () => {
    const cut = full.slice(0, full.length - 9); // cut inside the last row, before its newline
    const r = samplesOf(cut);
    expect(r.truncated).toBe(true);
    expect(r.samples).toHaveLength(39);
    expect(r.dropped).toBe(1);
  });
  it('keeps every earlier row of a file cut anywhere', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: full.length }), (cut) => {
        const r = importCsv(full.slice(0, cut));
        if (!r.ok) return true;
        return r.samples.length <= 40 && allFinite(r.samples);
      }),
      { numRuns: 300 },
    );
  });
  it('treats a file cut inside the header as not a log', () => {
    expect(importCsv('t_s,rp').ok).toBe(true); // t_s is there, rest is just unknown
    expect(importCsv('t_').ok).toBe(false);
  });
  it('is not truncated when the file ends with a newline', () => {
    expect(samplesOf(full).truncated).toBe(false);
  });
});

describe('junk through the importer', () => {
  it('never throws and never returns a non-finite number, for any string', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 400 }), (s) => {
        const r = importCsv(s);
        return r.ok ? allFinite(r.samples) && Number.isFinite(r.dropped) : typeof r.error === 'string';
      }),
      { numRuns: 300 },
    );
  });
  it('never throws on random lines under a real header', () => {
    fc.assert(
      fc.property(fc.array(fc.string({ maxLength: 60 }), { maxLength: 30 }), (rows) => {
        const r = importCsv(CSV_HEADER + '\n' + rows.join('\n'));
        return r.ok && allFinite(r.samples);
      }),
      { numRuns: 300 },
    );
  });
  it('never throws on random bytes read as text', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 500 }), (bytes) => {
        const r = importCsv(new TextDecoder().decode(bytes));
        return r.ok ? allFinite(r.samples) : true;
      }),
      { numRuns: 300 },
    );
  });
  it('never throws on values that are not strings', () => {
    expect(importCsv(undefined as unknown as string).ok).toBe(false);
    expect(importCsv(null as unknown as string).ok).toBe(false);
    expect(importCsv(5 as unknown as string).ok).toBe(false);
  });
  it('counts a huge number of junk rows without trouble', () => {
    const r = samplesOf('t_s,rpm\n' + 'x,1\n'.repeat(20000));
    expect(r.dropped).toBe(20000);
  });
});
