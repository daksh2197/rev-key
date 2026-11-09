/**
 * Numbers for the screen. Every function here returns a string that is never "NaN",
 * "Infinity", "undefined" or "-0", whatever it is given.
 */

const noNegZero = (n: number): number => (Object.is(n, -0) ? 0 : n);
const safe = (n: number): number => (Number.isFinite(n) ? noNegZero(n) : 0);
/** The screen never needs to show more than four octaves of shift. */
const SEMITONE_LIMIT = 48;

export function rpm(value: number): string {
  return Math.round(safe(value) / 10) * 10 === 0 ? '0' : (Math.round(safe(value) / 10) * 10).toLocaleString('en-CA');
}

export function hz(value: number): string {
  const v = Math.max(0, safe(value)); // a frequency is never negative
  return v >= 100 ? `${Math.round(v)} Hz` : `${noNegZero(Math.round(v * 10) / 10).toFixed(1)} Hz`;
}

/** "+1.3 st", "−2 st", "0 st". Whole numbers lose the decimal. */
export function semitones(value: number): string {
  const v = noNegZero(Math.round(Math.min(SEMITONE_LIMIT, Math.max(-SEMITONE_LIMIT, safe(value))) * 10) / 10);
  const text = Number.isInteger(v) ? String(Math.abs(v)) : Math.abs(v).toFixed(1);
  const sign = v > 0 ? '+' : v < 0 ? '−' : '';
  return `${sign}${text} st`;
}

export function percent(value: number): string {
  return `${Math.round(noNegZero(safe(value)))}%`;
}

export function kph(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return `${Math.round(noNegZero(value))} km/h`;
}

/** "1:23" for seconds. */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(safe(seconds)));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function ms(value: number): string {
  return `${Math.round(Math.max(0, safe(value)))} ms`;
}
