// ui/words.js: every on-screen string of the Recorder UI (spec §15). Copy is exact; change it
// here, not in the screens. Functions take the numbers so units stay in one place.
// One status vocabulary everywhere: Working ✓, Check ▲, Fix ✕, Waiting ○, Checking ◌ (simplify-spec §6).
// The icon next to the word carries the mark; the word is what is written here.

export const STATUS = {
  ok: 'Working',
  check: 'Check',
  fix: 'Fix',
  wait: 'Waiting',
  busy: 'Checking',
  opt: 'Optional',
};

export const SHELL = {
  brand: 'OpenGrip Studio',
  product: 'Recorder',
  screens: { start: 'Start', preflight: 'Connect', record: 'Record', review: 'Save', files: 'Files', scorecard: 'Compare' },
  keysButton: 'Keys',
  keysTitle: 'Keys',
  close: 'Close',
  hcOn: 'High contrast on.',
  hcOff: 'High contrast off.',
  demoChip: 'DEMO SIGNAL · synthetic',
  demoChipShort: 'DEMO',
  arduinoDetecting: 'Arduino · detecting…',
  arduinoChip: (baud, ch, rate) => `Arduino · ${baud} · ${ch} ch · ${rate}`,
  fileChip: (name, more) => `File · ${name}${more ? ` + ${more} more` : ''}`,
};

// Shell navigation (simplify-spec §3.1–3.5, card N1). Guide lines may mark **bold** words.
export const NAV = {
  home: 'Home',
  back: 'Back',
  more: 'More',
  showMe: 'Show me',
  guideLead: 'What do I do now?',
  stepsLabel: 'Session steps',
  steps: [['Connect', 'Connect'], ['Fit the band', 'Fit'], ['Record', 'Record'], ['Save', 'Save']],
  stateWord: { upcoming: 'not yet', current: 'current', done: 'done ✓', skipped: 'skipped', check: 'check ▲', fix: 'fix ✕' },
  stepAria: (n, name, state) => `Step ${n}, ${name}, ${state}`,
  lockedWhy: (prev) => `${prev} first`,
  keys: 'Keys and shortcuts',
  // The 5-part Record progress (N6 draws it). Delilah: the last part was "Elbow bend", one letter
  // from "Elbow bent"; "Bend only" says what Jo does (bend the elbow, hand relaxed).
  parts: ['Getting a baseline', 'Arm down', 'Elbow bent', 'Arm raised', 'Bend only'],
  guide: {
    start: 'Choose how to start. New here? Try **Practice with demo** first.',
    preflight: 'Wait for the ticks. Each line turns to Working ✓ by itself.',
    fit: 'Pick the arm, then ask Jo to press each sensor. Each number should light up.',
    // Kept short: "Start recording" is longer than "Record" and the guide is one line at 600 px (§3.1).
    record: 'Show Jo the screen, then press **Start recording**.',
    review: 'Type a code for Jo (like P03, not a name), then press **Save to this computer**.',
    files: 'Pick a recording to look at. Press **Home** to start again.',
    scorecard: 'Compare the two recordings. Press **Back** to return.',
    glassbox: 'Press **Train** to teach it, then **Watch** it decide. Press **Back** when done.',
  },
};

// Simple vs Advanced and the More menu (simplify-spec §4, §4.1, card N3).
export const MORE = {
  tools: 'Tools', help: 'Help', settings: 'Settings',
  files: 'Saved recordings',
  compare: 'Compare two recordings',
  exportAI: 'Export for AI tools…',
  body: 'Body view',
  glassbox: 'Watch it decide',
  guide: 'What do I do now?',
  keys: 'Keyboard shortcuts',
  contrast: 'High contrast',
  advanced: 'Advanced mode',
  advancedTag: 'Advanced',
  needRecording: 'Open or make a recording first.',
  bodyWhere: 'Body view is on the Record and Save screens.',
  advancedOn: 'Advanced mode on: every control is shown.',
  advancedOff: 'Simple mode on: only what each step needs.',
  advancedKey: 'That shortcut is an Advanced tool: More → Advanced mode.',
  hint: (k) => `Shortcut: ${k}`,
};

export const START = {
  lead1: 'Record clean, labelled muscle and force signals.',
  lead2: 'Plug in any Arduino sketch that prints numbers.',
  connectTitle: 'Connect Arduino',
  connectBody: 'Plug in the USB cable first. Any sketch that prints numbers works.',
  connectDisabled: "Needs Chrome or Edge on a computer. This browser can't talk to an Arduino.",
  demoTitle: 'Practice with demo',
  demoBody: 'No hardware? A made-up signal (marked SYNTHETIC) follows the prompts.',
  fileTitle: 'Open saved recordings',
  fileBody: 'Club logs (.txt) or OpenGrip CSVs. Or drop files anywhere on this page.',
  privacy: 'Everything stays on this computer: no network, no camera, no microphone.',
  notMedical: 'Research demo, not a medical device.',
};

export const PREFLIGHT = {
  title: 'Connect and check',
  okCount: (ok, n) => `${ok} of ${n} working`,
  peekTitle: 'What the Arduino is sending',
  peekTitleDemo: 'What the demo is sending',
  lanesTitle: 'Live channels',
  moved: 'moved',
  flat: 'flat',
  skipped: 'skipped',
  back: '← Back',
  start: 'Start session',
  startAnyway: 'Start session anyway',
  copy: 'Copy',
  copied: 'Copied.',
  fixPrefix: 'Fix:',
  tipPrefix: 'Tip:',
  whyRows: 'Arduino found is the port; Signal readable is the baud rate (speed), line format and sample rate, with the numbers shown on each line. Sensors move: we ask the volunteer to squeeze twice and look for movement.',
  why: 'Why?',
  rows: {
    browser: 'Browser',
    places: 'Fit the band',
    port: 'Arduino found',
    speed: 'Signal readable',
    format: 'Lines readable',
    channels: 'Sensors',
    rate: 'Update speed',
    signal: 'Signal readable',
    flex: 'Sensors move',
    safety: 'Safety',
    source: 'Source',
  },
  // Browser
  browserOk: (name) => `${name}: can use USB serial`,
  browserFix: "This browser can't talk to an Arduino.",
  browserFixLine: 'open this page in Chrome or Edge on a computer. Practice with demo and Open saved recordings still work.',
  useDemo: 'Use demo',
  demoBrowser: 'Demo needs nothing',
  demoSource: (ch, hz) => `Synthetic signal: ${ch} channels at ${hz} Hz`,
  // Simple mode (simplify N5): plain words on the row; the numbers sit in its Why? fold.
  demoSourceSimple: (n) => `Practice signal from ${n} pretend sensors`,
  demoSourceWhy: (ch, hz) => `A made-up signal: ${ch} channels at ${hz} Hz, so nothing needs plugging in.`,
  signalOk: 'Readings are coming in clearly.',
  signalWait: 'Checking the signal…',
  signalCheck: 'Readings come in, but some are garbled.',
  signalFix: "The readings can't be read yet.",
  signalWhy: (parts) => parts.map(([name, detail]) => `${name}: ${detail || '…'}`).join(' · '),
  lanesTitleSimple: 'Live sensors',
  laneName: (i) => `Sensor ${i}`,
  // Port
  portWait: "Choose your Arduino in the browser's list.",
  choosePort: 'Choose port',
  tryAgain: 'Try again',
  portOk: (vid, pid) => (vid == null ? 'USB serial' : `USB serial (${hex4(vid)}:${hex4(pid)})`),
  portFix: 'No port chosen.',
  portFixLine: 'plug in the USB cable, then press Choose port. Not in the list? A clone Uno (CH340 chip) may need a driver on Mac or Windows.',
  // Speed
  speedTrying: (baud, i, n) => `Trying ${baud} baud… (${i} of ${n})`,
  speedOk: (baud, pct, remembered) => `${baud} baud · ${pct}% of lines readable${remembered ? ' (remembered from last time)' : ''}`,
  speedCheck: (baud, pct) => `${baud} baud · ${pct}% readable. Some lines are garbled; check the cable.`,
  speedFix: 'No speed gave readable lines.',
  speedFixLine: 'check the sketch calls Serial.begin(…) and prints numbers.',
  showSeen: 'Show what we saw',
  // Format
  formatWait: 'Reading lines…',
  formatCheck: (pct) => `Format found, but ${pct}% of lines didn't fit and will be skipped.`,
  // Channels
  channelsOk: (names) => `${names.length}: ${names.join(' ')}`,
  channelsCheck: (n) => `${n} channels: only the first 8 are plotted; all are saved.`,
  channelsFix: '0 channels found.',
  // Rate
  rateWait: 'Measuring…',
  rateSlow: (label) => `${label}: slow. Quick grips may blur; 100 Hz or more is better.`,
  rateUnknown: 'Unknown rate.',
  // Flex check
  flexWait: 'Ask the volunteer to squeeze and relax twice.',
  skipCheck: 'Skip check',
  flexOk: (names) => `Movement seen on ${names.join(', ')}.`,
  flexCheck: (moved, flat) => `Movement on ${moved.join(', ')}. ${flat.join(', ')} stayed flat: check those sensors, or carry on.`,
  flexFix: 'No channel moved.',
  flexFixLine: 'check the sensors touch the skin and the wires are in.',
  flexSkipped: 'Skipped.',
  flexDemo: 'The demo flexes by itself.',
  // Safety (RISKS B19 comfort line sits under the electrical line, always shown)
  safetyText: 'If EMG electrodes touch skin: unplug the laptop charger (battery only). Servos get their own battery. Research demo.',
  safetyComfort: 'Band snug, not tight. Stop if fingers tingle, go numb or change colour; at most 15 minutes per fitting. No maximum-effort squeezes.',
  safetyBox: 'Done: charger unplugged or no EMG on skin',
  safetyOk: 'Charger unplugged or no EMG on skin.',
  safetyRemembered: 'Reminder: EMG on skin = laptop on battery only.',
  // Announcements (spec §11)
  sayRow: (row, status, detail) => `${row}: ${status}, ${detail}`,
  sayDemoGo: 'Demo ready. Press Next: fit the band, or Skip to record.',
  // The demo waits for one of these (simplify-spec N2: no auto-jump to Record).
  nextFit: 'Next: fit the band',
  skipRecord: 'Skip to record',
};

export const PLACEHOLDER = {
  record: 'The Record screen arrives in the next build. The signal is flowing:',
  samples: (n) => `${n.toLocaleString('en-GB')} samples so far.`,
  files: 'The Files screen arrives in a later build. Chosen:',
  backToStart: '← Back to Start',
  review: 'Review & Save arrives in the next build. Recorded:',
};

// Record (spec §8.2): the huge word for a step label, and the tag under it.
export const PROMPT_WORDS = {
  cal_rest: ['RELAX', 'Getting a baseline: relax'],
  cal_squeeze: ['SQUEEZE', 'Getting a baseline: firm squeeze, not your hardest'],
  rest: ['REST', ''],
  grip: ['GRIP', ''],
  open: ['OPEN', ''],
  elbow_bend: ['BEND ELBOW', 'Bend your elbow. Keep your hand relaxed.'],
};
// Plain replacements for protocol.js instructions that use the word "calibration" (by gesture).
export const INSTRUCTION_WORDS = {
  cal_rest: 'Getting a baseline: arm on the table, hand fully relaxed.',
  cal_squeeze: 'Getting a baseline: squeeze firmly but comfortably (not as hard as you can).',
};
export const POSITION_WORDS = { down: 'Arm down', elbow90: 'Elbow 90°', raised: 'Arm raised', table: 'Arm on table' };
export const STRIP_GROUPS = { cal: 'baseline', down: 'arm down', elbow90: 'elbow 90°', raised: 'raised', bend: 'elbow bend' };

const mmss = (sec) => { const s = Math.max(0, Math.round(sec)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
export const RECORD = {
  mmss,
  ready: 'READY',
  // Simple mode never says a key as the instruction (simplify-spec §5): these name the button instead.
  simple: {
    readySub: (calSec, steps, totalSec) => { const m = Math.max(1, Math.round(totalSec / 60)); return `Press Start recording when Jo is ready. About ${m} minute${m === 1 ? '' : 's'}.`; },
    // The big button words of simplify-spec §6; Advanced keeps the short words beside their key caps.
    buttons: { record: 'Start recording', resume: 'Carry on', pause: 'Pause', stop: 'Stop and save', redo: 'Redo step', skip: 'Skip', review: 'Review and save' },
    pausedSub: (word) => `Paused. Press Carry on when Jo is ready, to carry on with: ${word}.`,
    hiddenSub: (word) => `Recording paused: keep this tab in front. Data is still being recorded. Press Carry on to carry on with: ${word}.`,
    doneSub: (n) => `${n} of ${n} steps. Press Review and save.`,
    sayDone: 'All steps done. Press Review and save.',
    reconnectedSub: (word) => `The step restarts from its beginning: ${word}. Press Carry on to go on now.`,
    stepLine: (i, n, left, part) => `Part ${part.at} of ${part.n} · ${left > 0 ? `about ${Math.max(1, Math.round(left / 60))} min left` : 'all done'}`,
  },
  // Advanced keeps the key and the exact counts, in the plain words of simplify-spec §6 (baseline, not calibration).
  // The Volunteer screen faces Jo, not the operator: no button to press, no counts (review-3 #6).
  volReadySub: 'Get ready. We start soon.',
  readySub: (calSec, steps, totalSec) => `Press Record (R) when Jo is ready. Baseline first: ${Math.round(calSec)} s, then ${steps} steps, ${mmss(totalSec)} in all.`,
  startingIn: 'Starting in…',
  paused: 'PAUSED',
  pausedSub: (word) => `Data is still being recorded and marked as paused. Press P to carry on with: ${word}.`,
  done: 'DONE ✓',
  doneSub: (n) => `${n} of ${n} steps. Press S to review and save.`,
  next: 'Next',
  nextDone: 'Next: done',
  nextSec: (sec) => `· ${Math.round(sec)} s`,
  stepLine: (i, n, left) => `Step ${i} of ${n} · ${mmss(left)} left`,
  demoTag: 'DEMO',
  buttons: { record: 'Record', resume: 'Resume', pause: 'Pause', stop: 'Stop', redo: 'Redo step', skip: 'Skip', review: 'Review and save' },
  views: { fit: 'Fit', full: 'Full', norm: '0–1' },
  viewLabel: 'View',
  windowSec: (s) => `${s} s`,
  needStart: 'Start recording first',
  needCal: 'The 0–1 view needs the baseline first: it runs at the start of the guided session.',
  calAuto: 'Calibrated: showing 0–1. N to change.',
  calManual: 'Calibrated. N shows 0–1.',
  calAdded: 'Calibration added after this step.',
  marker: (n, at) => `Marker ${n} at ${at}`,
  sayStarted: 'Recording started.',
  sayRedo: (w) => `Redoing: ${w}.`,
  saySkip: (w) => `Skipped: ${w}.`,
  sayPaused: 'Paused.',
  sayDone: 'All steps done. Press S to review and save.',
  stopTitle: 'Stop recording?',
  stopBody: (rec) => `${rec} recorded. You'll review and save next.`,
  // Stop guard (spec §3.4): leaving by Home, Back or a step while recording or paused.
  leaveBody: 'Leaving stops the recording. Nothing is lost: you go to Save first.',
  stopYes: 'Stop and save',
  stopNo: 'Keep recording',
  plotLabel: (n, sec, step) => `Live signal, ${n} channels, last ${sec} seconds.${step ? ` Current step: ${step}.` : ''}`,
  // Interruptions (spec §9.1) and the hidden tab (RISKS B9).
  unplugged: 'ARDUINO UNPLUGGED',
  unplugSub: (dataTime) => `Your ${dataTime} of data is safe. Plug the cable back in: we'll reconnect by ourselves.`,
  unplugWait: (since) => `Waiting for the Arduino… (${since})`,
  reconnecting: 'Reconnecting…',
  reconnectFailed: "Couldn't reopen the port. Check the cable, then press Reconnect. If it was plugged into a different USB socket, stop and review, then start again.",
  reconnected: (n) => `✓ RECONNECTED · carrying on in ${n}…`,
  reconnectedSub: (word) => `The step restarts from its beginning: ${word}. Press R or P to carry on now.`,
  reconnectBtn: 'Reconnect',
  stopReviewBtn: 'Stop and review',
  plugInFirst: 'Plug the Arduino back in first.',
  sayUnplugged: 'Arduino unplugged. Data is safe. Waiting to reconnect.',
  sayReconnected: (word) => `Reconnected. Carrying on with: ${word}.`,
  hiddenSub: (word) => `Recording paused: keep this tab in front. Data is still being recorded. Press P to carry on with: ${word}.`,
  boardReset: (at) => `Note: the board reset at ${at} (the Arduino restarted). The timeline carries on.`,
  volExit: 'Back to controls',
  // Simplify N6a (spec §3.6): Redo/Skip live in a small Step menu so Simple shows three big buttons.
  stepMenu: 'Step', stepMenuLabel: 'Step options: redo or skip this step',
  volShow: 'Show volunteer screen',
  // Rounded up so the volunteer is never told "1 minute" with 1 min 40 s to go.
  volLeft: (sec) => (sec <= 60 ? 'Less than a minute left' : `About ${Math.ceil(sec / 60)} minutes left`),
  volStop: 'Need to stop? Just say so.',
  // Simplify N6b (spec §7): the operator reads these to the volunteer before the first Start.
  volCardTitle: 'Read this to the volunteer',
  volCard: [
    "You'll follow one big word at a time: Relax, Squeeze, Open, Bend elbow.",
    'It takes about 4 minutes. There are short rests.',
    'Squeeze firmly, never as hard as you can.',
    'Tingling, numbness or colour change in your fingers? Say stop: we\'ll loosen the band.',
  ],
  legendProtocol: [['M', 'marker'], ['1–9', 'marker'], ['C', 're-calibrate'], ['N', 'view'], ['V', 'volunteer view'], ['A', 'body view'], ['[ ]', 'window'], ['H', 'high contrast'], ['?', 'all keys']],
};

export const KEYS = {
  global: [['?', 'Show these keys'], ['H', 'High contrast on or off'], ['Esc', 'Close or go back']],
  start: [['1', 'Connect Arduino'], ['2', 'Practice with demo'], ['3', 'Open saved recordings'], ['← →', 'Move between tiles']],
  record: [['R', 'Record, or resume'], ['P', 'Pause or resume the steps'], ['S', 'Stop, then review'], ['←', 'Redo this step'], ['→', 'Skip this step'],
    ['M', 'Add a marker'], ['1–9', 'Add a marker'], ['C', 'Re-calibrate after this step'], ['N', 'Change view (Fit, Full, 0–1)'], ['V', 'Volunteer view (big prompt) on or off'], ['A', 'Body view: show or hide (narrow: Signal / Body)'], ['Enter', 'Unplugged: reconnect'], ['[ ]', 'Shorter or longer window'], ['Esc', 'Leave Volunteer view; before recording: back to Start']],
  review: [['B', 'Compare two recordings (after adding two recordings)'], ['Esc', 'Back']],
  files: [['O', 'Add files'], ['↑ ↓', 'Move between files'], ['Delete', 'Remove from the list'], ['B', 'Compare two recordings (two files loaded)'], ['Esc', 'Back']],
  scorecard: [['Esc', 'Back to where you came from']],
  preflight: [['Enter', 'Do the current step, or Start session'], ['K', 'Skip the flex check'], ['X', 'Tick the safety box'], ['Esc', 'Back (closes the port)']],
};

function hex4(n) { return Number(n).toString(16).padStart(4, '0'); }

// Plain sentences for every quality / Doctor finding (simplify-spec §6). `short` is the chip; `say(nm)`
// is the full plain sentence for Review; `why` is the jargon-bearing reason, shown only behind Why?.
// `adv: true` = detail for Advanced mode only (no plain sentence worth showing to a beginner).
// ch1 -> Sensor 1; Arduino pin names count from 0, so a0 / A0 -> Sensor 1.
export const sensorName = (nm) => String(nm || '').replace(/^ch(\d+)$/i, 'Sensor $1').replace(/^a(\d+)$/i, (_, n) => `Sensor ${Number(n) + 1}`);
export const PLAIN = {
  dropout: { short: "Sensor isn't touching the skin", say: (n) => `${n} isn't touching the skin well.`, why: 'The reading fell to zero: usually a sensor lifted off or a loose wire.' },
  spike: { short: 'A wire may be loose', say: (n) => `A wire to ${n} may be loose.`, why: "A sudden jump that a hand can't make." },
  saturation: { short: 'Squeezing too hard for the sensor', say: (n) => `${n} is being squeezed harder than it can read.`, why: "The reading hit the sensor's maximum. Ask for a softer squeeze or loosen the band." },
  noisy_rest: { short: 'Jumpy when relaxed', say: (n) => `${n} is jumpy even when the arm is relaxed.`, fix: (n) => `Check the ground wire and that ${n} sits flat on the skin.`, why: 'The reading wobbles at rest. Check the wires and that the sensor sits flat on the skin.' },
  band_shift: { short: 'The band may have slipped', say: (n) => `The band may have slipped near ${n}.`, fix: (n) => `Put the band back where it was (or tighten it again), then do the setup squeezes again.`, why: "The resting or squeezing level moved away from the baseline we measured at the start." },
  fade: { short: 'Squeezes getting weaker: Jo may be tired', say: (n) => `Squeezes on ${n} are getting weaker. Jo may be tired.`, why: 'Later squeezes are weaker than the first ones. It can also mean the band is loosening or sliding.' },
  position: { short: 'Bending the elbow looks like a squeeze here', shortFor: (it) => (it.level === 'red' ? 'Bending the elbow looks like a squeeze here' : 'Bending the elbow looks a little like a squeeze'), say: (n) => `On ${n}, bending the elbow looks like a squeeze.`, why: 'The sensor picks up the elbow, so a computer could confuse the two.' },
  no_data: { short: 'No clear movement yet', say: (n) => `${n} sent nothing we could read.`, why: 'No readings arrived on this sensor.' },
  no_bursts: { short: 'No clear squeezes seen', say: (n) => `No clear squeezes were seen on ${n}.`, why: 'We looked for short bursts of signal (squeezes) and found none.' },
  no_rate: { short: 'Timing is a guess', say: () => 'This recording has no clock, so timing is a guess.', why: 'No timestamps, so the sample rate is unknown and a typical one is assumed.' },
  no_labels: { short: 'Not labelled', say: () => 'This recording is not labelled, so it cannot be used to teach an AI as it is.', why: 'No step labels were recorded with the signal.' },
  bursts: { adv: true },
  hum_unchecked: { adv: true },
  // Drift (drift.js): slow changes over the session, not single glitches.
  rest_drift: { short: "Resting level moved during the session", say: (n) => `${n} did not settle back to the same level when Jo relaxed.`, why: 'The rest level moved between the start and the end of the session, often because the band loosened or warmed up. Re-tighten it where it was and keep sessions short.' },
  hold_creep: { short: 'Reading creeps up during a steady squeeze', say: (n) => `${n} kept rising while Jo held a steady squeeze.`, why: 'Pressure sensors slowly read higher under a steady load (sensor creep). Keep holds short, 2 to 3 seconds, and take the baseline at every fitting.' },
  ok: { short: 'All good', say: () => 'No problems found.', why: '' },
  board_reset: { short: 'The Arduino restarted', say: () => 'The Arduino restarted during the recording.', why: 'The board reset; the timeline carries on.' },
  slow_link: { short: 'Signal arrives slowly', say: () => 'The signal is arriving slowly.', why: 'The sample rate is low or the cable link is slow.' },
  gap: { short: 'Readings went missing', say: () => 'Some readings went missing for a moment.', why: 'There is a gap in the timestamps.' },
  jitter: { short: 'Uneven timing', say: () => 'Readings arrived at uneven times.', why: 'The time between samples varies more than expected.' },
  floating: { short: 'A sensor may be unplugged', say: (n) => `${n} may not be connected.`, why: 'The signal looks like a floating input: random drift with nothing attached.' },
  hum: { short: 'Mains hum on the signal', say: (n) => `${n} is picking up electrical hum.`, why: 'A 50 or 60 Hz mains hum is on the signal. Keep wires away from chargers.' },
  crosstalk: { short: 'Two sensors move together', say: () => 'Two sensors seem to be moving together.', why: 'Crosstalk: one sensor picks up the signal of another.' },
  boot_junk: { short: 'Junk at the start', say: () => 'There is some junk at the start of the recording.', why: 'The Arduino prints startup text before real data.' },
};

// Quality strip (spec §8.4): chip short texts per code; the popover shows the quality.js message
// verbatim plus the Doctor's fix line.
export const QUALITY = {
  label: 'Signal quality',
  okAll: (n) => `All ${n} sensor${n === 1 ? '' : 's'} look good`,
  checkN: (n) => `${n} thing${n === 1 ? '' : 's'} to check`,
  fixN: (n) => `${n} problem${n === 1 ? '' : 's'} to fix now`,
  more: (n) => `+${n} more`,
  // Chip text is the plain short form; the technical reason lives behind Why? (PLAIN, above).
  chip: Object.fromEntries(Object.entries(PLAIN).filter(([, p]) => p.short).map(([code, p]) => [code, (it) => (p.shortFor ? p.shortFor(it) : p.short)])),
  ago: (sec) => (sec < 60 ? `${Math.max(0, Math.round(sec))} s ago` : `${Math.floor(sec / 60)} min ago`),
  fixPrefix: 'Fix:',
  followTitle: 'Probably caused by this:',
  followOn: (code) => PLAIN[code]?.short || code.replace(/_/g, ' '),
  why: 'Why?',
  sayRed: (ch, short) => `Problem on ${ch}: ${short}.`,
  close: 'Close',
};

// Autosave indicator (spec §8.6).
export const SAVE = {
  idle: 'Not recording',
  pending: 'Saving starts in a moment',
  saved: (ago) => `Autosaved · ${ago}`,
  savedShort: (sec) => (sec < 60 ? `${Math.max(0, Math.round(sec))} s ago` : `${Math.floor(sec / 60)} min ago`),
  title: (n) => `${n.toLocaleString('en-GB')} samples in this browser`,
  failed: 'Autosave failed: data kept in this tab, retrying. Export soon.',
  sayFailed: 'Autosave failed. Data kept in this tab. Export soon.',
  about: 'Recordings are saved in this browser every 2 seconds, so a reload or crash loses at most 2 seconds. They stay until you save or discard them.',
};

// Recovery banner (spec §9.2) on Start.
export const RECOVER = {
  title: '1 recording isn\'t saved yet',
  noPerson: 'No volunteer code yet',
  // Plain line (spec wording table); samples and channels stay in data-samples for the walk.
  line: (who, when, len) => `${who} · ${when} · ${len}`,
  more: (n) => `And ${n} more recording${n === 1 ? '' : 's'} not saved yet`,
  review: 'Save it now',
  export: 'Download CSV',
  discard: 'Delete…',
  discardTitle: 'Delete this recording?',
  discardBody: (len) => `Delete this recording from this browser? ${len} of data. This can't be undone.`,
  keep: 'Keep it',
  del: 'Delete',
  loading: (n) => `Loading ${n.toLocaleString('en-GB')} samples…`,
  loadError: (e) => `Couldn't load this recording: ${e}. It's still stored; try again, or discard it.`,
  discarded: 'Recording deleted.',
  exported: (name) => `Exported ${name}.`,
  recovered: 'Recovered',
};

// Review and save (spec §10.1-10.3).
export const REVIEW = {
  moreDetails: 'More details',
  finishGuide: 'Saved ✓. **Record again**, start the **Next volunteer**, or go **Home**.',
  again: 'Record again',
  next: 'Next volunteer',
  home: 'Go home',
  fileTitle: (name) => `Review · ${name}`,
  summary: (n, ch, sec) => `${sec != null ? `${sec} second${sec === 1 ? '' : 's'} · ` : ''}${ch} sensor${ch === 1 ? '' : 's'}`,
  summaryWhy: (n, ch, sec, mk) => `${n.toLocaleString('en-GB')} samples (readings), ${ch} channel${ch === 1 ? '' : 's'} (one per sensor), ${mk} marker${mk === 1 ? '' : 's'} (moments you flagged).`,
  plotLabel: (ch) => `Whole recording, ${ch} channel${ch === 1 ? '' : 's'}; grey bands are gestures.`,
  header: (fix, check, ok) => `✕ ${fix} to fix · ▲ ${check} to check · ✓ ${ok} working`,
  clean: 'Working: this recording is ready to use.',
  assumed: (hz) => `Rate unknown: timing checks assume ${hz} Hz.`,
  whole: 'Whole recording',
  fixPrefix: 'How to fix:',
  followTitle: 'Probably caused by this, so not counted:',
  atSample: (i) => `at sample ${Number(i).toLocaleString('en-GB')}`,
  doctorTitle: 'Hardware check',
  doctorNone: 'Nothing to fix in the hardware.',
  addCompare: 'Compare two recordings',
  saveTitle: 'Save',
  pid: 'Volunteer code',
  pidHint: 'A code like P03, never a name. Keep the code-to-name list on paper.',
  sensors: 'Sensor per channel',
  setAll: 'Set all:',
  placement: 'Placement',
  placementPh: 'e.g. 4 FSRs around the forearm, 5 cm below the elbow',
  tightness: 'How did the band feel?',
  tight: { loose: 'Loose', snug: 'Snug', tight: 'Tight', none: 'Not noted' },
  setup: 'Setup name (optional)',
  setupHint: 'Name the fabric or mount, e.g. spandex-v2, so setups can be compared later.',
  notes: 'Notes',
  exportNow: 'Save to this computer',
  exportHint: 'Saves 2 files to Downloads: the recording (.csv) and its check report (.json). Until then the recording lives only in this browser.',
  cantSave: "Can't save yet: add a volunteer code (like P03, not a name).",
  blocked: 'Your browser blocked the download. Allow downloads for this page, then press Save again.',
  saved: (base) => `Saved ✓ to Downloads: ${base}.csv and its report`,
  backStart: '← Back to Start',
  // Save guard (spec §3.4): leaving a recording that isn't saved to a file.
  guardTitle: 'Save this recording first?',
  guardBody: (len, who) => {
    const x = [len, who].filter(Boolean).join(', ');
    return `This recording${x ? ` (${x})` : ''} isn't saved to a file yet. It's kept in this browser until you save or delete it.`;
  },
  guardSave: 'Save it now',
  guardLeave: 'Leave, keep it for later',
  guardStay: 'Stay here',
  backFiles: '← Back to Files',
  del: 'Delete…',
  delTitle: 'Delete this recording?',
  delBody: (n) => `Delete this recording (${n.toLocaleString('en-GB')} samples) from this browser? Files you already exported are not touched. This can't be undone.`,
  keep: 'Keep it',
  delYes: 'Delete',
  deleted: 'Recording deleted from this browser.',
};

// Files, open old logs (spec §10.4).
export const FILES = {
  // Scorecard pooling picker (several recordings per side).
  pool: {
    legend: (s) => `Design ${s}`,
    nth: (s, n) => `${s}, recording ${n}`,
    add: (s) => `Add another to ${s}`,
    remove: 'Remove',
    removeLabel: (s, n) => `Remove ${s}, recording ${n}`,
    noSpare: 'Every loaded recording is already picked. Add more files first.',
    added: (s, n) => `${s} now pools ${n} recordings.`,
  },
  title: 'Files',
  add: '+ Add files (O)',
  drop: 'Drop .txt or .csv files here, or press O to choose files.',
  dropMore: 'Drop more files here',
  empty: 'No file open yet.',
  back: '← Back',
  reading: 'Reading…',
  big: (bytes) => `Big file (${Math.round(bytes / 1048576)} MB): reading may take a while.`,
  unreadable: (why) => `Couldn't read this file: ${why}.`,
  rateUnknown: 'rate unknown',
  channels: (n) => `${n} channel${n === 1 ? '' : 's'}`,
  plotLabel: (name) => `Whole file ${name}; grey bands are gestures.`,
  save: 'Add metadata and save as OpenGrip CSV',
  removed: 'Removed from the list. The file on your disk is not touched.',
  compare: 'Compare two recordings',
  compareNeeds: 'Load two recordings to compare them.',
  pickA: 'A',
  pickB: 'B',
  openScorecard: 'Open scorecard (B)',
};

// A/B comparison tray (Review "Compare two recordings", Files "Compare two") and the Scorecard screen.
export const COMPARE = {
  added: (name, n) => (n < 2 ? `Added ${name} as A. Add one more recording, then press B.` : `Added ${name} as B. Press B to open the Scorecard.`),
  needTwo: 'Add two recordings to the comparison first (Compare two recordings on Save), then press B.',
  sameTwice: 'Pick two different recordings for A and B.',
  failed: (e) => `Couldn't build the Scorecard: ${e}.`,
};

// "Export for AI tools" panel (export-panel.js) on Review and Files.
export const EXPORT = {
  title: 'Export for AI tools',
  hint: 'One ZIP with the folders your tools read. People are volunteer codes only.',
  formats: 'Formats',
  calib: 'Include calibration steps',
  button: 'Export dataset (ZIP)',
  none: 'Pick at least one format.',
  empty: 'Nothing to export yet.',
  synthetic: 'Demo data: every file is marked synthetic=true.',
  done: (name, n) => `Saved ${name} (${n} files).`,
};

// Body view (docs/design/body-view-spec.md §5-§9); drawn by body-draw.js.
export const BODY_WORDS = {
  title: 'Body view',
  convention: 'Seen from the elbow, palm down',
  armConvention: 'Your own arm on a table, elbow nearest you',
  arm: { R: 'Right arm', L: 'Left arm' },
  entered: '✎ Places entered by you',
  enteredNone: '✎ Places entered by you: none yet',
  notSetTitle: 'Places not set',
  notSetBody: 'The live levels are below, in channel order. Tell the app where each sensor is to see them on the arm.',
  notPlaced: 'Not placed',
  lens: { ring: 'Ring', arm: 'Arm', table: 'Table' },
  lensLabel: 'Body view lens',
  back: 'Back of arm', palm: 'Palm side', thumb: 'Thumb side', little: 'Little-finger side',
  thumbWord: 'thumb', crease: 'elbow crease', cm: 'cm', radius: 'radius', ulna: 'ulna',
  // Plain kinds (simplify-spec §6): the legend shows in Simple, so it says what the sensor feels, not FMG / EMG.
  legend: ['Pressure sensor: wedge, longer = more pressure', 'Muscle-signal sensor: square, thicker halo = more muscle', 'Working ✓', 'Check ▲', 'Fix ✕'],
  check: { good: 'Working ✓', weak: 'Check ▲', bad: 'Fix ✕' },
  pin: { red: '✕ Fix', amber: '▲ Check' },
  noLevel: 'no level',
  cols: ['Ch', 'Type', 'Place', 'Around', 'Below crease', 'Now', 'Check', 'Fix tip'],
  // Narrow hosts (< 420 px, e.g. the Record rail): same values folded into 4 columns (review-2 M5).
  colsShort: ['Ch', 'Place', 'Now', 'Fix tip'],
  caption: 'Where each sensor is, its level now, and its checks',
  fixPrefix: 'How to fix: ',
};

// Record screen Body rail (spec §6.2, §5.4, §8, §9).
export const BODY_RAIL = {
  button: 'Body view',
  close: 'Close the Body view',
  region: 'Body view: where each sensor sits, lit by its level now',
  tabs: { signal: 'Signal', body: 'Body' },
  tabsLabel: 'Signal or Body view',
  setPlaces: 'Set sensor places',
  setPlacesNote: 'Default ring in channel order: not your places. Set sensor places opens the fit sheet.',
  defaultRing: 'default ring, not your places',
  rough: '▲ Levels are rough until the baseline is done',
  calibrated: 'Level 0–1 from the baseline',
  unplugged: '✕ Unplugged: showing no levels',
  shown: 'Body view shown', hidden: 'Body view hidden',
};
// Short place names for the lane gutter (spec §5.4), by 45° octant from the palm middle (0°),
// the same order as placement.js OCTANTS.
export const PLACE_SHORT = ['Palm mid', 'Palm·thumb', 'Thumb edge', 'Back·thumb', 'Back mid', 'Back·little', 'Little edge', 'Palm·little'];
export const NOT_PLACED_SHORT = 'not placed';

// Fit sheet + Preflight "Sensor places" row + placement check (body-view-spec §6.1, §16).
// Rule: places are "entered by you"; the check says "works here", never "correct position".
export const FIT = {
  row: 'Fit the band',
  rowOptional: 'Optional. Shows where each sensor is.',
  rowButton: 'Fit the band',
  rowEdit: 'Change places',
  rowSaved: (summary) => `${summary} · entered by you`,
  rowMoved: (n) => `${n} sensor${n === 1 ? '' : 's'} moved since last time`,
  title: "Fit the band on Jo's arm",
  entered: '✎ Places entered by you. The app cannot see where a sensor sits; you type it in.',
  person: 'Volunteer code',
  personHint: 'A code, not a name. Fits are kept on this computer only, by volunteer code and arm.',
  arm: 'Which arm', armL: 'Left arm', armR: 'Right arm',
  quick: 'Quick setup: evenly spaced ring',
  count: 'FMG sensors', countSimple: 'Sensors on the band', cm: 'Below the elbow crease', start: 'Sensor 1 sits at', dir: 'Numbers go',
  dirs: { thumb: 'toward the thumb', little: 'toward the little finger' },
  band: 'Band length round the arm (cm)', spacing: (cm) => `→ sensors ${cm} cm apart`,
  howTitle: 'How to measure',
  how: '<b>How to measure.</b> Bend the elbow: the <b>elbow crease</b> is the fold on the palm side. Straighten the arm and measure from the crease toward the wrist along the middle of the palm side. The thick, muscly part <b>6–10 cm below the crease</b> is where published FMG bands sit (Rehman 2023). To put the band back in the same place next time, line sensor 1 up with something you can feel, like the bony bump on the thumb side, and note it below.',
  landmark: 'Landmark note',
  emg: 'EMG sites', emgFlex: 'EMG on the flexors (palm side, upper third, 5 cm)', emgExt: 'EMG on the extensors (back, upper third, 5 cm)',
  emgRef: 'Reference electrode: the bony point of the elbow.',
  fine: 'Fine-tune',
  fineHint: 'Pick a sensor (a number or a dot), then ← → move it round the arm 5° (Shift 15°) and ↑ ↓ along it 0.5 cm (Shift 1.5 cm).',
  sayMoved: (ch, site, deg, cm) => `Sensor ${ch}: ${String(site || '').toLowerCase()}, ${deg}°, ${cm.toFixed(1)} cm.`,
  pressHint: 'Ask Jo to press each sensor with a finger. The same number should light up.',
  compare: 'Compared with last time', ghost: 'Last time (dimmed)', okTag: 'Working ✓', checkTag: 'Check ▲',
  noPerson: 'Enter a volunteer code to compare with their last fitting.',
  first: (pid, arm) => `First fitting for ${pid}, ${arm.toLowerCase()}: nothing to compare yet.`,
  otherArm: (arm) => `Last time was the ${arm.toLowerCase()}: not compared.`,
  others: (n) => `${n} other sensor${n === 1 ? ' is' : 's are'} within 1 cm and 20° of last time.`,
  same: (n) => `All ${n} sensors are within 1 cm and 20° of last time.`,
  save: 'Save places', useLast: "Use last time's places", skip: 'Skip for now',
  // Fit as a step page (simplify N5): Simple folds the detail away; Next goes on to Record.
  more: 'More fitting options', next: 'Next: Record',
  saved: (pid, arm) => `✓ Saved for ${pid}, ${arm.toLowerCase()}. Next time you can compare or reuse these.`,
  savedNoPid: '✓ Saved for this session. Add a volunteer code to compare next time.',
  checkTitle: 'Does each spot work?',
  checkIntro: 'Four short movements (about 20 s). Each sensor then shows whether its spot works here.',
  demoNote: 'Demo: the synthetic arm plays the four movements with the places entered here. Each sensor then shows whether its spot works here.',
  check: 'Check placement (20 s)',
  steps: { relax: ['Relax', 'Let the arm go loose.'], fist: ['Make a fist', 'Squeeze firmly.'], wrist_back: ['Wrist back', 'Bend the hand up, fingers open.'], elbow_bend: ['Bend the elbow', 'Without gripping.'] },
  secs: (s) => `${s} s`,
  sayCheck: 'Placement check started: follow the prompts.',
  live: 'Live re-check', liveStop: 'Stop live re-check',
  liveOn: 'Live re-check: adjust a sensor, repeat the movement shown, and watch its glow.',
  misplace: 'Simulate a misplaced sensor (sensor 3)', synthetic: 'SYNTHETIC',
  sensor: (ch) => `Sensor ${ch}`,
  state: { good: 'Working ✓', weak: 'Check ▲', bad: 'Fix ✕' },
  goodCount: (chs) => `${chs.length} sensor${chs.length === 1 ? '' : 's'}: ${chs.join(', ')}`,
  fixPrefix: 'How to fix: ',
};

// Review card: Body ring + gesture fingerprints (src/ui/fingerprint-view.js).
export const FP_WORDS = {
  title: 'Body',
  synthetic: 'SYNTHETIC · demo data',
  mainNote: 'Colour = each sensor’s mean level during the gesture steps on this recording. Pins = the hardware check’s findings.',
  placesNotSet: 'Spokes in channel order: places not set.',
  fpTitle: 'Grip patterns',
  fpIntro: 'Mean level per sensor during the steady middle of each step, rest taken away.',
  basis: { calibration: '1.0 = your calibration squeeze.', recording: '1.0 = the strongest step on this recording (no calibration).' },
  positions: { down: 'Arm down', elbow90: 'Elbow 90°', raised: 'Arm raised' },
  distractor: 'distractor',
  notRecorded: 'not recorded',
  check: 'Check ▲',
  ok: 'Working ✓',
  okLine: 'Each gesture has its own pattern on this recording.',
  table: 'Fingerprints as a table',
  tableHead: { gesture: 'Gesture', position: 'Position', steps: 'Steps' },
  steps: (n) => `${n} step${n === 1 ? '' : 's'}`,
};

// Card R7: the one-page session report (src/report.js). Plain words; Advanced adds numbers.
export const REPORT = {
  button: 'Save a one-page report',
  saved: (name) => `Report saved as ${name}.`,
  title: 'OpenGrip session report',
  synthetic: 'Synthetic demo data: made by the digital twin, not recorded from a person.',
  session: 'Session',
  code: 'Person code',
  noCode: 'no code given',
  date: 'Date',
  noDate: 'not recorded',
  length: 'Length',
  lengthVal: (sec, n) => `${sec != null ? `${sec} second${sec === 1 ? '' : 's'}` : 'unknown'} · ${n.toLocaleString('en-GB')} readings`,
  rate: 'Readings per second',
  setup: 'Setup',
  sensors: 'Sensors',
  sensorsVal: (n) => `${n} sensor${n === 1 ? '' : 's'}`,
  band: 'Band fit',
  placement: 'Where the sensors sit',
  doctor: 'Hardware Doctor',
  clean: 'Working: this recording is ready to use.',
  counts: (fix, check, ok) => `${fix} to fix · ${check} to check · ${ok} working`,
  whole: 'Whole recording',
  fix: 'Fix:',
  drift: 'Slow changes (drift)',
  driftNone: 'No slow changes found: the readings stayed steady.',
  liveNote: 'Live screen vs whole session',
  fit: 'Fit check',
  fitNone: 'No fit check was done for this session.',
  fitState: { good: 'Works here', weak: 'Weak', bad: 'Not working here' },
  plots: 'Overview',
  plotLabel: (name) => `${name}, whole recording`,
  footer: (v) => `Made by OpenGrip Studio ${v}. Everything in this page was worked out on this computer; nothing was sent anywhere.`,
};
