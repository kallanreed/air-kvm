import test from 'node:test';
import assert from 'node:assert/strict';

import { busyEvent } from '../src/messages.js';

test('busyEvent emits boolean busy state', () => {
  const ev = busyEvent(1);
  assert.equal(ev.type, 'busy.changed');
  assert.equal(ev.busy, true);
  assert.equal(typeof ev.ts, 'number');
});
