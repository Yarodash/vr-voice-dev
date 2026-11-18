// Сгенерированные пушки — по этапам, в той же группе (поза и «в руке» не теряются при смене):
//   0) запись без файлов (card: false) — сразу голограмма-заглушка по shape с табличкой «генерирую…»;
//   1) card.png (Gemini, фон вырезан) и card: true — «толстая картинка» (грани + стенки по контуру);
//   2) mesh.glb (Tripo) и glb: true — 3D-модель на месте картинки;
//   3) scope / trigger — настоящий прицел (scope-lens.js) и спуск, который ходит за курком.
// Код — generated-gun.js. Живёт в сцене: правка этого списка подхватывается на лету.
//
// Файлы: web/public/models/generated/<id>/card.png — PNG с прозрачным фоном, пушка сбоку, стволом
// ВПРАВО; <id>/mesh.glb — модель.
//
// Запись: { id, name, length, auto, card, glb, v } + по желанию любые поля из GUN_AUTO/GUN_SEMI
// (gapMs, kickRad, …) и подгонка:
//   id     — папка с файлами (латиница); вид оружия в игре — 'gen:<id>' (так и сохраняется)
//   name   — как в меню: «Заспавнить <name>», заголовок меню с пушкой в руке
//   length — длина пушки, м (ширина непрозрачной части картинки; модель масштабируется так же)
//   auto   — true: очередь, звук и вспышка калаша, гильза винтовочная; false: как пистолет
//   modes  — ['semi', 'auto']: в меню с пушкой в руке переключатель «Режим: авто / полуавтомат»
//            (запоминается: scene.gen.<id>.mode; без сохранённого — по auto)
//   shape  — силуэт заглушки: 'rifle' | 'smg' | 'pistol' | 'shotgun' | 'sniper' (без него — по length)
//   card   — false: картинки ещё нет (заглушка); по умолчанию true
//   glb    — true: показывать модель mesh.glb (пока грузится — картинку или заглушку)
//   v      — версия файлов: увеличь, когда card.png или mesh.glb перезаписаны (сбрасывает кэш)
//   spawnOnAdd — true: при появлении записи одна пушка сама встаёт перед игроком (раз на id+v)
//   grip   — [u, v] середина рукоятки (ладонь) в долях ВСЕЙ картинки, от левого верхнего угла;
//            без него ищется сама (generated-gun.js analyzeCard)
//   muzzle — [u, v] дуло в долях картинки; без него — правый край на высоте ствола
//   scope  — { eyepiece: [x, y], objective: [x, y], radiusPx, objectiveRadiusPx?, zoom = 4,
//            reticle = 'duplex' | 'pso', tanApparent = 0.26 } — ПИКСЕЛИ card.png (реальный размер):
//            середины торцов окуляра (к прикладу) и объектива, радиус стекла;
//            offset: [x, y, z] — сдвиг стёкол, м, по осям пушки (x вправо, y вверх, z к прикладу)
//   addScope — { at: [x, y], length = 0.28, zoom = 5, height, style = 'emerald' | 'black' }: на картинке
//            прицела нет — модель прицела с настоящими стёклами (scope-addon.js); at — пиксели card.png
//            верха коробки под серединой крепления, height — ось над ним, м
//   collimator — { at: [x, y], windowR = 0.022, zeroM = 30, dotMoa = 5, color = 0xff2418, height, length }:
//            коллиматор (red-dot, collimator.js) на рельсе; at — пиксели card.png верхней кромки рельса под
//            серединой лапы (у модели лапа садится на верх вершин под ней); точка без параллакса, пристреляна
//            на zeroM по пуле этой пушки; height — ось над рельсом, м
//   trigger — { box: [x0, y0, x1, y1], maxAngle = 0.35 } — пиксели card.png: рамка вокруг лезвия
//            спуска внутри скобы (верх рамки — ось поворота)
//   thicknessM — толщина «картинки», м (по умолчанию 0.035)
//   glbFlip — true: модель развёрнута не тем концом (дуло определилось неверно)
//   calib  — ключ localStorage с посадкой в руке, если её надо делить с другим оружием
//   autoAim — автонаводка, градусы (полуугол конуса вокруг ствола): пуля летит в центр ближайшей по
//            углу цели (мишень, летящая тарелка, вражеский пёс) с поправкой на падение и упреждением
//            (shooting.js autoAim); 0 / нет — выкл. То же поле работает в GUNS в main.js
//   projectile — 'mana': вместо пули светящийся мана-сгусток (mana.js): голубая вспышка у дула,
//            магический всплеск при попадании, без гильз, дыма и вспышки калаша; projectileColor — его
//            цвет (hex, по умолчанию голубой 0x39c6ff); gravity — м/с² (у маны по умолчанию 2,5 — падает
//            слабее пули). Звук к нему — sound: 'mana' (sound.js: «магический» выстрел и попадание)
//   homing — { delayS = 0.05, turnDegS = 360, gravity = 0 } (нужен autoAim): самонаведение — снаряд
//            вылетает ВДОЛЬ ствола, через delayS доворачивает к цели конуса autoAim (её текущему центру,
//            с упреждением) не быстрее turnDegS °/с — видна дуга; цель пропала / проскочил — дальше прямо
//   projectile: 'blackhole' — вместо пули летящая чёрная дыра (blackhole.js): всё вокруг притягивает,
//            псов подкидывает, коптеры сбивает с курса, в конце схлопывается со взрывом; свой звук
//   charge — { minS = 0.3, maxS = 3 }: курок не стреляет, а заряжает (реальное время); отпустил —
//            выстрел силы 0..1 ((держал − minS) / (maxS − minS)); у дула растёт заряд, в руке дрожь
//   projectile: 'rocket' | 'rail' | 'plasma' — оружие арены (arena-weapons.js, звук — arena-sound.js):
//            ракета (speed, gravity — дуга, взрыв с уроном ~4 м), рейлган (мгновенный сквозной луч
//            300 м, урон по shotKind), плазма (голубые шары, всплеск ~1 м); без гильз и вспышки калаша
//   shake  — { m, cap, tau }: своя тряска вида от выстрела (формат SHAKE в shake.js)
//   projectile: '<имя>' из projectiles/index.js — снаряд-модуль (шаблон projectiles/_template.js);
//            projectileOpts — { … } его настройки, доходят до mod.fire({ opts }) как есть
export const GEN_PREFIX = 'gen:';

// Стрельба по умолчанию (как в main.js GUNS): auto — как калаш, иначе — как пистолет.
export const GUN_AUTO = { gapMs: 90, auto: true, kickMs: 60, kickRad: 0.02, kickBackM: 0.005, climbRad: 0.006, buzz: 0.7, speed: 900, flash: true, sound: 'ak', shotKind: 'ak', rifleCasing: true, autoAim: 0, projectile: null, projectileColor: null, projectileOpts: null, gravity: null, homing: null, charge: null, shake: null };
export const GUN_SEMI = { gapMs: 0, auto: false, kickMs: 140, kickRad: 0.2, kickBackM: 0, climbRad: 0, buzz: 0.8, speed: 360, flash: false, sound: 'pistol', shotKind: 'pistol', rifleCasing: false, autoAim: 0, projectile: null, projectileColor: null, projectileOpts: null, gravity: null, homing: null, charge: null, shake: null };

export const GENERATED_GUNS = [
  {
    id: 'm16', name: 'М16', length: 1.0, auto: true, modes: ['semi', 'auto'], shape: 'rifle', card: true, glb: true, v: 1,
    scope: { eyepiece: [810, 483], objective: [1508, 485], radiusPx: 50.6, objectiveRadiusPx: 37.4, zoom: 2, offset: [-0.003, -0.003, 0] },
    trigger: { box: [1018, 822, 1060, 893] },
  },
  // штурмовая винтовка в духе аркадных шутеров 2000-х (по просьбе: «М-ка в стиле Serious Sam»); пока картинка, без 3D
  // снайперка «киберпанк + космос/галактика» (по просьбе из шлема)
  // арена-шутер, оригинальный дизайн в духе жанра: ракетница, рейлган, плазмаган (снаряды — отдельной задачей)
  { id: 'rocket_launcher', name: 'Ракетница', length: 1.05, auto: false, shape: 'shotgun', card: true, glb: true, v: 2, gapMs: 800,
    projectile: 'rocket', speed: 48, gravity: 7, shotKind: 'ak', kickMs: 220, kickRad: 0.1, kickBackM: 0.03, buzz: 1, shake: { m: 0.012, cap: 0.012, tau: 35 } }, // ракеты (arena-weapons.js): 48 м/с, летят дугой (gravity 7 м/с², нос по полёту), взрыв, урон по области ~4 м
  { id: 'railgun', name: 'Рейлган', length: 1.15, auto: false, shape: 'sniper', card: true, glb: true, v: 2, gapMs: 1500,
    projectile: 'rail', shotKind: 'awp', kickMs: 200, kickRad: 0.11, kickBackM: 0.03, buzz: 1, shake: { m: 0.016, cap: 0.016, tau: 35 }, // сквозной мгновенный луч (shooting.js railShot + arena-weapons.js)
    // на картинке прицела нет — модель прицела (scope-addon.js) на крышке коробки над катушками (замер по
    // альфе card.png: верх x 1215–1366 — y 508; по модели: конденсатор сзади на +3,2 см выше крышки —
    // прицел сдвинут вперёд, чтобы окуляр в него не уходил; глаз смотрит над конденсатором; по просьбе
    // ножки выше и крепче — ось 58 мм над крышкой)
    addScope: { at: [1408, 508], length: 0.28, zoom: 5, height: 0.058, style: 'emerald' } },
  { id: 'plasma_gun', name: 'Плазмаган', length: 1.0, auto: true, shape: 'smg', card: true, glb: true, v: 4, gapMs: 90,
    projectile: 'plasma', speed: 50, shotKind: 'pistol', kickRad: 0.012, kickBackM: 0.003, climbRad: 0.003, buzz: 0.5, shake: { m: 0.002, cap: 0.003, tau: 15 } }, // плазма (arena-weapons.js): ~11 выстр./с, малый всплеск ~1 м
  { id: 'cosmo_sniper', name: 'Космо-снайперка', length: 1.125, auto: false, shape: 'sniper', card: true, glb: true, v: 4, spawnOnAdd: true, grip: [0.272, 0.585], big: 1.9,
    // настоящий прицел на нарисованной трубе (пиксели card.png 2752×1536, замерено по альфе: окуляр x 723,
    // y 465–580; объектив x 1702, y 440–606) и спуск; на модели стёкла ставит fitScope по торцам трубы
    scope: { eyepiece: [724, 522], objective: [1701, 523], radiusPx: 57, objectiveRadiusPx: 83, zoom: 6 }, // замер 48 / 70, по просьбе ×1,1 ×1,08
    trigger: { box: [900, 826, 934, 890] }, gapMs: 1800, projectile: 'blackhole', charge: { minS: 0.3, maxS: 3 }, kickRad: 0.12, buzz: 1 }, // стреляет чёрными дырами (blackhole.js): держать курок — заряд, отпустить — выстрел; grip задан вручную: сама рукоять нашлась у приклада
  { id: 'sam_rifle', name: 'Сэм-винтовка', length: 0.775, auto: true, modes: ['semi', 'auto'], shape: 'rifle', card: true, glb: true, v: 4, autoAim: 15, projectile: 'mana', sound: 'mana', speed: 100, homing: { delayS: 0.04, turnDegS: 240 } }, // мана: сгусток виден в полёте (100 м/с) и доворачивает к цели дугой; v2 — «в стиле природы», v3 — + синяя мана, v4 — 3D (Tripo medium)
  // «М-ка в хаки» (из шлема 2026-11-18): обычная штурмовая винтовка M4-образная в цвете хаки, обычные пули
  { id: 'khaki_m4', name: 'М-ка хаки', length: 1.1, auto: true, modes: ['semi', 'auto'], shape: 'rifle', card: true, glb: true, v: 15, trigger: { box: [387, 307, 446, 342] },
    // коллиматор на верхнем рельсе над коробкой (замер по альфе card.png 1024×572: верх зубьев рельса x 362–862 — y 200,5)
    collimator: { at: [440, 200.5] } },
];

const FIRE_KEYS = Object.keys(GUN_AUTO);

export const genKind = (id) => `${GEN_PREFIX}${id}`;
export const isGenKind = (kind) => typeof kind === 'string' && kind.startsWith(GEN_PREFIX);
export const genEntry = (kind) => (isGenKind(kind) ? GENERATED_GUNS.find((g) => genKind(g.id) === kind) ?? null : null);
export const genSpawnLabel = (entry) => `Заспавнить ${entry.name}`;
export const genKindByLabel = (label) => {
  const entry = GENERATED_GUNS.find((g) => genSpawnLabel(g) === label);
  return entry ? genKind(entry.id) : null;
};
// параметры стрельбы для GUNS в main.js: шаблон + переопределения из записи
// режим огня пушки с modes: сохранённый ('semi' | 'auto') или по auto записи
export const genFireMode = (entry) => {
  let mode = null;
  try {
    mode = localStorage.getItem(`scene.gen.${entry.id}.mode`);
  } catch {
    // без хранилища — по записи
  }
  return entry.modes?.includes(mode) ? mode : entry.auto ? 'auto' : 'semi';
};
export const genGunParams = (entry) => {
  const out = { ...(entry.auto ? GUN_AUTO : GUN_SEMI) };
  for (const key of FIRE_KEYS) if (key in entry && key !== 'auto') out[key] = entry[key];
  if (entry.modes?.length > 1) out.auto = genFireMode(entry) === 'auto'; // звук/вспышка — по записи
  return out;
};
