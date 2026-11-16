# World-space panels with stick input

Files: `scene/ipd-panel.js` (`Настройки ▸ Расстояние между глазами`), `scene/laser-panel.js`
(`Цвет прицела` in the weapon menu). Both: a canvas texture on a plane in `root`, opened in front
of the head, driven by the stick/trigger/grip, reporting `busy()` so the scene stops using those
buttons. Use them as templates ([recipes.md](recipes.md#world-space-panel-with-stick-input)).

## Shared shape

```js
const panel = createXPanel({ THREE, renderer, camera, root, shared /*, scene */ });
panel.open()            // place DISTANCE_M in front (yaw only), paint, releaseFirst = true
panel.close()
panel.isOpen            // getter
panel.busy()            // open || a button that opened/closed it is still held
panel.update(source, menuOpen)   // every frame from scene/main.js, BEFORE menuIsOpen is computed
panel.dispose()
```

Common techniques:
- Canvas `W×H` (1024×576), `CanvasTexture` with `colorSpace = SRGBColorSpace`,
  `anisotropy = renderer.capabilities.getMaxAnisotropy()`, `MeshBasicMaterial({ map,
  transparent: true, toneMapped: false })`.
- Repaint only when the visual state changes: build a key string, compare with `painted`.
- Stick with hysteresis: `dir = x > STICK_ON ? 1 : x < -STICK_ON ? -1 : |x| < STICK_OFF ? 0 :
  previous` (ON 0.5–0.6, OFF 0.3); act on change of `dir`; IPD adds auto-repeat
  (`REPEAT_DELAY_MS 400`, `REPEAT_EVERY_MS 80`).
- `releaseFirst`: the button that confirmed the wheel item is still down when the panel opens;
  ignore input until it is released. Closing by trigger/grip sets it again so that press doesn't
  fire/grab/release.
- While the wheel is open (`menuOpen`), ignore the stick (it belongs to the wheel).
- Haptic tick on change: `source?.gamepad?.hapticActuators?.[0]?.pulse?.(0.15, 15)`.

## IPD panel specifics

- Hooks `scene.onBeforeRender` (after fps.js; disposed before fps.js). Inside, when the camera
  is an XR `ArrayCamera` with 2 eyes, it shifts both eye `matrixWorld`s along the inter-eye line
  by half the difference from the native IPD and recomputes `matrixWorldInverse`. Native IPD is
  re-read every frame (no accumulation).
- Values: `shared.ipdMm` (null = native), `shared.ipdNativeMm`; `localStorage 'scene.ipdMm'`,
  50–80 mm, step 0.5. Stick ←/→ change, Z = native, trigger or grip = done.
- `depthTest: false`, `renderOrder 950`, 0.36 m wide at 0.5 m.

## Laser colour panel specifics

- Opens only with a weapon in hand; closes automatically if the weapon leaves the hand.
- Selection by shooting: scene/main.js `fire()` calls `laserPanel.cast(muzzle, barrel)` then
  `laserPanel.shoot(source)`; every frame `cast` highlights the swatch under the barrel and its
  `point` feeds the laser dot. `cast` intersects the panel plane in local space and maps to
  canvas pixels (`rectOf(i)`).
- Stick ←/→/↑/↓ also moves the selection; grip or `Готово` closes; `blocksFire()` until the
  confirming trigger is released. Shots at the panel don't change the score.
- `depthTest: true` (the gun in front hides it), `renderOrder 940`, 0.8 m wide at 1.2 m.
- `shared.laserColor`, `localStorage 'scene.laserColor'`, `LASER_COLORS` (with `was` = old
  lighter value for migration).
