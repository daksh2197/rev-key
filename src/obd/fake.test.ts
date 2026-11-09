import { describe, expect, it } from 'vitest';
import { makeDemoDrive } from '../core/demo';
import { ManualClock } from '../testing/clock';
import { isFailure, parseAll, parseResponse } from './elm';
import { driveSource, ElmEmulator, ScriptedTransport } from './fake';
import { decodeSupported } from './pids';

const emu = (o: Partial<ConstructorParameters<typeof ElmEmulator>[0]> = {}) =>
  new ElmEmulator({ valueFor: (ch) => ({ rpm: 1726, speed_kph: 60, coolant_c: 83 })[ch as 'rpm'] ?? null, ...o });

describe('the pretend adapter', () => {
  it('echoes the command until ATE0', () => {
    const e = emu();
    expect(e.reply('010C')).toContain('010C\r');
    e.reply('ATE0');
    expect(e.reply('010C')?.startsWith('41')).toBe(true);
  });
  it('answers RPM with the real bytes 1A F8 for 1726', () => {
    const e = emu({ echo: false });
    expect(parseResponse(e.reply('010C') ?? '', 0x0c)).toEqual({ pid: 0x0c, bytes: [0x1a, 0xf8] });
  });
  it('removes the spaces after ATS0', () => {
    const e = emu({ echo: false });
    e.reply('ATS0');
    expect(e.reply('010C')).toContain('410C1AF8');
  });
  it('keeps the spaces when asked to ignore ATS0', () => {
    const e = emu({ echo: false, ignoreSetup: true });
    e.reply('ATS0');
    expect(e.reply('010C')).toContain('41 0C 1A F8');
  });
  it('says SEARCHING... only for the first 0100', () => {
    const e = emu({ echo: false });
    expect(e.reply('0100')).toContain('SEARCHING...');
    expect(e.reply('0100')).not.toContain('SEARCHING...');
  });
  it('announces PID 0C and 0D in the 0100 bitmap', () => {
    const e = emu({ echo: false, supportedPids: [0x0c, 0x0d] });
    const r = parseAll(e.reply('0100') ?? '', 0)[0];
    expect(decodeSupported(0, r?.bytes ?? [])).toEqual([0x0c, 0x0d]);
  });
  it('announces the next page when a PID lives on it', () => {
    const e = emu({ echo: false, supportedPids: [0x0c, 0x2f] });
    const r = parseAll(e.reply('0100') ?? '', 0)[0];
    expect(decodeSupported(0, r?.bytes ?? [])).toContain(0x20);
  });
  it('says NO DATA for a value it does not have', () => {
    const r = parseResponse(emu({ echo: false }).reply('0111') ?? '', 0x11);
    expect(isFailure(r) && r.error).toBe('no-data');
  });
  it('says NO DATA for a PID it does not support', () => {
    const r = parseResponse(emu({ echo: false, supportedPids: [0x0c] }).reply('010D') ?? '', 0x0d);
    expect(isFailure(r) && r.error).toBe('no-data');
  });
  it('says ? for a command it does not know', () => {
    expect(emu({ echo: false }).reply('XYZ')).toContain('?');
  });
  it('ends every reply with the prompt', () => {
    expect(emu().reply('ATZ')?.endsWith('>')).toBe(true);
  });
  it('uses CRLF when asked', () => {
    expect(emu({ echo: false, eol: '\r\n' }).reply('ATL0')).toBe('OK\r\n\r\n>');
  });
  it('adds a second ECU line with different bytes', () => {
    const all = parseAll(emu({ echo: false, secondEcu: true }).reply('010C') ?? '', 0x0c);
    expect(all).toHaveLength(2);
    expect(all[0]?.bytes).not.toEqual(all[1]?.bytes);
  });
  it('resets echo and spaces on ATZ', () => {
    const e = emu();
    e.reply('ATE0');
    e.reply('ATZ');
    expect(e.reply('010C')).toContain('010C\r');
  });
});

describe('the scripted transport', () => {
  it('delivers a reply after the latency', () => {
    const clock = new ManualClock();
    const t = new ScriptedTransport(() => 'OK\r>', { clock, latencyMs: 20 });
    const got: string[] = [];
    t.onLine((c) => got.push(c));
    void t.send('ATZ');
    clock.advance(19);
    expect(got).toEqual([]);
    clock.advance(1);
    expect(got).toEqual(['OK\r>']);
  });
  it('cuts replies into chunks of the given size', () => {
    const clock = new ManualClock();
    const t = new ScriptedTransport(() => 'ABCDEFG', { clock, latencyMs: 1, chunkSize: 3 });
    const got: string[] = [];
    t.onLine((c) => got.push(c));
    void t.send('x');
    clock.advance(5);
    expect(got).toEqual(['ABC', 'DEF', 'G']);
  });
  it('stays silent when the script returns null', () => {
    const clock = new ManualClock();
    const t = new ScriptedTransport(() => null, { clock });
    const got: string[] = [];
    t.onLine((c) => got.push(c));
    void t.send('x');
    clock.advance(1000);
    expect(got).toEqual([]);
  });
  it('rejects sends after close', async () => {
    const t = new ScriptedTransport(() => null, { clock: new ManualClock() });
    t.close();
    await expect(t.send('x')).rejects.toThrow();
  });
  it('remembers what was sent', () => {
    const t = new ScriptedTransport(() => null, { clock: new ManualClock() });
    void t.send('ATZ');
    void t.send('0100');
    expect(t.sent).toEqual(['ATZ', '0100']);
  });
});

describe('playing a drive as a car', () => {
  const drive = makeDemoDrive(1);
  it('supports only the channels the drive recorded', () => {
    const partial = { ...drive, samples: drive.samples.map((s) => ({ t_s: s.t_s, rpm: s.rpm })) };
    const src = driveSource(partial, () => 1);
    expect(src.supportedPids).toEqual([0x0c]);
  });
  it('gives the drive\'s value at the time asked', () => {
    const src = driveSource(drive, () => 10);
    const sample = drive.samples.find((s) => s.t_s === 10);
    expect(src.valueFor('speed_kph')).toBeCloseTo(sample?.speed_kph ?? -1, 5);
  });
  it('gives null for a channel the drive never recorded', () => {
    const none = { ...drive, samples: drive.samples.map((s) => ({ t_s: s.t_s, rpm: s.rpm })) };
    expect(driveSource(none, () => 1).valueFor('volts')).toBeNull();
  });
  it('holds the last value past the end of the drive', () => {
    const src = driveSource(drive, () => 99999);
    expect(src.valueFor('rpm')).not.toBeNull();
  });
});
