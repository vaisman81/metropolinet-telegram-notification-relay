# Metropolinet Telegram Notification Relay

Небольшой Node.js + Express сервис для уведомлений в Telegram о новых задачах из Microsoft 365 / Outlook.

Есть два режима:

- **Microsoft Graph polling**: сервис сам проверяет Inbox в Outlook и ищет письма с `TODO` в теме. Это основной вариант без Power Automate Premium.
- **Power Automate webhook**: Power Automate отправляет HTTP POST в сервис. Этот режим оставлен для совместимости, но action `HTTP` обычно требует Power Automate Premium/trial.

Сервис не сохраняет письма в базу данных и не логирует полный текст письма.

## Что приходит в Telegram

```text
Новая задача в Metropolinet
От: sender@example.com
Тема: TODO something
Получено: 2026-05-05 13:00
```

Время форматируется в часовом поясе `Asia/Jerusalem`.

## Требования

- Node.js 18 или новее
- Telegram bot token
- Telegram chat_id
- Для бесплатного режима: Azure App Registration с delegated permissions `Mail.Read`, `User.Read`, `offline_access`
- Для webhook режима: `SHARED_SECRET` и Power Automate plan/trial, который разрешает action `HTTP`

Платные внешние API не используются.

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

Не храните token в коде и не публикуйте `.env`.

## TELEGRAM_CHAT_ID

1. Напишите любое сообщение созданному боту, например `/start`.
2. Откройте:

```text
https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/getUpdates
```

3. Найдите `message.chat.id`.
4. Запишите это значение в `TELEGRAM_CHAT_ID`.

Для группы добавьте бота в группу, отправьте сообщение в группу и так же проверьте `getUpdates`. У групп `chat.id` часто отрицательный.

## Вариант A: без Power Automate Premium

Этот режим использует Microsoft Graph. Сервис раз в несколько минут проверяет Inbox пользователя `dmitry.vaisman@metropolinet.co.il`, выбирает новые письма с `TODO` в теме и отправляет короткое уведомление в Telegram.

### 1. Azure App Registration

Войдите в Azure Portal тем же Microsoft 365 аккаунтом.

1. Откройте **Microsoft Entra ID**.
2. Откройте **App registrations**.
3. Нажмите **New registration**.
4. Name: `Metropolinet Telegram Notification Relay`.
5. Supported account types: обычно достаточно `Accounts in this organizational directory only`.
6. Redirect URI:
   - Platform: `Web`
   - URL: `http://localhost:3001/callback`
7. Создайте приложение.

Скопируйте:

- `Application (client) ID` -> `MS_CLIENT_ID`
- `Directory (tenant) ID` -> `MS_TENANT_ID`

### 2. API permissions

В созданном приложении откройте **API permissions**:

1. Нажмите **Add a permission**.
2. Выберите **Microsoft Graph**.
3. Выберите **Delegated permissions**.
4. Добавьте:
   - `Mail.Read`
   - `User.Read`
   - `offline_access`
5. Если Azure попросит admin consent, его должен подтвердить администратор tenant. В некоторых tenant delegated `Mail.Read` может работать после обычного user consent.

### 3. Client secret

В **Certificates & secrets** создайте новый **Client secret**.

Скопируйте `Value` сразу после создания и запишите в `MS_CLIENT_SECRET`. Потом Azure больше не покажет это значение.

### 4. Получить refresh token

Заполните в `.env`:

```env
MS_TENANT_ID=45abff8b-eeda-41e5-99d4-2e7def6de1fe
MS_CLIENT_ID=client-id-from-azure
MS_CLIENT_SECRET=secret-value-from-azure
MS_REDIRECT_URI=http://localhost:3001/callback
```

Запустите:

```bash
npm run auth:microsoft
```

Скрипт напечатает ссылку Microsoft sign-in. Откройте её в браузере, войдите в аккаунт `dmitry.vaisman@metropolinet.co.il` и разрешите доступ. После callback скрипт напечатает:

```env
MS_REFRESH_TOKEN=...
```

Добавьте это значение в `.env` и в environment variables на Render/Railway/Azure.

### 5. Включить polling

Минимальные переменные:

```env
TELEGRAM_BOT_TOKEN=123456789:your_bot_token
TELEGRAM_CHAT_ID=123456789

GRAPH_POLLING_ENABLED=true
GRAPH_POLL_INTERVAL_SECONDS=120
GRAPH_LOOKBACK_MINUTES=5
TODO_SUBJECT_KEYWORD=TODO
MS_TENANT_ID=45abff8b-eeda-41e5-99d4-2e7def6de1fe
MS_CLIENT_ID=client-id-from-azure
MS_CLIENT_SECRET=secret-value-from-azure
MS_REFRESH_TOKEN=refresh-token-from-helper
MS_MAILBOX_USER=dmitry.vaisman@metropolinet.co.il
```

`GRAPH_LOOKBACK_MINUTES=5` означает: при первом запуске сервис проверит только последние 5 минут, чтобы не отправить старые письма. Дальше он хранит минимальное состояние в `.data/graph-state.json`: последнее время письма и последние обработанные message ids. Текст писем там не сохраняется.

Важно для Render Free: web service может засыпать при отсутствии HTTP-трафика. Когда он спит, polling тоже не выполняется. Для стабильной бесплатной работы добавьте внешний ping на `/health` или используйте другой always-on хостинг.

## Вариант B: Power Automate webhook

Power Automate отправляет HTTP POST:

```json
{
  "from": "sender@example.com",
  "subject": "TODO something",
  "received": "2026-05-05T10:00:00Z",
  "bodyPreview": "short preview"
}
```

Endpoint:

```text
POST /webhook/power-automate
```

Headers:

```text
Content-Type: application/json
X-Webhook-Secret: значение SHARED_SECRET
```

Успешный ответ:

```json
{ "ok": true }
```

Ошибки:

- `400` - пустое или неправильное тело запроса
- `401` - неправильный `X-Webhook-Secret`
- `502` - Telegram API вернул ошибку
- `500` - внутренняя ошибка сервиса

### Настройка Power Automate

Trigger:

```text
Office 365 Outlook - When a new email arrives (V3)
```

Mailbox:

```text
dmitry.vaisman@metropolinet.co.il
```

Фильтр:

- `Subject Filter`: `TODO`, если поле доступно
- или action `Condition`: `Subject` contains `TODO`

Action:

```text
HTTP
```

Method:

```text
POST
```

URL:

```text
https://your-service.example.com/webhook/power-automate
```

Headers:

```json
{
  "Content-Type": "application/json",
  "X-Webhook-Secret": "значение SHARED_SECRET"
}
```

Body:

```json
{
  "from": "<From Address>",
  "subject": "<Subject>",
  "received": "<Received Time>",
  "bodyPreview": "<Body Preview>"
}
```

`bodyPreview` принимается для совместимости, но сервис не отправляет его в Telegram и не логирует его.

## Deploy на Render

1. Создайте Web Service из GitHub repository.
2. Render может использовать `render.yaml`. Если настраиваете вручную:

```text
Build Command: npm install
Start Command: npm start
```

3. Для Graph polling добавьте environment variables:

```text
TELEGRAM_BOT_TOKEN
TELEGRAM_CHAT_ID
GRAPH_POLLING_ENABLED=true
GRAPH_POLL_INTERVAL_SECONDS=120
GRAPH_LOOKBACK_MINUTES=5
TODO_SUBJECT_KEYWORD=TODO
MS_TENANT_ID
MS_CLIENT_ID
MS_CLIENT_SECRET
MS_REFRESH_TOKEN
MS_MAILBOX_USER
```

4. Для webhook режима дополнительно добавьте:

```text
SHARED_SECRET
```

5. Health URL:

```text
https://your-render-app.onrender.com/health
```

## Deploy на Railway

1. Создайте project из GitHub repository.
2. Railway обычно определит Node.js автоматически.
3. Добавьте Variables из раздела Render.
4. Start command:

```text
npm start
```

## Deploy на Azure App Service

1. Создайте App Service с runtime Node.js 18 или новее.
2. Загрузите проект через GitHub Deployment, ZIP deploy или Azure CLI.
3. В Configuration -> Application settings добавьте variables из раздела Render.
4. Startup command:

```text
npm start
```

## Безопасность и приватность

- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `SHARED_SECRET`, `MS_CLIENT_SECRET`, `MS_REFRESH_TOKEN` хранятся только в переменных окружения.
- `.env` добавлен в `.gitignore`.
- Сервис не сохраняет письма в базу данных.
- Сервис не запрашивает и не логирует тело письма.
- В логах остаётся только техническая информация: результат отправки, message id, отправитель, длина темы и время получения.
- Если token был случайно отправлен в чат или опубликован, его нужно сразу перевыпустить.
