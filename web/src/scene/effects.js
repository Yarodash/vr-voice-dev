// Эффекты выстрела и попадания: вспышка, искры, дым, гильза, трассер, отблеск света.
// Живёт в сцене: правки подхватываются на лету. Дым — smoke.js (один вызов отрисовки на весь дым).
import { createSmoke } from './smoke.js';
import { createTracers } from './tracer.js';
import { createImpacts } from './impact.js';

export function createEffects({ THREE, group }) {
  const particles = [];
  const smoke = createSmoke({ THREE, group });
  const tracers = createTracers({ THREE, group });
  const impacts = createImpacts({ THREE, group });
  const up = new THREE.Vector3(0, 1, 0);

  // Один источник света на всё время: если добавлять и убирать свет при каждом выстреле, three.js
  // каждый раз пересобирает шейдеры, и игра подвисает.
  const flashLight = new THREE.PointLight(0xffb060, 0, 4, 2);
  group.add(flashLight);
  let flashUntil = 0;
  let flashPower = 0;

  const sphere = new THREE.SphereGeometry(1, 10, 8);
  const cone = new THREE.ConeGeometry(0.013, 0.16, 8);
  const unitBox = new THREE.BoxGeometry(1, 1, 1);
  const casingGeometry = new THREE.CylinderGeometry(0.0042, 0.0042, 0.019, 10);

  const random = (a, b) => a + Math.random() * (b - a);
  const scatter = (direction, spread, out) =>
    out.set(
      direction.x + random(-spread, spread),
      direction.y + random(-spread, spread),
      direction.z + random(-spread, spread),
    ).normalize();
  // временные (spawn копирует их в частицу)
  const tmpDir = new THREE.Vector3();
  const tmpTip = new THREE.Vector3();
  const tmpQ = new THREE.Quaternion();
  const tmpS0 = new THREE.Vector3();
  const tmpS1 = new THREE.Vector3(0.3, 0.25, 0.3);
  const sparkS0 = new THREE.Vector3(0.0035, 0.03, 0.0035);
  const sparkS1 = new THREE.Vector3(0.002, 0.008, 0.002);

  // Частицы рисуются пачками: InstancedMesh на каждую пару (геометрия, смешивание), цвет и
  // прозрачность — у каждого экземпляра свои. Раньше каждая частица была своим мешем: один выстрел
  // (17 частиц) — 34 вызова отрисовки на два глаза (~27 мкс CPU каждый на Quest), очередь — под сотню.
  // Теперь — не больше 4 пачек, а пустая пачка скрыта (пустой видимый меш тоже стоит CPU: программа и
  // униформы ставятся, хоть рисовать нечего). Первые WARM_FRAMES кадров пачки видны (пустые): их
  // шейдер собирается при подмене сцены, а не на первом выстреле. Записи частиц — из пула (без мусора).
  const MAX_PER_BATCH = 256;
  const WARM_FRAMES = 3;
  const batches = [];
  const batchOf = (geometry, additive) => {
    for (const b of batches) if (b.source === geometry && b.additive === additive) return b;
    const g = geometry.clone(); // своя копия: у неё свой атрибут прозрачности
    const opacity = new THREE.InstancedBufferAttribute(new Float32Array(MAX_PER_BATCH), 1);
    opacity.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('aOpacity', opacity);
    const material = new THREE.MeshBasicMaterial({
      transparent: true, depthWrite: false, blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    material.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aOpacity;\nvarying float vOpacity;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvOpacity = aOpacity;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vOpacity;')
        .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.a *= vOpacity;');
    };
    material.customProgramCacheKey = () => 'fx-particle-opacity'; // неизменный: программа общая между версиями сцены
    const mesh = new THREE.InstancedMesh(g, material, MAX_PER_BATCH);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.setColorAt(0, new THREE.Color(1, 1, 1)); // цвет экземпляров — сразу (иначе шейдер собрался бы второй раз)
    mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.name = 'fx-particles';
    group.add(mesh);
    const b = { source: geometry, additive, mesh, geometry: g, material, opacity, n: 0 };
    batches.push(b);
    return b;
  };
  // все пачки, что бывают (вспышка, пыль, лепестки, искры) — заранее, ради сборки шейдера при подмене
  batchOf(sphere, false);
  batchOf(sphere, true);
  batchOf(cone, true);
  batchOf(unitBox, true);
  let warm = 0;
  const pool = [];
  const makeParticle = () => ({
    batch: null, born: 0, life: 1, position: new THREE.Vector3(), quaternion: new THREE.Quaternion(),
    rotation: new THREE.Euler(), color: new THREE.Color(), velocity: new THREE.Vector3(), gravity: 0, drag: 0,
    scale0: new THREE.Vector3(), scale1: new THREE.Vector3(), opacity0: 1, spin: null, fadePower: 1,
  });
  const pScale = new THREE.Vector3();
  const pMatrix = new THREE.Matrix4();
  // на GPU уходят только первые n экземпляров
  const markUsed = (attr, n, size) => {
    attr.clearUpdateRanges();
    attr.addUpdateRange(0, Math.max(1, n) * size);
    attr.needsUpdate = true;
  };

  // geometry/color + движение. life — мс; scale0 → scale1 за время жизни; opacity гаснет до нуля.
  function spawn(geometry, { color, additive = false, opacity = 1 }, position, options) {
    const p = pool.pop() ?? makeParticle();
    p.batch = batchOf(geometry, additive);
    p.color.set(color);
    p.position.copy(position);
    if (options.quaternion) p.quaternion.copy(options.quaternion);
    else p.quaternion.identity();
    if (options.spin) p.rotation.setFromQuaternion(p.quaternion);
    const scale0 = options.scale0 ?? 1;
    if (scale0 instanceof THREE.Vector3) p.scale0.copy(scale0);
    else p.scale0.setScalar(scale0);
    if (options.scale1 instanceof THREE.Vector3) p.scale1.copy(options.scale1);
    else p.scale1.setScalar(options.scale1 ?? scale0);
    p.born = globalThis.__sceneState?.sceneNowMs ?? performance.now(); // сценовые часы (замедление времени)
    p.life = options.life;
    if (options.velocity) p.velocity.copy(options.velocity);
    else p.velocity.set(0, 0, 0);
    p.gravity = options.gravity ?? 0;
    p.drag = options.drag ?? 0;
    p.opacity0 = opacity;
    p.spin = options.spin ?? null;
    p.fadePower = options.fadePower ?? 1;
    particles.push(p);
  }

  return {
    // position/direction: дуло и направление ствола (мировые координаты)
    muzzleFlash(position, direction) {
      // яркое ядро и тёплое облако вокруг
      spawn(sphere, { color: 0xffffff, additive: true }, position, { life: 55, scale0: 0.028, scale1: 0.002 });
      spawn(sphere, { color: 0xff9a3c, additive: true, opacity: 0.8 }, position, { life: 90, scale0: 0.05, scale1: 0.012 });
      // лепестки пламени веером вперёд
      for (let i = 0; i < 6; i += 1) {
        const petal = scatter(direction, 0.3, tmpDir);
        tmpQ.setFromUnitVectors(up, petal);
        tmpTip.copy(position).addScaledVector(petal, 0.07);
        spawn(cone, { color: i % 2 ? 0xffd27a : 0xff7a1a, additive: true, opacity: 0.95 }, tmpTip, {
          life: 70,
          quaternion: tmpQ,
          scale0: tmpS0.set(1, random(0.8, 1.3), 1),
          scale1: tmpS1,
        });
      }
      // искры из дула
      for (let i = 0; i < 9; i += 1) {
        const dir = scatter(direction, 0.35, tmpDir);
        tmpQ.setFromUnitVectors(up, dir);
        spawn(unitBox, { color: 0xffcf6b, additive: true }, position, {
          life: random(150, 320),
          velocity: tmpTip.copy(dir).multiplyScalar(random(3, 8)),
          gravity: 6,
          quaternion: tmpQ,
          scale0: sparkS0,
          scale1: sparkS1,
        });
      }
      // клуб дыма из дула и струйка над стволом
      smoke.muzzle(position, direction);
      // отблеск света на руке и сцене
      flashLight.position.copy(position);
      flashPower = 7;
      flashUntil = (globalThis.__sceneState?.sceneNowMs ?? performance.now()) + 70;
      flashLight.intensity = flashPower;
    },

    // где дуло оружия в руке сейчас (каждый кадр) или null: от него идёт струйка дыма после выстрела
    setMuzzle(position) {
      smoke.setMuzzle(position);
    },

    // дымок из окна выброса; сама гильза — casings.js (вылетает, когда затвор отошёл назад)
    eject(position, right, up_) {
      smoke.eject(position, right, up_);
    },

    // попадание в сталь: звёздочка-вспышка, веер искр, тлеющая точка (impact.js) и пыль краски (smoke.js);
    // normal — наружу от мишени
    impact(point, normal) {
      impacts.hit(point, normal);
      smoke.impact(point, normal);
    },

    // облачко пыли (разбитая глиняная тарелка)
    dust(point) {
      smoke.impact(point, up);
      // рыжее облачко глиняной пыли
      spawn(sphere, { color: 0xe07a3c, opacity: 0.55 }, point, { life: 420, scale0: 0.05, scale1: 0.26, fadePower: 0.7 });
      spawn(sphere, { color: 0xffb27a, opacity: 0.35 }, point, { life: 260, scale0: 0.03, scale1: 0.18 });
    },

    // пуля упала в землю: облачко пыли без глиняной рыжины
    groundHit(point) {
      smoke.impact(point, up);
    },

    // след пули: раскалённая чёрточка летит от дула по параболе (tracer.js); вернёт номер для tracerLand
    // «Настройки ▸ Трассеры: выкл» (globalThis.__sceneState.tracersOff) — трассер не запускается (−1)
    tracer(from, dir, speed, gravity, maxLen) {
      if (globalThis.__sceneState?.tracersOff) return -1;
      return tracers.fire(from, dir, speed, gravity, maxLen);
    },
    // пуля номер id остановилась через along м (вдоль ствола)
    tracerLand(id, along) {
      if (id < 0) return;
      tracers.land(id, along);
    },

    update(dt) {
      smoke.update(dt);
      tracers.update(dt);
      impacts.update(dt);
      const now = globalThis.__sceneState?.sceneNowMs ?? performance.now();
      if (warm < WARM_FRAMES) warm += 1;
      if (flashUntil) {
        const left = (flashUntil - now) / 70;
        flashLight.intensity = left > 0 ? flashPower * left : 0;
        if (left <= 0) flashUntil = 0;
      }
      for (let b = 0; b < batches.length; b += 1) batches[b].n = 0;
      for (let i = particles.length - 1; i >= 0; i -= 1) {
        const p = particles[i];
        const age = (now - p.born) / p.life;
        if (age >= 1) {
          particles[i] = particles[particles.length - 1]; // порядок не важен: пачки рисуются целиком
          particles.pop();
          pool.push(p);
          continue;
        }
        if (p.drag) p.velocity.multiplyScalar(Math.max(0, 1 - p.drag * dt));
        p.velocity.y -= p.gravity * dt;
        p.position.addScaledVector(p.velocity, dt);
        pScale.lerpVectors(p.scale0, p.scale1, age);
        if (p.spin) {
          p.rotation.x += p.spin.x * dt;
          p.rotation.y += p.spin.y * dt;
          p.rotation.z += p.spin.z * dt;
          p.quaternion.setFromEuler(p.rotation);
        }
        const batch = p.batch;
        if (batch.n >= MAX_PER_BATCH) continue; // пачка полна: лишняя частица в этом кадре не видна
        const k = batch.n++;
        batch.mesh.setMatrixAt(k, pMatrix.compose(p.position, p.quaternion, pScale));
        batch.mesh.setColorAt(k, p.color);
        batch.opacity.array[k] = p.opacity0 * (1 - age ** p.fadePower);
      }
      for (let b = 0; b < batches.length; b += 1) {
        const { mesh, opacity, n } = batches[b];
        mesh.visible = n > 0 || warm < WARM_FRAMES;
        if (n === 0 && mesh.count === 0) continue;
        mesh.count = n;
        markUsed(mesh.instanceMatrix, n, 16);
        markUsed(mesh.instanceColor, n, 3);
        markUsed(opacity, n, 1);
      }
    },

    dispose() {
      for (const b of batches) {
        group.remove(b.mesh);
        b.geometry.dispose();
        b.material.dispose();
        b.mesh.dispose();
      }
      batches.length = 0;
      particles.length = 0;
      pool.length = 0;
      smoke.dispose();
      tracers.dispose();
      impacts.dispose();
      group.remove(flashLight);
      flashLight.dispose?.();
      for (const geometry of [sphere, cone, unitBox, casingGeometry]) geometry.dispose();
    },
  };
}
