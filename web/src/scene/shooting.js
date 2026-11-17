// Мишени и выстрелы. Живёт в сцене: правки подхватываются на лету.
//
// Мишени — стальные тарелки на деревянных стойках, рядами вдаль перед игроком (targets.js). Выстрел —
// пуля из дула вдоль ствола: летит с начальной скоростью оружия и падает под гравитацией (парабола),
// каждый кадр её путь за кадр проверяется отрезками (быстрая пуля ничего не проскакивает); во что
// отрезок упёрся первым — туда и попала. Вспышка, искры, дым, гильза, трассер по той же параболе и звук
// (effects.js, tracer.js, sound.js); попавшая мишень звенит и слетает со стойки, лежащая — подпрыгивает.
// Время пули — сценовое (dt): в замедлении пули летят медленнее.
import { createEffects } from './effects.js';
import { TARGET_LAYOUT, createTargets, groundAt, targetSpots } from './targets.js';
import { createSound } from './sound.js';
import { createMana } from './mana.js';
import { createBlackhole } from './blackhole.js';
import { createArena, ROCKET_LIFE } from './arena-weapons.js';

const SPEED_OF_SOUND = 343; // м/с: звук попадания приходит с задержкой
const GRAVITY = 9.81; // м/с²
const BULLET_SPEED = 360; // м/с по умолчанию (пистолет); у оружия своя — GUNS.speed в main.js
const BULLET_LIFE = 3; // с: дольше пуля не живёт
const BULLET_PATH = 1500; // м вдоль ствола: и не дальше
const BULLET_STEP = 1 / 60; // с: путь пули за кадр режется на отрезки не длиннее этого
const MAX_BULLETS = 32; // одновременно в полёте (пул); лишняя вытесняет самую старую
const AIM_SEGS = 5; // отрезков параболы у прицела (контур мишени)
const GROUND_FX_M = 150; // пыль от пули в земле — только ближе этого к игроку
// где пуля через t с: дуло + ствол·v·t − ½·g·t² по вертикали (без сопротивления воздуха)
// g — гравитация этой пули (мана-снаряд падает медленнее, MANA_GRAVITY)
const MANA_GRAVITY = 2.5;
const posAt = (out, muzzle, dir, speed, t, g = GRAVITY) => {
  out.copy(muzzle).addScaledVector(dir, speed * t);
  out.y -= 0.5 * g * t * t;
  return out;
};

export function createShooting({ THREE, root, camera }) {
  const shared = (globalThis.__sceneState ??= {});
  const group = new THREE.Group();
  root.add(group);
  const effects = createEffects({ THREE, group });
  const mana = createMana({ THREE, group, camera }); // мана-снаряды (projectile: 'mana')
  // чёрные дыры (projectile: 'blackhole', blackhole.js): не пуля — летит и тянет всё к себе сама;
  // мишени этой сцены (если включены) тоже притягиваются и сбиваются
  const blackhole = createBlackhole({ THREE, group, camera, groundAt, plates: () => (enabled ? targets : null), knockPlate: (t, p, d) => targetSet.knock(t, p, d) });
  // оружие арены (arena-weapons.js): ракета и плазма — пули этого пула без гравитации (вид и взрыв —
  // там), рельса — railShot ниже (мгновенный сквозной луч)
  const arena = createArena({
    THREE, group, camera,
    smokePuff: (x, y, z, ux, uy, uz, a0, a1, life, a) => effects.smokePuff(x, y, z, ux, uy, uz, a0, a1, life, a),
    plates: () => (enabled ? targets : null),
    knockPlate: (t, p, d) => targetSet.knock(t, p, d),
  });
  // Звук живёт между подменами сцены: контекст создаётся один раз (их число в странице ограничено).
  const sound = (shared.sound ??= createSound());

  // Мишени на деревянных стойках, их падение и тени — targets.js.
  // Мишени можно выключить целиком (сцена без мишеней, compositions.js): их группа скрыта, пули и
  // тарелки сквозь них пролетают, перед игроком они не встают.
  const targetGroup = new THREE.Group();
  targetGroup.name = 'targets';
  group.add(targetGroup);
  const targetSet = createTargets({ THREE, group: targetGroup, shared, camera });
  const targets = targetSet.plates;
  const raycaster = new THREE.Raycaster();
  const RANGE = 60; // дальше самого дальнего ряда (38 м)
  raycaster.far = RANGE;

  // ---- Пробоины в мишенях: сквозные дырки с рваным краем рисует шейдер мишени (targets.js setHoles).
  // Список следов переживает подмену сцены и сохраняется в сценах; на мишени не больше MAX_DECALS
  // последних. След: [x, y, z, поворот, размер] в системе мишени.
  const MAX_DECALS = 120; // столько же, сколько MAX_HOLES в targets.js
  if (shared.targetDecals?.length !== targets.length) shared.targetDecals = targets.map(() => []);
  const decalsOf = shared.targetDecals;
  const syncHoles = (index) => targetSet.setHoles(index, decalsOf[index]);
  targets.forEach((_, index) => syncHoles(index));
  const addDecal = (target, worldPoint) => {
    const local = target.worldToLocal(worldPoint.clone());
    const index = targets.indexOf(target);
    const list = decalsOf[index];
    list.push([local.x, local.y, local.z + 0.0015, Math.random() * Math.PI * 2, 0.8 + Math.random() * 0.5]);
    if (list.length > MAX_DECALS) list.shift();
    syncHoles(index);
  };

  const clearDecals = () =>
    targets.forEach((_, index) => {
      decalsOf[index] = [];
      syncHoles(index);
    });

  // Где стоят стойки: [{ x, z, yaw, near }] — переживает подмену сцены.
  let spots = null;
  const saveTargets = () => {
    if (!spots) return;
    shared.targetStands = spots;
    shared.targetLayout = TARGET_LAYOUT;
  };

  // Мишени встают перед игроком рядами вдаль (5…38 м), лицом к нему; сбитые снова стоят, следы от
  // пуль стираются. gaze: по взгляду сейчас; иначе — вперёд по оси мира −Z, куда игрок смотрит после
  // центровки.
  const placeInFront = (gaze = true) => {
    const head = camera.getWorldPosition(new THREE.Vector3());
    const forward = gaze ? camera.getWorldDirection(new THREE.Vector3()) : new THREE.Vector3(0, 0, -1);
    forward.y = 0;
    forward.normalize();
    spots = targetSpots(head, forward);
    targetSet.place(spots, { resetFallen: true });
    clearDecals();
    saveTargets();
  };

  // После подмены сцены стойки остаются там же (сбитые мишени лежат); после перезагрузки их ставят
  // перед игроком (и когда в targets.js поменялась расстановка).
  let placed = false;
  if (Array.isArray(shared.targetStands) && shared.targetLayout === TARGET_LAYOUT) {
    spots = shared.targetStands;
    targetSet.place(spots);
    placed = true;
  }

  const rayObjects = [targetSet.plateMesh, targetSet.standMesh]; // во что упирается пуля
  let enabled = true;
  const setEnabled = (on) => {
    enabled = Boolean(on);
    targetGroup.visible = enabled;
    rayObjects.length = 0;
    if (enabled) rayObjects.push(targetSet.plateMesh, targetSet.standMesh);
    else targetSet.setAim(null);
  };
  const aimHits = [];
  const normal = new THREE.Vector3();
  const scratch = new THREE.Vector3();
  let clayTarget = null; // глиняные тарелки (clays.js), их тоже можно сбить
  // Другие цели (робопёс, robodog.js): { cast(origin, dir, far) → расстояние или −1,
  // hit(origin, dir, distance) → true (попадание) | false | null (не в счёт), shot?(origin, dir, far) —
  // любой выстрел (пуля остановилась на far) }. Ближайшая из всех целей (тарелки тоже) получает пулю.
  const shootables = [];
  let extraHit = null;
  // ближайшая цель среди тарелок (withClay) и shootables не дальше far: расстояние или −1; кто — extraHit
  const castExtra = (origin, dir, far, withClay) => {
    extraHit = null;
    let best = -1;
    if (withClay && clayTarget) {
      const d = clayTarget.cast(origin, dir, far);
      if (d >= 0 && d <= far) {
        best = d;
        extraHit = clayTarget;
      }
    }
    for (let i = 0; i < shootables.length; i += 1) {
      const handler = shootables[i];
      const d = handler.cast(origin, dir, best >= 0 ? best : far);
      if (d >= 0 && (best < 0 || d < best)) {
        best = d;
        extraHit = handler;
      }
    }
    return best;
  };
  // ---- Автонаводка (оружие с autoAim: <градусы>, main.js GUNS / generated-guns.js): при выстреле
  // пуля летит не вдоль ствола, а в центр лучшей цели в конусе ±autoAim° вокруг ствола (наименьший
  // угол; почти равные — ближняя), с поправкой на падение пули и упреждением v·t (бегущий пёс).
  // Цели: стоящие мишени, летящие тарелки (clayTarget.aimTargets) и всё из shootables, у кого есть
  // aimTargets(visit) — visit(центр: Vector3, vx, vy, vz) для каждой живой вражеской цели (robodog-horde.js).
  // Поза пушки не меняется; метки захвата нет (кольцо убрано по просьбе пользователя).
  const lockPos = new THREE.Vector3();
  const lockVel = new THREE.Vector3();
  const autoDir = new THREE.Vector3();
  const sMuzzle = new THREE.Vector3();
  const sDir = new THREE.Vector3();
  const sTo = new THREE.Vector3();
  let sCos = 1;
  let sFar = 0;
  let lockFound = false;
  let lockAngle = 0;
  let lockDist = 0;
  let lockPlate = -1;
  let visitPlate = -1;
  // самонаведение: кто дал цель (clayTarget / shootable) и её ключ (key — любой постоянный объект
  // цели: пёс, тарелка) — по ним цель находится снова каждый шаг (refreshHome)
  let lockKey = null;
  let lockProv = null;
  let visitProv = null;
  const visitAim = (pos, vx = 0, vy = 0, vz = 0, key = null) => {
    sTo.subVectors(pos, sMuzzle);
    const dist = sTo.length();
    if (dist < 0.3 || dist > sFar) return;
    const c = sTo.dot(sDir) / dist;
    if (c < sCos) return;
    const angle = Math.acos(Math.min(1, c));
    // «почти тот же угол» (разница < AUTO_TIE_RAD ≈ 0,15°) — побеждает ближняя
    const better = !lockFound || (Math.abs(angle - lockAngle) < AUTO_TIE_RAD ? dist < lockDist : angle < lockAngle);
    if (!better) return;
    lockFound = true;
    lockAngle = angle;
    lockDist = dist;
    lockPos.copy(pos);
    lockVel.set(vx, vy, vz);
    lockPlate = visitPlate;
    lockKey = key;
    lockProv = visitProv;
  };
  const AUTO_TIE_RAD = 0.0026;
  // лучшая цель в конусе deg° вокруг dir; true — нашлась (lockPos, lockVel, lockPlate)
  const searchLock = (muzzle, dir, deg, speed) => {
    lockFound = false;
    lockPlate = -1;
    lockKey = null;
    lockProv = null;
    visitProv = null;
    sMuzzle.copy(muzzle);
    sDir.copy(dir).normalize();
    sCos = Math.cos((Math.min(45, deg) * Math.PI) / 180);
    sFar = Math.min(BULLET_PATH, speed * BULLET_LIFE);
    if (enabled) {
      const bodies = shared.targetBodies;
      for (let i = 0; i < targets.length; i += 1) {
        if (bodies?.[i]?.fallen) continue;
        visitPlate = i;
        visitAim(scratch.setFromMatrixPosition(targets[i].matrixWorld));
      }
    }
    visitPlate = -1;
    visitProv = clayTarget;
    clayTarget?.aimTargets?.(visitAim);
    for (let i = 0; i < shootables.length; i += 1) {
      visitProv = shootables[i];
      shootables[i].aimTargets?.(visitAim);
    }
    visitProv = null;
    return lockFound;
  };
  // ---- Самонаводящийся снаряд (shoot({ homing })): летит вдоль ствола, через delayS начинает
  // поворачивать к ТЕКУЩЕМУ центру цели (с упреждением v·t) не быстрее turnDegS°/с — видна дуга.
  // Цель пропала (убита, разбита, упала) или проскочена — дальше прямо. Скорость постоянна.
  const HOMING_STEP = 1 / 120; // с: шаг интегрирования (отрезки для попаданий — те же)
  let findKey = null;
  let findOk = false;
  const findPos = new THREE.Vector3();
  const findVel = new THREE.Vector3();
  const visitFind = (pos, vx = 0, vy = 0, vz = 0, key = null) => {
    if (findOk || key !== findKey) return;
    findOk = true;
    findPos.copy(pos);
    findVel.set(vx, vy, vz);
  };
  // где цель пули b сейчас (b.hPos, b.hVel); нет её — самонаведение выключается
  const refreshHome = (b) => {
    if (b.hPlate >= 0) {
      if (!enabled || shared.targetBodies?.[b.hPlate]?.fallen || !targets[b.hPlate]) b.hPlate = -1;
      else b.hPos.setFromMatrixPosition(targets[b.hPlate].matrixWorld);
      return;
    }
    if (!b.hKey) return;
    findKey = b.hKey;
    findOk = false;
    if (b.hProv === clayTarget || shootables.includes(b.hProv)) b.hProv?.aimTargets?.(visitFind);
    findKey = null;
    if (!findOk) {
      b.hKey = null;
      return;
    }
    b.hPos.copy(findPos);
    b.hVel.copy(findVel);
  };
  const homeTo = new THREE.Vector3();
  const homeDir = new THREE.Vector3();
  const steerHome = (b, h) => {
    const tti = homeTo.subVectors(b.hPos, b.pos).length() / b.speed;
    homeTo.copy(b.hPos).addScaledVector(b.hVel, tti).sub(b.pos);
    const dist = homeTo.length();
    if (dist < 1e-3) return;
    homeTo.divideScalar(dist);
    homeDir.copy(b.vel).normalize();
    const c = Math.max(-1, Math.min(1, homeDir.dot(homeTo)));
    if (c < 0) {
      // проскочил — дальше прямо
      b.hKey = null;
      b.hPlate = -1;
      return;
    }
    const angle = Math.acos(c);
    // не медленнее turnDegS, а у близкой цели — столько, чтобы закрыть угол за половину оставшегося
    // времени (дуга плавно круче к концу, но снаряд всегда сходится)
    const maxTurn = Math.max(b.hTurn, (2 * angle) / Math.max(dist / b.speed, h)) * h;
    if (angle <= maxTurn) homeDir.copy(homeTo);
    else {
      const f = maxTurn / angle;
      const s = Math.sin(angle);
      homeDir.multiplyScalar(Math.sin((1 - f) * angle) / s).addScaledVector(homeTo, Math.sin(f * angle) / s).normalize();
    }
    b.vel.copy(homeDir).multiplyScalar(b.speed);
  };
  // направление выстрела в lockPos (с упреждением lockVel·t) по параболе: нижний угол из
  // tg θ = (v² − √(v⁴ − g(g·h² + 2·y·v²))) / (g·h); недолёт по дальности — прямо на цель
  const solveLock = (muzzle, speed, out, g = GRAVITY) => {
    const v2 = speed * speed;
    let t = 0;
    for (let k = 0; k < 3; k += 1) {
      const px = lockPos.x + lockVel.x * t - muzzle.x;
      const py = lockPos.y + lockVel.y * t - muzzle.y;
      const pz = lockPos.z + lockVel.z * t - muzzle.z;
      const h = Math.hypot(px, pz);
      const disc = v2 * v2 - g * (g * h * h + 2 * py * v2);
      if (h < 1e-4 || g <= 0 || disc < 0) {
        out.set(px, py, pz).normalize();
        t = Math.hypot(h, py) / speed;
      } else {
        const tan = (v2 - Math.sqrt(disc)) / (g * h);
        const cos = 1 / Math.sqrt(1 + tan * tan);
        out.set((px / h) * cos, tan * cos, (pz / h) * cos);
        t = h / (speed * cos);
      }
      if (lockVel.lengthSq() === 0) break;
    }
    return out;
  };

  const aimPoint = new THREE.Vector3();
  const segDir = new THREE.Vector3();
  const segHit = { point: new THREE.Vector3(), normal: new THREE.Vector3(), target: null, isStand: false };

  // ---- Пули в полёте (пул, без выделений памяти за кадр)
  const bullets = [];
  for (let i = 0; i < MAX_BULLETS; i += 1) {
    bullets.push({ active: false, muzzle: new THREE.Vector3(), dir: new THREE.Vector3(), speed: BULLET_SPEED, age: 0, kind: null, tracer: 0, onResult: null, born: 0, g: GRAVITY, mana: 0, color: null, arena: 0, life: BULLET_LIFE,
      // самонаведение: численный полёт (pos, vel), цель (hPlate | hProv + hKey), её центр и скорость
      home: false, pos: new THREE.Vector3(), vel: new THREE.Vector3(), travel: 0, hDelay: 0, hTurn: 0, hPlate: -1, hProv: null, hKey: null, hPos: new THREE.Vector3(), hVel: new THREE.Vector3() });
  }
  let bornCounter = 0;
  let lastAim = null; // мишень под контуром (для vr:eval)
  const bA = new THREE.Vector3();
  const bB = new THREE.Vector3();
  const bDir = new THREE.Vector3();
  const bPoint = new THREE.Vector3();
  const bVel = new THREE.Vector3();
  const bNormal = new THREE.Vector3();
  const bulletHits = [];
  const camPos = new THREE.Vector3();
  const finish = (b, t, result) => {
    b.active = false;
    effects.tracerLand(b.tracer, b.speed * t);
    if (b.mana) mana.land(b.mana, t);
    const cb = b.onResult;
    b.onResult = null;
    if (cb) {
      try {
        cb(result);
      } catch (e) {
        console.warn('[shooting] onResult', e?.message ?? e);
      }
    }
  };
  // отрезок пути пули b от bA (время t0) до bB (t1): упёрлась — попадание разобрано, true
  const castBullet = (b, t0, t1) => {
    bDir.subVectors(bB, bA);
    const len = bDir.length();
    if (len < 1e-6) return false;
    bDir.divideScalar(len);
    let far = len;
    let what = 0; // 0 — ничего, 1 — земля, 2 — мишень, 3 — стойка, 4 — тарелка/робопёс
    let plateIndex = -1;
    // земля (тот же рельеф, что рисует world.js): конец отрезка под землёй — ищем, где пересёк
    if (bB.y < groundAt(bB.x, bB.z) && bA.y >= groundAt(bA.x, bA.z)) {
      let lo = 0;
      let hi = 1;
      for (let k = 0; k < 8; k += 1) {
        const f = (lo + hi) * 0.5;
        bPoint.copy(bA).addScaledVector(bDir, f * len);
        if (bPoint.y < groundAt(bPoint.x, bPoint.z)) hi = f;
        else lo = f;
      }
      far = hi * len;
      what = 1;
    }
    if (rayObjects.length) {
      raycaster.set(bA, bDir);
      raycaster.far = far;
      bulletHits.length = 0;
      raycaster.intersectObjects(rayObjects, false, bulletHits);
      raycaster.far = RANGE;
      const hit = bulletHits[0];
      if (hit) {
        far = hit.distance;
        if (hit.object === targetSet.plateMesh) {
          what = 2;
          plateIndex = hit.instanceId;
          if (hit.face) bNormal.copy(hit.face.normal);
          else bNormal.copy(bDir).negate();
        } else what = 3;
      }
      bulletHits.length = 0;
    }
    // глиняная тарелка (clays.js) или другая цель (робопёс) ближе — пуля попадает в неё
    const extraDistance = castExtra(bA, bDir, far, true);
    const extra = extraHit;
    if (extraDistance >= 0) {
      far = extraDistance;
      what = 4;
    }
    for (let i = 0; i < shootables.length; i += 1) shootables[i].shot?.(bA, bDir, far);
    if (!what) return false;

    const t = t0 + ((t1 - t0) * far) / len;
    bPoint.copy(bA).addScaledVector(bDir, far);
    // направление полёта в момент попадания (с учётом падения)
    if (b.home) bVel.copy(b.vel);
    else {
      bVel.copy(b.dir).multiplyScalar(b.speed);
      bVel.y -= b.g * t;
    }
    bVel.normalize();
    const keepKind = shared.shotKind;
    shared.shotKind = b.kind; // калибр той пули, что попала (пока она летела, оружие могли сменить)
    let result = false;
    if (what === 4) {
      const r = extra.hit(bA, bDir, far);
      result = r === undefined ? true : r;
    } else if (what === 2) {
      const target = targets[plateIndex];
      if (target) {
        bNormal.transformDirection(target.matrixWorld);
        addDecal(target, bPoint);
        targetSet.knock(target, bPoint, bVel);
        if (!b.mana && !b.arena) {
          effects.impact(bPoint, bNormal.clone());
          const delay = Math.min(250, (b.muzzle.distanceTo(bPoint) / SPEED_OF_SOUND) * 1000);
          const at = bPoint.clone();
          setTimeout(() => sound.hit(at), delay);
        }
        result = true;
      }
    } else if (what === 1 && !b.mana && !b.arena) {
      camera.getWorldPosition(camPos);
      if (b.gfx > 0) {
        if (camPos.distanceToSquared(bPoint) < 400 * 400) effects.groundHit(bPoint.clone(), b.gfx);
      } else if (camPos.distanceToSquared(bPoint) < GROUND_FX_M * GROUND_FX_M) effects.groundHit(bPoint.clone());
    }
    // мана-снаряд: вместо искр и пыли — магический всплеск и «чпок» со звоном (во что бы ни попал)
    if (b.mana) {
      mana.impact(bPoint, b.color);
      sound.manaHit?.(bPoint);
    }
    // ракета — взрыв с уроном по области, плазма — голубой всплеск (arena-weapons.js)
    if (b.arena) arena.impact(b.arena, bPoint, what);
    shared.shotKind = keepKind;
    finish(b, t, result);
    return true;
  };
  // самонаводящаяся пуля: шаги HOMING_STEP, руление к цели, каждый шаг — отрезок для попаданий
  const stepHoming = (b, dt) => {
    const end = Math.min(b.age + dt, BULLET_LIFE);
    refreshHome(b); // раз за шаг мира: где цель сейчас (и жива ли)
    let t0 = b.age;
    while (t0 < end) {
      const t1 = Math.min(end, t0 + HOMING_STEP);
      const h = t1 - t0;
      bA.copy(b.pos);
      if (t0 >= b.hDelay && (b.hKey || b.hPlate >= 0)) steerHome(b, h);
      b.vel.y -= b.g * h;
      b.pos.addScaledVector(b.vel, h);
      bB.copy(b.pos);
      b.travel += b.speed * h;
      if (castBullet(b, t0, t1)) {
        if (b.mana) mana.track(b.mana, bPoint, b.vel);
        return;
      }
      t0 = t1;
    }
    b.age = end;
    if (b.mana) mana.track(b.mana, b.pos, b.vel);
    if (end >= BULLET_LIFE || b.travel >= BULLET_PATH) finish(b, end, false);
  };
  const stepBullet = (b, dt) => {
    if (b.home) {
      stepHoming(b, dt);
      return;
    }
    const end = Math.min(b.age + dt, b.life, BULLET_PATH / b.speed);
    let t0 = b.age;
    while (t0 < end) {
      const t1 = Math.min(end, t0 + BULLET_STEP);
      posAt(bA, b.muzzle, b.dir, b.speed, t0, b.g);
      posAt(bB, b.muzzle, b.dir, b.speed, t1, b.g);
      if (castBullet(b, t0, t1)) return;
      t0 = t1;
    }
    b.age = end;
    if (end >= b.life || end >= BULLET_PATH / b.speed) {
      // ни во что не попала; ракета взрывается в воздухе там, где кончилась
      if (b.arena) arena.impact(b.arena, posAt(bPoint, b.muzzle, b.dir, b.speed, end, b.g), 0);
      finish(b, end, false);
    }
  };
  // контур прицела: в какую мишень попадёт пуля по параболе (AIM_SEGS отрезков до range)
  const aimBallistic = (muzzle, direction, range, speed) => {
    const T = range / speed;
    for (let i = 0; i < AIM_SEGS; i += 1) {
      posAt(bA, muzzle, direction, speed, (T * i) / AIM_SEGS);
      posAt(bB, muzzle, direction, speed, (T * (i + 1)) / AIM_SEGS);
      bDir.subVectors(bB, bA);
      const len = bDir.length();
      bDir.divideScalar(len);
      raycaster.set(bA, bDir);
      raycaster.far = len;
      aimHits.length = 0;
      raycaster.intersectObjects(rayObjects, false, aimHits);
      raycaster.far = RANGE;
      const hit = aimHits[0];
      // робопёс ближе — пуля в него, контура нет
      if (shootables.length && castExtra(bA, bDir, hit ? hit.distance : len, false) >= 0) return null;
      if (hit) return hit.object === targetSet.plateMesh ? targets[hit.instanceId] : null;
    }
    return null;
  };

  // ---- Рельса (projectile: 'rail', рейлган): мгновенный луч до RAIL_RANGE м или до земли, пробивает
  // всё на пути. Кандидаты — все мишени (все пересечения луча; стойки пробивает), тарелка, каждый пёс
  // (unit.cast), каждый коптер (шар hitR). По порядку каждого бьём его обычным обработчиком, как пулей
  // (урон по shared.shotKind — у рейлгана 'awp': мелких и средних насмерть, ноги ломает), — коротким
  // лучом из точки чуть перед ним (castExtra на 0,35 м). Вид и звук — arena.rail.
  const RAIL_RANGE = 300;
  const RAIL_MAX = 64;
  const railT = new Float32Array(RAIL_MAX);
  const railPlate = new Int16Array(RAIL_MAX); // ≥ 0 — номер мишени, −1 — тарелка / shootable
  const railOrder = new Uint8Array(RAIL_MAX);
  const railHitT = new Float32Array(RAIL_MAX);
  const railFrom = new THREE.Vector3();
  const railDir = new THREE.Vector3();
  const railOc = new THREE.Vector3();
  let railN = 0;
  const railInfo = { far: 0, ground: false, candidates: 0, hits: 0, any: false }; // последний луч (vr:eval: shooting.railInfo())
  const railAdd = (t, plate) => {
    if (railN >= RAIL_MAX || !(t >= 0)) return;
    railT[railN] = t;
    railPlate[railN] = plate;
    railN += 1;
  };
  const railShot = (muzzle, direction, onResult) => {
    railFrom.copy(muzzle);
    railDir.copy(direction).normalize();
    // земля: шаги по 1,5 м, потом деление пополам
    let far = RAIL_RANGE;
    let ground = false;
    let prev = 0;
    for (let s = 1.5; s <= RAIL_RANGE + 1e-3; s += 1.5) {
      bPoint.copy(railFrom).addScaledVector(railDir, s);
      if (bPoint.y < groundAt(bPoint.x, bPoint.z)) {
        let lo = prev;
        let hi = s;
        for (let k = 0; k < 10; k += 1) {
          const f = (lo + hi) * 0.5;
          bPoint.copy(railFrom).addScaledVector(railDir, f);
          if (bPoint.y < groundAt(bPoint.x, bPoint.z)) hi = f;
          else lo = f;
        }
        far = hi;
        ground = true;
        break;
      }
      prev = s;
    }
    railN = 0;
    if (rayObjects.length) {
      raycaster.set(railFrom, railDir);
      raycaster.far = far;
      bulletHits.length = 0;
      raycaster.intersectObjects(rayObjects, false, bulletHits);
      raycaster.far = RANGE;
      for (let h = 0; h < bulletHits.length; h += 1) {
        const hit = bulletHits[h];
        if (hit.object !== targetSet.plateMesh) continue;
        let seen = false;
        for (let k = 0; k < railN; k += 1) if (railPlate[k] === hit.instanceId) seen = true;
        if (!seen) railAdd(hit.distance, hit.instanceId);
      }
      bulletHits.length = 0;
    }
    if (clayTarget) railAdd(clayTarget.cast(railFrom, railDir, far), -1);
    const units = shared.horde?.debug?.units?.();
    if (units) {
      for (let i = 0; i < units.length; i += 1) {
        if (units[i].mode === 'off') continue;
        const d = units[i].cast(railFrom, railDir, far);
        if (d >= 0 && d <= far) railAdd(d, -1);
      }
    }
    const drones = shared.droneTargets;
    if (drones) {
      for (let i = 0; i < drones.length; i += 1) {
        const d = drones[i];
        if (d.state !== 'alive' && d.state !== 'dying') continue;
        railOc.set(d.x - railFrom.x, d.y - railFrom.y, d.z - railFrom.z);
        const tc = railOc.dot(railDir);
        const d2 = railOc.lengthSq() - tc * tc;
        const r = d.hitR ?? 0.3;
        if (tc < 0 || d2 > r * r) continue;
        const t = tc - Math.sqrt(r * r - d2);
        if (t <= far) railAdd(Math.max(0, t), -1);
      }
    }
    // по порядку вдоль луча (вставками: кандидатов мало)
    for (let i = 0; i < railN; i += 1) {
      let j = i - 1;
      while (j >= 0 && railT[railOrder[j]] > railT[i]) {
        railOrder[j + 1] = railOrder[j];
        j -= 1;
      }
      railOrder[j + 1] = i;
    }
    let any = false;
    let nHits = 0;
    for (let o = 0; o < railN; o += 1) {
      const i = railOrder[o];
      const t = railT[i];
      if (railPlate[i] >= 0) {
        const target = targets[railPlate[i]];
        if (!target) continue;
        bPoint.copy(railFrom).addScaledVector(railDir, t);
        addDecal(target, bPoint);
        targetSet.knock(target, bPoint, railDir);
        effects.impact(bPoint.clone(), railDir.clone().negate());
        sound.hit(bPoint.clone());
        any = true;
      } else {
        bA.copy(railFrom).addScaledVector(railDir, Math.max(0, t - 0.05));
        const d = castExtra(bA, railDir, 0.35, true);
        if (d < 0 || !extraHit) continue;
        const r = extraHit.hit(bA, railDir, d);
        if (r === undefined || r === true) any = true;
      }
      railHitT[nHits] = t;
      nHits += 1;
    }
    for (let i = 0; i < shootables.length; i += 1) shootables[i].shot?.(railFrom, railDir, far);
    railInfo.far = far;
    railInfo.ground = ground;
    railInfo.candidates = railN;
    railInfo.hits = nHits;
    railInfo.any = any;
    arena.rail(railFrom, railDir, far, railHitT, nHits, ground);
    if (onResult) {
      try {
        onResult(any ? true : nHits ? null : false);
      } catch (e) {
        console.warn('[shooting] onResult', e?.message ?? e);
      }
    }
  };

  // shared.shooting — ручка для npm run vr:eval (проверить выстрел без пистолета в руке)
  const api = (shared.shooting = {
    placeInFront,
    // Мишени есть в этой сцене или нет (вызывается до первого кадра: выключенные не встают).
    setTargetsEnabled: setEnabled,
    targetsEnabled: () => enabled,
    // Сцены (compositions.js): состояние мишеней — { layout, stands, bodies, decals } или null (мишеней нет)
    getTargets() {
      if (!enabled || !spots) return null;
      return { layout: TARGET_LAYOUT, stands: spots, bodies: targetSet.getBodies(), decals: decalsOf };
    },
    // state: как из getTargets(); {} — мишени заново перед игроком; null — мишеней нет
    // «Зареспавнить мишени»: все мишени снова на своих стойках (на тех же местах), пробоины стёрты
    respawnTargets() {
      if (!Array.isArray(spots) || spots.length !== targets.length) return placeInFront(false);
      targetSet.place(spots, { resetFallen: true });
      clearDecals();
      targets.forEach((_, index) => syncHoles(index));
      saveTargets();
    },
    setTargets(state) {
      if (!state) {
        setEnabled(false);
        return;
      }
      setEnabled(true);
      if (Array.isArray(state.stands) && state.stands.length === targets.length) {
        spots = state.stands;
        targetSet.place(spots, { resetFallen: true });
        targetSet.setBodies(state.bodies);
        clearDecals();
        (state.decals ?? []).forEach((list, index) => {
          if (!targets[index] || !Array.isArray(list)) return;
          decalsOf[index].push(...list.slice(-MAX_DECALS));
          syncHoles(index);
        });
        saveTargets();
      } else placeInFront(false);
      placed = true;
    },
    // Прицел (каждый кадр). Возвращает точку для лазера — луч прямой (свет не падает), а белый контур
    // получает мишень, в которую попадёт пуля по параболе (speed — её скорость). aim(null) — оружия нет.
    // range — дальность прицела (дальнобойное — больше; по умолчанию RANGE)
    aim(muzzle, direction, range = RANGE, speed = BULLET_SPEED) {
      effects.setMuzzle(muzzle); // струйка дыма идёт от дула, где бы оно ни было
      let target = null;
      let point = null;
      if (muzzle) {
        raycaster.set(muzzle, direction);
        raycaster.far = range;
        aimHits.length = 0;
        raycaster.intersectObjects(rayObjects, false, aimHits);
        raycaster.far = RANGE;
        const hit = aimHits[0];
        if (hit) point = aimPoint.copy(hit.point); // для лазерного прицела (laser.js)
        // другая цель (робопёс) ближе — лазер упирается в неё (тарелки — как раньше, насквозь)
        if (shootables.length) {
          const d = castExtra(muzzle, direction, hit ? hit.distance : range, false);
          if (d >= 0) point = aimPoint.copy(muzzle).addScaledVector(direction, d);
        }
        if (rayObjects.length && shared.aimOutline !== false) target = aimBallistic(muzzle, direction, range, speed);
      }
      lastAim = target;
      targetSet.setAim(target);
      return point;
    },
    // muzzle, direction: мировые координаты дула и направления ствола; ejector, right, up — где
    // вылетает гильза (мировые координаты). Пуля улетает и попадает позже (update); результат —
    // onResult(true — попал (мишень, тарелка, робопёс) | false — промах | null — попал во что-то не в
    // счёт (лежащий робопёс)). speed — начальная скорость пули, м/с. Дальность пули — BULLET_LIFE и
    // BULLET_PATH (range, если передан, не учитывается).
    // big — крупный калибр: вторая вспышка с дымом чуть впереди дула
    // projectile: 'mana' — мана-снаряд (mana.js) вместо пули: свой вид, вспышка, попадание, без гильзы;
    // color — его цвет (hex); gravity — м/с² этой пули (по умолчанию 9,81, у маны MANA_GRAVITY)
    // homing: { delayS = 0.05, turnDegS = 360, gravity = 0 } + autoAimDeg — самонаведение: цель
    // выбирается в конусе autoAimDeg° вокруг ствола (как автонаводка), снаряд стартует ВДОЛЬ ствола и
    // доворачивает к ней по дуге (stepHoming). Трассера у самонаводящейся пули нет (мана рисует свой след).
    shoot(muzzle, direction, { ejector, right, up, big = false, speed = BULLET_SPEED, onResult = null, projectile = null, color = null, gravity = null, homing = null, autoAimDeg = 0, charge = 0, forceTracer = false, groundFx = 0 } = {}) {
      // forceTracer — трассер даже при «Трассеры: выкл»; groundFx > 0 — пыль от попадания в землю этого
      // размера на любом расстоянии до 400 м (пулемёт «Моего дрона», my-drone.js)
      // projectile: 'blackhole' — чёрная дыра (blackhole.js) силы charge 0..1 вместо пули; будит врагов
      if (projectile === 'blackhole') {
        blackhole.fire(muzzle, direction, { k: charge, onResult, speed });
        for (let i = 0; i < shootables.length; i += 1) shootables[i].shot?.(muzzle, direction, 0);
        return;
      }
      // projectile: 'rail' — мгновенный сквозной луч (railShot), пули нет
      if (projectile === 'rail') {
        railShot(muzzle, direction, onResult);
        return;
      }
      // пул: свободная пуля, иначе самая старая считается промахом и уступает место
      let b = null;
      for (let i = 0; i < MAX_BULLETS; i += 1) {
        const c = bullets[i];
        if (!c.active) {
          b = c;
          break;
        }
        if (!b || c.born < b.born) b = c;
      }
      if (b.active) finish(b, b.age, false);
      b.active = true;
      b.muzzle.copy(muzzle);
      b.dir.copy(direction).normalize();
      b.speed = speed;
      b.age = 0;
      b.kind = shared.shotKind ?? null;
      b.onResult = onResult;
      b.gfx = groundFx;
      b.born = (bornCounter += 1);
      const isMana = projectile === 'mana';
      b.g = gravity ?? (isMana ? MANA_GRAVITY : GRAVITY);
      b.color = color;
      b.home = Boolean(homing);
      b.hPlate = -1;
      b.hKey = null;
      b.hProv = null;
      if (b.home) {
        b.g = homing.gravity ?? 0;
        b.pos.copy(b.muzzle);
        b.vel.copy(b.dir).multiplyScalar(speed);
        b.travel = 0;
        b.hDelay = homing.delayS ?? 0.05;
        b.hTurn = ((homing.turnDegS ?? 360) * Math.PI) / 180;
        if (autoAimDeg > 0 && searchLock(muzzle, b.dir, autoAimDeg, speed)) {
          b.hPlate = lockPlate;
          b.hKey = lockPlate >= 0 ? null : lockKey;
          b.hProv = lockPlate >= 0 ? null : lockProv;
          b.hPos.copy(lockPos);
          b.hVel.copy(lockVel);
        }
      }
      b.life = BULLET_LIFE;
      b.arena = 0;
      if (isMana) {
        b.tracer = -1;
        b.mana = mana.fire(b.muzzle, b.dir, speed, b.g, color, b.home);
        mana.muzzle(muzzle, b.dir, color);
        sound.shot({ position: muzzle });
        return;
      }
      b.mana = 0;
      // ракета / плазма (arena-weapons.js): без гравитации (если gravity не задана), свой вид и звук
      if (projectile === 'rocket' || projectile === 'plasma') {
        b.tracer = -1;
        b.home = false;
        b.g = gravity ?? 0;
        if (projectile === 'rocket') b.life = ROCKET_LIFE;
        b.arena = arena.fire(projectile, b.muzzle, b.dir, speed, b.g);
        arena.muzzle(projectile, muzzle, b.dir);
        return;
      }
      b.tracer = b.home ? -1 : effects.tracer(b.muzzle, b.dir, speed, b.g, Math.min(BULLET_PATH, speed * BULLET_LIFE), forceTracer);

      effects.muzzleFlash(muzzle, direction);
      if (big) effects.muzzleFlash(muzzle.clone().addScaledVector(direction, 0.07), direction);
      if (ejector && right && up) effects.eject(ejector, right, up);
      sound.shot({ position: muzzle });
    },
    // Автонаводка при выстреле: направление в лучшую цель конуса deg° (с поправкой на падение и
    // упреждением) — общий вектор (перезаписывается) — или null, если в конусе никого. Ствол не трогает.
    // gravity — как у shoot (null: по projectile)
    autoAim(muzzle, direction, deg, speed = BULLET_SPEED, gravity = null, projectile = null) {
      if (!(deg > 0) || !searchLock(muzzle, direction, deg, speed)) return null;
      return solveLock(muzzle, speed, autoDir, gravity ?? (projectile === 'mana' ? MANA_GRAVITY : GRAVITY));
    },
    manaStats: () => mana.stats(), // для vr:eval
    // заряд чёрной дыры у дула (main.js, gun.charge): item — оружие в руке или null; true — стал полным
    chargeFx: (item, level, seconds) => blackhole.charge(item, level, seconds),
    blackhole, // для vr:eval: blackhole.stats(), blackhole.fire(from, dir, { k })
    arena, // для vr:eval: arena.stats() (ракеты, плазма, лучи рейлгана — arena-weapons.js)
    railInfo: () => ({ ...railInfo }), // последний луч рейлгана: far, ground, candidates, hits, any
    // для vr:eval: последняя захваченная цель { x, y, z, plate, deg, dist } или null
    autoAimLock: () =>
      lockFound ? { x: lockPos.x, y: lockPos.y, z: lockPos.z, plate: lockPlate, deg: +((lockAngle * 180) / Math.PI).toFixed(2), dist: +lockDist.toFixed(2) } : null,
    // номер мишени под контуром после последнего aim() (−1 — нет), для vr:eval
    aimedIndex: () => targets.indexOf(lastAim),
    // пули в полёте (для vr:eval): [{ age, speed, kind, x, y, z }]
    bullets() {
      return bullets.filter((b) => b.active).map((b) => {
        if (b.home) bPoint.copy(b.pos);
        else posAt(bPoint, b.muzzle, b.dir, b.speed, b.age, b.g);
        return { age: b.age, speed: b.speed, kind: b.kind, x: bPoint.x, y: bPoint.y, z: bPoint.z, home: b.home, tracking: Boolean(b.hKey || b.hPlate >= 0) };
      });
    },
    // Глиняные тарелки (clays.js): { cast(origin, dir, far) → расстояние или −1, hit(origin, dir, distance) }
    setClayTarget(handler) {
      clayTarget = handler;
    },
    // Все живые вражеские цели из shootables: visit(центр, vx, vy, vz, ключ) — для автопилота дрона
    forEachEnemy(visit) {
      for (let i = 0; i < shootables.length; i += 1) shootables[i].aimTargets?.(visit);
    },
    // Ещё одна цель для пуль (см. shootables выше). Возвращает функцию, которая её убирает.
    addShootable(handler) {
      shootables.push(handler);
      return () => {
        const i = shootables.indexOf(handler);
        if (i >= 0) shootables.splice(i, 1);
      };
    },
    // Отрезок from→to (мировые) против мишеней и стоек: { point, normal, target, isStand } или null.
    // Результат — общий объект (перезаписывается следующим вызовом).
    castSegment(from, to) {
      segDir.subVectors(to, from);
      const length = segDir.length();
      if (length < 1e-6) return null;
      raycaster.set(from, segDir.divideScalar(length));
      raycaster.far = length;
      aimHits.length = 0;
      raycaster.intersectObjects(rayObjects, false, aimHits);
      raycaster.far = RANGE;
      const hit = aimHits[0];
      if (!hit) return null;
      segHit.point.copy(hit.point);
      segHit.isStand = hit.object === targetSet.standMesh;
      segHit.target = segHit.isStand ? null : targets[hit.instanceId];
      segHit.normal.copy(segDir).negate();
      return segHit;
    },
    // Попадание в мишень не пулей (тарелкой): звон, контур гаснет, сбивается, если физика включена
    hitTarget(target, point, direction, quiet = false) {
      targetSet.knock(target, point, direction);
      if (!quiet) sound.hit(point);
    },
    // облачко пыли в точке
    puff(point) {
      effects.dust(point);
    },
    update(dt = 0.016) {
      if (enabled && !placed && camera.getWorldPosition(scratch).lengthSq() > 0) {
        // первый кадр: мишени перед игроком (камера уже на месте)
        placeInFront(false);
        placed = true;
      }
      if (enabled) targetSet.update(dt); // полёт сбитых мишеней и тени
      // пули: тот же шаг, что у трассера (tracer.js) — голова трассера там, где пуля
      const bulletDt = Math.min(0.05, dt || 0);
      if (bulletDt > 0) for (let i = 0; i < MAX_BULLETS; i += 1) if (bullets[i].active) stepBullet(bullets[i], bulletDt);
      effects.update(dt);
      mana.update(dt);
      blackhole.update(dt);
      arena.update(dt);
    },
    dispose() {
      for (let i = 0; i < MAX_BULLETS; i += 1) bullets[i].active = false; // летящие пули пропадают вместе со сценой
      saveTargets();
      effects.dispose();
      mana.dispose();
      blackhole.dispose();
      arena.dispose();
      targetSet.dispose();
    },
  });
  return api;
}
