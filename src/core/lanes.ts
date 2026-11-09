/**
 * Two lanes of music and a rule for mixing them.
 *
 * The calm lane plays at idle and cruise. The pump lane comes in as the revs and the throttle
 * rise. That much every "music reacts to driving" system does. The twist here is the opposite
 * of the usual one, and it is called counter-steer:
 *
 *   hard driving where it does not belong (in the city, or over the speed limit) sends the
 *   mix back to the calm lane and lowers the volume.
 *
 * The music rewards smooth driving. The pump lane only fully opens at a steady, legal highway
 * pull. Volume can only ever go down from the cap the driver set; nothing in here raises it.
 */

import { type EngineSpec, DEFAULT_ENGINE } from './engine';

export type Place = 'highway' | 'city';

export interface LaneInput {
  rpm: number;
  /** 0 to 100. */
  throttlePct: number;
  place: Place;
  /** Vehicle speed, when the source reports it. */
  speedKph?: number | null;
  /** The posted limit the driver typed, when they did. */
  limitKph?: number | null;
  engine?: EngineSpec;
}

export type LaneReason =
  /** Low revs, light throttle. */
  | 'calm'
  /** Revs and throttle up on the highway: the pump lane opens with them. */
  | 'pull'
  /** City driving: the pump lane is held to a third of the way. */
  | 'city-cap'
  /** Hard inputs in the city, or over the limit anywhere: calm lane, volume down. */
  | 'counter-steer';

export interface LaneOutput {
  /** 0 = all calm lane, 1 = all pump lane. */
  pump: number;
  counterSteer: boolean;
  /** Fraction of the driver's volume cap to play at. Never above 1. */
  volume: number;
  reason: LaneReason;
  /** How hard the car is being driven, 0 to 1, before any rule is applied. */
  intensity: number;
}

/** The pump lane never opens further than this in the city. */
export const CITY_PUMP_CAP = 0.35;
/** Throttle above this in the city counts as hard driving. */
export const CITY_THROTTLE_LIMIT = 60;
/** This share of the redline in the city counts as hard driving. */
export const CITY_REDLINE_SHARE = 0.7;
/** Below this intensity a highway drive is called calm (a 2,200 rpm cruise with a light foot). */
export const CALM_BELOW = 0.25;
/** Counter-steer plays at this fraction of the driver's cap. */
export const COUNTER_STEER_VOLUME = 0.6;

const clamp01 = (v: number): number => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);

/** How hard the car is being driven: 60% revs, 40% throttle. */
export function intensity(rpm: number, throttlePct: number, engine: EngineSpec = DEFAULT_ENGINE): number {
  const revs = clamp01((rpm - engine.idleRpm) / (engine.redlineRpm - engine.idleRpm));
  const thr = clamp01(throttlePct / 100);
  return clamp01(revs * 0.6 + thr * 0.4);
}

export function overLimit(speedKph?: number | null, limitKph?: number | null): boolean {
  if (typeof speedKph !== 'number' || typeof limitKph !== 'number') return false;
  if (!Number.isFinite(speedKph) || !Number.isFinite(limitKph) || limitKph <= 0) return false;
  return speedKph > limitKph;
}

export function mixLanes(input: LaneInput): LaneOutput {
  const engine = input.engine ?? DEFAULT_ENGINE;
  const rpm = Number.isFinite(input.rpm) ? Math.max(0, input.rpm) : 0;
  const thr = clamp01(input.throttlePct / 100) * 100;
  const level = intensity(rpm, thr, engine);

  const hardInCity = input.place === 'city' && (thr > CITY_THROTTLE_LIMIT || rpm > engine.redlineRpm * CITY_REDLINE_SHARE);
  if (hardInCity || overLimit(input.speedKph, input.limitKph)) {
    return { pump: 0, counterSteer: true, volume: COUNTER_STEER_VOLUME, reason: 'counter-steer', intensity: level };
  }
  if (input.place === 'city') {
    return { pump: Math.min(level, CITY_PUMP_CAP), counterSteer: false, volume: 1, reason: 'city-cap', intensity: level };
  }
  return { pump: level, counterSteer: false, volume: 1, reason: level < CALM_BELOW ? 'calm' : 'pull', intensity: level };
}

/** Equal-power crossfade: the two lane gains for a mix position. Both between 0 and 1. */
export function laneGains(pump: number): { calm: number; pump: number } {
  const p = clamp01(pump);
  return { calm: Math.cos((p * Math.PI) / 2), pump: Math.sin((p * Math.PI) / 2) };
}
