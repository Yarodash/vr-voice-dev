# Performance (Quest 3S, 120 Hz)

File: `scene/fps.js` (`TARGET_HZ = 120`, `createFps({ THREE, camera, renderer, scene })` ->
`{ beginFrame(), update(), dispose() }`). Shell settings in `web/src/main.js`: MSAA 4×,
foveation 0, framebuffer scale 1.0 (1.3 was too slow).

## Telemetry

Every 5 s the page logs (to `logs/page-console.log`, tagged `[quest]`):
```
[perf] hz=120 fps=119.0 avg=8.4ms worst=34.1ms slow=0% calls=74 tris=213k geo=40 tex=32 prog=38 xr=1 cpu=2.0/16.7ms rend=1.5ms gpu=-ms
```
`hz` display rate (fps.js requests 120 per session), `slow` % frames > 1.5× budget, `calls/tris`
per frame (both eyes), `geo/tex/prog` live counts (watch for leaks: they must not grow across
swaps), `cpu` = scene update + render on CPU avg/worst (from `fps.beginFrame()` at the start of
scene update to `scene.onAfterRender`), `rend` = `renderer.render` part. No GPU timer on Quest
(`gpu=-`). Baseline tonight: fps ~119, calls 70–100, tris ~215k, cpu ~2 ms, prog ~38.
A `worst` spike right after a swap means something in the swap path is not cached (see below);
repeated spikes are a bug. Each swap also logs `[swap] dispose=… setup=… compile=… prepare=…ms/Nfr
newProgs=N uploads=N` (and `sceneHost.lastSwap` has the same plus `freed`, `slow` steps).

## Scene swap (hot-reload) cost

Model: [scene-lifecycle.md](scene-lifecycle.md#contract) (prepare then commit; disposes held back
until the new scene draws, so programs/textures are reused). Measured 2026-11-17, Quest 3S:

| | before | after |
|---|---|---|
| whole swap task (dispose + `setup()` + precompile; blocks the main thread) | 550–680 ms (grass 36k blades ~420 ms, pistol model ~100 ms, smoke texture ~40 ms) | 25–40 ms |
| first frame(s) of the new scene | 270–380 ms (17–23 shader programs recompiled ≈ 140 ms of link waits, 10–11 cached textures re-uploaded ≈ 100 ms) + a second 160 ms frame | 0 new programs, 0–1 uploads on an unchanged shader set |
| longest frame-to-frame gap around a swap (90 Hz, normal 11 ms) | ~950 ms in total over 2–3 frames | 33–50 ms (one frame) |

Not a swap cost: `npm run vr:shot` / `screenshot()` renders into an off-screen target, which needs
tone-mapping/colour-space variants of every lit program (~20 programs, ~300 ms hitch in the headset
per screenshot, freed again at the next swap).

What costs on Quest and how it is avoided:
- **Shader programs**: the Quest browser has no `KHR_parallel_shader_compile`; a new program costs
  ~5–15 ms of link wait at first use. three shares a program between materials with the same
  cache key only while one user is alive -> the host keeps old materials alive until the new ones
  took the programs. Shader text that changes per swap (random numbers, timestamps in GLSL) defeats
  this; keep shader strings deterministic. A genuinely new shader is linked during prepare, one or two
  per frame, while the old scene stays on screen.
- **Textures**: canvas/data textures built in `setup` are new objects -> new upload (1024² ≈ 10 ms,
  2048² canvas far more). Cache them in `__sceneState` keyed by the builder's source.
- **CPU in `setup`**: anything > ~5 ms (procedural placement, noise, merged models) -> cache by
  `fn.toString()` key (`worldCache`, `smokeTexture`, `model-cache.js`).
- Hidden objects are neither precompiled nor pre-uploaded (e.g. the cracked-glasses 2048² canvas);
  they cost on first show, as before.

Measure a swap: `npm run vr:eval -- "sceneHost.lastSwap"` after touching a comment in a scene file
(only while `recording` is false).

Read it: `Get-Content logs/page-console.log -Tail 20` (or Read with an offset near the end).
FPS number under the HUD dot: green ≥ 114, yellow ≥ 70, red below.

## Budget and known costs

- 120 Hz = 8.3 ms per frame; keep scene CPU well under ~4 ms.
- Every mesh is drawn for both eyes: prefer `InstancedMesh` and merged geometry
  (pistol: per-material merge -> 8 calls; targets: 2 instanced meshes; clays/shards instanced;
  smoke/tracers one draw each, zero draws when empty).
- Canvas texture upload: 1600×640 ≈ 10 ms on Quest. Repaint only on change; one big texture per
  frame at most.
- `getImageData` on a canvas used as a texture puts it into software mode (uploads ~10 ms).
- Adding/removing lights or changing material defines recompiles shaders (hitch). Keep one
  light and animate intensity; compile early (`frustumCulled = false` on always-present effects).
- Fragment-shader procedural noise and vertex-shader texture fetches are expensive: bake into
  textures / per-instance attributes.
- No per-frame allocations (`new Vector3`, closures, arrays) in update paths; GC pauses show as
  `worst` spikes. `pistols.save` writes localStorage at most every 500 ms.
- `console.log` per frame floods the WebSocket and the log file. Log periodically with a tag.
- `gl.finish` for GPU timing is unreliable on Quest and drops frames (`GPU_SAMPLE_MS = 0`).

## Adding telemetry for your system

Measure with `performance.now()` around your update, accumulate, and log every 5 s with your own
tag, e.g. `[clays] cpu=0.12/0.40ms n=12`. See [recipes.md](recipes.md#per-frame-system-with-telemetry).
