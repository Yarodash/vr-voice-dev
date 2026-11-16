// A pop-up with Claude's answer (or a warning from the page itself). One message at a time;
// the cross closes it and shows the next one, if there is one.
import * as THREE from 'three';
import { fitText, roundRect, wrapText } from './canvas-text.js';
import { MESSAGE, messageActionAt } from './ui-layout.js';

const TEXT_FONT = '500 46px system-ui, "Noto Sans", sans-serif';
const SMALL_FONT = '600 32px system-ui, "Noto Sans", sans-serif';
const LINE_PX = 60;
const MAX_LINES = 6;
const PAD = 40;
const { width: W, height: H, close: CLOSE } = MESSAGE;

// widthM: how wide the panel is in the scene, in metres.
export function createMessagePanel({ renderer, widthM }) {
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const g = canvas.getContext('2d');

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = renderer.capabilities.getMaxAnisotropy();

  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(widthM, (widthM * H) / W),
    // Drawn over everything: it is part of the user's view, not an object in the scene.
    new THREE.MeshBasicMaterial({ map: texture, toneMapped: false, transparent: true, depthTest: false }),
  );
  mesh.renderOrder = 1000;
  mesh.visible = false;

  let shown = null; // { text, warning, more }
  let dirty = false;

  function paint() {
    g.clearRect(0, 0, W, H);
    g.fillStyle = shown.warning ? 'rgba(69, 26, 26, 0.97)' : 'rgba(23, 37, 63, 0.97)';
    roundRect(g, { x: 0, y: 0, w: W, h: H }, 28);
    g.textBaseline = 'middle';

    g.font = SMALL_FONT;
    g.fillStyle = shown.warning ? '#fca5a5' : '#93c5fd';
    const title = shown.warning ? 'Внимание' : 'Claude';
    g.fillText(shown.more > 0 ? `${title}   ·   ещё сообщений: ${shown.more}` : title, PAD, 72);

    g.fillStyle = '#334155';
    roundRect(g, CLOSE, 20);
    g.strokeStyle = '#ffffff';
    g.lineWidth = 8;
    g.lineCap = 'round';
    g.beginPath();
    g.moveTo(CLOSE.x + 30, CLOSE.y + 30);
    g.lineTo(CLOSE.x + CLOSE.w - 30, CLOSE.y + CLOSE.h - 30);
    g.moveTo(CLOSE.x + CLOSE.w - 30, CLOSE.y + 30);
    g.lineTo(CLOSE.x + 30, CLOSE.y + CLOSE.h - 30);
    g.stroke();

    g.font = TEXT_FONT;
    g.fillStyle = '#f1f5f9';
    const lines = wrapText(g, shown.text, W - PAD * 2);
    const visible = lines.slice(0, MAX_LINES);
    if (lines.length > MAX_LINES) visible[MAX_LINES - 1] = fitText(g, `${visible[MAX_LINES - 1]} …`, W - PAD * 2);
    visible.forEach((line, index) => g.fillText(line, PAD, 170 + index * LINE_PX));
    texture.needsUpdate = true;
  }

  return {
    mesh,
    // uv of a ray hit on the mesh -> 'close-message' | null
    actionAt: (uv) => (mesh.visible ? messageActionAt(uv.x, uv.y) : null),
    // message: { text, warning? } or null to hide; more: how many others are waiting behind it
    show(message, more = 0) {
      shown = message ? { text: message.text, warning: Boolean(message.warning), more } : null;
      mesh.visible = Boolean(shown);
      dirty = Boolean(shown);
    },
    tick() {
      if (!dirty) return;
      dirty = false;
      paint();
    },
  };
}
