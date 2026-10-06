/**
 * The small web server: Telegram webhook (production), the Microsoft sign-in callback, and /health.
 */
import express from 'express';
import { Server } from 'http';
import { Telegraf } from 'telegraf';
import { Logger } from '../core/types';

export interface WebOptions {
  port: number;
  log: Logger;
  webhook?: { bot: Telegraf; path: string; secretToken: string };
  /** Finishes a Microsoft sign-in. */
  oauth?: {
    complete(state: string, code: string): Promise<{ ok: boolean; title: string; message: string }>;
    failed(state: string, description: string): Promise<{ title: string; message: string }>;
  };
  health(): Record<string, unknown>;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function page(title: string, message: string): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><title>${escapeHtml(title)}</title>
<style>body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#111827;color:#f9fafb;min-height:100vh;display:grid;place-items:center}
main{width:min(92vw,520px);padding:32px 24px;background:#1f2937;border:1px solid #374151;border-radius:8px}h1{margin:0 0 12px;font-size:24px}p{margin:0;line-height:1.5;color:#d1d5db}</style>
</head><body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></main></body></html>`;
}

export function startWebServer(opts: WebOptions): { close(): void } {
  const app = express();
  app.disable('x-powered-by');
  const { log } = opts;

  // Mounted before any body parser so telegraf reads the raw update; the secret is checked per request.
  if (opts.webhook) {
    app.use(opts.webhook.bot.webhookCallback(opts.webhook.path, { secretToken: opts.webhook.secretToken }));
    log.info('telegram webhook endpoint mounted', { path: opts.webhook.path });
  }

  app.get('/health', (_req, res) => {
    res.json({ ok: true, service: 'i-journal', ...opts.health() });
  });

  app.get('/auth/callback', async (req, res) => {
    const q = (k: string) => (typeof req.query[k] === 'string' ? (req.query[k] as string) : '');
    const state = q('state');
    if (!opts.oauth) {
      res.status(404).send(page('Not available', 'OneNote is not set up on this server.'));
      return;
    }
    try {
      if (q('error')) {
        const r = await opts.oauth.failed(state, q('error_description') || q('error'));
        res.status(400).send(page(r.title, r.message));
        return;
      }
      if (!q('code') || !state) {
        res.status(400).send(page('Sign-in incomplete', 'Microsoft did not send the details back. Ask the bot for a new link.'));
        return;
      }
      const r = await opts.oauth.complete(state, q('code'));
      res.status(r.ok ? 200 : 400).send(page(r.title, r.message));
    } catch (err) {
      log.error('oauth callback crashed', { error: err instanceof Error ? err.stack || err.message : String(err) });
      res.status(500).send(page('Something went wrong', 'The sign-in could not be finished. Ask the bot for a new link.'));
    }
  });

  let server: Server | null = app.listen(opts.port, () => log.info('web server listening', { port: opts.port }));
  server.on('error', (error: NodeJS.ErrnoException) => {
    log.error(error.code === 'EADDRINUSE' ? `port ${opts.port} is in use; set PORT to a free one` : 'web server error', { error: error.message });
    server = null;
  });
  return {
    close() {
      server?.close();
      server = null;
    },
  };
}
