# Enterprise Procurement, Inventory & Asset Management System

**Status:** Architecture and delivery plan — Phases 0a, 0b, 1a, 1b, 2, 3, 4 and 5a delivered
**Base system:** ABMDAS (Administration Bill Management & Digital Approval System)
**Decisions:** Extend ABMDAS modularly · SQLite · PWA · In-app notifications only

---

## 1. Guiding decisions

| Decision | Choice | Consequence |
|---|---|---|
| Delivery model | Extend ABMDAS as a modular monolith | Reuse auth, RBAC, units, vendors, workflow, invoices, handover, audit, print/QR |
| Database | SQLite (`data/abmdas.db`), WAL mode | Single-server deployment; one writer at a time; reporting must use indexed views and pagination |
| Web client | Existing vanilla SPA | No build step; shared API and components |
| Mobile | Progressive Web App | Camera-based barcode/QR scanning; installable; no app-store release |
| Notifications | In-app only | No SMTP, WhatsApp or push delivery; notification records still written for the bell/inbox |
| Approval engine | Extend `workflow_rules` / `workflow_stages` | Rules keyed by unit, department, requirement type, item category and amount |
| Audit | Append-only `audit_logs`, soft delete | No physical deletion of business records |

---

## 0. Non-disturbance guarantee and unchanged login

The existing ABMDAS installation is the system of record and must continue to behave exactly as it does today.

- **Login credentials and endpoints are unchanged.** Existing usernames and passwords, `/api/auth/login`, `/api/auth/me`, password rules and lockout behaviour are not modified. Sessions now use a 30-minute idle timeout with automatic logout. The Super Administrator continues to sign in with the same credentials.
- **No existing table is renamed, dropped or altered.** All new structures are additive `CREATE TABLE IF NOT EXISTS` statements. Existing `users`, `roles`, `units`, `vendors`, `bills`, `advances`, `imprests`, `handover`, `workflow_rules`, `workflow_stages`, `settings`, `sequences` and `audit_logs` remain untouched.
- **No existing route or page is modified.** New endpoints live under `/api/procurement/...`; new screens are additional sidebar entries. Existing bill, advance, imprest, handover, vendor, user, workflow, report and settings screens keep their behaviour.
- **Roles and permissions are additive.** Existing roles keep their current grants and users keep their current assignments. New roles are inserted only when missing.
- **Primary keys and numbering are not renumbered.** New document types use new `sequences` keys.
- **Regression gate.** After every phase the existing ABMDAS suites (bills, imprests, advances, units, tax, fields, date) must pass unchanged.
- **Deployment.** The same SQLite database file and the same startup command are used; no separate login or second application is introduced.

### Procurement workflow tables (separate from ABMDAS)

To avoid altering the existing approval tables, procurement uses its own rule tables:

```
procurement_workflow_rules(
  id, unit_id, department_id, requirement_type, item_category_id,
  min_amount, max_amount, active, created_at, updated_at
)
procurement_workflow_stages(
  id, rule_id, sequence, name, role_id, user_id, escalation_days
)
```

ABMDAS `workflow_rules` and `workflow_stages` remain the sole source for bill, advance and imprest approvals.

---

## 2. Target architecture

```
┌──────────────────────────────────────────────────────────────┐
│ Web SPA (existing)              PWA / mobile browser          │
│  · procurement pages            · barcode/QR scanner          │
│  · inventory pages              · approval inbox              │
│  · asset pages                  · asset verification          │
└───────────────────────────┬──────────────────────────────────┘
                            │ REST JSON + session cookie
┌───────────────────────────▼──────────────────────────────────┐
│ server/index.js + router                                     │
│  auth · RBAC · units · audit · workflow · files · reports    │
├──────────────────────────────────────────────────────────────┤
│ Domain modules (server/routes)                               │
│  org · items · requisitions · sourcing · purchase-orders     │
│  receiving · invoices · inventory · assets · maintenance     │
│  verification · disposal · dashboards                        │
├──────────────────────────────────────────────────────────────┤
│ SQLite (WAL)  ·  data/uploads  ·  background-safe jobs       │
└──────────────────────────────────────────────────────────────┘
```

### Module boundaries

| Module | Responsibility | Reuses |
|---|---|---|
| `org` | Branches, campuses, buildings, floors, rooms, cost centers | Units, departments |
| `items` | Item master, item categories, UOM, reorder levels | Categories |
| `vendors` | Vendor master, documents, evaluation ratings | Existing vendor module |
| `requisitions` | Requirement capture, classification, approval | Workflow engine |
| `sourcing` | RFQ, vendor responses, quotations, comparative statement | Vendors, files |
| `purchase-orders` | PO creation, revision, partial delivery, closure | Workflow, files |
| `receiving` | GRN/MRN, excess/rejection validation | PO, items |
| `invoices` | Invoice entry and ABMDAS approval routing | Existing bills workflow |
| `inventory` | Stock ledger, issue/return/transfer/adjustment/verification | Items, stores |
| `assets` | Asset register, allocation, custody, location, labels | Items, employees |
| `maintenance` | AMC, preventive schedule, breakdown complaints | Assets, vendors |
| `asset-audit` | Physical verification, missing/damaged reporting | Assets, PWA scanner |
| `disposal` | Scrap/write-off/donation/auction approval | Workflow |
| `dashboards` | Executive, procurement, inventory, asset, finance KPIs | Read models |
| `reports` | Register and analysis reports A–Z | SQL views, CSV/PDF |
| `notifications` | In-app notification records and bell counts | Existing notifications |

---

## 3. SQLite conventions

- `PRAGMA journal_mode = WAL`, `foreign_keys = ON`, `busy_timeout = 5000`.
- Every table: `id INTEGER PRIMARY KEY AUTOINCREMENT`, `created_at`, `updated_at`.
- Business records carry `deleted_at`, `deleted_by`, `delete_reason`; queries filter `deleted_at IS NULL`.
- Money stored as rounded `REAL` consistent with existing ABMDAS columns; quantities as `REAL`.
- Status values stored as lowercase snake-case strings; UI maps to labels.
- Referential integrity enforced; use `ON DELETE RESTRICT` for masters and `ON DELETE CASCADE` for line items only.
- Numbering through the existing `sequences` table (`PR/2026/0001`, `RFQ/2026/0001`, `PO/2026/0001`, `GRN/2026/0001`, `AST/2026/000001`).
- New tables are additive; no destructive migration of ABMDAS data.

---

## 4. Phase 0 — Foundation schema

New master tables:

```
branches(id, unit_id, code, name, active, deleted_at, ...)
campuses(id, branch_id, code, name, active, deleted_at, ...)
buildings(id, campus_id, code, name, active, deleted_at, ...)
floors(id, building_id, code, name, active, deleted_at, ...)
rooms(id, floor_id, code, name, room_type, active, deleted_at, ...)
cost_centers(id, unit_id, code, name, active, deleted_at, ...)

employees(
  id, user_id, employee_code, name, department_id, designation,
  email, mobile, reporting_manager_id, unit_id, status, deleted_at, ...
)

vendors (extend existing)
  pan_number, contact_person, address, evaluation fields via vendor_evaluations

vendor_evaluations(
  id, vendor_id, delivery_rating, quality_rating, pricing_rating,
  service_rating, comments, evaluated_by, evaluated_at, ...
)

item_categories(id, code, name, parent_id, item_type, active, deleted_at, ...)
uoms(id, code, name, active)
stores(id, unit_id, code, name, store_type, active, deleted_at, ...)
bins(id, store_id, code, name, active, deleted_at, ...)

items(
  id, item_code, name, category_id, sub_category_id, uom_id,
  item_type CHECK(item_type IN ('consumable','asset','service')),
  reorder_level, min_stock, max_stock, standard_cost,
  track_inventory, track_asset, active, deleted_at, ...
)
```

RBAC additions: `staff`, `department_head`, `store_incharge`, `procurement_officer`, `asset_custodian`, `auditor`, `senior_management`.

Workflow extension: dedicated `procurement_workflow_rules` / `procurement_workflow_stages` tables keyed by unit, department, requirement type, item category and amount. Resolution order: most specific match first, then amount band, then global rule. ABMDAS workflow tables are not modified.

Acceptance: existing ABMDAS tests still pass; new masters have CRUD APIs and admin pages; no transactional data required yet.

---

## 5. Phase 1 — Consumables and procurement

### 5.1 Requisition

```
requisitions(
  id, requisition_no, unit_id, department_id, cost_center_id,
  requested_by, requirement_type CHECK(consumable|asset|service),
  purpose, required_by, status, current_stage, submitted_at,
  approved_at, deleted_at, ...
)
requisition_items(
  id, requisition_id, item_id, description, uom_id, quantity,
  estimated_unit_cost, estimated_total, ...
)
```

Statuses: `draft → pending → approved → store_verification → issued | sourcing → closed`
plus `returned`, `rejected`, `cancelled`.

Store verification outcome:
- `stock_available` → create stock issue → acknowledgement → close.
- `stock_unavailable` → auto-create purchase requisition → sourcing.

### 5.2 Sourcing

```
rfqs(id, rfq_no, requisition_id, status, issued_at, due_at, ...)
rfq_vendors(id, rfq_id, vendor_id, sent_at, response_status, ...)
quotations(id, quotation_no, rfq_id, vendor_id, received_at, valid_until,
           subtotal, gst_amount, total, warranty, delivery_days,
           payment_terms, support_terms, status, ...)
quotation_items(id, quotation_id, item_id, description, quantity,
                unit_price, gst_rate, line_total, ...)
comparative_statements(id, cs_no, rfq_id, status, recommendation_notes,
                       recommended_quotation_id, prepared_by, approved_by, ...)
```

Comparison criteria: cost, GST, total value, warranty, delivery period, support terms, vendor rating, payment terms.

### 5.3 Purchase order and receipt

```
purchase_orders(id, po_no, quotation_id, vendor_id, unit_id, department_id,
                po_date, subtotal, gst_amount, total, status, revision_no,
                closed_at, deleted_at, ...)
po_items(id, po_id, item_id, description, quantity, received_quantity,
         unit_price, gst_rate, line_total, ...)
po_revisions(id, po_id, revision_no, reason, snapshot_json, created_by, created_at)

grns(id, grn_no, po_id, received_date, store_id, status,
     received_by, verified_by, ...)
grn_items(id, grn_id, po_item_id, item_id, ordered_qty, received_qty,
          accepted_qty, rejected_qty, rejection_reason, ...)
```

Rules: GRN is mandatory before invoice entry; excess receipt requires authorisation; rejected quantities update PO pending delivery only for accepted stock.

### 5.4 Invoice integration

```
invoices(id, invoice_no, vendor_invoice_no, vendor_id, po_id, grn_id,
         unit_id, department_id, invoice_date, due_date, subtotal,
         gst_amount, total, attachment_id, status, abmdas_bill_id, ...)
invoice_items(id, invoice_id, item_id, description, quantity,
              unit_price, gst_rate, line_total, ...)
```

Flow: invoice entry → validate PO/GRN → create linked ABMDAS bill → ABMDAS approval chain → approved bill → Accounts handover. `abmdas_bill_id` links the two records; the existing bill remains the approval source of truth.

### 5.5 Inventory

```
stock_ledger(
  id, unit_id, store_id, bin_id, item_id, transaction_type,
  reference_type, reference_id, quantity_in, quantity_out,
  unit_cost, balance_after, transaction_date, created_by, created_at
)
stock_balances(store_id, bin_id, item_id, quantity, updated_at)  -- maintained transactionally
stock_issues(id, issue_no, requisition_id, store_id, issued_to,
             issued_by, issued_at, status, acknowledged_at, ...)
stock_issue_items(id, issue_id, item_id, quantity, unit_cost, ...)
stock_returns, stock_transfers, stock_adjustments, physical_verifications (+ line tables)
```

`stock_ledger` is append-only. Balances are updated in the same transaction as each movement; reorder alerts compare balance against `items.reorder_level`.

Acceptance: consumable in-stock and out-of-stock flows run end to end; stock ledger reconciles to balances; invoice creates a linked ABMDAS bill; no negative stock.

---

## 6. Phase 2 — Asset lifecycle

```
assets(
  id, asset_code, asset_name, item_id, category_id, unit_id,
  department_id, primary_location_id, sub_location_id,
  custodian_employee_id, vendor_id, purchase_date, purchase_value,
  warranty_start, warranty_end, status, qr_payload, barcode_value,
  deleted_at, ...
)
asset_allocations(id, asset_id, employee_id, department_id,
                  allocated_at, returned_at, remarks, ...)
asset_transfers(id, asset_id, from_location_id, to_location_id,
                from_custodian_id, to_custodian_id, transferred_at, ...)
asset_maintenance(id, asset_id, maintenance_type, vendor_id,
                  scheduled_date, completed_date, cost, status, ...)
asset_verifications(id, asset_id, verified_at, verified_by,
                    location_match, condition, remarks, ...)
asset_disposals(id, asset_id, method, reason, requested_by,
                approved_by, disposed_at, ...)
asset_labels(id, asset_id, label_type, printed_at, printed_by)
```

Statuses: `ordered → received → created → allocated → in_use → under_maintenance → under_repair → transferred → missing → disposed`.
Label generation: `AST-<UNIT>-<YYYY>-<000001>`; Code128 barcode + QR payload pointing to the asset detail URL; single, bulk and reprint actions.

Acceptance: asset auto-created from GRN/invoice; QR resolves to asset; allocation and custodian history preserved; verification and disposal are approval-gated.

---

## 7. Phase 3 — Services, dashboards, reports

- Service requisitions reuse sourcing and PO/work-order flow; no stock or asset records.
- Dashboards: executive, procurement, inventory, asset, finance, using indexed aggregate queries.
- Reports A–Z: implement as SQL-backed report definitions with CSV/PDF export and permission checks.
- PWA: manifest, service worker, installable shell, camera scanner using `BarcodeDetector` with a JS fallback, offline-safe form drafts.

---

## 8. API and UI conventions

- Route prefix: `/api/<module>/...`; existing ABMDAS routes unchanged.
- Responses: `{ data }` or existing shapes; errors `{ error }` with HTTP status.
- All queries scoped by `ctx.unitIds` unless the user sees all units.
- Every write calls `audit(ctx, ACTION, entity, id, before, after)`.
- List endpoints support `page`, `pageSize`, `q`, `status`, `sort`.
- UI pages per module under `public/js/pages/`, registered in `public/js/app.js`.
- Print/label layouts use the existing report CSS and `@page` rules.

---

## 9. Testing and acceptance

| Level | Coverage |
|---|---|
| Syntax | `node --check` on every changed server and client module |
| Integration | Isolated temp DB per suite; existing ABMDAS tests must stay green |
| New suites | `items`, `requisitions`, `sourcing`, `purchase-orders`, `receiving`, `inventory`, `assets`, `disposal` |
| Data integrity | Stock ledger vs balances, PO received qty vs GRN accepted qty, asset vs invoice |
| Negative tests | over-receipt, negative stock, unapproved PO invoice, duplicate GRN, missing acknowledgement |
| UI | Browser check of each new page and print label |
| Regression | Existing bill, imprest, advance, unit and tax suites |

---

## 10. Delivery sequence

1. Phase 0: org, employee, item, vendor evaluation, RBAC, workflow dimensions, audit.
2. Phase 1a/1b: requisitions, approvals, store verification, stock ledger, sourcing, purchase orders, receipts and invoices → ABMDAS.
3. Phase 2: asset lifecycle, labels, maintenance, verification and disposal.
4. Phase 3: services, dashboards and reports A–Z.
5. Phase 4: PWA, hardening, UAT, backup and operational runbook.

Each phase is additive, independently testable, and must not regress the existing ABMDAS bill/advance/imprest workflows.

---

## 11. Delivery log

### Phase 0a — foundation and item master (delivered)

| Item | Detail |
|---|---|
| Additive schema | `server/procurement/schema.js` creates branches, campuses, buildings, floors, rooms, cost centers, employees, UOMs, item categories, stores, bins, items, vendor evaluations and separate procurement workflow rules/stages. Only `CREATE TABLE/INDEX IF NOT EXISTS`; no ABMDAS table is altered. |
| Seeds | 15 UOMs, 56 hierarchical item categories across consumable, asset and service types. Repeat-safe `INSERT OR IGNORE`. |
| RBAC | New permissions `item.view` and `item.manage`; new roles `staff`, `department_head`, `store_incharge`, `procurement_officer`, `asset_custodian`, `senior_management`, `auditor`. Existing roles keep their grants; item permissions are added to administration roles. |
| API | `/api/procurement/meta`, `/api/procurement/items` (list, detail, create, update, soft delete), `/api/procurement/item-categories`, `/api/procurement/uoms`. All guarded and audited. |
| UI | Procurement → Items list and form, type-aware category filtering, stock controls, retire action. Added additively in `public/js/app.js`. |
| Login | Unchanged: same credentials, `/api/auth/login`, session cookie and `/api/auth/me`. |
| Verification | New suite 30/30; existing bill/imprest 17/0; existing imprest workflow 15/0; main DB 28/28; deployment snapshot 5/5; browser create/edit/retire checked with no console errors. |

### Phase 0b — organization, employees, stores and vendor evaluation (delivered)

| Item | Detail |
|---|---|
| Additive schema | Uses the hierarchy tables created in Phase 0a (`branches`, `campuses`, `buildings`, `floors`, `rooms`, `cost_centers`, `employees`, `stores`, `bins`, `vendor_evaluations`) plus hierarchy indexes. No ABMDAS table is altered. |
| RBAC | New permissions `org.view`, `org.manage`, `employee.view`, `employee.manage`, `store.view`, `store.manage` and `vendor.evaluate`; granted additively to existing administration and procurement roles. |
| Organization API | `/api/procurement/org` returns the full hierarchy; `/api/procurement/org/{branches,campuses,buildings,floors,rooms,cost-centers}` support create, update and soft retire. Unique codes per level, parent-scoped code checks for floors/rooms, and parents with active children cannot be retired. Unit access walks branch → campus → building → floor → room. |
| Employee API | `/api/procurement/employees` list/detail/create/update/soft retire with filters; `/meta` supplies units, departments, managers and user accounts. Auto employee codes (`EMP-0001`), optional one-to-one link to an existing ABMDAS login, manager cycle/self checks, invalid email rejection and retirement blocked while direct reports exist. |
| Stores API | `/api/procurement/stores` with store types (main/sub/transit) and nested bins. Unique store codes and per-store bin codes; stores with active bins cannot be retired. |
| Vendor evaluation API | `/api/procurement/vendor-evaluations` returns per-vendor averages; `/{vendorId}/history` lists the append-only record; `POST /{vendorId}` validates whole-number ratings 0–5. No edit or delete route exists. |
| UI | Procurement → Organization (tabbed hierarchy with modal create/edit/retire), Employees (filters, KPI cards, linked login and reporting manager), Stores (store cards with bins) and Vendor Evaluation (averages, evaluate modal, history modal). Added additively to `public/js/app.js`. |
| Login | Unchanged: same `admin` credentials, `/api/auth/login`, session cookie and `/api/auth/me`. |
| Verification | New Phase 0b suite 62/62 (hierarchy CRUD and parent rules, employee codes/links/managers, store/bin rules, evaluation validation and averages, audit). Phase 0a suite 30/30. Existing bill/imprest 17/0 and imprest workflow 15/0 on isolated databases. Main DB verified: 1 unit, 1 `admin`, 26 departments, 155 ABMDAS categories, 0 vendors/bills/advances/imprests, new procurement masters empty. Browser smoke test on an isolated DB created branch, campus, employee, store, bin and vendor evaluation with no console errors. |

### Phase 1a — requisitions, approvals, store verification and stock (delivered)

| Item | Detail |
|---|---|
| Additive schema | `server/procurement/schema.js` creates `requisitions`, `requisition_items`, `requisition_stages`, `stock_balances`, `stock_ledger`, `stock_issues`, `stock_issue_items`, `stock_adjustments`, their indexes, and a repeat-safe default global procurement workflow (Departmental Approval → Procurement Approval). Only `CREATE TABLE/INDEX IF NOT EXISTS`; no ABMDAS table is altered. Setting `procurement.phase1a.v1` marks the phase. |
| Numbering | `PR/YYYY/NNNN` requisitions, `ISS/YYYY/NNNN` issues and `ADJ/YYYY/NNNN` adjustments, generated through the existing `sequences` table. |
| RBAC | New permissions `requisition.view`, `requisition.create`, `requisition.approve`, `requisition.verify`, `stock.view` and `stock.manage`; granted additively to the relevant existing roles. `super_admin` can act on any approval stage. |
| Requisition API | `/api/procurement/requisitions` list/create with `/meta`, detail/update/soft delete, and `submit`, `approve`, `return`, `reject`, `cancel`, `verify`, `acknowledge`. Draft/returned editing is owner-scoped; unit access and role permissions are enforced; the workflow is snapshotted to `requisition_stages` on submit, and stages whose role matches the creator are skipped to match ABMDAS behaviour. |
| Fulfilment flow | Final approval sends consumable requisitions to `store_verification`; assets and services go directly to `sourcing`. Store verification is all-or-nothing per requisition, takes a single store/bin, prevents negative stock, writes an issue plus append-only ledger entries and closes only after the requester acknowledges. Unavailable stock moves the requisition to `sourcing` with the verification outcome recorded. |
| Stock API | `/api/procurement/stock/meta`, `balances` (with quantity/value/below-reorder summary), append-only `ledger` with filters, `issues` list/detail, and `adjustments` list/create. Balances update transactionally inside the adjustment/issue transaction; decreasing below zero is rejected. |
| UI | Procurement → Requisitions (KPI list with status/type/mine filters and approval inbox, create/edit form with dynamic lines and estimated totals, detail with approval timeline, issue card and context actions plus the store verification modal) and Stock Register (Balances, Stock Ledger, Issues and Adjustments tabs, filters, adjustment modal and issue detail modal). Added additively to `public/js/app.js`. |
| Login | Unchanged: same `admin` credentials, `/api/auth/login`, session cookie and `/api/auth/me`. |
| Verification | New Phase 1a suite 65/65 on an isolated database (numbering, draft/return/resubmit, stage snapshot and role checks, approval routing, store verification and issue, insufficient-stock and sourcing paths, acknowledgement, cancellation and soft delete, stock balances/ledger/adjustments, audit). Phase 0b 62/62, Phase 0a 30/30, existing bill/imprest 17/0 and imprest workflow 17/0 on isolated databases. Main DB verified unchanged: 1 unit, 1 `admin`, 26 departments, 155 ABMDAS categories, 0 vendors/bills/advances/imprests; Phase 0a/0b procurement masters untouched (0 items, 0 stores, 56 item categories, 15 UOMs, default 2-stage procurement workflow). Browser smoke test on an isolated DB created and submitted a requisition, approved both stages, verified and issued stock, acknowledged and closed it, and exercised all four Stock Register tabs and the adjustment modal with no console errors. |

### Phase 1b — sourcing, purchase orders, receipts and invoice integration (delivered)

| Item | Detail |
|---|---|
| Additive schema | `server/procurement/schema.js` creates `rfqs`, `rfq_items`, `rfq_vendors`, `quotations`, `quotation_items`, `comparative_statements`, `purchase_orders`, `po_items`, `po_revisions`, `grns`, `grn_items`, `invoices` and `invoice_items`, with indexes and reference links back to requisitions, vendors, stores, bins and ABMDAS bills. Only `CREATE TABLE/INDEX IF NOT EXISTS`; no ABMDAS table is altered. Setting `procurement.phase1b.v1` marks the phase. |
| Numbering | `RFQ/YYYY/NNNN`, `QT/YYYY/NNNN`, `CS/YYYY/NNNN`, `GRN/YYYY/NNNN` and `PINV/YYYY/NNNN`, generated through the existing `sequences` table. New purchase orders use `PO/<unit code>/<dept code>/<YY-YY>/<NNNN>`; legacy `PO/YYYY/NNNN` values remain unchanged. |
| RBAC | New permissions `sourcing.view`, `sourcing.manage`, `po.view`, `po.manage`, `grn.view`, `grn.manage`, `invoice.view` and `invoice.manage`; granted additively to the relevant existing roles. `super_admin` retains full access and existing grants are unchanged. |
| Sourcing API | `/api/procurement/sourcing/meta`, `/api/procurement/rfqs` (list/detail/create/update/soft delete), `issue`, `close`, `cancel`, vendor `invite`/`uninvite`, quotations (`POST /api/procurement/rfqs/:id/quotations`, list/detail/update/withdraw) and comparative statements (`prepare`, `approve`, `reject`). RFQs can copy an approved requisition or be raised directly; approved comparative statements close the RFQ and make the recommended quotation awardable. |
| Purchase order API | `/api/procurement/purchase-orders` with `/meta`, list/detail/create/update/soft delete, `issue`, `revise`, `cancel`, and receipt endpoints `GET/POST /api/procurement/grns`, detail, `post` and `cancel`. Revisions snapshot the previous state in `po_revisions` and apply only to issued or partially received orders; drafts are edited directly. Posting a GRN updates PO received/rejected quantities and posts accepted inventory quantities to `stock_balances`/`stock_ledger` as `receipt` with reference type `grn`. Purchase orders may now be created directly, without a comparative statement: vendor, unit, department and line items are entered by hand and the order carries no requisition, RFQ, comparative or quotation link. |
| Invoice API | `/api/procurement/invoices` with `/meta`, list/detail/create/update/soft delete, `validate`, `create-bill`, `cancel` and `reject`. Invoice lines are generated from posted GRN accepted quantities (or explicit lines capped at accepted-minus-invoiced per PO line). Validation creates the linked draft ABMDAS bill by default; `createBill: false` validates without a bill and `POST /invoices/:id/create-bill` creates it later. ABMDAS bills remain the approval and payment source of truth. |
| UI | Procurement → Sourcing (RFQ list/form/detail with requisition copy, item lines, vendor invitations, quotation matrix, quotation entry, comparative prepare/approve/reject), Purchase Orders (list/form/detail with direct or comparison-based creation, issue/revise/cancel/delete and linked receipts/invoices), Goods Receipts (list plus dedicated receipt entry page with store/bin selection, posting and cancellation) and Procurement Invoices (list/form/detail with receipt-basis preview, validation modal, linked bill creation and bill links). Added additively to `public/js/app.js` with no changes to existing ABMDAS pages. |
| Login | Unchanged: same `admin` credentials, `/api/auth/login`, session cookie and `/api/auth/me`. |
| Verification | New Phase 1b suite 90/90 on a fresh isolated database (RFQ and direct RFQ flows, invitations, quotations, comparative approval/rejection, PO creation from a comparative statement and direct PO creation without one, issue/revise/cancel/delete, GRN posting with accepted-stock ledger entries, over-receipt authorisation, invoice generation and caps, validation with and without a bill, bill linkage, soft deletes and audit). Regressions green: Phase 1a 65/65, Phase 0b 62/62, Phase 0a 30/30, existing bill/imprest 17/0 and imprest workflow 15/0. Phase 1b schema and permissions applied to the main and deployment databases; main data verified unchanged. End-to-end browser smoke test on an isolated DB completed RFQ issue → quotation → comparative approval → PO create/issue → GRN create/post → invoice create/validate → linked draft ABMDAS bill with no console errors. |

### Phase 2 — asset lifecycle, labels, maintenance, verification and disposal (delivered)

| Item | Detail |
|---|---|
| Additive schema | `server/procurement/schema.js` creates `assets`, `asset_allocations`, `asset_transfers`, `asset_maintenance`, `asset_verifications`, `asset_disposals` and `asset_labels`, with indexes and links back to items, categories, units, departments, stores, bins, rooms, employees, vendors, purchase orders, GRNs and procurement invoices. Only `CREATE TABLE/INDEX IF NOT EXISTS`; no ABMDAS table is altered. Setting `procurement.phase2.v1` marks the phase. |
| Numbering | Asset codes use `AST-<UNIT>-<YYYY>-<000001>` with six-digit padding, generated through the existing `sequences` table. The barcode value is the asset code. |
| RBAC | New permissions `asset.view`, `asset.manage`, `asset.allocate`, `asset.maintain`, `asset.verify`, `asset.dispose` and `asset.approve`; granted additively to the relevant existing roles. `super_admin` retains full access and existing grants are unchanged. |
| Asset API | `/api/procurement/assets` with `/meta`, list and KPI summary, create, detail, update and soft retire; custody actions `allocate`, `return`, `transfer`; `maintenance` create/update; `verify`; disposal `request`, `approve` and `reject`; and label endpoints `GET /:id/label` and `POST /labels/bulk`. Unit access and role permissions are enforced on every route and all actions are audited. |
| Lifecycle rules | Statuses `ordered → received → created → allocated → in_use → under_maintenance → under_repair → transferred → missing → disposed`. Allocation preserves append-only custody history; transfer closes the previous allocation and opens a new one when a custodian changes. Preventive maintenance moves the asset under maintenance, corrective maintenance moves it under repair, and completion or cancellation returns it to its allocation or the register. Verification records location accuracy and condition, flags missing assets and restores them when found. Disposal is a two-step request and approval: approval marks the asset disposed and closes any active allocation; rejection leaves the asset active. |
| Automatic creation | Posting a GRN creates one asset per accepted whole unit for items of type `asset`, linked to the PO, GRN, store, bin, vendor and department. Validating the linked procurement invoice ensures the same assets exist (idempotent) and links `assets.invoice_id`. Asset items do not post stock. |
| Labels | Each asset receives a QR payload pointing to the application asset URL (`public_base_url` with a request-host fallback) and a Code128 barcode of the asset code. Labels can be printed singly or in bulk (up to 200) from a dedicated print view. `JsBarcode` is vendored under `public/vendor/`; QR rendering uses the existing vendored QR library. |
| UI | Procurement → Assets (KPI list with status, unit, category and custodian filters; register/edit form; detail view with custody, transfer, maintenance, verification, disposal and label histories; allocate, return, transfer, maintenance, verification and disposal modals; QR display and label printing). Added additively to `public/js/app.js` with no changes to existing ABMDAS pages. |
| Login | Unchanged: same `admin` credentials, `/api/auth/login`, session cookie and `/api/auth/me`. |
| Verification | New Phase 2 suite 124/124 on a fresh isolated database (manual register and validation rules, soft retire, allocation/return/transfer custody history, maintenance and verification transitions, disposal approval and rejection, single/bulk labels, GRN auto-creation and invoice linking, idempotency, role permissions and unit scoping). Regressions green: Phase 1b 79/79, Phase 1a 65/65, Phase 0b 62/62, Phase 0a 30/30. Phase 2 schema and permissions applied to the main and deployment databases; main data verified unchanged. Browser smoke test on an isolated DB created and edited assets, allocated/returned/transferred custody, scheduled/completed maintenance, verified and flagged missing assets, requested/approved disposal, rendered the Code128 + QR label (65 barcode bars) and printed labels with no console errors. |

### Phase 5a â€” item master v2, core fields and vendor mapping (delivered)

| Item | Detail |
|---|---|
| Additive schema | `server/procurement/schema.js` creates `item_details` (brand, model, manufacturer, HSN, GST rate, MOQ, reorder quantity, lead time, pack size and description, safety stock, last purchase cost), `item_vendors` (multiple vendors per item, vendor item code, unit cost, lead time, one preferred vendor) and `item_attachments` (product image and datasheet). The `items` table itself is unchanged. Setting `procurement.phase5a.v1` marks the phase. |
| API | `GET/POST/PUT /api/procurement/items` accept optional `details` and `vendors`; omitting them leaves existing values unchanged, so the old payload still works. Item detail returns `details`, `vendors` and `attachments`. `POST` and `DELETE /api/procurement/items/:id/attachments` upload and soft-remove files. `/api/procurement/meta` returns non-blacklisted vendors for the vendor picker. |
| Validation | HSN 2 to 8 digits; GST rate 0 to 100; whole lead-time days up to 3650; pack size above zero; at most one preferred vendor; no duplicate vendor; blacklisted or unknown vendors rejected; images JPEG, PNG or WebP and datasheets PDF only, max 5 MB, with a magic-byte content check. |
| Files | Served through `/api/files/item-attachment/:id` under `item.view`; removed files return 404 but stay in the audit trail. |
| UI | Item form adds Identification, Procurement and Packaging, Vendors (add and remove rows, preferred radio) and Product Image and Datasheet cards. Attachments can be added after the item is saved. |
| Verification | Phase 5a suite 47/47 on a fresh isolated database. Regressions green on fresh databases: Phase 1b 90/90, Phase 2 125/125. |


### Phase 5b - asset register extensions (delivered)

| Item | Detail |
|---|---|
| Additive schema | `assets` gains insurance, AMC and service-history support through `CREATE TABLE IF NOT EXISTS` companion tables and gated `ALTER TABLE` migrations. Existing asset rows are untouched. |
| API | Asset endpoints accept the extended payload; older payloads keep working because unknown keys are ignored and missing keys leave stored values unchanged. |

### Phase 5c to 5f - item master enrichment, alerts, tax defaults and insurance (delivered)

| Item | Detail |
|---|---|
| Item detail columns | `color`, `capacity`, `power_rating`, `configuration_details`, `make`, `expiry_tracking`, `shelf_life_days`, `amc_vendor_id`, `amc_start_date`, `amc_end_date`, `insurance_required`, `compliance_cert_required`, `default_store_id`, `storage_conditions`, `rack_number`, `bin_location`, `approval_required`, `approval_matrix_id` (added by gated `ALTER TABLE` migrations on `item_details`). |
| UOM conversions | New `item_uom_conversions` table plus `GET/POST /api/procurement/items/:id/uom-conversions` and `DELETE /api/procurement/items/:id/uom-conversions/:convId`. |
| Alert engine | `server/procurement/alerts.js` produces warranty, AMC, stock, expiry and reorder alerts. `POST /api/procurement/alerts/run` and `GET /api/procurement/alerts`; alerts also run non-blocking on login. De-duplicated by user, title and link within 24 hours. New Alerts page and sidebar entry. |
| Tax defaults | PO lines default `taxRate` from `item_details.gst_rate` when the user has not typed a rate. |
| Compliance files | Compliance certificates stored as `item_attachments` with kind `compliance` (PDF only, magic-byte checked), listed in the item form. |
| Asset insurance | `assets` gains `insurance_policy_no`, `insurer`, `insurance_premium`, `insurance_expiry_date`, `insurance_remarks`, edited on the asset form. |
| UI | Item form shows Technical Specifications, AMC and Compliance, and Consumable Settings cards based on item type; assets show insurance fields; asset classes store depreciation defaults. |

### Purchase order print / PDF (delivered)

| Item | Detail |
|---|---|
| Route | `#/purchase-orders/:id/print` dispatches to `renderPrint` in `public/js/pages/purchase-orders.js`. |
| Content | Vendor-facing layout based on the NLAGC reference PDF: `ORIGINAL`, `Doc No` / `Doc Date`, organisation logo and letterhead (address, phone, email, website, GST/PAN/GST state), `To` vendor block with a larger bold vendor name, two-line address (street then city/state/PIN), GST/PAN and no internal GST-state line, item table with reference GST rate and amount columns, amount in words, exact NLAGC terms beside totals, Payment and Delivery Terms below the Terms and Conditions, and shipping at the bottom. Same-state vendors (matched by GSTIN state code, then state name) show SGST/CGST only; inter-state vendors show IGST. PO line `item_name` is persisted separately from the item master so a custom name is not replaced when saving or revising; `item_name` is backfilled from the line description by `migration.po_item_name.v1`. |
| Items | The Order Items column headings (`S No`, `Product Name`, `Qty`, `Units`, `UnitPrice`, `Disc`, `Value`, GST columns) are centre-aligned. Product names are bold at 10.5 px and larger than the 9 px detail lines below them. Model and Make are combined on one line (for example, `Model: TIMG-36G · Make: Tycoon`) below the description. The `Disc` column prints only when a discount exists, an item-wise `Total Amount` column shows each line's post-discount/post-tax value, the header Discount total prints only when non-zero, and `Total No. of Items` appears immediately above the Amount in Words line. |
| Zero suppression | Zero-valued total rows and all-zero GST rate/amount columns are omitted entirely — label and value cell — so only non-zero values print. |
| Vendor-only | Internal details are excluded: department, vendor code, prepared/approved/issued by, revision/GRN data, notes, additional contacts and acknowledgement blocks are not printed. Only the `For New Life Assembly of God Community` / `Authorized Signatory` signatory block appears. |
| Bottom details | Payment Terms and Delivery Terms print directly below the Terms and Conditions clauses; the shipping address (with GST/contact/delivery date) prints at the bottom above the signatory. |
| Page number | PO print uses a document-level zero page margin (plus a named-page fallback) so Chrome's date/time and localhost URL headers/footers are suppressed; only a custom page number prints. Print-only spacing is tightened so a typical PO stays on one A4 page. The vendor-facing PO has no QR code. |
| Settings | Additive keys `org.phone`, `org.email`, `org.website`, `org.gstin`, `org.pan` and `org.gst_state` are editable in Settings and exposed through `/api/meta/bootstrap` for the PO letterhead. |
| Actions | Print and Save as PDF use the browser print dialog (`window.print`). Creating a PO or issuing a PO navigates to the print view with `?autoprint=1`, so the dialog opens automatically for office filing or sending to the vendor. |
| API (additive) | `GET /api/procurement/purchase-orders/:id` also returns `vendorContactPerson`, `vendorMobile`, `vendorEmail`, `vendorGstin`, `vendorPan`, `vendorAddress1`, `vendorAddress2`, `vendorCity`, `vendorState`, `vendorPincode` and `vendorCategory`. Existing fields are unchanged. |
| Styles | Reuses the existing `.print-report` / `@media print` rules in `public/css/app.css`; `no-print` hides navigation and buttons on paper and in the saved PDF. |

### Purchase order numbering and department codes (delivered)

| Item | Detail |
|---|---|
| Format | New POs are numbered `PO/<unit code>/<department code>/<FY>/<NNNN>`, for example `PO/NLAGC/MEDIA/26-27/0057`. |
| Financial year | Indian FY derived from the PO date: April–March becomes `26-27`, `27-28`, and so on. |
| Sequence | The four-digit sequence is scoped per unit, department and FY. New series are seeded at `56` so the first generated PO number is `0057`; an existing sequence below `56` is floored repeat-safely, while sequences already at or above `56` continue unchanged. Legacy PO numbers are not renumbered. |
| Department codes | Additive migration `migration.department_codes.v1` adds `departments.code`, backfills all existing departments with stable short codes and creates a unique partial index. Codes are editable from Settings → Departments, and new departments accept an optional code (auto-generated from the name when omitted). |
| API (additive) | `/api/meta/bootstrap` and procurement meta lists now include department `code`. `POST /api/meta/departments` accepts `code`; `PUT /api/meta/departments/:id` updates name, code and active status. No new permissions were introduced. |

### Runtime reliability (delivered)

| Item | Detail |
|---|---|
| Database location | `ABMDAS_DATA_DIR` points at `C:\abmdas-data` so SQLite WAL files are not synced by OneDrive, which caused intermittent "Cannot reach the server" errors. `server/index.js` prints the resolved database path at startup. |
| Health check | `GET /api/health` (public) reports `ok`, uptime and timestamp. |
| Supervisor | `C:\abmdas-data\abmdas-supervisor.ps1` probes the health endpoint every 20 seconds and restarts the server when it is down; started at logon from `C:\abmdas-data\abmdas-supervisor.vbs` (shortcut in the Startup folder). Log: `C:\abmdas-data\watchdog.log`. |
| Crash guards | `uncaughtException` and `unhandledRejection` handlers log instead of exiting the process. |
| Client retries | `public/js/api.js` retries failed fetches three times with a short backoff before showing the connection error. |
| Session timeout | Idle sessions expire after 30 minutes. Every authenticated request slides both the server-side expiry and the session cookie; `public/js/session.js` logs the UI out automatically on inactivity and syncs logout across tabs. Login and `/api/auth/me` return `sessionTimeoutMs` so the client uses the server value. |
| Fresh assets | `public/sw.js` is network-first with a cache fallback (`abmdas-shell-v47`), so UI changes appear immediately instead of being served from an old cache. |

### Online deployment - Vercel PWA + separate API (delivered)

| Item | Detail |
|---|---|
| Topology | Vercel hosts only `public/` as the installable PWA at `https://abmdas.vercel.app`. `vercel.json` declares `outputDirectory: "public"` and rewrites `/api/:path*` to `https://nlcc-projects.taild9d340.ts.net`. The full Node server, SQLite database, sessions and uploads stay on the local persistent disk at `C:\abmdas-data`; Vercel's ephemeral filesystem never holds application data. |
| Backend exposure | Tailscale Funnel provides the free, stable public backend hostname and proxies port 443 to `127.0.0.1:3000`. The local supervisor keeps the Node API alive. No card or paid cloud disk is required. |
| Same-origin behind proxy | `server/index.js` accepts a browser `Origin` when it matches an explicit `ABMDAS_ALLOWED_ORIGINS` entry (`https://abmdas.vercel.app`, `https://nlcc-projects.taild9d340.ts.net`) or any host in the `X-Forwarded-Host` chain. This prevents Vercel/Tailscale proxied POST/PUT/DELETE requests from being falsely rejected while preserving local/offline behaviour. |
| Configuration | The Vercel rewrite keeps the `/api/...` path intact, so existing endpoints, cookies, raw PDF/image responses and the 30-minute idle session flow are unchanged. Static responses carry the same CSP and security headers as the Node server. |
| Data migration | No migration was needed: the existing live `C:\abmdas-data\abmdas.db` and `uploads/` are already the backend's persistent store. The old `C:\abmdas` folder remains a verified manual copy for LAN/office use. |
| Guide | Final URLs, supervisor environment, verification results and troubleshooting live in `docs/VERCEL_DEPLOYMENT.md`. |

### Phase 5g - free-text requisition lines and suggested vendors (delivered)

| Item | Detail |
|---|---|
| Additive schema | Gated migration `migration.requisition_item_name.v1` adds `requisition_items.item_name TEXT`; `migration.requisition_suggested_vendor.v1` adds `requisitions.suggested_vendor_name`, `suggested_vendor_contact`, `suggested_vendor_mobile`, `suggested_vendor_email`, `suggested_vendor_address` and `suggested_vendor_notes`. Both use `ALTER TABLE` only when the column is absent; the fresh-database `CREATE TABLE` statements include the same columns. No existing column, row or ABMDAS table is changed. |
| Free-text lines | A requisition line may now carry either a master `item_id` or a typed `item_name` (trimmed, capped at 200 characters). `POST/PUT /api/procurement/requisitions` accept `itemId: ""` with `itemName`; a line with neither is rejected with "select an item or type an item name". Typed lines default unit cost to 0, keep the optional UOM and description, and flow through totals, approval routing and the audit trail normally. |
| API output | `GET /api/procurement/requisitions/:id` returns `itemName` (master name or typed name), `itemCode` (empty for typed lines) and `inItemMaster` for every line. Existing fields are unchanged and master-backed lines behave exactly as before. |
| Suggested vendor | The requester may optionally record one suggested vendor on the requisition (name, contact person, mobile, email, address, notes). The vendor may be picked from the already registered vendors via a dropdown (details are pulled from the vendor master and stored as a snapshot) or, if not listed, entered as free text with contact details prompted. Details are validated server-side: any contact detail requires a vendor name, and email format is checked. The suggestion is informational only: it does not create a vendor record and does not bypass sourcing. `GET /api/procurement/rfqs` creation from a requisition surfaces the suggestion to Procurement. |
| Stock verification | Typed lines are not in the item master, so they are never written to `stock_issue_items` or `stock_ledger`. If every line is free text, the "stock available" verification is refused with guidance to choose "Stock unavailable" and move the requisition to sourcing. For mixed requests, master-backed lines are issued normally and the excluded typed lines are noted in the issue remarks. |
| Sourcing | RFQ lines now accept a typed name as well as a master item. Copying a requisition into an RFQ preserves the typed name (composed with any description) and the RFQ line keeps `item_id` empty. Quotation and PO tables already allow empty `item_id`, so sourcing continues to work; Procurement can create a master item before issuing a PO if it wants stock and asset tracking. |
| UI | Requisition form: the item picker gains "Other - item not in the list (type the name)" which reveals a name input in the same row; Qty and Unit Cost columns were widened (120 px and 160 px, right-aligned inputs) and the table has comfortable minimum widths. The form now uses a single-column, top-to-bottom scrolling layout: Requirement, Items, Suggested Vendor, Approval Route, Submission. The Suggested Vendor card now offers a dropdown of registered vendors (auto-filling contact details) plus "Other - not listed (type the name)" for free-text entry. Requisition detail labels typed lines "Not in item master" and shows the suggested vendor card when present. Sourcing form received the same "Other" line entry and shows the requester's suggested vendor after a requisition is selected. |
| Verification | API tests: free-text create, edit, totals and validation; suggested vendor round-trip and name-required validation; requisition -> approval -> RFQ copy with a typed line; manual RFQ with a typed line. Browser test: the name input appears for "Other", Qty/Unit Cost render at 120/160 px with right-aligned inputs, draft saved from the UI with a typed line and suggested vendor, and the detail page showed "Not in item master" plus the vendor card with no console errors. |

### PO form overhaul (delivered)
- Direct PO form now supports creating a new vendor (quick add) and a new item (quick add with category/UOM) inline.
- Line items capture: Item, Item Name, Description, Model No, Make, UOM, Qty, Rate, Discount %, Discount Amount, Tax %, Tax Amount, Total.
- Charges card captures Freight, Loading/Unloading and Other charges; totals include discount and charges.
- Backend: additive columns on po_items (model_no, make, discount_percent, discount_amount) and purchase_orders (freight_charges, loading_charges, other_charges); recalc includes discount and charges; print footer updated.

### Administrative Pastor routing (delivered)
- Bill entry no longer carries a routing checkbox. Routing is decided later, at the point of Administrator approval.
- Bill detail: when the active stage is Administrator Approval, the approval card offers "Forward to Administrative Pastor". Ticking it and approving inserts an Administrative Pastor Approval stage immediately after the Administrator, even when the amount is below the Pastor's normal approval range. Other stages cannot use this option (server rejects it with a clear message).
- Approval Inbox: bills at the Administrator stage gain a "To Pastor" button that approves the Administrator's stage and forwards to the Pastor in one step.
- Expense categories: `categories.requires_admin_pastor` (additive, default 0) can be enabled when creating a category or sub-category in Settings, and toggled later with the "Admin Pastor" checkbox on each category. When a bill is submitted under such a category, the Pastor Stage is appended to the approval chain regardless of amount.
- API: `POST /api/meta/categories` and `PUT /api/meta/categories/:id` accept `requiresAdminPastor`; `/api/meta/bootstrap` returns `requires_admin_pastor`. `POST /api/bills/:id/action` accepts `forwardToAdminPastor` on an approve action.
- Audit: submissions record `categoryRequiresPastor` and the resulting chain; forwarding writes a dedicated `FORWARD` audit entry plus `forwardedToAdminPastor` on the approve entry.
- Verification: a category-flagged bill for Rs 1,000 (below the Pastor range) was submitted and received `Departmental -> Administrative Assistant -> Administrator -> Administrative Pastor`; a normal low-value bill was advanced to the Administrator stage, forwarded with the new option, and moved to a pending Administrative Pastor stage; forwarding from a non-Administrator stage was rejected.

### Inline master creation with full details (delivered)
- Every master-data dropdown on entry, edit and modal screens now has a compact "+" action beside it. It opens one shared modal containing the complete field set for that master instead of asking for a name only. The saved record is audited and selected in the form without losing values already typed.
- Covered masters: vendors, expense categories, item categories, UOMs, items, departments, units, cost centres, employees, stores, bins, rooms, branches, campuses, buildings, floors, roles and users.
- New additive endpoints: `POST /api/procurement/item-categories` (name, optional code, itemType, parentId; code generated when blank) and `POST /api/procurement/uoms` (code, name). Both require `item.manage` and write an audit entry. `server/util.js` now exports `nextSequence`.
- Shared helper `public/js/quick-add.js` installs a MutationObserver, attaches only to recognised master selects, skips existing `data-add-*` controls and enum selects (`status`, `type`, `mode`, `priority`, etc.), and uses the same permission strings as the server. Escape, backdrop click and Cancel all resolve cleanly.
- Bootstrap-backed masters update in-memory state immediately; page-local arrays such as PO items and UOMs update through an `onCreated` callback before the change event fires. The PO "New item" action now captures name, type, category, UOM, specification and standard cost, then populates the line's name, description, price and UOM.
- Server guards were aligned with the screens that need them: vendor creation now also accepts `po.manage`, `requisition.create`, `sourcing.manage` and `advance.create`; expense-category creation also accepts `invoice.manage`. Existing permissions are unchanged.
- Asset Classes now has a permission-gated "New asset class" action. It opens the full item-category modal with Item type fixed to `Asset`, creates the class, and opens its defaults form so depreciation, warranty, AMC, serial and asset-tag rules can be entered immediately. The same class can still be created as an asset-type category under Items.
- Full-detail master dialogs use an extra-wide layout with larger headings, labels, inputs, selects and buttons, and scroll inside the modal so every field is readable and editable. Base form inputs across the app were also enlarged from 38px to 42px minimum height with 14px text; toolbar controls keep their compact height. - Purchase Order item entry was rebuilt from a cramped 14-column table into full-width line cards with an even 4-column field grid, large inputs, a description textarea, live item-name label and per-line tax/total in the card header. The same cards are used on PO edit and revision screens. Service worker cache bumped to `abmdas-shell-v21`.

### Parent-child assets with maintained component counts (delivered)
- Additive schema: `item_components` stores component templates on asset-type items; `asset_components` stores the instantiated components on each asset. Both keep a positive `quantity` per row, notes and an `active` flag. Removed rows are deactivated rather than deleted, so history is preserved. Migration key `migration.asset_components.v1` makes startup repeat-safe.
- Item master: the item form has an Asset Components & Accessories card for asset items. Add/remove rows, pick any active asset or consumable item, enter the included quantity and notes, then save. The same data is returned on `GET /api/procurement/items/:id` as `components`.
- Asset register: the asset form has the same component card with an extra serial/identifier field. Selecting an asset item loads its component template; users can edit quantities or add/remove rows before registering. `GET /api/procurement/assets/:id` returns `components`, and the detail page shows each component with its own count.
- Automatic propagation: registering an asset without an explicit `components` payload copies the linked item template. Posting a GRN copies the template to every newly created asset for that item. Explicit component payloads from the API/UI are saved as supplied; the item template is left unchanged.
- Validation and audit: duplicate component items, self-references, service items, missing items and non-positive quantities are rejected. Item and asset create/update audit entries include `componentCount` and `componentQuantity`; GRN asset creation records the copied components. Existing permissions are reused: `item.manage` for templates and `asset.manage` for asset components.
- UI: component rows use full-width cards with large selects/inputs and a remove action. Service worker cache bumped to `abmdas-shell-v22`.

### Form Cancel navigation fix (delivered)
- The router now serialises renders and skips queued renders whose hash is no longer current. Previously, a slow page render could finish after a newer navigation and repaint the stale page, making Cancel appear not to return.
- All direct `render()` calls from boot and login now go through the same queue. Verified Cancel on Bills, Vendors, Requisitions, Sourcing, Purchase Orders, Procurement Invoices, Assets and Items forms returns to the correct list even when the next navigation happens immediately.
- Service worker cache bumped to `abmdas-shell-v23`.

### Tax, round-off, delivery addresses and general terms (delivered)

| Item | Detail |
|---|---|
| Tax model | One tax rate per line. Line and flat discounts are additive and capped at the gross line value; inclusive tax derives `taxable = discounted / (1 + rate / 100)`. Header discount is applied after tax, then charges are added. `discount_amount` remains the applied total; `flat_discount_amount` stores the raw flat portion on PO lines, PO headers and GRNs, and is preferred by all recalculations and forms so repeated saves or revisions cannot add the percentage twice. Verified end to end: quotation `955.30` → round-off `-0.30`, total `955`; PO `965.30` → `-0.30`, `965`; invoice `950.60` → `+0.40`, `951`; bill `1101.50` → `+0.50`, `1102`. |
| Round-off | Nearest rupee, half-up, after all discounts, taxes and charges. `calculateRoundOff(n, override)` in `server/util.js` returns `baseTotalAmount`, `roundOff`, the final total and a `manual` flag. The final rounded value is persisted in `total_amount`/`net_amount`; `round_off`, `baseTotalAmount` and `manualRoundOff` (where applicable) are returned by the APIs and audit summaries. The round-off field is auto-filled in every amount-bearing form but is editable: a submitted value is the adjustment, so final total = `baseTotalAmount + roundOff`. A blank value or `Auto` resets to the calculated half-up value; a non-numeric value is rejected with `Round off must be a number.` |
| Additive schema | Migration `migration.delivery_roundoff_terms.v1` adds: unit address fields; store address and in-charge fields; `round_off` on requisitions, quotations, POs, GRNs, invoices and bills; `general_terms` on RFQs, quotations and POs; and PO billing/shipping/contact snapshot fields. Existing rows and permissions are unchanged. Repeat-safe and verified against the live database (`PRAGMA integrity_check = ok`). |
| Legacy PO totals | Repeat-safe, audited migration `migration.po_totals_repair.v1` recalculates existing PO headers from their stored lines, header discount and charges using the shared tax/round-off rules. Only changed rows are written and each is recorded as a `SYSTEM_RECALC` audit entry. `PO/2026/0001` was corrected from `0.08` to `20,501.00`. |
| General terms | Setting `procurement.general_terms` is seeded with the three exact NLAGC clauses, editable under Settings → General Terms, and pre-filled into RFQ, quotation and PO forms. Documents keep their own snapshot once created. |
| Addresses & contacts | Units and stores capture address/contact details in Settings and Stores. POs snapshot billing source/unit/address, shipping source/location/address, delivery contact and additional contacts; shipping defaults to billing and the delivery contact defaults to the selected store's in-charge. All canonical fields are returned by `GET /api/procurement/purchase-orders/:id`. |
| PO print | `#/purchase-orders/:id/print` is vendor-facing: reference-style letterhead with logo, vendor block, centred item headings with line-discount column, amount in words, terms/totals, Payment/Delivery Terms under Terms and Conditions, shipping at the bottom and only the `For New Life Assembly of God Community` / `Authorized Signatory` signatory block, with an enlarged blank band above the Authorized Signatory line for a handwritten signature. Zero-value rows and zero-only GST columns are suppressed, browser date/URL headers and footers are replaced by a single page number, and totals come from the repaired PO headers. |
| UI | One-column top-to-bottom forms with sticky action bars; permission-gated quick-add opens full-detail forms. Every amount-bearing form (requisition, quotation, PO create/edit/revise, GRN, invoice and bill) now has an editable `Round off` number input with an `Auto` reset button; the displayed final total recalculates from `baseTotalAmount + roundOff`. Detail views continue to show `baseTotalAmount`, `roundOff` and the final rounded total. Service worker cache bumped to `abmdas-shell-v47`. |
| Verification | `delivery-schema-qa.js` (schema/integrity), `tax-api-qa.js` (tax/discount/round-off and audits), `delivery-api-qa.js` (addresses/contacts/terms), `round-off-unit-qa.js` (auto/manual/zero/string/AUTO cases) and `round-off-api-qa.js` (manual overrides persisted across requisition, quotation, PO, GRN, invoice and bill, blank reset to auto, and `manualRoundOff` audit entries) all pass. Browser QA on the isolated round-off server confirmed editable round-off, manual persistence after line recalculation and `Auto` reset in requisition, quotation, PO create/edit/revise, GRN create/edit, invoice and bill forms, with no new console errors. Browser QA also covered Settings, Stores, Units, sourcing, PO detail and PO print; latest QA confirmed logo placement, centred headings, bold product name, discount column, corrected `20,501.00` total, zero suppression, two-line vendor address, larger bold vendor name, no vendor GST state line, Payment/Delivery Terms under Terms and Conditions, shipping at the bottom, no QR code, page number instead of browser headers/footers, and vendor-only signatory. Live smoke test on port `3000` logged in, cleared Cache Storage, loaded `abmdas-shell-v47` and verified the requisition form's auto round-off (`₹1,003.00` for base `₹1,002.50`). |

### Discount repeat-save safeguard (delivered)
- The original `PO/NLAGC/MUSIC/26-27/0058` error happened because the stored *applied* discount was read back as the editable *flat* discount. Saving or revising therefore added the percentage portion again.
- `flat_discount_amount` is now stored explicitly on `po_items`, `purchase_orders` and `grns`. The create/edit/revise forms send it alongside `discountAmount`; `tax.parseLine()`, `tax.parseHeaderDiscount()` and `tax.calculateDocument()` prefer it; `recalcPo()` no longer feeds `discount_amount` back into the calculation.
- Migration `migration.po_flat_discount.v1` adds the columns, backfills them from existing applied totals minus the percentage portion, and records a `SYSTEM_MIGRATION` audit entry only for changed rows. It is additive, repeat-safe and does not touch demo item codes or permissions.
- `scripts/qa/po-discount-no-double.js` is the regression gate: it creates a draft PO, saves it twice and revises it with client-shaped payloads that include `flatDiscountAmount: 0`, then asserts the discount, taxable value, tax and total are unchanged.
- The PO print signature band was enlarged from a 20px to a 56px clear area while keeping the single-A4-page, no-browser-header/footer layout.
- PO 0058 item-name alignment: line 13 was linked to item `ITM-00024` (`Media Tray Stand`) instead of `ITM-00021` (`Groove Bell`). The link was corrected, and item masters `ITM-00021`/`ITM-00023`/`ITM-00024` were renamed to the exact purchased variants already shown on the PO. The repeat-safe, audited repair (`SYSTEM_REPAIR`) now reports zero mismatches between PO line names and master names.

### Fleet Desk module (delivered)
- Fleet Desk is a native ABMDAS module, not a second application: it reuses the existing login, session timeout, roles, audit log and API host. No new credentials or database are introduced.
- Additive schema in `server/fleet/schema.js` creates only `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` statements for `fleet_areas`, `fleet_vehicles`, `fleet_trips` and the additive `employee_driver_profiles` qualification. Departments, employees and users are the existing common ABMDAS masters — Fleet no longer owns copies. Masters start empty; no demo records are seeded. Restarting the server is repeat-safe. Legacy empty tables from the first draft are left physically in place but are unused.
- New permissions `fleet.view`, `fleet.booking.create`, `fleet.booking.manage` and `fleet.master.manage` are added without changing any existing grant. Administrators receive incharge access; staff can view and raise requests. Existing role assignments are untouched.
- API lives under `/api/fleet`: `meta`, `bookings`, `bookings/:id/availability` and booking actions (`assign`, `reject`, `odometer`), plus CRUD for the two Fleet-only masters (areas and vehicles). Booking numbers use a new `fleet_booking` sequence (`FD-0001` onward).
- Server-side availability checks recheck both vehicle and driver conflicts for overlapping `ASSIGNED` trips, and assignment verifies the vehicle is active, has enough seats and that both resources are free. Non-incharge users see only their own requests.
- The sidebar has its own **Fleet Desk** group with Vehicle Bookings and Fleet Masters. The booking form captures department, pickup/drop, trip window, passenger count and purpose; the detail page shows a Google Maps route link, free-resource assignment, rejection with remarks and completion.
- Drivers are active employees with a driving qualification set on the shared Employee form; only those employees appear in assignment. Fleet areas can link to a common address and vehicles can link to a common fixed asset.
- Service worker cache bumped to `abmdas-shell-v49`.

### Fleet roles and approval workflow (delivered)
- Dedicated system roles `transport_head` and `maintenance_team` are seeded repeat-safely. The live Transport incharge (`arun`, employee `70443`) is moved to `transport_head` once by marker `migration.fleet_transport_head.v1` with an audited `SYSTEM_REPAIR` entry; other `department_head` users remain view/create-only.
- New permissions `fleet.senior.approve` and `fleet.maintenance.manage` are added additively. `senior_management` receives senior approval; Transport Head receives full fleet management but not senior approval (marker `migration.fleet_senior_approval_segregation.v1` revokes the early grant); administrators keep all permissions through `super_admin`; Maintenance Team receives issue/maintenance handling with read-only fleet access.
- Booking requests now store employee ID and mobile from the logged-in user, travel category, journey date, start time, return-required flag, expected return date/time, priority and special remarks. VIP Movement and Emergency requests, or any declared long-distance/outstation, cost-limit or custom reason, route to Senior Management before Transport allotment.
- Transport can explicitly approve, reject, hold for clarification or forward to Senior Management. Senior Management can approve, reject or return for clarification. Held requests can be resubmitted by the requester; senior returns go back to senior review, while Transport holds go back to Transport for allotment. The status CHECK is rebuilt once (`migration.fleet_trip_approvals.v1`) to add `HOLD` and `SENIOR_APPROVAL` without dropping or rewriting user data.
- Allocation notifications now include the requester, reporting time, passenger count and special instructions; rejections notify the requester with the recorded reason.

### Fleet trip operations (delivered)
- The trip status CHECK is rebuilt once by marker `migration.fleet_trip_operations.v1` to add `STARTED` and `PENDING_VERIFICATION` without changing any existing row. The DB status stays `PENDING` for Forwarded bookings; the UI derives `Forwarded` from `forwarded_at` as before.
- A six-item pre-start checklist is mandatory. `POST /api/fleet/trips/:id/start` refuses to start until every item is selected and a fuel level, vehicle condition and starting km are recorded. GPS and a driver selfie are optional; selfies upload through `POST /api/fleet/photos` (5 MB, JPEG/PNG/WebP, magic-byte checked) and are served by `/api/files/fleet-selfie/:id`.
- During a trip, the allotted driver or Transport can post progress, prayer-pickup, fuel, halt and arrival updates with an optional location, GPS and passengers. Prayer-pickup updates add to a trip counter shown on the detail page, dashboard and reports.
- Driver closure sets `PENDING_VERIFICATION` and updates the vehicle odometer; Transport can verify to `COMPLETED` or return the closure with a reason to reopen `STARTED`. Notifications go to the requester, driver and Transport on each step.
- Vehicle issues and accidents are separate fleet registers. Any Fleet viewer can report them; Maintenance/Transport progress and resolve issues, while Transport or Senior Management review and close accidents. Both are notifiable, audited, filterable and exportable.
- Fleet Reports add attendance, issue, accident and audit registers with CSV download. Fleet Operations adds a Live trips tab. The Fleet Dashboard shows active trips, open issues, accidents under review and prayer-pickup counts alongside attendance and extra hours.
- Attendance now stores shift status, GPS coordinates and an optional selfie in addition to check-in/check-out, worked hours and extra hours over the standard 9-hour day. Manager entries are `APPROVED`; driver self-entries remain `PENDING` until Transport approves.
- Legacy direct `complete` booking action was removed so every completed trip must pass through driver closure and Transport verification. Service worker cache bumped to `abmdas-shell-v65`.

### PO reference photos (delivered)
- Additive table `po_reference_photos` stores optional vendor-facing photographs with soft delete, audit entries and a file under `C:\abmdas-data\uploads\po-reference-photos`. Uploads are limited to six per PO, 5 MB each, JPEG/PNG/WebP with magic-byte validation; no new permission is used (`po.manage` to attach/remove, `po.view` to read).
- PO detail has a Reference Photos card for upload from the device (with an optional caption) and removal. `GET /api/procurement/purchase-orders/:id` returns `photos` for both the detail and print screens.
- The vendor-facing PO print includes a **Reference Photos** section **only when at least one photo is attached**; a PO without photos prints exactly as before. Photos now print in a single vertical column, with an "Include reference photos" toggle and a confirmation prompt before each print so the user can choose whether photos are required for that print. The section remains `break-inside: avoid` and preserves the no-QR, no-browser-header/footer, single-A4-page, SGST/CGST/IGST and round-off safeguards. Service worker cache bumped to `abmdas-shell-v66`.

### Common masters across core, Procurement and Fleet Desk (delivered)
- **People & Organization** is now one sidebar group: Employees, Departments & Units, Users, Documents, Addresses & Maps, and Working Days & Holidays. These are shared by all three modules; no module keeps a second people or department master.
- Fleet Desk reads core `departments` and `employees` through `/api/fleet/meta`; the employee form sets an additive `employee_driver_profiles` record (licence number/expiry) instead of maintaining a separate driver master. A Driver is therefore just an employee with a qualification.
- `server/shared-masters.js` blocks deactivating or removing an employee or department that is still used by an open purchase order, an active fleet trip, or asset custody. No new permission is introduced.
- Renaming an item master now updates every linked PO line in the same audited transaction (`server/routes/procurement.js`), so PO and Item Master names can never drift apart again. The QA gate passes with zero mismatches.

### Phase 2 shared services (delivered)
- **Documents** — additive `common_documents` table and `/api/documents` + `/api/files/common-document/:id`. One upload/permission/audit path for employee, department, user, fleet vehicle and fleet booking attachments; JPEG/PNG/WebP/PDF only, 5 MB limit, magic-byte checked, soft deleted. A generic Documents page and a link from Fleet booking detail are provided.
- **Addresses & Maps** — additive `common_addresses` master with `/api/masters/addresses`. One label, postal address and lat/lng/maps URL per place; Fleet areas can link to it and auto-fill their map fields. Reusable by units, stores, vendors and PO shipping.
- **Shared lookups** — `/api/masters/lookups` returns only the groups the user may see (units, departments, employees, stores, UOMs, cost centres; tax rates when a rate master exists). Cost centres, UOMs and stores were already common — now they are exposed through one endpoint for all modules.
- **Working days / holidays** — additive `working_days` table and `/api/masters/working-days` with org permissions. A single shared calendar for trip planning, delivery dates and bill due dates.
- **Vehicles as assets** — `fleet_vehicles.asset_id` optionally links a vehicle to the common fixed-asset register, giving one custody, depreciation and disposal history.
- Service worker cache bumped to `abmdas-shell-v65`; all new schema statements are `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` plus guarded nullable-column additions on Fleet tables, including `fleet_vehicles.odometer_km`. No drops, renames or demo data.

