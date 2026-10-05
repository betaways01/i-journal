import test from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml, markdownToTelegramHtml as md, renderReply, splitMarkdown, stripMarkdown, validateTelegramHtml, visibleText } from '../../src/bot/render';

const valid = (html: string) => {
  const v = validateTelegramHtml(html);
  assert.ok(v.ok, `${v.error}: ${html.slice(0, 300)}`);
};

test('inline formatting', () => {
  const cases: Array<[string, string]> = [
    ['**bold**', '<b>bold</b>'],
    ['__bold__', '<b>bold</b>'],
    ['*italic*', '<i>italic</i>'],
    ['_italic_', '<i>italic</i>'],
    ['***both***', '<b><i>both</i></b>'],
    ['~~gone~~', '<s>gone</s>'],
    ['||secret||', '<tg-spoiler>secret</tg-spoiler>'],
    ['`code`', '<code>code</code>'],
    ['``a ` b``', '<code>a ` b</code>'],
    ['**bold with `code` inside**', '<b>bold with <code>code</code> inside</b>'],
    ['*it **bold** it*', '<i>it <b>bold</b> it</i>'],
    ['a < b & c > d', 'a &lt; b &amp; c &gt; d'],
    ['already &amp; escaped', 'already &amp;amp; escaped'],
    ['<script>alert(1)</script>', '&lt;script&gt;alert(1)&lt;/script&gt;'],
    ['2 * 3 * 4', '2 * 3 * 4'],
    ['a_b_c and snake_case_name', 'a_b_c and snake_case_name'],
    ['lone ** marker', 'lone ** marker'],
    ['lone _ marker', 'lone _ marker'],
    ['lone ` tick', 'lone ` tick'],
    ['\\*not italic\\*', '*not italic*'],
    ['price: $5 * 2', 'price: $5 * 2'],
    ['**unclosed bold', '**unclosed bold'],
    ['(*aside*)', '(<i>aside</i>)'],
    ['word**bold**word', 'word<b>bold</b>word'],
  ];
  for (const [input, want] of cases) {
    const got = md(input);
    assert.equal(got, want, input);
    valid(got);
  }
});

test('links', () => {
  assert.equal(md('[Grok](https://x.ai)'), '<a href="https://x.ai">Grok</a>');
  assert.equal(md('[wiki](https://en.wikipedia.org/wiki/Foo_(bar))'), '<a href="https://en.wikipedia.org/wiki/Foo_(bar)">wiki</a>');
  assert.equal(md('[**bold** link](https://a.b/c?x=1&y=2)'), '<a href="https://a.b/c?x=1&amp;y=2"><b>bold</b> link</a>');
  assert.equal(md('[click](javascript:alert(1))'), 'click (javascript:alert(1))');
  assert.equal(md('[open](onenote:https://x/y)'), 'open (onenote:https://x/y)');
  assert.equal(md('<https://example.com/a_b>'), '<a href="https://example.com/a_b">https://example.com/a_b</a>');
  assert.equal(md('see https://example.com/a_b_c*d*e.'), 'see https://example.com/a_b_c*d*e.');
  assert.equal(md('[a [nested] label](https://x.y)'), '<a href="https://x.y">a [nested] label</a>');
  assert.equal(md('[not a link] (https://x.y)'), '[not a link] (https://x.y)');
  assert.equal(md('[t](mailto:a@b.c)'), '<a href="mailto:a@b.c">t</a>');
  assert.equal(md('[q](https://x.y/"q")'), '<a href="https://x.y/&quot;q&quot;">q</a>');
  for (const s of ['[x](https://a.b) and [y](https://c.d)', '[[x]](https://a)', '[`code`](https://a)']) valid(md(s));
});

test('blocks: headings, lists, quotes, rules, code, tables, paragraphs', () => {
  assert.equal(md('# Title\n## Sub *x*'), '<b>Title</b>\n<b>Sub <i>x</i></b>');
  assert.equal(md('- one\n- **two**\n  - nested\n* star\n+ plus'), '• one\n• <b>two</b>\n  • nested\n• star\n• plus');
  assert.equal(md('1. first\n2) second\n10. tenth'), '1. first\n2. second\n10. tenth');
  assert.equal(md('- [ ] todo\n- [x] done'), '☐ todo\n☑ done');
  assert.equal(md('> quoted **line**\n> second'), '<blockquote>quoted <b>line</b>\nsecond</blockquote>');
  assert.equal(md('above\n\n---\n\nbelow'), 'above\n\n———\n\nbelow');
  assert.equal(md('```python\ndef f(x):\n    return x < 2 and "*a*"\n```'), '<pre><code class="language-python">def f(x):\n    return x &lt; 2 and "*a*"\n</code></pre>'.replace('\n</code>', '</code>'));
  assert.equal(md('```\nplain <b>\n```'), '<pre>plain &lt;b&gt;</pre>');
  assert.equal(md('~~~js\nx\n~~~'), '<pre><code class="language-js">x</code></pre>');
  assert.equal(md('```bad lang!\nx\n```'), '<pre><code class="language-bad">x</code></pre>');
  assert.equal(md('```\nunterminated\ncode'), '<pre>unterminated\ncode</pre>');
  assert.equal(md('para one\nline two\n\n\n\npara three'), 'para one\nline two\n\npara three');
  const table = md('| Name | Qty |\n|---|---:|\n| pump | 2 |\n| **panel** | 10 |');
  assert.equal(table, '<pre>Name  | Qty\n------+----\npump  | 2\npanel | 10</pre>');
  valid(table);
  assert.equal(md('a\r\nb'), 'a\nb');
});

test('realistic model answers render to valid HTML', () => {
  const samples = [
    "## Pricing a new product\n\nThree common approaches:\n\n1. **Cost-plus** — add a margin to unit cost.\n2. **Value-based** — price on what it saves the customer.\n3. **Competitive** — anchor to alternatives.\n\n```python\ndef price(cost, margin=0.3):\n    return round(cost * (1 + margin), 2)\n```\n\nMore: [HBR](https://hbr.org/pricing).",
    'Here is a lullaby:\n\n_Sleep now, little one, the sun has gone down,_\n_The lake is still, the wind lies down._',
    '| Month | Payment | Interest |\n|---|---|---|\n| 1 | 1,000 | 750 |\n| 2 | 1,000 | 748 |',
    '> "Trust is the foundation of leadership."\n> — Study Group / Leadership / 6. Trust First',
  ];
  for (const s of samples) valid(md(s));
});

test('stripMarkdown', () => {
  assert.equal(stripMarkdown('# Hi\n**bold** and _it_ and `code` [link](https://x.y)\n- item\n> quote'), 'Hi\nbold and it and code link (https://x.y)\n• item\n│ quote');
  assert.equal(stripMarkdown('```js\nconst a = 1;\n```'), 'const a = 1;');
  assert.equal(stripMarkdown('snake_case_name 2 * 3'), 'snake_case_name 2 * 3');
});

test('splitMarkdown keeps content, respects limits, re-opens split code fences', () => {
  assert.deepEqual(splitMarkdown(''), []);
  assert.deepEqual(splitMarkdown('   \n  '), []);
  const paras = Array.from({ length: 50 }, (_, i) => `Paragraph ${i} ` + 'word '.repeat(30)).join('\n\n');
  const chunks = splitMarkdown(paras, 1000);
  assert.ok(chunks.length > 5);
  for (const c of chunks) assert.ok(c.length <= 1000);
  assert.equal(chunks.join('\n\n').replace(/\s+/g, ' '), paras.replace(/\s+/g, ' '));
  const code = '```python\n' + Array.from({ length: 400 }, (_, i) => `print(${i})  # line`).join('\n') + '\n```';
  const cc = splitMarkdown(code, 1000);
  assert.ok(cc.length > 3);
  for (const c of cc) {
    assert.ok(c.startsWith('```python\n'), c.slice(0, 20));
    assert.ok(c.endsWith('\n```'));
    valid(md(c));
  }
  const long = 'x'.repeat(20000);
  for (const c of splitMarkdown(long, 3500)) assert.ok(c.length <= 3500);
  const emoji = '😀'.repeat(3000);
  for (const c of splitMarkdown(emoji, 1001)) {
    assert.ok(!/[\ud800-\udbff]$/.test(c), 'no dangling high surrogate');
    assert.ok(!/^[\udc00-\udfff]/.test(c), 'no dangling low surrogate');
  }
});

test('renderReply: every chunk valid and within 4096; plain fallback matches', () => {
  const inputs = [
    'short',
    'a'.repeat(9000),
    '<&>'.repeat(3000),
    Array.from({ length: 10000 }, (_, i) => `- item ${i}`).join('\n'),
    '```\n' + '<tag>&amp;'.repeat(2000) + '\n```',
    '**' + 'bold '.repeat(2000) + '**',
    'مرحبا بالعالم '.repeat(500),
    '👨‍👩‍👧‍👦 family '.repeat(800),
  ];
  for (const s of inputs) {
    const r = renderReply(s);
    assert.ok(r.html.length >= 1);
    assert.equal(r.html.length, r.plain.length);
    for (const h of r.html) {
      assert.ok(h.length <= 4096, `html chunk ${h.length}`);
      valid(h);
    }
    for (const p of r.plain) assert.ok(p.length <= 4096);
  }
  assert.deepEqual(renderReply(''), { html: [], plain: [] });
});

test('validator matches Telegram rules', () => {
  for (const ok of ['<b>x</b>', '<a href="https://a">x</a>', '<pre><code class="language-py">x</code></pre>', '<blockquote expandable>x</blockquote>', '<span class="tg-spoiler">x</span>', 'a &lt; b &amp; &quot;c&quot; &#128512; &#x1F600;', '<tg-emoji emoji-id="5368324170671202286">👍</tg-emoji>'])
    assert.equal(validateTelegramHtml(ok).ok, true, ok);
  const bad: Array<[string, RegExp]> = [
    ['<div>x</div>', /unsupported tag/],
    ['<b>x', /unclosed/],
    ['<b><i>x</b></i>', /mismatched/],
    ['<code><b>x</b></code>', /inside <code>/],
    ['<pre><b>x</b></pre>', /inside <pre>/],
    ['<a href="x"><a href="y">z</a></a>', /nested <a>/],
    ['a < b', /unescaped/],
    ['a & b', /bad entity/],
    ['&nbsp;', /bad entity/],
    ['<a onclick="x">y</a>', /bad attributes/],
    ['<b class="x">y</b>', /bad attributes/],
    ['<b></b>', /empty/],
    ['x'.repeat(4097), /too long/],
  ];
  for (const [html, re] of bad) {
    const v = validateTelegramHtml(html);
    assert.equal(v.ok, false, html);
    assert.match(v.error || '', re, html);
  }
  assert.equal(visibleText('<b>a &amp; b</b>'), 'a & b');
  assert.equal(escapeHtml('<a&b>'), '&lt;a&amp;b&gt;');
});

test('fuzz: 3000 random markdown-ish strings always render to valid HTML', () => {
  let seed = 0x2f6b;
  const rnd = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return ((seed >>> 0) % 1_000_000) / 1_000_000;
  };
  const alphabet = ['*', '**', '_', '__', '~~', '||', '`', '```', '\n', '\n\n', '[', ']', '(', ')', '<', '>', '&', '#', '- ', '> ', '|', '\\', ' ', 'a', 'word', 'https://x.y/a_b', '1. ', '😀', 'é', '---', '\t', '"', "'"];
  for (let n = 0; n < 3000; n++) {
    const len = 1 + Math.floor(rnd() * 40);
    let s = '';
    for (let i = 0; i < len; i++) s += alphabet[Math.floor(rnd() * alphabet.length)];
    let html = '';
    assert.doesNotThrow(() => {
      html = md(s);
    }, JSON.stringify(s));
    if (visibleText(html).trim()) {
      const v = validateTelegramHtml(html);
      assert.ok(v.ok, `${v.error} for ${JSON.stringify(s)} -> ${html}`);
    }
    for (const h of renderReply(s).html) {
      const v = validateTelegramHtml(h);
      assert.ok(v.ok, `${v.error} for ${JSON.stringify(s)} -> ${h}`);
    }
  }
});
