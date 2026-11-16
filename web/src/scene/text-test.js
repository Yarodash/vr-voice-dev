// Тест чёткости текста: доска ~0,96×0,72 м с 12 пронумерованными ячейками. В каждой — один и тот же
// образец текста (мелкая строка, две строки размера окон сообщений, крупная строка), нарисованный
// по-разному (фильтрация текстуры, разрешение холста, шрифт, цвета, прозрачность). Пользователь
// выбирает номер самой чёткой.
//
// Масштаб честный: во всех ячейках физический размер текста один и тот же — как у окон сообщений
// (холст 1600 px на 0,55 м на расстоянии 0,8 м, т. е. 2909 px/м; доска появляется в 0,8 м).
// «2×» — тот же текст на холсте вдвое большего разрешения, ячейка того же размера.
//
// Доска берётся хватом — «Относительно схватить» (relative-grab.js): не прыгает в руку, а
// двигается вместе с ней с момента хвата. Режим хвата — как у оружия («Хват: нажать/держать»).
// Положение доски переживает подмену сцены (__sceneState.textTestPose).
// Ручка для npm run vr:eval: __sceneState.textTest.respawn() — поставить снова перед глазами.
import { roundRect } from '../canvas-text.js';
import { createRelativeGrab } from './relative-grab.js';

const PX_PER_M = 1600 / 0.55; // плотность окон сообщений
const CELL_W_M = 0.3;
const CELL_H_M = 0.15;
const GAP_M = 0.012;
const MARGIN_M = 0.02;
const TITLE_M = 0.04; // полоса с заголовком сверху
const COLS = 3;
const ROWS = 4;
const BOARD_W = COLS * CELL_W_M + (COLS - 1) * GAP_M + 2 * MARGIN_M;
const BOARD_H = ROWS * CELL_H_M + (ROWS - 1) * GAP_M + 2 * MARGIN_M + TITLE_M;
const SPAWN_M = 0.8;
const GRAB_REACH_M = 0.15; // от края (или изнутри) доски до контроллера, чтобы взять

// базовые размеры (px при плотности окон сообщений); холст ячейки 873×436
const BASE_W = Math.round(CELL_W_M * PX_PER_M);
const BASE_H = Math.round(CELL_H_M * PX_PER_M);
const FONT_FAMILY = 'system-ui, "Noto Sans", sans-serif';
const SAMPLE = {
  small: { size: 32, y: 112, text: 'Claude · ещё сообщений: 2 · 1Il0O' }, // как заголовок окна
  normal1: { size: 46, y: 180, text: 'Готово: пистолет сдвинут на 5 см.' }, // как текст окна
  normal2: { size: 46, y: 240, text: 'Scene check: OK — 120 Hz, жщы' },
  large: { size: 64, y: 330, text: 'Шрифт: ЖЩЫЮ 3,14' },
};

const BLUE_BG = 'rgba(23, 37, 63, 0.97)'; // как окна Claude
const NOMIP = 'linear'; // LinearFilter, без mipmaps
const MIP_NEAREST = 'mipNearest'; // LinearMipmapNearest (по умолчанию — LinearMipmapLinear)

// Варианты (номер = индекс + 1). Значения по умолчанию — как у окон сообщений (message-panel.js):
// mipmaps LinearMipmapLinear + aniso16, шрифт 500, светлый на тёмно-синем.
// Второй раунд: пользователь выбрал «2× холст, без mipmaps» (самый чёткий, но мерцает при движении
// головы) — №1 он же, остальные ищут ту же чёткость с меньшим мерцанием.
// sharpMips: своя цепочка mipmap (уменьшение drawImage 'high' + лёгкая нерезкая маска, сила = число);
// blur: текст заранее размыт на столько px холста (против мерцания без mipmaps).
const VARIANTS = [
  { label: 'эталон: 2×, без mipmaps', scale: 2, filter: NOMIP },
  { label: '2×, mip, bias −0,25', scale: 2, lodBias: -0.25 },
  { label: '2×, mip, bias −0,5', scale: 2, lodBias: -0.5 },
  { label: '2×, mip, bias −0,75', scale: 2, lodBias: -0.75 },
  { label: '2×, MipmapNearest', scale: 2, filter: MIP_NEAREST },
  { label: '2×, MipmapNearest, bias −0,5', scale: 2, filter: MIP_NEAREST, lodBias: -0.5 },
  { label: '3×, mip, bias −0,5', scale: 3, lodBias: -0.5 },
  { label: '2×, свои mip + резкость', scale: 2, sharpMips: 0.6 },
  { label: '2×, свои mip + резк., bias −0,25', scale: 2, sharpMips: 0.6, lodBias: -0.25 },
  { label: '2×, без mip, размытие 1 px', scale: 2, filter: NOMIP, blur: 1 },
  { label: '2×, шрифт 600, mip, bias −0,5', scale: 2, weight: 600, lodBias: -0.5 },
  { label: '2×, без mip, размытие 2 px', scale: 2, filter: NOMIP, blur: 2 },
];

// Нерезкая маска 3×3 (1-2-1) по RGB: p + amount·(p − размытое)
function unsharp(g, w, h, amount) {
  const image = g.getImageData(0, 0, w, h);
  const src = image.data;
  const copy = new Uint8ClampedArray(src);
  const at = (x, y, c) => copy[(Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))) * 4 + c];
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = (y * w + x) * 4;
      for (let c = 0; c < 3; c += 1) {
        const blur =
          (at(x - 1, y - 1, c) + 2 * at(x, y - 1, c) + at(x + 1, y - 1, c) +
            2 * at(x - 1, y, c) + 4 * copy[i + c] + 2 * at(x + 1, y, c) +
            at(x - 1, y + 1, c) + 2 * at(x, y + 1, c) + at(x + 1, y + 1, c)) / 16;
        src[i + c] = copy[i + c] + amount * (copy[i + c] - blur);
      }
    }
  }
  g.putImageData(image, 0, 0);
}

// Своя цепочка mipmap: каждый уровень — уменьшение предыдущего (несжатого) вдвое с качественным
// сглаживанием; в текстуру идёт его копия с нерезкой маской (на крупных уровнях).
function sharpMipChain(canvas, amount) {
  const levels = [canvas];
  let plain = canvas;
  while (plain.width > 1 || plain.height > 1) {
    const next = document.createElement('canvas');
    next.width = Math.max(1, plain.width >> 1);
    next.height = Math.max(1, plain.height >> 1);
    const g = next.getContext('2d');
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    g.drawImage(plain, 0, 0, next.width, next.height);
    let level = next;
    if (next.width >= 32 && next.height >= 16) {
      level = document.createElement('canvas');
      level.width = next.width;
      level.height = next.height;
      const lg = level.getContext('2d', { willReadFrequently: true });
      lg.drawImage(next, 0, 0);
      unsharp(lg, level.width, level.height, amount);
    }
    levels.push(level);
    plain = next;
  }
  return levels;
}

function drawCell(canvas, number, v) {
  const g = canvas.getContext('2d');
  const sx = canvas.width / BASE_W;
  const sy = canvas.height / BASE_H;
  const s = Math.min(sx, sy);
  const snap = Boolean(v.pot);
  const px = (value) => (snap ? Math.round(value) : value);
  const weight = v.weight ?? 500;
  const fg = v.fg ?? '#f1f5f9';
  const sub = v.sub ?? '#93c5fd';

  g.clearRect(0, 0, canvas.width, canvas.height);
  g.fillStyle = v.opaque ? 'rgb(23, 37, 63)' : (v.bg ?? BLUE_BG);
  roundRect(g, { x: 0, y: 0, w: canvas.width, h: canvas.height }, 28 * s);

  const text = (str, x, yMid, size, fontWeight, color, align = 'left') => {
    const sizePx = snap ? Math.round(size * s) : size * s;
    g.font = `${fontWeight} ${sizePx}px ${FONT_FAMILY}`;
    g.textAlign = align;
    let y = yMid * sy;
    if (snap) {
      g.textBaseline = 'alphabetic'; // базовая линия — на целом пикселе
      y = Math.round(y + sizePx * 0.36);
    } else {
      g.textBaseline = 'middle';
    }
    const xx = px(x * sx);
    if (v.stroke) {
      g.lineJoin = 'round';
      g.lineWidth = 3 * s;
      g.strokeStyle = 'rgba(0, 0, 0, 0.65)';
      g.strokeText(str, xx, y);
    }
    g.fillStyle = color;
    g.fillText(str, xx, y);
  };

  const PAD = 28;
  text(v.label, PAD, 44, 30, Math.max(weight, 600), sub);
  text(String(number), BASE_W - 22, 56, 96, 800, '#fde047', 'right');
  text(SAMPLE.small.text, PAD, SAMPLE.small.y, SAMPLE.small.size, Math.max(weight, 600), sub);
  text(SAMPLE.normal1.text, PAD, SAMPLE.normal1.y, SAMPLE.normal1.size, weight, fg);
  text(SAMPLE.normal2.text, PAD, SAMPLE.normal2.y, SAMPLE.normal2.size, weight, fg);
  text(SAMPLE.large.text, PAD, SAMPLE.large.y, SAMPLE.large.size, weight, fg);

  if (v.blur) {
    // заранее размытый текст (гаусс, сигма = v.blur px холста)
    const copy = document.createElement('canvas');
    copy.width = canvas.width;
    copy.height = canvas.height;
    copy.getContext('2d').drawImage(canvas, 0, 0);
    g.clearRect(0, 0, canvas.width, canvas.height);
    g.filter = `blur(${v.blur}px)`;
    g.drawImage(copy, 0, 0);
    g.filter = 'none';
  }
}

export function createTextTest({ THREE, root, camera, renderer, shared }) {
  const maxAniso = renderer.capabilities.getMaxAnisotropy();
  const board = new THREE.Group();
  board.name = 'text-test';
  const disposables = [];
  const keep = (thing) => {
    disposables.push(thing);
    return thing;
  };

  // подложка-рамка: тонкий брусок (видна и сзади); цвет показывает, можно ли взять / взята
  const FRAME_IDLE = 0x262b33;
  const FRAME_NEAR = 0x475569;
  const FRAME_HELD = 0x0e7490;
  const frameMaterial = keep(new THREE.MeshBasicMaterial({ color: FRAME_IDLE, toneMapped: false }));
  const frame = new THREE.Mesh(keep(new THREE.BoxGeometry(BOARD_W, BOARD_H, 0.01)), frameMaterial);
  frame.position.z = -0.006;
  board.add(frame);

  // заголовок
  {
    const canvas = document.createElement('canvas');
    canvas.width = 2048;
    canvas.height = Math.round((2048 * TITLE_M) / BOARD_W);
    const g = canvas.getContext('2d');
    g.fillStyle = '#cbd5e1';
    g.font = `600 ${Math.round(canvas.height * 0.55)}px ${FONT_FAMILY}`;
    g.textBaseline = 'middle';
    g.fillText('Тест чёткости текста: назови номер самой чёткой ячейки. Хват — взять.', 40, canvas.height / 2);
    const texture = keep(new THREE.CanvasTexture(canvas));
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = maxAniso;
    const title = new THREE.Mesh(
      keep(new THREE.PlaneGeometry(BOARD_W, TITLE_M)),
      keep(new THREE.MeshBasicMaterial({ map: texture, toneMapped: false, transparent: true })),
    );
    title.position.set(0, BOARD_H / 2 - MARGIN_M / 2 - TITLE_M / 2, 0);
    board.add(title);
  }

  const cellGeometry = keep(new THREE.PlaneGeometry(CELL_W_M, CELL_H_M));
  VARIANTS.forEach((v, index) => {
    const canvas = document.createElement('canvas');
    if (v.pot) {
      canvas.width = 1024;
      canvas.height = 512;
    } else {
      const scale = v.scale ?? 1;
      canvas.width = BASE_W * scale;
      canvas.height = BASE_H * scale;
    }
    drawCell(canvas, index + 1, v);
    const texture = keep(new THREE.CanvasTexture(canvas));
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = v.aniso ?? maxAniso;
    if (v.filter === NOMIP) {
      texture.generateMipmaps = false;
      texture.minFilter = THREE.LinearFilter;
    } else {
      texture.generateMipmaps = !v.sharpMips;
      if (v.sharpMips) texture.mipmaps = sharpMipChain(canvas, v.sharpMips);
      texture.minFilter = v.filter === MIP_NEAREST ? THREE.LinearMipmapNearestFilter : THREE.LinearMipmapLinearFilter;
    }
    texture.magFilter = THREE.LinearFilter;
    const material = keep(
      new THREE.MeshBasicMaterial({ map: texture, toneMapped: false, transparent: !v.opaque }),
    );
    if (v.lodBias) {
      // сдвиг уровня mipmap: берётся более детальный уровень, чем выбрал бы GPU
      const bias = v.lodBias.toFixed(2);
      material.onBeforeCompile = (shader) => {
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <map_fragment>',
          THREE.ShaderChunk.map_fragment.replace('texture2D( map, vMapUv )', `texture2D( map, vMapUv, ${bias} )`),
        );
      };
      material.customProgramCacheKey = () => `text-test-lodbias-${bias}`;
    }
    const cell = new THREE.Mesh(cellGeometry, material);
    const col = index % COLS;
    const row = Math.floor(index / COLS);
    cell.position.set(
      -BOARD_W / 2 + MARGIN_M + CELL_W_M / 2 + col * (CELL_W_M + GAP_M),
      BOARD_H / 2 - MARGIN_M - TITLE_M - CELL_H_M / 2 - row * (CELL_H_M + GAP_M),
      0,
    );
    board.add(cell);
  });

  root.add(board);

  // ---- положение: сохранённое (после подмены сцены) или перед глазами
  const respawn = () => {
    const head = camera.getWorldPosition(new THREE.Vector3());
    const direction = camera.getWorldDirection(new THREE.Vector3());
    direction.y = 0;
    if (direction.lengthSq() < 1e-6) direction.set(0, 0, -1);
    direction.normalize();
    board.position.copy(head).addScaledVector(direction, SPAWN_M);
    board.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(-direction.x, -direction.z)); // лицом к игроку
    board.scale.set(1, 1, 1);
    savePose();
  };
  const savePose = () => {
    shared.textTestPose = { p: board.position.toArray(), q: board.quaternion.toArray() };
  };
  if (shared.textTestPose) {
    board.position.fromArray(shared.textTestPose.p);
    board.quaternion.fromArray(shared.textTestPose.q);
  } else {
    respawn();
  }

  const grab = createRelativeGrab({ THREE, object: board });
  const local = new THREE.Vector3();
  let near = false;

  const buzz = (source, strength, ms) => source?.gamepad?.hapticActuators?.[0]?.pulse?.(strength, ms);

  // расстояние от точки до доски (0 — над/под самой доской вплотную)
  const distanceTo = (point) => {
    board.updateWorldMatrix(true, false);
    board.worldToLocal(local.copy(point));
    const dx = Math.max(Math.abs(local.x) - BOARD_W / 2, 0);
    const dy = Math.max(Math.abs(local.y) - BOARD_H / 2, 0);
    return Math.hypot(dx, dy, local.z);
  };

  const api = {
    board,
    respawn,
    get held() {
      return grab.held;
    },
    // Каждый кадр, из main.js — после поиска ближайшего оружия/тарелки и до их хвата.
    // handBusy: в руке что-то есть или рядом оружие/тарелка (они главнее доски).
    update({ hand, gripWorld, handPosition, gripDown, gripWasDown, gripMode, menuIsOpen, handBusy, source }) {
      const pressed = gripDown && !gripWasDown;
      if (grab.held) {
        const letGo = gripMode === 'hold' ? !gripDown && !menuIsOpen : pressed && !menuIsOpen;
        if (letGo || !hand) {
          grab.release();
          savePose();
          buzz(source, 0.2, 90);
        } else {
          grab.update(gripWorld);
          savePose();
        }
      } else if (hand) {
        near = !handBusy && distanceTo(handPosition) < GRAB_REACH_M;
        if (near && pressed && !menuIsOpen) {
          grab.grab(gripWorld);
          buzz(source, 0.4, 40);
        }
      } else {
        near = false;
      }
      frameMaterial.color.setHex(grab.held ? FRAME_HELD : near ? FRAME_NEAR : FRAME_IDLE);
    },
    dispose() {
      if (grab.held) savePose();
      root.remove(board);
      for (const thing of disposables) thing.dispose();
    },
  };
  shared.textTest = api; // ручка для npm run vr:eval
  return api;
}
