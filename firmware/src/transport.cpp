#include "transport.hpp"

#include <cstdio>
#include <cstring>

#include <NimBLEDevice.h>
#if defined(ESP32)
#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>
#include <freertos/task.h>
#endif

namespace airkvm::fw {

void Transport::Begin() {
#if defined(ESP32)
  if (tx_queue_ != nullptr) return;
  tx_queue_ = static_cast<void*>(xQueueCreate(32, sizeof(TxFrame)));
  if (tx_queue_ == nullptr) {
    Serial.println("fatal:tx_queue_create_failed");
    Serial.flush();
    abort();
  }
  xTaskCreatePinnedToCore(
      &Transport::TxTaskMain,
      "airkvm_tx",
      4096,
      this,
      1,
      reinterpret_cast<TaskHandle_t*>(&tx_task_handle_),
      1);
#endif
}

void Transport::SetBleTxCharacteristic(NimBLECharacteristic* characteristic) {
  tx_char_ = characteristic;
}

void Transport::EmitControl(const char* payload) {
  if (payload == nullptr) return;
  const size_t text_len = std::strlen(payload);
  if (text_len == 0 || text_len > kAkMaxPayload) return;
  TxFrame frame{};
  if (!AkEncodeFrame(
          kAkFrameTypeControl, 0, 0,
          reinterpret_cast<const uint8_t*>(payload),
          static_cast<uint8_t>(text_len),
          frame.binary, sizeof(frame.binary), &frame.binary_len)) {
    return;
  }
  EnqueueFrame(frame);
}

void Transport::EmitLog(const String& message) {
  if (message.length() == 0) return;
  const auto text_len = static_cast<uint8_t>(
      message.length() < kAkMaxPayload ? message.length() : kAkMaxPayload);
  TxFrame frame{};
  if (!AkEncodeFrame(
          kAkFrameTypeLog, 0, 0,
          reinterpret_cast<const uint8_t*>(message.c_str()),
          text_len,
          frame.binary, sizeof(frame.binary), &frame.binary_len)) {
    return;
  }
  EnqueueFrame(frame);
}

void Transport::ForwardFrameToUart(const AkFrame& frame, bool priority) {
  SendToUart(frame.raw, frame.raw_len, priority);
}

void Transport::SendToUart(const uint8_t* bytes, size_t len, bool priority) {
  if (bytes == nullptr || len == 0 || len > kMaxBinaryFrameLen) return;
  TxFrame tx{};
  tx.priority   = priority;
  tx.binary_len = len;
  std::memcpy(tx.binary, bytes, len);
  EnqueueFrame(tx);
}

void Transport::EmitControlToBle(const char* payload) {
  if (payload == nullptr || tx_char_ == nullptr) return;
  const size_t text_len = std::strlen(payload);
  if (text_len == 0 || text_len > kAkMaxPayload) return;
  TxFrame frame{};
  if (!AkEncodeFrame(
          kAkFrameTypeControl, 0, 0,
          reinterpret_cast<const uint8_t*>(payload),
          static_cast<uint8_t>(text_len),
          frame.binary, sizeof(frame.binary), &frame.binary_len)) {
    return;
  }
  if (frame.binary_len > kMaxBleNotifyBytes) return;
  tx_char_->setValue(frame.binary, frame.binary_len);
  tx_char_->notify();
}

bool Transport::ForwardFrameToBle(const AkFrame& frame) {
  if (tx_char_ == nullptr) {
    EmitLog(R"({"evt":"ble.forward.skip","reason":"no_characteristic"})");
    return false;
  }
  if (frame.raw_len > kMaxBleNotifyBytes) {
    return false;
  }
  tx_char_->setValue(frame.raw, frame.raw_len);
  tx_char_->notify();
  return true;
}

bool Transport::SendRawToBle(const uint8_t* bytes, size_t len) {
  if (tx_char_ == nullptr || bytes == nullptr || len == 0 || len > kMaxBleNotifyBytes) return false;
  tx_char_->setValue(bytes, len);
  tx_char_->notify();
  return true;
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

void Transport::EnqueueFrame(const TxFrame& frame) {
#if defined(ESP32)
  if (tx_queue_ == nullptr) return;
  const auto queue = reinterpret_cast<QueueHandle_t>(tx_queue_);
  if (frame.priority) {
    xQueueSendToFront(queue, &frame, portMAX_DELAY);
  } else {
    xQueueSend(queue, &frame, portMAX_DELAY);
  }
#else
  EmitFrameDirect(frame);
#endif
}

void Transport::EmitFrameDirect(const TxFrame& frame) {
  if (frame.binary_len > 0) {
    Serial.write(frame.binary, frame.binary_len);
    Serial.flush();
  }
}

#if defined(ESP32)
void Transport::TxTaskMain(void* arg) {
  auto* self = static_cast<Transport*>(arg);
  if (self == nullptr) {
    vTaskDelete(nullptr);
    return;
  }
  self->TxTaskLoop();
}

void Transport::TxTaskLoop() {
  if (tx_queue_ == nullptr) {
    vTaskDelete(nullptr);
    return;
  }
  auto queue = reinterpret_cast<QueueHandle_t>(tx_queue_);
  TxFrame frame{};
  while (true) {
    if (xQueueReceive(queue, &frame, portMAX_DELAY) == pdTRUE) {
      EmitFrameDirect(frame);
    }
  }
}
#endif

}  // namespace airkvm::fw
