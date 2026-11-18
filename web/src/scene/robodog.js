// Робопёс-одиночка (функция сцены «robodog», см. compositions.js; сейчас ни в одной сцене не включён).
//
// Сам пёс — robodog-unit.js (модель, походка, попадания, смерть, кукла), поведение — robodog-ai.js:
// бегает по полю перед игроком, нюхает, оглядывается, прыгает; пуля рядом или попадание — убегает.
// HEALTH попаданий (каждый патрон калаша — отдельно) — смерть и тряпичная кукла; лежащего можно
// толкать выстрелами. Через DEAD_S секунд (или на «Рестарт» сцены) появляется новый.
// Цель для пуль — shooting.addShootable: попадание по живому — true, по лежащему — null (не в счёт).
// Сохраняется только «жив/мёртв» (state()); где он бегает — нет.
import { createDogSfx, createDogUnit } from './robodog-unit.js';
import { createBrain, createDog, yawTo } from './robodog-ai.js';
import { createZapFx } from './robodog-fx.js';
import { makeDogTextures, makeShadowTexture } from './robodog-model.js';
import { ensureWeaponEnv } from './weapon-env.js';

const HEALTH = 5;
const DEAD_S = 20; // лежит, потом новый
const NEAR_MISS_M = 2.2;
const LOG_EVERY_MS = 10000;

export function createRobodog({ THREE, root, camera, renderer = null, shooting, onKill }) {
  const shared = (globalThis.__sceneState ??= {});
  const brain = createBrain();
  const sfx = createDogSfx(shared);
  const shadowTexture = makeShadowTexture(THREE);
  let unit = null;
  let fx = null;
  let textures = null;
  let removeShootable = null;
  let enabled = false;
  // { dog, mode, health, deadLeft, pending, rag } — переживает подмену файла сцены
  let run = shared.robodogRun ?? null;

  const env = { px: 0, pz: 0, fx: 0, fz: -1, stands: null };
  const v1 = new THREE.Vector3();
  const v2 = new THREE.Vector3();
  const refreshEnv = () => {
    camera.getWorldPosition(v1);
    env.px = v1.x;
    env.pz = v1.z;
    camera.getWorldDirection(v2);
    const len = Math.hypot(v2.x, v2.z);
    if (len > 0.2) {
      env.fx = v2.x / len;
      env.fz = v2.z / len;
    }
    env.stands = shooting?.targetsEnabled?.() && Array.isArray(shared.targetStands) ? shared.targetStands : null;
  };

  // где появиться: 8–12 м перед игроком, не у стойки, мордой примерно к игроку
  const spawnDog = () => {
    refreshEnv();
    const dog = createDog();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const a = (Math.random() - 0.5) * 1.4;
      const dist = 8 + Math.random() * 4;
      const fx_ = env.fx * Math.cos(a) - env.fz * Math.sin(a);
      const fz_ = env.fx * Math.sin(a) + env.fz * Math.cos(a);
      dog.x = env.px + fx_ * dist;
      dog.z = env.pz + fz_ * dist;
      if (!(env.stands ?? []).some((s) => Math.hypot(s.x - dog.x, s.z - dog.z) < 1.6)) break;
    }
    dog.yaw = yawTo(env.px - dog.x, env.pz - dog.z) + (Math.random() - 0.5) * 1.2;
    dog.tx = dog.x;
    dog.tz = dog.z;
    dog.left = 1 + Math.random();
    return dog;
  };

  function cast(origin, dir, far) {
    return enabled && unit && run && !run.pending ? unit.cast(origin, dir, far) : -1;
  }
  // любой выстрел: пуля прошла рядом — живой пёс убегает
  function shot(origin, dir, far) {
    if (!enabled || !unit || unit.mode !== 'alive') return;
    v1.subVectors(unit.bodyCenter, origin);
    const t = v1.dot(dir);
    if (t < 0 || t > far + 1.5) return;
    if (v1.lengthSq() - t * t < NEAR_MISS_M * NEAR_MISS_M) {
      refreshEnv();
      brain.scare(unit.dog, env, false);
    }
  }
  function hit(origin, dir, distance) {
    if (!unit) return null;
    const result = unit.hit(origin, dir, distance);
    if (result === 'corpse') return null;
    if (result === 'kill') {
      run.mode = 'dying';
      run.deadLeft = DEAD_S;
      try {
        onKill?.();
      } catch (e) {
        console.warn('[robodog] onKill', e?.message ?? e);
      }
    } else {
      refreshEnv();
      brain.scare(unit.dog, env, true);
    }
    return true;
  }

  const ensureUnit = () => {
    if (unit) return;
    const anchors = [];
    fx = createZapFx({ THREE, root, anchors });
    textures = makeDogTextures(THREE);
    const env = renderer ? ensureWeaponEnv(THREE, renderer) : null;
    unit = createDogUnit({ THREE, root, fx, anchors, shadowTexture, sfx, camera, textures, env, shared });
    // автонаводка (shooting.js): живой пёс — центр корпуса и скорость
    const aimTargets = (visit) => {
      if (!enabled || !unit || !run || run.pending || (unit.mode !== 'alive' && !unit.knocked)) return;
      const d = unit.dog;
      const v = unit.mode === 'alive' ? d.v ?? 0 : 0;
      visit(unit.bodyCenter, -Math.sin(d.yaw) * v, 0, -Math.cos(d.yaw) * v, d);
    };
    removeShootable = shooting?.addShootable?.({ cast, hit, shot, aimTargets }) ?? null;
  };
  const teardown = () => {
    removeShootable?.();
    removeShootable = null;
    unit?.dispose();
    unit = null;
    fx?.dispose();
    fx = null;
    textures?.dispose();
    textures = null;
  };
  const newRun = (alive) => {
    run = shared.robodogRun = { dog: null, mode: alive ? 'alive' : 'dead', health: HEALTH, deadLeft: DEAD_S, pending: true, rag: null };
  };

  let sum = 0;
  let worst = 0;
  let frames = 0;
  let since = performance.now();

  return {
    // enabled — есть ли пёс в сцене; saved — { alive } из снимка сцены; keep — подмена файла сцены:
    // пёс остаётся где был (иначе — новый перед игроком)
    apply(on, saved, { keep = false } = {}) {
      enabled = Boolean(on);
      if (!enabled) {
        teardown();
        run = shared.robodogRun = null;
        return;
      }
      ensureUnit();
      if (keep && run && run.dog && !run.pending) {
        if (run.mode === 'alive') unit.spawn(run.dog, { health: run.health, boot: false });
        else if (run.rag) unit.restoreRagdoll(run.dog, run.rag);
        else unit.spawn(run.dog, { dead: true });
        if (run.mode === 'dying') run.mode = 'dead';
        return;
      }
      if (keep && run?.pending) return;
      newRun(saved?.alive !== false);
    },
    state: () => (enabled && run ? { alive: run.mode === 'alive' } : null),
    update(dt) {
      if (!enabled || !unit || !run) return;
      const t0 = performance.now();
      dt = Math.min(dt, 0.05);
      if (run.pending) {
        camera.getWorldPosition(v1);
        if (v1.lengthSq() === 0) return; // камера ещё не на месте
        run.dog = spawnDog();
        run.pending = false;
        unit.spawn(run.dog, { health: HEALTH, dead: run.mode !== 'alive' });
      }
      if (run.mode === 'alive') {
        refreshEnv();
        const event = brain.step(run.dog, env, dt);
        if (event) unit.jump({ height: event === 'jump' ? 0.45 : 0.25 });
      } else {
        run.deadLeft -= dt;
        if (run.deadLeft <= 0) {
          run.mode = 'alive';
          run.rag = null;
          run.dog = spawnDog();
          unit.spawn(run.dog, { health: HEALTH });
        } else if (run.deadLeft < 1.3 && unit.mode === 'dead') unit.setFade(1 - run.deadLeft / 1.3); // труп растворяется
      }
      unit.update(dt);
      if (run.mode === 'dying' && unit.mode === 'dead') run.mode = 'dead';
      run.health = unit.health;
      fx.update(dt);

      const spent = performance.now() - t0;
      sum += spent;
      worst = Math.max(worst, spent);
      frames += 1;
      if (t0 - since >= LOG_EVERY_MS) {
        console.log(`[robodog] cpu=${(sum / frames).toFixed(3)}/${worst.toFixed(2)}ms mode=${run.mode} state=${run.dog?.state} hp=${unit.health} fx=${fx.active}`);
        sum = worst = frames = 0;
        since = t0;
      }
    },
    // для npm run vr:eval
    debug: {
      info: () =>
        run && {
          mode: run.mode,
          pending: run.pending,
          health: unit?.health,
          deadLeft: +run.deadLeft.toFixed(1),
          dog: run.dog && { x: +run.dog.x.toFixed(2), z: +run.dog.z.toFixed(2), yaw: +run.dog.yaw.toFixed(2), v: +run.dog.v.toFixed(2), state: run.dog.state, jump: Boolean(run.dog.jump) },
          body: unit?.bodyCenter.toArray().map((v) => +v.toFixed(2)),
          asleep: unit?.ragdoll.asleep,
        },
      // выстрел из точки from (мировой) в центр пса — как пуля
      shootFrom(from) {
        const o = new THREE.Vector3().copy(from);
        const d = unit.bodyCenter.clone().sub(o).normalize();
        const t = cast(o, d, 60);
        return t < 0 ? 'мимо' : hit(o, d, t);
      },
      respawn() {
        newRun(true);
      },
    },
    dispose() {
      if (run && unit && run.mode !== 'alive' && !run.pending) run.rag = unit.ragdollState();
      teardown();
      shadowTexture.dispose();
    },
  };
}
