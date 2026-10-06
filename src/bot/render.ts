/**
 * Model Markdown -> Telegram HTML, valid by construction, plus chunking under Telegram's 4096 limit.
 * A message Telegram cannot parse is rejected outright, so every output path here produces either
 * balanced, supported tags or plain escaped text.
 */

export const TELEGRAM_LIMIT = 4096;

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, '&quot;');
}

// Placeholders for already-rendered inline pieces. Control chars are stripped from input first.
const PH_OPEN = '\u0001';
const PH_CLOSE = '\u0002';
const PH_RE = /\u0001(\d+)\u0002/g;

const PUNCT = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/;
const WORD = /[\p{L}\p{N}]/u;
const SPACE = /\s/;
const SAFE_SCHEME = /^(https?:\/\/|tg:\/\/|mailto:)/i;

function parseLinkAt(s: string, i: number): { text: string; url: string; end: number } | null {
  // [text](url "optional title") with nested brackets in text and balanced parens in url
  let depth = 0;
  let j = i;
  for (; j < s.length; j++) {
    const c = s[j];
    if (c === '\\') {
      j++;
      continue;
    }
    if (c === '[') depth++;
    else if (c === ']') {
      depth--;
      if (depth === 0) break;
    } else if (c === '\n') return null;
  }
  if (depth !== 0 || s[j + 1] !== '(') return null;
  const text = s.slice(i + 1, j);
  let k = j + 2;
  let parens = 1;
  let url = '';
  for (; k < s.length; k++) {
    const c = s[k];
    if (c === '\n') return null;
    if (c === '(') parens++;
    else if (c === ')') {
      parens--;
      if (parens === 0) break;
    }
    url += c;
  }
  if (parens !== 0) return null;
  url = url.trim().replace(/\s+"[^"]*"$/, '').replace(/^<|>$/g, '');
  if (!text.trim() || !url || /\s/.test(url)) return null;
  return { text, url, end: k + 1 };
}

type Delim = '***' | '**' | '__' | '~~' | '||' | '*' | '_';
const DELIMS: Delim[] = ['***', '**', '__', '~~', '||', '*', '_'];

function runLength(s: string, i: number, ch: string): number {
  let n = 0;
  while (s[i + n] === ch) n++;
  return n;
}

function delimAt(s: string, i: number): Delim | null {
  const ch = s[i];
  if (ch !== '*' && ch !== '_' && ch !== '~' && ch !== '|') return null;
  const run = runLength(s, i, ch);
  for (const d of DELIMS) {
    if (d[0] !== ch) continue;
    if (run === d.length || (d.length === 1 && run === 1)) return d;
  }
  if (ch === '*' && run > 3) return null;
  return null;
}

function canOpen(s: string, i: number, d: Delim): boolean {
  const next = s[i + d.length];
  if (next === undefined || SPACE.test(next)) return false;
  if (d[0] === '_' && i > 0 && WORD.test(s[i - 1])) return false;
  return true;
}

function findClose(s: string, from: number, d: Delim): number {
  const ch = d[0];
  for (let k = from; k < s.length; k++) {
    if (s[k] !== ch) continue;
    const run = runLength(s, k, ch);
    if (run === d.length && k > from && !SPACE.test(s[k - 1])) {
      const after = s[k + run];
      if (d[0] === '_' && after !== undefined && WORD.test(after)) {
        k += run - 1;
        continue;
      }
      return k;
    }
    k += run - 1;
  }
  return -1;
}

function wrap(d: Delim, inner: string): string {
  switch (d) {
    case '***':
      return `<b><i>${inner}</i></b>`;
    case '**':
    case '__':
      return `<b>${inner}</b>`;
    case '*':
    case '_':
      return `<i>${inner}</i>`;
    case '~~':
      return `<s>${inner}</s>`;
    case '||':
      return `<tg-spoiler>${inner}</tg-spoiler>`;
  }
}

function emphasis(s: string): string {
  let out = '';
  let i = 0;
  while (i < s.length) {
    const d = delimAt(s, i);
    if (d && canOpen(s, i, d)) {
      const j = findClose(s, i + d.length, d);
      if (j >= 0) {
        out += wrap(d, emphasis(s.slice(i + d.length, j)));
        i = j + d.length;
        continue;
      }
    }
    if (s[i] === PH_OPEN) {
      const end = s.indexOf(PH_CLOSE, i);
      out += s.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    // A run of delimiter chars that did not open is literal as a whole.
    const ch = s[i];
    if (ch === '*' || ch === '_' || ch === '~' || ch === '|') {
      const run = runLength(s, i, ch);
      out += escapeHtml(s.slice(i, i + run));
      i += run;
      continue;
    }
    out += escapeHtml(ch);
    i++;
  }
  return out;
}

/** Inline Markdown in one block of text -> HTML. `allowLinks` is false inside link text. */
function inline(src: string, holders: string[], allowLinks = true): string {
  const hold = (html: string) => {
    holders.push(html);
    return PH_OPEN + (holders.length - 1) + PH_CLOSE;
  };
  let s = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '\\' && i + 1 < src.length && PUNCT.test(src[i + 1])) {
      s += hold(escapeHtml(src[i + 1]));
      i += 2;
      continue;
    }
    if (c === '`') {
      const n = runLength(src, i, '`');
      let k = src.indexOf('`'.repeat(n), i + n);
      while (k >= 0 && runLength(src, k, '`') !== n) k = src.indexOf('`'.repeat(n), k + runLength(src, k, '`'));
      if (k >= 0) {
        let code = src.slice(i + n, k);
        if (code.length > 2 && code.startsWith(' ') && code.endsWith(' ')) code = code.slice(1, -1);
        s += hold(`<code>${escapeHtml(code)}</code>`);
        i = k + n;
        continue;
      }
      s += hold(escapeHtml('`'.repeat(n)));
      i += n;
      continue;
    }
    if (c === '[' && allowLinks) {
      const link = parseLinkAt(src, i);
      if (link) {
        const label = inline(link.text, holders, false);
        s += hold(SAFE_SCHEME.test(link.url) ? `<a href="${escapeAttr(link.url)}">${label}</a>` : `${label} (${escapeHtml(link.url)})`);
        i = link.end;
        continue;
      }
    }
    if (c === '<') {
      const m = /^<((?:https?|mailto|tg):[^\s<>]+)>/i.exec(src.slice(i));
      if (m) {
        s += hold(allowLinks ? `<a href="${escapeAttr(m[1])}">${escapeHtml(m[1])}</a>` : escapeHtml(m[1]));
        i += m[0].length;
        continue;
      }
    }
    if ((c === 'h' || c === 'H') && /^https?:\/\//i.test(src.slice(i, i + 8)) && (i === 0 || !WORD.test(src[i - 1]))) {
      const m = /^https?:\/\/[^\s<>"]+/i.exec(src.slice(i));
      if (m) {
        let url = m[0];
        while (/[.,;:!?)\]]$/.test(url)) url = url.slice(0, -1);
        s += hold(escapeHtml(url));
        i += url.length;
        continue;
      }
    }
    s += c;
    i++;
  }
  return emphasis(s);
}

function restore(html: string, holders: string[]): string {
  let out = html;
  // Holders can nest (link labels contain code spans), so restore until stable.
  for (let pass = 0; pass < 5 && PH_RE.test(out); pass++) {
    PH_RE.lastIndex = 0;
    out = out.replace(PH_RE, (_, n: string) => holders[Number(n)] ?? '');
  }
  PH_RE.lastIndex = 0;
  return out;
}

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)[^`]*$/;
const TABLE_SEP = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)+\|?\s*$/;

function splitRow(line: string): string[] {
  let t = line.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|') && !t.endsWith('\\|')) t = t.slice(0, -1);
  return t.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
}

function renderTable(rows: string[][]): string {
  const cols = Math.max(...rows.map((r) => r.length));
  const cells = rows.map((r) => Array.from({ length: cols }, (_, i) => stripMarkdown(r[i] || '')));
  const widths = Array.from({ length: cols }, (_, i) => Math.min(40, Math.max(...cells.map((r) => [...r[i]].length))));
  const fmt = (r: string[]) => r.map((c, i) => c + ' '.repeat(Math.max(0, widths[i] - [...c].length))).join(' | ').trimEnd();
  const lines = [fmt(cells[0]), widths.map((w) => '-'.repeat(Math.max(1, w))).join('-+-'), ...cells.slice(1).map(fmt)];
  return `<pre>${escapeHtml(lines.join('\n'))}</pre>`;
}

function codeBlock(code: string, lang: string): string {
  const safe = lang.replace(/[^A-Za-z0-9_+-]/g, '');
  const body = escapeHtml(code);
  return safe ? `<pre><code class="language-${safe}">${body}</code></pre>` : `<pre>${body}</pre>`;
}

export function markdownToTelegramHtml(md: string): string {
  const src = String(md ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
  const lines = src.split('\n');
  const out: string[] = [];
  const holders: string[] = [];
  let blankPending = false;
  const push = (html: string) => {
    if (blankPending && out.length) out.push('');
    blankPending = false;
    out.push(html);
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) {
      blankPending = true;
      continue;
    }
    const fence = FENCE_OPEN.exec(line);
    if (fence) {
      const marker = fence[1];
      const body: string[] = [];
      let j = i + 1;
      for (; j < lines.length; j++) {
        const close = new RegExp(`^ {0,3}${marker[0] === '`' ? '`' : '~'}{${marker.length},}\\s*$`);
        if (close.test(lines[j])) break;
        body.push(lines[j]);
      }
      push(codeBlock(body.join('\n'), fence[2] || ''));
      i = j;
      continue;
    }
    if (line.includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
      const rows = [splitRow(line)];
      let j = i + 2;
      for (; j < lines.length && lines[j].includes('|') && lines[j].trim(); j++) rows.push(splitRow(lines[j]));
      push(renderTable(rows));
      i = j - 1;
      continue;
    }
    const heading = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      push(`<b>${inline(heading[2], holders)}</b>`);
      continue;
    }
    if (/^ {0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      push('———');
      continue;
    }
    if (/^ {0,3}>/.test(line)) {
      const quote: string[] = [];
      let j = i;
      for (; j < lines.length && /^ {0,3}>/.test(lines[j]); j++) quote.push(lines[j].replace(/^ {0,3}> ?/, ''));
      push(`<blockquote>${quote.map((q) => inline(q, holders)).join('\n')}</blockquote>`);
      i = j - 1;
      continue;
    }
    const bullet = /^(\s*)([-*+])\s+(\[[ xX]\]\s+)?(.*)$/.exec(line);
    if (bullet) {
      const level = Math.floor(bullet[1].replace(/\t/g, '  ').length / 2);
      const mark = bullet[3] ? (/x/i.test(bullet[3]) ? '☑ ' : '☐ ') : '• ';
      push('  '.repeat(level) + mark + inline(bullet[4], holders));
      continue;
    }
    const ordered = /^(\s*)(\d{1,9})([.)])\s+(.*)$/.exec(line);
    if (ordered) {
      const level = Math.floor(ordered[1].replace(/\t/g, '  ').length / 2);
      push('  '.repeat(level) + `${ordered[2]}. ` + inline(ordered[4], holders));
      continue;
    }
    push(inline(line.replace(/ {2,}$/, ''), holders));
  }
  return restore(out.join('\n'), holders);
}

export function stripMarkdown(md: string): string {
  const lines = String(md ?? '').replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let inFence = false;
  for (const line of lines) {
    if (FENCE_OPEN.test(line) && !inFence) {
      inFence = true;
      continue;
    }
    if (inFence && /^ {0,3}(`{3,}|~{3,})\s*$/.test(line)) {
      inFence = false;
      continue;
    }
    if (inFence) {
      out.push(line);
      continue;
    }
    let l = line;
    l = l.replace(/^ {0,3}#{1,6}\s+/, '');
    l = l.replace(/^ {0,3}>\s?/, '│ ');
    l = l.replace(/^(\s*)[-*+]\s+\[[xX]\]\s+/, '$1☑ ').replace(/^(\s*)[-*+]\s+\[ \]\s+/, '$1☐ ').replace(/^(\s*)[-*+]\s+/, '$1• ');
    l = l.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, '$1 ($2)');
    l = l.replace(/(\*\*\*|\*\*|__|~~|\|\|)(?=\S)([^\n]*?\S)\1/g, '$2');
    l = l.replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?!\w)/g, '$1$2');
    l = l.replace(/(^|[^\w])_(?=\S)([^_\n]*?\S)_(?!\w)/g, '$1$2');
    l = l.replace(/`([^`\n]+)`/g, '$1');
    l = l.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, '$1');
    out.push(l);
  }
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Chunking
// ---------------------------------------------------------------------------

function hardSplit(s: string, limit: number): string[] {
  const out: string[] = [];
  let rest = s;
  while (rest.length > limit) {
    let cut = limit;
    const code = rest.charCodeAt(cut - 1);
    if (code >= 0xd800 && code <= 0xdbff) cut--;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest) out.push(rest);
  return out;
}

function splitText(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];
  const tryBy = (re: RegExp, joiner: string): string[] | null => {
    const parts = text.split(re);
    if (parts.length < 2) return null;
    const out: string[] = [];
    let cur = '';
    for (const p of parts) {
      const next = cur ? cur + joiner + p : p;
      if (next.length <= limit) cur = next;
      else {
        if (cur) out.push(cur);
        if (p.length > limit) {
          out.push(...splitText(p, limit));
          cur = '';
        } else cur = p;
      }
    }
    if (cur) out.push(cur);
    return out;
  };
  if (text.includes('\n')) return tryBy(/\n/, '\n') || hardSplit(text, limit);
  const sentences = tryBy(/(?<=[.!?])\s+/, ' ');
  if (sentences && sentences.every((p) => p.length <= limit)) return sentences;
  const words = tryBy(/ +/, ' ');
  if (words && words.every((p) => p.length <= limit)) return words;
  return hardSplit(text, limit);
}

interface Block {
  text: string;
  fence?: { open: string; close: string; body: string[] };
}

function blocksOf(md: string): Block[] {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) blocks.push({ text: para.join('\n') });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const fence = FENCE_OPEN.exec(lines[i]);
    if (fence) {
      flush();
      const marker = fence[1];
      const close = new RegExp(`^ {0,3}${marker[0] === '`' ? '`' : '~'}{${marker.length},}\\s*$`);
      const body: string[] = [];
      let j = i + 1;
      for (; j < lines.length && !close.test(lines[j]); j++) body.push(lines[j]);
      const open = lines[i].trim();
      blocks.push({ text: [open, ...body, marker].join('\n'), fence: { open, close: marker, body } });
      i = j;
      continue;
    }
    if (!lines[i].trim()) flush();
    else para.push(lines[i]);
  }
  flush();
  return blocks;
}

export function splitMarkdown(md: string, limit = 3500): string[] {
  const src = String(md ?? '');
  if (!src.trim()) return [];
  const pieces: string[] = [];
  for (const b of blocksOf(src)) {
    if (b.text.length <= limit) {
      pieces.push(b.text);
      continue;
    }
    if (b.fence) {
      const room = Math.max(200, limit - b.fence.open.length - b.fence.close.length - 4);
      let cur: string[] = [];
      let size = 0;
      const emit = () => {
        if (cur.length) pieces.push([b.fence!.open, ...cur, b.fence!.close].join('\n'));
        cur = [];
        size = 0;
      };
      for (const line of b.fence.body) {
        for (const part of line.length > room ? hardSplit(line, room) : [line]) {
          if (size + part.length + 1 > room) emit();
          cur.push(part);
          size += part.length + 1;
        }
      }
      emit();
      continue;
    }
    pieces.push(...splitText(b.text, limit));
  }
  const chunks: string[] = [];
  let cur = '';
  for (const p of pieces) {
    const next = cur ? cur + '\n\n' + p : p;
    if (next.length <= limit) cur = next;
    else {
      if (cur) chunks.push(cur);
      cur = p;
    }
  }
  if (cur) chunks.push(cur);
  return chunks.filter((c) => c.trim());
}

export function renderReply(md: string): { html: string[]; plain: string[] } {
  const html: string[] = [];
  const plain: string[] = [];
  const walk = (chunk: string, limit: number) => {
    const rendered = markdownToTelegramHtml(chunk);
    const ok = rendered.length <= TELEGRAM_LIMIT && validateTelegramHtml(rendered).ok;
    if (!ok && limit > 300) {
      for (const sub of splitMarkdown(chunk, Math.floor(limit / 2))) walk(sub, Math.floor(limit / 2));
      return;
    }
    const text = stripMarkdown(chunk).trim() ? stripMarkdown(chunk) : chunk;
    if (ok) {
      html.push(rendered);
      plain.push(text.slice(0, TELEGRAM_LIMIT));
      return;
    }
    // Last resort: plain escaped text is always accepted.
    for (const p of hardSplit(text, 3500)) {
      html.push(escapeHtml(p));
      plain.push(p);
    }
  };
  for (const c of splitMarkdown(md)) walk(c, 3500);
  return { html, plain };
}

// ---------------------------------------------------------------------------
// Validator (also used by the fake Telegram server in tests)
// ---------------------------------------------------------------------------

const ALLOWED: Record<string, (attrs: string) => boolean> = {
  b: (a) => !a.trim(),
  strong: (a) => !a.trim(),
  i: (a) => !a.trim(),
  em: (a) => !a.trim(),
  u: (a) => !a.trim(),
  ins: (a) => !a.trim(),
  s: (a) => !a.trim(),
  strike: (a) => !a.trim(),
  del: (a) => !a.trim(),
  'tg-spoiler': (a) => !a.trim(),
  span: (a) => /^\s*class="tg-spoiler"\s*$/.test(a),
  a: (a) => /^\s*href="[^"<>]*"\s*$/.test(a),
  code: (a) => !a.trim() || /^\s*class="language-[A-Za-z0-9_+-]+"\s*$/.test(a),
  pre: (a) => !a.trim(),
  blockquote: (a) => !a.trim() || /^\s*expandable\s*$/.test(a),
  'tg-emoji': (a) => /^\s*emoji-id="\d+"\s*$/.test(a),
};

function decodeEntities(s: string): string {
  return s.replace(/&(lt|gt|amp|quot|#\d+|#x[0-9a-fA-F]+);/g, (_, e: string) => {
    if (e === 'lt') return '<';
    if (e === 'gt') return '>';
    if (e === 'amp') return '&';
    if (e === 'quot') return '"';
    const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    try {
      return String.fromCodePoint(code);
    } catch {
      return '?';
    }
  });
}

export function visibleText(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, ''));
}

export function validateTelegramHtml(html: string): { ok: boolean; error?: string } {
  const stack: string[] = [];
  const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)([^<>]*)>/g;
  let last = 0;
  let m: RegExpExecArray | null;
  const checkText = (t: string): string | null => {
    if (t.includes('<') || t.includes('>')) return 'unescaped < or >';
    const amp = t.match(/&[^;\s]{0,10};?/g) || [];
    for (const a of amp) if (!/^&(lt|gt|amp|quot|#\d+|#x[0-9a-fA-F]+);$/.test(a)) return `bad entity ${a}`;
    return null;
  };
  while ((m = tagRe.exec(html))) {
    const err = checkText(html.slice(last, m.index));
    if (err) return { ok: false, error: err };
    last = tagRe.lastIndex;
    const closing = m[1] === '/';
    const name = m[2].toLowerCase();
    const attrs = m[3];
    if (!(name in ALLOWED)) return { ok: false, error: `unsupported tag <${name}>` };
    if (closing) {
      if (attrs.trim()) return { ok: false, error: `attributes on closing tag </${name}>` };
      const top = stack.pop();
      if (top !== name) return { ok: false, error: `mismatched </${name}> (open: ${top || 'none'})` };
      continue;
    }
    if (!ALLOWED[name](attrs)) return { ok: false, error: `bad attributes on <${name}>` };
    const parent = stack[stack.length - 1];
    if (parent === 'code') return { ok: false, error: 'tag inside <code>' };
    if (parent === 'pre' && name !== 'code') return { ok: false, error: 'tag inside <pre>' };
    if (name === 'a' && stack.includes('a')) return { ok: false, error: 'nested <a>' };
    stack.push(name);
  }
  const tail = checkText(html.slice(last));
  if (tail) return { ok: false, error: tail };
  if (stack.length) return { ok: false, error: `unclosed <${stack[stack.length - 1]}>` };
  const visible = visibleText(html);
  if (!visible.trim()) return { ok: false, error: 'message text is empty' };
  if (visible.length > TELEGRAM_LIMIT) return { ok: false, error: 'message is too long' };
  return { ok: true };
}
