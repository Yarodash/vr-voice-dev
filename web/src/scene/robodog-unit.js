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
import { buildRobodog, buildRobodogRig } from './robodog-model.js';
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
const HIT_GLOW = false; // синяя вспышка всего корпуса от попадания (выключена по просьбе пользователя)
const UPPER_R = 0.045;
const LOWER_R = 0.034;
const EYE_ON = 0x45e8ff;
const EYE_OFF = 0x061418;
const EYE_RAGE = 0xff2a14; // в ярости (стая) глаза красные
const EYE_ALLY = 0x3dff6a; // союзники (стая) — зелёные
// вылезание из-под земли (стая): сначала на этой глубине (×размер) весь под землёй, потом спина над
// землёй на EMERGE_BACK, потом встаёт
const EMERGE_DEPTH = 0.62;
const EMERGE_BACK = 0.24;
// сила выстрела по калибру (0..1): во сколько толкает куклу и как глубоко звенит корпус
const POWER = { pistol: 0.45, ak: 0.7, awp: 1 };

// Звуки псов (robodog-sound.js): не чаще, чем нужно уху, и без сотни голосов от очереди калаша.
// Ограничение частоты — по реальному времени (звук не замедляется в замедленном времени).
export function createDogSfx(shared) {
  const sound = createDogSound(shared);
  const last = {};
  // own — звук от своей пули (unit.hit): свой счётчик частоты и свои голоса (robodog-sound.js, audio-budget.js)
  const play = (name, gapMs, a, b, size, own = false) => {
    const key = own ? `${name}!` : name;
    const now = performance.now();
    if (now - (last[key] ?? -1e9) < gapMs) return;
    last[key] = now;
    sound[name](a, b, size, own);
  };
  // size — размер пса (стая: 1 … 4): звук ниже и громче (robodog-sound.js)
  return {
    zap: (p, strength = 1, size = 1, own = false) => play('zap', 55, p, strength, size, own),
    clank: (p, size = 1, own = false) => play('clank', 40, p, undefined, size, own),
    clankHeavy: (p, k, size = 1, own = false) => play('clankHeavy', 45, p, k, size, own),
    crackle: (p, size = 1) => play('crackle', 90, p, undefined, size),
    powerDown: (p, size = 1, own = false) => play('powerDown', 150, p, undefined, size, own),
    thud: (p, size = 1) => play('thud', 120, p, undefined, size),
    servo: (p, speed, size = 1) => play('servo', 260, p, speed, size), // шаги: не чаще ~4 в секунду на всех
    groundThud: (p, k, size = 1) => play('groundThud', 110, p, k, size),
    scrape: (p, k, size = 1) => play('scrape', 280, p, k, size),
    whoosh: (p, size = 1) => play('whoosh', 200, p, undefined, size),
    bark: (p, size = 1) => play('bark', 120, p, undefined, size),
    growl: (p, size = 1) => play('growl', 350, p, undefined, size),
    howl: (p, size = 1) => play('howl', 700, p, undefined, size),
    mg: (p, size = 1) => play('mg', 50, p, undefined, size),
    turretWind: (p, size = 1) => play('turretWind', 150, p, undefined, size), // мотор башенки перед очередью
  };
}

// rig — только скелет без мешей (стая: рисует robodog-instances.js экземплярами); тень — Object3D,
// её прозрачность — в unit.shadowMaterial.opacity
export function createDogUnit({ THREE, root, fx, anchors, shadowTexture, sfx, camera, textures = null, env = null, shared = globalThis.__sceneState ?? {}, rig = false }) {
  const model = rig ? buildRobodogRig(THREE) : buildRobodog(THREE, { textures, env });
  model.group.visible = false;
  if (!rig) root.add(model.group);
  const base = anchors.length; // наши шарниры в общем массиве эффектов
  anchors.push(model.body, ...model.legs.map((l) => l.upper), ...model.legs.map((l) => l.knee));
  const gait = createGait();
  const ragdoll = createRagdoll();

  const shadowGeometry = rig ? null : new THREE.PlaneGeometry(1, 1);
  shadowGeometry?.rotateX(-Math.PI / 2);
  const shadowMaterial = rig ? { opacity: 0, dispose() {} } : new THREE.MeshBasicMaterial({ map: shadowTexture, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 });
  const shadow = rig ? new THREE.Object3D() : new THREE.Mesh(shadowGeometry, shadowMaterial);
  shadow.name = 'robodog-shadow';
  shadow.visible = false;
  shadow.renderOrder = 1;
  if (!rig) root.add(shadow);

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
  const hinge = new THREE.Vector3(); // ось колена куклы (placeRagdoll)
  const lowerDir = new THREE.Vector3();
  const ax = new THREE.Vector3();
  const ay = new THREE.Vector3();
  const az = new THREE.Vector3();
  const footLocal = new THREE.Vector3(0, -L2, 0);
  const joints = new Float32Array(36); // мировые: таз, колено, стопа × 4 ноги
  const points = new Float32Array(COUNT * 3);
  const frame = { c: [0, 0, 0], x: [0, 0, 0], y: [0, 0, 0], z: [0, 0, 0] };
  const eyeOn = new THREE.Color(EYE_ON);
  const eyeOff = new THREE.Color(EYE_OFF);
  const cmd = { v: 0, w: 0, sniff: 0, crouch: 0, air: null, vs: 0, style: 1, paw: null, prowl: 0, rear: 0, rearReach: 0, brake: 0, look: 0, footSink: 0.008 };
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
  let fade = 0; // труп растворяется (стая; 0 — целый, 1 — исчез): шейдер, robodog-model.js injectDissolve
  let placedFade = -1; // при каком fade поза куклы (и тень) последний раз выставлена
  let emergeT = -1; // с с начала вылезания из-под земли; −1 — не вылезает
  let emergeA = 0.8; // медленно поднимается, пока спина не покажется над землёй
  let emergeB = 0.6; // рывком встаёт
  let rise = 0; // м ниже земли (отрицательное)
  let lastPuff = 0;
  let lastHalf = 0; // половина цикла походки — для шагов сервоприводов
  let modeT = 0; // секунд в режиме down / getup
  let glowK = -1; // накал глаз, выставленный unit.glow (−1 — ещё не выставлялся)
  // валится на бок (без двух ног, unit.collapse): с с начала, −1 — нет; направление (мир, единичное)
  let collapseT = -1;
  let collapseX = 0;
  let collapseZ = 0;
  let collapseSide = 1; // сторона падения пса: −1 левая, 1 правая
  let collapseLandT = 0; // collapseT в момент удара о землю
  let collapseLanded = false;
  let collapseDamped = false; // вращение уже гасилось (лёг на бок — не катится на спину) // корпус уже ударился о землю (пыль, гул, тряска — один раз)
  // Размер (стая: 1 маленький … 4 огромный; берётся из dog.scale при spawn). Вся модель — масштаб
  // группы; походка и кукла считаются «как у маленького» в своих единицах: длины ×S, время ×RT
  // (=√S, подобие по Фруду: большой шагает реже и шире), толчки пуль слабее (PK = S^−0.6).
  let S = 1;
  let RT = 1;
  let PK = 1;

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
    shadowMaterial, // прозрачность тени (у скелета без мешей — её читает robodog-instances.js)
    get hitPart() {
      return hitPart;
    },
    get scale() {
      return S;
    },
    get fade() {
      return fade;
    },
    // сбит или поднимается: хозяин его не водит
    // вылезает из-под земли: хозяин его не водит, не нападает, попадания без отброса
    get emerging() {
      return emergeT >= 0 && unit.mode === 'alive';
    },
    get knocked() {
      return unit.mode === 'down' || unit.mode === 'getup';
    },
    // валится на бок (unit.collapse): бюджет кукол стаи его не укладывает
    get collapsing() {
      return collapseT >= 0;
    },
  };

  const shotPower = () => POWER[shared.shotKind] ?? 0.6;

  // земля для походки — в единицах модели (÷S)
  const groundLocal = (lx, lz) => {
    if (emergeT >= 0) return 0; // вылезает: «земля» для ног — там, где он сейчас (под землёй)
    const dog = unit.dog;
    lx *= S;
    lz *= S;
    return (groundHeight(dog.x + lx * cosYaw + lz * sinYaw, dog.z - lx * sinYaw + lz * cosYaw) - groundBase) / S;
  };
  const placeAlive = () => {
    const dog = unit.dog;
    cosYaw = Math.cos(dog.yaw);
    sinYaw = Math.sin(dog.yaw);
    groundBase = groundHeight(dog.x, dog.z) + unit.jumpH + rise;
    model.group.position.set(dog.x, groundBase, dog.z);
    model.group.rotation.set(0, dog.yaw, 0);
  };
  const shadowAt = (x, z, yaw, scale, opacity) => {
    shadow.visible = opacity > 0.02;
    shadow.position.set(x, groundHeight(x, z) + 0.012, z);
    shadow.rotation.set(0, yaw, 0);
    // крупные: пятно шире и длиннее корпуса и бледнее — мягкий полумрак под всем псом, а не диск
    const big = Math.min(1, Math.max(0, (S - 1) / 3));
    shadow.scale.set((0.62 * scale + 0.1) * (1 + 0.35 * big) * S, 1, 1.05 * scale * (1 + 0.45 * big) * S);
    shadowMaterial.opacity = Math.min(1, opacity) * (1 - 0.25 * big);
  };
  // ось кости: её −Y вдоль dir (система родителя), ось сгиба X — hinge (ось колена, система родителя)
  // или X родителя
  const orientBone = (dir, out, hinge = null) => {
    ay.copy(dir).normalize().negate();
    if (hinge) ax.copy(hinge);
    else ax.set(1, 0, 0);
    ax.addScaledVector(ay, -ax.dot(ay));
    if (ax.lengthSq() < 1e-6) ax.set(0, 0, 1);
    ax.normalize();
    az.crossVectors(ax, ay);
    basis.makeBasis(ax, ay, az);
    out.setFromRotationMatrix(basis);
  };
  const placeRagdoll = () => {
    const p = ragdoll.pos;
    ragdoll.bodyFrame(frame);
    model.group.position.set(0, 0, 0);
    model.group.rotation.set(0, 0, 0);
    ax.fromArray(frame.x);
    ay.fromArray(frame.y);
    az.fromArray(frame.z);
    basis.makeBasis(ax, ay, az);
    bodyQ.setFromRotationMatrix(basis);
    bodyQi.copy(bodyQ).invert();
    // группа в начале мира, но с масштабом S: всё внутри — в единицах модели (мировые ÷S)
    const iS = 1 / S;
    model.body.position.fromArray(frame.c).multiplyScalar(iS);
    model.body.quaternion.copy(bodyQ);
    const lostLegs = unit.dog.lost | 0;
    for (let i = 0; i < 4; i += 1) {
      if (lostLegs & (1 << i)) continue; // отвалилась: точки куклы стянуты к тазу
      const leg = model.legs[i];
      leg.hip.rotation.set(0, 0, 0);
      v1.copy(leg.hip.position).applyQuaternion(bodyQ).add(model.body.position);
      v2.set(p[(KNEE + i) * 3], p[(KNEE + i) * 3 + 1], p[(KNEE + i) * 3 + 2]).multiplyScalar(iS);
      v3.subVectors(v2, v1).applyQuaternion(bodyQi);
      // ось колена — перпендикуляр к плоскости бедро–голень (как у живого: колено гнётся вокруг X
      // бедра, а бедро довёрнуто отведением). Раньше бралась ось X корпуса: в кадр смерти кости ног
      // поворачивались вокруг своей оси на 0,1–0,4 рад одним кадром. Прямая нога — плавно к X корпуса.
      lowerDir.set(p[(FOOT + i) * 3], p[(FOOT + i) * 3 + 1], p[(FOOT + i) * 3 + 2]).multiplyScalar(iS).sub(v2).applyQuaternion(bodyQi);
      hinge.crossVectors(v3, lowerDir);
      const hl = hinge.length() / (v3.length() * lowerDir.length() + 1e-9); // sin угла в колене
      if (hinge.x < 0) hinge.negate();
      hinge.normalize().multiplyScalar(Math.min(1, hl / 0.2));
      hinge.x += 1 - Math.min(1, hl / 0.2);
      orientBone(v3, leg.upper.quaternion, hinge);
      upperQi.copy(leg.upper.quaternion).invert();
      hinge.applyQuaternion(upperQi);
      v3.copy(lowerDir).applyQuaternion(upperQi);
      orientBone(v3, leg.knee.quaternion, hinge);
    }
    const lift = (frame.c[1] - groundHeight(frame.c[0], frame.c[2])) * iS;
    shadowAt(frame.c[0], frame.c[2], Math.atan2(frame.z[0], frame.z[2]), 0.7, Math.max(0, 1 - lift * 1.5) * (1 - fade));
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
    if (part === 0 || ((unit.dog.lost | 0) & (1 << ((part - 1) & 3)))) {
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
      if (other > 0 && (unit.dog.lost | 0) & (1 << ((other - 1) & 3))) other = 0; // отвалившейся ноги нет
      anchorPoint(other, arcB);
      if (arcB.distanceTo(arcA) > 0.7 * S) arcB.lerp(arcA, 0.4);
      fx.arc(base + part, arcA, base + other, arcB, 0.3 + Math.random() * 0.3, (0.035 + Math.random() * 0.04) * S, S);
    }
    for (let k = 0; k < crawl; k += 1) {
      const r = 0.24 * S;
      arcB.set((Math.random() - 0.5) * r, (Math.random() - 0.5) * r, (Math.random() - 0.5) * r).add(arcA);
      fx.arc(base + part, arcA, base + part, arcB, 0.25 + Math.random() * 0.25, 0.025 * S, S);
    }
    if (count + crawl > 0) sfx.crackle(arcA, S);
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
    if (unit.mode === 'off' || fade > 0.3) return -1;
    v1.subVectors(bodyCenter, origin);
    const tc = v1.dot(dir);
    if (tc < -0.9 * S || v1.lengthSq() - tc * tc > 0.64 * S * S) return -1;
    let best = -1;
    v2.copy(origin).applyMatrix4(bodyInv);
    // направление в системе корпуса без нормировки (там масштаб 1/S): t остаётся мировым
    v3.copy(origin).add(dir).applyMatrix4(bodyInv).sub(v2);
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
    const lost = unit.dog.lost | 0;
    for (let i = 0; i < 4; i += 1) {
      if (lost & (1 << i)) continue; // отвалилась
      const j = i * 9;
      const tu = rayCapsule(origin, dir, joints[j], joints[j + 1], joints[j + 2], joints[j + 3], joints[j + 4], joints[j + 5], UPPER_R * S);
      if (tu >= 0 && (best < 0 || tu < best)) {
        best = tu;
        hitPart = 1 + i;
      }
      const tl = rayCapsule(origin, dir, joints[j + 3], joints[j + 4], joints[j + 5], joints[j + 6], joints[j + 7], joints[j + 8], LOWER_R * S);
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
    ragdoll.setLost(unit.dog.lost | 0); // отвалившиеся ноги не держат тело
    ragdoll.setSlip(false);
    ragdoll.start(points, vx, vy, vz, groundHeight);
    ragdoll.setMuscle(muscle);
  };
  // Пуля толкает куклу: всё тело летит по ходу пули и вверх, а в точке попадания — сильнее
  // (закручивает). k — сила (калибр × насколько это «смертельный» выстрел).
  // Большой пёс тяжелее: толчок ×PK (огромный — ~0,44), но всё равно заметно дёргается.
  const throwRagdoll = (dir, k) => {
    ragdoll.push(dir.x * (2 + 3 * k) * PK, (1.2 + 1.6 * k + dir.y * 2) * PK, dir.z * (2 + 3 * k) * PK);
    ragdoll.impulse(hitPoint.x, hitPoint.y, hitPoint.z, dir.x, dir.y, dir.z, (4 + 6 * k) * PK * RT, 0.45 * S);
  };
  const ragdollVelocity = () => {
    const dog = unit.dog;
    return [-Math.sin(dog.yaw) * dog.v, dog.jump ? unit.jumpVy : 0, -Math.cos(dog.yaw) * dog.v];
  };

  // Пуля попала (после cast). opts.knockdown — несмертельное попадание сбивает с ног (стая).
  // Возвращает 'hit' (ранен, вздрогнул), 'knock' (сбит), 'kill' (убит этим выстрелом), 'corpse'.
  unit.hit = (origin, dir, distance, { knockdown = false, damage = 1 } = {}) => {
    hitPoint.copy(origin).addScaledVector(dir, distance);
    hitNormal.copy(dir).negate();
    const power = shotPower();
    if (unit.mode === 'dying' || unit.mode === 'dead') {
      // лежачий: не летит, а сдвигается по земле вдоль пули (без подброса, ~¼ прежнего толчка,
      // большой — ещё меньше), трение его останавливает; тяжёлый полый звон, немного искр
      {
        const hl = Math.hypot(dir.x, dir.z) || 1;
        const hx = dir.x / hl;
        const hz = dir.z / hl;
        const k = 0.25 * PK;
        ragdoll.push(hx * (2 + 3 * power) * k, 0, hz * (2 + 3 * power) * k);
        ragdoll.impulse(hitPoint.x, hitPoint.y, hitPoint.z, hx, 0, hz, (4 + 6 * power) * k * RT, 0.45 * S);
      }
      sfx.clankHeavy(hitPoint, power, S, true); // своя пуля — свои голоса
      fx.sparks(hitPoint, hitNormal, 8, { speed: [1.5 * RT, 4 * RT], hot: Math.random() < 0.5, size: RT });
      if (Math.random() < 0.4) {
        arcsFrom(hitPart, hitPoint, 0, 1);
        sfx.zap(hitPoint, 0.4, S, true);
      }
      return 'corpse';
    }
    sfx.clank(hitPoint, S, true);
    unit.health -= damage;
    flash = 1;
    fx.flash(hitPoint, 0.12 * S);
    fx.sparks(hitPoint, hitNormal, 16, { speed: [1.5 * RT, 4.5 * RT], size: RT });
    fx.sparks(hitPoint, hitNormal, 6, { speed: [RT, 3 * RT], hot: true, size: RT });
    arcsFrom(hitPart, hitPoint, 3, 2);
    sfx.zap(hitPoint, 1, S, true);
    if (unit.health <= 0) {
      unit.kill(dir, power, true); // своя пуля: «отключение» — своим голосом, мимо бюджета мира
      return 'kill';
    }
    if (knockdown || unit.knocked) {
      unit.knock(dir, power);
      return 'knock';
    }
    // вздрогнул: толчок по курсу пули (в системе пса)
    const lx = dir.x * cosYaw - dir.z * sinYaw;
    const lz = dir.x * sinYaw + dir.z * cosYaw;
    if (emergeT < 0) gait.kick(lz * 3 + (Math.random() - 0.5), -lx * 4 + (Math.random() - 0.5) * 2);
    return 'hit';
  };

  // сбит с ног: на DOWN_S секунд — кукла со слабыми мышцами, отброшенная пулей
  unit.knock = (dir, power = 0.6) => {
    emergeT = -1;
    rise = 0;
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
  // пошатнулся (большие псы не падают): сильный толчок корпуса, стая ещё и тормозит его
  unit.stagger = (dir) => {
    const lx = dir.x * cosYaw - dir.z * sinYaw;
    const lz = dir.x * sinYaw + dir.z * cosYaw;
    gait.kick(lz * 4 + (Math.random() - 0.5), -lx * 5 + (Math.random() - 0.5) * 2); // gait ограничивает накопление
  };

  // own — убила пуля игрока (unit.hit): звук отключения своими голосами (robodog-sound.js own)
  unit.kill = (dir, power = 0.6, own = false) => {
    emergeT = -1;
    rise = 0;
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
    fx.flash(hitPoint, 0.25 * S);
    fx.sparks(hitPoint, hitNormal, Math.round(30 * RT), { speed: [2 * RT, 6 * RT], size: RT });
    fx.sparks(hitPoint, hitNormal, Math.round(14 * RT), { speed: [RT, 4 * RT], hot: true, size: RT });
    arcsFrom(hitPart, hitPoint, 5, 2);
    sfx.powerDown(hitPoint, S, own);
    twitchLeft = 0;
    eyeLeft = 0;
  };

  // Поставить пса: dog — состояние для мозга (x, z, yaw…); dead — сразу лежит (загрузили мёртвым)
  unit.spawn = (dog, { health = 1, dead = false, boot = true, emerge = false } = {}) => {
    unit.dog = dog;
    // вылезает из-под земли (стая): emergeT ≥ 0 — идёт; rise — насколько ниже земли, м
    emergeT = emerge && !dead ? 0 : -1;
    rise = 0;
    // размер и окраска — из dog (переживают подмену файла сцены вместе с ним)
    S = dog.scale ?? 1;
    RT = Math.sqrt(S);
    PK = S === 1 ? 1 : S ** -0.6;
    model.group.scale.setScalar(S);
    ragdoll.setScale(S);
    model.setPaint?.(dog.paint ?? 0);
    if (model.turret) {
      model.turret.yaw.visible = Boolean(dog.turret); // пулемёт на спине (стая)
      model.turret.yaw.rotation.y = 0;
      model.turret.pitch.rotation.x = 0;
    }
    unit.mode = dead ? 'dead' : 'alive';
    collapseT = -1;
    unit.health = health;
    unit.deadFor = 0;
    unit.jumpH = 0;
    unit.jumpVy = 0;
    fade = 0;
    model.setFade?.(0);
    for (let i = 0; i < 4; i += 1) model.legs[i].upper.visible = !((dog.lost | 0) & (1 << i)); // отвалившиеся (обычная модель)
    unit.rush = false; // стая: «растворить быстро» (freeUnit)
    flash = 0;
    model.group.visible = true;
    eyeOn.set(dog.team === 'ally' ? EYE_ALLY : dog.angry ? EYE_RAGE : EYE_ON);
    model.eyeMaterial.color.copy(eyeOn);
    model.material.emissive.setRGB(0, 0, 0);
    if (emergeT >= 0) {
      const tm = S ** 0.25; // великаны чуть медленнее
      emergeA = 0.8 * tm;
      emergeB = 0.6 * tm;
      rise = -EMERGE_DEPTH * S;
      lastPuff = 0;
    }
    placeAlive();
    cmd.v = cmd.w = cmd.sniff = cmd.crouch = cmd.vs = 0;
    cmd.prowl = cmd.rear = cmd.rearReach = cmd.brake = cmd.look = 0;
    glowK = -1;
    if (emergeT >= 0) cmd.crouch = 1;
    cmd.air = null;
    cmd.paw = null;
    cmd.style = dog.style ?? 1;
    for (let i = 0; i < 30; i += 1) gait.update(1 / 60, cmd, groundLocal);
    model.setPose(gait.pose);
    collectJoints();
    if (dead) {
      dog.state = 'dead';
      unit.deadFor = DYING_S;
      startRagdoll(0, 0, 0, 0);
      model.eyeMaterial.color.copy(eyeOff);
    } else if (emergeT >= 0) {
      shadow.visible = false;
      sfx.groundThud(v1.set(dog.x, groundHeight(dog.x, dog.z), dog.z), 0.5, S * 3); // глухой гул из-под земли
    } else if (boot) {
      fx.sparks(bodyCenter, v1.set(0, 1, 0), Math.round(14 * RT), { speed: [0.8 * RT, 2.5 * RT], spread: 1.2, size: RT });
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
  // труп растворяется: k 0…1 (стая освобождает место; один пёс — перед появлением нового). Не тонет:
  // поза та же, discard в шейдере, тень гаснет (placeRagdoll)
  unit.setFade = (k) => {
    fade = Math.min(1, Math.max(0, k));
    model.setFade?.(fade);
  };

  // Прыжок: { height } — обычный; { vy } — с заданной вертикальной скоростью (бросок на игрока);
  // crouch — сколько секунд приседает перед прыжком
  unit.jump = ({ height = 0.45, vy = null, crouch = 0.18 } = {}) => {
    if (unit.dog.jump || unit.mode !== 'alive') return false;
    const v0 = vy ?? jumpSpeed(height * S);
    unit.dog.jump = { phase: 0, t: 0, crouch: crouch * RT, vy: v0, total: (2 * v0) / GRAVITY, landed: false };
    return true;
  };

  // пыль из-под земли вокруг корпуса (хозяин даёт onFootfall — облачко пыли); true — было
  const onFootfallOrPuff = () => {
    if (!unit.onFootfall) return false;
    const dog = unit.dog;
    const lx = (Math.random() - 0.5) * 0.35 * S;
    const lz = (Math.random() - 0.5) * 0.9 * S;
    const x = dog.x + lx * cosYaw + lz * sinYaw;
    const z = dog.z - lx * sinYaw + lz * cosYaw;
    unit.onFootfall(v3.set(x, groundHeight(x, z), z));
    return true;
  };
  // походка + поза в стойке (без смешивания)
  const animate = (dt) => {
    const dog = unit.dog;
    placeAlive();
    // в единицах модели: скорость ÷√S, поворот ×√S, время ÷√S (большой шагает реже и шире)
    cmd.v = dog.v / RT;
    cmd.w = dog.w * RT;
    cmd.sniff = dog.sniff;
    cmd.vs = (dog.vs ?? 0) / RT; // уворот вбок (стая)
    cmd.style = dog.style ?? 1;
    // стопа уходит кончиком в землю: 3 % голени у маленького … 6 % у огромного и крупнее (вес)
    cmd.footSink = L2 * (0.03 + 0.03 * Math.min(1, Math.max(0, (S - 1) / 3)));
    cmd.broken = dog.broken | 0; // перебитые ноги волочатся (стая)
    cmd.lost = dog.lost | 0; // отвалившиеся — корпус сильнее валится на их сторону
    cmd.paw = unit.mode === 'alive' ? (dog.pawPose ?? null) : null; // удар лапой (стая)
    // характер движения (стая): крадётся, на дыбах, удар с дыб, юзом, довёрнут к цели
    const live = unit.mode === 'alive';
    cmd.prowl = live ? dog.prowl ?? 0 : 0;
    cmd.rear = live ? dog.rear ?? 0 : 0;
    cmd.rearReach = live ? dog.rearReach ?? 0 : 0;
    cmd.brake = live ? dog.brake ?? 0 : 0;
    cmd.look = live ? dog.look ?? 0 : 0;
    gait.update(dt / RT, cmd, groundLocal);
    model.setPose(gait.pose);
  };

  // удары о землю и волочение куклы — звук (сила по скорости)
  const groundSounds = () => {
    const h = ragdoll.hits;
    const imp = h.impact / RT; // большой падает быстрее — сравниваем «как у маленького»
    const slide = h.slide / RT;
    if (imp > 1.3) sfx.groundThud(v3.set(h.x, h.y, h.z), Math.min(1, (imp - 1) / 5), S);
    if (slide > 0.9) sfx.scrape(bodyCenter, Math.min(1, slide / 4), S);
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
          cmd.crouch = 0.7 * Math.max(0, 1 - j.t / (0.22 * RT));
          if (j.t >= 0.22 * RT) dog.jump = null;
        }
      }
      let shadowK = 1;
      if (emergeT >= 0) {
        // вылезает: медленно до спины над землёй (присел, ноги поджаты — земля выше стоп), потом рывком
        // встаёт; пыль из-под земли
        emergeT += dt;
        dog.v = 0;
        dog.w = 0;
        dog.jump = null;
        const back = -EMERGE_BACK * S;
        if (emergeT < emergeA) {
          const k = emergeT / emergeA;
          rise = -EMERGE_DEPTH * S + (back + EMERGE_DEPTH * S) * k * k * (3 - 2 * k);
          cmd.crouch = 1;
          shadowK = 0;
        } else {
          const k = Math.min(1, (emergeT - emergeA) / emergeB);
          const e = 1 - (1 - k) * (1 - k);
          rise = back * (1 - e);
          cmd.crouch = 1 - e;
          shadowK = e;
          if (k >= 1) {
            emergeT = -1;
            rise = 0;
          }
        }
        if (emergeT - lastPuff > 0.16 && emergeT >= 0 && onFootfallOrPuff()) lastPuff = emergeT;
      }
      animate(dt);
      collectJoints();
      const hS = unit.jumpH / S;
      shadowAt(dog.x, dog.z, dog.yaw, 1 - Math.min(0.5, hS), (1 - Math.min(0.6, hS * 1.2)) * shadowK);
      if (dog.broken && Math.random() < dt * 3) {
        // перебитое колено искрит и потрескивает
        let leg = Math.floor(Math.random() * 4);
        while (!(dog.broken & (1 << leg))) leg = (leg + 1) % 4;
        if ((dog.lost | 0) & (1 << leg)) v2.setFromMatrixPosition(model.legs[leg].upper.matrixWorld); // культя
        else anchorPoint(5 + leg, v2);
        fx.sparks(v2, v1.set(0, 1, 0), 3, { speed: [0.6 * RT, 2 * RT], hot: Math.random() < 0.5, size: RT });
        if (Math.random() < 0.3) sfx.crackle(v2, S);
      }
      if (dog.state === 'stun' && Math.random() < dt * 14) {
        anchorPoint(Math.floor(Math.random() * 9), v2);
        fx.sparks(v2, v1.set(0, 1, 0), 3, { speed: [0.8 * RT, 2 * RT], size: RT });
      }
      // шаги: тихий «вжик» сервоприводов на каждую пару ног (только на ходу и не дальше 15 м)
      const half = Math.floor(gait.phase * 2);
      if (half !== lastHalf) {
        lastHalf = half;
        // великан (≥6×): пыль у опустившейся стопы (хозяин даёт onFootfall)
        if (S >= 6 && dog.v > 0.6 && !dog.jump && unit.onFootfall) {
          const f = (half ? 1 : 0) * 9 + 6;
          v2.set(joints[f], joints[f + 1], joints[f + 2]);
          v2.y = groundHeight(v2.x, v2.z);
          unit.onFootfall(v2);
        }
        if (dog.v > 0.6 && !dog.jump && camera) {
          camera.getWorldPosition(v1);
          const near = 15 * RT;
          if (v1.distanceToSquared(bodyCenter) < near * near) {
            sfx.servo(bodyCenter, dog.v / RT, S);
            // большие тяжело топают
            if (S > 2) sfx.groundThud(bodyCenter, Math.min(1, 0.15 + 0.1 * S), S);
          }
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
      if (modeT > DOWN_S * RT && (ragdoll.asleep || modeT > (DOWN_S + 0.6) * RT || frame.c[1] - groundHeight(frame.c[0], frame.c[2]) < 0.35 * S)) startGetup();
    } else if (unit.mode === 'getup') {
      // вскакивает: поза из куклы плавно переходит в стойку (присед → выпрямился)
      modeT += dt;
      const k = Math.min(1, modeT / (GETUP_S * RT));
      const e = k * k * (3 - 2 * k);
      cmd.crouch = 1 - e;
      cmd.air = null;
      animate(dt);
      model.group.updateMatrixWorld(true);
      model.body.matrixWorld.decompose(goalPos, goalQ, unusedScale);
      goalPos.multiplyScalar(1 / S); // группа ниже — в начале мира с масштабом S
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
        // валится на бок без ног — мышцы сразу обмякли (иначе остаток ног подбрасывал корпус)
        ragdoll.setMuscle(collapseT >= 0 ? 0 : t < 0.25 ? 0.35 : Math.max(0, 0.35 * (1 - (t - 0.25) / 0.5)));
        twitchLeft -= dt;
        if (twitchLeft <= 0 && t < 1.4) {
          twitchLeft = 0.05 + Math.random() * 0.1;
          const i = KNEE + Math.floor(Math.random() * 8);
          const s = (0.6 + Math.random() * 1.2) * RT;
          ragdoll.nudge(i, (Math.random() - 0.5) * s, Math.random() * s, (Math.random() - 0.5) * s);
          const part = Math.floor(Math.random() * 9);
          anchorPoint(part, v2);
          fx.sparks(v2, v1.set(0, 1, 0), 5, { speed: [RT, 3 * RT], hot: Math.random() < 0.4, size: RT });
          if (Math.random() < 0.45) arcsFrom(part, v2, 1, 1);
          if (Math.random() < 0.35) sfx.zap(v2, 0.5, S);
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
      let rdt = dt;
      if (collapseT >= 0) {
        // валится на бок под тяжестью: чем больше, тем медленнее (по-настоящему время ∝ √S), но не
        // «висит»: время куклы ×(S/4)^0,25 (исполин ≈ ×2,4 — падает за 3–4 с, а не за 10+); верх
        // корпуса мягко тянет вбок, пока не лёг. Без подброса и сальто (толчков вверх нет).
        collapseT += dt;
        const warp = Math.max(1, (S / 4) ** 0.25);
        rdt = dt * warp;
        // пара сил без общего толчка: верх корпуса — вбок, тазовые узлы — вполсилы обратно (корпус
        // перекатывается вокруг своей оси, а не едет и не подлетает)
        // крен: «верх» корпуса (frame.y, с прошлого кадра) — чем ближе к боку, тем слабее тянет; к боку
        // (up.y < 0,35) не тянет совсем, чтобы не перевернулся на спину
        const upY = collapseT > 0.05 ? frame.y[1] : 1;
        // только начальный крен (пока up.y > 0,6): дальше валится сам, под тяжестью, без закрутки —
        // сильная пара перекатывала корпус на спину
        const a = 0.5 * GRAVITY * rdt * Math.min(1, Math.max(0, (upY - 0.6) / 0.3));
        ragdoll.nudge(4, collapseX * a, 0, collapseZ * a);
        ragdoll.nudge(5, collapseX * a, 0, collapseZ * a);
        for (let i = 0; i < 4; i += 1) ragdoll.nudge(i, -0.5 * collapseX * a, 0, -0.5 * collapseZ * a);
        // угол без ноги проседает, оставшиеся ноги подгибаются в сторону падения (иначе прямые лапы с
        // упёртыми стопами держали корпус «столом» над землёй)
        const lostM = unit.dog.lost | 0;
        // Оставшиеся лапы разъезжаются наружу (стопы скользят, setSlip; колени подгибаются вниз): таз
        // опускается, корпус ложится на бок у земли. Иначе прямые лапы держали таз высоко, и корпус
        // перекатывался вокруг него на спину. Наружу — от корпуса: лапы стороны падения — к падению,
        // другой стороны — от него (если толкать их под корпус, они его подсекали). Пока не лёг.
        const g = upY > 0.3 ? 0.5 * GRAVITY * rdt : 0;
        for (let i = 0; i < 4; i += 1) {
          if (lostM & (1 << i)) {
            ragdoll.nudge(i, 0, -1.2 * g, 0);
            continue;
          }
          const o = (i & 1 ? 1 : -1) === collapseSide ? 1 : -1;
          ragdoll.nudge(FOOT + i, collapseX * o * 1.4 * g, 0, collapseZ * o * 1.4 * g);
          ragdoll.nudge(KNEE + i, collapseX * o * 0.6 * g, -0.6 * g, collapseZ * o * 0.6 * g);
        }
        // кончил: корпус у земли и лёг на бок (его «верх» почти горизонтален) — или 6 с
        // (frame — поза куклы с прошлого кадра; в первый кадр смерти ещё не выставлена)
        const low = collapseT > 0.3 && frame.c[1] - groundHeight(frame.c[0], frame.c[2]) < 0.25 * S;
        if (!collapseDamped && upY < 0.15) {
          // перевалил за бок: тяжёлый не перекатывается на спину — гасим вращение (один раз)
          collapseDamped = true;
          ragdoll.damp(0.25);
        }
        if (low && !collapseLanded) {
          collapseLanded = true;
          collapseLandT = collapseT;
          landThud();
        }
        // лёг на бок у земли — кукла сразу засыпает в этой позе (тяжёлый не катится дальше на спину);
        // лёг плашмя — ещё ~0,8 с оседает; 8 с — в любом случае
        if ((low && upY < 0.35) || (collapseLanded && collapseT - collapseLandT > 0.8 * RT ** 0.5) || collapseT > 8) {
          ragdoll.damp(0);
          ragdoll.setSlip(false);
          ragdoll.rest(groundHeight, 0.3);
          collapseT = -1;
        }
      }
      const slept = ragdoll.asleep;
      ragdoll.step(rdt, groundHeight);
      // уснувшая кукла: поза та же — не пересчитывать (только пока растворяется: гаснет тень)
      if (!(slept && ragdoll.asleep && fade === placedFade)) {
        placeRagdoll();
        collectJoints();
        groundSounds();
        placedFade = fade;
      }
    }
    if (!HIT_GLOW) flash = 0; // синее свечение всего пса от попадания выключено (по просьбе: «электрических эффектов и так достаточно»)
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
  // чёрная дыра (blackhole.js) держит сбитого в воздухе: таймер «сбит» начинается заново (не встаёт в полёте)
  unit.holdDown = () => {
    if (unit.mode === 'down') modeT = 0;
  };
  // ярость: глаза красные (свой материал глаз у каждого пса — дёшево)
  unit.setAngry = (on) => {
    eyeOn.set(unit.dog.team === 'ally' ? EYE_ALLY : on ? EYE_RAGE : EYE_ON);
    glowK = -1;
    if (unit.mode === 'alive' || unit.knocked) model.eyeMaterial.color.copy(eyeOn);
  };
  // накал глаз (стая, каждый кадр): k < 1 — тусклее (eyeOn × (0,45 + 0,55k)), 1 — как есть, до 1,5 —
  // добела (замах, присед перед броском, на дыбах). Только живой: умирающий мигает сам.
  unit.glow = (k) => {
    if (unit.mode !== 'alive') return;
    k = Math.round(k * 40) / 40; // не трогать цвет из-за мелочей
    if (k === glowK) return;
    glowK = k;
    const c = model.eyeMaterial.color;
    if (k <= 1) c.copy(eyeOn).multiplyScalar(0.45 + 0.55 * k);
    else {
      const h = Math.min(1, (k - 1) * 2) * 0.6;
      c.setRGB(eyeOn.r + (1 - eyeOn.r) * h, eyeOn.g + (1 - eyeOn.g) * h, eyeOn.b + (1 - eyeOn.b) * h);
    }
  };
  // LOD (стая, далёкий пёс): в кадре без походки — только переехать (группа и её матрицы)
  unit.follow = () => {
    if (unit.mode !== 'alive') return;
    placeAlive();
    model.group.updateMatrixWorld(true);
    bodyCenter.setFromMatrixPosition(model.body.matrixWorld);
  };
  // кукла считается? (бюджет кукол в стае; плавно ложащаяся — уже нет)
  unit.ragdollActive = () => (unit.mode === 'dying' || unit.mode === 'dead') && !ragdoll.asleep && !ragdoll.easing;
  // волочь труп по земле на (dx, dz) м (чёрная дыра): без физики и без рывка — поза та же, в воздухе
  // опускается не быстрее 5·√S м/с (dt — подшаг), едет по рельефу; зовётся каждый подшаг
  unit.drag = (dx, dz, dt) => {
    if (unit.mode === 'dying') {
      unit.mode = 'dead';
      unit.deadFor = Math.max(unit.deadFor, DYING_S);
      model.eyeMaterial.color.copy(eyeOff);
    }
    ragdoll.drag(dx, dz, groundHeight, 5 * RT * dt);
    placeRagdoll();
    collectJoints();
    placedFade = fade;
  };
  // бюджет кукол: перестать считать без рывка — у земли уснуть в своей позе, в воздухе плавно опуститься
  // (ragdoll.rest); умирающий — сразу мёртв (судороги кончаются, глаза гаснут)
  unit.rest = () => {
    if (unit.mode === 'dying') {
      unit.mode = 'dead';
      unit.deadFor = Math.max(unit.deadFor, DYING_S);
      model.eyeMaterial.color.copy(eyeOff);
    }
    ragdoll.rest(groundHeight, 0.3 * RT);
  };
  // взрыв (artillery.js): подбросить куклу (сбит, умирает, труп) целиком — скорость (vx, vy, vz) м/с, большой — слабее
  unit.blast = (vx, vy, vz) => {
    if (unit.mode !== 'down' && unit.mode !== 'dying' && unit.mode !== 'dead') return false;
    ragdoll.push(vx * PK, vy * PK, vz * PK);
    return true;
  };
  // сразу улечься на землю и больше не считать куклу (бюджет кукол в стае): умирающий — сразу мёртв
  unit.settle = () => {
    if (unit.mode === 'dying') {
      unit.mode = 'dead';
      unit.deadFor = Math.max(unit.deadFor, DYING_S);
      model.eyeMaterial.color.copy(eyeOff);
    }
    ragdoll.settle(groundHeight);
    placeRagdoll();
    collectJoints();
    placedFade = fade;
  };
  // перебита нога leg (0 ЛП, 1 ПП, 2 ЛЗ, 3 ПЗ): искры и дуги из колена, треск; дальше волочится
  // (dog.broken — битовая маска, её читает походка)
  // нога leg отваливается (большие псы, стая): из культи вспышка, искры, дуги, звон и треск; нога
  // больше не рисуется и не ловит пули (dog.lost), походка — как с перебитой (dog.broken). В seg
  // (Float32Array(12)) — мировые таз, колено, стопа и ось колена — для падающего куска
  // (robodog-leg-debris.js). Возвращает seg.
  unit.detachLeg = (leg, seg) => {
    const dog = unit.dog;
    collectJoints();
    const j = leg * 9;
    for (let k = 0; k < 9; k += 1) seg[k] = joints[j + k];
    v1.setFromMatrixColumn(model.legs[leg].upper.matrixWorld, 0).normalize();
    seg[9] = v1.x;
    seg[10] = v1.y;
    seg[11] = v1.z;
    dog.lost = (dog.lost | 0) | (1 << leg);
    dog.broken = (dog.broken | 0) | (1 << leg);
    model.legs[leg].upper.visible = false; // обычная модель (у скелета стаи — robodog-instances.js)
    v2.set(seg[0], seg[1], seg[2]);
    hitNormal.set(seg[3] - seg[0], seg[4] - seg[1], seg[5] - seg[2]).normalize();
    fx.flash(v2, 0.2 * S);
    fx.sparks(v2, hitNormal, Math.round(26 * RT), { speed: [RT, 5 * RT], hot: true, size: RT });
    fx.sparks(v2, v1.set(0, 1, 0), Math.round(12 * RT), { speed: [0.8 * RT, 3 * RT], size: RT });
    arcsFrom(0, v2, 2, 3);
    sfx.clankHeavy(v2, 1, S, true);
    sfx.zap(v2, 1, S, true);
    return seg;
  };
  // мёртвый без двух ног валится на бок в сторону (x, z) (мир): кукла не засыпает и не укладывается
  // бюджетом, пока корпус не у земли; великанам время куклы ускорено
  // корпус лёг: глухой удар; большим — пыль вдоль корпуса, огромным и крупнее — тряска у игрока (ближе — сильнее)
  const landThud = () => {
    v2.set(frame.c[0], groundHeight(frame.c[0], frame.c[2]), frame.c[2]);
    sfx.groundThud(v2, 1, S);
    if (S < 2.5) return;
    if (unit.onFootfall) {
      for (let k = -2; k <= 2; k += 1) {
        const x = frame.c[0] + frame.z[0] * k * 0.2 * S + (Math.random() - 0.5) * 0.2 * S;
        const z = frame.c[2] + frame.z[2] * k * 0.2 * S + (Math.random() - 0.5) * 0.2 * S;
        unit.onFootfall(v3.set(x, groundHeight(x, z), z));
      }
    }
    if (S >= 4 && camera && shared.screenShake) {
      camera.getWorldPosition(v1);
      const d = Math.hypot(v1.x - v2.x, v1.z - v2.z);
      const k = Math.min(1, S / 36) * Math.max(0, 1 - d / (30 + 3 * S));
      if (k > 0.02) {
        v3.set(v1.x - v2.x, 0, v1.z - v2.z);
        if (v3.lengthSq() < 1e-4) v3.set(0, 0, 1);
        try {
          shared.screenShake(k, v3.normalize());
        } catch {
          // тряска не важнее
        }
      }
    }
  };
  unit.collapse = (x, z, side = 1) => {
    collapseSide = side < 0 ? -1 : 1;
    if (unit.mode !== 'dying' && unit.mode !== 'dead') return;
    collapseLanded = false;
    collapseDamped = false;
    twitchLeft = 99; // без судорог: они будили куклу и докатывали её на спину
    const l = Math.hypot(x, z) || 1;
    collapseX = x / l;
    collapseZ = z / l;
    collapseT = 0;
    ragdoll.setSlip(true); // стопы не держат: ноги разъезжаются, корпус опускается на бок
  };
  unit.breakLeg = (leg) => {
    const dog = unit.dog;
    dog.broken = (dog.broken | 0) | (1 << leg);
    anchorPoint(5 + leg, v2);
    fx.sparks(v2, v1.set(0, 1, 0), Math.round(18 * RT), { speed: [RT, 4 * RT], hot: true, size: RT });
    arcsFrom(5 + leg, v2, 2, 2);
    sfx.zap(v2, 0.9, S);
  };
  // удар другого пса (лапа, бросок, пулемёт): damage единиц здоровья в точке point по направлению dir
  // (единичный). Возвращает 'hit' | 'kill' | null (уже не жив)
  unit.strike = (point, dir, damage = 1) => {
    if (unit.mode !== 'alive' && !unit.knocked) return null;
    hitPoint.copy(point);
    hitNormal.copy(dir).negate();
    hitPart = 0;
    sfx.clank(hitPoint, S);
    unit.health -= damage;
    flash = 1;
    fx.sparks(hitPoint, hitNormal, 10, { speed: [RT, 3.5 * RT], size: RT });
    if (unit.health <= 0) {
      unit.kill(dir, 0.6);
      return 'kill';
    }
    if (emergeT < 0 && unit.mode === 'alive') unit.stagger(dir);
    return 'hit';
  };
  // мировое положение стопы ноги leg (0 ЛП, 1 ПП, 2 ЛЗ, 3 ПЗ) — в out
  unit.foot = (leg, out) => out.set(joints[leg * 9 + 6], joints[leg * 9 + 7], joints[leg * 9 + 8]);

  unit.dispose = () => {
    model.dispose();
    shadow.removeFromParent();
    shadowGeometry?.dispose();
    shadowMaterial.dispose();
  };
  return unit;
}
