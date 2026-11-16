// Гильзы: пул до 20 штук. Вылетают из окна выброса вправо-вверх, вертятся, отскакивают от земли
// (groundHeight из car.js), тихо звякают, лежат несколько секунд и уменьшаются в ноль. Живёт в сцене.
import { groundHeight } from './car.js';

const MAX = 20;
const GRAVITY = 9.8;
const REST_S = 5; // сколько лежит до исчезновения
const FADE_S = 0.8;

export function createCasings({ THREE, root, shared }) {
  const geometry = new THREE.CylinderGeometry(0.0049, 0.0049, 0.019, 10); // 9 мм; калаш крупнее (scale)
  const material = new THREE.MeshStandardMaterial({ color: 0xd9a441, roughness: 0.4, metalness: 0.3, emissive: 0x3a2a08 });
  const pool = [];
  for (let i = 0; i < MAX; i += 1) {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.visible = false;
    root.add(mesh);
    pool.push({ mesh, active: false, vx: 0, vy: 0, vz: 0, sx: 0, sy: 0, sz: 0, rest: 0, born: 0, size: 1, tinkAt: 0 });
  }
  let next = 0;
  const euler = new THREE.Euler();

  const tink = (p) => {
    try {
      shared.sound?.tink?.(p);
    } catch {
      // без звука
    }
  };

  return {
    // position — окно выброса, right/up/barrel — оси оружия в мире; big — калаш (7,62×39) или
    // число — масштаб; stretch — во сколько раз гильза ещё и длиннее (AWP, .338: 1.5 × 2.4)
    eject(position, right, up, barrel, big = false, stretch = 1) {
      let c = pool.find((x) => !x.active);
      if (!c) {
        c = pool[next];
        next = (next + 1) % MAX;
      }
      const r = 1.5 + Math.random() * 1.0;
      const u = 1.0 + Math.random() * 0.8;
      const b = Math.random() * 0.4;
      c.vx = right.x * r + up.x * u - barrel.x * b;
      c.vy = right.y * r + up.y * u - barrel.y * b;
      c.vz = right.z * r + up.z * u - barrel.z * b;
      c.sx = (Math.random() - 0.5) * 40;
      c.sy = (Math.random() - 0.5) * 40;
      c.sz = (Math.random() - 0.5) * 40;
      c.rest = 0;
      c.active = true;
      c.size = typeof big === 'number' ? big : big ? 1.9 : 1;
      c.stretch = stretch;
      c.mesh.scale.set(c.size, c.size * stretch, c.size);
      c.mesh.position.copy(position);
      c.mesh.rotation.set(Math.random() * 6, Math.random() * 6, Math.random() * 6);
      c.mesh.visible = true;
    },

    update(dtRaw) {
      const dt = Math.min(dtRaw || 0, 0.05);
      const now = shared.sceneNowMs ?? performance.now(); // сценовые часы (замедление времени)
      for (let i = 0; i < MAX; i += 1) {
        const c = pool[i];
        if (!c.active) continue;
        const m = c.mesh;
        if (c.rest > 0) {
          c.rest += dt;
          if (c.rest > REST_S) {
            const k = 1 - (c.rest - REST_S) / FADE_S;
            if (k <= 0) {
              c.active = false;
              m.visible = false;
            } else {
              m.scale.set(c.size * k, c.size * (c.stretch ?? 1) * k, c.size * k);
            }
          }
          continue;
        }
        c.vy -= GRAVITY * dt;
        m.position.x += c.vx * dt;
        m.position.y += c.vy * dt;
        m.position.z += c.vz * dt;
        m.rotation.x += c.sx * dt;
        m.rotation.y += c.sy * dt;
        m.rotation.z += c.sz * dt;
        const floor = groundHeight(m.position.x, m.position.z) + 0.005 * c.size;
        if (m.position.y < floor) {
          m.position.y = floor;
          const impact = -c.vy;
          if (impact > 0.7 && now - c.tinkAt > 60) {
            c.tinkAt = now;
            tink(m.position);
          }
          c.vy = impact * 0.35;
          c.vx *= 0.6;
          c.vz *= 0.6;
          c.sx *= 0.5;
          c.sy *= 0.5;
          c.sz *= 0.5;
          if (impact < 0.9 && c.vx * c.vx + c.vz * c.vz < 0.04) {
            // улеглась на бок: ось гильзы горизонтальна
            c.rest = 0.001;
            m.rotation.copy(euler.set(Math.PI / 2, 0, Math.random() * 6.28));
            m.position.y = floor;
          }
        }
      }
    },

    dispose() {
      for (const c of pool) root.remove(c.mesh);
      geometry.dispose();
      material.dispose();
    },
  };
}
