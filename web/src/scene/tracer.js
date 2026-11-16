// Трассер пули: тонкое раскалённое ядро в мягкой рваной мерцающей оболочке (шум вдоль длины,
// сужается к концам, почти прозрачная — как струя горячего воздуха, а не лазер). Она летит от дула к
// точке попадания со скоростью пули, за ней — слабая линия вдоль всего пути; после попадания она
// за ~1 с расплывается на месте: ширится, становится мягче и рванее и блекнет в серую дымку. Все трассеры — одна сетка, один вызов отрисовки; пока
// трассеров нет — ни одного вызова. Трассер виден у каждого выстрела.

const MAX = 12; // одновременно летящих пуль
const SPEED = 420; // м/с на вид (было 190; пользователь попросил быстрее)
const STREAK = 2.2; // длина раскалённой чёрточки, м
const STREAK_HALF_WIDTH = 0.012; // м: мягкая «оболочка» ~2,4 см (было 4 см); ядро в ней тонкое
const TRAIL_HALF_WIDTH = 0.005; // было 0.008
const TRAIL_ALPHA = 0.45;
const TRAIL_DISSIPATE = 1.0; // с — за это время след после попадания расплывается в дымку
const TRAIL_FADE = 0.3; // с — постоянная затухания следа после попадания (~0,8 с до невидимости; было 0,06)

const vertexShader = /* glsl */ `
  attribute vec4 aFrom; // начало пути, w — яркость (она же зерно шума)
  attribute vec4 aDir;  // направление, w — 0 чёрточка; 1 + d — след, d 0..1 — насколько расплылся
  attribute vec4 aSpan; // хвост и голова (м от начала), прозрачность, полуширина оболочки (м)
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
    // след расплывается на месте (ширина, мягкость, рваность, цвет — во фрагментном шейдере), не смещаясь
    float d = max(aDir.w - 1.0, 0.0);
    vDiss = d;
    vEnds = vec2(along - aSpan.x, aSpan.y - along);
    vec3 toCam = cameraPosition - wp;
    float dist = length(toCam);
    vec3 side = normalize(cross(toCam / max(dist, 1e-4), aDir.xyz)); // так квад смотрит на камеру
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
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  // x: 0 хвост … 1 голова; y: −1 … 1 поперёк
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([0, -1, 0, 1, -1, 0, 1, 1, 0, 0, 1, 0], 3));
  const N = MAX * 2;
  const fromArr = new Float32Array(N * 4);
  const dirArr = new Float32Array(N * 4);
  const spanArr = new Float32Array(N * 4);
  const attrs = [
    ['aFrom', fromArr],
    ['aDir', dirArr],
    ['aSpan', spanArr],
  ].map(([name, arr]) => {
    const attr = new THREE.InstancedBufferAttribute(arr, 4).setUsage(THREE.DynamicDrawUsage);
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
  let count = 0;

  const copy = (i, j) => {
    sx[i] = sx[j]; sy[i] = sy[j]; sz[i] = sz[j];
    dx[i] = dx[j]; dy[i] = dy[j]; dz[i] = dz[j];
    len[i] = len[j]; age[i] = age[j]; bright[i] = bright[j];
  };

  return {
    fire(from, to) {
      const ex = to.x - from.x, ey = to.y - from.y, ez = to.z - from.z;
      const L = Math.hypot(ex, ey, ez);
      if (L < 0.05) return;
      let i;
      if (count < MAX) i = count++;
      else {
        i = 0; // мест нет — заменить самую старую
        for (let k = 1; k < MAX; k += 1) if (age[k] > age[i]) i = k;
      }
      sx[i] = from.x; sy[i] = from.y; sz[i] = from.z;
      dx[i] = ex / L; dy[i] = ey / L; dz[i] = ez / L;
      len[i] = L;
      age[i] = -0.004; // в первом же кадре чёрточка уже вылетела из дула
      bright[i] = 0.85 + Math.random() * 0.15;
    },

    update(dtRaw) {
      const dt = Math.min(0.05, dtRaw || 0);
      uTime.value = (uTime.value + dt) % 1000;
      let n = count;
      for (let i = n - 1; i >= 0; i -= 1) {
        age[i] += dt;
        const travelled = Math.max(0, age[i]) * SPEED;
        const arrivedFor = (travelled - len[i]) / SPEED; // с после попадания
        if (arrivedFor > Math.max(TRAIL_FADE * 4, TRAIL_DISSIPATE * 1.2, STREAK / SPEED)) {
          n -= 1;
          copy(i, n);
        }
      }
      count = n;

      let m = 0;
      for (let i = 0; i < n; i += 1) {
        const travelled = (Math.max(0, age[i]) + 0.004) * SPEED;
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
          m += 1;
        }
        // слабый след: гаснет вскоре после того, как пуля долетела
        const late = Math.max(0, (travelled - len[i]) / SPEED);
        // гаснет медленнее, пока расплывается: яркость уходит, а дымка ещё видна
        const trailAlpha = TRAIL_ALPHA * Math.exp(-late / TRAIL_FADE) * (1 + Math.min(1, late / TRAIL_DISSIPATE) * 1.5);
        const trailTail = 0; // вдоль всего пути от дула
        if (trailAlpha > 0.01 && trailTail < head) {
          const q = m * 4;
          fromArr[q] = sx[i]; fromArr[q + 1] = sy[i]; fromArr[q + 2] = sz[i]; fromArr[q + 3] = k;
          const d = Math.min(1, late / TRAIL_DISSIPATE);
          dirArr[q] = dx[i]; dirArr[q + 1] = dy[i]; dirArr[q + 2] = dz[i]; dirArr[q + 3] = 1 + d;
          spanArr[q] = trailTail; spanArr[q + 1] = head; spanArr[q + 2] = trailAlpha;
          spanArr[q + 3] = TRAIL_HALF_WIDTH * (1 + 3 * d ** 0.7); // расплывается вширь до 4×
          m += 1;
        }
      }
      if (m > 0 || geometry.instanceCount > 0) {
        for (const attr of attrs) {
          attr.clearUpdateRanges();
          attr.addUpdateRange(0, Math.max(1, m) * 4);
          attr.needsUpdate = true;
        }
      }
      geometry.instanceCount = m;
    },

    dispose() {
      group.remove(mesh);
      geometry.dispose();
      material.dispose();
      count = 0;
    },
  };
}
