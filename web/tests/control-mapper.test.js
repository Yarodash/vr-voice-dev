import { describe, expect, it } from 'vitest';
import { ControlMapper } from '../src/control-mapper.js';

const GRIP = 1, STICK = 3, X = 4, Y = 5;

function pad({ pressed = [], stickY = 0 } = {}) {
  const buttons = Array(8).fill(false);
  for (const index of pressed) buttons[index] = true;
  return { buttons, axes: [0, 0, 0, stickY] };
}

describe('ControlMapper', () => {
  it('X rising edge emits enter once', () => {
    const mapper = new ControlMapper();

    expect(mapper.step(0, pad())).toEqual([]);
    expect(mapper.step(16, pad({ pressed: [X] }))).toEqual(['enter']);
    expect(mapper.step(32, pad({ pressed: [X] }))).toEqual([]);
    expect(mapper.step(48, pad())).toEqual([]);
    expect(mapper.step(64, pad({ pressed: [X] }))).toEqual(['enter']);
  });

  it('Y rising edge emits esc once', () => {
    const mapper = new ControlMapper();

    expect(mapper.step(0, pad({ pressed: [Y] }))).toEqual(['esc']);
    expect(mapper.step(16, pad({ pressed: [Y] }))).toEqual([]);
  });

  it('stick up repeats scroll-up every repeatMs', () => {
    const mapper = new ControlMapper({ repeatMs: 200 });

    expect(mapper.step(0, pad({ stickY: -0.9 }))).toEqual(['scroll-up']);
    expect(mapper.step(100, pad({ stickY: -0.9 }))).toEqual([]);
    expect(mapper.step(200, pad({ stickY: -0.9 }))).toEqual(['scroll-up']);
    expect(mapper.step(250, pad({ stickY: 0 }))).toEqual([]);
    expect(mapper.step(260, pad({ stickY: 0.9 }))).toEqual(['scroll-down']);
  });

  it('small stick deflection is ignored', () => {
    const mapper = new ControlMapper({ threshold: 0.6 });

    expect(mapper.step(0, pad({ stickY: -0.5 }))).toEqual([]);
  });

  it('stick with grip emits arrows instead of scroll', () => {
    const mapper = new ControlMapper();

    expect(mapper.step(0, pad({ pressed: [GRIP], stickY: -0.9 }))).toEqual(['arrow-up']);
    expect(mapper.step(300, pad({ pressed: [GRIP], stickY: 0.9 }))).toEqual(['arrow-down']);
  });

  it('stick click held 1000 ms emits reload once', () => {
    const mapper = new ControlMapper({ holdMs: 1000 });

    expect(mapper.step(0, pad({ pressed: [STICK] }))).toEqual([]);
    expect(mapper.step(999, pad({ pressed: [STICK] }))).toEqual([]);
    expect(mapper.step(1000, pad({ pressed: [STICK] }))).toEqual(['reload']);
    expect(mapper.step(2500, pad({ pressed: [STICK] }))).toEqual([]);
  });

  it('a short stick click brings the panels in front of the user', () => {
    const mapper = new ControlMapper({ holdMs: 1000 });

    expect(mapper.step(0, pad({ pressed: [STICK] }))).toEqual([]);
    expect(mapper.step(300, pad())).toEqual(['recenter']);
    expect(mapper.step(400, pad())).toEqual([]);
  });

  it('a long stick click reloads and does not also recenter on release', () => {
    const mapper = new ControlMapper({ holdMs: 1000 });

    mapper.step(0, pad({ pressed: [STICK] }));
    expect(mapper.step(1000, pad({ pressed: [STICK] }))).toEqual(['reload']);
    expect(mapper.step(1100, pad())).toEqual([]);
  });

  it('a controller that reports fewer buttons does not throw', () => {
    const mapper = new ControlMapper();

    expect(mapper.step(0, { buttons: [false], axes: [] })).toEqual([]);
  });
});
