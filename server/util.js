'use strict';

const { db } = require('./db');

function nowIso() {
  return new Date().toISOString();
}

/* Local calendar date (YYYY-MM-DD). Using the local date avoids rejecting an
   invoice dated "today" in the early hours before UTC has rolled over. */
function today() {
  const d = new Date();
  const offset = d.getTimezoneOffset();
  return new Date(d.getTime() - offset * 60000).toISOString().slice(0, 10);
}

function nextSequence(key, { prefix, year = true, pad = 4 } = {}) {
  const bucket = year ? `${key}:${new Date().getFullYear()}` : key;
  db.prepare('INSERT INTO sequences(key, value) VALUES (?, 0) ON CONFLICT(key) DO NOTHING').run(bucket);
  db.prepare('UPDATE sequences SET value = value + 1 WHERE key = ?').run(bucket);
  const value = db.prepare('SELECT value FROM sequences WHERE key = ?').get(bucket).value;
  const num = String(value).padStart(pad, '0');
  if (!prefix) return num;
  return year ? `${prefix}/${new Date().getFullYear()}/${num}` : `${prefix}-${num}`;
}

function nextVendorCode() {
  return nextSequence('vendor', { prefix: 'VND', year: false, pad: 4 });
}

function nextBillNo() {
  return nextSequence('bill', { prefix: 'BILL', pad: 4 });
}

function nextAdvanceNo() {
  return nextSequence('advance', { prefix: 'ADV', pad: 4 });
}

function nextHandoverNo() {
  return nextSequence('handover', { prefix: 'HND', pad: 4 });
}

function nextItemCode() {
  return nextSequence('item', { prefix: 'ITM', year: false, pad: 5 });
}

function nextEmployeeCode() {
  return nextSequence('employee', { prefix: 'EMP', year: false, pad: 4 });
}

function nextRequisitionNo() {
  return nextSequence('requisition', { prefix: 'PR', pad: 4 });
}

function nextIssueNo() {
  return nextSequence('stock_issue', { prefix: 'ISS', pad: 4 });
}

function nextAdjustmentNo() {
  return nextSequence('stock_adjustment', { prefix: 'ADJ', pad: 4 });
}

function nextRfqNo() {
  return nextSequence('rfq', { prefix: 'RFQ', pad: 4 });
}

function nextQuotationNo() {
  return nextSequence('quotation', { prefix: 'QT', pad: 4 });
}

function nextComparativeNo() {
  return nextSequence('comparative_statement', { prefix: 'CS', pad: 4 });
}

/* Indian financial year label, e.g. Nov 2026 -> "26-27". */
function financialYear(dateValue) {
  const d = dateValue ? new Date(dateValue) : new Date();
  const year = Number.isFinite(d.getFullYear()) ? d.getFullYear() : new Date().getFullYear();
  const month = d.getMonth() + 1;
  const start = month >= 4 ? year : year - 1;
  return `${String(start).slice(-2)}-${String(start + 1).slice(-2)}`;
}

/* PO/UNITCODE/DEPTCODE/FY/NNNN. The trailing NNNN is one continuous,
   register-wide series; unit, department and FY are only labels. */
function nextPurchaseOrderNo(unitId, departmentId, poDate) {
  const unit = db.prepare('SELECT code FROM units WHERE id = ?').get(unitId);
  const dept = departmentId
    ? db.prepare('SELECT code FROM departments WHERE id = ?').get(departmentId)
    : null;
  const unitCode = String((unit && unit.code) || 'UNIT').toUpperCase();
  const deptCode = String((dept && dept.code) || 'GEN').toUpperCase();
  const fy = financialYear(poDate);
  const key = 'purchase_order';
  const exists = db.prepare('SELECT 1 FROM purchase_orders WHERE po_no = ?');
  for (let attempt = 0; attempt < 10000; attempt += 1) {
    const sequence = nextSequence(key, { year: false, pad: 4 });
    const poNo = `PO/${unitCode}/${deptCode}/${fy}/${sequence}`;
    if (!exists.get(poNo)) return poNo;
  }
  throw new Error('Unable to allocate a unique purchase order number.');
}

function nextGrnNo() {
  return nextSequence('grn', { prefix: 'GRN', pad: 4 });
}

function nextServiceAcceptanceNo() {
  return nextSequence('service_acceptance', { prefix: 'SA', pad: 4 });
}

function nextInvoiceNo() {
  return nextSequence('procurement_invoice', { prefix: 'PINV', pad: 4 });
}

/* Asset labels are unit- and year-scoped: AST-<UNIT>-<YYYY>-<000001>. */
function nextAssetCode(unitCode) {
  const year = new Date().getFullYear();
  const key = `asset:${unitCode || 'UNIT'}:${year}`;
  db.prepare('INSERT INTO sequences(key, value) VALUES (?, 0) ON CONFLICT(key) DO NOTHING').run(key);
  db.prepare('UPDATE sequences SET value = value + 1 WHERE key = ?').run(key);
  const value = db.prepare('SELECT value FROM sequences WHERE key = ?').get(key).value;
  return `AST-${unitCode || 'UNIT'}-${year}-${String(value).padStart(6, '0')}`;
}

function audit(req, action, entityType, entityId, oldValue, newValue) {
  try {
    db.prepare(
      `INSERT INTO audit_logs(user_id, action, entity_type, entity_id, old_value, new_value, ip_address, created_at)
       VALUES (?,?,?,?,?,?,?,?)`
    ).run(
      req.user ? req.user.id : null,
      action,
      entityType,
      entityId == null ? null : Number(entityId),
      oldValue == null ? null : JSON.stringify(oldValue),
      newValue == null ? null : JSON.stringify(newValue),
      req.ip || '',
      nowIso()
    );
  } catch (err) {
    console.error('Audit log failed', err);
  }
}

function notify(userIds, title, message, link) {
  const ids = [...new Set((userIds || []).filter(Boolean))];
  if (!ids.length) return;
  const stmt = db.prepare(
    'INSERT INTO notifications(user_id, title, message, link, is_read, created_at) VALUES (?,?,?,?,0,?)'
  );
  const at = nowIso();
  for (const id of ids) stmt.run(id, title, message, link || null, at);
}

function userIdsByRole(roleCode) {
  return db
    .prepare(
      `SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id
        WHERE r.code = ? AND u.status = 'Active'`
    )
    .all(roleCode)
    .map((r) => r.id);
}

function getSetting(key, fallback = '') {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

function setSetting(key, value) {
  db.prepare(
    'INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, String(value));
}

function getSettings() {
  return Object.fromEntries(db.prepare('SELECT key, value FROM settings').all().map((r) => [r.key, r.value]));
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/* Nearest-rupee, half-up rounding. Values are first normalised to 2 decimals
 * so binary floating-point noise (e.g. 950.6000000000001) cannot tip a .5
 * boundary the wrong way. Math.round is half-up for positive values, which is
 * the commercial convention used for GR/round-off on invoices and bills. */
function roundToNearestRupee(n) {
  return Math.round(round2(n) + Number.EPSILON);
}

/* Short alias used by the tax/document helpers. */
function roundRupee(n) {
  return roundToNearestRupee(n);
}

/* Parse an optional manual round-off adjustment. Forms auto-fill this value
 * but let the user change it when required. An empty value means "use auto". */
function parseRoundOffOverride(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'object') {
    if (value.roundOff !== undefined) return parseRoundOffOverride(value.roundOff);
    if (value.round_off !== undefined) return parseRoundOffOverride(value.round_off);
    return undefined;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed || trimmed.toLowerCase() === 'auto') return undefined;
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) throw badRequest('Round off must be a number.');
    return round2(parsed);
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw badRequest('Round off must be a number.');
  }
  return round2(value);
}

/* Returns the pre-round line, the adjustment and the FINAL rounded total.
 * round_off = roundedTotal - preRoundTotal (kept to 2 decimals). When an
 * explicit adjustment is supplied, the final total is base + adjustment. */
function calculateRoundOff(n, override) {
  const baseTotalAmount = round2(n);
  const manual = parseRoundOffOverride(override);
  const roundOff = manual === undefined
    ? round2(roundToNearestRupee(baseTotalAmount) - baseTotalAmount)
    : manual;
  const totalAmount = round2(baseTotalAmount + roundOff);
  return { baseTotalAmount, roundOff, totalAmount, manual: manual !== undefined };
}

/* Alias kept for callers that name the adjustment directly. */
function roundOffAmount(n) {
  return calculateRoundOff(n);
}

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

module.exports = {
  nowIso,
  today,
  nextSequence,
  nextBillNo,
  nextAdvanceNo,
  nextHandoverNo,
  nextItemCode,
  nextEmployeeCode,
  nextVendorCode,
  nextRequisitionNo,
  nextIssueNo,
  nextAdjustmentNo,
  nextRfqNo,
  nextQuotationNo,
  nextComparativeNo,
  nextPurchaseOrderNo,
  financialYear,
  nextGrnNo,
  nextInvoiceNo,
  nextServiceAcceptanceNo,
  nextAssetCode,
  audit,
  notify,
  userIdsByRole,
  getSetting,
  setSetting,
  getSettings,
  round2,
  roundToNearestRupee,
  roundRupee,
  calculateRoundOff,
  roundOffAmount,
  badRequest,
};
