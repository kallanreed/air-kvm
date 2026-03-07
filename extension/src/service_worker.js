const MCP_ENDPOINT = 'http://127.0.0.1:8787/extension-event';

async function postEvent(payload) {
  try {
    await fetch(MCP_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    });
  } catch {
    // Local agent bridge may not be running.
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return;

  postEvent({ ...msg, tabId: sender?.tab?.id ?? null });
  sendResponse({ ok: true });
});

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;
  try {
    const summary = await chrome.tabs.sendMessage(tab.id, { type: 'request.dom.summary' });
    await postEvent({ ...summary, tabId: tab.id });
  } catch {
    // No content script or unavailable tab context.
  }
});
