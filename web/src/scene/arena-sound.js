// Звуки оружия арены (arena-weapons.js: ракетница, рейлган, плазмаган). Тот же звуковой граф, что у
// всей сцены: __sceneState.audioGraph = { context, master, reverbSend } (его создаёт sound.js).
//
// ПРАВИЛО (docs/agents/effects-and-sound.md): ничего не строится на звук. Все звуки один раз считаются
// прямо в JS в AudioBuffer (без узлов) и лежат в __sceneState.arenaSoundBank (запекаются по одному за
// задачу — работа размазана по кадрам). Голоса — постоянные цепочки (усиление → HRTF → master, посыл в
// реверб) в __sceneState.arenaVoices: SHOTS разовых (на звук — только BufferSource; нет свободного —
// самый старый гаснет за 20 мс) и одна постоянная петля — шипение ближайшей летящей ракеты.
//
// createArenaSound(shared) → { rocketLaunch(p), explosion(p, near), rail(p), plasma(p), plasmaHit(p),
//   hiss(p | null, gain), silence(), stats() } — p: мировая точка.
import { audioBudget } from './audio-budget.js';

const BAKE_VERSION = 1;
const POOL_VERSION = 1;
const SHOTS = 10;

const TAU = Math.PI * 2;
const rnd = (a, b) => a + Math.random() * (b - a);
const normalize = (d, peak) => {
  let m = 0;
  for (let i = 0; i < d.length; i += 1) m = Math.max(m, Math.abs(d[i]));
  if (m > 0) for (let i = 0; i < d.length; i += 1) d[i] *= peak / m;
};
const fadeTail = (d, sr, seconds = 0.03) => {
  const n = Math.min(d.length, Math.floor(sr * seconds));
  for (let i = 0; i < n; i += 1) d[d.length - 1 - i] *= i / n;
};
const fadeIn = (d, sr, seconds = 0.002) => {
  const n = Math.min(d.length, Math.floor(sr * seconds));
  for (let i = 0; i < n; i += 1) d[i] *= i / n;
};

const RECIPES = {
  // пуск ракеты: глухой толчок (синус 90→35 Гц) + шипящий «вшшух» (шум, фильтр раскрывается и
  // закрывается — ракета уходит) + треск выхлопа
  rocketLaunch: { variants: 2, seconds: 1.3, render(d, sr) {
    let ph = 0;
    let lp = 0;
    let lp2 = 0;
    for (let i = 0; i < d.length; i += 1) {
      const t = i / sr;
      ph += (TAU * (35 + 55 * Math.exp(-t / 0.05))) / sr;
      const thump = Math.sin(ph) * Math.exp(-t / 0.12) * 1.3;
      const w = Math.random() * 2 - 1;
      const open = Math.min(1, t / 0.05) * Math.exp(-t / 0.35);
      const k = 0.03 + 0.4 * open;
      lp += k * (w - lp);
      lp2 += k * (lp - lp2);
      // полоса: первый фильтр минус часть второго (низ срезан, верх закрывается вместе с k)
      const hiss = (lp - lp2 * 0.6) * (Math.min(1, t / 0.015) * Math.exp(-t / 0.45)) * 2.4;
      const crackle = Math.random() < 0.004 * Math.exp(-t / 0.4) ? rnd(-1, 1) * 0.8 : 0;
      d[i] += thump + hiss + crackle + w * Math.exp(-t / 0.006) * 0.6;
    }
    fadeTail(d, sr, 0.15);
    normalize(d, 0.9);
  } },
  // шипение ракеты в полёте: петля 1 с — полосовой шум (круговая фильтрация — без стыка) + рокот 80 Гц
  rocketHiss: { variants: 1, seconds: 1, loop: true, render(d, sr) {
    const n = d.length;
    const x = new Float32Array(n);
    for (let i = 0; i < n; i += 1) x[i] = Math.random() * 2 - 1;
    let a = 0;
    let b = 0;
    for (let pass = 0; pass < 2; pass += 1) {
      for (let i = 0; i < n; i += 1) {
        a += 0.35 * (x[i] - a);
        b += 0.04 * (a - b);
        if (pass) d[i] = (a - b) * 1.0 + b * 1.6;
      }
    }
    // рокот: целое число периодов на петлю
    for (let i = 0; i < n; i += 1) d[i] += 0.12 * Math.sin((TAU * 80 * i) / sr) + 0.06 * Math.sin((TAU * 121 * i) / sr);
    normalize(d, 0.7);
  } },
  // взрыв ракеты: щелчок, удар низкочастотного шума, суббас 70→28 Гц, треск осколков, раскат
  explosion: { variants: 3, seconds: 2.4, render(d, sr) {
    let ph = 0;
    let lp = 0;
    let lp2 = 0;
    let rl = 0;
    let rl2 = 0;
    for (let i = 0; i < d.length; i += 1) {
      const t = i / sr;
      const w = Math.random() * 2 - 1;
      const a = 0.025 + 0.4 * Math.exp(-t / 0.08);
      lp += a * (w - lp);
      lp2 += a * (lp - lp2);
      rl += 0.008 * (w - rl);
      rl2 += 0.008 * (rl - rl2);
      const env = Math.min(1, t / 0.002) * Math.exp(-t / 0.35);
      ph += (TAU * (28 + 42 * Math.exp(-t / 0.12))) / sr;
      d[i] += w * Math.exp(-t / 0.008) * 1.2 + lp2 * env * 5 + Math.sin(ph) * Math.exp(-t / 0.5) * 1.2 + rl2 * Math.exp(-t / 0.9) * 22;
      if (t > 0.03 && t < 1.2 && Math.random() < 0.0016) {
        const k = Math.exp(-t / 0.4) * rnd(0.2, 0.6);
        for (let j = 0; j < 60 && i + j < d.length; j += 1) d[i + j] += (Math.random() * 2 - 1) * k * Math.exp(-j / 10);
      }
    }
    fadeTail(d, sr, 0.25);
    normalize(d, 0.98);
  } },
  // рейлган: короткий (35 мс) взлетающий «зиип» заряда → сухой треск разряда → «жжуум»: звенящие
  // металлические партиалы (1 : 2,41 : 3,93 : 5,6) съезжают вниз, электрический гул 100 Гц с
  // гармониками бьётся и гаснет, хвост — шипение
  rail: { variants: 2, seconds: 1.5, render(d, sr) {
    const t0 = 0.035;
    let zp = 0;
    const partial = [1, 2.41, 3.93, 5.6];
    const amp = [0.5, 0.32, 0.2, 0.12];
    const ph = [0, 0, 0, 0];
    const base = rnd(820, 900);
    let hum = 0;
    let lp = 0;
    let prev = 0;
    for (let i = 0; i < d.length; i += 1) {
      const t = i / sr;
      const w = Math.random() * 2 - 1;
      if (t < t0) {
        const e = t / t0;
        zp += (TAU * (600 + 5400 * e * e)) / sr;
        d[i] += Math.sin(zp + 2 * Math.sin(zp * 0.5)) * e * e * 0.6;
        continue;
      }
      const u = t - t0;
      // треск: дифференцированный шум (яркий) + щелчок
      const crack = (w - prev) * Math.exp(-u / 0.012) * 1.4;
      prev = w;
      // «жжуум»: партиалы, частота падает в 2,2 раза за ~0,5 с, вибрато растёт
      const glide = 1 / (1 + 1.2 * (1 - Math.exp(-u / 0.35)));
      let ring = 0;
      for (let k = 0; k < 4; k += 1) {
        ph[k] += (TAU * base * partial[k] * glide * (1 + 0.012 * Math.sin(u * 38 + k))) / sr;
        ring += amp[k] * Math.sin(ph[k]) * Math.exp(-u / (0.5 - 0.09 * k));
      }
      // электрический гул: пила 100 Гц, мягко срезанная, с биениями
      hum += (TAU * 100) / sr;
      const saw = ((hum / TAU) % 1) * 2 - 1;
      lp += 0.08 * (saw - lp);
      const buzz = lp * (0.6 + 0.4 * Math.sin(u * 23)) * Math.exp(-u / 0.42) * 0.9;
      const air = w * 0.25 * Math.exp(-u / 0.25);
      d[i] += crack + ring * 0.9 + buzz + air;
    }
    fadeIn(d, sr, 0.003);
    fadeTail(d, sr, 0.2);
    normalize(d, 0.92);
  } },
  // плазма: короткий «пью» — синус с частотной модуляцией, тон падает экспоненциально (каждый
  // вариант — своя высота и глубина модуляции) + щелчок и немного шипения
  plasma: { variants: 5, seconds: 0.32, render(d, sr) {
    const f0 = rnd(1500, 2300);
    const f1 = rnd(260, 380);
    const fm = rnd(0.6, 1.4);
    const mr = rnd(1.4, 2.2);
    let ph = 0;
    let mph = 0;
    let lp = 0;
    for (let i = 0; i < d.length; i += 1) {
      const t = i / sr;
      const f = f1 + (f0 - f1) * Math.exp(-t / 0.045);
      mph += (TAU * f * mr) / sr;
      ph += (TAU * f) / sr;
      const env = Math.min(1, t / 0.002) * Math.exp(-t / 0.07);
      const w = Math.random() * 2 - 1;
      lp += 0.3 * (w - lp);
      d[i] += Math.sin(ph + fm * Math.exp(-t / 0.06) * Math.sin(mph)) * env + (w - lp) * Math.exp(-t / 0.01) * 0.5 + lp * env * 0.15;
    }
    fadeTail(d, sr, 0.04);
    normalize(d, 0.75);
  } },
  // попадание плазмы: шипящий «пшш-тц» — полосовой шум + короткий падающий тон
  plasmaHit: { variants: 3, seconds: 0.3, render(d, sr) {
    let a = 0;
    let b = 0;
    let ph = 0;
    const f0 = rnd(1100, 1500);
    for (let i = 0; i < d.length; i += 1) {
      const t = i / sr;
      const w = Math.random() * 2 - 1;
      a += 0.5 * (w - a);
      b += 0.08 * (a - b);
      ph += (TAU * (180 + f0 * Math.exp(-t / 0.025))) / sr;
      d[i] += (a - b) * Math.exp(-t / 0.06) * 0.9 + Math.sin(ph) * Math.exp(-t / 0.04) * 0.5;
    }
    fadeTail(d, sr, 0.04);
    normalize(d, 0.7);
  } },
};

const bake = (shared, c) => {
  const sampleRate = c.sampleRate;
  const key = `${BAKE_VERSION}|${sampleRate}`;
  if (shared.arenaSoundBank?.key === key) return shared.arenaSoundBank;
  const bank = (shared.arenaSoundBank = { key, buffers: {} });
  const jobs = [];
  for (const [name, recipe] of Object.entries(RECIPES)) {
    bank.buffers[name] = [];
    for (let v = 0; v < recipe.variants; v += 1) jobs.push([name, recipe]);
  }
  const step = () => {
    if (shared.arenaSoundBank !== bank || !jobs.length) return;
    const [name, recipe] = jobs.shift();
    try {
      const buffer = c.createBuffer(1, Math.ceil(recipe.seconds * sampleRate), sampleRate);
      recipe.render(buffer.getChannelData(0), sampleRate);
      bank.buffers[name].push(buffer);
    } catch (e) {
      console.warn('[arena-sound] не запёкся', name, e?.message ?? e);
    }
    setTimeout(step, 16);
  };
  setTimeout(step, 0);
  return bank;
};

const voicesFor = (shared, g) => {
  const pool = shared.arenaVoices;
  if (pool?.version === POOL_VERSION && pool.master === g.master && pool.context === g.context) return pool;
  for (const v of [...(pool?.shots ?? []), pool?.hiss]) {
    if (!v) continue;
    try {
      v.source?.stop();
      v.input.disconnect();
      v.panner.disconnect();
    } catch {
      // уже отключён
    }
  }
  const c = g.context;
  const chain = (ref, rolloff, sendGain) => {
    const input = c.createGain();
    input.gain.value = 0;
    const panner = c.createPanner();
    panner.panningModel = 'HRTF';
    panner.distanceModel = 'inverse';
    panner.refDistance = ref;
    panner.rolloffFactor = rolloff;
    panner.maxDistance = 600;
    input.connect(panner).connect(g.master);
    if (g.reverbSend) {
      const send = c.createGain();
      send.gain.value = sendGain;
      input.connect(send).connect(g.reverbSend);
    }
    return { input, panner, source: null, endAt: 0, startedAt: 0 };
  };
  const shots = [];
  for (let i = 0; i < SHOTS; i += 1) shots.push(chain(2, 0.8, 0.25));
  return (shared.arenaVoices = { version: POOL_VERSION, master: g.master, context: c, shots, hiss: chain(2, 1, 0.1) });
};

export function createArenaSound(shared) {
  let bank = null;
  let played = 0;
  const ok = (v) => Number.isFinite(v);
  const ready = () => {
    const g = shared.audioGraph;
    const c = g?.context;
    if (!c) return null;
    if (bank?.key !== `${BAKE_VERSION}|${c.sampleRate}`) bank = bake(shared, c);
    return g;
  };
  const setPos = (p, x, y, z) => {
    if (p.positionX) {
      p.positionX.value = x;
      p.positionY.value = y;
      p.positionZ.value = z;
    } else p.setPosition(x, y, z);
  };

  const play = (name, position, gain, rate = 1, ref = 2) => {
    try {
      const g = ready();
      if (!g || !position || !ok(position.x) || !ok(position.y) || !ok(position.z)) return;
      const c = g.context;
      if (c.state === 'suspended') c.resume();
      const list = bank.buffers[name];
      if (!list?.length) return; // ещё запекается
      const pool = voicesFor(shared, g);
      const t = c.currentTime;
      let voice = null;
      for (const v of pool.shots) {
        if (v.endAt <= t) {
          voice = v;
          break;
        }
        if (!voice || v.startedAt < voice.startedAt) voice = v;
      }
      let at = t;
      if (voice.endAt > t && voice.source) {
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
      voice.input.gain.setValueAtTime(Math.min(2.5, Math.max(0, gain)), at);
      voice.panner.refDistance = ref;
      setPos(voice.panner, position.x, position.y, position.z);
      const source = c.createBufferSource();
      source.buffer = list[Math.floor(Math.random() * list.length)];
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
      played += 1;
    } catch {
      // звук не важнее игры
    }
  };

  // шипение ближайшей ракеты: постоянная петля, меняются позиция и громкость
  let hissGain = 0;
  const hiss = (p, gain = 1) => {
    try {
      if (!p && !hissGain) return;
      const g = ready();
      if (!g || !bank?.buffers.rocketHiss?.length) return;
      const v = voicesFor(shared, g).hiss;
      if (!v.source) {
        const s = g.context.createBufferSource();
        s.buffer = bank.buffers.rocketHiss[0];
        s.loop = true;
        s.connect(v.input);
        s.start(g.context.currentTime);
        v.source = s;
      }
      const t = g.context.currentTime;
      if (!p) {
        hissGain = 0;
        v.input.gain.setTargetAtTime(0, t, 0.05);
        return;
      }
      if (!ok(p.x) || !ok(p.y) || !ok(p.z)) return;
      setPos(v.panner, p.x, p.y, p.z);
      if (Math.abs(hissGain - gain) > 0.01) {
        hissGain = gain;
        v.input.gain.setTargetAtTime(gain, t, 0.04);
      }
    } catch {
      // звук не важнее игры
    }
  };

  try {
    ready();
  } catch {
    // позже
  }

  const vary = (k) => 1 + (Math.random() - 0.5) * k;
  return {
    // выстрелы игрока: шина мира коротко тише (audio-budget.js)
    rocketLaunch: (p) => (audioBudget(shared).duck(), play('rocketLaunch', p, 1.2, vary(0.08), 1)),
    explosion: (p) => play('explosion', p, 1.6, vary(0.12), 7),
    rail: (p) => (audioBudget(shared).duck(), play('rail', p, 1.1, vary(0.04), 1)),
    plasma: (p) => (audioBudget(shared).duck(0.75), play('plasma', p, 0.55, vary(0.1), 1)),
    plasmaHit: (p) => play('plasmaHit', p, 0.7, vary(0.2), 2),
    hiss,
    silence() {
      try {
        const pool = shared.arenaVoices;
        if (pool?.hiss && pool.context) pool.hiss.input.gain.setTargetAtTime(0, pool.context.currentTime, 0.04);
        hissGain = 0;
      } catch {
        // звук не важнее игры
      }
    },
    stats: () => ({
      baked: bank ? Object.fromEntries(Object.entries(bank.buffers).map(([k, v]) => [k, v.length])) : null,
      played,
      hiss: hissGain,
    }),
  };
}
