# Codex Memory (Compact)

## Current Truth
- Topology:
  - Host/controller runs MCP and connects to firmware over UART.
  - Target machine runs extension only.
  - Extension talks to firmware via BLE only (no localhost/MCP direct path).
- Active transport/protocol path:
  - BLE UART-style GATT service (`6E400101-B5A3-F393-E0A9-E50E24DCCB01`).
  - Firmware UART output uses framed `AK` packets:
    - `0x01` binary transfer chunk
    - `0x02` control JSON
    - `0x03` log text
- Current BLE device name: `air-kvm-ctrl-cb01`.
- Current MCP tools:
  - `airkvm_send`
  - `airkvm_list_tabs`
  - `airkvm_dom_snapshot`
  - `airkvm_screenshot_tab`
  - `airkvm_screenshot_desktop`

## Key Decisions
- Determinism / fail-fast:
  - ESP32 TX queue creation failure is fatal (`abort()`), no degraded fallback path.
  - ESP32 UART TX uses one deterministic queue/task writer path.
- Screenshot transfer path:
  - Binary transfer is authoritative (`encoding: "bin"`).
  - Lifecycle uses `transfer.meta` -> binary chunks -> `transfer.done` -> `transfer.done.ack`.
  - MCP drives flow control with `transfer.ack`, `transfer.nack`, `transfer.resume`.
  - Extension enforces one active screenshot transfer session.
- BLE control continuation:
  - Oversized BLE control payloads use `ctrl.chunk`; extension reassembles before dispatch.

## Logging Defaults
- Bridge page logging defaults to low-noise mode.
- Verbose mode toggle exists in bridge UI and controls raw BLE trace visibility.
- Default command log behavior:
  - suppress `SW->BLE` command entries unless verbose
  - suppress ACK-noise (`transfer.ack`, plain `{ok:true}`) unless verbose
  - classify plain `{ok:true}` as `type: "ack"` when shown

## User Preferences (Operational)
- Cross-platform first (Node-based paths; avoid OS-specific command dependencies in core flow).
- Commit frequently.
- Keep `codex-memory` updated when important behavior/process decisions change.

## Known Risks / Gaps
- Dedicated service-worker unit tests are still missing (backlog item).
- HID path exists in firmware code but is not the primary validated runtime path (`AIRKVM_ENABLE_HID=0` in default app build).

## Pointers
- Protocol authority: `docs/protocol.md`
- Current architecture summary: `docs/architecture.md`
- Current execution plan/backlog: `manager_plan.md` + `docs/plan.md`
