'use strict';

/**
 * Procurement foundation API — Phase 0.
 *
 * Everything here is additive: the endpoints live under /api/procurement and
 * only touch the new procurement tables. Existing ABMDAS routes are unchanged.
 */

const path = require('node:path');
const auth = require('../auth');
const { HttpError, saveUpload } = require('../http');
const { DATA_DIR } = require('../db');
const { audit, nowIso, nextItemCode, nextSequence, badRequest, round2 } = require('../util');
const { ensureVendor, transaction, inList } = require('../procurement/shared');
const assetSettings = require('../procurement/asset-settings');
const components = require('../procurement/components');
const tax = require('../procurement/tax');

const ITEM_TYPES = ['consumable', 'asset', 'service'];
const ITEM_UPLOAD_DIR = path.join(DATA_DIR, 'uploads', 'items');
const ITEM_ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024;
const ITEM_ATTACHMENT_RULES = {
  image: { mimes: ['image/jpeg', 'image/png', 'image/webp'], magic: ['jpeg', 'png', 'webp'] },
  datasheet: { mimes: ['application/pdf'], magic: ['pdf'] },
  compliance: { mimes: ['application/pdf'], magic: ['pdf'] },
};

function itemOut(row) {
  if (!row) return null;
  return {
    id: row.id,
    itemCode: row.item_code,
    name: row.name,
    specification: row.specification || '',
    categoryId: row.category_id,
    categoryCode: row.category_code || '',
    categoryName: row.category_name || '',
    subCategoryId: row.sub_category_id,
    subCategoryName: row.sub_category_name || '',
    uomId: row.uom_id,
    uomCode: row.uom_code || '',
    uomName: row.uom_name || '',
    itemType: row.item_type,
    reorderLevel: Number(row.reorder_level) || 0,
    minStock: Number(row.min_stock) || 0,
    maxStock: Number(row.max_stock) || 0,
    standardCost: Number(row.standard_cost) || 0,
    trackInventory: !!row.track_inventory,
    trackAsset: !!row.track_asset,
    active: !!row.active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const ITEM_SELECT = `
  SELECT i.*, c.code AS category_code, c.name AS category_name,
         sc.name AS sub_category_name, u.code AS uom_code, u.name AS uom_name
    FROM items i
    JOIN item_categories c ON c.id = i.category_id
    LEFT JOIN item_categories sc ON sc.id = i.sub_category_id
    JOIN uoms u ON u.id = i.uom_id
`;

function optionalDetailText(source, field, max = 200) {
  return String(source[field] ?? '').trim().slice(0, max);
}

function detailsFromBody(b) {
  const src = b && typeof b === 'object' ? b : {};
  const gstRate = positiveNumber(src.gstRate, 'GST rate');
  if (gstRate > 100) throw badRequest('GST rate must be between 0 and 100.');
  const hsnCode = optionalDetailText(src, 'hsnCode', 8);
  if (hsnCode && !/^\d{2,8}$/.test(hsnCode)) throw badRequest('HSN code must be 2 to 8 digits.');
  const leadTimeDays = positiveNumber(src.leadTimeDays, 'Lead time');
  if (!Number.isInteger(leadTimeDays) || leadTimeDays > 3650) {
    throw badRequest('Lead time must be a whole number of days (0 to 3650).');
  }
  const packSize = src.packSize === undefined || src.packSize === '' ? 1 : positiveNumber(src.packSize, 'Pack size');
  if (packSize <= 0) throw badRequest('Pack size must be greater than zero.');
  return {
    brand: optionalDetailText(src, 'brand'),
    modelNo: optionalDetailText(src, 'modelNo'),
    manufacturer: optionalDetailText(src, 'manufacturer'),
    hsnCode,
    gstRate,
    taxInclusive: tax.flag(src.taxInclusive),
    defaultDiscountPercent: tax.number(src.defaultDiscountPercent, 'Default discount percent', 0, { min: 0, max: 100, fallback: 0 }),
    defaultDiscountAmount: tax.number(src.defaultDiscountAmount, 'Default discount amount', 0, { fallback: 0 }),
    moq: positiveNumber(src.moq, 'MOQ'),
    reorderQty: positiveNumber(src.reorderQty, 'Reorder quantity'),
    leadTimeDays,
    packSize,
    packDescription: optionalDetailText(src, 'packDescription', 100),
    safetyStock: positiveNumber(src.safetyStock, 'Safety stock'),
    lastPurchaseCost: positiveNumber(src.lastPurchaseCost, 'Last purchase cost'),
    color: optionalDetailText(src, 'color', 50),
    capacity: optionalDetailText(src, 'capacity', 100),
    powerRating: optionalDetailText(src, 'powerRating', 50),
    configurationDetails: optionalDetailText(src, 'configurationDetails', 2000),
    make: optionalDetailText(src, 'make', 100),
    expiryTracking: src.expiryTracking === true || src.expiryTracking === 1 || src.expiryTracking === '1',
    shelfLifeDays: positiveNumber(src.shelfLifeDays, 'Shelf life days'),
    amcVendorId: src.amcVendorId ? Number(src.amcVendorId) : null,
    amcStartDate: optionalDetailText(src, 'amcStartDate', 10),
    amcEndDate: optionalDetailText(src, 'amcEndDate', 10),
    insuranceRequired: src.insuranceRequired === true || src.insuranceRequired === 1 || src.insuranceRequired === '1',
    complianceCertRequired: src.complianceCertRequired === true || src.complianceCertRequired === 1 || src.complianceCertRequired === '1',
    defaultStoreId: src.defaultStoreId ? Number(src.defaultStoreId) : null,
    storageConditions: optionalDetailText(src, 'storageConditions', 500),
    rackNumber: optionalDetailText(src, 'rackNumber', 50),
    binLocation: optionalDetailText(src, 'binLocation', 50),
    approvalRequired: src.approvalRequired === true || src.approvalRequired === 1 || src.approvalRequired === '1',
    approvalMatrixId: src.approvalMatrixId ? Number(src.approvalMatrixId) : null,
  };
}

function vendorsFromBody(ctx, list) {
  if (!Array.isArray(list)) throw badRequest('Vendors must be a list.');
  if (list.length > 50) throw badRequest('An item can map at most 50 vendors.');
  const seen = new Set();
  let preferred = 0;
  const rows = list.map((line, index) => {
    const vendorId = Number(line && line.vendorId);
    if (!Number.isInteger(vendorId) || vendorId <= 0) throw badRequest(`Vendor ${index + 1}: select a vendor.`);
    if (seen.has(vendorId)) throw badRequest(`Vendor ${index + 1}: this vendor is listed more than once.`);
    seen.add(vendorId);
    ensureVendor(ctx.db, vendorId);
    const isPreferred = line.isPreferred === true || line.isPreferred === 1 || line.isPreferred === '1';
    if (isPreferred) preferred += 1;
    const leadTimeDays = positiveNumber(line.leadTimeDays, `Vendor ${index + 1} lead time`);
    if (!Number.isInteger(leadTimeDays) || leadTimeDays > 3650) {
      throw badRequest(`Vendor ${index + 1}: lead time must be a whole number of days.`);
    }
    return {
      vendorId,
      vendorItemCode: optionalDetailText(line, 'vendorItemCode', 100),
      unitCost: positiveNumber(line.unitCost, `Vendor ${index + 1} unit cost`),
      leadTimeDays,
      isPreferred: isPreferred ? 1 : 0,
    };
  });
  if (preferred > 1) throw badRequest('Only one vendor can be the preferred vendor.');
  return rows;
}

function saveItemDetails(db, itemId, d, now) {
  db.prepare(
    `INSERT INTO item_details(item_id, brand, model_no, manufacturer, hsn_code, gst_rate,
       tax_inclusive, default_discount_percent, default_discount_amount,
       moq, reorder_qty, lead_time_days, pack_size, pack_description, safety_stock, last_purchase_cost,
       color, capacity, power_rating, configuration_details, make,
       expiry_tracking, shelf_life_days, amc_vendor_id, amc_start_date, amc_end_date,
       insurance_required, compliance_cert_required, default_store_id, storage_conditions,
       rack_number, bin_location, approval_required, approval_matrix_id,
       created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(item_id) DO UPDATE SET brand=excluded.brand, model_no=excluded.model_no,
       manufacturer=excluded.manufacturer, hsn_code=excluded.hsn_code, gst_rate=excluded.gst_rate,
        tax_inclusive=excluded.tax_inclusive, default_discount_percent=excluded.default_discount_percent,
        default_discount_amount=excluded.default_discount_amount,
       moq=excluded.moq, reorder_qty=excluded.reorder_qty, lead_time_days=excluded.lead_time_days,
       pack_size=excluded.pack_size, pack_description=excluded.pack_description,
       safety_stock=excluded.safety_stock, last_purchase_cost=excluded.last_purchase_cost,
       color=excluded.color, capacity=excluded.capacity, power_rating=excluded.power_rating,
       configuration_details=excluded.configuration_details, make=excluded.make,
       expiry_tracking=excluded.expiry_tracking, shelf_life_days=excluded.shelf_life_days,
       amc_vendor_id=excluded.amc_vendor_id, amc_start_date=excluded.amc_start_date,
       amc_end_date=excluded.amc_end_date, insurance_required=excluded.insurance_required,
       compliance_cert_required=excluded.compliance_cert_required,
       default_store_id=excluded.default_store_id, storage_conditions=excluded.storage_conditions,
       rack_number=excluded.rack_number, bin_location=excluded.bin_location,
       approval_required=excluded.approval_required, approval_matrix_id=excluded.approval_matrix_id,
       updated_at=excluded.updated_at`
  ).run(
    itemId, d.brand || null, d.modelNo || null, d.manufacturer || null, d.hsnCode || null,
    d.gstRate || 0, d.taxInclusive ? 1 : 0, d.defaultDiscountPercent || 0, d.defaultDiscountAmount || 0,
    d.moq || 0, d.reorderQty || 0, d.leadTimeDays || 0, d.packSize || 1,
    d.packDescription || null, d.safetyStock || 0, d.lastPurchaseCost || 0,
    d.color || null, d.capacity || null, d.powerRating || null, d.configurationDetails || null,
    d.make || null, d.expiryTracking ? 1 : 0, d.shelfLifeDays || 0, d.amcVendorId || null,
    d.amcStartDate || null, d.amcEndDate || null, d.insuranceRequired ? 1 : 0,
    d.complianceCertRequired ? 1 : 0, d.defaultStoreId || null, d.storageConditions || null,
    d.rackNumber || null, d.binLocation || null, d.approvalRequired ? 1 : 0, d.approvalMatrixId || null,
    now, now
  );
}

function saveItemVendors(db, itemId, rows, now) {
  db.prepare('UPDATE item_vendors SET is_preferred = 0 WHERE item_id = ?').run(itemId);
  const upsert = db.prepare(
    `INSERT INTO item_vendors(item_id, vendor_id, vendor_item_code, unit_cost, lead_time_days,
       is_preferred, active, created_at, updated_at)
     VALUES (?,?,?,?,?,?,1,?,?)
     ON CONFLICT(item_id, vendor_id) DO UPDATE SET vendor_item_code=excluded.vendor_item_code,
       unit_cost=excluded.unit_cost, lead_time_days=excluded.lead_time_days,
       is_preferred=excluded.is_preferred, active=1, updated_at=excluded.updated_at`
  );
  for (const row of rows) {
    upsert.run(itemId, row.vendorId, row.vendorItemCode || null, row.unitCost, row.leadTimeDays, row.isPreferred, now, now);
  }
  const ids = rows.map((r) => r.vendorId);
  if (ids.length) {
    db.prepare(
      `UPDATE item_vendors SET active = 0, is_preferred = 0, updated_at = ?
        WHERE item_id = ? AND vendor_id NOT IN (${inList(ids)})`
    ).run(now, itemId, ...ids);
  } else {
    db.prepare('UPDATE item_vendors SET active = 0, is_preferred = 0, updated_at = ? WHERE item_id = ?').run(now, itemId);
  }
}

function itemExtras(db, itemId) {
  const d = db.prepare('SELECT * FROM item_details WHERE item_id = ?').get(itemId);
  const details = {
    brand: d?.brand || '',
    modelNo: d?.model_no || '',
    manufacturer: d?.manufacturer || '',
    hsnCode: d?.hsn_code || '',
    gstRate: Number(d?.gst_rate) || 0,
    taxInclusive: !!d?.tax_inclusive,
    defaultDiscountPercent: Number(d?.default_discount_percent) || 0,
    defaultDiscountAmount: Number(d?.default_discount_amount) || 0,
    moq: Number(d?.moq) || 0,
    reorderQty: Number(d?.reorder_qty) || 0,
    leadTimeDays: Number(d?.lead_time_days) || 0,
    packSize: d ? Number(d.pack_size) : 1,
    packDescription: d?.pack_description || '',
    safetyStock: Number(d?.safety_stock) || 0,
    lastPurchaseCost: Number(d?.last_purchase_cost) || 0,
    color: d?.color || '',
    capacity: d?.capacity || '',
    powerRating: d?.power_rating || '',
    configurationDetails: d?.configuration_details || '',
    make: d?.make || '',
    expiryTracking: !!d?.expiry_tracking,
    shelfLifeDays: Number(d?.shelf_life_days) || 0,
    amcVendorId: d?.amc_vendor_id || null,
    amcStartDate: d?.amc_start_date || '',
    amcEndDate: d?.amc_end_date || '',
    insuranceRequired: !!d?.insurance_required,
    complianceCertRequired: !!d?.compliance_cert_required,
    defaultStoreId: d?.default_store_id || null,
    storageConditions: d?.storage_conditions || '',
    rackNumber: d?.rack_number || '',
    binLocation: d?.bin_location || '',
    approvalRequired: !!d?.approval_required,
    approvalMatrixId: d?.approval_matrix_id || null,
  };
  const vendors = db
    .prepare(
      `SELECT iv.*, v.code AS vendor_code, v.name AS vendor_name, v.status AS vendor_status
         FROM item_vendors iv JOIN vendors v ON v.id = iv.vendor_id
        WHERE iv.item_id = ? AND iv.active = 1
        ORDER BY iv.is_preferred DESC, v.name COLLATE NOCASE`
    )
    .all(itemId)
    .map((r) => ({
      vendorId: r.vendor_id,
      vendorCode: r.vendor_code,
      vendorName: r.vendor_name,
      vendorStatus: r.vendor_status,
      vendorItemCode: r.vendor_item_code || '',
      unitCost: Number(r.unit_cost) || 0,
      leadTimeDays: Number(r.lead_time_days) || 0,
      isPreferred: !!r.is_preferred,
    }));
  const attachments = db
    .prepare(
      `SELECT id, kind, file_name, mime_type, size, uploaded_at FROM item_attachments
        WHERE item_id = ? AND deleted_at IS NULL ORDER BY uploaded_at DESC, id DESC`
    )
    .all(itemId)
    .map((r) => ({
      id: r.id, kind: r.kind, fileName: r.file_name, mimeType: r.mime_type || '',
      size: Number(r.size) || 0, uploadedAt: r.uploaded_at,
      url: `/api/files/item-attachment/${r.id}`,
    }));
  const conversions = db
    .prepare(
      `SELECT c.*, fu.code AS from_code, fu.name AS from_name, tu.code AS to_code, tu.name AS to_name
         FROM item_uom_conversions c
         JOIN uoms fu ON fu.id = c.from_uom_id
         JOIN uoms tu ON tu.id = c.to_uom_id
        WHERE c.item_id = ? AND c.active = 1
        ORDER BY fu.name, tu.name`
    )
    .all(itemId)
    .map((r) => ({
      id: r.id,
      fromUomId: r.from_uom_id,
      fromCode: r.from_code,
      fromName: r.from_name,
      toUomId: r.to_uom_id,
      toCode: r.to_code,
      toName: r.to_name,
      factor: Number(r.conversion_factor),
    }));
  return {
    details,
    vendors,
    attachments,
    conversions,
    components: components.readItemComponents(db, itemId),
    assetSettings: assetSettings.resolveAssetSettings(db, itemId),
  };
}

function magicMatches(buffer, kind) {
  if (kind === 'jpeg') return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  if (kind === 'png') return buffer.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (kind === 'webp') return buffer.slice(0, 4).toString('ascii') === 'RIFF' && buffer.slice(8, 12).toString('ascii') === 'WEBP';
  if (kind === 'pdf') return buffer.slice(0, 5).toString('ascii') === '%PDF-';
  return false;
}

function positiveNumber(value, field, { required = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw badRequest(`${field} is required.`);
    return 0;
  }
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw badRequest(`${field} must be a number of zero or more.`);
  return round2(n);
}

function itemFromBody(b) {
  const name = String(b.name || '').trim();
  if (!name) throw badRequest('Item name is required.');
  const itemType = String(b.itemType || '').trim();
  if (!ITEM_TYPES.includes(itemType)) throw badRequest('Item type must be consumable, asset or service.');
  const categoryId = Number(b.categoryId);
  if (!Number.isInteger(categoryId) || categoryId <= 0) throw badRequest('Item category is required.');
  const uomId = Number(b.uomId);
  if (!Number.isInteger(uomId) || uomId <= 0) throw badRequest('Unit of measure is required.');

  const subCategoryId = b.subCategoryId ? Number(b.subCategoryId) : null;
  if (subCategoryId !== null && (!Number.isInteger(subCategoryId) || subCategoryId <= 0)) {
    throw badRequest('Sub category is invalid.');
  }

  const minStock = positiveNumber(b.minStock, 'Minimum stock');
  const maxStock = positiveNumber(b.maxStock, 'Maximum stock');
  if (maxStock > 0 && minStock > maxStock) throw badRequest('Minimum stock cannot exceed maximum stock.');

  return {
    name,
    specification: String(b.specification || '').trim(),
    categoryId,
    subCategoryId,
    uomId,
    itemType,
    reorderLevel: positiveNumber(b.reorderLevel, 'Reorder level'),
    minStock,
    maxStock,
    standardCost: positiveNumber(b.standardCost, 'Standard cost'),
    trackInventory: itemType === 'consumable' && b.trackInventory !== false ? 1 : 0,
    trackAsset: itemType === 'asset' ? 1 : 0,
    active: b.active === false ? 0 : 1,
  };
}

function assertCategory(ctx, data) {
  const category = ctx.db
    .prepare('SELECT * FROM item_categories WHERE id = ? AND deleted_at IS NULL')
    .get(data.categoryId);
  if (!category) throw badRequest('Item category was not found.');
  if (category.item_type !== data.itemType) {
    throw badRequest(`Category "${category.name}" is reserved for ${category.item_type} items.`);
  }
  if (data.subCategoryId) {
    const sub = ctx.db
      .prepare('SELECT * FROM item_categories WHERE id = ? AND deleted_at IS NULL')
      .get(data.subCategoryId);
    if (!sub) throw badRequest('Sub category was not found.');
    if (sub.item_type !== data.itemType) throw badRequest('Sub category does not match the item type.');
  }
  const uom = ctx.db.prepare('SELECT id FROM uoms WHERE id = ? AND active = 1').get(data.uomId);
  if (!uom) throw badRequest('Unit of measure was not found.');
}

module.exports = function registerProcurementRoutes(router) {
  /* ---------------------------------------------------------------- */
  /* Meta: categories, units of measure, stores, counts                */
  /* ---------------------------------------------------------------- */
  router.get('/api/procurement/meta', async (ctx) => {
    auth.guard(ctx.user, 'item.view');
    const categories = ctx.db
      .prepare(
        `SELECT c.*, p.name AS parent_name
           FROM item_categories c
           LEFT JOIN item_categories p ON p.id = c.parent_id
          WHERE c.deleted_at IS NULL
          ORDER BY c.item_type, c.name`
      )
      .all()
      .map((c) => ({
        id: c.id,
        code: c.code,
        name: c.name,
        parentId: c.parent_id,
        parentName: c.parent_name || '',
        itemType: c.item_type,
        active: !!c.active,
      }));
    const uoms = ctx.db
      .prepare('SELECT id, code, name FROM uoms WHERE active = 1 ORDER BY name')
      .all();
    const stores = ctx.db
      .prepare('SELECT id, code, name, unit_id, store_type FROM stores WHERE deleted_at IS NULL ORDER BY name')
      .all()
      .map((s) => ({ id: s.id, code: s.code, name: s.name, unitId: s.unit_id, storeType: s.store_type }));
    const counts = ctx.db
      .prepare(
        `SELECT item_type, COUNT(*) AS total
           FROM items WHERE deleted_at IS NULL GROUP BY item_type`
      )
      .all()
      .reduce((acc, row) => ({ ...acc, [row.item_type]: row.total }), {});

    const vendors = ctx.db
      .prepare("SELECT id, code, name FROM vendors WHERE status <> 'Blacklisted' ORDER BY name COLLATE NOCASE LIMIT 1000")
      .all();

    const departments = ctx.db
      .prepare('SELECT id, name FROM departments WHERE active = 1 ORDER BY name')
      .all();

    const componentItems = components.componentItemOptions(ctx.db);

    return {
      vendors,
      componentItems,
      departments,
      itemTypes: [
        { value: 'consumable', label: 'Consumable' },
        { value: 'asset', label: 'Asset (Non-Consumable)' },
        { value: 'service', label: 'Service' },
      ],
      categories,
      uoms,
      stores,
      counts: {
        consumable: counts.consumable || 0,
        asset: counts.asset || 0,
        service: counts.service || 0,
      },
    };
  });

  /* ---------------------------------------------------------------- */
  /* Lookup masters — created inline from entry forms                  */
  /* ---------------------------------------------------------------- */
  router.post('/api/procurement/item-categories', async (ctx) => {
    auth.guard(ctx.user, 'item.manage');
    const b = ctx.body || {};
    const name = String(b.name || '').trim();
    if (!name) throw badRequest('Category name is required.');
    const itemType = String(b.itemType || 'consumable').trim();
    if (!ITEM_TYPES.includes(itemType)) throw badRequest('Category type must be consumable, asset or service.');

    let parentId = null;
    if (b.parentId) {
      parentId = Number(b.parentId);
      const parent = ctx.db
        .prepare('SELECT id, item_type FROM item_categories WHERE id = ? AND deleted_at IS NULL')
        .get(parentId);
      if (!parent) throw badRequest('Parent category was not found.');
      if (parent.item_type !== itemType) throw badRequest('Parent category must have the same item type.');
    }

    let code = String(b.code || '').trim().toUpperCase();
    if (!code) code = nextSequence('item_category', { prefix: 'IC', year: false, pad: 4 });
    if (ctx.db.prepare('SELECT id FROM item_categories WHERE code = ? AND deleted_at IS NULL').get(code)) {
      throw new HttpError(409, 'Category code already exists.');
    }

    const now = nowIso();
    const res = ctx.db
      .prepare(
        `INSERT INTO item_categories(code, name, parent_id, item_type, active, created_at, updated_at)
         VALUES (?,?,?,?,1,?,?)`
      )
      .run(code, name, parentId, itemType, now, now);
    const id = Number(res.lastInsertRowid);
    audit(ctx, 'CREATE', 'item_category', id, null, { code, name, parentId, itemType });
    return { id, code, name, parentId, itemType, active: true };
  });

  router.post('/api/procurement/uoms', async (ctx) => {
    auth.guard(ctx.user, 'item.manage');
    const b = ctx.body || {};
    const code = String(b.code || '').trim().toUpperCase();
    const name = String(b.name || '').trim();
    if (!code || !name) throw badRequest('UOM code and name are required.');
    if (!/^[A-Z0-9_-]{1,20}$/.test(code)) {
      throw badRequest('UOM code may contain only letters, numbers, "-" and "_" (maximum 20 characters).');
    }
    if (ctx.db.prepare('SELECT id FROM uoms WHERE code = ?').get(code)) {
      throw new HttpError(409, 'UOM code already exists.');
    }
    const res = ctx.db.prepare('INSERT INTO uoms(code, name, active) VALUES (?,?,1)').run(code, name);
    const id = Number(res.lastInsertRowid);
    audit(ctx, 'CREATE', 'uom', id, null, { code, name });
    return { id, code, name, active: true };
  });

  /* ---------------------------------------------------------------- */
  /* Item master                                                       */
  /* ---------------------------------------------------------------- */
  router.get('/api/procurement/items', async (ctx) => {
    auth.guard(ctx.user, 'item.view');
    const q = ctx.query || {};
    const where = ['i.deleted_at IS NULL'];
    const params = [];

    if (q.search) {
      where.push('(i.item_code LIKE ? OR i.name LIKE ? OR i.specification LIKE ?)');
      const like = `%${String(q.search).trim()}%`;
      params.push(like, like, like);
    }
    if (q.type && ITEM_TYPES.includes(String(q.type))) {
      where.push('i.item_type = ?');
      params.push(String(q.type));
    }
    if (q.category) {
      where.push('(i.category_id = ? OR i.sub_category_id = ?)');
      params.push(Number(q.category), Number(q.category));
    }
    if (q.status === 'active') where.push('i.active = 1');
    if (q.status === 'inactive') where.push('i.active = 0');

    const page = Math.max(1, Number(q.page) || 1);
    const pageSize = Math.min(200, Math.max(1, Number(q.pageSize) || 50));
    const offset = (page - 1) * pageSize;

    const total = ctx.db
      .prepare(`SELECT COUNT(*) AS c FROM items i WHERE ${where.join(' AND ')}`)
      .get(...params).c;

    const rows = ctx.db
      .prepare(`${ITEM_SELECT} WHERE ${where.join(' AND ')} ORDER BY i.name COLLATE NOCASE ASC LIMIT ? OFFSET ?`)
      .all(...params, pageSize, offset);

    return { items: rows.map(itemOut), total, page, pageSize };
  });

  router.get('/api/procurement/items/:id', async (ctx) => {
    auth.guard(ctx.user, 'item.view');
    const id = Number(ctx.params.id);
    const row = ctx.db.prepare(`${ITEM_SELECT} WHERE i.id = ? AND i.deleted_at IS NULL`).get(id);
    if (!row) throw new HttpError(404, 'Item not found.');
    return { item: itemOut(row), ...itemExtras(ctx.db, id) };
  });

  router.post('/api/procurement/items', async (ctx) => {
    auth.guard(ctx.user, 'item.manage');
    const body = ctx.body || {};
    const data = itemFromBody(body);
    assertCategory(ctx, data);
    const details = body.details === undefined ? detailsFromBody({}) : detailsFromBody(body.details);
    const vendors = body.vendors === undefined ? [] : vendorsFromBody(ctx, body.vendors);
    const componentInput = body.components === undefined ? [] : body.components;
    if (data.itemType !== 'asset' && Array.isArray(componentInput) && componentInput.length) {
      throw badRequest('Components can only be defined on asset items.');
    }

    const now = nowIso();
    const code = nextItemCode();
    let id;
    let componentRows = [];
    transaction(ctx.db, () => {
      const res = ctx.db
        .prepare(
          `INSERT INTO items(item_code, name, specification, category_id, sub_category_id, uom_id,
             item_type, reorder_level, min_stock, max_stock, standard_cost,
             track_inventory, track_asset, active, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
        )
        .run(
          code, data.name, data.specification, data.categoryId, data.subCategoryId, data.uomId,
          data.itemType, data.reorderLevel, data.minStock, data.maxStock, data.standardCost,
          data.trackInventory, data.trackAsset, data.active, now, now
        );
      id = Number(res.lastInsertRowid);
      saveItemDetails(ctx.db, id, details, now);
      if (vendors.length) saveItemVendors(ctx.db, id, vendors, now);
      componentRows = components.validateComponents(ctx.db, componentInput, { parentItemId: id });
      components.saveItemComponents(ctx.db, id, componentRows, now);
      if (body.assetSettings !== undefined) {
        if (data.itemType === 'asset') assetSettings.saveItemOverrides(ctx.db, id, body.assetSettings, now);
        else assetSettings.clearItemOverrides(ctx.db, id, now);
      }
    });

    audit(ctx, 'CREATE', 'item', id, null, {
      itemCode: code, name: data.name, itemType: data.itemType, vendorCount: vendors.length,
      gstRate: details.gstRate, taxInclusive: details.taxInclusive,
      defaultDiscountPercent: details.defaultDiscountPercent, defaultDiscountAmount: details.defaultDiscountAmount,
      ...components.auditSummary(componentRows),
    });
    return { id, itemCode: code };
  });

  router.put('/api/procurement/items/:id', async (ctx) => {
    auth.guard(ctx.user, 'item.manage');
    const id = Number(ctx.params.id);
    const existing = ctx.db.prepare('SELECT * FROM items WHERE id = ? AND deleted_at IS NULL').get(id);
    if (!existing) throw new HttpError(404, 'Item not found.');

    const body = ctx.body || {};
    const data = itemFromBody(body);
    assertCategory(ctx, data);
    const details = body.details === undefined ? null : detailsFromBody(body.details);
    const vendors = body.vendors === undefined ? null : vendorsFromBody(ctx, body.vendors);
    const componentInput = body.components === undefined
      ? (data.itemType === 'asset' ? undefined : [])
      : body.components;
    if (data.itemType !== 'asset' && Array.isArray(componentInput) && componentInput.length) {
      throw badRequest('Components can only be defined on asset items.');
    }
    const componentRows = componentInput === undefined
      ? null
      : components.validateComponents(ctx.db, componentInput, { parentItemId: id });
    const now = nowIso();

    transaction(ctx.db, () => {
      ctx.db
        .prepare(
          `UPDATE items SET name=?, specification=?, category_id=?, sub_category_id=?, uom_id=?,
             item_type=?, reorder_level=?, min_stock=?, max_stock=?, standard_cost=?,
             track_inventory=?, track_asset=?, active=?, updated_at=?
           WHERE id=?`
        )
        .run(
          data.name, data.specification, data.categoryId, data.subCategoryId, data.uomId,
          data.itemType, data.reorderLevel, data.minStock, data.maxStock, data.standardCost,
          data.trackInventory, data.trackAsset, data.active, now, id
        );
      /* Permanent safeguard: an item master rename must never leave a PO line
         with a different item name. Keep every linked line in step so POs and
         the master stay aligned (audited by the item UPDATE entry below). */
      if (data.name !== existing.name) {
        ctx.db.prepare('UPDATE po_items SET item_name = ? WHERE item_id = ?').run(data.name, id);
      }
      if (details) saveItemDetails(ctx.db, id, details, now);
      if (vendors) saveItemVendors(ctx.db, id, vendors, now);
      if (componentRows) components.saveItemComponents(ctx.db, id, componentRows, now);
      if (body.assetSettings !== undefined) {
        if (data.itemType === 'asset') assetSettings.saveItemOverrides(ctx.db, id, body.assetSettings, now);
        else assetSettings.clearItemOverrides(ctx.db, id, now);
      }
    });

    audit(ctx, 'UPDATE', 'item', id, itemOut(existing), {
      name: data.name, itemType: data.itemType, active: !!data.active,
      gstRate: details?.gstRate, taxInclusive: details?.taxInclusive,
      defaultDiscountPercent: details?.defaultDiscountPercent, defaultDiscountAmount: details?.defaultDiscountAmount,
      vendorCount: vendors ? vendors.length : undefined,
      ...(componentRows ? components.auditSummary(componentRows) : {}),
    });
    return { ok: true };
  });

  /* ---------------------------------------------------------------- */
  /* UOM conversions per item (Phase 5c)                             */
  /* ---------------------------------------------------------------- */
  router.get('/api/procurement/items/:id/uom-conversions', async (ctx) => {
    auth.guard(ctx.user, 'item.view');
    const id = Number(ctx.params.id);
    const rows = ctx.db
      .prepare(
        `SELECT c.*, fu.code AS from_code, fu.name AS from_name, tu.code AS to_code, tu.name AS to_name
           FROM item_uom_conversions c
           JOIN uoms fu ON fu.id = c.from_uom_id
           JOIN uoms tu ON tu.id = c.to_uom_id
          WHERE c.item_id = ? AND c.active = 1
          ORDER BY fu.name, tu.name`
      )
      .all(id)
      .map((r) => ({
        id: r.id,
        fromUomId: r.from_uom_id,
        fromCode: r.from_code,
        fromName: r.from_name,
        toUomId: r.to_uom_id,
        toCode: r.to_code,
        toName: r.to_name,
        factor: Number(r.conversion_factor),
      }));
    return { conversions: rows };
  });

  router.post('/api/procurement/items/:id/uom-conversions', async (ctx) => {
    auth.guard(ctx.user, 'item.manage');
    const id = Number(ctx.params.id);
    const item = ctx.db.prepare('SELECT id FROM items WHERE id = ? AND deleted_at IS NULL').get(id);
    if (!item) throw new HttpError(404, 'Item not found.');
    const body = ctx.body || {};
    const fromId = Number(body.fromUomId);
    const toId = Number(body.toUomId);
    const factor = Number(body.factor);
    if (!Number.isInteger(fromId) || fromId <= 0) throw badRequest('Choose a source unit of measure.');
    if (!Number.isInteger(toId) || toId <= 0) throw badRequest('Choose a target unit of measure.');
    if (fromId === toId) throw badRequest('Source and target units must differ.');
    if (!Number.isFinite(factor) || factor <= 0) throw badRequest('Conversion factor must be a positive number.');
    const from = ctx.db.prepare('SELECT id FROM uoms WHERE id = ? AND active = 1').get(fromId);
    const to = ctx.db.prepare('SELECT id FROM uoms WHERE id = ? AND active = 1').get(toId);
    if (!from || !to) throw badRequest('One of the selected units is inactive or missing.');
    const now = nowIso();
    ctx.db
      .prepare(
        `INSERT INTO item_uom_conversions(item_id, from_uom_id, to_uom_id, conversion_factor, active, created_at, updated_at)
         VALUES (?,?,?,?,1,?,?)
         ON CONFLICT(item_id, from_uom_id, to_uom_id) DO UPDATE SET
           conversion_factor=excluded.conversion_factor, active=1, updated_at=excluded.updated_at`
      )
      .run(id, fromId, toId, factor, now, now);
    return { ok: true };
  });

  router.delete('/api/procurement/items/:id/uom-conversions/:convId', async (ctx) => {
    auth.guard(ctx.user, 'item.manage');
    const id = Number(ctx.params.id);
    const convId = Number(ctx.params.convId);
    const now = nowIso();
    ctx.db
      .prepare('UPDATE item_uom_conversions SET active = 0, updated_at = ? WHERE id = ? AND item_id = ?')
      .run(now, convId, id);
    return { ok: true };
  });

  router.post('/api/procurement/items/:id/attachments', async (ctx) => {
    auth.guard(ctx.user, 'item.manage');
    const id = Number(ctx.params.id);
    const item = ctx.db.prepare('SELECT id FROM items WHERE id = ? AND deleted_at IS NULL').get(id);
    if (!item) throw new HttpError(404, 'Item not found.');
    const body = ctx.body || {};
    const kind = String(body.kind || '');
    const rule = ITEM_ATTACHMENT_RULES[kind];
    if (!rule) throw badRequest('Attachment type must be an image or a datasheet.');
    const name = String(body.name || '').trim().slice(0, 200);
    if (!name || !body.data) throw badRequest('Choose a file to upload.');
    const mime = String(body.mime || '').toLowerCase();
    if (!rule.mimes.includes(mime)) {
      throw badRequest(kind === 'image' ? 'Images must be JPEG, PNG or WebP.' : 'Datasheets must be PDF files.');
    }
    const buffer = Buffer.from(String(body.data), 'base64');
    if (!buffer.length) throw badRequest('The file is empty.');
    if (buffer.length > ITEM_ATTACHMENT_MAX_BYTES) throw badRequest('Files must be 5 MB or smaller.');
    const magic = rule.magic.some((m) => magicMatches(buffer, m));
    if (!magic) throw badRequest('The file content does not match its type.');

    const saved = saveUpload({ name, data: String(body.data) }, ITEM_UPLOAD_DIR);
    const now = nowIso();
    const res = ctx.db
      .prepare(
        `INSERT INTO item_attachments(item_id, kind, file_name, stored_name, mime_type, size, uploaded_by, uploaded_at)
         VALUES (?,?,?,?,?,?,?,?)`
      )
      .run(id, kind, name, saved.stored, mime, saved.size, ctx.user.id, now);
    audit(ctx, 'CREATE', 'item_attachment', Number(res.lastInsertRowid), null, { itemId: id, kind, fileName: name });
    return { id: Number(res.lastInsertRowid), kind, fileName: name };
  });

  router.delete('/api/procurement/items/:id/attachments/:attachmentId', async (ctx) => {
    auth.guard(ctx.user, 'item.manage');
    const row = ctx.db
      .prepare('SELECT * FROM item_attachments WHERE id = ? AND item_id = ? AND deleted_at IS NULL')
      .get(Number(ctx.params.attachmentId), Number(ctx.params.id));
    if (!row) throw new HttpError(404, 'Attachment not found.');
    const now = nowIso();
    ctx.db
      .prepare('UPDATE item_attachments SET deleted_at = ?, deleted_by = ? WHERE id = ?')
      .run(now, ctx.user.id, row.id);
    audit(ctx, 'DELETE', 'item_attachment', row.id, { fileName: row.file_name, kind: row.kind }, { deletedAt: now });
    return { ok: true };
  });

  router.delete('/api/procurement/items/:id', async (ctx) => {
    auth.guard(ctx.user, 'item.manage');
    const id = Number(ctx.params.id);
    const existing = ctx.db.prepare('SELECT * FROM items WHERE id = ? AND deleted_at IS NULL').get(id);
    if (!existing) throw new HttpError(404, 'Item not found.');

    const now = nowIso();
    ctx.db
      .prepare('UPDATE items SET deleted_at = ?, deleted_by = ?, active = 0, updated_at = ? WHERE id = ?')
      .run(now, ctx.user.id, now, id);

    audit(ctx, 'DELETE', 'item', id, { itemCode: existing.item_code, name: existing.name }, { deletedAt: now });
    return { ok: true };
  });

  /* ---------------------------------------------------------------- */
  /* Read-only lookups                                                 */
  /* ---------------------------------------------------------------- */
  router.get('/api/procurement/item-categories', async (ctx) => {
    auth.guard(ctx.user, 'item.view');
    const type = ctx.query?.type;
    let sql = `SELECT c.*, p.name AS parent_name
                 FROM item_categories c
                 LEFT JOIN item_categories p ON p.id = c.parent_id
                WHERE c.deleted_at IS NULL`;
    const params = [];
    if (type && ITEM_TYPES.includes(String(type))) {
      sql += ' AND c.item_type = ?';
      params.push(String(type));
    }
    sql += ' ORDER BY c.item_type, c.name';
    return {
      categories: ctx.db.prepare(sql).all(...params).map((c) => ({
        id: c.id,
        code: c.code,
        name: c.name,
        parentId: c.parent_id,
        parentName: c.parent_name || '',
        itemType: c.item_type,
        active: !!c.active,
      })),
    };
  });

  router.get('/api/procurement/uoms', async (ctx) => {
    auth.guard(ctx.user, 'item.view');
    return {
      uoms: ctx.db.prepare('SELECT id, code, name FROM uoms WHERE active = 1 ORDER BY name').all(),
    };
  });
};
