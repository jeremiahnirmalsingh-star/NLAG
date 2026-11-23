'use strict';

const auth = require('../auth');
const { HttpError } = require('../http');
const { audit, nowIso, round2 } = require('../util');

function withheld(amount, released) {
  return round2(Math.max((Number(amount) || 0) - (Number(released) || 0), 0));
}

module.exports = function registerHandoverRoutes(router) {
  router.get('/api/handover/statement', async (ctx) => {
    auth.guard(ctx.user, 'handover.view');
    const q = ctx.query;
    let where = ' WHERE 1=1';
    const params = [];
    if (q.search) {
      where += ' AND (h.handover_no LIKE ? OR b.bill_no LIKE ? OR b.invoice_number LIKE ? OR v.name LIKE ?)';
      const like = `%${q.search}%`;
      params.push(like, like, like, like);
    }
    if (q.status) {
      where += ' AND h.status = ?';
      params.push(q.status);
    }
    if (q.from) {
      where += ' AND h.forwarded_at >= ?';
      params.push(q.from);
    }
    if (q.to) {
      where += ' AND h.forwarded_at <= ?';
      params.push(q.to + 'T23:59:59.999Z');
    }
    const base = `FROM handovers h
      JOIN bills b ON b.id = h.bill_id
      JOIN vendors v ON v.id = b.vendor_id
       LEFT JOIN units un ON un.id = b.unit_id
      LEFT JOIN users f ON f.id = h.forwarded_by
      LEFT JOIN users r ON r.id = h.received_by
      ${where}`;
    const rows = ctx.db
      .prepare(
        `SELECT h.id, h.handover_no, h.status, h.forwarded_at, h.received_at, h.remarks,
                b.id AS bill_id, b.bill_no, b.invoice_number, b.invoice_date, b.invoice_amount, b.tax_amount,
                b.transport_amount, b.transport_tax_amount, b.net_amount, b.advance_adjusted,
                b.gst_type, b.gst_rate, b.cgst_amount, b.sgst_amount, b.igst_amount,
                b.retention_percentage, b.retention_amount, b.retention_released_amount,
                b.hold_amount, b.hold_released_amount, b.credit_note_number, b.credit_note_amount,
                b.approved_at, b.unit_id, un.name AS unit_name, v.name AS vendor_name, v.code AS vendor_code,
                f.name AS forwarded_by_name, r.name AS received_by_name
         ${base} ORDER BY h.forwarded_at ASC, h.id ASC LIMIT 2000`
      )
      .all(...params);

    const totals = {
      count: rows.length,
      pending: 0,
      acknowledged: 0,
      basicTotal: 0,
      cgstTotal: 0,
      sgstTotal: 0,
      igstTotal: 0,
      taxTotal: 0,
      transportTotal: 0,
      transportTaxTotal: 0,
      netTotal: 0,
      advanceTotal: 0,
      retentionTotal: 0,
      holdTotal: 0,
      creditTotal: 0,
      payableTotal: 0,
    };

    const linesByBill = new Map();
  const billIds = rows.map((h) => h.bill_id);
  if (billIds.length) {
    const lineRows = ctx.db
      .prepare(`SELECT * FROM bill_tax_lines WHERE bill_id IN (${billIds.map(() => '?').join(',')}) ORDER BY bill_id, sequence, id`)
      .all(...billIds);
    for (const l of lineRows) {
      if (!linesByBill.has(l.bill_id)) linesByBill.set(l.bill_id, []);
      linesByBill.get(l.bill_id).push({
        id: l.id,
        sequence: l.sequence,
        label: l.label || '',
        taxableAmount: round2(Number(l.taxable_amount)),
        gstRate: round2(Number(l.gst_rate)),
        cgstAmount: round2(Number(l.cgst_amount)),
        sgstAmount: round2(Number(l.sgst_amount)),
        igstAmount: round2(Number(l.igst_amount)),
        taxAmount: round2(Number(l.tax_amount)),
      });
    }
  }

  const statementRows = rows.map((h, index) => {
      const retentionWithheld = withheld(h.retention_amount, h.retention_released_amount);
      const holdWithheld = withheld(h.hold_amount, h.hold_released_amount);
      const creditNoteAmount = round2(h.credit_note_amount);
      const payableAmount = round2(
        (Number(h.net_amount) || 0) - (Number(h.advance_adjusted) || 0)
          - retentionWithheld - holdWithheld - creditNoteAmount
      );
      if (h.status === 'acknowledged') totals.acknowledged += 1;
      else totals.pending += 1;
      totals.basicTotal += Number(h.invoice_amount) || 0;
      totals.cgstTotal += Number(h.cgst_amount) || 0;
      totals.sgstTotal += Number(h.sgst_amount) || 0;
      totals.igstTotal += Number(h.igst_amount) || 0;
      totals.taxTotal += Number(h.tax_amount) || 0;
      totals.transportTotal += Number(h.transport_amount) || 0;
      totals.transportTaxTotal += Number(h.transport_tax_amount) || 0;
      totals.netTotal += Number(h.net_amount) || 0;
      totals.advanceTotal += Number(h.advance_adjusted) || 0;
      totals.retentionTotal += retentionWithheld;
      totals.holdTotal += holdWithheld;
      totals.creditTotal += creditNoteAmount;
      totals.payableTotal += payableAmount;
      return {
        slNo: index + 1,
        unitId: h.unit_id,
        unitName: h.unit_name || 'Main Unit',
        id: h.id,
        handoverNo: h.handover_no,
        billId: h.bill_id,
        billNo: h.bill_no,
        vendorName: h.vendor_name,
        vendorCode: h.vendor_code,
        invoiceNumber: h.invoice_number,
        invoiceDate: h.invoice_date,
        invoiceAmount: round2(h.invoice_amount),
        taxAmount: round2(h.tax_amount),
        cgstAmount: round2(h.cgst_amount),
        sgstAmount: round2(h.sgst_amount),
        igstAmount: round2(h.igst_amount),
        gstType: h.gst_type,
        gstRate: h.gst_rate,
        taxLines: linesByBill.get(h.bill_id) || [],
        transportAmount: round2(h.transport_amount),
        transportTaxAmount: round2(h.transport_tax_amount),
        netAmount: round2(h.net_amount),
        advanceAdjusted: round2(h.advance_adjusted),
        retentionPercentage: h.retention_percentage,
        retentionWithheld,
        holdWithheld,
        creditNoteNumber: h.credit_note_number,
        creditNoteAmount,
        deductions: round2(
          (Number(h.advance_adjusted) || 0) + retentionWithheld + holdWithheld + creditNoteAmount
        ),
        payableAmount,
        approvalDate: h.approved_at,
        forwardedAt: h.forwarded_at,
        forwardedBy: h.forwarded_by_name,
        receivedAt: h.received_at,
        receivedBy: h.received_by_name,
        remarks: h.remarks,
        status: h.status,
      };
    });

    for (const key of Object.keys(totals)) {
      if (key !== 'count' && key !== 'pending' && key !== 'acknowledged') {
        totals[key] = round2(totals[key]);
      }
    }

    const settings = Object.fromEntries(
      ctx.db
        .prepare(
          "SELECT key, value FROM settings WHERE key IN ('org.name','org.department','report.footer','currency')"
        )
        .all()
        .map((row) => [row.key, row.value])
    );

    return {
      org: {
        name: settings['org.name'] || '',
        department: settings['org.department'] || '',
        footer: settings['report.footer'] || '',
        currency: settings.currency || 'INR',
      },
      generatedAt: nowIso(),
      filters: {
        search: q.search || '',
        status: q.status || '',
        from: q.from || '',
        to: q.to || '',
      },
      rows: statementRows,
      summary: totals,
    };
  });

  router.post('/api/handover/bulk-create', async (ctx) => {
    auth.guard(ctx.user, 'handover.view');
    const body = ctx.body || {};
    const billIds = Array.isArray(body.billIds) ? body.billIds.map(Number).filter(Boolean) : [];
    if (!billIds.length) throw new HttpError(400, 'No bills selected.');
    const now = nowIso();
    const { nextHandoverNo } = require('../workflow');
    let count = 0;
    for (const billId of billIds) {
      const bill = ctx.db.prepare('SELECT * FROM bills WHERE id = ? AND status = ?').get(billId, 'approved');
      if (!bill) continue;
      const existing = ctx.db.prepare('SELECT id FROM handovers WHERE bill_id = ?').get(billId);
      if (existing) continue;
      const handoverNo = nextHandoverNo();
      ctx.db
        .prepare("INSERT INTO handovers(handover_no, bill_id, forwarded_at, forwarded_by, status, created_at) VALUES (?,?,?,?, 'forwarded', ?)")
        .run(handoverNo, billId, now, ctx.user.id, now);
      count += 1;
    }
    return { ok: true, created: count };
  });

  router.get('/api/handover', async (ctx) => {
    auth.guard(ctx.user, 'handover.view');
    const q = ctx.query;
    let where = ' WHERE 1=1';
    const params = [];
    if (q.search) {
      where += ' AND (h.handover_no LIKE ? OR b.bill_no LIKE ? OR b.invoice_number LIKE ? OR v.name LIKE ?)';
      const like = `%${q.search}%`;
      params.push(like, like, like, like);
    }
    if (q.status) {
      where += ' AND h.status = ?';
      params.push(q.status);
    }
    if (q.from) {
      where += ' AND h.forwarded_at >= ?';
      params.push(q.from);
    }
    if (q.to) {
      where += ' AND h.forwarded_at <= ?';
      params.push(q.to + 'T23:59:59.999Z');
    }
    const base = `FROM handovers h
      JOIN bills b ON b.id = h.bill_id
      JOIN vendors v ON v.id = b.vendor_id
      LEFT JOIN users f ON f.id = h.forwarded_by
      LEFT JOIN users r ON r.id = h.received_by
      ${where}`;
    const total = ctx.db.prepare(`SELECT COUNT(*) AS c ${base}`).get(...params).c;
    const rows = ctx.db
      .prepare(
        `SELECT h.*, b.bill_no, b.invoice_number, b.invoice_date, b.invoice_amount, b.tax_amount,
                b.transport_amount, b.transport_tax_amount, b.net_amount, b.advance_adjusted,
                b.gst_type, b.gst_rate, b.cgst_amount, b.sgst_amount, b.igst_amount,
                b.retention_percentage, b.retention_amount, b.retention_released_amount,
                b.hold_amount, b.hold_released_amount, b.credit_note_number, b.credit_note_amount,
                b.approved_at, v.name AS vendor_name, v.code AS vendor_code,
                f.name AS forwarded_by_name, r.name AS received_by_name
         ${base} ORDER BY h.id DESC LIMIT 500`
      )
      .all(...params);
    const regLinesByBill = new Map();
    const regBillIds = rows.map((h) => h.bill_id);
    if (regBillIds.length) {
      const rl = ctx.db
        .prepare(`SELECT * FROM bill_tax_lines WHERE bill_id IN (${regBillIds.map(() => '?').join(',')}) ORDER BY bill_id, sequence, id`)
        .all(...regBillIds);
      for (const l of rl) {
        if (!regLinesByBill.has(l.bill_id)) regLinesByBill.set(l.bill_id, []);
        regLinesByBill.get(l.bill_id).push({
          id: l.id,
          sequence: l.sequence,
          label: l.label || '',
          taxableAmount: round2(Number(l.taxable_amount)),
          gstRate: round2(Number(l.gst_rate)),
          cgstAmount: round2(Number(l.cgst_amount)),
          sgstAmount: round2(Number(l.sgst_amount)),
          igstAmount: round2(Number(l.igst_amount)),
          taxAmount: round2(Number(l.tax_amount)),
        });
      }
    }
    return {
      total,
      handovers: rows.map((h) => {
        const retentionWithheld = withheld(h.retention_amount, h.retention_released_amount);
        const holdWithheld = withheld(h.hold_amount, h.hold_released_amount);
        const creditNoteAmount = round2(h.credit_note_amount);
        const payableAmount = round2(
          (Number(h.net_amount) || 0) - (Number(h.advance_adjusted) || 0)
            - retentionWithheld - holdWithheld - creditNoteAmount
        );
        return {
          id: h.id,
          handoverNo: h.handover_no,
          billId: h.bill_id,
          billNo: h.bill_no,
          vendorName: h.vendor_name,
          vendorCode: h.vendor_code,
          invoiceNumber: h.invoice_number,
          invoiceDate: h.invoice_date,
          invoiceAmount: h.invoice_amount,
          taxAmount: h.tax_amount,
          transportAmount: h.transport_amount,
          transportTaxAmount: h.transport_tax_amount,
          netAmount: h.net_amount,
          gstType: h.gst_type,
          gstRate: h.gst_rate,
          taxLines: regLinesByBill.get(h.bill_id) || [],
          cgstAmount: h.cgst_amount,
          sgstAmount: h.sgst_amount,
          igstAmount: h.igst_amount,
          advanceAdjusted: h.advance_adjusted,
          retentionPercentage: h.retention_percentage,
          retentionAmount: h.retention_amount,
          retentionReleasedAmount: h.retention_released_amount,
          retentionWithheld,
          holdAmount: h.hold_amount,
          holdReleasedAmount: h.hold_released_amount,
          holdWithheld,
          creditNoteNumber: h.credit_note_number,
          creditNoteAmount,
          payableAmount,
          approvalDate: h.approved_at,
          forwardedAt: h.forwarded_at,
          forwardedBy: h.forwarded_by_name,
          receivedBy: h.received_by_name,
          receivedAt: h.received_at,
          remarks: h.remarks,
          status: h.status,
        };
      }),
      summary: ctx.db
        .prepare(
          `SELECT
             COUNT(*) AS total,
             SUM(CASE WHEN h.status='forwarded' THEN 1 ELSE 0 END) AS pending,
             SUM(CASE WHEN h.status='acknowledged' THEN 1 ELSE 0 END) AS acknowledged
           ${base}`
        )
        .get(...params),
    };
  });

  router.post('/api/handover/bulk-acknowledge', async (ctx) => {
    auth.guard(ctx.user, 'handover.acknowledge');
    const body = ctx.body || {};
    const ids = Array.isArray(body.ids) ? body.ids.map(Number).filter(Boolean) : [];
    if (!ids.length) throw new HttpError(400, 'No handovers selected.');
    const now = nowIso();
    const { notify } = require('../util');
    let count = 0;
    for (const id of ids) {
      const h = ctx.db.prepare('SELECT * FROM handovers WHERE id = ?').get(id);
      if (!h || h.status === 'acknowledged') continue;
      ctx.db
        .prepare("UPDATE handovers SET status='acknowledged', received_by=?, received_at=?, remarks=? WHERE id=?")
        .run(ctx.user.id, now, body.remarks || '', id);
      const bill = ctx.db.prepare('SELECT * FROM bills WHERE id = ?').get(h.bill_id);
      audit(ctx, 'ACKNOWLEDGE', 'handover', id, { status: h.status }, { status: 'acknowledged' });
      if (bill) {
        notify([bill.created_by], 'Accounts acknowledged handover', h.handover_no + ' for ' + bill.bill_no + ' has been acknowledged by Accounts.', '#/handover');
      }
      count += 1;
    }
    return { ok: true, acknowledged: count };
  });

  router.post('/api/handover/:id/acknowledge', async (ctx) => {
    auth.guard(ctx.user, 'handover.acknowledge');
    const id = Number(ctx.params.id);
    const h = ctx.db.prepare('SELECT * FROM handovers WHERE id = ?').get(id);
    if (!h) throw new HttpError(404, 'Handover not found.');
    if (h.status === 'acknowledged') throw new HttpError(400, 'This handover has already been acknowledged.');
    const { remarks = '' } = ctx.body || {};
    const now = nowIso();
    ctx.db
      .prepare("UPDATE handovers SET status='acknowledged', received_by=?, received_at=?, remarks=? WHERE id=?")
      .run(ctx.user.id, now, remarks, id);
    const bill = ctx.db.prepare('SELECT * FROM bills WHERE id = ?').get(h.bill_id);
    audit(ctx, 'ACKNOWLEDGE', 'handover', id, { status: h.status }, { status: 'acknowledged' });
    const { notify } = require('../util');
    if (bill) {
      notify(
        [bill.created_by],
        'Accounts acknowledged handover',
        `${h.handover_no} for ${bill.bill_no} has been acknowledged by Accounts.`,
        `#/handover`
      );
    }
    return { ok: true };
  });
};
