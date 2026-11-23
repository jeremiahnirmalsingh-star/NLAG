'use strict';

/**
 * Alert / notification engine — Phase 5d.
 *
 * Generates in-app notifications for:
 *   - Warranty expiry (assets whose warranty_end falls within N days)
 *   - AMC renewal (assets whose amc_end_date falls within N days)
 *   - Stock reorder (items whose total stock balance < reorder_level)
 *   - Consumable expiry (items with expiry_tracking and stock with expiry within N days)
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

function runAll(db) {
  return {
    warranty: warrantyAlerts(db),
    amc: amcAlerts(db),
    stock: stockReorderAlerts(db),
    expiry: consumableExpiryAlerts(db),
  };
}

module.exports = { runAll, warrantyAlerts, amcAlerts, stockReorderAlerts, consumableExpiryAlerts };