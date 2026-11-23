'use strict';

/**
 * Procurement requisitions, approval, store verification and stock — Phase 1a.
 *
 * Additive only: new tables are created by server/procurement/schema.js and the
 * endpoints live under /api/procurement. Existing ABMDAS modules are untouched.
 */

const auth = require('../auth');
const { HttpError } = require('../http');
const {
  audit, notify, nowIso, today, badRequest, round2, calculateRoundOff,
  nextRequisitionNo, nextIssueNo, nextAdjustmentNo,
} = require('../util');
const tax = require('../procurement/tax');

const REQUIREMENT_TYPES = ['consumable', 'asset', 'service'];
const PRIORITIES = ['low', 'normal', 'high', 'urgent'];
const STATUSES = [
  'draft', 'pending', 'returned', 'rejected', 'cancelled',
  'store_verification', 'sourcing', 'issued', 'closed',
];
const EDITABLE_STATUSES = ['draft', 'returned'];
const OPEN_STATUSES = ['draft', 'pending', 'returned', 'store_verification', 'sourcing'];

/* ------------------------------------------------------------------ */
/* Shared helpers                                                      */
/* ------------------------------------------------------------------ */
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

function optionalDate(body, field) {
  if (body[field] === undefined || body[field] === null || body[field] === '') return null;
  const value = String(body[field]).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw badRequest(`${field} must be a valid date.`);
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

function userIdsByRoleId(db, roleId) {
  return db
    .prepare("SELECT id FROM users WHERE role_id = ? AND status = 'Active'")
    .all(Number(roleId))
    .map((r) => r.id);
}

function userIdsByRoleCode(db, roleCode) {
  return db
    .prepare(
      `SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id
        WHERE r.code = ? AND u.status = 'Active'`
    )
    .all(roleCode)
    .map((r) => r.id);
}

/* ------------------------------------------------------------------ */
/* Workflow resolution                                                 */
/* ------------------------------------------------------------------ */
function resolveWorkflow(db, { unitId, departmentId, requirementType, amount }) {
  const value = Number(amount) || 0;
  const rule = db
    .prepare(
      `SELECT * FROM procurement_workflow_rules
        WHERE active = 1
          AND (unit_id IS NULL OR unit_id = ?)
          AND (department_id IS NULL OR department_id = ?)
          AND (requirement_type IS NULL OR requirement_type = ?)
          AND min_amount <= ?
          AND (max_amount IS NULL OR max_amount >= ?)
        ORDER BY
          (CASE WHEN unit_id IS NOT NULL THEN 4 ELSE 0 END) +
          (CASE WHEN department_id IS NOT NULL THEN 2 ELSE 0 END) +
          (CASE WHEN requirement_type IS NOT NULL THEN 1 ELSE 0 END) DESC,
          min_amount DESC, id ASC
        LIMIT 1`
    )
    .get(Number(unitId), Number(departmentId) || -1, requirementType, value, value);

  if (!rule) return { rule: null, stages: [] };
  const stages = db
    .prepare('SELECT * FROM procurement_workflow_stages WHERE rule_id = ? ORDER BY sequence ASC')
    .all(rule.id);
  return { rule, stages };
}

function buildRequisitionStages(db, requisition, amount, now) {
  const resolved = resolveWorkflow(db, {
    unitId: requisition.unit_id,
    departmentId: requisition.department_id,
    requirementType: requisition.requirement_type,
    amount,
  });

  let stages = resolved.stages.slice();
  const creator = db.prepare('SELECT role_id FROM users WHERE id = ?').get(requisition.requested_by);
  if (creator && creator.role_id) {
    stages = stages.filter((stage) => Number(stage.role_id) !== Number(creator.role_id));
  }

  if (!stages.length) {
    const fallback = ['procurement_officer', 'department_head', 'administrator']
      .map((code) => db.prepare('SELECT id, name FROM roles WHERE code = ?').get(code))
      .find(Boolean);
    if (fallback) {
      stages = [{ name: `${fallback.name} Approval`, role_id: fallback.id }];
    }
  }

  db.prepare('DELETE FROM requisition_stages WHERE requisition_id = ?').run(requisition.id);
  const insert = db.prepare(
    `INSERT INTO requisition_stages(requisition_id, sequence, name, role_id, status, created_at, updated_at)
     VALUES (?,?,?,?,'pending',?,?)`
  );
  stages.forEach((stage, index) => {
    insert.run(requisition.id, index + 1, stage.name, stage.role_id, now, now);
  });
  return { ruleId: resolved.rule ? resolved.rule.id : null, stages };
}

/* ------------------------------------------------------------------ */
/* Row helpers                                                         */
/* ------------------------------------------------------------------ */
function requisitionOut(row) {
  const gross = round2(Number(row.estimated_total) || 0);
  /* `discount_amount` is the applied header discount (percent + flat), so do
   * not add the percentage a second time when deriving the pre-round total. */
  const headerDiscount = round2(Math.min(gross, Number(row.discount_amount) || 0));
  const totals = calculateRoundOff(Math.max(0, gross - headerDiscount), row.round_off);
  return {
    id: row.id,
    requisitionNo: row.requisition_no,
    unitId: row.unit_id,
    unitName: row.unit_name || '',
    departmentId: row.department_id,
    departmentName: row.department_name || '',
    costCenterId: row.cost_center_id,
    costCenterName: row.cost_center_name || '',
    requestedBy: row.requested_by,
    requestedByName: row.requested_by_name || '',
    requirementType: row.requirement_type,
    priority: row.priority,
    purpose: row.purpose || '',
    requiredBy: row.required_by,
    status: row.status,
    currentStage: row.current_stage,
    currentStageName: row.current_stage_name || '',
    workflowRuleId: row.workflow_rule_id,
    submittedAt: row.submitted_at,
    approvedAt: row.approved_at,
    verificationStatus: row.verification_status || '',
    verifiedBy: row.verified_by,
    verifiedByName: row.verified_by_name || '',
    verifiedAt: row.verified_at,
    verificationRemarks: row.verification_remarks || '',
    stockIssueId: row.stock_issue_id,
    cancelReason: row.cancel_reason || '',
    suggestedVendorId: row.suggested_vendor_id || null,
    suggestedVendorName: row.suggested_vendor_name || '',
    suggestedVendorContact: row.suggested_vendor_contact || '',
    suggestedVendorMobile: row.suggested_vendor_mobile || '',
    suggestedVendorEmail: row.suggested_vendor_email || '',
    suggestedVendorAddress: row.suggested_vendor_address || '',
    suggestedVendorNotes: row.suggested_vendor_notes || '',
    discountPercent: Number(row.discount_percent) || 0,
    discountAmount: Number(row.discount_amount) || 0,
    closedAt: row.closed_at,
    itemCount: Number(row.item_count) || 0,
    baseTotalAmount: totals.baseTotalAmount,
    roundOff: totals.roundOff,
    estimatedTotal: totals.totalAmount,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function getRequisition(ctx, id) {
  const ids = unitScope(ctx);
  const row = ctx.db
    .prepare(
      `SELECT r.*, u.name AS unit_name, d.name AS department_name,
              c.name AS cost_center_name, ru.name AS requested_by_name,
              vu.name AS verified_by_name, rs.name AS current_stage_name,
              (SELECT COUNT(*) FROM requisition_items ri WHERE ri.requisition_id = r.id) AS item_count,
              (SELECT COALESCE(SUM(ri.estimated_total), 0)
                 FROM requisition_items ri WHERE ri.requisition_id = r.id) AS estimated_total
         FROM requisitions r
         JOIN units u ON u.id = r.unit_id
         LEFT JOIN departments d ON d.id = r.department_id
         LEFT JOIN cost_centers c ON c.id = r.cost_center_id
         JOIN users ru ON ru.id = r.requested_by
         LEFT JOIN users vu ON vu.id = r.verified_by
         LEFT JOIN requisition_stages rs
                ON rs.requisition_id = r.id AND rs.sequence = r.current_stage
        WHERE r.id = ? AND r.deleted_at IS NULL AND r.unit_id IN (${inList(ids)})`
    )
    .get(Number(id), ...ids);
  if (!row) throw new HttpError(404, 'Requisition not found.');
  return row;
}

function requisitionItems(db, id) {
  return db
    .prepare(
      `SELECT ri.*, i.item_code, i.name AS catalog_item_name, i.item_type,
              i.standard_cost, i.track_inventory, i.reorder_level,
              u.code AS uom_code, u.name AS uom_name
         FROM requisition_items ri
         LEFT JOIN items i ON i.id = ri.item_id
         LEFT JOIN uoms u ON u.id = COALESCE(ri.uom_id, i.uom_id)
        WHERE ri.requisition_id = ?
        ORDER BY ri.id ASC`
    )
    .all(id)
    .map((row) => ({
      id: row.id,
      itemId: row.item_id,
      itemCode: row.item_code || '',
      itemName: row.catalog_item_name || row.item_name || row.description || '',
      itemType: row.item_type || '',
      inItemMaster: !!row.item_id,
      description: row.description || '',
      uomId: row.uom_id,
      uomCode: row.uom_code || '',
      uomName: row.uom_name || '',
      quantity: Number(row.quantity) || 0,
      estimatedUnitCost: Number(row.estimated_unit_cost) || 0,
      discountPercent: Number(row.discount_percent) || 0,
      discountAmount: Number(row.discount_amount) || 0,
      taxRate: Number(row.tax_rate) || 0,
      taxInclusive: !!row.tax_inclusive,
      taxableAmount: Number(row.taxable_amount) || 0,
      taxAmount: Number(row.tax_amount) || 0,
      estimatedTotal: Number(row.estimated_total) || 0,
      standardCost: Number(row.standard_cost) || 0,
      trackInventory: !!row.track_inventory,
      reorderLevel: Number(row.reorder_level) || 0,
    }));
}

function requisitionStages(db, id) {
  return db
    .prepare(
      `SELECT rs.*, rl.code AS role_code, rl.name AS role_name,
              u.name AS acted_by_name
         FROM requisition_stages rs
         JOIN roles rl ON rl.id = rs.role_id
         LEFT JOIN users u ON u.id = rs.acted_by
        WHERE rs.requisition_id = ?
        ORDER BY rs.sequence ASC`
    )
    .all(id)
    .map((row) => ({
      id: row.id,
      sequence: row.sequence,
      name: row.name,
      roleId: row.role_id,
      roleCode: row.role_code,
      roleName: row.role_name,
      status: row.status,
      actedBy: row.acted_by,
      actedByName: row.acted_by_name || '',
      actedAt: row.acted_at,
      comments: row.comments || '',
    }));
}

function getIssue(ctx, id) {
  const ids = unitScope(ctx);
  const issue = ctx.db
    .prepare(
      `SELECT si.*, u.name AS unit_name, s.name AS store_name,
              iu.name AS issued_by_name, tu.name AS issued_to_name,
              au.name AS acknowledged_by_name
         FROM stock_issues si
         JOIN units u ON u.id = si.unit_id
         JOIN stores s ON s.id = si.store_id
         JOIN users iu ON iu.id = si.issued_by
         JOIN users tu ON tu.id = si.issued_to
         LEFT JOIN users au ON au.id = si.acknowledged_by
        WHERE si.id = ? AND si.unit_id IN (${inList(ids)})`
    )
    .get(Number(id), ...ids);
  if (!issue) throw new HttpError(404, 'Stock issue not found.');

  const items = ctx.db
    .prepare(
      `SELECT sii.*, i.item_code, i.name AS item_name, b.name AS bin_name
         FROM stock_issue_items sii
         JOIN items i ON i.id = sii.item_id
         LEFT JOIN bins b ON b.id = sii.bin_id
        WHERE sii.issue_id = ?
        ORDER BY sii.id ASC`
    )
    .all(issue.id)
    .map((row) => ({
      id: row.id,
      itemId: row.item_id,
      itemCode: row.item_code || '',
      itemName: row.item_name || '',
      binId: row.bin_id,
      binName: row.bin_name || '',
      quantity: Number(row.quantity) || 0,
      unitCost: Number(row.unit_cost) || 0,
      remarks: row.remarks || '',
    }));

  return {
    issue: {
      id: issue.id,
      issueNo: issue.issue_no,
      requisitionId: issue.requisition_id,
      unitId: issue.unit_id,
      unitName: issue.unit_name || '',
      storeId: issue.store_id,
      storeName: issue.store_name || '',
      issuedTo: issue.issued_to,
      issuedToName: issue.issued_to_name || '',
      issuedBy: issue.issued_by,
      issuedByName: issue.issued_by_name || '',
      issuedAt: issue.issued_at,
      status: issue.status,
      acknowledgedBy: issue.acknowledged_by,
      acknowledgedByName: issue.acknowledged_by_name || '',
      acknowledgedAt: issue.acknowledged_at,
      remarks: issue.remarks || '',
    },
    items,
  };
}

function ensureOwnerOrApprover(ctx, requisition) {
  if (Number(requisition.requested_by) === Number(ctx.user.id)) return;
  if (auth.can(ctx.user, 'requisition.approve')) return;
  throw new HttpError(403, 'Only the requester or an approver can perform this action.');
}

function activeStage(db, requisition) {
  return db
    .prepare('SELECT * FROM requisition_stages WHERE requisition_id = ? AND sequence = ?')
    .get(requisition.id, requisition.current_stage);
}

function canActOnStage(user, stage) {
  return user.role_code === 'super_admin' || Number(user.role_id) === Number(stage.role_id);
}

function notifyStage(db, requisition, stage) {
  const ids = userIdsByRoleId(db, stage.role_id);
  notify(
    ids,
    'Requisition awaiting approval',
    `${requisition.requisition_no} — ${requisition.purpose || requisition.requirement_type}`,
    `/requisitions/${requisition.id}`
  );
}

function notifyRoleCode(db, roleCode, title, message, link) {
  notify(userIdsByRoleCode(db, roleCode), title, message, link);
}

/* ------------------------------------------------------------------ */
/* Requisition payload                                                 */
/* ------------------------------------------------------------------ */
function linesFromBody(ctx, body) {
  const list = Array.isArray(body.items) ? body.items : [];
  if (!list.length) throw badRequest('Add at least one item to the requisition.');
  if (list.length > 100) throw badRequest('A requisition can hold at most 100 lines.');

  return list.map((line, index) => {
    const rawItemId = Number(line.itemId);
    const hasItem = Number.isInteger(rawItemId) && rawItemId > 0;
    let item = null;
    if (hasItem) {
      item = ctx.db
        .prepare('SELECT * FROM items WHERE id = ? AND deleted_at IS NULL AND active = 1')
        .get(rawItemId);
      if (!item) throw badRequest(`Line ${index + 1}: item was not found or is inactive.`);
    }

    const typedName = String(line.itemName || '').trim().slice(0, 200);
    if (!hasItem && !typedName) {
      throw badRequest(`Line ${index + 1}: select an item or type an item name.`);
    }

    const quantity = Number(line.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw badRequest(`Line ${index + 1}: quantity must be greater than zero.`);
    }

    const rawCost = line.estimatedUnitCost;
    const cost = rawCost === undefined || rawCost === null || rawCost === ''
      ? Number(item?.standard_cost) || 0
      : Number(rawCost);
    if (!Number.isFinite(cost) || cost < 0) {
      throw badRequest(`Line ${index + 1}: estimated unit cost cannot be negative.`);
    }

    const uomId = Number(line.uomId) || (item ? item.uom_id : null) || null;
    if (uomId) {
      const uom = ctx.db.prepare('SELECT id FROM uoms WHERE id = ?').get(uomId);
      if (!uom) throw badRequest(`Line ${index + 1}: unit of measure was not found.`);
    }
    const description = String(line.description || '').trim().slice(0, 300)
      || (item ? item.name : '');
    const defaults = hasItem ? tax.itemDefaults(ctx.db, rawItemId) : {};
    const calc = tax.parseLine({ ...line, quantity, unitPrice: cost }, index, defaults, 'Line');

    return {
      itemId: hasItem ? rawItemId : null,
      itemName: hasItem ? null : typedName,
      description,
      uomId,
      quantity: calc.quantity,
      estimatedUnitCost: calc.unitPrice,
      discountPercent: calc.discountPercent,
      discountAmount: calc.discountAmount,
      taxRate: calc.taxRate,
      taxInclusive: calc.taxInclusive ? 1 : 0,
      taxableAmount: calc.taxableAmount,
      taxAmount: calc.taxAmount,
      estimatedTotal: calc.totalAmount,
      /* tax.calculateDocument() reads totalAmount/total_amount; keep both so
       * the document-level round-off sees the line's payable value. */
      totalAmount: calc.totalAmount,
    };
  });
}

function requisitionPayload(ctx, body, existing) {
  const unitId = ensureUnit(ctx, body.unitId ?? existing?.unit_id);
  const requirementType = String(body.requirementType || existing?.requirement_type || 'consumable');
  if (!REQUIREMENT_TYPES.includes(requirementType)) {
    throw badRequest('Requirement type must be consumable, asset or service.');
  }

  const departmentId = body.departmentId === undefined
    ? (existing?.department_id ?? null)
    : optionalId(body, 'departmentId');
  if (departmentId) {
    const dept = ctx.db.prepare('SELECT id FROM departments WHERE id = ?').get(departmentId);
    if (!dept) throw badRequest('Department was not found.');
  }

  const costCenterId = body.costCenterId === undefined
    ? (existing?.cost_center_id ?? null)
    : optionalId(body, 'costCenterId');
  if (costCenterId) {
    const centre = ctx.db.prepare('SELECT id, unit_id FROM cost_centers WHERE id = ? AND deleted_at IS NULL').get(costCenterId);
    if (!centre) throw badRequest('Cost centre was not found.');
    if (Number(centre.unit_id) !== unitId) throw badRequest('Cost centre does not belong to the selected unit.');
  }

  const priority = String(body.priority || existing?.priority || 'normal');
  if (!PRIORITIES.includes(priority)) throw badRequest('Priority is invalid.');

  const suggestedVendorIdRaw = body.suggestedVendorId;
  let suggestedVendorId = null;
  if (suggestedVendorIdRaw !== undefined && suggestedVendorIdRaw !== null && String(suggestedVendorIdRaw).trim() !== '') {
    suggestedVendorId = Number(suggestedVendorIdRaw);
    if (!Number.isInteger(suggestedVendorId) || suggestedVendorId <= 0) throw badRequest('Suggested vendor is invalid.');
    const v = ctx.db.prepare('SELECT * FROM vendors WHERE id = ?').get(suggestedVendorId);
    if (!v) throw badRequest('Suggested vendor not found.');
  }

  let suggestedVendorName = optionalText(body, 'suggestedVendorName', 200);
  let suggestedVendorContact = optionalText(body, 'suggestedVendorContact', 120);
  let suggestedVendorMobile = optionalText(body, 'suggestedVendorMobile', 40);
  let suggestedVendorEmail = optionalText(body, 'suggestedVendorEmail', 160);
  let suggestedVendorAddress = optionalText(body, 'suggestedVendorAddress', 300);
  const suggestedVendorNotes = optionalText(body, 'suggestedVendorNotes', 500);
  if (suggestedVendorId) {
    const v = ctx.db.prepare('SELECT * FROM vendors WHERE id = ?').get(suggestedVendorId);
    suggestedVendorName = v.name || '';
    suggestedVendorContact = v.contact_person || '';
    suggestedVendorMobile = v.mobile || '';
    suggestedVendorEmail = v.email || '';
    suggestedVendorAddress = [v.address_line1, v.address_line2, v.city, v.state, v.pincode].filter(Boolean).join(', ');
  } else {
    if (!suggestedVendorName
      && (suggestedVendorContact || suggestedVendorMobile || suggestedVendorEmail
        || suggestedVendorAddress || suggestedVendorNotes)) {
      throw badRequest('Enter the suggested vendor name, or clear the other suggested vendor details.');
    }
    if (suggestedVendorEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(suggestedVendorEmail)) {
      throw badRequest('Suggested vendor email is not valid.');
    }
  }

  const items = linesFromBody(ctx, body);
  const discount = tax.parseHeaderDiscount({
    discountPercent: body.discountPercent ?? existing?.discount_percent ?? 0,
    discountAmount: body.discountAmount ?? existing?.discount_amount ?? 0,
  }, 'Requisition');
  const document = tax.calculateDocument(items, {
    ...discount,
    roundOff: body.roundOff ?? existing?.round_off,
  });

  return {
    unitId,
    departmentId,
    costCenterId,
    requirementType,
    priority,
    purpose: requireText(body, 'purpose', 'Purpose', 500),
    requiredBy: body.requiredBy === undefined ? (existing?.required_by || null) : optionalDate(body, 'requiredBy'),
    suggestedVendorId,
    suggestedVendorName,
    suggestedVendorContact,
    suggestedVendorMobile,
    suggestedVendorEmail,
    suggestedVendorAddress,
    suggestedVendorNotes,
    discountPercent: document.discountPercent,
    discountAmount: document.discountAmount,
    baseTotalAmount: document.baseTotalAmount,
    roundOff: document.roundOff,
    estimatedTotal: document.totalAmount,
    items,
    document,
  };
}

function replaceItems(db, requisitionId, lines, now) {
  db.prepare('DELETE FROM requisition_items WHERE requisition_id = ?').run(requisitionId);
  const insert = db.prepare(
    `INSERT INTO requisition_items(requisition_id, item_id, item_name, description, uom_id, quantity,
       estimated_unit_cost, discount_percent, discount_amount, tax_rate, tax_inclusive,
       taxable_amount, tax_amount, estimated_total, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  for (const line of lines) {
    insert.run(
      requisitionId, line.itemId, line.itemName || null, line.description, line.uomId, line.quantity,
      line.estimatedUnitCost, line.discountPercent || 0, line.discountAmount || 0,
      line.taxRate || 0, line.taxInclusive || 0, line.taxableAmount || 0, line.taxAmount || 0,
      line.estimatedTotal, now, now
    );
  }
}

function requisitionTotals(db, requisitionId) {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(ri.estimated_total), 0) AS total,
              COALESCE(MAX(r.discount_percent), 0) AS discount_percent,
              COALESCE(MAX(r.discount_amount), 0) AS discount_amount,
              COALESCE(MAX(r.round_off), 0) AS round_off
         FROM requisition_items ri
         JOIN requisitions r ON r.id = ri.requisition_id
        WHERE ri.requisition_id = ?`
    )
    .get(requisitionId);
  const gross = round2(row.total);
  /* The persisted `discount_amount` already includes the percent component. */
  const discount = round2(Math.min(gross, Number(row.discount_amount) || 0));
  return calculateRoundOff(Math.max(0, gross - discount), row.round_off);
}

function requisitionTotal(db, requisitionId) {
  return requisitionTotals(db, requisitionId).totalAmount;
}

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */
module.exports = function registerProcurementRequisitionRoutes(router) {
  /* --------------------------- Requisition meta ------------------- */
  router.get('/api/procurement/requisitions/meta', async (ctx) => {
    auth.guard(ctx.user, 'requisition.view');
    const ids = unitScope(ctx);
    const ph = inList(ids);

    const units = ctx.db.prepare(`SELECT id, code, name FROM units WHERE id IN (${ph}) ORDER BY name`).all(...ids);
    const departments = ctx.db
      .prepare('SELECT id, code, name FROM departments WHERE active = 1 ORDER BY name')
      .all();
    const costCenters = ctx.db
      .prepare(`SELECT id, unit_id, code, name FROM cost_centers WHERE deleted_at IS NULL AND unit_id IN (${ph}) ORDER BY name`)
      .all(...ids);
    const items = ctx.db
      .prepare(
        `SELECT i.id, i.item_code, i.name, i.item_type, i.uom_id, i.standard_cost,
                i.reorder_level, i.track_inventory, u.code AS uom_code
           FROM items i JOIN uoms u ON u.id = i.uom_id
          WHERE i.deleted_at IS NULL AND i.active = 1
          ORDER BY i.name COLLATE NOCASE
          LIMIT 1000`
      )
      .all()
      .map((row) => ({
        id: row.id,
        itemCode: row.item_code,
        name: row.name,
        itemType: row.item_type,
        uomId: row.uom_id,
        uomCode: row.uom_code,
        standardCost: Number(row.standard_cost) || 0,
        reorderLevel: Number(row.reorder_level) || 0,
        trackInventory: !!row.track_inventory,
      }));
    const stores = ctx.db
      .prepare(
        `SELECT s.id, s.unit_id, s.code, s.name FROM stores s
          WHERE s.deleted_at IS NULL AND s.unit_id IN (${ph}) ORDER BY s.name`
      )
      .all(...ids)
      .map((s) => ({ id: s.id, unitId: s.unit_id, code: s.code, name: s.name }));

    const workflow = ctx.db
      .prepare(
        `SELECT ws.name, rl.name AS role_name
           FROM procurement_workflow_rules wr
           JOIN procurement_workflow_stages ws ON ws.rule_id = wr.id
           JOIN roles rl ON rl.id = ws.role_id
          WHERE wr.active = 1 AND wr.unit_id IS NULL AND wr.department_id IS NULL
            AND wr.requirement_type IS NULL AND wr.min_amount = 0 AND wr.max_amount IS NULL
          ORDER BY ws.sequence`
      )
      .all();

    return {
      units,
      departments,
      costCenters: costCenters.map((c) => ({ id: c.id, unitId: c.unit_id, code: c.code, name: c.name })),
      items,
      stores,
      workflow,
      requirementTypes: [
        { value: 'consumable', label: 'Consumable' },
        { value: 'asset', label: 'Asset (Non-Consumable)' },
        { value: 'service', label: 'Service' },
      ],
      priorities: [
        { value: 'low', label: 'Low' },
        { value: 'normal', label: 'Normal' },
        { value: 'high', label: 'High' },
        { value: 'urgent', label: 'Urgent' },
      ],
      statuses: STATUSES.map((value) => ({ value, label: value.replace(/_/g, ' ') })),
    };
  });

  /* --------------------------- Requisition list ------------------- */
  router.get('/api/procurement/requisitions', async (ctx) => {
    auth.guard(ctx.user, 'requisition.view');
    const ids = unitScope(ctx);
    const q = ctx.query || {};
    const where = ['r.deleted_at IS NULL', `r.unit_id IN (${inList(ids)})`];
    const params = [...ids];

    if (q.search) {
      const like = `%${String(q.search).trim()}%`;
      where.push('(r.requisition_no LIKE ? OR r.purpose LIKE ? OR ru.name LIKE ?)');
      params.push(like, like, like);
    }
    if (q.status && STATUSES.includes(String(q.status))) {
      where.push('r.status = ?');
      params.push(String(q.status));
    }
    if (q.type && REQUIREMENT_TYPES.includes(String(q.type))) {
      where.push('r.requirement_type = ?');
      params.push(String(q.type));
    }
    if (q.mine === '1') {
      where.push('r.requested_by = ?');
      params.push(ctx.user.id);
    }
    if (q.approvals === '1') {
      const roleId = Number(ctx.user.role_id) || -1;
      where.push(
        `r.status = 'pending' AND EXISTS (
           SELECT 1 FROM requisition_stages st
            WHERE st.requisition_id = r.id AND st.sequence = r.current_stage
              AND st.status = 'pending' AND (st.role_id = ? OR ? = 1))`
      );
      params.push(roleId, ctx.user.role_code === 'super_admin' ? 1 : 0);
    }

    const page = Math.max(1, Number(q.page) || 1);
    const pageSize = Math.min(200, Math.max(1, Number(q.pageSize) || 50));
    const offset = (page - 1) * pageSize;

    const total = ctx.db
      .prepare(
        `SELECT COUNT(*) AS c FROM requisitions r
           JOIN users ru ON ru.id = r.requested_by
          WHERE ${where.join(' AND ')}`
      )
      .get(...params).c;

    const rows = ctx.db
      .prepare(
        `SELECT r.*, u.name AS unit_name, d.name AS department_name,
                c.name AS cost_center_name, ru.name AS requested_by_name,
                rs.name AS current_stage_name,
                (SELECT COUNT(*) FROM requisition_items ri WHERE ri.requisition_id = r.id) AS item_count,
                (SELECT COALESCE(SUM(ri.estimated_total), 0)
                   FROM requisition_items ri WHERE ri.requisition_id = r.id) AS estimated_total
           FROM requisitions r
           JOIN units u ON u.id = r.unit_id
           JOIN users ru ON ru.id = r.requested_by
           LEFT JOIN departments d ON d.id = r.department_id
           LEFT JOIN cost_centers c ON c.id = r.cost_center_id
           LEFT JOIN requisition_stages rs
                  ON rs.requisition_id = r.id AND rs.sequence = r.current_stage
          WHERE ${where.join(' AND ')}
          ORDER BY r.created_at DESC, r.id DESC
          LIMIT ? OFFSET ?`
      )
      .all(...params, pageSize, offset);

    const summary = ctx.db
      .prepare(
        `SELECT
           SUM(CASE WHEN r.status = 'pending' THEN 1 ELSE 0 END) AS pending,
           SUM(CASE WHEN r.status = 'store_verification' THEN 1 ELSE 0 END) AS verification,
           SUM(CASE WHEN r.status IN ('issued','closed') THEN 1 ELSE 0 END) AS fulfilled,
           SUM(CASE WHEN r.status = 'sourcing' THEN 1 ELSE 0 END) AS sourcing
         FROM requisitions r
         JOIN users ru ON ru.id = r.requested_by
        WHERE ${where.join(' AND ')}`
      )
      .get(...params);

    return {
      requisitions: rows.map(requisitionOut),
      total,
      page,
      pageSize,
      summary: {
        pending: Number(summary.pending) || 0,
        verification: Number(summary.verification) || 0,
        fulfilled: Number(summary.fulfilled) || 0,
        sourcing: Number(summary.sourcing) || 0,
      },
    };
  });

  /* --------------------------- Requisition create ----------------- */
  router.post('/api/procurement/requisitions', async (ctx) => {
    auth.guard(ctx.user, 'requisition.create');
    const data = requisitionPayload(ctx, ctx.body || {});
    const now = nowIso();
    const requisitionNo = nextRequisitionNo();

    let id;
    transaction(ctx.db, () => {
      const res = ctx.db
        .prepare(
          `INSERT INTO requisitions(requisition_no, unit_id, department_id, cost_center_id, requested_by,
             requirement_type, priority, purpose, required_by, suggested_vendor_id, suggested_vendor_name, suggested_vendor_contact,
             suggested_vendor_mobile, suggested_vendor_email, suggested_vendor_address, suggested_vendor_notes,
             discount_percent, discount_amount, round_off, status, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'draft',?,?)`
        )
        .run(
          requisitionNo, data.unitId, data.departmentId, data.costCenterId, ctx.user.id,
          data.requirementType, data.priority, data.purpose, data.requiredBy,
          data.suggestedVendorId,
          data.suggestedVendorName, data.suggestedVendorContact, data.suggestedVendorMobile,
          data.suggestedVendorEmail, data.suggestedVendorAddress, data.suggestedVendorNotes,
          data.discountPercent, data.discountAmount, data.roundOff,
          now, now
        );
      id = Number(res.lastInsertRowid);
      replaceItems(ctx.db, id, data.items, now);
    });

    const totals = requisitionTotals(ctx.db, id);
    audit(ctx, 'CREATE', 'requisition', id, null, {
      requisitionNo, unitId: data.unitId, requirementType: data.requirementType,
      itemCount: data.items.length, baseTotalAmount: totals.baseTotalAmount,
      roundOff: totals.roundOff, estimatedTotal: totals.totalAmount,
      ...tax.auditSummary(data.items, data.document),
    });
    return {
      id, requisitionNo, status: 'draft',
      baseTotalAmount: totals.baseTotalAmount, roundOff: totals.roundOff,
      estimatedTotal: totals.totalAmount,
    };
  });

  /* --------------------------- Requisition detail ----------------- */
  router.get('/api/procurement/requisitions/:id', async (ctx) => {
    auth.guard(ctx.user, 'requisition.view');
    const requisition = getRequisition(ctx, ctx.params.id);
    const items = requisitionItems(ctx.db, requisition.id);
    const stages = requisitionStages(ctx.db, requisition.id);
    let issue = null;
    if (requisition.stock_issue_id) {
      try {
        issue = getIssue(ctx, requisition.stock_issue_id);
      } catch {
        issue = null;
      }
    }

    const stage = requisition.status === 'pending' && requisition.current_stage
      ? activeStage(ctx.db, requisition)
      : null;

    return {
      requisition: requisitionOut(requisition),
      items,
      stages,
      issue,
      actions: {
        canEdit: EDITABLE_STATUSES.includes(requisition.status)
          && (Number(requisition.requested_by) === Number(ctx.user.id) || ctx.user.role_code === 'super_admin'),
        canSubmit: EDITABLE_STATUSES.includes(requisition.status)
          && (Number(requisition.requested_by) === Number(ctx.user.id) || ctx.user.role_code === 'super_admin'),
        canApprove: requisition.status === 'pending' && !!stage && canActOnStage(ctx.user, stage)
          && auth.can(ctx.user, 'requisition.approve'),
        canVerify: requisition.status === 'store_verification' && auth.can(ctx.user, 'requisition.verify'),
        canAcknowledge: requisition.status === 'issued'
          && (Number(requisition.requested_by) === Number(ctx.user.id) || auth.can(ctx.user, 'requisition.approve')),
        canCancel: OPEN_STATUSES.includes(requisition.status)
          && (Number(requisition.requested_by) === Number(ctx.user.id) || auth.can(ctx.user, 'requisition.approve')),
        canDelete: requisition.status === 'draft'
          && (Number(requisition.requested_by) === Number(ctx.user.id) || ctx.user.role_code === 'super_admin'),
      },
    };
  });

  /* --------------------------- Requisition update ----------------- */
  router.put('/api/procurement/requisitions/:id', async (ctx) => {
    auth.guard(ctx.user, 'requisition.create');
    const requisition = getRequisition(ctx, ctx.params.id);
    if (!EDITABLE_STATUSES.includes(requisition.status)) {
      throw new HttpError(400, 'Only draft or returned requisitions can be edited.');
    }
    if (Number(requisition.requested_by) !== Number(ctx.user.id) && ctx.user.role_code !== 'super_admin') {
      throw new HttpError(403, 'Only the requester can edit this requisition.');
    }

    const data = requisitionPayload(ctx, ctx.body || {}, requisition);
    const now = nowIso();
    transaction(ctx.db, () => {
      ctx.db
        .prepare(
          `UPDATE requisitions SET unit_id=?, department_id=?, cost_center_id=?, requirement_type=?,
             priority=?, purpose=?, required_by=?, suggested_vendor_id=?, suggested_vendor_name=?, suggested_vendor_contact=?,
             suggested_vendor_mobile=?, suggested_vendor_email=?, suggested_vendor_address=?,
             suggested_vendor_notes=?, discount_percent=?, discount_amount=?, round_off=?, updated_at=? WHERE id=?`
        )
        .run(
          data.unitId, data.departmentId, data.costCenterId, data.requirementType,
          data.priority, data.purpose, data.requiredBy,
          data.suggestedVendorId,
          data.suggestedVendorName, data.suggestedVendorContact, data.suggestedVendorMobile,
          data.suggestedVendorEmail, data.suggestedVendorAddress, data.suggestedVendorNotes,
          data.discountPercent, data.discountAmount, data.roundOff,
          now, requisition.id
        );
      replaceItems(ctx.db, requisition.id, data.items, now);
    });

    const totals = requisitionTotals(ctx.db, requisition.id);
    audit(ctx, 'UPDATE', 'requisition', requisition.id, {
      requisitionNo: requisition.requisition_no, status: requisition.status,
      roundOff: round2(requisition.round_off),
    }, {
      requirementType: data.requirementType, itemCount: data.items.length,
      baseTotalAmount: totals.baseTotalAmount, roundOff: totals.roundOff,
      estimatedTotal: totals.totalAmount,
      ...tax.auditSummary(data.items, data.document),
    });
    return {
      ok: true, baseTotalAmount: totals.baseTotalAmount,
      roundOff: totals.roundOff, estimatedTotal: totals.totalAmount,
    };
  });

  /* --------------------------- Requisition delete ----------------- */
  router.delete('/api/procurement/requisitions/:id', async (ctx) => {
    auth.guard(ctx.user, 'requisition.create');
    const requisition = getRequisition(ctx, ctx.params.id);
    if (requisition.status !== 'draft') {
      throw new HttpError(400, 'Only draft requisitions can be deleted. Cancel submitted requisitions instead.');
    }
    if (Number(requisition.requested_by) !== Number(ctx.user.id) && ctx.user.role_code !== 'super_admin') {
      throw new HttpError(403, 'Only the requester can delete this requisition.');
    }
    const now = nowIso();
    ctx.db
      .prepare('UPDATE requisitions SET deleted_at=?, deleted_by=?, delete_reason=?, updated_at=? WHERE id=?')
      .run(now, ctx.user.id, optionalText(ctx.body || {}, 'reason', 300), now, requisition.id);
    audit(ctx, 'DELETE', 'requisition', requisition.id, {
      requisitionNo: requisition.requisition_no,
    }, { deletedAt: now });
    return { ok: true };
  });

  /* --------------------------- Submit ----------------------------- */
  router.post('/api/procurement/requisitions/:id/submit', async (ctx) => {
    auth.guard(ctx.user, 'requisition.create');
    const requisition = getRequisition(ctx, ctx.params.id);
    if (!EDITABLE_STATUSES.includes(requisition.status)) {
      throw new HttpError(400, 'Only draft or returned requisitions can be submitted.');
    }
    if (Number(requisition.requested_by) !== Number(ctx.user.id) && ctx.user.role_code !== 'super_admin') {
      throw new HttpError(403, 'Only the requester can submit this requisition.');
    }
    const lines = requisitionItems(ctx.db, requisition.id);
    if (!lines.length) throw badRequest('Add at least one item before submitting.');

    const amount = requisitionTotal(ctx.db, requisition.id);
    const now = nowIso();
    let firstStage = null;
    let ruleId = null;

    transaction(ctx.db, () => {
      const built = buildRequisitionStages(ctx.db, requisition, amount, now);
      ruleId = built.ruleId;
      ctx.db
        .prepare(
          `UPDATE requisitions SET status='pending', current_stage=1, workflow_rule_id=?,
             submitted_at=?, approved_at=NULL, updated_at=? WHERE id=?`
        )
        .run(ruleId, now, now, requisition.id);
      firstStage = ctx.db
        .prepare('SELECT * FROM requisition_stages WHERE requisition_id=? AND sequence=1')
        .get(requisition.id);
    });

    if (firstStage) notifyStage(ctx.db, requisition, firstStage);
    const totals = requisitionTotals(ctx.db, requisition.id);
    audit(ctx, 'SUBMIT', 'requisition', requisition.id, { status: requisition.status }, {
      status: 'pending', baseTotalAmount: totals.baseTotalAmount,
      roundOff: totals.roundOff, estimatedTotal: amount, workflowRuleId: ruleId,
    });
    return { ok: true, status: 'pending' };
  });

  /* --------------------------- Approve ---------------------------- */
  router.post('/api/procurement/requisitions/:id/approve', async (ctx) => {
    auth.guard(ctx.user, 'requisition.approve');
    const requisition = getRequisition(ctx, ctx.params.id);
    if (requisition.status !== 'pending') {
      throw new HttpError(400, 'This requisition is not awaiting approval.');
    }
    const stage = activeStage(ctx.db, requisition);
    if (!stage || stage.status !== 'pending') {
      throw new HttpError(400, 'No approval stage is pending.');
    }
    if (!canActOnStage(ctx.user, stage)) {
      throw new HttpError(403, 'This approval stage belongs to another role.');
    }

    const comments = optionalText(ctx.body || {}, 'comments', 1000);
    const now = nowIso();
    let nextStage = null;
    let finalStatus = null;

    transaction(ctx.db, () => {
      ctx.db
        .prepare("UPDATE requisition_stages SET status='approved', acted_by=?, acted_at=?, comments=?, updated_at=? WHERE id=?")
        .run(ctx.user.id, now, comments, now, stage.id);

      nextStage = ctx.db
        .prepare(
          `SELECT * FROM requisition_stages
            WHERE requisition_id=? AND sequence>? AND status='pending'
            ORDER BY sequence ASC LIMIT 1`
        )
        .get(requisition.id, stage.sequence);

      if (nextStage) {
        ctx.db
          .prepare('UPDATE requisitions SET current_stage=?, updated_at=? WHERE id=?')
          .run(nextStage.sequence, now, requisition.id);
      } else {
        finalStatus = requisition.requirement_type === 'consumable' ? 'store_verification' : 'sourcing';
        ctx.db
          .prepare('UPDATE requisitions SET status=?, current_stage=NULL, approved_at=?, updated_at=? WHERE id=?')
          .run(finalStatus, now, now, requisition.id);
      }
    });

    if (nextStage) {
      notifyStage(ctx.db, requisition, nextStage);
    } else {
      notify(
        [requisition.requested_by],
        'Requisition approved',
        `${requisition.requisition_no} passed all approval stages.`,
        `/requisitions/${requisition.id}`
      );
      if (finalStatus === 'store_verification') {
        notifyRoleCode(
          ctx.db, 'store_incharge',
          'Requisition ready for store verification',
          `${requisition.requisition_no} needs stock verification.`,
          `/requisitions/${requisition.id}`
        );
      } else {
        notifyRoleCode(
          ctx.db, 'procurement_officer',
          'Requisition ready for sourcing',
          `${requisition.requisition_no} needs procurement action.`,
          `/requisitions/${requisition.id}`
        );
      }
    }

    audit(ctx, 'APPROVE', 'requisition', requisition.id, {
      stage: stage.name, sequence: stage.sequence,
    }, { status: finalStatus || 'pending', nextStage: nextStage ? nextStage.sequence : null, comments });
    return { ok: true, status: finalStatus || 'pending' };
  });

  /* --------------------------- Reject / return -------------------- */
  function stageAction(action) {
    return async (ctx) => {
      auth.guard(ctx.user, 'requisition.approve');
      const requisition = getRequisition(ctx, ctx.params.id);
      if (requisition.status !== 'pending') {
        throw new HttpError(400, 'This requisition is not awaiting approval.');
      }
      const stage = activeStage(ctx.db, requisition);
      if (!stage || stage.status !== 'pending') {
        throw new HttpError(400, 'No approval stage is pending.');
      }
      if (!canActOnStage(ctx.user, stage)) {
        throw new HttpError(403, 'This approval stage belongs to another role.');
      }
      const comments = requireText(ctx.body || {}, 'comments', 'Remarks', 1000);
      const status = action === 'reject' ? 'rejected' : 'returned';
      const now = nowIso();

      transaction(ctx.db, () => {
        ctx.db
          .prepare("UPDATE requisition_stages SET status='skipped', updated_at=? WHERE requisition_id=? AND status='pending'")
          .run(now, requisition.id);
        ctx.db
          .prepare('UPDATE requisition_stages SET status=?, acted_by=?, acted_at=?, comments=?, updated_at=? WHERE id=?')
          .run(status, ctx.user.id, now, comments, now, stage.id);
        ctx.db
          .prepare('UPDATE requisitions SET status=?, current_stage=NULL, updated_at=? WHERE id=?')
          .run(status, now, requisition.id);
      });

      notify(
        [requisition.requested_by],
        action === 'reject' ? 'Requisition rejected' : 'Requisition returned for correction',
        `${requisition.requisition_no}: ${comments}`,
        `/requisitions/${requisition.id}`
      );
      audit(ctx, action === 'reject' ? 'REJECT' : 'RETURN', 'requisition', requisition.id, {
        stage: stage.name, sequence: stage.sequence,
      }, { status, comments });
      return { ok: true, status };
    };
  }

  router.post('/api/procurement/requisitions/:id/reject', stageAction('reject'));
  router.post('/api/procurement/requisitions/:id/return', stageAction('return'));

  /* --------------------------- Cancel ----------------------------- */
  router.post('/api/procurement/requisitions/:id/cancel', async (ctx) => {
    const requisition = getRequisition(ctx, ctx.params.id);
    const owner = Number(requisition.requested_by) === Number(ctx.user.id);
    if (!owner && !auth.can(ctx.user, 'requisition.approve')) {
      throw new HttpError(403, 'Only the requester or an approver can cancel this requisition.');
    }
    if (!OPEN_STATUSES.includes(requisition.status)) {
      throw new HttpError(400, 'This requisition can no longer be cancelled.');
    }
    const reason = optionalText(ctx.body || {}, 'reason', 500);
    const now = nowIso();
    transaction(ctx.db, () => {
      ctx.db
        .prepare("UPDATE requisition_stages SET status='skipped', updated_at=? WHERE requisition_id=? AND status='pending'")
        .run(now, requisition.id);
      ctx.db
        .prepare("UPDATE requisitions SET status='cancelled', current_stage=NULL, cancel_reason=?, updated_at=? WHERE id=?")
        .run(reason, now, requisition.id);
    });
    notify(
      [requisition.requested_by],
      'Requisition cancelled',
      `${requisition.requisition_no}${reason ? `: ${reason}` : ' was cancelled.'}`,
      `/requisitions/${requisition.id}`
    );
    audit(ctx, 'CANCEL', 'requisition', requisition.id, { status: requisition.status }, {
      status: 'cancelled', reason,
    });
    return { ok: true, status: 'cancelled' };
  });

  /* --------------------------- Store verification / issue --------- */
  router.post('/api/procurement/requisitions/:id/verify', async (ctx) => {
    auth.guard(ctx.user, 'requisition.verify');
    const requisition = getRequisition(ctx, ctx.params.id);
    if (requisition.status !== 'store_verification') {
      throw new HttpError(400, 'This requisition is not awaiting store verification.');
    }

    const body = ctx.body || {};
    const storeId = optionalId(body, 'storeId');
    if (!storeId) throw badRequest('Select the store to verify against.');
    const store = ctx.db
      .prepare('SELECT * FROM stores WHERE id=? AND deleted_at IS NULL AND active=1')
      .get(storeId);
    if (!store) throw badRequest('Store was not found.');
    if (Number(store.unit_id) !== Number(requisition.unit_id)) {
      throw badRequest('The selected store does not belong to the requisition unit.');
    }

    const binId = optionalId(body, 'binId');
    if (binId) {
      const bin = ctx.db
        .prepare('SELECT id FROM bins WHERE id=? AND store_id=? AND deleted_at IS NULL')
        .get(binId, storeId);
      if (!bin) throw badRequest('Bin was not found in the selected store.');
    }

    const decision = String(body.decision || '').trim();
    if (!['available', 'unavailable'].includes(decision)) {
      throw badRequest('Verification decision must be available or unavailable.');
    }
    const remarks = optionalText(body, 'remarks', 1000);
    const now = nowIso();

    if (decision === 'unavailable') {
      ctx.db
        .prepare(
          `UPDATE requisitions SET status='sourcing', verification_status='stock_unavailable',
             verified_by=?, verified_at=?, verification_remarks=?, updated_at=? WHERE id=?`
        )
        .run(ctx.user.id, now, remarks, now, requisition.id);
      notify(
        [requisition.requested_by],
        'Requisition moved to sourcing',
        `${requisition.requisition_no} was not available in stock and is now with Procurement.`,
        `/requisitions/${requisition.id}`
      );
      notifyRoleCode(
        ctx.db, 'procurement_officer',
        'Requisition ready for sourcing',
        `${requisition.requisition_no} needs sourcing action.`,
        `/requisitions/${requisition.id}`
      );
      audit(ctx, 'VERIFY', 'requisition', requisition.id, { status: requisition.status }, {
        status: 'sourcing', verificationStatus: 'stock_unavailable', storeId, remarks,
      });
      return { ok: true, status: 'sourcing' };
    }

    const lines = requisitionItems(ctx.db, requisition.id);
    if (!lines.length) throw badRequest('This requisition has no items to issue.');

    /* Validate that the whole request can be fulfilled from one bin per item. */
    const catalogued = lines.filter((line) => line.itemId);
    if (!catalogued.length) {
      throw badRequest(
        'Every line on this requisition was typed as a free-text item and is not in the item master, so no stock can be issued. Record the verification as "Stock unavailable" to move it to sourcing.'
      );
    }

    const required = new Map();
    for (const line of lines) {
      if (!line.itemId || !line.trackInventory) continue;
      required.set(line.itemId, round2((required.get(line.itemId) || 0) + line.quantity));
    }

    const picks = new Map();
    for (const [itemId, quantity] of required) {
      const params = [storeId, itemId];
      let sql = 'SELECT * FROM stock_balances WHERE store_id=? AND item_id=? AND quantity > 0';
      if (binId) {
        sql += ' AND bin_id=?';
        params.push(binId);
      }
      sql += ' ORDER BY quantity DESC, id ASC';
      const rows = ctx.db.prepare(sql).all(...params);
      const available = round2(rows.reduce((sum, row) => sum + Number(row.quantity || 0), 0));
      const pick = rows.find((row) => Number(row.quantity) >= quantity);
      if (!pick) {
        const line = lines.find((l) => l.itemId === itemId);
        throw badRequest(
          `Insufficient stock for ${line ? line.itemName : `item ${itemId}`}: required ${quantity}, available ${available}.`
        );
      }
      picks.set(itemId, { ...pick });
    }

    const issueNo = nextIssueNo();
    let issueId;
    const excluded = lines.filter((line) => !line.itemId);
    const issueRemarks = excluded.length
      ? `${remarks ? `${remarks} | ` : ''}Not issued (not in item master): ${excluded.map((line) => line.itemName).join(', ')}`.slice(0, 1000)
      : remarks;

    transaction(ctx.db, () => {
      const issueRes = ctx.db
        .prepare(
          `INSERT INTO stock_issues(issue_no, requisition_id, unit_id, store_id, issued_to, issued_by,
             issued_at, status, remarks, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,'issued',?,?,?)`
        )
        .run(
          issueNo, requisition.id, requisition.unit_id, storeId, requisition.requested_by,
          ctx.user.id, now, issueRemarks, now, now
        );
      issueId = Number(issueRes.lastInsertRowid);

      const insertIssueItem = ctx.db.prepare(
        `INSERT INTO stock_issue_items(issue_id, item_id, bin_id, quantity, unit_cost, remarks, created_at)
         VALUES (?,?,?,?,?,?,?)`
      );
      const insertLedger = ctx.db.prepare(
        `INSERT INTO stock_ledger(unit_id, store_id, bin_id, item_id, transaction_type, reference_type,
           reference_id, quantity_in, quantity_out, unit_cost, balance_after, transaction_date,
           created_by, created_at)
         VALUES (?,?,?,?,'issue','stock_issue',?,0,?,?,?,?,?,?)`
      );

      for (const line of lines) {
        if (!line.itemId) continue;
        if (!line.trackInventory) {
          insertIssueItem.run(issueId, line.itemId, null, line.quantity, line.estimatedUnitCost, line.description, now);
          continue;
        }
        const pick = picks.get(line.itemId);
        const newQty = round2(Number(pick.quantity) - line.quantity);
        if (newQty < 0) throw badRequest('Stock changed while issuing. Reload and verify again.');
        pick.quantity = newQty;
        ctx.db
          .prepare('UPDATE stock_balances SET quantity=?, updated_at=? WHERE id=?')
          .run(newQty, now, pick.id);
        const unitCost = Number(line.standardCost) || Number(line.estimatedUnitCost) || 0;
        insertLedger.run(
          requisition.unit_id, storeId, pick.bin_id, line.itemId, issueId,
          line.quantity, unitCost, newQty, today(), ctx.user.id, now
        );
        insertIssueItem.run(
          issueId, line.itemId, pick.bin_id, line.quantity, unitCost, line.description, now
        );
      }

      ctx.db
        .prepare(
          `UPDATE requisitions SET status='issued', stock_issue_id=?, verification_status='stock_available',
             verified_by=?, verified_at=?, verification_remarks=?, updated_at=? WHERE id=?`
        )
        .run(issueId, ctx.user.id, now, remarks, now, requisition.id);
    });

    audit(ctx, 'VERIFY', 'requisition', requisition.id, { status: requisition.status }, {
      status: 'issued', verificationStatus: 'stock_available', storeId, issueId, issueNo,
    });
    audit(ctx, 'ISSUE', 'stock_issue', issueId, null, {
      issueNo, requisitionId: requisition.id, storeId,
    });
    notify(
      [requisition.requested_by],
      'Stock issued',
      `${issueNo} was issued against ${requisition.requisition_no}. Please acknowledge receipt.`,
      `/requisitions/${requisition.id}`
    );
    return { ok: true, status: 'issued', issueId, issueNo };
  });

  /* --------------------------- Acknowledge / close ---------------- */
  router.post('/api/procurement/requisitions/:id/acknowledge', async (ctx) => {
    const requisition = getRequisition(ctx, ctx.params.id);
    ensureOwnerOrApprover(ctx, requisition);
    if (requisition.status !== 'issued' || !requisition.stock_issue_id) {
      throw new HttpError(400, 'There is no issued stock to acknowledge.');
    }
    const issue = ctx.db
      .prepare('SELECT * FROM stock_issues WHERE id=?')
      .get(requisition.stock_issue_id);
    if (!issue) throw new HttpError(404, 'Stock issue not found.');

    const now = nowIso();
    transaction(ctx.db, () => {
      ctx.db
        .prepare("UPDATE stock_issues SET status='acknowledged', acknowledged_by=?, acknowledged_at=?, updated_at=? WHERE id=?")
        .run(ctx.user.id, now, now, issue.id);
      ctx.db
        .prepare("UPDATE requisitions SET status='closed', closed_at=?, updated_at=? WHERE id=?")
        .run(now, now, requisition.id);
    });

    if (Number(issue.issued_by) !== Number(ctx.user.id)) {
      notify(
        [issue.issued_by],
        'Stock issue acknowledged',
        `${issue.issue_no} for ${requisition.requisition_no} was acknowledged and closed.`,
        `/requisitions/${requisition.id}`
      );
    }
    audit(ctx, 'ACKNOWLEDGE', 'requisition', requisition.id, { status: 'issued' }, {
      status: 'closed', issueId: issue.id, issueNo: issue.issue_no,
    });
    return { ok: true, status: 'closed' };
  });

  /* --------------------------- Stock meta ------------------------- */
  router.get('/api/procurement/stock/meta', async (ctx) => {
    auth.guard(ctx.user, 'stock.view');
    const ids = unitScope(ctx);
    const ph = inList(ids);

    const stores = ctx.db
      .prepare(
        `SELECT s.id, s.unit_id, s.code, s.name FROM stores s
          WHERE s.deleted_at IS NULL AND s.unit_id IN (${ph}) ORDER BY s.name`
      )
      .all(...ids);
    const bins = stores.length
      ? ctx.db
          .prepare(
            `SELECT id, store_id, code, name FROM bins
              WHERE deleted_at IS NULL AND store_id IN (${stores.map(() => '?').join(',')})
              ORDER BY name`
          )
          .all(...stores.map((s) => s.id))
      : [];
    const items = ctx.db
      .prepare(
        `SELECT i.id, i.item_code, i.name, i.item_type, i.uom_id, i.standard_cost, i.reorder_level,
                u.code AS uom_code
           FROM items i JOIN uoms u ON u.id = i.uom_id
          WHERE i.deleted_at IS NULL AND i.active = 1 AND i.track_inventory = 1
          ORDER BY i.name COLLATE NOCASE
          LIMIT 1000`
      )
      .all()
      .map((row) => ({
        id: row.id,
        itemCode: row.item_code,
        name: row.name,
        itemType: row.item_type,
        uomId: row.uom_id,
        uomCode: row.uom_code,
        standardCost: Number(row.standard_cost) || 0,
        reorderLevel: Number(row.reorder_level) || 0,
      }));

    return {
      stores: stores.map((s) => ({
        id: s.id, unitId: s.unit_id, code: s.code, name: s.name,
        bins: bins.filter((b) => b.store_id === s.id).map((b) => ({ id: b.id, code: b.code, name: b.name })),
      })),
      items,
    };
  });

  /* --------------------------- Stock balances --------------------- */
  router.get('/api/procurement/stock/balances', async (ctx) => {
    auth.guard(ctx.user, 'stock.view');
    const ids = unitScope(ctx);
    const q = ctx.query || {};
    const where = [`sb.unit_id IN (${inList(ids)})`];
    const params = [...ids];

    if (q.storeId) {
      where.push('sb.store_id = ?');
      params.push(Number(q.storeId));
    }
    if (q.itemId) {
      where.push('sb.item_id = ?');
      params.push(Number(q.itemId));
    }
    if (q.search) {
      const like = `%${String(q.search).trim()}%`;
      where.push('(i.name LIKE ? OR i.item_code LIKE ? OR s.name LIKE ?)');
      params.push(like, like, like);
    }
    if (q.belowReorder === '1') {
      where.push('sb.quantity <= i.reorder_level');
    }

    const page = Math.max(1, Number(q.page) || 1);
    const pageSize = Math.min(200, Math.max(1, Number(q.pageSize) || 100));
    const offset = (page - 1) * pageSize;

    const total = ctx.db
      .prepare(
        `SELECT COUNT(*) AS c FROM stock_balances sb
           JOIN items i ON i.id = sb.item_id
           JOIN stores s ON s.id = sb.store_id
          WHERE ${where.join(' AND ')}`
      )
      .get(...params).c;

    const rows = ctx.db
      .prepare(
        `SELECT sb.*, i.item_code, i.name AS item_name, i.reorder_level, i.standard_cost,
                u.code AS uom_code, s.name AS store_name, b.name AS bin_name
           FROM stock_balances sb
           JOIN items i ON i.id = sb.item_id
           JOIN uoms u ON u.id = i.uom_id
           JOIN stores s ON s.id = sb.store_id
           LEFT JOIN bins b ON b.id = sb.bin_id
          WHERE ${where.join(' AND ')}
          ORDER BY i.name COLLATE NOCASE, s.name, b.name
          LIMIT ? OFFSET ?`
      )
      .all(...params, pageSize, offset);

    const totals = ctx.db
      .prepare(
        `SELECT COALESCE(SUM(sb.quantity), 0) AS quantity,
                COALESCE(SUM(sb.quantity * i.standard_cost), 0) AS value,
                SUM(CASE WHEN sb.quantity <= i.reorder_level THEN 1 ELSE 0 END) AS reorder
           FROM stock_balances sb
           JOIN items i ON i.id = sb.item_id
           JOIN stores s ON s.id = sb.store_id
          WHERE ${where.join(' AND ')}`
      )
      .get(...params);

    return {
      balances: rows.map((row) => ({
        id: row.id,
        unitId: row.unit_id,
        storeId: row.store_id,
        storeName: row.store_name || '',
        binId: row.bin_id,
        binName: row.bin_name || '',
        itemId: row.item_id,
        itemCode: row.item_code || '',
        itemName: row.item_name || '',
        uomCode: row.uom_code || '',
        quantity: Number(row.quantity) || 0,
        reorderLevel: Number(row.reorder_level) || 0,
        standardCost: Number(row.standard_cost) || 0,
        value: round2((Number(row.quantity) || 0) * (Number(row.standard_cost) || 0)),
        updatedAt: row.updated_at,
      })),
      total,
      page,
      pageSize,
      summary: {
        quantity: Number(totals.quantity) || 0,
        value: round2(totals.value),
        belowReorder: Number(totals.reorder) || 0,
      },
    };
  });

  /* --------------------------- Stock ledger ----------------------- */
  router.get('/api/procurement/stock/ledger', async (ctx) => {
    auth.guard(ctx.user, 'stock.view');
    const ids = unitScope(ctx);
    const q = ctx.query || {};
    const where = [`sl.unit_id IN (${inList(ids)})`];
    const params = [...ids];

    if (q.storeId) {
      where.push('sl.store_id = ?');
      params.push(Number(q.storeId));
    }
    if (q.itemId) {
      where.push('sl.item_id = ?');
      params.push(Number(q.itemId));
    }
    if (q.type) {
      where.push('sl.transaction_type = ?');
      params.push(String(q.type));
    }
    if (q.from) {
      where.push('sl.transaction_date >= ?');
      params.push(String(q.from));
    }
    if (q.to) {
      where.push('sl.transaction_date <= ?');
      params.push(String(q.to));
    }

    const page = Math.max(1, Number(q.page) || 1);
    const pageSize = Math.min(200, Math.max(1, Number(q.pageSize) || 100));
    const offset = (page - 1) * pageSize;

    const total = ctx.db
      .prepare(`SELECT COUNT(*) AS c FROM stock_ledger sl WHERE ${where.join(' AND ')}`)
      .get(...params).c;

    const rows = ctx.db
      .prepare(
        `SELECT sl.*, i.item_code, i.name AS item_name, u.code AS uom_code,
                s.name AS store_name, b.name AS bin_name, us.name AS created_by_name
           FROM stock_ledger sl
           JOIN items i ON i.id = sl.item_id
           JOIN uoms u ON u.id = i.uom_id
           JOIN stores s ON s.id = sl.store_id
           LEFT JOIN bins b ON b.id = sl.bin_id
           LEFT JOIN users us ON us.id = sl.created_by
          WHERE ${where.join(' AND ')}
          ORDER BY sl.id DESC
          LIMIT ? OFFSET ?`
      )
      .all(...params, pageSize, offset);

    return {
      entries: rows.map((row) => ({
        id: row.id,
        unitId: row.unit_id,
        storeId: row.store_id,
        storeName: row.store_name || '',
        binId: row.bin_id,
        binName: row.bin_name || '',
        itemId: row.item_id,
        itemCode: row.item_code || '',
        itemName: row.item_name || '',
        uomCode: row.uom_code || '',
        transactionType: row.transaction_type,
        referenceType: row.reference_type,
        referenceId: row.reference_id,
        quantityIn: Number(row.quantity_in) || 0,
        quantityOut: Number(row.quantity_out) || 0,
        unitCost: Number(row.unit_cost) || 0,
        balanceAfter: Number(row.balance_after) || 0,
        transactionDate: row.transaction_date,
        createdBy: row.created_by,
        createdByName: row.created_by_name || '',
        createdAt: row.created_at,
      })),
      total,
      page,
      pageSize,
    };
  });

  /* --------------------------- Stock issues ----------------------- */
  router.get('/api/procurement/stock/issues', async (ctx) => {
    auth.guard(ctx.user, 'stock.view');
    const ids = unitScope(ctx);
    const q = ctx.query || {};
    const where = [`si.unit_id IN (${inList(ids)})`];
    const params = [...ids];

    if (q.status) {
      where.push('si.status = ?');
      params.push(String(q.status));
    }
    if (q.requisitionId) {
      where.push('si.requisition_id = ?');
      params.push(Number(q.requisitionId));
    }

    const page = Math.max(1, Number(q.page) || 1);
    const pageSize = Math.min(200, Math.max(1, Number(q.pageSize) || 50));
    const offset = (page - 1) * pageSize;

    const total = ctx.db
      .prepare(`SELECT COUNT(*) AS c FROM stock_issues si WHERE ${where.join(' AND ')}`)
      .get(...params).c;

    const rows = ctx.db
      .prepare(
        `SELECT si.*, s.name AS store_name, iu.name AS issued_by_name,
                tu.name AS issued_to_name, r.requisition_no
           FROM stock_issues si
           JOIN stores s ON s.id = si.store_id
           JOIN users iu ON iu.id = si.issued_by
           JOIN users tu ON tu.id = si.issued_to
           JOIN requisitions r ON r.id = si.requisition_id
          WHERE ${where.join(' AND ')}
          ORDER BY si.id DESC
          LIMIT ? OFFSET ?`
      )
      .all(...params, pageSize, offset);

    return {
      issues: rows.map((row) => ({
        id: row.id,
        issueNo: row.issue_no,
        requisitionId: row.requisition_id,
        requisitionNo: row.requisition_no || '',
        storeId: row.store_id,
        storeName: row.store_name || '',
        issuedTo: row.issued_to,
        issuedToName: row.issued_to_name || '',
        issuedBy: row.issued_by,
        issuedByName: row.issued_by_name || '',
        issuedAt: row.issued_at,
        status: row.status,
        acknowledgedAt: row.acknowledged_at,
      })),
      total,
      page,
      pageSize,
    };
  });

  router.get('/api/procurement/stock/issues/:id', async (ctx) => {
    auth.guard(ctx.user, 'stock.view');
    return getIssue(ctx, ctx.params.id);
  });

  /* --------------------------- Adjustments ------------------------ */
  router.get('/api/procurement/stock/adjustments', async (ctx) => {
    auth.guard(ctx.user, 'stock.view');
    const ids = unitScope(ctx);
    const where = [`sa.unit_id IN (${inList(ids)})`];
    const params = [...ids];
    if (ctx.query?.storeId) {
      where.push('sa.store_id = ?');
      params.push(Number(ctx.query.storeId));
    }
    if (ctx.query?.itemId) {
      where.push('sa.item_id = ?');
      params.push(Number(ctx.query.itemId));
    }
    const rows = ctx.db
      .prepare(
        `SELECT sa.*, i.item_code, i.name AS item_name, s.name AS store_name,
                b.name AS bin_name, u.name AS adjusted_by_name
           FROM stock_adjustments sa
           JOIN items i ON i.id = sa.item_id
           JOIN stores s ON s.id = sa.store_id
           LEFT JOIN bins b ON b.id = sa.bin_id
           JOIN users u ON u.id = sa.adjusted_by
          WHERE ${where.join(' AND ')}
          ORDER BY sa.id DESC
          LIMIT 200`
      )
      .all(...params);
    return {
      adjustments: rows.map((row) => ({
        id: row.id,
        adjustmentNo: row.adjustment_no,
        unitId: row.unit_id,
        storeId: row.store_id,
        storeName: row.store_name || '',
        binId: row.bin_id,
        binName: row.bin_name || '',
        itemId: row.item_id,
        itemCode: row.item_code || '',
        itemName: row.item_name || '',
        adjustmentType: row.adjustment_type,
        quantity: Number(row.quantity) || 0,
        reason: row.reason || '',
        adjustedBy: row.adjusted_by,
        adjustedByName: row.adjusted_by_name || '',
        adjustedAt: row.adjusted_at,
      })),
    };
  });

  router.post('/api/procurement/stock/adjustments', async (ctx) => {
    auth.guard(ctx.user, 'stock.manage');
    const body = ctx.body || {};
    const storeId = optionalId(body, 'storeId');
    if (!storeId) throw badRequest('Select a store.');
    const itemId = optionalId(body, 'itemId');
    if (!itemId) throw badRequest('Select an item.');
    const binId = optionalId(body, 'binId');
    const adjustmentType = String(body.adjustmentType || '').trim();
    if (!['increase', 'decrease'].includes(adjustmentType)) {
      throw badRequest('Adjustment type must be increase or decrease.');
    }
    const quantity = Number(body.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw badRequest('Quantity must be greater than zero.');
    }
    const reason = requireText(body, 'reason', 'Reason', 500);

    const ids = unitScope(ctx);
    const store = ctx.db
      .prepare(`SELECT * FROM stores WHERE id=? AND deleted_at IS NULL AND active=1 AND unit_id IN (${inList(ids)})`)
      .get(storeId, ...ids);
    if (!store) throw badRequest('Store was not found.');
    const item = ctx.db
      .prepare('SELECT * FROM items WHERE id=? AND deleted_at IS NULL AND active=1 AND track_inventory=1')
      .get(itemId);
    if (!item) throw badRequest('Stocked item was not found.');
    if (binId) {
      const bin = ctx.db
        .prepare('SELECT id FROM bins WHERE id=? AND store_id=? AND deleted_at IS NULL')
        .get(binId, storeId);
      if (!bin) throw badRequest('Bin was not found in the selected store.');
    }

    const now = nowIso();
    const adjustmentNo = nextAdjustmentNo();
    let balanceAfter = 0;
    let adjustmentId;

    transaction(ctx.db, () => {
      let balance = ctx.db
        .prepare('SELECT * FROM stock_balances WHERE store_id=? AND COALESCE(bin_id, 0)=COALESCE(?, 0) AND item_id=?')
        .get(storeId, binId, itemId);
      if (!balance) {
        const res = ctx.db
          .prepare('INSERT INTO stock_balances(unit_id, store_id, bin_id, item_id, quantity, created_at, updated_at) VALUES (?,?,?,?,0,?,?)')
          .run(store.id, storeId, binId, itemId, now, now);
        balance = { id: Number(res.lastInsertRowid), quantity: 0 };
      }
      const current = Number(balance.quantity) || 0;
      const next = round2(adjustmentType === 'increase' ? current + quantity : current - quantity);
      if (next < 0) {
        throw badRequest(`Insufficient stock: available ${current}, cannot decrease by ${quantity}.`);
      }

      ctx.db
        .prepare('UPDATE stock_balances SET quantity=?, unit_id=?, store_id=?, bin_id=?, item_id=?, updated_at=? WHERE id=?')
        .run(next, store.id, storeId, binId, itemId, now, balance.id);

      const adjRes = ctx.db
        .prepare(
          `INSERT INTO stock_adjustments(adjustment_no, unit_id, store_id, bin_id, item_id, adjustment_type,
             quantity, reason, adjusted_by, adjusted_at, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`
        )
        .run(adjustmentNo, store.id, storeId, binId, itemId, adjustmentType, round2(quantity), reason, ctx.user.id, now, now);
      adjustmentId = Number(adjRes.lastInsertRowid);

      ctx.db
        .prepare(
          `INSERT INTO stock_ledger(unit_id, store_id, bin_id, item_id, transaction_type, reference_type,
             reference_id, quantity_in, quantity_out, unit_cost, balance_after, transaction_date,
             created_by, created_at)
           VALUES (?,?,?,?,'adjustment','stock_adjustment',?,?,?,?,?,?,?,?)`
        )
        .run(
          store.id, storeId, binId, itemId, adjustmentId,
          adjustmentType === 'increase' ? round2(quantity) : 0,
          adjustmentType === 'decrease' ? round2(quantity) : 0,
          Number(item.standard_cost) || 0, next, today(), ctx.user.id, now
        );
      balanceAfter = next;
    });

    audit(ctx, 'ADJUST', 'stock_adjustment', adjustmentId, null, {
      adjustmentNo, storeId, binId, itemId, adjustmentType,
      quantity: round2(quantity), balanceAfter, reason,
    });
    return { ok: true, adjustmentId, adjustmentNo, balanceAfter };
  });
};
