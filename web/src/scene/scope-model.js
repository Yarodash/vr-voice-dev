// Оптический прицел (корпус) с размерами из параметров: труба, колокол объектива, окуляр с резиновым
// наглазником, барабаны поправок, кольца со стойками. Стёкла — scope-lens.js (ставит pistols.js по
// данным, которые возвращает сборщик). Детали одного материала слиты; обводка — своя. Матовый чёрный,
// текстуры — общие с АВП (__sceneState.awpTex). Сейчас на «Калаше 2.0» (ak2-model.js); у АВП свой
// корпус в awp-model.js (те же формы, длиннее и уже). Живёт в сцене.
//
// buildScopeBody(THREE, spec, { node, fixed, outlineM }) — добавляет меши в node (то, что двигается
// с прицелом) и fixed (неподвижные детали крепления), возвращает
//   { eyepieceZ, objectiveZ, objectiveR, lensR, y, outlineGeometry (для node), fixedOutlineGeometry }
// spec: { y (ось), front (z переднего торца), objR, objLen, cone, tubeR, ocularZ (начало окуляра),
//   ocuR, end (z торца окуляра, за ним наглазник 16 мм), lensR (стекло окуляра), rings: [z…],
//   ringFloor (y, куда опускаются стойки колец), turretZ, extra(add) — свои детали: add.node / add.fixed }
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { makeTextures } from './awp-model.js';

const UV_M = 0.03;

export function buildScopeBody(THREE, spec, { node, fixed, outlineM = 0 }) {
  const shared = (globalThis.__sceneState ??= {});
  const env = shared.weaponEnv ?? null;
  const tex = (shared.awpTex ??= makeTextures(THREE));
  const scopeMat = new THREE.MeshStandardMaterial({ color: 0x141517, roughness: 0.62, metalness: 0.25, roughnessMap: tex.anodizeRough, envMap: env, envMapIntensity: 0.15 });
  const mountMat = new THREE.MeshStandardMaterial({ color: 0x24262a, roughness: 0.45, metalness: 0.35, roughnessMap: tex.anodizeRough, envMap: env, envMapIntensity: 0.18 });
  const rubber = new THREE.MeshStandardMaterial({ color: 0x151617, roughness: 0.95, metalness: 0, bumpMap: tex.rubberBump, bumpScale: 1.1 });
  const steel = new THREE.MeshStandardMaterial({ color: 0x2e2f32, roughness: 0.62, metalness: 0.4, roughnessMap: tex.steelRough, envMap: env, envMapIntensity: 0.18 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x060607, roughness: 0.9, metalness: 0 });

  const parts = []; // { geometry (отцентрована), center, material, where: 'node' | 'fixed' }
  let where = 'node';
  const planarUv = (g) => {
    const p = g.attributes.position;
    const n = g.attributes.normal;
    const uv = new Float32Array(p.count * 2);
    for (let i = 0; i < p.count; i += 1) {
      const ax = Math.abs(n.getX(i)), ay = Math.abs(n.getY(i)), az = Math.abs(n.getZ(i));
      let u, v;
      if (ax >= ay && ax >= az) { u = p.getZ(i); v = p.getY(i); } else if (ay >= az) { u = p.getZ(i); v = p.getX(i); } else { u = p.getX(i); v = p.getY(i); }
      uv[i * 2] = u / UV_M; uv[i * 2 + 1] = v / UV_M;
    }
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  };
  const place = (geometry, material, { rx = 0, ry = 0, rz = 0, x = 0, y = 0, z = 0 } = {}) => {
    let g = geometry.index ? geometry.toNonIndexed() : geometry;
    if (g !== geometry) geometry.dispose();
    for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal' && name !== 'uv') g.deleteAttribute(name);
    g.clearGroups();
    if (rx) g.rotateX(rx);
    if (ry) g.rotateY(ry);
    if (rz) g.rotateZ(rz);
    g.translate(x, y, z);
    planarUv(g);
    g.computeBoundingBox();
    const center = g.boundingBox.getCenter(new THREE.Vector3());
    g.translate(-center.x, -center.y, -center.z);
    g.computeBoundingBox();
    parts.push({ geometry: g, center, material, where });
  };
  const rbox = (w, h, d, material, x, y, z, { r = 0.002, seg = 1, ...rot } = {}) =>
    place(new RoundedBoxGeometry(w, h, d, seg, Math.min(r, w / 2.01, h / 2.01, d / 2.01)), material, { ...rot, x, y, z });
  const box = (w, h, d, material, x, y, z, rot = {}) => place(new THREE.BoxGeometry(w, h, d), material, { ...rot, x, y, z });
  const tubeZ = (r0, r1, z0, z1, material, x, y, segments = 32) => {
    const g = new THREE.CylinderGeometry(r1, r0, Math.abs(z1 - z0), segments, 1);
    g.rotateX(Math.PI / 2);
    if (z1 < z0) g.rotateY(Math.PI);
    place(g, material, { x, y, z: (z0 + z1) / 2 });
  };
  const cylX = (r, h, material, x, y, z, segments = 24) => place(new THREE.CylinderGeometry(r, r, h, segments), material, { rz: Math.PI / 2, x, y, z });
  const cylY = (r, h, material, x, y, z, segments = 24) => place(new THREE.CylinderGeometry(r, r, h, segments), material, { x, y, z });
  const lathe = (points, material, segments = 40) => {
    const g = new THREE.LatheGeometry(points.map(([r, z]) => new THREE.Vector2(r, z)), segments);
    g.rotateX(Math.PI / 2);
    place(g, material, { y: spec.y });
  };

  const { y: sy, front: f, objR, objLen, cone, tubeR, ocularZ: o0, ocuR, end: e, lensR } = spec;
  const lensO = objR - 0.004; // стекло объектива
  // корпус вращением: объектив → конус → труба → окуляр
  lathe([
    [lensO, f + 0.007], [lensO, f], [objR - 0.0013, f - 0.003], [objR, f + 0.002], [objR, f + objLen], [objR - 0.0025, f + objLen + 0.013],
    [tubeR, f + objLen + cone], [tubeR, o0], [(tubeR + ocuR) / 2 + 0.0015, o0 + 0.016], [ocuR, o0 + 0.024], [ocuR, e - 0.001], [lensR, e - 0.0005],
  ], scopeMat);
  lathe([[ocuR - 0.0007, e - 0.002], [ocuR + 0.0015, e], [ocuR + 0.0017, e + 0.013], [ocuR + 0.0003, e + 0.016], [ocuR - 0.0017, e + 0.014], [ocuR - 0.0019, e + 0.0005]], rubber, 32); // наглазник
  for (const z of [f + 0.01, f + 0.02]) tubeZ(objR + 0.0004, objR + 0.0004, z, z + 0.003, scopeMat, 0, sy, 40); // рёбра объектива
  tubeZ(ocuR + 0.0005, ocuR + 0.0005, o0 + 0.03, o0 + 0.034, scopeMat, 0, sy, 32); // ребро окуляра
  // барабаны: вертикальный (сверху) с насечкой, горизонтальный (справа), подсветка (слева)
  const tz = spec.turretZ;
  tubeZ(tubeR + 0.003, tubeR + 0.003, tz - 0.022, tz + 0.022, scopeMat, 0, sy, 32); // седло
  const turretR = Math.max(0.011, tubeR * 0.7);
  cylY(turretR, 0.02, scopeMat, 0, sy + tubeR + 0.003 + 0.01, tz, 32);
  cylY(turretR + 0.001, 0.004, scopeMat, 0, sy + tubeR + 0.003 + 0.021, tz, 32);
  for (let i = 0; i < 14; i += 1) {
    const a = (i / 14) * Math.PI * 2;
    box(0.002, 0.01, 0.002, dark, Math.cos(a) * (turretR + 0.0001), sy + tubeR + 0.003 + 0.013, tz + Math.sin(a) * (turretR + 0.0001), { ry: -a });
  }
  cylX(turretR, 0.02, scopeMat, tubeR + 0.003 + 0.01, sy, tz, 28);
  cylX(turretR * 0.8, 0.014, scopeMat, -(tubeR + 0.003 + 0.007), sy, tz, 24);
  cylX(0.004, 0.003, dark, tubeR + 0.003 + 0.0215, sy, tz, 12);
  // кольца со стойками до ringFloor
  for (const z of spec.rings) {
    tubeZ(tubeR + 0.0035, tubeR + 0.0035, z - 0.008, z + 0.008, scopeMat, 0, sy, 32);
    const top = sy - tubeR - 0.001;
    const h = Math.max(0.004, top - spec.ringFloor);
    rbox(tubeR * 1.5, h, 0.014, mountMat, 0, spec.ringFloor + h / 2, z, { r: 0.002, seg: 2 });
    for (const side of [-1, 1]) cylX(0.0022, 0.004, steel, side * (tubeR + 0.003), sy + tubeR * 0.65, z - 0.004, 8); // винты крышки
  }
  // свои детали (крепление): add.node(...) / add.fixed(...)
  spec.extra?.({
    node: (fn) => { where = 'node'; fn(); },
    fixed: (fn) => { where = 'fixed'; fn(); where = 'node'; },
    rbox, box, tubeZ, cylX, cylY, mats: { scopeMat, mountMat, steel, dark, rubber },
  });
  where = 'node';

  // ---- сборка по материалу и месту
  const byKey = new Map();
  for (const part of parts) {
    const key = part.material.uuid + part.where;
    if (!byKey.has(key)) byKey.set(key, { material: part.material, where: part.where, geometries: [] });
    byKey.get(key).geometries.push(part.geometry.clone().translate(part.center.x, part.center.y, part.center.z));
  }
  for (const { material, where: at, geometries } of byKey.values()) {
    const merged = mergeGeometries(geometries);
    (at === 'fixed' ? fixed : node).add(new THREE.Mesh(merged, material));
    geometries.forEach((g) => g.dispose());
  }
  // обводка (мелочь — прорези, насечки — не нужна)
  const shellsOf = (list) => {
    if (!list.length || outlineM <= 0) return null;
    const size = new THREE.Vector3();
    return mergeGeometries(list.map(({ geometry, center }) => {
      geometry.boundingBox.getSize(size);
      const g = geometry.clone()
        .scale(1 + (outlineM * 2) / Math.max(size.x, 1e-4), 1 + (outlineM * 2) / Math.max(size.y, 1e-4), 1 + (outlineM * 2) / Math.max(size.z, 1e-4))
        .translate(center.x, center.y, center.z);
      const only = new THREE.BufferGeometry();
      only.setAttribute('position', g.attributes.position);
      return only;
    }));
  };
  const outlineGeometry = shellsOf(parts.filter((p) => p.where === 'node' && p.material !== dark));
  const fixedOutlineGeometry = shellsOf(parts.filter((p) => p.where === 'fixed' && p.material !== dark));
  parts.forEach((p) => p.geometry.dispose());
  return { y: sy, eyepieceZ: e - 0.0015, objectiveZ: f + 0.007, objectiveR: lensO, lensR, outlineGeometry, fixedOutlineGeometry };
}
