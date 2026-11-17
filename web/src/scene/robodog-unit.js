// Один робопёс «в мире»: модель (robodog-model.js), походка (robodog-gait.js), прыжок, попадания,
// сбивание с ног и подъём, смерть и тряпичная кукла (robodog-ragdoll.js), тень. Поведения тут нет:
// куда бежать, решает хозяин — одиночный пёс (robodog.js, мозг robodog-ai.js) или стая
// (robodog-horde.js). Хозяин двигает unit.dog (x, z, yaw, v, w, sniff, state) и зовёт unit.update(dt).
//
// Режимы: 'off' (в запасе), 'alive' (ходит), 'down' (сбит пулей: та же кукла на ~1 с, мышцы слабые),
// 'getup' (вскакивает: поза плавно переходит из куклы в стойку), 'dying' (судороги), 'dead' (кукла).
// Пули толкают куклу сильно (в точке попадания по ходу пули и вверх; калибр — shared.shotKind из
// main.js: пистолет слабее калаша, AWP сильнее всех); удары о землю звучат (глухой металл, скрежет).
//
// Искры и дуги — общий на всех псов эффект (robodog-fx.js): его anchors — общий массив, каждый пёс
// дописывает туда свои 9 шарниров (корпус, 4 бедра, 4 голени); индекс дуги = base + часть.
// Звуки — через createDogSfx (ограничение частоты, чтобы очередь и стая не забили звук).
// Всё игровое время — dt (замедление времени замедляет и псов).
import { buildRobodog } from './robodog-model.js';
import { L2, createGait, jumpSpeed } from './robodog-gait.js';
import { createDog } from './robodog-ai.js';
import { BODY_POINTS, COUNT, FOOT, KNEE, createRagdoll } from './robodog-ragdoll.js';
import { groundHeight } from './car.js';
import { createDogSound } from './robodog-sound.js';

const GRAVITY = 9.81;
const DYING_S = 1.6; // судороги до того, как обмякнет совсем
const DOWN_S = 1.0; // сбитый лежит, потом вскакивает
const GETUP_S = 0.55;
// корпус для попаданий: коробка в системе корпуса (центр, полуразмеры)
const BOX_C = [0, 0.01, -0.015];
const BOX_H = [0.112, 0.08, 0.43];
const UPPER_R = 0.045;
const LOWER_R = 0.034;
const EYE_ON = 0x45e8ff;
const EYE_OFF = 0x061418;
// сила выстрела по калибру (0..1): во сколько толкает куклу и как глубоко звенит корпус
const POWER = { pistol: 0.45, ak: 0.7, awp: 1 };

// Звуки псов (robodog-sound.js): не чаще, чем нужно уху, и без сотни голосов от очереди калаша.
// Ограничение частоты — по реальному времени (звук не замедляется в замедленном времени).
export function createDogSfx(shared) {
  const sound = createDogSound(shared);
  const last = {};
  const play = (name, gapMs, a, b) => {
    const now = performance.now();
    if (now - (last[name] ?? -1e9) < gapMs) return;
    last[name] = now;
    sound[name](a, b);
  };
  return {
    zap: (p, strength = 1) => play('zap', 55, p, strength),
    clank: (p) => play('clank', 40, p),
    clankHeavy: (p, k) => play('clankHeavy', 45, p, k),
    crackle: (p) => play('crackle', 90, p),
    powerDown: (p) => play('powerDown', 150, p),
    thud: (p) => play('thud', 120, p),
    servo: (p, speed) => play('servo', 110, p, speed),
    groundThud: (p, k) => play('groundThud', 110, p, k),
    scrape: (p, k) => play('scrape', 280, p, k),
  };
}

export function createDogUnit({ THREE, root, fx, anchors, shadowTexture, sfx, camera, textures = null, env = null, shared = globalThis.__sceneState ?? {} }) {
  const model = buildRobodog(THREE, { textures, env });
  model.group.visible = false;
  root.add(model.group);
  const base = anchors.length; // наши шарниры в общем массиве эффектов
  anchors.push(model.body, ...model.legs.map((l) => l.upper), ...model.legs.map((l) => l.knee));
  const gait = createGait();
  const ragdoll = createRagdoll();

  const shadowGeometry = new THREE.PlaneGeometry(1, 1);
  shadowGeometry.rotateX(-Math.PI / 2);
  const shadowMaterial = new THREE.MeshBasicMaterial({ map: shadowTexture, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 });
  const shadow = new THREE.Mesh(shadowGeometry, shadowMaterial);
  shadow.name = 'robodog-shadow';
  shadow.visible = false;
  shadow.renderOrder = 1;
  root.add(shadow);

  const v1 = new THREE.Vector3();
  const v2 = new THREE.Vector3();
  const v3 = new THREE.Vector3();
  const arcA = new THREE.Vector3(); // начало дуги (своя копия: точку могли передать общим вектором)
  const arcB = new THREE.Vector3();
  const hitPoint = new THREE.Vector3();
  const hitNormal = new THREE.Vector3();
  const bodyCenter = new THREE.Vector3();
  const bodyInv = new THREE.Matrix4();
  const basis = new THREE.Matrix4();
  const bodyQ = new THREE.Quaternion();
  const bodyQi = new THREE.Quaternion();
  const upperQi = new THREE.Quaternion();
  const ax = new THREE.Vector3();
  const ay = new THREE.Vector3();
  const az = new THREE.Vector3();
  const footLocal = new THREE.Vector3(0, -L2, 0);
  const joints = new Float32Array(36); // мировые: таз, колено, стопа × 4 ноги
  const points = new Float32Array(COUNT * 3);
  const frame = { c: [0, 0, 0], x: [0, 0, 0], y: [0, 0, 0], z: [0, 0, 0] };
  const eyeOn = new THREE.Color(EYE_ON);
  const eyeOff = new THREE.Color(EYE_OFF);
  const cmd = { v: 0, w: 0, sniff: 0, crouch: 0, air: null };
  // подъём: поза куклы в момент начала (корпус в мире, суставы относительно родителей)
  const capPos = new THREE.Vector3();
  const capQ = new THREE.Quaternion();
  const capLegs = [];
  for (let i = 0; i < 12; i += 1) capLegs.push(new THREE.Quaternion());
  const goalPos = new THREE.Vector3();
  const goalQ = new THREE.Quaternion();
  const tq = new THREE.Quaternion();
  const unusedScale = new THREE.Vector3();
  let flash = 0;
  let hitPart = 0;
  let groundBase = 0;
  let cosYaw = 1;
  let sinYaw = 0;
  let twitchLeft = 0;
  let eyeLeft = 0;
  let sink = 0; // труп уходит в землю (стая), м
  let lastHalf = 0; // половина цикла походки — для шагов сервоприводов
  let modeT = 0; // секунд в режиме down / getup

  const unit = {
    model,
    dog: createDog(),
    mode: 'off',
    health: 1,
    deadFor: 0,
    jumpH: 0,
    jumpVy: 0,
    bodyCenter,
    ragdoll,
    shadow, // для заблаговременной сборки шейдеров (robodog-horde.js: prewarm)
    get hitPart() {
      return hitPart;
    },
    // сбит или поднимается: хозяин его не водит
    get knocked() {
      return unit.mode === 'down' || unit.mode === 'getup';
    },
  };

  const shotPower = () => POWER[shared.shotKind] ?? 0.6;

  const groundLocal = (lx, lz) => {
    const dog = unit.dog;
    return groundHeight(dog.x + lx * cosYaw + lz * sinYaw, dog.z - lx * sinYaw + lz * cosYaw) - groundBase;
  };
  const placeAlive = () => {
    const dog = unit.dog;
    cosYaw = Math.cos(dog.yaw);
    sinYaw = Math.sin(dog.yaw);
    groundBase = groundHeight(dog.x, dog.z) + unit.jumpH;
    model.group.position.set(dog.x, groundBase, dog.z);
    model.group.rotation.set(0, dog.yaw, 0);
  };
  const shadowAt = (x, z, yaw, scale, opacity) => {
    shadow.visible = opacity > 0.02;
    shadow.position.set(x, groundHeight(x, z) + 0.012, z);
    shadow.rotation.set(0, yaw, 0);
    shadow.scale.set(0.62 * scale + 0.1, 1, 1.05 * scale);
    shadowMaterial.opacity = Math.min(1, opacity);
  };
  // ось кости: её −Y вдоль dir (система родителя), ось сгиба X — как у родителя
  const orientBone = (dir, out) => {
    ay.copy(dir).normalize().negate();
    ax.set(1, 0, 0).addScaledVector(ay, -ay.x);
    if (ax.lengthSq() < 1e-6) ax.set(0, 0, 1);
    ax.normalize();
    az.crossVectors(ax, ay);
    basis.makeBasis(ax, ay, az);
    out.setFromRotationMatrix(basis);
  };
  const placeRagdoll = () => {
    const p = ragdoll.pos;
    ragdoll.bodyFrame(frame);
    model.group.position.set(0, -sink, 0);
    model.group.rotation.set(0, 0, 0);
    ax.fromArray(frame.x);
    ay.fromArray(frame.y);
    az.fromArray(frame.z);
    basis.makeBasis(ax, ay, az);
    bodyQ.setFromRotationMatrix(basis);
    bodyQi.copy(bodyQ).invert();
    model.body.position.fromArray(frame.c);
    model.body.quaternion.copy(bodyQ);
    for (let i = 0; i < 4; i += 1) {
      const leg = model.legs[i];
      leg.hip.rotation.set(0, 0, 0);
      v1.copy(leg.hip.position).applyQuaternion(bodyQ).add(model.body.position);
      v2.set(p[(KNEE + i) * 3], p[(KNEE + i) * 3 + 1], p[(KNEE + i) * 3 + 2]);
      v3.subVectors(v2, v1).applyQuaternion(bodyQi);
      orientBone(v3, leg.upper.quaternion);
      upperQi.copy(leg.upper.quaternion).invert();
      v3.set(p[(FOOT + i) * 3], p[(FOOT + i) * 3 + 1], p[(FOOT + i) * 3 + 2]).sub(v2).applyQuaternion(bodyQi).applyQuaternion(upperQi);
      orientBone(v3, leg.knee.quaternion);
    }
    const lift = frame.c[1] - groundHeight(frame.c[0], frame.c[2]);
    shadowAt(frame.c[0], frame.c[2], Math.atan2(frame.z[0], frame.z[2]), 0.7, Math.max(0, 1 - lift * 1.5) * Math.max(0, 1 - sink * 3));
  };
  const collectJoints = () => {
    model.group.updateMatrixWorld(true);
    bodyCenter.setFromMatrixPosition(model.body.matrixWorld);
    bodyInv.copy(model.body.matrixWorld).invert();
    for (let i = 0; i < 4; i += 1) {
      const leg = model.legs[i];
      v1.setFromMatrixPosition(leg.upper.matrixWorld).toArray(joints, i * 9);
      v1.setFromMatrixPosition(leg.knee.matrixWorld).toArray(joints, i * 9 + 3);
      v1.copy(footLocal).applyMatrix4(leg.knee.matrixWorld).toArray(joints, i * 9 + 6);
    }
  };
  const collectRagdollPoints = () => {
    for (let i = 0; i < BODY_POINTS.length; i += 1) v1.fromArray(BODY_POINTS[i]).applyMatrix4(model.body.matrixWorld).toArray(points, i * 3);
    for (let i = 0; i < 4; i += 1) {
      for (let k = 0; k < 3; k += 1) {
        points[(KNEE + i) * 3 + k] = joints[i * 9 + 3 + k];
        points[(FOOT + i) * 3 + k] = joints[i * 9 + 6 + k];
      }
    }
  };

  // случайная точка на шарнире part (0 — корпус, 1–4 бёдра, 5–8 голени): мировая, в out
  const anchorPoint = (part, out) => {
    if (part === 0) {
      out.set((Math.random() - 0.5) * 0.2, Math.random() * 0.1 - 0.03, (Math.random() - 0.5) * 0.7);
      return out.applyMatrix4(model.body.matrixWorld);
    }
    out.set(0, -Math.random() * (part < 5 ? 0.22 : L2), 0);
    return out.applyMatrix4(anchors[base + part].matrixWorld);
  };
  // дуги от точки к другим частям и «ползающие» вокруг неё; трещат, пока горят. point копируется
  // сразу: его могли передать общим вектором (v2), а он ниже служит черновиком.
  const arcsFrom = (part, point, count, crawl) => {
    arcA.copy(point);
    for (let k = 0; k < count; k += 1) {
      let other = Math.floor(Math.random() * 9);
      if (other === part) other = part === 0 ? 1 + Math.floor(Math.random() * 8) : 0;
      anchorPoint(other, arcB);
      if (arcB.distanceTo(arcA) > 0.7) arcB.lerp(arcA, 0.4);
      fx.arc(base + part, arcA, base + other, arcB, 0.3 + Math.random() * 0.3, 0.035 + Math.random() * 0.04);
    }
    for (let k = 0; k < crawl; k += 1) {
      arcB.set((Math.random() - 0.5) * 0.24, (Math.random() - 0.5) * 0.24, (Math.random() - 0.5) * 0.24).add(arcA);
      fx.arc(base + part, arcA, base + part, arcB, 0.25 + Math.random() * 0.25, 0.025);
    }
    if (count + crawl > 0) sfx.crackle(arcA);
  };

  const rayCapsule = (o, d, a0, a1, a2, b0, b1, b2, r) => {
    const ux = b0 - a0;
    const uy = b1 - a1;
    const uz = b2 - a2;
    const wx = o.x - a0;
    const wy = o.y - a1;
    const wz = o.z - a2;
    const b = d.x * ux + d.y * uy + d.z * uz;
    const c = ux * ux + uy * uy + uz * uz;
    const dd = d.x * wx + d.y * wy + d.z * wz;
    const e = ux * wx + uy * wy + uz * wz;
    const den = c - b * b;
    let s = den > 1e-9 ? (e - b * dd) / den : 0;
    s = s < 0 ? 0 : s > 1 ? 1 : s;
    const t = -dd + s * b;
    if (t < 0) return -1;
    const qx = o.x + d.x * t - (a0 + ux * s);
    const qy = o.y + d.y * t - (a1 + uy * s);
    const qz = o.z + d.z * t - (a2 + uz * s);
    const dist2 = qx * qx + qy * qy + qz * qz;
    if (dist2 > r * r) return -1;
    return Math.max(0, t - Math.sqrt(r * r - dist2));
  };

  // луч: расстояние до пса или −1 (сначала шар вокруг корпуса, потом коробка и капсулы ног)
  unit.cast = (origin, dir, far) => {
    if (unit.mode === 'off' || sink > 0.02) return -1;
    v1.subVectors(bodyCenter, origin);
    const tc = v1.dot(dir);
    if (tc < -0.9 || v1.lengthSq() - tc * tc > 0.8 * 0.8) return -1;
    let best = -1;
    v2.copy(origin).applyMatrix4(bodyInv);
    v3.copy(dir).transformDirection(bodyInv);
    let tmin = -Infinity;
    let tmax = Infinity;
    for (let k = 0; k < 3; k += 1) {
      const o = v2.getComponent(k) - BOX_C[k];
      const dk = v3.getComponent(k);
      if (Math.abs(dk) < 1e-9) {
        if (Math.abs(o) > BOX_H[k]) tmin = Infinity;
        continue;
      }
      const ta = (-BOX_H[k] - o) / dk;
      const tb = (BOX_H[k] - o) / dk;
      const t1 = ta < tb ? ta : tb;
      const t2 = ta < tb ? tb : ta;
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
    }
    if (tmin <= tmax && tmax >= 0) {
      best = Math.max(0, tmin);
      hitPart = 0;
    }
    for (let i = 0; i < 4; i += 1) {
      const j = i * 9;
      const tu = rayCapsule(origin, dir, joints[j], joints[j + 1], joints[j + 2], joints[j + 3], joints[j + 4], joints[j + 5], UPPER_R);
      if (tu >= 0 && (best < 0 || tu < best)) {
        best = tu;
        hitPart = 1 + i;
      }
      const tl = rayCapsule(origin, dir, joints[j + 3], joints[j + 4], joints[j + 5], joints[j + 6], joints[j + 7], joints[j + 8], LOWER_R);
      if (tl >= 0 && (best < 0 || tl < best)) {
        best = tl;
        hitPart = 5 + i;
      }
    }
    return best >= 0 && best <= far ? best : -1;
  };

  const startRagdoll = (vx, vy, vz, muscle) => {
    collectJoints();
    collectRagdollPoints();
    ragdoll.start(points, vx, vy, vz);
    ragdoll.setMuscle(muscle);
  };
  // Пуля толкает куклу: всё тело летит по ходу пули и вверх, а в точке попадания — сильнее
  // (закручивает). k — сила (калибр × насколько это «смертельный» выстрел).
  const throwRagdoll = (dir, k) => {
    ragdoll.push(dir.x * (2 + 3 * k), 1.2 + 1.6 * k + dir.y * 2, dir.z * (2 + 3 * k));
    ragdoll.impulse(hitPoint.x, hitPoint.y, hitPoint.z, dir.x, dir.y, dir.z, 4 + 6 * k, 0.45);
  };
  const ragdollVelocity = () => {
    const dog = unit.dog;
    return [-Math.sin(dog.yaw) * dog.v, dog.jump ? unit.jumpVy : 0, -Math.cos(dog.yaw) * dog.v];
  };

  // Пуля попала (после cast). opts.knockdown — несмертельное попадание сбивает с ног (стая).
  // Возвращает 'hit' (ранен, вздрогнул), 'knock' (сбит), 'kill' (убит этим выстрелом), 'corpse'.
  unit.hit = (origin, dir, distance, { knockdown = false } = {}) => {
    hitPoint.copy(origin).addScaledVector(dir, distance);
    hitNormal.copy(dir).negate();
    const power = shotPower();
    if (unit.mode === 'dying' || unit.mode === 'dead') {
      // лежачий: далеко отлетает, тяжёлый полый звон, немного искр
      throwRagdoll(dir, power);
      sfx.clankHeavy(hitPoint, power);
      fx.sparks(hitPoint, hitNormal, 8, { speed: [1.5, 4], hot: Math.random() < 0.5 });
      if (Math.random() < 0.4) {
        arcsFrom(hitPart, hitPoint, 0, 1);
        sfx.zap(hitPoint, 0.4);
      }
      return 'corpse';
    }
    sfx.clank(hitPoint);
    unit.health -= 1;
    flash = 1;
    fx.flash(hitPoint, 0.12);
    fx.sparks(hitPoint, hitNormal, 16, { speed: [1.5, 4.5] });
    fx.sparks(hitPoint, hitNormal, 6, { speed: [1, 3], hot: true });
    arcsFrom(hitPart, hitPoint, 3, 2);
    sfx.zap(hitPoint, 1);
    if (unit.health <= 0) {
      unit.kill(dir, power);
      return 'kill';
    }
    if (knockdown || unit.knocked) {
      unit.knock(dir, power);
      return 'knock';
    }
    // вздрогнул: толчок по курсу пули (в системе пса)
    const lx = dir.x * cosYaw - dir.z * sinYaw;
    const lz = dir.x * sinYaw + dir.z * cosYaw;
    gait.kick(lz * 3 + (Math.random() - 0.5), -lx * 4 + (Math.random() - 0.5) * 2);
    return 'hit';
  };

  // сбит с ног: на DOWN_S секунд — кукла со слабыми мышцами, отброшенная пулей
  unit.knock = (dir, power = 0.6) => {
    if (unit.mode !== 'down') {
      const [vx, vy, vz] = ragdollVelocity();
      startRagdoll(vx, vy, vz, 0.3);
    }
    unit.mode = 'down';
    modeT = 0;
    const dog = unit.dog;
    dog.jump = null;
    dog.leap = null;
    dog.v = 0;
    unit.jumpH = 0;
    throwRagdoll(dir, power * 0.7);
  };

  unit.kill = (dir, power = 0.6) => {
    const dog = unit.dog;
    if (unit.mode !== 'down') {
      const [vx, vy, vz] = ragdollVelocity();
      startRagdoll(vx, vy, vz, 0.35);
    } else ragdoll.setMuscle(0.35);
    unit.mode = 'dying';
    unit.deadFor = 0;
    dog.state = 'dead';
    if (dir) throwRagdoll(dir, power);
    dog.jump = null;
    unit.jumpH = 0;
    fx.flash(hitPoint, 0.25);
    fx.sparks(hitPoint, hitNormal, 30, { speed: [2, 6] });
    fx.sparks(hitPoint, hitNormal, 14, { speed: [1, 4], hot: true });
    arcsFrom(hitPart, hitPoint, 5, 2);
    sfx.powerDown(hitPoint);
    twitchLeft = 0;
    eyeLeft = 0;
  };

  // Поставить пса: dog — состояние для мозга (x, z, yaw…); dead — сразу лежит (загрузили мёртвым)
  unit.spawn = (dog, { health = 1, dead = false, boot = true } = {}) => {
    unit.dog = dog;
    unit.mode = dead ? 'dead' : 'alive';
    unit.health = health;
    unit.deadFor = 0;
    unit.jumpH = 0;
    unit.jumpVy = 0;
    sink = 0;
    flash = 0;
    model.group.visible = true;
    model.eyeMaterial.color.copy(eyeOn);
    model.material.emissive.setRGB(0, 0, 0);
    placeAlive();
    cmd.v = cmd.w = cmd.sniff = cmd.crouch = 0;
    cmd.air = null;
    for (let i = 0; i < 30; i += 1) gait.update(1 / 60, cmd, groundLocal);
    model.setPose(gait.pose);
    collectJoints();
    if (dead) {
      dog.state = 'dead';
      unit.deadFor = DYING_S;
      startRagdoll(0, 0, 0, 0);
      model.eyeMaterial.color.copy(eyeOff);
    } else if (boot) {
      fx.sparks(bodyCenter, v1.set(0, 1, 0), 14, { speed: [0.8, 2.5], spread: 1.2 });
      arcsFrom(0, bodyCenter, 2, 0);
    }
  };
  // кукла после подмены файла сцены: те же точки
  unit.restoreRagdoll = (dog, rag) => {
    unit.spawn(dog, { dead: true, boot: false });
    ragdoll.pos.set(rag.pos);
    ragdoll.prev.set(rag.prev);
    unit.deadFor = rag.deadFor ?? DYING_S;
  };
  unit.ragdollState = () => ({ pos: Float32Array.from(ragdoll.pos), prev: Float32Array.from(ragdoll.prev), deadFor: unit.deadFor });
  unit.hide = () => {
    unit.mode = 'off';
    model.group.visible = false;
    shadow.visible = false;
    unit.dog.jump = null;
  };
  // труп уходит в землю на depth метров (стая освобождает место)
  unit.setSink = (depth) => {
    sink = depth;
  };

  // Прыжок: { height } — обычный; { vy } — с заданной вертикальной скоростью (бросок на игрока);
  // crouch — сколько секунд приседает перед прыжком
  unit.jump = ({ height = 0.45, vy = null, crouch = 0.18 } = {}) => {
    if (unit.dog.jump || unit.mode !== 'alive') return false;
    const v0 = vy ?? jumpSpeed(height);
    unit.dog.jump = { phase: 0, t: 0, crouch, vy: v0, total: (2 * v0) / GRAVITY, landed: false };
    return true;
  };

  // походка + поза в стойке (без смешивания)
  const animate = (dt) => {
    const dog = unit.dog;
    placeAlive();
    cmd.v = dog.v;
    cmd.w = dog.w;
    cmd.sniff = dog.sniff;
    gait.update(dt, cmd, groundLocal);
    model.setPose(gait.pose);
  };

  // удары о землю и волочение куклы — звук (сила по скорости)
  const groundSounds = () => {
    const h = ragdoll.hits;
    if (h.impact > 1.3) sfx.groundThud(v3.set(h.x, h.y, h.z), Math.min(1, (h.impact - 1) / 5));
    if (h.slide > 0.9) sfx.scrape(bodyCenter, Math.min(1, h.slide / 4));
  };

  // начать подъём: запомнить позу куклы, пёс встаёт там, где лежит, мордой куда смотрел корпус
  const startGetup = () => {
    unit.mode = 'getup';
    modeT = 0;
    capPos.copy(model.body.position);
    capQ.copy(model.body.quaternion);
    for (let i = 0; i < 4; i += 1) {
      capLegs[i * 3].copy(model.legs[i].hip.quaternion);
      capLegs[i * 3 + 1].copy(model.legs[i].upper.quaternion);
      capLegs[i * 3 + 2].copy(model.legs[i].knee.quaternion);
    }
    const dog = unit.dog;
    dog.x = frame.c[0];
    dog.z = frame.c[2];
    if (Math.hypot(frame.z[0], frame.z[2]) > 0.2) dog.yaw = Math.atan2(frame.z[0], frame.z[2]);
    dog.v = 0;
    dog.w = 0;
    dog.jump = null;
    ragdoll.setMuscle(0);
  };

  unit.update = (dt) => {
    if (unit.mode === 'off') return;
    if (unit.mode === 'alive') {
      const dog = unit.dog;
      cmd.crouch = 0;
      cmd.air = null;
      const j = dog.jump;
      if (j) {
        j.t += dt;
        if (j.phase === 0) {
          const k = Math.min(1, j.t / j.crouch);
          cmd.crouch = k * k * (3 - 2 * k);
          if (j.t >= j.crouch) {
            j.phase = 1;
            j.t = 0;
            unit.jumpVy = j.vy;
          }
        } else if (j.phase === 1) {
          unit.jumpVy -= GRAVITY * dt;
          unit.jumpH += unit.jumpVy * dt;
          cmd.air = Math.min(1, j.t / j.total);
          if (unit.jumpH <= 0 && unit.jumpVy < 0) {
            unit.jumpH = 0;
            j.phase = 2;
            j.t = 0;
          }
        } else {
          cmd.crouch = 0.7 * Math.max(0, 1 - j.t / 0.22);
          if (j.t >= 0.22) dog.jump = null;
        }
      }
      animate(dt);
      collectJoints();
      shadowAt(dog.x, dog.z, dog.yaw, 1 - Math.min(0.5, unit.jumpH), 1 - Math.min(0.6, unit.jumpH * 1.2));
      if (dog.state === 'stun' && Math.random() < dt * 14) {
        anchorPoint(Math.floor(Math.random() * 9), v2);
        fx.sparks(v2, v1.set(0, 1, 0), 3, { speed: [0.8, 2] });
      }
      // шаги: тихий «вжик» сервоприводов на каждую пару ног (только на ходу и не дальше 15 м)
      const half = Math.floor(gait.phase * 2);
      if (half !== lastHalf) {
        lastHalf = half;
        if (dog.v > 0.6 && !dog.jump && camera) {
          camera.getWorldPosition(v1);
          if (v1.distanceToSquared(bodyCenter) < 15 * 15) sfx.servo(bodyCenter, dog.v);
        }
      }
    } else if (unit.mode === 'down') {
      // сбит: летит и кувыркается куклой, мышцы слабые; потом вскакивает
      modeT += dt;
      ragdoll.setMuscle(modeT < 0.25 ? 0.3 : 0.12);
      ragdoll.step(dt, groundHeight);
      placeRagdoll();
      collectJoints();
      groundSounds();
      if (modeT > DOWN_S && (ragdoll.asleep || modeT > DOWN_S + 0.6 || frame.c[1] - groundHeight(frame.c[0], frame.c[2]) < 0.35)) startGetup();
    } else if (unit.mode === 'getup') {
      // вскакивает: поза из куклы плавно переходит в стойку (присед → выпрямился)
      modeT += dt;
      const k = Math.min(1, modeT / GETUP_S);
      const e = k * k * (3 - 2 * k);
      cmd.crouch = 1 - e;
      cmd.air = null;
      animate(dt);
      model.group.updateMatrixWorld(true);
      model.body.matrixWorld.decompose(goalPos, goalQ, unusedScale);
      model.group.position.set(0, 0, 0);
      model.group.rotation.set(0, 0, 0);
      model.body.position.lerpVectors(capPos, goalPos, e);
      model.body.quaternion.slerpQuaternions(capQ, goalQ, e);
      for (let i = 0; i < 4; i += 1) {
        const leg = model.legs[i];
        // цель — поза стойки, только что выставленная animate(); slerpQuaternions сначала копирует
        // первый аргумент в себя, поэтому цель — через копию
        leg.hip.quaternion.slerpQuaternions(capLegs[i * 3], tq.copy(leg.hip.quaternion), e);
        leg.upper.quaternion.slerpQuaternions(capLegs[i * 3 + 1], tq.copy(leg.upper.quaternion), e);
        leg.knee.quaternion.slerpQuaternions(capLegs[i * 3 + 2], tq.copy(leg.knee.quaternion), e);
      }
      collectJoints();
      shadowAt(unit.dog.x, unit.dog.z, unit.dog.yaw, 0.85 + 0.15 * e, 0.6 + 0.4 * e);
      if (k >= 1) {
        unit.mode = 'alive';
        unit.dog.state = 'recover';
        unit.dog.t = 0.3;
      }
    } else {
      unit.deadFor += dt;
      if (unit.mode === 'dying') {
        const t = unit.deadFor;
        ragdoll.setMuscle(t < 0.25 ? 0.35 : Math.max(0, 0.35 * (1 - (t - 0.25) / 0.5)));
        twitchLeft -= dt;
        if (twitchLeft <= 0 && t < 1.4) {
          twitchLeft = 0.05 + Math.random() * 0.1;
          const i = KNEE + Math.floor(Math.random() * 8);
          const s = 0.6 + Math.random() * 1.2;
          ragdoll.nudge(i, (Math.random() - 0.5) * s, Math.random() * s, (Math.random() - 0.5) * s);
          const part = Math.floor(Math.random() * 9);
          anchorPoint(part, v2);
          fx.sparks(v2, v1.set(0, 1, 0), 5, { speed: [1, 3], hot: Math.random() < 0.4 });
          if (Math.random() < 0.45) arcsFrom(part, v2, 1, 1);
          if (Math.random() < 0.35) sfx.zap(v2, 0.5);
        }
        eyeLeft -= dt;
        if (eyeLeft <= 0) {
          eyeLeft = 0.03 + Math.random() * 0.07;
          const lit = t < 1.2 && Math.random() < 1 - t / 1.2;
          model.eyeMaterial.color.copy(lit ? eyeOn : eyeOff);
        }
        if (t >= DYING_S) {
          unit.mode = 'dead';
          ragdoll.setMuscle(0);
          model.eyeMaterial.color.copy(eyeOff);
        }
      }
      ragdoll.step(dt, groundHeight);
      placeRagdoll();
      collectJoints();
      groundSounds();
    }
    if (flash > 0.01) {
      flash *= Math.exp(-dt * 10);
      const k = flash * (0.6 + Math.random() * 0.4);
      model.material.emissive.setRGB(0.25 * k, 0.45 * k, 1.1 * k);
    } else if (flash) {
      flash = 0;
      model.material.emissive.setRGB(0, 0, 0);
    }
  };

  // толчок по корпусу (пёс врезался в игрока): тангаж и крен, рад/с
  unit.kick = (pitch, roll) => gait.kick(pitch, roll);

  unit.dispose = () => {
    model.dispose();
    shadow.removeFromParent();
    shadowGeometry.dispose();
    shadowMaterial.dispose();
  };
  return unit;
}
