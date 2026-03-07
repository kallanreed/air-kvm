import { connectBle, postEvent } from './bridge.js';

const statusEl = document.getElementById('status');
const connectBtn = document.getElementById('connect');
const kDebug = true;

function debugLog(...args) {
  if (!kDebug) return;
  console.log('[airkvm-bridge]', ...args);
}

function setStatus(text) {
  if (statusEl) statusEl.textContent = text;
}

async function connectAndBind() {
  debugLog('connect click');
  setStatus('Connecting...');
  try {
    const ok = await connectBle({
      onCommand: async (command) => {
        debugLog('rx command from BLE', command);
        try {
          await chrome.runtime.sendMessage({ type: 'ble.command', command });
          debugLog('forwarded ble.command to service worker');
        } catch {
          debugLog('failed to forward ble.command');
          // Background may be unavailable transiently.
        }
      }
    });
    if (!ok) {
      debugLog('connect unavailable in context');
      setStatus('Web Bluetooth unavailable in this context');
      return;
    }
    debugLog('connect success');
    setStatus('Connected');
  } catch (err) {
    debugLog('connect error', String(err?.message || err));
    setStatus(`Error: ${String(err?.message || err)}`);
  }
}

connectBtn?.addEventListener('click', () => {
  connectAndBind();
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== 'ble.post' || msg.target !== 'ble-page') return;
  debugLog('ble.post from service worker', { type: msg?.payload?.type });
  postEvent(msg.payload)
    .then((ok) => {
      debugLog('ble.post result', { ok });
      sendResponse({ ok });
    })
    .catch((err) => {
      const error = String(err?.message || err);
      debugLog('ble.post error', error);
      sendResponse({ ok: false, error });
    });
  return true;
});
