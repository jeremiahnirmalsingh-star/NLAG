'use strict';

const path = require('node:path');
const auth = require('../auth');
const { HttpError, saveUpload, fileUrlFor } = require('../http');
const {
  audit, nowIso, today, nextBillNo, nextHandoverNo, notify, userIdsByRole,
  round2, badRequest, calculateRoundOff,
} = require('../util');
const { buildBillStages, activeStage, canAct, notifyStage, ensureFallbackChain, ensureAdminPastorStage } = require('../workflow');
const { setBillAdjustments, reverseBillAdjustments, availableAdvances } = require('../services/advance');
const { DATA_DIR } = require('../db');
const taxRules = require('../procurement/tax');

const UPLOAD_DIR = path.join(DATA_DIR, 'uploads', 'bills');

const STATUS_LABELS = {
  draft: 'Draft',
  pending: 'Pending Approval',
  approved: 'Approved',
  rejected: 'Rejected',
  returned: 'Returned for Correction',
  hold: 'Awaiting Clarification',
  cancelled: 'Cancelled',
};

function amount(value) {
  return Number(value) || 0;
}

/* ---------------------------------------------------------------- */
/* Imprest settlement for cash bills                                 */
/* ---------------------------------------------------------------- */

function refreshImprestSettlement(db, imprestId, now) {
  const imp = db.prepare('SELECT * FROM imprests WHERE id = ?').get(imprestId);
  if (!imp) return null;
  const total = round2(
    db.prepare('SELECT COALESCE(SUM(amount), 0) AS total FROM imprest_bills WHERE imprest_id = ?')
      .get(imprestId).total
  );
  const issued = round2(imp.amount_issued);
  const balance = round2(Math.max(issued - total, 0));
  let status = imp.status;
  if (total >= issued - 0.004) status = 'Settled';
  else if (total > 0) status = 'Partially Settled';
  else if (['Settled', 'Partially Settled', 'Overdue'].includes(imp.status)) status = 'Open';
  if (imp.due_date && imp.due_date < now.slice(0, 10) && status !== 'Settled') status = 'Overdue';
  db.prepare(
    'UPDATE imprests SET settled_amount = ?, balance_amount = ?, status = ?, updated_at = ? WHERE id = ?'
  ).run(total, balance, status, now, imprestId);
  return { total, balance, status };
}

function clearBillImprestSettlement(db, billId, now) {
  const rows = db.prepare('SELECT DISTINCT imprest_id FROM imprest_bills WHERE bill_id = ?').all(billId);
  if (!rows.length) return;
  db.prepare('DELETE FROM imprest_bills WHERE bill_id = ?').run(billId);
  for (const row of rows) refreshImprestSettlement(db, row.imprest_id, now);
}

/* Validates the imprest reference for a cash bill without changing anything.
   Returns null when the bill is not an imprest-settled cash bill. */
function resolveBillImprestSettlement(db, bill) {
  const { billType, cashSettlementType, imprestReference, netAmount, unitId } = bill;
  if (billType !== 'cash' || cashSettlementType !== 'imprest') return null;

  const reference = String(imprestReference || '').trim();
  if (!reference) throw badRequest('Enter an imprest reference for this cash bill.');
  const imp = db.prepare('SELECT * FROM imprests WHERE imprest_no = ?').get(reference);
  if (!imp) throw badRequest(`Imprest ${reference} was not found.`);
  if (Number(imp.unit_id) !== Number(unitId)) {
    throw badRequest(`Imprest ${reference} belongs to a different unit.`);
  }
  if (!['Open', 'Partially Settled', 'Overdue'].includes(imp.status)) {
    throw badRequest(`Imprest ${reference} is not open for settlement.`);
  }

  const settledElsewhere = round2(
    db.prepare(
      'SELECT COALESCE(SUM(amount), 0) AS total FROM imprest_bills WHERE imprest_id = ? AND bill_id <> ?'
    ).get(imp.id, bill.id || 0).total
  );
  const available = round2(round2(imp.amount_issued) - settledElsewhere);
  const settleAmount = round2(netAmount);
  if (settleAmount > available + 0.004) {
    throw badRequest(
      `Imprest ${reference} has only ${available.toFixed(2)} available for settlement.`
    );
  }
  if (!(settleAmount > 0)) return null;
  return { imp, settleAmount };
}

/* Keeps the imprest register in step with a cash bill. Validation happens
   before any previous settlement is cleared so an invalid edit cannot
   silently release imprest funds. */
function applyBillImprestSettlement(db, ctx, bill, now) {
  const resolved = resolveBillImprestSettlement(db, bill);
  clearBillImprestSettlement(db, bill.id, now);
  if (!resolved) return null;
  db.prepare(
    'INSERT INTO imprest_bills(imprest_id, bill_id, amount, notes, created_by, created_at) VALUES (?,?,?,?,?,?)'
  ).run(resolved.imp.id, bill.id, resolved.settleAmount, 'Auto-settled on bill entry', ctx.user.id, now);
  return refreshImprestSettlement(db, resolved.imp.id, now);
}

/* Tax breakdown shared by the bill, report and public verification views. */
function taxBreakdown(b) {
  return {
    gstType: b.gst_type || 'cgst_sgst',
    taxInclusive: !!b.tax_inclusive,
    discountPercent: round2(amount(b.discount_percent)),
    discountAmount: round2(amount(b.discount_amount)),
    baseTotalAmount: round2(round2(amount(b.net_amount)) - round2(amount(b.round_off))),
    roundOff: round2(amount(b.round_off)),
    gstRate: round2(amount(b.gst_rate)),
    cgstAmount: round2(amount(b.cgst_amount)),
    sgstAmount: round2(amount(b.sgst_amount)),
    igstAmount: round2(amount(b.igst_amount)),
    transportType: b.transport_type || 'none',
    transportAmount: round2(amount(b.transport_amount)),
    transportGstRate: round2(amount(b.transport_gst_rate)),
    transportTaxAmount: round2(amount(b.transport_tax_amount)),
  };
}

function taxLineOut(l) {
  return {
    id: l.id,
    sequence: l.sequence,
    label: l.label || '',
    taxableAmount: round2(amount(l.taxable_amount)),
    taxInclusive: !!l.tax_inclusive,
    gstRate: round2(amount(l.gst_rate)),
    cgstAmount: round2(amount(l.cgst_amount)),
    sgstAmount: round2(amount(l.sgst_amount)),
    igstAmount: round2(amount(l.igst_amount)),
    taxAmount: round2(amount(l.tax_amount)),
  };
}

function saveTaxLines(db, billId, lines) {
  db.prepare('DELETE FROM bill_tax_lines WHERE bill_id = ?').run(billId);
  const insert = db.prepare(
    `INSERT INTO bill_tax_lines(bill_id, sequence, label, taxable_amount, tax_inclusive, gst_rate, cgst_amount, sgst_amount, igst_amount, tax_amount)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  );
  for (const line of lines) insert.run(
    billId,
    line.sequence,
    line.label || '',
    line.taxableAmount,
    line.taxInclusive ? 1 : 0,
    line.gstRate,
    line.cgstAmount,
    line.sgstAmount,
    line.igstAmount,
    line.taxAmount
  );
}

/* Withheld retention and snag-work hold reduce the amount payable to the
   vendor. Released amounts give the withheld money back; a credit note also
   reduces the payable. */
function billDeductions(b) {
  const retentionAmount = round2(amount(b.retention_amount));
  const retentionReleasedAmount = round2(amount(b.retention_released_amount));
  const retentionWithheld = round2(Math.max(retentionAmount - retentionReleasedAmount, 0));
  const holdAmount = round2(amount(b.hold_amount));
  const holdReleasedAmount = round2(amount(b.hold_released_amount));
  const holdWithheld = round2(Math.max(holdAmount - holdReleasedAmount, 0));
  const creditNoteAmount = round2(amount(b.credit_note_amount));
  const payableAmount = round2(
    amount(b.net_amount) - amount(b.advance_adjusted) - retentionWithheld - holdWithheld - creditNoteAmount
  );
  return {
    ...taxBreakdown(b),
    retentionPercentage: round2(amount(b.retention_percentage)),
    retentionAmount,
    retentionReleasedAmount,
    retentionWithheld,
    retentionReleaseDate: b.retention_release_date || null,
    retentionReleaseRemarks: b.retention_release_remarks || '',
    holdAmount,
    holdReleasedAmount,
    holdWithheld,
    holdReleaseDate: b.hold_release_date || null,
    holdReleaseRemarks: b.hold_release_remarks || '',
    creditNoteNumber: b.credit_note_number || '',
    creditNoteDate: b.credit_note_date || null,
    creditNoteAmount,
    creditNoteRemarks: b.credit_note_remarks || '',
    payableAmount,
  };
}

function billOut(b) {
  return {
    id: b.id,
    billNo: b.bill_no,
    entryDate: b.entry_date,
    unitId: b.unit_id,
    unitName: b.unit_name,
    billType: b.bill_type || 'credit',
    cashSettlementType: b.cash_settlement_type || '',
    imprestReference: b.imprest_reference || '',
    departmentId: b.department_id,
    departmentName: b.department_name,
    categoryId: b.category_id,
    categoryName: b.category_name,
    vendorId: b.vendor_id,
    vendorName: b.vendor_name,
    vendorCode: b.vendor_code,
    invoiceNumber: b.invoice_number,
    invoiceDate: b.invoice_date,
    dueDate: b.due_date,
    invoiceAmount: b.invoice_amount,
    taxAmount: b.tax_amount,
    netAmount: b.net_amount,
    particulars: b.particulars,
    description: b.description,
    budgetHead: b.budget_head,
    costCenter: b.cost_center,
    priority: b.priority,
    status: b.status,
    statusLabel: STATUS_LABELS[b.status] || b.status,
    currentStage: b.current_stage,
    currentStageName: b.current_stage_name,
    currentStageRoleCode: b.current_stage_role_code || '',
    advanceAdjusted: b.advance_adjusted,
    ...billDeductions(b),
    createdBy: b.created_by,
    createdByName: b.created_by_name,
    submittedAt: b.submitted_at,
    approvedAt: b.approved_at,
    createdAt: b.created_at,
    updatedAt: b.updated_at,
    attachmentCount: b.attachment_count,
    handoverStatus: b.handover_status,
    handoverNo: b.handover_no,
  };
}

function billDetail(ctx, id) {
  const b = ctx.db
    .prepare(
      `SELECT b.*, v.name AS vendor_name, v.code AS vendor_code, v.gst_number AS vendor_gst,
              un.name AS unit_name, d.name AS department_name, c.name AS category_name, u.name AS created_by_name,
              h.handover_no, h.status AS handover_status
         FROM bills b
         JOIN vendors v ON v.id = b.vendor_id
         LEFT JOIN units un ON un.id = b.unit_id
         LEFT JOIN departments d ON d.id = b.department_id
         LEFT JOIN categories c ON c.id = b.category_id
         LEFT JOIN users u ON u.id = b.created_by
         LEFT JOIN handovers h ON h.bill_id = b.id
        WHERE b.id = ?`
    )
    .get(id);
  if (!b) throw new HttpError(404, 'Bill not found.');
  if (!ctx.unitIds.includes(Number(b.unit_id))) {
    throw new HttpError(404, 'Bill not found.');
  }

  const stage = activeStage(ctx.db, id);
  const stages = ctx.db
    .prepare(
      `SELECT bs.*, r.name AS role_name, r.code AS role_code,
              u.name AS acted_by_name, u.designation AS acted_by_designation
         FROM bill_stages bs
         JOIN roles r ON r.id = bs.role_id
         LEFT JOIN users u ON u.id = bs.acted_by
        WHERE bs.bill_id = ? ORDER BY bs.sequence ASC`
    )
    .all(id);
  const attachments = ctx.db
    .prepare('SELECT * FROM bill_attachments WHERE bill_id = ? ORDER BY id ASC')
    .all(id)
    .map((a) => ({
      id: a.id,
      docType: a.doc_type,
      fileName: a.file_name,
      mimeType: a.mime_type,
      size: a.size,
      uploadedAt: a.uploaded_at,
      url: fileUrlFor('bill-document', a.id),
    }));
  const adjustments = ctx.db
    .prepare(
      `SELECT ba.*, a.advance_no, a.advance_date
         FROM bill_advances ba JOIN advances a ON a.id = ba.advance_id
        WHERE ba.bill_id = ?`
    )
    .all(id);
  const taxLines = ctx.db
    .prepare('SELECT * FROM bill_tax_lines WHERE bill_id = ? ORDER BY sequence ASC, id ASC')
    .all(id)
    .map(taxLineOut);
  const handover = ctx.db
    .prepare(
      `SELECT h.*, f.name AS forwarded_by_name, r.name AS received_by_name
         FROM handovers h
         LEFT JOIN users f ON f.id = h.forwarded_by
         LEFT JOIN users r ON r.id = h.received_by
        WHERE h.bill_id = ?`
    )
    .get(id);

  return {
    bill: { ...billOut(b), taxLines },
    stages: stages.map((s) => ({
      id: s.id,
      sequence: s.sequence,
      name: s.name,
      roleName: s.role_name,
      roleCode: s.role_code,
      status: s.status,
      actedBy: s.acted_by,
      actedByName: s.acted_by_name,
      actedByDesignation: s.acted_by_designation,
      actedAt: s.acted_at,
      comments: s.comments,
      signatureImage: s.signature_image,
      escalationDays: s.escalation_days,
    })),
    attachments,
    adjustments: adjustments.map((a) => ({
      id: a.id,
      advanceId: a.advance_id,
      advanceNo: a.advance_no,
      advanceDate: a.advance_date,
      amount: a.amount,
    })),
    handover,
    availableAdvances: availableAdvances(ctx.db, b.vendor_id, id),
    canAct: b.status === 'pending' && canAct(ctx.user, stage),
    activeStageId: stage ? stage.id : null,
    activeStageName: stage ? stage.name : null,
    activeStageRoleCode: stage ? stage.role_code : null,
    verifyToken: reportToken(id),
  };
}

/* ------------------------------------------------------------------ */
/* Report verification token                                           */
/* ------------------------------------------------------------------ */
function verifySecret(db) {
  let row = db.prepare("SELECT value FROM settings WHERE key = 'app.secret'").get();
  if (!row) {
    const crypto = require('node:crypto');
    const secret = crypto.randomBytes(32).toString('hex');
    db.prepare("INSERT INTO settings(key, value) VALUES ('app.secret', ?) ON CONFLICT DO NOTHING").run(secret);
    row = { value: secret };
  }
  return row.value;
}

function reportToken(billId) {
  const { db } = require('../db');
  return `${billId}.${auth.sign('bill:' + billId, verifySecret(db))}`;
}

function parseReportToken(db, token) {
  const [idPart, sig] = String(token || '').split('.');
  if (!idPart || !sig) return null;
  const expected = auth.sign('bill:' + idPart, verifySecret(db));
  if (sig.length !== expected.length) return null;
  if (!require('node:crypto').timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  return Number(idPart);
}

/* ------------------------------------------------------------------ */
/* Attachments                                                         */
/* ------------------------------------------------------------------ */
function saveBillAttachments(ctx, billId, attachments) {
  if (!Array.isArray(attachments)) return;
  const stmt = ctx.db.prepare(
    `INSERT INTO bill_attachments(bill_id, doc_type, file_name, stored_name, mime_type, size, uploaded_by, uploaded_at)
     VALUES (?,?,?,?,?,?,?,?)`
  );
  const ALLOWED_EXT = new Set(['.pdf','.jpg','.jpeg','.png','.xls','.xlsx','.doc','.docx']);
  const MAX_SIZE = 20 * 1024 * 1024;
  for (const doc of attachments) {
    if (!doc || !doc.name || !doc.data) continue;
    const ext = path.extname(doc.name || '').toLowerCase();
    if (!ALLOWED_EXT.has(ext)) throw badRequest('Attachment type not allowed: ' + doc.name + '. Allowed: PDF, JPG, PNG, Excel, Word.');
    const buf = Buffer.from(doc.data || '', 'base64');
    if (buf.length > MAX_SIZE) throw badRequest('Attachment exceeds 20 MB: ' + doc.name + '.');
    const saved = saveUpload(doc, UPLOAD_DIR);
    stmt.run(billId, doc.docType || 'Supporting Document', doc.name, saved.stored,
      doc.mime || 'application/octet-stream', saved.size, ctx.user.id, nowIso());
  }
}

/* ------------------------------------------------------------------ */
/* Tax & transport calculation                                         */
/* ------------------------------------------------------------------ */
/* GST is derived from the basic invoice amount. A bill can be:
   - cgst_sgst: intra-state, split equally between CGST and SGST
   - igst:      inter-state, a single IGST line
   - non_gst:   no GST on the basic amount
   One invoice may contain several taxable components, each at its own GST
   rate (for example Rs.2,500 at 18% and Rs.500 at 5%). Transport is a
   separate charge and may itself be GST or Non-GST. */
function calculateTax(body, invoiceAmount) {
  const gstTypes = ['cgst_sgst', 'igst', 'non_gst'];
  const transportTypes = ['none', 'gst', 'non_gst'];
  const hasGstType = gstTypes.includes(body.gstType);
  let gstType = hasGstType ? body.gstType : 'cgst_sgst';
  const headerInclusive = taxRules.flag(body.taxInclusive);
  const headerDiscount = taxRules.parseHeaderDiscount(body, 'Bill');

  let sourceLines;
  if (Array.isArray(body.taxLines)) {
    if (!body.taxLines.length) throw badRequest('Add at least one tax component.');
    if (body.taxLines.length > 50) throw badRequest('A bill can have at most 50 tax components.');
    sourceLines = body.taxLines.map((line, index) => {
      const enteredAmount = round2(line.taxableAmount);
      const enteredRate = round2(line.gstRate);
      if (!Number.isFinite(enteredAmount) || enteredAmount < 0) {
        throw badRequest(`Tax component ${index + 1}: amount cannot be negative.`);
      }
      if (!Number.isFinite(enteredRate) || enteredRate < 0 || enteredRate > 100) {
        throw badRequest(`Tax component ${index + 1}: GST rate must be between 0 and 100.`);
      }
      const gstRate = gstType === 'non_gst' ? 0 : enteredRate;
      const inclusive = taxRules.flag(line.taxInclusive ?? headerInclusive, headerInclusive);
      const taxableAmount = inclusive && gstRate > 0
        ? round2(enteredAmount / (1 + gstRate / 100))
        : enteredAmount;
      return {
        label: String(line.label || '').trim(),
        grossAmount: enteredAmount,
        taxableAmount,
        gstRate,
        taxInclusive: inclusive,
      };
    });
    invoiceAmount = round2(sourceLines.reduce((sum, line) => sum + line.taxableAmount, 0));
  } else {
    let gstRate = round2(body.gstRate);
    if (gstRate < 0 || gstRate > 100) throw badRequest('GST rate must be between 0 and 100.');
    if (!hasGstType) {
      /* Backwards compatibility for callers that only send a tax amount. */
      const basicTax = round2(body.taxAmount);
      if (basicTax < 0) throw badRequest('Tax amount cannot be negative.');
      gstRate = invoiceAmount > 0 ? round2((basicTax / invoiceAmount) * 100) : 0;
      gstType = basicTax > 0 ? 'cgst_sgst' : 'non_gst';
    }
    if (gstType === 'non_gst') gstRate = 0;
    const enteredAmount = round2(invoiceAmount);
    const taxableAmount = headerInclusive && gstRate > 0
      ? round2(enteredAmount / (1 + gstRate / 100))
      : enteredAmount;
    invoiceAmount = taxableAmount;
    sourceLines = [{
      label: '',
      grossAmount: enteredAmount,
      taxableAmount,
      gstRate,
      taxInclusive: headerInclusive,
    }];
  }

  const taxLines = sourceLines.map((line, index) => {
    const gstRate = line.gstRate;
    let cgstAmount = 0;
    let sgstAmount = 0;
    let igstAmount = 0;
    if (gstType === 'igst') {
      igstAmount = round2((line.taxableAmount * gstRate) / 100);
    } else if (gstType === 'cgst_sgst') {
      cgstAmount = round2((line.taxableAmount * gstRate) / 200);
      sgstAmount = round2((line.taxableAmount * gstRate) / 100 - cgstAmount);
    }
    return {
      sequence: index + 1,
      label: line.label,
      taxableAmount: round2(line.taxableAmount),
      gstRate,
      cgstAmount,
      sgstAmount,
      igstAmount,
      taxAmount: round2(cgstAmount + sgstAmount + igstAmount),
      taxInclusive: !!line.taxInclusive,
    };
  });

  const cgstAmount = round2(taxLines.reduce((sum, line) => sum + line.cgstAmount, 0));
  const sgstAmount = round2(taxLines.reduce((sum, line) => sum + line.sgstAmount, 0));
  const igstAmount = round2(taxLines.reduce((sum, line) => sum + line.igstAmount, 0));
  const basicTax = round2(cgstAmount + sgstAmount + igstAmount);
  const gstRate = invoiceAmount > 0 ? round2((basicTax / invoiceAmount) * 100) : 0;

  let transportType = transportTypes.includes(body.transportType) ? body.transportType : null;
  let transportAmount = round2(body.transportAmount);
  if (transportAmount < 0) throw badRequest('Transport amount cannot be negative.');
  if (!transportType) {
    transportType = transportAmount > 0
      ? (round2(body.transportTaxAmount) > 0 ? 'gst' : 'non_gst')
      : 'none';
  }
  if (transportType === 'none') transportAmount = 0;

  let transportGstRate = round2(body.transportGstRate);
  if (transportGstRate < 0 || transportGstRate > 100) {
    throw badRequest('Transport GST rate must be between 0 and 100.');
  }
  let transportTaxAmount = 0;
  if (transportType === 'gst' && transportAmount > 0) {
    transportTaxAmount = round2((transportAmount * transportGstRate) / 100);
  } else {
    transportGstRate = transportType === 'gst' ? transportGstRate : 0;
  }

  const taxAmount = round2(basicTax + transportTaxAmount);
  const grossPayable = round2(invoiceAmount + taxAmount + transportAmount);
  const percentDiscount = round2((grossPayable * headerDiscount.discountPercent) / 100);
  const discountAmount = round2(Math.min(grossPayable, percentDiscount + headerDiscount.discountAmount));

  /* Round only after all line discounts, header discounts, taxes and charges.
   * The final rounded value is persisted in net_amount so reports and payables
   * stay correct; round_off holds the adjustment for display. */
  const {
    baseTotalAmount, roundOff, totalAmount: netAmount, manual: manualRoundOff,
  } = calculateRoundOff(grossPayable - discountAmount, body.roundOff);
  return {
    baseTotalAmount,
    roundOff,
    manualRoundOff,
    gstType,
    gstRate,
    cgstAmount,
    sgstAmount,
    igstAmount,
    taxInclusive: taxLines.some((line) => line.taxInclusive),
    discountPercent: headerDiscount.discountPercent,
    discountAmount,
    transportType,
    transportAmount,
    transportGstRate,
    transportTaxAmount,
    taxAmount,
    netAmount,
    invoiceAmount,
    taxLines,
  };
}

function validateBillBody(ctx, body, existingId) {
  if (!body.vendorId) throw badRequest('Vendor is required.');
  const vendor = ctx.db.prepare('SELECT * FROM vendors WHERE id = ?').get(Number(body.vendorId));
  if (!vendor) throw badRequest('Selected vendor does not exist.');
  if (vendor.status === 'Blacklisted') throw badRequest('Bills cannot be raised against a blacklisted vendor.');
  if (!body.invoiceNumber) throw badRequest('Invoice number is required.');
  if (!body.invoiceDate) throw badRequest('Invoice date is required.');
  if (body.entryDate && String(body.entryDate).slice(0, 10) !== today()) throw badRequest('Entry date must be today.');
  const invoiceDate = String(body.invoiceDate).slice(0, 10);
  const todayDate = today();
  if (invoiceDate > todayDate) {
    throw badRequest('Invoice date cannot be in the future. Please enter today or an earlier date.');
  }
  let dueDate = null;
  if (body.dueDate) {
    dueDate = String(body.dueDate).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) throw badRequest('Due date is invalid.');
    if (dueDate < invoiceDate) throw badRequest('Due date cannot be before the invoice date.');
  }

  const billType = ['credit', 'cash'].includes(body.billType) ? body.billType : 'credit';
  const cashSettlementType = ['', 'imprest', 'reimbursement'].includes(body.cashSettlementType)
    ? body.cashSettlementType
    : '';
  const imprestReference = String(body.imprestReference || '').trim();

  let unitId = body.unitId ? Number(body.unitId) : null;
  if (!unitId && existingId) {
    const ex = ctx.db.prepare('SELECT unit_id FROM bills WHERE id = ?').get(existingId);
    unitId = ex ? ex.unit_id : null;
  }
  if (!unitId) unitId = ctx.unitId;
  if (!unitId) throw badRequest('Select a unit for this bill.');
  const unitRow = ctx.db.prepare('SELECT active FROM units WHERE id = ?').get(unitId);
  if (!unitRow) throw badRequest('Selected unit does not exist.');
  if (!unitRow.active) throw badRequest('Selected unit is inactive.');
  const member = ctx.db.prepare('SELECT 1 FROM user_units WHERE user_id = ? AND unit_id = ?').get(ctx.user.id, unitId);
  if (!member) throw badRequest('You are not a member of the selected unit.');
  const calc = calculateTax(body, round2(body.invoiceAmount));
  const invoiceAmount = calc.invoiceAmount;
  if (!(invoiceAmount > 0)) throw badRequest('Invoice amount must be greater than zero.');
  const {
    gstType, gstRate, cgstAmount, sgstAmount, igstAmount,
    taxInclusive, discountPercent, discountAmount,
    transportType, transportAmount, transportGstRate, transportTaxAmount,
    taxAmount, baseTotalAmount, roundOff, netAmount, taxLines, manualRoundOff,
  } = calc;

  const invoiceNumber = String(body.invoiceNumber).trim();
  const dup = ctx.db
    .prepare(
      `SELECT id, bill_no FROM bills
        WHERE vendor_id = ? AND invoice_number = ? COLLATE NOCASE
          AND status <> 'cancelled' AND id <> ?`
    )
    .get(vendor.id, invoiceNumber, existingId || 0);
  if (dup) {
    throw new HttpError(409, `Invoice Number ${invoiceNumber} already exists for this vendor.`, {
      duplicateOf: dup.bill_no,
    });
  }

  /* Retention is normally a percentage of the basic (pre-tax) invoice value,
     but a directly entered amount is allowed and takes precedence. */
  const retentionPercentage = round2(body.retentionPercentage);
  if (retentionPercentage < 0 || retentionPercentage > 100) {
    throw badRequest('Retention percentage must be between 0 and 100.');
  }
  const hasRetentionAmount = body.retentionAmount !== '' && body.retentionAmount !== null && body.retentionAmount !== undefined;
  const retentionAmount = hasRetentionAmount
    ? round2(body.retentionAmount)
    : round2((invoiceAmount * retentionPercentage) / 100);
  if (retentionAmount < 0) throw badRequest('Retention amount cannot be negative.');
  if (retentionAmount > invoiceAmount + 0.004) {
    throw badRequest('Retention amount cannot exceed the basic invoice amount.');
  }

  const retentionReleasedAmount = round2(body.retentionReleasedAmount);
  if (retentionReleasedAmount < 0) throw badRequest('Retention released amount cannot be negative.');
  if (retentionReleasedAmount > retentionAmount + 0.004) {
    throw badRequest('Retention released amount cannot exceed the retention amount.');
  }

  const holdAmount = round2(body.holdAmount);
  if (holdAmount < 0) throw badRequest('Snag-work hold amount cannot be negative.');
  if (holdAmount > netAmount + 0.004) {
    throw badRequest('Snag-work hold amount cannot exceed the net bill amount.');
  }

  const holdReleasedAmount = round2(body.holdReleasedAmount);
  if (holdReleasedAmount < 0) throw badRequest('Hold released amount cannot be negative.');
  if (holdReleasedAmount > holdAmount + 0.004) {
    throw badRequest('Hold released amount cannot exceed the hold amount.');
  }

  const creditNoteAmount = round2(body.creditNoteAmount);
  if (creditNoteAmount < 0) throw badRequest('Credit note amount cannot be negative.');
  if (creditNoteAmount > netAmount + 0.004) {
    throw badRequest('Credit note amount cannot exceed the net bill amount.');
  }

  /* Release dates are optional: when a release is recorded without a date the
     current system date is captured automatically. A release that has not
     happened yet cannot carry a future date. */
  const retentionReleaseDate = retentionReleasedAmount > 0
    ? String(body.retentionReleaseDate || todayDate).slice(0, 10)
    : null;
  if (retentionReleaseDate && retentionReleaseDate > todayDate) {
    throw badRequest('Retention release date cannot be in the future.');
  }
  const holdReleaseDate = holdReleasedAmount > 0
    ? String(body.holdReleaseDate || todayDate).slice(0, 10)
    : null;
  if (holdReleaseDate && holdReleaseDate > todayDate) {
    throw badRequest('Hold release date cannot be in the future.');
  }

  const retentionWithheld = round2(Math.max(retentionAmount - retentionReleasedAmount, 0));
  const holdWithheld = round2(Math.max(holdAmount - holdReleasedAmount, 0));
  let advanceTotal = 0;
  if (Array.isArray(body.advanceAdjustments)) {
    advanceTotal = round2(body.advanceAdjustments.reduce((sum, item) => sum + amount(item.amount), 0));
  } else if (existingId) {
    const existing = ctx.db.prepare('SELECT advance_adjusted FROM bills WHERE id = ?').get(existingId);
    advanceTotal = round2(existing ? existing.advance_adjusted : 0);
  }
  const totalDeductions = round2(advanceTotal + retentionWithheld + holdWithheld + creditNoteAmount);
  if (totalDeductions > netAmount + 0.004) {
    throw badRequest('Advance adjustment, retention, snag-work hold and credit note together cannot exceed the net bill amount.');
  }

  return {
    vendor,
    invoiceAmount,
    taxAmount,
    baseTotalAmount,
    roundOff,
    netAmount,
    manualRoundOff,
    gstType,
    gstRate,
    cgstAmount,
    sgstAmount,
    igstAmount,
    taxInclusive,
    discountPercent,
    discountAmount,
    taxLines,
    unitId,
    billType,
    cashSettlementType,
    imprestReference,
    dueDate,
    transportType,
    transportAmount,
    transportGstRate,
    transportTaxAmount,
    invoiceNumber,
    retentionPercentage,
    retentionAmount,
    retentionReleasedAmount,
    retentionReleaseDate,
    retentionReleaseRemarks: String(body.retentionReleaseRemarks || '').trim(),
    holdAmount,
    holdReleasedAmount,
    holdReleaseDate,
    holdReleaseRemarks: String(body.holdReleaseRemarks || '').trim(),
    creditNoteNumber: String(body.creditNoteNumber || '').trim(),
    creditNoteDate: body.creditNoteDate || null,
    creditNoteAmount,
    creditNoteRemarks: String(body.creditNoteRemarks || '').trim(),
  };
}

/* Apply an approval decision to one bill. Shared by the single-bill action
   endpoint and the bulk approval endpoint. Throws on the first problem so a
   bulk request can record per-bill errors without failing the whole batch. */
function performBillAction(ctx, id, { action, comments = '', signatureImage, forwardToAdminPastor = false } = {}) {
  const permission = {
    approve: 'bill.approve',
    reject: 'bill.reject',
    return: 'bill.return',
    clarify: 'bill.clarify',
  }[action];
  if (!permission) throw new HttpError(400, 'Invalid approval action.');
  auth.guard(ctx.user, permission);

  const bill = ctx.db
    .prepare('SELECT b.*, v.name AS vendor_name FROM bills b JOIN vendors v ON v.id = b.vendor_id WHERE b.id = ?')
    .get(id);
  if (!bill) throw new HttpError(404, 'Bill not found.');
  if (!ctx.unitIds.includes(Number(bill.unit_id))) {
    throw new HttpError(404, 'Bill not found.');
  }
  if (bill.status !== 'pending') throw new HttpError(400, 'This bill is not pending approval.');

  const stage = activeStage(ctx.db, id);
  if (!stage) throw new HttpError(400, 'No active approval stage found.');
  if (!canAct(ctx.user, stage)) throw new HttpError(403, 'You are not the approver for the current stage.');
  if (forwardToAdminPastor && action !== 'approve') {
    throw new HttpError(400, 'Only an approval can be forwarded to the Administrative Pastor.');
  }
  if (forwardToAdminPastor && stage.role_code !== 'administrator') {
    throw new HttpError(400, 'Only the Administrator can forward a bill to the Administrative Pastor.');
  }

  const now = nowIso();
  const signature = signatureImage || ctx.user.signature_image || null;
  const stageStatus = { approve: 'approved', reject: 'rejected', return: 'returned', clarify: 'clarification' }[action];

  ctx.db
    .prepare('UPDATE bill_stages SET status=?, acted_by=?, acted_at=?, comments=?, signature_image=? WHERE id=?')
    .run(stageStatus, ctx.user.id, now, comments, signature, stage.id);

  let newStatus = bill.status;
  let message = '';

  if (action === 'approve') {
    // An Administrator may explicitly send the bill to the Administrative
    // Pastor even when the amount rule does not include that stage.
    if (forwardToAdminPastor) {
      ensureAdminPastorStage(ctx.db, id, { afterSequence: stage.sequence });
      audit(ctx, 'FORWARD', 'bill', id, { stage: stage.name }, {
        to: 'Administrative Pastor Approval',
        comments,
      });
    }
    const next = ctx.db
      .prepare(
        `SELECT bs.*, r.code AS role_code FROM bill_stages bs JOIN roles r ON r.id = bs.role_id
          WHERE bs.bill_id = ? AND bs.sequence > ? ORDER BY bs.sequence ASC LIMIT 1`
      )
      .get(id, stage.sequence);
    if (next) {
      ctx.db.prepare('UPDATE bills SET current_stage=?, updated_at=? WHERE id=?').run(next.sequence, now, id);
      notifyStage(ctx.db, bill, next);
      message = forwardToAdminPastor
        ? `Approved and forwarded to ${next.name}.`
        : `${stage.role_code === 'admin_assistant' ? 'Verified' : 'Approved'} and forwarded to ${next.name}.`;
    } else {
      newStatus = 'approved';
      ctx.db
        .prepare("UPDATE bills SET status='approved', approved_at=?, closed_at=?, updated_at=? WHERE id=?")
        .run(now, now, now, id);
      const handoverNo = nextHandoverNo();
      ctx.db
        .prepare(
          `INSERT INTO handovers(handover_no, bill_id, forwarded_at, forwarded_by, status, created_at)
           VALUES (?,?,?,?,'forwarded',?)`
        )
        .run(handoverNo, id, now, ctx.user.id, now);
      notify(
        [bill.created_by, ...userIdsByRole('accounts_viewer')],
        'Bill approved and handed over to Accounts',
        `${bill.bill_no} (${bill.vendor_name}) has received final approval and is now with Accounts. Handover ${handoverNo}.`,
        `#/handover`
      );
      message = `Final approval granted. Handed over to Accounts as ${handoverNo}.`;
    }
  } else if (action === 'reject') {
    newStatus = 'rejected';
    ctx.db.prepare("UPDATE bills SET status='rejected', closed_at=?, updated_at=? WHERE id=?").run(now, now, id);
    clearBillImprestSettlement(ctx.db, id, now);
    notify([bill.created_by], 'Bill rejected', `${bill.bill_no} was rejected by ${ctx.user.name}. ${comments || ''}`, `#/bills/${id}`);
    message = 'Bill rejected.';
  } else if (action === 'return') {
    newStatus = 'returned';
    ctx.db.prepare('UPDATE bills SET status=?, updated_at=? WHERE id=?').run('returned', now, id);
    notify([bill.created_by], 'Bill returned for correction', `${bill.bill_no} was returned by ${ctx.user.name}. ${comments || ''}`, `#/bills/${id}`);
    message = 'Bill returned to the creator for correction.';
  } else {
    newStatus = 'hold';
    ctx.db.prepare('UPDATE bills SET status=?, updated_at=? WHERE id=?').run('hold', now, id);
    notify([bill.created_by], 'Clarification requested', `${ctx.user.name} requested clarification on ${bill.bill_no}. ${comments || ''}`, `#/bills/${id}`);
    message = 'Clarification requested. The bill is on hold.';
  }

  audit(ctx, action.toUpperCase(), 'bill', id, { status: bill.status, stage: stage.name }, { status: newStatus, comments, forwardedToAdminPastor: !!forwardToAdminPastor });
  return { ok: true, status: newStatus, message, billNo: bill.bill_no };
}

/* ------------------------------------------------------------------ */
module.exports = function registerBillRoutes(router) {
  router.get('/api/bills', async (ctx) => {
    auth.guard(ctx.user, 'bill.view');
    const q = ctx.query;
    const page = Math.max(Number(q.page) || 1, 1);
    const pageSize = Math.min(Math.max(Number(q.pageSize) || 20, 1), 200);
    const where = ['1=1'];
    const params = [];

    if (q.search) {
      where.push('(b.bill_no LIKE ? OR b.invoice_number LIKE ? OR v.name LIKE ? OR v.code LIKE ? OR b.particulars LIKE ?)');
      const like = `%${q.search}%`;
      params.push(like, like, like, like, like);
    }
    if (q.status) {
      where.push('b.status = ?');
      params.push(q.status);
    }
    if (q.vendorId) {
      where.push('b.vendor_id = ?');
      params.push(Number(q.vendorId));
    }
    if (q.departmentId) {
      where.push('b.department_id = ?');
      params.push(Number(q.departmentId));
    }
    if (q.categoryId) {
      where.push('b.category_id = ?');
      params.push(Number(q.categoryId));
    }
    if (q.priority) {
      where.push('b.priority = ?');
      params.push(q.priority);
    }
    if (q.from) {
      where.push('b.entry_date >= ?');
      params.push(q.from);
    }
    if (q.to) {
      where.push('b.entry_date <= ?');
      params.push(q.to);
    }
    if (q.createdBy) {
      where.push('b.created_by = ?');
      params.push(Number(q.createdBy));
    }
    if (q.unitId) {
      where.push('b.unit_id = ?');
      params.push(Number(q.unitId));
    }
    /* Administrator level and above see every unit; others see only their own. */
    const unitIdList = ctx.unitIds.length ? ctx.unitIds : [0];
    where.push(`b.unit_id IN (${unitIdList.map(() => '?').join(',')})`);
    params.push(...unitIdList);
    if (q.pendingForMe === '1') {
      where.push(`b.status = 'pending' AND EXISTS (
        SELECT 1 FROM bill_stages bs WHERE bs.bill_id = b.id AND bs.status = 'pending'
          AND (bs.role_id = ? OR ? = 'super_admin'))`);
      params.push(ctx.user.role_id, ctx.user.role_code);
    }
    if (q.handoverStatus) {
      where.push('h.status = ?');
      params.push(q.handoverStatus);
    }

    const whereSql = where.join(' AND ');
    const base = `FROM bills b
      JOIN vendors v ON v.id = b.vendor_id
      LEFT JOIN units un ON un.id = b.unit_id
      LEFT JOIN departments d ON d.id = b.department_id
      LEFT JOIN categories c ON c.id = b.category_id
      LEFT JOIN users u ON u.id = b.created_by
      LEFT JOIN handovers h ON h.bill_id = b.id
      WHERE ${whereSql}`;

    const total = ctx.db.prepare(`SELECT COUNT(*) AS c ${base}`).get(...params).c;
    const rows = ctx.db
      .prepare(
        `SELECT b.*, v.name AS vendor_name, v.code AS vendor_code,
                d.name AS department_name, c.name AS category_name,
                u.name AS created_by_name, h.status AS handover_status, h.handover_no,
                (SELECT name FROM bill_stages bs WHERE bs.bill_id = b.id AND bs.status = 'pending' ORDER BY sequence LIMIT 1) AS current_stage_name,
                (SELECT r.code FROM bill_stages bs JOIN roles r ON r.id = bs.role_id
                  WHERE bs.bill_id = b.id AND bs.status = 'pending' ORDER BY sequence LIMIT 1) AS current_stage_role_code,
                (SELECT COUNT(*) FROM bill_attachments ba WHERE ba.bill_id = b.id) AS attachment_count
         ${base} ORDER BY b.id DESC LIMIT ? OFFSET ?`
      )
      .all(...params, pageSize, (page - 1) * pageSize);

    return {
      total,
      page,
      pageSize,
      pages: Math.max(Math.ceil(total / pageSize), 1),
      bills: rows.map(billOut),
      summary: ctx.db
        .prepare(
          `SELECT
             COUNT(*) AS total,
             SUM(CASE WHEN b.status='draft' THEN 1 ELSE 0 END) AS draft,
             SUM(CASE WHEN b.status='pending' THEN 1 ELSE 0 END) AS pending,
             SUM(CASE WHEN b.status='approved' THEN 1 ELSE 0 END) AS approved,
             SUM(CASE WHEN b.status='rejected' THEN 1 ELSE 0 END) AS rejected,
             COALESCE(SUM(b.net_amount),0) AS value
           ${base}`
        )
        .get(...params),
    };
  });

  router.get('/api/bills/:id', async (ctx) => {
    auth.guard(ctx.user, 'bill.view');
    return billDetail(ctx, Number(ctx.params.id));
  });

  router.post('/api/bills', async (ctx) => {
    auth.guard(ctx.user, 'bill.create');
    const body = ctx.body || {};
    const {
      invoiceAmount, taxAmount, discountPercent, discountAmount, taxInclusive, netAmount, roundOff, baseTotalAmount,
      manualRoundOff, gstType, gstRate, cgstAmount, sgstAmount, igstAmount,
      taxLines,
      unitId, billType, cashSettlementType, imprestReference, dueDate,
      transportType, transportAmount, transportGstRate, transportTaxAmount,
      invoiceNumber,
      retentionPercentage, retentionAmount, retentionReleasedAmount, retentionReleaseDate, retentionReleaseRemarks,
      holdAmount, holdReleasedAmount, holdReleaseDate, holdReleaseRemarks,
      creditNoteNumber, creditNoteDate, creditNoteAmount, creditNoteRemarks,
    } = validateBillBody(ctx, body);
    const now = nowIso();
    // Validate the imprest before creating the bill so a rejected reference
    // cannot leave an unusable draft behind.
    resolveBillImprestSettlement(ctx.db, {
      id: 0, billType, cashSettlementType, imprestReference, netAmount, unitId,
    });
    const billNo = nextBillNo();
    const res = ctx.db
      .prepare(
        `INSERT INTO bills(bill_no, entry_date, department_id, category_id, vendor_id, invoice_number,
           invoice_date, due_date, invoice_amount, tax_amount,
           discount_percent, discount_amount, tax_inclusive, net_amount, round_off,
           gst_type, gst_rate, cgst_amount, sgst_amount, igst_amount,
           transport_type, transport_amount, transport_gst_rate, transport_tax_amount,
           particulars, description, budget_head, cost_center, priority, status, current_stage,
           retention_percentage, retention_amount, retention_released_amount, retention_release_date, retention_release_remarks,
           hold_amount, hold_released_amount, hold_release_date, hold_release_remarks,
           credit_note_number, credit_note_date, credit_note_amount, credit_note_remarks,
           created_by, created_at, updated_at)
                  VALUES (?,?,?,?,?,?,
           ?,?,?,?,?,?,?,?,?,
           ?,?,?,?,?,
           ?,?,?,?,
           ?,?,?,?,?,'draft',0,
           ?,?,?,?,?,
           ?,?,?,?,
           ?,?,?,?,
?,?,?)
      `)
      .run(
        billNo,
        body.entryDate || today(),
        body.departmentId ? Number(body.departmentId) : null,
        body.categoryId ? Number(body.categoryId) : null,
        Number(body.vendorId),
        invoiceNumber,
        body.invoiceDate,
        dueDate,
        invoiceAmount,
        taxAmount,
        discountPercent,
        discountAmount,
        taxInclusive ? 1 : 0,
        netAmount,
        roundOff,
        gstType,
        gstRate,
        cgstAmount,
        sgstAmount,
        igstAmount,
        transportType,
        transportAmount,
        transportGstRate,
        transportTaxAmount,
        body.particulars || '',
        body.description || '',
        body.budgetHead || '',
        body.costCenter || '',
        body.priority || 'Medium',
        retentionPercentage,
        retentionAmount,
        retentionReleasedAmount,
        retentionReleaseDate,
        retentionReleaseRemarks,
        holdAmount,
        holdReleasedAmount,
        holdReleaseDate,
        holdReleaseRemarks,
        creditNoteNumber,
        creditNoteDate,
        creditNoteAmount,
        creditNoteRemarks,
        ctx.user.id,
        now,
        now
      );
    const id = Number(res.lastInsertRowid);
    saveTaxLines(ctx.db, id, taxLines);
    ctx.db.prepare('UPDATE bills SET unit_id=?, bill_type=?, cash_settlement_type=?, imprest_reference=? WHERE id=?')
      .run(unitId, billType, cashSettlementType, imprestReference, id);
    saveBillAttachments(ctx, id, body.attachments);
    if (Array.isArray(body.advanceAdjustments) && body.advanceAdjustments.length) {
      setBillAdjustments(ctx.db, id, body.advanceAdjustments, ctx.user.id);
    }
    audit(ctx, 'CREATE', 'bill', id, null, {
      billNo, invoiceNumber, baseTotalAmount, roundOff, netAmount, manualRoundOff,
      retentionAmount, holdAmount, creditNoteAmount,
      taxInclusive, discountPercent, discountAmount, gstRate,
    });

    // Auto-settle imprest for cash bills with imprest reference
    applyBillImprestSettlement(ctx.db, ctx, {
      id, billType, cashSettlementType, imprestReference, netAmount, unitId,
    }, now);
    return { id, billNo, baseTotalAmount, roundOff, netAmount };
  });

  router.put('/api/bills/:id', async (ctx) => {
    auth.guard(ctx.user, 'bill.edit');
    const id = Number(ctx.params.id);
    const bill = ctx.db.prepare('SELECT * FROM bills WHERE id = ?').get(id);
    if (!bill) throw new HttpError(404, 'Bill not found.');
    if (!['draft', 'returned', 'hold'].includes(bill.status)) {
      throw new HttpError(400, 'Only draft, returned or held bills can be edited.');
    }
    const body = ctx.body || {};
    const {
      invoiceAmount, taxAmount, discountPercent, discountAmount, taxInclusive, netAmount, roundOff, baseTotalAmount,
      manualRoundOff, gstType, gstRate, cgstAmount, sgstAmount, igstAmount,
      taxLines,
      unitId, billType, cashSettlementType, imprestReference, dueDate,
      transportType, transportAmount, transportGstRate, transportTaxAmount,
      invoiceNumber,
      retentionPercentage, retentionAmount, retentionReleasedAmount, retentionReleaseDate, retentionReleaseRemarks,
      holdAmount, holdReleasedAmount, holdReleaseDate, holdReleaseRemarks,
      creditNoteNumber, creditNoteDate, creditNoteAmount, creditNoteRemarks,
    } = validateBillBody(ctx, body, id);
    ctx.db
      .prepare(
        `UPDATE bills SET entry_date=?, department_id=?, category_id=?, vendor_id=?, invoice_number=?,
           invoice_date=?, due_date=?, invoice_amount=?, tax_amount=?,
           discount_percent=?, discount_amount=?, tax_inclusive=?, net_amount=?, round_off=?,
           gst_type=?, gst_rate=?, cgst_amount=?, sgst_amount=?, igst_amount=?,
           transport_type=?, transport_amount=?, transport_gst_rate=?, transport_tax_amount=?,
           particulars=?, description=?,
           budget_head=?, cost_center=?, priority=?,
           retention_percentage=?, retention_amount=?, retention_released_amount=?, retention_release_date=?, retention_release_remarks=?,
           hold_amount=?, hold_released_amount=?, hold_release_date=?, hold_release_remarks=?,
           credit_note_number=?, credit_note_date=?, credit_note_amount=?, credit_note_remarks=?,
           updated_at=?
         WHERE id=?`
      )
      .run(
        body.entryDate || bill.entry_date,
        body.departmentId ? Number(body.departmentId) : null,
        body.categoryId ? Number(body.categoryId) : null,
        Number(body.vendorId),
        invoiceNumber,
        body.invoiceDate,
        dueDate,
        invoiceAmount,
        taxAmount,
        discountPercent,
        discountAmount,
        taxInclusive ? 1 : 0,
        netAmount,
        roundOff,
        gstType,
        gstRate,
        cgstAmount,
        sgstAmount,
        igstAmount,
        transportType,
        transportAmount,
        transportGstRate,
        transportTaxAmount,
        body.particulars || '',
        body.description || '',
        body.budgetHead || '',
        body.costCenter || '',
        body.priority || 'Medium',
        retentionPercentage,
        retentionAmount,
        retentionReleasedAmount,
        retentionReleaseDate,
        retentionReleaseRemarks,
        holdAmount,
        holdReleasedAmount,
        holdReleaseDate,
        holdReleaseRemarks,
        creditNoteNumber,
        creditNoteDate,
        creditNoteAmount,
        creditNoteRemarks,
        nowIso(),
        id
      );
    saveTaxLines(ctx.db, id, taxLines);
    ctx.db.prepare('UPDATE bills SET unit_id=?, bill_type=?, cash_settlement_type=?, imprest_reference=? WHERE id=?')
      .run(unitId, billType, cashSettlementType, imprestReference, id);
    applyBillImprestSettlement(ctx.db, ctx, {
      id, billType, cashSettlementType, imprestReference, netAmount, unitId,
    }, nowIso());
    saveBillAttachments(ctx, id, body.attachments);
    if (Array.isArray(body.advanceAdjustments)) {
      setBillAdjustments(ctx.db, id, body.advanceAdjustments, ctx.user.id);
    } else if (Number(bill.vendor_id) !== Number(body.vendorId)) {
      reverseBillAdjustments(ctx.db, id, ctx.user.id);
    }
    audit(ctx, 'UPDATE', 'bill', id,
      {
        invoiceNumber: bill.invoice_number, netAmount: bill.net_amount,
        roundOff: round2(bill.round_off),
        retentionAmount: bill.retention_amount, holdAmount: bill.hold_amount,
        creditNoteAmount: bill.credit_note_amount,
      },
      {
        invoiceNumber, baseTotalAmount, roundOff, netAmount, manualRoundOff,
        retentionAmount, holdAmount, creditNoteAmount,
        taxInclusive, discountPercent, discountAmount, gstRate,
      });
    return { ok: true, baseTotalAmount, roundOff, netAmount };
  });

  router.delete('/api/bills/:id', async (ctx) => {
    auth.guard(ctx.user, 'bill.delete');
    const id = Number(ctx.params.id);
    const bill = ctx.db.prepare('SELECT * FROM bills WHERE id = ?').get(id);
    if (!bill) throw new HttpError(404, 'Bill not found.');
    if (bill.status !== 'draft') throw new HttpError(400, 'Only draft bills can be deleted.');
    clearBillImprestSettlement(ctx.db, id, nowIso());
    reverseBillAdjustments(ctx.db, id, ctx.user.id);
    ctx.db.prepare('DELETE FROM bills WHERE id = ?').run(id);
    audit(ctx, 'DELETE', 'bill', id, { billNo: bill.bill_no, invoiceNumber: bill.invoice_number });
    return { ok: true };
  });

  router.delete('/api/bills/:id/attachments/:attId', async (ctx) => {
    auth.guard(ctx.user, 'bill.edit');
    const id = Number(ctx.params.id);
    const bill = ctx.db.prepare('SELECT status FROM bills WHERE id = ?').get(id);
    if (!bill) throw new HttpError(404, 'Bill not found.');
    if (!['draft', 'returned', 'hold'].includes(bill.status)) throw new HttpError(400, 'Attachments cannot be removed at this stage.');
    const att = ctx.db
      .prepare('SELECT * FROM bill_attachments WHERE id = ? AND bill_id = ?')
      .get(Number(ctx.params.attId), id);
    if (!att) throw new HttpError(404, 'Attachment not found.');
    ctx.db.prepare('DELETE FROM bill_attachments WHERE id = ?').run(att.id);
    audit(ctx, 'DELETE_ATTACHMENT', 'bill', id, { fileName: att.file_name });
    return { ok: true };
  });

  /* ---------------------------------------------------------------- */
  /* Submit / resubmit                                                 */
  /* ---------------------------------------------------------------- */
  router.post('/api/bills/:id/submit', async (ctx) => {
    auth.guard(ctx.user, 'bill.create');
    const id = Number(ctx.params.id);
    const bill = ctx.db
      .prepare(
        `SELECT b.*, v.name AS vendor_name FROM bills b JOIN vendors v ON v.id = b.vendor_id WHERE b.id = ?`
      )
      .get(id);
    if (!bill) throw new HttpError(404, 'Bill not found.');
    if (!['draft', 'returned', 'hold'].includes(bill.status)) {
      throw new HttpError(400, 'This bill has already been submitted.');
    }
    ensureFallbackChain(ctx.db);
    const { rule, stages } = buildBillStages(ctx.db, id, bill.net_amount, bill.created_by);
    if (!stages.length) throw new HttpError(400, 'No approval stages are configured for this amount.');
    // Expenses in a category marked for Administrative Pastor approval always
    // include that stage, even when the amount falls below its normal range.
    const category = bill.category_id
      ? ctx.db.prepare('SELECT requires_admin_pastor FROM categories WHERE id = ?').get(Number(bill.category_id))
      : null;
    let categoryRequiresPastor = false;
    if (category && category.requires_admin_pastor) {
      categoryRequiresPastor = !!ensureAdminPastorStage(ctx.db, id);
    }
    const chain = ctx.db
      .prepare('SELECT name FROM bill_stages WHERE bill_id = ? ORDER BY sequence ASC')
      .all(id)
      .map((s) => s.name);
    ctx.db
      .prepare("UPDATE bills SET status='pending', current_stage=1, submitted_at=?, closed_at=NULL, updated_at=? WHERE id=?")
      .run(nowIso(), nowIso(), id);
    const stage = activeStage(ctx.db, id);
    notifyStage(ctx.db, bill, stage);
    notify(
      [bill.created_by],
      'Bill submitted for approval',
      `${bill.bill_no} has been submitted. Approval chain: ${chain.join(' \u2192 ')}.`,
      `#/bills/${id}`
    );
    audit(ctx, 'SUBMIT', 'bill', id, { status: bill.status }, {
      rule: rule ? rule.name : null,
      stages: chain,
      categoryRequiresPastor,
    });
    return { ok: true, rule: rule ? rule.name : null };
  });

  /* ---------------------------------------------------------------- */
  /* Approval actions                                                  */
  /* ---------------------------------------------------------------- */
  router.post('/api/bills/:id/action', async (ctx) => {
    const id = Number(ctx.params.id);
    return performBillAction(ctx, id, ctx.body || {});
  });

  /* Bulk approval: approve the current stage of several bills in one go. */
  router.post('/api/bills/bulk-action', async (ctx) => {
    const { ids, action = 'approve', comments = '', signatureImage } = ctx.body || {};
    auth.guard(ctx.user, 'bill.approve');
    if (!Array.isArray(ids) || !ids.length) throw badRequest('Select at least one bill to approve.');
    if (ids.length > 100) throw badRequest('A maximum of 100 bills can be processed at once.');
    if (action !== 'approve') throw badRequest('Only bulk approval is supported.');

    const results = [];
    for (const rawId of ids) {
      const id = Number(rawId);
      try {
        const result = performBillAction(ctx, id, { action, comments, signatureImage });
        results.push({ id, ok: true, ...result });
      } catch (err) {
        results.push({ id, ok: false, error: err.message || 'Approval failed.' });
      }
    }
    const approved = results.filter((r) => r.ok).length;
    const failed = results.length - approved;
    const message = failed
      ? `${approved} bill${approved === 1 ? '' : 's'} approved, ${failed} could not be approved.`
      : `${approved} bill${approved === 1 ? '' : 's'} approved.`;
    return { ok: failed === 0, approved, failed, message, results };
  });

  router.post('/api/bills/:id/respond', async (ctx) => {
    const id = Number(ctx.params.id);
    const bill = ctx.db.prepare('SELECT * FROM bills WHERE id = ?').get(id);
    if (!bill) throw new HttpError(404, 'Bill not found.');
    if (bill.status !== 'hold') throw new HttpError(400, 'This bill is not awaiting clarification.');
    if (bill.created_by !== ctx.user.id && !auth.can(ctx.user, 'bill.edit')) {
      throw new HttpError(403, 'Only the bill creator can respond to a clarification.');
    }
    const { message } = ctx.body || {};
    if (!message) throw new HttpError(400, 'A clarification response is required.');

    const stage = ctx.db
      .prepare("SELECT * FROM bill_stages WHERE bill_id = ? AND status = 'clarification' ORDER BY sequence DESC LIMIT 1")
      .get(id);
    if (!stage) throw new HttpError(400, 'No clarification request is open on this bill.');

    ctx.db
      .prepare(
        `UPDATE bill_stages SET status='pending', comments = COALESCE(comments,'') || '\nClarification: ' || ?, acted_at=NULL
          WHERE id = ?`
      )
      .run(message, stage.id);
    ctx.db.prepare("UPDATE bills SET status='pending', updated_at=? WHERE id=? ").run(nowIso(), id);

    const roleUserIds = stage.user_id ? [stage.user_id] : userIdsByRole(ctx.db.prepare('SELECT code FROM roles WHERE id=?').get(stage.role_id).code);
    notify(roleUserIds, 'Clarification received', `The creator responded to your clarification on ${bill.bill_no}.`, `#/bills/${id}`);
    audit(ctx, 'CLARIFICATION_RESPONSE', 'bill', id, null, { message });
    return { ok: true };
  });

  /* ---------------------------------------------------------------- */
  /* Approval report + public verification                             */
  /* ---------------------------------------------------------------- */
  router.get('/api/bills/:id/report', async (ctx) => {
    auth.guard(ctx.user, 'bill.view');
    const id = Number(ctx.params.id);
    const detail = billDetail(ctx, id);
    const settings = Object.fromEntries(
      ctx.db.prepare("SELECT key, value FROM settings WHERE key IN ('org.name','org.department','report.footer','public_base_url')").all().map((r) => [r.key, r.value])
    );
    const baseUrl = settings['public_base_url'] || `${ctx.req.headers['x-forwarded-proto'] || 'http'}://${ctx.req.headers.host}`;
    return {
      ...detail,
      org: {
        name: settings['org.name'] || '',
        department: settings['org.department'] || '',
        footer: settings['report.footer'] || '',
      },
      verifyUrl: `${baseUrl.replace(/\/$/, '')}/#/verify/${detail.verifyToken}`,
    };
  });

  router.get('/api/public/verify/:token', async (ctx) => {
    const id = parseReportToken(ctx.db, ctx.params.token);
    if (!id) throw new HttpError(404, 'Invalid or expired verification link.');
    const b = ctx.db
      .prepare(
        `SELECT b.id, b.bill_no, b.invoice_number, b.invoice_date, b.due_date, b.invoice_amount, b.tax_amount,
                b.net_amount, b.advance_adjusted, b.gst_type, b.gst_rate, b.cgst_amount, b.sgst_amount,
                b.igst_amount, b.transport_type, b.transport_amount, b.transport_gst_rate,
                b.transport_tax_amount, b.retention_percentage, b.retention_amount,
                b.retention_released_amount, b.hold_amount, b.hold_released_amount,
                b.credit_note_number, b.credit_note_date, b.credit_note_amount,
                b.status, b.approved_at, v.name AS vendor_name
           FROM bills b JOIN vendors v ON v.id = b.vendor_id WHERE b.id = ?`
      )
      .get(id);
    if (!b) throw new HttpError(404, 'Bill not found.');
    const stages = ctx.db
      .prepare(
        `SELECT bs.name, bs.status, bs.acted_at, u.name AS acted_by
           FROM bill_stages bs LEFT JOIN users u ON u.id = bs.acted_by
          WHERE bs.bill_id = ? ORDER BY bs.sequence`
      )
      .all(id);
  const taxLines = ctx.db
    .prepare('SELECT * FROM bill_tax_lines WHERE bill_id = ? ORDER BY sequence ASC, id ASC')
    .all(id)
    .map(taxLineOut);
    return {
      valid: true,
      billNo: b.bill_no,
      vendorName: b.vendor_name,
      invoiceNumber: b.invoice_number,
      invoiceDate: b.invoice_date,
      dueDate: b.due_date,
      invoiceAmount: b.invoice_amount,
      taxAmount: b.tax_amount,
      netAmount: b.net_amount,
      advanceAdjusted: b.advance_adjusted,
      ...billDeductions(b),
      status: b.status,
      approvedAt: b.approved_at,
      stages: stages.map((s) => ({ name: s.name, status: s.status, actedAt: s.acted_at, actedBy: s.acted_by })),
      taxLines,
    };
  }, { auth: false });

  void STATUS_LABELS;
};
