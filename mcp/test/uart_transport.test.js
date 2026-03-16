import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { UartTransport } from '../src/uart.js';
import {
  encodeControlFrame,
  kFrameType,
  kTarget,
} from '../../shared/binary_frame.js';
import { HalfPipe } from '../../shared/halfpipe.js';

function makeTestTransport(commandTimeoutMs = 100) {
  const writes = [];
  const transport = new UartTransport({
    portPath: 'TEST_PORT',
    baudRate: 115200,
    commandTimeoutMs
  });

  transport.open = async function openStub() {
    this.opened = true;
    this.serialPort = {
      write: (data, cb) => {
        writes.push(data instanceof Uint8Array ? Buffer.from(data) : Buffer.from(String(data)));
        cb();
      },
      drain: (cb) => cb(),
      isOpen: false,
      close: (cb) => cb?.()
    };
    if (!this.halfpipe) {
      this.halfpipe = new HalfPipe({
        writeFn: async (frameBytes) => {
          await new Promise((resolve, reject) => {
            this.serialPort.write(frameBytes, (err) => {
              if (err) reject(err);
              else this.serialPort.drain((drainErr) => (drainErr ? reject(drainErr) : resolve()));
            });
          });
        },
        ackTarget: kTarget.EXTENSION,
        log: () => {},
      });
    }
  };

  return { transport, writes };
}

const fwTool = { target: 'fw' };
const hidTool = { target: 'hid' };
const extTool = { target: 'extension' };
const extToolWithMatcher = {
  target: 'extension',
  matchResponse: (cmd, msg) => msg?.type === 'tabs.list' && msg?.request_id === cmd.request_id
};

test('feedBytes routes valid CONTROL frame to halfpipe onControl', async () => {
  const { transport } = makeTestTransport();
  await transport.open();

  const received = [];
  transport.halfpipe.onControl((msg) => received.push(msg));

  const frame = encodeControlFrame({ ok: true, type: 'state', busy: false });
  transport.halfpipe.feedBytes(frame);

  assert.equal(received.length, 1);
  assert.equal(received[0].type, 'state');
  transport.close();
});

test('feedBytes skips garbage bytes before magic', async () => {
  const { transport } = makeTestTransport();
  await transport.open();

  const received = [];
  transport.halfpipe.onControl((msg) => received.push(msg));

  const garbage = Buffer.from([0x00, 0x01, 0x02, 0xFF]);
  const frame = encodeControlFrame({ ok: true });
  transport.halfpipe.feedBytes(Buffer.concat([garbage, frame]));

  assert.equal(received.length, 1);
  transport.close();
});

test('feedBytes handles split frame (incremental delivery)', async () => {
  const { transport } = makeTestTransport();
  await transport.open();

  const received = [];
  transport.halfpipe.onControl((msg) => received.push(msg));

  const frame = encodeControlFrame({ ok: true });
  transport.halfpipe.feedBytes(frame.subarray(0, 6));
  assert.equal(received.length, 0);

  transport.halfpipe.feedBytes(frame.subarray(6));
  assert.equal(received.length, 1);
  transport.close();
});

test('feedBytes drops corrupted frame (bad CRC)', async () => {
  const { transport } = makeTestTransport();
  await transport.open();

  const received = [];
  transport.halfpipe.onControl((msg) => received.push(msg));

  const frame = Buffer.from(encodeControlFrame({ ok: true }));
  frame[8] ^= 0xff; // corrupt payload byte
  transport.halfpipe.feedBytes(frame);

  assert.equal(received.length, 0);
  transport.close();
});

test('send (extension tool) sends CHUNK frames and resolves on message', async () => {
  const { transport } = makeTestTransport();
  await transport.open();

  const pending = transport.send(
    { type: 'tabs.list.request', request_id: 'tl-1' },
    extTool,
    { timeoutMs: 200 }
  );

  setTimeout(() => {
    transport._handleMessage({ type: 'tabs.list', request_id: 'tl-1', tabs: [] });
  }, 10);

  const result = await pending;
  assert.equal(result.data.type, 'tabs.list');
  transport.close();
});

test('send (extension tool) ignores unmatched messages until request_id matches', async () => {
  const { transport } = makeTestTransport();
  await transport.open();

  const pending = transport.send(
    { type: 'tabs.list.request', request_id: 'tl-2' },
    extTool,
    { timeoutMs: 200 }
  );

  setTimeout(() => {
    transport._handleMessage({ type: 'state.set', busy: true });
    transport._handleMessage({ type: 'tabs.list', request_id: 'wrong-id', tabs: [{ id: 1 }] });
    transport._handleMessage({ type: 'tabs.list', request_id: 'tl-2', tabs: [] });
  }, 10);

  const result = await pending;
  assert.equal(result.data.request_id, 'tl-2');
  assert.deepEqual(result.data.tabs, []);
  transport.close();
});

test('send (extension tool) honors tool.matchResponse when provided', async () => {
  const { transport } = makeTestTransport();
  await transport.open();

  const pending = transport.send(
    { type: 'tabs.list.request', request_id: 'tl-3' },
    extToolWithMatcher,
    { timeoutMs: 200 }
  );

  setTimeout(() => {
    transport._handleMessage({ type: 'bridge.logs', request_id: 'tl-3', lines: ['noise'] });
    transport._handleMessage({ type: 'tabs.list', request_id: 'tl-3', tabs: [{ id: 7 }] });
  }, 10);

  const result = await pending;
  assert.equal(result.data.type, 'tabs.list');
  assert.deepEqual(result.data.tabs, [{ id: 7 }]);
  transport.close();
});

test('send (fw tool) sends CONTROL frame and resolves on ok response', async () => {
  const { transport, writes } = makeTestTransport();
  await transport.open();

  const pending = transport.send({ type: 'mouse.click', button: 'left' }, fwTool, { timeoutMs: 200 });

  setTimeout(() => {
    transport._handleControl({ ok: true });
  }, 10);

  const result = await pending;
  assert.equal(result.ok, true);

  // Verify a binary AK frame was written
  assert.ok(writes.length >= 1);
  assert.equal(writes[0][0], 0x41); // 'A'
  assert.equal(writes[0][1], 0x4b); // 'K'
  // Type byte should have FW target bits set
  assert.equal((writes[0][2] >> 5) & 0x7, kTarget.FW);
  assert.equal(writes[0][2] & 0x1f, kFrameType.CONTROL);
  transport.close();
});

test('send (fw tool) resolves on first non-boot CONTROL frame', async () => {
  const { transport } = makeTestTransport();
  await transport.open();

  const pending = transport.send({ type: 'state.request' }, fwTool, { timeoutMs: 200 });

  setTimeout(() => {
    transport._handleControl({ type: 'state', busy: false });
  }, 10);

  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal(result.data.type, 'state');
  assert.equal(result.data.busy, false);
  transport.close();
});

test('send (hid tool) sends CONTROL frame with HID target bits', async () => {
  const { transport, writes } = makeTestTransport();
  await transport.open();

  const pending = transport.send({ type: 'mouse.click', button: 'left' }, hidTool, { timeoutMs: 200 });

  setTimeout(() => {
    transport._handleControl({ ok: true });
  }, 10);

  const result = await pending;
  assert.equal(result.ok, true);

  assert.ok(writes.length >= 1);
  assert.equal(writes[0][0], 0x41); // 'A'
  assert.equal(writes[0][1], 0x4b); // 'K'
  assert.equal((writes[0][2] >> 5) & 0x7, kTarget.HID);
  assert.equal(writes[0][2] & 0x1f, kFrameType.CONTROL);
  transport.close();
});

test('send times out on fw tool', async () => {
  const { transport } = makeTestTransport();
  await transport.open();
  await assert.rejects(
    () => transport.send({ type: 'state.request' }, fwTool, { timeoutMs: 30 }),
    /device_timeout/
  );
  transport.close();
});

test('send times out on extension tool', async () => {
  const { transport } = makeTestTransport();
  await transport.open();
  await assert.rejects(
    () => transport.send({ type: 'tabs.list.request' }, extTool, { timeoutMs: 30 }),
    /device_timeout/
  );
  transport.close();
});

test('close cleans up halfpipe', async () => {
  const { transport } = makeTestTransport();
  await transport.open();
  assert.ok(transport.halfpipe);
  transport.close();
  assert.equal(transport.halfpipe, null);
  assert.equal(transport.opened, false);
});

test('log writes timestamped lines to configured file', async () => {
  const logPath = path.join(os.tmpdir(), `airkvm-uart-${Date.now()}-${Math.random().toString(16).slice(2)}.log`);
  const transport = new UartTransport({
    portPath: 'TEST_PORT',
    commandTimeoutMs: 100,
    logPath
  });

  transport.log('test line');
  await new Promise((resolve) => setTimeout(resolve, 20));
  transport.close();

  const text = fs.readFileSync(logPath, 'utf8');
  assert.match(text, /\[uart\] test line/);
  fs.unlinkSync(logPath);
});

test('concurrent send() calls are serialized — second waits for first', async () => {
  const { transport } = makeTestTransport(500);
  await transport.open();

  const order = [];

  const p1 = transport.send({ type: 'mouse.click', button: 'left' }, fwTool, { timeoutMs: 500 });
  const p2 = transport.send({ type: 'state.request' }, fwTool, { timeoutMs: 500 });

  // Resolve p1 after a tick; p2 must not have started yet (_pending still belongs to p1)
  setTimeout(() => {
    order.push('respond-1');
    transport._handleControl({ ok: true });
  }, 20);

  // Resolve p2 after p1 is settled
  setTimeout(() => {
    order.push('respond-2');
    transport._handleControl({ ok: true });
  }, 60);

  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(r1.ok, true);
  assert.equal(r2.ok, true);
  // Both responses arrived in order, confirming serialization
  assert.deepEqual(order, ['respond-1', 'respond-2']);
  transport.close();
});

test('concurrent send(): first failure does not block second', async () => {
  const { transport } = makeTestTransport(500);
  await transport.open();

  const p1 = transport.send({ type: 'mouse.click', button: 'left' }, fwTool, { timeoutMs: 40 });
  const p2 = transport.send({ type: 'state.request' }, fwTool, { timeoutMs: 200 });

  // p1 times out; p2 should then proceed and succeed
  setTimeout(() => {
    transport._handleControl({ ok: true });
  }, 80);

  await assert.rejects(() => p1, /device_timeout/);
  const r2 = await p2;
  assert.equal(r2.ok, true);
  transport.close();
});
