'use strict';

/**
 * Small helpers shared by the Phase 1b procurement route modules.
 * Additive only — nothing here touches ABMDAS tables or behaviour.
 */

const { HttpError } = require('../http');
const { badRequest } = require('../util');

function unitScope(ctx) {
  const ids = [...new Set((ctx.unitIds || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  if (!ids.length) throw new HttpError(403, 'You do not have access to any unit.');
  return ids;
}

function inList(ids) {
  return ids.map(() => '?').join(',');
}

function requireText(body, field, label, max = 500) {
  const value = String(body[field] || '').trim();
  if (!value) throw badRequest(`${label} is required.`);
  if (value.length > max) throw badRequest(`${label} is too long.`);
  return value;
}

function optionalText(body, field, max = 500) {
  return String(body[field] || '').trim().slice(0, max);
}

function optionalId(source, field) {
  if (source[field] === undefined || source[field] === null || source[field] === '') return null;
  const n = Number(source[field]);
  if (!Number.isInteger(n) || n <= 0) throw badRequest(`${field} is invalid.`);
  return n;
}

function optionalDate(source, field, label) {
  if (source[field] === undefined || source[field] === null || source[field] === '') return null;
  const value = String(source[field]).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw badRequest(`${label || field} must be a valid date.`);
  return value;
}

function ensureUnit(ctx, unitId) {
  const ids = unitScope(ctx);
  const id = Number(unitId);
  if (!Number.isInteger(id) || !ids.includes(id)) {
    throw new HttpError(403, 'You are not a member of the selected unit.');
  }
  return id;
}

function transaction(db, fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* ignore rollback failure */
    }
    throw err;
  }
}

function pageParams(query) {
  const page = Math.max(1, Number(query.page) || 1);
  const pageSize = Math.min(200, Math.max(1, Number(query.pageSize) || 50));
  return { page, pageSize, offset: (page - 1) * pageSize };
}

function ensureVendor(db, vendorId) {
  const vendor = db.prepare('SELECT * FROM vendors WHERE id = ?').get(Number(vendorId));
  if (!vendor) throw badRequest('Selected vendor does not exist.');
  if (vendor.status === 'Blacklisted') throw badRequest('Blacklisted vendors cannot be used.');
  return vendor;
}

function rowOr404(row, message) {
  if (!row) throw new HttpError(404, message);
  return row;
}

module.exports = {
  unitScope,
  inList,
  requireText,
  optionalText,
  optionalId,
  optionalDate,
  ensureUnit,
  transaction,
  pageParams,
  ensureVendor,
  rowOr404,
};
