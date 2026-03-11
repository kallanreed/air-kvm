import test from 'node:test';
import assert from 'node:assert/strict';

import {
  // v1 exports (kept for backward compat)
  decodeUartFrame,
  encodeControlFrame,
  encodeLogFrame,
  encodeTransferChunkFrame,
  tryExtractFrameFromBuffer,
  // v2 exports
  kFrameType,
  kV2HeaderLen,
  kV2CrcLen,
  kV2MinFrameLen,
  kV2MaxPayload,
  encodeFrame,
  decodeFrame,
  tryExtractV2Frame,
  makeV2TransferId,
  encodeChunkFrame,
  encodeAckFrame,
  encodeNackFrame,
  encodeResetFrame,
  encodeControlFrameV2,
  encodeLogFrameV2,
} from '../src/binary_frame.js';

// ── v1 tests (unchanged) ───────────────────────────────────────────

test('decodeUartFrame decodes control JSON frame', () => {
  const frame = encodeControlFrame({ ok: true, type: 'state' });
  const parsed = decodeUartFrame(frame);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.frameType, 2);
  assert.equal(parsed.msg.ok, true);
  assert.equal(parsed.msg.type, 'state');
});

test('decodeUartFrame decodes log text frame', () => {
  const frame = encodeLogFrame('hello log');
  const parsed = decodeUartFrame(frame);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.frameType, 3);
  assert.equal(parsed.text, 'hello log');
});

test('tryExtractFrameFromBuffer emits ctrl/log/bin kinds', () => {
  const ctrl = encodeControlFrame({ ok: true });
  const log = encodeLogFrame('x');
  const bin = encodeTransferChunkFrame({
    transferId: 0x11,
    seq: 2,
    payload: Buffer.from('ABC')
  });
  const joined = Buffer.concat([ctrl, log, bin]);

  const f1 = tryExtractFrameFromBuffer(joined);
  assert.equal(f1.frame.kind, 'ctrl');
  assert.equal(f1.frame.msg.ok, true);

  const rest1 = joined.subarray(f1.consumed);
  const f2 = tryExtractFrameFromBuffer(rest1);
  assert.equal(f2.frame.kind, 'log');
  assert.equal(f2.frame.msg, 'x');

  const rest2 = rest1.subarray(f2.consumed);
  const f3 = tryExtractFrameFromBuffer(rest2);
  assert.equal(f3.frame.kind, 'bin');
  assert.equal(f3.frame.transfer_id, 'tx_00000011');
  assert.equal(f3.frame.seq, 2);
});

// ── v2 tests ────────────────────────────────────────────────────────

test('v2: round-trip all 6 frame types', () => {
  const types = [
    { type: kFrameType.CHUNK,   payload: Buffer.from('data') },
    { type: kFrameType.CONTROL, payload: Buffer.from('{"a":1}') },
    { type: kFrameType.LOG,     payload: Buffer.from('log msg') },
    { type: kFrameType.ACK,     payload: Buffer.alloc(0) },
    { type: kFrameType.NACK,    payload: Buffer.alloc(0) },
    { type: kFrameType.RESET,   payload: Buffer.alloc(0) },
  ];
  for (const { type, payload } of types) {
    const encoded = encodeFrame({ type, transferId: 42, seq: 7, payload });
    const decoded = decodeFrame(encoded);
    assert.equal(decoded.ok, true, `type 0x${type.toString(16)} should decode ok`);
    assert.equal(decoded.type, type);
    assert.equal(decoded.transferId, 42);
    assert.equal(decoded.seq, 7);
    assert.deepEqual(decoded.payload, payload);
  }
});

test('v2: chunk frame with known payload', () => {
  const payload = Buffer.from([0xDE, 0xAD, 0xBE, 0xEF]);
  const encoded = encodeChunkFrame({ transferId: 100, seq: 3, payload });
  const decoded = decodeFrame(encoded);
  assert.equal(decoded.ok, true);
  assert.equal(decoded.type, kFrameType.CHUNK);
  assert.deepEqual(decoded.payload, payload);
});

test('v2: control frame v2 JSON roundtrip', () => {
  const msg = { action: 'ping', value: 42 };
  const encoded = encodeControlFrameV2(msg);
  const decoded = decodeFrame(encoded);
  assert.equal(decoded.ok, true);
  assert.equal(decoded.type, kFrameType.CONTROL);
  const parsed = JSON.parse(decoded.payload.toString('utf8'));
  assert.deepEqual(parsed, msg);
});

test('v2: log frame v2 text roundtrip', () => {
  const text = 'hello v2 log';
  const encoded = encodeLogFrameV2(text);
  const decoded = decodeFrame(encoded);
  assert.equal(decoded.ok, true);
  assert.equal(decoded.type, kFrameType.LOG);
  assert.equal(decoded.payload.toString('utf8'), text);
});

test('v2: ack/nack/reset zero payload', () => {
  for (const { fn, type, seq } of [
    { fn: () => encodeAckFrame({ transferId: 10, seq: 5 }), type: kFrameType.ACK, seq: 5 },
    { fn: () => encodeNackFrame({ transferId: 20, seq: 8 }), type: kFrameType.NACK, seq: 8 },
    { fn: () => encodeResetFrame({ transferId: 30 }), type: kFrameType.RESET, seq: 0 },
  ]) {
    const decoded = decodeFrame(fn());
    assert.equal(decoded.ok, true);
    assert.equal(decoded.type, type);
    assert.equal(decoded.payload.length, 0);
    assert.equal(decoded.seq, seq);
  }
});

test('v2: reset always has seq=0', () => {
  const encoded = encodeResetFrame({ transferId: 999 });
  const decoded = decodeFrame(encoded);
  assert.equal(decoded.ok, true);
  assert.equal(decoded.seq, 0);
  assert.equal(decoded.transferId, 999);
});

test('v2: CRC validation – corrupt payload byte', () => {
  const encoded = encodeChunkFrame({ transferId: 1, seq: 0, payload: Buffer.from('hello') });
  const corrupted = Buffer.from(encoded);
  corrupted[kV2HeaderLen] ^= 0xff; // flip first payload byte
  const decoded = decodeFrame(corrupted);
  assert.equal(decoded.ok, false);
  assert.equal(decoded.error, 'crc_mismatch');
});

test('v2: max payload (255 bytes)', () => {
  const payload = Buffer.alloc(255, 0xAB);
  const encoded = encodeChunkFrame({ transferId: 1, seq: 0, payload });
  const decoded = decodeFrame(encoded);
  assert.equal(decoded.ok, true);
  assert.equal(decoded.payload.length, 255);
  assert.deepEqual(decoded.payload, payload);
});

test('v2: payload too large (256 bytes) throws', () => {
  const payload = Buffer.alloc(256);
  assert.throws(() => encodeChunkFrame({ transferId: 1, seq: 0, payload }), /payload_too_large/);
});

test('v2: empty payload chunk (zero-length terminator)', () => {
  const encoded = encodeChunkFrame({ transferId: 50, seq: 3, payload: Buffer.alloc(0) });
  const decoded = decodeFrame(encoded);
  assert.equal(decoded.ok, true);
  assert.equal(decoded.type, kFrameType.CHUNK);
  assert.equal(decoded.payload.length, 0);
  assert.equal(decoded.transferId, 50);
  assert.equal(decoded.seq, 3);
});

test('v2: transfer ID boundaries', () => {
  for (const tid of [0, 65535, 12345]) {
    const encoded = encodeChunkFrame({ transferId: tid, seq: 0, payload: Buffer.from('x') });
    const decoded = decodeFrame(encoded);
    assert.equal(decoded.ok, true);
    assert.equal(decoded.transferId, tid);
  }
});

test('v2: seq boundaries', () => {
  for (const seq of [0, 65535]) {
    const encoded = encodeChunkFrame({ transferId: 1, seq, payload: Buffer.from('y') });
    const decoded = decodeFrame(encoded);
    assert.equal(decoded.ok, true);
    assert.equal(decoded.seq, seq);
  }
});

test('v2: invalid transferId throws', () => {
  assert.throws(() => encodeFrame({ type: kFrameType.CHUNK, transferId: 70000, seq: 0, payload: Buffer.alloc(0) }), /invalid_transfer_id/);
  assert.throws(() => encodeFrame({ type: kFrameType.CHUNK, transferId: -1, seq: 0, payload: Buffer.alloc(0) }), /invalid_transfer_id/);
});

test('v2: invalid seq throws', () => {
  assert.throws(() => encodeFrame({ type: kFrameType.CHUNK, transferId: 0, seq: 70000, payload: Buffer.alloc(0) }), /invalid_seq/);
  assert.throws(() => encodeFrame({ type: kFrameType.CHUNK, transferId: 0, seq: -1, payload: Buffer.alloc(0) }), /invalid_seq/);
});

test('v2: bad magic', () => {
  const buf = Buffer.alloc(kV2MinFrameLen);
  buf[0] = 0x00;
  buf[1] = 0x00;
  const decoded = decodeFrame(buf);
  assert.equal(decoded.ok, false);
  assert.equal(decoded.error, 'bad_magic');
});

test('v2: truncated frame', () => {
  const decoded = decodeFrame(Buffer.alloc(8));
  assert.equal(decoded.ok, false);
  assert.equal(decoded.error, 'frame_too_short');
});

test('v2: length mismatch', () => {
  const encoded = encodeChunkFrame({ transferId: 1, seq: 0, payload: Buffer.from('hello') });
  // Truncate: remove last 2 bytes so len field says 5 but data is shorter
  const truncated = Buffer.from(encoded.subarray(0, encoded.length - 2));
  const decoded = decodeFrame(truncated);
  assert.equal(decoded.ok, false);
  assert.equal(decoded.error, 'length_mismatch');
});

test('v2: tryExtractV2Frame – multiple frames', () => {
  const f1 = encodeChunkFrame({ transferId: 1, seq: 0, payload: Buffer.from('aaa') });
  const f2 = encodeAckFrame({ transferId: 2, seq: 1 });
  const f3 = encodeLogFrameV2('test');
  const joined = Buffer.concat([f1, f2, f3]);

  const r1 = tryExtractV2Frame(joined);
  assert.ok(r1);
  assert.equal(r1.frame.type, kFrameType.CHUNK);
  assert.equal(r1.frame.transferId, 1);
  assert.deepEqual(r1.frame.payload, Buffer.from('aaa'));

  const r2 = tryExtractV2Frame(joined.subarray(r1.consumed));
  assert.ok(r2);
  assert.equal(r2.frame.type, kFrameType.ACK);
  assert.equal(r2.frame.transferId, 2);

  const r3 = tryExtractV2Frame(joined.subarray(r1.consumed + r2.consumed));
  assert.ok(r3);
  assert.equal(r3.frame.type, kFrameType.LOG);
  assert.equal(r3.frame.payload.toString('utf8'), 'test');
});

test('v2: tryExtractV2Frame – partial frame returns null', () => {
  const encoded = encodeChunkFrame({ transferId: 1, seq: 0, payload: Buffer.from('data') });
  const half = encoded.subarray(0, Math.floor(encoded.length / 2));
  assert.equal(tryExtractV2Frame(half), null);
});

test('v2: tryExtractV2Frame – empty buffer returns null', () => {
  assert.equal(tryExtractV2Frame(Buffer.alloc(0)), null);
});

test('v2: tryExtractV2Frame – error frame on bad CRC', () => {
  const encoded = encodeChunkFrame({ transferId: 1, seq: 0, payload: Buffer.from('hi') });
  const corrupted = Buffer.from(encoded);
  corrupted[kV2HeaderLen] ^= 0xff;
  const result = tryExtractV2Frame(corrupted);
  assert.ok(result);
  assert.equal(result.frame.type, 'error');
  assert.equal(result.frame.error, 'crc_mismatch');
  assert.equal(result.consumed, corrupted.length);
});

test('v2: frame size verification', () => {
  for (const n of [0, 1, 100, 255]) {
    const payload = Buffer.alloc(n, 0x42);
    const encoded = encodeChunkFrame({ transferId: 1, seq: 0, payload });
    assert.equal(encoded.length, 12 + n);
  }
});

test('v2: makeV2TransferId returns integer 0–65535', () => {
  for (let i = 0; i < 50; i++) {
    const tid = makeV2TransferId();
    assert.ok(Number.isInteger(tid));
    assert.ok(tid >= 0 && tid <= 65535);
  }
});

test('v2: bad type throws', () => {
  assert.throws(() => encodeFrame({ type: 0x07, transferId: 0, seq: 0, payload: Buffer.alloc(0) }), /bad_type/);
  assert.throws(() => encodeFrame({ type: 0x00, transferId: 0, seq: 0, payload: Buffer.alloc(0) }), /bad_type/);
});
