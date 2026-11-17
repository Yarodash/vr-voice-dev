// Звуки чёрной дыры (blackhole.js, Космо-снайперка). Тот же звуковой граф, что у всей сцены:
// __sceneState.audioGraph = { context, master, reverbSend } (его создаёт sound.js).
//
// ПРАВИЛО (docs/agents/effects-and-sound.md): ничего не строится на звук. Все звуки один раз
// считаются прямо в JS в AudioBuffer (без узлов) и лежат в __sceneState.bhSoundBank (запекаются по
// одному за задачу — работа размазана по кадрам). Голоса — постоянные цепочки (усиление → HRTF →
// master, посыл в реверб) в __sceneState.bhVoices: SHOTS разовых (на звук — только BufferSource;
// нет свободного — самый старый гаснет за 20 мс) и две постоянные петли: гул летящей дыры (отдан
// ближайшей) и вой заряда у дула (высота растёт с зарядом). Меняются только позиция, громкость и
// скорость воспроизведения.
//
// createBlackholeSound(shared) → { fire(p, k), collapse(p, k), tick(p), rumble(p|null, k),
//   whine(p|null, level), stats() } — p: мировая точка, k / level: заряд 0..1.
import { audioBudget } from './audio-budget.js';

const BAKE_VERSION = 1;
const POOL_VERSION = 1;
const SHOTS = 4;
export const COLLAPSE_SWELL_S = 0.5; // с: обратный нарастающий звук до удара (удар в буфере — на этой секунде)

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
// петля без щелчка: синус целой частоты (за длину буфера — целое число периодов), поворотом вектора
const addLoopSine = (d, sr, f, a) => {
  const w = (TAU * f) / sr;
  const cw = Math.cos(w);
  const sw = Math.sin(w);
  const ph = Math.random() * TAU;
  let x = Math.cos(ph);
  let y = Math.sin(ph);
  for (let i = 0; i < d.length; i += 1) {
    d[i] += a * y;
    const nx = x * cw - y * sw;
    y = x * sw + y * cw;
    x = nx;
  }
};
// низкочастотный шум по кругу (второй проход начинается с состояния конца первого) — без стыка
const addLoopNoise = (d, k, a) => {
  const n = d.length;
  const x = new Float32Array(n);
  for (let i = 0; i < n; i += 1) x[i] = Math.random() * 2 - 1;
  let y = 0;
  let y2 = 0;
  for (let pass = 0; pass < 2; pass += 1) {
    for (let i = 0; i < n; i += 1) {
      y += k * (x[i] - y);
      y2 += k * (y - y2);
      if (pass) d[i] += y2 * a;
    }
  }
};

const RECIPES = {
  // выстрел: глубокий суббасовый «вуомп» (синус 100→30 Гц) + поднимающийся «вжууум» — три
  // расстроенных голоса (гармоники 1–4) 70→450 Гц с вибрато, ускоряющимся 6→14 Гц + воздушный свист
  fire: { variants: 2, seconds: 1.9, render(d, sr) {
    let ph = 0;
    const vph = [Math.random() * TAU, Math.random() * TAU, Math.random() * TAU];
    const det = [1, 1.009, 0.992];
    let vib = 0;
    let lp = 0;
    let lp2 = 0;
    for (let i = 0; i < d.length; i += 1) {
      const t = i / sr;
      const f0 = 30 + 70 * Math.exp(-t / 0.09);
      ph += (TAU * f0) / sr;
      const sub = Math.sin(ph) * Math.min(1, t / 0.004) * Math.exp(-t / 0.38) * 1.1;
      vib += (TAU * (6 + 8 * Math.min(1, t / 1.4))) / sr;
      const f1 = (70 + 380 * (1 - Math.exp(-t / 0.55))) * (1 + 0.06 * Math.sin(vib));
      const env = Math.min(1, t / 0.12) * (t < 1.05 ? 1 : Math.exp(-(t - 1.05) / 0.25));
      let w = 0;
      for (let k = 0; k < 3; k += 1) {
        vph[k] += (TAU * f1 * det[k]) / sr;
        const p = vph[k];
        w += Math.sin(p) + 0.5 * Math.sin(2 * p) + 0.28 * Math.sin(3 * p) + 0.15 * Math.sin(4 * p);
      }
      const n = Math.random() * 2 - 1;
      const k2 = 0.01 + 0.2 * Math.min(1, t / 1.2);
      lp += k2 * (n - lp);
      lp2 += k2 * (lp - lp2);
      d[i] += sub + w * 0.11 * env + lp2 * env * 0.9;
    }
    fadeTail(d, sr, 0.08);
    normalize(d, 0.95);
  } },
  // схлопывание: COLLAPSE_SWELL_S с обратного нарастания (шум и тон 60→500 Гц, как запущенный задом
  // наперёд удар, обрыв), затем огромный удар: щелчок, бум низкочастотного шума, суббас 50→18 Гц,
  // треск, долгий низкий раскат
  collapse: { variants: 2, seconds: 4.2, render(d, sr) {
    const t0 = COLLAPSE_SWELL_S;
    let ph = 0;
    let sph = 0;
    let lp = 0;
    let lp2 = 0;
    let rl = 0;
    let rl2 = 0;
    for (let i = 0; i < d.length; i += 1) {
      const t = i / sr;
      const w = Math.random() * 2 - 1;
      if (t < t0) {
        const e = (t / t0) ** 3;
        const k = 0.02 + 0.5 * e;
        lp += k * (w - lp);
        sph += (TAU * (60 + 440 * e)) / sr;
        d[i] += lp * e * 1.6 + Math.sin(sph) * e * 0.35 + Math.sin(sph * 1.5) * e * 0.15;
        continue;
      }
      const u = t - t0;
      const a = 0.02 + 0.33 * Math.exp(-u / 0.15);
      lp += a * (w - lp);
      lp2 += a * (lp - lp2);
      rl += 0.006 * (w - rl);
      rl2 += 0.006 * (rl - rl2);
      const env = Math.min(1, u / 0.003) * Math.exp(-u / 0.7);
      const f = 18 + 32 * Math.exp(-u / 0.3);
      ph += (TAU * f) / sr;
      d[i] += w * Math.exp(-u / 0.01) * 1.0 + lp2 * env * 6 + Math.sin(ph) * Math.exp(-u / 1.1) * 1.1 + rl2 * Math.exp(-u / 1.6) * 30;
      if (u > 0.05 && u < 1.6 && Math.random() < 0.0012) {
        const k = Math.exp(-u / 0.6) * rnd(0.2, 0.7);
        for (let j = 0; j < 80 && i + j < d.length; j += 1) d[i + j] += (Math.random() * 2 - 1) * k * Math.exp(-j / 14);
      }
    }
    fadeTail(d, sr, 0.2);
    normalize(d, 0.98);
  } },
  // полный заряд: звонкий «дзинь» (колокольчик 1:2.76:5.4) со щелчком и мягким низким толчком
  tick: { variants: 1, seconds: 0.6, render(d, sr) {
    const f0 = 1750;
    for (const [r, a, tau] of [[1, 1, 0.22], [2.76, 0.5, 0.1], [5.4, 0.3, 0.05], [0.5, 0.5, 0.08]]) {
      let ph = 0;
      for (let i = 0; i < d.length; i += 1) {
        const t = i / sr;
        d[i] += a * Math.sin(ph) * Math.exp(-t / tau);
        ph += (TAU * f0 * r) / sr;
      }
    }
    let prev = 0;
    for (let i = 0; i < Math.floor(0.01 * sr); i += 1) {
      const w = Math.random() * 2 - 1;
      d[i] += (w - prev) * Math.exp(-i / (0.002 * sr));
      prev = w;
    }
    fadeTail(d, sr);
    normalize(d, 0.8);
  } },
  // гул летящей дыры: петля 2 с (частоты кратны 0,5 Гц) — низкий рокот 31/37,5/46 Гц, вой 220 Гц с
  // гармониками и биениями, низкочастотный шум
  rumble: { variants: 1, seconds: 2, loop: true, render(d, sr) {
    addLoopSine(d, sr, 31, 0.9);
    addLoopSine(d, sr, 37.5, 0.7);
    addLoopSine(d, sr, 46, 0.5);
    addLoopSine(d, sr, 220, 0.12);
    addLoopSine(d, sr, 223.5, 0.1);
    addLoopSine(d, sr, 441, 0.06);
    addLoopSine(d, sr, 662.5, 0.035);
    addLoopNoise(d, 0.03, 4.5);
    normalize(d, 0.8);
  } },
  // вой заряда: петля 1 с — 180/270/361 Гц + биения 362 и шум-«дыхание» (высоту задаёт playbackRate)
  whine: { variants: 1, seconds: 1, loop: true, render(d, sr) {
    addLoopSine(d, sr, 180, 0.5);
    addLoopSine(d, sr, 270, 0.35);
    addLoopSine(d, sr, 361, 0.25);
    addLoopSine(d, sr, 364, 0.2);
    addLoopSine(d, sr, 540, 0.08);
    addLoopNoise(d, 0.12, 1.2);
    normalize(d, 0.7);
  } },
};

const bake = (shared, c) => {
  const sampleRate = c.sampleRate;
  const key = `${BAKE_VERSION}|${sampleRate}`;
  if (shared.bhSoundBank?.key === key) return shared.bhSoundBank;
  const bank = (shared.bhSoundBank = { key, buffers: {} });
  const jobs = [];
  for (const [name, recipe] of Object.entries(RECIPES)) {
    bank.buffers[name] = [];
    for (let v = 0; v < recipe.variants; v += 1) jobs.push([name, recipe]);
  }
  const step = () => {
    if (shared.bhSoundBank !== bank || !jobs.length) return;
    const [name, recipe] = jobs.shift();
    try {
      const buffer = c.createBuffer(1, Math.ceil(recipe.seconds * sampleRate), sampleRate);
      recipe.render(buffer.getChannelData(0), sampleRate);
      bank.buffers[name].push(buffer);
    } catch (e) {
      console.warn('[blackhole-sound] не запёкся', name, e?.message ?? e);
    }
    setTimeout(step, 16);
  };
  setTimeout(step, 0);
  return bank;
};

const voicesFor = (shared, g) => {
  const pool = shared.bhVoices;
  if (pool?.version === POOL_VERSION && pool.master === g.master && pool.context === g.context) return pool;
  for (const v of [...(pool?.shots ?? []), pool?.rumble, pool?.whine]) {
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
  for (let i = 0; i < SHOTS; i += 1) shots.push(chain(4, 0.6, 0.3));
  return (shared.bhVoices = { version: POOL_VERSION, master: g.master, context: c, shots, rumble: chain(4, 0.8, 0.15), whine: chain(0.8, 1, 0.05) });
};

export function createBlackholeSound(shared) {
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

  const play = (name, position, gain, rate = 1, ref = 4) => {
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

  // постоянная петля v (rumble | whine): запускается один раз, дальше звучит всегда (тихо — громкость 0)
  const loopVoice = (name) => {
    const g = shared.audioGraph;
    const c = g?.context;
    if (!c || !bank?.buffers[name]?.length) return null;
    const v = voicesFor(shared, g)[name];
    if (!v.source) {
      const s = c.createBufferSource();
      s.buffer = bank.buffers[name][0];
      s.loop = true;
      s.connect(v.input);
      s.start(c.currentTime);
      v.source = s;
    }
    return v;
  };
  const loopState = { rumble: 0, whine: 0 }; // текущая цель громкости (чтобы не планировать каждый кадр)
  const steer = (name, p, gain, rate) => {
    try {
      if (!p && !loopState[name]) return;
      if (!ready()) return;
      const v = loopVoice(name);
      if (!v) return;
      const t = v.input.context.currentTime;
      if (!p) {
        loopState[name] = 0;
        v.input.gain.setTargetAtTime(0, t, 0.06);
        return;
      }
      if (!ok(p.x) || !ok(p.y) || !ok(p.z) || !ok(gain) || !ok(rate)) return;
      setPos(v.panner, p.x, p.y, p.z);
      if (Math.abs(loopState[name] - gain) > 0.01) {
        loopState[name] = gain;
        v.input.gain.setTargetAtTime(gain, t, 0.05);
      }
      v.source.playbackRate.value = rate;
    } catch {
      // звук не важнее игры
    }
  };

  try {
    ready();
  } catch {
    // позже
  }

  return {
    fire: (p, k = 0) => audioBudget(shared).duck() || play('fire', p, 1.1 + 0.6 * k, (1.08 - 0.22 * k) * (1 + (Math.random() - 0.5) * 0.06), 2),
    // возвращает скорость воспроизведения: удар прозвучит через COLLAPSE_SWELL_S / она
    collapse: (p, k = 0) => {
      const rate = (1.1 - 0.25 * k) * (1 + (Math.random() - 0.5) * 0.05);
      play('collapse', p, 1.3 + 0.9 * k, rate, 8 + 10 * k);
      return rate;
    },
    // обе петли — в тишину (подмена сцены: новый модуль не знает, что старый оставил звучать)
    silence() {
      try {
        const pool = shared.bhVoices;
        const c = pool?.context;
        if (!c) return;
        for (const v of [pool.rumble, pool.whine]) v?.input.gain.setTargetAtTime(0, c.currentTime, 0.04);
        loopState.rumble = loopState.whine = 0;
      } catch {
        // звук не важнее игры
      }
    },
    tick: (p) => play('tick', p, 0.6, 1, 1),
    // гул ближайшей летящей дыры (null — нет ни одной)
    rumble: (p, k = 0, wob = 0) => steer('rumble', p, 0.5 + 0.5 * k, (0.95 - 0.3 * k) * (1 + wob)),
    // вой заряда у дула (null — не заряжается): высота и громкость растут с зарядом
    whine: (p, level = 0) => steer('whine', p, 0.18 + 0.3 * level, 0.55 + 1.6 * level * level),
    stats: () => ({
      baked: bank ? Object.fromEntries(Object.entries(bank.buffers).map(([k, v]) => [k, v.length])) : null,
      played,
      loops: { ...loopState },
    }),
  };
}
