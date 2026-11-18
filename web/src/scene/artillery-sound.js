// Звуки артиллерии (artillery.js). Тот же звуковой граф, что у всей сцены:
// __sceneState.audioGraph = { context, master, reverbSend } (его создаёт sound.js).
//
// ПРАВИЛО (docs/agents/effects-and-sound.md): ничего не строится на звук. Все звуки один раз
// считаются прямо в JS в AudioBuffer (без узлов) и лежат в __sceneState.artillerySoundBank; голоса —
// постоянные цепочки (усиление → панорама → master, посыл в реверб) в __sceneState.artilleryVoices.
// На звук создаётся только BufferSource; нет свободного голоса — самый старый гаснет за 20 мс.
//
// Взрыв — один заранее сведённый буфер (резкий треск + «тело» + суббас 76→26 Гц + дождь комьев +
// долгий гул). Дальность — не фильтр на звук, а три запечённых варианта: рядом (с треском и дождём
// комьев), средне (без верхов), далеко (глухой раскат с эхом). Свист падающего снаряда — нисходящий
// тон ~1,8 с, громче к концу; его голос двигается за снарядом (меняется только позиция).
//
// createArtillerySound(shared) → { boom(p, dist), thump(p), whistle(p) → h, move(h, x, y, z), stats() }
import { audioBudget, npcOut } from './audio-budget.js';

const BAKE_VERSION = 2;
const POOL_VERSION = 4; // 4: позиции — .value; 3: 3: разрывы и свист — equalpower (HRTF перегружал аудиопоток); 2: голоса — в npcBus (шина мира), звуки спрашивают audio-budget.js
const BOOMS = 6;
const WHISTLES = 4;
const THUMPS = 3;
export const WHISTLE_S = 1.8; // длина свиста: начинается за столько секунд до разрыва

const rnd = (a, b) => a + Math.random() * (b - a);
const normalize = (d, peak) => {
  let m = 0;
  for (let i = 0; i < d.length; i += 1) m = Math.max(m, Math.abs(d[i]));
  if (m > 0) for (let i = 0; i < d.length; i += 1) d[i] *= peak / m;
};
const fadeTail = (d, sr, seconds = 0.05) => {
  const n = Math.min(d.length, Math.floor(sr * seconds));
  for (let i = 0; i < n; i += 1) d[d.length - 1 - i] *= i / n;
};
// однополюсный ФНЧ по всему буферу (a — коэффициент: меньше — глуше)
const lowpass = (d, a, passes = 1) => {
  for (let p = 0; p < passes; p += 1) {
    let y = 0;
    for (let i = 0; i < d.length; i += 1) {
      y += a * (d[i] - y);
      d[i] = y;
    }
  }
};

// Взрыв снаряда. o: crack — сила треска, debris — дождь комьев, lp — ФНЧ после сведения (0 — нет),
// echo — [[задержка с, громкость]], rumble — долгий гул
const boomRecipe = (o) => ({
  variants: o.variants,
  seconds: o.seconds,
  render(d, sr) {
    let lp = 0;
    let lp2 = 0;
    let prev = 0;
    let rl = 0;
    let rl2 = 0;
    let ph = 0;
    const f0 = rnd(70, 84);
    for (let i = 0; i < d.length; i += 1) {
      const t = i / sr;
      const w = Math.random() * 2 - 1;
      // треск: продифференцированный белый шум, очень коротко
      const cr = (w - prev) * Math.exp(-t / 0.0045);
      prev = w;
      // «тело»: двухполюсный ФНЧ шума, полоса быстро сужается
      const a = 0.025 + 0.4 * Math.exp(-t / 0.09);
      lp += a * (w - lp);
      lp2 += a * (lp - lp2);
      const env = Math.min(1, t / 0.003) * (Math.exp(-t / 0.3) + 0.22 * Math.exp(-t / 1.1));
      // суббас: удар, частота падает, мягко перегружен (плотнее)
      const f = 26 + (f0 - 26) * Math.exp(-t / 0.11);
      ph += (2 * Math.PI * f) / sr;
      const sub = Math.tanh(1.8 * Math.sin(ph)) * Math.exp(-t / 0.6) * Math.min(1, t / 0.002);
      // гул: очень низкий шум, медленно нарастает и долго тает
      rl += 0.004 * (w - rl);
      rl2 += 0.004 * (rl - rl2);
      const rumble = rl2 * 34 * Math.min(1, t / 0.12) * Math.exp(-t / o.rumble);
      d[i] = o.crack * cr * 0.7 + lp2 * env * 5.5 + sub * 1.05 + rumble;
    }
    // дождь комьев: короткие щелчки и шорохи, гуще в начале
    if (o.debris > 0) {
      const n = Math.floor(70 * o.debris);
      for (let k = 0; k < n; k += 1) {
        const t0 = 0.22 + Math.random() ** 1.6 * (o.seconds - 0.8);
        const amp = o.debris * rnd(0.08, 0.5) * Math.exp(-(t0 - 0.22) / 1.2);
        const len = Math.floor(rnd(0.002, 0.014) * sr);
        const s0 = Math.floor(t0 * sr);
        let pv = 0;
        let y = 0;
        const soft = Math.random() < 0.5; // шорох (земля) или щелчок (камень)
        for (let j = 0; j < len && s0 + j < d.length; j += 1) {
          const w = Math.random() * 2 - 1;
          y += 0.35 * (w - y);
          const x = soft ? y : w - pv;
          pv = w;
          d[s0 + j] += x * amp * Math.exp(-j / (len * 0.3));
        }
      }
    }
    if (o.lp) lowpass(d, o.lp, o.lpPasses ?? 1);
    if (o.echo) {
      const src = Float32Array.from(d);
      for (const [delay, g] of o.echo) {
        const off = Math.floor(delay * sr);
        let y = 0;
        for (let i = off; i < d.length; i += 1) {
          y += 0.12 * (src[i - off] - y); // эхо глуше
          d[i] += y * g * 2.2;
        }
      }
    }
    fadeTail(d, sr, 0.25);
    normalize(d, 0.95);
  },
});

const RECIPES = {
  boomNear: boomRecipe({ variants: 3, seconds: 3.4, crack: 1, debris: 1, rumble: 1.4 }),
  boomMid: boomRecipe({ variants: 2, seconds: 3.6, crack: 0.5, debris: 0.45, rumble: 1.7, lp: 0.16, echo: [[0.55, 0.25]] }),
  boomFar: boomRecipe({ variants: 2, seconds: 4.2, crack: 0.2, debris: 0, rumble: 2.2, lp: 0.05, lpPasses: 2, echo: [[0.45, 0.4], [1.2, 0.25]] }),
  // свист подлетающего снаряда: тон падает ~1500 → ~750 Гц, громче к концу, воздух шипит
  whistle: { variants: 3, seconds: WHISTLE_S, render(d, sr) {
    let ph = 0;
    let lp = 0;
    let lp2 = 0;
    const f0 = rnd(1350, 1650);
    const T = d.length / sr;
    for (let i = 0; i < d.length; i += 1) {
      const t = i / sr;
      const x = t / T;
      const f = f0 * (1 - 0.5 * x ** 1.4) * (1 + 0.006 * Math.sin(2 * Math.PI * 5.5 * t));
      ph += (2 * Math.PI * f) / sr;
      const env = (0.1 + 0.9 * x ** 2.2) * Math.min(1, t / 0.2) * (x > 0.985 ? (1 - x) / 0.015 : 1);
      const w = Math.random() * 2 - 1;
      lp += 0.3 * (w - lp);
      lp2 += 0.3 * (lp - lp2);
      d[i] = env * (Math.sin(ph) * 0.7 + Math.sin(2 * ph) * 0.1 + (lp - lp2) * 1.4 * (0.25 + 0.75 * x));
    }
    normalize(d, 0.85);
  } },
  // далёкий выстрел батареи: глухой «бум» за горизонтом
  thump: { variants: 2, seconds: 2, render(d, sr) {
    let lp = 0;
    let lp2 = 0;
    let rl = 0;
    let ph = 0;
    for (let i = 0; i < d.length; i += 1) {
      const t = i / sr;
      const w = Math.random() * 2 - 1;
      lp += 0.03 * (w - lp);
      lp2 += 0.03 * (lp - lp2);
      rl += 0.006 * (w - rl);
      ph += (2 * Math.PI * (34 + 20 * Math.exp(-t / 0.08))) / sr;
      d[i] = lp2 * 9 * Math.min(1, t / 0.01) * Math.exp(-t / 0.14) + Math.sin(ph) * 0.6 * Math.exp(-t / 0.3) + rl * 6 * Math.min(1, t / 0.1) * Math.exp(-t / 0.7);
    }
    lowpass(d, 0.08);
    fadeTail(d, sr, 0.2);
    normalize(d, 0.8);
  } },
};

// Запечь все рецепты (один раз на страницу; ключ — версия и частота). По одному варианту за задачу
// (setTimeout) — работа размазана по кадрам.
const bake = (shared, c) => {
  const sampleRate = c.sampleRate;
  const key = `${BAKE_VERSION}|${sampleRate}`;
  if (shared.artillerySoundBank?.key === key) return shared.artillerySoundBank;
  const bank = (shared.artillerySoundBank = { key, buffers: {} });
  const jobs = [];
  // сначала по одному варианту каждого
  for (let v = 0; v < 3; v += 1) {
    for (const [name, recipe] of Object.entries(RECIPES)) {
      if (v === 0) bank.buffers[name] = [];
      if (v < recipe.variants) jobs.push([name, recipe]);
    }
  }
  const step = () => {
    if (shared.artillerySoundBank !== bank || !jobs.length) return;
    const [name, recipe] = jobs.shift();
    try {
      const buffer = c.createBuffer(1, Math.ceil(recipe.seconds * sampleRate), sampleRate);
      recipe.render(buffer.getChannelData(0), sampleRate);
      bank.buffers[name].push(buffer);
    } catch (e) {
      console.warn('[artillery-sound] не запёкся', name, e?.message ?? e);
    }
    setTimeout(step, 20);
  };
  setTimeout(step, 0);
  return bank;
};

// Постоянные голоса. Пересобираются, только если поменялся выход (sound.js пересобрал шину) или
// POOL_VERSION.
const voicesFor = (shared, g) => {
  const pool = shared.artilleryVoices;
  const bus = npcOut(g);
  if (pool?.version === POOL_VERSION && pool.master === g.master && pool.bus === bus && pool.context === g.context) return pool;
  for (const v of [...(pool?.boom ?? []), ...(pool?.whistle ?? []), ...(pool?.thump ?? [])]) {
    try {
      v.source?.stop();
      v.input.disconnect();
      v.panner.disconnect();
    } catch {
      // уже отключён
    }
  }
  const c = g.context;
  const chain = (model, ref, sendGain) => {
    const input = c.createGain();
    input.gain.value = 0;
    const panner = c.createPanner();
    panner.panningModel = model;
    panner.distanceModel = 'inverse';
    panner.refDistance = ref;
    panner.rolloffFactor = 1;
    panner.maxDistance = 3000;
    input.connect(panner).connect(bus);
    if (g.reverbSend) {
      const send = c.createGain();
      send.gain.value = sendGain;
      input.connect(send).connect(g.reverbSend);
    }
    return { input, panner, source: null, endAt: 0, startedAt: 0 };
  };
  const make = (n, ...args) => Array.from({ length: n }, () => chain(...args));
  return (shared.artilleryVoices = {
    version: POOL_VERSION,
    master: g.master,
    bus,
    context: c,
    // equalpower: HRTF-панорамы мира в бою перегружали аудиопоток Quest (выход глох целиком)
    boom: make(BOOMS, 'equalpower', 30, 0.35),
    whistle: make(WHISTLES, 'equalpower', 35, 0.08),
    thump: make(THUMPS, 'equalpower', 80, 0.45),
  });
};

export function createArtillerySound(shared) {
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
  // .value, не setValueAtTime: автоматизация позиции переводит панораму в дорогой посэмпловый режим
  const setPos = (p, x, y, z) => {
    if (p.positionX) {
      p.positionX.value = x;
      p.positionY.value = y;
      p.positionZ.value = z;
    } else p.setPosition(x, y, z);
  };

  // голос из пула kind: свободный или самый старый (гаснет за 20 мс); возвращает { voice, source } | null
  const budget = audioBudget(shared);
  // бюджет звуков мира (audio-budget.js): категория и опорное расстояние голоса по kind
  const CAT = { boom: ['boom', 30], whistle: ['far', 35], thump: ['far', 80] };
  const at3 = { x: 0, y: 0, z: 0 };
  const play = (kind, name, x, y, z, gain, rate = 1) => {
    try {
      const g = ready();
      if (!g || !ok(x) || !ok(y) || !ok(z)) return null;
      const c = g.context;
      if (c.state === 'suspended') c.resume();
      const list = bank.buffers[name];
      if (!list?.length) return null; // ещё запекается
      const buffer = list[Math.floor(Math.random() * list.length)];
      at3.x = x;
      at3.y = y;
      at3.z = z;
      const [cat, ref] = CAT[kind] ?? ['boom', 30];
      if (!budget.admit(cat, at3, gain, buffer.duration / rate, ref, 1)) return null;
      const voices = voicesFor(shared, g)[kind];
      const t = c.currentTime;
      let voice = null;
      for (const v of voices) {
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
      voice.input.gain.setValueAtTime(Math.min(2, Math.max(0, gain)), at);
      setPos(voice.panner, x, y, z, at);
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
      played += 1;
      return { voice, source };
    } catch {
      return null; // звук не важнее игры
    }
  };

  try {
    ready(); // запечь сразу, если контекст уже есть
  } catch {
    // позже
  }

  return {
    // разрыв в точке p; dist — до слушателя (выбирает вариант: рядом / средне / далеко)
    boom: (p, dist) => {
      const name = dist < 45 ? 'boomNear' : dist < 120 ? 'boomMid' : 'boomFar';
      play('boom', name, p.x, p.y, p.z, dist < 45 ? 1.15 : 1.3, rnd(0.92, 1.05));
    },
    // выстрел батареи далеко (p — точка в её стороне, ~250 м)
    thump: (p) => play('thump', 'thump', p.x, p.y, p.z, 0.9, rnd(0.85, 1.1)),
    // свист снаряда: голос потом двигают move(h, …), пока он его
    whistle: (p) => play('whistle', 'whistle', p.x, p.y, p.z, 0.75, rnd(0.94, 1.06)),
    move: (h, x, y, z) => {
      if (!h || h.voice.source !== h.source || !ok(x) || !ok(y) || !ok(z)) return;
      const p = h.voice.panner;
      if (p.positionX) {
        p.positionX.value = x;
        p.positionY.value = y;
        p.positionZ.value = z;
      } else p.setPosition(x, y, z);
    },
    stats: () => ({
      baked: bank ? Object.fromEntries(Object.entries(bank.buffers).map(([k, v]) => [k, v.length])) : null,
      played,
    }),
  };
}
