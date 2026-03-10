import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateAgentCommand, toDeviceLine } from './protocol.js';
import {
  buildCommandForTool,
  createResponseCollector,
  isKnownTool,
  isStructuredTool,
  TOOL_DEFINITIONS
} from './tooling.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const kTempDir = path.resolve(__dirname, '../../temp');
const kJsExecInlineMaxBytes = 4096;
// FW->BLE command forwarding currently sends control JSON as single notify payloads.
// Keep host->target transfer chunk lines small enough to fit typical BLE notify MTU envelopes.
const kJsExecTransferChunkBytes = 32;
const kJsExecTransferAckWindow = 1;
const kJsExecTransferAckTimeoutMs = 4000;
const kJsExecTransferMaxNackRetries = 4;

function makeToolResultText(text) {
  return { content: [{ type: 'text', text }] };
}

function makeToolResultJson(payload) {
  return makeToolResultText(JSON.stringify(payload));
}

function sanitizeSegment(value, fallback) {
  const text = typeof value === 'string' && value.length > 0 ? value : fallback;
  return text.replace(/[^a-zA-Z0-9._-]+/g, '_');
}

function isScreenshotTool(name) {
  return name === 'airkvm_screenshot_tab' || name === 'airkvm_screenshot_desktop';
}

function extensionForMime(mime) {
  if (mime === 'image/jpeg') return 'jpg';
  if (mime === 'image/png') return 'png';
  if (mime === 'image/webp') return 'webp';
  return 'bin';
}

function maybePersistScreenshot(name, data) {
  if (!isScreenshotTool(name)) return data;
  if (process.env.AIRKVM_SAVE_SCREENSHOTS !== '1') return data;
  if (!data || typeof data.base64 !== 'string' || data.base64.length === 0) return data;
  try {
    // TODO(kyle): Remove test-only screenshot autosave once b64z transfer reliability validation is complete.
    fs.mkdirSync(kTempDir, { recursive: true });
    const ext = extensionForMime(data.mime);
    const source = sanitizeSegment(data.source || 'unknown', 'unknown');
    const requestId = sanitizeSegment(data.request_id || 'screenshot', 'screenshot');
    const filePath = path.join(kTempDir, `${requestId}-${source}-${Date.now()}.${ext}`);
    const bytes = Buffer.from(data.base64, 'base64');
    fs.writeFileSync(filePath, bytes);
    return { ...data, saved_path: filePath, saved_bytes: bytes.length };
  } catch (err) {
    return { ...data, save_error: String(err?.message || err) };
  }
}

function compactFrame(frame) {
  if (!frame || typeof frame !== 'object') return frame;
  if (frame.kind === 'log') return { kind: 'log', msg: frame.msg };
  if (frame.kind === 'ctrl' || frame.kind === 'legacy_ctrl') return { kind: frame.kind, msg: frame.msg };
  if (frame.kind === 'invalid') return { kind: 'invalid', raw: frame.raw };
  return frame;
}

function buildDiagnostics(err) {
  const frames = Array.isArray(err?.frames) ? err.frames.map(compactFrame) : [];
  const recent = Array.isArray(err?.recentFrames) ? err.recentFrames.map(compactFrame) : [];
  if (frames.length === 0 && recent.length === 0) return null;
  return { frames, recent_frames: recent };
}

function makeTransferId() {
  const n = Math.floor(Math.random() * 0xffffffff) >>> 0;
  return `tx_${n.toString(16).padStart(8, '0')}`;
}

function buildJsExecTransferFrames(command) {
  const script = typeof command?.script === 'string' ? command.script : '';
  const scriptBytes = Buffer.from(script, 'utf8');
  const transferId = makeTransferId();
  const chunks = [];
  for (let offset = 0, seq = 0; offset < scriptBytes.length; offset += kJsExecTransferChunkBytes, seq += 1) {
    const end = Math.min(scriptBytes.length, offset + kJsExecTransferChunkBytes);
    chunks.push({
      type: 'transfer.chunk',
      request_id: command.request_id,
      transfer_id: transferId,
      source: 'js.exec.script',
      seq,
      data_b64: scriptBytes.subarray(offset, end).toString('base64')
    });
  }
  return {
    transferId,
    prelude: [
      {
        type: 'transfer.meta',
        request_id: command.request_id,
        transfer_id: transferId,
        source: 'js.exec.script',
        encoding: 'utf8',
        chunk_size: kJsExecTransferChunkBytes,
        total_chunks: chunks.length,
        total_bytes: scriptBytes.length
      },
      ...chunks,
      {
        type: 'transfer.done',
        request_id: command.request_id,
        transfer_id: transferId,
        source: 'js.exec.script',
        total_chunks: chunks.length
      }
    ],
    request: {
      ...command,
      script_transfer_id: transferId,
      script: ''
    }
  };
}

async function sendJsExecWithTransfer(transport, command) {
  if (typeof transport?.sendCommandNoWait !== 'function') {
    return transport.sendCommand(command, createResponseCollector('airkvm_exec_js_tab', command));
  }
  const transfer = buildJsExecTransferFrames(command);
  // Backward-compatible fallback for transports without frame wait support.
  if (typeof transport?.waitForFrame !== 'function') {
    for (const frame of transfer.prelude) {
      await transport.sendCommandNoWait(frame);
    }
    return transport.sendCommand(transfer.request, createResponseCollector('airkvm_exec_js_tab', transfer.request));
  }

  const requestId = transfer.request.request_id;
  const transferId = transfer.transferId;
  const chunks = transfer.prelude.filter((frame) => frame.type === 'transfer.chunk');
  const meta = transfer.prelude.find((frame) => frame.type === 'transfer.meta');
  const done = transfer.prelude.find((frame) => frame.type === 'transfer.done');

  const waitForTransferSignal = async () => {
    const result = await transport.waitForFrame((msg) => {
      if (!msg || typeof msg !== 'object') return null;
      if (
        msg.type === 'transfer.ack' &&
        msg.request_id === requestId &&
        msg.transfer_id === transferId &&
        Number.isInteger(msg.highest_contiguous_seq)
      ) {
        return {
          done: true,
          ok: true,
          data: { signal: 'ack', highest_contiguous_seq: msg.highest_contiguous_seq }
        };
      }
      if (
        msg.type === 'transfer.nack' &&
        msg.request_id === requestId &&
        msg.transfer_id === transferId &&
        Number.isInteger(msg.seq)
      ) {
        return {
          done: true,
          ok: true,
          data: { signal: 'nack', seq: msg.seq }
        };
      }
      if (
        msg.type === 'transfer.resume' &&
        msg.request_id === requestId &&
        msg.transfer_id === transferId &&
        Number.isInteger(msg.from_seq)
      ) {
        return {
          done: true,
          ok: true,
          data: { signal: 'resume', from_seq: msg.from_seq }
        };
      }
      if (
        msg.type === 'transfer.cancel' &&
        msg.request_id === requestId &&
        msg.transfer_id === transferId
      ) {
        return {
          done: true,
          ok: false,
          data: { signal: 'cancel', detail: msg }
        };
      }
      if (
        msg.type === 'transfer.error' &&
        msg.request_id === requestId &&
        msg.transfer_id === transferId
      ) {
        return {
          done: true,
          ok: false,
          data: { signal: 'error', detail: msg }
        };
      }
      return null;
    }, kJsExecTransferAckTimeoutMs);
    return result;
  };

  await transport.sendCommandNoWait(meta);
  let highestAckSeq = -1;
  let nextSeqToSend = 0;
  const nackRetriesBySeq = new Map();
  while (highestAckSeq < chunks.length - 1) {
    const windowEndSeq = Math.min(chunks.length - 1, highestAckSeq + kJsExecTransferAckWindow);
    while (nextSeqToSend <= windowEndSeq) {
      await transport.sendCommandNoWait(chunks[nextSeqToSend]);
      nextSeqToSend += 1;
    }

    const signal = await waitForTransferSignal();
    if (signal?.ok === false) {
      if (signal?.data?.signal === 'cancel') {
        const err = new Error('js_exec_script_transfer_cancelled');
        err.detail = signal?.data?.detail || null;
        throw err;
      }
      const err = new Error('js_exec_script_transfer_error');
      err.detail = signal?.data?.detail || null;
      throw err;
    }
    if (signal?.data?.signal === 'ack') {
      highestAckSeq = Math.max(highestAckSeq, signal.data.highest_contiguous_seq);
      continue;
    }
    if (signal?.data?.signal === 'resume') {
      const fromSeq = signal.data.from_seq;
      if (!Number.isInteger(fromSeq) || fromSeq < 0 || fromSeq >= chunks.length) {
        const err = new Error('js_exec_script_transfer_invalid_resume');
        err.detail = signal.data;
        throw err;
      }
      nextSeqToSend = Math.min(nextSeqToSend, fromSeq);
      highestAckSeq = Math.min(highestAckSeq, fromSeq - 1);
      continue;
    }
    if (signal?.data?.signal === 'nack') {
      const seq = signal.data.seq;
      if (!Number.isInteger(seq) || seq < 0 || seq >= chunks.length) {
        const err = new Error('js_exec_script_transfer_invalid_nack');
        err.detail = signal.data;
        throw err;
      }
      const retries = (nackRetriesBySeq.get(seq) || 0) + 1;
      nackRetriesBySeq.set(seq, retries);
      if (retries > kJsExecTransferMaxNackRetries) {
        const err = new Error('js_exec_script_transfer_nack_retries_exhausted');
        err.detail = { seq, retries };
        throw err;
      }
      nextSeqToSend = Math.min(nextSeqToSend, seq);
      highestAckSeq = Math.min(highestAckSeq, seq - 1);
    }
  }

  await transport.sendCommandNoWait(done);
  return transport.sendCommand(transfer.request, createResponseCollector('airkvm_exec_js_tab', transfer.request));
}

export function createServer({ transport, send }) {
  function onInitialize(id) {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        serverInfo: { name: 'air-kvm-mcp', version: '0.1.0' },
        capabilities: { tools: {} }
      }
    });
  }

  function onToolsList(id) {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        tools: TOOL_DEFINITIONS
      }
    });
  }

  function onToolCall(id, params) {
    const name = params?.name;
    const command = buildCommandForTool(name, params?.arguments || {});

    if (!isKnownTool(name)) {
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Unknown tool' } });
      return;
    }

    const validation = validateAgentCommand(command);
    if (!validation.ok) {
      send({
        jsonrpc: '2.0',
        id,
        result: makeToolResultText(`command rejected: ${validation.error}`),
        isError: true
      });
      return;
    }

    const line = toDeviceLine(command).trim();
    const responseCollector = createResponseCollector(name, command);
    const runTransport = (() => {
      if (name !== 'airkvm_exec_js_tab') {
        return transport.sendCommand(command, responseCollector);
      }
      const serializedBytes = Buffer.byteLength(JSON.stringify(command), 'utf8');
      if (serializedBytes <= kJsExecInlineMaxBytes) {
        return transport.sendCommand(command, responseCollector);
      }
      return sendJsExecWithTransfer(transport, command);
    })();

    runTransport.then((result) => {
      if (isStructuredTool(name)) {
        if (result.ok === false) {
          send({
            jsonrpc: '2.0',
            id,
            result: makeToolResultJson(result.data || { error: 'request_failed' }),
            isError: true
          });
          return;
        }
        send({
          jsonrpc: '2.0',
          id,
          result: makeToolResultJson(maybePersistScreenshot(name, result.data || { ok: true }))
        });
        return;
      }
      const isStateResponse = result?.msg?.type === 'state' && typeof result?.msg?.busy === 'boolean';
      const isExplicitRejection = result?.msg && result.ok === false;
      if (isExplicitRejection) {
        send({
          jsonrpc: '2.0',
          id,
          result: makeToolResultText(`device rejected ${line}: ${JSON.stringify(result.msg)}`),
          isError: true
        });
        return;
      }
      if (command.type === 'state.request' && isStateResponse) {
        send({
          jsonrpc: '2.0',
          id,
          result: makeToolResultText(`forwarded ${line}; state=${JSON.stringify(result.msg)}`)
        });
        return;
      }
      send({
        jsonrpc: '2.0',
        id,
        result: makeToolResultText(`forwarded ${line}`)
      });
    }).catch((err) => {
      const diagnostics = buildDiagnostics(err);
      if (isStructuredTool(name)) {
        send({
          jsonrpc: '2.0',
          id,
          result: makeToolResultJson({
            request_id: command.request_id || null,
            error: 'transport_error',
            detail: err.message,
            diagnostics
          }),
          isError: true
        });
        return;
      }
      send({
        jsonrpc: '2.0',
        id,
        result: makeToolResultText(
          diagnostics
            ? `transport error: ${err.message}; diagnostics=${JSON.stringify(diagnostics)}`
            : `transport error: ${err.message}`
        ),
        isError: true
      });
    });
  }

  function handleRequest(msg) {
    if (msg?.jsonrpc !== '2.0') return;

    if (msg.method === 'initialize') {
      onInitialize(msg.id);
      return;
    }

    if (msg.method === 'tools/list') {
      onToolsList(msg.id);
      return;
    }

    if (msg.method === 'tools/call') {
      onToolCall(msg.id, msg.params);
      return;
    }

    if (typeof msg.id !== 'undefined') {
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } });
    }
  }

  return { handleRequest };
}
