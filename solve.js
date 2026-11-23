// A fast drop-in for makefun-site 1.0.0.
//
// run(input) returns exactly the output tree makefun-site 1.0.0's build returns
// for the same input: every path it writes and that file's text, byte for byte.
// It is written from the reference's rules (its README and code): the same
// front matter, template dialect, Markdown subset, slug rule and report, only
// executed faster -- a single-pass Markdown renderer that copies plain runs
// instead of escaping character by character, an ASCII fast path for slugs,
// and templates compiled to plain functions (with a tree-walking renderer kept
// as a fallback if compilation ever fails). No dependency, no clock, no
// environment, no randomness, no file: the answer is a function of the input
// alone, and each case is answered alone.

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** The report file every build writes. */
export const REPORT_FILE = 'build-report.txt';

/** The top-level directories the generator writes itself. */
export const RESERVED = Object.freeze(['posts', 'tags', 'page']);

// ---------------------------------------------------------------- text

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/g;

/** `text` with & < > " and ' escaped. One regex pass; strings with no special character come back untouched. */
export function escapeHtml(text) {
  let out = '';
  let last = 0;
  let m;
  ESC_RE.lastIndex = 0;
  while ((m = ESC_RE.exec(text)) !== null) {
    out += text.slice(last, m.index) + ESC[m[0]];
    last = m.index + 1;
  }
  if (last === 0) return text;
  return out + text.slice(last);
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone: "2026-11-09" is "9 November 2026". */
export function longDate(date) {
  const m = (date.charCodeAt(5) - 48) * 10 + (date.charCodeAt(6) - 48);
  const d = (date.charCodeAt(8) - 48) * 10 + (date.charCodeAt(9) - 48);
  return `${d} ${MONTHS[m - 1]} ${date.slice(0, 4)}`;
}

/** The words of a body: its runs of characters other than whitespace. Counted by hand: the regex match allocates an array of every word. */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 32 || (c >= 9 && c <= 13)) {
      inWord = false;
      continue;
    }
    if (c > 127) {
      if (c === 160 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff) {
        inWord = false;
        continue;
      }
    }
    if (!inWord) {
      inWord = true;
      n++;
    }
  }
  return n;
}

/** `rel` (a link's path, "/"-separated) from the directory `dir` of a source, or null when it climbs out of the root. */
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

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

// ---------------------------------------------------------------- slugs

/** The most characters a slug keeps before a collision suffix. */
export const SLUG_MAX = 64;

/** Slugs already computed in this run (a pure memo: same text, same slug). Cleared for every case. */
const slugCache = new Map();

/**
 * The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every run
 * of characters other than a-z and 0-9 one "-", none at either end, at most 64
 * characters (a "-" left at the cut dropped), and "untitled" when nothing is left.
 * Pure ASCII text cannot change under NFKD and holds no combining marks, so it
 * takes the short path; anything else goes through the full normalisation.
 */
export function slugify(text) {
  const hit = slugCache.get(text);
  if (hit !== undefined) return hit;
  let out = '';
  let gap = false;
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) { ascii = false; break; }
  }
  if (ascii) {
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      let keep = null;
      if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
      else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
      if (keep === null) {
        gap = out.length > 0;
        continue;
      }
      if (gap) out += '-';
      gap = false;
      out += keep;
    }
  } else {
    const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
    for (const ch of plain) {
      let keep = null;
      if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
      else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
      if (keep === null) {
        gap = out.length > 0;
        continue;
      }
      if (gap) out += '-';
      gap = false;
      out += keep;
    }
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  const slug = out === '' ? 'untitled' : out;
  if (slugCache.size < 100000) slugCache.set(text, slug);
  return slug;
}

/** `slug` made unique against `taken` (and added to it): the first of slug, slug-2, slug-3 ... not taken. */
export function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

// ---------------------------------------------------------------- front matter

/** The keys a source's front matter may give. */
const KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function isDigit(c) {
  return c >= 48 && c <= 57;
}

/** A string value: "..." with \" and \\ its only escapes, or bare, the rest of the line (never opening on " or [). */
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
      if (ok) {
        for (let i = 0; i < 10 && ok; i++) {
          if (i !== 4 && i !== 7 && !isDigit(raw.charCodeAt(i))) ok = false;
        }
      }
      const y = ok ? (raw.charCodeAt(0) - 48) * 1000 + (raw.charCodeAt(1) - 48) * 100 + (raw.charCodeAt(2) - 48) * 10 + (raw.charCodeAt(3) - 48) : 0;
      const mo = ok ? (raw.charCodeAt(5) - 48) * 10 + (raw.charCodeAt(6) - 48) : 0;
      const d = ok ? (raw.charCodeAt(8) - 48) * 10 + (raw.charCodeAt(9) - 48) : 0;
      if (!ok || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',');
      for (let i = 0; i < tags.length; i++) {
        tags[i] = tags[i].trim();
        const t = tags[i];
        if (t === '') return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        for (let j = 0; j < t.length; j++) {
          const c = t.charCodeAt(j);
          if (c === 34 || c === 91 || c === 93) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        }
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout': {
      if (raw.length === 0) return { error: 'key "layout": not a template name' };
      for (let i = 0; i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return { error: 'key "layout": not a template name' };
      }
      return { value: raw };
    }
    case 'slug': {
      if (raw.length === 0 || raw.length > 64) return { error: 'key "slug": not a slug' };
      let ok = true;
      let prevDash = true;
      for (let i = 0; i < raw.length && ok; i++) {
        const c = raw.charCodeAt(i);
        if (c === 45) {
          if (prevDash) ok = false;
          prevDash = true;
        } else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) prevDash = false;
        else ok = false;
      }
      if (!ok || prevDash) return { error: 'key "slug": not a slug' };
      return { value: raw };
    }
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error } with the first
 * reason it is refused. `text` has "\n" line ends. Lines are walked by index,
 * never split into an array: only the head is ever read.
 */
export function parseFrontMatter(text) {
  let p = 0;
  let nl = text.indexOf('\n', p);
  let line = nl === -1 ? text.slice(p) : text.slice(p, nl);
  if (line !== '---') return { error: 'no front matter' };
  p = nl === -1 ? text.length + 1 : nl + 1;
  const fm = [];
  let no = 2;
  let bodyStart = -1;
  while (p <= text.length) {
    nl = text.indexOf('\n', p);
    line = nl === -1 ? text.slice(p) : text.slice(p, nl);
    if (line === '---') {
      bodyStart = nl === -1 ? text.length : nl + 1;
      break;
    }
    fm.push(line, no);
    if (nl === -1) break;
    p = nl + 1;
    no++;
  }
  if (bodyStart === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let f = 0; f < fm.length; f += 2) {
    const rawLine = fm[f];
    const ln = fm[f + 1];
    let blank = true;
    for (let i = 0; i < rawLine.length; i++) {
      const c = rawLine.charCodeAt(i);
      if (c !== 32 && c !== 9) { blank = false; break; }
    }
    if (blank || rawLine.charCodeAt(0) === 35) continue;
    let k = 0;
    while (k < rawLine.length) {
      const c = rawLine.charCodeAt(k);
      if ((c >= 97 && c <= 122) || c === 95) k++;
      else break;
    }
    if (k === 0 || rawLine.charCodeAt(k) !== 58) return { error: `line ${ln} is not "key: value"` };
    const key = rawLine.slice(0, k);
    let raw;
    if (k + 1 === rawLine.length) raw = '';
    else if (rawLine.charCodeAt(k + 1) === 32) raw = rawLine.slice(k + 2);
    else return { error: `line ${ln} is not "key: value"` };
    let e = raw.length;
    while (e > 0) {
      const c = raw.charCodeAt(e - 1);
      if (c === 32 || c === 9) e--;
      else break;
    }
    raw = raw.slice(0, e);
    if (!KEYS.has(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(bodyStart) };
}

// ---------------------------------------------------------------- markdown

// A line's kind, classified once up front by character codes:
// 0 blank, 1 fence open, 2 heading, 3 thematic break, 4 blockquote,
// 5 bullet item, 6 ordered item, 7 anything else.
function lineKind(line) {
  const n = line.length;
  if (n === 0) return 0;
  const c0 = line.charCodeAt(0);
  if (c0 === 32 || c0 === 9) {
    for (let i = 1; i < n; i++) {
      const c = line.charCodeAt(i);
      if (c !== 32 && c !== 9) return 7;
    }
    return 0;
  }
  if (c0 === 96) {
    if (n >= 3 && line.charCodeAt(1) === 96 && line.charCodeAt(2) === 96) {
      let i = 3;
      while (i < n) {
        const c = line.charCodeAt(i);
        if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) i++;
        else break;
      }
      while (i < n) {
        const c = line.charCodeAt(i);
        if (c === 32 || c === 9) i++;
        else return 7;
      }
      return 1;
    }
    return 7;
  }
  if (c0 === 35) {
    let i = 0;
    while (i < n && i < 6 && line.charCodeAt(i) === 35) i++;
    if (i === n) return 7;
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return 7;
    let j = n - 1;
    while (j > i && (line.charCodeAt(j) === 32 || line.charCodeAt(j) === 9)) j--;
    let k = i;
    while (k <= j && (line.charCodeAt(k) === 32 || line.charCodeAt(k) === 9)) k++;
    if (k > j) return 7;
    return 2;
  }
  if (c0 === 45) {
    if (n >= 3 && line.charCodeAt(1) === 45 && line.charCodeAt(2) === 45) {
      for (let i = 3; i < n; i++) {
        const c = line.charCodeAt(i);
        if (c !== 32 && c !== 9) return 7;
      }
      return 3;
    }
    if (n >= 2 && line.charCodeAt(1) === 32) return 5;
    return 7;
  }
  if (c0 === 42) {
    if (n >= 3 && line.charCodeAt(1) === 42 && line.charCodeAt(2) === 42) {
      for (let i = 3; i < n; i++) {
        const c = line.charCodeAt(i);
        if (c !== 32 && c !== 9) return 7;
      }
      return 3;
    }
    if (n >= 2 && line.charCodeAt(1) === 32) return 5;
    return 7;
  }
  if (c0 === 62) return 4;
  if (c0 >= 48 && c0 <= 57) {
    let i = 0;
    while (i < n && i < 9 && line.charCodeAt(i) >= 48 && line.charCodeAt(i) <= 57) i++;
    if (i < n && line.charCodeAt(i) === 46 && i + 1 < n && line.charCodeAt(i + 1) === 32) return 6;
    return 7;
  }
  return 7;
}

/** Whether `line` is a fence's closing line: three backticks, spaces or tabs after them. */
function isFenceClose(line) {
  if (line.length < 3 || line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A fence-open line's language (the [A-Za-z0-9_+-]* run after the backticks). */
function fenceLang(line) {
  let i = 3;
  let out = '';
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) {
      out += line[i];
      i++;
    } else break;
  }
  return out;
}

/** A heading line's level and text (spaces and tabs at its end dropped; closing `#`s kept as text). */
function headingParse(line) {
  let depth = 0;
  while (depth < line.length && line.charCodeAt(depth) === 35) depth++;
  let i = depth;
  while (i < line.length && (line.charCodeAt(i) === 32 || line.charCodeAt(i) === 9)) i++;
  let j = line.length;
  while (j > i && (line.charCodeAt(j - 1) === 32 || line.charCodeAt(j - 1) === 9)) j--;
  return { depth, text: line.slice(i, j) };
}

/** An ordered-item line's first number. */
function orderedStart(line) {
  let i = 0;
  let v = 0;
  while (i < line.length && line.charCodeAt(i) >= 48 && line.charCodeAt(i) <= 57) {
    v = v * 10 + (line.charCodeAt(i) - 48);
    i++;
  }
  return v;
}

/** An ordered-item line's text (after the digits, the dot and the space). */
function orderedText(line) {
  let i = 0;
  while (i < line.length && line.charCodeAt(i) >= 48 && line.charCodeAt(i) <= 57) i++;
  return line.slice(i + 2);
}

/** Whether `line` continues a list item: two or more spaces, then a non-space. */
const WS_CHAR = /\s/;
function isContinued(line) {
  let i = 0;
  while (i < line.length && line.charCodeAt(i) === 32) i++;
  if (i < 2 || i >= line.length) return false;
  return !WS_CHAR.test(line[i]);
}

/** A line with spaces and tabs at either end dropped. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return line.slice(a, b);
}

// The characters a backslash escapes.
const ESCAPABLE_CODE = new Uint8Array(128);
for (const ch of '\\`*_[]()#+-.!>') ESCAPABLE_CODE[ch.charCodeAt(0)] = 1;
// The characters inline rendering stops at: backslash, backtick, star, open bracket, and the escape table.
const IS_SPECIAL = new Uint8Array(128);
for (const ch of '\\`*[') IS_SPECIAL[ch.charCodeAt(0)] = 1;
for (const ch of '&<>"\'') IS_SPECIAL[ch.charCodeAt(0)] = 1;

/** The first index from `from` where `s` holds a special character, or -1. */
function nextSpecial(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s.charCodeAt(j);
    if (c < 128 && IS_SPECIAL[c]) return j;
  }
  return -1;
}

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  const w0 = what.charCodeAt(0);
  const wlen = what.length;
  for (let j = from; j <= s.length - wlen; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < s.length && ESCAPABLE_CODE[s.charCodeAt(j + 1)]) {
      j++;
      continue;
    }
    if (c === w0 && s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < s.length && ESCAPABLE_CODE[s.charCodeAt(j + 1)]) {
      j++;
      continue;
    }
    if (c !== 42) continue;
    if (s.charCodeAt(j + 1) === 42) {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/**
 * `s` rendered inline; `env.link(target)` is a link's href. Plain runs are
 * copied whole and escaped in bulk; only the markers are handled one by one.
 */
export function inline(s, env) {
  const out = [];
  const n = s.length;
  let i = 0;
  while (i < n) {
    const j = nextSpecial(s, i);
    if (j === -1) {
      // The tail holds no special character at all, so nothing in it needs escaping.
      out.push(s.slice(i));
      break;
    }
    // The run holds no special character either (nextSpecial stops at every
    // one, escape characters included), so it is already escaped as written.
    if (j > i) out.push(s.slice(i, j));
    const c = s[j];
    if (c === '&' || c === '<' || c === '>' || c === '"' || c === "'") {
      out.push(ESC[c]);
      i = j + 1;
      continue;
    }
    if (c === '\\') {
      if (j + 1 < n && ESCAPABLE_CODE[s.charCodeAt(j + 1)]) {
        const e = s[j + 1];
        out.push(e === '>' ? '&gt;' : e);
        i = j + 2;
      } else {
        out.push('\\');
        i = j + 1;
      }
      continue;
    }
    if (c === '`') {
      const k = s.indexOf('`', j + 1);
      if (k > j + 1) {
        out.push(`<code>${escapeHtml(s.slice(j + 1, k))}</code>`);
        i = k + 1;
      } else {
        out.push('`');
        i = j + 1;
      }
      continue;
    }
    if (c === '*') {
      if (s[j + 1] === '*') {
        const k = findUnescaped(s, '**', j + 2);
        if (k > j + 2) {
          out.push(`<strong>${inline(s.slice(j + 2, k), env)}</strong>`);
          i = k + 2;
        } else {
          out.push('**');
          i = j + 2;
        }
      } else {
        const k = findSingleStar(s, j + 1);
        if (k > j + 1) {
          out.push(`<em>${inline(s.slice(j + 1, k), env)}</em>`);
          i = k + 1;
        } else {
          out.push('*');
          i = j + 1;
        }
      }
      continue;
    }
    // c === '['
    const k = findUnescaped(s, ']', j + 1);
    const mm = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
    const target = mm === -1 ? '' : s.slice(k + 2, mm);
    if (target !== '' && !/\s/.test(target)) {
      out.push(`<a href="${escapeHtml(env.link(target))}">${inline(s.slice(j + 1, k), env)}</a>`);
      i = mm + 1;
    } else {
      out.push('[');
      i = j + 1;
    }
  }
  return out.join('');
}

/**
 * `src` rendered: its HTML (each block on its own lines, a "\n" after the last),
 * its table of contents (every level 2 and 3 heading: level, id and its inline
 * HTML) and its excerpt (the first paragraph's inline HTML, or "").
 */
export function renderMarkdown(src, env) {
  const lines = src.split('\n');
  const kinds = new Uint8Array(lines.length);
  for (let i = 0; i < lines.length; i++) kinds[i] = lineKind(lines[i]);
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const kind = kinds[i];
    const line = lines[i];
    if (kind === 0) {
      i++;
      continue;
    }
    if (kind === 1) {
      const lang = fenceLang(line);
      let code = '';
      i++;
      while (i < n && !isFenceClose(lines[i])) {
        code += escapeHtml(lines[i]);
        code += '\n';
        i++;
      }
      i++;
      const cls = lang === '' ? '' : ` class="language-${lang}"`;
      blocks.push(`<pre><code${cls}>${code}</code></pre>`);
      continue;
    }
    if (kind === 2) {
      const h = headingParse(line);
      const id = uniqueSlug(slugify(h.text), ids);
      const html = inline(h.text, env);
      blocks.push(`<h${h.depth} id="${id}">${html}</h${h.depth}>`);
      if (h.depth === 2 || h.depth === 3) toc.push({ level: h.depth, id, html });
      i++;
      continue;
    }
    if (kind === 3) {
      blocks.push('<hr>');
      i++;
      continue;
    }
    if (kind === 4) {
      const body = [];
      while (i < n && kinds[i] === 4) {
        let l = lines[i++];
        l = l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1);
        l = trimLine(l);
        if (l !== '') body.push(l);
      }
      blocks.push(body.length === 0 ? '<blockquote>\n</blockquote>' : `<blockquote>\n<p>${inline(body.join('\n'), env)}</p>\n</blockquote>`);
      continue;
    }
    if (kind === 5 || kind === 6) {
      const isOrdered = kind === 6;
      const start = isOrdered ? orderedStart(line) : 1;
      const items = [];
      while (i < n) {
        const k2 = kinds[i];
        if (isOrdered ? k2 === 6 : k2 === 5) {
          const txt = isOrdered ? orderedText(lines[i]) : lines[i].slice(2);
          items.push([trimLine(txt)]);
          i++;
        } else if (isContinued(lines[i])) {
          items[items.length - 1].push(trimLine(lines[i]));
          i++;
        } else break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && start !== 1 ? `<ol start="${start}">` : `<${tag}>`;
      let lis = '';
      for (const parts of items) lis += `<li>${inline(parts.join('\n'), env)}</li>\n`;
      blocks.push(`${open}\n${lis}</${tag}>`);
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < n) {
      const k2 = kinds[i];
      if (k2 === 0 || k2 === 1 || k2 === 2 || k2 === 3) break;
      body.push(trimLine(lines[i++]));
    }
    const html = inline(body.join('\n'), env);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>`);
  }
  return { html: blocks.map((b) => `${b}\n`).join(''), toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

/** The deepest an include nests: one past it renders nothing. */
export const INCLUDE_DEPTH = 8;

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
    let standalone = true;
    for (let k = lineStart; k < open; k++) {
      const c = src.charCodeAt(k);
      if (c !== 32 && c !== 9) { standalone = false; break; }
    }
    if (standalone) {
      for (let k = end; k < lineEnd; k++) {
        const c = src.charCodeAt(k);
        if (c !== 32 && c !== 9) { standalone = false; break; }
      }
    }
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
export function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** The value at `path` in the scope chain: its first name from the nearest scope holding it, then own properties. */
function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/**
 * `nodes` rendered in `scope` ({ vars, parent }), as one string. The
 * tree-walking renderer: used only when a template cannot be compiled.
 */
function renderNodes(nodes, scope, ctx, depth) {
  let out = '';
  for (const n of nodes) {
    switch (n.kind) {
      case 'text':
        out += n.text;
        break;
      case 'var':
        out += escapeHtml(textOf(lookup(scope, n.path)));
        break;
      case 'raw':
        out += textOf(lookup(scope, n.path));
        break;
      case 'if': {
        const v = truthy(lookup(scope, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) out += renderNodes(branch, scope, ctx, depth);
        break;
      }
      case 'for': {
        const xs = lookup(scope, n.path);
        if (!Array.isArray(xs)) break;
        xs.forEach((x, k) => {
          const vars = { [n.name]: x, loop: { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length } };
          out += renderNodes(n.body, { vars, parent: scope }, ctx, depth);
        });
        break;
      }
      case 'include': {
        const t = ctx.templates.get(n.name);
        if (t !== undefined && depth < INCLUDE_DEPTH) out += renderNodes(t, scope, ctx, depth + 1);
        break;
      }
    }
  }
  return out;
}

// ------------------------------------------------------------ template codegen

/** A lookup of `path` from scope variable `sv`, as one expression (uses the shared temp $v for deeper paths). */
function lookupExpr(sv, path) {
  if (path.length === 1) return `${sv}[${JSON.stringify(path[0])}]`;
  let expr = `${sv}[${JSON.stringify(path[0])}]`;
  for (let k = 1; k < path.length; k++) {
    const seg = JSON.stringify(path[k]);
    expr = `($v=${expr},$v!==null&&typeof $v==="object"&&H($v,${seg})?$v[${seg}]:undefined)`;
  }
  return expr;
}

let scopeUid = 0;

/** The statements rendering `nodes` in scope variable `sv`, appended to `lines`. */
function genNodes(nodes, sv, lines) {
  for (const n of nodes) {
    if (n.kind === 'text') {
      lines.push(`out+=${JSON.stringify(n.text)};`);
    } else if (n.kind === 'var') {
      lines.push(`out+=(($t=${lookupExpr(sv, n.path)}),typeof $t==="string"?E($t):E(TV($t)));`);
    } else if (n.kind === 'raw') {
      lines.push(`out+=(($t=${lookupExpr(sv, n.path)}),typeof $t==="string"?$t:TV($t));`);
    } else if (n.kind === 'if') {
      lines.push(`if(TR(${lookupExpr(sv, n.path)})!==${n.not}){`);
      genNodes(n.then, sv, lines);
      lines.push('}');
      if (n.else !== null) {
        lines.push('else{');
        genNodes(n.else, sv, lines);
        lines.push('}');
      }
    } else if (n.kind === 'for') {
      const sv2 = `S${++scopeUid}`;
      lines.push(`{const XS=${lookupExpr(sv, n.path)};if(Array.isArray(XS)){const ${sv2}=Object.create(${sv});const LP={};const L=XS.length;for(let k=0;k<L;k++){${sv2}[${JSON.stringify(n.name)}]=XS[k];LP.index=k+1;LP.first=k===0;LP.last=k===L-1;LP.length=L;${sv2}["loop"]=LP;`);
      genNodes(n.body, sv2, lines);
      lines.push('}}}');
    } else if (n.kind === 'include') {
      lines.push(`if(D<${INCLUDE_DEPTH}){const F=T.get(${JSON.stringify(n.name)});if(F)out+=F(${sv},D+1,T,E,TV,TR,H);}`);
    }
  }
}

/**
 * A template's nodes compiled to a function (S, D, T, E, TV, TR, H) returning
 * its rendering: S is the scope (a chain of null-prototype objects), D the
 * include depth, T the compiled templates by name, E the escape, TV textOf,
 * TR truthy, H Object.hasOwn. The rendering is built with += (V8 ropes), so
 * no array is allocated and no join copies it: it is flattened once, when the
 * harness serialises the answers.
 */
function compileTemplate(nodes) {
  scopeUid = 0;
  const lines = ['let $v,$t,out="";'];
  genNodes(nodes, 'S', lines);
  lines.push('return out;');
  return new Function('S', 'D', 'T', 'E', 'TV', 'TR', 'H', lines.join('\n'));
}

// ---------------------------------------------------------------- the build

/** A page's link record as templates read it. */
const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });

/** One site's output tree: path -> text. */
export function run(input) {
  slugCache.clear();
  const nodesMap = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      nodesMap.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  let fnMap = null;
  try {
    fnMap = new Map();
    for (const [name, nodes] of nodesMap) fnMap.set(name, compileTemplate(nodes));
  } catch {
    fnMap = null;
  }

  const base = input.site.base_url.replace(/\/+$/, '');
  const output = {};
  const broken = new Set();

  // 1. Sources, in code-unit order of their paths; a source that is not .md is static.
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  let sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.replace(/\r\n?/g, '\n') });
    else statics.push({ path: f.path, content: f.content });
  }

  // 2. Each source's front matter: a refused source is reported and dropped, and so is a draft.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = s.path.startsWith('tags/') ? 'tags' : s.path.startsWith('page/') ? 'page' : undefined;
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!nodesMap.has(layout)) {
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
  sources = kept;

  // 3. Each page's output directory and url: its slug made unique in its directory, in source order.
  const taken = new Map();
  const bySource = new Map();
  for (const s of sources) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. Each body's Markdown, its links resolved to the pages and static files they name.
  const staticPaths = new Set(statics.map((f) => f.path));
  for (const s of sources) {
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
        broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.body, env);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. The posts, newest first and then by slug; each post's newer and older neighbours.
  const posts = sources.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. The tags: grouped by their slug, each named as first met in the posts' order, ordered by count and then slug.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const names = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name);
      if (!seen.has(slug)) {
        seen.add(slug);
        names.push(name);
      }
    }
    return names;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of sources) {
    if (!s.post) {
      s.tagRefs = ownTags(s).map((name) => {
        const slug = slugify(name);
        return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
      });
    }
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // 7. Every page through its layout, the index pages and the tag pages through theirs.
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  const pageOf = (s) => ({
    ...(s.post ? cards.get(s) : cardOf(s)),
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  });
  const tagOf = (t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) });
  const cards = new Map(posts.map((p) => [p, cardOf(p)]));
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const baseScope = Object.create(null);
  baseScope.site = site;
  baseScope.tags = allTags;
  baseScope.recent = recent;
  const interpCtx = { templates: nodesMap, escape: escapeHtml };
  const render = (name, vars) => {
    const S = Object.create(baseScope);
    Object.assign(S, vars);
    if (fnMap !== null) {
      const fn = fnMap.get(name);
      if (fn === undefined) return null;
      return fn(S, 0, fnMap, escapeHtml, textOf, truthy, Object.hasOwn);
    }
    const nodes = nodesMap.get(name);
    if (nodes === undefined) return null;
    return renderNodes(nodes, { vars: S, parent: null }, interpCtx, 0);
  };
  for (const s of sources) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: tagOf(t) });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report: every refusal, draft, broken link and template that did not parse, sorted, then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = sources.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output[REPORT_FILE] = `${lines.join('\n')}\n`;
  return output;
}
