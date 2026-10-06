/**
 * Speech-to-text via an OpenAI-compatible /audio/transcriptions endpoint: Groq (free tier,
 * whisper-large-v3-turbo) or OpenAI (whisper-1). Keys come from the environment or the person's
 * key vault (/key GROQ_API_KEY …).
 */
import fs from 'fs';
import path from 'path';
import { Logger, SensePort } from '../types';

export interface SenseConfig {
  name: string;
  url: string;
  key: string;
  model: string;
}

export function senseFromKeys(keys: { groq?: string; openai?: string }): SenseConfig | null {
  if (keys.groq) return { name: 'groq', url: 'https://api.groq.com/openai/v1/audio/transcriptions', key: keys.groq, model: 'whisper-large-v3-turbo' };
  if (keys.openai) return { name: 'openai', url: 'https://api.openai.com/v1/audio/transcriptions', key: keys.openai, model: 'whisper-1' };
  return null;
}

export function createSense(cfg: SenseConfig, opts: { fetchImpl?: typeof fetch; timeoutMs?: number; log?: Logger; maxBytes?: number } = {}): SensePort {
  const doFetch = opts.fetchImpl ?? fetch;
  const maxBytes = opts.maxBytes ?? 25 * 1024 * 1024;
  return {
    name: cfg.name,
    async transcribe(filePath, mime) {
      try {
        const st = fs.statSync(filePath);
        if (!st.isFile() || st.size === 0 || st.size > maxBytes) return null;
        const form = new FormData();
        const name = path.basename(filePath).replace(/\.oga$/, '.ogg');
        form.append('file', new Blob([fs.readFileSync(filePath)], { type: mime || 'audio/ogg' }), name);
        form.append('model', cfg.model);
        form.append('response_format', 'json');
        const res = await doFetch(cfg.url, { method: 'POST', headers: { Authorization: 'Bearer ' + cfg.key }, body: form, signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000) });
        if (!res.ok) {
          opts.log?.warn('transcription failed', { provider: cfg.name, status: res.status, body: (await res.text().catch(() => '')).slice(0, 200).split(cfg.key).join('***') });
          return null;
        }
        const data = (await res.json()) as { text?: string };
        const text = (data.text || '').trim();
        return text || null;
      } catch (err) {
        opts.log?.warn('transcription error', { provider: cfg.name, error: err instanceof Error ? err.message : String(err) });
        return null;
      }
    },
  };
}
