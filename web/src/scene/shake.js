// Тряска от выстрелов («скриншейк»), безопасная для VR.
//
// В VR нельзя качать вид отдельно от головы: укачивает. Что считается допустимым (Roblox/Meta
// comfort guides, приём Zulubo «VR screen shake: the art of not throwing up», 2019): горизонт и центр
// взгляда неподвижны, движение только «туда-обратно» вдоль взгляда, без наклонов и поворотов, коротко.
// Поэтому здесь:
// - только сдвиг глаз (без поворота): несколько миллиметров назад вдоль взгляда и чуть вверх. Сдвиг
//   вдоль взгляда даёт радиальное «дыхание» картинки: в центре взгляда — ноль, заметно только по
//   краям и на близком (ствол, руки); далёкий мир и горизонт стоят на месте;
// - мгновенный толчок и экспоненциальный спад (TAU ≈ 20–40 мс → гаснет за 60–120 мс), высокочастотный
//   шум амплитуды, без колебаний; очередь не накапливается (CAP);
// - ничего не трогает rig и камеру игрока: сдвигаются только матрицы камер глаз на время отрисовки
//   кадра (scene.onBeforeRender, как ipd-panel.js) и возвращаются в onAfterRender. В 'vr.rig' сдвиг
//   не попадает, машина/центрирование его не видят. Проходы прицела (scope-lens.js) снимают обёртки
//   onBeforeRender — объектив не трясётся, а стекло прицела трясётся вместе с миром.
//
// Настройка: «Настройки ▸ Тряска: вкл / сильно / выкл» (localStorage 'scene.shake' = '1' | '2' | '0',
// по умолчанию '1'). Свой толчок из других систем: __sceneState.screenShake(сила 0..1, dirWorld?) —
// без направления назад вдоль взгляда, с направлением — вдоль dirWorld (мир, например направление
// пули, попавшей в игрока).
const KEY = 'scene.shake';
export const LEVELS = { 0: 0, 1: 1, 2: 2.5 }; // множитель силы: выкл / вкл / сильно
const NEXT = { 1: 2, 2: 0, 0: 1 };

// м — толчок за выстрел, cap — больше не набирается (очередь), tau — спад, мс; up — доля вверх
export const SHAKE = {
  pistol: { m: 0.006, cap: 0.006, tau: 25 },
  ak: { m: 0.004, cap: 0.006, tau: 20 }, // 600 выстр./мин: за 100 мс гаснет до 1 % — не копится
  awp: { m: 0.02, cap: 0.02, tau: 40 },
};
const UP = 0.25;
const NOISE = 0.4; // амплитуда каждого кадра — от (1 − NOISE) до 1
const EXTERNAL_M = 0.02; // screenShake(1): столько метров
const EXTERNAL_TAU = 35;

export function createShake({ THREE, scene, camera, shared }) {
  let level = 1;
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === '0' || saved === '2') level = Number(saved);
  } catch {
    // без хранилища: вкл
  }
  shared.shakeLevel = level;

  // канал выстрелов: скаляр вдоль взгляда; внешний канал: вектор в мире
  let gunAmp = 0;
  let gunTau = 25;
  let gunAt = 0;
  const ext = new THREE.Vector3();
  let extAt = 0;

  const gunNow = (now) => gunAmp * Math.exp(-(now - gunAt) / gunTau);
  const extScale = (now) => Math.exp(-(now - extAt) / EXTERNAL_TAU);

  const params = (kind, gun) => {
    if (gun?.shake) return gun.shake; // своё у записи (generated-guns.js), формат как в SHAKE
    if (SHAKE[kind]) return SHAKE[kind];
    if (kind === 'ak2') return SHAKE.ak;
    if (gun?.big) return SHAKE.awp;
    return gun?.auto ? SHAKE.ak : SHAKE.pistol;
  };

  const kick = (kind, gun) => {
    const k = LEVELS[shared.shakeLevel] ?? 1;
    if (!k) return;
    const p = params(kind, gun);
    const now = performance.now();
    gunAmp = Math.min(p.cap * k, gunNow(now) + p.m * k);
    gunTau = p.tau;
    gunAt = now;
  };

  const push = new THREE.Vector3();
  const external = (strength = 0.5, dirWorld = null) => {
    const k = LEVELS[shared.shakeLevel] ?? 1;
    const s = Math.min(1, Math.max(0, Number(strength) || 0));
    if (!k || !s) return;
    const now = performance.now();
    ext.multiplyScalar(extScale(now));
    extAt = now;
    if (dirWorld && dirWorld.lengthSq() > 1e-8) push.copy(dirWorld).normalize();
    else push.setFromMatrixColumn(camera.matrixWorld, 2).normalize(); // +Z камеры — назад
    ext.addScaledVector(push, EXTERNAL_M * k * s).clampLength(0, EXTERNAL_M * k);
  };
  shared.screenShake = external;
  shared.shakeDebug = { kick, params }; // ручка для npm run vr:eval

  // ---- сдвиг камер глаз на время отрисовки
  const offset = new THREE.Vector3();
  const back = new THREE.Vector3();
  const up = new THREE.Vector3();
  const saved = [new THREE.Matrix4(), new THREE.Matrix4()];
  const savedCams = [];
  const move = (cam) => {
    saved[savedCams.length].copy(cam.matrixWorld);
    savedCams.push(cam);
    const e = cam.matrixWorld.elements;
    e[12] += offset.x;
    e[13] += offset.y;
    e[14] += offset.z;
    cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
  };

  const prevBefore = scene.onBeforeRender;
  const prevAfter = scene.onAfterRender;
  const before = function onBeforeRender(r, s, cam, ...rest) {
    prevBefore?.call(this, r, s, cam, ...rest);
    savedCams.length = 0;
    if (!cam) return;
    const now = performance.now();
    const g = gunAmp > 0 ? gunNow(now) : 0;
    const x = extAt ? extScale(now) : 0;
    if (g < 1e-5 && x * ext.length() < 1e-5) {
      gunAmp = 0;
      return;
    }
    // оси головы: в XR оболочка уже поставила камеру игрока по шлему (xr.updateCamera)
    back.setFromMatrixColumn(camera.matrixWorld, 2).normalize();
    up.setFromMatrixColumn(camera.matrixWorld, 1).normalize();
    const n = 1 - NOISE * Math.random();
    offset.copy(back).multiplyScalar(g * n).addScaledVector(up, g * UP * (1 - NOISE * Math.random()));
    offset.addScaledVector(ext, x * (1 - NOISE * Math.random()));
    if (cam.isArrayCamera) {
      for (const eye of cam.cameras.slice(0, 2)) move(eye);
    } else {
      move(cam);
    }
  };
  const after = function onAfterRender(...args) {
    for (let i = 0; i < savedCams.length; i += 1) {
      savedCams[i].matrixWorld.copy(saved[i]);
      savedCams[i].matrixWorldInverse.copy(saved[i]).invert();
    }
    savedCams.length = 0;
    prevAfter?.apply(this, args);
  };
  scene.onBeforeRender = before;
  scene.onAfterRender = after;

  return {
    kick,
    external,
    get level() {
      return shared.shakeLevel;
    },
    // «Тряска: вкл → сильно → выкл → вкл»
    cycle() {
      shared.shakeLevel = NEXT[shared.shakeLevel] ?? 1;
      try {
        localStorage.setItem(KEY, String(shared.shakeLevel));
      } catch {
        // без хранилища не переживёт перезагрузку
      }
      return shared.shakeLevel;
    },
    dispose() {
      if (scene.onBeforeRender === before) scene.onBeforeRender = prevBefore;
      if (scene.onAfterRender === after) scene.onAfterRender = prevAfter;
      if (shared.screenShake === external) shared.screenShake = () => {};
    },
  };
}
