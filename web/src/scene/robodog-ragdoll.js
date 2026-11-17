// Робопёс: тряпичная кукла (ragdoll) после смерти — без three.js (проверяется в node).
//
// Классический дешёвый способ (Якобсен, «Advanced Character Physics»): частицы Верле в суставах и
// связи-расстояния между ними. 16 частиц: 8 жёстко связаны в корпус (4 тазовых узла, 2 точки
// сверху, нос, хвост — все попарно, корпус не мнётся), у каждой ноги колено и стопа (кости — связи
// длины бедра и голени). Пределы: стопа не складывается к тазу и не проходит сквозь корпус.
// «Мышцы» — мягкие связи стопы и колена с корпусом, длины из позы в момент смерти: пока сила мышц
// не упала до нуля, пёс ещё стоит и дёргается, потом ноги подкашиваются. Земля — по высоте
// ground(x, z): частица не уходит ниже, на касании трение гасит скорость вдоль земли.
// Подшаг 1/120 с (один на кадр шлема), 10 итераций связей, скорость частиц ограничена; успокоился —
// засыпает, пока его не толкнут.
import { HIPS, L1, L2 } from './robodog-gait.js';

export const BODY_POINTS = [
  ...HIPS, // 0–3: тазовые узлы ЛП, ПП, ЛЗ, ПЗ
  [0, 0.08, -0.26], // 4: верх спереди
  [0, 0.08, 0.26], // 5: верх сзади
  [0, 0, -0.43], // 6: нос (сенсорная голова)
  [0, 0, 0.38], // 7: хвост (задний бампер)
];
export const KNEE = 8; // 8–11 колени, 12–15 стопы (порядок ног как у HIPS)
export const FOOT = 12;
export const COUNT = 16;
const SUBSTEP = 1 / 120;
const ITERATIONS = 10;
const MAX_SPEED = 14; // м/с: сильные толчки не рвут связи (скорость частицы не больше этой)
const GRAVITY = 9.81;
const FRICTION = 0.55; // доля скорости вдоль земли, которую съедает касание за подшаг
const RESTITUTION = 0.15;

export function createRagdoll() {
  const pos = new Float32Array(COUNT * 3);
  const prev = new Float32Array(COUNT * 3);
  const radius = new Float32Array(COUNT);
  const invMass = new Float32Array(COUNT);
  const floor = new Float32Array(COUNT);
  const velY = new Float32Array(COUNT);
  const contact = new Uint8Array(COUNT);
  // удары о землю за последний step(): самый сильный (м/с вниз) и где, самое быстрое скольжение
  const hits = { impact: 0, slide: 0, x: 0, y: 0, z: 0 };
  for (let i = 0; i < COUNT; i += 1) {
    radius[i] = i < 4 ? 0.055 : i < 8 ? 0.05 : i < FOOT ? 0.035 : 0.028;
    invMass[i] = i < 8 ? 1 : 1.8; // ноги легче корпуса
  }
  // связи: a, b, min, max, вид (0 — жёсткая, 1 — предел, 2 — мышца)
  const MAX_C = 64;
  const ca = new Int16Array(MAX_C);
  const cb = new Int16Array(MAX_C);
  const cmin = new Float32Array(MAX_C);
  const cmax = new Float32Array(MAX_C);
  const ckind = new Uint8Array(MAX_C);
  let nc = 0;
  const add = (a, b, min, max, kind) => {
    ca[nc] = a;
    cb[nc] = b;
    cmin[nc] = min;
    cmax[nc] = max;
    ckind[nc] = kind;
    nc += 1;
  };
  for (let a = 0; a < 8; a += 1) {
    for (let b = a + 1; b < 8; b += 1) {
      const pa = BODY_POINTS[a];
      const pb = BODY_POINTS[b];
      const d = Math.hypot(pa[0] - pb[0], pa[1] - pb[1], pa[2] - pb[2]);
      add(a, b, d, d, 0);
    }
  }
  for (let leg = 0; leg < 4; leg += 1) {
    add(leg, KNEE + leg, L1, L1, 0);
    add(KNEE + leg, FOOT + leg, L2, L2, 0);
    add(leg, FOOT + leg, 0.12, L1 + L2, 1); // колено не складывается до конца
    add(leg ^ 1, FOOT + leg, 0.2, 10, 1); // стопа не проходит под корпусом на другую сторону
    add(leg < 2 ? 4 : 5, KNEE + leg, 0.22, 10, 1); // колено не уходит внутрь корпуса
  }
  const rigidCount = nc;
  let muscleStart = nc;
  let muscle = 0;
  let sleepFrames = 0;
  let asleep = false;
  let accumulator = 0;

  const dist = (a, b) => Math.hypot(pos[a * 3] - pos[b * 3], pos[a * 3 + 1] - pos[b * 3 + 1], pos[a * 3 + 2] - pos[b * 3 + 2]);

  const solve = () => {
    for (let c = 0; c < nc; c += 1) {
      const kind = ckind[c];
      if (kind === 2 && muscle <= 0) continue;
      const a = ca[c] * 3;
      const b = cb[c] * 3;
      const dx = pos[b] - pos[a];
      const dy = pos[b + 1] - pos[a + 1];
      const dz = pos[b + 2] - pos[a + 2];
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d < 1e-6) continue;
      let target = d;
      if (d < cmin[c]) target = cmin[c];
      else if (d > cmax[c]) target = cmax[c];
      if (target === d) continue;
      const wa = invMass[ca[c]];
      const wb = invMass[cb[c]];
      let k = (d - target) / (d * (wa + wb));
      if (kind === 2) k *= muscle;
      pos[a] += dx * k * wa;
      pos[a + 1] += dy * k * wa;
      pos[a + 2] += dz * k * wa;
      pos[b] -= dx * k * wb;
      pos[b + 1] -= dy * k * wb;
      pos[b + 2] -= dz * k * wb;
    }
  };

  const substep = (ground) => {
    const h2 = SUBSTEP * SUBSTEP;
    const maxStep = MAX_SPEED * SUBSTEP;
    let moved = 0;
    for (let i = 0; i < COUNT; i += 1) {
      const j = i * 3;
      let vx = (pos[j] - prev[j]) * 0.999;
      let vy = (pos[j + 1] - prev[j + 1]) * 0.999;
      let vz = (pos[j + 2] - prev[j + 2]) * 0.999;
      const len = Math.sqrt(vx * vx + vy * vy + vz * vz);
      if (len > maxStep) {
        const k = maxStep / len;
        vx *= k;
        vy *= k;
        vz *= k;
      }
      velY[i] = vy / SUBSTEP;
      contact[i] = 0;
      prev[j] = pos[j];
      prev[j + 1] = pos[j + 1];
      prev[j + 2] = pos[j + 2];
      pos[j] += vx;
      pos[j + 1] += vy - GRAVITY * h2;
      pos[j + 2] += vz;
    }
    // высота земли под частицей — раз за подшаг (за подшаг частица смещается на миллиметры)
    for (let i = 0; i < COUNT; i += 1) floor[i] = ground(pos[i * 3], pos[i * 3 + 2]) + radius[i];
    for (let it = 0; it < ITERATIONS; it += 1) {
      solve();
      for (let i = 0; i < COUNT; i += 1) {
        const j = i * 3;
        const g = floor[i];
        if (pos[j + 1] < g) {
          pos[j + 1] = g;
          contact[i] = 1;
        }
      }
    }
    // касание земли: удар (скорость вниз до касания) и скольжение — для звука; трение и слабый
    // отскок — один раз за подшаг
    for (let i = 0; i < COUNT; i += 1) {
      if (!contact[i]) continue;
      const j = i * 3;
      const sx = (pos[j] - prev[j]) / SUBSTEP;
      const sz = (pos[j + 2] - prev[j + 2]) / SUBSTEP;
      const slide = Math.sqrt(sx * sx + sz * sz);
      if (-velY[i] > hits.impact) {
        hits.impact = -velY[i];
        hits.x = pos[j];
        hits.y = pos[j + 1];
        hits.z = pos[j + 2];
      }
      if (slide > hits.slide) hits.slide = slide;
      prev[j] = pos[j] - (pos[j] - prev[j]) * (1 - FRICTION);
      prev[j + 2] = pos[j + 2] - (pos[j + 2] - prev[j + 2]) * (1 - FRICTION);
      const vy = pos[j + 1] - prev[j + 1];
      if (vy < 0) prev[j + 1] = pos[j + 1] + vy * RESTITUTION;
    }
    for (let i = 0; i < COUNT * 3; i += 1) moved = Math.max(moved, Math.abs(pos[i] - prev[i]));
    return moved;
  };

  return {
    pos,
    prev,
    count: COUNT,
    get asleep() {
      return asleep;
    },
    hits,
    get muscle() {
      return muscle;
    },
    // points: 16 мировых точек (как BODY_POINTS + колени + стопы) в позе на момент смерти;
    // (vx, vy, vz) — скорость пса, м/с
    start(points, vx = 0, vy = 0, vz = 0) {
      for (let i = 0; i < COUNT; i += 1) {
        const j = i * 3;
        pos[j] = points[j];
        pos[j + 1] = points[j + 1];
        pos[j + 2] = points[j + 2];
        prev[j] = pos[j] - vx * SUBSTEP;
        prev[j + 1] = pos[j + 1] - vy * SUBSTEP;
        prev[j + 2] = pos[j + 2] - vz * SUBSTEP;
      }
      // мышцы: стопа держится за три точки корпуса, колено — за две (длины из этой позы)
      nc = rigidCount;
      muscleStart = nc;
      for (let leg = 0; leg < 4; leg += 1) {
        for (const body of [leg, leg ^ 1, leg ^ 2]) add(body, FOOT + leg, dist(body, FOOT + leg), dist(body, FOOT + leg), 2);
        for (const body of [leg ^ 1, leg ^ 2]) add(body, KNEE + leg, dist(body, KNEE + leg), dist(body, KNEE + leg), 2);
      }
      muscle = 0;
      asleep = false;
      sleepFrames = 0;
      accumulator = 0;
    },
    // сила мышц 0..1 (0 — обмяк)
    setMuscle(k) {
      muscle = Math.max(0, Math.min(1, k));
      if (muscle > 0) asleep = false;
    },
    // толчок в точке (x, y, z) по направлению (dx, dy, dz) (единичный): частицам в радиусе r —
    // прибавка скорости speed (м/с), сильнее у ближних
    impulse(x, y, z, dx, dy, dz, speed, r = 0.45) {
      for (let i = 0; i < COUNT; i += 1) {
        const j = i * 3;
        const d = Math.hypot(pos[j] - x, pos[j + 1] - y, pos[j + 2] - z);
        const w = Math.max(0, 1 - d / r);
        if (w <= 0) continue;
        const dv = speed * w * SUBSTEP;
        prev[j] -= dx * dv;
        prev[j + 1] -= dy * dv;
        prev[j + 2] -= dz * dv;
      }
      asleep = false;
      sleepFrames = 0;
    },
    // толчок всему телу: прибавка скорости (vx, vy, vz) м/с каждой частице (полёт целиком)
    push(vx, vy, vz) {
      for (let i = 0; i < COUNT; i += 1) {
        const j = i * 3;
        prev[j] -= vx * SUBSTEP;
        prev[j + 1] -= vy * SUBSTEP;
        prev[j + 2] -= vz * SUBSTEP;
      }
      asleep = false;
      sleepFrames = 0;
    },
    // толкнуть одну частицу (подёргивания)
    nudge(i, dx, dy, dz) {
      const j = i * 3;
      prev[j] -= dx * SUBSTEP;
      prev[j + 1] -= dy * SUBSTEP;
      prev[j + 2] -= dz * SUBSTEP;
      asleep = false;
    },
    step(dt, ground) {
      hits.impact = 0;
      hits.slide = 0;
      if (asleep) return;
      accumulator = Math.min(accumulator + dt, SUBSTEP * 3);
      while (accumulator >= SUBSTEP) {
        accumulator -= SUBSTEP;
        const moved = substep(ground);
        if (moved < 4e-5 && muscle <= 0) sleepFrames += 1;
        else sleepFrames = 0;
        if (sleepFrames > 120) {
          asleep = true;
          accumulator = 0;
          break;
        }
      }
    },
    // Система корпуса из частиц: out = { c: [x, y, z], x: [...], y: [...], z: [...] } (оси единичные)
    bodyFrame(out) {
      const p = pos;
      const fx = (p[0] + p[3] - p[6] - p[9]) / 2;
      const fy = (p[1] + p[4] - p[7] - p[10]) / 2;
      const fz = (p[2] + p[5] - p[8] - p[11]) / 2;
      let n = Math.hypot(fx, fy, fz) || 1;
      const zx = -fx / n;
      const zy = -fy / n;
      const zz = -fz / n;
      let rx = (p[3] + p[9] - p[0] - p[6]) / 2;
      let ry = (p[4] + p[10] - p[1] - p[7]) / 2;
      let rz = (p[5] + p[11] - p[2] - p[8]) / 2;
      const dot = rx * zx + ry * zy + rz * zz;
      rx -= dot * zx;
      ry -= dot * zy;
      rz -= dot * zz;
      n = Math.hypot(rx, ry, rz) || 1;
      rx /= n;
      ry /= n;
      rz /= n;
      // y = z × x
      const yx = zy * rz - zz * ry;
      const yy = zz * rx - zx * rz;
      const yz = zx * ry - zy * rx;
      const hx = (p[0] + p[3] + p[6] + p[9]) / 4;
      const hy = (p[1] + p[4] + p[7] + p[10]) / 4;
      const hz = (p[2] + p[5] + p[8] + p[11]) / 4;
      out.c[0] = hx + yx * 0.03;
      out.c[1] = hy + yy * 0.03;
      out.c[2] = hz + yz * 0.03;
      out.x[0] = rx;
      out.x[1] = ry;
      out.x[2] = rz;
      out.y[0] = yx;
      out.y[1] = yy;
      out.y[2] = yz;
      out.z[0] = zx;
      out.z[1] = zy;
      out.z[2] = zz;
      return out;
    },
  };
}
