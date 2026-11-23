# ABMDAS online deployment — Vercel PWA + persistent local API

## Delivered topology

```text
Browser
  │
  ├── https://abmdas.vercel.app/          → Vercel serves public/ (installable PWA)
  │
  └── https://abmdas.vercel.app/api/...   → Vercel rewrite
                                              │
                                              ▼
                          https://abmdas-api.tail8b0493.ts.net/api/...
                                              │
                                              ▼
                          Tailscale Funnel → 127.0.0.1:3000
                                              │
                                              ▼
                          C:\abmdas-data\abmdas.db
                          C:\abmdas-data\uploads\
```

- **Frontend:** Vercel project `abmdas`, branch `main`, Output Directory `public`.
- **Frontend URL:** <https://abmdas.vercel.app>
- **Backend public URL:** <https://abmdas-api.tail8b0493.ts.net>
- **Backend process:** local Node server started by `C:\abmdas-data\abmdas-supervisor.ps1`.
- **Persistence:** the existing SQLite database and uploads stay at `C:\abmdas-data`; nothing application-related is stored on Vercel's ephemeral filesystem.
- **Tunnel:** Tailscale Funnel provides a free, stable public HTTPS hostname and forwards port 443 to the local API on port 3000.

Render was evaluated first, but a persistent disk there requires a paid plan and a card. The no-card Tailscale topology was chosen instead.

---

## Why the API is not on Vercel

The ABMDAS server is a long-running Node HTTP service using:

- `server/index.js` → `http.createServer()` / `server.listen()`
- `server/db.js` → SQLite at `ABMDAS_DATA_DIR\abmdas.db`
- `server/routes/files.js`, `bills.js`, `vendors.js`, `procurement.js` → uploads under `ABMDAS_DATA_DIR\uploads`
- `sessions` table → server-side login sessions

Vercel is used **only** for `public/`. Do not commit or upload `abmdas.db` to Vercel.

---

## Configuration that must stay in place

### `vercel.json`

```json
{
  "version": 2,
  "outputDirectory": "public",
  "rewrites": [
    {
      "source": "/api/:path*",
      "destination": "https://abmdas-api.tail8b0493.ts.net/api/:path*"
    }
  ]
}
```

The rewrite keeps the `/api/...` path intact, so cookies, session handling, file responses and all existing endpoints work unchanged.

### Backend environment

Set in `C:\abmdas-data\abmdas-supervisor.ps1` before `Start-Process`:

```powershell
$env:ABMDAS_DATA_DIR = $dataDir                 # C:\abmdas-data
$env:ABMDAS_ALLOWED_ORIGINS = 'https://abmdas.vercel.app,https://abmdas-api.tail8b0493.ts.net'
$env:PORT = "3000"
```

`server/index.js` accepts a POST/PUT/DELETE when the browser `Origin` matches an explicit `ABMDAS_ALLOWED_ORIGINS` entry, or when it matches any host in the forwarded-host chain. This avoids false `403 Cross-origin request blocked` errors when Vercel and Tailscale both rewrite host headers.

### Tailscale Funnel

The backend is exposed with:

```powershell
& 'C:\Program Files\Tailscale\tailscale.exe' funnel --bg --yes 3000
```

Check it with:

```powershell
& 'C:\Program Files\Tailscale\tailscale.exe' funnel status
```

Expected handler:

```text
https://abmdas-api.tail8b0493.ts.net/
|-- proxy http://127.0.0.1:3000
```

The local machine must stay powered on, the ABMDAS supervisor must be running, and the Tailscale service must stay connected for the online URL to work.

---

## Day-to-day operations

### Restart the backend

```powershell
Get-CimInstance Win32_Process |
  Where-Object { $_.CommandLine -like '*abmdas-supervisor.ps1*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue |
  ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }

wscript 'C:\abmdas-data\abmdas-supervisor.vbs'
```

The supervisor writes to `C:\abmdas-data\watchdog.log`; server output goes to `server.log` and `server-error.log`.

### Deploy a source change

```powershell
cd "C:\Users\nlaga\OneDrive\Documents\Default Project"
git add .
git commit -m "Describe the change"
git push origin main
```

Vercel auto-deploys `main`. If `server/index.js`, `server/`, or the supervisor environment changed, restart the local backend too.

---

## Verification checklist

These checks were run against the live deployment:

- [x] `https://abmdas.vercel.app/api/health` → `{"ok":true,...}`
- [x] Login with `admin` / `Admin@123` through the Vercel UI
- [x] Login response returns `sessionTimeoutMs: 1800000` (30 minutes)
- [x] `Set-Cookie` is `HttpOnly; SameSite=Lax; Secure`
- [x] `https://abmdas.vercel.app/sw.js` contains `abmdas-shell-v47`
- [x] Served `css/app.css` matches the repository copy after newline normalization
- [x] PO `PO/NLAGC/MUSIC/26-27/0058` opens with total `₹25,532.00`, taxable `₹21,637.29`, SGST/CGST `₹1,947.36` each, and round off `0`
- [x] PO print has no QR, uses the `Discount` label, keeps the large signature band, and retains the A4 print rules
- [x] `scripts/qa/po8-item-name-alignment.js` → `failures: []`
- [x] `scripts/qa/po-discount-no-double.js` → `failures: []`
- [x] Demo item codes `ITM-00012`–`ITM-00020` remain retired (`active=0`, `deleted_at` set) and were not reused

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Cannot reach the server` on the online URL | Local backend or Tailscale is offline | Check `http://127.0.0.1:3000/api/health`, `tailscale status`, and `tailscale funnel status` |
| `403 Cross-origin request blocked` | Backend running old `server/index.js`, or `ABMDAS_ALLOWED_ORIGINS` missing | Restart the supervisor with the current script and allowlist |
| Health works on Tailscale URL but not Vercel URL | `vercel.json` rewrite points at the wrong host | Confirm destination is `https://abmdas-api.tail8b0493.ts.net/api/:path*`, then push/redeploy |
| Data resets | `ABMDAS_DATA_DIR` not set to `C:\abmdas-data` | Restore the env var in the supervisor and restart |
| Blank page or static 404 | Vercel Output Directory not `public` | Set Output Directory to `public` and redeploy |
| Stale UI after a release | Service worker cache | Keep cache name `abmdas-shell-v47`; hard-refresh once if needed |
