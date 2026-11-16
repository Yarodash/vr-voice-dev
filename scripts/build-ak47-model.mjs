// Собирает web/public/models/ak47/ak47.glb из скачанного OBJ (CC0, Lamoot, OpenGameArt:
// https://opengameart.org/content/high-poly-ak-47 , файл highpoly_ak47.obj).
//
//   node scripts/build-ak47-model.mjs путь/к/highpoly_ak47.obj
//
// Что делает: разбивает модель на связные детали, раскладывает их по материалам (дерево — приклад,
// пистолетная рукоятка, цевьё и накладка; спуск — отдельно, остальное — сталь), переводит в систему
// оружия сцены (метры, ствол в −Z, верх +Y, середина пистолетной рукоятки в HANDLE), считает
// нормали с изломом по углу, UV для дерева (волокна вдоль ствола) и готовую обводку (каждая деталь
// растянута от своего центра на OUTLINE_M). Точки дула и окна выброса — в extras сцены (userData).
import fs from 'node:fs';
import path from 'node:path';
import * as THREE from 'three';
import { mergeVertices, toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

const SOURCE = process.argv[2];
const OUT = path.resolve('web/public/models/ak47/ak47.glb');
const SCALE = 0.1; // длина исходника 8.8 единиц → 0.88 м
const HANDLE = new THREE.Vector3(0, -0.04, 0.045);
const OUTLINE_M = 0.0025;
const CREASE = THREE.MathUtils.degToRad(38);
const WOOD_M = 0.45; // текстура дерева покрывает 0.45 × 0.45 м

// ---- OBJ: вершины и грани (многоугольники → треугольники веером)
const v = [];
const faces = [];
for (const line of fs.readFileSync(SOURCE, 'utf8').split('\n')) {
  const p = line.trim().split(/\s+/);
  if (p[0] === 'v') v.push([+p[1], +p[2], +p[3]]);
  else if (p[0] === 'f') faces.push(p.slice(1).map((s) => parseInt(s, 10) - 1));
}

// ---- связные детали
const parent = v.map((_, i) => i);
const find = (i) => {
  while (parent[i] !== i) i = parent[i] = parent[parent[i]];
  return i;
};
for (const face of faces) for (let k = 1; k < face.length; k += 1) parent[find(face[0])] = find(face[k]);
const comps = new Map();
for (const face of faces) {
  const r = find(face[0]);
  if (!comps.has(r)) comps.set(r, { faces: [], box: new THREE.Box3() });
  const c = comps.get(r);
  c.faces.push(face);
  for (const i of face) c.box.expandByPoint(new THREE.Vector3(...v[i]));
}

// какая деталь из какого материала (по габаритам в единицах исходника)
const near = (a, b) => Math.abs(a - b) < 0.03;
const kindOf = ({ box: { min, max } }) => {
  if (min.z > 1.95 && max.z > 4) return 'wood'; // приклад
  if (min.y < -0.7 && min.z > 1.1) return 'wood'; // пистолетная рукоятка
  if (near(min.z, -2.44) && near(max.z, -0.9) && near(min.y, 0.36)) return 'wood'; // цевьё
  if (near(min.z, -2.44) && near(max.z, -1.38) && near(min.y, 0.86)) return 'wood'; // накладка на газовую трубку
  if (near(min.z, 0.89) && near(max.z, 1.21) && near(min.y, 0.1)) return 'trigger';
  return 'steel';
};

// ---- в систему оружия: x — от оси ствола, всё ×SCALE, затем рукоятка в HANDLE
const barrelX = 2.445;
const toLocal = (p) => new THREE.Vector3((p[0] - barrelX) * SCALE, p[1] * SCALE, p[2] * SCALE);
// середина ладони: на оси рукоятки (между верхним и нижним поясом вершин) на высоте PALM_Y.
// Посередине у рукоятки вершин нет (длинные грани), поэтому ось — по двум поясам.
const PALM_Y = -0.2;
const gripComp = [...comps.values()].find((c) => c.box.min.y < -0.7 && c.box.min.z > 1.1);
const ring = (y0, y1) => {
  const sum = new THREE.Vector3();
  let count = 0;
  for (const face of gripComp.faces) for (const i of face) {
    if (v[i][1] > y0 && v[i][1] < y1) {
      sum.add(new THREE.Vector3(...v[i]));
      count += 1;
    }
  }
  return sum.divideScalar(count);
};
const top = ring(-0.1, 0.12);
const bottom = ring(-0.7, -0.45);
const palmSource = top.clone().lerp(bottom, (PALM_Y - top.y) / (bottom.y - top.y));
const palm = toLocal(palmSource.toArray());
palm.x = 0;
console.log('palm (source units)', palmSource.toArray().map((n) => n.toFixed(3)).join(' '));
const shift = HANDLE.clone().sub(palm);
const place = (p) => toLocal(p).add(shift);

const groups = { wood: [], steel: [], trigger: [] };
const outlineParts = [];
for (const comp of comps.values()) {
  const kind = kindOf(comp);
  const tris = [];
  for (const face of comp.faces) for (let k = 1; k < face.length - 1; k += 1) tris.push(face[0], face[k], face[k + 1]);
  const positions = new Float32Array(tris.length * 3);
  tris.forEach((i, n) => place(v[i]).toArray(positions, n * 3));
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  groups[kind].push(geometry);

  // обводка: деталь растянута от центра своих габаритов на OUTLINE_M с каждой стороны
  geometry.computeBoundingBox();
  const center = geometry.boundingBox.getCenter(new THREE.Vector3());
  const size = geometry.boundingBox.getSize(new THREE.Vector3());
  const k = [0, 1, 2].map((a) => 1 + (OUTLINE_M * 2) / Math.max(size.getComponent(a), 1e-4));
  const shell = positions.slice();
  for (let n = 0; n < shell.length; n += 3) {
    for (let a = 0; a < 3; a += 1) shell[n + a] = center.getComponent(a) + (shell[n + a] - center.getComponent(a)) * k[a];
  }
  outlineParts.push(shell);
}

const concat = (arrays) => {
  const out = new Float32Array(arrays.reduce((s, a) => s + a.length, 0));
  let o = 0;
  for (const a of arrays) {
    out.set(a, o);
    o += a.length;
  }
  return out;
};

// материал → индексированная геометрия с нормалями (излом по углу) и, для дерева, UV
const build = (list, withUv) => {
  let geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(concat(list.map((g) => g.attributes.position.array)), 3));
  geometry = toCreasedNormals(geometry, CREASE);
  if (withUv) {
    // проекция по преобладающей оси нормали грани; волокна (v) — вдоль ствола (z)
    const pos = geometry.attributes.position;
    const uv = new Float32Array(pos.count * 2);
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3();
    for (let t = 0; t < pos.count; t += 3) {
      a.fromBufferAttribute(pos, t);
      b.fromBufferAttribute(pos, t + 1);
      c.fromBufferAttribute(pos, t + 2);
      n.subVectors(c, b).cross(a.clone().sub(b)).normalize();
      const ax = Math.abs(n.x), ay = Math.abs(n.y), az = Math.abs(n.z);
      for (let j = 0; j < 3; j += 1) {
        const p = [a, b, c][j];
        let u, w;
        if (ax >= ay && ax >= az) [u, w] = [p.y, p.z];
        else if (ay >= az) [u, w] = [p.x + 0.31, p.z];
        else [u, w] = [p.x + 0.57, p.y + 0.13];
        uv[(t + j) * 2] = u / WOOD_M;
        uv[(t + j) * 2 + 1] = w / WOOD_M;
      }
    }
    geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  }
  return mergeVertices(geometry, 1e-6);
};

const meshes = [
  ['wood', build(groups.wood, true)],
  ['steel', build(groups.steel, false)],
  ['trigger', build(groups.trigger, false)],
];
{
  let outline = new THREE.BufferGeometry();
  outline.setAttribute('position', new THREE.BufferAttribute(concat(outlineParts), 3));
  meshes.push(['outline', mergeVertices(outline, 1e-6)]);
}

// ---- точки для стрельбы (в системе оружия)
const pt = (x, y, z) => place([x, y, z]).toArray().map((n) => +n.toFixed(5));
const extras = {
  muzzle: pt(barrelX, 0.72, -4.67), // срез дульного тормоза, ось канала
  ejector: pt(2.68, 0.98, -0.1), // окно выброса справа под крышкой ствольной коробки
  handle: HANDLE.toArray(),
  source: 'High-poly AK-47 by Lamoot, CC0, https://opengameart.org/content/high-poly-ak-47',
};

// ---- GLB
const chunks = [];
let byteLength = 0;
const bufferViews = [];
const accessors = [];
const addView = (typed, target) => {
  const bytes = Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength);
  const pad = (4 - (byteLength % 4)) % 4;
  if (pad) {
    chunks.push(Buffer.alloc(pad));
    byteLength += pad;
  }
  bufferViews.push({ buffer: 0, byteOffset: byteLength, byteLength: bytes.length, target });
  chunks.push(bytes);
  byteLength += bytes.length;
  return bufferViews.length - 1;
};
const addAccessor = (attribute, type) => {
  const array = attribute.array instanceof Float32Array ? attribute.array : new Float32Array(attribute.array);
  const view = addView(array, 34962);
  const accessor = { bufferView: view, componentType: 5126, count: attribute.count, type };
  if (type === 'VEC3') {
    const box = new THREE.Box3().setFromBufferAttribute(attribute);
    accessor.min = box.min.toArray();
    accessor.max = box.max.toArray();
  }
  accessors.push(accessor);
  return accessors.length - 1;
};
const gltfMeshes = [];
const nodes = [];
let triangles = 0;
for (const [name, geometry] of meshes) {
  const attributes = { POSITION: addAccessor(geometry.attributes.position, 'VEC3') };
  if (geometry.attributes.normal) attributes.NORMAL = addAccessor(geometry.attributes.normal, 'VEC3');
  if (geometry.attributes.uv) attributes.TEXCOORD_0 = addAccessor(geometry.attributes.uv, 'VEC2');
  const index = geometry.index.array;
  const small = geometry.attributes.position.count < 65536;
  const indices = small ? new Uint16Array(index) : new Uint32Array(index);
  const view = addView(indices, 34963);
  accessors.push({ bufferView: view, componentType: small ? 5123 : 5125, count: indices.length, type: 'SCALAR' });
  gltfMeshes.push({ name, primitives: [{ attributes, indices: accessors.length - 1 }] });
  nodes.push({ name, mesh: gltfMeshes.length - 1 });
  if (name !== 'outline') triangles += indices.length / 3;
  console.log(name, 'vertices', geometry.attributes.position.count, 'triangles', indices.length / 3);
}
const bin = Buffer.concat(chunks);
const json = {
  asset: { version: '2.0', generator: 'scripts/build-ak47-model.mjs', copyright: 'CC0 — Lamoot (OpenGameArt)' },
  scene: 0,
  scenes: [{ name: 'ak47', nodes: nodes.map((_, i) => i), extras }],
  nodes,
  meshes: gltfMeshes,
  accessors,
  bufferViews,
  buffers: [{ byteLength: bin.length }],
};
let jsonBuf = Buffer.from(JSON.stringify(json));
jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc((4 - (jsonBuf.length % 4)) % 4, 0x20)]);
const binBuf = Buffer.concat([bin, Buffer.alloc((4 - (bin.length % 4)) % 4)]);
const header = Buffer.alloc(12);
header.writeUInt32LE(0x46546c67, 0);
header.writeUInt32LE(2, 4);
header.writeUInt32LE(12 + 8 + jsonBuf.length + 8 + binBuf.length, 8);
const chunkHeader = (length, type) => {
  const b = Buffer.alloc(8);
  b.writeUInt32LE(length, 0);
  b.writeUInt32LE(type, 4);
  return b;
};
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, Buffer.concat([header, chunkHeader(jsonBuf.length, 0x4e4f534a), jsonBuf, chunkHeader(binBuf.length, 0x004e4942), binBuf]));
console.log('written', OUT, fs.statSync(OUT).size, 'bytes; triangles (без обводки)', triangles, 'extras', JSON.stringify(extras));
