import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { createControls } from '../src/controls.js';

const LEFT = { handedness: 'left', gamepad: { buttons: [], axes: [] } };
const Y = 5;
const RIGHT = { handedness: 'right', gamepad: { buttons: [], axes: [] } };
const LEFT_HAND = { handedness: 'left', gamepad: { buttons: [], axes: [] }, hand: {} };

// Just enough of three's WebXRManager: two controller objects and session events.
function setup(options = {}) {
  const controllers = [new THREE.Group(), new THREE.Group()];
  const grips = [new THREE.Group(), new THREE.Group()];
  const xr = new THREE.EventDispatcher();
  let session = null;
  xr.getController = (index) => controllers[index];
  xr.getControllerGrip = (index) => grips[index];
  xr.getSession = () => session;

  const ptt = [];
  const actions = [];
  let clock = 0;
  const controls = createControls({
    renderer: { xr },
    scene: new THREE.Scene(),
    onPtt: (down) => ptt.push(down),
    onAction: (action) => actions.push(action),
    ...options,
  });

  return {
    ptt,
    actions,
    controls,
    grips,
    fire: (index, type, data) => controllers[index].dispatchEvent({ type, data }),
    startSession() {
      session = Object.assign(new EventTarget(), { visibilityState: 'visible', inputSources: [] });
      xr.dispatchEvent({ type: 'sessionstart' });
      return session;
    },
    // one frame with the given buttons held on the left (or another) controller
    frame(pressed = [], source = LEFT) {
      if (!session) this.startSession();
      const buttons = Array.from({ length: 8 }, (_, index) => ({ pressed: pressed.includes(index) }));
      session.inputSources = [{ ...source, gamepad: { buttons, axes: [0, 0, 0, 0] } }];
      clock += 16;
      controls.tick(clock);
    },
    endSession() {
      session = null;
      xr.dispatchEvent({ type: 'sessionend' });
    },
  };
}

describe('createControls', () => {
  it('holding Y on the left controller records', () => {
    const t = setup();

    t.frame([Y]);
    t.frame([Y]);
    t.frame([]);

    expect(t.ptt).toEqual([true, false]);
  });

  it('ignores the right controller and a tracked hand', () => {
    const t = setup();

    t.frame([Y], RIGHT);
    t.frame([Y], LEFT_HAND);

    expect(t.ptt).toEqual([]);
  });

  it('X and the grip are not actions', () => {
    const t = setup();

    t.frame([4]);
    t.frame([]);
    t.frame([1]);

    expect(t.actions).toEqual([]);
    expect(t.ptt).toEqual([]);
  });

  it('the right controller going to sleep does not end the recording', () => {
    const t = setup();
    t.frame([Y]);

    t.fire(0, 'disconnected', RIGHT);

    expect(t.ptt).toEqual([true]);
  });

  it('the left controller going to sleep ends the recording', () => {
    const t = setup();
    t.frame([Y]);

    t.fire(1, 'disconnected', LEFT);

    expect(t.ptt).toEqual([true, false]);
  });

  it('the headset being taken off or the system menu opening ends the recording', () => {
    const t = setup();
    const session = t.startSession();
    t.frame([Y]);

    session.visibilityState = 'hidden';
    session.dispatchEvent(new Event('visibilitychange'));

    expect(t.ptt).toEqual([true, false]);
  });

  it('the session ending ends the recording', () => {
    const t = setup();
    t.frame([Y]);

    t.endSession();

    expect(t.ptt).toEqual([true, false]);
  });

  it('the trigger presses the button it points at and never records', () => {
    const t = setup({ hitTest: () => 'close-message' });

    t.fire(1, 'selectstart', LEFT);
    t.fire(1, 'selectend', LEFT);

    expect(t.actions).toEqual(['close-message']);
    expect(t.ptt).toEqual([]);
  });

  it('the trigger away from any button does nothing', () => {
    const t = setup({ hitTest: () => null });

    t.fire(1, 'selectstart', LEFT);

    expect(t.ptt).toEqual([]);
    expect(t.actions).toEqual([]);
  });

  it('remembers which grip belongs to the left controller', () => {
    const t = setup();

    t.fire(1, 'connected', LEFT);
    expect(t.controls.leftGrip).toBe(t.grips[1]);

    t.fire(1, 'disconnected', LEFT);
    expect(t.controls.leftGrip).toBe(null);
  });
});
