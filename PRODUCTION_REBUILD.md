# ReviewOS Production Rebuild Checklist

## New VPS Baseline

1. Create a fresh Ubuntu VPS.
2. Install Node.js LTS, nginx, PM2, git, tar, and certbot.
3. Upload this project to `/opt/reviewos`.
4. Run `npm ci`.
5. Create a production `.env` from `.env.example`.
6. If you keep the current `data/users.json`, keep the current `DATA_ENCRYPTION_KEY` too. Encrypted marketplace keys cannot be decrypted after changing it.
7. Run `npm run reset-admin -- '<new-strong-password>'`.
8. Start with `pm2 start index.js --name reviewos`.
9. Save PM2 with `pm2 save`.
10. Put nginx in front of `http://127.0.0.1:3001`.
11. Enable HTTPS with certbot.

## Data Restore Order

1. If hosting support restores the old server image, stop the app.
2. Copy old `data/` into `/opt/reviewos/data`.
3. Start the app once and check logs for migrations.
4. Run `npm run backup`.
5. Verify login, settings, reviews, questions, and analytics.

## If Old Server Data Is Gone

1. Keep the recovered local admin profile.
2. Rotate Ozon and Anthropic keys.
3. Re-enter fresh keys in the ReviewOS settings screen.
4. Run a manual sync cycle.
5. Treat old analytics as partial demo/history only.

## Backups

Add a cron job:

```bash
0 */6 * * * cd /opt/reviewos && npm run backup
```

Then push `data/backups/` off-server with your hosting backup service, S3, rclone, or another VPS. A backup that lives only on the same VPS is still fragile.

## Minimum Smoke Test

```bash
curl -fsS http://127.0.0.1:3001/health
```

Then log in at `/login.html` and check `/api/status` through the UI.
