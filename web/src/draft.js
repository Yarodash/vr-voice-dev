// Reads what matters out of the Claude Code screen, so the user never has to look at the
// terminal itself: the text dictated so far, whether Claude is working, and its last answer.
//
// Claude Code keeps the prompt in a box between two horizontal rules near the bottom of the
// screen. The dictated words accumulate there until they are sent, so that box *is* the draft.

const RULE_CHAR = '─';
const LEVEL_BARS = /[▁-█]+$/; // the microphone-level cursor shown while recording
const ANSWER = /^●\s+/; // Claude Code marks its messages (and tool calls) with a bullet
const TOOL_CALL = /^●\s+[A-Za-z][\w ]*(\(|$)/; // "● Update(file)", "● Stop Task"
const SPINNER = /^[^\s\w●❯>]\s+\S.*…/; // "✽ Honking… (esc to interrupt)"

const HINT = /^Try ".*"$/; // what Claude Code shows in an empty prompt of a fresh session

// `skip` marks the second column of a wide character: it holds no text of its own.
const textOf = (cells) => cells.filter((cell) => !cell.skip).map((cell) => cell.ch || ' ').join('');

function isRule(cells) {
  const text = textOf(cells).trim();
  if (text.length < 20) return false;
  return [...text].filter((ch) => ch === RULE_CHAR).length / text.length > 0.5;
}

// Rows of the prompt box: [top, bottom] rule indexes, or null when it is not on screen.
function promptBox(rows) {
  const rules = [];
  rows.forEach((cells, index) => {
    if (isRule(cells)) rules.push(index);
  });
  if (!rules.length) return null;
  const last = rules[rules.length - 1];
  // The last rule has the prompt line right under it: it is the top of the box. The bottom rule
  // was not repainted, so the prompt runs to the end. (Older rules higher up are leftovers of
  // earlier screens that must not be taken for the top of the box.)
  if (/^\s*[>❯]/.test(textOf(rows[last + 1] ?? []))) return [last, rows.length];
  // Otherwise the last two rules are the top and the bottom of the box.
  if (rules.length >= 2) return [rules[rules.length - 2], last];
  return null;
}

// rows: the visible screen, top to bottom; each row is one cell per column: [{ ch, skip? }].
// cursor: { x, y } on that screen. The draft is the prompt text *before the cursor*: whatever
// Claude Code draws after it (a hint, a suggestion) looks the same but was not said by the user.
export function extractDraft(rows, { cursor = null } = {}) {
  const box = promptBox(rows);
  if (!box) return '';
  const [top, bottom] = box;
  const cursorInBox = cursor !== null && cursor.y > top && cursor.y < bottom;
  const lastRow = cursorInBox ? cursor.y : bottom - 1;

  const lines = [];
  for (let i = top + 1; i <= lastRow; i += 1) {
    const cells = cursorInBox && i === cursor.y ? rows[i].slice(0, cursor.x) : rows[i];
    const text = textOf(cells);
    lines.push((i === top + 1 ? text.replace(/^\s*[>❯]\s?/, '') : text).trim());
  }
  const draft = lines.join(' ').replace(LEVEL_BARS, '').replace(/\s+/g, ' ').trim();
  return !cursorInBox && HINT.test(draft) ? '' : draft;
}

// { busy, reply }: is Claude working right now, and the last thing it said (not its tool calls).
export function extractStatus(rows) {
  const box = promptBox(rows);
  if (!box) return { busy: false, reply: '' };
  const above = rows.slice(0, box[0]).map((cells) => textOf(cells).trimEnd());

  const last = above.findLast((line) => line.trim() !== '') ?? '';
  const busy = SPINNER.test(last) && !/\bdone\b/.test(last);

  let reply = '';
  for (let i = above.length - 1; i >= 0 && !busy; i -= 1) {
    if (!ANSWER.test(above[i]) || TOOL_CALL.test(above[i])) continue;
    const parts = [above[i].replace(ANSWER, '')];
    for (let j = i + 1; j < above.length && /^\s{2}\S/.test(above[j]); j += 1) parts.push(above[j].trim());
    reply = parts.join(' ');
    break;
  }
  return { busy, reply };
}
