import test from 'node:test';
import assert from 'node:assert/strict';

import { dataUrlToMetaAndChunks, resolveScreenshotConfig } from '../src/screenshot_protocol.js';

test('resolveScreenshotConfig clamps and defaults values', () => {
  const cfg = resolveScreenshotConfig({
    max_width: 99999,
    max_height: 1,
    quality: 2,
    max_chars: 10
  });

  assert.equal(cfg.maxWidth, 1920);
  assert.equal(cfg.maxHeight, 120);
  assert.equal(cfg.jpegQuality, 0.9);
  assert.equal(cfg.maxBase64Chars, 20000);
});

test('dataUrlToMetaAndChunks emits compact keys and chunked payload', () => {
  const dataUrl = 'data:image/jpeg;base64,ABCDEFGHIJKL';
  const { meta, chunks } = dataUrlToMetaAndChunks(
    dataUrl,
    'r1',
    'tab',
    { encodedWidth: 640, encodedHeight: 360, encodedQuality: 0.55, attempts: 2 },
    4
  );

  assert.equal(meta.type, 'screenshot.meta');
  assert.equal(meta.rid, 'r1');
  assert.equal(meta.src, 'tab');
  assert.equal(meta.m, 'image/jpeg');
  assert.equal(meta.cs, 4);
  assert.equal(meta.tc, 3);
  assert.equal(meta.tch, 12);
  assert.equal(meta.ew, 640);
  assert.equal(meta.eh, 360);
  assert.equal(meta.eq, 0.55);
  assert.equal(meta.ea, 2);

  assert.equal(chunks.length, 3);
  assert.deepEqual(chunks[0], { type: 'screenshot.chunk', rid: 'r1', src: 'tab', q: 0, d: 'ABCD' });
  assert.deepEqual(chunks[1], { type: 'screenshot.chunk', rid: 'r1', src: 'tab', q: 1, d: 'EFGH' });
  assert.deepEqual(chunks[2], { type: 'screenshot.chunk', rid: 'r1', src: 'tab', q: 2, d: 'IJKL' });
});

