# AirKVM Plan And Status (March 8, 2026)

## Goal

Maintain a reliable remote-control and browser-automation stack where:
- MCP tools can request DOM, tab list, tab screenshots, and desktop screenshots.
- MCP tools can open new browser tabs on the target extension machine.
- Screenshot transfers are deterministic and recoverable under packet loss.
- Firmware/extension/MCP protocol behavior is stable and documented.

## Current State (Implemented)

### Firmware
- BLE UART-style GATT service is active (`6E400101-...`) with device name `air-kvm-ctrl-cb01`.
- Command router supports pass-through for `dom.snapshot`, `tabs.list`, `screenshot`, and `transfer.*` control messages.
- UART output is framed binary (`AK`) for control/log/binary payloads.
- Single deterministic UART TX writer path is enforced on ESP32 (queue + TX task).
- Oversized BLE control notify payloads are chunked with `ctrl.chunk`.
- HID code exists, but default app build uses `AIRKVM_ENABLE_HID=0`.

### MCP
- Structured tools exist and are live:
  - `airkvm_send`
  - `airkvm_list_tabs`
  - `airkvm_open_tab`
  - `airkvm_dom_snapshot`
  - `airkvm_exec_js_tab`
  - `airkvm_screenshot_tab`
  - `airkvm_screenshot_desktop`
- UART parser supports mixed framed stream (`ctrl`, `log`, `bin`, and `bin_error`).
- Screenshot collector supports:
  - binary chunk reassembly
  - ACK/NACK/resume flow control
  - done-ack completion
  - payload validation (`screenshot_corrupt_payload`)
  - explicit timeout classes (`screenshot_meta_timeout`, `screenshot_transfer_timeout`)

### Extension
- BLE bridge page is the primary BLE runtime path.
- Service worker handles:
  - `dom.snapshot.request`
  - `tabs.list.request`
  - `tab.open.request`
  - `js.exec.request` (single in-flight execution, timeout-bounded, `world: 'MAIN'`)
  - `screenshot.request` (tab + desktop)
  - transfer session controls (`transfer.resume`, `transfer.ack`, `transfer.done.ack`, `transfer.nack`, `transfer.cancel`, `transfer.reset`)
- Screenshot path includes capture timeout/stage timeout guards and JPEG downscale/compression logic.
- Default logging is low-noise; verbose mode is toggleable in bridge UI.

## Known Remaining Work

1. HID path is not the primary validated mode.
- Firmware HID support needs dedicated validation if HID milestones are re-prioritized.

2. End-to-end resilience testing matrix is still thin.
- Need broader scripted fault-injection coverage for chunk loss, reconnects, and bridge restarts.

3. Protocol-level observability can be improved.
- Keep tightening diagnostics for transfer stalls and lifecycle churn under real-world BLE instability.

4. Documentation maintenance discipline.
- Any transport/protocol change must update `docs/protocol.md`, `docs/architecture.md`, and this file in same PR.

## Immediate Next Steps

1. Add/expand integration tests that simulate:
- missing chunks
- duplicate chunks
- transfer resume from arbitrary sequence
- done-ack cleanup correctness

2. Validate repeated long-run desktop capture sessions under normal and noisy conditions.

3. If HID milestone resumes, define a separate HID validation checklist and keep it isolated from BLE UART data path.
