import { UartTransport } from './src/uart.js';
import { SerialPort } from 'serialport';

// Mock SerialPort
const mockPort = {
  isOpen: true,
  open: (cb) => setTimeout(() => cb(null), 0),
  on: () => {},
  write: (data, cb) => setTimeout(() => cb(null), 0),
  drain: (cb) => setTimeout(() => cb(null), 0),
  close: () => {}
};

SerialPort.prototype.constructor = function() { return mockPort; };

const transport = new UartTransport({ portPath: '/dev/null' });
await transport.open();

// Simulate two concurrent requests
const fwTool = { target: 'fw' };

const p1 = transport.send({ type: 'cmd1' }, fwTool, { timeoutMs: 1000 });
const p2 = transport.send({ type: 'cmd2' }, fwTool, { timeoutMs: 1000 });

// Simulate response for cmd1 arriving
setTimeout(() => {
  transport._handleControl({ ok: true, type: 'cmd1' });
}, 100);

// Simulate response for cmd2 arriving
setTimeout(() => {
  transport._handleControl({ ok: true, type: 'cmd2' });
}, 200);

try {
  const [r1, r2] = await Promise.all([p1, p2]);
  console.log('Both succeeded:', r1, r2);
} catch (err) {
  console.log('Error (expected):', err.message);
}
