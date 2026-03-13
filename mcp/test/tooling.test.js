import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCommandForTool,
  validateToolArgs,
} from '../src/protocol.js';

test('buildCommandForTool maps screenshot tools to screenshot.request with bin encoding', () => {
  const tab = buildCommandForTool('airkvm_screenshot_tab', {
    request_id: 'r1',
    max_width: 800,
    max_height: 450,
    quality: 0.5,
    max_chars: 70000,
    tab_id: 123
  });
  const desktop = buildCommandForTool('airkvm_screenshot_desktop', { request_id: 'r2' });
  const desktopWithDelay = buildCommandForTool('airkvm_screenshot_desktop', {
    request_id: 'r3',
    desktop_delay_ms: 600
  });
  const tabs = buildCommandForTool('airkvm_list_tabs', { request_id: 't1' });
  const windowBounds = buildCommandForTool('airkvm_window_bounds', { request_id: 'wb-1', tab_id: 9 });
  const openTab = buildCommandForTool('airkvm_open_tab', {
    request_id: 'tab-1',
    url: 'https://example.com/path',
    active: false
  });
  const exec = buildCommandForTool('airkvm_exec_js_tab', {
    request_id: 'js-1',
    script: 'return document.title;',
    tab_id: 7,
    timeout_ms: 500,
    max_result_chars: 256
  });

  assert.deepEqual(tab, {
    type: 'screenshot.request',
    source: 'tab',
    request_id: 'r1',
    max_width: 800,
    max_height: 450,
    quality: 0.5,
    max_chars: 70000,
    tab_id: 123,
    encoding: 'bin'
  });
  assert.deepEqual(desktop, { type: 'screenshot.request', source: 'desktop', request_id: 'r2', encoding: 'bin' });
  assert.deepEqual(desktopWithDelay, {
    type: 'screenshot.request',
    source: 'desktop',
    request_id: 'r3',
    desktop_delay_ms: 600,
    encoding: 'bin'
  });
  assert.deepEqual(tabs, { type: 'tabs.list.request', request_id: 't1' });
  assert.deepEqual(windowBounds, { type: 'window.bounds.request', request_id: 'wb-1', tab_id: 9 });
  assert.deepEqual(openTab, {
    type: 'tab.open.request',
    request_id: 'tab-1',
    url: 'https://example.com/path',
    active: false
  });
  assert.deepEqual(exec, {
    type: 'js.exec.request',
    request_id: 'js-1',
    script: 'return document.title;',
    tab_id: 7,
    timeout_ms: 500,
    max_result_chars: 256
  });
});

test('buildCommandForTool returns null for unknown tools', () => {
  assert.equal(buildCommandForTool('nope'), null);
  assert.equal(buildCommandForTool(''), null);
  assert.equal(buildCommandForTool(undefined), null);
});

test('validateToolArgs returns ok for valid args', () => {
  assert.deepEqual(validateToolArgs('airkvm_open_tab', { request_id: 'r1', url: 'https://example.com' }), { ok: true });
  assert.deepEqual(validateToolArgs('airkvm_exec_js_tab', { request_id: 'r1', script: 'return 1;' }), { ok: true });
  assert.deepEqual(validateToolArgs('airkvm_list_tabs', {}), { ok: true });
});

test('validateToolArgs rejects missing required fields', () => {
  assert.deepEqual(validateToolArgs('airkvm_open_tab', { request_id: 'r1' }), { ok: false, error: 'missing_required_field:url' });
  assert.deepEqual(validateToolArgs('airkvm_exec_js_tab', { request_id: 'r1' }), { ok: false, error: 'missing_required_field:script' });
  assert.deepEqual(validateToolArgs('airkvm_open_tab', { url: 'https://example.com' }), { ok: false, error: 'missing_required_field:request_id' });
});

test('validateToolArgs rejects wrong types', () => {
  assert.deepEqual(validateToolArgs('airkvm_open_tab', { request_id: 42, url: 'https://x.com' }), { ok: false, error: 'invalid_type:request_id' });
  assert.deepEqual(validateToolArgs('airkvm_screenshot_tab', { max_width: 1.5 }), { ok: false, error: 'invalid_type:max_width' });
  assert.deepEqual(validateToolArgs('airkvm_screenshot_tab', { quality: 'high' }), { ok: false, error: 'invalid_type:quality' });
});

test('validateToolArgs rejects out-of-range values', () => {
  assert.deepEqual(validateToolArgs('airkvm_exec_js_tab', { request_id: 'r', script: 's', timeout_ms: 10 }), { ok: false, error: 'out_of_range:timeout_ms' });
  assert.deepEqual(validateToolArgs('airkvm_exec_js_tab', { request_id: 'r', script: 's', timeout_ms: 9999 }), { ok: false, error: 'out_of_range:timeout_ms' });
});

test('validateToolArgs rejects strings violating length constraints', () => {
  assert.deepEqual(validateToolArgs('airkvm_exec_js_tab', { request_id: 'r', script: '' }), { ok: false, error: 'too_short:script' });
  assert.deepEqual(validateToolArgs('airkvm_open_tab', { request_id: 'r', url: 'x'.repeat(2049) }), { ok: false, error: 'too_long:url' });
});

test('validateToolArgs rejects invalid enum values', () => {
  assert.deepEqual(validateToolArgs('airkvm_screenshot_tab', { encoding: 'base64' }), { ok: false, error: 'invalid_enum:encoding' });
});

test('buildCommandForTool throws on invalid args', () => {
  assert.throws(() => buildCommandForTool('airkvm_open_tab', { request_id: 'r1' }), /missing_required_field:url/);
  assert.throws(() => buildCommandForTool('airkvm_exec_js_tab', { request_id: 'r', script: '' }), /too_short:script/);
  assert.throws(() => buildCommandForTool('airkvm_screenshot_tab', { max_width: 99999 }), /out_of_range:max_width/);
});

test('validateToolArgs returns unknown_tool for unknown name', () => {
  assert.deepEqual(validateToolArgs('nope', {}), { ok: false, error: 'unknown_tool' });
});

