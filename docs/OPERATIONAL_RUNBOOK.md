# ABMDAS Operational Runbook

## 1. Start / stop

- Start: `node server/index.js` (default port 3000, or set `PORT`).
- Data directory: set `ABMDAS_DATA_DIR` to override `data/` (useful for tests/backups).
- Stop: Ctrl+C. Ensure no pending writes; SQLite WAL is checkpointed on close.

## 2. Backup

Run `node scripts/backup.js [destinationDir]`. This copies `abmdas.db`, `-wal`, `-shm` and `uploads/` into a timestamped folder under `backups/` (or the given destination). For a fully consistent snapshot, stop the server first.

Recommended schedule: daily, retained for 30 days. Verify by restoring into a temp `ABMDAS_DATA_DIR` and running the regression suites.

## 3. Restore

1. Stop the server.
2. Replace `data/abmdas.db`, `data/abmdas.db-wal`, `data/abmdas.db-shm` and `data/uploads/` with the backup copies.
3. Start the server and check `/api/meta/bootstrap` and the Dashboard.

## 4. PWA / offline

- Manifest: `/manifest.webmanifest`. Service worker: `/sw.js`.
- The shell and static assets are cached; API calls are never cached.
- Install via the browser's "Install app" prompt. Camera-based QR scanning uses `BarcodeDetector` with a JS fallback.

## 5. Hardening

- Security headers (X-Frame-Options, X-Content-Type-Options, Referrer-Policy, CSP) are set on every response.
- Cross-origin writes are blocked unless the Origin matches the Host.
- Sessions use an httpOnly cookie; passwords are hashed with scrypt.

## 6. Monitoring

- Check server stdout for errors. Audit trail: `/audit` page and `audit_logs` table.
- Stock integrity: compare `stock_balances.quantity` with `SUM(quantity_in - quantity_out)` from `stock_ledger`.
- Asset integrity: `assets` rows vs GRN auto-created counts.

## 7. Troubleshooting

- Login fails: verify `users` row and password hash; reset via `server/reset.js` only in dev.
- Missing data after restore: ensure `-wal`/`-shm` files were copied.
- PWA not updating: bump the `CACHE` version in `sw.js` and reload.
