// Left Touch controller: holding Y records, the trigger presses the on-screen button the ray
// points at, the other buttons are plain actions (see ControlMapper).
import { ControlMapper } from './control-mapper.js';

// A tracked hand can also fire these events (pinch); only the real left controller counts.
const isLeftPad = (source) => Boolean(source && source.handedness === 'left' && source.gamepad && !source.hand);

// hitTest(): the action of the on-screen button the controller points at right now, or null.
// onStick(x, y): the thumbstick every frame (right and down are positive).
// getMapper(): the button map the scene has set, or null: then the built-in one is used.
export function createControls({
  renderer, scene, onPtt, onAction, onStick = () => {}, getMapper = () => null, hitTest = () => null,
}) {
  const builtInMapper = new ControlMapper();
  let holding = false;
  let leftGrip = null;
  let leftController = null;

  const press = () => {
    if (!holding) {
      holding = true;
      onPtt(true);
    }
  };
  const release = () => {
    if (holding) {
      holding = false;
      onPtt(false);
    }
  };
  const click = () => {
    // the ray is on a button of a window: press it; otherwise it is a plain trigger press
    onAction(hitTest() ?? 'trigger');
  };

  // three.js fills controller slots in connection order, not by hand, so listen on both.
  for (const index of [0, 1]) {
    const controller = renderer.xr.getController(index);
    const grip = renderer.xr.getControllerGrip(index);
    // Recording is not on the trigger: every click on a button would start it.
    controller.addEventListener('selectstart', (event) => isLeftPad(event.data) && click());
    controller.addEventListener('connected', (event) => {
      if (isLeftPad(event.data)) {
        leftGrip = grip;
        leftController = controller;
      }
    });
    // The release of Y never arrives if the left controller falls asleep mid-sentence. The other
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
        for (const action of (getMapper() ?? builtInMapper).step(nowMs, state)) {
          if (action === 'record-start') press();
          else if (action === 'record-stop') release();
          else if (action === 'record-cancel') {
            release(); // a short press: the recording stops like any other, then the page throws it away
            onAction(action);
          } else onAction(action);
        }
        onStick(state.axes[2] ?? 0, state.axes[3] ?? 0);
      }
    },
  };
}
