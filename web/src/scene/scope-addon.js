// Прицел-модель на сгенерированной пушке (generated-guns.js addScope): у картинки/GLB прицела нет —
// строится настоящий корпус (scope-model.js buildScopeBody) на низкой планке над верхом ствольной
// коробки и в нём — объёмные стёкла scope-lens.js (окуляр к прикладу, объектив к дулу). Ось прицела
// параллельна стволу (−Z оружия). Наклон стиком, панель «Отладка прицела», размер (gun-resize.js —
// масштаб всей группы) — как у scope: прицел лежит в той же группе оружия.
//
// addScope: { at: [x, y] — ПИКСЕЛИ card.png: точка на верхнем краю коробки, над которой середина
//   крепления; length = 0.28 — длина корпуса с наглазником, м; zoom = 5; height — ось над точкой at, м
//   (по умолчанию радиус колокола + 14 мм); style = 'emerald' (оружейный металл + зелёная подсветка) |
//   'black'; reticle = 'duplex'; tanApparent = 0.26 }
//
// createAddedScope(THREE, sc, { outlineMaterial, outlineM, makeLens, model }) → { mount, place(from) }:
// mount — в группу оружия; place(from) — по mapPx картинки или модели (переставляет крепление, при
// первом вызове строит корпус и стёкла, заполняет model.scope / lens / scopeOutline / fixedOutline).
import { buildScopeBody } from './scope-model.js';

const STYLES = {
  emerald: { body: 0x565d64, bodyMetal: 0.7, bodyRough: 0.36, env: 0.6, mount: 0x6b7279, glow: 0x22ff88 },
  black: { body: 0x141517, bodyMetal: 0.25, bodyRough: 0.62, env: 0.15, mount: 0x24262a, glow: null },
};
const BASE_LEN = 0.28; // длина, под которую заданы продольные размеры корпуса

export function createAddedScope(THREE, sc, { outlineMaterial, outlineM = 0, makeLens = null, model }) {
  const mount = new THREE.Group(); // в точке крепления; не наклоняется
  const node = new THREE.Group(); // корпус и стёкла: наклон стиком (pistols.updateLenses)
  const fixed = new THREE.Group(); // планка на коробке
  mount.add(node, fixed);
  mount.name = 'addedScope'; // для vr:eval: root.getObjectByName('addedScope').parent — пушка
  const style = STYLES[sc.style ?? 'emerald'] ?? STYLES.emerald;
  const k = (sc.length ?? BASE_LEN) / BASE_LEN;
  // стекло окуляра — почти во весь окуляр (до резины наглазника ≈ 0,3 мм), объектива — во весь колокол
  const objR = 0.03, tubeR = 0.016, ocuR = 0.022, lensR = 0.0198;
  const objLen = 0.04 * k, cone = 0.03 * k;
  const front = -0.16 * k, end = 0.104 * k;
  const ocularZ = end - 0.055 * k;
  const rings = [-0.04 * k, 0.036 * k];
  const y = sc.height ?? objR + 0.014;
  let built = false;

  const build = () => {
    built = true;
    const glow = style.glow == null ? null : new THREE.MeshBasicMaterial({ color: style.glow });
    const body = buildScopeBody(THREE, {
      y, front, objR, objLen, cone, tubeR, ocularZ, ocuR, end, lensR, turretZ: 0, rings, ringFloor: 0,
      extra: ({ node: inNode, fixed: inFixed, rbox, box, tubeZ, cylY, mats }) => {
        mats.scopeMat.color.setHex(style.body);
        mats.scopeMat.metalness = style.bodyMetal;
        mats.scopeMat.roughness = style.bodyRough;
        mats.scopeMat.envMapIntensity = style.env;
        mats.mountMat.color.setHex(style.mount);
        mats.mountMat.envMapIntensity = style.env;
        inFixed(() => {
          // низкая планка на крышке коробки (на 20 мм уходит вниз — верх модели не ровный)
          const railLen = rings[1] - rings[0] + 0.04;
          rbox(0.036, 0.022, railLen, mats.mountMat, 0, -0.009, 0, { r: 0.002, seg: 2 });
          for (let i = 0; i < 7; i += 1) box(0.037, 0.0015, 0.003, mats.dark, 0, 0.0016, -railLen / 2 + 0.008 + i * ((railLen - 0.016) / 6)); // поперечные пазы
          if (glow) for (const side of [-1, 1]) box(0.0008, 0.002, railLen * 0.7, glow, side * 0.0182, -0.005, 0); // светящиеся полосы по бокам
        });
        inNode(() => {
          // крепкие ножки: широкая стойка от планки до кольца, лапа-зажим на планке, толстый хомут на трубе
          const top = y - tubeR;
          for (const z of rings) {
            rbox(0.03, top, 0.022, mats.mountMat, 0, top / 2, z, { r: 0.003, seg: 2 });
            rbox(0.036, 0.008, 0.03, mats.mountMat, 0, 0.004, z, { r: 0.002, seg: 2 });
            tubeZ(tubeR + 0.005, tubeR + 0.005, z - 0.011, z + 0.011, mats.mountMat, 0, y, 40);
            for (const side of [-1, 1]) box(0.0012, 0.004, 0.004, mats.dark, side * 0.0151, top * 0.55, z); // облегчающие окна
            if (glow) for (const side of [-1, 1]) box(0.0008, top * 0.5, 0.0025, glow, side * 0.0151, top * 0.55, z + 0.0065); // светящиеся риски
          }
        });
        if (!glow) return;
        inNode(() => {
          tubeZ(objR + 0.0007, objR + 0.0007, front + objLen - 0.012, front + objLen - 0.009, glow, 0, y, 48); // кольцо на колоколе
          tubeZ(ocuR + 0.0007, ocuR + 0.0007, ocularZ + 0.04 * k, ocularZ + 0.04 * k + 0.003, glow, 0, y, 40); // кольцо на окуляре
          for (const side of [-1, 1]) for (let i = 0; i < 4; i += 1) box(0.0012, 0.008, 0.0022, glow, side * (tubeR + 0.0001), y, rings[0] - 0.014 - i * 0.005); // риски на трубе
          cylY(0.006, 0.0012, glow, 0, y + tubeR + 0.003 + 0.0235, 0, 24); // крышка барабана
        });
      },
    }, { node, fixed, outlineM });
    if (glow) {
      // светящиеся кольца вокруг стёкол — открытые (тор), стекло не закрывают
      const ringO = new THREE.Mesh(new THREE.TorusGeometry(objR - 0.0034, 0.0011, 8, 56), glow);
      ringO.position.set(0, y, front + 0.0062);
      const ringE = new THREE.Mesh(new THREE.TorusGeometry(lensR + 0.0005, 0.0006, 8, 48), glow);
      ringE.position.set(0, y, end - 0.0022);
      node.add(ringO, ringE);
    }
    for (const g of [node, fixed]) g.traverse((o) => { if (o.isMesh) o.renderOrder = 902; });
    model.scope = {
      node, y: body.y, eyepieceZ: body.eyepieceZ, objectiveZ: body.objectiveZ, objectiveR: body.objectiveR, lensR: body.lensR,
      minZ: 0, maxZ: 0, defaultZ: 0, magnification: sc.zoom ?? 5, tanApparent: sc.tanApparent ?? 0.26, reticle: sc.reticle ?? 'duplex',
    };
    model.lens = makeLens?.(model.scope) ?? null;
    if (model.lens) {
      model.lens.eyepiece.position.set(0, body.y, body.eyepieceZ);
      model.lens.objective.position.set(0, body.y, body.objectiveZ);
      model.lens.objective.scale.setScalar(body.objectiveR);
      model.lens.eyepiece.renderOrder = model.lens.objective.renderOrder = 902;
      node.add(model.lens.eyepiece, model.lens.objective);
    }
    const outlined = (geometry, parent) => {
      if (!geometry || !outlineMaterial) return null;
      const mesh = new THREE.Mesh(geometry, outlineMaterial);
      mesh.visible = false;
      mesh.renderOrder = 901;
      parent.add(mesh);
      return mesh;
    };
    model.scopeOutline = outlined(body.outlineGeometry, node); // видимость — pistols.updateLenses
    model.fixedOutline = outlined(body.fixedOutlineGeometry, fixed);
  };

  return {
    mount,
    place(from) {
      if (!from?.mapPx) return;
      const [py, pz] = from.mapPx(sc.at[0], sc.at[1]);
      mount.position.set(0, py, pz);
      if (!built) build();
    },
  };
}
