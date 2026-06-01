/** Helpers for sending Telegram messages with parse_mode 'HTML'. */

/** Escape text for Telegram HTML (only & < > are special in text). */
export function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * A tappable link to a OneNote page. Telegram ONLY renders http(s) anchors as clickable — a
 * custom-scheme href (e.g. "onenote:…") silently degrades to dead plain text. So we require an
 * http(s) URL; anything else falls back to showing the label plus the raw URL as visible text,
 * which is honest rather than a link that isn't one. `&` and `"` are escaped inside the href.
 */
export function oneNoteLinkHtml(url: string, label = 'Open in OneNote'): string {
  if (!/^https?:\/\//i.test(url)) {
    return url ? `${escapeHtml(label)}: ${escapeHtml(url)}` : escapeHtml(label);
  }
  const safeHref = url.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  return `<a href="${safeHref}">${escapeHtml(label)}</a>`;
}
