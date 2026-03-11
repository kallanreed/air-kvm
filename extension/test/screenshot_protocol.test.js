import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveScreenshotConfig } from '../src/screenshot_protocol.js';

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
  assert.equal(cfg.desktopDelayMs, 350);
});

test('resolveScreenshotConfig applies desktop_delay_ms bounds', () => {
  const low = resolveScreenshotConfig({ desktop_delay_ms: -10 });
  const high = resolveScreenshotConfig({ desktop_delay_ms: 99999 });
  const mid = resolveScreenshotConfig({ desktop_delay_ms: 800 });

  assert.equal(low.desktopDelayMs, 0);
  assert.equal(high.desktopDelayMs, 5000);
  assert.equal(mid.desktopDelayMs, 800);
});
