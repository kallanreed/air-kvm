# AirKVM Plan And Status (March 10, 2026)

## Goal

Maintain a reliable remote-control and browser-automation stack where:
- MCP tools can request DOM, tab list, tab screenshots, and desktop screenshots.
- MCP tools can open new browser tabs on the target extension machine.
- Payload transfers are reliable regardless of size, with firmware backpressure as the flow control.
- Firmware/extension/MCP protocol behavior is stable and documented.

## Current State (Implemented)

### Firmware
- BLE UART-style GATT service is active (`6E400101-...`) with device name `air-kvm-ctrl-cb01`.
- Command router supports pass-through for `dom.snapshot`, `tabs.list`, `screenshot`, and `stream.*` control messages.
- UART output is framed binary (`AK`) for control/log/binary payloads.
- Single deterministic UART TX writer path is enforced on ESP32 (queue + TX task).
- BLE RX queue remains the required BLE->UART serialization path.
- Stream ack generation: after forwarding binary chunk to UART, firmware sends `stream.ack` back on BLE.
- HID enabled by default (`AIRKVM_ENABLE_HID=1`) with security mode 1.
- `key.type` supports escape sequences: `\n`, `\t`, `\\`, `{Enter}`, `{Tab}`, `{Escape}`, `{Backspace}`, `{Delete}`, `{Up/Down/Left/Right}`.
- All legacy `transfer.*` command types removed from protocol/parser/router.

### MCP
- Structured tools: `airkvm_send`, `airkvm_list_tabs`, `airkvm_open_tab`, `airkvm_dom_snapshot`, `airkvm_exec_js_tab`, `airkvm_screenshot_tab`, `airkvm_screenshot_desktop`.
- UART parser supports mixed framed stream (`ctrl`, `log`, `bin`, and `bin_error`).
- `streamRequest()`: receives chunked binary responses (screenshots, DOM) via StreamReceiver.
- `streamSendCommand()`: sends large js.exec scripts as JSON-based `stream.data` chunks via StreamSender.
- `_collectFrames()`: shared frame-collection loop used by all transport methods (deduped from sendCommand/waitForFrame).
- Stream observability: UART debug logging for stream start/complete/error/timeout events.
- Old dom_snapshot and binary_screenshot collectors removed — stream path is now required.

### Extension
- BLE bridge page is the primary BLE runtime path.
- Service worker handles all browser automation commands.
- StreamSender: sends screenshots and DOM snapshots as AK binary chunk frames.
- StreamReceiver: receives large js.exec commands via `stream.data` JSON chunks dispatched through normal handler system.
- `stream.ack/nack/reset/data` handlers in `kBleCommandHandlers`.
- `bleWrite()` helper consolidates postEvent/postBinary telemetry boilerplate.
- All legacy inbound transfer code removed (inboundScriptTransfers, transfer.meta/chunk/done handlers).

## Known Issues

1. **Firmware Phase 2 not build-verified.** Stream ack generation and transfer type removal not yet compiled on ESP32 (no C++ toolchain available on Windows).

2. **Binary frame payload divergence.** MCP allows 4096-byte payloads; extension caps at 1024. Both are now documented in source.

---

## Transport Stream Architecture

### Design

Two independent streams with firmware bridging between them:

```
MCP app code                                    Extension app code
    │  stream.send(obj)                             │  stream.onMessage(obj)
    ▼                                               ▲
┌──────────────┐                               ┌──────────────┐
│ Stream Layer │  (MCP side)                   │ Stream Layer │  (Extension side)
│  chunk/ack   │                               │  reassemble  │
└──────┬───────┘                               └──────▲───────┘
       │ UART                                         │ BLE
┌──────▼──────────────────────────────────────────────┴───────┐
│                        Firmware                              │
│   Ext→MCP: binary chunk on BLE → forward to UART → ack BLE  │
│   MCP→Ext: JSON on UART → forward to BLE (pass-through)     │
└──────────────────────────────────────────────────────────────┘
```

**Key principles:**
- App code never thinks about chunking or payload size.
- One chunk in flight at a time per stream. Firmware backpressure is the flow control.
- Firmware acks the sender only after confirmed delivery to the other side.
- The firmware never buffers more than one chunk — can't overrun.
- Two chunking modes: binary (extension→MCP) and JSON/base64 (MCP→extension).

### Wire Protocol

See `docs/protocol.md` for full specification.

### Implementation Phases

#### Phase 1 — Stream layer in MCP and extension ✅
#### Phase 2 — Firmware stream awareness ✅
#### Phase 3 — Migrate dom/screenshot/large-js.exec to stream ✅ (partial)

- DOM snapshot and screenshot via StreamSender/StreamReceiver (binary chunks)
- js.exec script upload via StreamSender JSON-only mode (`stream.data` chunks)
- **Incomplete**: only dom/screenshot responses and js.exec >4096 bytes migrated.
  All other commands and responses still sent inline, breaking on BLE MTU (~160 bytes).

#### Phase 4 — Legacy cleanup ✅

- Removed all legacy transfer code from extension (~500 lines total)
- Removed all `transfer.*` types from firmware protocol/parser/router
- Removed old MCP collectors for dom_snapshot/screenshot (~590 lines)
- Deduplicated sendCommand/waitForFrame into `_collectFrames()`
- Extracted `bleWrite()` helper in bridge.js
- Documented binary_frame.js payload divergence
- Updated `docs/protocol.md` and `docs/architecture.md`

---

## Half-Pipe Transport Migration (March 11, 2026)

### Problem

The current transport has multiple code paths (`sendCommand`, `streamSendCommand`,
`streamRequest`, collectors) with per-tool routing and size thresholds. Payloads
exceeding BLE MTU silently break. The stream protocol uses expensive JSON for acks
and `stream.data` envelopes.

### Design

See `docs/protocol.md` §5–§6 for full spec. Summary:

- **App API**: `send(obj)` / `onMessage(cb)`. App knows nothing about transport.
- **All frames are binary AK v2**: 12-byte header, max 255-byte payload, 267 bytes max.
- **Frame types**: chunk (`0x01`), control (`0x02`), log (`0x03`), ack (`0x04`),
  nack (`0x05`), reset (`0x06`). No JSON in stream protocol.
- **One stream at a time**. One chunk in flight. Ack-gated.
- **`send()` rejects** on timeout/reset/cancel, clears state for next send.
- **`len < 255`** signals final chunk. Exact multiples send `len=0` terminator.
- **Reset always gets through** — never queued behind data, works from any state.

### Phase 5 — AK frame v2 codec ⬜

New `binary_frame.js` (shared or mirrored for MCP/extension) implementing v2:
- `encodeFrame(type, transferId, seq, payload)` → Uint8Array/Buffer
- `decodeFrame(bytes)` → `{type, transferId, seq, payload}` or null
- CRC32 encode/verify
- All six frame types supported
- Remove v1 codec

**Files**: `mcp/src/binary_frame.js`, `extension/src/binary_frame.js`

**Validation**: Unit tests for encode/decode round-trip, CRC validation, all
frame types, edge cases (len=0 terminator, max payload, bad CRC).

### Phase 6 — MCP half-pipe transport ⬜

Build the MCP-side half-pipe:
- `send(obj)` → JSON serialize → chunk into AK v2 frames → write to UART →
  wait for ack per chunk → resolve when complete
- `onMessage(cb)` → receive AK frames from UART → reassemble chunks by
  transfer_id/seq → parse JSON → deliver to callback
- One-send-at-a-time: queue subsequent sends behind current
- Timeout: reject + clear state after configurable deadline
- Reset: send reset frame, clear all local state, reject pending send
- Incoming reset: clear reassembly state, forward to app if needed
- Wire to UART serial read/write (replaces old `writeRawCommand` + frame parsing)

**Files**: `mcp/src/halfpipe.js` (new), `mcp/src/uart.js` (rewire)

**Validation**: `cd mcp && node --test` — new half-pipe tests for:
send small (single chunk), send large (multi-chunk), one-at-a-time enforcement,
timeout rejection, reset clears state, onMessage reassembly, ack/nack handling.

### Phase 7 — MCP server uses half-pipe ⬜

- Remove all transport routing logic from `server.js`
- Remove `sendCommand`, `streamSendCommand`, `streamRequest` calls
- Remove `kJsExecInlineMaxBytes`, `createResponseCollector`, inline vs stream decisions
- All structured tools: `await transport.send(command)`, correlate response via
  `transport.onMessage()` + `request_id` matching
- `airkvm_send` (HID): still goes through firmware-local path (no BLE crossing)
- Remove old `StreamSender`/`StreamReceiver` imports

**Files**: `mcp/src/server.js`, `mcp/src/tooling.js` (remove collector infra)

**Validation**: `cd mcp && node --test` — all pass. Server tests updated for
half-pipe transport mock.

### Phase 8 — Extension half-pipe transport ⬜

Build the extension-side half-pipe — same `send(obj)`/`onMessage(cb)` API:
- `send(obj)` → JSON serialize → chunk → AK v2 frames → BLE bridge write →
  ack-gated → resolve
- `onMessage(cb)` → receive AK frames from BLE bridge → reassemble → deliver
- Same serialization, one-at-a-time, timeout, reset semantics as MCP side
- Wire to BLE bridge IPC (`postBinaryViaBridge` for writes, bridge RX for reads)

**Files**: `extension/src/halfpipe.js` (new), `extension/src/bridge.js` (rewire)

**Validation**: `cd extension && node --test` — new half-pipe tests mirroring
MCP side.

### Phase 9 — Extension service worker uses half-pipe ⬜

- All command handlers send responses via `transport.send()`:
  `sendJsExec`, `sendTabsList`, `sendOpenTab`, `sendWindowBounds`,
  `sendDomSnapshot`, `sendScreenshot` + all error paths
- Inbound commands arrive via `transport.onMessage()` → dispatch to handlers
- Remove `postEventViaBridge`/`StreamSender`/`StreamReceiver`/`kBleCommandHandlers`
- Remove old `stream.ack/nack/reset/data` JSON handlers

**Files**: `extension/src/service_worker.js`

**Validation**: `cd extension && node --test` — all pass. Service worker tests
updated for half-pipe transport mock.

### Phase 10 — Firmware: AK v2 bridge ⬜

- UART reader: detect AK magic (`0x41 0x4B`) on serial input, switch to binary
  frame parsing (read by header length). Fall back to text line for non-AK input.
- Forward AK frames bidirectionally: UART→BLE, BLE→UART.
- All six frame types forwarded identically (firmware doesn't interpret payloads).
- BLE size guard: reject frames exceeding max notify size with nack.
- Reset priority: never queued behind data in TX queue.
- Remove old JSON-based `stream.ack/nack/reset` command types from parser.
- Remove old v1 binary frame handling.

**Files**: `firmware/src/transport_mux.cpp`, `firmware/src/app.cpp`,
`firmware/src/command_router.cpp`, `firmware/include/*.hpp`

**Validation**: `cd firmware && pio test -e native` — all pass. Test cases:
frame forwarding both directions, BLE size guard rejection, reset priority
(mid-transfer, full queue, BLE disconnected).

### Phase 11 — Cleanup + E2E ⬜

- Remove all dead code: old `StreamSender`/`StreamReceiver`, v1 `binary_frame.js`,
  old transport methods, collector infrastructure, `stream.data` JSON path
- Update `docs/architecture.md`
- `cd mcp && node --test && cd ../extension && node --test` — all pass
- Smoke test with live hardware

---

## Other Completed Work

- **HID enabled by default** — `AIRKVM_ENABLE_HID=1` in firmware with security mode 1.
- **key.type escape handling** — firmware HID controller parses `\n`, `\t`, `\\`, and `{Name}` sequences.
- **Protocol observability** — stream-specific UART debug logging for all stream operations.

## Remaining Work

1. **Stream-all migration** — Phases 5–10 above.
2. **Build-verify firmware on ESP32** — Phase 2 stream changes, transfer removal, and Phase 9 size guard need compilation test.
3. **Documentation discipline** — any transport/protocol change must update `docs/protocol.md`, `docs/architecture.md`, and this file in the same PR.
