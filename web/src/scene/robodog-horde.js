// Стая робопсов (функция сцены «robodogHorde», «Сцена 3»): псы появляются далеко впереди игрока
// (25–40 м, в пределах ±40° от того, куда он смотрит в момент появления), бегут к нему и с ~2,5 м
// прыгают на грудь. Достал — игрока «ударило» (onPlayerHit: красная вспышка по краям обзора тут,
// вибрация в main.js, глухой удар), пёс отлетает назад, приземляется и снова бежит.
// Пёс умирает от HEALTH попаданий (смерть и кукла — robodog-unit.js), труп через CORPSE_S секунд
// уходит в землю, и модель снова свободна. Сначала новый пёс раз в SPAWN_FIRST с, потом всё чаще
// (до SPAWN_MIN); живых одновременно не больше MAX_ALIVE.
//
// Дёшево: POOL готовых моделей (11 вызовов отрисовки на пса: корпус, глаза, 8 частей ног, тень) +
// один общий меш искр и дуг; модели переиспользуются, без создания на лету.
import { createDogSfx, createDogUnit } from './robodog-unit.js';
import { createDog, yawTo } from './robodog-ai.js';
import { createZapFx } from './robodog-fx.js';
import { makeDogTextures, makeShadowTexture } from './robodog-model.js';
import { ensureWeaponEnv } from './weapon-env.js';
import { BODY_Y } from './robodog-gait.js';
import { groundHeight } from './car.js';

const POOL = 5; // моделей всего (живые + трупы): ≤ 5 × 11 + 1 вызовов отрисовки
const MAX_ALIVE = 3;
const HEALTH = 2;
const CORPSE_S = 8; // труп лежит
const SINK_S = 1.5; // и уходит в землю
const SPAWN_FIRST = 4; // с между псами в начале
const SPAWN_MIN = 1.5; // и через пару минут
const RAMP = 0.02; // на столько секунд интервал короче за каждую секунду игры
const SPAWN_NEAR = 25;
const SPAWN_FAR = 40;
const SPAWN_ANGLE = (12.5 * Math.PI) / 180; // ± от взгляда: сектор 25° всего (по просьбе пользователя; было ±40°)
const LEAP_RANGE = 2.5;
const LEAP_T = 0.42; // с полёта до игрока
const CHEST_BELOW_HEAD = 0.35;
const CONTACT_R = 0.55; // центр корпуса ближе этого к линии голова–грудь — удар
const PERSONAL_M = 0.9; // по земле ближе к игроку не подходит
const GRAVITY = 9.81;
const LOG_EVERY_MS = 10000;

const wrap = (a) => {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
};

export function createHorde({ THREE, root, camera, renderer = null, shooting, onPlayerHit, onKill }) {
  const shared = (globalThis.__sceneState ??= {});
  const sfx = createDogSfx(shared);
  const shadowTexture = makeShadowTexture(THREE);
  let units = null;
  let fx = null;
  let textures = null;
  let removeShootable = null;
  let enabled = false;
  // { elapsed, nextSpawn, dogs: [{ dog, health }] } — живые псы переживают подмену файла сцены
  let run = shared.hordeRun ?? null;

  const head = new THREE.Vector3();
  const look = new THREE.Vector3();
  const v1 = new THREE.Vector3();
  const contact = new THREE.Vector3();

  // ---- красная вспышка по краям обзора (квадрат у камеры, как HUD)
  const vignetteCanvas = document.createElement('canvas');
  vignetteCanvas.width = vignetteCanvas.height = 128;
  {
    const g = vignetteCanvas.getContext('2d');
    const grad = g.createRadialGradient(64, 64, 18, 64, 64, 64);
    grad.addColorStop(0, 'rgba(255,0,0,0)');
    grad.addColorStop(0.45, 'rgba(230,10,10,0.25)');
    grad.addColorStop(1, 'rgba(200,0,0,0.9)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 128, 128);
  }
  const vignetteTexture = new THREE.CanvasTexture(vignetteCanvas);
  vignetteTexture.colorSpace = THREE.SRGBColorSpace;
  const vignette = new THREE.Mesh(
    new THREE.PlaneGeometry(1.1, 1.1),
    new THREE.MeshBasicMaterial({ map: vignetteTexture, transparent: true, opacity: 0, depthTest: false, depthWrite: false, toneMapped: false }),
  );
  vignette.name = 'horde-vignette';
  vignette.position.set(0, 0, -0.26);
  vignette.renderOrder = 1002;
  vignette.frustumCulled = false;
  vignette.visible = false;
  camera.add(vignette);
  let hurt = 0;

  const refreshHead = () => {
    camera.getWorldPosition(head);
    camera.getWorldDirection(look);
    look.y = 0;
    if (look.lengthSq() < 1e-6) look.set(0, 0, -1);
    look.normalize();
  };

  // ---- цель для пуль: ближайший пёс на луче
  let rayUnit = null;
  function cast(origin, dir, far) {
    rayUnit = null;
    if (!enabled || !units) return -1;
    let best = -1;
    for (let i = 0; i < units.length; i += 1) {
      const t = units[i].cast(origin, dir, best >= 0 ? best : far);
      if (t >= 0 && (best < 0 || t < best)) {
        best = t;
        rayUnit = units[i];
      }
    }
    return best;
  }
  function hit(origin, dir, distance) {
    const unit = rayUnit;
    rayUnit = null;
    if (!unit) return null;
    // первое попадание сбивает с ног (кукла ~1 с, потом вскакивает), второе — насмерть
    const result = unit.hit(origin, dir, distance, { knockdown: true });
    if (result === 'corpse') return null;
    if (result === 'kill') {
      try {
        onKill?.();
      } catch {
        // счёт не важнее выстрела
      }
    }
    return true;
  }

  const ensurePool = () => {
    if (units) return;
    const anchors = [];
    fx = createZapFx({ THREE, root, anchors });
    textures = makeDogTextures(THREE);
    const env = renderer ? ensureWeaponEnv(THREE, renderer) : null; // крашеный металл бликует, как оружие
    units = [];
    for (let i = 0; i < POOL; i += 1) units.push(createDogUnit({ THREE, root, fx, anchors, shadowTexture, sfx, camera, textures, env, shared }));
    removeShootable = shooting?.addShootable?.({ cast, hit }) ?? null;
    prewarm();
  };
  // Шейдеры и текстуры псов — заранее: модели в пуле скрыты, и без этого первый пёс в бою собирал
  // 2–3 программы прямо в кадре (на Quest без KHR_parallel_shader_compile — десятки мс, «фриз»).
  // compile() только начинает сборку; ожидание связывания и загрузка текстур — по одной за кадр в
  // update (как у подмены сцены, scene-host.js), до первого пса (SPAWN_FIRST) успевает.
  let warmQueue = [];
  const prewarm = () => {
    if (!renderer?.compile || !units.length) return;
    let scene = root;
    while (scene.parent) scene = scene.parent;
    const known = new Set(renderer.info.programs);
    try {
      renderer.compile(units[0].model.group, camera, scene); // скрытые тоже (compile обходит всё)
      renderer.compile(units[0].shadow, camera, scene);
    } catch (error) {
      console.warn('[horde] prewarm:', error?.message ?? error);
      return;
    }
    warmQueue = renderer.info.programs.filter((p) => !known.has(p));
    for (const t of [textures?.map, textures?.orm, shadowTexture]) if (t) warmQueue.push(t);
  };
  const warmStep = () => {
    const item = warmQueue.shift();
    try {
      if (item.isTexture) renderer.initTexture(item);
      else if (item.program) {
        item.getUniforms();
        item.getAttributes();
      }
    } catch {
      // соберётся при первой отрисовке, как раньше
    }
  };
  const teardown = () => {
    removeShootable?.();
    removeShootable = null;
    warmQueue = [];
    for (const unit of units ?? []) unit.dispose();
    units = null;
    fx?.dispose();
    fx = null;
    textures?.dispose();
    textures = null;
  };
  const newRun = () => {
    run = shared.hordeRun = { elapsed: 0, nextSpawn: SPAWN_FIRST, dogs: [], pending: true };
  };

  const aliveCount = () => {
    let n = 0;
    for (let i = 0; i < units.length; i += 1) if (units[i].mode === 'alive' || units[i].knocked) n += 1;
    return n;
  };
  // свободная модель; нет — самый старый труп уходит в землю прямо сейчас
  const freeUnit = () => {
    let oldest = null;
    for (let i = 0; i < units.length; i += 1) {
      const u = units[i];
      if (u.mode === 'off') return u;
      if (u.mode === 'dead' && (!oldest || u.deadFor > oldest.deadFor)) oldest = u;
    }
    if (oldest && oldest.deadFor < CORPSE_S) oldest.deadFor = CORPSE_S;
    return null;
  };
  const spawnOne = () => {
    const unit = freeUnit();
    if (!unit) return false;
    refreshHead();
    const dog = createDog();
    const a = (Math.random() * 2 - 1) * SPAWN_ANGLE;
    const dist = SPAWN_NEAR + Math.random() * (SPAWN_FAR - SPAWN_NEAR);
    const c = Math.cos(a);
    const s = Math.sin(a);
    dog.x = head.x + (look.x * c - look.z * s) * dist;
    dog.z = head.z + (look.x * s + look.z * c) * dist;
    dog.yaw = yawTo(head.x - dog.x, head.z - dog.z);
    dog.state = 'run';
    dog.speed = Math.min(5, 3.3 + Math.random() * 0.9 + run.elapsed * 0.004);
    unit.spawn(dog, { health: HEALTH });
    return true;
  };

  // ---- поведение одного пса (бег к игроку, бросок, отскок)
  const steer = (unit, dt) => {
    const dog = unit.dog;
    dog.t += dt;
    const dx = head.x - dog.x;
    const dz = head.z - dog.z;
    const dist = Math.hypot(dx, dz) || 1e-3;
    const j = dog.jump;
    if (j) {
      // бросок: присел — почти стоит; полетел — с расчётной скоростью к игроку
      if (dog.leap) {
        if (j.phase === 0) dog.v = 0.4;
        else if (j.phase === 1 && !dog.leap.flying) {
          dog.leap.flying = true;
          dog.v = dog.leap.v;
        }
        // в полёте: центр корпуса у линии голова–грудь — удар
        if (j.phase === 1 && !dog.leap.struck) {
          const by = unit.bodyCenter.y;
          const top = head.y;
          const bottom = head.y - 0.7;
          const cy = by > top ? top : by < bottom ? bottom : by;
          contact.set(head.x, cy, head.z);
          if (unit.bodyCenter.distanceTo(contact) < CONTACT_R) {
            dog.leap.struck = true;
            dog.v = -2.4; // отлетает назад
            unit.jumpVy = Math.max(0, unit.jumpVy) * 0.3 + 1.2;
            unit.kick(-7, (Math.random() - 0.5) * 6);
            v1.copy(unit.bodyCenter).lerp(contact, 0.5);
            sfx.thud(v1);
            hurt = 1;
            try {
              onPlayerHit?.(v1);
            } catch {
              // вибрация не важнее игры
            }
          }
        }
      }
      dog.w = 0;
    } else {
      if (dog.leap) {
        // приземлился после броска: постоять и снова бежать
        dog.state = 'recover';
        dog.t = dog.leap.struck ? -0.6 : 0.4; // ударил — дольше приходит в себя (1,4 с)
        dog.leap = null;
      }
      let goal = 0;
      let face = yawTo(dx, dz);
      if (dog.state === 'stun') {
        if (dog.t > 0.35) dog.state = 'run';
      } else if (dog.state === 'recover') {
        if (dog.t > 0.8) dog.state = 'run';
      } else {
        dog.state = 'run';
        goal = dog.speed;
        // не толкаться: отталкивание от других живых псов
        let ox = dx / dist;
        let oz = dz / dist;
        for (let i = 0; i < units.length; i += 1) {
          const other = units[i];
          if (other === unit || other.mode !== 'alive') continue;
          const ax = dog.x - other.dog.x;
          const az = dog.z - other.dog.z;
          const ad = Math.hypot(ax, az);
          if (ad < 1.6 && ad > 1e-3) {
            const push = ((1.6 - ad) / 1.6) * 1.5;
            ox += (ax / ad) * push;
            oz += (az / ad) * push;
          }
        }
        face = yawTo(ox, oz);
        const diff = Math.abs(wrap(yawTo(dx, dz) - dog.yaw));
        if (dist < LEAP_RANGE + dog.v * 0.15 && diff < 0.5) {
          // бросок: долететь до груди за LEAP_T
          const chest = head.y - CHEST_BELOW_HEAD - groundHeight(dog.x, dog.z) - BODY_Y;
          const h = Math.max(0.3, chest);
          const vy = (h + 0.5 * GRAVITY * LEAP_T * LEAP_T) / LEAP_T;
          if (unit.jump({ vy, crouch: 0.12 })) {
            dog.leap = { v: Math.max(1, dist - 0.25) / LEAP_T, flying: false, struck: false };
            dog.yaw = yawTo(dx, dz);
          }
        }
      }
      const diff = wrap(face - dog.yaw);
      dog.w = Math.max(-4, Math.min(4, diff * 5));
      dog.yaw = wrap(dog.yaw + dog.w * dt);
      goal *= Math.max(0.2, Math.min(1, 1.3 - Math.abs(diff) / 1.2));
      dog.v += Math.max(-6 * dt, Math.min(3.5 * dt, goal - dog.v));
    }
    dog.x -= Math.sin(dog.yaw) * dog.v * dt;
    dog.z -= Math.cos(dog.yaw) * dog.v * dt;
    if (!dog.jump) {
      // по земле сквозь игрока не проходит
      const ax = dog.x - head.x;
      const az = dog.z - head.z;
      const ad = Math.hypot(ax, az);
      if (ad < PERSONAL_M && ad > 1e-3) {
        dog.x = head.x + (ax / ad) * PERSONAL_M;
        dog.z = head.z + (az / ad) * PERSONAL_M;
      }
    }
  };

  let sum = 0;
  let worst = 0;
  let frames = 0;
  let since = performance.now();

  return {
    // on — есть ли стая в сцене; keep — подмена файла сцены (живые псы остаются), иначе заново
    apply(on, { keep = false } = {}) {
      enabled = Boolean(on);
      if (!enabled) {
        teardown();
        run = shared.hordeRun = null;
        return;
      }
      ensurePool();
      for (const unit of units) unit.hide();
      fx.clear();
      if (keep && run) {
        run.dogs.forEach(({ dog, health }, i) => {
          if (units[i]) units[i].spawn(dog, { health, boot: false });
        });
        return;
      }
      newRun();
    },
    update(dt) {
      if (hurt > 0) {
        hurt = Math.max(0, hurt - dt / 0.6);
        vignette.material.opacity = hurt * hurt;
        vignette.visible = hurt > 0;
      }
      if (warmQueue.length) warmStep();
      if (!enabled || !units || !run) return;
      const t0 = performance.now();
      dt = Math.min(dt, 0.05);
      refreshHead();
      if (run.pending) {
        if (head.lengthSq() === 0) return; // камера ещё не на месте
        run.pending = false;
      }
      run.elapsed += dt;
      run.nextSpawn -= dt;
      if (run.nextSpawn <= 0 && aliveCount() < MAX_ALIVE) {
        const ts = performance.now();
        const spawned = spawnOne();
        if (globalThis.__prof) globalThis.__prof.sub.hSpawn = performance.now() - ts; // ВРЕМЕННО
        if (spawned) run.nextSpawn = Math.max(SPAWN_MIN, SPAWN_FIRST - run.elapsed * RAMP);
      }
      const PS = globalThis.__prof?.sub; // ВРЕМЕННО: профилировщик
      for (let i = 0; i < units.length; i += 1) {
        const unit = units[i];
        const ta = performance.now();
        if (unit.mode === 'alive') steer(unit, dt);
        const tb = performance.now();
        const m0 = unit.mode;
        unit.update(dt);
        if (PS) { PS.hSteer = (PS.hSteer || 0) + tb - ta; PS['h_' + m0] = (PS['h_' + m0] || 0) + performance.now() - tb; }
        if (unit.mode === 'dead' && unit.deadFor > CORPSE_S) {
          const k = (unit.deadFor - CORPSE_S) / SINK_S;
          if (k >= 1) unit.hide();
          else unit.setSink(k * 0.6);
        }
      }
      const tf = performance.now();
      fx.update(dt);
      if (PS) PS.hFx = (PS.hFx || 0) + performance.now() - tf;

      const spent = performance.now() - t0;
      sum += spent;
      worst = Math.max(worst, spent);
      frames += 1;
      if (t0 - since >= LOG_EVERY_MS) {
        console.log(`[horde] cpu=${(sum / frames).toFixed(3)}/${worst.toFixed(2)}ms alive=${aliveCount()} used=${units.filter((u) => u.mode !== 'off').length} t=${run.elapsed.toFixed(0)}s fx=${fx.active}`);
        sum = worst = frames = 0;
        since = t0;
      }
    },
    debug: {
      info: () =>
        run && {
          elapsed: +run.elapsed.toFixed(1),
          nextSpawn: +run.nextSpawn.toFixed(1),
          units: units?.map((u) => ({ mode: u.mode, hp: u.health, state: u.dog.state, d: +Math.hypot(u.dog.x - head.x, u.dog.z - head.z).toFixed(1), jump: Boolean(u.dog.jump) })),
        },
    },
    dispose() {
      if (run && units) run.dogs = units.filter((u) => u.mode === 'alive').map((u) => ({ dog: { ...u.dog, jump: null, leap: null }, health: u.health }));
      teardown();
      shadowTexture.dispose();
      vignette.removeFromParent();
      vignette.geometry.dispose();
      vignette.material.dispose();
      vignetteTexture.dispose();
    },
  };
}
