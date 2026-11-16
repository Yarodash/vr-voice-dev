import { describe, expect, it } from 'vitest';
import { eyeSize, toDisplayRows } from '../src/screenshot.js';

describe('toDisplayRows', () => {
  it('flips the image (GPU rows come bottom-up) and converts linear colour to sRGB', () => {
    // 1 pixel wide, 2 pixels tall. GPU order: bottom row first.
    const fromGpu = new Uint8Array([
      0, 128, 255, 10, // bottom pixel
      255, 0, 0, 200, // top pixel
    ]);

    const rows = toDisplayRows(fromGpu, 1, 2);

    expect([...rows]).toEqual([
      255, 0, 0, 255, // top pixel first, alpha forced opaque
      0, 188, 255, 255, // linear 128 is sRGB 188
    ]);
  });

  it('keeps the left-to-right order inside a row', () => {
    const fromGpu = new Uint8Array([255, 255, 255, 255, 0, 0, 0, 255]); // 2 wide, 1 tall

    expect([...toDisplayRows(fromGpu, 2, 1)]).toEqual([255, 255, 255, 255, 0, 0, 0, 255]);
  });
});

describe('eyeSize', () => {
  it('keeps the eye viewport proportions at the requested width', () => {
    expect(eyeSize({ z: 1680, w: 1760 }, 1024)).toEqual({ width: 1024, height: 1073 });
  });

  it('caps the width so a typo cannot ask for a gigantic image', () => {
    expect(eyeSize({ z: 1000, w: 1000 }, 100000).width).toBe(2048);
  });
});
