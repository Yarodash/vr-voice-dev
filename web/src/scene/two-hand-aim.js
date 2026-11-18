// Двуручный хват: пока оружие в основной руке (по умолчанию левой) и зажат курок ДРУГОГО контроллера,
// ствол смотрит по линии «основная рука (рукоятка) → вторая рука (цевьё)», крен — от основной, точка хвата — та же.
// Как в VR-шутерах (LookRotation от основной руки ко второй, «вверх» от основной): в момент нажатия
// запоминается поворот оружия относительно этой рамки (offset), поэтому ствол не прыгает, а дальше
// поворачивается вместе с линией между руками. Отпустил курок — за ≈0,1 с плавно к одной руке.
// Курок второй руки больше ничего не делает (оболочка слушает только основной контроллер).
const BLEND_S = 0.1; // вход и выход из двуручного хвата
const MIN_SPAN_M = 0.06; // руки ближе — направление неустойчиво, рамка берётся с прошлого кадра
const MIN_UP = 0.15; // «вверх» оружия почти вдоль линии рук — крен с прошлого кадра

export function createTwoHandAim(THREE) {
  const rightPos = new THREE.Vector3();
  const pivot = new THREE.Vector3();
  const dir = new THREE.Vector3();
  const upv = new THREE.Vector3();
  const lastUp = new THREE.Vector3(0, 1, 0);
  const xAxis = new THREE.Vector3();
  const zAxis = new THREE.Vector3();
  const basis = new THREE.Matrix4();
  const frameQ = new THREE.Quaternion(); // рамка рук сейчас
  const lastFrameQ = new THREE.Quaternion();
  const offset = new THREE.Quaternion(); // поворот оружия в рамке рук, снятый при нажатии
  const gunQ = new THREE.Quaternion(); // поворот оружия одной рукой
  const target = new THREE.Quaternion();
  const delta = new THREE.Quaternion();
  const unusedP = new THREE.Vector3();
  const unusedS = new THREE.Vector3();
  const m = new THREE.Matrix4();
  let weight = 0;
  let engaged = false;
  let haveFrame = false;

  // Второй контроллер (не руки): курок и позиция рукоятки в мире (рамка XR + rig)
  const readSupport = (renderer, rigMatrix, handedness) => {
    const session = renderer.xr.getSession?.();
    let src = null;
    for (const s of session?.inputSources ?? []) {
      if (s.handedness === handedness && s.gamepad && !s.hand) {
        src = s;
        break;
      }
    }
    if (!src) return { down: false, pos: null };
    const down = Boolean(src.gamepad.buttons[0]?.pressed);
    const frame = renderer.xr.getFrame?.();
    const ref = renderer.xr.getReferenceSpace?.();
    const pose = frame && ref && src.gripSpace ? frame.getPose(src.gripSpace, ref) : null;
    if (!pose) return { down, pos: null };
    const p = pose.transform.position;
    rightPos.set(p.x, p.y, p.z);
    if (rigMatrix) rightPos.applyMatrix4(rigMatrix);
    return { down, pos: rightPos };
  };

  // Рамка рук: −Z — от рукоятки к правой руке, +Y — «вверх» оружия одной рукой (крен левой руки)
  const buildFrame = (handle, right, gunUp) => {
    dir.subVectors(right, handle);
    if (dir.length() < MIN_SPAN_M) return false;
    dir.normalize();
    upv.copy(gunUp).addScaledVector(dir, -gunUp.dot(dir));
    if (upv.length() < MIN_UP) upv.copy(lastUp).addScaledVector(dir, -lastUp.dot(dir));
    if (upv.lengthSq() < 1e-6) return false;
    upv.normalize();
    lastUp.copy(upv);
    zAxis.copy(dir).negate();
    xAxis.crossVectors(upv, zAxis);
    basis.makeBasis(xAxis, upv, zAxis);
    frameQ.setFromRotationMatrix(basis);
    return true;
  };

  return {
    // вес двуручного хвата 0…1 (для отладки)
    get weight() {
      return weight;
    },
    get engaged() {
      return engaged;
    },
    // gunWorld — поза оружия одной рукой (до отдачи и «Размера»), меняется на месте: поворот вокруг
    // точки handleLocal (рукоятка в системе оружия). allow — можно ли сейчас целиться двумя руками.
    // support — рука, курком которой поддерживают ('right' | 'left').
    // fake — подставные данные для проверки без шлема: { down, pos: Vector3 | null }.
    apply(gunWorld, handleLocal, renderer, rigMatrix, allow, dt, fake = null, support = 'right') {
      const r = fake ?? readSupport(renderer, rigMatrix, support);
      const down = allow && r.down;
      gunWorld.decompose(unusedP, gunQ, unusedS);
      pivot.copy(handleLocal).applyMatrix4(gunWorld);
      upv.set(0, 1, 0).applyQuaternion(gunQ);
      const gunUp = unusedS.copy(upv); // unusedS больше не нужен — «вверх» оружия
      const ok = r.pos ? buildFrame(pivot, r.pos, gunUp) : false;
      if (ok) {
        lastFrameQ.copy(frameQ);
        haveFrame = true;
      } else if (haveFrame) {
        frameQ.copy(lastFrameQ); // правая рука потерялась или слишком близко — держим прошлую рамку
      }
      // зажат, но ещё не схвачено (только нажал, или правая рука появилась позже) — хватаем
      if (down && !engaged && ok) {
        engaged = true;
        offset.copy(frameQ).invert().multiply(gunQ); // F⁻¹·G: при нажатии ствол на месте
      }
      if (!down) engaged = false;
      if (!allow) {
        weight = 0;
        engaged = false;
        haveFrame = false;
        return;
      }
      const step = Math.min(dt, 0.1) / BLEND_S;
      weight = engaged ? Math.min(1, weight + step) : Math.max(0, weight - step);
      if (weight <= 0 || !haveFrame) return;
      target.copy(frameQ).multiply(offset);
      const k = weight * weight * (3 - 2 * weight);
      delta.copy(gunQ).slerp(target, k).multiply(gunQ.invert()); // мировой поворот одна рука → итог
      // вокруг рукоятки: T(p)·R·T(−p)·gun
      m.makeRotationFromQuaternion(delta);
      unusedP.copy(pivot).applyQuaternion(delta);
      m.setPosition(pivot.sub(unusedP));
      gunWorld.premultiply(m);
    },
    reset() {
      weight = 0;
      engaged = false;
      haveFrame = false;
    },
  };
}
