import test from 'node:test';
import assert from 'node:assert/strict';

import { createServer } from '../src/server.js';
import { formatTransferId } from '../src/binary_frame.js';

function makeServerHarnessWithFrames(framesByRequest = {}) {
  const sent = [];
  const transport = {
    async sendCommand(command, collector) {
      const key = command.request_id;
      const frames = framesByRequest[key] || [];
      for (const frame of frames) {
        const msg = frame.kind === 'ctrl' ? frame.msg : null;
        const collected = collector ? collector(msg, frame, []) : null;
        if (collected?.done) {
          return {
            ok: typeof collected.ok === 'boolean' ? collected.ok : true,
            data: collected.data,
            msg: collected.msg ?? msg
          };
        }
      }
      throw new Error('device_timeout');
    }
  };

  const server = createServer({
    transport,
    send: (msg) => sent.push(msg)
  });
  return { sent, server };
}

async function callScreenshotTool(server, requestId, extraArgs = {}) {
  server.handleRequest({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: 'airkvm_screenshot_tab',
      arguments: { request_id: requestId, ...extraArgs }
    }
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test('reassembles large out-of-order binary screenshot stream', async () => {
  const requestId = 'shot-large-1';
  const transferId = formatTransferId(0x44);
  const chunkCount = 120;
  const chunks = [];
  const parts = [];
  for (let i = 0; i < chunkCount; i += 1) {
    const payload = Buffer.from(`P${String(i).padStart(3, '0')}`);
    parts.push(payload);
    chunks.push({ kind: 'bin', transfer_id: transferId, seq: i, payload });
  }
  const frames = [
    {
      kind: 'ctrl',
      msg: {
        type: 'transfer.meta',
        request_id: requestId,
        transfer_id: transferId,
        source: 'tab',
        mime: 'application/octet-stream',
        total_chunks: chunkCount,
        total_bytes: parts.reduce((acc, p) => acc + p.length, 0)
      }
    },
    ...chunks.reverse(),
    {
      kind: 'ctrl',
      msg: { type: 'transfer.done', request_id: requestId, transfer_id: transferId, total_chunks: chunkCount }
    }
  ];
  const { sent, server } = makeServerHarnessWithFrames({ [requestId]: frames });

  await callScreenshotTool(server, requestId, { max_chars: 200000 });
  const payload = JSON.parse(sent[0].result.content[0].text);
  assert.equal(sent[0].isError, undefined);
  assert.equal(payload.request_id, requestId);
  assert.equal(payload.total_chunks, chunkCount);
  assert.equal(payload.base64, Buffer.concat(parts).toString('base64'));
});

test('missing binary screenshot chunk results in structured transport timeout error', async () => {
  const requestId = 'shot-missing-1';
  const transferId = formatTransferId(0x45);
  const frames = [
    {
      kind: 'ctrl',
      msg: {
        type: 'transfer.meta',
        request_id: requestId,
        transfer_id: transferId,
        source: 'tab',
        mime: 'application/octet-stream',
        total_chunks: 3,
        total_bytes: 9
      }
    },
    { kind: 'bin', transfer_id: transferId, seq: 0, payload: Buffer.from('AAA') },
    { kind: 'bin', transfer_id: transferId, seq: 2, payload: Buffer.from('CCC') },
    { kind: 'ctrl', msg: { type: 'transfer.done', request_id: requestId, transfer_id: transferId, total_chunks: 3 } }
  ];
  const { sent, server } = makeServerHarnessWithFrames({ [requestId]: frames });

  await callScreenshotTool(server, requestId, { max_chars: 200000 });
  const payload = JSON.parse(sent[0].result.content[0].text);
  assert.equal(sent[0].isError, true);
  assert.equal(payload.request_id, requestId);
  assert.equal(payload.error, 'transport_error');
  assert.equal(payload.detail, 'device_timeout');
});

test('explicit screenshot.error is surfaced as structured tool error', async () => {
  const requestId = 'shot-error-1';
  const frames = [
    { kind: 'ctrl', msg: { type: 'screenshot.error', rid: requestId, src: 'tab', e: 'desktop_capture_denied' } }
  ];
  const { sent, server } = makeServerHarnessWithFrames({ [requestId]: frames });

  await callScreenshotTool(server, requestId);
  const payload = JSON.parse(sent[0].result.content[0].text);
  assert.equal(sent[0].isError, true);
  assert.equal(payload.request_id, requestId);
  assert.equal(payload.error, 'desktop_capture_denied');
});
