// `npm run docs:index` — writes docs/agents/api-index.md: a compact map of the public API of every
// scene module (web/src/scene/*.js) and shell module (web/src/*.js), so an agent can find the right
// function without opening a dozen files.
//
// For each file: the header comment (first paragraph, condensed), exported functions/classes with
// parameters, the API object a factory returns (methods with parameters and the comment above them),
// exported constants and the __sceneState handles the file sets. No dependencies: a small tokenizer
// blanks out comments/strings/regexes so braces can be matched safely.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'docs/agents/api-index.md');
const GROUPS = [
  { title: 'Scene (`web/src/scene/`, hot-swapped)', dir: 'web/src/scene', prefix: 'scene/' },
  { title: 'Shell (`web/src/`, editing reloads the page)', dir: 'web/src', prefix: '' },
];

const HEADER_CHARS = 330; // ~3 lines
const COMMENT_CHARS = 120;
const PARAMS_CHARS = 140;
const NESTED_MAX = 10;

// ---------------------------------------------------------------- tokenizer
// Returns { m, nc }: m — comments, strings, template text and regex bodies replaced by spaces;
// nc — only comments replaced. Both keep the length and newlines of the source.
function mask(src) {
  const n = src.length;
  const m = src.split('');
  const nc = src.split('');
  const blank = (arr, a, b) => {
    for (let k = a; k < b && k < n; k += 1) if (arr[k] !== '\n' && arr[k] !== '\r') arr[k] = ' ';
  };
  const REGEX_AFTER_WORD = new Set(['return', 'typeof', 'case', 'in', 'of', 'new', 'delete', 'void', 'throw', 'else', 'do', 'yield', 'await']);
  const REGEX_AFTER_PUNCT = '(,=:[!&|?{};+-*%<>~^';

  function scanTemplate(i) {
    while (i < n) {
      const c = src[i];
      if (c === '\\') {
        blank(m, i, i + 2);
        i += 2;
        continue;
      }
      if (c === '`') return i + 1;
      if (c === '$' && src[i + 1] === '{') {
        i = scanCode(i + 2, true) + 1;
        continue;
      }
      blank(m, i, i + 1);
      i += 1;
    }
    return n;
  }

  function scanCode(i, untilBrace) {
    let depth = 0;
    let last = ''; // last token: a punctuation char or a word
    while (i < n) {
      const c = src[i];
      const d = src[i + 1];
      if (c === '/' && d === '/') {
        let e = src.indexOf('\n', i);
        if (e < 0) e = n;
        blank(m, i, e);
        blank(nc, i, e);
        i = e;
        continue;
      }
      if (c === '/' && d === '*') {
        let e = src.indexOf('*/', i + 2);
        e = e < 0 ? n : e + 2;
        blank(m, i, e);
        blank(nc, i, e);
        i = e;
        continue;
      }
      if (c === '"' || c === "'") {
        let j = i + 1;
        while (j < n && src[j] !== c && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
        blank(m, i + 1, j);
        i = j + 1;
        last = 'x';
        continue;
      }
      if (c === '`') {
        i = scanTemplate(i + 1);
        last = 'x';
        continue;
      }
      if (c === '/' && (last === '' || REGEX_AFTER_PUNCT.includes(last) || REGEX_AFTER_WORD.has(last))) {
        let j = i + 1;
        let cls = false;
        while (j < n && src[j] !== '\n') {
          const ch = src[j];
          if (ch === '\\') {
            j += 2;
            continue;
          }
          if (ch === '[') cls = true;
          else if (ch === ']') cls = false;
          else if (ch === '/' && !cls) break;
          j += 1;
        }
        blank(m, i + 1, j);
        i = j + 1;
        while (i < n && /[a-z]/i.test(src[i])) i += 1;
        last = 'x';
        continue;
      }
      if (/[\w$]/.test(c)) {
        let j = i;
        while (j < n && /[\w$]/.test(src[j])) j += 1;
        last = src.slice(i, j);
        i = j;
        continue;
      }
      if (c === '{') depth += 1;
      else if (c === '}') {
        if (untilBrace && depth === 0) return i;
        depth -= 1;
      }
      if (!/\s/.test(c)) last = c;
      i += 1;
    }
    return n;
  }

  scanCode(0, false);
  return { m: m.join(''), nc: nc.join('') };
}

// index of the bracket that closes the one at i (any of (), [], {} — the code is balanced)
function closeOf(m, i) {
  let depth = 0;
  for (let k = i; k < m.length; k += 1) {
    const c = m[k];
    if (c === '(' || c === '[' || c === '{') depth += 1;
    else if (c === ')' || c === ']' || c === '}') {
      depth -= 1;
      if (depth === 0) return k;
    }
  }
  return m.length - 1;
}

const squash = (s) => s.replace(/\s+/g, ' ').trim();
const cut = (s, max) => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);
const lineOf = (src, i) => src.slice(0, i).split('\n').length;

// ---------------------------------------------------------------- pieces
function headerOf(src) {
  const lines = src.split(/\r?\n/);
  const out = [];
  if (lines[0]?.startsWith('/*')) {
    for (const l of lines) {
      const t = l.replace(/^\s*\/?\*+\/?/, '').replace(/\*\/\s*$/, '').trim();
      if (!t && out.length) break;
      if (t) out.push(t);
      if (l.includes('*/')) break;
    }
  } else {
    for (const l of lines) {
      if (!/^\s*\/\//.test(l)) break;
      const t = l.replace(/^\s*\/\/\s?/, '').trim();
      if (!t) {
        if (out.length) break;
        continue;
      }
      out.push(t);
    }
  }
  let text = squash(out.join(' '));
  if (text.length > HEADER_CHARS) {
    const head = text.slice(0, HEADER_CHARS);
    const stop = Math.max(head.lastIndexOf('. '), head.lastIndexOf('; '));
    text = stop > HEADER_CHARS * 0.5 ? head.slice(0, stop + 1) : cut(text, HEADER_CHARS);
  }
  return text;
}

// "the comment block right above" index i (contiguous // lines), or the trailing comment on its line
function commentAbove(src, i) {
  const before = src.slice(0, i);
  const lines = before.split('\n');
  lines.pop(); // the line where the code starts (text before it on that line is whitespace)
  const block = [];
  while (lines.length) {
    const t = lines[lines.length - 1].trim();
    if (!t.startsWith('//')) break;
    block.unshift(t.replace(/^\/\/\s?/, ''));
    lines.pop();
  }
  return squash(block.join(' '));
}

function trailingComment(src, i) {
  const e = src.indexOf('\n', i);
  const rest = src.slice(i, e < 0 ? src.length : e);
  const k = rest.indexOf('//');
  return k >= 0 ? squash(rest.slice(k + 2)) : '';
}

function paramsAt(ctx, open) {
  const close = closeOf(ctx.m, open);
  return { text: cut(squash(ctx.nc.slice(open + 1, close)), PARAMS_CHARS), close };
}

// local `function name(` / `const name = (…) =>` inside [a, b): its parameters, or null
function localParams(ctx, name, a, b) {
  const body = ctx.m.slice(a, b);
  const esc = name.replace(/\$/g, '\\$');
  let r = new RegExp(`\\bfunction\\s+${esc}\\s*\\(`).exec(body);
  if (r) return paramsAt(ctx, a + r.index + r[0].length - 1).text;
  r = new RegExp(`\\b(?:const|let)\\s+${esc}\\s*=\\s*(?:async\\s*)?(\\(|[\\w$]+\\s*=>|function\\b[^(]*\\()`).exec(body);
  if (r) {
    if (r[1].endsWith('=>')) return r[1].replace(/\s*=>$/, '');
    const open = a + r.index + r[0].length - 1;
    const p = paramsAt(ctx, open);
    if (r[1] === '(' && !/^\s*=>/.test(ctx.m.slice(p.close + 1, p.close + 6))) return null;
    return p.text;
  }
  return null;
}

// entries of the object literal opening at `open`: [{ kind: 'method'|'prop'|'spread', name, params, line, note }]
function objectEntries(ctx, open, scope, depth = 0) {
  const { m, nc, src } = ctx;
  const close = closeOf(m, open);
  const segs = [];
  let d = 0;
  let s = open + 1;
  for (let k = open + 1; k < close; k += 1) {
    const c = m[k];
    if (c === '(' || c === '[' || c === '{') d += 1;
    else if (c === ')' || c === ']' || c === '}') d -= 1;
    else if (c === ',' && d === 0) {
      segs.push([s, k]);
      s = k + 1;
    }
  }
  segs.push([s, close]);
  const out = [];
  for (const [a, b] of segs) {
    const off = m.slice(a, b).search(/\S/);
    if (off < 0) continue;
    const at = a + off;
    const code = m.slice(at, b);
    const line = lineOf(src, at);
    const note = cut(commentAbove(src, at) || trailingComment(src, b), COMMENT_CHARS);
    let r;
    if ((r = /^(get|set)\s+([\w$]+)\s*\(/.exec(code))) {
      out.push({ kind: 'prop', name: r[2], line, note });
    } else if ((r = /^(?:async\s+)?\*?\s*([\w$]+)\s*\(/.exec(code))) {
      out.push({ kind: 'method', name: r[1], params: paramsAt(ctx, at + r[0].length - 1).text, line, note });
    } else if ((r = /^([\w$]+|'[^']*'|"[^"]*")\s*:\s*/.exec(code))) {
      const name = nc.slice(at, at + r[1].length);
      const v = at + r[0].length;
      const val = m.slice(v, b);
      let q;
      if ((q = /^(?:async\s*)?\(/.exec(val))) {
        const p = paramsAt(ctx, v + q[0].length - 1);
        if (/^\s*=>/.test(m.slice(p.close + 1, p.close + 8))) out.push({ kind: 'method', name, params: p.text, line, note });
        else out.push({ kind: 'prop', name, line, note });
      } else if ((q = /^(?:async\s+)?([\w$]+)\s*=>/.exec(val))) {
        out.push({ kind: 'method', name, params: q[1], line, note });
      } else if ((q = /^(?:async\s+)?function\b[^(]*\(/.exec(val))) {
        out.push({ kind: 'method', name, params: paramsAt(ctx, v + q[0].length - 1).text, line, note });
      } else if (val[0] === '{' && depth === 0) {
        const inner = objectEntries(ctx, v, scope, 1);
        if (inner.some((e) => e.kind === 'method')) {
          out.push({ kind: 'group', name, line, note, inner });
        } else out.push({ kind: 'prop', name, line, note });
      } else if ((q = /^([\w$]+)\s*$/.exec(val)) && scope) {
        const p = localParams(ctx, q[1], scope[0], scope[1]);
        out.push(p !== null ? { kind: 'method', name, params: p, line, note } : { kind: 'prop', name, line, note });
      } else out.push({ kind: 'prop', name, line, note });
    } else if ((r = /^\.\.\.\s*([\w$.]+)/.exec(code))) {
      out.push({ kind: 'spread', name: `...${r[1]}`, line, note });
    } else if ((r = /^([\w$]+)\s*$/.exec(code))) {
      const p = scope ? localParams(ctx, r[1], scope[0], scope[1]) : null;
      out.push(p !== null ? { kind: 'method', name: r[1], params: p, line, note } : { kind: 'prop', name: r[1], line, note });
    }
  }
  return out;
}

// what the function body [open, close] returns at its top level: index of an object literal's `{` or -1
function returnedObject(ctx, open, close) {
  const { m } = ctx;
  let d = 0;
  let last = -1;
  for (let k = open + 1; k < close; k += 1) {
    const c = m[k];
    if (c === '{' || c === '(' || c === '[') d += 1;
    else if (c === '}' || c === ')' || c === ']') d -= 1;
    else if (d === 0 && c === 'r' && m.startsWith('return', k) && !/[\w$]/.test(m[k - 1]) && !/[\w$]/.test(m[k + 6])) last = k + 6;
  }
  if (last < 0) return -1;
  return resolveExpr(ctx, last, open, close, 0);
}

function resolveExpr(ctx, at, open, close, hops) {
  const { m } = ctx;
  const rest = m.slice(at, Math.min(close, at + 400));
  const off = rest.search(/\S/);
  if (off < 0 || hops > 3) return -1;
  const s = rest.slice(off);
  const base = at + off;
  if (s[0] === '{') return base;
  let r;
  // (shared.x = { … }) / (shared.x = api) / Object.freeze({ … }) / Object.assign(api, …)
  if ((r = /^\(\s*(?:[\w$.]+\s*=\s*)+/.exec(s)) || (r = /^Object\.(?:freeze|assign)\(\s*/.exec(s))) {
    return resolveExpr(ctx, base + r[0].length, open, close, hops + 1);
  }
  if ((r = /^([\w$]+)\s*(?:[;)\n]|$)/.exec(s))) {
    const decl = new RegExp(`\\b(?:const|let|var)\\s+${r[1].replace(/\$/g, '\\$')}\\s*=\\s*`).exec(m.slice(open, close));
    if (decl) return resolveExpr(ctx, open + decl.index + decl[0].length, open, close, hops + 1);
  }
  return -1;
}

// ---------------------------------------------------------------- one file
function analyze(file, rel) {
  const src = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const { m, nc } = mask(src);
  const ctx = { src, m, nc };
  const funcs = [];
  const classes = [];
  const consts = [];
  let r;

  const fnRe = /^export\s+(?:async\s+)?function\*?\s+([\w$]+)\s*\(/gm;
  while ((r = fnRe.exec(m))) {
    const p = paramsAt(ctx, r.index + r[0].length - 1);
    const bo = m.indexOf('{', p.close);
    const bc = closeOf(m, bo);
    funcs.push({ name: r[1], params: p.text, line: lineOf(src, r.index), body: [bo, bc] });
  }
  const constRe = /^export\s+(?:const|let)\s+([\w$]+)\s*=\s*/gm;
  while ((r = constRe.exec(m))) {
    const v = r.index + r[0].length;
    const val = m.slice(v, v + 300);
    let q;
    if ((q = /^(?:async\s*)?\(/.exec(val))) {
      const p = paramsAt(ctx, v + q[0].length - 1);
      const after = m.slice(p.close + 1, p.close + 10);
      if (/^\s*=>/.test(after)) {
        const ar = /^\s*=>\s*/.exec(after);
        const bs = p.close + 1 + ar[0].length;
        const body = m[bs] === '{' ? [bs, closeOf(m, bs)] : null;
        funcs.push({ name: r[1], params: p.text, line: lineOf(src, r.index), body });
        continue;
      }
    } else if ((q = /^(?:async\s+)?([\w$]+)\s*=>/.exec(val))) {
      funcs.push({ name: r[1], params: q[1], line: lineOf(src, r.index), body: null });
      continue;
    } else if ((q = /^(?:async\s+)?function\b[^(]*\(/.exec(val))) {
      const p = paramsAt(ctx, v + q[0].length - 1);
      const bo = m.indexOf('{', p.close);
      funcs.push({ name: r[1], params: p.text, line: lineOf(src, r.index), body: [bo, closeOf(m, bo)] });
      continue;
    }
    // a constant: show short literal values
    const lit = /^(-?[\d.e_]+|true|false|null|'[^'\n]{0,24}'|"[^"\n]{0,24}")\s*[;,\n]/.exec(nc.slice(v, v + 40));
    consts.push(lit ? `${r[1]}=${lit[1]}` : r[1]);
  }
  const reRe = /^export\s*\{([^}]*)\}/gm;
  while ((r = reRe.exec(m))) for (const part of r[1].split(',')) if (part.trim()) consts.push(squash(part).replace(/^.* as /, ''));

  const classRe = /^export\s+(?:default\s+)?class\s+([\w$]+)[^{]*\{/gm;
  while ((r = classRe.exec(m))) {
    const bo = r.index + r[0].length - 1;
    const bc = closeOf(m, bo);
    const methods = [];
    let d = 0;
    for (let k = bo + 1; k < bc; k += 1) {
      const c = m[k];
      if (c === '{' || c === '(' || c === '[') d += 1;
      else if (c === '}' || c === ')' || c === ']') d -= 1;
      else if (d === 0 && /[\w$#]/.test(c) && !/[\w$#.]/.test(m[k - 1])) {
        const q = /^(?:static\s+)?(?:async\s+)?(?:get\s+|set\s+)?\*?([\w$#]+)\s*\(/.exec(m.slice(k, k + 200));
        if (q) {
          const p = paramsAt(ctx, k + q[0].length - 1);
          if (!q[1].startsWith('#')) methods.push({ kind: 'method', name: q[1], params: p.text, line: lineOf(src, k), note: cut(commentAbove(src, k), COMMENT_CHARS) });
          k = closeOf(m, m.indexOf('{', p.close));
          continue;
        }
        while (k < bc && /[\w$#]/.test(m[k + 1])) k += 1;
      }
    }
    classes.push({ name: r[1], line: lineOf(src, r.index), methods });
  }

  for (const f of funcs) {
    if (!f.body) continue;
    const o = returnedObject(ctx, f.body[0], f.body[1]);
    f.apiAt = o;
    if (o >= 0) f.api = objectEntries(ctx, o, f.body);
  }

  // __sceneState handles this file sets
  const aliases = new Set(['shared']);
  const al = /\b([\w$]+)\s*=\s*\(?\s*globalThis\.__sceneState\b/g;
  while ((r = al.exec(m))) aliases.add(r[1]);
  const handles = new Map(); // name → '' | '(params)'
  const handleApis = [];
  const seen = new Set(funcs.map((f) => f.apiAt).filter((x) => x >= 0));
  const names = [...aliases].join('|');
  const setRe = new RegExp(`(?:\\b(?:${names})|__sceneState)\\??\\.([\\w$]+)\\s*(?:\\?\\?=|\\|\\|=|=(?![=>]))`, 'g');
  while ((r = setRe.exec(m))) {
    const v = r.index + r[0].length;
    if (!handles.has(r[1])) handles.set(r[1], '');
    // a function handle: shared.x = (a, b) => …
    const f = funcs.find((fn) => fn.body && fn.body[0] < r.index && r.index < fn.body[1]);
    const scope = f ? f.body : [0, m.length];
    const q = /^\s*\(/.exec(m.slice(v, v + 20));
    if (q) {
      const p = paramsAt(ctx, v + q[0].length - 1);
      if (/^\s*=>/.test(m.slice(p.close + 1, p.close + 8))) {
        if (!handles.get(r[1]) || p.text) handles.set(r[1], `(${p.text})`);
        continue;
      }
    }
    // shared.x = localFunction
    const id = /^\s*([\w$]+)\s*[;\n]/.exec(m.slice(v, v + 60));
    if (id) {
      const p = localParams(ctx, id[1], scope[0], scope[1]);
      if (p !== null) {
        handles.set(r[1], `(${p})`);
        continue;
      }
    }
    // an object handle with methods that the factory does not return itself: shared.x = api
    const o = resolveExpr(ctx, v, scope[0], scope[1], 0);
    if (o < 0 || seen.has(o)) continue;
    seen.add(o);
    const entries = objectEntries(ctx, o, scope);
    if (entries.some((e) => e.kind === 'method')) handleApis.push({ name: r[1], entries });
  }

  return {
    rel, header: headerOf(src), funcs, classes, consts, handleApis,
    handles: [...handles].map(([k, p]) => k + p), lines: src.split('\n').length,
  };
}

// ---------------------------------------------------------------- markdown
function entryLines(entries, indent, prefix = '') {
  const out = [];
  const props = [];
  for (const e of entries) {
    if (e.kind === 'method') {
      out.push(`${indent}- \`${prefix}${e.name}(${e.params})\` L${e.line}${e.note ? ` — ${e.note}` : ''}`);
    } else if (e.kind === 'group') {
      const shown = e.inner.slice(0, NESTED_MAX);
      out.push(`${indent}- \`${prefix}${e.name}.*\` L${e.line}${e.note ? ` — ${e.note}` : ''}`);
      out.push(...entryLines(shown, `${indent}  `, `${e.name}.`));
      if (e.inner.length > shown.length) out.push(`${indent}  - … ${e.inner.length - shown.length} more`);
    } else props.push(prefix + e.name);
  }
  if (props.length) out.push(`${indent}- fields: ${props.map((p) => `\`${p}\``).join(', ')}`);
  return out;
}

function fileSection(a) {
  const out = [`### ${a.rel} (${a.lines})`];
  if (a.header) out.push(a.header);
  for (const f of a.funcs) {
    const api = f.api ?? [];
    const hasMethods = api.some((e) => e.kind === 'method' || e.kind === 'group');
    if (api.length && !hasMethods) {
      out.push(`- \`${f.name}(${f.params})\` L${f.line} → { ${api.map((e) => e.name).join(', ')} }`);
    } else if (hasMethods) {
      out.push(`- \`${f.name}(${f.params})\` L${f.line} → API:`);
      out.push(...entryLines(api, '  '));
    } else out.push(`- \`${f.name}(${f.params})\` L${f.line}`);
  }
  for (const c of a.classes) {
    out.push(`- class \`${c.name}\` L${c.line}:`);
    out.push(...entryLines(c.methods, '  '));
  }
  for (const h of a.handleApis) {
    out.push(`- \`__sceneState.${h.name}\` → API:`);
    out.push(...entryLines(h.entries, '  '));
  }
  if (a.consts.length) out.push(`- consts: ${a.consts.map((c) => `\`${c}\``).join(', ')}`);
  if (a.handles.length) out.push(`- sets __sceneState: ${a.handles.map((h) => `\`${h}\``).join(', ')}`);
  return out.join('\n');
}

const parts = [
  '# API index (generated)',
  '',
  'Generated by `npm run docs:index` (`scripts/gen-api-index.mjs`) — do not edit by hand; re-run after',
  'changing exports. Per file: header comment (condensed), exported functions with parameters, the API',
  'object a factory returns (`→ API:` methods, `L` = line), exported consts, and the `__sceneState`',
  'handles the file sets (`shared.x = …`). Read this first, then open only the files (and lines) you need.',
  '',
];
for (const g of GROUPS) {
  const dir = path.join(ROOT, g.dir);
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js')).sort();
  parts.push(`## ${g.title}`, '');
  for (const f of files) parts.push(fileSection(analyze(path.join(dir, f), g.prefix + f)), '');
}
const text = `${parts.join('\n').trimEnd()}\n`;
fs.writeFileSync(OUT, text);
console.log(`${path.relative(ROOT, OUT)}: ${text.split('\n').length - 1} lines`);
