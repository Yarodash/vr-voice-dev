// Where the clickable things are on the message window, in canvas pixels. Kept apart from the
// drawing code so that "what did the ray hit" can be answered (and tested) without a canvas.

// box: the text window; close: the cross, above and to the right of it (outside the window).
export const MESSAGE = {
  width: 1600,
  height: 640,
  box: { x: 0, y: 14, w: 1470 }, // y: a small margin above the window, between stacked ones
  close: { x: 1488, y: 4, w: 96, h: 96 },
};

const inside = (x, y, rect) => x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h;

// u, v: texture coordinates of the hit (three.js: v = 1 is the top edge). height: how tall the
// window is now, in canvas pixels (it is only as tall as its text needs).
export function messageActionAt(u, v, height = MESSAGE.height) {
  return inside(u * MESSAGE.width, (1 - v) * height, MESSAGE.close) ? 'close-message' : null;
}
