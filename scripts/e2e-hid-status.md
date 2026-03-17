# E2E HID Status

## Scope
`scripts/e2e-hid.mjs` exercises the full AirKVM path:
1. MCP tool call
2. UART to firmware
3. Firmware BLE bridge
4. Extension service worker automation
5. HID mouse/keyboard injection back through firmware
6. Browser-side validation in the target tab

## Current status
Transport and routing are working.

The current blocker is no longer transport correctness. It is the last bit of browser-window focus and geometry instability in the HID test on macOS.

Current state:
- request/response matching is fixed
- extension busy-state routing is fixed
- `scripts/poc-smoke.mjs` passes
- `scripts/e2e-integration.mjs` passes
- absolute digitizer-style HID is honored by the host
- `window_bounds.screen` now returns enough browser-reported screen data to build a correct logical screen model
- `scripts/e2e-hid.mjs` is using that direct screen model instead of popup calibration
- latest live HID result is `27/28` passing
- the only remaining failure is `Button 4`, which appears tied to transient layout movement from CDP/debugger activity

## What is fixed

### Request matching bug: fixed
The original shifted-response problem is fixed in `mcp/src/uart.js`.

Current behavior:
- MCP no longer resolves the pending request with the first extension message that arrives
- responses are matched by `request_id` or explicit tool-level matcher
- unmatched extension chatter is ignored instead of shifting all later responses

Evidence:
- `scripts/poc-smoke.mjs` passes
- `scripts/e2e-integration.mjs` passes
- live MCP UART logs no longer show the old one-off response skew

Relevant files:
- `mcp/src/uart.js`
- `mcp/test/uart_transport.test.js`

### Extension busy-state routing bug: fixed
The extension was incorrectly routing firmware-local `state.set` messages onto the MCP-bound HalfPipe message path.

That is now fixed:
- `busy.changed` in `extension/src/service_worker.js` uses the HalfPipe control path to firmware

Result:
- stray `state.set` messages no longer appear at MCP during live HID runs
- this confirmed the AK/HalfPipe routing bug was real, but it is no longer the HID blocker

Relevant files:
- `extension/src/service_worker.js`
- `extension/src/ble_bridge.js`

### Bridge log timeout override: fixed
`airkvm_bridge_logs` can legitimately take longer than the old fixed timeout.

Current behavior:
- MCP now supports tool timeout as a function of args
- `airkvm_bridge_logs` accepts `timeout_ms`

Relevant files:
- `mcp/src/server.js`
- `mcp/src/protocol.js`

### MCP UART file logging: fixed
MCP can now log UART traffic while it owns the serial port.

Use:
```bash
AIRKVM_UART_LOG_PATH=/Users/kylereed/project/air-kvm/temp/e2e-hid-uart.log node scripts/e2e-hid.mjs
```

Relevant files:
- `mcp/src/uart.js`
- `mcp/src/index.js`

## Important protocol note
HalfPipe is the only transport.

More precisely:
- HalfPipe emits AK frames
- AK frames carry explicit frame type and target
- routing semantics already exist inside AK/HalfPipe
- do not add alternate transports or side protocols

Correct usage:
- browser automation traffic: `hp.send(...)`
- firmware-local commands: `hp.sendControl(..., kTarget.FW)`

Examples of firmware-local commands:
- `state.set`
- `state.request`
- `fw.version.request`
- HID commands from MCP

## HID-specific findings

### `exec_js_tab` during HID is unsafe
Once HID interaction starts, do not use `exec_js_tab` mid-flow on macOS/Chromium.

Why:
- CDP activity shows the debugger infobar
- that shifts page content vertically
- measured rects become invalid for HID targeting

This is documented in `scripts/e2e-hid.mjs`.

### Browser chrome clicks are unsafe
Clicks in the browser titlebar / omnibox area are not a valid focus strategy.

Observed problems:
- typing can land in the address bar
- on macOS, bad corner/titlebar clicks can move windows
- browser chrome coordinates are not reliable for page-content targeting

### Absolute mouse descriptor: failed
The first absolute HID experiment used a Generic Desktop mouse-style absolute report.

Observed result:
- firmware accepted `mouse.move_abs`
- host/browser ignored it

Conclusion:
- this descriptor shape is not usable for absolute positioning on this machine

### Digitizer-style absolute descriptor: works
The firmware was changed to expose a digitizer/pen-style absolute report alongside the existing relative path.

Observed result:
- after forgetting and re-pairing the HID device, absolute moves started affecting the browser
- browser-visible pointer movement occurs with `mouse.move_abs`

Conclusion:
- the host honors the digitizer-style absolute report
- absolute mode is viable in this stack

## Direct screen-model findings

### Browser-reported logical screen metrics are the right input
The key discovery is that the browser already reports the logical screen space that the absolute HID mapping aligns with.

Live values from the target browser:
- `devicePixelRatio = 2`
- `screen.width = 1512`
- `screen.height = 982`
- physical display size was `3024 × 1964`

Interpretation:
- the HID absolute range should be mapped against the browser-reported logical screen size, not the physical pixel size
- using raw `3024 × 1964` was wrong because it ignored the `2x` scaling

### `window_bounds.screen` now exposes the needed data
The `airkvm_window_bounds` tool now returns the screen data needed to project client coordinates to HID absolute coordinates:
- `device_pixel_ratio`
- logical `screen.width`
- logical `screen.height`
- `viewport.inner_width`
- `viewport.inner_height`
- `viewport.outer_width`
- `viewport.outer_height`
- `viewport.screen_x`
- `viewport.screen_y`

This is enough to derive:
- browser chrome offsets
- content origin in logical screen space
- direct `screen -> abs` mapping

Relevant files:
- `extension/src/service_worker.js`
- `mcp/test/server.test.js`
- `extension/test/service_worker_js_exec.test.js`

### Popup calibration is no longer the active path
We previously built a popup-based calibration flow and a set of calibration tools/scripts.

That work was useful for learning the model, but it is no longer the active approach because:
- the direct browser-reported screen model is simpler
- the popup toolchain added a lot of one-off surface area
- it did not solve the real underlying issue, which is layout instability after CDP activity

The calibration toolchain has now been removed.

## Current `e2e-hid` behavior
`scripts/e2e-hid.mjs` now:
- uses `window_bounds.screen` directly
- computes logical screen mapping from browser data
- double-clicks the textarea before typing
  - first click raises/focuses the window
  - second click places the caret
- keeps button logging separate from the textarea so typing is measured cleanly

This fixed two earlier misreads:
- the first HID action could be consumed by window focus
- button handlers were mutating the same textarea we were using to validate typing

### Latest live result: `27/28` passing
The current live result is:
- printable ASCII typing works
- `Button 1`, `Button 2`, and `Button 3` register
- only `Button 4` still fails

Interpretation:
- HID absolute targeting is now largely correct
- the remaining miss is narrow and consistent with layout shifting after CDP/debugger work
- the likely remaining issue is stale geometry for the rightmost control, not transport or HID descriptor design

## Current blockers

### 1. CDP/debugger banner still perturbs geometry
We still use `exec_js_tab` for:
- fixture injection
- DOM rect gathering
- validation

That means the debugger banner remains a source of layout instability.

Important nuance:
- moving rect gather later does not help, because rect gather itself uses CDP and can recreate the problem
- deterministic fixture geometry also does not fully solve it if the viewport origin itself shifts when the banner appears/disappears

### 2. Window focus is environmental
The HID test cannot fully guarantee OS-level focus.

Current behavior:
- first click may only raise/focus the window
- second click is needed to activate the textarea/button target
- if another window is covering the browser, the test can still fail for environmental reasons

## Best next step
The strongest next step is to build a non-CDP script injection / readback path using `chrome.scripting.executeScript` for this class of UI test helpers.

Why:
- `airkvm_exec_js_tab` is currently backed by `chrome.debugger` + `Runtime.evaluate`
- that is exactly what causes the debugger banner
- the extension already has a `chrome.scripting.executeScript` path for screen metrics, so the same model can be used for deterministic fixture injection and readback

That should reduce the remaining geometry instability more than further HID math tweaks.

## Summary
The hard transport problems are solved.

The important progress in this round was:
- absolute digitizer HID works
- browser-reported logical screen metrics explain the correct absolute mapping
- `window_bounds.screen` now returns the data needed for that mapping
- `scripts/e2e-hid.mjs` is down to a single remaining failure

The remaining issue is not UART, BLE, HalfPipe, or absolute HID viability. It is the browser-automation layer still perturbing layout via CDP.
