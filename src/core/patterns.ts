/**
 * The music, written down as data.
 *
 * Two lanes share one tempo and one key. Each is a two-bar loop on a sixteenth-note grid, and
 * each step is a list of events: which voice, how loud, how long, and a pitch as semitones from
 * the key's root. Because pitch is relative, moving the root (the key lock) moves the whole song
 * and every voice stays in tune with the others.
 *
 * These are placeholder beats written for the demo, not released tracks. The audio layer turns
 * each event into sound; this file never touches audio, so the patterns are tested like any
 * other data: every event is finite, every step is covered, the downbeats carry a kick.
 */

export const BPM = 140;
export const STEPS_PER_BAR = 16;
export const BARS = 2;
export const LOOP_STEPS = STEPS_PER_BAR * BARS;
/** Seconds per sixteenth note. */
export const STEP_SECONDS = 60 / BPM / 4;

export type Lane = 'calm' | 'pump';

export type Voice =
  /** Pitched: a low sine with a long tail, the bass of the pump lane. */
  | 'bass'
  /** Pitched: soft chord tone with a slow swell. */
  | 'pad'
  /** Pitched: short bright pluck for melodies. */
  | 'pluck'
  /** Pitched: a sine thump tuned to the root's fifth, standing in for a hand drum. */
  | 'tom'
  /** Pitched: thin lead stab. */
  | 'stab'
  /** Unpitched drums. */
  | 'kick'
  | 'snare'
  | 'hat'
  | 'open-hat';

export interface NoteEvent {
  voice: Voice;
  /** Semitones above the root. Ignored by unpitched voices. */
  interval: number;
  /** Octave offset for pitched voices; 0 means the root's own octave (A2 for the demo). */
  octave: number;
  /** 0 to 1. */
  velocity: number;
  /** Length in steps. */
  steps: number;
  /** Bass only: slide to this interval over the note's second half. */
  glideTo?: number;
  /** Extra timing offset within the step, in thirds (0, 1, 2), for rolls. */
  thirds?: number;
}

/** Minor pentatonic over the root, for melodies that stay in key under any shift. */
export const PENTATONIC = [0, 3, 5, 7, 10, 12, 15] as const;

const ev = (voice: Voice, velocity: number, steps: number, interval = 0, octave = 0, extra: Partial<NoteEvent> = {}): NoteEvent => ({
  voice,
  interval,
  octave,
  velocity,
  steps,
  ...extra,
});

/** Calm lane: a pad on the downbeat, a soft kick, a tuned hand drum, a pentatonic pluck line. */
function calmStep(step: number): NoteEvent[] {
  const bar = Math.floor(step / STEPS_PER_BAR) % BARS;
  const k = step % STEPS_PER_BAR;
  const out: NoteEvent[] = [];
  if (k === 0) for (const iv of [0, 3, 7, 10]) out.push(ev('pad', 0.5, 15, iv, 1));
  if (k === 0 || k === 8) out.push(ev('kick', 0.35, 2));
  if (k === 4 || k === 12 || k === 14) out.push(ev('tom', 0.25, 1, 7, 0));
  if (k % 4 === 2) out.push(ev('hat', 0.2, 1));
  const line = bar ? [0, 0, 4, 0, 0, 3, 0, 0, 2, 0, 0, 0, 1, 0, 0, 0] : [0, 0, 0, 2, 0, 0, 4, 0, 0, 0, 3, 0, 5, 0, 0, 0];
  const degree = line[k] ?? 0;
  if (degree) out.push(ev('pluck', 0.45, 2, PENTATONIC[degree - 1] ?? 0, 3));
  return out;
}

/** Pump lane: a drill-style pattern at 140, sliding bass on the root, hats in triplet rolls. */
function pumpStep(step: number): NoteEvent[] {
  const bar = Math.floor(step / STEPS_PER_BAR) % BARS;
  const k = step % STEPS_PER_BAR;
  const out: NoteEvent[] = [];
  const kicks = bar ? [0, 3, 10] : [0, 6];
  if (kicks.includes(k)) out.push(ev('kick', 0.8, 2));
  if (k === 8) out.push(ev('snare', 0.7, 2));
  if (k % 2 === 0) out.push(ev('hat', k % 4 === 0 ? 0.5 : 0.3, 1));
  if (bar && k === 14) {
    out.push(ev('hat', 0.35, 1, 0, 0, { thirds: 1 }));
    out.push(ev('hat', 0.35, 1, 0, 0, { thirds: 2 }));
  }
  if (k === 0) out.push(bar ? ev('bass', 0.9, 10, 0, 0) : ev('bass', 0.9, 6, 0, 0, { glideTo: 3 }));
  if (!bar && k === 6) out.push(ev('bass', 0.8, 10, 3, 0));
  if (bar && k === 10) out.push(ev('bass', 0.8, 6, -2, 0));
  if (!bar && k === 12) out.push(ev('stab', 0.3, 1, 7, 2));
  return out;
}

export function eventsAt(lane: Lane, step: number): NoteEvent[] {
  const s = Number.isFinite(step) ? ((Math.trunc(step) % LOOP_STEPS) + LOOP_STEPS) % LOOP_STEPS : 0;
  return lane === 'calm' ? calmStep(s) : pumpStep(s);
}

/** The shift drop: one hit of everything, played on the master bus when a gear change lands. */
export const DROP: readonly NoteEvent[] = [
  ev('kick', 1, 2),
  ev('snare', 0.8, 2),
  ev('open-hat', 0.5, 6),
  ev('bass', 1, 8, 0, 0),
];

/**
 * The look-ahead scheduler's one decision: which steps fall inside the next `lookahead` seconds.
 * Audio is scheduled a little into the future so that a busy main thread (a slow frame, a
 * Bluetooth packet) never makes the beat stutter. Pure, so it is tested without an AudioContext.
 */
export interface ScheduleCursor {
  /** Audio-clock time the next step should sound. */
  nextTime: number;
  step: number;
}

export function stepsDue(cursor: ScheduleCursor, now: number, lookahead: number): { due: ScheduleCursor[]; cursor: ScheduleCursor } {
  const due: ScheduleCursor[] = [];
  let c = cursor;
  if (!Number.isFinite(now) || !Number.isFinite(lookahead)) return { due, cursor: c };
  // A cursor that fell far behind (the tab was asleep) jumps forward instead of replaying the gap.
  if (now - c.nextTime > 1) c = { nextTime: now, step: c.step };
  let guard = 0;
  while (c.nextTime < now + lookahead && guard++ < 1000) {
    due.push(c);
    c = { nextTime: c.nextTime + STEP_SECONDS, step: c.step + 1 };
  }
  return { due, cursor: c };
}
