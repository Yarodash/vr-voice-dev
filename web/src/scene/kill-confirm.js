// Подтверждение убийства (как в шутерах): игрок убил врага — резкий «клац» и в точке убийства
// хитмаркер-крест (четыре коротких косых штриха вокруг пустого центра), щелчком: быстро
// вырастает с лёгким перехлёстом и доворотом, держится и гаснет — всего ~0,45 с.
//
// Чьё убийство: только игрока — пули/ракеты/рельса/плазма/чёрная дыра игрока и пулемёт «Моего
// дрона» (тот стреляет через shooting.shoot). Вызывают места, где решается смерть от оружия игрока:
// robodog-horde.js hit (shootables), drones.js hit, arena-weapons.js splash, blackhole.js.
// Союзники, артиллерия, псы и коптеры между собой — не в счёт.
//   shared.killConfirm?.dog(unit)   — пёс (unit.bodyCenter; большой — unit.scale ≥ 2.5 → красный)
//   shared.killConfirm?.drone(d)    — коптер (d.x/y/z; большой — d.size ≥ 2 → красный)
//   shared.killConfirm?.at(x, y, z, big)
//
// Метка: ОДИН InstancedBufferGeometry-квад + ShaderMaterial (пул SLOTS, кольцом), повёрнут к
// камере в видовом пространстве (в XR — к каждому глазу), размер ∝ расстоянию → постоянный угол
// (~1,9°), depthTest ВКЛ, но точка сдвинута к камере на радиус жертвы + 6 % расстояния (не ближе 1,2 м):
// трава перед жертвой не прячет, а прицел, оружие и линза перекрывают; renderOrder 905. Рисуется и в
// проходе прицела (scope-lens.js): там размер — доля его поля зрения (uScope / projectionMatrix[1][1]).
// Вся анимация — в шейдере по uTime и времени старта: в кадре только uniform, атрибуты пишутся
// лишь при убийстве (addUpdateRange), instanceCount 0, когда меток нет (нет draw call).
//
// Звук: запечён один раз в JS (два варианта: обычный и большой; щелчок + второй щелчок со
// звоном — уже смешаны в один буфер), кэш __sceneState.killSoundBank. Голоса — постоянные
// gain → StereoPanner → master (звук игрока, бюджет мира не спрашивает), в __sceneState.killVoices;
// на звук создаётся только BufferSource. Мульти-килл — очередь щелчков через GAP (не каша),
// каждый следующий в серии чуть выше; больше QUEUE_MAX вперёд — не играем. Не пространственный:
// лёгкая панорама в сторону убийства, на щелчок мир коротко приглушается (audioBudget.duck).
//
// С ПК: npm run vr:eval -- "__sceneState.killConfirm.stats()"
//       npm run vr:eval -- "__sceneState.killConfirm.test(20)"  (метка+звук в 20 м перед глазами; только ПК)
import { audioBudget } from './audio-budget.js';

export const KILL_CONFIRM_VERSION = 4;
const BANK_VERSION = 2; // менять при правке рецепта звука
const SLOTS = 16; // одновременных меток убийств (ракета в толпу)
const HIT_SLOTS = 24; // серых меток попаданий (свой кусок пула: очередь из калаша не вытесняет кресты убийств)
const HIT_LIFE = 0.25; // с — серая метка попадания (совпадает с шейдером)
const TICK_GAP = 0.07; // с — тик попадания не чаще
const TICK_LEVEL = 0.2;
const LIFE = 0.46; // с, жизнь метки (совпадает с шейдером)
const HALF_ANGLE = 0.024; // полуширина квада / расстояние: кончики штрихов на ±0.68 квада → крест ~1,9°
const SCOPE_FRAC = 0.13; // в узкой камере (прицел): полуширина квада в NDC → крест ~16 % окуляра
const BIG_DOG = 2.5;
const BIG_DRONE = 2;
const GAP = 0.085; // с между щелчками серии
const QUEUE_MAX = 0.36; // с — дальше в будущее щелчки не ставим
const STREAK_S = 0.7; // с — убийства ближе этого считаются серией (каждый щелчок выше)
const VOICES = 5;
const MIN_AGE = 0.06; // с — голос моложе этого не отбираем
const LEVEL = 0.62;

const VERT = /* glsl */ `
attribute vec3 aPos;
attribute vec3 aInfo; // x — время старта (с), y — 0 убийство, 1 большое убийство, 2 попадание (серый), z — радиус жертвы (м)
uniform float uTime;
uniform float uHalf;
uniform float uScope;
varying vec2 vUv;
varying float vAlpha;
varying float vBig;
varying float vFlash;
varying float vHit;
void main() {
  float a = uTime - aInfo.x;
  vUv = position.xy;
  float hit = step(1.5, aInfo.y);
  vBig = aInfo.y > 0.5 && aInfo.y < 1.5 ? 1.0 : 0.0;
  vHit = hit;
  if (a < 0.0 || a > (hit > 0.5 ? ${HIT_LIFE.toFixed(3)} : ${LIFE.toFixed(3)})) {
    vAlpha = 0.0;
    vFlash = 0.0;
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0); // вне экрана
    return;
  }
  // щелчок: 0..55 мс 0.35 → 1.28 (ease-out), к 150 мс оседает в 1.0; после 0.27 с гаснет и чуть растёт
  float p = clamp(a / 0.055, 0.0, 1.0);
  float e = 1.0 - (1.0 - p) * (1.0 - p) * (1.0 - p);
  float s = a < 0.055 ? mix(0.35, 1.28, e) : mix(1.28, 1.0, smoothstep(0.055, 0.15, a));
  float fade = smoothstep(0.27, ${LIFE.toFixed(3)}, a);
  s *= 1.0 + 0.12 * fade;
  vAlpha = 1.0 - fade;
  vFlash = 1.0 - smoothstep(0.0, 0.07, a);
  // попадание: быстрый «чпок» 0.6 → 1 за 40 мс без перехлёста и доворота, гаснет к 0,25 с
  if (hit > 0.5) {
    float ph = clamp(a / 0.04, 0.0, 1.0);
    s = mix(0.6, 1.0, 1.0 - (1.0 - ph) * (1.0 - ph)) * 0.72;
    vAlpha = 1.0 - smoothstep(0.12, ${HIT_LIFE.toFixed(3)}, a);
    vFlash = 0.0;
    e = 1.0;
  }
  // доворот: заходит повёрнутым на 0.3 рад и защёлкивается в косой крест
  float r = 0.3 * (1.0 - e);
  float cr = cos(r);
  float sr = sin(r);
  vec2 q = vec2(cr * position.x - sr * position.y, sr * position.x + cr * position.y);
  vec4 mv = modelViewMatrix * vec4(aPos, 1.0);
  // к камере вдоль луча: на радиус жертвы + 6 % расстояния, но не ближе 1,2 м (угол не меняется)
  float dist = length(mv.xyz);
  float pulled = max(min(dist, 1.2), dist - aInfo.z - 0.06 * dist);
  mv.xyz *= pulled / max(dist, 1e-3);
  // глаз: uHalf; узкая камера прицела: доля её поля
  float ang = min(uHalf, uScope / projectionMatrix[1][1]);
  float size = max(0.3, -mv.z) * ang * s * (1.0 + 0.15 * vBig);
  mv.xy += q * size;
  gl_Position = projectionMatrix * mv;
}`;

const FRAG = /* glsl */ `
varying vec2 vUv;
varying float vAlpha;
varying float vBig;
varying float vFlash;
varying float vHit;
// четыре косых штриха вдоль диагоналей, от R0 до R1, к центру сужаются; центр пустой
float sdCross(vec2 p, float grow) {
  vec2 q = abs(vec2(p.x + p.y, p.y - p.x) * 0.70710678);
  float along = max(q.x, q.y);
  float perp = min(q.x, q.y);
  float c = clamp(along, 0.34, 0.88);
  float w = mix(0.04, 0.085, (c - 0.34) / 0.54) + grow;
  return length(vec2(along - c, perp)) - w;
}
void main() {
  if (vAlpha <= 0.0) discard;
  float d = sdCross(vUv, 0.018 * vFlash);
  float aa = fwidth(d) + 1e-4;
  float fill = 1.0 - smoothstep(-aa, aa, d);
  float rim = 1.0 - smoothstep(-aa, aa, d - 0.055); // тёмная кайма: читается на ярком небе
  vec3 col = mix(vec3(1.0), vec3(1.0, 0.16, 0.1), vBig);
  col = mix(col, vec3(1.0), 0.6 * vFlash * vBig); // красный вспыхивает белым
  col = mix(col, vec3(0.62), vHit); // попадание — серый
  vec3 rgb = mix(vec3(0.05), col, fill);
  float alpha = max(fill, rim * mix(0.55, 0.4, vHit)) * vAlpha;
  if (alpha < 0.01) discard;
  gl_FragColor = vec4(rgb, alpha);
  #include <colorspace_fragment>
}`;

// ---- звук: «клац» = короткий щелчок + тело, через ~30 мс второй щелчок с металлическим звоном
function bakeKill(sr, big) {
  const dur = big ? 0.42 : 0.32;
  const n = Math.ceil(dur * sr);
  const out = new Float32Array(n);
  let seed = big ? 911 : 377;
  const rnd = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647 - 0.5;
  };
  // щелчок: шум с высоким срезом (разность), экспонента τ
  const click = (t0, amp, tau) => {
    const i0 = Math.floor(t0 * sr);
    const len = Math.min(n - i0, Math.ceil(tau * 8 * sr));
    let prev = 0;
    for (let i = 0; i < len; i += 1) {
      const x = rnd();
      out[i0 + i] += (x - prev) * amp * Math.exp(-i / (tau * sr));
      prev = x;
    }
  };
  const tone = (t0, f, amp, tau, attack = 0.0006) => {
    const i0 = Math.floor(t0 * sr);
    const len = Math.min(n - i0, Math.ceil(tau * 7 * sr));
    const w = (2 * Math.PI * f) / sr;
    for (let i = 0; i < len; i += 1) {
      const t = i / sr;
      const env = Math.min(1, t / attack) * Math.exp(-t / tau);
      out[i0 + i] += Math.sin(w * i) * amp * env;
    }
  };
  const f0 = big ? 2350 : 3150;
  const t2 = big ? 0.04 : 0.031;
  const ring = big ? 1.35 : 1;
  // 1-й транзиент: щелчок + «тело» защёлки
  click(0, 0.9, 0.0007);
  tone(0, f0 * 0.83, 0.42, 0.0045);
  tone(0, big ? 640 : 900, 0.34, 0.011);
  if (big) tone(0, 150, 0.5, 0.03, 0.002); // тяжёлый «тук» под крупного
  // 2-й транзиент: щелчок + звон (негармонические парциалы)
  click(t2, 0.7, 0.0005);
  const parts = [1, 1.47, 2.09, 2.76];
  const amps = [0.3, 0.19, 0.13, 0.08];
  const taus = [0.09, 0.062, 0.045, 0.03];
  for (let k = 0; k < parts.length; k += 1) tone(t2, f0 * parts[k], amps[k], taus[k] * ring, 0.0008);
  // хвост к нулю (без щелчка на конце) и нормировка
  let peak = 0;
  const tail = Math.floor(0.02 * sr);
  for (let i = 0; i < n; i += 1) {
    if (i > n - tail) out[i] *= (n - i) / tail;
    peak = Math.max(peak, Math.abs(out[i]));
  }
  const k = peak > 0 ? 0.9 / peak : 1;
  for (let i = 0; i < n; i += 1) out[i] *= k;
  return out;
}

// тик попадания: короткий тихий «тк» — высокий щелчок + крошечный звон, ~35 мс (без звона-хвоста «клаца»)
function bakeTick(sr) {
  const n = Math.ceil(0.045 * sr);
  const out = new Float32Array(n);
  let seed = 4242;
  let prev = 0;
  for (let i = 0; i < n; i += 1) {
    seed = (seed * 16807) % 2147483647;
    const x = seed / 2147483647 - 0.5;
    const t = i / sr;
    let v = (x - prev) * 0.7 * Math.exp(-t / 0.0004);
    prev = x;
    v += Math.sin(2 * Math.PI * 4700 * t) * 0.3 * Math.min(1, t / 0.0004) * Math.exp(-t / 0.006);
    v += Math.sin(2 * Math.PI * 1900 * t) * 0.18 * Math.exp(-t / 0.003);
    out[i] = v;
  }
  let peak = 0;
  for (let i = 0; i < n; i += 1) {
    if (i > n - 48) out[i] *= (n - i) / 48;
    peak = Math.max(peak, Math.abs(out[i]));
  }
  const k = peak > 0 ? 0.9 / peak : 1;
  for (let i = 0; i < n; i += 1) out[i] *= k;
  return out;
}

export function createKillConfirm({ THREE, root, camera }) {
  const shared = (globalThis.__sceneState ??= {});
  const base = performance.now() / 1000;
  const clock = () => performance.now() / 1000 - base;

  // ---- метки
  const plane = new THREE.PlaneGeometry(2, 2);
  const geo = new THREE.InstancedBufferGeometry();
  geo.index = plane.index;
  geo.setAttribute('position', plane.getAttribute('position'));
  const posArr = new Float32Array((SLOTS + HIT_SLOTS) * 3);
  const infoArr = new Float32Array((SLOTS + HIT_SLOTS) * 3).fill(-100);
  const aPos = new THREE.InstancedBufferAttribute(posArr, 3).setUsage(THREE.DynamicDrawUsage);
  const aInfo = new THREE.InstancedBufferAttribute(infoArr, 3).setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('aPos', aPos);
  geo.setAttribute('aInfo', aInfo);
  geo.instanceCount = 0;
  const mat = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms: { uTime: { value: 0 }, uHalf: { value: HALF_ANGLE }, uScope: { value: SCOPE_FRAC } },
    transparent: true,
    depthTest: true,
    depthWrite: false,
    toneMapped: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'kill-markers';
  mesh.frustumCulled = false; // шейдер собирается при старте сцены, а не на первом убийстве
  mesh.renderOrder = 905;
  root.add(mesh);
  // проходы прицелов и камеры «Моего дрона» её рисуют (в shared.scopeHide НЕ класть): в узкой камере
  // размер — доля её поля (uScope), а в глазу корпус прицела и линза перекрывают её по глубине
  shared.scopeHide?.delete(mesh);
  shared.killConfirmVersion = KILL_CONFIRM_VERSION; // маркер «новый код живой» для vr:eval
  let slot = 0;
  let lastEnd = -1;

  // ---- звук
  const bank = () => {
    const c = shared.audioGraph?.context;
    if (!c) return null;
    const b = shared.killSoundBank;
    if (b?.version === BANK_VERSION && b.rate === c.sampleRate) return b;
    const mk = (big) => {
      const data = bakeKill(c.sampleRate, big);
      const buf = c.createBuffer(1, data.length, c.sampleRate);
      buf.copyToChannel(data, 0);
      return buf;
    };
    const tickData = bakeTick(c.sampleRate);
    const tick = c.createBuffer(1, tickData.length, c.sampleRate);
    tick.copyToChannel(tickData, 0);
    return (shared.killSoundBank = { version: BANK_VERSION, rate: c.sampleRate, normal: mk(false), big: mk(true), tick });
  };
  const voices = () => {
    const g = shared.audioGraph;
    const c = g?.context;
    if (!c || !g.master) return null;
    const v = shared.killVoices;
    if (v?.context === c && v.master === g.master) return v;
    const list = [];
    for (let i = 0; i < VOICES; i += 1) {
      const gain = c.createGain();
      gain.gain.value = LEVEL;
      const pan = c.createStereoPanner();
      gain.connect(pan).connect(g.master);
      list.push({ gain, pan, source: null, start: -1, end: -1 });
    }
    return (shared.killVoices = { context: c, master: g.master, list });
  };
  try {
    bank(); // запечь заранее (≈ 1 мс), чтобы первое убийство не ждало
  } catch {
    // звук не важнее
  }

  const stats = { kills: 0, dogs: 0, drones: 0, played: 0, queued: 0, dropped: 0, stolen: 0, errors: 0, hits: 0, ticks: 0, tickSkipped: 0 };
  let nextAt = 0; // время AudioContext, раньше которого следующий щелчок не ставим
  let streak = 0;
  let lastKillAt = -10;
  const camPos = new THREE.Vector3();
  const camRight = new THREE.Vector3();

  // щелчок; возвращает задержку (с) относительно «сейчас» или −1 (не играли)
  const click = (x, y, z, big) => {
    const b = bank();
    const vs = voices();
    if (!b || !vs) return 0;
    const c = vs.context;
    if (c.state !== 'running') return 0;
    const now = c.currentTime;
    const when = Math.max(now + 0.005, nextAt);
    if (when - now > QUEUE_MAX) {
      stats.dropped += 1;
      return -1;
    }
    if (when > now + 0.01) stats.queued += 1;
    nextAt = when + GAP;
    // голос: свободный, иначе старейший, если уже в тихом хвосте (никогда не самый новый)
    let voice = null;
    let oldest = null;
    let newest = null;
    for (const v of vs.list) {
      if (v.end <= when) {
        voice = v;
        break;
      }
      if (!oldest || v.start < oldest.start) oldest = v;
      if (!newest || v.start > newest.start) newest = v;
    }
    let at = when;
    if (!voice) {
      if (!oldest || oldest === newest || when - oldest.start < MIN_AGE) {
        stats.dropped += 1;
        return -1;
      }
      voice = oldest;
      voice.gain.gain.cancelScheduledValues(when);
      voice.gain.gain.setValueAtTime(LEVEL, when);
      voice.gain.gain.linearRampToValueAtTime(0, when + 0.06);
      try {
        voice.source?.stop(when + 0.06);
      } catch {
        // уже остановлен
      }
      at = when + 0.06;
      stats.stolen += 1;
    }
    voice.gain.gain.cancelScheduledValues(at);
    voice.gain.gain.setValueAtTime(LEVEL * (big ? 1.1 : 1), at);
    // лёгкая панорама в сторону убийства
    camera.getWorldPosition(camPos);
    camRight.setFromMatrixColumn(camera.matrixWorld, 0);
    const dx = x - camPos.x;
    const dy = y - camPos.y;
    const dz = z - camPos.z;
    const dl = Math.hypot(dx, dy, dz);
    const pan = dl > 1e-3 ? ((dx * camRight.x + dy * camRight.y + dz * camRight.z) / dl) * 0.3 : 0;
    if (Number.isFinite(pan)) voice.pan.pan.setValueAtTime(Math.max(-0.3, Math.min(0.3, pan)), at);
    const src = c.createBufferSource();
    src.buffer = big ? b.big : b.normal;
    src.playbackRate.value = (1 + 0.035 * Math.min(streak, 5)) * (0.985 + 0.03 * Math.random());
    src.connect(voice.gain);
    src.onended = () => {
      try {
        src.disconnect();
      } catch {
        // уже отключён
      }
      if (voice.source === src) voice.source = null;
    };
    src.start(at);
    voice.source = src;
    voice.start = at;
    voice.end = at + src.buffer.duration / src.playbackRate.value;
    stats.played += 1;
    try {
      audioBudget(shared).duck(0.7);
    } catch {
      // не важно
    }
    return at - now;
  };
  const at = (x, y, z, big = false, radius = 0.4) => { // radius — радиус жертвы, м
    try {
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;
      stats.kills += 1;
      const t = clock();
      streak = t - lastKillAt < STREAK_S ? streak + 1 : 0;
      lastKillAt = t;
      let delay = 0;
      try {
        delay = click(x, y, z, big);
      } catch {
        stats.errors += 1;
      }
      // метка — в такт щелчку (в серии: каждая со своим щелчком)
      const start = t + Math.max(0, delay);
      const i = slot;
      slot = (slot + 1) % SLOTS;
      posArr[i * 3] = x;
      posArr[i * 3 + 1] = y;
      posArr[i * 3 + 2] = z;
      infoArr[i * 3] = start;
      infoArr[i * 3 + 1] = big ? 1 : 0;
      infoArr[i * 3 + 2] = Number.isFinite(radius) ? Math.max(0, radius) : 0.4;
      // диапазоны копятся до загрузки (несколько убийств за кадр); three сам чистит их после неё
      aPos.addUpdateRange(i * 3, 3);
      aPos.needsUpdate = true;
      aInfo.addUpdateRange(i * 3, 3);
      aInfo.needsUpdate = true;
      geo.instanceCount = SLOTS + HIT_SLOTS;
      mat.uniforms.uTime.value = t; // update этого кадра мог пройти раньше
      lastEnd = Math.max(lastEnd, start + LIFE);
    } catch {
      stats.errors += 1; // подтверждение не важнее убийства
    }
  };

  // ---- попадание без убийства: серая метка + тихий тик (свои 2 голоса, не чаще TICK_GAP; мир не глушит)
  const tickVoices = () => {
    const g = shared.audioGraph;
    const c = g?.context;
    if (!c || !g.master) return null;
    const v = shared.hitTickVoices;
    if (v?.context === c && v.master === g.master) return v;
    const list = [];
    for (let i = 0; i < 2; i += 1) {
      const gain = c.createGain();
      gain.gain.value = TICK_LEVEL;
      const pan = c.createStereoPanner();
      gain.connect(pan).connect(g.master);
      list.push({ gain, pan, end: -1 });
    }
    return (shared.hitTickVoices = { context: c, master: g.master, list });
  };
  let tickAt = -10;
  // n — сколько попаданий собрано за кадр: один тик, чуть громче для многих (до ×2)
  const tick = (x, y, z, n = 1) => {
    const b = bank();
    const vs = tickVoices();
    if (!b?.tick || !vs || vs.context.state !== 'running') return;
    const now = vs.context.currentTime;
    // не чаще TICK_GAP и не поверх только что поставленного «клаца»
    if (now - tickAt < TICK_GAP || nextAt - now > -0.03) {
      stats.tickSkipped += 1;
      return;
    }
    const voice = vs.list[0].end <= now ? vs.list[0] : vs.list[1].end <= now ? vs.list[1] : null;
    if (!voice) {
      stats.tickSkipped += 1;
      return;
    }
    tickAt = now;
    voice.gain.gain.setValueAtTime(TICK_LEVEL * (1 + 0.25 * Math.min(4, Math.max(0, n - 1))), now);
    camera.getWorldPosition(camPos);
    camRight.setFromMatrixColumn(camera.matrixWorld, 0);
    const dx = x - camPos.x;
    const dy = y - camPos.y;
    const dz = z - camPos.z;
    const dl = Math.hypot(dx, dy, dz);
    const pan = dl > 1e-3 ? ((dx * camRight.x + dy * camRight.y + dz * camRight.z) / dl) * 0.3 : 0;
    if (Number.isFinite(pan)) voice.pan.pan.setValueAtTime(Math.max(-0.3, Math.min(0.3, pan)), now);
    const src = vs.context.createBufferSource();
    src.buffer = b.tick;
    src.playbackRate.value = 0.97 + 0.06 * Math.random();
    src.connect(voice.gain);
    src.onended = () => {
      try {
        src.disconnect();
      } catch {
        // уже отключён
      }
    };
    src.start(now);
    voice.end = now + b.tick.duration / src.playbackRate.value + 0.005;
    stats.ticks += 1;
  };
  let hitSlot = 0;
  // за кадр — один тик: попадания копятся (первое — для панорамы), играются в update
  let tickN = 0;
  let tickX = 0;
  let tickY = 0;
  let tickZ = 0;
  const hitAt = (x, y, z, radius = 0.08) => {
    try {
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;
      stats.hits += 1;
      const t = clock();
      try {
        if (tickN === 0) {
          tickX = x;
          tickY = y;
          tickZ = z;
        }
        tickN += 1;
      } catch {
        stats.errors += 1;
      }
      const i = SLOTS + hitSlot;
      hitSlot = (hitSlot + 1) % HIT_SLOTS;
      posArr[i * 3] = x;
      posArr[i * 3 + 1] = y;
      posArr[i * 3 + 2] = z;
      infoArr[i * 3] = t;
      infoArr[i * 3 + 1] = 2;
      infoArr[i * 3 + 2] = Number.isFinite(radius) ? Math.max(0, radius) : 0.08; // точка пули на поверхности — 0.08; взрыв — центр тела, радиус жертвы
      aPos.addUpdateRange(i * 3, 3);
      aPos.needsUpdate = true;
      aInfo.addUpdateRange(i * 3, 3);
      aInfo.needsUpdate = true;
      geo.instanceCount = SLOTS + HIT_SLOTS;
      mat.uniforms.uTime.value = t;
      lastEnd = Math.max(lastEnd, t + HIT_LIFE);
    } catch {
      stats.errors += 1;
    }
  };

  const api = {
    version: KILL_CONFIRM_VERSION,
    at,
    hitAt,
    // попадание пули игрока без убийства (луч origin + dir·distance)
    hitRay(origin, dir, distance) {
      if (!origin || !dir || !Number.isFinite(distance)) return;
      hitAt(origin.x + dir.x * distance, origin.y + dir.y * distance, origin.z + dir.z * distance);
    },
    // ранение взрывом/дырой (без точки попадания): серый крестик в центре тела (союзники — нет)
    dogHit(u) {
      if (!u || u.dog?.team === 'ally' || !u.bodyCenter) return;
      hitAt(u.bodyCenter.x, u.bodyCenter.y, u.bodyCenter.z, 0.35 * (u.scale ?? 1));
    },
    droneHit(d) {
      if (!d || d.team === 'ally') return;
      hitAt(d.x, d.y, d.z, 0.5 * (d.span ?? 0.5));
    },
    dog(u) {
      if (!u || u.dog?.team === 'ally') return;
      stats.dogs += 1;
      const c = u.bodyCenter;
      if (c) at(c.x, c.y, c.z, (u.scale ?? 1) >= BIG_DOG, 0.35 * (u.scale ?? 1));
    },
    drone(d) {
      if (!d || d.team === 'ally') return;
      stats.drones += 1;
      at(d.x, d.y, d.z, (d.size ?? 0) >= BIG_DRONE, 0.5 * (d.span ?? 0.5));
    },
    stats: () => ({ ...stats, active: geo.instanceCount > 0, voices: shared.killVoices?.list.length ?? 0 }),
    // проверка с ПК: метка + звук в dist м перед глазами (big — красная)
    test(dist = 15, big = false) {
      camera.getWorldPosition(camPos);
      camRight.set(0, 0, -1).applyQuaternion(camera.getWorldQuaternion(new THREE.Quaternion()));
      at(camPos.x + camRight.x * dist, camPos.y + camRight.y * dist, camPos.z + camRight.z * dist, big);
      return api.stats();
    },
  };
  shared.killConfirm = api;

  return {
    update() {
      if (tickN > 0) {
        try {
          tick(tickX, tickY, tickZ, tickN);
        } catch {
          stats.errors += 1;
        }
        tickN = 0;
      }
      if (geo.instanceCount === 0) return;
      const t = clock();
      mat.uniforms.uTime.value = t;
      if (t > lastEnd) geo.instanceCount = 0;
    },
    dispose() {
      if (shared.killConfirm === api) delete shared.killConfirm;
      shared.scopeHide?.delete(mesh);
      root.remove(mesh);
      geo.dispose();
      plane.dispose();
      mat.dispose();
    },
  };
}
