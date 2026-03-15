#pragma once

#include <Arduino.h>

#include "ak_frame_parser.hpp"
#include "device_state.hpp"
#include "hid_controller.hpp"
#include "protocol.hpp"
#include "route.hpp"
#include "transport.hpp"

namespace airkvm::fw {

class CommandRouter {
 public:
  CommandRouter(Transport& transport, DeviceState& state, HidController& hid);

  // Handle a CONTROL frame targeting firmware (state, version, etc.).
  // Responses are sent via route.Reply() back to the frame's origin transport.
  void ProcessFwFrame(const AkFrame& frame, Route& route);

  // Handle a CONTROL frame targeting the HID subsystem (mouse, keyboard).
  // Responses are sent via route.Reply() back to the frame's origin transport.
  void ProcessHidFrame(const AkFrame& frame, Route& route);

 private:
  bool HandleFwCommand(const airkvm::Command& cmd, Route& route);
  bool HandleHidCommand(const airkvm::Command& cmd);

  Transport& transport_;
  DeviceState&  state_;
  HidController& hid_;
};

}  // namespace airkvm::fw
