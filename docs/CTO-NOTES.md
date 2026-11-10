# CTO notes

You don't have to write this code. You have to be able to do three things with it:

1. **Explain it** to an interviewer, a partner or a customer.
2. **Find a bug** in it when a note or a beat is wrong.
3. **Know what to ask for** when you want it changed.

This page gets you there. Read sections 1 and 2 once (about 20 minutes). Keep section 4 for the day something breaks. Do section 5 with your own hands, because that is where it sticks.

## 1. The whole app in one picture

```
   a source            the brain                   the rig              the screen
 ┌───────────┐     ┌──────────────────┐     ┌────────────────┐     ┌─────────────┐
 │ sliders   │     │ engine.ts  note  │     │ two lane buses │     │ rev counter │
 │ auto drive│ ──> │ keylock.ts shift │ ──> │ engine drone   │     │ readouts    │
 │ wheel     │ rpm │ lanes.ts   mix   │     │ drop           │     │ lane bar    │
 │ log file  │ thr │ shift.ts   drop  │ ──> │ scheduler      │     │ two lines   │
 │ live car  │     └──────────────────┘     └────────────────┘     └─────────────┘
 └───────────┘              ^  main.ts, once per frame, carries numbers left to right
```

There is no server. The page is a handful of files that GitHub hands to the browser, and then the browser does everything, including talking to the car.

- **The brain** (`src/core/`) only knows numbers and sentences. It has never heard of a speaker, a button or Bluetooth.
- **The rig** (`src/audio/`) only knows how to make sound at a given time.
- **The adapter** (`src/obd/`) only knows how to talk ELM327 over a transport.
- **The screen** (`index.html`, `src/ui/`, `src/styles/`) only knows how to look.
- **The wiring** (`src/main.ts`) runs once per frame and carries numbers from one to the next.

Keeping these apart is the most important decision in the repo. A wrong note can only come from the brain or the wiring. A late beat can only come from the rig. A dropped connection can only come from the adapter. Each is tested on its own.

## 2. Seven ideas this repo teaches

The first one is new in this build; the rest carry over from the earlier repos and are here so you can say them out loud.

### Book sound ahead of time (the new one)

JavaScript on a web page runs one thing at a time. If the code that plays a drum hit runs late because the page was busy drawing, the hit is late. You cannot hear a late drum hit as "late"; you hear it as wrong.

So the rig never plays a note when its timer fires. Every 25 ms it looks 120 ms into the future on the audio clock, finds the sixteenth notes that start in that window, and books their sounds with the browser at exact times. The browser's audio thread plays them whatever the page is doing. The one decision ("which steps fall inside the window?") is a pure function, `stepsDue`, with its own tests.

The same idea runs the shift drop. Sound takes time to reach a Bluetooth speaker. If you book the drop when you see the shift, it lands late. So the detector predicts the shift from the slope of the revs and books the drop early by the speaker's delay. Predicting the future to hide latency is how games, video calls and racing telemetry all work.

- **See it:** [`src/core/patterns.ts`](../src/core/patterns.ts) (`stepsDue`), [`src/audio/rig.ts`](../src/audio/rig.ts) (`tick`), [`src/core/shift.ts`](../src/core/shift.ts) (`push`).
- **Say it:** "Audio is scheduled 120 ms ahead on the audio clock, so a slow frame can't bend the beat. The drop is predicted from the RPM slope and booked early by the speaker delay the driver set."

### Pure functions

A pure function gets numbers in and gives numbers out, and does nothing else. Same input, same answer, every time.

- **See it:** `firingHz`, `bestShift`, `mixLanes`, `slopeRpmPerSecond`, `autoDrive`, `stepsDue`. All of `src/core/`.
- **Say it:** "All the decisions are pure functions, so I can test every edge case in milliseconds and the screen and the speaker can't corrupt the logic."

### State machines

The key lock is in one of five phases (`off`, `idle`, `waiting`, `out-of-reach`, `locked`) and moves between them by rules. Draw the five boxes and the arrows and you have the design.

- **See it:** `KeyLock.update` in [`src/core/keylock.ts`](../src/core/keylock.ts). The `LockPhase` type lists the boxes; each `return` is an arrow.
- **Say it:** "The lock is a small state machine with hysteresis: it needs a steady second to engage and a real change to release, so it neither flickers nor sticks."

### Property tests

Most tests check one hand-picked example. A property test invents hundreds of random inputs and checks a rule that must hold for all of them: the shift never exceeds the limit; the volume never goes above the cap; the car sim never produces a negative number. `fast-check` does the inventing and, when a rule fails, shrinks the input to the smallest case that breaks it.

- **See it:** any test with `fc.assert(fc.property(...))`. Every core module with a rule that must hold for all inputs has one.
- **Run it:** `npm test`.
- **Say it:** "Example tests prove the cases I thought of. The property tests cover the ones I didn't."

### Ports and adapters

The core never calls Bluetooth. The adapter session speaks to a `Transport` interface with three methods (`send`, `onLine`, `close`). Web Bluetooth is one implementation; a scripted fake that plays back a recorded drive is another. The tests use the fake, the car uses the real one, the session code is identical.

- **See it:** `Transport` in [`src/obd/session.ts`](../src/obd/session.ts), `connectBle` in `ble.ts`, `ScriptedTransport` in `fake.ts`.
- **Say it:** "The OBD session only knows a three-method transport, so I can run a whole drive through it in a test without a car."

### Learning instead of configuring

Every racing wheel puts its pedals on different axes, resting at +1 on some and −1 on others. Rather than ship a table of wheels, `Pedals` watches: the first readings are rest, the furthest travel is full, the first pedal to move is the throttle. The shift detector does the same with the shift point: it starts with a default and replaces it with the median of the shifts it has seen.

- **See it:** [`src/ui/pedal.ts`](../src/ui/pedal.ts), `pedalValue` in `sim.ts`, `shiftRpm` in `shift.ts`.
- **Say it:** "Nothing about the wheel or the driver is configured; both are learned from the first few seconds."

### Reading hardware from a web page

Web Bluetooth, the Gamepad API and Web Audio are all built into the browser. The app connects to a car's OBD-II adapter, reads a racing wheel and synthesizes music with nothing installed.

- **See it:** `connectBle` in [`src/obd/ble.ts`](../src/obd/ble.ts), `navigator.getGamepads` in `pedal.ts`, `new AudioContext` in `rig.ts`.
- **Say it:** "No app store and no driver. The browser already has the radio, the gamepad and the synth; the page just uses them, and only ever reads from the car."

## 3. Where things live

| You want to change... | Open this |
| --- | --- |
| The firing-frequency formula, or add an engine | `src/core/engine.ts` (`ENGINES`) |
| How steady is steady, the shift limit, root or fifth | `DEFAULT_LOCK` in `src/core/keylock.ts` |
| The city cap, the counter-steer rule, the calm threshold | the constants at the top of `src/core/lanes.ts` |
| How a shift is spotted, how far ahead it predicts | `DEFAULT_SHIFT` in `src/core/shift.ts` |
| The two beats, the tempo, the drop | `src/core/patterns.ts` |
| How an instrument sounds | `src/audio/voices.ts` |
| The limiter, the buses, the engine drone | `src/audio/rig.ts` |
| Anything the app says | `src/core/words.ts` |
| How the dial is drawn | `src/ui/tach.ts` |
| The auto-drive script, the car sim's gearbox | `src/core/sim.ts` |
| Which log files load | `src/core/replay.ts` (and `log.ts`, `csv.ts`) |
| The boxes on the page | `index.html` |
| A colour or a font | `src/styles/brand.css` |
| Layout and spacing | `src/styles/app.css` |
| What happens on deploy | `.github/workflows/ship.yml` |

## 4. When something breaks

| What you see | Likely cause | Where to look | How to check |
| --- | --- | --- | --- |
| No sound after Start | The browser refused to start audio, or the tab is muted | The first status line says so for four seconds | Press Start again from a real click. Check the tab's mute icon. On iPhone, check the silent switch. |
| The note reads wrong for my car | Wrong cylinder count, or a two-stroke | Engine menu; `ENGINES` in `engine.ts` | Rev to 3,000 and compare: a four should read 100 Hz, a V6 150, a V8 200. Write the RPM and the expected Hz as a test in `engine.test.ts`. |
| It never locks at cruise | The revs are wobbling more than 80 rpm, or cruise is under 1,200 rpm | `DEFAULT_LOCK` in `keylock.ts`; the "Steadying" line shows how far it got | Load the drive as a log and replay it. If the lock never engages, widen `steadyBandRpm` by 20 and see if the tests still agree. |
| The song keeps its key and says out of reach | The drone sits between the root and the fifth | Normal: more than two semitones is a wrong-sounding song | Change `maxShift` to 3 to hear why the limit exists. |
| The drop lands after the shift | Speaker delay not set, or set too low | Settings, Speaker delay | Raise it by 50 ms steps until the drop and the shift agree. If it then fires too early on slow pulls, lower `windowMs` in `shift.ts`. |
| The beat stutters | Something heavier than this page is hogging the main thread | `LOOKAHEAD_S` in `rig.ts` | Raise it to 0.2. The cost: notes are booked earlier, so a key shift or a drop reaches the speaker that much later. |
| "No Web Bluetooth" | Safari, Firefox, or an iPhone | Browser | Chrome or Edge on Android, Windows, macOS or ChromeOS. |
| The adapter won't answer | Wrong service UUID on a clone, or no power | `CANDIDATE_SERVICES` in `obd/ble.ts`; the status line | Check the adapter's light first. A clone with an unusual UUID needs it added to `CANDIDATE_SERVICES`; the list is the one Open Gauge uses. |
| The wheel does nothing | Pedals not yet learned, or the pedals sit on axes 0 or 1 | The pedal note under the sliders says what to do; `pedal.ts` skips axes 0 and 1 (steering) | Press the throttle all the way once, then the brake once. If nothing is learned, the wheel reports its pedals on the steering axes: open an issue with the wheel's name. |
| Red X on a commit | A test or the build failed in CI | GitHub, Actions tab | The log names the failing test. Nothing was deployed. |

**The one debugging habit that matters:** reproduce it as a test first. Record the drive as a log, load it into a test, assert what the lock or the detector should have done. A bug you can trigger with a test is a bug you can fix once and keep fixed.

## 5. Your turn

Five real changes, easiest first. Each one is a commit with your name on it. You can do all of them in the browser: open the repo on GitHub and press the `.` key for an editor. Commit from the Source Control panel; the robot tests and deploys it.

1. **Change a sentence.** In `src/core/words.ts`, reword the counter-steer line in your own voice. *Done when:* `npm test` still passes (one test only checks that every lane has a sentence) and the live site says it.
2. **Add an engine.** In `src/core/engine.ts`, add a flat-six: `{ id: 'f6', name: 'Flat six, four-stroke', cylinders: 6, strokes: 4, idleRpm: 700, redlineRpm: 7500 }`. *Done when:* it appears in the Engine menu and the note ring redraws with the higher redline.
3. **Change a rule.** Set `CITY_PUMP_CAP` in `lanes.ts` to `0.5` and push. *Done when:* CI goes red, because `lanes.test.ts` pins the cap to the number 0.35 on purpose. Read the log, then decide: change it back, or update the test and the line in `docs/THE-MATH.md` that states 35%. The red X is the safety net doing its job.
4. **Write a test.** Hold a cruise in your own car, note the RPM, and add an `it(...)` to `keylock.test.ts` that feeds that RPM for 1.1 s and asserts the shift you expect. *Done when:* it passes, or it fails and you learn something about your engine.
5. **Add a lane.** A third lane, "night", that takes over after a time you set. It touches every layer: a pattern in `patterns.ts`, a bus in `rig.ts`, a rule in `lanes.ts` (`pump` becomes a position across three lanes), and the bar in `index.html` and `app.css`. The build refuses to pass until every one of them agrees, which is the type checker being your checklist. Talk this one through with Claude; ask it to explain each change before you accept it.

## 6. Questions you should be ready for

**Why no React?**
One screen, a dial and a dozen controls. React alone is several times the size of this app's JavaScript (18 kB compressed). The structure a framework gives you, logic separate from view, is here anyway, done by hand.

**How do you know the note is right?**
Three ways. Worked examples checked by hand: 2,200 rpm on a V6 is 110 Hz is A2. Edge cases for every engine preset and for junk input. And property tests that the frequency and note number undo each other for any frequency, and that the lock never shifts further than its limit for any drive.

**Why does the drop need prediction?**
Because sound booked now leaves a Bluetooth speaker up to a third of a second later. The detector learns where the driver shifts, fits a line through the last third of a second of revs, and books the drop when the line says the shift is one lead-time away.

**What happens with no signal?**
The service worker saved every file on the first visit. The page is fetched fresh when there is a connection and falls back to the saved copy when there isn't. The car talks over Bluetooth, not the internet.

**Is it safe to use while driving?**
It reads from the car and never writes. There is no screen to touch while moving: you set it up parked. The volume cap is yours and the app can only lower it. It is entertainment software, not a driving aid, and the page says so.

**What did the AI do, and what did you do?**
Say it straight: Claude wrote most of the code as a pair programmer. You chose the problem, made the product decisions, reviewed the changes and can walk through any file. Then walk through one.

## 7. Words you'll hear

| Word | Plain meaning |
| --- | --- |
| Firing frequency | How many times per second the engine's cylinders fire; the main note it makes |
| MIDI note number | A count of semitones where 69 is A4 (440 Hz); fractions are allowed |
| Cents | Hundredths of a semitone |
| Root, fifth | The home note of a key, and the note seven semitones above it |
| Semitone | The smallest step on a piano; twelve to an octave |
| Hysteresis | Needing a bigger change to leave a state than to enter it, so things don't flicker |
| Look-ahead scheduling | Booking sounds a little into the future so they play on time |
| Latency | The delay between asking for a sound and hearing it |
| OBD-II, PID | The car's diagnostic port, and the numbered values it can be asked for |
| ELM327 | The chip family inside most cheap OBD-II Bluetooth adapters |
| Transport | A small interface for "send text, receive text"; what the session talks to |
| Property test | A test that checks a rule on hundreds of invented inputs |
| PWA | A website that can be installed and work offline like an app |
