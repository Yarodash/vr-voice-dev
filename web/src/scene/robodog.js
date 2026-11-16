// Робопёс — противник в тире (функция сцены «robodog», см. compositions.js; включена в «Сцене 1»).
//
// Модель — robodog-model.js, походка и ноги — robodog-gait.js, поведение — robodog-ai.js,
// тряпичная кукла — robodog-ragdoll.js, искры и дуги — robodog-fx.js, звук — sound.js (zap,
// powerDown). Пёс бегает по полю перед игроком, по земле (та же высота, что у видимой сетки земли:
// groundHeight из car.js).
//
// В него можно стрелять: он — «мишень» для shooting.js (addShootable). Попадание: искры, трескучие
// бело-голубые дуги по корпусу, вспышка корпуса, электрический треск; пёс вздрагивает, на миг
// замирает и убегает. Пуля рядом (ближе NEAR_MISS_M) — тоже убегает. HEALTH попаданий (каждый патрон
// калаша — отдельно) — смерть: судороги, ноги подкашиваются, глаза мигают и гаснут, искры, потом
// он обмякает (тряпичная кукла с толчком от последней пули). Лежащего можно толкать выстрелами.
// Через DEAD_S секунд (или на «Рестарт» сцены) появляется новый.
//
// Счёт: попадание по живому — обычное попадание (score.shot(true) в main.js), по лежащему —
// не считается ни попаданием, ни промахом; убийство — onKill (main.js даёт бонус).
// Сохраняется только «жив/мёртв» (state()); где он бегает — нет.
import { buildRobodog } from './robodog-model.js';
import { BODY_Y, L2, createGait, jumpSpeed } from './robodog-gait.js';
import { createBrain, createDog, yawTo } from './robodog-ai.js';
import { BODY_POINTS, COUNT, FOOT, KNEE, createRagdoll } from './robodog-ragdoll.js';
import { createZapFx } from './robodog-fx.js';
import { groundHeight } from './car.js';

const HEALTH = 5;
const DEAD_S = 20; // лежит, потом новый
const NEAR_MISS_M = 2.2;
const GRAVITY = 9.81;
const DYING_S = 1.6; // судороги до того, как обмякнет совсем
const LOG_EVERY_MS = 10000;
// корпус для попаданий: коробка в системе корпуса (центр, полуразмеры)
const BOX_C = [0, 0.01, -0.015];
const BOX_H = [0.112, 0.08, 0.43];
const UPPER_R = 0.045;
const LOWER_R = 0.034;
const EYE_ON = 0x45e8ff;
const EYE_OFF = 0x061418;

export function createRobodog({ THREE, root, camera, shooting, onKill }) {
  const shared = (globalThis.__sceneState ??= {});
  const brain = createBrain();
  const gait = createGait();
  const ragdoll = createRagdoll();
  let model = null;
  let fx = null;
  let anchors = null;
  let removeShootable = null;
  let enabled = false;
  let run = shared.robodogRun ?? null; // { dog, mode, health, deadLeft, dyingT, pending, alive0, rag }

  // ---- тень: мягкое пятно под псом
  const shadowCanvas = document.createElement('canvas');
  shadowCanvas.width = shadowCanvas.height = 64;
  {
    const g = shadowCanvas.getContext('2d');
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, 'rgba(0,0,0,0.55)');
    grad.addColorStop(0.55, 'rgba(0,0,0,0.3)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
  }
  const shadowTexture = new THREE.CanvasTexture(shadowCanvas);
  const shadowGeometry = new THREE.PlaneGeometry(1, 1);
  shadowGeometry.rotateX(-Math.PI / 2);
  const shadowMaterial = new THREE.MeshBasicMaterial({ map: shadowTexture, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 });
  const shadow = new THREE.Mesh(shadowGeometry, shadowMaterial);
  shadow.name = 'robodog-shadow';
  shadow.visible = false;
  shadow.renderOrder = 1;
  root.add(shadow);

  // ---- общие временные объекты (без выделений в кадре)
  const env = { px: 0, pz: 0, fx: 0, fz: -1, stands: null };
  const v1 = new THREE.Vector3();
  const v2 = new THREE.Vector3();
  const v3 = new THREE.Vector3();
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
  let flash = 0; // вспышка корпуса 0..1
  let lastZap = 0;
  let hitPart = 0; // в какую часть попал последний cast: индекс в anchors
  let groundBase = 0;
  let cosYaw = 1;
  let sinYaw = 0;
  let jumpH = 0;
  let jumpVy = 0;
  const cmd = { v: 0, w: 0, sniff: 0, crouch: 0, air: null };
  let twitchLeft = 0;
  let eyeLeft = 0;
  let eyeLit = true;

  const sound = () => shared.sound;
  const zapSound = (point, strength = 1) => {
    const now = performance.now();
    if (now - lastZap < 55) return;
    lastZap = now;
    try {
      sound()?.zap?.(point, strength);
    } catch {
      // без звука
    }
  };

  // земля в системе «стоп» пса: (lx, lz) по его курсу → высота относительно его начала
  const groundLocal = (lx, lz) => {
    const dog = run.dog;
    return groundHeight(dog.x + lx * cosYaw + lz * sinYaw, dog.z - lx * sinYaw + lz * cosYaw) - groundBase;
  };

  const refreshEnv = () => {
    camera.getWorldPosition(v1);
    env.px = v1.x;
    env.pz = v1.z;
    camera.getWorldDirection(v2);
    const len = Math.hypot(v2.x, v2.z);
    if (len > 0.2) {
      env.fx = v2.x / len;
      env.fz = v2.z / len;
    }
    env.stands = shooting?.targetsEnabled?.() && Array.isArray(shared.targetStands) ? shared.targetStands : null;
  };

  // где появиться: 8–12 м перед игроком, не у стойки, мордой примерно к игроку
  const spawnDog = () => {
    refreshEnv();
    const dog = createDog();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const a = (Math.random() - 0.5) * 1.4;
      const dist = 8 + Math.random() * 4;
      const fx = env.fx * Math.cos(a) - env.fz * Math.sin(a);
      const fz = env.fx * Math.sin(a) + env.fz * Math.cos(a);
      dog.x = env.px + fx * dist;
      dog.z = env.pz + fz * dist;
      if (!(env.stands ?? []).some((s) => Math.hypot(s.x - dog.x, s.z - dog.z) < 1.6)) break;
    }
    dog.yaw = yawTo(env.px - dog.x, env.pz - dog.z) + (Math.random() - 0.5) * 1.2;
    dog.tx = dog.x;
    dog.tz = dog.z;
    dog.left = 1 + Math.random();
    return dog;
  };

  // ---- положение модели
  const placeAlive = () => {
    const dog = run.dog;
    cosYaw = Math.cos(dog.yaw);
    sinYaw = Math.sin(dog.yaw);
    groundBase = groundHeight(dog.x, dog.z) + jumpH;
    model.group.position.set(dog.x, groundBase, dog.z);
    model.group.rotation.set(0, dog.yaw, 0);
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
    model.group.position.set(0, 0, 0);
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
      // таз — точка жёсткого корпуса; от него к колену, от колена к стопе
      v1.copy(leg.hip.position).applyQuaternion(bodyQ).add(model.body.position);
      v2.set(p[(KNEE + i) * 3], p[(KNEE + i) * 3 + 1], p[(KNEE + i) * 3 + 2]);
      v3.subVectors(v2, v1).applyQuaternion(bodyQi);
      orientBone(v3, leg.upper.quaternion);
      upperQi.copy(leg.upper.quaternion).invert();
      v3.set(p[(FOOT + i) * 3], p[(FOOT + i) * 3 + 1], p[(FOOT + i) * 3 + 2]).sub(v2).applyQuaternion(bodyQi).applyQuaternion(upperQi);
      orientBone(v3, leg.knee.quaternion);
    }
    shadowAt(frame.c[0], frame.c[2], Math.atan2(frame.z[0], frame.z[2]), 0.7, Math.max(0, 1 - (frame.c[1] - groundHeight(frame.c[0], frame.c[2])) * 1.5));
  };
  const shadowAt = (x, z, yaw, scale, opacity) => {
    shadow.visible = opacity > 0.02;
    shadow.position.set(x, groundHeight(x, z) + 0.012, z);
    shadow.rotation.set(0, yaw, 0);
    shadow.scale.set(0.62 * scale + 0.1, 1, 1.05 * scale);
    shadowMaterial.opacity = Math.min(1, opacity);
  };

  // мировые точки суставов после обновления матриц: для попаданий и для начала куклы
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

  // ---- модель и мишень для пуль
  const ensureModel = () => {
    if (model) return;
    model = buildRobodog(THREE);
    root.add(model.group);
    anchors = [model.body, ...model.legs.map((l) => l.upper), ...model.legs.map((l) => l.knee)];
    fx = createZapFx({ THREE, root, anchors });
    removeShootable = shooting?.addShootable?.({ cast, hit, shot }) ?? null;
  };
  const teardown = () => {
    removeShootable?.();
    removeShootable = null;
    fx?.dispose();
    fx = null;
    model?.dispose();
    model = null;
    anchors = null;
    shadow.visible = false;
  };

  // ---- попадания: луч против коробки корпуса и капсул ног
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
  function cast(origin, dir, far) {
    if (!enabled || !model || !run || run.pending) return -1;
    // грубо: шар вокруг корпуса
    v1.subVectors(bodyCenter, origin);
    const tc = v1.dot(dir);
    if (tc < -0.9 || v1.lengthSq() - tc * tc > 0.8 * 0.8) return -1;
    let best = -1;
    // коробка корпуса в его системе
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
  }

  // любой выстрел: пуля прошла рядом — живой пёс убегает
  function shot(origin, dir, far) {
    if (!enabled || !run || run.pending || run.mode !== 'alive') return;
    v1.subVectors(bodyCenter, origin);
    const t = v1.dot(dir);
    if (t < 0 || t > far + 1.5) return;
    if (v1.lengthSq() - t * t < NEAR_MISS_M * NEAR_MISS_M) {
      refreshEnv();
      brain.scare(run.dog, env, false);
    }
  }

  // случайная точка на шарнире (для концов дуг): мировая
  const anchorPoint = (index, out) => {
    if (index === 0) {
      out.set((Math.random() - 0.5) * 0.2, Math.random() * 0.1 - 0.03, (Math.random() - 0.5) * 0.7);
      return out.applyMatrix4(model.body.matrixWorld);
    }
    const len = index < 5 ? 0.22 : L2;
    out.set(0, -Math.random() * len, 0);
    return out.applyMatrix4(anchors[index].matrixWorld);
  };
  // дуги от точки попадания к другим частям и «ползающие» вокруг неё
  const arcsFrom = (part, point, count, crawl) => {
    for (let k = 0; k < count; k += 1) {
      let other = Math.floor(Math.random() * anchors.length);
      if (other === part) other = part === 0 ? 1 + Math.floor(Math.random() * 8) : 0;
      anchorPoint(other, v2);
      if (v2.distanceTo(point) > 0.7) v2.lerp(point, 0.4);
      fx.arc(part, point, other, v2, 0.3 + Math.random() * 0.3, 0.035 + Math.random() * 0.04);
    }
    for (let k = 0; k < crawl; k += 1) {
      v2.set((Math.random() - 0.5) * 0.24, (Math.random() - 0.5) * 0.24, (Math.random() - 0.5) * 0.24).add(point);
      fx.arc(part, point, part, v2, 0.25 + Math.random() * 0.25, 0.025);
    }
  };

  function hit(origin, dir, distance) {
    if (!run || !model) return null;
    hitPoint.copy(origin).addScaledVector(dir, distance);
    hitNormal.copy(dir).negate();
    if (run.mode !== 'alive') {
      // лежащего — толкает, немного искрит; не считается ни попаданием, ни промахом
      ragdoll.impulse(hitPoint.x, hitPoint.y, hitPoint.z, dir.x, dir.y, dir.z, 2.2, 0.4);
      ragdoll.impulse(hitPoint.x, hitPoint.y, hitPoint.z, 0, 1, 0, 0.6, 0.4);
      fx.sparks(hitPoint, hitNormal, 6, { speed: [1, 3], hot: Math.random() < 0.5 });
      if (Math.random() < 0.4) {
        fx.arc(hitPart, hitPoint, hitPart, v2.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(0.2).add(hitPoint), 0.2, 0.02);
        zapSound(hitPoint, 0.4);
      }
      return null;
    }
    run.health -= 1;
    flash = 1;
    fx.flash(hitPoint, 0.12);
    fx.sparks(hitPoint, hitNormal, 16, { speed: [1.5, 4.5] });
    fx.sparks(hitPoint, hitNormal, 6, { speed: [1, 3], hot: true });
    arcsFrom(hitPart, hitPoint, 3, 2);
    zapSound(hitPoint, 1);
    if (run.health <= 0) {
      kill(dir);
      return true;
    }
    // вздрогнул: толчок по курсу пули (в системе пса), замер и убегает
    const lx = dir.x * cosYaw - dir.z * sinYaw;
    const lz = dir.x * sinYaw + dir.z * cosYaw;
    gait.kick(lz * 3 + (Math.random() - 0.5), -lx * 4 + (Math.random() - 0.5) * 2);
    refreshEnv();
    brain.scare(run.dog, env, true);
    return true;
  }

  const kill = (dir) => {
    const dog = run.dog;
    run.mode = 'dying';
    run.dyingT = 0;
    run.deadLeft = DEAD_S;
    dog.state = 'dead';
    collectJoints();
    collectRagdollPoints();
    const vx = -Math.sin(dog.yaw) * dog.v;
    const vz = -Math.cos(dog.yaw) * dog.v;
    ragdoll.start(points, vx, dog.jump ? jumpVy : 0, vz);
    ragdoll.setMuscle(0.6);
    ragdoll.impulse(hitPoint.x, hitPoint.y, hitPoint.z, dir.x, dir.y, dir.z, 3.4, 0.6);
    ragdoll.impulse(hitPoint.x, hitPoint.y, hitPoint.z, 0, 1, 0, 1.2, 0.5);
    dog.jump = null;
    jumpH = 0;
    fx.flash(hitPoint, 0.25);
    fx.sparks(hitPoint, hitNormal, 30, { speed: [2, 6] });
    fx.sparks(hitPoint, hitNormal, 14, { speed: [1, 4], hot: true });
    arcsFrom(hitPart, hitPoint, 5, 2);
    try {
      sound()?.powerDown?.(hitPoint);
    } catch {
      // без звука
    }
    twitchLeft = 0;
    eyeLeft = 0;
    try {
      onKill?.();
    } catch (e) {
      console.warn('[robodog] onKill', e?.message ?? e);
    }
  };

  // ---- состояние
  const newRun = (alive) => {
    run = shared.robodogRun = { dog: null, mode: alive ? 'alive' : 'dead', health: HEALTH, deadLeft: DEAD_S, dyingT: 9, pending: true, rag: null };
  };
  // появиться (первый кадр, когда камера на месте, или после смерти)
  const spawn = () => {
    run.dog = spawnDog();
    run.pending = false;
    run.health = HEALTH;
    jumpH = 0;
    flash = 0;
    model.eyeMaterial.color.copy(eyeOn);
    model.material.emissive.setRGB(0, 0, 0);
    // поза стоя
    placeAlive();
    cmd.v = cmd.w = cmd.sniff = cmd.crouch = 0;
    cmd.air = null;
    for (let i = 0; i < 30; i += 1) gait.update(1 / 60, cmd, groundLocal);
    model.setPose(gait.pose);
    collectJoints();
    if (run.mode !== 'alive') {
      // загрузили мёртвым: лежит (обмяк на месте)
      run.dog.state = 'dead';
      collectRagdollPoints();
      ragdoll.start(points);
      ragdoll.setMuscle(0);
      run.dyingT = 9;
      model.eyeMaterial.color.copy(eyeOff);
    } else {
      // включился: голубые искры вокруг
      fx.sparks(bodyCenter, v1.set(0, 1, 0), 18, { speed: [0.8, 2.5], spread: 1.2 });
      arcsFrom(0, bodyCenter, 3, 0);
    }
  };

  let sum = 0;
  let worst = 0;
  let frames = 0;
  let since = performance.now();

  const api = {
    // enabled — есть ли пёс в сцене; saved — { alive } из снимка сцены; keep — подмена файла сцены:
    // пёс остаётся где был (иначе — новый перед игроком)
    apply(on, saved, { keep = false } = {}) {
      enabled = Boolean(on);
      if (!enabled) {
        teardown();
        run = shared.robodogRun = null;
        return;
      }
      ensureModel();
      if (keep && run && (run.pending || run.dog)) {
        if (!run.pending && run.mode !== 'alive') {
          // кукла после подмены сцены: те же точки
          if (run.rag) {
            ragdoll.start(run.rag.pos);
            ragdoll.prev.set(run.rag.prev);
          } else run.pending = true;
          run.mode = 'dead';
          ragdoll.setMuscle(0);
          model.eyeMaterial.color.copy(eyeOff);
        }
        return;
      }
      newRun(saved?.alive !== false);
    },
    state: () => (enabled && run ? { alive: run.mode === 'alive' } : null),
    get alive() {
      return Boolean(run && run.mode === 'alive' && !run.pending);
    },
    update(dt) {
      if (!enabled || !model || !run) return;
      const t0 = performance.now();
      dt = Math.min(dt, 0.05);
      if (run.pending) {
        camera.getWorldPosition(v1);
        if (v1.lengthSq() === 0) return; // камера ещё не на месте
        spawn();
      }
      if (run.mode === 'alive') {
        const dog = run.dog;
        refreshEnv();
        const event = brain.step(dog, env, dt);
        if (event && !dog.jump) dog.jump = { phase: 0, t: 0, height: event === 'jump' ? 0.45 : 0.25, total: 1 };
        // прыжок: присел → полёт по параболе → приземлился, присел
        cmd.crouch = 0;
        cmd.air = null;
        const j = dog.jump;
        if (j) {
          j.t += dt;
          if (j.phase === 0) {
            const k = Math.min(1, j.t / 0.18);
            cmd.crouch = k * k * (3 - 2 * k);
            if (j.t >= 0.18) {
              j.phase = 1;
              j.t = 0;
              jumpVy = jumpSpeed(j.height);
              j.total = (2 * jumpVy) / GRAVITY;
            }
          } else if (j.phase === 1) {
            jumpVy -= GRAVITY * dt;
            jumpH += jumpVy * dt;
            cmd.air = Math.min(1, j.t / j.total);
            if (jumpH <= 0 && jumpVy < 0) {
              jumpH = 0;
              j.phase = 2;
              j.t = 0;
            }
          } else {
            cmd.crouch = 0.7 * Math.max(0, 1 - j.t / 0.22);
            if (j.t >= 0.22) dog.jump = null;
          }
        }
        placeAlive();
        cmd.v = dog.v;
        cmd.w = dog.w;
        cmd.sniff = dog.sniff;
        gait.update(dt, cmd, groundLocal);
        model.setPose(gait.pose);
        collectJoints();
        shadowAt(dog.x, dog.z, dog.yaw, 1 - Math.min(0.5, jumpH), 1 - Math.min(0.6, jumpH * 1.2));
        // оглушён — изредка искрит
        if (dog.state === 'stun' && Math.random() < dt * 14) {
          anchorPoint(Math.floor(Math.random() * 9), v2);
          fx.sparks(v2, v1.set(0, 1, 0), 3, { speed: [0.8, 2] });
        }
      } else {
        // умирает: мышцы слабеют, судороги, глаза мигают и гаснут; потом просто кукла
        if (run.mode === 'dying') {
          run.dyingT += dt;
          const t = run.dyingT;
          ragdoll.setMuscle(t < 0.35 ? 0.6 : Math.max(0, 0.6 * (1 - (t - 0.35) / 0.55)));
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
            if (Math.random() < 0.35) zapSound(v2, 0.5);
          }
          eyeLeft -= dt;
          if (eyeLeft <= 0) {
            eyeLeft = 0.03 + Math.random() * 0.07;
            eyeLit = t < 1.2 && Math.random() < 1 - t / 1.2;
            model.eyeMaterial.color.copy(eyeLit ? eyeOn : eyeOff);
          }
          if (t >= DYING_S) {
            run.mode = 'dead';
            ragdoll.setMuscle(0);
            model.eyeMaterial.color.copy(eyeOff);
          }
        }
        ragdoll.step(dt, groundHeight);
        placeRagdoll();
        collectJoints();
        run.deadLeft -= dt;
        if (run.deadLeft <= 0) {
          run.mode = 'alive';
          run.rag = null;
          spawn();
        }
      }
      // вспышка корпуса от попадания: голубоватая, мерцает
      if (flash > 0.01) {
        flash *= Math.exp(-dt * 10);
        const k = flash * (0.6 + Math.random() * 0.4);
        model.material.emissive.setRGB(0.25 * k, 0.45 * k, 1.1 * k);
      } else if (flash) {
        flash = 0;
        model.material.emissive.setRGB(0, 0, 0);
      }
      fx.update(dt);

      const spent = performance.now() - t0;
      sum += spent;
      worst = Math.max(worst, spent);
      frames += 1;
      if (t0 - since >= LOG_EVERY_MS) {
        console.log(`[robodog] cpu=${(sum / frames).toFixed(3)}/${worst.toFixed(2)}ms mode=${run.mode} state=${run.dog?.state} hp=${run.health} fx=${fx.active} rag=${run.mode !== 'alive' ? (ragdoll.asleep ? 'sleep' : 'awake') : '-'}`);
        sum = worst = frames = 0;
        since = t0;
      }
    },
    // для npm run vr:eval
    debug: {
      info: () =>
        run && {
          mode: run.mode,
          pending: run.pending,
          health: run.health,
          deadLeft: +run.deadLeft.toFixed(1),
          dog: run.dog && { x: +run.dog.x.toFixed(2), z: +run.dog.z.toFixed(2), yaw: +run.dog.yaw.toFixed(2), v: +run.dog.v.toFixed(2), state: run.dog.state, jump: Boolean(run.dog.jump) },
          body: bodyCenter.toArray().map((v) => +v.toFixed(2)),
          asleep: ragdoll.asleep,
        },
      // выстрел из точки from (мировой) в центр пса — как пуля
      shootFrom(from) {
        const o = new THREE.Vector3().copy(from);
        const d = bodyCenter.clone().sub(o).normalize();
        const t = cast(o, d, 60);
        if (t < 0) return 'мимо';
        return hit(o, d, t);
      },
      respawn() {
        newRun(true);
      },
      bodyY: BODY_Y,
    },
    dispose() {
      if (run && run.mode !== 'alive' && !run.pending) run.rag = { pos: Float32Array.from(ragdoll.pos), prev: Float32Array.from(ragdoll.prev) };
      teardown();
      shadow.removeFromParent();
      shadowGeometry.dispose();
      shadowMaterial.dispose();
      shadowTexture.dispose();
    },
  };
  return api;
}
