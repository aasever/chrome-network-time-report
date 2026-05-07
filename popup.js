'use strict';

// ── Filter language ─────────────────────────────────────────────────────────

class FilterParser {
  constructor(input) {
    this._tokens = this._tokenize(input.trim());
    this._pos = 0;
  }

  _tokenize(input) {
    // Match AND/OR/NOT keywords, parentheses, quoted strings, or barewords (including field:value)
    const re = /\bAND\b|\bOR\b|\bNOT\b|\band\b|\bor\b|\bnot\b|[()]|"[^"]*"|'[^']*'|[^\s()]+/g;
    const tokens = [];
    let m;
    while ((m = re.exec(input)) !== null) tokens.push(m[0]);
    return tokens;
  }

  _peek() { return this._tokens[this._pos]; }
  _consume() { return this._tokens[this._pos++]; }

  parse() {
    if (this._tokens.length === 0) return null;
    const node = this._parseOr();
    return node;
  }

  _parseOr() {
    let left = this._parseAnd();
    while (this._peek()?.toUpperCase() === 'OR') {
      this._consume();
      left = { type: 'OR', left, right: this._parseAnd() };
    }
    return left;
  }

  _parseAnd() {
    let left = this._parseNot();
    while (this._peek()?.toUpperCase() === 'AND') {
      this._consume();
      left = { type: 'AND', left, right: this._parseNot() };
    }
    return left;
  }

  _parseNot() {
    if (this._peek()?.toUpperCase() === 'NOT') {
      this._consume();
      return { type: 'NOT', operand: this._parseNot() };
    }
    return this._parsePrimary();
  }

  _parsePrimary() {
    const tok = this._peek();
    if (!tok) return null;

    if (tok === '(') {
      this._consume();
      const expr = this._parseOr();
      if (this._peek() === ')') this._consume();
      return expr;
    }

    this._consume();
    const unquoted = tok.replace(/^["']|["']$/g, '');
    const colon = unquoted.indexOf(':');
    if (colon > 0 && colon < unquoted.length - 1) {
      return { type: 'FIELD', field: unquoted.slice(0, colon).toLowerCase(), value: unquoted.slice(colon + 1) };
    }
    return { type: 'TEXT', value: unquoted };
  }
}

function evalFilter(node, req) {
  if (!node) return true;
  switch (node.type) {
    case 'OR':  return evalFilter(node.left, req) || evalFilter(node.right, req);
    case 'AND': return evalFilter(node.left, req) && evalFilter(node.right, req);
    case 'NOT': return !evalFilter(node.operand, req);
    case 'FIELD': {
      const v = node.value.toLowerCase();
      switch (node.field) {
        case 'host':
        case 'hostname': return req.hostname.toLowerCase().includes(v);
        case 'uri':
        case 'path':
        case 'url':      return req.uri.toLowerCase().includes(v);
        case 'status':   return String(req.statusCode).startsWith(v);
        case 'method':   return req.method.toLowerCase() === v.toLowerCase();
        default:         return false;
      }
    }
    case 'TEXT': {
      const v = node.value.toLowerCase();
      return req.hostname.toLowerCase().includes(v)
          || req.uri.toLowerCase().includes(v)
          || String(req.statusCode).includes(v)
          || req.method.toLowerCase().includes(v);
    }
    default: return true;
  }
}

function applyFilter(requests, expression) {
  if (!expression || !expression.trim()) return requests;
  let ast;
  try {
    ast = new FilterParser(expression).parse();
  } catch {
    return requests; // parse error → show all
  }
  if (!ast) return requests;
  return requests.filter((r) => evalFilter(ast, r));
}

// ── Formatting ──────────────────────────────────────────────────────────────

function fmtSize(bytes) {
  if (bytes === undefined || bytes === null || bytes < 0) return 'N/A';
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log2(bytes) / 10), units.length - 1);
  const val = bytes / Math.pow(1024, i);
  return `${i === 0 ? val : val.toFixed(2)} ${units[i]}`;
}

function fmtTime(s) {
  if (s === undefined || s === null) return '—';
  return s.toFixed(3) + 's';
}

function fmtTimeCumul(s) {
  if (s >= 60) return (s / 60).toFixed(2) + 'm';
  return s.toFixed(3) + 's';
}

function statusClass(code) {
  if (code >= 200 && code < 300) return 'status-2xx';
  if (code >= 300 && code < 400) return 'status-3xx';
  if (code >= 400 && code < 500) return 'status-4xx';
  if (code >= 500) return 'status-5xx';
  return '';
}

function timeClass(s) {
  if (s < 0.5) return 'time-fast';
  if (s < 2.0) return 'time-medium';
  return 'time-slow';
}

function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Viewer tab (action popup = active tab; full-tab page can pin via ?forTab=) ─

const _urlParams = new URLSearchParams(window.location.search);
const _forTabParam = _urlParams.get('forTab');
let viewerTabIdPinned = null;
if (_forTabParam != null && _forTabParam !== '') {
  const n = Number(_forTabParam);
  if (Number.isInteger(n) && n >= 0) viewerTabIdPinned = n;
}
if (viewerTabIdPinned !== null) {
  document.documentElement.classList.add('fullscreen-tab');
}
let lastViewerTabId;

// ── State ───────────────────────────────────────────────────────────────────

let allRequests = [];
let filteredRequests = [];
let isRecording = true;
let captureHeaders = false;
let sortCol = 'responseTime';
let sortDir = 'desc';
let activeTab = 'requests';
let expandedRequestId = null;

// ── DOM refs ─────────────────────────────────────────────────────────────────

const btnRecord     = document.getElementById('btnRecord');
const btnClear      = document.getElementById('btnClear');
const btnExport     = document.getElementById('btnExport');
const btnTab        = document.getElementById('btnTab');
const captureHeadersToggle = document.getElementById('captureHeadersToggle');
const filterInput   = document.getElementById('filterInput');
const filterClearBtn= document.getElementById('filterClearBtn');
const helpBtn       = document.getElementById('helpBtn');
const helpOverlay   = document.getElementById('helpOverlay');
const helpClose     = document.getElementById('helpClose');
const recordStatus  = document.getElementById('recordingStatus');
const statShowing   = document.getElementById('statShowing');
const statTotal     = document.getElementById('statTotal');
const statTotalTime = document.getElementById('statTotalTime');
const statAvgTime   = document.getElementById('statAvgTime');
const statTotalSize = document.getElementById('statTotalSize');
const requestsView  = document.getElementById('requestsView');
const summaryView   = document.getElementById('summaryView');
const requestsBody  = document.getElementById('requestsBody');
const summaryBody   = document.getElementById('summaryBody');
const emptyState    = document.getElementById('emptyState');
const tabs          = document.querySelectorAll('.tab');
const tableHeaders  = document.querySelectorAll('th[data-col]');

// ── Render ───────────────────────────────────────────────────────────────────

function renderTable() {
  const sorted = [...filteredRequests].sort((a, b) => {
    let av = a[sortCol], bv = b[sortCol];
    if (typeof av === 'string') av = av.toLowerCase();
    if (typeof bv === 'string') bv = bv.toLowerCase();
    if (av < bv) return sortDir === 'asc' ? -1 : 1;
    if (av > bv) return sortDir === 'asc' ? 1 : -1;
    return 0;
  });

  if (sorted.length === 0) {
    requestsBody.innerHTML = '';
    emptyState.style.display = 'flex';
    return;
  }
  emptyState.style.display = 'none';

  const renderHeaders = (hdrs) => {
    if (!hdrs || hdrs.length === 0) return `<div class="headers-empty">No headers captured.</div>`;
    const items = hdrs
      .map((h) => {
        const name = esc(h.name);
        const value = esc(h.value ?? '');
        return `<div class="hdr"><span class="hdr-k">${name}</span><span class="hdr-v">${value}</span></div>`;
      })
      .join('');
    return `<div class="headers-list">${items}</div>`;
  };

  const rows = sorted.map((r) => {
    const tc = timeClass(r.responseTime);
    const sc = statusClass(r.statusCode);
    const isExpanded = expandedRequestId === r.id;
    const details = isExpanded
      ? `<tr class="details-row">
          <td colspan="7">
            <div class="details-wrap">
              <div class="details-col">
                <div class="details-title">Request headers</div>
                ${captureHeaders ? renderHeaders(r.requestHeaders) : `<div class="headers-disabled">Enable “Headers” to capture.</div>`}
              </div>
              <div class="details-col">
                <div class="details-title">Response headers</div>
                ${captureHeaders ? renderHeaders(r.responseHeaders) : `<div class="headers-disabled">Enable “Headers” to capture.</div>`}
              </div>
            </div>
          </td>
        </tr>`
      : '';

    return `<tr class="request-row" data-id="${esc(r.id)}">
      <td class="col-time ${tc}">${fmtTime(r.responseTime)}</td>
      <td class="col-status ${sc}">${esc(r.statusCode || '—')}</td>
      <td class="col-method">${esc(r.method)}</td>
      <td class="col-host" title="${esc(r.hostname)}">${esc(r.hostname)}</td>
      <td class="col-uri" title="${esc(r.uri)}">${esc(r.uri)}</td>
      <td class="col-req">${fmtSize(r.requestSize)}</td>
      <td class="col-res">${r.responseSize < 0 ? 'N/A' : fmtSize(r.responseSize)}</td>
    </tr>${details}`;
  });
  requestsBody.innerHTML = rows.join('');
}

function renderSummary() {
  const hostMap = new Map();
  for (const r of filteredRequests) {
    const h = r.hostname;
    if (!hostMap.has(h)) hostMap.set(h, { total: 0, count: 0 });
    const e = hostMap.get(h);
    e.total += r.responseTime;
    e.count += 1;
  }

  const sorted = [...hostMap.entries()]
    .sort((a, b) => b[1].total - a[1].total)
    .slice(0, 10);

  if (sorted.length === 0) {
    summaryBody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:var(--text-muted);padding:20px">No data</td></tr>`;
    return;
  }

  const maxTotal = sorted[0][1].total;
  const rankClass = (i) => i === 0 ? 'gold' : i === 1 ? 'silver' : i === 2 ? 'bronze' : '';

  summaryBody.innerHTML = sorted.map(([host, data], i) => {
    const pct = maxTotal > 0 ? (data.total / maxTotal * 100).toFixed(1) : 0;
    const avg = data.total / data.count;
    return `<tr>
      <td><span class="rank-badge ${rankClass(i)}">${i + 1}</span></td>
      <td style="color:var(--accent);font-family:var(--font-mono)">${esc(host)}</td>
      <td style="text-align:right;color:var(--warn)">${fmtTimeCumul(data.total)}</td>
      <td style="text-align:right">${data.count}</td>
      <td style="text-align:right;color:var(--text-muted)">${fmtTime(avg)}</td>
      <td class="bar-cell">
        <div class="bar-bg"><div class="bar-fill" style="width:${pct}%"></div></div>
      </td>
    </tr>`;
  }).join('');
}

function renderStats() {
  const total = filteredRequests.length;
  const totalTime = filteredRequests.reduce((s, r) => s + r.responseTime, 0);
  const totalSize = filteredRequests.reduce((s, r) => s + (r.responseSize > 0 ? r.responseSize : 0), 0);

  statShowing.textContent = total;
  statTotal.textContent = allRequests.length;
  statTotalTime.textContent = fmtTimeCumul(totalTime);
  statAvgTime.textContent = total > 0 ? fmtTime(totalTime / total) : '0.000s';
  statTotalSize.textContent = fmtSize(totalSize);
}

function refresh() {
  filteredRequests = applyFilter(allRequests, filterInput.value);
  renderStats();
  if (activeTab === 'requests') renderTable();
  else renderSummary();
}

// ── Sort ─────────────────────────────────────────────────────────────────────

tableHeaders.forEach((th) => {
  th.addEventListener('click', () => {
    const col = th.dataset.col;
    if (sortCol === col) {
      sortDir = sortDir === 'desc' ? 'asc' : 'desc';
    } else {
      sortCol = col;
      sortDir = 'desc';
    }
    tableHeaders.forEach((h) => {
      h.classList.toggle('sorted', h.dataset.col === sortCol);
      const icon = h.querySelector('.sort-icon');
      if (icon) {
        icon.textContent = h.dataset.col === sortCol
          ? (sortDir === 'desc' ? '▼' : '▲')
          : '';
      }
    });
    renderTable();
  });
});

// ── Tabs ─────────────────────────────────────────────────────────────────────

tabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    activeTab = tab.dataset.tab;
    tabs.forEach((t) => t.classList.toggle('active', t.dataset.tab === activeTab));
    requestsView.classList.toggle('visible', activeTab === 'requests');
    summaryView.classList.toggle('visible', activeTab === 'summary');
    refresh();
  });
});

// ── Filter ───────────────────────────────────────────────────────────────────

let filterTimer;
filterInput.addEventListener('input', () => {
  filterClearBtn.classList.toggle('visible', filterInput.value.length > 0);
  filterInput.classList.remove('error');
  clearTimeout(filterTimer);
  filterTimer = setTimeout(() => {
    try {
      if (filterInput.value.trim()) new FilterParser(filterInput.value).parse();
      filterInput.classList.remove('error');
    } catch {
      filterInput.classList.add('error');
    }
    refresh();
  }, 200);
});

filterClearBtn.addEventListener('click', () => {
  filterInput.value = '';
  filterInput.classList.remove('error');
  filterClearBtn.classList.remove('visible');
  refresh();
});

// ── Buttons ──────────────────────────────────────────────────────────────────

btnRecord.addEventListener('click', () => {
  isRecording = !isRecording;
  chrome.runtime.sendMessage({ type: 'SET_RECORDING', value: isRecording });
  btnRecord.textContent = isRecording ? 'Pause' : 'Record';
  btnRecord.classList.toggle('recording', isRecording);
  recordStatus.textContent = isRecording ? 'RECORDING' : 'PAUSED';
});

btnClear.addEventListener('click', () => {
  const msg =
    lastViewerTabId !== undefined
      ? { type: 'CLEAR_REQUESTS', tabId: lastViewerTabId }
      : { type: 'CLEAR_REQUESTS' };
  chrome.runtime.sendMessage(msg, () => {
    allRequests = [];
    refresh();
  });
});

btnExport.addEventListener('click', exportCSV);

captureHeadersToggle?.addEventListener('change', () => {
  const value = captureHeadersToggle.checked === true;
  captureHeaders = value;
  chrome.runtime.sendMessage({ type: 'SET_CAPTURE_HEADERS', value }, () => {
    refresh();
  });
});

requestsBody.addEventListener('click', (e) => {
  const tr = e.target?.closest?.('tr.request-row');
  if (!tr) return;
  const id = tr.getAttribute('data-id');
  expandedRequestId = expandedRequestId === id ? null : id;
  renderTable();
});

btnTab.addEventListener('click', () => {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const id = tabs[0]?.id;
    const q =
      id !== undefined ? `?forTab=${encodeURIComponent(String(id))}` : '';
    chrome.tabs.create({ url: chrome.runtime.getURL('popup.html') + q });
  });
});

// ── Help ─────────────────────────────────────────────────────────────────────

helpBtn.addEventListener('click', () => helpOverlay.classList.add('visible'));
helpClose.addEventListener('click', () => helpOverlay.classList.remove('visible'));
helpOverlay.addEventListener('click', (e) => {
  if (e.target === helpOverlay) helpOverlay.classList.remove('visible');
});

// ── Export CSV ───────────────────────────────────────────────────────────────

function csvEscape(val) {
  const s = String(val === null || val === undefined ? '' : val);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function exportCSV() {
  const headers = [
    'Timestamp',
    'Response Time (s)',
    'Status',
    'Method',
    'Hostname',
    'URI',
    'Request Size (bytes)',
    'Response Size (bytes)',
    'Request Headers (JSON)',
    'Response Headers (JSON)',
  ];
  const rows = filteredRequests.map((r) => [
    new Date(r.timestamp).toISOString(),
    r.responseTime.toFixed(6),
    r.statusCode,
    r.method,
    r.hostname,
    r.uri,
    r.requestSize,
    r.responseSize < 0 ? '' : r.responseSize,
    r.requestHeaders && r.requestHeaders.length ? JSON.stringify(r.requestHeaders) : '',
    r.responseHeaders && r.responseHeaders.length ? JSON.stringify(r.responseHeaders) : '',
  ]);

  const csv = [headers, ...rows].map((row) => row.map(csvEscape).join(',')).join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `network-report-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// ── Init & poll ──────────────────────────────────────────────────────────────

function loadData() {
  chrome.runtime.sendMessage({ type: 'GET_REQUESTS' }, (res) => {
    if (chrome.runtime.lastError) return;
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (chrome.runtime.lastError) return;
      const tabId =
        viewerTabIdPinned !== null ? viewerTabIdPinned : tabs[0]?.id;
      lastViewerTabId = tabId;
      const raw = res.requests || [];
      allRequests =
        tabId === undefined
          ? []
          : raw.filter((r) => r.tabId === tabId);
      isRecording = res.isRecording !== false;
      captureHeaders = res.captureHeaders === true;
      if (captureHeadersToggle) captureHeadersToggle.checked = captureHeaders;
      btnRecord.textContent = isRecording ? 'Pause' : 'Record';
      btnRecord.classList.toggle('recording', isRecording);
      recordStatus.textContent = isRecording ? 'RECORDING' : 'PAUSED';
      refresh();
    });
  });
}

loadData();
// Refresh every 2 seconds while the popup is open
const pollInterval = setInterval(loadData, 2000);
window.addEventListener('unload', () => clearInterval(pollInterval));
