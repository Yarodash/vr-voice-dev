// Режим «Инерция» (Настройки ▸ Инерция: вкл/выкл, localStorage 'scene.inertia'): гасит дрожание руки.
// Фильтр One Euro (Casiez, Roussel, Vogel, CHI 2012, https://gery.casiez.net/1euro/): частота среза
// растёт со скоростью движения — медленно (дрожь) режем сильно, быстро (взмах) почти без задержки.
// Положение — по вектору, поворот — slerp кватерниона с alpha от угловой скорости (как OneEuroFilterQuat
// у Meta/Snap/Monado). Фильтруется поза руки относительно rig (hand.matrix, пространство XR), а не
// мировая: иначе в едущей машине оружие отставало бы от неё.
// main.js кладёт отфильтрованную позу в gripWorld — от неё оружие, тарелка в руке, «относительно
// схваченные» панели, дуло, прицел и выстрел. Положение руки для броска тарелки и поиска рядом — сырое.
//
// Подбор (Casiez): beta = 0, minCutoff — пока дрожь не пропала; затем beta — пока быстрые движения не
// перестали отставать. Единицы: cutoff в Гц; beta — Гц на м/с (положение) и Гц на рад/с (поворот).
export const INERTIA = {
  posMinCutoff: 1.0, // Гц: стоишь — положение сглаживается сильно
  posBeta: 6, // взмах 1 м/с → срез 7 Гц (задержка ~23 мс)
  rotMinCutoff: 1.0, // Гц: прицел в покое — дрожь ствола гасится
  rotBeta: 3, // поворот 2 рад/с → срез 7 Гц
  dCutoff: 1.0, // Гц: сглаживание оценки скорости (рекомендация авторов)
  resetJumpM: 0.3, // скачок позы больше этого (перецентровка, потеря трекинга) — без сглаживания
  maxDt: 0.1, // пауза кадров дольше — начать заново
};

// Для оружия с прицелом (АВП, Калаш 2.0) — сильнее (пользователь: «для снайперки ещё сильнее»):
// в покое срез ниже (дрожь гасится почти полностью), за счёт этого медленное наведение чуть «плывёт».
export const INERTIA_SCOPED = {
  ...INERTIA,
  posMinCutoff: 0.4,
  posBeta: 3,
  rotMinCutoff: 0.3,
  rotBeta: 1.2,
};

const alphaOf = (cutoff, dt) => {
  const r = 2 * Math.PI * cutoff * dt;
  return r / (r + 1);
};

export function createInertia(THREE, params = INERTIA) {
  let p = params;
  const pos = new THREE.Vector3(); // отфильтрованное
  const quat = new THREE.Quaternion();
  const vel = new THREE.Vector3(); // сглаженная скорость, м/с
  const angVel = new THREE.Vector3(); // сглаженная угловая скорость (ось × рад/с)
  const rawPos = new THREE.Vector3();
  const rawQuat = new THREE.Quaternion();
  const rawScale = new THREE.Vector3();
  const tmpV = new THREE.Vector3();
  const tmpQ = new THREE.Quaternion();
  const local = new THREE.Matrix4();
  const one = new THREE.Vector3(1, 1, 1);
  let ready = false;

  // один шаг фильтра по позе (position, quaternion), dt — реальные секунды; результат в pos/quat
  const step = (position, quaternion, dt) => {
    rawQuat.copy(quaternion);
    if (!ready || !(dt > 0) || dt > p.maxDt || position.distanceTo(pos) > p.resetJumpM) {
      pos.copy(position);
      quat.copy(rawQuat);
      vel.set(0, 0, 0);
      angVel.set(0, 0, 0);
      ready = true;
      return;
    }
    // положение: скорость = (сырое − прошлое отфильтрованное)/dt, сглаженная; срез от её модуля
    const ad = alphaOf(p.dCutoff, dt);
    tmpV.subVectors(position, pos).divideScalar(dt);
    vel.lerp(tmpV, ad);
    pos.lerp(position, alphaOf(p.posMinCutoff + p.posBeta * vel.length(), dt));
    // поворот: тот же полушар (q и −q — один поворот), угловая скорость из разницы с прошлым
    if (quat.dot(rawQuat) < 0) rawQuat.set(-rawQuat.x, -rawQuat.y, -rawQuat.z, -rawQuat.w);
    tmpQ.copy(quat).invert().premultiply(rawQuat); // raw × prev⁻¹ (мировая ось)
    if (tmpQ.w < 0) tmpQ.set(-tmpQ.x, -tmpQ.y, -tmpQ.z, -tmpQ.w);
    const s = Math.hypot(tmpQ.x, tmpQ.y, tmpQ.z);
    const k = s > 1e-9 ? (2 * Math.atan2(s, tmpQ.w)) / s / dt : 2 / dt;
    tmpV.set(tmpQ.x * k, tmpQ.y * k, tmpQ.z * k);
    angVel.lerp(tmpV, ad);
    quat.slerp(rawQuat, alphaOf(p.rotMinCutoff + p.rotBeta * angVel.length(), dt));
  };

  return {
    pos,
    quat,
    step,
    reset() {
      ready = false;
    },
    // target ← мировая матрица руки по отфильтрованной позе в пространстве rig (hand.matrix — поза XR)
    // strong — оружие с прицелом в руке: параметры INERTIA_SCOPED (переход без скачка — состояние общее)
    apply(hand, target, dt, strong = false) {
      p = strong ? INERTIA_SCOPED : params;
      hand.matrix.decompose(rawPos, rawQuat, rawScale);
      step(rawPos, rawQuat, dt);
      local.compose(pos, quat, one);
      if (hand.parent) target.multiplyMatrices(hand.parent.matrixWorld, local);
      else target.copy(local);
      return target;
    },
  };
}
