#include "hid_key_type.hpp"

#include <cstddef>

namespace airkvm::fw {
namespace {

constexpr const char* kNamedKeyAliases[] = {
    "Shift", "ShiftLeft", "ShiftRight", "Control", "Ctrl", "ControlLeft", "ControlRight",
    "Alt", "AltLeft", "Option", "OptionLeft", "AltRight", "OptionRight", "Meta",
    "Command", "MetaLeft", "CommandLeft", "MetaRight", "CommandRight",
    "Enter", "Return", "NumpadEnter", "Tab", "Escape", "Esc", "Backspace", "Delete",
    "Del", "Insert", "Home", "End", "PageUp", "PageDown", "ArrowRight", "ArrowLeft",
    "ArrowDown", "ArrowUp", "Up", "Down", "Left", "Right", "CapsLock", "NumLock",
    "ScrollLock", "PrintScreen", "Pause", "ContextMenu", "Application", "Menu",
    "Backquote", "Minus", "Equal", "BracketLeft", "BracketRight", "Backslash",
    "IntlBackslash", "Semicolon", "Quote", "Comma", "Period", "Slash", "Space",
    "Spacebar", "NumpadAdd", "NumpadSubtract", "NumpadMultiply", "NumpadDivide",
    "NumpadDecimal", "NumpadComma", "NumpadEqual", "NumpadParenLeft",
    "NumpadParenRight", "Mute", "VolumeMute", "VolumeUp", "VolumeDown", "Help",
    "Stop", "Again", "Undo", "Cut", "Copy", "Paste", "Find",
};

}  // namespace

bool IsRecognizedKeyTypeName(const std::string& name) {
  for (const char* alias : kNamedKeyAliases) {
    if (name == alias) {
      return true;
    }
  }
  return false;
}

std::vector<std::string> ExpandKeyTypeText(const std::string& text) {
  std::vector<std::string> out;
  std::size_t i = 0;
  while (i < text.size()) {
    const char c = text[i];
    if (c == '\\' && i + 1 < text.size()) {
      const char next = text[i + 1];
      if (next == 'n') {
        out.emplace_back("Enter");
        i += 2;
        continue;
      }
      if (next == 't') {
        out.emplace_back("Tab");
        i += 2;
        continue;
      }
      if (next == '\\') {
        out.emplace_back("\\");
        i += 2;
        continue;
      }
      out.emplace_back("\\");
      i += 1;
      continue;
    }

    if (c == '{') {
      const std::size_t close = text.find('}', i + 1);
      if (close != std::string::npos && close > i + 1) {
        const std::string name = text.substr(i + 1, close - (i + 1));
        if (IsRecognizedKeyTypeName(name)) {
          out.push_back(name);
          i = close + 1;
          continue;
        }
      }
      out.emplace_back("{");
      i += 1;
      continue;
    }

    out.emplace_back(1, c);
    i += 1;
  }
  return out;
}

}  // namespace airkvm::fw
