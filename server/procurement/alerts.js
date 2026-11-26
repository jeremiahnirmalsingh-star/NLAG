'use strict';

/**
 * Alert / notification engine — Phase 5d.
 *
 * Generates in-app notifications for:
 *   - Warranty expiry (assets whose warranty_end falls within N days)
 *   - AMC renewal (assets whose amc_end_date falls within N days)
 *   - Stock reorder (items whose total stock balance < reorder_level)
 *   - Consumable expiry (items with expiry_tracking and stock with expiry within N days)
 *   - Fleet vehicle compliance expiry (registration, insurance, permit, road tax, pollution)
 *
 * Notifications are de-duplicated by (user, title, entity) within a 24-hour window
 * so repeated runs do not spam users.
 */

const { notify, userIdsByRole } = require('../util');

const WINDOWS = [30, 60, 90];

function today() { return new Date().toISOString().slice(0, 10); }

function addDays(isoDate, days) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function recipientIds(db) {
  const roles = ['store_incharge', 'procurement_officer', 'asset_custodian', 'administrator'];
  const ids = [];
  for (const r of roles) ids.push(...userIdsByRole(r));
  return [...new Set(ids)];
}

/* Vehicle expiry notices follow the approval configuration already saved in
   the system: core workflow stage roles, procurement workflow stage roles,
   roles with Fleet master management, and Transport/Administration users. */
function vehicleRecipientIds(db) {
  const ids = new Set();
  const collect = (rows) => rows.forEach((r) => ids.add(Number(r.id)));
  collect(db.prepare(
    `SELECT DISTINCT u.id
       FROM users u
       JOIN roles r ON r.id = u.role_id
       JOIN workflow_stages s ON s.role_id = u.role_id
       JOIN workflow_rules wr ON wr.id = s.rule_id AND wr.active = 1
      WHERE u.status = 'Active'`
  ).all());
  collect(db.prepare(
    `SELECT DISTINCT u.id
       FROM users u
       JOIN roles r ON r.id = u.role_id
       JOIN procurement_workflow_stages s ON s.role_id = u.role_id
       JOIN procurement_workflow_rules wr ON wr.id = s.rule_id AND wr.active = 1
      WHERE u.status = 'Active'`
  ).all());
  collect(db.prepare(
    `SELECT DISTINCT u.id
       FROM users u
       JOIN roles r ON r.id = u.role_id
       JOIN role_permissions rp ON rp.role_id = r.id
      WHERE u.status = 'Active' AND rp.permission_key = 'fleet.master.manage'`
  ).all());
  collect(db.prepare(
    "SELECT id FROM users WHERE status = 'Active' AND (department LIKE '%Transport%' OR department LIKE '%Admin%')"
  ).all());
  return [...ids].filter(Boolean);
}

const VEHICLE_EXPIRIES = [
  { column: 'registration_expiry_date', label: 'Registration' },
  { column: 'insurance_expiry_date', label: 'Insurance' },
  { column: 'permit_expiry_date', label: 'Permit' },
  { column: 'road_tax_expiry_date', label: 'Road tax' },
  { column: 'pollution_expiry_date', label: 'Pollution certificate' },
];

function alreadyNotified(db, userId, title, link) {
  const row = db.prepare(
    `SELECT 1 FROM notifications
      WHERE user_id = ? AND title = ? AND link = ?
        AND created_at >= datetime('now', '-1 day')`
  ).get(userId, title, link);
  return !!row;
}

function push(db, userIds, title, message, link) {
  const ids = userIds.filter((id) => !alreadyNotified(db, id, title, link));
  notify(ids, title, message, link);
  return ids.length;
}

function warrantyAlerts(db) {
  const recipients = recipientIds(db);
  let count = 0;
  for (const days of WINDOWS) {
    const cutoff = addDays(today(), days);
    const rows = db.prepare(
      `SELECT id, asset_code, asset_name AS name, warranty_end, department_id
         FROM assets
        WHERE deleted_at IS NULL
          AND status != 'disposed'
          AND warranty_end IS NOT NULL
          AND warranty_end >= ? AND warranty_end <= ?`
    ).all(today(), cutoff);
    for (const r of rows) {
      const title = `Warranty expiring in ${days} days`;
      const link = `#/assets/${r.id}`;
      const msg = `Asset ${r.asset_code} (${r.name}) warranty expires on ${r.warranty_end}.`;
      count += push(db, recipients, title, msg, link);
    }
  }
  return count;
}

function amcAlerts(db) {
  const recipients = recipientIds(db);
  let count = 0;
  for (const days of WINDOWS) {
    const cutoff = addDays(today(), days);
    const rows = db.prepare(
      `SELECT a.id, a.asset_code, a.asset_name AS name, i.amc_end_date
         FROM assets a
         JOIN item_details i ON i.item_id = a.item_id
        WHERE a.deleted_at IS NULL
          AND a.status != 'disposed'
          AND i.amc_end_date IS NOT NULL
          AND i.amc_end_date >= ? AND i.amc_end_date <= ?`
    ).all(today(), cutoff);
    for (const r of rows) {
      const title = `AMC renewal due in ${days} days`;
      const link = `#/assets/${r.id}`;
      const msg = `Asset ${r.asset_code} (${r.name}) AMC ends on ${r.amc_end_date}. Renewal required.`;
      count += push(db, recipients, title, msg, link);
    }
  }
  return count;
}

function stockReorderAlerts(db) {
  const recipients = userIdsByRole('store_incharge').concat(userIdsByRole('procurement_officer'));
  const unique = [...new Set(recipients)];
  let count = 0;
  const rows = db.prepare(
    `SELECT i.id, i.item_code, i.name, i.reorder_level,
            COALESCE(SUM(sb.quantity), 0) AS current_stock
       FROM items i
       LEFT JOIN stock_balances sb ON sb.item_id = i.id
      WHERE i.deleted_at IS NULL AND i.active = 1
        AND i.item_type = 'consumable'
        AND i.reorder_level > 0
      GROUP BY i.id
     HAVING current_stock <= i.reorder_level`
  ).all();
  for (const r of rows) {
    const title = 'Stock below reorder level';
    const link = `#/items/${r.id}`;
    const msg = `Item ${r.item_code} (${r.name}): current stock ${r.current_stock}, reorder level ${r.reorder_level}.`;
    count += push(db, unique, title, msg, link);
  }
  return count;
}

function consumableExpiryAlerts(db) {
  const recipients = userIdsByRole('store_incharge').concat(userIdsByRole('procurement_officer'));
  const unique = [...new Set(recipients)];
  let count = 0;
  // Items with expiry tracking enabled; stock ledger entries with expiry dates
  // are checked via stock_balances joined to a not-yet-existing expiry table.
  // For now we check items where expiry_tracking=1 and there is stock on hand.
  const rows = db.prepare(
    `SELECT i.id, i.item_code, i.name, d.shelf_life_days
       FROM items i
       JOIN item_details d ON d.item_id = i.id
      WHERE i.deleted_at IS NULL AND i.active = 1
        AND i.item_type = 'consumable'
        AND d.expiry_tracking = 1`
  ).all();
  // Without per-batch expiry dates we can only flag the item as needing review.
  for (const r of rows) {
    const hasStock = db.prepare(
      'SELECT COALESCE(SUM(quantity),0) AS q FROM stock_balances WHERE item_id = ?'
    ).get(r.id).q;
    if (hasStock > 0) {
      const title = 'Consumable expiry review needed';
      const link = `#/items/${r.id}`;
      const msg = `Item ${r.item_code} (${r.name}) has expiry tracking enabled with ${hasStock} units in stock. Verify expiry dates.`;
      count += push(db, unique, title, msg, link);
    }
  }
  return count;
}

function vehicleComplianceAlerts(db) {
  const recipients = vehicleRecipientIds(db);
  const current = today();
  let count = 0;
  for (const item of VEHICLE_EXPIRIES) {
    const expired = db.prepare(
      `SELECT id, reg_no, ${item.column} AS expiry
         FROM fleet_vehicles
        WHERE deleted_at IS NULL AND ${item.column} IS NOT NULL AND ${item.column} < ?`
    ).all(current);
    for (const r of expired) {
      const title = `${r.reg_no} ${item.label} expired`;
      const link = `#/fleet/masters?model=vehicles&vehicleId=${r.id}`;
      const msg = `Vehicle ${r.reg_no} ${item.label.toLowerCase()} expired on ${r.expiry}. Renew and update the vehicle master.`;
      count += push(db, recipients, title, msg, link);
    }

    let lower = current;
    for (const days of WINDOWS) {
      const upper = addDays(current, days);
      const rows = db.prepare(
        `SELECT id, reg_no, ${item.column} AS expiry
           FROM fleet_vehicles
          WHERE deleted_at IS NULL AND ${item.column} > ? AND ${item.column} <= ?`
      ).all(lower, upper);
      for (const r of rows) {
        const title = `${r.reg_no} ${item.label} expiring in ${days} days`;
        const link = `#/fleet/masters?model=vehicles&vehicleId=${r.id}`;
        const msg = `Vehicle ${r.reg_no} ${item.label.toLowerCase()} expires on ${r.expiry}. Renew before the expiry date.`;
        count += push(db, recipients, title, msg, link);
      }
      lower = upper;
    }
  }
  return count;
}

function runAll(db) {
  return {
    warranty: warrantyAlerts(db),
    amc: amcAlerts(db),
    stock: stockReorderAlerts(db),
    expiry: consumableExpiryAlerts(db),
    vehicle: vehicleComplianceAlerts(db),
  };
}

module.exports = {
  runAll, warrantyAlerts, amcAlerts, stockReorderAlerts, consumableExpiryAlerts, vehicleComplianceAlerts,
};