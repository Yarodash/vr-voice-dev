# Effects and sound

Files: `scene/effects.js` (owned by shooting.js: `createEffects({ THREE, group })`),
`scene/smoke.js`, `scene/tracer.js`, AK flash in `scene/main.js`, `scene/sound.js`.
Assets: `web/public/sounds/guns/*.ogg` (CC0, LICENSE.txt).

## shake.js — VR-safe screen shake

Comfort rule (Meta/Roblox comfort guides; Zulubo 2019 "VR screen shake: the art of not throwing
up"): never rotate the view, keep the horizon and gaze centre still, only "in/out" motion, short.
So the shake is a pure eye **translation** (mostly back along the head's view axis, 25 % up),
instant onset, exponential decay, per-frame amplitude noise (0.6–1×), no oscillation, no vignette.
Along-gaze translation leaves the gaze centre and far world still; only near things (gun, hands) "breathe".
- Applied only during the main render: `scene.onBeforeRender` (chained after fps/ipd, like
  `ipd-panel.js`) shifts the eye cameras' `matrixWorld` (XR: `cam.cameras[0..1]`; desktop: the
  camera), `onAfterRender` restores them. The rig, `vr.rig`, car-drive and recentre never see it;
  scope-lens passes strip the hooks, so the objective view is not shaken (the glass shakes with the world).
- Per gun (`SHAKE` in shake.js; `gun.shake` overrides; fallback big→awp, auto→ak, else pistol):
  pistol 6 mm/τ25 ms, AK 4 mm/τ20 ms capped 6 mm (no build-up in full auto), AWP 20 mm/τ40 ms.
  Level × 1 («Тряска: вкл»), × 2.5 («сильно»), 0 («выкл»), `localStorage 'scene.shake'`.
- Hooked in `fire()` (main.js): `shake.kick(heldItem.kind, gun)`.
- **Other systems**: `__sceneState.screenShake(strength 0..1, dirWorld?)` — same jolt, 20 mm × strength
  (× level, τ 35 ms, capped), along `dirWorld` (e.g. a bullet hitting the player) or back along gaze
  without it. Respects the toggle. Debug: `__sceneState.shakeDebug.kick(kind, gun)`.

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
gravity, drag, scale0, scale1, quaternion, spin, fadePower})`: particles are drawn in batches —
one `InstancedMesh` (named `fx-particles`) per (geometry, additive) pair with per-instance colour
and opacity (`aOpacity`, patched MeshBasicMaterial, cache key `fx-particle-opacity`), at most 256
per batch; an empty batch is hidden after 3 warm-up frames. A new geometry in `spawn` gets its own
batch lazily (its shader then compiles on first use — add it to the `batchOf(...)` list at setup).

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

Mana bolts (`scene/mana.js`, owned by shooting.js, gun field `projectile: 'mana'`): one
InstancedBufferGeometry quad + one additive ShaderMaterial (camera-facing sprites, kinds 0 orb
core+glow, 1 soft glow, 2 ring, 3 sparkle star), SoA typed arrays, cap 32 orbs × (1 + 10 trail) +
360 particles, one draw call, 0 when idle. `fire(from, dir, speed, g, hex) -> id`, `land(id, t)`,
`muzzle(p, dir, hex)`, `impact(p, hex)`, `update(dt)` (same dt clamp as bullets, so the orb is where
the bullet is). Mana shots skip tracer, muzzle flash/smoke, casing, AK flash, metal sparks/dust and
`sound.hit`; any hit → `mana.impact` + `sound.manaHit`. Debug: `__sceneState.shooting.manaStats()`.

Black holes (`scene/blackhole.js`, owned by shooting.js, gun field `projectile: 'blackhole'` + `charge`):
hole quads with a premultiplied-alpha disc/lensing shader + one additive particle batch, sound in
`scene/blackhole-sound.js` (JS-baked buffers like drone-sound.js: fire whoomp+warble, collapse =
0.5 s reversed swell + boom, full-charge tick; looping rumble/whine voices). Details: recipes.md
«Black hole projectile».

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
sound.setWeapon('mana'); sound.shot() / sound.manaHit(position)   // mana gun (projectile 'mana'): baked «whoom-shing» (rising detuned saw 300→1200 Hz, bells 1:2.76:5.4:8.9, chorus tail, airy whoosh; no noise bang/thump), ±6 % pitch; hit = soft pop + falling bell cascade. Not baked yet → silent (never a gunshot). stats().lastShot shows which buffer played
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
  equalpower: casings). Robodogs have their own pool in `robodog-sound.js` (`__sceneState.dogVoices`);
  quadcopters in `drone-sound.js` (buffers computed in JS → `__sceneState.droneSoundBank`; 8 one-shot
  HRTF voices + 4 permanent looping rotor-hum voices in `__sceneState.droneVoices`, given to the 4
  nearest drones every 0.25 s; only position/gain/playbackRate change; bursts pre-mixed 3/4/5 rounds).
  Artillery: `artillery-sound.js` (JS-baked `__sceneState.artillerySoundBank`: boomNear/Mid/Far —
  distance tiers instead of a per-play low-pass — whistle, thump; voices `__sceneState.artilleryVoices`:
  6 boom HRTF, 4 whistle HRTF (moved with the shell), 3 thump equalpower).
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
