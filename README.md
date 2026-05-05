# Metropolinet Telegram Notification Relay

Небольшой Node.js + Express сервис для уведомлений в Telegram о новых задачах из Microsoft 365 / Outlook через Power Automate.

Сервис не читает почтовый ящик напрямую, не хранит письма в базе данных и не логирует полный текст письма. Power Automate отслеживает Outlook и отправляет короткий JSON webhook в этот сервис.

## Что делает сервис

Power Automate отправляет HTTP POST:

```json
{
  "from": "sender@example.com",
  "subject": "TODO something",
  "received": "2026-05-05T10:00:00Z",
  "bodyPreview": "short preview"
}
```

Сервис проверяет header `X-Webhook-Secret`, формирует короткое уведомление и отправляет его через Telegram Bot API:

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
- Любой публичный HTTPS endpoint для Power Automate: Render, Railway, Azure App Service или другой хостинг
- Power Automate plan/trial, который разрешает action `HTTP`

Платные внешние API не используются.

Важно: в Power Automate action `HTTP` может требовать premium plan или trial. Если flow получает состояние `Suspended` с причиной `BillingConsumption`, Outlook connection уже может быть рабочим, но сам flow не включится до активации подходящего Power Automate plan/trial или pay-as-you-go billing.

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

Заполните `.env`:

```env
PORT=3000
TELEGRAM_BOT_TOKEN=123456789:your_bot_token
TELEGRAM_CHAT_ID=123456789
SHARED_SECRET=long-random-secret
```

Запуск:

```bash
npm start
```

Если на этой Windows-машине `npm` не найден в `PATH`, в проект уже можно положить портативный Node.js/npm и запускать команды через него, например:

```powershell
.\.tools\node-v24.15.0-win-x64\npm.cmd start
```

Для локальной разработки:

```bash
npm run dev
```

Проверка:

```bash
curl http://localhost:3000/health
```

Тестовый webhook:

```bash
curl -X POST http://localhost:3000/webhook/power-automate \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Secret: long-random-secret" \
  -d "{\"from\":\"sender@example.com\",\"subject\":\"TODO something\",\"received\":\"2026-05-05T10:00:00Z\",\"bodyPreview\":\"short preview\"}"
```

На Windows PowerShell:

```powershell
$body = @{
  from = "sender@example.com"
  subject = "TODO something"
  received = "2026-05-05T10:00:00Z"
  bodyPreview = "short preview"
} | ConvertTo-Json

Invoke-RestMethod `
  -Method Post `
  -Uri "http://localhost:3000/webhook/power-automate" `
  -Headers @{ "X-Webhook-Secret" = "long-random-secret" } `
  -ContentType "application/json" `
  -Body $body
```

## Как создать Telegram bot

1. Откройте Telegram и найдите `@BotFather`.
2. Отправьте команду `/newbot`.
3. Задайте имя бота и username.
4. BotFather выдаст token вида `123456789:ABC...`.
5. Запишите его в переменную окружения `TELEGRAM_BOT_TOKEN`.

Не храните token в коде и не публикуйте `.env`.

## Как получить TELEGRAM_CHAT_ID

### Личный чат

1. Напишите любое сообщение созданному боту в Telegram, например `start`.
2. Откройте в браузере:

```text
https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/getUpdates
```

3. Найдите в ответе `message.chat.id`.
4. Запишите это значение в `TELEGRAM_CHAT_ID`.

### Группа

1. Добавьте бота в группу.
2. Напишите сообщение в группу.
3. Откройте:

```text
https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/getUpdates
```

4. Найдите `message.chat.id`. Для групп значение часто отрицательное.
5. Если бот должен писать в группу, убедитесь, что он не заблокирован настройками privacy или правами группы.

## Endpoint

Основной endpoint:

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

- `400` — пустое или неправильное тело запроса
- `401` — неправильный `X-Webhook-Secret`
- `502` — Telegram API вернул ошибку
- `500` — внутренняя ошибка сервиса

## Настройка Power Automate

Создайте cloud flow.

### Trigger

Connector:

```text
Office 365 Outlook
```

Trigger:

```text
When a new email arrives (V3)
```

Mailbox:

```text
dmitry.vaisman@metropolinet.co.il
```

Фильтрацию лучше делать в Power Automate, чтобы сервис получал только нужные задачи:

- для темы используйте поле `Subject Filter` со значением `TODO`, если оно доступно в вашей версии trigger
- для конкретного отправителя используйте `From` / advanced options, если доступно
- если нужного поля нет, добавьте action `Condition` после trigger:
  - `From Address` equals `sender@example.com`
  - или `Subject` contains `TODO`

### Action

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

В интерфейсе Power Automate подставьте эти значения через Dynamic content:

- `From Address`
- `Subject`
- `Received Time`
- `Body Preview`

Поле `bodyPreview` принимается для совместимости, но сервис не отправляет его в Telegram и не логирует его.

## Deploy на Render

1. Создайте новый Web Service.
2. Подключите репозиторий с этим проектом.
3. Render может использовать `render.yaml` из проекта. Если настраиваете вручную, укажите:

```text
Build Command: npm install
Start Command: npm start
```

4. Добавьте environment variables:

```text
TELEGRAM_BOT_TOKEN
TELEGRAM_CHAT_ID
SHARED_SECRET
```

5. Render выдаст публичный HTTPS URL. Используйте:

```text
https://your-render-app.onrender.com/webhook/power-automate
```

## Deploy на Railway

1. Создайте новый project из GitHub repository.
2. Railway обычно определит Node.js автоматически.
3. Добавьте Variables:

```text
TELEGRAM_BOT_TOKEN
TELEGRAM_CHAT_ID
SHARED_SECRET
```

4. Start command:

```text
npm start
```

5. Сгенерируйте публичный domain и используйте:

```text
https://your-railway-domain.up.railway.app/webhook/power-automate
```

## Deploy на Azure App Service

1. Создайте App Service с runtime Node.js 18 или новее.
2. Загрузите проект через GitHub Deployment, ZIP deploy или Azure CLI.
3. В Configuration -> Application settings добавьте:

```text
TELEGRAM_BOT_TOKEN
TELEGRAM_CHAT_ID
SHARED_SECRET
```

4. Startup command:

```text
npm start
```

5. Endpoint:

```text
https://your-app-name.azurewebsites.net/webhook/power-automate
```

## Безопасность и приватность

- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `SHARED_SECRET` хранятся только в переменных окружения.
- `.env` добавлен в `.gitignore`.
- Сервис не сохраняет письма в базу данных.
- Сервис не логирует `bodyPreview` или полный текст письма.
- В логах остаётся только техническая информация: результат отправки, отправитель, длина темы и время получения.
