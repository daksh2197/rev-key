/**
 * Talking to an ELM327: cutting its stream into answers, and reading each answer.
 *
 * The adapter is a chatty serial device. Depending on its settings and its maker it echoes
 * what you typed, ends lines with CR or CRLF, puts spaces between bytes or not, prints
 * "SEARCHING..." the first time, and sometimes sends noise. Everything here is written so
 * that no input, however broken, can throw: a bad answer becomes an `error` value.
 *
 * The AT commands come from the Elm Electronics ELM327 datasheet; the mode 01 answers
 * ("41 <pid> <data>") from SAE J1979 as listed on the Wikipedia "OBD-II PIDs" page.
 */

import { BITMAP_PIDS, pidById } from './pids';

// ---------- the read-only rule ----------

/** The only AT commands the app ever sends. All of them set up the adapter; none writes to the car. */
export const SETUP_COMMANDS = ['ATZ', 'ATE0', 'ATL0', 'ATS0', 'ATH0', 'ATSP0'] as const;

/**
 * The one place that decides what may be sent to the adapter.
 * Allowed: the six setup commands above, and mode 01 requests (two hex digits "01" plus a
 * two-digit PID). Everything else is refused, including every other mode (04 clears codes,
 * 08 and 09 control and read vehicle info, 2x and above write), every other AT command and
 * anything with extra characters in it.
 */
export function isAllowedCommand(cmd: string): boolean {
  if (typeof cmd !== 'string') return false;
  const c = cmd.toUpperCase().replace(/ /g, '');
  if ((SETUP_COMMANDS as readonly string[]).includes(c)) return true;
  return /^01[0-9A-F]{2}$/.test(c);
}

// ---------- cutting the stream into answers ----------

const MAX_BUFFER = 4096;

/**
 * Collects text as it arrives and hands back one block per answer. An answer ends at the
 * '>' prompt the adapter prints when it is ready for the next command. Chunks can split
 * anywhere, even in the middle of a hex pair.
 */
export class Framer {
  private buffer = '';

  /** Feed a chunk; get back every answer that this chunk completed (blank ones are dropped). */
  push(chunk: string): string[] {
    this.buffer += typeof chunk === 'string' ? chunk : '';
    const out: string[] = [];
    let at = this.buffer.indexOf('>');
    while (at !== -1) {
      const block = this.buffer.slice(0, at);
      this.buffer = this.buffer.slice(at + 1);
      if (block.trim() !== '') out.push(block);
      at = this.buffer.indexOf('>');
    }
    // A flood of noise with no prompt must not grow without limit.
    if (this.buffer.length > MAX_BUFFER) this.buffer = this.buffer.slice(-MAX_BUFFER);
    return out;
  }

  reset(): void {
    this.buffer = '';
  }
}

// ---------- reading one answer ----------

export type ElmError =
  | 'no-data'
  | 'unable-to-connect'
  | 'bus-init'
  | 'can-error'
  | 'stopped'
  | 'unknown-command'
  | 'adapter-error'
  | 'wrong-pid'
  | 'truncated'
  | 'garbage'
  | 'empty';

export interface Reading {
  pid: number;
  bytes: number[];
}

export interface Failure {
  error: ElmError;
  /** The cleaned text that led to this verdict, for the status line. */
  text: string;
}

export type ParseResult = Reading | Failure;

export function isFailure(r: ParseResult): r is Failure {
  return 'error' in r;
}

/** Printable ASCII only (garbage bytes vanish), upper case, one trimmed line per entry, blanks dropped. */
function cleanLines(raw: unknown): string[] {
  const text = typeof raw === 'string' ? raw : '';
  return text
    .replace(/[^\x20-\x7e\r\n]/g, '')
    .replace(/>/g, '')
    .split(/[\r\n]+/)
    .map((l) => l.trim().toUpperCase())
    .filter((l) => l !== '');
}

/**
 * Join the numbered lines of a multi-frame answer ("0: 41 00 BE 3F" / "1: A8 13") into one
 * line, and drop the 3-digit length line that comes before them.
 */
function logicalLines(lines: string[]): string[] {
  const out: string[] = [];
  let joined: string | null = null;
  lines.forEach((line, i) => {
    const numbered = /^[0-9A-F]:\s*(.*)$/.exec(line);
    if (numbered) {
      joined = (joined ?? '') + ' ' + (numbered[1] ?? '');
      return;
    }
    if (joined !== null) {
      out.push(joined.trim());
      joined = null;
    }
    const next = lines[i + 1];
    if (/^[0-9A-F]{3}$/.test(line) && next !== undefined && /^[0-9A-F]:/.test(next)) return; // length header
    out.push(line);
  });
  if (joined !== null) out.push((joined as string).trim());
  return out;
}

/** Every line that looks like a mode 01 answer ("41 <pid> ..."), whether or not it is complete. */
function candidates(lines: string[]): Reading[] {
  const out: Reading[] = [];
  for (const line of logicalLines(lines)) {
    if (!/^[0-9A-F ]+$/.test(line)) continue;
    let hex = line.replace(/ /g, '');
    if (hex.length % 2 === 1) hex = hex.slice(0, -1); // cut mid-byte: keep the whole bytes
    if (hex.length < 4 || !hex.startsWith('41')) continue;
    const bytes: number[] = [];
    for (let i = 2; i + 2 <= hex.length; i += 2) bytes.push(parseInt(hex.slice(i, i + 2), 16));
    const pid = bytes.shift();
    if (pid !== undefined) out.push({ pid, bytes });
  }
  return out;
}

/** How many data bytes a PID's answer must have. */
function neededBytes(pid: number): number {
  const known = pidById(pid);
  if (known) return known.bytes;
  return (BITMAP_PIDS as readonly number[]).includes(pid) || pid % 0x20 === 0 ? 4 : 1;
}

function complete(c: Reading): boolean {
  return c.bytes.length >= neededBytes(c.pid);
}

/**
 * Every complete mode 01 answer in the text, in the order they came. Two ECUs answering
 * gives two entries. Pass `expectPid` to keep only answers to that PID.
 */
export function parseAll(raw: string, expectPid?: number): Reading[] {
  return candidates(cleanLines(raw))
    .filter((c) => (expectPid === undefined || c.pid === expectPid) && complete(c))
    .map((c) => ({ pid: c.pid, bytes: c.bytes.slice(0, neededBytes(c.pid)) }));
}

/**
 * Read one answer. `parseResponse('41 0C 1A F8')` is `{ pid: 0x0C, bytes: [0x1A, 0xF8] }`.
 * If several ECUs answered, the first line for the asked PID wins. If nothing usable is
 * there, the result is `{ error, text }` saying why. Never throws.
 */
export function parseResponse(raw: string, expectPid?: number): ParseResult {
  const lines = cleanLines(raw);
  const good = parseAll(raw, expectPid)[0];
  if (good) return good;

  const text = lines.join(' | ');
  const has = (needle: string): boolean => lines.some((l) => l.includes(needle));
  if (has('UNABLE TO CONNECT')) return { error: 'unable-to-connect', text };
  if (has('BUS INIT') && has('ERROR')) return { error: 'bus-init', text };
  if (has('CAN ERROR')) return { error: 'can-error', text };
  if (has('STOPPED')) return { error: 'stopped', text };
  if (has('NO DATA')) return { error: 'no-data', text };
  if (lines.some((l) => /^\?+$/.test(l))) return { error: 'unknown-command', text };
  if (has('ERROR') || has('BUFFER FULL') || has('BUS BUSY') || has('LV RESET') || has('ACT ALERT')) {
    return { error: 'adapter-error', text };
  }

  const heard = candidates(lines);
  if (heard.some((c) => expectPid === undefined || c.pid === expectPid)) return { error: 'truncated', text };
  if (heard.length > 0) return { error: 'wrong-pid', text };
  const meaningful = lines.filter((l) => !l.startsWith('SEARCHING'));
  if (meaningful.length === 0) return { error: 'empty', text };
  return { error: 'garbage', text };
}

/** Read the answer to a setup command: ok when the adapter said anything that is not an error. */
export function parseSetupReply(raw: string, sent: string): { ok: boolean; text: string } {
  const echoed = sent.toUpperCase().replace(/ /g, '');
  const lines = cleanLines(raw).filter((l) => l.replace(/ /g, '') !== echoed);
  const text = lines.join(' ');
  if (lines.length === 0) return { ok: false, text };
  const bad = lines.some((l) => /^\?+$/.test(l) || l.includes('ERROR'));
  return { ok: !bad, text };
}

/** A short plain sentence for an error, for the status line. */
export function describeError(error: ElmError): string {
  switch (error) {
    case 'no-data':
      return 'The car did not answer (is the ignition on?).';
    case 'unable-to-connect':
      return 'The adapter cannot talk to the car (ignition off, or the adapter is not plugged in all the way).';
    case 'bus-init':
      return 'The adapter could not start the conversation with the car.';
    case 'can-error':
      return 'The adapter reported a CAN bus error.';
    case 'stopped':
      return 'The adapter stopped the request.';
    case 'unknown-command':
      return 'The adapter did not understand the command.';
    case 'adapter-error':
      return 'The adapter reported an error.';
    case 'wrong-pid':
      return 'The answer was for a different value than the one asked for.';
    case 'truncated':
      return 'The answer was cut short.';
    case 'garbage':
      return 'The adapter sent something unreadable.';
    case 'empty':
      return 'The adapter sent an empty answer.';
  }
}
