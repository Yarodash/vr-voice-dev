// «Относительно схватить» издали лучом джойстика. Рука пуста, меню закрыто, рядом ничего нет: луч
// (тот же, что у окон: −Z пространства луча левого контроллера) ищет оружие до MAX_RANGE_M. Берётся
// только то, во что луч ПОПАЛ (просьба пользователя: «именно луч прям на пушку навести»): сначала
// грубый отсев по ограничивающей сфере (своя у каждого, в системе оружия, обновляется раз в
// BOUNDS_REFRESH_MS: калаш и сгенерированные пушки догружаются позже), потом точный луч по
// треугольникам мешей оружия (Raycaster). У цели белая обводка, луч упирается в точку попадания.
// КУРОК (не хват — просьба пользователя) берёт относительно: offset = inverse(рука) × оружие, дальше
// оружие = рука × offset (как рычаг), луч тянется до точки, за которую взяли; пока курок зажат —
// держится, отпустил — висит, где отпустили. Стик вперёд/назад — ближе/дальше вдоль луча (до 3 м/с,
// 0,3–15 м). Окно HUD перед оружием на луче (кнопки превью) главнее.
// Подключено в scene/main.js.
const MAX_RANGE_M = 15;
const BOUNDS_REFRESH_MS = 1000;
const STICK_SPEED = 3; // м/с при полном отклонении стика (ближе/дальше вдоль луча)
const STICK_FORWARD_PULLS = false; // стик вперёд — дальше, назад — ближе (пользователь попросил поменять местами); true — наоборот
const MIN_DIST_M = 0.3;
const SPIN_SPEED = Math.PI; // рад/с при полном отклонении стика влево/вправо (вращение вокруг луча)
const DEAD = 0.18;

export function createRayGrab({ THREE, root, camera = null }) {
  const origin = new THREE.Vector3();
  const dir = new THREE.Vector3();
  const center = new THREE.Vector3();
  const toCenter = new THREE.Vector3();
  const hit = new THREE.Vector3();
  const bestHit = new THREE.Vector3();
  const step = new THREE.Vector3();
  const spin = new THREE.Matrix4();
  const shift = new THREE.Matrix4();
  const grabLocal = new THREE.Vector3(); // точка, за которую взяли, в системе оружия
  const size = new THREE.Vector3();
  const box = new THREE.Box3();
  const inv = new THREE.Matrix4();
  const offset = new THREE.Matrix4();
  const world = new THREE.Matrix4();
  const raycaster = new THREE.Raycaster();
  raycaster.far = MAX_RANGE_M;
  raycaster.params.Line.threshold = 0.004; // линии внутри оружия не ловят луч за метр от себя
  raycaster.params.Points.threshold = 0.004;
  raycaster.camera = camera; // спрайтам (если есть) нужна камера
  const hits = [];
  let target = null; // на что смотрит луч (можно взять)
  let item = null; // что держим лучом
  let lastTarget = null;

  const positions = new Float32Array(6);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const line = new THREE.Line(geometry, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.75 }));
  line.frustumCulled = false;
  line.visible = false;
  const dot = new THREE.Mesh(new THREE.SphereGeometry(0.012, 12, 8), new THREE.MeshBasicMaterial({ color: 0xffffff }));
  dot.visible = false;
  root.add(line, dot);

  // ограничивающая сфера в системе оружия (без его «Размера»: радиус × group.scale.x в кадре)
  const boundsOf = (it, now) => {
    let b = it.rayBounds;
    if (b && now - b.at < BOUNDS_REFRESH_MS) return b;
    if (!b) b = it.rayBounds = { at: 0, center: new THREE.Vector3(), radius: 0.15 };
    it.group.updateWorldMatrix(true, true);
    box.setFromObject(it.group);
    if (box.isEmpty()) {
      b.center.set(0, 0, 0);
      b.radius = 0.15;
    } else {
      box.getCenter(b.center).applyMatrix4(inv.copy(it.group.matrixWorld).invert());
      b.radius = box.getSize(size).length() / 2 / Math.max(1e-3, it.group.scale.x);
    }
    b.at = now;
    return b;
  };

  // точное попадание в оружие: ближайшая точка на его мешах (→ hit), расстояние или −1
  // tFar — докуда вдоль луча может быть оружие (за его сферой): для луча, начатого ВНУТРИ оружия
  const backFrom = new THREE.Vector3();
  const backDir = new THREE.Vector3();
  const castInto = (it, tFar = 0) => {
    hits.length = 0;
    it.group.updateWorldMatrix(true, true);
    raycaster.intersectObject(it.group, true, hits);
    for (let i = 0; i < hits.length; i += 1) {
      const h = hits[i];
      if (!h.object.isMesh || !h.object.visible || h.object.material?.side === THREE.BackSide) continue; // невидимое и обводка не в счёт
      hit.copy(h.point);
      return h.distance;
    }
    // луч начался внутри оружия (большое после «Размера», игрок стоит в нём): лицевые грани изнутри
    // не видны — обратный луч из-за оружия к руке; его попадание перед рукой = выход из оружия
    if (tFar > 0) {
      backFrom.copy(origin).addScaledVector(dir, tFar);
      raycaster.set(backFrom, backDir.copy(dir).negate());
      raycaster.far = tFar;
      hits.length = 0;
      raycaster.intersectObject(it.group, true, hits);
      raycaster.set(origin, dir);
      raycaster.far = MAX_RANGE_M;
      for (let i = hits.length - 1; i >= 0; i -= 1) { // ближайший к руке выход
        const h = hits[i];
        if (!h.object.isMesh || !h.object.visible || h.object.material?.side === THREE.BackSide) continue;
        hit.copy(h.point);
        return tFar - h.distance;
      }
    }
    return -1;
  };

  const pick = (items, now) => {
    let best = null;
    let bestDist = Infinity;
    for (let i = 0; i < items.length; i += 1) {
      const it = items[i];
      const b = boundsOf(it, now);
      it.group.updateWorldMatrix(true, false);
      center.copy(b.center).applyMatrix4(it.group.matrixWorld);
      const radius = b.radius * it.group.scale.x;
      toCenter.subVectors(center, origin);
      const t = toCenter.dot(dir);
      if (t < -radius || t - radius > MAX_RANGE_M || t - radius > bestDist) continue;
      if (toCenter.lengthSq() - t * t > radius * radius) continue; // луч мимо сферы
      const d = castInto(it, toCenter.lengthSq() < radius * radius ? Math.min(MAX_RANGE_M, t + radius) : 0); // рука в сфере оружия — может быть внутри
      if (d >= 0 && d < bestDist) {
        bestDist = d;
        best = it;
        bestHit.copy(hit); // точка ближайшего
      }
    }
    if (best) hit.copy(bestHit);
    return best;
  };

  // окно HUD (сообщения, зелёное превью с кнопками — дети камеры) ближе оружия на луче: курок нажмёт
  // кнопку окна (оболочка, pointer.js), а не возьмёт оружие. Учитываются только видимые меши.
  const shown = (o) => {
    for (let x = o; x; x = x.parent) if (!x.visible) return false;
    return true;
  };
  const hudFirst = (it) => {
    if (!camera) return false;
    const gunDist = hit.distanceTo(origin);
    hits.length = 0;
    raycaster.intersectObjects(camera.children, true, hits);
    for (let i = 0; i < hits.length; i += 1) {
      if (hits[i].distance >= gunDist) break;
      if (hits[i].object.isMesh && shown(hits[i].object)) return true;
    }
    return false;
  };

  const showLine = (end) => {
    positions[0] = origin.x;
    positions[1] = origin.y;
    positions[2] = origin.z;
    positions[3] = end.x;
    positions[4] = end.y;
    positions[5] = end.z;
    geometry.attributes.position.needsUpdate = true;
    line.visible = true;
    dot.position.copy(end);
    dot.visible = true;
  };

  return {
    get target() {
      return target;
    },
    get item() {
      return item;
    },
    // луч занят (рисуем свой до оружия): оболочке — hideBeam
    get showing() {
      return line.visible;
    },
    // rayObj — объект луча контроллера (или null); gripWorld — поза руки (после «Инерции»);
    // canPoint — рука пуста, рядом ничего, меню и панели закрыты. Берёт и держит КУРОК (просьба
    // пользователя): нажал на оружии — взял, отпустил — висит. Возвращает 'grab' | 'release' | 'hover' | null.
    update({ rayObj, gripWorld, items, canPoint, triggerDown, triggerPressed, menuIsOpen, stickX = 0, stickY = 0, dt = 0 }) {
      const now = performance.now();
      if (item && !items.includes(item)) item = null; // удалили, сменили сцену
      target = null;
      line.visible = dot.visible = false;
      let event = null;
      if (rayObj) {
        rayObj.updateWorldMatrix(true, false);
        origin.setFromMatrixPosition(rayObj.matrixWorld);
        dir.set(0, 0, -1).transformDirection(rayObj.matrixWorld);
        raycaster.set(origin, dir);
      }
      if (item) {
        if (!triggerDown) {
          item = null;
          event = 'release';
        }
      } else if (canPoint && rayObj && !menuIsOpen) {
        target = pick(items, now);
        if (target && hudFirst(target)) target = null; // окно HUD перед оружием: курок — его кнопкам
        if (target && triggerPressed) {
          target.group.updateWorldMatrix(true, false);
          offset.copy(gripWorld).invert().multiply(target.group.matrixWorld);
          grabLocal.copy(hit).applyMatrix4(inv.copy(target.group.matrixWorld).invert());
          item = target;
          target = null;
          event = 'grab';
        }
      }
      if (item) {
        world.copy(gripWorld).multiply(offset);
        // стик вперёд/назад — ближе/дальше вдоль луча (скорость ∝ отклонению, до STICK_SPEED м/с),
        // поворот относительно руки тот же
        if (rayObj && !menuIsOpen && Math.abs(stickY) > DEAD) {
          const k = (Math.sign(stickY) * (Math.abs(stickY) - DEAD)) / (1 - DEAD); // + — стик назад (к себе)
          const t = hit.copy(grabLocal).applyMatrix4(world).sub(origin).dot(dir);
          const next = Math.min(MAX_RANGE_M, Math.max(MIN_DIST_M, t + (STICK_FORWARD_PULLS ? k : -k) * STICK_SPEED * Math.min(dt, 0.1)));
          if (next !== t) {
            step.copy(dir).transformDirection(inv.copy(gripWorld).invert()).multiplyScalar(next - t); // сдвиг в системе руки
            offset.elements[12] += step.x;
            offset.elements[13] += step.y;
            offset.elements[14] += step.z;
            world.copy(gripWorld).multiply(offset);
          }
        }
        // стик влево/вправо — вращение вокруг луча через точку захвата (до SPIN_SPEED рад/с; вправо —
        // по часовой, если смотреть вдоль луча)
        if (rayObj && !menuIsOpen && Math.abs(stickX) > DEAD) {
          const k = (Math.sign(stickX) * (Math.abs(stickX) - DEAD)) / (1 - DEAD);
          hit.copy(grabLocal).applyMatrix4(world);
          spin.makeRotationAxis(dir, k * SPIN_SPEED * Math.min(dt, 0.1));
          world.premultiply(shift.makeTranslation(-hit.x, -hit.y, -hit.z)).premultiply(spin)
            .premultiply(shift.makeTranslation(hit.x, hit.y, hit.z));
          offset.multiplyMatrices(inv.copy(gripWorld).invert(), world);
        }
        world.decompose(item.group.position, item.group.quaternion, item.group.scale);
        item.group.updateWorldMatrix(true, false);
        if (rayObj) showLine(hit.copy(grabLocal).applyMatrix4(item.group.matrixWorld));
      } else if (target) {
        showLine(hit);
      }
      const changed = target && target !== lastTarget;
      lastTarget = target;
      return event ?? (changed ? 'hover' : null);
    },
    release() {
      item = null;
    },
    hide() {
      // руки не видно: свой луч не рисуется (держимое висит, где было)
      target = null;
      line.visible = dot.visible = false;
    },
    dispose() {
      root.remove(line, dot);
      geometry.dispose();
      line.material.dispose();
      dot.geometry.dispose();
      dot.material.dispose();
    },
  };
}
