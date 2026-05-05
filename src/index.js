import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import { ImapFlow } from 'imapflow';

const {
  PORT = '3000',
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
  SHARED_SECRET,
  GMAIL_POLLING_ENABLED = 'false',
  GMAIL_POLL_INTERVAL_SECONDS = '120',
  GMAIL_STATE_FILE = '.data/gmail-state.json',
  GMAIL_IMAP_HOST = 'imap.gmail.com',
  GMAIL_IMAP_PORT = '993',
  GMAIL_IMAP_SECURE = 'true',
  GMAIL_IMAP_USER,
  GMAIL_IMAP_PASSWORD,
  GMAIL_IMAP_MAILBOX = 'INBOX',
  GMAIL_IMAP_MARK_SEEN = 'true',
  GRAPH_POLLING_ENABLED = 'false',
  GRAPH_POLL_INTERVAL_SECONDS = '120',
  GRAPH_LOOKBACK_MINUTES = '5',
  GRAPH_STATE_FILE = '.data/graph-state.json',
  TODO_SUBJECT_KEYWORD = 'TODO',
  MS_TENANT_ID,
  MS_CLIENT_ID,
  MS_CLIENT_SECRET,
  MS_REFRESH_TOKEN,
  MS_MAILBOX_USER = 'me',
} = process.env;

const REQUIRED_ENV = {
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
};

const isGmailPollingEnabled = GMAIL_POLLING_ENABLED.toLowerCase() === 'true';
const isGraphPollingEnabled = GRAPH_POLLING_ENABLED.toLowerCase() === 'true';

if (SHARED_SECRET) {
  REQUIRED_ENV.SHARED_SECRET = SHARED_SECRET;
}

if (isGraphPollingEnabled) {
  Object.assign(REQUIRED_ENV, {
    MS_TENANT_ID,
    MS_CLIENT_ID,
    MS_REFRESH_TOKEN,
  });
}

if (isGmailPollingEnabled) {
  Object.assign(REQUIRED_ENV, {
    GMAIL_IMAP_USER,
    GMAIL_IMAP_PASSWORD,
  });
}

const missingEnv = Object.entries(REQUIRED_ENV)
  .filter(([, value]) => !value)
  .map(([key]) => key);

if (missingEnv.length > 0) {
  console.error(`Missing required environment variables: ${missingEnv.join(', ')}`);
  process.exit(1);
}

if (!SHARED_SECRET) {
  console.warn('SHARED_SECRET is not set. The Power Automate webhook endpoint is disabled.');
}

const app = express();
let graphPollTimer;
let graphPollInProgress = false;
let currentMicrosoftRefreshToken = MS_REFRESH_TOKEN;
let gmailPollTimer;
let gmailPollInProgress = false;

app.use(
  express.json({
    limit: '64kb',
    strict: true,
  }),
);

app.get('/health', (_req, res) => {
  res.status(200).json({ ok: true });
});

app.post('/webhook/power-automate', async (req, res) => {
  const requestId = randomUUID();

  if (!SHARED_SECRET) {
    return res.status(404).json({ ok: false, error: 'webhook_disabled' });
  }

  const secret = req.get('X-Webhook-Secret');

  if (secret !== SHARED_SECRET) {
    console.warn(`[${requestId}] Unauthorized webhook request`);
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  const validation = validateWebhookPayload(req.body);
  if (!validation.ok) {
    console.warn(`[${requestId}] Bad webhook payload: ${validation.error}`);
    return res.status(400).json({ ok: false, error: validation.error });
  }

  const { from, subject, received } = validation.data;
  const message = formatTelegramMessage({ from, subject, received });

  try {
    await sendTelegramMessage(message);
    console.info(`[${requestId}] Telegram notification sent`, {
      from,
      subjectLength: subject.length,
      received,
    });
    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error(`[${requestId}] Telegram API error`, {
      message: error.message,
      status: error.status,
      telegramDescription: error.telegramDescription,
    });
    return res.status(502).json({ ok: false, error: 'telegram_api_error' });
  }
});

app.use((err, _req, res, _next) => {
  if (err instanceof SyntaxError && 'body' in err) {
    return res.status(400).json({ ok: false, error: 'invalid_json' });
  }

  console.error('Unhandled server error', { message: err.message });
  return res.status(500).json({ ok: false, error: 'internal_server_error' });
});

app.listen(Number(PORT), () => {
  console.info(`Notification relay is listening on port ${PORT}`);

  if (isGmailPollingEnabled) {
    startGmailPolling();
  }

  if (isGraphPollingEnabled) {
    startGraphPolling();
  }
});

function validateWebhookPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, error: 'request_body_must_be_json_object' };
  }

  const from = normalizeString(payload.from);
  const subject = normalizeString(payload.subject);
  const received = normalizeString(payload.received);

  if (!from) {
    return { ok: false, error: 'from_is_required' };
  }

  if (!subject) {
    return { ok: false, error: 'subject_is_required' };
  }

  if (!received) {
    return { ok: false, error: 'received_is_required' };
  }

  return {
    ok: true,
    data: {
      from,
      subject,
      received,
    },
  };
}

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function formatTelegramMessage({ from, subject, received }) {
  return [
    '<b>Новая задача в Metropolinet</b>',
    `От: ${escapeHtml(from)}`,
    `Тема: ${escapeHtml(subject)}`,
    `Получено: ${escapeHtml(formatReceivedTime(received))}`,
  ].join('\n');
}

function formatReceivedTime(value) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Jerusalem',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

function escapeHtml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

async function sendTelegramMessage(text) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }),
  });

  const responseBody = await readTelegramResponse(response);

  if (!response.ok || responseBody?.ok === false) {
    const error = new Error('Telegram request failed');
    error.status = response.status;
    error.telegramDescription = responseBody?.description;
    throw error;
  }
}

async function readTelegramResponse(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function startGmailPolling() {
  const intervalMs = Math.max(Number(GMAIL_POLL_INTERVAL_SECONDS) || 120, 30) * 1000;

  console.info('Gmail IMAP polling is enabled', {
    mailbox: GMAIL_IMAP_MAILBOX,
    username: GMAIL_IMAP_USER,
    keyword: TODO_SUBJECT_KEYWORD,
    intervalSeconds: intervalMs / 1000,
  });

  void pollGmailInbox();
  gmailPollTimer = setInterval(() => {
    void pollGmailInbox();
  }, intervalMs);
  gmailPollTimer.unref?.();
}

async function pollGmailInbox() {
  if (gmailPollInProgress) {
    return;
  }

  const requestId = randomUUID();
  gmailPollInProgress = true;

  try {
    const state = await loadMessageState(GMAIL_STATE_FILE);
    const client = new ImapFlow({
      host: GMAIL_IMAP_HOST,
      port: Number(GMAIL_IMAP_PORT),
      secure: GMAIL_IMAP_SECURE.toLowerCase() === 'true',
      auth: {
        user: GMAIL_IMAP_USER,
        pass: GMAIL_IMAP_PASSWORD,
      },
      logger: false,
    });
    client.on('error', (error) => {
      console.warn(`[${requestId}] Gmail IMAP client error`, {
        message: error.message,
        code: error.code,
      });
    });

    await client.connect();
    await client.mailboxOpen(GMAIL_IMAP_MAILBOX, { readOnly: false });

    const unseen = await client.search({ seen: false });

    for (const uid of unseen) {
      const message = await client.fetchOne(uid, {
        uid: true,
        envelope: true,
        internalDate: true,
        flags: true,
      });

      const messageId = normalizeString(message?.envelope?.messageId) || `uid:${uid}`;
      const subject = normalizeString(message?.envelope?.subject);

      if (state.seenMessageIds.includes(messageId)) {
        continue;
      }

      if (!subject.toLowerCase().includes(TODO_SUBJECT_KEYWORD.toLowerCase())) {
        continue;
      }

      const from = getImapEnvelopeSender(message?.envelope);
      const received = message?.internalDate?.toISOString() || new Date().toISOString();

      await sendTelegramMessage(formatTelegramMessage({ from, subject, received }));

      if (GMAIL_IMAP_MARK_SEEN.toLowerCase() === 'true') {
        await client.messageFlagsAdd(uid, ['\\Seen']);
      }

      state.lastReceivedDateTime = maxIsoDate(state.lastReceivedDateTime, received);
      state.seenMessageIds = trimSeenMessageIds([...state.seenMessageIds, messageId]);
      await saveMessageState(GMAIL_STATE_FILE, state);

      console.info(`[${requestId}] Gmail TODO notification sent`, {
        uid,
        messageId,
        from,
        subjectLength: subject.length,
        received,
      });
    }

    await client.logout();
  } catch (error) {
    console.error(`[${requestId}] Gmail polling error`, {
      message: error.message,
      code: error.code,
    });
  } finally {
    gmailPollInProgress = false;
  }
}

function getImapEnvelopeSender(envelope) {
  const sender = envelope?.from?.[0];
  return normalizeString(sender?.address) || normalizeString(sender?.name) || 'unknown';
}

function startGraphPolling() {
  const intervalMs = Math.max(Number(GRAPH_POLL_INTERVAL_SECONDS) || 120, 30) * 1000;

  console.info('Microsoft Graph polling is enabled', {
    mailbox: MS_MAILBOX_USER,
    keyword: TODO_SUBJECT_KEYWORD,
    intervalSeconds: intervalMs / 1000,
  });

  void pollMicrosoftGraph();
  graphPollTimer = setInterval(() => {
    void pollMicrosoftGraph();
  }, intervalMs);
  graphPollTimer.unref?.();
}

async function pollMicrosoftGraph() {
  if (graphPollInProgress) {
    return;
  }

  const requestId = randomUUID();
  graphPollInProgress = true;

  try {
    const state = await loadGraphState();
    const since = state.lastReceivedDateTime || getInitialGraphSince();
    const accessToken = await getMicrosoftAccessToken();
    const messages = await fetchRecentInboxMessages(accessToken, since);
    const todoMessages = messages.filter(isTodoMessage);

    for (const message of todoMessages) {
      if (state.seenMessageIds.includes(message.id)) {
        continue;
      }

      const from = getGraphMessageSender(message);
      const subject = normalizeString(message.subject) || '(без темы)';
      const received = normalizeString(message.receivedDateTime);

      await sendTelegramMessage(formatTelegramMessage({ from, subject, received }));

      state.lastReceivedDateTime = maxIsoDate(state.lastReceivedDateTime, received);
      state.seenMessageIds = trimSeenMessageIds([...state.seenMessageIds, message.id]);
      await saveGraphState(state);

      console.info(`[${requestId}] Graph TODO notification sent`, {
        messageId: message.id,
        from,
        subjectLength: subject.length,
        received,
      });
    }

    if (messages.length > 0) {
      const latestReceived = messages
        .map((message) => normalizeString(message.receivedDateTime))
        .filter(Boolean)
        .reduce(maxIsoDate, state.lastReceivedDateTime);

      if (latestReceived !== state.lastReceivedDateTime) {
        state.lastReceivedDateTime = latestReceived;
        await saveGraphState(state);
      }
    }
  } catch (error) {
    console.error(`[${requestId}] Microsoft Graph polling error`, {
      message: error.message,
      status: error.status,
      graphCode: error.graphCode,
    });
  } finally {
    graphPollInProgress = false;
  }
}

async function getMicrosoftAccessToken() {
  const tokenUrl = `https://login.microsoftonline.com/${encodeURIComponent(MS_TENANT_ID)}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    client_id: MS_CLIENT_ID,
    grant_type: 'refresh_token',
    refresh_token: currentMicrosoftRefreshToken,
    scope: 'offline_access User.Read Mail.Read',
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

  if (!response.ok) {
    const error = new Error('Microsoft token refresh failed');
    error.status = response.status;
    error.graphCode = responseBody?.error;
    throw error;
  }

  if (responseBody.refresh_token) {
    currentMicrosoftRefreshToken = responseBody.refresh_token;
  }

  return responseBody.access_token;
}

async function fetchRecentInboxMessages(accessToken, since) {
  const userPath =
    MS_MAILBOX_USER.toLowerCase() === 'me'
      ? 'me'
      : `users/${encodeURIComponent(MS_MAILBOX_USER)}`;
  const url = new URL(`https://graph.microsoft.com/v1.0/${userPath}/mailFolders/inbox/messages`);

  url.searchParams.set('$top', '25');
  url.searchParams.set('$select', 'id,subject,from,receivedDateTime');
  url.searchParams.set('$orderby', 'receivedDateTime asc');
  url.searchParams.set('$filter', `receivedDateTime ge ${since}`);

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Prefer: 'outlook.body-content-type="text"',
    },
  });

  const responseBody = await response.json().catch(() => null);

  if (!response.ok) {
    const error = new Error('Microsoft Graph messages request failed');
    error.status = response.status;
    error.graphCode = responseBody?.error?.code;
    throw error;
  }

  return Array.isArray(responseBody?.value) ? responseBody.value : [];
}

function isTodoMessage(message) {
  const subject = normalizeString(message.subject).toLowerCase();
  return subject.includes(TODO_SUBJECT_KEYWORD.toLowerCase());
}

function getGraphMessageSender(message) {
  return (
    normalizeString(message.from?.emailAddress?.address) ||
    normalizeString(message.from?.emailAddress?.name) ||
    'unknown'
  );
}

async function loadGraphState() {
  return loadMessageState(GRAPH_STATE_FILE);
}

async function saveGraphState(state) {
  return saveMessageState(GRAPH_STATE_FILE, state);
}

async function loadMessageState(stateFile) {
  try {
    const raw = await readFile(stateFile, 'utf8');
    const parsed = JSON.parse(raw);

    return {
      lastReceivedDateTime: normalizeString(parsed.lastReceivedDateTime),
      seenMessageIds: Array.isArray(parsed.seenMessageIds)
        ? parsed.seenMessageIds.filter((id) => typeof id === 'string')
        : [],
    };
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn('Could not read Graph state file, starting with fresh state', {
        message: error.message,
      });
    }

    return {
      lastReceivedDateTime: '',
      seenMessageIds: [],
    };
  }
}

async function saveMessageState(stateFile, state) {
  await mkdir(path.dirname(stateFile), { recursive: true });
  await writeFile(
    stateFile,
    `${JSON.stringify(
      {
        lastReceivedDateTime: state.lastReceivedDateTime,
        seenMessageIds: trimSeenMessageIds(state.seenMessageIds),
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
}

function getInitialGraphSince() {
  const lookbackMinutes = Math.max(Number(GRAPH_LOOKBACK_MINUTES) || 0, 0);
  return new Date(Date.now() - lookbackMinutes * 60 * 1000).toISOString();
}

function maxIsoDate(current, next) {
  if (!current) {
    return next;
  }

  if (!next) {
    return current;
  }

  return new Date(next).getTime() > new Date(current).getTime() ? next : current;
}

function trimSeenMessageIds(ids) {
  return [...new Set(ids)].slice(-200);
}
