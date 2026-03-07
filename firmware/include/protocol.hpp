#pragma once

#include <cstdint>
#include <optional>
#include <string>

namespace airkvm {

enum class CommandType {
  kUnknown,
  kMouseMoveRel,
  kMouseMoveAbs,
  kMouseClick,
  kKeyTap,
  kStateRequest,
};

struct Command {
  CommandType type{CommandType::kUnknown};
  int dx{0};
  int dy{0};
  int x{0};
  int y{0};
  std::string button;
  std::string key;
};

// Parse a constrained JSON-line command without dynamic JSON dependencies.
// This keeps firmware small for POC and is enough for early integration tests.
std::optional<Command> ParseCommandLine(const std::string& line);

std::string AckJson(const std::string& id, bool ok, const std::string& error = "");

}  // namespace airkvm
