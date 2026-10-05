import fs from 'fs';
import path from 'path';
import { Inbound, InboundMedia, InboundTarget, Logger } from '../../core/types';

/** Loose shape of a Telegram Message (Bot API), covering what we read. */
export interface TgMessage {
  message_id: number;
  from?: { id: number; is_bot?: boolean; first_name?: string; username?: string };
  chat?: { id: number; type?: string };
  date?: number;
  text?: string;
  caption?: string;
  media_group_id?: string;
  photo?: Array<{ file_id: string; file_size?: number; width?: number; height?: number }>;
  voice?: { file_id: string; mime_type?: string; duration?: number; file_size?: number };
  audio?: { file_id: string; mime_type?: string; duration?: number; file_name?: string; file_size?: number };
  video?: { file_id: string; mime_type?: string; duration?: number; file_size?: number };
  video_note?: { file_id: string; duration?: number; file_size?: number };
  document?: { file_id: string; mime_type?: string; file_name?: string; file_size?: number };
  sticker?: { file_id: string; emoji?: string };
  animation?: { file_id: string; mime_type?: string; file_size?: number };
  reply_to_message?: TgMessage;
  quote?: { text?: string };
  forward_origin?: unknown;
  forward_date?: number;
  forward_from?: unknown;
  forward_sender_name?: string;
}

export const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;

export function mediaOf(msg: TgMessage): Array<InboundMedia & { fileSize?: number }> {
  const out: Array<InboundMedia & { fileSize?: number }> = [];
  if (msg.photo?.length) {
    const best = msg.photo[msg.photo.length - 1];
    out.push({ kind: 'photo', fileId: best.file_id, mime: 'image/jpeg', fileSize: best.file_size });
  }
  if (msg.voice) out.push({ kind: 'voice', fileId: msg.voice.file_id, mime: msg.voice.mime_type, duration: msg.voice.duration, fileSize: msg.voice.file_size });
  if (msg.audio) out.push({ kind: 'audio', fileId: msg.audio.file_id, mime: msg.audio.mime_type, duration: msg.audio.duration, fileName: msg.audio.file_name, fileSize: msg.audio.file_size });
  if (msg.video) out.push({ kind: 'video', fileId: msg.video.file_id, mime: msg.video.mime_type, duration: msg.video.duration, fileSize: msg.video.file_size });
  if (msg.video_note) out.push({ kind: 'video_note', fileId: msg.video_note.file_id, duration: msg.video_note.duration, fileSize: msg.video_note.file_size });
  if (msg.document) out.push({ kind: 'document', fileId: msg.document.file_id, mime: msg.document.mime_type, fileName: msg.document.file_name, fileSize: msg.document.file_size });
  if (msg.sticker) out.push({ kind: 'sticker', fileId: msg.sticker.file_id, emoji: msg.sticker.emoji });
  if (msg.animation) out.push({ kind: 'animation', fileId: msg.animation.file_id, mime: msg.animation.mime_type, fileSize: msg.animation.file_size });
  return out;
}

export function isForwarded(msg: TgMessage): boolean {
  return Boolean(msg.forward_origin || msg.forward_date || msg.forward_from || msg.forward_sender_name);
}

/** Telegram message -> core Inbound. Returns null for messages with nothing in them. */
export function toInbound(msg: TgMessage, botId?: number): Inbound | null {
  const media = mediaOf(msg).map(({ fileSize: _drop, ...m }) => m);
  const text = msg.text ?? msg.caption;
  let target: InboundTarget | undefined;
  const reply = msg.reply_to_message;
  if (reply && typeof reply.message_id === 'number') {
    target = {
      messageId: reply.message_id,
      text: reply.text ?? reply.caption,
      quote: msg.quote?.text,
      media: mediaOf(reply).map(({ fileSize: _drop, ...m }) => m),
      fromBot: Boolean(reply.from?.is_bot && (botId === undefined || reply.from.id === botId)),
    };
  }
  if (!text && !media.length) return null;
  return { kind: 'message', messageId: msg.message_id, text: text || undefined, media, target, forwarded: isForwarded(msg) || undefined };
}

/** Albums arrive as several messages sharing media_group_id; merge them into one inbound. */
export function mergeInbounds(parts: Inbound[]): Inbound {
  const first = parts[0];
  return {
    ...first,
    text: parts.map((p) => p.text).find((t) => t && t.trim()),
    media: parts.flatMap((p) => p.media),
    forwarded: parts.some((p) => p.forwarded) || undefined,
  };
}

/** Kinds worth keeping on disk: what the model can look at now, or transcribe later. */
function wanted(m: InboundMedia): boolean {
  if (m.kind === 'photo' || m.kind === 'voice' || m.kind === 'audio' || m.kind === 'video_note') return true;
  return m.kind === 'document' && Boolean(m.mime?.startsWith('image/'));
}

function extFor(m: InboundMedia, filePath: string): string {
  const fromPath = path.extname(filePath);
  if (fromPath && fromPath.length <= 6) return fromPath === '.oga' ? '.ogg' : fromPath;
  if (m.kind === 'photo') return '.jpg';
  if (m.kind === 'voice') return '.ogg';
  if (m.kind === 'video_note') return '.mp4';
  return '.bin';
}

export interface FileApi {
  getFile(fileId: string): Promise<{ file_path?: string; file_size?: number }>;
  getFileLink(fileId: string): Promise<URL>;
}

/**
 * Downloads the media worth keeping into `dir`, setting localPath on success. Never throws: a failed
 * download just leaves localPath unset, and the model is told it cannot see that item.
 */
export async function downloadMedia(
  api: FileApi,
  media: InboundMedia[],
  dir: string,
  prefix: string,
  opts: { timeoutMs?: number; maxBytes?: number; fetchImpl?: typeof fetch; log?: Logger } = {}
): Promise<void> {
  const maxBytes = opts.maxBytes ?? MAX_DOWNLOAD_BYTES;
  const doFetch = opts.fetchImpl ?? fetch;
  await Promise.all(
    media.map(async (m, i) => {
      if (!m.fileId || m.localPath || !wanted(m)) return;
      try {
        const meta = await api.getFile(m.fileId);
        if (!meta.file_path) return;
        if (meta.file_size && meta.file_size > maxBytes) {
          opts.log?.warn('media too large to download', { kind: m.kind, size: meta.file_size });
          return;
        }
        const url = await api.getFileLink(m.fileId);
        const res = await doFetch(url.toString(), { signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000) });
        if (!res.ok || !res.body) throw new Error(`download HTTP ${res.status}`);
        const reader = res.body.getReader();
        const chunks: Uint8Array[] = [];
        let total = 0;
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > maxBytes) {
            await reader.cancel();
            throw new Error('download exceeded size cap');
          }
          chunks.push(value);
        }
        fs.mkdirSync(dir, { recursive: true });
        const dest = path.join(dir, `${prefix}-${i}-${m.kind}${extFor(m, meta.file_path)}`);
        fs.writeFileSync(dest, Buffer.concat(chunks));
        m.localPath = dest;
      } catch (err) {
        opts.log?.warn('media download failed', { kind: m.kind, error: err instanceof Error ? err.message : String(err) });
      }
    })
  );
}

/**
 * Collects album parts for a short window, then hands one merged inbound to `onReady`.
 * add() returns immediately; nothing waits on a timer.
 */
export class AlbumCollector {
  private readonly pending = new Map<string, { parts: Inbound[]; timer: NodeJS.Timeout }>();

  constructor(
    private readonly onReady: (key: string, merged: Inbound) => void,
    private readonly waitMs = 800
  ) {}

  add(key: string, part: Inbound): void {
    const cur = this.pending.get(key);
    if (cur) {
      cur.parts.push(part);
      clearTimeout(cur.timer);
      cur.timer = this.arm(key);
      return;
    }
    this.pending.set(key, { parts: [part], timer: this.arm(key) });
  }

  private arm(key: string): NodeJS.Timeout {
    const t = setTimeout(() => this.flush(key), this.waitMs);
    t.unref?.();
    return t;
  }

  flush(key: string): void {
    const cur = this.pending.get(key);
    if (!cur) return;
    clearTimeout(cur.timer);
    this.pending.delete(key);
    const parts = [...cur.parts].sort((a, b) => (a.messageId ?? 0) - (b.messageId ?? 0));
    this.onReady(key, mergeInbounds(parts));
  }

  flushAll(): void {
    for (const key of [...this.pending.keys()]) this.flush(key);
  }

  get size(): number {
    return this.pending.size;
  }
}
