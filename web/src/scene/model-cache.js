// Готовые модели оружия: строятся один раз (на шлеме ~0,1 с на пистолет: десятки скруглённых
// деталей, слияние геометрий, обводка) и дальше выдаются копиями — при подмене сцены и при спавне.
// Геометрии и текстуры у копий общие (только читаются), материалы и узлы — свои у каждой копии.
// Ключ — исходный текст функции-строителя и параметры: правка модели строит её заново.
//
//   const model = cachedBuild(buildPistol, THREE, { outlineM: 0.0025 }); // то же, что buildPistol(...)
export function cachedBuild(build, THREE, options = {}) {
  const shared = (globalThis.__sceneState ??= {});
  const cache = (shared.modelCache ??= new Map());
  const slot = build.name + JSON.stringify(options);
  const source = build.toString() + (shared.weaponEnv?.uuid ?? ''); // строитель читает weaponEnv
  let entry = cache.get(slot);
  if (entry?.source !== source) {
    entry = { source, template: build(THREE, options) };
    cache.set(slot, entry);
  }
  return instantiate(entry.template);
}

function instantiate(template) {
  const group = template.group.clone(true);
  const nodes = new Map();
  const from = [];
  const to = [];
  template.group.traverse((node) => from.push(node));
  group.traverse((node) => to.push(node));
  from.forEach((node, i) => nodes.set(node, to[i]));
  const materials = new Map();
  const materialOf = (material) => {
    if (!materials.has(material)) materials.set(material, material.clone());
    return materials.get(material);
  };
  for (const node of to) {
    if (node.material) node.material = Array.isArray(node.material) ? node.material.map(materialOf) : materialOf(node.material);
  }
  const copy = (value) => {
    if (!value || typeof value !== 'object') return value;
    if (value.isObject3D) return nodes.get(value) ?? value.clone();
    if (value.isMaterial) return materialOf(value);
    if (value.isVector2 || value.isVector3 || value.isVector4 || value.isQuaternion || value.isEuler || value.isMatrix4 || value.isColor) return value.clone();
    if (Array.isArray(value)) return value.map(copy);
    if (Object.getPrototypeOf(value) !== Object.prototype) return value; // геометрии, текстуры: общие
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = copy(item);
    return out;
  };
  return copy(template);
}
