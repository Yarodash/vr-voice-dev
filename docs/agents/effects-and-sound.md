# Effects and sound

Files: `scene/effects.js` (owned by shooting.js: `createEffects({ THREE, group })`),
`scene/smoke.js`, `scene/tracer.js`, AK flash in `scene/main.js`, `scene/sound.js`.
Assets: `web/public/sounds/guns/*.ogg` (CC0, LICENSE.txt).

## effects.js

```js
const effects = createEffects({ THREE, group });
effects.muzzleFlash(position, direction)   // core + petals + sparks + smoke.muzzle + flash light
effects.setMuzzle(position|null)           // per frame: smoke wisp follows the current muzzle
effects.eject(position, right, up)         // brass casing + ejection-port smoke
effects.impact(point, normal)              // sparks + glow + impact dust
effects.dust(point)                        // clay dust cloud
effects.tracer(from, to)                   // tracer.js
effects.update(dt); effects.dispose()
```
Only shooting.js holds `effects`; scene code reaches it via `shooting.shoot/aim/puff`.
Generic particles use `spawn(geometry, {color, additive, opacity}, position, {life ms, velocity,
gravity, drag, scale0, scale1, quaternion, spin, fadePower})`: one `Mesh` + one new
`MeshBasicMaterial` per particle (legacy; fine for tens of particles per shot, avoid for
continuous emitters). Geometries (`sphere`, `cone`, `unitBox`, casing) are shared.

**One permanent `PointLight`** (`flashLight`), intensity animated. Never add/remove lights at
runtime: three recompiles every lit shader (frame hitch).

## smoke.js / tracer.js (the efficient pattern)

Both are one `InstancedBufferGeometry` + one custom `ShaderMaterial`, CPU particle state in
typed arrays (struct-of-arrays, live ones first `count`), no allocations per frame,
`DynamicDrawUsage` attributes with `clearUpdateRanges()/addUpdateRange()`,
`geometry.instanceCount = n` (0 = no draw call), `frustumCulled = false` so the shader compiles
at scene start (not on first shot). Smoke cap 200 puffs, tracer cap 12 bullets (oldest replaced).
- smoke: `muzzle(pos, dir)`, `setMuzzle(pos|null)`, `eject(pos, right, up)`,
  `impact(point, normal)`, `update(dt)`, `dispose()`. Lit by the sunset sun from +X, wind to −X.
- tracer: `fire(from, to)`, `update(dt)`, `dispose()`. Camera-facing quads built in the vertex
  shader; 190 m/s visual speed; streak + fading trail.
- Custom fragment shaders end with `#include <colorspace_fragment>` (and `toneMapped: false`
  where colours are final). Without it colours are wrong in the headset and in screenshots.

AK flash (scene/main.js `flash`): one merged mesh (3 crossed planes + disc), additive canvas
gradient texture, visible 45 ms after a shot at the shooter's muzzle (`placeFlash`).

## sound.js

```js
export const SOUND_VERSION = 20;     // bump when the returned object must be rebuilt
export const GUN_FILES = { pistol: ['pistolB1', 'pistolB2'], ak: ['ak1', 'ak2', 'ak3'] };
const sound = createSound();          // lives in __sceneState.sound
sound.version
sound.update(camera)                  // listener = head + watchdog; called every frame from scene/main.js
sound.setWeapon('pistol' | 'ak')      // what shot() without kind sounds like
sound.shot({ kind, position })        // sample (random variant, ±3 % pitch) or baked-synth fallback
sound.hit(position) / shatter(position) / tink(position) / zap(position, strength) / powerDown(position)
sound.stats()                         // {contextState, pools:{gun,fx,small:{active,fading}}, liveNodes, played, stolen, skipped, resumes, nanResets, …}
sound.previewFile(name) -> Promise<duration|null>   // raw file at the listener (sound board)
```
Lifecycle: scene/main.js does
`if (shared.sound?.version !== SOUND_VERSION) shared.sound = createSound();` before
`createShooting` (shooting.js captures `shared.sound` once). `shared.audioGraph` holds the
`AudioContext`, `master` (engine-sound.js connects here too), `reverbSend`, the output bus
(`busVersion`) and the voice pools (`poolVersion`); they are reused across `SOUND_VERSION`s and
rebuilt only when `BUS_VERSION` / `POOL_VERSION` change. `shared.soundBank` = decoded samples +
baked synth, keyed by `GUN_FILES` + `BAKE_VERSION` + sample rate.

Design (rapid fire used to break audio: ~11–24 new nodes + an HRTF panner per sound, never
disconnected, 2.8 ms main thread per AK shot+hit+tink on Quest, and a compressor that barely
limited so overlaps hard-clipped):
- **No per-sound synthesis.** Every synth recipe (`RECIPES`: hit, shatter, tink, zap, powerDown,
  synth gun fallback, pistol crack/ring) is rendered once into buffers with `OfflineAudioContext`
  (`BAKES`: several random variants each). Pistol samples get the highshelf + crack baked in.
- **Voice pools** (`POOLS`): permanent chains built once — `gun` (10 voices, 7 sounding; near-field
  stereo + HRTF crossfade, near reverb via one shared 30 ms delay), `fx` (10/8, HRTF), `small`
  (4/3, equalpower, casings). Per sound only `AudioBufferSourceNode` + a gain are created and
  disconnected in `onended`. Over the cap the oldest voice fades in 20 ms (`steal`) and the new
  sound takes another free voice.
- **Output**: master → DynamicsCompressor (−3 dB, knee 3, ratio 12, attack 2 ms, release 100 ms)
  → trim (cancels Chromium's auto makeup) → WaveShaper soft clip → destination. Measured offline:
  unity below 0.5, +18 dB of overlap → 0.93; never collapses.
- **Watchdog** in `update()` every 0.5 s: resume a `suspended`/`interrupted` context; an analyser
  after the compressor checks for NaN (it would silence the compressor forever) → rebuild bus +
  pools. All positions/params are `Number.isFinite`-guarded; bad listener matrices are skipped.
- Every public method is wrapped (`safe`) — sound must never break a shot.

Gotchas: bump `SOUND_VERSION` for any change in `createSound`; bump `BAKE_VERSION` when a
recipe changes, `BUS_VERSION` / `POOL_VERSION` when the output or voice chains change. New sound
= add a recipe + a `BAKES` entry + a method calling `play(pool, pick(bank.fx.name), {...})`; do
not build node graphs per call. Verify rapid fire with master muted (`audioGraph.master.gain`)
and `sound.stats()` staying bounded.
