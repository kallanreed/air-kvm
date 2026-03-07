#include <unity.h>

#include "protocol.hpp"

void test_parse_mouse_move_rel() {
  const auto cmd = airkvm::ParseCommandLine("{\"type\":\"mouse.move_rel\",\"dx\":10,\"dy\":-4}");
  TEST_ASSERT_TRUE(cmd.has_value());
  TEST_ASSERT_EQUAL_INT(static_cast<int>(airkvm::CommandType::kMouseMoveRel), static_cast<int>(cmd->type));
  TEST_ASSERT_EQUAL(10, cmd->dx);
  TEST_ASSERT_EQUAL(-4, cmd->dy);
}

void test_parse_key_tap() {
  const auto cmd = airkvm::ParseCommandLine("{\"type\":\"key.tap\",\"key\":\"Enter\"}");
  TEST_ASSERT_TRUE(cmd.has_value());
  TEST_ASSERT_EQUAL_INT(static_cast<int>(airkvm::CommandType::kKeyTap), static_cast<int>(cmd->type));
  TEST_ASSERT_EQUAL_STRING("Enter", cmd->key.c_str());
}

void test_invalid_command() {
  const auto cmd = airkvm::ParseCommandLine("{\"foo\":\"bar\"}");
  TEST_ASSERT_FALSE(cmd.has_value());
}

void test_ack_json_ok() {
  const auto s = airkvm::AckJson("abc", true);
  TEST_ASSERT_EQUAL_STRING("{\"id\":\"abc\",\"ok\":true}", s.c_str());
}

int main(int, char**) {
  UNITY_BEGIN();
  RUN_TEST(test_parse_mouse_move_rel);
  RUN_TEST(test_parse_key_tap);
  RUN_TEST(test_invalid_command);
  RUN_TEST(test_ack_json_ok);
  return UNITY_END();
}
