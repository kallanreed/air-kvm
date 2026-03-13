import test from 'node:test';
import assert from 'node:assert/strict';

import { buildCommandForTool, validateToolArgs, isControlTool } from '../src/protocol.js';

test('buildCommandForTool maps airkvm_mouse_move_rel', () => {
  assert.deepEqual(buildCommandForTool('airkvm_mouse_move_rel', { dx: 10, dy: -5 }), { type: 'mouse.move_rel', dx: 10, dy: -5 });
});

test('validateToolArgs rejects airkvm_mouse_move_rel with missing fields', () => {
  assert.deepEqual(validateToolArgs('airkvm_mouse_move_rel', { dx: 1 }), { ok: false, error: 'missing_required_field:dy' });
  assert.deepEqual(validateToolArgs('airkvm_mouse_move_rel', {}), { ok: false, error: 'missing_required_field:dx' });
});

test('validateToolArgs rejects airkvm_mouse_move_rel with non-integer', () => {
  assert.deepEqual(validateToolArgs('airkvm_mouse_move_rel', { dx: 1.5, dy: 0 }), { ok: false, error: 'invalid_type:dx' });
});

test('buildCommandForTool maps airkvm_mouse_move_abs', () => {
  assert.deepEqual(buildCommandForTool('airkvm_mouse_move_abs', { x: 100, y: 200 }), { type: 'mouse.move_abs', x: 100, y: 200 });
});

test('buildCommandForTool maps airkvm_mouse_click', () => {
  assert.deepEqual(buildCommandForTool('airkvm_mouse_click', { button: 'left' }), { type: 'mouse.click', button: 'left' });
});

test('validateToolArgs rejects airkvm_mouse_click with non-string button', () => {
  assert.deepEqual(validateToolArgs('airkvm_mouse_click', { button: 1 }), { ok: false, error: 'invalid_type:button' });
});

test('buildCommandForTool maps airkvm_key_tap', () => {
  assert.deepEqual(buildCommandForTool('airkvm_key_tap', { key: 'Enter' }), { type: 'key.tap', key: 'Enter' });
});

test('validateToolArgs rejects airkvm_key_tap with non-string key', () => {
  assert.deepEqual(validateToolArgs('airkvm_key_tap', { key: 13 }), { ok: false, error: 'invalid_type:key' });
});

test('buildCommandForTool maps airkvm_key_type', () => {
  assert.deepEqual(buildCommandForTool('airkvm_key_type', { text: 'Hello, World!' }), { type: 'key.type', text: 'Hello, World!' });
});

test('validateToolArgs rejects airkvm_key_type with empty text', () => {
  assert.deepEqual(validateToolArgs('airkvm_key_type', { text: '' }), { ok: false, error: 'too_short:text' });
});

test('validateToolArgs rejects airkvm_key_type with text too long', () => {
  assert.deepEqual(validateToolArgs('airkvm_key_type', { text: 'a'.repeat(129) }), { ok: false, error: 'too_long:text' });
});

test('buildCommandForTool maps airkvm_key_type with escape sequences and braces', () => {
  assert.deepEqual(buildCommandForTool('airkvm_key_type', { text: 'user\\tpass\\n' }), { type: 'key.type', text: 'user\\tpass\\n' });
  assert.deepEqual(buildCommandForTool('airkvm_key_type', { text: 'hello{Enter}world' }), { type: 'key.type', text: 'hello{Enter}world' });
});

test('buildCommandForTool maps airkvm_state_request', () => {
  assert.deepEqual(buildCommandForTool('airkvm_state_request', {}), { type: 'state.request' });
});

test('buildCommandForTool maps airkvm_state_set', () => {
  assert.deepEqual(buildCommandForTool('airkvm_state_set', { busy: true }), { type: 'state.set', busy: true });
});

test('validateToolArgs rejects airkvm_state_set with non-boolean', () => {
  assert.deepEqual(validateToolArgs('airkvm_state_set', { busy: 'yes' }), { ok: false, error: 'invalid_type:busy' });
});

test('buildCommandForTool maps airkvm_fw_version_request', () => {
  assert.deepEqual(buildCommandForTool('airkvm_fw_version_request', {}), { type: 'fw.version.request' });
});

test('buildCommandForTool maps airkvm_transfer_reset', () => {
  assert.deepEqual(buildCommandForTool('airkvm_transfer_reset', {}), { type: 'transfer.reset' });
});

test('isControlTool identifies HID and firmware tools', () => {
  assert.equal(isControlTool('airkvm_send'), true);
  assert.equal(isControlTool('airkvm_mouse_move_rel'), true);
  assert.equal(isControlTool('airkvm_mouse_move_abs'), true);
  assert.equal(isControlTool('airkvm_mouse_click'), true);
  assert.equal(isControlTool('airkvm_key_tap'), true);
  assert.equal(isControlTool('airkvm_key_type'), true);
  assert.equal(isControlTool('airkvm_state_request'), true);
  assert.equal(isControlTool('airkvm_state_set'), true);
  assert.equal(isControlTool('airkvm_fw_version_request'), true);
  assert.equal(isControlTool('airkvm_transfer_reset'), true);
  assert.equal(isControlTool('airkvm_list_tabs'), false);
  assert.equal(isControlTool('airkvm_screenshot_tab'), false);
});
