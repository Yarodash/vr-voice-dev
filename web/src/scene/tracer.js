// Трассер пули (траекторию и попадание считает shooting.js — пуля с гравитацией): тонкое раскалённое ядро в мягкой рваной мерцающей оболочке (шум вдоль длины,
// сужается к концам, почти прозрачная — как струя горячего воздуха, а не лазер). Она летит от дула к
// точке попадания со скоростью пули, за ней — слабая линия вдоль всего пути; после попадания она
// за ~1 с расплывается на месте: ширится, становится мягче и рванее и блекнет в серую дымку. Все трассеры — одна сетка, один вызов отрисовки; пока
// трассеров нет — ни одного вызова. Трассер виден у каждого выстрела.

// Путь пули — парабола: точка в s м от дула (по прямой ствола) = from + dir·s − (0, k·s², 0),
// k = g / (2·v²) — ровно та же, что у пули в shooting.js (одинаковые dt — голова трассера там же, где пуля).
const MAX = 32; // одновременно летящих пуль (живут до ~3 с)
const STREAK_S = 2.2 / 420; // длина раскалённой чёрточки — путь пули за это время (2,2 м при 420 м/с)
const TRAIL_MAX = 120; // м: след тянется не дальше этого за головой (дальний промах — не через всё небо)
const SEG = 16; // поперечных разрезов вдоль полоски: длинный след гнётся по параболе
const STREAK_HALF_WIDTH = 0.012; // м: мягкая «оболочка» ~2,4 см (было 4 см); ядро в ней тонкое
const TRAIL_HALF_WIDTH = 0.005; // было 0.008
const TRAIL_ALPHA = 0.45;
const TRAIL_DISSIPATE = 1.0; // с — за это время след после попадания расплывается в дымку
const TRAIL_FADE = 0.3; // с — постоянная затухания следа после попадания (~0,8 с до невидимости; было 0,06)

const vertexShader = /* glsl */ `
  attribute vec4 aFrom; // начало пути, w — яркость (она же зерно шума)
  attribute vec4 aDir;  // направление, w — 0 чёрточка; 1 + d — след, d 0..1 — насколько расплылся
  attribute vec4 aSpan; // хвост и голова (м от начала), прозрачность, полуширина оболочки (м)
  attribute float aGrav; // k: на s м пути пуля опустилась на k·s² (гравитация)
  varying vec2 vUv;
  varying float vAlpha;
  varying float vKind;
  varying float vAlong;
  varying float vCore;
  varying float vFar;
  varying float vSeed;
  varying float vDiss;
  varying vec2 vEnds; // м от хвоста и до головы
  void main() {
    float along = mix(aSpan.x, aSpan.y, position.x);
    vec3 wp = aFrom.xyz + aDir.xyz * along;
    wp.y -= aGrav * along * along;
    vec3 tang = normalize(aDir.xyz - vec3(0.0, 2.0 * aGrav * along, 0.0));
    // след расплывается на месте (ширина, мягкость, рваность, цвет — во фрагментном шейдере), не смещаясь
    float d = max(aDir.w - 1.0, 0.0);
    vDiss = d;
    vEnds = vec2(along - aSpan.x, aSpan.y - along);
    vec3 toCam = cameraPosition - wp;
    float dist = length(toCam);
    vec3 side = normalize(cross(toCam / max(dist, 1e-4), tang)); // так квад смотрит на камеру
    // вдали полоска не тоньше нескольких пикселей, но оболочка там бледнее
    float w = max(aSpan.w, dist * 0.004);
    wp += side * position.y * w;
    gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
    vUv = position.xy;
    vAlong = along;
    vCore = max(0.0022, dist * 0.0011) / w; // доля ширины под ядро (не тоньше ~пикселя)
    vFar = pow(aSpan.w / w, 0.35);
    vAlpha = aSpan.z * aFrom.w;
    vKind = step(0.5, aDir.w);
    vSeed = aFrom.w * 137.0;
  }
`;

const fragmentShader = /* glsl */ `
  uniform float uTime;
  varying vec2 vUv;
  varying float vAlpha;
  varying float vKind;
  varying float vAlong;
  varying float vCore;
  varying float vFar;
  varying float vSeed;
  varying float vDiss;
  varying vec2 vEnds;
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float vnoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
  }
  void main() {
    float t = vUv.x; // 0 — хвост, 1 — голова
    float y = abs(vUv.y);
    // шум бежит вдоль полоски и мерцает (время сцены: в замедлении мерцает медленнее)
    vec2 np = vec2(vAlong * 9.0 - uTime * 14.0 + vSeed, vUv.y * 1.6 + uTime * 3.0);
    float n1 = vnoise(np);
    float n2 = vnoise(np * 2.7 + 17.0);
    float n = n1 * 0.65 + n2 * 0.35;
    vec3 col;
    if (vKind < 0.5) {
      // сужается к обоим концам, ширина «гуляет», край рваный, оболочка почти прозрачная
      float taper = smoothstep(0.0, 0.2, t) * (1.0 - smoothstep(0.9, 1.0, t));
      float wf = max(taper * (0.5 + 0.65 * n1), 0.02);
      float edge = y / wf + (n2 - 0.5) * 0.55;
      // мелкое «зерно» — шершавость оболочки и ядра
      float n3 = vnoise(vec2(vAlong * 38.0 - uTime * 40.0 + vSeed, vUv.y * 5.0 - uTime * 9.0));
      float sheath = (1.0 - smoothstep(0.2, 1.0, edge)) * (0.14 + 0.75 * n * n) * (0.55 + 0.7 * n3);
      // ядро не идеально прямое и рвётся: чуть виляет поперёк и гаснет пятнами
      float yc = abs(vUv.y - (n2 - 0.5) * 0.18 * wf);
      float cw = vCore * max(taper, 0.08) * (0.7 + 0.6 * n2);
      float core = exp(-(yc * yc) / (cw * cw) * 1.4) * taper * (0.3 + 0.9 * n1 * (0.6 + 0.6 * n3));
      float head = 0.35 + 0.65 * t;
      col = vec3(1.0, 0.42, 0.12) * sheath * 1.1 * vFar * head
          + mix(vec3(1.0, 0.5, 0.18), vec3(1.0, 0.82, 0.5), smoothstep(0.5, 0.95, t)) * core * 2.2 * head;
    } else {
      // расплывание спокойное: узор шума привязан к месту на пути (частоты постоянные) и лишь медленно
      // меняется (≤ 0,5 Гц); край мягчеет и чуть рвётся, появляются плавные просветы, цвет — в серую дымку
      float d = vDiss;
      float m1 = vnoise(vec2(vAlong * 4.0 + vSeed, vUv.y * 1.5 + uTime * 0.4));
      float m2 = vnoise(vec2(vAlong * 9.0 + vSeed + 5.0, vUv.y * 2.5 - uTime * 0.3));
      float mm = m1 * 0.6 + m2 * 0.4;
      // мягкие рваные концы: у дула (~0,45 м) и у дальнего конца (~0,3 м) след сходит на нет и сужается
      float ends = smoothstep(0.0, 0.45, vEnds.x + (m2 - 0.5) * 0.2) * smoothstep(0.0, 0.3, vEnds.y + (m1 - 0.5) * 0.12);
      float edge = y / max((0.7 + 0.3 * m1) * ends, 0.02) + (m2 - 0.5) * (0.12 + 0.3 * d);
      float a = (1.0 - smoothstep(0.15 * (1.0 - d), 1.0, edge)) * (0.55 + 0.45 * mm);
      float holes = vnoise(vec2(vAlong * 1.6 + vSeed + 9.0, uTime * 0.25));
      a *= smoothstep(d * 0.4, d * 0.4 + 0.45, holes); // просветы плавно растут по мере расплывания
      a *= mix(0.35 + 0.65 * t, 1.0, d); // дымка уже ровная по длине
      a *= ends;
      vec3 warm = vec3(1.0, 0.4, 0.13);
      vec3 haze = vec3(0.42, 0.42, 0.46);
      col = mix(warm, haze, smoothstep(0.0, 0.55, d)) * a * vFar;
    }
    gl_FragColor = vec4(col, vAlpha);
    #include <colorspace_fragment>
  }
`;

export function createTracers({ THREE, group }) {
  const geometry = new THREE.InstancedBufferGeometry();
  // x: 0 хвост … 1 голова (SEG кусков, чтобы след гнулся); y: −1 … 1 поперёк
  const verts = [];
  const index = [];
  for (let k = 0; k <= SEG; k += 1) {
    verts.push(k / SEG, -1, 0, k / SEG, 1, 0);
    if (k < SEG) {
      const a = k * 2;
      index.push(a, a + 2, a + 3, a, a + 3, a + 1);
    }
  }
  geometry.setIndex(index);
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  const N = MAX * 2;
  const fromArr = new Float32Array(N * 4);
  const dirArr = new Float32Array(N * 4);
  const spanArr = new Float32Array(N * 4);
  const gravArr = new Float32Array(N);
  const attrs = [
    ['aFrom', fromArr, 4],
    ['aDir', dirArr, 4],
    ['aSpan', spanArr, 4],
    ['aGrav', gravArr, 1],
  ].map(([name, arr, size]) => {
    const attr = new THREE.InstancedBufferAttribute(arr, size).setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute(name, attr);
    return attr;
  });
  geometry.instanceCount = 0;

  const uTime = { value: 0 };
  const material = new THREE.ShaderMaterial({
    uniforms: { uTime },
    vertexShader,
    fragmentShader,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'bullet-tracers';
  mesh.frustumCulled = false; // всегда видима: шейдер собран заранее; при 0 экземплярах вызова нет
  mesh.renderOrder = 3;
  group.add(mesh);

  // летящие пули: плотные массивы, живые — первые count
  const sx = new Float32Array(MAX), sy = new Float32Array(MAX), sz = new Float32Array(MAX);
  const dx = new Float32Array(MAX), dy = new Float32Array(MAX), dz = new Float32Array(MAX);
  const len = new Float32Array(MAX), age = new Float32Array(MAX), bright = new Float32Array(MAX);
  const spd = new Float32Array(MAX), grav = new Float32Array(MAX), ids = new Int32Array(MAX);
  let count = 0;
  let nextId = 1;
  let warm = 0; // кадров после создания (см. конец update)

  const copy = (i, j) => {
    sx[i] = sx[j]; sy[i] = sy[j]; sz[i] = sz[j];
    dx[i] = dx[j]; dy[i] = dy[j]; dz[i] = dz[j];
    len[i] = len[j]; age[i] = age[j]; bright[i] = bright[j];
    spd[i] = spd[j]; grav[i] = grav[j]; ids[i] = ids[j];
  };

  return {
    // from — дуло, dir — единичный вектор ствола, speed — м/с, gravity — м/с², maxLen — м пути до
    // исчезновения, если пуля так ни во что и не попала. Возвращает номер трассера для land().
    fire(from, dir, speed, gravity, maxLen) {
      let i;
      if (count < MAX) i = count++;
      else {
        i = 0; // мест нет — заменить самую старую
        for (let k = 1; k < MAX; k += 1) if (age[k] > age[i]) i = k;
      }
      sx[i] = from.x; sy[i] = from.y; sz[i] = from.z;
      dx[i] = dir.x; dy[i] = dir.y; dz[i] = dir.z;
      len[i] = maxLen;
      age[i] = 0; // как у пули: в первом же кадре пролетает speed·dt
      bright[i] = 0.85 + Math.random() * 0.15;
      spd[i] = speed;
      grav[i] = gravity / (2 * speed * speed);
      ids[i] = nextId;
      nextId = (nextId + 1) % 0x7fffffff || 1;
      return ids[i];
    },

    // пуля номер id остановилась, пролетев along м (по прямой ствола): голова дальше не идёт
    land(id, along) {
      for (let i = 0; i < count; i += 1) {
        if (ids[i] !== id) continue;
        len[i] = Math.max(0.01, along);
        return;
      }
    },

    update(dtRaw) {
      const dt = Math.min(0.05, dtRaw || 0);
      uTime.value = (uTime.value + dt) % 1000;
      let n = count;
      for (let i = n - 1; i >= 0; i -= 1) {
        age[i] += dt;
        const arrivedFor = age[i] - len[i] / spd[i]; // с после попадания
        if (arrivedFor > Math.max(TRAIL_FADE * 4, TRAIL_DISSIPATE * 1.2, STREAK_S)) {
          n -= 1;
          copy(i, n);
        }
      }
      count = n;

      let m = 0;
      for (let i = 0; i < n; i += 1) {
        const SPEED = spd[i];
        const STREAK = SPEED * STREAK_S;
        const travelled = age[i] * SPEED;
        const head = Math.min(len[i], travelled);
        const k = bright[i];
        // чёрточка
        const tail = Math.min(len[i], Math.max(0, travelled - STREAK));
        if (tail < head) {
          const q = m * 4;
          fromArr[q] = sx[i]; fromArr[q + 1] = sy[i]; fromArr[q + 2] = sz[i]; fromArr[q + 3] = k;
          dirArr[q] = dx[i]; dirArr[q + 1] = dy[i]; dirArr[q + 2] = dz[i]; dirArr[q + 3] = 0;
          // хвост «тянется» за головой полной длиной, даже когда голова уже упёрлась в цель
          spanArr[q] = travelled - STREAK; spanArr[q + 1] = head; spanArr[q + 2] = 1;
          spanArr[q + 3] = STREAK_HALF_WIDTH;
          if (spanArr[q] < 0) spanArr[q] = 0;
          gravArr[m] = grav[i];
          m += 1;
        }
        // слабый след: гаснет вскоре после того, как пуля долетела
        const late = Math.max(0, (travelled - len[i]) / SPEED);
        // гаснет медленнее, пока расплывается: яркость уходит, а дымка ещё видна
        const trailAlpha = TRAIL_ALPHA * Math.exp(-late / TRAIL_FADE) * (1 + Math.min(1, late / TRAIL_DISSIPATE) * 1.5);
        const trailTail = Math.max(0, head - TRAIL_MAX); // вдоль пути от дула (у дальнего — последние TRAIL_MAX м)
        if (trailAlpha > 0.01 && trailTail < head) {
          const q = m * 4;
          fromArr[q] = sx[i]; fromArr[q + 1] = sy[i]; fromArr[q + 2] = sz[i]; fromArr[q + 3] = k;
          const d = Math.min(1, late / TRAIL_DISSIPATE);
          dirArr[q] = dx[i]; dirArr[q + 1] = dy[i]; dirArr[q + 2] = dz[i]; dirArr[q + 3] = 1 + d;
          spanArr[q] = trailTail; spanArr[q + 1] = head; spanArr[q + 2] = trailAlpha;
          spanArr[q + 3] = TRAIL_HALF_WIDTH * (1 + 3 * d ** 0.7); // расплывается вширь до 4×
          gravArr[m] = grav[i];
          m += 1;
        }
      }
      if (m > 0 || geometry.instanceCount > 0) {
        for (const attr of attrs) {
          attr.clearUpdateRanges();
          attr.addUpdateRange(0, Math.max(1, m) * attr.itemSize);
          attr.needsUpdate = true;
        }
      }
      geometry.instanceCount = m;
      // пустой видимый меш тоже стоит CPU (программа и униформы ставятся на каждый глаз): скрыт, пока
      // пусто; первые кадры виден — шейдер собирается при подмене сцены (material держит программу)
      if (warm < 3) warm += 1;
      mesh.visible = m > 0 || warm < 3;
    },

    dispose() {
      group.remove(mesh);
      geometry.dispose();
      material.dispose();
      count = 0;
    },
  };
}
