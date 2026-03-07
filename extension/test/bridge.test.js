import test from 'node:test';
import assert from 'node:assert/strict';

import {
  __resetBleForTest,
  connectBle,
  disconnectBle,
  getConnectedDeviceInfo,
  postEvent
} from '../src/bridge.js';

test('connectBle establishes UART RX characteristic via navigator.bluetooth', async () => {
  __resetBleForTest();
  let requested = null;
  const writes = [];
  const rx = {
    writeValueWithoutResponse: async (value) => writes.push(value)
  };
  const service = {
    getCharacteristic: async () => rx
  };
  const server = {
    connected: true,
    getPrimaryService: async () => service
  };
  const device = {
    gatt: { connected: true, connect: async () => server },
    addEventListener: () => {}
  };
  const navigatorLike = {
    bluetooth: {
      requestDevice: async (opts) => {
        requested = opts;
        return device;
      }
    }
  };

  const connected = await connectBle({ navigatorLike });
  const posted = await postEvent({ type: 'busy.changed', busy: true });

  assert.equal(connected, true);
  assert.equal(posted, true);
  assert.deepEqual(requested.filters, [{ services: ['6e400101-b5a3-f393-e0a9-e50e24dccb01'] }]);
  assert.equal(writes.length, 1);
});

test('postEvent fails when BLE transport is unavailable', async () => {
  __resetBleForTest();
  const ok = await postEvent({ type: 'busy.changed', busy: true });
  assert.equal(ok, false);
});

test('disconnectBle clears connected device metadata', async () => {
  __resetBleForTest();
  const rx = {
    writeValueWithoutResponse: async () => {}
  };
  const service = {
    getCharacteristic: async () => rx
  };
  const server = {
    connected: true,
    getPrimaryService: async () => service
  };
  const gatt = {
    connected: true,
    connect: async () => server,
    disconnect: () => {
      gatt.connected = false;
    }
  };
  const device = {
    id: 'dev-1',
    name: 'air-kvm-ctrl-cb01',
    gatt,
    addEventListener: () => {}
  };
  const navigatorLike = {
    bluetooth: {
      requestDevice: async () => device
    }
  };

  const connected = await connectBle({ navigatorLike });
  assert.equal(connected, true);
  assert.equal(getConnectedDeviceInfo().id, 'dev-1');
  disconnectBle();
  assert.deepEqual(getConnectedDeviceInfo(), { id: null, name: null, connected: false });
});

test('connectBle invokes onDisconnect callback on gatt disconnection', async () => {
  __resetBleForTest();
  let disconnectHandler = null;
  let disconnectCalls = 0;
  const rx = {
    writeValueWithoutResponse: async () => {}
  };
  const tx = {
    addEventListener: () => {},
    startNotifications: async () => {}
  };
  const service = {
    getCharacteristic: async (uuid) => (String(uuid).endsWith('03-b5a3-f393-e0a9-e50e24dccb01') ? tx : rx)
  };
  const server = {
    connected: true,
    getPrimaryService: async () => service
  };
  const device = {
    gatt: { connected: true, connect: async () => server },
    addEventListener: (event, handler) => {
      if (event === 'gattserverdisconnected') {
        disconnectHandler = handler;
      }
    }
  };
  const navigatorLike = {
    bluetooth: {
      requestDevice: async () => device
    }
  };

  const connected = await connectBle({
    navigatorLike,
    onDisconnect: () => {
      disconnectCalls += 1;
    }
  });
  assert.equal(connected, true);
  assert.equal(typeof disconnectHandler, 'function');
  disconnectHandler();
  assert.equal(disconnectCalls, 1);
});
