import test from 'node:test';
import assert from 'node:assert/strict';

import { createServer } from '../src/server.js';

function makeHarness(sendCommandImpl, options = {}) {
  const sent = [];
  const sentNoWait = [];
  const waited = [];
  const transport = {
    sendCommand: sendCommandImpl || (async () => ({ ok: true, msg: { ok: true } })),
    sendCommandNoWait: async (command) => {
      sentNoWait.push(command);
      return { ok: true };
    },
    waitForFrame: typeof options.waitForFrame === 'function'
      ? async (collector, timeoutMs) => {
        waited.push({ timeoutMs });
        return options.waitForFrame(collector, timeoutMs);
      }
      : undefined
  };
  const server = createServer({
    transport,
    send: (msg) => sent.push(msg)
  });
  return { sent, sentNoWait, waited, server };
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

test('airkvm_exec_js_tab uses stream send for oversized script', async () => {
  const streamSentCommands = [];
  const sent = [];
  const transport = {
    sendCommand: async () => ({ ok: true, msg: { ok: true } }),
    streamRequest: async () => ({ ok: true, data: {} }),
    streamSendCommand: async (command, collector) => {
      streamSentCommands.push(command);
      const result = collector({
        type: 'js.exec.result',
        request_id: 'js-large-1',
        tab_id: 2,
        duration_ms: 8,
        value_type: 'string',
        value_json: '"ok"',
        truncated: false,
        ts: 100
      }, null, []);
      return {
        ok: typeof result.ok === 'boolean' ? result.ok : true,
        msg: result.msg,
        data: result.data,
        frames: [],
      };
    },
  };
  const server = createServer({ transport, send: (msg) => sent.push(msg) });
  const largeScript = 'a'.repeat(5000);

  server.handleRequest({
    jsonrpc: '2.0',
    id: 66,
    method: 'tools/call',
    params: {
      name: 'airkvm_exec_js_tab',
      arguments: { request_id: 'js-large-1', script: largeScript }
    }
  });

  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(streamSentCommands.length, 1);
  assert.equal(streamSentCommands[0].type, 'js.exec.request');
  assert.equal(streamSentCommands[0].script, largeScript);
  const payload = JSON.parse(sent[0].result.content[0].text);
  assert.equal(payload.type, 'js.exec.result');
});

test('airkvm_exec_js_tab stream send timeout surfaces as transport_error', async () => {
  const sent = [];
  const transport = {
    sendCommand: async () => ({ ok: true, msg: { ok: true } }),
    streamRequest: async () => ({ ok: true, data: {} }),
    streamSendCommand: async () => {
      throw new Error('stream_send_timeout');
    },
  };
  const server = createServer({ transport, send: (msg) => sent.push(msg) });
  const largeScript = 'c'.repeat(5000);

  server.handleRequest({
    jsonrpc: '2.0',
    id: 68,
    method: 'tools/call',
    params: {
      name: 'airkvm_exec_js_tab',
      arguments: { request_id: 'js-timeout-1', script: largeScript }
    }
  });

  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(sent.length, 1);
  const payload = JSON.parse(sent[0].result.content[0].text);
  assert.equal(payload.error, 'transport_error');
  assert.equal(payload.detail, 'stream_send_timeout');
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

test('airkvm_dom_snapshot errors when streamRequest is missing', async () => {
  const { sent, server } = makeHarness();

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
  assert.equal(sent[0].isError, true);
  const payload = JSON.parse(sent[0].result.content[0].text);
  assert.equal(payload.error, 'stream_transport_required');
});

test('airkvm_screenshot_tab errors when streamRequest is missing', async () => {
  const { sent, server } = makeHarness();

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
  assert.equal(payload.error, 'stream_transport_required');
});

// --- Stream-path tests (transport.streamRequest present) ---

function makeStreamHarness(streamRequestImpl) {
  const sent = [];
  const transport = {
    sendCommand: async () => ({ ok: true, msg: { ok: true } }),
    sendCommandNoWait: async () => ({ ok: true }),
    streamRequest: streamRequestImpl,
  };
  const server = createServer({
    transport,
    send: (msg) => sent.push(msg),
  });
  return { sent, server };
}

test('stream: airkvm_dom_snapshot returns structured json via streamRequest', async () => {
  const { sent, server } = makeStreamHarness(async () => ({
    ok: true,
    data: { type: 'dom.snapshot', request_id: 'dom-s1', html: '<h1>hi</h1>', title: 'Test' },
  }));

  server.handleRequest({
    jsonrpc: '2.0', id: 100,
    method: 'tools/call',
    params: { name: 'airkvm_dom_snapshot', arguments: { request_id: 'dom-s1' } },
  });

  await new Promise((r) => setTimeout(r, 0));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].isError, undefined);
  const payload = JSON.parse(sent[0].result.content[0].text);
  assert.equal(payload.request_id, 'dom-s1');
  assert.equal(payload.snapshot.html, '<h1>hi</h1>');
});

test('stream: airkvm_dom_snapshot error response via streamRequest', async () => {
  const { sent, server } = makeStreamHarness(async () => ({
    ok: true,
    data: { type: 'dom.snapshot.error', ok: false, request_id: 'dom-s2', error: 'no_tab' },
  }));

  server.handleRequest({
    jsonrpc: '2.0', id: 101,
    method: 'tools/call',
    params: { name: 'airkvm_dom_snapshot', arguments: { request_id: 'dom-s2' } },
  });

  await new Promise((r) => setTimeout(r, 0));
  assert.equal(sent[0].isError, true);
  const payload = JSON.parse(sent[0].result.content[0].text);
  assert.equal(payload.error, 'no_tab');
});

test('stream: airkvm_screenshot_tab returns base64 via streamRequest', async () => {
  const { sent, server } = makeStreamHarness(async () => ({
    ok: true,
    data: {
      type: 'screenshot.response', request_id: 'shot-s1', source: 'tab',
      data: '/9j/fakebase64', mime: 'image/jpeg',
    },
  }));

  server.handleRequest({
    jsonrpc: '2.0', id: 102,
    method: 'tools/call',
    params: {
      name: 'airkvm_screenshot_tab',
      arguments: { request_id: 'shot-s1', max_width: 800, max_height: 600, quality: 0.5 },
    },
  });

  await new Promise((r) => setTimeout(r, 0));
  assert.equal(sent[0].isError, undefined);
  const payload = JSON.parse(sent[0].result.content[0].text);
  assert.equal(payload.request_id, 'shot-s1');
  assert.equal(payload.mime, 'image/jpeg');
  assert.equal(payload.base64, '/9j/fakebase64');
});

test('stream: streamRequest timeout surfaces as transport_error', async () => {
  const { sent, server } = makeStreamHarness(async () => {
    throw new Error('device_timeout');
  });

  server.handleRequest({
    jsonrpc: '2.0', id: 103,
    method: 'tools/call',
    params: { name: 'airkvm_dom_snapshot', arguments: { request_id: 'dom-s3' } },
  });

  await new Promise((r) => setTimeout(r, 0));
  assert.equal(sent[0].isError, true);
  const payload = JSON.parse(sent[0].result.content[0].text);
  assert.equal(payload.error, 'transport_error');
  assert.equal(payload.detail, 'device_timeout');
});

// --- Half-pipe path tests (transport.sendRequest / sendControlCommand) ---

test('halfpipe: airkvm_list_tabs uses sendRequest when available', async () => {
  const sent = [];
  const transport = {
    sendRequest: async (command) => ({
      type: 'tabs.list',
      request_id: command.request_id,
      tabs: [{ id: 1, title: 'Test' }]
    }),
    sendCommand: async () => { throw new Error('should not use old path'); },
  };
  const server = createServer({ transport, send: (msg) => sent.push(msg) });
  server.handleRequest({
    jsonrpc: '2.0', id: 1,
    method: 'tools/call',
    params: { name: 'airkvm_list_tabs', arguments: { request_id: 'req-1' } }
  });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].isError, undefined);
  const result = JSON.parse(sent[0].result.content[0].text);
  assert.equal(result.request_id, 'req-1');
  assert.deepEqual(result.tabs, [{ id: 1, title: 'Test' }]);
});

test('halfpipe: airkvm_send uses sendControlCommand when available', async () => {
  const sent = [];
  const transport = {
    sendControlCommand: async () => ({ ok: true, msg: { ok: true } }),
    sendCommand: async () => { throw new Error('should not use old path'); },
  };
  const server = createServer({ transport, send: (msg) => sent.push(msg) });
  server.handleRequest({
    jsonrpc: '2.0', id: 1,
    method: 'tools/call',
    params: { name: 'airkvm_send', arguments: { command: { type: 'key.tap', key: 'Enter' } } }
  });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].isError, undefined);
});

test('halfpipe: airkvm_dom_snapshot uses sendRequest', async () => {
  const sent = [];
  const transport = {
    sendRequest: async (command) => ({
      type: 'dom.snapshot',
      request_id: command.request_id,
      html: '<h1>hello</h1>',
      title: 'Test Page'
    }),
  };
  const server = createServer({ transport, send: (msg) => sent.push(msg) });
  server.handleRequest({
    jsonrpc: '2.0', id: 2,
    method: 'tools/call',
    params: { name: 'airkvm_dom_snapshot', arguments: { request_id: 'dom-hp-1' } }
  });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].isError, undefined);
  const payload = JSON.parse(sent[0].result.content[0].text);
  assert.equal(payload.request_id, 'dom-hp-1');
  assert.equal(payload.snapshot.html, '<h1>hello</h1>');
});

test('halfpipe: airkvm_screenshot_tab uses sendRequest', async () => {
  const sent = [];
  const transport = {
    sendRequest: async (command) => ({
      type: 'screenshot.response',
      request_id: command.request_id,
      source: 'tab',
      mime: 'image/jpeg',
      data: '/9j/fakebase64'
    }),
  };
  const server = createServer({ transport, send: (msg) => sent.push(msg) });
  server.handleRequest({
    jsonrpc: '2.0', id: 3,
    method: 'tools/call',
    params: {
      name: 'airkvm_screenshot_tab',
      arguments: { request_id: 'shot-hp-1', max_width: 800, max_height: 600, quality: 0.5 }
    }
  });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].isError, undefined);
  const payload = JSON.parse(sent[0].result.content[0].text);
  assert.equal(payload.request_id, 'shot-hp-1');
  assert.equal(payload.mime, 'image/jpeg');
  assert.equal(payload.base64, '/9j/fakebase64');
});

test('halfpipe: airkvm_exec_js_tab uses sendRequest', async () => {
  const sent = [];
  const transport = {
    sendRequest: async (command) => ({
      type: 'js.exec.result',
      request_id: command.request_id,
      tab_id: 2,
      duration_ms: 5,
      value_type: 'string',
      value_json: '"hello"',
      truncated: false
    }),
  };
  const server = createServer({ transport, send: (msg) => sent.push(msg) });
  server.handleRequest({
    jsonrpc: '2.0', id: 4,
    method: 'tools/call',
    params: {
      name: 'airkvm_exec_js_tab',
      arguments: { request_id: 'js-hp-1', script: 'return "hello"' }
    }
  });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].isError, undefined);
  const payload = JSON.parse(sent[0].result.content[0].text);
  assert.equal(payload.type, 'js.exec.result');
  assert.equal(payload.value_json, '"hello"');
});

test('halfpipe: sendRequest error surfaces as transport_error', async () => {
  const sent = [];
  const transport = {
    sendRequest: async () => { throw new Error('device_timeout'); },
  };
  const server = createServer({ transport, send: (msg) => sent.push(msg) });
  server.handleRequest({
    jsonrpc: '2.0', id: 5,
    method: 'tools/call',
    params: { name: 'airkvm_dom_snapshot', arguments: { request_id: 'dom-err-1' } }
  });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].isError, true);
  const payload = JSON.parse(sent[0].result.content[0].text);
  assert.equal(payload.error, 'transport_error');
  assert.equal(payload.detail, 'device_timeout');
});

test('halfpipe: sendRequest error response from device', async () => {
  const sent = [];
  const transport = {
    sendRequest: async () => ({ ok: false, error: 'no_tab', request_id: 'dom-dev-err' }),
  };
  const server = createServer({ transport, send: (msg) => sent.push(msg) });
  server.handleRequest({
    jsonrpc: '2.0', id: 6,
    method: 'tools/call',
    params: { name: 'airkvm_dom_snapshot', arguments: { request_id: 'dom-dev-err' } }
  });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].isError, true);
  const payload = JSON.parse(sent[0].result.content[0].text);
  assert.equal(payload.error, 'no_tab');
});

test('halfpipe: sendControlCommand rejection surfaces as device rejected', async () => {
  const sent = [];
  const transport = {
    sendControlCommand: async () => ({ ok: false, msg: { ok: false, error: 'invalid_key' } }),
  };
  const server = createServer({ transport, send: (msg) => sent.push(msg) });
  server.handleRequest({
    jsonrpc: '2.0', id: 7,
    method: 'tools/call',
    params: { name: 'airkvm_send', arguments: { command: { type: 'key.tap', key: 'Enter' } } }
  });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].isError, true);
  assert.ok(sent[0].result.content[0].text.includes('device rejected'));
});
