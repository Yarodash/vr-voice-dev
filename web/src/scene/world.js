// Мир вокруг: слегка волнистая земля с травой до горизонта, небо и облака. Вид по умолчанию — закат
// справа от игрока (вправо по оси мира +X), слева небо темнее, со звёздами. Живёт в сцене: правки
// подхватываются на лету.
//
// Время суток, погода, сезон и стиль неба — из состояния атмосферы (`shared.atmosphere.now`,
// scene/atmosphere.js; контракт — docs/agents/atmosphere.md). Здесь оно только читается: каждый кадр
// sky-palettes.js считает на процессоре готовые цвета и числа (палитра стиля по высоте солнца, пелена,
// туман, сезон, ветер), а шейдеры получают их uniform-ами — при смене погоды ни одна программа не
// пересобирается. Пока модуля атмосферы нет — запасное состояние (`shared.atmoFallback`, прежний закат).
//
// Небо — свой шейдер на сфере вокруг головы: градиент (горизонт → полоса → зенит, сторона солнца и
// обратная), солнце и луна (с фазой) с ореолами, слой облаков из карты (плывут по ветру, меняют форму;
// cloudCover — от чистого неба до сплошной пелены), Млечный Путь, туманность и сияние (космическое
// небо), радуга, пелена тумана. Один вызов отрисовки; рисуется после непрозрачного, поэтому считается
// только там, где неба не закрывает земля. Звёзды — точки со своим шейдером (мерцают, прячутся за
// облаками, днём скрыты). Земля — свой шейдер: поле травы из шума и штрихов, сезон (цветы, листва),
// намокание, лужи, снег, туман по дальности.
// Тени псов и коптеров (sun-shadows.js): два каскада карт силуэтов. dogShadeUv(uv) — 1 освещено,
// 0 тень; uv.xy — ближний каскад, uv.zw — дальний (считаются в вершинном шейдере: проекция
// ортогональная, по треугольнику линейна). Край ближнего каскада плавно переходит в дальний, край
// дальнего — в «без теней».
const DOG_SHADE_GLSL = `
  uniform float dogShadowOn;
  uniform float dogShadowStrength;
  uniform sampler2D dogShadowNear;
  uniform sampler2D dogShadowFar;
  uniform vec4 dogShadowNearA;
  uniform vec4 dogShadowFarA;
  float dogEdge(vec2 uv) { vec2 e = min(uv, 1.0 - uv); return min(e.x, e.y); }
  // uv каскада → атлас (sun-shadows.js); чуть внутрь от края — соседний каскад не подмешивается
  vec2 dogAtlas(vec2 uv, vec4 a) { return clamp(uv, 0.002, 0.998) * a.xy + a.zw; }
  float dogShadeUv(vec4 uv) {
    if (dogShadowOn < 0.5) return 1.0;
    // внутри ближнего каскада — одна выборка; дальний — только на стыке и за ближним
    float ea = dogEdge(uv.xy);
    float near = 1.0;
    if (ea > 0.0) {
      near = texture2D(dogShadowNear, dogAtlas(uv.xy, dogShadowNearA)).r;
      if (ea >= 0.06) return near;
    }
    float eb = dogEdge(uv.zw);
    float far = eb > 0.0 ? mix(1.0, texture2D(dogShadowFar, dogAtlas(uv.zw, dogShadowFarA)).r, smoothstep(0.0, 0.08, eb)) : 1.0;
    return ea > 0.0 ? mix(far, near, ea / 0.06) : far;
  }`;
// трава: только ближний каскад — дальше травинки сливаются с землёй, её тень видна и так; так вдвое
// дешевле (у травы ~200k вершин на глаз и много перекрытий)
const DOG_NEAR_GLSL = `
  uniform float dogShadowOn;
  uniform float dogShadowStrength;
  uniform sampler2D dogShadowNear;
  uniform vec4 dogShadowNearA;
  float dogShadeNear(vec2 uv) {
    if (dogShadowOn < 0.5) return 1.0;
    vec2 e2 = min(uv, 1.0 - uv);
    float e = min(e2.x, e2.y);
    if (e <= 0.0) return 1.0;
    return mix(1.0, texture2D(dogShadowNear, clamp(uv, 0.002, 0.998) * dogShadowNearA.xy + dogShadowNearA.zw).r, smoothstep(0.0, 0.06, e));
  }`;
const DOG_NEAR_UV_GLSL = `
  uniform mat4 dogShadowNearM;
  varying vec2 vDogUv;
  void dogShadowUv(vec3 w) { vDogUv = (dogShadowNearM * vec4(w, 1.0)).xy * 0.5 + 0.5; }`;
const DOG_UV_GLSL = `
  uniform mat4 dogShadowNearM;
  uniform mat4 dogShadowFarM;
  varying vec4 vDogUv;
  void dogShadowUv(vec3 w) {
    vDogUv = vec4((dogShadowNearM * vec4(w, 1.0)).xy, (dogShadowFarM * vec4(w, 1.0)).xy) * 0.5 + 0.5;
  }`;

import { createSkyLook, makeDefaultNow } from './sky-palettes.js';

export function createWorld({ THREE, scene, root, camera, renderer, sunShadow = null }) {
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
        for (const item of [this.noiseTexture, this.bladeTexture, this.cloudTexture, this.shadowTarget, this.ground, this.starGeometry]) item?.dispose();
        for (const lod of this.lods ?? []) lod.geometry.dispose();
      },
    };
  }
  const cache = shared.worldCache;
  // uniforms теней псов (sun-shadows.js); без них — выключены
  const dogU = sunShadow ?? {
    dogShadowOn: { value: 0 },
    dogShadowStrength: { value: 0 },
    dogShadowNear: { value: null },
    dogShadowFar: { value: null },
    dogShadowNearM: { value: new THREE.Matrix4() },
    dogShadowFarM: { value: new THREE.Matrix4() },
    dogShadowNearA: { value: new THREE.Vector4(1, 1, 0, 0) },
    dogShadowFarA: { value: new THREE.Vector4(1, 1, 0, 0) },
  };

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

  // Облик неба и света: sky-palettes.js считает его каждый кадр по состоянию атмосферы; uniform-ы
  // шейдеров держат те же объекты (Color / Vector*), так что обновлять их отдельно не нужно.
  const skyLook = createSkyLook(THREE);
  const look = skyLook.look;
  // Проверка из vr:eval без модуля атмосферы и не трогая его: `__sceneState.atmoOverride =
  // __sceneState.worldDebug.makeNow()` — своё состояние только для неба, земли и травы (у него есть
  // sun(высота°, азимут°)); `atmoOverride = null` — вернуть настоящее.
  shared.worldDebug = { makeNow: () => makeDefaultNow(THREE) };
  const atmoNow = () => shared.atmoOverride ?? shared.atmosphere?.now ?? (shared.atmoFallback ??= makeDefaultNow(THREE));
  skyLook.update(atmoNow(), 0);
  shared.skyLook = skyLook.pub; // соседям: свет на земле, цвета горизонта, светило (atmosphere.md)
  const u = (value) => ({ value });
  // прежнее солнце (закат справа, 2,2° над горизонтом): по нему когда-то расставлены звёзды
  const SUNSET_AZIMUTH = -8; // градусов: 0 — ровно справа (+X)
  const sunsetFlat = new THREE.Vector2(Math.sin(THREE.MathUtils.degToRad(90 + SUNSET_AZIMUTH)), Math.cos(THREE.MathUtils.degToRad(90 + SUNSET_AZIMUTH)));

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

  // ---------- «травинки сверху» для шейдера земли: повторяющаяся текстура 256² из тысяч коротких
  // штрихов (травинка, видимая сверху/наискось: у основания тёмная и широкая, к кончику светлая и
  // узкая) на тёмном фоне-просвете. R — яркость штриха (0 — просвет), G — желтизна кончика.
  // Строится один раз (кэш); мип-уровни вдали сводят её в ровный «ворс» без мерцания.
  const BLADE_TEX = 256;
  const bladeData = (cache.bladeData ??= (() => {
    const data = new Uint8Array(BLADE_TEX * BLADE_TEX * 4);
    let s = 91;
    const rnd = () => {
      s = (s * 1664525 + 1013904223) % 4294967296;
      return s / 4294967296;
    };
    const wrap = (n) => ((n % BLADE_TEX) + BLADE_TEX) % BLADE_TEX;
    for (let n = 0; n < 2600; n += 1) {
      const x0 = rnd() * BLADE_TEX;
      const y0 = rnd() * BLADE_TEX;
      const a = rnd() * Math.PI * 2;
      const len = 10 + rnd() * 30;
      const bright = 0.5 + rnd() * 0.5;
      const dry = rnd() < 0.12 ? 0.6 + rnd() * 0.4 : rnd() * 0.25;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      for (let t = 0; t <= len; t += 0.6) {
        const k = t / len;
        const x = x0 + ca * t;
        const y = y0 + sa * t;
        const half = 1.3 * (1 - k) + 0.35; // сужается к кончику
        const value = bright * (0.3 + 0.7 * k); // кончик светлее
        for (let dy = -2; dy <= 2; dy += 1) {
          for (let dx = -2; dx <= 2; dx += 1) {
            const px = Math.floor(x) + dx;
            const py = Math.floor(y) + dy;
            const d = Math.hypot(px + 0.5 - x, py + 0.5 - y);
            const cover = Math.min(1, Math.max(0, half + 0.5 - d));
            if (cover <= 0) continue;
            const i = (wrap(py) * BLADE_TEX + wrap(px)) * 4;
            const v = Math.round(value * cover * 255);
            if (v > data[i]) {
              data[i] = v;
              data[i + 1] = Math.round(dry * 255);
            }
          }
        }
      }
    }
    // B — редкие круглые точки (весной цветы, на снегу искры), A — вытянутые пятнышки (опавшие листья).
    // Те же выборки, что у штрихов: сезонные детали не стоят шейдеру земли ни одной новой выборки.
    const blot = (channel, x0, y0, rx, ry, angle, value) => {
      const ca = Math.cos(angle);
      const sa = Math.sin(angle);
      const reach = Math.ceil(Math.max(rx, ry)) + 1;
      for (let dy = -reach; dy <= reach; dy += 1) {
        for (let dx = -reach; dx <= reach; dx += 1) {
          const px = Math.floor(x0) + dx;
          const py = Math.floor(y0) + dy;
          const ox = px + 0.5 - x0;
          const oy = py + 0.5 - y0;
          const d = Math.hypot((ox * ca + oy * sa) / rx, (oy * ca - ox * sa) / ry);
          const cover = Math.min(1, Math.max(0, (1 - d) * Math.min(rx, ry) + 0.5));
          if (cover <= 0) continue;
          const i = (wrap(py) * BLADE_TEX + wrap(px)) * 4 + channel;
          data[i] = Math.max(data[i], Math.round(value * cover * 255));
        }
      }
    };
    for (let n = 0; n < 300; n += 1) {
      const r = 0.9 + rnd() * 1.5;
      blot(2, rnd() * BLADE_TEX, rnd() * BLADE_TEX, r, r, 0, 0.6 + rnd() * 0.4);
    }
    for (let n = 0; n < 700; n += 1) {
      const len = 2.2 + rnd() * 3.2;
      blot(3, rnd() * BLADE_TEX, rnd() * BLADE_TEX, len, len * (0.4 + rnd() * 0.25), rnd() * Math.PI, 0.55 + rnd() * 0.45);
    }
    return data;
  })());
  const bladeTexture = (cache.bladeTexture ??= new THREE.DataTexture(bladeData, BLADE_TEX, BLADE_TEX, THREE.RGBAFormat, THREE.UnsignedByteType));
  if (bladeTexture.version === 0) {
    bladeTexture.wrapS = bladeTexture.wrapT = THREE.RepeatWrapping;
    bladeTexture.magFilter = THREE.LinearFilter;
    bladeTexture.minFilter = THREE.LinearMipmapLinearFilter;
    bladeTexture.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy()); // штрихи вскользь не размываются в кашу
    bladeTexture.generateMipmaps = true;
    bladeTexture.needsUpdate = true;
  }

  // ---------- небо: шейдер на сфере, которая следует за головой
  // Цвета линейные и уже готовые для экрана (тональной компрессии нет, только мягкий потолок яркости
  // у солнца). Дымка земли у горизонта берёт те же цвета, что горизонт неба, — шва нет.
  // Палитра (look.*): горизонт / полоса / зенит со стороны солнца («Sun») и напротив («Far»), свечения
  // вокруг солнца, цвета облаков — всё приходит готовым из sky-palettes.js.
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

  // скорость и направление облаков — по ветру из состояния (look.cloudWind); при wind = 0.3 нижний слой
  // идёт 0,02 высоты слоя в секунду: спокойно, заметно за 20–30 с
  const HIGH_SCALE = 1.45; // верхний слой мельче
  const HIGH_SPEED = 0.6; // и плывёт медленнее (параллакс)
  // сдвиги облаков переживают подмену сцены: небо не «прыгает» при каждой правке
  const cloudShift = (cache.cloudShift ??= [0, 0, 0.37, 0.61]); // нижний слой xy, верхний zw
  const warpShift = (cache.warpShift ??= [0, 0, 0, 0]); // искажение xy, мелкий шум краёв zw
  const skyTime = { value: 0 };
  const skyUniforms = {
    noiseTex: u(noiseTexture),
    cloudTex: u(cloudTexture),
    sunDir: u(look.sunDir),
    sunFlat: u(look.sunFlat),
    hazeWarm: u(look.horizonSun),
    hazeCool: u(look.horizonFar),
    bandWarm: u(look.bandSun),
    bandCool: u(look.bandFar),
    zenithWarm: u(look.zenithSun),
    zenithCool: u(look.zenithFar),
    glowWide: u(look.glowWide),
    glowHalo: u(look.glowHalo),
    glowHorizon: u(look.glowHorizon),
    sunDisc: u(look.sunDisc),
    sunBloom: u(look.sunBloom),
    cloudLitFar: u(look.cloudLitFar),
    cloudLitMid: u(look.cloudLitMid),
    cloudLitSun: u(look.cloudLitSun),
    cloudShadeFar: u(look.cloudShadeFar),
    cloudShadeSun: u(look.cloudShadeSun),
    cloudRim: u(look.cloudRim),
    cloudSun: u(look.cloudSun),
    cloudP: u(look.cloudP),
    nightP: u(look.nightP),
    mwColor: u(look.mwColor),
    moonDir: u(look.moonDir),
    moonColor: u(look.moonColor),
    moonGlow: u(look.moonGlow),
    veilColor: u(look.veilColor),
    veilP: u(look.veilP),
    flashP: u(look.flashP),
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
    uniform vec4 cloudP; // x — сдвиг толщины (облачность), y — доля шума-заполнения, z — насколько облако гасит солнце, w — насколько толща пелены темнее
    uniform vec4 nightP; // x — звёзды, y — «только на тёмной стороне», z — Млечный Путь, w — туманность
    uniform vec4 veilP; // x — пелена тумана у горизонта, y — её спад с высотой, z — радуга, w — сияние
    // точка слоя облаков, куда смотрит луч (в высотах слоя)
    vec2 cloudPlane(vec3 dir) { return dir.xz / (max(dir.y, 0.0) + 0.03); }
    // два слоя облаков: lo — нижний, hi — верхний (мельче, медленнее). r — толщина, gb — наклон, a — где облако.
    // Облачность: толщина карты сдвигается (cloudP.x: меньше — облака тают, больше — срастаются), а между
    // облаками карты пелену дорисовывает тот же шум, что их искажает (cloudP.y) — без новых выборок.
    void cloudLayers(vec2 p, out vec4 lo, out vec4 hi) {
      vec4 w = texture2D(noiseTex, p * 0.045 + warpShift.xy) - 0.5; // медленное искажение: клубы перетекают
      lo = texture2D(cloudTex, p * ${MAP.toFixed(5)} + cloudShift.xy + w.rg * 0.04);
      hi = texture2D(cloudTex, vec2(p.x, -p.y) * ${(MAP * HIGH_SCALE).toFixed(5)} + cloudShift.zw + w.ba * 0.04);
      lo.r = max(lo.r + cloudP.x + w.b * cloudP.y, 0.0);
      hi.r = max(hi.r + cloudP.x + w.r * cloudP.y, 0.0);
    }
    // 1 — сторона солнца, 0 — противоположная; в зените 0.5 (без нормировки: в зените нет излома)
    float sunSide(vec3 dir) { return dot(dir.xz, sunFlat) * 0.5 + 0.5; }
    // сколько неба в этом направлении съел туман (в ясную погоду — ничего, и считать нечего)
    float veilAt(float e) { return veilP.x > 0.001 ? veilP.x * exp(-e * veilP.y) : 0.0; }
  `;
  const skyGroup = new THREE.Group();
  skyGroup.name = 'scene-sky';
  root.add(skyGroup);
  const skyMaterial = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    toneMapped: false,
    // дизеринг three.js (#define DITHERING): ±0,5 младшего разряда по шуму от gl_FragCoord, без выборок —
    // тёмное ночное небо и ореол луны не идут ступенями-кольцами (8 бит на канал)
    dithering: true,
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
      uniform vec3 bandWarm;
      uniform vec3 bandCool;
      uniform vec3 zenithWarm;
      uniform vec3 zenithCool;
      uniform vec3 glowWide;
      uniform vec3 glowHalo;
      uniform vec3 glowHorizon;
      uniform vec3 sunDisc;
      uniform vec3 sunBloom;
      uniform vec3 cloudLitFar;
      uniform vec3 cloudLitMid;
      uniform vec3 cloudLitSun;
      uniform vec3 cloudShadeFar;
      uniform vec3 cloudShadeSun;
      uniform vec3 cloudRim;
      uniform vec3 cloudSun; // откуда освещены облака
      uniform vec3 mwColor;
      uniform vec3 moonDir;
      uniform vec3 moonColor;
      uniform vec3 moonGlow;
      uniform vec3 veilColor;
      uniform vec4 flashP; // xyz — где в небе вспышка молнии, w — её яркость
      uniform float time;
      varying vec3 vDir;
      #include <common>
      #include <dithering_pars_fragment>
      ${CLOUD_GLSL}
      // мягкий потолок: до 0.8 цвет как есть, выше плавно упирается в 1 (солнце белеет, а не режется)
      vec3 shoulder(vec3 c) { return min(c, 0.8) + 0.2 * (1.0 - exp(-max(c - 0.8, 0.0) * 5.0)); }
      // Облако освещается как груда шаров: нормаль клуба из карты, свет от низкого солнца сбоку и
      // немного сверху (от высокого — сверху). Сторона к солнцу светлая, обратная — в тени; бок,
      // обращённый к нам и вниз (плоское дно облака), темнее; толща облака в тени темнее; тонкие
      // края у солнца светятся. Цвета — из палитры; flash — вспышка молнии изнутри облака.
      vec3 shadeCloud(vec4 c, float s, float near, vec2 out2, float e, vec3 horizon, float hazeFar, float bright, float flash) {
        vec3 N = vec3(c.g * 2.0 - 1.0, 0.0, c.b * 2.0 - 1.0);
        N.y = sqrt(max(0.0, 1.0 - dot(N.xz, N.xz)));
        float diff = clamp(dot(N, cloudSun) * 0.6 + 0.42, 0.0, 1.0);
        float base = clamp(dot(N.xz, -out2), 0.0, 1.0) * (1.0 - e * 0.7);
        diff *= 1.0 - 0.5 * base;
        diff *= 1.0 - 0.35 * c.r * (1.0 - diff);
        vec3 litColor = mix(mix(cloudLitFar, cloudLitMid, smoothstep(0.2, 0.6, s)), cloudLitSun, smoothstep(0.6, 0.97, s));
        vec3 shadowColor = mix(cloudShadeFar, cloudShadeSun, s * s);
        vec3 cloud = mix(shadowColor, litColor * bright, diff * diff * (3.0 - 2.0 * diff));
        cloud *= 1.0 - cloudP.w * smoothstep(0.55, 1.25, c.r); // пелена: где толще, там темнее (сплошное небо не ровное)
        cloud += cloudRim * (exp(near * 9.0) * (1.0 - smoothstep(0.0, 0.35, c.r)));
        cloud += vec3(0.72, 0.78, 1.0) * (flash * (0.3 + 0.7 * min(c.r, 1.0)));
        return mix(cloud, horizon, hazeFar * 0.75);
      }
      void main() {
        vec3 dir = normalize(vDir);
        float e = max(dir.y, 0.0);
        float s = sunSide(dir);
        float near = dot(dir, sunDir) - 1.0; // 0 у солнца, -2 напротив
        // градиент: горизонт (как дымка земли) → полоса над ним → зенит
        vec3 horizon = mix(hazeCool, hazeWarm, s * s * s);
        vec3 band = mix(bandCool, bandWarm, s * s);
        vec3 zenith = mix(zenithCool, zenithWarm, s * s);
        vec3 col = mix(horizon, band, 1.0 - exp(-e * 11.0));
        col = mix(col, zenith, smoothstep(0.04, mix(0.45, 0.85, s), e));
        // свечение вокруг солнца: широкое тёплое у горизонта и ореол
        col += glowWide * (exp(near * 3.5) * exp(-e * 4.0));
        col += glowHalo * exp(near * 45.0);
        col += glowHorizon * (exp(-e * 30.0) * exp(near * 8.0)); // дымка у горизонта под солнцем
        // Млечный Путь: слабая полоса через тёмную сторону неба (ночью — через всё небо); днём не считается
        if (nightP.z > 0.001) {
          vec3 mwAxis = vec3(0.30, 0.42, 0.86);
          float mwDist = dot(dir, mwAxis);
          // зерно полосы — шум в стереографической развёртке купола: она без вырожденных направлений,
          // пятна круглые по всему небу (прежняя линейная развёртка тянула их в штрихи-«занавески»)
          float mwNoise = texture2D(noiseTex, dir.xz * (2.6 / (1.0 + e)) + 0.37).g;
          float mw = exp(-mwDist * mwDist * 28.0) * (0.5 + mwNoise * 0.7) * mix(1.0, 1.0 - smoothstep(0.25, 0.6, s), nightP.y) * smoothstep(0.08, 0.45, e);
          col += mwColor * (mw * nightP.z);
        }
        // туманность (космическое небо): крупные фиолетовые и бирюзовые облака света
        if (nightP.w > 0.001) {
          // стереографическая развёртка купола: пятна шума круглые и у зенита, и у горизонта
          vec2 sp = dir.xz / (1.0 + e);
          vec4 nb = texture2D(noiseTex, sp * 0.17 + 0.61);
          vec4 nd = texture2D(noiseTex, sp * 0.8 + 0.13);
          float lift = smoothstep(0.0, 0.3, e);
          float violet = smoothstep(0.5, 0.85, nb.r + nd.g * 0.3);
          float teal = smoothstep(0.52, 0.86, nb.b + nd.a * 0.3);
          float core = smoothstep(0.62, 0.95, nb.g + nd.r * 0.3);
          col += (vec3(0.16, 0.025, 0.3) * violet + vec3(0.0, 0.13, 0.15) * teal + vec3(0.4, 0.14, 0.3) * core * violet) * (nightP.w * lift * (0.5 + 0.8 * nd.b));
        }
        // сияние (космическая ночь): занавеси над дальним горизонтом (−Z), колышутся
        if (veilP.w > 0.001) {
          float az = dir.x / (abs(dir.z) + 0.4);
          float wave = texture2D(noiseTex, vec2(az * 0.3 + time * 0.003, time * 0.005)).r;
          float rays = texture2D(noiseTex, vec2(az * 2.3 - time * 0.006, wave * 0.4 + 0.3)).g;
          float foot = 0.1 + 0.3 * wave; // нижний край занавеси
          float curtain = smoothstep(foot - 0.02, foot + 0.03, e) * exp(-(e - foot) * 6.5);
          vec3 tint = mix(vec3(0.1, 1.0, 0.55), vec3(0.5, 0.25, 1.0), smoothstep(0.0, 0.35, e - foot));
          col += tint * (curtain * (0.25 + 1.1 * rays * rays) * veilP.w * smoothstep(-0.25, 0.5, -dir.z) * 0.4);
        }

        float alpha = 0.0;
        if (cloudP.x > -1.0) {
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
          // вспышка молнии: ярче всего там, где ударило, слабее по всему небу
          float flash = flashP.w > 0.0 ? flashP.w * (0.3 + 0.7 * exp((dot(dir, flashP.xyz) - 1.0) * 5.0)) : 0.0;
          col = mix(col, shadeCloud(hi, s, near, out2, e, horizon, hazeFar, 0.8, flash), aHi);
          col = mix(col, shadeCloud(lo, s, near, out2, e, horizon, hazeFar, 1.0, flash), aLo);
          alpha = max(aLo, aHi);
        }

        // солнце: диск с потемнением к краю и ореол-«блум»; за облаком гаснет
        float angle = sqrt(max(-2.0 * near, 0.0));
        float disc = 1.0 - smoothstep(0.0085, 0.0105, angle);
        float limb = 1.0 - 0.35 * (angle / 0.0105) * (angle / 0.0105);
        vec3 sunLight = sunDisc * (disc * limb) + sunBloom * exp(near * 1500.0);
        // луна: диск-шар, освещённый настоящим солнцем (фаза получается сама), ореол; за облаком гаснет
        float mNear = dot(dir, moonDir) - 1.0;
        if (moonGlow.g > 0.0005) sunLight += moonGlow * (exp(mNear * 30.0) * 0.35 + exp(mNear * 400.0)); // ореол — только ночью
        if (mNear > -0.00045) {
          vec3 mr = normalize(cross(vec3(0.0, 1.0, 0.0), moonDir));
          vec3 mu = cross(moonDir, mr);
          vec2 q = vec2(dot(dir, mr), dot(dir, mu)) / 0.028;
          float r2 = dot(q, q);
          if (r2 < 1.0) {
            float z = sqrt(1.0 - r2);
            vec3 n = mr * q.x + mu * q.y - moonDir * z;
            float lit = smoothstep(-0.1, 0.15, dot(n, sunDir));
            float seas = 0.86 + 0.14 * sin(q.x * 4.3 + 1.0) * sin(q.y * 3.7 + q.x * 2.1);
            sunLight += moonColor * ((1.0 - smoothstep(0.86, 1.0, r2)) * (0.035 + 0.965 * lit) * seas * (0.72 + 0.28 * z));
          }
        }
        col += sunLight * (1.0 - alpha * cloudP.z);
        // радуга: дуга в 42° от точки напротив солнца, красный снаружи
        if (veilP.z > 0.001) {
          float t = (-dot(dir, sunDir) - 0.7071) / 0.0758; // 45° … 38,5°
          if (t > 0.0 && t < 1.0) {
            vec3 hue = clamp(abs(mod(t * 4.4 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
            float bow = sin(t * 3.1416);
            col += hue * (bow * bow * veilP.z * 0.3 * smoothstep(-0.01, 0.1, dir.y) * (1.0 - alpha * 0.5)) * (1.0 - col * 0.6);
          }
        }
        // туман и пелена осадков: у горизонта небо уходит в цвет тумана, в густом — всё небо
        col = mix(col, veilColor, veilAt(e));
        gl_FragColor = vec4(shoulder(col), 1.0);
        #include <colorspace_fragment>
        #include <dithering_fragment>
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
    const side = (x * sunsetFlat.x + z * sunsetFlat.y) / Math.max(r, 1e-3) * 0.5 + 0.5;
    const darkness = (1 - smooth(0.3, 0.75, side)) * 0.7 + smooth(0.1, 0.8, y) * 0.5;
    if (starRandom() > darkness) continue;
    starPositions.push(x * 3800, y * 3800, z * 3800);
    const magnitude = starRandom() ** 3.2; // мало ярких, много слабых
    starData.push(THREE.MathUtils.degToRad(0.07 + magnitude * 0.2), 0.25 + magnitude * 1.6, starRandom());
    const t = starRandom();
    starTint.push(...(t < 0.2 ? [1, 0.82, 0.62] : t < 0.45 ? [0.75, 0.85, 1] : [0.95, 0.96, 1]));
  }
  // Ночные звёзды: добавка на той стороне, где на закате светло (выше — прежние звёзды, они не тронуты).
  // Отмечены фазой +2: видны только когда звёзды горят по всему небу (nightP.y < 1), на закате их нет.
  starSeed = 97531;
  for (let i = 0; i < 3000 && starData.length < 2200 * 3; i += 1) {
    const y = 0.03 + starRandom() * 0.97;
    const angle = starRandom() * Math.PI * 2;
    const r = Math.sqrt(1 - y * y);
    const x = Math.cos(angle) * r;
    const z = Math.sin(angle) * r;
    const side = (x * sunsetFlat.x + z * sunsetFlat.y) / Math.max(r, 1e-3) * 0.5 + 0.5;
    const darkness = (1 - smooth(0.3, 0.75, side)) * 0.7 + smooth(0.1, 0.8, y) * 0.5;
    if (starRandom() < darkness * 0.75) continue;
    starPositions.push(x * 3800, y * 3800, z * 3800);
    const magnitude = starRandom() ** 3.2;
    starData.push(THREE.MathUtils.degToRad(0.07 + magnitude * 0.2), 0.25 + magnitude * 1.6, 2 + starRandom());
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
          float extra = step(1.5, aStar.z); // ночная добавка (см. выше)
          float seed = aStar.z - 2.0 * extra;
          // видны там, где небо тёмное: на закате — напротив солнца и выше (у горизонта и к закату
          // гаснут), ночью — по всему небу (nightP.y: 1 — только тёмная сторона, 0 — везде)
          float sky = (1.0 - smoothstep(0.35, 0.78, s)) * smoothstep(0.02, 0.2, dir.y);
          sky = max(sky, smoothstep(0.35, 0.95, dir.y) * (1.0 - smoothstep(0.7, 0.95, s)) * 0.6);
          sky = mix(smoothstep(0.02, 0.2, dir.y), sky * (1.0 - extra), nightP.y) * nightP.x * (1.0 - veilAt(max(dir.y, 0.0)));
          vec4 lo;
          vec4 hi;
          cloudLayers(cloudPlane(dir), lo, hi);
          float clear = 1.0 - smoothstep(0.1, 0.35, max(lo.r, hi.r));
          float phase = seed * 60.0;
          float twinkle = 1.0 + (0.12 + 0.3 * (1.0 - dir.y)) * sin(time * (1.7 + seed * 2.5) + phase) * sin(time * 0.73 + phase * 1.3);
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
          float freq = 1.26 + fract(seed * 7.31) * 2.5;
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

  // Трава везде, во все стороны до горизонта (пользователь: «всё, что я вижу, — трава»). Три кольца
  // вокруг центра игровой зоны (там игрок и вышка):
  //  - до LOD_DISTANCE — настоящие травинки с изгибом (LOD0);
  //  - до CLUMP_FROM — травинки-треугольники (LOD1), дальше до GRASS_RING — кустики-«короны» (LOD2,
  //    4 травинки одним экземпляром); всё реже и крупнее с расстоянием; к краю кольца их цвет
  //    сходится с цветом поля под ними, так что края кольца не видно. Всего 3 вызова отрисовки;
  //    ветер только в вершинном шейдере, на процессоре каждый кадр — ничего;
  //  - дальше — шейдер земли рисует «поле травы издали»: средний цвет густой травы (тот же свет, что у
  //    травинок), пятна оттенков, сухие проплешины, бегущие волны ветра и просвет против солнца.
  // Земля между редкими дальними травинками — то же поле, вблизи под густой травой — тёмная глубина.
  const GRASS_RING = 60; // м: дальше травинок нет, только поле в шейдере земли
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
  // Свет (небо, солнце или луна, просвечивание), цвета травы по сезону, ветер, туман — uniform-ы из
  // sky-palettes.js (look.*): одни и те же у земли и у травинок.
  const meadowUniforms = {
    noiseTex: u(noiseTexture),
    sunFlat: u(look.sunFlat),
    hazeWarm: u(look.hazeWarmG),
    hazeCool: u(look.hazeCoolG),
    skyLight: u(look.skyLight),
    sunLight: u(look.sunLight),
    glowTint: u(look.glowTint),
    grassSun: u(look.grassSun),
    lightP: u(look.lightP),
    lushA: u(look.lushA),
    lushB: u(look.lushB),
    dryCol: u(look.dryCol),
    depthA: u(look.depthA),
    depthB: u(look.depthB),
    depthGain: u(look.depthGain),
    windDir: u(look.windDir),
    windP: u(look.windP),
    windA: u(look.windA),
    fogP: u(look.fogP),
    wetP: u(look.wetP),
    snowCol: u(look.snowCol),
    seasonP: u(look.seasonP),
    shadeP: u(look.shadeP),
  };
  const MEADOW_GLSL = `
    uniform sampler2D noiseTex;
    vec4 noise4(vec2 p) { return texture2D(noiseTex, p * ${f(1 / NOISE_CELLS)}); }
    uniform float time; // часы мира (world.update получает dt с учётом хода времени)
    uniform vec2 sunFlat; // сторона солнца по горизонту (как у неба)
    uniform vec3 hazeWarm; // горизонт со стороны солнца и напротив — уже с туманом погоды
    uniform vec3 hazeCool;
    uniform vec3 skyLight; // свет неба на траве
    uniform vec3 sunLight; // свет солнца (ночью луны)
    uniform vec3 glowTint; // просвечивание травинок против света
    uniform vec3 grassSun; // к светилу, прижато к горизонту: освещает бока травинок
    uniform vec4 lightP; // x — сила света на склонах, y — его доля на ровном, z — блеск мокрого, w — сила теней травинок
    uniform vec3 lushA; // цвет травы по сезону: сизо-зелёная ↔ жёлто-зелёная, сухая, «глубина» под травой
    uniform vec3 lushB;
    uniform vec3 dryCol;
    uniform vec3 depthA;
    uniform vec3 depthB;
    uniform vec3 depthGain; // свет в глубине травы (1 — как на прежнем закате)
    uniform vec2 windDir; // куда дует ветер (xz)
    uniform vec4 windP; // фазы: волна по полю, её огибающая, трепет травинок медленный и быстрый
    uniform vec4 windA; // размахи: наклон по ветру, трепет, волна, «прижатость» в бурю
    uniform vec4 fogP; // x — плотность дымки у горизонта, y — плотность тумана погоды, z — откуда дымка
    uniform vec4 wetP; // x — мокро, y — лужи, z — дождь (рябь), w — снег на земле
    uniform vec3 snowCol; // снег под нынешним светом
    uniform vec4 seasonP; // x — цветы, y — опавшая листва, z — искры на снегу, w — сухие пятна
    uniform vec4 shadeP; // тени облаков на земле: x — сила, y — порог (чем ниже, тем больше тени), z и w — фазы (плывут по ветру)
    // земля под травой: тёмная, как глубина густой травы (цвет без света)
    vec3 meadowGround(float tint) { return mix(depthA, depthB, smoothstep(0.3, 0.75, tint)); }
    // Волны ветра по полю: широкие извилистые полосы (~40 м) бегут по ветру ~7 м/с, 0..1.
    // Травинки в волне сильнее гнутся и светлеют, поле в шейдере земли светлеет так же — волна
    // непрерывно идёт от ног до горизонта. Только синусы: выборка текстуры в вершинах на Quest дорогая.
    float windWave(vec2 p) {
      vec2 q = vec2(dot(p, windDir), p.y * windDir.x - p.x * windDir.y); // вдоль ветра и поперёк
      float bend = 1.6 * sin(q.y * 0.031 + q.x * 0.012) + 0.8 * sin(q.y * 0.083 - q.x * 0.02 + 1.3);
      float w = sin(q.x * 0.15 + q.y * 0.05 - windP.x + bend);
      return (w * 0.5 + 0.5) * (0.55 + 0.45 * sin(q.x * 0.041 - q.y * 0.067 - windP.y));
    }
    // Тени облаков: большие мягкие пятна (сотни метров) плывут по ветру. Не проекция облаков неба (это
    // стоило бы выборки текстуры в каждом пикселе земли), а те же синусы; 1 — свет, меньше — тень.
    float cloudShade(vec2 p) {
      if (shadeP.x < 0.001) return 1.0;
      vec2 q = vec2(dot(p, windDir), p.y * windDir.x - p.x * windDir.y);
      float a = sin(q.x * 0.0113 + 1.9 * sin(q.y * 0.0061 + 0.5) - shadeP.z);
      float b = sin(q.y * 0.0147 + 1.4 * sin(q.x * 0.0043 + 2.1) + shadeP.w);
      float c = sin((q.x + q.y) * 0.0291 - shadeP.z * 1.7 + 0.8);
      return 1.0 - shadeP.x * smoothstep(shadeP.y, shadeP.y + 0.3, 0.5 + 0.22 * (a + b) + 0.08 * c);
    }
    // насколько волна ветра высветляет траву (при обычном ветре ×0.3, в штиль волн не видно)
    float waveGain() { return 0.3 * min(windA.z * 10.0, 1.5); }
    // цвет травинки: сизо-зелёный ↔ жёлто-зелёный
    vec3 grassLush(float tone) { return mix(lushA, lushB, tone); }
    // Поле густой травы издали: свет травинок, усреднённый по их случайным поворотам (небо сверху,
    // светило сбоку, просвечивание — особенно взглядом против света). viewDir — от глаза.
    vec3 grassField(vec3 lush, vec3 viewDir) {
      vec3 glow = (lush * 1.6 + vec3(0.05, 0.035, 0.0)) * glowTint * 0.8;
      float against = pow(clamp(dot(viewDir, grassSun), 0.0, 1.0), 3.0);
      return lush * skyLight * 0.85 + lush * sunLight * 0.38 + glow * (0.19 + against * 1.6);
    }
    // цвет тумана в сторону dir (по горизонту) и его доля на расстоянии dist
    vec3 hazeColor(vec2 dir) {
      float toward = clamp(dot(dir, sunFlat) * 0.5 + 0.5, 0.0, 1.0);
      return mix(hazeCool, hazeWarm, toward * toward * toward);
    }
    float hazeAmount(float dist) { return 1.0 - exp(-(max(dist - fogP.z, 0.0) * fogP.x + dist * fogP.y)); }
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
  const grassTime = { value: 0 }; // время ветра: у травинок и у поля в шейдере земли общее
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
      dithering: true, // как у неба: ночью и в тумане земля — тёмный плавный градиент
      uniforms: {
        ...meadowUniforms,
        lightDir: u(look.lightDir),
        hillSun: u(look.hillSun),
        hillAdd: u(look.hillAdd),
        skyRefl: u(look.skyRefl),
        glint: u(look.glint),
        grassShadow: { value: null },
        shadowMatrix: { value: new THREE.Matrix4() },
        bladeTex: { value: bladeTexture },
        time: grassTime,
        ...dogU,
      },
      vertexShader: `
        varying vec3 vWorld;
        varying vec3 vNormal;
        ${DOG_UV_GLSL}
        void main() {
          vec4 world = modelMatrix * vec4(position, 1.0);
          vWorld = world.xyz;
          dogShadowUv(world.xyz);
          vNormal = normalize(mat3(modelMatrix) * normal);
          gl_Position = projectionMatrix * viewMatrix * world;
        }`,
      fragmentShader: `
        uniform vec3 lightDir; // к светилу (настоящее направление): блик в лужах
        uniform vec3 hillSun; // к светилу, приподнято: свет на склонах
        uniform vec3 hillAdd;
        uniform vec3 skyRefl; // небо над головой: отражение в лужах и на мокрой траве
        uniform vec3 glint; // блик светила в воде и искры на снегу
        uniform sampler2D grassShadow;
        uniform sampler2D bladeTex;
        uniform mat4 shadowMatrix;
        varying vec3 vWorld;
        varying vec3 vNormal;
        varying vec4 vDogUv;
        #include <common>
        #include <dithering_pars_fragment>
        ${MEADOW_GLSL}
        ${DOG_SHADE_GLSL}
        void main() {
          vec2 p = vWorld.xz;
          float far = length(vWorld.xz - cameraPosition.xz);
          // мелкие детали гаснут с расстоянием: иначе вдали они мерцают от малейшего движения головы
          float midFade = 1.0 - smoothstep(60.0, 260.0, far);
          float fineFade = 1.0 - smoothstep(6.0, 30.0, far);
          float big = noise4(p * 0.012).r;   // большие пятна полей
          // пятна луга: желтоватая и сизая зелень; по ним же окрашены травинки. Остальные каналы той же
          // выборки — «низины» для луж и снега и выбор цвета цветов и листьев.
          vec4 patchN = noise4(p * 0.23 + 5.3);
          float tint = noise4(p * 0.09).b * 0.65 + patchN.a * 0.35;
          float mid = mix(0.5, tint, midFade);    // пятна травы
          vec4 spots = noise4(p * 0.03 + 40.0);    // сухие пятна
          float fine = mix(0.5, noise4(p * 1.7).r, fineFade);  // мелкая рябь у ног
          vec3 viewDir = normalize(vWorld - cameraPosition);
          // Травинки, нарисованные на земле (текстура штрихов): мелкие (плитка 2,5 м — травинки
          // 10–45 см) и крупные, повёрнутые (плитка 11 м — кустики, видны и за сотни метров). Земля
          // везде — густая трава: светлые кончики над тёмными просветами; настоящие травинки сверху.
          // В тех же выборках: b — точки (цветы, искры снега), a — пятнышки (опавшие листья).
          vec4 strokeA = texture2D(bladeTex, p * 0.4);
          vec4 strokeB = texture2D(bladeTex, vec2(p.x * 0.6 - p.y * 0.8, p.x * 0.8 + p.y * 0.6) * 0.09 + 0.37);
          // и самые крупные (плитка 45 м): вдали, где мелкие уже слились в ровный цвет, они дают
          // пёстрый «ворс» кочек до самого горизонта
          vec4 strokeC = texture2D(bladeTex, vec2(p.x * 0.8 + p.y * 0.6, p.y * 0.8 - p.x * 0.6) * 0.022 + 0.71);
          float strokes = max(max(strokeA.r, strokeB.r * 0.9), strokeC.r * 0.85);
          // поле травы: оттенок по пятнам луга и большим пятнам полей, сухая трава пятнами и кончиками
          float tone = clamp(mid * 0.7 + smoothstep(0.35, 0.8, big) * 0.45 - 0.15, 0.0, 1.0);
          vec3 lush = grassLush(tone);
          float patchFade = 1.0 - smoothstep(300.0, 1200.0, far);
          float dry = smoothstep(0.62, 0.85, spots.r) * 0.45 * patchFade + max(strokeA.g, strokeB.g) * 0.35;
          lush = mix(lush, dryCol, min(dry * seasonP.w, 1.0));
          // осень: трава пятнами буреет под опавшей листвой
          float leafPatch = 0.0;
          if (seasonP.y > 0.001) {
            leafPatch = seasonP.y * smoothstep(0.42, 0.7, spots.g * 0.65 + patchN.r * 0.5);
            lush = mix(lush, vec3(0.26, 0.11, 0.022), leafPatch * 0.4);
          }
          vec3 field = grassField(lush, viewDir) * 1.15;
          // бегущие волны ветра: пригнутая трава светлее (вдали гаснут, иначе у горизонта рябь)
          field *= 1.0 + waveGain() * windWave(p) * (1.0 - smoothstep(250.0, 900.0, far));
          // Сколько видно травинок, а сколько тёмной глубины: по штрихам; вскользь (к горизонту)
          // травинки загораживают просветы — «ворс», почти одна трава.
          float graze = 1.0 - clamp(-viewDir.y, 0.0, 1.0);
          graze *= graze;
          float cover = clamp(strokes * 1.3 + graze * 0.35 - 0.05, 0.0, 1.0);
          vec3 depth = meadowGround(tint) * depthGain * (0.85 + fine * 0.3);
          vec3 blades = field * (0.6 + 0.8 * strokes);
          // весна — мелкие цветы точками (белые, жёлтые, розовые — полянами); осень — листья на земле
          if (seasonP.x + seasonP.y > 0.001) {
            vec3 plain = skyLight * 0.9 + sunLight * 0.6; // свет на мелком и лежащем: без формы
            // крупные плитки штрихов — только вдали: вблизи их точки были бы пятнами в полметра
            float midScale = smoothstep(5.0, 16.0, far);
            float farScale = smoothstep(28.0, 80.0, far);
            float dots = max(max(strokeA.b, strokeB.b * 0.9 * midScale), strokeC.b * 0.75 * farScale);
            float bloom = dots * seasonP.x * smoothstep(0.32, 0.6, spots.b * 0.6 + patchN.g * 0.6);
            vec3 petal = mix(vec3(1.0, 0.96, 0.85), vec3(1.0, 0.72, 0.08), step(0.5, patchN.b));
            petal = mix(petal, vec3(0.85, 0.3, 0.62), step(0.62, patchN.r));
            blades = mix(blades, petal * plain, min(bloom * 1.5, 1.0));
            depth = mix(depth, petal * plain, min(bloom * 1.5, 1.0));
            float leaf = max(max(strokeA.a, strokeB.a * 0.9 * midScale), strokeC.a * 0.8 * farScale) * leafPatch;
            vec3 leafCol = mix(vec3(0.55, 0.2, 0.03), vec3(0.62, 0.42, 0.05), patchN.b);
            leafCol = mix(leafCol, vec3(0.36, 0.07, 0.03), step(0.62, patchN.g) * 0.8) * plain;
            depth = mix(depth, leafCol * 0.85, min(leaf * 1.3, 1.0));
            blades = mix(blades, leafCol, min(leaf, 1.0) * 0.5);
          }
          // снег: сначала ложится в просветы между кочками, потом укрывает траву, торчат редкие кончики
          float snowMask = 0.0;
          if (wetP.w > 0.001) {
            snowMask = smoothstep(0.0, 0.3, wetP.w * 1.3 - (0.5 * tint + 0.3 * fine));
            depth = mix(depth, snowCol, snowMask);
            blades = mix(blades, snowCol, snowMask * wetP.w * 0.7);
            cover *= 1.0 - snowMask * (0.35 + 0.6 * wetP.w);
          }
          vec3 col = mix(depth, blades, cover);
          // свет на холмах: склоны к светилу теплее и светлее, от него темнее (ровное место ×1)
          float light = clamp(dot(normalize(vNormal), hillSun), 0.0, 1.0);
          col *= 1.0 + lightP.x * (light - lightP.y);
          col += hillAdd * max(light - lightP.y, 0.0);
          // тени травинок (текстура силуэтов со стороны солнца); две точки с линейной фильтрацией
          // смягчают края. Вне текстуры (дальше ~30 м) выборок нет, в пасмурную погоду — тоже. Тени
          // псов (dogShadeUv) с ними не складываются: берётся более тёмная.
          float shade = 0.0;
          if (lightP.w > 0.01) {
            vec4 lc = shadowMatrix * vec4(vWorld, 1.0);
            vec2 suv = lc.xy * 0.5 + 0.5;
            if (suv.x > 0.0 && suv.x < 1.0 && suv.y > 0.0 && suv.y < 1.0) {
              vec2 texel = vec2(0.75 / 2048.0);
              float lit = texture2D(grassShadow, suv + texel).r + texture2D(grassShadow, suv - texel).r;
              shade = (1.0 - lit * 0.5) * 0.55 * lightP.w;
            }
          }
          shade = max(shade, (1.0 - dogShadeUv(vDogUv)) * dogShadowStrength);
          col *= (1.0 - shade) * cloudShade(p);
          // искры на снегу: вспыхивают и гаснут, когда поворачиваешь голову
          if (seasonP.z > 0.001) {
            float twinkle = fract(dot(viewDir.xz, vec2(37.0, 23.0)) + patchN.g * 5.0 + p.x * 0.61 + p.y * 0.37);
            col += glint * (strokeA.b * snowMask * seasonP.z * step(0.7, twinkle) * 3.0);
          }
          // мокрая трава блестит вскользь отражённым небом
          col += skyRefl * (lightP.z * graze * 0.07);
          // дымка у горизонта: к солнцу тёплая, в другую сторону холодная, чтобы земля сливалась с небом;
          // туман погоды — тем же цветом, но гуще (видимость)
          float distance = length(vWorld.xz - cameraPosition.xz);
          vec2 dir = normalize(vWorld.xz - cameraPosition.xz + vec2(1e-4));
          vec3 haze = hazeColor(dir);
          // лужи: в «низинах» шума на ровном; отражают небо (вскользь — горизонт), блик светила, рябь от капель
          if (wetP.y > 0.001) {
            float level = mix(0.9, 0.57, wetP.y);
            float pool = smoothstep(level, level + 0.035, patchN.r * 0.7 + spots.a * 0.3 + (fine - 0.5) * 0.1);
            pool *= smoothstep(0.9988, 0.9996, normalize(vNormal).y) * (1.0 - snowMask);
            if (pool > 0.0) {
              float down = clamp(-viewDir.y, 0.0, 1.0);
              float fresnel = 0.05 + 0.95 * pow(1.0 - down, 5.0);
              vec3 mirror = mix(haze, skyRefl, smoothstep(0.02, 0.45, down));
              float ring = 0.0;
              if (wetP.z > 0.001 && fineFade > 0.0) {
                // кольцо от капли в каждой клетке ~0,7 м: расходится и гаснет, у каждой своя фаза
                vec2 g = p * 1.4;
                vec2 cell = floor(g);
                float h1 = fract(sin(dot(cell, vec2(12.9898, 78.233))) * 43758.5453);
                float h2 = fract(h1 * 91.7 + 0.37);
                float age = fract(time * (0.9 + h2 * 0.5) + h1);
                float d = length(g - cell - 0.5 - (vec2(h1, h2) - 0.5) * 0.4);
                ring = (1.0 - age) * smoothstep(0.06, 0.0, abs(d - age * 0.42)) * fineFade * wetP.z;
              }
              vec3 water = mix(col * 0.4, mirror, fresnel) + mirror * (ring * 0.6);
              vec3 bounce = reflect(viewDir, normalize(vec3((fine - 0.5) * 0.06, 1.0, (patchN.g - 0.5) * 0.04)));
              water += glint * (pow(max(dot(bounce, lightDir), 0.0), 220.0) * 6.0);
              col = mix(col, water, pool * (1.0 - 0.55 * strokes));
            }
          }
          gl_FragColor = vec4(mix(col, haze, hazeAmount(distance)), 1.0);
          #include <colorspace_fragment>
          #include <dithering_fragment>
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
  // Бюджет в травинках на круг до GRASS_RING (было 36 000 на конус впереди): ≈ 8k ближних (6 вершин),
  // ≈ 22k треугольников (3), ≈ 7k корон по 6 травинок (12) — ≈ 200k вершин на глаз (было 141k).
  const GRASS_COUNT = 72000;
  // Ближние травинки — полоска из двух звеньев (изгиб виден), дальше LOD_DISTANCE от центра — один
  // треугольник той же формы: вершин втрое меньше, а издали разницы нет. Трава упирается в
  // вершинный шейдер, так что это прямой выигрыш в кадрах.
  const LOD_DISTANCE = 8;
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
  farBlade.setAttribute('normal', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1], 3));
  // Дальше CLUMP_FROM — кустик-«корона» одним экземпляром: 6 травинок веером, сильно наклонённых
  // наружу (сверху, с вышки, они закрывают больше земли), у соседних общие нижние вершины
  // (12 вершин на 6 травинок вместо 18), экземпляров вшестеро меньше. Один вызов на всё кольцо.
  const CLUMP_FROM = 20; // м
  const CROWN_BLADES = 6;
  const crown = new THREE.BufferGeometry();
  {
    const ring = [];
    const tips = [];
    const uvs = [];
    const index = [];
    for (let k = 0; k < CROWN_BLADES; k += 1) {
      const a = (k / CROWN_BLADES) * Math.PI * 2;
      const mid = a + Math.PI / CROWN_BLADES;
      const lean = k % 2 ? 0.32 : 0.2; // через одну — сильнее наклонены и ниже
      const top = k % 2 ? 0.8 : 1;
      ring.push(Math.cos(a) * 0.1, 0, Math.sin(a) * 0.1); // основание широкое: травинка — хорда кольца
      tips.push(Math.cos(mid) * lean, top, Math.sin(mid) * lean);
      index.push(k, (k + 1) % CROWN_BLADES, CROWN_BLADES + k);
    }
    for (let k = 0; k < CROWN_BLADES; k += 1) uvs.push(0, 0);
    for (let k = 0; k < CROWN_BLADES; k += 1) uvs.push(0.5, 1);
    crown.setAttribute('position', new THREE.Float32BufferAttribute([...ring, ...tips], 3));
    crown.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    crown.setIndex(index);
    crown.computeVertexNormals(); // у кончика — нормаль своей травинки; низ в тени, там нормаль не важна
  }
  // на травинку: оттенок кустика, своя случайность (0..1) и пятно луга под ней (meadowPatch из шейдера,
  // посчитанный здесь заранее: выборка текстуры в вершинном шейдере на Quest дорогая)
  const grassFresh = !cache.lods; // травинки уже расставлены (подмена сцены): берём готовые
  const lods = cache.lods ?? [blade, farBlade, crown].map((geometry) => ({
    geometry,
    count: 0,
    matrices: new Float32Array(GRASS_COUNT * 16),
    variation: new Float32Array(GRASS_COUNT * 3),
  }));
  const grassMaterial = new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    toneMapped: false,
    uniforms: { ...meadowUniforms, seasonQ: u(look.seasonQ), skyRefl: u(look.skyRefl), time: grassTime, ...dogU },
    // Весь свет считается по вершинам (у ближней травинки их 6): так на Quest заметно дешевле, чем в каждом
    // пикселе, а на узкой травинке разницы не видно. Фрагментный шейдер только выбирает сторону.
    vertexShader: `
      attribute vec3 aVariation;
      uniform vec4 seasonQ; // x — с какой «случайности» травинка сухая (лето 0.94: каждая шестнадцатая)
      uniform vec3 skyRefl; // небо над головой: блеск мокрого поля и лужи вдали
      varying vec3 vFront;
      varying vec3 vBack;
      ${MEADOW_GLSL}
      ${DOG_NEAR_UV_GLSL}
      void main() {
        mat4 m = modelMatrix * instanceMatrix;
        vec4 world = m * vec4(position, 1.0);
        vec3 base = m[3].xyz;
        float tall = length(m[1].xyz);
        float h = uv.y;
        float bend = h * h;
        float gust = sin(windP.z + base.x * 0.35 + base.z * 0.22) * 0.6 + sin(windP.w + base.x * 1.7 + base.z * 0.9) * 0.25;
        float wave = windWave(base.xz); // широкая волна ветра, та же, что бежит по полю вдали
        float sway = bend * (0.4 + tall * 1.6); // высокие гнутся сильнее
        // снег на земле: над ним остаётся половина травинки; сколько её укрыто — как у земли под ней
        // (те же пятна луга, что в шейдере земли: снег ложится и сходит одними и теми же проплешинами).
        // Трава упирается в вершинный шейдер: всё погодное ниже — за проверками uniform-ов, в обычную
        // погоду (сухо, без снега и тумана) вершина стоит столько же, сколько до погоды.
        float snowHere = wetP.w > 0.001 ? smoothstep(0.0, 0.3, wetP.w * 1.3 - (0.5 * aVariation.z + 0.15)) : 0.0;
        // под снегом травинка ниже, в бурю её прижимает к земле (иначе сильный наклон растягивал бы её)
        world.y -= (world.y - base.y) * (0.5 * snowHere * wetP.w + windA.w * 0.45 * h);
        world.xz += windDir * (sway * (windA.x + gust * windA.y + wave * windA.z)) + vec2(-windDir.y, windDir.x) * (sway * gust * windA.y * 0.43);
        gl_Position = projectionMatrix * viewMatrix * world;
        dogShadowUv(world.xyz); // тень пса на травинке (sun-shadows.js)

        // цвет: сизо-зелёный ↔ жёлто-зелёный по пятнам луга и по кустику; изредка (осенью и зимой —
        // часто) сухая травинка
        float tint = aVariation.z;
        float tone = clamp(tint * 0.7 + aVariation.x * 0.6 - 0.25, 0.0, 1.0);
        vec3 lush = grassLush(tone);
        lush *= 0.8 + 0.4 * aVariation.y;
        lush = mix(lush, dryCol, step(seasonQ.x, aVariation.y) * 0.8);
        vec3 ground = meadowGround(tint);
        vec3 albedo = mix(ground * 0.8, lush, smoothstep(0.0, 0.7, h));
        // весна: у каждой восьмой травинки кончик — цветок (белый, жёлтый, розовый)
        if (seasonP.x > 0.001) {
          float pick = fract(aVariation.y * 7.31 + aVariation.x * 3.17);
          float bloom = step(1.0 - 0.12 * seasonP.x, pick) * smoothstep(0.55, 0.95, h);
          vec3 petal = mix(vec3(1.0, 0.96, 0.85), vec3(1.0, 0.72, 0.08), step(0.5, fract(pick * 17.0)));
          petal = mix(petal, vec3(0.85, 0.3, 0.62), step(0.7, fract(pick * 41.0)));
          albedo = mix(albedo, petal, bloom);
          lush = mix(lush, petal * 0.4, bloom);
        }
        // снег: травинка белеет (кончики — шапки снега), просвечивает меньше
        if (snowHere > 0.0) {
          albedo = mix(albedo, vec3(0.82, 0.86, 0.95), snowHere * wetP.w * (0.5 + 0.4 * aVariation.y));
          lush *= 1.0 - 0.8 * snowHere * wetP.w;
        }
        // свет: небо сверху, светило сбоку; низ травинок в тени соседних
        vec3 n = normalize(mat3(m) * (normal + vec3(0.0, -0.5 * h, 0.0)));
        float ndl = dot(n, grassSun);
        float sunReach = smoothstep(0.15, 1.0, h);
        vec3 sky = albedo * skyLight * (0.5 + 0.5 * h);
        vec3 sun = sunLight * 1.5 * sunReach;
        // просвечивание: обратная к солнцу сторона и особенно взгляд против солнца
        vec3 glow = (lush * 1.6 + vec3(0.05, 0.035, 0.0)) * glowTint * sunReach;
        vec3 viewDir = normalize(world.xyz - cameraPosition);
        float against = pow(clamp(dot(viewDir, grassSun), 0.0, 1.0), 3.0);
        float waveLight = 1.0 + waveGain() * wave; // пригнутая волной трава светлее
        vFront = (sky + albedo * sun * max(ndl, 0.0) + glow * (max(-ndl, 0.0) * 0.6 + against * 1.6)) * waveLight;
        vBack = (sky + albedo * sun * max(-ndl, 0.0) + glow * (max(ndl, 0.0) * 0.6 + against * 1.6)) * waveLight;
        // вдали травинки сливаются с землёй под ними (тот же расчёт, что в шейдере земли): поле
        // густое, без мерцания; к краю кольца травинок — целиком, так что края кольца не видно
        float ringR = length(base.xz);
        float graze = 1.0 - clamp(-viewDir.y, 0.0, 1.0);
        float cover = clamp(0.5 + graze * graze * 0.5, 0.0, 1.0); // в среднем как у земли под травой
        vec3 under = mix(ground * depthGain * 1.1, grassField(grassLush(tone), viewDir) * 1.08 * waveLight, cover);
        // тень облака — и на травинке, и на поле под ней (как в шейдере земли)
        float cloudLit = cloudShade(base.xz);
        vFront *= cloudLit;
        vBack *= cloudLit;
        under *= cloudLit;
        float camDist = length(world.xz - cameraPosition.xz);
        // туман погоды и мокрое считаются, только когда они есть
        bool foggy = fogP.y > 0.0;
        bool wetField = lightP.z + wetP.y > 0.001;
        vec3 haze = foggy || wetField ? hazeColor((world.xz - cameraPosition.xz) / max(camDist, 1e-3)) : vec3(0.0);
        if (snowHere > 0.0) under = mix(under, snowCol, snowHere * (0.62 + 0.36 * wetP.w));
        if (wetField) {
          // мокрое поле вдали блестит, как земля под ним; лужи — в среднем (иначе край кольца травинок виден)
          float down = clamp(-viewDir.y, 0.0, 1.0);
          under += skyRefl * (lightP.z * graze * graze * 0.07);
          under = mix(under, mix(haze, skyRefl, smoothstep(0.02, 0.45, down)), wetP.y * 0.2 * (0.05 + 0.95 * pow(1.0 - down, 5.0)) * (1.0 - snowHere));
        }
        float fade = max(smoothstep(8.0, 28.0, camDist) * 0.55, smoothstep(${f(GRASS_RING * 0.6)}, ${f(GRASS_RING)}, ringR));
        vFront = mix(vFront, under, fade);
        vBack = mix(vBack, under, fade);
        // туман: травинки растворяются вместе с землёй
        if (foggy) {
          float fog = hazeAmount(camDist);
          vFront = mix(vFront, haze, fog);
          vBack = mix(vBack, haze, fog);
        }
      }`,
    fragmentShader: `
      varying vec3 vFront;
      varying vec3 vBack;
      varying vec2 vDogUv;
      ${DOG_NEAR_GLSL}
      void main() {
        gl_FragColor = vec4((gl_FrontFacing ? vFront : vBack) * (1.0 - (1.0 - dogShadeNear(vDogUv)) * dogShadowStrength), 1.0);
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
    // Густота по кругу: у центра полная, дальше 1 / (1 + ((d − 2)/12)²) — густо там, куда смотрят с
    // вышки (10–40 м); впереди (−Z, куда смотрят в бою) чуть гуще, чем сзади (×1 и ×0,8).
    const density = (d, z) => (0.9 - 0.1 * (z / Math.max(d, 1))) / (1 + (Math.max(0, d - 2) / 12) ** 2);
    let i = 0;
    while (i < GRASS_COUNT) {
      const cd = GRASS_RING * Math.sqrt(seeded()); // равномерно по площади круга
      const ca = seeded() * Math.PI * 2;
      const cx = Math.cos(ca) * cd;
      const cz = Math.sin(ca) * cd;
      if (seeded() > density(cd, cz)) continue;
      // вдали травинки крупнее и кустики шире: редкое поле всё равно читается травой
      const far = Math.max(0, cd - 20);
      const grow = 1 + Math.max(0, cd - 12) / 30; // шире уже с 12 м: с вышки поле должно быть густым
      const single = seeded() < 0.45;
      const count = single ? 1 : 4 + Math.floor(seeded() * 7);
      const radius = single ? 0 : (0.07 + seeded() * 0.16) * grow;
      const GRASS_HEIGHT = 1; // общий множитель высоты травы (пользователь: было 0,5 — «в 2 раза выше»)
      const clumpTall = (0.22 + seeded() ** 1.5 * 0.5) * (1 + far / 120) * GRASS_HEIGHT;
      const clumpTone = seeded();
      if (cd >= CLUMP_FROM) {
        // среднее кольцо: кустик — одна «корона» (считается за CROWN_BLADES травинок)
        const lod = lods[2];
        const spread = (0.8 + seeded() * 0.6) * (1 + (cd - CLUMP_FROM) / 40); // вдали кустики крупнее
        yaw.setFromAxisAngle(up, seeded() * Math.PI * 2);
        where.set(cx, groundHeight(cx, cz), cz);
        size.set(spread, clumpTall * (0.75 + 0.4 * seeded()), spread);
        matrix.compose(where, yaw, size);
        matrix.toArray(lod.matrices, lod.count * 16);
        lod.variation[lod.count * 3] = clumpTone;
        lod.variation[lod.count * 3 + 1] = seeded();
        lod.variation[lod.count * 3 + 2] = meadowPatch(cx, cz);
        lod.count += 1;
        i += CROWN_BLADES;
        continue;
      }
      for (let k = 0; k < count && i < GRASS_COUNT; k += 1, i += 1) {
        const angle = seeded() * Math.PI * 2;
        const r = radius * Math.sqrt(seeded());
        const x = cx + Math.cos(angle) * r;
        const z = cz + Math.sin(angle) * r;
        const tall = clumpTall * (0.65 + 0.55 * seeded());
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

  // Тени травинок на земле. Светило для теней не ниже SHADOW_ELEVATION над горизонтом (иначе на
  // закате тени слишком длинные). Силуэты всех травинок рисуются в текстуру камерой со стороны
  // светила (как карта теней, но без глубины: принимает тени только земля), и шейдер земли
  // затемняет себя там, где на неё падает силуэт. Форма тени — настоящая форма травинки.
  // Запекается не каждый кадр: заново — когда светило ушло больше чем на SHADOW_REBAKE_DEG и
  // остановилось или идёт медленно (обычный ход суток — раз в десятки секунд, один проход ≈ трава
  // одного глаза). Пока солнце бежит по небу быстро (смена времени суток), тени травы гаснут и
  // возвращаются уже на новом месте. В пасмурную погоду и в сумерки их нет (look.lightP.w = 0).
  const SHADOW_ELEVATION = 22; // градусов
  const SHADOW_SIZE = 2048;
  const SHADOW_REBAKE_DEG = 2.5;
  // при подмене сцены земля сразу берёт готовую текстуру теней из кэша
  const shadowTarget = (cache.shadowTarget ??= new THREE.WebGLRenderTarget(SHADOW_SIZE, SHADOW_SIZE));
  const shadowScene = new THREE.Scene();
  shadowScene.background = new THREE.Color(1, 1, 1);
  const silhouetteMaterial = new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.DoubleSide });
  for (const lod of lods) shadowScene.add(makeBlades(lod, silhouetteMaterial)); // матрицы общие с травой
  // к светилу для теней: тот же объект всю жизнь мира, двигается на месте (по нему же — тени псов)
  const shadowSun = new THREE.Vector3(1, 0.4, 0).normalize();
  const aimShadowSun = () => {
    // главный свет уже посчитан состоянием атмосферы (now.keyDir: то же правило — солнце, ниже −5,5°
    // луна, не ниже 22°): берём его, чтобы тени и свет на предметах не могли разойтись
    const key = atmoNow().keyDir;
    if (key) {
      shadowSun.copy(key);
      return;
    }
    const light = look.lightDir;
    const flat = Math.hypot(light.x, light.z);
    const elevation = Math.max(Math.asin(Math.max(-1, Math.min(1, light.y))), THREE.MathUtils.degToRad(SHADOW_ELEVATION));
    if (flat < 1e-3) shadowSun.set(shadowSun.x, 0, shadowSun.z).normalize().multiplyScalar(Math.cos(elevation));
    else shadowSun.set((light.x / flat) * Math.cos(elevation), 0, (light.z / flat) * Math.cos(elevation));
    shadowSun.y = Math.sin(elevation);
  };
  aimShadowSun();
  // текстура теней покрывает круг у центра (±30 м поперёк солнца, вдоль — до ±80 м: косой взгляд
  // солнца растягивает её по земле), где тени видны; дальние редкие травинки без теней
  const grassCenter = new THREE.Vector3(0, 0, 0);
  const shadowCamera = new THREE.OrthographicCamera(-30, 30, 30, -30, 1, 300);
  const shadowMatrix = land.material.uniforms.shadowMatrix.value;
  const bakedSun = (cache.shadowDir ??= new THREE.Vector3()); // с какой стороны запечено
  const aimShadowCamera = (dir) => {
    shadowCamera.position.copy(grassCenter).addScaledVector(dir, 120);
    shadowCamera.lookAt(grassCenter);
    shadowCamera.updateMatrixWorld(true);
    shadowMatrix.multiplyMatrices(shadowCamera.projectionMatrix, shadowCamera.matrixWorldInverse);
  };
  land.material.uniforms.grassShadow.value = shadowTarget.texture;
  let shadowBaked = Boolean(cache.shadowBaked);
  if (shadowBaked) aimShadowCamera(bakedSun);
  const bakeGrassShadows = () => {
    bakedSun.copy(shadowSun);
    aimShadowCamera(bakedSun);
    const xrEnabled = renderer.xr.enabled;
    const previous = renderer.getRenderTarget();
    renderer.xr.enabled = false; // в текстуру, а не в шлем
    renderer.setRenderTarget(shadowTarget);
    renderer.render(shadowScene, shadowCamera);
    renderer.setRenderTarget(previous);
    renderer.xr.enabled = xrEnabled;
    shadowBaked = true;
    cache.shadowBaked = true;
  };
  const lastShadowSun = shadowSun.clone();
  let shadowSpeed = 0; // градусов в секунду (сглажено)
  let shadowFade = shadowBaked ? 1 : 0;
  let shadowWait = 0;
  const updateGrassShadows = (realDt) => {
    const step = Math.max(realDt, 1e-3);
    const moved = THREE.MathUtils.radToDeg(lastShadowSun.angleTo(shadowSun));
    lastShadowSun.copy(shadowSun);
    shadowSpeed += (moved / step - shadowSpeed) * Math.min(1, step * 6);
    const off = shadowBaked ? THREE.MathUtils.radToDeg(bakedSun.angleTo(shadowSun)) : 180;
    const racing = shadowSpeed > 3;
    shadowWait -= step;
    const wanted = skyLook.pub.shadow;
    if (!shadowBaked || (off > SHADOW_REBAKE_DEG && !racing && shadowWait <= 0 && wanted > 0.01)) {
      const jump = off > 8;
      bakeGrassShadows();
      shadowWait = 0.5;
      if (jump) shadowFade = 0; // после большого скачка тени проявляются плавно
    }
    const target = racing || (shadowBaked && THREE.MathUtils.radToDeg(bakedSun.angleTo(shadowSun)) > 8) ? 0 : 1;
    shadowFade += Math.sign(target - shadowFade) * Math.min(Math.abs(target - shadowFade), step * 4);
    look.lightP.w = wanted * shadowFade;
  };

  // молния: где ударило — там облака светятся ярче (событие состояния атмосферы)
  let atmoSeen = null;
  let offLightning = null;
  const cameraPosition = new THREE.Vector3();
  const strike = new THREE.Vector3();
  const onLightning = (event) => {
    if (!event || !Number.isFinite(event.x) || !Number.isFinite(event.z)) return;
    strike.set(event.x - cameraPosition.x, 700 + 0.25 * Math.hypot(event.x - cameraPosition.x, event.z - cameraPosition.z), event.z - cameraPosition.z).normalize();
    look.flashP.x = strike.x;
    look.flashP.y = strike.y;
    look.flashP.z = strike.z;
  };
  const wrap = (v) => ((v % 1) + 1) % 1;
  let warmFrames = 3;
  let lastUpdateMs = performance.now();
  return {
    shadowSun, // к светилу для теней (не ниже 22°): тот же объект, двигается на месте; тени псов (sun-shadows.js) — по нему же
    update(dt) {
      const nowMs = performance.now();
      const realDt = Math.min(0.1, (nowMs - lastUpdateMs) / 1000);
      lastUpdateMs = nowMs;
      // состояние атмосферы → цвета и числа для шейдеров (uniform-ы держат те же объекты)
      const atmo = shared.atmosphere;
      if (atmo !== atmoSeen) {
        offLightning?.();
        offLightning = atmo?.on?.('lightning', onLightning) ?? null;
        atmoSeen = atmo;
      }
      skyLook.update(atmoNow(), dt);
      aimShadowSun();
      // небо следует за головой: до него не дойти
      camera.getWorldPosition(cameraPosition);
      skyGroup.position.copy(cameraPosition);
      // облака: нижний слой плывёт быстрее верхнего (параллакс); искажение и мелкий шум краёв медленно
      // смещаются сами по себе — клубы понемногу перетекают, а не едут единым листом. Ветер несёт и
      // облака, и шум, который дорисовывает пелену между ними.
      const wx = look.cloudWind.x;
      const wz = look.cloudWind.y;
      cloudShift[0] = wrap(cloudShift[0] - wx * MAP);
      cloudShift[1] = wrap(cloudShift[1] - wz * MAP);
      cloudShift[2] = wrap(cloudShift[2] - wx * HIGH_SPEED * MAP * HIGH_SCALE);
      cloudShift[3] = wrap(cloudShift[3] + wz * HIGH_SPEED * MAP * HIGH_SCALE);
      warpShift[0] = wrap(warpShift[0] + 0.0021 * dt - wx * 0.045);
      warpShift[1] = wrap(warpShift[1] - 0.0013 * dt - wz * 0.045);
      warpShift[2] = wrap(warpShift[2] - wx * 0.45 + 0.004 * dt);
      warpShift[3] = wrap(warpShift[3] - wz * 0.45 + 0.003 * dt);
      skyUniforms.cloudShift.value.fromArray(cloudShift);
      skyUniforms.warpShift.value.fromArray(warpShift);
      skyTime.value = (skyTime.value + dt) % 10000;
      // размер звёзд в пикселях: половина высоты кадра (в шлеме — кадра одного глаза)
      const eye = renderer.xr.isPresenting ? renderer.xr.getCamera().cameras[0] : null;
      skyUniforms.starPx.value = (eye ? eye.viewport.w : renderer.domElement.height) / 2;
      shared.skyStarPx = skyUniforms.starPx; // свои камеры (камера дрона) подменяют на время своего кадра
      // днём звёзды не рисуются вовсе (первые кадры видны всегда: шейдер собирается при подмене сцены, а не в сумерках)
      if (warmFrames > 0) warmFrames -= 1;
      stars.visible = warmFrames > 0 || look.nightP.x > 0.003;
      grassTime.value += dt;
      updateGrassShadows(realDt);
    },
    dispose() {
      // каждый шаг отдельно: упавший шаг не должен прерывать уборку остальной сцены
      const steps = [
        () => offLightning?.(),
        () => { if (shared.skyLook === skyLook.pub) shared.skyLook = null; },
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
