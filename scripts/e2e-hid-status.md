# E2E HID Status

## Scope
`scripts/e2e-hid.mjs` exercises the full AirKVM path:
1. MCP tool call
2. UART to firmware
3. Firmware BLE bridge
4. Extension service worker automation
5. HID mouse/keyboard injection back through firmware
6. Browser-side validation in the target tab

The current blocker is no longer transport correctness. It is HID targeting accuracy on macOS.

## Current status
Transport and routing are working.

The remaining failure is HID calibration / targeting:
- closed-loop browser-guided targeting works on a controlled calibration popup
- open-loop targeting from the learned model still misses badly on larger moves
- the strongest current hypothesis is nonlinear desktop pointer behavior, likely mouse acceleration or similar OS-side scaling

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
- `busy.changed` in `extension/src/service_worker.js` uses `sendControlViaHalfPipe(..., 'fw')`
- `extension/src/ble_bridge.js` routes that as `hp.sendControl(..., kTarget.FW)`

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

### Browser event `screenX/screenY` are only useful inside page content
The temporary cursor test showed:
- inside page content, browser mouse event coordinates are plausible and useful
- over browser chrome/frame, they are not reliable for desktop-global calibration

So page-content acquisition is the key threshold:
- once the cursor is over page content, browser feedback becomes useful
- before that, browser coordinates are not trustworthy

## Calibration tools added

New extension/MCP tools:
- `airkvm_open_window`
- `airkvm_open_calibration_window`
- `airkvm_calibration_status`

New calibration assets:
- `extension/src/calibration.html`
- `extension/src/calibration.js`
- `scripts/calibration-home.mjs`
- `scripts/calibration-probe.mjs`

Current calibration popup behavior:
- controlled popup window opened by the extension
- live red cursor marker in page content
- four corner targets
- centered `DONE` button
- repeated pointer event reporting
- `DONE` click reporting with actual click coordinates

Service worker calibration state now includes:
- latest pointer event
- `event_count`
- popup layout
- `done_clicked`
- `done_click_event`
- popup window/tab ids

Relevant files:
- `extension/src/service_worker.js`
- `extension/src/calibration.html`
- `extension/src/calibration.js`
- `mcp/src/protocol.js`

## What calibration can do today

### Closed-loop targeting: works
Using browser feedback after each move, the calibration flow can:
- acquire browser content
- touch all four corner targets
- update gain from observed move results
- converge into the `DONE` button and click it

This is now reliable enough to prove:
- HID commands are reaching the browser
- browser-content acquisition is possible
- local correction works

### Open-loop targeting: still fails
This is the most important current result.

After a full four-corner calibration pass, the script now freezes the learned model and tries one single open-loop move to `DONE`, then clicks without correction.

Latest live result:
- starting point before open-loop shot: `847,623`
- `DONE` center: `450,392`
- requested move: `dx=-265`, `dy=-154`
- actual landed/clicked point: `587,480`
- offset from center: `+137`, `+88`
- `done_clicked` stayed `false`

Interpretation:
- the current model is good enough for local closed-loop correction
- it is not good enough to transfer as a global open-loop mapping

## Leading hypothesis
The leading hypothesis is nonlinear pointer behavior on macOS, likely mouse acceleration or a similar OS-side transform.

Why this fits the evidence:
- small local moves behave much more predictably than large moves
- effective gain changes over the course of the path
- a model that works locally near a target does not transfer to a larger open-loop move
- corner-to-corner movement and center targeting do not share one stable global linear scale

Important nuance:
- some short probes looked roughly linear over limited move sizes
- the full corner-walk + open-loop transfer test shows that global linearity does not hold well enough for the real problem

So the working assumption now should be:
- local linearity is usable
- global linearity is not

### Update: pointer acceleration disabled
Pointer acceleration was disabled and the open-loop calibration test was rerun.

What improved:
- the corner-walk gains became much more stable
- the model settled around roughly `x ≈ 0.6875`, `y ≈ 0.6897`

What did not improve:
- the frozen open-loop shot to `DONE` still missed badly

Latest live result with acceleration disabled:
- start before open-loop shot: `831,623`
- `DONE` center: `450,392`
- requested move: `dx=-254`, `dy=-154`
- actual landed/clicked point: `657,517`
- offset from center: `+207`, `+125`
- `done_clicked` stayed `false`

Interpretation:
- disabling acceleration improves local consistency
- it does not make the current four-corner model transfer correctly to a long open-loop move
- so acceleration may be part of the story, but it is not the whole story

## Current state of `scripts/e2e-hid.mjs`

What is true now:
- request/response routing is no longer the blocker
- the test still does not have a reliable focus-and-target strategy for the real tab
- calibration work is happening in `scripts/calibration-home.mjs`, not yet folded back into the real HID test

The real remaining problem is:
- how to transfer calibration knowledge from the controlled popup to the real browser tab without browser feedback during the HID phase

## Recommended next steps

### 1. Treat this as a nonlinear control problem
Do not assume one global X/Y scale.

Instead:
- keep using bounded moves
- update the model continuously from observed results
- expect different behavior for larger moves

### 2. Decide whether true open-loop HID is required
If the real tab cannot provide feedback during HID, then:
- OS acceleration may make precise open-loop targeting fundamentally fragile

Possible escape hatches:
- disable mouse acceleration on the target machine
- use a target-specific browser feedback surface near the final action
- introduce a browser-visible re-anchor step close to the real target before the final click

### 3. If continuing with calibration, test gain vs move magnitude explicitly
`scripts/calibration-probe.mjs` exists for this purpose.

The next valuable experiment would be:
- gather effective gain for multiple move sizes and directions
- see whether large-move behavior diverges enough to model acceleration explicitly

### 4. Absolute positioning now looks more attractive
Based on the current evidence, absolute positioning is a stronger next avenue than continuing to force global open-loop relative motion.

Why:
- relative HID movement is workable in closed loop, but not transferring reliably in open loop
- path history and move magnitude are affecting the result too much
- a stable absolute coordinate model would remove most of the accumulated-path error

The tradeoff:
- absolute HID is more invasive to implement correctly
- it likely requires a different HID descriptor / device model than the current relative mouse path
- calibration still matters, but it becomes a one-time screen mapping problem instead of a continuously drifting relative-control problem

## Files most relevant right now
- `scripts/e2e-hid.mjs`
- `scripts/calibration-home.mjs`
- `scripts/calibration-probe.mjs`
- `extension/src/calibration.html`
- `extension/src/calibration.js`
- `extension/src/service_worker.js`
- `mcp/src/uart.js`
- `mcp/src/protocol.js`
