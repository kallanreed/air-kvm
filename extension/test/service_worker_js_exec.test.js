import test from 'node:test';
import assert from 'node:assert/strict';

function makeHarness() {
  const postedPayloads = [];
  const runtimeListeners = [];
  const executeScriptCalls = [];
  const createTabCalls = [];
  let executeScriptImpl = async () => [{ result: { ok: true, value_type: 'number', value_json: '1', truncated: false } }];
  let createTabImpl = async ({ url, active }) => ({
    id: 44,
    windowId: 1,
    active: Boolean(active),
    title: 'New Tab',
    url
  });

  globalThis.self = { addEventListener: () => {} };
  globalThis.setInterval = () => 0;

  globalThis.chrome = {
    storage: {
      local: {
        get: async () => ({}),
        set: async () => {}
      },
      session: {
        set: async () => {},
        get: async () => ({})
      }
    },
    runtime: {
      id: 'test',
      getURL: (path) => `chrome-extension://test/${path}`,
      sendMessage: async (msg) => {
        if (msg?.type === 'ble.post') {
          postedPayloads.push(msg.payload);
          return { ok: true };
        }
        if (msg?.type === 'desktop.capture.request') {
          return { ok: false, error: 'unsupported' };
        }
        return { ok: true };
      },
      onMessage: {
        addListener: (fn) => runtimeListeners.push(fn)
      },
      onInstalled: { addListener: () => {} },
      onStartup: { addListener: () => {} },
      onSuspend: { addListener: () => {} },
      onSuspendCanceled: { addListener: () => {} }
    },
    tabs: {
      get: async (id) => ({ id, active: true, windowId: 1, url: 'https://example.com' }),
      query: async () => [{ id: 9, active: true, windowId: 1, url: 'https://example.com' }],
      update: async () => ({}),
      create: async (opts) => {
        createTabCalls.push(opts);
        return createTabImpl(opts);
      }
    },
    scripting: {
      executeScript: async (details) => {
        executeScriptCalls.push(details);
        return executeScriptImpl(details);
      }
    },
    action: {
      setBadgeText: () => {},
      setBadgeBackgroundColor: () => {},
      onClicked: { addListener: () => {} }
    }
  };

  return {
    postedPayloads,
    runtimeListeners,
    executeScriptCalls,
    createTabCalls,
    setExecuteScriptImpl: (impl) => {
      executeScriptImpl = impl;
    },
    setCreateTabImpl: (impl) => {
      createTabImpl = impl;
    }
  };
}

async function importServiceWorkerFresh() {
  return import(`../src/service_worker.js?t=${Date.now()}-${Math.random()}`);
}

function findBleCommandListener(runtimeListeners) {
  const trustedSender = {
    id: 'test',
    url: 'chrome-extension://test/src/ble_bridge.html'
  };
  const listener = runtimeListeners.find((candidate) => {
    let called = false;
    const out = candidate({ type: 'ble.command', command: { type: 'unknown' } }, trustedSender, () => {
      called = true;
    });
    return out === true || called;
  });
  assert.equal(typeof listener, 'function');
  return listener;
}

test('service worker handles js.exec.request and posts js.exec.result via bridge', async () => {
  const harness = makeHarness();
  await importServiceWorkerFresh();

  harness.setExecuteScriptImpl(async () => [{
    result: {
      ok: true,
      value_type: 'string',
      value_json: '"ok"',
      truncated: false
    }
  }]);

  const listener = findBleCommandListener(harness.runtimeListeners);
  let response = null;
  const returned = listener({
    type: 'ble.command',
    command: {
      type: 'js.exec.request',
      request_id: 'js-1',
      script: 'return "ok";',
      timeout_ms: 300,
      max_result_chars: 200
    }
  }, {
    id: 'test',
    url: 'chrome-extension://test/src/ble_bridge.html'
  }, (msg) => {
    response = msg;
  });

  assert.equal(returned, true);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(response, { ok: true });
  assert.equal(harness.executeScriptCalls.length, 1);
  assert.equal(harness.executeScriptCalls[0].world, 'MAIN');

  const resultPayload = harness.postedPayloads.find((payload) => payload?.type === 'js.exec.result');
  assert.equal(Boolean(resultPayload), true);
  assert.equal(resultPayload.request_id, 'js-1');
  assert.equal(resultPayload.value_type, 'string');
  assert.equal(resultPayload.value_json, '"ok"');
  assert.equal(resultPayload.truncated, false);
});

test('service worker returns js_exec_busy when a js exec request is already in flight', async () => {
  const harness = makeHarness();
  await importServiceWorkerFresh();

  let resolveFirst = null;
  harness.setExecuteScriptImpl(() => new Promise((resolve) => {
    resolveFirst = () => resolve([{ result: { ok: true, value_type: 'number', value_json: '1', truncated: false } }]);
  }));

  const listener = findBleCommandListener(harness.runtimeListeners);

  listener({
    type: 'ble.command',
    command: {
      type: 'js.exec.request',
      request_id: 'js-a',
      script: 'return 1;'
    }
  }, {
    id: 'test',
    url: 'chrome-extension://test/src/ble_bridge.html'
  }, () => {});

  listener({
    type: 'ble.command',
    command: {
      type: 'js.exec.request',
      request_id: 'js-b',
      script: 'return 2;'
    }
  }, {
    id: 'test',
    url: 'chrome-extension://test/src/ble_bridge.html'
  }, () => {});

  await new Promise((resolve) => setTimeout(resolve, 0));
  const busyPayload = harness.postedPayloads.find((payload) => payload?.type === 'js.exec.error' && payload.request_id === 'js-b');
  assert.equal(Boolean(busyPayload), true);
  assert.equal(busyPayload.error_code, 'js_exec_busy');

  resolveFirst();
  await new Promise((resolve) => setTimeout(resolve, 0));
});

test('service worker rejects ble.command from untrusted sender', async () => {
  const harness = makeHarness();
  await importServiceWorkerFresh();
  const listener = findBleCommandListener(harness.runtimeListeners);

  let response = null;
  const returned = listener({
    type: 'ble.command',
    command: { type: 'js.exec.request', request_id: 'js-u', script: 'return 1;' }
  }, {
    id: 'other-extension-id',
    url: 'chrome-extension://other/src/ble_bridge.html'
  }, (msg) => {
    response = msg;
  });

  assert.equal(returned, true);
  assert.deepEqual(response, { ok: false, error: 'untrusted_sender' });
  assert.equal(harness.executeScriptCalls.length, 0);
});

test('service worker releases js exec lock after bounded post-timeout hold', async () => {
  const harness = makeHarness();
  await importServiceWorkerFresh();

  let callCount = 0;
  harness.setExecuteScriptImpl(() => {
    callCount += 1;
    if (callCount === 1) {
      return new Promise(() => {});
    }
    return Promise.resolve([{ result: { ok: true, value_type: 'number', value_json: '2', truncated: false } }]);
  });

  const listener = findBleCommandListener(harness.runtimeListeners);
  const sender = {
    id: 'test',
    url: 'chrome-extension://test/src/ble_bridge.html'
  };
  listener({
    type: 'ble.command',
    command: {
      type: 'js.exec.request',
      request_id: 'js-timeout-a',
      script: 'return 1;',
      timeout_ms: 50
    }
  }, sender, () => {});

  await new Promise((resolve) => setTimeout(resolve, 70));

  listener({
    type: 'ble.command',
    command: {
      type: 'js.exec.request',
      request_id: 'js-timeout-b',
      script: 'return 2;'
    }
  }, sender, () => {});
  await new Promise((resolve) => setTimeout(resolve, 0));

  const timeoutPayload = harness.postedPayloads.find((payload) => payload?.request_id === 'js-timeout-a');
  assert.equal(timeoutPayload?.type, 'js.exec.error');
  assert.equal(timeoutPayload?.error_code, 'js_exec_timeout');

  const busyPayload = harness.postedPayloads.find((payload) => payload?.request_id === 'js-timeout-b');
  assert.equal(busyPayload?.type, 'js.exec.error');
  assert.equal(busyPayload?.error_code, 'js_exec_busy');

  await new Promise((resolve) => setTimeout(resolve, 1100));

  listener({
    type: 'ble.command',
    command: {
      type: 'js.exec.request',
      request_id: 'js-timeout-c',
      script: 'return 3;'
    }
  }, sender, () => {});
  await new Promise((resolve) => setTimeout(resolve, 0));

  const finalPayload = harness.postedPayloads.find((payload) => payload?.request_id === 'js-timeout-c');
  assert.equal(finalPayload?.type, 'js.exec.result');
});

test('service worker returns invalid_js_exec_request for empty script', async () => {
  const harness = makeHarness();
  await importServiceWorkerFresh();
  const listener = findBleCommandListener(harness.runtimeListeners);
  const sender = {
    id: 'test',
    url: 'chrome-extension://test/src/ble_bridge.html'
  };

  listener({
    type: 'ble.command',
    command: {
      type: 'js.exec.request',
      request_id: 'js-invalid',
      script: ''
    }
  }, sender, () => {});
  await new Promise((resolve) => setTimeout(resolve, 0));

  const payload = harness.postedPayloads.find((entry) => entry?.request_id === 'js-invalid');
  assert.equal(payload?.type, 'js.exec.error');
  assert.equal(payload?.error_code, 'invalid_js_exec_request');
});

test('service worker maps runtime script failures to js_exec_runtime_error', async () => {
  const harness = makeHarness();
  await importServiceWorkerFresh();
  harness.setExecuteScriptImpl(async () => [{
    result: {
      ok: false,
      error_code: 'js_exec_runtime_error',
      error: 'boom'
    }
  }]);
  const listener = findBleCommandListener(harness.runtimeListeners);
  const sender = {
    id: 'test',
    url: 'chrome-extension://test/src/ble_bridge.html'
  };

  listener({
    type: 'ble.command',
    command: {
      type: 'js.exec.request',
      request_id: 'js-runtime',
      script: 'throw new Error("boom");'
    }
  }, sender, () => {});
  await new Promise((resolve) => setTimeout(resolve, 0));

  const payload = harness.postedPayloads.find((entry) => entry?.request_id === 'js-runtime');
  assert.equal(payload?.type, 'js.exec.error');
  assert.equal(payload?.error_code, 'js_exec_runtime_error');
});

test('service worker handles tab.open.request and posts tab.open via bridge', async () => {
  const harness = makeHarness();
  await importServiceWorkerFresh();
  const listener = findBleCommandListener(harness.runtimeListeners);
  const sender = {
    id: 'test',
    url: 'chrome-extension://test/src/ble_bridge.html'
  };

  listener({
    type: 'ble.command',
    command: {
      type: 'tab.open.request',
      request_id: 'open-1',
      url: 'https://example.com/new',
      active: false
    }
  }, sender, () => {});
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(harness.createTabCalls.length, 1);
  assert.deepEqual(harness.createTabCalls[0], { url: 'https://example.com/new', active: false });
  const payload = harness.postedPayloads.find((entry) => entry?.request_id === 'open-1');
  assert.equal(payload?.type, 'tab.open');
  assert.equal(payload?.tab?.url, 'https://example.com/new');
  assert.equal(payload?.tab?.active, false);
});

test('service worker returns tab.open.error when chrome.tabs.create fails', async () => {
  const harness = makeHarness();
  await importServiceWorkerFresh();
  harness.setCreateTabImpl(async () => {
    throw new Error('tabs_create_failed');
  });
  const listener = findBleCommandListener(harness.runtimeListeners);
  const sender = {
    id: 'test',
    url: 'chrome-extension://test/src/ble_bridge.html'
  };

  listener({
    type: 'ble.command',
    command: {
      type: 'tab.open.request',
      request_id: 'open-err',
      url: 'https://example.com/new'
    }
  }, sender, () => {});
  await new Promise((resolve) => setTimeout(resolve, 0));

  const payload = harness.postedPayloads.find((entry) => entry?.request_id === 'open-err');
  assert.equal(payload?.type, 'tab.open.error');
  assert.equal(payload?.error, 'tabs_create_failed');
});
