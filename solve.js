// A fast drop-in for makefun-site 1.0.0: the same build, byte for byte, done quicker.
// run(input) returns the output tree { path -> text } for one site's input.
// Strategy: templates are compiled once per case into flat op lists (no node-tree
// walk per render, output gathered in an array and joined once); Markdown and front
// matter are scanned by hand instead of by regex per line; inline HTML is built in
// chunks; slug results are cached per case. All caches live inside run(), so every
// call is self-contained and deterministic.

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/g;
const ESC_TEST = /[&<>"']/;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const RESERVED = ['posts', 'tags', 'page'];
const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const WS_RE = /\s/;
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);
const MARK_RE = /\p{M}/gu;

function escapeHtml(text) {
  if (!ESC_TEST.test(text)) return text;
  return text.replace(ESC_RE, (c) => ESCAPES[c]);
}

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  return `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
}

/**
 * The slug of `text`. Pure-ASCII text skips normalisation (NFKD is the identity
 * there and ASCII holds no combining marks); anything else goes the full route.
 */
function slugify(text) {
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) >= 128) { ascii = false; break; }
  }
  const plain = ascii ? text : text.normalize('NFKD').replace(MARK_RE, '');
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const code = plain.charCodeAt(i);
    let keep = null;
    if (code >= 65 && code <= 90) keep = plain[i].toLowerCase();
    else if ((code >= 97 && code <= 122) || (code >= 48 && code <= 57)) keep = plain[i];
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, 64).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

function slugCached(cache, text) {
  let v = cache.get(text);
  if (v === undefined) {
    v = slugify(text);
    cache.set(text, v);
  }
  return v;
}

/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** `rel` from directory `dir`, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

// ---------------------------------------------------------------- front matter

const KEY_SET = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);
const NAME_RE = /^[a-z0-9-]+$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG_RE = /^[^"[\]]+$/;

function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return line.slice(a, b);
}

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: quoted with only \" and \\ escapes, or bare. */
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      let ok = raw.length === 10 && raw.charCodeAt(4) === 45 && raw.charCodeAt(7) === 45;
      let y = 0, mo = 0, d = 0;
      if (ok) {
        for (let i = 0; i < 10; i++) {
          if (i === 4 || i === 7) continue;
          const c = raw.charCodeAt(i);
          if (c < 48 || c > 57) { ok = false; break; }
        }
      }
      if (ok) {
        y = Number(raw.slice(0, 4));
        mo = Number(raw.slice(5, 7));
        d = Number(raw.slice(8, 10));
      }
      if (!ok || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !TAG_RE.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return NAME_RE.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return SLUG_RE.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body lines: { data, bodyLines }, or { error } with the
 * first reason it is refused. `lines` is the source text split on "\n".
 */
function parseFrontMatter(lines) {
  if (lines.length === 0 || lines[0] !== '---') return { error: 'no front matter' };
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') { close = i; break; }
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let i = 1; i < close; i++) {
    const line = lines[i];
    if (isBlank(line)) continue;
    if (line.charCodeAt(0) === 35) continue; // comment: '#' first
    let k = 0;
    while (k < line.length) {
      const c = line.charCodeAt(k);
      if ((c >= 97 && c <= 122) || c === 95) k++;
      else break;
    }
    if (k === 0 || line.charCodeAt(k) !== 58) return { error: `line ${i + 1} is not "key: value"` };
    const key = line.slice(0, k);
    let raw;
    if (k + 1 === line.length) raw = '';
    else if (line.charCodeAt(k + 1) === 32) raw = line.slice(k + 2);
    else return { error: `line ${i + 1} is not "key: value"` };
    let e = raw.length;
    while (e > 0 && (raw.charCodeAt(e - 1) === 32 || raw.charCodeAt(e - 1) === 9)) e--;
    if (e < raw.length) raw = raw.slice(0, e);
    if (!KEY_SET.has(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, bodyLines: lines.slice(close + 1) };
}

// ---------------------------------------------------------------- Markdown

/** Fence opener: the language, or null. A fence closer is "```" plus spaces/tabs. */
function fenceLang(line) {
  if (!line.startsWith('```')) return null;
  let j = 3;
  while (j < line.length) {
    const c = line.charCodeAt(j);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) j++;
    else break;
  }
  for (let k = j; k < line.length; k++) {
    const c = line.charCodeAt(k);
    if (c !== 32 && c !== 9) return null;
  }
  return line.slice(3, j);
}

function isFenceClose(line) {
  if (!line.startsWith('```')) return false;
  for (let k = 3; k < line.length; k++) {
    const c = line.charCodeAt(k);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  let h = 0;
  while (h < line.length && line.charCodeAt(h) === 35) h++;
  if (h === 0 || h > 6) return null;
  if (h >= line.length) return null;
  const c = line.charCodeAt(h);
  if (c !== 32 && c !== 9) return null;
  let s = h;
  while (s < line.length && (line.charCodeAt(s) === 32 || line.charCodeAt(s) === 9)) s++;
  let e = line.length;
  while (e > s && (line.charCodeAt(e - 1) === 32 || line.charCodeAt(e - 1) === 9)) e--;
  if (e <= s) return null;
  return { depth: h, text: line.slice(s, e) };
}

function isHr(line) {
  if (line.length < 3) return false;
  const p = line.slice(0, 3);
  if (p !== '---' && p !== '***') return false;
  for (let k = 3; k < line.length; k++) {
    const c = line.charCodeAt(k);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** Whether `line` ends a paragraph: blank, fence, heading or thematic break.
 * Only the first character can start one of those, so dispatch on it. */
function endsParagraph(line) {
  if (line.length === 0) return true;
  const c = line.charCodeAt(0);
  if (c === 32 || c === 9) return isBlank(line); // a spaced line ends one only by being blank
  if (c === 96) return fenceLang(line) !== null;
  if (c === 35) return headingOf(line) !== null;
  if (c === 45 || c === 42) return isHr(line);
  return false;
}

/**
 * A list opener: { ordered, start, text } or null. Ordered markers carry at most
 * 9 digits, and a bullet line is tried before an ordered one.
 */
function listOpen(line) {
  const c0 = line.charCodeAt(0);
  if ((c0 === 45 || c0 === 42) && line.charCodeAt(1) === 32) return { ordered: false, start: 1, text: line.slice(2) };
  let j = 0;
  while (j < line.length && line.charCodeAt(j) >= 48 && line.charCodeAt(j) <= 57) j++;
  if (j === 0 || j > 9) return null;
  if (line.charCodeAt(j) !== 46 || line.charCodeAt(j + 1) !== 32) return null;
  return { ordered: true, start: Number(line.slice(0, j)), text: line.slice(j + 2) };
}

const CONTINUED_RE = /^ {2,}\S/;

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  for (let j = from; j <= s.length - what.length; j++) {
    if (s[j] === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (c !== '*') continue;
    if (s[j + 1] === '*') {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/**
 * `s` rendered inline; `link(target)` resolves a link's href. Plain runs are
 * escaped in whole chunks, found by a native scan instead of a per-character loop.
 * The scan regex is fresh per call, so the recursion below cannot disturb it.
 */
function inlineStr(s, link) {
  const out = [];
  const re = /[\\`*\[]/g;
  let i = 0;
  let ps = 0;
  const n = s.length;
  const flush = (to) => { if (to > ps) out.push(escapeHtml(s.slice(ps, to))); };
  while (i < n) {
    re.lastIndex = i;
    const m = re.exec(s);
    if (m === null) break;
    const j = m.index;
    const c = s[j];
    if (c === '\\' && j + 1 < n && ESCAPABLE.has(s[j + 1])) {
      flush(j);
      out.push(escapeHtml(s[j + 1]));
      i = j + 2;
      ps = i;
      continue;
    }
    if (c === '`') {
      const k = s.indexOf('`', j + 1);
      if (k > j + 1) {
        flush(j);
        out.push('<code>', escapeHtml(s.slice(j + 1, k)), '</code>');
        i = k + 1;
        ps = i;
      } else i = j + 1;
      continue;
    }
    if (c === '*') {
      if (s[j + 1] === '*') {
        const k = findUnescaped(s, '**', j + 2);
        if (k > j + 2) {
          flush(j);
          out.push('<strong>', inlineStr(s.slice(j + 2, k), link), '</strong>');
          i = k + 2;
          ps = i;
        } else i = j + 2;
        continue;
      }
      const k = findSingleStar(s, j + 1);
      if (k > j + 1) {
        flush(j);
        out.push('<em>', inlineStr(s.slice(j + 1, k), link), '</em>');
        i = k + 1;
        ps = i;
      } else i = j + 1;
      continue;
    }
    if (c === '[') {
      const k = findUnescaped(s, ']', j + 1);
      const m = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
      const target = m === -1 ? '' : s.slice(k + 2, m);
      if (target !== '' && !WS_RE.test(target)) {
        flush(j);
        out.push('<a href="', escapeHtml(link(target)), '">', inlineStr(s.slice(j + 1, k), link), '</a>');
        i = m + 1;
        ps = i;
        continue;
      }
      i = j + 1;
      continue;
    }
    i = j + 1; // a '\' before a character it does not escape: plain text
  }
  flush(n);
  return out.join('');
}

/** `lines` rendered: HTML, table of contents, and first paragraph's inline HTML. */
function renderMarkdown(lines, link, slugCache) {
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    if (isBlank(line)) { i++; continue; }
    const lang = fenceLang(line);
    if (lang !== null) {
      const body = [];
      i++;
      while (i < n && !isFenceClose(lines[i])) body.push(lines[i++]);
      i++;
      const cls = lang === '' ? '' : ` class="language-${escapeHtml(lang)}"`;
      const joined = body.length === 0 ? '' : `${body.join('\n')}\n`;
      blocks.push(`<pre><code${cls}>${escapeHtml(joined)}</code></pre>`);
      continue;
    }
    const heading = headingOf(line);
    if (heading !== null) {
      const id = uniqueSlug(slugCached(slugCache, heading.text), ids);
      const html = inlineStr(heading.text, link);
      blocks.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>`);
      if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
      i++;
      continue;
    }
    if (isHr(line)) { blocks.push('<hr>'); i++; continue; }
    if (line.charCodeAt(0) === 62) {
      const body = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        const l = lines[i++];
        body.push(l.length > 1 && l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1));
      }
      const inner = [];
      for (const l of body) {
        const t = trimLine(l);
        if (t !== '') inner.push(t);
      }
      blocks.push(inner.length === 0 ? '<blockquote>\n</blockquote>' : `<blockquote>\n<p>${inlineStr(inner.join('\n'), link)}</p>\n</blockquote>`);
      continue;
    }
    const first = listOpen(line);
    if (first !== null) {
      const ordered = first.ordered;
      const items = [];
      while (i < n) {
        const m = listOpen(lines[i]);
        if (m !== null && m.ordered === ordered) {
          items.push([trimLine(m.text)]);
          i++;
        } else if (CONTINUED_RE.test(lines[i])) {
          items[items.length - 1].push(trimLine(lines[i]));
          i++;
        } else break;
      }
      const tag = ordered ? 'ol' : 'ul';
      const open = ordered && first.start !== 1 ? `<ol start="${first.start}">` : `<${tag}>`;
      let list = `${open}\n`;
      for (const parts of items) list += `<li>${inlineStr(parts.join('\n'), link)}</li>\n`;
      blocks.push(`${list}</${tag}>`);
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const html = inlineStr(body.join('\n'), link);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>`);
  }
  let html = '';
  for (const b of blocks) html += `${b}\n`;
  return { html, toc, excerpt: excerpt ?? '' };
}

const WORD_SPLIT_RE = /\s+/;

/** The words of body lines: runs of characters other than whitespace. */
function wordsOfLines(lines) {
  const text = lines.join('\n');
  if (text === '') return 0;
  let n = text.split(WORD_SPLIT_RE).length;
  if (/\s/.test(text[0])) n--;
  if (/\s/.test(text[text.length - 1])) n--;
  return n;
}

// ---------------------------------------------------------------- templates

const INCLUDE_DEPTH = 8;
const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/**
 * `src` compiled into a flat op list. A for/if op carries the index of its closing
 * marker (`end`) and an if also its else marker (`els`, -1 when there is none), so
 * rendering jumps over whole branches instead of walking a tree.
 */
function compileTemplate(name, src) {
  const ops = [];
  const stack = [];
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') ops.push({ op: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') ops.push({ op: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const idx = ops.length;
        ops.push({ op: 'for', name: m[1], path: pathOf(name, m[2]), end: -1 });
        stack.push({ kind: 'for', idx });
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const idx = ops.length;
        ops.push({ op: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), els: -1, end: -1 });
        stack.push({ kind: 'if', idx });
      } else if (tag === 'else') {
        const top = stack[stack.length - 1];
        if (top === undefined || top.kind !== 'if' || ops[top.idx].els !== -1) throw new TemplateError(`template "${name}": an else outside an if`);
        ops[top.idx].els = ops.length;
        ops.push({ op: 'else' });
      } else if (tag === 'endfor' || tag === 'endif') {
        const top = stack[stack.length - 1];
        const want = tag === 'endfor' ? 'for' : 'if';
        if (top === undefined || top.kind !== want) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        ops[top.idx].end = ops.length;
        stack.pop();
        ops.push({ op: tag });
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) ops.push({ op: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 0) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return ops;
}

/** The value at `path`: first name from the nearest frame holding it, then own properties. */
function lookup(frames, path) {
  const first = path[0];
  let v;
  let found = false;
  for (let k = frames.length - 1; k >= 0; k--) {
    if (Object.hasOwn(frames[k], first)) { v = frames[k][first]; found = true; break; }
  }
  if (!found) return undefined;
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** An own property of an object, or undefined (a single path step). */
function ownVal(o, k) {
  return (o !== null && typeof o === 'object' && Object.hasOwn(o, k)) ? o[k] : undefined;
}

/** A value as text: string itself, a number's digits, true/false, array items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) {
    let s = '';
    for (let k = 0; k < v.length; k++) {
      if (k > 0) s += ', ';
      s += textOf(v[k]);
    }
    return s;
  }
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** Ops `start..end` rendered into `out`, `frames` innermost last. */
function renderOps(ops, start, end, frames, templates, depth, out) {
  let i = start;
  while (i < end) {
    const n = ops[i];
    switch (n.op) {
      case 'text':
        out.push(n.text);
        i++;
        break;
      case 'var':
        out.push(escapeHtml(textOf(lookup(frames, n.path))));
        i++;
        break;
      case 'raw':
        out.push(textOf(lookup(frames, n.path)));
        i++;
        break;
      case 'if': {
        const take = truthy(lookup(frames, n.path)) !== n.not;
        if (take) renderOps(ops, i + 1, n.els === -1 ? n.end : n.els, frames, templates, depth, out);
        else if (n.els !== -1) renderOps(ops, n.els + 1, n.end, frames, templates, depth, out);
        i = n.end + 1;
        break;
      }
      case 'for': {
        const xs = lookup(frames, n.path);
        if (Array.isArray(xs)) {
          const len = xs.length;
          for (let k = 0; k < len; k++) {
            const frame = {};
            frame[n.name] = xs[k];
            frame.loop = { index: k + 1, first: k === 0, last: k === len - 1, length: len };
            frames.push(frame);
            renderOps(ops, i + 1, n.end, frames, templates, depth, out);
            frames.pop();
          }
        }
        i = n.end + 1;
        break;
      }
      case 'include': {
        const t = templates.get(n.name);
        if (t !== undefined && depth < INCLUDE_DEPTH) renderOps(t, 0, t.length, frames, templates, depth + 1, out);
        i++;
        break;
      }
      default: // else / endfor / endif markers: reached only by jumping over them
        i++;
        break;
    }
  }
}

// ---------------------------------------------------------------- template codegen
//
// A compiled template can also be turned into a plain JS function: loop variables
// become locals (fresh ids, so a template's own names can never collide with the
// generated ones), root names are read once per render, paths become ownVal()
// steps, and includes are expanded inline at their static depth (an include at
// depth 8 renders nothing, as the interpreter does). Anything the compiler cannot
// prove small stays on the interpreter above, so this is only a speed path.

function emitPath(ctx, path, binders) {
  const first = path[0];
  let id = null;
  for (let k = binders.length - 1; k >= 0; k--) {
    if (binders[k].name === first) { id = binders[k].id; break; }
  }
  let expr;
  if (id !== null) expr = id;
  else {
    if (!ctx.roots.has(first)) ctx.roots.set(first, `__r${ctx.roots.size}`);
    expr = ctx.roots.get(first);
  }
  for (let k = 1; k < path.length; k++) expr = `__g(${expr},${JSON.stringify(path[k])})`;
  return expr;
}

function emitRange(ctx, ops, start, end, templates, binders, depth) {
  for (let i = start; i < end; i++) {
    if (++ctx.budget > 6000) throw new Error('template too big to compile');
    const n = ops[i];
    switch (n.op) {
      case 'text':
        ctx.parts.push(`__o+=${JSON.stringify(n.text)};`);
        break;
      case 'var':
        ctx.parts.push(`__o+=__e(__t(${emitPath(ctx, n.path, binders)}));`);
        break;
      case 'raw':
        ctx.parts.push(`__o+=__t(${emitPath(ctx, n.path, binders)});`);
        break;
      case 'if': {
        const cond = `__b(${emitPath(ctx, n.path, binders)})`;
        ctx.parts.push(n.not ? `if(!${cond}){` : `if(${cond}){`);
        emitRange(ctx, ops, i + 1, n.els === -1 ? n.end : n.els, templates, binders, depth);
        if (n.els !== -1) {
          ctx.parts.push('}else{');
          emitRange(ctx, ops, n.els + 1, n.end, templates, binders, depth);
        }
        ctx.parts.push('}');
        i = n.end;
        break;
      }
      case 'for': {
        const xsId = `__x${ctx.counter++}`;
        const kId = `__k${ctx.counter++}`;
        const lenId = `__l${ctx.counter++}`;
        const varId = `__v${ctx.counter++}`;
        const loopId = `__p${ctx.counter++}`;
        ctx.parts.push(`{const ${xsId}=${emitPath(ctx, n.path, binders)};if(Array.isArray(${xsId})){const ${lenId}=${xsId}.length;for(let ${kId}=0;${kId}<${lenId};${kId}++){const ${varId}=${xsId}[${kId}];const ${loopId}={index:${kId}+1,first:${kId}===0,last:${kId}===${lenId}-1,length:${lenId}};`);
        binders.push({ name: n.name, id: varId }, { name: 'loop', id: loopId });
        emitRange(ctx, ops, i + 1, n.end, templates, binders, depth);
        binders.pop();
        binders.pop();
        ctx.parts.push('}}}');
        i = n.end;
        break;
      }
      case 'include': {
        if (depth < INCLUDE_DEPTH) {
          const t = templates.get(n.name);
          if (t !== undefined) emitRange(ctx, t, 0, t.length, templates, binders, depth + 1);
        }
        break;
      }
      default: // else / endfor / endif markers: jumped over, never emitted
        break;
    }
  }
}

/** A template's ops as a JS function (root frame in, page string out), or null. */
function tryCodegen(ops, templates) {
  try {
    const ctx = { parts: [], roots: new Map(), counter: 0, budget: 0 };
    emitRange(ctx, ops, 0, ops.length, templates, [], 0);
    let prologue = '';
    for (const [name, id] of ctx.roots) prologue += `const ${id}=__g(__r,${JSON.stringify(name)});`;
    return new Function('__g', '__t', '__e', '__b', '__r', `${prologue}let __o='';${ctx.parts.join('')}return __o;`);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- the build

/** One site's output tree: path -> text. */
export function run(input) {
  const slugCache = new Map();
  const report = [];

  // Templates, parsed in code-unit order of name; one that does not parse is reported and left out.
  const templates = new Map();
  for (const name of Object.keys(input.templates).sort()) {
    try {
      templates.set(name, compileTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }

  const base = input.site.base_url.replace(/\/+$/, '');

  // Sources, in code-unit order of path; .md is a source, anything else static.
  const files = [...input.files].sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, lines: f.content.replace(/\r\n?/g, '\n').split('\n') });
    else statics.push(f);
  }

  // Front matter: a refused source is reported and dropped, and so is a draft.
  // Checks run in order: front-matter error, tags//page/ dir, post without date,
  // layout not a parsing template, then draft; the first failure is reported.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.lines);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.bodyLines = fm.bodyLines;
    s.post = s.path.startsWith('posts/');
    let own = null;
    if (s.path.startsWith('tags/')) own = 'tags';
    else if (s.path.startsWith('page/')) own = 'page';
    if (own !== null) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // Permalinks: each page's slug made unique in its directory, in source order.
  const taken = new Map();
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    const slug = uniqueSlug(s.data.slug ?? slugCached(slugCache, s.data.title), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // Markdown, its links resolved to the pages and static files they name.
  // Link targets repeat across sources, so resolved hrefs are cached per case.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  const linkCache = new Map();
  for (const s of kept) {
    const dir = dirOf(s.path);
    const link = (target) => {
      if (SCHEME_RE.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
      const key = `${dir}\n${target}`;
      let href = linkCache.get(key);
      if (href === undefined) {
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null && bySource.has(path)) href = `${bySource.get(path).url}${frag}`;
        else if (path !== null && staticPaths.has(path)) href = `${base}/${path}${frag}`;
        else href = target;
        linkCache.set(key, href);
      }
      if (href === target) broken.add(`broken-link ${s.path} -> ${target}`);
      return href;
    };
    const md = renderMarkdown(s.bodyLines, link, slugCache);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
    s.words = wordsOfLines(s.bodyLines);
  }

  // Collections: posts newest first, ties by slug; each post's neighbours.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => (y.data.date < x.data.date ? -1 : y.data.date > x.data.date ? 1 : 0) ||
    (x.slug < y.slug ? -1 : x.slug > y.slug ? 1 : 0));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // Tags: grouped by slug, each named as first met in the posts' order, ordered by count then slug.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugCached(slugCache, name);
      if (!seen.has(slug)) {
        seen.add(slug);
        out.push({ name, slug });
      }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const { name, slug } of ownTags(p)) {
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (!s.post) s.tagRefs = ownTags(s).map(({ name, slug }) => bySlug.get(slug) ?? { name, slug, url: '', posts: [] });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length ||
    (x.slug < y.slug ? -1 : x.slug > y.slug ? 1 : 0));

  // A post's card, as lists show it; a page as its layout reads it.
  const cardCache = new Map();
  const cardOf = (s) => {
    let c = cardCache.get(s);
    if (c === undefined) {
      c = {
        title: s.data.title,
        url: s.url,
        date: s.data.date ?? '',
        date_long: s.data.date === undefined ? '' : longDate(s.data.date),
        summary: s.data.summary ?? '',
        excerpt: s.excerpt,
        reading_minutes: Math.max(1, Math.ceil(s.words / 200)),
        tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
      };
      cardCache.set(s, c);
    }
    return c;
  };
  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });
  const pageOf = (s) => {
    if (s.tocView === undefined) s.tocView = s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html }));
    return {
      ...cardOf(s),
      slug: s.slug,
      content: s.html,
      toc: s.tocView,
      newer: linkOf(s.newer ?? null),
      older: linkOf(s.older ?? null),
      is_post: s.post,
    };
  };

  // Layouts: every page through its layout, the index pages and the tag pages through theirs.
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cardOf(p));
  const output = {};
  // One root frame, reused for every render: each render assigns exactly the
  // keys it binds (the rest stay undefined, which reads as absent).
  const rootFrame = { site, tags: allTags, recent, page: undefined, posts: undefined, pager: undefined, tag: undefined };
  const frames = [rootFrame];
  const outBuf = [];
  // Compiled template functions where the compiler succeeded; the interpreter
  // above stays the fallback for anything it did not take.
  const fns = new Map();
  for (const [name, ops] of templates) {
    const fn = tryCodegen(ops, templates);
    if (fn !== null) fns.set(name, fn);
  }
  const render = (name, vars) => {
    rootFrame.page = vars.page;
    rootFrame.posts = vars.posts;
    rootFrame.pager = vars.pager;
    rootFrame.tag = vars.tag;
    outBuf.length = 0;
    const fn = fns.get(name);
    if (fn !== undefined) return fn(ownVal, textOf, escapeHtml, truthy, rootFrame);
    const ops = templates.get(name);
    if (ops === undefined) return null;
    renderOps(ops, 0, ops.length, frames, templates, 0, outBuf);
    return outBuf.join('');
  };
  for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cardOf(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cardOf(p)) } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // The report: every refusal, draft, broken link and template that did not parse, sorted, then the counts.
  const lines = [...report, ...broken].sort();
  const pageCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
