# ABMDAS on Vercel (static PWA) + separate API backend

## Important: what Vercel can and cannot host

Vercel will host the **frontend only** (`public/`). The ABMDAS API must run on a
Node host with a persistent disk because the app uses:

- `server/index.js` → long-running `http.createServer()` / `server.listen()`
- `server/db.js` → SQLite file at `data/abmdas.db`
- `server/routes/files.js`, `bills.js`, `vendors.js`, `procurement.js` → uploaded files under `data/uploads/`
- `sessions` table → login sessions stored in the database

Vercel's filesystem is temporary. If the whole app were forced to run there,
the database/uploads would reset on cold starts and the app would reseed a
fresh `admin` account. **Do not upload `abmdas.db` to Vercel.**

```text
Browser
  │
  ├── https://abmdas.vercel.app/            → Vercel serves public/ (PWA)
  │
  └── https://abmdas.vercel.app/api/...     → Vercel rewrite
                                                │
                                                ▼
                                   https://abmdas-api.onrender.com/api/...
                                                │
                                                ▼
                                   persistent /data volume
                                   ├── abmdas.db
                                   └── uploads/
```

Because `/api/*` is proxied through the Vercel domain, the browser still sees
one origin. `credentials: 'same-origin'`, `HttpOnly`, `SameSite=Lax`, `Secure`,
and `connect-src 'self'` all keep working. `server/index.js` now reads
`X-Forwarded-Host` so the backend does not reject proxied POST/PUT/DELETE
requests as cross-origin.

---

## Step 1 — Put the source in GitHub

If you already have a GitHub repo connected to Vercel, just commit and push
these changes. Otherwise, from this folder:

```powershell
cd "C:\Users\nlaga\OneDrive\Documents\Default Project"
git init
git add .
git commit -m "ABMDAS Vercel static + separate API deployment"
git branch -M main
git remote add origin https://github.com/YOUR_ACCOUNT/abmdas.git
git push -u origin main
```

`data/` is already in `.gitignore`, so the live database is not committed.

---

## Step 2 — Create the API backend

Example using **Render**; Railway or Fly.io work the same way with a mounted
volume.

1. Create a new **Web Service** and connect the same GitHub repo.
2. Settings:
   - **Branch:** `main`
   - **Runtime:** Node
   - **Build Command:** `npm install` (there are currently no npm dependencies; this is harmless)
   - **Start Command:** `npm start`
3. Add a **persistent disk** mounted at `/data` (1 GB is plenty to start).
4. Add environment variables:

   ```bash
   ABMDAS_DATA_DIR=/data
   PORT=10000
   NODE_VERSION=24
   NODE_OPTIONS=--experimental-sqlite
   ```

   `NODE_VERSION=24` is preferred. If your host only offers Node 22, keep
   `NODE_OPTIONS=--experimental-sqlite` so `node:sqlite` is available.

5. Deploy, then test:

   ```text
   https://YOUR-API-HOST/api/health
   ```

   Expected:

   ```json
   { "ok": true, "uptime": 1, "timestamp": "..." }
   ```

---

## Step 3 — Copy the existing data once

This preserves the repaired PO 0058 discounts, item-name alignment, users,
settings, and uploads.

1. Stop the source server / supervisor first. SQLite is in WAL mode, so copying
   while it is running can miss recent writes. If you cannot stop it, copy
   `abmdas.db`, `abmdas.db-wal`, and `abmdas.db-shm` together.
2. Copy from the current live location:

   ```text
   C:\abmdas-data\abmdas.db       → backend /data/abmdas.db
   C:\abmdas-data\uploads\        → backend /data/uploads/
   ```

3. Start the backend again.
4. Log in with `admin` / `Admin@123`.
5. Confirm PO `PO/NLAGC/MUSIC/26-27/0058` still shows total `25532`, the
   `Discount` label, and the aligned item names.

> If you skip this step, the backend starts with a new seeded database and all
> real records are gone.

---

## Step 4 — Connect Vercel

1. Open `vercel.json` in the repo.
2. Replace the placeholder with your real backend origin:

   ```json
   "destination": "https://abmdas-api.onrender.com/api/:path*"
   ```

   Use the origin only — no trailing slash and no extra `/api` before `:path*`.

3. In the Vercel project settings, set **Output Directory** to `public`.
   (`vercel.json` also declares this, but setting it in the dashboard avoids
   ambiguity.)
4. Import/deploy the GitHub repo.
5. Vercel will serve `public/index.html`, CSS, JS, manifest, images, and the
   service worker. `/api/*` will be forwarded to the backend.

No CORS configuration is needed: the browser only talks to the Vercel domain.

---

## Step 5 — Verify the online deployment

- [ ] `https://YOUR-VERCEL-APP/api/health` returns `{"ok":true,...}`
- [ ] Login works with `admin` / `Admin@123`
- [ ] Session stays alive for 30 minutes idle, then logs out
- [ ] PO list opens `PO/NLAGC/MUSIC/26-27/0058`
- [ ] PO print is one A4 page, no QR, `Discount` label, no browser header/footer
- [ ] Signature space is visible and large enough
- [ ] Item names match Item Master
- [ ] Uploaded images/PDFs open via `/api/files/...`
- [ ] Service worker cache is `abmdas-shell-v47`

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Cannot reach the server` | Placeholder `YOUR-API-HOST` still in `vercel.json`, or backend is down | Replace placeholder; check `/api/health` on the backend directly |
| `403 Cross-origin request blocked` | Backend is running old `server/index.js` | Redeploy backend with the `X-Forwarded-Host` fix |
| Data resets after restart | Missing persistent disk or `ABMDAS_DATA_DIR` not set | Mount `/data`, set `ABMDAS_DATA_DIR=/data`, restore DB/uploads |
| Blank page / 404 on static files | Output Directory is not `public` | Set Output Directory to `public` in Vercel |
| Login works but files 404 | `uploads` not copied or wrong `ABMDAS_DATA_DIR` | Restore `/data/uploads` and redeploy backend |

The old `C:\abmdas` folder and the local supervisor remain useful for LAN/office
use, but they are not what Vercel deploys.
