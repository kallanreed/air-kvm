# Transport Layer Rearchitecture Plan

## Problem

Large payloads (>4KB) get silently truncated at the firmware's BLE control buffer. The current transfer protocol (transfer.meta, transfer.done, transfer.ack, transfer.nack, transfer.resume, transfer.cancel, transfer.reset — 10+ message types) pushes chunking/flow-control into the application layer, forcing every tool to manually wire up a session state machine. This is complex, fragile, and duplicated across three collectors in MCP and multiple handlers in the extension.

## Design

Replace with a **transparent stream layer** that lives below the application code but above raw UART/BLE transport. The system has two independent streams with the firmware bridging between them:

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
│   receive chunk on UART → forward on BLE → ack UART when    │
│   BLE delivery confirmed. (And reverse direction.)           │
└──────────────────────────────────────────────────────────────┘
```

**Key principles:**
- App code never thinks about chunking or payload size.
- One chunk in flight at a time per stream. Firmware backpressure is the flow control.
- Firmware acks the sender only after confirmed delivery to the other side.
- The firmware never buffers more than one chunk — can't overrun.

## Wire Protocol

### Frame format

Reuse existing AK binary frame (no changes to `magic`, `version`, `crc` layout):

```
[AK magic 2B] [version 1B] [frame_type 1B] [transfer_id 4B LE] [seq 4B LE] [payload_len 2B LE] [payload] [crc32 4B LE]
```

### Frame types

| Type | Value | Purpose |
|------|-------|---------|
| `chunk` | `0x01` | Data chunk (existing transfer chunk type) |
| `control` | `0x02` | Small inline JSON control message (existing, unchanged) |
| `log` | `0x03` | Log text (existing, unchanged) |

### Chunk frame header additions

Repurpose 1 bit from the existing fields (or add a flags byte within payload envelope):
- **`is_final`**: 1 = this is the last chunk of the transfer. Receiver knows reassembly is complete without a separate "done" message.
- **`transfer_id`**: random 4-byte tag. Distinguishes transfers so stale acks/chunks after reset are ignored.
- **`seq`**: 0-indexed chunk sequence number.

### Control messages (streamlined)

Only 3 transport-level control messages remain:

| Message | Direction | Purpose |
|---------|-----------|---------|
| `stream.ack` | receiver → sender (through firmware) | `{ type: "stream.ack", transfer_id, seq }` — confirms chunk received |
| `stream.nack` | receiver → sender (through firmware) | `{ type: "stream.nack", transfer_id, seq, reason }` — chunk corrupted or undeliverable |
| `stream.reset` | MCP → firmware (out-of-band) | `{ type: "stream.reset" }` — hard clear all stream state on all layers |

### Messages removed

All of these go away:
- `transfer.meta` (first chunk implicitly starts a transfer)
- `transfer.done` / `transfer.done.ack` (`is_final` bit replaces this)
- `transfer.resume` (timeout + retransmit replaces this)
- `transfer.cancel` / `transfer.cancel.ok` (reset replaces this)

### Small message fast path

Messages that fit within a single chunk (most control commands, tab lists, simple responses) are sent as `frame_type=0x02` (control JSON) — same as today, no chunking overhead. The stream layer only activates chunking when the serialized payload exceeds a threshold (e.g. 512 bytes, well under firmware's buffer limit).

## Failure Recovery

### Chunk corrupted
- Receiver CRC fails → nack(transfer_id, seq, "crc_mismatch") → sender retransmits.
- If nack is lost → sender timeout → retransmit anyway.

### Chunk or ack lost
- Sender timeout (e.g. 3s) → retransmit current chunk.
- Receiver gets duplicate seq → idempotent: re-ack, don't double-append to reassembly buffer.
- Max 3 retries, then surface error to app layer.

### BLE disconnect mid-transfer
- Firmware knows (`active_conn_count_ == 0`) → nacks UART sender with reason `downstream_disconnected`.
- MCP surfaces error to app. On BLE reconnect, MCP can retry the whole operation.

### Extension service worker killed (MV3 lifecycle)
- New service worker has no state → ignores chunks for unknown transfer_ids.
- MCP times out → sends `stream.reset` → starts fresh.
- transfer_id prevents stale data from old transfer being confused with new one.

### Firmware reboots
- Both sides lose connection. On reconnect, MCP sends `stream.reset` before any new work.

### Permanent wedge
- MCP retries exhaust → error to app → MCP sends `stream.reset` → clean state.
- Reset is the universal escape hatch. No handshake — fire and forget, both sides clear.

## Implementation Phases

### Phase 1 — Stream layer in MCP and extension

New files:
- `mcp/src/stream.js` — sender/receiver stream layer for UART side
- `extension/src/stream.js` — sender/receiver stream layer for BLE side

Stream layer API (both sides):
```js
// Sender
stream.send(object)         // → chunks, sends one at a time, waits for acks
stream.reset()              // → clears all state

// Receiver
stream.onMessage(callback)  // → called with reassembled objects
stream.onError(callback)    // → called on unrecoverable transfer failure
```

Internally manages: chunking, seq numbering, transfer_id generation, ack tracking, timeout/retry, reassembly, duplicate detection.

### Phase 2 — Firmware stream awareness

Firmware becomes minimally stream-aware:
- Recognizes chunk frames (already does via AK magic).
- When bridging a chunk from UART→BLE: holds off acking UART until BLE write completes (or BLE is confirmed down → nack).
- When bridging a chunk from BLE→UART: emits chunk on UART, acks BLE immediately (UART is reliable/wired).
- On `stream.reset`: clears any pending bridge state.

No reassembly in firmware. No payload inspection. Just chunk-level gate.

### Phase 3 — Migrate app code to use stream layer

- MCP `tooling.js`: `createResponseCollector` for dom_snapshot/screenshot/js_exec all replaced with `stream.send()` / `stream.onMessage()`.
- Extension `service_worker.js`: `pumpTransferSession`, `handleTransferAck`, `handleTransferNack`, `handleTransferResume`, `handleTransferDoneAck`, `sendDomSnapshot` chunking logic, `sendScreenshot` chunking logic — all replaced with `stream.send()`.
- Remove all `transfer.*` handlers from `kBleCommandHandlers` except the new `stream.ack`, `stream.nack`, `stream.reset`.
- Remove `screenshotTransfers` Map, `inboundScriptTransfers` Map, all session lifecycle machinery.

### Phase 4 — Cleanup

- Remove dead transfer message types from `firmware/include/protocol.hpp` and `firmware/src/protocol.cpp`.
- Remove `transfer.*` cases from `command_router.cpp`.
- Remove old `transfer.*` validation from `mcp/src/protocol.js`.
- Update `docs/protocol.md` to reflect new stream protocol.
- Deduplicate `binary_frame.js` constants (document extension 1024 vs MCP 4096 payload limit divergence).
- Deduplicate `sendCommand`/`waitForFrame` in `uart.js`.
- Extract `bleWriteBytes` helper in `bridge.js`.

## Dependency Order

```
Phase 1 (stream.js on both sides) — write and unit test in isolation
Phase 2 (firmware awareness) — can parallel with Phase 1
Phase 3 (migrate app code) — depends on Phase 1 + Phase 2
Phase 4 (cleanup) — depends on Phase 3
```
