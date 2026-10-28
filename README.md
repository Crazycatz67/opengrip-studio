# OpenGrip Studio: Recorder

The software half of the club's data apparatus. A forearm band with FSR force sensors (FMG)
and/or EMG sensors goes into an Arduino, the Arduino streams over USB, and the Recorder turns
that into **clean, labelled recordings** with a quality report, ready for later ML work.

- **Plug and play.** It works with the club's existing Arduino as it is, including a bare
  `Serial.println(analogRead(A0))` at 9600 baud, so you don't need to reflash it. It finds
  the baud rate, the line format, the channel count and the sample rate by itself.
- **Guided sessions.** It starts with a per-fitting calibration (5 s relaxed, then 3 firm but
  comfortable squeezes). Grips are then recorded in 3 arm positions, plus an "elbow bend only"
  distractor. Every sample is labelled `gesture@position`, e.g. `grip@elbow90`.
- **Quality checks.** These cover rest noise, bursts, fade across repeats, dropouts,
  saturation, contact spikes, the arm-position effect and band shift. Each item is shown as
  green, amber or red in plain words.
- **It never loses data.** Recordings are autosaved to the browser (IndexedDB) while you
  record. If the board is unplugged, what you have so far is kept, and the board reconnects
  and carries on when it comes back. After a page reload the last session can be recovered.
- **Private.** It is a static site with no build step and makes no network requests. It uses
  no camera, no microphone and no analytics.

> Status (2026-10-20): the engine (`src/`), the Node tests, the browser engine test and the
> CLI replay are done. The recording UI (`index.html`, `src/ui/`) is being designed and is
> not in this repo yet.

## Running it

Web Serial only works in **Chrome or Edge on a desktop** (Windows, macOS, Linux or ChromeOS).
Firefox, Safari and phones don't have it. It also needs a secure context, which means
**localhost or https**. Opening the file directly (`file://`) does not work.

```sh
python3 -m http.server 8000      # from the repo root (or: npm run serve)
# open http://localhost:8000 in Chrome or Edge
```

Everything runs offline once the page has loaded. You can serve it from any static https
host as well.

### Tests

| Command | What it runs | Time |
|---|---|---|
| `npm test` / `npm run gate` | the Node suite: parsing, format/baud/rate detection, quality, protocol, CSV, autosave, fake and mock-Arduino end to end, no-network scan | ~6 s |
| `npm run gate:browser` | `test/browser/engine.html` in headless Chrome. A mock `navigator.serial` replays the synthetic legacy fixtures byte by byte through connect → detect → guided record → unplug → reconnect → save to real IndexedDB → recover | ~30 s |
| `node tools/replay.mjs <file> [--rate HZ] [--json]` | prints what the app would detect and report for a log file | instant |

The browser gate starts its own server on a free port and stops it afterwards. Chrome runs
with fake media devices and no audio, and the temporary profile is deleted at the end. You
can also open `/test/browser/engine.html` by hand from any localhost server to get a
pass/fail page.

If you change `test/fixtures/`, regenerate it with `node tools/make-synthetic-fixtures.mjs`, then
the browser copy with `node tools/make-browser-fixtures.mjs`. A test fails if you forget.

## CSV format

```
# opengrip_studio v0.1.0
# person_id=P03                       an ID code, never a name
# sensors=FMG,FMG,FMG,FMG,EMG,EMG     one per channel: FMG | EMG | both | unknown
# placement=right forearm, 3 cm below elbow crease
# tightness=snug, one finger fits under
# notes=free text on one line
# rate_hz=100
# app_version=0.1.0
# started_at=2026-10-21T15:04:05.000Z
# cal_rest=...  cal_squeeze=...        per-channel calibration levels
# marker t_ms=12345 note=button
t_ms,a0,a1,a2,a3,a4,a5,label
0,12,8,15,9,11,10,cal_rest
10,13,8,14,9,12,10,cal_rest
```

- `t_ms` is the device's `millis()` if the board sends it, otherwise host time from the start
  of the recording. It keeps increasing across a board reset (unplug and replug).
- Labels look like `gesture` or `gesture@position`. `cal_rest` and `cal_squeeze` are the
  calibration steps.
- Each CSV is saved with a JSON sidecar holding the full quality report.

### Input formats it reads

It accepts all of the following, with or without serial-open garbage and with cut-off lines:

- one number per line (the club's old logs)
- numbers separated by commas, tabs or spaces
- Arduino Serial Plotter style (`a:12 b:34` or `thumb:12,index:34`)
- `A0: 123` text
- `t_ms,ch1,...[,label]`, with or without the `# nxt_logger` header

It tries these baud rates in order: 115200, 9600, 57600, 38400, 230400. The last good rate is
tried first next time.

## Arduino: `arduino/nxt_logger/nxt_logger.ino`

This sketch is optional, because the Recorder reads old sketches too. It adds timestamps, all
channels and a marker button. By default it reads pins A0-A5 (the Uno's 6 analog pins; add
A6/A7 on a Mega or Nano), samples at 200 Hz using a `micros()` schedule, and talks at 115200
baud. It prints the header `# nxt_logger v1 channels=6 rate_hz=200` and then `t_ms,a0,...,a5`.
An optional button pin (to GND) adds `# marker` lines.
**The sketch has not been compiled yet** (arduino-cli wasn't available). It only uses the
standard Arduino API.

### FSR wiring (one 10k divider per channel)

```
5V ──[ FSR ]──┬── A0
              │
            [10k]
              │
GND ──────────┘
```

Pressing harder gives a higher reading. To choose the resistor, pick one close to the FSR's
resistance at the forces you care about. 10k suits typical grip forces on an FSR 402. If
firm grips sit near 1023, use 4.7k or 3.3k. If strong squeezes only reach about 100-200, use
22k or 47k. Use the same value on every channel and write it in the notes.

### Clone Unos (CH340): no port showing?

Many cheap Uno and Nano clones use a **CH340/CH341** USB chip instead of the original's
ATmega16U2. If Chrome's port picker is empty, or the board doesn't show up at all:

- Install the WCH CH340 driver (Windows, older macOS) from the chip maker WCH.
- Recent macOS and Linux usually include it already.
- Try a different cable: many USB cables only carry power.
- Close the Arduino IDE Serial Monitor/Plotter, because only one program can hold the port.

## Safety (EMG electrodes on skin)

**If electrodes are on skin and the board is powered over USB, unplug the laptop charger.
The laptop must run on battery only while the band is worn.** Never wear electrodes while
the board is connected to a mains-powered desktop, USB hub or charger. FSRs (FMG) don't touch
the skin, but follow the same rule whenever a band mixes FMG and EMG. The Recorder shows
this notice once when you connect.

## Test data

`test/fixtures/` holds six **synthetic** logs made by the digital twin (`src/sim/twin.js`) with
`node tools/make-synthetic-fixtures.mjs` (seeded, so the bytes never change). They copy the club's
old log format (one number per line, junk bytes at the start) and the faults the tests look for:
dropouts with spikes, a spike right after the start, fading bursts. They are test data only,
never evidence that a detector or model works on real arms.

The club's real recordings are **not in this repository**. If you have them, put them in
`test/fixtures-club/` (git-ignored); `test/fixtures-club.test.js` and the twin realism test then
also run on them, and skip when the folder is absent. Do not publish or share them without the
club's OK. Earlier commits of this repository's history still contain them.

## Layout

```
src/        parse, detect, pipeline, quality, protocol, session, csv, sources, store
src/sim/    uart.js (wrong-baud simulator), mockserial.js (mock navigator.serial)
arduino/    nxt_logger sketch
tools/      replay.mjs, browser-gate.mjs, make-browser-fixtures.mjs, make-synthetic-fixtures.mjs
test/       Node tests; test/browser/ engine page
```
