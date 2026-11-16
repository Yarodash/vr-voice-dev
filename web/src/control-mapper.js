// Left Touch controller (xr-standard gamepad) -> actions. The trigger is handled separately
// through WebXR select events, because only those count as a user gesture.
const GRIP = 1;
const STICK_CLICK = 3;
const X = 4;
const Y = 5;
const STICK_Y = 3; // axes index; negative is "up"

export class ControlMapper {
  constructor({ holdMs = 1000, threshold = 0.6, repeatMs = 200 } = {}) {
    this.holdMs = holdMs;
    this.threshold = threshold;
    this.repeatMs = repeatMs;
    this.previous = [];
    this.stickDirection = null;
    this.stickEmittedAt = 0;
    this.clickStartedAt = null;
    this.clickFired = false;
  }

  step(nowMs, { buttons, axes }) {
    const actions = [];
    const pressed = (index) => Boolean(buttons[index]);
    const rising = (index) => pressed(index) && !this.previous[index];

    if (rising(X)) actions.push('enter');
    if (rising(Y)) actions.push('esc');

    const y = axes[STICK_Y] ?? 0;
    const direction = y < -this.threshold ? 'up' : y > this.threshold ? 'down' : null;
    if (direction && (direction !== this.stickDirection || nowMs - this.stickEmittedAt >= this.repeatMs)) {
      actions.push(`${pressed(GRIP) ? 'arrow' : 'scroll'}-${direction}`);
      this.stickEmittedAt = nowMs;
    }
    this.stickDirection = direction;

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
      // released before the long press fired: a short click
      if (this.clickStartedAt !== null && !this.clickFired) actions.push('recenter');
      this.clickStartedAt = null;
    }

    this.previous = [...buttons];
    return actions;
  }
}
