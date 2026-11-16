import { describe, expect, it } from 'vitest';
import { ControlMapper } from '../src/control-mapper.js';

const GRIP = 1, STICK = 3, X = 4, Y = 5;

function pad({ pressed = [] } = {}) {
  const buttons = Array(8).fill(false);
  for (const index of pressed) buttons[index] = true;
  return { buttons, axes: [0, 0, 0, 0] };
}

describe('ControlMapper', () => {
  it('X sends once per press', () => {
    const mapper = new ControlMapper();

    expect(mapper.step(0, pad())).toEqual([]);
    expect(mapper.step(16, pad({ pressed: [X] }))).toEqual(['send']);
    expect(mapper.step(32, pad({ pressed: [X] }))).toEqual([]);
    expect(mapper.step(48, pad())).toEqual([]);
    expect(mapper.step(64, pad({ pressed: [X] }))).toEqual(['send']);
  });

  it('holding Y records: it starts on press and stops on release', () => {
    const mapper = new ControlMapper();

    expect(mapper.step(0, pad({ pressed: [Y] }))).toEqual(['record-start']);
    expect(mapper.step(16, pad({ pressed: [Y] }))).toEqual([]);
    expect(mapper.step(900, pad())).toEqual(['record-stop']);
    expect(mapper.step(916, pad())).toEqual([]);
  });

  it('the grip deletes once per press', () => {
    const mapper = new ControlMapper();

    expect(mapper.step(0, pad({ pressed: [GRIP] }))).toEqual(['delete']);
    expect(mapper.step(16, pad({ pressed: [GRIP] }))).toEqual([]);
  });

  it('stick click held 1000 ms reloads once', () => {
    const mapper = new ControlMapper({ holdMs: 1000 });

    expect(mapper.step(0, pad({ pressed: [STICK] }))).toEqual([]);
    expect(mapper.step(999, pad({ pressed: [STICK] }))).toEqual([]);
    expect(mapper.step(1000, pad({ pressed: [STICK] }))).toEqual(['reload']);
    expect(mapper.step(2500, pad({ pressed: [STICK] }))).toEqual([]);
  });

  it('a short stick click does nothing', () => {
    const mapper = new ControlMapper({ holdMs: 1000 });

    mapper.step(0, pad({ pressed: [STICK] }));
    expect(mapper.step(300, pad())).toEqual([]);
  });

  it('a controller that reports fewer buttons does not throw', () => {
    const mapper = new ControlMapper();

    expect(mapper.step(0, { buttons: [false], axes: [] })).toEqual([]);
  });
});
