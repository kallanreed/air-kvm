# Manager Plan

## Objective
Implement Milestone A from `docs/plan.md`: ESP32 advertises BLE HID (HOGP) and command path can inject keyboard/mouse input.

## Steps
1. [x] Read `docs/*.md` and extract goals/current blockers.
2. [x] Verify firmware dependency surface for HID APIs.
3. [x] Add HID controller setup/report map and integrate into app boot.
4. [x] Route command handlers (`mouse.move_rel`, `mouse.click`, `key.tap`) to HID report sends.
5. [ ] Run `pio test -e native` and `pio run -e esp32dev`.
6. [ ] Document remaining live macOS validation steps.

## Notes
- Keep existing custom BLE UART service available while introducing HID, per current transition plan.
