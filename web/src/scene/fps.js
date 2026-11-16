// Счётчик кадров под кружком-индикатором и телеметрия производительности.
//
// Цель — 120 Гц: при входе в VR сцена просит у шлема частоту TARGET_HZ (Quest 3S умеет 72/80/90/120).
// Число под кружком обновляется два раза в секунду: зелёное — почти цель, жёлтое — от 72, ниже — красное.
//
// Телеметрия: раз в PERF_EVERY_MS страница пишет в консоль строку `[perf] …`, она попадает в
// logs/page-console.log. Её читают агенты, чтобы проверять, держит ли сцена 120:
//   [perf] hz=120 fps=118.7 avg=8.4ms worst=12.1ms slow=3% calls=142 tris=210k geo=95 tex=31 prog=24
// hz — частота экрана сейчас; slow — доля кадров дольше 1.5 бюджета (пропущенные кадры);
// calls/tris — вызовы отрисовки и треугольники за кадр (оба глаза); geo/tex/prog — сколько живёт
// геометрий, текстур и шейдерных программ.
// Цена кадра (запас до 150 fps — это ≤ 6.7 мс):
//   cpu=4.1/6.0ms — сцена (update) + renderer.render на CPU: среднее / худшее за период;
//   rend=2.2ms — из них сам renderer.render;
//   gpu=… — таймеров GPU (EXT_disjoint_timer_query_webgl2) в Quest Browser нет. Запасной замер —
//   gl.finish раз в GPU_SAMPLE_MS (от начала render до конца работы GPU) — на Quest ненадёжен
//   (1–46 мс вразнобой) и сам роняет кадр, поэтому выключен (GPU_SAMPLE_MS = 0): тогда gpu=-.
export const TARGET_HZ = 120;
const PERF_EVERY_MS = 5000;
const GPU_SAMPLE_MS = 0; // 0 — не замерять

export function createFps({ THREE, camera, renderer, scene }) {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 48;
  const g = canvas.getContext('2d');
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const label = new THREE.Mesh(
    new THREE.PlaneGeometry(0.064, 0.024),
    new THREE.MeshBasicMaterial({ map: texture, transparent: true, toneMapped: false, depthTest: false }),
  );
  label.renderOrder = 1001;
  label.name = 'scene-fps';

  // HUD — группа у камеры, в которой есть кружок (CircleGeometry); подпись ставится прямо под ним
  let attached = false;
  const attach = () => {
    for (const group of camera.children) {
      const dot = group.children?.find((c) => c.geometry?.type === 'CircleGeometry');
      if (!dot) continue;
      label.position.copy(dot.position).add(new THREE.Vector3(0, -0.032, 0));
      group.add(label);
      attached = dot;
      return;
    }
  };

  const draw = (fps) => {
    g.clearRect(0, 0, canvas.width, canvas.height);
    g.font = 'bold 34px system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.lineWidth = 6;
    g.strokeStyle = 'rgba(0,0,0,0.75)';
    g.fillStyle = fps >= TARGET_HZ * 0.95 ? '#4ade80' : fps >= 70 ? '#facc15' : '#f87171';
    const text = String(Math.round(fps));
    g.strokeText(text, 64, 25);
    g.fillText(text, 64, 25);
    texture.needsUpdate = true;
  };

  // Частота экрана: просим TARGET_HZ один раз на каждый XR-сеанс.
  let askedSession = null;
  const askRate = () => {
    const session = renderer.xr.getSession?.();
    if (!session || session === askedSession) return;
    askedSession = session;
    const rates = session.supportedFrameRates ? [...session.supportedFrameRates] : [];
    if (!rates.length || !session.updateTargetFrameRate) return;
    const best = rates.includes(TARGET_HZ) ? TARGET_HZ : Math.max(...rates);
    session.updateTargetFrameRate(best).catch((error) => console.warn('[perf] частота не сменилась:', error));
  };

  let frames = 0;
  let since = performance.now();
  let last = since;
  // за период телеметрии
  let perfSince = since;
  let perfFrames = 0;
  let worst = 0;
  let slow = 0;
  draw(0);

  // Цена кадра: начало — beginFrame() в начале update сцены, конец — scene.onAfterRender.
  let frameStart = -1;
  let renderStart = 0;
  let cpuSum = 0;
  let cpuMax = 0;
  let cpuFrames = 0;
  let renderSum = 0;
  let gpuSum = 0;
  let gpuMax = 0;
  let gpuSamples = 0;
  let gpuSampleAt = performance.now();
  const gl = renderer.getContext();
  const prevBefore = scene?.onBeforeRender;
  const prevAfter = scene?.onAfterRender;
  if (scene) {
    scene.onBeforeRender = function onBeforeRender(...args) {
      renderStart = performance.now();
      prevBefore?.apply(this, args);
    };
    scene.onAfterRender = function onAfterRender(...args) {
      prevAfter?.apply(this, args);
      const end = performance.now();
      renderSum += end - renderStart;
      if (frameStart >= 0) {
        const cpu = end - frameStart;
        cpuSum += cpu;
        cpuMax = Math.max(cpuMax, cpu);
        cpuFrames += 1;
        frameStart = -1;
      }
      if (GPU_SAMPLE_MS > 0 && end - gpuSampleAt >= GPU_SAMPLE_MS && renderer.xr.isPresenting) {
        gpuSampleAt = end;
        gl.finish();
        const gpu = performance.now() - renderStart;
        gpuSum += gpu;
        gpuMax = Math.max(gpuMax, gpu);
        gpuSamples += 1;
      }
    };
  }

  return {
    // в самом начале update сцены: отсюда считается цена кадра на CPU
    beginFrame() {
      frameStart = performance.now();
    },
    update() {
      if (!attached) attach();
      else label.position.set(attached.position.x, attached.position.y - 0.032, 0); // кружок могут сдвинуть (hud.js dotShiftM)
      askRate();
      const now = performance.now();
      const frameMs = now - last;
      last = now;
      frames += 1;
      perfFrames += 1;
      worst = Math.max(worst, frameMs);
      const session = renderer.xr.getSession?.();
      const hz = session?.frameRate || 60;
      if (frameMs > (1000 / hz) * 1.5) slow += 1;

      if (now - since >= 500) {
        draw((frames * 1000) / (now - since));
        frames = 0;
        since = now;
      }
      if (now - perfSince >= PERF_EVERY_MS) {
        const seconds = (now - perfSince) / 1000;
        const info = renderer.info;
        console.log(
          `[perf] hz=${session?.frameRate || '-'} fps=${(perfFrames / seconds).toFixed(1)}`
            + ` avg=${((seconds * 1000) / perfFrames).toFixed(1)}ms worst=${worst.toFixed(1)}ms`
            + ` slow=${Math.round((slow / perfFrames) * 100)}%`
            + ` calls=${info.render.calls} tris=${Math.round(info.render.triangles / 1000)}k`
            + ` geo=${info.memory.geometries} tex=${info.memory.textures} prog=${info.programs?.length ?? '-'}`
            + ` xr=${session ? 1 : 0}`
            + ` cpu=${cpuFrames ? (cpuSum / cpuFrames).toFixed(1) : '-'}/${cpuMax.toFixed(1)}ms`
            + ` rend=${cpuFrames ? (renderSum / cpuFrames).toFixed(1) : '-'}ms`
            + ` gpu=${gpuSamples ? `${(gpuSum / gpuSamples).toFixed(1)}/${gpuMax.toFixed(1)}` : '-'}ms`,
        );
        perfSince = now;
        perfFrames = 0;
        worst = 0;
        slow = 0;
        cpuSum = 0;
        cpuMax = 0;
        cpuFrames = 0;
        renderSum = 0;
        gpuSum = 0;
        gpuMax = 0;
        gpuSamples = 0;
      }
    },
    dispose() {
      if (scene) {
        scene.onBeforeRender = prevBefore;
        scene.onAfterRender = prevAfter;
      }
      label.removeFromParent();
      label.geometry.dispose();
      label.material.dispose();
      texture.dispose();
    },
  };
}
