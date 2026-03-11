# Browser Tools Investigation — 2026-03-11

## Summary

Live testing of the MCP browser tools against the extension over BLE/UART revealed one
bug that was fixed, and one open issue requiring further work.

---

## ✅ Fixed: Firmware echoes passthrough requests back to UART

### Root cause

`firmware/src/command_router.cpp` — the `HandleCommand` passthrough block (all
`kDomSnapshotRequest`, `kTabsListRequest`, `kScreenshotRequest`, `kJsExecRequest`, etc.)
had an extra `transport_.EmitControlUartOnly(cmd.raw.c_str())` in the UART→BLE branch:

```cpp
} else {
    transport_.EmitControlUartOnly(cmd.raw.c_str()); // ← BUG
    const auto forwarded = transport_.ForwardControlToBle(cmd.raw.c_str());
```

The echo caused the MCP `streamRequest()` to receive the request payload as if it were
the response and resolve immediately — before the extension ever replied.

### Symptoms
- `airkvm_dom_snapshot` returned `{"snapshot": {"type":"dom.snapshot.request",...}}` (the request echoed)
- `airkvm_screenshot_tab` returned `{"base64":""}` (empty — resolved on echo before image arrived)

### Fix
Removed the spurious `EmitControlUartOnly` call from the `else` (UART→BLE) branch.
The BLE→UART direction still correctly calls `EmitControlUartOnly` to relay extension
responses back to the host.

**Commit:** firmware: remove spurious UART echo in passthrough command handler

### Verification
After flashing `esp32dev_hid_uart`:
- `airkvm_list_tabs` → ✅ returns tab list
- `airkvm_dom_snapshot` → ✅ returns full DOM summary with actionable elements
- `airkvm_screenshot_tab` → ✅ returns 40KB JPEG
- `airkvm_open_tab` → ✅ opens tab, returns tab metadata

---

## 🔴 Open: `airkvm_exec_js_tab` times out on large scripts

### Symptoms

`airkvm_exec_js_tab` with a ~555-byte `js.exec.request` JSON times out. Diagnostics show:
- Firmware logs `ble.notify len:555 result:attempted` — the command was sent to the extension
- No `js.exec.result` ever arrives back

### Hypothesis

`ForwardControlToBle` sends the full payload in a single `tx_char_->notify()` call with no
chunking. If the negotiated BLE MTU is less than 556 bytes (e.g. 517 bytes on some
platforms, or 23 bytes on constrained ones), the BLE stack may split the notification into
multiple packets. The extension's BLE RX path (`bridge.js`) buffers incoming bytes and
parses newline-delimited JSON — but if the fragmented packets don't reassemble cleanly
(or the JSON arrives incomplete before the newline), `JSON.parse()` fails and the command
handler is never invoked.

The extension's **TX→firmware** direction already chunks writes at 160 bytes
(`kBleWriteChunkBytes` in `bridge.js`). The firmware's **TX→extension** direction
(`ForwardControlToBle` / `EmitBleControl` in `transport_mux.cpp`) does **not** chunk —
it issues a single `notify()` for the full payload.

### Next steps

1. Confirm whether the extension's line buffer is actually reassembling split packets
   correctly (it may work fine at 517-byte MTU but break below).
2. Add chunking to `EmitBleControl` in `transport_mux.cpp`, matching the extension's
   160-byte chunk size, with a small inter-chunk delay if needed.
3. Alternatively, negotiate a larger MTU explicitly in `app.cpp`.
4. Add a firmware native test for large passthrough forwarding.

---

## Tools tested

| Tool | Status | Notes |
|------|--------|-------|
| `airkvm_list_tabs` | ✅ | Returns tab list over BLE |
| `airkvm_open_tab` | ✅ | Opens tab, returns metadata |
| `airkvm_dom_snapshot` | ✅ (after fix) | Returns full DOM summary |
| `airkvm_screenshot_tab` | ✅ (after fix) | Returns JPEG via chunked stream |
| `airkvm_exec_js_tab` | ❌ | Times out; large command not reaching extension |
| `airkvm_window_bounds` | Not tested | |
| `airkvm_screenshot_desktop` | Not tested | |
