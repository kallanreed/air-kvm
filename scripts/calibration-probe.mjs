#!/usr/bin/env node

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const mcpDir = path.join(repoRoot, 'mcp');

const serialPort = process.env.AIRKVM_SERIAL_PORT || '/dev/cu.usbserial-0001';
const toolTimeoutMs = Number.parseInt(process.env.AIRKVM_TOOL_TIMEOUT_MS || '30000', 10);
const popupWidth = Number.parseInt(process.env.AIRKVM_CAL_WIDTH || '900', 10);
const popupHeight = Number.parseInt(process.env.AIRKVM_CAL_HEIGHT || '700', 10);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function spawnMcp() {
  const child = spawn('node', ['src/index.js'], {
    cwd: mcpDir,
    env: { ...process.env, AIRKVM_SERIAL_PORT: serialPort }
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
            const { resolve } = waiting.get(msg.id);
            waiting.delete(msg.id);
            resolve(msg);
          }
        } catch {}
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
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiting.delete(id);
        reject(new Error(`timeout:${method}`));
      }, toolTimeoutMs);
      waiting.set(id, {
        resolve: (msg) => {
          clearTimeout(timer);
          resolve(msg);
        }
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  async function tool(name, args = {}) {
    const response = await rpc('tools/call', { name, arguments: args });
    const rawText = response?.result?.content?.[0]?.text ?? '';
    try {
      return JSON.parse(rawText);
    } catch {
      throw new Error(`bad_json:${name}:${rawText}`);
    }
  }

  return { rpc, tool, stop };
}

async function findCursor(mcp, sessionId) {
  const opened = await mcp.tool('airkvm_open_calibration_window', {
    request_id: 'probe-open',
    session_id: sessionId,
    focused: true,
    width: popupWidth,
    height: popupHeight
  });
  console.log(JSON.stringify({ phase: 'opened', opened }, null, 2));

  const stepX = Math.max(40, Math.floor((opened?.window?.bounds?.width || popupWidth) / 4));
  const stepY = Math.max(40, Math.floor((opened?.window?.bounds?.height || popupHeight) / 4));
  const startDown = Math.max(120, Math.floor(stepY * 1.5));
  await mcp.tool('airkvm_mouse_move_rel', { dx: 0, dy: startDown });
  await sleep(80);

  let status = await mcp.tool('airkvm_calibration_status', { request_id: 'probe-status-0' });
  if (status?.found) return status;

  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 6; col++) {
      await mcp.tool('airkvm_mouse_move_rel', { dx: stepX, dy: 0 });
      await sleep(80);
      status = await mcp.tool('airkvm_calibration_status', {
        request_id: `probe-status-r${row}-c${col}`
      });
      if (status?.found) {
        console.log(JSON.stringify({ phase: 'found', row, col, status }, null, 2));
        return status;
      }
    }
    await mcp.tool('airkvm_mouse_move_rel', { dx: -(stepX * 6), dy: stepY });
    await sleep(80);
    status = await mcp.tool('airkvm_calibration_status', {
      request_id: `probe-status-row-${row}`
    });
    if (status?.found) {
      console.log(JSON.stringify({ phase: 'found', row, col: 'row-step', status }, null, 2));
      return status;
    }
  }

  throw new Error('cursor_not_found');
}

async function probeMove(mcp, label, dx, dy) {
  const before = await mcp.tool('airkvm_calibration_status', { request_id: `${label}-before` });
  await mcp.tool('airkvm_mouse_move_rel', { dx, dy });
  await sleep(180);
  const after = await mcp.tool('airkvm_calibration_status', { request_id: `${label}-after` });
  const beforeX = Number(before?.event?.client_x);
  const beforeY = Number(before?.event?.client_y);
  const afterX = Number(after?.event?.client_x);
  const afterY = Number(after?.event?.client_y);
  console.log(JSON.stringify({
    phase: 'probe',
    label,
    requested: { dx, dy },
    before: { x: beforeX, y: beforeY, event_count: before?.event_count },
    after: { x: afterX, y: afterY, event_count: after?.event_count },
    observed: {
      dx: Number.isFinite(beforeX) && Number.isFinite(afterX) ? afterX - beforeX : null,
      dy: Number.isFinite(beforeY) && Number.isFinite(afterY) ? afterY - beforeY : null
    }
  }, null, 2));
}

async function main() {
  const mcp = spawnMcp();
  const sessionId = `cal-probe-${Date.now()}`;
  try {
    const init = await mcp.rpc('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'calibration-probe', version: '0.1.0' }
    });
    if (!init.result) throw new Error('mcp_initialize_failed');

    await mcp.tool('airkvm_mouse_move_rel', { dx: -32000, dy: -32000 });
    await sleep(120);

    await findCursor(mcp, sessionId);
    await probeMove(mcp, 'x50', 50, 0);
    await probeMove(mcp, 'x100', 100, 0);
    await probeMove(mcp, 'x200', 200, 0);
    await probeMove(mcp, 'y50', 0, 50);
    await probeMove(mcp, 'y100', 0, 100);
    await probeMove(mcp, 'y200', 0, 200);
  } finally {
    await mcp.stop();
  }
}

main().catch((err) => {
  console.error(String(err?.message || err));
  process.exit(1);
});
