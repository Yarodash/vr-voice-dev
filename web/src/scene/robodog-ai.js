// Робопёс: простой «мозг» — конечный автомат без three.js (проверяется в node).
//
// Пёс бродит по полю перед игроком (4…25 м от него, в секторе впереди), доходит до точки и стоит,
// нюхает землю или оборачивается к игроку, иногда подпрыгивает. Обходит стойки мишеней (простое
// отталкивание), к игроку ближе 4 м не подходит. Пуля рядом или попадание — пёс на пару секунд
// замирает (оглушён), потом убегает от игрока бегом и снова оборачивается на него.
//
// dog: { x, z, yaw, v, w, state, t, left, tx, tz, sniff, jump } — yaw: куда смотрит (вперёд =
// (−sin yaw, −cos yaw), как у машины), v — скорость вперёд, w — скорость поворота (рад/с).
// env: { px, pz — игрок, fx, fz — куда он смотрит (по земле, единичный), stands: [{x, z}] | null }.
// step(dog, env, dt) двигает пса и возвращает 'jump' | 'hop' | null — начать прыжок (анимацию
// и полёт ведёт robodog.js; пока dog.jump не null, мозг не поворачивает и скорость держит).

export const NEAR_M = 4; // ближе к игроку не подходит
export const FAR_M = 25; // дальше не уходит
const WALK = 0.9;
const TROT = 1.7;
const RUN = 3.4;
const ACCEL = 2.6; // м/с²
const DECEL = 4.5;
const STAND_R = 1.3; // обходит стойки на таком расстоянии

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const wrap = (a) => {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
};
export const yawTo = (dx, dz) => Math.atan2(-dx, -dz);

export function createDog(x = 0, z = -10, yaw = 0) {
  return { x, z, yaw, v: 0, w: 0, state: 'idle', t: 0, left: 1, tx: x, tz: z, want: 0, sniff: 0, jump: null, nextJump: 6, fleeing: 0 };
}

export function createBrain(random = Math.random) {
  const rand = (a, b) => a + random() * (b - a);

  // новая точка: впереди игрока, в секторе ±70°, 6…20 м, не у самой стойки
  const pickTarget = (dog, env) => {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const angle = rand(-1.2, 1.2);
      const dist = rand(6, 20);
      const c = Math.cos(angle);
      const s = Math.sin(angle);
      // повернуть взгляд игрока на angle вокруг вертикали
      const dx = env.fx * c - env.fz * s;
      const dz = env.fx * s + env.fz * c;
      const tx = env.px + dx * dist;
      const tz = env.pz + dz * dist;
      if (Math.hypot(tx - dog.x, tz - dog.z) < 2.5) continue; // слишком близко — неинтересно
      let blocked = false;
      for (const st of env.stands ?? []) if (Math.hypot(st.x - tx, st.z - tz) < STAND_R + 0.4) blocked = true;
      if (blocked) continue;
      dog.tx = tx;
      dog.tz = tz;
      return;
    }
    dog.tx = env.px + env.fx * 10;
    dog.tz = env.pz + env.fz * 10;
  };

  const enter = (dog, state, seconds) => {
    dog.state = state;
    dog.t = 0;
    dog.left = seconds;
  };

  // после стояния — куда дальше
  const nextIdle = (dog, env) => {
    const r = random();
    if (r < 0.55) {
      pickTarget(dog, env);
      dog.want = random() < 0.35 ? TROT : WALK;
      enter(dog, 'wander', 20);
    } else if (r < 0.75) enter(dog, 'sniff', rand(1.5, 3));
    else enter(dog, 'look', rand(1, 2.5));
  };

  const api = {
    // пуля пролетела рядом или попала: замереть, потом убежать
    scare(dog, env, hit) {
      if (dog.state === 'dead') return;
      if (hit) {
        dog.v *= 0.3;
        enter(dog, 'stun', 0.35);
      } else if (dog.state !== 'flee' && dog.state !== 'stun') {
        api.flee(dog, env);
      }
      dog.fleeing = 1;
    },
    flee(dog, env) {
      // от игрока, с отклонением в сторону; не дальше FAR_M
      const ax = dog.x - env.px;
      const az = dog.z - env.pz;
      const d = Math.hypot(ax, az) || 1;
      const turn = rand(-0.7, 0.7);
      const c = Math.cos(turn);
      const s = Math.sin(turn);
      const ux = (ax / d) * c - (az / d) * s;
      const uz = (ax / d) * s + (az / d) * c;
      const dist = clamp(d + rand(7, 11), 9, FAR_M - 2);
      dog.tx = env.px + ux * dist;
      dog.tz = env.pz + uz * dist;
      dog.want = RUN;
      enter(dog, 'flee', rand(2.5, 4));
    },
    step(dog, env, dt) {
      dog.t += dt;
      dog.left -= dt;
      let event = null;
      let goal = 0; // желаемая скорость
      let face = null; // куда повернуться (yaw), если не идёт к точке
      const toPlayer = yawTo(env.px - dog.x, env.pz - dog.z);
      const distPlayer = Math.hypot(env.px - dog.x, env.pz - dog.z);
      dog.sniff += ((dog.state === 'sniff' ? 1 : 0) - dog.sniff) * Math.min(1, dt * 4);

      switch (dog.state) {
        case 'dead':
          dog.v = 0;
          dog.w = 0;
          return null;
        case 'stun':
          goal = 0;
          if (dog.left <= 0) api.flee(dog, env);
          break;
        case 'idle':
          if (dog.left <= 0) nextIdle(dog, env);
          break;
        case 'sniff':
          if (dog.left <= 0) nextIdle(dog, env);
          break;
        case 'look':
          face = toPlayer;
          if (dog.left <= 0) {
            if (random() < 0.25) event = 'hop';
            nextIdle(dog, env);
          }
          break;
        case 'flee':
        case 'wander': {
          goal = dog.want;
          const dist = Math.hypot(dog.tx - dog.x, dog.tz - dog.z);
          if (dist < 0.8 || dog.left <= 0) {
            if (dog.state === 'flee') enter(dog, 'look', rand(1.2, 2.2));
            else enter(dog, random() < 0.5 ? 'idle' : 'sniff', rand(1, 3));
            goal = 0;
          } else if (dist < 2.5) goal = Math.min(goal, 0.5 + dist * 0.4); // подходит, замедляясь
          // прыжок на ходу: иногда, если впереди свободно
          dog.nextJump -= dt;
          if (dog.nextJump <= 0 && dog.v > 1.2 && dist > 5) {
            event = 'jump';
            dog.nextJump = rand(6, 14);
          }
          break;
        }
        default:
          enter(dog, 'idle', 1);
      }
      dog.fleeing = Math.max(0, dog.fleeing - dt * 0.2);

      if (dog.jump) {
        // в прыжке: летит как летел
        dog.w = 0;
      } else {
        // направление: к цели + отталкивание от стоек и от игрока
        let dx = 0;
        let dz = 0;
        if (face === null && (dog.state === 'wander' || dog.state === 'flee')) {
          const tx = dog.tx - dog.x;
          const tz = dog.tz - dog.z;
          const d = Math.hypot(tx, tz) || 1;
          dx = tx / d;
          dz = tz / d;
          const stands = env.stands;
          for (let i = 0; stands && i < stands.length; i += 1) {
            const st = stands[i];
            const ax = dog.x - st.x;
            const az = dog.z - st.z;
            const ad = Math.hypot(ax, az);
            if (ad < STAND_R * 1.6 && ad > 1e-3) {
              const push = ((STAND_R * 1.6 - ad) / (STAND_R * 1.6)) * 2.2;
              dx += (ax / ad) * push;
              dz += (az / ad) * push;
            }
          }
          if (distPlayer < NEAR_M + 1.5) {
            const push = ((NEAR_M + 1.5 - distPlayer) / 1.5) * 2;
            dx -= ((env.px - dog.x) / (distPlayer || 1)) * push;
            dz -= ((env.pz - dog.z) / (distPlayer || 1)) * push;
          }
          face = yawTo(dx, dz);
        }
        if (face !== null) {
          const diff = wrap(face - dog.yaw);
          const maxW = dog.v > 2 ? 3.2 : 2.4;
          dog.w = clamp(diff * 4, -maxW, maxW);
          // крутой поворот — сначала развернуться почти на месте
          goal *= clamp(1.3 - Math.abs(diff) / 1.2, 0.15, 1);
        } else dog.w *= Math.max(0, 1 - dt * 8);
        dog.yaw = wrap(dog.yaw + dog.w * dt);
        dog.v += clamp(goal - dog.v, -DECEL * dt, ACCEL * dt);
      }

      // движение вперёд по курсу
      dog.x -= Math.sin(dog.yaw) * dog.v * dt;
      dog.z -= Math.cos(dog.yaw) * dog.v * dt;
      // жёсткие границы: не ближе NEAR_M и не дальше FAR_M от игрока
      const ax = dog.x - env.px;
      const az = dog.z - env.pz;
      const ad = Math.hypot(ax, az) || 1;
      if (ad < NEAR_M) {
        dog.x = env.px + (ax / ad) * NEAR_M;
        dog.z = env.pz + (az / ad) * NEAR_M;
      } else if (ad > FAR_M + 3) {
        dog.x = env.px + (ax / ad) * (FAR_M + 3);
        dog.z = env.pz + (az / ad) * (FAR_M + 3);
      }
      if (ad > FAR_M && dog.state !== 'flee' && dog.state !== 'wander' && !dog.jump) {
        // ушёл далеко (игрок отошёл) — вернуться
        pickTarget(dog, env);
        dog.want = TROT;
        enter(dog, 'wander', 20);
      }
      return event;
    },
  };
  return api;
}
