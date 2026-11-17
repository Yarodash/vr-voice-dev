// Глиняные тарелочки (вид предмета 'plate'). Живёт в сцене: правки подхватываются на лету.
//
// Тарелку спавнят из меню («Заспавнить тарелку») или кнопкой X прямо у руки, берут курком (или
// хватом, как оружие); взятая курком сразу готова к броску. Пока
// тарелка в руке, курок не стреляет, а «взводит» бросок: зажал курок и махнул — когда рука на взмахе
// начинает тормозить (скорость упала ниже RELEASE_DROP от пика), тарелка срывается и летит со
// скоростью руки × THROW_GAIN, вращаясь вокруг своей оси (баллистика, лёгкое сопротивление воздуха,
// чуть-чуть подъёмной силы, держится плашмя с лёгким покачиванием). Во что-то попала — разбивается:
// оранжевые осколки с физикой, облачко пыли, звук бьющейся глины. Мишень, в которую попала тарелка,
// получает попадание как от пули (звон, сбивается, если физика мишеней включена). Летящие и
// лежащие (висящие) тарелки можно сбить из оружия.
//
// Дёшево: все тарелки — один InstancedMesh, все осколки — второй, обводка «можно взять» — один меш.
// Без выделений памяти в кадре. Состояние переживает подмену сцены (globalThis.__sceneState.clays),
// висящие тарелки — и перезагрузку страницы (localStorage).
import { groundAt } from './targets.js';

const STORE_KEY = 'scene.clays';
const MAX_CLAYS = 40; // больше — самая старая висящая исчезает
const SCALE_R = 2; // тарелка вдвое шире настоящей (диаметр 22 см) — легче попасть и видно издалека
const SCALE_Y = 1.5; // и в полтора раза выше
const H = 0.025 * SCALE_Y; // высота
const MID = 0.012 * SCALE_Y; // центр тарелки над её дном
const REACH = 0.16; // как далеко от руки можно взять

const THROW_GAIN = 4.5; // скорость тарелки = скорость руки × это (одной кистью легко добросить до 10 м)
const MIN_PEAK = 0.8; // м/с: медленнее — это не взмах
const RELEASE_DROP = 0.85; // рука затормозила до этой доли пика — отпускаем
const SPIN = 22; // рад/с вокруг своей оси
const GRAVITY = 9.81;
const DRAG = 0.0045; // квадратичное сопротивление, 1/м
const LIFT = 0.009; // подъёмная сила ~ скорость², пока тарелка плашмя
const LIFT_MAX = 3.5; // м/с², не больше
const LEVEL_RATE = 1.6; // 1/с: как быстро наклон в полёте уходит к горизонтали
const MAX_FLIGHT = 20; // с

const MAX_SHARDS = 256; // хватит на залп из ~20 тарелок разом
const SOUND_BURST = 6; // не больше стольких звуков разбития (и звона мишеней) за SOUND_WINDOW мс
const SOUND_WINDOW = 80;
const SHARD_LIFE = [3, 5]; // с
const SHARD_FADE = 0.6; // последние секунды осколок уменьшается до нуля

export function createClays({ THREE, root, shooting, camera }) {
  const shared = (globalThis.__sceneState ??= {});
  const sound = () => shared.sound;
  const UP = new THREE.Vector3(0, 1, 0);

  // ---- модель: купол с ободом (токарный профиль от центра дна наружу к ободу и вверх к макушке)
  const profile = [
    [0, 0.012], [0.03, 0.011], [0.046, 0.006], [0.05, 0.0005], [0.0545, 0], [0.055, 0.003],
    [0.054, 0.007], [0.05, 0.0105], [0.045, 0.0145], [0.038, 0.0185], [0.028, 0.0222], [0.016, 0.0243], [0, 0.025],
  ].map(([r, y]) => [r * SCALE_R, y * SCALE_Y]);
  const UNDER = 4; // первые точки профиля — дно (темнее)
  const clayGeometry = new THREE.LatheGeometry(profile.map(([r, y]) => new THREE.Vector2(r, y)), 24);
  clayGeometry.translate(0, -MID, 0);
  {
    const colors = new Float32Array(clayGeometry.attributes.position.count * 3);
    const orange = new THREE.Color(0xf26419);
    const under = new THREE.Color(0x7a2e0c);
    const ring = new THREE.Color(0xb8440c);
    for (let k = 0; k < clayGeometry.attributes.position.count; k += 1) {
      const j = k % profile.length;
      // дно тёмное, ободок и кольцо у макушки чуть темнее (рёбра настоящей тарелочки)
      const c = j < UNDER ? under : j === 6 || j === 7 || j === 10 ? ring : orange;
      colors.set([c.r, c.g, c.b], k * 3);
    }
    clayGeometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  }
  const clayMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0 });
  const clayMesh = new THREE.InstancedMesh(clayGeometry, clayMaterial, MAX_CLAYS);
  clayMesh.name = 'clays';
  clayMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  clayMesh.frustumCulled = false;
  clayMesh.count = 0;
  root.add(clayMesh);
  let clayWarm = 0; // кадров после создания (update: пустой меш скрыт)

  // белая обводка у тарелки, которую можно взять
  const outlineMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.BackSide });
  const outline = new THREE.Mesh(clayGeometry, outlineMaterial);
  outline.matrixAutoUpdate = false;
  outline.visible = false;
  root.add(outline);

  // ---- осколки: плоские треугольные кусочки, оранжевые и тёмные (дно)
  const shardShape = new THREE.Shape([new THREE.Vector2(-0.019, -0.012), new THREE.Vector2(0.022, -0.009), new THREE.Vector2(0.002, 0.02)]);
  const shardGeometry = new THREE.ExtrudeGeometry(shardShape, { depth: 0.005, bevelEnabled: false });
  shardGeometry.translate(0, 0, -0.0025);
  // чуть светятся сами: в сумерках осколки не теряются в траве
  const shardMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, metalness: 0, emissive: 0x6a2406 });
  const shardMesh = new THREE.InstancedMesh(shardGeometry, shardMaterial, MAX_SHARDS);
  shardMesh.name = 'clay-shards';
  shardMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  shardMesh.frustumCulled = false;
  const zero = new THREE.Matrix4().makeScale(0, 0, 0);
  const shardOrange = new THREE.Color(0xf26419);
  const shardDark = new THREE.Color(0x6b280b);
  for (let i = 0; i < MAX_SHARDS; i += 1) {
    shardMesh.setMatrixAt(i, zero);
    shardMesh.setColorAt(i, shardOrange);
  }
  shardMesh.visible = false;
  root.add(shardMesh);
  const shards = [];
  for (let i = 0; i < MAX_SHARDS; i += 1) {
    shards.push({ alive: false, p: new THREE.Vector3(), v: new THREE.Vector3(), q: new THREE.Quaternion(), w: new THREE.Vector3(), age: 0, life: 1, size: 1, rest: false });
  }
  let nextShard = 0;

  // ---- тарелки: { state: 'rest' | 'held' | 'fly', p, q, v, axis, wob, angle, spin, age }
  const newClay = () => ({
    state: 'rest',
    p: new THREE.Vector3(),
    q: new THREE.Quaternion(),
    v: new THREE.Vector3(),
    axis: new THREE.Vector3(0, 1, 0),
    wob: new THREE.Vector3(1, 0, 0),
    angle: 0,
    spin: 0,
    age: 0,
  });
  let list = shared.clays;
  if (!Array.isArray(list)) {
    list = [];
    try {
      const saved = JSON.parse(localStorage.getItem(STORE_KEY));
      for (const { p, q } of Array.isArray(saved) ? saved : []) {
        const clay = newClay();
        clay.p.fromArray(p);
        clay.q.fromArray(q);
        list.push(clay);
      }
    } catch {
      // нет сохранённых
    }
    shared.clays = list;
  }
  // после перезагрузки «в руке» не бывает: такие просто висят
  let dirty = true;

  const persist = () => {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(list.filter((c) => c.state !== 'fly').map((c) => ({ p: c.p.toArray(), q: c.q.toArray() }))));
    } catch {
      // без хранилища тарелки не переживут перезагрузку
    }
  };

  const removeAt = (index) => {
    list.splice(index, 1);
    dirty = true;
  };

  // ---- осколки и звук: тарелка разбилась в point; velocity — её скорость (или направление удара)
  const tmp = new THREE.Vector3();
  const tmpQ = new THREE.Quaternion();
  const tmpE = new THREE.Euler();
  // залп: десятки звуков в один кадр — лишь подвисание на Quest; звучат первые SOUND_BURST
  let soundWindowAt = -1e9;
  let soundCount = 0;
  const soundOk = () => {
    const now = performance.now();
    if (now - soundWindowAt > SOUND_WINDOW) {
      soundWindowAt = now;
      soundCount = 0;
    }
    soundCount += 1;
    return soundCount <= SOUND_BURST;
  };
  const breakAt = (point, velocity) => {
    const count = 10 + Math.floor(Math.random() * 5);
    for (let k = 0; k < count; k += 1) {
      const index = nextShard;
      const s = shards[index];
      nextShard = (nextShard + 1) % MAX_SHARDS;
      s.alive = true;
      s.rest = false;
      s.age = 0;
      s.life = SHARD_LIFE[0] + Math.random() * (SHARD_LIFE[1] - SHARD_LIFE[0]);
      s.size = 0.9 + Math.random() * 1.1;
      s.p.copy(point).addScaledVector(tmp.randomDirection(), 0.04);
      s.v.copy(velocity).multiplyScalar(0.3);
      s.v.addScaledVector(tmp.randomDirection(), 1.2 + Math.random() * 2.4);
      s.v.y += 0.8 + Math.random() * 1.5;
      s.q.setFromEuler(tmpE.set(Math.random() * 6.3, Math.random() * 6.3, Math.random() * 6.3));
      s.w.randomDirection().multiplyScalar(8 + Math.random() * 20);
      shardMesh.setColorAt(index, Math.random() < 0.3 ? shardDark : shardOrange);
    }
    shardMesh.instanceColor.needsUpdate = true;
    shardMesh.visible = true;
    if (soundOk()) sound()?.shatter?.(point);
    shooting?.puff?.(point);
  };

  const shatter = (clay, point, velocity) => {
    const index = list.indexOf(clay);
    if (index < 0) return;
    breakAt(point, velocity);
    removeAt(index);
    persist();
  };

  // ---- пули: летящие и висящие тарелки (не в руке) — шар радиуса HIT_R
  const HIT_R = 0.14;
  let rayClay = null;
  const rayHit = new THREE.Vector3();
  const rayVel = new THREE.Vector3();
  shooting?.setClayTarget?.({
    cast(origin, dir, far) {
      let best = -1;
      rayClay = null;
      for (const clay of list) {
        if (clay.state === 'held') continue;
        tmp.subVectors(clay.p, origin);
        const t = tmp.dot(dir);
        if (t < 0 || t > far) continue;
        if (tmp.lengthSq() - t * t > HIT_R * HIT_R) continue;
        if (best < 0 || t < best) {
          best = t;
          rayClay = clay;
        }
      }
      return best;
    },
    hit(origin, dir, distance) {
      if (!rayClay) return;
      rayHit.copy(origin).addScaledVector(dir, distance);
      rayVel.copy(rayClay.v).addScaledVector(dir, 2.5);
      shatter(rayClay, rayHit, rayVel);
      rayClay = null;
    },
    // автонаводка (shooting.js searchLock): летящие тарелки, центр и скорость
    aimTargets(visit) {
      for (let i = 0; i < list.length; i += 1) {
        const clay = list[i];
        if (clay.state === 'fly') visit(clay.p, clay.v.x, clay.v.y, clay.v.z, clay);
      }
    },
  });

  // ---- скорость руки: разность положений за HISTORY кадров (сглаживает дрожь)
  const HISTORY = 4; // при 72–90 Гц ≈ 40 мс: пик кисти не размазывается
  const hist = [];
  for (let i = 0; i < HISTORY; i += 1) hist.push({ p: new THREE.Vector3(), t: 0 });
  let histCount = 0;
  let histHead = 0;
  let clock = 0;
  const handVelocity = new THREE.Vector3();
  const peakVelocity = new THREE.Vector3();
  let peak = 0;
  let wasArmed = false;

  const matrix = new THREE.Matrix4();
  const one = new THREE.Vector3(1, 1, 1);
  const grow = new THREE.Vector3();
  const align = new THREE.Quaternion();
  const turn = new THREE.Quaternion();
  const from = new THREE.Vector3();
  const tilted = new THREE.Vector3();
  const nearCenter = new THREE.Vector3();
  const side = new THREE.Vector3();
  const edgeFrom = new THREE.Vector3();
  const edgeTo = new THREE.Vector3();
  const EDGE = 0.085; // м от центра: почти край
  const SIGNS = [1, -1];
  const flatForward = new THREE.Vector3();
  const FORWARD_MIN = 0.3; // м/с вперёд по горизонтали — меньше: это не бросок вперёд

  const api = {
    list,
    // новая висящая тарелка: position/quaternion (мировые)
    spawn(position, quaternion) {
      while (list.length >= MAX_CLAYS) {
        const old = list.findIndex((c) => c.state === 'rest');
        if (old < 0) break;
        removeAt(old);
      }
      if (list.length >= MAX_CLAYS) return null;
      const clay = newClay();
      clay.p.copy(position);
      clay.q.copy(quaternion);
      list.push(clay);
      dirty = true;
      persist();
      return clay;
    },
    held() {
      return list.find((c) => c.state === 'held') ?? null;
    },
    // все тарелки разом (сцены, compositions.js): [{ p, q }] — висящие; [] — ни одной
    setAll(poses) {
      list.length = 0;
      for (const { p, q } of poses ?? []) {
        const clay = newClay();
        clay.p.fromArray(p);
        clay.q.fromArray(q);
        list.push(clay);
      }
      outline.visible = false;
      dirty = true;
      persist();
    },
    // ближайшая к pos тарелка (не летящая), ближе maxDist (по умолчанию REACH)
    nearest(pos, maxDist = REACH) {
      let found = null;
      let best = maxDist;
      for (const clay of list) {
        if (clay.state !== 'rest') continue;
        const d = clay.p.distanceTo(pos);
        if (d < best) {
          best = d;
          found = clay;
        }
      }
      return found;
    },
    grab(clay) {
      clay.state = 'held';
      clay.v.set(0, 0, 0);
      peak = 0;
    },
    drop(clay) {
      clay.state = 'rest';
      clay.v.set(0, 0, 0);
      dirty = true;
      persist();
    },
    remove(clay) {
      const index = list.indexOf(clay);
      if (index >= 0) removeAt(index);
      persist();
    },
    // положение тарелки в руке (мировая матрица)
    place(clay, worldMatrix) {
      worldMatrix.decompose(clay.p, clay.q, grow);
      dirty = true;
    },
    // бросок: velocity — мировая скорость, м/с
    launch(clay, velocity, spin = SPIN) {
      clay.state = 'fly';
      clay.v.copy(velocity);
      clay.axis.set(0, 1, 0).applyQuaternion(clay.q);
      if (clay.axis.y < 0) clay.axis.negate(); // перевёрнутая всё равно летит «куполом вверх»
      clay.wob.crossVectors(clay.axis, velocity).normalize();
      if (clay.wob.lengthSq() < 0.5) clay.wob.set(1, 0, 0);
      clay.angle = 0;
      clay.spin = spin;
      clay.age = 0;
      dirty = true;
      persist();
    },
    // Каждый кадр, пока известна рука: handPosition (мировая), triggerDown. Если в руке тарелка и курок
    // зажат, ловит пик скорости взмаха и бросает. Возвращает брошенную тарелку или null.
    // headForward — куда смотрит голова (мировое): тарелка летит только вперёд от игрока; замах назад
    // и его торможение бросок не запускают.
    updateHand(handPosition, dt, triggerDown, headForward = null) {
      clock += dt;
      const slot = hist[histHead];
      slot.p.copy(handPosition);
      slot.t = clock;
      const oldest = hist[(histHead + HISTORY - Math.min(histCount, HISTORY - 1)) % HISTORY];
      histHead = (histHead + 1) % HISTORY;
      histCount = Math.min(histCount + 1, HISTORY);
      const span = clock - oldest.t;
      if (span > 1e-4) handVelocity.subVectors(handPosition, oldest.p).divideScalar(span);
      else handVelocity.set(0, 0, 0);

      const clay = api.held();
      const armed = Boolean(clay && triggerDown);
      if (armed && !wasArmed) peak = 0;
      wasArmed = armed;
      if (!armed) return null;
      const speed = handVelocity.length();
      if (headForward) {
        // по горизонтали рука должна идти вперёд (запас FORWARD_MIN м/с), иначе взмах не считается
        flatForward.set(headForward.x, 0, headForward.z);
        const len = flatForward.length();
        const ahead = len > 1e-3 ? (handVelocity.x * flatForward.x + handVelocity.z * flatForward.z) / len : 1;
        if (ahead < FORWARD_MIN) {
          // не вперёд: замах назад не бросает; но если был взмах вперёд и рука резко встала — бросок
          if (peak < MIN_PEAK) {
            peak = 0;
            return null;
          }
          return api.release(clay);
        }
      }
      if (speed > peak) {
        peak = speed;
        peakVelocity.copy(handVelocity);
        return null;
      }
      if (peak < MIN_PEAK || speed > peak * RELEASE_DROP) return null;
      return api.release(clay);
    },
    // бросок со скоростью пика взмаха (peakVelocity записан только при движении вперёд)
    release(clay) {
      console.log(`[clay] бросок: рука ${peak.toFixed(1)} м/с → тарелка ${(peak * THROW_GAIN).toFixed(1)} м/с`);
      peakVelocity.multiplyScalar(THROW_GAIN);
      api.launch(clay, peakVelocity);
      peak = 0;
      return clay;
    },
    handSpeed: () => handVelocity.length(),
    setNear(clay) {
      if (!clay) {
        outline.visible = false;
        return;
      }
      outline.visible = true;
      nearCenter.copy(clay.p);
      outline.matrix.compose(nearCenter, clay.q, grow.setScalar(1.14));
    },
    // ручка для npm run vr:eval: бросить тарелку номер index с такой скоростью
    debugThrow(index, vx, vy, vz) {
      const clay = list[index];
      if (!clay) return false;
      api.launch(clay, tmp.set(vx, vy, vz));
      return true;
    },
    update(dt) {
      const h = Math.min(dt, 0.05);
      for (let i = list.length - 1; i >= 0; i -= 1) {
        const clay = list[i];
        if (clay.state !== 'fly') continue;
        clay.age += h;
        from.copy(clay.p);
        const speed = clay.v.length();
        // сопротивление, подъёмная сила (пока плашмя), гравитация
        clay.v.multiplyScalar(Math.max(0, 1 - DRAG * speed * h));
        const lift = Math.min(LIFT_MAX, LIFT * speed * speed) * Math.max(0, clay.axis.y) ** 2;
        clay.v.y += (lift - GRAVITY) * h;
        clay.p.addScaledVector(clay.v, h);
        // плашмя: наклон уходит к горизонтали, сверху — лёгкое покачивание
        clay.axis.lerp(UP, 1 - Math.exp(-LEVEL_RATE * h)).normalize();
        clay.angle += clay.spin * h;
        tilted.copy(clay.axis).addScaledVector(clay.wob, 0.07 * Math.sin(clay.age * 13)).normalize();
        align.setFromUnitVectors(UP, tilted);
        clay.q.copy(align).multiply(turn.setFromAxisAngle(UP, clay.angle));
        dirty = true;

        // мишени и стойки на пути за кадр
        // центр и оба края тарелки (поперёк полёта): широкая тарелка задевает мишень и краем
        let hit = shooting?.castSegment?.(from, clay.p);
        if (!hit && shooting?.castSegment) {
          side.crossVectors(clay.v, UP);
          if (side.lengthSq() > 1e-6) {
            side.normalize().multiplyScalar(EDGE);
            for (const sign of SIGNS) {
              hit = shooting.castSegment(edgeFrom.copy(from).addScaledVector(side, sign), edgeTo.copy(clay.p).addScaledVector(side, sign));
              if (hit) break;
            }
          }
        }
        if (hit) {
          if (hit.target) shooting.hitTarget(hit.target, hit.point, tmp.copy(clay.v).normalize(), !soundOk());
          shatter(clay, hit.point, clay.v);
          continue;
        }
        const ground = groundAt(clay.p.x, clay.p.z);
        if (clay.p.y - MID * 0.5 <= ground) {
          clay.p.y = ground + 0.01;
          shatter(clay, clay.p, clay.v);
          continue;
        }
        if (clay.age > MAX_FLIGHT) shatter(clay, clay.p, clay.v);
      }

      if (dirty) {
        for (let i = 0; i < list.length; i += 1) {
          matrix.compose(list[i].p, list[i].q, one);
          clayMesh.setMatrixAt(i, matrix);
        }
        clayMesh.count = list.length;
        clayMesh.instanceMatrix.needsUpdate = true;
        dirty = false;
      }
      // пустой видимый меш тоже стоит CPU (программа и униформы на каждый глаз): скрыт, пока тарелок
      // нет; первые кадры виден — шейдер собирается при подмене сцены (материал держит программу)
      if (clayWarm < 3) clayWarm += 1;
      clayMesh.visible = clayMesh.count > 0 || clayWarm < 3;

      // осколки: гравитация, отскок от земли с трением, в конце жизни уменьшаются
      if (!shardMesh.visible) return;
      let any = false;
      for (let i = 0; i < MAX_SHARDS; i += 1) {
        const s = shards[i];
        if (!s.alive) continue;
        s.age += h;
        if (s.age >= s.life) {
          s.alive = false;
          shardMesh.setMatrixAt(i, zero);
          continue;
        }
        any = true;
        if (!s.rest) {
          s.v.y -= GRAVITY * h;
          s.p.addScaledVector(s.v, h);
          const w = s.w.length();
          if (w > 1e-3) s.q.premultiply(tmpQ.setFromAxisAngle(tmp.copy(s.w).divideScalar(w), w * h));
          const ground = groundAt(s.p.x, s.p.z) + 0.002;
          if (s.p.y < ground) {
            s.p.y = ground;
            if (s.v.y < -0.6) {
              s.v.y *= -0.3;
              s.v.x *= 0.55;
              s.v.z *= 0.55;
              s.w.multiplyScalar(0.5);
            } else {
              // лёг: плашмя на траву
              s.rest = true;
              s.v.set(0, 0, 0);
              tmpE.setFromQuaternion(s.q, 'YXZ');
              s.q.setFromEuler(tmpE.set(Math.PI / 2, tmpE.y, 0, 'YXZ'));
            }
          }
        }
        const left = s.life - s.age;
        const scale = s.size * (left < SHARD_FADE ? left / SHARD_FADE : 1);
        matrix.compose(s.p, s.q, grow.setScalar(scale));
        shardMesh.setMatrixAt(i, matrix);
      }
      shardMesh.instanceMatrix.needsUpdate = true;
      if (!any) shardMesh.visible = false;
    },
    dispose() {
      persist();
      shooting?.setClayTarget?.(null);
      for (const mesh of [clayMesh, outline, shardMesh]) root.remove(mesh);
      clayMesh.dispose();
      shardMesh.dispose();
      clayGeometry.dispose();
      shardGeometry.dispose();
      clayMaterial.dispose();
      outlineMaterial.dispose();
      shardMaterial.dispose();
    },
  };
  return api;
}
