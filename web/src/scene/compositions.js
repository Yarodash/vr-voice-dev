// Сцены (композиции): сохранённое состояние мира и режим, который с ним включается.
//
// Сцена — { name, savedAt, features, data, live } в localStorage 'scene.compositions':
//   data — снимок, с которым сцену сохранили: оружие (вид, положение), висящие тарелки, мишени
//     (где стойки, какая стоит, какая лежит и как, следы от пуль), счёт; null — пустое поле.
//   live — последнее состояние сцены (пока она активна, main.js пишет его раз в несколько секунд,
//     при подмене сцены, уходе со страницы и переключении на другую сцену).
//   features — что в этой сцене есть, кроме предметов: targets — мишени и подменю «Мишени»,
//     spawn — подменю «Заспавнить» и пункт «Хват», xPlate — X спавнит тарелку, score — счёт
//     (score.js). Новая сцена может завести свои флаги: main.js и menu.js смотрят только на них.
// Меню «Сцены ▸ <имя> ▸»: «Продолжить» — live (или data), как было; «Рестарт» — freshOf(data):
// мишени стоят, дырок и тарелок нет, счёт 0, оружие на сохранённых местах. Перезагрузка страницы —
// как «Продолжить» для активной сцены.
// Активная сцена — 'scene.active' = { name, features } (name: null — ни одна). Нет ключа вообще —
// страница ещё из времён до сцен: это тир (RANGE).
// Оружие и тарелки по ходу игры сохраняют себя сами (pistols.js / clays.js); мишени и счёт после
// перезагрузки берутся из live активной сцены (main.js: applyScene).

const LIST_KEY = 'scene.compositions';
const ACTIVE_KEY = 'scene.active';

export const RANGE_FEATURES = { targets: true, spawn: true, xPlate: true, score: false, car: false, robodog: false, robodogHorde: false }; // тир («Сцена 1»)
// car — машина (car.js), её положение в data.car / live.car; robodog — робопёс-одиночка
// (robodog.js), в снимке только { alive } (data.robodog / live.robodog); robodogHorde — стая
// робопсов бежит на игрока (robodog-horde.js, «Сцена 3»), в снимке ничего
export const EMPTY_FEATURES = { targets: false, spawn: false, xPlate: false, score: false, car: false, robodog: false, robodogHorde: false }; // пустое поле
// Счёт выключен везде (пользователь убрал его из всех сцен): score.js остался, чтобы вернуть —
// убрать «score: false» отсюда и включить флаг сценам.
const features = (saved) => ({ ...EMPTY_FEATURES, ...saved, score: false });

export function loadCompositions() {
  try {
    const list = JSON.parse(localStorage.getItem(LIST_KEY));
    return Array.isArray(list)
      ? list.filter((entry) => entry && typeof entry.name === 'string').map((entry) => ({ ...entry, features: features(entry.features) }))
      : [];
  } catch {
    return [];
  }
}

export function saveCompositions(list) {
  try {
    localStorage.setItem(LIST_KEY, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}

export function readActive(shared) {
  if (shared.activeScene) return shared.activeScene;
  let active = null;
  try {
    const saved = JSON.parse(localStorage.getItem(ACTIVE_KEY));
    if (saved && typeof saved === 'object') active = { name: saved.name ?? null, features: features(saved.features) };
  } catch {
    // нет сохранённого
  }
  active ??= { name: null, features: { ...RANGE_FEATURES } };
  shared.activeScene = active;
  return active;
}

export function writeActive(shared, name, features) {
  const active = { name: name ?? null, features: { ...EMPTY_FEATURES, ...features } };
  shared.activeScene = active;
  try {
    localStorage.setItem(ACTIVE_KEY, JSON.stringify(active));
  } catch {
    // без хранилища не переживёт перезагрузку
  }
  return active;
}

// последнее состояние сцены (для «Продолжить» и перезагрузки); json — уже строка снимка
export function storeLive(name, json) {
  if (!name) return false;
  const list = loadCompositions();
  const entry = list.find((e) => e.name === name);
  if (!entry) return false;
  entry.live = JSON.parse(json);
  return saveCompositions(list);
}

// машину поставили впервые: её место — часть сцены (и для «Рестарт», и для «Продолжить»)
export function storeCarPose(name, pose) {
  const list = loadCompositions();
  const entry = list.find((e) => e.name === name);
  if (!entry) return false;
  entry.data = { ...(entry.data ?? { version: 1 }), car: pose };
  if (entry.live) entry.live.car = pose;
  return saveCompositions(list);
}

// разовый перенос: «Сцена 2» получает машину
export function migrateCarScene() {
  const KEY = 'scene.carMigrated';
  try {
    if (localStorage.getItem(KEY)) return false;
    const list = loadCompositions();
    const entry = list.find((e) => e.name === 'Сцена 2');
    if (entry) {
      entry.features = { ...entry.features, car: true };
      saveCompositions(list);
    }
    localStorage.setItem(KEY, '1');
    return Boolean(entry);
  } catch {
    return false;
  }
}

// Разовый перенос: счёт выключен во всех сценах, у «Сцены 1» робопса больше нет, и появляется
// «Сцена 3» — пустое поле со стаей робопсов (без мишеней, оружие спавнится, X — тарелка).
// Возвращает true, если список сцен поменялся (активную сцену надо перечитать).
export const HORDE_FEATURES = { ...EMPTY_FEATURES, spawn: true, xPlate: true, robodogHorde: true };
export function migrateHordeScenes() {
  const KEY = 'scene.hordeMigrated';
  try {
    if (localStorage.getItem(KEY)) return false;
    const list = loadCompositions();
    for (const entry of list) {
      entry.features = { ...entry.features, score: false };
      if (entry.name === 'Сцена 1') entry.features.robodog = false;
    }
    if (!list.some((e) => e.features?.robodogHorde)) {
      const empty = { version: 1, weapons: [], clays: [], targets: null, score: null };
      const name = list.some((e) => e.name === 'Сцена 3') ? nextName(list) : 'Сцена 3';
      list.push({ name, savedAt: new Date().toISOString(), features: { ...HORDE_FEATURES }, data: empty, live: empty });
    }
    saveCompositions(list);
    localStorage.setItem(KEY, '1');
    return true;
  } catch {
    return false;
  }
}

export function nextName(list) {
  const taken = new Set(list.map((entry) => entry.name));
  let n = list.length + 1;
  while (taken.has(`Сцена ${n}`)) n += 1;
  return `Сцена ${n}`;
}

// числа короче: 5 знаков после запятой (миллиметры с запасом)
const round = (value) =>
  Array.isArray(value)
    ? value.map(round)
    : typeof value === 'number'
      ? Math.round(value * 1e5) / 1e5
      : value && typeof value === 'object'
        ? Object.fromEntries(Object.entries(value).map(([key, v]) => [key, round(v)]))
        : value;

// Что сейчас в мире (простой JSON).
export function snapshot({ pistols, clays, shooting, score, car, robodog }) {
  return round({
    ...(car?.pose() ? { car: car.pose() } : {}),
    ...(robodog?.state() ? { robodog: robodog.state() } : {}),
    version: 1,
    weapons: pistols.items.map((item) => ({
      kind: item.kind,
      position: item.group.position.toArray(),
      quaternion: item.group.quaternion.toArray(),
    })),
    clays: clays.list.filter((clay) => clay.state !== 'fly').map((clay) => ({ p: clay.p.toArray(), q: clay.q.toArray() })),
    targets: shooting.getTargets(),
    score: score?.get() ?? null,
  });
}

// «Рестарт»: та же сцена, но ещё никто не стрелял — оружие на сохранённых местах, мишени стоят на
// своих стойках, без дырок, тарелок нет, счёт 0, робопёс жив (появится заново перед игроком).
export function freshOf(data) {
  const targets = data?.targets?.stands ? { layout: data.targets.layout, stands: data.targets.stands } : data?.targets ? {} : null;
  return { version: 1, weapons: [] /* рестарт: без оружия — его спавнят из меню */, clays: [], targets, score: { score: 0, streak: 0 }, ...(data?.car ? { car: data.car } : {}) };
}
