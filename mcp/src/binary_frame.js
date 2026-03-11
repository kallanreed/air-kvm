// ── Shared constants ────────────────────────────────────────────────
export const kMagic0 = 0x41; // 'A'
export const kMagic1 = 0x4b; // 'K'

// ── CRC-32 (IEEE 802.3) ────────────────────────────────────────────
let crcTable = null;

function getCrcTable() {
  if (crcTable) return crcTable;
  crcTable = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let j = 0; j < 8; j += 1) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    crcTable[i] = c >>> 0;
  }
  return crcTable;
}

export function crc32(bytes) {
  const table = getCrcTable();
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    c = table[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

// ── v2 constants ────────────────────────────────────────────────────
export const kFrameType = {
  CHUNK: 0x01,
  CONTROL: 0x02,
  LOG: 0x03,
  ACK: 0x04,
  NACK: 0x05,
  RESET: 0x06,
};

const kValidTypes = new Set(Object.values(kFrameType));

export const kV2HeaderLen = 8;   // magic(2) + type(1) + tid(2) + seq(2) + len(1)
export const kV2CrcLen = 4;
export const kV2MinFrameLen = 12; // header + crc, no payload
export const kV2MaxPayload = 255;

// ── v2 encode / decode ──────────────────────────────────────────────

export function encodeFrame({ type, transferId, seq, payload }) {
  if (!kValidTypes.has(type)) {
    throw new Error('bad_type');
  }
  if (!Number.isInteger(transferId) || transferId < 0 || transferId > 0xffff) {
    throw new Error('invalid_transfer_id');
  }
  if (!Number.isInteger(seq) || seq < 0 || seq > 0xffff) {
    throw new Error('invalid_seq');
  }
  const buf = payload ? Buffer.from(payload) : Buffer.alloc(0);
  if (buf.length > kV2MaxPayload) {
    throw new Error('payload_too_large');
  }

  const out = Buffer.alloc(kV2HeaderLen + buf.length + kV2CrcLen);
  out[0] = kMagic0;
  out[1] = kMagic1;
  out[2] = type;
  out.writeUInt16LE(transferId, 3);
  out.writeUInt16LE(seq, 5);
  out[7] = buf.length;
  buf.copy(out, kV2HeaderLen);

  // CRC scope: bytes 2 .. end of payload (type + tid + seq + len + payload)
  const crc = crc32(out.subarray(2, kV2HeaderLen + buf.length));
  out.writeUInt32LE(crc >>> 0, kV2HeaderLen + buf.length);
  return out;
}

export function decodeFrame(bytes) {
  const frame = Buffer.from(bytes);
  if (frame.length < kV2MinFrameLen) {
    return { ok: false, error: 'frame_too_short' };
  }
  if (frame[0] !== kMagic0 || frame[1] !== kMagic1) {
    return { ok: false, error: 'bad_magic' };
  }
  const type = frame[2];
  if (!kValidTypes.has(type)) {
    return { ok: false, error: 'bad_type', type };
  }
  const transferId = frame.readUInt16LE(3);
  const seq = frame.readUInt16LE(5);
  const len = frame[7];
  const expectedLen= kV2HeaderLen + len + kV2CrcLen;
  if (frame.length < expectedLen) {
    return { ok: false, error: 'length_mismatch', type, transferId, seq, len };
  }
  const payload = Buffer.from(frame.subarray(kV2HeaderLen, kV2HeaderLen + len));
  const gotCrc = frame.readUInt32LE(kV2HeaderLen + len);
  const wantCrc = crc32(frame.subarray(2, kV2HeaderLen + len));
  if (gotCrc !== wantCrc) {
    return { ok: false, error: 'crc_mismatch', type, transferId, seq, gotCrc, wantCrc };
  }
  return { ok: true, type, transferId, seq, payload };
}

export function tryExtractV2Frame(buffer) {
  if (!buffer || buffer.length === 0) return null;
  if (buffer[0] !== kMagic0 || buffer[1] !== kMagic1) return null;
  if (buffer.length < kV2MinFrameLen) return null;

  const len = buffer[7];
  const totalLen = kV2HeaderLen + len + kV2CrcLen;
  if (buffer.length < totalLen) return null;

  const chunk = buffer.subarray(0, totalLen);
  const decoded = decodeFrame(chunk);
  if (!decoded.ok) {
    return {
      frame: { type: 'error', error: decoded.error },
      consumed: totalLen,
    };
  }
  return {
    frame: {
      type: decoded.type,
      transferId: decoded.transferId,
      seq: decoded.seq,
      payload: decoded.payload,
    },
    consumed: totalLen,
  };
}

export function makeV2TransferId() {
  return Math.floor(Math.random() * 0x10000);
}

// ── v2 convenience encoders ─────────────────────────────────────────

export function encodeChunkFrame({ transferId, seq, payload }) {
  return encodeFrame({ type: kFrameType.CHUNK, transferId, seq, payload: payload || Buffer.alloc(0) });
}

export function encodeAckFrame({ transferId, seq }) {
  return encodeFrame({ type: kFrameType.ACK, transferId, seq, payload: Buffer.alloc(0) });
}

export function encodeNackFrame({ transferId, seq }) {
  return encodeFrame({ type: kFrameType.NACK, transferId, seq, payload: Buffer.alloc(0) });
}

export function encodeResetFrame({ transferId }) {
  return encodeFrame({ type: kFrameType.RESET, transferId, seq: 0, payload: Buffer.alloc(0) });
}

export function encodeControlFrameV2(msg) {
  if (!msg || typeof msg !== 'object') throw new Error('invalid_ctrl_msg');
  const payload = Buffer.from(JSON.stringify(msg), 'utf8');
  return encodeFrame({ type: kFrameType.CONTROL, transferId: 0, seq: 0, payload });
}

export function encodeLogFrameV2(text) {
  if (typeof text !== 'string' || text.length === 0) throw new Error('invalid_text');
  const payload = Buffer.from(text, 'utf8');
  return encodeFrame({ type: kFrameType.LOG, transferId: 0, seq: 0, payload });
}


