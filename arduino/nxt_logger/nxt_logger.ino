// nxt_logger v1: fixed-rate multi-channel logger for OpenGrip Studio.
// NOT COMPILED YET (no arduino-cli on the build machine); standard Arduino API only.
//
// Output at 115200 baud:
//   # nxt_logger v1 channels=6 rate_hz=200 pins=A0,A1,A2,A3,A4,A5
//   t_ms,a0,a1,...           one line per sample, t_ms = millis() at the sample
//   # marker t_ms=12345 note=button      when the optional button is pressed
// OpenGrip Studio also reads the club's old "Serial.println(analogRead(A0))" sketches,
// so reflashing is optional; this sketch adds timestamps, all channels and markers.
//
// SAFETY (EMG electrodes on skin): the person wearing the band must be connected only to
// a battery-powered circuit. Unplug the laptop charger while electrodes are worn (run the
// laptop on battery), and never wear electrodes while the board is on a mains-powered
// USB hub or desktop PC. FSRs (FMG) have no skin contact, but follow the same rule when a
// band mixes FMG and EMG.
//
// FSR WIRING (one per channel): a voltage divider.
//   5V ---[ FSR ]---+--- analog pin (A0..A5)
//                   |
//                 [ R ] 10k
//                   |
//   GND ------------+
// More force -> lower FSR resistance -> higher reading. Choosing R: pick R close to the
// FSR's resistance at the force you care about most (geometric middle of its working range).
// 10k suits typical grip forces on an FSR 402. If firm grips read near 1023 (saturated),
// use a smaller R (4.7k, 3.3k); if strong squeezes only reach ~100-200, use a larger R
// (22k, 47k). Keep the same R on every channel so channels are comparable, and write
// the value in the session notes.

// ---- Settings -----------------------------------------------------------------------
const uint8_t PINS[] = {A0, A1, A2, A3, A4, A5};   // Uno has 6 analog pins; Mega: add A6, A7...
const uint8_t NUM_CH = sizeof(PINS) / sizeof(PINS[0]);
const unsigned long RATE_HZ = 200;                 // samples per second (per channel)
const long BAUD = 115200;
const int BUTTON_PIN = -1;                         // e.g. 2 (button to GND); -1 = no button
// --------------------------------------------------------------------------------------

const unsigned long PERIOD_US = 1000000UL / RATE_HZ;
unsigned long nextUs;
bool lastButton = HIGH;
unsigned long lastButtonMs = 0;

void printHeader() {
  Serial.print(F("# nxt_logger v1 channels="));
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

void setup() {
  Serial.begin(BAUD);
  if (BUTTON_PIN >= 0) pinMode(BUTTON_PIN, INPUT_PULLUP);
  delay(50);
  printHeader();
  nextUs = micros();
}

void loop() {
  // Fixed rate from micros(): schedule from the previous deadline, not "now", so timing
  // errors don't add up. Subtraction keeps working when micros() wraps (~70 min).
  if ((long)(micros() - nextUs) < 0) return;
  nextUs += PERIOD_US;
  // Fell far behind (e.g. serial buffer full at too high a rate): resync, don't burst.
  if ((long)(micros() - nextUs) > (long)(PERIOD_US * 4)) nextUs = micros() + PERIOD_US;

  unsigned long t = millis();
  // Read every channel first, then print, so all values in a line come from the same moment.
  // Each pin is read twice and the first reading thrown away: the Uno has one ADC that
  // switches between pins, and a high-impedance source (e.g. an FSR divider) may not settle
  // in time, so part of the previous pin's value leaks in ("crosstalk").
  int vals[NUM_CH];
  for (uint8_t i = 0; i < NUM_CH; i++) {
    analogRead(PINS[i]);
    vals[i] = analogRead(PINS[i]);
  }
  Serial.print(t);
  for (uint8_t i = 0; i < NUM_CH; i++) {
    Serial.print(',');
    Serial.print(vals[i]);
  }
  Serial.println();
  // At 115200 baud a 6-channel line (~30 chars) takes ~2.6 ms; 200 Hz leaves headroom.
  // 8 channels at 200 Hz is near the limit: lower RATE_HZ or raise BAUD if lines drop.

  if (BUTTON_PIN >= 0) {
    bool b = digitalRead(BUTTON_PIN);
    if (b == LOW && lastButton == HIGH && t - lastButtonMs > 200) {  // 200 ms debounce
      Serial.print(F("# marker t_ms="));
      Serial.print(t);
      Serial.println(F(" note=button"));
      lastButtonMs = t;
    }
    lastButton = b;
  }
}
