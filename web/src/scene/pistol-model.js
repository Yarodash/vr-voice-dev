// Модель пистолета (пропорции Glock 19). Живёт в сцене: правки подхватываются на лету.
//
// Система координат: ствол смотрит в −Z, верх — +Y, рукоятка внизу ближе к +Z (строго под 90° к затвору).
// Центр рукоятки (ладонь) примерно в (0, −0.04, 0.045): от него считается посадка в руку.
// Детали одного материала слиты в один Mesh (прямые дети группы): так пистолет — 8 вызовов
// отрисовки, а не 28. Обводка (buildPistol(THREE, { outlineM })) — одна геометрия: каждая деталь,
// чуть растянутая от центра своих габаритов, так она ложится ровно вокруг детали.
//
// Боковые профили (затвор, рамка, скоба, рукоятка, спуск) рисуются в координатах (f, y):
// f — расстояние вперёд по стволу (f = −z), y — вверх. Затем профиль выдавливается по ширине (X).
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// Основные размеры, метры
const SLIDE_W = 0.025;
const SLIDE_BOTTOM = 0.006;
const SLIDE_TOP = 0.036;
const SLIDE_REAR = -0.072; // f
const SLIDE_FRONT = 0.108; // f
const BORE_Y = 0.021;
const PORT_F0 = 0.005; // окно выброса, от патронника вперёд
const PORT_F1 = 0.04;

export function buildPistol(THREE, { outlineM = 0 } = {}) {
  const group = new THREE.Group();

  // Окружение (weapon-env.js) только у металла оружия: без него металл уходит в чёрное.
  const env = globalThis.__sceneState?.weaponEnv ?? null;
  const shared = (globalThis.__sceneState ??= {});
  const noiseTex = (size, dots, light, dark, bumpOnly = false) => {
    // мелкое зерно: tile 2 см, повторяется по UV (planar, см. boxUv)
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const g = c.getContext('2d');
    g.fillStyle = bumpOnly ? '#808080' : '#a0a0a0';
    g.fillRect(0, 0, size, size);
    for (let i = 0; i < dots; i++) {
      const v = Math.random();
      g.fillStyle = v < 0.5 ? dark : light;
      const r = 0.6 + Math.random() * 0.9;
      g.beginPath();
      g.arc(Math.random() * size, Math.random() * size, r, 0, Math.PI * 2);
      g.fill();
    }
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    return t;
  };
  // Текстура затвора: тёмная сталь, продольная шлифовка, потёртые кромки, гравировка из линий. 1024×512, раз и в кэш.
  const slideTex = () => {
    const W = 1024, H = 512;
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const g = c.getContext('2d');
    g.fillStyle = '#2c3036';
    g.fillRect(0, 0, W, H);
    for (let i = 0; i < 2600; i++) { // шлифовка вдоль ствола (u)
      const y = Math.random() * H, x = Math.random() * W, l = 30 + Math.random() * 260;
      g.fillStyle = Math.random() < 0.5 ? 'rgba(255,255,255,0.045)' : 'rgba(0,0,0,0.10)';
      g.fillRect(x, y, l, 1);
    }
    // потёртости на кромках (бока: v≈0.9 верх боковины, v≈0 низ; торцы u≈0 и u≈1)
    const wear = (x, y, w, h, n) => {
      for (let i = 0; i < n; i++) {
        g.fillStyle = `rgba(150,156,162,${0.15 + Math.random() * 0.35})`;
        const l = 4 + Math.random() * 26;
        g.fillRect(x + Math.random() * w, y + Math.random() * h, l, 1 + Math.random() * 2);
      }
    };
    wear(0, H * 0.1, W, 10, 420); wear(0, H * 0.9 - 8, W, 10, 220); wear(0, 0, 14, H, 260); wear(W - 14, 0, 14, H, 260);
    for (let i = 0; i < 40; i++) { // редкие царапины
      g.strokeStyle = 'rgba(170,176,182,0.25)';
      g.lineWidth = 1;
      const x = Math.random() * W, y = Math.random() * H;
      g.beginPath(); g.moveTo(x, y); g.lineTo(x + (Math.random() - 0.5) * 120, y + (Math.random() - 0.5) * 30); g.stroke();
    }
    // табличка с гравировкой (только линии, без текста): тёмные штрихи с чуть светлой фаской
    for (let i = 0; i < 6; i++) {
      const y = H * (0.42 + i * 0.022), x0 = W * 0.3, x1 = W * (0.52 + (i % 3) * 0.05);
      g.fillStyle = 'rgba(0,0,0,0.55)'; g.fillRect(x0, y, x1 - x0, 2);
      g.fillStyle = 'rgba(190,196,202,0.18)'; g.fillRect(x0, y + 2, x1 - x0, 1);
    }
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    return t;
  };
  const tex = (shared.pistolTex ??= {
    gripBump: noiseTex(256, 2600, '#ffffff', '#000000', true), // крупная «шагрень» накладок
    frameBump: noiseTex(256, 900, '#b0b0b0', '#505050', true), // мелкое зерно рамки
    steelRough: noiseTex(256, 1500, '#d0d0d0', '#707070'), // разбивает блики на металле
    slideMap: slideTex(),
  });
  const { gripBump, frameBump, steelRough, slideMap } = tex;
  const slideMat = new THREE.MeshStandardMaterial({ color: 0xffffff, map: slideMap, roughness: 0.62, metalness: 0.62, roughnessMap: steelRough, envMap: env, envMapIntensity: 0.4 });
  const polymerMat = new THREE.MeshStandardMaterial({ color: 0x26282b, roughness: 0.8, metalness: 0.0, bumpMap: frameBump, bumpScale: 0.6 });
  const gripMat = new THREE.MeshStandardMaterial({ color: 0x26282b, roughness: 0.85, metalness: 0.0, bumpMap: gripBump, bumpScale: 1.6 });
  const grooveMat = new THREE.MeshStandardMaterial({ color: 0x15171a, roughness: 0.7, metalness: 0.5, envMap: env, envMapIntensity: 0.25 });
  const cutMat = new THREE.MeshStandardMaterial({ color: 0x16181b, roughness: 0.7, metalness: 0.3 });
  const steelMat = new THREE.MeshStandardMaterial({ color: 0x7a8088, roughness: 0.58, metalness: 0.65, roughnessMap: steelRough, envMap: env, envMapIntensity: 0.4 });
  const whiteMat = new THREE.MeshStandardMaterial({ color: 0xf2f4f7, roughness: 0.4, metalness: 0, emissive: 0x2a2a2a });
  // Спуск (тёмная сталь) чуть светится, пока пистолет рядом или в руке (см. glow в main.js).
  const accent = new THREE.MeshStandardMaterial({ color: 0x2a2d31, roughness: 0.55, metalness: 0.6, emissive: 0x000000, envMap: env, envMapIntensity: 0.35 });

  // Деталь из геометрии в координатах пистолета: геометрия центрируется, деталь запоминается со своим
  // центром. В конце детали одного материала сливаются в один меш (меньше вызовов отрисовки), а
  // обводка — в одну геометрию из всех деталей, каждая растянута от своего центра.
  const parts = []; // { geometry (отцентрована), center, material, trigger }
  let tag = null; // 'trigger' | 'slide': такие детали уходят в свои подвижные узлы
  // Плоские UV по доминирующей оси нормали (в координатах пистолета, 1 тайл = 2 см): у выдавленных профилей UV не годятся для зерна.
  const boxUv = (geometry) => {
    const g = geometry.index ? geometry.toNonIndexed() : geometry;
    const p = g.attributes.position;
    const n = g.attributes.normal;
    const uv = new Float32Array(p.count * 2);
    for (let i = 0; i < p.count; i++) {
      const ax = Math.abs(n.getX(i)), ay = Math.abs(n.getY(i)), az = Math.abs(n.getZ(i));
      let u, v;
      if (ax >= ay && ax >= az) { u = p.getZ(i); v = p.getY(i); } else if (ay >= az) { u = p.getX(i); v = p.getZ(i); } else { u = p.getX(i); v = p.getY(i); }
      uv[i * 2] = u * 50; uv[i * 2 + 1] = v * 50;
    }
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    if (g !== geometry) geometry.dispose();
    return g;
  };
  // Затвор: вся боковина = одна текстура (u вдоль ствола, v по высоте), сверху — по ширине.
  const slideUv = (geometry) => {
    const g = geometry.index ? geometry.toNonIndexed() : geometry;
    const p = g.attributes.position;
    const n = g.attributes.normal;
    const uv = new Float32Array(p.count * 2);
    for (let i = 0; i < p.count; i++) {
      const u = (-p.getZ(i) + 0.08) / 0.2;
      const side = Math.abs(n.getX(i)) >= Math.abs(n.getY(i));
      uv[i * 2] = u;
      uv[i * 2 + 1] = side ? (p.getY(i) - 0.002) / 0.036 * 0.8 + 0.1 : p.getX(i) / 0.025 * 0.8 + 0.5;
    }
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    if (g !== geometry) geometry.dispose();
    return g;
  };
  const place = (geometry, material) => {
    if (material === polymerMat || material === gripMat) geometry = boxUv(geometry);
    else if (material === slideMat) geometry = slideUv(geometry);
    geometry.computeBoundingBox();
    const center = geometry.boundingBox.getCenter(new THREE.Vector3());
    geometry.translate(-center.x, -center.y, -center.z);
    const indexed = geometry.index ? geometry.toNonIndexed() : geometry;
    if (indexed !== geometry) geometry.dispose();
    indexed.computeBoundingBox();
    parts.push({ geometry: indexed, center, material, tag });
  };

  // Профиль в (f, y) → тело шириной width по X, с фаской bevel по всем рёбрам.
  const extrudeSide = (shape, width, bevel, material, curveSegments = 8) => {
    const depth = Math.max(width - 2 * bevel, 0.0004);
    const geometry = new THREE.ExtrudeGeometry(shape, {
      depth,
      curveSegments,
      bevelEnabled: true,
      bevelThickness: bevel,
      bevelSize: bevel,
      bevelOffset: -bevel, // фаска внутрь: внешний контур остаётся ровно по профилю
      bevelSegments: 2,
    });
    geometry.translate(0, 0, -depth / 2);
    geometry.rotateY(Math.PI / 2); // профиль X → −Z (вперёд), выдавливание Z → X
    return place(geometry, material);
  };

  // Скруглённый брусок: x, y — как есть, f — вперёд (z = −f).
  const rbox = (w, h, d, r, material, x, y, f) => {
    const geometry = new RoundedBoxGeometry(w, h, d, 2, r);
    geometry.translate(x, y, -f);
    return place(geometry, material);
  };

  // Диск/цилиндр вдоль ствола.
  const cylinderF = (radius, length, material, y, f, segments = 20) => {
    const geometry = new THREE.CylinderGeometry(radius, radius, length, segments);
    geometry.rotateX(Math.PI / 2);
    geometry.translate(0, y, -f);
    return place(geometry, material);
  };

  const shape = (points) => {
    const s = new THREE.Shape();
    s.moveTo(points[0][0], points[0][1]);
    for (let i = 1; i < points.length; i += 1) {
      const p = points[i];
      if (p.length === 4) s.quadraticCurveTo(p[0], p[1], p[2], p[3]);
      else s.lineTo(p[0], p[1]);
    }
    s.closePath();
    return s;
  };

  tag = 'slide';
  // --- затвор: плоские бока, скошенный «нос» снизу спереди, скруглённые рёбра
  extrudeSide(
    shape([
      [SLIDE_REAR + 0.0015, SLIDE_BOTTOM],
      [SLIDE_FRONT - 0.011, SLIDE_BOTTOM],
      [SLIDE_FRONT, BORE_Y - 0.0085], // скос носа
      [SLIDE_FRONT, SLIDE_TOP - 0.0015],
      [SLIDE_FRONT - 0.0015, SLIDE_TOP],
      [SLIDE_REAR + 0.0012, SLIDE_TOP],
      [SLIDE_REAR, SLIDE_TOP - 0.002],
      [SLIDE_REAR, SLIDE_BOTTOM + 0.0015],
    ]),
    SLIDE_W, 0.0022, slideMat, 4,
  );

  // насечки затвора: сзади и спереди, на обеих сторонах — одной деталью
  {
    const grooves = [];
    const addGroove = (f, side) => {
      const g = new THREE.BoxGeometry(0.0006, 0.018, 0.0011);
      g.translate(side * (SLIDE_W / 2 + 0.00005), 0.0215, -f);
      grooves.push(g);
    };
    for (let i = 0; i < 8; i += 1) for (const side of [-1, 1]) addGroove(SLIDE_REAR + 0.006 + i * 0.0036, side);
    for (let i = 0; i < 5; i += 1) for (const side of [-1, 1]) addGroove(SLIDE_FRONT - 0.03 + i * 0.0036, side);
    place(mergeGeometries(grooves), grooveMat);
    grooves.forEach((g) => g.dispose());
  }

  // окно выброса справа сверху, в нём — ствольный «капюшон» и экстрактор
  rbox(0.0098, 0.0105, PORT_F1 - PORT_F0, 0.0006, cutMat, 0.0078, SLIDE_TOP - 0.0052, (PORT_F0 + PORT_F1) / 2);
  rbox(0.0112, 0.0012, PORT_F1 - PORT_F0 - 0.003, 0.0005, steelMat, -0.0002, SLIDE_TOP - 0.0002, (PORT_F0 + PORT_F1) / 2 - 0.001);
  rbox(0.0012, 0.0028, 0.013, 0.0004, steelMat, SLIDE_W / 2 + 0.0003, SLIDE_TOP - 0.009, PORT_F0 - 0.008);

  // ствол на срезе затвора: торец, канал
  cylinderF(0.0066, 0.004, steelMat, BORE_Y, SLIDE_FRONT - 0.0012, 24);
  cylinderF(0.0044, 0.001, cutMat, BORE_Y, SLIDE_FRONT + 0.0013, 20);

  // мушка с белой точкой
  rbox(0.0035, 0.0052, 0.0065, 0.0008, cutMat, 0, SLIDE_TOP + 0.0024, SLIDE_FRONT - 0.008);
  {
    const dot = new THREE.CylinderGeometry(0.0011, 0.0011, 0.0006, 12);
    dot.rotateX(Math.PI / 2);
    dot.translate(0, SLIDE_TOP + 0.0034, -(SLIDE_FRONT - 0.008 - 0.0034));
    place(dot, whiteMat);
  }
  // целик: основание и два «уха» с белыми точками (прорезь между ними)
  const rearF = SLIDE_REAR + 0.011;
  rbox(0.019, 0.0022, 0.0075, 0.0007, cutMat, 0, SLIDE_TOP + 0.001, rearF);
  for (const side of [-1, 1]) {
    rbox(0.0072, 0.0056, 0.0075, 0.0009, cutMat, side * 0.0057, SLIDE_TOP + 0.0026, rearF);
    const dot = new THREE.CylinderGeometry(0.001, 0.001, 0.0006, 12);
    dot.rotateX(Math.PI / 2);
    dot.translate(side * 0.0057, SLIDE_TOP + 0.0034, -(rearF - 0.0039));
    place(dot, whiteMat);
  }

  tag = null;
  // --- рамка: полоса под затвором с пылезащитной частью спереди
  extrudeSide(
    shape([
      [SLIDE_REAR + 0.003, SLIDE_BOTTOM + 0.002],
      [SLIDE_FRONT - 0.009, SLIDE_BOTTOM + 0.002],
      [SLIDE_FRONT - 0.009, -0.002],
      [SLIDE_FRONT - 0.013, -0.0065],
      [-0.024, -0.0065],
      [-0.024, -0.003],
      [SLIDE_REAR + 0.003, -0.003],
    ]),
    0.0225, 0.0016, polymerMat, 6,
  );
  rbox(0.016, 0.0014, 0.0035, 0.0005, cutMat, 0, -0.0068, 0.074); // поперечный паз планки снизу
  rbox(0.016, 0.0014, 0.0035, 0.0005, cutMat, 0, -0.0068, 0.086);

  // --- спусковая скоба: профиль с отверстием, квадратный перед с «крючком»
  {
    const guard = shape([
      [-0.026, -0.003],
      [0.031, -0.003],
      [0.0335, -0.006],
      [0.0325, -0.026],
      [0.0325, -0.0315, 0.027, -0.0315],
      [-0.016, -0.0315],
      [-0.024, -0.0315, -0.026, -0.022],
    ]);
    const hole = new THREE.Path();
    hole.moveTo(-0.019, -0.0068);
    hole.lineTo(0.0275, -0.0068);
    hole.lineTo(0.0275, -0.024);
    hole.quadraticCurveTo(0.0275, -0.0268, 0.0245, -0.0268);
    hole.lineTo(-0.014, -0.0268);
    hole.quadraticCurveTo(-0.019, -0.0268, -0.019, -0.021);
    hole.closePath();
    guard.holes.push(hole);
    extrudeSide(guard, 0.0115, 0.0013, polymerMat, 6);
  }

  // спуск: изогнутая пластина (вогнутая спереди) и предохранительная клавиша в ней
  tag = 'trigger';
  extrudeSide(
    shape([
      [0.0068, -0.0062],
      [0.0128, -0.0062],
      [0.0088, -0.015, 0.0098, -0.0238],
      [0.0068, -0.0242],
      [0.0048, -0.015, 0.0068, -0.0062],
    ]),
    0.0058, 0.0009, accent, 6,
  );
  rbox(0.0016, 0.009, 0.0022, 0.0005, cutMat, 0, -0.0165, 0.0089);
  tag = null;

  // --- рукоятка: строго вертикальная, с бобровым хвостом сверху сзади и раструбом шахты снизу
  // Рукоятка доходит до самого затвора: скруглённые рёбра прячут её верх под затвор без «полки».
  // Сзади — короткий «бобровый хвост» под затвором.
  extrudeSide(
    shape([
      [-0.0222, SLIDE_BOTTOM],
      [-0.0225, -0.03],
      [-0.0205, -0.05, -0.022, -0.069],
      [-0.0185, -0.082], // раструб шахты магазина спереди
      [-0.0728, -0.082],
      [-0.0703, -0.071], // раструб сзади
      [-0.0672, -0.044, -0.0688, -0.016],
      [-0.070, -0.006, -0.0772, -0.002], // бобровый хвост
      [-0.0778, 0.003],
      [-0.0778, SLIDE_BOTTOM, -0.074, SLIDE_BOTTOM],
    ]),
    0.0272, 0.0035, polymerMat, 8,
  );
  // участки насечки по бокам рукоятки (чуть темнее и матовее самой рукоятки)
  {
    const panels = [];
    for (const side of [-1, 1]) {
      const g = new RoundedBoxGeometry(0.0012, 0.048, 0.032, 2, 0.0005);
      g.translate(side * 0.0137, -0.046, 0.0455);
      panels.push(g);
    }
    place(mergeGeometries(panels), gripMat);
    panels.forEach((g) => g.dispose());
  }
  // насечка спереди на рукоятке
  rbox(0.016, 0.044, 0.0012, 0.0005, gripMat, 0, -0.047, -0.0211);

  // пятка магазина
  rbox(0.029, 0.006, 0.0545, 0.0022, gripMat, 0, -0.0848, -0.0457);

  // --- органы управления
  for (const side of [-1, 1]) {
    rbox(0.0012, 0.0045, 0.0085, 0.0005, steelMat, side * 0.0119, 0.0005, 0.022); // рычаг разборки
  }
  rbox(0.0016, 0.0035, 0.017, 0.0006, cutMat, -0.012, 0.0045, -0.012); // затворная задержка слева
  rbox(0.0026, 0.0055, 0.0085, 0.001, cutMat, -0.0145, -0.012, -0.0262); // кнопка магазина слева

  // Детали одного материала — одним мешом; спуск и затвор — каждый в своём подвижном узле (pivot).
  // Спуск: пивот в верхней точке пластины у рамки. Затвор: пивот в начале координат, ходит по +Z.
  const trigger = { pivot: new THREE.Object3D(), maxAngle: 0.35 }; // ≈20°
  trigger.pivot.position.set(0, -0.0062, -0.0088);
  const slide = { pivot: new THREE.Object3D(), travel: 0.023 }; // ход назад, м
  group.add(trigger.pivot, slide.pivot);
  const holders = { trigger, slide };
  const byKey = new Map(); // материал + узел → геометрии
  for (const part of parts) {
    const key = part.material.uuid + (part.tag ?? '');
    if (!byKey.has(key)) byKey.set(key, { material: part.material, tag: part.tag, geometries: [] });
    byKey.get(key).geometries.push(part.geometry.clone().translate(part.center.x, part.center.y, part.center.z));
  }
  for (const { material, tag: owner, geometries } of byKey.values()) {
    const merged = mergeGeometries(geometries);
    const mesh = new THREE.Mesh(merged, material);
    if (owner === 'trigger') merged.translate(-trigger.pivot.position.x, -trigger.pivot.position.y, -trigger.pivot.position.z);
    (owner ? holders[owner].pivot : group).add(mesh);
    geometries.forEach((g) => g.dispose());
  }

  // Обводка (outlineM > 0): каждая деталь растянута от своего центра на outlineM с каждой стороны,
  // всё одной геометрией.
  let outlineGeometry = null;
  if (outlineM > 0) {
    const size = new THREE.Vector3();
    const shells = parts.filter((p) => p.tag !== 'trigger').map(({ geometry, center }) => {
      geometry.boundingBox.getSize(size);
      return geometry.clone()
        .scale(
          1 + (outlineM * 2) / Math.max(size.x, 1e-4),
          1 + (outlineM * 2) / Math.max(size.y, 1e-4),
          1 + (outlineM * 2) / Math.max(size.z, 1e-4),
        )
        .translate(center.x, center.y, center.z);
    });
    outlineGeometry = mergeGeometries(shells);
    shells.forEach((g) => g.dispose());
  }
  parts.forEach((part) => part.geometry.dispose());

  return {
    group,
    accent,
    outlineGeometry, // null без outlineM
    slide, // { pivot, travel }: pivot.position.z = сдвиг затвора назад
    trigger, // { pivot, maxAngle }: вращение pivot.rotation.x = −значение × maxAngle тянет спуск назад
    muzzle: new THREE.Vector3(0, BORE_Y, -(SLIDE_FRONT + 0.0018)), // откуда вылетает пуля
    ejector: new THREE.Vector3(SLIDE_W / 2 + 0.001, SLIDE_TOP - 0.006, -(PORT_F0 + PORT_F1) / 2), // окно выброса гильзы
  };
}
