// Приёмка выстрела пушки с ПК (только десктоп-страница: в шлеме не создаётся и ничего не стоит).
// CLI: npm run test:shot -- <id> [--enemy 3] [--ally 3] [--wait 8] [--shot]  (scripts/test-shot.mjs)
// Ручка: __sceneState.testKit —
//   placeDog(team, x, z, { size, frozen }) → unit (стоит сразу, без вылезания; нужна битва — robodogHorde)
//   clearTestDogs() → сколько убрано (только поставленные китом)
//   fireGun(kind, { pitchDeg = 20, yawDeg = 0, from }) → { kind, from, dir } — как курок (main.js shootGun)
//     с опциями пушки из GUNS, из точки чуть перед камерой; kind — 'pistol', 'awp', 'gen_flare_shotgun'
//     или id записи generated-guns.js ('flare_shotgun')
//   waitFor(fn, timeoutMs) → значение fn() или null (опрос раз в кадр, реальное время)
//   snapshotStats() → { projectiles: { <имя>: stats() }, killConfirm, money }
//   shotTest(id, { enemy, ally, wait, screenshot, pitchDeg, yawDeg, keepDogs }) — вся приёмка одним вызовом
//     (её зовёт CLI); псы кита убираются в начале и в конце (keepDogs: true — оставить)
//
// Счётчики снаряда-модуля (stats() модуля projectiles/*), по которым идёт приёмка:
//   fired — выстрелов; landed — упал / попал (если есть: ждём +1); strikes — эффектов (если есть: ждём +1);
//   lastPoint { x, y, z } — где упал последний (иначе берётся самый новый из live[]);
//   lastStrike { x, z, dogs, drones, kills } — где и что задел последний эффект.
// Пушка без модуля (пуля, мана, ракета) — только fired; точки падения нет, псы не ставятся.

const BUILTIN = ['mana', 'rocket', 'plasma', 'rail', 'blackhole']; // снаряды shooting.js без модуля
const IS_QUEST = typeof navigator !== 'undefined' && /Quest|OculusBrowser/.test(navigator.userAgent);
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const r2 = (v) => (Number.isFinite(v) ? +v.toFixed(2) : v);
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => typeof o?.[k] === 'number').map((k) => [k, o[k]]));
const delta = (a, b) => {
  const out = {};
  for (const k of Object.keys(b ?? {})) if (typeof b[k] === 'number' && typeof a?.[k] === 'number' && b[k] !== a[k]) out[k] = r2(b[k] - a[k]);
  return out;
};

// deps (main.js): THREE, camera, shared, shooting, guns (GUNS), kindOf(id) → ключ GUNS или null,
// shootGun(kind, gun, from, dir) — тот же выстрел, что у курка
export function createTestKit({ THREE, camera, shared, shooting, guns, kindOf, shootGun }) {
  if (IS_QUEST) return null;
  const head = new THREE.Vector3();
  const fwd = new THREE.Vector3();
  const testDogs = new Set();

  const dogState = (u, hp0) => u && {
    team: u.dog?.team, mode: u.mode, hp0, hp: r2(u.health),
    hurt: u.mode !== 'alive' || u.health < hp0,
    at: [r2(u.dog?.x), r2(u.dog?.z)],
  };

  // Щит: пока проверка идёт, пёс кита получает урон (unit.hit / unit.strike) только изнутри методов
  // проверяемого модуля — битва вокруг (псы, коптеры) его не трогает и не портит итог.
  let shieldOpen = 0; // > 0 — сейчас работает код модуля
  const shields = new Map(); // unit → [hit, strike]
  const shieldDog = (u) => {
    if (shields.has(u)) return;
    const { hit, strike } = u;
    shields.set(u, [hit, strike]);
    u.hit = (a, b, c, d) => (shieldOpen > 0 ? hit(a, b, c, d) : null);
    u.strike = (a, b, c) => (shieldOpen > 0 ? strike(a, b, c) : null);
  };
  const unshieldAll = () => {
    for (const [u, [hit, strike]] of shields) {
      u.hit = hit;
      u.strike = strike;
    }
    shields.clear();
  };
  // методы модуля открывают щит на время своего вызова; → снять обёртки
  const armModule = (mod) => {
    const saved = [];
    for (const fn of ['fire', 'move', 'impact', 'expire', 'update']) {
      const orig = mod?.[fn];
      if (typeof orig !== 'function') continue;
      mod[fn] = (a, b, c, d) => {
        shieldOpen += 1;
        try {
          return orig(a, b, c, d);
        } finally {
          shieldOpen -= 1;
        }
      };
      saved.push([fn, orig]);
    }
    return () => {
      for (const [fn, orig] of saved) mod[fn] = orig;
    };
  };

  const kit = {
    placeDog(team = 'enemy', x, z, { size = 'маленький', frozen = true, shield = false } = {}) {
      const u = shared.hordeDebug?.place?.(x, z, { size, team, frozen, emerge: false }) ?? null;
      if (u) testDogs.add(u);
      if (u && shield) shieldDog(u);
      return u;
    },
    clearTestDogs() {
      let n = 0;
      unshieldAll();
      for (const u of testDogs) {
        if (u.mode !== 'off') { u.hide(); n += 1; }
      }
      testDogs.clear();
      return n;
    },
    fireGun(kind, { pitchDeg = 20, yawDeg = 0, from = null } = {}) {
      const key = kindOf(kind);
      if (!key) throw new Error(`нет пушки «${kind}»: ${Object.keys(guns).join(', ')}`);
      camera.updateWorldMatrix(true, false);
      camera.getWorldPosition(head);
      camera.getWorldDirection(fwd);
      fwd.y = 0;
      if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1);
      fwd.normalize().applyAxisAngle(new THREE.Vector3(0, 1, 0), (-yawDeg * Math.PI) / 180); // yaw > 0 — вправо
      const p = (pitchDeg * Math.PI) / 180;
      const dir = fwd.clone().multiplyScalar(Math.cos(p));
      dir.y = Math.sin(p);
      const start = from ? new THREE.Vector3(from.x, from.y, from.z) : head.clone().addScaledVector(fwd, 0.6).add(new THREE.Vector3(0, -0.15, 0));
      shootGun(key, guns[key], start, dir);
      return { kind: key, from: start.toArray().map(r2), dir: dir.toArray().map((v) => +v.toFixed(3)) };
    },
    async waitFor(fn, timeoutMs = 5000) {
      const end = performance.now() + timeoutMs;
      for (;;) {
        let v = null;
        try { v = fn(); } catch { v = null; }
        if (v) return v;
        if (performance.now() > end) return null;
        await nextFrame();
      }
    },
    snapshotStats() {
      const projectiles = {};
      for (const [name, m] of Object.entries(shooting.projectiles ?? {})) {
        try { projectiles[name] = m.stats?.() ?? null; } catch (e) { projectiles[name] = { error: String(e?.message ?? e) }; }
      }
      return { projectiles, killConfirm: shared.killConfirm?.stats?.() ?? null, money: shared.money?.stats?.() ?? null };
    },

    // Вся приёмка: выстрел → упал → псы рядом → эффект → итог. Псы ставятся поперёк линии огня
    // (враг справа, союзник слева) на enemy / ally м от точки падения. Если эффект случился сразу при
    // падении (псы не успели), псы ставятся там же и делается второй такой же выстрел.
    async shotTest(id, { enemy = 0, ally = 0, wait = 8, screenshot = null, pitchDeg = 20, yawDeg = 0, size = 'маленький', keepDogs = false } = {}) {
      kit.clearTestDogs(); // остатки прошлой проверки
      const t0 = performance.now();
      const deadline = t0 + wait * 1000;
      const left = () => Math.max(0, deadline - performance.now());
      const key = kindOf(id);
      if (!key) return { ok: false, error: `нет пушки «${id}»`, guns: Object.keys(guns) };
      const gun = guns[key];
      const modName = gun.projectile && shooting.projectiles?.[gun.projectile] ? gun.projectile : null;
      const mod = modName ? shooting.projectiles[modName] : null;
      const disarm = armModule(mod); // щит псов открыт только внутри методов этого модуля
      try {
        return await runShot(key, gun, mod, modName, { enemy, ally, pitchDeg, yawDeg, size, screenshot, t0, left });
      } finally {
        disarm();
        if (keepDogs) unshieldAll();
        else kit.clearTestDogs();
      }
    },
    // снимок, сделанный в shotTest в момент эффекта — отдаётся мосту файлом (CLI вторым вызовом)
    takeShot() {
      const s = kit.lastShot;
      kit.lastShot = null;
      return s ?? 'снимка нет';
    },
    lastShot: null,
  };

  async function runShot(key, gun, mod, modName, { enemy, ally, pitchDeg, yawDeg, size, screenshot, t0, left }) {
    const st = () => { try { return mod?.stats?.() ?? null; } catch { return null; } };
    const before = kit.snapshotStats();
    const s0 = st();
    const has = (k) => typeof s0?.[k] === 'number';
    const out = { gun: key, module: modName, shots: 1 };
    const shot = kit.fireGun(key, { pitchDeg, yawDeg });
    const sF = st();
    out.fired = mod ? (has('fired') ? sF.fired - s0.fired : null) : 1;
    const struck = () => has('strikes') && st()?.strikes > s0.strikes;

    // 1) упал
    let landPoint = null;
    if (has('landed')) {
      const s1 = await kit.waitFor(() => { const s = st(); return s?.landed > s0.landed ? s : null; }, left());
      out.landed = s1 ? s1.landed - s0.landed : 0;
      out.landedAfterS = s1 ? r2((performance.now() - t0) / 1000) : null;
      if (s1) {
        const newest = (s1.live ?? []).reduce((a, q) => (!a || q.id > a.id ? q : a), null);
        landPoint = s1.lastPoint ?? newest ?? (s1.lastStrike ? { x: s1.lastStrike.x, y: null, z: s1.lastStrike.z } : null);
      }
    } else if (mod) {
      out.landed = null; // модуль не считает падения
    }
    if (landPoint) out.landPoint = [r2(landPoint.x), r2(landPoint.y), r2(landPoint.z)];

    // 2) псы рядом с точкой падения, поперёк линии огня
    const dogs = {};
    const placeAll = () => {
      if (!landPoint) return;
      const sx = -shot.dir[2];
      const sz = shot.dir[0];
      const n = Math.hypot(sx, sz) || 1;
      for (const [team, d] of [['enemy', enemy], ['ally', ally]]) {
        if (!(d > 0)) continue;
        const s = team === 'enemy' ? 1 : -1;
        const u = kit.placeDog(team, landPoint.x + (s * d * sx) / n, landPoint.z + (s * d * sz) / n, { size, shield: true });
        dogs[team] = u ? { u, hp0: u.health, dist: d } : { error: shared.hordeDebug ? 'пёс не поставлен (нет битвы — функция сцены robodogHorde, или нет свободных моделей)' : 'нет стаи' };
      }
    };
    if ((enemy > 0 || ally > 0) && landPoint) {
      const already = struck();
      placeAll();
      await nextFrame();
      await nextFrame(); // bodyCenter пса — после кадра
      if (already && (dogs.enemy?.u || dogs.ally?.u)) {
        // эффект был сразу при падении — второй такой же выстрел в уже стоящих псов
        s0.strikes = st()?.strikes ?? s0.strikes;
        if (has('landed')) s0.landed = st()?.landed ?? s0.landed;
        kit.fireGun(key, { pitchDeg, yawDeg });
        out.shots = 2;
      }
    } else if ((enemy > 0 || ally > 0) && !landPoint) {
      out.dogsNote = 'точки падения нет — псы не поставлены';
    }

    // 3) эффект
    let strikeState = null;
    if (has('strikes')) {
      const pre = {};
      for (const t of ['enemy', 'ally']) if (dogs[t]?.u) pre[t] = r2(dogs[t].u.health);
      const s2 = await kit.waitFor(() => (struck() ? st() : null), left());
      out.strikes = s2 ? s2.strikes - s0.strikes : 0;
      out.strikeAfterS = s2 ? r2((performance.now() - t0) / 1000) : null;
      if (s2?.lastStrike) {
        const ls = s2.lastStrike;
        out.lastStrike = { x: ls.x, z: ls.z, dogs: ls.dogs ?? ls.result?.dogs, drones: ls.drones ?? ls.result?.drones, kills: ls.kills ?? ls.result?.kills };
      }
      strikeState = pre;
      if (s2 && screenshot) {
        await pause(120); // огненный шар уже раздулся
        try {
          kit.lastShot = await screenshot({ eyes: 'left', width: 1024 });
          out.shotTaken = true;
        } catch (e) {
          out.shotError = String(e?.message ?? e);
        }
      }
    } else if (mod) {
      out.strikes = null;
      await pause(Math.min(1500, left()));
    } else {
      await pause(Math.min(1500, left())); // обычная пуля: долетит
    }

    // 4) дали эффекту доиграть
    await pause(Math.min(700, left()));
    for (const t of ['enemy', 'ally']) {
      const d = dogs[t];
      if (!d) continue;
      out[t] = d.u ? { ...dogState(d.u, d.hp0), dist: d.dist, hpAtStrike: strikeState?.[t] ?? null } : d;
    }
    const after = kit.snapshotStats();
    out.killConfirm = delta(pick(before.killConfirm, ['kills', 'dogs', 'drones', 'hits']), pick(after.killConfirm, ['kills', 'dogs', 'drones', 'hits']));
    out.money = delta(pick(before.money, ['balance']), pick(after.money, ['balance']));
    out.creditedToPlayer = (out.killConfirm.kills ?? 0) + (out.killConfirm.hits ?? 0) > 0;

    // итог: проверки по тому, что заявлено
    const checks = { fired: out.fired >= 1 };
    // projectile: '<имя>' в записи есть, а модуля в projectiles/index.js нет — пушка стреляет обычной пулей
    if (gun.projectile && !mod && !BUILTIN.includes(gun.projectile)) {
      checks.moduleRegistered = false;
      out.error = `снаряд «${gun.projectile}» не зарегистрирован в projectiles/index.js`;
    }
    if (out.landed !== undefined && out.landed !== null) checks.landed = out.landed >= 1;
    if (out.strikes !== undefined && out.strikes !== null) checks.strikes = out.strikes >= 1;
    if (enemy > 0) checks.enemyHurtAndCredited = Boolean(out.enemy?.hurt) && out.creditedToPlayer;
    if (ally > 0) checks.allyUnharmed = Boolean(out.ally?.team) && !out.ally.hurt;
    if (has('expired')) out.expired = (st()?.expired ?? s0.expired) - s0.expired; // погас в воздухе (landed 0 — смотри сюда)
    out.checks = checks;
    out.ok = Object.values(checks).every(Boolean);
    out.tookS = r2((performance.now() - t0) / 1000);
    return out;
  }
  return kit;
}
