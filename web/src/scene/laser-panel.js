// Панель выбора цвета лазерного прицела («Цвет прицела» в меню оружия). Висит в мире перед
// глазами; цвет выбирают выстрелом в плашку (луч ствола подсвечивает плашку под прицелом, курок —
// настоящий выстрел, выбирается то, во что попали), либо стиком (← → ↑ ↓). «Готово» (выстрелом
// в кнопку) или хват закрывают панель. Пока панель открыта (и пока не отпущены кнопки, которыми
// её открыли/закрыли), busy() — true: оружие не отпускается. Выбранный цвет — shared.laserColor
// (0xRRGGBB), хранится в localStorage 'scene.laserColor'.
const KEY = 'scene.laserColor';
export const LASER_COLORS = [
  // насыщенные и потемнее: луч и точка рисуются с прибавлением света, светлые цвета выходили бледными
  { name: 'красный', hex: 0xc80000, was: 0xff2020 },
  { name: 'зелёный', hex: 0x00a020, was: 0x20ff40 },
  { name: 'синий', hex: 0x1030d0, was: 0x3060ff },
  { name: 'голубой', hex: 0x0090b0, was: 0x20ffff },
  { name: 'пурпурный', hex: 0xa000c0, was: 0xff30ff },
  { name: 'жёлтый', hex: 0xc0a800, was: 0xffee20 },
  { name: 'оранжевый', hex: 0xd05800, was: 0xff8800 },
  { name: 'белый', hex: 0xd0d0d0, was: 0xffffff },
];
const COLS = 4;
const DONE = LASER_COLORS.length; // индекс кнопки «Готово»
const STICK_ON = 0.6;
const STICK_OFF = 0.3;
const TRIGGER = 0;
const GRIP = 1;
const W = 1024;
const H = 576;
const PANEL_W_M = 0.8;
const PANEL_H_M = (PANEL_W_M * H) / W;
const DISTANCE_M = 1.2;
// плашки в пикселях холста
const SW_W = 200;
const SW_H = 150;
const SW_GAP = 24;
const SW_X0 = (W - COLS * SW_W - (COLS - 1) * SW_GAP) / 2;
const SW_Y0 = 120;
const DONE_RECT = { x: 362, y: 470, w: 300, h: 80 };

const rectOf = (i) => {
  if (i === DONE) return DONE_RECT;
  return { x: SW_X0 + (i % COLS) * (SW_W + SW_GAP), y: SW_Y0 + Math.floor(i / COLS) * (SW_H + SW_GAP), w: SW_W, h: SW_H };
};

export function createLaserPanel({ THREE, renderer, camera, root, shared }) {
  shared.laserColor = LASER_COLORS[0].hex;
  try {
    const saved = Number.parseInt(localStorage.getItem(KEY), 10);
    const old = LASER_COLORS.find((c) => c.was === saved); // сохранённый старый (светлый) цвет — его новый оттенок
    if (old) shared.laserColor = old.hex;
    else if (LASER_COLORS.some((c) => c.hex === saved)) shared.laserColor = saved;
  } catch {
    // без хранилища: красный
  }
  const indexOfColor = () => Math.max(0, LASER_COLORS.findIndex((c) => c.hex === shared.laserColor));

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const g = canvas.getContext('2d');
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(PANEL_W_M, PANEL_H_M),
    new THREE.MeshBasicMaterial({ map: texture, transparent: true, toneMapped: false, depthTest: true }), // с глубиной: пистолет перед панелью её закрывает
  );
  mesh.renderOrder = 940;
  mesh.visible = false;
  mesh.name = 'scene-laser-panel';
  root.add(mesh);

  const roundRect = (x, y, w, h, r) => {
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  };
  let hover = -1;
  let painted = '';
  const paint = () => {
    const sel = indexOfColor();
    const key = `${sel}|${hover}`;
    if (key === painted) return;
    painted = key;
    g.clearRect(0, 0, W, H);
    roundRect(8, 8, W - 16, H - 16, 40);
    g.fillStyle = 'rgba(15, 23, 42, 0.92)';
    g.fill();
    g.lineWidth = 6;
    g.strokeStyle = 'rgba(147, 197, 253, 0.6)';
    g.stroke();
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = '#cbd5e1';
    g.font = '600 52px system-ui, "Noto Sans", sans-serif';
    g.fillText('Цвет прицела: выстрели в плашку', W / 2, 62);
    LASER_COLORS.forEach((c, i) => {
      const r = rectOf(i);
      roundRect(r.x, r.y, r.w, r.h, 22);
      g.fillStyle = `#${c.hex.toString(16).padStart(6, '0')}`;
      g.fill();
      if (i === sel || i === hover) {
        g.lineWidth = i === sel ? 12 : 8;
        g.strokeStyle = i === sel ? '#ffffff' : 'rgba(255,255,255,0.65)';
        g.stroke();
      }
    });
    const d = rectOf(DONE);
    roundRect(d.x, d.y, d.w, d.h, 30);
    g.fillStyle = hover === DONE ? '#22c55e' : '#166534';
    g.fill();
    g.fillStyle = '#ffffff';
    g.font = '700 48px system-ui, "Noto Sans", sans-serif';
    g.fillText('Готово', d.x + d.w / 2, d.y + d.h / 2 + 2);
    texture.needsUpdate = true;
  };

  const head = new THREE.Vector3();
  const forward = new THREE.Vector3();
  const localOrigin = new THREE.Vector3();
  const localDir = new THREE.Vector3();
  const point = new THREE.Vector3();
  const inverse = new THREE.Matrix4();
  let open = false;
  let releaseFirst = false; // курок, которым выбрали пункт меню, ещё зажат — не стрелять
  let gripLock = false; // хват, которым закрыли панель, ещё зажат — не отпускать оружие
  let wasGrip = true;
  let stickX = 0;
  let stickY = 0;

  const select = (i, source) => {
    if (i < 0 || i >= LASER_COLORS.length || LASER_COLORS[i].hex === shared.laserColor) return;
    shared.laserColor = LASER_COLORS[i].hex;
    try {
      localStorage.setItem(KEY, String(shared.laserColor));
    } catch {
      // без хранилища цвет не переживёт перезапуск
    }
    source?.gamepad?.hapticActuators?.[0]?.pulse?.(0.15, 15);
  };

  const closePanel = () => {
    open = false;
    mesh.visible = false;
    hover = -1;
  };

  return {
    point, // куда луч попал на панели (после cast() с результатом ≥ 0)
    open() {
      camera.getWorldPosition(head);
      camera.getWorldDirection(forward);
      forward.y = 0;
      if (forward.lengthSq() < 1e-6) forward.set(0, 0, -1);
      forward.normalize();
      mesh.position.copy(head).addScaledVector(forward, DISTANCE_M);
      mesh.position.y = head.y - 0.05;
      mesh.rotation.set(0, Math.atan2(-forward.x, -forward.z), 0);
      mesh.updateMatrixWorld(true);
      painted = '';
      hover = -1;
      paint();
      mesh.visible = true;
      open = true;
      releaseFirst = true;
      gripLock = true;
      stickX = stickY = 0;
    },
    close: closePanel,
    get isOpen() {
      return open;
    },
    busy() {
      return open || gripLock;
    },
    blocksFire() {
      return releaseFirst;
    },
    // луч ствола против панели: подсвечивает плашку под прицелом; расстояние до панели или −1
    cast(origin, dir) {
      if (!open) return -1;
      inverse.copy(mesh.matrixWorld).invert();
      localOrigin.copy(origin).applyMatrix4(inverse);
      localDir.copy(dir).transformDirection(inverse);
      let found = -1;
      let distance = -1;
      if (Math.abs(localDir.z) > 1e-6) {
        const t = -localOrigin.z / localDir.z;
        if (t > 0) {
          const x = localOrigin.x + localDir.x * t;
          const y = localOrigin.y + localDir.y * t;
          const u = (x / PANEL_W_M + 0.5) * W;
          const v = (0.5 - y / PANEL_H_M) * H;
          if (u >= 0 && u <= W && v >= 0 && v <= H) {
            distance = t;
            point.copy(origin).addScaledVector(dir, t);
            for (let i = 0; i <= DONE; i++) {
              const r = rectOf(i);
              if (u >= r.x && u <= r.x + r.w && v >= r.y && v <= r.y + r.h) found = i;
            }
          }
        }
      }
      if (found !== hover) {
        hover = found;
        paint();
      }
      return distance;
    },
    // выстрел: выбрать плашку под прицелом (cast() вызван перед этим) или закрыть по «Готово»
    shoot(source) {
      if (!open || hover < 0) return;
      if (hover === DONE) {
        closePanel();
        gripLock = true;
      } else select(hover, source);
      paint();
    },
    update(source, menuOpen) {
      const buttons = source?.gamepad?.buttons ?? [];
      const trigger = Boolean(buttons[TRIGGER]?.pressed);
      const grip = Boolean(buttons[GRIP]?.pressed);
      if (releaseFirst && !trigger) releaseFirst = false;
      if (gripLock && !grip && !(open && menuOpen)) gripLock = false;
      if (open) {
        if (!menuOpen && !gripLock && grip && !wasGrip) {
          closePanel();
          gripLock = true;
        } else if (!menuOpen) {
          // стик: одно движение за толчок
          const x = source?.gamepad?.axes?.[2] ?? 0;
          const y = source?.gamepad?.axes?.[3] ?? 0;
          const dx = x > STICK_ON ? 1 : x < -STICK_ON ? -1 : Math.abs(x) < STICK_OFF ? 0 : stickX;
          const dy = y > STICK_ON ? 1 : y < -STICK_ON ? -1 : Math.abs(y) < STICK_OFF ? 0 : stickY;
          const cur = indexOfColor();
          if (dx !== stickX && dx) select(Math.min(LASER_COLORS.length - 1, Math.max(0, cur + dx)), source);
          if (dy !== stickY && dy) select(Math.min(LASER_COLORS.length - 1, Math.max(0, cur + dy * COLS)), source);
          stickX = dx;
          stickY = dy;
        } else {
          stickX = stickY = 0;
        }
        paint();
      }
      wasGrip = grip;
    },
    dispose() {
      root.remove(mesh);
      mesh.geometry.dispose();
      mesh.material.dispose();
      texture.dispose();
    },
  };
}
