// Звуки выстрела и попадания. Выстрелы — записи настоящего оружия (web/public/sounds/guns, CC0, см. LICENSE.txt),
// пока они не загрузились — синтез на лету (WebAudio). Попадание в металл — синтез.
// Живёт в сцене: правки подхватываются на лету.
//
// Объект звука живёт в globalThis.__sceneState.sound (его создаёт shooting.js один раз). Когда этот
// файл меняется так, что нужен новый объект, увеличь SOUND_VERSION: main.js тогда пересоздаёт его,
// а сам звуковой контекст (их число в странице ограничено) берётся прежний — __sceneState.audioGraph.
export const SOUND_VERSION = 15;
// какие записи звучат в игре (sound-board.js помечает их «в игре»)
export const GUN_FILES = { pistol: ['pistolB1', 'pistolB2'], ak: ['ak1', 'ak2', 'ak3'] };

export function createSound() {
  const shared = (globalThis.__sceneState ??= {});
  let { context = null, master = null, reverbSend = null } = shared.audioGraph ?? {};
  let weapon = 'pistol'; // каким оружием звучит shot() без параметров (см. setWeapon)

  const ensure = () => {
    if (context) {
      if (context.state === 'suspended') context.resume();
      return context;
    }
    context = new AudioContext();
    master = context.createGain();
    master.gain.value = 0.85;
    // компрессор не даёт выстрелу «хрипеть» на пике
    const compressor = context.createDynamicsCompressor();
    compressor.threshold.value = -6; // выше порога: выстрел не сжимается в кашу, звон попадания не громче его
    compressor.ratio.value = 4;
    master.connect(compressor).connect(context.destination);
    // эхо помещения: свёртка с затухающим шумом
    const convolver = context.createConvolver();
    const length = Math.floor(context.sampleRate * 1.5);
    const impulse = context.createBuffer(2, length, context.sampleRate);
    for (let channel = 0; channel < 2; channel += 1) {
      const data = impulse.getChannelData(channel);
      for (let i = 0; i < length; i += 1) data[i] = (Math.random() * 2 - 1) * (1 - i / length) ** 3.2;
    }
    convolver.buffer = impulse;
    reverbSend = context.createGain();
    reverbSend.gain.value = 0.5;
    reverbSend.connect(convolver).connect(master);
    shared.audioGraph = { context, master, reverbSend };
    loadSamples(context);
    return context;
  };

  // Записи выстрелов грузятся один раз и живут в __sceneState.gunSamples (подмена сцены их не перезагружает).
  // pistolB: только дубль A_34P (яркий, с эхом по полю); дубль A_42P был глухим и звучал по-другому
  const MAX_VOICES = 6;
  const voices = [];
  const loadSamples = (c) => {
    // кэш привязан к списку файлов: после смены набора записей новый подгружается без перезагрузки страницы
    const key = JSON.stringify(GUN_FILES);
    if (shared.gunSamples?.key === key) return;
    const samples = (shared.gunSamples = { key, pistol: [], ak: [] });
    for (const [kind, names] of Object.entries(GUN_FILES)) {
      for (const name of names) {
        fetch(`/sounds/guns/${name}.ogg`)
          .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(r.status))))
          .then((data) => c.decodeAudioData(data))
          .then((buffer) => samples[kind].push(buffer))
          .catch((e) => console.warn('[sound] не загрузился', name, e?.message ?? e));
      }
    }
  };
  // Записи грузятся сразу, при создании звука, а не на первом выстреле: иначе первый выстрел после
  // загрузки страницы звучал запасным синтезатором (записи ещё декодировались). AudioContext без
  // жеста пользователя создаётся приостановленным — декодировать это не мешает; запустится на выстреле.
  try {
    ensure();
    loadSamples(context);
  } catch (e) {
    console.warn('[sound] предзагрузка не удалась', e?.message ?? e);
  }

  // 3D: PannerNode (HRTF, inverse) в точке position (THREE.Vector3 / {x,y,z}) → master. Без position —
  // обычный master (звук у слушателя). Реверб остаётся неспатиальным: он берёт сигнал до паннера.
  const makePanner = (c, position, refDistance = 1.5) => {
    if (!position) return master;
    const p = c.createPanner();
    p.panningModel = 'HRTF';
    p.distanceModel = 'inverse';
    p.refDistance = refDistance;
    p.rolloffFactor = 0.5; // на 38 м ≈ -22 дБ
    p.maxDistance = 200;
    p.coneInnerAngle = 360;
    const t = c.currentTime;
    if (p.positionX) {
      p.positionX.setValueAtTime(position.x, t);
      p.positionY.setValueAtTime(position.y, t);
      p.positionZ.setValueAtTime(position.z, t);
    } else p.setPosition(position.x, position.y, position.z);
    p.connect(master);
    return p;
  };

  // Проигрывает случайную запись: чуть другая высота и громкость, не больше MAX_VOICES голосов сразу.
  const playSample = (c, kind, dest = master) => {
    const list = shared.gunSamples?.[kind];
    if (!list?.length) return false;
    const t = c.currentTime;
    while (voices.length >= MAX_VOICES) {
      const old = voices.shift();
      try {
        old.gain.gain.cancelScheduledValues(t);
        old.gain.gain.setValueAtTime(old.gain.gain.value, t);
        old.gain.gain.linearRampToValueAtTime(0, t + 0.03);
        old.source.stop(t + 0.04);
      } catch {
        // уже закончился
      }
    }
    const source = c.createBufferSource();
    source.buffer = list[Math.floor(Math.random() * list.length)];
    source.playbackRate.value = 1 + (Math.random() - 0.5) * 0.06; // ±3%
    const gain = c.createGain();
    // пистолет громче и звонче: запись глуховата и терялась на фоне звона попадания
    gain.gain.value = (kind === 'ak' ? 1 : 1.7) * (0.88 + Math.random() * 0.24);
    if (kind === 'ak') {
      source.connect(gain).connect(dest);
    } else {
      const bright = c.createBiquadFilter();
      bright.type = 'highshelf';
      bright.frequency.value = 2500;
      bright.gain.value = 3; // записи 1911 уже звонкие, добавка лишь чуть добавляет хруста
      source.connect(bright).connect(gain).connect(dest);
    }
    if (kind !== 'ak') {
      // «хлёсткость»: короткий яркий треск и тонкий металлический звон поверх записи
      noise(c, t, { seconds: 0.05, type: 'highpass', from: 4500, to: 2500, gain: 0.5, decay: 0.03, send: 0.1, dest });
      tone(c, t, { type: 'triangle', from: 2350, gain: 0.07, decay: 0.16, send: 0.5, dest });
      tone(c, t, { type: 'sine', from: 3720, gain: 0.04, decay: 0.12, send: 0.5, dest });
    }
    const wet = c.createGain();
    wet.gain.value = kind === 'ak' ? 0.22 : 0.24; // эхо по полю чуть гуще
    gain.connect(wet).connect(reverbSend);
    const voice = { source, gain };
    voices.push(voice);
    source.onended = () => {
      const i = voices.indexOf(voice);
      if (i >= 0) voices.splice(i, 1);
    };
    source.start(t);
    return true;
  };

  // Буферы шума готовятся один раз на длину (очередь из автомата — 10 выстрелов в секунду).
  const noiseBuffers = new Map();
  const noiseBuffer = (c, seconds) => {
    const cached = noiseBuffers.get(seconds);
    if (cached) return cached;
    const buffer = c.createBuffer(1, Math.floor(c.sampleRate * seconds), c.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i += 1) data[i] = Math.random() * 2 - 1;
    noiseBuffers.set(seconds, buffer);
    return buffer;
  };

  // шумовая вспышка через фильтр: type 'highpass' | 'lowpass' | 'bandpass', частота плавно меняется
  const noise = (c, t, { seconds, type, from, to, gain, decay, send = 0.3, dest = master }) => {
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
    source.connect(filter).connect(envelope);
    envelope.connect(dest);
    const wet = c.createGain();
    wet.gain.value = send;
    envelope.connect(wet).connect(reverbSend);
    source.start(t);
    source.stop(t + seconds);
  };

  const tone = (c, t, { type = 'sine', from, to = from, gain, decay, send = 0.2, dest = master }) => {
    const osc = c.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(from, t);
    if (to !== from) osc.frequency.exponentialRampToValueAtTime(to, t + decay);
    const envelope = c.createGain();
    envelope.gain.setValueAtTime(0.0001, t);
    envelope.gain.exponentialRampToValueAtTime(gain, t + 0.002);
    envelope.gain.exponentialRampToValueAtTime(0.0001, t + decay);
    osc.connect(envelope);
    envelope.connect(dest);
    const wet = c.createGain();
    wet.gain.value = send;
    envelope.connect(wet).connect(reverbSend);
    osc.start(t);
    osc.stop(t + decay + 0.02);
  };

  // Прослушка записи для звуковой доски (sound-board.js): сырой файл без обработки, у слушателя,
  // через тот же master, что и выстрелы. Одна за раз. Промис: длительность по окончании, null — перебили.
  let preview = null;
  let previewToken = null;
  const previewFile = (name) => {
    const c = ensure();
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
      source.connect(master);
      preview = source;
      return new Promise((resolve) => {
        source.onended = () => {
          if (preview === source) preview = null;
          resolve(previewToken === token ? buffer.duration : null);
        };
        source.start();
      });
    });
  };

  return {
    version: SOUND_VERSION,
    previewFile,
    // Слушатель = голова: вызывать каждый кадр. Позиция и ориентация — AudioParam, сглаживание 20 мс
    // (без «ступенек» при повороте головы).
    update(camera) {
      if (!context || !camera) return;
      try {
      camera.updateWorldMatrix(true, false);
      const e = camera.matrixWorld.elements; // колонки: 0 — вправо, 1 — вверх, 2 — назад (без масштаба)
      const norm = (x, y, z) => { const n = Math.hypot(x, y, z) || 1; return [x / n, y / n, z / n]; };
      const lp = [e[12], e[13], e[14]];
      const lf = norm(-e[8], -e[9], -e[10]);
      const lu = norm(e[4], e[5], e[6]);
      const l = context.listener;
      const t = context.currentTime;
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
      weapon = kind === 'ak' ? 'ak' : 'pistol';
    },
    // Выстрел: резкий хлопок (высокий шум), плотное «тело» (шум, фильтр уходит вниз), глухой удар в
    // грудь (синус вниз по частоте) и хвост эха. { kind: 'ak' } — автомат: громче, ниже, длиннее
    // хвост, с лязгом затвора; без параметров — оружие из setWeapon (по умолчанию пистолет).
    shot({ kind = weapon, position } = {}) {
      try {
        const c = ensure();
        loadSamples(c);
        const dest = makePanner(c, position);
        if (playSample(c, kind === 'ak' ? 'ak' : 'pistol', dest)) return;
        const t = c.currentTime;
        if (kind === 'ak') {
          const jitter = 1 + (Math.random() - 0.5) * 0.08; // очередь не звучит одинаковыми щелчками
          noise(c, t, { seconds: 0.2, type: 'highpass', from: 1900 * jitter, to: 650, gain: 1, decay: 0.09, send: 0.55, dest });
          noise(c, t, { seconds: 0.6, type: 'lowpass', from: 3200 * jitter, to: 220, gain: 1, decay: 0.42, send: 0.75, dest });
          noise(c, t, { seconds: 0.3, type: 'bandpass', from: 900, to: 320, gain: 0.6, decay: 0.2, send: 0.5, dest });
          tone(c, t, { from: 125 * jitter, to: 28, gain: 1, decay: 0.32, send: 0.35, dest });
          tone(c, t + 0.003, { type: 'triangle', from: 68, to: 24, gain: 0.85, decay: 0.42, send: 0.3, dest });
          noise(c, t + 0.045, { seconds: 0.05, type: 'bandpass', from: 2600, to: 1800, gain: 0.22, decay: 0.035, send: 0.05, dest }); // затвор
          return;
        }
        noise(c, t, { seconds: 0.2, type: 'highpass', from: 2500, to: 900, gain: 1, decay: 0.07, send: 0.5, dest });
        noise(c, t, { seconds: 0.4, type: 'lowpass', from: 4200, to: 380, gain: 0.85, decay: 0.3, send: 0.6, dest });
        noise(c, t, { seconds: 0.3, type: 'bandpass', from: 1200, to: 500, gain: 0.5, decay: 0.16, send: 0.4, dest });
        tone(c, t, { from: 170, to: 38, gain: 1, decay: 0.24, send: 0.3, dest });
        tone(c, t + 0.004, { type: 'triangle', from: 90, to: 32, gain: 0.7, decay: 0.3, send: 0.2, dest });
      } catch {
        // без звука
      }
    },
    // Попадание в металл: звонкий «тинь» из нескольких негармоничных обертонов и сухой щелчок.
    hit(position) {
      try {
        const c = ensure();
        const t = c.currentTime;
        // звон тише выстрела на ~6 дБ и затухает с расстоянием (ref 1.5 м): мишень в 5 м ≈ -7 дБ ещё
        const dest = c.createGain();
        dest.gain.value = 0.5;
        dest.connect(makePanner(c, position, 1.5));
        const base = 1050 + Math.random() * 260;
        const partials = [
          [1, 0.34, 0.55],
          [1.58, 0.28, 0.4],
          [2.41, 0.2, 0.3],
          [3.27, 0.13, 0.2],
          [4.6, 0.07, 0.12],
        ];
        for (const [ratio, gain, decay] of partials) {
          tone(c, t, { from: base * ratio * (1 + (Math.random() - 0.5) * 0.01), gain, decay, send: 0.35, dest });
        }
        noise(c, t, { seconds: 0.05, type: 'highpass', from: 5200, to: 3200, gain: 0.55, decay: 0.018, send: 0.1, dest });
        tone(c, t, { from: 380, to: 210, gain: 0.3, decay: 0.07, send: 0.1, dest }); // удар по пластине
      } catch {
        // без звука
      }
    },
    // Бьётся глиняная тарелка: сухой хруст (шум в середине частот), звонкий треск сверху, глухой
    // «тук» и россыпь коротких щелчков разлетающихся осколков.
    shatter(position) {
      try {
        const c = ensure();
        const t = c.currentTime;
        const dest = c.createGain();
        dest.gain.value = 0.75;
        dest.connect(makePanner(c, position, 1.5));
        noise(c, t, { seconds: 0.12, type: 'bandpass', from: 3200, to: 1400, gain: 0.95, decay: 0.08, send: 0.3, dest });
        noise(c, t, { seconds: 0.25, type: 'highpass', from: 7000, to: 3200, gain: 0.45, decay: 0.16, send: 0.25, dest });
        tone(c, t, { from: 460, to: 160, gain: 0.4, decay: 0.05, send: 0.1, dest });
        for (let i = 0; i < 9; i += 1) {
          const at = t + 0.004 + Math.random() * 0.12;
          tone(c, at, { type: 'triangle', from: 2400 + Math.random() * 4200, gain: 0.04 + Math.random() * 0.08, decay: 0.015 + Math.random() * 0.03, send: 0.3, dest });
          noise(c, at, { seconds: 0.02, type: 'highpass', from: 5500, to: 3800, gain: 0.12 + Math.random() * 0.2, decay: 0.01, send: 0.15, dest });
        }
      } catch {
        // без звука
      }
    },
  };
}
