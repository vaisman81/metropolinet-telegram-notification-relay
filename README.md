# Metropolinet Telegram Notification Relay

Небольшой Node.js + Express сервис для уведомлений в Telegram о новых задачах из Outlook.

Поддерживаются три режима:

- `Gmail IMAP polling` - рекомендуемый бесплатный вариант. Outlook серверно форвардит письма с `TODO` на Gmail, сервис на Render читает Gmail по IMAP и шлет Telegram.
- `Power Automate webhook` - Power Automate отправляет HTTP POST в сервис. Этот режим обычно требует Premium/trial.
- `Microsoft Graph polling` - оставлен как опция, но в корпоративных tenant часто требует Entra admin consent.

Сервис не сохраняет письма в базу данных и не логирует полный текст письма.

## Что приходит в Telegram

```text
Новая задача в Metropolinet
От: sender@example.com
Тема: TODO something
Получено: 2026-05-05 13:00
```

Время форматируется в часовом поясе `Asia/Jerusalem`.

## Установка

```bash
npm install
cp .env.example .env
```

На Windows PowerShell:

```powershell
npm install
Copy-Item .env.example .env
```

Запуск:

```bash
npm start
```

Проверка:

```bash
curl http://localhost:3000/health
```

## Telegram bot

1. Откройте Telegram и найдите `@BotFather`.
2. Отправьте `/newbot`.
3. Задайте имя и username.
4. BotFather выдаст token вида `123456789:ABC...`.
5. Запишите token в `TELEGRAM_BOT_TOKEN`.

## TELEGRAM_CHAT_ID

1. Напишите боту сообщение, например `/start`.
2. Откройте:

```text
https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/getUpdates
```

3. Найдите `message.chat.id`.
4. Запишите значение в `TELEGRAM_CHAT_ID`.

## Вариант A: бесплатный Gmail polling

Это основной вариант, если Microsoft tenant не дает Graph permissions.

Схема:

```text
Outlook mailbox -> server-side forward/rule -> Gmail -> IMAP polling on Render -> Telegram
```

Работает с выключенным компьютером, если:

- правило форвардинга создано как серверное правило в Outlook/Exchange;
- сервис развернут на Render/Railway/Azure, а не локально.

### 1. Настроить Gmail

Используйте Gmail ящик:

```text
dvsoftmaster@gmail.com
```

В Gmail:

1. Включите IMAP:
   - `Settings` -> `See all settings` -> `Forwarding and POP/IMAP` -> `Enable IMAP`
2. Если включена двухфакторная защита Google, создайте `App password`:
   - `Google Account` -> `Security` -> `2-Step Verification` -> `App passwords`
3. Создайте app password, например для `Mail`.

Этот app password пойдет в `GMAIL_IMAP_PASSWORD`.

### 2. Переменные окружения для Gmail polling

Минимальные переменные:

```env
PORT=3000
TELEGRAM_BOT_TOKEN=123456789:your_bot_token
TELEGRAM_CHAT_ID=123456789

GMAIL_POLLING_ENABLED=true
GMAIL_POLL_INTERVAL_SECONDS=120
GMAIL_STATE_FILE=.data/gmail-state.json
GMAIL_IMAP_HOST=imap.gmail.com
GMAIL_IMAP_PORT=993
GMAIL_IMAP_SECURE=true
GMAIL_IMAP_USER=dvsoftmaster@gmail.com
GMAIL_IMAP_PASSWORD=your_gmail_app_password
GMAIL_IMAP_MAILBOX=INBOX
GMAIL_IMAP_MARK_SEEN=true

TODO_SUBJECT_KEYWORD=TODO
```

Как это работает:

- сервис ищет непрочитанные письма в Gmail Inbox;
- если в теме есть `TODO`, шлет уведомление в Telegram;
- после успешной отправки может пометить письмо как `Seen`;
- хранит только техническое состояние в `.data/gmail-state.json`.

Текст письма сервис не читает и не логирует.

### 3. Настроить Outlook server-side rule

Нужна именно серверная пересылка, чтобы она работала с выключенным компьютером.

В Outlook Web:

1. Откройте [https://outlook.office.com](https://outlook.office.com)
2. `Settings` -> `Mail` -> `Rules`
3. Создайте правило:
   - Condition: `Subject includes` -> `TODO`
   - Action: `Forward to` -> `dvsoftmaster@gmail.com`

Если tenant запрещает forwarding наружу, правило не сработает. Это ограничение Exchange/Metropolinet, не нашего сервиса.

Альтернатива:

- если серверный forward запрещен, можно использовать почтовый ящик вне tenant как промежуточный адрес, который у вас под контролем;
- но если Metropolinet блокирует external forwarding полностью, это придется решать с администраторами.

### 4. Deploy на Render

1. Создайте Web Service из GitHub repository.
2. Build command:

```text
npm install
```

3. Start command:

```text
npm start
```

4. Добавьте environment variables из блока выше.

5. Health URL:

```text
https://your-render-app.onrender.com/health
```

Важно для Render Free:

- web service может засыпать без входящего трафика;
- пока сервис спит, polling не идет;
- для стабильной работы нужен внешний ping на `/health` или always-on хостинг.

## Вариант B: Power Automate webhook

Endpoint:

```text
POST /webhook/power-automate
```

Headers:

```text
Content-Type: application/json
X-Webhook-Secret: значение SHARED_SECRET
```

Body:

```json
{
  "from": "sender@example.com",
  "subject": "TODO something",
  "received": "2026-05-05T10:00:00Z",
  "bodyPreview": "short preview"
}
```

Ошибки:

- `400` - пустое или неправильное тело запроса
- `401` - неправильный `X-Webhook-Secret`
- `502` - Telegram API вернул ошибку
- `500` - внутренняя ошибка сервиса

## Вариант C: Microsoft Graph polling

Этот режим оставлен в коде, но обычно упирается в Entra admin consent.

Переменные:

```env
GRAPH_POLLING_ENABLED=true
MS_TENANT_ID=...
MS_CLIENT_ID=...
MS_CLIENT_SECRET=...
MS_REFRESH_TOKEN=...
MS_MAILBOX_USER=dmitry.vaisman@metropolinet.co.il
```

Если tenant не дает `Mail.Read`, используйте Gmail polling.

## Безопасность и приватность

- `TELEGRAM_BOT_TOKEN`, `GMAIL_IMAP_PASSWORD`, `SHARED_SECRET`, `MS_CLIENT_SECRET`, `MS_REFRESH_TOKEN` хранятся только в переменных окружения.
- `.env` добавлен в `.gitignore`.
- Сервис не сохраняет письма в базу данных.
- Сервис не логирует текст письма.
- В логах остается только техническая информация: отправитель, длина темы, время получения, message id или uid.
