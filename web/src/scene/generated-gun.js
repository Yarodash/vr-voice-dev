// Модель сгенерированной пушки (запись из generated-guns.js): сначала «толстая картинка» из
// card.png, потом, если glb: true и файл загрузился, — модель mesh.glb на её месте (та же группа:
// поза, «в руке», дуло — те же; меняется только то, что внутри visual).
//
// Система оружия сцены: метры, ствол −Z, верх +Y, ладонь (середина рукоятки) в HANDLE — как у
// пистолета и калаша, поэтому хват, отдача и посадка в руку работают без изменений.
//
// Картинка: 7 слоёв одной текстуры (alphaTest) поперёк толщины thicknessM, внутренние темнее, — сбоку
// сплошной силуэт, сверху не бумажная линия. Обводка «можно взять» — белый силуэт, расширенный на
// outlineM (тот же приём, что в pistols.js: обводка renderOrder 1 без глубины, пушка — 2 поверх).
// Маска разбирается один раз на картинку (analyzeCard): ширина непрозрачной части = length, дуло —
// правый край на высоте ствола, рукоятка — первый «выступ вниз» слева (у длинных — после приклада).
//
// Модель: длинная ось — ствол; какой конец дуло — по картинке (у дула силуэт ниже, чем у приклада;
// glbFlip — наоборот), верх — +Y файла (Tripo — Y вверх, картинка смотрит в +Z). Масштаб — length,
// рукоятка и дуло — в тех же долях габарита, что на картинке. Обводка — оболочка по нормалям
// (BackSide), материалы файла + weapon-env.js.
//
// Всё тяжёлое (разбор маски, холсты, загрузка и подготовка модели) — один раз на id+v в
// __sceneState.genGunCache; геометрии и материалы общие у всех экземпляров (userData.shared:
// pistols.remove их не освобождает).
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { MeshoptSimplifier } from 'three/addons/libs/meshopt_simplifier.module.js';
import { createAddedScope } from './scope-addon.js';
import { createCollimator } from './collimator.js';
import { genGunParams } from './generated-guns.js';

const HANDLE = { x: 0, y: -0.04, z: 0.045 }; // ладонь в системе оружия (main.js HANDLE)
const BASE = `${import.meta.env.BASE_URL}models/generated/`;
// правка кода построения — новый ключ кэша (иначе после подмены сцены осталась бы старая сборка)
const codeKey = (...fns) => { let s = 0; for (const fn of fns) for (const ch of fn.toString()) s = (s * 31 + ch.charCodeAt(0)) | 0; return s; };
let CARD_CODE = null; // считаются один раз на версию модуля
let GLB_CODE = null;
const ANALYZE_W = 512; // ширина холста разбора маски
const TEX_MAX_W = 1024; // ширина текстуры картинки (обрезана по пушке)
const DEFAULT_THICKNESS_M = 0.035;
const ALPHA_ON = 128;
// Упрощение сетки модели (meshoptimizer, только индекс): у Tripo 30–80 тыс. треугольников на пушку,
// пушка в руке рисуется на оба глаза (и её обводка) — треть треугольников кадра. Ошибка — доля габарита
// модели: 0,001 ≈ 1 мм на метровой пушке; вблизи (у лица) на глаз не отличить, треугольников в
// 3–3,5 раза меньше (sam_rifle 77 тыс. → 22 тыс.). entry.simplify: своя ошибка, 0 — не упрощать.
const SIMPLIFY_ERROR = 0.001;

const cacheOf = () => ((globalThis.__sceneState ??= {}).genGunCache ??= new Map());

// ---- Разбор маски: всё в долях исходной картинки (u вправо, v вниз)
export function analyzeCard(alpha, w, h, entry = {}) {
  const opaque = (x, y) => alpha[(y * w + x) * 4 + 3] >= ALPHA_ON;
  const top = new Int32Array(w).fill(-1);
  const bot = new Int32Array(w).fill(-1);
  let x0 = w, x1 = -1, y0 = h, y1 = -1;
  for (let x = 0; x < w; x += 1) {
    for (let y = 0; y < h; y += 1) {
      if (!opaque(x, y)) continue;
      if (top[x] < 0) top[x] = y;
      bot[x] = y;
    }
    if (top[x] >= 0) {
      x0 = Math.min(x0, x); x1 = Math.max(x1, x);
      y0 = Math.min(y0, top[x]); y1 = Math.max(y1, bot[x]);
    }
  }
  if (x1 < 0) return null;
  const bw = x1 - x0 + 1;
  const bh = y1 - y0 + 1;
  // высота силуэта у левого и правого края (6 %): чем модель сравнивается, какой конец — дуло
  const extent = (from, to) => {
    let lo = h, hi = -1;
    for (let x = from; x <= to; x += 1) if (top[x] >= 0) { lo = Math.min(lo, top[x]); hi = Math.max(hi, bot[x]); }
    return hi >= lo ? hi - lo + 1 : 1;
  };
  const edge = Math.max(1, Math.round(bw * 0.06));
  const heightLeft = extent(x0, x0 + edge);
  const heightRight = extent(x1 - edge, x1);
  // дуло: правые 1 % столбцов — середина их непрозрачных строк
  let mLo = h, mHi = -1;
  for (let x = Math.max(x0, x1 - Math.max(1, Math.round(bw * 0.01))); x <= x1; x += 1) {
    if (top[x] >= 0) { mLo = Math.min(mLo, top[x]); mHi = Math.max(mHi, bot[x]); }
  }
  const muzzle = [(x1 + 1) / w, ((mLo + mHi) / 2 + 0.5) / h];
  // рукоятка: «низ» силуэта по столбцам; база — 25-й перцентиль низа на 8–85 % длины (низ
  // коробки/цевья); выступы вниз глубже 5 % длины — рукоятка, спусковая скоба, магазин, приклад.
  // Длинное оружие (длина > 2,2 высоты): выступ от самого левого края — приклад, пропускается.
  const from = x0 + Math.round(bw * 0.08);
  const to = x0 + Math.round(bw * 0.85);
  const bottoms = [];
  for (let x = from; x <= to; x += 1) if (bot[x] >= 0) bottoms.push(bot[x]);
  bottoms.sort((a, b) => a - b);
  const base = bottoms.length ? bottoms[Math.floor(bottoms.length * 0.25)] : y0 + bh * 0.5;
  const thr = base + bw * 0.05;
  const long = bw > bh * 2.2;
  let grip = null;
  let segStart = -1;
  for (let x = x0; x <= x1 + 1 && !grip; x += 1) {
    const low = x <= x1 && bot[x] > thr;
    if (low && segStart < 0) segStart = x;
    if (low || segStart < 0) continue;
    const s0 = segStart, s1 = x - 1;
    segStart = -1;
    const width = s1 - s0 + 1;
    if (width < bw * 0.02 || width > bw * 0.4) continue;
    if (long && s0 <= x0 + bw * 0.02) continue; // приклад
    if (s0 > x0 + bw * 0.75) continue;
    let bottom = 0;
    for (let k = s0; k <= s1; k += 1) bottom = Math.max(bottom, bot[k]);
    const gy = Math.max(Math.round(thr) + 1, Math.round(base + 0.45 * (bottom - base)));
    // самый левый непрозрачный отрезок строки gy в пределах выступа — рукоятка
    let r0 = -1, r1 = -1;
    for (let k = s0; k <= s1; k += 1) {
      if (opaque(k, gy)) { if (r0 < 0) r0 = k; r1 = k; } else if (r0 >= 0) break;
    }
    if (r0 >= 0) grip = [((r0 + r1) / 2 + 0.5) / w, (gy + 0.5) / h];
  }
  const autoGrip = Boolean(grip);
  grip ??= [(x0 + bw * 0.35) / w, (y0 + bh * 0.6) / h];
  return {
    box: [x0 / w, y0 / h, (x1 + 1) / w, (y1 + 1) / h], // u0, v0, u1, v1
    grip: entry.grip ?? grip,
    muzzle: entry.muzzle ?? muzzle,
    autoGrip,
    edgeRatio: heightRight / heightLeft, // < 1: у дула силуэт ниже, чем у приклада
  };
}

// ---- Картинка: разбор, текстура, обводка, геометрия слоёв (один раз на id+v)
function prepareCard(THREE, image, entry, outlineM) {
  const W = image.naturalWidth || image.width;
  const H = image.naturalHeight || image.height;
  const aw = Math.min(ANALYZE_W, W);
  const ah = Math.max(1, Math.round((H * aw) / W));
  const scan = document.createElement('canvas'); // только для разбора (getImageData), не текстура
  scan.width = aw;
  scan.height = ah;
  const sg = scan.getContext('2d', { willReadFrequently: true });
  sg.drawImage(image, 0, 0, aw, ah);
  const scanData = sg.getImageData(0, 0, aw, ah).data;
  const info = analyzeCard(scanData, aw, ah, entry);
  if (!info) throw new Error('в card.png нет непрозрачных пикселей');
  const [u0, v0, u1, v1] = info.box;
  const length = entry.length ?? 0.25;
  const mPerPx = length / ((u1 - u0) * W); // метров на пиксель исходной картинки
  // текстура: обрезка по пушке с полями под обводку, не шире TEX_MAX_W
  const ts = Math.min(1, TEX_MAX_W / ((u1 - u0) * W));
  const padTex = Math.ceil((outlineM / mPerPx) * ts) + 3;
  const pad = padTex / ts;
  const cx0 = Math.max(0, Math.floor(u0 * W - pad));
  const cy0 = Math.max(0, Math.floor(v0 * H - pad));
  const cx1 = Math.min(W, Math.ceil(u1 * W + pad));
  const cy1 = Math.min(H, Math.ceil(v1 * H + pad));
  const tw = Math.max(1, Math.round((cx1 - cx0) * ts));
  const th = Math.max(1, Math.round((cy1 - cy0) * ts));
  const canvas = document.createElement('canvas');
  canvas.width = tw;
  canvas.height = th;
  canvas.getContext('2d').drawImage(image, cx0, cy0, cx1 - cx0, cy1 - cy0, 0, 0, tw, th);
  // обводка: тот же силуэт, расширенный на outlineM (копии по кругу), залитый белым
  const ring = document.createElement('canvas');
  ring.width = tw;
  ring.height = th;
  const rg = ring.getContext('2d');
  const r = (outlineM / mPerPx) * ts;
  for (const [radius, steps] of [[r, 16], [r * 0.5, 8]]) {
    for (let i = 0; i < steps; i += 1) {
      const a = (i / steps) * Math.PI * 2;
      rg.drawImage(canvas, Math.cos(a) * radius, Math.sin(a) * radius);
    }
  }
  rg.globalCompositeOperation = 'source-in';
  rg.fillStyle = '#ffffff';
  rg.fillRect(0, 0, tw, th);
  // спуск (entry.trigger.box, пиксели card.png): своя маленькая текстура, а на общей — вырезан
  const tb = entry.trigger?.box;
  let trig = null;
  if (tb) {
    const ix0 = Math.max(0, Math.floor((tb[0] - cx0) * ts)), iy0 = Math.max(0, Math.floor((tb[1] - cy0) * ts));
    const ix1 = Math.min(tw, Math.ceil((tb[2] - cx0) * ts)), iy1 = Math.min(th, Math.ceil((tb[3] - cy0) * ts));
    const tcan = document.createElement('canvas');
    tcan.width = Math.max(1, ix1 - ix0);
    tcan.height = Math.max(1, iy1 - iy0);
    tcan.getContext('2d').drawImage(canvas, ix0, iy0, tcan.width, tcan.height, 0, 0, tcan.width, tcan.height);
    canvas.getContext('2d').clearRect(ix0, iy0, ix1 - ix0, iy1 - iy0);
    trig = { canvas: tcan, rect: [cx0 + ix0 / ts, cy0 + iy0 / ts, cx0 + ix1 / ts, cy0 + iy1 / ts] };
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 16; // three ограничит максимумом устройства; резче под углом вблизи
  const outlineTexture = new THREE.CanvasTexture(ring);
  outlineTexture.anisotropy = 16;
  // из пикселей исходной картинки — в систему оружия: ладонь в HANDLE, вправо по картинке — −Z
  const gx = info.grip[0] * W;
  const gy = info.grip[1] * H;
  const toZ = (px) => HANDLE.z - (px - gx) * mPerPx;
  const toY = (py) => HANDLE.y - (py - gy) * mPerPx;
  const thickness = entry.thicknessM ?? DEFAULT_THICKNESS_M;
  // прямоугольники-картинки на толщинах xs; rect — пиксели исходной картинки
  const quads = (xs, rect = [cx0, cy0, cx1, cy1]) => {
    const n = xs.length;
    const position = new Float32Array(n * 12);
    const uv = new Float32Array(n * 8);
    const index = [];
    const zl = toZ(rect[0]), zr = toZ(rect[2]), yt = toY(rect[1]), yb = toY(rect[3]);
    xs.forEach((x, i) => {
      position.set([x, yt, zl, x, yt, zr, x, yb, zl, x, yb, zr], i * 12);
      uv.set([0, 1, 1, 1, 0, 0, 1, 0], i * 8);
      const k = i * 4;
      index.push(k, k + 2, k + 1, k + 1, k + 2, k + 3);
    });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geometry.setIndex(index);
    geometry.computeBoundingSphere();
    geometry.userData.shared = true;
    return geometry;
  };
  // две грани-картинки (с другой стороны картинка зеркальная, как и у настоящей пушки) и стенки
  // по контуру маски между ними — сплошной толстый силуэт с любого угла
  const faces = [-thickness / 2, thickness / 2];
  const geometry = quads(faces);
  const outlineGeometry = quads(faces);
  const material = new THREE.MeshBasicMaterial({ map: texture, alphaTest: 0.5, side: THREE.DoubleSide });
  material.userData.shared = true;
  // стенки: у спуска — свои (двигаются с ним); пиксель маски в спуске — по его середине
  const inTrig = trig ? (x, y) => {
    const fx = (x + 0.5) * (W / aw), fy = (y + 0.5) * (W / aw);
    return fx >= trig.rect[0] && fx < trig.rect[2] && fy >= trig.rect[1] && fy < trig.rect[3];
  } : () => false;
  const wallGeometry = buildWalls(THREE, scanData, aw, ah, W / aw, toZ, toY, thickness, (x, y) => !inTrig(x, y));
  const wallMaterial = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide });
  wallMaterial.userData.shared = true;
  let trigger = null;
  if (trig) {
    const map = new THREE.CanvasTexture(trig.canvas);
    map.colorSpace = THREE.SRGBColorSpace;
    const tm = new THREE.MeshBasicMaterial({ map, alphaTest: 0.5, side: THREE.DoubleSide });
    tm.userData.shared = true;
    trigger = {
      parts: [{ geometry: quads(faces, trig.rect), material: tm }, { geometry: buildWalls(THREE, scanData, aw, ah, W / aw, toZ, toY, thickness, inTrig), material: wallMaterial }],
      pivot: [0, toY(tb[1]), toZ((tb[0] + tb[2]) / 2)], // верх лезвия
      texture: map,
    };
  }
  const outlineMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, map: outlineTexture, alphaTest: 0.5, side: THREE.DoubleSide, depthWrite: false });
  outlineMaterial.userData.shared = true;
  const muzzle = [thickness * 0, toY(info.muzzle[1] * H), toZ(info.muzzle[0] * W)];
  const ejector = [thickness / 2, muzzle[1], HANDLE.z - 0.12 * length];
  // пиксели card.png → [y, z] в системе оружия (прицел и т. п.)
  const mapPx = (px, py) => [toY(py), toZ(px)];
  return { info, geometry, material, wallGeometry, wallMaterial, outlineGeometry, outlineMaterial, muzzle, ejector, texture, outlineTexture, size: [W, H], mapPx, mPerPx, trigger };
}

// Стенки по контуру маски (и вокруг дыр: скоба, прорези цевья): каждая граница «непрозрачный
// пиксель | прозрачный» — четырёхугольник на всю толщину; соседние на одной линии сливаются.
// Цвет — цвет картинки у края, притемнённый (верх светлее, низ темнее — читается объём).
function buildWalls(THREE, data, w, h, pxScale, toZ, toY, thickness, keep = () => true) {
  const on = (x, y) => x >= 0 && y >= 0 && x < w && y < h && data[(y * w + x) * 4 + 3] >= ALPHA_ON && keep(x, y);
  const lin = (v) => (v / 255) ** 2.2;
  const position = [];
  const color = [];
  const index = [];
  const xa = -thickness / 2, xb = thickness / 2;
  const colorAt = (x, y, shade) => {
    const k = (y * w + x) * 4;
    return [lin(data[k]) * shade, lin(data[k + 1]) * shade, lin(data[k + 2]) * shade];
  };
  // отрезок контура (в пикселях маски) от (px0, py0) до (px1, py1); цвета концов — c0, c1
  const wall = (px0, py0, px1, py1, c0, c1) => {
    const z0 = toZ(px0 * pxScale), y0 = toY(py0 * pxScale), z1 = toZ(px1 * pxScale), y1 = toY(py1 * pxScale);
    const k = position.length / 3;
    position.push(xa, y0, z0, xb, y0, z0, xa, y1, z1, xb, y1, z1);
    color.push(...c0, ...c0, ...c1, ...c1);
    index.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
  };
  const SHADE = { top: 0.8, bottom: 0.45, side: 0.6 };
  // горизонтальные границы: сверху (dy = −1) и снизу (dy = +1) пикселя
  for (const [dy, shade, edge] of [[-1, SHADE.top, 0], [1, SHADE.bottom, 1]]) {
    for (let y = 0; y < h; y += 1) {
      let start = -1;
      for (let x = 0; x <= w; x += 1) {
        const border = x < w && on(x, y) && !on(x, y + dy);
        if (border && start < 0) start = x;
        if (!border && start >= 0) {
          wall(start, y + edge, x, y + edge, colorAt(start, y, shade), colorAt(x - 1, y, shade));
          start = -1;
        }
      }
    }
  }
  // вертикальные: слева (dx = −1) и справа (dx = +1)
  for (const [dx, edge] of [[-1, 0], [1, 1]]) {
    for (let x = 0; x < w; x += 1) {
      let start = -1;
      for (let y = 0; y <= h; y += 1) {
        const border = y < h && on(x, y) && !on(x + dx, y);
        if (border && start < 0) start = y;
        if (!border && start >= 0) {
          wall(x + edge, start, x + edge, y, colorAt(x, start, SHADE.side), colorAt(x, y - 1, SHADE.side));
          start = -1;
        }
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(color, 3));
  geometry.setIndex(index);
  geometry.computeBoundingSphere();
  geometry.userData.shared = true;
  return geometry;
}

const loadCard = (THREE, entry, outlineM) => {
  const cache = cacheOf();
  const key = `card|${CARD_CODE ??= codeKey(prepareCard, buildWalls, analyzeCard)}|${entry.id}|${entry.v ?? 1}|${entry.length}|${entry.thicknessM ?? ''}|${entry.grip ?? ''}|${entry.muzzle ?? ''}|${entry.trigger?.box ?? ''}|${outlineM}`;
  let slot = cache.get(key);
  if (!slot) {
    slot = { result: undefined };
    const url = `${BASE}${entry.id}/card.png?v=${entry.v ?? 1}`;
    slot.promise = new THREE.ImageLoader().loadAsync(url)
      .then((image) => prepareCard(THREE, image, entry, outlineM))
      .catch((error) => {
        console.error(`[gen] ${entry.id}: картинка не готова (${url})`, error);
        return null;
      })
      .then((result) => (slot.result = result));
    cache.set(key, slot);
  }
  return slot;
};

// ---- Чистка сетки Tripo: вершины сшиваются по положению (с квантованием), треугольники делятся на
// связные куски; куски меньше minFrac всех треугольников (по умолчанию 0,5 %) или с габаритом меньше
// 1 % модели выбрасываются (самый большой — всегда остаётся); вырожденные и «иглы» (качество
// 4√3·S / Σ рёбер² < 1e-3) — тоже. Меняется только индекс. opts: { minFrac }.
function cleanGeometry(THREE, geometry, opts) {
  const pos = geometry.attributes.position;
  const n = pos.count;
  const src = geometry.index ? geometry.index.array : Uint32Array.from({ length: n }, (_, i) => i);
  const total = Math.floor(src.length / 3);
  geometry.computeBoundingBox();
  const diag = geometry.boundingBox.getSize(new THREE.Vector3()).length() || 1;
  const q = diag * 1e-5;
  const weld = new Int32Array(n);
  const ids = new Map();
  for (let i = 0; i < n; i += 1) {
    const key = `${Math.round(pos.getX(i) / q)},${Math.round(pos.getY(i) / q)},${Math.round(pos.getZ(i) / q)}`;
    let id = ids.get(key);
    if (id === undefined) { id = ids.size; ids.set(key, id); }
    weld[i] = id;
  }
  const parent = new Int32Array(ids.size).map((_, i) => i);
  const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  const good = new Uint8Array(total);
  for (let t = 0; t < total; t += 1) {
    const a = src[t * 3], b = src[t * 3 + 1], c = src[t * 3 + 2];
    const wa = weld[a], wb = weld[b], wc = weld[c];
    if (wa === wb || wb === wc || wa === wc) continue;
    const ux = pos.getX(b) - pos.getX(a), uy = pos.getY(b) - pos.getY(a), uz = pos.getZ(b) - pos.getZ(a);
    const vx = pos.getX(c) - pos.getX(a), vy = pos.getY(c) - pos.getY(a), vz = pos.getZ(c) - pos.getZ(a);
    const wx = vx - ux, wy = vy - uy, wz = vz - uz;
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    const area2 = Math.hypot(cx, cy, cz); // 2·S
    const edges = ux * ux + uy * uy + uz * uz + vx * vx + vy * vy + vz * vz + wx * wx + wy * wy + wz * wz;
    if (edges <= 0 || (2 * Math.sqrt(3) * area2) / edges < 1e-3) continue;
    good[t] = 1;
    const ra = find(wa), rb = find(wb), rc = find(wc);
    parent[rb] = ra;
    parent[find(rc)] = ra;
  }
  // куски: число треугольников и габарит
  const stats = new Map(); // root → { tris, min[3], max[3] }
  for (let t = 0; t < total; t += 1) {
    if (!good[t]) continue;
    const root = find(weld[src[t * 3]]);
    let s = stats.get(root);
    if (!s) { s = { tris: 0, min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] }; stats.set(root, s); }
    s.tris += 1;
    for (let k = 0; k < 3; k += 1) {
      const v = src[t * 3 + k];
      const p = [pos.getX(v), pos.getY(v), pos.getZ(v)];
      for (let d = 0; d < 3; d += 1) { if (p[d] < s.min[d]) s.min[d] = p[d]; if (p[d] > s.max[d]) s.max[d] = p[d]; }
    }
  }
  let biggest = null;
  for (const [root, s] of stats) if (!biggest || s.tris > stats.get(biggest).tris) biggest = root;
  const minTris = total * (opts?.minFrac ?? 0.005);
  const keepRoot = new Set();
  for (const [root, s] of stats) {
    const size = Math.hypot(s.max[0] - s.min[0], s.max[1] - s.min[1], s.max[2] - s.min[2]);
    if (root === biggest || (s.tris >= minTris && size >= diag * 0.01)) keepRoot.add(root);
  }
  const out = [];
  for (let t = 0; t < total; t += 1) {
    if (good[t] && keepRoot.has(find(weld[src[t * 3]]))) out.push(src[t * 3], src[t * 3 + 1], src[t * 3 + 2]);
  }
  // без неиспользуемых вершин (иначе габарит и разворот считались бы и по выброшенным)
  const remap = new Int32Array(n).fill(-1);
  let used = 0;
  for (let i = 0; i < out.length; i += 1) {
    if (remap[out[i]] < 0) remap[out[i]] = used++;
    out[i] = remap[out[i]];
  }
  const clean = new THREE.BufferGeometry();
  for (const [name, attr] of Object.entries(geometry.attributes)) {
    const size = attr.itemSize;
    const array = new attr.array.constructor(used * size);
    for (let i = 0; i < n; i += 1) {
      if (remap[i] < 0) continue;
      for (let k = 0; k < size; k += 1) array[remap[i] * size + k] = attr.getComponent(i, k);
    }
    clean.setAttribute(name, new THREE.BufferAttribute(array, size, attr.normalized));
  }
  clean.setIndex(out);
  return { geometry: clean, removed: total - out.length / 3, total, pieces: stats.size - keepRoot.size, bad: total - good.reduce((s, g) => s + g, 0) };
}

// Упрощение (SIMPLIFY_ERROR): меняется только индекс; швы UV meshoptimizer сохраняет сам. Ошибка или
// нестандартный формат вершин — модель остаётся как есть.
function simplifyParts(THREE, parts, entry) {
  const error = entry.simplify ?? SIMPLIFY_ERROR;
  if (!(error > 0)) return;
  let before = 0, after = 0;
  const t0 = performance.now();
  for (const p of parts) {
    const g = p.geometry;
    const pos = g.attributes.position;
    if (!g.index || !(pos?.array instanceof Float32Array) || pos.itemSize !== 3 || pos.isInterleavedBufferAttribute) continue;
    try {
      const src = new Uint32Array(g.index.array);
      const [index] = MeshoptSimplifier.simplify(src, pos.array, 3, 0, error, []);
      before += src.length / 3;
      after += index.length / 3;
      if (index.length >= 3) g.setIndex(new THREE.BufferAttribute(index, 1));
    } catch (err) {
      console.warn(`[gen] ${entry.id}: упрощение не удалось`, err);
    }
  }
  console.log(`[gen] ${entry.id}: упрощение ${before} → ${after} треугольников (${(performance.now() - t0).toFixed(0)} мс)`);
}

// ---- Прицел на модели (entry.scope): торцы трубы ищутся на самой модели. У каждого конца — вершины
// в цилиндре вокруг оси, проведённой по точкам card.png (±FIT_SEARCH по оси, радиус ×FIT_R от стекла
// с картинки); торец — самая дальняя по оси вершина, центр и радиус трубы — по кольцу у торца. Стекло
// ставится чуть СНАРУЖИ торца (GLASS_PROUD), а треугольники под стеклом (до FIT_DEPTH вглубь трубы)
// вырезаются: Tripo закрывает трубу выпуклой заглушкой, и она торчала перед стеклом («чёрная клякса»).
// Возвращает центры стёкол [x, y, z] и радиусы в системе оружия; parts меняет на месте (только индекс).
const FIT_SEARCH = 0.03; // м
const FIT_R = 1.5; // радиус поиска — во столько раз больше стекла с картинки
const FIT_DEPTH = 0.03; // м
const GLASS_PROUD = 0.0012; // м
function fitScope(THREE, parts, sc, mapPx, mPerPx) {
  const [ey, ez] = mapPx(sc.eyepiece[0], sc.eyepiece[1]);
  const [oy, oz] = mapPx(sc.objective[0], sc.objective[1]);
  const len = Math.hypot(oy - ey, oz - ez);
  const ay = (oy - ey) / len, az = (oz - ez) / len; // ось: от окуляра к объективу (в плоскости yz)
  const ny = -az, nz = ay; // поперёк оси в плоскости yz («вверх» прицела)
  const cardR = [(sc.radiusPx ?? 40) * mPerPx, (sc.objectiveRadiusPx ?? sc.radiusPx ?? 40) * mPerPx];
  const ends = [0, 1].map((k) => ({ t0: k ? len : 0, dir: k ? 1 : -1, R: cardR[k] * FIT_R, tEnd: k ? -Infinity : Infinity, x0: Infinity, x1: -Infinity, u0: Infinity, u1: -Infinity, cx: 0, cu: 0, rOut: 0 }));
  const local = (pos, i) => {
    const y = pos.getY(i) - ey, z = pos.getZ(i) - ez;
    return [pos.getX(i), y * ay + z * az, y * ny + z * nz]; // x, t (по оси), u (поперёк)
  };
  const eachVertex = (fn) => {
    for (const p of parts) {
      const pos = p.geometry.attributes.position;
      const idx = p.geometry.index?.array;
      const used = new Uint8Array(pos.count);
      if (idx) for (let i = 0; i < idx.length; i += 1) used[idx[i]] = 1;
      else used.fill(1);
      for (let i = 0; i < pos.count; i += 1) if (used[i]) fn(...local(pos, i));
    }
  };
  // 1) торец: самая дальняя вершина
  eachVertex((x, t, u) => {
    for (const e of ends) {
      if (Math.abs(t - e.t0) > FIT_SEARCH || Math.hypot(x, u) > e.R) continue;
      e.tEnd = e.dir > 0 ? Math.max(e.tEnd, t) : Math.min(e.tEnd, t);
    }
  });
  if (!ends.every((e) => Number.isFinite(e.tEnd))) return null;
  // 2) кольцо у торца (12 мм вглубь): центр по размаху, радиус трубы
  const ring = (e, t) => (e.tEnd - t) * e.dir < 0.012 && Math.abs(t - e.t0) <= FIT_SEARCH;
  eachVertex((x, t, u) => {
    for (const e of ends) {
      if (!ring(e, t) || Math.hypot(x, u) > e.R) continue;
      e.x0 = Math.min(e.x0, x); e.x1 = Math.max(e.x1, x); e.u0 = Math.min(e.u0, u); e.u1 = Math.max(e.u1, u);
    }
  });
  for (const e of ends) { e.cx = (e.x0 + e.x1) / 2; e.cu = (e.u0 + e.u1) / 2; }
  eachVertex((x, t, u) => {
    for (const e of ends) if (ring(e, t) && Math.hypot(x, u) <= e.R) e.rOut = Math.max(e.rOut, Math.hypot(x - e.cx, u - e.cu));
  });
  // стекло: с картинки, но не меньше 0,7 радиуса трубы на модели
  // (сверху не ограничено: стекло больше трубы — по просьбе, ободок тогда просто шире стекла на 4 %)
  ends.forEach((e, k) => { e.glassR = Math.max(cardR[k], 0.7 * e.rOut); });
  // 3) вырез под стеклом
  let cut = 0;
  for (const p of parts) {
    const g = p.geometry;
    const pos = g.attributes.position;
    const idx = g.index ? g.index.array : Array.from({ length: pos.count }, (_, i) => i);
    const keep = [];
    for (let i = 0; i + 2 < idx.length; i += 3) {
      const A = local(pos, idx[i]), B = local(pos, idx[i + 1]), C = local(pos, idx[i + 2]);
      const x = (A[0] + B[0] + C[0]) / 3, t = (A[1] + B[1] + C[1]) / 3, u = (A[2] + B[2] + C[2]) / 3;
      // только треугольники ЦЕЛИКОМ под стеклом: край выреза не выходит за стекло — дыр вокруг нет
      const inside = ends.some((e) => {
        const depth = (e.tEnd - t) * e.dir;
        const r = (P) => Math.hypot(P[0] - e.cx, P[2] - e.cu);
        return depth > -0.002 && depth < FIT_DEPTH && r(A) < e.glassR && r(B) < e.glassR && r(C) < e.glassR;
      });
      if (inside) cut += 1;
      else keep.push(idx[i], idx[i + 1], idx[i + 2]);
    }
    if (keep.length !== idx.length) g.setIndex(keep);
  }
  const point = (e) => {
    const t = e.tEnd + e.dir * GLASS_PROUD;
    return [e.cx, ey + t * ay + e.cu * ny, ez + t * az + e.cu * nz];
  };
  const [eye, obj] = ends;
  // ringR — внешний радиус тёмного ободка вокруг стекла (закрывает щель между стеклом и стенкой трубы)
  const fit = { eye: point(eye), objective: point(obj), lensR: eye.glassR, objectiveR: obj.glassR, tubeR: [eye.rOut, obj.rOut], ringR: [Math.max(eye.glassR * 1.04, eye.rOut * 0.97), Math.max(obj.glassR * 1.04, obj.rOut * 0.97)], cut };
  const mm = (n) => (n * 1000).toFixed(1);
  console.log(`[gen] прицел по модели: торцы ${mm(eye.tEnd)} / ${mm(obj.tEnd - len)} мм от точек картинки, центр окуляра x ${mm(eye.cx)} u ${mm(eye.cu)}, труба r ${mm(eye.rOut)} / ${mm(obj.rOut)}, стёкла r ${mm(eye.glassR)} / ${mm(obj.glassR)} мм, вырезано ${cut} треугольников`);
  return fit;
}

// ---- Модель: ориентация, масштаб, совмещение с картинкой, обводка (один раз на id+v)
function prepareGlb(THREE, gltf, entry, card, outlineM) {
  const shared = globalThis.__sceneState ?? {};
  gltf.scene.updateMatrixWorld(true);
  const parts = [];
  gltf.scene.traverse((o) => {
    if (!o.isMesh) return;
    const geometry = o.geometry.clone();
    geometry.applyMatrix4(o.matrixWorld);
    parts.push({ geometry, material: o.material });
  });
  if (!parts.length) throw new Error('в mesh.glb нет мешей');
  // чистка (entry.clean !== false): оторванные клочья и вырожденные треугольники — до габаритов,
  // иначе клочок за прикладом удлинил бы «ствол» и сдвинул масштаб
  if (entry.clean !== false) {
    let removed = 0, total = 0, pieces = 0, bad = 0;
    for (const p of parts) {
      const r = cleanGeometry(THREE, p.geometry, entry.clean);
      p.geometry.dispose();
      p.geometry = r.geometry;
      removed += r.removed; pieces += r.pieces; bad += r.bad;
      total += r.total;
    }
    console.log(`[gen] ${entry.id}: чистка модели — убрано ${removed} из ${total} треугольников (оторванных кусков ${pieces}, вырожденных и игл ${bad})`);
  }
  simplifyParts(THREE, parts, entry);
  const box = new THREE.Box3();
  for (const p of parts) { p.geometry.computeBoundingBox(); box.union(p.geometry.boundingBox); }
  const size = box.getSize(new THREE.Vector3());
  const axes = [0, 1, 2].sort((a, b) => size.getComponent(b) - size.getComponent(a));
  const along = axes[0]; // ствол
  // верх: +Y файла, если ствол не по Y; иначе — средняя по длине ось
  const upAxis = along !== 1 && axes[2] !== 1 ? 1 : axes[1];
  // какой конец — дуло: у дула силуэт ниже (как на картинке: edgeRatio = справа / слева)
  const lo = box.min.getComponent(along), len = size.getComponent(along);
  let minA = Infinity, maxA = -Infinity, minB = Infinity, maxB = -Infinity;
  for (const p of parts) {
    const pos = p.geometry.attributes.position;
    for (let i = 0; i < pos.count; i += 1) {
      const t = (pos.getComponent(i, along) - lo) / len;
      const u = pos.getComponent(i, upAxis);
      if (t < 0.06) { minA = Math.min(minA, u); maxA = Math.max(maxA, u); }
      else if (t > 0.94) { minB = Math.min(minB, u); maxB = Math.max(maxB, u); }
    }
  }
  const ratioPlus = Math.max(1e-6, maxB - minB) / Math.max(1e-6, maxA - minA); // «дуло на +оси»: дуло / приклад
  const cardRatio = card?.info.edgeRatio ?? 0.5;
  let plus = Math.log(ratioPlus) * Math.log(cardRatio) >= 0 || Math.abs(Math.log(ratioPlus)) < 0.05; // по умолчанию: вправо по картинке = +ось
  if (entry.glbFlip) plus = !plus;
  const m = new THREE.Vector3().setComponent(along, plus ? 1 : -1);
  const up = new THREE.Vector3().setComponent(upAxis, 1);
  const ex = new THREE.Vector3().crossVectors(m, up);
  const rotation = new THREE.Matrix4().makeBasis(ex, up, m.clone().negate()).transpose(); // файл → оружие
  const scale = (entry.length ?? 0.25) / len;
  const transform = new THREE.Matrix4().makeScale(scale, scale, scale).multiply(rotation);
  const gunBox = new THREE.Box3();
  for (const p of parts) {
    p.geometry.applyMatrix4(transform);
    p.geometry.computeBoundingBox();
    gunBox.union(p.geometry.boundingBox);
  }
  // рукоятка и дуло — в тех же долях габарита, что на картинке
  const fr = (point) => {
    if (!card) return [0.35, 0.6];
    const [u0, v0, u1, v1] = card.info.box;
    return [(point[0] - u0) / (u1 - u0), (point[1] - v0) / (v1 - v0)];
  };
  const [gu, gv] = fr(card?.info.grip ?? [0, 0]);
  const [, mv] = card ? fr(card.info.muzzle) : [1, 0.3];
  const yAt = (v) => gunBox.max.y - v * (gunBox.max.y - gunBox.min.y);
  const shift = new THREE.Vector3(
    HANDLE.x - (gunBox.min.x + gunBox.max.x) / 2,
    HANDLE.y - yAt(gv),
    HANDLE.z - (gunBox.max.z - gu * (gunBox.max.z - gunBox.min.z)), // приклад — +Z, дуло — −Z
  );
  const shells = [];
  for (const p of parts) {
    const g = p.geometry;
    g.translate(shift.x, shift.y, shift.z);
    g.computeBoundingSphere();
    g.userData.shared = true;
    // те же вершины без швов (UV режут сетку): сглаженные нормали для обводки и для самой модели
    const bare = new THREE.BufferGeometry();
    bare.setAttribute('position', g.attributes.position.clone());
    if (g.index) bare.setIndex(g.index.clone());
    const shell = mergeVertices(bare, 1e-4);
    bare.dispose();
    shell.computeVertexNormals();
    const pos = shell.attributes.position;
    const nor = shell.attributes.normal;
    if (!g.attributes.normal) {
      // у Tripo нормалей в файле нет (GLTFLoader тогда включает flatShading — гранёно): берём
      // сглаженные из сшитой копии, по совпадающему положению
      const keyOf = (a, i) => `${Math.round(a.getX(i) * 1e5)},${Math.round(a.getY(i) * 1e5)},${Math.round(a.getZ(i) * 1e5)}`;
      const byPos = new Map();
      for (let i = 0; i < pos.count; i += 1) byPos.set(keyOf(pos, i), i);
      const gp = g.attributes.position;
      const normals = new Float32Array(gp.count * 3);
      for (let i = 0; i < gp.count; i += 1) {
        const j = byPos.get(keyOf(gp, i));
        if (j === undefined) continue;
        normals[i * 3] = nor.getX(j); normals[i * 3 + 1] = nor.getY(j); normals[i * 3 + 2] = nor.getZ(j);
      }
      g.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
      p.material.flatShading = false;
      p.material.needsUpdate = true;
    }
    for (let i = 0; i < pos.count; i += 1) {
      pos.setXYZ(i, pos.getX(i) + nor.getX(i) * outlineM, pos.getY(i) + nor.getY(i) * outlineM, pos.getZ(i) + nor.getZ(i) * outlineM);
    }
    shell.deleteAttribute('normal');
    shells.push(shell);
    const mat = p.material;
    if (mat.isMeshStandardMaterial) {
      mat.envMap = shared.weaponEnv ?? null;
      mat.envMapIntensity = 0.35;
      if (mat.map) mat.map.anisotropy = 16;
    }
    mat.userData.shared = true;
  }
  const outlineGeometry = shells.length > 1 ? mergeGeometries(shells) : shells[0];
  if (shells.length > 1) shells.forEach((s) => s.dispose());
  outlineGeometry.computeBoundingSphere();
  outlineGeometry.userData.shared = true;
  const muzzle = [0, yAt(mv) + shift.y, gunBox.min.z + shift.z];
  const ejector = [gunBox.max.x + shift.x, muzzle[1], HANDLE.z - 0.12 * (entry.length ?? 0.25)];
  // пиксели card.png → [y, z]: в тех же долях габарита, что на картинке
  const mapPx = card ? (px, py) => {
    const [f, g] = fr([px / card.size[0], py / card.size[1]]);
    return [yAt(g) + shift.y, gunBox.max.z - f * (gunBox.max.z - gunBox.min.z) + shift.z];
  } : null;
  // спуск: треугольники, чей центр (по y, z; на всю толщину) в entry.trigger.box, — отдельный меш
  // на тех же буферах вершин (только свой индекс), поворачивается вокруг верха рамки
  let trigger = null;
  const tb = entry.trigger?.box;
  if (tb && mapPx) {
    const [yTop, zA] = mapPx(tb[0], tb[1]);
    const [yBot, zB] = mapPx(tb[2], tb[3]);
    const trigParts = [];
    for (const p of parts) {
      const g = p.geometry;
      const pos = g.attributes.position;
      const idx = g.index ? g.index.array : Array.from({ length: pos.count }, (_, i) => i);
      const keep = [], cut = [];
      for (let t = 0; t + 2 < idx.length; t += 3) {
        const a = idx[t], b = idx[t + 1], c = idx[t + 2];
        const cy = (pos.getY(a) + pos.getY(b) + pos.getY(c)) / 3;
        const cz = (pos.getZ(a) + pos.getZ(b) + pos.getZ(c)) / 3;
        (cy <= yTop && cy >= yBot && cz <= zA && cz >= zB ? cut : keep).push(a, b, c);
      }
      if (!cut.length) continue;
      const split = (list) => {
        const out = new THREE.BufferGeometry();
        for (const [name, attr] of Object.entries(g.attributes)) out.setAttribute(name, attr); // общие буферы
        out.setIndex(list);
        out.computeBoundingSphere();
        out.userData.shared = true;
        return out;
      };
      p.geometry = split(keep);
      trigParts.push({ geometry: split(cut), material: p.material });
    }
    if (trigParts.length) trigger = { parts: trigParts, pivot: [0, yTop, (zA + zB) / 2] };
  }
  const scopeFit = entry.scope && mapPx ? fitScope(THREE, parts, entry.scope, mapPx, card.mPerPx) : null;
  return { parts, outlineGeometry, muzzle, ejector, plus, ratioPlus, cardRatio, mapPx, mPerPx: card?.mPerPx ?? null, trigger, scopeFit };
}

const loadGlb = (THREE, entry, cardSlot, outlineM) => {
  const cache = cacheOf();
  const key = `glb|${GLB_CODE ??= codeKey(prepareGlb, prepareCard, analyzeCard, cleanGeometry, simplifyParts, fitScope)}|${SIMPLIFY_ERROR}|${entry.simplify ?? ''}|${JSON.stringify(entry.clean ?? true)}|${entry.id}|${entry.v ?? 1}|${entry.length}|${entry.grip ?? ''}|${entry.muzzle ?? ''}|${Boolean(entry.glbFlip)}|${entry.trigger?.box ?? ''}|${entry.scope ? [entry.scope.eyepiece, entry.scope.objective, entry.scope.radiusPx, entry.scope.objectiveRadiusPx] : ''}|${outlineM}`;
  let slot = cache.get(key);
  if (!slot) {
    slot = { result: undefined };
    const url = `${BASE}${entry.id}/mesh.glb?v=${entry.v ?? 1}`;
    slot.promise = Promise.all([new GLTFLoader().loadAsync(url), cardSlot?.promise ?? null, MeshoptSimplifier.ready])
      .then(([gltf, card]) => prepareGlb(THREE, gltf, entry, card, outlineM))
      .catch((error) => {
        console.error(`[gen] ${entry.id}: модель не готова (${url})`, error);
        return null;
      })
      .then((result) => (slot.result = result));
    cache.set(key, slot);
  }
  return slot;
};

// ---- Заглушка (этап 0: картинки ещё нет): условный силуэт по shape, полупрозрачная голограмма с
// бегущей полосой и табличка «<name> — генерирую…». Детали — в системе прототипа (ладонь в начале
// координат, y вверх, ствол −Z), потом масштаб под length и ладонь в HANDLE.
// [cx, cy, cz, sx, sy, sz, наклон вокруг X]
const SHAPES = {
  rifle: { ref: 1.06, parts: [
    [0, 0, 0, 0.03, 0.1, 0.035, 0.3], [0, 0.075, -0.06, 0.035, 0.06, 0.3, 0], [0, 0.08, -0.33, 0.045, 0.05, 0.26, 0],
    [0, 0.085, -0.56, 0.02, 0.02, 0.22, 0], [0, -0.02, -0.13, 0.025, 0.14, 0.05, -0.2], [0, 0.04, 0.24, 0.035, 0.1, 0.3, 0],
    [0, 0.12, -0.05, 0.015, 0.03, 0.1, 0],
  ] },
  smg: { ref: 0.64, parts: [
    [0, 0, 0, 0.03, 0.1, 0.035, 0.25], [0, 0.07, -0.08, 0.04, 0.07, 0.3, 0], [0, 0.08, -0.3, 0.02, 0.02, 0.12, 0],
    [0, -0.04, -0.12, 0.025, 0.16, 0.035, 0], [0, 0.05, 0.18, 0.02, 0.05, 0.2, 0],
  ] },
  pistol: { ref: 0.19, parts: [
    [0, 0, 0, 0.03, 0.11, 0.035, 0.25], [0, 0.07, -0.05, 0.03, 0.035, 0.19, 0], [0, 0.045, -0.06, 0.026, 0.02, 0.15, 0],
    [0, 0.02, -0.05, 0.008, 0.02, 0.04, 0],
  ] },
};
SHAPES.shotgun = SHAPES.rifle;
SHAPES.sniper = SHAPES.rifle;

const HOLO_VERTEX = /* glsl */ `
  varying vec3 vPos;
  varying vec3 vNormal;
  varying vec3 vView;
  void main() {
    vPos = position;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vNormal = normalize(normalMatrix * normal);
    vView = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
  }
`;
const HOLO_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uLength;
  varying vec3 vPos;
  varying vec3 vNormal;
  varying vec3 vView;
  void main() {
    float rim = pow(1.0 - abs(dot(normalize(vNormal), normalize(vView))), 2.0);
    float band = fract(-vPos.z / uLength * 0.8 - uTime * 0.5);
    float scan = smoothstep(0.0, 0.08, band) * (1.0 - smoothstep(0.08, 0.2, band));
    float lines = 0.5 + 0.5 * sin(vPos.y * 900.0 + uTime * 6.0);
    vec3 color = vec3(0.28, 0.45, 0.72) * (0.5 + 0.8 * rim + 0.9 * scan) + vec3(0.5, 0.8, 1.0) * scan * 0.5;
    float alpha = clamp(0.18 + 0.5 * rim + 0.4 * scan + 0.06 * lines, 0.0, 0.85);
    gl_FragColor = vec4(color, alpha);
  }
`;

function preparePlaceholder(THREE, entry, outlineM) {
  const length = entry.length ?? 0.25;
  const shape = SHAPES[entry.shape] ?? (length < 0.35 ? SHAPES.pistol : length < 0.75 ? SHAPES.smg : SHAPES.rifle);
  const s = length / shape.ref;
  const boxes = (grow) => mergeGeometries(shape.parts.map(([cx, cy, cz, sx, sy, sz, tilt]) => {
    const g = new THREE.BoxGeometry(sx * s + grow * 2, sy * s + grow * 2, sz * s + grow * 2);
    if (tilt) g.rotateX(tilt);
    g.translate(cx * s + HANDLE.x, cy * s + HANDLE.y, cz * s + HANDLE.z);
    return g;
  }));
  const geometry = boxes(0);
  geometry.computeBoundingBox();
  geometry.userData.shared = true;
  const outlineGeometry = boxes(outlineM);
  outlineGeometry.deleteAttribute('normal');
  outlineGeometry.userData.shared = true;
  const shared = (globalThis.__sceneState ??= {});
  const material = new THREE.ShaderMaterial({
    uniforms: { uTime: (shared.genHoloTime ??= { value: 0 }), uLength: { value: length } },
    vertexShader: HOLO_VERTEX, fragmentShader: HOLO_FRAGMENT, transparent: true, depthWrite: false, side: THREE.DoubleSide,
  });
  material.userData.shared = true;
  // табличка: имя и «генерирую…»
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 128;
  const g = canvas.getContext('2d');
  g.fillStyle = 'rgba(20, 32, 52, 0.75)';
  g.beginPath();
  g.roundRect(4, 4, 504, 120, 24);
  g.fill();
  g.fillStyle = '#d8ecff';
  g.textAlign = 'center';
  g.font = 'bold 52px sans-serif';
  g.fillText(entry.name ?? entry.id, 256, 58);
  g.font = '34px sans-serif';
  g.fillStyle = '#9cc4ff';
  g.fillText('генерирую…', 256, 104);
  const labelTexture = new THREE.CanvasTexture(canvas);
  labelTexture.colorSpace = THREE.SRGBColorSpace;
  const labelMaterial = new THREE.SpriteMaterial({ map: labelTexture, transparent: true, depthWrite: false });
  labelMaterial.userData.shared = true;
  const box = geometry.boundingBox;
  // дуло — перед самой передней детали, на её высоте
  let front = shape.parts[0];
  for (const part of shape.parts) if (part[2] - part[5] / 2 < front[2] - front[5] / 2) front = part;
  const muzzle = [0, front[1] * s + HANDLE.y, box.min.z];
  const ejector = [0.02, (front[1] * s + HANDLE.y + HANDLE.y) / 2 + 0.03 * s, HANDLE.z - 0.12 * length];
  return { geometry, outlineGeometry, material, labelMaterial, labelTexture, label: [0, box.max.y + 0.06, (box.min.z + box.max.z) / 2], muzzle, ejector };
}

const placeholderOf = (THREE, entry, outlineM) => {
  const cache = cacheOf();
  const key = `holo|${HOLO_CODE ??= codeKey(preparePlaceholder, HOLO_FRAGMENT, HOLO_VERTEX)}|${entry.id}|${entry.name}|${entry.length}|${entry.shape ?? ''}|${outlineM}`;
  if (!cache.has(key)) cache.set(key, { result: preparePlaceholder(THREE, entry, outlineM) });
  return cache.get(key).result;
};
let HOLO_CODE = null;

const EYE_OFF = 0.003; // стёкла чуть снаружи торцов прицела (иначе тонут в картинке/модели)

// Сразу возвращает группу и всё для стрельбы. Что внутри visual: заглушка (пока нет картинки) →
// картинка (card !== false и загрузилась) → модель (glb: true и загрузилась); из кэша — в том же
// кадре. outline — Mesh, видимость которого включает main.js (paintPistols). Модель и есть item
// (pistols.js не копирует её), поэтому прицел (scope, lens) и спуск (trigger) можно ставить позже.
export function buildGenerated(THREE, entry, { outlineMaterial, outlineM = 0.0025, makeLens = null }) {
  const group = new THREE.Group();
  const visual = new THREE.Group();
  group.add(visual);
  const outline = new THREE.Mesh(new THREE.BufferGeometry(), outlineMaterial);
  outline.visible = false;
  outline.renderOrder = 901; // после неба (900)
  group.add(outline);
  const length = entry.length ?? 0.25;
  const muzzle = new THREE.Vector3(0, 0.03, HANDLE.z - length * 0.7);
  const ejector = new THREE.Vector3(0.02, 0.03, HANDLE.z - 0.12 * length);
  // спуск «светится» у пушки в руке (paintPistols): у картинки и модели свечения нет — пустышка
  const accent = new THREE.MeshStandardMaterial({ emissive: 0x000000 });
  const model = { group, accent, muzzle, ejector, outline, gen: { id: entry.id, shows: 'none' } };
  // спуск: пивот в группе сразу (pistols.updateTriggers крутит его по курку), детали — по готовности
  const triggerPivot = entry.trigger ? new THREE.Group() : null;
  if (triggerPivot) {
    group.add(triggerPivot);
    model.trigger = { pivot: triggerPivot, maxAngle: entry.trigger.maxAngle ?? 0.35 };
  }
  // прицел: mount — в точке окуляра, −Z смотрит на объектив; node — узел для наклона (updateLenses)
  const mount = entry.scope ? new THREE.Group() : null;
  const scopeNode = mount ? new THREE.Group() : null;
  let ringMaterial = null; // ободки стёкол (placeScope)
  if (mount) {
    mount.add(scopeNode);
    group.add(mount);
  }
  // прицел-модель (addScope, scope-addon.js): корпус и стёкла над коробкой, если на картинке прицела нет
  const added = entry.addScope && !entry.scope ? createAddedScope(THREE, entry.addScope, { outlineMaterial, outlineM, makeLens, model }) : null;
  if (added) group.add(added.mount);
  // коллиматор (collimator.js): red-dot на рельсе, точка на бесконечности, пристрелян по пуле этой пушки
  const collimator = entry.collimator ? createCollimator(THREE, entry.collimator, { outlineMaterial, outlineM, model, fire: genGunParams(entry) }) : null;
  if (collimator) group.add(collimator.mount);
  const placeScope = (from) => {
    added?.place(from);
    collimator?.place(from);
    const sc = entry.scope;
    if (!mount || !from.mapPx || !from.mPerPx) return;
    // у модели — стёкла по настоящим торцам трубы (fitScope, уже снаружи торца), у картинки — по точкам
    const fit = from.scopeFit ?? null;
    const [ey, ez] = from.mapPx(sc.eyepiece[0], sc.eyepiece[1]);
    const [oy, oz] = from.mapPx(sc.objective[0], sc.objective[1]);
    const e = fit?.eye ?? [0, ey, ez];
    const o = fit?.objective ?? [0, oy, oz];
    const pad = fit ? 0 : EYE_OFF;
    const dx = o[0] - e[0], dy = o[1] - e[1], dz = o[2] - e[2];
    const dist = Math.hypot(dx, dy, dz);
    const off = sc.offset ?? [0, 0, 0]; // подгонка стёкол к трубе прицела, м (x вправо, y вверх, z назад)
    mount.position.set(e[0] + off[0], e[1] + off[1], e[2] + off[2]);
    mount.rotation.set(Math.atan2(dy, Math.hypot(dx, dz)), Math.atan2(-dx, -dz), 0, 'YXZ'); // −Z — на объектив
    const objectiveR = fit?.objectiveR ?? (sc.objectiveRadiusPx ?? sc.radiusPx ?? 40) * from.mPerPx;
    const lensR = fit?.lensR ?? (sc.radiusPx ?? 40) * from.mPerPx;
    // стекло окуляра другого радиуса (картинка → модель) — пересоздать: радиус зашит в геометрию и шейдер
    if (model.scope && model.lens && Math.abs(model.scope.lensR - lensR) > 0.0005) {
      model.lens.dispose();
      model.lens = null;
      model.scope = null;
    }
    if (!model.scope) {
      model.scope = {
        node: scopeNode, y: 0, eyepieceZ: pad, objectiveZ: -dist - pad, objectiveR,
        lensR, minZ: 0, maxZ: 0, defaultZ: 0,
        magnification: sc.zoom ?? 4, tanApparent: sc.tanApparent ?? 0.26, reticle: sc.reticle ?? 'duplex',
      };
      model.lens = makeLens?.(model.scope) ?? null;
      if (model.lens) {
        model.lens.eyepiece.renderOrder = model.lens.objective.renderOrder = 902;
        scopeNode.add(model.lens.eyepiece, model.lens.objective);
      }
    }
    model.scope.eyepieceZ = pad;
    model.scope.objectiveZ = -dist - pad;
    model.scope.objectiveR = objectiveR;
    if (model.lens) {
      model.lens.eyepiece.position.set(0, 0, pad);
      model.lens.objective.position.set(0, 0, -dist - pad);
      model.lens.objective.scale.setScalar(objectiveR);
    }
    // тёмные ободки вокруг стёкол (только у модели): от края стекла почти до стенки трубы, чуть
    // глубже стекла — через щель между стеклом и вырезом не видно фона
    for (const ring of model.scopeRings ?? []) { ring.removeFromParent(); ring.geometry.dispose(); }
    model.scopeRings = [];
    if (fit) {
      ringMaterial ??= new THREE.MeshStandardMaterial({ color: 0x14111b, roughness: 0.55, metalness: 0.3, side: THREE.DoubleSide });
      const rings = [[lensR, fit.ringR[0], -0.0006], [objectiveR, fit.ringR[1], -dist + 0.0006]];
      for (const [r0, r1, z] of rings) {
        const ring = new THREE.Mesh(new THREE.RingGeometry(r0 * 0.97, r1, 48, 1), ringMaterial);
        ring.position.z = z;
        ring.renderOrder = 902;
        scopeNode.add(ring);
        model.scopeRings.push(ring);
      }
    }
  };
  const placeTrigger = (from) => {
    if (!triggerPivot) return;
    triggerPivot.clear();
    const t = from.trigger;
    if (!t) return;
    triggerPivot.position.fromArray(t.pivot);
    for (const part of t.parts) {
      const mesh = new THREE.Mesh(part.geometry, part.material);
      mesh.position.set(-t.pivot[0], -t.pivot[1], -t.pivot[2]);
      mesh.renderOrder = 902;
      triggerPivot.add(mesh);
    }
  };
  const show = (objects, outlineGeometry, outlineMat, from, shows) => {
    visual.clear();
    for (const object of objects) {
      if (object.isMesh) object.renderOrder = 902;
      visual.add(object);
    }
    outline.geometry = outlineGeometry;
    outline.material = outlineMat;
    muzzle.fromArray(from.muzzle);
    ejector.fromArray(from.ejector);
    placeTrigger(from);
    placeScope(from);
    model.gen.shows = shows;
  };
  const showPlaceholder = () => {
    const holo = placeholderOf(THREE, entry, outlineM);
    const mesh = new THREE.Mesh(holo.geometry, holo.material);
    mesh.renderOrder = 3; // прозрачная: после обводки и оружия
    mesh.onBeforeRender = () => { holo.material.uniforms.uTime.value = performance.now() / 1000; };
    const label = new THREE.Sprite(holo.labelMaterial);
    label.position.fromArray(holo.label);
    label.scale.set(0.2, 0.05, 1);
    label.renderOrder = 3;
    show([mesh, label], holo.outlineGeometry, outlineMaterial, holo, 'placeholder');
    mesh.renderOrder = 3;
  };
  const showCard = (card) => {
    if (!card || model.gen.shows === 'glb') return;
    show([new THREE.Mesh(card.geometry, card.material), new THREE.Mesh(card.wallGeometry, card.wallMaterial)], card.outlineGeometry, card.outlineMaterial, card, 'card');
  };
  const showGlb = (glb) => {
    if (!glb) return;
    show(glb.parts.map((p) => new THREE.Mesh(p.geometry, p.material)), glb.outlineGeometry, outlineMaterial, glb, 'glb');
  };
  const outlineKey = outlineM * 1.2; // у картинки обводка чуть толще: тонкая кайма у картинки теряется
  const cardSlot = entry.card !== false ? loadCard(THREE, entry, outlineKey) : null;
  const glbSlot = entry.glb ? loadGlb(THREE, entry, cardSlot, outlineM) : null;
  if (glbSlot?.result) showGlb(glbSlot.result);
  else {
    if (cardSlot?.result) showCard(cardSlot.result);
    else {
      showPlaceholder();
      cardSlot?.promise.then(showCard);
    }
    glbSlot?.promise.then(showGlb);
  }
  return model;
}

// для npm run vr:eval: что разобрано из картинок и как легла модель
export function genGunDebug() {
  const out = {};
  for (const [key, slot] of cacheOf()) {
    const r = slot.result;
    if (!r) { out[key] = r === null ? 'ошибка' : 'грузится'; continue; }
    out[key] = key.startsWith('holo') ? { muzzleM: r.muzzle.map((n) => +n.toFixed(3)) } : key.startsWith('card')
      ? { grip: r.info.grip.map((n) => +n.toFixed(3)), muzzle: r.info.muzzle.map((n) => +n.toFixed(3)), autoGrip: r.info.autoGrip, box: r.info.box.map((n) => +n.toFixed(3)), edgeRatio: +r.info.edgeRatio.toFixed(3), muzzleM: r.muzzle.map((n) => +n.toFixed(3)), size: r.size, trigger: Boolean(r.trigger) }
      : { muzzleM: r.muzzle.map((n) => +n.toFixed(3)), muzzleOnPlusAxis: r.plus, ratioPlus: +r.ratioPlus.toFixed(3), cardRatio: +r.cardRatio.toFixed(3), trigger: Boolean(r.trigger) };
  }
  return out;
}
