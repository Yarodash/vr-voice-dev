// Звуки робопсов: электричество и металл. Свой модуль (sound.js ведёт другой агент), но тот же
// звуковой граф: __sceneState.audioGraph = { context, master, reverbSend } (его создаёт sound.js).
// Все звуки — 3D (HRTF) в точке на псе, короткие (доли секунды), одновременно не больше VOICES:
// лишние просто не звучат (очередь из калаша по стае не забивает звук).
//
// createDogSound(shared) → { zap(p, strength), crackle(p, seconds), powerDown(p), clank(p), thud(p),
//   servo(p, speed) }
const VOICES = 10;

export function createDogSound(shared) {
  const ends = [];
  const noiseBuffers = new Map();
  let drive = null;

  const graph = () => {
    const g = shared.audioGraph;
    if (!g?.context) return null;
    if (g.context.state === 'suspended') g.context.resume();
    return g;
  };
  const voice = (c, seconds) => {
    const now = c.currentTime;
    for (let i = ends.length - 1; i >= 0; i -= 1) if (ends[i] <= now) ends.splice(i, 1);
    if (ends.length >= VOICES) return false;
    ends.push(now + seconds);
    return true;
  };
  const driveCurve = () => {
    if (drive) return drive;
    drive = new Float32Array(1024);
    for (let i = 0; i < 1024; i += 1) {
      const x = (i / 1023) * 2 - 1;
      drive[i] = Math.tanh(x * 2.5) / Math.tanh(2.5);
    }
    return drive;
  };
  const panner = (c, position, out, refDistance = 1.5) => {
    const p = c.createPanner();
    p.panningModel = 'HRTF';
    p.distanceModel = 'inverse';
    p.refDistance = refDistance;
    p.rolloffFactor = 0.5;
    p.maxDistance = 200;
    const t = c.currentTime;
    if (p.positionX) {
      p.positionX.setValueAtTime(position.x, t);
      p.positionY.setValueAtTime(position.y, t);
      p.positionZ.setValueAtTime(position.z, t);
    } else p.setPosition(position.x, position.y, position.z);
    p.connect(out);
    return p;
  };
  // вход звука: усиление → 3D в точке → master
  const out = (g, position, gain, refDistance) => {
    const c = g.context;
    const dest = c.createGain();
    dest.gain.value = gain;
    dest.connect(panner(c, position, g.master, refDistance));
    return dest;
  };
  const noiseBuffer = (c, seconds) => {
    let buffer = noiseBuffers.get(seconds);
    if (buffer) return buffer;
    buffer = c.createBuffer(1, Math.floor(c.sampleRate * seconds), c.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i += 1) data[i] = Math.random() * 2 - 1;
    noiseBuffers.set(seconds, buffer);
    return buffer;
  };
  const envelope = (c, t, gain, decay, dest, wet, reverb) => {
    const e = c.createGain();
    e.gain.setValueAtTime(0.0001, t);
    e.gain.exponentialRampToValueAtTime(gain, t + 0.002);
    e.gain.exponentialRampToValueAtTime(0.0001, t + decay);
    e.connect(dest);
    if (wet > 0 && reverb) {
      const w = c.createGain();
      w.gain.value = wet;
      e.connect(w).connect(reverb);
    }
    return e;
  };
  const noise = (g, t, { seconds, type, from, to, gain, decay, send = 0.1, dest }) => {
    const c = g.context;
    const source = c.createBufferSource();
    source.buffer = noiseBuffer(c, seconds);
    const filter = c.createBiquadFilter();
    filter.type = type;
    filter.frequency.setValueAtTime(from, t);
    filter.frequency.exponentialRampToValueAtTime(to, t + decay);
    source.connect(filter).connect(envelope(c, t, gain, decay, dest, send, g.reverbSend));
    source.start(t);
    source.stop(t + seconds);
  };
  const tone = (g, t, { type = 'sine', from, to = from, gain, decay, send = 0.1, dest }) => {
    const c = g.context;
    const osc = c.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(from, t);
    if (to !== from) osc.frequency.exponentialRampToValueAtTime(to, t + decay);
    osc.connect(envelope(c, t, gain, decay, dest, send, g.reverbSend));
    osc.start(t);
    osc.stop(t + decay + 0.02);
  };
  const safe = (fn) => (...args) => {
    try {
      const g = graph();
      if (g) fn(g, ...args);
    } catch {
      // без звука
    }
  };

  return {
    // Попадание: очень короткий широкополосный щелчок, яркая вспышка шума через лёгкий перегруз и
    // короткий высокий «вой дуги» с быстрым дрожанием частоты; снизу — короткая «пила» разряда.
    zap: safe((g, position, strength = 1) => {
      const c = g.context;
      const length = 0.1 + Math.random() * 0.08;
      if (!voice(c, length + 0.1)) return;
      const t = c.currentTime;
      const dest = out(g, position, 0.75 * strength);
      const hot = c.createWaveShaper(); // «высокое напряжение»
      hot.curve = driveCurve();
      hot.connect(dest);
      noise(g, t, { seconds: 0.02, type: 'highpass', from: 150, to: 150, gain: 1, decay: 0.006, send: 0.05, dest }); // щелчок
      noise(g, t, { seconds: 0.1, type: 'highpass', from: 7500, to: 2200, gain: 0.9, decay: 0.07, send: 0.15, dest: hot });
      noise(g, t + 0.004, { seconds: 0.05, type: 'bandpass', from: 4200, to: 2600, gain: 0.6, decay: 0.035, dest: hot });
      const whine = c.createOscillator();
      whine.type = 'sawtooth';
      const f0 = 1800 + Math.random() * 1600;
      for (let k = 0; k <= 14; k += 1) whine.frequency.setValueAtTime(f0 * (0.75 + Math.random() * 0.6) * (1 - (0.35 * k) / 14), t + (k * length) / 14);
      const hp = c.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 1200;
      const env = c.createGain();
      env.gain.setValueAtTime(0.0001, t);
      env.gain.exponentialRampToValueAtTime(0.32, t + 0.004);
      env.gain.exponentialRampToValueAtTime(0.0001, t + length);
      whine.connect(hp).connect(env).connect(hot);
      whine.start(t);
      whine.stop(t + length + 0.02);
      tone(g, t, { type: 'sawtooth', from: 160 + Math.random() * 60, to: 90, gain: 0.18, decay: 0.08, dest: hot });
    }),
    // треск, пока горят дуги: россыпь сухих щелчков и пара коротких взвизгов
    crackle: safe((g, position, seconds = 0.4) => {
      const c = g.context;
      if (!voice(c, seconds)) return;
      const t = c.currentTime;
      const dest = out(g, position, 0.38, 1.2);
      const n = 8 + Math.floor(Math.random() * 7);
      for (let i = 0; i < n; i += 1) {
        const f = 3000 + Math.random() * 6000;
        noise(g, t + Math.random() * seconds, { seconds: 0.02, type: 'bandpass', from: f, to: f * 0.7, gain: 0.25 + Math.random() * 0.6, decay: 0.004 + Math.random() * 0.01, dest });
      }
      for (let i = 0; i < 2; i += 1) {
        tone(g, t + Math.random() * seconds * 0.8, { type: 'square', from: 2500 + Math.random() * 2500, to: 1500 + Math.random() * 1000, gain: 0.05, decay: 0.03, send: 0.05, dest });
      }
    }),
    // Смерть: электрический вой съезжает вниз и «захлёбывается» (амплитуду рвёт всё более редкий
    // меандр), искрит; в конце глухой удар корпуса о землю
    powerDown: safe((g, position) => {
      const c = g.context;
      if (!voice(c, 1.5)) return;
      const t = c.currentTime;
      const dest = out(g, position, 0.65);
      const hot = c.createWaveShaper();
      hot.curve = driveCurve();
      const bp = c.createBiquadFilter();
      bp.type = 'bandpass';
      bp.Q.value = 2;
      bp.frequency.setValueAtTime(2600, t);
      bp.frequency.exponentialRampToValueAtTime(180, t + 1.3);
      const sputter = c.createGain();
      sputter.gain.value = 0.5;
      const lfo = c.createOscillator();
      lfo.type = 'square';
      lfo.frequency.setValueAtTime(45, t);
      lfo.frequency.exponentialRampToValueAtTime(5, t + 1.3);
      const depth = c.createGain();
      depth.gain.value = 0.5;
      lfo.connect(depth).connect(sputter.gain);
      const env = c.createGain();
      env.gain.setValueAtTime(0.0001, t);
      env.gain.exponentialRampToValueAtTime(0.4, t + 0.02);
      env.gain.setValueAtTime(0.4, t + 0.5);
      env.gain.exponentialRampToValueAtTime(0.0001, t + 1.35);
      for (const [type, from, to] of [['sawtooth', 1500, 55], ['square', 760, 30]]) {
        const osc = c.createOscillator();
        osc.type = type;
        osc.frequency.setValueAtTime(from, t);
        osc.frequency.exponentialRampToValueAtTime(to, t + 1.3);
        osc.connect(hot);
        osc.start(t);
        osc.stop(t + 1.4);
      }
      hot.connect(bp).connect(sputter).connect(env).connect(dest);
      const wet = c.createGain();
      wet.gain.value = 0.25;
      env.connect(wet).connect(g.reverbSend);
      lfo.start(t);
      lfo.stop(t + 1.4);
      for (let i = 0; i < 10; i += 1) {
        const f = 2500 + Math.random() * 5000;
        noise(g, t + Math.random() * 1.1, { seconds: 0.03, type: 'bandpass', from: f, to: f * 0.6, gain: 0.25 + Math.random() * 0.45, decay: 0.006 + Math.random() * 0.02, dest });
      }
      tone(g, t + 0.9, { from: 140, to: 45, gain: 0.45, decay: 0.2, send: 0.2, dest });
    }),
    // Пуля по корпусу: полый металлический «бдзынь» — как звон мишени, но ниже, короче и глуше
    clank: safe((g, position) => {
      const c = g.context;
      if (!voice(c, 0.2)) return;
      const t = c.currentTime;
      const dest = out(g, position, 0.55);
      const base = 430 + Math.random() * 120;
      for (const [ratio, gain, decay] of [[1, 0.3, 0.16], [1.47, 0.22, 0.11], [2.09, 0.14, 0.08], [2.76, 0.08, 0.05]]) {
        tone(g, t, { type: 'triangle', from: base * ratio * (1 + (Math.random() - 0.5) * 0.02), gain, decay, send: 0.25, dest });
      }
      noise(g, t, { seconds: 0.05, type: 'bandpass', from: 1400, to: 400, gain: 0.6, decay: 0.035, dest });
      tone(g, t, { from: 190, to: 95, gain: 0.35, decay: 0.07, dest });
    }),
    // Пёс врезался в игрока: тяжёлый глухой удар у головы с металлическим отзвуком
    thud: safe((g, position) => {
      const c = g.context;
      const t = c.currentTime;
      const dest = out(g, position, 0.9, 1);
      tone(g, t, { from: 120, to: 42, gain: 1, decay: 0.28, send: 0.2, dest });
      noise(g, t, { seconds: 0.2, type: 'lowpass', from: 1200, to: 150, gain: 0.8, decay: 0.12, send: 0.2, dest });
      tone(g, t, { type: 'triangle', from: 380, to: 340, gain: 0.12, decay: 0.15, send: 0.3, dest });
    }),
    // Шаг на бегу: тихий короткий «вжик» сервопривода (выше на скорости)
    servo: safe((g, position, speed = 1) => {
      const c = g.context;
      if (!voice(c, 0.1)) return;
      const t = c.currentTime;
      const dest = out(g, position, 0.12, 1);
      const f = 520 + Math.min(4, speed) * 90 + Math.random() * 60;
      const bp = c.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = f * 2;
      bp.Q.value = 3;
      bp.connect(dest);
      tone(g, t, { type: 'sawtooth', from: f, to: f * 1.35, gain: 0.5, decay: 0.07, send: 0.05, dest: bp });
      noise(g, t + 0.06, { seconds: 0.02, type: 'highpass', from: 4000, to: 3000, gain: 0.15, decay: 0.006, send: 0.02, dest });
    }),
  };
}
