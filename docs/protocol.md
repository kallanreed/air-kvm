# Protocol (Current, March 2026)

## Overview
- UART transport uses JSON lines (`\n` delimited).
- Firmware emits multiplexed frames:
  - `{"ch":"ctrl","msg":{...}}` for protocol payloads
  - `{"ch":"log","msg":"..."}` for diagnostics
- BLE bridge carries JSON command/event payloads between extension and firmware.

## Core Device Commands (UART/BLE)
Supported command shapes:

```json
{"type":"mouse.move_rel","dx":10,"dy":-4}
{"type":"mouse.move_abs","x":1200,"y":340}
{"type":"mouse.click","button":"left"}
{"type":"key.tap","key":"Enter"}
{"type":"state.request"}
{"type":"state.set","busy":true}
{"type":"fw.version.request"}
{"type":"dom.snapshot.request","request_id":"req-1"}
{"type":"tabs.list.request","request_id":"req-2"}
{"type":"screenshot.request","source":"tab","request_id":"req-3"}
{"type":"screenshot.request","source":"desktop","request_id":"req-4"}
```

`screenshot.request` optional fields:
- `max_width` (int)
- `max_height` (int)
- `quality` (number)
- `max_chars` (int)
- `tab_id` (int, tab source only)
- `encoding` (`b64` or `b64z`)

## Core Responses / Events
Examples:

```json
{"ch":"ctrl","msg":{"type":"state","busy":false}}
{"ch":"ctrl","msg":{"type":"fw.version","version":"dev","built_at":"Mar  7 2026 12:34:56"}}
{"ch":"ctrl","msg":{"type":"dom.snapshot","request_id":"req-1","summary":{...}}}
{"ch":"ctrl","msg":{"type":"tabs.list","request_id":"req-2","tabs":[...]}}
{"ch":"ctrl","msg":{"type":"dom.snapshot.error","request_id":"req-1","error":"..."}}
{"ch":"ctrl","msg":{"type":"tabs.list.error","request_id":"req-2","error":"..."}}
{"ch":"ctrl","msg":{"ok":true}}
{"ch":"log","msg":"rx.ble {\"type\":\"state.request\"}"}
```

Boot frame includes build metadata:

```json
{"type":"boot","fw":"air-kvm-ctrl-cb01","version":"dev","built_at":"Mar  7 2026 12:34:56"}
```

## Screenshot Transfer Protocol (Current)

### Transfer-session framing (primary path)
Extension sends:

```json
{"type":"transfer.meta","request_id":"req-3","transfer_id":"tx_...","source":"tab","mime":"image/jpeg","encoding":"b64","chunk_size":120,"total_chunks":235,"total_chars":28156}
{"type":"transfer.chunk","request_id":"req-3","transfer_id":"tx_...","source":"tab","seq":0,"data":"..."}
{"type":"transfer.done","request_id":"req-3","transfer_id":"tx_...","source":"tab","total_chunks":235}
```

MCP may send control back while collecting:

```json
{"type":"transfer.ack","request_id":"req-3","transfer_id":"tx_...","highest_contiguous_seq":63}
{"type":"transfer.resume","request_id":"req-3","transfer_id":"tx_...","from_seq":64}
{"type":"transfer.done.ack","request_id":"req-3","transfer_id":"tx_..."}
{"type":"transfer.cancel","request_id":"req-3","transfer_id":"tx_..."}
{"type":"transfer.reset","request_id":"req-3"}
```

Error/administrative frames:

```json
{"type":"transfer.error","request_id":"req-3","transfer_id":"tx_...","code":"no_such_transfer"}
{"type":"transfer.cancel.ok","request_id":"req-3","transfer_id":"tx_..."}
{"type":"transfer.reset.ok","request_id":"req-3"}
```

Notes:
- `transfer_id` is required for resume/ack/cancel semantics.
- If `transfer_id` is unknown, extension returns `transfer.error` with `code:"no_such_transfer"`.
- Extension keeps transfer state in memory with TTL pruning.

## MCP Tool Contract
Available tools:
- `airkvm_send`
- `airkvm_list_tabs`
- `airkvm_dom_snapshot`
- `airkvm_screenshot_tab`
- `airkvm_screenshot_desktop`

`airkvm_screenshot_tab` options:
- `request_id`, `max_width`, `max_height`, `quality`, `max_chars`, `tab_id`, `encoding`

`airkvm_screenshot_desktop` options:
- `request_id`, `max_width`, `max_height`, `quality`, `max_chars`, `encoding`

Structured tool outputs for DOM/tabs/screenshot are JSON payloads in text content.

## BLE Manual Testing
GATT profile:
- Service: `6E400101-B5A3-F393-E0A9-E50E24DCCB01`
- RX (write/writeWithoutResponse): `6E400102-B5A3-F393-E0A9-E50E24DCCB01`
- TX (notify/read): `6E400103-B5A3-F393-E0A9-E50E24DCCB01`

Send UTF-8 JSON payloads to RX characteristic. Newline is optional over BLE.
