// Урон по области — один вызов для любого снаряда, взрыва или удара (projectiles/*, artillery.js strike).
//
// areaDamage(point, radius, maxDamage, { credit = 'player', allies = false, push = 1 }) →
//   { dogs, drones, kills } — сколько задето и убито.
//   point — мировая точка ({ x, y, z }); урон падает от maxDamage в центре до 1 на краю радиуса
//   (псы — по квадрату, коптеры — линейно); мёртвых псов только подбрасывает.
//   credit: 'player' — это урон игрока: хитмаркер, «клац», очки и деньги (kill-confirm.js → money.js);
//           null — чужой урон (артиллерия, NPC): без маркеров и денег.
//   allies: true — задевает и своих (по умолчанию свои не ранятся).
//   push — сила толчка (0 — без толчка).
// Ставится в __sceneState.areaDamage (shooting.js) — так её зовут модули без импорта.
// Скретч-векторы создаются один раз; каждый пёс и коптер — в try/catch (сломанный не ломает взрыв).

export function createAreaDamage(THREE) {
  const shared = (globalThis.__sceneState ??= {});
  const C = new THREE.Vector3();
  const D = new THREE.Vector3();
  const P = new THREE.Vector3();
  const out = { dogs: 0, drones: 0, kills: 0 };

  return function areaDamage(point, radius, maxDamage, { credit = 'player', allies = false, push = 1 } = {}) {
    out.dogs = 0;
    out.drones = 0;
    out.kills = 0;
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y) || !Number.isFinite(point.z) || !(radius > 0)) return out;
    P.set(point.x, point.y, point.z);
    const kc = credit === 'player' ? shared.killConfirm : null;
    const maxD = Math.max(1, maxDamage || 1);

    let units = null;
    try {
      units = shared.horde?.debug?.units?.() ?? null;
    } catch {
      units = null;
    }
    if (units) {
      for (let i = 0; i < units.length; i += 1) {
        const u = units[i];
        try {
          if (u.mode === 'off' || u.emerging) continue;
          const c = u.bodyCenter;
          const RR = radius + 0.4 * u.scale;
          const dist = Math.hypot(c.x - P.x, c.y - P.y, c.z - P.z);
          if (dist > RR) continue;
          const k = 1 - dist / RR;
          D.set(c.x - P.x, 0, c.z - P.z);
          if (D.lengthSq() < 1e-4) D.set(Math.random() - 0.5, 0, Math.random() - 0.5);
          D.normalize();
          D.y = 0.6 + 0.7 * k;
          D.normalize();
          const sp = (4 + 9 * k) * push;
          if (u.mode === 'alive' || u.knocked) {
            if (u.dog?.team === 'ally' && !allies) continue;
            if (u.dog && !u.dog.angry) {
              u.dog.angry = true;
              u.setAngry?.(true);
            }
            const res = u.strike(C.copy(c), D, Math.max(1, Math.round(maxD * k * k)));
            out.dogs += 1;
            if (res === 'kill') {
              out.kills += 1;
              if (push > 0) u.blast?.(D.x * sp, D.y * sp, D.z * sp);
              kc?.dog(u);
            } else if (res === 'hit') {
              kc?.dogHit(u);
              if (push > 0 && u.scale <= 1.7 && k > 0.2) u.knock(D, (0.6 + 1.4 * k) * push);
            }
          } else if ((u.mode === 'dying' || u.mode === 'dead') && u.deadFor < 30 && push > 0) {
            u.blast?.(D.x * sp * 0.8, D.y * sp * 0.8, D.z * sp * 0.8);
          }
        } catch {
          // пёс не важнее взрыва
        }
      }
    }

    const drones = shared.droneTargets;
    if (drones) {
      for (let i = 0; i < drones.length; i += 1) {
        const d = drones[i];
        try {
          if (d.state !== 'alive' && d.state !== 'dying') continue;
          const RR = radius * 1.2 + d.span;
          const dist = Math.hypot(d.x - P.x, d.y - P.y, d.z - P.z);
          if (dist > RR || dist < 1e-4) continue;
          const k = 1 - dist / RR;
          D.set((d.x - P.x) / dist, (d.y - P.y) / dist, (d.z - P.z) / dist);
          if (push > 0) {
            const v = (((6 + 8 * k) * k) / Math.sqrt(Math.max(0.4, d.span))) * push;
            d.vx += D.x * v;
            d.vy += D.y * v + 2 * k * push;
            d.vz += D.z * v;
          }
          if (d.state !== 'alive' || (d.team === 'ally' && !allies)) continue;
          C.set(d.x, d.y, d.z);
          const dr = shared.droneStrike?.(d, C, D, Math.max(1, Math.round(maxD * k)));
          out.drones += 1;
          if (dr === 'kill') {
            out.kills += 1;
            kc?.drone(d);
          } else if (dr === 'hit') kc?.droneHit(d);
        } catch {
          // коптер не важнее
        }
      }
    }
    return { dogs: out.dogs, drones: out.drones, kills: out.kills };
  };
}
