'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { hashPassword } = require('./auth');

const DATA_DIR = process.env.ABMDAS_DATA_DIR || path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'abmdas.db');

/* Default procurement general terms. Seeded once with INSERT OR IGNORE so an
   administrator's edits are never overwritten on restart. */
const DEFAULT_GENERAL_TERMS = [
  '1. Any items that are damaged during transportation or unloading and also when noticed during unboxing must be replaced at no cost to NLAGC',
  '2. Materials shall be dispatched with DC, Invoice, without those documents the materials will not be unloaded and the same will be returned.',
  '3. Any variations in size / Product No / quality / appearance / colour will not be acceptable and the same to be replaced without any additional cost and time.',
].join('\n');

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'uploads'), { recursive: true });

const db = new DatabaseSync(DB_FILE);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;
  PRAGMA wal_checkpoint(TRUNCATE);
`);

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sequences (
  key   TEXT PRIMARY KEY,
  value INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS roles (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  code        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  description TEXT,
  is_system   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS permissions (
  key    TEXT PRIMARY KEY,
  module TEXT NOT NULL,
  label  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS role_permissions (
  role_id        INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_key TEXT    NOT NULL REFERENCES permissions(key) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_key)
);

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id   TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  department    TEXT,
  designation   TEXT,
  mobile        TEXT,
  email         TEXT,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role_id       INTEGER NOT NULL REFERENCES roles(id),
  status        TEXT NOT NULL DEFAULT 'Active',
  signature_image TEXT,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until  TEXT,
  last_login_at TEXT,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ip         TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS departments (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  name   TEXT NOT NULL UNIQUE,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS categories (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  code      TEXT,
  name      TEXT NOT NULL,
  parent_id INTEGER REFERENCES categories(id) ON DELETE CASCADE,
  active    INTEGER NOT NULL DEFAULT 1,
  requires_admin_pastor INTEGER NOT NULL DEFAULT 0,
  UNIQUE(name, parent_id)
);

CREATE TABLE IF NOT EXISTS vendors (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  code           TEXT NOT NULL UNIQUE,
  name           TEXT NOT NULL,
  category       TEXT,
  contact_person TEXT,
  designation    TEXT,
  mobile         TEXT,
  email          TEXT,
  gst_number     TEXT,
  pan_number     TEXT,
  address_line1  TEXT,
  address_line2  TEXT,
  city           TEXT,
  state          TEXT,
  pincode        TEXT,
  bank_name      TEXT,
  account_number TEXT,
  ifsc_code      TEXT,
  account_holder TEXT,
  status         TEXT NOT NULL DEFAULT 'Active',
  created_by     INTEGER REFERENCES users(id),
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS vendor_documents (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  vendor_id   INTEGER NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  doc_type    TEXT NOT NULL,
  file_name   TEXT NOT NULL,
  stored_name TEXT NOT NULL,
  mime_type   TEXT,
  size        INTEGER NOT NULL DEFAULT 0,
  uploaded_by INTEGER REFERENCES users(id),
  uploaded_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS units (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  code          TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  active        INTEGER NOT NULL DEFAULT 1,
  address_line1 TEXT NOT NULL DEFAULT '',
  address_line2 TEXT NOT NULL DEFAULT '',
  city          TEXT NOT NULL DEFAULT '',
  state         TEXT NOT NULL DEFAULT '',
  pincode       TEXT NOT NULL DEFAULT '',
  phone         TEXT NOT NULL DEFAULT '',
  email         TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

/* Every user is a member of every active unit. The users.unit_id column is the
   user's home unit (the default when signing in). */
CREATE TABLE IF NOT EXISTS user_units (
  user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  unit_id  INTEGER NOT NULL REFERENCES units(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, unit_id)
);

CREATE TABLE IF NOT EXISTS bills (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  bill_no         TEXT NOT NULL UNIQUE,
  entry_date      TEXT NOT NULL,
  department_id   INTEGER REFERENCES departments(id),
  category_id     INTEGER REFERENCES categories(id),
  vendor_id       INTEGER NOT NULL REFERENCES vendors(id),
  invoice_number  TEXT NOT NULL,
  invoice_date    TEXT,
  invoice_amount  REAL NOT NULL DEFAULT 0,
  tax_amount      REAL NOT NULL DEFAULT 0,
  discount_percent REAL NOT NULL DEFAULT 0,
  discount_amount REAL NOT NULL DEFAULT 0,
  tax_inclusive   INTEGER NOT NULL DEFAULT 0,
  net_amount      REAL NOT NULL DEFAULT 0,
  round_off       REAL NOT NULL DEFAULT 0,
  gst_type        TEXT NOT NULL DEFAULT 'cgst_sgst',
  gst_rate        REAL NOT NULL DEFAULT 0,
  cgst_amount     REAL NOT NULL DEFAULT 0,
  sgst_amount     REAL NOT NULL DEFAULT 0,
  igst_amount     REAL NOT NULL DEFAULT 0,
  transport_type  TEXT NOT NULL DEFAULT 'none',
  transport_amount REAL NOT NULL DEFAULT 0,
  transport_gst_rate REAL NOT NULL DEFAULT 0,
  transport_tax_amount REAL NOT NULL DEFAULT 0,
  particulars     TEXT,
  description     TEXT,
  budget_head     TEXT,
  cost_center     TEXT,
  priority        TEXT NOT NULL DEFAULT 'Medium',
  status          TEXT NOT NULL DEFAULT 'draft',
  current_stage   INTEGER NOT NULL DEFAULT 0,
  advance_adjusted REAL NOT NULL DEFAULT 0,
  retention_percentage      REAL NOT NULL DEFAULT 0,
  retention_amount          REAL NOT NULL DEFAULT 0,
  retention_released_amount REAL NOT NULL DEFAULT 0,
  retention_release_date    TEXT,
  retention_release_remarks TEXT,
  hold_amount               REAL NOT NULL DEFAULT 0,
  hold_released_amount      REAL NOT NULL DEFAULT 0,
  hold_release_date         TEXT,
  hold_release_remarks      TEXT,
  credit_note_number        TEXT,
  credit_note_date          TEXT,
  credit_note_amount        REAL NOT NULL DEFAULT 0,
  credit_note_remarks       TEXT,
  created_by      INTEGER REFERENCES users(id),
  submitted_at    TEXT,
  approved_at     TEXT,
  closed_at       TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_bills_vendor_invoice
  ON bills(vendor_id, invoice_number COLLATE NOCASE)
  WHERE status <> 'cancelled';

CREATE INDEX IF NOT EXISTS idx_bills_status ON bills(status);
CREATE INDEX IF NOT EXISTS idx_bills_vendor ON bills(vendor_id);
CREATE INDEX IF NOT EXISTS idx_bills_created ON bills(created_at);

/* One invoice can carry several taxable components, each at its own GST rate
   (for example Rs.2,500 at 18% and Rs.500 at 5%). The bill keeps the
   aggregate totals for listings and reports; this table holds the breakdown. */
CREATE TABLE IF NOT EXISTS bill_tax_lines (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  bill_id         INTEGER NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  sequence        INTEGER NOT NULL DEFAULT 1,
  label           TEXT NOT NULL DEFAULT '',
  taxable_amount  REAL NOT NULL DEFAULT 0,
  tax_inclusive   INTEGER NOT NULL DEFAULT 0,
  gst_rate        REAL NOT NULL DEFAULT 0,
  cgst_amount     REAL NOT NULL DEFAULT 0,
  sgst_amount     REAL NOT NULL DEFAULT 0,
  igst_amount     REAL NOT NULL DEFAULT 0,
  tax_amount      REAL NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_bill_tax_lines_bill ON bill_tax_lines(bill_id);

CREATE TABLE IF NOT EXISTS bill_attachments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  bill_id     INTEGER NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  doc_type    TEXT NOT NULL,
  file_name   TEXT NOT NULL,
  stored_name TEXT NOT NULL,
  mime_type   TEXT,
  size        INTEGER NOT NULL DEFAULT 0,
  uploaded_by INTEGER REFERENCES users(id),
  uploaded_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS advances (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  advance_no      TEXT NOT NULL UNIQUE,
  vendor_id       INTEGER NOT NULL REFERENCES vendors(id),
  advance_date    TEXT NOT NULL,
  amount          REAL NOT NULL DEFAULT 0,
  adjusted_amount REAL NOT NULL DEFAULT 0,
  purpose         TEXT,
  department_id   INTEGER REFERENCES departments(id),
  remarks         TEXT,
  status          TEXT NOT NULL DEFAULT 'Open',
  created_by      INTEGER REFERENCES users(id),
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS advance_ledger (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  advance_id     INTEGER NOT NULL REFERENCES advances(id) ON DELETE CASCADE,
  txn_date       TEXT NOT NULL,
  txn_type       TEXT NOT NULL,
  debit          REAL NOT NULL DEFAULT 0,
  credit         REAL NOT NULL DEFAULT 0,
  balance        REAL NOT NULL DEFAULT 0,
  reference_type TEXT,
  reference_id   INTEGER,
  notes          TEXT,
  created_by     INTEGER REFERENCES users(id),
  created_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS bill_advances (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  bill_id    INTEGER NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  advance_id INTEGER NOT NULL REFERENCES advances(id),
  amount     REAL NOT NULL,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workflow_rules (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  min_amount  REAL NOT NULL DEFAULT 0,
  max_amount  REAL,
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workflow_stages (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_id        INTEGER NOT NULL REFERENCES workflow_rules(id) ON DELETE CASCADE,
  sequence       INTEGER NOT NULL,
  name           TEXT NOT NULL,
  role_id        INTEGER NOT NULL REFERENCES roles(id),
  user_id        INTEGER REFERENCES users(id),
  alt_user_id    INTEGER REFERENCES users(id),
  escalation_days INTEGER NOT NULL DEFAULT 3
);

CREATE TABLE IF NOT EXISTS bill_stages (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  bill_id        INTEGER NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  sequence       INTEGER NOT NULL,
  name           TEXT NOT NULL,
  role_id        INTEGER NOT NULL REFERENCES roles(id),
  user_id        INTEGER REFERENCES users(id),
  alt_user_id    INTEGER REFERENCES users(id),
  status         TEXT NOT NULL DEFAULT 'pending',
  acted_by       INTEGER REFERENCES users(id),
  acted_at       TEXT,
  comments       TEXT,
  signature_image TEXT,
  escalation_days INTEGER NOT NULL DEFAULT 3
);

CREATE INDEX IF NOT EXISTS idx_bill_stages_bill ON bill_stages(bill_id);

CREATE TABLE IF NOT EXISTS advance_stages (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  advance_id     INTEGER NOT NULL REFERENCES advances(id) ON DELETE CASCADE,
  sequence       INTEGER NOT NULL,
  name           TEXT NOT NULL,
  role_id        INTEGER NOT NULL REFERENCES roles(id),
  user_id        INTEGER REFERENCES users(id),
  alt_user_id    INTEGER REFERENCES users(id),
  status         TEXT NOT NULL DEFAULT 'pending',
  acted_by       INTEGER REFERENCES users(id),
  acted_at       TEXT,
  comments       TEXT,
  signature_image TEXT,
  escalation_days INTEGER NOT NULL DEFAULT 3
);

CREATE INDEX IF NOT EXISTS idx_advance_stages_advance ON advance_stages(advance_id);

CREATE TABLE IF NOT EXISTS handovers (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  handover_no   TEXT NOT NULL UNIQUE,
  bill_id       INTEGER NOT NULL UNIQUE REFERENCES bills(id),
  forwarded_at  TEXT NOT NULL,
  forwarded_by  INTEGER REFERENCES users(id),
  received_by   INTEGER REFERENCES users(id),
  received_at   TEXT,
  remarks       TEXT,
  status        TEXT NOT NULL DEFAULT 'forwarded',
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title      TEXT NOT NULL,
  message    TEXT NOT NULL,
  link       TEXT,
  is_read    INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, is_read);

CREATE TABLE IF NOT EXISTS audit_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER REFERENCES users(id),
  action      TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id   INTEGER,
  old_value   TEXT,
  new_value   TEXT,
  ip_address  TEXT,
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_logs(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at);
`);

/* ------------------------------------------------------------------ */
/* Imprest management tables                                          */
/* ------------------------------------------------------------------ */
db.exec(`
CREATE TABLE IF NOT EXISTS imprests (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  imprest_no      TEXT NOT NULL UNIQUE,
  user_id         INTEGER NOT NULL REFERENCES users(id),
  department_id   INTEGER REFERENCES departments(id),
  unit_id         INTEGER REFERENCES units(id),
  purpose         TEXT NOT NULL,
  amount_issued   REAL NOT NULL DEFAULT 0,
  date_issued     TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'Open',
  settled_amount  REAL NOT NULL DEFAULT 0,
  balance_amount  REAL NOT NULL DEFAULT 0,
  due_date        TEXT,
  created_by      INTEGER REFERENCES users(id),
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS imprest_bills (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  imprest_id  INTEGER NOT NULL REFERENCES imprests(id) ON DELETE CASCADE,
  bill_id     INTEGER NOT NULL REFERENCES bills(id),
  amount      REAL NOT NULL DEFAULT 0,
  notes       TEXT,
  created_by  INTEGER REFERENCES users(id),
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_imprests_user ON imprests(user_id);
CREATE INDEX IF NOT EXISTS idx_imprests_unit ON imprests(unit_id);
CREATE INDEX IF NOT EXISTS idx_imprest_bills_imprest ON imprest_bills(imprest_id);

CREATE TABLE IF NOT EXISTS imprest_stages (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  imprest_id     INTEGER NOT NULL REFERENCES imprests(id) ON DELETE CASCADE,
  sequence       INTEGER NOT NULL,
  name           TEXT NOT NULL,
  role_id        INTEGER NOT NULL REFERENCES roles(id),
  user_id        INTEGER REFERENCES users(id),
  alt_user_id    INTEGER REFERENCES users(id),
  status         TEXT NOT NULL DEFAULT 'pending',
  acted_by       INTEGER REFERENCES users(id),
  acted_at       TEXT,
  comments       TEXT,
  escalation_days INTEGER NOT NULL DEFAULT 3
);

CREATE INDEX IF NOT EXISTS idx_imprest_stages_imprest ON imprest_stages(imprest_id);
`);


/* ------------------------------------------------------------------ */
/* Lightweight schema migrations                                      */
/* ------------------------------------------------------------------ */
/* Existing databases created before a column was introduced are      */
/* upgraded in place. SQLite has no "ADD COLUMN IF NOT EXISTS", so we */
/* inspect the table first and only add the missing columns.          */
function ensureColumns(table, columns) {
  const existing = new Set(
    db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name)
  );
  for (const [name, definition] of Object.entries(columns)) {
    if (!existing.has(name)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
    }
  }
}

ensureColumns('categories', {
  requires_admin_pastor: 'INTEGER NOT NULL DEFAULT 0',
});

ensureColumns('bills', {
  unit_id: 'INTEGER REFERENCES units(id)',
  bill_type: "TEXT NOT NULL DEFAULT 'credit'",
  cash_settlement_type: "TEXT NOT NULL DEFAULT ''",
  imprest_reference: 'TEXT',
  due_date: 'TEXT',
  gst_type: "TEXT NOT NULL DEFAULT 'cgst_sgst'",
  gst_rate: 'REAL NOT NULL DEFAULT 0',
  cgst_amount: 'REAL NOT NULL DEFAULT 0',
  sgst_amount: 'REAL NOT NULL DEFAULT 0',
  igst_amount: 'REAL NOT NULL DEFAULT 0',
  transport_type: "TEXT NOT NULL DEFAULT 'none'",
  transport_amount: 'REAL NOT NULL DEFAULT 0',
  transport_gst_rate: 'REAL NOT NULL DEFAULT 0',
  transport_tax_amount: 'REAL NOT NULL DEFAULT 0',
  retention_percentage: 'REAL NOT NULL DEFAULT 0',
  retention_amount: 'REAL NOT NULL DEFAULT 0',
  retention_released_amount: 'REAL NOT NULL DEFAULT 0',
  retention_release_date: 'TEXT',
  retention_release_remarks: 'TEXT',
  hold_amount: 'REAL NOT NULL DEFAULT 0',
  hold_released_amount: 'REAL NOT NULL DEFAULT 0',
  hold_release_date: 'TEXT',
  hold_release_remarks: 'TEXT',
  credit_note_number: 'TEXT',
  credit_note_date: 'TEXT',
  credit_note_amount: 'REAL NOT NULL DEFAULT 0',
  credit_note_remarks: 'TEXT',
});

ensureColumns('users', {
  unit_id: 'INTEGER REFERENCES units(id)',
});

ensureColumns('advances', {
  unit_id: 'INTEGER REFERENCES units(id)',
  current_stage: 'INTEGER NOT NULL DEFAULT 0',
  submitted_at: 'TEXT',
  approved_at: 'TEXT',
});
ensureColumns('categories', {
  code: 'TEXT',
  parent_id: 'INTEGER REFERENCES categories(id)',
});
ensureColumns('imprests', {
  current_stage: 'INTEGER NOT NULL DEFAULT 0',
  submitted_at: 'TEXT',
  approved_at: 'TEXT',
  issued_by: 'INTEGER REFERENCES users(id)',
});
ensureColumns('imprest_stages', {
  signature_image: 'TEXT',
});
/* Bills recorded before the tax breakdown existed only stored a single tax
   amount. Infer the GST rate from the basic amount and split the tax into
   CGST and SGST so old bills keep the same net value and show a full
   breakdown. Runs exactly once per database. */
const taxMigration = db.prepare("SELECT value FROM settings WHERE key = 'migration.tax.v1'").get();
if (!taxMigration) {
  const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
  const legacyBills = db.prepare('SELECT id, invoice_amount, tax_amount FROM bills').all();
  const update = db.prepare(
    `UPDATE bills SET gst_type = ?, gst_rate = ?, cgst_amount = ?, sgst_amount = ?, igst_amount = ?,
       transport_type = COALESCE(NULLIF(transport_type, ''), 'none'),
       transport_amount = COALESCE(transport_amount, 0),
       transport_gst_rate = COALESCE(transport_gst_rate, 0),
       transport_tax_amount = COALESCE(transport_tax_amount, 0)
     WHERE id = ?`
  );
  for (const row of legacyBills) {
    const basic = Number(row.invoice_amount) || 0;
    const tax = r2(row.tax_amount);
    if (tax > 0) {
      const rate = basic > 0 ? r2((tax / basic) * 100) : 0;
      const cgst = r2(tax / 2);
      update.run('cgst_sgst', rate, cgst, r2(tax - cgst), 0, row.id);
    } else {
      update.run('non_gst', 0, 0, 0, 0, row.id);
    }
  }
  db.prepare(
    "INSERT INTO settings(key, value) VALUES ('migration.tax.v1', '1') ON CONFLICT(key) DO UPDATE SET value = '1'"
  ).run();
}

/* ------------------------------------------------------------------ */
/* Migration: units, admin assistant role/stage, bill type             */
/* ------------------------------------------------------------------ */
const unitMigration = db.prepare("SELECT value FROM settings WHERE key = 'migration.units.v1'").get();
if (!unitMigration) {
  // ensure at least one unit
  const uc = db.prepare('SELECT COUNT(*) AS c FROM units').get().c;
  if (uc === 0) {
    const now = new Date().toISOString();
    db.prepare('INSERT INTO units(code, name, active, created_at, updated_at) VALUES (?,?,?,?,?)').run('MAIN', 'Main Unit', 1, now, now);
  }
  const firstUnit = db.prepare('SELECT id FROM units ORDER BY id LIMIT 1').get();
  const firstUnitId = firstUnit ? firstUnit.id : null;

  // back-fill unit_id on existing bills/advances/users
  db.prepare('UPDATE bills SET unit_id = COALESCE(unit_id, ?)').run(firstUnitId);
  db.prepare('UPDATE advances SET unit_id = COALESCE(unit_id, ?)').run(firstUnitId);
  db.prepare("UPDATE users SET unit_id = COALESCE(unit_id, ?) WHERE role_id <> (SELECT id FROM roles WHERE code='super_admin')").run(firstUnitId);

  // ensure admin_assistant role exists
  const hasRole = db.prepare("SELECT id FROM roles WHERE code = 'admin_assistant'").get();
  if (!hasRole) {
    db.prepare('INSERT INTO roles(code, name, description) VALUES (?,?,?)').run('admin_assistant', 'Administrative Assistant', 'Verifier for bills before administrator approval; not an approving authority');
    // permissions are granted by the ROLE_DEFS seeding loop below
  }

  // insert assistant verification stage before Administrator Approval in existing rules
  const adminRole = db.prepare("SELECT id FROM roles WHERE code = 'administrator'").get();
  const assistantRole = db.prepare("SELECT id FROM roles WHERE code = 'admin_assistant'").get();
  if (adminRole && assistantRole) {
    const rules = db.prepare('SELECT id FROM workflow_rules').all();
    for (const r of rules) {
      const stages = db.prepare('SELECT * FROM workflow_stages WHERE rule_id = ? ORDER BY sequence ASC').all(r.id);
      const hasAssistant = stages.some((s) => s.role_id === assistantRole.id);
      const hasAdmin = stages.some((s) => s.role_id === adminRole.id);
      if (hasAdmin && !hasAssistant) {
        // find sequence of administrator stage
        const adminStage = stages.find((s) => s.role_id === adminRole.id);
        const adminSeq = adminStage ? adminStage.sequence : null;
        // shift later stages
        if (adminSeq !== null) {
          db.prepare('UPDATE workflow_stages SET sequence = sequence + 1 WHERE rule_id = ? AND sequence >= ?').run(r.id, adminSeq);
          db.prepare(
            `INSERT INTO workflow_stages(rule_id, sequence, name, role_id, escalation_days)
             VALUES (?,?,?,?,3)`
          ).run(r.id, adminSeq, 'Administrative Assistant Verification', assistantRole.id);
        }
      }
    }
  }

  db.prepare(
    "INSERT INTO settings(key, value) VALUES ('migration.units.v1', '1') ON CONFLICT(key) DO UPDATE SET value = '1'"
  ).run();
}
const taxLinesMigration = db.prepare("SELECT value FROM settings WHERE key = 'migration.tax_lines.v1'").get();
if (!taxLinesMigration) {
  const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
  const existing = db.prepare('SELECT id FROM bills WHERE id NOT IN (SELECT DISTINCT bill_id FROM bill_tax_lines)').all();
  const insert = db.prepare(
    `INSERT INTO bill_tax_lines(bill_id, sequence, label, taxable_amount, gst_rate, cgst_amount, sgst_amount, igst_amount, tax_amount)
     VALUES (?,?,?,?,?,?,?,?,?)`
  );
  for (const row of existing) {
    const b = db.prepare('SELECT invoice_amount, gst_rate, cgst_amount, sgst_amount, igst_amount FROM bills WHERE id = ?').get(row.id);
    if (!b) continue;
    const basicTax = r2((Number(b.cgst_amount) || 0) + (Number(b.sgst_amount) || 0) + (Number(b.igst_amount) || 0));
    insert.run(row.id, 1, '', r2(b.invoice_amount), r2(b.gst_rate), r2(b.cgst_amount), r2(b.sgst_amount), r2(b.igst_amount), basicTax);
  }
  db.prepare(
    "INSERT INTO settings(key, value) VALUES ('migration.tax_lines.v1', '1') ON CONFLICT(key) DO UPDATE SET value = '1'"
  ).run();
}

/* ------------------------------------------------------------------ */
/* Migration: enforce AA workflow + due_date                          */
/* ------------------------------------------------------------------ */
const aaWorkflowMigration = db.prepare("SELECT value FROM settings WHERE key = 'migration.aa_workflow.v1'").get();
if (!aaWorkflowMigration) {
  const adminRole = db.prepare("SELECT id FROM roles WHERE code = 'administrator'").get();
  if (adminRole) {
    // Fix "up to 10,000" rule: ensure Administrator Approval stage exists
    const rules = db.prepare('SELECT id FROM workflow_rules WHERE min_amount <= 10000 AND (max_amount IS NULL OR max_amount <= 10000)').all();
    for (const r of rules) {
      const stages = db.prepare('SELECT * FROM workflow_stages WHERE rule_id = ? ORDER BY sequence ASC').all(r.id);
      const hasAdmin = stages.some((s) => s.role_id === adminRole.id);
      if (!hasAdmin) {
        const deptStage = stages.find((s) => s.name === 'Departmental Approval');
        const insertSeq = deptStage ? deptStage.sequence + 1 : stages.length + 1;
        // shift later stages
        db.prepare('UPDATE workflow_stages SET sequence = sequence + 1 WHERE rule_id = ? AND sequence >= ?').run(r.id, insertSeq);
        db.prepare(
          `INSERT INTO workflow_stages(rule_id, sequence, name, role_id, escalation_days)
           VALUES (?,?,?,?,3)`
        ).run(r.id, insertSeq, 'Administrator Approval', adminRole.id);
      }
    }
  }
  db.prepare(
    "INSERT INTO settings(key, value) VALUES ('migration.aa_workflow.v1', '1') ON CONFLICT(key) DO UPDATE SET value = '1'"
  ).run();
}

const PERMISSIONS = [
  ['dashboard.view', 'Dashboard', 'View dashboard'],
  ['bill.view', 'Bills', 'View bills'],
  ['bill.create', 'Bills', 'Create bills'],
  ['bill.edit', 'Bills', 'Edit bills'],
  ['bill.delete', 'Bills', 'Delete draft bills'],
  ['bill.approve', 'Bills', 'Approve bills'],
  ['bill.reject', 'Bills', 'Reject bills'],
  ['bill.return', 'Bills', 'Return bills for correction'],
  ['bill.clarify', 'Bills', 'Request clarification'],
  ['advance.view', 'Advances', 'View advances'],
  ['advance.create', 'Advances', 'Record advances'],
  ['advance.edit', 'Advances', 'Edit advances'],
  ['advance.adjust', 'Advances', 'Adjust advances against bills'],
  ['vendor.view', 'Vendors', 'View vendors'],
  ['vendor.create', 'Vendors', 'Create vendors'],
  ['vendor.edit', 'Vendors', 'Edit vendors'],
  ['vendor.delete', 'Vendors', 'Deactivate vendors'],
  ['item.view', 'Items', 'View item master'],
  ['item.manage', 'Items', 'Create, edit and retire items'],
  ['org.view', 'Organization', 'View organization hierarchy'],
  ['org.manage', 'Organization', 'Manage branches, campuses, buildings, floors, rooms and cost centres'],
  ['employee.view', 'Employees', 'View employee master'],
  ['employee.manage', 'Employees', 'Create, edit and retire employees'],
  ['store.view', 'Stores', 'View stores and bins'],
  ['store.manage', 'Stores', 'Create, edit and retire stores and bins'],
  ['requisition.view', 'Requisitions', 'View purchase requisitions'],
  ['requisition.create', 'Requisitions', 'Raise and edit purchase requisitions'],
  ['requisition.approve', 'Requisitions', 'Approve, return or reject requisitions'],
  ['requisition.verify', 'Requisitions', 'Verify stock and issue consumables'],
  ['stock.view', 'Stock', 'View stock balances, issues and ledger'],
  ['stock.manage', 'Stock', 'Record stock adjustments and issues'],
  ['sourcing.view', 'Sourcing', 'View RFQs, quotations and comparative statements'],
  ['sourcing.manage', 'Sourcing', 'Manage RFQs, quotations and approve comparative statements'],
  ['po.view', 'Purchase Orders', 'View purchase orders'],
  ['po.manage', 'Purchase Orders', 'Create, issue, revise and cancel purchase orders'],
  ['grn.view', 'Goods Receipt', 'View goods receipt notes'],
  ['grn.manage', 'Goods Receipt', 'Create and post goods receipt notes'],
  ['invoice.view', 'Procurement Invoices', 'View procurement invoices'],
  ['invoice.manage', 'Procurement Invoices', 'Validate procurement invoices and raise linked bills'],
  ['asset.view', 'Assets', 'View the asset register and lifecycle history'],
  ['asset.manage', 'Assets', 'Create, edit and retire asset records'],
  ['asset.allocate', 'Assets', 'Allocate, return and transfer assets'],
  ['asset.maintain', 'Assets', 'Schedule and complete asset maintenance'],
  ['asset.verify', 'Assets', 'Record physical asset verifications'],
  ['asset.dispose', 'Assets', 'Request disposal of assets'],
  ['asset.approve', 'Assets', 'Approve or reject asset disposals'],
  ['vendor.evaluate', 'Vendors', 'Record vendor performance evaluations'],
  ['handover.view', 'Handover', 'View handover register'],
  ['handover.acknowledge', 'Handover', 'Acknowledge handover'],
  ['report.view', 'Reports', 'View reports'],
  ['report.export', 'Reports', 'Export and print reports'],
  ['user.manage', 'Administration', 'Manage users'],
  ['role.manage', 'Administration', 'Manage roles and permissions'],
  ['workflow.manage', 'Administration', 'Configure approval workflow'],
  ['settings.manage', 'Administration', 'Manage system settings'],
  ['audit.view', 'Administration', 'View audit trail'],
];

const ROLE_DEFS = [
  {
    code: 'super_admin',
    name: 'Super Administrator',
    description: 'Full system control',
    permissions: ['*'],
  },
  {
    code: 'admin_user',
    name: 'Administration User',
    description: 'Day-to-day bill entry and documentation',
    permissions: [
      'dashboard.view', 'bill.view', 'bill.create', 'bill.edit', 'bill.delete',
      'advance.view', 'advance.create', 'advance.edit', 'advance.adjust',
      'vendor.view', 'vendor.create', 'vendor.edit',
      'item.view', 'item.manage',
      'org.view', 'org.manage', 'employee.view', 'employee.manage',
      'store.view', 'store.manage', 'vendor.evaluate',
      'requisition.view', 'requisition.create',
      'sourcing.view', 'sourcing.manage', 'po.view', 'grn.view', 'invoice.view', 'invoice.manage',
      'asset.view', 'asset.manage', 'asset.allocate', 'asset.maintain', 'asset.verify',
      'report.view', 'report.export', 'handover.view',
    ],
  },
  {
    code: 'dept_approver',
    name: 'Departmental Approver',
    description: 'Departmental verification and approval',
    permissions: [
      'dashboard.view', 'bill.view', 'bill.create', 'bill.edit', 'bill.approve', 'bill.reject', 'bill.return',
      'bill.clarify', 'vendor.view', 'advance.view', 'report.view', 'handover.view',
      'item.view', 'org.view', 'employee.view', 'store.view',
      'requisition.view', 'requisition.approve', 'stock.view',
      'sourcing.view', 'po.view', 'grn.view', 'invoice.view',
      'asset.view',
    ],
  },
  {
    code: 'administrator',
    name: 'Administrator',
    description: 'Secondary administrative approval',
    permissions: [
      'dashboard.view', 'bill.view', 'bill.create', 'bill.edit', 'bill.approve', 'bill.reject', 'bill.return',
      'bill.clarify', 'vendor.view', 'advance.view', 'report.view', 'handover.view',
      'item.view', 'item.manage', 'org.view', 'org.manage', 'employee.view', 'employee.manage',
      'store.view', 'store.manage', 'vendor.evaluate',
      'requisition.view', 'requisition.approve', 'stock.view',
      'sourcing.view', 'sourcing.manage', 'po.view', 'grn.view', 'invoice.view', 'invoice.manage',
      'asset.view', 'asset.manage', 'asset.allocate', 'asset.maintain', 'asset.verify',
      'asset.dispose', 'asset.approve',
    ],
  },
  {
    code: 'admin_assistant',
    name: 'Administrative Assistant',
    description: 'Verifier for bills before administrator approval; not an approving authority',
    permissions: [
      'dashboard.view', 'bill.view', 'bill.create', 'bill.edit', 'bill.approve', 'bill.reject', 'bill.return',
      'bill.clarify', 'vendor.view', 'advance.view', 'report.view', 'handover.view',
      'item.view', 'org.view', 'employee.view', 'store.view',
      'requisition.view', 'stock.view',
      'sourcing.view', 'po.view', 'grn.view', 'invoice.view',
      'asset.view',
    ],
  },
  {
    code: 'admin_pastor',
    name: 'Administrative Pastor',
    description: 'Final approving authority',
    permissions: [
      'dashboard.view', 'bill.view', 'bill.create', 'bill.edit', 'bill.approve', 'bill.reject', 'bill.return',
      'bill.clarify', 'vendor.view', 'advance.view', 'report.view', 'report.export',
      'handover.view', 'item.view', 'org.view', 'employee.view', 'store.view',
      'requisition.view', 'requisition.approve', 'stock.view',
      'sourcing.view', 'po.view', 'grn.view', 'invoice.view',
      'asset.view', 'asset.approve',
    ],
  },
  {
    code: 'accounts_viewer',
    name: 'Accounts Viewer',
    description: 'Read-only access for the Accounts Department',
    permissions: [
      'dashboard.view', 'bill.view', 'vendor.view', 'advance.view',
      'handover.view', 'handover.acknowledge', 'report.view', 'report.export',
      'item.view', 'org.view', 'requisition.view', 'stock.view',
      'po.view', 'grn.view', 'invoice.view',
      'asset.view',
    ],
  },
  {
    code: 'staff',
    name: 'Staff',
    description: 'Raises requirements and tracks their own requests',
    permissions: ['dashboard.view', 'item.view', 'requisition.view', 'requisition.create', 'stock.view', 'asset.view'],
  },
  {
    code: 'department_head',
    name: 'Department Head',
    description: 'Approves departmental requirements',
    permissions: [
      'dashboard.view', 'item.view', 'org.view', 'employee.view', 'store.view',
      'requisition.view', 'requisition.approve', 'stock.view', 'report.view',
      'sourcing.view', 'po.view', 'grn.view',
      'asset.view',
    ],
  },
  {
    code: 'store_incharge',
    name: 'Store Incharge',
    description: 'Manages stores, stock and issue of consumables',
    permissions: [
      'dashboard.view', 'item.view', 'item.manage', 'org.view', 'employee.view',
      'store.view', 'store.manage', 'report.view',
      'requisition.view', 'requisition.verify', 'stock.view', 'stock.manage',
      'po.view', 'grn.view', 'grn.manage',
      'asset.view', 'asset.manage', 'asset.allocate', 'asset.maintain', 'asset.verify',
    ],
  },
  {
    code: 'procurement_officer',
    name: 'Procurement Officer',
    description: 'Handles vendors, sourcing, purchase orders and receiving',
    permissions: [
      'dashboard.view', 'item.view', 'item.manage', 'vendor.view', 'vendor.create', 'vendor.edit',
      'org.view', 'employee.view', 'store.view', 'vendor.evaluate',
      'report.view', 'report.export', 'requisition.view', 'requisition.approve', 'stock.view',
      'sourcing.view', 'sourcing.manage', 'po.view', 'po.manage',
      'grn.view', 'grn.manage', 'invoice.view', 'invoice.manage',
      'asset.view', 'asset.manage', 'asset.allocate',
    ],
  },
  {
    code: 'asset_custodian',
    name: 'Asset Custodian',
    description: 'Custodian responsible for allocated assets',
    permissions: [
      'dashboard.view', 'item.view', 'org.view', 'requisition.view', 'requisition.create',
      'po.view', 'grn.view',
      'asset.view', 'asset.maintain',
    ],
  },
  {
    code: 'senior_management',
    name: 'Senior Management',
    description: 'Management approval and executive reporting',
    permissions: [
      'dashboard.view', 'item.view', 'org.view', 'employee.view', 'store.view',
      'report.view', 'report.export', 'requisition.view', 'requisition.approve', 'stock.view',
      'sourcing.view', 'po.view', 'grn.view', 'invoice.view',
      'asset.view', 'asset.approve',
    ],
  },
  {
    code: 'auditor',
    name: 'Auditor',
    description: 'Read-only audit of transactions and masters',
    permissions: [
      'dashboard.view', 'item.view', 'org.view', 'employee.view', 'store.view',
      'audit.view', 'report.view', 'requisition.view', 'stock.view',
      'sourcing.view', 'po.view', 'grn.view', 'invoice.view',
      'asset.view',
    ],
  },
];

const upsertPermission = db.prepare(
  'INSERT INTO permissions(key, module, label) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET module=excluded.module, label=excluded.label'
);
for (const [key, module, label] of PERMISSIONS) upsertPermission.run(key, module, label);

const insertRole = db.prepare(
  'INSERT INTO roles(code, name, description, is_system) VALUES (?,?,?,1) ON CONFLICT(code) DO NOTHING'
);
const findRole = db.prepare('SELECT id FROM roles WHERE code = ?');
const grant = db.prepare(
  'INSERT INTO role_permissions(role_id, permission_key) VALUES (?,?) ON CONFLICT DO NOTHING'
);
const allPermissions = PERMISSIONS.map((p) => p[0]);

for (const def of ROLE_DEFS) {
  insertRole.run(def.code, def.name, def.description);
  const role = findRole.get(def.code);
  const perms = def.permissions.includes('*') ? allPermissions : def.permissions;
  for (const p of perms) grant.run(role.id, p);
}

/* ------------------------------------------------------------------ */
/* ------------------------------------------------------------------ */
/* Migration: enforce AA workflow for all amounts                     */
/* ------------------------------------------------------------------ */
const aaWorkflow2Migration = db.prepare("SELECT value FROM settings WHERE key = 'migration.aa_workflow.v2'").get();
if (!aaWorkflow2Migration) {
  const adminRole = db.prepare("SELECT id FROM roles WHERE code = 'administrator'").get();
  const assistantRole = db.prepare("SELECT id FROM roles WHERE code = 'admin_assistant'").get();
  if (adminRole && assistantRole) {
    const rules = db.prepare('SELECT id FROM workflow_rules').all();
    for (const r of rules) {
      const stages = db.prepare('SELECT * FROM workflow_stages WHERE rule_id = ? ORDER BY sequence ASC').all(r.id);
      const hasAssistant = stages.some((s) => s.role_id === assistantRole.id);
      const hasAdmin = stages.some((s) => s.role_id === adminRole.id);
      if (!hasAssistant) {
        const insertSeq = hasAdmin
          ? stages.find((s) => s.role_id === adminRole.id).sequence
          : stages.length + 1;
        db.prepare('UPDATE workflow_stages SET sequence = sequence + 1 WHERE rule_id = ? AND sequence >= ?').run(r.id, insertSeq);
        db.prepare(
          "INSERT INTO workflow_stages(rule_id, sequence, name, role_id, escalation_days) VALUES (?,?,?,?,3)"
        ).run(r.id, insertSeq, 'Administrative Assistant Verification', assistantRole.id);
      }
      const stages2 = db.prepare('SELECT * FROM workflow_stages WHERE rule_id = ? ORDER BY sequence ASC').all(r.id);
      const hasAdmin2 = stages2.some((s) => s.role_id === adminRole.id);
      if (!hasAdmin2) {
        db.prepare(
          "INSERT INTO workflow_stages(rule_id, sequence, name, role_id, escalation_days) VALUES (?,?,?,?,3)"
        ).run(r.id, stages2.length + 1, 'Administrator Approval', adminRole.id);
      }
    }
  }
  db.prepare(
    "INSERT INTO settings(key, value) VALUES ('migration.aa_workflow.v2', '1') ON CONFLICT(key) DO UPDATE SET value = '1'"
  ).run();
}

/* Seed: settings, lookups, users, vendors, workflow                  */
/* ------------------------------------------------------------------ */

function seedIfEmpty() {
  const now = new Date().toISOString();

  const settings = {
    'org.name': 'New Life AG Church',
    'org.department': 'Administration Department',
    'org.address': '',
    'currency': '\u20B9',
    'public_base_url': '',
    'report.footer': 'This is a system generated approval report. Generated by ABMDAS.',
    'notify.email': '0',
    'tax.default_gst_rate': '18',
    'tax.default_transport_gst_rate': '18',
  };
  const setSetting = db.prepare('INSERT INTO settings(key, value) VALUES (?,?) ON CONFLICT(key) DO NOTHING');
  for (const [k, v] of Object.entries(settings)) setSetting.run(k, v);

  const hasUsers = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  if (hasUsers === 0) {
    const roles = Object.fromEntries(
      db.prepare('SELECT id, code FROM roles').all().map((r) => [r.code, r.id])
    );
    const users = [
      ['EMP-001', 'System Administrator', 'Administration', 'Super Administrator', 'admin', 'admin@newlifeag.org', 'admin', 'Admin@123', 'super_admin'],
      ['EMP-002', 'Mary Thomas', 'Administration', 'Administration Executive', 'mary', 'mary@newlifeag.org', 'mary', 'User@123', 'admin_user'],
      ['EMP-003', 'Samuel Joseph', 'Administration', 'Departmental Approver', 'samuel', 'samuel@newlifeag.org', 'samuel', 'User@123', 'dept_approver'],
      ['EMP-004', 'Daniel Mathew', 'Administration', 'Administrator', 'daniel', 'daniel@newlifeag.org', 'daniel', 'User@123', 'administrator'],
      ['EMP-004A', 'Assistant Admin', 'Administration', 'Administrative Assistant', 'assistant', 'assistant@newlifeag.org', 'assistant', 'User@123', 'admin_assistant'],
      ['EMP-005', 'Rev. Thomas Philip', 'Administration', 'Administrative Pastor', 'pastor', 'pastor@newlifeag.org', 'pastor', 'User@123', 'admin_pastor'],
      ['EMP-006', 'Grace Abraham', 'Accounts', 'Accounts Officer', 'accounts', 'accounts@newlifeag.org', 'accounts', 'User@123', 'accounts_viewer'],
    ];
    const insertUser = db.prepare(`
      INSERT INTO users(employee_id, name, department, designation, mobile, email, username,
                        password_hash, role_id, status, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,'Active',?,?)`);
    for (const [emp, name, dept, desig, uname, email, username, password, roleCode] of users) {
      insertUser.run(emp, name, dept, desig, '', email, username, hashPassword(password), roles[roleCode], now, now);
    }
  }

  const hasUnits = db.prepare('SELECT COUNT(*) AS c FROM units').get().c;
  if (hasUnits === 0) {
    const addUnit = db.prepare('INSERT INTO units(code, name, active, created_at, updated_at) VALUES (?,?,1,?,?)');
    const now = new Date().toISOString();
    addUnit.run('MAIN', 'Main Unit', now, now);
  }

  const hasDepartments = db.prepare('SELECT COUNT(*) AS c FROM departments').get().c;
  if (hasDepartments === 0) {
    const add = db.prepare('INSERT INTO departments(name) VALUES (?)');
    for (const d of [
      'Administration Department', 'Maintenance Department (MEP)', 'Security Department',
      'Transport Department', 'Housekeeping Department', 'IT Department', 'HR Department',
      'Facility & Hospitality Department', 'Purchase Department', 'Stores Department',
      'Printing & Designing Department', 'Media Department', 'Building Maintenance',
      'MEP Projects', 'Civil Projects', 'Book Store', 'Events Management',
      'English Service', 'Telegu Service', 'Hindi Service',
      'Finance & Accounts Department',
      'Accounts', 'Music & Worship', 'Children Ministry', 'Outreach', 'Pastoral Care',
    ]) add.run(d);
  }

  const hasCategories = db.prepare('SELECT COUNT(*) AS c FROM categories').get().c;
  if (hasCategories === 0) {
    const addMain = db.prepare('INSERT INTO categories(code, name, parent_id) VALUES (?,?,NULL)');
    const addSub = db.prepare('INSERT INTO categories(code, name, parent_id) VALUES (?,?,?)');
    const mainCats = [
      ['ADM', 'Administration'],
      ['UTL', 'Utilities'],
      ['BMT', 'Building Maintenance'],
      ['HKP', 'Housekeeping'],
      ['SEC', 'Security & Safety'],
      ['VEH', 'Vehicle Expenses'],
      ['IT', 'Information Technology'],
      ['HR', 'Human Resources'],
      ['HOS', 'Hospitality & Guest Relations'],
      ['EVT', 'Events & Programs'],
      ['MED', 'Media & Communication'],
      ['PRT', 'Printing & Publications'],
      ['PUR', 'Purchases & Procurement'],
      ['INV', 'Inventory & Stores'],
      ['BST', 'Bookstore'],
      ['CAN', 'Canteen'],
      ['MIN', 'Ministry Activities'],
      ['PRJ', 'Construction & Projects'],
      ['AST', 'Assets'],
      ['EMG', 'Emergency & Contingency'],
    ];
    const subCats = {
      'ADM': ['Office Stationery', 'Printing & Photocopying', 'Courier & Postage', 'Office Consumables', 'Staff Refreshments', 'Meeting Expenses', 'Legal Expenses', 'Audit Expenses', 'Government Fees & Licenses', 'Insurance Premiums', 'Miscellaneous Expenses'],
      'UTL': ['Electricity Charges', 'Water Charges', 'Internet Charges', 'Telephone Charges', 'Mobile Charges', 'Gas Charges'],
      'BMT': ['Electrical Maintenance', 'Plumbing Maintenance', 'Air Conditioner Maintenance', 'Civil Maintenance', 'Carpentry Maintenance', 'Fabrication Works', 'Painting Works', 'Waterproofing Works', 'False Ceiling Works', 'Glass & Aluminium Works', 'General Repairs'],
      'HKP': ['Cleaning Chemicals', 'Cleaning Consumables', 'Restroom Supplies', 'Pest Control', 'Garden Maintenance', 'Waste Disposal', 'Carpet Cleaning', 'Curtain Maintenance'],
      'SEC': ['Security Services', 'CCTV Maintenance', 'Fire Safety Systems', 'Access Control Systems', 'Safety Equipment', 'Visitor Management'],
      'VEH': ['Diesel', 'Petrol', 'Fastag Recharge', 'Vehicle Service', 'Vehicle Repairs', 'Tyres & Tubes', 'Battery Replacement', 'Vehicle Insurance', 'FC Renewal', 'Permit Renewal', 'Road Tax', 'Pollution Certificate', 'Vehicle Accessories'],
      'IT': ['Computer Hardware', 'Software Licenses', 'Website Maintenance', 'Cloud Services', 'Antivirus', 'Firewall', 'Networking Equipment', 'Printer Maintenance', 'IT AMC'],
      'HR': ['Salaries & Wages', 'Contract Staff Payments', 'Overtime', 'Recruitment Expenses', 'Training & Development', 'Uniforms', 'Staff Welfare', 'Medical Assistance'],
      'HOS': ['Guest Accommodation', 'Guest Transportation', 'Guest Food & Refreshments', 'Hall Setup', 'Conference Arrangements'],
      'EVT': ['Stage Decoration', 'Floral Decoration', 'Event Materials', 'Sound System', 'Lighting System', 'Event Setup Charges', 'Volunteer Support'],
      'MED': ['Photography', 'Videography', 'Live Streaming', 'Media Production', 'Advertisement', 'Equipment Maintenance'],
      'PRT': ['Banner Printing', 'Flex Printing', 'Brochure Printing', 'Book Printing', 'Invitation Printing', 'Design Charges'],
      'PUR': ['Consumable Purchases', 'Asset Purchases', 'Vendor Advances', 'Freight & Transportation', 'Local Purchases'],
      'INV': ['Inventory Purchases', 'Storage Materials', 'Asset Tagging', 'Inventory Adjustment', 'Asset Disposal'],
      'BST': ['Bible Purchase', 'Books Purchase', 'Merchandise Purchase', 'Stationery Purchase'],
      'CAN': ['Grocery Purchase', 'Milk & Beverages', 'Kitchen Consumables', 'Kitchen Equipment Maintenance', 'Gas Refill'],
      'MIN': ['Outreach Programs', 'Missions Support', 'Ministry Materials', 'Special Ministry Events'],
      'PRJ': ['Construction Work', 'Renovation Work', 'Interior Works', 'Architectural Consultancy', 'Engineering Consultancy', 'Project Management Fees', 'Contractor Bills'],
      'AST': ['Furniture Purchase', 'Equipment Purchase', 'Fixture Purchase', 'Asset Repairs', 'Asset Maintenance'],
      'EMG': ['Emergency Repairs', 'Urgent Purchases', 'Disaster Recovery', 'Special Approval Expenses'],
    };
    const mainIds = {};
    for (const [code, name] of mainCats) {
      const res = addMain.run(code, name);
      mainIds[code] = Number(res.lastInsertRowid);
    }
    for (const [code, subs] of Object.entries(subCats)) {
      for (const sub of subs) {
        addSub.run(null, sub, mainIds[code]);
      }
    }
  }

  /* Default approval matrix */
  const hasRules = db.prepare('SELECT COUNT(*) AS c FROM workflow_rules').get().c;
  if (hasRules === 0) {
    const roles = Object.fromEntries(
      db.prepare('SELECT id, code FROM roles').all().map((r) => [r.code, r.id])
    );
    const addRule = db.prepare(
      'INSERT INTO workflow_rules(name, min_amount, max_amount, active, created_at, updated_at) VALUES (?,?,?,1,?,?)'
    );
    const addStage = db.prepare(
      'INSERT INTO workflow_stages(rule_id, sequence, name, role_id, escalation_days) VALUES (?,?,?,?,?)'
    );
    const rules = [
      {
        name: 'Up to \u20B910,000',
        min: 0,
        max: 10000,
        stages: [['Departmental Approval', 'dept_approver'], ['Administrative Assistant Verification', 'admin_assistant'], ['Administrator Approval', 'administrator']],
      },
      {
        name: '\u20B910,001 \u2013 \u20B950,000',
        min: 10000.01,
        max: 50000,
        stages: [['Departmental Approval', 'dept_approver'], ['Administrative Assistant Verification', 'admin_assistant'], ['Administrator Approval', 'administrator']],
      },
      {
        name: '\u20B950,001 \u2013 \u20B92,00,000',
        min: 50000.01,
        max: 200000,
        stages: [
          ['Departmental Approval', 'dept_approver'],
          ['Administrative Assistant Verification', 'admin_assistant'],
          ['Administrator Approval', 'administrator'],
          ['Administrative Pastor Approval', 'admin_pastor'],
        ],
      },
      {
        name: 'Above \u20B92,00,000 (custom chain)',
        min: 200000.01,
        max: null,
        stages: [
          ['Departmental Approval', 'dept_approver'],
          ['Administrative Assistant Verification', 'admin_assistant'],
          ['Administrator Approval', 'administrator'],
          ['Administrative Pastor Approval', 'admin_pastor'],
        ],
      },
    ];
    for (const r of rules) {
      const res = addRule.run(r.name, r.min, r.max, now, now);
      r.stages.forEach(([name, role], i) => addStage.run(res.lastInsertRowid, i + 1, name, roles[role], 3));
    }
  }

  /* Vendors are managed from the Masters page. Demo vendors are not seeded,
     so a cleaned database stays free of sample records. */
}

seedIfEmpty();

/* Default procurement general terms (idempotent; administrator edits win). */
db.prepare('INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)').run(
  'procurement.general_terms',
  DEFAULT_GENERAL_TERMS
);

/* ------------------------------------------------------------------ */
/* Migration: Administrative Assistant is a bill verifier only        */
/* ------------------------------------------------------------------ */
const verifierRoleMigration = db
  .prepare("SELECT value FROM settings WHERE key = 'migration.verifier.v1'")
  .get();
if (!verifierRoleMigration) {
  const assistantRole = db.prepare("SELECT id FROM roles WHERE code = 'admin_assistant'").get();
  if (assistantRole) {
    db.prepare('UPDATE roles SET name = ?, description = ? WHERE id = ?').run(
      'Administrative Assistant',
      'Verifier for bills before administrator approval; not an approving authority',
      assistantRole.id
    );
    db.prepare('UPDATE workflow_stages SET name = ? WHERE role_id = ?').run(
      'Administrative Assistant Verification',
      assistantRole.id
    );
    db.prepare('UPDATE bill_stages SET name = ? WHERE role_id = ?').run(
      'Administrative Assistant Verification',
      assistantRole.id
    );

    // Advances and imprests do not use the Administrative Assistant stage.
    db.prepare('DELETE FROM advance_stages WHERE role_id = ?').run(assistantRole.id);
    db.prepare('DELETE FROM imprest_stages WHERE role_id = ?').run(assistantRole.id);

    const adminRole = db.prepare("SELECT id FROM roles WHERE code = 'administrator'").get();
    if (adminRole) {
      const pendingAdvances = db
        .prepare(
          `SELECT a.id FROM advances a
            WHERE a.status = 'pending'
              AND NOT EXISTS (
                SELECT 1 FROM advance_stages s WHERE s.advance_id = a.id AND s.status = 'pending'
              )`
        )
        .all();
      for (const row of pendingAdvances) {
        const nextSeq = db
          .prepare('SELECT COALESCE(MAX(sequence), 0) AS m FROM advance_stages WHERE advance_id = ?')
          .get(row.id).m + 1;
        db.prepare(
          "INSERT INTO advance_stages(advance_id, sequence, name, role_id, status, escalation_days) VALUES (?,?,?,?,'pending',3)"
        ).run(row.id, nextSeq, 'Administrator Approval', adminRole.id);
      }

      const pendingImprests = db
        .prepare(
          `SELECT i.id FROM imprests i
            WHERE i.status = 'pending'
              AND NOT EXISTS (
                SELECT 1 FROM imprest_stages s WHERE s.imprest_id = i.id AND s.status = 'pending'
              )`
        )
        .all();
      for (const row of pendingImprests) {
        const nextSeq = db
          .prepare('SELECT COALESCE(MAX(sequence), 0) AS m FROM imprest_stages WHERE imprest_id = ?')
          .get(row.id).m + 1;
        db.prepare(
          "INSERT INTO imprest_stages(imprest_id, sequence, name, role_id, status, escalation_days) VALUES (?,?,?,?,'pending',3)"
        ).run(row.id, nextSeq, 'Administrator Approval', adminRole.id);
      }
    }
  }
  db.prepare(
    "INSERT INTO settings(key, value) VALUES ('migration.verifier.v1', '1') ON CONFLICT(key) DO UPDATE SET value = '1'"
  ).run();
}

/* Idempotent: keep the Administrative Assistant designation in sync. */
db.prepare(
  "UPDATE users SET designation = 'Administrative Assistant' WHERE designation = 'Administrator Assistant'"
).run();

/* Keep unit membership complete: every user belongs to every active unit, and
   the home unit is always a membership. Idempotent; runs on every start. */
db.exec(`
  INSERT OR IGNORE INTO user_units(user_id, unit_id)
    SELECT u.id, un.id FROM users u CROSS JOIN units un WHERE un.active = 1;
  INSERT OR IGNORE INTO user_units(user_id, unit_id)
    SELECT id, unit_id FROM users WHERE unit_id IS NOT NULL;
`);

db.exec(`
CREATE TABLE IF NOT EXISTS reimbursements (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  reimbursement_no  TEXT NOT NULL UNIQUE,
  user_id           INTEGER NOT NULL REFERENCES users(id),
  department_id     INTEGER REFERENCES departments(id),
  unit_id           INTEGER REFERENCES units(id),
  expense_category  TEXT NOT NULL DEFAULT '',
  amount            REAL NOT NULL DEFAULT 0,
  expense_date      TEXT NOT NULL,
  description       TEXT,
  remarks           TEXT,
  status            TEXT NOT NULL DEFAULT 'draft',
  current_stage     INTEGER NOT NULL DEFAULT 0,
  submitted_at      TEXT,
  approved_at       TEXT,
  paid_at           TEXT,
  created_by        INTEGER REFERENCES users(id),
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reimbursement_attachments (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  reimbursement_id INTEGER NOT NULL REFERENCES reimbursements(id) ON DELETE CASCADE,
  file_name       TEXT NOT NULL,
  stored_name     TEXT NOT NULL,
  mime_type       TEXT,
  size            INTEGER NOT NULL DEFAULT 0,
  uploaded_by     INTEGER REFERENCES users(id),
  uploaded_at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_reimbursements_user ON reimbursements(user_id);
CREATE INDEX IF NOT EXISTS idx_reimbursements_unit ON reimbursements(unit_id);
CREATE INDEX IF NOT EXISTS idx_reimbursement_attachments_r ON reimbursement_attachments(reimbursement_id);
`);

/* Numbered records (vendors, bills, advances, handovers) get their    */
/* next number from the sequences table. Seeded and manually created   */
/* rows can exist without a matching sequence value, which would cause */
/* duplicate codes. Raise each sequence to at least the highest number */
/* already used by an existing record.                                 */
function syncSequenceFloor(key, table, column, prefix, year) {
  const bucket = year ? `${key}:${new Date().getFullYear()}` : key;
  const like = year ? `${prefix}/${new Date().getFullYear()}/%` : `${prefix}-%`;
  const rows = db.prepare(`SELECT ${column} AS code FROM ${table} WHERE ${column} LIKE ?`).all(like);
  let max = 0;
  for (const row of rows) {
    const n = parseInt(String(row.code).split(/[/-]/).pop(), 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  db.prepare(
    `INSERT INTO sequences(key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = CASE WHEN value < excluded.value THEN excluded.value ELSE value END`
  ).run(bucket, max);
}

syncSequenceFloor('vendor', 'vendors', 'code', 'VND', false);
syncSequenceFloor('bill', 'bills', 'bill_no', 'BILL', true);
syncSequenceFloor('advance', 'advances', 'advance_no', 'ADV', true);
syncSequenceFloor('imprest', 'imprests', 'imprest_no', 'IMP', true);
syncSequenceFloor('reimbursement', 'reimbursements', 'reimbursement_no', 'RMB', true);
syncSequenceFloor('handover', 'handovers', 'handover_no', 'HND', true);

/* ------------------------------------------------------------------ */
/* Additive procurement / inventory / asset foundation                 */
/* ------------------------------------------------------------------ */
require('./procurement/schema').ensureProcurementSchema(db);

module.exports = { db, DATA_DIR, DB_FILE };
