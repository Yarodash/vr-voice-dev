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
A single `worst` spike right after a swap is shader compilation; repeated spikes are a bug.

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
