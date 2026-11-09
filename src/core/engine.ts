/**
 * The engine as a musical instrument.
 *
 * An engine at a steady RPM makes a steady note. Its loudest component is the firing
 * frequency: how many cylinders fire per second. In a four-stroke engine each cylinder
 * fires once every two crankshaft turns, so
 *
 *   firing Hz = RPM / 60 * cylinders / 2
 *
 * A V6 at 2,400 rpm fires 120 times a second, a note that sits between A#2 and B2.
 * Everything else in this app starts from that one number.
 *
 * Pitch is counted in MIDI note numbers (69 = A4 = 440 Hz, 12 per octave). A note number can
 * be fractional: 69.5 is a quarter tone above A4. Names use the convention where note 60 is C4.
 */

export interface EngineSpec {
  id: string;
  /** For the screen. */
  name: string;
  cylinders: number;
  strokes: 2 | 4;
  idleRpm: number;
  redlineRpm: number;
}

export const ENGINES: readonly EngineSpec[] = [
  { id: 'v6', name: 'V6, four-stroke', cylinders: 6, strokes: 4, idleRpm: 800, redlineRpm: 6500 },
  { id: 'i4', name: 'Inline four, four-stroke', cylinders: 4, strokes: 4, idleRpm: 750, redlineRpm: 7000 },
  { id: 'v8', name: 'V8, four-stroke', cylinders: 8, strokes: 4, idleRpm: 700, redlineRpm: 6200 },
  { id: 'i3', name: 'Three cylinder, four-stroke', cylinders: 3, strokes: 4, idleRpm: 850, redlineRpm: 6500 },
];

export const DEFAULT_ENGINE: EngineSpec = ENGINES[0]!;

export function engineById(id: string): EngineSpec {
  return ENGINES.find((e) => e.id === id) ?? DEFAULT_ENGINE;
}

/** The highest RPM any dial or slider in the app will show. */
export const RPM_MAX = 8000;

export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;

const finite = (n: number): boolean => Number.isFinite(n);

/** RPM made safe for arithmetic: finite, never negative, never past the dial. */
export function cleanRpm(rpm: number): number {
  if (!finite(rpm) || rpm <= 0) return 0;
  return Math.min(rpm, RPM_MAX);
}

/** Firing frequency in hertz. 0 rpm gives 0 Hz. */
export function firingHz(rpm: number, engine: EngineSpec = DEFAULT_ENGINE): number {
  const firesPerRev = engine.cylinders / (engine.strokes / 2);
  return (cleanRpm(rpm) / 60) * firesPerRev;
}

/** MIDI note number for a frequency; fractional. NaN for 0 or less, so callers must check. */
export function midiFromHz(hz: number): number {
  if (!finite(hz) || hz <= 0) return Number.NaN;
  return 69 + 12 * Math.log2(hz / 440);
}

export function hzFromMidi(midi: number): number {
  if (!finite(midi)) return 0;
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/** Pitch class 0..11 (C = 0) of a note number, rounding to the nearest semitone. */
export function pitchClass(midi: number): number {
  const n = Math.round(midi);
  return ((n % 12) + 12) % 12;
}

/** "D#1", "A2". The empty string for a non-number. */
export function noteName(midi: number): string {
  if (!finite(midi)) return '';
  const n = Math.round(midi);
  const name = NOTE_NAMES[pitchClass(n)] ?? 'C';
  return `${name}${Math.floor(n / 12) - 1}`;
}

/** How far a fractional note is from its nearest semitone, in cents (-50 to +50). */
export function centsOff(midi: number): number {
  if (!finite(midi)) return 0;
  const c = Math.round((midi - Math.round(midi)) * 100);
  return c === 0 ? 0 : c; // never minus zero
}

/** The smallest signed step from one pitch class to another, in semitones (-6 to +6). */
export function wrapSemitones(diff: number): number {
  if (!finite(diff)) return 0;
  let d = ((diff % 12) + 12) % 12;
  if (d > 6) d -= 12;
  return d === 0 ? 0 : d;
}

/** The engine's note at an RPM, with everything the screen shows about it. */
export interface EngineNote {
  hz: number;
  /** Fractional note number, or NaN when the engine is off. */
  midi: number;
  name: string;
  cents: number;
}

export function engineNote(rpm: number, engine: EngineSpec = DEFAULT_ENGINE): EngineNote {
  const hz = firingHz(rpm, engine);
  const midi = midiFromHz(hz);
  return { hz, midi, name: noteName(midi), cents: centsOff(midi) };
}
