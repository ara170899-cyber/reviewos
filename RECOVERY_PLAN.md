# ReviewOS Recovery Plan

## What We Have

- Recovered backend source from `Downloads/.trash-20260325/indexb.js.pre-v3.bak`.
- Recovered dashboard UI from `Downloads/.trash-20260325/index.html.pre-frontend-split.bak`.
- Imported local legacy user data from `users.json.before-encryption.bak`.
- Imported demo/legacy analytics from `review-analytics.json.pre-user-split.bak`.
- Preserved the empty SQLite/WAL set under `recovery-artifacts/` for audit purposes.

## What We Do Not Have Locally

- Live production reviews/questions from the deleted VPS.
- A useful populated `reviewos.sqlite` dump.
- A confirmed server snapshot after March 25, 2026.

## Rebuild Path

1. Start this local recovered app and verify auth, dashboard, settings, and analytics import.
2. If hosting support restores the March 25 manual server image, copy `data/` from that image into this project.
3. If no server image survives, use the restored Ozon credentials only after rotating them, then re-sync reviews/questions from Ozon API.
4. Re-deploy on a new VPS with daily offsite backups and a separate exported SQLite backup job.
5. Keep `npm run backup` in cron until a stronger offsite backup pipeline exists.

See `PRODUCTION_REBUILD.md` for the VPS checklist.

## Local Run

```bash
npm install
npm run reset-admin -- 'new-strong-password'
npm start
```

Open `http://localhost:3001/login.html`.

## Backup Command

```bash
npm run backup
```

The archive is written to `data/backups/`.
