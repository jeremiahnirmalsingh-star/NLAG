'use strict';

/**
 * Shared asset helpers — Phase 2.
 *
 * Additive only. These helpers are used by the asset routes and by the GRN and
 * invoice routes so received asset items become asset register entries without
 * duplicating business rules.
 */

const { nowIso, nextAssetCode } = require('../util');
const assetSettings = require('./asset-settings');
const components = require('./components');

function addMonths(isoDate, months) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + months);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

function assetDetailUrl(db, assetId) {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'public_base_url'").get();
  const base = String(row?.value || '').replace(/\/$/, '');
  return `${base}/#/assets/${assetId}`;
}

function createAssetsForGrn(db, grnId, createdBy = null) {
  const grn = db
    .prepare(
      `SELECT g.id, g.po_id, g.unit_id, g.store_id, g.received_date, u.code AS unit_code
         FROM grns g JOIN units u ON u.id = g.unit_id
        WHERE g.id = ?`
    )
    .get(Number(grnId));
  if (!grn) return [];

  const lines = db
    .prepare(
      `SELECT gi.id AS grn_item_id, gi.po_item_id, gi.item_id, gi.accepted_quantity, gi.unit_price,
              gi.bin_id, i.name AS item_name, i.category_id,
              p.department_id, p.vendor_id,
              ad.model_no AS asset_model_no, ad.manufacturer AS asset_manufacturer,
              ad.serial_numbers AS asset_serial_numbers, ad.warranty_start AS asset_warranty_start,
              ad.warranty_end AS asset_warranty_end, ad.condition AS asset_condition,
              ad.remarks AS asset_remarks
         FROM grn_items gi
         JOIN items i ON i.id = gi.item_id
         JOIN purchase_orders p ON p.id = ?
         LEFT JOIN grn_item_asset_details ad ON ad.grn_item_id = gi.id
        WHERE gi.grn_id = ? AND gi.accepted_quantity > 0.004 AND i.item_type = 'asset'
        ORDER BY gi.id`
    )
    .all(grn.po_id, grn.id);

  const created = [];
  const now = nowIso();
  const purchaseDate = grn.received_date || now.slice(0, 10);
  const year = Number(String(purchaseDate).slice(0, 4)) || new Date().getFullYear();
  const insert = db.prepare(
    `INSERT INTO assets(asset_code, asset_name, item_id, category_id, unit_id, department_id,
       store_id, bin_id, vendor_id, po_id, po_item_id, grn_id, grn_item_id, serial_no, model_no,
       manufacturer, purchase_date, purchase_value, warranty_start, warranty_end, condition,
       remarks, status, created_by, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'created', ?, ?, ?)`
  );
  const setLabel = db.prepare('UPDATE assets SET qr_payload = ?, barcode_value = ? WHERE id = ?');

  for (const line of lines) {
    const existing = db
      .prepare('SELECT COUNT(*) AS c FROM assets WHERE grn_item_id = ?')
      .get(line.grn_item_id).c;
    const wanted = Math.max(1, Math.round(Number(line.accepted_quantity) || 0));
    const settings = assetSettings.resolveAssetSettings(db, line.item_id)?.effective || {};
    const departmentId = line.department_id || settings.defaultDepartmentId || null;
    const warrantyMonths = Number(settings.warrantyMonths) || 0;
    const warrantyStart = line.asset_warranty_start || (warrantyMonths > 0 ? purchaseDate : null);
    const warrantyEnd = line.asset_warranty_end
      || (warrantyStart && warrantyMonths > 0 ? addMonths(warrantyStart, warrantyMonths) : null);
    const serials = String(line.asset_serial_numbers || '')
      .split(/[\n,;]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    for (let index = Number(existing); index < wanted; index += 1) {
      const code = nextAssetCode(grn.unit_code || 'UNIT');
      const res = insert.run(
        code, line.item_name, line.item_id, line.category_id, grn.unit_id, departmentId,
        grn.store_id, line.bin_id, line.vendor_id, grn.po_id, line.po_item_id, grn.id,
        line.grn_item_id, serials[index] || null, line.asset_model_no || null,
        line.asset_manufacturer || null, purchaseDate, Number(line.unit_price) || 0,
        warrantyStart, warrantyEnd,
        line.asset_condition || null, line.asset_remarks || null, createdBy, now, now
      );
      const assetId = Number(res.lastInsertRowid);
      setLabel.run(assetDetailUrl(db, assetId), code, assetId);
      components.copyItemComponentsToAsset(db, assetId, line.item_id, now);
      created.push(assetId);
    }
  }
  return created;
}

function ensureAssetsForInvoice(db, invoiceId, createdBy = null) {
  const invoice = db.prepare('SELECT id FROM invoices WHERE id = ?').get(Number(invoiceId));
  if (!invoice) return [];
  const grnRows = db
    .prepare(
      `SELECT DISTINCT gi.grn_id AS grn_id
         FROM invoice_items ii
         JOIN grn_items gi ON gi.id = ii.grn_item_id
         JOIN items i ON i.id = gi.item_id
        WHERE ii.invoice_id = ? AND i.item_type = 'asset'`
    )
    .all(invoice.id);

  const created = [];
  for (const row of grnRows) created.push(...createAssetsForGrn(db, row.grn_id, createdBy));

  db.prepare(
    `UPDATE assets SET invoice_id = ?, updated_at = ?
      WHERE invoice_id IS NULL AND grn_item_id IN (
        SELECT ii.grn_item_id FROM invoice_items ii
         WHERE ii.invoice_id = ? AND ii.grn_item_id IS NOT NULL
      )`
  ).run(invoice.id, nowIso(), invoice.id);
  return created;
}

module.exports = {
  assetDetailUrl,
  createAssetsForGrn,
  ensureAssetsForInvoice,
};
