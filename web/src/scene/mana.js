// Мана-снаряды (оружие с projectile: 'mana', generated-guns.js / main.js GUNS): светящийся
// голубой сгусток вместо пули — яркое ядро в мягком ореоле, короткий мерцающий хвост и искорки,
// слегка виляет; вспышка у дула — голубое свечение с кольцом; попадание — магический всплеск
// (кольца, свечение, россыпь искр). Летит ровно по пути пули shooting.js (та же парабола, тот же
// шаг dt — сгусток там, где пуля); попадание и автонаводку считает shooting.js.
//
// Всё — один InstancedBufferGeometry (квадрат к камере) + один ShaderMaterial с аддитивным
// смешиванием: один вызов отрисовки, пока есть что рисовать (0 — ни одного). Состояние — типизированные
// массивы, живые — первые count; за кадр ничего не выделяется. Вид спрайта (kind): 0 — сгусток
// (ядро + ореол), 1 — мягкое свечение, 2 — кольцо, 3 — искорка-звёздочка.

const MAX_ORBS = 32; // как пуль в shooting.js
const TRAIL = 10; // спрайтов в хвосте (через ~0,11 м — сливаются в шлейф)
const TRAIL_M = 1.1; // м: длина хвоста
const MAX_PARTS = 360; // искры, кольца, вспышки (лишние вытесняют самые старые)
const CAP = MAX_ORBS * (1 + TRAIL) + MAX_PARTS;
const SPARKS_PER_S = 70; // искорок от летящего сгустка
const DEFAULT_COLOR = 0x39c6ff;

const vertexShader = /* glsl */ `
  attribute vec4 iPos;  // xyz — центр, w — полуразмер (м)
  attribute vec4 iCol;  // rgb — цвет (линейный), a — яркость
  attribute vec2 iKind; // x — вид, y — поворот (рад)
  varying vec2 vUv;
  varying vec4 vCol;
  varying float vKind;
  void main() {
    vec4 mv = modelViewMatrix * vec4(iPos.xyz, 1.0);
    float c = cos(iKind.y);
    float s = sin(iKind.y);
    vec2 p = position.xy;
    mv.xy += vec2(p.x * c - p.y * s, p.x * s + p.y * c) * iPos.w;
    gl_Position = projectionMatrix * mv;
    vUv = position.xy;
    vCol = iCol;
    vKind = iKind.x;
  }
`;

const fragmentShader = /* glsl */ `
  varying vec2 vUv;
  varying vec4 vCol;
  varying float vKind;
  void main() {
    float r = length(vUv);
    float edge = max(0.0, 1.0 - r);
    vec3 c = vCol.rgb;
    vec3 col;
    if (vKind < 0.5) {
      float core = exp(-r * r * 16.0);
      float glow = exp(-r * r * 3.2) * edge;
      col = mix(c, vec3(1.0), 0.75) * core * 2.4 + c * glow * 1.5;
    } else if (vKind < 1.5) {
      col = c * exp(-r * r * 3.0) * edge;
    } else if (vKind < 2.5) {
      float d = (r - 0.8) / 0.08;
      col = (c * 1.1 + vec3(0.12)) * exp(-d * d) * edge * 4.0;
    } else {
      vec2 q = abs(vUv);
      float star = exp(-q.x * 16.0) * exp(-q.y * 2.4) + exp(-q.y * 16.0) * exp(-q.x * 2.4);
      col = mix(c, vec3(1.0), 0.55) * (star + exp(-r * r * 28.0)) * edge;
    }
    gl_FragColor = vec4(col * vCol.a, 1.0);
    #include <colorspace_fragment>
  }
`;

export function createMana({ THREE, group, camera }) {
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
  const posArr = new Float32Array(CAP * 4);
  const colArr = new Float32Array(CAP * 4);
  const kindArr = new Float32Array(CAP * 2);
  const attrs = [
    ['iPos', posArr, 4],
    ['iCol', colArr, 4],
    ['iKind', kindArr, 2],
  ].map(([name, arr, size]) => {
    const attr = new THREE.InstancedBufferAttribute(arr, size).setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute(name, attr);
    return attr;
  });
  geometry.instanceCount = 0;
  const material = new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'mana-bolts';
  mesh.frustumCulled = false; // шейдер собирается при подмене сцены, а не на первом выстреле
  let warmFrames = 0; // кадров после создания (конец update: пустой меш скрыт)
  mesh.renderOrder = 3;
  group.add(mesh);

  // ---- сгустки в полёте
  const ox = new Float32Array(MAX_ORBS), oy = new Float32Array(MAX_ORBS), oz = new Float32Array(MAX_ORBS);
  const dx = new Float32Array(MAX_ORBS), dy = new Float32Array(MAX_ORBS), dz = new Float32Array(MAX_ORBS);
  const spd = new Float32Array(MAX_ORBS), grav = new Float32Array(MAX_ORBS), age = new Float32Array(MAX_ORBS);
  const endT = new Float32Array(MAX_ORBS), phase = new Float32Array(MAX_ORBS), emit = new Float32Array(MAX_ORBS);
  const cr = new Float32Array(MAX_ORBS), cg = new Float32Array(MAX_ORBS), cb = new Float32Array(MAX_ORBS);
  const ids = new Int32Array(MAX_ORBS);
  // самонаводящиеся (ext): положение задаёт shooting.js (track), путь кривой — хвост идёт по
  // последним HIST положениям головы (новое — первое)
  const HIST = 6;
  const ext = new Uint8Array(MAX_ORBS);
  const hist = new Float32Array(MAX_ORBS * HIST * 3);
  const histN = new Uint8Array(MAX_ORBS);
  let orbs = 0;
  let nextId = 1;
  const copyOrb = (i, j) => {
    ext[i] = ext[j];
    histN[i] = histN[j];
    hist.copyWithin(i * HIST * 3, j * HIST * 3, (j + 1) * HIST * 3);
    ox[i] = ox[j]; oy[i] = oy[j]; oz[i] = oz[j];
    dx[i] = dx[j]; dy[i] = dy[j]; dz[i] = dz[j];
    spd[i] = spd[j]; grav[i] = grav[j]; age[i] = age[j];
    endT[i] = endT[j]; phase[i] = phase[j]; emit[i] = emit[j];
    cr[i] = cr[j]; cg[i] = cg[j]; cb[i] = cb[j]; ids[i] = ids[j];
  };

  // ---- частицы: искры, кольца, свечения
  const px = new Float32Array(MAX_PARTS), py = new Float32Array(MAX_PARTS), pz = new Float32Array(MAX_PARTS);
  const vx = new Float32Array(MAX_PARTS), vy = new Float32Array(MAX_PARTS), vz = new Float32Array(MAX_PARTS);
  const pAge = new Float32Array(MAX_PARTS), pLife = new Float32Array(MAX_PARTS);
  const s0 = new Float32Array(MAX_PARTS), s1 = new Float32Array(MAX_PARTS), pKind = new Float32Array(MAX_PARTS);
  const pr = new Float32Array(MAX_PARTS), pg = new Float32Array(MAX_PARTS), pb = new Float32Array(MAX_PARTS);
  const pA = new Float32Array(MAX_PARTS), pDrag = new Float32Array(MAX_PARTS), pGrav = new Float32Array(MAX_PARTS);
  const pRot = new Float32Array(MAX_PARTS), pSpin = new Float32Array(MAX_PARTS);
  let parts = 0;
  const copyPart = (i, j) => {
    px[i] = px[j]; py[i] = py[j]; pz[i] = pz[j];
    vx[i] = vx[j]; vy[i] = vy[j]; vz[i] = vz[j];
    pAge[i] = pAge[j]; pLife[i] = pLife[j]; s0[i] = s0[j]; s1[i] = s1[j]; pKind[i] = pKind[j];
    pr[i] = pr[j]; pg[i] = pg[j]; pb[i] = pb[j]; pA[i] = pA[j]; pDrag[i] = pDrag[j]; pGrav[i] = pGrav[j];
    pRot[i] = pRot[j]; pSpin[i] = pSpin[j];
  };
  const rand = (a, b) => a + Math.random() * (b - a);
  // новая частица (мест нет — самая старая уступает)
  const part = (x, y, z, kind, life, size0, size1, r, g, b, a = 1) => {
    let i;
    if (parts < MAX_PARTS) i = parts++;
    else {
      i = 0;
      for (let k = 1; k < MAX_PARTS; k += 1) if (pAge[k] / pLife[k] > pAge[i] / pLife[i]) i = k;
    }
    px[i] = x; py[i] = y; pz[i] = z;
    vx[i] = 0; vy[i] = 0; vz[i] = 0;
    pAge[i] = 0; pLife[i] = life; s0[i] = size0; s1[i] = size1; pKind[i] = kind;
    pr[i] = r; pg[i] = g; pb[i] = b; pA[i] = a; pDrag[i] = 0; pGrav[i] = 0;
    pRot[i] = Math.random() * Math.PI; pSpin[i] = 0;
    return i;
  };
  // искорка с разлётом speed (м/с) по случайному направлению вокруг (nx, ny, nz) с разбросом spread
  const spark = (x, y, z, nx, ny, nz, spread, speed, life, size, r, g, b) => {
    const i = part(x, y, z, 3, life, size, size * 0.3, r, g, b, 1);
    let ax = nx + rand(-spread, spread);
    let ay = ny + rand(-spread, spread);
    let az = nz + rand(-spread, spread);
    const n = Math.hypot(ax, ay, az) || 1;
    ax /= n; ay /= n; az /= n;
    vx[i] = ax * speed; vy[i] = ay * speed; vz[i] = az * speed;
    pDrag[i] = 3.2;
    pGrav[i] = 1.2;
    pSpin[i] = rand(-6, 6);
    return i;
  };

  // спрайт в буфер отрисовки (m — сколько уже записано в этом кадре)
  let m = 0;
  const put = (x, y, z, size, r, g, b, a, kind, rot) => {
    if (m >= CAP) return;
    const q = m * 4;
    posArr[q] = x; posArr[q + 1] = y; posArr[q + 2] = z; posArr[q + 3] = size;
    colArr[q] = r; colArr[q + 1] = g; colArr[q + 2] = b; colArr[q + 3] = a;
    kindArr[m * 2] = kind; kindArr[m * 2 + 1] = rot;
    m += 1;
  };

  const color = new THREE.Color();
  const camPos = new THREE.Vector3();
  let clock = 0;
  const setColor = (hex) => {
    color.set(hex ?? DEFAULT_COLOR); // в линейные компоненты (как ждёт шейдер)
    return color;
  };

  return {
    // сгусток по пути пули: from — дуло, dir — единичное направление, speed — м/с, gravity — м/с²
    // external — самонаводящийся: дальше положение задаёт track()
    fire(from, dir, speed, gravity, hex, external = false) {
      let i;
      if (orbs < MAX_ORBS) i = orbs++;
      else {
        i = 0;
        for (let k = 1; k < MAX_ORBS; k += 1) if (age[k] > age[i]) i = k;
      }
      ox[i] = from.x; oy[i] = from.y; oz[i] = from.z;
      dx[i] = dir.x; dy[i] = dir.y; dz[i] = dir.z;
      spd[i] = speed; grav[i] = gravity; age[i] = 0; endT[i] = 1e9;
      phase[i] = Math.random() * 100; emit[i] = 0;
      setColor(hex);
      cr[i] = color.r; cg[i] = color.g; cb[i] = color.b;
      ext[i] = external ? 1 : 0;
      const q = i * HIST * 3;
      hist[q] = from.x; hist[q + 1] = from.y; hist[q + 2] = from.z;
      histN[i] = 1;
      ids[i] = nextId;
      nextId = (nextId + 1) % 0x7fffffff || 1;
      return ids[i];
    },
    // самонаводящийся сгусток id теперь в p, летит со скоростью vel (вызывать каждый шаг мира)
    track(id, p, vel) {
      for (let i = 0; i < orbs; i += 1) {
        if (ids[i] !== id) continue;
        const q = i * HIST * 3;
        hist.copyWithin(q + 3, q, q + (HIST - 1) * 3);
        hist[q] = p.x; hist[q + 1] = p.y; hist[q + 2] = p.z;
        if (histN[i] < HIST) histN[i] += 1;
        const n = Math.hypot(vel.x, vel.y, vel.z) || 1;
        dx[i] = vel.x / n; dy[i] = vel.y / n; dz[i] = vel.z / n;
        return;
      }
    },
    // пуля id остановилась через t с полёта (попала или кончилась): сгусток гаснет там
    land(id, t) {
      for (let i = 0; i < orbs; i += 1) {
        if (ids[i] !== id) continue;
        endT[i] = Math.max(0, t);
        return;
      }
    },
    // голубая вспышка у дула: свечение, ядро, кольцо и несколько искр вперёд
    muzzle(p, dir, hex) {
      setColor(hex);
      const { r, g, b } = color;
      part(p.x, p.y, p.z, 1, 0.11, 0.13, 0.03, r, g, b, 1.2);
      part(p.x, p.y, p.z, 0, 0.07, 0.05, 0.015, r, g, b, 1);
      const k = part(p.x + dir.x * 0.03, p.y + dir.y * 0.03, p.z + dir.z * 0.03, 2, 0.14, 0.025, 0.11, r, g, b, 0.9);
      vx[k] = dir.x * 0.6; vy[k] = dir.y * 0.6; vz[k] = dir.z * 0.6;
      for (let n = 0; n < 6; n += 1) spark(p.x, p.y, p.z, dir.x, dir.y, dir.z, 0.45, rand(1.5, 4), rand(0.15, 0.3), 0.014, r, g, b);
    },
    // магический всплеск в точке попадания: свечение, ядро, два кольца, россыпь искр
    impact(p, hex) {
      setColor(hex);
      const { r, g, b } = color;
      part(p.x, p.y, p.z, 1, 0.3, 0.12, 0.5, r, g, b, 1.3);
      part(p.x, p.y, p.z, 0, 0.14, 0.14, 0.02, r, g, b, 1.2);
      part(p.x, p.y, p.z, 2, 0.32, 0.05, 0.62, r, g, b, 1);
      part(p.x, p.y, p.z, 2, 0.45, 0.03, 0.38, r * 0.7 + 0.3, g * 0.7 + 0.3, b * 0.7 + 0.3, 0.8);
      for (let n = 0; n < 14; n += 1) spark(p.x, p.y, p.z, 0, 0.3, 0, 1.2, rand(1.2, 4.2), rand(0.3, 0.7), rand(0.014, 0.026), r, g, b);
    },
    update(dtRaw) {
      const dt = Math.min(0.05, dtRaw || 0); // тот же шаг, что у пуль (shooting.js)
      clock = (clock + dt) % 1000;
      camera.getWorldPosition(camPos);
      // сгустки: двигаются; долетевшие отпускаются
      for (let i = orbs - 1; i >= 0; i -= 1) {
        age[i] += dt;
        if (age[i] >= endT[i] || age[i] > 3.2) {
          orbs -= 1;
          copyOrb(i, orbs);
        }
      }
      m = 0;
      for (let i = 0; i < orbs; i += 1) {
        const t = age[i];
        const ph = phase[i];
        const along = spd[i] * t;
        const drop = 0.5 * grav[i] * t * t;
        // лёгкое виляние поперёк пути (растёт с первых сантиметров, чтобы не выходить из ствола вбок)
        const wob = Math.min(1, along / 0.6) * 0.014;
        const wx = Math.sin(clock * 37 + ph) * wob;
        const wy = Math.cos(clock * 29 + ph * 1.3) * wob;
        const q = i * HIST * 3;
        const hx = (ext[i] ? hist[q] : ox[i] + dx[i] * along) + wx;
        const hy = (ext[i] ? hist[q + 1] : oy[i] + dy[i] * along - drop) + wy;
        const hz = ext[i] ? hist[q + 2] : oz[i] + dz[i] * along;
        const dist = Math.hypot(hx - camPos.x, hy - camPos.y, hz - camPos.z);
        const pulse = 1 + 0.18 * Math.sin(clock * 55 + ph);
        // вдали не меньше ~0,35° — сгусток видно и на 40 м
        put(hx, hy, hz, Math.max(0.09, dist * 0.004) * pulse, cr[i], cg[i], cb[i], 1, 0, 0);
        // хвост: мягкие свечения по пути назад, мерцают
        const stepT = TRAIL_M / TRAIL / spd[i];
        if (ext[i]) {
          // кривой путь: по ломаной последних положений головы, через равные TRAIL_M / TRAIL м
          const spacing = TRAIL_M / TRAIL;
          let s = 0; // отрезок hist[s] → hist[s + 1]
          let walked = 0; // м пройдено до начала отрезка s
          for (let k = 1; k <= TRAIL && s < histN[i] - 1; k += 1) {
            const want = k * spacing;
            let a = q + s * 3;
            let len = Math.hypot(hist[a + 3] - hist[a], hist[a + 4] - hist[a + 1], hist[a + 5] - hist[a + 2]);
            while (walked + len < want && s < histN[i] - 2) {
              walked += len;
              s += 1;
              a = q + s * 3;
              len = Math.hypot(hist[a + 3] - hist[a], hist[a + 4] - hist[a + 1], hist[a + 5] - hist[a + 2]);
            }
            if (walked + len < want) break; // ломаная кончилась (у дула)
            const u = len > 1e-6 ? (want - walked) / len : 0;
            const f = 1 - k / (TRAIL + 1);
            const shimmer = 0.55 + 0.45 * Math.sin(clock * 48 + k * 1.9 + ph);
            put(
              hist[a] + (hist[a + 3] - hist[a]) * u + wx * f,
              hist[a + 1] + (hist[a + 4] - hist[a + 1]) * u + wy * f,
              hist[a + 2] + (hist[a + 5] - hist[a + 2]) * u,
              Math.max(0.11, dist * 0.0045) * (0.4 + 0.6 * f),
              cr[i] * 0.8, cg[i] * 0.9, cb[i], 0.6 * f * shimmer, 1, 0,
            );
          }
        }
        for (let k = 1; k <= TRAIL && !ext[i]; k += 1) {
          const tk = t - k * stepT;
          if (tk <= 0) break;
          const ak = spd[i] * tk;
          const f = 1 - k / (TRAIL + 1);
          const shimmer = 0.55 + 0.45 * Math.sin(clock * 48 + k * 1.9 + ph);
          put(
            ox[i] + dx[i] * ak + wx * f,
            oy[i] + dy[i] * ak - 0.5 * grav[i] * tk * tk + wy * f,
            oz[i] + dz[i] * ak,
            Math.max(0.11, dist * 0.0045) * (0.4 + 0.6 * f),
            cr[i] * 0.8, cg[i] * 0.9, cb[i], 0.6 * f * shimmer, 1, 0,
          );
        }
        // искорки слетают с сгустка
        emit[i] += dt * SPARKS_PER_S;
        while (emit[i] >= 1) {
          emit[i] -= 1;
          const j = part(hx, hy, hz, 3, rand(0.2, 0.4), rand(0.01, 0.02), 0.003, cr[i], cg[i], cb[i], 0.9);
          vx[j] = rand(-0.6, 0.6) - dx[i] * 1.5;
          vy[j] = rand(-0.6, 0.6) - dy[i] * 1.5;
          vz[j] = rand(-0.6, 0.6) - dz[i] * 1.5;
          pDrag[j] = 2;
          pGrav[j] = 0.6;
          pSpin[j] = rand(-8, 8);
        }
      }
      // частицы
      for (let i = parts - 1; i >= 0; i -= 1) {
        pAge[i] += dt;
        if (pAge[i] >= pLife[i]) {
          parts -= 1;
          copyPart(i, parts);
        }
      }
      for (let i = 0; i < parts; i += 1) {
        const keep = Math.max(0, 1 - pDrag[i] * dt);
        vx[i] *= keep; vy[i] *= keep; vz[i] *= keep;
        vy[i] -= pGrav[i] * dt;
        px[i] += vx[i] * dt; py[i] += vy[i] * dt; pz[i] += vz[i] * dt;
        pRot[i] += pSpin[i] * dt;
        const u = pAge[i] / pLife[i];
        const twinkle = pKind[i] === 3 ? 0.6 + 0.4 * Math.sin(clock * 60 + i * 2.3) : 1;
        put(px[i], py[i], pz[i], s0[i] + (s1[i] - s0[i]) * u, pr[i], pg[i], pb[i], pA[i] * (1 - u) * (1 - u * 0.3) * twinkle, pKind[i], pRot[i]);
      }
      if (m > 0 || geometry.instanceCount > 0) {
        for (const attr of attrs) {
          attr.clearUpdateRanges();
          attr.addUpdateRange(0, Math.max(1, m) * attr.itemSize);
          attr.needsUpdate = true;
        }
      }
      geometry.instanceCount = m;
      // пустой видимый меш тоже стоит CPU (программа и униформы на каждый глаз): скрыт, пока пусто;
      // первые кадры виден — шейдер собирается при подмене сцены (материал держит программу)
      if (warmFrames < 3) warmFrames += 1;
      mesh.visible = m > 0 || warmFrames < 3;
    },
    // для vr:eval
    stats: () => ({ orbs, parts, drawn: geometry.instanceCount }),
    dispose() {
      group.remove(mesh);
      geometry.dispose();
      material.dispose();
      orbs = 0;
      parts = 0;
    },
  };
}
