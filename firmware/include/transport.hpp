#pragma once

#include <Arduino.h>
#include <cstddef>

#include "ak_frame_parser.hpp"

class NimBLECharacteristic;

namespace airkvm::fw {

class Transport {
 public:
  void Begin();
  void SetBleTxCharacteristic(NimBLECharacteristic* characteristic);

  // --- UART ---

  // Emit a firmware-generated CONTROL frame to UART.
  void EmitControl(const char* payload);

  // Emit a firmware-generated LOG frame to UART.
  void EmitLog(const String& message);

  // Forward an AK frame to UART. priority=true uses xQueueSendToFront
  // so RESET frames jump ahead of any queued data.
  void ForwardFrameToUart(const AkFrame& frame, bool priority = false);

  // Send pre-encoded bytes to UART.
  void SendToUart(const uint8_t* bytes, size_t len, bool priority = false);

  // --- BLE ---

  // Emit a firmware-generated CONTROL frame directly to BLE.
  void EmitControlToBle(const char* payload);

  // Forward an AK frame to BLE. Returns false if no characteristic is set
  // or the frame is too large for a BLE notify.
  bool ForwardFrameToBle(const AkFrame& frame);

  // Send pre-encoded bytes directly to BLE (e.g. a NACK frame).
  // Returns false if no characteristic is set or the payload is too large.
  bool SendRawToBle(const uint8_t* bytes, size_t len);

 private:
  static constexpr size_t kMaxBinaryFrameLen = kAkMaxFrameLen;  // 267 bytes
  static constexpr size_t kMaxBleNotifyBytes = 512;

  struct TxFrame {
    bool   priority{false};
    size_t binary_len{0};
    uint8_t binary[kMaxBinaryFrameLen]{};
  };

  void EnqueueFrame(const TxFrame& frame);
  void EmitFrameDirect(const TxFrame& frame);

  // ESP32 guard: the native test environment doesn't have FreeRTOS, so the
  // TX queue and task are compiled out. EnqueueFrame falls back to
  // EmitFrameDirect (synchronous serial write) in that case.
#if defined(ESP32)
  static void TxTaskMain(void* arg);
  void TxTaskLoop();
  void* tx_queue_{nullptr};
  void* tx_task_handle_{nullptr};
#endif

  NimBLECharacteristic* tx_char_{nullptr};
};

}  // namespace airkvm::fw
