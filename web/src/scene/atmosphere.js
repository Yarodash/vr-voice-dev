// Атмосфера: погода, время суток, сезон и стиль неба — одно состояние `now` с плавными переходами.
// Контракт (имена полей и id менять нельзя, по нему пишут world.js, weather-fx.js, weather-sound.js):
// docs/agents/atmosphere.md. Этот модуль — единственный, кто пишет в `now`; остальные только читают.
//
// Как устроено (подробнее — «How it works» в docs/agents/atmosphere.md):
// - четыре независимых канала: погода (вектор чисел WF из таблицы WEATHERS), час суток (0..24, по кругу
//   кратчайшей дорогой), веса сезонов и веса стилей неба. Каждый `set…` запоминает ТЕКУЩИЕ значения канала
//   как начало и ведёт их к цели за N реальных секунд (smoothstep) — перебить можно в любой момент, скачка нет;
// - всё остальное в `now` (солнце, луна, свет, цвет тумана, радуга) каждый кадр считается из этих каналов —
//   непрерывные функции, поэтому любые переходы плавные сами собой;
// - медленные накопители (wet, puddles, snowCover, gust, направление ветра), молнии, авто-погода и течение
//   суток идут по ИГРОВОМУ времени (dt мира, «Время ×N»).
// Состояние переживает подмену сцены (новый объект берёт значения прежнего из shared.atmosphere) и
// перезагрузку страницы (localStorage 'scene.atmo').
const STORE_KEY = 'scene.atmo';
const CARRY_V = 2; // формат carry(): поменял поля состояния — увеличь, иначе новая версия возьмёт чужие поля
const DEG = Math.PI / 180;

// ---------- погода: поля, которые задаёт пресет (порядок = порядок в массивах смешивания)
const WF = ['cloudCover', 'cloudDark', 'sunDirect', 'fog', 'visibilityM', 'wind', 'rain', 'snow', 'hail', 'sleet', 'dust', 'smoke', 'leaves', 'lightning', 'rainbow'];
const VIS = WF.indexOf('visibilityM'); // смешивается в логарифме: 20 км → 30 м идёт равномерно на глаз
const I_DIRECT = WF.indexOf('sunDirect');
const I_WIND = WF.indexOf('wind');
const I_RAIN = WF.indexOf('rain');
const I_SNOW = WF.indexOf('snow');
const I_HAIL = WF.indexOf('hail');
const I_SLEET = WF.indexOf('sleet');
const I_LIGHTNING = WF.indexOf('lightning');
const I_RAINBOW = WF.indexOf('rainbow');
const SNOW_FLOOR = 0.8; // зимой снег лежит и без снегопада не ниже этого
const SKY_MATCH = 0.1; // на какую долю яркости неба дальний предмет в тумане может отличаться от неба за ним
const AMBIENT_FLOOR = 0.3; // самый слабый рассеянный свет на предметах (пасмурная глубокая ночь)
export const KEY_SWITCH_ELEV = -5.5; // градусов высоты солнца: ниже — главный свет от луны (то же число — в sky-palettes.js)
const KEY_MIN_ELEV = 22; // градусов: главный свет (keyDir) не ниже — как «солнце для теней» в world.js (SHADOW_ELEVATION)
const w = (id, name, cloudCover, cloudDark, sunDirect, fog, visibilityM, wind, rest = {}) => ({
  id,
  name,
  v: { cloudCover, cloudDark, sunDirect, fog, visibilityM, wind, rain: 0, snow: 0, hail: 0, sleet: 0, dust: 0, smoke: 0, leaves: 0, lightning: 0, rainbow: 0, ...rest },
});
// partlyCloudy — «как было до атмосферы»: те же кучевые облака, обычный ветер, прямое солнце
export const WEATHERS = [
  //  id              имя                      cover dark  direct fog   видимость ветер
  w('clear', 'Ясно', 0.04, 0.0, 1.0, 0.0, 20000, 0.15),
  w('partlyCloudy', 'Переменная облачность', 0.35, 0.05, 1.0, 0.03, 16000, 0.3),
  w('overcast', 'Пасмурно', 1.0, 0.45, 0.04, 0.15, 6000, 0.3),
  w('drizzle', 'Морось', 0.92, 0.4, 0.08, 0.14, 5000, 0.25, { rain: 0.15 }),
  w('rain', 'Дождь', 1.0, 0.6, 0.02, 0.32, 1800, 0.4, { rain: 0.5 }),
  w('heavyRain', 'Ливень', 1.0, 0.82, 0.0, 0.58, 420, 0.6, { rain: 1.0 }),
  w('thunderstorm', 'Гроза', 1.0, 1.0, 0.0, 0.55, 500, 0.8, { rain: 0.9, lightning: 1.0 }),
  w('lightSnow', 'Лёгкий снег', 0.85, 0.25, 0.15, 0.12, 5000, 0.15, { snow: 0.25 }),
  w('blizzard', 'Метель', 1.0, 0.5, 0.0, 0.78, 140, 1.0, { snow: 1.0 }),
  w('hail', 'Град', 1.0, 0.85, 0.02, 0.3, 1500, 0.6, { hail: 0.8, rain: 0.25, lightning: 0.25 }),
  w('sleet', 'Дождь со снегом', 1.0, 0.6, 0.02, 0.32, 1800, 0.45, { sleet: 0.7, rain: 0.2, snow: 0.12 }),
  w('mist', 'Дымка', 0.3, 0.05, 0.7, 0.4, 900, 0.1),
  w('denseFog', 'Густой туман', 0.6, 0.2, 0.12, 1.0, 40, 0.05),
  w('windy', 'Ветрено', 0.4, 0.1, 0.9, 0.05, 12000, 1.0, { leaves: 0.8, dust: 0.1 }),
  w('dustStorm', 'Пыльная буря', 0.5, 0.3, 0.22, 0.82, 110, 1.1, { dust: 1.0, leaves: 0.3 }),
  w('sunshower', 'Слепой дождь', 0.4, 0.12, 0.85, 0.06, 9000, 0.25, { rain: 0.4, rainbow: 1.0 }),
  w('smog', 'Смог', 0.5, 0.3, 0.3, 0.62, 280, 0.08, { smoke: 1.0 }),
  w('hurricane', 'Ураган', 1.0, 0.95, 0.0, 0.62, 280, 1.5, { rain: 1.0, leaves: 1.0, lightning: 0.35 }),
];
export const WEATHER_GROUPS = [
  { name: 'Ясно и облака', ids: ['clear', 'partlyCloudy', 'overcast'] },
  { name: 'Дождь', ids: ['drizzle', 'rain', 'heavyRain', 'thunderstorm', 'sunshower', 'hurricane'] },
  { name: 'Снег и лёд', ids: ['lightSnow', 'blizzard', 'hail', 'sleet'] },
  { name: 'Туман и ветер', ids: ['mist', 'denseFog', 'windy', 'dustStorm', 'smog'] },
];

// ---------- сезоны: высота солнца в полдень (градусы) — летом выше, зимой ниже
export const SEASONS = [
  { id: 'spring', name: 'Весна', peak: 48 },
  { id: 'summer', name: 'Лето', peak: 62 },
  { id: 'autumn', name: 'Осень', peak: 42 },
  { id: 'winter', name: 'Зима', peak: 24 },
];
const SUMMER = 1;
const WINTER = 3;

// ---------- путь солнца. Мир: игрок по умолчанию смотрит на −Z («юг»), запад — справа (+X), восток слева.
// Солнце идёт по большому кругу через точки востока и запада, наклонённому к югу на высоту полудня `peak`:
//   dir(H) = sin H · запад + cos H · (cos peak · юг + sin peak · вверх),  H = (час − 12) · 15°.
// Восход всегда в 6:00 слева, заход в 18:00 справа; сезон меняет только высоту дуги.
// Закат (пресет `sunset`) обязан давать РОВНО прежнее солнце world.js: SUN_ELEVATION 2,2°, SUN_AZIMUTH −8°
// (setFromSphericalCoords(1, 90° − 2,2°, 90° − 8°)) — из этого находятся час пресета и поворот осей «запад/юг».
const SUNSET_ELEV = 2.2;
export const SUNSET_AZ = 8; // градусов от +X к +Z (то, что world.js называет SUN_AZIMUTH = −8)
const SUMMER_PEAK = SEASONS[SUMMER].peak * DEG;
const SUNSET_H = Math.acos(Math.sin(SUNSET_ELEV * DEG) / Math.sin(SUMMER_PEAK)); // часовой угол заката летом
const SUNSET_HOUR = 12 + SUNSET_H / DEG / 15;
const WEST_ANGLE = SUNSET_AZ * DEG + Math.atan2(Math.cos(SUNSET_H) * Math.cos(SUMMER_PEAK), Math.sin(SUNSET_H));
const WEST_X = Math.cos(WEST_ANGLE);
const WEST_Z = Math.sin(WEST_ANGLE);
const SOUTH_X = Math.sin(WEST_ANGLE);
const SOUTH_Z = -Math.cos(WEST_ANGLE);
// Луна — «полная»: по такой же дуге почти напротив солнца (всходит минут через 50 после заката, ночью
// высоко, на рассвете ещё видна на западе); зимой её дуга выше, летом ниже — как у настоящей.
const MOON_LAG = (180 - 12) * DEG;
const moonPeak = (sunPeak) => 86 * DEG - sunPeak * 0.6;

// ---------- времена суток (час; закат — вычислен выше)
export const TIMES = [
  { id: 'preDawn', name: 'Предрассветные сумерки', hour: 5.25 },
  { id: 'dawn', name: 'Рассвет', hour: 6.27 },
  { id: 'morning', name: 'Утро', hour: 8.5 },
  { id: 'noon', name: 'Полдень', hour: 12 },
  { id: 'afternoon', name: 'День', hour: 15 },
  { id: 'goldenHour', name: 'Золотой час', hour: 17.25 },
  { id: 'sunset', name: 'Закат', hour: SUNSET_HOUR },
  { id: 'dusk', name: 'Сумерки', hour: 18.6 },
  { id: 'night', name: 'Ночь', hour: 21.5 },
  { id: 'midnight', name: 'Глубокая ночь', hour: 0 },
];
export const TIME_GROUPS = [
  { name: 'Утро и день', ids: ['preDawn', 'dawn', 'morning', 'noon', 'afternoon'] },
  { name: 'Вечер и ночь', ids: ['goldenHour', 'sunset', 'dusk', 'night', 'midnight'] },
];

// ---------- стили неба: палитра света на предметах и дымки у горизонта по высоте солнца.
// Четыре опорные высоты: N — ночь (≤ −14°), T — сумерки (−5°), L — низкое солнце (+2,2°, как на закате),
// D — день (≥ 35°). В каждой: sun — цвет и сила направленного света (ночью это луна), amb — рассеянного,
// fog — цвет дымки у горизонта (линейный, «готовый для экрана», как цвета неба в world.js).
// Розовый стиль — прежний мультяшный вид: свет на предметах нейтрально-белый, на закате ровно 1 × 1.
const ANCHORS = [-14, -5, SUNSET_ELEV, 35]; // градусы высоты солнца: N, T, L, D
const style = (id, name, N, T, L, D) => ({ id, name, keys: [N, T, L, D] });
const k = (sun, sunPow, amb, ambPow, fog) => ({ sun, sunPow, amb, ambPow, fog });
export const SKIES = [
  style(
    'pink',
    'Розовое',
    // fog во всех стилях — горизонт неба из sky-palettes.js на этих высотах: mix(horizonFar, horizonSun, 0.35);
    // поменялась палитра неба — обнови и эти числа, иначе в лёгкой дымке предметы уйдут не в цвет горизонта
    k([0.7, 0.8, 1.0], 0.3, [0.55, 0.62, 1.0], 0.42, [0.075, 0.037, 0.102]),
    k([1.0, 0.8, 0.86], 0.3, [0.8, 0.74, 1.0], 0.62, [0.243, 0.077, 0.102]),
    k([1.0, 1.0, 1.0], 1.0, [1.0, 1.0, 1.0], 1.0, [0.363, 0.135, 0.146]),
    k([1.0, 0.98, 0.96], 1.3, [1.0, 0.96, 0.98], 1.12, [0.737, 0.573, 0.785]),
  ),
  style(
    'gold',
    'Золотое',
    k([0.9, 0.86, 0.72], 0.3, [0.6, 0.58, 0.72], 0.42, [0.104, 0.063, 0.042]),
    k([1.0, 0.62, 0.4], 0.3, [0.85, 0.7, 0.75], 0.6, [0.35, 0.165, 0.063]),
    k([1.0, 0.72, 0.42], 1.05, [1.0, 0.86, 0.7], 0.95, [0.545, 0.319, 0.099]),
    k([1.0, 0.95, 0.84], 1.3, [1.0, 0.96, 0.88], 1.1, [0.96, 0.785, 0.465]),
  ),
  style(
    'blue',
    'Синее',
    k([0.66, 0.78, 1.0], 0.3, [0.45, 0.58, 1.0], 0.42, [0.036, 0.036, 0.062]),
    k([0.9, 0.6, 0.55], 0.28, [0.55, 0.66, 1.0], 0.6, [0.239, 0.134, 0.126]),
    k([1.0, 0.7, 0.45], 1.0, [0.9, 0.86, 0.95], 0.92, [0.519, 0.353, 0.334]),
    k([1.0, 0.97, 0.92], 1.35, [0.86, 0.93, 1.0], 1.12, [0.532, 0.695, 0.898]),
  ),
  style(
    'cosmic',
    'Космическое',
    k([0.6, 0.95, 0.9], 0.32, [0.45, 0.62, 0.95], 0.44, [0.036, 0.06, 0.094]),
    k([0.8, 0.5, 1.0], 0.3, [0.5, 0.6, 1.0], 0.6, [0.223, 0.093, 0.204]),
    k([1.0, 0.66, 0.86], 0.95, [0.72, 0.7, 1.0], 0.9, [0.358, 0.183, 0.303]),
    k([0.92, 0.96, 1.0], 1.2, [0.72, 0.92, 0.95], 1.0, [0.452, 0.316, 0.719]),
  ),
];
const SKY_IDS = SKIES.map((s) => s.id);

// яркость «освещённой дымки» по опорным высотам (ночью туман тёмный, но не чёрный)
const DAY_LEVEL = [0.05, 0.24, 0.62, 1.0];

// ---------- авто-погода: вес каждой погоды по сезону (0 — не бывает)
const AUTO = {
  spring: { clear: 2, partlyCloudy: 3, overcast: 2, drizzle: 2, rain: 2.5, heavyRain: 1, thunderstorm: 1, sunshower: 1.5, sleet: 0.8, mist: 1.2, denseFog: 0.6, windy: 1.5, hail: 0.5, lightSnow: 0.3 },
  summer: { clear: 3, partlyCloudy: 4, overcast: 1, drizzle: 1, rain: 2, heavyRain: 1, thunderstorm: 2, sunshower: 1.5, windy: 1, mist: 0.7, dustStorm: 0.5, hail: 0.3, smog: 0.3, hurricane: 0.2, denseFog: 0.2 },
  autumn: { clear: 1.5, partlyCloudy: 2.5, overcast: 3, drizzle: 2.5, rain: 3, heavyRain: 1.5, thunderstorm: 0.5, sleet: 1, mist: 2, denseFog: 1.5, windy: 2.5, hurricane: 0.4, lightSnow: 0.4, smog: 0.5 },
  winter: { clear: 2, partlyCloudy: 2, overcast: 3, lightSnow: 4, blizzard: 2, sleet: 1, mist: 1, denseFog: 1, windy: 1.5, hail: 0.2 },
};
const AUTO_MIN_S = 150; // игровых секунд между сменами
const AUTO_MAX_S = 360;
const AUTO_BLEND_S = 40; // сама смена — медленнее ручной

export const FLOW_STEPS = [0, 10, 30, 120]; // «Течение суток»: минут на сутки (0 — стоит)

// wind: null — ветер сам выбирает направление; число — градусы, куда он дует (setWind)
export const DEFAULTS = { weather: 'partlyCloudy', time: 'sunset', season: 'summer', sky: 'pink', flow: 0, auto: false, wind: null };
const OVERCAST0 = (() => {
  const v = WEATHERS.find((e) => e.id === DEFAULTS.weather).v;
  return v.cloudCover * (0.35 + 0.65 * v.cloudDark);
})();
const BASE_WIND_ANGLE = Math.atan2(0.3, 1); // куда дул ветер world.js до атмосферы: к закату (+X) и чуть к игроку

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth01 = (t) => {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
};
const smoothstep = (a, b, x) => smooth01((x - a) / (b - a));
const wrap24 = (h) => ((h % 24) + 24) % 24;
const weatherById = (id) => WEATHERS.find((e) => e.id === id) ?? null;
const timeById = (id) => TIMES.find((e) => e.id === id) ?? null;
// пресет времени, в чей отрезок попадает час (для пометки в меню, пока сутки текут)
const TIMES_BY_HOUR = [...TIMES].sort((a, b) => a.hour - b.hour);
const periodOf = (hour) => {
  let found = TIMES_BY_HOUR[TIMES_BY_HOUR.length - 1];
  for (let i = 0; i < TIMES_BY_HOUR.length; i += 1) if (TIMES_BY_HOUR[i].hour <= hour + 1e-6) found = TIMES_BY_HOUR[i];
  return found.id;
};

export function createAtmosphere({ THREE, camera = null, shared = (globalThis.__sceneState ??= {}) }) {
  // прежний объект (подмена сцены): продолжаем с его значений. Формат carry() другой (правили этот файл) —
  // не берём, состояние восстановится из localStorage
  let prev = null;
  try {
    const carried = shared.atmosphere?.carry?.();
    if (carried && carried.v === CARRY_V && carried.w?.length === WF.length) prev = carried;
  } catch (error) {
    console.warn('[atmo] прежнее состояние не взято:', error);
  }

  // ---------- что выбрано
  const target = { ...DEFAULTS };
  let savedHour = null;
  let savedWind = null; // обычное направление ветра, рад (первый запуск — прежнее, BASE_WIND_ANGLE)
  if (prev) Object.assign(target, prev.target);
  else {
    try {
      const saved = JSON.parse(localStorage.getItem(STORE_KEY) ?? 'null');
      if (saved && typeof saved === 'object') {
        if (weatherById(saved.weather)) target.weather = saved.weather;
        if (timeById(saved.time)) target.time = saved.time;
        if (SEASONS.some((s) => s.id === saved.season)) target.season = saved.season;
        if (SKY_IDS.includes(saved.sky)) target.sky = saved.sky;
        if (Number.isFinite(saved.flow) && saved.flow >= 0) target.flow = saved.flow;
        target.auto = Boolean(saved.auto);
        if (Number.isFinite(saved.hour)) savedHour = wrap24(saved.hour);
        if (Number.isFinite(saved.wind)) target.wind = ((saved.wind % 360) + 360) % 360;
        if (Number.isFinite(saved.windDeg)) savedWind = saved.windDeg * DEG;
      }
    } catch {
      // без хранилища — по умолчанию
    }
  }
  // точный час цели: пресет, а если сохранён свой час (сутки текли или setTime(число)) — он
  const presetHour = timeById(target.time).hour;
  const startHour = savedHour !== null && Math.abs(((savedHour - presetHour + 36) % 24) - 12) > 0.01 ? savedHour : presetHour;

  // ---------- изменяемые числа — полями одного объекта: запись числа в поле объекта ничего не выделяет в
  // куче, а запись в переменную замыкания выделяла бы новое число каждый кадр
  const st = {
    rev: 1, // растёт при любой смене выбора (ключ пересборки меню)
    saveIn: 0,
    // каналы: t — доля пути 0..1, dur — секунд на весь путь
    wT: 1,
    wDur: 1,
    sT: 1,
    sDur: 1,
    kT: 1,
    kDur: 1,
    hour: startHour,
    hourTarget: startHour, // точный час цели (setTime(число) — не обязательно пресет)
    hFrom: startHour,
    hDelta: 0,
    hT: 1,
    hDur: 1,
    // накопители
    wet: 0,
    puddles: 0,
    snow: 0,
    rainbowAfter: 0, // «после дождя»: радуга ещё держится, когда выглянуло солнце
    gust: 0,
    gustGoal: 0,
    gustIn: 0,
    windT: Math.random() * 1000, // фаза блуждания направления ветра
    // направление ветра: обычное (рад, куда дует: 0 — к +X, π/2 — к +Z) доворачивается к цели за время смены погоды
    windBase: savedWind ?? BASE_WIND_ANGLE,
    windGoal: savedWind ?? BASE_WIND_ANGLE,
    windFrom: savedWind ?? BASE_WIND_ANGLE,
    windDelta: 0,
    windTurnT: 1,
    windTurnDur: 1,
    gustSide: 0, // в какую сторону отклоняет ветер нынешний порыв, −1..1
    gustTurn: 0, // само отклонение, рад (плавно идёт к gustSide · сила порыва)
    autoIn: AUTO_MIN_S + Math.random() * (AUTO_MAX_S - AUTO_MIN_S),
    // молнии
    strikeIn: -1, // с до следующей (−1 — не запланирована)
    pulses: 0,
    flash: 0,
    // калибровка: в состоянии по умолчанию свет и тени ровно 1 (как до атмосферы)
    calSun: 1,
    calAmb: 1,
    calShadow: 1,
  };
  const save = () => {
    try {
      // час: пока сутки текут — где они сейчас; иначе — куда ведёт переход (а не его середина)
      const windDeg = Math.round(((((st.windGoal / DEG) % 360) + 360) % 360) * 10) / 10;
      localStorage.setItem(STORE_KEY, JSON.stringify({ ...target, hour: Math.round((target.flow > 0 && st.hT >= 1 ? st.hour : st.hourTarget) * 1000) / 1000, windDeg }));
    } catch {
      // без хранилища выбор не переживёт перезагрузку
    }
  };

  // ---------- каналы смешивания: начало, цель, текущее
  const N = WF.length;
  const wFrom = new Float64Array(N);
  const wTo = new Float64Array(N);
  const wCur = new Float64Array(N);
  const loadWeather = (out, id) => {
    const v = weatherById(id).v;
    for (let i = 0; i < N; i += 1) out[i] = i === VIS ? Math.log(v.visibilityM) : v[WF[i]];
  };
  const sFrom = new Float64Array(4);
  const sTo = new Float64Array(4);
  const sCur = new Float64Array(4);
  const kFrom = new Float64Array(4);
  const kTo = new Float64Array(4);
  const kCur = new Float64Array(4);
  const oneHot = (out, index) => {
    out.fill(0);
    out[index] = 1;
  };
  const seasonIndex = (id) => SEASONS.findIndex((s) => s.id === id);

  loadWeather(wTo, target.weather);
  wCur.set(wTo);
  wFrom.set(wTo);
  oneHot(sTo, seasonIndex(target.season));
  sCur.set(sTo);
  sFrom.set(sTo);
  oneHot(kTo, SKY_IDS.indexOf(target.sky));
  kCur.set(kTo);
  kFrom.set(kTo);

  // ---------- текущее состояние: один и тот же объект каждый кадр
  const now = {
    hour: startHour,
    sunDir: new THREE.Vector3(1, 0, 0),
    moonDir: new THREE.Vector3(-1, 0, 0),
    sunElev: SUNSET_ELEV,
    moonElev: -20, // градусы
    keyDir: new THREE.Vector3(1, 0.4, 0).normalize(), // К главному свету предметов и теней (солнце; ниже −5,5° — луна), не ниже 22°; меняется скачком, когда свет погас
    keyShadow: 1, // 0..1: насколько видны тени от главного света (× sunDirect, ночью ~0,4, 0 — в сумерках, пока светило меняется)
    day: 1,
    sunColor: new THREE.Color(1, 1, 1),
    ambientColor: new THREE.Color(1, 1, 1),
    sunPower: 1,
    ambientPower: 1,
    cloudCover: 0,
    cloudDark: 0,
    sunDirect: 1,
    fog: 0,
    visibilityM: 16000,
    fogColor: new THREE.Color(0.36, 0.135, 0.146),
    wind: 0.3,
    windDir: new THREE.Vector2(Math.cos(BASE_WIND_ANGLE), Math.sin(BASE_WIND_ANGLE)),
    gust: 0,
    rain: 0,
    snow: 0,
    hail: 0,
    sleet: 0,
    dust: 0,
    smoke: 0,
    leaves: 0,
    wet: 0,
    puddles: 0,
    snowCover: 0,
    lightning: 0,
    flash: 0,
    rainbow: 0,
    spring: 0,
    summer: 1,
    autumn: 0,
    winter: 0,
    sky: { pink: 1, gold: 0, blue: 0, cosmic: 0 },
  };

  // цвет неба низко над горизонтом без тумана и доля пелены там (см. derive); пока мира нет — ok = false
  const skyRef = (shared.atmoSkyRef ??= { r: 0, g: 0, b: 0, free: 1, ok: false });
  const tune = (shared.atmoTune ??= {}); // подстройка чисел из vr:eval без подмены сцены (пусто — значения из кода)
  const pulseAt = new Float64Array(3); // вспышка: до трёх всполохов (через сколько секунд) и их яркость
  const pulseAmp = new Float64Array(3);
  const listeners = { lightning: new Set() };
  const strike = { x: 0, y: 0, z: 0, distM: 0, power: 0 }; // один объект на все события (не хранить)
  const head = new THREE.Vector3();

  // накопители «как будто погода стоит давно»: после перезагрузки мир сразу в погоде, а не намокает с нуля
  const settleSlow = () => {
    const rainLike = wCur[I_RAIN] + wCur[I_SLEET] * 0.7 + wCur[I_HAIL] * 0.3;
    st.wet = clamp01(rainLike * 4);
    st.puddles = clamp01((wCur[I_RAIN] - 0.25) / 0.5);
    st.snow = Math.max(SNOW_FLOOR * sCur[WINTER], clamp01(wCur[I_SNOW] * 1.6));
    st.rainbowAfter = wCur[I_RAIN] > 0.2 ? 1 : 0;
  };
  settleSlow();

  if (prev) {
    // подмена сцены: каналы — с прежних значений, переходы доигрываются за оставшееся время
    wCur.set(prev.w);
    sCur.set(prev.s);
    kCur.set(prev.k);
    wFrom.set(wCur);
    sFrom.set(sCur);
    kFrom.set(kCur);
    for (const key of Object.keys(prev.st)) if (key in st && !key.startsWith('cal')) st[key] = prev.st[key];
    st.rev += 1;
    // начатые переходы — заново из текущих значений за оставшееся время
    const restart = (t, dur) => {
      const left = (1 - st[t]) * st[dur];
      st[t] = left > 0 ? 0 : 1;
      st[dur] = Math.max(0.01, left);
    };
    restart('wT', 'wDur');
    restart('sT', 'sDur');
    restart('kT', 'kDur');
    restart('hT', 'hDur');
    st.hFrom = st.hour;
    st.hDelta = st.hT < 1 ? ((st.hourTarget - st.hour + 36) % 24) - 12 : 0;
  }

  // ---------- расчёт производных полей
  const sunC = new Float64Array(3);
  const ambC = new Float64Array(3);
  const fogC = new Float64Array(3);
  const lift = (out, dir, minElevDeg) => {
    // направление с той же стороны, но не ниже minElev над горизонтом
    const hLen = Math.hypot(dir.x, dir.z) || 1;
    const elev = Math.max(Math.asin(Math.max(-1, Math.min(1, dir.y))), minElevDeg * DEG);
    const c = Math.cos(elev);
    return out.set((dir.x / hLen) * c, Math.sin(elev), (dir.z / hLen) * c);
  };

  const derive = () => {
    // --- сезон и стиль
    now.spring = sCur[0];
    now.summer = sCur[1];
    now.autumn = sCur[2];
    now.winter = sCur[3];
    now.sky.pink = kCur[0];
    now.sky.gold = kCur[1];
    now.sky.blue = kCur[2];
    now.sky.cosmic = kCur[3];
    // --- погода (поля по именам, а не циклом по WF: запись по вычисляемому имени выделяла бы числа в куче)
    now.cloudCover = wCur[0];
    now.cloudDark = wCur[1];
    now.sunDirect = wCur[2];
    now.fog = wCur[3];
    now.visibilityM = Math.exp(wCur[VIS]);
    now.wind = wCur[5];
    now.rain = wCur[6];
    now.snow = wCur[7];
    now.hail = wCur[8];
    now.sleet = wCur[9];
    now.dust = wCur[10];
    now.smoke = wCur[11];
    now.leaves = wCur[12];
    now.lightning = wCur[13];
    // --- солнце и луна
    const hour = st.hour;
    now.hour = hour;
    let peak = 0;
    for (let i = 0; i < 4; i += 1) peak += sCur[i] * SEASONS[i].peak;
    peak *= DEG;
    const H = (hour - 12) * 15 * DEG;
    const sinH = Math.sin(H);
    const cosH = Math.cos(H);
    const south = cosH * Math.cos(peak);
    now.sunDir.set(sinH * WEST_X + south * SOUTH_X, cosH * Math.sin(peak), sinH * WEST_Z + south * SOUTH_Z);
    now.sunElev = Math.asin(Math.max(-1, Math.min(1, now.sunDir.y))) / DEG;
    const mp = moonPeak(peak);
    const Hm = H + MOON_LAG;
    const mSouth = Math.cos(Hm) * Math.cos(mp);
    now.moonDir.set(Math.sin(Hm) * WEST_X + mSouth * SOUTH_X, Math.cos(Hm) * Math.sin(mp), Math.sin(Hm) * WEST_Z + mSouth * SOUTH_Z);
    now.moonElev = Math.asin(Math.max(-1, Math.min(1, now.moonDir.y))) / DEG;
    const elev = now.sunElev;
    now.day = smoothstep(-12, 4, elev);
    // --- палитра стиля по высоте солнца: отрезок между двумя опорными высотами
    let seg = 0;
    if (elev >= ANCHORS[2]) seg = 2;
    else if (elev >= ANCHORS[1]) seg = 1;
    const t = smooth01((elev - ANCHORS[seg]) / (ANCHORS[seg + 1] - ANCHORS[seg]));
    let sunPow = 0;
    let ambPow = 0;
    sunC[0] = sunC[1] = sunC[2] = ambC[0] = ambC[1] = ambC[2] = fogC[0] = fogC[1] = fogC[2] = 0;
    for (let s = 0; s < 4; s += 1) {
      const weight = kCur[s];
      if (weight <= 0) continue;
      const a = SKIES[s].keys[seg];
      const b = SKIES[s].keys[seg + 1];
      const wa = weight * (1 - t);
      const wb = weight * t;
      sunPow += a.sunPow * wa + b.sunPow * wb;
      ambPow += a.ambPow * wa + b.ambPow * wb;
      for (let c = 0; c < 3; c += 1) {
        sunC[c] += a.sun[c] * wa + b.sun[c] * wb;
        ambC[c] += a.amb[c] * wa + b.amb[c] * wb;
        fogC[c] += a.fog[c] * wa + b.fog[c] * wb;
      }
    }
    const dayLevel = DAY_LEVEL[seg] + (DAY_LEVEL[seg + 1] - DAY_LEVEL[seg]) * t;
    // --- главный свет: солнце, а когда оно ниже KEY_SWITCH_ELEV — луна. Правило то же, что у земли и травы
    // (sky-palettes.js): к смене светила направленный свет гаснет до нуля (в сумерках свет только
    // рассеянный), поэтому скачок направления не виден; потом разгорается лунный
    const useMoon = elev < KEY_SWITCH_ELEV;
    lift(now.keyDir, useMoon ? now.moonDir : now.sunDir, KEY_MIN_ELEV);
    const keyK = useMoon ? (1 - smoothstep(-10, -6, elev)) * smoothstep(-2, 6, now.moonElev) : smoothstep(-5, -1, elev);
    // --- погода гасит и перекрашивает свет
    const cover = now.cloudCover;
    const overcast = cover * (0.35 + 0.65 * now.cloudDark); // 0 ясно … 1 грозовая туча
    const veil = clamp01(now.fog * 0.6 + now.dust * 0.5 + now.smoke * 0.5); // пелена в воздухе
    const direct = now.sunDirect;
    // направленный свет: без прямого солнца остаётся слабый «свет с той стороны»
    now.sunPower = sunPow * (0.1 + 0.9 * direct) * (1 - 0.35 * veil) * keyK * st.calSun;
    // рассеянный: часть пропавшего солнца уходит в него (пасмурно — светло, но без теней), туча темнит
    const snowBounce = 1 + 0.14 * st.snow * now.day; // снег на земле подсвечивает снизу
    // не ниже AMBIENT_FLOOR: и грозовой ночью враги должны читаться в шлеме
    now.ambientPower = Math.max(AMBIENT_FLOOR, (ambPow + sunPow * 0.22 * (1 - direct) * now.day) * (1 - 0.45 * overcast) * (1 - 0.15 * veil) * snowBounce * st.calAmb);
    const grey = (sunC[0] + sunC[1] + sunC[2]) / 3;
    const sunFade = 0.5 * (1 - direct); // под облаками свет серее
    now.sunColor.setRGB(sunC[0] + (grey - sunC[0]) * sunFade, sunC[1] + (grey - sunC[1]) * sunFade, sunC[2] + (grey - sunC[2]) * sunFade);
    // рассеянный: к серо-голубому под тучами, к охре в пыль, к бурому в смог, чуть холоднее зимой
    const ambGrey = (ambC[0] + ambC[1] + ambC[2]) / 3;
    const og = 0.55 * clamp01((overcast - OVERCAST0) / (1 - OVERCAST0)); // при облаках по умолчанию — без сдвига цвета
    let ar = ambC[0] + (ambGrey * 0.94 - ambC[0]) * og;
    let ag = ambC[1] + (ambGrey * 0.98 - ambC[1]) * og;
    let ab = ambC[2] + (ambGrey * 1.06 - ambC[2]) * og;
    const dustK = 0.6 * now.dust;
    ar += (ambGrey * 1.18 - ar) * dustK;
    ag += (ambGrey * 0.86 - ag) * dustK;
    ab += (ambGrey * 0.5 - ab) * dustK;
    const smokeK = 0.5 * now.smoke;
    ar += (ambGrey * 1.02 - ar) * smokeK;
    ag += (ambGrey * 0.92 - ag) * smokeK;
    ab += (ambGrey * 0.8 - ab) * smokeK;
    const cold = 0.06 * sCur[WINTER];
    now.ambientColor.setRGB(ar * (1 - cold), ag, ab * (1 + cold * 0.5));
    // --- цвет тумана: дымка горизонта стиля → «освещённая пелена» (серая по яркости неба) → пыль / смог / снег
    const lit = dayLevel * (1 - 0.45 * overcast);
    const fogMix = clamp01(now.fog * 1.15 + cover * 0.25 + now.rain * 0.3 + now.snow * 0.3);
    let fr = fogC[0] + (0.72 * lit * (0.6 + 0.4 * ar) - fogC[0]) * fogMix;
    let fg = fogC[1] + (0.75 * lit * (0.6 + 0.4 * ag) - fogC[1]) * fogMix;
    let fb = fogC[2] + (0.8 * lit * (0.6 + 0.4 * ab) - fogC[2]) * fogMix;
    const dark = 1 - 0.35 * overcast * (1 - fogMix * 0.5);
    fr *= dark;
    fg *= dark;
    fb *= dark;
    const dustF = clamp01(now.dust * 0.9);
    fr += (0.8 * lit - fr) * dustF;
    fg += (0.5 * lit - fg) * dustF;
    fb += (0.22 * lit - fb) * dustF;
    const smokeF = clamp01(now.smoke * 0.8);
    fr += (0.42 * lit - fr) * smokeF;
    fg += (0.37 * lit - fg) * smokeF;
    fb += (0.31 * lit - fb) * smokeF;
    const snowF = clamp01(now.snow * 0.6);
    const litSnow = dayLevel * (1 - 0.2 * overcast); // снежная пелена светлее дождевой
    fr += (0.9 * litSnow - fr) * snowF;
    fg += (0.92 * litSnow - fg) * snowF;
    fb += (0.96 * litSnow - fb) * snowF;
    // --- небо за предметами. Туман не должен быть заметно светлее или темнее того, что небо рисует низко
    // над горизонтом (skyRef — из шейдера неба, пишет atmosphere-light.js, опоздание на кадр), пока пелена не
    // закрыла и эту часть неба (skyRef.free → 1: густой туман, метель, пыльная буря — цвет свободен).
    // Иначе высокий дальний предмет стоит на тёмном грозовом небе светлым призраком, а у горизонта — светлая
    // полоса. Цвет идёт от цвета неба к «своему» настолько, насколько позволяет допуск SKY_MATCH.
    if (skyRef.ok) {
      const match = tune.skyMatch ?? SKY_MATCH;
      const lb = 0.2126 * skyRef.r + 0.7152 * skyRef.g + 0.0722 * skyRef.b;
      const la = 0.2126 * fr + 0.7152 * fg + 0.0722 * fb;
      const t = Math.min(1, (match * lb + 1e-4) / ((1 - skyRef.free) * Math.abs(la - lb) + 1e-5));
      fr = skyRef.r + (fr - skyRef.r) * t;
      fg = skyRef.g + (fg - skyRef.g) * t;
      fb = skyRef.b + (fb - skyRef.b) * t;
    }
    now.fogColor.setRGB(fr, fg, fb);
    // --- тени от главного света: × прямое солнце, ночью (лунные) ~0,4, гаснут к смене светила и в пелене
    now.keyShadow = Math.min(1, direct * (0.4 + 0.6 * now.day) * keyK * (1 - 0.5 * veil) * st.calShadow);
    // --- радуга: в слепой дождь и какое-то время после дождя, только при солнце (чем оно ниже, тем лучше)
    const bow = Math.max(wCur[I_RAINBOW], st.rainbowAfter * 0.85);
    now.rainbow = bow * smoothstep(0.25, 0.7, direct) * smoothstep(-1, 6, elev) * (1 - 0.65 * smoothstep(35, 60, elev));
    // --- ветер: направление медленно гуляет вокруг обычного (±35°)
    // (обычное направление выбирается заново при каждой смене погоды; порыв немного отклоняет; заданное
    // через setWind держится ровно)
    const angle = target.wind === null ? st.windBase + 0.4 * Math.sin(st.windT / 97) + 0.22 * Math.sin(st.windT / 41 + 1.3) + st.gustTurn : st.windBase;
    now.windDir.set(Math.cos(angle), Math.sin(angle));
    // --- накопители и вспышка
    now.wet = st.wet;
    now.puddles = st.puddles;
    now.snowCover = st.snow;
    now.gust = st.gust;
    now.flash = st.flash;
  };

  // калибровка по состоянию по умолчанию: сила света и теней на первом запуске ровно как до атмосферы
  {
    const keepW = Float64Array.from(wCur);
    const keepS = Float64Array.from(sCur);
    const keepK = Float64Array.from(kCur);
    const keepHour = st.hour;
    const keepSnow = st.snow;
    loadWeather(wCur, DEFAULTS.weather);
    oneHot(sCur, seasonIndex(DEFAULTS.season));
    oneHot(kCur, SKY_IDS.indexOf(DEFAULTS.sky));
    st.hour = timeById(DEFAULTS.time).hour;
    st.snow = 0;
    derive();
    st.calSun = 1 / now.sunPower;
    st.calAmb = 1 / now.ambientPower;
    st.calShadow = 1 / now.keyShadow;
    wCur.set(keepW);
    sCur.set(keepS);
    kCur.set(keepK);
    st.hour = keepHour;
    st.snow = keepSnow;
  }

  // ---------- шаги по времени
  const stepBlends = (realDt) => {
    if (st.wT < 1) {
      st.wT = Math.min(1, st.wT + realDt / st.wDur);
      const e = smooth01(st.wT);
      for (let i = 0; i < N; i += 1) wCur[i] = wFrom[i] + (wTo[i] - wFrom[i]) * e;
    }
    if (st.sT < 1) {
      st.sT = Math.min(1, st.sT + realDt / st.sDur);
      const e = smooth01(st.sT);
      for (let i = 0; i < 4; i += 1) sCur[i] = sFrom[i] + (sTo[i] - sFrom[i]) * e;
    }
    if (st.kT < 1) {
      st.kT = Math.min(1, st.kT + realDt / st.kDur);
      const e = smooth01(st.kT);
      for (let i = 0; i < 4; i += 1) kCur[i] = kFrom[i] + (kTo[i] - kFrom[i]) * e;
    }
    if (st.hT < 1) {
      st.hT = Math.min(1, st.hT + realDt / st.hDur);
      st.hour = wrap24(st.hFrom + st.hDelta * smooth01(st.hT));
    }
    if (st.windTurnT < 1) {
      st.windTurnT = Math.min(1, st.windTurnT + realDt / st.windTurnDur);
      st.windBase = st.windFrom + st.windDelta * smooth01(st.windTurnT);
    }
  };
  // довернуть обычное направление ветра к углу (рад) кратчайшей дорогой за seconds настоящих секунд —
  // с текущего направления, так что перебить можно в любой момент
  const turnWind = (angle, seconds) => {
    st.windFrom = st.windBase;
    st.windDelta = Math.atan2(Math.sin(angle - st.windBase), Math.cos(angle - st.windBase));
    st.windGoal = st.windFrom + st.windDelta;
    st.windTurnT = seconds > 0 ? 0 : 1;
    st.windTurnDur = Math.max(0.01, seconds);
    if (!(seconds > 0)) st.windBase = st.windGoal;
  };

  // течение суток — по игровому времени; пока идёт переход setTime, сутки ждут
  const stepFlow = (dt) => {
    if (st.hT < 1 || !(target.flow > 0)) return;
    st.hour = wrap24(st.hour + (dt * 24) / (target.flow * 60));
    st.hourTarget = st.hour;
    const period = periodOf(st.hour);
    if (period !== target.time) {
      target.time = period;
      st.rev += 1;
    }
  };

  const stepSlow = (dt) => {
    if (!(dt > 0)) return;
    const rain = wCur[I_RAIN];
    const snow = wCur[I_SNOW];
    const sleet = wCur[I_SLEET];
    const wind = wCur[I_WIND];
    const direct = wCur[I_DIRECT];
    const winter = sCur[WINTER];
    const summer = sCur[SUMMER];
    // мокро: растёт от любой воды с неба, сохнет минуты (быстрее на солнце, ветру и летом)
    const rainLike = rain + sleet * 0.7 + wCur[I_HAIL] * 0.3;
    if (rainLike > 0.02) st.wet = Math.min(1, st.wet + (0.02 + rainLike * 0.12) * dt);
    else st.wet = Math.max(0, st.wet - (dt / 170) * (0.5 + direct * now.day + wind * 0.5 + summer * 0.3));
    // лужи: только в настоящий дождь, предел — по силе дождя; сохнут дольше, чем поверхности
    const puddleCap = clamp01((rain - 0.25) / 0.5);
    if (st.puddles < puddleCap) st.puddles = Math.min(puddleCap, st.puddles + (rain - 0.2) * 0.06 * dt);
    else if (rain < 0.2) st.puddles = Math.max(0, st.puddles - (dt / 260) * (0.6 + direct * now.day + summer * 0.3));
    // снег на земле: копится в снегопад (метель — ~45 с до сплошного); зимой лежит (не ниже SNOW_FLOOR),
    // в другие сезоны тает за минуту-полторы, дождь смывает
    let acc = st.snow + (snow * 0.022 + sleet * 0.004) * dt;
    // тает: по сезону (не зимой), быстрее днём; пока валит снег — почти не тает (метель и летом ложится, лёгкий снег — нет)
    // летом — за 20–30 с, весной и осенью — за 30–50 с
    acc -= ((1 - winter) * (0.016 + 0.012 * now.day) * (1 + 0.5 * summer) * (1 - 0.85 * clamp01(snow * 2)) + rain * 0.04 * (1 - 0.6 * winter)) * dt;
    if (acc > SNOW_FLOOR && snow < 0.05) acc = Math.max(SNOW_FLOOR, acc - dt / 400); // свежий снег оседает
    st.snow = Math.min(1, Math.max(SNOW_FLOOR * winter, acc));
    // радуга после дождя: «заряжается» дождём, держится ~1,5 мин, когда он кончился
    if (rain > 0.2) st.rainbowAfter = Math.min(1, st.rainbowAfter + dt / 20);
    else st.rainbowAfter = Math.max(0, st.rainbowAfter - dt / 90);
    // порывы: каждые 1,5–6 с новая цель (чем сильнее ветер, тем чаще и выше), подход — плавный
    st.gustIn -= dt;
    if (st.gustIn <= 0) {
      const r = Math.random();
      st.gustGoal = clamp01(r * r * (0.35 + wind * 0.9));
      st.gustIn = (1.5 + Math.random() * 4.5) / (0.6 + wind);
      st.gustSide = Math.random() * 2 - 1; // порыв приходит чуть сбоку: до ±12° при полном порыве
    }
    st.gust += (st.gustGoal - st.gust) * Math.min(1, dt * (st.gustGoal > st.gust ? 1.6 : 0.7));
    st.gustTurn += (st.gustSide * st.gust * 0.21 - st.gustTurn) * Math.min(1, dt * 1.2);
    st.windT += dt;
  };

  // удар молнии: точка в 300–3000 м от головы (чаще ближе), событие и всполохи вспышки
  const fireStrike = () => {
    const a = Math.random() * Math.PI * 2;
    const dist = 300 + Math.random() * Math.random() * 2700;
    if (camera) camera.getWorldPosition(head);
    else head.set(0, 0, 0);
    strike.x = head.x + Math.cos(a) * dist;
    strike.y = 0;
    strike.z = head.z + Math.sin(a) * dist;
    strike.distM = dist;
    strike.power = 1 - 0.65 * ((dist - 300) / 2700);
    // всполохи: главный сразу и ещё 1–2 дрожания в ближайшие 0,25 с
    st.pulses = 2 + (Math.random() < 0.6 ? 1 : 0);
    pulseAt[0] = 0;
    pulseAmp[0] = strike.power;
    pulseAt[1] = 0.05 + Math.random() * 0.05;
    pulseAmp[1] = strike.power * (0.45 + Math.random() * 0.3);
    pulseAt[2] = 0.14 + Math.random() * 0.1;
    pulseAmp[2] = strike.power * (0.6 + Math.random() * 0.35);
    for (const fn of listeners.lightning) {
      try {
        fn(strike);
      } catch (error) {
        console.warn('[atmo] lightning listener:', error);
      }
    }
  };
  const stepLightning = (dt, fxDt) => {
    const rate = wCur[I_LIGHTNING];
    if (rate > 0.02) {
      if (st.strikeIn < 0) st.strikeIn = (2 + Math.random() * 6) / rate; // первая — вскоре после начала грозы
      st.strikeIn -= dt;
      if (st.strikeIn <= 0) {
        st.strikeIn = (4 + Math.random() * 10) / rate;
        fireStrike();
      }
    } else st.strikeIn = -1;
    // вспышка: резкий подъём, затухание ~0,3 с (по времени глаз игрока, а не ускоренного мира)
    if (st.flash > 0) st.flash *= Math.exp(-fxDt / 0.085);
    if (st.flash < 0.004) st.flash = 0;
    for (let i = 0; i < st.pulses; i += 1) {
      if (pulseAmp[i] <= 0) continue;
      pulseAt[i] -= fxDt;
      if (pulseAt[i] <= 0) {
        st.flash = Math.max(st.flash, pulseAmp[i]);
        pulseAmp[i] = 0;
      }
    }
  };

  const pickAuto = () => {
    // сезон с наибольшим весом; текущая погода не повторяется
    let season = 0;
    for (let i = 1; i < 4; i += 1) if (sCur[i] > sCur[season]) season = i;
    const table = AUTO[SEASONS[season].id];
    let total = 0;
    for (const id in table) if (id !== target.weather) total += table[id];
    let r = Math.random() * total;
    for (const id in table) {
      if (id === target.weather) continue;
      r -= table[id];
      if (r <= 0) return id;
    }
    return DEFAULTS.weather;
  };
  const stepAuto = (dt) => {
    if (!target.auto) return;
    st.autoIn -= dt;
    if (st.autoIn > 0) return;
    const id = pickAuto();
    console.log(`[atmo] авто-погода: ${weatherById(id).name}`);
    api.setWeather(id, AUTO_BLEND_S);
  };

  // начать переход канала: t = 0 (или сразу 1 при seconds = 0)
  const begin = (t, dur, seconds) => {
    st[t] = seconds > 0 ? 0 : 1;
    st[dur] = Math.max(0.01, seconds);
    st.rev += 1;
  };

  const api = {
    now,
    target,
    WEATHERS,
    TIMES,
    SEASONS,
    SKIES,
    // счётчик смены выбора: main.js пересобирает меню, когда он изменился
    get rev() {
      return st.rev;
    },
    setWeather(id, seconds = 25) {
      if (!weatherById(id)) return console.warn(`[atmo] нет погоды «${id}»`), false;
      wFrom.set(wCur);
      loadWeather(wTo, id);
      begin('wT', 'wDur', seconds);
      if (!(seconds > 0)) {
        // мгновенно — значит «эта погода стоит давно»: мокрое, лужи и снег сразу такие, как при ней
        wCur.set(wTo);
        settleSlow();
      }
      // новая погода — ветер с новой стороны (по всему кругу), доворот за то же время; заданный setWind не трогаем
      if (id !== target.weather && target.wind === null) turnWind(Math.random() * Math.PI * 2, seconds);
      target.weather = id;
      st.autoIn = AUTO_MIN_S + Math.random() * (AUTO_MAX_S - AUTO_MIN_S);
      save();
      return true;
    },
    // Направление ветра: градусы, КУДА он дует (0 — к +X, вправо от взгляда по умолчанию; 90 — к +Z, на
    // игрока; 180 — влево; 270 — к −Z, от игрока), доворот за seconds; держится ровно, без блуждания и
    // порывов. null — снова само: с нынешнего направления, новое — при следующей смене погоды.
    setWind(degrees = null, seconds = 3) {
      if (degrees === null || degrees === undefined) target.wind = null;
      else if (Number.isFinite(degrees)) {
        target.wind = ((degrees % 360) + 360) % 360;
        turnWind(target.wind * DEG, seconds);
      } else return console.warn(`[atmo] направление ветра — градусы или null, а не «${degrees}»`), false;
      save();
      return true;
    },
    setTime(idOrHour, seconds = 8) {
      const preset = typeof idOrHour === 'string' ? timeById(idOrHour) : null;
      if (typeof idOrHour === 'string' && !preset) return console.warn(`[atmo] нет времени суток «${idOrHour}»`), false;
      if (!preset && !Number.isFinite(idOrHour)) return false;
      st.hourTarget = preset ? preset.hour : wrap24(idOrHour);
      st.hFrom = st.hour;
      st.hDelta = ((st.hourTarget - st.hour + 36) % 24) - 12; // кратчайшей дорогой по кругу суток
      begin('hT', 'hDur', seconds);
      if (!(seconds > 0)) st.hour = st.hourTarget;
      target.time = preset ? preset.id : periodOf(st.hourTarget);
      save();
      return true;
    },
    setSeason(id, seconds = 20) {
      const index = seasonIndex(id);
      if (index < 0) return console.warn(`[atmo] нет сезона «${id}»`), false;
      sFrom.set(sCur);
      oneHot(sTo, index);
      begin('sT', 'sDur', seconds);
      if (!(seconds > 0)) {
        // мгновенно: снег сразу как в этом сезоне (зимой лежит, в остальные — только если идёт)
        sCur.set(sTo);
        settleSlow();
      }
      target.season = id;
      save();
      return true;
    },
    setSky(id, seconds = 6) {
      const index = SKY_IDS.indexOf(id);
      if (index < 0) return console.warn(`[atmo] нет стиля неба «${id}»`), false;
      kFrom.set(kCur);
      oneHot(kTo, index);
      begin('kT', 'kDur', seconds);
      if (!(seconds > 0)) kCur.set(kTo);
      target.sky = id;
      save();
      return true;
    },
    setFlow(minutesPerDay) {
      target.flow = Number.isFinite(minutesPerDay) && minutesPerDay > 0 ? minutesPerDay : 0;
      st.rev += 1;
      save();
    },
    setAutoWeather(on) {
      target.auto = Boolean(on);
      st.autoIn = 20 + Math.random() * 40; // включили — первая смена скоро
      st.rev += 1;
      save();
    },
    on(type, fn) {
      const set = listeners[type];
      if (!set) return () => {};
      set.add(fn);
      return () => set.delete(fn);
    },
    // доиграть все переходы сразу (для проверок и снимков); settle — накопители как будто погода стоит давно
    snap(settle = true) {
      st.wT = st.sT = st.kT = st.hT = st.windTurnT = 1;
      st.windBase = st.windGoal;
      wCur.set(wTo);
      sCur.set(sTo);
      kCur.set(kTo);
      st.hour = st.hourTarget;
      if (settle) settleSlow();
      derive();
    },
    // вернуть всё как на первом запуске (закат, розовое небо, лето, переменная облачность, время стоит)
    reset(seconds = 0) {
      api.setFlow(DEFAULTS.flow);
      api.setAutoWeather(DEFAULTS.auto);
      api.setWeather(DEFAULTS.weather, seconds);
      api.setTime(DEFAULTS.time, seconds);
      api.setSeason(DEFAULTS.season, seconds);
      api.setSky(DEFAULTS.sky, seconds);
      target.wind = null;
      turnWind(BASE_WIND_ANGLE, seconds); // ветер — как на первом запуске
      save();
      if (!(seconds > 0)) api.snap();
    },
    // молния прямо сейчас (проверка вспышки и грома), при любой погоде
    strikeNow() {
      fireStrike();
      stepLightning(0, 0);
    },
    // dt — игровое время кадра («Время ×N»), realDt — настоящее
    update(dt, realDt = dt) {
      const real = Math.min(Math.max(realDt, 0), 0.25);
      const game = Math.max(dt, 0);
      stepBlends(real);
      stepFlow(game);
      stepSlow(game);
      stepLightning(game, Math.min(game, real));
      stepAuto(game);
      derive();
      if (target.flow > 0) {
        st.saveIn -= real;
        if (st.saveIn <= 0) {
          st.saveIn = 5;
          save(); // час текущих суток — чтобы перезагрузка продолжила с него
        }
      }
    },
    // всё, что нужно следующему объекту при подмене сцены
    carry() {
      return { v: CARRY_V, target: { ...target }, w: Float64Array.from(wCur), s: Float64Array.from(sCur), k: Float64Array.from(kCur), st: { ...st } };
    },
    dispose() {
      listeners.lightning.clear();
      save();
      // объект остаётся в shared.atmosphere: следующая версия сцены заберёт из него значения (carry)
    },
  };
  if (prev) {
    // цели каналов прежнего объекта (переход мог идти)
    loadWeather(wTo, target.weather);
    oneHot(sTo, seasonIndex(target.season));
    oneHot(kTo, SKY_IDS.indexOf(target.sky));
  }
  derive();
  shared.atmosphere = api;
  return api;
}
