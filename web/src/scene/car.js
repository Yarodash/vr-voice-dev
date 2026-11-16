// Машина в сцене (функция сцены «car», см. compositions.js): модель — car-model.js.
// Ставится один раз ~3 м перед игроком, на землю, боком в 3/4; положение { p: [x, y, z], yaw }
// хранится в данных сцены (snapshot.car): «Продолжить» и перезагрузка — где припарковали (live),
// «Рестарт» — на исходном месте (data).
// Ездит (car-drive.js даёт педали и руль): аркадная «велосипедная» модель — скорость вдоль кузова,
// поворот = v·tan(угол колёс)/база; кузов стоит на земле по четырём точкам касания колёс (высота,
// тангаж, крен — сглаженно). Без водителя машина тормозит до остановки.
import { buildCar } from './car-model.js';

// Высота земли — ровно как у сетки земли в world.js: та же формула в узлах той же неравномерной
// сетки (128², узлы по квадрату расстояния), между узлами — по её треугольникам. Вдали клетки
// большие (десятки метров), и формула без сетки разошлась бы с видимой землёй.
const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const formula = (x, z) =>
  smooth(6, 70, Math.hypot(x, z)) *
  (1.2 * Math.sin(x * 0.019) * Math.cos(z * 0.016) + 0.6 * Math.sin(x * 0.052 + z * 0.041) + 0.3 * Math.sin(z * 0.1 - x * 0.07));
const G_SIZE = 9000;
const G_HALF = G_SIZE / 2;
const G_SEG = 128;
const G_STEP = G_SIZE / G_SEG;
const warp = (v) => Math.sign(v) * G_HALF * (Math.abs(v) / G_HALF) ** 2;
const unwarp = (w) => Math.sign(w) * G_HALF * Math.sqrt(Math.min(1, Math.abs(w) / G_HALF));
export const groundHeight = (x, z) => {
  const ix = Math.min(G_SEG - 1, Math.max(0, Math.floor((unwarp(x) + G_HALF) / G_STEP)));
  const iz = Math.min(G_SEG - 1, Math.max(0, Math.floor((unwarp(z) + G_HALF) / G_STEP)));
  const x0 = warp(-G_HALF + ix * G_STEP);
  const x1 = warp(-G_HALF + (ix + 1) * G_STEP);
  const z0 = warp(-G_HALF + iz * G_STEP);
  const z1 = warp(-G_HALF + (iz + 1) * G_STEP);
  const u = (x - x0) / (x1 - x0);
  const w = (z - z0) / (z1 - z0);
  // PlaneGeometry: треугольники (x0 z0, x0 z1, x1 z0) и (x0 z1, x1 z1, x1 z0)
  const hb = formula(x0, z1);
  const hd = formula(x1, z0);
  if (u + w <= 1) {
    const ha = formula(x0, z0);
    return ha + u * (hd - ha) + w * (hb - ha);
  }
  const hc = formula(x1, z1);
  return hc + (1 - u) * (hb - hc) + (1 - w) * (hd - hc);
};

const WHEELBASE = 2.7; // как в car-model.js
const TRACK = 0.71; // половина колеи
const WHEEL_R = 0.305;
const MAX_STEER = (35 * Math.PI) / 180; // упор колёс
const V_MAX = 25; // м/с вперёд
const V_REV = 5; // м/с назад
const BRAKE = 8; // м/с² при полностью зажатом тормозе
const REV_ACCEL = 3; // м/с² назад
const LAT_MAX = 9; // м/с²: на скорости угол колёс меньше, чтобы поперечное ускорение не больше этого
const STEER_RATE = 1.8; // доля полного упора в секунду (к краю)
const STEER_BACK = 3; // и обратно к центру
const REVERSE_HOLD_S = 0.4; // стоим, тормоз держат дольше — задний ход
const WORLD_R = 300; // дальше от центра машина не уезжает
const BODY_SMOOTH_S = 0.06; // сглаживание высоты, тангажа и крена кузова

export function createCar({ THREE, root, camera }) {
  const shared = (globalThis.__sceneState ??= {});
  // движение переживает подмену файла сцены (не перезагрузку страницы)
  const phys = (shared.carPhysics ??= { v: 0, gear: 'D', steer: 0, hold: 0, x: 0, z: 0 });
  let car = null;
  let pose = null;
  const body = { y: 0, pitch: 0, roll: 0 };

  const placeInFront = () => {
    const head = camera.getWorldPosition(new THREE.Vector3());
    const dir = camera.getWorldDirection(new THREE.Vector3());
    dir.y = 0;
    if (dir.lengthSq() < 1e-6) dir.set(0, 0, -1);
    dir.normalize();
    const right = new THREE.Vector3(-dir.z, 0, dir.x);
    // нос машины вправо и чуть к игроку (3/4)
    const a = THREE.MathUtils.degToRad(25);
    const fwd = right.multiplyScalar(Math.cos(a)).addScaledVector(dir, -Math.sin(a));
    const p = head.addScaledVector(dir, 3.4);
    p.y = groundHeight(p.x, p.z);
    return { p: p.toArray().map((v) => Math.round(v * 1e4) / 1e4), yaw: Math.round(Math.atan2(-fwd.x, -fwd.z) * 1e4) / 1e4 };
  };

  // высота кузова, тангаж и крен по земле под четырьмя колёсами
  const target = { y: 0, pitch: 0, roll: 0 };
  const sampleGround = (x, z, yaw) => {
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    const at = (lx, lz) => groundHeight(x + lx * c + lz * s, z - lx * s + lz * c);
    const fl = at(-TRACK, -WHEELBASE / 2);
    const fr = at(TRACK, -WHEELBASE / 2);
    const rl = at(-TRACK, WHEELBASE / 2);
    const rr = at(TRACK, WHEELBASE / 2);
    target.y = (fl + fr + rl + rr) / 4;
    target.pitch = Math.atan2((fl + fr - rl - rr) / 2, WHEELBASE); // нос выше — +
    target.roll = Math.atan2((fr + rr - fl - rl) / 2, 2 * TRACK); // правый бок выше — +
    return target;
  };
  const placeBody = () => {
    car.group.position.set(pose.p[0], body.y, pose.p[2]);
    car.group.rotation.set(body.pitch, pose.yaw, body.roll, 'YXZ');
  };

  return {
    // enabled — есть ли машина в сцене; saved — сохранённое положение. Возвращает положение, если
    // машину пришлось поставить заново (его надо записать в сцену), иначе null.
    apply(enabled, saved) {
      if (!enabled) {
        car?.dispose();
        car = null;
        pose = null;
        phys.v = 0;
        return null;
      }
      if (!car) {
        car = buildCar(THREE);
        root.add(car.group);
      }
      const fresh = !(saved && Array.isArray(saved.p));
      pose = fresh ? placeInFront() : { p: [...saved.p], yaw: saved.yaw };
      // машину переставили (сцена, «Рестарт») — она стоит; подмена файла сцены на ходу — едет дальше
      if (Math.hypot(pose.p[0] - phys.x, pose.p[2] - phys.z) > 1) {
        phys.v = 0;
        phys.steer = 0;
        phys.gear = 'D';
      }
      phys.x = pose.p[0];
      phys.z = pose.p[2];
      Object.assign(body, sampleGround(pose.p[0], pose.p[2], pose.yaw));
      pose.p[1] = body.y;
      placeBody();
      car.setSteer(phys.steer);
      return fresh ? pose : null;
    },
    pose: () => pose,
    get model() {
      return car;
    },
    // скорость (м/с, + вперёд), передача 'D' | 'R', руль −1..1 (доля упора), угол колёс (рад)
    state: () => ({ v: phys.v, gear: phys.gear, steer: phys.steer }),
    // Положение машины без тангажа и крена (только курс): к нему привязан игрок за рулём.
    yawFrame(target4) {
      return target4.makeRotationY(pose?.yaw ?? 0).setPosition(pose?.p[0] ?? 0, body.y, pose?.p[2] ?? 0);
    },
    // input: { throttle 0..1, brake 0..1, steer −1..1 } — водитель; null — никого: тормозит до остановки.
    // Возвращает 'reverse', если в этом кадре включилась задняя передача.
    update(dt, input = null) {
      if (!car) return null;
      dt = Math.min(dt, 0.05);
      if (!input && phys.v === 0) {
        car.setWheelSpin(0);
        car.update(dt);
        return null;
      }
      let event = null;
      const throttle = input?.throttle ?? 0;
      const brake = input ? input.brake : 1;
      // задний ход: стоим, тормоз держат дольше REVERSE_HOLD_S; вперёд — газ, когда стоим
      const slow = Math.abs(phys.v) < 0.3;
      if (phys.gear === 'D') {
        if (input && slow && brake > 0.5 && throttle < 0.1) {
          phys.hold += dt;
          if (phys.hold > REVERSE_HOLD_S) {
            phys.gear = 'R';
            phys.hold = 0;
            event = 'reverse';
          }
        } else phys.hold = 0;
      } else if (slow && throttle > 0.1) {
        phys.gear = 'D';
        phys.hold = 0;
      }
      const dir = phys.gear === 'D' ? 1 : -1;
      const go = dir > 0 ? throttle : brake; // на задней «тормоз» — газ назад, а газ — тормоз
      const stop = dir > 0 ? brake : throttle;
      let u = phys.v * dir; // скорость в сторону передачи
      const accel = dir > 0 ? go * Math.min(4.5, 45 / Math.max(u, 0.1)) : go * REV_ACCEL;
      // качение, воздух, торможение двигателем без газа, тормоз — всегда против движения
      const resist = 0.25 + 0.0018 * u * u + (go < 0.05 ? 0.5 : 0) + stop * BRAKE;
      u += accel * dt;
      u = u > 0 ? Math.max(0, u - resist * dt) : Math.min(0, u + resist * dt);
      u = Math.min(u, dir > 0 ? V_MAX : V_REV);
      phys.v = u * dir;
      if (Math.abs(phys.v) < 1e-3 && !go) phys.v = 0;

      // руль: к цели с ограниченной скоростью; на скорости упор меньше (поперечное ускорение ≤ LAT_MAX)
      const want = input ? Math.max(-1, Math.min(1, input.steer)) : phys.steer;
      const rate = (Math.abs(want) < Math.abs(phys.steer) ? STEER_BACK : STEER_RATE) * dt;
      phys.steer += Math.max(-rate, Math.min(rate, want - phys.steer));
      const speed = Math.abs(phys.v);
      const limit = Math.min(MAX_STEER, Math.atan((LAT_MAX * WHEELBASE) / Math.max(speed * speed, 1e-3)));
      const angle = phys.steer * limit; // + — вправо
      car.setSteer(angle / MAX_STEER);

      // велосипедная модель от середины между осями: курс, снос β, движение
      const tan = Math.tan(angle);
      pose.yaw -= ((phys.v * tan) / WHEELBASE) * dt; // вправо — курс уменьшается
      if (pose.yaw > Math.PI) pose.yaw -= 2 * Math.PI;
      else if (pose.yaw < -Math.PI) pose.yaw += 2 * Math.PI;
      const heading = pose.yaw - Math.atan(0.5 * tan);
      let x = pose.p[0] - Math.sin(heading) * phys.v * dt;
      let z = pose.p[2] - Math.cos(heading) * phys.v * dt;
      const r = Math.hypot(x, z);
      if (r > WORLD_R) {
        // край мира: дальше не пускает, скорость гаснет
        x *= WORLD_R / r;
        z *= WORLD_R / r;
        phys.v *= Math.exp(-4 * dt);
      }
      pose.p[0] = phys.x = x;
      pose.p[2] = phys.z = z;

      // кузов по земле, сглаженно
      sampleGround(x, z, pose.yaw);
      const k = 1 - Math.exp(-dt / BODY_SMOOTH_S);
      body.y += (target.y - body.y) * k;
      body.pitch += (target.pitch - body.pitch) * k;
      body.roll += (target.roll - body.roll) * k;
      pose.p[1] = body.y;
      placeBody();
      car.setWheelSpin(phys.v / WHEEL_R);
      car.update(dt);
      return event;
    },
    dispose() {
      car?.dispose();
      car = null;
    },
  };
}
