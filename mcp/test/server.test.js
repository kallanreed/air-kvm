import test from 'node:test';
import assert from 'node:assert/strict';

import { createServer } from '../src/server.js';

function makeHarness(sendCommandImpl) {
  const sent = [];
  const transport = {
    sendCommand: sendCommandImpl || (async () => ({ ok: true, msg: { ok: true } }))
  };
  const server = createServer({
    transport,
    send: (msg) => sent.push(msg)
  });
  return { sent, server };
}

test('tools/list includes structured tools', () => {
  const { sent, server } = makeHarness();
  server.handleRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert.equal(sent.length, 1);
  const names = sent[0].result.tools.map((tool) => tool.name);
  assert.deepEqual(names, [
    'airkvm_send',
    'airkvm_list_tabs',
    'airkvm_window_bounds',
    'airkvm_open_tab',
    'airkvm_dom_snapshot',
    'airkvm_exec_js_tab',
    'airkvm_screenshot_tab',
    'airkvm_screenshot_desktop'
  ]);
});

test('airkvm_window_bounds returns structured json content', async () => {
  const { sent, server } = makeHarness(async () => ({
    ok: true,
    data: {
      type: 'window.bounds',
      request_id: 'wb-1',
      tab_id: 2,
      window_id: 5,
      bounds: {
        left: 80,
        top: 40,
        width: 1280,
        height: 900,
        window_state: 'normal'
      },
      ts: 55
    }
  }));

  server.handleRequest({
    jsonrpc: '2.0',
    id: 8,
    method: 'tools/call',
    params: {
      name: 'airkvm_window_bounds',
      arguments: { request_id: 'wb-1' }
    }
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  const payload = JSON.parse(sent[0].result.content[0].text);
  assert.equal(payload.type, 'window.bounds');
  assert.equal(payload.request_id, 'wb-1');
  assert.equal(payload.bounds.left, 80);
});

test('airkvm_open_tab returns structured json content', async () => {
  const { sent, server } = makeHarness(async () => ({
    ok: true,
    data: {
      type: 'tab.open',
      request_id: 'tab-1',
      tab: {
        id: 101,
        window_id: 3,
        active: true,
        title: 'Example',
        url: 'https://example.com'
      },
      ts: 123
    }
  }));

  server.handleRequest({
    jsonrpc: '2.0',
    id: 7,
    method: 'tools/call',
    params: {
      name: 'airkvm_open_tab',
      arguments: { request_id: 'tab-1', url: 'https://example.com', active: true }
    }
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  const payload = JSON.parse(sent[0].result.content[0].text);
  assert.equal(payload.type, 'tab.open');
  assert.equal(payload.request_id, 'tab-1');
  assert.equal(payload.tab.id, 101);
});

test('airkvm_exec_js_tab returns structured json content', async () => {
  const { sent, server } = makeHarness(async () => ({
    ok: true,
    data: {
      type: 'js.exec.result',
      request_id: 'js-1',
      tab_id: 2,
      duration_ms: 8,
      value_type: 'string',
      value_json: '"ok"',
      truncated: false,
      ts: 100
    }
  }));

  server.handleRequest({
    jsonrpc: '2.0',
    id: 6,
    method: 'tools/call',
    params: {
      name: 'airkvm_exec_js_tab',
      arguments: { request_id: 'js-1', script: 'return "ok";' }
    }
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  const payload = JSON.parse(sent[0].result.content[0].text);
  assert.equal(payload.type, 'js.exec.result');
  assert.equal(payload.request_id, 'js-1');
  assert.equal(payload.value_json, '"ok"');
});

test('airkvm_list_tabs returns structured json content', async () => {
  const { sent, server } = makeHarness(async () => ({
    ok: true,
    data: {
      request_id: 'tabs-1',
      tabs: [{ id: 1, title: 'Example', url: 'https://example.com' }]
    }
  }));

  server.handleRequest({
    jsonrpc: '2.0',
    id: 99,
    method: 'tools/call',
    params: {
      name: 'airkvm_list_tabs',
      arguments: { request_id: 'tabs-1' }
    }
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  const payload = JSON.parse(sent[0].result.content[0].text);
  assert.equal(payload.request_id, 'tabs-1');
  assert.equal(payload.tabs.length, 1);
});

test('airkvm_dom_snapshot returns structured json content', async () => {
  const { sent, server } = makeHarness(async () => ({
    ok: true,
    data: {
      request_id: 'dom-1',
      snapshot: { type: 'dom.snapshot', request_id: 'dom-1', summary: { title: 'Example' } }
    }
  }));

  server.handleRequest({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: {
      name: 'airkvm_dom_snapshot',
      arguments: { request_id: 'dom-1' }
    }
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  const payload = JSON.parse(sent[0].result.content[0].text);
  assert.equal(payload.request_id, 'dom-1');
  assert.equal(payload.snapshot.type, 'dom.snapshot');
});

test('airkvm_screenshot_tab returns structured error result on failure', async () => {
  const { sent, server } = makeHarness(async () => ({
    ok: false,
    data: { request_id: 'shot-1', source: 'tab', error: 'permission_denied' }
  }));

  server.handleRequest({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: {
      name: 'airkvm_screenshot_tab',
      arguments: { request_id: 'shot-1' }
    }
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(sent[0].isError, true);
  const payload = JSON.parse(sent[0].result.content[0].text);
  assert.equal(payload.request_id, 'shot-1');
  assert.equal(payload.error, 'permission_denied');
});

test('airkvm_dom_snapshot returns structured transport error payload', async () => {
  const { sent, server } = makeHarness(async () => {
    throw new Error('device_timeout');
  });

  server.handleRequest({
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: {
      name: 'airkvm_dom_snapshot',
      arguments: { request_id: 'dom-timeout' }
    }
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(sent[0].isError, true);
  const payload = JSON.parse(sent[0].result.content[0].text);
  assert.equal(payload.request_id, 'dom-timeout');
  assert.equal(payload.error, 'transport_error');
  assert.equal(payload.detail, 'device_timeout');
});

test('airkvm_dom_snapshot transport error includes diagnostics frames', async () => {
  const err = new Error('device_timeout');
  err.frames = [{ kind: 'log', msg: 'rx.uart {"type":"dom.snapshot.request"}' }];
  err.recentFrames = [{ kind: 'ctrl', msg: { ok: true } }];
  const { sent, server } = makeHarness(async () => {
    throw err;
  });

  server.handleRequest({
    jsonrpc: '2.0',
    id: 5,
    method: 'tools/call',
    params: {
      name: 'airkvm_dom_snapshot',
      arguments: { request_id: 'dom-diag' }
    }
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(sent[0].isError, true);
  const payload = JSON.parse(sent[0].result.content[0].text);
  assert.equal(payload.error, 'transport_error');
  assert.equal(payload.diagnostics.frames.length, 1);
  assert.equal(payload.diagnostics.recent_frames.length, 1);
});
