export const kDefaultScreenshotConfig = {
  maxWidth: 960,
  maxHeight: 540,
  jpegQuality: 0.55,
  maxBase64Chars: 90000,
  maxAttempts: 4,
  downscaleFactor: 0.8,
  minJpegQuality: 0.45
};

function clampInt(value, min, max, fallback) {
  if (!Number.isInteger(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function clampNumber(value, min, max, fallback) {
  if (typeof value !== 'number' || Number.isNaN(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

export function resolveScreenshotConfig(command, base = kDefaultScreenshotConfig) {
  return {
    maxWidth: clampInt(command?.max_width, 160, 1920, base.maxWidth),
    maxHeight: clampInt(command?.max_height, 120, 1080, base.maxHeight),
    jpegQuality: clampNumber(command?.quality, 0.3, 0.9, base.jpegQuality),
    maxBase64Chars: clampInt(command?.max_chars, 20000, 200000, base.maxBase64Chars),
    encoding: command?.encoding === 'b64z' ? 'b64z' : 'b64',
    maxAttempts: base.maxAttempts,
    downscaleFactor: base.downscaleFactor,
    minJpegQuality: base.minJpegQuality
  };
}

export function dataUrlToMetaAndChunks(
  dataUrl,
  requestId,
  source,
  encodeStats = null,
  chunkSize = 120,
  encoding = 'b64',
  payloadBase64Override = null
) {
  const comma = dataUrl.indexOf(',');
  if (comma === -1) throw new Error('screenshot_invalid_data_url');

  const header = dataUrl.slice(0, comma);
  const base64 = payloadBase64Override || dataUrl.slice(comma + 1);
  const mimeMatch = /^data:([^;]+);base64$/i.exec(header);
  const mime = mimeMatch?.[1] || 'application/octet-stream';
  const totalChunks = Math.ceil(base64.length / chunkSize);

  const meta = {
    type: 'screenshot.meta',
    rid: requestId,
    src: source,
    m: mime,
    e: encoding,
    cs: chunkSize,
    tc: totalChunks,
    tch: base64.length,
    ew: encodeStats?.encodedWidth || null,
    eh: encodeStats?.encodedHeight || null,
    eq: encodeStats?.encodedQuality || null,
    ea: encodeStats?.attempts || null
  };

  const chunks = [];
  for (let seq = 0; seq < totalChunks; seq += 1) {
    chunks.push({
      type: 'screenshot.chunk',
      rid: requestId,
      src: source,
      q: seq,
      d: base64.slice(seq * chunkSize, (seq + 1) * chunkSize)
    });
  }

  return { meta, chunks };
}
