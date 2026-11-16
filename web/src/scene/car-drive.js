// За рулём машины (car.js). Пункты меню «Сесть за руль» / «Выйти из машины» (сцены с функцией «car»).
// Сесть: игрока (группу rig оболочки — родителя камеры) переносят так, что голова оказывается на
// месте глаз водителя (левый руль) и смотрит по ходу машины; дальше rig каждый кадр едет с машиной —
// только курс и положение, без тангажа и крена кузова (меньше укачивает). Голову внутри машины
// можно двигать как обычно.
// Управление: курок — газ (аналоговый), хват — тормоз; стоим и держим тормоз дольше 0,4 с —
// задний ход (тогда хват — газ назад, а курок — тормоз; газ на месте — снова вперёд). Стик
// влево-вправо — руль, нелинейно: мёртвая зона 0,08, дальше |x|^2.5 (малые отклонения — совсем
// малый поворот). Пока открыто меню или панель — стик и педали машине не идут (тормоз двигателем),
// а газ после меню ждёт, пока курок отпустят.
// Выйти: игрок стоит у водительской двери. «Сидит ли» переживает подмену сцены (__sceneState), но не
// перезагрузку страницы: после перезагрузки игрок всегда стоит (rig — как сохранила оболочка).
import { groundHeight } from './car.js';
import { createEngineSound } from './engine-sound.js';

const SEAT_EYE = [-0.37, 1.17, 0.22]; // глаза водителя в системе машины (перед — к −Z)
const DOOR = [-1.35, 0, -0.2]; // где встать при выходе: у левой передней двери
const DEADZONE = 0.08;
const EXPO = 2.5;
const RIG_KEY = 'vr.rig'; // так оболочка запоминает rig между перезагрузками

// стик −1..1 → руль −1..1: мёртвая зона и степень (малые отклонения — очень малый поворот)
export const steerCurve = (x) => {
  const a = Math.abs(x);
  if (a <= DEADZONE) return 0;
  return Math.sign(x) * Math.min(1, (a - DEADZONE) / (1 - DEADZONE)) ** EXPO;
};

export function createCarDrive({ THREE, camera, car, shared }) {
  // seated, rel — rig относительно машины (16 чисел), stand — рост глаз стоя над землёй;
  // debugInput — { throttle, brake, x } вместо джойстика (для npm run vr:eval на ПК)
  const seat = (shared.carSeat ??= { seated: false, rel: null, stand: 1.6, debugInput: null });
  const frame = new THREE.Matrix4();
  const rel = new THREE.Matrix4();
  const m = new THREE.Matrix4();
  const t = new THREE.Matrix4();
  const head = new THREE.Vector3();
  const look = new THREE.Vector3();
  const p = new THREE.Vector3();
  const unusedScale = new THREE.Vector3();
  if (seat.rel) rel.fromArray(seat.rel);
  let engine = seat.seated ? createEngineSound() : null;
  let needRelease = true; // газ — только после того, как курок отпустили (им же выбрали пункт меню)
  let buzzLeft = 0;
  const rig = () => camera.parent;
  const buzz = (source, strength, ms) => source?.gamepad?.hapticActuators?.[0]?.pulse?.(strength, ms);

  const enter = () => {
    const r = rig();
    if (!r || !car.model) return false;
    camera.updateWorldMatrix(true, false);
    camera.getWorldPosition(head);
    camera.getWorldDirection(look);
    if (!seat.seated) seat.stand = Math.min(2, Math.max(1, head.y - groundHeight(head.x, head.z)));
    const headYaw = Math.atan2(-look.x, -look.z);
    car.yawFrame(frame);
    p.fromArray(SEAT_EYE).applyMatrix4(frame);
    // rig' = T · rig, T = к сиденью · поворот (курс машины − курс головы) · голову в начало
    t.makeTranslation(-head.x, -head.y, -head.z)
      .premultiply(m.makeRotationY(car.pose().yaw - headYaw))
      .premultiply(m.makeTranslation(p.x, p.y, p.z));
    r.updateMatrix();
    m.copy(t).multiply(r.matrix);
    m.decompose(r.position, r.quaternion, unusedScale);
    rel.copy(frame).invert().multiply(m);
    seat.rel = rel.toArray();
    seat.seated = true;
    needRelease = true;
    engine ??= createEngineSound();
    return true;
  };

  const exit = () => {
    const r = rig();
    if (r && seat.seated) {
      camera.updateWorldMatrix(true, false);
      camera.getWorldPosition(head);
      if (car.model) p.fromArray(DOOR).applyMatrix4(car.yawFrame(frame));
      else p.copy(head);
      const y = groundHeight(p.x, p.z) + seat.stand;
      r.position.x += p.x - head.x;
      r.position.y += y - head.y;
      r.position.z += p.z - head.z;
      try {
        localStorage.setItem(RIG_KEY, JSON.stringify({ p: r.position.toArray(), q: r.quaternion.toArray() }));
      } catch {
        // без хранилища после перезагрузки игрок окажется там, где был до машины
      }
    }
    seat.seated = false;
    seat.rel = null;
    engine?.stop();
    engine = null;
    return true;
  };

  return {
    get seated() {
      return seat.seated;
    },
    enter,
    exit,
    // каждый кадр (до того, как сцена считает руку): машина едет, игрок за рулём — с ней.
    // busy — открыто меню или панель: стик и педали не машине.
    update(dt, source, busy) {
      if (seat.seated && !car.model) exit(); // машину убрали (другая сцена, «Очистить всё»)
      if (!seat.seated) {
        car.update(dt, null);
        return;
      }
      const gp = source?.gamepad;
      const fake = seat.debugInput;
      const trigger = fake ? fake.throttle ?? 0 : gp?.buttons[0]?.value ?? 0;
      const grip = fake ? fake.brake ?? 0 : gp?.buttons[1]?.value ?? 0;
      const stickX = fake ? fake.x ?? 0 : gp?.axes?.[2] ?? 0;
      if (busy) needRelease = true;
      else if (trigger < 0.05 || fake) needRelease = false;
      const input = {
        throttle: busy || needRelease ? 0 : trigger,
        brake: busy ? 0 : grip,
        steer: busy ? 0 : steerCurve(stickX),
      };
      if (car.update(dt, input) === 'reverse') buzz(source, 0.6, 120);
      // игрок едет с машиной: rig = машина (курс + место) · rel
      const r = rig();
      if (r) {
        m.multiplyMatrices(car.yawFrame(frame), rel);
        m.decompose(r.position, r.quaternion, unusedScale);
      }
      const speed = Math.abs(car.state().v);
      // лёгкая дрожь: от скорости и газа
      buzzLeft -= dt;
      if (buzzLeft <= 0) {
        buzzLeft = 0.06;
        if (speed > 0.3 || input.throttle > 0.05) buzz(source, Math.min(0.2, 0.025 + speed * 0.005 + input.throttle * 0.06), 70);
      }
      engine?.set(speed, input.throttle);
    },
    dispose() {
      engine?.stop(); // при подмене сцены новая версия заведёт свой, если игрок за рулём
      engine = null;
    },
  };
}
