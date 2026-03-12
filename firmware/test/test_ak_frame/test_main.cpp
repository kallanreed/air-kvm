#include <unity.h>

#include "ak_frame_parser.hpp"

using namespace airkvm::fw;

// Build a minimal valid AK frame into out[]. Returns total length.
static size_t build_frame(uint8_t* out, uint8_t type, uint16_t txid, uint16_t seq,
                          const uint8_t* payload, uint8_t plen) {
  out[0] = 0x41; // 'A'
  out[1] = 0x4B; // 'K'
  out[2] = type;
  out[3] = static_cast<uint8_t>(txid & 0xFF);
  out[4] = static_cast<uint8_t>(txid >> 8);
  out[5] = static_cast<uint8_t>(seq & 0xFF);
  out[6] = static_cast<uint8_t>(seq >> 8);
  out[7] = plen;
  for (uint8_t i = 0; i < plen; ++i) out[8 + i] = payload[i];
  const uint32_t crc = AkCrc32(out + 2, (kAkHeaderLen - 2) + plen);
  const size_t crc_off = kAkHeaderLen + plen;
  out[crc_off + 0] = static_cast<uint8_t>(crc & 0xFF);
  out[crc_off + 1] = static_cast<uint8_t>((crc >> 8) & 0xFF);
  out[crc_off + 2] = static_cast<uint8_t>((crc >> 16) & 0xFF);
  out[crc_off + 3] = static_cast<uint8_t>((crc >> 24) & 0xFF);
  return kAkHeaderLen + plen + kAkCrcLen;
}

void test_parse_valid_chunk() {
  uint8_t payload[] = {0x01, 0x02, 0x03};
  uint8_t buf[kAkMaxFrameLen];
  const size_t len = build_frame(buf, kAkFrameTypeChunk, 0x0001, 0x0000, payload, sizeof(payload));

  int count = 0;
  AkFrameParser parser;
  parser.Feed(buf, len, [&](const AkFrame& f) {
    ++count;
    TEST_ASSERT_EQUAL(kAkFrameTypeChunk, f.type);
    TEST_ASSERT_EQUAL(0x0001, f.transfer_id);
    TEST_ASSERT_EQUAL(0x0000, f.seq);
    TEST_ASSERT_EQUAL(3, f.payload_len);
    TEST_ASSERT_EQUAL_UINT8_ARRAY(payload, f.payload, 3);
    TEST_ASSERT_EQUAL(len, f.raw_len);
  });
  TEST_ASSERT_EQUAL(1, count);
}

void test_parse_all_frame_types() {
  const uint8_t types[] = {
    kAkFrameTypeChunk, kAkFrameTypeControl, kAkFrameTypeLog,
    kAkFrameTypeAck,   kAkFrameTypeNack,    kAkFrameTypeReset
  };
  AkFrameParser parser;
  for (uint8_t t : types) {
    uint8_t buf[kAkMaxFrameLen];
    const size_t len = build_frame(buf, t, 0, 0, nullptr, 0);
    int count = 0;
    parser.Feed(buf, len, [&](const AkFrame& f) {
      ++count;
      TEST_ASSERT_EQUAL(t, f.type);
    });
    TEST_ASSERT_EQUAL(1, count);
  }
}

void test_garbage_before_magic_is_dropped() {
  uint8_t payload[] = {0xAA};
  uint8_t frame[kAkMaxFrameLen];
  const size_t frame_len = build_frame(frame, kAkFrameTypeAck, 0, 0, payload, 1);

  uint8_t buf[16 + kAkMaxFrameLen];
  // Prepend 16 garbage bytes
  for (int i = 0; i < 16; ++i) buf[i] = 0xFF;
  memcpy(buf + 16, frame, frame_len);

  int count = 0;
  AkFrameParser parser;
  parser.Feed(buf, 16 + frame_len, [&](const AkFrame& f) {
    ++count;
    TEST_ASSERT_EQUAL(kAkFrameTypeAck, f.type);
  });
  TEST_ASSERT_EQUAL(1, count);
}

void test_bad_crc_drops_frame() {
  uint8_t buf[kAkMaxFrameLen];
  const size_t len = build_frame(buf, kAkFrameTypeChunk, 0, 0, nullptr, 0);
  // Corrupt the CRC
  buf[len - 1] ^= 0xFF;

  int count = 0;
  AkFrameParser parser;
  parser.Feed(buf, len, [&](const AkFrame&) { ++count; });
  TEST_ASSERT_EQUAL(0, count);
}

void test_frame_split_across_feeds() {
  uint8_t buf[kAkMaxFrameLen];
  const size_t len = build_frame(buf, kAkFrameTypeNack, 0x0002, 0x0001, nullptr, 0);

  int count = 0;
  AkFrameParser parser;
  // Feed one byte at a time
  for (size_t i = 0; i < len; ++i) {
    parser.Feed(buf + i, 1, [&](const AkFrame& f) {
      ++count;
      TEST_ASSERT_EQUAL(kAkFrameTypeNack, f.type);
    });
  }
  TEST_ASSERT_EQUAL(1, count);
}

void test_multiple_frames_in_one_feed() {
  uint8_t buf[kAkMaxFrameLen * 3];
  size_t off = 0;
  for (int i = 0; i < 3; ++i) {
    const uint8_t p = static_cast<uint8_t>(i);
    off += build_frame(buf + off, kAkFrameTypeChunk, static_cast<uint16_t>(i), 0, &p, 1);
  }

  int count = 0;
  AkFrameParser parser;
  parser.Feed(buf, off, [&](const AkFrame&) { ++count; });
  TEST_ASSERT_EQUAL(3, count);
}

void test_reset_clears_partial_state() {
  // Send first byte of a frame, then reset, then send a full valid frame.
  uint8_t buf[kAkMaxFrameLen];
  const size_t len = build_frame(buf, kAkFrameTypeLog, 0, 0, nullptr, 0);

  int count = 0;
  AkFrameParser parser;
  // Feed just the magic bytes of a different partial frame
  uint8_t partial[] = {0x41, 0x4B, 0x01};
  parser.Feed(partial, sizeof(partial), [&](const AkFrame&) { ++count; });
  TEST_ASSERT_EQUAL(0, count);

  parser.Reset();
  parser.Feed(buf, len, [&](const AkFrame& f) {
    ++count;
    TEST_ASSERT_EQUAL(kAkFrameTypeLog, f.type);
  });
  TEST_ASSERT_EQUAL(1, count);
}

// FindMagic1: receiving 0x41 again re-syncs (stays in FindMagic1), then 0x4B
// continues normally. Sequence: 0x41 0x41 0x4B <rest-of-header+crc> should parse.
void test_magic1_resync_on_double_magic0() {
  uint8_t frame[kAkMaxFrameLen];
  const size_t frame_len = build_frame(frame, kAkFrameTypeAck, 0, 0, nullptr, 0);

  // Build stream: leading 0x41, then the full valid frame starting with 0x41 0x4B.
  uint8_t buf[1 + kAkMaxFrameLen];
  buf[0] = 0x41;  // extra 0x41 triggers re-sync branch in FindMagic1
  memcpy(buf + 1, frame, frame_len);

  int count = 0;
  AkFrameParser parser;
  parser.Feed(buf, 1 + frame_len, [&](const AkFrame& f) {
    ++count;
    TEST_ASSERT_EQUAL(kAkFrameTypeAck, f.type);
  });
  TEST_ASSERT_EQUAL(1, count);
}

// FindMagic1: a non-magic0 byte after 0x41 must reset to FindMagic0 and the
// parser must still correctly parse a following valid frame.
void test_magic1_bad_byte_resets_then_recovers() {
  uint8_t frame[kAkMaxFrameLen];
  const size_t frame_len = build_frame(frame, kAkFrameTypeControl, 0x0007, 0x0003, nullptr, 0);

  // 0x41 0xFF <junk that isn't 0x4B and isn't 0x41> then a valid frame
  uint8_t buf[2 + kAkMaxFrameLen];
  buf[0] = 0x41;
  buf[1] = 0xFF;  // triggers FindMagic0 reset
  memcpy(buf + 2, frame, frame_len);

  int count = 0;
  AkFrameParser parser;
  parser.Feed(buf, 2 + frame_len, [&](const AkFrame& f) {
    ++count;
    TEST_ASSERT_EQUAL(kAkFrameTypeControl, f.type);
    TEST_ASSERT_EQUAL(0x0007, f.transfer_id);
    TEST_ASSERT_EQUAL(0x0003, f.seq);
  });
  TEST_ASSERT_EQUAL(1, count);
}

// ReadHeader: invalid type byte causes silent drop + reset; the parser should
// parse a subsequent valid frame without any residual state.
void test_invalid_type_drops_and_recovers() {
  // Build a raw frame buffer with an invalid type (0x00) but correct magic.
  uint8_t bad[kAkMaxFrameLen];
  bad[0] = 0x41; bad[1] = 0x4B;
  bad[2] = 0x00;  // invalid type
  bad[3] = bad[4] = bad[5] = bad[6] = 0;
  bad[7] = 0;  // zero payload
  // CRC doesn't matter — parser rejects before reaching CRC.
  bad[8] = bad[9] = bad[10] = bad[11] = 0;
  const size_t bad_len = kAkHeaderLen + kAkCrcLen;

  uint8_t good[kAkMaxFrameLen];
  const size_t good_len = build_frame(good, kAkFrameTypeReset, 0, 0, nullptr, 0);

  uint8_t buf[kAkMaxFrameLen * 2];
  memcpy(buf, bad, bad_len);
  memcpy(buf + bad_len, good, good_len);

  int count = 0;
  AkFrameParser parser;
  parser.Feed(buf, bad_len + good_len, [&](const AkFrame& f) {
    ++count;
    TEST_ASSERT_EQUAL(kAkFrameTypeReset, f.type);
  });
  TEST_ASSERT_EQUAL(1, count);
}

// ReadHeader: type just above the valid range (0x07) is also rejected.
void test_type_above_range_drops_frame() {
  uint8_t buf[kAkHeaderLen + kAkCrcLen];
  buf[0] = 0x41; buf[1] = 0x4B;
  buf[2] = 0x07;  // one above kAkFrameTypeReset
  buf[3] = buf[4] = buf[5] = buf[6] = 0;
  buf[7] = 0;
  buf[8] = buf[9] = buf[10] = buf[11] = 0;

  int count = 0;
  AkFrameParser parser;
  parser.Feed(buf, sizeof(buf), [&](const AkFrame&) { ++count; });
  TEST_ASSERT_EQUAL(0, count);
}

// Max payload (255 bytes) is fully buffered and delivered correctly.
void test_max_payload_parsed() {
  uint8_t payload[kAkMaxPayload];
  for (size_t i = 0; i < kAkMaxPayload; ++i) payload[i] = static_cast<uint8_t>(i & 0xFF);

  uint8_t buf[kAkMaxFrameLen];
  const size_t len = build_frame(buf, kAkFrameTypeChunk, 0xABCD, 0x1234, payload, kAkMaxPayload);

  int count = 0;
  AkFrameParser parser;
  parser.Feed(buf, len, [&](const AkFrame& f) {
    ++count;
    TEST_ASSERT_EQUAL(kAkFrameTypeChunk, f.type);
    TEST_ASSERT_EQUAL(0xABCD, f.transfer_id);
    TEST_ASSERT_EQUAL(0x1234, f.seq);
    TEST_ASSERT_EQUAL(kAkMaxPayload, f.payload_len);
    TEST_ASSERT_EQUAL_UINT8_ARRAY(payload, f.payload, kAkMaxPayload);
    TEST_ASSERT_EQUAL(len, f.raw_len);
  });
  TEST_ASSERT_EQUAL(1, count);
}

// Garbage bytes interspersed between two valid frames must not disrupt either.
void test_garbage_between_frames() {
  uint8_t f1[kAkMaxFrameLen], f2[kAkMaxFrameLen];
  const size_t l1 = build_frame(f1, kAkFrameTypeLog, 0, 0, nullptr, 0);
  const size_t l2 = build_frame(f2, kAkFrameTypeNack, 1, 0, nullptr, 0);

  uint8_t buf[kAkMaxFrameLen * 2 + 8];
  size_t off = 0;
  memcpy(buf + off, f1, l1); off += l1;
  // 8 junk bytes between the two frames
  for (int i = 0; i < 8; ++i) buf[off++] = 0xDE;
  memcpy(buf + off, f2, l2); off += l2;

  int count = 0;
  AkFrameParser parser;
  parser.Feed(buf, off, [&](const AkFrame&) { ++count; });
  TEST_ASSERT_EQUAL(2, count);
}

// After a CRC mismatch the parser resets and parses the next valid frame.
void test_bad_crc_then_valid_frame() {
  uint8_t bad[kAkMaxFrameLen];
  size_t bad_len = build_frame(bad, kAkFrameTypeChunk, 0, 0, nullptr, 0);
  bad[bad_len - 1] ^= 0xFF;  // corrupt last CRC byte

  uint8_t good[kAkMaxFrameLen];
  const size_t good_len = build_frame(good, kAkFrameTypeAck, 0x0005, 0, nullptr, 0);

  uint8_t buf[kAkMaxFrameLen * 2];
  memcpy(buf, bad, bad_len);
  memcpy(buf + bad_len, good, good_len);

  int count = 0;
  AkFrameParser parser;
  parser.Feed(buf, bad_len + good_len, [&](const AkFrame& f) {
    ++count;
    TEST_ASSERT_EQUAL(kAkFrameTypeAck, f.type);
    TEST_ASSERT_EQUAL(0x0005, f.transfer_id);
  });
  TEST_ASSERT_EQUAL(1, count);
}

// AkEncodeFrame returns false when the output buffer is too small.
void test_encode_frame_buffer_too_small() {
  uint8_t out[kAkHeaderLen];  // too small for even a zero-payload frame (needs +4 for CRC)
  size_t out_len = 0;
  const bool ok = AkEncodeFrame(kAkFrameTypeAck, 0, 0, nullptr, 0, out, sizeof(out), &out_len);
  TEST_ASSERT_FALSE(ok);
}

// AkEncodeFrame produces a frame that the parser accepts correctly.
void test_encode_then_parse_roundtrip() {
  uint8_t payload[] = {0x10, 0x20, 0x30};
  uint8_t buf[kAkMaxFrameLen];
  size_t out_len = 0;
  const bool ok = AkEncodeFrame(
      kAkFrameTypeControl, 0x0042, 0x0007, payload, sizeof(payload),
      buf, sizeof(buf), &out_len);
  TEST_ASSERT_TRUE(ok);

  int count = 0;
  AkFrameParser parser;
  parser.Feed(buf, out_len, [&](const AkFrame& f) {
    ++count;
    TEST_ASSERT_EQUAL(kAkFrameTypeControl, f.type);
    TEST_ASSERT_EQUAL(0x0042, f.transfer_id);
    TEST_ASSERT_EQUAL(0x0007, f.seq);
    TEST_ASSERT_EQUAL(3, f.payload_len);
    TEST_ASSERT_EQUAL_UINT8_ARRAY(payload, f.payload, 3);
  });
  TEST_ASSERT_EQUAL(1, count);
}

int main(int, char**) {
  UNITY_BEGIN();
  RUN_TEST(test_parse_valid_chunk);
  RUN_TEST(test_parse_all_frame_types);
  RUN_TEST(test_garbage_before_magic_is_dropped);
  RUN_TEST(test_bad_crc_drops_frame);
  RUN_TEST(test_frame_split_across_feeds);
  RUN_TEST(test_multiple_frames_in_one_feed);
  RUN_TEST(test_reset_clears_partial_state);
  RUN_TEST(test_magic1_resync_on_double_magic0);
  RUN_TEST(test_magic1_bad_byte_resets_then_recovers);
  RUN_TEST(test_invalid_type_drops_and_recovers);
  RUN_TEST(test_type_above_range_drops_frame);
  RUN_TEST(test_max_payload_parsed);
  RUN_TEST(test_garbage_between_frames);
  RUN_TEST(test_bad_crc_then_valid_frame);
  RUN_TEST(test_encode_frame_buffer_too_small);
  RUN_TEST(test_encode_then_parse_roundtrip);
  return UNITY_END();
}
