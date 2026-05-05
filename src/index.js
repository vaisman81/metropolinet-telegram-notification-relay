import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import express from 'express';

const {
  PORT = '3000',
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
  SHARED_SECRET,
} = process.env;

const REQUIRED_ENV = {
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
  SHARED_SECRET,
};

const missingEnv = Object.entries(REQUIRED_ENV)
  .filter(([, value]) => !value)
  .map(([key]) => key);

if (missingEnv.length > 0) {
  console.error(`Missing required environment variables: ${missingEnv.join(', ')}`);
  process.exit(1);
}

const app = express();

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
