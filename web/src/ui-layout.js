// Where the clickable things are on the message window, in canvas pixels. Kept apart from the
// drawing code so that "what did the ray hit" can be answered (and tested) without a canvas.

export const MESSAGE = { width: 1600, height: 520, close: { x: 1480, y: 24, w: 96, h: 96 } };

const inside = (x, y, rect) => x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h;

// u, v: texture coordinates of the hit (three.js: v = 1 is the top edge).
export function messageActionAt(u, v) {
  return inside(u * MESSAGE.width, (1 - v) * MESSAGE.height, MESSAGE.close) ? 'close-message' : null;
}
