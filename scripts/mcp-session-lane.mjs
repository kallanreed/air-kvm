#!/usr/bin/env node
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const mcpDir = path.join(repoRoot, 'mcp');

const serialPort = process.env.AIRKVM_SERIAL_PORT || '/dev/cu.usbserial-0001';
const lane = process.argv[2] || 'mixed';
const iterations = Number.parseInt(process.argv[3] || '1', 10);
const sessionTimeoutMs = Number.parseInt(process.env.AIRKVM_TOOL_TIMEOUT_MS || '120000', 10);

if (!['browser', 'hid', 'mixed'].includes(lane)) {
  console.error('usage: node scripts/mcp-session-lane.mjs <browser|hid|mixed> [iterations]');
  process.exit(1);
}

if (!Number.isInteger(iterations) || iterations <= 0) {
  console.error('iterations must be a positive integer');
  process.exit(1);
}

function callSpec(name, args = {}) {
  return { name, args };
}

function sequenceForLane(selectedLane) {
  if (selectedLane === 'browser') {
    return [
      callSpec('airkvm_list_tabs', {}),
      callSpec('airkvm_open_tab', { url: 'https://example.com/' }),
      callSpec('airkvm_exec_js_tab', { script: 'return document.title;' }),
      callSpec('airkvm_screenshot_tab', { max_width: 1280, max_height: 720, quality: 0.6 })
    ];
  }
  if (selectedLane === 'hid') {
    return [
      callSpec('airkvm_send', { command: { type: 'mouse.move_rel', dx: 20, dy: 10 } }),
      callSpec('airkvm_send', { command: { type: 'key.tap', key: 'Enter' } }),
      callSpec('airkvm_send', { command: { type: 'key.tap', key: 'Shift' } })
    ];
  }
  return [
    callSpec('airkvm_list_tabs', {}),
    callSpec('airkvm_send', { command: { type: 'mouse.move_rel', dx: 20, dy: 10 } }),
    callSpec('airkvm_send', { command: { type: 'key.tap', key: 'Enter' } }),
    callSpec('airkvm_screenshot_tab', { max_width: 1280, max_height: 720, quality: 0.6 })
  ];
}

function run() {
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['src/index.js'], {
      cwd: mcpDir,
      env: {
        ...process.env,
        AIRKVM_SERIAL_PORT: serialPort
      }
    });

    let nextId = 1;
    const waiting = new Map();
    let stdoutCarry = '';
    let finished = false;
    let sessionTimer = null;

    function finish(err, result) {
      if (finished) return;
      finished = true;
      if (sessionTimer) clearTimeout(sessionTimer);
      const done = () => {
        if (err) reject(err);
        else resolve(result);
      };
      child.once('exit', done);
      child.kill('SIGINT');
      setTimeout(() => child.kill('SIGKILL'), 1000);
    }

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdoutCarry += chunk;
      let newline = stdoutCarry.indexOf('\n');
      while (newline !== -1) {
        const line = stdoutCarry.slice(0, newline).trim();
        stdoutCarry = stdoutCarry.slice(newline + 1);
        if (line) {
          try {
            const msg = JSON.parse(line);
            if (typeof msg.id !== 'undefined' && waiting.has(msg.id)) {
              const resolveWaiter = waiting.get(msg.id);
              waiting.delete(msg.id);
              resolveWaiter(msg);
            }
          } catch {
            // Ignore malformed output lines.
          }
        }
        newline = stdoutCarry.indexOf('\n');
      }
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => process.stderr.write(chunk));
    child.on('error', (err) => finish(err));
    child.on('exit', (code) => {
      if (!finished && code !== 0 && code !== null) {
        finish(new Error(`mcp_exit_${code}`));
      }
    });

    function rpc(method, params = {}) {
      return new Promise((resolveRpc) => {
        const id = nextId++;
        waiting.set(id, resolveRpc);
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });
    }

    (async () => {
      if (Number.isInteger(sessionTimeoutMs) && sessionTimeoutMs > 0) {
        sessionTimer = setTimeout(() => finish(new Error('session_timeout')), sessionTimeoutMs);
      }
      const init = await rpc('initialize', {});
      if (!init?.result) throw new Error('initialize_failed');

      const sequence = sequenceForLane(lane);
      const summary = {
        lane,
        iterations,
        passed: 0,
        failed: 0,
        failures: []
      };

      for (let i = 1; i <= iterations; i += 1) {
        let iterOk = true;
        for (const step of sequence) {
          const res = await rpc('tools/call', {
            name: step.name,
            arguments: step.args
          });
          if (res?.error || res?.result?.isError) {
            iterOk = false;
            summary.failures.push({
              iteration: i,
              tool: step.name,
              error: res?.error || res?.result?.content?.[0]?.text || 'unknown_error'
            });
            break;
          }
        }
        if (iterOk) summary.passed += 1;
        else summary.failed += 1;
      }

      process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
      finish(null, summary);
    })().catch((err) => finish(err));
  });
}

run().catch((err) => {
  console.error(String(err?.message || err));
  process.exit(1);
});
