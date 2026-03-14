// UI layer for ble_bridge.html: log panel, status display, button helpers, screen capture,
// and verbose/autoscroll preferences. Imported by ble_bridge.js (transport layer).

const statusEl = document.getElementById('status');
export const connectBtn = document.getElementById('connect');
export const disconnectBtn = document.getElementById('disconnect');
export const forgetBtn = document.getElementById('forget');
export const reconnectBtn = document.getElementById('reconnect');
export const clearLogBtn = document.getElementById('clear-log');
export const toggleAutoscrollBtn = document.getElementById('toggle-autoscroll');
export const toggleVerboseBtn = document.getElementById('toggle-verbose');
export const logEl = document.getElementById('log');

const kDebug = true;
const kMaxLogLines = 250;
const kVerbosePrefStorageKey = 'airkvmVerboseBridgeLog';

let logLines = [];
let autoScrollEnabled = true;
let verboseLoggingEnabled = false;

export function isVerboseLoggingEnabled() { return verboseLoggingEnabled; }
export function setVerboseLoggingEnabled(v) { verboseLoggingEnabled = v; }
export function isAutoScrollEnabled() { return autoScrollEnabled; }
export function setAutoScrollEnabled(v) { autoScrollEnabled = v; }

export function loadVerboseLoggingPref() {
  try {
    return globalThis.localStorage?.getItem(kVerbosePrefStorageKey) === '1';
  } catch {
    return false;
  }
}

export function persistVerboseLoggingPref() {
  try {
    globalThis.localStorage?.setItem(kVerbosePrefStorageKey, verboseLoggingEnabled ? '1' : '0');
  } catch {
    // Non-fatal.
  }
}

export function refreshAutoscrollButton() {
  if (!toggleAutoscrollBtn) return;
  toggleAutoscrollBtn.textContent = `Auto-scroll: ${autoScrollEnabled ? 'ON' : 'OFF'}`;
  toggleAutoscrollBtn.setAttribute('aria-pressed', autoScrollEnabled ? 'true' : 'false');
}

export function refreshVerboseButton() {
  if (!toggleVerboseBtn) return;
  toggleVerboseBtn.textContent = `Verbose: ${verboseLoggingEnabled ? 'ON' : 'OFF'}`;
  toggleVerboseBtn.setAttribute('aria-pressed', verboseLoggingEnabled ? 'true' : 'false');
}

export function appendLog(line) {
  if (!logEl) return;
  const kAutoScrollThresholdPx = 16;
  const wasNearBottom =
    logEl.scrollTop + logEl.clientHeight >= (logEl.scrollHeight - kAutoScrollThresholdPx);
  logLines.push(line);
  const row = document.createElement('div');
  row.className = 'log-row';
  row.textContent = line;
  logEl.appendChild(row);

  if (logLines.length > kMaxLogLines) {
    const overflow = logLines.length - kMaxLogLines;
    logLines = logLines.slice(overflow);
    for (let i = 0; i < overflow; i += 1) {
      if (logEl.firstChild) {
        logEl.removeChild(logEl.firstChild);
      }
    }
  }
  if (autoScrollEnabled && wasNearBottom) {
    logEl.scrollTop = logEl.scrollHeight;
  }
}

export function renderLogParts(parts) {
  return parts.map((part) => {
    if (typeof part === 'string') return part;
    try {
      return JSON.stringify(part);
    } catch {
      return String(part);
    }
  }).join(' ');
}

export function appendStampedLog(prefix, parts) {
  const rendered = renderLogParts(parts);
  const line = prefix ? `${prefix} ${rendered}` : rendered;
  appendLog(`${new Date().toISOString()} ${line}`);
}

export function debugLog(...args) {
  if (!verboseLoggingEnabled) return;
  if (!kDebug) return;
  console.log('[airkvm-bridge]', ...args);
  appendStampedLog('', args);
}

export function infoLog(...args) {
  appendStampedLog('', args);
}

export function setStatus(text) {
  if (statusEl) statusEl.textContent = text;
}

export function setControlsDisabled(disabled) {
  if (connectBtn) connectBtn.disabled = disabled;
  if (reconnectBtn) reconnectBtn.disabled = disabled;
}

export function clearLog() {
  logLines = [];
  logEl?.replaceChildren();
}

export async function captureDesktopDataUrl(options = {}) {
  const delayMs = Number.isInteger(options.desktopDelayMs)
    ? Math.max(0, Math.min(5000, options.desktopDelayMs))
    : 0;
  if (!chrome.desktopCapture?.chooseDesktopMedia) {
    throw new Error('desktop_capture_unavailable');
  }

  const streamId = await new Promise((resolve, reject) => {
    chrome.desktopCapture.chooseDesktopMedia(['screen', 'window'], (id) => {
      if (!id) {
        reject(new Error('desktop_capture_denied'));
        return;
      }
      resolve(id);
    });
  });

  const stream = await getUserMediaCompat({
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: 'desktop',
        chromeMediaSourceId: streamId
      }
    }
  });

  try {
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    const [track] = stream.getVideoTracks();
    if (!track) throw new Error('desktop_capture_no_track');
    const imageCapture = new ImageCapture(track);
    const bitmap = await imageCapture.grabFrame();
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('desktop_capture_canvas_unavailable');
    ctx.drawImage(bitmap, 0, 0);
    return canvas.toDataURL('image/png');
  } finally {
    stream.getTracks().forEach((t) => t.stop());
  }
}

export function getUserMediaCompat(constraints) {
  const modern = globalThis.navigator?.mediaDevices?.getUserMedia;
  if (typeof modern === 'function') {
    return modern.call(globalThis.navigator.mediaDevices, constraints);
  }
  const legacy = globalThis.navigator?.getUserMedia
    || globalThis.navigator?.webkitGetUserMedia
    || globalThis.navigator?.mozGetUserMedia;
  if (typeof legacy !== 'function') {
    throw new Error('desktop_capture_media_unavailable');
  }
  return new Promise((resolve, reject) => {
    legacy.call(globalThis.navigator, constraints, resolve, reject);
  });
}
