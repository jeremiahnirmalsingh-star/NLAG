'use strict';

const auth = require('../auth');
const { HttpError, badRequest } = require('../http');
const { audit, nowIso, round2, notify, userIdsByRole } = require('../util');
const { buildStages, ensureFallbackChain, activeStageFor, canAct } = require('../workflow');

function nextImprestNo(db) {
  const year = new Date().getFullYear();
  const key = `imprest:${year}`;
  const row = db.prepare('SELECT value FROM sequences WHERE key = ?').get(key);
  const next = (row ? row.value : 0) + 1;
  db.prepare('INSERT INTO sequences(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, next);
  return `IMP/${year}/${String(next).padStart(4, '0')}`;
}

function imprestOut(i) {
  return {
    id: i.id,
    imprestNo: i.imprest_no,
    userId: i.user_id,
    userName: i.user_name,
    departmentId: i.department_id,
    departmentName: i.department_name,
    unitId: i.unit_id,
    unitName: i.unit_name,
    purpose: i.purpose,
    amountIssued: i.amount_issued,
    dateIssued: i.date_issued,
    status: i.status,
    currentStage: i.current_stage,
    currentStageName: i.current_stage_name,
    settledAmount: i.settled_amount,
    balanceAmount: i.balance_amount,
    dueDate: i.due_date,
    submittedAt: i.submitted_at,
    approvedAt: i.approved_at,
    createdAt: i.created_at,
    createdBy: i.created_by,
    hasOpenImprest: !!i.has_open_imprest,
  };
}

function unitAllowed(ctx, record) {
  return auth.seesAllUnits(ctx.user) || ctx.unitIds.includes(Number(record.unit_id));
}

function assertUnitAccess(ctx, record) {
  if (!unitAllowed(ctx, record)) throw new HttpError(404, 'Imprest not found.');
}

function notifyStage(db, imp, stage) {
  if (!stage) return;
  const ids = stage.user_id ? [stage.user_id] : userIdsByRole(stage.role_code);
  notify(
    ids,
    'Imprest request pending your approval',
    `${imp.imprest_no} for ${Number(imp.amount_issued).toFixed(2)} is awaiting ${stage.name}.`,
    `#/imprests/${imp.id}`
  );
}

module.exports = function registerImprestRoutes(router) {
  // Active employees that can hold an imprest.
  router.get('/api/imprests/employees', async (ctx) => {
    auth.guard(ctx.user, 'advance.view');
    const rows = ctx.db
      .prepare(
        `SELECT u.id, u.name, u.department, u.unit_id, un.name AS unit_name
           FROM users u LEFT JOIN units un ON un.id = u.unit_id
          WHERE u.status = 'Active'
          ORDER BY u.name ASC`
      )
      .all();
    return {
      employees: rows.map((u) => ({
        id: u.id,
        name: u.name,
        department: u.department,
        unitId: u.unit_id,
        unitName: u.unit_name,
      })),
    };
  });

  // Check for open imprests for a user
  router.get('/api/imprests/open-check', async (ctx) => {
    auth.guard(ctx.user, 'advance.view');
    const userId = ctx.query.userId ? Number(ctx.query.userId) : ctx.user.id;
    const open = ctx.db.prepare(
      "SELECT id, imprest_no, balance_amount, status FROM imprests WHERE user_id = ? AND status IN ('Open','Partially Settled','Overdue','issued','approved','pending') AND balance_amount > 0"
    ).all(userId);
    return { hasOpen: open.length > 0, openImprests: open };
  });

  router.get('/api/imprests', async (ctx) => {
    auth.guard(ctx.user, 'advance.view');
    const q = ctx.query || {};
    let where = ' WHERE 1=1';
    const params = [];
    if (q.status) { where += ' AND i.status = ?'; params.push(q.status); }
    if (q.userId) { where += ' AND i.user_id = ?'; params.push(Number(q.userId)); }
    if (q.search) {
      where += ' AND (i.imprest_no LIKE ? OR i.purpose LIKE ? OR u.name LIKE ?)';
      const like = `%${q.search}%`;
      params.push(like, like, like);
    }
    if (q.pendingForMe) {
      where += ` AND i.status = 'pending'
        AND EXISTS (
          SELECT 1 FROM imprest_stages s
           WHERE s.imprest_id = i.id AND s.status = 'pending'
             AND (s.role_id = ? OR ? = 'super_admin' OR s.user_id = ?)
             AND s.sequence = (
               SELECT MIN(s2.sequence) FROM imprest_stages s2
                WHERE s2.imprest_id = i.id AND s2.status = 'pending'
             )
        )`;
      params.push(ctx.user.role_id, ctx.user.role_code, ctx.user.id);
    }
    if (!auth.seesAllUnits(ctx.user)) {
      where += ' AND i.unit_id IN (' + (ctx.unitIds.length ? ctx.unitIds.map(() => '?').join(',') : '0') + ')';
      params.push(...(ctx.unitIds.length ? ctx.unitIds : [0]));
    }
    if (q.from) { where += ' AND i.date_issued >= ?'; params.push(q.from); }
    if (q.to) { where += ' AND i.date_issued <= ?'; params.push(q.to); }

    const base = `FROM imprests i
        JOIN users u ON u.id = i.user_id
        LEFT JOIN departments d ON d.id = i.department_id
        LEFT JOIN units un ON un.id = i.unit_id
        ${where}`;
    const rows = ctx.db.prepare(
      `SELECT i.*, u.name AS user_name, d.name AS department_name, un.name AS unit_name,
              (SELECT name FROM imprest_stages WHERE imprest_id = i.id AND status = 'pending' ORDER BY sequence LIMIT 1) AS current_stage_name,
              (SELECT 1 FROM imprests i2 WHERE i2.user_id = i.user_id AND i2.id <> i.id AND i2.status IN ('Open','Partially Settled','Overdue','issued','approved','pending') AND i2.balance_amount > 0 LIMIT 1) AS has_open_imprest
         ${base} ORDER BY i.id DESC LIMIT 500`
    ).all(...params);
    const summary = ctx.db.prepare(
      `SELECT COALESCE(SUM(i.amount_issued),0) AS issued,
              COALESCE(SUM(i.settled_amount),0) AS settled,
              COALESCE(SUM(i.balance_amount),0) AS outstanding,
              COUNT(*) AS count
         ${base}`
    ).get(...params);
    return { imprests: rows.map(imprestOut), summary };
  });

  router.get('/api/imprests/:id', async (ctx) => {
    auth.guard(ctx.user, 'advance.view');
    const id = Number(ctx.params.id);
    const i = ctx.db.prepare(
      `SELECT i.*, u.name AS user_name, d.name AS department_name, un.name AS unit_name,
              (SELECT name FROM imprest_stages WHERE imprest_id = i.id AND status = 'pending' ORDER BY sequence LIMIT 1) AS current_stage_name
         FROM imprests i JOIN users u ON u.id = i.user_id
         LEFT JOIN departments d ON d.id = i.department_id
         LEFT JOIN units un ON un.id = i.unit_id WHERE i.id = ?`
    ).get(id);
    if (!i) throw new HttpError(404, 'Imprest not found.');
    assertUnitAccess(ctx, i);
    const stages = ctx.db.prepare(
      `SELECT bs.*, r.code AS role_code, r.name AS role_name, u.name AS acted_by_name
         FROM imprest_stages bs JOIN roles r ON r.id = bs.role_id
         LEFT JOIN users u ON u.id = bs.acted_by WHERE bs.imprest_id = ? ORDER BY bs.sequence`
    ).all(id);
    const bills = ctx.db.prepare(
      `SELECT ib.*, b.bill_no, b.invoice_number, b.net_amount, b.status
         FROM imprest_bills ib JOIN bills b ON b.id = ib.bill_id
        WHERE ib.imprest_id = ? ORDER BY ib.id ASC`
    ).all(id);
    return {
      imprest: imprestOut(i),
      stages: stages.map((s) => ({
        id: s.id,
        sequence: s.sequence,
        name: s.name,
        roleCode: s.role_code,
        roleName: s.role_name,
        userId: s.user_id,
        status: s.status,
        actedByName: s.acted_by_name,
        actedAt: s.acted_at,
        comments: s.comments,
        signatureImage: s.signature_image,
        canAct: canAct(ctx.user, s),
      })),
      bills: bills.map((b) => ({
        id: b.bill_id,
        billNo: b.bill_no,
        invoiceNumber: b.invoice_number,
        netAmount: b.net_amount,
        status: b.status,
        amount: b.amount,
        notes: b.notes,
        createdAt: b.created_at,
      })),
    };
  });

  // Create imprest request (draft)
  router.post('/api/imprests', async (ctx) => {
    auth.guard(ctx.user, 'advance.create');
    const body = ctx.body || {};
    if (!body.purpose) throw badRequest('Purpose is required.');
    const amount = round2(body.amountIssued);
    if (amount <= 0) throw badRequest('Amount issued must be greater than zero.');
    if (!body.dateIssued) throw badRequest('Date issued is required.');
    const userId = body.userId ? Number(body.userId) : ctx.user.id;
    const user = ctx.db.prepare("SELECT id FROM users WHERE id = ? AND status = 'Active'").get(userId);
    if (!user) throw badRequest('Selected employee was not found or is inactive.');
    const unitId = body.unitId ? Number(body.unitId) : (ctx.unitIds[0] || null);
    if (unitId && !auth.seesAllUnits(ctx.user) && !ctx.unitIds.includes(unitId)) {
      throw new HttpError(403, 'You do not have access to the selected unit.');
    }
    const now = nowIso();
    const no = nextImprestNo(ctx.db);
    const res = ctx.db.prepare(
      `INSERT INTO imprests(imprest_no, user_id, department_id, unit_id, purpose, amount_issued, date_issued, status, current_stage, settled_amount, balance_amount, due_date, created_by, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,'draft',0,0,?,?,?,?,?)`
    ).run(
      no,
      userId,
      body.departmentId ? Number(body.departmentId) : null,
      unitId,
      String(body.purpose).trim(),
      amount,
      String(body.dateIssued).slice(0, 10),
      amount,
      body.dueDate ? String(body.dueDate).slice(0, 10) : null,
      ctx.user.id,
      now,
      now
    );
    const id = Number(res.lastInsertRowid);
    audit(ctx, 'CREATE', 'imprest', id, null, { imprestNo: no, amount });
    return { id, imprestNo: no };
  });

  // Submit imprest request
  router.post('/api/imprests/:id/submit', async (ctx) => {
    auth.guard(ctx.user, 'advance.create');
    const id = Number(ctx.params.id);
    const imp = ctx.db.prepare('SELECT * FROM imprests WHERE id = ?').get(id);
    if (!imp) throw new HttpError(404, 'Imprest not found.');
    assertUnitAccess(ctx, imp);
    if (imp.status !== 'draft' && imp.status !== 'returned') throw new HttpError(400, 'Only draft or returned imprests can be submitted.');
    if (imp.user_id !== ctx.user.id && !auth.can(ctx.user, 'advance.edit')) {
      throw new HttpError(403, 'You can only submit your own imprest requests.');
    }
    ensureFallbackChain(ctx.db);
    const { stages } = buildStages(ctx.db, {
      table: 'imprest_stages',
      foreignKey: 'imprest_id',
      id,
      amount: imp.amount_issued,
      creatorUserId: imp.created_by || imp.user_id,
      excludeRoleCodes: ['admin_assistant'],
    });
    if (!stages.length) throw new HttpError(400, 'No approval stages are configured for this amount.');
    const now = nowIso();
    ctx.db.prepare("UPDATE imprests SET status = 'pending', current_stage = 1, submitted_at = ?, updated_at = ? WHERE id = ?").run(now, now, id);
    const stage = activeStageFor(ctx.db, 'imprest_stages', 'imprest_id', id);
    notifyStage(ctx.db, imp, stage);
    audit(ctx, 'SUBMIT', 'imprest', id, { status: imp.status }, { status: 'pending' });
    return { ok: true, stages: stages.map((s) => s.name) };
  });

  // Approve imprest
  router.post('/api/imprests/:id/approve', async (ctx) => {
    auth.guard(ctx.user, 'bill.approve');
    const id = Number(ctx.params.id);
    const imp = ctx.db.prepare('SELECT * FROM imprests WHERE id = ?').get(id);
    if (!imp) throw new HttpError(404, 'Imprest not found.');
    assertUnitAccess(ctx, imp);
    if (imp.status !== 'pending') throw new HttpError(400, 'Only pending imprests can be approved.');
    const stage = activeStageFor(ctx.db, 'imprest_stages', 'imprest_id', id);
    if (!stage) throw new HttpError(400, 'No pending approval stage.');
    if (!canAct(ctx.user, stage)) throw new HttpError(403, 'You are not the approver for this stage.');
    const now = nowIso();
    const body = ctx.body || {};
    const signature = body.signatureImage || ctx.user.signature_image || null;
    ctx.db.prepare(
      "UPDATE imprest_stages SET status = 'approved', acted_by = ?, acted_at = ?, comments = ?, signature_image = ? WHERE id = ?"
    ).run(ctx.user.id, now, body.comments || '', signature, stage.id);
    const nextStage = ctx.db.prepare(
      "SELECT bs.*, r.code AS role_code FROM imprest_stages bs JOIN roles r ON r.id = bs.role_id WHERE bs.imprest_id = ? AND bs.status = 'pending' AND bs.sequence > ? ORDER BY bs.sequence LIMIT 1"
    ).get(id, stage.sequence);
    if (nextStage) {
      ctx.db.prepare('UPDATE imprests SET current_stage = ?, updated_at = ? WHERE id = ?').run(nextStage.sequence, now, id);
      notifyStage(ctx.db, imp, nextStage);
    } else {
      ctx.db.prepare("UPDATE imprests SET status = 'approved', approved_at = ?, updated_at = ? WHERE id = ?").run(now, now, id);
      notify([imp.user_id], 'Imprest approved', `Your imprest request ${imp.imprest_no} for ${imp.amount_issued} has been approved.`, `#/imprests/${id}`);
    }
    audit(ctx, 'APPROVE', 'imprest', id, { status: imp.status }, { status: nextStage ? imp.status : 'approved' });
    return {
      ok: true,
      status: nextStage ? imp.status : 'approved',
      message: nextStage ? `Approved and forwarded to ${nextStage.name}.` : 'Final approval granted. The imprest is ready to be issued.',
    };
  });

  // Reject imprest
  router.post('/api/imprests/:id/reject', async (ctx) => {
    auth.guard(ctx.user, 'bill.reject');
    const id = Number(ctx.params.id);
    const imp = ctx.db.prepare('SELECT * FROM imprests WHERE id = ?').get(id);
    if (!imp) throw new HttpError(404, 'Imprest not found.');
    assertUnitAccess(ctx, imp);
    if (imp.status !== 'pending') throw new HttpError(400, 'Only pending imprests can be rejected.');
    const stage = activeStageFor(ctx.db, 'imprest_stages', 'imprest_id', id);
    if (!stage) throw new HttpError(400, 'No pending approval stage.');
    if (!canAct(ctx.user, stage)) throw new HttpError(403, 'You are not the approver for this stage.');
    const body = ctx.body || {};
    const now = nowIso();
    const signature = body.signatureImage || ctx.user.signature_image || null;
    ctx.db.prepare("UPDATE imprests SET status = 'rejected', updated_at = ? WHERE id = ?").run(now, id);
    ctx.db.prepare(
      "UPDATE imprest_stages SET status = 'rejected', acted_by = ?, acted_at = ?, comments = ?, signature_image = ? WHERE imprest_id = ? AND status = 'pending'"
    ).run(ctx.user.id, now, body.comments || '', signature, id);
    notify([imp.user_id], 'Imprest rejected', `Your imprest request ${imp.imprest_no} has been rejected. ${body.comments || ''}`, `#/imprests/${id}`);
    audit(ctx, 'REJECT', 'imprest', id, { status: imp.status }, { status: 'rejected', comments: body.comments });
    return { ok: true, status: 'rejected', message: 'Imprest rejected.' };
  });

  // Return imprest to the requester for correction
  router.post('/api/imprests/:id/return', async (ctx) => {
    auth.guard(ctx.user, 'bill.return');
    const id = Number(ctx.params.id);
    const imp = ctx.db.prepare('SELECT * FROM imprests WHERE id = ?').get(id);
    if (!imp) throw new HttpError(404, 'Imprest not found.');
    assertUnitAccess(ctx, imp);
    if (imp.status !== 'pending') throw new HttpError(400, 'Only pending imprests can be returned.');
    const stage = activeStageFor(ctx.db, 'imprest_stages', 'imprest_id', id);
    if (!stage) throw new HttpError(400, 'No pending approval stage.');
    if (!canAct(ctx.user, stage)) throw new HttpError(403, 'You are not the approver for this stage.');
    const body = ctx.body || {};
    const now = nowIso();
    const signature = body.signatureImage || ctx.user.signature_image || null;
    ctx.db.prepare("UPDATE imprests SET status = 'returned', updated_at = ? WHERE id = ?").run(now, id);
    ctx.db.prepare(
      "UPDATE imprest_stages SET status = 'returned', acted_by = ?, acted_at = ?, comments = ?, signature_image = ? WHERE imprest_id = ? AND status = 'pending'"
    ).run(ctx.user.id, now, body.comments || '', signature, id);
    notify([imp.user_id], 'Imprest returned for correction', `Your imprest request ${imp.imprest_no} was returned by ${ctx.user.name}. ${body.comments || ''}`, `#/imprests/${id}`);
    audit(ctx, 'RETURN', 'imprest', id, { status: imp.status }, { status: 'returned', comments: body.comments });
    return { ok: true, status: 'returned', message: 'Imprest returned to the requester for correction.' };
  });

  // Issue imprest (after approval)
  router.post('/api/imprests/:id/issue', async (ctx) => {
    auth.guard(ctx.user, 'bill.approve');
    const id = Number(ctx.params.id);
    const imp = ctx.db.prepare('SELECT * FROM imprests WHERE id = ?').get(id);
    if (!imp) throw new HttpError(404, 'Imprest not found.');
    assertUnitAccess(ctx, imp);
    if (imp.status !== 'approved') throw new HttpError(400, 'Only approved imprests can be issued.');
    const body = ctx.body || {};
    const amount = round2(body.amountIssued || imp.amount_issued);
    if (!(amount > 0)) throw badRequest('Amount issued must be greater than zero.');
    const now = nowIso();
    ctx.db.prepare(
      "UPDATE imprests SET status = 'Open', date_issued = ?, amount_issued = ?, balance_amount = ?, issued_by = ?, updated_at = ? WHERE id = ?"
    ).run(
      body.dateIssued ? String(body.dateIssued).slice(0, 10) : now.slice(0, 10),
      amount,
      amount,
      ctx.user.id,
      now,
      id
    );
    notify([imp.user_id], 'Imprest issued', `Your imprest ${imp.imprest_no} for ${amount} has been issued.`, `#/imprests/${id}`);
    audit(ctx, 'ISSUE', 'imprest', id, { status: imp.status }, { status: 'Open', amount });
    return { ok: true, status: 'Open', message: 'Imprest issued and now open for settlement.' };
  });

  // Settle imprest against bills
  router.post('/api/imprests/:id/settle', async (ctx) => {
    auth.guard(ctx.user, 'bill.approve');
    const id = Number(ctx.params.id);
    const imp = ctx.db.prepare('SELECT * FROM imprests WHERE id = ?').get(id);
    if (!imp) throw new HttpError(404, 'Imprest not found.');
    assertUnitAccess(ctx, imp);
    if (!['Open', 'Partially Settled', 'Overdue'].includes(imp.status)) {
      throw new HttpError(400, 'Only an open imprest can be settled against bills.');
    }
    const body = ctx.body || {};
    const billIds = Array.isArray(body.billIds) ? body.billIds : [];
    const now = nowIso();
    let totalSettled = round2(imp.settled_amount);
    let added = 0;
    for (const bid of billIds) {
      const bill = ctx.db.prepare('SELECT * FROM bills WHERE id = ?').get(Number(bid));
      if (!bill) continue;
      const already = ctx.db.prepare('SELECT 1 FROM imprest_bills WHERE imprest_id = ? AND bill_id = ?').get(id, Number(bid));
      if (already) continue;
      let amt = round2(body.amounts && body.amounts[bid] ? body.amounts[bid] : bill.net_amount);
      if (!(amt > 0)) continue;
      if (totalSettled + amt > imp.amount_issued) amt = round2(imp.amount_issued - totalSettled);
      if (!(amt > 0)) break;
      ctx.db.prepare(
        `INSERT INTO imprest_bills(imprest_id, bill_id, amount, notes, created_by, created_at) VALUES (?,?,?,?,?,?)`
      ).run(id, Number(bid), amt, body.notes || '', ctx.user.id, now);
      ctx.db.prepare("UPDATE bills SET cash_settlement_type = 'imprest', imprest_reference = ? WHERE id = ?").run(imp.imprest_no, Number(bid));
      totalSettled = round2(totalSettled + amt);
      added += 1;
    }
    const balance = round2(imp.amount_issued - totalSettled);
    let status = imp.status;
    if (totalSettled >= imp.amount_issued - 0.004) status = 'Settled';
    else if (totalSettled > 0) status = 'Partially Settled';
    if (imp.due_date && imp.due_date < now.slice(0, 10) && status !== 'Settled') status = 'Overdue';
    ctx.db.prepare('UPDATE imprests SET settled_amount = ?, balance_amount = ?, status = ?, updated_at = ? WHERE id = ?').run(totalSettled, balance, status, now, id);
    audit(ctx, 'UPDATE', 'imprest', id, null, { settled: totalSettled, balance, status, bills: added });
    if (balance <= 0.004) {
      notify([imp.user_id], 'Imprest settled', `Your imprest ${imp.imprest_no} has been fully settled.`, `#/imprests/${id}`);
    }
    return { id, settledAmount: totalSettled, balanceAmount: balance, status, billsSettled: added };
  });

  // Edit imprest (draft or returned)
  router.put('/api/imprests/:id', async (ctx) => {
    auth.guard(ctx.user, 'advance.edit');
    const id = Number(ctx.params.id);
    const imp = ctx.db.prepare('SELECT * FROM imprests WHERE id = ?').get(id);
    if (!imp) throw new HttpError(404, 'Imprest not found.');
    assertUnitAccess(ctx, imp);
    if (imp.status !== 'draft' && imp.status !== 'returned') throw new HttpError(400, 'Only draft or returned imprests can be edited.');
    if (imp.user_id !== ctx.user.id && imp.created_by !== ctx.user.id && !auth.can(ctx.user, 'advance.edit')) {
      throw new HttpError(403, 'You can only edit your own imprest requests.');
    }
    const body = ctx.body || {};
    const now = nowIso();
    const amount = body.amountIssued !== undefined ? round2(body.amountIssued) : imp.amount_issued;
    if (!(amount > 0)) throw badRequest('Amount issued must be greater than zero.');
    ctx.db.prepare(
      `UPDATE imprests SET purpose = ?, amount_issued = ?, date_issued = ?, due_date = ?, department_id = ?, unit_id = ?, balance_amount = ?, updated_at = ? WHERE id = ?`
    ).run(
      body.purpose ? String(body.purpose).trim() : imp.purpose,
      amount,
      body.dateIssued ? String(body.dateIssued).slice(0, 10) : imp.date_issued,
      body.dueDate ? String(body.dueDate).slice(0, 10) : imp.due_date,
      body.departmentId ? Number(body.departmentId) : imp.department_id,
      body.unitId ? Number(body.unitId) : imp.unit_id,
      amount,
      now,
      id
    );
    audit(ctx, 'UPDATE', 'imprest', id, null, body);
    return { id };
  });

  // Delete an imprest that never left the approval stage
  router.delete('/api/imprests/:id', async (ctx) => {
    auth.guard(ctx.user, 'advance.edit');
    const id = Number(ctx.params.id);
    const imp = ctx.db.prepare('SELECT * FROM imprests WHERE id = ?').get(id);
    if (!imp) throw new HttpError(404, 'Imprest not found.');
    assertUnitAccess(ctx, imp);
    if (!['draft', 'returned', 'rejected'].includes(imp.status)) {
      throw new HttpError(400, 'Only imprests that have not been approved can be deleted.');
    }
    ctx.db.prepare('DELETE FROM imprests WHERE id = ?').run(id);
    audit(ctx, 'DELETE', 'imprest', id, { imprestNo: imp.imprest_no, amount: imp.amount_issued });
    return { ok: true };
  });
};
