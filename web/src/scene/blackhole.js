// Чёрные дыры (оружие с projectile: 'blackhole', Космо-снайперка в generated-guns.js). Выстрел —
// маленькая летящая чёрная дыра: чёрное ядро с тёмно-фиолетовым краем, вращающийся аккреционный диск
// (горячий бело-голубой у края тени → фиолетовый → оранжевый снаружи; полосы шума крутятся тем
// быстрее, чем ближе к центру; доплер: одна сторона ярче), тонкое фотонное кольцо, линзированное
// изображение дальней стороны диска вокруг тени, мягкий ореол и тёмная дымка вокруг. Затягивает
// искры-полоски по спирали, с земли под собой — светящуюся крошку. Летит прямо (без гравитации),
// постепенно тормозит; живёт life с или до земли, потом СХЛОПЫВАЕТСЯ: сжимается и ярчает
// (COLLAPSE_SWELL_S — под обратное нарастание звука), затем вспышка, кольца, искры, всё затянутое
// отбрасывается наружу.
//
// ГРАВИТАЦИЯ в радиусе R (с зарядом 4 → 15 м): ускорение ~ 1/r (с потолком), к краю гаснет. Псы
// (robodog-horde.js, обе команды; союзники слабее): живой при сильном притяжении сбивается в куклу
// (unit.knock) и подкидывается к дыре, кукла тянется (ragdoll.push), пока дыра рядом, не встаёт
// (unit.holdDown); остальные живые (тяжёлые или сверх LIFT_MAX кукол) съезжают к ней. Трупы-куклы
// тоже тянутся. Коптеры (shared.droneTargets) сбиваются с курса и крутятся; у ядра — урон
// (shared.droneStrike / unit.strike). Мишени и летящие тарелки (Сцена 1) — тоже. Игрок и вышка не
// затрагиваются никогда (SAFE_M вокруг игрока и вышки).
//
// Заряд (main.js, gun.charge): у дула растёт маленькая дыра того же шейдера, пульсирует; полный —
// вспышка и «дзинь» (blackhole-sound.js). Сила выстрела k = 0..1: размер, радиус и сила притяжения,
// время жизни, взрыв.
//
// Отрисовка: дыры — один InstancedBufferGeometry-квадрат к голове + ShaderMaterial с
// предумноженной альфой (ядро чёрное — затемняет фон, свечение — складывается), частицы — второй
// такой же с аддитивным смешиванием: 2 вызова, пока есть что рисовать (пусто — скрыты). Шум для
// диска — одна маленькая текстура 256×64, построена один раз (__sceneState.bhNoise). Состояние —
// заранее выделенные объекты и типизированные массивы; за кадр ничего не выделяется.
// Время: всё по сценовому dt (подшаги мира), заряд у дула — по реальному (рука игрока).
import { createBlackholeSound } from './blackhole-sound.js';

const MAX_HOLES = 3; // одновременно летящих; лишний выстрел схлопывает самую старую
const SLOTS = MAX_HOLES + 1; // + заряд у дула
const CHARGE_SLOT = MAX_HOLES;
const MAX_PARTS = 700;
const LIFT_MAX = 6; // псов-кукол, поднятых дырами одновременно (кукла ~0,5 мс на Quest)
const BLAST_LIFT_MAX = 10; // при взрыве можно сбить чуть больше (на ~1 с)
const LIFT_A = 10; // м/с²: с какого притяжения (с поправкой на массу) пса отрывает от земли
const CAPTURE_A = 10; // м/с² (без поправки на массу): с такого притяжения враг «в вихре» — погибает сразу
const SWIRL_MAX = 4; // трупов, которые кувыркаются в вихре куклой (= RAGDOLL_MAX стаи); остальных волочёт
const DRAG_MAX = 6; // трупов, которых волочёт по земле, за подшаг
const AMAX = 120; // м/с²: потолок притяжения (×2 по просьбе: «гравитация сильнее»)
const SAFE_M = 6; // м вокруг игрока (и вышки) — ничего не тянет и не ранит
const DRAG = 0.15; // 1/с: дыра чуть тормозит (по просьбе: летит дальше и быстрее — ~200–260 м за жизнь)
const HIT_GAP_S = 0.3; // урон у ядра — не чаще
const NOISE_KEY = 'bh-noise-1';

// параметры дыры от заряда k (0..1)
const sizeOf = (k) => 0.36 + 0.7 * k; // полуразмер квадрата, м (диск ≈ 0,9 от него, тень 0,2)
const pullR = (k) => 4 + 15.5 * k; // полный заряд — 19,5 м (+30 %)
const pullA = (k) => 36 + 44 * k; // ×2
const lifeOf = (k) => 2.8 + 1.7 * k;
const speedOf = (k) => 92 - 12 * k; // ×2: 92 → 80 м/с
const coreOf = (k) => 0.9 + 1.6 * k; // м: в этом радиусе — урон
const blastROf = (k) => 3 + 9 * k;

const holeVertex = /* glsl */ `
  attribute vec4 hPos;  // xyz — центр, w — полуразмер квадрата (м)
  attribute vec4 hPar;  // x — возраст (с), y — яркость, z — схлопывание 0..1, w — зерно
  uniform vec3 uCam;
  varying vec2 vP;
  varying vec4 vPar;
  varying float vIncl;
  void main() {
    vec3 c = hPos.xyz;
    vec3 toCam = uCam - c;
    float d = length(toCam);
    toCam = d > 1e-4 ? toCam / d : vec3(0.0, 0.0, 1.0);
    // квадрат повёрнут к голове (не к каждому глазу): оба глаза видят одну плоскость
    vec3 right = cross(vec3(0.0, 1.0, 0.0), toCam);
    float rl = length(right);
    right = rl > 1e-3 ? right / rl : vec3(1.0, 0.0, 0.0);
    vec3 up = cross(toCam, right);
    vec3 wp = c + (right * position.x + up * position.y) * hPos.w;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(wp, 1.0);
    vP = position.xy;
    vPar = hPar;
    vIncl = toCam.y; // > 0 — смотрим сверху
  }
`;

const holeFragment = /* glsl */ `
  uniform sampler2D uNoise;
  varying vec2 vP;
  varying vec4 vPar;
  varying float vIncl;
  #define PI 3.14159265
  const float RS = 0.2;   // радиус тени (ядра)
  const float RIN = 0.27; // внутренний край диска
  const float ROUT = 0.9; // внешний
  vec3 heat(float t) {
    vec3 c0 = vec3(1.25, 1.4, 2.0);   // бело-голубой, горячий
    vec3 c1 = vec3(0.45, 0.38, 1.5);  // сине-фиолетовый
    vec3 c2 = vec3(0.85, 0.15, 0.95); // пурпур
    vec3 c3 = vec3(1.3, 0.5, 0.08);   // оранжевый, холодный край
    if (t < 0.15) return mix(c0, c1, t / 0.15);
    if (t < 0.45) return mix(c1, c2, (t - 0.15) / 0.3);
    return mix(c2, c3, min(1.0, (t - 0.45) / 0.35));
  }
  // свечение диска на радиусе r и угле a: полосы шума вращаются, у центра быстрее (∝ r^-1.5)
  vec3 disc(float r, float a, float age, float seed) {
    float t = (r - RIN) / (ROUT - RIN);
    if (t <= 0.0 || t >= 1.0) return vec3(0.0);
    float w = pow(RIN / r, 1.5);
    float u = a / (2.0 * PI);
    float n1 = texture2D(uNoise, vec2(u * 2.0 - age * w * 0.9 + seed, t * 0.8 + seed * 0.3)).r;
    float n2 = texture2D(uNoise, vec2(u * 5.0 - age * w * 1.7 - seed, t * 1.9 + 0.31)).g;
    float bands = 0.12 + 2.2 * n1 * n1 * (0.45 + 0.9 * n2);
    float prof = smoothstep(0.0, 0.05, t) * pow(1.0 - t, 1.4) * (1.0 + 1.2 * exp(-t * 9.0));
    return heat(t) * bands * prof;
  }
  void main() {
    vec2 p = vP;
    float rho = length(p);
    if (rho >= 1.0) discard;
    float age = vPar.x;
    float seed = vPar.w;
    float s = max(0.14, abs(vIncl));          // сбоку диск тонкий, сверху — круглый
    float side = vIncl >= 0.0 ? 1.0 : -1.0;   // сверху: ближний край диска — внизу
    // прямое изображение наклонного диска
    vec2 dq = vec2(p.x, p.y / s);
    float rd = length(dq);
    vec3 direct = disc(rd, atan(dq.y * side, dq.x), age, seed);
    // доплер: приближающаяся сторона (слева) ярче, удаляющаяся — тусклее
    float dop = 1.0 + 0.7 * sqrt(1.0 - s * s) * clamp(-p.x / max(rd, 1e-3), -1.0, 1.0);
    direct *= dop * dop * (1.0 + 0.8 * (1.0 - s));
    bool nearHalf = p.y * side < 0.0;
    // линзированное изображение: дальняя сторона диска обнимает тень сверху и снизу
    vec3 lensed = rho > RS ? disc(RIN + (rho - RS * 1.02) * 1.9, atan(p.y, p.x) + 1.3, age * 1.1, seed + 0.5) * (0.35 + 0.55 * (1.0 - s)) : vec3(0.0);
    // фотонное кольцо — тонкая яркая окружность у края тени
    float pr = (rho - RS * 1.07) / 0.014;
    vec3 ring = vec3(1.1, 0.95, 1.8) * exp(-pr * pr) * (1.0 + 0.4 * sin(age * 7.0 + seed * 20.0)) * (0.8 + 0.4 * dop);
    // мягкий ореол
    vec3 halo = vec3(0.35, 0.12, 0.75) * (exp(-rho * rho * 7.0) * 0.55 + exp(-rho * 3.2) * 0.12);
    // ядро: чёрное, у края — тёмно-фиолетовый «френель»
    float core = 1.0 - smoothstep(RS * 0.95, RS, rho);
    float rim = pow(smoothstep(RS * 0.55, RS, rho), 4.0) * core;
    vec3 back = lensed + ring + halo + (nearHalf ? vec3(0.0) : direct);
    vec3 front = nearHalf ? direct : vec3(0.0);
    vec3 col = back * (1.0 - core) + vec3(0.25, 0.08, 0.55) * rim * 0.6 + front;
    // тёмная дымка вокруг (свет из-за дыры отклонён) — затемняет фон
    float dark = 0.4 * (1.0 - smoothstep(RS, 0.75, rho)) * (1.0 - core);
    float edge = 1.0 - smoothstep(0.8, 1.0, rho);
    col *= 0.8 * vPar.y * edge * (1.0 + 2.5 * vPar.z);
    float alpha = max(core, dark) * edge * clamp(vPar.y, 0.0, 1.0);
    gl_FragColor = vec4(col, alpha); // предумноженная альфа: ядро закрывает фон, свет складывается
    #include <colorspace_fragment>
  }
`;

const partVertex = /* glsl */ `
  attribute vec4 iPos;  // xyz — центр, w — полуширина (м)
  attribute vec4 iCol;  // rgb — цвет (линейный), a — яркость
  attribute vec4 iVel;  // xyz — направление полоски (мир), w — полудлина (м)
  attribute float iKind; // 0 свечение, 1 кольцо, 2 искра-звёздочка, 3 полоска по скорости
  varying vec2 vUv;
  varying vec4 vCol;
  varying float vKind;
  void main() {
    vec4 mv = modelViewMatrix * vec4(iPos.xyz, 1.0);
    vec2 p = position.xy;
    if (iKind > 2.5) {
      vec3 vv = (modelViewMatrix * vec4(iVel.xyz, 0.0)).xyz;
      vec2 ax = length(vv.xy) > 1e-5 ? normalize(vv.xy) : vec2(1.0, 0.0);
      vec2 ay = vec2(-ax.y, ax.x);
      mv.xy += ax * p.x * max(iVel.w, iPos.w) + ay * p.y * iPos.w;
    } else mv.xy += p * iPos.w;
    gl_Position = projectionMatrix * mv;
    vUv = p;
    vCol = iCol;
    vKind = iKind;
  }
`;

const partFragment = /* glsl */ `
  varying vec2 vUv;
  varying vec4 vCol;
  varying float vKind;
  void main() {
    float r = length(vUv);
    float edge = max(0.0, 1.0 - r);
    vec3 c = vCol.rgb;
    vec3 col;
    if (vKind < 0.5) {
      col = (c * exp(-r * r * 3.0) + mix(c, vec3(1.0), 0.6) * exp(-r * r * 14.0)) * edge;
    } else if (vKind < 1.5) {
      float d = (r - 0.82) / 0.07;
      col = (c * 1.1 + vec3(0.1)) * exp(-d * d) * edge * 3.5;
    } else if (vKind < 2.5) {
      vec2 q = abs(vUv);
      float star = exp(-q.x * 14.0) * exp(-q.y * 2.2) + exp(-q.y * 14.0) * exp(-q.x * 2.2);
      col = mix(c, vec3(1.0), 0.5) * (star + exp(-r * r * 22.0)) * edge;
    } else {
      float y = vUv.y;
      col = mix(c, vec3(1.0), 0.35) * exp(-y * y * 5.0) * (1.0 - vUv.x * vUv.x) * (0.6 + 0.4 * (1.0 - vUv.x));
    }
    gl_FragColor = vec4(col * vCol.a, 1.0);
    #include <colorspace_fragment>
  }
`;

// ---- Заряд у дула (по просьбе пользователя): диск и кольца — В ПЛОСКОСТИ ⟂ СТВОЛУ (кольцо вокруг
// дула), а не квадрат к камере; в центре — чёрная сфера-ядро с фиолетовым френелем. Диск — квадрат в
// своей плоскости (поворот = поворот оружия: плоскость XY оружия ⟂ стволу −Z), те же функции heat/disc,
// что у летящей дыры (вырезаны из holeFragment — один источник), аддитивно, с обеих сторон.
const DISC_GLSL = holeFragment.slice(holeFragment.indexOf('  #define PI'), holeFragment.indexOf('  void main()'));
const chargeDiscVertex = /* glsl */ `
  varying vec2 vP;
  void main() {
    vP = position.xy;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const chargeDiscFragment = /* glsl */ `
  uniform sampler2D uNoise;
  uniform vec3 uPar; // x — время (с), y — яркость, z — зерно
  varying vec2 vP;
  ${DISC_GLSL}
  void main() {
    float rho = length(vP);
    if (rho >= 1.0) discard;
    float age = uPar.x;
    vec3 d = disc(rho, atan(vP.y, vP.x), age, uPar.z);
    // доплер по кругу: яркая сторона бежит вместе с вращением
    d *= 1.0 + 0.5 * sin(atan(vP.y, vP.x) - age * 3.0);
    float pr = (rho - RS * 1.12) / 0.018;
    vec3 ring = vec3(1.1, 0.95, 1.8) * exp(-pr * pr) * (1.1 + 0.4 * sin(age * 9.0 + uPar.z * 20.0));
    vec3 halo = vec3(0.35, 0.12, 0.75) * exp(-rho * rho * 6.0) * 0.45 * smoothstep(RS * 0.9, RS * 1.2, rho);
    float edge = 1.0 - smoothstep(0.8, 1.0, rho);
    gl_FragColor = vec4((d * 1.3 + ring + halo) * uPar.y * edge, 1.0);
    #include <colorspace_fragment>
  }
`;
const coreVertex = /* glsl */ `
  varying vec3 vN;
  varying vec3 vV;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vN = normalize(normalMatrix * normal);
    vV = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
  }
`;
const coreFragment = /* glsl */ `
  uniform float uInten;
  varying vec3 vN;
  varying vec3 vV;
  void main() {
    float f = 1.0 - abs(dot(normalize(vN), normalize(vV)));
    gl_FragColor = vec4(vec3(0.3, 0.08, 0.7) * pow(f, 3.0) * uInten, 1.0); // чёрная, край светится
    #include <colorspace_fragment>
  }
`;

// Шум для диска: 256 (угол, по кругу) × 64 (радиус), два канала: R — вытянутые по кругу полосы,
// G — пятна. Периодичен по обеим осям (RepeatWrapping без шва). Строится раз на страницу.
const buildNoise = (THREE) => {
  const W = 256;
  const H = 64;
  const data = new Uint8Array(W * H * 4);
  const fbm = (octaves) => {
    const out = new Float32Array(W * H);
    for (const [gx, gy, amp] of octaves) {
      const g = new Float32Array(gx * gy);
      for (let i = 0; i < g.length; i += 1) g[i] = Math.random();
      for (let y = 0; y < H; y += 1) {
        const fy = (y / H) * gy;
        const iy = Math.floor(fy);
        let ty = fy - iy;
        ty = ty * ty * (3 - 2 * ty);
        const y0 = iy % gy;
        const y1 = (iy + 1) % gy;
        for (let x = 0; x < W; x += 1) {
          const fx = (x / W) * gx;
          const ix = Math.floor(fx);
          let tx = fx - ix;
          tx = tx * tx * (3 - 2 * tx);
          const x0 = ix % gx;
          const x1 = (ix + 1) % gx;
          const a = g[y0 * gx + x0] + (g[y0 * gx + x1] - g[y0 * gx + x0]) * tx;
          const b = g[y1 * gx + x0] + (g[y1 * gx + x1] - g[y1 * gx + x0]) * tx;
          out[y * W + x] += amp * (a + (b - a) * ty);
        }
      }
    }
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < out.length; i += 1) {
      lo = Math.min(lo, out[i]);
      hi = Math.max(hi, out[i]);
    }
    for (let i = 0; i < out.length; i += 1) out[i] = (out[i] - lo) / (hi - lo || 1);
    return out;
  };
  const r = fbm([[4, 8, 0.5], [8, 16, 0.25], [16, 32, 0.15], [32, 64, 0.1]]);
  const g = fbm([[6, 4, 0.5], [12, 8, 0.25], [24, 16, 0.15], [48, 32, 0.1]]);
  for (let i = 0; i < W * H; i += 1) {
    data[i * 4] = Math.round(r[i] * 255);
    data[i * 4 + 1] = Math.round(g[i] * 255);
    data[i * 4 + 2] = 0;
    data[i * 4 + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
};

const quadGeometry = (THREE) => {
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
  return geometry;
};
const dynAttr = (THREE, geometry, name, arr, size) => {
  const attr = new THREE.InstancedBufferAttribute(arr, size).setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute(name, attr);
  return attr;
};
const flush = (attrs, n) => {
  for (const attr of attrs) {
    attr.clearUpdateRanges();
    attr.addUpdateRange(0, Math.max(1, n) * attr.itemSize);
    attr.needsUpdate = true;
  }
};

export function createBlackhole({ THREE, group, camera, groundAt, plates = null, knockPlate = null }) {
  const shared = (globalThis.__sceneState ??= {});
  const sound = createBlackholeSound(shared);
  sound.silence?.();
  if (shared.bhNoise?.key !== NOISE_KEY) shared.bhNoise = { key: NOISE_KEY, tex: buildNoise(THREE) };

  // ---- меш дыр
  const holeGeo = quadGeometry(THREE);
  const hPosArr = new Float32Array(SLOTS * 4);
  const hParArr = new Float32Array(SLOTS * 4);
  const holeAttrs = [dynAttr(THREE, holeGeo, 'hPos', hPosArr, 4), dynAttr(THREE, holeGeo, 'hPar', hParArr, 4)];
  holeGeo.instanceCount = 0;
  const camUniform = { value: new THREE.Vector3() };
  const holeMat = new THREE.ShaderMaterial({
    vertexShader: holeVertex,
    fragmentShader: holeFragment,
    uniforms: { uNoise: { value: shared.bhNoise.tex }, uCam: camUniform },
    transparent: true,
    premultipliedAlpha: true,
    depthWrite: false,
    toneMapped: false,
  });
  const holeMesh = new THREE.Mesh(holeGeo, holeMat);
  holeMesh.name = 'blackholes';
  holeMesh.frustumCulled = false;
  holeMesh.renderOrder = 4; // после частиц: ядро закрывает то, что за ним
  group.add(holeMesh);

  // ---- меш частиц
  const partGeo = quadGeometry(THREE);
  const iPosArr = new Float32Array(MAX_PARTS * 4);
  const iColArr = new Float32Array(MAX_PARTS * 4);
  const iVelArr = new Float32Array(MAX_PARTS * 4);
  const iKindArr = new Float32Array(MAX_PARTS);
  const partAttrs = [dynAttr(THREE, partGeo, 'iPos', iPosArr, 4), dynAttr(THREE, partGeo, 'iCol', iColArr, 4), dynAttr(THREE, partGeo, 'iVel', iVelArr, 4), dynAttr(THREE, partGeo, 'iKind', iKindArr, 1)];
  partGeo.instanceCount = 0;
  const partMat = new THREE.ShaderMaterial({
    vertexShader: partVertex,
    fragmentShader: partFragment,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  });
  const partMesh = new THREE.Mesh(partGeo, partMat);
  partMesh.name = 'blackhole-parts';
  partMesh.frustumCulled = false;
  partMesh.renderOrder = 3;
  group.add(partMesh);
  let warmFrames = 0;

  // ---- заряд у дула: диск ⟂ стволу + сфера-ядро (2 вызова, только пока заряжается)
  const chargePar = { value: new THREE.Vector3(0, 1, 0) };
  const chargeDiscMat = new THREE.ShaderMaterial({
    vertexShader: chargeDiscVertex,
    fragmentShader: chargeDiscFragment,
    uniforms: { uNoise: { value: shared.bhNoise.tex }, uPar: chargePar },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    forceSinglePass: true,
    toneMapped: false,
  });
  const chargeDisc = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), chargeDiscMat);
  chargeDisc.name = 'blackhole-charge-disc';
  chargeDisc.frustumCulled = false;
  chargeDisc.renderOrder = 4;
  chargeDisc.scale.setScalar(0.001);
  group.add(chargeDisc);
  const coreInten = { value: 1 };
  const chargeCore = new THREE.Mesh(
    new THREE.SphereGeometry(1, 24, 16),
    new THREE.ShaderMaterial({ vertexShader: coreVertex, fragmentShader: coreFragment, uniforms: { uInten: coreInten }, toneMapped: false }),
  );
  chargeCore.name = 'blackhole-charge-core';
  chargeCore.frustumCulled = false;
  chargeCore.scale.setScalar(0.001);
  group.add(chargeCore);

  // ---- дыры (слоты 0..MAX_HOLES-1 — летящие, CHARGE_SLOT — заряд у дула)
  const holes = [];
  for (let i = 0; i < SLOTS; i += 1) {
    holes.push({
      active: false, collapsing: false, k: 0, pos: new THREE.Vector3(), vel: new THREE.Vector3(), age: 0, life: 3, cT: 0, cDur: 0.5,
      R: 4, A: 18, size: 0.4, core: 1, seed: 0, emit: 0, dust: 0, born: 0, onResult: null, plateHit: new Uint8Array(64), boost: 1,
      // плоскость вращения искр: bu, bv — в плоскости диска, bn — ось (летящая — горизонт; заряд — ⟂ стволу)
      bu: new THREE.Vector3(1, 0, 0), bv: new THREE.Vector3(0, 0, 1), bn: new THREE.Vector3(0, 1, 0),
    });
  }
  let bornCounter = 0;
  const charge = holes[CHARGE_SLOT];
  let chargeItem = null; // оружие в руке, у дула которого растёт заряд (null — не заряжается)
  let chargeLevel = 0;
  let chargeFull = false;
  let chargeRealT = 0;
  const chargeMuzzle = new THREE.Vector3();
  const chargeDir = new THREE.Vector3();
  const chargeSpin = new THREE.Quaternion();
  const zAxis = new THREE.Vector3(0, 0, 1);

  // ---- частицы (SoA). rel — координаты относительно дыры слота hole (кружатся вокруг неё);
  // pull — мировая частица, которую тянет дыра слота hole (крошка с земли)
  const px = new Float32Array(MAX_PARTS), py = new Float32Array(MAX_PARTS), pz = new Float32Array(MAX_PARTS);
  const vx = new Float32Array(MAX_PARTS), vy = new Float32Array(MAX_PARTS), vz = new Float32Array(MAX_PARTS);
  const pAge = new Float32Array(MAX_PARTS), pLife = new Float32Array(MAX_PARTS);
  const s0 = new Float32Array(MAX_PARTS), s1 = new Float32Array(MAX_PARTS), pKind = new Uint8Array(MAX_PARTS);
  const pr = new Float32Array(MAX_PARTS), pg = new Float32Array(MAX_PARTS), pb = new Float32Array(MAX_PARTS), pA = new Float32Array(MAX_PARTS);
  const pDrag = new Float32Array(MAX_PARTS), pGrav = new Float32Array(MAX_PARTS), pLen = new Float32Array(MAX_PARTS);
  const pHole = new Int8Array(MAX_PARTS), pMode = new Uint8Array(MAX_PARTS); // 0 — свободная, 1 — rel, 2 — pull
  let parts = 0;
  const copyPart = (i, j) => {
    px[i] = px[j]; py[i] = py[j]; pz[i] = pz[j];
    vx[i] = vx[j]; vy[i] = vy[j]; vz[i] = vz[j];
    pAge[i] = pAge[j]; pLife[i] = pLife[j]; s0[i] = s0[j]; s1[i] = s1[j]; pKind[i] = pKind[j];
    pr[i] = pr[j]; pg[i] = pg[j]; pb[i] = pb[j]; pA[i] = pA[j];
    pDrag[i] = pDrag[j]; pGrav[i] = pGrav[j]; pLen[i] = pLen[j]; pHole[i] = pHole[j]; pMode[i] = pMode[j];
  };
  const rand = (a, b) => a + Math.random() * (b - a);
  const part = (x, y, z, kind, life, size0, size1, r, g, b, a = 1) => {
    let i;
    if (parts < MAX_PARTS) i = parts++;
    else {
      i = 0;
      for (let k = 1; k < MAX_PARTS; k += 1) if (pAge[k] / pLife[k] > pAge[i] / pLife[i]) i = k;
    }
    px[i] = x; py[i] = y; pz[i] = z;
    vx[i] = 0; vy[i] = 0; vz[i] = 0;
    pAge[i] = 0; pLife[i] = life; s0[i] = size0; s1[i] = size1; pKind[i] = kind;
    pr[i] = r; pg[i] = g; pb[i] = b; pA[i] = a;
    pDrag[i] = 0; pGrav[i] = 0; pLen[i] = 0; pHole[i] = -1; pMode[i] = 0;
    return i;
  };
  // искра от (x, y, z) по направлению (nx, ny, nz) с разбросом spread, скорость speed
  const spark = (x, y, z, nx, ny, nz, spread, speed, life, size, r, g, b, streak = false) => {
    const i = part(x, y, z, streak ? 3 : 2, life, size, size * 0.3, r, g, b, 1);
    let ax = nx + rand(-spread, spread);
    let ay = ny + rand(-spread, spread);
    let az = nz + rand(-spread, spread);
    const n = Math.hypot(ax, ay, az) || 1;
    ax /= n; ay /= n; az /= n;
    vx[i] = ax * speed; vy[i] = ay * speed; vz[i] = az * speed;
    pDrag[i] = 2.2;
    pGrav[i] = 2;
    if (streak) pLen[i] = 0.025;
    return i;
  };

  // искра-полоска на орбите вокруг дыры h (относительные координаты): по спирали падает в ядро
  const infall = (h, slot) => {
    const rr = h.size * rand(1.1, 2.6);
    const a = Math.random() * Math.PI * 2;
    const y = rand(-0.35, 0.35) * rr * 0.45;
    const { bu, bv, bn } = h;
    const c = Math.cos(a);
    const s = Math.sin(a);
    // в плоскости диска (bu, bv), y — вдоль оси bn
    const i = part((c * bu.x + s * bv.x) * rr + bn.x * y, (c * bu.y + s * bv.y) * rr + bn.y * y, (c * bu.z + s * bv.z) * rr + bn.z * y, 3, rand(0.6, 1.4), rand(0.006, 0.014) * (0.6 + h.size), 0.003, 0, 0, 0, 1);
    // цвет: горячий фиолетово-голубой или оранжевый
    if (Math.random() < 0.6) { pr[i] = 0.55; pg[i] = 0.45; pb[i] = 1.6; } else { pr[i] = 1.2; pg[i] = 0.45; pb[i] = 0.1; }
    const vOrb = Math.sqrt(GM(h) / rr) * rand(0.55, 0.8);
    // вращение по кругу в плоскости диска, плюс немного внутрь и к плоскости
    const tu = -s * vOrb - c * vOrb * 0.15;
    const tv = c * vOrb - s * vOrb * 0.15;
    vx[i] = tu * bu.x + tv * bv.x - bn.x * y * 0.5;
    vy[i] = tu * bu.y + tv * bv.y - bn.y * y * 0.5;
    vz[i] = tu * bu.z + tv * bv.z - bn.z * y * 0.5;
    pLen[i] = 0.02 + 0.03 * h.size;
    pMode[i] = 1;
    pHole[i] = slot;
  };
  const GM = (h) => 40 * h.size * h.size * h.size; // «масса» дыры для частиц: орбита у края диска ~6·size м/с

  // ---- взаимодействие с миром
  const head = new THREE.Vector3();
  const towerXZ = { x: 0, z: 0, on: false };
  const safe = (x, z) => {
    const dx = x - head.x;
    const dz = z - head.z;
    if (dx * dx + dz * dz < SAFE_M * SAFE_M) return true;
    if (towerXZ.on) {
      const tx = x - towerXZ.x;
      const tz = z - towerXZ.z;
      if (tx * tx + tz * tz < SAFE_M * SAFE_M) return true;
    }
    return false;
  };
  // притяжение дыры h на расстоянии r, м/с² (до поправки на массу)
  const accelAt = (h, r) => {
    if (r >= h.R) return 0;
    const q = r / h.R;
    return Math.min(AMAX, (h.A * h.R * 0.3) / Math.max(r, 1)) * (1 - q * q * q * q) * h.boost;
  };
  const tmp = new THREE.Vector3();
  const tmp2 = new THREE.Vector3();
  let lifted = 0; // псов-кукол, поднятых дырами (считается каждый шаг)
  let swirled = 0; // трупов, крутящихся в вихрях в этом подшаге
  let dragged = 0;
  let killed = 0;
  const KILL_PER_STEP = 3;
  const enrageDog = (u) => {
    const dog = u.dog;
    if (dog.team !== 'ally' && !dog.angry) {
      dog.angry = true;
      u.setAngry?.(true);
    }
  };
  // скорость куклы (по первой частице корпуса), м/с — в tmp2
  const ragVel = (u) => {
    const p = u.ragdoll.pos;
    const q = u.ragdoll.prev;
    return tmp2.set(p[0] - q[0], p[1] - q[1], p[2] - q[2]).multiplyScalar(120);
  };

  const pullDogs = (h, dt, nowS) => {
    const units = shared.horde?.debug?.units?.();
    if (!units) return;
    for (let i = 0; i < units.length; i += 1) {
      const u = units[i];
      if (u.mode === 'off') continue;
      const c = u.bodyCenter;
      const S = u.scale;
      const dx = h.pos.x - c.x;
      const dy = h.pos.y - c.y;
      const dz = h.pos.z - c.z;
      const r = Math.hypot(dx, dy, dz);
      if (r > h.R + 0.5 * S || r < 1e-4) continue;
      if (safe(c.x, c.z)) continue;
      const ally = u.dog.team === 'ally';
      const m = (S === 1 ? 1 : S ** -0.6) * (ally ? 0.6 : 1); // тяжёлые и свои — слабее
      const aRaw = accelAt(h, Math.max(0, r - 0.3 * S));
      const a = aRaw * m;
      const ux = dx / r;
      const uy = dy / r;
      const uz = dz / r;
      const dog = u.dog;
      // ЗАХВАТ ВИХРЕМ (по просьбе: «всё, что попало, — насмерть»): враг любого размера — сразу, свой —
      // только у ядра. strike(…, огромный урон) → kill: кукла, искры, дуги, «выключение»; подкинуть к дыре
      const inCore = r < h.core + 0.45 * S;
      if ((u.mode === 'alive' || u.knocked) && !u.emerging && (inCore || (!ally && aRaw > CAPTURE_A))) {
        if (killed >= KILL_PER_STEP) continue; // смерть (искры, звук, кукла) дорогая — не больше 3 за подшаг
        killed += 1;
        tmp.set(ux, Math.max(0.3, uy), uz).normalize();
        if (u.strike(tmp2.copy(c), tmp, 1e4) === 'kill') {
          dog.bhSwirl = true;
          const toss = Math.min(1.6, a / 25);
          u.ragdoll.push(ux * 6 * toss, (4 + 4 * h.k) * toss + Math.max(0, uy) * 4, uz * 6 * toss);
        }
        continue;
      }
      if (a <= 0) continue;
      if (u.mode === 'alive' || u.mode === 'getup') {
        if (u.emerging) continue;
        if (a > LIFT_A && lifted < LIFT_MAX) {
          // оторвало от земли: кукла, подкинуть к дыре
          enrageDog(u);
          tmp.set(ux, Math.max(0.3, uy), uz).normalize();
          u.knock(tmp, 0.3);
          const toss = Math.min(1.6, a / 25);
          u.ragdoll.push(ux * 6 * toss, (4 + 4 * h.k) * toss + Math.max(0, uy) * 4, uz * 6 * toss);
          dog.bhLift = true;
          lifted += 1;
        } else if (u.mode === 'alive') {
          // тяжёлый (или кукол уже много): скользит к дыре, шатается
          const v = Math.min(4, a * 0.25) * dt;
          const hl = Math.hypot(ux, uz) || 1;
          dog.x += (ux / hl) * v;
          dog.z += (uz / hl) * v;
          if (Math.random() < dt * 3) u.stagger(tmp.set(ux, 0, uz));
        }
        continue;
      }
      const corpse = u.mode === 'dying' || u.mode === 'dead';
      if (corpse && aRaw <= CAPTURE_A * 0.5) continue; // трупы — только в самом вихре
      if (corpse && swirled >= SWIRL_MAX) {
        // кукол сверх бюджета не считаем: труп лежит и его волочёт по земле к дыре
        if (dragged >= DRAG_MAX) continue;
        dragged += 1;
        const v = Math.min(6, a * 0.3) * dt;
        const hl = Math.hypot(ux, uz) || 1;
        const sx = (ux / hl) * v;
        const sz = (uz / hl) * v;
        const p = u.ragdoll.pos;
        const q = u.ragdoll.prev;
        for (let j = 0; j < p.length; j += 3) {
          p[j] += sx; p[j + 2] += sz; q[j] += sx; q[j + 2] += sz;
        }
        u.settle();
        continue;
      }
      if (u.mode === 'down' || corpse) {
        if (u.mode === 'down') u.holdDown?.();
        let sw = 0.4 * a;
        if (corpse) {
          // труп в вихре: бьётся в «агонии» (искры, дуги — режим dying держится, пока он в вихре), крутится
          // по орбите и кувыркается (случайные толчки частиц)
          swirled += 1;
          dog.bhSwirl = true;
          if (u.mode === 'dying') u.deadFor = Math.min(u.deadFor, 0.4);
          sw = 0.9 * a;
          const kick = (3 + 6 * h.k) * Math.min(1, a / 20);
          for (let n = 0; n < 2; n += 1) u.ragdoll.nudge(Math.floor(Math.random() * u.ragdoll.count), (Math.random() - 0.5) * kick, (Math.random() - 0.5) * kick, (Math.random() - 0.5) * kick);
        }
        // тянет к дыре и закручивает вокруг вертикали; у ядра скорость подтягивается к скорости дыры
        // (затянутых несёт с собой, а не пролетает насквозь)
        let ax = ux * a - uz * sw;
        let ay = uy * a;
        let az = uz * a + ux * sw;
        if (r < h.core * 1.6) {
          const v = ragVel(u);
          const k = Math.min(1, 4 * dt) / dt;
          ax += (h.vel.x - v.x) * k * 0.5;
          ay += (h.vel.y - v.y) * k * 0.5;
          az += (h.vel.z - v.z) * k * 0.5;
        }
        u.ragdoll.push(ax * dt, ay * dt, az * dt);
      }
    }
  };

  const pullDrones = (h, dt, nowS) => {
    const list = shared.droneTargets;
    if (!list) return;
    for (let i = 0; i < list.length; i += 1) {
      const d = list[i];
      if (d.state !== 'alive' && d.state !== 'dying') continue;
      const dx = h.pos.x - d.x;
      const dy = h.pos.y - d.y;
      const dz = h.pos.z - d.z;
      const r = Math.hypot(dx, dy, dz);
      if (r > h.R + d.span || r < 1e-4 || safe(d.x, d.z)) continue;
      const ally = d.team === 'ally';
      const m = (1 / Math.sqrt(Math.max(0.4, d.span))) * (ally ? 0.6 : 1);
      const aRaw = accelAt(h, Math.max(0, r - 0.5 * d.span));
      const a = aRaw * m;
      const ux = dx / r;
      const uy = dy / r;
      const uz = dz / r;
      const sw = d.state === 'dying' ? 1 : 0.5; // подбитый — крутится по орбите сильнее
      d.vx += (ux * a - uz * sw * a) * dt;
      d.vy += uy * a * dt;
      d.vz += (uz * a + ux * sw * a) * dt;
      d.yaw += Math.min(d.state === 'dying' ? 30 : 12, a * 0.25) * dt; // закручивает
      if (d.state === 'alive') d.angry = d.angry || !ally;
      // захват вихрем: враг — сразу в клочья (свой — только у ядра): искры, штопор, падает горящим
      const inCore = r < h.core + 0.5 * d.span;
      if (d.state === 'alive' && (inCore || (!ally && aRaw > CAPTURE_A))) {
        tmp.set(-ux, -uy, -uz);
        if (shared.droneStrike?.(d, tmp2.set(d.x, d.y, d.z), tmp, 1e4) === 'kill') d.spinRate = (Math.random() < 0.5 ? -1 : 1) * (14 + 10 * Math.random());
      }
      void nowS;
    }
  };

  const pullProps = (h, dt) => {
    // мишени (Сцена 1): каждую — один раз за жизнь дыры, к ней
    const list = plates?.();
    if (list && knockPlate) {
      for (let i = 0; i < list.length && i < 64; i += 1) {
        if (h.plateHit[i]) continue;
        tmp.setFromMatrixPosition(list[i].matrixWorld);
        const r = tmp.distanceTo(h.pos);
        if (r > h.R * 0.7 || safe(tmp.x, tmp.z)) continue;
        h.plateHit[i] = 1;
        tmp2.subVectors(h.pos, tmp).normalize();
        knockPlate(list[i], tmp, tmp2);
      }
    }
    // летящие тарелки
    const clays = shared.clays;
    if (Array.isArray(clays)) {
      for (let i = 0; i < clays.length; i += 1) {
        const c = clays[i];
        if (c.state !== 'fly' || !c.v) continue;
        const dx = h.pos.x - c.p.x;
        const dy = h.pos.y - c.p.y;
        const dz = h.pos.z - c.p.z;
        const r = Math.hypot(dx, dy, dz);
        if (r > h.R || r < 1e-4 || safe(c.p.x, c.p.z)) continue;
        const a = accelAt(h, r) * dt;
        c.v.x += (dx / r) * a;
        c.v.y += (dy / r) * a;
        c.v.z += (dz / r) * a;
      }
    }
  };

  // ---- взрыв в конце схлопывания
  const blast = (h, nowS) => {
    const p = h.pos;
    const k = h.k;
    const BR = blastROf(k);
    // вид: вспышка, два кольца, искры во все стороны, затянутое — наружу
    part(p.x, p.y, p.z, 0, 0.28, h.size * 1.4, h.size * 4.5, 1.2, 0.9, 2.2, 2.2);
    part(p.x, p.y, p.z, 0, 0.7, h.size * 2, h.size * 6, 0.55, 0.15, 1.1, 1.1);
    part(p.x, p.y, p.z, 1, 0.45, h.size * 0.5, BR * 0.55, 0.8, 0.55, 1.8, 1.4);
    part(p.x, p.y, p.z, 1, 0.75, h.size * 0.3, BR * 0.9, 1.1, 0.45, 0.12, 0.9);
    const n = Math.round(50 + 70 * k);
    for (let i = 0; i < n; i += 1) {
      const hot = Math.random() < 0.5;
      spark(p.x, p.y, p.z, 0, 0.15, 0, 1, rand(6, 18 + 12 * k), rand(0.4, 1.1), rand(0.02, 0.05) * (1 + k), hot ? 0.7 : 1.3, hot ? 0.55 : 0.45, hot ? 1.8 : 0.12, true);
    }
    const slot = holes.indexOf(h);
    for (let i = 0; i < parts; i += 1) {
      if (pHole[i] !== slot) continue;
      if (pMode[i] === 1) {
        // относительную — в мир, с разлётом наружу
        const ox = px[i];
        const oy = py[i];
        const oz = pz[i];
        const r = Math.hypot(ox, oy, oz) || 1;
        px[i] = p.x + ox;
        py[i] = p.y + oy;
        pz[i] = p.z + oz;
        const sp = rand(5, 14);
        vx[i] = (ox / r) * sp; vy[i] = (oy / r) * sp + 2; vz[i] = (oz / r) * sp;
      } else {
        const ox = px[i] - p.x;
        const oy = py[i] - p.y;
        const oz = pz[i] - p.z;
        const r = Math.hypot(ox, oy, oz) || 1;
        const sp = rand(4, 10);
        vx[i] = (ox / r) * sp; vy[i] = (oy / r) * sp + 3; vz[i] = (oz / r) * sp;
      }
      pMode[i] = 0;
      pHole[i] = -1;
      pDrag[i] = 1.5;
      pGrav[i] = 4;
      pAge[i] = Math.min(pAge[i], pLife[i] * 0.5);
    }
    // тряска у игрока — по расстоянию
    const dHead = head.distanceTo(p);
    if (dHead < 40) shared.screenShake?.(Math.min(0.9, (0.25 + 0.6 * k) * (1 - dHead / 40) * 1.6), tmp.subVectors(head, p));
    // псы: урон и отброс наружу
    const units = shared.horde?.debug?.units?.();
    if (units) {
      let extra = 0;
      for (let i = 0; i < units.length; i += 1) {
        const u = units[i];
        if (u.mode === 'off') continue;
        const c = u.bodyCenter;
        const dx = c.x - p.x;
        const dy = c.y - p.y;
        const dz = c.z - p.z;
        const r = Math.hypot(dx, dy, dz);
        if (r > BR + 0.4 * u.scale || safe(c.x, c.z)) continue;
        const q = Math.max(0, 1 - r / (BR + 0.4 * u.scale));
        const ally = u.dog.team === 'ally';
        const m = (u.scale === 1 ? 1 : u.scale ** -0.6) * (ally ? 0.6 : 1);
        tmp.set(dx, Math.max(dy, 0) + 0.5 * r, dz).normalize();
        if (u.mode === 'alive' || u.knocked) {
          enrageDog(u);
          const dmg = Math.max(1, Math.round((2 + 10 * k) * q * (ally ? 0.5 : 1)));
          u.strike(p, tmp, dmg);
          if (u.mode === 'alive' && !u.emerging && q * m > 0.25 && lifted + extra < BLAST_LIFT_MAX) {
            u.knock(tmp, 0.6);
            extra += 1;
          }
        }
        if (u.mode !== 'alive' && u.mode !== 'getup') {
          const v = (6 + 10 * k) * q * m;
          u.ragdoll.push(tmp.x * v, tmp.y * v + 3 * q, tmp.z * v);
        }
      }
    }
    // коптеры
    const list = shared.droneTargets;
    if (list) {
      for (let i = 0; i < list.length; i += 1) {
        const d = list[i];
        if (d.state !== 'alive' && d.state !== 'dying') continue;
        const dx = d.x - p.x;
        const dy = d.y - p.y;
        const dz = d.z - p.z;
        const r = Math.hypot(dx, dy, dz);
        if (r > BR + d.span || r < 1e-4 || safe(d.x, d.z)) continue;
        const q = Math.max(0, 1 - r / (BR + d.span));
        tmp.set(dx / r, dy / r, dz / r);
        const v = (8 + 10 * k) * q / Math.sqrt(Math.max(0.4, d.span));
        d.vx += tmp.x * v;
        d.vy += tmp.y * v + 2 * q;
        d.vz += tmp.z * v;
        if (d.state === 'alive') shared.droneStrike?.(d, tmp2.set(d.x, d.y, d.z), tmp.negate(),(2 + 8 * k) * q * (d.team === 'ally' ? 0.5 : 1));
      }
    }
    // мишени — наружу
    const pl = plates?.();
    if (pl && knockPlate) {
      for (let i = 0; i < pl.length; i += 1) {
        tmp.setFromMatrixPosition(pl[i].matrixWorld);
        if (tmp.distanceTo(p) > BR || safe(tmp.x, tmp.z)) continue;
        tmp2.subVectors(tmp, p).normalize();
        knockPlate(pl[i], tmp, tmp2);
      }
    }
    void nowS;
  };

  const startCollapse = (h) => {
    if (h.collapsing) return;
    h.collapsing = true;
    h.cT = 0;
    const rate = sound.collapse(h.pos, h.k) || 1;
    h.cDur = 0.5 / rate; // удар звука — через COLLAPSE_SWELL_S / скорость воспроизведения
  };
  const finishHole = (h, nowS) => {
    blast(h, nowS);
    h.active = false;
    const cb = h.onResult;
    h.onResult = null;
    if (cb) {
      try {
        cb(null); // дыра — не «в счёт»
      } catch (e) {
        console.warn('[blackhole] onResult', e?.message ?? e);
      }
    }
  };

  // ---- отрисовка (раз за кадр — на последнем подшаге мира)
  const camPos = head;
  let m = 0;
  const putHole = (h, slot) => {
    const q = m * 4;
    const dist = h.pos.distanceTo(camPos);
    let size = h.size;
    let inten = 1;
    let col = 0;
    if (slot === CHARGE_SLOT) {
      // заряд: пульсирует, полный — ярче и чаще
      const pulse = 1 + (0.08 + 0.1 * chargeLevel) * Math.sin(chargeRealT * (9 + 14 * chargeLevel));
      size *= pulse;
      inten = 0.7 + 0.5 * chargeLevel + (chargeFull ? 0.25 + 0.2 * Math.sin(chargeRealT * 30) : 0);
    } else {
      if (h.age < 0.12) size *= 0.35 + 0.65 * (h.age / 0.12); // вырастает у дула
      if (h.collapsing) {
        col = Math.min(1, h.cT / h.cDur);
        size *= 1 - 0.85 * col * col;
      }
      size = Math.max(size, dist * 0.011); // вдали не меньше ~0,6° — видно и на 100 м
    }
    hPosArr[q] = h.pos.x; hPosArr[q + 1] = h.pos.y; hPosArr[q + 2] = h.pos.z; hPosArr[q + 3] = size;
    hParArr[q] = slot === CHARGE_SLOT ? chargeRealT : h.age;
    hParArr[q + 1] = inten;
    hParArr[q + 2] = col;
    hParArr[q + 3] = h.seed;
    m += 1;
  };
  let n = 0;
  const putPart = (x, y, z, w, r, g, b, a, kind, dx, dy, dz, len) => {
    const q = n * 4;
    iPosArr[q] = x; iPosArr[q + 1] = y; iPosArr[q + 2] = z; iPosArr[q + 3] = w;
    iColArr[q] = r; iColArr[q + 1] = g; iColArr[q + 2] = b; iColArr[q + 3] = a;
    iVelArr[q] = dx; iVelArr[q + 1] = dy; iVelArr[q + 2] = dz; iVelArr[q + 3] = len;
    iKindArr[n] = kind;
    n += 1;
  };
  const draw = () => {
    camera.getWorldPosition(camPos);
    camUniform.value.copy(camPos);
    // заряд у дула: где дуло сейчас (поза оружия этого кадра уже выставлена)
    if (chargeItem) {
      const g = chargeItem.group;
      g.updateWorldMatrix(true, false);
      chargeMuzzle.copy(chargeItem.muzzle).applyMatrix4(g.matrixWorld);
      chargeDir.set(0, 0, -1).transformDirection(g.matrixWorld);
      charge.size = 0.05 + 0.17 * chargeLevel;
      charge.pos.copy(chargeMuzzle).addScaledVector(chargeDir, 0.03 + charge.size * 0.3);
      sound.whine(charge.pos, chargeLevel);
      // диск ⟂ стволу: поворот оружия (его плоскость XY ⟂ оси ствола); искры кружат в той же плоскости
      g.matrixWorld.decompose(tmp, chargeDisc.quaternion, tmp2);
      charge.bu.set(1, 0, 0).applyQuaternion(chargeDisc.quaternion);
      charge.bv.set(0, 1, 0).applyQuaternion(chargeDisc.quaternion);
      charge.bn.copy(chargeDir);
      const pulse = 1 + (0.08 + 0.1 * chargeLevel) * Math.sin(chargeRealT * (9 + 14 * chargeLevel));
      const inten = 0.7 + 0.5 * chargeLevel + (chargeFull ? 0.25 + 0.2 * Math.sin(chargeRealT * 30) : 0);
      chargeDisc.position.copy(charge.pos);
      chargeDisc.quaternion.multiply(chargeSpin.setFromAxisAngle(zAxis, -chargeRealT * (2 + 4 * chargeLevel))); // крутится вокруг ствола
      chargeDisc.scale.setScalar(charge.size * pulse);
      chargePar.value.set(chargeRealT, inten, charge.seed);
      chargeCore.position.copy(charge.pos);
      chargeCore.scale.setScalar(charge.size * 0.2 * pulse);
      coreInten.value = inten;
    }
    chargeDisc.visible = chargeCore.visible = Boolean(chargeItem) || warmFrames < 3;
    m = 0;
    for (let i = 0; i < MAX_HOLES; i += 1) if (holes[i].active) putHole(holes[i], i); // заряд — свой меш (выше)
    n = 0;
    for (let i = 0; i < parts; i += 1) {
      const u = pAge[i] / pLife[i];
      let x = px[i];
      let y = py[i];
      let z = pz[i];
      if (pMode[i] === 1) {
        const h = holes[pHole[i]];
        x += h.pos.x;
        y += h.pos.y;
        z += h.pos.z;
      }
      const sp = Math.hypot(vx[i], vy[i], vz[i]);
      const len = pKind[i] === 3 ? Math.min(0.2, pLen[i] + sp * 0.006) : 0;
      const fade = pMode[i] === 1 ? Math.min(1, u * 6) * (1 - u) : (1 - u) * (1 - u * 0.3);
      putPart(x, y, z, s0[i] + (s1[i] - s0[i]) * u, pr[i], pg[i], pb[i], pA[i] * fade, pKind[i], vx[i], vy[i], vz[i], len);
    }
    if (m > 0 || holeGeo.instanceCount > 0) flush(holeAttrs, m);
    if (n > 0 || partGeo.instanceCount > 0) flush(partAttrs, n);
    holeGeo.instanceCount = m;
    partGeo.instanceCount = n;
    if (warmFrames < 3) warmFrames += 1;
    holeMesh.visible = m > 0 || warmFrames < 3;
    partMesh.visible = n > 0 || warmFrames < 3;
    // гул — ближайшая летящая дыра
    let best = null;
    let bestD = Infinity;
    for (let i = 0; i < MAX_HOLES; i += 1) {
      const h = holes[i];
      if (!h.active) continue;
      const d = h.pos.distanceToSquared(camPos);
      if (d < bestD) {
        bestD = d;
        best = h;
      }
    }
    sound.rumble(best ? best.pos : null, best ? best.k : 0, best ? 0.04 * Math.sin(best.age * 5) : 0);
  };

  // ---- телеметрия
  let cpuSum = 0;
  let cpuWorst = 0;
  let cpuN = 0;
  let logAt = performance.now();
  let seenNow = -1;
  let subIdx = 0;

  const stepParts = (dt) => {
    for (let i = parts - 1; i >= 0; i -= 1) {
      pAge[i] += dt;
      const dead = pAge[i] >= pLife[i] || (pMode[i] !== 0 && (pHole[i] < 0 || !holes[pHole[i]].active));
      if (dead) {
        parts -= 1;
        copyPart(i, parts);
      }
    }
    for (let i = 0; i < parts; i += 1) {
      if (pMode[i] === 1) {
        // по спирали к центру: притяжение GM/r², у ядра — гаснет
        const h = holes[pHole[i]];
        const r2 = px[i] * px[i] + py[i] * py[i] + pz[i] * pz[i];
        const r = Math.sqrt(r2) || 1e-4;
        const coreR = h.size * 0.2;
        if (r < coreR) {
          pAge[i] = pLife[i];
          continue;
        }
        const a = Math.min(400, (GM(h) * (h.collapsing ? 3 : 1)) / r2) * dt;
        vx[i] -= (px[i] / r) * a;
        vy[i] -= (py[i] / r) * a;
        vz[i] -= (pz[i] / r) * a;
        const keep = Math.max(0, 1 - 0.6 * dt);
        vx[i] *= keep; vy[i] *= keep; vz[i] *= keep;
      } else if (pMode[i] === 2) {
        const h = holes[pHole[i]];
        const dx = h.pos.x - px[i];
        const dy = h.pos.y - py[i];
        const dz = h.pos.z - pz[i];
        const r = Math.hypot(dx, dy, dz) || 1e-4;
        if (r < h.size * 0.3) {
          pAge[i] = pLife[i];
          continue;
        }
        const a = Math.max(8, accelAt(h, r) * 1.5) * dt;
        vx[i] += (dx / r) * a - (dz / r) * a * 0.5;
        vy[i] += (dy / r) * a;
        vz[i] += (dz / r) * a + (dx / r) * a * 0.5;
        const keep = Math.max(0, 1 - 0.8 * dt);
        vx[i] *= keep; vy[i] *= keep; vz[i] *= keep;
      } else {
        const keep = Math.max(0, 1 - pDrag[i] * dt);
        vx[i] *= keep; vy[i] *= keep; vz[i] *= keep;
        vy[i] -= pGrav[i] * dt;
      }
      px[i] += vx[i] * dt; py[i] += vy[i] * dt; pz[i] += vz[i] * dt;
    }
  };

  const api = {
    // выстрел: from — дуло, dir — направление, k — заряд 0..1, onResult(null) — когда схлопнулась
    fire(from, dir, { k = 0, onResult = null, speed = null } = {}) {
      k = Math.min(1, Math.max(0, Number(k) || 0));
      let h = null;
      for (let i = 0; i < MAX_HOLES; i += 1) {
        const c = holes[i];
        if (!c.active) {
          h = c;
          break;
        }
        if (!h || c.born < h.born) h = c;
      }
      if (h.active) finishHole(h, (shared.sceneNowMs ?? 0) / 1000); // самая старая схлопывается сразу
      h.active = true;
      h.collapsing = false;
      h.k = k;
      h.pos.copy(from).addScaledVector(dir, 0.15);
      h.vel.copy(dir).normalize().multiplyScalar(speed && speed < 200 ? speed : speedOf(k));
      h.age = 0;
      h.life = lifeOf(k);
      h.R = pullR(k);
      h.A = pullA(k);
      h.size = sizeOf(k);
      h.core = coreOf(k);
      h.seed = Math.random() * 10;
      h.emit = 0;
      h.dust = 0;
      h.boost = 1;
      h.born = (bornCounter += 1);
      h.onResult = onResult;
      h.plateHit.fill(0);
      // вспышка у дула: фиолетовое свечение, кольцо, искры вперёд
      part(from.x, from.y, from.z, 0, 0.18, 0.12 + 0.15 * k, 0.4 + 0.5 * k, 0.6, 0.25, 1.6, 1.6);
      const ri = part(from.x, from.y, from.z, 1, 0.3, 0.04, 0.35 + 0.4 * k, 0.75, 0.5, 1.8, 1.1);
      vx[ri] = dir.x * 2; vy[ri] = dir.y * 2; vz[ri] = dir.z * 2;
      for (let i = 0; i < 14 + 16 * k; i += 1) spark(from.x, from.y, from.z, dir.x, dir.y, dir.z, 0.5, rand(2, 7), rand(0.2, 0.45), 0.02, 0.6, 0.45, 1.7, true);
      sound.fire(from, k);
      shared.screenShake?.(0.2 + 0.4 * k, tmp.copy(dir).negate());
    },
    // заряд у дула: item — оружие в руке (его muzzle и поза), level 0..1, seconds — сколько копится
    // (реальное время); null — не заряжается. true — только что стал полным (вспышка и «дзинь»)
    charge(item, level = 0, seconds = 0) {
      if (!item) {
        if (chargeItem) {
          chargeItem = null;
          charge.active = false;
          sound.whine(null);
        }
        return false;
      }
      const wasFull = chargeFull;
      if (!chargeItem) chargeFull = false;
      chargeItem = item;
      chargeLevel = Math.min(1, Math.max(0, level));
      chargeRealT = seconds;
      charge.active = true;
      charge.k = chargeLevel;
      charge.size = 0.05 + 0.17 * chargeLevel; // (и в draw) — искры вокруг рождаются под этот размер
      charge.seed = charge.seed || Math.random() * 10;
      chargeFull = chargeLevel >= 1;
      if (chargeFull && !wasFull) {
        const p = charge.pos;
        part(p.x, p.y, p.z, 0, 0.22, 0.1, 0.5, 0.9, 0.6, 2, 2);
        part(p.x, p.y, p.z, 1, 0.3, 0.03, 0.3, 0.9, 0.6, 2, 1.4);
        for (let i = 0; i < 12; i += 1) spark(p.x, p.y, p.z, 0, 0, 0, 1, rand(1, 3), rand(0.2, 0.4), 0.012, 0.8, 0.5, 1.8);
        sound.tick(p);
        return true;
      }
      return false;
    },
    update(dtRaw) {
      const t0 = performance.now();
      const dt = Math.min(0.05, dtRaw || 0);
      const nowS = (shared.sceneNowMs ?? 0) / 1000;
      camera.getWorldPosition(head);
      const tp = shared.towerPos;
      towerXZ.on = Boolean(shared.towerOn && tp);
      if (towerXZ.on) {
        towerXZ.x = tp.x;
        towerXZ.z = tp.z;
      }
      // сколько псов сейчас подняты дырами (куклы «сбит»)
      lifted = 0;
      swirled = 0;
      dragged = 0;
      killed = 0;
      let any = false;
      for (let i = 0; i < MAX_HOLES; i += 1) any = any || holes[i].active;
      if (any) {
        const units = shared.horde?.debug?.units?.();
        if (units) {
          for (let i = 0; i < units.length; i += 1) {
            const u = units[i];
            if (!u.dog.bhLift) continue;
            if (u.mode === 'down') lifted += 1;
            else if (u.mode === 'alive' || u.mode === 'off') u.dog.bhLift = false;
          }
        }
      }
      for (let i = 0; i < MAX_HOLES; i += 1) {
        const h = holes[i];
        if (!h.active || dt <= 0) continue;
        h.age += dt;
        if (!h.collapsing) {
          h.vel.multiplyScalar(Math.exp(-DRAG * dt));
          h.pos.addScaledVector(h.vel, dt);
          const gy = groundAt(h.pos.x, h.pos.z) + h.size * 0.25;
          if (h.pos.y < gy) {
            h.pos.y = gy;
            h.vel.multiplyScalar(0.1);
            startCollapse(h);
          } else if (h.age >= h.life) startCollapse(h);
        } else {
          h.cT += dt;
          h.vel.multiplyScalar(Math.exp(-6 * dt));
          h.pos.addScaledVector(h.vel, dt);
          h.boost = 1 + 0.8 * Math.min(1, h.cT / h.cDur); // схлопываясь, тянет сильнее
        }
        pullDogs(h, dt, nowS);
        pullDrones(h, dt, nowS);
        pullProps(h, dt);
        // искры-полоски по спирали; с земли под дырой — крошка
        h.emit += dt * (55 + 85 * h.k) * (h.collapsing ? 2.5 : 1);
        while (h.emit >= 1) {
          h.emit -= 1;
          infall(h, i);
        }
        const above = h.pos.y - groundAt(h.pos.x, h.pos.z);
        if (above < h.R * 0.6 && !safe(h.pos.x, h.pos.z)) {
          h.dust += dt * (22 + 40 * h.k);
          while (h.dust >= 1) {
            h.dust -= 1;
            const a = Math.random() * Math.PI * 2;
            const rr = Math.sqrt(Math.random()) * Math.min(h.R * 0.5, Math.sqrt(Math.max(0.01, h.R * h.R * 0.36 - above * above)));
            const x = h.pos.x + Math.cos(a) * rr;
            const z = h.pos.z + Math.sin(a) * rr;
            const j = part(x, groundAt(x, z) + 0.05, z, Math.random() < 0.5 ? 2 : 3, rand(0.8, 1.6), rand(0.02, 0.05), 0.01, 1.1, 0.5, 0.25, 0.9);
            if (Math.random() < 0.4) { pr[j] = 0.6; pg[j] = 0.3; pb[j] = 1.2; }
            vy[j] = rand(1, 3);
            pLen[j] = 0.03;
            pMode[j] = 2;
            pHole[j] = i;
          }
        }
        if (h.collapsing && h.cT >= h.cDur) finishHole(h, nowS);
      }
      // заряд у дула: искры-полоски вокруг
      if (charge.active && dt > 0) {
        charge.emit += dt * (40 + 160 * chargeLevel);
        while (charge.emit >= 1) {
          charge.emit -= 1;
          infall(charge, CHARGE_SLOT);
        }
      }
      if (dt > 0) stepParts(dt);
      // рисовать — на последнем подшаге кадра
      const now = shared.sceneNowMs;
      if (now !== seenNow) {
        seenNow = now;
        subIdx = 0;
      }
      subIdx += 1;
      if (subIdx >= (shared.worldClock?.n ?? 1)) draw();
      const spent = performance.now() - t0;
      if (any || parts) {
        cpuSum += spent;
        cpuWorst = Math.max(cpuWorst, spent);
        cpuN += 1;
      }
      if (t0 - logAt > 5000) {
        if (cpuN) console.log(`[blackhole] cpu=${(cpuSum / cpuN).toFixed(3)}/${cpuWorst.toFixed(2)}ms holes=${holes.filter((h, j) => j < MAX_HOLES && h.active).length} parts=${parts} lifted=${lifted}`);
        cpuSum = cpuWorst = cpuN = 0;
        logAt = t0;
      }
    },
    // для vr:eval
    stats: () => ({
      holes: holes.slice(0, MAX_HOLES).filter((h) => h.active).map((h) => ({ k: +h.k.toFixed(2), age: +h.age.toFixed(2), x: +h.pos.x.toFixed(1), y: +h.pos.y.toFixed(1), z: +h.pos.z.toFixed(1), R: +h.R.toFixed(1), collapsing: h.collapsing })),
      charging: Boolean(chargeItem),
      chargeLevel,
      parts,
      lifted,
      drawn: { holes: holeGeo.instanceCount, parts: partGeo.instanceCount },
      sound: sound.stats(),
    }),
    dispose() {
      sound.silence?.();
      group.remove(holeMesh);
      group.remove(partMesh);
      holeGeo.dispose();
      partGeo.dispose();
      holeMat.dispose();
      partMat.dispose();
      for (const mesh of [chargeDisc, chargeCore]) {
        group.remove(mesh);
        mesh.geometry.dispose();
        mesh.material.dispose();
      }
      for (const h of holes) {
        h.active = false;
        h.onResult = null;
      }
      parts = 0;
    },
  };
  return api;
}
