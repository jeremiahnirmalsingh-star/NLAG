'use strict';

/**
 * Common-master safeguards.
 *
 * Employees, departments and users are shared by ABMDAS core, Procurement and
 * Fleet Desk. Deactivating or removing one must not break an open PO or an
 * assigned/requested trip. This helper is additive and read-only; it never
 * modifies data and never introduces a new permission.
 */

function count(db, sql, params) {
  try {
    return Number(db.prepare(sql).get(...params).c || 0);
  } catch {
    return 0; // table or column not present in an older database
  }
}

function inUseMessage(db, type, id) {
  const key = Number(id);
  if (!Number.isInteger(key) || key <= 0) return null;

  if (type === 'employee') {
    const trips = count(
      db,
      "SELECT COUNT(*) AS c FROM fleet_trips WHERE driver_id = ? AND status IN ('ASSIGNED','PENDING')",
      [key]
    );
    if (trips) return `This employee is assigned to ${trips} active fleet trip(s). Complete those trips first.`;
    const assets = count(
      db,
      'SELECT COUNT(*) AS c FROM assets WHERE custodian_employee_id = ? AND deleted_at IS NULL',
      [key]
    );
    if (assets) return `This employee is the custodian of ${assets} asset(s). Reassign those assets first.`;
    return null;
  }

  if (type === 'department') {
    const trips = count(
      db,
      "SELECT COUNT(*) AS c FROM fleet_trips WHERE department_id = ? AND status IN ('PENDING','ASSIGNED')",
      [key]
    );
    if (trips) return `This department has ${trips} active fleet booking(s). Complete those trips first.`;
    const orders = count(
      db,
      `SELECT COUNT(*) AS c FROM purchase_orders
        WHERE department_id = ?
          AND deleted_at IS NULL
          AND status NOT IN ('received','closed','cancelled')`,
      [key]
    );
    if (orders) return `This department has ${orders} open purchase order(s). Close those orders first.`;
  }

  return null;
}

module.exports = { inUseMessage };
