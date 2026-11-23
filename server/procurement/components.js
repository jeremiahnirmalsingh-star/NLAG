'use strict';

/**
 * Parent/child asset components — additive helper.
 *
 * An asset-type item can define a component template (for example, a computer
 * system includes a mouse, keyboard, motherboard and RAM). Each asset created
 * from that item gets its own component rows, with a maintained quantity per
 * component. Existing items and assets are untouched until a user saves a
 * component list or a GRN creates a new asset.
 */

const { badRequest, round2 } = require('../util');

const MAX_COMPONENTS = 100;

function optionalText(value, field, max = 200) {
  return String(value ?? '').trim().slice(0, max);
}

function validateComponents(db, list, { parentItemId = null } = {}) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) throw badRequest('Components must be a list.');
  if (list.length > MAX_COMPONENTS) {
    throw badRequest(`An asset can include at most ${MAX_COMPONENTS} component rows.`);
  }

  const seen = new Set();
  return list.map((row, index) => {
    const source = row && typeof row === 'object' ? row : {};
    const componentItemId = Number(source.componentItemId ?? source.itemId);
    if (!Number.isInteger(componentItemId) || componentItemId <= 0) {
      throw badRequest(`Component ${index + 1}: select an item.`);
    }
    if (parentItemId && componentItemId === Number(parentItemId)) {
      throw badRequest('An item cannot include itself as a component.');
    }
    if (seen.has(componentItemId)) {
      throw badRequest(`Component ${index + 1}: this item is listed more than once.`);
    }
    seen.add(componentItemId);

    const item = db
      .prepare(
        `SELECT id, item_code, name, item_type FROM items
          WHERE id = ? AND deleted_at IS NULL AND active = 1`
      )
      .get(componentItemId);
    if (!item) throw badRequest(`Component ${index + 1}: item was not found.`);
    if (!['asset', 'consumable'].includes(item.item_type)) {
      throw badRequest(`Component ${index + 1}: service items cannot be used as components.`);
    }

    const quantity = Number(source.quantity === undefined || source.quantity === '' ? 1 : source.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw badRequest(`Component ${index + 1}: quantity must be greater than zero.`);
    }

    return {
      componentItemId,
      itemCode: item.item_code,
      itemName: item.name,
      itemType: item.item_type,
      quantity: round2(quantity),
      serialNo: optionalText(source.serialNo, 'serialNo', 200),
      notes: optionalText(source.notes, 'notes', 500),
      active: 1,
    };
  });
}

function readItemComponents(db, parentItemId) {
  if (!parentItemId) return [];
  return db
    .prepare(
      `SELECT c.id, c.component_item_id, c.quantity, c.notes, c.active,
              i.item_code, i.name AS item_name, i.item_type, u.code AS uom_code, u.name AS uom_name
         FROM item_components c
         JOIN items i ON i.id = c.component_item_id
         LEFT JOIN uoms u ON u.id = i.uom_id
        WHERE c.parent_item_id = ? AND c.active = 1
        ORDER BY i.name COLLATE NOCASE ASC, c.id ASC`
    )
    .all(parentItemId)
    .map((row) => ({
      id: row.id,
      componentItemId: row.component_item_id,
      itemCode: row.item_code || '',
      itemName: row.item_name || '',
      itemType: row.item_type,
      uomCode: row.uom_code || '',
      uomName: row.uom_name || '',
      quantity: row.quantity,
      notes: row.notes || '',
      active: !!row.active,
    }));
}

function readAssetComponents(db, parentAssetId) {
  if (!parentAssetId) return [];
  return db
    .prepare(
      `SELECT c.id, c.component_item_id, c.quantity, c.serial_no, c.notes, c.active,
              i.item_code, i.name AS item_name, i.item_type, u.code AS uom_code, u.name AS uom_name
         FROM asset_components c
         JOIN items i ON i.id = c.component_item_id
         LEFT JOIN uoms u ON u.id = i.uom_id
        WHERE c.parent_asset_id = ? AND c.active = 1
        ORDER BY i.name COLLATE NOCASE ASC, c.id ASC`
    )
    .all(parentAssetId)
    .map((row) => ({
      id: row.id,
      componentItemId: row.component_item_id,
      itemCode: row.item_code || '',
      itemName: row.item_name || '',
      itemType: row.item_type,
      uomCode: row.uom_code || '',
      uomName: row.uom_name || '',
      quantity: row.quantity,
      serialNo: row.serial_no || '',
      notes: row.notes || '',
      active: !!row.active,
    }));
}

function saveItemComponents(db, parentItemId, rows, now) {
  const list = Array.isArray(rows) ? rows : [];
  const upsert = db.prepare(
    `INSERT INTO item_components(parent_item_id, component_item_id, quantity, notes, active, created_at, updated_at)
     VALUES (?,?,?,?,1,?,?)
     ON CONFLICT(parent_item_id, component_item_id) DO UPDATE SET
       quantity = excluded.quantity,
       notes = excluded.notes,
       active = 1,
       updated_at = excluded.updated_at`
  );
  for (const row of list) {
    upsert.run(parentItemId, row.componentItemId, row.quantity, row.notes || null, now, now);
  }
  const ids = list.map((row) => row.componentItemId);
  if (ids.length) {
    db.prepare(
      `UPDATE item_components SET active = 0, updated_at = ?
        WHERE parent_item_id = ? AND component_item_id NOT IN (${ids.map(() => '?').join(',')})`
    ).run(now, parentItemId, ...ids);
  } else {
    db.prepare('UPDATE item_components SET active = 0, updated_at = ? WHERE parent_item_id = ?')
      .run(now, parentItemId);
  }
}

function saveAssetComponents(db, parentAssetId, rows, now) {
  const list = Array.isArray(rows) ? rows : [];
  const upsert = db.prepare(
    `INSERT INTO asset_components(parent_asset_id, component_item_id, quantity, serial_no, notes, active, created_at, updated_at)
     VALUES (?,?,?,?,?,1,?,?)
     ON CONFLICT(parent_asset_id, component_item_id) DO UPDATE SET
       quantity = excluded.quantity,
       serial_no = excluded.serial_no,
       notes = excluded.notes,
       active = 1,
       updated_at = excluded.updated_at`
  );
  for (const row of list) {
    upsert.run(
      parentAssetId, row.componentItemId, row.quantity,
      row.serialNo || null, row.notes || null, now, now
    );
  }
  const ids = list.map((row) => row.componentItemId);
  if (ids.length) {
    db.prepare(
      `UPDATE asset_components SET active = 0, updated_at = ?
        WHERE parent_asset_id = ? AND component_item_id NOT IN (${ids.map(() => '?').join(',')})`
    ).run(now, parentAssetId, ...ids);
  } else {
    db.prepare('UPDATE asset_components SET active = 0, updated_at = ? WHERE parent_asset_id = ?')
      .run(now, parentAssetId);
  }
}

function copyItemComponentsToAsset(db, assetId, itemId, now) {
  if (!assetId || !itemId) return [];
  const rows = db
    .prepare(
      `SELECT component_item_id, quantity, notes FROM item_components
        WHERE parent_item_id = ? AND active = 1 ORDER BY id`
    )
    .all(itemId);
  if (!rows.length) return [];

  const insert = db.prepare(
    `INSERT INTO asset_components(parent_asset_id, component_item_id, quantity, serial_no, notes, active, created_at, updated_at)
     VALUES (?,?,?,NULL,?,1,?,?)
     ON CONFLICT(parent_asset_id, component_item_id) DO NOTHING`
  );
  for (const row of rows) {
    insert.run(assetId, row.component_item_id, row.quantity, row.notes || null, now, now);
  }
  return readAssetComponents(db, assetId);
}

function auditSummary(rows) {
  const list = Array.isArray(rows) ? rows : [];
  return {
    componentCount: list.length,
    componentQuantity: round2(list.reduce((sum, row) => sum + (Number(row?.quantity) || 0), 0)),
  };
}

function componentItemOptions(db) {
  return db
    .prepare(
      `SELECT id, item_code, name, item_type FROM items
        WHERE deleted_at IS NULL AND active = 1 AND item_type IN ('asset','consumable')
        ORDER BY name COLLATE NOCASE`
    )
    .all()
    .map((row) => ({
      id: row.id,
      code: row.item_code,
      name: row.name,
      itemType: row.item_type,
    }));
}

module.exports = {
  validateComponents,
  readItemComponents,
  readAssetComponents,
  saveItemComponents,
  saveAssetComponents,
  copyItemComponentsToAsset,
  auditSummary,
  componentItemOptions,
};
