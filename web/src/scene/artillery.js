// Артиллерия в большой битве («Сцена 3», функция сцены «robodogHorde»; меню «Собаки ▸ Артиллерия:
// вкл/выкл», shared.artillery, localStorage 'scene.artillery', по умолчанию вкл).
//
// Батарей не видно (их не рисуем): враги — далеко впереди за горизонтом (−Z мира), союзники — далеко
// сзади. Каждая сторона раз в 10–25 с даёт залп 3–8 снарядов (чаще и больше во время своей волны
// стаи и когда целей много) по самому плотному скоплению псов другой стороны (разброс до ~8 м); целей
// нет — бьёт по полю. Вокруг игрока (и вышки) SAFE_R м снаряды не падают.
//
// Снаряд: на горизонте — короткая вспышка выстрела, через расстояние/скорость звука — глухой «бум»
// батареи (из её стороны); за WHISTLE_S до разрыва — свист (голос летит за снарядом), за STREAK_S —
// яркий след падающего снаряда. Цель за время полёта ушла — точку разрыва перед свистом подводят к
// псу, по которому стреляли (с тем же разбросом).
//
// РАЗРЫВ (главное): ослепительная бело-жёлтая вспышка (звезда + свечение), свет на земле (плоское
// аддитивное пятно — вместо PointLight: новый источник света пересобрал бы все шейдеры), огненный шар
// из клубов с «размывом» по шуму (горят и рвутся по краям, темнеют и становятся дымом), ударная волна
// по земле (кольцо пыли) и светлое кольцо в воздухе, высокий тёмный столб дыма (поднимается и
// расползается 7–10 с, сносится ветром к −X), фонтан земли, комья по дугам, искры, плавающие угли,
// юбка пыли от центра, тлеющая воронка (мерцает 5 с), обгорелое пятно на земле (до SCORCH_CAP, тает за
// 30 с). Звук (artillery-sound.js): запечённый взрыв (треск + суббас + дождь комьев + гул) с задержкой
// расстояние/343 м/с, вариант по дальности (рядом / средне / далеко — глуше и с эхом). Тряска обзора
// (shared.screenShake, уважает настройку «Тряска») — по расстоянию, несколько затухающих толчков.
// Урон в радиусе SPLASH_R: псам обеих команд (unit.strike; маленьких и средних ещё и сбивает с ног,
// убитых и трупы подбрасывает — unit.blast), коптерам (shared.droneStrike).
//
// Дёшево: все эффекты — один InstancedBufferGeometry (квадрат) + один ShaderMaterial (атлас 512×256 из
// 8 клеток, запечён один раз в __sceneState.artilleryAtlas) = один вызов отрисовки, 0 когда пусто.
// Смешение «premultiplied»: огонь аддитивный, дым обычный — в одном проходе (aVel.w — доля
// аддитивности). Частицы — типизированные массивы (__sceneState.artilleryFx, переживают подмену файла
// сцены), без выделений в кадре; CAP частиц, взрывы далеко и когда их много — беднее (LOD).
// Логика (снаряды, разрывы, урон) — в update(dt) подшагами мира; частицы стареют и пишутся в буфер
// один раз за кадр — frame(dt) с dt = clock.total (игровое время, world-clock.js).
//
// createArtillery({ THREE, root, camera, horde }) → { apply(on), update(dt), frame(dt), debug, dispose() }
import { createArtillerySound, WHISTLE_S } from './artillery-sound.js';
import { groundHeight } from './car.js';

const CAP = 1500; // частиц всего
const SCORCH_CAP = 24;
const FX_VERSION = 1;
const SAFE_R = 18; // вокруг игрока снаряды не падают, м
const SPLASH_R = 7.5; // радиус поражения, м
const SCATTER = 8; // разброс вокруг точки прицела, м
const CLUSTER_R = 12;
const BATTERY_M = 1400; // до батареи
const SOUND_MPS = 343;
const SHELL_VH = 230; // скорость снаряда на подлёте: по горизонтали и вниз, м/с
const SHELL_VV = 190;
const STREAK_S = 0.5;
const FLIGHT = [8.5, 10.5]; // с от выстрела до разрыва
// взрывов в 2 раза меньше (просьба пользователя): залпы в ~1,5 раза реже и чуть меньше (было [10, 25] и [3, 8])
const GAP = [15, 37]; // с между залпами одной стороны
const FIRST = { enemy: 5, ally: 11 };
const SALVO = [2, 6];
const SHELLS_MAX = 32;
const LOG_EVERY_MS = 10000;

// типы частиц
const T_FLASH = 0;
const T_GLOW = 1;
const T_LAUNCH = 2;
const T_POOL = 3;
const T_RING = 4;
const T_RINGFX = 5;
const T_FIRE = 6;
const T_SMOKE = 7;
const T_DUST = 8;
const T_DIRT = 9;
const T_DEBRIS = 10;
const T_SPARK = 11;
const T_EMBER = 12;
const T_CRATER = 13;
// аддитивные — во втором проходе (поверх дыма)
const ADDITIVE = [1, 1, 1, 1, 0, 1, 1, 0, 0, 0, 0, 1, 1, 1];

const rand = (a, b) => a + Math.random() * (b - a);
const smooth = (a, b, x) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

// ---------------------------------------------------------------- атлас 4×2 клетки по 128
// 0, 1 — клубы (плотность с шумом: размыв съедает их с краёв и дыр), 2 — мягкое свечение,
// 3 — чёрточка (искра, след снаряда), 4 — кольцо, 5 — обгорелое пятно, 6 — ком земли, 7 — звезда вспышки
const buildAtlas = (THREE) => {
  const C = 128;
  const W = C * 4;
  const H = C * 2;
  const data = new Uint8Array(W * H * 4);
  const hash = (x, y, s) => {
    let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(s, 982451653)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };
  const vnoise = (x, y, s) => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const xf = x - xi;
    const yf = y - yi;
    const u = xf * xf * (3 - 2 * xf);
    const v = yf * yf * (3 - 2 * yf);
    const a = hash(xi, yi, s);
    const b = hash(xi + 1, yi, s);
    const c = hash(xi, yi + 1, s);
    const d = hash(xi + 1, yi + 1, s);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  };
  const fbm = (x, y, s) => {
    let v = 0;
    let a = 0.5;
    let f = 1;
    for (let o = 0; o < 4; o += 1) {
      v += a * vnoise(x * f, y * f, s + o * 17);
      f *= 2.03;
      a *= 0.5;
    }
    return v / 0.9375;
  };
  const clamp01 = (x) => Math.max(0, Math.min(1, x));
  const out = { r: 1, g: 1, b: 1, a: 0 };
  const cells = [
    // 0: клуб
    (u, v, r) => {
      const n = fbm(u * 2.2 + 3, v * 2.2 + 7, 1);
      const n2 = fbm(u * 5 + 1, v * 5 + 2, 9);
      const fall = 1 - smooth(0.3, 1, r + (n - 0.5) * 0.55);
      out.a = clamp01(fall * (0.35 + n * 0.95));
      out.r = out.g = out.b = clamp01(0.74 + 0.5 * (n2 - 0.5));
    },
    // 1: клуб комковатый
    (u, v, r) => {
      const ang = Math.atan2(v, u);
      const billow = 0.78 + 0.5 * (fbm(Math.cos(ang) * 1.6 + 5, Math.sin(ang) * 1.6 + 5, 4) - 0.5);
      const n = fbm(u * 3 + 11, v * 3 + 4, 6);
      const fall = 1 - smooth(billow * 0.4, billow, r);
      out.a = clamp01(fall * (0.3 + n * 1.0));
      out.r = out.g = out.b = clamp01(0.7 + 0.55 * (fbm(u * 6, v * 6, 8) - 0.5));
    },
    // 2: свечение
    (u, v, r) => {
      out.a = clamp01(Math.exp(-r * r * 4.5) * Math.sqrt(clamp01(1 - r)));
      out.r = out.g = out.b = 1;
    },
    // 3: чёрточка вдоль u
    (u, v) => {
      const au = Math.abs(u);
      out.a = clamp01(Math.exp(-v * v * 30) * (1 - au) ** 1.2 + 0.6 * Math.exp(-v * v * 220) * (1 - au));
      out.r = out.g = out.b = 1;
    },
    // 4: кольцо
    (u, v, r) => {
      const d = (r - 0.82) / 0.08;
      out.a = clamp01((Math.exp(-d * d) + (r < 0.82 ? 0.16 * smooth(0.3, 0.82, r) : 0)) * clamp01((1 - r) / 0.08));
      out.r = out.g = out.b = 1;
    },
    // 5: обгорелое пятно с лучами
    (u, v, r) => {
      const n = fbm(u * 3 + 11, v * 3 + 2, 21);
      const ang = Math.atan2(v, u);
      const ray = fbm(Math.cos(ang) * 4 + 1, Math.sin(ang) * 4 + 1, 33);
      const rr = r + (n - 0.5) * 0.35 - (ray - 0.5) * 0.45 * r;
      out.a = clamp01((1 - smooth(0.32, 0.95, rr)) * (0.78 + 0.22 * n)) * clamp01((1 - r) / 0.05);
      out.r = out.g = out.b = 0.03 + 0.07 * n;
    },
    // 6: ком земли
    (u, v, r) => {
      const ang = Math.atan2(v, u);
      const edge = 0.58 + 0.7 * (fbm(Math.cos(ang) * 1.3 + 3, Math.sin(ang) * 1.3 + 3, 41) - 0.5);
      out.a = clamp01((edge - r) / 0.06);
      out.r = out.g = out.b = clamp01(0.55 + 0.7 * (fbm(u * 4, v * 4, 43) - 0.5) - 0.2 * v);
    },
    // 7: звезда вспышки
    (u, v, r) => {
      const au = Math.abs(u);
      const av = Math.abs(v);
      const p = Math.abs(u + v) * 0.7071;
      const q = Math.abs(u - v) * 0.7071;
      const star = Math.exp(-au * 22) * Math.exp(-av * 2.5) + Math.exp(-av * 22) * Math.exp(-au * 2.5);
      const star2 = 0.4 * (Math.exp(-p * 30) * Math.exp(-q * 4) + Math.exp(-q * 30) * Math.exp(-p * 4));
      out.a = clamp01(Math.exp(-r * r * 10) + 0.7 * star + star2) * clamp01((1 - r) * 3);
      out.r = out.g = out.b = 1;
    },
  ];
  for (let ci = 0; ci < 8; ci += 1) {
    const ox = (ci % 4) * C;
    const oy = Math.floor(ci / 4) * C;
    for (let y = 0; y < C; y += 1) {
      for (let x = 0; x < C; x += 1) {
        const u = ((x + 0.5) / C) * 2 - 1;
        const v = ((y + 0.5) / C) * 2 - 1;
        cells[ci](u, v, Math.hypot(u, v));
        const j = ((oy + y) * W + ox + x) * 4;
        data[j] = Math.round(out.r * 255);
        data[j + 1] = Math.round(out.g * 255);
        data[j + 2] = Math.round(out.b * 255);
        data[j + 3] = Math.round(out.a * 255);
      }
    }
  }
  const tex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
};

const vertexShader = /* glsl */ `
  attribute vec4 iPos;  // xyz — центр, w — поворот (рад)
  attribute vec4 iSize; // xy — размер (м), z — режим (0 к камере, 1 по земле, 2 вдоль скорости), w — клетка + размыв
  attribute vec4 iCol;  // rgb — цвет (линейный, может быть > 1), a — непрозрачность
  attribute vec4 iVel;  // xyz — скорость (режим 2) или нормаль земли (режим 1), w — аддитивность 0..1
  varying vec2 vUv;
  varying vec4 vCol;
  varying float vAdd;
  varying float vEro;
  void main() {
    vec2 c = position.xy;
    float cr = cos(iPos.w);
    float sr = sin(iPos.w);
    vec2 rc = vec2(c.x * cr - c.y * sr, c.x * sr + c.y * cr);
    vec4 mv;
    if (iSize.z < 0.5) {
      mv = modelViewMatrix * vec4(iPos.xyz, 1.0);
      mv.xy += rc * iSize.xy;
    } else if (iSize.z < 1.5) {
      vec3 n = normalize(iVel.xyz);
      vec3 t = normalize(cross(n, vec3(0.0, 0.0, 1.0)));
      vec3 b = cross(t, n);
      mv = modelViewMatrix * vec4(iPos.xyz + t * (rc.x * iSize.x) + b * (rc.y * iSize.y), 1.0);
    } else {
      mv = modelViewMatrix * vec4(iPos.xyz, 1.0);
      vec2 d = (modelViewMatrix * vec4(iVel.xyz, 0.0)).xy;
      float l = length(d);
      d = l > 1e-5 ? d / l : vec2(1.0, 0.0);
      mv.xy += d * (c.x * iSize.x) + vec2(-d.y, d.x) * (c.y * iSize.y);
    }
    gl_Position = projectionMatrix * mv;
    float cell = floor(iSize.w);
    vEro = iSize.w - cell;
    vUv = (vec2(mod(cell, 4.0), floor(cell / 4.0)) + c * 0.97 + 0.5) * vec2(0.25, 0.5);
    vCol = iCol;
    vAdd = iVel.w;
  }
`;

const fragmentShader = /* glsl */ `
  uniform sampler2D map;
  varying vec2 vUv;
  varying vec4 vCol;
  varying float vAdd;
  varying float vEro;
  void main() {
    vec4 t = texture2D(map, vUv);
    float a = t.a;
    if (vEro > 0.001) a = smoothstep(vEro, min(1.0, vEro + 0.3), a);
    a *= vCol.a;
    gl_FragColor = vec4(vCol.rgb * t.rgb * a, a * (1.0 - vAdd));
    #include <colorspace_fragment>
  }
`;

// частицы: структура массивов (живые — первые n)
const makeStore = () => {
  const f = () => new Float32Array(CAP);
  const s = () => new Float32Array(SCORCH_CAP);
  return {
    version: FX_VERSION,
    n: 0,
    type: new Uint8Array(CAP), cell: new Uint8Array(CAP), mode: new Uint8Array(CAP),
    x: f(), y: f(), z: f(), vx: f(), vy: f(), vz: f(), age: f(), life: f(), s0: f(), s1: f(),
    a0: f(), tone: f(), drag: f(), grav: f(), rot: f(), spin: f(), w: f(), gy: f(), seed: f(),
    sc: { n: 0, x: s(), y: s(), z: s(), nx: s(), ny: s(), nz: s(), age: s(), life: s(), size: s(), rot: s() },
  };
};
const SC_KEYS = ['x', 'y', 'z', 'nx', 'ny', 'nz', 'age', 'life', 'size', 'rot'];
const TEAMS = ['enemy', 'ally'];
const KEYS = ['type', 'cell', 'mode', 'x', 'y', 'z', 'vx', 'vy', 'vz', 'age', 'life', 's0', 's1', 'a0', 'tone', 'drag', 'grav', 'rot', 'spin', 'w', 'gy', 'seed'];

export function createArtillery({ THREE, root, camera, horde = null }) {
  const shared = (globalThis.__sceneState ??= {});
  if (shared.artillery === undefined) {
    try {
      shared.artillery = localStorage.getItem('scene.artillery') !== 'off';
    } catch {
      shared.artillery = true;
    }
  }
  const sound = createArtillerySound(shared);
  if (shared.artilleryFx?.version !== FX_VERSION) shared.artilleryFx = makeStore();
  const P = shared.artilleryFx; // частицы и пятна переживают подмену файла сцены
  // { t, next: { enemy, ally }, shells, events, booms } — тоже
  let run = shared.artilleryRun ?? null;
  let feature = false;

  const head = new THREE.Vector3();
  const V = new THREE.Vector3();
  const V2 = new THREE.Vector3();
  const N = new THREE.Vector3();
  const aim = { x: 0, z: 0, unit: null };
  const cand = new Array(64).fill(null);

  // ---------------------------------------------------------------- меш
  if (shared.artilleryAtlas?.key !== buildAtlas.toString()) {
    shared.artilleryAtlas?.tex?.dispose();
    shared.artilleryAtlas = { key: buildAtlas.toString(), tex: buildAtlas(THREE) };
  }
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3));
  const attrs = ['iPos', 'iSize', 'iCol', 'iVel'].map((name) => {
    const attr = new THREE.InstancedBufferAttribute(new Float32Array(CAP * 4), 4).setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute(name, attr);
    return attr;
  });
  const [aPos, aSize, aCol, aVel] = attrs.map((a) => a.array);
  geometry.instanceCount = 0;
  const material = new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms: { map: { value: shared.artilleryAtlas.tex } },
    transparent: true,
    depthWrite: false,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    toneMapped: false,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'artillery-fx';
  mesh.frustumCulled = false; // шейдер собирается при подмене сцены, а не на первом разрыве
  mesh.renderOrder = 5;
  root.add(mesh);

  // ---------------------------------------------------------------- частицы
  // type, клетка, режим, точка, скорость (или нормаль для режима 1), жизнь, размер от/до, непрозрачность,
  // оттенок, сопротивление, тяжесть (−: всплывает), вращение, ширина (режим 2), высота земли
  const add = (type, cell, mode, x, y, z, vx, vy, vz, life, s0, s1, a0, tone, drag, grav, spin, w, gy) => {
    if (P.n >= CAP) return;
    const i = P.n++;
    P.type[i] = type; P.cell[i] = cell; P.mode[i] = mode;
    P.x[i] = x; P.y[i] = y; P.z[i] = z;
    P.vx[i] = vx; P.vy[i] = vy; P.vz[i] = vz;
    P.age[i] = 0; P.life[i] = life; P.s0[i] = s0; P.s1[i] = s1;
    P.a0[i] = a0; P.tone[i] = tone; P.drag[i] = drag; P.grav[i] = grav;
    P.rot[i] = Math.random() * Math.PI * 2; P.spin[i] = spin; P.w[i] = w; P.gy[i] = gy;
    P.seed[i] = Math.random() * 10;
  };
  const addScorch = (x, y, z, n, size) => {
    const sc = P.sc;
    let i = sc.n;
    if (i >= SCORCH_CAP) {
      // полно — заменяет самое старое
      i = 0;
      for (let k = 1; k < SCORCH_CAP; k += 1) if (sc.age[k] / sc.life[k] > sc.age[i] / sc.life[i]) i = k;
    } else sc.n += 1;
    sc.x[i] = x; sc.y[i] = y; sc.z[i] = z;
    sc.nx[i] = n.x; sc.ny[i] = n.y; sc.nz[i] = n.z;
    sc.age[i] = 0; sc.life[i] = 30; sc.size[i] = size; sc.rot[i] = Math.random() * Math.PI * 2;
  };
  const groundNormal = (x, z, out) => {
    const hx = groundHeight(x + 1, z) - groundHeight(x - 1, z);
    const hz = groundHeight(x, z + 1) - groundHeight(x, z - 1);
    return out.set(-hx, 2, -hz).normalize();
  };

  // ---------------------------------------------------------------- РАЗРЫВ
  let heat = 0; // сколько разрывов недавно (LOD, когда их много)
  const blastFx = (x, gy, z, dist) => {
    let L = dist > 130 ? 0.45 : dist > 75 ? 0.7 : 1;
    if (heat > 4) L *= 0.6;
    if (P.n > CAP - 160) L *= 0.4;
    heat += 1;
    const fs = Math.max(1, dist / 70); // далёкая вспышка — крупнее, чтобы её было видно
    groundNormal(x, z, N);
    // вспышка: звезда + широкое свечение
    add(T_FLASH, 7, 0, x, gy + 2.5, z, 0, 0, 0, 0.16, 10 * fs, 17 * fs, 1, 1, 0, 0, 0, 0, gy);
    add(T_GLOW, 2, 0, x, gy + 3, z, 0, 0.5, 0, 0.55, 14 * fs, 28 * fs, 0.9, 1, 0, 0, 0, 0, gy);
    // свет на земле и ударная волна
    add(T_POOL, 2, 1, x, gy + 0.15, z, N.x, N.y, N.z, 0.7, 30, 34, 0.9, 1, 0, 0, 0, 0, gy);
    add(T_RING, 4, 1, x, gy + 0.12, z, N.x, N.y, N.z, 0.6, 2, 38, 0.65, 1, 0, 0, 0, 0, gy);
    add(T_RINGFX, 4, 0, x, gy + 2, z, 0, 0, 0, 0.24, 3, 26, 0.5, 1, 0, 0, 0, 0, gy);
    // огненный шар: ядро + клубы во все стороны (больше вверх)
    add(T_FIRE, 0, 0, x, gy + 2.5, z, 0, 3, 0, 1.3, 5, 13, 1, 1, 1.5, -0.15, rand(-0.6, 0.6), 0, gy);
    const nf = Math.round(14 * L) + 2;
    for (let k = 0; k < nf; k += 1) {
      const a = Math.random() * Math.PI * 2;
      V.set(Math.cos(a), rand(0.3, 1.3), Math.sin(a)).normalize().multiplyScalar(rand(7, 17));
      add(T_FIRE, k & 1, 0, x + V.x * 0.08, gy + rand(0.8, 2.2), z + V.z * 0.08, V.x, V.y, V.z, rand(1.3, 2.3), rand(2.5, 4), rand(7, 11), 1, rand(0.7, 1), 2.4, -0.2, rand(-1, 1), 0, gy);
    }
    // столб дыма: клубы с разной скоростью вверх тормозят на разной высоте — получается столб
    const ns = Math.round(11 * L) + 3;
    for (let k = 0; k < ns; k += 1) {
      // высоты остановки — ровно от земли до верха (vy/drag ≈ 1…20 м): столб без дыр; внизу клубы мельче
      const h = k / Math.max(1, ns - 1);
      add(T_SMOKE, k & 1, 0, x + rand(-1, 1), gy + rand(1, 2.5), z + rand(-1, 1), rand(-1.5, 1.5), 0.6 + 9.5 * h + rand(-0.4, 0.4), rand(-1.5, 1.5), rand(8, 11), rand(3, 5), rand(7, 11) + 7 * h, rand(0.8, 0.95), rand(0.05, 0.1), 0.5, -0.015, rand(-0.25, 0.25), 0, gy);
    }
    // фонтан земли
    const nd = Math.round(7 * L);
    for (let k = 0; k < nd; k += 1) {
      V.set(rand(-0.35, 0.35), 1, rand(-0.35, 0.35)).normalize().multiplyScalar(rand(12, 24));
      add(T_DIRT, k & 1, 0, x, gy + 0.8, z, V.x, V.y, V.z, rand(1.8, 3), 1.2, rand(3.5, 5.5), 0.9, rand(0.8, 1.2), 0.9, 0.55, rand(-1, 1), 0, gy);
    }
    // комья по дугам
    const nb = Math.round(16 * L);
    for (let k = 0; k < nb; k += 1) {
      V.set(rand(-0.9, 0.9), rand(0.6, 1.4), rand(-0.9, 0.9)).normalize().multiplyScalar(rand(8, 22));
      const s = rand(0.22, 0.75);
      add(T_DEBRIS, 6, 0, x, gy + 0.8, z, V.x, V.y, V.z, 6, s, s, 1, rand(0.7, 1.3), 0.08, 1, rand(-12, 12), 0, gy);
    }
    // искры
    const nk = Math.round(26 * L);
    for (let k = 0; k < nk; k += 1) {
      V.set(rand(-1, 1), rand(0.2, 1.5), rand(-1, 1)).normalize().multiplyScalar(rand(10, 30));
      add(T_SPARK, 3, 2, x, gy + 1, z, V.x, V.y, V.z, rand(0.6, 1.6), 0.3, 0.3, 1, 1, 0.5, 1, 0, rand(0.05, 0.11) * fs, gy);
    }
    // угли, что плавают в воздухе
    const ne = Math.round(8 * L);
    for (let k = 0; k < ne; k += 1) {
      V.set(rand(-1, 1), rand(0.5, 1.5), rand(-1, 1)).normalize().multiplyScalar(rand(2, 7));
      const s = rand(0.2, 0.38);
      add(T_EMBER, 2, 0, x, gy + 1.5, z, V.x, V.y, V.z, rand(2, 4), s, s, 1, 1, 1.3, -0.06, 0, 0, gy);
    }
    // юбка пыли от центра
    const nu = Math.round(10 * L);
    for (let k = 0; k < nu; k += 1) {
      const a = (k / Math.max(1, nu)) * Math.PI * 2 + rand(-0.3, 0.3);
      const r0 = rand(1, 3);
      const v = rand(10, 17);
      add(T_DUST, k & 1, 0, x + Math.cos(a) * r0, gy + rand(0.6, 1.4), z + Math.sin(a) * r0, Math.cos(a) * v, rand(0.3, 1.3), Math.sin(a) * v, rand(2.4, 3.6), rand(2.2, 3.2), rand(7, 11), 0.8, rand(0.85, 1.15), 1.5, -0.02, rand(-0.4, 0.4), 0, gy);
    }
    // тлеющая воронка и угли в ней
    add(T_CRATER, 2, 1, x, gy + 0.1, z, N.x, N.y, N.z, rand(4.5, 6.5), 4.5, 5, 0.85, 1, 0, 0, 0, 0, gy);
    for (let k = 0; k < 4; k += 1) {
      const s = rand(0.35, 0.55);
      add(T_EMBER, 2, 0, x + rand(-1.3, 1.3), gy + 0.25, z + rand(-1.3, 1.3), 0, 0, 0, rand(3, 6), s, s, 1, 1, 0, 0, 0, 0, gy);
    }
    addScorch(x, gy + 0.05, z, N, rand(6, 8));
  };
  // РАЗРЫВ поменьше (ракета, arena-weapons.js): тот же вид в масштабе S (0,3 — шар ~3 м, дым ~6 м),
  // частиц меньше; y — точка взрыва: выше 1,2 м над землёй — в воздухе (без воронки, пятна, земли)
  const smallBlast = (x, y, z, S) => {
    const gy = groundHeight(x, z);
    const ground = y - gy < 1.2;
    const cy = ground ? gy : y;
    const lift = ground ? 1 : 0; // у земли огонь чуть выше точки, в воздухе — вокруг неё
    let L = heat > 6 ? 0.6 : 1;
    if (P.n > CAP - 160) L *= 0.4; // heat не копим: вне битвы update() не гасит его
    const rs = Math.sqrt(S);
    groundNormal(x, z, N);
    add(T_FLASH, 7, 0, x, cy + 1.6 * S * lift, z, 0, 0, 0, 0.13, 10 * S, 17 * S, 1, 1, 0, 0, 0, 0, gy);
    add(T_GLOW, 2, 0, x, cy + 2 * S * lift, z, 0, 0.5 * S, 0, 0.45, 14 * S, 26 * S, 0.9, 1, 0, 0, 0, 0, gy);
    add(T_RINGFX, 4, 0, x, cy + 1.2 * S * lift, z, 0, 0, 0, 0.22, 3 * S, 24 * S, 0.5, 1, 0, 0, 0, 0, gy);
    add(T_FIRE, 0, 0, x, cy + 2.2 * S * lift, z, 0, 3 * S, 0, 1.1, 5 * S, 12 * S, 1, 1, 1.5, -0.15 * S, rand(-0.6, 0.6), 0, gy);
    const nf = Math.round(9 * L) + 2;
    for (let k = 0; k < nf; k += 1) {
      const a = Math.random() * Math.PI * 2;
      V.set(Math.cos(a), ground ? rand(0.3, 1.3) : rand(-1, 1), Math.sin(a)).normalize().multiplyScalar(rand(7, 17) * S);
      add(T_FIRE, k & 1, 0, x + V.x * 0.08, cy + rand(0.8, 2.2) * S * lift, z + V.z * 0.08, V.x, V.y, V.z, rand(1, 1.7), rand(2.5, 4) * S, rand(7, 11) * S, 1, rand(0.7, 1), 2.4, -0.2 * S, rand(-1, 1), 0, gy);
    }
    const ns = Math.round(6 * L) + 2;
    for (let k = 0; k < ns; k += 1) {
      const h = k / Math.max(1, ns - 1);
      add(T_SMOKE, k & 1, 0, x + rand(-1, 1) * S, cy + rand(1, 2.5) * S, z + rand(-1, 1) * S, rand(-1.5, 1.5) * S, (0.6 + 9.5 * h + rand(-0.4, 0.4)) * S, rand(-1.5, 1.5) * S, rand(5, 7.5), rand(3, 5) * S, (rand(7, 11) + 7 * h) * S, rand(0.8, 0.95), rand(0.05, 0.1), 0.5, -0.015 * S, rand(-0.25, 0.25), 0, gy);
    }
    const nk = Math.round(16 * L);
    for (let k = 0; k < nk; k += 1) {
      V.set(rand(-1, 1), ground ? rand(0.2, 1.5) : rand(-1, 1.5), rand(-1, 1)).normalize().multiplyScalar(rand(10, 30) * rs);
      add(T_SPARK, 3, 2, x, cy + S * lift, z, V.x, V.y, V.z, rand(0.5, 1.3), 0.3 * S, 0.3 * S, 1, 1, 0.5, 1, 0, rand(0.04, 0.08), gy);
    }
    const ne = Math.round(5 * L);
    for (let k = 0; k < ne; k += 1) {
      V.set(rand(-1, 1), rand(0.5, 1.5), rand(-1, 1)).normalize().multiplyScalar(rand(2, 7) * S);
      const s = rand(0.2, 0.38) * rs;
      add(T_EMBER, 2, 0, x, cy + 1.5 * S, z, V.x, V.y, V.z, rand(1.5, 3), s, s, 1, 1, 1.3, -0.06 * S, 0, 0, gy);
    }
    if (!ground) return;
    add(T_POOL, 2, 1, x, gy + 0.12, z, N.x, N.y, N.z, 0.55, 30 * S, 34 * S, 0.9, 1, 0, 0, 0, 0, gy);
    add(T_RING, 4, 1, x, gy + 0.1, z, N.x, N.y, N.z, 0.5, 2 * S, 38 * S, 0.6, 1, 0, 0, 0, 0, gy);
    const nd = Math.round(4 * L);
    for (let k = 0; k < nd; k += 1) {
      V.set(rand(-0.35, 0.35), 1, rand(-0.35, 0.35)).normalize().multiplyScalar(rand(12, 24) * rs);
      add(T_DIRT, k & 1, 0, x, gy + 0.8 * S, z, V.x, V.y, V.z, rand(1.4, 2.4), 1.2 * S, rand(3.5, 5.5) * S, 0.9, rand(0.8, 1.2), 0.9, 0.55, rand(-1, 1), 0, gy);
    }
    const nb = Math.round(8 * L);
    for (let k = 0; k < nb; k += 1) {
      V.set(rand(-0.9, 0.9), rand(0.6, 1.4), rand(-0.9, 0.9)).normalize().multiplyScalar(rand(8, 22) * rs);
      const s = rand(0.22, 0.75) * rs * 0.7;
      add(T_DEBRIS, 6, 0, x, gy + 0.8 * S, z, V.x, V.y, V.z, 5, s, s, 1, rand(0.7, 1.3), 0.08, 1, rand(-12, 12), 0, gy);
    }
    const nu = Math.round(7 * L);
    for (let k = 0; k < nu; k += 1) {
      const a = (k / Math.max(1, nu)) * Math.PI * 2 + rand(-0.3, 0.3);
      const r0 = rand(1, 3) * S;
      const v = rand(10, 17) * S;
      add(T_DUST, k & 1, 0, x + Math.cos(a) * r0, gy + rand(0.6, 1.4) * S, z + Math.sin(a) * r0, Math.cos(a) * v, rand(0.3, 1.3) * S, Math.sin(a) * v, rand(2, 3), rand(2.2, 3.2) * S, rand(7, 11) * S, 0.8, rand(0.85, 1.15), 1.5, -0.02 * S, rand(-0.4, 0.4), 0, gy);
    }
    add(T_CRATER, 2, 1, x, gy + 0.1, z, N.x, N.y, N.z, rand(3, 4.5), 4.5 * S, 5 * S, 0.85, 1, 0, 0, 0, 0, gy);
    addScorch(x, gy + 0.05, z, N, rand(6, 8) * S);
  };
  // вспышка выстрела на горизонте (в стороне батареи)
  const launchFx = (bx, bz) => {
    V.set(bx - head.x, 0, bz - head.z).normalize();
    const x = head.x + V.x * 650;
    const z = head.z + V.z * 650;
    const gy = groundHeight(x, z);
    add(T_LAUNCH, 2, 0, x, gy + 6, z, 0, 0, 0, 0.4, 40, 55, 0.8, 1.2, 0, 0, 0, 0, gy);
    add(T_FLASH, 7, 0, x, gy + 4, z, 0, 0, 0, 0.12, 18, 22, 0.7, 1, 0, 0, 0, 0, gy);
  };

  // ---------------------------------------------------------------- цели и урон
  const dogUnits = () => {
    try {
      return horde?.debug?.units?.() ?? null; // псы стаи (robodog-horde.js)
    } catch {
      return null;
    }
  };
  const dogAlive = (u) => u && (u.mode === 'alive' || u.knocked) && !u.emerging;
  const safeDist = (x, z) => {
    let d = Math.hypot(x - head.x, z - head.z);
    const tp = shared.towerPos;
    if (tp) d = Math.min(d, Math.hypot(x - tp.x, z - tp.z));
    return d;
  };
  // самое плотное скопление псов, по которым бьёт батарея team (враги — по союзникам) → aim; false — нет
  const pickCluster = (team, units) => {
    if (!units) return false;
    const wantAlly = team === 'enemy';
    let n = 0;
    for (let i = 0; i < units.length && n < cand.length; i += 1) {
      const u = units[i];
      if (!dogAlive(u) || (u.dog.team === 'ally') !== wantAlly) continue;
      const d = safeDist(u.bodyCenter.x, u.bodyCenter.z);
      if (d < SAFE_R + 3 || d > 220) continue;
      cand[n++] = u;
    }
    if (!n) return false;
    let best = -1;
    let bestW = -1;
    for (let i = 0; i < n; i += 1) {
      const a = cand[i].bodyCenter;
      let w = 0;
      for (let j = 0; j < n; j += 1) {
        const b = cand[j].bodyCenter;
        if (Math.hypot(a.x - b.x, a.z - b.z) < CLUSTER_R) w += Math.sqrt(cand[j].scale);
      }
      if (w > bestW) {
        bestW = w;
        best = i;
      }
    }
    const c = cand[best].bodyCenter;
    let sx = 0;
    let sz = 0;
    let k = 0;
    for (let j = 0; j < n; j += 1) {
      const b = cand[j].bodyCenter;
      if (Math.hypot(c.x - b.x, c.z - b.z) < CLUSTER_R) {
        sx += b.x;
        sz += b.z;
        k += 1;
      }
    }
    aim.x = sx / k;
    aim.z = sz / k;
    aim.unit = cand[best];
    for (let i = 0; i < n; i += 1) cand[i] = null;
    return true;
  };
  // точка разрыва снаряда s: не ближе SAFE_R к игроку; направление подлёта — от батареи
  const settle = (s) => {
    let d = safeDist(s.x, s.z);
    if (d < SAFE_R) {
      let dx = s.x - head.x;
      let dz = s.z - head.z;
      let l = Math.hypot(dx, dz);
      if (l < 0.5) {
        const a = Math.random() * Math.PI * 2;
        dx = Math.sin(a);
        dz = -Math.cos(a);
        l = 1;
      }
      const r = SAFE_R + rand(1, 4);
      s.x = head.x + (dx / l) * r;
      s.z = head.z + (dz / l) * r;
      d = safeDist(s.x, s.z);
      if (d < SAFE_R) s.z = head.z - SAFE_R - 3; // вышка в стороне — просто вперёд
    }
    const dx = s.x - s.bx;
    const dz = s.z - s.bz;
    const l = Math.hypot(dx, dz) || 1;
    s.dx = dx / l;
    s.dz = dz / l;
  };
  // где снаряд s за tau с до разрыва → out
  const shellPos = (s, tau, out) => out.set(s.x - s.dx * SHELL_VH * tau, groundHeight(s.x, s.z) + SHELL_VV * tau, s.z - s.dz * SHELL_VH * tau);

  // урон и толчок в точке (x, gy, z)
  const splash = (x, gy, z) => {
    const units = dogUnits();
    if (units) {
      for (let i = 0; i < units.length; i += 1) {
        const u = units[i];
        if (u.mode === 'off' || u.emerging) continue;
        const c = u.bodyCenter;
        const R = SPLASH_R + 0.5 * u.scale;
        const dist = Math.hypot(c.x - x, c.y - gy, c.z - z);
        if (dist > R) continue;
        const k = 1 - dist / R;
        V2.set(c.x - x, 0, c.z - z);
        if (V2.lengthSq() < 1e-4) V2.set(Math.random() - 0.5, 0, Math.random() - 0.5);
        V2.normalize();
        V2.y = 0.6 + 0.7 * k;
        V2.normalize();
        try {
          if (dogAlive(u) || u.knocked) {
            const res = u.strike(c, V2, 1 + 7 * k * k);
            const sp = 4 + 9 * k;
            if (res === 'kill') u.blast?.(V2.x * sp, V2.y * sp, V2.z * sp);
            else if (res === 'hit' && u.scale <= 1.7 && k > 0.2) u.knock(V2, 1 + 2 * k);
          } else if ((u.mode === 'dying' || u.mode === 'dead') && u.deadFor < 30) {
            const sp = 3 + 7 * k;
            u.blast?.(V2.x * sp, V2.y * sp, V2.z * sp);
          }
        } catch {
          // пёс не важнее разрыва
        }
      }
    }
    const drones = shared.droneTargets;
    if (drones && shared.droneStrike) {
      for (let i = 0; i < drones.length; i += 1) {
        const d = drones[i];
        if (d.state !== 'alive') continue;
        const R = SPLASH_R * 1.4 + d.span;
        const dist = Math.hypot(d.x - x, d.y - gy, d.z - z);
        if (dist > R) continue;
        const k = 1 - dist / R;
        V2.set(d.x - x, d.y - gy, d.z - z).normalize();
        V.set(d.x, d.y, d.z);
        try {
          shared.droneStrike(d, V, V2, 1 + 10 * k);
        } catch {
          // коптер не важнее
        }
      }
    }
  };

  // ---------------------------------------------------------------- события по игровому времени
  // { at, kind: 'thump' | 'boom' | 'shake', x, y, z, a }
  const queue = (at, kind, x, y, z, a = 0) => {
    if (run.events.length < 96) run.events.push({ at, kind, x, y, z, a });
  };
  const fire = (e) => {
    V.set(e.x, e.y, e.z);
    if (e.kind === 'thump') sound.thump(V);
    else if (e.kind === 'boom') sound.boom(V, e.a);
    else if (e.kind === 'shake') {
      V2.set(head.x - e.x, 0, head.z - e.z);
      if (V2.lengthSq() < 1e-4) V2.set(0, 0, 1);
      V2.normalize();
      try {
        shared.screenShake?.(e.a, V2);
      } catch {
        // тряска не важнее
      }
    }
  };

  const impact = (s) => {
    const gy = groundHeight(s.x, s.z);
    const dist = Math.hypot(s.x - head.x, gy - head.y, s.z - head.z);
    blastFx(s.x, gy, s.z, dist);
    splash(s.x, gy, s.z);
    queue(run.t + dist / SOUND_MPS, 'boom', s.x, gy + 2, s.z, dist);
    if (dist < 170) {
      const k = Math.min(0.85, 15 / dist);
      const t0 = run.t + dist / 900; // земля доносит раньше воздуха
      queue(t0, 'shake', s.x, gy, s.z, k);
      queue(t0 + 0.07, 'shake', s.x, gy, s.z, k * 0.55);
      queue(t0 + 0.16, 'shake', s.x, gy, s.z, k * 0.35);
      queue(t0 + 0.3, 'shake', s.x, gy, s.z, k * 0.2);
    }
    run.booms += 1;
  };

  // залп батареи team: n снарядов (0 — по обстановке); at — точка (debug) или по скоплению/полю
  const barrage = (team, n = 0, at = null, flight = null) => {
    const units = dogUnits();
    let intensity = 1;
    try {
      const w = horde?.debug?.waves?.();
      if (w?.active === team) intensity += 0.6;
    } catch {
      // без волн
    }
    const has = !at && pickCluster(team, units);
    if (has) {
      let opp = 0;
      for (let i = 0; units && i < units.length; i += 1) if (dogAlive(units[i]) && (units[i].dog.team === 'ally') === (team === 'enemy')) opp += 1;
      intensity += Math.min(0.6, opp / 30);
    } else if (!at) intensity *= 0.7; // целей нет — по полю, пореже
    const count = n || Math.max(SALVO[0], Math.min(SALVO[1], Math.round(rand(3, 6) * intensity)));
    const bx = head.x + rand(-350, 350);
    const bz = head.z + (team === 'enemy' ? -BATTERY_M : BATTERY_M);
    let launch = run.t;
    for (let i = 0; i < count && run.shells.length < SHELLS_MAX; i += 1) {
      const r = Math.sqrt(Math.random()) * SCATTER;
      const a = Math.random() * Math.PI * 2;
      const ox = Math.cos(a) * r;
      const oz = Math.sin(a) * r;
      let x;
      let z;
      if (at) {
        x = at.x + ox;
        z = at.z + oz;
      } else if (has) {
        x = aim.x + ox;
        z = aim.z + oz;
      } else {
        // поле: впереди, в секторе ±50°
        const b = rand(-0.9, 0.9);
        const d = team === 'ally' ? rand(45, 140) : rand(28, 100);
        x = head.x + Math.sin(b) * d;
        z = head.z - Math.cos(b) * d;
      }
      const fl = flight ?? rand(FLIGHT[0], FLIGHT[1]);
      const s = { team, launchT: launch, impactT: launch + fl, bx, bz, x, z, ox, oz, dx: 0, dz: -1, track: has ? aim.unit : null, flashed: false, aimed: false, whistled: false, h: null };
      settle(s);
      run.shells.push(s);
      launch += rand(0.25, 0.9);
    }
    aim.unit = null;
    return count;
  };

  let enabled = false;
  const active = () => enabled && shared.artillery !== false;
  const ensureRun = () => {
    run = shared.artilleryRun ??= { t: 0, next: { enemy: FIRST.enemy, ally: FIRST.ally }, shells: [], events: [], booms: 0 };
  };

  // экземпляр m в буферы (frame)
  let m = 0;
  const put = (x, y, z, rot, sx, sy, mode, cellEro, r, g, b, a, vx, vy, vz, addK) => {
    if (m >= CAP) return;
    const j = m * 4;
    aPos[j] = x; aPos[j + 1] = y; aPos[j + 2] = z; aPos[j + 3] = rot;
    aSize[j] = sx; aSize[j + 1] = sy; aSize[j + 2] = mode; aSize[j + 3] = cellEro;
    aCol[j] = r; aCol[j + 1] = g; aCol[j + 2] = b; aCol[j + 3] = a;
    aVel[j] = vx; aVel[j + 1] = vy; aVel[j + 2] = vz; aVel[j + 3] = addK;
    m += 1;
  };

  // ---------------------------------------------------------------- телеметрия
  let cpuSum = 0;
  let cpuWorst = 0;
  let frames = 0;
  let since = performance.now();
  let maxN = 0;

  const api = {
    // включить/выключить вместе со стаей (функция сцены «robodogHorde»)
    apply(on) {
      feature = Boolean(on);
      enabled = feature;
      if (enabled) ensureRun();
    },
    // подшаг мира (игровое время)
    update(dt) {
      if (!run) return;
      camera.getWorldPosition(head);
      run.t += dt;
      heat *= Math.exp(-dt * 0.8);
      const on = active();
      if (on) {
        for (let ti = 0; ti < 2; ti += 1) {
          const team = TEAMS[ti];
          run.next[team] -= dt;
          if (run.next[team] <= 0) {
            barrage(team);
            run.next[team] = rand(GAP[0], GAP[1]);
          }
        }
      } else if (run.shells.length) run.shells.length = 0; // выключили — снаряды не долетают
      const shells = run.shells;
      for (let i = shells.length - 1; i >= 0; i -= 1) {
        const s = shells[i];
        const tl = s.impactT - run.t;
        if (!s.flashed && run.t >= s.launchT) {
          s.flashed = true;
          launchFx(s.bx, s.bz);
          // «бум» батареи — из её стороны, ~250 м
          V.set(s.bx - head.x, 0, s.bz - head.z).normalize();
          queue(s.launchT + BATTERY_M / SOUND_MPS, 'thump', head.x + V.x * 250, head.y + 10, head.z + V.z * 250);
        }
        if (!s.aimed && tl <= WHISTLE_S + 0.3) {
          s.aimed = true;
          // цель ушла — точка разрыва подводится к ней (с тем же разбросом)
          const u = s.track;
          if (u && dogAlive(u)) {
            s.x = u.bodyCenter.x + s.ox;
            s.z = u.bodyCenter.z + s.oz;
          }
          s.track = null;
          settle(s);
        }
        if (!s.whistled && tl <= WHISTLE_S) {
          s.whistled = true;
          shellPos(s, Math.max(0, tl), V);
          s.h = sound.whistle(V);
        }
        if (tl <= 0) {
          impact(s);
          shells[i] = shells[shells.length - 1];
          shells.pop();
        }
      }
      const ev = run.events;
      for (let i = ev.length - 1; i >= 0; i -= 1) {
        if (run.t < ev[i].at) continue;
        const e = ev[i];
        ev[i] = ev[ev.length - 1];
        ev.pop();
        fire(e);
      }
    },
    // раз в кадр: частицы стареют и пишутся в буфер (dt — игровое время кадра)
    frame(dt) {
      const t0 = performance.now();
      camera.getWorldPosition(head);
      const n0 = P.n;
      // ---- шаг частиц
      for (let i = P.n - 1; i >= 0; i -= 1) {
        P.age[i] += dt;
        let dead = P.age[i] >= P.life[i];
        if (!dead && P.mode[i] !== 1) {
          const dr = Math.exp(-P.drag[i] * dt);
          const ty = P.type[i];
          P.vx[i] *= dr;
          P.vy[i] = P.vy[i] * dr - 9.81 * P.grav[i] * dt;
          P.vz[i] *= dr;
          if (ty === T_SMOKE || ty === T_DUST) P.vx[i] -= 0.25 * dt; // ветер к −X
          P.x[i] += P.vx[i] * dt;
          P.y[i] += P.vy[i] * dt;
          P.z[i] += P.vz[i] * dt;
          P.rot[i] += P.spin[i] * dt;
          if ((ty === T_DEBRIS || ty === T_SPARK) && P.y[i] < P.gy[i] && P.vy[i] < 0) dead = true;
        }
        if (dead) {
          P.n -= 1;
          const j = P.n;
          for (let k = 0; k < KEYS.length; k += 1) P[KEYS[k]][i] = P[KEYS[k]][j];
        }
      }
      const sc = P.sc;
      for (let i = sc.n - 1; i >= 0; i -= 1) {
        sc.age[i] += dt;
        if (sc.age[i] < sc.life[i]) continue;
        sc.n -= 1;
        const j = sc.n;
        for (let k = 0; k < SC_KEYS.length; k += 1) sc[SC_KEYS[k]][i] = sc[SC_KEYS[k]][j];
      }
      // ---- запись экземпляров: пятна → дым/пыль/земля → огонь и свет → следы снарядов
      m = 0;
      for (let i = 0; i < sc.n; i += 1) {
        const k = sc.age[i] / sc.life[i];
        const a = Math.min(1, sc.age[i] * 3) * (1 - smooth(0.65, 1, k)) * 0.92;
        put(sc.x[i], sc.y[i], sc.z[i], sc.rot[i], sc.size[i], sc.size[i], 1, 5, 1, 1, 1, a, sc.nx[i], sc.ny[i], sc.nz[i], 0);
      }
      for (let pass = 0; pass < 2; pass += 1) {
        for (let i = 0; i < P.n; i += 1) {
          const ty = P.type[i];
          if (ADDITIVE[ty] !== pass) continue;
          const k = P.age[i] / P.life[i];
          const s0 = P.s0[i];
          const s1 = P.s1[i];
          const x = P.x[i];
          const y = P.y[i];
          const z = P.z[i];
          const rot = P.rot[i];
          const cell = P.cell[i];
          const age = P.age[i];
          switch (ty) {
            case T_SMOKE: {
              const e = 1 - (1 - k) * (1 - k);
              const s = s0 + (s1 - s0) * e;
              const t = P.tone[i];
              const lit = Math.exp(-age * 2.2) * 0.9; // снизу подсвечен огнём
              const a = P.a0[i] * Math.min(1, age * 3) * (1 - k) ** 1.3;
              put(x, y, z, rot, s, s, 0, cell + 0.05 + 0.3 * k, t + 1.3 * lit, t * 0.95 + 0.5 * lit, t * 0.9 + 0.14 * lit, a, 0, 0, 0, 0);
              break;
            }
            case T_DUST: {
              const e = 1 - (1 - k) * (1 - k);
              const s = s0 + (s1 - s0) * e;
              const t = P.tone[i];
              put(x, y, z, rot, s, s, 0, cell + 0.15 + 0.3 * k, 0.5 * t, 0.42 * t, 0.31 * t, P.a0[i] * Math.min(1, k * 12) * (1 - k) ** 1.6, 0, 0, 0, 0);
              break;
            }
            case T_DIRT: {
              const e = 1 - (1 - k) * (1 - k);
              const s = s0 + (s1 - s0) * e;
              const t = P.tone[i];
              put(x, y, z, rot, s, s, 0, cell + 0.2 + 0.4 * k, 0.2 * t, 0.15 * t, 0.1 * t, P.a0[i] * Math.min(1, k * 15) * (1 - k) ** 1.1, 0, 0, 0, 0);
              break;
            }
            case T_DEBRIS: {
              const t = P.tone[i];
              put(x, y, z, rot, s0, s0, 0, 6, 0.16 * t, 0.12 * t, 0.09 * t, Math.min(1, (1 - k) * 10), 0, 0, 0, 0);
              break;
            }
            case T_RING: {
              const e = 1 - (1 - k) ** 3;
              const s = s0 + (s1 - s0) * e;
              put(x, y, z, rot, s, s, 1, 4, 0.75, 0.66, 0.52, P.a0[i] * (1 - k) ** 1.5, P.vx[i], P.vy[i], P.vz[i], 0.25);
              break;
            }
            case T_FLASH: {
              const s = s0 + (s1 - s0) * Math.sqrt(k);
              put(x, y, z, rot, s, s, 0, 7, 4, 3.7, 3, P.a0[i] * (1 - k) * (1 - k), 0, 0, 0, 1);
              break;
            }
            case T_GLOW:
            case T_LAUNCH: {
              const s = s0 + (s1 - s0) * Math.sqrt(k);
              const t = P.tone[i] * (ty === T_GLOW ? 2.2 : 1);
              put(x, y, z, rot, s, s, 0, 2, t, 0.55 * t, 0.2 * t, P.a0[i] * (1 - k) ** 1.6, 0, 0, 0, 1);
              break;
            }
            case T_POOL: {
              const s = s0 + (s1 - s0) * k;
              put(x, y, z, rot, s, s, 1, 2, 1.4, 0.85, 0.35, P.a0[i] * (1 - k) * (1 - k), P.vx[i], P.vy[i], P.vz[i], 1);
              break;
            }
            case T_RINGFX: {
              const e = 1 - (1 - k) * (1 - k);
              const s = s0 + (s1 - s0) * e;
              put(x, y, z, rot, s, s, 0, 4, 1.2, 1.1, 0.95, P.a0[i] * (1 - k) * (1 - k), 0, 0, 0, 1);
              break;
            }
            case T_FIRE: {
              const e = 1 - (1 - k) ** 3;
              const s = s0 + (s1 - s0) * e;
              // жар: бело-жёлтый → оранжевый → тёмно-красный → дым
              let r;
              let g;
              let b;
              const hk = k * (1.25 - 0.25 * P.tone[i]);
              if (hk < 0.12) {
                const f = hk / 0.12;
                r = 3 - 0.6 * f; g = 2.6 - 1.1 * f; b = 1.9 - 1.4 * f;
              } else if (hk < 0.3) {
                const f = (hk - 0.12) / 0.18;
                r = 2.4 - 0.8 * f; g = 1.5 - 0.9 * f; b = 0.5 - 0.38 * f;
              } else if (hk < 0.5) {
                const f = (hk - 0.3) / 0.2;
                r = 1.6 - 0.9 * f; g = 0.6 - 0.42 * f; b = 0.12 - 0.07 * f;
              } else if (hk < 0.7) {
                const f = (hk - 0.5) / 0.2;
                r = 0.7 - 0.58 * f; g = 0.18 - 0.09 * f; b = 0.05 + 0.03 * f;
              } else {
                r = 0.1; g = 0.085; b = 0.075;
              }
              const addK = 1 - smooth(0.38, 0.62, k);
              const a = P.a0[i] * Math.min(1, k * 25) * (1 - smooth(0.65, 1, k));
              put(x, y, z, rot, s, s, 0, cell + 0.05 + 0.6 * smooth(0.15, 1, k), r, g, b, a, 0, 0, 0, addK);
              break;
            }
            case T_SPARK: {
              const v = Math.hypot(P.vx[i], P.vy[i], P.vz[i]);
              const len = Math.max(s0, v * 0.045);
              const h = 3 - 1.5 * k;
              put(x, y, z, 0, len, P.w[i], 2, 3, h, (0.8 - 0.45 * k) * h, (0.45 - 0.4 * k) * h, (1 - k) ** 0.7, P.vx[i], P.vy[i], P.vz[i], 1);
              break;
            }
            case T_EMBER: {
              const f = 0.6 + 0.4 * Math.sin(age * 17 + P.seed[i] * 6) * Math.sin(age * 5.3 + P.seed[i]);
              put(x, y, z, 0, s0, s0, 0, 2, 2 * f, 0.9 * f, 0.2 * f, 1 - k, 0, 0, 0, 1);
              break;
            }
            case T_CRATER: {
              const f = 0.75 + 0.25 * Math.sin(age * 9 + P.seed[i]) * Math.sin(age * 23.7 + 2 * P.seed[i]);
              put(x, y, z, rot, s0, s0, 1, 2, 1.6 * f, 0.56 * f, 0.11 * f, P.a0[i] * (1 - k) ** 1.2, P.vx[i], P.vy[i], P.vz[i], 1);
              break;
            }
            default:
              break;
          }
        }
      }
      // следы падающих снарядов (последние STREAK_S) и свист за ними
      if (run) {
        for (let i = 0; i < run.shells.length; i += 1) {
          const s = run.shells[i];
          const tl = s.impactT - run.t;
          if (s.h && tl > 0) {
            shellPos(s, tl, V);
            sound.move(s.h, V.x, V.y, V.z);
          }
          if (tl > 0 && tl < STREAK_S) {
            shellPos(s, tl, V);
            const fade = Math.min(1, (STREAK_S - tl) * 8);
            put(V.x, V.y, V.z, 0, 20, 0.7, 2, 3, 3, 2.5, 1.7, fade, s.dx * SHELL_VH, -SHELL_VV, s.dz * SHELL_VH, 1);
            put(V.x, V.y, V.z, 0, 2.2, 2.2, 0, 2, 3, 2.4, 1.4, fade, 0, 0, 0, 1);
          }
        }
      }
      geometry.instanceCount = m;
      if (m > 0) {
        for (const attr of attrs) {
          attr.clearUpdateRanges();
          attr.addUpdateRange(0, m * 4);
          attr.needsUpdate = true;
        }
      }
      // телеметрия
      maxN = Math.max(maxN, n0);
      const t1 = performance.now();
      const ms = t1 - t0;
      cpuSum += ms;
      cpuWorst = Math.max(cpuWorst, ms);
      frames += 1;
      if (t1 - since > LOG_EVERY_MS) {
        if (maxN > 0 || run?.shells.length) console.log(`[artillery] cpu=${(cpuSum / frames).toFixed(3)}/${cpuWorst.toFixed(2)}ms fx=${P.n} max=${maxN} scorch=${P.sc.n} shells=${run?.shells.length ?? 0} booms=${run?.booms ?? 0} on=${active()}`);
        cpuSum = cpuWorst = frames = maxN = 0;
        since = t1;
      }
    },
    // небольшой разрыв без урона и звука (ракета, arena-weapons.js): S — масштаб (0,3 ≈ ракета);
    // частицы рисует frame() (работает в любой сцене). true — сделан
    explode(x, y, z, S = 0.3) {
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return false;
      smallBlast(x, y, z, S);
      return true;
    },
    // ПОЛНЫЙ разрыв артиллерийского снаряда в (x, z) на земле — для любого модуля (projectiles/*):
    // огненный шар, столб дыма, воронка, пятно, «бум» (дойдёт со скоростью звука, игровое время) и
    // тряска. damage > 0 — ещё и урон по области __sceneState.areaDamage(точка, radius, damage, { credit })
    // (area-damage.js; credit 'player' — маркеры и деньги игроку, null — чужой). Работает в любой сцене
    // (вне битвы тоже). → { dogs, drones, kills } или true (без урона); false — плохие координаты
    strike(x, z, { damage = 0, radius = SPLASH_R, credit = 'player', sound: withSound = true, shake = true } = {}) {
      if (!Number.isFinite(x) || !Number.isFinite(z)) return false;
      ensureRun(); // очередь событий (звук, тряска) — в run; update() ведёт её и вне битвы
      camera.getWorldPosition(head);
      const gy = groundHeight(x, z);
      const dist = Math.hypot(x - head.x, gy - head.y, z - head.z);
      blastFx(x, gy, z, dist);
      if (withSound) queue(run.t + dist / SOUND_MPS, 'boom', x, gy + 2, z, dist);
      if (shake && dist < 170) {
        const k = Math.min(0.85, 15 / Math.max(1, dist));
        const t0 = run.t + dist / 900;
        queue(t0, 'shake', x, gy, z, k);
        queue(t0 + 0.07, 'shake', x, gy, z, k * 0.55);
        queue(t0 + 0.16, 'shake', x, gy, z, k * 0.35);
      }
      if (!(damage > 0)) return true;
      try {
        return shared.areaDamage?.(V.set(x, gy + 0.6, z), radius, damage, { credit }) ?? true;
      } catch {
        return true; // урон не важнее разрыва
      }
    },
    debug: {
      info: () => ({
        enabled, on: active(), t: run ? +run.t.toFixed(1) : null,
        next: run ? { enemy: +run.next.enemy.toFixed(1), ally: +run.next.ally.toFixed(1) } : null,
        shells: run?.shells.map((s) => ({ team: s.team, in: +(s.impactT - run.t).toFixed(1), x: +s.x.toFixed(1), z: +s.z.toFixed(1) })),
        events: run?.events.length, fx: P.n, scorch: P.sc.n, booms: run?.booms, heat: +heat.toFixed(2), sound: sound.stats(),
      }),
      // с ПК (не в шлеме!): залп сейчас. dist — м от игрока по азимуту bearing (град, 0 — «вперёд» мира −Z)
      barrage: ({ team = 'ally', n = 5, dist = 35, bearing = 0, flight = 3 } = {}) => {
        ensureRun();
        camera.getWorldPosition(head);
        const b = (bearing * Math.PI) / 180;
        return barrage(team, n, { x: head.x + Math.sin(b) * dist, z: head.z - Math.cos(b) * dist }, flight);
      },
      // разрыв сразу (без снаряда), для настройки вида
      blast: (dist = 30, bearing = 0) => {
        ensureRun();
        camera.getWorldPosition(head);
        const b = (bearing * Math.PI) / 180;
        const s = { x: head.x + Math.sin(b) * Math.max(SAFE_R, dist), z: head.z - Math.cos(b) * Math.max(SAFE_R, dist), bx: head.x, bz: head.z - BATTERY_M };
        settle(s);
        impact(s);
        return P.n;
      },
      clear: () => {
        P.n = 0;
        P.sc.n = 0;
        if (run) {
          run.shells.length = 0;
          run.events.length = 0;
        }
      },
    },
    dispose() {
      // частицы и снаряды — в __sceneState (следующая версия сцены продолжит); атлас — в кэше
      mesh.removeFromParent();
      geometry.dispose();
      material.dispose();
    },
  };
  shared.artillerySystem = api; // ручка для npm run vr:eval (artillerySystem.debug.info())
  return api;
}
