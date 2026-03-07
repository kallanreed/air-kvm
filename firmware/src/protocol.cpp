#include "protocol.hpp"

#include <sstream>

namespace airkvm {
namespace {

bool Contains(const std::string& s, const std::string& needle) {
  return s.find(needle) != std::string::npos;
}

int ExtractInt(const std::string& s, const std::string& key, int fallback) {
  const std::string pattern = "\"" + key + "\":";
  const auto pos = s.find(pattern);
  if (pos == std::string::npos) return fallback;
  const auto start = pos + pattern.size();
  size_t end = start;
  while (end < s.size() && (s[end] == '-' || (s[end] >= '0' && s[end] <= '9'))) {
    ++end;
  }
  if (end == start) return fallback;
  return std::stoi(s.substr(start, end - start));
}

std::string ExtractString(const std::string& s, const std::string& key) {
  const std::string pattern = "\"" + key + "\":\"";
  const auto pos = s.find(pattern);
  if (pos == std::string::npos) return "";
  const auto start = pos + pattern.size();
  const auto end = s.find('"', start);
  if (end == std::string::npos) return "";
  return s.substr(start, end - start);
}

}  // namespace

std::optional<Command> ParseCommandLine(const std::string& line) {
  if (!Contains(line, "\"type\":\"")) return std::nullopt;

  Command cmd;
  if (Contains(line, "\"type\":\"mouse.move_rel\"")) {
    cmd.type = CommandType::kMouseMoveRel;
    cmd.dx = ExtractInt(line, "dx", 0);
    cmd.dy = ExtractInt(line, "dy", 0);
    return cmd;
  }

  if (Contains(line, "\"type\":\"mouse.move_abs\"")) {
    cmd.type = CommandType::kMouseMoveAbs;
    cmd.x = ExtractInt(line, "x", 0);
    cmd.y = ExtractInt(line, "y", 0);
    return cmd;
  }

  if (Contains(line, "\"type\":\"mouse.click\"")) {
    cmd.type = CommandType::kMouseClick;
    cmd.button = ExtractString(line, "button");
    return cmd;
  }

  if (Contains(line, "\"type\":\"key.tap\"")) {
    cmd.type = CommandType::kKeyTap;
    cmd.key = ExtractString(line, "key");
    return cmd;
  }

  if (Contains(line, "\"type\":\"state.request\"")) {
    cmd.type = CommandType::kStateRequest;
    return cmd;
  }

  return std::nullopt;
}

std::string AckJson(const std::string& id, bool ok, const std::string& error) {
  std::ostringstream oss;
  oss << "{\"id\":\"" << id << "\",\"ok\":" << (ok ? "true" : "false");
  if (!ok) {
    oss << ",\"error\":\"" << error << "\"";
  }
  oss << "}";
  return oss.str();
}

}  // namespace airkvm
