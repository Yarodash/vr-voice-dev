// Стая робопсов: рог/гул перед большой волной. Отдельный маленький модуль (robodog-sound.js ведёт
// другой агент), но по тому же правилу (docs/agents/effects-and-sound.md): звук запекается один раз
// в AudioBuffer (OfflineAudioContext, кэш __sceneState.dogHornBank), играет через один постоянный
// голос (усиление → панорама → master, __sceneState.dogHornVoice); на звук — только BufferSource.
//
// createHorn(shared) → { play(position, pitch = 1, gain = 1) }
const BAKE_KEY = 'horn-1';
const SECONDS = 2.4;

// низкий «боевой рог» из трёх пил через фильтр, медленная атака, гул земли снизу
const render = (c, out) => {
  const lp = c.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.setValueAtTime(380, 0);
  lp.frequency.linearRampToValueAtTime(900, 0.6);
  lp.frequency.linearRampToValueAtTime(420, SECONDS);
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, 0);
  g.gain.exponentialRampToValueAtTime(0.5, 0.35);
  g.gain.setValueAtTime(0.5, 1.5);
  g.gain.exponentialRampToValueAtTime(0.0001, SECONDS - 0.05);
  lp.connect(g).connect(out);
  for (const [f, k] of [[73, 1], [110, 0.8], [146.5, 0.45]]) {
    const o = c.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(f * 0.97, 0);
    o.frequency.linearRampToValueAtTime(f, 0.4);
    const og = c.createGain();
    og.gain.value = 0.3 * k;
    o.connect(og).connect(lp);
    o.start(0);
    o.stop(SECONDS);
  }
  // гул: низкий шум
  const n = c.createBuffer(1, Math.floor(c.sampleRate * SECONDS), c.sampleRate);
  const d = n.getChannelData(0);
  for (let i = 0; i < d.length; i += 1) d[i] = Math.random() * 2 - 1;
  const s = c.createBufferSource();
  s.buffer = n;
  const nf = c.createBiquadFilter();
  nf.type = 'lowpass';
  nf.frequency.value = 120;
  const ng = c.createGain();
  ng.gain.setValueAtTime(0.0001, 0);
  ng.gain.exponentialRampToValueAtTime(0.6, 0.5);
  ng.gain.exponentialRampToValueAtTime(0.0001, SECONDS - 0.05);
  s.connect(nf).connect(ng).connect(out);
  s.start(0);
};

export function createHorn(shared) {
  const bake = (rate) => {
    const key = `${BAKE_KEY}|${rate}`;
    if (shared.dogHornBank?.key === key) return shared.dogHornBank;
    const bank = (shared.dogHornBank = { key, buffer: null });
    if (typeof OfflineAudioContext === 'undefined') return bank;
    try {
      const c = new OfflineAudioContext(1, Math.ceil(SECONDS * rate), rate);
      const out = c.createGain();
      out.connect(c.destination);
      render(c, out);
      c.startRendering().then((b) => (bank.buffer = b)).catch(() => {});
    } catch {
      // без рога
    }
    return bank;
  };
  const voice = (g) => {
    const v = shared.dogHornVoice;
    if (v && v.master === g.master && v.context === g.context) return v;
    const c = g.context;
    const input = c.createGain();
    const panner = c.createPanner();
    panner.panningModel = 'equalpower';
    panner.distanceModel = 'inverse';
    panner.refDistance = 40;
    panner.rolloffFactor = 0.6;
    input.connect(panner).connect(g.master);
    return (shared.dogHornVoice = { master: g.master, context: c, input, panner, source: null });
  };
  try {
    if (shared.audioGraph?.context) bake(shared.audioGraph.context.sampleRate);
  } catch {
    // позже
  }
  return {
    play(position, pitch = 1, gain = 1) {
      try {
        const g = shared.audioGraph;
        const c = g?.context;
        if (!c || !position || !Number.isFinite(position.x) || !Number.isFinite(position.z)) return;
        const bank = bake(c.sampleRate);
        if (!bank.buffer) return; // ещё запекается
        const v = voice(g);
        const t = c.currentTime;
        try {
          v.source?.stop(t);
        } catch {
          // уже кончился
        }
        v.input.gain.setValueAtTime(Math.min(2, gain), t);
        if (v.panner.positionX) {
          v.panner.positionX.setValueAtTime(position.x, t);
          v.panner.positionY.setValueAtTime(position.y, t);
          v.panner.positionZ.setValueAtTime(position.z, t);
        } else v.panner.setPosition(position.x, position.y, position.z);
        const s = c.createBufferSource();
        s.buffer = bank.buffer;
        s.playbackRate.value = pitch;
        s.connect(v.input);
        s.onended = () => {
          s.disconnect();
          if (v.source === s) v.source = null;
        };
        s.start(t);
        v.source = s;
      } catch {
        // звук не важнее игры
      }
    },
  };
}
