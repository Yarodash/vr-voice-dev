// Расстояние между глазами (IPD): своё значение вместо того, что даёт шлем.
//
// Как это работает. В WebXR положения глаз приходят от шлема (XRView каждого глаза); three.js в
// renderer.render сначала вызывает xr.updateCamera — ставит камеры глаз (ArrayCamera.cameras[0/1])
// по этим положениям, — а сразу после этого scene.onBeforeRender, и только потом считает видимость
// и рисует. В этом обработчике камеры глаз раздвигаются (или сдвигаются) вдоль линии между ними,
// поровну в обе стороны, на разницу между выбранным и «родным» расстоянием; matrixWorldInverse
// пересчитывается. В следующем кадре шлем снова отдаёт свои положения, так что сдвиг не копится.
// «Родное» расстояние — между камерами глаз до сдвига (shared.ipdNativeMm).
//
// Выбранное значение (мм) хранится в localStorage 'scene.ipdMm' и в __sceneState.ipdMm; пусто —
// без сдвига (как в шлеме).
//
// Панель: «Настройки ▸ Расстояние между глазами» открывает её в полуметре перед глазами. Стик
// влево/вправо — меньше/больше на 0,5 мм (зажатый — с повтором), Z (нажатие стика) — как в шлеме,
// курок или хват — готово. Пока панель открыта (и пока не отпущены курок/хват, которым её закрыли),
// busy() — true: сцена не стреляет, не берёт и не отпускает предметы.
const KEY = 'scene.ipdMm';
const MIN_MM = 50;
const MAX_MM = 80;
const STEP_MM = 0.5;
const REPEAT_DELAY_MS = 400; // зажатый стик: первый повтор через столько
const REPEAT_EVERY_MS = 80; // и дальше каждые столько (≈6 мм/с)
const STICK_ON = 0.5;
const STICK_OFF = 0.3;
const TRIGGER = 0;
const GRIP = 1;
const STICK_CLICK = 3; // Z

const W = 1024;
const H = 576;
const PANEL_W_M = 0.36;
const DISTANCE_M = 0.5;

const fmt = (mm) => mm.toFixed(1).replace('.', ',');

export function createIpd({ THREE, renderer, scene, camera, root, shared }) {
  // ---- сохранённое значение
  shared.ipdMm = null;
  try {
    const saved = Number.parseFloat(localStorage.getItem(KEY));
    if (Number.isFinite(saved) && saved >= MIN_MM && saved <= MAX_MM) shared.ipdMm = saved;
  } catch {
    // без хранилища: как в шлеме
  }
  const save = () => {
    try {
      if (shared.ipdMm == null) localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, String(shared.ipdMm));
    } catch {
      // без хранилища значение не переживёт перезагрузку
    }
  };

  // ---- сдвиг глаз: сразу после xr.updateCamera, до отрисовки
  const left = new THREE.Vector3();
  const right = new THREE.Vector3();
  const across = new THREE.Vector3();
  const prevBefore = scene.onBeforeRender;
  const hook = function onBeforeRender(r, s, cam, ...rest) {
    prevBefore?.call(this, r, s, cam, ...rest);
    // (каждый renderer.render в XR заново ставит глаза по шлему в xr.updateCamera, так что сдвиг
    // не накапливается, сколько бы раз за кадр ни рисовали)
    if (!cam?.isArrayCamera || cam.cameras.length !== 2 || !renderer.xr.isPresenting) return;
    const [camL, camR] = cam.cameras;
    left.setFromMatrixPosition(camL.matrixWorld);
    right.setFromMatrixPosition(camR.matrixWorld);
    const native = left.distanceTo(right);
    if (native < 1e-4) return;
    shared.ipdNativeMm = native * 1000;
    if (shared.ipdMm == null) return;
    const half = (shared.ipdMm / 1000 - native) / 2;
    if (Math.abs(half) < 1e-7) return;
    across.subVectors(right, left).divideScalar(native); // от левого глаза к правому
    const shift = (eye, k) => {
      const e = eye.matrixWorld.elements;
      e[12] += across.x * k;
      e[13] += across.y * k;
      e[14] += across.z * k;
      eye.matrixWorldInverse.copy(eye.matrixWorld).invert();
    };
    shift(camL, -half);
    shift(camR, half);
  };
  scene.onBeforeRender = hook;

  // ---- панель
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const g = canvas.getContext('2d');
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(PANEL_W_M, (PANEL_W_M * H) / W),
    new THREE.MeshBasicMaterial({ map: texture, transparent: true, toneMapped: false, depthTest: false }),
  );
  mesh.renderOrder = 950;
  mesh.visible = false;
  mesh.name = 'scene-ipd-panel';
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
  let painted = '';
  const paint = () => {
    const native = shared.ipdNativeMm;
    const value = shared.ipdMm ?? native;
    const key = `${value?.toFixed(1)}|${native?.toFixed(1)}|${shared.ipdMm == null}`;
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
    g.font = '600 56px system-ui, "Noto Sans", sans-serif';
    g.fillText('Расстояние между глазами', W / 2, 82);
    g.fillStyle = '#ffffff';
    g.font = '700 160px system-ui, "Noto Sans", sans-serif';
    g.fillText(value == null ? '—' : `${fmt(value)} мм`, W / 2, 245);
    g.font = '500 46px system-ui, "Noto Sans", sans-serif';
    g.fillStyle = shared.ipdMm == null ? '#86efac' : '#93c5fd';
    const diff = shared.ipdMm != null && native != null ? shared.ipdMm - native : 0;
    const sign = diff > 0 ? '+' : diff < 0 ? '−' : '±';
    g.fillText(
      native == null ? 'в шлеме: —' : shared.ipdMm == null ? `как в шлеме (${fmt(native)} мм)` : `в шлеме: ${fmt(native)} мм (${sign}${fmt(Math.abs(diff))})`,
      W / 2,
      390,
    );
    g.fillStyle = '#94a3b8';
    g.font = '500 40px system-ui, "Noto Sans", sans-serif';
    g.fillText('стик ← → — изменить,  Z — как в шлеме', W / 2, 468);
    g.fillText('курок — готово', W / 2, 520);
    texture.needsUpdate = true;
  };

  const head = new THREE.Vector3();
  const forward = new THREE.Vector3();
  let open = false;
  let releaseFirst = false; // курок/хват, нажатые при открытии или закрытии, сначала отпустить
  let wasTrigger = true;
  let wasGrip = true;
  let wasClick = true;
  let stickDir = 0;
  let nextRepeatAt = 0;

  const step = (dir, source) => {
    const base = shared.ipdMm ?? shared.ipdNativeMm ?? 63;
    const next = Math.round((base + dir * STEP_MM) / STEP_MM) * STEP_MM;
    const clamped = Math.min(MAX_MM, Math.max(MIN_MM, next));
    if (clamped === shared.ipdMm) return;
    shared.ipdMm = clamped;
    save();
    source?.gamepad?.hapticActuators?.[0]?.pulse?.(0.15, 15);
  };

  return {
    open() {
      camera.getWorldPosition(head);
      camera.getWorldDirection(forward);
      forward.y = 0;
      if (forward.lengthSq() < 1e-6) forward.set(0, 0, -1);
      forward.normalize();
      mesh.position.copy(head).addScaledVector(forward, DISTANCE_M);
      mesh.rotation.set(0, Math.atan2(-forward.x, -forward.z), 0);
      painted = '';
      paint();
      mesh.visible = true;
      open = true;
      releaseFirst = true; // курок, которым выбрали пункт меню, ещё зажат
      stickDir = 0;
    },
    close() {
      open = false;
      mesh.visible = false;
    },
    get isOpen() {
      return open;
    },
    // панель открыта или ещё не отпущена кнопка, которой её закрыли
    busy() {
      return open || releaseFirst;
    },
    update(source, menuOpen) {
      const buttons = source?.gamepad?.buttons ?? [];
      const trigger = Boolean(buttons[TRIGGER]?.pressed);
      const grip = Boolean(buttons[GRIP]?.pressed);
      const click = Boolean(buttons[STICK_CLICK]?.pressed);
      if (releaseFirst && !trigger && !grip) releaseFirst = false;
      if (open) {
        if (!menuOpen && !releaseFirst && ((trigger && !wasTrigger) || (grip && !wasGrip))) {
          open = false;
          mesh.visible = false;
          releaseFirst = true;
        } else if (!menuOpen) {
          if (click && !wasClick && shared.ipdMm != null) {
            shared.ipdMm = null; // как в шлеме
            save();
            source?.gamepad?.hapticActuators?.[0]?.pulse?.(0.3, 40);
          }
          const x = source?.gamepad?.axes?.[2] ?? 0;
          const now = performance.now();
          const dir = x > STICK_ON ? 1 : x < -STICK_ON ? -1 : Math.abs(x) < STICK_OFF ? 0 : stickDir;
          if (dir !== stickDir) {
            stickDir = dir;
            if (dir) {
              step(dir, source);
              nextRepeatAt = now + REPEAT_DELAY_MS;
            }
          } else if (dir && now >= nextRepeatAt) {
            step(dir, source);
            nextRepeatAt = now + REPEAT_EVERY_MS;
          }
        } else {
          stickDir = 0;
        }
        paint();
      }
      wasTrigger = trigger;
      wasGrip = grip;
      wasClick = click;
    },
    dispose() {
      if (scene.onBeforeRender === hook) scene.onBeforeRender = prevBefore;
      root.remove(mesh);
      mesh.geometry.dispose();
      mesh.material.dispose();
      texture.dispose();
    },
  };
}
