import test from 'node:test';
import assert from 'node:assert/strict';

import { SCREENSHOT_CONTRACT as mcpContract } from '../src/screenshot_contract.js';
import { SCREENSHOT_CONTRACT as extensionContract } from '../../extension/src/screenshot_contract.js';

test('mcp and extension screenshot contracts stay in sync', () => {
  assert.deepEqual(mcpContract, extensionContract);
});
