// opengrip_selftest v1: a test sketch for OpenGrip Studio. Works on an Arduino Uno or Nano.
// NOT COMPILED YET (no arduino-cli on the build machine); standard Arduino API only.
// To check it compiles: Arduino IDE -> Tools -> Board -> "Arduino Uno" (or Nano), then the
// tick button (Verify). "Done compiling" at the bottom means it is fine.
//
// WHY THIS EXISTS: it proves the app works with your board before any sensor is wired.
//   Mode 1 "fake" (the default, NO sensors needed): the board sends made-up numbers with a
//     known shape, so you can check the app finds the board and draws the right lines with
//     only a USB cable.
//   Mode 2 "sensors": the board reads the real analog pins A0..A5, exactly like nxt_logger.
//
// HOW TO PICK THE MODE (either way works):
//   - Jumper: put a wire from pin D2 to GND, then press the board's reset button -> sensors.
//     No wire on D2 -> fake.
//   - Serial command: in the Arduino IDE Serial Monitor (115200 baud) type 1 (fake) or
//     2 (sensors) and press Enter. Close the Serial Monitor before using the app.
//
// OUTPUT at 115200 baud, the same line format as nxt_logger (so the app reads both alike):
//   # opengrip_selftest v1 mode=fake channels=4 rate_hz=200 pins=A0,A1,A2,A3
//   t_ms,a0,a1,a2,a3                     column names
//   12345,512,800,300,60                 one line per sample: time in ms, then one value per channel
//   # marker t_ms=12345 note=mode_sensors      when the mode changes
// Lines starting with "#" are information lines; the app reads and keeps them.
//
// THE FAKE PATTERN (values 0..1023, like a real analog pin), repeats every 4 seconds:
//   a0 slow ramp: climbs from 0 to 1023 over 4 s, then drops back to 0
//   a1 square wave: 200 for 0.5 s, then 800 for 0.5 s (1 per second)
//   a2 triangle: up from 100 to 900 over 2 s, then back down over 2 s
//   a3 "squeeze": rests near 60, then 600 for 1.5 s (looks like a grip on a force sensor)
//   a4 flat at 512, a5 flat at 256 (only if NUM_CH is 5 or 6)
//
// SAFETY: this sketch needs no sensors. In sensors mode the same rules as nxt_logger apply
// (EMG electrodes: laptop on battery, charger unplugged). Servos never on the Arduino's 5V.

// ---- Settings -----------------------------------------------------------------------
const uint8_t PINS[] = {A0, A1, A2, A3};   // 2 to 6 pins; e.g. {A0, A1, A2, A3, A4, A5}
const uint8_t NUM_CH = sizeof(PINS) / sizeof(PINS[0]);
const unsigned long RATE_HZ = 200;         // samples per second (same as nxt_logger)
const long BAUD = 115200;                  // same as nxt_logger
const int MODE_PIN = 2;                    // wire D2 to GND = sensors mode
// --------------------------------------------------------------------------------------

const unsigned long PERIOD_US = 1000000UL / RATE_HZ;
unsigned long nextUs;
bool sensorsMode = false;

void printHeader() {
  Serial.print(F("# opengrip_selftest v1 mode="));
  Serial.print(sensorsMode ? F("sensors") : F("fake"));
  Serial.print(F(" channels="));
  Serial.print(NUM_CH);
  Serial.print(F(" rate_hz="));
  Serial.print(RATE_HZ);
  Serial.print(F(" pins="));
  for (uint8_t i = 0; i < NUM_CH; i++) {
    if (i) Serial.print(',');
    Serial.print('A');
    Serial.print(PINS[i] - A0);
  }
  Serial.println();
  Serial.print(F("t_ms"));
  for (uint8_t i = 0; i < NUM_CH; i++) {
    Serial.print(F(",a"));
    Serial.print(PINS[i] - A0);
  }
  Serial.println();
}

// The made-up value for channel `ch` at time t (ms). Integer maths only: an Uno has no
// fast floating point, and whole numbers are what a real analogRead gives.
int fakeValue(uint8_t ch, unsigned long t) {
  unsigned long p = t % 4000UL;            // position in the 4-second cycle
  switch (ch) {
    case 0: return (int)(p * 1023UL / 3999UL);                                  // ramp
    case 1: return (t % 1000UL) < 500UL ? 200 : 800;                            // square
    case 2: return p < 2000UL ? 100 + (int)(p * 800UL / 2000UL)                 // triangle
                              : 900 - (int)((p - 2000UL) * 800UL / 2000UL);
    case 3: return (p >= 1000UL && p < 2500UL) ? 600 : 60;                      // squeeze
    case 4: return 512;
    default: return 256;
  }
}

void setMode(bool sensors, unsigned long t) {
  if (sensors == sensorsMode) return;
  sensorsMode = sensors;
  // A marker line, not a new header: the app is already reading, and markers are shown on the plot.
  Serial.print(F("# marker t_ms="));
  Serial.print(t);
  Serial.println(sensorsMode ? F(" note=mode_sensors") : F(" note=mode_fake"));
}

void setup() {
  Serial.begin(BAUD);
  pinMode(MODE_PIN, INPUT_PULLUP);         // no wire reads HIGH; wire to GND reads LOW
  sensorsMode = digitalRead(MODE_PIN) == LOW;
  delay(50);
  printHeader();
  nextUs = micros();
}

void loop() {
  // Serial commands: '1' = fake, '2' = sensors. Other characters (e.g. Enter) are ignored.
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '1') setMode(false, millis());
    if (c == '2') setMode(true, millis());
  }

  // Fixed rate, the same way as nxt_logger: schedule from the previous deadline.
  if ((long)(micros() - nextUs) < 0) return;
  nextUs += PERIOD_US;
  if ((long)(micros() - nextUs) > (long)(PERIOD_US * 4)) nextUs = micros() + PERIOD_US;

  unsigned long t = millis();
  int vals[6];
  for (uint8_t i = 0; i < NUM_CH && i < 6; i++) {
    if (sensorsMode) {
      analogRead(PINS[i]);                 // first reading thrown away (crosstalk, see nxt_logger)
      vals[i] = analogRead(PINS[i]);
    } else {
      vals[i] = fakeValue(i, t);
    }
  }
  Serial.print(t);
  for (uint8_t i = 0; i < NUM_CH && i < 6; i++) {
    Serial.print(',');
    Serial.print(vals[i]);
  }
  Serial.println();
}
