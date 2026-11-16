import { describe, expect, it } from 'vitest';
import { floatToInt16 } from '../src/pcm.js';

describe('floatToInt16', () => {
  it('clamps and scales', () => {
    const out = floatToInt16(new Float32Array([1, -1, 2, -2, 0, 0.5]));

    expect(out).toBeInstanceOf(Int16Array);
    expect([...out]).toEqual([32767, -32768, 32767, -32768, 0, 16384]);
  });
});
