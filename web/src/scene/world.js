// Мир вокруг: слегка волнистая зелёная земля до горизонта, небо заката и облака. Закат справа от
// игрока (вправо по оси мира +X, то есть после центровки по правую руку), слева небо темнее, со
// звёздами. Живёт в сцене: правки подхватываются на лету.
//
// Небо — свой шейдер на сфере вокруг головы: закатный градиент, солнце с ореолом, слой облаков из
// текстуры шума (плывут и меняют форму), Млечный Путь. Один вызов отрисовки; рисуется после
// непрозрачного, поэтому считается только там, где неба не закрывает земля. Звёзды — точки со своим
// шейдером (мерцают, прячутся за облаками). Земля — свой маленький шейдер: пятна разных оттенков
// зелени из шума и дымка у горизонта под цвет неба.
export function createWorld({ THREE, scene, root, camera, renderer }) {
  // Дорогое (шум, земля, звёзды, ~36 000 травинок, запечённые тени травы, текстуры на GPU) строится
  // один раз и переживает подмену сцены: на шлеме это ~0,5 с работы и заливки текстур на каждой
  // подмене. Ключ — исходный текст createWorld: любая правка этой функции строит всё заново.
  const shared = (globalThis.__sceneState ??= {});
  const WORLD_KEY = createWorld.toString();
  if (shared.worldCache?.key !== WORLD_KEY) {
    const stale = shared.worldCache;
    // старое освобождается позже: пока подменяется сцена, его ещё может рисовать прежняя версия
    if (stale) setTimeout(() => stale.free?.(), 5000);
    shared.worldCache = {
      key: WORLD_KEY,
      free() {
        for (const item of [this.noiseTexture, this.cloudTexture, this.shadowTarget, this.ground, this.starGeometry]) item?.dispose();
        for (const lod of this.lods ?? []) lod.geometry.dispose();
      },
    };
  }
  const cache = shared.worldCache;

  // --- дальность: небо и земля уходят далеко за 100 м, которые выставляет страница
  const oldFar = camera.far;
  camera.far = 5000;
  camera.updateProjectionMatrix();

  // Тональная компрессия — для предметов сцены (пистолеты, мишени). Небо, земля и трава считают
  // цвет сами и её не используют. Окна сообщений, меню и кружок страницы её тоже не замечают.
  const oldToneMapping = renderer.toneMapping;
  const oldExposure = renderer.toneMappingExposure;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.55;

  // сетка страницы уступает место земле
  const grid = scene.children.find((child) => child.type === 'GridHelper');
  const gridWasVisible = grid?.visible;
  if (grid) grid.visible = false;

  // солнце справа, у самого горизонта
  const SUN_ELEVATION = 2.2; // градусов над горизонтом
  const SUN_AZIMUTH = -8; // градусов: 0 — ровно справа (+X), плюс — к игроку, минус — вперёд
  const sunDirection = new THREE.Vector3().setFromSphericalCoords(
    1,
    THREE.MathUtils.degToRad(90 - SUN_ELEVATION),
    THREE.MathUtils.degToRad(90 + SUN_AZIMUTH),
  );

  // ---------- шум для шейдеров земли и травы: одна маленькая повторяющаяся текстура 256² вместо
  // вычисления шума на GPU (хеши в каждом пикселе земли стоили на Quest ~30 кадров в секунду).
  // В каждом канале свой гладкий шум, 32 клетки на текстуру; мип-уровни убирают мерцание вдали.
  const smooth = (a, b, x) => {
    const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  };
  let seed = 7;
  const seeded = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
  const NOISE_SIZE = 256;
  const NOISE_CELLS = 32;
  const noiseFresh = !cache.noiseData;
  const noiseData = (cache.noiseData ??= new Uint8Array(NOISE_SIZE * NOISE_SIZE * 4));
  if (!noiseFresh) seed = cache.seedAfterNoise; // травинки дальше берут случайные числа с того же места
  for (let channel = 0; noiseFresh && channel < 4; channel += 1) {
    const lattice = Array.from({ length: NOISE_CELLS * NOISE_CELLS }, seeded);
    const at = (x, y) => lattice[(y % NOISE_CELLS) * NOISE_CELLS + (x % NOISE_CELLS)];
    const cell = NOISE_SIZE / NOISE_CELLS;
    for (let y = 0; y < NOISE_SIZE; y += 1) {
      for (let x = 0; x < NOISE_SIZE; x += 1) {
        const ix = Math.floor(x / cell);
        const iy = Math.floor(y / cell);
        const sx = smooth(0, 1, (x % cell) / cell);
        const sy = smooth(0, 1, (y % cell) / cell);
        const top = at(ix, iy) + (at(ix + 1, iy) - at(ix, iy)) * sx;
        const bottom = at(ix, iy + 1) + (at(ix + 1, iy + 1) - at(ix, iy + 1)) * sx;
        noiseData[(y * NOISE_SIZE + x) * 4 + channel] = Math.round((top + (bottom - top) * sy) * 255);
      }
    }
  }
  if (noiseFresh) cache.seedAfterNoise = seed;
  const noiseTexture = (cache.noiseTexture ??= new THREE.DataTexture(noiseData, NOISE_SIZE, NOISE_SIZE, THREE.RGBAFormat, THREE.UnsignedByteType));
  if (noiseTexture.version === 0) {
    noiseTexture.wrapS = noiseTexture.wrapT = THREE.RepeatWrapping;
    noiseTexture.magFilter = THREE.LinearFilter;
    noiseTexture.minFilter = THREE.LinearMipmapLinearFilter;
    noiseTexture.generateMipmaps = true;
    noiseTexture.needsUpdate = true;
  }

  // ---------- небо: шейдер на сфере, которая следует за головой
  // Цвета линейные и уже готовые для экрана (тональной компрессии нет, только мягкий потолок яркости
  // у солнца). Дымка земли у горизонта берёт те же цвета, что горизонт неба, — шва нет.
  const hazeWarm = new THREE.Vector3(0.85, 0.2, 0.045); // горизонт под солнцем: густо-оранжевый
  const hazeCool = new THREE.Vector3(0.1, 0.1, 0.2); // горизонт с другой стороны: сизо-синий
  const sunFlat = new THREE.Vector2(sunDirection.x, sunDirection.z).normalize();
  // Облака — слой на высоте: луч взгляда пересекается с плоскостью над головой (координата =
  // направление.xz / (высота луча + 0,03)): над головой облака крупные, к горизонту мельче и сжимаются.
  // Форма — не шум, а карта облаков, нарисованная один раз при загрузке: несколько отдельных кучевых
  // облаков, каждое — груда шаров-клубов (крупные и высокие в середине, мелкие по краю), между ними
  // чистое небо. В карте: R — толщина, G и B — наклон поверхности клуба (по нему облако освещается
  // как объёмное), A — где облако есть. Два слоя карты (ниже и выше, разный масштаб) медленно плывут
  // с разной скоростью, а медленно меняющееся искажение заставляет клубы понемногу перетекать.
  const CLOUD_MAP = 1024;
  const CLOUD_MAP_UNITS = 6; // карта покрывает 6×6 высот слоя и повторяется
  const MAP = 1 / CLOUD_MAP_UNITS;
  const CLOUD_MAP_KEY = 'clumps-v3';
  // карта рисуется один раз за загрузку страницы (на шлеме это заметная пауза), при подмене сцены — из памяти
  let cloudMapData = globalThis.__skyCloudMap?.key === CLOUD_MAP_KEY ? globalThis.__skyCloudMap.data : null;
  if (!cloudMapData) {
    const N = CLOUD_MAP;
    const height = new Float32Array(N * N);
    let state = 31337;
    const rnd = () => {
      state = (state * 1664525 + 1013904223) % 4294967296;
      return state / 4294967296;
    };
    // клуб — мягкий бугор толщины (без резкого края); клубы складываются, так что середина облака
    // плотнее и выше, а края мягко сходят на нет. Центр и радиус в долях карты.
    const puff = (cx, cy, r, weight = 1) => {
      const pr = r * N;
      const px = cx * N;
      const py = cy * N;
      for (let y = Math.floor(py - pr); y <= Math.ceil(py + pr); y += 1) {
        const wy = ((y % N) + N) % N;
        for (let x = Math.floor(px - pr); x <= Math.ceil(px + pr); x += 1) {
          const dx = (x + 0.5 - px) / pr;
          const dy = (y + 0.5 - py) / pr;
          const d2 = dx * dx + dy * dy;
          if (d2 >= 1) continue;
          const k = 1 - d2;
          height[wy * N + (((x % N) + N) % N)] += r * k * k * weight;
        }
      }
    };
    // центры облаков — не ближе друг к другу, чем их размеры (с учётом повтора карты)
    const clumps = [];
    const wrapped = (a) => Math.abs(a - Math.round(a));
    const sizes = [0.1, 0.095, 0.085, 0.08, 0.07, 0.045, 0.04, 0.035, 0.035, 0.03, 0.028];
    for (const R of sizes) {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const cx = rnd();
        const cy = rnd();
        if (clumps.every((c) => Math.hypot(wrapped(cx - c.cx) / 1.4, wrapped(cy - c.cy)) > (R + c.R) * 1.25)) {
          clumps.push({ cx, cy, R });
          break;
        }
      }
    }
    for (const { cx, cy, R } of clumps) {
      const big = R > 0.06;
      const stretch = 1.3 + rnd() * 0.4; // вдоль ветра (X) облака длиннее
      puff(cx, cy, R * 0.75, 1.2);
      const core = big ? 7 + Math.floor(rnd() * 6) : 3 + Math.floor(rnd() * 3);
      for (let k = 0; k < core; k += 1) {
        const a = rnd() * Math.PI * 2;
        const d = R * (0.2 + 0.6 * rnd());
        puff(cx + Math.cos(a) * d * stretch, cy + Math.sin(a) * d, R * (0.35 + 0.25 * rnd()) * (1 - (0.3 * d) / R));
      }
      // мелкие клубы по краю: край облака бугристый, «цветная капуста»
      const rim = big ? 26 + Math.floor(rnd() * 14) : 8 + Math.floor(rnd() * 5);
      for (let k = 0; k < rim; k += 1) {
        const a = rnd() * Math.PI * 2;
        const d = R * (0.55 + 0.4 * rnd());
        puff(cx + Math.cos(a) * d * stretch, cy + Math.sin(a) * d, R * (0.12 + 0.14 * rnd()), 0.9);
      }
    }
    let hMax = 1e-6;
    for (let i = 0; i < N * N; i += 1) hMax = Math.max(hMax, height[i]);
    // наклон поверхности — по соседним пикселям толщины: клубы сливаются плавно, без швов
    const at = (x, y) => height[(((y % N) + N) % N) * N + (((x % N) + N) % N)];
    const slopeScale = N / hMax / 18;
    cloudMapData = new Uint8Array(N * N * 4);
    for (let y = 0; y < N; y += 1) {
      for (let x = 0; x < N; x += 1) {
        const i = y * N + x;
        const gx = (at(x + 1, y) - at(x - 1, y)) * slopeScale;
        const gy = (at(x, y + 1) - at(x, y - 1)) * slopeScale;
        const len = Math.sqrt(gx * gx + gy * gy + 1);
        cloudMapData[i * 4] = Math.round(Math.sqrt(height[i] / hMax) * 255);
        cloudMapData[i * 4 + 1] = Math.round((-gx / len) * 127.5 + 127.5);
        cloudMapData[i * 4 + 2] = Math.round((-gy / len) * 127.5 + 127.5);
        cloudMapData[i * 4 + 3] = 255;
      }
    }
    globalThis.__skyCloudMap = { key: CLOUD_MAP_KEY, data: cloudMapData };
  }
  if (cache.cloudTexture?.image.data !== cloudMapData) cache.cloudTexture = null;
  const cloudTexture = (cache.cloudTexture ??= new THREE.DataTexture(cloudMapData, CLOUD_MAP, CLOUD_MAP, THREE.RGBAFormat, THREE.UnsignedByteType));
  if (cloudTexture.version === 0) {
    cloudTexture.wrapS = cloudTexture.wrapT = THREE.RepeatWrapping;
    cloudTexture.magFilter = THREE.LinearFilter;
    cloudTexture.minFilter = THREE.LinearMipmapLinearFilter;
    cloudTexture.generateMipmaps = true;
    cloudTexture.needsUpdate = true;
  }

  const WIND = 0.02; // нижний слой, высот слоя в секунду: спокойно, заметно за 20–30 с
  const HIGH_SCALE = 1.45; // верхний слой мельче
  const HIGH_SPEED = 0.6; // и плывёт медленнее (параллакс)
  const windAngle = Math.atan2(0.3, 1); // ветер дует к закату (+X) и чуть к игроку
  const cloudShift = [0, 0, 0.37, 0.61]; // нижний слой xy, верхний zw
  const warpShift = [0, 0, 0, 0]; // искажение xy, мелкий шум краёв zw
  const skyTime = { value: 0 };
  const skyUniforms = {
    noiseTex: { value: noiseTexture },
    sunDir: { value: sunDirection },
    sunFlat: { value: sunFlat },
    hazeWarm: { value: hazeWarm },
    hazeCool: { value: hazeCool },
    cloudTex: { value: cloudTexture },
    cloudShift: { value: new THREE.Vector4() },
    warpShift: { value: new THREE.Vector4() },
    time: skyTime,
    starPx: { value: 400 },
  };
  // общий кусок неба и звёзд: где облака (звёзды за облаком гаснут)
  const CLOUD_GLSL = `
    uniform sampler2D noiseTex;
    uniform sampler2D cloudTex;
    uniform vec2 sunFlat;
    uniform vec4 cloudShift;
    uniform vec4 warpShift;
    // точка слоя облаков, куда смотрит луч (в высотах слоя)
    vec2 cloudPlane(vec3 dir) { return dir.xz / (max(dir.y, 0.0) + 0.03); }
    // два слоя облаков: lo — нижний, hi — верхний (мельче, медленнее). r — толщина, gb — наклон, a — где облако
    void cloudLayers(vec2 p, out vec4 lo, out vec4 hi) {
      vec4 w = texture2D(noiseTex, p * 0.045 + warpShift.xy) - 0.5; // медленное искажение: клубы перетекают
      lo = texture2D(cloudTex, p * ${MAP.toFixed(5)} + cloudShift.xy + w.rg * 0.04);
      hi = texture2D(cloudTex, vec2(p.x, -p.y) * ${(MAP * HIGH_SCALE).toFixed(5)} + cloudShift.zw + w.ba * 0.04);
    }
    // 1 — сторона солнца, 0 — противоположная; в зените 0.5 (без нормировки: в зените нет излома)
    float sunSide(vec3 dir) { return dot(dir.xz, sunFlat) * 0.5 + 0.5; }
  `;
  const skyGroup = new THREE.Group();
  skyGroup.name = 'scene-sky';
  root.add(skyGroup);
  const skyMaterial = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    toneMapped: false,
    uniforms: skyUniforms,
    vertexShader: `
      varying vec3 vDir;
      void main() {
        vDir = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      uniform vec3 sunDir;
      uniform vec3 hazeWarm;
      uniform vec3 hazeCool;
      uniform float time;
      varying vec3 vDir;
      ${CLOUD_GLSL}
      // мягкий потолок: до 0.8 цвет как есть, выше плавно упирается в 1 (солнце белеет, а не режется)
      vec3 shoulder(vec3 c) { return min(c, 0.8) + 0.2 * (1.0 - exp(-max(c - 0.8, 0.0) * 5.0)); }
      // Облако освещается как груда шаров: нормаль клуба из карты, свет от низкого солнца справа и
      // немного сверху. Сторона к солнцу золотая, обратная — сизая; бок, обращённый к нам и вниз
      // (плоское дно облака), темнее; толща облака в тени темнее; тонкие края у солнца светятся.
      vec3 shadeCloud(vec4 c, float s, float near, vec2 out2, float e, vec3 horizon, float hazeFar, float bright) {
        vec3 N = vec3(c.g * 2.0 - 1.0, 0.0, c.b * 2.0 - 1.0);
        N.y = sqrt(max(0.0, 1.0 - dot(N.xz, N.xz)));
        vec3 L = normalize(vec3(sunFlat.x, 0.35, sunFlat.y));
        float diff = clamp(dot(N, L) * 0.6 + 0.42, 0.0, 1.0);
        float base = clamp(dot(N.xz, -out2), 0.0, 1.0) * (1.0 - e * 0.7);
        diff *= 1.0 - 0.5 * base;
        diff *= 1.0 - 0.35 * c.r * (1.0 - diff);
        vec3 litColor = mix(mix(vec3(0.42, 0.2, 0.32), vec3(0.95, 0.36, 0.34), smoothstep(0.2, 0.6, s)),
                            vec3(1.0, 0.56, 0.18), smoothstep(0.6, 0.97, s));
        vec3 shadowColor = mix(vec3(0.04, 0.045, 0.09), vec3(0.2, 0.08, 0.1), s * s);
        vec3 cloud = mix(shadowColor, litColor * bright, diff * diff * (3.0 - 2.0 * diff));
        cloud += vec3(1.0, 0.62, 0.28) * exp(near * 9.0) * (1.0 - smoothstep(0.0, 0.35, c.r)) * 1.3;
        return mix(cloud, horizon, hazeFar * 0.75);
      }
      void main() {
        vec3 dir = normalize(vDir);
        float e = max(dir.y, 0.0);
        float s = sunSide(dir);
        float near = dot(dir, sunDir) - 1.0; // 0 у солнца, -2 напротив
        // градиент: горизонт (как дымка земли) → розово-фиолетовая полоса → глубокая синева
        vec3 horizon = mix(hazeCool, hazeWarm, s * s * s);
        vec3 band = mix(vec3(0.07, 0.05, 0.13), vec3(0.62, 0.17, 0.17), s * s);
        vec3 zenith = mix(vec3(0.006, 0.01, 0.042), vec3(0.028, 0.065, 0.21), s * s);
        vec3 col = mix(horizon, band, 1.0 - exp(-e * 11.0));
        col = mix(col, zenith, smoothstep(0.04, mix(0.45, 0.85, s), e));
        // свечение вокруг солнца: широкое тёплое у горизонта и ореол
        col += vec3(0.9, 0.3, 0.05) * exp(near * 3.5) * exp(-e * 4.0) * 0.4;
        col += vec3(1.0, 0.5, 0.14) * exp(near * 45.0) * 0.4;
        col += vec3(1.0, 0.32, 0.05) * exp(-e * 30.0) * exp(near * 8.0) * 0.3; // дымка у горизонта под солнцем
        // Млечный Путь: слабая полоса через тёмную сторону неба
        vec3 mwAxis = vec3(0.30, 0.42, 0.86);
        float mwDist = dot(dir, mwAxis);
        float mwNoise = texture2D(noiseTex, vec2(dir.x * 1.6 + dir.y * 0.7, dir.z * 1.6 - dir.y * 1.1) + 0.37).g;
        float mw = exp(-mwDist * mwDist * 28.0) * (0.5 + mwNoise * 0.7) * (1.0 - smoothstep(0.25, 0.6, s)) * smoothstep(0.08, 0.45, e);
        col += vec3(0.032, 0.034, 0.05) * mw;

        vec2 p = cloudPlane(dir);
        float far = length(p); // насколько далеко точка слоя (в высотах слоя)
        float hazeFar = smoothstep(1.5, 22.0, far);
        float show = (1.0 - smoothstep(12.0, 30.0, far)) * smoothstep(-0.005, 0.03, dir.y);
        vec4 lo;
        vec4 hi;
        cloudLayers(p, lo, hi);
        // мягкие рваные края: мелкий шум подъедает только край облака, середина плотная
        float fray = texture2D(noiseTex, p * 0.45 + warpShift.zw).b - 0.5;
        float aLo = smoothstep(0.1, 0.42, lo.r + fray * 0.22 * (1.0 - smoothstep(0.1, 0.5, lo.r))) * show;
        float aHi = smoothstep(0.1, 0.42, hi.r + fray * 0.22 * (1.0 - smoothstep(0.1, 0.5, hi.r))) * show * 0.85;
        vec2 out2 = dir.xz / max(length(dir.xz), 1e-4);
        col = mix(col, shadeCloud(hi, s, near, out2, e, horizon, hazeFar, 0.8), aHi);
        col = mix(col, shadeCloud(lo, s, near, out2, e, horizon, hazeFar, 1.0), aLo);
        float alpha = max(aLo, aHi);

        // солнце: диск с потемнением к краю и ореол-«блум»; за облаком гаснет
        float angle = sqrt(max(-2.0 * near, 0.0));
        float disc = 1.0 - smoothstep(0.0085, 0.0105, angle);
        float limb = 1.0 - 0.35 * (angle / 0.0105) * (angle / 0.0105);
        vec3 sunLight = vec3(1.0, 0.72, 0.38) * 3.0 * disc * limb + vec3(1.0, 0.62, 0.3) * exp(near * 1500.0) * 0.9;
        col += sunLight * (1.0 - alpha * 0.92);
        gl_FragColor = vec4(shoulder(col), 1.0);
        #include <colorspace_fragment>
      }`,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(4500, 48, 24), skyMaterial);
  sky.name = 'scene-sky-dome';
  sky.frustumCulled = false;
  // после всего непрозрачного (но до кружка-индикатора оболочки, 1001): пиксели, закрытые землёй, не считаются
  sky.renderOrder = 900;
  skyGroup.add(sky);

  // ---------- звёзды: мягкие круглые точки разной яркости и цвета, мерцают; на тёмной стороне
  // (слева и выше); за облаками и у светлого горизонта гаснут. Размер — угловой, одинаков в шлеме и на ПК.
  let starSeed = 4242;
  const starRandom = () => {
    starSeed = (starSeed * 1664525 + 1013904223) % 4294967296;
    return starSeed / 4294967296;
  };
  const starPositions = [];
  const starData = []; // угловой размер (рад), яркость, фаза мерцания
  const starTint = [];
  for (let i = 0; i < 4000 && starData.length < 1400 * 3; i += 1) {
    const y = 0.03 + starRandom() * 0.97;
    const angle = starRandom() * Math.PI * 2;
    const r = Math.sqrt(1 - y * y);
    const x = Math.cos(angle) * r;
    const z = Math.sin(angle) * r;
    const side = (x * sunFlat.x + z * sunFlat.y) / Math.max(r, 1e-3) * 0.5 + 0.5;
    const darkness = (1 - smooth(0.3, 0.75, side)) * 0.7 + smooth(0.1, 0.8, y) * 0.5;
    if (starRandom() > darkness) continue;
    starPositions.push(x * 3800, y * 3800, z * 3800);
    const magnitude = starRandom() ** 3.2; // мало ярких, много слабых
    starData.push(THREE.MathUtils.degToRad(0.07 + magnitude * 0.2), 0.25 + magnitude * 1.6, starRandom());
    const t = starRandom();
    starTint.push(...(t < 0.2 ? [1, 0.82, 0.62] : t < 0.45 ? [0.75, 0.85, 1] : [0.95, 0.96, 1]));
  }
  const starGeometry = new THREE.BufferGeometry();
  starGeometry.setAttribute('position', new THREE.Float32BufferAttribute(starPositions, 3));
  starGeometry.setAttribute('aStar', new THREE.Float32BufferAttribute(starData, 3));
  starGeometry.setAttribute('aTint', new THREE.Float32BufferAttribute(starTint, 3));
  const stars = new THREE.Points(
    starGeometry,
    new THREE.ShaderMaterial({
      uniforms: skyUniforms,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
      vertexShader: `
        attribute vec3 aStar;
        attribute vec3 aTint;
        uniform float time;
        uniform float starPx; // половина высоты кадра одного глаза в пикселях
        varying vec3 vColor;
        varying float vCross; // сила лучей: 1 в центре взгляда, 0 сбоку
        varying float vCore; // радиус ядра звезды в долях точки
        varying float vSpike; // толщина луча в долях точки
        varying float vLen; // длина лучей (мерцает)
        ${CLOUD_GLSL}
        void main() {
          vec3 dir = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          float px = aStar.x * projectionMatrix[1][1] * starPx;
          float size = max(px, 1.6);
          float s = sunSide(dir);
          // видны там, где небо тёмное: слева и выше; у горизонта и к закату гаснут
          float sky = (1.0 - smoothstep(0.35, 0.78, s)) * smoothstep(0.02, 0.2, dir.y);
          sky = max(sky, smoothstep(0.35, 0.95, dir.y) * (1.0 - smoothstep(0.7, 0.95, s)) * 0.6);
          vec4 lo;
          vec4 hi;
          cloudLayers(cloudPlane(dir), lo, hi);
          float clear = 1.0 - smoothstep(0.1, 0.35, max(lo.r, hi.r));
          float phase = aStar.z * 60.0;
          float twinkle = 1.0 + (0.12 + 0.3 * (1.0 - dir.y)) * sin(time * (1.7 + aStar.z * 2.5) + phase) * sin(time * 0.73 + phase * 1.3);
          vColor = aTint * aStar.y * sky * clear * twinkle * min(1.0, (px * px) / (size * size) * 1.5);
          // У центра взгляда яркие звёзды искрятся «плюсом» (как через звёздный фильтр): точка шире,
          // чтобы поместились лучи; к краю обзора — обычные круглые точки.
          float center = 1.0 - smoothstep(0.05, 0.5, length(gl_Position.xy / gl_Position.w));
          float sparkle = center * smoothstep(0.15, 0.9, aStar.y);
          float scale = 2.0 + 6.0 * sparkle;
          float total = size * scale;
          vCore = 2.0 / scale;
          vSpike = max(vCore * 0.11, 1.1 / total);
          // плюс мягко мерцает: у каждой звезды своя частота (0,2–0,6 Гц) и фаза; яркость и длина лучей ±30 %
          float freq = 1.26 + fract(aStar.z * 7.31) * 2.5;
          float glint = 0.6 * sin(time * freq + phase) + 0.4 * sin(time * freq * 0.61 + phase * 2.3);
          vCross = sparkle * (1.0 + 0.3 * glint);
          vLen = 0.8 + 0.2 * glint;
          gl_PointSize = total;
        }`,
      fragmentShader: `
        varying vec3 vColor;
        varying float vCross;
        varying float vCore;
        varying float vSpike;
        varying float vLen;
        void main() {
          vec2 p = gl_PointCoord * 2.0 - 1.0;
          float r2 = dot(p, p);
          // круглое ядро + тонкие лучи по горизонтали и вертикали, гаснущие к концам; всё внутри круга
          float a = exp(-r2 / (vCore * vCore) * 1.75 * (1.0 + 7.0 * min(vCross, 1.0))); // у искрящейся звезды ядро маленькое: плюс, а не кружок
          if (vCross > 0.01) {
            vec2 ap = abs(p);
            vec2 fade = 1.0 - smoothstep(0.0, vLen, ap);
            float w = 1.0 / (vSpike * vSpike);
            float spikes = exp(-ap.y * ap.y * w) * fade.x * fade.x + exp(-ap.x * ap.x * w) * fade.y * fade.y;
            a += vCross * (spikes * 1.0 + exp(-r2 / (vCore * vCore) * 3.2) * 0.08); // лучи и мягкий ореол
          }
          a *= 1.0 - smoothstep(0.75, 1.0, r2);
          gl_FragColor = vec4(vColor * a, 1.0);
          #include <colorspace_fragment>
        }`,
    }),
  );
  stars.name = 'scene-stars';
  stars.renderOrder = -999;
  stars.frustumCulled = false;
  skyGroup.add(stars);

  // Луг: где растёт трава. Впереди, в сторону мишеней (−Z), и по бокам; позади игрока её нет.
  // До FLARE_FROM поле шириной 2×HALF_WIDTH, дальше расходится конусом до FAR. Края поля волнистые
  // и мягкие; одна и та же формула здесь (где сажать травинки) и в шейдере земли (где земля под
  // травой темнее), чтобы трава и земля под ней совпадали.
  const GRASS_AREA = { halfWidth: 15, near: 2, far: -100, flareFrom: -20, flare: 0.55 }; // метры
  const wobble = (t) => 1.1 * Math.sin(t * 0.61) + 0.7 * Math.sin(t * 1.53 + 1.7);
  const meadow = (x, z) => {
    const beyond = Math.max(0, GRASS_AREA.flareFrom - z);
    const half = GRASS_AREA.halfWidth + beyond * GRASS_AREA.flare;
    const ramp = 5 + beyond * 0.12;
    return Math.min(
      smooth(-half, -half + ramp, x + wobble(z)),
      1 - smooth(half - ramp, half, x - wobble(z + 20)),
      smooth(GRASS_AREA.far, GRASS_AREA.far + 20, z + 3 * wobble(x * 0.5 + 40)),
      1 - smooth(GRASS_AREA.near - 2.5, GRASS_AREA.near, z - 0.5 * wobble(x + 60)),
    );
  };
  // то же, что meadowPatch в шейдере, но на процессоре: билинейная выборка текстуры шума
  const noiseAt = (x, z, channel) => {
    const u = (x / NOISE_CELLS) * NOISE_SIZE - 0.5;
    const v = (z / NOISE_CELLS) * NOISE_SIZE - 0.5;
    const ix = Math.floor(u);
    const iy = Math.floor(v);
    const fx = u - ix;
    const fy = v - iy;
    const wrap = (n) => ((n % NOISE_SIZE) + NOISE_SIZE) % NOISE_SIZE;
    const at = (a, b) => noiseData[(wrap(iy + b) * NOISE_SIZE + wrap(ix + a)) * 4 + channel] / 255;
    const top = at(0, 0) + (at(1, 0) - at(0, 0)) * fx;
    const bottom = at(0, 1) + (at(1, 1) - at(0, 1)) * fx;
    return top + (bottom - top) * fy;
  };
  const meadowPatch = (x, z) => noiseAt(x * 0.09, z * 0.09, 2) * 0.65 + noiseAt(x * 0.23 + 5.3, z * 0.23 + 5.3, 3) * 0.35;
  const f = (v) => v.toFixed(2);
  // Общий кусок шейдеров земли и травы (цвета линейные; в цвет экрана их переводит three)
  const MEADOW_GLSL = `
    uniform sampler2D noiseTex;
    vec4 noise4(vec2 p) { return texture2D(noiseTex, p * ${f(1 / NOISE_CELLS)}); }
    float wobble(float t) { return 1.1 * sin(t * 0.61) + 0.7 * sin(t * 1.53 + 1.7); }
    float meadowMask(vec2 p) {
      float beyond = max(0.0, ${f(GRASS_AREA.flareFrom)} - p.y);
      float halfWidth = ${f(GRASS_AREA.halfWidth)} + beyond * ${f(GRASS_AREA.flare)};
      float ramp = 5.0 + beyond * 0.12;
      return min(
        min(smoothstep(-halfWidth, -halfWidth + ramp, p.x + wobble(p.y)),
            1.0 - smoothstep(halfWidth - ramp, halfWidth, p.x - wobble(p.y + 20.0))),
        min(smoothstep(${f(GRASS_AREA.far)}, ${f(GRASS_AREA.far + 20)}, p.y + 3.0 * wobble(p.x * 0.5 + 40.0)),
            1.0 - smoothstep(${f(GRASS_AREA.near - 2.5)}, ${f(GRASS_AREA.near)}, p.y - 0.5 * wobble(p.x + 60.0))));
    }
    // пятна луга: желтоватая и сизая зелень; по ним же окрашены травинки
    float meadowPatch(vec2 p) { return noise4(p * 0.09).b * 0.65 + noise4(p * 0.23 + 5.3).a * 0.35; }
    // земля под травой: тёмная, как глубина густой травы
    vec3 meadowGround(float tint) { return mix(vec3(0.022, 0.044, 0.012), vec3(0.048, 0.068, 0.017), smoothstep(0.3, 0.75, tint)); }
  `;

  // ---------- земля: слегка волнистая; цвет считает шейдер по мировым координатам
  const SIZE = 9000;
  // Сетка земли неравномерная: линии сетки стоят по квадрату расстояния от центра (1 м, 4 м, 10 м,
  // 18 м, … 70 м, 110 м, …), то есть у игрока часто, к горизонту редко. 128² клеток вместо прежних
  // 260² равномерных — вчетверо меньше треугольников, а холмы вблизи даже точнее.
  const SEGMENTS = 128;
  const warp = (v) => Math.sign(v) * (SIZE / 2) * (Math.abs(v) / (SIZE / 2)) ** 2;
  const height = (x, z) => {
    const amplitude = smooth(6, 70, Math.hypot(x, z)); // рядом с игроком ровно
    return amplitude * (1.2 * Math.sin(x * 0.019) * Math.cos(z * 0.016) + 0.6 * Math.sin(x * 0.052 + z * 0.041) + 0.3 * Math.sin(z * 0.1 - x * 0.07));
  };
  const groundFresh = !cache.ground;
  const ground = (cache.ground ??= new THREE.PlaneGeometry(SIZE, SIZE, SEGMENTS, SEGMENTS));
  if (groundFresh) {
    ground.rotateX(-Math.PI / 2);
    const positions = ground.attributes.position;
    for (let i = 0; i < positions.count; i += 1) {
      const x = warp(positions.getX(i));
      const z = warp(positions.getZ(i));
      positions.setXYZ(i, x, height(x, z), z);
    }
    ground.computeVertexNormals();
  }
  const land = new THREE.Mesh(
    ground,
    new THREE.ShaderMaterial({
      toneMapped: false,
      uniforms: {
        sunDir: { value: sunDirection },
        hazeWarm: { value: hazeWarm },
        hazeCool: { value: hazeCool },
        grassShadow: { value: null },
        shadowMatrix: { value: new THREE.Matrix4() },
        shadowOn: { value: 0 },
        noiseTex: { value: noiseTexture },
      },
      vertexShader: `
        varying vec3 vWorld;
        varying vec3 vNormal;
        void main() {
          vec4 world = modelMatrix * vec4(position, 1.0);
          vWorld = world.xyz;
          vNormal = normalize(mat3(modelMatrix) * normal);
          gl_Position = projectionMatrix * viewMatrix * world;
        }`,
      fragmentShader: `
        uniform vec3 sunDir;
        uniform vec3 hazeWarm;
        uniform vec3 hazeCool;
        uniform sampler2D grassShadow;
        uniform mat4 shadowMatrix;
        uniform float shadowOn;
        varying vec3 vWorld;
        varying vec3 vNormal;
        ${MEADOW_GLSL}
        void main() {
          vec2 p = vWorld.xz;
          float far = length(vWorld.xz - cameraPosition.xz);
          // мелкие детали гаснут с расстоянием: иначе вдали они мерцают от малейшего движения головы
          float midFade = 1.0 - smoothstep(60.0, 260.0, far);
          float fineFade = 1.0 - smoothstep(6.0, 30.0, far);
          float big = noise4(p * 0.012).r;   // большие пятна полей
          float tint = meadowPatch(p);
          float mid = mix(0.5, tint, midFade);    // пятна травы
          vec4 spots = noise4(p * 0.03 + 40.0);    // сухие и земляные пятна
          float fine = mix(0.5, noise4(p * 1.7).r, fineFade);  // мелкая рябь у ног
          vec3 darkGreen = vec3(0.030, 0.062, 0.016);
          vec3 green = vec3(0.052, 0.098, 0.024);
          vec3 lightGreen = vec3(0.100, 0.140, 0.036);
          vec3 dry = vec3(0.170, 0.145, 0.060);
          vec3 earth = vec3(0.085, 0.060, 0.032);
          vec3 col = mix(darkGreen, green, smoothstep(0.25, 0.7, mid));
          col = mix(col, lightGreen, smoothstep(0.55, 0.8, big) * 0.8);
          float patchFade = 1.0 - smoothstep(300.0, 1200.0, far);
          col = mix(col, dry, smoothstep(0.62, 0.85, spots.r) * 0.6 * patchFade);
          col = mix(col, earth, smoothstep(0.68, 0.88, spots.g) * 0.5 * patchFade);
          col *= 0.88 + fine * 0.24;
          // закатный свет: склоны к солнцу теплее и светлее, от солнца темнее и холоднее
          float light = clamp(dot(normalize(vNormal), normalize(vec3(sunDir.x, 0.45, sunDir.z))), 0.0, 1.0);
          col *= 0.62 + 0.5 * light;
          col += vec3(0.05, 0.022, 0.0) * light;
          // под травой земля тёмная, как глубина густой травы: просветы между травинками не светятся
          float mask = meadowMask(p);
          col = mix(col, meadowGround(tint), mask);
          // тени травинок (текстура силуэтов со стороны солнца); две точки с линейной фильтрацией
          // смягчают края. Вне луга травы нет — и выборок нет.
          if (shadowOn > 0.5 && mask > 0.0) {
            vec4 lc = shadowMatrix * vec4(vWorld, 1.0);
            vec2 suv = lc.xy * 0.5 + 0.5;
            if (suv.x > 0.0 && suv.x < 1.0 && suv.y > 0.0 && suv.y < 1.0) {
              vec2 texel = vec2(0.75 / 2048.0);
              float lit = texture2D(grassShadow, suv + texel).r + texture2D(grassShadow, suv - texel).r;
              col *= 1.0 - (1.0 - lit * 0.5) * 0.55;
            }
          }
          // дымка у горизонта: к закату тёплая, в другую сторону холодная, чтобы земля сливалась с небом
          float distance = length(vWorld.xz - cameraPosition.xz);
          vec2 dir = normalize(vWorld.xz - cameraPosition.xz + vec2(1e-4));
          float toward = clamp(dot(dir, normalize(sunDir.xz)) * 0.5 + 0.5, 0.0, 1.0);
          vec3 haze = mix(hazeCool, hazeWarm, pow(toward, 3.0));
          float fog = 1.0 - exp(-max(distance - 40.0, 0.0) / 900.0);
          gl_FragColor = vec4(mix(col, haze, fog), 1.0);
          #include <colorspace_fragment>
        }`,
    }),
  );
  land.name = 'scene-ground';
  land.frustumCulled = false;
  root.add(land);

  // ---------- трава: десятки тысяч травинок в двух InstancedMesh, колышутся на ветру (ветер считает
  // вершинный шейдер, на процессоре ничего не пересчитывается каждый кадр). Травинки растут
  // кустиками: в кустике 4–10 травинок, расходятся веером, у кустика свой рост и оттенок; между
  // кустиками — одиночные. Сторона травинки к солнцу (справа, низко) тёплая и светлая, обратная
  // тёмная, а против солнца травинки просвечивают. Вдали трава сливается с землёй под ней.
  const GRASS_COUNT = 36000;
  // Ближние травинки — полоска из двух звеньев (изгиб виден), дальше LOD_DISTANCE от игрока — один
  // треугольник той же формы: вершин втрое меньше, а издали разницы нет. Трава упирается в
  // вершинный шейдер, так что это прямой выигрыш в кадрах.
  const LOD_DISTANCE = 10;
  const blade = new THREE.PlaneGeometry(0.05, 1, 1, 2);
  blade.translate(0, 0.5, 0); // основание у земли
  const bladePositions = blade.attributes.position;
  for (let i = 0; i < bladePositions.count; i += 1) {
    const y = bladePositions.getY(i);
    bladePositions.setX(i, bladePositions.getX(i) * (1 - y) ** 0.9); // сужается к кончику
    bladePositions.setZ(i, y * y * 0.12); // и чуть изогнута
  }
  const farBlade = new THREE.BufferGeometry();
  farBlade.setAttribute('position', new THREE.Float32BufferAttribute([-0.025, 0, 0, 0.025, 0, 0, 0, 1, 0.12], 3));
  farBlade.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0.5, 1], 2));
  // на травинку: оттенок кустика, своя случайность (0..1) и пятно луга под ней (meadowPatch из шейдера,
  // посчитанный здесь заранее: выборка текстуры в вершинном шейдере на Quest дорогая)
  const grassFresh = !cache.lods; // травинки уже расставлены (подмена сцены): берём готовые
  const lods = cache.lods ?? [blade, farBlade].map((geometry) => ({
    geometry,
    count: 0,
    matrices: new Float32Array(GRASS_COUNT * 16),
    variation: new Float32Array(GRASS_COUNT * 3),
  }));
  const grassTime = { value: 0 };
  const grassMaterial = new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    toneMapped: false,
    uniforms: { time: grassTime, sunDir: { value: sunDirection }, noiseTex: { value: noiseTexture } },
    // Весь свет считается по вершинам (у ближней травинки их 6): так на Quest заметно дешевле, чем в каждом
    // пикселе, а на узкой травинке разницы не видно. Фрагментный шейдер только выбирает сторону.
    vertexShader: `
      attribute vec3 aVariation;
      uniform float time;
      uniform vec3 sunDir;
      varying vec3 vFront;
      varying vec3 vBack;
      ${MEADOW_GLSL}
      void main() {
        mat4 m = modelMatrix * instanceMatrix;
        vec4 world = m * vec4(position, 1.0);
        vec3 base = m[3].xyz;
        float tall = length(m[1].xyz);
        float h = uv.y;
        float bend = h * h;
        float gust = sin(time * 1.3 + base.x * 0.35 + base.z * 0.22) * 0.6 + sin(time * 2.9 + base.x * 1.7 + base.z * 0.9) * 0.25;
        float sway = bend * (0.4 + tall * 1.6); // высокие гнутся сильнее
        world.x += sway * (0.06 + gust * 0.07);
        world.z += sway * gust * 0.03;
        gl_Position = projectionMatrix * viewMatrix * world;

        // цвет: сизо-зелёный ↔ жёлто-зелёный по пятнам луга и по кустику; изредка сухая травинка
        float tint = aVariation.z;
        float tone = clamp(tint * 0.7 + aVariation.x * 0.6 - 0.25, 0.0, 1.0);
        vec3 lush = mix(vec3(0.030, 0.095, 0.020), vec3(0.090, 0.140, 0.022), tone);
        lush *= 0.8 + 0.4 * aVariation.y;
        lush = mix(lush, vec3(0.16, 0.13, 0.05), step(0.94, aVariation.y) * 0.8);
        vec3 ground = meadowGround(tint);
        vec3 albedo = mix(ground * 0.8, lush, smoothstep(0.0, 0.7, h));
        // свет: небо сверху, низкое тёплое солнце справа; низ травинок в тени соседних
        vec3 n = normalize(mat3(m) * vec3(0.0, -0.5 * h, 1.0));
        vec3 L = normalize(vec3(sunDir.x, 0.18, sunDir.z));
        float ndl = dot(n, L);
        float sunReach = smoothstep(0.15, 1.0, h);
        vec3 sky = albedo * vec3(0.30, 0.34, 0.48) * (0.5 + 0.5 * h);
        vec3 sun = vec3(1.0, 0.58, 0.28) * 1.5 * sunReach;
        // просвечивание: обратная к солнцу сторона и особенно взгляд против солнца
        vec3 glow = (lush * 1.6 + vec3(0.05, 0.035, 0.0)) * vec3(1.0, 0.8, 0.3) * sunReach;
        float against = pow(clamp(dot(normalize(world.xyz - cameraPosition), L), 0.0, 1.0), 3.0);
        vFront = sky + albedo * sun * max(ndl, 0.0) + glow * (max(-ndl, 0.0) * 0.6 + against * 1.6);
        vBack = sky + albedo * sun * max(-ndl, 0.0) + glow * (max(ndl, 0.0) * 0.6 + against * 1.6);
        // вдали травинки сливаются с землёй под ними: поле густое, без мерцания
        float fade = smoothstep(8.0, 28.0, length(world.xz - cameraPosition.xz)) * 0.55;
        vFront = mix(vFront, ground * 1.25, fade);
        vBack = mix(vBack, ground * 1.25, fade);
      }`,
    fragmentShader: `
      varying vec3 vFront;
      varying vec3 vBack;
      void main() {
        gl_FragColor = vec4(gl_FrontFacing ? vFront : vBack, 1.0);
        #include <colorspace_fragment>
      }`,
  });
  if (grassFresh) {
    const up = new THREE.Vector3(0, 1, 0);
    const axis = new THREE.Vector3();
    const tilt = new THREE.Quaternion();
    const yaw = new THREE.Quaternion();
    const turn = new THREE.Quaternion();
    const where = new THREE.Vector3();
    const size = new THREE.Vector3();
    const matrix = new THREE.Matrix4();
    // высота земли ровно такая, как у её сетки (клетки в десятки метров, треугольники интерполируют
    // высоту линейно), иначе вдали травинки висели бы над землёй или тонули в ней
    const cell = SIZE / SEGMENTS;
    const line = (k) => warp(k * cell - SIZE / 2); // k-я линия сетки
    const index = (v) => Math.floor((Math.sign(v) * Math.sqrt(Math.abs(v) / (SIZE / 2)) * (SIZE / 2) + SIZE / 2) / cell);
    const groundHeight = (x, z) => {
      const ix = index(x);
      const iz = index(z);
      const fx = (x - line(ix)) / (line(ix + 1) - line(ix));
      const fz = (z - line(iz)) / (line(iz + 1) - line(iz));
      const at = (a, b) => height(line(ix + a), line(iz + b));
      if (fx + fz <= 1) return at(0, 0) + (at(1, 0) - at(0, 0)) * fx + (at(0, 1) - at(0, 0)) * fz;
      return at(1, 1) + (at(0, 1) - at(1, 1)) * (1 - fx) + (at(1, 0) - at(1, 1)) * (1 - fz);
    };
    // густота: у игрока полная, к мишеням реже, дальше по конусу ещё реже (1 / (1 + (d/10)²))
    const density = (z) => 1 / (1 + (Math.max(0, -z - 3) / 10) ** 2);
    const widest = GRASS_AREA.halfWidth + (GRASS_AREA.flareFrom - GRASS_AREA.far) * GRASS_AREA.flare;
    let i = 0;
    while (i < GRASS_COUNT) {
      const cx = (seeded() * 2 - 1) * widest;
      const cz = GRASS_AREA.far + seeded() * (GRASS_AREA.near - GRASS_AREA.far);
      const m = meadow(cx, cz);
      if (m < 0.02 || seeded() > (0.3 + 0.7 * m) * density(cz)) continue; // к краям поля и вдали реже
      // вдали травинки крупнее и кустики шире: редкое поле всё равно читается травой
      const far = Math.max(0, -cz - 20);
      const grow = 1 + far / 35;
      const single = seeded() < 0.45;
      const count = single ? 1 : 4 + Math.floor(seeded() * 7);
      const radius = single ? 0 : (0.07 + seeded() * 0.16) * grow;
      const clumpTall = (0.22 + seeded() ** 1.5 * 0.5) * (1 + far / 120);
      const clumpTone = seeded();
      for (let k = 0; k < count && i < GRASS_COUNT; k += 1, i += 1) {
        const angle = seeded() * Math.PI * 2;
        const r = radius * Math.sqrt(seeded());
        const x = cx + Math.cos(angle) * r;
        const z = cz + Math.sin(angle) * r;
        const edge = meadow(x, z);
        const tall = clumpTall * (0.65 + 0.55 * seeded()) * (0.15 + 0.85 * edge); // к краю ниже
        // наклон наружу от середины кустика (веером)
        const lean = single ? seeded() * 0.15 : (0.1 + 0.4 * (r / radius)) * (0.6 + 0.4 * seeded());
        axis.set(Math.sin(angle), 0, -Math.cos(angle));
        tilt.setFromAxisAngle(axis, lean);
        yaw.setFromAxisAngle(up, seeded() * Math.PI * 2);
        turn.multiplyQuaternions(tilt, yaw);
        where.set(x, groundHeight(x, z), z);
        size.set((0.7 + seeded() * 1.1) * grow, tall, 1);
        matrix.compose(where, turn, size);
        const lod = lods[Math.hypot(x, z) < LOD_DISTANCE ? 0 : 1];
        matrix.toArray(lod.matrices, lod.count * 16);
        lod.variation[lod.count * 3] = clumpTone;
        lod.variation[lod.count * 3 + 1] = seeded();
        lod.variation[lod.count * 3 + 2] = meadowPatch(x, z);
        lod.count += 1;
      }
    }
  }
  const grass = new THREE.Group();
  grass.name = 'scene-grass';
  root.add(grass);
  if (grassFresh) {
    for (const lod of lods) {
      lod.geometry.setAttribute('aVariation', new THREE.InstancedBufferAttribute(lod.variation.subarray(0, lod.count * 3), 3));
      lod.instanceMatrix = new THREE.InstancedBufferAttribute(lod.matrices.slice(0, lod.count * 16), 16);
    }
    cache.lods = lods;
  }
  // меши травы — новые, а матрицы травинок (и их буфер на GPU) общие из кэша: ни расчёта, ни заливки
  const makeBlades = (lod, material) => {
    const mesh = new THREE.InstancedMesh(lod.geometry, material, 0);
    mesh.instanceMatrix = lod.instanceMatrix;
    mesh.count = lod.count;
    mesh.frustumCulled = false;
    return mesh;
  };
  for (const lod of lods) grass.add(makeBlades(lod, grassMaterial));

  // Тени травинок на земле. Солнце для теней выше настоящего (иначе тени слишком длинные): справа,
  // SHADOW_ELEVATION над горизонтом. Силуэты всех травинок один раз рисуются в текстуру камерой со
  // стороны солнца (как карта теней, но без глубины: принимает тени только земля), и шейдер земли
  // затемняет себя там, где на неё падает силуэт. Форма тени — настоящая форма травинки.
  const SHADOW_ELEVATION = 22; // градусов
  const SHADOW_SIZE = 2048;
  // запекается один раз (кэш): при подмене сцены земля сразу берёт готовую текстуру теней
  const shadowTarget = (cache.shadowTarget ??= new THREE.WebGLRenderTarget(SHADOW_SIZE, SHADOW_SIZE));
  const shadowScene = new THREE.Scene();
  shadowScene.background = new THREE.Color(1, 1, 1);
  const silhouetteMaterial = new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.DoubleSide });
  if (!cache.shadowBaked) for (const lod of lods) shadowScene.add(makeBlades(lod, silhouetteMaterial));
  const shadowSun = new THREE.Vector3().setFromSphericalCoords(
    1,
    THREE.MathUtils.degToRad(90 - SHADOW_ELEVATION),
    THREE.MathUtils.degToRad(90 + SUN_AZIMUTH),
  );
  // текстура теней покрывает ближние ~45 м поля (где тени видны); дальние редкие травинки без теней
  const grassCenter = new THREE.Vector3(0, 0, -16);
  const shadowCamera = new THREE.OrthographicCamera(-28, 28, 28, -28, 1, 300);
  shadowCamera.position.copy(grassCenter).addScaledVector(shadowSun, 120);
  shadowCamera.lookAt(grassCenter);
  shadowCamera.updateMatrixWorld(true);
  const shadowMatrix = new THREE.Matrix4().multiplyMatrices(shadowCamera.projectionMatrix, shadowCamera.matrixWorldInverse);
  let shadowBaked = false;
  const useGrassShadows = () => {
    land.material.uniforms.grassShadow.value = shadowTarget.texture;
    land.material.uniforms.shadowMatrix.value.copy(shadowMatrix);
    land.material.uniforms.shadowOn.value = 1;
    shadowBaked = true;
  };
  if (cache.shadowBaked) useGrassShadows();
  const bakeGrassShadows = () => {
    const xrEnabled = renderer.xr.enabled;
    const previous = renderer.getRenderTarget();
    renderer.xr.enabled = false; // в текстуру, а не в шлем
    renderer.setRenderTarget(shadowTarget);
    renderer.render(shadowScene, shadowCamera);
    renderer.setRenderTarget(previous);
    renderer.xr.enabled = xrEnabled;
    useGrassShadows();
    cache.shadowBaked = true;
    shadowScene.clear(); // силуэты больше не нужны (их матрицы общие с травой — не освобождать)
  };

  const cameraPosition = new THREE.Vector3();
  return {
    update(dt) {
      // небо следует за головой: до него не дойти
      camera.getWorldPosition(cameraPosition);
      skyGroup.position.copy(cameraPosition);
      // облака: нижний слой плывёт быстрее верхнего (параллакс); искажение и мелкий шум краёв медленно
      // смещаются сами по себе — клубы понемногу перетекают, а не едут единым листом
      const wx = Math.cos(windAngle) * WIND * dt;
      const wz = Math.sin(windAngle) * WIND * dt;
      const wrap = (v) => ((v % 1) + 1) % 1;
      cloudShift[0] = wrap(cloudShift[0] - wx * MAP);
      cloudShift[1] = wrap(cloudShift[1] - wz * MAP);
      cloudShift[2] = wrap(cloudShift[2] - wx * HIGH_SPEED * MAP * HIGH_SCALE);
      cloudShift[3] = wrap(cloudShift[3] + wz * HIGH_SPEED * MAP * HIGH_SCALE);
      warpShift[0] = wrap(warpShift[0] + 0.0021 * dt);
      warpShift[1] = wrap(warpShift[1] - 0.0013 * dt);
      warpShift[2] = wrap(warpShift[2] - wx * 0.45 + 0.004 * dt);
      warpShift[3] = wrap(warpShift[3] - wz * 0.45 + 0.003 * dt);
      skyUniforms.cloudShift.value.fromArray(cloudShift);
      skyUniforms.warpShift.value.fromArray(warpShift);
      skyTime.value = (skyTime.value + dt) % 10000;
      // размер звёзд в пикселях: половина высоты кадра (в шлеме — кадра одного глаза)
      const eye = renderer.xr.isPresenting ? renderer.xr.getCamera().cameras[0] : null;
      skyUniforms.starPx.value = (eye ? eye.viewport.w : renderer.domElement.height) / 2;
      grassTime.value += dt;
      if (!shadowBaked) bakeGrassShadows(); // один раз, в первом кадре
    },
    dispose() {
      // каждый шаг отдельно: упавший шаг не должен прерывать уборку остальной сцены
      const steps = [
        () => { if (grid) grid.visible = gridWasVisible ?? true; },
        () => { camera.far = oldFar; camera.updateProjectionMatrix(); },
        () => { renderer.toneMapping = oldToneMapping; renderer.toneMappingExposure = oldExposure; },
        // shadowTarget, noiseTexture, cloudTexture, земля и трава — в кэше (shared.worldCache), не освобождать
        () => silhouetteMaterial.dispose(),
        () => { sky.geometry.dispose(); skyMaterial.dispose(); },
        () => { stars.geometry.dispose(); stars.material.dispose(); },
      ];
      for (const step of steps) {
        try {
          step();
        } catch (error) {
          console.warn('[world] dispose:', error);
        }
      }
    },
  };
}
