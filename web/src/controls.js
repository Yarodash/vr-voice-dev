// Left Touch controller: the trigger is push-to-talk (or a click when it points at a button),
// the other buttons go through ControlMapper.
import { ControlMapper } from './control-mapper.js';

// A tracked hand can also fire "select" (pinch); only the real left controller counts.
const isLeftPad = (source) => Boolean(source && source.handedness === 'left' && source.gamepad && !source.hand);

// hitTest(): the action of the on-screen button the controller points at right now, or null.
export function createControls({ renderer, scene, onPtt, onAction, hitTest = () => null }) {
  const mapper = new ControlMapper();
  let holding = false;
  let clicking = false; // this trigger press went to a button, not to the microphone
  let leftGrip = null;
  let leftController = null;

  const press = () => {
    const action = hitTest();
    if (action) {
      clicking = true;
      onAction(action);
    } else if (!holding) {
      holding = true;
      onPtt(true);
    }
  };
  const release = () => {
    clicking = false;
    if (holding) {
      holding = false;
      onPtt(false);
    }
  };

  // three.js fills controller slots in connection order, not by hand, so listen on both.
  for (const index of [0, 1]) {
    const controller = renderer.xr.getController(index);
    const grip = renderer.xr.getControllerGrip(index);
    controller.addEventListener('selectstart', (event) => isLeftPad(event.data) && press());
    controller.addEventListener('selectend', (event) => isLeftPad(event.data) && release());
    controller.addEventListener('connected', (event) => {
      if (isLeftPad(event.data)) {
        leftGrip = grip;
        leftController = controller;
      }
    });
    // "selectend" never arrives if the left controller falls asleep mid-sentence. The other
    // controller (or a tracked hand) disappearing must not cut the sentence short.
    controller.addEventListener('disconnected', (event) => {
      if (leftGrip === grip) {
        leftGrip = null;
        leftController = null;
      }
      if (!event.data || isLeftPad(event.data)) release();
    });
    scene.add(controller, grip);
  }
  renderer.xr.addEventListener('sessionend', release);
  // Headset taken off or the system menu opened: input stops arriving, so let go of the "key".
  renderer.xr.addEventListener('sessionstart', () => {
    const session = renderer.xr.getSession();
    session?.addEventListener('visibilitychange', () => {
      if (session.visibilityState !== 'visible') release();
    });
  });

  return {
    get leftGrip() {
      return leftGrip;
    },
    // The left controller's pointing ray (its -Z axis), or null while it is not tracked.
    get leftController() {
      return leftController;
    },
    tick(nowMs) {
      const session = renderer.xr.getSession();
      if (!session) return;
      for (const source of session.inputSources) {
        if (!isLeftPad(source)) continue;
        const state = {
          buttons: source.gamepad.buttons.map((button) => button.pressed),
          axes: [...source.gamepad.axes],
        };
        for (const action of mapper.step(nowMs, state)) onAction(action);
      }
    },
  };
}
