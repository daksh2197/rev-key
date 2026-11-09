import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  BITMAP_PIDS,
  decodeSupported,
  encodeSupported,
  hex2,
  PIDS,
  pidById,
  pidForChannel,
  requestFor,
  SLOW_EVERY,
} from './pids';

const pid = (id: number) => {
  const p = pidById(id);
  if (!p) throw new Error(`no pid ${id}`);
  return p;
};

describe('PID decoding against the published formulas', () => {
  it('reads RPM 1A F8 as 1726', () => expect(pid(0x0c).decode(0x1a, 0xf8)).toBe(1726));
  it('reads RPM 00 00 as 0', () => expect(pid(0x0c).decode(0, 0)).toBe(0));
  it('reads RPM FF FF as 16383.75', () => expect(pid(0x0c).decode(0xff, 0xff)).toBe(16383.75));
  it('reads RPM 0A 00 as 640 (idle)', () => expect(pid(0x0c).decode(0x0a, 0)).toBe(640));
  it('reads coolant 7B as 83 degrees', () => expect(pid(0x05).decode(0x7b)).toBe(83));
  it('reads coolant 00 as minus 40', () => expect(pid(0x05).decode(0)).toBe(-40));
  it('reads coolant FF as 215', () => expect(pid(0x05).decode(0xff)).toBe(215));
  it('reads intake air 3C as 20 degrees', () => expect(pid(0x0f).decode(0x3c)).toBe(20));
  it('reads speed FF as 255', () => expect(pid(0x0d).decode(0xff)).toBe(255));
  it('reads speed 3C as 60', () => expect(pid(0x0d).decode(0x3c)).toBe(60));
  it('reads throttle FF as 100 percent', () => expect(pid(0x11).decode(0xff)).toBe(100));
  it('reads throttle 80 as about 50.2 percent', () => expect(pid(0x11).decode(0x80)).toBeCloseTo(50.196, 3));
  it('reads engine load 00 as 0 percent', () => expect(pid(0x04).decode(0)).toBe(0));
  it('reads fuel level FF as 100 percent', () => expect(pid(0x2f).decode(0xff)).toBe(100));
  it('reads manifold pressure 65 as 101 kPa', () => expect(pid(0x0b).decode(0x65)).toBe(101));
  it('reads barometric pressure 65 as 101 kPa', () => expect(pid(0x33).decode(0x65)).toBe(101));
  it('reads voltage 30 D4 as 12.5 volts', () => expect(pid(0x42).decode(0x30, 0xd4)).toBe(12.5));
  it('reads voltage 36 B0 as 14.0 volts', () => expect(pid(0x42).decode(0x36, 0xb0)).toBe(14));
  it('treats a missing second byte as zero', () => expect(pid(0x0c).decode(0x1a)).toBe(1664));
});

describe('PID table', () => {
  it('has ten PIDs, one per channel, no repeats', () => {
    expect(PIDS).toHaveLength(10);
    expect(new Set(PIDS.map((p) => p.id)).size).toBe(10);
    expect(new Set(PIDS.map((p) => p.channel)).size).toBe(10);
  });
  it('asks RPM, speed, throttle and MAP every cycle', () => {
    const fast = PIDS.filter((p) => p.rate === 'fast').map((p) => p.id);
    expect(fast.sort()).toEqual([0x0b, 0x0c, 0x0d, 0x11]);
  });
  it('asks temperatures, voltage and fuel on the slow cycle', () => {
    for (const id of [0x05, 0x0f, 0x42, 0x2f]) expect(pid(id).rate).toBe('slow');
    expect(SLOW_EVERY).toBe(10);
  });
  it('finds a PID by channel', () => expect(pidForChannel('rpm')?.id).toBe(0x0c));
  it('returns undefined for an unknown PID', () => expect(pidById(0x99)).toBeUndefined());
  it('writes requests as mode 01 plus two hex digits', () => {
    expect(requestFor(0x0c)).toBe('010C');
    expect(requestFor(0x04)).toBe('0104');
    expect(requestFor(0x00)).toBe('0100');
  });
  it('writes hex with a leading zero and capitals', () => expect(hex2(10)).toBe('0A'));
  it('lists the three bitmap questions', () => expect([...BITMAP_PIDS]).toEqual([0, 0x20, 0x40]));
  it('says two data bytes only for RPM and voltage', () => {
    expect(PIDS.filter((p) => p.bytes === 2).map((p) => p.id).sort()).toEqual([0x0c, 0x42]);
  });
});

describe('PID properties', () => {
  const byteArb = fc.integer({ min: 0, max: 255 });
  it('keeps every decoded value within the PID range for all byte pairs', () => {
    for (const p of PIDS) {
      fc.assert(
        fc.property(byteArb, byteArb, (a, b) => {
          const v = p.decode(a, b);
          return Number.isFinite(v) && v >= p.min && v <= p.max;
        }),
        { numRuns: 300 },
      );
    }
  });
  it('keeps decoded values in range even for out-of-range or odd numbers', () => {
    fc.assert(
      fc.property(fc.double({ noNaN: false }), fc.double({ noNaN: false }), (a, b) => {
        return PIDS.every((p) => {
          const v = p.decode(a, b);
          return Number.isFinite(v) && v >= p.min && v <= p.max;
        });
      }),
      { numRuns: 300 },
    );
  });
  it('rises with A for the single-byte linear PIDs', () => {
    for (const p of PIDS.filter((q) => q.bytes === 1)) {
      fc.assert(
        fc.property(byteArb, byteArb, (x, y) => {
          const [lo, hi] = x <= y ? [x, y] : [y, x];
          return p.decode(lo) <= p.decode(hi);
        }),
        { numRuns: 300 },
      );
    }
  });
  it('rises with A for the two-byte PIDs when B is fixed', () => {
    for (const p of PIDS.filter((q) => q.bytes === 2)) {
      fc.assert(
        fc.property(byteArb, byteArb, byteArb, (x, y, b) => {
          const [lo, hi] = x <= y ? [x, y] : [y, x];
          return p.decode(lo, b) <= p.decode(hi, b);
        }),
        { numRuns: 300 },
      );
    }
  });
  it('encodes then decodes to within one step of the value', () => {
    for (const p of PIDS) {
      fc.assert(
        fc.property(fc.double({ min: p.min, max: p.max, noNaN: true }), (v) => {
          const bytes = p.encode(v);
          const back = p.decode(bytes[0], bytes[1]);
          const step = p.bytes === 2 ? 0.25 : p.max - p.min > 200 ? 1 : 100 / 255;
          return Math.abs(back - v) <= step;
        }),
        { numRuns: 300 },
      );
    }
  });
  it('encodes to the right number of bytes, each 0 to 255, whatever the input', () => {
    fc.assert(
      fc.property(fc.double(), (v) =>
        PIDS.every((p) => {
          const bytes = p.encode(v);
          return bytes.length === p.bytes && bytes.every((b) => Number.isInteger(b) && b >= 0 && b <= 255);
        }),
      ),
      { numRuns: 300 },
    );
  });
});

describe('supported-PID bitmaps', () => {
  it('reads BE 1F A8 13 as the PIDs a typical car announces', () => {
    const pids = decodeSupported(0x00, [0xbe, 0x1f, 0xa8, 0x13]);
    expect(pids).toEqual([1, 3, 4, 5, 6, 7, 12, 13, 14, 15, 16, 17, 19, 21, 28, 31, 32]);
    expect(pids).toContain(0x0c);
    expect(pids).toContain(0x0d);
    expect(pids).toContain(0x20);
  });
  it('puts the top bit of the first byte at PID 01', () => expect(decodeSupported(0, [0x80, 0, 0, 0])).toEqual([1]));
  it('puts the bottom bit of the last byte at PID 20', () => expect(decodeSupported(0, [0, 0, 0, 1])).toEqual([0x20]));
  it('counts from the base: 0x20 page starts at PID 21', () => expect(decodeSupported(0x20, [0x80, 0, 0, 0])).toEqual([0x21]));
  it('returns nothing for an all-zero bitmap', () => expect(decodeSupported(0, [0, 0, 0, 0])).toEqual([]));
  it('copes with a short bitmap', () => expect(decodeSupported(0, [0xff])).toHaveLength(8));
  it('encodes then decodes any set of PIDs on the page', () => {
    fc.assert(
      fc.property(fc.uniqueArray(fc.integer({ min: 1, max: 32 }), { maxLength: 32 }), (ids) => {
        const back = decodeSupported(0, encodeSupported(0, ids));
        return JSON.stringify(back) === JSON.stringify([...ids].sort((a, b) => a - b));
      }),
      { numRuns: 300 },
    );
  });
  it('ignores PIDs that belong to another page when encoding', () => {
    expect(encodeSupported(0, [0x41, 0x0c])).toEqual(encodeSupported(0, [0x0c]));
  });
});
