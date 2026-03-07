import { connectBle, postEvent } from './bridge.js';

const statusEl = document.getElementById('status');
const connectBtn = document.getElementById('connect');

function setStatus(text) {
  if (statusEl) statusEl.textContent = text;
}

async function connectAndBind() {
  setStatus('Connecting...');
  try {
    const ok = await connectBle({
      onCommand: async (command) => {
        try {
          await chrome.runtime.sendMessage({ type: 'ble.command', command });
        } catch {
          // Background may be unavailable transiently.
        }
      }
    });
    if (!ok) {
      setStatus('Web Bluetooth unavailable in this context');
      return;
    }
    setStatus('Connected');
  } catch (err) {
    setStatus(`Error: ${String(err?.message || err)}`);
  }
}

connectBtn?.addEventListener('click', () => {
  connectAndBind();
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== 'ble.post' || msg.target !== 'ble-page') return;
  postEvent(msg.payload)
    .then((ok) => sendResponse({ ok }))
    .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
  return true;
});

