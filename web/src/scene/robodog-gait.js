// Робопёс: размеры, ноги (обратная кинематика) и походка — чистая математика без three.js (можно
// проверить в node). Модель — robodog-model.js, поведение — robodog-ai.js, всё вместе — robodog.js.
//
// Система тела: вперёд −Z, вправо +X, вверх +Y; начало — центр корпуса. Ноги: тазобедренный узел
// (отведение — поворот вокруг Z), бедро (сгиб вокруг X) и колено (сгиб вокруг X); колени у всех
// четырёх ног смотрят назад, как у Spot.
//
// Походка процедурная: у каждой ноги своя фаза цикла; опора (стопа стоит на земле и уезжает назад
// относительно тела) и перенос (стопа по синусу поднимается и выносится вперёд). Шагом и рысью ходят
// диагональные пары (ЛП+ПЗ, ПП+ЛЗ), на бегу фазы плавно сходятся к галопу (передние вместе, задние
// вместе). Частота, длина шага и высота подъёма растут со скоростью; корпус покачивается и кивает.

export const L1 = 0.22; // бедро, м
export const L2 = 0.23; // голень (до центра стопы)
export const FOOT_R = 0.028; // радиус стопы
export const BODY_Y = 0.46; // центр корпуса над землёй, когда стоит
// тазобедренные узлы в системе корпуса: ЛП, ПП, ЛЗ, ПЗ
export const HIPS = [
  [-0.13, -0.03, -0.28],
  [0.13, -0.03, -0.28],
  [-0.13, -0.03, 0.28],
  [0.13, -0.03, 0.28],
];
const NEUTRAL_X = 1.1; // стопы чуть шире таза
const JOLT_V = 9; // рад/с: предел скорости толчка от попаданий
const JOLT_MAX = 0.3; // рад: и наклона от них
const MIN_Y = 0.27; // корпус не ниже этого над землёй (стоит, сбит толчком, присел)
const GRAVITY = 9.81;

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
const lerp = (a, b, t) => a + (b - a) * t;
const frac = (x) => x - Math.floor(x);

// Двухзвенная нога. (dx, dy, dz) — стопа относительно таза в системе корпуса. out: { abd, hip, knee }
// — поворот тазового узла вокруг Z, бедра и колена вокруг X (колено назад). Недостижимое — нога
// вытягивается в сторону цели.
export function legIK(dx, dy, dz, out) {
  const r = Math.hypot(dx, dy);
  out.abd = Math.atan2(dx, -dy);
  let d = Math.hypot(r, dz);
  d = clamp(d, 0.09, L1 + L2 - 1e-4);
  const alpha = Math.atan2(-dz, r);
  const beta = Math.acos(clamp((L1 * L1 + d * d - L2 * L2) / (2 * L1 * d), -1, 1));
  const gamma = Math.acos(clamp((L1 * L1 + L2 * L2 - d * d) / (2 * L1 * L2), -1, 1));
  out.hip = alpha - beta;
  out.knee = Math.PI - gamma;
  return out;
}

// Прямая задача (для проверки): где окажется стопа при углах out — [x, y, z] относительно таза.
export function legFK({ abd, hip, knee }) {
  const sy = -(L1 * Math.cos(hip) + L2 * Math.cos(hip + knee));
  const sz = -(L1 * Math.sin(hip) + L2 * Math.sin(hip + knee));
  return [-Math.sin(abd) * sy, Math.cos(abd) * sy, sz];
}

// Высота прыжка → начальная вертикальная скорость
export const jumpSpeed = (height) => Math.sqrt(2 * GRAVITY * height);

const TROT = [0, 0.5, 0.5, 0];
const GALLOP = [0, 0.08, 0.55, 0.63];

// Походка. update(dt, cmd, ground) → pose. cmd: { v — скорость вперёд (м/с), w — поворот (рад/с,
// + влево), sniff 0..1 — нюхает землю, crouch 0..1 — присел (перед прыжком и после), air: null |
// 0..1 — в прыжке (доля полёта) }. ground(x, z) — высота земли в точке (система «стоп»: начало под
// центром корпуса, ось Y вверх, без наклона) относительно этого начала.
// pose: { y, x, pitch, roll, legs: [{ abd, hip, knee }] ×4 } — корпус (над началом) и ноги.
export function createGait() {
  const pose = { y: BODY_Y, x: 0, pitch: 0, roll: 0, yaw: 0, legs: HIPS.map(() => ({ abd: 0, hip: 0, knee: 0 })) };
  const feet = HIPS.map(() => [0, 0, 0]); // цели стоп (для отладки и тени)
  let phase = 0;
  let time = 0;
  const jolt = { p: 0, r: 0, vp: 0, vr: 0 }; // толчок от попадания: пружина на тангаж и крен
  const offsets = [0, 0, 0, 0];

  const toBody = (x, y, z, out) => {
    // в систему корпуса: минус положение, поворот обратно (корпус = Rx(pitch)·Ry(yaw)·Rz(roll))
    let px = x - pose.x;
    let py = y - pose.y;
    let pz = z;
    const cp = Math.cos(-pose.pitch);
    const sp = Math.sin(-pose.pitch);
    const ny = cp * py - sp * pz;
    pz = sp * py + cp * pz;
    py = ny;
    const cy = Math.cos(-pose.yaw);
    const sy = Math.sin(-pose.yaw);
    const nx0 = cy * px + sy * pz;
    pz = -sy * px + cy * pz;
    px = nx0;
    const cr = Math.cos(-pose.roll);
    const sr = Math.sin(-pose.roll);
    const nx = cr * px - sr * py;
    py = sr * px + cr * py;
    px = nx;
    out[0] = px;
    out[1] = py;
    out[2] = pz;
    return out;
  };
  const local = [0, 0, 0];

  return {
    pose,
    feet,
    get phase() {
      return phase;
    },
    // попадание: тряхнуть корпус (pitch, roll — рад/с)
    // Ограничено: очередь по большому псу не накапливает толчки (иначе корпус заваливался, а ноги
    // выворачивались коленом вперёд и уходили под землю)
    kick(pitchSpeed, rollSpeed) {
      jolt.vp = clamp(jolt.vp + pitchSpeed, -JOLT_V, JOLT_V);
      jolt.vr = clamp(jolt.vr + rollSpeed, -JOLT_V, JOLT_V);
    },
    update(dt, cmd, ground) {
      time += dt;
      const v = Math.max(0, cmd.v);
      const w = cmd.w;
      const vs = cmd.vs ?? 0; // скорость вбок (+ вправо): уворот
      const broken = cmd.broken ?? 0; // перебитые ноги (биты 0–3 — ЛП, ПП, ЛЗ, ПЗ): волочатся
      const style = cmd.style ?? 1; // «гибкость» пса: размах изгибов корпуса
      const sniff = cmd.sniff ?? 0;
      const crouch = cmd.crouch ?? 0;
      const air = cmd.air ?? null;
      // Характер движения (стая, robodog-horde.js): prowl 0..1 — крадётся (низко, широко, медленный
      // высокий шаг); rear 0..1 — встал на дыбы (передние лапы молотят воздух), rearReach 0..1 — удар
      // обеими лапами вперёд-вниз из стойки; brake 0..1 — тормозит юзом (корпус назад, передние
      // упираются); look — рад, корпус довёрнут к цели (кружит боком, а смотрит на игрока)
      const prowl = cmd.prowl ?? 0;
      const rear = cmd.rear ?? 0;
      const reach = cmd.rearReach ?? 0;
      const brake = cmd.brake ?? 0;
      const look = cmd.look ?? 0;
      // во весь опор: галоп с фазой полёта — опора короче, корпус сильнее качается и «гнётся»
      const sprint = smoothstep(3.0, 5.2, v);
      let duty = lerp(0.62, 0.4, smoothstep(0.3, 3.0, v));
      duty = lerp(lerp(duty, 0.3, sprint), 0.72, prowl);
      // шагов в секунду (полных циклов); на большой скорости — не реже, чем нужно, чтобы шаг
      // (v·duty/f) не упёрся в предел 0,55 м: иначе стопы скользят по земле
      const f = Math.max(Math.min(4.4, 1.7 + 0.75 * v) * (1 - 0.35 * prowl), (v * duty) / 0.53);
      phase = frac(phase + f * dt);
      const run = smoothstep(1.6, 3.0, v);
      const activity = clamp(Math.max(v, Math.abs(w) * 0.35, Math.abs(vs)) / 0.12, 0, 1);
      for (let i = 0; i < 4; i += 1) offsets[i] = lerp(TROT[i], GALLOP[i], run);

      // корпус
      const k = Math.min(1, dt * 60);
      jolt.vp += (-220 * jolt.p - 16 * jolt.vp) * dt;
      jolt.vr += (-220 * jolt.r - 16 * jolt.vr) * dt;
      jolt.p = clamp(jolt.p + jolt.vp * dt, -JOLT_MAX, JOLT_MAX);
      jolt.r = clamp(jolt.r + jolt.vr * dt, -JOLT_MAX, JOLT_MAX);
      const idle = 1 - activity;
      const breathe = Math.sin(time * Math.PI * 2 * 0.25);
      const trotBob = 0.012 * activity * (1 - run) * Math.cos(phase * Math.PI * 4);
      const gallopBob = (0.022 + 0.04 * sprint) * run * Math.sin(phase * Math.PI * 2);
      const gF = ground(0, HIPS[0][2]);
      const gR = ground(0, HIPS[2][2]);
      const gL = ground(HIPS[0][0], 0);
      const gRi = ground(HIPS[1][0], 0);
      const slopePitch = Math.atan2(gF - gR, HIPS[2][2] - HIPS[0][2]);
      const slopeRoll = Math.atan2(gL - gRi, HIPS[1][0] - HIPS[0][0]) * 0.6;
      const groundMid = (gF + gR) / 2;
      // на дыбы: поворот вокруг задних тазовых узлов — центр поднимается на 0,28·sin θ (задние ноги
      // чуть присели)
      const rearA = 0.85 * rear;
      let y = BODY_Y + groundMid - 0.025 * run - 0.02 * sprint - trotBob - gallopBob + 0.004 * breathe * idle - 0.045 * sniff - 0.13 * crouch
        - 0.1 * prowl - 0.035 * brake + 0.28 * Math.sin(rearA) - 0.06 * rear;
      let pitch = slopePitch + (0.07 + 0.09 * sprint) * run * Math.sin(phase * Math.PI * 2 - 0.6) - 0.24 * sniff + jolt.p + 0.02 * Math.sin(time * 5.3) * sniff
        - 0.07 * prowl + 0.13 * brake + rearA;
      // живость: корпус в такт шагу поворачивается и покачивается (рысью — с каждым шагом пары, на
      // галопе — волной), в поворот закладывается, при увороте наклоняется в сторону рывка
      // (Корпус — одно твёрдое тело: заметный поворот в такт шагу выглядел как «виляние задом».
      // Поэтому покачивание — около градуса и только на бегу; живость — от поворотов, крена в
      // поворот и уворотов.)
      const sway = style * activity * smoothstep(1.2, 3.0, v);
      let yaw = sway * 0.012 * Math.sin(phase * Math.PI * 4 + 0.4) + clamp(0.04 * w, -0.08, 0.08) + clamp(0.7 * look, -0.3, 0.3);
      let roll = slopeRoll + clamp(-0.14 * w * v, -0.22, 0.22) + 0.018 * Math.sin(time * Math.PI * 2 * 0.13) * idle + jolt.r
        + sway * 0.03 * Math.sin(phase * Math.PI * 4 + 1.2) * (1 - run) + clamp(-0.1 * vs, -0.15, 0.15);
      let x = 0.012 * Math.sin(time * Math.PI * 2 * 0.13) * idle;
      if (broken) {
        // хромает: корпус заваливается на перебитую сторону (передняя — ещё и нос вниз), ковыляет
        for (let i = 0; i < 4; i += 1) {
          if (!(broken & (1 << i))) continue;
          roll += HIPS[i][0] < 0 ? 0.12 : -0.12;
          if (i < 2) pitch -= 0.09;
        }
        y -= 0.035 * activity * Math.abs(Math.sin(phase * Math.PI * 2));
      }
      if (air !== null) {
        // в полёте: нос вверх на взлёте, вниз к приземлению
        pitch += 0.22 * Math.cos(air * Math.PI);
        y = BODY_Y; // высоту в полёте задаёт robodog.js (вся группа летит)
      }
      pose.y += (Math.max(y, groundMid + MIN_Y) - pose.y) * k;
      pose.pitch += (clamp(pitch, -0.6, 0.6 + 0.45 * rear) - pose.pitch) * k;
      pose.roll += (roll - pose.roll) * k;
      pose.yaw += (yaw - pose.yaw) * k;
      pose.x += (x - pose.x) * k;

      // ноги
      const lift = Math.max(0.06 + 0.05 * run + 0.04 * sprint, 0.09 * prowl) * activity;
      for (let i = 0; i < 4; i += 1) {
        const hip = HIPS[i];
        const nx = hip[0] * (NEUTRAL_X + 0.18 * prowl);
        // юзом — передние упираются впереди; на дыбах задние подходят под корпус; удар с дыб — передние
        // опускаются далеко впереди
        const nz = hip[2] + (i >= 2 ? 0.02 - 0.07 * rear - 0.03 * brake : -0.09 * brake - 0.22 * reach);
        let fx;
        let fy;
        let fz;
        if (air !== null) {
          // поджать ноги на взлёте, вытянуть к земле перед приземлением; передние вперёд, задние назад
          const reach = smoothstep(0.35, 0.9, air);
          fx = nx;
          fz = nz + (i < 2 ? lerp(0.06, -0.1, reach) : lerp(0.14, 0.02, reach));
          const hipY = pose.y + hip[1];
          fy = hipY - lerp(0.24, 0.42, reach);
        } else {
          // скорость стопы относительно земли: вперёд + поворот (ω × r)
          let sx = w * nz - vs;
          let sz = -v - w * nx;
          const stance = duty / f;
          sx *= stance;
          sz *= stance;
          const len = Math.hypot(sx, sz);
          if (len > 0.55) {
            sx *= 0.55 / len;
            sz *= 0.55 / len;
          }
          const p = frac(phase + offsets[i]);
          let s;
          let h = 0;
          if (p < duty) s = 0.5 - p / duty;
          else {
            const q = (p - duty) / (1 - duty);
            s = -0.5 + q * q * (3 - 2 * q);
            h = lift * Math.sin(Math.PI * q);
          }
          fx = nx + sx * s * activity;
          fz = nz + sz * s * activity;
          fy = ground(fx, fz) + FOOT_R + h;
        }
        if (broken & (1 << i) && air === null) {
          // перебитая нога: не шагает — стопа волочится сзади-сбоку по земле
          fx = nx * 1.2;
          fz = nz + (i < 2 ? 0.12 : 0.18);
          fy = ground(fx, fz) + FOOT_R;
        }
        // удар лапой (стая, большие псы): cmd.paw = { leg, x, y, z, k } — стопа ноги leg тянется к
        // точке (x, y, z) (система «стоп», единицы модели) с долей k
        const paw = cmd.paw;
        if (paw && paw.leg === i && paw.k > 0) {
          fx = lerp(fx, paw.x, paw.k);
          fy = lerp(fy, paw.y, paw.k);
          fz = lerp(fz, paw.z, paw.k);
        }
        feet[i][0] = fx;
        feet[i][1] = fy;
        feet[i][2] = fz;
        toBody(fx, fy, fz, local);
        const pawing = i < 2 && rear > 0.01 && air === null && !(paw && paw.leg === i && paw.k > 0);
        if (pawing) {
          // на дыбах: передние лапы в системе корпуса, по очереди молотят воздух (≈1,6 раза в секунду);
          // удар (reach) вытягивает их вперёд
          const pw = time * Math.PI * 2 * 1.6 + i * Math.PI;
          const kr = smoothstep(0, 0.6, rear);
          local[0] = lerp(local[0], hip[0] * 1.05, kr);
          local[1] = lerp(local[1], hip[1] - 0.27 + 0.07 * Math.sin(pw) * (1 - reach), kr);
          local[2] = lerp(local[2], hip[2] - 0.1 - 0.06 * Math.cos(pw) * (1 - reach) - 0.2 * reach, kr);
        }
        // стопа всегда ниже таза (кроме замаха лапой): иначе решение IK переворачивает колено
        let ly = local[1] - hip[1];
        if (!(paw && paw.leg === i && paw.k > 0) && ly > -0.12) ly = -0.12;
        legIK(local[0] - hip[0], ly, local[2] - hip[2], pose.legs[i]);
      }
      return pose;
    },
  };
}
