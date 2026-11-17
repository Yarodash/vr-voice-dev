// Размер оружия — часть «Перенастроить оси»: пока оружие замерло для перенастройки, стик
// влево/вправо плавно уменьшает/увеличивает его; второй хват, который приклеивает посадку, заодно
// фиксирует размер. Масштаб — вокруг рукоятки (HANDLE: ладонь/посадка остаётся на месте), всё, что
// считается от группы оружия (дуло, вспышка, дым, лазер, спуск, обводка, стёкла прицела), идёт следом
// само. Свой у каждого вида оружия (у сгенерированных — 'gen:<id>'), localStorage 'scene.scale.<kind>',
// переживает подмену сцены (shared.gunScales) и перезагрузку.
//
// start(item) — вошли в перенастройку; стик сначала надо отпустить в центр (им только что выбирали
// сектор). stop() — второй хват (записывает размер) или оружие перестало быть «замершим».
const KEY = (kind) => `scene.scale.${kind}`;
const MIN = 0.3;
const MAX = 3;
const RATE = 1.6; // ×1,6 в секунду при полном отклонении
const DEAD = 0.2;
const FADE_OPACITY = 0.8; // замершее при перенастройке оружие видно на 80 %

const scales = () => ((globalThis.__sceneState ??= {}).gunScales ??= {});

// масштаб вида оружия (1 — как есть); читается из localStorage один раз на вид
export function gunScaleOf(kind) {
  const cache = scales();
  if (typeof cache[kind] !== 'number') {
    let s = 1;
    try {
      const saved = Number.parseFloat(localStorage.getItem(KEY(kind)));
      if (Number.isFinite(saved)) s = Math.min(MAX, Math.max(MIN, saved));
    } catch {
      // без хранилища — 1
    }
    cache[kind] = s;
  }
  return cache[kind];
}

// «Настройки ▸ Сбросить размеры оружия»: все виды снова 1, ключи scene.scale.* стёрты
export function resetGunScales(items = []) {
  const cache = scales();
  for (const kind of Object.keys(cache)) cache[kind] = 1;
  try {
    for (let i = localStorage.length - 1; i >= 0; i -= 1) {
      const key = localStorage.key(i);
      if (key?.startsWith('scene.scale.')) localStorage.removeItem(key);
    }
  } catch {
    // без хранилища — только в этой сессии
  }
  for (const item of items) item.group.scale.setScalar(1);
}

export function createGunResize({ THREE, root, handle }) {
  let item = null; // замершее оружие, которое сейчас меняют
  let armed = false; // стик вернулся в центр после выбора пункта
  let dirty = false; // масштаб менялся — записать при выходе
  let shown = '';
  const base = new THREE.Matrix4(); // поза замершего оружия без размера

  // подпись над рукояткой: «Размер ×1,25» (канва перерисовывается только при смене числа)
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 160;
  const g = canvas.getContext('2d');
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: false, depthWrite: false, transparent: true }));
  label.scale.set(0.16, 0.05, 1);
  label.renderOrder = 20;
  label.visible = false;
  root.add(label);
  const draw = (text) => {
    if (text === shown) return;
    shown = text;
    g.clearRect(0, 0, canvas.width, canvas.height);
    g.fillStyle = 'rgba(15, 18, 24, 0.82)';
    g.beginPath();
    g.roundRect(4, 4, canvas.width - 8, canvas.height - 8, 28);
    g.fill();
    g.textAlign = 'center';
    g.fillStyle = '#ffffff';
    g.font = 'bold 64px sans-serif';
    g.fillText(text, canvas.width / 2, 78);
    g.fillStyle = '#9ca3af';
    g.font = '34px sans-serif';
    g.fillText('▲ стик ▼ размер   хват — готово', canvas.width / 2, 132);
    texture.needsUpdate = true;
  };

  const pivot = new THREE.Matrix4();
  const scaleM = new THREE.Matrix4();
  const back = new THREE.Matrix4();
  const pose = new THREE.Matrix4();
  const at = new THREE.Vector3();

  // matrix × размер вида s вокруг рукоятки (inverse — снять его)
  const applyScale = (matrix, s, inverse = false) => {
    if (s === 1) return matrix;
    if (inverse) s = 1 / s;
    pivot.makeTranslation(handle.x, handle.y, handle.z);
    back.makeTranslation(-handle.x, -handle.y, -handle.z);
    return matrix.multiply(pivot).multiply(scaleM.makeScale(s, s, s)).multiply(back);
  };

  // замершее оружие полупрозрачное (FADE_OPACITY): сквозь него виден джойстик. Каждому мешу — своя
  // копия материала на время режима (материалы общие у копий из кэша — их не трогаем), на выходе —
  // прежние, копии освобождаются. Обводка (BackSide) и стёкла прицела (ShaderMaterial) — как были.
  const faded = new Map(); // mesh → прежний material (или массив)
  const fadeOf = (m) => {
    if (!m || m.side === THREE.BackSide || m.isShaderMaterial) return m;
    const c = m.clone();
    c.transparent = true;
    c.opacity = (m.opacity ?? 1) * FADE_OPACITY;
    c.depthWrite = true; // своя глубина: дальние детали оружия не просвечивают сквозь ближние
    return c;
  };
  const fade = (target) => {
    target.group.traverse((o) => {
      if (!o.isMesh || faded.has(o)) return;
      const was = o.material;
      const now = Array.isArray(was) ? was.map(fadeOf) : fadeOf(was);
      if (now === was || (Array.isArray(was) && now.every((m, i) => m === was[i]))) return;
      faded.set(o, was);
      o.material = now;
    });
  };
  const unfade = () => {
    for (const [mesh, was] of faded) {
      const now = mesh.material;
      const list = Array.isArray(now) ? now : [now];
      const old = Array.isArray(was) ? was : [was];
      for (const m of list) if (!old.includes(m)) m.dispose();
      mesh.material = was;
    }
    faded.clear();
  };

  const stop = () => {
    unfade();
    if (item && dirty) {
      try {
        localStorage.setItem(KEY(item.kind), String(gunScaleOf(item.kind)));
      } catch {
        // не переживёт перезагрузку
      }
    }
    dirty = false;
    item = null;
    label.visible = false;
  };

  return {
    get active() {
      return Boolean(item);
    },
    start(target) {
      if (!target) return;
      item = target;
      armed = false;
      dirty = false;
      shown = '';
      item.group.updateMatrix();
      applyScale(base.copy(item.group.matrix), gunScaleOf(item.kind), true);
      unfade();
      fade(item);
    },
    stop,
    // matrix (поза группы оружия без размера) × размер вида вокруг рукоятки; inverse — снять его
    apply(matrix, kind, inverse = false) {
      return applyScale(matrix, gunScaleOf(kind), inverse);
    },
    // каждый кадр (main.js): recalibrating — замершее оружие (или null), items — все (лежащие того же
    // вида меняются вместе), menuOpen — стик занят колесом/панелью
    update({ recalibrating, items, source, menuOpen, dt }) {
      if (!item) return;
      if (item !== recalibrating) {
        stop();
        return;
      }
      const x = menuOpen ? 0 : -(source?.gamepad?.axes?.[3] ?? 0); // стик вверх — больше, вниз — меньше (ось 3: вверх < 0)
      if (!armed && Math.abs(x) < DEAD) armed = true;
      if (armed && Math.abs(x) >= DEAD) {
        const k = Math.sign(x) * ((Math.abs(x) - DEAD) / (1 - DEAD));
        const s = Math.min(MAX, Math.max(MIN, gunScaleOf(item.kind) * RATE ** (k * Math.min(dt, 0.1))));
        const cache = scales();
        if (s !== cache[item.kind]) {
          cache[item.kind] = s;
          dirty = true;
          for (const other of items) if (other !== item && other.kind === item.kind) other.group.scale.setScalar(s);
          applyScale(pose.copy(base), s).decompose(item.group.position, item.group.quaternion, item.group.scale);
        }
      }
      draw(`Размер ×${gunScaleOf(item.kind).toFixed(2).replace('.', ',')}`);
      item.group.updateWorldMatrix(true, false);
      at.copy(handle).applyMatrix4(item.group.matrixWorld);
      label.position.set(at.x, at.y + 0.17, at.z);
      label.visible = true;
    },
    dispose() {
      stop();
      root.remove(label);
      label.material.dispose();
      texture.dispose();
    },
  };
}
