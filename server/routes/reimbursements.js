'use strict';

const auth = require('../auth');
const { HttpError, badRequest } = require('../http');
const { audit, nowIso, round2 } = require('../util');

function nextReimbursementNo(db) {
  const year = new Date().getFullYear();
  const key = `reimbursement:${year}`;
  const row = db.prepare('SELECT value FROM sequences WHERE key = ?').get(key);
  const next = (row ? row.value : 0) + 1;
  db.prepare('INSERT INTO sequences(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, next);
  return `RMB/${year}/${String(next).padStart(4, '0')}`;
}

function reimbursementOut(r) {
  return {
    id: r.id,
    reimbursementNo: r.reimbursement_no,
    userId: r.user_id,
    userName: r.user_name,
    departmentId: r.department_id,
    departmentName: r.department_name,
    unitId: r.unit_id,
    unitName: r.unit_name,
    expenseCategory: r.expense_category,
    amount: r.amount,
    expenseDate: r.expense_date,
    description: r.description,
    remarks: r.remarks,
    status: r.status,
    currentStage: r.current_stage,
    submittedAt: r.submitted_at,
    approvedAt: r.approved_at,
    paidAt: r.paid_at,
    createdAt: r.created_at,
  };
}

module.exports = function registerReimbursementRoutes(router) {
  router.get('/api/reimbursements', async (ctx) => {
    auth.guard(ctx.user, 'bill.view');
    const q = ctx.query || {};
    let where = ' WHERE 1=1';
    const params = [];
    if (q.status) { where += ' AND r.status = ?'; params.push(q.status); }
    if (q.userId) { where += ' AND r.user_id = ?'; params.push(Number(q.userId)); }
    if (!auth.seesAllUnits(ctx.user)) {
      where += ' AND r.unit_id IN (' + (ctx.unitIds.length ? ctx.unitIds.map(() => '?').join(',') : '0') + ')';
      params.push(...(ctx.unitIds.length ? ctx.unitIds : [0]));
    }
    const rows = ctx.db.prepare(
      `SELECT r.*, u.name AS user_name, d.name AS department_name, un.name AS unit_name
         FROM reimbursements r
         JOIN users u ON u.id = r.user_id
         LEFT JOIN departments d ON d.id = r.department_id
         LEFT JOIN units un ON un.id = r.unit_id
         ${where} ORDER BY r.id DESC LIMIT 500`
    ).all(...params);
    return { reimbursements: rows.map(reimbursementOut) };
  });

  router.get('/api/reimbursements/:id', async (ctx) => {
    auth.guard(ctx.user, 'bill.view');
    const id = Number(ctx.params.id);
    const r = ctx.db.prepare(
      `SELECT r.*, u.name AS user_name, d.name AS department_name, un.name AS unit_name
         FROM reimbursements r JOIN users u ON u.id = r.user_id
         LEFT JOIN departments d ON d.id = r.department_id
         LEFT JOIN units un ON un.id = r.unit_id WHERE r.id = ?`
    ).get(id);
    if (!r) throw new HttpError(404, 'Reimbursement not found.');
    const attachments = ctx.db.prepare('SELECT * FROM reimbursement_attachments WHERE reimbursement_id = ? ORDER BY id ASC').all(id);
    return { reimbursement: reimbursementOut(r), attachments };
  });

  router.post('/api/reimbursements', async (ctx) => {
    auth.guard(ctx.user, 'bill.create');
    const body = ctx.body || {};
    if (!body.expenseCategory) throw badRequest('Expense category is required.');
    const amount = round2(body.amount);
    if (amount <= 0) throw badRequest('Amount must be greater than zero.');
    if (!body.expenseDate) throw badRequest('Expense date is required.');
    const userId = body.userId ? Number(body.userId) : ctx.user.id;
    const unitId = body.unitId ? Number(body.unitId) : (ctx.unitIds[0] || null);
    const now = nowIso();
    const no = nextReimbursementNo(ctx.db);
    const res = ctx.db.prepare(
      `INSERT INTO reimbursements(reimbursement_no, user_id, department_id, unit_id, expense_category, amount, expense_date, description, remarks, status, current_stage, created_by, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?, ?,?,'draft',0,?,?,?)`
    ).run(no, userId, body.departmentId ? Number(body.departmentId) : null, unitId, String(body.expenseCategory).trim(), amount, String(body.expenseDate).slice(0, 10), body.description || '', body.remarks || '', ctx.user.id, now, now);
    const id = Number(res.lastInsertRowid);
    audit(ctx, 'CREATE', 'reimbursement', id, null, { reimbursementNo: no, amount });
    return { id, reimbursementNo: no };
  });

  router.put('/api/reimbursements/:id', async (ctx) => {
    auth.guard(ctx.user, 'bill.edit');
    const id = Number(ctx.params.id);
    const r = ctx.db.prepare('SELECT * FROM reimbursements WHERE id = ?').get(id);
    if (!r) throw new HttpError(404, 'Reimbursement not found.');
    if (!['draft', 'returned'].includes(r.status)) throw new HttpError(400, 'Only draft or returned reimbursements can be edited.');
    const body = ctx.body || {};
    const now = nowIso();
    const amount = body.amount !== undefined ? round2(body.amount) : r.amount;
    ctx.db.prepare(
      `UPDATE reimbursements SET department_id = ?, unit_id = ?, expense_category = ?, amount = ?, expense_date = ?, description = ?, remarks = ?, updated_at = ? WHERE id = ?`
    ).run(
      body.departmentId ? Number(body.departmentId) : r.department_id,
      body.unitId ? Number(body.unitId) : r.unit_id,
      body.expenseCategory ? String(body.expenseCategory).trim() : r.expense_category,
      amount,
      body.expenseDate ? String(body.expenseDate).slice(0, 10) : r.expense_date,
      body.description !== undefined ? body.description : r.description,
      body.remarks !== undefined ? body.remarks : r.remarks,
      now, id
    );
    audit(ctx, 'UPDATE', 'reimbursement', id, null, body);
    return { id };
  });

  router.post('/api/reimbursements/:id/submit', async (ctx) => {
    auth.guard(ctx.user, 'bill.create');
    const id = Number(ctx.params.id);
    const r = ctx.db.prepare('SELECT * FROM reimbursements WHERE id = ?').get(id);
    if (!r) throw new HttpError(404, 'Reimbursement not found.');
    if (r.status !== 'draft' && r.status !== 'returned') throw new HttpError(400, 'Only draft or returned reimbursements can be submitted.');
    const now = nowIso();
    ctx.db.prepare("UPDATE reimbursements SET status = 'pending', current_stage = 1, submitted_at = ?, updated_at = ? WHERE id = ?").run(now, now, id);
    audit(ctx, 'SUBMIT', 'reimbursement', id, null, {});
    return { id, status: 'pending' };
  });

  router.post('/api/reimbursements/:id/approve', async (ctx) => {
    auth.guard(ctx.user, 'bill.approve');
    const id = Number(ctx.params.id);
    const r = ctx.db.prepare('SELECT * FROM reimbursements WHERE id = ?').get(id);
    if (!r) throw new HttpError(404, 'Reimbursement not found.');
    if (r.status !== 'pending') throw new HttpError(400, 'Only pending reimbursements can be approved.');
    const now = nowIso();
    ctx.db.prepare("UPDATE reimbursements SET status = 'approved', approved_at = ?, updated_at = ? WHERE id = ?").run(now, now, id);
    audit(ctx, 'APPROVE', 'reimbursement', id, null, {});
    return { id, status: 'approved' };
  });

  router.post('/api/reimbursements/:id/reject', async (ctx) => {
    auth.guard(ctx.user, 'bill.reject');
    const id = Number(ctx.params.id);
    const r = ctx.db.prepare('SELECT * FROM reimbursements WHERE id = ?').get(id);
    if (!r) throw new HttpError(404, 'Reimbursement not found.');
    const body = ctx.body || {};
    const now = nowIso();
    ctx.db.prepare("UPDATE reimbursements SET status = 'rejected', updated_at = ? WHERE id = ?").run(now, id);
    audit(ctx, 'REJECT', 'reimbursement', id, null, { remarks: body.remarks });
    return { id, status: 'rejected' };
  });

  router.post('/api/reimbursements/:id/pay', async (ctx) => {
    auth.guard(ctx.user, 'handover.acknowledge');
    const id = Number(ctx.params.id);
    const r = ctx.db.prepare('SELECT * FROM reimbursements WHERE id = ?').get(id);
    if (!r) throw new HttpError(404, 'Reimbursement not found.');
    if (r.status !== 'approved') throw new HttpError(400, 'Only approved reimbursements can be paid.');
    const now = nowIso();
    ctx.db.prepare("UPDATE reimbursements SET status = 'paid', paid_at = ?, updated_at = ? WHERE id = ?").run(now, now, id);
    audit(ctx, 'PAY', 'reimbursement', id, null, {});
    return { id, status: 'paid' };
  });
};
