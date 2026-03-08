import { gunzipSync } from 'node:zlib';

export const TOOL_DEFINITIONS = [
  {
    name: 'airkvm_send',
    description: 'Validate and forward a control command to the AirKVM device transport.',
    inputSchema: {
      type: 'object',
      properties: {
        command: {
          type: 'object',
          properties: {
            type: { type: 'string' }
          },
          required: ['type']
        }
      },
      required: ['command']
    }
  },
  {
    name: 'airkvm_list_tabs',
    description: 'List automatable browser tabs available on the target extension.',
    inputSchema: {
      type: 'object',
      properties: {
        request_id: { type: 'string' }
      },
      required: []
    }
  },
  {
    name: 'airkvm_dom_snapshot',
    description: 'Request a DOM snapshot from the target extension over the AirKVM transport.',
    inputSchema: {
      type: 'object',
      properties: {
        request_id: { type: 'string' }
      },
      required: []
    }
  },
  {
    name: 'airkvm_screenshot_tab',
    description: 'Request a tab screenshot from the target extension over the AirKVM transport.',
    inputSchema: {
      type: 'object',
      properties: {
        request_id: { type: 'string' },
        max_width: { type: 'integer', minimum: 160, maximum: 1920 },
        max_height: { type: 'integer', minimum: 120, maximum: 1080 },
        quality: { type: 'number', minimum: 0.3, maximum: 0.9 },
        max_chars: { type: 'integer', minimum: 20000, maximum: 200000 },
        tab_id: { type: 'integer' },
        encoding: { type: 'string', enum: ['b64', 'b64z'] }
      },
      required: []
    }
  },
  {
    name: 'airkvm_screenshot_desktop',
    description: 'Request a desktop screenshot from the target extension over the AirKVM transport.',
    inputSchema: {
      type: 'object',
      properties: {
        request_id: { type: 'string' },
        max_width: { type: 'integer', minimum: 160, maximum: 1920 },
        max_height: { type: 'integer', minimum: 120, maximum: 1080 },
        quality: { type: 'number', minimum: 0.3, maximum: 0.9 },
        max_chars: { type: 'integer', minimum: 20000, maximum: 200000 },
        encoding: { type: 'string', enum: ['b64', 'b64z'] }
      },
      required: []
    }
  }
];

export function makeRequestId() {
  return `req_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
}

function base64LooksLikeMime(base64, mime) {
  try {
    const bytes = Buffer.from(base64, 'base64');
    if (bytes.length < 4) return false;
    if (mime === 'image/jpeg') {
      return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    }
    if (mime === 'image/png') {
      return bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
    }
    return true;
  } catch {
    return false;
  }
}

export function isKnownTool(name) {
  return TOOL_DEFINITIONS.some((tool) => tool.name === name);
}

export function isStructuredTool(name) {
  return (
    name === 'airkvm_dom_snapshot' ||
    name === 'airkvm_list_tabs' ||
    name === 'airkvm_screenshot_tab' ||
    name === 'airkvm_screenshot_desktop'
  );
}

export function buildCommandForTool(name, args = {}) {
  if (name === 'airkvm_send') {
    return args?.command;
  }

  const requestId =
    typeof args?.request_id === 'string' && args.request_id.length > 0
      ? args.request_id
      : makeRequestId();

  const screenshotOptions = {};
  if (Number.isInteger(args?.max_width)) screenshotOptions.max_width = args.max_width;
  if (Number.isInteger(args?.max_height)) screenshotOptions.max_height = args.max_height;
  if (typeof args?.quality === 'number') screenshotOptions.quality = args.quality;
  if (Number.isInteger(args?.max_chars)) screenshotOptions.max_chars = args.max_chars;
  if (Number.isInteger(args?.tab_id)) screenshotOptions.tab_id = args.tab_id;
  if (args?.encoding === 'b64' || args?.encoding === 'b64z') screenshotOptions.encoding = args.encoding;

  if (name === 'airkvm_list_tabs') {
    return { type: 'tabs.list.request', request_id: requestId };
  }
  if (name === 'airkvm_dom_snapshot') {
    return { type: 'dom.snapshot.request', request_id: requestId };
  }
  if (name === 'airkvm_screenshot_tab') {
    return { type: 'screenshot.request', source: 'tab', request_id: requestId, ...screenshotOptions };
  }
  if (name === 'airkvm_screenshot_desktop') {
    return { type: 'screenshot.request', source: 'desktop', request_id: requestId, ...screenshotOptions };
  }

  return null;
}

export function createResponseCollector(name, command) {
  if (name === 'airkvm_dom_snapshot') {
    const requestId = command.request_id;
    return (msg) => {
      if (typeof msg.ok === 'boolean' && msg.ok === false) {
        return {
          done: true,
          ok: false,
          data: { request_id: requestId, error: msg.error || 'device_rejected', device: msg }
        };
      }
      if (msg.type === 'dom.snapshot' && msg.request_id === requestId) {
        return {
          done: true,
          ok: true,
          data: { request_id: requestId, snapshot: msg }
        };
      }
      if (msg.type === 'dom.snapshot.error' && msg.request_id === requestId) {
        return {
          done: true,
          ok: false,
          data: { request_id: requestId, error: msg.error || 'dom_snapshot_error', detail: msg }
        };
      }
      return null;
    };
  }

  if (name === 'airkvm_list_tabs') {
    const requestId = command.request_id;
    return (msg) => {
      if (typeof msg.ok === 'boolean' && msg.ok === false) {
        return {
          done: true,
          ok: false,
          data: { request_id: requestId, error: msg.error || 'device_rejected', device: msg }
        };
      }
      if (msg.type === 'tabs.list' && msg.request_id === requestId) {
        return {
          done: true,
          ok: true,
          data: {
            request_id: requestId,
            tabs: Array.isArray(msg.tabs) ? msg.tabs : []
          }
        };
      }
      if (msg.type === 'tabs.list.error' && msg.request_id === requestId) {
        return {
          done: true,
          ok: false,
          data: { request_id: requestId, error: msg.error || 'tabs_list_error', detail: msg }
        };
      }
      return null;
    };
  }

  if (name === 'airkvm_screenshot_tab' || name === 'airkvm_screenshot_desktop') {
    const requestId = command.request_id;
    const maxChars = Number.isInteger(command.max_chars) ? command.max_chars : 200000;
    const chunksBySeq = new Map();
    let meta = null;
    let receivedChars = 0;
    let transferId = null;
    let highestContiguousSeq = -1;
    let lastAckSeq = -1;
    let timeoutRetries = 0;
    const kMaxTimeoutRetries = 3;
    const kAckStride = 8;

    function computeHighestContiguousSeq() {
      let seq = -1;
      while (chunksBySeq.has(seq + 1)) {
        seq += 1;
      }
      return seq;
    }

    function maybeAck(force = false) {
      if (!transferId) return null;
      highestContiguousSeq = computeHighestContiguousSeq();
      if (!force && highestContiguousSeq < 0) return null;
      if (!force && highestContiguousSeq - lastAckSeq < kAckStride) return null;
      if (highestContiguousSeq === lastAckSeq) return null;
      lastAckSeq = highestContiguousSeq;
      return {
        type: 'transfer.ack',
        request_id: requestId,
        transfer_id: transferId,
        highest_contiguous_seq: highestContiguousSeq
      };
    }

    const onFrame = (msg) => {
      const msgRequestId = msg.request_id ?? msg.rid;
      const msgSource = msg.source ?? msg.src;
      const msgError = msg.error ?? msg.e;
      if (typeof msg.ok === 'boolean' && msg.ok === false) {
        return {
          done: true,
          ok: false,
          data: { request_id: requestId, error: msg.error || 'device_rejected', device: msg }
        };
      }
      if (msgRequestId !== requestId) {
        return null;
      }
      if (msg.type === 'screenshot.error') {
        return {
          done: true,
          ok: false,
          data: {
            request_id: requestId,
            source: msgSource || command.source,
            error: msgError || 'screenshot_error',
            detail: msg
          }
        };
      }
      if (msg.type === 'transfer.error' && msgRequestId === requestId) {
        const code = msg.code || msgError || 'transfer_error';
        return {
          done: true,
          ok: false,
          data: {
            request_id: requestId,
            source: msgSource || command.source,
            error: code,
            detail: msg
          }
        };
      }
      if (msg.type === 'screenshot.meta') {
        meta = msg;
        transferId = transferId || msg.transfer_id || msg.tid || null;
      } else if (msg.type === 'transfer.meta') {
        meta = msg;
        transferId = msg.transfer_id || msg.tid || transferId;
      } else if (msg.type === 'screenshot.chunk') {
        const seq = msg.seq ?? msg.q;
        const data = msg.data ?? msg.d;
        if (Number.isInteger(seq) && typeof data === 'string') {
          if (data.length > maxChars) {
            return {
              done: true,
              ok: false,
              data: {
                request_id: requestId,
                source: msgSource || command.source,
                error: 'screenshot_chunk_too_large',
                detail: { seq, length: data.length, max_chars: maxChars }
              }
            };
          }
          if (!chunksBySeq.has(seq)) {
            receivedChars += data.length;
          }
          if (receivedChars > maxChars) {
            return {
              done: true,
              ok: false,
              data: {
                request_id: requestId,
                source: msgSource || command.source,
                error: 'screenshot_response_too_large',
                detail: { received_chars: receivedChars, max_chars: maxChars }
              }
            };
          }
          chunksBySeq.set(seq, data);
        }
      } else if (msg.type === 'transfer.chunk') {
        if (!meta) {
          // Ignore transfer chunks until transfer meta is observed for this request.
          return null;
        }
        const msgTransferId = msg.transfer_id || msg.tid || null;
        if (!msgTransferId) {
          return null;
        }
        if (transferId && msgTransferId !== transferId) {
          return null;
        }
        if (!transferId && msgTransferId) {
          transferId = msgTransferId;
        }
        const seq = msg.seq ?? msg.q;
        const data = msg.data ?? msg.d;
        if (Number.isInteger(seq) && typeof data === 'string') {
          if (data.length > maxChars) {
            return {
              done: true,
              ok: false,
              data: {
                request_id: requestId,
                source: msgSource || command.source,
                error: 'screenshot_chunk_too_large',
                detail: { seq, length: data.length, max_chars: maxChars }
              }
            };
          }
          if (!chunksBySeq.has(seq)) {
            receivedChars += data.length;
          }
          if (receivedChars > maxChars) {
            return {
              done: true,
              ok: false,
              data: {
                request_id: requestId,
                source: msgSource || command.source,
                error: 'screenshot_response_too_large',
                detail: { received_chars: receivedChars, max_chars: maxChars }
              }
            };
          }
          chunksBySeq.set(seq, data);
          const ack = maybeAck(false);
          if (ack) {
            return { done: false, outbound: [ack], extendTimeoutMs: 7000 };
          }
        }
      } else if (msg.type === 'transfer.done') {
        const doneTransferId = msg.transfer_id || msg.tid || null;
        if (transferId && doneTransferId && doneTransferId !== transferId) {
          return null;
        }
      }

      const totalChunks = meta ? (meta.total_chunks ?? meta.tc ?? meta.total ?? meta.t) : null;
      const totalChars = meta ? (meta.total_chars ?? meta.tch) : null;
      const encoding = (meta?.encoding ?? meta?.e ?? command.encoding ?? 'b64');
      if (!meta || !Number.isInteger(totalChunks) || totalChunks < 0) {
        return null;
      }
      if (Number.isInteger(totalChars) && totalChars > maxChars) {
        return {
          done: true,
          ok: false,
          data: {
            request_id: requestId,
            source: msgSource || command.source,
            error: 'screenshot_response_too_large',
            detail: { total_chars: totalChars, max_chars: maxChars }
          }
        };
      }
      if (chunksBySeq.size < totalChunks) {
        return null;
      }

      const ordered = [];
      for (let seq = 0; seq < totalChunks; seq += 1) {
        if (!chunksBySeq.has(seq)) {
          return null;
        }
        ordered.push(chunksBySeq.get(seq));
      }

      const base64 = ordered.join('');
      let normalizedBase64 = base64;
      const mime = (meta.mime ?? meta.m) || 'application/octet-stream';
      if (encoding === 'b64z') {
        try {
          const zipped = Buffer.from(base64, 'base64');
          normalizedBase64 = gunzipSync(zipped).toString('base64');
        } catch {
          return {
            done: true,
            ok: false,
            data: {
              request_id: requestId,
              source: (meta.source ?? meta.src) || command.source,
              error: 'screenshot_decode_failed'
            }
          };
        }
      }
      if (!base64LooksLikeMime(normalizedBase64, mime)) {
        return {
          done: true,
          ok: false,
          data: {
            request_id: requestId,
            source: (meta.source ?? meta.src) || command.source,
            error: 'screenshot_corrupt_payload',
            detail: { mime }
          }
        };
      }
      return {
        done: true,
        ok: true,
        outbound: transferId
          ? [{
            type: 'transfer.done.ack',
            request_id: requestId,
            transfer_id: transferId
          }]
          : undefined,
        data: {
          request_id: requestId,
          source: (meta.source ?? meta.src) || command.source,
          mime,
          total_chunks: totalChunks,
          total_chars: typeof (meta.total_chars ?? meta.tch) === 'number'
            ? (meta.total_chars ?? meta.tch)
            : normalizedBase64.length,
          encoding,
          base64: normalizedBase64
        }
      };
    };
    onFrame.onTimeout = () => {
      if (!transferId) return null;
      if (timeoutRetries >= kMaxTimeoutRetries) {
        return {
          done: true,
          ok: false,
          data: {
            request_id: requestId,
            source: command.source,
            error: 'screenshot_transfer_timeout',
            detail: {
              transfer_id: transferId,
              retries: timeoutRetries,
              highest_contiguous_seq: computeHighestContiguousSeq()
            }
          }
        };
      }
      timeoutRetries += 1;
      const fromSeq = computeHighestContiguousSeq() + 1;
      return {
        done: false,
        outbound: [{
          type: 'transfer.resume',
          request_id: requestId,
          transfer_id: transferId,
          from_seq: fromSeq
        }],
        extendTimeoutMs: 7000
      };
    };
    return onFrame;
  }

  return null;
}
