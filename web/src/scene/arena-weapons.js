// Оружие арены (generated-guns.js, поле projectile): 'rocket' — ракетница, 'rail' — рейлган,
// 'plasma' — плазмаган. Владелец — shooting.js (как mana.js / blackhole.js).
//
// Ракета и плазма летят пулями shooting.js (тот же пул, те же попадания: земля, мишени, тарелки, псы,
// коптеры), только без гравитации; этот модуль рисует их по тому же прямому пути с тем же шагом dt и
// делает остальное, когда пуля кончилась (impact):
//   ракета — корпус (InstancedMesh), пламя выхлопа и искры (спрайты), густой дымный след (общий дым
//            smoke.js через smokePuff); взрыв — разрыв артиллерии в масштабе 0,3 (artillery.js explode)
//            + вспышка, ударное кольцо, искры; урон и отброс в радиусе ROCKET_R псам, коптерам,
//            мишеням, трупам; тряска обзора по расстоянию; игрока не ранит (его и нечем).
//   плазма — голубой шар: яркое ядро в мягком ореоле и короткий хвост; попадание — голубые кольца,
//            вспышка, искры; маленький всплеск (PLASMA_R) по псам/коптерам рядом, если попала не в них.
//   рельса — мгновенный луч (сквозные попадания считает shooting.js railShot): прямой яркий стержень,
//            мягкое свечение и зелёная спираль вокруг (лента-хеликс, считается в вершинном шейдере),
//            всё гаснет за BEAM_LIFE с, спираль при этом расходится; искры в каждой точке попадания и в конце.
//
// Отрисовка: спрайты (ядра, свечения, кольца, искры-чёрточки, пламя) — один InstancedBufferGeometry +
// ShaderMaterial (аддитивно); лучи — второй (лента из BEAM_SEG отрезков, 3 экземпляра на луч); корпуса
// ракет — InstancedMesh. Пустые — скрыты (perf.md), первые 3 кадра видны (шейдеры собираются при
// подмене сцены). Состояние — типизированные массивы, за кадр ничего не выделяется.
// Звук — arena-sound.js (запечённые буферы, постоянные голоса).
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { createArenaSound } from './arena-sound.js';

const MAX_PROJ = 24; // ракет и плазменных шаров в полёте (пул пуль в shooting.js — 32)
const MAX_PARTS = 700;
const SPRITE_CAP = MAX_PROJ * 6 + MAX_PARTS;
const MAX_BEAMS = 4;
const BEAM_SEG = 1024; // отрезков ленты (спираль до HELIX_M м — ~10 на виток)
const HELIX_M = 60;
const HELIX_PITCH = 0.55; // м на виток
const BEAM_LIFE = 1.0; // с
const ROCKET_R = 4; // м: радиус взрыва ракеты
const PLASMA_R = 1; // м: всплеск плазмы
export const ROCKET_LIFE = 4; // с: дольше ракета не летит (взрывается в воздухе)
const TRAIL_STEP = 0.5; // м между клубами дымного следа (вблизи; вдали — dist·0,035)
const LOG_EVERY_MS = 10000;
const K_ROCKET = 0;
const K_PLASMA = 1;

const rand = (a, b) => a + Math.random() * (b - a);

// ---------------------------------------------------------------- спрайты
// вид (iVel.w): 0 — ядро в ореоле, 1 — мягкое свечение, 2 — кольцо, 3 — искра-чёрточка (тянется вдоль
// iVel.xyz от точки), 4 — язык пламени (тоже вдоль iVel.xyz: у точки — бело-жёлтый, к концу — красный)
const spriteVertex = /* glsl */ `
  attribute vec4 iPos;  // xyz — центр (у 3/4 — начало), w — полуразмер (м)
  attribute vec4 iCol;  // rgb (линейный, может быть > 1), a — яркость
  attribute vec4 iVel;  // xyz — вектор вытягивания (м) для 3/4, w — вид
  varying vec2 vUv;
  varying vec4 vCol;
  varying float vKind;
  void main() {
    vec4 mv = modelViewMatrix * vec4(iPos.xyz, 1.0);
    vec2 p = position.xy;
    float kind = iVel.w;
    if (kind > 2.5) {
      vec3 n = normalize(mv.xyz);
      vec3 a = (modelViewMatrix * vec4(iVel.xyz, 0.0)).xyz;
      a -= n * dot(a, n);
      float L = length(a);
      vec3 ax = L > 1e-5 ? a / L : vec3(1.0, 0.0, 0.0);
      vec3 side = normalize(cross(ax, n));
      float s = iPos.w;
      mv.xyz += a * 0.5 + ax * p.x * (L * 0.5 + s) + side * p.y * s;
    } else {
      mv.xy += p * iPos.w;
    }
    gl_Position = projectionMatrix * mv;
    vUv = p;
    vCol = iCol;
    vKind = kind;
  }
`;
const spriteFragment = /* glsl */ `
  varying vec2 vUv;
  varying vec4 vCol;
  varying float vKind;
  void main() {
    float r = length(vUv);
    float edge = max(0.0, 1.0 - r);
    vec3 c = vCol.rgb;
    vec3 col;
    if (vKind < 0.5) {
      float core = exp(-r * r * 14.0);
      float glow = exp(-r * r * 3.0) * edge;
      col = mix(c, vec3(1.0), 0.7) * core * 2.2 + c * glow * 1.3;
    } else if (vKind < 1.5) {
      col = c * exp(-r * r * 3.0) * edge;
    } else if (vKind < 2.5) {
      float d = (r - 0.82) / 0.07;
      col = (c + vec3(0.1)) * exp(-d * d) * edge * 3.0;
    } else if (vKind < 3.5) {
      float u = vUv.x * 0.5 + 0.5; // 0 — голова искры
      float w = exp(-vUv.y * vUv.y * 5.0) * (1.0 - u) * (1.0 - abs(vUv.x) * 0.15);
      col = mix(c, vec3(1.0), 0.5 * (1.0 - u)) * w * 1.6;
    } else {
      float u = vUv.x * 0.5 + 0.5; // 0 — у сопла
      float hw = max(0.06, 1.0 - u * 0.9);
      float d = vUv.y / hw;
      float body = exp(-d * d * 2.5) * pow(max(0.0, 1.0 - u), 1.3) * smoothstep(-1.0, -0.8, vUv.x);
      vec3 hot = mix(vec3(1.0, 0.95, 0.8), c, smoothstep(0.0, 0.35, u));
      hot = mix(hot, vec3(0.9, 0.18, 0.04), smoothstep(0.35, 1.0, u));
      col = hot * body * 2.0;
    }
    gl_FragColor = vec4(col * vCol.a, 1.0);
    #include <colorspace_fragment>
  }
`;

// ---------------------------------------------------------------- лучи рейлгана
// лента вдоль луча: aStrip.x — доля длины 0..1, aStrip.y — сторона −1..1. Вид (iFrom.w): 0 — стержень,
// 1 — свечение, 2 — спираль (первые HELIX_M м). Ширина — к камере, не тоньше ~0,07° (видно и вдали).
const beamVertex = /* glsl */ `
  attribute vec2 aStrip;
  attribute vec4 iFrom; // xyz — начало, w — вид
  attribute vec4 iDir;  // xyz — направление (единичное), w — длина, м
  attribute vec4 iP;    // x — возраст, с; y — жизнь, с; z — фаза спирали; w — ширина, м
  attribute vec3 iCol;
  varying float vSide;
  varying float vA;
  varying vec3 vCol;
  varying float vKind;
  void main() {
    float kind = iFrom.w;
    float len = iDir.w;
    float L = kind > 1.5 ? min(len, ${HELIX_M.toFixed(1)}) : len;
    float x = aStrip.x * L;
    vec3 d = iDir.xyz;
    vec3 up = abs(d.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
    vec3 pa = normalize(cross(up, d));
    vec3 pb = cross(d, pa);
    float age = iP.x;
    float k = clamp(age / iP.y, 0.0, 1.0);
    vec3 p = iFrom.xyz + d * x;
    vec3 tang = d;
    if (kind > 1.5) {
      float w = 6.2831853 / ${HELIX_PITCH.toFixed(3)};
      float rad = (0.03 + 0.13 * sqrt(k)) * smoothstep(0.0, 0.35, x);
      float th = x * w + iP.z - age * 9.0;
      vec3 off = pa * cos(th) + pb * sin(th);
      p += off * rad;
      tang = d + (pb * cos(th) - pa * sin(th)) * rad * w;
    }
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    vec3 tv = (modelViewMatrix * vec4(tang, 0.0)).xyz;
    vec3 side = cross(tv, normalize(mv.xyz));
    float sl = length(side);
    side = sl > 1e-5 ? side / sl : vec3(1.0, 0.0, 0.0);
    float width = max(iP.w, -mv.z * (kind > 0.5 && kind < 1.5 ? 0.0024 : 0.0011));
    mv.xyz += side * aStrip.y * width;
    gl_Position = projectionMatrix * mv;
    // фронт пробегает луч за ~0,1 с; гаснет за жизнь; дальние куски тоньше по яркости
    float shown = clamp((age * 2600.0 - x) / 3.0 + 1.0, 0.0, 1.0);
    float fade = kind < 0.5 ? pow(1.0 - k, 3.0) : kind < 1.5 ? pow(1.0 - k, 2.0) : pow(1.0 - k, 1.4);
    float far = kind > 1.5 ? 1.0 - smoothstep(L - 4.0, L, x) * step(L, len - 0.01) : 1.0;
    vA = shown * fade * far * clamp(iP.w / width, 0.3, 1.0);
    vSide = aStrip.y;
    vCol = iCol;
    vKind = kind;
  }
`;
const beamFragment = /* glsl */ `
  varying float vSide;
  varying float vA;
  varying vec3 vCol;
  varying float vKind;
  void main() {
    float s = vSide;
    vec3 col;
    if (vKind < 0.5) col = mix(vCol, vec3(1.0), 0.65) * exp(-s * s * 3.0) * 2.2;
    else if (vKind < 1.5) col = vCol * exp(-s * s * 2.5) * (1.0 - abs(s)) * 0.55;
    else col = mix(vCol, vec3(1.0), 0.15) * exp(-s * s * 3.5) * 1.7;
    gl_FragColor = vec4(col * vA, 1.0);
    #include <colorspace_fragment>
  }
`;

// корпус ракеты: остриё — в начале координат (точка попадания), хвост — +Z (назад), длина ~0,39 м
function buildRocketGeometry(THREE) {
  const parts = [];
  const paint = (g, hex) => {
    const c = new THREE.Color(hex);
    const n = g.attributes.position.count;
    const arr = new Float32Array(n * 3);
    for (let i = 0; i < n; i += 1) {
      arr[i * 3] = c.r;
      arr[i * 3 + 1] = c.g;
      arr[i * 3 + 2] = c.b;
    }
    g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
    parts.push(g);
  };
  const nose = new THREE.ConeGeometry(0.032, 0.1, 14);
  nose.rotateX(-Math.PI / 2);
  nose.translate(0, 0, 0.05);
  paint(nose, 0xd2491f);
  const body = new THREE.CylinderGeometry(0.032, 0.032, 0.26, 14, 1, true);
  body.rotateX(-Math.PI / 2);
  body.translate(0, 0, 0.23);
  paint(body, 0x4a5640);
  const band = new THREE.CylinderGeometry(0.0335, 0.0335, 0.025, 14, 1, true);
  band.rotateX(-Math.PI / 2);
  band.translate(0, 0, 0.125);
  paint(band, 0xe0b52a);
  const nozzle = new THREE.CylinderGeometry(0.026, 0.02, 0.035, 12, 1, false);
  nozzle.rotateX(-Math.PI / 2);
  nozzle.translate(0, 0, 0.375);
  paint(nozzle, 0x1e1e1e);
  for (let k = 0; k < 4; k += 1) {
    const fin = new THREE.BoxGeometry(0.004, 0.05, 0.08);
    fin.translate(0, 0.055, 0.32);
    fin.rotateZ((k * Math.PI) / 2 + Math.PI / 4);
    paint(fin, 0x70757a);
  }
  const merged = mergeGeometries(parts.map((g) => g.toNonIndexed()));
  parts.forEach((g) => g.dispose());
  merged.computeVertexNormals();
  return merged;
}

export function createArena({ THREE, group, camera, groundAt, smokePuff, plates = null, knockPlate = null }) {
  const shared = (globalThis.__sceneState ??= {});
  const sound = createArenaSound(shared);
  const camPos = new THREE.Vector3();
  const V = new THREE.Vector3();
  const V2 = new THREE.Vector3();
  const P = new THREE.Vector3();
  const Q = new THREE.Quaternion();
  const QR = new THREE.Quaternion();
  const S1 = new THREE.Vector3(1, 1, 1);
  const M = new THREE.Matrix4();
  const FWD = new THREE.Vector3(0, 0, -1);
  const AXZ = new THREE.Vector3(0, 0, 1);

  // ---- спрайты
  const sGeo = new THREE.InstancedBufferGeometry();
  sGeo.setIndex([0, 1, 2, 0, 2, 3]);
  sGeo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
  const sPos = new Float32Array(SPRITE_CAP * 4);
  const sCol = new Float32Array(SPRITE_CAP * 4);
  const sVel = new Float32Array(SPRITE_CAP * 4);
  const sAttrs = [['iPos', sPos], ['iCol', sCol], ['iVel', sVel]].map(([name, arr]) => {
    const a = new THREE.InstancedBufferAttribute(arr, 4).setUsage(THREE.DynamicDrawUsage);
    sGeo.setAttribute(name, a);
    return a;
  });
  sGeo.instanceCount = 0;
  const sMat = new THREE.ShaderMaterial({
    vertexShader: spriteVertex,
    fragmentShader: spriteFragment,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    forceSinglePass: true,
    toneMapped: false,
  });
  const sMesh = new THREE.Mesh(sGeo, sMat);
  sMesh.name = 'arena-sprites';
  sMesh.frustumCulled = false;
  sMesh.renderOrder = 4;
  group.add(sMesh);

  // ---- лучи
  const bGeo = new THREE.InstancedBufferGeometry();
  {
    const strip = new Float32Array((BEAM_SEG + 1) * 2 * 2);
    const pos = new Float32Array((BEAM_SEG + 1) * 2 * 3);
    const index = [];
    for (let i = 0; i <= BEAM_SEG; i += 1) {
      const s = i / BEAM_SEG;
      strip.set([s, -1, s, 1], i * 4);
      if (i < BEAM_SEG) {
        const a = i * 2;
        index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
    bGeo.setIndex(index);
    bGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3)); // не используется шейдером
    bGeo.setAttribute('aStrip', new THREE.BufferAttribute(strip, 2));
  }
  const BI = MAX_BEAMS * 3;
  const bFrom = new Float32Array(BI * 4);
  const bDir = new Float32Array(BI * 4);
  const bP = new Float32Array(BI * 4);
  const bCol = new Float32Array(BI * 3);
  const bAttrs = [['iFrom', bFrom, 4], ['iDir', bDir, 4], ['iP', bP, 4], ['iCol', bCol, 3]].map(([name, arr, size]) => {
    const a = new THREE.InstancedBufferAttribute(arr, size).setUsage(THREE.DynamicDrawUsage);
    bGeo.setAttribute(name, a);
    return a;
  });
  bGeo.instanceCount = 0;
  const bMat = new THREE.ShaderMaterial({
    vertexShader: beamVertex,
    fragmentShader: beamFragment,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    forceSinglePass: true,
    toneMapped: false,
  });
  const bMesh = new THREE.Mesh(bGeo, bMat);
  bMesh.name = 'arena-beams';
  bMesh.frustumCulled = false;
  bMesh.renderOrder = 4;
  group.add(bMesh);

  // ---- корпуса ракет (кэш геометрии — между подменами сцены)
  const geoKey = buildRocketGeometry.toString();
  if (shared.arenaRocketGeo?.key !== geoKey) shared.arenaRocketGeo = { key: geoKey, geometry: buildRocketGeometry(THREE) };
  const rGeo = shared.arenaRocketGeo.geometry;
  const rMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0.25 });
  const rMesh = new THREE.InstancedMesh(rGeo, rMat, MAX_PROJ);
  rMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  rMesh.count = 0;
  rMesh.name = 'arena-rockets';
  rMesh.frustumCulled = false;
  rGeo.userData.shared = true;
  group.add(rMesh);
  let warm = 0;

  // ---- снаряды в полёте
  const pk = new Uint8Array(MAX_PROJ);
  const ox = new Float32Array(MAX_PROJ), oy = new Float32Array(MAX_PROJ), oz = new Float32Array(MAX_PROJ);
  const dx = new Float32Array(MAX_PROJ), dy = new Float32Array(MAX_PROJ), dz = new Float32Array(MAX_PROJ);
  const spd = new Float32Array(MAX_PROJ), age = new Float32Array(MAX_PROJ), trail = new Float32Array(MAX_PROJ); // trail — время следующего клуба, с
  const grav = new Float32Array(MAX_PROJ); // м/с²: путь — та же парабола, что у пули shooting.js
  const roll = new Float32Array(MAX_PROJ), phase = new Float32Array(MAX_PROJ), emitAcc = new Float32Array(MAX_PROJ);
  const ids = new Int32Array(MAX_PROJ);
  let projN = 0;
  let nextId = 1;
  const copyProj = (i, j) => {
    pk[i] = pk[j];
    ox[i] = ox[j]; oy[i] = oy[j]; oz[i] = oz[j];
    dx[i] = dx[j]; dy[i] = dy[j]; dz[i] = dz[j];
    spd[i] = spd[j]; age[i] = age[j]; trail[i] = trail[j]; grav[i] = grav[j];
    roll[i] = roll[j]; phase[i] = phase[j]; emitAcc[i] = emitAcc[j]; ids[i] = ids[j];
  };
  const findProj = (id) => {
    for (let i = 0; i < projN; i += 1) if (ids[i] === id) return i;
    return -1;
  };

  // ---- частицы
  const px = new Float32Array(MAX_PARTS), py = new Float32Array(MAX_PARTS), pz = new Float32Array(MAX_PARTS);
  const vx = new Float32Array(MAX_PARTS), vy = new Float32Array(MAX_PARTS), vz = new Float32Array(MAX_PARTS);
  const pAge = new Float32Array(MAX_PARTS), pLife = new Float32Array(MAX_PARTS);
  const s0 = new Float32Array(MAX_PARTS), s1 = new Float32Array(MAX_PARTS), pKind = new Uint8Array(MAX_PARTS);
  const pr = new Float32Array(MAX_PARTS), pg = new Float32Array(MAX_PARTS), pb = new Float32Array(MAX_PARTS);
  const pA = new Float32Array(MAX_PARTS), pDrag = new Float32Array(MAX_PARTS), pGrav = new Float32Array(MAX_PARTS);
  const pStretch = new Float32Array(MAX_PARTS);
  let partN = 0;
  const copyPart = (i, j) => {
    px[i] = px[j]; py[i] = py[j]; pz[i] = pz[j];
    vx[i] = vx[j]; vy[i] = vy[j]; vz[i] = vz[j];
    pAge[i] = pAge[j]; pLife[i] = pLife[j]; s0[i] = s0[j]; s1[i] = s1[j]; pKind[i] = pKind[j];
    pr[i] = pr[j]; pg[i] = pg[j]; pb[i] = pb[j]; pA[i] = pA[j]; pDrag[i] = pDrag[j]; pGrav[i] = pGrav[j];
    pStretch[i] = pStretch[j];
  };
  const part = (x, y, z, kind, life, size0, size1, r, g, b, a = 1) => {
    let i;
    if (partN < MAX_PARTS) i = partN++;
    else {
      i = 0;
      for (let k = 1; k < MAX_PARTS; k += 1) if (pAge[k] / pLife[k] > pAge[i] / pLife[i]) i = k;
    }
    px[i] = x; py[i] = y; pz[i] = z;
    vx[i] = 0; vy[i] = 0; vz[i] = 0;
    pAge[i] = 0; pLife[i] = life; s0[i] = size0; s1[i] = size1; pKind[i] = kind;
    pr[i] = r; pg[i] = g; pb[i] = b; pA[i] = a; pDrag[i] = 0; pGrav[i] = 0; pStretch[i] = 0;
    return i;
  };
  // искра-чёрточка: летит из (x, y, z) около направления (nx, ny, nz) с разбросом spread
  const spark = (x, y, z, nx, ny, nz, spread, speed, life, size, r, g, b, a = 1, grav = 4) => {
    const i = part(x, y, z, 3, life, size, size * 0.5, r, g, b, a);
    let ax = nx + rand(-spread, spread);
    let ay = ny + rand(-spread, spread);
    let az = nz + rand(-spread, spread);
    const n = Math.hypot(ax, ay, az) || 1;
    ax /= n; ay /= n; az /= n;
    vx[i] = ax * speed; vy[i] = ay * speed; vz[i] = az * speed;
    pDrag[i] = 2.5;
    pGrav[i] = grav;
    pStretch[i] = 0.035;
    return i;
  };

  // ---- запись спрайта в буфер
  let m = 0;
  const put = (x, y, z, size, r, g, b, a, kind, ex = 0, ey = 0, ez = 0) => {
    if (m >= SPRITE_CAP) return;
    const q = m * 4;
    sPos[q] = x; sPos[q + 1] = y; sPos[q + 2] = z; sPos[q + 3] = size;
    sCol[q] = r; sCol[q + 1] = g; sCol[q + 2] = b; sCol[q + 3] = a;
    sVel[q] = ex; sVel[q + 1] = ey; sVel[q + 2] = ez; sVel[q + 3] = kind;
    m += 1;
  };

  // ---- лучи
  const beams = [];
  for (let i = 0; i < MAX_BEAMS; i += 1) beams.push({ on: false, x: 0, y: 0, z: 0, dx: 0, dy: 0, dz: -1, len: 1, age: 0, phase: 0 });

  // ---- урон по области (ракета, плазма). direct — плазма уже попала пулей в цель: всплеска нет
  const splash = (p, R, rocket) => {
    let units = null;
    try {
      units = shared.horde?.debug?.units?.() ?? null;
    } catch {
      units = null;
    }
    if (units) {
      for (let i = 0; i < units.length; i += 1) {
        const u = units[i];
        if (u.mode === 'off' || u.emerging) continue;
        const c = u.bodyCenter;
        const RR = R + 0.4 * u.scale;
        const dist = Math.hypot(c.x - p.x, c.y - p.y, c.z - p.z);
        if (dist > RR) continue;
        const k = 1 - dist / RR;
        V2.set(c.x - p.x, 0, c.z - p.z);
        if (V2.lengthSq() < 1e-4) V2.set(Math.random() - 0.5, 0, Math.random() - 0.5);
        V2.normalize();
        V2.y = rocket ? 0.6 + 0.7 * k : 0.3;
        V2.normalize();
        try {
          const ally = u.dog?.team === 'ally';
          if (u.mode === 'alive' || u.knocked) {
            if (ally) continue; // свои не ранятся
            if (!u.dog.angry) {
              u.dog.angry = true;
              u.setAngry?.(true);
            }
            const dmg = rocket ? Math.max(1, Math.round(1 + 5 * k * k)) : 1;
            const res = u.strike(c, V2, dmg);
            const sp = rocket ? 4 + 9 * k : 1.5;
            if (res === 'kill') {
              u.blast?.(V2.x * sp, V2.y * sp, V2.z * sp);
              shared.killConfirm?.dog(u); // ракета/плазма игрока: «клац» + хитмаркер (kill-confirm.js)
            }
            else if (res === 'hit') shared.killConfirm?.dogHit(u); // ранен взрывом: серый крестик
            if (rocket && res === 'hit' && u.scale <= 1.7 && k > 0.2) u.knock(V2, 0.6 + 1.4 * k);
          } else if ((u.mode === 'dying' || u.mode === 'dead') && u.deadFor < 30) {
            const sp = rocket ? 3 + 8 * k : 1 + 1.5 * k;
            u.blast?.(V2.x * sp, V2.y * sp, V2.z * sp);
          }
        } catch {
          // пёс не важнее взрыва
        }
      }
    }
    const drones = shared.droneTargets;
    if (drones) {
      for (let i = 0; i < drones.length; i += 1) {
        const d = drones[i];
        if (d.state !== 'alive' && d.state !== 'dying') continue;
        const RR = R * 1.2 + d.span;
        const dist = Math.hypot(d.x - p.x, d.y - p.y, d.z - p.z);
        if (dist > RR || dist < 1e-4) continue;
        const k = 1 - dist / RR;
        V2.set((d.x - p.x) / dist, (d.y - p.y) / dist, (d.z - p.z) / dist);
        if (rocket) {
          const v = (6 + 8 * k) * k / Math.sqrt(Math.max(0.4, d.span));
          d.vx += V2.x * v;
          d.vy += V2.y * v + 2 * k;
          d.vz += V2.z * v;
        }
        if (d.state === 'alive' && d.team !== 'ally') {
          V.set(d.x, d.y, d.z);
          try {
            const dr = shared.droneStrike?.(d, V, V2, rocket ? Math.max(1, Math.round(1 + 6 * k)) : 1);
            if (dr === 'kill') shared.killConfirm?.drone(d);
            else if (dr === 'hit') shared.killConfirm?.droneHit(d);
          } catch {
            // коптер не важнее
          }
        }
      }
    }
    if (rocket) {
      const pl = plates?.();
      if (pl && knockPlate) {
        for (let i = 0; i < pl.length; i += 1) {
          V.setFromMatrixPosition(pl[i].matrixWorld);
          if (V.distanceTo(p) > R) continue;
          V2.subVectors(V, p).normalize();
          V2.y += 0.3;
          knockPlate(pl[i], V, V2.normalize());
        }
      }
    }
  };

  // ---- взрыв ракеты
  const explode = (p) => {
    let art = false;
    try {
      art = Boolean(shared.artillerySystem?.explode?.(p.x, p.y, p.z, 0.3));
    } catch {
      art = false;
    }
    // своё сверху: белая вспышка, ударное кольцо, свечение, искры
    part(p.x, p.y, p.z, 0, 0.14, 1.1, 0.3, 1.0, 0.85, 0.55, 3);
    part(p.x, p.y, p.z, 1, 0.45, 2.2, 4.2, 1.0, 0.45, 0.12, 1.4);
    let k = part(p.x, p.y + 0.2, p.z, 2, 0.32, 0.4, 7, 1.0, 0.8, 0.55, 1.3);
    pDrag[k] = 0;
    k = part(p.x, p.y + 0.2, p.z, 2, 0.5, 0.3, 4.5, 0.9, 0.5, 0.2, 0.7);
    for (let n = 0; n < 26; n += 1) spark(p.x, p.y + 0.2, p.z, 0, 0.6, 0, 1.1, rand(6, 18), rand(0.4, 1.1), rand(0.025, 0.045), 1.0, 0.62, 0.22, 1.2, 9);
    if (!art) {
      // без артиллерии (её нет в сцене) — огненные клубы и дым сами
      for (let n = 0; n < 7; n += 1) {
        const i = part(p.x + rand(-0.6, 0.6), p.y + rand(0, 0.8), p.z + rand(-0.6, 0.6), 1, rand(0.5, 0.9), rand(0.8, 1.2), rand(1.6, 2.6), 1.0, 0.42, 0.1, 1.2);
        vx[i] = rand(-2, 2); vy[i] = rand(1, 4); vz[i] = rand(-2, 2); pDrag[i] = 3;
      }
      for (let n = 0; n < 10; n += 1) smokePuff(p.x + rand(-0.8, 0.8), p.y + rand(0, 1), p.z + rand(-0.8, 0.8), rand(-1.5, 1.5), rand(0.5, 2.5), rand(-1.5, 1.5), 0.4, rand(1.6, 2.6), rand(3, 5), 1);
    }
    splash(p, ROCKET_R, true);
    sound.explosion(p);
    camera.getWorldPosition(camPos);
    const dHead = camPos.distanceTo(p);
    if (dHead < 32) {
      V.subVectors(camPos, p);
      if (V.lengthSq() < 1e-4) V.set(0, 0, 1);
      try {
        shared.screenShake?.(Math.min(0.85, 2.4 / Math.max(1.5, dHead)), V.normalize());
      } catch {
        // тряска не важнее
      }
    }
  };

  // ---- попадание плазмы
  let plasmaHitAt = 0;
  const plasmaImpact = (p, direct) => {
    part(p.x, p.y, p.z, 0, 0.12, 0.16, 0.04, 0.3, 0.6, 1.0, 1.6);
    part(p.x, p.y, p.z, 1, 0.3, 0.25, 0.7, 0.2, 0.45, 1.0, 1.1);
    part(p.x, p.y, p.z, 2, 0.28, 0.05, PLASMA_R, 0.35, 0.7, 1.0, 1.1);
    part(p.x, p.y, p.z, 2, 0.4, 0.04, PLASMA_R * 0.65, 0.6, 0.85, 1.0, 0.6);
    for (let n = 0; n < 8; n += 1) spark(p.x, p.y, p.z, 0, 0.4, 0, 1.2, rand(2, 6), rand(0.2, 0.45), rand(0.012, 0.02), 0.45, 0.75, 1.0, 1.1, 3);
    if (!direct) splash(p, PLASMA_R, false);
    const now = shared.sceneNowMs ?? 0;
    if (Math.abs(now - plasmaHitAt) > 45) {
      plasmaHitAt = now;
      sound.plasmaHit(p);
    }
  };

  let clock = 0;
  let cpuSum = 0;
  let cpuWorst = 0;
  let cpuN = 0;
  let logAt = performance.now();
  let fired = 0;

  const api = {
    // снаряд (kind 'rocket' | 'plasma') по пути пули: from — дуло, dir — единичное, speed — м/с,
    // g — гравитация, м/с² (та же, что у пули: from + dir·v·t − ½·g·t²) → id
    fire(kind, from, dir, speed, g = 0) {
      let i;
      if (projN < MAX_PROJ) i = projN++;
      else {
        i = 0;
        for (let k = 1; k < MAX_PROJ; k += 1) if (age[k] > age[i]) i = k;
      }
      pk[i] = kind === 'rocket' ? K_ROCKET : K_PLASMA;
      ox[i] = from.x; oy[i] = from.y; oz[i] = from.z;
      dx[i] = dir.x; dy[i] = dir.y; dz[i] = dir.z;
      spd[i] = speed; age[i] = 0; trail[i] = 0.25 / Math.max(1, speed); roll[i] = Math.random() * Math.PI * 2;
      grav[i] = g || 0;
      phase[i] = Math.random() * 100; emitAcc[i] = 0;
      ids[i] = nextId;
      nextId = (nextId + 1) % 0x7fffffff || 1;
      fired += 1;
      return ids[i];
    },
    // вспышка у дула и звук выстрела
    muzzle(kind, p, d) {
      if (kind === 'rocket') {
        part(p.x, p.y, p.z, 0, 0.09, 0.14, 0.05, 1.0, 0.6, 0.25, 2);
        part(p.x, p.y, p.z, 1, 0.25, 0.35, 0.6, 1.0, 0.45, 0.12, 1);
        // клуб вперёд от дула; выхлоп назад — небольшой и подальше за плечом (не в лицо)
        for (let n = 0; n < 4; n += 1) {
          const s = rand(1.5, 3.5);
          smokePuff(p.x + d.x * 0.15, p.y + d.y * 0.15, p.z + d.z * 0.15, d.x * s + rand(-0.4, 0.4), d.y * s + rand(-0.2, 0.4), d.z * s + rand(-0.4, 0.4), 0.05, rand(0.3, 0.5), rand(1.4, 2.2), 0.9);
        }
        for (let n = 0; n < 2; n += 1) {
          const s = rand(3, 5);
          smokePuff(p.x - d.x * 1.6, p.y - d.y * 1.6 + 0.1, p.z - d.z * 1.6, -d.x * s + rand(-0.6, 0.6), rand(0.2, 0.8), -d.z * s + rand(-0.6, 0.6), 0.06, rand(0.35, 0.55), rand(1.2, 1.8), 0.6);
        }
        for (let n = 0; n < 8; n += 1) spark(p.x, p.y, p.z, d.x, d.y, d.z, 0.45, rand(3, 9), rand(0.12, 0.3), 0.012, 1.0, 0.6, 0.2, 1, 3);
        sound.rocketLaunch(p);
      } else {
        part(p.x, p.y, p.z, 0, 0.05, 0.06, 0.02, 0.3, 0.6, 1.0, 1.4);
        part(p.x, p.y, p.z, 1, 0.09, 0.12, 0.05, 0.2, 0.45, 1.0, 0.9);
        const k = part(p.x + d.x * 0.02, p.y + d.y * 0.02, p.z + d.z * 0.02, 2, 0.1, 0.015, 0.07, 0.4, 0.7, 1.0, 0.8);
        vx[k] = d.x * 0.5; vy[k] = d.y * 0.5; vz[k] = d.z * 0.5;
        sound.plasma(p);
      }
    },
    // снаряд id кончился в p (what: 0 — время вышло, 1 — земля, 2 — мишень, 3 — стойка, 4 — цель-shootable)
    impact(id, p, what) {
      const i = findProj(id);
      if (i < 0) return;
      const kind = pk[i];
      projN -= 1;
      copyProj(i, projN);
      if (kind === K_ROCKET) explode(p);
      else plasmaImpact(p, what === 4);
    },
    // луч рейлгана: from — дуло, dir — единичное, len — м до конца; hits — расстояния попаданий (n штук);
    // endHit — луч упёрся (земля), иначе ушёл на всю дальность
    rail(from, dir, len, hits, n, endHit) {
      let b = beams[0];
      for (let i = 0; i < MAX_BEAMS; i += 1) {
        if (!beams[i].on) {
          b = beams[i];
          break;
        }
        if (beams[i].age > b.age) b = beams[i];
      }
      b.on = true;
      b.x = from.x; b.y = from.y; b.z = from.z;
      b.dx = dir.x; b.dy = dir.y; b.dz = dir.z;
      b.len = len; b.age = 0; b.phase = Math.random() * Math.PI * 2;
      // у дула
      part(from.x, from.y, from.z, 0, 0.1, 0.12, 0.03, 0.3, 1.0, 0.45, 2);
      let k = part(from.x + dir.x * 0.03, from.y + dir.y * 0.03, from.z + dir.z * 0.03, 2, 0.22, 0.02, 0.09, 0.3, 1.0, 0.45, 1.0);
      vx[k] = dir.x * 0.8; vy[k] = dir.y * 0.8; vz[k] = dir.z * 0.8;
      // искры в каждом попадании
      for (let h = 0; h < n; h += 1) {
        const t = hits[h];
        P.set(from.x + dir.x * t, from.y + dir.y * t, from.z + dir.z * t);
        part(P.x, P.y, P.z, 1, 0.35, 0.25, 0.5, 0.25, 1.0, 0.4, 1.2);
        for (let s = 0; s < 9; s += 1) spark(P.x, P.y, P.z, -dir.x * 0.3, 0.3 - dir.y * 0.3, -dir.z * 0.3, 1.0, rand(2, 7), rand(0.25, 0.6), rand(0.012, 0.022), 0.5, 1.0, 0.6, 1.2, 5);
      }
      // в конце
      P.set(from.x + dir.x * len, from.y + dir.y * len, from.z + dir.z * len);
      part(P.x, P.y, P.z, 0, 0.18, 0.35, 0.08, 0.3, 1.0, 0.45, 1.6);
      part(P.x, P.y, P.z, 1, 0.6, 0.5, 1.3, 0.2, 0.9, 0.35, 1.0);
      if (endHit) {
        k = part(P.x, P.y + 0.05, P.z, 2, 0.4, 0.05, 1.1, 0.35, 1.0, 0.5, 1.0);
        for (let s = 0; s < 16; s += 1) spark(P.x, P.y + 0.05, P.z, 0, 0.8, 0, 0.9, rand(2, 8), rand(0.3, 0.8), rand(0.014, 0.026), 0.5, 1.0, 0.6, 1.2, 6);
        smokePuff(P.x, P.y + 0.1, P.z, rand(-0.3, 0.3), rand(0.4, 1), rand(-0.3, 0.3), 0.05, rand(0.4, 0.7), rand(1.5, 2.2), 0.6);
      }
      sound.rail(from);
    },
    update(dtRaw) {
      const dt = Math.min(0.05, dtRaw || 0); // тот же шаг, что у пуль (shooting.js)
      const t0 = performance.now();
      clock = (clock + dt) % 1000;
      camera.getWorldPosition(camPos);
      // ---- снаряды: стареют; потерянные (пул пуль их вытеснил) гаснут сами
      for (let i = projN - 1; i >= 0; i -= 1) {
        age[i] += dt;
        if (age[i] > (pk[i] === K_ROCKET ? ROCKET_LIFE + 0.3 : 3.3)) {
          projN -= 1;
          copyProj(i, projN);
        }
      }
      m = 0;
      let rockets = 0;
      let nearD = 1e9;
      let near = -1;
      for (let i = 0; i < projN; i += 1) {
        const tt = age[i];
        const along = spd[i] * tt;
        const hx = ox[i] + dx[i] * along;
        const hy = oy[i] + dy[i] * along - 0.5 * grav[i] * tt * tt;
        const hz = oz[i] + dz[i] * along;
        const dist = Math.hypot(hx - camPos.x, hy - camPos.y, hz - camPos.z);
        if (pk[i] === K_ROCKET) {
          // направление полёта сейчас (касательная к параболе): нос и выхлоп — по нему
          let fx = dx[i] * spd[i];
          let fy = dy[i] * spd[i] - grav[i] * tt;
          let fz = dz[i] * spd[i];
          const fl0 = Math.hypot(fx, fy, fz) || 1;
          fx /= fl0; fy /= fl0; fz /= fl0;
          // корпус: нос по полёту, медленно вращается
          roll[i] += dt * 9;
          V.set(fx, fy, fz);
          Q.setFromUnitVectors(FWD, V);
          QR.setFromAxisAngle(AXZ, roll[i]);
          Q.multiply(QR);
          M.compose(P.set(hx, hy, hz), Q, S1);
          rMesh.setMatrixAt(rockets, M);
          rockets += 1;
          // выхлоп у сопла (0,39 м за носом)
          const tl = 0.4;
          const tx = hx - fx * tl;
          const ty = hy - fy * tl;
          const tz = hz - fz * tl;
          const fl = 0.8 + 0.2 * Math.sin(clock * 70 + phase[i]) * Math.sin(clock * 43 + phase[i] * 2);
          const big = Math.max(1, dist * 0.01); // вдали пламя не меньше ~0,6°
          put(tx, ty, tz, 0.05 * fl * big, 1.0, 0.65, 0.3, 1.6, 0);
          const fLen = (0.3 + 0.18 * fl) * big;
          put(tx, ty, tz, 0.045 * big, 1.0, 0.55, 0.15, 1.3, 4, -fx * fLen, -fy * fLen, -fz * fLen);
          put(tx - fx * 0.1, ty - fy * 0.1, tz - fz * 0.1, 0.45 * big, 1.0, 0.4, 0.1, 0.45 * fl, 1);
          // искры выхлопа
          emitAcc[i] += dt * 30;
          while (emitAcc[i] >= 1) {
            emitAcc[i] -= 1;
            spark(tx, ty, tz, -fx, -fy, -fz, 0.35, rand(3, 7), rand(0.12, 0.3), 0.01, 1.0, 0.6, 0.2, 1, 2);
          }
          // густой дымный след (общий дым smoke.js): клуб каждые ~TRAIL_STEP м по той же параболе
          // (время клуба — trail[i]; хвост — на tl м позади носа). Вдали клубы реже и крупнее (бюджет
          // smoke.js CAP), рождаются сразу пухлыми — след сплошной, а не бусами
          let puffs = 0;
          const tEnd = tt - tl / spd[i];
          const step = Math.max(TRAIL_STEP, dist * 0.035);
          while (trail[i] < tEnd && puffs < 8) {
            const ta = trail[i];
            const a = spd[i] * ta;
            const s = rand(0.8, 2);
            smokePuff(ox[i] + dx[i] * a, oy[i] + dy[i] * a - 0.5 * grav[i] * ta * ta, oz[i] + dz[i] * a, -fx * s + rand(-0.3, 0.3), -fy * s + rand(-0.2, 0.4), -fz * s + rand(-0.3, 0.3), 0.18 + step * 0.3, rand(0.6, 0.9) + step * 0.3, rand(1.9, 2.7), 1.7); // густота ×1,7 (smoke.js DENSITY её половинит)
            trail[i] += (step * rand(0.85, 1.15)) / spd[i];
            puffs += 1;
          }
          if (puffs >= 8) trail[i] = Math.max(trail[i], tEnd); // догонять пачкой не надо
          if (dist < nearD) {
            nearD = dist;
            near = i;
          }
        } else {
          // плазменный шар: ядро, ореол, короткий хвост
          const pulse = 1 + 0.15 * Math.sin(clock * 60 + phase[i]);
          const sz = Math.max(0.06, dist * 0.004) * pulse;
          put(hx, hy, hz, sz, 0.25, 0.55, 1.0, 1.5, 0);
          put(hx, hy, hz, sz * 3.6, 0.12, 0.3, 1.0, 0.85, 1);
          const tlen = Math.min(0.9, along);
          put(hx, hy, hz, sz * 0.6, 0.3, 0.6, 1.0, 0.9, 3, -dx[i] * tlen, -dy[i] * tlen, -dz[i] * tlen);
          for (let k = 1; k <= 3; k += 1) {
            const back = Math.min(along, k * 0.22);
            put(hx - dx[i] * back, hy - dy[i] * back, hz - dz[i] * back, sz * (1.6 - k * 0.3), 0.15, 0.35, 1.0, 0.35 / k, 1);
          }
        }
      }
      if (near >= 0) {
        const tn = age[near];
        const along = spd[near] * tn;
        P.set(ox[near] + dx[near] * along, oy[near] + dy[near] * along - 0.5 * grav[near] * tn * tn, oz[near] + dz[near] * along);
        sound.hiss(P, 0.9);
      } else sound.hiss(null);
      // ---- частицы
      for (let i = partN - 1; i >= 0; i -= 1) {
        pAge[i] += dt;
        if (pAge[i] >= pLife[i]) {
          partN -= 1;
          copyPart(i, partN);
        }
      }
      for (let i = 0; i < partN; i += 1) {
        const keep = Math.max(0, 1 - pDrag[i] * dt);
        vx[i] *= keep; vy[i] *= keep; vz[i] *= keep;
        vy[i] -= pGrav[i] * dt;
        px[i] += vx[i] * dt; py[i] += vy[i] * dt; pz[i] += vz[i] * dt;
        const u = pAge[i] / pLife[i];
        const kind = pKind[i];
        const a = pA[i] * (1 - u) * (kind === 2 ? 1 : 1 - u * 0.3);
        const size = kind === 2 ? s0[i] + (s1[i] - s0[i]) * (1 - (1 - u) * (1 - u)) : s0[i] + (s1[i] - s0[i]) * u;
        if (kind === 3) {
          const st = pStretch[i];
          put(px[i], py[i], pz[i], size, pr[i], pg[i], pb[i], a, 3, -vx[i] * st, -vy[i] * st, -vz[i] * st);
        } else put(px[i], py[i], pz[i], size, pr[i], pg[i], pb[i], a, kind);
      }
      // ---- лучи
      let bn = 0;
      for (let i = 0; i < MAX_BEAMS; i += 1) {
        const b = beams[i];
        if (!b.on) continue;
        b.age += dt;
        if (b.age >= BEAM_LIFE) {
          b.on = false;
          continue;
        }
        for (let kind = 0; kind < 3; kind += 1) {
          const q = bn * 4;
          bFrom[q] = b.x; bFrom[q + 1] = b.y; bFrom[q + 2] = b.z; bFrom[q + 3] = kind;
          bDir[q] = b.dx; bDir[q + 1] = b.dy; bDir[q + 2] = b.dz; bDir[q + 3] = b.len;
          bP[q] = b.age; bP[q + 1] = BEAM_LIFE; bP[q + 2] = b.phase; bP[q + 3] = kind === 0 ? 0.006 : kind === 1 ? 0.05 : 0.011;
          const c = bn * 3;
          if (kind === 0) {
            bCol[c] = 0.55; bCol[c + 1] = 1.0; bCol[c + 2] = 0.65;
          } else if (kind === 1) {
            bCol[c] = 0.12; bCol[c + 1] = 0.9; bCol[c + 2] = 0.3;
          } else {
            bCol[c] = 0.15; bCol[c + 1] = 1.0; bCol[c + 2] = 0.3;
          }
          bn += 1;
        }
      }
      // ---- в буферы
      if (m > 0 || sGeo.instanceCount > 0) {
        for (const a of sAttrs) {
          a.clearUpdateRanges();
          a.addUpdateRange(0, Math.max(1, m) * 4);
          a.needsUpdate = true;
        }
      }
      sGeo.instanceCount = m;
      if (bn > 0) {
        for (const a of bAttrs) {
          a.clearUpdateRanges();
          a.addUpdateRange(0, bn * a.itemSize);
          a.needsUpdate = true;
        }
      }
      bGeo.instanceCount = bn;
      rMesh.count = rockets;
      if (rockets) rMesh.instanceMatrix.needsUpdate = true;
      if (warm < 3) warm += 1;
      sMesh.visible = m > 0 || warm < 3;
      bMesh.visible = bn > 0 || warm < 3;
      rMesh.visible = rockets > 0 || warm < 3;
      // телеметрия — только пока есть что считать
      if (projN || partN || bn) {
        const spent = performance.now() - t0;
        cpuSum += spent;
        cpuWorst = Math.max(cpuWorst, spent);
        cpuN += 1;
      }
      if (t0 - logAt > LOG_EVERY_MS) {
        if (cpuN) console.log(`[arena] cpu=${(cpuSum / cpuN).toFixed(3)}/${cpuWorst.toFixed(2)}ms proj=${projN} parts=${partN} beams=${bn} fired=${fired}`);
        cpuSum = cpuWorst = cpuN = 0;
        logAt = t0;
      }
    },
    stats: () => ({ proj: projN, parts: partN, sprites: sGeo.instanceCount, beams: bGeo.instanceCount / 3, rockets: rMesh.count, sound: sound.stats() }),
    dispose() {
      sound.silence();
      group.remove(sMesh);
      group.remove(bMesh);
      group.remove(rMesh);
      sGeo.dispose();
      sMat.dispose();
      bGeo.dispose();
      bMat.dispose();
      rMat.dispose();
      rMesh.dispose(); // геометрия корпуса — в shared.arenaRocketGeo
      projN = 0;
      partN = 0;
    },
  };
  return api;
}
