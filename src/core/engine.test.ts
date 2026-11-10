import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  centsOff,
  cleanRpm,
  DEFAULT_ENGINE,
  ENGINES,
  engineById,
  engineNote,
  firingHz,
  hzFromMidi,
  midiFromHz,
  noteName,
  pitchClass,
  RPM_MAX,
  wrapSemitones,
} from './engine';

describe('firing frequency', () => {
  it('a four-stroke V6 fires three times per revolution: 2,400 rpm is 120 Hz', () => {
    expect(firingHz(2400, DEFAULT_ENGINE)).toBeCloseTo(120, 9);
  });

  it('800 rpm on the V6 is 40 Hz, the idle drone the board started from', () => {
    expect(firingHz(800)).toBeCloseTo(40, 9);
  });

  it('an inline four fires twice per revolution', () => {
    expect(firingHz(3000, engineById('i4'))).toBeCloseTo(100, 9);
  });

  it('a V8 fires four times per revolution', () => {
    expect(firingHz(1500, engineById('v8'))).toBeCloseTo(100, 9);
  });

  it('an engine that is off makes no note', () => {
    expect(firingHz(0)).toBe(0);
    expect(engineNote(0).name).toBe('');
    expect(Number.isNaN(engineNote(0).midi)).toBe(true);
  });

  it('junk rpm is treated as off, and huge rpm stops at the dial', () => {
    expect(cleanRpm(Number.NaN)).toBe(0);
    expect(cleanRpm(-500)).toBe(0);
    expect(cleanRpm(Number.POSITIVE_INFINITY)).toBe(0); // not a number of revs, so off
    expect(cleanRpm(1e9)).toBe(RPM_MAX);
  });

  it('rises with rpm for every engine (property)', () => {
    fc.assert(
      fc.property(fc.constantFrom(...ENGINES), fc.double({ min: 1, max: 7999, noNaN: true }), fc.double({ min: 1, max: 1000, noNaN: true }), (e, rpm, more) => {
        const a = firingHz(rpm, e);
        const b = firingHz(rpm + more, e);
        return b > a && Number.isFinite(b);
      }),
    );
  });
});

describe('notes', () => {
  it('440 Hz is A4, note number 69', () => {
    expect(midiFromHz(440)).toBeCloseTo(69, 9);
    expect(noteName(69)).toBe('A4');
    expect(hzFromMidi(69)).toBeCloseTo(440, 9);
  });

  it('40 Hz is a D#1 a hair sharp, as the board said', () => {
    const n = engineNote(800);
    expect(n.name).toBe('D#1');
    expect(n.cents).toBeGreaterThan(0);
    expect(n.cents).toBeLessThan(50);
  });

  it('middle C is C4 and the note below it is B3', () => {
    expect(noteName(60)).toBe('C4');
    expect(noteName(59)).toBe('B3');
  });

  it('pitch class wraps every twelve semitones', () => {
    expect(pitchClass(0)).toBe(0);
    expect(pitchClass(12)).toBe(0);
    expect(pitchClass(-1)).toBe(11);
    expect(pitchClass(69)).toBe(9);
  });

  it('cents are never minus zero and never past half a semitone', () => {
    expect(Object.is(centsOff(60), -0)).toBe(false);
    expect(Math.abs(centsOff(60.5))).toBe(50);
    expect(centsOff(60.49)).toBe(49);
    expect(centsOff(60.51)).toBe(-49);
  });

  it('frequency and note number undo each other (property)', () => {
    fc.assert(
      fc.property(fc.double({ min: 20, max: 20000, noNaN: true }), (hz) => Math.abs(hzFromMidi(midiFromHz(hz)) - hz) < 1e-6 * hz),
    );
  });

  it('wrapSemitones picks the short way round the octave', () => {
    expect(wrapSemitones(7)).toBe(-5);
    expect(wrapSemitones(5)).toBe(5);
    expect(wrapSemitones(6)).toBe(6);
    expect(wrapSemitones(-7)).toBe(5);
    expect(wrapSemitones(12)).toBe(0);
    expect(wrapSemitones(Number.NaN)).toBe(0);
    expect(Object.is(wrapSemitones(-12), -0)).toBe(false);
  });

  it('wrapped shifts stay inside -6..6 for any whole number (property)', () => {
    fc.assert(fc.property(fc.integer({ min: -1000, max: 1000 }), (d) => Math.abs(wrapSemitones(d)) <= 6));
  });

  it('below the bottom of hearing there is no note name', () => {
    expect(engineNote(100).name).toBe(''); // 5 Hz
    expect(engineNote(400).name).toBe('D#0'); // 20 Hz
  });

  it('a non-number has no name and zero cents', () => {
    expect(noteName(Number.NaN)).toBe('');
    expect(centsOff(Number.NaN)).toBe(0);
    expect(hzFromMidi(Number.NaN)).toBe(0);
  });
});
