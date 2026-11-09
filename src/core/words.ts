/**
 * Every sentence the app says, in one place, so the wording can be read and tested as a whole.
 */

import { type EngineNote, NOTE_NAMES, pitchClass } from './engine';
import { semitones } from './format';
import type { KeyLockState } from './keylock';
import type { LaneOutput } from './lanes';
import type { ShiftEvent } from './shift';

export const APP_NAME = 'Rev Key';

export const START_HINT = 'Press Start. Hold the revs steady for a second and listen to the drone settle into the song.';
export const AUDIO_BLOCKED = 'The browser would not start sound. Press Start again, or check the tab is not muted.';

/** "A minor", for the song's key after the current shift. */
export function keyName(songRoot: number, shift: number): string {
  const shifted = Number.isFinite(shift) ? songRoot + shift : songRoot;
  return `${NOTE_NAMES[pitchClass(shifted)] ?? 'A'} minor`;
}

export function lockLine(lock: KeyLockState, note: EngineNote): string {
  switch (lock.phase) {
    case 'off':
      return 'Rev Key off: the song stays in its own key whatever the engine does.';
    case 'idle':
      return 'Idling. The lock waits for revs above 1,200.';
    case 'waiting':
      return lock.steadyMs > 0
        ? `Steadying: ${Math.round(lock.steadyMs / 100) / 10}s of the second the lock needs.`
        : 'Revs moving. Hold them steady for a second to lock the key.';
    case 'out-of-reach':
      return `Steady on ${note.name}, but the nearest root or fifth is more than two semitones away. The song keeps its key.`;
    case 'locked':
      return lock.target === 'fifth'
        ? `Locked: the engine's ${note.name} sits on the song's fifth (${semitones(lock.shift)}).`
        : `Locked: the engine's ${note.name} is the song's root (${semitones(lock.shift)}).`;
  }
}

export function laneLine(lane: LaneOutput): string {
  switch (lane.reason) {
    case 'counter-steer':
      return 'Counter-steer: hard driving where it does not belong. Calm lane, volume down.';
    case 'city-cap':
      return 'City: the pump lane stays below a third of the way open.';
    case 'pull':
      return 'Highway pull: the pump lane opens with the revs.';
    case 'calm':
      return 'Cruising in the calm lane.';
  }
}

export function shiftLine(event: ShiftEvent): string {
  return event.kind === 'predicted'
    ? `Shift coming in about ${event.inMs} ms. Drop scheduled so it lands on the gear change.`
    : 'Shift. Drop landed on the gear change.';
}

export const SOURCE_NAMES = {
  sim: 'Drive it here',
  replay: 'Replay a log',
  live: 'Live car',
} as const;

export const BLUETOOTH_MISSING =
  'This browser has no Web Bluetooth. Chrome or Edge on Android, Windows, macOS or ChromeOS can connect; iPhone cannot.';

export const REPLAY_HINT = 'Drop in an Open Gauge log (JSON or CSV with an rpm column), or play the invented demo drive.';

export const NOT_A_DRIVING_AID =
  'Entertainment software, not a driving aid. Set it up parked, then leave the phone alone. Obey the road.';
