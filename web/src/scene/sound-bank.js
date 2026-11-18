// Банк запечённых звуков с постоянными голосами — по ПРАВИЛАМ ЗВУКА (docs/agents/effects-and-sound.md),
// тот же приём, что arena-sound.js / artillery-sound.js, но в одну строку для нового модуля.
//
// const bank = createSoundBank('ping', {
//   launch: { seconds: 0.4, variants: 2, render(d, sr) { ... d[i] = ...; normalize(d, 0.9); } },
// }, { voices: 6 });
// bank.play('launch', point, vol = 1, { rate = 1, ref = 2, duck = false })  — point: мировая { x, y, z }
// bank.stats() → { baked: { launch: 2 }, played }
//
// - render(d, sr) пишет моно-сэмплы в Float32Array d (длина seconds·sr) — считается ОДИН раз, по одному
//   варианту за setTimeout-задачу; буферы лежат в __sceneState.<key>SoundBank и переживают подмену сцены
//   (правка render меняет ключ — банк перепекается сам).
// - Голоса: voices постоянных цепочек усиление → HRTF → master (+ посыл в реверб) в __sceneState.<key>Voices;
//   на звук создаётся только BufferSource; нет свободного голоса — самый старый гаснет за 20 мс.
// - duck: true — выстрел игрока: шина мира коротко тише (audio-budget.js). Звуки банка идут прямо в
//   master и бюджет не спрашивают (это звуки оружия игрока).
// - Не запёкся ещё — молчит. Любая ошибка звука глотается: звук не важнее игры.
import { audioBudget } from './audio-budget.js';

export const rnd = (a, b) => a + Math.random() * (b - a);
export const normalize = (d, peak) => {
  let m = 0;
  for (let i = 0; i < d.length; i += 1) m = Math.max(m, Math.abs(d[i]));
  if (m > 0) for (let i = 0; i < d.length; i += 1) d[i] *= peak / m;
};
export const fadeTail = (d, sr, seconds = 0.03) => {
  const n = Math.min(d.length, Math.floor(sr * seconds));
  for (let i = 0; i < n; i += 1) d[d.length - 1 - i] *= i / n;
};

const hash = (s) => {
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
};

export function createSoundBank(key, recipes, { voices = 6 } = {}) {
  const shared = (globalThis.__sceneState ??= {});
  const bankKey = `${key}SoundBank`;
  const voicesKey = `${key}Voices`;
  const src = hash(Object.entries(recipes).map(([n, r]) => `${n}|${r.seconds}|${r.variants ?? 1}|${r.render}`).join('\n'));
  let played = 0;

  const bake = (c) => {
    const k = `${src}|${c.sampleRate}`;
    if (shared[bankKey]?.key === k) return shared[bankKey];
    const bank = (shared[bankKey] = { key: k, buffers: {} });
    const jobs = [];
    for (const [name, r] of Object.entries(recipes)) {
      bank.buffers[name] = [];
      for (let v = 0; v < (r.variants ?? 1); v += 1) jobs.push([name, r]);
    }
    const step = () => {
      if (shared[bankKey] !== bank || !jobs.length) return;
      const [name, r] = jobs.shift();
      try {
        const buffer = c.createBuffer(1, Math.max(1, Math.ceil(r.seconds * c.sampleRate)), c.sampleRate);
        r.render(buffer.getChannelData(0), c.sampleRate);
        bank.buffers[name].push(buffer);
      } catch (e) {
        console.warn(`[${key}-sound] не запёкся`, name, e?.message ?? e);
      }
      setTimeout(step, 16);
    };
    setTimeout(step, 0);
    return bank;
  };

  const pool = (g) => {
    const p = shared[voicesKey];
    if (p?.n === voices && p.master === g.master && p.context === g.context) return p;
    for (const v of p?.list ?? []) {
      try {
        v.source?.stop();
        v.input.disconnect();
        v.panner.disconnect();
      } catch {
        // уже отключён
      }
    }
    const c = g.context;
    const list = [];
    for (let i = 0; i < voices; i += 1) {
      const input = c.createGain();
      input.gain.value = 0;
      const panner = c.createPanner();
      panner.panningModel = 'HRTF';
      panner.distanceModel = 'inverse';
      panner.rolloffFactor = 0.8;
      panner.maxDistance = 600;
      input.connect(panner).connect(g.master);
      if (g.reverbSend) {
        const send = c.createGain();
        send.gain.value = 0.2;
        input.connect(send).connect(g.reverbSend);
      }
      list.push({ input, panner, source: null, endAt: 0, startedAt: 0 });
    }
    return (shared[voicesKey] = { n: voices, master: g.master, context: c, list });
  };

  const play = (name, p, vol = 1, { rate = 1, ref = 2, duck = false } = {}) => {
    try {
      const g = shared.audioGraph; // создаёт sound.js (shooting.js держит его всегда)
      const c = g?.context;
      if (!c || !p || !Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) return false;
      if (c.state === 'suspended') c.resume();
      const list = bake(c).buffers[name];
      if (!list?.length) return false; // ещё запекается
      if (duck) audioBudget(shared).duck();
      const t = c.currentTime;
      let voice = null;
      for (const v of pool(g).list) {
        if (v.endAt <= t) {
          voice = v;
          break;
        }
        if (!voice || v.startedAt < voice.startedAt) voice = v;
      }
      let at = t;
      voice.input.gain.cancelScheduledValues(t);
      if (voice.endAt > t && voice.source) {
        voice.input.gain.setValueAtTime(voice.input.gain.value, t);
        voice.input.gain.linearRampToValueAtTime(0, t + 0.02);
        try {
          voice.source.stop(t + 0.021);
        } catch {
          // уже закончился
        }
        at = t + 0.022;
      }
      voice.input.gain.setValueAtTime(Math.min(2.5, Math.max(0, vol)), at);
      voice.panner.refDistance = ref;
      if (voice.panner.positionX) {
        voice.panner.positionX.value = p.x;
        voice.panner.positionY.value = p.y;
        voice.panner.positionZ.value = p.z;
      } else voice.panner.setPosition(p.x, p.y, p.z);
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
      return true;
    } catch {
      return false; // звук не важнее игры
    }
  };

  try {
    if (shared.audioGraph?.context) bake(shared.audioGraph.context); // начать печь сразу
  } catch {
    // позже, при первом play
  }

  return {
    play,
    stats: () => {
      const b = shared[bankKey];
      return { baked: b ? Object.fromEntries(Object.entries(b.buffers).map(([k, v]) => [k, v.length])) : null, played };
    },
  };
}
