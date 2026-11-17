// Звуки робопсов: электричество и металл. Свой модуль (sound.js ведёт другой агент), но тот же
// звуковой граф: __sceneState.audioGraph = { context, master, reverbSend } (его создаёт sound.js).
//
// Как в sound.js (docs/agents/effects-and-sound.md): ничего не синтезируется на лету. Каждый
// рецепт один раз «запекается» в буферы через OfflineAudioContext (по несколько случайных
// вариантов) и живёт в __sceneState.dogSoundBank. Голоса — постоянные цепочки (усиление → HRTF-панорама
// → master, и посыл в реверб), их VOICES штук, в __sceneState.dogVoices. На звук создаётся только
// AudioBufferSourceNode; голосов не хватает — самый старый быстро гаснет и уступает.
//
// createDogSound(shared) → { zap(p, k), crackle(p), powerDown(p), clank(p), clankHeavy(p, k),
//   thud(p), servo(p, speed), groundThud(p, k), scrape(p, k) } — p: мировая точка, k: 0..1 сила
const BAKE_VERSION = 1;
const POOL_VERSION = 1;
const VOICES = 8;

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
  // пуля по живому корпусу: полый «бдзынь» — ниже, короче и глуше звона мишени
  clank: { variants: 4, seconds: 0.25, render(c, out) {
    ring(c, out, 0, rnd(430, 550), [[1, 0.3, 0.16], [1.47, 0.22, 0.11], [2.09, 0.14, 0.08], [2.76, 0.08, 0.05]]);
    noise(c, out, 0, { seconds: 0.05, type: 'bandpass', from: 1400, to: 400, gain: 0.6, decay: 0.035 });
    tone(c, out, 0, { from: 190, to: 95, gain: 0.35, decay: 0.07 });
  } },
  // пуля по лежащему: тяжёлый полый удар по пустому металлическому корпусу — глубже и длиннее
  clankHeavy: { variants: 4, seconds: 0.5, render(c, out) {
    const base = rnd(240, 320);
    ring(c, out, 0, base, [[1, 0.36, 0.38], [1.52, 0.26, 0.26], [2.13, 0.16, 0.18], [2.91, 0.1, 0.12], [3.8, 0.05, 0.08]]);
    tone(c, out, 0, { from: 150, to: 60, gain: 0.7, decay: 0.16 }); // «бум» пустого корпуса
    noise(c, out, 0, { seconds: 0.08, type: 'bandpass', from: 2200, to: 500, gain: 0.8, decay: 0.05 });
    noise(c, out, 0, { seconds: 0.2, type: 'lowpass', from: 900, to: 150, gain: 0.5, decay: 0.12 });
  } },
  // пёс врезался в игрока: тяжёлый глухой удар с металлическим отзвуком
  thud: { variants: 2, seconds: 0.4, render(c, out) {
    tone(c, out, 0, { from: 120, to: 42, gain: 1, decay: 0.28 });
    noise(c, out, 0, { seconds: 0.2, type: 'lowpass', from: 1200, to: 150, gain: 0.8, decay: 0.12 });
    tone(c, out, 0, { type: 'triangle', from: rnd(360, 400), to: 340, gain: 0.12, decay: 0.15 });
  } },
  // шаг на бегу: тихий «вжик» сервопривода
  servo: { variants: 3, seconds: 0.12, render(c, out) {
    const f = rnd(560, 760);
    const bp = c.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = f * 2;
    bp.Q.value = 3;
    bp.connect(out);
    tone(c, bp, 0, { type: 'sawtooth', from: f, to: f * 1.35, gain: 0.5, decay: 0.07 });
    noise(c, out, 0.06, { seconds: 0.02, type: 'highpass', from: 4000, to: 3000, gain: 0.15, decay: 0.006 });
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

// Запечь все рецепты (один раз на страницу; ключ — версия рецептов и частота).
const bake = (shared, sampleRate) => {
  const key = `${BAKE_VERSION}|${sampleRate}`;
  if (shared.dogSoundBank?.key === key) return shared.dogSoundBank;
  const bank = (shared.dogSoundBank = { key, buffers: {} });
  if (typeof OfflineAudioContext === 'undefined') return bank;
  for (const [name, recipe] of Object.entries(RECIPES)) {
    bank.buffers[name] = [];
    for (let v = 0; v < recipe.variants; v += 1) {
      try {
        const c = new OfflineAudioContext(1, Math.ceil(recipe.seconds * sampleRate), sampleRate);
        const out = c.createGain();
        out.connect(c.destination);
        recipe.render(c, out);
        c.startRendering()
          .then((buffer) => bank.buffers[name].push(buffer))
          .catch((e) => console.warn('[dog-sound] не запёкся', name, e?.message ?? e));
      } catch (e) {
        console.warn('[dog-sound] не запёкся', name, e?.message ?? e);
      }
    }
  }
  return bank;
};

// Постоянные голоса: усиление → HRTF → master, и посыл в реверб. Пересобираются, только если
// поменялся сам выход (sound.js пересобрал шину) или POOL_VERSION.
const voicesFor = (shared, g) => {
  const pool = shared.dogVoices;
  if (pool?.version === POOL_VERSION && pool.master === g.master && pool.context === g.context) return pool;
  for (const v of pool?.voices ?? []) {
    try {
      v.input.disconnect();
      v.panner.disconnect();
    } catch {
      // уже отключён
    }
  }
  const c = g.context;
  const voices = [];
  for (let i = 0; i < VOICES; i += 1) {
    const input = c.createGain();
    input.gain.value = 0;
    const panner = c.createPanner();
    panner.panningModel = 'HRTF';
    panner.distanceModel = 'inverse';
    panner.refDistance = 1.5;
    panner.rolloffFactor = 0.5;
    panner.maxDistance = 200;
    input.connect(panner).connect(g.master);
    const send = c.createGain();
    send.gain.value = 0.18;
    if (g.reverbSend) input.connect(send).connect(g.reverbSend);
    voices.push({ input, panner, source: null, endAt: 0, startedAt: 0 });
  }
  return (shared.dogVoices = { version: POOL_VERSION, master: g.master, context: c, voices });
};

export function createDogSound(shared) {
  let bank = null;
  const ok = (v) => Number.isFinite(v);

  const play = (name, position, gain, rate = 1) => {
    try {
      const g = shared.audioGraph;
      const c = g?.context;
      if (!c || !position || !ok(position.x) || !ok(position.y) || !ok(position.z)) return;
      if (c.state === 'suspended') c.resume();
      bank = bank?.key === `${BAKE_VERSION}|${c.sampleRate}` ? bank : bake(shared, c.sampleRate);
      const list = bank.buffers[name];
      if (!list?.length) return; // ещё запекается
      const pool = voicesFor(shared, g);
      const t = c.currentTime;
      // свободный голос; нет — самый старый
      let voice = null;
      for (const v of pool.voices) {
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
  return {
    zap: (p, k = 1) => play('zap', p, 0.75 * k, jitter(0.12)),
    crackle: (p) => play('crackle', p, 0.4, jitter()),
    powerDown: (p) => play('powerDown', p, 0.7, jitter(0.04)),
    clank: (p) => play('clank', p, 0.6, jitter()),
    // k: 0..1 — калибр (пистолет ~0.4, калаш ~0.7, AWP 1): громче и ниже
    clankHeavy: (p, k = 0.5) => play('clankHeavy', p, 0.5 + 0.6 * k, (1.12 - 0.3 * k) * jitter(0.05)),
    thud: (p) => play('thud', p, 0.95, jitter(0.04)),
    servo: (p, speed = 1) => play('servo', p, 0.12, (0.9 + Math.min(4, speed) * 0.06) * jitter(0.05)),
    groundThud: (p, k = 0.5) => play('groundThud', p, 0.25 + 0.75 * k, (1.1 - 0.25 * k) * jitter(0.08)),
    scrape: (p, k = 0.5) => play('scrape', p, 0.15 + 0.45 * k, (0.85 + 0.3 * k) * jitter(0.08)),
  };
}
