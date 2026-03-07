const UART_SERVICE_UUID = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const UART_RX_CHAR_UUID = '6e400002-b5a3-f393-e0a9-e50e24dcca9e';
const UART_TX_CHAR_UUID = '6e400003-b5a3-f393-e0a9-e50e24dcca9e';
const kDebug = true;

function debugLog(...args) {
  if (!kDebug) return;
  console.log('[airkvm-ble]', ...args);
}

let bleDevice = null;
let rxCharacteristic = null;
let txCharacteristic = null;
let bleLineBuffer = '';
let commandHandler = null;

export function __resetBleForTest() {
  bleDevice = null;
  rxCharacteristic = null;
  txCharacteristic = null;
  bleLineBuffer = '';
  commandHandler = null;
}

function hasBluetooth(navigatorLike) {
  return Boolean(navigatorLike?.bluetooth?.requestDevice);
}

export async function connectBle(deps = {}) {
  const navigatorLike = deps.navigatorLike || globalThis.navigator;
  if (!hasBluetooth(navigatorLike)) {
    debugLog('connectBle unavailable');
    return false;
  }

  const device = await navigatorLike.bluetooth.requestDevice({
    filters: [{ services: [UART_SERVICE_UUID] }],
    optionalServices: [UART_SERVICE_UUID]
  });

  const server = await device.gatt.connect();
  const service = await server.getPrimaryService(UART_SERVICE_UUID);
  const rx = await service.getCharacteristic(UART_RX_CHAR_UUID);
  const tx = await service.getCharacteristic(UART_TX_CHAR_UUID);
  debugLog('connectBle characteristics ready');

  bleDevice = device;
  rxCharacteristic = rx;
  txCharacteristic = tx;
  bleLineBuffer = '';

  const decoder = deps.decoder || new TextDecoder();
  if (typeof txCharacteristic?.addEventListener === 'function') {
    txCharacteristic.addEventListener('characteristicvaluechanged', (event) => {
      const value = event?.target?.value;
      if (!value) return;
      onBleBytes(decoder.decode(value), deps.onCommand || commandHandler);
    });
  }
  if (typeof txCharacteristic?.startNotifications === 'function') {
    await txCharacteristic.startNotifications();
    debugLog('notifications started');
  }

  device.addEventListener('gattserverdisconnected', () => {
    rxCharacteristic = null;
    txCharacteristic = null;
    bleLineBuffer = '';
  });

  return true;
}

async function ensureConnected(deps = {}) {
  if (rxCharacteristic && bleDevice?.gatt?.connected) return true;
  return connectBle(deps);
}

export async function postEvent(payload, deps = {}) {
  const encoder = deps.encoder || new TextEncoder();
  try {
    const connected = await ensureConnected(deps);
    if (!connected || !rxCharacteristic) return false;
    const line = `${JSON.stringify(payload)}\n`;
    debugLog('tx', payload?.type || 'unknown');
    await rxCharacteristic.writeValueWithoutResponse(encoder.encode(line));
    return true;
  } catch {
    debugLog('postEvent failed', payload?.type || 'unknown');
    return false;
  }
}

function onBleBytes(text, onCommand) {
  if (!text || typeof text !== 'string') return;
  bleLineBuffer += text;
  const lines = bleLineBuffer.split('\n');
  bleLineBuffer = lines.pop() || '';
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const msg = JSON.parse(trimmed);
      debugLog('rx line json', msg?.type || 'unknown');
      if (typeof onCommand === 'function') onCommand(msg);
    } catch {
      // Ignore malformed device notifications.
    }
  }

  // Some BLE notifications carry one whole JSON object without a newline.
  const tail = bleLineBuffer.trim();
  if (!tail) return;
  try {
    const msg = JSON.parse(tail);
    debugLog('rx tail json', msg?.type || 'unknown');
    bleLineBuffer = '';
    if (typeof onCommand === 'function') onCommand(msg);
  } catch {
    // Keep buffering when payload appears partial.
  }
}

export function setBleCommandHandler(handler) {
  commandHandler = handler;
}
