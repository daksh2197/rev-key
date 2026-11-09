/**
 * The conversation with the adapter: set it up, learn what the car supports, then ask for
 * those values over and over and hand out samples.
 *
 * It only knows the `Transport` interface, so the same code runs over Web Bluetooth, over the
 * scripted fake in the tests, and over the fake in demo mode. It never hangs: every request
 * has a timeout, and an adapter that stops answering ends the session with a status.
 */

import { CHANNELS, type Channel, type Sample } from '../core/log';
import {
  describeError,
  Framer,
  isAllowedCommand,
  isFailure,
  parseAll,
  parseResponse,
  parseSetupReply,
  SETUP_COMMANDS,
} from './elm';
import {
  BITMAP_PIDS,
  decodeSupported,
  PIDS,
  requestFor,
  SLOW_EVERY,
  type Pid,
} from './pids';

/**
 * A way to send commands to the adapter and hear back. Three small methods, so a test can
 * stand in for Bluetooth.
 *
 * `send` takes the command without its line ending (the transport adds the CR).
 * `onLine` registers a listener for incoming text. Despite the name it receives chunks that
 * may start or stop mid-line; the Framer in elm.ts does the cutting.
 */
export interface Transport {
  send(line: string): Promise<void>;
  onLine(listener: (chunk: string) => void): void;
  /** Called once if the link drops by itself. Optional for simple fakes. */
  onClose?(listener: () => void): void;
  close(): void;
}

/** Time, injected so tests can run a minute of conversation in a blink. */
export interface Clock {
  now(): number;
  /** Run `fn` after `ms`; returns a function that cancels it. */
  after(ms: number, fn: () => void): () => void;
}

export const realClock: Clock = {
  now: () => performance.now(),
  after: (ms, fn) => {
    const h = setTimeout(fn, ms);
    return () => clearTimeout(h);
  },
};

export type SessionState = 'idle' | 'initialising' | 'polling' | 'stopped' | 'failed';

export type SessionReason =
  | 'user-stopped'
  | 'no-answer'
  | 'unable-to-connect'
  | 'no-data'
  | 'no-pids'
  | 'adapter-error'
  | 'link-closed';

export interface SessionStatus {
  state: SessionState;
  reason?: SessionReason;
  /** A plain sentence for the screen. */
  message: string;
  /** PIDs the car said it supports, once known. */
  supported?: number[];
}

export interface SessionOptions {
  clock?: Clock;
  onSample?: (sample: Sample) => void;
  onStatus?: (status: SessionStatus) => void;
  /** How long to wait for one answer. */
  requestTimeoutMs?: number;
  /** ATZ resets the chip and can take a second or two. */
  resetTimeoutMs?: number;
  /** The first 0100 can take ten seconds while the adapter searches protocols. */
  searchTimeoutMs?: number;
  /** This many failed requests in a row ends the session. */
  maxMisses?: number;
  /** A breath between cycles; also guarantees the page is never starved by a fast fake. */
  cyclePauseMs?: number;
}

const SEARCH_TRIES = 3;

/** Errors that mean the link or the car is in trouble, as opposed to "that value is not available now". */
const TROUBLE: ReadonlySet<string> = new Set([
  'unable-to-connect',
  'bus-init',
  'can-error',
  'stopped',
  'adapter-error',
]);

export class Session {
  private readonly clock: Clock;
  private readonly framer = new Framer();
  private readonly requestTimeoutMs: number;
  private readonly resetTimeoutMs: number;
  private readonly searchTimeoutMs: number;
  private readonly maxMisses: number;
  private readonly cyclePauseMs: number;
  private pending: { resolve: (block: string | null) => void; cancel: () => void } | null = null;
  private stopRequested = false;
  private finished = false;
  private status: SessionStatus = { state: 'idle', message: 'Not started.' };
  /** Every command sent, in order. Handy for the tests and for the setup page. */
  readonly sent: string[] = [];

  constructor(
    private readonly transport: Transport,
    private readonly options: SessionOptions = {},
  ) {
    this.clock = options.clock ?? realClock;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 2000;
    this.resetTimeoutMs = options.resetTimeoutMs ?? 5000;
    this.searchTimeoutMs = options.searchTimeoutMs ?? 12000;
    this.maxMisses = options.maxMisses ?? 5;
    this.cyclePauseMs = options.cyclePauseMs ?? 0;
    transport.onLine((chunk) => this.onChunk(chunk));
    transport.onClose?.(() => this.end('failed', 'link-closed', 'The Bluetooth link closed.'));
  }

  get current(): SessionStatus {
    return this.status;
  }

  /** Ask the session to finish. Safe to call at any time, more than once. */
  stop(): void {
    this.stopRequested = true;
    this.pending?.resolve(null);
    this.end('stopped', 'user-stopped', 'Stopped.');
    this.transport.close();
  }

  /** Run the whole conversation. Resolves with the final status when the session ends. */
  async start(): Promise<SessionStatus> {
    try {
      this.setStatus({ state: 'initialising', message: 'Setting up the adapter.' });
      if (!(await this.setup())) return this.status;
      const supported = await this.learnSupported();
      if (!supported) return this.status;
      const polled = PIDS.filter((p) => supported.includes(p.id));
      if (polled.length === 0) {
        return this.end('failed', 'no-pids', 'The car did not list any value this app can read.', supported);
      }
      this.setStatus({
        state: 'polling',
        message: `Reading ${polled.length} values.`,
        supported,
      });
      await this.poll(polled);
    } catch (e) {
      // Only reachable by a bug or a transport that throws; end with a status rather than hang.
      this.end('failed', 'adapter-error', e instanceof Error ? e.message : 'Unexpected error.');
    }
    return this.status;
  }

  // ----- steps -----

  private async setup(): Promise<boolean> {
    for (const cmd of SETUP_COMMANDS) {
      if (this.stopRequested) return false;
      const block = await this.ask(cmd, cmd === 'ATZ' ? this.resetTimeoutMs : this.requestTimeoutMs);
      if (block === null) {
        this.end('failed', 'no-answer', 'The adapter did not answer. Is it powered and in range?');
        return false;
      }
      // A "?" for one setup command is tolerated: some clones do not know every command.
      parseSetupReply(block, cmd);
    }
    return true;
  }

  /** Ask 0100 (and 0120, 0140 when announced) and return the union of what the car supports. */
  private async learnSupported(): Promise<number[] | null> {
    const supported = new Set<number>();
    for (const base of BITMAP_PIDS) {
      if (this.stopRequested) return null;
      if (base !== 0x00 && !supported.has(base)) break; // the previous bitmap said there is no next page
      const got = await this.askBitmap(base);
      if (got === 'fatal') return null;
      if (got === 'none') {
        if (base === 0x00) return null; // end() already called
        break;
      }
      for (const pid of got) supported.add(pid);
    }
    return [...supported].sort((a, b) => a - b);
  }

  private async askBitmap(base: number): Promise<number[] | 'none' | 'fatal'> {
    const cmd = requestFor(base);
    let last: SessionReason = 'no-answer';
    let lastText = 'The adapter did not answer.';
    for (let attempt = 0; attempt < SEARCH_TRIES; attempt++) {
      if (this.stopRequested) return 'fatal';
      const block = await this.ask(cmd, this.searchTimeoutMs);
      if (block === null) {
        last = 'no-answer';
        lastText = 'The adapter stopped answering while looking for the car.';
        continue;
      }
      const readings = parseAll(block, base);
      if (readings.length > 0) {
        // Several ECUs may answer; the car supports what any of them supports.
        const pids = new Set<number>();
        for (const r of readings) for (const p of decodeSupported(base, r.bytes)) pids.add(p);
        return [...pids];
      }
      const parsed = parseResponse(block, base);
      if (isFailure(parsed)) {
        if (parsed.error === 'unable-to-connect') {
          if (base === 0x00) this.end('failed', 'unable-to-connect', describeError(parsed.error));
          return base === 0x00 ? 'fatal' : 'none';
        }
        last = parsed.error === 'no-data' ? 'no-data' : 'adapter-error';
        lastText = describeError(parsed.error);
      }
    }
    if (base === 0x00) {
      this.end('failed', last, lastText);
      return 'fatal';
    }
    return 'none'; // a later page that does not answer just means no more PIDs
  }

  private async poll(polled: Pid[]): Promise<void> {
    const fast = polled.filter((p) => p.rate === 'fast');
    const slow = polled.filter((p) => p.rate === 'slow');
    const origin = this.clock.now();
    let misses = 0;
    for (let cycle = 0; !this.stopRequested; cycle++) {
      const round = cycle % SLOW_EVERY === 0 ? [...fast, ...slow] : fast;
      const sample: Sample = { t_s: 0 };
      let got = 0;
      for (const pid of round) {
        if (this.stopRequested) return;
        const block = await this.ask(requestFor(pid.id), this.requestTimeoutMs);
        if (this.stopRequested) return;
        if (block === null) {
          misses++;
        } else {
          const r = parseResponse(block, pid.id);
          if (!isFailure(r)) {
            const value = pid.decode(r.bytes[0], r.bytes[1]);
            sample[pid.channel] = Math.round(value * 100) / 100;
            got++;
            misses = 0;
          } else if (TROUBLE.has(r.error)) {
            misses++;
          }
          // "no-data", garbage and wrong answers are skipped: the value just is not reported this cycle.
        }
        if (misses >= this.maxMisses) {
          this.end('failed', 'no-answer', 'The adapter stopped answering.');
          return;
        }
      }
      if (got > 0) {
        sample.t_s = Math.round(((this.clock.now() - origin) / 1000) * 1000) / 1000;
        this.options.onSample?.(sample);
      }
      await this.pause(this.cyclePauseMs);
    }
  }

  // ----- plumbing -----

  private pause(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.clock.after(ms, resolve);
    });
  }

  private onChunk(chunk: string): void {
    for (const block of this.framer.push(chunk)) this.pending?.resolve(block);
    // A block that arrives when nobody asked (a late answer to a request that timed out) is dropped.
  }

  /** Send one command and wait for its answer. Null means no answer in time (or the session ended). */
  private ask(cmd: string, timeoutMs: number): Promise<string | null> {
    if (!isAllowedCommand(cmd)) throw new Error(`Refused to send "${cmd}": the app only reads.`);
    if (this.stopRequested || this.finished) return Promise.resolve(null);
    return new Promise((resolve) => {
      const cancel = this.clock.after(timeoutMs, () => {
        this.framer.reset();
        settle(null);
      });
      const settle = (block: string | null): void => {
        if (this.pending?.resolve !== settle) return;
        this.pending = null;
        cancel();
        resolve(block);
      };
      this.pending = { resolve: settle, cancel };
      this.sent.push(cmd);
      this.transport.send(cmd).catch(() => settle(null));
    });
  }

  private setStatus(status: SessionStatus): void {
    if (this.finished) return;
    this.status = status;
    this.options.onStatus?.(status);
  }

  private end(state: 'stopped' | 'failed', reason: SessionReason, message: string, supported?: number[]): SessionStatus {
    if (!this.finished) {
      this.finished = true;
      this.status = { state, reason, message, ...(supported ? { supported } : { supported: this.status.supported }) };
      this.pending?.resolve(null);
      this.options.onStatus?.(this.status);
    }
    return this.status;
  }
}

/** Which channels does a set of PIDs cover? */
export function channelsFor(pids: readonly number[]): Channel[] {
  return CHANNELS.filter((ch) => PIDS.some((p) => p.channel === ch && pids.includes(p.id)));
}
