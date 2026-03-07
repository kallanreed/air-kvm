import readline from 'node:readline';
import { validateAgentCommand, toDeviceLine } from './protocol.js';

function send(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function makeToolResultText(text) {
  return { content: [{ type: 'text', text }] };
}

function onInitialize(id) {
  send({
    jsonrpc: '2.0',
    id,
    result: {
      protocolVersion: '2024-11-05',
      serverInfo: { name: 'air-kvm-mcp', version: '0.1.0' },
      capabilities: { tools: {} }
    }
  });
}

function onToolsList(id) {
  send({
    jsonrpc: '2.0',
    id,
    result: {
      tools: [
        {
          name: 'airkvm_send',
          description: 'Validate and forward a control command to the AirKVM device transport.',
          inputSchema: {
            type: 'object',
            properties: {
              command: {
                type: 'object',
                properties: {
                  type: { type: 'string' }
                },
                required: ['type']
              }
            },
            required: ['command']
          }
        }
      ]
    }
  });
}

function onToolCall(id, params) {
  const name = params?.name;
  const command = params?.arguments?.command;

  if (name !== 'airkvm_send') {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Unknown tool' } });
    return;
  }

  const validation = validateAgentCommand(command);
  if (!validation.ok) {
    send({
      jsonrpc: '2.0',
      id,
      result: makeToolResultText(`command rejected: ${validation.error}`),
      isError: true
    });
    return;
  }

  // POC transport: emit a device-line preview. Replace with serial write in next iteration.
  const line = toDeviceLine(command).trim();
  send({
    jsonrpc: '2.0',
    id,
    result: makeToolResultText(`forwarded ${line}`)
  });
}

function handleRequest(msg) {
  if (msg?.jsonrpc !== '2.0') return;

  if (msg.method === 'initialize') {
    onInitialize(msg.id);
    return;
  }

  if (msg.method === 'tools/list') {
    onToolsList(msg.id);
    return;
  }

  if (msg.method === 'tools/call') {
    onToolCall(msg.id, msg.params);
    return;
  }

  if (typeof msg.id !== 'undefined') {
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } });
  }
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  if (!line.trim()) return;
  try {
    const msg = JSON.parse(line);
    handleRequest(msg);
  } catch {
    // Ignore malformed input to keep STDIO loop resilient.
  }
});
