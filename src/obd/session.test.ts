import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { Sample } from '../core/log';
import { ManualClock, runUntilSettled } from '../testing/clock';
import { ElmEmulator, emulatedTransport, ScriptedTransport, type EmulatorOptions } from './fake';
import { isAllowedCommand } from './elm';
import { PIDS, requestFor } from './pids';
import { Session, type SessionStatus } from './session';

const VALUES: Record<string, number> = {
  rpm: 2500,
  speed_kph: 60,
  coolant_c: 88,
  intake_c: 30,
  throttle_pct: 20,
  load_pct: 40,
  map_kpa: 60,
  baro_kpa: 100,
  volts: 13.9,
  fuel_pct: 55,
};

const car = (extra: Partial<EmulatorOptions> = {}): EmulatorOptions => ({
  valueFor: (ch) => VALUES[ch] ?? null,
  ...extra,
});

interface Run {
  clock: ManualClock;
  transport: ScriptedTransport;
  session: Session;
  samples: Sample[];
  statuses: SessionStatus[];
}

function setup(transportFor: (clock: ManualClock) => ScriptedTransport, opts: ConstructorParameters<typeof Session>[1] = {}): Run {
  const clock = new ManualClock();
  const transport = transportFor(clock);
  const samples: Sample[] = [];
  const statuses: SessionStatus[] = [];
  const session = new Session(transport, {
    clock,
    onSample: (s) => samples.push(s),
    onStatus: (s) => statuses.push(s),
    ...opts,
  });
  return { clock, transport, session, samples, statuses };
}

const emulated = (emu: EmulatorOptions) => (clock: ManualClock) => emulatedTransport(emu, { clock, latencyMs: 5 });

/** Run the session for `ms` of fake time, then stop it and return its final status. */
async function runFor(run: Run, ms: number): Promise<SessionStatus> {
  const done = run.session.start();
  let elapsed = 0;
  await runUntilSettled(run.clock, new Promise<void>((resolve) => {
    void done.then(() => resolve());
    const tick = (): void => {
      if (elapsed >= ms) {
        run.session.stop();
        return;
      }
      elapsed += 10;
      run.clock.after(10, tick);
    };
    tick();
  }), ms + 60_000);
  return run.session.current;
}

describe('the setup conversation', () => {
  it('sends the setup commands in order, then asks what the car supports', async () => {
    const run = setup(emulated(car()));
    await runFor(run, 500);
    expect(run.transport.sent.slice(0, 7)).toEqual(['ATZ', 'ATE0', 'ATL0', 'ATS0', 'ATH0', 'ATSP0', '0100']);
  });
  it('asks 0120 only after 0100 announced it', async () => {
    const run = setup(emulated(car()));
    await runFor(run, 500);
    expect(run.transport.sent.indexOf('0120')).toBeGreaterThan(run.transport.sent.indexOf('0100'));
    expect(run.transport.sent).toContain('0140');
  });
  it('does not ask 0120 or 0140 when the car supports only the first page', async () => {
    const run = setup(emulated(car({ supportedPids: [0x0c, 0x0d, 0x05] })));
    await runFor(run, 500);
    expect(run.transport.sent).not.toContain('0120');
    expect(run.transport.sent).not.toContain('0140');
  });
  it('reports the supported PIDs in its status', async () => {
    const run = setup(emulated(car({ supportedPids: [0x0c, 0x0d, 0x05] })));
    await runFor(run, 500);
    const polling = run.statuses.find((s) => s.state === 'polling');
    expect(polling?.supported).toEqual(expect.arrayContaining([0x0c, 0x0d, 0x05]));
  });
  it('goes through initialising, polling and stopped', async () => {
    const run = setup(emulated(car()));
    await runFor(run, 500);
    expect(run.statuses.map((s) => s.state)).toEqual(['initialising', 'polling', 'stopped']);
  });
  it('combines the bitmaps of two ECUs', async () => {
    const raw = (cmd: string): string | null => {
      if (cmd === '0100') return '41 00 08 18 00 00\r41 00 00 00 00 01\r\r>'; // 0C and 0D+... from one, 0x20 from the other
      if (cmd === '0120') return 'NO DATA\r\r>';
      if (cmd === '010C') return '41 0C 1A F8\r\r>';
      return 'OK\r\r>';
    };
    const run = setup((clock) => new ScriptedTransport(raw, { clock, latencyMs: 5 }));
    await runFor(run, 300);
    expect(run.statuses.find((s) => s.state === 'polling')?.supported).toEqual(expect.arrayContaining([0x05, 0x0c, 0x0d, 0x20]));
  });
});

describe('polling', () => {
  it('asks only for PIDs the car announced', async () => {
    const run = setup(emulated(car({ supportedPids: [0x0c, 0x0d] })));
    await runFor(run, 1000);
    const asked = new Set(run.transport.sent.filter((c) => c.startsWith('01')).map((c) => c));
    expect([...asked].sort()).toEqual(['0100', '010C', '010D']);
  });
  it('never asks for an unsupported PID, whatever the car supports', () => {
    return fc.assert(
      fc.asyncProperty(fc.uniqueArray(fc.constantFrom(...PIDS.map((p) => p.id)), { minLength: 1 }), async (ids) => {
        const run = setup(emulated(car({ supportedPids: ids })));
        await runFor(run, 400);
        const allowed = new Set([...ids.map(requestFor), '0100', '0120', '0140']);
        return run.transport.sent.every((c) => c.startsWith('AT') || allowed.has(c));
      }),
      { numRuns: 40 },
    );
  }, 30_000);
  it('emits samples with the decoded values', async () => {
    const run = setup(emulated(car()));
    await runFor(run, 1000);
    const first = run.samples[0];
    expect(first?.rpm).toBe(2500);
    expect(first?.speed_kph).toBe(60);
    expect(first?.coolant_c).toBe(88);
    expect(first?.volts).toBe(13.9);
  });
  it('asks the fast PIDs every cycle and the slow ones every tenth', async () => {
    const run = setup(emulated(car()));
    await runFor(run, 5000);
    const count = (cmd: string) => run.transport.sent.filter((c) => c === cmd).length;
    expect(count('010C')).toBeGreaterThan(count('0105') * 5);
    expect(count('0105')).toBeGreaterThanOrEqual(1);
    const withCoolant = run.samples.filter((s) => s.coolant_c !== undefined).length;
    expect(withCoolant).toBeLessThan(run.samples.length);
  });
  it('puts the slow values in the very first sample', async () => {
    const run = setup(emulated(car()));
    await runFor(run, 1000);
    expect(run.samples[0]?.fuel_pct).toBeDefined();
  });
  it('stamps samples with rising seconds from the start', async () => {
    const run = setup(emulated(car()));
    await runFor(run, 2000);
    const times = run.samples.map((s) => s.t_s);
    expect(times.length).toBeGreaterThan(3);
    expect(times.every((t, i) => i === 0 || t > (times[i - 1] ?? 0))).toBe(true);
  });
  it('leaves a channel out of a sample when the car says NO DATA for it', async () => {
    const run = setup(emulated(car({ valueFor: (ch) => (ch === 'rpm' ? null : (VALUES[ch] ?? null)) })));
    await runFor(run, 1000);
    expect(run.samples.length).toBeGreaterThan(0);
    expect(run.samples.every((s) => s.rpm === undefined)).toBe(true);
    expect(run.samples[0]?.speed_kph).toBe(60);
  });
  it('keeps going while the car answers NO DATA to everything (ignition off)', async () => {
    const run = setup(emulated(car({ valueFor: () => null })));
    const status = await runFor(run, 3000);
    expect(status.reason).toBe('user-stopped');
    expect(run.samples).toEqual([]);
  });
  it('works with echo off, LF line endings and no spaces from the start', async () => {
    const run = setup(emulated(car({ echo: false, spaces: false, eol: '\r\n' })));
    await runFor(run, 500);
    expect(run.samples[0]?.rpm).toBe(2500);
  });
  it('works with an adapter that ignores ATE0 and ATS0', async () => {
    const run = setup(emulated(car({ echo: true, spaces: true, ignoreSetup: true })));
    await runFor(run, 500);
    expect(run.samples[0]?.rpm).toBe(2500);
  });
  it('works when the adapter answers in pieces cut mid-byte', async () => {
    const run = setup((clock) => emulatedTransport(car(), { clock, latencyMs: 5, chunkSize: 3 }));
    await runFor(run, 500);
    expect(run.samples[0]?.rpm).toBe(2500);
  });
  it('takes the first ECU when a second one disagrees', async () => {
    const run = setup(emulated(car({ secondEcu: true })));
    await runFor(run, 500);
    expect(run.samples[0]?.rpm).toBe(2500);
    expect(run.samples[0]?.speed_kph).toBe(60);
  });
  it('survives the adapter saying SEARCHING... before the first answer', async () => {
    const run = setup(emulated(car({ searching: true })));
    await runFor(run, 500);
    expect(run.samples.length).toBeGreaterThan(0);
  });
});

describe('the session never hangs', () => {
  it('ends with no-answer when the adapter never answers at all', async () => {
    const run = setup((clock) => new ScriptedTransport(() => null, { clock }));
    const result = await runUntilSettled(run.clock, run.session.start());
    expect(result.settled).toBe(true);
    expect(result.value?.state).toBe('failed');
    expect(result.value?.reason).toBe('no-answer');
  });
  it('ends with a status when the adapter stops answering mid-drive', async () => {
    let asked = 0;
    const run = setup((clock) => {
      const emu = new ElmEmulator(car());
      return new ScriptedTransport((cmd) => (++asked > 40 ? null : emu.reply(cmd)), { clock, latencyMs: 5 });
    });
    const result = await runUntilSettled(run.clock, run.session.start());
    expect(result.settled).toBe(true);
    expect(result.value?.reason).toBe('no-answer');
    expect(run.samples.length).toBeGreaterThan(0);
  });
  it('gives up after the set number of silent requests in a row', async () => {
    let calls = 0;
    const run = setup(
      (clock) =>
        new ScriptedTransport(
          (cmd) => {
            if (cmd.startsWith('AT')) return 'OK\r\r>';
            if (cmd === '0100') return '41 00 08 18 00 00\r\r>';
            calls++;
            return null;
          },
          { clock },
        ),
      { maxMisses: 3 },
    );
    const result = await runUntilSettled(run.clock, run.session.start());
    expect(result.settled).toBe(true);
    expect(calls).toBe(3);
  });
  it('ends when the adapter says UNABLE TO CONNECT to 0100', async () => {
    const run = setup((clock) => new ScriptedTransport((cmd) => (cmd.startsWith('AT') ? 'OK\r\r>' : 'SEARCHING...\rUNABLE TO CONNECT\r\r>'), { clock }));
    const result = await runUntilSettled(run.clock, run.session.start());
    expect(result.value?.reason).toBe('unable-to-connect');
  });
  it('ends with no-data when the car never answers 0100', async () => {
    const run = setup((clock) => new ScriptedTransport((cmd) => (cmd.startsWith('AT') ? 'OK\r\r>' : 'NO DATA\r\r>'), { clock }));
    const result = await runUntilSettled(run.clock, run.session.start());
    expect(result.value?.state).toBe('failed');
    expect(result.value?.reason).toBe('no-data');
  });
  it('ends with no-pids when the car supports nothing this app can read', async () => {
    const run = setup((clock) => new ScriptedTransport((cmd) => (cmd.startsWith('AT') ? 'OK\r\r>' : '41 00 00 00 00 00\r\r>'), { clock }));
    const result = await runUntilSettled(run.clock, run.session.start());
    expect(result.value?.reason).toBe('no-pids');
  });
  it('ends as failed with no-answer after repeated CAN errors while polling', async () => {
    const run = setup((clock) => {
      const emu = new ElmEmulator(car());
      let polls = 0;
      return new ScriptedTransport(
        (cmd) => {
          const isPoll = cmd.startsWith('01') && !['0100', '0120', '0140'].includes(cmd);
          return isPoll && ++polls > 8 ? 'CAN ERROR\r\r>' : emu.reply(cmd);
        },
        { clock, latencyMs: 5 },
      );
    });
    const result = await runUntilSettled(run.clock, run.session.start());
    expect(result.settled).toBe(true);
    expect(result.value?.state).toBe('failed');
    expect(result.value?.reason).toBe('no-answer');
  });
  it('ends when the link closes by itself', async () => {
    const run = setup(emulated(car()));
    const done = run.session.start();
    for (let i = 0; i < 30; i++) {
      await runUntilSettled(run.clock, Promise.resolve(), 10);
    }
    run.transport.drop();
    const result = await runUntilSettled(run.clock, done);
    expect(result.settled).toBe(true);
    expect(result.value?.reason).toBe('link-closed');
  });
  it('ends with stopped when asked to stop', async () => {
    const run = setup(emulated(car()));
    const status = await runFor(run, 300);
    expect(status.state).toBe('stopped');
    expect(status.reason).toBe('user-stopped');
  });
  it('stops asking the adapter once stopped', async () => {
    const run = setup(emulated(car()));
    await runFor(run, 300);
    const before = run.transport.sent.length;
    run.clock.advance(5000);
    expect(run.transport.sent.length).toBe(before);
  });
  it('can be stopped twice without trouble', async () => {
    const run = setup(emulated(car()));
    await runFor(run, 100);
    expect(() => run.session.stop()).not.toThrow();
  });
  it('ignores an answer that arrives after its request timed out', async () => {
    const run = setup(emulated(car()));
    const done = run.session.start();
    await runUntilSettled(run.clock, Promise.resolve(), 200);
    run.transport.say('41 0C 00 00\r\r>');
    await runUntilSettled(run.clock, Promise.resolve(), 500);
    run.session.stop();
    await runUntilSettled(run.clock, done);
    expect(run.samples.every((s) => s.rpm === undefined || s.rpm === 2500)).toBe(true);
  });
  it('treats a send that fails as no answer', async () => {
    const run = setup((clock) => {
      const t = new ScriptedTransport(() => null, { clock });
      t.send = () => Promise.reject(new Error('write failed'));
      return t;
    });
    const result = await runUntilSettled(run.clock, run.session.start());
    expect(result.value?.reason).toBe('no-answer');
  });
});

describe('hostile adapters', () => {
  it('never throws and always ends, whatever text the adapter sends', () => {
    return fc.assert(
      fc.asyncProperty(fc.array(fc.string({ maxLength: 60 }), { minLength: 1, maxLength: 8 }), fc.integer({ min: 0, max: 7 }), async (replies, k) => {
        let i = 0;
        const run = setup(
          (clock) =>
            new ScriptedTransport(
              () => {
                const r = replies[i++ % replies.length] ?? '';
                return i % (k + 2) === 0 ? null : r + '\r>';
              },
              { clock, latencyMs: 3 },
            ),
          { maxMisses: 3 },
        );
        const result = await runUntilSettled(run.clock, (async () => {
          const p = run.session.start();
          // Garbage may keep a session alive for a while; stop it after a minute of fake time.
          run.clock.after(60_000, () => run.session.stop());
          return p;
        })());
        return result.settled && run.samples.every((s) => Object.values(s).every((v) => Number.isFinite(v)));
      }),
      { numRuns: 60 },
    );
  }, 30_000);
  it('never produces a NaN or out-of-range value from random answers to polls', () => {
    return fc.assert(
      fc.asyncProperty(fc.array(fc.array(fc.integer({ min: 0, max: 255 }), { maxLength: 6 }), { minLength: 1, maxLength: 6 }), async (byteLists) => {
        let i = 0;
        const run = setup(
          (clock) =>
            new ScriptedTransport(
              (cmd) => {
                if (cmd.startsWith('AT')) return 'OK\r>';
                if (cmd === '0100') return '41 00 08 18 00 00\r>';
                const bytes = byteLists[i++ % byteLists.length] ?? [];
                return ['41', cmd.slice(2), ...bytes.map((b) => b.toString(16).padStart(2, '0'))].join(' ') + '\r>';
              },
              { clock, latencyMs: 3 },
            ),
          { maxMisses: 50 },
        );
        const done = run.session.start();
        run.clock.after(3000, () => run.session.stop());
        await runUntilSettled(run.clock, done);
        return run.samples.every((s) => PIDS.every((p) => s[p.channel] === undefined || (s[p.channel] as number) >= p.min && (s[p.channel] as number) <= p.max));
      }),
      { numRuns: 60 },
    );
  }, 30_000);
});

describe('the read-only rule in the session', () => {
  it('only ever sends setup commands and mode 01 requests', async () => {
    const run = setup(emulated(car()));
    await runFor(run, 3000);
    expect(run.transport.sent.length).toBeGreaterThan(20);
    expect(run.transport.sent.every((c) => isAllowedCommand(c))).toBe(true);
    expect(run.session.sent).toEqual(run.transport.sent);
  });
  it('only ever sends setup commands and mode 01 requests, even against a hostile adapter', async () => {
    const run = setup((clock) => new ScriptedTransport(() => '04\r03\r>', { clock }));
    await runUntilSettled(run.clock, run.session.start());
    expect(run.transport.sent.every((c) => isAllowedCommand(c))).toBe(true);
  });
});
