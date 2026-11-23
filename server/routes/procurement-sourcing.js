'use strict';

/**
 * Procurement sourcing — RFQs, vendor quotations and comparative statements.
 *
 * Additive only: endpoints live under /api/procurement and use the Phase 1b
 * tables created by server/procurement/schema.js. ABMDAS is untouched.
 */

const auth = require('../auth');
const { HttpError } = require('../http');
const {
  audit, notify, nowIso, today, round2, getSetting,
  nextRfqNo, nextQuotationNo, nextComparativeNo,
} = require('../util');
const {
  unitScope, inList, requireText, optionalText, optionalId, optionalDate,
  ensureUnit, transaction, pageParams, ensureVendor, rowOr404,
} = require('../procurement/shared');
const tax = require('../procurement/tax');

const REQUIREMENT_TYPES = ['consumable', 'asset', 'service'];
const RFQ_STATUSES = ['draft', 'issued', 'closed', 'cancelled'];
const QUOTATION_STATUSES = ['received', 'shortlisted', 'rejected', 'awarded', 'withdrawn'];
const CS_STATUSES = ['draft', 'pending', 'approved', 'rejected', 'cancelled'];

/* Server-side default used when the settings row has not been seeded yet.
 * The canonical default is stored under procurement.general_terms. */
const DEFAULT_GENERAL_TERMS = [
  '1. Any items that are damaged during transportation or unloading and also when noticed during unboxing must be replaced at no cost to NLAGC',
  '2. Materials shall be dispatched with DC, Invoice, without those documents the materials will not be unloaded and the same will be returned.',
  '3. Any variations in size / Product No / quality / appearance / colour will not be acceptable and the same to be replaced without any additional cost and time.',
].join('\n');

function defaultGeneralTerms() {
  return getSetting('procurement.general_terms', DEFAULT_GENERAL_TERMS) || DEFAULT_GENERAL_TERMS;
}

/* ------------------------------------------------------------------ */
/* Row helpers                                                         */
/* ------------------------------------------------------------------ */
function rfqOut(row) {
  return {
    id: row.id,
    rfqNo: row.rfq_no,
    unitId: row.unit_id,
    unitName: row.unit_name || '',
    departmentId: row.department_id,
    departmentName: row.department_name || '',
    requisitionId: row.requisition_id,
    requisitionNo: row.requisition_no || '',
    requirementType: row.requirement_type,
    title: row.title || '',
    purpose: row.purpose || '',
    status: row.status,
    issueDate: row.issue_date,
    closingDate: row.closing_date,
    terms: row.terms || '',
    generalTerms: row.general_terms || '',
    createdBy: row.created_by,
    createdByName: row.created_by_name || '',
    issuedAt: row.issued_at,
    closedAt: row.closed_at,
    cancelReason: row.cancel_reason || '',
    itemCount: Number(row.item_count) || 0,
    vendorCount: Number(row.vendor_count) || 0,
    quotationCount: Number(row.quotation_count) || 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function quotationOut(row) {
  return {
    id: row.id,
    quotationNo: row.quotation_no,
    rfqId: row.rfq_id,
    rfqNo: row.rfq_no || '',
    vendorId: row.vendor_id,
    vendorCode: row.vendor_code || '',
    vendorName: row.vendor_name || '',
    quotationDate: row.quotation_date,
    validUntil: row.valid_until,
    subtotal: round2(row.subtotal),
    taxAmount: round2(row.tax_amount),
    discountPercent: Number(row.discount_percent) || 0,
    discountAmount: Number(row.discount_amount) || 0,
    baseTotalAmount: round2(round2(row.total_amount) - round2(row.round_off)),
    roundOff: round2(row.round_off),
    totalAmount: round2(row.total_amount),
    generalTerms: row.general_terms || '',
    deliveryDays: Number(row.delivery_days) || 0,
    paymentTerms: row.payment_terms || '',
    warrantyTerms: row.warranty_terms || '',
    remarks: row.remarks || '',
    status: row.status,
    itemCount: Number(row.item_count) || 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function comparativeOut(row) {
  return {
    id: row.id,
    csNo: row.cs_no,
    rfqId: row.rfq_id,
    rfqNo: row.rfq_no || '',
    status: row.status,
    recommendedQuotationId: row.recommended_quotation_id,
    recommendedQuotationNo: row.recommended_quotation_no || '',
    recommendedVendorName: row.recommended_vendor_name || '',
    recommendationNotes: row.recommendation_notes || '',
    totalQuoted: round2(row.total_quoted),
    preparedBy: row.prepared_by,
    preparedByName: row.prepared_by_name || '',
    preparedAt: row.prepared_at,
    approvedBy: row.approved_by,
    approvedByName: row.approved_by_name || '',
    approvedAt: row.approved_at,
    rejectedAt: row.rejected_at,
    rejectionReason: row.rejection_reason || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function getRfq(ctx, id) {
  const ids = unitScope(ctx);
  return rowOr404(
    ctx.db
      .prepare(
        `SELECT r.*, u.name AS unit_name, d.name AS department_name,
                rq.requisition_no, cu.name AS created_by_name,
                (SELECT COUNT(*) FROM rfq_items ri WHERE ri.rfq_id = r.id) AS item_count,
                (SELECT COUNT(*) FROM rfq_vendors rv
                  WHERE rv.rfq_id = r.id AND rv.status <> 'withdrawn') AS vendor_count,
                (SELECT COUNT(*) FROM quotations q
                  WHERE q.rfq_id = r.id AND q.deleted_at IS NULL) AS quotation_count
           FROM rfqs r
           JOIN units u ON u.id = r.unit_id
           LEFT JOIN departments d ON d.id = r.department_id
           LEFT JOIN requisitions rq ON rq.id = r.requisition_id
           JOIN users cu ON cu.id = r.created_by
          WHERE r.id = ? AND r.deleted_at IS NULL AND r.unit_id IN (${inList(ids)})`
      )
      .get(Number(id), ...ids),
    'RFQ not found.'
  );
}

function rfqItems(db, rfqId) {
  return db
    .prepare(
      `SELECT ri.*, i.item_code, i.name AS item_name, i.item_type, i.track_inventory,
              u.code AS uom_code, u.name AS uom_name
         FROM rfq_items ri
         LEFT JOIN items i ON i.id = ri.item_id
         LEFT JOIN uoms u ON u.id = COALESCE(ri.uom_id, i.uom_id)
        WHERE ri.rfq_id = ?
        ORDER BY ri.id`
    )
    .all(rfqId)
    .map((row) => ({
      id: row.id,
      requisitionItemId: row.requisition_item_id,
      itemId: row.item_id,
      itemCode: row.item_code || '',
      itemName: row.item_name || row.description || '',
      itemType: row.item_type || '',
      description: row.description || '',
      uomId: row.uom_id,
      uomCode: row.uom_code || '',
      uomName: row.uom_name || '',
      quantity: Number(row.quantity) || 0,
      estimatedUnitCost: Number(row.estimated_unit_cost) || 0,
      trackInventory: !!row.track_inventory,
    }));
}

function rfqVendors(db, rfqId) {
  return db
    .prepare(
      `SELECT rv.*, v.code AS vendor_code, v.name AS vendor_name, v.status AS vendor_status
         FROM rfq_vendors rv
         JOIN vendors v ON v.id = rv.vendor_id
        WHERE rv.rfq_id = ?
        ORDER BY v.name COLLATE NOCASE`
    )
    .all(rfqId)
    .map((row) => ({
      id: row.id,
      vendorId: row.vendor_id,
      vendorCode: row.vendor_code,
      vendorName: row.vendor_name,
      vendorStatus: row.vendor_status,
      status: row.status,
      invitedAt: row.invited_at,
      respondedAt: row.responded_at,
      remarks: row.remarks || '',
    }));
}

function getQuotation(ctx, id) {
  const ids = unitScope(ctx);
  return rowOr404(
    ctx.db
      .prepare(
        `SELECT q.*, r.rfq_no, r.unit_id, v.code AS vendor_code, v.name AS vendor_name,
                (SELECT COUNT(*) FROM quotation_items qi WHERE qi.quotation_id = q.id) AS item_count
           FROM quotations q
           JOIN rfqs r ON r.id = q.rfq_id
           JOIN vendors v ON v.id = q.vendor_id
          WHERE q.id = ? AND q.deleted_at IS NULL AND r.unit_id IN (${inList(ids)})`
      )
      .get(Number(id), ...ids),
    'Quotation not found.'
  );
}

function quotationItems(db, quotationId) {
  return db
    .prepare(
      `SELECT qi.*, i.item_code, i.name AS item_name, u.code AS uom_code
         FROM quotation_items qi
         LEFT JOIN items i ON i.id = qi.item_id
         LEFT JOIN uoms u ON u.id = COALESCE(qi.uom_id, i.uom_id)
        WHERE qi.quotation_id = ?
        ORDER BY qi.id`
    )
    .all(quotationId)
    .map((row) => ({
      id: row.id,
      rfqItemId: row.rfq_item_id,
      itemId: row.item_id,
      itemCode: row.item_code || '',
      itemName: row.item_name || row.description || '',
      description: row.description || '',
      uomId: row.uom_id,
      uomCode: row.uom_code || '',
      quantity: Number(row.quantity) || 0,
      unitPrice: Number(row.unit_price) || 0,
      discountPercent: Number(row.discount_percent) || 0,
      discountAmount: Number(row.discount_amount) || 0,
      taxRate: Number(row.tax_rate) || 0,
      taxInclusive: !!row.tax_inclusive,
      taxableAmount: Number(row.taxable_amount) || 0,
      taxAmount: Number(row.tax_amount) || 0,
      totalAmount: Number(row.total_amount) || 0,
      deliveryDays: Number(row.delivery_days) || 0,
      remarks: row.remarks || '',
    }));
}

function getComparative(ctx, id) {
  const ids = unitScope(ctx);
  return rowOr404(
    ctx.db
      .prepare(
        `SELECT c.*, r.rfq_no, r.unit_id,
                q.quotation_no AS recommended_quotation_no,
                v.name AS recommended_vendor_name,
                pu.name AS prepared_by_name, au.name AS approved_by_name
           FROM comparative_statements c
           JOIN rfqs r ON r.id = c.rfq_id
           LEFT JOIN quotations q ON q.id = c.recommended_quotation_id
           LEFT JOIN vendors v ON v.id = q.vendor_id
           JOIN users pu ON pu.id = c.prepared_by
           LEFT JOIN users au ON au.id = c.approved_by
          WHERE c.id = ? AND r.unit_id IN (${inList(ids)})`
      )
      .get(Number(id), ...ids),
    'Comparative statement not found.'
  );
}

/* ------------------------------------------------------------------ */
/* Payload helpers                                                     */
/* ------------------------------------------------------------------ */
function freeTextLabel(name, description, max = 300) {
  const cleanName = String(name || '').trim();
  const cleanDesc = String(description || '').trim();
  if (!cleanName) return cleanDesc.slice(0, max);
  if (!cleanDesc || cleanDesc === cleanName) return cleanName.slice(0, max);
  return `${cleanName} \u2014 ${cleanDesc}`.slice(0, max);
}

function rfqLines(ctx, body) {
  const list = Array.isArray(body.items) ? body.items : [];
  if (!list.length) throw new HttpError(400, 'Add at least one item to the RFQ.');
  if (list.length > 100) throw new HttpError(400, 'An RFQ can hold at most 100 lines.');

  return list.map((line, index) => {
    const rawItemId = Number(line.itemId);
    const hasItem = Number.isInteger(rawItemId) && rawItemId > 0;
    let item = null;
    if (hasItem) {
      item = ctx.db.prepare('SELECT * FROM items WHERE id = ? AND deleted_at IS NULL AND active = 1').get(rawItemId);
      if (!item) throw new HttpError(400, `Line ${index + 1}: item was not found or is inactive.`);
    }
    const typedName = String(line.itemName || line.description || '').trim().slice(0, 300);
    if (!hasItem && !typedName) {
      throw new HttpError(400, `Line ${index + 1}: select an item or type an item name.`);
    }
    const quantity = Number(line.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new HttpError(400, `Line ${index + 1}: quantity must be greater than zero.`);
    }
    const rawCost = line.estimatedUnitCost;
    const cost = rawCost === undefined || rawCost === null || rawCost === ''
      ? Number(item?.standard_cost) || 0
      : Number(rawCost);
    if (!Number.isFinite(cost) || cost < 0) {
      throw new HttpError(400, `Line ${index + 1}: estimated unit cost cannot be negative.`);
    }
    return {
      requisitionItemId: line.requisitionItemId ? Number(line.requisitionItemId) : null,
      itemId: hasItem ? rawItemId : null,
      description: hasItem
        ? (String(line.description || '').trim().slice(0, 300) || item.name)
        : freeTextLabel(typedName, line.description),
      uomId: Number(line.uomId) || (item ? item.uom_id : null) || null,
      quantity: round2(quantity),
      estimatedUnitCost: round2(cost),
    };
  });
}

function replaceRfqItems(db, rfqId, lines, now) {
  db.prepare('DELETE FROM rfq_items WHERE rfq_id = ?').run(rfqId);
  const insert = db.prepare(
    `INSERT INTO rfq_items(rfq_id, requisition_item_id, item_id, description, uom_id,
       quantity, estimated_unit_cost, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?)`
  );
  for (const line of lines) {
    insert.run(
      rfqId, line.requisitionItemId || null, line.itemId, line.description, line.uomId,
      line.quantity, line.estimatedUnitCost, now, now
    );
  }
}

function invitedVendorIds(ctx, body, existing) {
  let list = body.vendorIds;
  if (list === undefined && Array.isArray(body.vendors)) {
    list = body.vendors.map((v) => (typeof v === 'object' ? v.vendorId : v));
  }
  if (list === undefined) {
    if (existing) return null;
    return [];
  }
  if (!Array.isArray(list)) throw new HttpError(400, 'Vendors must be a list of vendor ids.');
  const ids = [...new Set(list.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  for (const id of ids) ensureVendor(ctx.db, id);
  return ids;
}

function saveRfqVendors(db, rfqId, ids, now) {
  if (ids == null) return;
  const existing = db.prepare('SELECT vendor_id FROM rfq_vendors WHERE rfq_id = ?').all(rfqId).map((r) => r.vendor_id);
  const keep = new Set(ids);
  for (const vendorId of existing) {
    if (!keep.has(vendorId)) {
      /* A vendor that already quoted cannot be silently dropped. */
      const quote = db
        .prepare('SELECT 1 FROM quotations WHERE rfq_id = ? AND vendor_id = ? AND deleted_at IS NULL')
        .get(rfqId, vendorId);
      if (quote) throw new HttpError(400, 'A vendor with a recorded quotation cannot be removed from the RFQ.');
      db.prepare('DELETE FROM rfq_vendors WHERE rfq_id = ? AND vendor_id = ?').run(rfqId, vendorId);
    }
  }
  const insert = db.prepare(
    `INSERT INTO rfq_vendors(rfq_id, vendor_id, status, invited_at, created_at)
     VALUES (?,?, 'invited', ?, ?)
     ON CONFLICT(rfq_id, vendor_id) DO NOTHING`
  );
  for (const id of ids) insert.run(rfqId, id, now, now);
}

function rfqPayload(ctx, body, existing, requisition) {
  const requisitionRow = requisition || (existing?.requisition_id
    ? ctx.db.prepare('SELECT * FROM requisitions WHERE id = ?').get(existing.requisition_id)
    : null);
  const unitId = ensureUnit(ctx, body.unitId ?? existing?.unit_id ?? requisitionRow?.unit_id);
  let departmentId = body.departmentId === undefined
    ? (existing?.department_id ?? requisitionRow?.department_id ?? null)
    : optionalId(body, 'departmentId');
  if (departmentId) {
    const dept = ctx.db.prepare('SELECT id FROM departments WHERE id = ?').get(departmentId);
    if (!dept) throw new HttpError(400, 'Department was not found.');
  } else {
    departmentId = null;
  }
  const requirementType = String(body.requirementType || existing?.requirement_type || requisitionRow?.requirement_type || '');
  if (!REQUIREMENT_TYPES.includes(requirementType)) {
    throw new HttpError(400, 'Requirement type must be consumable, asset or service.');
  }
  const fallbackTitle = existing?.title
    || (requisitionRow ? `Sourcing for ${requisitionRow.requisition_no}` : '');
  const titleInput = body.title !== undefined ? body.title : fallbackTitle;
  const title = requireText({ title: titleInput }, 'title', 'RFQ title', 200);

  return {
    unitId,
    departmentId,
    requirementType,
    title,
    purpose: body.purpose === undefined
      ? (existing?.purpose || requisitionRow?.purpose || '')
      : optionalText(body, 'purpose', 500),
    closingDate: body.closingDate === undefined ? (existing?.closing_date || null) : optionalDate(body, 'closingDate'),
    terms: body.terms === undefined ? (existing?.terms || '') : optionalText(body, 'terms', 2000),
    /* RFQ forms prefill from the procurement.general_terms setting. */
    generalTerms: body.generalTerms === undefined
      ? (existing?.general_terms ?? defaultGeneralTerms())
      : optionalText(body, 'generalTerms', 5000),
    items: body.items === undefined && (existing || requisitionRow) ? null : rfqLines(ctx, body),
    vendorIds: invitedVendorIds(ctx, body, existing),
  };
}

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */
module.exports = function registerProcurementSourcingRoutes(router) {
  /* ------------------------------ Meta ---------------------------- */
  router.get('/api/procurement/sourcing/meta', async (ctx) => {
    auth.guard(ctx.user, 'sourcing.view');
    const ids = unitScope(ctx);
    const ph = inList(ids);
    const requisitions = ctx.db
      .prepare(
        `SELECT r.id, r.requisition_no, r.unit_id, r.department_id, r.requirement_type,
                r.purpose, r.status,
                (SELECT COALESCE(SUM(ri.estimated_total), 0)
                   FROM requisition_items ri WHERE ri.requisition_id = r.id) AS estimated_total
           FROM requisitions r
          WHERE r.deleted_at IS NULL AND r.status = 'sourcing' AND r.unit_id IN (${ph})
          ORDER BY r.created_at DESC`
      )
      .all(...ids)
      .map((row) => ({
        id: row.id,
        requisitionNo: row.requisition_no,
        unitId: row.unit_id,
        departmentId: row.department_id,
        requirementType: row.requirement_type,
        purpose: row.purpose || '',
        estimatedTotal: round2(row.estimated_total),
      }));
    const vendors = ctx.db
      .prepare(
        `SELECT id, code, name, status, gst_number FROM vendors
          WHERE status <> 'Blacklisted' ORDER BY name COLLATE NOCASE LIMIT 1000`
      )
      .all()
      .map((row) => ({ id: row.id, code: row.code, name: row.name, status: row.status, gstNumber: row.gst_number || '' }));
    const units = ctx.db.prepare(`SELECT id, code, name FROM units WHERE id IN (${ph}) ORDER BY name`).all(...ids);
    const departments = ctx.db.prepare('SELECT id, code, name FROM departments WHERE active = 1 ORDER BY name').all();
    return {
      requisitions,
      vendors,
      units,
      departments,
      statuses: RFQ_STATUSES.map((value) => ({ value, label: value.replace(/_/g, ' ') })),
      quotationStatuses: QUOTATION_STATUSES.map((value) => ({ value, label: value.replace(/_/g, ' ') })),
      requirementTypes: REQUIREMENT_TYPES.map((value) => ({ value, label: value.replace(/_/g, ' ') })),
      generalTerms: defaultGeneralTerms(),
      today: today(),
    };
  });

  /* ------------------------------- RFQs --------------------------- */
  router.get('/api/procurement/rfqs', async (ctx) => {
    auth.guard(ctx.user, 'sourcing.view');
    const ids = unitScope(ctx);
    const q = ctx.query || {};
    const where = ['r.deleted_at IS NULL', `r.unit_id IN (${inList(ids)})`];
    const params = [...ids];
    if (q.search) {
      const like = `%${String(q.search).trim()}%`;
      where.push('(r.rfq_no LIKE ? OR r.title LIKE ? OR rq.requisition_no LIKE ?)');
      params.push(like, like, like);
    }
    if (q.status && RFQ_STATUSES.includes(String(q.status))) {
      where.push('r.status = ?');
      params.push(String(q.status));
    }
    if (q.requisitionId) {
      where.push('r.requisition_id = ?');
      params.push(Number(q.requisitionId));
    }
    const { page, pageSize, offset } = pageParams(q);
    const total = ctx.db
      .prepare(
        `SELECT COUNT(*) AS c FROM rfqs r
           LEFT JOIN requisitions rq ON rq.id = r.requisition_id
          WHERE ${where.join(' AND ')}`
      )
      .get(...params).c;
    const rows = ctx.db
      .prepare(
        `SELECT r.*, u.name AS unit_name, d.name AS department_name, rq.requisition_no,
                cu.name AS created_by_name,
                (SELECT COUNT(*) FROM rfq_items ri WHERE ri.rfq_id = r.id) AS item_count,
                (SELECT COUNT(*) FROM rfq_vendors rv
                  WHERE rv.rfq_id = r.id AND rv.status <> 'withdrawn') AS vendor_count,
                (SELECT COUNT(*) FROM quotations q
                  WHERE q.rfq_id = r.id AND q.deleted_at IS NULL) AS quotation_count
           FROM rfqs r
           JOIN units u ON u.id = r.unit_id
           LEFT JOIN departments d ON d.id = r.department_id
           LEFT JOIN requisitions rq ON rq.id = r.requisition_id
           JOIN users cu ON cu.id = r.created_by
          WHERE ${where.join(' AND ')}
          ORDER BY r.created_at DESC, r.id DESC
          LIMIT ? OFFSET ?`
      )
      .all(...params, pageSize, offset);
    return { rfqs: rows.map(rfqOut), total, page, pageSize };
  });

  router.post('/api/procurement/rfqs', async (ctx) => {
    auth.guard(ctx.user, 'sourcing.manage');
    const body = ctx.body || {};
    const requisitionId = optionalId(body, 'requisitionId');
    let requisition = null;
    if (requisitionId) {
      requisition = rowOr404(
        ctx.db.prepare('SELECT * FROM requisitions WHERE id = ? AND deleted_at IS NULL').get(requisitionId),
        'Requisition not found.'
      );
      if (!unitScope(ctx).includes(Number(requisition.unit_id))) {
        throw new HttpError(403, 'You are not a member of the requisition unit.');
      }
      if (requisition.status !== 'sourcing') {
        throw new HttpError(400, 'Only a requisition awaiting sourcing can be used to create an RFQ.');
      }
      const open = ctx.db
        .prepare(
          `SELECT 1 FROM rfqs WHERE requisition_id = ? AND status IN ('draft','issued') AND deleted_at IS NULL`
        )
        .get(requisitionId);
      if (open) throw new HttpError(400, 'An open RFQ already exists for this requisition.');
    }

    const payload = rfqPayload(ctx, {
      ...body,
      unitId: body.unitId ?? requisition?.unit_id,
      departmentId: body.departmentId ?? requisition?.department_id,
      requirementType: body.requirementType ?? requisition?.requirement_type,
      title: body.title ?? (requisition ? `Sourcing for ${requisition.requisition_no}` : undefined),
      purpose: body.purpose ?? requisition?.purpose,
    }, null, requisition);

    let lines = payload.items;
    if (!lines && requisition) {
      lines = ctx.db
        .prepare(
          `SELECT ri.id AS requisition_item_id, ri.item_id, ri.item_name, ri.description, ri.uom_id,
                  ri.quantity, ri.estimated_unit_cost
             FROM requisition_items ri
            WHERE ri.requisition_id = ?
            ORDER BY ri.id`
        )
        .all(requisition.id)
        .map((row) => ({
          requisitionItemId: row.requisition_item_id,
          itemId: row.item_id,
          description: row.item_id ? row.description : freeTextLabel(row.item_name, row.description),
          uomId: row.uom_id,
          quantity: Number(row.quantity),
          estimatedUnitCost: Number(row.estimated_unit_cost),
        }));
    }
    if (!lines || !lines.length) throw new HttpError(400, 'Add at least one item to the RFQ.');

    const rfqNo = nextRfqNo();
    const now = nowIso();
    let id;
    transaction(ctx.db, () => {
      const res = ctx.db
        .prepare(
          `INSERT INTO rfqs(rfq_no, unit_id, department_id, requisition_id, requirement_type, title,
             purpose, status, closing_date, terms, general_terms, created_by, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,'draft',?,?,?,?,?,?)`
        )
        .run(
          rfqNo, payload.unitId, payload.departmentId, requisitionId, payload.requirementType,
          payload.title, payload.purpose, payload.closingDate, payload.terms, payload.generalTerms,
          ctx.user.id, now, now
        );
      id = Number(res.lastInsertRowid);
      replaceRfqItems(ctx.db, id, lines, now);
      if (payload.vendorIds && payload.vendorIds.length) saveRfqVendors(ctx.db, id, payload.vendorIds, now);
    });
    audit(ctx, 'CREATE', 'rfq', id, null, {
      rfqNo, requisitionId, itemCount: lines.length,
      vendorCount: payload.vendorIds?.length || 0,
      generalTerms: payload.generalTerms,
    });
    return { id, rfqNo, status: 'draft' };
  });

  router.get('/api/procurement/rfqs/:id', async (ctx) => {
    auth.guard(ctx.user, 'sourcing.view');
    const rfq = getRfq(ctx, ctx.params.id);
    const items = rfqItems(ctx.db, rfq.id);
    const vendors = rfqVendors(ctx.db, rfq.id);
    const quotations = ctx.db
      .prepare(
        `SELECT q.*, r.rfq_no, v.code AS vendor_code, v.name AS vendor_name,
                (SELECT COUNT(*) FROM quotation_items qi WHERE qi.quotation_id = q.id) AS item_count
           FROM quotations q
           JOIN rfqs r ON r.id = q.rfq_id
           JOIN vendors v ON v.id = q.vendor_id
          WHERE q.rfq_id = ? AND q.deleted_at IS NULL
          ORDER BY q.total_amount ASC, q.id`
      )
      .all(rfq.id)
      .map(quotationOut);
    const statements = ctx.db
      .prepare(
        `SELECT c.*, r.rfq_no, q.quotation_no AS recommended_quotation_no,
                v.name AS recommended_vendor_name,
                pu.name AS prepared_by_name, au.name AS approved_by_name
           FROM comparative_statements c
           JOIN rfqs r ON r.id = c.rfq_id
           LEFT JOIN quotations q ON q.id = c.recommended_quotation_id
           LEFT JOIN vendors v ON v.id = q.vendor_id
           JOIN users pu ON pu.id = c.prepared_by
           LEFT JOIN users au ON au.id = c.approved_by
          WHERE c.rfq_id = ?
          ORDER BY c.id DESC`
      )
      .all(rfq.id)
      .map(comparativeOut);
    const approved = statements.some((s) => s.status === 'approved');
    return {
      rfq: rfqOut(rfq),
      items,
      vendors,
      quotations,
      comparativeStatements: statements,
      actions: {
        canEdit: rfq.status === 'draft' && auth.can(ctx.user, 'sourcing.manage'),
        canIssue: rfq.status === 'draft' && auth.can(ctx.user, 'sourcing.manage'),
        canClose: rfq.status === 'issued' && auth.can(ctx.user, 'sourcing.manage'),
        canCancel: !approved && ['draft', 'issued'].includes(rfq.status) && auth.can(ctx.user, 'sourcing.manage'),
        canDelete: rfq.status === 'draft' && auth.can(ctx.user, 'sourcing.manage'),
        canQuote: rfq.status === 'issued' && auth.can(ctx.user, 'sourcing.manage'),
        canCompare: rfq.status === 'issued' && quotations.length > 0 && auth.can(ctx.user, 'sourcing.manage'),
        canCreatePurchaseOrder: approved && auth.can(ctx.user, 'po.manage'),
      },
    };
  });

  router.put('/api/procurement/rfqs/:id', async (ctx) => {
    auth.guard(ctx.user, 'sourcing.manage');
    const rfq = getRfq(ctx, ctx.params.id);
    if (rfq.status !== 'draft') throw new HttpError(400, 'Only draft RFQs can be edited.');
    const payload = rfqPayload(ctx, ctx.body || {}, rfq);
    const now = nowIso();
    transaction(ctx.db, () => {
      ctx.db
        .prepare(
          `UPDATE rfqs SET unit_id=?, department_id=?, requirement_type=?, title=?, purpose=?,
             closing_date=?, terms=?, general_terms=?, updated_at=? WHERE id=?`
        )
        .run(
          payload.unitId, payload.departmentId, payload.requirementType, payload.title,
          payload.purpose, payload.closingDate, payload.terms, payload.generalTerms, now, rfq.id
        );
      if (payload.items) replaceRfqItems(ctx.db, rfq.id, payload.items, now);
      saveRfqVendors(ctx.db, rfq.id, payload.vendorIds, now);
    });
    audit(ctx, 'UPDATE', 'rfq', rfq.id, {
      rfqNo: rfq.rfq_no, generalTerms: rfq.general_terms || '',
    }, { title: payload.title, generalTerms: payload.generalTerms });
    return { ok: true };
  });

  router.delete('/api/procurement/rfqs/:id', async (ctx) => {
    auth.guard(ctx.user, 'sourcing.manage');
    const rfq = getRfq(ctx, ctx.params.id);
    if (rfq.status !== 'draft') throw new HttpError(400, 'Only draft RFQs can be deleted. Cancel issued RFQs instead.');
    const now = nowIso();
    ctx.db
      .prepare('UPDATE rfqs SET deleted_at=?, deleted_by=?, delete_reason=?, updated_at=? WHERE id=?')
      .run(now, ctx.user.id, optionalText(ctx.body || {}, 'reason', 300), now, rfq.id);
    audit(ctx, 'DELETE', 'rfq', rfq.id, { rfqNo: rfq.rfq_no }, { deletedAt: now });
    return { ok: true };
  });

  router.post('/api/procurement/rfqs/:id/issue', async (ctx) => {
    auth.guard(ctx.user, 'sourcing.manage');
    const rfq = getRfq(ctx, ctx.params.id);
    if (rfq.status !== 'draft') throw new HttpError(400, 'Only draft RFQs can be issued.');
    if (!rfqItems(ctx.db, rfq.id).length) throw new HttpError(400, 'Add at least one item before issuing.');
    if (!rfqVendors(ctx.db, rfq.id).length) throw new HttpError(400, 'Invite at least one vendor before issuing.');
    const now = nowIso();
    ctx.db
      .prepare("UPDATE rfqs SET status='issued', issue_date=?, issued_at=?, updated_at=? WHERE id=?")
      .run(today(), now, now, rfq.id);
    notify(
      [rfq.created_by],
      'RFQ issued',
      `${rfq.rfq_no} — ${rfq.title}`,
      `/sourcing/${rfq.id}`
    );
    audit(ctx, 'ISSUE', 'rfq', rfq.id, { status: 'draft' }, { status: 'issued' });
    return { ok: true, status: 'issued' };
  });

  router.post('/api/procurement/rfqs/:id/close', async (ctx) => {
    auth.guard(ctx.user, 'sourcing.manage');
    const rfq = getRfq(ctx, ctx.params.id);
    if (rfq.status !== 'issued') throw new HttpError(400, 'Only issued RFQs can be closed.');
    const now = nowIso();
    ctx.db
      .prepare("UPDATE rfqs SET status='closed', closed_at=?, updated_at=? WHERE id=?")
      .run(now, now, rfq.id);
    audit(ctx, 'CLOSE', 'rfq', rfq.id, { status: 'issued' }, { status: 'closed' });
    return { ok: true, status: 'closed' };
  });

  router.post('/api/procurement/rfqs/:id/cancel', async (ctx) => {
    auth.guard(ctx.user, 'sourcing.manage');
    const rfq = getRfq(ctx, ctx.params.id);
    if (!['draft', 'issued'].includes(rfq.status)) throw new HttpError(400, 'This RFQ cannot be cancelled.');
    const approved = ctx.db
      .prepare("SELECT 1 FROM comparative_statements WHERE rfq_id = ? AND status = 'approved'")
      .get(rfq.id);
    if (approved) throw new HttpError(400, 'An RFQ with an approved comparative statement cannot be cancelled.');
    const reason = requireText(ctx.body || {}, 'reason', 'Cancellation reason', 500);
    const now = nowIso();
    ctx.db
      .prepare("UPDATE rfqs SET status='cancelled', cancel_reason=?, updated_at=? WHERE id=?")
      .run(reason, now, rfq.id);
    audit(ctx, 'CANCEL', 'rfq', rfq.id, { status: rfq.status }, { status: 'cancelled', reason });
    return { ok: true, status: 'cancelled' };
  });

  router.post('/api/procurement/rfqs/:id/vendors', async (ctx) => {
    auth.guard(ctx.user, 'sourcing.manage');
    const rfq = getRfq(ctx, ctx.params.id);
    if (!['draft', 'issued'].includes(rfq.status)) throw new HttpError(400, 'Vendors cannot be added to this RFQ.');
    const vendorId = optionalId(ctx.body || {}, 'vendorId');
    if (!vendorId) throw new HttpError(400, 'Select a vendor.');
    ensureVendor(ctx.db, vendorId);
    const now = nowIso();
    ctx.db
      .prepare(
        `INSERT INTO rfq_vendors(rfq_id, vendor_id, status, invited_at, created_at, remarks)
         VALUES (?,?, 'invited', ?, ?, ?)
         ON CONFLICT(rfq_id, vendor_id) DO UPDATE SET status = 'invited', remarks = excluded.remarks`
      )
      .run(rfq.id, vendorId, now, now, optionalText(ctx.body || {}, 'remarks', 300));
    audit(ctx, 'INVITE', 'rfq', rfq.id, null, { vendorId });
    return { ok: true };
  });

  router.delete('/api/procurement/rfqs/:id/vendors/:vendorId', async (ctx) => {
    auth.guard(ctx.user, 'sourcing.manage');
    const rfq = getRfq(ctx, ctx.params.id);
    if (rfq.status !== 'draft') throw new HttpError(400, 'Vendors can only be removed from draft RFQs.');
    const vendorId = Number(ctx.params.vendorId);
    const quote = ctx.db
      .prepare('SELECT 1 FROM quotations WHERE rfq_id = ? AND vendor_id = ? AND deleted_at IS NULL')
      .get(rfq.id, vendorId);
    if (quote) throw new HttpError(400, 'A vendor with a recorded quotation cannot be removed.');
    ctx.db.prepare('DELETE FROM rfq_vendors WHERE rfq_id = ? AND vendor_id = ?').run(rfq.id, vendorId);
    audit(ctx, 'UNINVITE', 'rfq', rfq.id, { vendorId }, null);
    return { ok: true };
  });

  /* --------------------------- Quotations ------------------------- */
  router.get('/api/procurement/quotations', async (ctx) => {
    auth.guard(ctx.user, 'sourcing.view');
    const ids = unitScope(ctx);
    const q = ctx.query || {};
    const where = ['q.deleted_at IS NULL', `r.unit_id IN (${inList(ids)})`];
    const params = [...ids];
    if (q.rfqId) {
      where.push('q.rfq_id = ?');
      params.push(Number(q.rfqId));
    }
    if (q.vendorId) {
      where.push('q.vendor_id = ?');
      params.push(Number(q.vendorId));
    }
    if (q.status && QUOTATION_STATUSES.includes(String(q.status))) {
      where.push('q.status = ?');
      params.push(String(q.status));
    }
    const { page, pageSize, offset } = pageParams(q);
    const total = ctx.db
      .prepare(
        `SELECT COUNT(*) AS c FROM quotations q JOIN rfqs r ON r.id = q.rfq_id
          WHERE ${where.join(' AND ')}`
      )
      .get(...params).c;
    const rows = ctx.db
      .prepare(
        `SELECT q.*, r.rfq_no, v.code AS vendor_code, v.name AS vendor_name,
                (SELECT COUNT(*) FROM quotation_items qi WHERE qi.quotation_id = q.id) AS item_count
           FROM quotations q
           JOIN rfqs r ON r.id = q.rfq_id
           JOIN vendors v ON v.id = q.vendor_id
          WHERE ${where.join(' AND ')}
          ORDER BY q.created_at DESC, q.id DESC
          LIMIT ? OFFSET ?`
      )
      .all(...params, pageSize, offset);
    return { quotations: rows.map(quotationOut), total, page, pageSize };
  });

  router.post('/api/procurement/rfqs/:id/quotations', async (ctx) => {
    auth.guard(ctx.user, 'sourcing.manage');
    const rfq = getRfq(ctx, ctx.params.id);
    if (rfq.status !== 'issued') throw new HttpError(400, 'Quotations can only be recorded against an issued RFQ.');
    const body = ctx.body || {};
    const vendorId = optionalId(body, 'vendorId');
    if (!vendorId) throw new HttpError(400, 'Select the quoting vendor.');
    ensureVendor(ctx.db, vendorId);
    const invitation = ctx.db
      .prepare('SELECT * FROM rfq_vendors WHERE rfq_id = ? AND vendor_id = ?')
      .get(rfq.id, vendorId);
    if (!invitation || invitation.status === 'withdrawn') {
      throw new HttpError(400, 'Only invited vendors can quote on this RFQ.');
    }
    const duplicate = ctx.db
      .prepare('SELECT 1 FROM quotations WHERE rfq_id = ? AND vendor_id = ? AND deleted_at IS NULL')
      .get(rfq.id, vendorId);
    if (duplicate) throw new HttpError(400, 'This vendor has already submitted a quotation for the RFQ.');

    const rfqLines = rfqItems(ctx.db, rfq.id);
    const lineMap = new Map(rfqLines.map((line) => [line.id, line]));
    const list = Array.isArray(body.items) ? body.items : [];
    if (!list.length) throw new HttpError(400, 'Add at least one quotation line.');
    const seen = new Set();
    const lines = list.map((line, index) => {
      const rfqItemId = Number(line.rfqItemId);
      const rfqLine = lineMap.get(rfqItemId);
      if (!rfqLine) throw new HttpError(400, `Line ${index + 1}: RFQ item was not found.`);
      if (seen.has(rfqItemId)) throw new HttpError(400, `Line ${index + 1}: RFQ item is repeated.`);
      seen.add(rfqItemId);
      const quantity = line.quantity === undefined || line.quantity === ''
        ? rfqLine.quantity
        : Number(line.quantity);
      if (!Number.isFinite(quantity) || quantity <= 0) {
        throw new HttpError(400, `Line ${index + 1}: quantity must be greater than zero.`);
      }
      const unitPrice = Number(line.unitPrice);
      if (!Number.isFinite(unitPrice) || unitPrice < 0) {
        throw new HttpError(400, `Line ${index + 1}: unit price cannot be negative.`);
      }
      const deliveryDays = Number(line.deliveryDays) || 0;
      if (deliveryDays < 0) throw new HttpError(400, `Line ${index + 1}: delivery days cannot be negative.`);
      const calc = tax.parseLine(
        { ...line, quantity, unitPrice },
        index,
        tax.itemDefaults(ctx.db, rfqLine.itemId),
        'Line'
      );
      return {
        rfqItemId,
        itemId: rfqLine.itemId,
        description: String(line.description || '').trim().slice(0, 300) || rfqLine.description || rfqLine.itemName,
        uomId: line.uomId ? Number(line.uomId) : rfqLine.uomId,
        ...calc,
        deliveryDays,
        remarks: optionalText(line, 'remarks', 300),
      };
    });

    const document = tax.calculateDocument(lines, {
      ...tax.parseHeaderDiscount(body, 'Quotation'),
      roundOff: body.roundOff,
    });
    const subtotal = document.subtotal;
    const taxAmount = document.taxAmount;
    const totalAmount = document.totalAmount;
    /* A quotation inherits the RFQ's general terms unless explicitly overridden. */
    const generalTerms = body.generalTerms === undefined
      ? (rfq.general_terms || '')
      : optionalText(body, 'generalTerms', 5000);
    const quotationDate = optionalDate(body, 'quotationDate') || today();
    const validUntil = optionalDate(body, 'validUntil');
    if (validUntil && validUntil < quotationDate) throw new HttpError(400, 'Validity date cannot be before the quotation date.');
    const deliveryDays = Math.max(0, Math.floor(Number(body.deliveryDays) || 0));
    const quotationNo = nextQuotationNo();
    const now = nowIso();
    let id;
    transaction(ctx.db, () => {
      const res = ctx.db
        .prepare(
          `INSERT INTO quotations(quotation_no, rfq_id, vendor_id, quotation_date, valid_until,
             subtotal, tax_amount, discount_percent, discount_amount, total_amount, round_off,
             delivery_days, payment_terms, warranty_terms, general_terms,
             remarks, status, created_by, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'received',?,?,?)`
        )
        .run(
          quotationNo, rfq.id, vendorId, quotationDate, validUntil,
          subtotal, taxAmount, document.discountPercent, document.discountAmount, totalAmount, document.roundOff,
          deliveryDays, optionalText(body, 'paymentTerms', 500), optionalText(body, 'warrantyTerms', 500),
          generalTerms, optionalText(body, 'remarks', 1000), ctx.user.id, now, now
        );
      id = Number(res.lastInsertRowid);
      const insert = ctx.db.prepare(
        `INSERT INTO quotation_items(quotation_id, rfq_item_id, item_id, description, uom_id,
           quantity, unit_price, discount_percent, discount_amount, tax_rate, tax_inclusive,
           taxable_amount, tax_amount, total_amount, delivery_days, remarks, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      );
      for (const line of lines) {
        insert.run(
          id, line.rfqItemId, line.itemId, line.description, line.uomId,
          line.quantity, line.unitPrice, line.discountPercent, line.discountAmount,
          line.taxRate, line.taxInclusive ? 1 : 0, line.taxableAmount, line.taxAmount,
          line.totalAmount, line.deliveryDays, line.remarks, now
        );
      }
      ctx.db
        .prepare("UPDATE rfq_vendors SET status='responded', responded_at=? WHERE rfq_id=? AND vendor_id=?")
        .run(now, rfq.id, vendorId);
    });
    notify(
      [rfq.created_by],
      'Quotation received',
      `${quotationNo} received for ${rfq.rfq_no}.`,
      `/sourcing/${rfq.id}`
    );
    audit(ctx, 'CREATE', 'quotation', id, null, {
      quotationNo, rfqId: rfq.id, vendorId, generalTerms,
      baseTotalAmount: document.baseTotalAmount, roundOff: document.roundOff,
      totalAmount,
      ...tax.auditSummary(lines, document),
    });
    return {
      id, quotationNo, status: 'received',
      baseTotalAmount: document.baseTotalAmount, roundOff: document.roundOff, totalAmount,
    };
  });

  router.get('/api/procurement/quotations/:id', async (ctx) => {
    auth.guard(ctx.user, 'sourcing.view');
    const quotation = getQuotation(ctx, ctx.params.id);
    return { quotation: quotationOut(quotation), items: quotationItems(ctx.db, quotation.id) };
  });

  router.put('/api/procurement/quotations/:id', async (ctx) => {
    auth.guard(ctx.user, 'sourcing.manage');
    const quotation = getQuotation(ctx, ctx.params.id);
    if (quotation.status === 'awarded') throw new HttpError(400, 'An awarded quotation cannot be edited.');
    const rfq = getRfq(ctx, quotation.rfq_id);
    if (rfq.status === 'cancelled') throw new HttpError(400, 'Quotations on a cancelled RFQ cannot be edited.');
    const locked = ctx.db
      .prepare("SELECT 1 FROM comparative_statements WHERE rfq_id = ? AND status IN ('pending','approved')")
      .get(rfq.id);
    if (locked) throw new HttpError(400, 'Quotations cannot be edited while a comparative statement is pending or approved.');

    const body = ctx.body || {};
    const rfqLines = rfqItems(ctx.db, rfq.id);
    const lineMap = new Map(rfqLines.map((line) => [line.id, line]));
    const list = Array.isArray(body.items) ? body.items : null;
    let lines = null;
    if (list) {
      if (!list.length) throw new HttpError(400, 'Add at least one quotation line.');
      const seen = new Set();
      lines = list.map((line, index) => {
        const rfqItemId = Number(line.rfqItemId);
        const rfqLine = lineMap.get(rfqItemId);
        if (!rfqLine) throw new HttpError(400, `Line ${index + 1}: RFQ item was not found.`);
        if (seen.has(rfqItemId)) throw new HttpError(400, `Line ${index + 1}: RFQ item is repeated.`);
        seen.add(rfqItemId);
        const quantity = line.quantity === undefined || line.quantity === ''
          ? rfqLine.quantity
          : Number(line.quantity);
        if (!Number.isFinite(quantity) || quantity <= 0) {
          throw new HttpError(400, `Line ${index + 1}: quantity must be greater than zero.`);
        }
        const unitPrice = Number(line.unitPrice);
        if (!Number.isFinite(unitPrice) || unitPrice < 0) {
          throw new HttpError(400, `Line ${index + 1}: unit price cannot be negative.`);
        }
        const calc = tax.parseLine(
          { ...line, quantity, unitPrice },
          index,
          tax.itemDefaults(ctx.db, rfqLine.itemId),
          'Line'
        );
        return {
          rfqItemId,
          itemId: rfqLine.itemId,
          description: String(line.description || '').trim().slice(0, 300) || rfqLine.description || rfqLine.itemName,
          uomId: line.uomId ? Number(line.uomId) : rfqLine.uomId,
          ...calc,
          deliveryDays: Math.max(0, Math.floor(Number(line.deliveryDays) || 0)),
          remarks: optionalText(line, 'remarks', 300),
        };
      });
    }

    const headerDiscount = tax.parseHeaderDiscount({
      discountPercent: body.discountPercent ?? quotation.discount_percent ?? 0,
      discountAmount: body.discountAmount ?? quotation.discount_amount ?? 0,
    }, 'Quotation');
    /* Recalculate from stored lines when only header fields changed so the
     * persisted total, base total and round-off stay consistent. */
    const detailLines = lines || quotationItems(ctx.db, quotation.id);
    const document = tax.calculateDocument(detailLines, {
      ...headerDiscount,
      roundOff: body.roundOff ?? quotation.round_off,
    });
    const subtotal = document.subtotal;
    const taxAmount = document.taxAmount;
    const totalAmount = document.totalAmount;
    const generalTerms = body.generalTerms === undefined
      ? (quotation.general_terms || '')
      : optionalText(body, 'generalTerms', 5000);
    const now = nowIso();
    transaction(ctx.db, () => {
      ctx.db
        .prepare(
          `UPDATE quotations SET quotation_date=?, valid_until=?, subtotal=?, tax_amount=?,
             discount_percent=?, discount_amount=?, total_amount=?, round_off=?,
             delivery_days=?, payment_terms=?, warranty_terms=?, general_terms=?, remarks=?, updated_at=? WHERE id=?`
        )
        .run(
          body.quotationDate === undefined ? quotation.quotation_date : (optionalDate(body, 'quotationDate') || quotation.quotation_date),
          body.validUntil === undefined ? quotation.valid_until : optionalDate(body, 'validUntil'),
          subtotal, taxAmount, document.discountPercent, document.discountAmount, totalAmount, document.roundOff,
          body.deliveryDays === undefined ? quotation.delivery_days : Math.max(0, Math.floor(Number(body.deliveryDays) || 0)),
          body.paymentTerms === undefined ? quotation.payment_terms : optionalText(body, 'paymentTerms', 500),
          body.warrantyTerms === undefined ? quotation.warranty_terms : optionalText(body, 'warrantyTerms', 500),
          generalTerms,
          body.remarks === undefined ? quotation.remarks : optionalText(body, 'remarks', 1000),
          now, quotation.id
        );
      if (lines) {
        ctx.db.prepare('DELETE FROM quotation_items WHERE quotation_id = ?').run(quotation.id);
        const insert = ctx.db.prepare(
          `INSERT INTO quotation_items(quotation_id, rfq_item_id, item_id, description, uom_id,
             quantity, unit_price, discount_percent, discount_amount, tax_rate, tax_inclusive,
             taxable_amount, tax_amount, total_amount, delivery_days, remarks, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
        );
        for (const line of lines) {
          insert.run(
            quotation.id, line.rfqItemId, line.itemId, line.description, line.uomId,
            line.quantity, line.unitPrice, line.discountPercent, line.discountAmount,
            line.taxRate, line.taxInclusive ? 1 : 0, line.taxableAmount, line.taxAmount,
            line.totalAmount, line.deliveryDays, line.remarks, now
          );
        }
      }
    });
    audit(ctx, 'UPDATE', 'quotation', quotation.id, {
      totalAmount: quotation.total_amount, roundOff: round2(quotation.round_off),
      generalTerms: quotation.general_terms || '',
    }, {
      totalAmount,
      baseTotalAmount: document.baseTotalAmount,
      roundOff: document.roundOff,
      generalTerms,
      discountPercent: document.discountPercent,
      discountAmount: document.discountAmount,
      ...tax.auditSummary(detailLines, document),
    });
    return {
      ok: true, baseTotalAmount: document.baseTotalAmount,
      roundOff: document.roundOff, totalAmount,
    };
  });

  router.delete('/api/procurement/quotations/:id', async (ctx) => {
    auth.guard(ctx.user, 'sourcing.manage');
    const quotation = getQuotation(ctx, ctx.params.id);
    if (quotation.status === 'awarded') throw new HttpError(400, 'An awarded quotation cannot be deleted.');
    const locked = ctx.db
      .prepare("SELECT 1 FROM comparative_statements WHERE rfq_id = ? AND status IN ('pending','approved')")
      .get(quotation.rfq_id);
    if (locked) throw new HttpError(400, 'Quotations cannot be deleted while a comparative statement is pending or approved.');
    const now = nowIso();
    ctx.db
      .prepare('UPDATE quotations SET deleted_at=?, deleted_by=?, delete_reason=?, updated_at=? WHERE id=?')
      .run(now, ctx.user.id, optionalText(ctx.body || {}, 'reason', 300), now, quotation.id);
    ctx.db
      .prepare("UPDATE rfq_vendors SET status='invited', responded_at=NULL WHERE rfq_id=? AND vendor_id=?")
      .run(quotation.rfq_id, quotation.vendor_id);
    audit(ctx, 'DELETE', 'quotation', quotation.id, { quotationNo: quotation.quotation_no }, { deletedAt: now });
    return { ok: true };
  });

  /* ---------------------- Comparative statements ------------------ */
  router.get('/api/procurement/rfqs/:id/comparative', async (ctx) => {
    auth.guard(ctx.user, 'sourcing.view');
    const rfq = getRfq(ctx, ctx.params.id);
    const items = rfqItems(ctx.db, rfq.id);
    const quotations = ctx.db
      .prepare(
        `SELECT q.*, v.code AS vendor_code, v.name AS vendor_name,
                (SELECT COUNT(*) FROM quotation_items qi WHERE qi.quotation_id = q.id) AS item_count
           FROM quotations q JOIN vendors v ON v.id = q.vendor_id
          WHERE q.rfq_id = ? AND q.deleted_at IS NULL
          ORDER BY q.total_amount ASC, q.id`
      )
      .all(rfq.id);
    const quoteItems = ctx.db
      .prepare(
        `SELECT qi.* FROM quotation_items qi
           JOIN quotations q ON q.id = qi.quotation_id
          WHERE q.rfq_id = ? AND q.deleted_at IS NULL
          ORDER BY qi.id`
      )
      .all(rfq.id);
    const byQuote = new Map();
    for (const line of quoteItems) {
      if (!byQuote.has(line.quotation_id)) byQuote.set(line.quotation_id, new Map());
      byQuote.get(line.quotation_id).set(line.rfq_item_id, line);
    }
    return {
      rfq: rfqOut(rfq),
      lines: items.map((item) => ({
        ...item,
        offers: quotations.map((q) => {
          const line = byQuote.get(q.id)?.get(item.id);
          return {
            quotationId: q.id,
            unitPrice: line ? Number(line.unit_price) : null,
            taxRate: line ? Number(line.tax_rate) : null,
            totalAmount: line ? Number(line.total_amount) : null,
            quoted: !!line,
          };
        }),
      })),
      quotations: quotations.map(quotationOut),
      lowestQuotationId: quotations.length ? quotations[0].id : null,
    };
  });

  router.get('/api/procurement/comparative-statements', async (ctx) => {
    auth.guard(ctx.user, 'sourcing.view');
    const ids = unitScope(ctx);
    const q = ctx.query || {};
    const where = [`r.unit_id IN (${inList(ids)})`];
    const params = [...ids];
    if (q.status && CS_STATUSES.includes(String(q.status))) {
      where.push('c.status = ?');
      params.push(String(q.status));
    }
    if (q.rfqId) {
      where.push('c.rfq_id = ?');
      params.push(Number(q.rfqId));
    }
    const { page, pageSize, offset } = pageParams(q);
    const total = ctx.db
      .prepare(
        `SELECT COUNT(*) AS c FROM comparative_statements c JOIN rfqs r ON r.id = c.rfq_id
          WHERE ${where.join(' AND ')}`
      )
      .get(...params).c;
    const rows = ctx.db
      .prepare(
        `SELECT c.*, r.rfq_no, q.quotation_no AS recommended_quotation_no,
                v.name AS recommended_vendor_name,
                pu.name AS prepared_by_name, au.name AS approved_by_name
           FROM comparative_statements c
           JOIN rfqs r ON r.id = c.rfq_id
           LEFT JOIN quotations q ON q.id = c.recommended_quotation_id
           LEFT JOIN vendors v ON v.id = q.vendor_id
           JOIN users pu ON pu.id = c.prepared_by
           LEFT JOIN users au ON au.id = c.approved_by
          WHERE ${where.join(' AND ')}
          ORDER BY c.created_at DESC, c.id DESC
          LIMIT ? OFFSET ?`
      )
      .all(...params, pageSize, offset);
    return { comparativeStatements: rows.map(comparativeOut), total, page, pageSize };
  });

  router.post('/api/procurement/rfqs/:id/comparative', async (ctx) => {
    auth.guard(ctx.user, 'sourcing.manage');
    const rfq = getRfq(ctx, ctx.params.id);
    if (rfq.status !== 'issued') throw new HttpError(400, 'Prepare a comparative statement against an issued RFQ.');
    const body = ctx.body || {};
    const quotationId = optionalId(body, 'recommendedQuotationId');
    if (!quotationId) throw new HttpError(400, 'Select the recommended quotation.');
    const quotation = rowOr404(
      ctx.db
        .prepare('SELECT * FROM quotations WHERE id = ? AND rfq_id = ? AND deleted_at IS NULL')
        .get(quotationId, rfq.id),
      'Recommended quotation not found for this RFQ.'
    );
    if (['rejected', 'withdrawn'].includes(quotation.status)) {
      throw new HttpError(400, 'A rejected or withdrawn quotation cannot be recommended.');
    }
    const open = ctx.db
      .prepare("SELECT 1 FROM comparative_statements WHERE rfq_id = ? AND status IN ('draft','pending')")
      .get(rfq.id);
    if (open) throw new HttpError(400, 'A comparative statement is already open for this RFQ.');
    const csNo = nextComparativeNo();
    const now = nowIso();
    const res = ctx.db
      .prepare(
        `INSERT INTO comparative_statements(cs_no, rfq_id, status, recommended_quotation_id,
           recommendation_notes, total_quoted, prepared_by, prepared_at, created_at, updated_at)
         VALUES (?,?,'pending',?,?,?,?,?,?,?)`
      )
      .run(
        csNo, rfq.id, quotation.id, optionalText(body, 'recommendationNotes', 2000),
        round2(quotation.total_amount), ctx.user.id, now, now, now
      );
    const id = Number(res.lastInsertRowid);
    notify(
      [rfq.created_by],
      'Comparative statement awaiting approval',
      `${csNo} prepared for ${rfq.rfq_no}.`,
      `/sourcing/${rfq.id}`
    );
    audit(ctx, 'CREATE', 'comparative_statement', id, null, {
      csNo, rfqId: rfq.id, recommendedQuotationId: quotation.id,
    });
    return { id, csNo, status: 'pending' };
  });

  router.get('/api/procurement/comparative-statements/:id', async (ctx) => {
    auth.guard(ctx.user, 'sourcing.view');
    const statement = getComparative(ctx, ctx.params.id);
    const rfq = getRfq(ctx, statement.rfq_id);
    return { comparativeStatement: comparativeOut(statement), rfq: rfqOut(rfq) };
  });

  router.post('/api/procurement/comparative-statements/:id/approve', async (ctx) => {
    auth.guard(ctx.user, 'sourcing.manage');
    const statement = getComparative(ctx, ctx.params.id);
    if (statement.status !== 'pending') throw new HttpError(400, 'This comparative statement is not awaiting approval.');
    const rfq = getRfq(ctx, statement.rfq_id);
    const quotation = rowOr404(
      ctx.db.prepare('SELECT * FROM quotations WHERE id = ? AND rfq_id = ? AND deleted_at IS NULL')
        .get(statement.recommended_quotation_id, rfq.id),
      'Recommended quotation not found.'
    );
    if (['rejected', 'withdrawn'].includes(quotation.status)) {
      throw new HttpError(400, 'The recommended quotation is no longer valid.');
    }
    const comments = optionalText(ctx.body || {}, 'comments', 1000);
    const now = nowIso();
    transaction(ctx.db, () => {
      ctx.db
        .prepare(
          `UPDATE comparative_statements SET status='approved', approved_by=?, approved_at=?,
             recommendation_notes = CASE WHEN ? = '' THEN recommendation_notes ELSE ? END,
             updated_at=? WHERE id=?`
        )
        .run(ctx.user.id, now, comments, comments, now, statement.id);
      ctx.db.prepare("UPDATE quotations SET status='awarded', updated_at=? WHERE id=?").run(now, quotation.id);
      ctx.db
        .prepare(
          `UPDATE quotations SET status='rejected', updated_at=?
            WHERE rfq_id=? AND id<>? AND deleted_at IS NULL
              AND status IN ('received','shortlisted')`
        )
        .run(now, rfq.id, quotation.id);
      ctx.db
        .prepare("UPDATE rfqs SET status='closed', closed_at=?, updated_at=? WHERE id=? AND status='issued'")
        .run(now, now, rfq.id);
    });
    notify(
      [rfq.created_by],
      'Comparative statement approved',
      `${statement.cs_no} approved. ${quotation.quotation_no} is recommended.`,
      `/sourcing/${rfq.id}`
    );
    audit(ctx, 'APPROVE', 'comparative_statement', statement.id, { status: 'pending' }, {
      status: 'approved', recommendedQuotationId: quotation.id,
    });
    return { ok: true, status: 'approved', rfqId: rfq.id };
  });

  router.post('/api/procurement/comparative-statements/:id/reject', async (ctx) => {
    auth.guard(ctx.user, 'sourcing.manage');
    const statement = getComparative(ctx, ctx.params.id);
    if (statement.status !== 'pending') throw new HttpError(400, 'This comparative statement is not awaiting approval.');
    const reason = requireText(ctx.body || {}, 'reason', 'Rejection reason', 500);
    const now = nowIso();
    ctx.db
      .prepare(
        `UPDATE comparative_statements SET status='rejected', rejected_by=?, rejected_at=?,
           rejection_reason=?, updated_at=? WHERE id=?`
      )
      .run(ctx.user.id, now, reason, now, statement.id);
    notify(
      [statement.prepared_by],
      'Comparative statement rejected',
      `${statement.cs_no}: ${reason}`,
      `/sourcing/${statement.rfq_id}`
    );
    audit(ctx, 'REJECT', 'comparative_statement', statement.id, { status: 'pending' }, {
      status: 'rejected', reason,
    });
    return { ok: true, status: 'rejected' };
  });
};
