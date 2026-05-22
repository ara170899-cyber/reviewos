# Changelog

All notable changes to ReviewOS are documented in this file.

## [2.1.0] — 2026-05

### Added
- **AI provider switcher**: Anthropic native SDK ↔ OpenRouter (любая модель через один API). Выбор провайдера и модели — в Settings.
- **Tone presets для AI**: 6 готовых стилей (friendly / formal / caring / brief / sales / custom) + свой prompt. Применяется ко всем AI-ответам Ozon и WB.
- **WB Studio** — полный модуль (`/wb.html`):
  - загрузка карточек WB через публичный API (без авторизации)
  - ТЗ для китайской инспекции на основе реальных отзывов
  - сравнение «моя vs конкурент»: характеристики, цена, темы отзывов, action plan
  - snapshots и сравнение по периодам (до/после доработки)
- **WB Seller API**: отзывы и вопросы продавца с авторизацией, AI-ответы с тональностью, публикация в WB.
- **Чаты Ozon Seller Chat**: AI разбирает диалоги, классифицирует намерение (pre_sales / return / complaint / conflict), эскалирует на менеджера для острых случаев.
- **Period-comparison** для WB-карточек: AI говорит что улучшилось/что ухудшилось после доработки.
- **Объединённая лента** Ozon+WB отзывов и вопросов в основном UI: фильтры по источнику и статусу.
- **Tests**: `tests/smoke.js` — 30+ smoke-tests на все routes с понятными ошибками.
- **Motion-bits** анимации: animated counters, stagger fade-up, spring toasts, pulse confirms, skeletons.
- **Persistent WB ban tracking**: переживает рестарт сервера, защищает токен от продления бана.
- **Шифрование at-rest** API ключей (AES-256-GCM с ключом из `DATA_ENCRYPTION_KEY`).

### Changed
- WB-публичные эндпоинты (`card.wb.ru`, `feedbacks*.wb.ru`) теперь идут через системный `curl` (child_process) для обхода TLS-fingerprint фильтра Node.
- AI-аналитика и SKU Lab убраны — заменены модулями WB Studio и сравнения по периодам.
- Объединённый UI отзывов/вопросов (Ozon + WB на одной странице).
- Tone instructions автоматически инжектятся во все AI-промпты.

### Fixed
- TLS-fingerprint блокировка WB → переход на curl-обёртку.
- Race condition при параллельной загрузке двух карточек WB → последовательная загрузка + read-merge-write в `ensureWbCard`.
- 50-pack basket-server fallback (раньше до 26 — пропускали свежие товары).
- WB rate-limit: persistent ban в файле + минимум 15 минут блокировки при любом 429.
- Цены WB не парсились — перешли на `sizes[].price.product` (v4 формат) вместо устаревшего `sizes[].stocks[].price`.
- Ozon `code 7 PermissionDenied` для чатов/отзывов больше не валит весь цикл, а помечает как `skipped`.
- XSS в обработке ошибок: `j.error`, `e.message` теперь обёрнуты в `esc()` перед вставкой в DOM.
- CORS allow-list `localhost` теперь только в `NODE_ENV !== production`.

### Security
- `.gitignore` расширен: `data/`, `*.bak`, `recovery-artifacts/`, `*.sqlite*`, `.env.*`.
- Все секреты (`ANTHROPIC_API_KEY`, `JWT_SECRET`, `DATA_ENCRYPTION_KEY`, Ozon/WB/OpenRouter токены) — только в `.env` или зашифрованы в `data/users.json`.
- В API-ответах никогда не возвращаются ключи — только `*_set: boolean` и `*_hint` (4 последних символа).

## [2.0.0] — earlier

Recovered baseline:
- Express monolith with JSON storage.
- Ozon Seller integration (reviews, questions, answers).
- AI replies via Claude.
- Multi-user auth (JWT, bcrypt).
- Cron-runner per user.
