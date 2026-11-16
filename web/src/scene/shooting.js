// Мишени и выстрелы. Живёт в сцене: правки подхватываются на лету.
//
// Мишени — стальные тарелки на деревянных стойках, рядами вдаль перед игроком (targets.js). Выстрел —
// мгновенный луч от дула пистолета вдоль ствола: вспышка, искры, дым, гильза, трассер и звук
// (effects.js, sound.js); попавшая мишень звенит и слетает со стойки, лежащая — подпрыгивает.
import { createEffects } from './effects.js';
import { TARGET_LAYOUT, createTargets, targetSpots } from './targets.js';
import { createSound } from './sound.js';

const SPEED_OF_SOUND = 343; // м/с: звук попадания приходит с задержкой

export function createShooting({ THREE, root, camera }) {
  const shared = (globalThis.__sceneState ??= {});
  const group = new THREE.Group();
  root.add(group);
  const effects = createEffects({ THREE, group });
  // Звук живёт между подменами сцены: контекст создаётся один раз (их число в странице ограничено).
  const sound = (shared.sound ??= createSound());

  // Мишени на деревянных стойках, их падение и тени — targets.js.
  const targetSet = createTargets({ THREE, group, shared, camera });
  const targets = targetSet.plates;
  const raycaster = new THREE.Raycaster();
  const RANGE = 60; // дальше самого дальнего ряда (38 м)
  raycaster.far = RANGE;

  // ---- Следы от пуль на мишенях: тёмная дырка с опалённым краем. Они крепятся к мишени (качаются
  // вместе с ней) и переживают подмену сцены; на каждой мишени не больше MAX_DECALS последних.
  const MAX_DECALS = 40;
  const decalCanvas = document.createElement("canvas");
  decalCanvas.width = decalCanvas.height = 64;
  const dg = decalCanvas.getContext("2d");
  const burn = dg.createRadialGradient(32, 32, 0, 32, 32, 31);
  burn.addColorStop(0, "rgba(8,8,8,1)");
  burn.addColorStop(0.28, "rgba(12,10,9,1)");
  burn.addColorStop(0.42, "rgba(45,38,34,0.85)");
  burn.addColorStop(0.7, "rgba(60,52,46,0.35)");
  burn.addColorStop(1, "rgba(60,52,46,0)");
  dg.fillStyle = burn;
  dg.fillRect(0, 0, 64, 64);
  const decalTexture = new THREE.CanvasTexture(decalCanvas);
  decalTexture.colorSpace = THREE.SRGBColorSpace;
  const decalGeometry = new THREE.CircleGeometry(0.016, 18);
  const decalMaterial = new THREE.MeshBasicMaterial({ map: decalTexture, transparent: true, depthWrite: false });
  if (shared.targetDecals?.length !== targets.length) shared.targetDecals = targets.map(() => []);
  const decalsOf = shared.targetDecals; // [x, y, z, поворот, размер] в системе мишени
  const placeDecal = (target, [x, y, z, turn, size]) => {
    const decal = new THREE.Mesh(decalGeometry, decalMaterial);
    decal.position.set(x, y, z);
    decal.rotation.z = turn;
    decal.scale.setScalar(size);
    decal.renderOrder = 1;
    target.add(decal);
    (target.userData.decals ??= []).push(decal);
  };
  targets.forEach((target, index) => (decalsOf[index] ?? []).forEach((saved) => placeDecal(target, saved)));
  const addDecal = (target, worldPoint) => {
    const local = target.worldToLocal(worldPoint.clone());
    const saved = [local.x, local.y, local.z + 0.0015, Math.random() * Math.PI * 2, 0.8 + Math.random() * 0.5];
    placeDecal(target, saved);
    const list = decalsOf[targets.indexOf(target)];
    list.push(saved);
    if (list.length > MAX_DECALS) {
      list.shift();
      target.remove(target.userData.decals.shift());
    }
  };

  const clearDecals = () =>
    targets.forEach((target, index) => {
      for (const decal of target.userData.decals ?? []) target.remove(decal);
      target.userData.decals = [];
      decalsOf[index] = [];
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
  const aimHits = [];
  const normal = new THREE.Vector3();
  const scratch = new THREE.Vector3();
  let clayTarget = null; // глиняные тарелки (clays.js), их тоже можно сбить
  const segDir = new THREE.Vector3();
  const segHit = { point: new THREE.Vector3(), normal: new THREE.Vector3(), target: null, isStand: false };

  // shared.shooting — ручка для npm run vr:eval (проверить выстрел без пистолета в руке)
  const api = (shared.shooting = {
    placeInFront,
    // Прицел (каждый кадр): тот же луч, что у shoot(); мишень, в которую попадёт выстрел, получает
    // белый контур. aim(null) — оружия в руке нет.
    aim(muzzle, direction) {
      effects.setMuzzle(muzzle); // струйка дыма идёт от дула, где бы оно ни было
      let target = null;
      if (muzzle) {
        raycaster.set(muzzle, direction);
        aimHits.length = 0;
        raycaster.intersectObjects(rayObjects, false, aimHits);
        const hit = aimHits[0];
        if (hit?.object === targetSet.plateMesh) target = targets[hit.instanceId];
      }
      targetSet.setAim(target);
    },
    // muzzle, direction: мировые координаты дула и направления ствола; ejector, right, up — где
    // вылетает гильза (мировые координаты). Возвращает true при попадании.
    shoot(muzzle, direction, { ejector, right, up } = {}) {
      raycaster.set(muzzle, direction);
      // все мишени (и стоящие, и лежащие) и стойки; в стойку — пуля просто останавливается
      const hits = raycaster.intersectObjects(rayObjects, false);
      let target = null;
      let end = muzzle.clone().addScaledVector(direction, RANGE);
      if (hits.length) {
        const hit = hits[0];
        end = hit.point.clone();
        if (hit.object === targetSet.plateMesh) {
          target = targets[hit.instanceId];
          normal.copy(hit.face?.normal ?? direction.clone().negate()).transformDirection(target.matrixWorld);
        }
      }
      // глиняная тарелка (clays.js) ближе мишени — пуля разбивает её и дальше не летит
      const clayDistance = clayTarget ? clayTarget.cast(muzzle, direction, hits.length ? hits[0].distance : RANGE) : -1;
      if (clayDistance >= 0) {
        end = muzzle.clone().addScaledVector(direction, clayDistance);
        target = null;
        clayTarget.hit(muzzle, direction, clayDistance);
      }
      if (target) {
        addDecal(target, end);
        targetSet.knock(target, end, direction);
      }

      effects.muzzleFlash(muzzle, direction);
      effects.tracer(muzzle, end);
      if (ejector && right && up) effects.eject(ejector, right, up);
      sound.shot({ position: muzzle });
      if (target) {
        effects.impact(end, normal.clone());
        const delay = Math.min(250, (muzzle.distanceTo(end) / SPEED_OF_SOUND) * 1000);
        setTimeout(() => sound.hit(end), delay);
      }
      return Boolean(target) || clayDistance >= 0;
    },
    // Глиняные тарелки (clays.js): { cast(origin, dir, far) → расстояние или −1, hit(origin, dir, distance) }
    setClayTarget(handler) {
      clayTarget = handler;
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
      if (!placed && camera.getWorldPosition(scratch).lengthSq() > 0) {
        // первый кадр: мишени перед игроком (камера уже на месте)
        placeInFront(false);
        placed = true;
      }
      targetSet.update(dt); // полёт сбитых мишеней и тени
      effects.update(dt);
    },
    dispose() {
      saveTargets();
      effects.dispose();
      targetSet.dispose();
      decalGeometry.dispose();
      decalMaterial.dispose();
      decalTexture.dispose();
    },
  });
  return api;
}
