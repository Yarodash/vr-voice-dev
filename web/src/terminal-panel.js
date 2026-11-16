// The Claude Code terminal as a panel in the 3D scene.
// xterm.js parses the terminal stream; we paint its cell grid onto a canvas used as a texture.
import { Terminal } from '@xterm/xterm';
import * as THREE from 'three';
import { rowRuns } from './term-paint.js';

const FONT_PX = 28;
const FONT = '"JetBrains Mono", "DejaVu Sans Mono", monospace';
const LINE_HEIGHT = 1.32;
const HEADER_PX = 44;
const REPAINT_MS = 66;
const PANEL_WIDTH_M = 2.0;
const COLORS = { fg: '#d8dee9', bg: '#10141c' };
const ANSI = [
  '#1d2330', '#e06c75', '#98c379', '#e5c07b', '#61afef', '#c678dd', '#56b6c2', '#c8ccd4',
  '#5c6370', '#ff7b86', '#b5e890', '#ffd68a', '#7cc5ff', '#e19bff', '#7fe0ea', '#ffffff',
];
const VOICE = {
  idle: { color: '#6b7280', label: 'курок — говорить' },
  warmup: { color: '#f59e0b', label: 'секунду…' },
  listening: { color: '#ef4444', label: 'ГОВОРИТЕ' },
  finalizing: { color: '#3b82f6', label: 'распознаю…' },
};

function paletteColor(index) {
  if (index < 16) return ANSI[index];
  if (index < 232) {
    const n = index - 16;
    const level = (c) => (c === 0 ? 0 : 55 + c * 40);
    return `rgb(${level(Math.floor(n / 36))},${level(Math.floor(n / 6) % 6)},${level(n % 6)})`;
  }
  const gray = 8 + (index - 232) * 10;
  return `rgb(${gray},${gray},${gray})`;
}

function cellColor(cell, kind) {
  if (cell[`is${kind}RGB`]()) return `#${cell[`get${kind}Color`]().toString(16).padStart(6, '0')}`;
  if (cell[`is${kind}Palette`]()) return paletteColor(cell[`get${kind}Color`]());
  return null;
}

export async function createTerminalPanel({ cols, rows, renderer, domParent }) {
  // Canvas text only uses a web font once it has loaded; ask for the Latin and Cyrillic subsets.
  await Promise.all(
    [400, 700].map((weight) => document.fonts.load(`${weight} ${FONT_PX}px "JetBrains Mono"`, 'Aя')),
  ).catch(() => {});

  const term = new Terminal({
    cols,
    rows,
    scrollback: 5000,
    disableStdin: true,
    cursorBlink: false,
    fontFamily: FONT,
    fontSize: 13,
    theme: { background: COLORS.bg, foreground: COLORS.fg },
  });
  if (domParent) term.open(domParent); // the same terminal as a normal element on the 2D page

  const canvas = document.createElement('canvas');
  const g = canvas.getContext('2d');
  g.font = `400 ${FONT_PX}px ${FONT}`;
  const cellW = g.measureText('M').width; // fractional on purpose: must equal the font's advance
  const cellH = Math.round(FONT_PX * LINE_HEIGHT);
  canvas.width = Math.ceil(cols * cellW);
  canvas.height = HEADER_PX + rows * cellH;

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = renderer.capabilities.getMaxAnisotropy();

  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(PANEL_WIDTH_M, (PANEL_WIDTH_M * canvas.height) / canvas.width),
    new THREE.MeshBasicMaterial({ map: texture, toneMapped: false }),
  );
  mesh.position.set(0, 1.5, -1.6);
  mesh.lookAt(0, 1.6, 0);

  let voice = 'idle';
  let note = '';
  let noteColor = '#f87171';
  let dirty = true;
  let paintedAt = -Infinity;
  let version = 0; // grows whenever the screen content may have changed
  const markDirty = () => {
    dirty = true;
    version += 1;
  };
  term.onWriteParsed(markDirty);
  term.onScroll(markDirty);

  function paintHeader() {
    const mid = HEADER_PX / 2;
    const state = VOICE[voice] ?? VOICE.idle;
    g.fillStyle = '#1a2130';
    g.fillRect(0, 0, canvas.width, HEADER_PX);
    g.fillStyle = state.color;
    g.beginPath();
    g.arc(24, mid, 10, 0, Math.PI * 2);
    g.fill();
    g.font = `700 22px ${FONT}`;
    g.textBaseline = 'middle';
    g.textAlign = 'left';
    g.fillStyle = '#e5e9f0';
    g.fillText(state.label, 46, mid);
    if (note) {
      g.textAlign = 'right';
      g.fillStyle = noteColor;
      g.fillText(note.length > 70 ? `${note.slice(0, 69)}…` : note, canvas.width - 16, mid);
      g.textAlign = 'left';
    }
  }

  function paintGlyph(run, left, top) {
    const center = left + (run.cols * cellW) / 2;
    if (run.text === '─') {
      g.fillRect(left, top + cellH / 2 - 1, cellW + 0.5, 2); // continuous line, whatever the fallback font
    } else if (run.text === '│') {
      g.fillRect(center - 1, top, 2, cellH);
    } else {
      g.textAlign = 'center';
      g.fillText(run.text, center, top + cellH / 2);
      g.textAlign = 'left';
    }
  }

  function paint() {
    g.fillStyle = COLORS.bg;
    g.fillRect(0, 0, canvas.width, canvas.height);
    paintHeader();

    const buffer = term.buffer.active;
    const scratch = buffer.getNullCell();
    g.textBaseline = 'middle';
    for (let y = 0; y < rows; y += 1) {
      const line = buffer.getLine(buffer.viewportY + y);
      if (!line) continue;
      const cells = [];
      for (let x = 0; x < cols; x += 1) {
        const cell = line.getCell(x, scratch);
        if (!cell) break;
        cells.push({
          ch: cell.getChars(),
          width: cell.getWidth(),
          fg: cellColor(cell, 'Fg'),
          bg: cellColor(cell, 'Bg'),
          bold: Boolean(cell.isBold()),
          dim: Boolean(cell.isDim()),
          inverse: Boolean(cell.isInverse()),
        });
      }
      const top = HEADER_PX + y * cellH;
      for (const run of rowRuns(cells, COLORS)) {
        const left = run.x * cellW;
        if (run.bg) {
          g.fillStyle = run.bg;
          g.fillRect(left, top, run.cols * cellW, cellH);
        }
        if (run.text.trim() === '') continue;
        g.font = `${run.bold ? 700 : 400} ${FONT_PX}px ${FONT}`;
        g.globalAlpha = run.dim ? 0.6 : 1;
        g.fillStyle = run.fg;
        if (run.text.length === 1 && run.text.charCodeAt(0) > 0x04ff) paintGlyph(run, left, top);
        else g.fillText(run.text, left, top + cellH / 2);
        g.globalAlpha = 1;
      }
    }
    texture.needsUpdate = true;
  }

  return {
    mesh,
    get version() {
      return version;
    },
    // Where the terminal's cursor is on the visible screen.
    get cursor() {
      const buffer = term.buffer.active;
      return { x: buffer.cursorX, y: buffer.cursorY + buffer.baseY - buffer.viewportY };
    },
    // The visible screen as rows of cells (one per column), for reading text back out of it.
    readScreen() {
      const buffer = term.buffer.active;
      const scratch = buffer.getNullCell();
      const screen = [];
      for (let y = 0; y < rows; y += 1) {
        const line = buffer.getLine(buffer.viewportY + y);
        const cells = [];
        for (let x = 0; line && x < cols; x += 1) {
          const cell = line.getCell(x, scratch);
          if (!cell) break;
          // one entry per column, so that the cursor's x is an index into the row
          cells.push({ ch: cell.getChars(), skip: cell.getWidth() === 0 });
        }
        screen.push(cells);
      }
      return screen;
    },
    write(bytes) {
      term.write(bytes);
    },
    reset() {
      term.reset();
      markDirty();
    },
    // True while a full-screen program (Claude Code's default renderer) owns the screen:
    // there is no scrollback then, the program scrolls itself on PgUp/PgDn.
    get alternateScreen() {
      return term.buffer.active.type === 'alternate';
    },
    scrollLines(amount) {
      term.scrollLines(amount);
    },
    setVoiceState(state) {
      voice = state;
      markDirty();
    },
    setNote(text, color = '#f87171') {
      note = text ?? '';
      noteColor = color;
      markDirty();
    },
    tick(nowMs) {
      // hidden (the usual case): nothing to draw; it stays dirty and is painted once shown again
      if (!dirty || !mesh.visible || nowMs - paintedAt < REPAINT_MS) return;
      dirty = false;
      paintedAt = nowMs;
      paint();
    },
  };
}
