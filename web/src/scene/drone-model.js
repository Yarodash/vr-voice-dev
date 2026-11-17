// Квадрокоптеры (drones.js): геометрия и текстуры. Всё в единицах «размаха» (span = 1: от кончика
// винта до кончика винта ~1), вперёд −Z, вверх +Y; экземпляр масштабируется на свой размах.
//
// Два корпуса (по одному InstancedMesh на всех): «лёгкий» (маленький и средний — гоночная X-рама,
// голые винты) и «тяжёлый» (большой и огромный — бронированный корпус, винты в кольцах-обтекателях,
// ракетные подвесы). Пулемёт на подвесе-шаре — отдельная деталь (поворачивается к цели). Окраска —
// цвета вершин; у вершин атрибут paintSlot (0 — как есть, 1 — основной цвет команды, 2 — второй),
// подставляет шейдер drones.js (как у псов, robodog-instances.js).
//
// buildDroneGeometries(THREE) → { light, heavy, gun, rotor, puff } (BufferGeometry; кэш по исходнику
// в __sceneState, наружу — клоны) и константы посадки (MOTORS, ROTOR_R, GUN_PIVOT, GUN_MUZZLE, LIGHTS).
// droneTextures(THREE) → { rotor, glow, puff } (CanvasTexture, кэш в __sceneState, не освобождать).
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const M_LIGHT = 0.3; // моторы X-рамы: (±M, ., ±M)
const M_HEAVY = 0.31;
// где моторы (центры винтов) — по корпусу; [x, y, z]
export const MOTORS = {
  light: [[-M_LIGHT, 0.05, -M_LIGHT], [M_LIGHT, 0.05, -M_LIGHT], [-M_LIGHT, 0.05, M_LIGHT], [M_LIGHT, 0.05, M_LIGHT]],
  heavy: [[-M_HEAVY, 0.075, -M_HEAVY], [M_HEAVY, 0.075, -M_HEAVY], [-M_HEAVY, 0.075, M_HEAVY], [M_HEAVY, 0.075, M_HEAVY]],
};
export const ROTOR_R = { light: 0.19, heavy: 0.16 };
// шарнир пулемёта под корпусом и дуло (в системе пулемёта)
export const GUN_PIVOT = { light: [0, -0.1, -0.05], heavy: [0, -0.115, -0.12] };
export const GUN_MUZZLE = [0, 0.004, -0.26];
// огни: [x, y, z, вид] — 0 красный (слева), 1 зелёный (справа), 2 маяк команды (мигает), 3 белый строб
export const LIGHTS = {
  light: [[-M_LIGHT, 0.0, -M_LIGHT, 0], [M_LIGHT, 0.0, -M_LIGHT, 1], [0, 0.085, 0.12, 2], [0, -0.07, 0.1, 3]],
  heavy: [[-M_HEAVY - 0.19, 0.075, -M_HEAVY, 0], [M_HEAVY + 0.19, 0.075, -M_HEAVY, 1], [0, 0.13, 0.15, 2], [0, -0.07, 0.17, 3]],
};

const VERSION = 'drone-geo-1';

function build(THREE) {
  const color = new THREE.Color();
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const v = new THREE.Vector3();
  const one = new THREE.Vector3(1, 1, 1);
  // деталь: геометрия, цвет (hex, sRGB), слот краски, положение, поворот (x, y, z), масштаб
  const part = (list, g, hex, slot, pos, rot = [0, 0, 0], scl = null) => {
    color.set(hex);
    const n = g.attributes.position.count;
    const c = new Float32Array(n * 3);
    const s = new Float32Array(n);
    for (let i = 0; i < n; i += 1) {
      c[i * 3] = color.r;
      c[i * 3 + 1] = color.g;
      c[i * 3 + 2] = color.b;
      s[i] = slot;
    }
    g.setAttribute('color', new THREE.BufferAttribute(c, 3));
    g.setAttribute('paintSlot', new THREE.BufferAttribute(s, 1));
    q.setFromEuler(e.set(rot[0], rot[1], rot[2]));
    m.compose(v.set(pos[0], pos[1], pos[2]), q, scl ? new THREE.Vector3(...scl) : one);
    g.applyMatrix4(m);
    list.push(g);
  };
  const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);
  const cyl = (rt, rb, h, seg = 8) => new THREE.CylinderGeometry(rt, rb, h, seg);
  const sph = (r, ws = 8, hs = 6, thetaLen = Math.PI) => new THREE.SphereGeometry(r, ws, hs, 0, Math.PI * 2, 0, thetaLen);
  const merge = (list) => {
    const g = mergeGeometries(list, false);
    for (const p of list) p.dispose();
    g.computeBoundingSphere();
    return g;
  };
  const GRAPHITE = 0x24272b;
  const CARBON = 0x141518;
  const METAL = 0x6d7178;
  const SILVER = 0xb9bec4;
  const GLASS = 0x050607;
  const GUNMETAL = 0x2e3236;

  // ---- лёгкий: гоночная X-рама
  const L = [];
  part(L, box(0.2, 0.065, 0.3), GRAPHITE, 0, [0, 0, 0]);
  part(L, sph(0.1, 10, 4, Math.PI / 2), 0xffffff, 1, [0, 0.025, -0.01], [0, 0, 0], [1, 0.55, 1.5]); // колпак — цвет команды
  part(L, box(0.09, 0.04, 0.15), 0xffffff, 2, [0, 0.06, 0.06]); // батарея — второй цвет
  part(L, sph(0.024, 8, 6), GLASS, 0, [0, -0.005, -0.155]); // камера
  for (const [mx, , mz] of MOTORS.light) {
    const len = Math.hypot(mx, mz);
    const yaw = Math.atan2(mx, mz);
    part(L, box(0.034, 0.022, len), CARBON, 0, [mx / 2, 0, mz / 2], [0, yaw, 0]);
    part(L, box(0.042, 0.028, 0.08), 0xffffff, mz < 0 ? 1 : 2, [mx * 0.82, 0.003, mz * 0.82], [0, yaw, 0]); // кончики лучей
    part(L, cyl(0.034, 0.03, 0.045, 10), METAL, 0, [mx, 0.022, mz]);
    part(L, cyl(0.012, 0.012, 0.03, 6), SILVER, 0, [mx, 0.055, mz]);
  }
  part(L, box(0.04, 0.05, 0.04), CARBON, 0, [0, -0.055, -0.05]); // крепление подвеса
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) part(L, box(0.012, 0.07, 0.012), CARBON, 0, [sx * 0.075, -0.06, sz * 0.085]);
    part(L, box(0.014, 0.014, 0.27), CARBON, 0, [sx * 0.075, -0.095, 0]);
  }
  const light = merge(L);

  // ---- тяжёлый: броня, винты в кольцах, подвесы
  const H = [];
  part(H, box(0.26, 0.11, 0.46), GUNMETAL, 0, [0, 0, 0]);
  part(H, box(0.22, 0.08, 0.12), GUNMETAL, 0, [0, -0.012, -0.26], [-0.35, 0, 0]); // нос
  part(H, box(0.22, 0.03, 0.34), 0xffffff, 1, [0, 0.068, 0.02]); // верхняя бронеплита — цвет команды
  part(H, box(0.272, 0.034, 0.1), 0xffffff, 2, [0, 0.015, 0.13]); // полоса
  part(H, box(0.12, 0.05, 0.12), GUNMETAL, 0, [0, 0.1, 0.12]); // горб с электроникой
  part(H, sph(0.048, 10, 6), GLASS, 0, [0, -0.058, -0.21]); // сенсор
  part(H, cyl(0.004, 0.004, 0.14, 4), CARBON, 0, [0.08, 0.15, 0.15]); // антенна
  part(H, cyl(0.004, 0.004, 0.1, 4), CARBON, 0, [-0.08, 0.13, 0.17]);
  for (const [mx, my, mz] of MOTORS.heavy) {
    const len = Math.hypot(mx, mz);
    const yaw = Math.atan2(mx, mz);
    part(H, box(0.062, 0.046, len), GUNMETAL, 0, [mx / 2, 0.02, mz / 2], [0, yaw, 0]);
    part(H, cyl(0.05, 0.056, 0.07, 10), METAL, 0, [mx, my - 0.04, mz]);
    part(H, cyl(0.016, 0.016, 0.03, 6), SILVER, 0, [mx, my + 0.005, mz]);
    // кольцо-обтекатель и две распорки
    part(H, new THREE.TorusGeometry(0.178, 0.016, 4, 20), 0xffffff, mz < 0 ? 1 : 2, [mx, my, mz], [Math.PI / 2, 0, 0], [1, 1, 2.2]);
    part(H, box(0.36, 0.012, 0.014), CARBON, 0, [mx, my - 0.01, mz], [0, Math.PI / 4, 0]);
    part(H, box(0.36, 0.012, 0.014), CARBON, 0, [mx, my - 0.01, mz], [0, -Math.PI / 4, 0]);
  }
  for (const sx of [-1, 1]) {
    // ракетный подвес
    part(H, cyl(0.036, 0.036, 0.2, 8), GUNMETAL, 0, [sx * 0.17, -0.07, -0.02], [Math.PI / 2, 0, 0]);
    part(H, cyl(0.03, 0.036, 0.03, 8), 0xffffff, 1, [sx * 0.17, -0.07, -0.135], [Math.PI / 2, 0, 0]);
    part(H, box(0.02, 0.05, 0.05), CARBON, 0, [sx * 0.15, -0.04, -0.02]);
    // шасси
    for (const sz of [-1, 1]) part(H, box(0.02, 0.1, 0.02), CARBON, 0, [sx * 0.1, -0.09, sz * 0.13], [0, 0, sx * 0.25]);
    part(H, box(0.024, 0.022, 0.42), CARBON, 0, [sx * 0.115, -0.14, 0]);
  }
  part(H, box(0.06, 0.06, 0.06), CARBON, 0, [0, -0.07, -0.12]); // крепление подвеса
  const heavy = merge(H);

  // ---- пулемёт на шаре-подвесе: шарнир в начале координат, ствол по −Z
  const G = [];
  part(G, sph(0.036, 10, 8), GUNMETAL, 0, [0, 0, 0]);
  part(G, box(0.034, 0.04, 0.12), CARBON, 0, [0, 0, -0.045]);
  part(G, box(0.03, 0.03, 0.055), 0xffffff, 2, [0.034, -0.006, -0.025]); // короб с лентой
  part(G, cyl(0.009, 0.009, 0.15, 6), CARBON, 0, [0, 0.004, -0.17], [Math.PI / 2, 0, 0]);
  part(G, cyl(0.015, 0.015, 0.03, 6), GUNMETAL, 0, [0, 0.004, -0.245], [Math.PI / 2, 0, 0]); // дульный тормоз
  part(G, cyl(0.004, 0.004, 0.09, 4), CARBON, 0, [0, 0.026, -0.1], [Math.PI / 2, 0, 0]); // газовая трубка
  const gun = merge(G);

  // ---- диск винта (размытые лопасти): круг радиуса 1 в плоскости XZ
  const rotor = new THREE.CircleGeometry(1, 20);
  rotor.rotateX(-Math.PI / 2);
  // ---- плашка (огни, огонь, дым): квадрат 1×1 лицом к +Z (поворачивается к камере)
  const puff = new THREE.PlaneGeometry(1, 1);
  return { light, heavy, gun, rotor, puff };
}

export function buildDroneGeometries(THREE) {
  const shared = (globalThis.__sceneState ??= {});
  const key = `${VERSION}|${build.toString().length}`;
  if (shared.droneGeoCache?.key !== key) shared.droneGeoCache = { key, geo: build(THREE) };
  const g = shared.droneGeoCache.geo;
  return { light: g.light.clone(), heavy: g.heavy.clone(), gun: g.gun.clone(), rotor: g.rotor.clone(), puff: g.puff.clone() };
}

// текстуры: диск винта (размытые лопасти, кольцо на концах), свечение огня, клуб дыма/пламени
function makeTextures(THREE) {
  const canvas = (size, draw) => {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    draw(c.getContext('2d'), size);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    return t;
  };
  const rotor = canvas(128, (g, s) => {
    const h = s / 2;
    // два размытых сектора лопастей (конический градиент) — диск не одинаково прозрачный
    const con = g.createConicGradient(0, h, h);
    for (let k = 0; k <= 16; k += 1) {
      const a = k / 16;
      const blade = Math.max(0, Math.cos(a * Math.PI * 4)) ** 3; // два мягких максимума — две лопасти
      con.addColorStop(a, `rgba(200,205,210,${(0.1 + 0.22 * blade).toFixed(3)})`);
    }
    g.fillStyle = con;
    g.beginPath();
    g.arc(h, h, h * 0.98, 0, Math.PI * 2);
    g.arc(h, h, h * 0.12, 0, Math.PI * 2, true);
    g.fill();
    // светлое кольцо на концах лопастей
    g.strokeStyle = 'rgba(230,232,236,0.45)';
    g.lineWidth = s * 0.035;
    g.beginPath();
    g.arc(h, h, h * 0.92, 0, Math.PI * 2);
    g.stroke();
  });
  const glow = canvas(64, (g, s) => {
    const h = s / 2;
    const r = g.createRadialGradient(h, h, 0, h, h, h);
    r.addColorStop(0, 'rgba(255,255,255,1)');
    r.addColorStop(0.18, 'rgba(255,255,255,0.85)');
    r.addColorStop(0.45, 'rgba(255,255,255,0.18)');
    r.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = r;
    g.fillRect(0, 0, s, s);
  });
  const puff = canvas(128, (g, s) => {
    // клуб: несколько мягких пятен (своё зерно — одинаково каждый раз)
    let seed = 11;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let k = 0; k < 9; k += 1) {
      const x = s * (0.3 + 0.4 * rnd());
      const y = s * (0.3 + 0.4 * rnd());
      const rr = s * (0.16 + 0.16 * rnd());
      const r = g.createRadialGradient(x, y, 0, x, y, rr);
      r.addColorStop(0, 'rgba(255,255,255,0.55)');
      r.addColorStop(0.6, 'rgba(255,255,255,0.22)');
      r.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = r;
      g.fillRect(0, 0, s, s);
    }
  });
  return { rotor, glow, puff };
}

export function droneTextures(THREE) {
  const shared = (globalThis.__sceneState ??= {});
  const key = `drone-tex-1|${makeTextures.toString().length}`;
  if (shared.droneTexCache?.key !== key) shared.droneTexCache = { key, tex: makeTextures(THREE) };
  return shared.droneTexCache.tex;
}
