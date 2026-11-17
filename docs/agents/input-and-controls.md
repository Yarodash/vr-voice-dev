# Input and controls

Files: shell `web/src/controls.js`, `web/src/control-mapper.js` (built-in fallback map),
`web/src/pointer.js` (ray for preview buttons); scene `web/src/scene/controls-map.js`
(`ControlMap`, hot-swapped via `ctx.setMapper`), `web/src/scene/main.js` (reads buttons directly).

Only the **left** Touch controller is used. Right controller / hands are ignored
(`isLeftPad = handedness 'left' && gamepad && !hand`).

## Button indices (xr-standard gamepad)

| Index | Name (user's word) | Who uses it |
|---|---|---|
| 0 | курок (trigger) | scene: fire, clay grab/throw, panel confirm, ray grab of a weapon at a distance (ray-grab.js); shell: `selectstart` presses preview buttons |
| 1 | хват (grip) | scene: grab/release/recalibrate; shell action `'grip'` closes the open wheel |
| 3 | Z (stick click) | IPD panel "as in headset"; otherwise free |
| 4 | X | scene: spawn clay in hand (`features.xPlate`) |
| 5 | Y | shell (via ControlMap): hold = record, tap = wheel, 3 taps = reload |
| 12 | «равно» ≡ | free (index measured, unconfirmed) |
| axes[2], axes[3] | stick x, y (right/down positive) | wheel sector; panels |

## Action map (`scene/controls-map.js`, live-swappable)

```js
export class ControlMap {
  step(nowMs, { buttons }) -> string[]   // buttons: boolean[] (pressed)
}
```
Actions the shell understands (`onAction` in `web/src/main.js` / `controls.js`):
`record-start`, `record-stop`, `record-cancel` (+`wheel-toggle` after a Y tap < 300 ms),
`wheel-toggle`, `grip`, `reload`, `send`, `delete`, `send-draft`, `cancel-draft`.
A new action name needs a shell edit. `setMapper` copies `previous` (held buttons) to the new map.

Wheel note: `wheel-toggle` opens the wheel or confirms the hovered sector; the shell does not
handle a plain `'trigger'` action, so in code the trigger does not confirm wheel sectors
(CLAUDE.md text may say otherwise).

## Reading buttons in the scene

```js
const session = renderer.xr.getSession();
let source;
for (const s of session?.inputSources ?? []) {
  if (s.handedness === 'left' && s.gamepad && !s.hand) { source = s; break; }
}
const gripDown = Boolean(source?.gamepad.buttons[GRIP_BUTTON]?.pressed);
const gripPressed = gripDown && !gripWasDown;   // rising edge; set gripWasDown = gripDown later
const x = source?.gamepad?.axes?.[2] ?? 0;      // stick
```
Keep `…WasDown` state in the `setup` closure. Initialise to `true` when a button held during a
swap must not fire (`let xWasDown = true`).

Haptics: `source?.gamepad?.hapticActuators?.[0]?.pulse?.(strength0to1, ms)` (`buzz` in main.js).

## Gating (who owns the buttons this frame)

- `menuIsOpen` (scene/main.js) = wheel open now **or last frame** **or** `ipd.busy()` **or**
  `laserPanel.busy()`. While true: no grabbing/releasing, no X spawn, clays don't throw.
- Firing also checks `!panelBusy && !laserPanel.blocksFire()`.
- Panels expose `busy()` = open, or the button that opened/closed them is still held
  (`releaseFirst` / `gripLock`). New modal UI must add itself to `menuIsOpen`.
- Hand exclusivity: weapon, clay, recalibrating weapon, text board (`textTest.held`), weapon held
  by the ray (`rayGrab.item`, ray-grab.js; stick Y is its push/pull then). The nearest
  search runs only when all are free; `textTest.update` gets `handBusy`.

## Controller model and axes

- Real Touch model: `XRControllerModelFactory` on the grip (`showController`), kept across swaps
  in `shared.realModel`; hidden while a weapon is held (`realModel.visible = !heldItem`).
- Axes group `scene-pad-axes` (invisible unless `SHOW_AXES`): red +X right, green −Z forward,
  blue +Y up out of the face plate. Built from the **ray** space orientation, turned −40° about X,
  offset `AXES_RED_M`, `AXES_LIFT_M`. Weapon seating, clay seating and the wheel position derive
  from it (`ctx.pointerAim.object = axes`).
- User convention for shifting held items: along the item's own axes; "вниз" = against blue.
  `PISTOL_SHIFT` (x red, y blue, z against green), currently `(0, -0.05, 0)`.
- **Inertia** (`Настройки ▸ Инерция: вкл/выкл`, keepOpen; `shared.inertia`, localStorage
  `scene.inertia` `'on'/'off'`, default off): `scene/inertia.js`, One Euro filter (position vector +
  quaternion slerp, adaptive cutoff from speed; constants `INERTIA` at the top). In `update`,
  right after `handPosition` is read, `inertia.apply(hand, gripWorld, realDt)` replaces `gripWorld`
  with the filtered pose (filtered in rig space = `hand.matrix`, so a moving car doesn't lag). So
  held weapons, muzzle/aim/laser/shot, held clay and relatively grabbed panels are filtered;
  `handPosition` stays raw (near search, clay throw). Bench handle: `__sceneState.inertiaDebug.make()`
  → `{ step(pos, quat, dt), pos, quat }`. Measured (synthetic 90 Hz): tremor RMS −85 %, lag ≈ 56 ms
  at 0.1 rad/s, 18 ms at 1 rad/s, 9 ms at 3 rad/s.
