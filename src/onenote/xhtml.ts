/**
 * Markdown to OneNote XHTML. The Markdown is parsed once by the same renderer the bot uses for
 * Telegram (well-formed by construction, escaped), and its small tag set is mapped to tags OneNote
 * accepts. Lines become paragraphs; code and quote blocks keep their line breaks.
 */
import { markdownToTelegramHtml } from '../bot/render';

const MAP: Array<[RegExp, string]> = [
  [/<pre><code class="language-[^"]*">/g, '<pre>'],
  [/<\/code><\/pre>/g, '</pre>'],
  [/<pre><code>/g, '<pre>'],
  [/<code>/g, '<span style="font-family:Consolas,monospace">'],
  [/<\/code>/g, '</span>'],
  [/<s>/g, '<del>'],
  [/<\/s>/g, '</del>'],
  [/<\/?tg-spoiler>/g, ''],
  [/<span class="tg-spoiler">/g, '<span>'],
  [/<blockquote(?: expandable)?>/g, '<div style="margin-left:16px;color:#595959">'],
  [/<\/blockquote>/g, '</div>'],
];

export function markdownToOneNote(md: string): string {
  let html = markdownToTelegramHtml(md);
  for (const [re, to] of MAP) html = html.replace(re, to);
  const out: string[] = [];
  // Blocks that span lines are kept whole; everything else is one paragraph per line.
  const blocks = html.split(/(<pre>[\s\S]*?<\/pre>|<div style="margin-left:16px;color:#595959">[\s\S]*?<\/div>)/);
  for (const block of blocks) {
    if (!block) continue;
    if (block.startsWith('<pre>')) {
      out.push(block.replace(/\n/g, '<br/>'));
      continue;
    }
    if (block.startsWith('<div ')) {
      out.push(block.replace(/\n/g, '<br/>'));
      continue;
    }
    for (const line of block.split('\n')) if (line.trim()) out.push(`<p>${line}</p>`);
  }
  return out.join('');
}
