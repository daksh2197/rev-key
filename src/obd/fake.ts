/**
 * A pretend ELM327, for the tests and for demo mode.
 *
 * `ElmEmulator` answers commands the way a real adapter does: it echoes (until told not to),
 * prints "SEARCHING..." before the first answer to 0100, puts spaces between bytes (until told
 * not to), answers PIDs with real "41 0C xx xx" bytes made with the PID formulas run
 * backwards, and says "NO DATA" for anything it has no value for.
 *
 * `ScriptedTransport` carries those answers (or any hand-written ones) to a Session with a
 * delay and an optional chunk size, so a test can cut an answer in the middle of a byte.
 */

import { type Channel, type Drive, holdValue, seriesOf, valueAt, CHANNELS } from '../core/log';
import { encodeSupported, hex2, PIDS, pidById, BITMAP_PIDS } from './pids';
import type { Clock, Transport } from './session';

export interface EmulatorOptions {
  /** The current value of a channel, or null when the car has nothing to say. */
  valueFor(channel: Channel): number | null;
  /** PIDs the pretend car supports. Defaults to every PID this app knows. */
  supportedPids?: number[];
  /** Echo the command back (real adapters start with this on). Default true. */
  echo?: boolean;
  /** Put a space between bytes. Default true. */
  spaces?: boolean;
  /** Line ending in answers. Default CR; "\r\n" is what some clones send. */
  eol?: '\r' | '\r\n';
  /** Print "SEARCHING..." before the first 0100 answer. Default true. */
  searching?: boolean;
  /** Pretend the adapter ignores ATE0 / ATS0, like some cheap clones. Default false. */
  ignoreSetup?: boolean;
  /** A second ECU that also answers every PID, with different bytes, after the engine ECU. */
  secondEcu?: boolean;
}

export class ElmEmulator {
  private echo: boolean;
  private spaces: boolean;
  private searched = false;
  private readonly supported: Set<number>;
  private readonly eol: string;

  constructor(private readonly options: EmulatorOptions) {
    this.echo = options.echo ?? true;
    this.spaces = options.spaces ?? true;
    this.eol = options.eol ?? '\r';
    this.supported = new Set(options.supportedPids ?? PIDS.map((p) => p.id));
  }

  /** The full text the adapter would send for this command, prompt included. Null means silence. */
  reply(cmd: string): string | null {
    const c = cmd.toUpperCase().replace(/ /g, '');
    const lines: string[] = [];
    const eol = this.eol;
    const wasEcho = this.echo;
    let body: string[];

    if (c === 'ATZ') {
      this.echo = this.options.echo ?? true;
      this.spaces = this.options.spaces ?? true;
      this.searched = false;
      body = ['', 'ELM327 v1.5'];
    } else if (c === 'ATE0') {
      if (!this.options.ignoreSetup) this.echo = false;
      body = ['OK'];
    } else if (c === 'ATS0') {
      if (!this.options.ignoreSetup) this.spaces = false;
      body = ['OK'];
    } else if (c === 'ATL0' || c === 'ATH0' || c === 'ATSP0') {
      body = ['OK'];
    } else if (/^01[0-9A-F]{2}$/.test(c)) {
      body = this.mode01(parseInt(c.slice(2), 16));
    } else {
      body = ['?'];
    }

    if (wasEcho) lines.push(cmd);
    lines.push(...body);
    return lines.join(eol) + eol + eol + '>';
  }

  private bytesText(bytes: number[]): string {
    return bytes.map(hex2).join(this.spaces ? ' ' : '');
  }

  private mode01(pid: number): string[] {
    const out: string[] = [];
    const isBitmap = (BITMAP_PIDS as readonly number[]).includes(pid);
    if (isBitmap && pid === 0x00 && this.options.searching !== false && !this.searched) {
      out.push('SEARCHING...');
    }
    if (isBitmap) {
      if (pid === 0x00) this.searched = true;
      const bytes = encodeSupported(pid, this.announced(pid));
      out.push(this.answer(pid, bytes));
      if (this.options.secondEcu) out.push(this.answer(pid, encodeSupported(pid, [])));
      return out;
    }
    const known = pidById(pid);
    const value = known && this.supported.has(pid) ? this.options.valueFor(known.channel) : null;
    if (!known || value === null) {
      out.push('NO DATA');
      return out;
    }
    const bytes = known.encode(value);
    out.push(this.answer(pid, bytes));
    if (this.options.secondEcu) out.push(this.answer(pid, bytes.map((b) => b ^ 1)));
    return out;
  }

  /** What the bitmap for `base` announces: PIDs in its page, plus the "next page exists" bit. */
  private announced(base: number): number[] {
    const out = [...this.supported].filter((p) => p > base && p <= base + 32);
    if ([...this.supported].some((p) => p > base + 32)) out.push(base + 32);
    return out;
  }

  private answer(pid: number, bytes: number[]): string {
    return this.bytesText([0x41, pid, ...bytes]);
  }
}

export interface ScriptedOptions {
  clock: Clock;
  /** How long the pretend adapter takes to answer. */
  latencyMs?: number;
  /** Deliver the answer in pieces of this many characters (to test framing across chunks). */
  chunkSize?: number;
}

/** A transport that answers from a function. Whatever it returns is delivered as the adapter's text. */
export class ScriptedTransport implements Transport {
  readonly sent: string[] = [];
  private listener: ((chunk: string) => void) | null = null;
  private closeListener: (() => void) | null = null;
  private closed = false;

  constructor(
    private readonly respond: (cmd: string) => string | null,
    private readonly options: ScriptedOptions,
  ) {}

  send(line: string): Promise<void> {
    if (this.closed) return Promise.reject(new Error('closed'));
    this.sent.push(line);
    const text = this.respond(line);
    if (text !== null) {
      this.options.clock.after(this.options.latencyMs ?? 5, () => this.deliver(text));
    }
    return Promise.resolve();
  }

  onLine(listener: (chunk: string) => void): void {
    this.listener = listener;
  }

  onClose(listener: () => void): void {
    this.closeListener = listener;
  }

  close(): void {
    this.closed = true;
  }

  /** Test helper: the link drops by itself. */
  drop(): void {
    this.closed = true;
    this.closeListener?.();
  }

  /** Test helper: the adapter says something nobody asked for. */
  say(text: string): void {
    this.deliver(text);
  }

  private deliver(text: string): void {
    if (this.closed || !this.listener) return;
    const size = this.options.chunkSize;
    if (!size || size < 1) {
      this.listener(text);
      return;
    }
    for (let i = 0; i < text.length; i += size) this.listener(text.slice(i, i + size));
  }
}

/** An emulator wired to a transport in one go. */
export function emulatedTransport(options: EmulatorOptions, transport: ScriptedOptions): ScriptedTransport {
  const emu = new ElmEmulator(options);
  return new ScriptedTransport((cmd) => emu.reply(cmd), transport);
}

/**
 * Play a recorded drive as a car. `nowSeconds` says how far into the drive we are; the value
 * of each channel is the line between the two nearest recorded points, and channels the drive
 * never recorded are not supported (so they answer NO DATA and are left out of the bitmap).
 */
export function driveSource(drive: Drive, nowSeconds: () => number): Pick<EmulatorOptions, 'valueFor' | 'supportedPids'> {
  const series = new Map<Channel, ReturnType<typeof seriesOf>>();
  for (const ch of CHANNELS) {
    const s = seriesOf(drive, ch);
    if (s.length > 0) series.set(ch, s);
  }
  const first = drive.samples[0]?.t_s ?? 0;
  return {
    supportedPids: PIDS.filter((p) => series.has(p.channel)).map((p) => p.id),
    valueFor: (channel) => {
      const s = series.get(channel);
      if (!s) return null;
      const t = first + nowSeconds();
      return valueAt(s, t) ?? holdValue(s, t);
    },
  };
}
