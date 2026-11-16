// Turns one row of terminal cells into the few fillText calls needed to paint it.

// Latin and Cyrillic come from the bundled monospace font, so a whole run can be drawn at once.
// Anything else (box drawing, symbols, CJK) may come from a fallback font with a different
// advance, so it is drawn cell by cell to stay on the grid.
const LAST_PLAIN_CODE_POINT = 0x04ff;

const isPlain = (ch) => ch.length === 1 && ch.charCodeAt(0) <= LAST_PLAIN_CODE_POINT;

// cells: [{ ch, width, fg, bg, bold, dim, inverse }]  (fg/bg: CSS colour or null for the default)
// returns: [{ x, cols, text, fg, bg, bold, dim }]     (bg: null when nothing has to be filled)
export function rowRuns(cells, defaults) {
  const runs = [];
  let current = null;
  let x = 0;

  for (const cell of cells) {
    if (cell.width === 0) continue; // second half of a wide character

    const ch = cell.ch || ' ';
    let fg = cell.fg ?? defaults.fg;
    let bg = cell.bg ?? defaults.bg;
    if (cell.inverse) [fg, bg] = [bg, fg];
    if (bg === defaults.bg) bg = null;

    const mergeable =
      current &&
      current.plain &&
      isPlain(ch) &&
      current.fg === fg &&
      current.bg === bg &&
      current.bold === cell.bold &&
      current.dim === cell.dim;

    if (mergeable) {
      current.text += ch;
      current.cols += cell.width;
    } else {
      current = { x, cols: cell.width, text: ch, fg, bg, bold: cell.bold, dim: cell.dim, plain: isPlain(ch) };
      runs.push(current);
    }
    x += cell.width;
  }

  // Blank space without a background needs no drawing; trimming it also keeps the first visible
  // glyph of a run exactly on its own cell. (Merged runs are one cell per character.)
  return runs
    .map(({ plain, ...run }) => {
      if (run.bg !== null) return run;
      const text = run.text.trim();
      const lead = run.text.length - run.text.trimStart().length;
      return { ...run, x: run.x + lead, cols: plain ? text.length : run.cols, text };
    })
    .filter((run) => run.bg !== null || run.text !== '');
}
