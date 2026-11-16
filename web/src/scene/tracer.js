// Трассер пули: короткая тонкая раскалённая чёрточка летит от дула к точке попадания со скоростью
// пули (замедленно, чтобы глаз успел проследить), за ней — слабая линия вдоль всего пути, которая
// гаснет за ~0,15 с после попадания. Все трассеры — одна сетка, один вызов отрисовки; пока
// трассеров нет — ни одного вызова. Трассер виден у каждого выстрела.

const MAX = 12; // одновременно летящих пуль
const SPEED = 190; // м/с на вид — успеваешь проследить даже на 5 м
const STREAK = 2.2; // длина раскалённой чёрточки, м
const STREAK_HALF_WIDTH = 0.005; // м: ядро ~8 мм
const TRAIL_HALF_WIDTH = 0.002;
const TRAIL_ALPHA = 0.45;
const TRAIL_FADE = 0.06; // с — постоянная затухания следа после попадания (~0,15 с до невидимости)

const vertexShader = /* glsl */ `
  attribute vec4 aFrom; // начало пути, w — яркость
  attribute vec4 aDir;  // направление, w — 0 чёрточка, 1 след
  attribute vec4 aSpan; // хвост и голова (м от начала), прозрачность, полуширина (м)
  varying vec2 vUv;
  varying float vAlpha;
  varying float vKind;
  void main() {
    float along = mix(aSpan.x, aSpan.y, position.x);
    vec3 wp = aFrom.xyz + aDir.xyz * along;
    vec3 toCam = cameraPosition - wp;
    float dist = length(toCam);
    vec3 side = normalize(cross(toCam / max(dist, 1e-4), aDir.xyz)); // так квад смотрит на камеру
    // вдали не тоньше ~пикселя: ширина растёт с расстоянием, а яркость чуть падает
    float w = max(aSpan.w, dist * (aDir.w < 0.5 ? 0.0013 : 0.0009));
    wp += side * position.y * w;
    gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
    vUv = position.xy;
    vAlpha = aSpan.z * aFrom.w * sqrt(aSpan.w / w);
    vKind = aDir.w;
  }
`;

const fragmentShader = /* glsl */ `
  varying vec2 vUv;
  varying float vAlpha;
  varying float vKind;
  void main() {
    float across = 1.0 - abs(vUv.y);
    float t = vUv.x; // 0 — хвост, 1 — голова
    vec3 col;
    float a;
    if (vKind < 0.5) {
      float core = smoothstep(0.0, 1.0, across);
      core *= core;
      col = mix(vec3(1.0, 0.18, 0.03), vec3(1.0, 0.72, 0.25), smoothstep(0.05, 0.7, t));
      col += vec3(0.7, 0.55, 0.3) * smoothstep(0.75, 0.97, t) * core; // раскалённая голова
      a = core * (0.25 + 0.75 * t) * (1.0 - smoothstep(0.96, 1.0, t)) * smoothstep(0.0, 0.08, t);
      col *= 2.2;
    } else {
      col = vec3(1.0, 0.45, 0.15);
      a = across * across * (0.35 + 0.65 * t);
    }
    gl_FragColor = vec4(col, a * vAlpha);
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

  const material = new THREE.ShaderMaterial({
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
      let n = count;
      for (let i = n - 1; i >= 0; i -= 1) {
        age[i] += dt;
        const travelled = Math.max(0, age[i]) * SPEED;
        const arrivedFor = (travelled - len[i]) / SPEED; // с после попадания
        if (arrivedFor > Math.max(TRAIL_FADE * 4, STREAK / SPEED)) {
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
        const trailAlpha = TRAIL_ALPHA * Math.exp(-late / TRAIL_FADE);
        const trailTail = 0; // вдоль всего пути от дула
        if (trailAlpha > 0.01 && trailTail < head) {
          const q = m * 4;
          fromArr[q] = sx[i]; fromArr[q + 1] = sy[i]; fromArr[q + 2] = sz[i]; fromArr[q + 3] = k;
          dirArr[q] = dx[i]; dirArr[q + 1] = dy[i]; dirArr[q + 2] = dz[i]; dirArr[q + 3] = 1;
          spanArr[q] = trailTail; spanArr[q + 1] = head; spanArr[q + 2] = trailAlpha;
          spanArr[q + 3] = TRAIL_HALF_WIDTH;
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
