# ABMDAS — Administration Bill Management & Digital Approval System

An internal, web-based system for the **Administration Department of New Life AG Church** to register vendor bills, validate invoices, apply amount-based approval workflows, collect digital approvals, hand approved bills over to Accounts, and produce verifiable approval reports.

Built to the supplied SRS v1.0. It is a **self-contained Node.js application** with no external npm dependencies: the HTTP server uses Node's built-in `node:http`, the database uses the built-in `node:sqlite`, and the interface is a dependency-free ES-module single-page app.

---

## 1. What it does

| Area | Capabilities |
| --- | --- |
| **Vendors** | Vendor master with contact, statutory (GST/PAN), bank details and document uploads. Active / Inactive / Blacklisted status. Duplicate vendor-name protection. |
| **Bills** | Bill entry with vendor, department, category, basic invoice amount, automatic GST, transport charges, retention, snag-work hold, credit note, particulars, priority, attachments and advance adjustment. Draft / edit / submit. |
| **GST & transport** | Automatic GST from the basic invoice amount. A bill can be CGST + SGST (intra-state), IGST (inter-state) or Non-GST. Transport charges can be entered as GST or Non-GST and are added to the net amount. All amounts flow through to the approval report, bill detail, handover register, public verification page and consolidated statement. |
| **Retention, hold & credit note** | Retention can be a percentage of the basic invoice value or a directly entered amount. Retention and snag-work hold releases reduce the withheld amount; credit notes reduce the payable. All amounts flow through to the approval report, handover register, public verification page and reports. |
| **Duplicate invoices** | Invoice numbers are unique per vendor (case-insensitive). A duplicate returns a clear **409** error and links to the existing bill. |
| **Advances** | Record vendor advances, track adjusted and outstanding balances, adjust one or more advances against a bill, and reverse adjustments if a bill is cancelled. Full advance ledger. |
| **Approval workflow** | Configurable amount-band rules. Each rule has an ordered approval chain (stage name, approver role, optional specific approver, escalation days). Rules are evaluated on the bill's net amount; a fallback single-stage chain is always available. |
| **Digital approvals** | Approve, reject, return for correction or request clarification with remarks. Approver signature image and timestamp are recorded for every decision. |
| **Bulk approval** | The Approval Inbox supports checkboxes and select-all so several bills can be approved in one action. Each bill is processed independently; the response reports which bills succeeded and why any failed. |
| **Accounts handover** | Final approval automatically creates a numbered handover (`HND/…`) to Accounts. Accounts acknowledge receipt from the register. |
| **Consolidated statement** | A single printable / save-as-PDF statement covering all handovers that match the register filters. It includes basic, CGST, SGST, IGST, transport, total tax, net, deductions and payable totals, plus certification and signature blocks. |
| **Approval reports + QR** | Printable / save-as-PDF approval report with a QR code. Anyone can scan the QR to open a public verification page showing the approval chain. Links are HMAC-signed. |
| **Dashboard** | Pipeline value, pending/approved/rejected counts, monthly trend, department spend, turnaround time, top vendors and recent activity. |
| **Users & roles** | User accounts, role-based permissions, per-user digital signature, password reset, activate / lock / deactivate. |
| **Notifications** | In-app notifications for submissions, decisions, handovers and acknowledgements. |
| **Audit trail** | Immutable log of logins and every create / update / delete / approval action with before-and-after values, user, IP and timestamp. |
| **Reports** | 12 exportable registers and management reports with date/vendor/department filters, CSV export and print layout. |
| **Search** | Global header search across bills, invoices and vendors. |

**Explicitly out of scope (per the SRS):** accounting functions such as vouchers, ledgers, TDS computation, GST return filing, payment processing, UTR entry and bank reconciliation. ABMDAS computes the GST and transport amounts on each bill but stops at handover to Accounts.

---

## 2. Requirements

- **Node.js 22.13 or newer** (developed and tested on Node 26). Node 24/26 recommended.
- Any modern browser (Chrome, Edge, Firefox, Safari).
- No `npm install` is required — there are no third-party packages.

Check your version:

```powershell
node --version
```

---

## 3. Quick start

From the project folder:

```powershell
node server/index.js
```

On first run the application creates `data/abmdas.db`, creates the schema, and seeds demo users, vendors, departments, categories, permissions and workflow rules.

Open:

- **Local:** <http://localhost:3000>
- **Network:** the LAN address printed in the console, e.g. `http://192.168.1.163:3000`

If `npm` is available you can also use:

```powershell
npm start        # node server/index.js
npm run dev      # node --watch server/index.js (auto-restart on changes)
npm run reset    # delete all data and start fresh (asks for confirmation)
```

> On Windows, if PowerShell blocks `npm.ps1` because of the execution policy, run `node server/index.js` directly or use `npm.cmd` instead.

---

## 4. Default sign-in accounts

| Username | Password | Role | Purpose |
| --- | --- | --- | --- |
| `admin` | `Admin@123` | Super Administrator | Full system control |
| `mary` | `User@123` | Administration User | Bill entry and vendor management |
| `samuel` | `User@123` | Departmental Approver | First-stage approval |
| `daniel` | `User@123` | Administrator | Second-stage / higher-value approval |
| `pastor` | `User@123` | Administrative Pastor | Final approval |
| `accounts` | `User@123` | Accounts Viewer | Handover acknowledgement and reports |

**Change these passwords before real use** (My Profile → Change password), and create real accounts for staff.

---

## 5. How the approval workflow works

1. A user saves a bill as a **draft** or **submits** it for approval.
2. On submission, ABMDAS takes the bill's **net amount** (invoice + tax) and finds the best matching **active amount-band rule**.
3. The matching rule's ordered stages become the bill's approval chain. Each stage is assigned to a **role**, optionally to a **specific approver**, and carries an **escalation day** count.
4. Any user with the stage's role (or the named approver) can act on the current stage. Decisions are:
   - **Approve** — advances to the next stage, or finalises the bill.
   - **Reject** — closes the bill as rejected.
   - **Return** — sends it back to the creator for correction and resubmission.
   - **Request clarification** — puts the bill on hold until the creator responds.
5. On **final approval**, ABMDAS records the approval timestamp, stamps approver signatures, and automatically creates an **Accounts handover** entry.
6. Accounts acknowledges receipt in **Handover Register**. The bill's approval report and QR verification link remain available permanently.

Rules are managed at **Approval Workflow** (Super Administrator / users with `workflow.manage`). If no rule matches, the system guarantees a fallback single-stage chain so a bill can always be submitted.

Default workflow bands:

| Net amount | Approval chain |
| --- | --- |
| Up to ₹10,000 | Departmental Approval |
| ₹10,001 – ₹50,000 | Departmental Approval → Administrator Approval |
| ₹50,001 – ₹2,00,000 | Departmental Approval → Administrator Approval → Administrative Pastor Approval |
| Above ₹2,00,000 | Departmental Approval → Administrator Approval → Administrative Pastor Approval (customise as needed) |

Each seeded stage has a 3-day escalation setting. Adjust bands, stages and approvers on the **Approval Workflow** page to match your church's actual delegation of authority.

### 5.1 Retention, snag-work hold and credit notes

Every bill can carry the following additional amounts. They are entered on the bill form and appear on the bill detail page, approval report, handover register, public QR verification page and the relevant reports.

| Field | Meaning |
| --- | --- |
| **Retention %** | Percentage applied to the **basic invoice value** (before tax) to calculate the retention amount. |
| **Retention amount** | Calculated automatically from the percentage, or edited directly to override it. Cannot exceed the basic invoice value. |
| **Retention released** | Amount released from retention. The release date is optional — when it is left blank, the current system date is captured automatically. Cannot exceed the retention amount. |
| **Hold amount (pending snag works)** | Amount withheld until snag works are completed. |
| **Hold amount released** | Amount released on completion of snag works. The release date is optional and defaults to the current system date. Cannot exceed the hold amount. |
| **Credit note number / date / amount / remarks** | Credit note raised by the vendor; the amount reduces the payable. |

Invoice dates cannot be in the future. Release dates are optional, default to the current system date, and cannot be future-dated.

The payable amount is calculated as:

```
Payable = Net amount (basic invoice + total tax + transport)
          − Advance adjusted
          − (Retention amount − Retention released)
          − (Hold amount − Hold released)
          − Credit note amount
```

The system prevents the combined deductions from exceeding the net bill amount. Withheld amounts are shown separately from released amounts so that Accounts can see exactly what is still held back.

### 5.2 GST and transport charges

GST is calculated automatically from the **basic invoice amount**. The bill form updates CGST, SGST, IGST, transport GST, total tax and net amount as values are entered.

| Field | Meaning |
| --- | --- |
| **GST type** | `CGST + SGST` for intra-state supplies, `IGST` for inter-state supplies, or `Non-GST` where the vendor invoice carries no GST. |
| **GST rate (%)** | Rate applied to the basic invoice amount. Pick a standard slab (0%, 5%, 12%, 18% or 28%) or choose **Other rate** to enter any percentage between 0 and 100. For CGST + SGST the rate is split equally (e.g. 18% becomes 9% CGST + 9% SGST). Disabled for Non-GST bills. |
| **CGST / SGST / IGST amount** | Calculated automatically and shown read-only on the form. |
| **Transport type** | `No transport charge`, `Transport — GST`, or `Transport — Non-GST`. |
| **Transport amount** | Basic freight / transport charge. |
| **Transport GST rate (%)** | Applied only when transport type is GST. Uses the same standard slabs and **Other rate** option as the main GST rate. |
| **Transport GST amount** | Calculated automatically. |

New bills start with the rates configured under **Settings → Tax Defaults** (Default GST Rate and Default Transport GST Rate). Staff can still change the slab or enter a custom rate on each bill.

The totals are derived as:

```
Total tax = CGST + SGST + IGST + GST on transport
Net amount = Basic invoice amount + Total tax + Transport amount
```

One bill therefore supports all tax treatments (CGST + SGST, IGST or Non-GST) together with GST or Non-GST transport in a single entry, and may contain **multiple tax components at different GST rates** (for example Rs.2,500 at 18% and Rs.500 at 5%) in one invoice. For backward compatibility, callers that send only a single `taxAmount` have the GST rate inferred and the amount split into CGST and SGST.

The **Approval Inbox** supports bulk approval. Use the row checkboxes or the header checkbox to select bills, then choose **Approve selected**. Approvals are applied per bill at its current stage; a bill that cannot be approved (for example because you are not its current approver) is reported separately without blocking the others.

The **Handover Register** links to a **Consolidated Statement** at `#/handover/statement`. It prints in one pass with the organisation header, filter summary, tax and deduction totals, one row per handover, certification text and signature blocks. The print layout uses A4 with repeating table headers and avoids splitting rows across pages.

---

## 6. Roles and permissions

Every menu and API action is permission-based. The seeded roles are:

- **Super Administrator** — full access; cannot be modified.
- **Administration User** — bills, vendors, advances, reports.
- **Departmental Approver** — approval inbox and bill viewing.
- **Administrator** — wider approval authority and reports.
- **Administrative Pastor** — final-stage approval.
- **Accounts Viewer** — handover acknowledgement, reports, no bill creation.

Create additional roles at **Roles & Permissions**. Permissions are grouped by module (Dashboard, Bills, Advances, Vendors, Handover, Reports, Users, Roles, Workflow, Settings, Audit).

---

## 7. Data, backup and reset

All persistent state lives in the `data/` folder:

```
data/
  abmdas.db          SQLite database (users, bills, workflow, audit, settings …)
  uploads/
    bills/           bill attachments
    vendors/         vendor documents
```

### Backup

1. Stop the server (`Ctrl+C`).
2. Copy the entire `data/` folder to a safe location.
3. Restart the server.

Take backups regularly. The database and uploaded documents must be backed up together, because the database stores attachment metadata that points into `data/uploads/`.

### Restore

Stop the server, replace the `data/` folder with a backup copy, then restart.

### Reset to a fresh demo database

```powershell
node server/reset.js
```

Type `RESET` when prompted, then restart with `node server/index.js`.

To keep data outside the project folder, set `ABMDAS_DATA_DIR` before starting:

```powershell
$env:ABMDAS_DATA_DIR = "D:\ABMDAS-Data"
node server/index.js
```

---

## 8. Configuration

| Setting | Where | Default |
| --- | --- | --- |
| HTTP port | `PORT` environment variable | `3000` |
| Bind address | `HOST` environment variable | `0.0.0.0` (all interfaces, LAN-accessible) |
| Data folder | `ABMDAS_DATA_DIR` environment variable | `./data` |
| Organisation name, department, address, currency | Settings page | New Life AG Church |
| Report footer | Settings page | — |
| Public base URL for QR links | Settings page | Current request host |
| Email notifications | Settings page | Disabled |
| Default GST rate for new bills | Settings page → Tax Defaults | 18% |
| Default transport GST rate for new bills | Settings page → Tax Defaults | 18% |

Example for a fixed internal URL:

```powershell
$env:PORT = "8080"
$env:HOST = "0.0.0.0"
node server/index.js
```

### QR verification links

The QR code on an approval report points to:

```
<public_base_url>/#/verify/<billId>.<hmac>
```

Set **Public Base URL** in Settings to the address staff will use (for example `https://abmdas.church.local`) so printed QR codes remain valid. If left blank, the current host is used at report-generation time.

---

## 9. Deploying on the church network

ABMDAS is designed for internal use. A simple deployment:

1. Install Node.js on a always-on office PC or small server.
2. Copy this folder to the machine, e.g. `C:\ABMDAS`.
3. Start it with `node server/index.js` (or `npm start`).
4. Allow inbound TCP port 3000 in Windows Firewall for the local subnet.
5. Share the printed LAN URL (e.g. `http://192.168.1.163:3000`) with staff.

For a stable address, give the server a fixed IP or a local DNS name.

### Recommended for production

- Put the app behind **IIS, nginx or Caddy** with **HTTPS** and forward to `http://127.0.0.1:3000`. Use `X-Forwarded-Proto: https` so session cookies are marked `Secure`.
- Do **not** expose ABMDAS directly to the public internet.
- Run it as a Windows service (for example with NSSM or Task Scheduler “At startup”) so it restarts after reboots.
- Restrict file-system access to the `data/` folder.
- Change all demo passwords and remove unused accounts.

Example nginx reverse-proxy block:

```nginx
server {
  listen 443 ssl;
  server_name abmdas.church.local;

  ssl_certificate     C:/certs/abmdas.crt;
  ssl_certificate_key C:/certs/abmdas.key;

  location / {
    proxy_pass         http://127.0.0.1:3000;
    proxy_set_header   Host $host;
    proxy_set_header   X-Forwarded-Proto https;
    proxy_set_header   X-Real-IP $remote_addr;
    client_max_body_size 35m;
  }
}
```

---

## 10. Security model

- Passwords are hashed with **scrypt** and a per-user random salt.
- Sessions use random tokens stored in the database and sent in an **HttpOnly, SameSite=Lax** cookie. Set `Secure` automatically when HTTPS is detected through `X-Forwarded-Proto`.
- Public QR verification links use **HMAC-SHA256** signatures tied to the application secret. The secret is generated on first run and stored in the database.
- State-changing API requests are protected by a **same-origin check**.
- A strict **Content-Security-Policy** blocks inline scripts and external resources.
- The **audit trail** records logins and all significant changes with old/new values.
- Uploaded files are stored outside the web root and served only through authenticated download endpoints (bill/vendor documents).
- Bill and vendor uploads are limited to 5 MB per file and a 30 MB JSON request body.

---

## 11. Project structure

```
ABMDAS/
  package.json
  README.md
  public/
    index.html
    css/app.css              Design system, responsive layout, print styles
    img/favicon.svg
    vendor/qrcode.js         Vendored MIT QR generator
    js/
      app.js                 SPA shell, auth, routing, notifications
      api.js                 Fetch wrapper
      state.js               Session/bootstrap state and permission helper
      ui.js                  Shared UI helpers (modals, toasts, icons, formatting)
      router.js              Hash router helpers
      pages/                 dashboard, bills, bill-form, approvals, vendors,
                             advances, handover, reports, admin, verify
  server/
    index.js                 HTTP server, static files, security headers
    db.js                    Schema, seed data, sequence repair
    auth.js                  Password hashing, sessions, permissions
    http.js                  Cookie/JSON/static/upload helpers
    router.js                Minimal method + path router
    workflow.js              Approval-chain selection and fallback
    util.js                  Numbering, audit, notifications, settings
    reset.js                 Data reset utility
    services/advance.js      Advance adjustment ledger
    routes/                  auth, users, vendors, bills, advances, handover,
                             files, dashboard, reports, admin
  data/                      Created at runtime (gitignored)
```

---

## 12. Troubleshooting

| Problem | Fix |
| --- | --- |
| `npm` fails with “running scripts is disabled” | Use `node server/index.js`, or `npm.cmd start`. |
| `Cannot find module 'node:sqlite'` | Upgrade Node.js to 22.13+ (Node 24/26 recommended). |
| Port 3000 already in use | Set another port: `$env:PORT=8080; node server/index.js`. |
| Other devices cannot reach the app | Check Windows Firewall inbound rule for the port and confirm both devices are on the same network. |
| QR links point to `localhost` | Set **Public Base URL** in Settings to the LAN/HTTPS address, then reprint reports. |
| Login page loads but API calls fail | Confirm you opened the app through the same host/port that serves the API and that cookies are enabled. |
| Need to start over | Stop the server, run `node server/reset.js`, type `RESET`, restart. |

---

## 13. Notes on scope and verification

- This system intentionally stops before accounting. Accounts receives the approved bill and its verification report; subsequent voucher, ledger, GST/TDS, payment and reconciliation work happens in the organisation's accounting system.
- Approval reports are generated from the system of record and include a QR link to a read-only public verification page. Verification confirms the bill number, vendor, invoice, amounts, status and approval chain.
- The application was smoke-tested end to end: login, bootstrap, every page, all 12 reports + CSV, advance creation, bill creation with adjustment, duplicate-invoice rejection, multi-stage submission and approval, automatic handover and acknowledgement, approval report + public QR verification (valid and invalid), user/role/workflow CRUD, settings/profile round-trips, and static assets.
