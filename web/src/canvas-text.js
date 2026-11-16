// Small helpers for drawing text panels on a 2D canvas.

export function wrapText(g, text, maxWidth) {
  const lines = [];
  let line = '';
  for (const word of text.split(' ')) {
    const candidate = line ? `${line} ${word}` : word;
    if (line && g.measureText(candidate).width > maxWidth) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  return lines;
}

export function fitText(g, text, maxWidth) {
  if (g.measureText(text).width <= maxWidth) return text;
  let cut = text;
  while (cut.length > 1 && g.measureText(`${cut}…`).width > maxWidth) cut = cut.slice(0, -1);
  return `${cut}…`;
}

export function roundRect(g, rect, radius) {
  g.beginPath();
  g.roundRect(rect.x, rect.y, rect.w, rect.h, radius);
  g.fill();
}
