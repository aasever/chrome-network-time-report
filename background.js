'use strict';

const MAX_REQUESTS = 2000;
const pending = new Map();

// Requests stored in memory; flushed to storage on each completion
let requests = [];
let isRecording = true;
let captureHeaders = false;

async function loadFromStorage() {
  const data = await chrome.storage.local.get([
    'requests',
    'isRecording',
    'captureHeaders',
  ]);
  requests = data.requests || [];
  isRecording = data.isRecording !== false;
  captureHeaders = data.captureHeaders === true;
}

async function saveToStorage() {
  await chrome.storage.local.set({ requests });
}

loadFromStorage();

function redactHeaders(headers) {
  if (!headers || !Array.isArray(headers)) return [];
  const blocked = new Set(['authorization', 'cookie', 'set-cookie']);
  return headers
    .filter((h) => h && typeof h.name === 'string')
    .map((h) => {
      const name = String(h.name);
      const lname = name.toLowerCase();
      if (blocked.has(lname)) return { name, value: '' };
      return { name, value: h.value === undefined ? '' : String(h.value) };
    });
}

// ── webRequest listeners ────────────────────────────────────────────────────

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (!isRecording) return;
    let bodyBytes = 0;
    if (details.requestBody) {
      if (details.requestBody.raw) {
        bodyBytes = details.requestBody.raw.reduce(
          (sum, chunk) => sum + (chunk.bytes ? chunk.bytes.byteLength : 0), 0
        );
      } else if (details.requestBody.formData) {
        bodyBytes = JSON.stringify(details.requestBody.formData).length;
      }
    }
    pending.set(details.requestId, {
      startTime: details.timeStamp,
      bodyBytes,
      tabId: details.tabId,
    });
  },
  { urls: ['<all_urls>'] },
  ['requestBody']
);

chrome.webRequest.onSendHeaders.addListener(
  (details) => {
    const entry = pending.get(details.requestId);
    if (!entry) return;
    const headerBytes = details.requestHeaders
      ? details.requestHeaders.reduce(
          (sum, h) => sum + h.name.length + (h.value ? h.value.length : 0) + 4,
          0
        )
      : 0;
    entry.requestSize = headerBytes + entry.bodyBytes;
    entry.method = details.method;
  },
  { urls: ['<all_urls>'] },
  ['requestHeaders']
);

chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    if (!isRecording || !captureHeaders) return;
    const entry = pending.get(details.requestId);
    if (!entry) return;
    entry.requestHeaders = redactHeaders(details.requestHeaders);
  },
  { urls: ['<all_urls>'] },
  ['requestHeaders', 'extraHeaders']
);

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    const entry = pending.get(details.requestId);
    if (!entry) return;
    entry.statusCode = details.statusCode;
    if (details.responseHeaders) {
      const cl = details.responseHeaders.find(
        (h) => h.name.toLowerCase() === 'content-length'
      );
      if (cl) entry.responseSize = parseInt(cl.value, 10) || 0;

      const ct = details.responseHeaders.find(
        (h) => h.name.toLowerCase() === 'content-type'
      );
      if (ct) entry.contentType = ct.value.split(';')[0].trim();

      if (captureHeaders) {
        entry.responseHeaders = redactHeaders(details.responseHeaders);
      }
    }
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders', 'extraHeaders']
);

chrome.webRequest.onCompleted.addListener(
  async (details) => {
    const entry = pending.get(details.requestId);
    if (!entry) return;
    pending.delete(details.requestId);

    let url;
    try { url = new URL(details.url); } catch { return; }

    const record = {
      id: details.requestId + '_' + Date.now(),
      timestamp: entry.startTime,
      method: entry.method || details.method || 'GET',
      hostname: url.hostname,
      uri: url.pathname + url.search,
      statusCode: entry.statusCode || details.statusCode,
      responseTime: Math.max(0, (details.timeStamp - entry.startTime) / 1000),
      requestSize: entry.requestSize || 0,
      responseSize: entry.responseSize !== undefined ? entry.responseSize : -1,
      contentType: entry.contentType || '',
      tabId: details.tabId,
      requestHeaders: entry.requestHeaders || [],
      responseHeaders: entry.responseHeaders || [],
    };

    requests.push(record);
    if (requests.length > MAX_REQUESTS) {
      requests = requests.slice(requests.length - MAX_REQUESTS);
    }
    await saveToStorage();
  },
  { urls: ['<all_urls>'] }
);

chrome.webRequest.onErrorOccurred.addListener(
  (details) => { pending.delete(details.requestId); },
  { urls: ['<all_urls>'] }
);

// ── Message handler ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    switch (msg.type) {
      case 'GET_REQUESTS':
        sendResponse({ requests, isRecording, captureHeaders });
        break;
      case 'CLEAR_REQUESTS': {
        if (msg.tabId !== undefined && msg.tabId !== null) {
          requests = requests.filter((r) => r.tabId !== msg.tabId);
        } else {
          requests = [];
        }
        await saveToStorage();
        sendResponse({ ok: true });
        break;
      }
      case 'SET_RECORDING':
        isRecording = msg.value;
        await chrome.storage.local.set({ isRecording });
        sendResponse({ ok: true });
        break;
      case 'SET_CAPTURE_HEADERS':
        captureHeaders = msg.value === true;
        await chrome.storage.local.set({ captureHeaders });
        sendResponse({ ok: true, captureHeaders });
        break;
      default:
        sendResponse({ error: 'unknown message' });
    }
  })();
  return true; // keep channel open for async response
});
