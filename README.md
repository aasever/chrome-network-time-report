# Network Time Report

A Chrome extension that monitors all network traffic in your browser and produces a live, filterable report of every HTTP request and response. Use it to identify slow endpoints, audit third-party requests, or export a full network trace as CSV.

---

## What it does

While active, the extension intercepts every network request made by Chrome and records:

| Column | Description |
|---|---|
| **Time (s)** | Response time in seconds, colour-coded green (< 0.5 s), amber (< 2 s), red (≥ 2 s) |
| **Status** | HTTP status code, colour-coded by class (2xx / 3xx / 4xx / 5xx) |
| **Method** | HTTP method (GET, POST, PUT, DELETE, …) |
| **Hostname** | The host portion of the request URL |
| **URI** | Path and query string |
| **Req Size** | Estimated request size (headers + body) in B / KB / MB / GB |
| **Res Size** | Response size from the `Content-Length` header in B / KB / MB / GB (shown as N/A when the header is absent, e.g. chunked or streaming responses) |

The **Summary tab** ranks the top 10 hosts by their cumulative response time (#1 = slowest total), showing request count, average response time, and a relative bar chart.

---

## Local development setup

### Prerequisites

- Google Chrome (or any Chromium-based browser)
- Git

### 1. Clone the repository

```bash
git clone https://github.com/aasever/chrome-network-time-report.git
cd chrome-network-time-report
```

No build step is required — the extension is plain HTML, CSS, and JavaScript.

### 2. Load the extension in Chrome

1. Open Chrome and navigate to `chrome://extensions`
2. Enable **Developer mode** (toggle in the top-right corner)
3. Click **Load unpacked**
4. Select the `chrome-network-time-report` folder you cloned

The extension icon (⬡) will appear in the Chrome toolbar. Pin it for easy access via the puzzle-piece menu.

### 3. Making changes

Edit any of the source files directly:

| File | Purpose |
|---|---|
| `manifest.json` | Extension metadata and permissions |
| `background.js` | Service worker — intercepts network events via `chrome.webRequest` |
| `popup.html` | Report UI markup |
| `popup.js` | Filtering engine, table rendering, CSV export |
| `popup.css` | All styles |

After editing, go back to `chrome://extensions` and click the **refresh icon** on the extension card to reload it.

---

## Using the extension

### Opening the report

Click the ⬡ **Network Time Report** icon in the Chrome toolbar. The popup opens at 960 px wide. For more screen space click **⤢ Full Tab** to open the report in a dedicated browser tab.

### Recording controls

| Control | Action |
|---|---|
| **Pause / Record** | Temporarily stop or resume capturing requests |
| **Clear** | Wipe all recorded requests |
| **Export CSV** | Download the currently filtered requests as a `.csv` file |

### Filtering

Type a filter expression into the filter bar. Results update as you type.

#### Field filters

```
hostname:api.example.com     # partial match on the hostname
host:cdn                     # shorthand for hostname
uri:/api/v2                  # partial match on the URI path + query
status:404                   # exact status code, or prefix e.g. status:4
method:POST                  # HTTP method (case-insensitive)
```

#### Boolean operators

```
api AND NOT cdn                          # include "api", exclude "cdn"
google.com OR facebook.com               # either hostname
(status:4 OR status:5) AND uri:/auth     # grouping with parentheses
NOT method:GET                           # exclude all GET requests
```

Operators (`AND`, `OR`, `NOT`) are case-insensitive.

#### Free-text search

A bare word without a field prefix matches against hostname, URI, method, and status code simultaneously:

```
analytics          # hides everything that doesn't mention "analytics"
```

### Summary tab

Switches the view to a ranked table of the top 10 hosts by **cumulative response time**. The host with the longest total wait time is ranked #1. Columns show cumulative time, number of requests to that host, and the average response time per request.

---

## Permissions used

| Permission | Why |
|---|---|
| `webRequest` | Observe all network requests and responses |
| `storage` | Persist captured requests and recording state across service-worker restarts |
| `tabs` | Open the report in a new tab via the ⤢ Full Tab button |
| `<all_urls>` (host permission) | Monitor requests to any URL |

