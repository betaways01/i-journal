import dotenv from 'dotenv';
import http from 'http';
import url from 'url';

dotenv.config();

const CLIENT_ID = process.env.MICROSOFT_CLIENT_ID!;
const CLIENT_SECRET = process.env.MICROSOFT_CLIENT_SECRET!;
const REDIRECT_URI = process.env.MICROSOFT_REDIRECT_URI || 'http://localhost:3000/auth/callback';
const SCOPES = 'offline_access Notes.ReadWrite User.Read';

const AUTHORITY = 'https://login.microsoftonline.com/consumers';

const AUTH_URL =
  `${AUTHORITY}/oauth2/v2.0/authorize?` +
  `client_id=${CLIENT_ID}` +
  `&response_type=code` +
  `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
  `&scope=${encodeURIComponent(SCOPES)}` +
  `&response_mode=query`;

const TOKEN_URL = `${AUTHORITY}/oauth2/v2.0/token`;

console.log('\n=== Microsoft OAuth Token Helper ===\n');
console.log('Open this URL in your browser:\n');
console.log(AUTH_URL);
console.log('\nWaiting for callback on http://localhost:3000...\n');

const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url || '', true);

  if (parsedUrl.pathname === '/auth/callback') {
    const code = parsedUrl.query.code as string;

    if (!code) {
      res.writeHead(400);
      res.end('Error: No authorization code received.');
      return;
    }

    try {
      const params = new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code,
        redirect_uri: REDIRECT_URI,
        grant_type: 'authorization_code',
        scope: SCOPES,
      });

      const response = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
      });

      const data = (await response.json()) as {
        access_token?: string;
        refresh_token?: string;
        error?: string;
        error_description?: string;
      };

      if (data.error) {
        res.writeHead(400);
        res.end(`Error: ${data.error_description}`);
        console.error('Token error:', data.error_description);
        server.close();
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<h1>Success!</h1><p>You can close this window. Check your terminal for the tokens.</p>');

      console.log('\n=== TOKENS ===\n');
      console.log(`MICROSOFT_ACCESS_TOKEN=${data.access_token}\n`);
      console.log(`MICROSOFT_REFRESH_TOKEN=${data.refresh_token}\n`);
      console.log('Copy these values into your .env file.\n');

      server.close();
      process.exit(0);
    } catch (error) {
      res.writeHead(500);
      res.end('Internal error during token exchange.');
      console.error('Token exchange error:', error);
      server.close();
    }
  }
});

server.listen(3000);
