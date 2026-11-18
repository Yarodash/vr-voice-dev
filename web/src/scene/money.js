// Деньги игрока: награда за убийства робопсов и коптеров (те же убийства, что у хитмаркера —
// kill-confirm.js: пули/ракеты/рельса/плазма/дыра игрока и «Мой дрон»). Баланс общий для всех сцен
// и переживает перезагрузку: localStorage 'scene.money'; между подменами сцены — shared.moneyState.
//
// - Слева сверху в поле зрения — «$ 1 250» (холст → CanvasTexture, перерисовка только при изменении,
//   не чаще раза в кадр), висит в HUD-группе у камеры (как score.js), далеко от окон ответов справа
//   и от кружка. На прибавку число коротко «пульсирует» (растёт и зеленеет).
// - В точке убийства рядом с крестом всплывает «+$N» и уплывает вверх (~0,8 с): ОДИН инстанс-меш
//   глифов (атлас «0–9 + $») + ShaderMaterial, повёрнут к камере, размер ∝ расстоянию (постоянный
//   угол), depthTest выкл, renderOrder 906; в кадре — только uniform времени, атрибуты пишутся при
//   награде, instanceCount 0, когда надписей нет.
//
// Награды: DOG_REWARD (по scale пса), DRONE_REWARD (по индексу размера коптера).
// С ПК: npm run vr:eval -- "__sceneState.money.stats()"; add(n) / set(n) / reset();
//       test(dist) — «+$N» в dist м перед глазами (только ПК: не трогает баланс).
export const MONEY_VERSION = 2;
const KEY = 'scene.money';

// scale пса (robodog-horde.js SIZES) → $: маленький, средний, большой, огромный, гигантский, колоссальный, титанический
const DOG_REWARD = [[1, 10], [1.6, 20], [2.5, 50], [4, 100], [7, 200], [12, 400], [36, 1200]];
// коптер (drones.js SIZES, индекс d.size): маленький, средний, большой, огромный — сбить трудно, платим щедро
const DRONE_REWARD = [40, 80, 200, 400];
export const dogReward = (scale = 1) => {
  let best = DOG_REWARD[0];
  for (const r of DOG_REWARD) if (Math.abs(r[0] - scale) < Math.abs(best[0] - scale)) best = r;
  return best[1];
};
export const droneReward = (size = 0) => DRONE_REWARD[Math.max(0, Math.min(DRONE_REWARD.length - 1, size | 0))];

// табличка баланса (м в пространстве HUD-группы; группа в 0.8 м × масштаб, см. hud-and-messages.md)
const W = 0.2;
const H = 0.05;
const X = -0.4; // центр таблички (текст прижат к её левому краю): начало «$» ≈ 29° влево (HUD в 1 м ×1,25)
const Y = 0.12; // ≈ 22° вверх — выше окон ответов, далеко от кружка справа
const PULSE_S = 0.42;

// всплывающие «+$N»
const POPS = 8;
const CHARS = 7; // «+$1200» и запас
const LIFE = 0.8;
const GLYPHS = '0123456789+$';
const CELL_W = 42;
const CELL_H = 64;
const H_ANG = 0.03; // высота глифа / расстояние (~1,7°)
const ADV = 0.5; // шаг символа / высота (квад шире — ячейка атласа CELL_W/CELL_H, соседние перекрываются)

const VERT = /* glsl */ `
attribute vec3 aPos;
attribute vec4 aInfo; // x — старт (с), y — глиф, z — номер символа, w — радиус жертвы (м)
uniform float uTime;
varying vec2 vUv;
varying float vAlpha;
void main() {
  float a = uTime - aInfo.x;
  if (a < 0.0 || a > ${LIFE.toFixed(3)} || aInfo.y < 0.0) {
    vAlpha = 0.0;
    vUv = vec2(0.0);
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  vec4 mv = modelViewMatrix * vec4(aPos, 1.0);
  // как хитмаркер (kill-confirm.js): к камере на радиус жертвы + 6 %, не ближе 1,2 м; depthTest вкл —
  // прицел и оружие перекрывают; в узкой камере прицела — в той же доле его поля, что и крест
  float d0 = length(mv.xyz);
  float pulled = max(min(d0, 1.2), d0 - aInfo.w - 0.06 * d0);
  mv.xyz *= pulled / max(d0, 1e-3);
  float dist = max(0.3, -mv.z);
  float f = min(1.0, 0.13 / (projectionMatrix[1][1] * 0.024));
  float h = dist * ${H_ANG.toFixed(4)} * f;
  float p = clamp(a / 0.08, 0.0, 1.0);
  float s = a < 0.08 ? mix(0.55, 1.15, 1.0 - (1.0 - p) * (1.0 - p)) : mix(1.15, 1.0, smoothstep(0.08, 0.2, a));
  float u = position.x * 0.5 + 0.5;
  float v = position.y * 0.5 + 0.5;
  // правее креста (его штрихи до ~0.031·dist), всплывает вверх, замедляясь
  float rise = 1.0 - (1.0 - a / ${LIFE.toFixed(3)}) * (1.0 - a / ${LIFE.toFixed(3)});
  vec2 base = vec2(dist * 0.024 * f, dist * 0.003 * f + h * 1.5 * rise);
  vec2 local = vec2((aInfo.z * ${ADV.toFixed(3)} + u * ${(CELL_W / CELL_H).toFixed(4)}) * h, (v - 0.5) * h) * s;
  mv.xy += base + local;
  gl_Position = projectionMatrix * mv;
  vUv = vec2((aInfo.y + u) * ${(CELL_W / 512).toFixed(6)}, v);
  vAlpha = 1.0 - smoothstep(0.5, ${LIFE.toFixed(3)}, a);
}`;

const FRAG = /* glsl */ `
uniform sampler2D uMap;
uniform vec3 uColor;
varying vec2 vUv;
varying float vAlpha;
void main() {
  if (vAlpha <= 0.0) discard;
  vec4 t = texture2D(uMap, vUv);
  float alpha = t.a * vAlpha;
  if (alpha < 0.01) discard;
  gl_FragColor = vec4(t.rgb * uColor, alpha);
  #include <colorspace_fragment>
}`;

const spaced = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

export function createMoney({ THREE, root, camera }) {
  const shared = (globalThis.__sceneState ??= {});
  let state = shared.moneyState;
  if (!state) {
    let saved = 0;
    try {
      saved = Number(localStorage.getItem(KEY)) || 0;
    } catch {
      saved = 0;
    }
    state = shared.moneyState = { balance: Math.max(0, Math.round(saved)) };
  }
  const base = performance.now() / 1000;
  const clock = () => performance.now() / 1000 - base;
  const stats = { added: 0, pops: 0, draws: 0, saves: 0 };

  // ---- сохранение (не чаще раза в секунду; остаток — в update/dispose)
  let savedAt = -10;
  let saveDirty = false;
  const save = () => {
    try {
      localStorage.setItem(KEY, String(state.balance));
      stats.saves += 1;
    } catch {
      // нет хранилища — баланс живёт до перезагрузки
    }
    saveDirty = false;
    savedAt = clock();
  };

  // ---- табличка баланса в HUD
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 128;
  const g2 = canvas.getContext('2d');
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  const plate = new THREE.Mesh(
    new THREE.PlaneGeometry(W, H),
    new THREE.MeshBasicMaterial({ map: texture, transparent: true, toneMapped: false, depthTest: false, depthWrite: false }),
  );
  plate.name = 'scene-money';
  plate.renderOrder = 1001;
  plate.position.set(X, Y, 0);
  let shownGreen = false;
  const draw = (green) => {
    const w = canvas.width;
    const h = canvas.height;
    g2.clearRect(0, 0, w, h);
    const text = spaced(state.balance);
    g2.font = 'bold 74px system-ui, sans-serif';
    const tw = g2.measureText(text).width;
    const dollarW = 52;
    const pillW = Math.min(w - 4, 36 + dollarW + 14 + tw + 30);
    g2.fillStyle = 'rgba(12, 14, 20, 0.62)';
    g2.beginPath();
    g2.roundRect(2, 10, pillW, h - 20, (h - 20) / 2);
    g2.fill();
    g2.textBaseline = 'middle';
    g2.textAlign = 'left';
    g2.fillStyle = '#ffd34d';
    g2.fillText('$', 36, h / 2 + 3);
    g2.fillStyle = green ? '#7dff8f' : '#ffffff';
    g2.fillText(text, 36 + dollarW + 14, h / 2 + 3);
    texture.needsUpdate = true;
    shownGreen = green;
    stats.draws += 1;
  };
  let drawDirty = true;
  let pulse = 0;

  let hud = null;
  const place = () => {
    if (hud && hud.parent === camera && plate.parent === hud) return;
    hud = null;
    for (const group of camera.children) {
      if (group.children?.some((c) => c.geometry?.type === 'CircleGeometry')) {
        hud = group;
        break;
      }
    }
    if (!hud) return;
    for (const old of hud.children.filter((c) => c.name === 'scene-money' && c !== plate)) hud.remove(old); // от прежней версии сцены
    hud.add(plate);
  };

  // ---- «+$N» в мире: атлас глифов (белые с тёмной обводкой; цвет — uColor)
  const atlas = document.createElement('canvas');
  atlas.width = 512;
  atlas.height = CELL_H;
  const ga = atlas.getContext('2d');
  ga.font = 'bold 52px system-ui, sans-serif';
  ga.textAlign = 'center';
  ga.textBaseline = 'middle';
  ga.lineJoin = 'round';
  for (let i = 0; i < GLYPHS.length; i += 1) {
    const cx = i * CELL_W + CELL_W / 2;
    ga.lineWidth = 9;
    ga.strokeStyle = 'rgba(20, 14, 0, 0.9)';
    ga.strokeText(GLYPHS[i], cx, CELL_H / 2 + 2);
    ga.fillStyle = '#ffffff';
    ga.fillText(GLYPHS[i], cx, CELL_H / 2 + 2);
  }
  const atlasTex = new THREE.CanvasTexture(atlas);
  atlasTex.colorSpace = THREE.SRGBColorSpace;
  atlasTex.minFilter = THREE.LinearMipmapLinearFilter;
  atlasTex.anisotropy = 4;
  const plane = new THREE.PlaneGeometry(2, 2);
  const geo = new THREE.InstancedBufferGeometry();
  geo.index = plane.index;
  geo.setAttribute('position', plane.getAttribute('position'));
  const N = POPS * CHARS;
  const posArr = new Float32Array(N * 3);
  const infoArr = new Float32Array(N * 4);
  for (let i = 0; i < N; i += 1) infoArr[i * 4 + 1] = -1;
  const aPos = new THREE.InstancedBufferAttribute(posArr, 3).setUsage(THREE.DynamicDrawUsage);
  const aInfo = new THREE.InstancedBufferAttribute(infoArr, 4).setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('aPos', aPos);
  geo.setAttribute('aInfo', aInfo);
  geo.instanceCount = 0;
  const mat = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms: { uTime: { value: 0 }, uMap: { value: atlasTex }, uColor: { value: new THREE.Color(0xffd34d) } },
    transparent: true,
    depthTest: true,
    depthWrite: false,
    toneMapped: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'money-pops';
  mesh.frustumCulled = false; // шейдер собирается при старте сцены
  mesh.renderOrder = 906;
  root.add(mesh);
  shared.scopeHide?.delete(mesh); // видно и в проходах прицелов и камеры дрона (как хитмаркер)
  shared.moneyVersion = MONEY_VERSION; // маркер «новый код живой» для vr:eval
  let popSlot = 0;
  let popsEnd = -1;
  const glyphOf = (ch) => GLYPHS.indexOf(ch);

  const pop = (amount, x, y, z, delay, radius = 0.4) => {
    const text = `+$${amount}`;
    const start = clock() + Math.max(0, delay || 0);
    const p0 = popSlot * CHARS;
    popSlot = (popSlot + 1) % POPS;
    for (let k = 0; k < CHARS; k += 1) {
      const i = p0 + k;
      posArr[i * 3] = x;
      posArr[i * 3 + 1] = y;
      posArr[i * 3 + 2] = z;
      infoArr[i * 4] = start;
      infoArr[i * 4 + 1] = k < text.length ? glyphOf(text[k]) : -1;
      infoArr[i * 4 + 2] = k;
      infoArr[i * 4 + 3] = Number.isFinite(radius) ? Math.max(0, radius) : 0.4;
    }
    aPos.addUpdateRange(p0 * 3, CHARS * 3); // диапазоны копятся до загрузки; three чистит их сам
    aPos.needsUpdate = true;
    aInfo.addUpdateRange(p0 * 4, CHARS * 4);
    aInfo.needsUpdate = true;
    geo.instanceCount = N;
    mat.uniforms.uTime.value = clock();
    popsEnd = Math.max(popsEnd, start + LIFE);
    stats.pops += 1;
  };

  // at: { x, y, z, delay? } — где всплыть «+$N» (delay, с — в такт щелчку хитмаркера)
  const add = (amount, at = null) => {
    try {
      const n = Math.round(Number(amount));
      if (!Number.isFinite(n) || n === 0) return state.balance;
      state.balance = Math.max(0, state.balance + n);
      stats.added += n > 0 ? n : 0;
      drawDirty = true;
      if (n > 0) pulse = PULSE_S;
      if (clock() - savedAt > 1) save();
      else saveDirty = true;
      if (n > 0 && at && Number.isFinite(at.x) && Number.isFinite(at.y) && Number.isFinite(at.z)) pop(n, at.x, at.y, at.z, at.delay, at.radius);
    } catch {
      // деньги не важнее боя
    }
    return state.balance;
  };

  const tmpV = new THREE.Vector3();
  const tmpQ = new THREE.Quaternion();
  const api = {
    version: MONEY_VERSION,
    add,
    balance: () => state.balance,
    set(n) {
      state.balance = Math.max(0, Math.round(Number(n) || 0));
      drawDirty = true;
      save();
      return state.balance;
    },
    reset() {
      return api.set(0);
    },
    dogReward,
    droneReward,
    stats: () => ({ balance: state.balance, ...stats, hud: Boolean(plate.parent), popsActive: geo.instanceCount > 0 }),
    // «+$N» в dist м перед глазами, баланс не меняется (проверка с ПК)
    test(dist = 12, amount = 200) {
      camera.getWorldPosition(tmpV);
      const fx = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.getWorldQuaternion(tmpQ));
      pop(amount, tmpV.x + fx.x * dist, tmpV.y + fx.y * dist, tmpV.z + fx.z * dist, 0);
      pulse = PULSE_S;
      drawDirty = true;
      return api.stats();
    },
  };
  shared.money = api;

  return {
    update(dt) {
      place();
      const t = clock();
      if (pulse > 0) {
        pulse = Math.max(0, pulse - (Number.isFinite(dt) ? dt : 0));
        const k = 1 - pulse / PULSE_S; // 0 → 1
        const s = 1 + 0.22 * Math.sin(Math.PI * Math.min(1, k * 1.6)) * (1 - k * 0.3);
        plate.scale.setScalar(pulse > 0 ? s : 1);
        if (pulse === 0) drawDirty = true; // вернуть белые цифры
      }
      const green = pulse > 0;
      if (drawDirty || green !== shownGreen) {
        drawDirty = false;
        draw(green);
      }
      if (saveDirty && t - savedAt > 1) save();
      if (geo.instanceCount > 0) {
        mat.uniforms.uTime.value = t;
        if (t > popsEnd) geo.instanceCount = 0;
      }
    },
    dispose() {
      if (saveDirty) save();
      if (shared.money === api) delete shared.money;
      shared.scopeHide?.delete(mesh);
      plate.removeFromParent();
      plate.geometry.dispose();
      plate.material.dispose();
      texture.dispose();
      root.remove(mesh);
      geo.dispose();
      plane.dispose();
      mat.dispose();
      atlasTex.dispose();
    },
  };
}
