#include "command_router.hpp"

#ifndef AIRKVM_FW_VERSION
#define AIRKVM_FW_VERSION "dev"
#endif
#define AIRKVM_FW_BUILT_AT __DATE__ " " __TIME__

namespace airkvm::fw {

CommandRouter::CommandRouter(TransportMux& transport, DeviceState& state, HidController& hid)
    : transport_(transport), state_(state), hid_(hid) {}

void CommandRouter::ProcessLine(const String& line, const char* source) {
  if (line.length() == 0) {
    return;
  }

  transport_.EmitLog(String("rx.") + source + " " + line);
  const auto cmd = airkvm::ParseCommandLine(line.c_str());
  if (!cmd.has_value()) {
    transport_.EmitControl("{\"ok\":false,\"error\":\"invalid_command\"}");
    return;
  }

  HandleCommand(*cmd);
  transport_.EmitControl("{\"ok\":true}");
}

void CommandRouter::HandleCommand(const airkvm::Command& cmd) {
  switch (cmd.type) {
    case airkvm::CommandType::kMouseMoveRel: {
      const bool injected = hid_.SendMouseMoveRel(cmd.dx, cmd.dy);
      if (!injected) {
        transport_.EmitLog("hid.reject mouse.move_rel");
      }
      transport_.EmitControl("{\"type\":\"event\",\"event\":\"mouse.move_rel\"}");
      break;
    }
    case airkvm::CommandType::kMouseMoveAbs:
      transport_.EmitLog("hid.unsupported mouse.move_abs");
      transport_.EmitControl("{\"type\":\"event\",\"event\":\"mouse.move_abs\"}");
      break;
    case airkvm::CommandType::kMouseClick: {
      const bool injected = hid_.SendMouseClick(cmd.button.c_str());
      if (!injected) {
        transport_.EmitLog("hid.reject mouse.click");
      }
      transport_.EmitControl("{\"type\":\"event\",\"event\":\"mouse.click\"}");
      break;
    }
    case airkvm::CommandType::kKeyTap: {
      const bool injected = hid_.SendKeyTap(cmd.key.c_str());
      if (!injected) {
        transport_.EmitLog("hid.reject key.tap");
      }
      transport_.EmitControl("{\"type\":\"event\",\"event\":\"key.tap\"}");
      break;
    }
    case airkvm::CommandType::kStateRequest:
      transport_.EmitState(state_);
      break;
    case airkvm::CommandType::kStateSet:
      state_.busy = cmd.busy;
      transport_.EmitState(state_);
      break;
    case airkvm::CommandType::kFwVersionRequest:
      transport_.EmitControl(
          "{\"type\":\"fw.version\",\"version\":\"" AIRKVM_FW_VERSION
          "\",\"built_at\":\"" AIRKVM_FW_BUILT_AT "\"}");
      break;
    case airkvm::CommandType::kDomSnapshotRequest:
    case airkvm::CommandType::kScreenshotRequest:
    case airkvm::CommandType::kDomSnapshot:
    case airkvm::CommandType::kDomSnapshotError:
    case airkvm::CommandType::kScreenshotMeta:
    case airkvm::CommandType::kScreenshotChunk:
    case airkvm::CommandType::kScreenshotError:
      transport_.EmitControl(cmd.raw.c_str());
      break;
    case airkvm::CommandType::kUnknown:
      break;
  }
}

}  // namespace airkvm::fw
