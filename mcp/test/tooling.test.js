import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';

import {
  buildCommandForTool,
  createResponseCollector,
  isKnownTool,
  isStructuredTool
} from '../src/tooling.js';

test('buildCommandForTool maps screenshot tools to screenshot.request', () => {
  const tab = buildCommandForTool('airkvm_screenshot_tab', {
    request_id: 'r1',
    max_width: 800,
    max_height: 450,
    quality: 0.5,
    max_chars: 70000,
    tab_id: 123,
    encoding: 'b64z'
  });
  const desktop = buildCommandForTool('airkvm_screenshot_desktop', { request_id: 'r2' });
  const tabs = buildCommandForTool('airkvm_list_tabs', { request_id: 't1' });

  assert.deepEqual(tab, {
    type: 'screenshot.request',
    source: 'tab',
    request_id: 'r1',
    max_width: 800,
    max_height: 450,
    quality: 0.5,
    max_chars: 70000,
    tab_id: 123,
    encoding: 'b64z'
  });
  assert.deepEqual(desktop, { type: 'screenshot.request', source: 'desktop', request_id: 'r2' });
  assert.deepEqual(tabs, { type: 'tabs.list.request', request_id: 't1' });
});

test('isKnownTool and isStructuredTool classify tools correctly', () => {
  assert.equal(isKnownTool('airkvm_send'), true);
  assert.equal(isKnownTool('airkvm_dom_snapshot'), true);
  assert.equal(isKnownTool('airkvm_list_tabs'), true);
  assert.equal(isKnownTool('nope'), false);
  assert.equal(isStructuredTool('airkvm_send'), false);
  assert.equal(isStructuredTool('airkvm_list_tabs'), true);
  assert.equal(isStructuredTool('airkvm_screenshot_tab'), true);
});

test('tabs list collector returns structured list payload', () => {
  const command = { type: 'tabs.list.request', request_id: 'tabs-1' };
  const collect = createResponseCollector('airkvm_list_tabs', command);
  const done = collect({
    type: 'tabs.list',
    request_id: 'tabs-1',
    tabs: [{ id: 10, title: 'Example', url: 'https://example.com' }]
  });
  assert.equal(done.done, true);
  assert.equal(done.ok, true);
  assert.equal(done.data.request_id, 'tabs-1');
  assert.equal(done.data.tabs.length, 1);
});

test('dom snapshot collector returns structured success payload', () => {
  const command = { type: 'dom.snapshot.request', request_id: 'dom-1' };
  const collect = createResponseCollector('airkvm_dom_snapshot', command);

  const ignored = collect({ type: 'dom.snapshot', request_id: 'other' });
  assert.equal(ignored, null);

  const done = collect({ type: 'dom.snapshot', request_id: 'dom-1', summary: { title: 'T' } });
  assert.equal(done.done, true);
  assert.equal(done.ok, true);
  assert.equal(done.data.request_id, 'dom-1');
  assert.equal(done.data.snapshot.type, 'dom.snapshot');
});

test('screenshot collector reassembles chunks in sequence order', () => {
  const command = { type: 'screenshot.request', source: 'tab', request_id: 'shot-1' };
  const collect = createResponseCollector('airkvm_screenshot_tab', command);

  assert.equal(collect({ type: 'screenshot.meta', request_id: 'shot-1', source: 'tab', mime: 'image/png', total_chunks: 2, total_chars: 6 }), null);
  assert.equal(collect({ type: 'screenshot.chunk', request_id: 'shot-1', source: 'tab', seq: 1, data: 'DEF' }), null);
  const done = collect({ type: 'screenshot.chunk', request_id: 'shot-1', source: 'tab', seq: 0, data: 'ABC' });

  assert.equal(done.done, true);
  assert.equal(done.ok, true);
  assert.equal(done.data.request_id, 'shot-1');
  assert.equal(done.data.base64, 'ABCDEF');
  assert.equal(done.data.total_chunks, 2);
});

test('screenshot collector returns structured error payload', () => {
  const command = { type: 'screenshot.request', source: 'desktop', request_id: 'shot-2' };
  const collect = createResponseCollector('airkvm_screenshot_desktop', command);

  const done = collect({
    type: 'screenshot.error',
    request_id: 'shot-2',
    source: 'desktop',
    error: 'desktop_capture_denied'
  });

  assert.equal(done.done, true);
  assert.equal(done.ok, false);
  assert.equal(done.data.request_id, 'shot-2');
  assert.equal(done.data.error, 'desktop_capture_denied');
});

test('screenshot collector supports compact screenshot frame keys', () => {
  const command = { type: 'screenshot.request', source: 'tab', request_id: 'shot-compact' };
  const collect = createResponseCollector('airkvm_screenshot_tab', command);

  assert.equal(collect({ type: 'screenshot.meta', rid: 'shot-compact', src: 'tab', m: 'image/jpeg', tc: 2, tch: 6 }), null);
  assert.equal(collect({ type: 'screenshot.chunk', rid: 'shot-compact', src: 'tab', q: 0, d: 'ABC' }), null);
  const done = collect({ type: 'screenshot.chunk', rid: 'shot-compact', src: 'tab', q: 1, d: 'DEF' });

  assert.equal(done.done, true);
  assert.equal(done.ok, true);
  assert.equal(done.data.request_id, 'shot-compact');
  assert.equal(done.data.source, 'tab');
  assert.equal(done.data.mime, 'image/jpeg');
  assert.equal(done.data.total_chunks, 2);
  assert.equal(done.data.base64, 'ABCDEF');
});

test('screenshot collector rejects oversized response from meta total', () => {
  const command = { type: 'screenshot.request', source: 'tab', request_id: 'shot-big-meta', max_chars: 10 };
  const collect = createResponseCollector('airkvm_screenshot_tab', command);

  const done = collect({ type: 'screenshot.meta', rid: 'shot-big-meta', src: 'tab', tc: 1, tch: 11 });
  assert.equal(done.done, true);
  assert.equal(done.ok, false);
  assert.equal(done.data.error, 'screenshot_response_too_large');
});

test('screenshot collector rejects oversized chunk payload', () => {
  const command = { type: 'screenshot.request', source: 'tab', request_id: 'shot-big-chunk', max_chars: 10 };
  const collect = createResponseCollector('airkvm_screenshot_tab', command);

  collect({ type: 'screenshot.meta', rid: 'shot-big-chunk', src: 'tab', tc: 1, tch: 10 });
  const done = collect({ type: 'screenshot.chunk', rid: 'shot-big-chunk', src: 'tab', q: 0, d: 'A'.repeat(11) });
  assert.equal(done.done, true);
  assert.equal(done.ok, false);
  assert.equal(done.data.error, 'screenshot_chunk_too_large');
});

test('screenshot collector decodes b64z payload back to base64 image', () => {
  const command = { type: 'screenshot.request', source: 'tab', request_id: 'shot-z' };
  const collect = createResponseCollector('airkvm_screenshot_tab', command);
  const imageBytes = Buffer.from('hello-image-bytes');
  const zipped = gzipSync(imageBytes).toString('base64');

  assert.equal(collect({ type: 'screenshot.meta', rid: 'shot-z', src: 'tab', m: 'image/jpeg', tc: 1, tch: zipped.length, e: 'b64z' }), null);
  const done = collect({ type: 'screenshot.chunk', rid: 'shot-z', src: 'tab', q: 0, d: zipped });

  assert.equal(done.done, true);
  assert.equal(done.ok, true);
  assert.equal(done.data.encoding, 'b64z');
  assert.equal(done.data.base64, imageBytes.toString('base64'));
});

test('screenshot collector supports transfer.* frames and emits done ack', () => {
  const command = { type: 'screenshot.request', source: 'tab', request_id: 'shot-transfer' };
  const collect = createResponseCollector('airkvm_screenshot_tab', command);

  assert.equal(
    collect({
      type: 'transfer.meta',
      request_id: 'shot-transfer',
      transfer_id: 'tx-1',
      source: 'tab',
      mime: 'image/jpeg',
      total_chunks: 2,
      total_chars: 6
    }),
    null
  );
  assert.equal(
    collect({
      type: 'transfer.chunk',
      request_id: 'shot-transfer',
      transfer_id: 'tx-1',
      source: 'tab',
      seq: 0,
      data: 'ABC'
    }),
    null
  );
  const done = collect({
    type: 'transfer.chunk',
    request_id: 'shot-transfer',
    transfer_id: 'tx-1',
    source: 'tab',
    seq: 1,
    data: 'DEF'
  });
  assert.equal(done.done, true);
  assert.equal(done.ok, true);
  assert.equal(done.data.base64, 'ABCDEF');
  assert.equal(Array.isArray(done.outbound), true);
  assert.equal(done.outbound[0].type, 'transfer.done.ack');
  assert.equal(done.outbound[0].transfer_id, 'tx-1');
});

test('screenshot collector timeout handler emits transfer.resume', () => {
  const command = { type: 'screenshot.request', source: 'tab', request_id: 'shot-resume' };
  const collect = createResponseCollector('airkvm_screenshot_tab', command);

  collect({
    type: 'transfer.meta',
    request_id: 'shot-resume',
    transfer_id: 'tx-resume',
    source: 'tab',
    total_chunks: 3
  });
  collect({
    type: 'transfer.chunk',
    request_id: 'shot-resume',
    transfer_id: 'tx-resume',
    source: 'tab',
    seq: 0,
    data: 'AAA'
  });
  const timed = collect.onTimeout();
  assert.equal(timed.done, false);
  assert.equal(timed.outbound[0].type, 'transfer.resume');
  assert.equal(timed.outbound[0].transfer_id, 'tx-resume');
  assert.equal(timed.outbound[0].from_seq, 1);
});

test('transfer no_such_transfer surfaces structured error', () => {
  const command = { type: 'screenshot.request', source: 'tab', request_id: 'shot-no-such' };
  const collect = createResponseCollector('airkvm_screenshot_tab', command);

  const done = collect({
    type: 'transfer.error',
    request_id: 'shot-no-such',
    source: 'tab',
    code: 'no_such_transfer',
    transfer_id: 'tx-gone'
  });

  assert.equal(done.done, true);
  assert.equal(done.ok, false);
  assert.equal(done.data.error, 'no_such_transfer');
});
