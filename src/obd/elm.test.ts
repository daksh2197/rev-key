import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  describeError,
  Framer,
  isAllowedCommand,
  isFailure,
  parseAll,
  parseResponse,
  parseSetupReply,
  SETUP_COMMANDS,
  type ElmError,
} from './elm';

const rpm = { pid: 0x0c, bytes: [0x1a, 0xf8] };
const errorOf = (raw: string, pid?: number): ElmError | null => {
  const r = parseResponse(raw, pid);
  return isFailure(r) ? r.error : null;
};

describe('reading one answer', () => {
  it('reads a plain answer with spaces', () => expect(parseResponse('41 0C 1A F8')).toEqual(rpm));
  it('reads an answer with the spaces turned off', () => expect(parseResponse('410C1AF8')).toEqual(rpm));
  it('reads lower-case hex', () => expect(parseResponse('41 0c 1a f8')).toEqual(rpm));
  it('reads an answer that ends in CR', () => expect(parseResponse('41 0C 1A F8\r\r')).toEqual(rpm));
  it('reads an answer that ends in CRLF', () => expect(parseResponse('41 0C 1A F8\r\n\r\n')).toEqual(rpm));
  it('reads an answer with the command echoed first', () => expect(parseResponse('010C\r41 0C 1A F8\r\r')).toEqual(rpm));
  it('reads an answer with the echo and no spaces', () => expect(parseResponse('010C\r410C1AF8\r')).toEqual(rpm));
  it('reads an answer that follows SEARCHING...', () => {
    expect(parseResponse('SEARCHING...\r41 0C 1A F8\r\r')).toEqual(rpm);
  });
  it('reads an answer that follows a BUS INIT: OK line', () => {
    expect(parseResponse('SEARCHING...\rBUS INIT: OK\r41 0C 1A F8')).toEqual(rpm);
  });
  it('reads a one-byte answer', () => expect(parseResponse('41 0D 3C')).toEqual({ pid: 0x0d, bytes: [0x3c] }));
  it('ignores extra bytes after the ones needed', () => {
    expect(parseResponse('41 0D 3C FF FF')).toEqual({ pid: 0x0d, bytes: [0x3c] });
  });
  it('ignores garbage bytes mixed into the text', () => {
    expect(parseResponse('\u0000ÿ41 0C 1A F8\u0007\r')).toEqual(rpm);
  });
  it('ignores a stray prompt character inside the text', () => expect(parseResponse('41 0C 1A F8\r>')).toEqual(rpm));
  it('reads an answer with extra spaces and tabs around it', () => {
    expect(parseResponse('   41   0C   1A   F8   ')).toEqual({ pid: 0x0c, bytes: [0x1a, 0xf8] });
  });
});

describe('the adapter says no', () => {
  it('names NO DATA', () => expect(errorOf('NO DATA\r\r')).toBe('no-data'));
  it('names NO DATA after SEARCHING...', () => expect(errorOf('SEARCHING...\rNO DATA\r')).toBe('no-data'));
  it('names the question mark', () => expect(errorOf('?\r\r')).toBe('unknown-command'));
  it('names UNABLE TO CONNECT', () => expect(errorOf('SEARCHING...\rUNABLE TO CONNECT\r')).toBe('unable-to-connect'));
  it('names a BUS INIT error', () => expect(errorOf('BUS INIT: ...ERROR\r')).toBe('bus-init'));
  it('does not call BUS INIT: OK an error by itself', () => expect(errorOf('BUS INIT: OK\r')).toBe('garbage'));
  it('names STOPPED', () => expect(errorOf('STOPPED\r')).toBe('stopped'));
  it('names CAN ERROR', () => expect(errorOf('CAN ERROR\r')).toBe('can-error'));
  it('names other adapter errors', () => {
    expect(errorOf('BUFFER FULL\r')).toBe('adapter-error');
    expect(errorOf('DATA ERROR\r')).toBe('adapter-error');
    expect(errorOf('BUS BUSY\r')).toBe('adapter-error');
  });
  it('says empty for nothing at all', () => expect(errorOf('')).toBe('empty'));
  it('says empty for only SEARCHING...', () => expect(errorOf('SEARCHING...\r')).toBe('empty'));
  it('says empty for only whitespace', () => expect(errorOf(' \r\n \r')).toBe('empty'));
  it('says garbage for text it does not know', () => expect(errorOf('HELLO THERE')).toBe('garbage'));
  it('says garbage for random hex that is not an answer', () => expect(errorOf('DEAD BEEF')).toBe('garbage'));
  it('lets a good answer win over an error line in the same text', () => {
    expect(parseResponse('NO DATA\r41 0C 1A F8')).toEqual(rpm);
  });
  it('gives every error a plain sentence', () => {
    const all: ElmError[] = ['no-data', 'unable-to-connect', 'bus-init', 'can-error', 'stopped', 'unknown-command', 'adapter-error', 'wrong-pid', 'truncated', 'garbage', 'empty'];
    for (const e of all) expect(describeError(e).length).toBeGreaterThan(10);
  });
});

describe('answers that are wrong or cut short', () => {
  it('rejects an answer for a different PID when one was asked for', () => {
    expect(errorOf('41 0D 3C', 0x0c)).toBe('wrong-pid');
  });
  it('accepts the answer for the asked PID among others', () => {
    expect(parseResponse('41 0D 3C\r41 0C 1A F8', 0x0c)).toEqual(rpm);
  });
  it('calls a two-byte answer with one byte truncated', () => expect(errorOf('41 0C 1A', 0x0c)).toBe('truncated'));
  it('calls an answer cut in the middle of a byte truncated', () => expect(errorOf('41 0C 1A F', 0x0c)).toBe('truncated'));
  it('calls an answer with no data at all truncated', () => expect(errorOf('41 0C', 0x0c)).toBe('truncated'));
  it('calls a bitmap with three bytes truncated', () => expect(errorOf('41 00 BE 3F A8', 0x00)).toBe('truncated'));
  it('does not read a half-written header as an answer', () => expect(errorOf('4')).toBe('garbage'));
  it('reads an answer for any PID when no PID was asked for', () => {
    expect(parseResponse('41 0D 3C')).toEqual({ pid: 0x0d, bytes: [0x3c] });
  });
});

describe('several ECUs answering', () => {
  it('takes the first line for the asked PID', () => {
    expect(parseResponse('41 0C 1A F8\r41 0C 00 00', 0x0c)).toEqual(rpm);
  });
  it('skips an earlier line from another PID', () => {
    expect(parseResponse('41 05 7B\r41 0C 1A F8', 0x0c)).toEqual(rpm);
  });
  it('lists both answers with parseAll', () => {
    expect(parseAll('41 00 BE 3F A8 13\r41 00 98 18 00 01', 0x00)).toHaveLength(2);
  });
  it('lists nothing for text with no answers', () => expect(parseAll('NO DATA')).toEqual([]));
  it('reads two ECUs answering with the spaces off', () => {
    expect(parseAll('410C1AF8\r410C0000', 0x0c)).toHaveLength(2);
  });
});

describe('multi-frame answers to 0100', () => {
  it('joins numbered lines into one answer', () => {
    const raw = '00A\r0: 41 00 BE 3F\r1: A8 13 00 00 00\r';
    expect(parseResponse(raw, 0x00)).toEqual({ pid: 0, bytes: [0xbe, 0x3f, 0xa8, 0x13] });
  });
  it('joins numbered lines with the spaces off', () => {
    const raw = '008\r0:4100BE3F\r1:A813\r';
    expect(parseResponse(raw, 0x00)).toEqual({ pid: 0, bytes: [0xbe, 0x3f, 0xa8, 0x13] });
  });
  it('reads a multi-frame answer that follows SEARCHING...', () => {
    const raw = 'SEARCHING...\r00A\r0: 41 00 BE 3F\r1: A8 13 00 00 00';
    expect(isFailure(parseResponse(raw, 0x00))).toBe(false);
  });
  it('reads one ECU in multi-frame and another in a single frame', () => {
    const raw = '00A\r0: 41 00 BE 3F\r1: A8 13 00 00 00\r41 00 98 18 00 01';
    expect(parseAll(raw, 0x00)).toHaveLength(2);
  });
  it('does not mistake a three-digit length line for an answer', () => {
    expect(errorOf('00A\r', 0x00)).toBe('garbage');
  });
});

describe('setup replies', () => {
  it('accepts OK', () => expect(parseSetupReply('OK\r', 'ATE0').ok).toBe(true));
  it('accepts OK after the echoed command', () => expect(parseSetupReply('ATE0\rOK\r', 'ATE0').ok).toBe(true));
  it('accepts the version banner after ATZ', () => expect(parseSetupReply('ATZ\r\rELM327 v1.5\r', 'ATZ').ok).toBe(true));
  it('rejects a question mark', () => expect(parseSetupReply('?\r', 'ATS0').ok).toBe(false));
  it('rejects silence', () => expect(parseSetupReply('', 'ATS0').ok).toBe(false));
  it('rejects only the echo', () => expect(parseSetupReply('ATS0\r', 'ATS0').ok).toBe(false));
});

describe('the read-only rule', () => {
  it('allows each of the six setup commands', () => {
    for (const c of SETUP_COMMANDS) expect(isAllowedCommand(c)).toBe(true);
    expect(SETUP_COMMANDS).toHaveLength(6);
  });
  it('allows mode 01 requests', () => {
    for (const c of ['0100', '0120', '0140', '010C', '010d', '01 0C', '0105']) expect(isAllowedCommand(c)).toBe(true);
  });
  it('refuses clearing codes (mode 04)', () => expect(isAllowedCommand('04')).toBe(false));
  it('refuses reading codes and every other mode', () => {
    for (const c of ['03', '0300', '0200', '0400', '0500', '0600', '0700', '0800', '0900', '0A00', '2200', '2F00', '3B00']) {
      expect(isAllowedCommand(c)).toBe(false);
    }
  });
  it('refuses AT commands that are not setup commands', () => {
    for (const c of ['ATD', 'ATWS', 'ATPP FF SV 00', 'ATSH7E0', 'ATE1', 'ATSP6', 'ATI', 'ATRV', 'ATCAF0', 'ATFI', 'ATSW00']) {
      expect(isAllowedCommand(c)).toBe(false);
    }
  });
  it('refuses a good command with anything extra', () => {
    for (const c of ['010C1', '010C\r0400', '010C;04', 'ATZ ATZ', '0100\n', ' ATE0x', '']) expect(isAllowedCommand(c)).toBe(false);
  });
  it('refuses values that are not strings', () => {
    expect(isAllowedCommand(undefined as unknown as string)).toBe(false);
    expect(isAllowedCommand(null as unknown as string)).toBe(false);
    expect(isAllowedCommand(1 as unknown as string)).toBe(false);
  });
  it('allows lower-case setup commands', () => expect(isAllowedCommand('atz')).toBe(true));
  it('allows only mode 01 among all possible four-hex-digit commands', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 0xffff }), (n) => {
        const cmd = n.toString(16).padStart(4, '0');
        return isAllowedCommand(cmd) === cmd.startsWith('01');
      }),
      { numRuns: 300 },
    );
  });
  it('never allows a command that contains a control character', () => {
    fc.assert(
      fc.property(fc.string(), fc.constantFrom('\r', '\n', '\0', '\t'), fc.string(), (a, c, b) => !isAllowedCommand(a + c + b)),
      { numRuns: 300 },
    );
  });
});

describe('cutting the stream into answers', () => {
  it('returns one block at each prompt', () => {
    const f = new Framer();
    expect(f.push('41 0C 1A F8\r\r>')).toEqual(['41 0C 1A F8\r\r']);
  });
  it('waits for the prompt before returning anything', () => {
    const f = new Framer();
    expect(f.push('41 0C 1A')).toEqual([]);
    expect(f.push(' F8\r\r>')).toEqual(['41 0C 1A F8\r\r']);
  });
  it('handles a chunk that ends inside a byte', () => {
    const f = new Framer();
    f.push('41 0');
    expect(f.push('C 1A F8\r>')).toEqual(['41 0C 1A F8\r']);
  });
  it('returns two answers from one chunk', () => {
    expect(new Framer().push('OK\r>OK\r>')).toEqual(['OK\r', 'OK\r']);
  });
  it('drops blank answers (a prompt with nothing before it)', () => {
    expect(new Framer().push('>\r>')).toEqual([]);
  });
  it('keeps the text after the last prompt for next time', () => {
    const f = new Framer();
    expect(f.push('A\r>B')).toEqual(['A\r']);
    expect(f.push('C\r>')).toEqual(['BC\r']);
  });
  it('forgets partial text on reset', () => {
    const f = new Framer();
    f.push('half an ans');
    f.reset();
    expect(f.push('OK\r>')).toEqual(['OK\r']);
  });
  it('does not grow without limit when no prompt ever comes', () => {
    const f = new Framer();
    for (let i = 0; i < 100; i++) f.push('x'.repeat(1000));
    expect(f.push('\r>')[0]?.length).toBeLessThanOrEqual(4097);
  });
  it('gives the same answers however the stream is cut into chunks', () => {
    const stream = 'SEARCHING...\r41 00 BE 3F A8 13\r\r>41 0C 1A F8\r\r>NO DATA\r\r>';
    const whole = new Framer().push(stream);
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 1, max: 9 }), { minLength: 1, maxLength: 30 }), (sizes) => {
        const f = new Framer();
        const out: string[] = [];
        let at = 0;
        let i = 0;
        while (at < stream.length) {
          const n = sizes[i++ % sizes.length] ?? 1;
          out.push(...f.push(stream.slice(at, at + n)));
          at += n;
        }
        return JSON.stringify(out) === JSON.stringify(whole);
      }),
      { numRuns: 300 },
    );
  });
});

describe('hostile input', () => {
  it('turns any string into an answer or an error, never a throw', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), fc.option(fc.integer({ min: 0, max: 255 }), { nil: undefined }), (s, pid) => {
        const r = parseResponse(s, pid);
        return isFailure(r) ? typeof r.error === 'string' : Number.isInteger(r.pid) && r.bytes.every((b) => b >= 0 && b <= 255);
      }),
      { numRuns: 300 },
    );
  });
  it('survives strings made of the adapter\'s own vocabulary shuffled together', () => {
    const words = ['41', '0C', '1A', 'F8', 'NO DATA', '?', 'SEARCHING...', '>', '\r', '\n', 'STOPPED', 'CAN ERROR', '0:', '1:', '00A', ' '];
    fc.assert(
      fc.property(fc.array(fc.constantFrom(...words), { maxLength: 30 }), (parts) => {
        const r = parseResponse(parts.join(' '), 0x0c);
        const r2 = parseResponse(parts.join(''), undefined);
        return (isFailure(r) || r.bytes.length >= 2) && (isFailure(r2) || r2.bytes.length >= 1);
      }),
      { numRuns: 300 },
    );
  });
  it('survives random bytes turned into text', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 300 }), (bytes) => {
        const text = String.fromCharCode(...bytes);
        const r = parseResponse(text);
        const f = new Framer();
        f.push(text);
        return typeof r === 'object';
      }),
      { numRuns: 300 },
    );
  });
  it('survives values that are not strings', () => {
    expect(() => parseResponse(undefined as unknown as string)).not.toThrow();
    expect(() => parseResponse(null as unknown as string)).not.toThrow();
    expect(() => parseResponse(42 as unknown as string)).not.toThrow();
    expect(() => new Framer().push(undefined as unknown as string)).not.toThrow();
  });
  it('never returns a NaN in any byte', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 120 }), (s) => {
        return parseAll(s).every((r) => r.bytes.every((b) => Number.isFinite(b)));
      }),
      { numRuns: 300 },
    );
  });
  it('reads a long run of repeated answers without trouble', () => {
    expect(parseAll('41 0C 1A F8\r'.repeat(500), 0x0c)).toHaveLength(500);
  });
});
