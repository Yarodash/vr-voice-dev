// Remote console: lets tools on the PC run JavaScript on this page (in the headset) and read
// its console output. Requests arrive only over the bridge WebSocket; see `npm run vr:eval`.

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
const CUT = '… (обрезано)';
const MAX_ITEMS = 50;
const MAX_KEYS = 30;

const round = (n) => (Number.isFinite(n) ? Number(n.toFixed(4)) : n);

function format(value, depth, seen) {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'undefined':
      return 'undefined';
    case 'string':
      return JSON.stringify(value);
    case 'function':
      return `[Function ${value.name || 'anonymous'}]`;
    case 'symbol':
    case 'bigint':
    case 'number':
    case 'boolean':
      return String(typeof value === 'number' ? round(value) : value);
    default:
  }
  if (value instanceof Error) return `${value.name}: ${value.message}`;

  // three.js: a short summary reads better than thousands of matrix elements
  if (value.isVector2 || value.isVector3 || value.isVector4 || value.isQuaternion) {
    const parts = ['x', 'y', 'z', 'w'].filter((k) => k in value).map((k) => round(value[k]));
    return `${value.constructor.name}(${parts.join(', ')})`;
  }
  if (value.isEuler) return `Euler(${round(value.x)}, ${round(value.y)}, ${round(value.z)}, ${value.order})`;
  if (value.isColor) return `Color(#${value.getHexString()})`;
  if (value.isObject3D) {
    const { x, y, z } = value.position;
    const name = value.name ? ` "${value.name}"` : '';
    return `${value.type}${name} {position: (${round(x)}, ${round(y)}, ${round(z)}), children: ${value.children.length}, visible: ${value.visible}}`;
  }
  if (value.isBufferGeometry || value.isMaterial || value.isTexture) return `[${value.type || value.constructor.name}]`;

  if (seen.has(value)) return '[Circular]';
  const isList = Array.isArray(value) || ArrayBuffer.isView(value);
  if (depth <= 0) return isList ? `[Array(${value.length})]` : `[${value.constructor?.name ?? 'Object'}]`;

  seen.add(value);
  try {
    if (isList) {
      const items = Array.from(value.slice(0, MAX_ITEMS), (item) => format(item, depth - 1, seen));
      if (value.length > MAX_ITEMS) items.push(`… +${value.length - MAX_ITEMS}`);
      return `[${items.join(', ')}]`;
    }
    if (value instanceof Map || value instanceof Set) {
      return `${value.constructor.name}(${value.size}) ${format([...value], depth, seen)}`;
    }
    const keys = Object.keys(value);
    const fields = keys.slice(0, MAX_KEYS).map((key) => `${key}: ${format(value[key], depth - 1, seen)}`);
    if (keys.length > MAX_KEYS) fields.push(`… +${keys.length - MAX_KEYS}`);
    const type = value.constructor?.name;
    return `${type && type !== 'Object' ? `${type} ` : ''}{${fields.join(', ')}}`;
  } finally {
    seen.delete(value);
  }
}

// A one-line, bounded description of any value, roughly what a browser console would print.
export function describeValue(value, { depth = 3, maxLength = 4000 } = {}) {
  let text;
  try {
    text = format(value, depth, new Set());
  } catch (err) {
    text = `[не удалось показать значение: ${err.message}]`;
  }
  return text.length > maxLength ? text.slice(0, maxLength) + CUT : text;
}

// Runs code like a console line: an expression gives its value; statements need a `return`.
// `await` works in both. The names in `scope` are visible as variables.
export async function runSnippet(code, scope) {
  const names = Object.keys(scope);
  let fn;
  try {
    fn = new AsyncFunction(...names, `return (${code}\n);`);
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    fn = new AsyncFunction(...names, code);
  }
  return fn(...Object.values(scope));
}

export function createRemoteConsole({ send, isConnected, scope, now = Date.now, limitPerSecond = 40 }) {
  const backlog = []; // console output produced while the bridge is not connected
  let windowStart = 0;
  let sentInWindow = 0;
  let dropped = 0;

  function emit(level, text) {
    const message = { t: 'console', level, text };
    if (isConnected()) send(message);
    else if (backlog.length < 200) backlog.push(message);
  }

  function forward(level, args) {
    const t = now();
    if (t - windowStart >= 1000) {
      windowStart = t;
      sentInWindow = 0;
      if (dropped > 0) {
        emit('warn', `… пропущено сообщений консоли: ${dropped}`);
        dropped = 0;
      }
    }
    if (sentInWindow >= limitPerSecond) {
      dropped += 1;
      return;
    }
    sentInWindow += 1;
    const text = args
      .map((arg) => (typeof arg === 'string' ? arg : describeValue(arg, { depth: 2, maxLength: 1000 })))
      .join(' ');
    emit(level, text);
  }

  return {
    // Handles {"t":"eval","id","code"} from the bridge.
    async run({ id, code }) {
      try {
        const value = await runSnippet(code, scope());
        if (typeof value?.file?.base64 === 'string') {
            // e.g. a screenshot: the bridge saves the file and answers with its path
          send({ t: 'eval-result', id, ok: true, value: String(value.note ?? 'файл'), file: value.file });
        } else {
          send({ t: 'eval-result', id, ok: true, value: describeValue(value) });
        }
      } catch (err) {
        const where = err?.stack?.split('\n').slice(1, 3).join('\n') ?? '';
        send({ t: 'eval-result', id, ok: false, error: `${describeValue(err)}${where ? `\n${where}` : ''}` });
      }
    },

    // Mirrors console.* (and, in a browser, uncaught errors) to the bridge. The original
    // console keeps working, so the headset's own devtools still see everything.
    hookConsole(target = console, events = globalThis) {
      for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
        const original = target[level].bind(target);
        target[level] = (...args) => {
          original(...args);
          try {
            forward(level, args);
          } catch {
            // never let logging break the page
          }
        };
      }
      events.addEventListener?.('error', (event) => {
        forward('error', [`Uncaught ${event.message} (${event.filename}:${event.lineno})`]);
      });
      events.addEventListener?.('unhandledrejection', (event) => {
        forward('error', ['Unhandled rejection:', event.reason]);
      });
    },

    flush() {
      while (backlog.length && isConnected()) send(backlog.shift());
    },
  };
}
