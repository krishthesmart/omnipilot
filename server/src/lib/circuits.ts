// HardwarePilot's library of hand-checked connection guides. Each guide is a
// diagram spec the UI draws as an interactive, step-by-step wiring diagram:
// components with named pins, wires between "component.pin" endpoints, and
// steps that light up the wires they add.

export type ComponentKind = "board" | "breadboard" | "led" | "resistor" | "button" | "sensor" | "motor" | "device" | "port" | "power";

export interface DiagramComponent {
  id: string;
  label: string;
  kind: ComponentKind;
  pins: { id: string; label: string }[];
}

export interface DiagramWire {
  from: string; // "componentId.pinId"
  to: string;
  color: string;
  label?: string;
}

export interface DiagramStep {
  text: string;
  /** Indexes into `wires` that this step adds. */
  wires: number[];
  tip?: string;
}

export interface DiagramSpec {
  id: string;
  title: string;
  components: DiagramComponent[];
  wires: DiagramWire[];
  steps: DiagramStep[];
  safety: string[];
  /** Search terms for real how-to videos. */
  videoQuery: string;
  code?: { language: string; source: string };
  /** False for model-drafted guides: the UI labels them as unverified. */
  verified: boolean;
}

const UNO_PINS = [
  { id: "5V", label: "5V" },
  { id: "3V3", label: "3.3V" },
  { id: "GND", label: "GND" },
  { id: "D2", label: "D2" },
  { id: "D9", label: "D9 (PWM)" },
  { id: "D10", label: "D10" },
  { id: "D13", label: "D13" },
  { id: "A0", label: "A0" },
];
const uno = (): DiagramComponent => ({ id: "uno", label: "Arduino Uno", kind: "board", pins: UNO_PINS });

const ARDUINO_SAFETY = [
  "Unplug the USB cable before changing any wires.",
  "Double-check 5V and GND are never wired directly together (a short circuit).",
];

export const CIRCUITS: { match: RegExp; spec: DiagramSpec }[] = [
  {
    match: /\b(leds?|blink\w*|light up)\b.*\barduino\b|\barduino\b.*\b(leds?|blink\w*|light up)\b/i,
    spec: {
      id: "arduino-led",
      title: "Blink an LED with an Arduino",
      components: [
        uno(),
        { id: "r1", label: "220 Ω resistor", kind: "resistor", pins: [{ id: "a", label: "end 1" }, { id: "b", label: "end 2" }] },
        { id: "led", label: "LED", kind: "led", pins: [{ id: "anode", label: "+ long leg (anode)" }, { id: "cathode", label: "− short leg (cathode)" }] },
      ],
      wires: [
        { from: "uno.D13", to: "r1.a", color: "#f59e0b", label: "signal" },
        { from: "r1.b", to: "led.anode", color: "#f59e0b" },
        { from: "led.cathode", to: "uno.GND", color: "#111827", label: "ground" },
      ],
      steps: [
        { text: "Connect pin D13 on the Arduino to one end of the 220 Ω resistor.", wires: [0], tip: "A resistor works either way round." },
        { text: "Connect the other end of the resistor to the LED's long leg (+, the anode).", wires: [1], tip: "The resistor limits the current so the LED doesn't burn out." },
        { text: "Connect the LED's short leg (−, the cathode) to GND on the Arduino.", wires: [2], tip: "The flat edge on the LED's rim marks the short leg." },
        { text: "Plug in the USB cable and upload the code. The LED should blink once a second.", wires: [] },
      ],
      safety: [...ARDUINO_SAFETY, "Never connect an LED without a resistor; it can burn out the LED or the pin."],
      videoQuery: "arduino blink external led resistor beginner",
      code: {
        language: "cpp",
        source: `void setup() {\n  pinMode(13, OUTPUT);\n}\n\nvoid loop() {\n  digitalWrite(13, HIGH); // LED on\n  delay(1000);\n  digitalWrite(13, LOW);  // LED off\n  delay(1000);\n}`,
      },
      verified: true,
    },
  },
  {
    match: /\b(button|push ?button|switch)\b.*\barduino\b|\barduino\b.*\b(button|push ?button|switch)\b/i,
    spec: {
      id: "arduino-button",
      title: "Read a push button with an Arduino",
      components: [uno(), { id: "btn", label: "Push button", kind: "button", pins: [{ id: "a", label: "leg A" }, { id: "b", label: "leg B (diagonal to A)" }] }],
      wires: [
        { from: "uno.D2", to: "btn.a", color: "#3b82f6", label: "input" },
        { from: "btn.b", to: "uno.GND", color: "#111827", label: "ground" },
      ],
      steps: [
        { text: "Connect pin D2 to one leg of the button.", wires: [0] },
        { text: "Connect the diagonally opposite leg to GND.", wires: [1], tip: "Using diagonal legs makes sure you go across the switch, not along a leg that's always connected." },
        { text: "Upload the code and open the Serial Monitor: pressing the button prints \"pressed\".", wires: [], tip: "INPUT_PULLUP uses the Arduino's built-in resistor, so no extra resistor is needed." },
      ],
      safety: ARDUINO_SAFETY,
      videoQuery: "arduino push button INPUT_PULLUP tutorial",
      code: {
        language: "cpp",
        source: `void setup() {\n  pinMode(2, INPUT_PULLUP);\n  Serial.begin(9600);\n}\n\nvoid loop() {\n  if (digitalRead(2) == LOW) { // LOW = pressed with INPUT_PULLUP\n    Serial.println("pressed");\n    delay(200);\n  }\n}`,
      },
      verified: true,
    },
  },
  {
    match: /\bservo\b/i,
    spec: {
      id: "arduino-servo",
      title: "Control a servo motor with an Arduino",
      components: [
        uno(),
        { id: "servo", label: "Servo (SG90)", kind: "motor", pins: [{ id: "sig", label: "signal (orange/yellow)" }, { id: "vcc", label: "power (red)" }, { id: "gnd", label: "ground (brown/black)" }] },
      ],
      wires: [
        { from: "servo.sig", to: "uno.D9", color: "#f59e0b", label: "signal" },
        { from: "servo.vcc", to: "uno.5V", color: "#ef4444", label: "5V" },
        { from: "servo.gnd", to: "uno.GND", color: "#111827", label: "ground" },
      ],
      steps: [
        { text: "Connect the servo's brown/black wire to GND.", wires: [2], tip: "Connect ground first; it's a good habit." },
        { text: "Connect the red wire to 5V.", wires: [1] },
        { text: "Connect the orange/yellow signal wire to pin D9.", wires: [0] },
        { text: "Upload the code: the servo sweeps from 0° to 180° and back.", wires: [] },
      ],
      safety: [...ARDUINO_SAFETY, "One small servo is fine on USB power; for bigger or multiple servos use a separate 5V supply with a shared ground."],
      videoQuery: "arduino sg90 servo wiring tutorial",
      code: {
        language: "cpp",
        source: `#include <Servo.h>\n\nServo servo;\n\nvoid setup() {\n  servo.attach(9);\n}\n\nvoid loop() {\n  for (int a = 0; a <= 180; a++) { servo.write(a); delay(10); }\n  for (int a = 180; a >= 0; a--) { servo.write(a); delay(10); }\n}`,
      },
      verified: true,
    },
  },
  {
    match: /\b(potentiometer|pot|knob)\b/i,
    spec: {
      id: "arduino-pot",
      title: "Read a potentiometer (knob) with an Arduino",
      components: [uno(), { id: "pot", label: "10 kΩ potentiometer", kind: "sensor", pins: [{ id: "l", label: "left leg" }, { id: "w", label: "middle leg (wiper)" }, { id: "r", label: "right leg" }] }],
      wires: [
        { from: "pot.l", to: "uno.5V", color: "#ef4444", label: "5V" },
        { from: "pot.w", to: "uno.A0", color: "#22c55e", label: "reading" },
        { from: "pot.r", to: "uno.GND", color: "#111827", label: "ground" },
      ],
      steps: [
        { text: "Connect the left leg to 5V.", wires: [0] },
        { text: "Connect the right leg to GND.", wires: [2] },
        { text: "Connect the middle leg to A0.", wires: [1], tip: "The middle leg's voltage changes as you turn the knob; A0 measures it as 0–1023." },
        { text: "Upload the code and open the Serial Monitor; turn the knob to see the number change.", wires: [] },
      ],
      safety: ARDUINO_SAFETY,
      videoQuery: "arduino potentiometer analogRead tutorial",
      code: { language: "cpp", source: `void setup() {\n  Serial.begin(9600);\n}\n\nvoid loop() {\n  Serial.println(analogRead(A0)); // 0-1023\n  delay(100);\n}` },
      verified: true,
    },
  },
  {
    match: /\b(ultrasonic|hc-?sr04|distance sensor)\b/i,
    spec: {
      id: "arduino-ultrasonic",
      title: "Measure distance with an HC-SR04 ultrasonic sensor",
      components: [uno(), { id: "us", label: "HC-SR04", kind: "sensor", pins: [{ id: "vcc", label: "VCC" }, { id: "trig", label: "Trig" }, { id: "echo", label: "Echo" }, { id: "gnd", label: "GND" }] }],
      wires: [
        { from: "us.vcc", to: "uno.5V", color: "#ef4444", label: "5V" },
        { from: "us.gnd", to: "uno.GND", color: "#111827", label: "ground" },
        { from: "us.trig", to: "uno.D9", color: "#3b82f6", label: "trigger" },
        { from: "us.echo", to: "uno.D10", color: "#22c55e", label: "echo" },
      ],
      steps: [
        { text: "Connect VCC to 5V and GND to GND.", wires: [0, 1] },
        { text: "Connect Trig to pin D9.", wires: [2], tip: "Trig sends out a sound pulse." },
        { text: "Connect Echo to pin D10.", wires: [3], tip: "Echo reports how long the pulse took to bounce back." },
        { text: "Upload the code and open the Serial Monitor to see the distance in cm.", wires: [] },
      ],
      safety: ARDUINO_SAFETY,
      videoQuery: "arduino hc-sr04 ultrasonic sensor tutorial",
      code: {
        language: "cpp",
        source: `const int TRIG = 9, ECHO = 10;\n\nvoid setup() {\n  pinMode(TRIG, OUTPUT);\n  pinMode(ECHO, INPUT);\n  Serial.begin(9600);\n}\n\nvoid loop() {\n  digitalWrite(TRIG, LOW); delayMicroseconds(2);\n  digitalWrite(TRIG, HIGH); delayMicroseconds(10);\n  digitalWrite(TRIG, LOW);\n  long us = pulseIn(ECHO, HIGH);\n  Serial.println(us * 0.0343 / 2); // cm\n  delay(200);\n}`,
      },
      verified: true,
    },
  },
  {
    match: /\b(raspberry ?pi|rpi)\b.*\b(leds?|light up|gpio)\b|\b(leds?|light up|gpio)\b.*\b(raspberry ?pi|rpi)\b/i,
    spec: {
      id: "pi-led",
      title: "Light an LED from a Raspberry Pi",
      components: [
        { id: "pi", label: "Raspberry Pi (40-pin header)", kind: "board", pins: [{ id: "p11", label: "pin 11 (GPIO17)" }, { id: "p6", label: "pin 6 (GND)" }, { id: "p1", label: "pin 1 (3.3V)" }] },
        { id: "r1", label: "330 Ω resistor", kind: "resistor", pins: [{ id: "a", label: "end 1" }, { id: "b", label: "end 2" }] },
        { id: "led", label: "LED", kind: "led", pins: [{ id: "anode", label: "+ long leg" }, { id: "cathode", label: "− short leg" }] },
      ],
      wires: [
        { from: "pi.p11", to: "r1.a", color: "#f59e0b", label: "GPIO17" },
        { from: "r1.b", to: "led.anode", color: "#f59e0b" },
        { from: "led.cathode", to: "pi.p6", color: "#111827", label: "ground" },
      ],
      steps: [
        { text: "Shut down the Pi and unplug its power.", wires: [] },
        { text: "Connect physical pin 11 (GPIO17) to one end of the 330 Ω resistor.", wires: [0], tip: "Pin 1 is the corner pin next to the square solder pad; numbers go 1, 2 across, then down." },
        { text: "Connect the resistor's other end to the LED's long leg.", wires: [1] },
        { text: "Connect the LED's short leg to physical pin 6 (GND).", wires: [2] },
        { text: "Power the Pi back on and run the Python script.", wires: [] },
      ],
      safety: ["Raspberry Pi pins are 3.3V only: never connect 5V to a GPIO pin.", "Power off before wiring."],
      videoQuery: "raspberry pi gpio led gpiozero beginner",
      code: { language: "python", source: `from gpiozero import LED\nfrom time import sleep\n\nled = LED(17)\nwhile True:\n    led.toggle()\n    sleep(1)` },
      verified: true,
    },
  },
  {
    match: /\b(dht11|dht22|temperature sensor|humidity)\b/i,
    spec: {
      id: "arduino-dht11",
      title: "Read temperature with a DHT11 sensor module",
      components: [uno(), { id: "dht", label: "DHT11 module (3 pins)", kind: "sensor", pins: [{ id: "vcc", label: "+ / VCC" }, { id: "data", label: "OUT / DATA" }, { id: "gnd", label: "− / GND" }] }],
      wires: [
        { from: "dht.vcc", to: "uno.5V", color: "#ef4444", label: "5V" },
        { from: "dht.data", to: "uno.D2", color: "#22c55e", label: "data" },
        { from: "dht.gnd", to: "uno.GND", color: "#111827", label: "ground" },
      ],
      steps: [
        { text: "Connect the module's + pin to 5V and − pin to GND.", wires: [0, 2] },
        { text: "Connect the OUT/DATA pin to D2.", wires: [1], tip: "3-pin modules already include the pull-up resistor; a bare 4-pin sensor needs a 10 kΩ resistor from DATA to 5V." },
        { text: "Install the \"DHT sensor library\" in the Arduino IDE, upload the code, and open the Serial Monitor.", wires: [] },
      ],
      safety: ARDUINO_SAFETY,
      videoQuery: "arduino dht11 temperature sensor module tutorial",
      code: {
        language: "cpp",
        source: `#include <DHT.h>\n\nDHT dht(2, DHT11);\n\nvoid setup() {\n  Serial.begin(9600);\n  dht.begin();\n}\n\nvoid loop() {\n  Serial.print(dht.readTemperature());\n  Serial.println(" C");\n  delay(2000);\n}`,
      },
      verified: true,
    },
  },
  {
    match: /\b(photoresistor|ldr|light[- ]dependent resistor|photocell)\b(?![^.?!]*\bmodule\b)/i,
    spec: {
      id: "arduino-ldr",
      title: "Read light levels with a photoresistor (LDR)",
      components: [
        { id: "uno", label: "Arduino Uno", kind: "board", pins: [{ id: "5V", label: "5V" }, { id: "A0", label: "A0" }, { id: "GND", label: "GND" }] },
        { id: "ldr", label: "Photoresistor (LDR)", kind: "sensor", pins: [{ id: "a", label: "leg 1" }, { id: "b", label: "leg 2" }] },
        { id: "r1", label: "10 kΩ resistor", kind: "resistor", pins: [{ id: "a", label: "end 1" }, { id: "b", label: "end 2" }] },
      ],
      wires: [
        { from: "uno.5V", to: "ldr.a", color: "#ef4444", label: "5V" },
        { from: "ldr.b", to: "uno.A0", color: "#22c55e", label: "reading" },
        { from: "r1.a", to: "uno.A0", color: "#22c55e", label: "reading" },
        { from: "r1.b", to: "uno.GND", color: "#111827", label: "ground" },
      ],
      steps: [
        { text: "Connect one leg of the photoresistor to 5V.", wires: [0], tip: "A photoresistor works either way round." },
        { text: "Connect its other leg to A0.", wires: [1] },
        { text: "Also connect one end of the 10 kΩ resistor to A0 (on a breadboard, put it in the same row as the photoresistor's leg).", wires: [2] },
        { text: "Connect the resistor's other end to GND.", wires: [3], tip: "The two parts form a \"voltage divider\": more light means a higher reading on A0." },
        { text: "Upload the code and open the Serial Monitor; cover the sensor to see the number drop.", wires: [] },
      ],
      safety: ARDUINO_SAFETY,
      videoQuery: "arduino photoresistor ldr voltage divider tutorial",
      code: { language: "cpp", source: `void setup() {\n  Serial.begin(9600);\n}\n\nvoid loop() {\n  Serial.println(analogRead(A0)); // brighter = higher\n  delay(200);\n}` },
      verified: true,
    },
  },
  {
    match: /\b(buzzer|piezo|beep|tone)\b/i,
    spec: {
      id: "arduino-buzzer",
      title: "Make a beep with a buzzer and an Arduino",
      components: [uno(), { id: "bz", label: "Piezo buzzer", kind: "device", pins: [{ id: "pos", label: "+ (longer leg)" }, { id: "neg", label: "− (shorter leg)" }] }],
      wires: [
        { from: "uno.D9", to: "bz.pos", color: "#f59e0b", label: "signal" },
        { from: "bz.neg", to: "uno.GND", color: "#111827", label: "ground" },
      ],
      steps: [
        { text: "Connect the buzzer's + leg (longer, or marked +) to pin D9.", wires: [0] },
        { text: "Connect the buzzer's − leg to GND.", wires: [1] },
        { text: "Upload the code: the buzzer beeps once a second.", wires: [], tip: "tone() works for both active and passive buzzers; a passive one can play different notes." },
      ],
      safety: ARDUINO_SAFETY,
      videoQuery: "arduino piezo buzzer tone tutorial",
      code: {
        language: "cpp",
        source: `void setup() {}

void loop() {
  tone(9, 1000);   // 1 kHz beep
  delay(300);
  noTone(9);
  delay(700);
}`,
      },
      verified: true,
    },
  },
  {
    match: /\b(monitor|display|screen|tv)\b.*\b(laptop|computer|pc|mac)\b|\b(laptop|computer|pc|mac)\b.*\b(monitor|display|screen|tv)\b|\bhdmi\b/i,
    spec: {
      id: "laptop-monitor",
      title: "Connect a laptop to an external monitor",
      components: [
        { id: "laptop", label: "Laptop", kind: "device", pins: [{ id: "hdmi", label: "HDMI port (or USB-C with a USB-C→HDMI adapter)" }, { id: "power", label: "charger port" }] },
        { id: "cable", label: "HDMI cable", kind: "port", pins: [{ id: "end1", label: "end 1" }, { id: "end2", label: "end 2" }] },
        { id: "monitor", label: "Monitor", kind: "device", pins: [{ id: "hdmi", label: "HDMI in" }, { id: "power", label: "power in" }] },
        { id: "outlet", label: "Wall outlet", kind: "power", pins: [{ id: "a", label: "socket" }, { id: "b", label: "socket" }] },
      ],
      wires: [
        { from: "monitor.power", to: "outlet.a", color: "#111827", label: "power" },
        { from: "laptop.hdmi", to: "cable.end1", color: "#6366f1", label: "video" },
        { from: "cable.end2", to: "monitor.hdmi", color: "#6366f1", label: "video" },
        { from: "laptop.power", to: "outlet.b", color: "#111827", label: "charger" },
      ],
      steps: [
        { text: "Plug the monitor into power and switch it on.", wires: [0] },
        { text: "Plug one end of the HDMI cable into the laptop.", wires: [1], tip: "No HDMI port? Use a USB-C (Thunderbolt) to HDMI adapter." },
        { text: "Plug the other end into the monitor's HDMI input.", wires: [2] },
        { text: "Use the monitor's buttons to pick that HDMI input. On the laptop, Windows: press Win+P; Mac: System Settings → Displays.", wires: [], tip: "Choose \"Extend\" for two separate screens or \"Duplicate\" to show the same thing." },
        { text: "Plug in the laptop charger; external screens use extra battery.", wires: [3] },
      ],
      safety: ["Push connectors straight in; never force a plug the wrong way up."],
      videoQuery: "how to connect laptop to external monitor hdmi",
      verified: true,
    },
  },
  {
    match: /\b(desktop|pc|computer|tower)\b.*\b(set ?up|connect|plug|hook)|\b(set ?up|connect|plug|hook)\b.*\b(desktop|pc|tower)\b/i,
    spec: {
      id: "desktop-setup",
      title: "Set up a desktop PC",
      components: [
        { id: "pc", label: "PC tower (back panel)", kind: "device", pins: [{ id: "psu", label: "power socket (PSU)" }, { id: "gpu", label: "graphics card port (lower, horizontal)" }, { id: "usb", label: "USB ports" }, { id: "lan", label: "Ethernet port" }] },
        { id: "monitor", label: "Monitor", kind: "device", pins: [{ id: "in", label: "DisplayPort/HDMI in" }, { id: "power", label: "power in" }] },
        { id: "kbm", label: "Keyboard & mouse", kind: "device", pins: [{ id: "usb", label: "USB plugs" }] },
        { id: "router", label: "Wi-Fi router", kind: "device", pins: [{ id: "lan", label: "LAN port" }] },
        { id: "outlet", label: "Power strip", kind: "power", pins: [{ id: "a", label: "socket" }, { id: "b", label: "socket" }] },
      ],
      wires: [
        { from: "pc.gpu", to: "monitor.in", color: "#6366f1", label: "video" },
        { from: "kbm.usb", to: "pc.usb", color: "#3b82f6", label: "USB" },
        { from: "pc.lan", to: "router.lan", color: "#22c55e", label: "internet (optional)" },
        { from: "monitor.power", to: "outlet.a", color: "#111827", label: "power" },
        { from: "pc.psu", to: "outlet.b", color: "#111827", label: "power" },
      ],
      steps: [
        { text: "Connect the monitor cable to the graphics card's port, the lower horizontal row on the back.", wires: [0], tip: "If the PC has a graphics card, the ports higher up (on the motherboard) usually show nothing: a very common mistake." },
        { text: "Plug the keyboard and mouse into USB ports.", wires: [1] },
        { text: "Optional: connect an Ethernet cable from the PC to the router for faster, steadier internet.", wires: [2] },
        { text: "Plug the monitor and the PC into the power strip.", wires: [3, 4] },
        { text: "Flip the switch on the back of the PC's power supply to | (on), then press the power button on the front.", wires: [] },
      ],
      safety: ["Plug in power last.", "Don't open the case while it's plugged in."],
      videoQuery: "how to set up a desktop pc cables beginner",
      verified: true,
    },
  },
];

// --- Module catalog: common breakout modules, wired by pin role (correct by construction) ---

type ModulePinRole = "vcc" | "gnd" | "analog" | "digital" | "sda" | "scl";

interface ModuleEntry {
  match: RegExp;
  id: string;
  name: string;
  /** Pins in the order printed on most boards. */
  pins: { id: string; label: string; role: ModulePinRole; purpose?: string }[];
  supply: "5V" | "3V3";
  safety?: string[];
  code: string;
  videoQuery: string;
}

export const MODULES: ModuleEntry[] = [
  {
    match: /\bjoystick\b/i, id: "joystick", name: "Joystick module", supply: "5V", videoQuery: "arduino joystick module tutorial",
    pins: [{ id: "gnd", label: "GND", role: "gnd" }, { id: "vcc", label: "+5V", role: "vcc" }, { id: "vrx", label: "VRx", role: "analog", purpose: "left/right position" }, { id: "vry", label: "VRy", role: "analog", purpose: "up/down position" }, { id: "sw", label: "SW", role: "digital", purpose: "press button (use INPUT_PULLUP)" }],
    code: `void setup() {\n  pinMode(2, INPUT_PULLUP);\n  Serial.begin(9600);\n}\n\nvoid loop() {\n  Serial.print(analogRead(A0)); Serial.print(" ");\n  Serial.print(analogRead(A1)); Serial.print(" ");\n  Serial.println(digitalRead(2) == LOW ? "pressed" : "");\n  delay(100);\n}`,
  },
  {
    match: /\b(pir|motion sensor|hc-?sr501)\b/i, id: "pir", name: "PIR motion sensor (HC-SR501)", supply: "5V", videoQuery: "arduino pir motion sensor hc-sr501 tutorial",
    pins: [{ id: "vcc", label: "VCC", role: "vcc" }, { id: "out", label: "OUT", role: "digital", purpose: "goes HIGH when motion is seen" }, { id: "gnd", label: "GND", role: "gnd" }],
    code: `void setup() {\n  pinMode(2, INPUT);\n  Serial.begin(9600);\n}\n\nvoid loop() {\n  if (digitalRead(2) == HIGH) Serial.println("motion!");\n  delay(200);\n}`,
  },
  {
    match: /\b(ir (obstacle|proximity|sensor)|obstacle (avoidance )?sensor|line (tracking|follower) sensor)\b/i, id: "ir-obstacle", name: "IR obstacle sensor", supply: "5V", videoQuery: "arduino ir obstacle avoidance sensor tutorial",
    pins: [{ id: "vcc", label: "VCC", role: "vcc" }, { id: "gnd", label: "GND", role: "gnd" }, { id: "out", label: "OUT", role: "digital", purpose: "LOW when something is close" }],
    code: `void setup() {\n  pinMode(2, INPUT);\n  Serial.begin(9600);\n}\n\nvoid loop() {\n  Serial.println(digitalRead(2) == LOW ? "obstacle" : "clear");\n  delay(200);\n}`,
  },
  {
    match: /\b(soil moisture|moisture sensor)\b/i, id: "soil", name: "Soil moisture sensor", supply: "5V", videoQuery: "arduino soil moisture sensor tutorial",
    pins: [{ id: "vcc", label: "VCC", role: "vcc" }, { id: "gnd", label: "GND", role: "gnd" }, { id: "ao", label: "AO", role: "analog", purpose: "wetter soil changes the reading" }],
    code: `void setup() {\n  Serial.begin(9600);\n}\n\nvoid loop() {\n  Serial.println(analogRead(A0));\n  delay(500);\n}`,
  },
  {
    match: /\b(sound sensor|microphone module|sound detector)\b/i, id: "sound", name: "Sound sensor module", supply: "5V", videoQuery: "arduino sound sensor module tutorial",
    pins: [{ id: "vcc", label: "VCC", role: "vcc" }, { id: "gnd", label: "GND", role: "gnd" }, { id: "ao", label: "AO", role: "analog", purpose: "loudness" }],
    code: `void setup() {\n  Serial.begin(9600);\n}\n\nvoid loop() {\n  Serial.println(analogRead(A0));\n  delay(50);\n}`,
  },
  {
    match: /\b(water (level )?sensor|rain sensor)\b/i, id: "water", name: "Water level sensor", supply: "5V", videoQuery: "arduino water level sensor tutorial",
    pins: [{ id: "s", label: "S", role: "analog", purpose: "water level" }, { id: "vcc", label: "+", role: "vcc" }, { id: "gnd", label: "−", role: "gnd" }],
    code: `void setup() {\n  Serial.begin(9600);\n}\n\nvoid loop() {\n  Serial.println(analogRead(A0));\n  delay(500);\n}`,
  },
  {
    match: /\b(gas sensor|mq-?\d+|smoke sensor)\b/i, id: "gas", name: "MQ gas sensor module", supply: "5V", videoQuery: "arduino mq2 gas sensor tutorial",
    pins: [{ id: "vcc", label: "VCC", role: "vcc" }, { id: "gnd", label: "GND", role: "gnd" }, { id: "ao", label: "AO", role: "analog", purpose: "gas level" }],
    safety: ["MQ sensors get hot while working; don't touch the metal cap.", "It's a hobby sensor, not a safety alarm."],
    code: `void setup() {\n  Serial.begin(9600);\n}\n\nvoid loop() {\n  Serial.println(analogRead(A0));\n  delay(500);\n}`,
  },
  {
    match: /\brelay\b/i, id: "relay", name: "Relay module", supply: "5V", videoQuery: "arduino relay module tutorial low voltage",
    pins: [{ id: "vcc", label: "VCC", role: "vcc" }, { id: "gnd", label: "GND", role: "gnd" }, { id: "in", label: "IN", role: "digital", purpose: "switches the relay" }],
    safety: ["Only switch low-voltage things (like a 5–12V lamp or fan). Never wire mains (wall) electricity yourself: ask a qualified adult."],
    code: `void setup() {\n  pinMode(2, OUTPUT);\n}\n\nvoid loop() {\n  digitalWrite(2, HIGH); delay(2000); // many modules switch ON at LOW instead\n  digitalWrite(2, LOW);  delay(2000);\n}`,
  },
  {
    match: /\b(lcd|16x2|1602)\b/i, id: "lcd-i2c", name: "16x2 LCD with I2C backpack", supply: "5V", videoQuery: "arduino 16x2 lcd i2c tutorial",
    pins: [{ id: "gnd", label: "GND", role: "gnd" }, { id: "vcc", label: "VCC", role: "vcc" }, { id: "sda", label: "SDA", role: "sda" }, { id: "scl", label: "SCL", role: "scl" }],
    code: `#include <LiquidCrystal_I2C.h>\n\nLiquidCrystal_I2C lcd(0x27, 16, 2); // try 0x3F if blank\n\nvoid setup() {\n  lcd.init();\n  lcd.backlight();\n  lcd.print("Hello!");\n}\n\nvoid loop() {}`,
  },
  {
    match: /\b(oled|ssd1306)\b/i, id: "oled", name: "0.96\" OLED display (SSD1306, I2C)", supply: "5V", videoQuery: "arduino ssd1306 oled i2c tutorial",
    pins: [{ id: "gnd", label: "GND", role: "gnd" }, { id: "vcc", label: "VCC", role: "vcc" }, { id: "scl", label: "SCL", role: "scl" }, { id: "sda", label: "SDA", role: "sda" }],
    code: `#include <Adafruit_SSD1306.h>\n\nAdafruit_SSD1306 display(128, 64, &Wire);\n\nvoid setup() {\n  display.begin(SSD1306_SWITCHCAPVCC, 0x3C);\n  display.clearDisplay();\n  display.setTextColor(SSD1306_WHITE);\n  display.println("Hello!");\n  display.display();\n}\n\nvoid loop() {}`,
  },
  {
    match: /\b(rotary encoder|encoder knob)\b/i, id: "encoder", name: "Rotary encoder module", supply: "5V", videoQuery: "arduino rotary encoder module tutorial",
    pins: [{ id: "clk", label: "CLK", role: "digital", purpose: "rotation" }, { id: "dt", label: "DT", role: "digital", purpose: "direction" }, { id: "sw", label: "SW", role: "digital", purpose: "press" }, { id: "vcc", label: "+", role: "vcc" }, { id: "gnd", label: "GND", role: "gnd" }],
    code: `void setup() {\n  pinMode(2, INPUT); pinMode(3, INPUT); pinMode(4, INPUT_PULLUP);\n  Serial.begin(9600);\n}\n\nint last = HIGH;\nvoid loop() {\n  int clk = digitalRead(2);\n  if (clk != last && clk == LOW) Serial.println(digitalRead(3) != clk ? "right" : "left");\n  last = clk;\n}`,
  },
];

const ROLE_STYLE: Record<ModulePinRole, string> = { vcc: "#ef4444", gnd: "#111827", analog: "#22c55e", digital: "#3b82f6", sda: "#8b5cf6", scl: "#eab308" };

/** Builds a guide for a catalog module: each pin goes to the next free Arduino pin of the right kind. */
export function moduleGuide(m: ModuleEntry): DiagramSpec {
  const analog = ["A0", "A1", "A2", "A3"];
  const digital = ["D2", "D3", "D4", "D5"];
  const target = (role: ModulePinRole) =>
    role === "vcc" ? m.supply : role === "gnd" ? "GND" : role === "analog" ? analog.shift()! : role === "digital" ? digital.shift()! : role === "sda" ? "A4" : "A5";
  const assignments = m.pins.map((p) => ({ pin: p, board: target(p.role) }));
  const boardPins = Array.from(new Set(assignments.map((a) => a.board))).map((id) => ({
    id,
    label: id === "A4" ? "A4 (SDA)" : id === "A5" ? "A5 (SCL)" : id === "3V3" ? "3.3V" : id,
  }));
  const wires = assignments.map((a) => ({ from: `mod.${a.pin.id}`, to: `uno.${a.board}`, color: ROLE_STYLE[a.pin.role], label: a.pin.purpose ?? a.pin.role }));
  const power = assignments.map((a, i) => ({ a, i })).filter(({ a }) => a.pin.role === "vcc" || a.pin.role === "gnd");
  const signals = assignments.map((a, i) => ({ a, i })).filter(({ a }) => a.pin.role !== "vcc" && a.pin.role !== "gnd");
  return {
    id: `module-${m.id}`,
    title: `Connect a ${m.name} to an Arduino`,
    components: [
      { id: "uno", label: "Arduino Uno", kind: "board", pins: boardPins },
      { id: "mod", label: m.name, kind: "sensor", pins: m.pins.map((p) => ({ id: p.id, label: p.label })) },
    ],
    wires,
    steps: [
      { text: `Connect power: ${power.map(({ a }) => `${a.pin.label} → ${a.board === "3V3" ? "3.3V" : a.board}`).join(", ")}.`, wires: power.map(({ i }) => i) },
      ...signals.map(({ a, i }) => ({
        text: `Connect ${a.pin.label} to ${a.board === "A4" ? "A4 (SDA)" : a.board === "A5" ? "A5 (SCL)" : a.board}.`,
        wires: [i],
        tip: a.pin.purpose ? `${a.pin.label}: ${a.pin.purpose}.` : a.pin.role === "sda" || a.pin.role === "scl" ? "On an Uno, I2C uses A4 (SDA) and A5 (SCL); newer boards also have labeled SDA/SCL pins." : undefined,
      })),
      { text: "Upload the code and open the Serial Monitor (or watch the display).", wires: [] },
    ],
    safety: [...ARDUINO_SAFETY, ...(m.safety ?? []), "Pin order differs between sellers: match the labels printed on your module, not the position."],
    videoQuery: m.videoQuery,
    code: { language: "cpp", source: m.code },
    verified: true,
  };
}

type PinRole = "power" | "ground" | "io" | "other";

/** What a pin is, from its id/label: rails (5V, 3.3V, VCC), ground, or a board's signal pin. */
function pinRole(kind: ComponentKind, pin: { id: string; label: string }): PinRole {
  const text = `${pin.id} ${pin.label}`;
  if (/\b(gnd|ground|vss|0v)\b/i.test(text)) return "ground";
  if (/\b(5v|3v3|3\.3v|vcc|vin|vdd|12v|power)\b/i.test(text) && kind !== "device" && kind !== "port") return "power";
  if (kind === "board" && /\b(d\d+|a\d+|gpio\s?\d+|io\d+|pin\s?\d+)\b/i.test(text)) return "io";
  return "other";
}

/**
 * Electrical sanity check over the connected groups of pins ("nets"): a net
 * must never join power to ground (a short), tie a power rail to a board's
 * signal pin, or join two board signal pins. Returns the problem, or null.
 */
export function electricalProblem(spec: Pick<DiagramSpec, "components" | "wires">): string | null {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    while (parent.get(x) && parent.get(x) !== x) x = parent.get(x)!;
    return x;
  };
  const roles = new Map<string, { role: PinRole; name: string }>();
  for (const c of spec.components) {
    for (const p of c.pins) {
      const ref = `${c.id}.${p.id}`;
      parent.set(ref, ref);
      roles.set(ref, { role: pinRole(c.kind, p), name: `${c.label} ${p.label}` });
    }
  }
  for (const w of spec.wires) if (parent.has(w.from) && parent.has(w.to)) parent.set(find(w.from), find(w.to));

  const nets = new Map<string, { role: PinRole; name: string }[]>();
  for (const [ref, r] of roles) nets.set(find(ref), [...(nets.get(find(ref)) ?? []), r]);
  for (const net of nets.values()) {
    const of = (role: PinRole) => net.filter((n) => n.role === role);
    if (of("power").length && of("ground").length) return `${of("power")[0].name} is connected to ${of("ground")[0].name}: that's a short circuit.`;
    if (of("power").length && of("io").length) return `${of("io")[0].name} is tied directly to ${of("power")[0].name}; a signal pin must not be wired to a power rail.`;
    if (of("io").length > 1) return `${of("io")[0].name} and ${of("io")[1].name} are wired together; each part's pin should go to one board pin.`;
  }
  return null;
}

export function findCircuit(text: string): DiagramSpec | null {
  const curated = CIRCUITS.find((c) => c.match.test(text))?.spec;
  if (curated) return curated;
  const module = MODULES.find((m) => m.match.test(text));
  return module ? moduleGuide(module) : null;
}

/** All hand-checked guides, including generated module guides (for tests and the "guides I know" list). */
export function allGuides(): DiagramSpec[] {
  return [...CIRCUITS.map((c) => c.spec), ...MODULES.map(moduleGuide)];
}

/** Pin names a step mentions (D13, A0, 5V, 3.3V, GND) must be on wires that step actually adds. */
export function stepsInconsistent(spec: DiagramSpec): string | null {
  const label = new Map<string, string>(spec.components.flatMap((c) => c.pins.map((p): [string, string] => [`${c.id}.${p.id}`, `${p.id} ${p.label}`])));
  for (const step of spec.steps) {
    const mentioned = step.text.match(/\b(D\d{1,2}|A\d|5V|3\.3V|GND)\b/g) ?? [];
    const wired = step.wires.flatMap((i) => [spec.wires[i].from, spec.wires[i].to].map((ref) => label.get(ref) ?? ref)).join(" ").toLowerCase();
    const missing = mentioned.filter((m) => !wired.includes(m.toLowerCase()) && !(m === "3.3V" && wired.includes("3v3")));
    if (missing.length) return `step "${step.text}" mentions ${missing.join(", ")} but doesn't wire it`;
  }
  return null;
}

/**
 * Keeps only the parts of a model-drafted spec that make sense: wires must join
 * two real pins, steps may only reference real wires. Returns null if nothing
 * drawable is left.
 */
export function validateSpec(raw: any): DiagramSpec | null {
  if (!raw || !Array.isArray(raw.components) || !Array.isArray(raw.wires)) return null;
  const components: DiagramComponent[] = raw.components
    .filter((c: any) => typeof c?.id === "string" && typeof c?.label === "string" && Array.isArray(c?.pins))
    .map((c: any) => ({
      id: c.id,
      label: c.label,
      kind: ["board", "breadboard", "led", "resistor", "button", "sensor", "motor", "device", "port", "power"].includes(c.kind) ? c.kind : "device",
      pins: c.pins.filter((p: any) => typeof p?.id === "string").map((p: any) => ({ id: p.id, label: typeof p.label === "string" ? p.label : p.id })),
    }));
  const pinIds = new Set(components.flatMap((c) => c.pins.map((p) => `${c.id}.${p.id}`)));
  const wireMap: number[] = [];
  const wires: DiagramWire[] = [];
  raw.wires.forEach((w: any, i: number) => {
    if (pinIds.has(w?.from) && pinIds.has(w?.to) && w.from !== w.to) {
      wireMap[i] = wires.length;
      wires.push({ from: w.from, to: w.to, color: /^#[0-9a-f]{6}$/i.test(w.color) ? w.color : "#6366f1", label: typeof w.label === "string" ? w.label : undefined });
    }
  });
  if (wires.length === 0) return null;
  const steps: DiagramStep[] = (Array.isArray(raw.steps) ? raw.steps : [])
    .filter((s: any) => typeof s?.text === "string")
    .map((s: any) => ({
      text: s.text,
      wires: (Array.isArray(s.wires) ? s.wires : []).map((i: unknown) => (typeof i === "number" ? wireMap[i] : undefined)).filter((i: unknown): i is number => typeof i === "number"),
      tip: typeof s.tip === "string" ? s.tip : undefined,
    }));
  return {
    id: "drafted",
    title: typeof raw.title === "string" ? raw.title : "How to connect it",
    components,
    wires,
    steps: steps.length ? steps : wires.map((w, i) => ({ text: `Connect ${w.from} to ${w.to}.`, wires: [i] })),
    safety: Array.isArray(raw.safety) ? raw.safety.filter((s: unknown) => typeof s === "string") : [],
    videoQuery: typeof raw.videoQuery === "string" ? raw.videoQuery : (typeof raw.title === "string" ? raw.title : "how to connect"),
    verified: false,
  };
}
