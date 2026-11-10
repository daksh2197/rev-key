# The math

Everything the app decides, with the formula, a worked example and the test that checks it. Each example below is also an `it(...)` in `src/core/*.test.ts`; if the two ever disagree, the test is right and this page is wrong.

## 1. The engine as a note

A four-stroke engine fires each cylinder once every two crankshaft turns. So the number of firings per second, the strongest tone in the exhaust and intake note, is

```
firing Hz = RPM / 60 × cylinders / 2
```

For a V6 that is `RPM / 20`. A four is `RPM / 30`, a V8 `RPM / 15`. (A two-stroke fires every turn, so the `/ 2` goes away. The app carries the stroke count but ships only four-stroke presets.)

Frequency becomes a note number the way MIDI does it: 69 is A4 at 440 Hz, and every semitone is a twelfth of a doubling.

```
note = 69 + 12 × log2(Hz / 440)
```

The number is allowed to be fractional. 44.6 is forty cents below A2. Names use the convention where 60 is C4 (middle C), so 45 is A2 and 27 is D#1.

| RPM (V6) | Firing Hz | Note number | Name |
| ---: | ---: | ---: | --- |
| 800 | 40.0 | 27.49 | D#1 (49 cents sharp) |
| 2,150 | 107.5 | 44.60 | A2 (40 cents flat) |
| 2,200 | 110.0 | 45.00 | A2 |
| 2,330 | 116.5 | 45.99 | A#2 |
| 2,620 | 131.0 | 48.03 | C3 |
| 4,400 | 220.0 | 57.00 | A3 |

Where: `firingHz`, `midiFromHz`, `noteName`, `centsOff` in `src/core/engine.ts`. Tests: "a four-stroke V6 fires three times per revolution", "40 Hz is a D#1 a hair sharp", and a property that frequency and note number undo each other for any frequency from 20 Hz to 20 kHz.

## 2. The key lock

The song has a root. The demo's is A, note 45. The lock asks: what is the smallest move that puts the engine's note on the song's root or on its fifth (seven semitones up)?

```
for target in [root, fifth]:
    raw   = engineNote − (songRoot + (target is fifth ? 7 : 0))
    shift = raw wrapped into (−6, +6]          # the short way round the octave
keep the target with the smallest |shift|
refuse it if |shift| > 2
```

Wrapping is what makes an A at any octave count as the root: a difference of 12, 24 or 36 wraps to 0. In fine mode (the default) the fraction is kept, so the drone sits exactly on the root. In whole-semitone mode the raw difference is rounded first.

| Engine note | Root at 45 | Fifth at 52 | Chosen | Shift |
| --- | ---: | ---: | --- | ---: |
| 45 (A2) | 0 | −7 → 5 | root | 0 |
| 46 (A#2) | +1 | +6 | root | +1 |
| 51 (D#3) | +6 | −1 | fifth | −1 |
| 52 (E3) | −5 | 0 | fifth | 0 |
| 48.5 | +3.5 | −3.5 | neither | out of reach |

Then the three rules on top of the arithmetic:

1. **Steady first.** The last `steadyMs` (1,000 ms) of samples must all sit inside `steadyBandRpm` (80 rpm), and the current sample must be above `minRpm` (1,200). A climb through a note never locks.
2. **Hold through wobble.** Once locked, the lock survives while the revs stay within `releaseBandRpm` (120) of the RPM it engaged at, re-aiming the fine shift at each sample so the drone stays dead on the root. If a wobble carries the note a hair past the two-semitone limit, the last shift is kept rather than dropped, so the song never jumps back and forth at the edge.
3. **Let go cleanly.** Outside that band the lock drops to `waiting`, the shift returns to 0, and the song glides home.

Where: `bestShift`, `KeyLock` in `src/core/keylock.ts`. Tests: every row above, "a pull through the revs never locks", "holds the lock through small wobble, then lets go on a real change", and a property over 200 random samples that the shift never exceeds the limit and is 0 whenever the phase is not `locked`.

## 3. Two lanes and counter-steer

How hard the car is being driven, 0 to 1:

```
intensity = 0.6 × (RPM − idle) / (redline − idle) + 0.4 × throttle / 100
```

clamped at both ends. Then the rules, in order:

```
counter-steer  if (city and (throttle > 60% or RPM > 70% of redline))
               or (speed > posted limit, anywhere)
               → pump = 0, volume = 60% of the cap
city           → pump = min(intensity, 0.35), volume = cap
highway        → pump = intensity, volume = cap; "calm" below 0.25, "pull" above
```

The two lanes are crossfaded with equal power: calm gain `cos(pump × π/2)`, pump gain `sin(pump × π/2)`, so the loudness stays level through the fade (the two gains squared always sum to 1).

Where: `intensity`, `mixLanes`, `laneGains` in `src/core/lanes.ts`. Tests: each rule by example, and a property that for any input the volume is never above 1, the pump share stays in 0..1, and counter-steer always means pump = 0.

## 4. Seeing and foreseeing a gear change

**Seeing.** Inside the last `windowMs` (350 ms), if the highest RPM minus the current RPM is at least `dropRpm` (900) and the throttle is at least `minThrottlePct` (35%), that is an upshift. Lifting off the throttle also drops the revs, hence the throttle condition. The RPM the drop started from is remembered; the median of the last eight is where this driver shifts.

**Foreseeing.** Sound booked now reaches the speaker later: the browser's own buffer (a few milliseconds to tens of milliseconds, which it reports), the app's 120 ms booking window, and a Bluetooth speaker's delay (typically 100 to 300 ms, which nothing reports, so the driver sets it). Call the sum the lead. While the revs climb under throttle:

```
slope      = least-squares slope of RPM against time over the window   (rpm per second)
time to go = (shiftRPM − RPM) / slope
fire a "predicted" event once when 0 < time to go ≤ lead
```

The app then books the drop `time to go − speaker delay` seconds ahead, snapped to the next eighth note, so it leaves the speaker as the revs fall. Example from the test: 3,000 to 6,000 rpm over 1.5 s is 2,000 rpm/s; with the default shift point at 5,800 and a 250 ms lead, the event fires about 250 ms before 5,800 rpm, which the climb reaches at 1,400 ms.

Three guards: after an event the detector ignores the next `cooldownMs` (900) so one shift cannot fire twice; a prediction disarms until the revs stop climbing, so a slow climb cannot keep re-predicting; and a fall is learned from once, at its peak, with nothing more learned until the revs climb again, so a drop sampled sixty times a second does not teach sixty shift points. A shift seen during a cooldown is still learned from, so a predicted shift still teaches the detector where the driver shifts.

Where: `ShiftDetector`, `slopeRpmPerSecond`, `median` in `src/core/shift.ts`. Tests: "a 1,000 rpm fall under throttle is an upshift", "the same fall with the foot off is lifting", "with a 250 ms lead it predicts once", "a prediction silences the seen event for that shift, but the shift is still learned", and a property that random samples never produce a NaN or out-of-range event.

## 5. Booking sound ahead of time

The band runs on a sixteenth-note grid at 140 bpm: one step every 107.14 ms. Every 25 ms the rig asks one pure function which steps start inside the next 120 ms of audio-clock time:

```
while cursor.nextTime < now + lookahead:
    due ← cursor
    cursor ← (nextTime + stepSeconds, step + 1)
```

and books every note of those steps with the AudioContext at their exact times. If the cursor has fallen more than a second behind (the tab slept), it jumps to now rather than replaying the gap. A guard caps one call at 1,000 steps.

Where: `stepsDue` in `src/core/patterns.ts`, used by `Rig.tick` in `src/audio/rig.ts`. Tests: the three cases above and a property that no step is ever booked outside the window.

## 6. What is not here

- **Pitch-shifting real recordings.** The two beats are synthesized from the patterns in `patterns.ts`, so changing key is changing one number. A recorded song needs each stem time-stretched and pitch-shifted separately, which is a different and much larger piece of work.
- **Notes below hearing.** Under 16 Hz (320 rpm on the V6) the screen shows no note name; the arithmetic still runs.
- **The exact cruise RPM of any car.** The app never guesses it; it reads it, from a slider, a log or the car.
- **Engine order content.** A real engine's note has strong components at half and twice the firing frequency. The demo's engine sound includes the half order; the lock uses the firing frequency alone, because that is what the ear follows at cruise.
