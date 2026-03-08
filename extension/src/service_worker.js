import { dataUrlToMetaAndChunks, resolveScreenshotConfig } from './screenshot_protocol.js';
const kBleBridgePagePath = 'src/ble_bridge.html';
const kDebug = true;
const kScreenshotCaptureTimeoutMs = 25000;
const kScreenshotStageTimeoutMs = 10000;
const kTransferTtlMs = 2 * 60 * 1000;
const kSwHeartbeatIntervalMs = 5000;
const kSwBreadcrumbStorageKey = 'airkvm_sw_breadcrumb';
let lastAutomationTabId = null;
let bridgeTraceSeq = 0;
let screenshotInFlight = false;
const screenshotTransfers = new Map();
const kSwInstanceId = `sw_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;

function debugLog(...args) {
  if (!kDebug) return;
  console.log('[airkvm-sw]', `[${kSwInstanceId}]`, ...args);
}

function activeTransferIds() {
  return Array.from(screenshotTransfers.keys());
}

async function writeSwBreadcrumb(event, detail = null) {
  if (!chrome?.storage?.session?.set) return;
  try {
    await chrome.storage.session.set({
      [kSwBreadcrumbStorageKey]: {
        instance_id: kSwInstanceId,
        ts: Date.now(),
        event,
        detail,
        active_transfer_ids: activeTransferIds()
      }
    });
  } catch {
    // Non-fatal diagnostics.
  }
}

async function readSwBreadcrumb() {
  if (!chrome?.storage?.session?.get) return null;
  try {
    const got = await chrome.storage.session.get(kSwBreadcrumbStorageKey);
    return got?.[kSwBreadcrumbStorageKey] || null;
  } catch {
    return null;
  }
}

function emitSwAliveHeartbeat() {
  chrome.runtime.sendMessage({
    type: 'ble.sw.alive',
    target: 'ble-page',
    instance_id: kSwInstanceId,
    ts: Date.now(),
    active_transfer_ids: activeTransferIds()
  }).catch(() => {});
}

function setBadge(text, color) {
  if (!chrome?.action?.setBadgeText || !chrome?.action?.setBadgeBackgroundColor) return;
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
}

function clearBadgeLater(ms = 5000) {
  setTimeout(() => {
    if (!chrome?.action?.setBadgeText) return;
    chrome.action.setBadgeText({ text: '' });
  }, ms);
}

async function ensureBleBridgePage() {
  if (!chrome?.tabs?.query || !chrome?.tabs?.create) return false;
  const url = chrome.runtime.getURL(kBleBridgePagePath);
  const existing = await chrome.tabs.query({ url });
  if (existing.length > 0) {
    debugLog('bridge page already open', { count: existing.length });
    return true;
  }
  debugLog('opening bridge page');
  await chrome.tabs.create({ url, active: true });
  return true;
}

function isAutomationCandidateTab(tab) {
  if (!tab?.id) return false;
  const url = String(tab.url || '');
  if (!url) return true;
  if (url.startsWith('edge://') || url.startsWith('chrome://') || url.startsWith('devtools://')) return false;
  if (
    url.startsWith('chrome-extension://') ||
    url.startsWith('edge-extension://') ||
    url.startsWith('extension://')
  ) {
    return false;
  }
  return true;
}

async function resolveTargetTab(preferredTabId = null) {
  if (Number.isInteger(preferredTabId)) {
    try {
      const tab = await chrome.tabs.get(preferredTabId);
      if (isAutomationCandidateTab(tab)) return tab;
    } catch {
      // fall through
    }
  }

  if (Number.isInteger(lastAutomationTabId)) {
    try {
      const tab = await chrome.tabs.get(lastAutomationTabId);
      if (isAutomationCandidateTab(tab)) return tab;
    } catch {
      // fall through
    }
  }

  const candidates = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const active = candidates.find((tab) => isAutomationCandidateTab(tab));
  if (active) {
    lastAutomationTabId = active.id;
    return active;
  }

  const all = await chrome.tabs.query({ lastFocusedWindow: true });
  const fallback = all.find((tab) => isAutomationCandidateTab(tab));
  if (fallback) {
    lastAutomationTabId = fallback.id;
    return fallback;
  }
  return null;
}

async function postEventViaBridge(payload) {
  bridgeTraceSeq += 1;
  const traceId = `sw-${Date.now()}-${bridgeTraceSeq}`;
  debugLog('postEventViaBridge tx', {
    traceId,
    type: payload?.type,
    keys: Object.keys(payload || {}),
    bytes: JSON.stringify(payload || {}).length
  });
  try {
    const res = await chrome.runtime.sendMessage({
      type: 'ble.post',
      target: 'ble-page',
      payload,
      traceId
    });
    debugLog('postEventViaBridge rx', { traceId, res });
    return Boolean(res?.ok);
  } catch {
    debugLog('postEventViaBridge failed', { traceId });
    return false;
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return;
  if (msg.type === 'ble.bridge.status') {
    debugLog('bridge status', { status: msg.status, detail: msg.detail ?? null, tabId: sender?.tab?.id ?? null });
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type.startsWith('ble.')) {
    // Internal bridge control messages are handled by dedicated listeners below.
    return;
  }
  if (msg.target === 'ble-page') return;
  if (msg.type !== 'busy.changed' && msg.type !== 'dom.summary') {
    debugLog('ignoring non-bridge content message', { type: msg.type });
    return;
  }
  debugLog('runtime message from content', { type: msg.type, tabId: sender?.tab?.id ?? null });
  if (Number.isInteger(sender?.tab?.id)) {
    lastAutomationTabId = sender.tab.id;
  }

  postEventViaBridge({ ...msg, tabId: sender?.tab?.id ?? null })
    .then((ok) => sendResponse({ ok }))
    .catch(() => sendResponse({ ok: false }));
  return true;
});

function makeRequestId() {
  return `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
}

function makeTransferId() {
  return `tx_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
}

function pruneScreenshotTransfers(nowTs = Date.now()) {
  for (const [transferId, session] of screenshotTransfers.entries()) {
    if (!session || nowTs - (session.updatedAt || 0) > kTransferTtlMs) {
      screenshotTransfers.delete(transferId);
    }
  }
}

function withTimeout(promise, ms, errorCode) {
  let timeoutId = null;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(errorCode)), ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeoutId !== null) clearTimeout(timeoutId);
  });
}

async function captureTabPng(config) {
  const tab = await resolveTargetTab(config.tabId || null);
  if (!tab?.id) {
    throw new Error('active_tab_not_found');
  }
  if (!tab.active && chrome.tabs?.update) {
    await chrome.tabs.update(tab.id, { active: true });
  }
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  return compressDataUrlToJpeg(dataUrl, config);
}

async function captureDesktopPng(config) {
  const response = await chrome.runtime.sendMessage({
    type: 'desktop.capture.request',
    target: 'ble-page'
  });
  if (!response?.ok || typeof response.dataUrl !== 'string') {
    throw new Error(response?.error || 'desktop_capture_failed');
  }
  return compressDataUrlToJpeg(response.dataUrl, config);
}

function fitWithin(width, height, maxWidth, maxHeight) {
  if (width <= 0 || height <= 0) {
    return { width: 1, height: 1 };
  }
  const scale = Math.min(1, maxWidth / width, maxHeight / height);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale))
  };
}

async function blobToDataUrl(blob) {
  const ab = await blob.arrayBuffer();
  const bytes = new Uint8Array(ab);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return `data:${blob.type || 'application/octet-stream'};base64,${btoa(binary)}`;
}

async function encodeBitmapToJpegDataUrl(bitmap, config) {
  let size = fitWithin(bitmap.width, bitmap.height, config.maxWidth, config.maxHeight);
  let quality = config.jpegQuality;
  let bestBlob = null;
  let bestEstimatedBase64Chars = Number.POSITIVE_INFINITY;
  let attempts = 0;

  for (let attempt = 0; attempt < config.maxAttempts; attempt += 1) {
    attempts = attempt + 1;
    const canvas = new OffscreenCanvas(size.width, size.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas_2d_unavailable');
    ctx.drawImage(bitmap, 0, 0, size.width, size.height);
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
    bestBlob = blob;

    const estimatedBase64Chars = Math.ceil((blob.size * 4) / 3);
    bestEstimatedBase64Chars = estimatedBase64Chars;
    if (estimatedBase64Chars <= config.maxBase64Chars) {
      break;
    }

    const nextWidth = Math.max(1, Math.round(size.width * config.downscaleFactor));
    const nextHeight = Math.max(1, Math.round(size.height * config.downscaleFactor));
    size = { width: nextWidth, height: nextHeight };
    quality = Math.max(config.minJpegQuality, quality - 0.1);
  }

  if (!bestBlob) {
    throw new Error('screenshot_encode_failed');
  }
  if (bestEstimatedBase64Chars > config.maxBase64Chars) {
    throw new Error('screenshot_too_large');
  }
  const dataUrl = await blobToDataUrl(bestBlob);
  return {
    dataUrl,
    encodedWidth: size.width,
    encodedHeight: size.height,
    encodedQuality: quality,
    estimatedBase64Chars: bestEstimatedBase64Chars,
    attempts
  };
}

async function compressDataUrlToJpeg(dataUrl, config) {
  const response = await withTimeout(fetch(dataUrl), kScreenshotStageTimeoutMs, 'screenshot_fetch_timeout');
  const blob = await withTimeout(response.blob(), kScreenshotStageTimeoutMs, 'screenshot_blob_timeout');
  const bitmap = await withTimeout(createImageBitmap(blob), kScreenshotStageTimeoutMs, 'screenshot_bitmap_timeout');
  return withTimeout(
    encodeBitmapToJpegDataUrl(bitmap, config),
    kScreenshotStageTimeoutMs,
    'screenshot_encode_timeout'
  );
}

async function sendDomSnapshot(command) {
  debugLog('sendDomSnapshot start', command);
  const requestId = command.request_id || makeRequestId();
  const tab = await resolveTargetTab(command.tab_id || null);
  if (!tab?.id) throw new Error('active_tab_not_found');
  let summary = null;
  try {
    summary = await chrome.tabs.sendMessage(tab.id, { type: 'request.dom.summary' });
  } catch (err) {
    debugLog('sendDomSnapshot tab message failed', String(err?.message || err));
  }
  const title = summary?.title || tab.title || '';
  const normalizedSummary = summary && typeof summary === 'object'
    ? { ...summary, title: summary.title || title }
    : { type: 'dom.summary', ts: Date.now(), url: tab.url || '', title, focus: { tag: null, id: null }, actionable: [] };
  debugLog('sendDomSnapshot got summary', { tabId: tab.id, title: normalizedSummary?.title ?? null });
  await postEventViaBridge({
    type: 'dom.snapshot',
    request_id: requestId,
    tabId: tab.id,
    ts: Date.now(),
    summary: normalizedSummary
  });
}

async function sendScreenshot(command) {
  if (screenshotInFlight) {
    throw new Error('screenshot_busy');
  }
  screenshotInFlight = true;
  debugLog('sendScreenshot start', command);
  try {
    const source = command.source === 'desktop' ? 'desktop' : 'tab';
    const requestId = command.request_id || makeRequestId();
    const config = resolveScreenshotConfig(command);
    config.tabId = Number.isInteger(command?.tab_id) ? command.tab_id : null;
    debugLog('sendScreenshot capture begin', {
      source,
      requestId,
      tabId: config.tabId || null,
      encodingRequested: config.encoding
    });
    const encoded = await withTimeout(
      source === 'desktop' ? captureDesktopPng(config) : captureTabPng(config),
      kScreenshotCaptureTimeoutMs,
      'screenshot_capture_timeout'
    );
    debugLog('sendScreenshot capture done', {
      source,
      requestId,
      encodedWidth: encoded.encodedWidth,
      encodedHeight: encoded.encodedHeight,
      encodedQuality: encoded.encodedQuality
    });
    const compression = config.encoding === 'b64z'
      ? await tryGzipDataUrlBase64(encoded.dataUrl)
      : { encoding: 'b64', payloadBase64: null };
    debugLog('sendScreenshot compression', {
      source,
      requestId,
      requested: config.encoding,
      selected: compression.encoding
    });
    const { meta, chunks } = dataUrlToMetaAndChunks(
      encoded.dataUrl,
      requestId,
      source,
      encoded,
      120,
      compression.encoding,
      compression.payloadBase64
    );
    debugLog('sendScreenshot encoded', {
      source,
      requestId,
      encoding: compression.encoding,
      chunks: chunks.length,
      totalChars: meta.tch
    });
    pruneScreenshotTransfers();
    const transferId = makeTransferId();
    const session = {
      transferId,
      requestId,
      source,
      meta,
      chunks,
      updatedAt: Date.now(),
      highestAckSeq: -1
    };
    screenshotTransfers.set(transferId, session);
    debugLog('transfer session created', {
      requestId,
      transferId,
      totalChunks: chunks.length
    });
    void writeSwBreadcrumb('transfer_created', {
      request_id: requestId,
      transfer_id: transferId,
      total_chunks: chunks.length
    });

    await postEventViaBridge({
      type: 'transfer.meta',
      request_id: requestId,
      transfer_id: transferId,
      source,
      mime: meta.m,
      encoding: meta.e,
      chunk_size: meta.cs,
      total_chunks: meta.tc,
      total_chars: meta.tch,
      encoded_width: meta.ew,
      encoded_height: meta.eh,
      encoded_quality: meta.eq,
      encode_attempts: meta.ea
    });
    for (const chunk of chunks) {
      await postEventViaBridge({
        type: 'transfer.chunk',
        request_id: requestId,
        transfer_id: transferId,
        source,
        seq: chunk.q,
        data: chunk.d
      });
    }
    await postEventViaBridge({
      type: 'transfer.done',
      request_id: requestId,
      transfer_id: transferId,
      source,
      total_chunks: chunks.length
    });
  } finally {
    screenshotInFlight = false;
  }
}

async function sendTransferError(command, code, detail = null) {
  await postEventViaBridge({
    type: 'transfer.error',
    request_id: command?.request_id || null,
    transfer_id: command?.transfer_id || null,
    source: command?.source || null,
    code,
    detail,
    ts: Date.now()
  });
}

async function handleTransferResume(command) {
  pruneScreenshotTransfers();
  const transferId = command?.transfer_id;
  const session = transferId ? screenshotTransfers.get(transferId) : null;
  if (!session) {
    const breadcrumb = await readSwBreadcrumb();
    const detail = {
      instance_id: kSwInstanceId,
      active_transfer_ids: activeTransferIds(),
      last_breadcrumb: breadcrumb
    };
    debugLog('transfer resume missing session', {
      requestId: command?.request_id || null,
      transferId: transferId || null,
      detail
    });
    await sendTransferError(command, 'no_such_transfer', detail);
    return;
  }
  if (command?.request_id && session.requestId !== command.request_id) {
    await sendTransferError(command, 'request_id_mismatch');
    return;
  }
  const fromSeq = Number.isInteger(command?.from_seq)
    ? Math.max(0, command.from_seq)
    : Math.max(0, session.highestAckSeq + 1);
  session.updatedAt = Date.now();
  debugLog('transfer resume start', {
    requestId: session.requestId,
    transferId: session.transferId,
    fromSeq,
    totalChunks: session.chunks.length
  });
  void writeSwBreadcrumb('transfer_resume', {
    request_id: session.requestId,
    transfer_id: session.transferId,
    from_seq: fromSeq
  });
  for (let seq = fromSeq; seq < session.chunks.length; seq += 1) {
    const chunk = session.chunks[seq];
    await postEventViaBridge({
      type: 'transfer.chunk',
      request_id: session.requestId,
      transfer_id: session.transferId,
      source: session.source,
      seq: chunk.q,
      data: chunk.d
    });
  }
  await postEventViaBridge({
    type: 'transfer.done',
    request_id: session.requestId,
    transfer_id: session.transferId,
    source: session.source,
    total_chunks: session.chunks.length
  });
}

async function handleTransferAck(command) {
  pruneScreenshotTransfers();
  const transferId = command?.transfer_id;
  const session = transferId ? screenshotTransfers.get(transferId) : null;
  if (!session) {
    await sendTransferError(command, 'no_such_transfer');
    return;
  }
  if (Number.isInteger(command?.highest_contiguous_seq)) {
    session.highestAckSeq = Math.max(session.highestAckSeq, command.highest_contiguous_seq);
  }
  session.updatedAt = Date.now();
  void writeSwBreadcrumb('transfer_ack', {
    request_id: session.requestId,
    transfer_id: session.transferId,
    highest_contiguous_seq: session.highestAckSeq
  });
}

async function handleTransferCancel(command) {
  const transferId = command?.transfer_id;
  if (!transferId || !screenshotTransfers.has(transferId)) {
    await sendTransferError(command, 'no_such_transfer');
    return;
  }
  screenshotTransfers.delete(transferId);
  void writeSwBreadcrumb('transfer_cancel', { transfer_id: transferId });
  await postEventViaBridge({
    type: 'transfer.cancel.ok',
    request_id: command?.request_id || null,
    transfer_id: transferId,
    ts: Date.now()
  });
}

async function handleTransferReset(command) {
  screenshotTransfers.clear();
  void writeSwBreadcrumb('transfer_reset', {
    request_id: command?.request_id || null
  });
  await postEventViaBridge({
    type: 'transfer.reset.ok',
    request_id: command?.request_id || null,
    ts: Date.now()
  });
}

async function tryGzipDataUrlBase64(dataUrl) {
  const comma = dataUrl.indexOf(',');
  if (comma === -1) throw new Error('screenshot_invalid_data_url');
  const base64 = dataUrl.slice(comma + 1);
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  if (typeof CompressionStream !== 'function') {
    return { encoding: 'b64', payloadBase64: null };
  }
  try {
    const zippedBase64 = await Promise.race([
      gzipBytesToBase64(bytes),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error('compression_timeout')), 3000);
      })
    ]);
    if (typeof zippedBase64 !== 'string' || zippedBase64.length >= base64.length) {
      // Do not claim compressed mode when compression failed or did not reduce payload size.
      return { encoding: 'b64', payloadBase64: null };
    }
    return { encoding: 'b64z', payloadBase64: zippedBase64 };
  } catch {
    // Compression path is optional; always preserve screenshot flow via b64 fallback.
    return { encoding: 'b64', payloadBase64: null };
  }
}

async function gzipBytesToBase64(bytes) {
  const cs = new CompressionStream('gzip');
  const writer = cs.writable.getWriter();
  await writer.write(bytes);
  await writer.close();
  const compressed = await new Response(cs.readable).arrayBuffer();
  const zipped = new Uint8Array(compressed);
  let binary = '';
  for (let i = 0; i < zipped.length; i += 1) {
    binary += String.fromCharCode(zipped[i]);
  }
  return btoa(binary);
}

async function sendTabsList(command) {
  const requestId = command.request_id || makeRequestId();
  const tabs = await chrome.tabs.query({ lastFocusedWindow: true });
  const filtered = tabs
    .filter((tab) => isAutomationCandidateTab(tab))
    .map((tab) => ({
      id: tab.id,
      window_id: tab.windowId,
      active: Boolean(tab.active),
      title: tab.title || '',
      url: tab.url || ''
    }));
  await postEventViaBridge({
    type: 'tabs.list',
    request_id: requestId,
    tabs: filtered,
    ts: Date.now()
  });
}

async function handleBleCommand(command) {
  debugLog('handleBleCommand', command);
  if (!command || typeof command.type !== 'string') {
    debugLog('handleBleCommand ignore non-command payload', command);
    return;
  }
  if (command.type === 'dom.snapshot.request') {
    try {
      await sendDomSnapshot(command);
    } catch (err) {
      debugLog('sendDomSnapshot error', String(err?.message || err));
      await postEventViaBridge({
        type: 'dom.snapshot.error',
        request_id: command.request_id || null,
        error: String(err?.message || err),
        ts: Date.now()
      });
    }
    return;
  }
  if (command.type === 'screenshot.request') {
    try {
      await sendScreenshot(command);
    } catch (err) {
      debugLog('sendScreenshot error', String(err?.message || err));
      await postEventViaBridge({
        type: 'screenshot.error',
        request_id: command.request_id || null,
        source: command.source || 'tab',
        error: String(err?.message || err),
        ts: Date.now()
      });
    }
  }
  if (command.type === 'tabs.list.request') {
    try {
      await sendTabsList(command);
    } catch (err) {
      debugLog('sendTabsList error', String(err?.message || err));
      await postEventViaBridge({
        type: 'tabs.list.error',
        request_id: command.request_id || null,
        error: String(err?.message || err),
        ts: Date.now()
      });
    }
  }
  if (command.type === 'transfer.resume') {
    try {
      await handleTransferResume(command);
    } catch (err) {
      debugLog('handleTransferResume error', String(err?.message || err));
      await sendTransferError(command, 'transfer_resume_failed', String(err?.message || err));
    }
    return;
  }
  if (command.type === 'transfer.ack' || command.type === 'transfer.done.ack') {
    try {
      await handleTransferAck(command);
    } catch (err) {
      debugLog('handleTransferAck error', String(err?.message || err));
      await sendTransferError(command, 'transfer_ack_failed', String(err?.message || err));
    }
    return;
  }
  if (command.type === 'transfer.cancel') {
    try {
      await handleTransferCancel(command);
    } catch (err) {
      debugLog('handleTransferCancel error', String(err?.message || err));
      await sendTransferError(command, 'transfer_cancel_failed', String(err?.message || err));
    }
    return;
  }
  if (command.type === 'transfer.reset') {
    try {
      await handleTransferReset(command);
    } catch (err) {
      debugLog('handleTransferReset error', String(err?.message || err));
      await sendTransferError(command, 'transfer_reset_failed', String(err?.message || err));
    }
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== 'ble.command') return;
  debugLog('runtime ble.command', msg.command);
  handleBleCommand(msg.command)
    .then(() => sendResponse({ ok: true }))
    .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
  return true;
});

chrome.runtime.onInstalled?.addListener((details) => {
  debugLog('lifecycle onInstalled', details || null);
  void writeSwBreadcrumb('lifecycle_onInstalled', details || null);
});

chrome.runtime.onStartup?.addListener(() => {
  debugLog('lifecycle onStartup');
  void writeSwBreadcrumb('lifecycle_onStartup');
});

if (typeof self?.addEventListener === 'function') {
  self.addEventListener('activate', () => {
    debugLog('lifecycle activate');
    void writeSwBreadcrumb('lifecycle_activate');
  });
}

if (chrome.runtime?.onSuspend?.addListener) {
  chrome.runtime.onSuspend.addListener(() => {
    debugLog('lifecycle onSuspend');
    void writeSwBreadcrumb('lifecycle_onSuspend');
  });
}

if (chrome.runtime?.onSuspendCanceled?.addListener) {
  chrome.runtime.onSuspendCanceled.addListener(() => {
    debugLog('lifecycle onSuspendCanceled');
    void writeSwBreadcrumb('lifecycle_onSuspendCanceled');
  });
}

debugLog('boot', { instance_id: kSwInstanceId });
void writeSwBreadcrumb('boot', { instance_id: kSwInstanceId });
setInterval(() => {
  emitSwAliveHeartbeat();
}, kSwHeartbeatIntervalMs);

chrome.action.onClicked.addListener(async (tab) => {
  debugLog('action clicked', { tabId: tab?.id ?? null });
  if (isAutomationCandidateTab(tab)) {
    lastAutomationTabId = tab.id;
  }
  setBadge('...', '#5B6CFF');
  try {
    await ensureBleBridgePage();
    setBadge('TAB', '#9E9E9E');
    if (!tab.id) {
      clearBadgeLater();
      return;
    }
    const summary = await chrome.tabs.sendMessage(tab.id, { type: 'request.dom.summary' });
    await postEventViaBridge({ ...summary, tabId: tab.id });
    clearBadgeLater();
  } catch {
    setBadge('ERR', '#D93025');
    clearBadgeLater();
  }
});
