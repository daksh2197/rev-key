/**
 * The tachometer, with a second scale.
 *
 * The outer ring is a normal rev counter: 0 to 8 (thousand rpm), redline from the engine's
 * redline. The inner ring is new: the engine's note at each RPM, so the needle reads two
 * things at once, "2,200 rpm" and "A2". A small marker on the inner ring shows where the song's
 * root sits. When the lock engages the marker slides onto the needle: the song came to the engine.
 *
 * Pure drawing; the page feeds it numbers.
 */

import { type EngineSpec, engineNote, firingHz, hzFromMidi, NOTE_NAMES, pitchClass } from '../core/engine';
import { RPM_MAX } from '../core/engine';

const CX = 160;
const CY = 166;
const R = 132;
/** Degrees either side of straight up. */
const SWEEP = 128;

export function angleForRpm(rpm: number): number {
  const safe = Number.isFinite(rpm) ? Math.min(Math.max(rpm, 0), RPM_MAX) : 0;
  return -SWEEP + (2 * SWEEP * safe) / RPM_MAX;
}

function point(angle: number, radius: number): [number, number] {
  const a = (angle * Math.PI) / 180;
  return [CX + radius * Math.sin(a), CY - radius * Math.cos(a)];
}

function arc(from: number, to: number, radius: number): string {
  const [x0, y0] = point(from, radius);
  const [x1, y1] = point(to, radius);
  const large = to - from > 180 ? 1 : 0;
  return `M${x0.toFixed(2)} ${y0.toFixed(2)} A${radius} ${radius} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

function spoke(angle: number, inner: number, outer: number, cls: string): string {
  const [x0, y0] = point(angle, inner);
  const [x1, y1] = point(angle, outer);
  return `<line class="${cls}" x1="${x0.toFixed(2)}" y1="${y0.toFixed(2)}" x2="${x1.toFixed(2)}" y2="${y1.toFixed(2)}"/>`;
}

/** The RPM at which this engine plays a given note number. */
export function rpmForMidi(midi: number, engine: EngineSpec): number {
  const hzPerRpm = firingHz(1, engine);
  return hzPerRpm > 0 ? hzFromMidi(midi) / hzPerRpm : 0;
}

/** Whole notes between the engine's idle and the dial's top, each with the RPM it sits at. */
export function noteTicks(engine: EngineSpec): { midi: number; rpm: number; name: string }[] {
  const out: { midi: number; rpm: number; name: string }[] = [];
  const lo = Math.ceil(engineNote(Math.max(300, engine.idleRpm * 0.5), engine).midi);
  const hi = Math.floor(engineNote(RPM_MAX, engine).midi);
  for (let m = lo; m <= hi; m++) {
    const rpm = rpmForMidi(m, engine);
    if (rpm > 0 && rpm <= RPM_MAX) out.push({ midi: m, rpm, name: NOTE_NAMES[pitchClass(m)] ?? '' });
  }
  return out;
}

function draw(engine: EngineSpec): string {
  const ticks: string[] = [];
  for (let r = 0; r <= RPM_MAX; r += 250) {
    const major = r % 1000 === 0;
    const cls = ['tick', major ? 'tick-major' : '', r >= engine.redlineRpm ? 'tick-red' : ''].filter(Boolean).join(' ');
    ticks.push(spoke(angleForRpm(r), R - (major ? 16 : 8), R, cls));
    if (major) {
      const [x, y] = point(angleForRpm(r), R - 30);
      ticks.push(`<text class="num${r >= engine.redlineRpm ? ' num-red' : ''}" x="${x.toFixed(1)}" y="${(y + 5).toFixed(1)}">${r / 1000}</text>`);
    }
  }

  // Notes bunch up at low revs (an octave is a doubling of RPM), so a name is only written
  // where there is room for it: at least this many degrees from the last one written.
  const MIN_LABEL_GAP = 11;
  const notes: string[] = [];
  let lastLabelAngle = Number.NEGATIVE_INFINITY;
  for (const n of noteTicks(engine)) {
    if (n.rpm < engine.idleRpm * 0.75) continue; // below idle the ticks bunch into a smear
    const a = angleForRpm(n.rpm);
    const natural = !n.name.includes('#');
    notes.push(spoke(a, R - 58, R - 50, natural ? 'note-tick' : 'note-tick note-sharp'));
    if (natural && n.rpm >= engine.idleRpm && a - lastLabelAngle >= MIN_LABEL_GAP) {
      lastLabelAngle = a;
      const [x, y] = point(a, R - 70);
      notes.push(`<text class="note-name" x="${x.toFixed(1)}" y="${(y + 4).toFixed(1)}">${n.name}</text>`);
    }
  }

  const redStart = angleForRpm(engine.redlineRpm);

  return `
<svg viewBox="0 0 320 236" role="img" aria-labelledby="tach-title">
  <title id="tach-title">Rev counter</title>
  <path class="band" d="${arc(-SWEEP, SWEEP, R)}"/>
  <path class="band-red" d="${arc(redStart, SWEEP, R + 4)}"/>
  ${ticks.join('\n  ')}
  <path class="note-ring" d="${arc(-SWEEP, SWEEP, R - 54)}"/>
  ${notes.join('\n  ')}
  <g class="root-marker" data-part="root">
    <path d="M${CX} ${(CY - R + 44).toFixed(1)} l-6 -9 h12 z"/>
  </g>
  <g class="needle" data-part="needle">
    <path class="needle-blade" d="M${CX - 1.2} 46 L${CX + 1.2} 46 L${CX + 3} ${CY} L${CX + 2} ${CY + 24} L${CX - 2} ${CY + 24} L${CX - 3} ${CY} Z"/>
  </g>
  <circle class="hub" cx="${CX}" cy="${CY}" r="12"/>
  <circle class="hub-pin" cx="${CX}" cy="${CY}" r="3"/>
  <text class="read-rpm" data-part="rpm" x="${CX}" y="${CY + 48}">0</text>
  <text class="read-unit" x="${CX}" y="${CY + 62}">rpm</text>
</svg>`;
}

export interface TachState {
  rpm: number;
  /** The RPM at which the song's root would sound, for the marker. Null hides it. */
  rootRpm: number | null;
  locked: boolean;
  /** One sentence for screen readers. */
  description: string;
}

export interface Tach {
  set(state: TachState): void;
  /** Redraw for another engine (its redline and note positions change). */
  setEngine(engine: EngineSpec): void;
}

export function mountTach(host: HTMLElement, engine: EngineSpec): Tach {
  let rpmText: SVGTextElement;
  let title: SVGTitleElement;
  const render = (e: EngineSpec): void => {
    host.innerHTML = draw(e);
    rpmText = host.querySelector<SVGTextElement>('[data-part="rpm"]')!;
    title = host.querySelector<SVGTitleElement>('title')!;
  };
  render(engine);
  const calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let first = true;
  let sweeping = false;
  let last: TachState | null = null;

  const apply = (state: TachState): void => {
    host.style.setProperty('--needle', `${angleForRpm(state.rpm).toFixed(2)}deg`);
    const rootAngle = state.rootRpm === null ? null : angleForRpm(state.rootRpm);
    host.style.setProperty('--root', `${(rootAngle ?? angleForRpm(0)).toFixed(2)}deg`);
    host.classList.toggle('is-locked', state.locked);
    host.classList.toggle('no-root', rootAngle === null);
    rpmText.textContent = String(Math.round(state.rpm / 10) * 10);
    title.textContent = state.description;
  };

  return {
    set(state) {
      last = state;
      if (first && !calm) {
        // The ignition sweep, once: needle to the stop and back, like a car waking up.
        // Frames that arrive during the sweep only update `last`; the needle waits.
        first = false;
        sweeping = true;
        host.style.setProperty('--needle', `${angleForRpm(RPM_MAX).toFixed(2)}deg`);
        window.setTimeout(() => {
          sweeping = false;
          if (last) apply(last);
        }, 650);
        return;
      }
      first = false;
      if (!sweeping) apply(state);
    },
    setEngine(e) {
      render(e);
      if (last) apply(last);
    },
  };
}
