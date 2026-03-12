import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCommandForTool,
  isKnownTool,
  isStructuredTool
} from '../src/tooling.js';

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

test('isKnownTool and isStructuredTool classify tools correctly', () => {
  assert.equal(isKnownTool('airkvm_send'), true);
  assert.equal(isKnownTool('airkvm_dom_snapshot'), true);
  assert.equal(isKnownTool('airkvm_list_tabs'), true);
  assert.equal(isKnownTool('airkvm_window_bounds'), true);
  assert.equal(isKnownTool('airkvm_open_tab'), true);
  assert.equal(isKnownTool('airkvm_exec_js_tab'), true);
  assert.equal(isKnownTool('nope'), false);
  assert.equal(isStructuredTool('airkvm_send'), false);
  assert.equal(isStructuredTool('airkvm_list_tabs'), true);
  assert.equal(isStructuredTool('airkvm_window_bounds'), true);
  assert.equal(isStructuredTool('airkvm_open_tab'), true);
  assert.equal(isStructuredTool('airkvm_exec_js_tab'), true);
  assert.equal(isStructuredTool('airkvm_screenshot_tab'), true);
});

