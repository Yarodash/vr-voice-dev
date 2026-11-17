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
  smoke/tracers one draw each). **A draw call costs ~25–30 µs of CPU on Quest** (measured:
  `rend` 2.1 ms for ~78 calls), so the object count is the main render-CPU lever.
- **An empty but visible mesh still costs CPU**: with `count`/`instanceCount` 0 three skips only the
  final `gl.draw*`, but still runs `setProgram`, uniforms and VAO binding for each eye. Pattern
  (effects, smoke, tracer, impact, mana, clays, drones): visible for the first 3 frames (so the
  swap precompiles the shader; the material keeps its program afterwards), then
  `mesh.visible = count > 0`.
- **Transparent + `DoubleSide` = two draws per eye and a program re-check every frame**: three
  renders back faces, then front faces, setting `material.needsUpdate = true` twice per draw. Use
  `forceSinglePass: true` unless the two-pass order matters (drones-rotor had it). Find them:
  `scene.traverse(o => …m.transparent && m.side === THREE.DoubleSide && !m.forceSinglePass…)`;
  find any material whose `version` grows every frame the same way.
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

## Optimization pass 2026-11-17 (Сцена 3: robot-dog battle, 90 Hz)

Where the frame goes (Quest, `[perf]` + `[horde]` + `[scope]`): cpu 6–8 ms = horde 1.5–7 ms +
`rend` ~2 ms + scope passes + ~1 ms other scene. With cpu at 6–7 ms the page still ran at 80–85 fps:
XR frame gaps sit at 11–13.5 ms (not vsync-quantised) while JS work ends ~7 ms into the frame, i.e.
the rest is GPU/compositor. Read-only probe: `session.requestAnimationFrame` from `vr:eval`, compare
the callback's `t` with `performance.now()`.

| Change | Before | After |
|---|---|---|
| Effect particles (`effects.js`: muzzle flash, sparks, dust) — one mesh+material each → 4 `InstancedMesh` batches (per-instance colour + `aOpacity`) | a shot = 17 meshes = 34 draws; battle dust 16–50 meshes visible | ≤ 4 draws total (e.g. 33 dust puffs = 1 draw) |
| Empty effect meshes hidden (tracer, impact, mana, smoke, clays) | 4 empty meshes set up per eye per frame | 0 |
| `drones-rotor` `forceSinglePass` | 2 draws + 2 `needsUpdate` per eye per frame | 1 draw |
| Scope (`scope-lens.js`): both eyes see the glass → one texture for both (MONO, camera between the eye directions, FOV widened ~25 %); `FAR_EVERY` every frame only within 0.25 m | x6 scope: 750–814 renders/5 s × 1.2 ms (≈ 2.4 ms/frame) | ≈ 200/5 s while held, 90/s when aiming (≈ 0.8–1.5 ms/frame) |
| Generated gun GLB simplified at load (`generated-gun.js` `SIMPLIFY_ERROR` 0.001, meshoptimizer from `three/addons/libs`, ~90 ms once on Quest) | sam_rifle 77k tris (×2 eyes = 30 % of the frame) | 22k (m16 30k → 9k); close-up identical (`logs/screenshots/simp/`) |
| `car.js` `groundHeight` (per dog per frame): `Math.hypot`/`**` → plain math | 10 KB/frame garbage | 1.5 KB/frame |

Tried and dropped: frustum-culled grass tiles for the scope pass (12 m tiles) — looking along the
meadow the scope still saw 33 tiles = 33 draws (≈ 1 ms CPU) to save vertex work; net loss.

Still open (not mine / shell): horde `apply` on swap is most of `setup` (~45 of 50 ms on Quest:
each save by any agent is a ~60–80 ms hitch); foveation is 0 (shell) — fixed foveation 0.3–0.5
would cut fragment cost at the edges if the user accepts it; screenshots cost ~300 ms.

Profiling without the headset: a headless Chrome (Playwright from `D:\ClaudeWebsites\claude-browser`)
opened on the dev URL with the same `localStorage` runs the same scene; CDP
`HeapProfiler.startSampling` (with `includeObjectsCollectedByMinor/MajorGC`) gives allocation sites,
`Profiler.start` gives CPU per function. It is not paired with the bridge, so it never shows up in
`vr:eval`. Desktop GPU timer queries (RTX) were too noisy to rank Quest GPU costs.

## Adding telemetry for your system

Measure with `performance.now()` around your update, accumulate, and log every 5 s with your own
tag, e.g. `[clays] cpu=0.12/0.40ms n=12`. See [recipes.md](recipes.md#per-frame-system-with-telemetry).
