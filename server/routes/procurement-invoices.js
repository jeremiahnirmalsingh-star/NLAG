'use strict';

/**
 * Procurement invoices — validation and linkage to an ABMDAS draft bill.
 *
 * The ABMDAS bill remains the approval and payment source of truth. This route
 * only creates a linked draft bill, so no ABMDAS workflow is bypassed.
 */

const auth = require('../auth');
const { HttpError } = require('../http');
const {
  audit, notify, nowIso, today, round2, nextInvoiceNo, nextBillNo,
} = require('../util');
const {
  unitScope, inList, requireText, optionalText, optionalId, optionalDate,
  transaction, pageParams, ensureVendor, rowOr404,
} = require('../procurement/shared');
const { ensureAssetsForInvoice } = require('../procurement/assets');
const tax = require('../procurement/tax');

const INVOICE_STATUSES = ['draft', 'validated', 'billed', 'rejected', 'cancelled'];
const GST_TYPES = ['cgst_sgst', 'igst', 'non_gst'];
const OPEN_BILL_STATUSES = ['draft', 'validated', 'billed'];

function invoiceOut(row) {
  return {
    id: row.id,
    invoiceNo: row.invoice_no,
    supplierInvoiceNo: row.supplier_invoice_no,
    supplierInvoiceDate: row.supplier_invoice_date,
    poId: row.po_id,
    poNo: row.po_no || '',
    grnId: row.grn_id,
    grnNo: row.grn_no || '',
    vendorId: row.vendor_id,
    vendorCode: row.vendor_code || '',
    vendorName: row.vendor_name || '',
    unitId: row.unit_id,
    unitName: row.unit_name || '',
    departmentId: row.department_id,
    departmentName: row.department_name || '',
    status: row.status,
    subtotal: round2(row.subtotal),
    taxAmount: round2(row.tax_amount),
    discountPercent: Number(row.discount_percent) || 0,
    discountAmount: round2(row.discount_amount),
    baseTotalAmount: round2(round2(row.net_amount) - round2(row.round_off)),
    roundOff: round2(row.round_off),
    netAmount: round2(row.net_amount),
    gstType: row.gst_type,
    gstRate: round2(row.gst_rate),
    cgstAmount: round2(row.cgst_amount),
    sgstAmount: round2(row.sgst_amount),
    igstAmount: round2(row.igst_amount),
    dueDate: row.due_date,
    remarks: row.remarks || '',
    validatedBy: row.validated_by,
    validatedByName: row.validated_by_name || '',
    validatedAt: row.validated_at,
    validationRemarks: row.validation_remarks || '',
    rejectionReason: row.rejection_reason || '',
    abmdasBillId: row.abmdas_bill_id,
    abmdasBillNo: row.abmdas_bill_no || '',
    itemCount: Number(row.item_count) || 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function getInvoice(ctx, id) {
  const ids = unitScope(ctx);
  return rowOr404(
    ctx.db
      .prepare(
        `SELECT i.*, p.po_no, g.grn_no, v.code AS vendor_code, v.name AS vendor_name,
                u.name AS unit_name, d.name AS department_name,
                vu.name AS validated_by_name, b.bill_no AS abmdas_bill_no,
                (SELECT COUNT(*) FROM invoice_items ii WHERE ii.invoice_id = i.id) AS item_count
           FROM invoices i
           LEFT JOIN purchase_orders p ON p.id = i.po_id
           LEFT JOIN grns g ON g.id = i.grn_id
           JOIN vendors v ON v.id = i.vendor_id
           JOIN units u ON u.id = i.unit_id
           LEFT JOIN departments d ON d.id = i.department_id
           LEFT JOIN users vu ON vu.id = i.validated_by
           LEFT JOIN bills b ON b.id = i.abmdas_bill_id
          WHERE i.id = ? AND i.deleted_at IS NULL AND i.unit_id IN (${inList(ids)})`
      )
      .get(Number(id), ...ids),
    'Procurement invoice not found.'
  );
}

/* invoice_items.discount_amount stores the applied total. Expose the flat
 * component as well so the edit form never adds the percentage a second time. */
function invoiceLineFlatDiscount(row) {
  const percent = Number(row.discount_percent) || 0;
  const gross = round2((Number(row.quantity) || 0) * (Number(row.unit_price) || 0));
  const percentAmount = round2((gross * percent) / 100);
  return Math.max(0, round2((Number(row.discount_amount) || 0) - percentAmount));
}

function invoiceItems(db, invoiceId) {
  return db
    .prepare(
      `SELECT ii.*, i.item_code, i.name AS item_name, u.code AS uom_code
         FROM invoice_items ii
         LEFT JOIN items i ON i.id = ii.item_id
         LEFT JOIN uoms u ON u.id = COALESCE(ii.uom_id, i.uom_id)
        WHERE ii.invoice_id = ?
        ORDER BY ii.id`
    )
    .all(invoiceId)
    .map((row) => ({
      id: row.id,
      poItemId: row.po_item_id,
      grnItemId: row.grn_item_id,
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
      flatDiscountAmount: invoiceLineFlatDiscount(row),
      taxRate: Number(row.tax_rate) || 0,
      taxInclusive: !!row.tax_inclusive,
      taxableAmount: Number(row.taxable_amount) || 0,
      taxAmount: Number(row.tax_amount) || 0,
      totalAmount: Number(row.total_amount) || 0,
    }));
}

function receiptSummary(db, poId, grnId, excludeInvoiceId) {
  const params = [poId];
  let grnClause = '';
  if (grnId) {
    grnClause = ' AND g.id = ?';
    params.push(grnId);
  }
  const accepted = db
    .prepare(
      `SELECT gi.id AS grn_item_id, gi.po_item_id, gi.item_id, gi.accepted_quantity, gi.unit_price,
              g.id AS grn_id
         FROM grn_items gi
         JOIN grns g ON g.id = gi.grn_id
        WHERE g.po_id = ? AND g.status = 'posted'${grnClause}
        ORDER BY gi.id`
    )
    .all(...params);

  const invoiced = db
    .prepare(
      `SELECT COALESCE(SUM(ii.quantity), 0) AS qty
         FROM invoice_items ii
         JOIN invoices i ON i.id = ii.invoice_id
        WHERE i.po_id = ? AND i.status <> 'cancelled' AND i.deleted_at IS NULL
          AND i.id <> ? AND ii.po_item_id = ?`
    );
  const invoicedByLine = db
    .prepare(
      `SELECT COALESCE(SUM(ii.quantity), 0) AS qty
         FROM invoice_items ii
         JOIN invoices i ON i.id = ii.invoice_id
        WHERE i.po_id = ? AND i.status <> 'cancelled' AND i.deleted_at IS NULL
          AND i.id <> ? AND ii.grn_item_id = ?`
    );

  const byPoItem = new Map();
  for (const row of accepted) {
    const entry = byPoItem.get(row.po_item_id) || {
      poItemId: row.po_item_id,
      itemId: row.item_id,
      accepted: 0,
      invoiced: Number(invoiced.get(poId, excludeInvoiceId || 0, row.po_item_id).qty) || 0,
      unitPrice: Number(row.unit_price) || 0,
      grnItemId: row.grn_item_id,
      grnId: row.grn_id,
    };
    entry.accepted = round2(entry.accepted + Number(row.accepted_quantity));
    byPoItem.set(row.po_item_id, entry);
  }
  return { accepted, byPoItem, invoicedByLine, poId, excludeInvoiceId };
}

/* Invoice lines inherit the PO basis. A flat PO discount is a whole-order
 * amount, so it is prorated to the quantity currently being invoiced. */
function invoiceLineDefaults(ctx, poLine, quantity) {
  const itemDefaults = poLine?.item_id ? tax.itemDefaults(ctx.db, poLine.item_id) : {};
  if (!poLine) return itemDefaults;
  const percent = Number(poLine.discount_percent ?? itemDefaults.discountPercent ?? 0) || 0;
  const grossPo = round2(Number(poLine.quantity || 0) * Number(poLine.unit_price || 0));
  const percentAmount = round2((grossPo * percent) / 100);
  const flatPo = poLine.flat_discount_amount !== undefined
    ? Math.max(0, round2(Number(poLine.flat_discount_amount) || 0))
    : Math.max(0, round2(Number(poLine.discount_amount ?? itemDefaults.discountAmount ?? 0) - percentAmount));
  const ratio = Number(poLine.quantity) > 0 ? quantity / Number(poLine.quantity) : 0;
  return {
    taxRate: Number(poLine.tax_rate ?? itemDefaults.taxRate ?? 0) || 0,
    taxInclusive: poLine.tax_inclusive === undefined
      ? !!itemDefaults.taxInclusive
      : !!poLine.tax_inclusive,
    discountPercent: percent,
    discountAmount: round2(flatPo * ratio),
  };
}

/* Stored invoice header discount_amount is the applied total. Recover the
 * flat portion when an edit payload omits it, so the percent is not doubled. */
function invoiceHeaderFlatAmount(existing, items) {
  if (!existing) return 0;
  const percent = Number(existing.discount_percent) || 0;
  const gross = round2(items.reduce((sum, line) => sum + Number(line.totalAmount || 0), 0));
  const percentAmount = round2((gross * percent) / 100);
  return Math.max(0, round2(Number(existing.discount_amount || 0) - percentAmount));
}

function invoiceLines(ctx, po, body, existingInvoice) {
  const explicit = Array.isArray(body.lines) ? body.lines : (Array.isArray(body.items) ? body.items : null);
  const grnId = optionalId(body, 'grnId') || (existingInvoice?.grn_id ?? null);
  const poItems = ctx.db
    .prepare(
      `SELECT pi.*, i.name AS item_name, i.item_type AS item_type, i.uom_id AS item_uom_id
         FROM po_items pi LEFT JOIN items i ON i.id = pi.item_id
        WHERE pi.po_id = ? ORDER BY pi.id`
    )
    .all(po.id);
  const poLineMap = new Map(poItems.map((line) => [line.id, line]));
  const summary = receiptSummary(ctx.db, po.id, grnId, existingInvoice?.id);
  /* Service acceptance quantities (if any) cap invoicing for service lines. */
  const saAccepted = new Map();
  const saRows = ctx.db
    .prepare(
      `SELECT sai.po_item_id, COALESCE(SUM(sai.accepted_quantity),0) AS qty
         FROM service_acceptance_items sai
         JOIN service_acceptances sa ON sa.id = sai.sa_id
        WHERE sa.po_id = ? AND sa.status = 'accepted' AND sa.deleted_at IS NULL
        GROUP BY sai.po_item_id`
    )
    .all(po.id);
  for (const row of saRows) saAccepted.set(row.po_item_id, Number(row.qty) || 0);

  const poRemaining = new Map();
  for (const item of poItems) {
    const entry = summary.byPoItem.get(item.id);
    const accepted = entry ? entry.accepted : 0;
    const invoiced = entry ? entry.invoiced : 0;
    let available;
    if (item.item_type === 'service') {
      const saQty = saAccepted.has(item.id) ? saAccepted.get(item.id) : null;
      const cap = saQty === null ? Number(item.quantity) : saQty;
      available = round2(Math.max(cap - invoiced, 0));
    } else {
      available = round2(Math.max(accepted - invoiced, 0));
    }
    poRemaining.set(item.id, available);
  }
  const poItemById = new Map(poItems.map((line) => [line.id, line]));

  let source;
  if (explicit) {
    if (!explicit.length) throw new HttpError(400, 'Add at least one invoice line.');
    if (explicit.length > 100) throw new HttpError(400, 'An invoice can hold at most 100 lines.');
    source = explicit.map((line, index) => {
      const poItemId = Number(line.poItemId);
      const poLine = poLineMap.get(poItemId);
      if (!poLine) throw new HttpError(400, `Line ${index + 1}: purchase order line was not found.`);
      const quantity = Number(line.quantity);
      if (!Number.isFinite(quantity) || quantity <= 0) {
        throw new HttpError(400, `Line ${index + 1}: quantity must be greater than zero.`);
      }
      const available = poRemaining.get(poItemId) || 0;
      if (quantity > available + 0.004) {
        throw new HttpError(
          400,
          `Line ${index + 1}: quantity exceeds the accepted quantity available for invoicing (${available}).`
        );
      }
      const grnItemId = line.grnItemId ? Number(line.grnItemId) : null;
      if (grnItemId) {
        const receipt = ctx.db
          .prepare(
            `SELECT gi.* FROM grn_items gi JOIN grns g ON g.id = gi.grn_id
              WHERE gi.id = ? AND gi.po_item_id = ? AND g.po_id = ? AND g.status = 'posted'`
          )
          .get(grnItemId, poItemId, po.id);
        if (!receipt) throw new HttpError(400, `Line ${index + 1}: goods receipt line was not found.`);
      }
      poRemaining.set(poItemId, round2(available - quantity));
      return {
        poItemId,
        grnItemId,
        itemId: poLine.item_id,
        description: String(line.description || '').trim().slice(0, 300) || poLine.description || poLine.item_name,
        uomId: line.uomId ? Number(line.uomId) : (poLine.uom_id || poLine.item_uom_id),
        quantity: round2(quantity),
        unitPrice: line.unitPrice === undefined ? round2(poLine.unit_price) : Number(line.unitPrice),
        discountPercent: line.discountPercent,
        discountAmount: line.discountAmount,
        taxRate: line.taxRate,
        taxInclusive: line.taxInclusive,
        grnId: null,
      };
    });
  } else {
    /* Build receipt-backed defaults. Prefer the requested GRN; otherwise group
       accepted quantities by purchase order line across all posted receipts. */
    const accepted = summary.accepted;
    const serviceLines = poItems.filter((p) => p.item_type === 'service');
    if (!accepted.length && !serviceLines.length) {
      throw new HttpError(400, 'Post a goods receipt before raising an invoice.');
    }
    if (!accepted.length) {
      source = [];
      for (const poLine of serviceLines) {
        const remaining = poRemaining.get(poLine.id) || 0;
        if (remaining <= 0.004) continue;
        source.push({
          poItemId: poLine.id,
          grnItemId: null,
          itemId: poLine.item_id,
          description: poLine.description || poLine.item_name || '',
          uomId: poLine.uom_id || poLine.item_uom_id,
          quantity: remaining,
          unitPrice: round2(poLine.unit_price || 0),
          taxRate: round2(poLine.tax_rate || 0),
          grnId: null,
        });
      }
      if (!source.length) throw new HttpError(400, 'There is no quantity left to invoice.');
    } else if (grnId) {
      source = [];
      for (const row of accepted) {
        const poLine = poLineMap.get(row.po_item_id);
        const lineInvoiced = Number(
          summary.invoicedByLine.get(po.id, existingInvoice?.id || 0, row.grn_item_id).qty
        ) || 0;
        const poAvailable = poRemaining.get(row.po_item_id) || 0;
        const quantity = round2(Math.min(Number(row.accepted_quantity) - lineInvoiced, poAvailable));
        if (quantity <= 0.004) continue;
        poRemaining.set(row.po_item_id, round2(poAvailable - quantity));
        source.push({
          poItemId: row.po_item_id,
          grnItemId: row.grn_item_id,
          itemId: row.item_id,
          description: poLine?.description || poLine?.item_name || '',
          uomId: poLine?.uom_id || poLine?.item_uom_id,
          quantity,
          unitPrice: round2(row.unit_price || poLine?.unit_price || 0),
          taxRate: round2(poLine?.tax_rate || 0),
          grnId: row.grn_id,
        });
      }
    } else {
      source = [];
      for (const [poItemId, entry] of summary.byPoItem.entries()) {
        const remaining = poRemaining.get(poItemId) || 0;
        if (remaining <= 0.004) continue;
        const poLine = poItemById.get(poItemId) || null;
        source.push({
          poItemId,
          grnItemId: null,
          itemId: entry.itemId,
          description: poLine?.description || poLine?.item_name || '',
          uomId: poLine?.uom_id || poLine?.item_uom_id,
          quantity: remaining,
          unitPrice: round2(entry.unitPrice || poLine?.unit_price || 0),
          taxRate: round2(poLine?.tax_rate || 0),
          grnId: null,
        });
      }
    }
    if (!source.length) throw new HttpError(400, 'There is no accepted quantity left to invoice.');
  }

  for (const [index, line] of source.entries()) {
    const poLine = poLineMap.get(line.poItemId);
    const defaults = invoiceLineDefaults(ctx, poLine, line.quantity);
    Object.assign(line, tax.parseLine(line, index, defaults, 'Line'));
  }
  return source;
}

function invoicePayload(ctx, body, existing) {
  const poId = optionalId(body, 'poId') || existing?.po_id || null;
  if (!poId) throw new HttpError(400, 'Select a purchase order.');
  const ids = unitScope(ctx);
  const po = rowOr404(
    ctx.db
      .prepare(
        `SELECT p.* FROM purchase_orders p
          WHERE p.id = ? AND p.deleted_at IS NULL AND p.unit_id IN (${inList(ids)})`
      )
      .get(poId, ...ids),
    'Purchase order not found.'
  );
  if (['draft', 'cancelled'].includes(po.status)) {
    throw new HttpError(400, 'Invoices can only be raised against an issued purchase order.');
  }
  ensureVendor(ctx.db, po.vendor_id);

  const supplierInvoiceNo = requireText(body, 'supplierInvoiceNo', 'Supplier invoice number', 100);
  const rawDate = optionalDate(body, 'supplierInvoiceDate', 'Supplier invoice date') || existing?.supplier_invoice_date;
  if (!rawDate) throw new HttpError(400, 'Supplier invoice date is required.');
  if (rawDate > today()) throw new HttpError(400, 'Supplier invoice date cannot be in the future.');
  const dueDate = body.dueDate === undefined ? (existing?.due_date || null) : optionalDate(body, 'dueDate');
  if (dueDate && dueDate < rawDate) throw new HttpError(400, 'Due date cannot be before the invoice date.');
  const gstType = String(body.gstType || existing?.gst_type || 'cgst_sgst');
  if (!GST_TYPES.includes(gstType)) throw new HttpError(400, 'GST type is invalid.');
  const grnId = optionalId(body, 'grnId') || existing?.grn_id || null;
  if (grnId) {
    const grn = ctx.db
      .prepare("SELECT * FROM grns WHERE id = ? AND po_id = ? AND status = 'posted'")
      .get(grnId, po.id);
    if (!grn) throw new HttpError(400, 'Select a posted goods receipt for this purchase order.');
  }

  const duplicate = ctx.db
    .prepare(
      `SELECT id FROM invoices
        WHERE vendor_id = ? AND supplier_invoice_no = ? COLLATE NOCASE
          AND status <> 'cancelled' AND deleted_at IS NULL AND id <> ?`
    )
    .get(po.vendor_id, supplierInvoiceNo, existing?.id || 0);
  if (duplicate) throw new HttpError(409, 'This supplier invoice number is already recorded for the vendor.');
  const existingBill = ctx.db
    .prepare(
      `SELECT id, bill_no FROM bills
        WHERE vendor_id = ? AND invoice_number = ? COLLATE NOCASE AND status <> 'cancelled' AND id <> ?`
    )
    .get(po.vendor_id, supplierInvoiceNo, existing?.abmdas_bill_id || 0);
  if (existingBill) throw new HttpError(409, `Invoice ${supplierInvoiceNo} already exists as bill ${existingBill.bill_no}.`);

  const items = invoiceLines(ctx, po, { ...body, grnId }, existing);
  const headerDiscount = tax.parseHeaderDiscount({
    discountPercent: body.discountPercent ?? existing?.discount_percent ?? 0,
    discountAmount: body.discountAmount ?? invoiceHeaderFlatAmount(existing, items),
  }, 'Invoice');
  const document = tax.calculateDocument(items, {
    ...headerDiscount,
    roundOff: body.roundOff ?? existing?.round_off,
  });
  const subtotal = document.subtotal;
  const taxAmount = document.taxAmount;
  const netAmount = document.totalAmount;
  const gstRate = subtotal > 0 && gstType !== 'non_gst' ? round2((taxAmount / subtotal) * 100) : 0;
  let cgstAmount = 0;
  let sgstAmount = 0;
  let igstAmount = 0;
  if (gstType === 'igst') igstAmount = taxAmount;
  else if (gstType === 'cgst_sgst') {
    cgstAmount = round2(taxAmount / 2);
    sgstAmount = round2(taxAmount - cgstAmount);
  }
  if (netAmount <= 0) throw new HttpError(400, 'The invoice value must be greater than zero.');

  return {
    po,
    grnId,
    supplierInvoiceNo,
    supplierInvoiceDate: rawDate,
    dueDate,
    gstType,
    gstRate,
    subtotal,
    taxAmount,
    discountPercent: document.discountPercent,
    discountAmount: document.discountAmount,
    baseTotalAmount: document.baseTotalAmount,
    roundOff: document.roundOff,
    document,
    netAmount,
    cgstAmount,
    sgstAmount,
    igstAmount,
    items,
    departmentId: po.department_id,
    remarks: body.remarks === undefined ? (existing?.remarks || '') : optionalText(body, 'remarks', 1000),
  };
}

function replaceInvoiceItems(db, invoiceId, lines, now) {
  db.prepare('DELETE FROM invoice_items WHERE invoice_id = ?').run(invoiceId);
  const insert = db.prepare(
    `INSERT INTO invoice_items(invoice_id, po_item_id, grn_item_id, item_id, description, uom_id,
       quantity, unit_price, discount_percent, discount_amount, tax_rate, tax_inclusive,
       taxable_amount, tax_amount, total_amount, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  for (const line of lines) {
    insert.run(
      invoiceId, line.poItemId, line.grnItemId || null, line.itemId, line.description, line.uomId,
      line.quantity, line.unitPrice, line.discountPercent || 0, line.discountAmount || 0,
      line.taxRate, line.taxInclusive ? 1 : 0, line.taxableAmount || 0,
      line.taxAmount, line.totalAmount, now
    );
  }
}

function createLinkedBill(ctx, invoice, body) {
  if (invoice.abmdas_bill_id) {
    const existing = ctx.db.prepare('SELECT id, bill_no FROM bills WHERE id = ?').get(invoice.abmdas_bill_id);
    if (existing) return { billId: existing.id, billNo: existing.bill_no, existing: true };
  }
  const bodyData = body || {};
  let categoryId = optionalId(bodyData, 'categoryId');
  if (categoryId) {
    const category = ctx.db.prepare('SELECT id FROM categories WHERE id = ? AND active = 1').get(categoryId);
    if (!category) throw new HttpError(400, 'ABMDAS category was not found.');
  } else {
    const category = ctx.db.prepare('SELECT id FROM categories WHERE active = 1 ORDER BY id LIMIT 1').get();
    if (!category) throw new HttpError(400, 'No active ABMDAS category is available. Add a category first.');
    categoryId = category.id;
  }
  let departmentId = invoice.department_id;
  if (bodyData.departmentId !== undefined) {
    departmentId = optionalId(bodyData, 'departmentId');
    if (departmentId) {
      const dept = ctx.db.prepare('SELECT id FROM departments WHERE id = ?').get(departmentId);
      if (!dept) throw new HttpError(400, 'Department was not found.');
    }
  }

  const duplicate = ctx.db
    .prepare(
      `SELECT id, bill_no FROM bills
        WHERE vendor_id = ? AND invoice_number = ? COLLATE NOCASE AND status <> 'cancelled'`
    )
    .get(invoice.vendor_id, invoice.supplier_invoice_no);
  if (duplicate) {
    throw new HttpError(409, `Invoice ${invoice.supplier_invoice_no} already exists as bill ${duplicate.bill_no}.`);
  }

  const billNo = nextBillNo();
  const now = nowIso();
  /* invoice rows have no .items array — read the inclusive flag from the
   * persisted invoice lines instead of relying on a nonexistent property. */
  const taxInclusive = ctx.db
    .prepare('SELECT 1 FROM invoice_items WHERE invoice_id = ? AND tax_inclusive = 1 LIMIT 1')
    .get(invoice.id) ? 1 : 0;
  const roundOff = round2(invoice.round_off || 0);
  const itemNames = ctx.db
    .prepare('SELECT description FROM invoice_items WHERE invoice_id = ? ORDER BY id')
    .all(invoice.id)
    .map((row) => row.description)
    .filter(Boolean)
    .join(', ')
    .slice(0, 500);
  const res = ctx.db
    .prepare(
      `INSERT INTO bills(bill_no, entry_date, department_id, category_id, vendor_id, invoice_number,
         invoice_date, due_date, invoice_amount, tax_amount, discount_percent, discount_amount,
         tax_inclusive, net_amount, round_off, gst_type, gst_rate, cgst_amount, sgst_amount, igst_amount,
         transport_type, transport_amount, transport_gst_rate, transport_tax_amount,
         particulars, description, budget_head, cost_center, priority, status, current_stage,
         created_by, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'none',0,0,0,?,?,'','','Medium','draft',0,?,?,?)`
    )
    .run(
      billNo, today(), departmentId, categoryId, invoice.vendor_id, invoice.supplier_invoice_no,
      invoice.supplier_invoice_date, invoice.due_date, invoice.subtotal, invoice.tax_amount,
      invoice.discount_percent, invoice.discount_amount,
      taxInclusive,
      invoice.net_amount, roundOff, invoice.gst_type, invoice.gst_rate, invoice.cgst_amount,
      invoice.sgst_amount, invoice.igst_amount,
      `Procurement invoice ${invoice.invoice_no}${invoice.po_id ? ` against ${invoice.po_no || 'purchase order'}` : ''}`,
      itemNames, ctx.user.id, now, now
    );
  const billId = Number(res.lastInsertRowid);
  ctx.db.prepare("UPDATE bills SET unit_id=?, bill_type='credit', cash_settlement_type='', imprest_reference='' WHERE id=?")
    .run(invoice.unit_id, billId);
  if (invoice.tax_amount > 0 || invoice.gst_rate > 0) {
    ctx.db
      .prepare(
        `INSERT INTO bill_tax_lines(bill_id, sequence, label, taxable_amount, tax_inclusive, gst_rate,
           cgst_amount, sgst_amount, igst_amount, tax_amount)
         VALUES (?,1,'GST',?,?,?,?,?,?,?)`
      )
      .run(
        billId, invoice.subtotal,
        taxInclusive,
        invoice.gst_rate, invoice.cgst_amount,
        invoice.sgst_amount, invoice.igst_amount, invoice.tax_amount
      );
  }
  return { billId, billNo, roundOff, existing: false };
}

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */
module.exports = function registerProcurementInvoiceRoutes(router) {
  router.get('/api/procurement/invoices/meta', async (ctx) => {
    auth.guard(ctx.user, 'invoice.view');
    const ids = unitScope(ctx);
    const ph = inList(ids);
    const purchaseOrders = ctx.db
      .prepare(
        `SELECT p.id, p.po_no, p.status, p.vendor_id, v.name AS vendor_name, p.unit_id,
                p.delivery_date
           FROM purchase_orders p JOIN vendors v ON v.id = p.vendor_id
          WHERE p.deleted_at IS NULL AND p.status IN ('issued','partially_received','received','closed')
            AND p.unit_id IN (${ph})
          ORDER BY p.po_date DESC, p.id DESC`
      )
      .all(...ids)
      .map((row) => ({
        id: row.id,
        poNo: row.po_no,
        status: row.status,
        vendorId: row.vendor_id,
        vendorName: row.vendor_name,
        unitId: row.unit_id,
        deliveryDate: row.delivery_date,
      }));
    const grns = ctx.db
      .prepare(
        `SELECT g.id, g.grn_no, g.po_id, g.received_date
           FROM grns g JOIN purchase_orders p ON p.id = g.po_id
          WHERE g.status = 'posted' AND p.unit_id IN (${ph})
          ORDER BY g.received_date DESC, g.id DESC`
      )
      .all(...ids)
      .map((row) => ({ id: row.id, grnNo: row.grn_no, poId: row.po_id, receivedDate: row.received_date }));
    const categories = ctx.db
      .prepare('SELECT id, name FROM categories WHERE active = 1 ORDER BY name COLLATE NOCASE')
      .all();
    return {
      purchaseOrders,
      grns,
      categories,
      gstTypes: GST_TYPES.map((value) => ({ value, label: value.replace(/_/g, ' ') })),
      statuses: INVOICE_STATUSES.map((value) => ({ value, label: value.replace(/_/g, ' ') })),
      today: today(),
    };
  });

  router.get('/api/procurement/invoices', async (ctx) => {
    auth.guard(ctx.user, 'invoice.view');
    const ids = unitScope(ctx);
    const q = ctx.query || {};
    const where = ['i.deleted_at IS NULL', `i.unit_id IN (${inList(ids)})`];
    const params = [...ids];
    if (q.search) {
      const like = `%${String(q.search).trim()}%`;
      where.push('(i.invoice_no LIKE ? OR i.supplier_invoice_no LIKE ? OR v.name LIKE ? OR p.po_no LIKE ?)');
      params.push(like, like, like, like);
    }
    if (q.status && INVOICE_STATUSES.includes(String(q.status))) {
      where.push('i.status = ?');
      params.push(String(q.status));
    }
    if (q.poId) {
      where.push('i.po_id = ?');
      params.push(Number(q.poId));
    }
    const { page, pageSize, offset } = pageParams(q);
    const total = ctx.db
      .prepare(
        `SELECT COUNT(*) AS c FROM invoices i JOIN vendors v ON v.id = i.vendor_id
           LEFT JOIN purchase_orders p ON p.id = i.po_id
          WHERE ${where.join(' AND ')}`
      )
      .get(...params).c;
    const rows = ctx.db
      .prepare(
        `SELECT i.*, p.po_no, g.grn_no, v.code AS vendor_code, v.name AS vendor_name,
                u.name AS unit_name, d.name AS department_name,
                vu.name AS validated_by_name, b.bill_no AS abmdas_bill_no,
                (SELECT COUNT(*) FROM invoice_items ii WHERE ii.invoice_id = i.id) AS item_count
           FROM invoices i
           LEFT JOIN purchase_orders p ON p.id = i.po_id
           LEFT JOIN grns g ON g.id = i.grn_id
           JOIN vendors v ON v.id = i.vendor_id
           JOIN units u ON u.id = i.unit_id
           LEFT JOIN departments d ON d.id = i.department_id
           LEFT JOIN users vu ON vu.id = i.validated_by
           LEFT JOIN bills b ON b.id = i.abmdas_bill_id
          WHERE ${where.join(' AND ')}
          ORDER BY i.created_at DESC, i.id DESC
          LIMIT ? OFFSET ?`
      )
      .all(...params, pageSize, offset);
    return { invoices: rows.map(invoiceOut), total, page, pageSize };
  });

  router.post('/api/procurement/invoices', async (ctx) => {
    auth.guard(ctx.user, 'invoice.manage');
    const data = invoicePayload(ctx, ctx.body || {}, null);
    const invoiceNo = nextInvoiceNo();
    const now = nowIso();
    let id;
    transaction(ctx.db, () => {
      const res = ctx.db
        .prepare(
          `INSERT INTO invoices(invoice_no, supplier_invoice_no, supplier_invoice_date, po_id, grn_id,
             vendor_id, unit_id, department_id, status, subtotal, tax_amount,
             discount_percent, discount_amount, net_amount, round_off,
             gst_type, gst_rate, cgst_amount, sgst_amount, igst_amount, due_date, remarks,
             created_by, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,'draft',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
        )
        .run(
          invoiceNo, data.supplierInvoiceNo, data.supplierInvoiceDate, data.po.id, data.grnId,
          data.po.vendor_id, data.po.unit_id, data.departmentId,
          data.subtotal, data.taxAmount, data.discountPercent, data.discountAmount, data.netAmount, data.roundOff,
          data.gstType, data.gstRate, data.cgstAmount, data.sgstAmount, data.igstAmount,
          data.dueDate, data.remarks, ctx.user.id, now, now
        );
      id = Number(res.lastInsertRowid);
      replaceInvoiceItems(ctx.db, id, data.items, now);
    });
    audit(ctx, 'CREATE', 'procurement_invoice', id, null, {
      invoiceNo, supplierInvoiceNo: data.supplierInvoiceNo, poId: data.po.id,
      netAmount: data.netAmount, discountPercent: data.discountPercent,
      baseTotalAmount: data.baseTotalAmount, roundOff: data.roundOff,
      ...tax.auditSummary(data.items, data.document),
    });
    return {
      id, invoiceNo, status: 'draft',
      baseTotalAmount: data.baseTotalAmount, roundOff: data.roundOff, netAmount: data.netAmount,
    };
  });

  router.get('/api/procurement/invoices/:id', async (ctx) => {
    auth.guard(ctx.user, 'invoice.view');
    const invoice = getInvoice(ctx, ctx.params.id);
    const items = invoiceItems(ctx.db, invoice.id);
    let bill = null;
    if (invoice.abmdas_bill_id) {
      const row = ctx.db
        .prepare('SELECT id, bill_no, status, net_amount, round_off FROM bills WHERE id = ?')
        .get(invoice.abmdas_bill_id);
      if (row) {
        bill = {
          id: row.id, billNo: row.bill_no, status: row.status,
          netAmount: round2(row.net_amount), roundOff: round2(row.round_off),
        };
      }
    }
    return {
      invoice: invoiceOut(invoice),
      items,
      bill,
      actions: {
        canEdit: invoice.status === 'draft' && auth.can(ctx.user, 'invoice.manage'),
        canValidate: invoice.status === 'draft' && auth.can(ctx.user, 'invoice.manage'),
        canCreateBill: invoice.status === 'validated' && !invoice.abmdas_bill_id && auth.can(ctx.user, 'invoice.manage'),
        canDelete: invoice.status === 'draft' && auth.can(ctx.user, 'invoice.manage'),
        canViewBill: !!invoice.abmdas_bill_id,
      },
    };
  });

  router.put('/api/procurement/invoices/:id', async (ctx) => {
    auth.guard(ctx.user, 'invoice.manage');
    const invoice = getInvoice(ctx, ctx.params.id);
    if (invoice.status !== 'draft') throw new HttpError(400, 'Only draft procurement invoices can be edited.');
    const data = invoicePayload(ctx, ctx.body || {}, invoice);
    const now = nowIso();
    transaction(ctx.db, () => {
      ctx.db
        .prepare(
          `UPDATE invoices SET supplier_invoice_no=?, supplier_invoice_date=?, grn_id=?, department_id=?,
             subtotal=?, tax_amount=?, discount_percent=?, discount_amount=?, net_amount=?, round_off=?,
             gst_type=?, gst_rate=?, cgst_amount=?, sgst_amount=?, igst_amount=?,
             due_date=?, remarks=?, updated_at=? WHERE id=?`
        )
        .run(
          data.supplierInvoiceNo, data.supplierInvoiceDate, data.grnId, data.departmentId,
          data.subtotal, data.taxAmount, data.discountPercent, data.discountAmount, data.netAmount, data.roundOff,
          data.gstType, data.gstRate,
          data.cgstAmount, data.sgstAmount, data.igstAmount, data.dueDate, data.remarks,
          now, invoice.id
        );
      replaceInvoiceItems(ctx.db, invoice.id, data.items, now);
    });
    audit(ctx, 'UPDATE', 'procurement_invoice', invoice.id,
      { netAmount: invoice.net_amount, roundOff: round2(invoice.round_off) }, {
        netAmount: data.netAmount, discountPercent: data.discountPercent,
        baseTotalAmount: data.baseTotalAmount, roundOff: data.roundOff,
        ...tax.auditSummary(data.items, data.document),
      });
    return {
      ok: true, baseTotalAmount: data.baseTotalAmount,
      roundOff: data.roundOff, netAmount: data.netAmount,
    };
  });

  router.delete('/api/procurement/invoices/:id', async (ctx) => {
    auth.guard(ctx.user, 'invoice.manage');
    const invoice = getInvoice(ctx, ctx.params.id);
    if (invoice.status !== 'draft') {
      throw new HttpError(400, 'Only draft procurement invoices can be deleted. Cancel validated invoices instead.');
    }
    const now = nowIso();
    ctx.db
      .prepare('UPDATE invoices SET deleted_at=?, deleted_by=?, delete_reason=?, updated_at=? WHERE id=?')
      .run(now, ctx.user.id, optionalText(ctx.body || {}, 'reason', 300), now, invoice.id);
    audit(ctx, 'DELETE', 'procurement_invoice', invoice.id, { invoiceNo: invoice.invoice_no }, { deletedAt: now });
    return { ok: true };
  });

  router.post('/api/procurement/invoices/:id/cancel', async (ctx) => {
    auth.guard(ctx.user, 'invoice.manage');
    const invoice = getInvoice(ctx, ctx.params.id);
    if (!['draft', 'validated'].includes(invoice.status)) {
      throw new HttpError(400, 'Only an unlinked draft or validated invoice can be cancelled.');
    }
    const reason = requireText(ctx.body || {}, 'reason', 'Cancellation reason', 500);
    const now = nowIso();
    ctx.db
      .prepare("UPDATE invoices SET status='cancelled', rejection_reason=?, updated_at=? WHERE id=?")
      .run(reason, now, invoice.id);
    audit(ctx, 'CANCEL', 'procurement_invoice', invoice.id, { status: invoice.status }, {
      status: 'cancelled', reason,
    });
    return { ok: true, status: 'cancelled' };
  });

  router.post('/api/procurement/invoices/:id/validate', async (ctx) => {
    auth.guard(ctx.user, 'invoice.manage');
    const invoice = getInvoice(ctx, ctx.params.id);
    if (invoice.status !== 'draft') throw new HttpError(400, 'Only draft procurement invoices can be validated.');
    const items = invoiceItems(ctx.db, invoice.id);
    if (!items.length) throw new HttpError(400, 'Add at least one invoice line before validating.');
    if (invoice.net_amount <= 0) throw new HttpError(400, 'The invoice value must be greater than zero.');
    const now = nowIso();
    const body = ctx.body || {};
    const withBill = body.createBill !== false && body.createBill !== '0';

    let result = null;
    let assetIds = [];
    transaction(ctx.db, () => {
      ctx.db
        .prepare(
          `UPDATE invoices SET status='validated', validated_by=?, validated_at=?,
             validation_remarks=?, updated_at=? WHERE id=?`
        )
        .run(ctx.user.id, now, optionalText(body, 'validationRemarks', 1000), now, invoice.id);
      const addInvoiced = ctx.db.prepare(
        'UPDATE po_items SET invoiced_quantity = invoiced_quantity + ?, updated_at = ? WHERE id = ? AND po_id = ?'
      );
      for (const item of items) {
        if (item.poItemId) addInvoiced.run(item.quantity, now, item.poItemId, invoice.po_id);
      }
      assetIds = ensureAssetsForInvoice(ctx.db, invoice.id, ctx.user.id);
      if (withBill) {
        const linked = createLinkedBill(ctx, invoice, body);
        ctx.db
          .prepare("UPDATE invoices SET status='billed', abmdas_bill_id=?, updated_at=? WHERE id=?")
          .run(linked.billId, now, invoice.id);
        result = linked;
      }
    });
    notify(
      [invoice.created_by],
      result ? 'Procurement invoice validated' : 'Procurement invoice validated',
      result
        ? `${invoice.invoice_no} validated and linked to bill ${result.billNo}.`
        : `${invoice.invoice_no} validated. Raise the linked ABMDAS bill to continue approval.`,
      `/invoices/${invoice.id}`
    );
    audit(ctx, 'VALIDATE', 'procurement_invoice', invoice.id, {
      status: 'draft', roundOff: round2(invoice.round_off),
    }, {
      status: result ? 'billed' : 'validated',
      abmdasBillId: result?.billId || null,
      billRoundOff: result?.roundOff ?? null,
      assetsCreated: assetIds.length,
    });
    return {
      ok: true,
      status: result ? 'billed' : 'validated',
      billId: result?.billId || null,
      billNo: result?.billNo || null,
      roundOff: result?.roundOff ?? round2(invoice.round_off),
      assetsCreated: assetIds.length,
    };
  });

  router.post('/api/procurement/invoices/:id/create-bill', async (ctx) => {
    auth.guard(ctx.user, 'invoice.manage');
    const invoice = getInvoice(ctx, ctx.params.id);
    if (!['validated', 'billed'].includes(invoice.status)) {
      throw new HttpError(400, 'Validate the procurement invoice before creating the linked bill.');
    }
    if (invoice.abmdas_bill_id) {
      const existing = ctx.db.prepare('SELECT id, bill_no FROM bills WHERE id = ?').get(invoice.abmdas_bill_id);
      if (existing) return { ok: true, billId: existing.id, billNo: existing.bill_no, existing: true };
    }
    const now = nowIso();
    let linked;
    transaction(ctx.db, () => {
      linked = createLinkedBill(ctx, invoice, ctx.body || {});
      ctx.db
        .prepare("UPDATE invoices SET status='billed', abmdas_bill_id=?, updated_at=? WHERE id=?")
        .run(linked.billId, now, invoice.id);
    });
    audit(ctx, 'CREATE_BILL', 'procurement_invoice', invoice.id, null, {
      billId: linked.billId, billNo: linked.billNo,
      roundOff: linked.roundOff, netAmount: round2(invoice.net_amount),
    });
    return { ok: true, billId: linked.billId, billNo: linked.billNo, roundOff: linked.roundOff };
  });
};
