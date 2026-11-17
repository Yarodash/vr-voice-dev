// Попадание пули в сталь: короткая звёздочка-вспышка из тонких лучей, веер раскалённых искр
// (вытянуты по скорости, остывают белый → оранжевый → красный, падают и отскакивают от земли) и
// тлеющая точка в месте попадания. Всё — одна сетка, один шейдер, один вызов отрисовки (аддитивно,
// сортировка не нужна); пока ничего нет — ни одного вызова. Пыль/краска — в smoke.js.

const SPARKS = 160;
const STARS = 8;
const EMBERS = 16;
const TOTAL = SPARKS + STARS + EMBERS;
const GRAVITY = 9.8;
const BLUR = 0.014; // с: «выдержка» — длина искры = скорость × BLUR

const vertexShader = /* glsl */ `
  attribute vec4 aA; // xyz — голова/центр, w — вид: 0 искра, 1 звезда, 2 уголёк
  attribute vec4 aB; // искра: xyz хвост, w полуширина; звезда/уголёк: x размер, y поворот, z случайное
  attribute vec4 aC; // x — накал 0..1, y — прозрачность
  varying vec2 vUv;
  varying float vKind;
  varying float vTemp;
  varying float vAlpha;
  varying float vSeed;
  void main() {
    vKind = aA.w;
    vTemp = aC.x;
    vAlpha = aC.y;
    vSeed = aB.z;
    vUv = position.xy;
    if (aA.w < 0.5) {
      // искра: полоска от хвоста к голове, повёрнута к камере
      float along = position.x * 0.5 + 0.5;
      vec3 seg = aA.xyz - aB.xyz;
      vec3 dir = seg / max(length(seg), 1e-5);
      vec3 wp = mix(aB.xyz, aA.xyz, along);
      vec3 toCam = cameraPosition - wp;
      float dist = length(toCam);
      vec3 side = normalize(cross(toCam / max(dist, 1e-4), dir) + vec3(1e-6));
      float w = max(aB.w, dist * 0.0009); // вдали не тоньше ~пикселя
      vAlpha *= sqrt(aB.w / w);
      wp += side * position.y * w;
      gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
    } else {
      float c = cos(aB.y);
      float s = sin(aB.y);
      vec2 rc = vec2(c * position.x - s * position.y, s * position.x + c * position.y);
      vec4 mv = viewMatrix * vec4(aA.xyz, 1.0);
      mv.xy += rc * aB.x;
      gl_Position = projectionMatrix * mv;
    }
  }
`;

const fragmentShader = /* glsl */ `
  varying vec2 vUv;
  varying float vKind;
  varying float vTemp;
  varying float vAlpha;
  varying float vSeed;
  float hash(float n) { return fract(sin(n) * 43758.5453); }
  void main() {
    // цвет накала: тёмно-красный → оранжевый → бело-жёлтый
    vec3 col = mix(vec3(0.55, 0.04, 0.0), vec3(1.0, 0.42, 0.07), smoothstep(0.0, 0.45, vTemp));
    col = mix(col, vec3(1.0, 0.93, 0.75), smoothstep(0.5, 1.0, vTemp));
    col *= 0.6 + 2.4 * vTemp;
    float a;
    if (vKind < 0.5) {
      float across = 1.0 - abs(vUv.y);
      float along = vUv.x * 0.5 + 0.5;
      a = across * across * (0.35 + 0.65 * along);
    } else if (vKind < 1.5) {
      // звезда: несколько тонких лучей разной длины и маленькое ядро
      float r = length(vUv);
      a = exp(-r * r * 90.0) * 1.5;
      for (int i = 0; i < 4; i++) {
        float fi = float(i);
        float ang = fi * 0.785398 + (hash(vSeed + fi) - 0.5) * 0.5;
        vec2 d = vec2(cos(ang), sin(ang));
        float len = mix(0.35, 1.0, hash(vSeed * 1.7 + fi * 3.1));
        float off = abs(dot(vUv, vec2(-d.y, d.x)));
        float t = abs(dot(vUv, d)) / len;
        a += exp(-off * 70.0) * (1.0 - smoothstep(0.0, 1.0, t)) * (1.0 - t * 0.5);
      }
      a *= 1.0 - smoothstep(0.85, 1.0, r);
    } else {
      float r = length(vUv);
      a = exp(-r * r * 7.0) * (1.0 - smoothstep(0.7, 1.0, r));
    }
    gl_FragColor = vec4(col, a * vAlpha);
    #include <colorspace_fragment>
  }
`;

export function createImpacts({ THREE, group }) {
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
  const A = new Float32Array(TOTAL * 4);
  const B = new Float32Array(TOTAL * 4);
  const C = new Float32Array(TOTAL * 4);
  const attrs = [
    ['aA', A],
    ['aB', B],
    ['aC', C],
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
  mesh.name = 'impact-sparks';
  mesh.frustumCulled = false; // всегда видима: шейдер собран заранее; при 0 экземплярах вызова нет
  mesh.renderOrder = 3;
  group.add(mesh);

  // искры
  const sx = new Float32Array(SPARKS), sy = new Float32Array(SPARKS), sz = new Float32Array(SPARKS);
  const svx = new Float32Array(SPARKS), svy = new Float32Array(SPARKS), svz = new Float32Array(SPARKS);
  const sAge = new Float32Array(SPARKS), sLife = new Float32Array(SPARKS), sHeat = new Float32Array(SPARKS);
  const sWidth = new Float32Array(SPARKS);
  let sparks = 0;
  // звёзды и угольки: место, возраст, жизнь, размер, поворот, случайное
  const makePool = (n) => ({
    x: new Float32Array(n), y: new Float32Array(n), z: new Float32Array(n),
    age: new Float32Array(n), life: new Float32Array(n), size: new Float32Array(n),
    rot: new Float32Array(n), seed: new Float32Array(n), count: 0, cap: n,
  });
  const stars = makePool(STARS);
  const embers = makePool(EMBERS);

  const random = (a, b) => a + Math.random() * (b - a);
  const tA = new THREE.Vector3();
  const tB = new THREE.Vector3();
  const nrm = new THREE.Vector3();

  const addPoint = (pool, p, life, size) => {
    let i;
    if (pool.count < pool.cap) i = pool.count++;
    else {
      i = 0;
      for (let k = 1; k < pool.cap; k += 1) if (pool.age[k] / pool.life[k] > pool.age[i] / pool.life[i]) i = k;
    }
    pool.x[i] = p.x; pool.y[i] = p.y; pool.z[i] = p.z;
    pool.age[i] = 0; pool.life[i] = life; pool.size[i] = size;
    pool.rot[i] = Math.random() * Math.PI; pool.seed[i] = Math.random() * 100;
  };
  const removePoint = (pool, i) => {
    const n = --pool.count;
    pool.x[i] = pool.x[n]; pool.y[i] = pool.y[n]; pool.z[i] = pool.z[n];
    pool.age[i] = pool.age[n]; pool.life[i] = pool.life[n]; pool.size[i] = pool.size[n];
    pool.rot[i] = pool.rot[n]; pool.seed[i] = pool.seed[n];
  };

  // звёзды или угольки (kind 1 / 2) — в буферы с позиции m; вернёт новое m (без замыкания на кадр)
  const points = (pool, kind, m, dt) => {
    for (let i = pool.count - 1; i >= 0; i -= 1) {
      pool.age[i] += dt;
      if (pool.age[i] >= pool.life[i]) removePoint(pool, i);
    }
    for (let i = 0; i < pool.count; i += 1) {
      const f = pool.age[i] / pool.life[i];
      const q = m * 4;
      A[q] = pool.x[i]; A[q + 1] = pool.y[i]; A[q + 2] = pool.z[i]; A[q + 3] = kind;
      if (kind === 1) {
        B[q] = pool.size[i] * (0.8 + 0.4 * f);
        C[q] = 1;
        C[q + 1] = 1 - f * f;
      } else {
        B[q] = pool.size[i] * (1 - 0.4 * f);
        C[q] = (1 - f) ** 1.5;
        C[q + 1] = 1 - Math.max(0, (f - 0.6) / 0.4);
      }
      B[q + 1] = pool.rot[i];
      B[q + 2] = pool.seed[i];
      B[q + 3] = 0;
      m += 1;
    }
    return m;
  };
  let warm = 0; // кадров после создания (см. конец update)

  const addSpark = (x, y, z, vx, vy, vz, life, heat, width) => {
    let i;
    if (sparks < SPARKS) i = sparks++;
    else {
      i = 0;
      for (let k = 1; k < SPARKS; k += 1) if (sAge[k] / sLife[k] > sAge[i] / sLife[i]) i = k;
    }
    sx[i] = x; sy[i] = y; sz[i] = z;
    svx[i] = vx; svy[i] = vy; svz[i] = vz;
    sAge[i] = 0; sLife[i] = life; sHeat[i] = heat; sWidth[i] = width;
  };

  return {
    // point — место попадания, normal — наружу от поверхности
    hit(point, normal) {
      nrm.copy(normal).normalize();
      // касательные к поверхности: по ним в основном и летит веер искр
      tA.set(0, 1, 0).cross(nrm);
      if (tA.lengthSq() < 1e-4) tA.set(1, 0, 0);
      tA.normalize();
      tB.copy(nrm).cross(tA);
      const px = point.x + nrm.x * 0.004, py = point.y + nrm.y * 0.004, pz = point.z + nrm.z * 0.004;
      addPoint(stars, { x: px, y: py, z: pz }, 0.038, random(0.08, 0.12));
      addPoint(embers, { x: px, y: py, z: pz }, 0.32, 0.006);
      const n = 12 + Math.floor(Math.random() * 13);
      for (let k = 0; k < n; k += 1) {
        const ang = Math.random() * Math.PI * 2;
        const flat = random(2, 6); // вдоль поверхности
        const out = random(0.3, 2.5); // наружу
        const ca = Math.cos(ang) * flat, sa = Math.sin(ang) * flat;
        addSpark(
          px, py, pz,
          tA.x * ca + tB.x * sa + nrm.x * out,
          tA.y * ca + tB.y * sa + nrm.y * out + random(0, 1.2),
          tA.z * ca + tB.z * sa + nrm.z * out,
          random(0.25, 0.75),
          random(0.85, 1),
          random(0.0011, 0.0019),
        );
      }
    },

    update(dtRaw) {
      const dt = Math.min(0.05, dtRaw || 0);
      let m = 0;
      // искры
      for (let i = sparks - 1; i >= 0; i -= 1) {
        sAge[i] += dt;
        if (sAge[i] >= sLife[i]) {
          const n = --sparks;
          sx[i] = sx[n]; sy[i] = sy[n]; sz[i] = sz[n];
          svx[i] = svx[n]; svy[i] = svy[n]; svz[i] = svz[n];
          sAge[i] = sAge[n]; sLife[i] = sLife[n]; sHeat[i] = sHeat[n]; sWidth[i] = sWidth[n];
          continue;
        }
        const k = 1 - Math.min(1, 1.6 * dt);
        svx[i] *= k; svy[i] *= k; svz[i] *= k;
        svy[i] -= GRAVITY * dt;
        sx[i] += svx[i] * dt; sy[i] += svy[i] * dt; sz[i] += svz[i] * dt;
        if (sy[i] < 0.005 && svy[i] < 0) {
          // отскок от земли
          sy[i] = 0.005;
          svy[i] *= -0.35;
          svx[i] *= 0.55;
          svz[i] *= 0.55;
        }
      }
      for (let i = 0; i < sparks; i += 1) {
        const f = sAge[i] / sLife[i];
        const q = m * 4;
        A[q] = sx[i]; A[q + 1] = sy[i]; A[q + 2] = sz[i]; A[q + 3] = 0;
        // хвост: где искра была BLUR назад (не короче 8 мм)
        let bx = svx[i] * BLUR, by = svy[i] * BLUR, bz = svz[i] * BLUR;
        const bl = Math.hypot(bx, by, bz);
        if (bl < 0.008) {
          const s = bl > 1e-6 ? 0.008 / bl : 0;
          bx *= s; by *= s; bz *= s;
          if (s === 0) by = -0.008;
        }
        B[q] = sx[i] - bx; B[q + 1] = sy[i] - by; B[q + 2] = sz[i] - bz; B[q + 3] = sWidth[i];
        C[q] = sHeat[i] * Math.exp(-sAge[i] / 0.12); // остывает: белая → оранжевая → красная
        C[q + 1] = 1 - Math.max(0, (f - 0.7) / 0.3);
        m += 1;
      }
      // звёзды и угольки
      m = points(stars, 1, m, dt);
      m = points(embers, 2, m, dt);

      if (m > 0 || geometry.instanceCount > 0) {
        for (const attr of attrs) {
          attr.clearUpdateRanges();
          attr.addUpdateRange(0, Math.max(1, m) * 4);
          attr.needsUpdate = true;
        }
      }
      geometry.instanceCount = m;
      // пустой видимый меш тоже стоит CPU (программа и униформы на каждый глаз): скрыт, пока пусто;
      // первые кадры виден — шейдер собирается при подмене сцены (материал держит программу)
      if (warm < 3) warm += 1;
      mesh.visible = m > 0 || warm < 3;
    },

    dispose() {
      group.remove(mesh);
      geometry.dispose();
      material.dispose();
      sparks = 0;
    },
  };
}
