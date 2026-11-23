'use strict';

/**
 * Asset lifecycle — Phase 2.
 *
 * Additive only. Every business record is kept; assets are retired with a soft
 * delete and disposal is controlled by a separate approval step.
 */

const auth = require('../auth');
const { HttpError } = require('../http');
const {
  audit, notify, nowIso, today, round2, nextAssetCode,
} = require('../util');
const {
  unitScope, inList, requireText, optionalText, optionalId, optionalDate,
  ensureUnit, transaction, pageParams, rowOr404,
} = require('../procurement/shared');
const components = require('../procurement/components');

const ASSET_STATUSES = [
  'ordered', 'received', 'created', 'allocated', 'in_use',
  'under_maintenance', 'under_repair', 'transferred', 'missing', 'disposed',
];
const MAINTENANCE_TYPES = ['preventive', 'corrective', 'inspection', 'calibration', 'other'];
const MAINTENANCE_STATUSES = ['scheduled', 'in_progress', 'completed', 'cancelled'];
const DISPOSAL_METHODS = ['sale', 'scrap', 'donation', 'write_off', 'return_to_vendor', 'other'];

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */
function codeLabel(value) {
  return String(value || '').replace(/_/g, ' ');
}

function assetBaseUrl(ctx) {
  const row = ctx.db.prepare("SELECT value FROM settings WHERE key = 'public_base_url'").get();
  const fallback = `${ctx.req?.headers?.['x-forwarded-proto'] || 'http'}://${ctx.req?.headers?.host || 'localhost'}`;
  return String(row?.value || fallback).replace(/\/+$/, '');
}

function assetQrPayload(ctx, assetId) {
  return `${assetBaseUrl(ctx)}/#/assets/${assetId}`;
}

function assetOut(row) {
  return {
    id: row.id,
    assetCode: row.asset_code,
    assetName: row.asset_name,
    itemId: row.item_id,
    itemCode: row.item_code || '',
    itemName: row.item_name || '',
    categoryId: row.category_id,
    categoryName: row.category_name || '',
    unitId: row.unit_id,
    unitCode: row.unit_code || '',
    unitName: row.unit_name || '',
    departmentId: row.department_id,
    departmentName: row.department_name || '',
    storeId: row.store_id,
    storeName: row.store_name || '',
    binId: row.bin_id,
    binName: row.bin_name || '',
    roomId: row.room_id,
    roomName: row.room_name || '',
    custodianEmployeeId: row.custodian_employee_id,
    custodianName: row.custodian_name || '',
    vendorId: row.vendor_id,
    vendorName: row.vendor_name || '',
    poId: row.po_id,
    poNo: row.po_no || '',
    grnId: row.grn_id,
    grnNo: row.grn_no || '',
    invoiceId: row.invoice_id,
    invoiceNo: row.invoice_no || '',
    serialNo: row.serial_no || '',
    modelNo: row.model_no || '',
    manufacturer: row.manufacturer || '',
    purchaseDate: row.purchase_date,
    purchaseValue: round2(row.purchase_value),
    warrantyStart: row.warranty_start,
    warrantyEnd: row.warranty_end,
    status: row.status,
    statusLabel: codeLabel(row.status),
    condition: row.condition || '',
    qrPayload: row.qr_payload || '',
    barcodeValue: row.barcode_value || row.asset_code,
    remarks: row.remarks || '',
    insurancePolicyNo: row.insurance_policy_no || '',
    insurer: row.insurer || '',
    insurancePremium: round2(row.insurance_premium),
    insuranceExpiryDate: row.insurance_expiry_date || '',
    insuranceRemarks: row.insurance_remarks || '',
    createdBy: row.created_by,
    createdByName: row.created_by_name || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const ASSET_SELECT = `
  SELECT a.*, i.item_code, i.name AS item_name, c.name AS category_name,
         u.code AS unit_code, u.name AS unit_name, d.name AS department_name,
         s.name AS store_name, b.name AS bin_name, r.name AS room_name,
         e.name AS custodian_name, v.name AS vendor_name,
         p.po_no, g.grn_no, inv.invoice_no, cu.name AS created_by_name
    FROM assets a
    JOIN units u ON u.id = a.unit_id
    LEFT JOIN items i ON i.id = a.item_id
    LEFT JOIN item_categories c ON c.id = a.category_id
    LEFT JOIN departments d ON d.id = a.department_id
    LEFT JOIN stores s ON s.id = a.store_id
    LEFT JOIN bins b ON b.id = a.bin_id
    LEFT JOIN rooms r ON r.id = a.room_id
    LEFT JOIN employees e ON e.id = a.custodian_employee_id
    LEFT JOIN vendors v ON v.id = a.vendor_id
    LEFT JOIN purchase_orders p ON p.id = a.po_id
    LEFT JOIN grns g ON g.id = a.grn_id
    LEFT JOIN invoices inv ON inv.id = a.invoice_id
    LEFT JOIN users cu ON cu.id = a.created_by
`;

function getAsset(ctx, id) {
  const ids = unitScope(ctx);
  return rowOr404(
    ctx.db
      .prepare(`${ASSET_SELECT} WHERE a.id = ? AND a.deleted_at IS NULL AND a.unit_id IN (${inList(ids)})`)
      .get(Number(id), ...ids),
    'Asset not found.'
  );
}

function activeAllocation(db, assetId) {
  return db
    .prepare('SELECT * FROM asset_allocations WHERE asset_id = ? AND returned_at IS NULL ORDER BY id DESC LIMIT 1')
    .get(assetId);
}

function restingStatus(db, assetId) {
  return activeAllocation(db, assetId) ? 'allocated' : 'created';
}

function unitRoomId(db, roomId) {
  if (!roomId) return null;
  const row = db
    .prepare(
      `SELECT br.unit_id
         FROM rooms rm
         JOIN floors f ON f.id = rm.floor_id
         JOIN buildings bd ON bd.id = f.building_id
         JOIN campuses cp ON cp.id = bd.campus_id
         JOIN branches br ON br.id = cp.branch_id
        WHERE rm.id = ?`
    )
    .get(roomId);
  return row ? Number(row.unit_id) : null;
}

function ensureStore(ctx, unitId, storeId) {
  if (!storeId) return null;
  const row = ctx.db
    .prepare('SELECT id, unit_id FROM stores WHERE id = ? AND deleted_at IS NULL')
    .get(storeId);
  if (!row) throw new HttpError(400, 'Selected store does not exist.');
  if (Number(row.unit_id) !== Number(unitId)) {
    throw new HttpError(400, 'The store belongs to a different unit.');
  }
  return storeId;
}

function ensureBin(ctx, storeId, binId) {
  if (!binId) return null;
  const row = ctx.db.prepare('SELECT id, store_id FROM bins WHERE id = ?').get(binId);
  if (!row) throw new HttpError(400, 'Selected bin does not exist.');
  if (storeId && Number(row.store_id) !== Number(storeId)) {
    throw new HttpError(400, 'The bin does not belong to the selected store.');
  }
  return binId;
}

function ensureRoom(ctx, unitId, roomId) {
  if (!roomId) return null;
  const roomUnit = unitRoomId(ctx.db, roomId);
  if (!roomUnit) throw new HttpError(400, 'Selected room does not exist.');
  if (roomUnit !== Number(unitId)) {
    throw new HttpError(400, 'The room belongs to a different unit.');
  }
  return roomId;
}

function ensureDepartment(ctx, departmentId) {
  if (!departmentId) return null;
  const row = ctx.db.prepare('SELECT id FROM departments WHERE id = ?').get(departmentId);
  if (!row) throw new HttpError(400, 'Selected department does not exist.');
  return departmentId;
}

function ensureEmployee(ctx, employeeId) {
  if (!employeeId) return null;
  const row = ctx.db
    .prepare("SELECT id, name, department_id FROM employees WHERE id = ? AND deleted_at IS NULL AND status = 'Active'")
    .get(employeeId);
  if (!row) throw new HttpError(400, 'Selected employee is not an active employee.');
  return row;
}

function ensureVendorRef(ctx, vendorId) {
  if (!vendorId) return null;
  const row = ctx.db.prepare('SELECT id FROM vendors WHERE id = ?').get(vendorId);
  if (!row) throw new HttpError(400, 'Selected vendor does not exist.');
  return vendorId;
}

function ensureCategory(ctx, categoryId, itemType) {
  if (!categoryId) return null;
  const row = ctx.db.prepare('SELECT id, item_type FROM item_categories WHERE id = ?').get(categoryId);
  if (!row) throw new HttpError(400, 'Selected asset category does not exist.');
  if (row.item_type !== 'asset') {
    throw new HttpError(400, 'The selected category is not an asset category.');
  }
  if (itemType && itemType !== 'asset') {
    throw new HttpError(400, 'Only items of type asset can be registered as assets.');
  }
  return categoryId;
}

function ensureItem(ctx, itemId) {
  if (!itemId) return null;
  const row = ctx.db
    .prepare("SELECT id, category_id, name FROM items WHERE id = ? AND deleted_at IS NULL AND item_type = 'asset'")
    .get(itemId);
  if (!row) throw new HttpError(400, 'Selected item is not an asset item.');
  return row;
}

function assetPayload(ctx, body, existing) {
  const source = body || {};
  const pick = (field, fallback) => (source[field] === undefined ? fallback : source[field]);

  const unitId = existing ? existing.unit_id : ensureUnit(ctx, requireText(source, 'unitId', 'Unit', 20));
  const itemId = optionalId({ itemId: pick('itemId', existing?.item_id) }, 'itemId');
  const item = ensureItem(ctx, itemId);
  const categoryId = ensureCategory(
    ctx,
    optionalId({ categoryId: pick('categoryId', existing?.category_id ?? item?.category_id) }, 'categoryId'),
    item ? 'asset' : 'asset'
  );
  if (!item && !categoryId) throw new HttpError(400, 'An asset category is required.');

  const departmentId = ensureDepartment(ctx, optionalId({ departmentId: pick('departmentId', existing?.department_id) }, 'departmentId'));
  const storeId = ensureStore(ctx, unitId, optionalId({ storeId: pick('storeId', existing?.store_id) }, 'storeId'));
  const binId = ensureBin(ctx, storeId, optionalId({ binId: pick('binId', existing?.bin_id) }, 'binId'));
  const roomId = ensureRoom(ctx, unitId, optionalId({ roomId: pick('roomId', existing?.room_id) }, 'roomId'));
  const vendorId = ensureVendorRef(ctx, optionalId({ vendorId: pick('vendorId', existing?.vendor_id) }, 'vendorId'));

  const purchaseValueRaw = pick('purchaseValue', existing?.purchase_value ?? 0);
  const purchaseValue = purchaseValueRaw === '' || purchaseValueRaw === null || purchaseValueRaw === undefined
    ? 0
    : Number(purchaseValueRaw);
  if (!Number.isFinite(purchaseValue) || purchaseValue < 0) {
    throw new HttpError(400, 'Purchase value must be zero or more.');
  }

  const status = existing
    ? existing.status
    : (['ordered', 'received', 'created'].includes(String(source.status || '')) ? String(source.status) : 'created');

  return {
    assetName: requireText({ assetName: pick('assetName', existing?.asset_name) }, 'assetName', 'Asset name', 200),
    itemId,
    categoryId,
    unitId,
    departmentId,
    storeId,
    binId,
    roomId,
    vendorId,
    serialNo: optionalText({ serialNo: pick('serialNo', existing?.serial_no) }, 'serialNo', 200),
    modelNo: optionalText({ modelNo: pick('modelNo', existing?.model_no) }, 'modelNo', 200),
    manufacturer: optionalText({ manufacturer: pick('manufacturer', existing?.manufacturer) }, 'manufacturer', 200),
    purchaseDate: optionalDate({ purchaseDate: pick('purchaseDate', existing?.purchase_date) }, 'purchaseDate', 'Purchase date')
      || existing?.purchase_date || today(),
    purchaseValue: round2(purchaseValue),
    warrantyStart: optionalDate({ warrantyStart: pick('warrantyStart', existing?.warranty_start) }, 'warrantyStart', 'Warranty start'),
    warrantyEnd: optionalDate({ warrantyEnd: pick('warrantyEnd', existing?.warranty_end) }, 'warrantyEnd', 'Warranty end'),
    condition: optionalText({ condition: pick('condition', existing?.condition) }, 'condition', 100),
    remarks: optionalText({ remarks: pick('remarks', existing?.remarks) }, 'remarks', 1000),
    insurancePolicyNo: optionalText({ insurancePolicyNo: pick('insurancePolicyNo', existing?.insurance_policy_no) }, 'insurancePolicyNo', 100),
    insurer: optionalText({ insurer: pick('insurer', existing?.insurer) }, 'insurer', 200),
    insurancePremium: round2(Number(pick('insurancePremium', existing?.insurance_premium) || 0)),
    insuranceExpiryDate: optionalDate({ insuranceExpiryDate: pick('insuranceExpiryDate', existing?.insurance_expiry_date) }, 'insuranceExpiryDate', 'Insurance expiry'),
    insuranceRemarks: optionalText({ insuranceRemarks: pick('insuranceRemarks', existing?.insurance_remarks) }, 'insuranceRemarks', 1000),
    status,
  };
}

function writeLabels(ctx, assetId, labelType) {
  const now = nowIso();
  ctx.db
    .prepare(
      'INSERT INTO asset_labels(asset_id, label_type, printed_at, printed_by, created_at) VALUES (?,?,?,?,?)'
    )
    .run(assetId, labelType, now, ctx.user.id, now);
}

function labelOut(ctx, asset) {
  const payload = assetQrPayload(ctx, asset.id);
  ctx.db
    .prepare('UPDATE assets SET qr_payload = ?, barcode_value = ?, updated_at = ? WHERE id = ?')
    .run(payload, asset.asset_code, nowIso(), asset.id);
  return {
    assetId: asset.id,
    assetCode: asset.asset_code,
    assetName: asset.asset_name,
    categoryName: asset.category_name || '',
    unitName: asset.unit_name || '',
    custodianName: asset.custodian_name || '',
    qrPayload: payload,
    barcodeValue: asset.asset_code,
    labelType: 'both',
  };
}

function approverUserIds(ctx) {
  return ctx.db
    .prepare(
      `SELECT DISTINCT u.id FROM users u
         JOIN role_permissions rp ON rp.role_id = u.role_id
        WHERE rp.permission_key = 'asset.approve' AND u.status = 'Active'`
    )
    .all()
    .map((row) => row.id);
}

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */
module.exports = function registerProcurementAssetRoutes(router) {
  /* ----------------------------- Meta ------------------------------ */
  router.get('/api/procurement/assets/meta', async (ctx) => {
    auth.guard(ctx.user, 'asset.view');
    const ids = unitScope(ctx);
    const ph = inList(ids);

    const units = ctx.db
      .prepare(`SELECT id, code, name FROM units WHERE id IN (${ph}) ORDER BY name COLLATE NOCASE`)
      .all(...ids)
      .map((row) => ({ id: row.id, code: row.code, name: row.name }));

    const departments = ctx.db
      .prepare('SELECT id, name FROM departments WHERE active = 1 ORDER BY name COLLATE NOCASE')
      .all();

    const categories = ctx.db
      .prepare("SELECT id, code, name FROM item_categories WHERE item_type = 'asset' AND active = 1 ORDER BY name COLLATE NOCASE")
      .all()
      .map((row) => ({ id: row.id, code: row.code || '', name: row.name }));

    const items = ctx.db
      .prepare(
        `SELECT id, item_code, name, category_id FROM items
          WHERE item_type = 'asset' AND deleted_at IS NULL AND active = 1
          ORDER BY name COLLATE NOCASE`
      )
      .all()
      .map((row) => ({ id: row.id, code: row.item_code, name: row.name, categoryId: row.category_id }));

    const stores = ctx.db
      .prepare(
        `SELECT s.id, s.unit_id, s.code, s.name FROM stores s
          WHERE s.deleted_at IS NULL AND s.active = 1 AND s.unit_id IN (${ph})
          ORDER BY s.name COLLATE NOCASE`
      )
      .all(...ids)
      .map((row) => ({ id: row.id, unitId: row.unit_id, code: row.code, name: row.name }));

    const bins = ctx.db
      .prepare(
        `SELECT b.id, b.store_id, b.code, b.name FROM bins b
          JOIN stores s ON s.id = b.store_id
         WHERE s.deleted_at IS NULL AND s.unit_id IN (${ph})
         ORDER BY b.name COLLATE NOCASE`
      )
      .all(...ids)
      .map((row) => ({ id: row.id, storeId: row.store_id, code: row.code, name: row.name }));

    const rooms = ctx.db
      .prepare(
        `SELECT rm.id, rm.code, rm.name, rm.room_type, br.unit_id
           FROM rooms rm
           JOIN floors f ON f.id = rm.floor_id
           JOIN buildings bd ON bd.id = f.building_id
           JOIN campuses cp ON cp.id = bd.campus_id
           JOIN branches br ON br.id = cp.branch_id
          WHERE rm.deleted_at IS NULL AND rm.active = 1 AND br.unit_id IN (${ph})
          ORDER BY rm.name COLLATE NOCASE`
      )
      .all(...ids)
      .map((row) => ({ id: row.id, unitId: row.unit_id, code: row.code, name: row.name, roomType: row.room_type || '' }));

    const employees = ctx.db
      .prepare(
        `SELECT id, employee_code, name, department_id, unit_id FROM employees
          WHERE deleted_at IS NULL AND status = 'Active' AND (unit_id IS NULL OR unit_id IN (${ph}))
          ORDER BY name COLLATE NOCASE`
      )
      .all(...ids)
      .map((row) => ({
        id: row.id, code: row.employee_code, name: row.name,
        departmentId: row.department_id, unitId: row.unit_id,
      }));

    const vendors = ctx.db
      .prepare("SELECT id, code, name FROM vendors WHERE status <> 'Blacklisted' ORDER BY name COLLATE NOCASE")
      .all()
      .map((row) => ({ id: row.id, code: row.code, name: row.name }));

    const statusCounts = ctx.db
      .prepare(`SELECT status, COUNT(*) AS total FROM assets WHERE deleted_at IS NULL AND unit_id IN (${ph}) GROUP BY status`)
      .all(...ids);
    const componentItems = components.componentItemOptions(ctx.db);

    return {
      units,
      departments,
      categories,
      items,
      componentItems,
      stores,
      bins,
      rooms,
      employees,
      vendors,
      statuses: ASSET_STATUSES.map((value) => ({ value, label: codeLabel(value) })),
      maintenanceTypes: MAINTENANCE_TYPES.map((value) => ({ value, label: codeLabel(value) })),
      maintenanceStatuses: MAINTENANCE_STATUSES.map((value) => ({ value, label: codeLabel(value) })),
      disposalMethods: DISPOSAL_METHODS.map((value) => ({ value, label: codeLabel(value) })),
      statusCounts: Object.fromEntries(statusCounts.map((row) => [row.status, Number(row.total)])),
      today: today(),
    };
  });

  /* ----------------------------- List ------------------------------ */
  router.get('/api/procurement/assets', async (ctx) => {
    auth.guard(ctx.user, 'asset.view');
    const ids = unitScope(ctx);
    const q = ctx.query || {};
    const where = ['a.deleted_at IS NULL', `a.unit_id IN (${inList(ids)})`];
    const params = [...ids];

    if (q.search) {
      const like = `%${String(q.search).trim()}%`;
      where.push(`(a.asset_code LIKE ? OR a.asset_name LIKE ? OR a.serial_no LIKE ?
                   OR i.item_code LIKE ? OR i.name LIKE ? OR e.name LIKE ?)`);
      params.push(like, like, like, like, like, like);
    }
    if (q.status && ASSET_STATUSES.includes(String(q.status))) {
      where.push('a.status = ?');
      params.push(String(q.status));
    }
    if (q.unitId) {
      where.push('a.unit_id = ?');
      params.push(Number(q.unitId));
    }
    if (q.categoryId) {
      where.push('a.category_id = ?');
      params.push(Number(q.categoryId));
    }
    if (q.itemId) {
      where.push('a.item_id = ?');
      params.push(Number(q.itemId));
    }
    if (q.departmentId) {
      where.push('a.department_id = ?');
      params.push(Number(q.departmentId));
    }
    if (q.custodianEmployeeId) {
      where.push('a.custodian_employee_id = ?');
      params.push(Number(q.custodianEmployeeId));
    }
    if (q.storeId) {
      where.push('a.store_id = ?');
      params.push(Number(q.storeId));
    }

    const from = `FROM assets a
      LEFT JOIN items i ON i.id = a.item_id
      LEFT JOIN item_categories c ON c.id = a.category_id
      LEFT JOIN departments d ON d.id = a.department_id
      LEFT JOIN employees e ON e.id = a.custodian_employee_id`;

    const summary = ctx.db
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN a.status = 'allocated' THEN 1 ELSE 0 END) AS allocated,
                SUM(CASE WHEN a.status = 'in_use' THEN 1 ELSE 0 END) AS in_use,
                SUM(CASE WHEN a.status = 'under_maintenance' THEN 1 ELSE 0 END) AS under_maintenance,
                SUM(CASE WHEN a.status = 'under_repair' THEN 1 ELSE 0 END) AS under_repair,
                SUM(CASE WHEN a.status = 'missing' THEN 1 ELSE 0 END) AS missing,
                SUM(CASE WHEN a.status = 'disposed' THEN 1 ELSE 0 END) AS disposed,
                COALESCE(SUM(CASE WHEN a.status <> 'disposed' THEN a.purchase_value ELSE 0 END), 0) AS active_value
           ${from} WHERE ${where.join(' AND ')}`
      )
      .get(...params);

    const { page, pageSize, offset } = pageParams(q);
    const rows = ctx.db
      .prepare(`${ASSET_SELECT} WHERE ${where.join(' AND ')} ORDER BY a.created_at DESC, a.id DESC LIMIT ? OFFSET ?`)
      .all(...params, pageSize, offset);

    return {
      assets: rows.map(assetOut),
      total: Number(summary.total) || 0,
      page,
      pageSize,
      summary: {
        total: Number(summary.total) || 0,
        allocated: Number(summary.allocated) || 0,
        inUse: Number(summary.in_use) || 0,
        underMaintenance: Number(summary.under_maintenance) || 0,
        underRepair: Number(summary.under_repair) || 0,
        missing: Number(summary.missing) || 0,
        disposed: Number(summary.disposed) || 0,
        activeValue: round2(summary.active_value),
      },
    };
  });

  /* --------------------------- Bulk labels ------------------------- */
  router.post('/api/procurement/assets/labels/bulk', async (ctx) => {
    auth.guard(ctx.user, 'asset.view');
    const body = ctx.body || {};
    const requested = Array.isArray(body.assetIds) ? body.assetIds : [];
    const assetIds = [...new Set(requested.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
    if (!assetIds.length) throw new HttpError(400, 'Select at least one asset to print labels.');
    if (assetIds.length > 200) throw new HttpError(400, 'Up to 200 labels can be printed at once.');

    const ids = unitScope(ctx);
    const rows = ctx.db
      .prepare(
        `${ASSET_SELECT} WHERE a.deleted_at IS NULL AND a.id IN (${inList(assetIds)})
           AND a.unit_id IN (${inList(ids)}) ORDER BY a.asset_code`
      )
      .all(...assetIds, ...ids);
    if (rows.length !== assetIds.length) throw new HttpError(400, 'One or more selected assets are not available.');

    const labels = [];
    transaction(ctx.db, () => {
      for (const row of rows) {
        labels.push(labelOut(ctx, row));
        writeLabels(ctx, row.id, 'both');
      }
    });
    audit(ctx, 'PRINT', 'asset', null, null, { count: labels.length, assetIds });
    return { labels };
  });

  /* ---------------------------- Create ----------------------------- */
  router.post('/api/procurement/assets', async (ctx) => {
    auth.guard(ctx.user, 'asset.manage');
    const body = ctx.body || {};
    const data = assetPayload(ctx, body, null);
    const componentRows = body.components === undefined
      ? null
      : components.validateComponents(ctx.db, body.components, { parentItemId: data.itemId });
    const unit = ctx.db.prepare('SELECT code FROM units WHERE id = ?').get(data.unitId);
    if (!unit) throw new HttpError(400, 'Selected unit does not exist.');
    const assetCode = nextAssetCode(unit.code);
    const now = nowIso();
    let id;
    let savedComponents = [];
    let componentSource = 'none';
    transaction(ctx.db, () => {
      const res = ctx.db
        .prepare(
          `INSERT INTO assets(asset_code, asset_name, item_id, category_id, unit_id, department_id,
             store_id, bin_id, room_id, vendor_id, serial_no, model_no, manufacturer, purchase_date,
             purchase_value, warranty_start, warranty_end, status, condition, remarks,
             created_by, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
        )
        .run(
          assetCode, data.assetName, data.itemId, data.categoryId, data.unitId, data.departmentId,
          data.storeId, data.binId, data.roomId, data.vendorId, data.serialNo, data.modelNo,
          data.manufacturer, data.purchaseDate, data.purchaseValue, data.warrantyStart,
          data.warrantyEnd, data.status, data.condition, data.remarks, ctx.user.id, now, now
        );
      id = Number(res.lastInsertRowid);
      ctx.db
        .prepare('UPDATE assets SET qr_payload = ?, barcode_value = ? WHERE id = ?')
        .run(assetQrPayload(ctx, id), assetCode, id);
      if (componentRows) {
        components.saveAssetComponents(ctx.db, id, componentRows, now);
        savedComponents = componentRows;
        componentSource = 'provided';
      } else {
        savedComponents = components.copyItemComponentsToAsset(ctx.db, id, data.itemId, now);
        componentSource = 'item-template';
      }
    });
    audit(ctx, 'CREATE', 'asset', id, null, {
      assetCode, assetName: data.assetName, unitId: data.unitId, categoryId: data.categoryId,
      componentSource,
      ...components.auditSummary(savedComponents),
    });
    return { id, assetCode, status: data.status };
  });

  /* ---------------------------- Detail ----------------------------- */
  router.get('/api/procurement/assets/:id', async (ctx) => {
    auth.guard(ctx.user, 'asset.view');
    const asset = getAsset(ctx, ctx.params.id);
    if (!asset.qr_payload || !/^https?:\/\//i.test(asset.qr_payload)) {
      asset.qr_payload = assetQrPayload(ctx, asset.id);
      ctx.db
        .prepare('UPDATE assets SET qr_payload = ?, updated_at = ? WHERE id = ?')
        .run(asset.qr_payload, nowIso(), asset.id);
    }

    const allocations = ctx.db
      .prepare(
        `SELECT al.*, e.name AS employee_name, e.employee_code, d.name AS department_name,
                s.name AS store_name, b.name AS bin_name, r.name AS room_name,
                ab.name AS allocated_by_name, rb.name AS returned_by_name
           FROM asset_allocations al
           JOIN employees e ON e.id = al.employee_id
           LEFT JOIN departments d ON d.id = al.department_id
           LEFT JOIN stores s ON s.id = al.store_id
           LEFT JOIN bins b ON b.id = al.bin_id
           LEFT JOIN rooms r ON r.id = al.room_id
           LEFT JOIN users ab ON ab.id = al.allocated_by
           LEFT JOIN users rb ON rb.id = al.returned_by
          WHERE al.asset_id = ?
          ORDER BY al.allocated_at DESC, al.id DESC`
      )
      .all(asset.id)
      .map((row) => ({
        id: row.id,
        employeeId: row.employee_id,
        employeeName: row.employee_name,
        employeeCode: row.employee_code,
        departmentName: row.department_name || '',
        storeName: row.store_name || '',
        binName: row.bin_name || '',
        roomName: row.room_name || '',
        allocatedAt: row.allocated_at,
        allocatedByName: row.allocated_by_name || '',
        returnedAt: row.returned_at,
        returnedByName: row.returned_by_name || '',
        remarks: row.remarks || '',
        active: !row.returned_at,
      }));

    const transfers = ctx.db
      .prepare(
        `SELECT t.*, fs.name AS from_store_name, ts.name AS to_store_name,
                fr.name AS from_room_name, tr.name AS to_room_name,
                fe.name AS from_custodian_name, te.name AS to_custodian_name,
                ub.name AS transferred_by_name
           FROM asset_transfers t
           LEFT JOIN stores fs ON fs.id = t.from_store_id
           LEFT JOIN stores ts ON ts.id = t.to_store_id
           LEFT JOIN rooms fr ON fr.id = t.from_room_id
           LEFT JOIN rooms tr ON tr.id = t.to_room_id
           LEFT JOIN employees fe ON fe.id = t.from_custodian_id
           LEFT JOIN employees te ON te.id = t.to_custodian_id
           LEFT JOIN users ub ON ub.id = t.transferred_by
          WHERE t.asset_id = ?
          ORDER BY t.transferred_at DESC, t.id DESC`
      )
      .all(asset.id)
      .map((row) => ({
        id: row.id,
        fromStoreName: row.from_store_name || '',
        toStoreName: row.to_store_name || '',
        fromRoomName: row.from_room_name || '',
        toRoomName: row.to_room_name || '',
        fromCustodianName: row.from_custodian_name || '',
        toCustodianName: row.to_custodian_name || '',
        transferredAt: row.transferred_at,
        transferredByName: row.transferred_by_name || '',
        reason: row.reason || '',
        remarks: row.remarks || '',
      }));

    const maintenance = ctx.db
      .prepare(
        `SELECT m.*, v.name AS vendor_name, cu.name AS created_by_name
           FROM asset_maintenance m
           LEFT JOIN vendors v ON v.id = m.vendor_id
           LEFT JOIN users cu ON cu.id = m.created_by
          WHERE m.asset_id = ?
          ORDER BY m.scheduled_date DESC, m.id DESC`
      )
      .all(asset.id)
      .map((row) => ({
        id: row.id,
        maintenanceType: row.maintenance_type,
        vendorId: row.vendor_id,
        vendorName: row.vendor_name || '',
        cost: round2(row.cost),
        scheduledDate: row.scheduled_date,
        completedDate: row.completed_date,
        status: row.status,
        description: row.description || '',
        remarks: row.remarks || '',
        createdByName: row.created_by_name || '',
        createdAt: row.created_at,
      }));

    const verifications = ctx.db
      .prepare(
        `SELECT v.*, u.name AS verified_by_name FROM asset_verifications v
           LEFT JOIN users u ON u.id = v.verified_by
          WHERE v.asset_id = ? ORDER BY v.verification_date DESC, v.id DESC`
      )
      .all(asset.id)
      .map((row) => ({
        id: row.id,
        verificationDate: row.verification_date,
        verifiedByName: row.verified_by_name || '',
        locationMatch: !!row.location_match,
        condition: row.condition || '',
        remarks: row.remarks || '',
        createdAt: row.created_at,
      }));

    const disposals = ctx.db
      .prepare(
        `SELECT d.*, rb.name AS requested_by_name, ab.name AS approved_by_name
           FROM asset_disposals d
           LEFT JOIN users rb ON rb.id = d.requested_by
           LEFT JOIN users ab ON ab.id = d.approved_by
          WHERE d.asset_id = ?
          ORDER BY d.requested_at DESC, d.id DESC`
      )
      .all(asset.id)
      .map((row) => ({
        id: row.id,
        method: row.method,
        reason: row.reason,
        status: row.status,
        requestedByName: row.requested_by_name || '',
        requestedAt: row.requested_at,
        approvedByName: row.approved_by_name || '',
        approvedAt: row.approved_at,
        disposedAt: row.disposed_at,
        rejectionReason: row.rejection_reason || '',
        remarks: row.remarks || '',
      }));

    const labels = ctx.db
      .prepare('SELECT id, label_type, printed_at FROM asset_labels WHERE asset_id = ? ORDER BY id DESC LIMIT 10')
      .all(asset.id)
      .map((row) => ({ id: row.id, labelType: row.label_type, printedAt: row.printed_at }));

    const active = allocations.find((row) => row.active) || null;
    const pendingDisposal = disposals.find((row) => row.status === 'pending') || null;
    const blocked = ['disposed'].includes(asset.status);

    return {
      asset: assetOut(asset),
      components: components.readAssetComponents(ctx.db, asset.id),
      allocations,
      transfers,
      maintenance,
      verifications,
      disposals,
      labels,
      activeAllocation: active,
      actions: {
        canEdit: !blocked && auth.can(ctx.user, 'asset.manage'),
        canDelete: ['ordered', 'received', 'created'].includes(asset.status)
          && !allocations.length && auth.can(ctx.user, 'asset.manage'),
        canAllocate: !blocked && asset.status !== 'missing' && !active && auth.can(ctx.user, 'asset.allocate'),
        canReturn: !!active && auth.can(ctx.user, 'asset.allocate'),
        canTransfer: !blocked && asset.status !== 'missing' && auth.can(ctx.user, 'asset.allocate'),
        canMaintain: !blocked && auth.can(ctx.user, 'asset.maintain'),
        canVerify: !blocked && auth.can(ctx.user, 'asset.verify'),
        canRequestDisposal: !blocked && !pendingDisposal && auth.can(ctx.user, 'asset.dispose'),
        canApproveDisposal: !!pendingDisposal && auth.can(ctx.user, 'asset.approve'),
        canPrintLabel: auth.can(ctx.user, 'asset.view'),
      },
    };
  });

  /* ---------------------------- Update ----------------------------- */
  router.put('/api/procurement/assets/:id', async (ctx) => {
    auth.guard(ctx.user, 'asset.manage');
    const asset = getAsset(ctx, ctx.params.id);
    if (asset.status === 'disposed') throw new HttpError(400, 'A disposed asset cannot be edited.');
    const body = ctx.body || {};
    const data = assetPayload(ctx, body, asset);
    const componentRows = body.components === undefined
      ? null
      : components.validateComponents(ctx.db, body.components, { parentItemId: data.itemId });
    const now = nowIso();
    transaction(ctx.db, () => {
      ctx.db
        .prepare(
          `UPDATE assets SET asset_name=?, item_id=?, category_id=?, department_id=?, store_id=?, bin_id=?,
             room_id=?, vendor_id=?, serial_no=?, model_no=?, manufacturer=?, purchase_date=?,
             purchase_value=?, warranty_start=?, warranty_end=?, condition=?, remarks=?,
             insurance_policy_no=?, insurer=?, insurance_premium=?, insurance_expiry_date=?,
             insurance_remarks=?, updated_at=?
           WHERE id=?`
        )
        .run(
          data.assetName, data.itemId, data.categoryId, data.departmentId, data.storeId, data.binId,
          data.roomId, data.vendorId, data.serialNo, data.modelNo, data.manufacturer, data.purchaseDate,
          data.purchaseValue, data.warrantyStart, data.warrantyEnd, data.condition, data.remarks,
          data.insurancePolicyNo, data.insurer, data.insurancePremium, data.insuranceExpiryDate,
          data.insuranceRemarks, now, asset.id
        );
      if (componentRows) components.saveAssetComponents(ctx.db, asset.id, componentRows, now);
    });
    audit(ctx, 'UPDATE', 'asset', asset.id, { assetName: asset.asset_name, status: asset.status }, {
      assetName: data.assetName, departmentId: data.departmentId,
      ...(componentRows ? components.auditSummary(componentRows) : {}),
    });
    return { ok: true };
  });

  /* -------------------------- Soft delete -------------------------- */
  router.delete('/api/procurement/assets/:id', async (ctx) => {
    auth.guard(ctx.user, 'asset.manage');
    const asset = getAsset(ctx, ctx.params.id);
    if (!['ordered', 'received', 'created'].includes(asset.status)) {
      throw new HttpError(400, 'Only an asset that has never been allocated can be retired.');
    }
    const allocation = ctx.db.prepare('SELECT 1 FROM asset_allocations WHERE asset_id = ?').get(asset.id);
    if (allocation) throw new HttpError(400, 'An asset with custody history cannot be retired.');
    const now = nowIso();
    ctx.db
      .prepare('UPDATE assets SET deleted_at=?, deleted_by=?, updated_at=? WHERE id=?')
      .run(now, ctx.user.id, now, asset.id);
    audit(ctx, 'DELETE', 'asset', asset.id, { assetCode: asset.asset_code, status: asset.status }, { deleted: true });
    return { ok: true };
  });

  /* --------------------------- Allocation -------------------------- */
  router.post('/api/procurement/assets/:id/allocate', async (ctx) => {
    auth.guard(ctx.user, 'asset.allocate');
    const asset = getAsset(ctx, ctx.params.id);
    if (['disposed', 'missing'].includes(asset.status)) {
      throw new HttpError(400, 'This asset cannot be allocated in its current state.');
    }
    if (activeAllocation(ctx.db, asset.id)) {
      throw new HttpError(400, 'The asset is already allocated. Record a return first.');
    }
    const body = ctx.body || {};
    const employee = ensureEmployee(ctx, Number(body.employeeId));
    if (!employee) throw new HttpError(400, 'Select the employee taking custody.');
    const departmentId = ensureDepartment(
      ctx,
      optionalId({ departmentId: body.departmentId === undefined ? employee.department_id : body.departmentId }, 'departmentId')
    );
    const storeId = ensureStore(ctx, asset.unit_id, optionalId({ storeId: body.storeId === undefined ? asset.store_id : body.storeId }, 'storeId'));
    const storeChanged = Number(storeId || 0) !== Number(asset.store_id || 0);
    const binId = ensureBin(
      ctx,
      storeId,
      optionalId({ binId: body.binId === undefined ? (storeChanged ? null : asset.bin_id) : body.binId }, 'binId')
    );
    const roomId = ensureRoom(ctx, asset.unit_id, optionalId({ roomId: body.roomId === undefined ? asset.room_id : body.roomId }, 'roomId'));
    const allocatedAt = optionalDate(body, 'allocatedAt', 'Allocation date') || today();
    const remarks = optionalText(body, 'remarks', 1000);
    const nextStatus = body.inUse === true || body.inUse === '1' ? 'in_use' : 'allocated';
    const now = nowIso();

    transaction(ctx.db, () => {
      ctx.db
        .prepare(
          `INSERT INTO asset_allocations(asset_id, employee_id, department_id, store_id, bin_id, room_id,
             allocated_at, allocated_by, remarks, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?)`
        )
        .run(asset.id, employee.id, departmentId, storeId, binId, roomId, allocatedAt, ctx.user.id, remarks, now);
      ctx.db
        .prepare(
          `UPDATE assets SET custodian_employee_id=?, department_id=?, store_id=?, bin_id=?, room_id=?,
             status=?, updated_at=? WHERE id=?`
        )
        .run(employee.id, departmentId, storeId, binId, roomId, nextStatus, now, asset.id);
    });
    notify(
      [asset.created_by],
      'Asset allocated',
      `${asset.asset_code} was allocated to ${employee.name}.`,
      `/assets/${asset.id}`
    );
    audit(ctx, 'ALLOCATE', 'asset', asset.id, { status: asset.status }, {
      status: nextStatus, employeeId: employee.id, allocatedAt,
    });
    return { ok: true, status: nextStatus };
  });

  router.post('/api/procurement/assets/:id/return', async (ctx) => {
    auth.guard(ctx.user, 'asset.allocate');
    const asset = getAsset(ctx, ctx.params.id);
    const allocation = activeAllocation(ctx.db, asset.id);
    if (!allocation) throw new HttpError(400, 'This asset is not currently allocated.');
    const body = ctx.body || {};
    const returnedAt = optionalDate(body, 'returnedAt', 'Return date') || today();
    const now = nowIso();
    const remarks = optionalText(body, 'remarks', 1000);

    transaction(ctx.db, () => {
      ctx.db
        .prepare('UPDATE asset_allocations SET returned_at=?, returned_by=?, remarks=? WHERE id=?')
        .run(returnedAt, ctx.user.id, remarks || allocation.remarks || '', allocation.id);
      ctx.db
        .prepare('UPDATE assets SET custodian_employee_id=NULL, status=?, updated_at=? WHERE id=?')
        .run(restingStatus(ctx.db, asset.id), now, asset.id);
    });
    audit(ctx, 'RETURN', 'asset', asset.id, { status: asset.status, allocationId: allocation.id }, {
      status: restingStatus(ctx.db, asset.id), returnedAt,
    });
    return { ok: true, status: 'created' };
  });

  router.post('/api/procurement/assets/:id/transfer', async (ctx) => {
    auth.guard(ctx.user, 'asset.allocate');
    const asset = getAsset(ctx, ctx.params.id);
    if (['disposed', 'missing'].includes(asset.status)) {
      throw new HttpError(400, 'This asset cannot be transferred in its current state.');
    }
    const body = ctx.body || {};
    const toEmployee = body.toEmployeeId ? ensureEmployee(ctx, Number(body.toEmployeeId)) : null;
    const toStoreId = ensureStore(
      ctx,
      asset.unit_id,
      optionalId({ toStoreId: body.toStoreId === undefined ? asset.store_id : body.toStoreId }, 'toStoreId')
    );
    const storeChanged = Number(toStoreId || 0) !== Number(asset.store_id || 0);
    const toBinId = ensureBin(
      ctx,
      toStoreId,
      optionalId({ toBinId: body.toBinId === undefined ? (storeChanged ? null : asset.bin_id) : body.toBinId }, 'toBinId')
    );
    const toRoomId = ensureRoom(
      ctx,
      asset.unit_id,
      optionalId({ toRoomId: body.toRoomId === undefined ? asset.room_id : body.toRoomId }, 'toRoomId')
    );
    const transferredAt = optionalDate(body, 'transferredAt', 'Transfer date') || today();
    const reason = optionalText(body, 'reason', 500);
    const remarks = optionalText(body, 'remarks', 1000);
    if (!toEmployee && !toStoreId && !toRoomId) {
      throw new HttpError(400, 'Select a new custodian, store or room for the transfer.');
    }
    const now = nowIso();
    let nextStatus = 'transferred';

    transaction(ctx.db, () => {
      ctx.db
        .prepare(
          `INSERT INTO asset_transfers(asset_id, from_store_id, from_bin_id, from_room_id, from_custodian_id,
             to_store_id, to_bin_id, to_room_id, to_custodian_id, transferred_at, reason, remarks,
             transferred_by, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
        )
        .run(
          asset.id, asset.store_id, asset.bin_id, asset.room_id, asset.custodian_employee_id,
          toStoreId, toBinId, toRoomId, toEmployee ? toEmployee.id : null,
          transferredAt, reason, remarks, ctx.user.id, now
        );

      const current = activeAllocation(ctx.db, asset.id);
      if (toEmployee) {
        if (current) {
          ctx.db
            .prepare('UPDATE asset_allocations SET returned_at=?, returned_by=? WHERE id=?')
            .run(transferredAt, ctx.user.id, current.id);
        }
        const departmentId = toEmployee.department_id || asset.department_id || null;
        ctx.db
          .prepare(
            `INSERT INTO asset_allocations(asset_id, employee_id, department_id, store_id, bin_id, room_id,
               allocated_at, allocated_by, remarks, created_at)
             VALUES (?,?,?,?,?,?,?,?,?,?)`
          )
          .run(asset.id, toEmployee.id, departmentId, toStoreId, toBinId, toRoomId, transferredAt, ctx.user.id, remarks, now);
        nextStatus = 'allocated';
      } else if (current) {
        /* A location-only transfer keeps the current custodian allocated. */
        nextStatus = 'allocated';
      }
      const custodianId = toEmployee ? toEmployee.id : (current ? current.employee_id : null);

      ctx.db
        .prepare(
          `UPDATE assets SET store_id=?, bin_id=?, room_id=?, custodian_employee_id=?, status=?, updated_at=?
            WHERE id=?`
        )
        .run(toStoreId, toBinId, toRoomId, custodianId, nextStatus, now, asset.id);
    });
    audit(ctx, 'TRANSFER', 'asset', asset.id, {
      storeId: asset.store_id, roomId: asset.room_id, custodianEmployeeId: asset.custodian_employee_id,
    }, {
      toStoreId, toRoomId, toEmployeeId: toEmployee ? toEmployee.id : null, transferredAt,
    });
    return { ok: true, status: nextStatus };
  });

  /* -------------------------- Maintenance -------------------------- */
  router.post('/api/procurement/assets/:id/maintenance', async (ctx) => {
    auth.guard(ctx.user, 'asset.maintain');
    const asset = getAsset(ctx, ctx.params.id);
    if (asset.status === 'disposed') throw new HttpError(400, 'A disposed asset cannot be maintained.');
    const body = ctx.body || {};
    const maintenanceType = String(body.maintenanceType || 'preventive');
    if (!MAINTENANCE_TYPES.includes(maintenanceType)) {
      throw new HttpError(400, 'Select a valid maintenance type.');
    }
    const scheduledDate = optionalDate(body, 'scheduledDate', 'Scheduled date') || today();
    const description = requireText(body, 'description', 'Maintenance description', 1000);
    const vendorId = ensureVendorRef(ctx, optionalId(body, 'vendorId'));
    const cost = body.cost === undefined || body.cost === '' ? 0 : Number(body.cost);
    if (!Number.isFinite(cost) || cost < 0) throw new HttpError(400, 'Maintenance cost must be zero or more.');
    const now = nowIso();
    const assetStatus = maintenanceType === 'corrective' ? 'under_repair' : 'under_maintenance';
    let id;

    transaction(ctx.db, () => {
      const res = ctx.db
        .prepare(
          `INSERT INTO asset_maintenance(asset_id, maintenance_type, vendor_id, cost, scheduled_date,
             status, description, remarks, created_by, created_at, updated_at)
           VALUES (?,?,?,?,?,'scheduled',?,?,?,?,?)`
        )
        .run(
          asset.id, maintenanceType, vendorId, round2(cost), scheduledDate, description,
          optionalText(body, 'remarks', 1000), ctx.user.id, now, now
        );
      id = Number(res.lastInsertRowid);
      ctx.db
        .prepare('UPDATE assets SET status=?, updated_at=? WHERE id=?')
        .run(assetStatus, now, asset.id);
    });
    audit(ctx, 'MAINTAIN', 'asset', asset.id, { status: asset.status }, {
      status: assetStatus, maintenanceId: id, maintenanceType, scheduledDate,
    });
    return { id, status: assetStatus };
  });

  router.put('/api/procurement/assets/:id/maintenance/:maintenanceId', async (ctx) => {
    auth.guard(ctx.user, 'asset.maintain');
    const asset = getAsset(ctx, ctx.params.id);
    const row = rowOr404(
      ctx.db
        .prepare('SELECT * FROM asset_maintenance WHERE id = ? AND asset_id = ?')
        .get(Number(ctx.params.maintenanceId), asset.id),
      'Maintenance record not found.'
    );
    const body = ctx.body || {};
    const status = body.status === undefined ? row.status : String(body.status);
    if (!MAINTENANCE_STATUSES.includes(status)) throw new HttpError(400, 'Select a valid maintenance status.');
    const completedDate = status === 'completed'
      ? (optionalDate(body, 'completedDate', 'Completion date') || today())
      : null;
    const cost = body.cost === undefined ? Number(row.cost) : Number(body.cost);
    if (!Number.isFinite(cost) || cost < 0) throw new HttpError(400, 'Maintenance cost must be zero or more.');
    const now = nowIso();
    const nextAssetStatus = ['completed', 'cancelled'].includes(status)
      ? restingStatus(ctx.db, asset.id)
      : asset.status;

    transaction(ctx.db, () => {
      ctx.db
        .prepare(
          `UPDATE asset_maintenance SET status=?, cost=?, completed_date=?, remarks=?, updated_at=?
            WHERE id=? AND asset_id=?`
        )
        .run(
          status, round2(cost), completedDate,
          body.remarks === undefined ? row.remarks : optionalText(body, 'remarks', 1000),
          now, row.id, asset.id
        );
      if (['completed', 'cancelled'].includes(status)) {
        ctx.db
          .prepare('UPDATE assets SET status=?, updated_at=? WHERE id=?')
          .run(nextAssetStatus, now, asset.id);
      }
    });
    audit(ctx, 'MAINTAIN_UPDATE', 'asset', asset.id, { maintenanceId: row.id, status: row.status }, {
      status, cost: round2(cost), completedDate,
    });
    return { ok: true, status };
  });

  /* -------------------------- Verification ------------------------- */
  router.post('/api/procurement/assets/:id/verify', async (ctx) => {
    auth.guard(ctx.user, 'asset.verify');
    const asset = getAsset(ctx, ctx.params.id);
    if (asset.status === 'disposed') throw new HttpError(400, 'A disposed asset cannot be verified.');
    const body = ctx.body || {};
    const verificationDate = optionalDate(body, 'verificationDate', 'Verification date') || today();
    const locationMatch = body.locationMatch === false || body.locationMatch === '0' ? 0 : 1;
    const condition = optionalText(body, 'condition', 100);
    const remarks = optionalText(body, 'remarks', 1000);
    const markMissing = body.markMissing === true || body.markMissing === '1';
    const now = nowIso();
    let nextStatus = asset.status;

    if (markMissing) nextStatus = 'missing';
    else if (asset.status === 'missing' && locationMatch) nextStatus = restingStatus(ctx.db, asset.id);

    transaction(ctx.db, () => {
      ctx.db
        .prepare(
          `INSERT INTO asset_verifications(asset_id, verification_date, verified_by, location_match,
             condition, remarks, created_at)
           VALUES (?,?,?,?,?,?,?)`
        )
        .run(asset.id, verificationDate, ctx.user.id, locationMatch, condition, remarks, now);
      if (nextStatus !== asset.status || condition) {
        ctx.db
          .prepare('UPDATE assets SET status=?, condition=?, updated_at=? WHERE id=?')
          .run(nextStatus, condition || asset.condition, now, asset.id);
      }
    });
    audit(ctx, 'VERIFY', 'asset', asset.id, { status: asset.status }, {
      status: nextStatus, verificationDate, locationMatch: !!locationMatch,
    });
    return { ok: true, status: nextStatus };
  });

  /* ---------------------------- Disposal --------------------------- */
  router.post('/api/procurement/assets/:id/disposals', async (ctx) => {
    auth.guard(ctx.user, 'asset.dispose');
    const asset = getAsset(ctx, ctx.params.id);
    if (asset.status === 'disposed') throw new HttpError(400, 'This asset is already disposed.');
    const pending = ctx.db
      .prepare("SELECT 1 FROM asset_disposals WHERE asset_id = ? AND status = 'pending'")
      .get(asset.id);
    if (pending) throw new HttpError(400, 'A disposal request is already pending approval.');
    const body = ctx.body || {};
    const method = String(body.method || 'scrap');
    if (!DISPOSAL_METHODS.includes(method)) throw new HttpError(400, 'Select a valid disposal method.');
    const reason = requireText(body, 'reason', 'Disposal reason', 1000);
    const now = nowIso();
    let id;
    ctx.db
      .prepare(
        `INSERT INTO asset_disposals(asset_id, method, reason, status, requested_by, requested_at,
           remarks, created_at, updated_at)
         VALUES (?,?,?,'pending',?,?,?,?,?)`
      )
      .run(asset.id, method, reason, ctx.user.id, now, optionalText(body, 'remarks', 1000), now, now);
    id = Number(ctx.db.prepare('SELECT last_insert_rowid() AS id').get().id);

    notify(
      approverUserIds(ctx),
      'Asset disposal awaiting approval',
      `${asset.asset_code} — ${asset.asset_name} was submitted for disposal.`,
      `/assets/${asset.id}`
    );
    audit(ctx, 'DISPOSAL_REQUEST', 'asset', asset.id, null, { disposalId: id, method, reason });
    return { id, status: 'pending' };
  });

  router.post('/api/procurement/assets/:id/disposals/:disposalId/approve', async (ctx) => {
    auth.guard(ctx.user, 'asset.approve');
    const asset = getAsset(ctx, ctx.params.id);
    const disposal = rowOr404(
      ctx.db
        .prepare('SELECT * FROM asset_disposals WHERE id = ? AND asset_id = ?')
        .get(Number(ctx.params.disposalId), asset.id),
      'Disposal request not found.'
    );
    if (disposal.status !== 'pending') throw new HttpError(400, 'Only a pending disposal can be approved.');
    const body = ctx.body || {};
    const now = nowIso();
    const remarks = optionalText(body, 'remarks', 1000);

    transaction(ctx.db, () => {
      ctx.db
        .prepare(
          `UPDATE asset_disposals SET status='disposed', approved_by=?, approved_at=?, disposed_at=?,
             remarks=?, updated_at=? WHERE id=?`
        )
        .run(ctx.user.id, now, now, remarks || disposal.remarks || '', now, disposal.id);
      const current = activeAllocation(ctx.db, asset.id);
      if (current) {
        ctx.db
          .prepare('UPDATE asset_allocations SET returned_at=?, returned_by=? WHERE id=?')
          .run(now.slice(0, 10), ctx.user.id, current.id);
      }
      ctx.db
        .prepare(
          `UPDATE assets SET status='disposed', custodian_employee_id=NULL, updated_at=? WHERE id=?`
        )
        .run(now, asset.id);
    });
    notify(
      [asset.created_by, disposal.requested_by],
      'Asset disposal approved',
      `${asset.asset_code} has been disposed.`,
      `/assets/${asset.id}`
    );
    audit(ctx, 'DISPOSAL_APPROVE', 'asset', asset.id, { status: asset.status }, {
      status: 'disposed', disposalId: disposal.id,
    });
    return { ok: true, status: 'disposed' };
  });

  router.post('/api/procurement/assets/:id/disposals/:disposalId/reject', async (ctx) => {
    auth.guard(ctx.user, 'asset.approve');
    const asset = getAsset(ctx, ctx.params.id);
    const disposal = rowOr404(
      ctx.db
        .prepare('SELECT * FROM asset_disposals WHERE id = ? AND asset_id = ?')
        .get(Number(ctx.params.disposalId), asset.id),
      'Disposal request not found.'
    );
    if (disposal.status !== 'pending') throw new HttpError(400, 'Only a pending disposal can be rejected.');
    const body = ctx.body || {};
    const rejectionReason = requireText(body, 'rejectionReason', 'Rejection reason', 500);
    const now = nowIso();
    ctx.db
      .prepare(
        `UPDATE asset_disposals SET status='rejected', approved_by=?, approved_at=?,
           rejection_reason=?, updated_at=? WHERE id=?`
      )
      .run(ctx.user.id, now, rejectionReason, now, disposal.id);
    notify(
      [disposal.requested_by],
      'Asset disposal rejected',
      `${asset.asset_code} disposal was rejected: ${rejectionReason}`,
      `/assets/${asset.id}`
    );
    audit(ctx, 'DISPOSAL_REJECT', 'asset', asset.id, { disposalId: disposal.id }, { rejectionReason });
    return { ok: true, status: 'rejected' };
  });

  /* ----------------------------- Labels ---------------------------- */
  router.get('/api/procurement/assets/:id/label', async (ctx) => {
    auth.guard(ctx.user, 'asset.view');
    const asset = getAsset(ctx, ctx.params.id);
    const label = labelOut(ctx, asset);
    writeLabels(ctx, asset.id, 'both');
    audit(ctx, 'PRINT', 'asset', asset.id, null, { assetCode: asset.asset_code });
    return { label };
  });
};
