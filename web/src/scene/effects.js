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

  // Частицы — из пула: меш и материал не создаются и не освобождаются на каждый выстрел. Иначе
  // (было так) после паузы > 0,3 с между выстрелами все материалы вспышки освобождались, three.js
  // выбрасывал их шейдерную программу, и следующий выстрел заново собирал её (~10 мс на Quest), плюс
  // 17 новых материалов и мешей — мусор для GC. Свободные частицы остаются в группе, невидимые.
  const pool = [];
  const makeParticle = () => {
    const material = new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false });
    const mesh = new THREE.Mesh(sphere, material);
    mesh.visible = false;
    group.add(mesh);
    return {
      mesh, material, born: 0, life: 1, velocity: new THREE.Vector3(), gravity: 0, drag: 0,
      scale0: new THREE.Vector3(), scale1: new THREE.Vector3(), opacity0: 1, spin: null, fadePower: 1,
    };
  };
  // первые кадры одна частица видна (прозрачная, крошечная): шейдер собирается сразу при подмене
  // сцены, а не на первом выстреле
  const warmParticle = makeParticle();
  warmParticle.material.opacity = 0;
  warmParticle.mesh.scale.setScalar(1e-4);
  warmParticle.mesh.frustumCulled = false;
  warmParticle.mesh.visible = true;
  let warm = 0;

  // geometry/color + движение. life — мс; scale0 → scale1 за время жизни; opacity гаснет до нуля.
  function spawn(geometry, { color, additive = false, opacity = 1 }, position, options) {
    const p = pool.pop() ?? makeParticle();
    const { mesh, material } = p;
    material.color.set(color);
    material.opacity = opacity;
    material.blending = additive ? THREE.AdditiveBlending : THREE.NormalBlending;
    mesh.geometry = geometry;
    mesh.position.copy(position);
    if (options.quaternion) mesh.quaternion.copy(options.quaternion);
    else mesh.quaternion.identity();
    const scale0 = options.scale0 ?? 1;
    if (scale0 instanceof THREE.Vector3) p.scale0.copy(scale0);
    else p.scale0.setScalar(scale0);
    mesh.scale.copy(p.scale0);
    if (options.scale1 instanceof THREE.Vector3) p.scale1.copy(options.scale1);
    else p.scale1.setScalar(options.scale1 ?? scale0);
    mesh.visible = true;
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
    tracer(from, dir, speed, gravity, maxLen) {
      return tracers.fire(from, dir, speed, gravity, maxLen);
    },
    // пуля номер id остановилась через along м (вдоль ствола)
    tracerLand(id, along) {
      tracers.land(id, along);
    },

    update(dt) {
      smoke.update(dt);
      tracers.update(dt);
      impacts.update(dt);
      const now = globalThis.__sceneState?.sceneNowMs ?? performance.now();
      if (warm < 3 && ++warm === 3) {
        warmParticle.mesh.visible = false;
        warmParticle.mesh.frustumCulled = true;
        pool.push(warmParticle);
      }
      if (flashUntil) {
        const left = (flashUntil - now) / 70;
        flashLight.intensity = left > 0 ? flashPower * left : 0;
        if (left <= 0) flashUntil = 0;
      }
      for (let i = particles.length - 1; i >= 0; i -= 1) {
        const p = particles[i];
        const age = (now - p.born) / p.life;
        if (age >= 1) {
          p.mesh.visible = false;
          particles.splice(i, 1);
          pool.push(p);
          continue;
        }
        if (p.drag) p.velocity.multiplyScalar(Math.max(0, 1 - p.drag * dt));
        p.velocity.y -= p.gravity * dt;
        p.mesh.position.addScaledVector(p.velocity, dt);
        p.mesh.scale.lerpVectors(p.scale0, p.scale1, age);
        if (p.spin) {
          p.mesh.rotation.x += p.spin.x * dt;
          p.mesh.rotation.y += p.spin.y * dt;
          p.mesh.rotation.z += p.spin.z * dt;
        }
        p.material.opacity = p.opacity0 * (1 - age ** p.fadePower);
      }
    },

    dispose() {
      for (const p of [...particles, ...pool]) {
        group.remove(p.mesh);
        p.material.dispose();
      }
      if (warm < 3) {
        group.remove(warmParticle.mesh);
        warmParticle.material.dispose();
      }
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
