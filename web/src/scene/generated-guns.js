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
export const GEN_PREFIX = 'gen:';

// Стрельба по умолчанию (как в main.js GUNS): auto — как калаш, иначе — как пистолет.
export const GUN_AUTO = { gapMs: 90, auto: true, kickMs: 60, kickRad: 0.02, kickBackM: 0.005, climbRad: 0.006, buzz: 0.7, speed: 900, flash: true, sound: 'ak', shotKind: 'ak', rifleCasing: true, autoAim: 0, projectile: null, projectileColor: null, gravity: null, homing: null, charge: null };
export const GUN_SEMI = { gapMs: 0, auto: false, kickMs: 140, kickRad: 0.2, kickBackM: 0, climbRad: 0, buzz: 0.8, speed: 360, flash: false, sound: 'pistol', shotKind: 'pistol', rifleCasing: false, autoAim: 0, projectile: null, projectileColor: null, gravity: null, homing: null, charge: null };

export const GENERATED_GUNS = [
  {
    id: 'm16', name: 'М16', length: 1.0, auto: true, modes: ['semi', 'auto'], shape: 'rifle', card: true, glb: true, v: 1,
    scope: { eyepiece: [810, 483], objective: [1508, 485], radiusPx: 50.6, objectiveRadiusPx: 37.4, zoom: 2, offset: [-0.003, -0.003, 0] },
    trigger: { box: [1018, 822, 1060, 893] },
  },
  // штурмовая винтовка в духе аркадных шутеров 2000-х (по просьбе: «М-ка в стиле Serious Sam»); пока картинка, без 3D
  // снайперка «киберпанк + космос/галактика» (по просьбе из шлема)
  { id: 'cosmo_sniper', name: 'Космо-снайперка', length: 1.25, auto: false, shape: 'sniper', card: true, glb: true, v: 4, spawnOnAdd: true, grip: [0.272, 0.585], big: 1.9, gapMs: 1800, projectile: 'blackhole', charge: { minS: 0.3, maxS: 3 }, kickRad: 0.12, buzz: 1 }, // стреляет чёрными дырами (blackhole.js): держать курок — заряд, отпустить — выстрел; grip задан вручную: сама рукоять нашлась у приклада
  { id: 'sam_rifle', name: 'Сэм-винтовка', length: 0.775, auto: true, modes: ['semi', 'auto'], shape: 'rifle', card: true, glb: true, v: 4, autoAim: 15, projectile: 'mana', sound: 'mana', speed: 100, homing: { delayS: 0.04, turnDegS: 240 } }, // мана: сгусток виден в полёте (100 м/с) и доворачивает к цели дугой; v2 — «в стиле природы», v3 — + синяя мана, v4 — 3D (Tripo medium)
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
