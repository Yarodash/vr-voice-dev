// Отвалившиеся ноги больших робопсов (стая, robodog-horde.js): кусок — бедро + голень со стопой той же
// раскраски — падает куклой и через LIFE_S растворяется, как труп (aFade).
//
// Кукла — 3 частицы Верле (таз, колено, стопа; как robodog-ragdoll.js, только проще): две кости
// постоянной длины, колено не складывается до конца, земля ground(x, z) с трением и слабым отскоком,
// удар о землю звучит (sfx стаи — частота уже ограничена). Ось колена несётся отдельно (из креста
// костей, пока нога согнута; иначе — прежняя), кусок ещё и вращается вокруг бедра, пока летит.
// Рисуется теми же экземплярами, что псы (robodog-instances.js addLeg): ни новых материалов, ни
// программ. Пул CAP кусков, всё заранее — в кадре без выделений; переполнен — заменяет самый старый.
//
// createLegDebris({ THREE, sfx }) → { spawn(seg, scale, side, paint, vx, vy, vz), update(dt),
//   render(inst), clear(), active }
//   seg — Float32Array(12): таз, колено, стопа, ось колена (мировые; unit.detachLeg)
import { L1, L2 } from './robodog-gait.js';
import { groundHeight } from './car.js';

const CAP = 12;
const LIFE_S = 7; // лежит, потом растворяется
const FADE_S = 1.4;
const SUBSTEP = 1 / 90;
const ITER = 4;
const GRAVITY = 9.81;
const FRICTION = 0.45;
const RESTITUTION = 0.2;
const RADIUS = [0.04, 0.03, 0.025]; // ×размер: таз, колено, стопа

export function createLegDebris({ THREE, sfx }) {
  const pieces = [];
  for (let i = 0; i < CAP; i += 1) {
    pieces.push({
      on: false,
      t: 0,
      acc: 0,
      S: 1,
      side: 0,
      paint: 0,
      spin: 0,
      calm: 0, // с подряд почти без движения — уснул
      asleep: false,
      drawn: false, // уснувший: матрицы уже посчитаны
      pos: new Float32Array(9),
      prev: new Float32Array(9),
      hinge: new THREE.Vector3(1, 0, 0),
      mu: new THREE.Matrix4(),
      ml: new THREE.Matrix4(),
    });
  }
  const u = new THREE.Vector3();
  const l = new THREE.Vector3();
  const c = new THREE.Vector3();
  const ax = new THREE.Vector3();
  const ay = new THREE.Vector3();
  const az = new THREE.Vector3();
  const sound = new THREE.Vector3();
  const floor = new Float32Array(3);
  const velY = new Float32Array(3);
  let active = 0;

  // кость из точки a к точке b: −Y вдоль кости, X — ось колена (как orientBone в robodog-unit.js)
  const bone = (m, p, a, b, hinge, S) => {
    ay.set(p[a] - p[b], p[a + 1] - p[b + 1], p[a + 2] - p[b + 2]);
    if (ay.lengthSq() < 1e-12) ay.set(0, 1, 0);
    ay.normalize();
    ax.copy(hinge).addScaledVector(ay, -hinge.dot(ay));
    if (ax.lengthSq() < 1e-8) {
      ax.set(ay.y, -ay.x, 0);
      if (ax.lengthSq() < 1e-8) ax.set(1, 0, 0);
    }
    ax.normalize();
    az.crossVectors(ax, ay);
    m.makeBasis(ax, ay, az);
    m.scale(c.setScalar(S));
    m.setPosition(p[a], p[a + 1], p[a + 2]);
  };

  // связь длины между частицами a и b (индексы ×3), d — [min, max]
  const link = (p, a, b, min, max) => {
    const dx = p[b] - p[a];
    const dy = p[b + 1] - p[a + 1];
    const dz = p[b + 2] - p[a + 2];
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (d < 1e-6) return;
    const target = d < min ? min : d > max ? max : d;
    if (target === d) return;
    const k = (d - target) / (2 * d);
    p[a] += dx * k;
    p[a + 1] += dy * k;
    p[a + 2] += dz * k;
    p[b] -= dx * k;
    p[b + 1] -= dy * k;
    p[b + 2] -= dz * k;
  };

  const substep = (q) => {
    const p = q.pos;
    const o = q.prev;
    const S = q.S;
    const h2 = SUBSTEP * SUBSTEP;
    let moved = 0;
    for (let i = 0; i < 3; i += 1) {
      const j = i * 3;
      const vx = (p[j] - o[j]) * 0.995;
      const vy = (p[j + 1] - o[j + 1]) * 0.995;
      const vz = (p[j + 2] - o[j + 2]) * 0.995;
      velY[i] = vy / SUBSTEP;
      o[j] = p[j];
      o[j + 1] = p[j + 1];
      o[j + 2] = p[j + 2];
      p[j] += vx;
      p[j + 1] += vy - GRAVITY * h2;
      p[j + 2] += vz;
      floor[i] = groundHeight(p[j], p[j + 2]) + RADIUS[i] * S;
    }
    let contact = 0;
    for (let it = 0; it < ITER; it += 1) {
      link(p, 0, 3, L1 * S, L1 * S);
      link(p, 3, 6, L2 * S, L2 * S);
      link(p, 0, 6, 0.3 * (L1 + L2) * S, (L1 + L2) * S); // колено не складывается до конца
      for (let i = 0; i < 3; i += 1) {
        const j = i * 3 + 1;
        if (p[j] < floor[i]) {
          o[j] += floor[i] - p[j]; // вытолкнуть без прибавки скорости
          p[j] = floor[i];
          contact |= 1 << i;
        }
      }
    }
    let impact = 0;
    for (let i = 0; i < 3; i += 1) {
      const j = i * 3;
      if (contact & (1 << i)) {
        if (-velY[i] > impact) {
          impact = -velY[i];
          sound.set(p[j], p[j + 1], p[j + 2]);
        }
        o[j] = p[j] - (p[j] - o[j]) * (1 - FRICTION);
        o[j + 2] = p[j + 2] - (p[j + 2] - o[j + 2]) * (1 - FRICTION);
        const vy = p[j + 1] - o[j + 1];
        if (vy < 0) o[j + 1] = p[j + 1] + vy * RESTITUTION;
      }
      moved = Math.max(moved, Math.abs(p[j] - o[j]), Math.abs(p[j + 1] - o[j + 1]), Math.abs(p[j + 2] - o[j + 2]));
    }
    if (contact) q.spin *= 0.9; // на земле перестаёт крутиться
    // удар о землю: глухо и звякнуло (сравнение «как у маленького»: большой падает быстрее)
    const rt = Math.sqrt(S);
    if (impact / rt > 1.4) {
      const k = Math.min(1, (impact / rt - 1) / 4);
      sfx.groundThud(sound, k, S);
      if (k > 0.25) sfx.clank(sound, S);
    }
    return moved / SUBSTEP / Math.sqrt(S);
  };

  // ось колена: из креста костей, пока нога согнута (знак — как у прежней), иначе прежняя ⟂ бедру;
  // плюс вращение вокруг бедра (spin, рад/с)
  const updateHinge = (q, dt) => {
    const p = q.pos;
    u.set(p[3] - p[0], p[4] - p[1], p[5] - p[2]);
    l.set(p[6] - p[3], p[7] - p[4], p[8] - p[5]);
    c.crossVectors(u, l);
    const sin = c.length() / (u.length() * l.length() + 1e-9);
    if (sin > 0.2) {
      c.normalize();
      if (c.dot(q.hinge) < 0) c.negate();
      q.hinge.lerp(c, 0.5);
    }
    if (q.spin) q.hinge.applyAxisAngle(u.normalize(), q.spin * dt);
    q.hinge.addScaledVector(u.normalize(), -q.hinge.dot(u));
    if (q.hinge.lengthSq() < 1e-8) q.hinge.set(1, 0, 0);
    q.hinge.normalize();
  };

  return {
    get active() {
      return active;
    },
    // новый кусок: seg — таз, колено, стопа, ось колена (мировые); (vx, vy, vz) — скорость, м/с
    spawn(seg, scale, side, paint, vx, vy, vz) {
      let q = null;
      for (const p of pieces) {
        if (!p.on) {
          q = p;
          break;
        }
        if (!q || p.t > q.t) q = p; // все заняты — самый старый
      }
      if (!q.on) active += 1;
      q.on = true;
      q.t = 0;
      q.acc = 0;
      q.S = scale;
      q.side = side;
      q.paint = paint;
      q.calm = 0;
      q.asleep = false;
      q.drawn = false;
      q.spin = (Math.random() < 0.5 ? -1 : 1) * (2 + Math.random() * 3) / Math.sqrt(scale);
      q.hinge.set(seg[9], seg[10], seg[11]).normalize();
      // кувырок: стопа летит чуть иначе, чем таз
      const tumble = (1.2 + Math.random()) * Math.min(2, Math.sqrt(scale)) * (scale > 4 ? Math.sqrt(4 / scale) : 1); // тяжёлый кувыркается вяло
      const tx = (Math.random() - 0.5) * tumble;
      const tz = (Math.random() - 0.5) * tumble;
      for (let i = 0; i < 3; i += 1) {
        const j = i * 3;
        const k = (i - 1) * 0.5; // таз −, стопа +
        q.pos[j] = seg[j];
        q.pos[j + 1] = seg[j + 1];
        q.pos[j + 2] = seg[j + 2];
        q.prev[j] = seg[j] - (vx + tx * k) * SUBSTEP;
        q.prev[j + 1] = seg[j + 1] - (vy - Math.abs(k) * 0.3 * tumble) * SUBSTEP;
        q.prev[j + 2] = seg[j + 2] - (vz + tz * k) * SUBSTEP;
      }
      return q;
    },
    update(dt) {
      if (!active) return;
      for (const q of pieces) {
        if (!q.on) continue;
        q.t += dt;
        if (q.t > LIFE_S + FADE_S) {
          q.on = false;
          active -= 1;
          continue;
        }
        if (q.asleep) continue;
        q.acc = Math.min(q.acc + dt, 0.1);
        let speed = 0;
        while (q.acc >= SUBSTEP) {
          q.acc -= SUBSTEP;
          speed = substep(q);
          updateHinge(q, SUBSTEP);
        }
        q.calm = speed < 0.08 ? q.calm + dt : 0;
        if (q.calm > 0.6) q.asleep = true;
      }
    },
    // в буферы экземпляров (между inst.begin и inst.end)
    render(inst) {
      if (!active || !inst?.addLeg) return;
      for (const q of pieces) {
        if (!q.on) continue;
        const fade = q.t > LIFE_S ? Math.min(1, (q.t - LIFE_S) / FADE_S) : 0;
        if (!q.asleep || !q.drawn) {
          bone(q.mu, q.pos, 0, 3, q.hinge, q.S);
          bone(q.ml, q.pos, 3, 6, q.hinge, q.S);
          q.drawn = q.asleep;
        }
        inst.addLeg(q.side, q.paint, fade, q.mu.elements, q.ml.elements);
      }
    },
    clear() {
      for (const q of pieces) q.on = false;
      active = 0;
    },
  };
}
