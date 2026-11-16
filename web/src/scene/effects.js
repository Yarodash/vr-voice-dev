// Эффекты выстрела и попадания: вспышка, искры, дым, гильза, трассер, отблеск света.
// Живёт в сцене: правки подхватываются на лету. Дым — smoke.js (один вызов отрисовки на весь дым).
import { createSmoke } from './smoke.js';
import { createTracers } from './tracer.js';

export function createEffects({ THREE, group }) {
  const particles = [];
  const smoke = createSmoke({ THREE, group });
  const tracers = createTracers({ THREE, group });
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
  const scatter = (direction, spread) =>
    new THREE.Vector3(
      direction.x + random(-spread, spread),
      direction.y + random(-spread, spread),
      direction.z + random(-spread, spread),
    ).normalize();

  // geometry/color + движение. life — мс; scale0 → scale1 за время жизни; opacity гаснет до нуля.
  function spawn(geometry, { color, additive = false, opacity = 1 }, position, options) {
    const material = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.copy(position);
    if (options.quaternion) mesh.quaternion.copy(options.quaternion);
    const scale0 = options.scale0 ?? 1;
    mesh.scale.copy(scale0 instanceof THREE.Vector3 ? scale0 : new THREE.Vector3(scale0, scale0, scale0));
    group.add(mesh);
    particles.push({
      mesh,
      material,
      born: performance.now(),
      life: options.life,
      velocity: options.velocity ?? new THREE.Vector3(),
      gravity: options.gravity ?? 0,
      drag: options.drag ?? 0,
      scale0: mesh.scale.clone(),
      scale1: options.scale1 instanceof THREE.Vector3 ? options.scale1 : new THREE.Vector3().setScalar(options.scale1 ?? scale0),
      opacity0: opacity,
      spin: options.spin ?? null,
      fadePower: options.fadePower ?? 1,
    });
  }

  return {
    // position/direction: дуло и направление ствола (мировые координаты)
    muzzleFlash(position, direction) {
      const orient = new THREE.Quaternion().setFromUnitVectors(up, direction);
      // яркое ядро и тёплое облако вокруг
      spawn(sphere, { color: 0xffffff, additive: true }, position, { life: 55, scale0: 0.028, scale1: 0.002 });
      spawn(sphere, { color: 0xff9a3c, additive: true, opacity: 0.8 }, position, { life: 90, scale0: 0.05, scale1: 0.012 });
      // лепестки пламени веером вперёд
      for (let i = 0; i < 6; i += 1) {
        const petal = scatter(direction, 0.3);
        const q = new THREE.Quaternion().setFromUnitVectors(up, petal);
        const tip = position.clone().addScaledVector(petal, 0.07);
        spawn(cone, { color: i % 2 ? 0xffd27a : 0xff7a1a, additive: true, opacity: 0.95 }, tip, {
          life: 70,
          quaternion: q,
          scale0: new THREE.Vector3(1, random(0.8, 1.3), 1),
          scale1: new THREE.Vector3(0.3, 0.25, 0.3),
        });
      }
      // искры из дула
      for (let i = 0; i < 9; i += 1) {
        const v = scatter(direction, 0.35).multiplyScalar(random(3, 8));
        const q = new THREE.Quaternion().setFromUnitVectors(up, v.clone().normalize());
        spawn(unitBox, { color: 0xffcf6b, additive: true }, position, {
          life: random(150, 320),
          velocity: v,
          gravity: 6,
          quaternion: q,
          scale0: new THREE.Vector3(0.0035, 0.03, 0.0035),
          scale1: new THREE.Vector3(0.002, 0.008, 0.002),
        });
      }
      // клуб дыма из дула и струйка над стволом
      smoke.muzzle(position, direction);
      // отблеск света на руке и сцене
      flashLight.position.copy(position);
      flashPower = 7;
      flashUntil = performance.now() + 70;
      flashLight.intensity = flashPower;
    },

    // где дуло оружия в руке сейчас (каждый кадр) или null: от него идёт струйка дыма после выстрела
    setMuzzle(position) {
      smoke.setMuzzle(position);
    },

    // гильза вылетает вправо и вверх, вертится и падает
    eject(position, right, up_) {
      smoke.eject(position, right, up_);
      const v = right.clone().multiplyScalar(random(1.4, 2.2)).addScaledVector(up_, random(1.2, 2)).add(new THREE.Vector3(0, 0, random(0.2, 0.6)));
      spawn(casingGeometry, { color: 0xd9a441 }, position, {
        life: 1100,
        velocity: v,
        gravity: 9.8,
        scale0: 1,
        scale1: 1,
        spin: new THREE.Vector3(random(-18, 18), random(-18, 18), random(-18, 18)),
        fadePower: 8, // почти не тает до самого конца
      });
    },

    // искры, вспышка и пыль в точке попадания; normal — наружу от мишени
    impact(point, normal) {
      spawn(sphere, { color: 0xffffff, additive: true }, point, { life: 70, scale0: 0.05, scale1: 0.005 });
      spawn(sphere, { color: 0xffa24a, additive: true, opacity: 0.7 }, point, { life: 130, scale0: 0.03, scale1: 0.12 });
      for (let i = 0; i < 16; i += 1) {
        const v = scatter(normal, 0.8).multiplyScalar(random(1.5, 6));
        const q = new THREE.Quaternion().setFromUnitVectors(up, v.clone().normalize());
        spawn(unitBox, { color: i % 3 ? 0xffd27a : 0xffffff, additive: true }, point, {
          life: random(220, 520),
          velocity: v,
          gravity: 7,
          quaternion: q,
          scale0: new THREE.Vector3(0.003, 0.028, 0.003),
          scale1: new THREE.Vector3(0.0015, 0.008, 0.0015),
        });
      }
      smoke.impact(point, normal);
    },

    // облачко пыли (разбитая глиняная тарелка)
    dust(point) {
      smoke.impact(point, up);
      // рыжее облачко глиняной пыли
      spawn(sphere, { color: 0xe07a3c, opacity: 0.55 }, point, { life: 420, scale0: 0.05, scale1: 0.26, fadePower: 0.7 });
      spawn(sphere, { color: 0xffb27a, opacity: 0.35 }, point, { life: 260, scale0: 0.03, scale1: 0.18 });
    },

    // след пули: короткая раскалённая чёрточка летит от дула к цели (tracer.js)
    tracer(from, to) {
      tracers.fire(from, to);
    },

    update(dt) {
      smoke.update(dt);
      tracers.update(dt);
      const now = performance.now();
      if (flashUntil) {
        const left = (flashUntil - now) / 70;
        flashLight.intensity = left > 0 ? flashPower * left : 0;
        if (left <= 0) flashUntil = 0;
      }
      for (let i = particles.length - 1; i >= 0; i -= 1) {
        const p = particles[i];
        const age = (now - p.born) / p.life;
        if (age >= 1) {
          group.remove(p.mesh);
          p.material.dispose();
          particles.splice(i, 1);
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
      for (const p of particles) {
        group.remove(p.mesh);
        p.material.dispose();
      }
      particles.length = 0;
      smoke.dispose();
      tracers.dispose();
      group.remove(flashLight);
      flashLight.dispose?.();
      for (const geometry of [sphere, cone, unitBox, casingGeometry]) geometry.dispose();
    },
  };
}
