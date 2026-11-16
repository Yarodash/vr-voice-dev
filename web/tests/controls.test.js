import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { createControls } from '../src/controls.js';

const LEFT = { handedness: 'left', gamepad: { buttons: [], axes: [] } };
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
    endSession() {
      session = null;
      xr.dispatchEvent({ type: 'sessionend' });
    },
  };
}

describe('createControls', () => {
  it('left trigger press and release drive push-to-talk', () => {
    const { ptt, fire } = setup();

    fire(1, 'selectstart', LEFT);
    fire(1, 'selectend', LEFT);

    expect(ptt).toEqual([true, false]);
  });

  it('ignores the right controller and a pinching hand', () => {
    const { ptt, fire } = setup();

    fire(0, 'selectstart', RIGHT);
    fire(0, 'selectend', RIGHT);
    fire(1, 'selectstart', LEFT_HAND);

    expect(ptt).toEqual([]);
  });

  it('the right controller going to sleep does not end the hold', () => {
    const { ptt, fire } = setup();
    fire(1, 'selectstart', LEFT);

    fire(0, 'disconnected', RIGHT);

    expect(ptt).toEqual([true]);
  });

  it('the left controller going to sleep ends the hold', () => {
    const { ptt, fire } = setup();
    fire(1, 'selectstart', LEFT);

    fire(1, 'disconnected', LEFT);

    expect(ptt).toEqual([true, false]);
  });

  it('the headset being taken off or the system menu opening ends the hold', () => {
    const { ptt, fire, startSession } = setup();
    const session = startSession();
    fire(1, 'selectstart', LEFT);

    session.visibilityState = 'hidden';
    session.dispatchEvent(new Event('visibilitychange'));

    expect(ptt).toEqual([true, false]);
  });

  it('the session ending ends the hold', () => {
    const { ptt, fire, startSession, endSession } = setup();
    startSession();
    fire(1, 'selectstart', LEFT);

    endSession();

    expect(ptt).toEqual([true, false]);
  });

  it('the trigger on a button presses the button instead of starting to listen', () => {
    const { ptt, actions, fire } = setup({ hitTest: () => 'close-message' });

    fire(1, 'selectstart', LEFT);
    fire(1, 'selectend', LEFT);

    expect(actions).toEqual(['close-message']);
    expect(ptt).toEqual([]);
  });

  it('the trigger away from any button still starts listening', () => {
    const { ptt, actions, fire } = setup({ hitTest: () => null });

    fire(1, 'selectstart', LEFT);
    fire(1, 'selectend', LEFT);

    expect(ptt).toEqual([true, false]);
    expect(actions).toEqual([]);
  });

  it('remembers which grip belongs to the left controller', () => {
    const { controls, grips, fire } = setup();

    fire(1, 'connected', LEFT);
    expect(controls.leftGrip).toBe(grips[1]);

    fire(1, 'disconnected', LEFT);
    expect(controls.leftGrip).toBe(null);
  });
});
