// «Калаш 2.0» — тот же автомат (ak-model.js, скачанная модель) с прицелом: короткий (≈ 20 см), но
// толстый (труба 38 мм, колокол 66 мм, окуляр 55 мм, стекло окуляра крупнее, чем у АВП) прицел
// 4× с сеткой-уголками на классическом боковом креплении: «ласточкин хвост» на левой стенке
// ствольной коробки, на нём зажим с рычагом, из него поднимается стойка и мостик над крышкой
// ствольной коробки, на мостике — кольца. Прицел над осью ствола. Стёкла — scope-lens.js (pistols.js).
//
// buildAk2(THREE, { outlineM }) → всё, что buildAk, + scope (как у АВП: node, y, eyepieceZ,
// objectiveZ, objectiveR, lensR, outlineGeometry, minZ = maxZ = 0, magnification, tanApparent,
// reticle) + fixedOutlineGeometry (обводка неподвижной части крепления).
import { buildAk } from './ak-model.js';
import { buildScopeBody } from './scope-model.js';

const AXIS_Y = 0.13; // ось прицела (ствол — 0.052; крышка коробки — до 0.092)
const BRIDGE_TOP = 0.104;

export function buildAk2(THREE, { outlineM = 0 } = {}) {
  const ak = buildAk(THREE);
  const node = new THREE.Group(); // прицел с мостиком: наклоняется стиком (pistols.updateLenses)
  const fixed = new THREE.Group(); // планка и зажим на коробке
  ak.group.add(node, fixed);
  const body = buildScopeBody(THREE, {
    y: AXIS_Y, front: -0.1, objR: 0.033, objLen: 0.03, cone: 0.022, tubeR: 0.019,
    ocularZ: 0.028, ocuR: 0.0275, end: 0.084, lensR: 0.025, turretZ: -0.01,
    rings: [-0.036, 0.018], ringFloor: BRIDGE_TOP,
    extra: ({ node: inNode, fixed: inFixed, rbox, cylX, cylY, box, mats }) => {
      inNode(() => {
        // мостик над крышкой коробки и стойка вниз по левому боку (уходит в зажим)
        rbox(0.048, 0.008, 0.09, mats.mountMat, -0.011, BRIDGE_TOP - 0.004, -0.01, { r: 0.003, seg: 2 });
        rbox(0.008, 0.05, 0.07, mats.mountMat, -0.031, BRIDGE_TOP - 0.025, -0.012, { r: 0.003, seg: 2 });
        for (let i = 0; i < 3; i += 1) box(0.0012, 0.008, 0.012, mats.dark, -0.0352, BRIDGE_TOP - 0.02, -0.035 + i * 0.022); // облегчающие окна
      });
      inFixed(() => {
        // «ласточкин хвост» на левой стенке коробки и зажим на нём с рычагом
        rbox(0.005, 0.02, 0.13, mats.steel, -0.0255, 0.055, -0.025, { r: 0.0015 });
        rbox(0.014, 0.034, 0.08, mats.mountMat, -0.033, 0.06, -0.012, { r: 0.003, seg: 2 });
        cylX(0.006, 0.006, mats.steel, -0.042, 0.06, 0.012, 16); // ось рычага
        rbox(0.005, 0.008, 0.055, mats.steel, -0.044, 0.06, -0.012, { r: 0.002 }); // рычаг
        cylY(0.0045, 0.006, mats.steel, -0.033, 0.045, -0.04, 12); // винт
      });
    },
  }, { node, fixed, outlineM });

  return {
    ...ak,
    scope: {
      node, y: body.y, eyepieceZ: body.eyepieceZ, objectiveZ: body.objectiveZ, objectiveR: body.objectiveR, lensR: body.lensR,
      minZ: 0, maxZ: 0, defaultZ: 0, outlineGeometry: body.outlineGeometry,
      magnification: 4, tanApparent: 0.34, reticle: 'pso',
    },
    fixedOutlineGeometry: body.fixedOutlineGeometry,
    fixedNode: fixed,
  };
}
