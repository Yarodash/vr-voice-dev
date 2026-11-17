// Звуки квадрокоптеров (drones.js). Тот же звуковой граф, что у всей сцены:
// __sceneState.audioGraph = { context, master, reverbSend } (его создаёт sound.js).
//
// ПРАВИЛО (docs/agents/effects-and-sound.md): ничего не строится на звук. Все звуки один раз
// считаются прямо в JS в AudioBuffer (без узлов) и лежат в __sceneState.droneSoundBank; очередь
// пулемёта — заранее сведённая очередь из 3/4/5 выстрелов (один звук = один голос). Голоса —
// постоянные цепочки (усиление → HRTF → master, посыл в реверб) в __sceneState.droneVoices:
// SHOTS разовых (на звук создаётся только BufferSource; нет свободного — самый старый гаснет за
// 20 мс) и LOOPS постоянных петель гула винтов (зацикленный буфер запускается один раз и звучит
// всегда; гул отдаётся LOOPS ближайшим коптерам, у остальных его нет: меняются только позиция,
// громкость и скорость воспроизведения).
//
// createDroneSound(shared) → { burst(p, rounds, size), clank(p, size), boom(p, size), pop(p, size),
//   update(head, drones, dt), stats() } — p: мировая точка, size: 0 маленький … 3 огромный.
const BAKE_VERSION = 1;
const POOL_VERSION = 1;
const SHOTS = 8;
const LOOPS = 4;
const GAP = 0.075; // с между выстрелами очереди (тот же GAP — в drones.js)
export const BURST_GAP = GAP;

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

// ---- рецепты: (d — пустой Float32Array, sr) → заполнить
// один выстрел с t0: щелчок (белый шум с дифференцированием), «тело» (низкочастотный шум), удар
// (синус 120→55 Гц), лязг затвора, короткий хвост
const round = (d, sr, t0, g = 1) => {
  const s0 = Math.floor(t0 * sr);
  let lp = 0;
  let prev = 0;
  let ph = 0;
  let tail = 0;
  const n = Math.min(d.length - s0, Math.floor(0.3 * sr));
  for (let i = 0; i < n; i += 1) {
    const t = i / sr;
    const w = Math.random() * 2 - 1;
    const crack = (w - prev) * Math.exp(-t / 0.005);
    prev = w;
    lp += 0.18 * (w - lp);
    tail += 0.04 * (w - tail);
    const f = 55 + 65 * Math.exp(-t / 0.02);
    ph += (2 * Math.PI * f) / sr;
    const thump = Math.sin(ph) * Math.exp(-t / 0.035);
    const body = lp * Math.exp(-t / 0.03);
    const tl = tail * Math.exp(-t / 0.09) * 2.2;
    let clack = 0;
    if (t > 0.034 && t < 0.05) clack = (Math.random() * 2 - 1) * Math.exp(-(t - 0.034) / 0.003) * 0.3;
    d[s0 + i] += g * (crack * 0.9 + body * 1.4 + thump * 0.8 + tl * 0.5 + clack);
  }
};
const burstRecipe = (rounds) => ({
  variants: 2,
  seconds: rounds * GAP + 0.35,
  render(d, sr) {
    for (let k = 0; k < rounds; k += 1) round(d, sr, k * GAP + rnd(0, 0.004), rnd(0.85, 1));
    fadeTail(d, sr);
    normalize(d, 0.9);
  },
});
const PLATE = [1, 1.47, 1.82, 2.36, 2.63, 3.17, 3.55];
const RECIPES = {
  burst3: burstRecipe(3),
  burst4: burstRecipe(4),
  burst5: burstRecipe(5),
  // пуля по корпусу: тонкий металл/пластик — короткий «тик» и звон пластины
  clank: { variants: 4, seconds: 0.35, render(d, sr) {
    const f0 = rnd(900, 1700);
    for (const r of PLATE) {
      const f = f0 * r * rnd(0.98, 1.02);
      const a = rnd(0.5, 1) / Math.sqrt(r);
      const tau = 0.07 / r ** 0.7;
      let ph = 0;
      for (let i = 0; i < d.length; i += 1) {
        const t = i / sr;
        d[i] += a * Math.sin(ph) * Math.exp(-t / tau);
        ph += (2 * Math.PI * f) / sr;
      }
    }
    let prev = 0;
    for (let i = 0; i < Math.floor(0.012 * sr); i += 1) {
      const w = Math.random() * 2 - 1;
      d[i] += (w - prev) * 1.5 * Math.exp(-i / (0.003 * sr));
      prev = w;
    }
    fadeTail(d, sr);
    normalize(d, 0.9);
  } },
  // взрыв: щелчок, «бум» низкочастотного шума с убывающей полосой, суббас 55→28 Гц, треск обломков
  boom: { variants: 3, seconds: 2.2, render(d, sr) {
    let lp = 0;
    let lp2 = 0;
    let ph = 0;
    for (let i = 0; i < d.length; i += 1) {
      const t = i / sr;
      const w = Math.random() * 2 - 1;
      const a = 0.02 + 0.33 * Math.exp(-t / 0.12);
      lp += a * (w - lp);
      lp2 += a * (lp - lp2);
      const env = Math.min(1, t / 0.004) * Math.exp(-t / 0.5);
      const f = 28 + 30 * Math.exp(-t / 0.25);
      ph += (2 * Math.PI * f) / sr;
      d[i] += w * Math.exp(-t / 0.008) * 0.8 + lp2 * env * 5 + Math.sin(ph) * Math.exp(-t / 0.6) * 0.8;
      if (t > 0.08 && t < 1.4 && Math.random() < 0.0009) {
        // обломки: редкие щелчки
        const k = Math.exp(-t / 0.5) * rnd(0.2, 0.6);
        for (let j = 0; j < 60 && i + j < d.length; j += 1) d[i + j] += (Math.random() * 2 - 1) * k * Math.exp(-j / 12);
      }
    }
    fadeTail(d, sr, 0.1);
    normalize(d, 0.95);
  } },
  // подбит: электрический треск, хлопок и гаснущий вой моторов (1400 → 180 Гц)
  pop: { variants: 3, seconds: 0.9, render(d, sr) {
    let ph = 0;
    let prev = 0;
    for (let i = 0; i < d.length; i += 1) {
      const t = i / sr;
      const w = Math.random() * 2 - 1;
      const f = 180 + 1300 * Math.exp(-t / 0.22);
      ph += (2 * Math.PI * f) / sr;
      let x = Math.sin(ph) * 0.35 * Math.exp(-t / 0.35) + Math.sign(Math.sin(ph * 0.5)) * 0.08 * Math.exp(-t / 0.3);
      x += (w - prev) * Math.exp(-t / 0.015) * 0.9;
      if (t < 0.3 && Math.random() < 0.004) x += rnd(-1, 1) * 0.8;
      prev = w;
      d[i] += x;
    }
    fadeTail(d, sr);
    normalize(d, 0.85);
  } },
  // гул винтов: петля ровно 1 с — все частоты целые (Гц), шум отфильтрован по кругу → без щелчка на
  // стыке. Четыре мотора чуть вразнобой (96/99/101/104 Гц) — живые биения; гармоники лопастей.
  hum: { variants: 1, seconds: 1, loop: true, render(d, sr) {
    const n = d.length;
    for (const f of [96, 99, 101, 104]) {
      for (let h = 1; h <= 7; h += 1) {
        const a = 0.5 / h ** 1.15;
        const ph0 = Math.random() * Math.PI * 2;
        const w = (2 * Math.PI * f * h) / sr;
        // поворот вектора вместо Math.sin на каждый отсчёт (в разы дешевле)
        const cw = Math.cos(w);
        const sw = Math.sin(w);
        let x = Math.cos(ph0);
        let y = Math.sin(ph0);
        for (let i = 0; i < n; i += 1) {
          d[i] += a * y;
          const nx = x * cw - y * sw;
          y = x * sw + y * cw;
          x = nx;
        }
      }
    }
    // шум воздуха: низкочастотный, по кругу (второй проход начинается с состояния конца первого),
    // промодулирован лопастями
    const x = new Float32Array(n);
    for (let i = 0; i < n; i += 1) x[i] = Math.random() * 2 - 1;
    let y = 0;
    for (let pass = 0; pass < 2; pass += 1) {
      for (let i = 0; i < n; i += 1) {
        y += 0.08 * (x[i] - y);
        if (pass) d[i] += y * 2.2 * (1 + 0.45 * Math.sin((2 * Math.PI * 200 * i) / sr));
      }
    }
    normalize(d, 0.8);
  } },
};

// Запечь все рецепты (один раз на страницу; ключ — версия и частота). По одному варианту за задачу
// (setTimeout) — работа размазана по кадрам.
const bake = (shared, c) => {
  const sampleRate = c.sampleRate;
  const key = `${BAKE_VERSION}|${sampleRate}`;
  if (shared.droneSoundBank?.key === key) return shared.droneSoundBank;
  const bank = (shared.droneSoundBank = { key, buffers: {} });
  const jobs = [];
  for (const [name, recipe] of Object.entries(RECIPES)) {
    bank.buffers[name] = [];
    for (let v = 0; v < recipe.variants; v += 1) jobs.push([name, recipe]);
  }
  // сначала гул и по одному варианту каждого
  jobs.sort((a, b) => (a[0] === 'hum' ? -1 : b[0] === 'hum' ? 1 : 0));
  const step = () => {
    if (shared.droneSoundBank !== bank || !jobs.length) return;
    const [name, recipe] = jobs.shift();
    try {
      const buffer = c.createBuffer(1, Math.ceil(recipe.seconds * sampleRate), sampleRate);
      recipe.render(buffer.getChannelData(0), sampleRate);
      bank.buffers[name].push(buffer);
    } catch (e) {
      console.warn('[drone-sound] не запёкся', name, e?.message ?? e);
    }
    setTimeout(step, 16);
  };
  setTimeout(step, 0);
  return bank;
};

// Постоянные голоса. Пересобираются, только если поменялся выход (sound.js пересобрал шину) или
// POOL_VERSION.
const voicesFor = (shared, g) => {
  const pool = shared.droneVoices;
  if (pool?.version === POOL_VERSION && pool.master === g.master && pool.context === g.context) return pool;
  for (const v of [...(pool?.shots ?? []), ...(pool?.loops ?? [])]) {
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
    panner.maxDistance = 400;
    input.connect(panner).connect(g.master);
    if (g.reverbSend) {
      const send = c.createGain();
      send.gain.value = sendGain;
      input.connect(send).connect(g.reverbSend);
    }
    return { input, panner, source: null, endAt: 0, startedAt: 0, owner: null };
  };
  const shots = [];
  for (let i = 0; i < SHOTS; i += 1) shots.push(chain(3, 0.7, 0.2));
  const loops = [];
  for (let i = 0; i < LOOPS; i += 1) loops.push(chain(2, 1, 0.05));
  return (shared.droneVoices = { version: POOL_VERSION, master: g.master, context: c, shots, loops });
};

// по размеру (0 маленький … 3 огромный)
const SHOT_GAIN = [0.5, 0.65, 0.85, 1];
const SHOT_RATE = [1.3, 1.08, 0.85, 0.68];
const HUM_GAIN = [0.16, 0.22, 0.34, 0.55];
const HUM_RATE = [2.1, 1.45, 0.8, 0.42];
const HUM_REF = [1.2, 2.2, 5, 12];

export function createDroneSound(shared) {
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
  const setPos = (p, x, y, z, at) => {
    if (p.positionX) {
      p.positionX.setValueAtTime(x, at);
      p.positionY.setValueAtTime(y, at);
      p.positionZ.setValueAtTime(z, at);
    } else p.setPosition(x, y, z);
  };

  const play = (name, position, gain, rate = 1) => {
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
      voice.input.gain.setValueAtTime(Math.min(2, Math.max(0, gain)), at);
      setPos(voice.panner, position.x, position.y, position.z, at);
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

  // гул: раз в PICK_S с — LOOPS ближайших коптеров (живых и падающих); в кадре — позиции
  const PICK_S = 0.25;
  let pickLeft = 0;
  const best = new Array(LOOPS).fill(null);
  const bestD = new Float64Array(LOOPS);
  const humStep = (head, drones, dt) => {
    const g = shared.audioGraph;
    const c = g?.context;
    if (!c || !bank?.buffers.hum?.length) return;
    const pool = voicesFor(shared, g);
    const t = c.currentTime;
    // петли запускаются один раз и звучат всегда (без коптера — с нулевой громкостью)
    for (const v of pool.loops) {
      if (v.source) continue;
      const s = c.createBufferSource();
      s.buffer = bank.buffers.hum[0];
      s.loop = true;
      s.connect(v.input);
      s.start(t + Math.random() * 0.5);
      v.source = s;
    }
    pickLeft -= dt;
    if (pickLeft <= 0) {
      pickLeft = PICK_S;
      for (let k = 0; k < LOOPS; k += 1) {
        best[k] = null;
        bestD[k] = Infinity;
      }
      for (let i = 0; i < drones.length; i += 1) {
        const d = drones[i];
        if (d.state !== 'alive' && d.state !== 'dying') continue;
        // громкий огромный слышен дальше: расстояние делится на опорное
        const dist = Math.hypot(d.x - head.x, d.y - head.y, d.z - head.z) / HUM_REF[d.size];
        let k = LOOPS - 1;
        if (dist >= bestD[k]) continue;
        while (k > 0 && bestD[k - 1] > dist) {
          bestD[k] = bestD[k - 1];
          best[k] = best[k - 1];
          k -= 1;
        }
        bestD[k] = dist;
        best[k] = d;
      }
      // кто остался в наборе — держит свой голос; освободившиеся голоса — новым
      for (const v of pool.loops) if (v.owner && !best.includes(v.owner)) {
        v.owner = null;
        v.input.gain.setTargetAtTime(0, t, 0.08);
      }
      for (let k = 0; k < LOOPS; k += 1) {
        const d = best[k];
        if (!d || pool.loops.some((v) => v.owner === d)) continue;
        const v = pool.loops.find((l) => !l.owner);
        if (!v) break;
        v.owner = d;
        v.panner.refDistance = HUM_REF[d.size];
        setPos(v.panner, d.x, d.y, d.z, t);
        v.input.gain.setTargetAtTime(HUM_GAIN[d.size], t, 0.15);
      }
    }
    for (const v of pool.loops) {
      const d = v.owner;
      if (!d) continue;
      if (d.state !== 'alive' && d.state !== 'dying') {
        v.owner = null;
        v.input.gain.setTargetAtTime(0, t, 0.05);
        continue;
      }
      if (v.panner.positionX) {
        v.panner.positionX.value = d.x;
        v.panner.positionY.value = d.y;
        v.panner.positionZ.value = d.z;
      } else v.panner.setPosition(d.x, d.y, d.z);
      // разгон — выше; падает — моторы воют и сходят на нет
      const sp = Math.min(1, Math.hypot(d.vx, d.vy, d.vz) / 15);
      const rate = HUM_RATE[d.size] * (d.state === 'dying' ? Math.max(0.35, 1.25 - d.t * 0.5) : 1 + 0.12 * sp + d.humJit);
      if (ok(rate)) v.source.playbackRate.value = rate;
    }
  };

  // запечь сразу, если контекст уже есть
  try {
    ready();
  } catch {
    // позже
  }

  const jit = (a) => 1 + (Math.random() - 0.5) * a;
  return {
    // очередь пулемёта (rounds 3–5): один голос на всю очередь
    burst: (p, rounds, size) => play(`burst${Math.max(3, Math.min(5, rounds))}`, p, SHOT_GAIN[size] * 0.9, SHOT_RATE[size] * jit(0.08)),
    clank: (p, size) => play('clank', p, 0.55 + 0.1 * size, (1.2 - 0.15 * size) * jit(0.2)),
    boom: (p, size) => play('boom', p, 0.7 + 0.25 * size, (1.25 - 0.17 * size) * jit(0.08)),
    pop: (p, size) => play('pop', p, 0.6 + 0.1 * size, (1.2 - 0.15 * size) * jit(0.1)),
    update(head, drones, dt) {
      try {
        humStep(head, drones, dt);
      } catch {
        // звук не важнее игры
      }
    },
    // с ПК: npm run vr:eval -- "__sceneState.drones.debug.sound()"
    stats: () => ({
      baked: bank ? Object.fromEntries(Object.entries(bank.buffers).map(([k, v]) => [k, v.length])) : null,
      played,
      loops: shared.droneVoices?.loops.map((v) => (v.owner ? `${v.owner.size}@${Math.round(v.owner.x)},${Math.round(v.owner.z)}` : '-')),
    }),
  };
}
