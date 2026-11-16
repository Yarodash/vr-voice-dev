// A pop-up with Claude's answer (or a warning from the page itself), or the phrase the user has
// sent. The window is only as tall as its text needs; several are stacked by the caller.
import * as THREE from 'three';
import { fitText, roundRect, wrapText } from './canvas-text.js';
import { MESSAGE } from './ui-layout.js';

const TEXT_FONT = '500 46px system-ui, "Noto Sans", sans-serif';
const SMALL_FONT = '600 32px system-ui, "Noto Sans", sans-serif';
const LINE_PX = 60;
const MAX_LINES = 6;
const PAD = 40;
const { width: W, height: H, box: BOX } = MESSAGE; // BOX: where the text window sits
const TITLE_Y = 36; // from the top of the window
const FIRST_LINE_Y = 96; // centre of the first text line, from the top of the window
const BOTTOM_PAD = 36;
const TEXT_WIDTH = BOX.w - PAD * 2;
const SEND_STRIP = 112; // under the unsent preview: room for the "Отправить" button
const CROSS = { x: BOX.x + BOX.w + 18, y: BOX.y, w: 96, h: 96 }; // only the unsent preview has one: it cancels the phrase

// widthM: how wide the panel is in the scene, in metres.
export function createMessagePanel({ renderer, widthM }) {
  // Text sharpness: the user compared variants on a test board in the headset (scene/text-test.js)
  // and picked «2× canvas, trilinear mipmaps, anisotropy 16, LOD bias −0.5» as sharp without shimmer.
  // The canvas is drawn at SCALE× the layout size (layout numbers stay in 1× units: the context is
  // scaled); the bias makes the GPU pick a half-level sharper mipmap.
  const SCALE = 2;
  const LOD_BIAS = -0.5;
  const canvas = document.createElement('canvas');
  canvas.width = W * SCALE;
  canvas.height = H * SCALE;
  const g = canvas.getContext('2d');
  g.setTransform(SCALE, 0, 0, SCALE, 0, 0);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = renderer.capabilities.getMaxAnisotropy();

  const fullM = (widthM * H) / W; // height of the whole canvas, in metres
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(widthM, fullM),
    // Drawn over everything: it is part of the user's view, not an object in the scene.
    new THREE.MeshBasicMaterial({ map: texture, toneMapped: false, transparent: true, depthTest: false }),
  );
  // the scene may patch this material further (message holes): it calls this hook first
  mesh.material.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <map_fragment>',
      THREE.ShaderChunk.map_fragment.replace('texture2D( map, vMapUv )', `texture2D( map, vMapUv, ${LOD_BIAS.toFixed(2)} )`),
    );
  };
  mesh.material.customProgramCacheKey = () => `message-panel-lodbias-${LOD_BIAS}`;
  mesh.renderOrder = 1000;
  mesh.visible = false;
  // The window itself (not the empty strip with the cross) is what stays centred.
  const centreShiftM = (widthM * (W / 2 - (BOX.x + BOX.w / 2))) / W;
  mesh.position.x = centreShiftM;
  const windowWidthM = (widthM * BOX.w) / W;
  let sideShiftM = windowWidthM / 14; // 1/14 of the window's width, in metres (setSideShift changes it)

  let shown = null; // { text, warning, from, more }
  let shownHeight = H; // canvas pixels the panel takes now, from the top
  let dirty = false;
  let hover = null; // the button under the controller's ray: 'cancel-draft' | 'send-draft' | null
  let sendRect = null; // where the "Отправить" button is now (canvas pixels)

  // like in a chat: Claude's windows a bit to the left, the user's to the right
  function placeSideways() {
    if (shown) mesh.position.x = centreShiftM + (shown.from === 'user' || shown.from === 'draft' ? sideShiftM : -sideShiftM);
  }

  function paint() {
    g.clearRect(0, 0, W, H);

    g.font = TEXT_FONT;
    const lines = wrapText(g, shown.text, TEXT_WIDTH);
    const visible = lines.slice(0, MAX_LINES);
    if (lines.length > MAX_LINES) visible[MAX_LINES - 1] = fitText(g, `${visible[MAX_LINES - 1]} …`, TEXT_WIDTH);
    const boxH = FIRST_LINE_Y + (Math.max(visible.length, 1) - 1) * LINE_PX + LINE_PX / 2 + BOTTOM_PAD;
    const typing = shown.from === 'draft'; // what the user is dictating right now: the unsent preview
    shownHeight = Math.min(H, BOX.y + boxH + (typing ? SEND_STRIP : 0));
    sendRect = typing ? { x: BOX.x + BOX.w - 300, y: BOX.y + boxH + 12, w: 300, h: 88 } : null;

    const mine = shown.from === 'user'; // the phrase the user has just sent, marked "You"
    g.fillStyle = shown.warning ? 'rgba(69, 26, 26, 0.97)' : typing ? 'rgba(48, 88, 38, 0.97)' : mine ? 'rgba(20, 54, 42, 0.97)' : 'rgba(23, 37, 63, 0.97)';
    roundRect(g, { x: BOX.x, y: BOX.y, w: BOX.w, h: boxH }, 28);
    g.textBaseline = 'middle';

    g.font = SMALL_FONT;
    g.fillStyle = shown.warning ? '#fca5a5' : typing ? '#ecfccb' : mine ? '#86efac' : '#93c5fd';
    const title = shown.warning ? 'Внимание' : typing ? 'Набираю…' : mine ? 'You' : 'Claude';
    g.fillText(shown.more > 0 ? `${title}   ·   ещё сообщений: ${shown.more}` : title, BOX.x + PAD, BOX.y + TITLE_Y);

    if (typing) {
      g.fillStyle = hover === 'cancel-draft' ? '#dc2626' : '#334155'; // the ray is on the cross: it turns red
      roundRect(g, CROSS, 20);
      g.strokeStyle = '#ffffff';
      g.lineWidth = 8;
      g.lineCap = 'round';
      g.beginPath();
      g.moveTo(CROSS.x + 30, CROSS.y + 30);
      g.lineTo(CROSS.x + CROSS.w - 30, CROSS.y + CROSS.h - 30);
      g.moveTo(CROSS.x + CROSS.w - 30, CROSS.y + 30);
      g.lineTo(CROSS.x + 30, CROSS.y + CROSS.h - 30);
      g.stroke();

      // the button that sends the preview as it is (after a reload the phrase may already be there)
      g.fillStyle = hover === 'send-draft' ? '#65a30d' : '#4d7c0f';
      roundRect(g, sendRect, 22);
      g.fillStyle = '#f7fee7';
      g.font = '600 40px system-ui, "Noto Sans", sans-serif';
      g.textAlign = 'center';
      g.fillText('Отправить', sendRect.x + sendRect.w / 2, sendRect.y + sendRect.h / 2 + 2);
      g.textAlign = 'left';
    }

    g.font = TEXT_FONT;
    g.fillStyle = '#f1f5f9';
    visible.forEach((line, index) => g.fillText(line, BOX.x + PAD, BOX.y + FIRST_LINE_Y + index * LINE_PX));

    // Show only the top part of the canvas. Where the panel sits vertically is up to the caller
    // (see heightM): several panels are stacked.
    const part = shownHeight / H;
    texture.repeat.set(1, part);
    texture.offset.set(0, 1 - part);
    mesh.scale.y = part;
    texture.needsUpdate = true;
  }

  return {
    mesh,
    fullHeightM: fullM, // the height the tallest window takes, in metres
    // The height the panel takes now (the window and the margin above it), metres.
    get heightM() {
      return fullM * (shownHeight / H);
    },
    // How far below the top of the panel its window starts, metres.
    windowOffsetM: (BOX.y / H) * fullM,
    // uv of a ray hit on the mesh -> 'cancel-draft' (the cross) | 'send-draft' (the button) | null;
    // only the unsent preview has them
    actionAt: (uv) => {
      if (!mesh.visible || shown?.from !== 'draft') return null;
      const x = uv.x * W;
      const y = (1 - uv.y) * shownHeight;
      const inside = (r) => r && x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
      if (inside(CROSS)) return 'cancel-draft';
      return inside(sendRect) ? 'send-draft' : null;
    },
    // the action under the controller's ray (or null): that button is drawn highlighted
    setHover(action) {
      if (action === hover) return;
      hover = action;
      dirty = Boolean(shown);
    },
    // 0..1; older messages are drawn fainter
    setOpacity(opacity) {
      mesh.material.opacity = opacity;
    },
    // message: { id, text, warning?, from?: 'user' } or null to hide
    show(message, more = 0) {
      const next = message
        ? { id: message.id, text: message.text, warning: Boolean(message.warning), from: message.from, more }
        : null;
      // the same message again: no repaint (a repaint re-uploads the whole 1600×640 texture, ~10 ms on Quest)
      const same = next && shown && next.id === shown.id && next.text === shown.text
        && next.warning === shown.warning && next.from === shown.from && next.more === shown.more;
      if (same || (!next && !shown)) return;
      shown = next;
      mesh.userData.message = shown; // what this window shows (the scene keys bullet holes by it)
      mesh.visible = Boolean(shown);
      dirty = Boolean(shown);
      // like in a chat: Claude's windows a fourteenth of their width to the left, the user's to the right
      placeSideways();
    },
    // fraction of the window's width the windows are pushed aside by
    setSideShift(fraction) {
      sideShiftM = windowWidthM * fraction;
      placeSideways();
    },
    // repaints if needed; true when it did (the caller repaints at most one window per frame)
    tick() {
      if (!dirty) return false;
      dirty = false;
      paint();
      return true;
    },
  };
}
