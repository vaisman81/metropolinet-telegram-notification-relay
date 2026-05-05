import 'dotenv/config';
import { createServer } from 'node:http';

const {
  MS_TENANT_ID,
  MS_CLIENT_ID,
  MS_CLIENT_SECRET,
  MS_REDIRECT_URI = 'http://localhost:3001/callback',
} = process.env;

const SCOPES = 'offline_access User.Read Mail.Read';

if (!MS_TENANT_ID || !MS_CLIENT_ID) {
  console.error('Missing MS_TENANT_ID or MS_CLIENT_ID in environment variables.');
  process.exit(1);
}

const redirectUri = new URL(MS_REDIRECT_URI);
const callbackPath = redirectUri.pathname || '/callback';
const port = Number(redirectUri.port || (redirectUri.protocol === 'https:' ? 443 : 80));

const server = createServer(async (req, res) => {
  const requestUrl = new URL(req.url, MS_REDIRECT_URI);

  if (requestUrl.pathname !== callbackPath) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }

  const code = requestUrl.searchParams.get('code');
  const error = requestUrl.searchParams.get('error');
  const errorDescription = requestUrl.searchParams.get('error_description');

  if (error) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`Microsoft sign-in failed: ${error}`);
    console.error('Microsoft sign-in failed', { error, errorDescription });
    server.close();
    return;
  }

  if (!code) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Missing authorization code');
    console.error('Missing authorization code in callback.');
    server.close();
    return;
  }

  try {
    const token = await exchangeCodeForToken(code);

    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Refresh token received. You can close this browser tab.');

    console.log('\nAdd this value to your environment variables:');
    console.log(`MS_REFRESH_TOKEN=${token.refresh_token}`);
  } catch (exchangeError) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Token exchange failed. Check the terminal output.');
    console.error('Token exchange failed', {
      message: exchangeError.message,
      status: exchangeError.status,
      microsoftError: exchangeError.microsoftError,
    });
  } finally {
    server.close();
  }
});

server.listen(port, redirectUri.hostname, () => {
  console.log(`Waiting for Microsoft OAuth callback on ${MS_REDIRECT_URI}`);
  console.log('\nOpen this URL in your browser and sign in:\n');
  console.log(buildAuthorizationUrl());
  console.log('\nAfter sign-in, this script will print MS_REFRESH_TOKEN.');
});

function buildAuthorizationUrl() {
  const url = new URL(
    `https://login.microsoftonline.com/${encodeURIComponent(MS_TENANT_ID)}/oauth2/v2.0/authorize`,
  );

  url.searchParams.set('client_id', MS_CLIENT_ID);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', MS_REDIRECT_URI);
  url.searchParams.set('response_mode', 'query');
  url.searchParams.set('scope', SCOPES);
  url.searchParams.set('prompt', 'select_account');

  return url.toString();
}

async function exchangeCodeForToken(code) {
  const tokenUrl = `https://login.microsoftonline.com/${encodeURIComponent(MS_TENANT_ID)}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    client_id: MS_CLIENT_ID,
    code,
    redirect_uri: MS_REDIRECT_URI,
    grant_type: 'authorization_code',
    scope: SCOPES,
  });

  if (MS_CLIENT_SECRET) {
    body.set('client_secret', MS_CLIENT_SECRET);
  }

  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });

  const responseBody = await response.json().catch(() => null);

  if (!response.ok || !responseBody?.refresh_token) {
    const error = new Error('Microsoft token endpoint did not return a refresh token');
    error.status = response.status;
    error.microsoftError = responseBody?.error;
    throw error;
  }

  return responseBody;
}
