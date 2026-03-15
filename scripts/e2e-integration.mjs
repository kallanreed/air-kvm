#!/usr/bin/env node
/**
 * E2E integration test suite for AirKVM extension tools.
 *
 * Tests every extension-facing tool against live hardware:
 *   MCP → UART → firmware → BLE → extension → browser
 *
 * Runs ALL tests and reports detailed per-assertion output regardless of failures.
 *
 * Usage:
 *   AIRKVM_SERIAL_PORT=/dev/cu.usbserial-0001 node scripts/e2e-integration.mjs
 *
 * Env vars:
 *   AIRKVM_SERIAL_PORT        UART device (default: /dev/cu.usbserial-0001)
 *   AIRKVM_TOOL_TIMEOUT_MS    per-tool timeout ms (default: 30000)
 *   AIRKVM_E2E_TEST_URL       URL to open for browser tests (default: https://example.com)
 *
 * Screenshots are always saved to temp/ and validated from disk.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const mcpDir = path.join(repoRoot, 'mcp');
const tempDir = path.join(repoRoot, 'temp');

const serialPort = process.env.AIRKVM_SERIAL_PORT || '/dev/cu.usbserial-0001';
const toolTimeoutMs = parseInt(process.env.AIRKVM_TOOL_TIMEOUT_MS || '30000', 10);
const testUrl = process.env.AIRKVM_E2E_TEST_URL || 'https://example.com';

// ─── JPEG utilities ──────────────────────────────────────────────────────────

/** Return { width, height } from a JPEG buffer, or null if unparseable. */
function parseJpegDimensions(buf) {
  if (!buf || buf.length < 4) return null;
  if (buf[0] !== 0xFF || buf[1] !== 0xD8) return null; // not JPEG
  let i = 2;
  while (i < buf.length - 8) {
    if (buf[i] !== 0xFF) break;
    const marker = buf[i + 1];
    const segLen = (buf[i + 2] << 8) | buf[i + 3];
    // SOF markers that contain dimensions: C0-C3, C5-C7, C9-CB, CD-CF
    const isSOF = (marker >= 0xC0 && marker <= 0xC3)
               || (marker >= 0xC5 && marker <= 0xC7)
               || (marker >= 0xC9 && marker <= 0xCB)
               || (marker >= 0xCD && marker <= 0xCF);
    if (isSOF && i + 8 < buf.length) {
      // SOF segment: [precision(1), height(2), width(2), components(1)]
      return {
        height: (buf[i + 5] << 8) | buf[i + 6],
        width:  (buf[i + 7] << 8) | buf[i + 8],
      };
    }
    i += 2 + segLen;
  }
  return null;
}

/**
 * Save a base64 JPEG to disk, read it back, and return validation results.
 * Returns { savedPath, fileSizeBytes, dims: {width,height}|null, validMagic }
 */
function saveAndValidateJpeg(base64, filename) {
  mkdirSync(tempDir, { recursive: true });
  const savedPath = path.join(tempDir, filename);
  const buf = Buffer.from(base64, 'base64');
  writeFileSync(savedPath, buf);
  const disk = readFileSync(savedPath);
  const validMagic = disk[0] === 0xFF && disk[1] === 0xD8 && disk[2] === 0xFF;
  const dims = parseJpegDimensions(disk);
  return { savedPath, fileSizeBytes: disk.length, dims, validMagic };
}

// ─── Colours ────────────────────────────────────────────────────────────────

const isTTY = process.stdout.isTTY;
const c = {
  green: (s) => isTTY ? `\x1b[32m${s}\x1b[0m` : s,
  red:   (s) => isTTY ? `\x1b[31m${s}\x1b[0m` : s,
  cyan:  (s) => isTTY ? `\x1b[36m${s}\x1b[0m` : s,
  bold:  (s) => isTTY ? `\x1b[1m${s}\x1b[0m` : s,
  dim:   (s) => isTTY ? `\x1b[2m${s}\x1b[0m` : s,
};

// ─── Test runner ─────────────────────────────────────────────────────────────

class TestSuite {
  constructor() {
    this._results = [];    // { name, assertions: [{label, ok, got, expected}], error, rawResponse }
    this._currentTest = null;
  }

  begin(name) {
    this._currentTest = { name, assertions: [], error: null, rawResponse: null, skipped: false };
  }

  setRaw(raw) {
    if (this._currentTest) this._currentTest.rawResponse = raw;
  }

  /** Assert a boolean condition. `got`/`expected` are shown on failure. */
  assert(condition, label, got, expected) {
    const ok = Boolean(condition);
    const entry = { label, ok };
    if (!ok) {
      entry.got = got;
      entry.expected = expected;
    }
    this._currentTest.assertions.push(entry);
    return ok;
  }

  /** Shorthand: assert that `val` is truthy, show val on failure. */
  check(condition, label, val) {
    return this.assert(condition, label, val, '(truthy)');
  }

  /** Mark test as failed with an exception message. */
  fail(err) {
    if (this._currentTest) this._currentTest.error = String(err?.message || err);
  }

  end() {
    if (!this._currentTest) return;
    this._results.push(this._currentTest);
    const t = this._currentTest;
    const passed = !t.error && t.assertions.every((a) => a.ok);
    const icon = passed ? c.green('✓') : c.red('✗');
    console.log(`\n${icon} ${c.bold(t.name)}`);
    for (const a of t.assertions) {
      if (a.ok) {
        console.log(`    ${c.green('✓')} ${a.label}`);
      } else {
        console.log(`    ${c.red('✗')} ${a.label}`);
        if (a.got !== undefined)      console.log(`        got:      ${c.dim(JSON.stringify(a.got))}`);
        if (a.expected !== undefined) console.log(`        expected: ${c.dim(String(a.expected))}`);
      }
    }
    if (t.error) {
      console.log(`    ${c.red('error:')} ${t.error}`);
    }
    if (t.rawResponse !== null) {
      const rawStr = typeof t.rawResponse === 'string'
        ? t.rawResponse
        : JSON.stringify(t.rawResponse, null, 2);
      const lines = rawStr.split('\n').slice(0, 20);
      if (rawStr.split('\n').length > 20) lines.push('  ...(truncated)');
      console.log(`    ${c.dim('raw: ' + lines.join('\n         '))}`);
    }
    this._currentTest = null;
  }

  summary() {
    const total = this._results.length;
    const failed = this._results.filter(
      (t) => t.error || t.assertions.some((a) => !a.ok)
    ).length;
    const passed = total - failed;
    console.log('\n' + '─'.repeat(60));
    console.log(c.bold(`Results: ${passed}/${total} passed`));
    if (failed > 0) {
      console.log(c.red(`         ${failed} FAILED`));
      for (const t of this._results) {
        const ok = !t.error && t.assertions.every((a) => a.ok);
        if (!ok) console.log(`  ${c.red('✗')} ${t.name}${t.error ? ' — ' + t.error : ''}`);
      }
    }
    console.log('─'.repeat(60));
    return failed === 0;
  }
}

// ─── MCP JSON-RPC harness ────────────────────────────────────────────────────

function spawnMcp() {
  const child = spawn('node', ['src/index.js'], {
    cwd: mcpDir,
    env: { ...process.env, AIRKVM_SERIAL_PORT: serialPort },
  });

  const waiting = new Map();
  let carry = '';
  let nextId = 1;

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    carry += chunk;
    let nl = carry.indexOf('\n');
    while (nl !== -1) {
      const line = carry.slice(0, nl).trim();
      carry = carry.slice(nl + 1);
      if (line) {
        try {
          const msg = JSON.parse(line);
          if (msg.id !== undefined && waiting.has(msg.id)) {
            const resolve = waiting.get(msg.id);
            waiting.delete(msg.id);
            resolve(msg);
          }
        } catch { /* non-JSON log lines */ }
      }
      nl = carry.indexOf('\n');
    }
  });

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => process.stderr.write(chunk));

  function stop() {
    return new Promise((done) => {
      child.once('exit', done);
      child.kill('SIGINT');
      setTimeout(() => child.kill('SIGKILL'), 800);
    });
  }

  function rpc(method, params = {}) {
    const id = nextId++;
    return new Promise((res, rej) => {
      const timer = setTimeout(
        () => { waiting.delete(id); rej(new Error(`timeout:${method}`)); },
        toolTimeoutMs
      );
      waiting.set(id, (msg) => { clearTimeout(timer); res(msg); });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  function tool(name, args = {}) {
    return rpc('tools/call', { name, arguments: args });
  }

  /** Parse MCP tool response into { ok, data, rawText } */
  function parse(response) {
    const rawText = response?.result?.content?.[0]?.text ?? '';
    let data;
    try { data = JSON.parse(rawText); } catch { data = { _unparseable: rawText }; }
    const ok = !data?.error && !response?.isError;
    return { ok, data, rawText };
  }

  return { rpc, tool, parse, stop };
}

// ─── Helper assertions ────────────────────────────────────────────────────────

function assertTabShape(suite, tab, label = 'tab') {
  suite.assert(Number.isInteger(tab?.id), `${label}.id is integer`, tab?.id, 'integer');
  suite.assert(Number.isInteger(tab?.window_id), `${label}.window_id is integer`, tab?.window_id, 'integer');
  suite.assert(typeof tab?.url === 'string', `${label}.url is string`, tab?.url, 'string');
  suite.assert(typeof tab?.title === 'string', `${label}.title is string`, tab?.title, 'string');
  suite.assert(typeof tab?.active === 'boolean', `${label}.active is boolean`, tab?.active, 'boolean');
}

function assertBoundsShape(suite, bounds, label = 'bounds') {
  suite.assert(bounds !== null && typeof bounds === 'object', `${label} is object`, bounds, 'object');
  suite.assert(Number.isInteger(bounds?.width) && bounds.width > 0, `${label}.width is positive integer`, bounds?.width, '>0 integer');
  suite.assert(Number.isInteger(bounds?.height) && bounds.height > 0, `${label}.height is positive integer`, bounds?.height, '>0 integer');
}

// ─── Tests ────────────────────────────────────────────────────────────────────

async function runTests(mcp, suite) {
  let openedTabId = null;   // filled by open_tab, used by subsequent tests
  const reqNum = (() => { let n = 0; return () => `e2e-${++n}`; })();

  // ── 1. Firmware: state.request ────────────────────────────────────────────
  suite.begin('fw: state_request');
  try {
    const res = mcp.parse(await mcp.tool('airkvm_state_request'));
    suite.setRaw(res.data);
    suite.assert(res.ok, 'no error', res.data?.error, undefined);
    suite.assert(res.data?.type === 'state' || 'ble_connected' in (res.data ?? {}),
      'response looks like state', res.data?.type, '"state" or has ble_connected');
  } catch (e) { suite.fail(e); }
  suite.end();

  // ── 2. Firmware: fw.version.request ──────────────────────────────────────
  suite.begin('fw: fw_version_request');
  try {
    const res = mcp.parse(await mcp.tool('airkvm_fw_version_request'));
    suite.setRaw(res.data);
    suite.assert(res.ok, 'no error', res.data?.error, undefined);
    suite.check(typeof res.data?.version === 'string' || res.data?.fw_version !== undefined,
      'has version field', res.data);
  } catch (e) { suite.fail(e); }
  suite.end();

  // ── 3. list_tabs (baseline) ───────────────────────────────────────────────
  suite.begin('list_tabs: baseline response shape');
  let baselineTabs = [];
  try {
    const res = mcp.parse(await mcp.tool('airkvm_list_tabs', { request_id: reqNum() }));
    suite.setRaw(res.data);
    suite.assert(res.ok, 'no error', res.data?.error, undefined);
    suite.assert(Array.isArray(res.data?.tabs), 'data.tabs is array', res.data?.tabs, 'array');
    baselineTabs = res.data?.tabs ?? [];
    if (baselineTabs.length > 0) {
      assertTabShape(suite, baselineTabs[0], 'tabs[0]');
    } else {
      suite.check(true, '(no tabs open yet — shape checks skipped)');
    }
    suite.check(res.data?.type === 'tabs.list', 'data.type is "tabs.list"', res.data?.type);
  } catch (e) { suite.fail(e); }
  suite.end();

  // ── 4. open_tab ───────────────────────────────────────────────────────────
  suite.begin(`open_tab: ${testUrl}`);
  try {
    const res = mcp.parse(await mcp.tool('airkvm_open_tab', {
      request_id: reqNum(),
      url: testUrl,
      active: true,
    }));
    suite.setRaw(res.data);
    suite.assert(res.ok, 'no error', res.data?.error, undefined);
    suite.assert(res.data?.type === 'tab.open', 'data.type is "tab.open"', res.data?.type, '"tab.open"');
    assertTabShape(suite, res.data?.tab, 'data.tab');
    suite.assert(
      String(res.data?.tab?.url || '').includes(new URL(testUrl).hostname),
      'tab.url contains hostname',
      res.data?.tab?.url,
      `contains ${new URL(testUrl).hostname}`
    );
    suite.check(
      typeof res.data?.tab?.title === 'string' && res.data.tab.title.length > 0,
      'tab.title is non-empty after load',
      res.data?.tab?.title
    );
    openedTabId = res.data?.tab?.id ?? null;
  } catch (e) { suite.fail(e); }
  suite.end();

  // ── 5. list_tabs after open ───────────────────────────────────────────────
  suite.begin('list_tabs: confirms opened tab is visible');
  try {
    const res = mcp.parse(await mcp.tool('airkvm_list_tabs', { request_id: reqNum() }));
    suite.setRaw(res.data);
    suite.assert(res.ok, 'no error', res.data?.error, undefined);
    suite.assert(Array.isArray(res.data?.tabs), 'data.tabs is array', res.data?.tabs, 'array');
    const tabs = res.data?.tabs ?? [];
    suite.assert(tabs.length > baselineTabs.length, 'tab count increased', tabs.length, `> ${baselineTabs.length}`);
    const found = openedTabId != null
      ? tabs.find((t) => t.id === openedTabId)
      : tabs.find((t) => String(t.url).includes(new URL(testUrl).hostname));
    suite.assert(Boolean(found), 'opened tab appears in list', found, `tab with id=${openedTabId}`);
    if (found) assertTabShape(suite, found, 'found tab');
  } catch (e) { suite.fail(e); }
  suite.end();

  // ── 6. window_bounds (no tab_id) ─────────────────────────────────────────
  suite.begin('window_bounds: no tab_id (uses active tab)');
  try {
    const res = mcp.parse(await mcp.tool('airkvm_window_bounds', { request_id: reqNum() }));
    suite.setRaw(res.data);
    suite.assert(res.ok, 'no error', res.data?.error, undefined);
    suite.assert(res.data?.type === 'window.bounds', 'data.type is "window.bounds"', res.data?.type, '"window.bounds"');
    suite.assert(Number.isInteger(res.data?.tab_id), 'data.tab_id is integer', res.data?.tab_id, 'integer');
    assertBoundsShape(suite, res.data?.bounds);
    suite.check(
      res.data?.bounds?.window_state === undefined || typeof res.data.bounds.window_state === 'string',
      'bounds.window_state is string if present',
      res.data?.bounds?.window_state
    );
  } catch (e) { suite.fail(e); }
  suite.end();

  // ── 7. window_bounds (with tab_id) ───────────────────────────────────────
  if (openedTabId != null) {
    suite.begin(`window_bounds: with tab_id=${openedTabId}`);
    try {
      const res = mcp.parse(await mcp.tool('airkvm_window_bounds', {
        request_id: reqNum(),
        tab_id: openedTabId,
      }));
      suite.setRaw(res.data);
      suite.assert(res.ok, 'no error', res.data?.error, undefined);
      suite.assert(res.data?.tab_id === openedTabId, 'tab_id matches request', res.data?.tab_id, openedTabId);
      assertBoundsShape(suite, res.data?.bounds);
    } catch (e) { suite.fail(e); }
    suite.end();
  }

  // ── 8. dom_snapshot ───────────────────────────────────────────────────────
  suite.begin('dom_snapshot: response shape and summary');
  try {
    const res = mcp.parse(await mcp.tool('airkvm_dom_snapshot', { request_id: reqNum() }));
    suite.setRaw({ ...res.data, snapshot: res.data?.snapshot ? '(present)' : null });
    suite.assert(res.ok, 'no error', res.data?.error, undefined);
    const snap = res.data?.snapshot;
    suite.assert(snap && typeof snap === 'object', 'data.snapshot is object', snap, 'object');
    suite.assert(snap?.type === 'dom.snapshot', 'snapshot.type is "dom.snapshot"', snap?.type, '"dom.snapshot"');
    suite.assert(Number.isInteger(snap?.tabId), 'snapshot.tabId is integer', snap?.tabId, 'integer');
    const summary = snap?.summary;
    suite.assert(summary && typeof summary === 'object', 'snapshot.summary is object', summary, 'object');
    suite.assert(Array.isArray(summary?.actionable), 'summary.actionable is array', summary?.actionable, 'array');
    suite.assert(Number.isInteger(summary?.frame_count), 'summary.frame_count is integer', summary?.frame_count, 'integer');
    suite.assert(Array.isArray(summary?.frames), 'summary.frames is array', summary?.frames, 'array');
    suite.assert(typeof summary?.url === 'string', 'summary.url is string', summary?.url, 'string');
    suite.check(summary?.actionable.length > 0, 'has actionable elements', summary?.actionable.length);
  } catch (e) { suite.fail(e); }
  suite.end();

  // ── 9–14. exec_js_tab ────────────────────────────────────────────────────

  async function execJs(script, tabId = null) {
    const args = { request_id: reqNum(), script };
    if (Number.isInteger(tabId)) args.tab_id = tabId;
    return mcp.parse(await mcp.tool('airkvm_exec_js_tab', args));
  }

  function assertExecResult(res, suite, { expectOk = true, expectType, expectValue, label = '' } = {}) {
    const prefix = label ? `${label}: ` : '';
    suite.setRaw(res.data);
    if (expectOk) {
      suite.assert(res.ok, `${prefix}no error`, res.data?.error, undefined);
      suite.assert(res.data?.type === 'js.exec.result', `${prefix}type is "js.exec.result"`, res.data?.type, '"js.exec.result"');
      suite.assert(typeof res.data?.value_json === 'string', `${prefix}value_json is string`, typeof res.data?.value_json, 'string');
      if (expectType !== undefined) {
        suite.assert(res.data?.value_type === expectType, `${prefix}value_type`, res.data?.value_type, expectType);
      }
      if (expectValue !== undefined) {
        let parsed;
        try { parsed = JSON.parse(res.data?.value_json); } catch { parsed = res.data?.value_json; }
        suite.assert(parsed === expectValue, `${prefix}value`, parsed, expectValue);
      }
    } else {
      // Expect an error response
      suite.assert(!res.ok || res.data?.type === 'js.exec.error',
        `${prefix}returns error response`, res.data?.type, 'js.exec.error or ok=false');
    }
  }

  suite.begin('exec_js_tab: arithmetic (1 + 1)');
  try {
    const res = await execJs('1 + 1', openedTabId);
    assertExecResult(res, suite, { expectType: 'number', expectValue: 2, label: '1+1' });
  } catch (e) { suite.fail(e); }
  suite.end();

  suite.begin('exec_js_tab: string (document.location.hostname)');
  try {
    const res = await execJs('document.location.hostname', openedTabId);
    suite.setRaw(res.data);
    suite.assert(res.ok, 'no error', res.data?.error, undefined);
    suite.assert(res.data?.value_type === 'string', 'value_type is "string"', res.data?.value_type, 'string');
    let hostname;
    try { hostname = JSON.parse(res.data?.value_json); } catch { hostname = null; }
    suite.assert(typeof hostname === 'string' && hostname.length > 0,
      'hostname is non-empty string', hostname, 'non-empty string');
    suite.check(
      hostname === new URL(testUrl).hostname,
      `hostname matches test URL (${new URL(testUrl).hostname})`,
      hostname
    );
  } catch (e) { suite.fail(e); }
  suite.end();

  suite.begin('exec_js_tab: null literal');
  try {
    const res = await execJs('null', openedTabId);
    suite.setRaw(res.data);
    suite.assert(res.ok, 'no error', res.data?.error, undefined);
    suite.assert(res.data?.value_json === 'null', 'value_json is "null"', res.data?.value_json, '"null"');
  } catch (e) { suite.fail(e); }
  suite.end();

  suite.begin('exec_js_tab: object literal');
  try {
    const res = await execJs('({ answer: 42 })', openedTabId);
    suite.setRaw(res.data);
    suite.assert(res.ok, 'no error', res.data?.error, undefined);
    suite.assert(res.data?.value_type === 'object', 'value_type is "object"', res.data?.value_type, 'object');
    let parsed;
    try { parsed = JSON.parse(res.data?.value_json); } catch { parsed = null; }
    suite.assert(parsed?.answer === 42, 'parsed.answer === 42', parsed?.answer, 42);
  } catch (e) { suite.fail(e); }
  suite.end();

  suite.begin('exec_js_tab: boolean');
  try {
    const res = await execJs('typeof document === "object"', openedTabId);
    assertExecResult(res, suite, { expectType: 'boolean', expectValue: true, label: 'typeof document' });
  } catch (e) { suite.fail(e); }
  suite.end();

  suite.begin('exec_js_tab: script error returns error response');
  try {
    const res = await execJs('(() => { throw new Error("deliberate"); })()', openedTabId);
    suite.setRaw(res.data);
    const isErr = !res.ok || res.data?.type === 'js.exec.error';
    suite.assert(isErr, 'error response for thrown exception', res.data?.type, 'js.exec.error');
  } catch (e) { suite.fail(e); }
  suite.end();

  // ── 15. screenshot_tab: capture, save, validate from disk ───────────────
  // First confirm the page has the right content via JS so we know what to expect.
  suite.begin('screenshot_tab: page content check before capture');
  let pageH1 = null;
  try {
    const res = await execJs(
      'document.querySelector("h1")?.textContent?.trim() ?? "(no h1)"',
      openedTabId
    );
    suite.setRaw(res.data);
    suite.assert(res.ok, 'no error', res.data?.error, undefined);
    try { pageH1 = JSON.parse(res.data?.value_json); } catch { pageH1 = null; }
    suite.assert(typeof pageH1 === 'string' && pageH1.length > 0,
      'page has an h1 element', pageH1, 'non-empty string');
    const expectedH1 = new URL(testUrl).hostname === 'example.com' ? 'Example Domain' : null;
    if (expectedH1) {
      suite.assert(pageH1 === expectedH1,
        `h1 text is "${expectedH1}"`, pageH1, expectedH1);
    }
  } catch (e) { suite.fail(e); }
  suite.end();

  suite.begin('screenshot_tab: captures and saves valid JPEG');
  try {
    const maxWidth = 1280;
    const maxHeight = 720;
    const res = mcp.parse(await mcp.tool('airkvm_screenshot_tab', {
      request_id: reqNum(),
      ...(openedTabId != null ? { tab_id: openedTabId } : {}),
      max_width: maxWidth,
      max_height: maxHeight,
      quality: 0.6,
    }));
    suite.setRaw({ ...res.data, base64: res.data?.base64 ? `(${res.data.base64.length} chars)` : null });
    suite.assert(res.ok, 'no error', res.data?.error, undefined);
    suite.assert(res.data?.source === 'tab', 'source is "tab"', res.data?.source, '"tab"');
    suite.assert(res.data?.mime === 'image/jpeg', 'mime is "image/jpeg"', res.data?.mime, '"image/jpeg"');
    suite.assert(typeof res.data?.base64 === 'string' && res.data.base64.length > 1000,
      'base64 is non-trivial string', `${res.data?.base64?.length} chars`, '> 1000 chars');
    if (res.data?.base64) {
      const { savedPath, fileSizeBytes, dims, validMagic } = saveAndValidateJpeg(
        res.data.base64, 'e2e-screenshot-tab.jpg'
      );
      suite.assert(validMagic, 'file on disk has JPEG magic bytes (FF D8 FF)', validMagic, true);
      suite.assert(fileSizeBytes > 1000, `file size is substantial (${fileSizeBytes} bytes)`, fileSizeBytes, '> 1000');
      if (dims) {
        suite.assert(dims.width > 0 && dims.width <= maxWidth,
          `image width within bounds (${dims.width}px ≤ ${maxWidth})`, dims.width, `≤ ${maxWidth}`);
        suite.assert(dims.height > 0 && dims.height <= maxHeight,
          `image height within bounds (${dims.height}px ≤ ${maxHeight})`, dims.height, `≤ ${maxHeight}`);
      } else {
        suite.check(false, 'could not parse JPEG dimensions from saved file');
      }
      suite.check(true, `saved to ${savedPath}`);
      if (pageH1) suite.check(true, `page had h1="${pageH1}" at time of capture`);
    }
  } catch (e) { suite.fail(e); }
  suite.end();
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log(c.bold('\nAirKVM E2E Integration Test Suite'));
  console.log(`  serial port : ${serialPort}`);
  console.log(`  test URL    : ${testUrl}`);
  console.log(`  timeout     : ${toolTimeoutMs}ms per tool`);
  console.log(`  screenshots : always saved to temp/`);
  console.log('');

  const mcp = spawnMcp();
  const suite = new TestSuite();

  try {
    const init = await mcp.rpc('initialize', {});
    if (!init.result) throw new Error('MCP initialize failed');
    console.log(c.dim('  MCP initialized'));

    await runTests(mcp, suite);
  } finally {
    await mcp.stop();
  }

  const allPassed = suite.summary();
  process.exit(allPassed ? 0 : 1);
}

main().catch((err) => {
  console.error(c.red(`\nFatal: ${err?.message || err}`));
  process.exit(1);
});
