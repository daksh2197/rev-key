/**
 * The wiring. Every frame: take revs, throttle and speed from the chosen source, run them through
 * the core (key lock, lanes, shift detector), then paint the screen and steer the rig.
 * Nothing in here decides anything about music or cars; it carries numbers.
 */

import './styles/fonts.css';
import './styles/brand.css';
import './styles/app.css';

import { Rig, LOOKAHEAD_S } from './audio/rig';
import { DEFAULT_ENGINE, ENGINES, type EngineSpec, engineById, engineNote } from './core/engine';
import * as fmt from './core/format';
import { DEFAULT_LOCK, KeyLock } from './core/keylock';
import { mixLanes, type Place } from './core/lanes';
import type { Sample } from './core/log';
import { makeDemoDrive } from './core/demo';
import { fromDrive, readReplay, type Replay } from './core/replay';
import { DEFAULT_SHIFT, ShiftDetector } from './core/shift';
import { autoDrive, CarSim } from './core/sim';
import { STEP_SECONDS } from './core/patterns';
import * as words from './core/words';
import { BleError, bluetoothAvailable, connectBle } from './obd/ble';
import { Session, type SessionStatus } from './obd/session';
import { Pedals } from './ui/pedal';
import { mountTach, rpmForMidi } from './ui/tach';

type Source = 'sim' | 'replay' | 'live';

interface Settings {
  engine: string;
  place: Place;
  limitKph: number | null;
  delayMs: number;
  cabin: number;
  cap: number;
}

const SETTINGS_KEY = 'rev-key.settings';
const DEFAULTS: Settings = { engine: DEFAULT_ENGINE.id, place: 'highway', limitKph: null, delayMs: 0, cabin: 45, cap: 70 };

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return DEFAULTS;
    const p = JSON.parse(raw) as Partial<Settings>;
    const num = (v: unknown, lo: number, hi: number, d: number): number =>
      typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d;
    return {
      engine: typeof p.engine === 'string' ? engineById(p.engine).id : DEFAULTS.engine,
      place: p.place === 'city' ? 'city' : 'highway',
      limitKph: typeof p.limitKph === 'number' && Number.isFinite(p.limitKph) && p.limitKph > 0 ? Math.min(200, p.limitKph) : null,
      delayMs: num(p.delayMs, 0, 500, 0),
      cabin: num(p.cabin, 0, 100, 45),
      cap: num(p.cap, 0, 100, 70),
    };
  } catch {
    return DEFAULTS;
  }
}

function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    // Private mode or storage full: the app still works for this visit.
  }
}

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id} in index.html`);
  return el as T;
};

/** Live regions only change when their text does, or screen readers repeat themselves. */
function setText(el: HTMLElement, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

function main(): void {
  if (new URLSearchParams(location.search).get('embed') === '1') document.documentElement.dataset.embed = '1';

  const settings = loadSettings();
  let engine: EngineSpec = engineById(settings.engine);

  // ----- core -----
  const lock = new KeyLock({ ...DEFAULT_LOCK, engine });
  const shifts = new ShiftDetector(DEFAULT_SHIFT);
  const rig = new Rig();
  const car = new CarSim(engine);
  const pedals = new Pedals();
  const SONG_ROOT = DEFAULT_LOCK.songRoot;

  // ----- elements -----
  const tach = mountTach($('tach'), engine);
  const startBtn = $<HTMLButtonElement>('btn-start');
  const revKeyBtn = $<HTMLButtonElement>('btn-revkey');
  const rHz = $('r-hz');
  const rNote = $('r-note');
  const rKey = $('r-key');
  const rShift = $('r-shift');
  const laneDot = $('lane-dot');
  const statusLock = $('status-lock');
  const statusLane = $('status-lane');

  const tabs = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
  const panels = { sim: $('panel-sim'), replay: $('panel-replay'), live: $('panel-live') };

  const autoBtn = $<HTMLButtonElement>('btn-auto');
  const pedalNote = $('pedal-note');
  const rpmSlider = $<HTMLInputElement>('rpm');
  const rpmOut = $<HTMLOutputElement>('rpm-out');
  const thrSlider = $<HTMLInputElement>('thr');
  const thrOut = $<HTMLOutputElement>('thr-out');

  const replayHint = $('replay-hint');
  const logFile = $<HTMLInputElement>('log-file');
  const demoLogBtn = $<HTMLButtonElement>('btn-demo-log');
  const transport = $('transport');
  const playBtn = $<HTMLButtonElement>('btn-play');
  const seek = $<HTMLInputElement>('seek');
  const seekOut = $<HTMLOutputElement>('seek-out');
  const replayLabel = $('replay-label');
  const replayMsg = $('replay-msg');

  const connectBtn = $<HTMLButtonElement>('btn-connect');
  const disconnectBtn = $<HTMLButtonElement>('btn-disconnect');
  const liveStatus = $('live-status');

  const engineSel = $<HTMLSelectElement>('engine');
  const placeSel = $<HTMLSelectElement>('place');
  const limitInput = $<HTMLInputElement>('limit');
  const delaySlider = $<HTMLInputElement>('delay');
  const delayOut = $<HTMLOutputElement>('delay-out');
  const delayNote = $('delay-note');
  const cabSlider = $<HTMLInputElement>('cab');
  const cabOut = $<HTMLOutputElement>('cab-out');
  const capSlider = $<HTMLInputElement>('cap');
  const capOut = $<HTMLOutputElement>('cap-out');

  setText(replayHint, words.REPLAY_HINT);
  setText($('safety'), words.NOT_A_DRIVING_AID);
  setText(statusLock, words.START_HINT);

  for (const e of ENGINES) {
    const opt = document.createElement('option');
    opt.value = e.id;
    opt.textContent = e.name;
    engineSel.append(opt);
  }
  engineSel.value = engine.id;
  placeSel.value = settings.place;
  limitInput.value = settings.limitKph === null ? '' : String(settings.limitKph);
  delaySlider.value = String(settings.delayMs);
  cabSlider.value = String(settings.cabin);
  capSlider.value = String(settings.cap);

  // ----- state -----
  let source: Source = 'sim';
  let autoOn = false;
  let autoT0 = 0;
  let manual = { rpm: 800, thr: 0 };
  let smoothRpm = 800;
  let pumpMix = 0;
  let lastFrame = performance.now();
  let pedalDriving = false;

  let replay: Replay | null = null;
  let replayPlaying = false;
  let replayT = 0;

  let session: Session | null = null;
  let live: { rpm: number; thr: number | null; speed: number | null; at: number } | null = null;

  const applyLead = (): void => {
    // The drop needs to be booked this far before the shift: the speaker delay the driver set,
    // the rig's booking window, and up to one eighth note of snapping to the beat.
    shifts.configure({ leadMs: settings.delayMs + LOOKAHEAD_S * 1000 + STEP_SECONDS * 1000 });
    const measured = Math.round(rig.outputLatencySeconds * 1000);
    setText(delayNote, measured > 0 ? `Browser reports ${measured} ms to the speaker. Bluetooth adds more; set what you hear.` : 'Bluetooth speakers usually add 100 to 300 ms. Set what you hear.');
  };
  applyLead();

  const refreshEngine = (): void => {
    engine = engineById(engineSel.value);
    lock.configure({ engine });
    tach.setEngine(engine);
    rpmSlider.max = String(8000);
  };

  // ----- sources -----
  const selectSource = (next: Source): void => {
    source = next;
    for (const t of tabs) {
      const on = t.id === `tab-${next}`;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
    }
    for (const [key, panel] of Object.entries(panels)) panel.hidden = key !== next;
    lock.reset();
    shifts.reset();
    if (next !== 'replay') replayPlaying = false;
    playBtn.setAttribute('aria-pressed', String(replayPlaying));
    playBtn.textContent = replayPlaying ? 'Pause' : 'Play';
  };
  for (const t of tabs) {
    t.addEventListener('click', () => selectSource(t.id.replace('tab-', '') as Source));
    t.addEventListener('keydown', (e) => {
      const i = tabs.indexOf(t);
      const next = e.key === 'ArrowRight' ? tabs[(i + 1) % tabs.length] : e.key === 'ArrowLeft' ? tabs[(i + tabs.length - 1) % tabs.length] : null;
      if (next) {
        e.preventDefault();
        next.focus();
        next.click();
      }
    });
  }

  // Drive it here
  const setAuto = (on: boolean): void => {
    autoOn = on;
    autoBtn.setAttribute('aria-pressed', String(on));
    autoT0 = performance.now();
  };
  autoBtn.addEventListener('click', () => setAuto(!autoOn));
  rpmSlider.addEventListener('input', () => {
    setAuto(false);
    manual.rpm = Number(rpmSlider.value);
  });
  thrSlider.addEventListener('input', () => {
    setAuto(false);
    manual.thr = Number(thrSlider.value);
  });

  // Replay a log
  const loadReplay = (r: Replay, note: string): void => {
    replay = r;
    replayT = 0;
    replayPlaying = false;
    transport.hidden = false;
    setText(replayLabel, r.source === 'demo' ? 'Invented demo drive, not a real car' : r.label);
    setText(replayMsg, note);
    seek.max = String(r.duration);
    seek.value = '0';
    lock.reset();
    shifts.reset();
  };
  logFile.addEventListener('change', () => {
    const file = logFile.files?.[0];
    if (!file) return;
    file
      .text()
      .then((text) => {
        const r = readReplay(text);
        if (!r.ok) {
          setText(replayMsg, r.error);
          return;
        }
        loadReplay(r.replay, `${file.name}: ${r.replay.samples.toLocaleString('en-CA')} rpm readings over ${fmt.clock(r.replay.duration)}.`);
      })
      .catch(() => setText(replayMsg, 'Could not read that file.'));
  });
  demoLogBtn.addEventListener('click', () => {
    const r = fromDrive(makeDemoDrive(1));
    if (r.ok) loadReplay(r.replay, 'An invented drive: pulls, shifts and a long cruise. Not a real car.');
  });
  playBtn.addEventListener('click', () => {
    if (!replay) return;
    replayPlaying = !replayPlaying;
    if (replayPlaying && replayT >= replay.duration) replayT = 0;
    playBtn.setAttribute('aria-pressed', String(replayPlaying));
    playBtn.textContent = replayPlaying ? 'Pause' : 'Play';
  });
  seek.addEventListener('input', () => {
    replayT = Number(seek.value);
    lock.reset();
    shifts.reset();
  });

  // Live car
  connectBtn.hidden = !bluetoothAvailable();
  if (!bluetoothAvailable()) setText(liveStatus, words.BLUETOOTH_MISSING);
  const onSample = (s: Sample): void => {
    if (typeof s.rpm !== 'number') return;
    live = {
      rpm: s.rpm,
      thr: typeof s.throttle_pct === 'number' ? s.throttle_pct : (live?.thr ?? null),
      speed: typeof s.speed_kph === 'number' ? s.speed_kph : (live?.speed ?? null),
      at: performance.now(),
    };
  };
  const onStatus = (status: SessionStatus): void => {
    setText(liveStatus, status.message);
    const open = status.state === 'initialising' || status.state === 'polling';
    connectBtn.hidden = open || !bluetoothAvailable();
    disconnectBtn.hidden = !open;
    if (!open) {
      live = null;
      session = null;
    }
  };
  connectBtn.addEventListener('click', () => {
    connectBtn.disabled = true;
    setText(liveStatus, 'Choose the adapter in the browser’s list.');
    connectBle()
      .then((transport) => {
        session = new Session(transport, { onSample, onStatus, cyclePauseMs: 20 });
        lock.reset();
        shifts.reset();
        void session.start();
      })
      .catch((e: unknown) => {
        const text = e instanceof BleError ? e.message : 'Could not connect.';
        setText(liveStatus, text === 'cancelled' ? 'Cancelled. Not connected.' : text);
      })
      .finally(() => {
        connectBtn.disabled = false;
      });
  });
  disconnectBtn.addEventListener('click', () => session?.stop());

  // ----- settings -----
  const paintSettings = (): void => {
    setText(delayOut, fmt.ms(settings.delayMs));
    setText(cabOut, fmt.percent(settings.cabin));
    setText(capOut, fmt.percent(settings.cap));
  };
  paintSettings();
  const persist = (): void => {
    settings.engine = engineSel.value;
    settings.place = placeSel.value === 'city' ? 'city' : 'highway';
    const lim = Number(limitInput.value);
    settings.limitKph = limitInput.value.trim() !== '' && Number.isFinite(lim) && lim > 0 ? Math.min(200, Math.max(10, Math.round(lim))) : null;
    settings.delayMs = Number(delaySlider.value);
    settings.cabin = Number(cabSlider.value);
    settings.cap = Number(capSlider.value);
    saveSettings(settings);
    paintSettings();
  };
  engineSel.addEventListener('change', () => {
    persist();
    refreshEngine();
  });
  placeSel.addEventListener('change', persist);
  limitInput.addEventListener('input', persist);
  limitInput.addEventListener('change', () => {
    persist();
    // Show what was kept: a limit outside 10 to 200 km/h is clamped, junk is dropped.
    limitInput.value = settings.limitKph === null ? '' : String(settings.limitKph);
  });
  delaySlider.addEventListener('input', () => {
    persist();
    applyLead();
  });
  cabSlider.addEventListener('input', persist);
  capSlider.addEventListener('input', () => {
    persist();
    rig.setCap(settings.cap / 100);
  });

  // ----- start / stop, Rev Key on/off -----
  startBtn.addEventListener('click', () => {
    if (rig.running) {
      void rig.stop();
      startBtn.textContent = 'Start engine and music';
      return;
    }
    rig.setCap(settings.cap / 100);
    void rig.start().then((ok) => {
      if (!ok) {
        setText(statusLock, words.AUDIO_BLOCKED);
        statusLock.dataset.tone = 'warn';
        noticeUntil = performance.now() + 4000;
        return;
      }
      startBtn.textContent = 'Stop';
      applyLead();
      if (source === 'sim' && !pedalDriving && manual.rpm <= 820 && manual.thr === 0) setAuto(true);
      if (source === 'replay' && replay && !replayPlaying) playBtn.click();
    });
  });
  revKeyBtn.addEventListener('click', () => {
    const on = revKeyBtn.getAttribute('aria-pressed') !== 'true';
    revKeyBtn.setAttribute('aria-pressed', String(on));
    revKeyBtn.textContent = on ? 'Rev Key on' : 'Rev Key off';
    lock.setEnabled(on);
  });

  // ----- the frame -----
  let shiftNote = '';
  let shiftNoteUntil = 0;
  /** A notice (like "the browser would not start sound") holds the first line until this time. */
  let noticeUntil = 0;

  const frame = (now: number): void => {
    const dt = Math.min(0.25, Math.max(0, (now - lastFrame) / 1000));
    lastFrame = now;

    let rpm = manual.rpm;
    let thr = manual.thr;
    let speed: number | null = null;

    if (source === 'sim') {
      const p = pedals.read();
      if (p.connected) {
        setText(pedalNote, p.learned === 0 ? `${p.name.slice(0, 40)}: press the throttle once, all the way, so it can learn which pedal is which.` : p.learned === 1 ? 'Throttle learned. Press the brake once to learn it too.' : 'Wheel connected. Pedals drive this car.');
        if (p.throttle > 0.02 || p.brake > 0.02 || pedalDriving) {
          pedalDriving = p.throttle > 0.02 || p.brake > 0.02 || car.state.speedKph > 1;
          if (pedalDriving) {
            setAuto(false);
            const st = car.step(dt, p.throttle, p.brake);
            rpm = st.rpm;
            thr = st.throttlePct;
            speed = st.speedKph;
            manual = { rpm, thr };
          }
        }
      } else {
        pedalDriving = false;
        setText(pedalNote, 'Plug in a USB wheel or gamepad and press the pedal: it drives this car.');
      }
      if (autoOn) {
        const a = autoDrive((now - autoT0) / 1000);
        rpm = a.rpm;
        thr = a.throttlePct;
        manual = { rpm, thr };
      }
      rpmSlider.value = String(Math.round(rpm));
      thrSlider.value = String(Math.round(thr));
      setText(rpmOut, `${fmt.rpm(rpm)} rpm`);
      setText(thrOut, fmt.percent(thr));
    } else if (source === 'replay') {
      if (replay) {
        if (replayPlaying) {
          replayT += dt;
          if (replayT >= replay.duration) {
            replayT = replay.duration;
            replayPlaying = false;
            playBtn.setAttribute('aria-pressed', 'false');
            playBtn.textContent = 'Play';
          }
          seek.value = String(replayT);
        }
        const f = replay.at(replayT);
        rpm = f.rpm;
        thr = f.throttlePct ?? 0;
        speed = f.speedKph;
        setText(seekOut, `${fmt.clock(replayT)} / ${fmt.clock(replay.duration)}`);
      } else {
        rpm = 0;
        thr = 0;
      }
    } else {
      if (live && now - live.at < 3000) {
        rpm = live.rpm;
        thr = live.thr ?? 0;
        speed = live.speed;
      } else {
        rpm = 0;
        thr = 0;
      }
    }

    // One smoothing step for the needle and the engine sound; the core gets the real value.
    smoothRpm += (rpm - smoothRpm) * Math.min(1, dt * 15);
    const note = engineNote(rpm, engine);
    const lockState = lock.update({ t: now, rpm });
    const lane = mixLanes({ rpm, throttlePct: thr, place: settings.place, speedKph: speed, limitKph: settings.limitKph, engine });
    const event = shifts.push({ t: now, rpm, throttlePct: thr });
    if (event) {
      rig.drop(event.kind === 'predicted' ? Math.max(0, event.inMs - settings.delayMs) / 1000 : 0);
      shiftNote = words.shiftLine(event);
      shiftNoteUntil = now + 1500;
    }

    pumpMix += (lane.pump - pumpMix) * Math.min(1, dt * 4);
    rig.setMix(pumpMix);
    rig.setVolumeFraction(lane.volume);
    rig.setRoot(SONG_ROOT + lockState.shift);
    rig.setEngine({ hz: engineNote(smoothRpm, engine).hz, throttle: thr / 100, level: settings.cabin / 100 });

    // The marker: where the song's root sounds on this engine, in the octave nearest the revs.
    const shiftedRoot = SONG_ROOT + lockState.shift;
    let rootRpm = rpmForMidi(shiftedRoot, engine);
    if (rpm >= lock.settings.minRpm && Number.isFinite(note.midi)) {
      const octave = Math.round((note.midi - shiftedRoot) / 12);
      rootRpm = rpmForMidi(shiftedRoot + 12 * octave, engine);
    }
    tach.set({
      rpm: smoothRpm,
      rootRpm: rootRpm > 0 && rootRpm <= 8000 ? rootRpm : null,
      locked: lockState.phase === 'locked',
      description: `Rev counter at ${fmt.rpm(rpm)} rpm. ${words.lockLine(lockState, note)}`,
    });

    setText(rHz, fmt.hz(note.hz));
    setText(rNote, note.name === '' ? '—' : note.cents === 0 ? note.name : `${note.name} ${note.cents > 0 ? '+' : '−'}${Math.abs(note.cents)}¢`);
    setText(rKey, words.keyName(SONG_ROOT, lockState.shift));
    setText(rShift, fmt.semitones(lockState.shift));
    laneDot.style.left = `calc(${(pumpMix * 100).toFixed(1)}% - 2px)`;

    // The lock and the lanes are visible without sound, so the lines update as soon as the revs
    // move. Until then, the first line tells a new visitor what to do.
    const moving = rig.running || lockState.phase !== 'idle' || source !== 'sim';
    if (now >= noticeUntil) {
      setText(statusLock, moving ? words.lockLine(lockState, note) : words.START_HINT);
      statusLock.dataset.tone = lockState.phase === 'locked' ? 'go' : '';
    }
    const laneText = now < shiftNoteUntil ? shiftNote : words.laneLine(lane);
    setText(statusLane, moving ? laneText : '');
    statusLane.dataset.tone = lane.counterSteer ? 'warn' : now < shiftNoteUntil ? 'go' : '';

    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);

  // ----- installable and offline, in production only -----
  if (import.meta.env.PROD && 'serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => undefined);
  }
}

main();
