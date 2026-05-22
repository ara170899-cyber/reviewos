# AGENTS.md — Context for AI assistants

> Файл, который автоматически подгружается AI-ассистентами (Cursor, Aider и др.). Прочитай его **до того как** начать любую правку.

---

## 1. Что это за проект

**ReviewOS** — Node.js + Express монолит для продавцов **Ozon** и **Wildberries**.

Основная цель: автоматизировать рутину работы с обратной связью покупателей через AI.

Что умеет:
- Загружать **отзывы и вопросы** с Ozon Seller API и WB Seller API
- Генерировать AI-ответы (Anthropic Claude или любая модель через OpenRouter)
- Применять выбранную **тональность** к ответам (6 пресетов или свой prompt)
- Публиковать ответы автоматически (`auto_post`) или вручную
- Работать с **чатами Ozon Seller Chat** (классификация интента, эскалация конфликтов)
- В **WB Studio** (отдельная страница `/wb.html`):
  - Загружать любую карточку WB через публичный API (без авторизации)
  - Генерировать **ТЗ для китайской инспекции** на основе реальных отзывов
  - Сравнивать «моя vs конкурент» — диффы характеристик, цены, темы отзывов, action plan
  - Делать **snapshots** карточки и сравнивать «до/после доработки»

---

## 2. Архитектура

### Стек
- **Backend**: Node.js ≥18, Express 4, axios, helmet, express-rate-limit, jsonwebtoken, bcryptjs, node-cron, dotenv, uuid, @anthropic-ai/sdk
- **Frontend**: ванильный HTML/CSS/JS, без сборщика, без React. Анимации через Motion (motion.dev) с CDN
- **Хранилище**: JSON-файлы в `data/` (никакой БД)
- **AI**: Anthropic SDK для нативного Claude, или OpenRouter (OpenAI-совместимый API) для GPT/Gemini/Llama/DeepSeek

### Структура
```
.
├── index.js                          ← ВЕСЬ backend (≈2700 строк, один файл)
├── package.json
├── .env / .env.example
├── public/                           ← статика, отдаётся express.static
│   ├── app.css                       ← design-system (CSS-переменные, компоненты)
│   ├── motion-bits.js                ← ESM-модуль с motion.dev + helpers (window.MX)
│   ├── login.html                    ← страница входа
│   ├── index.html                    ← главный SPA (Dashboard, Отзывы, Вопросы, Чаты, Settings)
│   └── wb.html                       ← WB Studio (5 блоков: загрузка, ТЗ, сравнение, периоды, ответы)
├── data/                             ← НИКОГДА не коммитить!
│   ├── users.json                    ← список юзеров, ZAШИФРОВАННЫЕ ключи Ozon/WB/OpenRouter
│   ├── wb-bans.json                  ← persistent rate-limit bans per WB-token-hash
│   └── users/<uid>/
│       ├── reviews.json              ← Ozon отзывы
│       ├── questions.json            ← Ozon вопросы
│       ├── products.json             ← кеш характеристик Ozon SKU
│       ├── wb-cards.json             ← кеш WB карточек (характеристики, описание, отзывы)
│       ├── wb-snapshots.json         ← снимки для сравнения периодов
│       ├── wb-feedbacks.json         ← отзывы продавца WB (Seller API)
│       ├── wb-questions.json         ← вопросы продавца WB
│       ├── chats.json                ← Ozon чаты (index + threads с сообщениями)
│       └── logs.json                 ← операционный лог
├── scripts/
│   ├── reset-admin-password.js       ← npm run reset-admin -- 'newpass'
│   └── backup-data.sh                ← npm run backup → data/backups/<timestamp>.tar.gz
└── tests/
    └── smoke.js                      ← 29+ smoke-тестов с понятными ошибками
```

### Принципы дизайна
- **JSON-storage, не БД** — простота развёртывания, минимум зависимостей
- **`index.js` — монолит** — все routes и логика в одном файле, проще искать (Cmd+F работает)
- **Frontend без сборщика** — обычный HTML, нет webpack/vite. Можно открыть `public/index.html` прямо в браузере (с проксированием `/api`)
- **Все секреты шифруются at-rest** (AES-256-GCM) в `data/users.json`. Расшифровка через `DATA_ENCRYPTION_KEY`
- **Per-user storage** — каждый юзер в своей папке `data/users/<uid>/`

---

## 3. Запуск и команды

```bash
# Один раз
npm install
cp .env.example .env
echo "JWT_SECRET=$(openssl rand -hex 32)" >> .env
echo "DATA_ENCRYPTION_KEY=$(openssl rand -hex 32)" >> .env
# Запиши в .env: ANTHROPIC_API_KEY=sk-ant-...
npm run reset-admin -- 'strong-password'

# Каждый день
npm start                                       # → http://localhost:3001
npm run dev                                     # → nodemon (auto-restart)

# Тесты
npm test                                        # без auth (только public endpoints)
npm test -- --password='strong-password'        # все 29 тестов
npm test -- --skip-ai                           # пропустить реальные вызовы AI/WB

# Бэкап data/
npm run backup                                  # data/backups/<timestamp>.tar.gz

# Health check
curl http://localhost:3001/health
```

---

## 4. Переменные окружения (`.env`)

Минимально нужные:
| Переменная | Описание |
|---|---|
| `JWT_SECRET` | Длинная случайная строка для подписи JWT (32+ символа) |
| `DATA_ENCRYPTION_KEY` | Ключ AES для шифрования Ozon/WB/OpenRouter токенов. **Менять нельзя** после первой записи — расшифровка станет невозможна |
| `ANTHROPIC_API_KEY` | Ключ Anthropic (или используй OpenRouter в Settings) |

Опционально:
| Переменная | Default | Описание |
|---|---|---|
| `PORT` | 3001 | HTTP-порт |
| `NODE_ENV` | — | `production` отключает `localhost` в CORS |
| `APP_ORIGIN` | — | Origin фронта на production |
| `ALLOWED_ORIGINS` | — | CSV дополнительных origin'ов |
| `WB_DEST` | `-1257786` | Регион WB (Москва) |
| `ANTHROPIC_REVIEW_MODEL` | `claude-sonnet-4-20250514` | Дефолтная модель |
| `BOOTSTRAP_ADMIN` | false | При true и пустом users.json — создаст админа из ADMIN_EMAIL/ADMIN_PASSWORD |

---

## 5. API карта

| Группа | Endpoint | Описание |
|---|---|---|
| **Health** | `GET /health` | Версия, uptime, флаги компонентов |
| **Auth** | `POST /api/auth/register` | Регистрация |
| | `POST /api/auth/login` | Логин → `{token, user}` |
| | `GET /api/auth/me` | Текущий юзер |
| | `PATCH /api/auth/profile` | Обновить имя/пароль |
| **Settings** | `GET /api/settings` | Все настройки (без secrets) |
| | `POST /api/settings` | Сохранить ключи/тон/AI-провайдер |
| | `POST /api/test-ozon` | Проверка Ozon Client-Id + Api-Key |
| | `POST /api/test-wb` | Проверка WB-токена |
| | `POST /api/test-openrouter` | Проверка OpenRouter ключа |
| **AI** | `GET /api/tone/presets` | Список пресетов тональности |
| | `GET /api/ai/models` | Провайдеры + рекомендованные модели |
| | `POST /api/ai/tone-preview` | Тестовый AI-ответ на отзыв-пример |
| **Ozon Reviews/Questions** | `GET /api/reviews` | Отзывы Ozon |
| | `GET /api/questions` | Вопросы Ozon |
| | `POST /api/cycle` | Запуск полного цикла (Ozon + WB sync + AI + post) |
| | `POST /api/reviews/:uuid/{post,regenerate}` | Действия с отзывом |
| | `POST /api/questions/:id/{post,regenerate}` | Действия с вопросом |
| **Ozon Chat** | `POST /api/chats/sync` | Загрузка диалогов |
| | `GET /api/chats?filter=...` | Список с фильтрами |
| | `GET /api/chats/:chatId` | Детальная история |
| | `POST /api/chats/:chatId/generate` | AI-ответ + классификация |
| | `POST /api/chats/:chatId/{send,escalate}` | Отправить / Эскалировать |
| | `PATCH /api/chats/:chatId` | Редактировать черновик |
| | `POST /api/chats/debug` | Диагностика: сырой ответ Ozon |
| **WB Studio (public)** | `POST /api/wb/fetch` | Загрузить карточку по nm_id |
| | `GET /api/wb/cards[/:nmId]` | Список / детали |
| | `DELETE /api/wb/cards/:nmId` | Удалить из кеша |
| | `GET /api/wb/cards/:nmId/diagnose` | Диагностика подтянутых данных |
| | `POST /api/wb/inspection-brief` | ТЗ для китайской инспекции |
| | `POST /api/wb/compare` | Сравнение моя vs конкурент |
| | `POST /api/wb/snapshot` | Сделать снимок карточки |
| | `GET /api/wb/snapshots/:nmId` | История снимков |
| | `POST /api/wb/period-compare` | AI-сравнение двух снимков |
| **WB Seller (приват)** | `POST /api/wb-seller/sync` | Sync отзывов/вопросов продавца |
| | `GET /api/wb-seller/{reviews,questions}` | Списки |
| | `POST /api/wb-seller/{reviews,questions}/:id/generate` | AI-ответ |
| | `POST /api/wb-seller/{reviews,questions}/:id/preview-ai` | AI-превью без сохранения |
| | `POST /api/wb-seller/{reviews,questions}/:id/post` | Публикация в WB |
| | `PATCH /api/wb-seller/{reviews,questions}/:id` | Изменить черновик |
| | `GET /api/wb-seller/status` | WB ban / cooldown |
| | `POST /api/wb-seller/{probe,clear-ban}` | Диагностика / снятие ban |
| **Admin** | `GET /api/admin/users` | Список юзеров |
| | `PATCH /api/admin/users/:id` | Изменить роль/план/trial |

Auth — JWT в `Authorization: Bearer <token>`. Middleware `auth` на всех `/api/*` кроме `/api/auth/*`. Admin-only: `adminAuth` для `/api/admin/*`.

---

## 6. Особенности маркетплейсов (КРИТИЧНО)

### Wildberries public API
**WB агрессивно режет Node.js по TLS-fingerprint (JA3)**. `axios`/`fetch` получает HTTP 403 на `card.wb.ru` и `feedbacks*.wb.ru`. Решение: **запросы идут через `child_process.execFile('curl', [...])`** (см. `wbGet` в index.js). Системный `curl` имеет TLS-handshake, который WB не банит.

Если добавляешь новый запрос к публичному WB API — **обязательно через `wbGet`**, не через `axios`.

### Wildberries Seller API (приват)
- Endpoint: `https://feedbacks-api.wildberries.ru/api/v1/{feedbacks,questions}`
- Авторизация: `Authorization: <token>` (без `Bearer`, токен из ЛК WB → Профиль → Доступ к API → Отзывы/вопросы)
- **Rate limit: ~1 запрос/секунду**. Превышение → **бан на часы**, причём каждый запрос во время бана продлевает его
- Реализовано: `wbBanRemainingSec`, `wbBanSet` — persistent ban в `data/wb-bans.json`. При любом 429 ставим минимум 15 мин. UI показывает обратный отсчёт
- При sync — пауза 2.5 сек между страницами пагинации

### Wildberries basket-серверы (для характеристик)
WB хранит детали карточек на CDN `basket-XX.wbbasket.ru` где XX — от 01 до 50+. Номер сервера зависит от `nm_id`. Реализован перебор 1..50 параллельными батчами по 6 (`fetchWbBasketCard`).

### Ozon Seller API
- Endpoint: `https://api-seller.ozon.ru/v{1,3}/...`
- Авторизация: headers `Client-Id` + `Api-Key`
- **Подписки**: дешёвые подписки не дают `/v1/review/list`, `/v1/question/list`, `/v3/chat/list` (`code 7 PermissionDenied`). Реализовано: `isOzonSubscriptionDenied` → помечаем `skipped`, не валим цикл
- **Окно ответа в чате — 48 часов** после последнего сообщения покупателя. После — `access period has expired`. UI показывает таймер `⏱ осталось Nч` / `🕒 окно истекло`

### Ozon Chat API
- `/v3/chat/list` body: `{filter:{chat_status:"All"}, cursor:"", limit:100}`
- **Cursor для пагинации иногда отвергается самим WB** — известный баг. Реализовано: catch + остановка пагинации с warning
- `/v3/chat/history` возвращает text в `m.data` (массив строк), не в `m.content`

---

## 7. AI: aiComplete абстракция

Все вызовы AI идут через `aiComplete(user, { messages, max_tokens, temperature })` в `index.js`:

```js
async function aiComplete(user, opts) {
  const { provider, model } = resolveAiConfig(user);
  if (provider === "openrouter") {
    // POST https://openrouter.ai/api/v1/chat/completions
    // headers: Authorization: Bearer <user.openrouter_api_key>
    // body: {model, messages, max_tokens, temperature}
  } else {
    // anthropic.messages.create({model, max_tokens, messages})
  }
  return { text, provider, model };
}

function parseAiJson(text) { /* убирает ```json``` обёртки, JSON.parse */ }
```

**Никогда не вызывай `anthropic.messages.create()` напрямую** — только через `aiComplete`. Это даёт автоматический выбор провайдера через user.ai_provider.

Tone применяется через `buildToneInstructions(user, kind)` — подставляется в промпт. 6 пресетов: `friendly`, `formal`, `caring`, `brief`, `sales`, `custom`. См. `TONE_PRESETS` в index.js.

---

## 8. Конвенции кода

### Backend (`index.js`)
- **Все секреты** при сохранении пользователя → `encryptSecret()`. При чтении из БД → `hydrateUserSecrets()` (расшифровывает на лету в `req.user.xxx_api_key`)
- **Никогда не отдавать секреты в API**: `sanitizeUser()` вырезает `password`, `*_api_key`, `*_api_key_encrypted`. Оставляет только `*_set: boolean` и `*_hint`
- **JSON-хранилище**: `getUserData(uid, key, default)`, `setUserData(uid, key, value)` — RW в `data/users/<uid>/<key>.json`. При параллельной записи **читай файл ещё раз перед записью** (см. `ensureWbCard`) — иначе race condition
- **Логирование**: `addUserLog(uid, message, type)` где type ∈ `info|success|warn|error`. Логи попадают в `data/users/<uid>/logs.json` и видны на странице «Лог»
- **Ошибки маркетплейсов**: используй `formatApiErrorMessage`, `isOzonSubscriptionDenied`, `isOzonPublishForbidden` чтобы отличать «нет подписки» от «бага»
- Никогда **не пиши пароли в .env** на production — используй `npm run reset-admin`

### Frontend
- **Никакого React/Vue** — только vanilla. Динамика через `innerHTML` шаблонные строки
- **Всегда `esc(value)`** при вставке user-controlled данных в `innerHTML`. Иначе XSS
- Дизайн-токены — в `public/app.css` (`--primary`, `--panel`, `--t1` и т.д.)
- Анимации — через `window.MX.*` (см. `motion-bits.js`)
- AJAX — через `api.get/post/patch/delete` (объявлен в index.html). В wb.html — функция `api()` с похожим интерфейсом
- Auth-токен — `localStorage.getItem("token")`. Если 401 → `logout()` → редирект на `/login.html`

---

## 9. Частые задачи (рецепты)

### Добавить новый endpoint
1. Найди в `index.js` секцию с похожими роутами (Ozon, WB, Settings и т.д.)
2. Добавь `app.<method>("/api/...", auth, async (req, res) => { ... })`
3. Если действие требует AI — используй `aiComplete(req.user, ...)`, не `anthropic.messages.create`
4. Если действие меняет данные — добавь `addUserLog(req.user.id, ...)` для аудита
5. Обнови `tests/smoke.js` — добавь тест на 401 без токена и happy-path

### Добавить новый AI-промпт
1. Создай `async function generateXxx(args, user)` в `index.js`
2. Внутри: `const msg = await aiComplete(user, { max_tokens: ..., messages: [{role:"user", content: ...}] })`
3. Если нужен JSON — `return parseAiJson(msg.text)`. Внутри промпта явно проси «Верни ТОЛЬКО валидный JSON»
4. Не забудь `buildToneInstructions(user, "review"|"question")` если ответ для покупателя

### Добавить новую вкладку в основной UI
1. В `public/index.html` добавь кнопку в topbar: `<button class="tab-btn" onclick="setTab('new')" id="dtab-new">...</button>`
2. И в bot-nav (мобильное меню)
3. Расширь `const TABS = [...]` массив
4. Добавь `<div class="page stagger" id="page-new">...</div>` в main-wrap
5. В функции `setTab(t)` добавь `if(t==="new") loadNew()` чтобы инициализировать

### Добавить новый пресет тональности
1. В `index.js` дополни объект `TONE_PRESETS`
2. UI подхватит автоматически через `/api/tone/presets`

### Сменить AI-провайдера/модель программно
В Settings UI или через POST `/api/settings`:
```json
{"ai_provider": "openrouter", "ai_model": "openai/gpt-4o", "openrouter_api_key": "sk-or-..."}
```

---

## 10. Тесты

**`tests/smoke.js`** — 29+ HTTP-проверок против работающего сервера на `http://localhost:3001`.

Запуск:
```bash
npm test                                         # без auth (public)
npm test -- --password='admin-pass'              # авторизованные тесты
npm test -- --skip-ai                            # пропустить вызовы AI/WB
npm test -- --base=http://staging.example.com    # против staging
```

Тесты сгруппированы:
- Service & static
- Authentication
- Settings & tone presets
- AI provider & OpenRouter
- Reviews & Questions (Ozon)
- WB Seller API
- WB Studio (public)
- AI tone preview
- Chats (Ozon Seller Chat)
- Admin

Каждый тест выдаёт `file:line + description + body fragment` при провале. Не молчит.

---

## 11. Известные ловушки и решения

| Симптом | Причина | Решение |
|---|---|---|
| WB вернул 403 на любой запрос | TLS-fingerprint Node | Используй `wbGet` (через curl), не axios |
| WB вернул 429 «too many requests» | Превышен лимит 1 req/sec | Persistent ban на 15+ мин, не дёргать токен |
| Ozon `PermissionDenied code 7` | Подписка не разрешает API | Помечать `skipped`, не падать |
| `JS ERROR: esc is not defined` | Опечатка в имени helper'а | `esc()` и `escapeHtml()` определены в начале скрипта index.html |
| Race condition при двойной загрузке WB карточек | Параллельные `Promise.all` пишут в JSON | Загружать **последовательно** + перечитывать кеш перед `setUserWbCards` |
| Цена карточки `null` | WB v4 формат: цена в `sizes[].price.product`, не в `stocks[].price` | Парсер уже обновлён, см. `fetchWbCard` |
| Характеристики пустые | Карточка на basket-27+ а перебор был до 26 | Расширен до 50 |
| Cursor value is incorrect | Баг Ozon Chat API при пагинации | Catch + stop, warning в логи |
| Окно ответа Ozon истекло | Прошло >48 часов с сообщения | UI блокирует кнопку Send, показывает таймер |

---

## 12. Security rules — ВАЖНО для AI-агентов

🚨 **Что НЕ делать**:
1. Не выводить значения `process.env.*` в логи, ответы API, файлы, commit messages
2. Не возвращать в JSON ответах `password`, `*_api_key`, `*_api_key_encrypted` — только `*_set: boolean` и `*_hint` (последние 4 символа)
3. Не вставлять user-controlled строки в `innerHTML` без `esc()` — это XSS
4. Не использовать `child_process.exec` со строками от пользователя — только `execFile` с массивом args
5. Не делать file IO с `req.params.X` без валидации (path traversal)
6. Не отключать `helmet` или `cors`
7. Не убирать `auth` middleware с защищённых роутов

✅ **Что делать всегда**:
1. Шифровать новые секретные поля через `encryptSecret()`
2. Возвращать в ошибках 4xx понятные сообщения на русском (UI показывает их напрямую)
3. Логировать важные действия через `addUserLog`
4. При новых fetch-обёртках для маркетплейсов — учитывать rate limits
5. Тестировать новые endpoints добавлением кейсов в `tests/smoke.js`

---

## 13. Deploy на production

См. [PRODUCTION_REBUILD.md](./PRODUCTION_REBUILD.md). Кратко:

```bash
# Ubuntu VPS
sudo apt install -y nodejs npm nginx certbot python3-certbot-nginx
git clone https://github.com/<you>/reviewos.git /opt/reviewos
cd /opt/reviewos
npm ci
cp .env.example .env
# Заполни .env: openssl rand -hex 32 для секретов, реальные APP_ORIGIN, ANTHROPIC_API_KEY
npm run reset-admin -- 'strong-password'
sudo npm install -g pm2
pm2 start index.js --name reviewos
pm2 save && pm2 startup
# Nginx → reverse proxy на 127.0.0.1:3001, certbot для HTTPS
```

Backup в cron:
```
0 */6 * * * cd /opt/reviewos && npm run backup
```

**Не забудь синхронизировать `data/backups/` вне сервера** (S3, rclone, отдельный VPS).

---

## 14. Подсказки для AI-агентов

Если пользователь просит:
- **«добавь endpoint X»** → см. рецепт «Добавить новый endpoint» выше, обнови smoke.js
- **«сделай UI красивее»** → используй CSS-токены из `app.css`, анимации через `window.MX.*` (см. `motion-bits.js`)
- **«проверь работает ли X»** → запусти `npm test -- --password=...`, проанализируй вывод
- **«почему WB банит»** → проверь `data/wb-bans.json`, не дёргай токен пока бан активен
- **«добавь новый маркетплейс»** → создай модуль по аналогии с WB (helpers + storage + routes + UI), но **проверь TLS-fingerprint** — может тоже понадобиться curl-обёртка
- **«сделай авто-публикацию»** → расширь `runUserCycle` в `index.js`, секция WB или Ozon. Не забудь `if (user.auto_post)` проверку

Если что-то непонятно — **спроси пользователя** или прочти `CHANGELOG.md` (там история всех решений).

При **любых сомнениях по WB rate-limits** — лучше **подожди**, чем ударить лишний раз. Бан растёт лавинообразно.

---

## 15. Поддержка

- Issues / PR: см. репозиторий на GitHub
- Security: private security advisory, не публичный issue
- Лицензия: MIT (см. [LICENSE](./LICENSE))
- История изменений: [CHANGELOG.md](./CHANGELOG.md)
