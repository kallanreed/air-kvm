import { connectBle, getConnectedDeviceInfo, postEvent } from './bridge.js';

const statusEl = document.getElementById('status');
const connectBtn = document.getElementById('connect');
const kDebug = true;
const kHandshakeTimeoutMs = 2000;
const kPreferredDeviceStorageKey = 'blePreferredDeviceId';

function debugLog(...args) {
  if (!kDebug) return;
  console.log('[airkvm-bridge]', ...args);
}

function setStatus(text) {
  if (statusEl) statusEl.textContent = text;
}

function notifySw(status, detail = null) {
  chrome.runtime.sendMessage({ type: 'ble.bridge.status', status, detail }).catch(() => {});
}

async function loadPreferredDeviceId() {
  try {
    const stored = await chrome.storage.local.get(kPreferredDeviceStorageKey);
    return typeof stored?.[kPreferredDeviceStorageKey] === 'string'
      ? stored[kPreferredDeviceStorageKey]
      : null;
  } catch {
    return null;
  }
}

async function savePreferredDeviceId(deviceId) {
  if (!deviceId) return;
  try {
    await chrome.storage.local.set({ [kPreferredDeviceStorageKey]: deviceId });
  } catch {
    // Non-fatal.
  }
}

function unwrapCommand(frame) {
  if (!frame || typeof frame !== 'object') return null;
  if (typeof frame.type === 'string') return frame;
  if (frame.ch === 'ctrl' && frame.msg && typeof frame.msg === 'object') return frame.msg;
  return null;
}

function waitForControlHandshake(state) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      state.pendingHandshake = null;
      resolve(false);
    }, kHandshakeTimeoutMs);
    state.pendingHandshake = () => {
      clearTimeout(timer);
      state.pendingHandshake = null;
      resolve(true);
    };
  });
}

async function connectAndBind() {
  debugLog('connect click');
  notifySw('connect_click');
  setStatus('Connecting...');
  const state = { pendingHandshake: null };
  const preferredDeviceId = await loadPreferredDeviceId();
  debugLog('preferred device', preferredDeviceId);
  try {
    const ok = await connectBle({
      preferredDeviceId,
      requestOptions: {
        filters: [{ services: ['6e400001-b5a3-f393-e0a9-e50e24dcca9e'], namePrefix: 'air-kvm' }],
        optionalServices: ['6e400001-b5a3-f393-e0a9-e50e24dcca9e']
      },
      onCommand: async (command) => {
        const unwrapped = unwrapCommand(command);
        debugLog('rx command from BLE', { raw: command, unwrapped });
        if (!unwrapped) return;
        if (state.pendingHandshake && (unwrapped.type === 'state' || typeof unwrapped.ok === 'boolean')) {
          state.pendingHandshake();
        }
        if (typeof unwrapped.type !== 'string') return;
        try {
          await chrome.runtime.sendMessage({ type: 'ble.command', command: unwrapped });
          debugLog('forwarded ble.command to service worker');
        } catch {
          debugLog('failed to forward ble.command');
          // Background may be unavailable transiently.
        }
      }
    });
    if (!ok) {
      debugLog('connect unavailable in context');
      notifySw('connect_unavailable');
      setStatus('Web Bluetooth unavailable in this context');
      return;
    }
    debugLog('connect success');
    const handshakePending = waitForControlHandshake(state);
    await postEvent({ type: 'state.request' }, { traceId: 'bridge-handshake' });
    const handshakeOk = await handshakePending;
    if (!handshakeOk) {
      debugLog('connect invalid stream (no JSON control response)');
      notifySw('connect_invalid_stream');
      setStatus('Invalid stream (not AirKVM control)');
      return;
    }
    const info = getConnectedDeviceInfo();
    debugLog('connected device info', info);
    await savePreferredDeviceId(info.id);
    notifySw('connect_success');
    setStatus('Connected');
  } catch (err) {
    debugLog('connect error', String(err?.message || err));
    notifySw('connect_error', String(err?.message || err));
    setStatus(`Error: ${String(err?.message || err)}`);
  }
}

connectBtn?.addEventListener('click', () => {
  connectAndBind();
});

notifySw('bridge_loaded');

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== 'ble.post' || msg.target !== 'ble-page') return;
  debugLog('ble.post from service worker', {
    traceId: msg.traceId || null,
    type: msg?.payload?.type,
    bytes: JSON.stringify(msg?.payload || {}).length
  });
  postEvent(msg.payload, { traceId: msg.traceId || null })
    .then((ok) => {
      debugLog('ble.post result', { traceId: msg.traceId || null, ok });
      sendResponse({ ok });
    })
    .catch((err) => {
      const error = String(err?.message || err);
      debugLog('ble.post error', { traceId: msg.traceId || null, error });
      sendResponse({ ok: false, error });
    });
  return true;
});
