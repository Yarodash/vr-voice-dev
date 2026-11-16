# HUD, message windows, bullet holes, render orders

Files: shell `web/src/main.js` (HUD group, dot, message pool, `applyHud`), shell
`web/src/message-panel.js` (one window: canvas 1600×640 -> `CanvasTexture`),
`web/src/ui-layout.js` (`MESSAGE` layout), scene `scene/hud.js` (`HUD_CONFIG`, live),
scene `scene/message-holes.js`, scene `scene/fps.js` and `scene/score.js` (attach to the HUD),
scene `scene/text-test.js` (in progress).

## Shell HUD structure

`camera` (inside `rig`) -> `hud` group at `(HUD.x, HUD.y, -distance)` scaled by
`distanceM / 0.8` -> children:
- `triggerDot`: `CircleGeometry(0.014)`, `renderOrder 1001`. This is how scene code finds the HUD
  group: the camera child that contains a `CircleGeometry`.
- 8 message panels (pool): `PlaneGeometry(0.55, …)` with a `CanvasTexture`; newest lowest;
  `mesh.userData.message = { id, text, from?: 'user'|'draft', warning? }`.
  `renderOrder 1000`, no depth (or `-10` + depth write + `alphaTest` when `occluded: true`).
- Scene additions: FPS label (`scene-fps`, under the dot), score plate (`scene-score`).

Message kinds: Claude answers (`/say`), the user's sent phrase (`from: 'user'`), the unsent
preview (`from: 'draft'`, light green, with cross and send buttons pressed by the trigger ray).
Only one window is repainted per frame (each upload of 1600×640 costs ~10 ms on Quest).

## scene/hud.js (live, via ctx.setHud)

```js
export const HUD_CONFIG = {
  maxShown: 4, opacity: [1, 1, 0.7, 0.45], windowTopM: 0.1056, sideShift: 1 / 14,
  distanceM: 1.0, dotShiftM: -0.12, occluded: true,
  dot: { idle, waiting, recording, pending, ready, sent, cancelled },   // 0xRRGGBB
};
```
Any field may be omitted. Changing message window *drawing* is a shell edit (reload).

## Attaching scene objects to the HUD

```js
let hud = null;
const place = () => {                                  // call from update(); cheap after first find
  if (hud && hud.parent === camera) return;
  hud = camera.children.find((g) => g.children?.some((c) => c.geometry?.type === 'CircleGeometry')) ?? null;
  if (!hud) return;
  for (const old of hud.children.filter((c) => c.name.startsWith('scene-myplate') && c !== mesh)) hud.remove(old);
  hud.add(mesh);
};
// material: { transparent: true, toneMapped: false, depthTest: false }, mesh.renderOrder = 1001
// dispose(): mesh.removeFromParent(); geometry/material/texture.dispose()
```
Objects under the camera are outside `root`: the host will not remove them.

## message-holes.js (bullet holes in message windows)

`createMessageHoles({ THREE, camera })` -> `{ hit(origin, dir) -> boolean, update(), dispose() }`.
Patches the **shell's** panel materials without editing the shell:
- Finds panels under the camera (`PlaneGeometry` width > 0.3 with a `CanvasTexture`), refreshed
  at most once per second.
- `material.onBeforeCompile` injects a loop over a `MAX × 2` float `DataTexture` of holes
  (discard + charred edge + cracks) before `#include <opaque_fragment>`.
- `material.customProgramCacheKey = () => \`message-holes-shared-${MAX}-r4\``.
  **Bump the `-rN` suffix whenever the injected GLSL changes**: three.js caches compiled programs
  by this key and does not call `onBeforeCompile` again, so the old shader would stay.
- Uniforms/texture live on `material.userData.holesShared` (not in the scene closure) so a new
  scene version keeps feeding the program compiled by an older version.
- Original hooks are kept in `material.userData.holesBase` so patches don't stack; `dispose()`
  restores them only if this version still owns the material (`holesOwner`).
- Holes belong to the message (key `id:hash(text)` from `mesh.userData.message`), not the pool
  slot. Fallback pixel hash uses a 64×26 scratch canvas — never `getImageData` on the shell's
  window canvas (switches it to software mode: every later upload ~10 ms instead of ~0.2 ms).
- Persisted to `scene.messageHoles3` with a 1 s debounce; `hit()` never throws.

## Render order reference

| renderOrder | What | depthTest |
|---|---|---|
| -999 | stars | |
| -10 | message windows when `occluded` | yes, writes depth |
| 1–3 | decals 1, smoke 2, AK flash 2, tracers 3 | yes, no depth write |
| 5, 6 | laser beam, laser dot | yes, no write |
| 900 | sky dome; radial wheel (depthTest false) | |
| 940 | laser colour panel | yes |
| 950 | IPD panel | false |
| 1000 | message windows (default) | false |
| 1001 | dot, FPS label, score plate/popup | false |

## Text test board (text-test.js) — hidden (tool kept)

Not created any more (stub in scene/main.js). Outcome: message windows now use 2× canvas + trilinear
mipmaps + anisotropy 16 + LOD bias −0.5 (`SCALE`, `LOD_BIAS` in web/src/message-panel.js; the bias is a
`map_fragment` patch in the panel material's onBeforeCompile, which message-holes.js chains).


World-space board comparing 12 text-rendering variants (mipmaps, anisotropy, 2× canvas,
weight, colours, LOD bias via `onBeforeCompile` + `customProgramCacheKey`
`text-test-lodbias-${bias}`). Text density matches message windows (2909 px/m). Grabbed with
relative grab. Findings from it should feed back into `message-panel.js` (shell edit).
