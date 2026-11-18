// ШАБЛОН снаряда-модуля (не зарегистрирован). Новый снаряд — одной командой:
//   npm run new:projectile -- <имя> <id пушки> [--speed 40] [--no-blast]
// (scripts/new-projectile.mjs): копирует ТРИ файла (этот, _template.sounds.js, _template.fx.js) в
// projectiles/<имя>.js / <имя>.sounds.js / <имя>.fx.js, регистрирует в index.js, ставит projectile в
// запись пушки — голый выстрел сразу в игре (П0). shooting.js и другие файлы не трогать.
//
// Три файла — три агента ПАРАЛЛЕЛЬНО, каждый правит только свой:
//   <имя>.js        — ЛОГИКА: [П1] выстрел (полёт, падение, ожидание) и [П2] эффект + урон (detonate).
//   <имя>.sounds.js — [П3] ЗВУКИ: рецепты по событиям (launch, land, preStrike, strike, expire).
//   <имя>.fx.js     — [П4] ВИД: вспышка, след, пламя, дым — крючки fire/fly/land/wait/strike/expire/update.
// Логика зовёт звуки и вид по событиям; нет звука или крючка — молча; ошибка в fx глотается
// (одно предупреждение) — выстрел не ломается.
//
// stats() → { fired, landed, strikes, expired, live, lastPoint: { x, y, z }, lastStrike: { x, z, dogs, drones, kills }, sound } —
// по этим числам принимается каждый П: npm run test:shot -- <id пушки> --enemy 3 --ally 3 --shot
// (scripts/test-shot.mjs, test-kit.js) ждёт fired +1, landed +1 (если счётчик есть), strikes +1 (если есть);
// псов ставит у lastPoint (где упал последний). Названия полей не менять.
//
// ctx (даёт shooting.js): THREE, group (сюда добавлять меши), camera, shared (__sceneState), effects,
//   groundAt(x, z) → высота земли, areaDamage(point, radius, maxDamage, { credit: 'player' | null }),
//   strike(x, z, { damage, radius, credit, sound, shake }) → полный разрыв (artillery.js),
//   explode(x, y, z, S) → малый разрыв, только вид, soundBank(key, recipes, { voices }),
//   smokePuff(…), plates(), knockPlate(plate, point, dir).
// Модуль → shooting.js: { life, gravity, fire, move, impact, expire, update, stats, dispose }.
import { createSoundBank } from '../sound-bank.js';
import { MAX_STEP_S } from '../world-clock.js';
import { SOUNDS } from './_template.sounds.js';
import { createFx } from './_template.fx.js';

const NAME = 'template'; // имя снаряда (то же, что ключ в projectiles/index.js)
const LIFE = 6; // с полёта: потом пуля пула кончается → expire
const GRAVITY = 9.81; // по умолчанию, если в записи оружия нет gravity
const FUSE_S = 3; // с (игровое время) от падения до эффекта; в записи: projectileOpts: { fuseS }
const RADIUS = 9; // м, радиус урона
const DAMAGE = 15; // урон в центре (на краю — 1)
const MAX = 8; // одновременно живых снарядов; лишний вытесняет самый старый
const BLAST = true; // П0: артиллерийский разрыв в конце; false — detonate() только считает (эффект пушки — не взрыв)

// мягкое круглое пятно — одно на всех, кэш в __sceneState (не освобождать в dispose)
const glowTexture = (THREE, shared) => {
  if (shared.projGlowTex) return shared.projGlowTex;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const r = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  r.addColorStop(0, 'rgba(255,255,255,1)');
  r.addColorStop(0.3, 'rgba(255,255,255,0.5)');
  r.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = r;
  g.fillRect(0, 0, 64, 64);
  return (shared.projGlowTex = new THREE.CanvasTexture(c));
};

export function createTemplate(ctx) { // create<Имя>
  const { THREE, group, shared, strike, areaDamage, explode } = ctx;
  const tex = glowTexture(THREE, shared);
  const P = new THREE.Vector3(); // скретч
  const n = { fired: 0, landed: 0, strikes: 0, expired: 0 }; // счётчики для приёмки
  let lastStrike = null;
  let lastPoint = null; // где упал последний (test:shot ставит рядом псов)
  let nextId = 0;

  // [П3] звук: событие → рецепт из <имя>.sounds.js ({ seconds, variants, render, vol, ref, lead }); нет — молча
  const bank = createSoundBank(NAME, SOUNDS, { voices: 6 });
  const sfx = (name, p) => {
    const r = SOUNDS[name];
    if (r) bank.play(name, p, r.vol ?? 1, { duck: name === 'launch', ref: r.ref ?? 2, rate: 0.95 + Math.random() * 0.1 });
  };

  // [П4] вид: крючки из <имя>.fx.js; любая ошибка → одно предупреждение, выстрел живёт дальше
  let fx = {};
  try {
    fx = createFx(ctx) ?? {};
  } catch (e) {
    console.warn(`[${NAME}-fx] не создался`, e?.message ?? e);
  }
  let fxWarned = false;
  const hook = (name, a, b, c) => {
    const f = fx[name];
    if (!f) return;
    try {
      f(a, b, c);
    } catch (e) {
      if (!fxWarned) console.warn(`[${NAME}-fx] ${name}`, e?.message ?? e);
      fxWarned = true;
    }
  };

  // [П1] пул: на снаряд — один светящийся спрайт (state: 0 свободен, 1 летит, 2 лежит и ждёт)
  const slots = [];
  for (let i = 0; i < MAX; i += 1) {
    const mat = new THREE.SpriteMaterial({ map: tex, color: 0xff5a2a, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    const sprite = new THREE.Sprite(mat);
    sprite.visible = false;
    group.add(sprite);
    slots.push({ id: 0, state: 0, sprite, mat, x: 0, y: 0, z: 0, t: 0, fuse: FUSE_S, born: 0, pre: false });
  }
  const byId = (id) => {
    for (let i = 0; i < MAX; i += 1) if (slots[i].id === id && slots[i].state !== 0) return slots[i];
    return null;
  };
  const free = (s) => {
    s.state = 0;
    s.sprite.visible = false;
  };
  const place = (s, p) => {
    s.x = p.x;
    s.y = p.y;
    s.z = p.z;
    s.sprite.position.set(p.x, p.y, p.z);
  };

  // [П2] эффект в точке, где снаряд пролежал fuse
  const detonate = (s) => {
    if (!BLAST) {
      lastStrike = { x: +s.x.toFixed(2), z: +s.z.toFixed(2), dogs: 0, drones: 0, kills: 0 };
      return;
    }
    let hit = strike(s.x, s.z, { damage: DAMAGE, radius: RADIUS, credit: 'player' }); // разрыв + урон игроку
    if (!hit) {
      // артиллерии нет (не должно быть) — сами: урон и малый разрыв
      hit = areaDamage(P.set(s.x, s.y + 0.5, s.z), RADIUS, DAMAGE, { credit: 'player' });
      explode(s.x, s.y + 0.5, s.z, 0.5);
    }
    lastStrike = { x: +s.x.toFixed(2), z: +s.z.toFixed(2), dogs: hit?.dogs ?? 0, drones: hit?.drones ?? 0, kills: hit?.kills ?? 0 };
  };

  const api = {
    life: LIFE,
    gravity: GRAVITY,
    // [П1] выстрел: from/dir — векторы пула (скопировать, если хранить); opts — projectileOpts записи. → id > 0
    fire({ from, dir, opts }) {
      let s = slots.find((q) => q.state === 0);
      if (!s) s = slots.reduce((a, q) => (q.born < a.born ? q : a)); // самый старый уступает
      s.id = nextId += 1;
      s.state = 1;
      s.born = s.id;
      s.t = 0;
      s.pre = false;
      s.fuse = opts?.fuseS ?? FUSE_S;
      place(s, from);
      s.sprite.scale.setScalar(0.25);
      s.sprite.visible = true;
      n.fired += 1;
      sfx('launch', from); // [П3]
      hook('fire', s, dir, opts); // [П4]
      return s.id;
    },
    // [П1] в полёте, каждый подшаг: где снаряд (пул считает дугу сам)
    move(id, pos) {
      const s = byId(id);
      if (s?.state === 1) place(s, pos);
    },
    // [П1] попал: point — общий вектор (скопировать); what: 1 земля, 2 мишень, 3 стойка, 4 цель (пёс,
    // коптер, тарелка — прямое попадание уже засчитано), 0 не бывает (это expire)
    impact(id, point, what) {
      const s = byId(id);
      if (!s) return;
      place(s, point);
      if (what !== 1) s.y = ctx.groundAt(s.x, s.z); // попал не в землю — падает под точку
      s.sprite.position.y = s.y + 0.15;
      s.state = 2;
      s.t = 0;
      n.landed += 1;
      lastPoint = { x: +s.x.toFixed(2), y: +s.y.toFixed(2), z: +s.z.toFixed(2) };
      sfx('land', s.sprite.position); // [П3]
      hook('land', s, what); // [П4]
    },
    // [П1] кончился в воздухе (время/путь, вытеснен из пула): point — где, или null
    expire(id) {
      const s = byId(id);
      if (!s) return;
      n.expired += 1;
      sfx('expire', s.sprite.position); // [П3]
      hook('expire', s); // [П4]
      free(s);
    },
    // игровое время (подшаг мира, до MAX_STEP_S); таймеры только на dt, не performance.now()
    update(dt) {
      const h = Math.min(MAX_STEP_S, dt || 0);
      for (let i = 0; i < MAX; i += 1) {
        const s = slots[i];
        if (s.state === 0) continue;
        s.t += h;
        if (s.state === 1) {
          hook('fly', s, h); // [П4]
          if (s.t > LIFE + 1) free(s); // страховка: пуля пропала без expire
          continue;
        }
        // [П1] лежит: мигает чаще к концу
        const k = s.t / s.fuse;
        s.sprite.scale.setScalar(0.35 + 0.25 * Math.abs(Math.sin(s.t * (6 + 20 * k))));
        hook('wait', s, h, k); // [П4]
        if (!s.pre && s.t >= s.fuse - (SOUNDS.preStrike?.lead ?? 0.6)) {
          s.pre = true;
          sfx('preStrike', s.sprite.position); // [П3] свист перед эффектом
        }
        if (s.t >= s.fuse) {
          n.strikes += 1;
          detonate(s); // [П2]
          sfx('strike', s.sprite.position); // [П3] (у артиллерии свой взрыв — это добавка)
          hook('strike', s); // [П4]
          free(s);
        }
      }
      hook('update', h); // [П4] свои частицы, затухания
    },
    stats: () => ({
      ...n,
      live: slots.filter((s) => s.state).map((s) => ({ id: s.id, state: s.state, t: +s.t.toFixed(2), x: +s.x.toFixed(1), y: +s.y.toFixed(2), z: +s.z.toFixed(1) })),
      lastPoint,
      lastStrike,
      sound: bank.stats(),
      fx: fx.stats?.() ?? null,
    }),
    dispose() {
      hook('dispose');
      for (const s of slots) {
        group.remove(s.sprite);
        s.mat.dispose(); // текстура общая (кэш) — не трогать
      }
      if (shared.projectileDebug?.[NAME] === api) delete shared.projectileDebug[NAME];
    },
  };
  (shared.projectileDebug ??= {})[NAME] = api; // vr:eval: __sceneState.projectileDebug.<NAME>.stats()
  return api;
}
