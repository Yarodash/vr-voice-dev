// Left Touch controller (xr-standard gamepad) -> actions.
//   Y (hold)            record: 'record-start' on press, 'record-stop' on release
//   X                   'send'
//   grip                'delete'
//   stick click, 1 s    'reload'
// The trigger is not here: it clicks on-screen buttons through WebXR select events.
const GRIP = 1;
const STICK_CLICK = 3;
const X = 4;
const Y = 5;

export class ControlMapper {
  constructor({ holdMs = 1000 } = {}) {
    this.holdMs = holdMs;
    this.previous = [];
    this.clickStartedAt = null;
    this.clickFired = false;
  }

  step(nowMs, { buttons }) {
    const actions = [];
    const pressed = (index) => Boolean(buttons[index]);
    const rising = (index) => pressed(index) && !this.previous[index];
    const falling = (index) => !pressed(index) && Boolean(this.previous[index]);

    if (rising(Y)) actions.push('record-start');
    if (falling(Y)) actions.push('record-stop');
    if (rising(X)) actions.push('send');
    if (rising(GRIP)) actions.push('delete');

    if (pressed(STICK_CLICK)) {
      if (rising(STICK_CLICK)) {
        this.clickStartedAt = nowMs;
        this.clickFired = false;
      }
      if (!this.clickFired && this.clickStartedAt !== null && nowMs - this.clickStartedAt >= this.holdMs) {
        actions.push('reload');
        this.clickFired = true;
      }
    } else {
      this.clickStartedAt = null;
    }

    this.previous = [...buttons];
    return actions;
  }
}
