import express from 'express';
import { Server } from 'http';
import { Telegraf } from '../bot';
import { config, hasMicrosoftOAuthConfigured } from '../config';
import { getUserById } from '../db/users.repo';
import {
  parseMicrosoftAuthState,
  saveMicrosoftConnectionFromCode,
} from '../onenote/auth';

let server: Server | null = null;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderPage(title: string, message: string): string {
  const safeTitle = escapeHtml(title);
  const safeMessage = escapeHtml(message);

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${safeTitle}</title>
    <style>
      body {
        margin: 0;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background: #111827;
        color: #f9fafb;
        min-height: 100vh;
        display: grid;
        place-items: center;
      }

      main {
        width: min(92vw, 520px);
        padding: 32px 24px;
        background: #1f2937;
        border: 1px solid #374151;
        border-radius: 8px;
      }

      h1 {
        margin: 0 0 12px;
        font-size: 24px;
      }

      p {
        margin: 0;
        line-height: 1.5;
        color: #d1d5db;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>${safeTitle}</h1>
      <p>${safeMessage}</p>
    </main>
  </body>
</html>`;
}

function microsoftFailureMessage(description: string): string {
  if (description.includes('AADSTS50020')) {
    return (
      'Microsoft rejected this account because the Azure app is not configured for personal Microsoft accounts. ' +
      'In Azure Portal, set Supported account types to "Accounts in any organizational directory and personal Microsoft accounts", ' +
      'then try again from Telegram.'
    );
  }

  // Our own OneNote-not-usable / license messages are already user-friendly — pass them through.
  if (/personal Microsoft account|OneNote isn't reachable|30121|SharePoint license/i.test(description)) {
    return description;
  }

  if (description) {
    return `Microsoft sign-in failed: ${description}`;
  }

  return 'The Microsoft sign-in did not finish cleanly. Start again from Telegram.';
}

export function startWebServer(bot: Telegraf): void {
  if (server) return;

  const app = express();

  app.get('/health', (_req, res) => {
    res.json({ ok: true, service: 'i-journal-web' });
  });

  app.get('/auth/callback', async (req, res) => {
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    const oauthError = typeof req.query.error === 'string' ? req.query.error : '';
    const oauthErrorDescription =
      typeof req.query.error_description === 'string' ? req.query.error_description : '';

    if (oauthError) {
      const message = microsoftFailureMessage(oauthErrorDescription || oauthError);

      if (state) {
        try {
          const userId = parseMicrosoftAuthState(state);
          const user = getUserById(userId);
          if (user) {
            await bot.telegram.sendMessage(user.telegram_id, `OneNote connection failed.\n\n${message}`).catch((error) => {
              console.error('[Web] Failed to send OneNote failure message to Telegram:', error);
            });
          }
        } catch {
          // State may be missing or expired; still render the useful page.
        }
      }

      res.status(400).send(renderPage('Connection Failed', message));
      return;
    }

    if (!code || !state) {
      res
        .status(400)
        .send(renderPage('Connection Failed', 'Missing Microsoft OAuth details. Start again from Telegram.'));
      return;
    }

    try {
      const userId = parseMicrosoftAuthState(state);
      const user = getUserById(userId);

      if (!user) {
        res
          .status(404)
          .send(renderPage('Connection Failed', 'That journal user could not be found anymore.'));
        return;
      }

      const profile = await saveMicrosoftConnectionFromCode(userId, code);

      await bot.telegram.sendMessage(
        user.telegram_id,
        `✅ OneNote connected.\n\nSigned in as ${profile.displayName}${profile.email ? `\n${profile.email}` : ''}`
      ).catch((error) => {
        console.error('[Web] Failed to send OneNote success message to Telegram:', error);
      });

      res.send(
        renderPage('OneNote Connected', 'You can return to Telegram. Your journal can now sync to your own OneNote.')
      );
    } catch (error) {
      console.error('[Web] Microsoft callback failed:', error);
      const message = microsoftFailureMessage(error instanceof Error ? error.message : String(error));

      // Tell the user in Telegram too, where they actually are — not only on this web page.
      try {
        const user = getUserById(parseMicrosoftAuthState(state));
        if (user) {
          await bot.telegram
            .sendMessage(user.telegram_id, `OneNote was not connected.\n\n${message}`)
            .catch(() => {});
        }
      } catch {
        // state missing/expired — just render the page
      }

      res.status(500).send(renderPage('Connection Failed', message));
    }
  });

  server = app.listen(config.web.port, () => {
    const oauthSuffix = hasMicrosoftOAuthConfigured() ? ' with Microsoft callback enabled' : '';
    console.log(`[Web] Listening on http://localhost:${config.web.port}${oauthSuffix}`);
  });

  server.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE') {
      console.error(
        `[Web] Port ${config.web.port} is already in use. ` +
          `Set PORT and MICROSOFT_REDIRECT_URI to a free port before using /storage connect.`
      );
      server = null;
      return;
    }

    console.error('[Web] Server error:', error);
    server = null;
  });
}

export function closeWebServer(): void {
  if (!server) return;
  server.close();
  server = null;
}
