// Звуки выстрела и попадания. Выстрелы — записи настоящего оружия (web/public/sounds/guns, CC0, см. LICENSE.txt),
// пока они не загрузились — запечённый синтез. Попадание, тарелка, гильза, разряд — синтез, запечённый в буферы.
// Живёт в сцене: правки подхватываются на лету.
//
// Объект звука живёт в globalThis.__sceneState.sound (его создаёт shooting.js один раз). Когда этот
// файл меняется так, что нужен новый объект, увеличь SOUND_VERSION: main.js тогда пересоздаёт его,
// а сам звуковой контекст (их число в странице ограничено) берётся прежний — __sceneState.audioGraph.
//
// Почему так (очередь «ломала» звук): раньше каждый выстрел строил свой граф (~11 узлов у АК, ~22 у
// пистолета, ~24 у звона мишени, на каждый — свой HRTF-паннер и задержка) и ничего не отключал; на
// очереди это ~500 новых узлов в секунду (2,8 мс главного потока на выстрел в шлеме) и перегруз
// аудиопотока Quest, а компрессор почти не ограничивал (сумма выстрелов жёстко клиповалась на выходе).
// Теперь: всё синтезированное запекается в буферы один раз (OfflineAudioContext); голоса — постоянные
// цепочки (паннер, стерео, посылы) в пулах с жёстким лимитом и мягким «отъёмом» старейшего; на звук
// создаются только источник и его гейн, и они отключаются в onended; в конце — лимитер и мягкий клип;
// сторож в update() поднимает приостановленный контекст и пересобирает выход, если в нём NaN.
// 26: AWP — один голос (слои смешаны заранее); пулы больше и раздельные (выстрелы / попадания /
// затвор / гильзы), отнимается только голос в тихом хвосте и никогда не самый новый. Псы
// (robodog-sound.js) — свой пул на том же графе. 24: bolt(…, 'cycle'); 23: AWP и затвор
import { audioBudget } from './audio-budget.js';

export const SOUND_VERSION = 33; // 33: stats().budget; 32: свой звук не пропускается (нет свободного — делит голос со старейшим), голова → audioBudget, свой выстрел приглушает шину мира; 31: мана громче; 30: мана без запасного выстрела, lastShot в stats; 29: мана (shot kind 'mana', manaHit); 28: мягче лимитер; 27: пулы без лишнего (dog)
// какие записи звучат в игре (sound-board.js помечает их «в игре»)
export const GUN_FILES = { pistol: ['pistolB1', 'pistolB2'], ak: ['ak1', 'ak2', 'ak3'] };

const BAKE_VERSION = 5; // 5: мана — «вумм-шинг» вместо выстрела; 4: мана (manaShot, manaHit); 3: AWP одним буфером. Меняй, когда меняются рецепты ниже (синтез перезапечётся)
const BUS_VERSION = 2; // меняй при изменении выхода (лимитер, реверб)
const POOL_VERSION = 3; // меняй при изменении устройства голосов

const NEAR_FAR = 1.2; // дальше — обычный HRTF; ближе — ближнее поле
const NEAR_FULL = 0.55; // ближе — почти чистое стерео
const STEAL_FADE = 0.06; // с, за сколько гасится отнятый голос (он уже в тихом хвосте)
const DRIVE = 3; // мягкий клип: вход ±3 → выход до ±1
const SHOT_MIN_GAP_MS = 55; // звук своего выстрела — не чаще ~18 в секунду реального времени
// Пулы голосов: size — постоянных цепочек; max — сколько звучит, прежде чем отнимать; minAge — отнимать
// только звук старше этого (с): он уже в тихом хвосте; самый новый не отнимается никогда. Нечего
// отнять — звучит сверх max, пока есть свободные цепочки. Голос — один источник буфера, их может быть много.
const POOLS = {
  gun: { size: 16, max: 12, minAge: 0.45, near: true, model: 'HRTF' }, // выстрелы (запись 1,3 с)
  impact: { size: 12, max: 10, minAge: 0.25, near: false, model: 'HRTF' }, // звон мишени, тарелки, разряды
  mech: { size: 4, max: 3, minAge: 0.2, near: false, model: 'equalpower' }, // затвор АВП
  small: { size: 6, max: 4, minAge: 0.08, near: false, model: 'equalpower' }, // гильзы: тихо и часто
};

const finite = (v, fallback = 0) => (Number.isFinite(v) ? v : fallback);
const validPos = (p) => (p && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z) ? p : null);

// ---------- рецепты синтеза (рисуют в любой контекст, в т. ч. OfflineAudioContext) ----------

const noiseBuffers = new Map();
const noiseBuffer = (c, seconds) => {
  const key = `${c.sampleRate}:${seconds}`;
  const cached = noiseBuffers.get(key);
  if (cached) return cached;
  const buffer = c.createBuffer(1, Math.max(1, Math.floor(c.sampleRate * seconds)), c.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i += 1) data[i] = Math.random() * 2 - 1;
  noiseBuffers.set(key, buffer);
  return buffer;
};

// шумовая вспышка через фильтр: type 'highpass' | 'lowpass' | 'bandpass', частота плавно меняется
const noise = (c, out, t, { seconds, type, from, to, gain, decay }) => {
  const source = c.createBufferSource();
  source.buffer = noiseBuffer(c, seconds);
  const filter = c.createBiquadFilter();
  filter.type = type;
  filter.frequency.setValueAtTime(from, t);
  filter.frequency.exponentialRampToValueAtTime(to, t + decay);
  const envelope = c.createGain();
  envelope.gain.setValueAtTime(0.0001, t);
  envelope.gain.exponentialRampToValueAtTime(gain, t + 0.002);
  envelope.gain.exponentialRampToValueAtTime(0.0001, t + decay);
  source.connect(filter).connect(envelope).connect(out);
  source.start(t);
  source.stop(t + seconds);
};

const tone = (c, out, t, { type = 'sine', from, to = from, gain, decay }) => {
  const osc = c.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(from, t);
  if (to !== from) osc.frequency.exponentialRampToValueAtTime(to, t + decay);
  const envelope = c.createGain();
  envelope.gain.setValueAtTime(0.0001, t);
  envelope.gain.exponentialRampToValueAtTime(gain, t + 0.002);
  envelope.gain.exponentialRampToValueAtTime(0.0001, t + decay);
  osc.connect(envelope).connect(out);
  osc.start(t);
  osc.stop(t + decay + 0.02);
};

// (для маны; только в запекании, OfflineAudioContext — не при игре)
// гейн-огибающая → out: подъём за attack с до peak, спад за decay с
const envGain = (c, out, t, attack, peak, decay) => {
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  g.connect(out);
  return g;
};
// колокольчик: чистый синус с мягкой атакой и долгим спадом
const bell = (c, out, t, freq, gain, decay, attack = 0.005) => {
  const osc = c.createOscillator();
  osc.frequency.value = freq;
  osc.connect(envGain(c, out, t, attack, gain, decay));
  osc.start(t);
  osc.stop(t + attack + decay + 0.02);
};

const PISTOL_GAIN = 1.7; // пистолет громче и звонче: запись глуховата и терялась на фоне звона попадания

const RECIPES = {
  // «хлёсткость» пистолета: короткий яркий треск и тонкий металлический звон поверх записи
  // (громкости поделены на PISTOL_GAIN: при игре запись с ними умножается на него)
  pistolCrack(c, out, t) {
    const k = 1 / PISTOL_GAIN;
    noise(c, out, t, { seconds: 0.05, type: 'highpass', from: 4500, to: 2500, gain: 0.5 * k, decay: 0.03 });
    tone(c, out, t, { type: 'triangle', from: 2350, gain: 0.07 * k, decay: 0.16 });
    tone(c, out, t, { type: 'sine', from: 3720, gain: 0.04 * k, decay: 0.12 });
  },
  // запасной выстрел, пока записи не загрузились
  synthAk(c, out, t) {
    const jitter = 1 + (Math.random() - 0.5) * 0.08;
    noise(c, out, t, { seconds: 0.2, type: 'highpass', from: 1900 * jitter, to: 650, gain: 1, decay: 0.09 });
    noise(c, out, t, { seconds: 0.6, type: 'lowpass', from: 3200 * jitter, to: 220, gain: 1, decay: 0.42 });
    noise(c, out, t, { seconds: 0.3, type: 'bandpass', from: 900, to: 320, gain: 0.6, decay: 0.2 });
    tone(c, out, t, { from: 125 * jitter, to: 28, gain: 1, decay: 0.32 });
    tone(c, out, t + 0.003, { type: 'triangle', from: 68, to: 24, gain: 0.85, decay: 0.42 });
    noise(c, out, t + 0.045, { seconds: 0.05, type: 'bandpass', from: 2600, to: 1800, gain: 0.22, decay: 0.035 }); // затвор
  },
  synthPistol(c, out, t) {
    const jitter = 1 + (Math.random() - 0.5) * 0.08;
    noise(c, out, t, { seconds: 0.2, type: 'highpass', from: 2500 * jitter, to: 900, gain: 1, decay: 0.07 });
    noise(c, out, t, { seconds: 0.4, type: 'lowpass', from: 4200 * jitter, to: 380, gain: 0.85, decay: 0.3 });
    noise(c, out, t, { seconds: 0.3, type: 'bandpass', from: 1200, to: 500, gain: 0.5, decay: 0.16 });
    tone(c, out, t, { from: 170 * jitter, to: 38, gain: 1, decay: 0.24 });
    tone(c, out, t + 0.004, { type: 'triangle', from: 90, to: 32, gain: 0.7, decay: 0.3 });
  },
  // Гильза звякнула о землю: тихий высокий «тинь» с коротким щелчком.
  tink(c, out, t) {
    const base = 3800 + Math.random() * 1400;
    tone(c, out, t, { from: base, gain: 0.3, decay: 0.12 });
    tone(c, out, t, { from: base * 1.62, gain: 0.15, decay: 0.07 });
    noise(c, out, t, { seconds: 0.02, type: 'highpass', from: 6000, to: 4000, gain: 0.2, decay: 0.01 });
  },
  // Попадание в металл: звонкий «тинь» из нескольких негармоничных обертонов и сухой щелчок.
  hit(c, out, t) {
    const base = 1050 + Math.random() * 260;
    const partials = [
      [1, 0.34, 0.55],
      [1.58, 0.28, 0.4],
      [2.41, 0.2, 0.3],
      [3.27, 0.13, 0.2],
      [4.6, 0.07, 0.12],
    ];
    for (const [ratio, gain, decay] of partials) {
      tone(c, out, t, { from: base * ratio * (1 + (Math.random() - 0.5) * 0.01), gain, decay });
    }
    noise(c, out, t, { seconds: 0.05, type: 'highpass', from: 5200, to: 3200, gain: 0.55, decay: 0.018 });
    tone(c, out, t, { from: 380, to: 210, gain: 0.3, decay: 0.07 }); // удар по пластине
  },
  // Бьётся глиняная тарелка: сухой хруст, звонкий треск сверху, глухой «тук» и россыпь щелчков осколков.
  shatter(c, out, t) {
    noise(c, out, t, { seconds: 0.12, type: 'bandpass', from: 3200, to: 1400, gain: 0.95, decay: 0.08 });
    noise(c, out, t, { seconds: 0.25, type: 'highpass', from: 7000, to: 3200, gain: 0.45, decay: 0.16 });
    tone(c, out, t, { from: 460, to: 160, gain: 0.4, decay: 0.05 });
    for (let i = 0; i < 9; i += 1) {
      const at = t + 0.004 + Math.random() * 0.12;
      tone(c, out, at, { type: 'triangle', from: 2400 + Math.random() * 4200, gain: 0.04 + Math.random() * 0.08, decay: 0.015 + Math.random() * 0.03 });
      noise(c, out, at, { seconds: 0.02, type: 'highpass', from: 5500, to: 3800, gain: 0.12 + Math.random() * 0.2, decay: 0.01 });
    }
  },
  // Электрический разряд (робопёс): щелчок, треск пачками шума и рваное жужжание двух «пил».
  zap(c, out, t) {
    noise(c, out, t, { seconds: 0.05, type: 'highpass', from: 6000, to: 3000, gain: 0.7, decay: 0.025 });
    const bursts = 6 + Math.floor(Math.random() * 5);
    for (let i = 0; i < bursts; i += 1) {
      const at = t + Math.random() * 0.22;
      const f = 1800 + Math.random() * 5500;
      noise(c, out, at, { seconds: 0.05, type: 'bandpass', from: f, to: f * 0.6, gain: 0.35 + Math.random() * 0.55, decay: 0.008 + Math.random() * 0.03 });
    }
    const length = 0.12 + Math.random() * 0.2;
    const base = 70 + Math.random() * 180;
    const hum = c.createGain();
    hum.gain.setValueAtTime(0.0001, t);
    hum.gain.exponentialRampToValueAtTime(0.24, t + 0.005);
    hum.gain.exponentialRampToValueAtTime(0.0001, t + length);
    const chop = c.createGain();
    chop.gain.value = 0.5;
    const lfo = c.createOscillator();
    lfo.type = 'square';
    lfo.frequency.value = 30 + Math.random() * 40;
    const depth = c.createGain();
    depth.gain.value = 0.5;
    lfo.connect(depth).connect(chop.gain);
    const hp = c.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 400;
    for (const detune of [1, 1.013 + Math.random() * 0.02]) {
      const osc = c.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(base * detune * (2 + Math.random()), t);
      osc.frequency.exponentialRampToValueAtTime(base * detune, t + length);
      osc.connect(hp);
      osc.start(t);
      osc.stop(t + length + 0.02);
    }
    hp.connect(chop).connect(hum).connect(out);
    lfo.start(t);
    lfo.stop(t + length + 0.02);
  },
  // Робот отключается (смерть робопса): гудение съезжает вниз, фильтр закрывается, искрит
  powerDown(c, out, t) {
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(3200, t);
    lp.frequency.exponentialRampToValueAtTime(140, t + 1.1);
    const envelope = c.createGain();
    envelope.gain.setValueAtTime(0.0001, t);
    envelope.gain.exponentialRampToValueAtTime(0.32, t + 0.02);
    envelope.gain.setValueAtTime(0.32, t + 0.45);
    envelope.gain.exponentialRampToValueAtTime(0.0001, t + 1.2);
    for (const [type, from, to] of [['sawtooth', 430, 36], ['square', 217, 19]]) {
      const osc = c.createOscillator();
      osc.type = type;
      osc.frequency.setValueAtTime(from, t);
      osc.frequency.exponentialRampToValueAtTime(to, t + 1.15);
      osc.connect(lp);
      osc.start(t);
      osc.stop(t + 1.25);
    }
    lp.connect(envelope).connect(out);
    tone(c, out, t, { from: 160, to: 40, gain: 0.5, decay: 0.2 }); // глухой удар
    for (let i = 0; i < 9; i += 1) {
      const at = t + Math.random() * 0.9;
      const f = 2000 + Math.random() * 5000;
      noise(c, out, at, { seconds: 0.05, type: 'bandpass', from: f, to: f * 0.6, gain: 0.2 + Math.random() * 0.4, decay: 0.01 + Math.random() * 0.03 });
    }
  },
  // AWP: низкий «бум» под записью калаша (удар в грудь и раскат)
  awpBoom(c, out, t) {
    const jitter = 1 + (Math.random() - 0.5) * 0.06;
    tone(c, out, t, { from: 78 * jitter, to: 30, gain: 1, decay: 0.55 });
    tone(c, out, t + 0.004, { type: 'triangle', from: 46 * jitter, to: 22, gain: 0.85, decay: 0.7 });
    noise(c, out, t, { seconds: 0.9, type: 'lowpass', from: 1100 * jitter, to: 90, gain: 0.9, decay: 0.75 });
    noise(c, out, t, { seconds: 0.08, type: 'bandpass', from: 1500, to: 600, gain: 0.5, decay: 0.05 });
  },
  // Мана-выстрел — не удар, а «вумм-шинг»: мягкий (атака ~8 мс) расстроенный пилообразный тон
  // взлетает 300→1200 Гц за ~0,1 с через мягкий фильтр, на вершине звенят хрустальные колокольца
  // (негармоничные 1 : 2,76 : 5,4 : 8,9, ~0,5 с), под ними — хоровое мерцание (расстроенные синусы с
  // медленным вибрато) и воздушный «вжух» шума вверх. Ни шумового хлопка, ни низкого удара.
  manaShot(c, out, t) {
    const j = 1 + (Math.random() - 0.5) * 0.06;
    // взлёт: две расстроенные пилы + синус октавой выше, через lowpass
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 2;
    lp.frequency.setValueAtTime(1400, t);
    lp.frequency.exponentialRampToValueAtTime(4200, t + 0.11);
    lp.frequency.exponentialRampToValueAtTime(1800, t + 0.3);
    lp.connect(envGain(c, out, t, 0.008, 0.2, 0.3));
    for (const [type, mul, level] of [['sawtooth', 1, 0.5], ['sawtooth', 1.012, 0.5], ['sine', 2, 0.6]]) {
      const osc = c.createOscillator();
      osc.type = type;
      osc.frequency.setValueAtTime(300 * j * mul, t);
      osc.frequency.exponentialRampToValueAtTime(1200 * j * mul, t + 0.1);
      const g = c.createGain();
      g.gain.value = level;
      osc.connect(g).connect(lp);
      osc.start(t);
      osc.stop(t + 0.34);
    }
    // хрустальные колокольца на вершине взлёта
    const bellBase = 1200 * j;
    [[1, 0.16, 0.6], [2.76, 0.09, 0.45], [5.4, 0.05, 0.3], [8.9, 0.03, 0.2]].forEach(([ratio, gain, decay]) =>
      bell(c, out, t + 0.085, bellBase * ratio, gain, decay, 0.005),
    );
    // хоровое мерцание: 4 расстроенных синуса с вибрато 5–6 Гц
    const chorus = envGain(c, out, t + 0.05, 0.04, 0.05, 0.6);
    const vib = c.createOscillator();
    vib.frequency.value = 5 + Math.random();
    const vibDepth = c.createGain();
    vibDepth.gain.value = 9;
    vib.connect(vibDepth);
    for (const d of [0.993, 0.997, 1.003, 1.007]) {
      const osc = c.createOscillator();
      osc.frequency.value = 2400 * j * d;
      vibDepth.connect(osc.frequency);
      osc.connect(chorus);
      osc.start(t + 0.05);
      osc.stop(t + 0.75);
    }
    vib.start(t + 0.05);
    vib.stop(t + 0.75);
    // воздушный «вжух»: полоса шума вверх
    const src = c.createBufferSource();
    src.buffer = noiseBuffer(c, 0.4);
    const bp = c.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 1.2;
    bp.frequency.setValueAtTime(800, t);
    bp.frequency.exponentialRampToValueAtTime(4000, t + 0.2);
    src.connect(bp).connect(envGain(c, out, t, 0.01, 0.12, 0.25));
    src.start(t);
    src.stop(t + 0.4);
  },
  // Мана попала: мягкий «чпок» и каскад искристых колокольчиков вниз (не металл)
  manaHit(c, out, t) {
    const j = 1 + (Math.random() - 0.5) * 0.06;
    const pop = c.createOscillator();
    pop.frequency.setValueAtTime(900 * j, t);
    pop.frequency.exponentialRampToValueAtTime(300 * j, t + 0.045);
    pop.connect(envGain(c, out, t, 0.003, 0.3, 0.06));
    pop.start(t);
    pop.stop(t + 0.1);
    const puff = c.createBufferSource();
    puff.buffer = noiseBuffer(c, 0.1);
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 1800;
    puff.connect(lp).connect(envGain(c, out, t, 0.004, 0.1, 0.06));
    puff.start(t);
    puff.stop(t + 0.1);
    const base = 2600 * j;
    [1.5, 1.26, 1, 0.84, 0.75].forEach((ratio, i) => {
      const at = t + 0.02 + i * 0.04;
      bell(c, out, at, base * ratio, 0.1 * (1 - i * 0.12), 0.35, 0.004);
      bell(c, out, at, base * ratio * 2.76, 0.03, 0.18, 0.004);
    });
    for (let i = 0; i < 4; i += 1) bell(c, out, t + 0.03 + Math.random() * 0.2, 6000 + Math.random() * 3000, 0.02, 0.05, 0.002);
  },
  // Затвор открывают: щелчок рукоятки вверх, шорох хода назад, лязг в заднем положении (через ~0,38 с)
  boltOpen(c, out, t) {
    noise(c, out, t, { seconds: 0.03, type: 'highpass', from: 5200, to: 3500, gain: 0.5, decay: 0.012 });
    tone(c, out, t, { type: 'triangle', from: 2900 + Math.random() * 300, gain: 0.18, decay: 0.05 });
    tone(c, out, t + 0.002, { from: 1150, to: 900, gain: 0.2, decay: 0.04 });
    noise(c, out, t + 0.16, { seconds: 0.25, type: 'bandpass', from: 2400, to: 1300, gain: 0.16, decay: 0.2 }); // скольжение
    const back = t + 0.37;
    noise(c, out, back, { seconds: 0.05, type: 'bandpass', from: 3000, to: 1800, gain: 0.55, decay: 0.03 });
    tone(c, out, back, { type: 'triangle', from: 2300 + Math.random() * 200, gain: 0.16, decay: 0.07 });
    tone(c, out, back, { from: 700, to: 480, gain: 0.25, decay: 0.05 });
  },
  // Затвор закрывают: удар вперёд (патрон в патроннике) и щелчок рукоятки вниз через 0,15 с
  boltClose(c, out, t) {
    noise(c, out, t, { seconds: 0.06, type: 'bandpass', from: 1700, to: 900, gain: 0.7, decay: 0.045 });
    tone(c, out, t, { from: 820, to: 520, gain: 0.32, decay: 0.06 });
    tone(c, out, t, { type: 'triangle', from: 3100 + Math.random() * 300, gain: 0.12, decay: 0.08 });
    noise(c, out, t + 0.15, { seconds: 0.03, type: 'highpass', from: 4500, to: 3000, gain: 0.45, decay: 0.012 });
    tone(c, out, t + 0.15, { type: 'triangle', from: 2500 + Math.random() * 200, gain: 0.15, decay: 0.04 });
  },
};
// что запекается: [рецепт, вариантов, длина в секундах]
const BAKES = {
  tink: ['tink', 6, 0.15],
  hit: ['hit', 5, 0.6],
  shatter: ['shatter', 4, 0.3],
  zap: ['zap', 6, 0.4],
  powerDown: ['powerDown', 2, 1.3],
  synthPistol: ['synthPistol', 3, 0.45],
  synthAk: ['synthAk', 3, 0.65],
  awpBoom: ['awpBoom', 2, 1.0],
  boltOpen: ['boltOpen', 2, 0.5],
  boltClose: ['boltClose', 2, 0.25],
  manaShot: ['manaShot', 5, 0.8],
  manaHit: ['manaHit', 4, 0.6],
};

const bake = (sampleRate, seconds, draw) => {
  const oc = new OfflineAudioContext(1, Math.ceil(seconds * sampleRate), sampleRate);
  draw(oc, oc.destination, 0);
  return oc.startRendering();
};

// мягкий клип: до 0,7 — линейно, выше плавно (tanh) подходит к 1; вход шейпера — сигнал / DRIVE
const softClipCurve = () => {
  const curve = new Float32Array(2049);
  for (let i = 0; i < curve.length; i += 1) {
    const s = ((i / (curve.length - 1)) * 2 - 1) * DRIVE;
    const a = Math.abs(s);
    curve[i] = a <= 0.7 ? s : Math.sign(s) * (0.7 + 0.3 * Math.tanh((a - 0.7) / 0.3));
  }
  return curve;
};

const disconnect = (...nodes) => {
  for (const n of nodes) {
    try {
      n?.disconnect();
    } catch {
      // уже отключён
    }
  }
};

export function createSound() {
  const shared = (globalThis.__sceneState ??= {});
  let weapon = 'pistol'; // каким оружием звучит shot() без параметров (см. setWeapon)
  const counters = (shared.soundCounters ??= { played: 0, stolen: 0, skipped: 0, resumes: 0, nanResets: 0, busBuilds: 0, errors: 0 });
  const graph = () => shared.audioGraph;

  // ---------- контекст и выход ----------
  // master (громкость, к нему же подключён мотор машины — engine-sound.js) → компрессор-лимитер →
  // подстройка → мягкий клип → динамики. Реверб: reverbSend → свёртка → master. Задержка ближнего
  // поля (30 мс, эхо своего выстрела не слипается с ним) — одна общая.
  const buildBus = (g) => {
    const c = g.context;
    disconnect(g.master, g.reverbSend, ...(g.busNodes ?? []));
    const compressor = c.createDynamicsCompressor();
    // замерено офлайн (с мягким клипом): до 0,5 — без изменений, 1 → 0,90, 2 → 0,97, 8 → 0,99 — не
    // глохнет. Порог −2 дБ и отпускание 0,2 с: в шлеме на очереди (−3 дБ, 0,1 с) давил > 3 дБ половину
    // времени и «качал» хвосты; теперь одиночный выстрел почти не сжимается, пики ловит клип.
    compressor.threshold.value = -2;
    compressor.knee.value = 6;
    compressor.ratio.value = 10;
    compressor.attack.value = 0.003;
    compressor.release.value = 0.2;
    const trim = c.createGain();
    trim.gain.value = 0.962 / DRIVE; // снимает автоподъём компрессора Chromium (×1,04)
    const clip = c.createWaveShaper();
    clip.curve = softClipCurve();
    clip.oversample = 'none';
    const probe = c.createAnalyser(); // сторож: NaN после компрессора → пересобрать выход
    probe.fftSize = 256;
    g.master.connect(compressor).connect(trim).connect(clip).connect(c.destination);
    compressor.connect(probe);
    const convolver = c.createConvolver();
    const length = Math.floor(c.sampleRate * 1.5);
    const impulse = c.createBuffer(2, length, c.sampleRate);
    for (let channel = 0; channel < 2; channel += 1) {
      const data = impulse.getChannelData(channel);
      for (let i = 0; i < length; i += 1) data[i] = (Math.random() * 2 - 1) * (1 - i / length) ** 3.2;
    }
    convolver.buffer = impulse;
    g.reverbSend.gain.value = 0.5;
    g.reverbSend.connect(convolver).connect(g.master);
    const nearDelay = c.createDelay(0.1);
    nearDelay.delayTime.value = 0.03;
    nearDelay.connect(g.reverbSend);
    Object.assign(g, { busVersion: BUS_VERSION, busNodes: [compressor, trim, clip, probe, convolver, nearDelay], probe, nearDelay });
    counters.busBuilds += 1;
  };

  // Голос — постоянная цепочка. Ближний (gun): input → prox (низкая полка) → стерео → sg → master
  // и prox → hg → паннер → master; посылы в реверб: sendNear (через задержку) и sendFar.
  // Обычный: input → паннер → master, sendFar → реверб.
  const makeVoice = (g, { near, model }) => {
    const c = g.context;
    const input = c.createGain();
    const panner = c.createPanner();
    panner.panningModel = model;
    panner.distanceModel = 'inverse';
    panner.refDistance = 1.5;
    panner.rolloffFactor = 0.5; // на 38 м ≈ -22 дБ
    panner.maxDistance = 200;
    panner.coneInnerAngle = 360;
    const sendFar = c.createGain();
    sendFar.connect(g.reverbSend);
    const v = { near, input, panner, sendFar, shot: null, nodes: [input, panner, sendFar] };
    if (near) {
      const prox = c.createBiquadFilter();
      prox.type = 'lowshelf';
      prox.frequency.value = 250;
      prox.gain.value = 0;
      const stereo = c.createStereoPanner();
      const sg = c.createGain();
      const hg = c.createGain();
      const sendNear = c.createGain();
      input.connect(prox);
      prox.connect(stereo).connect(sg).connect(g.master);
      prox.connect(hg).connect(panner).connect(g.master);
      sendNear.connect(g.nearDelay);
      Object.assign(v, { prox, stereo, sg, hg, sendNear });
      v.nodes.push(prox, stereo, sg, hg, sendNear);
    } else {
      input.connect(panner).connect(g.master);
    }
    return v;
  };

  const buildPools = (g) => {
    for (const pool of Object.values(g.pools ?? {})) for (const v of pool.voices) disconnect(...v.nodes);
    g.pools = {};
    for (const [name, cfg] of Object.entries(POOLS)) {
      g.pools[name] = { name, max: cfg.max, minAge: cfg.minAge, voices: Array.from({ length: cfg.size }, () => makeVoice(g, cfg)) };
    }
    g.poolVersion = POOL_VERSION;
  };

  const ensure = () => {
    let g = graph();
    if (g?.context && g.context.state === 'closed') g = shared.audioGraph = null;
    if (!g?.context) {
      const context = new AudioContext();
      const master = context.createGain();
      master.gain.value = 0.85;
      const reverbSend = context.createGain();
      g = shared.audioGraph = { context, master, reverbSend };
    }
    if (g.busVersion !== BUS_VERSION) buildBus(g);
    if (g.poolVersion !== POOL_VERSION) buildPools(g);
    const c = g.context;
    if (c.state !== 'running' && c.state !== 'closed') {
      c.resume().catch(() => {});
    }
    loadBank(c);
    return g;
  };

  // ---------- банк звуков: записи + запечённый синтез, один раз, живёт в __sceneState.soundBank ----------
  // AWP одним буфером: запись калаша ниже (×0,66–0,70), под ней другая запись ещё ниже (×0,48) и
  // низкий «бум» — смешаны заранее, чтобы выстрел занимал один голос, а не три
  const bakeAwp = (c, bank) => {
    if (bank.awpFor === BAKE_VERSION || bank.awpBusy || bank.fxReady !== BAKE_VERSION) return;
    const ak = bank.ak;
    const booms = bank.fx.awpBoom;
    if (ak.length < GUN_FILES.ak.length || !booms?.length) return;
    bank.awpBusy = true;
    (async () => {
      const list = [];
      for (let i = 0; i < 3; i += 1) {
        const main = ak[i % ak.length];
        const low = ak[(i + 1) % ak.length];
        const boom = booms[i % booms.length];
        const rate = 0.66 + Math.random() * 0.04;
        const seconds = Math.max(main.duration / rate, low.duration / 0.48, boom.duration) + 0.05;
        list.push(await bake(c.sampleRate, seconds, (oc, out, t) => {
          for (const [buffer, r, gain] of [[boom, 1, 0.95], [low, 0.48, 0.7], [main, rate, 1.3]]) {
            const source = oc.createBufferSource();
            source.buffer = buffer;
            source.playbackRate.value = r;
            const g = oc.createGain();
            g.gain.value = gain;
            source.connect(g).connect(out);
            source.start(t);
          }
        }));
      }
      bank.awp = list;
      bank.awpFor = BAKE_VERSION;
    })()
      .catch((e) => console.warn('[sound] AWP не запёкся', e?.message ?? e))
      .finally(() => { bank.awpBusy = false; });
  };
  const gunKey = JSON.stringify(GUN_FILES);
  const loadBank = (c) => {
    let bank = shared.soundBank;
    // записи (их ключ) и запечённый синтез (BAKE_VERSION) обновляются отдельно: смена рецептов не
    // перезагружает записи, и выстрелы не уходят на запасной синтез
    const sameFiles = bank && bank.rate === c.sampleRate && (bank.gunKey ?? bank.files?.split('|')[0]) === gunKey;
    if (!sameFiles) bank = loadFiles(c);
    if (bank.bakeVersion !== BAKE_VERSION) {
      bank.bakeVersion = BAKE_VERSION;
      (async () => {
        for (const [name, [recipe, count, seconds]] of Object.entries(BAKES)) {
          const list = [];
          for (let i = 0; i < count; i += 1) {
            try {
              list.push(await bake(c.sampleRate, seconds, RECIPES[recipe]));
            } catch (e) {
              console.warn('[sound] не запёкся', name, e?.message ?? e);
              break;
            }
          }
          bank.fx[name] = list; // целиком: пока пекётся, звучит прежний вариант
        }
        bank.fxReady = BAKE_VERSION;
        bakeAwp(c, bank);
      })();
    }
  };
  const loadFiles = (c) => {
    delete shared.gunSamples; // старый кэш (до SOUND_VERSION 20)
    const bank = (shared.soundBank = { gunKey, rate: c.sampleRate, pistol: [], ak: [], awp: [], fx: {} });
    for (const [kind, names] of Object.entries(GUN_FILES)) {
      for (const name of names) {
        fetch(`/sounds/guns/${name}.ogg`)
          .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(r.status))))
          .then((data) => c.decodeAudioData(data))
          .then((raw) => {
            if (kind !== 'pistol') return raw;
            // пистолет: чуть хруста сверху (highshelf +3 дБ) и треск со звоном — запекаются в запись
            return bake(c.sampleRate, raw.duration + 0.05, (oc, out, t) => {
              const source = oc.createBufferSource();
              source.buffer = raw;
              const bright = oc.createBiquadFilter();
              bright.type = 'highshelf';
              bright.frequency.value = 2500;
              bright.gain.value = 3;
              source.connect(bright).connect(out);
              source.start(t);
              RECIPES.pistolCrack(oc, out, t);
            }).catch(() => raw);
          })
          .then((buffer) => {
            bank[kind].push(buffer);
            bakeAwp(c, bank);
          })
          .catch((e) => console.warn('[sound] не загрузился', name, e?.message ?? e));
      }
    }
    return bank;
  };
  const pick = (list) => (list?.length ? list[Math.floor(Math.random() * list.length)] : null);

  // ---------- голоса ----------
  // поза головы (из update): позиция и вектор «вправо» — для ближнего поля
  const head = { x: 0, y: 0, z: 0, rx: 1, ry: 0, rz: 0, ok: false };

  const release = (v, shot) => {
    disconnect(shot.source, shot.env);
    if (v.shot === shot) v.shot = null;
  };
  const steal = (v, t) => {
    const shot = v.shot;
    if (!shot || shot.fading) return;
    shot.fading = true;
    counters.stolen += 1;
    try {
      const gain = shot.env.gain;
      gain.cancelScheduledValues(t);
      gain.setValueAtTime(finite(gain.value), t);
      gain.linearRampToValueAtTime(0, t + STEAL_FADE);
      shot.source.stop(t + STEAL_FADE + 0.005);
    } catch {
      release(v, shot);
    }
  };
  // Свободный голос пула. Звучит max и больше — старейший звук, если он старше minAge (уже в тихом
  // хвосте), мягко гаснет (60 мс); новый звук всегда берёт другой, свободный голос (паннер гаснущего не
  // прыгает). Молодые звуки не трогаются: тогда звучит сверх max, пока есть свободные цепочки.
  // Свободных нет совсем — отнимается старейший (кроме самого нового), а этот звук пропускается.
  const acquire = (pool, t) => {
    let active = 0;
    let oldest = null;
    let newest = null;
    let free = null;
    for (const v of pool.voices) {
      const shot = v.shot;
      if (shot && t > shot.endAt + 0.5) release(v, shot); // onended потерялся
      if (!v.shot) {
        free ??= v;
      } else if (!v.shot.fading) {
        active += 1;
        if (!oldest || v.shot.startedAt < oldest.shot.startedAt) oldest = v;
        if (!newest || v.shot.startedAt > newest.shot.startedAt) newest = v;
      }
    }
    if (oldest && oldest !== newest && (active >= pool.max || !free) && (t - oldest.shot.startedAt >= pool.minAge || !free)) {
      steal(oldest, t);
    }
    if (free) return free;
    // Свободных цепочек нет: все пулы sound.js — звуки игрока, их не пропускаем. Новый звук делит
    // цепочку со старейшим (тот гаснет своей огибающей за 60 мс; паннер прыгнет только у его хвоста).
    let first = null;
    for (const v of pool.voices) if (v.shot && (!first || v.shot.startedAt < first.shot.startedAt)) first = v;
    if (first && !first.shot.fading) steal(first, t);
    if (first) counters.shared = (counters.shared ?? 0) + 1;
    return first;
  };

  const setPos = (panner, x, y, z) => {
    if (panner.positionX) {
      panner.positionX.value = x;
      panner.positionY.value = y;
      panner.positionZ.value = z;
    } else panner.setPosition(x, y, z);
  };

  // Настроить голос под точку звука: ближнее поле (свой выстрел у руки), дальнее (HRTF) или у слушателя.
  // Ближнее: HRTF браузера снят для дальнего поля и «уносит» источник на метр, поэтому вблизи основной
  // путь — equal-power стерео с сильной ILD, плавно переходящий в HRTF с расстоянием; низкая полка —
  // эффект близости; реверб тише и с задержкой (сухой сигнал — главный признак близости).
  const configure = (v, position, refDistance, wet) => {
    const p = validPos(position);
    if (p) setPos(v.panner, p.x, p.y, p.z);
    else if (head.ok) setPos(v.panner, head.x, head.y, head.z);
    v.panner.refDistance = refDistance;
    if (!v.near) {
      v.sendFar.gain.value = wet;
      return;
    }
    let mode = p ? 'far' : 'head';
    let w = 1;
    let pan = 0;
    if (p && head.ok) {
      const dx = p.x - head.x;
      const dy = p.y - head.y;
      const dz = p.z - head.z;
      const d = Math.hypot(dx, dy, dz);
      if (d < NEAR_FAR) {
        mode = 'near';
        const side = (dx * head.rx + dy * head.ry + dz * head.rz) / Math.max(d, 0.05);
        const k = Math.min(1, Math.max(0, (d - NEAR_FULL) / (NEAR_FAR - NEAR_FULL)));
        w = k * k * (3 - 2 * k); // smoothstep
        // не до упора: у выстрела у левого уха правое ухо всё равно слышит его громко (~-8 дБ)
        pan = Math.max(-0.5, Math.min(0.5, finite(side) * 0.8));
      }
    }
    const isNear = mode === 'near';
    v.input.gain.value = isNear ? 1.15 : 1; // свой выстрел остаётся самым громким
    v.prox.gain.value = isNear ? 4 * (1 - w) : 0;
    v.stereo.pan.value = pan;
    v.sg.gain.value = isNear ? Math.cos((w * Math.PI) / 2) : mode === 'head' ? 1 : 0;
    v.hg.gain.value = isNear ? Math.sin((w * Math.PI) / 2) : mode === 'head' ? 0 : 1;
    v.sendNear.gain.value = isNear ? wet * (0.3 + 0.7 * w) : 0;
    v.sendFar.gain.value = isNear ? 0 : wet;
  };

  // Проиграть буфер голосом пула: создаются только источник и его гейн, в onended отключаются.
  const play = (poolName, buffer, { position, gain = 1, rate = 1, refDistance = 1.5, wet = 0.25 } = {}) => {
    if (!buffer) return false;
    const g = ensure();
    const c = g.context;
    const t = c.currentTime;
    const v = acquire(g.pools[poolName], t);
    if (!v) {
      counters.skipped += 1;
      return false;
    }
    configure(v, position, finite(refDistance, 1.5), finite(wet, 0.25));
    const source = c.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = finite(rate, 1);
    const env = c.createGain();
    env.gain.value = finite(gain, 0);
    source.connect(env);
    env.connect(v.input);
    env.connect(v.sendFar);
    if (v.sendNear) env.connect(v.sendNear);
    const shot = { source, env, startedAt: t, endAt: t + buffer.duration / finite(rate, 1), fading: false };
    v.shot = shot;
    source.onended = () => release(v, shot);
    source.start(t);
    counters.played += 1;
    return true;
  };
  const safe = (fn) => {
    try {
      return fn();
    } catch (e) {
      counters.errors += 1;
      counters.lastError = String(e?.message ?? e);
      return false;
    }
  };

  // Предзагрузка сразу, при создании звука: иначе первый выстрел звучал запасным синтезом. AudioContext
  // без жеста пользователя создаётся приостановленным — декодировать это не мешает; запустится на выстреле.
  try {
    ensure();
  } catch (e) {
    console.warn('[sound] предзагрузка не удалась', e?.message ?? e);
  }

  // Прослушка записи для звуковой доски: сырой файл без обработки, у слушателя, через master.
  // Одна за раз. Промис: длительность по окончании, null — перебили.
  let preview = null;
  let previewToken = null;
  const previewFile = (name) => {
    const g = ensure();
    const c = g.context;
    try {
      preview?.stop();
    } catch {
      // уже закончилась
    }
    preview = null;
    const cache = (shared.previewBuffers ??= new Map());
    let loading = cache.get(name);
    if (!loading) {
      loading = fetch(`/sounds/guns/${name}.ogg`)
        .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then((data) => c.decodeAudioData(data));
      cache.set(name, loading);
      loading.catch(() => cache.delete(name));
    }
    const token = {};
    previewToken = token;
    return loading.then((buffer) => {
      if (previewToken !== token) return null;
      const source = c.createBufferSource();
      source.buffer = buffer;
      source.connect(g.master);
      preview = source;
      return new Promise((resolve) => {
        source.onended = () => {
          disconnect(source);
          if (preview === source) preview = null;
          resolve(previewToken === token ? buffer.duration : null);
        };
        source.start();
      });
    });
  };

  // Сторож (из update, раз в 0,5 с): контекст приостановлен/прерван — resume; в выходе NaN (он навсегда
  // глушит компрессор) — пересобрать выход и голоса.
  let nextWatch = 0;
  let probeData = null;
  const watch = (g) => {
    const now = performance.now();
    if (now < nextWatch) return;
    nextWatch = now + 500;
    const c = g.context;
    if (c.state === 'suspended' || c.state === 'interrupted') {
      counters.resumes += 1;
      c.resume().catch(() => {});
      return;
    }
    if (!g.probe) return;
    probeData ??= new Float32Array(g.probe.fftSize);
    g.probe.getFloatTimeDomainData(probeData);
    for (let i = 0; i < probeData.length; i += 1) {
      if (!Number.isFinite(probeData[i])) {
        counters.nanResets += 1;
        console.warn('[sound] NaN в выходе — пересобираю выход и голоса');
        buildBus(g);
        buildPools(g);
        return;
      }
    }
  };

  const api = {
    version: SOUND_VERSION,
    previewFile,
    // Отладка: sound.stats() → голоса по пулам, счётчики, состояние контекста
    stats() {
      const g = graph();
      const pools = {};
      let liveNodes = 0;
      for (const [name, pool] of Object.entries(g?.pools ?? {})) {
        let active = 0;
        let fading = 0;
        for (const v of pool.voices) {
          liveNodes += v.nodes.length;
          if (v.shot) {
            liveNodes += 2;
            if (v.shot.fading) fading += 1;
            else active += 1;
          }
        }
        pools[name] = { size: pool.voices.length, max: pool.max, active, fading };
      }
      const bank = shared.soundBank;
      return {
        contextState: g?.context?.state ?? 'none',
        pools,
        voices: Object.values(pools).reduce((s, p) => s + p.active + p.fading, 0),
        liveNodes,
        bank: bank && { pistol: bank.pistol.length, ak: bank.ak.length, awp: bank.awp?.length ?? 0, fx: Object.fromEntries(Object.entries(bank.fx).map(([k, l]) => [k, l.length])) },
        ...counters,
        budget: shared.audioBudget?.stats?.(), // звуки мира (audio-budget.js)
      };
    },
    // Слушатель = голова: вызывать каждый кадр. Позиция и ориентация — AudioParam, сглаживание 20 мс.
    update(camera) {
      const g = graph();
      if (!g?.context || !camera) return;
      try {
        watch(g);
        camera.updateWorldMatrix(true, false);
        const e = camera.matrixWorld.elements; // колонки: 0 — вправо, 1 — вверх, 2 — назад (без масштаба)
        for (let i = 0; i < 15; i += 1) if (!Number.isFinite(e[i])) return; // NaN в слушателе заглушил бы всё
        const norm = (x, y, z) => { const n = Math.hypot(x, y, z) || 1; return [x / n, y / n, z / n]; };
        const lp = [e[12], e[13], e[14]];
        const lf = norm(-e[8], -e[9], -e[10]);
        const lu = norm(e[4], e[5], e[6]);
        head.x = lp[0]; head.y = lp[1]; head.z = lp[2];
        head.rx = e[0]; head.ry = e[1]; head.rz = e[2];
        head.ok = true;
        audioBudget(shared).setHead(lp[0], lp[1], lp[2]); // для слышимости звуков мира (audio-budget.js)
        const l = g.context.listener;
        const t = g.context.currentTime;
        if (l.positionX) {
          l.positionX.setTargetAtTime(lp[0], t, 0.02);
          l.positionY.setTargetAtTime(lp[1], t, 0.02);
          l.positionZ.setTargetAtTime(lp[2], t, 0.02);
          l.forwardX.setTargetAtTime(lf[0], t, 0.02);
          l.forwardY.setTargetAtTime(lf[1], t, 0.02);
          l.forwardZ.setTargetAtTime(lf[2], t, 0.02);
          l.upX.setTargetAtTime(lu[0], t, 0.02);
          l.upY.setTargetAtTime(lu[1], t, 0.02);
          l.upZ.setTargetAtTime(lu[2], t, 0.02);
        } else {
          l.setPosition(lp[0], lp[1], lp[2]);
          l.setOrientation(lf[0], lf[1], lf[2], lu[0], lu[1], lu[2]);
        }
      } catch {
        // слушатель не обновился — звук просто останется на прошлой позе
      }
    },
    // Каким оружием звучит следующий shot() без параметров: 'pistol' | 'ak'. shooting.js зовёт
    // shot() без параметров, поэтому main.js ставит оружие перед выстрелом.
    setWeapon(kind) {
      weapon = kind === 'ak' || kind === 'awp' || kind === 'mana' ? kind : 'pistol';
    },
    // затвор АВП (awp-model.js cycleBolt): phase 'open' — вверх и назад, 'close' — вперёд и вниз,
    // 'cycle' — самозарядка: короткий «клац-щёлк» (запись закрытия, ускоренная в 1,6 раза)
    bolt(position, phase = 'open') {
      const cycle = phase === 'cycle';
      return safe(() => play('mech', pick(shared.soundBank?.fx[phase === 'close' || cycle ? 'boltClose' : 'boltOpen']), { position, gain: cycle ? 0.45 : 0.6, rate: cycle ? 1.6 : 1, refDistance: 1.0, wet: 0.12 }));
    },
    // Выстрел: случайная запись (±3 % высоты, ±12 % громкости); пока записи не загрузились —
    // запечённый синтез. { kind: 'ak' } — автомат; без параметров — оружие из setWeapon.
    shot(opts) {
      const ok = api.shotRaw(opts);
      if (ok) safe(() => audioBudget(shared).duck()); // свой выстрел: шина мира коротко тише (audio-budget.js)
      return ok;
    },
    shotRaw({ kind = weapon, position } = {}) {
      return safe(() => {
        ensure();
        // Ускоренное время (×4…×64) даёт выстрел каждый кадр: пул выстрелов забивался молодыми звуками
        // и остальные пропадали. Не чаще раза в SHOT_MIN_GAP_MS реального времени — звучит очередью.
        const nowMs = performance.now();
        if (nowMs - (shared.lastShotSoundAt ?? 0) < SHOT_MIN_GAP_MS) return false;
        shared.lastShotSoundAt = nowMs;
        // мана: запечённый «магический» выстрел, высота гуляет ±6 %; пока не запёкся — тишина, а не выстрел
        if (kind === 'mana') {
          const list = shared.soundBank?.fx.manaShot;
          counters.lastShot = list?.length ? `manaShot@${shared.soundBank.fxReady}` : 'mana:not-baked';
          if (!list?.length) return false;
          return play('gun', pick(list), { position, gain: 1.3 + Math.random() * 0.2, rate: 0.94 + Math.random() * 0.12, wet: 0.35 });
        }
        counters.lastShot = kind;
        // AWP: один голос — запечённая смесь (bakeAwp); пока она не готова — только основной слой.
        // Хвост длиннее (больше реверба)
        const awp = kind === 'awp';
        const ak = kind === 'ak' || awp;
        const bank = shared.soundBank;
        const sample = pick(ak ? bank?.ak : bank?.pistol);
        const level = 0.88 + Math.random() * 0.24;
        if (awp && bank?.awp?.length) {
          return play('gun', pick(bank.awp), { position, gain: level, rate: 0.98 + Math.random() * 0.04, wet: 0.45 });
        }
        if (sample && awp) {
          return play('gun', sample, { position, gain: 1.3 * level, rate: 0.66 + Math.random() * 0.04, wet: 0.45 });
        }
        if (sample) {
          return play('gun', sample, { position, gain: (ak ? 1 : PISTOL_GAIN) * level, rate: 1 + (Math.random() - 0.5) * 0.06, wet: ak ? 0.22 : 0.24 });
        }
        return play('gun', pick(bank?.fx[ak ? 'synthAk' : 'synthPistol']), { position, gain: level, wet: 0.5 });
      });
    },
    tink(position) {
      return safe(() => play('small', pick(shared.soundBank?.fx.tink), { position, gain: 0.25, refDistance: 1.0, wet: 0.2 }));
    },
    // звон тише выстрела на ~6 дБ и затухает с расстоянием (ref 1.5 м): мишень в 5 м ≈ -7 дБ ещё
    hit(position) {
      return safe(() => play('impact', pick(shared.soundBank?.fx.hit), { position, gain: 0.5, rate: 0.97 + Math.random() * 0.06, wet: 0.3 }));
    },
    shatter(position) {
      return safe(() => play('impact', pick(shared.soundBank?.fx.shatter), { position, gain: 0.75, rate: 0.95 + Math.random() * 0.1, wet: 0.25 }));
    },
    // strength 0..1 — громкость
    zap(position, strength = 1) {
      return safe(() => play('impact', pick(shared.soundBank?.fx.zap), { position, gain: 0.6 * Math.max(0, Math.min(1, finite(strength, 1))), wet: 0.15 }));
    },
    powerDown(position) {
      return safe(() => play('impact', pick(shared.soundBank?.fx.powerDown), { position, gain: 0.6, wet: 0.25 }));
    },
    // мана попала: «чпок» со звоном (shooting.js, projectile 'mana')
    manaHit(position) {
      return safe(() => play('impact', pick(shared.soundBank?.fx.manaHit), { position, gain: 0.55, rate: 0.95 + Math.random() * 0.1, wet: 0.3 }));
    },
  };
  return api;
}
