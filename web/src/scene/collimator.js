// Коллиматор (red-dot) на сгенерированной пушке (generated-guns.js collimator): компактная трубка на
// крепёжной лапе, лапа — на верхнем рельсе. Внутри трубки у переднего торца — наклонное тонированное
// стекло, в нём красная точка «на бесконечности».
//
// Точка без параллакса (как в настоящем коллиматоре): стекло рисует её по НАПРАВЛЕНИЮ взгляда
// «глаз → фрагмент стекла», а не по месту на стекле: пиксель стекла красный, если этот луч идёт под
// углом меньше радиуса точки к направлению прицеливания uDotDir. Поэтому при сдвиге глаза точка
// сдвигается по стеклу, но всегда лежит на одной и той же далёкой точке; у каждого глаза (стерео) своя
// cameraPosition — точки обоих глаз сходятся на бесконечности в одну. Взгляд мимо стекла — точки нет.
//
// Пристрелка: корпус параллелен стволу (−Z оружия), а направление точки каждый кадр — из центра стекла
// в место, где пуля этой пушки (дуло, ствол, скорость, гравитация) будет на дистанции zeroM: точка
// совпадает с попаданием на zeroM (на 20–50 м расходится на сантиметры — как у настоящего).
// Масштаб пушки (gun-resize.js) учитывается сам: всё считается в мировых координатах.
//
// collimator: { at: [x, y] — ПИКСЕЛИ card.png: точка на верхней кромке рельса под серединой лапы;
//   zeroM = 30 — дистанция пристрелки, м; windowR = 0.022 — радиус окна, м; dotMoa = 5 — диаметр точки, угл. минуты (не меньше ~1,5
//   пикселя экрана — иначе на шлеме мерцала бы); color = 0xff2418; height = windowR + 0.02 — ось над рельсом, м;
//   length = max(0.045, 2,2·windowR) — длина трубки, м; tilt = 0.14 — наклон стекла, рад; tint = 0x9fd8ff }
//
// createCollimator(THREE, cfg, { outlineMaterial, outlineM, model, fire: { speed, gravity } })
//   → { mount, place(from) }: mount — в группу оружия; place(from) — по mapPx картинки или модели (у
//   модели лапа садится на самый верх вершин под ней). model.collimator — для vr:eval.

const GRAVITY = 9.81;
const MOA = Math.PI / (180 * 60);

export function createCollimator(THREE, cfg, { outlineMaterial = null, outlineM = 0.0025, model, fire = {} }) {
  const shared = globalThis.__sceneState ?? {};
  const mount = new THREE.Group();
  mount.name = 'collimator';
  const ri = cfg.windowR ?? 0.022; // светлое окно (радиус; по просьбе — Ø 4,4 см, как у крупных red-dot)
  const ro = ri + 0.0035; // корпус
  const rb = ri + 0.0048; // кольца у торцов
  const L = cfg.length ?? Math.max(0.045, ri * 2.2); // короткая: окно не сужается перспективой трубки
  const axisY = cfg.height ?? ri + 0.02; // ось над рельсом: под трубкой — лапа ~1,4 см
  const rear = L / 2, front = -L / 2;

  // ---- корпус
  const body = new THREE.MeshStandardMaterial({ color: 0x1d1f22, roughness: 0.5, metalness: 0.45, envMap: shared.weaponEnv ?? null, envMapIntensity: 0.5, side: THREE.DoubleSide });
  const dark = new THREE.MeshStandardMaterial({ color: 0x0b0b0c, roughness: 0.8, metalness: 0.1, side: THREE.DoubleSide });
  const geos = []; // [geometry, material, outlined]
  const add = (g, mat = body, outlined = true) => { geos.push([g, mat, outlined]); return g; };
  // трубка: сечение стенки (r, ось) вращается вокруг оси; Lathe — вокруг Y, потом Y → Z
  const prof = [
    [ri, rear], [rb, rear], [rb, rear - 0.011], [ro, rear - 0.013], [ro, front + 0.015], [rb, front + 0.013], [rb, front], [ri, front], [ri, rear],
  ].map(([r, a]) => new THREE.Vector2(r, a));
  const tube = new THREE.LatheGeometry(prof, 48);
  tube.rotateX(Math.PI / 2);
  tube.translate(0, axisY, 0);
  add(tube);
  // торцевые кольца — чёрные внутренние ободки (тонкая фаска у окна)
  for (const z of [rear - 0.0004, front + 0.0004]) {
    const ring = new THREE.RingGeometry(ri * 0.985, ri + 0.0022, 48);
    ring.translate(0, axisY, z);
    add(ring, dark, false);
  }
  // лапа: основание на рельсе, стойка до трубки, зажимной винт справа
  const box = (w, h, d, x, y, z, mat = body, outlined = true) => {
    const g = new THREE.BoxGeometry(w, h, d);
    g.translate(x, y, z);
    return add(g, mat, outlined);
  };
  const baseLen = 0.042;
  box(0.024, 0.007, baseLen, 0, 0.0035, 0.002); // основание (низ — рельс)
  const riserTop = axisY - ri - 0.0005; // ниже окна: в трубку не заглядывает
  box(Math.min(0.02, 2 * Math.sqrt(ro * ro - (ri + 0.0005) ** 2) - 0.001), riserTop - 0.006, 0.032, 0, (riserTop + 0.006) / 2, 0.002); // стойка (верх — в стенке трубки)
  box(0.0025, 0.006, baseLen - 0.004, 0.0125, 0.003, 0.002); // щёки зажима (низ — на рельсе, не ниже)
  box(0.0025, 0.006, baseLen - 0.004, -0.0125, 0.003, 0.002);
  for (const z of [-0.007, 0.011]) box(0.026, 0.0012, 0.0016, 0, 0.0072, z, dark, false); // поперечные риски
  const cyl = (r, h, axis, x, y, z, mat = body, seg = 24) => {
    const g = new THREE.CylinderGeometry(r, r, h, seg);
    if (axis === 'x') g.rotateZ(Math.PI / 2);
    g.translate(x, y, z);
    return add(g, mat);
  };
  cyl(0.0042, 0.006, 'x', 0.0155, 0.0042, 0.002); // зажимной винт
  cyl(0.0075, 0.006, 'y', 0, axisY + ro + 0.001, 0.003); // барабан по высоте
  cyl(0.008, 0.0065, 'x', ro + 0.0011, axisY, 0.003); // яркость (справа)
  cyl(0.006, 0.0012, 'x', ro + 0.0046, axisY, 0.003, dark); // торец ручки яркости

  const meshes = new THREE.Group();
  for (const [g, mat] of geos) {
    const m = new THREE.Mesh(g, mat);
    m.renderOrder = 902;
    meshes.add(m);
  }
  mount.add(meshes);

  // ---- стекло с точкой
  const dotDir = new THREE.Vector3(0, 0, -1);
  const uniforms = {
    uDotDir: { value: dotDir },
    uDotR: { value: Math.tan(((cfg.dotMoa ?? 5) * MOA) / 2) },
    uDotColor: { value: new THREE.Color(cfg.color ?? 0xff2418) },
    uTint: { value: new THREE.Color(cfg.tint ?? 0x9fd8ff) },
  };
  const glassMat = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    vertexShader: /* glsl */ `
      varying vec3 vWP;
      varying vec3 vN;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWP = wp.xyz;
        vN = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uDotDir;
      uniform float uDotR;
      uniform vec3 uDotColor;
      uniform vec3 uTint;
      varying vec3 vWP;
      varying vec3 vN;
      void main() {
        vec3 V = normalize(vWP - cameraPosition);
        float c = dot(V, uDotDir);
        // тангенс угла между взглядом и направлением точки: зависит только от направления взгляда
        float r = c > 0.0 ? length(cross(V, uDotDir)) / c : 1e3;
        float fw = max(fwidth(r), 1e-6);
        float core = max(uDotR, fw * 0.8); // не меньше ~1,6 пикселя: без мерцания на шлеме
        float dotA = 1.0 - smoothstep(core - fw * 0.6, core + fw * 0.6, r);
        float glow = 0.45 * exp(-max(r - core, 0.0) / (core * 1.3));
        float fres = pow(1.0 - abs(dot(V, normalize(vN))), 3.0);
        float tintA = 0.1 + 0.35 * fres;
        float d = clamp(dotA + glow, 0.0, 1.0);
        vec3 col = mix(uTint, uDotColor * (1.0 + 0.6 * dotA), d);
        gl_FragColor = vec4(min(col, vec3(1.0)), max(tintA, d));
      }
    `,
  });
  const glass = new THREE.Mesh(new THREE.CircleGeometry(ri * 0.99, 48), glassMat);
  glass.position.set(0, axisY, front + 0.007);
  glass.rotation.x = cfg.tilt ?? 0.14; // наклонное зеркало-объектив (верх к дулу)
  glass.renderOrder = 903; // после пушки и корпуса
  mount.add(glass);

  // пристрелка: каждый кадр (у каждого глаза — тот же ответ; дёшево)
  const zeroM = cfg.zeroM ?? 30;
  const speed = fire.speed ?? 900;
  const g = fire.gravity ?? GRAVITY;
  const muzzleW = new THREE.Vector3();
  const barrel = new THREE.Vector3();
  const sightW = new THREE.Vector3();
  let frame = -1;
  glass.onBeforeRender = (renderer) => {
    const f = renderer.info.render.frame;
    if (f === frame) return;
    frame = f;
    const gm = model.group.matrixWorld;
    muzzleW.copy(model.muzzle).applyMatrix4(gm);
    barrel.set(0, 0, -1).transformDirection(gm);
    sightW.setFromMatrixPosition(glass.matrixWorld);
    const t = zeroM / speed;
    dotDir.copy(muzzleW).addScaledVector(barrel, zeroM);
    dotDir.y -= 0.5 * g * t * t;
    dotDir.sub(sightW).normalize();
  };

  // ---- обводка «можно взять»: оболочка корпуса по нормалям, ребёнок обводки пушки (видимость — её)
  let outline = null;
  if (outlineMaterial) {
    const shells = [];
    for (const [g0, , outlined] of geos) {
      if (!outlined) continue;
      const bare = new THREE.BufferGeometry();
      bare.setAttribute('position', g0.attributes.position.clone());
      if (g0.index) bare.setIndex(g0.index.clone());
      shells.push(bare);
    }
    const merged = mergeShells(THREE, shells, outlineM);
    outline = new THREE.Mesh(merged, outlineMaterial);
    outline.renderOrder = 901;
  }

  const fitCache = new WeakMap(); // from → y верха модели под лапой
  const topOfModel = (from, y0, z0) => {
    if (!from.parts) return null;
    if (fitCache.has(from)) return fitCache.get(from);
    let top = -Infinity;
    const z1 = z0 - baseLen / 2 + 0.002, z2 = z0 + baseLen / 2 + 0.002;
    for (const p of from.parts) {
      const pos = p.geometry.attributes.position;
      const idx = p.geometry.index?.array;
      const check = (i) => {
        const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
        if (Math.abs(x) <= 0.014 && z >= z1 && z <= z2 && y < y0 + 0.03 && y > top) top = y;
      };
      if (idx) for (let k = 0; k < idx.length; k += 1) check(idx[k]);
      else for (let i = 0; i < pos.count; i += 1) check(i);
    }
    const out = Number.isFinite(top) ? top : null;
    fitCache.set(from, out);
    return out;
  };

  const api = {
    mount, glass, uniforms, dotDir, outline,
    info: null,
    place(from) {
      if (!from?.mapPx) return;
      const [py, pz] = from.mapPx(cfg.at[0], cfg.at[1]);
      const fit = topOfModel(from, py, pz);
      const y = fit ?? py;
      mount.position.set(0, y, pz);
      if (outline) {
        outline.position.copy(mount.position);
        if (outline.parent !== model.outline) model.outline?.add(outline);
        model.fixedOutline ??= outline; // tintOutline: голубая/белая вместе с пушкой
      }
      api.info = { y: +y.toFixed(4), z: +pz.toFixed(4), cardY: +py.toFixed(4), fitY: fit == null ? null : +fit.toFixed(4) };
    },
  };
  model.collimator = api;
  return api;
}

// оболочки по сглаженным нормалям, сдвинутые на m (обводка)
function mergeShells(THREE, shells, m) {
  const parts = [];
  for (const s of shells) {
    const merged = mergeVerts(THREE, s);
    merged.computeVertexNormals();
    const pos = merged.attributes.position, nor = merged.attributes.normal;
    // обход граней внутрь (у Lathe так) — знак объёма отрицательный: сдвигаем в другую сторону
    let vol = 0;
    const ix = merged.index.array;
    for (let k = 0; k < ix.length; k += 3) {
      const a = ix[k], b = ix[k + 1], c = ix[k + 2];
      const ax = pos.getX(a), ay = pos.getY(a), az = pos.getZ(a), bx = pos.getX(b), by = pos.getY(b), bz = pos.getZ(b), cx = pos.getX(c), cy = pos.getY(c), cz = pos.getZ(c);
      vol += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
    }
    m = vol < 0 ? -Math.abs(m) : Math.abs(m);
    for (let i = 0; i < pos.count; i += 1) pos.setXYZ(i, pos.getX(i) + nor.getX(i) * m, pos.getY(i) + nor.getY(i) * m, pos.getZ(i) + nor.getZ(i) * m);
    merged.deleteAttribute('normal');
    parts.push(merged);
  }
  // склейка без зависимостей: просто конкатенация позиций и индексов
  let nv = 0, ni = 0;
  for (const p of parts) { nv += p.attributes.position.count; ni += p.index.count; }
  const position = new Float32Array(nv * 3);
  const index = new Uint32Array(ni);
  let ov = 0, oi = 0;
  for (const p of parts) {
    position.set(p.attributes.position.array, ov * 3);
    const src = p.index.array;
    for (let k = 0; k < src.length; k += 1) index[oi + k] = src[k] + ov;
    ov += p.attributes.position.count;
    oi += src.length;
    p.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(position, 3));
  out.setIndex(new THREE.BufferAttribute(index, 1));
  out.computeBoundingSphere();
  return out;
}

// сшивка вершин по положению (1e-5 м), всегда с индексом
function mergeVerts(THREE, g) {
  const pos = g.attributes.position;
  const src = g.index ? g.index.array : Array.from({ length: pos.count }, (_, i) => i);
  const ids = new Map();
  const remap = new Int32Array(pos.count);
  const out = [];
  for (let i = 0; i < pos.count; i += 1) {
    const key = `${Math.round(pos.getX(i) * 1e5)},${Math.round(pos.getY(i) * 1e5)},${Math.round(pos.getZ(i) * 1e5)}`;
    let id = ids.get(key);
    if (id === undefined) { id = ids.size; ids.set(key, id); out.push(pos.getX(i), pos.getY(i), pos.getZ(i)); }
    remap[i] = id;
  }
  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.Float32BufferAttribute(out, 3));
  merged.setIndex(Array.from(src, (i) => remap[i]));
  g.dispose();
  return merged;
}
