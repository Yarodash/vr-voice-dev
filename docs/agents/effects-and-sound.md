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
effects.groundHit(point)                   // bullet in the ground: smoke.impact dust only
effects.tracer(from, dir, speed, g, maxLen) -> id   // tracer.js, curved (gravity)
effects.tracerLand(id, along)              // bullet stopped `along` m down the barrel line
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
at scene start (not on first shot). Smoke cap 200 puffs, tracer cap 32 bullets (oldest replaced).
- smoke: `muzzle(pos, dir)`, `setMuzzle(pos|null)`, `eject(pos, right, up)`,
  `impact(point, normal)`, `update(dt)`, `dispose()`. Lit by the sunset sun from +X, wind to −X.
- tracer: `fire(from, dir, speed, g, maxLen) -> id`, `land(id, along)`, `update(dt)`, `dispose()`.
  Camera-facing strips (16 segments) built in the vertex shader along the parabola
  `from + dir·s − (0, k·s², 0)`, `k = g/(2v²)` (attribute `aGrav`) — the same path the bullet in
  shooting.js flies; head advances `speed·dt` with the same dt clamp (0.05) as the bullet, so it
  is where the bullet is. Streak = 2.2 m at 420 m/s (scales with speed), trail ≤ 120 m behind the
  head, dissipates after `land`.
- Custom fragment shaders end with `#include <colorspace_fragment>` (and `toneMapped: false`
  where colours are final). Without it colours are wrong in the headset and in screenshots.

AK flash (scene/main.js `flash`): one merged mesh (3 crossed planes + disc), additive canvas
gradient texture, visible 45 ms after a shot at the shooter's muzzle (`placeFlash`).

## sound.js

```js
export const SOUND_VERSION = 28;     // bump when the returned object must be rebuilt
export const GUN_FILES = { pistol: ['pistolB1', 'pistolB2'], ak: ['ak1', 'ak2', 'ak3'] };
const sound = createSound();          // lives in __sceneState.sound
sound.version
sound.update(camera)                  // listener = head + watchdog; called every frame from scene/main.js
sound.setWeapon('pistol' | 'ak')      // what shot() without kind sounds like
sound.shot({ kind, position })        // sample (random variant, ±3 % pitch) or baked-synth fallback
sound.hit(position) / shatter(position) / tink(position) / zap(position, strength) / powerDown(position)
sound.bolt(position, 'open' | 'close' | 'cycle')   // AWP bolt (mech pool)
sound.stats()                         // {contextState, pools:{gun,impact,mech,small:{active,fading}}, liveNodes, played, stolen, skipped, resumes, nanResets, …}
sound.previewFile(name) -> Promise<duration|null>   // raw file at the listener (sound board)
```
Lifecycle: scene/main.js does
`if (shared.sound?.version !== SOUND_VERSION) shared.sound = createSound();` before
`createShooting` (shooting.js captures `shared.sound` once). `shared.audioGraph` holds the
`AudioContext`, `master` (engine-sound.js connects here too), `reverbSend`, the output bus
(`busVersion`) and the voice pools (`poolVersion`); they are reused across `SOUND_VERSION`s and
rebuilt only when `BUS_VERSION` / `POOL_VERSION` change. `shared.soundBank` = decoded samples +
baked synth, keyed by `GUN_FILES` + `BAKE_VERSION` + sample rate.

**RULE for any new sound (weapon, enemy, effect, in any file):** never build nodes per play (no
new oscillators/filters/WaveShapers/PannerNodes per event) — bake synth sounds once into
AudioBuffers (OfflineAudioContext, cached in `__sceneState`), play them through a fixed voice
pool (persistent gain+panner; a play creates only a BufferSource), pre-mix multi-layer sounds
into one buffer, rate-limit frequent sounds. Verify: node creation during play stays ≈ 1 source
+ 1 gain per sound. (2026-11-17 robodog-sound.js built ~275 nodes/s and cut all game audio.)

Design (rapid fire used to break audio: ~11–24 new nodes + an HRTF panner per sound, never
disconnected, 2.8 ms main thread per AK shot+hit+tink on Quest, and a compressor that barely
limited so overlaps hard-clipped):
- **No per-sound synthesis.** Every synth recipe (`RECIPES`: hit, shatter, tink, zap, powerDown,
  synth gun fallback, pistol crack/ring) is rendered once into buffers with `OfflineAudioContext`
  (`BAKES`: several random variants each). Pistol samples get the highshelf + crack baked in.
- **Voice pools** (`POOLS`, `{size, max, minAge}`): permanent chains built once — `gun` (16/12,
  near-field stereo + HRTF crossfade, near reverb via one shared 30 ms delay), `impact` (12/10,
  HRTF: hit, shatter, zap, powerDown), `mech` (4/3, equalpower: AWP bolt), `small` (6/4,
  equalpower: casings). Robodogs have their own pool in `robodog-sound.js` (`__sceneState.dogVoices`).
  Per sound only `AudioBufferSourceNode` + a gain are created and disconnected in `onended`. When
  `max` voices sound, the oldest is stolen (60 ms fade) only if older than `minAge` (already in its
  quiet tail) and never the newest; otherwise the sound plays above `max` while free chains remain.
  One sound = one voice: multi-layer sounds are pre-mixed (AWP = `bank.awp`, baked from AK samples
  + `awpBoom` in `bakeAwp`).
- **Output**: master → DynamicsCompressor (−2 dB, knee 6, ratio 10, attack 3 ms, release 200 ms)
  → trim (cancels Chromium's auto makeup ×1.04) → WaveShaper soft clip → destination. Measured
  offline: unity below 0.5, 1 → 0.90, 8 → 0.99; never collapses.
- **Watchdog** in `update()` every 0.5 s: resume a `suspended`/`interrupted` context; an analyser
  after the compressor checks for NaN (it would silence the compressor forever) → rebuild bus +
  pools. All positions/params are `Number.isFinite`-guarded; bad listener matrices are skipped.
- Every public method is wrapped (`safe`) — sound must never break a shot.

Gotchas: bump `SOUND_VERSION` for any change in `createSound`; bump `BAKE_VERSION` when a
recipe changes, `BUS_VERSION` / `POOL_VERSION` when the output or voice chains change. New sound
= add a recipe + a `BAKES` entry + a method calling `play(pool, pick(bank.fx.name), {...})`; do
not build node graphs per call. Verify rapid fire with master muted (`audioGraph.master.gain`)
and `sound.stats()` staying bounded.
