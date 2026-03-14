// Transport layer for ble_bridge.html: owns the HalfPipe instance, BLE connection lifecycle,
// health watchdog, and preferred-device persistence. UI helpers are imported from ble_bridge_ui.js.
// Outbound payloads arrive from the service worker as { type:'hp.send' } and are chunked via
// HalfPipe to BLE; inbound BLE bytes are fed into HalfPipe and reassembled messages are
// forwarded to the SW as { type:'hp.message' }.
import { HalfPipe } from '../../shared/halfpipe.js';
import { kTarget } from '../../shared/binary_frame.js';
import {
  connectBle,
  disconnectBle,
  getConnectedDeviceInfo,
  postBinary,
  readBleTxSnapshot,
  setBleVerboseDebug,
  setBleDebugLogger
} from './bridge.js';
import {
  debugLog, infoLog, setStatus, setControlsDisabled,
  refreshAutoscrollButton, refreshVerboseButton,
  loadVerboseLoggingPref, persistVerboseLoggingPref,
  isVerboseLoggingEnabled, setVerboseLoggingEnabled,
  isAutoScrollEnabled, setAutoScrollEnabled,
  captureDesktopDataUrl, appendStampedLog,
  connectBtn, disconnectBtn, forgetBtn, reconnectBtn,
  clearLogBtn, toggleAutoscrollBtn, toggleVerboseBtn, logEl,
  clearLog
} from './ble_bridge_ui.js';

const kHandshakeTimeoutMs = 6000;
const kHandshakeAttempts = 3;
const kPreferredDeviceStorageKey = 'blePreferredDeviceId';
const kPreferredDeviceNameStorageKey = 'blePreferredDeviceName';
const kHealthPingIntervalMs = 6000;
const kHealthPingTimeoutMs = 4000;
const kHealthMaxMisses = 4;
const kHealthSuspendMsDom = 15000;
const kHealthSuspendMsScreenshot = 45000;
let connectInFlight = false;
let disconnectInFlight = false;
let healthTimer = null;
let healthState = {
  misses: 0,
  pendingPingResolve: null,
  suspendedUntil: 0,
  lastActivityAt: 0
};
let lastCommandContext = null;
let connectState = { pendingHandshake: null };

const hp = new HalfPipe({
  writeFn: async (bytes) => { await postBinary(bytes); },
  ackTarget: kTarget.MCP,
  log: (msg) => debugLog('[halfpipe]', msg),
});

hp.onMessage((msg) => {
  chrome.runtime.sendMessage({ type: 'hp.message', msg }).catch(() => {});
});

hp.onControl((msg) => {
  noteControlFrameForHealth(msg);
  if (connectState.pendingHandshake && (msg?.type === 'state' || msg?.type === 'boot' || typeof msg?.ok === 'boolean')) {
    connectState.pendingHandshake();
  }
});

hp.onLog((text) => {
  debugLog('[fw-log]', text);
});

function summarizeCommand(frame) {
  if (!frame || typeof frame !== 'object') return { type: 'unknown' };
  const inferredType = typeof frame.type === 'string'
    ? frame.type
    : (typeof frame.ok === 'boolean' ? 'ack' : 'unknown');
  return {
    type: inferredType,
    request_id: typeof frame.request_id === 'string' ? frame.request_id : undefined,
    transfer_id: typeof frame.transfer_id === 'string' ? frame.transfer_id : undefined,
    seq: Number.isInteger(frame.seq) ? frame.seq : undefined,
    from_seq: Number.isInteger(frame.from_seq) ? frame.from_seq : undefined,
    highest_contiguous_seq: Number.isInteger(frame.highest_contiguous_seq) ? frame.highest_contiguous_seq : undefined,
    ok: typeof frame.ok === 'boolean' ? frame.ok : undefined,
    error: typeof frame.error === 'string' ? frame.error : undefined
  };
}

function isVerboseOnlyCommand(frame) {
  if (!frame || typeof frame !== 'object') return true;
  if (typeof frame.type === 'string') {
    return frame.type === 'transfer.ack';
  }
  // Plain transport ACK frame like {"ok":true}
  if (typeof frame.ok === 'boolean') return true;
  return false;
}

function commandLog(direction, frame) {
  lastCommandContext = {
    direction,
    type: typeof frame?.type === 'string' ? frame.type : null,
    request_id: typeof frame?.request_id === 'string' ? frame.request_id : null,
    transfer_id: typeof frame?.transfer_id === 'string' ? frame.transfer_id : null,
    ts: Date.now()
  };
  if (!isVerboseLoggingEnabled() && direction === 'SW->BLE') return;
  if (!isVerboseLoggingEnabled() && isVerboseOnlyCommand(frame)) return;
  infoLog(`[cmd] ${direction}`, summarizeCommand(frame));
}

setBleDebugLogger((...args) => {
  if (!isVerboseLoggingEnabled()) return;
  appendStampedLog('[ble]', args);
});

function stopHealthWatchdog() {
  if (healthTimer) {
    clearInterval(healthTimer);
    healthTimer = null;
  }
  if (healthState.pendingPingResolve) {
    healthState.pendingPingResolve(false);
    healthState.pendingPingResolve = null;
  }
  healthState.misses = 0;
}

async function markDisconnected(reason) {
  if (disconnectInFlight) return;
  disconnectInFlight = true;
  const connectedInfo = getConnectedDeviceInfo();
  infoLog('[telemetry]', {
    evt: 'ble.disconnect.snapshot',
    reason: reason || null,
    gatt_connected: Boolean(connectedInfo.connected),
    health_misses: Number.isInteger(healthState.misses) ? healthState.misses : 0,
    last_activity_at: healthState.lastActivityAt || null,
    last_command_context: lastCommandContext
  });
  stopHealthWatchdog();
  hp.reset().catch(() => {});
  disconnectBle();
  notifySw('disconnect', reason || null);
  setStatus(reason ? `Disconnected (${reason})` : 'Disconnected');
  disconnectInFlight = false;
}

function waitForHealthAck() {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (healthState.pendingPingResolve) {
        healthState.pendingPingResolve = null;
      }
      resolve(false);
    }, kHealthPingTimeoutMs);
    healthState.pendingPingResolve = (ok) => {
      clearTimeout(timer);
      healthState.pendingPingResolve = null;
      resolve(Boolean(ok));
    };
  });
}

function markBridgeActivity(reason = 'activity') {
  healthState.lastActivityAt = Date.now();
  if (healthState.pendingPingResolve) {
    healthState.pendingPingResolve(true);
  }
  if (isVerboseLoggingEnabled()) {
    debugLog('health activity', { reason });
  }
}

function noteControlFrameForHealth(unwrapped) {
  if (!unwrapped) return;
  markBridgeActivity(unwrapped.type || 'ctrl_frame');
  if (unwrapped.type === 'dom.snapshot.request') {
    healthState.suspendedUntil = Math.max(healthState.suspendedUntil, Date.now() + kHealthSuspendMsDom);
  } else if (unwrapped.type === 'screenshot.request') {
    healthState.suspendedUntil = Math.max(healthState.suspendedUntil, Date.now() + kHealthSuspendMsScreenshot);
  } else if (typeof unwrapped.type === 'string' && unwrapped.type.startsWith('transfer.')) {
    // Active transfer frames are proof-of-life; avoid watchdog false positives.
    healthState.suspendedUntil = Math.max(healthState.suspendedUntil, Date.now() + kHealthPingIntervalMs);
  }
  if (!healthState.pendingPingResolve) return;
  if (unwrapped.type === 'state' || typeof unwrapped.ok === 'boolean') {
    healthState.pendingPingResolve(true);
  }
}

function startHealthWatchdog() {
  stopHealthWatchdog();
  healthTimer = setInterval(async () => {
    if (Date.now() < healthState.suspendedUntil) {
      return;
    }
    if (Date.now() - healthState.lastActivityAt < kHealthPingIntervalMs * 2) {
      healthState.misses = 0;
      return;
    }
    const info = getConnectedDeviceInfo();
    if (!info.connected) {
      debugLog('health disconnected at gatt layer');
      await markDisconnected('health:gatt_disconnected');
      return;
    }
    const ackWait = waitForHealthAck();
    let posted = false;
    try { await hp.send({ type: 'state.request' }, kTarget.MCP); posted = true; } catch { posted = false; }
    if (!posted) {
      healthState.misses += 1;
      debugLog('health ping send failed', { misses: healthState.misses });
    } else {
      const ok = await ackWait;
      if (ok) {
        healthState.misses = 0;
      } else {
        healthState.misses += 1;
        debugLog('health ping timeout', { misses: healthState.misses });
      }
    }

    if (healthState.misses >= kHealthMaxMisses) {
      debugLog('health watchdog disconnecting', { misses: healthState.misses });
      await markDisconnected('health:timeout');
    }
  }, kHealthPingIntervalMs);
}

function notifySw(status, detail = null) {
  chrome.runtime.sendMessage({ type: 'ble.bridge.status', status, detail }).catch(() => {});
}

function loadPreferredDeviceLocalFallback() {
  try {
    const id = globalThis.localStorage?.getItem(kPreferredDeviceStorageKey) || null;
    const name = globalThis.localStorage?.getItem(kPreferredDeviceNameStorageKey) || null;
    return { id, name };
  } catch {
    return { id: null, name: null };
  }
}

function savePreferredDeviceLocalFallback(id, name) {
  try {
    if (id) globalThis.localStorage?.setItem(kPreferredDeviceStorageKey, id);
    if (name) globalThis.localStorage?.setItem(kPreferredDeviceNameStorageKey, name);
  } catch {
    // Non-fatal.
  }
}

function clearPreferredDeviceLocalFallback() {
  try {
    globalThis.localStorage?.removeItem(kPreferredDeviceStorageKey);
    globalThis.localStorage?.removeItem(kPreferredDeviceNameStorageKey);
  } catch {
    // Non-fatal.
  }
}

async function loadPreferredDevice() {
  try {
    const stored = await chrome.storage.local.get(kPreferredDeviceStorageKey);
    const storedName = await chrome.storage.local.get(kPreferredDeviceNameStorageKey);
    const id = typeof stored?.[kPreferredDeviceStorageKey] === 'string'
      ? stored[kPreferredDeviceStorageKey]
      : null;
    const name = typeof storedName?.[kPreferredDeviceNameStorageKey] === 'string'
      ? storedName[kPreferredDeviceNameStorageKey]
      : null;
    if (id || name) {
      debugLog('preferred device from chrome.storage', { id, name });
      return { id, name };
    }
    const fallback = loadPreferredDeviceLocalFallback();
    debugLog('preferred device from localStorage fallback', fallback);
    return fallback;
  } catch {
    const fallback = loadPreferredDeviceLocalFallback();
    debugLog('preferred device fallback after storage error', fallback);
    return fallback;
  }
}

async function savePreferredDevice(deviceId, deviceName) {
  if (!deviceId && !deviceName) return;
  debugLog('saving preferred device', { deviceId: deviceId || null, deviceName: deviceName || null });
  try {
    const payload = {};
    if (deviceId) payload[kPreferredDeviceStorageKey] = deviceId;
    if (deviceName) payload[kPreferredDeviceNameStorageKey] = deviceName;
    await chrome.storage.local.set(payload);
  } catch {
    // Non-fatal.
  }
  savePreferredDeviceLocalFallback(deviceId, deviceName);
}

async function clearPreferredDeviceId() {
  debugLog('clearing preferred device');
  try {
    await chrome.storage.local.remove([kPreferredDeviceStorageKey, kPreferredDeviceNameStorageKey]);
  } catch {
    // Non-fatal.
  }
  clearPreferredDeviceLocalFallback();
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

async function connectAndBind(options = {}) {
  const allowChooserFallback = options.allowChooserFallback !== false;
  const trigger = options.trigger || 'manual';
  if (connectInFlight) {
    infoLog('connect ignored: already in progress');
    return;
  }
  connectInFlight = true;
  setControlsDisabled(true);
  infoLog('connect start', { trigger, allowChooserFallback });
  notifySw(trigger === 'auto' ? 'connect_auto_start' : 'connect_click');
  setStatus(trigger === 'auto' ? 'Auto-connecting...' : 'Connecting...');
  connectState.pendingHandshake = null;
  const state = connectState;
  const preferred = await loadPreferredDevice();
  if (trigger === 'auto' && typeof globalThis.navigator?.bluetooth?.getDevices === 'function') {
    try {
      const known = await globalThis.navigator.bluetooth.getDevices();
      infoLog('auto-connect known devices', known.map((d) => ({ id: d?.id || null, name: d?.name || null })));
    } catch (err) {
      infoLog('auto-connect known devices error', String(err?.message || err));
    }
  }
  debugLog('preferred device', preferred);
  try {
    const ok = await connectBle({
      preferredDeviceId: preferred.id,
      preferredDeviceName: preferred.name,
      allowChooserFallback,
      onDisconnect: () => {
      infoLog('gattserverdisconnected');
      void markDisconnected('gatt_disconnected');
    },
      requestOptions: {
        filters: [
          { services: ['6e400101-b5a3-f393-e0a9-e50e24dccb01'], name: 'air-kvm-ctrl-cb01' },
          { services: ['6e400101-b5a3-f393-e0a9-e50e24dccb01'], name: 'air-kvm-poc' },
          { services: ['6e400101-b5a3-f393-e0a9-e50e24dccb01'] }
        ],
        optionalServices: ['6e400101-b5a3-f393-e0a9-e50e24dccb01']
      },
      onCommand: (command) => {
        if (command?.type === '__ble_raw_bytes' && Array.isArray(command.bytes)) {
          hp.feedBytes(new Uint8Array(command.bytes));
        }
      }
    });
    if (!ok) {
      debugLog('connect unavailable in context');
      notifySw('connect_unavailable');
      setStatus('Web Bluetooth unavailable in this context');
      return;
    }
    infoLog('connect success');
    infoLog('connected device', getConnectedDeviceInfo());
    let handshakeOk = false;
    for (let attempt = 1; attempt <= kHandshakeAttempts; attempt += 1) {
      const handshakePending = waitForControlHandshake(state);
      try { await hp.send({ type: 'state.request' }, kTarget.MCP); } catch { /* ignore */ }
      const okAttempt = await handshakePending;
      if (okAttempt) {
        handshakeOk = true;
        break;
      }
      try {
        const snapshot = await readBleTxSnapshot();
        debugLog('handshake snapshot', { attempt, snapshot });
      } catch (err) {
        debugLog('handshake snapshot failed', { attempt, error: String(err?.message || err) });
      }
      infoLog('handshake attempt timed out', { attempt });
    }
    if (!handshakeOk) {
      infoLog('connect invalid stream (no JSON control response)');
      disconnectBle();
      await clearPreferredDeviceId();
      notifySw('connect_invalid_stream');
      setStatus('Invalid stream (not AirKVM control)');
      return;
    }
    const info = getConnectedDeviceInfo();
    infoLog('connected device info', info);
    await savePreferredDevice(info.id, info.name);
    notifySw('connect_success');
    setStatus('Connected');
    startHealthWatchdog();
  } catch (err) {
    const msg = String(err?.message || err);
    infoLog('connect error', msg);
    if (trigger === 'auto' && (msg === 'preferred_device_not_found' || msg === 'preferred_device_not_set')) {
      notifySw('connect_auto_no_saved_match', msg);
      setStatus('Saved device not found. Click Connect to choose.');
      return;
    }
    notifySw('connect_error', msg);
    setStatus(`Error: ${msg}`);
  } finally {
    connectInFlight = false;
    setControlsDisabled(false);
  }
}

async function disconnectAndReport(detail = null) {
  await markDisconnected(detail);
}

connectBtn?.addEventListener('click', () => {
  connectAndBind({ allowChooserFallback: true, trigger: 'manual' });
});

disconnectBtn?.addEventListener('click', () => {
  infoLog('disconnect click');
  disconnectAndReport();
});

forgetBtn?.addEventListener('click', async () => {
  infoLog('forget click');
  await clearPreferredDeviceId();
  notifySw('forget_device');
  setStatus('Saved device cleared');
});

reconnectBtn?.addEventListener('click', async () => {
  infoLog('reconnect chooser click');
  await disconnectAndReport('reconnect_start');
  await clearPreferredDeviceId();
  await connectAndBind({ allowChooserFallback: true, trigger: 'manual' });
});

clearLogBtn?.addEventListener('click', () => { clearLog(); });

toggleAutoscrollBtn?.addEventListener('click', () => {
  setAutoScrollEnabled(!isAutoScrollEnabled());
  refreshAutoscrollButton();
});

toggleVerboseBtn?.addEventListener('click', async () => {
  setVerboseLoggingEnabled(!isVerboseLoggingEnabled());
  setBleVerboseDebug(isVerboseLoggingEnabled());
  persistVerboseLoggingPref();
  refreshVerboseButton();
  infoLog('verbose logging', { enabled: isVerboseLoggingEnabled() });
  try {
    await chrome.runtime.sendMessage({ type: 'airkvm.debug.set', verbose: isVerboseLoggingEnabled() });
  } catch { /* Non-fatal. */ }
});

setVerboseLoggingEnabled(loadVerboseLoggingPref());
setBleVerboseDebug(isVerboseLoggingEnabled());
notifySw('bridge_loaded');
infoLog('bridge_loaded');
refreshAutoscrollButton();
refreshVerboseButton();


chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'desktop.capture.request' && msg.target === 'ble-page') {
    debugLog('desktop.capture.request');
    captureDesktopDataUrl({
      desktopDelayMs: Number.isInteger(msg.desktop_delay_ms) ? msg.desktop_delay_ms : null
    })
      .then((dataUrl) => sendResponse({ ok: true, dataUrl }))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true;
  }
  if (!msg || msg.target !== 'ble-page') return;
  if (msg?.type === 'hp.send' && msg.target === 'ble-page') {
    hp.send(msg.payload, kTarget.MCP)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true;
  }
});

