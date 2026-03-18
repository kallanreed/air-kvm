#include <unity.h>

#include "hid_key_type.hpp"

void test_expand_key_type_newline_tab_and_backslash() {
  const auto keys = airkvm::fw::ExpandKeyTypeText("a\\n\\t\\\\b");
  TEST_ASSERT_EQUAL_UINT32(5, keys.size());
  TEST_ASSERT_EQUAL_STRING("a", keys[0].c_str());
  TEST_ASSERT_EQUAL_STRING("Enter", keys[1].c_str());
  TEST_ASSERT_EQUAL_STRING("Tab", keys[2].c_str());
  TEST_ASSERT_EQUAL_STRING("\\", keys[3].c_str());
  TEST_ASSERT_EQUAL_STRING("b", keys[4].c_str());
}

void test_expand_key_type_named_keys() {
  const auto keys = airkvm::fw::ExpandKeyTypeText("{Enter}{Escape}{Up}{Left}");
  TEST_ASSERT_EQUAL_UINT32(4, keys.size());
  TEST_ASSERT_EQUAL_STRING("Enter", keys[0].c_str());
  TEST_ASSERT_EQUAL_STRING("Escape", keys[1].c_str());
  TEST_ASSERT_EQUAL_STRING("Up", keys[2].c_str());
  TEST_ASSERT_EQUAL_STRING("Left", keys[3].c_str());
}

void test_expand_key_type_unknown_escape_and_unknown_brace_name_fall_back_literal() {
  const auto keys = airkvm::fw::ExpandKeyTypeText("\\x{Nope}");
  TEST_ASSERT_EQUAL_UINT32(8, keys.size());
  TEST_ASSERT_EQUAL_STRING("\\", keys[0].c_str());
  TEST_ASSERT_EQUAL_STRING("x", keys[1].c_str());
  TEST_ASSERT_EQUAL_STRING("{", keys[2].c_str());
  TEST_ASSERT_EQUAL_STRING("N", keys[3].c_str());
  TEST_ASSERT_EQUAL_STRING("o", keys[4].c_str());
  TEST_ASSERT_EQUAL_STRING("p", keys[5].c_str());
  TEST_ASSERT_EQUAL_STRING("e", keys[6].c_str());
  TEST_ASSERT_EQUAL_STRING("}", keys[7].c_str());
}

void test_expand_key_type_unclosed_brace_is_literal() {
  const auto keys = airkvm::fw::ExpandKeyTypeText("{Enter");
  TEST_ASSERT_EQUAL_UINT32(6, keys.size());
  TEST_ASSERT_EQUAL_STRING("{", keys[0].c_str());
  TEST_ASSERT_EQUAL_STRING("E", keys[1].c_str());
  TEST_ASSERT_EQUAL_STRING("n", keys[2].c_str());
  TEST_ASSERT_EQUAL_STRING("t", keys[3].c_str());
  TEST_ASSERT_EQUAL_STRING("e", keys[4].c_str());
  TEST_ASSERT_EQUAL_STRING("r", keys[5].c_str());
}

int main(int, char**) {
  UNITY_BEGIN();
  RUN_TEST(test_expand_key_type_newline_tab_and_backslash);
  RUN_TEST(test_expand_key_type_named_keys);
  RUN_TEST(test_expand_key_type_unknown_escape_and_unknown_brace_name_fall_back_literal);
  RUN_TEST(test_expand_key_type_unclosed_brace_is_literal);
  return UNITY_END();
}
