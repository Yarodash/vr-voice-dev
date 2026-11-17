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
const posAt = (out, muzzle, dir, speed, t) => {
  out.copy(muzzle).addScaledVector(dir, speed * t);
  out.y -= 0.5 * GRAVITY * t * t;
  return out;
};

export function createShooting({ THREE, root, camera }) {
  const shared = (globalThis.__sceneState ??= {});
  const group = new THREE.Group();
  root.add(group);
  const effects = createEffects({ THREE, group });
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
  const aimPoint = new THREE.Vector3();
  const segDir = new THREE.Vector3();
  const segHit = { point: new THREE.Vector3(), normal: new THREE.Vector3(), target: null, isStand: false };

  // ---- Пули в полёте (пул, без выделений памяти за кадр)
  const bullets = [];
  for (let i = 0; i < MAX_BULLETS; i += 1) {
    bullets.push({ active: false, muzzle: new THREE.Vector3(), dir: new THREE.Vector3(), speed: BULLET_SPEED, age: 0, kind: null, tracer: 0, onResult: null, born: 0 });
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
    bVel.copy(b.dir).multiplyScalar(b.speed);
    bVel.y -= GRAVITY * t;
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
        effects.impact(bPoint, bNormal.clone());
        const delay = Math.min(250, (b.muzzle.distanceTo(bPoint) / SPEED_OF_SOUND) * 1000);
        const at = bPoint.clone();
        setTimeout(() => sound.hit(at), delay);
        result = true;
      }
    } else if (what === 1) {
      camera.getWorldPosition(camPos);
      if (camPos.distanceToSquared(bPoint) < GROUND_FX_M * GROUND_FX_M) effects.groundHit(bPoint.clone());
    }
    shared.shotKind = keepKind;
    finish(b, t, result);
    return true;
  };
  const stepBullet = (b, dt) => {
    const end = Math.min(b.age + dt, BULLET_LIFE, BULLET_PATH / b.speed);
    let t0 = b.age;
    while (t0 < end) {
      const t1 = Math.min(end, t0 + BULLET_STEP);
      posAt(bA, b.muzzle, b.dir, b.speed, t0);
      posAt(bB, b.muzzle, b.dir, b.speed, t1);
      if (castBullet(b, t0, t1)) return;
      t0 = t1;
    }
    b.age = end;
    if (end >= BULLET_LIFE || end >= BULLET_PATH / b.speed) finish(b, end, false); // ни во что не попала
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
    shoot(muzzle, direction, { ejector, right, up, big = false, speed = BULLET_SPEED, onResult = null } = {}) {
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
      b.born = (bornCounter += 1);
      b.tracer = effects.tracer(b.muzzle, b.dir, speed, GRAVITY, Math.min(BULLET_PATH, speed * BULLET_LIFE));

      effects.muzzleFlash(muzzle, direction);
      if (big) effects.muzzleFlash(muzzle.clone().addScaledVector(direction, 0.07), direction);
      if (ejector && right && up) effects.eject(ejector, right, up);
      sound.shot({ position: muzzle });
    },
    // номер мишени под контуром после последнего aim() (−1 — нет), для vr:eval
    aimedIndex: () => targets.indexOf(lastAim),
    // пули в полёте (для vr:eval): [{ age, speed, kind, x, y, z }]
    bullets() {
      return bullets.filter((b) => b.active).map((b) => {
        posAt(bPoint, b.muzzle, b.dir, b.speed, b.age);
        return { age: b.age, speed: b.speed, kind: b.kind, x: bPoint.x, y: bPoint.y, z: bPoint.z };
      });
    },
    // Глиняные тарелки (clays.js): { cast(origin, dir, far) → расстояние или −1, hit(origin, dir, distance) }
    setClayTarget(handler) {
      clayTarget = handler;
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
    },
    dispose() {
      for (let i = 0; i < MAX_BULLETS; i += 1) bullets[i].active = false; // летящие пули пропадают вместе со сценой
      saveTargets();
      effects.dispose();
      targetSet.dispose();
    },
  });
  return api;
}
