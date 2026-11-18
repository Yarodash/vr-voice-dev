// Прогрессия боя (просьба пользователя): 4 стадии. В начале сцены — только маленькие псы и никаких
// коптеров; с каждой стадией псы крупнее (доля крупных растёт), коптеры появляются со 2-й стадии
// и тоже по ступеням: маленькие → средние → большие (+ огромные).
//
// Время — ИГРОВОЕ (shared.sceneNowMs, идёт с «Время ×N»), с начала боя: shared.battleStartMs ставит
// стая псов (robodog-horde.js) при старте/рестарте боя. Стадии и веса — здесь, в одном месте.
//
// battleSeconds(shared)     — сколько игровых секунд идёт бой (0, если не начат)
// stageOf(t)                — номер стадии 1..6
// dogSizeWeights(t)         — веса размеров псов [маленький, средний, большой, огромный] (4 — «огромный» делится
//                             на огромный/гигантский/колоссальный) или все 7 размеров (стадии 5–6)
// droneSizeWeights(t)       — веса размеров коптеров [маленький, средний, большой, огромный]; все 0 — коптеров нет
// dronesAllowed(t)          — 0..1: доля обычного числа коптеров на сторону
// dogsAllowed(t)            — 0..1: доля обычного предела живых псов на сторону

// начало стадий 2, 3, 4 — в игровых секундах боя
// 5 «Конец 2» и 6 «Конец 3» (по просьбе) — дальше по времени; их можно и выбрать в «Эпохе»
export const STAGE_FROM = [0, 120, 300, 540, 840, 1200, 1620];

const STAGES = [
  // 1: только маленькие псы, коптеров нет
  { dogs: [1, 0, 0, 0], drones: [0, 0, 0, 0], droneShare: 0, dogShare: 0.2 },
  // 2: маленькие и средние псы; маленькие коптеры (половина обычного числа)
  { dogs: [3, 2, 0, 0], drones: [1, 0, 0, 0], droneShare: 0.3, dogShare: 0.4 },
  // 3: появляются большие псы; коптеры маленькие и средние
  { dogs: [2, 3, 2, 0], drones: [2, 2, 0, 0], droneShare: 0.6, dogShare: 0.7 },
  // 4: крупных больше всего, огромные псы; коптеры всех размеров
  { dogs: [1, 2, 3, 2], drones: [1, 2, 2, 1], droneShare: 1, dogShare: 1 },
  // 5 «Конец 2»: ещё крупнее — веса по 7 размерам [мал, сред, бол, огр, гигантский, колоссальный, титанический]
  { dogs: [1, 1, 2, 3, 3, 2, 0], drones: [1, 2, 2, 1], droneShare: 1, dogShare: 1 },
  // 6 «Конец 3»: неимоверно огромные — колоссы и титаны
  { dogs: [1, 1, 1, 2, 3, 3, 1.5], drones: [1, 2, 2, 1], droneShare: 1, dogShare: 1 },
  // 7 «Конец 4»: исполины — в 4 раза выше титанов (8-й размер)
  { dogs: [1, 1, 1, 2, 2, 3, 2, 1], drones: [1, 2, 2, 1], droneShare: 1, dogShare: 1 },
];

export function battleSeconds(shared) {
  if (shared?.battleStartMs == null || shared?.sceneNowMs == null) return 0;
  return Math.max(0, (shared.sceneNowMs - shared.battleStartMs) / 1000);
}

export function stageOf(t) {
  let s = 1;
  for (let i = 1; i < STAGE_FROM.length; i += 1) if (t >= STAGE_FROM[i]) s = i + 1;
  return s;
}

export function dogSizeWeights(t) {
  return STAGES[stageOf(t) - 1].dogs;
}

export function droneSizeWeights(t) {
  return STAGES[stageOf(t) - 1].drones;
}

// 0..1: доля обычного предела живых псов на сторону (в начале мало, к «Концу» — как было)
export function dogsAllowed(t) {
  return STAGES[stageOf(t) - 1].dogShare;
}

export function dronesAllowed(t) {
  return STAGES[stageOf(t) - 1].droneShare;
}

// выбрать индекс по весам (r — случайное 0..1); −1, если все веса 0
export function pickWeighted(weights, r = Math.random()) {
  let sum = 0;
  for (let i = 0; i < weights.length; i += 1) sum += weights[i];
  if (sum <= 0) return -1;
  let x = r * sum;
  for (let i = 0; i < weights.length; i += 1) {
    x -= weights[i];
    if (x < 0) return i;
  }
  return weights.length - 1;
}

// названия стадий (так их называет пользователь) — пункты «Настройки ▸ Эпоха ▸ …»
export const STAGE_NAMES = ['Начало', 'Середина 1', 'Середина 2', 'Конец', 'Конец 2', 'Конец 3', 'Конец 4'];

// перейти в стадию n (1..4) прямо сейчас: сдвинуть начало боя так, будто прошло STAGE_FROM[n−1] с
export function setStage(shared, n) {
  if (shared?.sceneNowMs == null) return;
  const i = Math.max(1, Math.min(STAGE_FROM.length, n)) - 1;
  shared.battleStartMs = shared.sceneNowMs - STAGE_FROM[i] * 1000 - 1;
}


