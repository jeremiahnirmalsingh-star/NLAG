'use strict';

const auth = require('../auth');
const { HttpError, fileUrlFor } = require('../http');
const { audit, nowIso, nextAdvanceNo, round2, badRequest, notify } = require('../util');
const { createAdvance, closeAdvance, availableAdvances, activateAdvance } = require('../services/advance');
const {
  buildAdvanceStages,
  activeStageFor,
  canAct,
  notifyAdvanceStage,
  ensureFallbackChain,
} = require('../workflow');

function advanceOut(a) {
  return {
    id: a.id,
    advanceNo: a.advance_no,
    vendorId: a.vendor_id,
    vendorName: a.vendor_name,
    vendorCode: a.vendor_code,
    advanceDate: a.advance_date,
    amount: a.amount,
    adjustedAmount: a.adjusted_amount,
    balance: round2(a.amount - a.adjusted_amount),
    purpose: a.purpose,
    departmentId: a.department_id,
    departmentName: a.department_name,
    unitId: a.unit_id,
    unitName: a.unit_name,
    remarks: a.remarks,
    status: a.status,
    currentStage: a.current_stage,
    currentStageName: a.current_stage_name,
    submittedAt: a.submitted_at,
    approvedAt: a.approved_at,
    createdAt: a.created_at,
  };
}

module.exports = function registerAdvanceRoutes(router) {
  router.get('/api/advances/available', async (ctx) => {
    auth.guard(ctx.user, 'advance.view');
    const vendorId = Number(ctx.query.vendorId);
    if (!vendorId) return { advances: [] };
    const billId = ctx.query.billId ? Number(ctx.query.billId) : null;
    return { advances: availableAdvances(ctx.db, vendorId, billId) };
  });

  router.get('/api/advances', async (ctx) => {
    auth.guard(ctx.user, 'advance.view');
    const q = ctx.query;
    let where = ' WHERE 1=1';
    const params = [];
    if (q.search) {
      where += ' AND (a.advance_no LIKE ? OR v.name LIKE ? OR v.code LIKE ? OR a.purpose LIKE ?)';
      const like = `%${q.search}%`;
      params.push(like, like, like, like);
    }
    if (q.status) {
      where += ' AND a.status = ?';
      params.push(q.status);
    }
    if (q.vendorId) {
      where += ' AND a.vendor_id = ?';
      params.push(Number(q.vendorId));
    }
    if (q.pendingForMe) {
      where += ` AND a.status = 'pending'
        AND EXISTS (
          SELECT 1 FROM advance_stages s
           WHERE s.advance_id = a.id AND s.status = 'pending'
             AND (s.role_id = ? OR ? = 'super_admin')
             AND s.sequence = (
               SELECT MIN(s2.sequence) FROM advance_stages s2
                WHERE s2.advance_id = a.id AND s2.status = 'pending'
             )
        )`;
      params.push(ctx.user.role_id, ctx.user.role_code);
    }
    if (!auth.seesAllUnits(ctx.user)) {
      where += ' AND a.unit_id IN (' + (ctx.unitIds.length ? ctx.unitIds.map(() => '?').join(',') : '0') + ')';
      params.push(...(ctx.unitIds.length ? ctx.unitIds : [0]));
    }
    if (q.from) {
      where += ' AND a.advance_date >= ?';
      params.push(q.from);
    }
    if (q.to) {
      where += ' AND a.advance_date <= ?';
      params.push(q.to);
    }
    const base = `FROM advances a JOIN vendors v ON v.id = a.vendor_id
      LEFT JOIN departments d ON d.id = a.department_id LEFT JOIN units un ON un.id = a.unit_id ${where}`;
    const rows = ctx.db
      .prepare(
        `SELECT a.*, v.name AS vendor_name, v.code AS vendor_code, d.name AS department_name, un.name AS unit_name,
                (SELECT name FROM advance_stages WHERE advance_id = a.id AND status = 'pending' ORDER BY sequence LIMIT 1) AS current_stage_name
         ${base} ORDER BY a.id DESC LIMIT 500`
      )
      .all(...params);
    const summary = ctx.db
      .prepare(
        `SELECT COALESCE(SUM(a.amount),0) AS total,
                COALESCE(SUM(a.adjusted_amount),0) AS adjusted,
                COALESCE(SUM(a.amount - a.adjusted_amount),0) AS outstanding,
                COUNT(*) AS count
         ${base}`
      )
      .get(...params);
    return { advances: rows.map(advanceOut), summary };
  });

  router.get('/api/advances/:id', async (ctx) => {
    auth.guard(ctx.user, 'advance.view');
    const id = Number(ctx.params.id);
    const a = ctx.db
      .prepare(
        `SELECT a.*, v.name AS vendor_name, v.code AS vendor_code, d.name AS department_name, un.name AS unit_name,
                (SELECT name FROM advance_stages WHERE advance_id = a.id AND status = 'pending' ORDER BY sequence LIMIT 1) AS current_stage_name
           FROM advances a JOIN vendors v ON v.id = a.vendor_id
           LEFT JOIN departments d ON d.id = a.department_id LEFT JOIN units un ON un.id = a.unit_id WHERE a.id = ?`
      )
      .get(id);
    if (!a) throw new HttpError(404, 'Advance not found.');
    if (!auth.seesAllUnits(ctx.user) && !ctx.unitIds.includes(Number(a.unit_id))) {
      throw new HttpError(404, 'Advance not found.');
    }
    const stages = ctx.db
      .prepare(
        `SELECT s.*, r.code AS role_code, r.name AS role_name, u.name AS acted_by_name
           FROM advance_stages s
           JOIN roles r ON r.id = s.role_id
           LEFT JOIN users u ON u.id = s.acted_by
          WHERE s.advance_id = ? ORDER BY s.sequence ASC`
      )
      .all(id);
    const ledger = ctx.db
      .prepare(
        `SELECT l.*, u.name AS user_name FROM advance_ledger l LEFT JOIN users u ON u.id = l.created_by
          WHERE l.advance_id = ? ORDER BY l.id ASC`
      )
      .all(id);
    const bills = ctx.db
      .prepare(
        `SELECT ba.amount, b.id, b.bill_no, b.invoice_number, b.status, b.net_amount, b.entry_date
           FROM bill_advances ba JOIN bills b ON b.id = ba.bill_id
          WHERE ba.advance_id = ? ORDER BY ba.id ASC`
      )
      .all(id);
    return {
      advance: advanceOut(a),
      stages: stages.map((s) => ({
        id: s.id,
        sequence: s.sequence,
        name: s.name,
        roleCode: s.role_code,
        roleName: s.role_name,
        status: s.status,
        actedByName: s.acted_by_name,
        actedAt: s.acted_at,
        comments: s.comments,
        signatureImage: s.signature_image,
        canAct: canAct(ctx.user, s),
      })),
      ledger: ledger.map((l) => ({
        id: l.id,
        date: l.txn_date,
        type: l.txn_type,
        debit: l.debit,
        credit: l.credit,
        balance: l.balance,
        notes: l.notes,
        user: l.user_name,
      })),
      bills,
    };
  });

  router.post('/api/advances', async (ctx) => {
    auth.guard(ctx.user, 'advance.create');
    const b = ctx.body || {};
    if (!b.vendorId) throw badRequest('Vendor is required.');
    if (!b.advanceDate) throw badRequest('Advance date is required.');
    const amount = round2(b.amount);
    if (!(amount > 0)) throw badRequest('Advance amount must be greater than zero.');
    const vendor = ctx.db.prepare('SELECT * FROM vendors WHERE id = ?').get(Number(b.vendorId));
    if (!vendor) throw badRequest('Vendor not found.');
    const advanceNo = nextAdvanceNo();
    const id = createAdvance(
      ctx.db,
      {
        advanceNo,
        vendorId: vendor.id,
        advanceDate: b.advanceDate,
        amount,
        purpose: b.purpose,
        departmentId: b.departmentId ? Number(b.departmentId) : null,
        unitId: b.unitId ? Number(b.unitId) : (ctx.unitIds[0] || null),
        remarks: b.remarks,
      },
      ctx.user.id
    );
    ensureFallbackChain(ctx.db);
    const { stages } = buildAdvanceStages(ctx.db, id, amount, ctx.user.id);
    if (!stages.length) throw new HttpError(400, 'No approval stages are configured for this amount.');
    const now = nowIso();
    ctx.db
      .prepare("UPDATE advances SET status='pending', current_stage=1, submitted_at=?, updated_at=? WHERE id=?")
      .run(now, now, id);
    const stage = activeStageFor(ctx.db, 'advance_stages', 'advance_id', id);
    notifyAdvanceStage(ctx.db, { id, advance_no: advanceNo, vendor_name: vendor.name, amount }, stage);
    notify(
      [ctx.user.id],
      'Advance submitted for approval',
      `${advanceNo} has been submitted. Approval chain: ${stages.map((s) => s.name).join(' \u2192 ')}.`,
      `#/advances/${id}`
    );
    audit(ctx, 'CREATE', 'advance', id, null, { advanceNo, vendor: vendor.name, amount });
    return { id, advanceNo, stages: stages.map((s) => s.name) };
  });

  /* ---------------------------------------------------------------- */
  /* Resubmit a returned advance                                       */
  /* ---------------------------------------------------------------- */
  router.post('/api/advances/:id/submit', async (ctx) => {
    auth.guard(ctx.user, 'advance.create');
    const id = Number(ctx.params.id);
    const adv = ctx.db
      .prepare('SELECT a.*, v.name AS vendor_name FROM advances a JOIN vendors v ON v.id = a.vendor_id WHERE a.id = ?')
      .get(id);
    if (!adv) throw new HttpError(404, 'Advance not found.');
    if (adv.status !== 'returned') throw new HttpError(400, 'Only returned advances can be resubmitted.');
    if (adv.created_by !== ctx.user.id && !auth.can(ctx.user, 'advance.edit')) {
      throw new HttpError(403, 'Only the creator can resubmit this advance.');
    }
    ensureFallbackChain(ctx.db);
    const { stages } = buildAdvanceStages(ctx.db, id, adv.amount, adv.created_by);
    if (!stages.length) throw new HttpError(400, 'No approval stages are configured for this amount.');
    const now = nowIso();
    ctx.db
      .prepare("UPDATE advances SET status='pending', current_stage=1, submitted_at=?, updated_at=? WHERE id=?")
      .run(now, now, id);
    const stage = activeStageFor(ctx.db, 'advance_stages', 'advance_id', id);
    notifyAdvanceStage(ctx.db, adv, stage);
    audit(ctx, 'SUBMIT', 'advance', id, { status: adv.status }, { status: 'pending' });
    return { ok: true, message: 'Advance resubmitted for approval.' };
  });

  /* ---------------------------------------------------------------- */
  /* Approval actions                                                  */
  /* ---------------------------------------------------------------- */
  router.post('/api/advances/:id/action', async (ctx) => {
    const { action, comments = '', signatureImage } = ctx.body || {};
    const permission = { approve: 'bill.approve', reject: 'bill.reject', return: 'bill.return' }[action];
    if (!permission) throw new HttpError(400, 'Invalid approval action.');
    auth.guard(ctx.user, permission);

    const id = Number(ctx.params.id);
    const adv = ctx.db
      .prepare('SELECT a.*, v.name AS vendor_name FROM advances a JOIN vendors v ON v.id = a.vendor_id WHERE a.id = ?')
      .get(id);
    if (!adv) throw new HttpError(404, 'Advance not found.');
    if (!auth.seesAllUnits(ctx.user) && !ctx.unitIds.includes(Number(adv.unit_id))) {
      throw new HttpError(404, 'Advance not found.');
    }
    if (adv.status !== 'pending') throw new HttpError(400, 'This advance is not pending approval.');

    const stage = activeStageFor(ctx.db, 'advance_stages', 'advance_id', id);
    if (!stage) throw new HttpError(400, 'No active approval stage found.');
    if (!canAct(ctx.user, stage)) throw new HttpError(403, 'You are not the approver for the current stage.');

    const now = nowIso();
    const signature = signatureImage || ctx.user.signature_image || null;
    const stageStatus = { approve: 'approved', reject: 'rejected', return: 'returned' }[action];
    ctx.db
      .prepare('UPDATE advance_stages SET status=?, acted_by=?, acted_at=?, comments=?, signature_image=? WHERE id=?')
      .run(stageStatus, ctx.user.id, now, comments, signature, stage.id);

    let newStatus = adv.status;
    let message = '';
    if (action === 'approve') {
      const next = ctx.db
        .prepare(
          `SELECT s.*, r.code AS role_code FROM advance_stages s JOIN roles r ON r.id = s.role_id
            WHERE s.advance_id = ? AND s.status = 'pending' AND s.sequence > ?
            ORDER BY s.sequence ASC LIMIT 1`
        )
        .get(id, stage.sequence);
      if (next) {
        ctx.db.prepare('UPDATE advances SET current_stage=?, updated_at=? WHERE id=?').run(next.sequence, now, id);
        notifyAdvanceStage(ctx.db, adv, next);
        message = `Approved and forwarded to ${next.name}.`;
      } else {
        activateAdvance(ctx.db, id, ctx.user.id);
        ctx.db.prepare("UPDATE advances SET submitted_at = COALESCE(submitted_at, ?), updated_at = ? WHERE id = ?").run(now, now, id);
        newStatus = 'Open';
        notify(
          [adv.created_by],
          'Advance approved',
          `${adv.advance_no} to ${adv.vendor_name} for ${Number(adv.amount).toFixed(2)} has received final approval.`,
          `#/advances/${id}`
        );
        message = 'Final approval granted. The advance is now open for adjustment against bills.';
      }
    } else if (action === 'reject') {
      newStatus = 'rejected';
      ctx.db.prepare("UPDATE advances SET status='rejected', updated_at=? WHERE id=?").run(now, id);
      notify([adv.created_by], 'Advance rejected', `${adv.advance_no} was rejected by ${ctx.user.name}. ${comments || ''}`, `#/advances/${id}`);
      message = 'Advance rejected.';
    } else {
      newStatus = 'returned';
      ctx.db.prepare("UPDATE advances SET status='returned', updated_at=? WHERE id=?").run(now, id);
      notify([adv.created_by], 'Advance returned for correction', `${adv.advance_no} was returned by ${ctx.user.name}. ${comments || ''}`, `#/advances/${id}`);
      message = 'Advance returned to the creator for correction.';
    }

    audit(ctx, action.toUpperCase(), 'advance', id, { status: adv.status, stage: stage.name }, { status: newStatus, comments });
    return { ok: true, status: newStatus, message, advanceNo: adv.advance_no };
  });

  router.put('/api/advances/:id', async (ctx) => {
    auth.guard(ctx.user, 'advance.edit');
    const id = Number(ctx.params.id);
    const adv = ctx.db.prepare('SELECT * FROM advances WHERE id = ?').get(id);
    if (!adv) throw new HttpError(404, 'Advance not found.');
    if (!['pending', 'returned'].includes(adv.status)) {
      throw new HttpError(400, 'Only advances awaiting approval can be edited.');
    }
    const b = ctx.body || {};
    const amount = round2(b.amount ?? adv.amount);
    if (!(amount > 0)) throw badRequest('Advance amount must be greater than zero.');
    if (amount < adv.adjusted_amount) {
      throw new HttpError(400, 'Amount cannot be less than the amount already adjusted against bills.');
    }
    if (amount !== adv.amount && adv.adjusted_amount > 0) {
      throw new HttpError(400, 'The advance amount cannot be changed after it has been adjusted against a bill.');
    }
    ctx.db
      .prepare(
        `UPDATE advances SET vendor_id=?, advance_date=?, amount=?, purpose=?, department_id=?,
           remarks=?, updated_at=? WHERE id=?`
      )
      .run(
        b.vendorId ? Number(b.vendorId) : adv.vendor_id,
        b.advanceDate || adv.advance_date,
        amount,
        b.purpose ?? adv.purpose,
        b.departmentId ? Number(b.departmentId) : adv.department_id,
        b.remarks ?? adv.remarks,
        nowIso(),
        id
      );
    if (amount !== adv.amount) {
      // The paid amount is posted to the ledger only after final approval.
      ctx.db.prepare('DELETE FROM advance_ledger WHERE advance_id = ?').run(id);
    }
    audit(ctx, 'UPDATE', 'advance', id, { amount: adv.amount }, { amount });
    return { ok: true };
  });

  router.post('/api/advances/:id/close', async (ctx) => {
    auth.guard(ctx.user, 'advance.edit');
    const id = Number(ctx.params.id);
    const adv = ctx.db.prepare('SELECT * FROM advances WHERE id = ?').get(id);
    if (!adv) throw new HttpError(404, 'Advance not found.');
    if (adv.status === 'Closed') throw new HttpError(400, 'Advance is already closed.');
    closeAdvance(ctx.db, id, ctx.user.id);
    audit(ctx, 'CLOSE', 'advance', id, { status: adv.status }, { status: 'Closed' });
    return { ok: true };
  });

  router.delete('/api/advances/:id', async (ctx) => {
    auth.guard(ctx.user, 'advance.edit');
    const id = Number(ctx.params.id);
    const adv = ctx.db.prepare('SELECT * FROM advances WHERE id = ?').get(id);
    if (!adv) throw new HttpError(404, 'Advance not found.');
    if (!['pending', 'returned', 'rejected'].includes(adv.status)) {
      throw new HttpError(400, 'Only advances that are not yet approved can be deleted.');
    }
    ctx.db.prepare('DELETE FROM advances WHERE id = ?').run(id);
    audit(ctx, 'DELETE', 'advance', id, { advanceNo: adv.advance_no, amount: adv.amount });
    return { ok: true };
  });

  void fileUrlFor;
};
