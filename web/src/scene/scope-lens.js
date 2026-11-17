// Оптика прицела — «портал» с увеличением: в окуляре видно увеличенное (×magnification) живое
// изображение мира, объёмное — оно зависит от того, где глаз. Стоит на АВП (awp-model.js, pistols.js):
// createScopeLens(...) на каждый экземпляр; reticleStyle 'pso' — уголки ПСО; dispose при удалении.
//
// Как устроено:
// - Изображение «на бесконечности»: каждую точку стекла глаз видит по своему направлению d (от глаза
//   через эту точку, в системе окуляра). Сквозь прицел это направление в мире d / M (M — кратность,
//   прицел не переворачивает). Шейдер окуляра берёт цвет именно по этому мировому направлению, а не
//   по координатам на стекле: сдвинул глаз — видна другая часть увеличенного мира, глубина как у окна.
// - Виртуальная камера на каждый глаз: у объектива, смотрит туда, куда глаз смотрит сквозь середину
//   стекла (ось прицела + смещение глаза / M), с углом обзора ровно под видимое из глаза стекло.
//   Два глаза — две текстуры (EYES), шейдер выбирает ту, чей глаз ближе к рисуемому (стерео). Если
//   стекло видят оба глаза (MONO), рисуется одна текстура на оба (см. update) — вдвое дешевле.
//   Текстура хранит поворот своей камеры: если её рисовали кадр-два назад (издалека — реже,
//   FAR_EVERY), картинка всё равно стоит на месте, только края могут подрезаться.
// - Сетка (дуплекс или уголки ПСО) — на оси прицела (направление d = 0): при смещении глаза она
//   смещается относительно мира — параллакс. Поле зрения — круг |tan d| < tanApparent (полевая
//   диафрагма), к краю виньетка, хроматическая аберрация.
// - Выходной зрачок — яркий круг на стекле: глаз на выносе — во всё стекло, издалека — меньше
//   (PUPIL_FAR_FRAC); глаз сбоку — круг уезжает в противоположную сторону (тёмный серп со стороны
//   смещения), к TILT_END_DEG — темно и прохода нет. Дальше MAX_VIEW_M — не рисуется.
// - Тёмное стекло отражает небо (френель) и чуть отливает просветлением — выглядит стеклом.
// - Цвет. Текстура помечена как цель XR (isXRRenderTarget) с sRGB-текстурой и внутренним форматом
//   RGBA8: three рисует в неё теми же шейдерами, что и в шлем (тот же тон-маппинг, вывод в sRGB), а
//   шейдер окуляра отдаёт байты как есть (toneMapped: false) — цвет как у мира вокруг.
// - В объектив не попадает сам прибор (hideObject) и всё, что висит на камере (HUD). Обёртки
//   scene.onBeforeRender / onAfterRender (fps.js, ipd-panel.js) на время прохода снимаются.
//   Телеметрия: раз в 5 с строка [scope] в консоли; lens.debug() — данные для scope-debug.js.
//
// Использование:
//   const lens = createScopeLens({ THREE, renderer, scene, camera });
//   model.add(lens.eyepiece);   // диск окуляра: плоскость XY, смотрит в +Z (к глазу)
//   model.add(lens.objective);  // стекло объектива: смотрит в −Z; там же стоят камеры
//   lens.update(active, hideObject) // каждый кадр в конце update сцены
//   lens.dispose();
export const MAGNIFICATION = 4; // кратность по умолчанию
export const TAN_APPARENT = 0.22; // видимое поле: tan половины угла
export const LENS_R = 0.017; // радиус стекла окуляра, м
export const EYE_RELIEF = 0.07; // вынос выходного зрачка, м
export const PUPIL_R = 0.014; // (не используется; оставлено для совместимости вызовов)
export const PUPIL_FAR_FRAC = 0.8; // выходной зрачок издалека — такая доля радиуса стекла
export const PUPIL_FAR_M = 0.45; // к этому расстоянию глаза (м) зрачок сжимается до PUPIL_FAR_FRAC
// Смотреть надо вдоль оси прицела: угол глаза от оси, видимый из окуляра, к TILT_END_DEG — темно
export const TILT_END_DEG = 40; // (было 14: пользователю «чуть сдвинул голову — и всё чёрное»)
// «Прощающая» оптика: смещение глаза вбок учитывается с этим множителем (1 — строго по физике).
// Меньше — можно смотреть под бо́льшими углами, сетка остаётся на стекле, параллакс слабее.
export const EYE_SHIFT = 0.35;
export const MAX_VIEW_M = 3; // дальше — не рисуется
export const VIEW_FADE_M = 0.3; // последние столько метров — плавно гаснет
// Дешевле издалека: рисовать каждый N-й кадр — [до расстояния (м), N]
// (в окуляр смотрят с ~0,07 м; дальше 0,25 м стекло в кадре уже маленькое — через кадр)
export const FAR_EVERY = [[0.25, 1], [0.6, 2], [1.5, 3], [Infinity, 4]];
export const FIELD_FILL = 1.12; // видимый круг поля шире, чем tanApparent (1 — строгий)
export const VIGNETTE_START = 0.62; // с какой доли радиуса поля начинается затемнение
export const VIGNETTE_DARK = 0.5; // яркость на самом краю поля
export const CHROMA = 0.012; // хроматическая аберрация на краю поля (доля радиуса), 0 — выключить
export const SIZE = 512; // текстура изображения (на глаз), пикселей по стороне
export const SAMPLES = 4; // MSAA текстуры
export const EYES = 2; // текстур (глаз) на прицел
export const MONO = true; // оба глаза видят стекло — одна текстура на оба (см. update)
const COVER = 1.15; // запас угла камеры сверх видимого стекла
const LOG_EVERY_MS = 5000;

const vertexShader = /* glsl */ `
  varying vec2 vPos;
  varying vec3 vEye;
  varying vec3 vWP;
  varying vec3 vWN;
  void main() {
    vPos = position.xy;
    vEye = (inverse(modelMatrix) * vec4(cameraPosition, 1.0)).xyz; // глаз в системе диска
    vWP = (modelMatrix * vec4(position, 1.0)).xyz;
    vWN = normalize(mat3(modelMatrix) * vec3(0.0, 0.0, 1.0));
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  uniform sampler2D map0;
  uniform sampler2D map1;
  uniform mat3 rot0;       // система окуляра → система камеры глаза 0
  uniform mat3 rot1;
  uniform float h0;        // tan половины угла камеры
  uniform float h1;
  uniform vec3 eye0;       // где был глаз, когда рисовали текстуру (система окуляра)
  uniform vec3 eye1;
  uniform float live;      // 0..1 — изображение есть
  uniform float tanA;      // поле: tan половины угла
  uniform float mag;       // кратность
  uniform float eyeRelief;
  uniform float reticle;   // 1 — сетка видна
  uniform float lensR;
  varying vec2 vPos;
  varying vec3 vEye;
  varying vec3 vWP;
  varying vec3 vWN;

  float bar(float d, float w) {
    float aa = fwidth(d) * 1.2;
    return 1.0 - smoothstep(w, w + aa, abs(d));
  }
  float segment(vec2 p, vec2 a, vec2 b) {
    vec2 pa = p - a, ba = b - a;
    return length(pa - ba * clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0));
  }
  float chevron(vec2 p, float y0, float halfW, float h) {
    vec2 apex = vec2(0.0, y0);
    return min(segment(p, apex, vec2(-halfW, y0 - h)), segment(p, apex, vec2(halfW, y0 - h)));
  }
  // мировое направление (система окуляра) → uv текстуры выбранного глаза
  vec2 toUv(vec3 w, bool b) {
    vec3 c = b ? rot1 * w : rot0 * w;
    float h = b ? h1 : h0;
    return (c.xy / max(-c.z, 1e-5)) / h * 0.5 + 0.5;
  }
  vec3 tex(bool b, vec2 uv) {
    return b ? texture2D(map1, uv).rgb : texture2D(map0, uv).rgb;
  }

  void main() {
    vec3 E = vec3(vEye.xy * EYE_SHIFT, vEye.z); // смещение глаза вбок — с множителем EYE_SHIFT
    float ez = max(E.z, 1e-3);
    vec2 tanD = (vPos - E.xy) / ez;               // направление глаз → точка стекла
    vec2 q = tanD / tanA;                         // в долях поля; сетка — в q = 0 (ось прицела)
    float r = length(q);
    vec2 tv = E.xy / ez;                          // угол глаза от оси
    float tilt = length(tv);
    bool b = distance(vEye, eye1) < distance(vEye, eye0); // текстура ближайшего глаза

    // изображение «на бесконечности»: мировое направление tanD / M
    float ca = CHROMA * r * r;
    vec2 uvG = toUv(normalize(vec3(tanD / mag, -1.0)), b);
    vec2 uvR = toUv(normalize(vec3(tanD * (1.0 + ca) / mag, -1.0)), b);
    vec2 uvB = toUv(normalize(vec3(tanD * (1.0 - ca) / mag, -1.0)), b);
    vec3 img = vec3(tex(b, clamp(uvR, 0.0, 1.0)).r, tex(b, clamp(uvG, 0.0, 1.0)).g, tex(b, clamp(uvB, 0.0, 1.0)).b);
    vec2 inside = step(vec2(0.0), uvG) * step(uvG, vec2(1.0));
    img *= inside.x * inside.y;
    img *= mix(1.0, VIGNETTE_DARK, smoothstep(VIGNETTE_START, 1.0, r));
    if (reticle > 0.5) {
#ifdef RETICLE_PSO
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
      float thinW = 0.0045, thickW = 0.02;
      float hx = abs(q.x) > 0.42 ? thickW : thinW;
      float vy = abs(q.y) > 0.42 ? thickW : thinW;
      float m = max(bar(q.y, hx) * step(abs(q.x), 1.0), bar(q.x, vy) * step(abs(q.y), 1.0));
      img *= 1.0 - 0.92 * m;
#endif
    }

    // выходной зрачок: яркий круг, уезжает от стороны смещения глаза, к TILT_END — со стекла
    float rp = mix(1.05, PUPIL_FAR_FRAC, smoothstep(eyeRelief + 0.03, PUPIL_FAR_M, ez));
    vec2 side = tilt > 1e-5 ? tv / tilt : vec2(0.0);
    float tt = clamp(tilt / TILT_END, 0.0, 1.0);
    vec2 pc = -side * (1.0 + rp) * tt * sqrt(tt);
    float pupil = 1.0 - smoothstep(rp - 0.08, rp + 0.03, length(vPos / lensR - pc));
    float field = 1.0 - smoothstep(0.94, 1.0, r);
    float see = live * pupil * field * step(0.0, E.z);

    // стекло: почти чёрное с просветлением и отражением неба (френель)
    vec3 V = normalize(cameraPosition - vWP);
    vec3 N = normalize(vWN);
    vec3 R = reflect(-V, N);
    vec3 sky = mix(vec3(0.05, 0.045, 0.04), mix(vec3(0.42, 0.28, 0.36), vec3(0.18, 0.18, 0.38), smoothstep(0.1, 0.7, R.y)), smoothstep(-0.05, 0.08, R.y));
    float fres = 0.04 + 0.96 * pow(1.0 - clamp(dot(V, N), 0.0, 1.0), 5.0);
    float sheen = smoothstep(0.35, 0.0, length(vPos / lensR - vec2(-0.35, 0.4)));
    vec3 glass = vec3(0.012, 0.014, 0.02) + sky * (0.1 + 0.6 * fres) + vec3(0.03, 0.05, 0.04) * sheen;
    gl_FragColor = vec4(img * see + glass * (1.0 - see) + sky * fres * 0.15 * see, 1.0);
  }
`;

export function createScopeLens({
  THREE, renderer, scene, camera,
  magnification = MAGNIFICATION, lensR = LENS_R, tanApparent = TAN_APPARENT, eyeRelief = EYE_RELIEF,
  size = SIZE, reticleStyle = 'duplex',
}) {
  const shared = (globalThis.__sceneState ??= {});
  tanApparent *= FIELD_FILL;
  let mag = magnification;
  const targets = [];
  for (let i = 0; i < EYES; i += 1) {
    const target = new THREE.WebGLRenderTarget(size, size, {
      samples: SAMPLES, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false, depthBuffer: true,
    });
    target.isXRRenderTarget = true; // тон-маппинг и вывод как в шлеме (см. шапку)
    target.texture.colorSpace = THREE.SRGBColorSpace;
    target.texture.internalFormat = 'RGBA8';
    targets.push(target);
  }
  const scopeCamera = new THREE.PerspectiveCamera(1, 1, 0.05, camera.far);
  // что нарисовано в каждой текстуре (для шейдера и отладки)
  const views = targets.map((target, i) => ({
    name: `глаз ${i}`, target, rot: new THREE.Matrix3(), h: tanApparent / mag, eye: new THREE.Vector3(0, 0, eyeRelief),
    fovDeg: 0, offsetDeg: [0, 0], frame: -1, ms: 0,
  }));

  const lensMaterial = new THREE.ShaderMaterial({
    uniforms: {
      map0: { value: targets[0].texture },
      map1: { value: targets[1].texture },
      rot0: { value: views[0].rot },
      rot1: { value: views[1].rot },
      h0: { value: views[0].h },
      h1: { value: views[1].h },
      eye0: { value: views[0].eye },
      eye1: { value: views[1].eye },
      live: { value: 0 },
      tanA: { value: tanApparent },
      mag: { value: mag },
      eyeRelief: { value: eyeRelief },
      reticle: { value: 1 },
      lensR: { value: lensR },
    },
    vertexShader,
    fragmentShader,
    defines: {
      PUPIL_FAR_FRAC: PUPIL_FAR_FRAC.toFixed(4),
      PUPIL_FAR_M: PUPIL_FAR_M.toFixed(4),
      TILT_END: Math.tan((TILT_END_DEG * Math.PI) / 180).toFixed(4),
      EYE_SHIFT: EYE_SHIFT.toFixed(4),
      VIGNETTE_START: VIGNETTE_START.toFixed(3),
      VIGNETTE_DARK: VIGNETTE_DARK.toFixed(3),
      CHROMA: CHROMA.toFixed(4),
      ...(reticleStyle === 'pso' ? { RETICLE_PSO: '' } : {}),
    },
    toneMapped: false,
  });
  const eyepiece = new THREE.Mesh(new THREE.CircleGeometry(lensR, 48), lensMaterial);
  eyepiece.name = 'scope-eyepiece';

  const objectiveGeometry = new THREE.CircleGeometry(1, 40);
  objectiveGeometry.rotateY(Math.PI); // смотрит в −Z
  const objectiveMaterial = new THREE.MeshStandardMaterial({
    color: 0x6f58b0, roughness: 0.08, metalness: 1, envMap: shared.weaponEnv ?? null, envMapIntensity: 0.32,
  });
  const objective = new THREE.Mesh(objectiveGeometry, objectiveMaterial);
  objective.name = 'scope-objective'; // масштаб = радиус стекла

  const eyeWorld = new THREE.Vector3();
  const eyeLocal = new THREE.Vector3();
  const lensQuat = new THREE.Quaternion();
  const turn = new THREE.Quaternion();
  const dir = new THREE.Vector3();
  const back = new THREE.Vector3(0, 0, -1);
  const m4 = new THREE.Matrix4();
  const noop = () => {};
  let frame = 0;
  let wasLive = false;
  let wasBoth = false;
  let lastDist = Infinity;
  let statN = 0, statSum = 0, statMax = 0, statCalls = 0, statTris = 0, statAt = performance.now();
  const tiltEnd = Math.tan((TILT_END_DEG * Math.PI) / 180);
  const smooth = (a, b, x) => {
    const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  };

  // Видит ли глаз (мировая точка) изображение: 0..1 (вдоль оси, не дальше MAX_VIEW_M); out — глаз
  // в системе окуляра
  const eyeSees = (point, out) => {
    out.copy(point);
    eyepiece.worldToLocal(out);
    const ez = out.z;
    if (ez < 0.005) return 0;
    const dist = out.length();
    if (dist > MAX_VIEW_M) return 0;
    if ((Math.hypot(out.x, out.y) * EYE_SHIFT) / ez >= tiltEnd) return 0;
    lastDist = Math.min(lastDist, dist);
    return 1 - smooth(MAX_VIEW_M - VIEW_FADE_M, MAX_VIEW_M, dist);
  };
  const frustum = new THREE.Frustum();
  const projView = new THREE.Matrix4();
  const lensSphere = new THREE.Sphere();
  const inView = (cam) => {
    cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
    frustum.setFromProjectionMatrix(projView.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
    return frustum.intersectsSphere(lensSphere);
  };

  // куда глаз (система окуляра) смотрит сквозь середину стекла — в мире это угол / M (как в шейдере),
  // и половина угла камеры под видимое из глаза стекло (с запасом, не шире двойного поля): в out.x/y/z
  const aimOf = (eyeL, out) => {
    const ez = Math.max(eyeL.z, 0.01);
    return out.set((-eyeL.x * EYE_SHIFT) / ez / mag, (-eyeL.y * EYE_SHIFT) / ez / mag,
      Math.max(1e-4, Math.min((COVER * lensR) / ez / mag, (2 * tanApparent) / mag)));
  };
  const aimA = new THREE.Vector3();
  const aimB = new THREE.Vector3();
  const eyeMid = new THREE.Vector3();

  // Нарисовать текстуру i: глаз (система окуляра) eyeL; aim — (cx, cy, h) камеры, по умолчанию — под этот глаз
  const renderEye = (i, eyeL, hideObject, aim = aimOf(eyeL, aimA)) => {
    const t0 = performance.now();
    const v = views[i];
    const cx = aim.x, cy = aim.y, h = aim.z;
    dir.set(cx, cy, -1).normalize();
    turn.setFromUnitVectors(back, dir);
    objective.updateWorldMatrix(true, false);
    objective.getWorldPosition(scopeCamera.position);
    eyepiece.getWorldQuaternion(lensQuat);
    scopeCamera.quaternion.copy(lensQuat).multiply(turn);
    scopeCamera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(h));
    scopeCamera.aspect = 1;
    scopeCamera.updateProjectionMatrix();
    scopeCamera.updateMatrixWorld();
    // окуляр → камера: обратный поворот turn
    v.rot.setFromMatrix4(m4.makeRotationFromQuaternion(turn).transpose());
    v.h = h;
    v.eye.copy(eyeL);
    v.fovDeg = scopeCamera.fov;
    v.offsetDeg = [THREE.MathUtils.radToDeg(Math.atan(cx)), THREE.MathUtils.radToDeg(Math.atan(cy))];
    v.frame = frame;

    const prevTarget = renderer.getRenderTarget();
    const xrWas = renderer.xr.enabled;
    const before = scene.onBeforeRender;
    const after = scene.onAfterRender;
    const hideWas = hideObject ? hideObject.visible : true;
    const cameraWas = camera.visible;
    // ещё скрыть: shared.scopeHide (Set объектов) — например, панель отладки с этими же текстурами
    // (иначе текстура рисовалась бы в саму себя)
    const extra = shared.scopeHide;
    const extraWas = [];
    try {
      renderer.xr.enabled = false;
      scene.onBeforeRender = noop;
      scene.onAfterRender = noop;
      if (hideObject) hideObject.visible = false;
      if (extra) for (const o of extra) { extraWas.push(o.visible); o.visible = false; }
      camera.visible = false;
      renderer.setRenderTarget(v.target);
      renderer.render(scene, scopeCamera);
      statCalls = renderer.info.render.calls;
      statTris = renderer.info.render.triangles;
    } finally {
      camera.visible = cameraWas;
      if (hideObject) hideObject.visible = hideWas;
      if (extra) { let k = 0; for (const o of extra) o.visible = extraWas[k++] ?? o.visible; }
      scene.onBeforeRender = before;
      scene.onAfterRender = after;
      renderer.xr.enabled = xrWas;
      renderer.setRenderTarget(prevTarget);
    }
    v.ms = performance.now() - t0;
    statN += 1;
    statSum += v.ms;
    statMax = Math.max(statMax, v.ms);
  };

  // глаза этого кадра: [{ local, fade }] (только те, что видят стекло)
  const seen = [{ local: new THREE.Vector3(), fade: 0 }, { local: new THREE.Vector3(), fade: 0 }];
  const collectEyes = () => {
    eyepiece.updateWorldMatrix(true, false);
    eyepiece.getWorldPosition(lensSphere.center);
    lensSphere.radius = lensR * 1.5;
    lastDist = Infinity;
    seen[0].fade = seen[1].fade = 0;
    if (renderer.xr.isPresenting) {
      const eyes = renderer.xr.getCamera().cameras;
      for (let i = 0; i < Math.min(eyes.length, EYES); i += 1) {
        if (inView(eyes[i])) seen[i].fade = eyeSees(eyeWorld.setFromMatrixPosition(eyes[i].matrixWorld), seen[i].local);
      }
    } else {
      camera.updateWorldMatrix(true, false);
      if (inView(camera)) seen[0].fade = eyeSees(eyeWorld.setFromMatrixPosition(camera.matrixWorld), seen[0].local);
    }
    return Math.max(seen[0].fade, seen[1].fade);
  };
  // текстура i шейдеру: своя или (глаз не видит) — соседняя
  const bindEye = (slot, from) => {
    const u = lensMaterial.uniforms;
    const v = views[from];
    u[`map${slot}`].value = v.target.texture;
    u[`rot${slot}`].value = v.rot;
    u[`h${slot}`].value = v.h;
    u[`eye${slot}`].value = v.eye;
  };

  const api = {
    eyepiece,
    objective,
    scopeCamera,
    targets,
    get target() {
      return targets[0];
    },
    get magnification() {
      return mag;
    },
    setMagnification(m) {
      mag = m;
      lensMaterial.uniforms.mag.value = m;
    },
    setReticle(on) {
      lensMaterial.uniforms.reticle.value = on ? 1 : 0;
    },
    // для отладки (scope-debug.js, vr:eval): что в каждой текстуре
    debug() {
      return { frame, size, samples: SAMPLES, mag, tanA: tanApparent, live: lensMaterial.uniforms.live.value, dist: lastDist, views };
    },
    // для npm run vr:eval: нарисовать текстуру глаза 0 для глаза на выносе на оси, вернуть мс
    debugRender(hideObject = null) {
      eyepiece.updateWorldMatrix(true, false);
      renderEye(0, eyeLocal.set(0, 0, eyeRelief), hideObject);
      bindEye(0, 0);
      bindEye(1, 0);
      return views[0].ms;
    },
    // Каждый кадр, в конце update сцены. active — можно ли смотреть; hideObject — группа прибора
    // (не должна попасть в свой объектив). Возвращает true, если изображение есть.
    update(active, hideObject = null) {
      const fade = active ? collectEyes() : 0;
      const live = fade > 0.002;
      if (live) {
        frame += 1;
        let every = 1;
        for (let k = 0; k < FAR_EVERY.length; k += 1) if (lastDist <= FAR_EVERY[k][0]) { every = FAR_EVERY[k][1]; break; }
        // Оба глаза видят стекло — ОДНА текстура на оба (MONO): камера смотрит между направлениями
        // глаз, угол — с запасом на оба. Изображение «на бесконечности» от положения глаза не зависит
        // (камера одна и та же, у объектива), различались только направление и угол — так что глазам
        // видна та же картинка, а проход по сцене — один вместо двух (~1,2 мс CPU на Quest каждый).
        // Цена: угол камеры шире на разницу направлений глаз (~25 %), пикселей на градус меньше.
        const both = MONO && seen[0].fade > 0 && seen[1].fade > 0;
        const now = !wasLive || both !== wasBoth || frame % every === 0;
        if (now && both) {
          const a = aimOf(seen[0].local, aimA);
          const b = aimOf(seen[1].local, aimB);
          const dx = Math.abs(a.x - b.x) / 2, dy = Math.abs(a.y - b.y) / 2;
          a.set((a.x + b.x) / 2, (a.y + b.y) / 2, Math.max(a.z, b.z) + Math.max(dx, dy));
          renderEye(0, eyeMid.addVectors(seen[0].local, seen[1].local).multiplyScalar(0.5), hideObject, a);
        } else if (now) {
          for (let i = 0; i < EYES; i += 1) if (seen[i].fade > 0) renderEye(i, seen[i].local, hideObject);
        }
        wasBoth = both;
        // MONO — оба слота с текстурой 0; глаз не видит стекло — его слот берёт текстуру другого
        const a = both || seen[0].fade > 0 ? 0 : 1;
        const b = both ? 0 : seen[1].fade > 0 ? 1 : 0;
        bindEye(0, a);
        bindEye(1, b);
      }
      wasLive = live;
      lensMaterial.uniforms.live.value = live ? fade : 0;
      const t = performance.now();
      if (t - statAt >= LOG_EVERY_MS) {
        if (statN) {
          console.log(`[scope] n=${statN}/${((t - statAt) / 1000).toFixed(0)}s cpu=${(statSum / statN).toFixed(2)}/${statMax.toFixed(2)}ms calls=${statCalls} tris=${(statTris / 1000).toFixed(0)}k size=${size} msaa=${SAMPLES} x${mag.toFixed(1)}`);
        }
        statN = statSum = statMax = 0;
        statAt = t;
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
      targets.forEach((t) => t.dispose());
    },
  };
  return api;
}
