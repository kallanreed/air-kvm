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
const centerIterations = Number.parseInt(process.env.AIRKVM_CAL_CENTER_ITERS || '6', 10);
const successRadius = Number.parseInt(process.env.AIRKVM_CAL_SUCCESS_RADIUS || '2', 10);
const conservativeGainFloor = Number.parseFloat(process.env.AIRKVM_CAL_GAIN_FLOOR || '1.5');
const edgePadding = Number.parseInt(process.env.AIRKVM_CAL_EDGE_PADDING || '24', 10);
const touchOrder = ['corner_tl', 'corner_tr', 'corner_bl', 'corner_br'];
const localSearchMoves = [
  { dx: -3, dy: -2 },
  { dx: -3, dy: -1 },
  { dx: -2, dy: -2 },
  { dx: -4, dy: -2 },
  { dx: -2, dy: -1 },
  { dx: -1, dy: -1 },
  { dx: -2, dy: 0 },
  { dx: 0, dy: -2 },
  { dx: -1, dy: 0 },
  { dx: 0, dy: -1 }
];
const moveHistory = [];

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

async function main() {
  const mcp = spawnMcp();
  const sessionId = `cal-${Date.now()}`;
  try {
    const init = await mcp.rpc('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'calibration-home', version: '0.1.0' }
    });
    if (!init.result) throw new Error('mcp_initialize_failed');

    await mcp.tool('airkvm_mouse_move_rel', { dx: -32000, dy: -32000 });
    await sleep(120);

    const opened = await mcp.tool('airkvm_open_calibration_window', {
      request_id: 'cal-open',
      session_id: sessionId,
      focused: true,
      width: popupWidth,
      height: popupHeight
    });
    console.log(JSON.stringify({ phase: 'opened', opened }, null, 2));

    const stepX = Math.max(40, Math.floor((opened?.window?.bounds?.width || popupWidth) / 4));
    const stepY = Math.max(40, Math.floor((opened?.window?.bounds?.height || popupHeight) / 4));
    const initialSeekDown = Math.max(120, Math.floor(stepY * 1.5));
    await mcp.tool('airkvm_mouse_move_rel', { dx: 0, dy: initialSeekDown });
    await sleep(80);
    console.log(JSON.stringify({ phase: 'seek-start', move: { dx: 0, dy: initialSeekDown } }, null, 2));
    let lastStatus = await mcp.tool('airkvm_calibration_status', { request_id: 'cal-status-0' });
    if (lastStatus?.found) {
      console.log(JSON.stringify({ phase: 'found', status: lastStatus }, null, 2));
      if (lastStatus?.layout && lastStatus?.event) {
        await moveToDoneAndClick(mcp, lastStatus);
      }
      return;
    }

    for (let row = 0; row < 5; row++) {
      for (let col = 0; col < 6; col++) {
        await mcp.tool('airkvm_mouse_move_rel', { dx: stepX, dy: 0 });
        await sleep(80);
        lastStatus = await mcp.tool('airkvm_calibration_status', {
          request_id: `cal-status-r${row}-c${col}`
        });
        console.log(JSON.stringify({ phase: 'poll', row, col, status: lastStatus }, null, 2));
        if (lastStatus?.found) {
          console.log(JSON.stringify({ phase: 'found', status: lastStatus }, null, 2));
          if (lastStatus?.layout && lastStatus?.event) {
            await moveToDoneAndClick(mcp, lastStatus);
          }
          return;
        }
      }
      await mcp.tool('airkvm_mouse_move_rel', { dx: -(stepX * 6), dy: stepY });
      await sleep(80);
      lastStatus = await mcp.tool('airkvm_calibration_status', {
        request_id: `cal-status-row-${row}`
      });
      console.log(JSON.stringify({ phase: 'row-step', row, status: lastStatus }, null, 2));
      if (lastStatus?.found) {
        console.log(JSON.stringify({ phase: 'found', status: lastStatus }, null, 2));
        if (lastStatus?.layout && lastStatus?.event) {
          await moveToDoneAndClick(mcp, lastStatus);
        }
        return;
      }
    }

    console.log(JSON.stringify({ phase: 'miss', status: lastStatus }, null, 2));
    process.exitCode = 1;
  } finally {
    await mcp.stop();
  }
}

async function moveToDoneAndClick(mcp, status) {
  let tracked = status;
  let gainX = 1;
  let gainY = 1;
  for (const targetId of touchOrder) {
    const touched = await moveIntoTarget(mcp, tracked, targetId, gainX, gainY);
    tracked = touched.status;
    gainX = touched.gainX;
    gainY = touched.gainY;
    console.log(JSON.stringify({
      phase: 'touch-complete',
      target_id: targetId,
      landed: {
        x: Number(tracked?.event?.client_x),
        y: Number(tracked?.event?.client_y)
      },
      gain: { x: gainX, y: gainY }
    }, null, 2));
  }

  const doneTargetX = Number(tracked?.layout?.done_center_x);
  const doneTargetY = Number(tracked?.layout?.done_center_y);
  const openLoop = await openLoopDoneClick(mcp, tracked, doneTargetX, doneTargetY, gainX, gainY);
  tracked = openLoop.status;
  await mcp.tool('airkvm_mouse_click', { button: 'left' });
  await sleep(180);
  const clicked = await mcp.tool('airkvm_calibration_status', { request_id: 'cal-status-done-0' });
  const clickX = Number(clicked?.done_click_event?.client_x ?? clicked?.event?.client_x);
  const clickY = Number(clicked?.done_click_event?.client_y ?? clicked?.event?.client_y);
  console.log(JSON.stringify({
    phase: 'done-click',
    click: { x: clickX, y: clickY },
    target: { x: doneTargetX, y: doneTargetY },
    offset: {
      dx: Number.isFinite(clickX) ? clickX - doneTargetX : null,
      dy: Number.isFinite(clickY) ? clickY - doneTargetY : null
    },
    within_window: withinSuccessWindow(clickX, clickY, doneTargetX, doneTargetY),
    status: clicked
  }, null, 2));
}

function updateGain(currentGain, requested, observed) {
  if (!Number.isFinite(requested) || requested === 0 || !Number.isFinite(observed) || observed === 0) {
    return currentGain;
  }
  const measured = observed / requested;
  if (!Number.isFinite(measured) || measured <= 0) {
    return currentGain;
  }
  if (!Number.isFinite(currentGain) || currentGain <= 0) {
    return measured;
  }
  return ((currentGain * 2) + measured) / 3;
}

function clampMove(value) {
  if (!Number.isFinite(value)) return 0;
  if (value === 0) return 0;
  if (value > 0) return Math.max(1, value);
  return Math.min(-1, value);
}

async function tryLocalCenterSearch(mcp, status, targetX, targetY) {
  let tracked = status;
  for (let index = 0; index < localSearchMoves.length; index++) {
    const move = localSearchMoves[index];
    await mcp.tool('airkvm_mouse_move_rel', move);
    await sleep(150);
    const nextStatus = await mcp.tool('airkvm_calibration_status', {
      request_id: `cal-status-local-${index}`
    });
    const nextX = Number(nextStatus?.event?.client_x);
    const nextY = Number(nextStatus?.event?.client_y);
    console.log(JSON.stringify({
      phase: 'done-local',
      attempt: index,
      move,
      landed: { x: nextX, y: nextY },
      target: { x: targetX, y: targetY },
      status: nextStatus
    }, null, 2));
    tracked = nextStatus;
    if (withinSuccessWindow(nextX, nextY, targetX, targetY)) {
      return tracked;
    }
  }
  return tracked;
}

function withinSuccessWindow(x, y, targetX, targetY) {
  if (![x, y, targetX, targetY].every(Number.isFinite)) return false;
  return Math.abs(x - targetX) <= successRadius && Math.abs(y - targetY) <= successRadius;
}

function clampToViewport(value, viewportSize) {
  if (!Number.isFinite(value) || !Number.isFinite(viewportSize)) return value;
  return Math.max(edgePadding, Math.min(viewportSize - edgePadding, value));
}

function withinRectWindow(x, y, rect) {
  if (![x, y, rect?.left, rect?.top, rect?.width, rect?.height].every(Number.isFinite)) return false;
  return x >= rect.left - successRadius &&
    x <= (rect.left + rect.width + successRadius) &&
    y >= rect.top - successRadius &&
    y <= (rect.top + rect.height + successRadius);
}

function targetRect(layout, targetId) {
  return {
    left: Number(layout?.[`${targetId}_left`]),
    top: Number(layout?.[`${targetId}_top`]),
    width: Number(layout?.[`${targetId}_width`]),
    height: Number(layout?.[`${targetId}_height`]),
    x: Number(layout?.[`${targetId}_x`]),
    y: Number(layout?.[`${targetId}_y`])
  };
}

async function moveIntoTarget(mcp, status, targetId, startGainX, startGainY) {
  let tracked = status;
  let gainX = startGainX || 1;
  let gainY = startGainY || 1;
  const rect = targetRect(status?.layout, targetId);
  const pointResult = await moveNearPoint(mcp, tracked, rect.x, rect.y, gainX, gainY, targetId);
  tracked = pointResult.status;
  gainX = pointResult.gainX;
  gainY = pointResult.gainY;

  for (let attempt = 0; attempt < localSearchMoves.length; attempt++) {
    const currentX = Number(tracked?.event?.client_x);
    const currentY = Number(tracked?.event?.client_y);
    if (withinRectWindow(currentX, currentY, rect)) {
      return { status: tracked, gainX, gainY };
    }
    const move = localSearchMoves[attempt];
    await mcp.tool('airkvm_mouse_move_rel', move);
    await sleep(150);
    const nextStatus = await mcp.tool('airkvm_calibration_status', {
      request_id: `${targetId}-local-${attempt}`
    });
    tracked = nextStatus;
    console.log(JSON.stringify({
      phase: 'touch-local',
      target_id: targetId,
      attempt,
      move,
      landed: {
        x: Number(nextStatus?.event?.client_x),
        y: Number(nextStatus?.event?.client_y)
      },
      rect
    }, null, 2));
    if (withinRectWindow(Number(nextStatus?.event?.client_x), Number(nextStatus?.event?.client_y), rect)) {
      return { status: tracked, gainX, gainY };
    }
  }

  return { status: tracked, gainX, gainY };
}

async function moveNearPoint(mcp, status, targetX, targetY, startGainX, startGainY, phaseLabel) {
  let tracked = status;
  let gainX = startGainX || 1;
  let gainY = startGainY || 1;
  let currentX = Number(tracked?.event?.client_x);
  let currentY = Number(tracked?.event?.client_y);
  const viewportWidth = Number(tracked?.layout?.viewport_width);
  const viewportHeight = Number(tracked?.layout?.viewport_height);

  for (let attempt = 0; attempt < centerIterations; attempt++) {
    if (withinSuccessWindow(currentX, currentY, targetX, targetY)) {
      break;
    }
    const boundedTargetX = clampToViewport(targetX, viewportWidth);
    const boundedTargetY = clampToViewport(targetY, viewportHeight);
    const desiredClientDx = boundedTargetX - currentX;
    const desiredClientDy = boundedTargetY - currentY;
    const safeGainX = Math.max(gainX, conservativeGainFloor);
    const safeGainY = Math.max(gainY, conservativeGainFloor);
    const dx = clampMove(Math.round(desiredClientDx / safeGainX));
    const dy = clampMove(Math.round(desiredClientDy / safeGainY));
    await mcp.tool('airkvm_mouse_move_rel', { dx, dy });
    await sleep(150);
    const nextStatus = await mcp.tool('airkvm_calibration_status', {
      request_id: `${phaseLabel}-track-${attempt}`
    });
    const nextX = Number(nextStatus?.event?.client_x);
    const nextY = Number(nextStatus?.event?.client_y);
    gainX = updateAxisGain('x', gainX, dx, nextX - currentX);
    gainY = updateAxisGain('y', gainY, dy, nextY - currentY);
    tracked = nextStatus;
    currentX = nextX;
    currentY = nextY;
    console.log(JSON.stringify({
      phase: 'target-track',
      target_id: phaseLabel,
      attempt,
      move: { dx, dy },
      bounded_target: { x: boundedTargetX, y: boundedTargetY },
      landed: { x: currentX, y: currentY },
      target: { x: targetX, y: targetY },
      gain: { x: gainX, y: gainY }
    }, null, 2));
  }

  return { status: tracked, gainX, gainY };
}

async function openLoopDoneClick(mcp, status, targetX, targetY, gainX, gainY) {
  const currentX = Number(status?.event?.client_x);
  const currentY = Number(status?.event?.client_y);
  const viewportWidth = Number(status?.layout?.viewport_width);
  const viewportHeight = Number(status?.layout?.viewport_height);
  const boundedTargetX = clampToViewport(targetX, viewportWidth);
  const boundedTargetY = clampToViewport(targetY, viewportHeight);
  const safeGainX = Math.max(gainX || 1, conservativeGainFloor);
  const safeGainY = Math.max(gainY || 1, conservativeGainFloor);
  const dx = clampMove(Math.round((boundedTargetX - currentX) / safeGainX));
  const dy = clampMove(Math.round((boundedTargetY - currentY) / safeGainY));
  await mcp.tool('airkvm_mouse_move_rel', { dx, dy });
  await sleep(150);
  const nextStatus = await mcp.tool('airkvm_calibration_status', { request_id: 'done-open-loop' });
  console.log(JSON.stringify({
    phase: 'done-open-loop',
    move: { dx, dy },
    from: { x: currentX, y: currentY },
    target: { x: targetX, y: targetY },
    bounded_target: { x: boundedTargetX, y: boundedTargetY },
    landed: {
      x: Number(nextStatus?.event?.client_x),
      y: Number(nextStatus?.event?.client_y)
    },
    gain: { x: gainX, y: gainY },
    status: nextStatus
  }, null, 2));
  return { status: nextStatus };
}

function updateAxisGain(axis, currentGain, requested, observed) {
  recordGainSample(requested, observed, axis);
  const aggregateGain = aggregateAxisGain(axis);
  if (Number.isFinite(aggregateGain) && aggregateGain > 0) {
    return aggregateGain;
  }
  return updateGain(currentGain, requested, observed);
}

function recordGainSample(requested, observed, axis) {
  if (!Number.isFinite(requested) || !Number.isFinite(observed) || requested === 0 || observed === 0) {
    return;
  }
  moveHistory.push({ axis, requested, observed });
}

function aggregateAxisGain(axis) {
  let requestedTotal = 0;
  let observedTotal = 0;
  for (const sample of moveHistory) {
    if (sample.axis !== axis) continue;
    requestedTotal += Math.abs(sample.requested);
    observedTotal += Math.abs(sample.observed);
  }
  if (!requestedTotal || !observedTotal) return null;
  return observedTotal / requestedTotal;
}

main().catch((err) => {
  console.error(String(err?.message || err));
  process.exit(1);
});
