// OmniPilot on an ESP32: type a question in the Serial Monitor (115200 baud)
// and the answer comes back from OmniPilot running on a computer or Raspberry
// Pi on the same Wi-Fi. The model runs there; the ESP32 just asks.
//
// On the OmniPilot computer, in server/.env:
//   HOST=0.0.0.0
//   OMNIPILOT_API_TOKEN=<16+ random characters>
// Needs the ArduinoJson library (v7) from the Library Manager.

#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>

const char* WIFI_SSID = "your-wifi";
const char* WIFI_PASSWORD = "your-password";
const char* OMNIPILOT_URL = "http://192.168.1.20:8899/api/ask";  // the OmniPilot computer's IP
const char* OMNIPILOT_TOKEN = "paste-your-token-here";

String ask(const String& question) {
  HTTPClient http;
  http.begin(OMNIPILOT_URL);
  http.setTimeout(120000);  // a small local model can take a while
  http.addHeader("Content-Type", "application/json");
  http.addHeader("Authorization", String("Bearer ") + OMNIPILOT_TOKEN);

  JsonDocument req;
  req["message"] = question;
  req["textOnly"] = true;  // no pictures or diagrams: keeps the reply small
  String body;
  serializeJson(req, body);

  int code = http.POST(body);
  if (code != 200) {
    String err = "HTTP error " + String(code);
    http.end();
    return err;
  }
  JsonDocument res;
  DeserializationError parseError = deserializeJson(res, http.getStream());
  http.end();
  if (parseError) return String("Couldn't read the reply: ") + parseError.c_str();
  return res["answer"].as<String>();
}

void setup() {
  Serial.begin(115200);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.print("Connecting to Wi-Fi");
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.println("\nReady. Type a question and press Enter.");
}

void loop() {
  if (!Serial.available()) return;
  String question = Serial.readStringUntil('\n');
  question.trim();
  if (question.isEmpty()) return;
  Serial.println("> " + question);
  Serial.println(ask(question));
  Serial.println();
}
