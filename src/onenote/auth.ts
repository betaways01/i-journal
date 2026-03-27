import { config } from '../config';

let currentAccessToken = config.microsoft.accessToken;
let currentRefreshToken = config.microsoft.refreshToken;

export function getAccessToken(): string {
  return currentAccessToken;
}

export async function refreshAccessToken(): Promise<string> {
  if (!currentRefreshToken) {
    throw new Error(
      'No refresh token available. Run `npm run get-token` to obtain Microsoft tokens.'
    );
  }

  const tokenUrl = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/token';

  const params = new URLSearchParams({
    client_id: config.microsoft.clientId,
    client_secret: config.microsoft.clientSecret,
    refresh_token: currentRefreshToken,
    grant_type: 'refresh_token',
    scope: 'offline_access Notes.ReadWrite User.Read',
  });

  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to refresh Microsoft token: ${error}`);
  }

  const data = (await response.json()) as { access_token: string; refresh_token?: string };
  currentAccessToken = data.access_token;
  if (data.refresh_token) {
    currentRefreshToken = data.refresh_token;
  }

  console.log('[OneNote] Access token refreshed successfully');
  return currentAccessToken;
}

export async function getValidToken(): Promise<string> {
  if (!currentAccessToken) {
    return refreshAccessToken();
  }
  return currentAccessToken;
}
