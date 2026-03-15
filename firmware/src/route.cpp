#include "route.hpp"

#include <cstring>

namespace airkvm::fw {

// ---- UartRoute ----

UartRoute::UartRoute(Transport& transport) : transport_(transport) {}

void UartRoute::Reply(const char* json) {
  transport_.EmitControl(json);
}

void UartRoute::Nack(const AkFrame& frame) {
  uint8_t buf[kAkMaxFrameLen];
  size_t  buf_len = 0;
  const uint8_t type_byte = ((kAkTargetMcp & 0x7u) << 5) | kAkFrameTypeNack;
  if (AkEncodeFrame(type_byte, frame.transfer_id, frame.seq,
                    nullptr, 0, buf, sizeof(buf), &buf_len)) {
    transport_.SendToUart(buf, buf_len);
  }
}

bool UartRoute::Forward(const AkFrame& frame) {
  return transport_.ForwardFrameToBle(frame);
}

// ---- BleRoute ----

BleRoute::BleRoute(Transport& transport) : transport_(transport) {}

void BleRoute::Reply(const char* json) {
  transport_.EmitControlToBle(json);
}

void BleRoute::Nack(const AkFrame& frame) {
  uint8_t buf[kAkMaxFrameLen];
  size_t  buf_len = 0;
  const uint8_t type_byte = ((kAkTargetExtension & 0x7u) << 5) | kAkFrameTypeNack;
  if (AkEncodeFrame(type_byte, frame.transfer_id, frame.seq,
                    nullptr, 0, buf, sizeof(buf), &buf_len)) {
    transport_.SendRawToBle(buf, buf_len);
  }
}

bool BleRoute::Forward(const AkFrame& frame) {
  transport_.ForwardFrameToUart(frame);
  return true;
}

}  // namespace airkvm::fw
