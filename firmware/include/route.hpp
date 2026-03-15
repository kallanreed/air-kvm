#pragma once

#include "ak_frame_parser.hpp"
#include "transport.hpp"

namespace airkvm::fw {

// Abstracts the transport-specific reply/nack/forward behaviour for a frame
// based on where it arrived from (UART or BLE).
class Route {
 public:
  virtual ~Route() = default;

  // Send a CONTROL response back to the originating transport.
  virtual void Reply(const char* json) = 0;

  // Send a NACK back to the originating transport.
  virtual void Nack(const AkFrame& frame) = 0;

  // Forward a frame to the opposite transport.
  // Returns false if the frame could not be forwarded (e.g. too large for BLE).
  virtual bool Forward(const AkFrame& frame) = 0;

  // The AkTarget that this route forwards to (i.e. the opposite transport).
  // UART route → kAkTargetExtension; BLE route → kAkTargetMcp.
  virtual uint8_t RouteTarget() const = 0;
};

// Frame received over UART (originated from MCP).
// Replies go back to UART; frames targeting Extension are forwarded to BLE.
class UartRoute : public Route {
 public:
  explicit UartRoute(Transport& transport);
  void    Reply(const char* json) override;
  void    Nack(const AkFrame& frame) override;
  bool    Forward(const AkFrame& frame) override;
  uint8_t RouteTarget() const override { return kAkTargetExtension; }

 private:
  Transport& transport_;
};

// Frame received over BLE (originated from Extension).
// Replies go back to BLE; frames targeting MCP are forwarded to UART.
class BleRoute : public Route {
 public:
  explicit BleRoute(Transport& transport);
  void    Reply(const char* json) override;
  void    Nack(const AkFrame& frame) override;
  bool    Forward(const AkFrame& frame) override;
  uint8_t RouteTarget() const override { return kAkTargetMcp; }

 private:
  Transport& transport_;
};

}  // namespace airkvm::fw
