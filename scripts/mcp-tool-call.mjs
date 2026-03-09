#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const mcpDir = path.join(repoRoot, 'mcp');

const serialPort = process.env.AIRKVM_SERIAL_PORT || '/dev/cu.usbserial-0001';
const timeoutMs = Number.parseInt(process.env.AIRKVM_TOOL_TIMEOUT_MS || '120000', 10);

function positiveIntFromEnv(name, fallback) {
  const value = Number.parseInt(process.env[name] || '', 10);
  if (!Number.isInteger(value) || value <= 0) return fallback;
  return value;
}

function sanitizeForPath(value) {
  return String(value || 'default').replace(/[^a-zA-Z0-9._-]/g, '_');
}

const defaultQueueLockPath = path.join(os.tmpdir(), `airkvm-tool-call-${sanitizeForPath(serialPort)}.lock`);
const queueLockPath = process.env.AIRKVM_TOOL_QUEUE_LOCK || defaultQueueLockPath;
const queuePollMs = positiveIntFromEnv('AIRKVM_TOOL_QUEUE_POLL_MS', 100);
const queueWaitMs = positiveIntFromEnv('AIRKVM_TOOL_QUEUE_WAIT_MS', 120000);
const queueStaleMs = positiveIntFromEnv('AIRKVM_TOOL_QUEUE_STALE_MS', Math.max(queueWaitMs * 2, 300000));
const queueSettleMs = positiveIntFromEnv('AIRKVM_TOOL_QUEUE_SETTLE_MS', 250);

function usage() {
  process.stderr.write(
    'usage: node scripts/mcp-tool-call.mjs <tool_name> [json_args]\n' +
    'example: node scripts/mcp-tool-call.mjs airkvm_screenshot_desktop ' +
    '\'{"request_id":"shot-1","max_width":1280,"max_height":720,"quality":0.6}\'\n'
  );
}

function parseJsonArg(raw, fallback) {
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pidLooksAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function clearStaleLockIfNeeded() {
  try {
    const content = await fs.readFile(queueLockPath, 'utf8');
    const parsed = JSON.parse(content);
    const pid = Number.parseInt(String(parsed?.pid ?? ''), 10);
    const createdAt = Number.parseInt(String(parsed?.created_at ?? ''), 10);
    const ageMs = Number.isInteger(createdAt) ? Date.now() - createdAt : queueStaleMs + 1;
    const pidAlive = pidLooksAlive(pid);
    if (!pidAlive || (!Number.isInteger(pid) && ageMs > queueStaleMs)) {
      await fs.unlink(queueLockPath);
    }
  } catch {
    try {
      const stats = await fs.stat(queueLockPath);
      if (Date.now() - stats.mtimeMs > queueStaleMs) {
        await fs.unlink(queueLockPath);
      }
    } catch {
      // Ignore stat/unlink errors; lock may have disappeared.
    }
  }
}

async function withQueueLock(fn) {
  const start = Date.now();
  let lockHandle = null;
  while (!lockHandle) {
    try {
      lockHandle = await fs.open(queueLockPath, 'wx');
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
      await clearStaleLockIfNeeded();
      if (Date.now() - start > queueWaitMs) {
        throw new Error('tool_queue_timeout');
      }
      await sleep(queuePollMs);
    }
  }

  try {
    await lockHandle.writeFile(JSON.stringify({ pid: process.pid, created_at: Date.now() }));
    const result = await fn();
    // Keep lock slightly longer to avoid UART reopen races across processes.
    if (queueSettleMs > 0) {
      await sleep(queueSettleMs);
    }
    return result;
  } finally {
    try {
      await lockHandle.close();
    } catch {
      // Ignore close failures.
    }
    try {
      await fs.unlink(queueLockPath);
    } catch {
      // Ignore unlink failures.
    }
  }
}

function run() {
  return new Promise((resolve, reject) => {
    const toolName = process.argv[2];
    const args = parseJsonArg(process.argv[3], {});
    if (!toolName) {
      usage();
      reject(new Error('missing_tool_name'));
      return;
    }

    const child = spawn('node', ['src/index.js'], {
      cwd: mcpDir,
      env: {
        ...process.env,
        AIRKVM_SERIAL_PORT: serialPort
      }
    });

    let stdoutCarry = '';
    const waiting = new Map();
    let done = false;
    let timer = null;

    function finish(err, result) {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      const finalize = () => {
        if (err) reject(err);
        else resolve(result);
      };
      child.once('exit', finalize);
      child.kill('SIGINT');
      setTimeout(() => child.kill('SIGKILL'), 800);
    }

    function handleStdoutChunk(chunk) {
      stdoutCarry += chunk;
      let newline = stdoutCarry.indexOf('\n');
      while (newline !== -1) {
        const line = stdoutCarry.slice(0, newline).trim();
        stdoutCarry = stdoutCarry.slice(newline + 1);
        if (line.length > 0) {
          try {
            const msg = JSON.parse(line);
            if (typeof msg.id !== 'undefined' && waiting.has(msg.id)) {
              const resolveWaiter = waiting.get(msg.id);
              waiting.delete(msg.id);
              resolveWaiter(msg);
            }
          } catch {
            // Ignore malformed lines; keep parser resilient.
          }
        }
        newline = stdoutCarry.indexOf('\n');
      }
    }

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', handleStdoutChunk);
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => process.stderr.write(chunk));
    child.on('error', (err) => finish(err));
    child.on('exit', (code) => {
      if (!done && code !== 0 && code !== null) {
        finish(new Error(`mcp_exit_${code}`));
      }
    });

    function rpc(id, method, params = {}) {
      return new Promise((resolveRpc) => {
        waiting.set(id, resolveRpc);
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });
    }

    (async () => {
      const init = await rpc(1, 'initialize', {});
      if (!init.result) throw new Error('initialize_failed');
      const call = await rpc(2, 'tools/call', {
        name: toolName,
        arguments: args
      });
      process.stdout.write(`${JSON.stringify(call.result, null, 2)}\n`);
      finish(null, call.result);
    })().catch((err) => finish(err));

    timer = setTimeout(() => finish(new Error('tool_call_timeout')), timeoutMs);
  });
}

withQueueLock(run).catch((err) => {
  process.stderr.write(`${String(err?.message || err)}\n`);
  process.exit(1);
});
