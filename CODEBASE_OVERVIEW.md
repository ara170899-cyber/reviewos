# ReviewOS Rebuild: What Is Implemented

## Runtime

- Node.js + Express monolith in `index.js`.
- Static dashboard UI in `public/index.html`.
- Login UI in `public/login.html`.
- JSON file storage under `data/`.
- Local backup command: `npm run backup`.

## Implemented App Areas

- Authentication: register, login, current user, profile update.
- Multi-user storage: each user gets JSON files under `data/users/<user-id>/`.
- Ozon Seller integration: fetch reviews, fetch questions, publish review replies, publish question answers.
- AI replies: Claude prompt for review responses and question answers.
- AI analytics: generate analytics from reviews, import legacy analytics, group analytics by SKU, compare periods.
- Dashboard UI: KPIs, review/question counters, status bar, recent reviews/questions.
- AI Analytics UI: period filters, SKU history, priorities, comparison, signal map, report rendering.
- SKU Lab UI: factory tasks, listing tasks, risk radar, next SKU ideas, copy/export helpers.
- Reviews UI: list, regenerate AI response, edit response, publish response.
- Questions UI: list, regenerate AI answer, edit answer, publish answer.
- Settings UI: Ozon Client ID/API key, cron schedule, auto-post toggle, Ozon connection test.
- Logs UI: per-user operational logs.
- Admin API: list users and update role/plan/trial fields.
- Cron runner: checks user schedules each minute and runs Ozon sync cycles.

## Current Local Data State

- Admin user: `admin@reviewos.ru`.
- Reviews: `0`.
- Questions: `0`.
- Imported legacy analytics: `3` items grouped into `2` SKU groups.
- Ozon API key is present but encrypted at rest.
- Empty recovered SQLite/WAL artifacts are preserved in `recovery-artifacts/`.

## Main Files

- `index.js`: backend, API routes, Ozon integration, AI generation, cron, JSON persistence.
- `public/index.html`: dashboard and app UI.
- `public/login.html`: login screen.
- `data/users.json`: users and encrypted Ozon credentials.
- `data/users/<id>/analytics-history.json`: restored analytics history.
- `scripts/reset-admin-password.js`: local admin password reset helper.
- `scripts/backup-data.sh`: archive-based local backup helper.
- `RECOVERY_PLAN.md`: recovery notes and what was found.
- `PRODUCTION_REBUILD.md`: VPS deployment checklist.

## Known Gaps

- No locally recovered production reviews/questions yet.
- Old SQLite database contains schema only, not useful rows.
- Ozon and Anthropic keys should be rotated before real production use.
- The frontend is a recovered single HTML file; it works, but it is not yet refactored into maintainable components.
- `public/index.html` references `pdfmake` vendor files that are not currently restored, so PDF export paths need vendor assets or a small rewrite.
