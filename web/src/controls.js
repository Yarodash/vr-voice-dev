// The primary Touch controller (left by default; the scene's «Настройки ▸ Основная рука» makes it the
// right one, localStorage 'vr.primaryHand'): holding Y (B on the right) records, the trigger presses
// the on-screen button the ray points at, the other buttons are plain actions (see ControlMapper).
// The other controller is left to the scene (its trigger steadies the gun with both hands).
import { ControlMapper } from './control-mapper.js';

// A tracked hand can also fire these events (pinch); only real controllers count.
const isPad = (source) => Boolean(source && source.gamepad && !source.hand && (source.handedness === 'left' || source.handedness === 'right'));

// hitTest(): the action of the on-screen button the controller points at right now, or null.
// onStick(x, y): the thumbstick every frame (right and down are positive).
// getMapper(): the button map the scene has set, or null: then the built-in one is used.
// getPrimaryHand(): 'left' | 'right' — which controller all of this listens to.
export function createControls({
  renderer, scene, onPtt, onAction, onStick = () => {}, getMapper = () => null, hitTest = () => null,
  getPrimaryHand = () => 'left',
}) {
  const builtInMapper = new ControlMapper();
  let holding = false;
  const pads = { left: null, right: null }; // { grip, controller } of each connected controller
  const isPrimaryPad = (source) => isPad(source) && source.handedness === getPrimaryHand();

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
    controller.addEventListener('selectstart', (event) => isPrimaryPad(event.data) && click());
    controller.addEventListener('connected', (event) => {
      if (isPad(event.data)) pads[event.data.handedness] = { grip, controller };
    });
    // The release of Y never arrives if the primary controller falls asleep mid-sentence. The other
    // controller (or a tracked hand) disappearing must not cut the sentence short.
    controller.addEventListener('disconnected', (event) => {
      let wasPrimary = false;
      for (const hand of ['left', 'right']) {
        if (pads[hand]?.grip === grip) {
          pads[hand] = null;
          wasPrimary ||= hand === getPrimaryHand();
        }
      }
      if (!event.data || wasPrimary || isPrimaryPad(event.data)) release();
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
    // The primary controller's grip, or null while it is not tracked.
    get primaryGrip() {
      return pads[getPrimaryHand()]?.grip ?? null;
    },
    // The primary controller's pointing ray (its -Z axis), or null while it is not tracked.
    get primaryController() {
      return pads[getPrimaryHand()]?.controller ?? null;
    },
    // The primary hand has just changed: a recording held on the old one ends here.
    primaryChanged() {
      release();
    },
    tick(nowMs) {
      const session = renderer.xr.getSession();
      if (!session) return;
      for (const source of session.inputSources) {
        if (!isPrimaryPad(source)) continue;
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
