# ReviewOS

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node 18+](https://img.shields.io/badge/node-%E2%89%A518-brightgreen)](https://nodejs.org)

**Marketplace operations on autopilot.** AI-помощник для продавцов Ozon и Wildberries: отзывы, вопросы, ТЗ для китайской инспекции, сравнение с конкурентами и анализ периодов «до/после доработки» — на одной странице.

> ⚠ **Security**: перед клонированием убедись что у тебя есть свежие `JWT_SECRET` и `DATA_ENCRYPTION_KEY` (`openssl rand -hex 32`). Файл `.env` НИКОГДА не должен попадать в git — он покрыт `.gitignore`. Все API-ключи маркетплейсов шифруются AES-256-GCM в `data/users.json` и не возвращаются через API наружу.

> Один Node.js процесс, без БД (JSON-хранилище), без облачных зависимостей. AI работает через **Anthropic Claude** или любую модель через **OpenRouter** (GPT, Gemini, Llama, DeepSeek…).

---

## Возможности

### Отзывы и вопросы
- **Ozon Seller API** — загрузка отзывов и вопросов, генерация AI-ответов, авто-публикация
- **Wildberries Seller API** — то же самое для WB (отзывы и вопросы продавца)
- **Объединённая лента** — отзывы и вопросы обоих маркетплейсов в одном UI с source-бейджами
- **6 пресетов тональности** + кастомный prompt (дружелюбный / формальный / эмпатичный / деловой / продающий / свой)
- **Контекст карточки товара** — характеристики автоматически подтягиваются и попадают в промпт ответа на вопрос — модель не выдумывает мощность/размер

### WB Studio (публичные WB API без авторизации)
- **Загрузка любой карточки WB** — характеристики + до 1000 отзывов покупателей
- **ТЗ для инспекции в Китае** — AI собирает чек-лист QC, план выборки AQL, тесты, упаковку, риски ниши на основе **реальных** жалоб
- **Сравнение моя vs конкурент** — диффы характеристик, темы отзывов, рекомендация по цене, action plan
- **Снимки и периоды до/после** — зафиксируй карточку до доработки, потом после, AI скажет что улучшилось / что ухудшилось / какие новые проблемы появились / план следующих шагов

### AI провайдер
- Переключение **Anthropic ↔ OpenRouter** в Settings без перезапуска
- Готовые пресеты моделей: Claude Opus 4.7 / Sonnet 4.6 / Haiku 4.5, GPT-4o, Gemini 2.0, Llama 3.3, Mistral, DeepSeek
- Поле для ввода произвольного `model_id` (любая модель OpenRouter)
- **Tone preview** — кнопка «попробовать на тестовом отзыве» прямо в Settings, видишь как ответит выбранная модель + тон

### Прочее
- JWT auth, multi-user, encrypted-at-rest API ключи (AES-256-CBC)
- Rate limits на auth и cycle
- Cron-расписание автоматических циклов
- `/health` с детальным статусом компонентов
- Smoke-тесты с понятными ошибками

---

## Скриншоты

| | |
|---|---|
| **Главная** | hero с приветствием, KPI по обоим маркетплейсам, recent отзывы/вопросы |
| **Отзывы / Вопросы** | объединённый список Ozon+WB с source-бейджами, AI-ответ в карточке, edit/regenerate/post |
| **WB Studio** | 5 блоков: загрузка → ТЗ инспекции → сравнение → периоды → ответы продавца |
| **Settings** | Ozon / WB / AI-провайдер / модель / тональность с превью |

---

## Установка

Требования: **Node.js 18+**, `npm`, `curl` в PATH (Motion / WB public API).

```bash
git clone https://github.com/<your-org>/reviewos.git && cd reviewos
npm install
cp .env.example .env

# Сгенерируй секреты:
echo "JWT_SECRET=$(openssl rand -hex 32)" >> .env
echo "DATA_ENCRYPTION_KEY=$(openssl rand -hex 32)" >> .env

# Заполни в .env: ANTHROPIC_API_KEY (либо настрой OpenRouter позже в UI)
# Создай админа:
npm run reset-admin -- 'your-strong-password'

npm start                   # → http://localhost:3001/login.html
npm test -- --password='your-strong-password'   # smoke-tests (30+ проверок)
```

> ⚠ `DATA_ENCRYPTION_KEY` менять после первой записи API-ключей **нельзя** — расшифровка станет невозможной. Если потерял ключ — нужно очистить `data/users.json` и завести ключи заново через UI.

Открой http://localhost:3001/login.html и войди как `admin@reviewos.ru` с указанным паролем.

### Шаги после первого входа

1. **Settings → 🔑 Ozon Seller API** — Client ID + API ключ
2. **Settings → 🟣 Wildberries Seller API** — токен из ЛК WB → Доступ к API (раздел «Отзывы и вопросы»)
3. **Settings → 🤖 AI-провайдер** — выбери Anthropic или OpenRouter
4. **Settings → 🎨 Тональность** — выбери пресет или напиши свой promt → жми «🎭 Превью на отзыве»
5. **Главная → ▶ Запустить цикл Ozon** — подтянутся отзывы и вопросы обоих маркетплейсов

---

## Тесты

```bash
npm test                              # smoke-test без авторизации
npm test -- --password='admin-pass'   # все тесты с авторизацией
npm test -- --skip-ai                 # пропустить тесты с реальными вызовами WB/AI
```

Тесты выдают **читаемые ошибки**: что не отвечает, какой статус пришёл, что в теле. Запускаются против работающего сервера на `http://localhost:3001` (или передай `--base=...`).

---

## API кратко

| Группа | Endpoints |
|---|---|
| Health & auth | `GET /health` · `POST /api/auth/login` · `GET /api/auth/me` · `PATCH /api/auth/profile` |
| Settings | `GET/POST /api/settings` · `POST /api/test-ozon` · `POST /api/test-wb` · `POST /api/test-openrouter` |
| AI | `GET /api/tone/presets` · `GET /api/ai/models` · `POST /api/ai/tone-preview` |
| Ozon | `GET /api/reviews` · `GET /api/questions` · `POST /api/cycle` · `POST /api/reviews/:id/{post,regenerate}` · `POST /api/questions/:id/{post,regenerate}` |
| WB Seller (приват) | `POST /api/wb-seller/sync` · `GET /api/wb-seller/{reviews,questions}` · `POST /api/wb-seller/reviews/:id/{generate,post}` · `PATCH /api/wb-seller/reviews/:id` (аналогично для questions) |
| WB Studio (паблик) | `POST /api/wb/fetch` · `GET /api/wb/cards[/:nmId]` · `POST /api/wb/inspection-brief` · `POST /api/wb/compare` · `POST /api/wb/snapshot` · `POST /api/wb/period-compare` |
| Admin | `GET /api/admin/users` · `PATCH /api/admin/users/:id` |

---

## Архитектура

```
index.js          ← монолит: Express + JWT + AI + Ozon + WB
data/
  users.json      ← пользователи + зашифрованные ключи
  users/<uid>/
    reviews.json          ← Ozon отзывы
    questions.json        ← Ozon вопросы
    products.json         ← кеш характеристик Ozon SKU
    wb-cards.json         ← кеш WB карточек (характеристики, описание, отзывы)
    wb-snapshots.json     ← снимки для сравнения периодов
    wb-feedbacks.json     ← отзывы продавца WB (Seller API)
    wb-questions.json     ← вопросы продавца WB
    logs.json             ← операционный лог
public/
  app.css         ← единая дизайн-система
  login.html
  index.html      ← дашборд + Reviews + Questions + Logs + Settings
  wb.html         ← WB Studio (5 блоков)
tests/
  smoke.js        ← покрытие всех роутов с понятными ошибками
scripts/
  reset-admin-password.js
  backup-data.sh  ← архив data/ в data/backups/
```

### Почему WB через curl

`card.wb.ru` и `feedbacks*.wb.ru` фильтруют Node.js по TLS-fingerprint (JA3). Прямой `axios`/`fetch` получает HTTP 403. Системный `curl` имеет совместимый handshake — поэтому WB-публичные запросы идут через `child_process.execFile('curl', ...)`. WB Seller API (с авторизацией) фильтра не имеет — он через axios.

### Безопасность
- `JWT_SECRET` обязателен, иначе сервер не стартует
- Все API-ключи маркетплейсов и OpenRouter шифруются AES-256-CBC, ключ из `DATA_ENCRYPTION_KEY`
- В ответах API ключи никогда не возвращаются — только `*_set: true` и `*_hint` (4 последних символа)
- Rate-limit на auth и cycle, helmet на всех ответах

---

## Production деплой

См. [PRODUCTION_REBUILD.md](./PRODUCTION_REBUILD.md). Кратко:

```bash
# на свежем Ubuntu VPS
sudo apt install -y nodejs npm nginx certbot python3-certbot-nginx
git clone <repo> /opt/reviewos && cd /opt/reviewos
npm ci
cp .env.example .env  # отредактируй с реальными секретами
npm run reset-admin -- 'strong-password'
sudo npm install -g pm2
pm2 start index.js --name reviewos
pm2 save && pm2 startup
# nginx reverse proxy на 127.0.0.1:3001, certbot для HTTPS
```

Backup:
```bash
0 */6 * * * cd /opt/reviewos && npm run backup
```

Не забудь синхронизировать `data/backups/` куда-нибудь вне VPS.

---

## Лицензия

MIT — см. [LICENSE](LICENSE).

## Contributing

Issues и PR приветствуются. Перед PR прогони `npm test` — все 30+ smoke-тестов должны быть зелёными.

## Безопасность

Если нашёл security-уязвимость — **не** заводи публичный issue. Напиши на email мейнтейнера (см. git log) или открой private security advisory в GitHub. Особое внимание к:
- утечкам в `data/` или `.env` после деплоя
- XSS в шаблонных строках UI
- bypass auth middleware

См. также [CHANGELOG.md](CHANGELOG.md).

---

## Что дальше

См. [AGENTS.md](./AGENTS.md) — context-файл для AI-ассистентов и будущих контрибьюторов. Содержит safety rules, известные ловушки, и команды первой помощи.
