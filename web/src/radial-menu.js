// A radial ("pie") menu in the style of the old CS:GO wheel: it opens on a click of the stick, the
// thumbstick points at a sector (the last one pointed at stays chosen), the next click confirms
// it. A sector may hold a submenu: confirming it opens the submenu; a sector with `back: true`
// confirmed leads out of the submenu.
//
// menu: { title, items: [{ label, children?: items, back?: true }] }
import * as THREE from 'three';

const SIZE = 1024;
const OUTER = 470; // radii, canvas pixels
const INNER = 130;
const GAP = 0.025; // radians between sectors
const DEAD = 0.45; // stick deflection below which nothing is picked

const FAMILY = 'system-ui, "Noto Sans", sans-serif';
const SMALL = `500 36px ${FAMILY}`;

// The menu itself is defined in scene/menu.js (and handed over with ctx.setMenu), so that changing
// it does not reload the page.

// widthM: how wide the wheel is in the scene, in metres.
export function createRadialMenu({ renderer, widthM = 0.45, getMenu = null }) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIZE;
  const g = canvas.getContext('2d');

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(widthM, widthM),
    // Part of the user's view, not an object in the scene: drawn over everything.
    new THREE.MeshBasicMaterial({ map: texture, toneMapped: false, transparent: true, depthTest: false }),
  );
  mesh.renderOrder = 900;
  mesh.visible = false;

  let levels = []; // [{ title, items }]: the menu being shown, and the ones it was entered from
  let labels = []; // labels of the sectors entered so far
  let hovered = -1;
  let pushedBack = false; // the choice was taken back by pushing the stick the opposite way
  let dirty = false;
  let shownMenu = null; // the menu object the levels were taken from (see tick)

  const current = () => levels[levels.length - 1];

  function sectorAt(x, y, count) {
    const angle = (Math.atan2(x, -y) + Math.PI * 2) % (Math.PI * 2); // from "up", clockwise
    const width = (Math.PI * 2) / count;
    return Math.floor(((angle + width / 2) % (Math.PI * 2)) / width);
  }

  // Fits text into a w x h box: wraps at word boundaries (up to maxLines), shrinking the font step by
  // step until every line fits. Returns { lines, size, lineH }.
  function fit(text, weight, w, h, maxSize, minSize, maxLines) {
    let best = null;
    for (let size = maxSize; size >= minSize; size -= 2) {
      g.font = `${weight} ${size}px ${FAMILY}`;
      const words = String(text).split(/\s+/).filter(Boolean);
      const lines = [];
      let line = '';
      for (const word of words) {
        const tryLine = line ? `${line} ${word}` : word;
        if (!line || g.measureText(tryLine).width <= w) line = tryLine;
        else {
          lines.push(line);
          line = word;
        }
      }
      if (line) lines.push(line);
      const lineH = size * 1.15;
      best = { lines, size, lineH };
      if (lines.length <= maxLines && lines.length * lineH <= h && lines.every((l) => g.measureText(l).width <= w)) return best;
    }
    return best;
  }

  function drawBlock(block, weight, x, y) {
    g.font = `${weight} ${block.size}px ${FAMILY}`;
    block.lines.forEach((l, i) => g.fillText(l, x, y + (i - (block.lines.length - 1) / 2) * block.lineH));
  }

  function paint() {
    const { title, items } = current();
    const cx = SIZE / 2;
    const cy = SIZE / 2;
    const width = (Math.PI * 2) / items.length;
    g.clearRect(0, 0, SIZE, SIZE);

    items.forEach((item, index) => {
      const centre = index * width - Math.PI / 2; // canvas angles: 0 is to the right
      const start = centre - width / 2 + GAP;
      const end = centre + width / 2 - GAP;
      g.beginPath();
      g.arc(cx, cy, OUTER, start, end);
      g.arc(cx, cy, INNER, end, start, true);
      g.closePath();
      const on = index === hovered;
      g.fillStyle = on ? 'rgba(59, 130, 246, 0.95)' : item.back ? 'rgba(51, 65, 85, 0.88)' : 'rgba(23, 37, 63, 0.88)';
      g.fill();
      g.lineWidth = on ? 8 : 3;
      g.strokeStyle = on ? '#bfdbfe' : 'rgba(147, 197, 253, 0.35)';
      g.stroke();

      const radius = (OUTER + INNER) / 2;
      const lx = cx + Math.cos(centre) * radius;
      const ly = cy + Math.sin(centre) * radius;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillStyle = on ? '#ffffff' : '#e2e8f0';
      // the usable box: the sector's chord at mid radius across, its radial depth along
      const chord = 2 * radius * Math.sin(Math.min(width / 2 - GAP / 2, Math.PI / 2));
      const boxW = Math.max(150, Math.min(chord - 40, OUTER - INNER - 30));
      const arrowH = item.children ? 40 : 0;
      const boxH = Math.max(70, Math.min(chord - 40, OUTER - INNER - 50) - arrowH);
      const block = fit(item.label, 600, boxW, boxH, 54, 26, 3);
      const textH = block.lines.length * block.lineH;
      const total = textH + arrowH;
      drawBlock(block, 600, lx, ly - total / 2 + textH / 2);
      if (item.children) {
        g.font = SMALL;
        g.fillStyle = on ? '#dbeafe' : '#93c5fd';
        g.fillText('▸', lx, ly + total / 2 - 18);
      }
    });

    g.beginPath();
    g.arc(cx, cy, INNER - 22, 0, Math.PI * 2);
    // the centre is chosen when no sector is (confirming there goes back): lit like a chosen sector
    const centreChosen = hovered === -1;
    g.fillStyle = centreChosen ? 'rgba(59, 130, 246, 0.95)' : 'rgba(15, 23, 42, 0.92)';
    g.fill();
    if (centreChosen) {
      g.lineWidth = 8;
      g.strokeStyle = '#bfdbfe';
      g.stroke();
    }
    g.fillStyle = centreChosen ? '#ffffff' : '#93c5fd';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    const inner = INNER - 22;
    const cBlock = fit(labels.length ? labels.join(' › ') : title, 500, inner * 1.5, inner * 1.3, 36, 16, 3);
    drawBlock(cBlock, 500, cx, cy);
    texture.needsUpdate = true;
  }

  return {
    mesh,
    get isOpen() {
      return mesh.visible;
    },
    open(menu) {
      levels = [{ title: menu.title, items: menu.items }];
      shownMenu = menu;
      labels = [];
      hovered = -1;
      pushedBack = false;
      mesh.visible = true;
      dirty = true;
    },
    // x, y: the thumbstick, as the gamepad reports it (right and down are positive)
    setStick(x, y) {
      if (!mesh.visible || current().items.length === 0) return; // nothing to point at in an empty menu
      // With the stick back in the middle the last sector stays chosen; a new direction changes the
      // choice, and pushing the stick the opposite way takes the choice back to the centre (nothing
      // chosen: confirming then goes back, see confirm).
      const count = current().items.length;
      let next = hovered;
      if (Math.hypot(x, y) <= DEAD) {
        pushedBack = false; // the stick is back in the middle: a new choice may be made
      } else if (!pushedBack) {
        // (after the choice was taken back, nothing is chosen again until the stick has been in the
        // middle: otherwise holding the stick against it would choose and take back every frame)
        const angle = (Math.atan2(x, -y) + Math.PI * 2) % (Math.PI * 2); // from "up", clockwise
        const chosen = hovered >= 0 ? (hovered * Math.PI * 2) / count : null;
        const away = chosen === null ? 0 : Math.abs(((angle - chosen + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
        if (chosen !== null && away > (Math.PI * 3) / 4) {
          next = -1;
          pushedBack = true;
        } else {
          next = sectorAt(x, y, count);
        }
      }
      if (next !== hovered) {
        hovered = next;
        dirty = true;
      }
    },
    // The click on the stick. On a sector with a submenu it opens that submenu; on "back" it goes
    // out of one; on an ordinary sector it picks it and hides the wheel; with nothing chosen it
    // just hides the wheel. Returns what was picked ({ path: [labels], label }) or null.
    confirm() {
      const item = hovered >= 0 ? current().items[hovered] : null;
      if (item && item.back && levels.length > 1) {
        levels.pop();
        labels.pop();
        hovered = -1;
        dirty = true;
        return null;
      }
      if (item && item.children) {
        levels.push({ title: item.label, items: item.children });
        labels.push(item.label);
        hovered = -1;
        dirty = true;
        return null;
      }
      if (!item) {
        // the centre: one step back, out of a submenu or, at the top level, closes the wheel
        this.back();
        return null;
      }
      const picked = item && !item.back ? { path: [...labels, item.label], label: item.label } : null;
      if (picked && item.keepOpen) {
        dirty = true; // a toggle: the wheel stays open, same sector; labels refresh in tick() when the scene rebuilds the menu
        return picked;
      }
      mesh.visible = false;
      levels = [];
      labels = [];
      hovered = -1;
      return picked;
    },
    // One step back: out of a submenu, or, at the top level, closes the wheel.
    back() {
      if (levels.length > 1) {
        levels.pop();
        labels.pop();
        hovered = -1;
        dirty = true;
      } else {
        this.close();
      }
    },
    // Hides the wheel without choosing anything.
    close() {
      mesh.visible = false;
      levels = [];
      labels = [];
      hovered = -1;
    },
    tick() {
      // the scene rebuilt its menu (a toggle flipped): take the new items at the same path, keep the sector
      const latest = getMenu && mesh.visible ? getMenu() : null;
      if (latest && latest !== shownMenu) {
        shownMenu = latest;
        let items = latest.items;
        const next = [{ title: latest.title, items }];
        for (const label of labels) {
          const entry = items.find((it) => it.label === label && it.children);
          if (!entry) break;
          items = entry.children;
          next.push({ title: entry.label, items });
        }
        if (next.length === labels.length + 1) {
          levels = next;
          if (hovered >= items.length) hovered = -1;
        } else {
          levels = next.slice(0, 1);
          labels = [];
          hovered = -1;
        }
        dirty = true;
      }
      if (!mesh.visible || !dirty) return;
      dirty = false;
      paint();
    },
  };
}
