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

  // Карты окружения в сцене нет, поэтому металл не делаем «зеркальным» — иначе он уходит в чёрное.
  const slideMat = new THREE.MeshStandardMaterial({ color: 0x4a5058, roughness: 0.38, metalness: 0.6 });
  const polymerMat = new THREE.MeshStandardMaterial({ color: 0x33363b, roughness: 0.78, metalness: 0.0 });
  const gripMat = new THREE.MeshStandardMaterial({ color: 0x2c2f33, roughness: 1.0, metalness: 0.0 });
  const grooveMat = new THREE.MeshStandardMaterial({ color: 0x2a2e33, roughness: 0.6, metalness: 0.4 });
  const cutMat = new THREE.MeshStandardMaterial({ color: 0x16181b, roughness: 0.7, metalness: 0.3 });
  const steelMat = new THREE.MeshStandardMaterial({ color: 0x8c939b, roughness: 0.35, metalness: 0.45 });
  const whiteMat = new THREE.MeshStandardMaterial({ color: 0xf2f4f7, roughness: 0.4, metalness: 0, emissive: 0x2a2a2a });
  // Оранжевый спуск светится, пока пистолет рядом или в руке (см. glow в main.js).
  const accent = new THREE.MeshStandardMaterial({ color: 0xf97316, roughness: 0.45, metalness: 0.1, emissive: 0x000000 });

  // Деталь из геометрии в координатах пистолета: геометрия центрируется, деталь запоминается со своим
  // центром. В конце детали одного материала сливаются в один меш (меньше вызовов отрисовки), а
  // обводка — в одну геометрию из всех деталей, каждая растянута от своего центра.
  const parts = []; // { geometry (отцентрована), center, material }
  const place = (geometry, material) => {
    geometry.computeBoundingBox();
    const center = geometry.boundingBox.getCenter(new THREE.Vector3());
    geometry.translate(-center.x, -center.y, -center.z);
    const indexed = geometry.index ? geometry.toNonIndexed() : geometry;
    if (indexed !== geometry) geometry.dispose();
    indexed.computeBoundingBox();
    parts.push({ geometry: indexed, center, material });
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

  // Детали одного материала — одним мешом.
  const byMaterial = new Map();
  for (const part of parts) {
    if (!byMaterial.has(part.material)) byMaterial.set(part.material, []);
    byMaterial.get(part.material).push(part.geometry.clone().translate(part.center.x, part.center.y, part.center.z));
  }
  for (const [material, geometries] of byMaterial) {
    group.add(new THREE.Mesh(mergeGeometries(geometries), material));
    geometries.forEach((g) => g.dispose());
  }

  // Обводка (outlineM > 0): каждая деталь растянута от своего центра на outlineM с каждой стороны,
  // всё одной геометрией.
  let outlineGeometry = null;
  if (outlineM > 0) {
    const size = new THREE.Vector3();
    const shells = parts.map(({ geometry, center }) => {
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
    muzzle: new THREE.Vector3(0, BORE_Y, -(SLIDE_FRONT + 0.0018)), // откуда вылетает пуля
    ejector: new THREE.Vector3(SLIDE_W / 2 + 0.001, SLIDE_TOP - 0.006, -(PORT_F0 + PORT_F1) / 2), // окно выброса гильзы
  };
}
