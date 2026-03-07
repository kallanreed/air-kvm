#pragma once

#include <Arduino.h>

class NimBLEAdvertising;
class NimBLECharacteristic;
class NimBLEHIDDevice;
class NimBLEServer;

namespace airkvm::fw {

class HidController {
 public:
  HidController() = default;

  void Setup(NimBLEServer* server, NimBLEAdvertising* advertising);

  bool SendMouseMoveRel(int dx, int dy);
  bool SendMouseClick(const String& button);
  bool SendKeyTap(const String& key);

 private:
  static int8_t ClampAxis(int value);
  static uint8_t ButtonMask(const String& button);
  static uint8_t KeyCode(const String& key);

  bool NotifyKeyboard(uint8_t modifier, uint8_t keycode);
  bool NotifyMouse(uint8_t buttons, int dx, int dy, int wheel);

  NimBLEHIDDevice* hid_device_{nullptr};
  NimBLECharacteristic* keyboard_input_{nullptr};
  NimBLECharacteristic* mouse_input_{nullptr};
};

}  // namespace airkvm::fw
