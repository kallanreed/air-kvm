#include <cassert>
#include <iostream>

#include "../include/protocol.hpp"

int main() {
  {
    const auto cmd = airkvm::ParseCommandLine("{\"type\":\"mouse.move_rel\",\"dx\":2,\"dy\":3}");
    assert(cmd.has_value());
    assert(cmd->type == airkvm::CommandType::kMouseMoveRel);
    assert(cmd->dx == 2);
    assert(cmd->dy == 3);
  }

  {
    const auto cmd = airkvm::ParseCommandLine("{\"type\":\"key.tap\",\"key\":\"a\"}");
    assert(cmd.has_value());
    assert(cmd->type == airkvm::CommandType::kKeyTap);
    assert(cmd->key == "a");
  }

  {
    const auto cmd = airkvm::ParseCommandLine("{\"x\":1}");
    assert(!cmd.has_value());
  }

  {
    const auto ack = airkvm::AckJson("id-1", true);
    assert(ack == "{\"id\":\"id-1\",\"ok\":true}");
  }

  std::cout << "firmware host tests passed\n";
  return 0;
}
