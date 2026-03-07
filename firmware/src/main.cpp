#include <Arduino.h>

#include "protocol.hpp"

namespace {

String ReadLine() {
  static String buffer;
  while (Serial.available() > 0) {
    const char c = static_cast<char>(Serial.read());
    if (c == '\n') {
      String line = buffer;
      buffer = "";
      return line;
    }
    if (c != '\r') {
      buffer += c;
    }
  }
  return "";
}

void HandleCommand(const airkvm::Command& cmd) {
  // POC stub: echo command type until HID wiring is integrated.
  switch (cmd.type) {
    case airkvm::CommandType::kMouseMoveRel:
      Serial.println("{\"type\":\"event\",\"event\":\"mouse.move_rel\"}");
      break;
    case airkvm::CommandType::kMouseMoveAbs:
      Serial.println("{\"type\":\"event\",\"event\":\"mouse.move_abs\"}");
      break;
    case airkvm::CommandType::kMouseClick:
      Serial.println("{\"type\":\"event\",\"event\":\"mouse.click\"}");
      break;
    case airkvm::CommandType::kKeyTap:
      Serial.println("{\"type\":\"event\",\"event\":\"key.tap\"}");
      break;
    case airkvm::CommandType::kStateRequest:
      Serial.println("{\"type\":\"state\",\"busy\":false}");
      break;
    case airkvm::CommandType::kUnknown:
      break;
  }
}

}  // namespace

void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println("{\"type\":\"boot\",\"fw\":\"air-kvm-poc\"}");
}

void loop() {
  const String line = ReadLine();
  if (line.length() == 0) {
    delay(5);
    return;
  }

  const auto cmd = airkvm::ParseCommandLine(line.c_str());
  if (!cmd.has_value()) {
    Serial.println("{\"ok\":false,\"error\":\"invalid_command\"}");
    return;
  }

  HandleCommand(*cmd);
  Serial.println("{\"ok\":true}");
}
