// Звуки робопсов: электричество и металл. Свой модуль (sound.js ведёт другой агент), но тот же
// звуковой граф: __sceneState.audioGraph = { context, master, reverbSend } (его создаёт sound.js).
//
// Как в sound.js (docs/agents/effects-and-sound.md): ничего не синтезируется на лету. Каждый
// рецепт один раз «запекается» в буферы через OfflineAudioContext (по несколько случайных
// вариантов) и живёт в __sceneState.dogSoundBank. Голоса — постоянные цепочки (усиление → HRTF-панорама
// → npcBus, и посыл в реверб), их VOICES штук, + OWN своих (→ master), в __sceneState.dogVoices. На звук создаётся только
// AudioBufferSourceNode; голосов не хватает — самый старый быстро гаснет и уступает.
//
// createDogSound(shared) → { zap(p, k), crackle(p), powerDown(p), clank(p), clankHeavy(p, k),
//   thud(p), servo(p, speed), groundThud(p, k), scrape(p, k), whoosh(p), bark(p), growl(p), howl(p), mg(p),
//   turretWind(p) } — p: мировая точка, k: 0..1 сила; у всех третий аргумент size — размер пса
//   (ниже и громче)
//
// Металл — модальный синтез (как настоящая пластина: сумма затухающих негармоничных синусов,
// верхние моды гаснут быстрее, каждая мода раздвоена на доли процента — «биения» стали). Моды
// считаются прямо в JS в буфер (modalBuf), без узлов. Шарниры: низкий мотор-редуктор (motorLayer:
// 80–220 Гц, гармоники, шум, рваная «зубчатая» амплитуда, без свипов), глухой «тук» петли, дребезг
// (rattle), шипение гидравлики (hiss, только шум). Высокие тоны и свипы звучат «птицами» — не
// добавлять (замер: спектральный центроид шагов < 1,5 кГц). Новые рецепты нормируются после запекания
// (recipe.peak), чтобы громкость задавалась только в методах ниже.
import { audioBudget, npcOut } from './audio-budget.js';

const BAKE_VERSION = 6; // 2: whoosh (лапа), mg (пулемёт); 3: bark (ярость); 5: металл, шарниры, ricochet, hiss, turretWind; 6: ниже и шумнее (было «как птицы»)
const POOL_VERSION = 3; // 2: 12 голосов; 3: + OWN своих голосов (к master), голоса мира — в npcBus
const VOICES = 12; // звуки мира (их число ограничивает audio-budget.js)
const OWN = 4; // звон от СВОЕЙ пули (own = true): только эти голоса, мир их не занимает, бюджет не спрашивают
// категория бюджета (audio-budget.js) по звуку
const CAT = { zap: 'zap', crackle: 'zap', powerDown: 'boom', clank: 'hit', clankHeavy: 'hit', ricochet: 'hit', thud: 'hit', servo: 'step', groundThud: 'step', scrape: 'step', whoosh: 'step', turretWind: 'gun', mg: 'gun', bark: 'voice', hiss: 'voice', growl: 'voice', howl: 'voice' };

// ---- рецепты (офлайн-контекст c, вывод в out); возвращают длительность, с
const rnd = (a, b) => a + Math.random() * (b - a);
const noiseBuf = (c, seconds) => {
  const b = c.createBuffer(1, Math.max(1, Math.floor(c.sampleRate * seconds)), c.sampleRate);
  const d = b.getChannelData(0);
  for (let i = 0; i < d.length; i += 1) d[i] = Math.random() * 2 - 1;
  return b;
};
const env = (c, t, gain, decay, out, attack = 0.002) => {
  const e = c.createGain();
  e.gain.setValueAtTime(0.0001, t);
  e.gain.exponentialRampToValueAtTime(gain, t + attack);
  e.gain.exponentialRampToValueAtTime(0.0001, t + decay);
  e.connect(out);
  return e;
};
const noise = (c, out, t, { seconds = 0.1, type, from, to = from, gain, decay, q = 1 }) => {
  const s = c.createBufferSource();
  s.buffer = noiseBuf(c, seconds);
  const f = c.createBiquadFilter();
  f.type = type;
  f.Q.value = q;
  f.frequency.setValueAtTime(from, t);
  f.frequency.exponentialRampToValueAtTime(to, t + decay);
  s.connect(f).connect(env(c, t, gain, decay, out));
  s.start(t);
  s.stop(t + seconds);
};
const tone = (c, out, t, { type = 'sine', from, to = from, gain, decay }) => {
  const o = c.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(from, t);
  if (to !== from) o.frequency.exponentialRampToValueAtTime(to, t + decay);
  o.connect(env(c, t, gain, decay, out));
  o.start(t);
  o.stop(t + decay + 0.02);
};
const drive = (c, out, amount = 2.5) => {
  const w = c.createWaveShaper();
  const curve = new Float32Array(1024);
  for (let i = 0; i < 1024; i += 1) {
    const x = (i / 1023) * 2 - 1;
    curve[i] = Math.tanh(x * amount) / Math.tanh(amount);
  }
  w.curve = curve;
  w.connect(out);
  return w;
};
// металлический звон: негармоничные обертоны
const ring = (c, out, t, base, partials) => {
  for (const [ratio, gain, decay] of partials) tone(c, out, t, { type: 'triangle', from: base * ratio * rnd(0.99, 1.01), gain, decay });
};

// ---- металл и шарниры: считается в JS прямо в буфер (без узлов), потом играет как слой
const normalize = (d, peak) => {
  let m = 0;
  for (let i = 0; i < d.length; i += 1) m = Math.max(m, Math.abs(d[i]));
  if (m > 0) for (let i = 0; i < d.length; i += 1) d[i] *= peak / m;
};
// мягкий хвост в конце буфера — обрезанная мода не щёлкает
const fadeTail = (d, sr, seconds = 0.04) => {
  const n = Math.min(d.length, Math.floor(sr * seconds));
  for (let i = 0; i < n; i += 1) d[d.length - 1 - i] *= i / n;
};
// моды стальной пластины (отношения частот примерно как у свободной пластины Хладни)
const PLATE = [1, 1.47, 1.82, 2.36, 2.63, 3.17, 3.55, 4.12, 4.71, 5.43];
// [частота, амплитуда, τ]: выше мода — заметно тише (r^tilt) и гаснет гораздо быстрее (r^damp) —
// иначе верхние моды долго звенят и звук «поёт», как птица; split — вторая, чуть сдвинутая
// копия моды (биения, «живой» металл)
const plateModes = (f0, count, tau0, split = 0.005, damp = 1.4, tilt = 0.9) => {
  const m = [];
  for (let i = 0; i < count; i += 1) {
    const r = PLATE[i % PLATE.length] * (1 + Math.floor(i / PLATE.length)) * rnd(0.97, 1.03);
    const a = rnd(0.5, 1) / r ** tilt;
    const tau = (tau0 * rnd(0.7, 1.3)) / r ** damp;
    m.push([f0 * r, a, tau, 0]);
    if (split) m.push([f0 * r * (1 + split * rnd(0.5, 1.5)), a * rnd(0.4, 0.8), tau, 0]);
  }
  return m;
};
// сумма затухающих синусов; glide — удар чуть задирает частоту в первые ~15 мс (жёсткий металл)
const modalBuf = (c, seconds, modes, glide = 0) => {
  const sr = c.sampleRate;
  const n = Math.max(1, Math.floor(sr * seconds));
  const b = c.createBuffer(1, n, sr);
  const d = b.getChannelData(0);
  const gk = Math.exp(-1 / (0.012 * sr));
  for (const [f, a, tau, t0 = 0] of modes) {
    if (!(f > 20 && f < sr * 0.45)) continue;
    const start = Math.floor(t0 * sr);
    const end = Math.min(n, start + Math.ceil(tau * sr * 7));
    const dk = Math.exp(-1 / (tau * sr));
    const w = (2 * Math.PI * f) / sr;
    let amp = a;
    let g = glide;
    let ph = 0;
    for (let i = start; i < end; i += 1) {
      d[i] += amp * Math.sin(ph);
      ph += w * (1 + g);
      amp *= dk;
      g *= gk;
    }
  }
  fadeTail(d, sr);
  normalize(d, 1);
  return b;
};
// дребезг механизма: несколько глухих щелчков (шум через низкочастотный фильтр) — шестерни,
// люфт в шарнире; без резонаторов, чтобы ничего не «пело»
const rattle = (c, out, t, len, count, gain) => {
  for (let i = 0; i < count; i += 1) {
    noise(c, out, t + (len * (i + rnd(0, 0.6))) / count, { seconds: 0.012, type: 'lowpass', from: rnd(900, 1600), to: 400, gain: gain * rnd(0.5, 1), decay: 0.008, q: 0.7 });
  }
};
// рикошет: короткий свист пули — тон съезжает вниз (доплер), «кувыркается» (дрожь амплитуды)
const whistleBuf = (c, seconds) => {
  const sr = c.sampleRate;
  const n = Math.max(1, Math.floor(sr * seconds));
  const b = c.createBuffer(1, n, sr);
  const d = b.getChannelData(0);
  const f0 = rnd(1600, 2400);
  const f1 = f0 * rnd(0.5, 0.65);
  const len = Math.min(seconds, rnd(0.1, 0.18));
  const flutter = rnd(25, 55);
  let ph = 0;
  for (let i = 0; i < Math.floor(len * sr); i += 1) {
    const t = i / sr;
    const k = t / len;
    ph += (2 * Math.PI * f0 * (f1 / f0) ** k) / sr;
    const e = Math.min(1, t / 0.012) * (1 - k) ** 1.5;
    d[i] = e * (1 - 0.35 * (0.5 + 0.5 * Math.sin(2 * Math.PI * flutter * t))) * Math.sin(ph);
  }
  normalize(d, 1);
  return b;
};
// готовый буфер как слой рецепта
const layer = (c, out, t, buffer, gain = 1) => {
  const s = c.createBufferSource();
  s.buffer = buffer;
  const g = c.createGain();
  g.gain.value = gain;
  s.connect(g).connect(out);
  s.start(t);
};
// низкий мотор-редуктор: пила + меандр на f (гармоники гудят), низкочастотный фильтр, «зубья»
// шестерён рвут амплитуду (меандр-ЛФО, частота teeth[0]→teeth[1]), под ним полоса шума.
// f — основной тон, glide — во сколько раз он вырастет к концу (у шагов ≈1: свип звучит «птицей»),
// cut — срез фильтра
const motorLayer = (c, out, t, len, { f, glide = 1, cut = 900, teeth = [40, 40], gain = 0.6 }) => {
  const lp = c.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = cut;
  lp.Q.value = 0.7;
  const am = c.createGain();
  am.gain.value = 0.6;
  const lfo = c.createOscillator();
  lfo.type = 'square';
  lfo.frequency.setValueAtTime(teeth[0], t);
  lfo.frequency.linearRampToValueAtTime(teeth[1], t + len);
  const depth = c.createGain();
  depth.gain.value = 0.4;
  lfo.connect(depth).connect(am.gain);
  const e = c.createGain();
  e.gain.setValueAtTime(0.0001, t);
  e.gain.exponentialRampToValueAtTime(gain, t + Math.min(0.03, len * 0.25));
  e.gain.setValueAtTime(gain, t + len * 0.75);
  e.gain.exponentialRampToValueAtTime(0.0001, t + len);
  lp.connect(am).connect(e).connect(out);
  const oscs = [lfo];
  for (const [type, mul, g] of [['sawtooth', 1, 0.6], ['square', 0.5, 0.4]]) {
    const o = c.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f * mul, t);
    if (glide !== 1) o.frequency.exponentialRampToValueAtTime(f * mul * glide, t + len);
    const og = c.createGain();
    og.gain.value = g;
    o.connect(og).connect(lp);
    oscs.push(o);
  }
  const s = c.createBufferSource();
  s.buffer = noiseBuf(c, len + 0.02);
  const bp = c.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = rnd(300, 600);
  bp.Q.value = 0.8;
  const ng = c.createGain();
  ng.gain.value = 0.5;
  s.connect(bp).connect(ng).connect(am);
  s.start(t);
  for (const o of oscs) {
    o.start(t);
    o.stop(t + len + 0.02);
  }
};
// щелчок во всю полосу (фронт удара)
const click = (c, out, t, gain = 1, from = 1500) => noise(c, out, t, { seconds: 0.006, type: 'highpass', from, gain, decay: 0.003 });

const RECIPES = {
  // попадание: очень короткий широкополосный щелчок, яркая вспышка шума через перегруз, высокий
  // «вой дуги» с быстрым дрожанием частоты, короткая «пила» разряда снизу
  zap: { variants: 4, seconds: 0.3, render(c, out) {
    const hot = drive(c, out);
    noise(c, out, 0, { seconds: 0.02, type: 'highpass', from: 150, gain: 1, decay: 0.006 });
    noise(c, hot, 0, { seconds: 0.1, type: 'highpass', from: 7500, to: 2200, gain: 0.9, decay: 0.07 });
    noise(c, hot, 0.004, { seconds: 0.05, type: 'bandpass', from: 4200, to: 2600, gain: 0.6, decay: 0.035 });
    const length = rnd(0.1, 0.18);
    const whine = c.createOscillator();
    whine.type = 'sawtooth';
    const f0 = rnd(1800, 3400);
    for (let k = 0; k <= 16; k += 1) whine.frequency.setValueAtTime(f0 * rnd(0.75, 1.35) * (1 - (0.35 * k) / 16), (k * length) / 16);
    const hp = c.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 1200;
    whine.connect(hp).connect(env(c, 0, 0.32, length, hot, 0.004));
    whine.start(0);
    whine.stop(length + 0.02);
    tone(c, hot, 0, { type: 'sawtooth', from: rnd(160, 220), to: 90, gain: 0.18, decay: 0.08 });
  } },
  // треск дуг: россыпь сухих щелчков и пара коротких взвизгов
  crackle: { variants: 3, seconds: 0.5, render(c, out) {
    const n = 10 + Math.floor(Math.random() * 6);
    for (let i = 0; i < n; i += 1) {
      const f = rnd(3000, 9000);
      noise(c, out, rnd(0, 0.45), { seconds: 0.02, type: 'bandpass', from: f, to: f * 0.7, gain: rnd(0.25, 0.85), decay: rnd(0.004, 0.014) });
    }
    for (let i = 0; i < 2; i += 1) tone(c, out, rnd(0, 0.36), { type: 'square', from: rnd(2500, 5000), to: rnd(1500, 2500), gain: 0.05, decay: 0.03 });
  } },
  // смерть: электрический вой съезжает вниз и «захлёбывается» (амплитуду рвёт всё более редкий
  // меандр), искрит; в конце глухой удар корпуса
  powerDown: { variants: 2, seconds: 1.5, render(c, out) {
    const bp = c.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 2;
    bp.frequency.setValueAtTime(2600, 0);
    bp.frequency.exponentialRampToValueAtTime(180, 1.3);
    const hot = drive(c, bp);
    const sputter = c.createGain();
    sputter.gain.value = 0.5;
    const lfo = c.createOscillator();
    lfo.type = 'square';
    lfo.frequency.setValueAtTime(45, 0);
    lfo.frequency.exponentialRampToValueAtTime(5, 1.3);
    const depth = c.createGain();
    depth.gain.value = 0.5;
    lfo.connect(depth).connect(sputter.gain);
    const e = c.createGain();
    e.gain.setValueAtTime(0.0001, 0);
    e.gain.exponentialRampToValueAtTime(0.4, 0.02);
    e.gain.setValueAtTime(0.4, 0.5);
    e.gain.exponentialRampToValueAtTime(0.0001, 1.35);
    bp.connect(sputter).connect(e).connect(out);
    for (const [type, from, to] of [['sawtooth', 1500, 55], ['square', 760, 30]]) {
      const o = c.createOscillator();
      o.type = type;
      o.frequency.setValueAtTime(from * rnd(0.9, 1.1), 0);
      o.frequency.exponentialRampToValueAtTime(to, 1.3);
      o.connect(hot);
      o.start(0);
      o.stop(1.4);
    }
    lfo.start(0);
    lfo.stop(1.4);
    for (let i = 0; i < 10; i += 1) {
      const f = rnd(2500, 7500);
      noise(c, out, rnd(0, 1.1), { seconds: 0.03, type: 'bandpass', from: f, to: f * 0.6, gain: rnd(0.25, 0.7), decay: rnd(0.006, 0.026) });
    }
    tone(c, out, 0.9, { from: 140, to: 45, gain: 0.45, decay: 0.2 });
  } },
  // пуля по живому корпусу: стальная пластина — жёсткий щелчок, звонкий негармоничный «дзанг»
  // с биениями, под ним глухой «бонк» полого корпуса; у каждого варианта своя высота
  clank: { variants: 10, seconds: 0.3, peak: 0.9, render(c, out) {
    const f0 = rnd(260, 520);
    click(c, out, 0, 0.8, 1000);
    noise(c, out, 0, { seconds: 0.03, type: 'bandpass', from: rnd(1800, 2600), to: 800, gain: 0.4, decay: 0.02, q: 1.2 });
    layer(c, out, 0, modalBuf(c, 0.3, plateModes(f0, 7, rnd(0.08, 0.13), 0.006), 0.04), 0.75);
    tone(c, out, 0, { from: f0 * rnd(0.4, 0.5), to: f0 * 0.34, gain: 0.5, decay: 0.07 }); // полость
  } },
  // то же + короткий рикошет: пуля с посвистом уходит в сторону (≈ каждое десятое попадание)
  ricochet: { variants: 4, seconds: 0.3, peak: 0.9, render(c, out) {
    const f0 = rnd(320, 560);
    click(c, out, 0, 0.9, 1200);
    layer(c, out, 0, modalBuf(c, 0.2, plateModes(f0, 7, rnd(0.06, 0.09), 0.006), 0.05), 0.65);
    layer(c, out, rnd(0.01, 0.02), whistleBuf(c, 0.25), 0.3);
  } },
  // пуля по лежащему: тяжёлый удар по пустому стальному корпусу — ниже и длиннее, «бум» внутри,
  // и дребезг отбитых деталей
  clankHeavy: { variants: 8, seconds: 0.6, peak: 0.95, render(c, out) {
    const f0 = rnd(140, 260);
    click(c, out, 0, 0.9, 1000);
    layer(c, out, 0, modalBuf(c, 0.6, plateModes(f0, 9, rnd(0.14, 0.2), 0.004), 0.03), 0.8);
    tone(c, out, 0, { from: rnd(100, 130), to: 50, gain: 0.7, decay: 0.16 }); // «бум» пустого корпуса
    noise(c, out, 0, { seconds: 0.08, type: 'bandpass', from: 2200, to: 500, gain: 0.5, decay: 0.05 });
    noise(c, out, 0, { seconds: 0.2, type: 'lowpass', from: 900, to: 150, gain: 0.35, decay: 0.12 });
    const n = 1 + Math.floor(Math.random() * 3);
    for (let i = 0; i < n; i += 1) layer(c, out, rnd(0.04, 0.16), modalBuf(c, 0.04, plateModes(rnd(700, 1400), 3, 0.012, 0.006)), rnd(0.08, 0.18));
  } },
  // пёс врезался в игрока: тяжёлый глухой удар с металлическим отзвуком
  thud: { variants: 2, seconds: 0.4, render(c, out) {
    tone(c, out, 0, { from: 120, to: 42, gain: 1, decay: 0.28 });
    noise(c, out, 0, { seconds: 0.2, type: 'lowpass', from: 1200, to: 150, gain: 0.8, decay: 0.12 });
    tone(c, out, 0, { type: 'triangle', from: rnd(360, 400), to: 340, gain: 0.12, decay: 0.15 });
  } },
  // взмах лапой большого пса: тяжёлый «вуух» — шум, полоса съезжает вниз, плавно нарастает и гаснет
  whoosh: { variants: 2, seconds: 0.55, render(c, out) {
    const s = c.createBufferSource();
    s.buffer = noiseBuf(c, 0.55);
    const bp = c.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 1.4;
    bp.frequency.setValueAtTime(rnd(900, 1200), 0);
    bp.frequency.exponentialRampToValueAtTime(160, 0.45);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, 0);
    g.gain.exponentialRampToValueAtTime(0.9, 0.2);
    g.gain.exponentialRampToValueAtTime(0.0001, 0.52);
    s.connect(bp).connect(g).connect(out);
    s.start(0);
    tone(c, out, 0.05, { from: 70, to: 40, gain: 0.25, decay: 0.4 });
  } },
  // ярость: злой электрический «лай» — два рваных гавка: пила через перегруз с дрожью частоты,
  // треск разряда поверх
  bark: { variants: 3, seconds: 0.6, render(c, out) {
    const hot = drive(c, out, 4);
    for (const [t0, len] of [[0, 0.16], [0.24, 0.22]]) {
      const o = c.createOscillator();
      o.type = 'sawtooth';
      const f = rnd(260, 340);
      for (let k = 0; k <= 10; k += 1) o.frequency.setValueAtTime(f * rnd(0.85, 1.15) * (1 - (0.4 * k) / 10), t0 + (k * len) / 10);
      const bp = c.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = rnd(900, 1300);
      bp.Q.value = 1.2;
      o.connect(bp).connect(env(c, t0, 0.7, len, hot, 0.01));
      o.start(t0);
      o.stop(t0 + len + 0.02);
      noise(c, hot, t0, { seconds: 0.06, type: 'highpass', from: 5000, to: 2500, gain: 0.35, decay: 0.04 });
    }
  } },
  // рык перед броском/в засаде: низкий перегруженный гул с «рокотом» (АМ 18–28 Гц) и натужным
  // сервоприводом поверх — электрическое «ррр»
  growl: { variants: 3, seconds: 0.85, peak: 0.85, render(c, out) {
    const len = rnd(0.6, 0.78);
    const hot = drive(c, out, 4);
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 2;
    lp.frequency.setValueAtTime(450, 0);
    lp.frequency.linearRampToValueAtTime(rnd(850, 1100), len * 0.35);
    lp.frequency.linearRampToValueAtTime(380, len);
    const am = c.createGain();
    am.gain.value = 0.55;
    const lfo = c.createOscillator();
    lfo.type = 'triangle';
    lfo.frequency.value = rnd(18, 28);
    const depth = c.createGain();
    depth.gain.value = 0.45;
    lfo.connect(depth).connect(am.gain);
    const e = c.createGain();
    e.gain.setValueAtTime(0.0001, 0);
    e.gain.exponentialRampToValueAtTime(0.8, 0.08);
    e.gain.setValueAtTime(0.8, len * 0.7);
    e.gain.exponentialRampToValueAtTime(0.0001, len);
    lp.connect(am).connect(e).connect(hot);
    const f = rnd(55, 75);
    const oscs = [lfo];
    for (const [type, mul, g] of [['sawtooth', 1, 0.6], ['sawtooth', 1.012, 0.5], ['square', 2, 0.25]]) {
      const o = c.createOscillator();
      o.type = type;
      for (let k = 0; k <= 8; k += 1) o.frequency.setValueAtTime(f * mul * rnd(0.94, 1.06), (k * len) / 8);
      const og = c.createGain();
      og.gain.value = g;
      o.connect(og).connect(lp);
      oscs.push(o);
    }
    for (const o of oscs) {
      o.start(0);
      o.stop(len + 0.02);
    }
    motorLayer(c, out, 0.05, len * 0.8, { f: rnd(100, 130), glide: 1.12, cut: 800, teeth: [30, 55], gain: 0.3 });
  } },
  // рёв перед атакой (большие псы встают на дыбы, засада срывается в бег): электрический вой —
  // три расстроенные пилы, тон 130 → 260 Гц с дрожью → вниз, форманта 600 → 1500 → 700 Гц,
  // сильный перегруз, треск разрядов, низкий гул под ним
  howl: { variants: 3, seconds: 1.4, peak: 0.9, render(c, out) {
    const len = rnd(1.05, 1.3);
    const hot = drive(c, out, 5);
    const bp = c.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 1.3;
    bp.frequency.setValueAtTime(600, 0);
    bp.frequency.linearRampToValueAtTime(rnd(1300, 1600), len * 0.35);
    bp.frequency.linearRampToValueAtTime(700, len);
    const e = c.createGain();
    e.gain.setValueAtTime(0.0001, 0);
    e.gain.exponentialRampToValueAtTime(0.9, 0.12);
    e.gain.setValueAtTime(0.9, len * 0.6);
    e.gain.exponentialRampToValueAtTime(0.0001, len);
    bp.connect(e).connect(hot);
    const f0 = rnd(120, 145);
    const top = f0 * rnd(1.8, 2.05);
    const oscs = [];
    for (const [mul, g] of [[1, 0.6], [1.008, 0.5], [0.5, 0.45]]) {
      const o = c.createOscillator();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(f0 * mul, 0);
      o.frequency.exponentialRampToValueAtTime(top * mul, len * 0.3);
      for (let k = 1; k <= 10; k += 1) o.frequency.setValueAtTime(top * mul * rnd(0.93, 1.07) * (1 - (0.3 * k) / 10), len * 0.3 + (k * len * 0.6) / 10);
      o.frequency.exponentialRampToValueAtTime(f0 * mul * 1.1, len);
      const og = c.createGain();
      og.gain.value = g;
      o.connect(og).connect(bp);
      oscs.push(o);
    }
    for (const o of oscs) {
      o.start(0);
      o.stop(len + 0.02);
    }
    tone(c, out, 0, { type: 'sawtooth', from: 55, to: 42, gain: 0.35, decay: len });
    for (let k = 0; k < 6; k += 1) noise(c, out, rnd(0.05, len * 0.8), { seconds: 0.05, type: 'highpass', from: rnd(2500, 4000), gain: rnd(0.2, 0.4), decay: 0.035 });
  } },
  // пулемёт на спине пса: механический выстрел — щелчок во всю полосу, перегруженный хлопок,
  // пинок снизу, звон стальной ствольной коробки, через ~40 мс «клац» затвора, короткое эхо
  // (синтетический и с механикой — не похож на сэмплы оружия игрока)
  mg: { variants: 6, seconds: 0.34, peak: 0.95, render(c, out) {
    const hot = drive(c, out, 5);
    click(c, out, 0, 1, 800);
    noise(c, hot, 0, { seconds: 0.09, type: 'bandpass', from: rnd(1400, 1900), to: 450, gain: 0.9, decay: 0.055, q: 1.5 });
    tone(c, hot, 0, { from: rnd(120, 150), to: 48, gain: 0.8, decay: 0.07 });
    layer(c, out, 0.001, modalBuf(c, 0.12, plateModes(rnd(700, 1100), 6, 0.04, 0.004), 0.03), 0.2);
    const tb = rnd(0.032, 0.045);
    noise(c, out, tb, { seconds: 0.01, type: 'lowpass', from: rnd(1500, 2200), to: 500, gain: 0.5, decay: 0.008, q: 0.7 });
    layer(c, out, tb, modalBuf(c, 0.04, plateModes(rnd(1200, 1800), 3, 0.012, 0.004)), 0.18);
    noise(c, out, 0.008, { seconds: 0.32, type: 'lowpass', from: 1800, to: 220, gain: 0.22, decay: 0.26 });
  } },
  // наводка перед очередью (TURRET_WIND 0,35 с): низкий мотор башенки раскручивается (70→190 Гц) с
  // дребезгом шестерён, в конце глухой «клац» — взвёл
  turretWind: { variants: 3, seconds: 0.45, peak: 0.85, render(c, out) {
    const len = 0.32;
    motorLayer(c, out, 0, len, { f: rnd(65, 80), glide: rnd(2.3, 2.7), cut: 900, teeth: [15, 55], gain: 0.8 });
    rattle(c, out, 0.04, len - 0.06, 7, 0.35);
    noise(c, out, len + 0.005, { seconds: 0.03, type: 'lowpass', from: 1800, to: 300, gain: 0.8, decay: 0.02, q: 0.7 });
    layer(c, out, len + 0.005, modalBuf(c, 0.05, plateModes(rnd(500, 800), 4, 0.015, 0.004)), 0.4);
    tone(c, out, len + 0.005, { from: 160, to: 90, gain: 0.4, decay: 0.04 });
  } },
  // шаг: шарнир. Короткий низкий гул мотор-редуктора (80–220 Гц, без свипа), в конце хода глухой
  // металлический «тук» петли (низко-средний, сильно задемпфирован), иногда дребезг люфта
  servo: { variants: 8, seconds: 0.22, peak: 0.8, render(c, out) {
    const len = rnd(0.07, 0.13);
    motorLayer(c, out, 0, len, { f: rnd(80, 220), glide: rnd(0.95, 1.08), cut: rnd(600, 1000), teeth: [rnd(30, 60), rnd(30, 60)], gain: 0.55 });
    const tick = len * rnd(0.7, 1);
    noise(c, out, tick, { seconds: 0.015, type: 'lowpass', from: rnd(1200, 2000), to: 350, gain: 0.7, decay: 0.01, q: 0.7 });
    layer(c, out, tick, modalBuf(c, 0.04, plateModes(rnd(380, 700), 3, 0.012, 0.004)), 0.45);
    tone(c, out, tick, { from: rnd(130, 170), to: 80, gain: 0.35, decay: 0.035 });
    if (Math.random() < 0.4) rattle(c, out, tick + 0.01, 0.05, 2 + Math.floor(Math.random() * 2), 0.25);
  } },
  // гидравлика: только шум — шипение струи (полоса 1–5 кГц), затухает
  hiss: { variants: 4, seconds: 0.35, peak: 0.6, render(c, out) {
    const len = rnd(0.16, 0.3);
    const s = c.createBufferSource();
    s.buffer = noiseBuf(c, len + 0.05);
    const hp = c.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.setValueAtTime(rnd(1200, 1700), 0);
    hp.frequency.linearRampToValueAtTime(rnd(900, 1200), len);
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 5000;
    const e = c.createGain();
    e.gain.setValueAtTime(0.0001, 0);
    e.gain.exponentialRampToValueAtTime(0.7, 0.02);
    e.gain.setValueAtTime(0.7, len * 0.4);
    e.gain.exponentialRampToValueAtTime(0.0001, len);
    s.connect(hp).connect(lp).connect(e).connect(out);
    s.start(0);
  } },
  // корпус ударился о землю: глухой «бум» с коротким металлическим отзвуком
  groundThud: { variants: 4, seconds: 0.3, render(c, out) {
    tone(c, out, 0, { from: rnd(85, 110), to: 45, gain: 0.9, decay: 0.14 });
    noise(c, out, 0, { seconds: 0.12, type: 'lowpass', from: 900, to: 180, gain: 0.7, decay: 0.08 });
    ring(c, out, 0, rnd(300, 380), [[1, 0.12, 0.12], [1.6, 0.08, 0.08], [2.4, 0.05, 0.05]]);
  } },
  // волочится по земле: шорох и скрежет металла, рваный
  scrape: { variants: 3, seconds: 0.45, render(c, out) {
    const s = c.createBufferSource();
    s.buffer = noiseBuf(c, 0.45);
    const bp = c.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 4;
    bp.frequency.setValueAtTime(rnd(1400, 2200), 0);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, 0);
    for (let k = 1; k <= 18; k += 1) {
      const t = (k * 0.4) / 18;
      g.gain.setValueAtTime(rnd(0.05, 0.5) * (1 - t / 0.45), t);
      bp.frequency.setValueAtTime(rnd(1200, 3200), t);
    }
    g.gain.setValueAtTime(0.0001, 0.44);
    s.connect(bp).connect(g).connect(out);
    s.start(0);
    noise(c, out, 0, { seconds: 0.4, type: 'lowpass', from: 500, to: 200, gain: 0.25, decay: 0.35 }); // шорох по траве
  } },
};

// Запечь все рецепты (один раз на страницу; ключ — версия рецептов и частота). По одному варианту
// за раз (await): работа JS (моды) размазана по кадрам, а не одним рывком; сначала по первому
// варианту каждого звука, потом вторые и т. д. — всё звучит почти сразу.
const bake = (shared, sampleRate) => {
  const key = `${BAKE_VERSION}|${sampleRate}`;
  const old = shared.dogSoundBank;
  // та же версия, но добавились новые рецепты (подмена файла) — допечь только их, остальное не трогать
  if (old?.key === key && Object.keys(RECIPES).every((name) => old.buffers[name])) return old;
  const bank = old?.key === key ? old : (shared.dogSoundBank = { key, buffers: {} });
  if (typeof OfflineAudioContext === 'undefined') return bank;
  const entries = Object.entries(RECIPES).filter(([name]) => !bank.buffers[name]);
  for (const [name] of entries) bank.buffers[name] = [];
  const most = Math.max(...entries.map(([, r]) => r.variants));
  (async () => {
    for (let v = 0; v < most; v += 1) {
      for (const [name, recipe] of entries) {
        if (v >= recipe.variants) continue;
        if (shared.dogSoundBank !== bank) return; // пересобирается заново
        try {
          const c = new OfflineAudioContext(1, Math.ceil(recipe.seconds * sampleRate), sampleRate);
          const out = c.createGain();
          out.connect(c.destination);
          recipe.render(c, out);
          const buffer = await c.startRendering();
          if (recipe.peak) normalize(buffer.getChannelData(0), recipe.peak);
          bank.buffers[name].push(buffer);
        } catch (e) {
          console.warn('[dog-sound] не запёкся', name, e?.message ?? e);
        }
      }
    }
  })();
  return bank;
};

// Постоянные голоса: усиление → HRTF → master, и посыл в реверб. Пересобираются, только если
// поменялся сам выход (sound.js пересобрал шину) или POOL_VERSION.
const voicesFor = (shared, g) => {
  const pool = shared.dogVoices;
  const bus = npcOut(g);
  if (pool?.version === POOL_VERSION && pool.master === g.master && pool.bus === bus && pool.context === g.context) return pool;
  for (const v of [...(pool?.voices ?? []), ...(pool?.own ?? [])]) {
    try {
      v.input.disconnect();
      v.panner.disconnect();
    } catch {
      // уже отключён
    }
  }
  const c = g.context;
  const make = (out) => {
    const input = c.createGain();
    input.gain.value = 0;
    const panner = c.createPanner();
    panner.panningModel = 'HRTF';
    panner.distanceModel = 'inverse';
    panner.refDistance = 1.5;
    panner.rolloffFactor = 0.5;
    panner.maxDistance = 200;
    input.connect(panner).connect(out);
    const send = c.createGain();
    send.gain.value = 0.18;
    if (g.reverbSend) input.connect(send).connect(g.reverbSend);
    return { input, panner, source: null, endAt: 0, startedAt: 0 };
  };
  const voices = Array.from({ length: VOICES }, () => make(bus));
  const own = Array.from({ length: OWN }, () => make(g.master));
  return (shared.dogVoices = { version: POOL_VERSION, master: g.master, bus, context: c, voices, own });
};

export function createDogSound(shared) {
  let bank = null;
  const ok = (v) => Number.isFinite(v);

  const budget = audioBudget(shared);
  // own — звон от своей пули (свои голоса, без бюджета); иначе — звук мира, спрашивает бюджет
  const play = (name, position, gain, rate = 1, own = false) => {
    try {
      const g = shared.audioGraph;
      const c = g?.context;
      if (!c || !position || !ok(position.x) || !ok(position.y) || !ok(position.z)) return;
      if (c.state === 'suspended') c.resume();
      bank = bank?.key === `${BAKE_VERSION}|${c.sampleRate}` ? bank : bake(shared, c.sampleRate);
      const list = bank.buffers[name];
      if (!list?.length) return; // ещё запекается
      const buffer = list[Math.floor(Math.random() * list.length)];
      if (!own && !budget.admit(CAT[name] ?? 'hit', position, gain, buffer.duration / rate, 1.5, 0.5)) return;
      const pool = voicesFor(shared, g);
      const t = c.currentTime;
      // свободный голос; нет — самый старый
      let voice = null;
      for (const v of own ? pool.own : pool.voices) {
        if (v.endAt <= t) {
          voice = v;
          break;
        }
        if (!voice || v.startedAt < voice.startedAt) voice = v;
      }
      let at = t;
      if (voice.endAt > t && voice.source) {
        // уступает: гаснет за 20 мс
        voice.input.gain.cancelScheduledValues(t);
        voice.input.gain.setValueAtTime(voice.input.gain.value, t);
        voice.input.gain.linearRampToValueAtTime(0, t + 0.02);
        try {
          voice.source.stop(t + 0.021);
        } catch {
          // уже закончился
        }
        at = t + 0.022;
      } else voice.input.gain.cancelScheduledValues(t);
      voice.input.gain.setValueAtTime(Math.min(2, Math.max(0, gain)), at);
      const p = voice.panner;
      if (p.positionX) {
        p.positionX.setValueAtTime(position.x, at);
        p.positionY.setValueAtTime(position.y, at);
        p.positionZ.setValueAtTime(position.z, at);
      } else p.setPosition(position.x, position.y, position.z);
      const source = c.createBufferSource();
      source.buffer = buffer;
      source.playbackRate.value = rate;
      source.connect(voice.input);
      source.onended = () => {
        source.disconnect();
        if (voice.source === source) voice.source = null;
      };
      source.start(at);
      voice.source = source;
      voice.startedAt = at;
      voice.endAt = at + source.buffer.duration / rate;
    } catch {
      // звук не важнее игры
    }
  };

  // запечь сразу, если контекст уже есть (иначе — на первом звуке)
  try {
    if (shared.audioGraph?.context) bank = bake(shared, shared.audioGraph.context.sampleRate);
  } catch {
    // позже
  }

  const jitter = (a = 0.06) => 1 + (Math.random() - 0.5) * a;
  // size — размер пса (1 маленький … 4 огромный): ниже (playbackRate 1/√size, огромный — на октаву)
  // и громче (size^0.4); тот же буфер и голос, ничего нового не строится
  // own (4-й аргумент) — звук от своей пули: свои голоса, без бюджета (audio-budget.js)
  const big = (fn) => (p, k, size = 1, own = false) => {
    if (size === 1) return fn(p, k, 1, 1, own);
    return fn(p, k, size ** 0.4, 1 / Math.sqrt(size), own);
  };
  // шипение гидравлики: не чаще раза в 1,2 с на всех псов (по времени звука)
  let hissAt = -1;
  const hiss = (p, g, r) => {
    const t = shared.audioGraph?.context?.currentTime ?? 0;
    if (t - hissAt < 1.2) return;
    hissAt = t;
    play('hiss', p, 0.16 * g, r * jitter(0.12));
  };
  return {
    zap: big((p, k = 1, g, r, own) => play('zap', p, 0.6 * k * g, r * jitter(0.12), own)),
    crackle: big((p, _k, g, r) => play('crackle', p, 0.4 * g, r * jitter())),
    powerDown: big((p, _k, g, r) => play('powerDown', p, 0.7 * g, r * jitter(0.04))),
    // попадание по живому: стальной «дзанг» разной высоты, иногда рикошет со свистом
    clank: big((p, _k, g, r, own) => (Math.random() < 0.1 ? play('ricochet', p, 0.7 * g, r * jitter(0.15), own) : play('clank', p, 0.8 * g, r * jitter(0.2), own))),
    // k: 0..1 — калибр (пистолет ~0.4, калаш ~0.7, AWP 1): громче и ниже
    clankHeavy: big((p, k = 0.5, g, r, own) => (Math.random() < 0.06
      ? play('ricochet', p, 0.6 * g, r * 0.8 * jitter(0.15), own)
      : play('clankHeavy', p, (0.55 + 0.6 * k) * g, r * (1.12 - 0.3 * k) * jitter(0.15), own))),
    thud: big((p, _k, g, r) => play('thud', p, 0.95 * g, r * jitter(0.04))),
    // шаг: шарнир (мотор + тик петли + скрип), быстрее — громче и выше; иногда шипит гидравлика
    servo: big((p, speed = 1, g, r) => {
      const s = Math.min(4, Math.max(0, speed));
      play('servo', p, 0.3 * (0.6 + 0.15 * s) * g, r * (0.95 + 0.04 * s) * jitter(0.1)); // низкий гул: чуть громче, динамики шлема слабы внизу
      if (Math.random() < 0.1) hiss(p, g, r);
    }),
    // наводка башенки перед очередью
    turretWind: big((p, _k, g, r) => play('turretWind', p, 0.45 * g, r * jitter(0.06))),
    groundThud: big((p, k = 0.5, g, r) => play('groundThud', p, (0.25 + 0.75 * k) * g, r * (1.1 - 0.25 * k) * jitter(0.08))),
    scrape: big((p, k = 0.5, g, r) => play('scrape', p, (0.15 + 0.45 * k) * g, r * (0.85 + 0.3 * k) * jitter(0.08))),
    whoosh: big((p, _k, g, r) => play('whoosh', p, 0.8 * g, r * jitter(0.08))),
    bark: big((p, _k, g, r) => play('bark', p, 0.8 * g, r * jitter(0.14))),
    growl: big((p, _k, g, r) => play('growl', p, 0.8 * g, r * jitter(0.1))), // присел перед броском, засада
    howl: big((p, _k, g, r) => play('howl', p, 1.0 * g, r * jitter(0.08))), // рёв: на дыбы, рывок из засады
    mg: big((p, _k, g, r) => play('mg', p, 0.85 * g, r * jitter(0.1))),
  };
}
