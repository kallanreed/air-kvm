#pragma once

#include <string>
#include <vector>

namespace airkvm::fw {

// Expand key.type text into the same key-token sequence used by HID injection.
// Special handling:
// - \n -> "Enter"
// - \t -> "Tab"
// - \\ -> "\\"
// - {Name} -> "Name" when it is a recognized named key
// Unknown escapes and unknown brace names fall back to literal characters.
std::vector<std::string> ExpandKeyTypeText(const std::string& text);
bool IsRecognizedKeyTypeName(const std::string& name);

}  // namespace airkvm::fw
