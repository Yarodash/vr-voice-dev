// Отладка прицела АВП: панель в мире со всеми текстурами прицела (scope-lens.js: по одной на глаз) —
// каждая на своём квадрате, под ней подпись: имя, размер, кадр последней отрисовки (и рисовалась ли
// в этом кадре), угол обзора и смещение виртуальной камеры, где был глаз. Включается пунктом меню
// оружия «Отладка прицела» (shared.scopeDebug + localStorage). Появляется в 1,2 м перед головой,
// чуть ниже глаз, и стоит в мире. Берётся «Относительно схватить» (relative-grab.js) хватом, когда
// рука рядом (белая обводка); положение переживает подмену сцены и перезагрузку. Живёт в сцене.
import { createRelativeGrab } from './relative-grab.js';

const W = 0.3; // сторона квадрата текстуры, м
const GAP = 0.03;
const LABEL_H = 0.11;
const PANEL_W = 2 * W + 3 * GAP;
const PANEL_H = W + LABEL_H + 3 * GAP + 0.05;
const PANEL_Y = -LABEL_H / 2 + 0.01; // центр подложки относительно центра панели
const GRAB_REACH_M = 0.12;
const REFRESH_MS = 250;
const ON_KEY = 'scene.scopeDebug';
const POSE_KEY = 'scene.scopeDebug.pose';

export function createScopeDebug({ THREE, root, camera, shared, getLens }) {
  // вкл/выкл и положение: из прошлой версии сцены или после перезагрузки — из localStorage
  try {
    if (shared.scopeDebug === undefined) shared.scopeDebug = localStorage.getItem(ON_KEY) === 'on';
    if (!shared.scopeDebugPose) shared.scopeDebugPose = JSON.parse(localStorage.getItem(POSE_KEY)) ?? null;
  } catch {
    // без хранилища: выключена, встанет перед головой
  }
  const group = new THREE.Group();
  group.name = 'scope-debug';
  group.visible = false;
  root.add(group);
  (shared.scopeHide ??= new Set()).add(group); // камеры прицела её не рисуют (текстура в саму себя)
  const disposables = [];
  const back = new THREE.Mesh(new THREE.PlaneGeometry(PANEL_W, PANEL_H), new THREE.MeshBasicMaterial({ color: 0x101216, transparent: true, opacity: 0.88 }));
  back.position.set(0, PANEL_Y, -0.002);
  // белая обводка «можно взять» (как у оружия): рамка чуть больше подложки, за ней
  const outline = new THREE.Mesh(new THREE.PlaneGeometry(PANEL_W + 0.012, PANEL_H + 0.012), new THREE.MeshBasicMaterial({ color: 0xffffff }));
  outline.position.set(0, PANEL_Y, -0.004);
  outline.visible = false;
  group.add(back, outline);
  disposables.push(back.geometry, back.material, outline.geometry, outline.material);

  const makeLabel = (w, h, px = 512) => {
    const canvas = document.createElement('canvas');
    canvas.width = px;
    canvas.height = Math.round((px * h) / w);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: texture, transparent: true }));
    disposables.push(mesh.geometry, mesh.material, texture);
    return { mesh, canvas, texture, g: canvas.getContext('2d') };
  };
  const title = makeLabel(2 * W + GAP, 0.04, 1024);
  title.mesh.position.set(0, W / 2 + GAP + 0.01, 0);
  group.add(title.mesh);
  const slots = [0, 1].map((i) => {
    const x = (i === 0 ? -1 : 1) * (W / 2 + GAP / 2);
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(W, W), new THREE.MeshBasicMaterial({ color: 0x333333, toneMapped: false }));
    quad.position.set(x, 0, 0);
    const label = makeLabel(W, LABEL_H);
    label.mesh.position.set(x, -W / 2 - GAP / 2 - LABEL_H / 2, 0);
    group.add(quad, label.mesh);
    disposables.push(quad.geometry, quad.material);
    return { quad, label };
  });

  const write = ({ canvas, g, texture }, lines, color = '#e8eef5') => {
    g.clearRect(0, 0, canvas.width, canvas.height);
    const size = Math.floor((canvas.height / Math.max(lines.length, 1)) * 0.72);
    g.font = `${size}px monospace`;
    g.fillStyle = color;
    g.textBaseline = 'top';
    lines.forEach((line, i) => g.fillText(line, 8, 4 + i * size * 1.3));
    texture.needsUpdate = true;
  };

  // ---- положение
  let lastStore = 0;
  const savePose = (force = false) => {
    shared.scopeDebugPose = { p: group.position.toArray(), q: group.quaternion.toArray() };
    const now = performance.now();
    if (!force && now - lastStore < 500) return;
    lastStore = now;
    try {
      localStorage.setItem(POSE_KEY, JSON.stringify(shared.scopeDebugPose));
    } catch {
      // без хранилища не переживёт перезагрузку
    }
  };
  const head = new THREE.Vector3();
  const forward = new THREE.Vector3();
  const place = () => {
    camera.getWorldPosition(head);
    camera.getWorldDirection(forward);
    forward.y = 0;
    if (forward.lengthSq() < 1e-6) forward.set(0, 0, -1);
    forward.normalize();
    group.position.copy(head).addScaledVector(forward, 1.2);
    group.position.y = head.y - 0.18;
    group.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(-forward.x, -forward.z)); // лицом к игроку
    savePose(true);
  };
  let wasOn = Boolean(shared.scopeDebug && shared.scopeDebugPose);
  if (wasOn) {
    group.position.fromArray(shared.scopeDebugPose.p);
    group.quaternion.fromArray(shared.scopeDebugPose.q);
    group.visible = true;
  }

  // ---- хват
  const grab = createRelativeGrab({ THREE, object: group });
  const local = new THREE.Vector3();
  const buzz = (source, strength, ms) => source?.gamepad?.hapticActuators?.[0]?.pulse?.(strength, ms);
  const distanceTo = (point) => {
    group.updateWorldMatrix(true, false);
    group.worldToLocal(local.copy(point));
    const dx = Math.max(Math.abs(local.x) - PANEL_W / 2, 0);
    const dy = Math.max(Math.abs(local.y - PANEL_Y) - PANEL_H / 2, 0);
    return Math.hypot(dx, dy, local.z);
  };
  let near = false;
  let flashUntil = 0;

  let lastLens = null;
  let lastFrame = -1;
  let refreshAt = 0;
  const refresh = () => {
    const lens = getLens();
    if (lens !== lastLens) {
      lastLens = lens;
      slots.forEach((slot, i) => {
        const tex = lens?.targets?.[i]?.texture ?? null;
        slot.quad.material.map = tex;
        slot.quad.material.color.set(tex ? 0xffffff : 0x333333);
        slot.quad.material.needsUpdate = true;
      });
    }
    const now = performance.now();
    if (now < refreshAt) return;
    refreshAt = now + REFRESH_MS;
    if (!lens) {
      write(title, ['Отладка прицела: нет АВП с прицелом']);
      slots.forEach((s) => write(s.label, ['—']));
      return;
    }
    const d = lens.debug();
    const framesPerRefresh = d.frame - lastFrame;
    lastFrame = d.frame;
    write(title, [`Прицел ×${d.mag.toFixed(1)}  поле tan ${d.tanA.toFixed(3)}  live ${d.live.toFixed(2)}`, `глаз ${Number.isFinite(d.dist) ? d.dist.toFixed(2) + ' м' : '—'}  кадр ${d.frame} (+${framesPerRefresh} за 0,25 с)`]);
    d.views.forEach((v, i) => {
      const fresh = v.frame === d.frame && d.live > 0;
      write(slots[i].label, [
        `${v.name}: ${d.size}×${d.size} MSAA ${d.samples}`,
        `кадр ${v.frame}${fresh ? ' — сейчас' : ''}  ${v.ms.toFixed(2)} мс`,
        `fov ${v.fovDeg.toFixed(3)}°  смещ ${v.offsetDeg[0].toFixed(2)}°, ${v.offsetDeg[1].toFixed(2)}°`,
        `глаз ${v.eye.x.toFixed(3)} ${v.eye.y.toFixed(3)} ${v.eye.z.toFixed(3)} м`,
      ], fresh ? '#9cffb0' : '#e8eef5');
    });
  };

  const api = {
    group,
    get held() {
      return grab.held;
    },
    // Расстояние руки до панели (Infinity — выключена или руки нет): main.js сравнивает с ближайшим
    // оружием/тарелкой — берётся ближайшее.
    distance(handPosition) {
      return group.visible && handPosition ? distanceTo(handPosition) : Infinity;
    },
    // Каждый кадр из main.js (секция хвата). nearest — панель ближе всего остального в досягаемости
    // (и рука пуста); остальное — как у других предметов.
    update({ hand, gripWorld, gripDown, gripWasDown, gripMode, menuIsOpen, nearest = false, source } = {}) {
      const on = Boolean(shared.scopeDebug);
      if (on !== wasOn) {
        try {
          localStorage.setItem(ON_KEY, on ? 'on' : 'off');
        } catch {
          // без хранилища
        }
      }
      if (on && !wasOn) place();
      wasOn = on;
      group.visible = on;
      if (!on) {
        if (grab.held) grab.release();
        near = false;
        outline.visible = false;
        return;
      }
      const pressed = gripDown && !gripWasDown;
      if (grab.held) {
        const letGo = gripMode === 'hold' ? !gripDown && !menuIsOpen : pressed && !menuIsOpen;
        if (letGo || !hand) {
          grab.release();
          savePose(true);
          buzz(source, 0.2, 90);
          flashUntil = performance.now() + 250;
        } else {
          grab.update(gripWorld);
          savePose();
        }
        near = false;
      } else {
        near = Boolean(hand) && nearest;
        if (near && pressed && !menuIsOpen) {
          grab.grab(gripWorld);
          buzz(source, 0.4, 40);
        }
      }
      outline.visible = near || performance.now() < flashUntil;
      refresh();
    },
    dispose() {
      if (grab.held) grab.release();
      if (group.visible) savePose(true);
      shared.scopeHide?.delete(group);
      root.remove(group);
      for (const s of slots) s.quad.material.map = null;
      disposables.forEach((x) => x.dispose());
    },
  };
  return api;
}

export { GRAB_REACH_M as SCOPE_DEBUG_REACH_M };
