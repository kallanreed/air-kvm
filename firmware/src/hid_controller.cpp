#include "hid_controller.hpp"

#include <NimBLEDevice.h>
#include <NimBLEHIDDevice.h>

namespace {
// Keyboard report (ID 1) + mouse report (ID 2).
const uint8_t kHidReportMap[] = {
    0x05, 0x01,        // Usage Page (Generic Desktop)
    0x09, 0x06,        // Usage (Keyboard)
    0xA1, 0x01,        // Collection (Application)
    0x85, 0x01,        //   Report ID (1)
    0x05, 0x07,        //   Usage Page (Keyboard/Keypad)
    0x19, 0xE0,        //   Usage Minimum (Keyboard LeftControl)
    0x29, 0xE7,        //   Usage Maximum (Keyboard Right GUI)
    0x15, 0x00,        //   Logical Minimum (0)
    0x25, 0x01,        //   Logical Maximum (1)
    0x75, 0x01,        //   Report Size (1)
    0x95, 0x08,        //   Report Count (8)
    0x81, 0x02,        //   Input (Data,Var,Abs)
    0x95, 0x01,        //   Report Count (1)
    0x75, 0x08,        //   Report Size (8)
    0x81, 0x01,        //   Input (Const,Array,Abs)
    0x95, 0x06,        //   Report Count (6)
    0x75, 0x08,        //   Report Size (8)
    0x15, 0x00,        //   Logical Minimum (0)
    0x25, 0x65,        //   Logical Maximum (101)
    0x05, 0x07,        //   Usage Page (Keyboard/Keypad)
    0x19, 0x00,        //   Usage Minimum (Reserved)
    0x29, 0x65,        //   Usage Maximum (Keyboard Application)
    0x81, 0x00,        //   Input (Data,Array,Abs)
    0xC0,              // End Collection

    0x05, 0x01,        // Usage Page (Generic Desktop)
    0x09, 0x02,        // Usage (Mouse)
    0xA1, 0x01,        // Collection (Application)
    0x85, 0x02,        //   Report ID (2)
    0x09, 0x01,        //   Usage (Pointer)
    0xA1, 0x00,        //   Collection (Physical)
    0x05, 0x09,        //     Usage Page (Buttons)
    0x19, 0x01,        //     Usage Minimum (1)
    0x29, 0x03,        //     Usage Maximum (3)
    0x15, 0x00,        //     Logical Minimum (0)
    0x25, 0x01,        //     Logical Maximum (1)
    0x95, 0x03,        //     Report Count (3)
    0x75, 0x01,        //     Report Size (1)
    0x81, 0x02,        //     Input (Data,Var,Abs)
    0x95, 0x01,        //     Report Count (1)
    0x75, 0x05,        //     Report Size (5)
    0x81, 0x01,        //     Input (Const,Array,Abs)
    0x05, 0x01,        //     Usage Page (Generic Desktop)
    0x09, 0x30,        //     Usage (X)
    0x09, 0x31,        //     Usage (Y)
    0x09, 0x38,        //     Usage (Wheel)
    0x15, 0x81,        //     Logical Minimum (-127)
    0x25, 0x7F,        //     Logical Maximum (127)
    0x75, 0x08,        //     Report Size (8)
    0x95, 0x03,        //     Report Count (3)
    0x81, 0x06,        //     Input (Data,Var,Rel)
    0xC0,              //   End Collection
    0xC0               // End Collection
};

constexpr uint8_t kKeyboardReportId = 1;
constexpr uint8_t kMouseReportId = 2;
}  // namespace

namespace airkvm::fw {

void HidController::Setup(NimBLEServer* server, NimBLEAdvertising* advertising) {
  if (server == nullptr) {
    return;
  }

  hid_device_ = new NimBLEHIDDevice(server);
  keyboard_input_ = hid_device_->inputReport(kKeyboardReportId);
  mouse_input_ = hid_device_->inputReport(kMouseReportId);

  hid_device_->manufacturer("air-kvm");
  hid_device_->pnp(0x02, 0x045E, 0x0001, 0x0110);
  hid_device_->hidInfo(0x00, 0x02);
  hid_device_->reportMap((uint8_t*)kHidReportMap, sizeof(kHidReportMap));
  hid_device_->setBatteryLevel(100);
  hid_device_->startServices();

  if (advertising != nullptr) {
    advertising->addServiceUUID(hid_device_->hidService()->getUUID());
  }
}

bool HidController::SendMouseMoveRel(int dx, int dy) {
  return NotifyMouse(0, dx, dy, 0);
}

bool HidController::SendMouseClick(const String& button) {
  const uint8_t mask = ButtonMask(button);
  if (mask == 0) {
    return false;
  }

  return NotifyMouse(mask, 0, 0, 0) && NotifyMouse(0, 0, 0, 0);
}

bool HidController::SendKeyTap(const String& key) {
  const uint8_t code = KeyCode(key);
  if (code == 0) {
    return false;
  }

  return NotifyKeyboard(0, code) && NotifyKeyboard(0, 0);
}

int8_t HidController::ClampAxis(int value) {
  if (value > 127) {
    return 127;
  }
  if (value < -127) {
    return -127;
  }
  return static_cast<int8_t>(value);
}

uint8_t HidController::ButtonMask(const String& button) {
  if (button == "left") {
    return 0x01;
  }
  if (button == "right") {
    return 0x02;
  }
  if (button == "middle") {
    return 0x04;
  }
  return 0;
}

uint8_t HidController::KeyCode(const String& key) {
  if (key == "Enter") {
    return 0x28;
  }
  if (key == "Tab") {
    return 0x2B;
  }
  if (key == "Escape") {
    return 0x29;
  }
  if (key == "Space") {
    return 0x2C;
  }
  if (key.length() == 1) {
    const char c = key[0];
    if (c >= 'a' && c <= 'z') {
      return static_cast<uint8_t>(0x04 + (c - 'a'));
    }
    if (c >= 'A' && c <= 'Z') {
      return static_cast<uint8_t>(0x04 + (c - 'A'));
    }
    if (c >= '1' && c <= '9') {
      return static_cast<uint8_t>(0x1E + (c - '1'));
    }
    if (c == '0') {
      return 0x27;
    }
  }
  return 0;
}

bool HidController::NotifyKeyboard(uint8_t modifier, uint8_t keycode) {
  if (keyboard_input_ == nullptr) {
    return false;
  }

  uint8_t report[8] = {modifier, 0, keycode, 0, 0, 0, 0, 0};
  keyboard_input_->setValue(report, sizeof(report));
  keyboard_input_->notify();
  return true;
}

bool HidController::NotifyMouse(uint8_t buttons, int dx, int dy, int wheel) {
  if (mouse_input_ == nullptr) {
    return false;
  }

  uint8_t report[4] = {
      buttons,
      static_cast<uint8_t>(ClampAxis(dx)),
      static_cast<uint8_t>(ClampAxis(dy)),
      static_cast<uint8_t>(ClampAxis(wheel)),
  };
  mouse_input_->setValue(report, sizeof(report));
  mouse_input_->notify();
  return true;
}

}  // namespace airkvm::fw
