export function isCommand(msg) {
  return typeof msg === 'object' && msg !== null && typeof msg.type === 'string';
}

export function validateAgentCommand(msg) {
  if (!isCommand(msg)) return { ok: false, error: 'invalid_message' };

  switch (msg.type) {
    case 'mouse.move_rel':
      return Number.isInteger(msg.dx) && Number.isInteger(msg.dy)
        ? { ok: true }
        : { ok: false, error: 'invalid_mouse_move_rel' };
    case 'mouse.move_abs':
      return Number.isInteger(msg.x) && Number.isInteger(msg.y)
        ? { ok: true }
        : { ok: false, error: 'invalid_mouse_move_abs' };
    case 'mouse.click':
      return typeof msg.button === 'string' ? { ok: true } : { ok: false, error: 'invalid_mouse_click' };
    case 'key.tap':
      return typeof msg.key === 'string' ? { ok: true } : { ok: false, error: 'invalid_key_tap' };
    case 'state.request':
      return { ok: true };
    default:
      return { ok: false, error: 'unknown_type' };
  }
}

export function toDeviceLine(msg) {
  return `${JSON.stringify(msg)}\n`;
}
