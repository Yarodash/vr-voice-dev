// Дым выстрела: клубы из дула, тонкая струйка над стволом, дымок из окна гильзы и пыль в месте
// попадания. Все клубы — одна сетка с одним шейдером (один вызов отрисовки на весь дым): мягкие
// повёрнутые спрайты из процедурной текстуры, освещённые закатным солнцем справа (+X).
// Частицы считаются на процессоре без выделения памяти в кадре; пока дыма нет — ни одного вызова.

const DENSITY = 0.5; // густота всего дыма: 1 — как было, 0,5 — вдвое реже
const CAP = 280; // не больше стольких клубов одновременно; лишний заменяет самый старый (+80 — след ракет, arena-weapons.js)

// Ветер и солнце: солнце низко справа (+X), ветер оттуда же — дым сносит к −X.
const WIND_X = -0.11;
const WIND_Z = 0.015;
const SUN = [0.99, 0.04, 0.139];

// ---- текстура: 2×2 варианта клуба 128×128, плотность в альфе, «рельеф» в RGB
function makeSmokeTexture(THREE) {
  const CELL = 128;
  const SIZE = CELL * 2;
  let seed = 1234567;
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const perm = new Uint8Array(512);
  const lattice = new Float32Array(256);
  for (let i = 0; i < 256; i += 1) {
    perm[i] = i;
    lattice[i] = rand();
  }
  for (let i = 255; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    const t = perm[i];
    perm[i] = perm[j];
    perm[j] = t;
  }
  for (let i = 0; i < 256; i += 1) perm[i + 256] = perm[i];
  const noise = (x, y) => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const xf = x - xi;
    const yf = y - yi;
    const u = xf * xf * (3 - 2 * xf);
    const v = yf * yf * (3 - 2 * yf);
    const a = xi & 255;
    const b = yi & 255;
    const n00 = lattice[perm[perm[a] + b]];
    const n10 = lattice[perm[perm[a + 1] + b]];
    const n01 = lattice[perm[perm[a] + b + 1]];
    const n11 = lattice[perm[perm[a + 1] + b + 1]];
    return (n00 + (n10 - n00) * u) + ((n01 + (n11 - n01) * u) - (n00 + (n10 - n00) * u)) * v;
  };
  const fbm = (x, y) => {
    let sum = 0;
    let amp = 0.5;
    let norm = 0;
    for (let o = 0; o < 4; o += 1) {
      sum += noise(x, y) * amp;
      norm += amp;
      amp *= 0.45;
      x *= 2.03;
      y *= 2.03;
    }
    return sum / norm;
  };
  const smooth = (e0, e1, x) => {
    const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
    return t * t * (3 - 2 * t);
  };
  const data = new Uint8Array(SIZE * SIZE * 4);
  for (let cell = 0; cell < 4; cell += 1) {
    const ox = (cell % 2) * CELL;
    const oy = Math.floor(cell / 2) * CELL;
    const sx = cell * 17.3 + 3.1;
    const sy = cell * 9.7 + 7.9;
    for (let y = 0; y < CELL; y += 1) {
      for (let x = 0; x < CELL; x += 1) {
        const u = ((x + 0.5) / CELL) * 2 - 1;
        const v = ((y + 0.5) / CELL) * 2 - 1;
        const r = Math.hypot(u, v);
        const big = fbm(u * 1.6 + sx, v * 1.6 + sy); // крупные «бугры» края
        const mid = fbm(u * 2.8 + sx + 11.1, v * 2.8 + sy + 5.3); // клубы внутри
        const fine = fbm(u * 7 + sx + 4.7, v * 7 + sy + 2.9); // лёгкая мелкая фактура
        const edge = r + (big - 0.5) * 0.75;
        let a = 1 - smooth(0.2, 0.92, edge);
        a *= (0.55 + 0.6 * mid) * (0.9 + 0.2 * fine);
        a *= 1 - smooth(0.82, 0.99, r); // к краю клетки — ноль, чтобы mip-уровни не смешивались
        a = Math.min(1, Math.max(0, a));
        const detail = Math.min(1, Math.max(0, 0.5 + (mid - 0.5) * 1.9 + (fine - 0.5) * 0.35));
        const i = ((oy + y) * SIZE + ox + x) * 4;
        data[i] = data[i + 1] = data[i + 2] = Math.round(detail * 255);
        data[i + 3] = Math.round(a * 255);
      }
    }
  }
  const texture = new THREE.DataTexture(data, SIZE, SIZE, THREE.RGBAFormat, THREE.UnsignedByteType);
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}

const vertexShader = /* glsl */ `
  attribute vec4 iPos;   // xyz — место, w — возраст 0..1
  attribute vec4 iData;  // размер (полуширина, м), поворот, прозрачность, вариант + 4 * вид
  uniform vec3 sunDir;
  varying vec2 vUv;
  varying vec2 vCorner;
  varying float vAlpha;
  varying float vHeat;
  varying float vKind;
  varying vec3 vSun;
  varying vec3 vView;
  void main() {
    float c = cos(iData.y);
    float s = sin(iData.y);
    vec2 corner = position.xy;
    vec2 rc = vec2(c * corner.x - s * corner.y, s * corner.x + c * corner.y);
    vec4 mv = modelViewMatrix * vec4(iPos.xyz, 1.0);
    mv.xy += rc * iData.x;
    gl_Position = projectionMatrix * mv;

    float cell = mod(iData.w, 4.0);
    vKind = floor(iData.w / 4.0 + 0.01);
    vUv = (corner * 0.5 + 0.5) * 0.5 + vec2(mod(cell, 2.0), floor(cell / 2.0 + 0.01)) * 0.5;
    vCorner = rc;
    // у самых глаз дым прозрачнее: не застилает обзор и не нагружает заливку
    vAlpha = iData.z * smoothstep(0.07, 0.32, -mv.z);
    vHeat = 1.0 - smoothstep(0.0, 0.035, iPos.w);
    vSun = normalize((viewMatrix * vec4(sunDir, 0.0)).xyz);
    vView = normalize(mv.xyz);
  }
`;

const fragmentShader = /* glsl */ `
  uniform sampler2D map;
  varying vec2 vUv;
  varying vec2 vCorner;
  varying float vAlpha;
  varying float vHeat;
  varying float vKind;
  varying vec3 vSun;
  varying vec3 vView;
  void main() {
    vec4 tex = texture2D(map, vUv);
    float density = tex.a * vAlpha;
    float detail = tex.r;
    // клуб как шар: нормаль из положения на спрайте; рельеф текстуры добавляет самозатенение
    vec2 cc = vCorner;
    vec3 n = normalize(vec3(cc, sqrt(max(0.0, 1.0 - dot(cc, cc))) * 0.9 + 0.2));
    float ndl = dot(n, vSun);
    float lit = smoothstep(-0.35, 0.95, ndl) * (0.45 + 0.8 * detail);
    // тень — сумеречная сизая (у пыли — тёплая серая), свет — закатный оранжевый
    vec3 shade = mix(vec3(0.17, 0.19, 0.29), vec3(0.26, 0.23, 0.21), vKind);
    vec3 sunCol = mix(vec3(1.9, 0.95, 0.45), vec3(1.8, 1.05, 0.55), vKind);
    vec3 col = shade * (0.6 + 0.6 * detail) + sunCol * lit;
    // против солнца тонкий дым светится насквозь
    float back = pow(max(dot(vView, vSun), 0.0), 5.0);
    col += vec3(1.8, 0.85, 0.38) * back * (1.0 - tex.a * 0.6);
    // в первые мгновения дым подсвечен вспышкой
    col += vec3(2.4, 1.15, 0.45) * vHeat;
    gl_FragColor = vec4(col, density);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

export function createSmoke({ THREE, group }) {
  // текстура считается ~40 мс на шлеме: один раз, при подмене сцены — из памяти (ключ — код функции)
  const shared = (globalThis.__sceneState ??= {});
  const textureKey = makeSmokeTexture.toString();
  if (shared.smokeTexture?.key !== textureKey) shared.smokeTexture = { key: textureKey, texture: makeSmokeTexture(THREE) };
  const texture = shared.smokeTexture.texture;

  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  geometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3),
  );
  const posArray = new Float32Array(CAP * 4);
  const dataArray = new Float32Array(CAP * 4);
  const posAttr = new THREE.InstancedBufferAttribute(posArray, 4).setUsage(THREE.DynamicDrawUsage);
  const dataAttr = new THREE.InstancedBufferAttribute(dataArray, 4).setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('iPos', posAttr);
  geometry.setAttribute('iData', dataAttr);
  geometry.instanceCount = 0;

  const material = new THREE.ShaderMaterial({
    uniforms: {
      map: { value: texture },
      sunDir: { value: new THREE.Vector3(...SUN).normalize() },
    },
    vertexShader,
    fragmentShader,
    transparent: true,
    depthWrite: false,
    blending: THREE.NormalBlending,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'gun-smoke';
  // Сетка всегда видима: шейдер собирается сразу при появлении сцены, а не на первом выстреле
  // (иначе подвисание). При instanceCount = 0 three.js не делает вызова отрисовки.
  mesh.frustumCulled = false;
  mesh.renderOrder = 2;
  const eye = new THREE.Vector3();
  let haveEye = false;
  mesh.onBeforeRender = (renderer, scene, camera) => {
    eye.setFromMatrixPosition(camera.matrixWorld);
    haveEye = true;
  };
  group.add(mesh);

  // ---- частицы: плотные массивы, живые — первые count
  const px = new Float32Array(CAP), py = new Float32Array(CAP), pz = new Float32Array(CAP);
  const vx = new Float32Array(CAP), vy = new Float32Array(CAP), vz = new Float32Array(CAP);
  const age = new Float32Array(CAP), life = new Float32Array(CAP);
  const size0 = new Float32Array(CAP), size1 = new Float32Array(CAP);
  const rot = new Float32Array(CAP), spin = new Float32Array(CAP);
  const alpha = new Float32Array(CAP), drag = new Float32Array(CAP), rise = new Float32Array(CAP);
  const turb = new Float32Array(CAP), phase = new Float32Array(CAP), look = new Float32Array(CAP);
  const order = new Uint16Array(CAP);
  const dist = new Float32Array(CAP);
  let count = 0;
  let time = 0;
  let warmFrames = 0; // кадров после создания (конец update: пустой меш скрыт)

  const random = (a, b) => a + Math.random() * (b - a);

  // look: вариант текстуры 0..3 + 4 * вид (0 — пороховой дым, 1 — пыль)
  function emit(x, y, z, ux, uy, uz, o) {
    let i;
    if (count < CAP) i = count++;
    else {
      i = 0; // места нет — заменяем самый «отживший» клуб
      let worst = -1;
      for (let k = 0; k < CAP; k += 1) {
        const f = age[k] / life[k];
        if (f > worst) {
          worst = f;
          i = k;
        }
      }
    }
    px[i] = x; py[i] = y; pz[i] = z;
    vx[i] = ux; vy[i] = uy; vz[i] = uz;
    age[i] = 0;
    life[i] = o.life;
    size0[i] = o.size0;
    size1[i] = o.size1;
    rot[i] = Math.random() * Math.PI * 2;
    spin[i] = o.spin ?? random(-1.2, 1.2);
    alpha[i] = o.alpha * DENSITY; // DENSITY: общая густота дыма (пользователь попросил вдвое реже)
    drag[i] = o.drag;
    rise[i] = o.rise;
    turb[i] = o.turb ?? 0.06;
    phase[i] = Math.random() * 100;
    look[i] = Math.floor(Math.random() * 4) + 4 * (o.kind ?? 0);
  }

  // общие настройки, переиспользуемые при выстреле (без новых объектов)
  const opt = { life: 1, size0: 0.01, size1: 0.1, alpha: 0.5, drag: 6, rise: 0.1, turb: 0.06, spin: undefined, kind: 0 };
  const set = (life, s0, s1, a, d, r, t, kind = 0) => {
    opt.life = life; opt.size0 = s0; opt.size1 = s1; opt.alpha = a;
    opt.drag = d; opt.rise = r; opt.turb = t; opt.kind = kind; opt.spin = undefined;
    return opt;
  };

  // струйка из дула после выстрела (раскалённый ствол дымит тем дольше, чем чаще стреляли).
  // Клубочки рождаются у ТЕКУЩЕГО дула (setMuzzle каждый кадр) и дальше живут в мире сами.
  const wisp = { x: 0, y: 0, z: 0, live: false, until: 0, next: 0 };
  let heat = 0;

  // перпендикуляры к направлению (для разлёта кольцом)
  const perpA = new THREE.Vector3();
  const perpB = new THREE.Vector3();
  const dirN = new THREE.Vector3();

  return {
    // плотный клуб из дула: часть вылетает струёй вперёд и тормозит, часть расходится кольцом
    muzzle(position, direction) {
      dirN.copy(direction).normalize();
      perpA.set(0, 1, 0).cross(dirN);
      if (perpA.lengthSq() < 1e-4) perpA.set(1, 0, 0);
      perpA.normalize();
      perpB.copy(dirN).cross(perpA);
      const { x, y, z } = position;
      // (пользователь: «поменьше дыма в начале выстрела» — клубов вдвое меньше, они вдвое прозрачнее)
      // струя вперёд: быстро гасит скорость и распускается
      for (let k = 0; k < 2; k += 1) {
        const s = random(2.2, 5.5);
        const j = 0.18;
        emit(
          x + dirN.x * 0.01, y + dirN.y * 0.01, z + dirN.z * 0.01,
          (dirN.x + random(-j, j)) * s, (dirN.y + random(-j, j)) * s, (dirN.z + random(-j, j)) * s,
          set(random(2.4, 3.4), 0.015, random(0.12, 0.2), random(0.16, 0.22), random(7, 10), random(0.06, 0.13), 0.09),
        );
      }
      // плотное ядро у самого дула
      for (let k = 0; k < 2; k += 1) {
        const s = random(0.4, 1.4);
        emit(
          x, y, z,
          dirN.x * s + random(-0.15, 0.15), dirN.y * s + random(-0.1, 0.2), dirN.z * s + random(-0.15, 0.15),
          set(random(2.2, 3.0), 0.012, random(0.08, 0.13), random(0.22, 0.3), random(5, 7), random(0.08, 0.15), 0.07),
        );
      }
      // кольцо газов вокруг дула
      for (let k = 0; k < 3; k += 1) {
        const ang = (k / 3) * Math.PI * 2 + random(-0.6, 0.6);
        const ca = Math.cos(ang) * 0.9;
        const sa = Math.sin(ang) * 0.9;
        emit(
          x + dirN.x * 0.02, y + dirN.y * 0.02, z + dirN.z * 0.02,
          perpA.x * ca + perpB.x * sa + dirN.x * 0.5,
          perpA.y * ca + perpB.y * sa + dirN.y * 0.5,
          perpA.z * ca + perpB.z * sa + dirN.z * 0.5,
          set(random(1.4, 2.0), 0.008, random(0.045, 0.07), 0.18, 6, 0.1, 0.07),
        );
      }
      heat = Math.min(5, heat + 1);
      wisp.until = time + 1.8 + heat * 0.6; // струйка из дула дольше (было 0,6 + 0,25·нагрев)
      wisp.next = time + 0.1;
    },

    // где дуло сейчас (каждый кадр); null — оружия в руке нет: струйка прекращается
    setMuzzle(position) {
      if (position) {
        wisp.x = position.x; wisp.y = position.y; wisp.z = position.z;
        wisp.live = true;
      } else {
        wisp.live = false;
        wisp.until = 0;
      }
    },

    // небольшой дымок из окна выброса гильзы
    eject(position, right, up) {
      for (let k = 0; k < 3; k += 1) {
        const r = random(0.15, 0.45);
        const u = random(0.15, 0.4);
        emit(
          position.x, position.y, position.z,
          right.x * r + up.x * u + random(-0.05, 0.05),
          right.y * r + up.y * u + random(-0.05, 0.05),
          right.z * r + up.z * u + random(-0.05, 0.05),
          set(random(1.1, 1.7), 0.006, random(0.03, 0.05), random(0.25, 0.35), 4, 0.1, 0.05),
        );
      }
    },

    // один клуб порохового дыма (след ракеты, выхлоп ракетницы — arena-weapons.js): точка, скорость, м/с,
    // полуразмер от/до, м, жизнь, с, густота (до DENSITY)
    puff(x, y, z, ux, uy, uz, s0, s1, lifeS, a) {
      emit(x, y, z, ux, uy, uz, set(lifeS, s0, s1, a, 2.2, 0.22, 0.12));
    },

    // облачко пыли в месте попадания; normal — наружу от поверхности
    // scale > 1 — крупнее, выше и дольше (пулемёт дрона: видно издалека), клубов чуть больше
    impact(point, normal, scale = 1) {
      const n = scale > 1 ? Math.min(9, Math.round(4 + scale)) : 5;
      const v = Math.sqrt(scale);
      const life = scale > 1 ? 1 + 0.25 * Math.min(scale, 4) : 1;
      for (let k = 0; k < n; k += 1) {
        const s = random(0.4, 1.4) * v;
        emit(
          point.x, point.y, point.z,
          (normal.x + random(-0.6, 0.6)) * s, (normal.y + random(-0.4, 0.8)) * s, (normal.z + random(-0.6, 0.6)) * s,
          set(random(1.3, 2.2) * life, 0.015 * scale, random(0.09, 0.17) * scale, random(0.2, 0.28), 5, 0.06, 0.08, 1),
        );
      }
    },

    update(dtRaw) {
      const dt = Math.min(0.05, dtRaw || 0);
      time += dt;
      heat = Math.max(0, heat - dt * 0.8);

      // струйка: тонкие клубочки поднимаются от дула и завиваются
      if (!wisp.live) wisp.until = 0;
      if (wisp.next < time - 0.2) wisp.next = time; // после паузы не наверстывать пачкой
      while (time < wisp.until && time >= wisp.next) {
        const left = Math.min(1, (wisp.until - time) / 1.2);
        emit(
          wisp.x + random(-0.002, 0.002), wisp.y + 0.003, wisp.z + random(-0.002, 0.002),
          random(-0.015, 0.015), random(0.05, 0.1), random(-0.015, 0.015),
          set(random(2.2, 3.2), 0.003, random(0.018, 0.03), 0.04 + left * 0.08, 3, 0.12, 0.06),
        );
        wisp.next += 0.06;
      }

      let n = count;
      for (let i = n - 1; i >= 0; i -= 1) {
        age[i] += dt;
        if (age[i] >= life[i]) {
          // убрать: на его место — последний
          n -= 1;
          px[i] = px[n]; py[i] = py[n]; pz[i] = pz[n];
          vx[i] = vx[n]; vy[i] = vy[n]; vz[i] = vz[n];
          age[i] = age[n]; life[i] = life[n];
          size0[i] = size0[n]; size1[i] = size1[n];
          rot[i] = rot[n]; spin[i] = spin[n];
          alpha[i] = alpha[n]; drag[i] = drag[n]; rise[i] = rise[n];
          turb[i] = turb[n]; phase[i] = phase[n]; look[i] = look[n];
          continue;
        }
        // скорость стремится к сносу ветром и медленному подъёму; чем больше drag, тем быстрее
        const k = 1 - Math.exp(-drag[i] * dt);
        vx[i] += (WIND_X - vx[i]) * k;
        vy[i] += (rise[i] - vy[i]) * k;
        vz[i] += (WIND_Z - vz[i]) * k;
        // завихрения: растут с возрастом клуба
        const t = time * 1.3 + phase[i];
        const a = turb[i] * Math.min(1, age[i] * 1.5);
        const x = px[i], y = py[i], z = pz[i];
        const tx = Math.sin(y * 9.1 + t) * Math.cos(z * 7.3 - t * 0.7);
        const ty = Math.sin(z * 8.7 + t * 0.9) * Math.cos(x * 6.9 + t * 0.5) * 0.6;
        const tz = Math.sin(x * 8.3 - t * 1.1) * Math.cos(y * 7.7 + t * 0.6);
        px[i] = x + (vx[i] + tx * a) * dt;
        py[i] = y + (vy[i] + ty * a) * dt;
        pz[i] = z + (vz[i] + tz * a) * dt;
        rot[i] += spin[i] * dt;
        spin[i] *= 1 - Math.min(1, dt * 0.6);
      }
      count = n;

      // дальние рисуются первыми (иначе ближний клуб «прорезает» дальний)
      for (let i = 0; i < n; i += 1) {
        order[i] = i;
        if (haveEye) {
          const dx = px[i] - eye.x, dy = py[i] - eye.y, dz = pz[i] - eye.z;
          dist[i] = dx * dx + dy * dy + dz * dz;
        } else dist[i] = -i;
      }
      for (let i = 1; i < n; i += 1) {
        const o = order[i];
        const d = dist[o];
        let j = i - 1;
        while (j >= 0 && dist[order[j]] < d) {
          order[j + 1] = order[j];
          j -= 1;
        }
        order[j + 1] = o;
      }

      for (let s = 0; s < n; s += 1) {
        const i = order[s];
        const f = age[i] / life[i];
        const g = 1 - (1 - f) ** 3; // быстро распускается, потом медленно
        const fadeIn = Math.min(1, f * 25);
        const q = s * 4;
        posArray[q] = px[i];
        posArray[q + 1] = py[i];
        posArray[q + 2] = pz[i];
        posArray[q + 3] = f;
        dataArray[q] = size0[i] + (size1[i] - size0[i]) * g;
        dataArray[q + 1] = rot[i];
        dataArray[q + 2] = alpha[i] * fadeIn * (1 - f) ** 1.25;
        dataArray[q + 3] = look[i];
      }
      if (n > 0 || geometry.instanceCount > 0) {
        posAttr.clearUpdateRanges();
        dataAttr.clearUpdateRanges();
        posAttr.addUpdateRange(0, Math.max(1, n) * 4);
        dataAttr.addUpdateRange(0, Math.max(1, n) * 4);
        posAttr.needsUpdate = true;
        dataAttr.needsUpdate = true;
      }
      geometry.instanceCount = n;
      // пустой видимый меш тоже стоит CPU (программа и униформы на каждый глаз): скрыт, пока пусто;
      // первые кадры виден — шейдер собирается при подмене сцены (материал держит программу)
      if (warmFrames < 3) warmFrames += 1;
      mesh.visible = n > 0 || warmFrames < 3;
    },

    get count() {
      return count;
    },

    dispose() {
      group.remove(mesh);
      geometry.dispose();
      material.dispose(); // texture живёт в shared.smokeTexture
      count = 0;
    },
  };
}
