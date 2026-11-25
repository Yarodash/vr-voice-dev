// Звук погоды и природы: дождь, ветер, гром, град, снег, птицы, сверчки, листва.
// Состояние только читается: shared.atmosphere.now (docs/agents/atmosphere.md), гром — по событию
// atmosphere.on('lightning'). Пока модуля атмосферы нет — тишина.
//
// ПРАВИЛА ЗВУКА (docs/agents/effects-and-sound.md):
// - Все звуки один раз считаются числами в AudioBuffer (шум + фильтры + огибающие прямо в JS, без
//   узлов) и лежат в __sceneState.weatherSoundBank. Счёт (~1 с на ПК, в разы дольше в шлеме) идёт в
//   фоновом потоке: Worker из Blob с текстом функции bakeLib (тот же приём, что у DRACOLoader в
//   three.js) — кадры не страдают. Поэтому bakeLib ОБЯЗАНА быть самодостаточной: ничего снаружи
//   своей области не читает. Worker не завёлся — счёт на главном потоке кусочками (рецепт —
//   генератор, один кусок за задачу). Не запеклось — молчит.
// - Граф постоянный (__sceneState.weatherVoices, переживает подмену сцены): слой = петля(и) →
//   своё усиление → общий выход → шина мира npcOut (audio-budget.js). «Стерео» слоя — один и тот же
//   моно-буфер двумя источниками с разным сдвигом в левый и правый канал (вдвое меньше памяти и счёта).
//   Источник петли создаётся, только когда слой зазвучал, и снимается через IDLE_S тишины.
// - Разовые звуки (капля, удар града, птица, гром, порыв) — один BufferSource в заранее созданный
//   голос (усиление → StereoPanner) из маленького пула. Никаких панорам HRTF, фильтров, ревербераторов
//   и обратных связей: эхо грома и птиц запечено в буфер.
// - Громкости — прямым присваиванием .value раз в кадр (сглаживание — в JS), без автоматизации.
// - Петли нормированы по RMS (REF); сумма слоёв выше KNEE мягко сжимается и не поднимается выше CAP —
//   ливень с ураганом не прижимают лимитер шины мира и не спорят с выстрелами игрока.
//
// С ПК: npm run vr:eval -- "__sceneState.weatherSoundDebug.stats()"
//       __sceneState.weatherSoundDebug.set({ rain: 1, wind: 1.2, gust: 0.5 })  — подменить поля now
//       __sceneState.weatherSoundDebug.clear()        — снова читать атмосферу
//       __sceneState.weatherSoundDebug.thunder(300, 1, 40)  — гром: расстояние (м), сила, азимут (°)
import { npcOut } from './audio-budget.js';

const BAKE_VERSION = 3; // 3: ноты птиц считаются втрое быстрее (тот же звук); 2: низкий гул сдвинут в 100–300 Гц (на динамиках шлема ниже 100 Гц не слышно)
const GRAPH_VERSION = 1;
// Сумма петель (RMS на выходе погоды): до KNEE — как есть, выше — сжимается вчетверть… и не выше CAP.
// Мягко, а не стенкой: порыв в ураган всё ещё слышен как прибавка, а не только как смена тембра.
export const KNEE = 0.06;
export const CAP = 0.1;
const IDLE_S = 6; // слой молчит дольше — его источники снимаются
const SMALL = 5; // голоса коротких звуков: капли, град, птицы
const BIG = 4; // голоса долгих: гром, порыв
const SOUND_SPEED = 343;
const THUNDER_GAP_MS = 400;

// Всё, что нужно для счёта буферов: числа, фильтры, рецепты. САМОДОСТАТОЧНА (её текст уходит в Worker):
// внутри нельзя ссылаться ни на что снаружи.
export function bakeLib() {
  const REF = 0.125; // RMS каждой петли в буфере
  const TAU = Math.PI * 2;
  const rnd = (a, b) => a + Math.random() * (b - a);
  const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

  // ---------- числа: шум, фильтры, огибающие (всё — по Float32Array, без узлов) ----------
  const noise = (n) => {
    const x = new Float32Array(n);
    for (let i = 0; i < n; i += 1) x[i] = Math.random() * 2 - 1;
    return x;
  };
  // розовый шум (фильтр Пола Келлета, экономный)
  const pink = (n) => {
    const x = new Float32Array(n);
    let b0 = 0;
    let b1 = 0;
    let b2 = 0;
    for (let i = 0; i < n; i += 1) {
      const w = Math.random() * 2 - 1;
      b0 = 0.99765 * b0 + w * 0.099046;
      b1 = 0.963 * b1 + w * 0.2965164;
      b2 = 0.57 * b2 + w * 1.0526913;
      x[i] = (b0 + b1 + b2 + w * 0.1848) * 0.25;
    }
    return x;
  };
  // двухполюсный фильтр (RBJ): 'lp' | 'hp' | 'bp', на месте
  const biquad = (x, sr, type, f, q = 0.707) => {
    const w = (TAU * Math.min(f, sr * 0.45)) / sr;
    const cs = Math.cos(w);
    const al = Math.sin(w) / (2 * q);
    let b0;
    let b1;
    let b2;
    if (type === 'lp') {
      b1 = 1 - cs;
      b0 = b2 = b1 / 2;
    } else if (type === 'hp') {
      b1 = -(1 + cs);
      b0 = b2 = (1 + cs) / 2;
    } else {
      b0 = al;
      b1 = 0;
      b2 = -al;
    }
    const a0 = 1 + al;
    const n0 = b0 / a0;
    const n1 = b1 / a0;
    const n2 = b2 / a0;
    const d1 = (-2 * cs) / a0;
    const d2 = (1 - al) / a0;
    let z1 = 0;
    let z2 = 0;
    for (let i = 0; i < x.length; i += 1) {
      const s = x[i];
      const y = n0 * s + z1;
      z1 = n1 * s - d1 * y + z2;
      z2 = n2 * s - d2 * y;
      x[i] = y;
    }
    return x;
  };
  // полосовой фильтр с плавающей частотой (TPT SVF — устойчив при модуляции): fcAt(i) → Гц, пересчёт
  // раз в 32 отсчёта; добротность q невысокая (2–4): «у-у-у», а не свист
  const sweepBand = (x, sr, fcAt, q) => {
    const k = 1 / q;
    let ic1 = 0;
    let ic2 = 0;
    let a1 = 0;
    let a2 = 0;
    let a3 = 0;
    for (let i = 0; i < x.length; i += 1) {
      if ((i & 31) === 0) {
        const g = Math.tan((Math.PI * Math.min(Math.max(20, fcAt(i)), sr * 0.45)) / sr);
        a1 = 1 / (1 + g * (g + k));
        a2 = g * a1;
        a3 = g * a2;
      }
      const v3 = x[i] - ic2;
      const v1 = a1 * ic1 + a2 * v3;
      const v2 = ic2 + a2 * ic1 + a3 * v3;
      ic1 = 2 * v1 - ic1;
      ic2 = 2 * v2 - ic2;
      x[i] = k * v1;
    }
    return x;
  };
  // медленная плавная кривая в −1…1: сумма parts синусов со случайными периодами pMin…pMax (с)
  const wander = (n, sr, pMin, pMax, parts = 3) => {
    const out = new Float32Array(n);
    for (let p = 0; p < parts; p += 1) {
      const w = TAU / (rnd(pMin, pMax) * sr);
      const cw = Math.cos(w);
      const sw = Math.sin(w);
      const ph = rnd(0, TAU);
      let x = Math.cos(ph);
      let y = Math.sin(ph);
      for (let i = 0; i < n; i += 1) {
        out[i] += y / parts;
        const nx = x * cw - y * sw;
        y = x * sw + y * cw;
        x = nx;
      }
    }
    return out;
  };
  const rmsOf = (x) => {
    let s = 0;
    for (let i = 0; i < x.length; i += 1) s += x[i] * x[i];
    return Math.sqrt(s / Math.max(1, x.length));
  };
  const rmsTo = (x, r) => {
    const k = r / (rmsOf(x) || 1e9);
    for (let i = 0; i < x.length; i += 1) x[i] *= k;
    return x;
  };
  const peakTo = (x, p) => {
    let m = 0;
    for (let i = 0; i < x.length; i += 1) m = Math.max(m, Math.abs(x[i]));
    if (m > 0) for (let i = 0; i < x.length; i += 1) x[i] *= p / m;
    return x;
  };
  // неровная дрожь громкости: шум ниже hz Гц, RMS 1
  const flutter = (n, sr, hz) => rmsTo(biquad(noise(n), sr, 'lp', hz, 0.6), 1);
  // огибающая из случайных всплесков: perSec в секунду, атака и спад (с), сила — u^pow; среднее = 1
  const bursts = (n, sr, perSec, aMin, aMax, dMin, dMax, pow = 2) => {
    const e = new Float32Array(n);
    const count = Math.round((n / sr) * perSec);
    for (let k = 0; k < count; k += 1) {
      const s0 = Math.floor(Math.random() * n);
      const amp = Math.random() ** pow;
      const a = Math.max(1, Math.floor(rnd(aMin, aMax) * sr));
      const dec = Math.exp(-1 / (rnd(dMin, dMax) * sr));
      for (let i = 0; i < a && s0 + i < n; i += 1) e[s0 + i] += (amp * i) / a;
      let v = amp;
      for (let i = s0 + a; i < n && v > 0.003; i += 1) {
        e[i] += v;
        v *= dec;
      }
    }
    let mean = 0;
    for (let i = 0; i < n; i += 1) mean += e[i];
    mean = mean / n || 1;
    for (let i = 0; i < n; i += 1) e[i] /= mean;
    return e;
  };
  // умножить на огибающую fn(секунды), считая её раз в step отсчётов (между — линейно)
  const shape = (x, sr, fn, step = 64) => {
    let a = fn(0);
    for (let i = 0; i < x.length; i += step) {
      const b = fn((i + step) / sr);
      const e = Math.min(x.length, i + step);
      const k = (b - a) / step;
      let v = a;
      for (let j = i; j < e; j += 1) {
        x[j] *= v;
        v += k;
      }
      a = b;
    }
    return x;
  };
  // затухающий синус с s0: частота f, спад tau (с) — капля, стук, звон
  const ping = (buf, s0, sr, f, tau, amp) => {
    const n = Math.min(buf.length - s0, Math.ceil(tau * sr * 6));
    const w = (TAU * f) / sr;
    const cw = Math.cos(w);
    const sw = Math.sin(w);
    const dec = Math.exp(-1 / (tau * sr));
    let x = 1;
    let y = 0;
    let a = amp;
    for (let i = 0; i < n; i += 1) {
      buf[s0 + i] += a * y;
      a *= dec;
      const nx = x * cw - y * sw;
      y = x * sw + y * cw;
      x = nx;
    }
  };
  // «бульк»: синус с растущей частотой (пузырёк в луже)
  const bubble = (buf, s0, sr, f0, rise, tau, amp) => {
    const n = Math.min(buf.length - s0, Math.ceil(tau * sr * 5));
    const dec = Math.exp(-1 / (tau * sr));
    const att = 0.0015 * sr;
    let ph = 0;
    let a = amp;
    for (let i = 0; i < n; i += 1) {
      ph += (TAU * f0 * (1 + ((rise - 1) * i) / n)) / sr;
      buf[s0 + i] += a * Math.sin(ph) * Math.min(1, i / att);
      a *= dec;
    }
  };
  // короткий шумовой щелчок
  const click = (buf, s0, sr, tau, amp) => {
    const n = Math.min(buf.length - s0, Math.ceil(tau * sr * 5));
    const dec = Math.exp(-1 / (tau * sr));
    let a = amp;
    for (let i = 0; i < n; i += 1) {
      buf[s0 + i] += (Math.random() * 2 - 1) * a;
      a *= dec;
    }
  };
  const fadeTail = (d, sr, seconds) => {
    const n = Math.min(d.length, Math.floor(sr * seconds));
    for (let i = 0; i < n; i += 1) d[d.length - 1 - i] *= i / n;
  };
  // довести до RMS и мягко прижать редкие пики (капли, стуки) под top
  const toRms = (d, rms, top = 0.92) => {
    const k = rms / (rmsOf(d) || 1e9);
    const knee = top * 0.6;
    const room = top - knee;
    for (let i = 0; i < d.length; i += 1) {
      let v = d[i] * k;
      const a = Math.abs(v);
      if (a > knee) v = Math.sign(v) * (knee + room * Math.tanh((a - knee) / room));
      d[i] = v;
    }
  };
  // Петля без шва: src длиннее d на x отсчётов; начало d — равномощный переход из хвоста src
  // (src[n + i] гаснет, src[i] нарастает), поэтому d[n − 1] → d[0] — это соседние отсчёты src.
  const seam = (src, d, x) => {
    const n = d.length;
    for (let i = 0; i < n; i += 1) d[i] = src[i];
    for (let i = 0; i < x; i += 1) {
      const th = ((i / x) * Math.PI) / 2;
      d[i] = src[i] * Math.sin(th) + src[n + i] * Math.cos(th);
    }
  };
  // рецепт петли: fill(n, sr) — генератор, возвращает Float32Array длины n
  const loop = (seconds, xfade, fill) => ({
    seconds,
    loop: true,
    *render(d, sr) {
      const x = Math.floor(xfade * sr);
      const src = yield* fill(d.length + x, sr);
      yield;
      seam(src, d, x);
      toRms(d, REF);
    },
  });
  // «издалека»: срезать верх и добавить несколько тихих глухих отражений (без обратной связи)
  const distant = (d, sr, lp, taps) => {
    biquad(d, sr, 'lp', lp, 0.7);
    const wet = d.slice();
    biquad(wet, sr, 'lp', 2400, 0.7);
    for (const [sec, k] of taps) {
      const s = Math.floor(sec * sr);
      for (let i = s; i < d.length; i += 1) d[i] += wet[i - s] * k;
    }
  };

  // ---------- дождь ----------
  // Далёкий дождь — ровный шум (розовый + «воздух»), ближний — россыпь капель (затухающие синусы
  // 1–9 кГц, сила по степенному закону) и редкие «бульки» в лужи.
  function* rainFill(n, sr, o) {
    const bed = pink(n);
    biquad(bed, sr, 'hp', o.hp, 0.7);
    biquad(bed, sr, 'lp', o.lp, 0.7);
    rmsTo(bed, 1);
    yield;
    const air = noise(n);
    biquad(air, sr, 'hp', o.airHp, 0.7);
    biquad(air, sr, 'lp', o.airLp, 0.7);
    rmsTo(air, o.air);
    yield;
    const sway = wander(n, sr, o.swayMin, o.swayMax, 3);
    for (let i = 0; i < n; i += 1) bed[i] = (bed[i] + air[i]) * (1 + o.sway * sway[i]);
    yield;
    const drops = air.fill(0);
    const count = Math.round((n / sr) * o.drops);
    const lf = Math.log(o.fMax / o.fMin);
    for (let k = 0; k < count; k += 1) {
      const f = o.fMin * Math.exp(lf * Math.random());
      ping(drops, Math.floor(Math.random() * n), sr, f, o.cycles / f, Math.random() ** 3);
      if ((k & 1023) === 1023) yield;
    }
    const plops = Math.round((n / sr) * o.plops);
    for (let k = 0; k < plops; k += 1) bubble(drops, Math.floor(Math.random() * n), sr, rnd(450, 1300), rnd(1.2, 1.7), rnd(0.012, 0.03), rnd(0.4, 1.4));
    biquad(drops, sr, 'hp', 200, 0.7); // затухающие синусы в сумме дают постоянную составляющую — снять
    rmsTo(drops, o.dropLevel);
    for (let i = 0; i < n; i += 1) bed[i] += drops[i];
    return bed;
  }
  const RAIN = {
    // морось: тонкий высокий шелест, мелкие частые тики
    drizzle: { hp: 1900, lp: 9500, airHp: 3500, airLp: 11000, air: 0.7, sway: 0.1, swayMin: 2, swayMax: 5, drops: 260, fMin: 3500, fMax: 10000, cycles: 5, plops: 0, dropLevel: 0.75 },
    // дождь: шум 300 Гц…9 кГц и отчётливые капли
    rainA: { hp: 330, lp: 8500, airHp: 1500, airLp: 9000, air: 0.55, sway: 0.12, swayMin: 2, swayMax: 5, drops: 650, fMin: 1200, fMax: 9000, cycles: 4, plops: 5, dropLevel: 0.6 },
    rainB: { hp: 420, lp: 7500, airHp: 1800, airLp: 10000, air: 0.6, sway: 0.12, swayMin: 1.7, swayMax: 4.3, drops: 520, fMin: 1000, fMax: 8000, cycles: 4.5, plops: 7, dropLevel: 0.65 },
    // ливень: плотная стена — шум шире и ровнее, капли тонут в нём, «полотнища» по громкости
    pour: { hp: 140, lp: 7000, airHp: 800, airLp: 6500, air: 1, sway: 0.2, swayMin: 1.4, swayMax: 3.8, drops: 1100, fMin: 900, fMax: 7000, cycles: 4, plops: 12, dropLevel: 0.32 },
  };

  // ---------- ветер ----------
  function* windLowFill(n, sr) {
    const x = pink(n);
    biquad(x, sr, 'lp', 320, 0.7);
    biquad(x, sr, 'lp', 520, 0.7);
    biquad(x, sr, 'hp', 70, 0.7);
    yield;
    const a = wander(n, sr, 1.7, 5.5, 3);
    for (let i = 0; i < n; i += 1) x[i] *= 0.65 + 0.4 * a[i];
    return x;
  }
  // «вой»: шум через полосу с плавающей частотой + второй, более высокий голос + широкая подложка
  function* windMidFill(n, sr, o) {
    const m = wander(n, sr, 2.2, 6.5, 3);
    const m2 = wander(n, sr, 1.1, 3.1, 2);
    const x = noise(n);
    sweepBand(x, sr, (i) => o.f0 * 2 ** (o.oct * (m[i] + 0.35 * m2[i])), o.q);
    rmsTo(x, 1);
    yield;
    const y = noise(n);
    sweepBand(y, sr, (i) => o.f1 * 2 ** (o.oct1 * (0.8 * m[i] - 0.5 * m2[i])), o.q1);
    rmsTo(y, 0.45);
    yield;
    const body = pink(n);
    biquad(body, sr, 'hp', 180, 0.7);
    biquad(body, sr, 'lp', 1500, 0.7);
    rmsTo(body, 0.4);
    yield;
    // выше тон — громче: порыв
    for (let i = 0; i < n; i += 1) x[i] = (x[i] + y[i]) * Math.min(1.4, Math.max(0.15, 0.65 + 0.7 * m[i])) + body[i] * (0.8 + 0.3 * m2[i]);
    return x;
  }
  // шелест травы: высокий шум, дрожащий мелкими всплесками
  function* windHighFill(n, sr) {
    const x = noise(n);
    biquad(x, sr, 'hp', 1800, 0.7);
    biquad(x, sr, 'lp', 7500, 0.7);
    yield;
    const e = bursts(n, sr, 28, 0.01, 0.05, 0.04, 0.16, 1.5);
    const s = wander(n, sr, 1.5, 4.5, 3);
    for (let i = 0; i < n; i += 1) x[i] *= (0.35 + 0.65 * Math.min(3, e[i])) * (0.7 + 0.3 * s[i]);
    return x;
  }
  // ураганный рёв: широкая плотная полоса с частой неровной «трёпкой» + быстрый вой
  function* galeFill(n, sr) {
    const x = pink(n);
    biquad(x, sr, 'hp', 90, 0.7);
    biquad(x, sr, 'lp', 1800, 0.7);
    const buffet = flutter(n, sr, 5);
    for (let i = 0; i < n; i += 1) x[i] *= Math.min(2.2, Math.max(0.2, 1 + 0.45 * buffet[i]));
    rmsTo(x, 1);
    yield;
    const m = wander(n, sr, 0.9, 2.8, 3);
    const howl = noise(n);
    sweepBand(howl, sr, (i) => 700 * 2 ** (0.9 * m[i]), 3.2);
    rmsTo(howl, 0.5);
    yield;
    for (let i = 0; i < n; i += 1) x[i] += howl[i] * (0.5 + 0.8 * clamp01(m[i] + 0.5));
    return x;
  }
  // низкий гул (ливень, ураган)
  function* rumbleFill(n, sr) {
    const x = noise(n);
    biquad(x, sr, 'lp', 170, 0.7);
    biquad(x, sr, 'lp', 260, 0.7);
    biquad(x, sr, 'hp', 45, 0.7);
    yield;
    const a = wander(n, sr, 2, 6, 3);
    for (let i = 0; i < n; i += 1) x[i] *= 0.7 + 0.3 * a[i];
    return x;
  }
  // сухой шорох снега и песка: высокий шум мелкими зёрнами
  function* gritFill(n, sr) {
    const x = noise(n);
    biquad(x, sr, 'hp', 3200, 0.7);
    biquad(x, sr, 'lp', 11000, 0.7);
    yield;
    const s = wander(n, sr, 1.2, 3.5, 3);
    let hold = 0;
    let g = 0;
    for (let i = 0; i < n; i += 1) {
      if ((hold -= 1) <= 0) {
        g = Math.random() ** 2;
        hold = rnd(0.0007, 0.003) * sr;
      }
      x[i] *= (0.25 + 1.5 * g) * (0.65 + 0.35 * s[i]);
    }
    return x;
  }
  // снегопад: мягкий тихий фон без верха
  function* snowBedFill(n, sr) {
    const x = pink(n);
    biquad(x, sr, 'lp', 900, 0.7);
    biquad(x, sr, 'lp', 1400, 0.7);
    biquad(x, sr, 'hp', 180, 0.7);
    yield;
    const a = wander(n, sr, 3, 7, 2);
    for (let i = 0; i < n; i += 1) x[i] *= 0.85 + 0.15 * a[i];
    return x;
  }
  // осенняя листва на ветру: сухой треск-шорох частыми короткими всплесками
  function* leavesFill(n, sr) {
    const x = noise(n);
    biquad(x, sr, 'hp', 1300, 0.7);
    biquad(x, sr, 'lp', 6500, 0.7);
    yield;
    const e = bursts(n, sr, 60, 0.002, 0.008, 0.012, 0.06, 2.5);
    const s = wander(n, sr, 1.3, 4, 3);
    for (let i = 0; i < n; i += 1) x[i] *= (0.12 + Math.min(4, e[i])) * (0.6 + 0.4 * s[i]);
    return x;
  }

  // ---------- град ----------
  // удар градины о землю: короткий «тук» + жёсткий ледяной щелчок
  const knock = (buf, s0, sr, a) => {
    ping(buf, s0, sr, rnd(320, 900), rnd(0.003, 0.007), a * 0.8);
    ping(buf, s0, sr, rnd(1900, 4200), rnd(0.0012, 0.003), a);
    click(buf, s0, sr, 0.0005, a * 0.9);
  };
  function* hailFill(n, sr) {
    const x = noise(n);
    biquad(x, sr, 'hp', 1500, 0.7);
    biquad(x, sr, 'lp', 6000, 0.7);
    rmsTo(x, 0.15);
    yield;
    const k = new Float32Array(n);
    const count = Math.round((n / sr) * 42);
    for (let j = 0; j < count; j += 1) knock(k, Math.floor(Math.random() * n), sr, Math.random() ** 2.2);
    biquad(k, sr, 'hp', 150, 0.7);
    rmsTo(k, 1);
    for (let i = 0; i < n; i += 1) x[i] += k[i];
    return x;
  }

  // ---------- птицы и сверчки ----------
  // нота: синус с плавной частотой f0 → f1, огибающая-колокол, вторая гармоника h2
  const tone = (d, sr, t0, dur, f0, f1, amp, vib = 0, vibHz = 0, h2 = 0.12) => {
    const s0 = Math.floor(t0 * sr);
    const full = Math.floor(dur * sr);
    const n = Math.min(d.length - s0, full);
    if (s0 < 0 || n <= 2) return;
    // один Math.sin на отсчёт: частота растёт множителем, огибающая sin²(π·i/full) и вибрато — поворотом
    // вектора, вторая гармоника — из квадрата синуса (2·sin² − 1 = −cos 2φ)
    const glide = Math.exp(Math.log(f1 / f0) / full);
    const we = Math.PI / full;
    const ce = Math.cos(we);
    const se = Math.sin(we);
    let ex = 1;
    let ey = 0;
    const wv = (TAU * vibHz) / sr;
    const cv = Math.cos(wv);
    const sv = Math.sin(wv);
    let vx = 1;
    let vy = 0;
    let w = (TAU * f0) / sr;
    let ph = rnd(0, TAU);
    for (let i = 0; i < n; i += 1) {
      ph += vib ? w * (1 + vib * vy) : w;
      const sn = Math.sin(ph);
      d[s0 + i] += amp * ey * ey * (sn + h2 * (2 * sn * sn - 1));
      w *= glide;
      const nx = ex * ce - ey * se;
      ey = ex * se + ey * ce;
      ex = nx;
      if (vib) {
        const mx = vx * cv - vy * sv;
        vy = vx * sv + vy * cv;
        vx = mx;
      }
    }
  };
  // голоса птиц: (d, sr, t, a) пишет с момента t (с) и возвращает момент конца
  const CALLS = [
    // чириканье: 2–4 коротких нисходящих «чив»
    (d, sr, t, a) => {
      const k = 2 + Math.floor(Math.random() * 3);
      const f = rnd(3200, 4600);
      const gap = rnd(0.1, 0.16);
      for (let j = 0; j < k; j += 1) tone(d, sr, t + j * gap, rnd(0.05, 0.08), f * rnd(1.15, 1.3), f * rnd(0.8, 0.9), a * rnd(0.7, 1));
      return t + k * gap;
    },
    // трель: частые ноты, тон плывёт
    (d, sr, t, a) => {
      const f = rnd(3800, 5600);
      const rate = rnd(16, 26);
      const k = Math.floor(rnd(8, 18));
      const up = rnd(0.9, 1.15);
      for (let j = 0; j < k; j += 1) {
        const fj = f * up ** (j / k);
        tone(d, sr, t + j / rate, 0.9 / rate, fj, fj * rnd(1.05, 1.18), a * (0.6 + 0.4 * Math.sin((Math.PI * (j + 0.5)) / k)));
      }
      return t + k / rate;
    },
    // свист из двух нот (синица: «фи-бии»)
    (d, sr, t, a) => {
      const f = rnd(3600, 4600);
      const rep = 1 + Math.floor(Math.random() * 2);
      let x = t;
      for (let r = 0; r < rep; r += 1) {
        tone(d, sr, x, 0.2, f, f * 0.99, a, 0.004, 28);
        tone(d, sr, x + 0.26, 0.28, f * 0.8, f * 0.79, a * 0.9, 0.004, 28);
        x += 0.72;
      }
      return x;
    },
    // щебет: россыпь нот вразброс
    (d, sr, t, a) => {
      const k = Math.floor(rnd(7, 13));
      let x = t;
      let f = rnd(2800, 4800);
      for (let j = 0; j < k; j += 1) {
        const dur = rnd(0.035, 0.085);
        const f2 = Math.min(6500, Math.max(2200, f * rnd(0.7, 1.45)));
        tone(d, sr, x, dur, f, f2, a * rnd(0.5, 1));
        f = Math.min(6000, Math.max(2400, f2 * rnd(0.85, 1.2)));
        x += dur + rnd(0.01, 0.06);
      }
      return x;
    },
    // кукушка: две мягкие низкие ноты
    (d, sr, t, a) => {
      const f = rnd(640, 700);
      const rep = 1 + Math.floor(Math.random() * 2);
      let x = t;
      for (let r = 0; r < rep; r += 1) {
        tone(d, sr, x, 0.2, f, f * 0.985, a * 1.3, 0, 0, 0.25);
        tone(d, sr, x + 0.3, 0.3, f * 0.79, f * 0.775, a * 1.3, 0, 0, 0.25);
        x += 1.05;
      }
      return x - 0.4;
    },
    // пеночка: чередование двух нот
    (d, sr, t, a) => {
      const f = rnd(3900, 4900);
      const k = Math.floor(rnd(4, 8));
      const gap = rnd(0.2, 0.26);
      for (let j = 0; j < k; j += 1) {
        const up = j % 2 ? 0.84 : 1;
        tone(d, sr, t + j * gap, 0.09, f * up * 1.06, f * up * 0.94, a * rnd(0.8, 1));
      }
      return t + k * gap;
    },
  ];
  const ECHO = [[0.11, 0.2], [0.19, 0.13], [0.31, 0.07]];
  // далёкий птичий хор: много тихих голосов, глухо
  function* birdsBedFill(n, sr) {
    const d = new Float32Array(n);
    const seconds = n / sr;
    const count = Math.round(seconds * 6);
    const SMALL_BIRDS = [0, 1, 2, 3, 5];
    for (let k = 0; k < count; k += 1) {
      // кукушка (4) — редко: её низкие ноты не глушатся расстоянием и забивали бы хор
      const call = Math.random() < 0.05 ? 4 : SMALL_BIRDS[Math.floor(Math.random() * SMALL_BIRDS.length)];
      CALLS[call](d, sr, rnd(0, seconds - 0.2), (0.08 + Math.random() ** 2.5) * (call === 4 ? 0.5 : 1));
      if ((k & 7) === 7) yield;
    }
    distant(d, sr, 3800, ECHO);
    return d;
  }
  // сверчки: у каждого свой тон (4–5,2 кГц), темп и громкость; стрекот — по 3–4 коротких импульса
  function* cricketsFill(n, sr) {
    const d = new Float32Array(n);
    const seconds = n / sr;
    for (let k = 0; k < 5; k += 1) {
      const f = rnd(4000, 5200);
      const per = 1 / rnd(1.7, 2.7);
      const pulses = 3 + (Math.random() < 0.4 ? 1 : 0);
      const gap = rnd(0.024, 0.034);
      const pd = rnd(0.012, 0.019);
      const amp = rnd(0.3, 1) ** 1.5;
      let t = rnd(0, per);
      while (t < seconds) {
        if (Math.random() < 0.07) t += rnd(0.5, 1.4); // примолк
        for (let p = 0; p < pulses; p += 1) tone(d, sr, t + p * gap, pd, f, f * 1.02, amp * (0.7 + (0.3 * p) / pulses), 0, 0, 0.05);
        t += per * rnd(0.94, 1.06);
      }
      yield;
    }
    return d;
  }

  // ---------- гром ----------
  // near — резкий треск (несколько ударов подряд + рвущийся шум), удар и раскат; mid — треск глуше и
  // размазан; far — только глухой долгий рокот. Эхо-раскаты запечены: низкий шум под огибающей из
  // нескольких наплывов. Ничего ниже 60 Гц не тянем в одиночку — на маленьких динамиках шлема слышна
  // полоса 100–400 Гц.
  const thunder = (kind, seconds, variants) => ({
    seconds,
    variants,
    *render(d, sr) {
      const n = d.length;
      const near = kind === 'near';
      const far = kind === 'far';
      if (!far) {
        const cn = Math.floor(sr * 1.8);
        const c = new Float32Array(cn);
        const strokes = near ? 4 + Math.floor(Math.random() * 4) : 3 + Math.floor(Math.random() * 3);
        const main = Math.floor(Math.random() * 2);
        let t = 0.01;
        for (let k = 0; k < strokes; k += 1) {
          const s0 = Math.floor(t * sr);
          const tau = (near ? rnd(0.012, 0.045) : rnd(0.03, 0.09)) * sr;
          const att = (near ? 0.0004 : 0.006) * sr;
          const dec = Math.exp(-1 / tau);
          const len = Math.min(cn - s0, Math.floor(tau * 6));
          let a = k === main ? 1 : rnd(0.3, 0.8);
          for (let i = 0; i < len; i += 1) {
            c[s0 + i] += (Math.random() * 2 - 1) * a * Math.min(1, i / att);
            a *= dec;
          }
          t += near ? rnd(0.02, 0.11) : rnd(0.05, 0.2);
        }
        // рвущийся треск между ударами: шум зёрнами, быстро гаснет
        const tear = new Float32Array(cn);
        let hold = 0;
        let g = 0;
        for (let i = 0; i < cn; i += 1) {
          if ((hold -= 1) <= 0) {
            g = Math.random() ** 3;
            hold = rnd(0.001, 0.004) * sr;
          }
          tear[i] = (Math.random() * 2 - 1) * g;
        }
        const tearTau = near ? 0.28 : 0.4;
        shape(tear, sr, (s) => 0.5 * Math.min(1, s / 0.01) * Math.exp(-s / tearTau));
        for (let i = 0; i < cn; i += 1) c[i] += tear[i];
        biquad(c, sr, 'hp', near ? 220 : 160, 0.7);
        biquad(c, sr, 'lp', near ? 9000 : 2000, 0.7);
        if (!near) biquad(c, sr, 'lp', 2600, 0.7);
        peakTo(c, near ? 1 : 0.5);
        for (let i = 0; i < cn && i < n; i += 1) d[i] += c[i];
        yield;
      }
      {
        // удар: шум через фильтр с падающей частотой среза
        const b = noise(n);
        const fLow = far ? 90 : 80;
        const fHigh = near ? 520 : far ? 170 : 330;
        const tauF = near ? 0.35 : far ? 0.9 : 0.5;
        const t0 = near ? 0.02 : far ? 0.1 : 0.06;
        const att = near ? 0.012 : far ? 0.5 : 0.05;
        const decS = near ? 1.0 : far ? 2.2 : 1.5;
        let y1 = 0;
        let y2 = 0;
        let a = 0;
        for (let i = 0; i < n; i += 1) {
          const s = i / sr - t0;
          if (s < 0) {
            b[i] = 0;
            continue;
          }
          if ((i & 63) === 0) a = 1 - Math.exp((-TAU * (fLow + fHigh * Math.exp(-s / tauF))) / sr);
          y1 += a * (b[i] - y1);
          y2 += a * (y1 - y2);
          b[i] = y2;
        }
        shape(b, sr, (s) => (s < t0 ? 0 : (1 - Math.exp(-(s - t0) / att)) * Math.exp(-(s - t0) / decS)));
        peakTo(b, near ? 0.85 : far ? 0.5 : 0.8);
        for (let i = 0; i < n; i += 1) d[i] += b[i];
        yield;
      }
      if (!far) {
        // суббас 55 → 32 Гц (слышен в наушниках)
        let ph = 0;
        const m = Math.min(n, Math.floor(sr * 3));
        for (let i = 0; i < m; i += 1) {
          const s = i / sr;
          ph += (TAU * (32 + 23 * Math.exp(-s / 0.4))) / sr;
          d[i] += Math.sin(ph) * 0.22 * Math.min(1, s / 0.02) * Math.exp(-s / 0.9);
        }
      }
      {
        // раскаты: низкий шум под огибающей из наплывов-эхо + неровная дрожь
        const r = noise(n);
        biquad(r, sr, 'lp', far ? 240 : near ? 300 : 260, 0.7);
        biquad(r, sr, 'lp', far ? 320 : 420, 0.7);
        biquad(r, sr, 'hp', 45, 0.7);
        yield;
        const step = 64;
        const en = Math.ceil(n / step) + 2;
        const env = new Float32Array(en);
        const rolls = far ? 7 + Math.floor(Math.random() * 3) : 6 + Math.floor(Math.random() * 4);
        const span = seconds - (far ? 2.6 : 2.4);
        for (let k = 0; k < rolls; k += 1) {
          const at = k === 0 ? (far ? 0.2 : 0.35) : rnd(0.4, span);
          const amp = rnd(0.35, 1) * Math.exp(-at / (far ? 4 : 2.8));
          const up = rnd(0.08, 0.3) * (far ? 2 : 1);
          const down = rnd(0.5, 1.3) * (far ? 1.3 : 1);
          for (let j = Math.floor((at * sr) / step); j < en; j += 1) {
            const s = (j * step) / sr - at;
            if (s < 0) continue;
            if (s > down * 7) break;
            env[j] += amp * (1 - Math.exp(-s / up)) * Math.exp(-s / down);
          }
        }
        const fl = flutter(en, sr / step, 7);
        for (let j = 0; j < en; j += 1) env[j] *= Math.max(0.15, 1 + 0.4 * fl[j]);
        for (let i = 0; i < n; i += 1) {
          const p = i / step;
          const j = Math.floor(p);
          r[i] *= env[j] + (env[j + 1] - env[j]) * (p - j);
        }
        peakTo(r, near ? 0.55 : far ? 0.95 : 0.75);
        for (let i = 0; i < n; i += 1) d[i] += r[i];
      }
      fadeTail(d, sr, 1.5);
      peakTo(d, 0.95);
    },
  });

  // ---------- рецепты: name → { seconds, variants, loop, *render(d, sr, v) → длина (необязательно) } ----------
  const RECIPES = {
    // --- петли (длины разные и несоизмеримые: вместе не повторяются «пластинкой»)
    windLow: loop(6.1, 1, windLowFill),
    windMidA: loop(5.7, 1, (n, sr) => windMidFill(n, sr, { f0: 480, oct: 0.9, q: 2.6, f1: 950, oct1: 0.7, q1: 2 })),
    windMidB: loop(7.9, 1, (n, sr) => windMidFill(n, sr, { f0: 380, oct: 1, q: 3.2, f1: 1250, oct1: 0.6, q1: 1.8 })),
    windHigh: loop(4.9, 0.7, windHighFill),
    birdsBed: loop(7.1, 0.9, birdsBedFill),
    rainA: loop(5.3, 0.7, (n, sr) => rainFill(n, sr, RAIN.rainA)),
    rainB: loop(6.7, 0.7, (n, sr) => rainFill(n, sr, RAIN.rainB)),
    drizzle: loop(4.7, 0.6, (n, sr) => rainFill(n, sr, RAIN.drizzle)),
    pour: loop(5.9, 0.7, (n, sr) => rainFill(n, sr, RAIN.pour)),
    rumble: loop(7.3, 1, rumbleFill),
    gale: loop(6.5, 0.9, galeFill),
    crickets: loop(6.3, 0.6, cricketsFill),
    leaves: loop(5.5, 0.7, leavesFill),
    grit: loop(4.3, 0.6, gritFill),
    hailLoop: loop(5.1, 0.5, hailFill),
    snowBed: loop(4.1, 0.8, snowBedFill),
    // --- разовые
    // птица вблизи: один голос, слегка «в поле» (тихие отражения)
    bird: {
      seconds: 2.7,
      variants: 8,
      *render(d, sr, v) {
        const end = CALLS[v % CALLS.length](d, sr, 0.01, 0.8);
        yield;
        distant(d, sr, 7000, ECHO);
        yield;
        const n = Math.min(d.length, Math.floor((end + 0.42) * sr));
        fadeTail(d.subarray(0, n), sr, 0.12);
        peakTo(d.subarray(0, n), 0.8);
        return n;
      },
    },
    // капля рядом: по листу/земле («тук»), в лужу («бульк»), по твёрдому («тик»)
    drop: {
      seconds: 0.3,
      variants: 6,
      *render(d, sr, v) {
        const kind = v % 3;
        if (kind === 0) {
          const x = new Float32Array(d.length);
          click(x, 0, sr, rnd(0.004, 0.008), 1);
          biquad(x, sr, 'bp', rnd(500, 1100), 1.2);
          for (let i = 0; i < d.length; i += 1) d[i] += x[i] * 3;
          ping(d, 0, sr, rnd(180, 300), 0.012, 0.5);
        } else if (kind === 1) {
          click(d, 0, sr, 0.0006, 0.5);
          bubble(d, Math.floor(rnd(0.008, 0.02) * sr), sr, rnd(700, 1500), rnd(1.25, 1.6), rnd(0.02, 0.035), 1);
        } else {
          const f = rnd(1800, 3200);
          ping(d, 0, sr, f, 0.004, 1);
          ping(d, 0, sr, f * rnd(1.9, 2.3), 0.002, 0.5);
          click(d, 0, sr, 0.0005, 0.6);
        }
        fadeTail(d, sr, 0.03);
        peakTo(d, 0.8);
      },
    },
    // крупная градина рядом: стук и отскок
    hailHit: {
      seconds: 0.34,
      variants: 4,
      *render(d, sr) {
        knock(d, 0, sr, 1);
        const b = rnd(0.07, 0.13);
        knock(d, Math.floor(b * sr), sr, rnd(0.25, 0.4));
        if (Math.random() < 0.6) knock(d, Math.floor((b + rnd(0.05, 0.08)) * sr), sr, rnd(0.08, 0.16));
        fadeTail(d, sr, 0.03);
        peakTo(d, 0.85);
      },
    },
    // одинокий порыв ветра (зимняя тишина): наплыв и спад, тон поднимается и падает
    gust: {
      seconds: 4.6,
      variants: 2,
      *render(d, sr) {
        const n = d.length;
        const seconds = n / sr;
        const peakAt = rnd(0.33, 0.45) * seconds;
        const bell = (s) => (s < peakAt ? Math.sin((Math.PI / 2) * (s / peakAt)) ** 2 : Math.cos((Math.PI / 2) * ((s - peakAt) / (seconds - peakAt))) ** 2);
        const f0 = rnd(250, 320);
        const df = rnd(380, 560);
        const x = noise(n);
        sweepBand(x, sr, (i) => f0 + df * bell(i / sr), 2.2);
        shape(x, sr, bell);
        rmsTo(x, 1);
        yield;
        const h = noise(n);
        biquad(h, sr, 'hp', 2500, 0.7);
        biquad(h, sr, 'lp', 8000, 0.7);
        shape(h, sr, (s) => bell(s) ** 2);
        rmsTo(h, 0.22);
        const body = pink(n);
        biquad(body, sr, 'hp', 120, 0.7);
        biquad(body, sr, 'lp', 900, 0.7);
        shape(body, sr, bell);
        rmsTo(body, 0.5);
        for (let i = 0; i < n; i += 1) d[i] = x[i] + h[i] + body[i];
        peakTo(d, 0.7);
      },
    },
    thunderNear: thunder('near', 7.5, 2),
    thunderMid: thunder('mid', 8.5, 1),
    thunderFar: thunder('far', 9.5, 1),
  };
  return { RECIPES, REF };
}
export const { RECIPES, REF } = bakeLib();

// для графа и микса (свои копии: в bakeLib — такие же, но внутри)
const rnd = (a, b) => a + Math.random() * (b - a);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const ramp = (v, a, b) => clamp01((v - a) / (b - a));
const smooth = (v, a, b) => {
  const t = ramp(v, a, b);
  return t * t * (3 - 2 * t);
};

// ---------- запекание: один раз на страницу (ключ — версия и частота) ----------
// Тело фонового потока (его текст уходит в Blob вместе с bakeLib): считает буферы по списку и
// отдаёт каждый готовый Float32Array без копирования.
function bakeWorker(lib) {
  self.onmessage = (event) => {
    const { sampleRate, jobs } = event.data;
    for (const [name, v] of jobs) {
      const t0 = performance.now();
      try {
        const recipe = lib.RECIPES[name];
        const d = new Float32Array(Math.max(1, Math.ceil(recipe.seconds * sampleRate)));
        const it = recipe.render(d, sampleRate, v);
        let r = it.next();
        while (!r.done) r = it.next();
        const n = Number.isFinite(r.value) && r.value > 0 ? Math.min(d.length, Math.floor(r.value)) : d.length;
        const data = n === d.length ? d : d.slice(0, n);
        for (let i = 0; i < n; i += 1) if (data[i] !== data[i]) throw new Error('NaN в буфере');
        self.postMessage({ name, data, ms: performance.now() - t0 }, [data.buffer]);
      } catch (e) {
        self.postMessage({ name, error: String(e?.message ?? e) });
      }
    }
    self.postMessage({ done: true });
  };
}
const BAKE_GAP_MS = 24;
// urgent() → имена рецептов, которые нужны прямо сейчас (звучащая погода): они считаются первыми
const bake = (shared, c, urgent) => {
  const sampleRate = c.sampleRate;
  const key = `${BAKE_VERSION}|${sampleRate}`;
  if (shared.weatherSoundBank?.key === key) return shared.weatherSoundBank;
  try {
    shared.weatherSoundBank?.worker?.terminate();
  } catch {
    // уже остановлен
  }
  const bank = (shared.weatherSoundBank = { key, buffers: {}, jobs: 0, done: 0, failed: 0, mode: 'worker', worker: null, maxMs: 0, maxAt: null, totalMs: 0, startedMs: performance.now(), readyMs: 0 });
  const left = []; // [имя, вариант] — что ещё не готово, по порядку
  for (const [name, recipe] of Object.entries(RECIPES)) {
    bank.buffers[name] = [];
    for (let v = 0; v < (recipe.variants ?? 1); v += 1) left.push([name, v]);
  }
  bank.jobs = left.length;
  try {
    const first = urgent?.() ?? [];
    const rank = (name) => (first.includes(name) ? 0 : 1);
    left.sort((a, b) => rank(a[0]) - rank(b[0])); // устойчивая: прочие — в порядке RECIPES
  } catch {
    // порядок не важнее звука
  }
  const count = (name, ms) => {
    bank.totalMs += ms;
    if (ms > bank.maxMs) {
      bank.maxMs = ms;
      bank.maxAt = name;
    }
  };
  const accept = (name, data) => {
    const buffer = c.createBuffer(1, data.length, sampleRate);
    buffer.copyToChannel(data, 0);
    bank.buffers[name].push(buffer);
    bank.done += 1;
    if (bank.done + bank.failed >= bank.jobs) bank.readyMs = Math.round(performance.now() - bank.startedMs);
  };
  // запасной путь: на главном потоке, по одному кусочку рецепта за задачу
  const onMain = () => {
    bank.mode = 'main';
    let job = null;
    const step = () => {
      if (shared.weatherSoundBank !== bank) return;
      if (!job) {
        if (!left.length) return;
        const [name, v] = left[0];
        job = { name, d: null, it: null, v };
      }
      const t0 = performance.now();
      const name = job.name;
      try {
        if (!job.it) {
          const recipe = RECIPES[job.name];
          job.d = new Float32Array(Math.max(1, Math.ceil(recipe.seconds * sampleRate)));
          job.it = recipe.render(job.d, sampleRate, job.v);
        }
        const r = job.it.next();
        if (r.done) {
          const n = Number.isFinite(r.value) && r.value > 0 ? Math.min(job.d.length, Math.floor(r.value)) : job.d.length;
          const data = n === job.d.length ? job.d : job.d.subarray(0, n);
          for (let i = 0; i < n; i += 1) if (data[i] !== data[i]) throw new Error('NaN в буфере');
          accept(job.name, data);
          left.shift();
          job = null;
        }
      } catch (e) {
        console.warn('[weather-sound] не запёкся', job.name, e?.message ?? e);
        bank.failed += 1;
        left.shift();
        job = null;
      }
      count(name, performance.now() - t0);
      setTimeout(step, BAKE_GAP_MS);
    };
    setTimeout(step, 0);
  };
  try {
    const url = URL.createObjectURL(new Blob([`(${bakeWorker})((${bakeLib})());`], { type: 'text/javascript' }));
    const worker = new Worker(url);
    bank.worker = worker;
    const finish = () => {
      worker.terminate();
      URL.revokeObjectURL(url);
      bank.worker = null;
    };
    worker.onmessage = (event) => {
      const m = event.data;
      if (shared.weatherSoundBank !== bank || m.done) {
        finish();
        return;
      }
      try {
        left.shift();
        if (m.error) {
          bank.failed += 1;
          console.warn('[weather-sound] не запёкся', m.name, m.error);
        } else {
          count(m.name, m.ms);
          accept(m.name, m.data);
        }
      } catch (e) {
        bank.failed += 1;
        console.warn('[weather-sound] не принят', m.name, e?.message ?? e);
      }
    };
    worker.onerror = (event) => {
      console.warn('[weather-sound] фоновый поток не завёлся, считаю на главном:', event?.message ?? event);
      finish();
      if (shared.weatherSoundBank === bank) onMain();
    };
    worker.postMessage({ sampleRate, jobs: left.slice() });
  } catch (e) {
    console.warn('[weather-sound] нет фонового потока, считаю на главном:', e?.message ?? e);
    onMain();
  }
  return bank;
};

// ---------- постоянный граф ----------
// слой: [имя, буфер, каналов (2 — один буфер двумя источниками со сдвигом влево и вправо), сглаживание с]
const LAYERS = [
  ['drizzle', 'drizzle', 2, 0.8],
  ['rainA', 'rainA', 2, 0.8],
  ['rainB', 'rainB', 2, 0.8],
  ['pour', 'pour', 2, 0.8],
  ['rumble', 'rumble', 1, 0.8],
  ['windLow', 'windLow', 1, 0.45],
  ['windMidA', 'windMidA', 2, 0.35],
  ['windMidB', 'windMidB', 2, 0.35],
  ['windHigh', 'windHigh', 2, 0.3],
  ['gale', 'gale', 2, 0.4],
  ['grit', 'grit', 2, 0.35],
  ['hail', 'hailLoop', 2, 0.6],
  ['snowBed', 'snowBed', 2, 1.2],
  ['birds', 'birdsBed', 2, 1.2],
  ['crickets', 'crickets', 2, 1.2],
  ['leaves', 'leaves', 2, 0.35],
];
const LI = Object.fromEntries(LAYERS.map((l, i) => [l[0], i]));

const drop = (...nodes) => {
  for (const n of nodes) {
    try {
      n?.disconnect();
    } catch {
      // уже отключён
    }
  }
};
const stopSources = (L) => {
  for (const s of L.sources) {
    try {
      s.stop();
    } catch {
      // не запущен
    }
    drop(s);
  }
  L.sources.length = 0;
};
const graphFor = (shared, g) => {
  const cur = shared.weatherVoices;
  const bus = npcOut(g); // шина мира (audio-budget.js): свой лимитер, приглушается на выстрел игрока
  if (cur?.version === GRAPH_VERSION && cur.context === g.context && cur.master === g.master && cur.bus === bus) return cur;
  if (cur) {
    for (const L of cur.layers) {
      stopSources(L);
      drop(L.gain, L.merger);
    }
    for (const v of [...cur.small, ...cur.big]) {
      try {
        v.source?.stop();
      } catch {
        // уже закончился
      }
      drop(v.source, v.gain, v.pan);
    }
    drop(cur.out);
  }
  const c = g.context;
  const out = c.createGain();
  out.gain.value = 1;
  out.connect(bus);
  let fixed = 1;
  const layers = LAYERS.map(([name, buffer, channels, tau]) => {
    const gain = c.createGain();
    gain.gain.value = 0;
    gain.connect(out);
    let merger = null;
    if (channels === 2) {
      merger = c.createChannelMerger(2);
      merger.connect(gain);
    }
    fixed += merger ? 2 : 1;
    return { name, buffer, tau, gain, merger, sources: [], bankKey: '', cur: 0, written: 0, idle: 0 };
  });
  const voice = () => {
    const gain = c.createGain();
    gain.gain.value = 0;
    const pan = c.createStereoPanner();
    gain.connect(pan).connect(out);
    fixed += 2;
    return { gain, pan, source: null, endAt: 0, startedAt: 0, automated: false };
  };
  const small = [];
  for (let i = 0; i < SMALL; i += 1) small.push(voice());
  const big = [];
  for (let i = 0; i < BIG; i += 1) big.push(voice());
  return (shared.weatherVoices = { version: GRAPH_VERSION, context: c, master: g.master, bus, out, layers, small, big, fixed, owner: null, muted: false, volume: 1 });
};

const KEYS = ['rain', 'snow', 'hail', 'sleet', 'dust', 'wind', 'gust', 'fog', 'day', 'hour', 'spring', 'summer', 'autumn', 'winter', 'leaves', 'snowCover'];

export function createWeatherSound(ctx) {
  const shared = (globalThis.__sceneState ??= {});
  const token = {};
  const N = {}; // поля погоды этого кадра (числа)
  for (const k of KEYS) N[k] = 0;
  const target = new Float32Array(LAYERS.length); // усиления слоёв (RMS / REF)
  // счётчики переживают подмену сцены (отладка): сколько чего сыграно и сколько создано источников
  const played = (shared.weatherSoundCounters ??= { drop: 0, hail: 0, bird: 0, thunder: 0, gust: 0, skipped: 0, stolen: 0, loopSources: 0 });
  let lastMs = performance.now();
  let clock = Math.random() * 100;
  let est = 0; // оценка RMS суммы петель
  let scale = 1;
  let errors = 0;
  let lastError = null;
  let has = false;
  let birdAmt = 0;
  let cricketAmt = 0;
  let dropLeft = 1;
  let hailLeft = 0.5;
  let birdLeft = rnd(1, 4);
  let gustLeft = rnd(8, 20);
  let off = null;
  let subscribed = null;
  let lastThunderMs = -1e9;
  let cpuAvg = 0;
  let cpuMax = 0;
  // гром в пути: звук идёт 343 м/с
  const pending = [];
  for (let i = 0; i < 8; i += 1) pending.push({ live: false, at: 0, dist: 0, power: 1, x: 0, z: 0, dir: false });

  const expo = (mean) => mean * Math.min(3, Math.max(0.2, -Math.log(1 - Math.random())));
  const pick = (bank, name) => {
    const list = bank.buffers[name];
    return list?.length ? list[Math.floor(Math.random() * list.length)] : null;
  };

  // разовый звук: свободный голос пула; занято — пропуск (steal: старейший гаснет за 60 мс)
  const shot = (G, pool, buffer, vol, pan = 0, rate = 1, steal = false) => {
    if (!buffer || !(vol > 0) || !Number.isFinite(vol) || !Number.isFinite(rate)) return false;
    const c = G.context;
    const t = c.currentTime;
    let v = null;
    for (const x of pool) {
      if (x.endAt <= t) {
        v = x;
        break;
      }
      if (!v || x.startedAt < v.startedAt) v = x;
    }
    let at = t;
    const gain = v.gain.gain;
    const level = Math.min(1, vol);
    if (v.endAt > t && v.source) {
      if (!steal) {
        played.skipped += 1;
        return false;
      }
      gain.cancelScheduledValues(t);
      gain.setValueAtTime(gain.value, t);
      gain.linearRampToValueAtTime(0, t + 0.06);
      try {
        v.source.stop(t + 0.062);
      } catch {
        // уже закончился
      }
      at = t + 0.064;
      gain.setValueAtTime(level, at);
      v.automated = true;
      played.stolen += 1;
    } else {
      if (v.automated) {
        gain.cancelScheduledValues(t);
        v.automated = false;
      }
      gain.value = level;
    }
    v.pan.pan.value = Math.min(1, Math.max(-1, Number.isFinite(pan) ? pan : 0));
    const source = c.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = rate;
    source.connect(v.gain);
    source.onended = () => {
      drop(source);
      if (v.source === source) v.source = null;
    };
    source.start(at);
    v.source = source;
    v.startedAt = at;
    v.endAt = at + buffer.duration / rate;
    return true;
  };

  const thunderNow = (G, bank, p) => {
    const d = p.dist * rnd(0.85, 1.2); // граница «близко/далеко» размыта
    const name = d < 600 ? 'thunderNear' : d < 2200 ? 'thunderMid' : 'thunderFar';
    const buffer = pick(bank, name) ?? pick(bank, 'thunderMid') ?? pick(bank, 'thunderNear') ?? pick(bank, 'thunderFar');
    // power у атмосферы уже падает с расстоянием (1 на 300 м … 0,35 на 3 км), поэтому свой спад пологий:
    // 300 м — 0,47, 1 км — 0,31, 3 км — 0,10 (пик буфера 0,95)
    const vol = Math.min(0.6, Math.min(1.2, Math.max(0.3, p.power)) * (0.2 + 0.36 / (1 + p.dist / 900)));
    let pan = 0;
    if (p.dir) {
      // дешёвая панорама: с какой стороны от головы ударило; далёкий гром — шире и ближе к центру
      const e = ctx.camera?.matrixWorld?.elements;
      if (e) {
        const dx = p.x - e[12];
        const dz = p.z - e[14];
        const len = Math.hypot(dx, dz);
        const rl = Math.hypot(e[0], e[2]);
        if (len > 1 && rl > 1e-3) pan = ((dx * e[0] + dz * e[2]) / (len * rl)) * (0.75 - 0.4 * ramp(p.dist, 300, 3000));
      }
    }
    if (shot(G, G.big, buffer, vol, pan, rnd(0.92, 1.06), true)) played.thunder += 1;
  };
  const strike = (e, forced = false) => {
    try {
      // пока погода подменена для проверки (weatherSoundDebug.set), настоящие молнии не гремят
      if (!forced && shared.weatherSoundOverride) return;
      const m = ctx.camera?.matrixWorld?.elements;
      const dir = Number.isFinite(e?.x) && Number.isFinite(e?.z);
      let dist = e?.distM;
      if (!Number.isFinite(dist)) dist = dir && m ? Math.hypot(e.x - m[12], e.z - m[14]) : 1500;
      dist = Math.max(30, dist);
      for (const p of pending) {
        if (p.live) continue;
        p.live = true;
        p.at = performance.now() + Math.min(14, dist / SOUND_SPEED) * 1000;
        p.dist = dist;
        p.power = Number.isFinite(e?.power) ? e.power : 1;
        p.x = dir ? e.x : 0;
        p.z = dir ? e.z : 0;
        p.dir = dir;
        return;
      }
    } catch {
      // звук не важнее игры
    }
  };

  // усиления слоёв по погоде. Числа — RMS слоя на выходе погоды; сумма сжимается выше KNEE.
  const mix = () => {
    target.fill(0);
    birdAmt = 0;
    cricketAmt = 0;
    if (!has) return;
    const rain = Math.max(0, N.rain) + 0.5 * Math.max(0, N.sleet);
    const wind = Math.min(1.6, Math.max(0, N.wind));
    const gust = clamp01(N.gust);
    const snow = clamp01(N.snow);
    const hail = clamp01(N.hail);
    const dust = clamp01(N.dust);
    // свои медленные «вдохи»: ровный ветер не стоит на месте
    const lifeA = 1 + 0.12 * Math.sin(clock * 0.41) + 0.08 * Math.sin(clock * 0.17 + 2);
    const lifeB = 1 + 0.12 * Math.sin(clock * 0.33 + 1.3) + 0.08 * Math.sin(clock * 0.23 + 4);

    target[LI.drizzle] = 0.011 * ramp(rain, 0, 0.15) * (1 - 0.65 * ramp(rain, 0.3, 1));
    const body = 0.021 * ramp(rain, 0.05, 0.5) * (1 + 0.15 * ramp(rain, 0.5, 1));
    target[LI.rainA] = body;
    target[LI.rainB] = body;
    target[LI.pour] = 0.05 * smooth(rain, 0.5, 1.05);
    target[LI.rumble] = 0.026 * smooth(rain, 0.65, 1.1) + 0.03 * smooth(wind, 0.9, 1.5);

    // густой туман в штиль глушит и ветер (в бурю «туман» — это ливень или пыль: там не глушим)
    const hush = 1 - 0.5 * clamp01(N.fog) * (1 - ramp(wind, 0.2, 0.6));
    target[LI.windLow] = 0.028 * wind ** 1.3 * (0.8 + 0.35 * gust) * lifeA * hush;
    const mid = 0.024 * wind ** 1.4 * (0.5 + 0.9 * gust) * hush;
    target[LI.windMidA] = mid * lifeA;
    target[LI.windMidB] = mid * lifeB;
    // трава под снегом не шелестит
    const grass = 1 - 0.7 * Math.max(clamp01(N.snowCover), 0.6 * clamp01(N.winter));
    target[LI.windHigh] = 0.02 * wind * (0.35 + 1.0 * gust) * lifeB * grass * hush;
    target[LI.gale] = 0.05 * ramp(wind, 0.85, 1.5) ** 1.3 * (0.75 + 0.4 * gust);
    target[LI.grit] = 0.02 * snow * ramp(wind, 0.15, 0.9) * (0.6 + 0.6 * gust) + 0.03 * dust * (0.35 + 0.65 * ramp(wind, 0.2, 1)) * (0.7 + 0.5 * gust);
    target[LI.hail] = 0.045 * hail ** 0.8 + 0.01 * clamp01(N.sleet);
    target[LI.snowBed] = 0.005 * smooth(snow, 0.05, 0.6);

    // природа: в дождь, бурю, снег птицы и сверчки молчат; в тумане всё тише
    const calm = (1 - ramp(rain, 0.05, 0.35)) * (1 - ramp(wind, 0.55, 1)) * (1 - ramp(snow, 0.1, 0.6)) * (1 - hail) * (1 - dust);
    const quiet = 1 - 0.7 * clamp01(N.fog);
    const day = clamp01(N.day);
    const morning = Math.exp(-(((N.hour - 7.5) / 3) ** 2)); // утренний хор
    const season = clamp01(N.spring + 0.8 * N.summer + 0.22 * N.autumn);
    birdAmt = season * Math.min(1, day * (0.55 + 0.45 * morning) + 0.3 * morning * (1 - day)) * calm * quiet;
    cricketAmt = clamp01(N.summer) * (1 - smooth(day, 0.25, 0.6)) * calm * quiet;
    target[LI.birds] = 0.009 * birdAmt;
    target[LI.crickets] = 0.011 * cricketAmt;
    target[LI.leaves] = (0.018 * clamp01(N.autumn) * wind * (0.4 + 0.9 * gust) + 0.012 * clamp01(N.leaves) * (0.3 + 0.7 * ramp(wind, 0.1, 0.8))) * lifeA;

    let s = 0;
    for (let i = 0; i < target.length; i += 1) s += target[i] * target[i];
    est = Math.sqrt(s);
    scale = est > KNEE ? Math.min(CAP, KNEE + (est - KNEE) * 0.4) / est : 1;
    const k = scale / REF;
    for (let i = 0; i < target.length; i += 1) target[i] *= k;
  };

  const read = () => {
    const now = shared.atmosphere?.now;
    const o = shared.weatherSoundOverride;
    if (!now && !o) return false;
    for (let i = 0; i < KEYS.length; i += 1) {
      const k = KEYS[i];
      let v = o && k in o ? o[k] : now?.[k];
      if (typeof v !== 'number' || v !== v) v = k === 'day' ? 1 : k === 'hour' ? 12 : 0;
      N[k] = v;
    }
    return true;
  };

  // что печь первым: слои, которые уже должны звучать, гром в грозу, птицы
  const urgent = () => {
    const names = [];
    for (let i = 0; i < LAYERS.length; i += 1) if (target[i] > 0) names.push(LAYERS[i][1]);
    if (shared.atmosphere?.now?.lightning > 0.02) names.push('thunderNear', 'thunderMid', 'thunderFar');
    if (birdAmt > 0.04) names.push('bird');
    if (target[LI.hail] > 0) names.push('hailHit');
    if (target[LI.drizzle] > 0) names.push('drop');
    return names;
  };

  const startLayer = (c, L, bank) => {
    const buffer = bank.buffers[L.buffer]?.[0];
    if (!buffer) return; // ещё запекается
    const t = c.currentTime + 0.02;
    const make = (dest, input, offset) => {
      const s = c.createBufferSource();
      s.buffer = buffer;
      s.loop = true;
      if (input === null) s.connect(dest);
      else s.connect(dest, 0, input);
      s.start(t, offset * buffer.duration);
      L.sources.push(s);
      played.loopSources += 1;
    };
    if (L.merger) {
      make(L.merger, 0, rnd(0, 0.2));
      make(L.merger, 1, rnd(0.37, 0.57));
    } else make(L.gain, null, Math.random() * 0.9);
    L.bankKey = bank.key;
  };

  const step = (dt) => {
    const g = shared.audioGraph;
    const c = g?.context;
    if (!c || !g.master || c.state === 'closed') return;
    clock += dt;
    has = read();
    mix();
    const bank = bake(shared, c, urgent);
    const G = graphFor(shared, g);
    if (G.owner !== token) {
      G.owner = token;
      if (G.muted) {
        G.out.gain.cancelScheduledValues(c.currentTime);
        G.out.gain.value = G.volume;
        G.muted = false;
      }
    }
    const volume = Math.min(2, Math.max(0, Number.isFinite(shared.weatherVolume) ? shared.weatherVolume : 1));
    if (volume !== G.volume) {
      G.volume = volume;
      G.out.gain.value = volume;
    }
    // подписка на молнии (модуль атмосферы может появиться позже или смениться)
    const atmo = shared.atmosphere;
    if (atmo !== subscribed) {
      try {
        off?.();
      } catch {
        // подписки уже нет
      }
      off = null;
      subscribed = atmo ?? null;
      if (typeof atmo?.on === 'function') off = atmo.on('lightning', (e) => strike(e));
    }

    // слои: громкость к цели (сглаживание в JS, запись .value — только когда заметно изменилась)
    for (let i = 0; i < G.layers.length; i += 1) {
      const L = G.layers[i];
      const want = target[i];
      if (L.sources.length && L.bankKey !== bank.key) stopSources(L); // банк перепечён
      if (want > 0.004 && !L.sources.length) startLayer(c, L, bank);
      if (!L.sources.length) {
        L.cur = 0;
        continue;
      }
      L.cur += (want - L.cur) * (1 - Math.exp(-dt / L.tau));
      if (want === 0 && L.cur < 0.003) L.cur = 0; // RMS слоя уже ниже −68 дБ: шаг в ноль не слышен
      if (Math.abs(L.cur - L.written) > 0.0002 + 0.004 * L.written || (L.cur === 0 && L.written !== 0)) {
        L.gain.gain.value = L.cur;
        L.written = L.cur;
      }
      if (L.cur === 0) {
        L.idle += dt;
        if (L.idle > IDLE_S) stopSources(L);
      } else L.idle = 0;
    }

    // гром, дошедший до игрока
    const nowMs = performance.now();
    for (let i = 0; i < pending.length; i += 1) {
      const p = pending[i];
      if (!p.live || p.at > nowMs) continue;
      p.live = false;
      if (nowMs - lastThunderMs < THUNDER_GAP_MS) {
        played.skipped += 1; // ускоренное время («Время ×N») даёт молнии пачками
        continue;
      }
      lastThunderMs = nowMs;
      thunderNow(G, bank, p);
    }
    if (!has) return;

    const rain = Math.max(0, N.rain) + 0.5 * Math.max(0, N.sleet);
    // отдельные капли по ближним поверхностям — при слабом дожде (в сильном их не слышно)
    const drops = ramp(rain, 0.03, 0.12) * (1 - ramp(rain, 0.45, 0.8));
    if (drops > 0) {
      dropLeft -= dt;
      if (dropLeft <= 0) {
        dropLeft = expo(1 / (0.8 + 2 * ramp(rain, 0.03, 0.3)));
        if (shot(G, G.small, pick(bank, 'drop'), rnd(0.05, 0.13) * (0.5 + 0.5 * drops), rnd(-0.9, 0.9), rnd(0.85, 1.25))) played.drop += 1;
      }
    }
    const hail = clamp01(N.hail);
    if (hail > 0.03) {
      hailLeft -= dt;
      if (hailLeft <= 0) {
        hailLeft = expo(1 / (1 + 4 * hail));
        if (shot(G, G.small, pick(bank, 'hailHit'), rnd(0.08, 0.2) * (0.5 + 0.5 * hail), rnd(-0.9, 0.9), rnd(0.8, 1.3))) played.hail += 1;
      }
    }
    if (birdAmt > 0.04) {
      birdLeft -= dt;
      if (birdLeft <= 0) {
        birdLeft = expo(Math.max(1.6, 2.6 / birdAmt));
        // кукушка (вариант 4) — реже остальных, и только весной и летом
        let buffer = pick(bank, 'bird');
        if (buffer === bank.buffers.bird[4] && (Math.random() < 0.6 || N.spring + N.summer < 0.5)) buffer = bank.buffers.bird[Math.floor(Math.random() * 4)];
        if (shot(G, G.small, buffer, (0.03 + 0.06 * Math.random()) * Math.min(1, 0.4 + birdAmt), rnd(-0.85, 0.85), rnd(0.9, 1.15))) played.bird += 1;
      }
    }
    // зимой — тишина и редкий порыв
    const lonely = clamp01(N.winter) * (1 - ramp(N.wind, 0.3, 0.6)) * (1 - ramp(rain, 0.1, 0.4));
    if (lonely > 0.3) {
      gustLeft -= dt;
      if (gustLeft <= 0) {
        gustLeft = rnd(16, 40);
        if (shot(G, G.big, pick(bank, 'gust'), rnd(0.05, 0.09) * lonely, rnd(-0.5, 0.5), rnd(0.85, 1.1))) played.gust += 1;
      }
    }
  };

  const stats = () => {
    const G = shared.weatherVoices;
    const bank = shared.weatherSoundBank;
    const t = G?.context.currentTime ?? 0;
    const layers = {};
    let loopSources = 0;
    for (const L of G?.layers ?? []) {
      loopSources += L.sources.length;
      if (L.sources.length) layers[L.name] = +L.cur.toFixed(4);
    }
    let shots = 0;
    for (const v of [...(G?.small ?? []), ...(G?.big ?? [])]) if (v.source && v.endAt > t) shots += 1;
    return {
      ctx: G?.context.state ?? 'none',
      baked: bank ? Object.fromEntries(Object.entries(bank.buffers).map(([k, v]) => [k, v.length])) : null,
      bake: bank ? { mode: bank.mode, done: bank.done, failed: bank.failed, jobs: bank.jobs, maxMs: +bank.maxMs.toFixed(1), maxAt: bank.maxAt, totalMs: Math.round(bank.totalMs), readyMs: bank.readyMs } : null,
      has,
      state: { ...N },
      layers, // усиления звучащих слоёв (RMS слоя = усиление × REF)
      est: +est.toFixed(4), // RMS суммы петель до потолка
      scale: +scale.toFixed(3),
      birdAmt: +birdAmt.toFixed(3),
      cricketAmt: +cricketAmt.toFixed(3),
      nodes: { fixed: G?.fixed ?? 0, loopSources, shots },
      cpuMs: { avg: +cpuAvg.toFixed(4), max: +cpuMax.toFixed(2) }, // цена update() на главном потоке
      played: { ...played },
      pending: pending.filter((p) => p.live).length,
      errors,
      lastError,
    };
  };

  // граф прежнего экземпляра (подмена сцены) сразу переходит к этому: dispose() его не заглушит
  if (shared.weatherVoices) shared.weatherVoices.owner = token;

  // ручка для npm run vr:eval
  shared.weatherSoundDebug = {
    set(o) {
      shared.weatherSoundOverride = { ...(shared.weatherSoundOverride ?? {}), ...o };
      return shared.weatherSoundOverride;
    },
    clear() {
      shared.weatherSoundOverride = null;
    },
    // гром: расстояние (м), сила, азимут (°: 0 — прямо перед головой, 90 — справа)
    thunder(distM = 800, power = 1, azimuthDeg = 0) {
      const e = ctx.camera?.matrixWorld?.elements;
      if (!e) return strike({ distM, power }, true);
      const a = (azimuthDeg * Math.PI) / 180;
      const fx = -e[8];
      const fz = -e[10];
      const fl = Math.hypot(fx, fz) || 1;
      const rl = Math.hypot(e[0], e[2]) || 1;
      const x = e[12] + distM * ((fx / fl) * Math.cos(a) + (e[0] / rl) * Math.sin(a));
      const z = e[14] + distM * ((fz / fl) * Math.cos(a) + (e[2] / rl) * Math.sin(a));
      return strike({ x, y: 0, z, distM, power }, true);
    },
    // сколько мс считается рецепт на главном потоке (проверка запасного пути): bench('bird', 0)
    bench(name, v = 0) {
      const recipe = RECIPES[name];
      const sr = shared.audioGraph?.context?.sampleRate ?? 48000;
      const d = new Float32Array(Math.ceil(recipe.seconds * sr));
      const t0 = performance.now();
      const it = recipe.render(d, sr, v);
      let slices = 1;
      let worst = 0;
      let t1 = t0;
      let r = it.next();
      for (;;) {
        const t2 = performance.now();
        worst = Math.max(worst, t2 - t1);
        t1 = t2;
        if (r.done) break;
        slices += 1;
        r = it.next();
      }
      return { ms: +(performance.now() - t0).toFixed(1), slices, worstSliceMs: +worst.toFixed(1) };
    },
    stats,
  };

  return {
    update() {
      const nowMs = performance.now();
      const dt = Math.min(0.1, (nowMs - lastMs) / 1000);
      lastMs = nowMs;
      if (!(dt > 0)) return;
      try {
        step(dt);
      } catch (e) {
        // звук не важнее игры
        errors += 1;
        lastError = String(e?.message ?? e);
      }
      // цена кадра (для stats): среднее и худшее
      const ms = performance.now() - nowMs;
      cpuAvg += (ms - cpuAvg) * 0.02;
      if (ms > cpuMax) cpuMax = ms;
    },
    dispose() {
      try {
        off?.();
      } catch {
        // подписки уже нет
      }
      off = null;
      subscribed = null;
      // сцена подменяется — граф остаётся новому экземпляру; если его не будет, погода плавно смолкнет
      const G = shared.weatherVoices;
      if (G?.owner === token) {
        G.owner = null;
        setTimeout(() => {
          try {
            if (shared.weatherVoices !== G || G.owner) return;
            const t = G.context.currentTime;
            G.out.gain.cancelScheduledValues(t);
            G.out.gain.setValueAtTime(G.out.gain.value, t);
            G.out.gain.linearRampToValueAtTime(0, t + 0.5);
            G.muted = true;
          } catch {
            // контекст закрыт
          }
        }, 1500);
      }
    },
    stats,
  };
}
