// Оптика прицела — настоящая линза: в окуляре видно увеличенное (MAGNIFICATION×) живое изображение
// мира. Сейчас нигде не стоит (подзорную трубу убрали); готова для прицела на оружии (АВП):
// createScopeLens(...) на каждый экземпляр; reticleStyle 'pso' — уголки ПСО; dispose при удалении.
// Настройки подзорной трубы были: lensR 0.021, eyeRelief 0.07, tanApparent 0.26, size 448, 4×.
//
// Как устроено:
// - Вторая камера (PerspectiveCamera) стоит у объектива и смотрит вдоль трубы с узким углом обзора:
//   tan(половины угла) = TAN_APPARENT / MAGNIFICATION. Каждый кадр, пока в окуляр смотрят, она рисует
//   сцену в маленькую текстуру (SIZE×SIZE) — renderer.xr.enabled на это время false (как снимки
//   screenshot.js и тени world.js), потом всё возвращается.
// - Окуляр — диск (eyepiece) со своим шейдером. Для каждого глаза (cameraPosition у каждого свой)
//   считается луч глаз → точка диска: его направление (tan от оси трубы) и есть точка изображения.
//   Поэтому картинка «на бесконечности» и увеличена ровно в MAGNIFICATION раз против взгляда без трубы.
//   Видимое поле — круг (полевая диафрагма, TAN_APPARENT), по краю темнеет (виньетка); сетка
//   (дуплекс-крест или уголки ПСО — reticleStyle 'pso') — в той же плоскости, движется с изображением.
// - Выходной зрачок: лучи, дошедшие до глаза, должны пройти через кружок радиуса PUPIL_R на
//   расстоянии EYE_RELIEF от окуляра. Глаз сбоку — тёмный серп и чернота, глаз далеко — поле сужается
//   в кружок (как у настоящего прицела). Не смотрят — тёмное стекло с лёгким отблеском просветления,
//   и прохода сцены нет.
// - Цвет. Текстура помечена как цель XR (isXRRenderTarget) с sRGB-текстурой и внутренним форматом
//   RGBA8: three рисует в неё теми же шейдерами, что и в шлем (тот же тон-маппинг ACES, тот же вывод в
//   sRGB — новых программ не компилируется), а в текстуре лежат уже готовые байты экрана. Шейдер
//   окуляра отдаёт их как есть (toneMapped: false, без colorspace_fragment) — картинка в трубе того же
//   цвета, что мир вокруг.
// - Что не попадает в объектив: сам прибор (hide — его группа) и всё, что висит на камере (HUD:
//   окна сообщений, кружок, счёт) — на время прохода camera.visible = false.
// - Обёртки scene.onBeforeRender / onAfterRender (fps.js, ipd-panel.js) на время прохода снимаются,
//   чтобы [perf] cpu считал кадр как раньше. Своя телеметрия: раз в 5 с строка [scope] в консоли.
//
// Использование:
//   const lens = createScopeLens({ THREE, renderer, scene, camera });
//   model.add(lens.eyepiece);   // диск окуляра: плоскость XY, смотрит в +Z (к глазу); ставь в торец
//   model.add(lens.objective);  // стекло объектива: смотрит в −Z (от глаза); там же стоит камера
//   lens.update(active, hideObject) // каждый кадр в конце update сцены; active — прибор в руке
//   lens.dispose();
export const MAGNIFICATION = 4; // кратность
export const TAN_APPARENT = 0.22; // видимое поле: tan половины угла (≈25° целиком; истинное поле при 4× ≈ 6,3°, как у ПСО-1)
export const LENS_R = 0.017; // радиус стекла окуляра, м
export const EYE_RELIEF = 0.07; // вынос выходного зрачка, м (у ПСО-1 ≈ 68 мм; ближе 5 см к глазу шлем всё равно обрезает)
// ---- Насколько точно надо ставить глаз (крутить здесь). Середина между «строго» (зрачок 7 мм, до
// 17 см) и «плоской картинкой»: оптика честная (картинка смещается и срезается краем, если глаз ушёл
// с оси), но видно в 2 раза шире.
export const PUPIL_R = 0.014; // радиус выходного зрачка («окно для глаза»), м; строгий был 0.007
export const PUPIL_EDGE_IN = 0.5; // внутри PUPIL_R × это — видно полностью
export const PUPIL_EDGE_OUT = 1.6; // к PUPIL_R × это — плавно гаснет (серп)
export const MAX_EYE_Z = 0.24; // дальше этого от окуляра (м) — не видно; строгий был 0.17
export const EYE_Z_FADE = 0.05; // последние столько метров до MAX_EYE_Z изображение плавно гаснет
export const FIELD_FILL = 1.12; // видимый круг поля шире, чем tanApparent (1 — строгий)
export const VIGNETTE_START = 0.62; // с какой доли радиуса поля начинается затемнение (строгий 0.5)
export const VIGNETTE_DARK = 0.5; // яркость на самом краю поля (строгий 0.45)
// Хроматическая аберрация: на краю поля красный и синий расходятся на ± столько долей радиуса поля
// (0.012 ≈ 3 пикселя текстуры при 512), в центре — ноль (растёт как r²). 0 — выключить.
export const CHROMA = 0.012;
export const SIZE = 512; // текстура изображения, пикселей по стороне
export const SAMPLES = 4; // MSAA текстуры
export const RENDER_EVERY = 1; // рисовать каждый N-й кадр (2 — вдвое дешевле, но картинка дёргается)
const LOG_EVERY_MS = 5000;

const vertexShader = /* glsl */ `
  varying vec2 vPos;
  varying vec3 vEye;
  void main() {
    vPos = position.xy;
    vEye = (inverse(modelMatrix) * vec4(cameraPosition, 1.0)).xyz; // глаз в системе диска
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  uniform sampler2D map;
  uniform float live;      // 1 — изображение нарисовано в этом кадре
  uniform float tanA;      // TAN_APPARENT
  uniform float eyeRelief;
  uniform float pupilR;
  uniform float reticle;   // 1 — сетка видна
  uniform float lensR;
  varying vec2 vPos;
  varying vec3 vEye;

  float bar(float d, float w) {
    float aa = fwidth(d) * 1.2;
    return 1.0 - smoothstep(w, w + aa, abs(d));
  }
  float segment(vec2 p, vec2 a, vec2 b) {
    vec2 pa = p - a, ba = b - a;
    return length(pa - ba * clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0));
  }
  // уголок вершиной вверх: вершина (0, y0), концы (±halfW, y0 − h); расстояние до него
  float chevron(vec2 p, float y0, float halfW, float h) {
    vec2 apex = vec2(0.0, y0);
    return min(segment(p, apex, vec2(-halfW, y0 - h)), segment(p, apex, vec2(halfW, y0 - h)));
  }

  void main() {
    vec3 E = vEye;
    float ez = max(E.z, 1e-3);
    vec3 d = vec3(vPos, 0.0) - E;                 // луч от глаза в трубу
    vec2 q = (d.xy / max(-d.z, 1e-4)) / tanA;     // направление в долях поля: круг |q| < 1
    float r = length(q);
    // выходной зрачок: где луч пересекает плоскость на выносе EYE_RELIEF
    vec2 X = E.xy + (vPos - E.xy) * (ez - eyeRelief) / ez;
    float pupil = 1.0 - smoothstep(pupilR * PUPIL_EDGE_IN, pupilR * PUPIL_EDGE_OUT, length(X));
    float field = 1.0 - smoothstep(0.94, 1.0, r);
    float see = live * pupil * field * step(0.0, E.z);

    // хроматическая аберрация: R чуть крупнее, B чуть мельче — цветная кайма растёт к краю поля
    float ca = CHROMA * r * r;
    vec3 img = vec3(
      texture2D(map, clamp(q * (1.0 + ca) * 0.5 + 0.5, 0.0, 1.0)).r,
      texture2D(map, clamp(q * 0.5 + 0.5, 0.0, 1.0)).g,
      texture2D(map, clamp(q * (1.0 - ca) * 0.5 + 0.5, 0.0, 1.0)).b);
    img *= mix(1.0, VIGNETTE_DARK, smoothstep(VIGNETTE_START, 1.0, r)); // виньетка: край поля темнее
    if (reticle > 0.5) {
#ifdef RETICLE_PSO
      // ПСО-1: главный уголок (вершина — точка прицеливания), под ним два уголка поменьше,
      // горизонтальная шкала поправок с рисками по обе стороны (без середины)
      float px = fwidth(q.x) * 1.2;
      float w = 0.0055;
      float m = 0.0;
      m = max(m, 1.0 - smoothstep(w, w + px, chevron(q, 0.0, 0.075, 0.11)));
      m = max(m, 1.0 - smoothstep(w * 0.8, w * 0.8 + px, chevron(q, -0.2, 0.045, 0.065)));
      m = max(m, 1.0 - smoothstep(w * 0.8, w * 0.8 + px, chevron(q, -0.32, 0.045, 0.065)));
      float ax = abs(q.x);
      float scale = bar(q.y, w * 0.8) * step(0.14, ax) * step(ax, 0.75);
      float tick = fract(ax / 0.1 + 0.5) - 0.5;
      float ticks = bar(tick * 0.1, w * 0.8) * step(0.15, ax) * step(ax, 0.75) * step(q.y, 0.0) * step(-0.045, q.y);
      m = max(m, max(scale, ticks));
      img *= 1.0 - 0.92 * m;
#else
      // «дуплекс»: тонкий крест в середине, толстые штрихи к краям
      float thinW = 0.0045, thickW = 0.02;
      float hx = abs(q.x) > 0.42 ? thickW : thinW;
      float vy = abs(q.y) > 0.42 ? thickW : thinW;
      float m = max(bar(q.y, hx) * step(abs(q.x), 1.0), bar(q.x, vy) * step(abs(q.y), 1.0));
      img *= 1.0 - 0.92 * m;
#endif
    }

    // тёмное стекло: слабое фиолетово-зелёное просветление, отблеск сильнее под углом
    vec3 toEye = normalize(-d);
    float fres = pow(1.0 - clamp(toEye.z, 0.0, 1.0), 2.0);
    float sheen = smoothstep(0.35, 0.0, length(vPos / lensR - vec2(-0.35, 0.4)));
    vec3 glass = vec3(0.020, 0.024, 0.034) + vec3(0.10, 0.07, 0.17) * fres + vec3(0.05, 0.08, 0.06) * sheen;
    glass *= 1.0 - 0.75 * live * pupil;           // глаз у окуляра — вокруг поля почти черно
    gl_FragColor = vec4(img * see + glass * (1.0 - see), 1.0);
  }
`;

// Всё в метрах; прибор поменьше — меньше lensR, и тогда поле ограничит край стекла (tanApparent ≈
// lensR / eyeRelief — поле как раз во всё стекло на выносе).
export function createScopeLens({
  THREE, renderer, scene, camera,
  magnification = MAGNIFICATION, lensR = LENS_R, tanApparent = TAN_APPARENT, eyeRelief = EYE_RELIEF,
  pupilR = PUPIL_R, size = SIZE, reticleStyle = 'duplex',
}) {
  const shared = (globalThis.__sceneState ??= {});
  tanApparent *= FIELD_FILL; // круг поля чуть шире (увеличение то же: камера считается от него же)
  const target = new THREE.WebGLRenderTarget(size, size, {
    samples: SAMPLES,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    generateMipmaps: false,
    depthBuffer: true,
  });
  target.isXRRenderTarget = true; // тон-маппинг и вывод как в шлеме (см. шапку)
  target.texture.colorSpace = THREE.SRGBColorSpace;
  target.texture.internalFormat = 'RGBA8'; // байты экрана; без SRGB8_ALPHA8 (иначе sRGB дважды)

  const scopeCamera = new THREE.PerspectiveCamera(1, 1, 0.05, camera.far);
  const setMagnification = (m) => {
    scopeCamera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(tanApparent / m));
    scopeCamera.updateProjectionMatrix();
  };
  setMagnification(magnification);

  const lensMaterial = new THREE.ShaderMaterial({
    uniforms: {
      map: { value: target.texture },
      live: { value: 0 },
      tanA: { value: tanApparent },
      eyeRelief: { value: eyeRelief },
      pupilR: { value: pupilR },
      reticle: { value: 1 },
      lensR: { value: lensR },
    },
    vertexShader,
    fragmentShader,
    defines: {
      PUPIL_EDGE_IN: PUPIL_EDGE_IN.toFixed(3),
      PUPIL_EDGE_OUT: PUPIL_EDGE_OUT.toFixed(3),
      VIGNETTE_START: VIGNETTE_START.toFixed(3),
      VIGNETTE_DARK: VIGNETTE_DARK.toFixed(3),
      CHROMA: CHROMA.toFixed(4),
      ...(reticleStyle === 'pso' ? { RETICLE_PSO: '' } : {}),
    },
    toneMapped: false,
  });
  const eyepiece = new THREE.Mesh(new THREE.CircleGeometry(lensR, 48), lensMaterial);
  eyepiece.name = 'scope-eyepiece';

  // объектив снаружи: тёмное стекло с цветным отблеском просветления (карта окружения оружия)
  const objectiveGeometry = new THREE.CircleGeometry(1, 40);
  objectiveGeometry.rotateY(Math.PI); // смотрит в −Z
  const objectiveMaterial = new THREE.MeshStandardMaterial({
    color: 0x6f58b0, roughness: 0.08, metalness: 1, envMap: shared.weaponEnv ?? null, envMapIntensity: 0.32,
  });
  const objective = new THREE.Mesh(objectiveGeometry, objectiveMaterial);
  objective.name = 'scope-objective'; // масштаб = радиус стекла: objective.scale.setScalar(r)

  const eyeWorld = new THREE.Vector3();
  const eyeLocal = new THREE.Vector3();
  const noop = () => {};
  let frame = 0;
  let wasLive = false;
  // телеметрия
  let statN = 0, statSum = 0, statMax = 0, statCalls = 0, statTris = 0, statAt = performance.now();

  const smooth = (a, b, x) => {
    const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  };
  // Насколько глаз (мировая точка) видит поле через выходной зрачок, 0..1: ближайший к оси луч
  // через стекло проходит у зрачка на minX; к краю окна и к MAX_EYE_Z плавно гаснет
  const eyeSees = (point) => {
    eyeLocal.copy(point);
    eyepiece.worldToLocal(eyeLocal);
    const ez = eyeLocal.z;
    if (ez < 0.01 || ez > MAX_EYE_Z) return 0;
    const lateral = Math.hypot(eyeLocal.x, eyeLocal.y);
    const k = (ez - eyeRelief) / ez;
    const minX = Math.max(0, (lateral * eyeRelief) / ez - lensR * Math.abs(k));
    return (1 - smooth(pupilR * PUPIL_EDGE_IN, pupilR * PUPIL_EDGE_OUT, minX)) * (1 - smooth(MAX_EYE_Z - EYE_Z_FADE, MAX_EYE_Z, ez));
  };

  const lookingIn = () => {
    eyepiece.updateWorldMatrix(true, false);
    if (renderer.xr.isPresenting) {
      const eyes = renderer.xr.getCamera().cameras;
      let best = 0;
      for (let i = 0; i < eyes.length; i += 1) best = Math.max(best, eyeSees(eyeWorld.setFromMatrixPosition(eyes[i].matrixWorld)));
      return best;
    }
    camera.updateWorldMatrix(true, false);
    return eyeSees(eyeWorld.setFromMatrixPosition(camera.matrixWorld));
  };

  const renderView = (hideObject) => {
    const t0 = performance.now();
    objective.updateWorldMatrix(true, false);
    objective.getWorldPosition(scopeCamera.position);
    eyepiece.getWorldQuaternion(scopeCamera.quaternion); // смотрит вдоль трубы (−Z окуляра)
    scopeCamera.updateMatrixWorld();

    const prevTarget = renderer.getRenderTarget();
    const xrWas = renderer.xr.enabled;
    const before = scene.onBeforeRender;
    const after = scene.onAfterRender;
    const hideWas = hideObject ? hideObject.visible : true;
    const cameraWas = camera.visible;
    try {
      renderer.xr.enabled = false; // в текстуру, а не в шлем
      scene.onBeforeRender = noop; // fps.js / ipd-panel.js — только для главного прохода
      scene.onAfterRender = noop;
      if (hideObject) hideObject.visible = false;
      camera.visible = false; // HUD на камере не попадает в прицел
      renderer.setRenderTarget(target);
      renderer.render(scene, scopeCamera);
      statCalls = renderer.info.render.calls;
      statTris = renderer.info.render.triangles;
    } finally {
      camera.visible = cameraWas;
      if (hideObject) hideObject.visible = hideWas;
      scene.onBeforeRender = before;
      scene.onAfterRender = after;
      renderer.xr.enabled = xrWas;
      renderer.setRenderTarget(prevTarget);
    }
    const ms = performance.now() - t0;
    statN += 1;
    statSum += ms;
    statMax = Math.max(statMax, ms);
  };

  const api = {
    eyepiece,
    objective,
    scopeCamera,
    target,
    get magnification() {
      return tanApparent / Math.tan(THREE.MathUtils.degToRad(scopeCamera.fov / 2));
    },
    setMagnification,
    // для npm run vr:eval: нарисовать изображение сейчас (без проверки взгляда), вернуть мс
    debugRender(hideObject = null) {
      const t0 = performance.now();
      renderView(hideObject);
      return performance.now() - t0;
    },
    setReticle(on) {
      lensMaterial.uniforms.reticle.value = on ? 1 : 0;
    },
    // Каждый кадр, в конце update сцены (когда прибор уже на месте). active — можно ли смотреть
    // (например, оружие в руке; true — всегда); hideObject — группа прибора (не должна попасть в
    // собственный объектив). Возвращает true, если изображение нарисовано.
    update(active, hideObject = null) {
      const fade = active ? lookingIn() : 0; // 0..1: плавно на краях окна для глаза
      const live = fade > 0.002;
      if (live) {
        frame += 1;
        // первый кадр взгляда рисуется всегда; дальше — каждый RENDER_EVERY-й
        if (!wasLive || frame % RENDER_EVERY === 0) renderView(hideObject);
      }
      wasLive = live;
      lensMaterial.uniforms.live.value = live ? fade : 0;
      const now = performance.now();
      if (now - statAt >= LOG_EVERY_MS) {
        if (statN) {
          console.log(`[scope] n=${statN}/${((now - statAt) / 1000).toFixed(0)}s cpu=${(statSum / statN).toFixed(2)}/${statMax.toFixed(2)}ms calls=${statCalls} tris=${(statTris / 1000).toFixed(0)}k size=${size} msaa=${SAMPLES} x${api.magnification.toFixed(1)}`);
        }
        statN = statSum = statMax = 0;
        statAt = now;
      }
      return live;
    },
    dispose() {
      eyepiece.removeFromParent();
      objective.removeFromParent();
      eyepiece.geometry.dispose();
      lensMaterial.dispose();
      objectiveGeometry.dispose();
      objectiveMaterial.dispose();
      target.dispose();
    },
  };
  return api;
}
