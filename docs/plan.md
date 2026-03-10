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
- BLE RX queue remains the required BLE->UART serialization path; queue writes now use bounded wait and explicit overflow telemetry.
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
  - `js.exec.request` (single in-flight execution, timeout-bounded, CDP `Runtime.evaluate`)
  - `screenshot.request` (tab + desktop)
  - transfer session controls (`transfer.resume`, `transfer.ack`, `transfer.done.ack`, `transfer.nack`, `transfer.cancel`, `transfer.reset`)
- Screenshot path includes capture timeout/stage timeout guards and JPEG downscale/compression logic.
- Default logging is low-noise; verbose mode is toggleable in bridge UI.
- DOM snapshot responses now stream over transfer/binary (`transfer.meta` + binary chunks + `transfer.done`) with ACK/NACK/resume support.
- Outbound control messages are sent as plain JSON lines; large payloads should use transfer streaming rather than control chunking.

## Known Remaining Work

1. HID path is not the primary validated mode.
- Firmware HID support needs dedicated validation if HID milestones are re-prioritized.

2. End-to-end resilience testing matrix is still thin.
- Need broader scripted fault-injection coverage for chunk loss, reconnects, and bridge restarts.

3. Protocol-level observability can be improved.
- Keep tightening diagnostics for transfer stalls and lifecycle churn under real-world BLE instability.

4. Documentation maintenance discipline.
- Any transport/protocol change must update `docs/protocol.md`, `docs/architecture.md`, and this file in same PR.

5. `key.type` escaped-string handling is still missing.
- Add explicit escape parsing for special characters and named special keys (for example newline/tab and `Enter`/`Tab` tokens) so typed text flows can express non-printable keys safely.
- Define the syntax in protocol docs and keep behavior bounded/validated.

## Immediate Next Steps

1. Add/expand integration tests that simulate:
- missing chunks
- duplicate chunks
- transfer resume from arbitrary sequence
- done-ack cleanup correctness

2. Validate repeated long-run desktop capture sessions under normal and noisy conditions.

3. If HID milestone resumes, define a separate HID validation checklist and keep it isolated from BLE UART data path.

4. Implement and validate escaped-string support for `key.type`, with protocol docs + firmware tests.

5. Complete transfer-path reliability validation for non-image payloads.
- Confirm long `dom.snapshot` transfer sessions complete consistently under live BLE conditions.
- Add diagnostics for missing-sequence detection and retry behavior across image + DOM transfers.

## TODO (March 10, 2026 handoff)

1. Finish symmetric transfer reliability for MCP->UART->FW->BLE (JS script upload path).
- Keep transfer controls identical both directions: `transfer.meta/chunk/done` with `transfer.ack/nack/resume/cancel/reset`.
- Keep sender retry policy bounded and deterministic (windowed send + retry caps + timeout behavior).

2. Fix firmware UART ingress corruption under sustained control-chunk traffic.
- Current symptom: malformed/spliced `transfer.chunk` JSON arrives at bridge (`invalid_ctrl_json`) before extension parsing.
- Add UART-ingress hardening so control lines cannot be merged/truncated under burst load.
- Prefer framed/binary ingress for high-volume transfer chunks if line-based JSON cannot be made robust enough.

3. Tighten backpressure defaults for JS upload transfer.
- Start with conservative send window/ACK stride and validate no corruption over repeated >4KB uploads.
- Re-tune upward only after live soak confirms stable ingress with zero malformed chunk lines.

4. Add end-to-end tests for reverse transfer direction (host -> extension).
- ACK progress behavior.
- NACK-triggered chunk resend.
- Resume from arbitrary sequence.
- Cancel/reset cleanup for all active transfer maps and in-flight flags.

5. Resolve `airkvm_send` generic timeout behavior for transfer control responses.
- `transfer.reset.ok` currently reaches transport but may not satisfy `airkvm_send` completion semantics.
- Add explicit correlation handling so reset/transfer control commands surface success without false timeout errors.
