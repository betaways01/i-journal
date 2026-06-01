/** Helpers for sending Telegram messages with parse_mode 'HTML'. */

/** Escape text for Telegram HTML (only & < > are special in text). */
export function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * A tappable link to a OneNote page. We pass the page's oneNoteClientUrl ("onenote:…"), which
 * Telegram accepts in an HTML anchor and which opens the OneNote APP (not the web version).
 * `&` and `"` must be escaped inside the href.
 */
export function oneNoteLinkHtml(url: string, label = 'Open in OneNote'): string {
  const safeHref = url.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  return `<a href="${safeHref}">${escapeHtml(label)}</a>`;
}
