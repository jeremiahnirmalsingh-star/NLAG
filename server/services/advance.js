'use strict';

const { round2, nowIso, badRequest } = require('../util');

function ledgerBalance(db, advanceId) {
  const row = db
    .prepare('SELECT COALESCE(SUM(debit),0) - COALESCE(SUM(credit),0) AS bal FROM advance_ledger WHERE advance_id = ?')
    .get(advanceId);
  return round2(row.bal);
}

function refreshStatus(db, advanceId) {
  const adv = db.prepare('SELECT * FROM advances WHERE id = ?').get(advanceId);
  if (!adv) return;
  // Approval-driven states are managed by the workflow, not utilisation.
  if (['pending', 'rejected', 'returned'].includes(adv.status)) return;
  const balance = round2(adv.amount - adv.adjusted_amount);
  let status = 'Open';
  if (adv.status === 'Closed') status = 'Closed';
  else if (balance <= 0.004) status = 'Fully Adjusted';
  else if (adv.adjusted_amount > 0) status = 'Partially Adjusted';
  db.prepare('UPDATE advances SET status = ?, updated_at = ? WHERE id = ?').run(status, nowIso(), advanceId);
}

function postLedger(db, { advanceId, txnType, debit = 0, credit = 0, referenceType, referenceId, notes, userId, txnDate }) {
  const balance = round2(ledgerBalance(db, advanceId) + debit - credit);
  db.prepare(
    `INSERT INTO advance_ledger(advance_id, txn_date, txn_type, debit, credit, balance,
       reference_type, reference_id, notes, created_by, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    advanceId,
    txnDate || new Date().toISOString().slice(0, 10),
    txnType,
    round2(debit),
    round2(credit),
    balance,
    referenceType || null,
    referenceId || null,
    notes || null,
    userId || null,
    nowIso()
  );
  return balance;
}

function createAdvance(db, data, userId) {
  const now = nowIso();
  const res = db
    .prepare(
      `INSERT INTO advances(advance_no, vendor_id, advance_date, amount, adjusted_amount, purpose,
         department_id, unit_id, remarks, status, created_by, created_at, updated_at)
       VALUES (?,?,?,?,0,?,?,?,?,'pending',?,?,?)`
    )
    .run(
      data.advanceNo,
      data.vendorId,
      data.advanceDate,
      round2(data.amount),
      data.purpose || '',
      data.departmentId || null,
      data.unitId || null,
      data.remarks || '',
      userId,
      now,
      now
    );
  return Number(res.lastInsertRowid);
}

/** Post the paid amount once the advance receives final approval. */
function activateAdvance(db, advanceId, userId) {
  const adv = db.prepare('SELECT * FROM advances WHERE id = ?').get(advanceId);
  if (!adv) throw badRequest('Advance not found.');
  db.prepare("UPDATE advances SET status = 'Open', approved_at = ?, updated_at = ? WHERE id = ?").run(
    nowIso(),
    nowIso(),
    advanceId
  );
  postLedger(db, {
    advanceId,
    txnType: 'Advance Paid',
    debit: adv.amount,
    referenceType: 'advance',
    referenceId: advanceId,
    notes: adv.purpose || 'Advance approved',
    userId,
    txnDate: adv.advance_date,
  });
}

/** Replace all advance adjustments for a bill (used while the bill is a draft). */
function setBillAdjustments(db, billId, items, userId) {
  const bill = db.prepare('SELECT * FROM bills WHERE id = ?').get(billId);
  if (!bill) throw badRequest('Bill not found.');
  reverseBillAdjustments(db, billId, userId);

  let total = 0;
  for (const item of items || []) {
    const amount = round2(item.amount);
    if (amount <= 0) continue;
    const adv = db.prepare('SELECT * FROM advances WHERE id = ?').get(item.advanceId);
    if (!adv) throw badRequest('Selected advance no longer exists.');
    if (adv.vendor_id !== bill.vendor_id) throw badRequest('Advance belongs to a different vendor.');
    if (!['Open', 'Partially Adjusted'].includes(adv.status)) {
      throw badRequest(`Advance ${adv.advance_no} is not approved or is closed.`);
    }
    const available = round2(adv.amount - adv.adjusted_amount);
    if (amount > available + 0.004) {
      throw badRequest(`Adjustment for ${adv.advance_no} exceeds the available balance of ${available.toFixed(2)}.`);
    }
    db.prepare(
      'INSERT INTO bill_advances(bill_id, advance_id, amount, created_by, created_at) VALUES (?,?,?,?,?)'
    ).run(billId, adv.id, amount, userId, nowIso());
    db.prepare('UPDATE advances SET adjusted_amount = ?, updated_at = ? WHERE id = ?').run(
      round2(adv.adjusted_amount + amount),
      nowIso(),
      adv.id
    );
    postLedger(db, {
      advanceId: adv.id,
      txnType: 'Invoice Adjustment',
      credit: amount,
      referenceType: 'bill',
      referenceId: billId,
      notes: `Adjusted against ${bill.bill_no} (${bill.invoice_number})`,
      userId,
    });
    refreshStatus(db, adv.id);
    total += amount;
  }

  if (total > bill.net_amount + 0.004) {
    reverseBillAdjustments(db, billId, userId);
    throw badRequest('Total advance adjustment cannot exceed the net bill amount.');
  }
  db.prepare('UPDATE bills SET advance_adjusted = ?, updated_at = ? WHERE id = ?').run(round2(total), nowIso(), billId);
  return total;
}

function reverseBillAdjustments(db, billId, userId) {
  const rows = db.prepare('SELECT * FROM bill_advances WHERE bill_id = ?').all(billId);
  for (const row of rows) {
    const adv = db.prepare('SELECT * FROM advances WHERE id = ?').get(row.advance_id);
    if (adv) {
      db.prepare('UPDATE advances SET adjusted_amount = MAX(0, ? - ?), updated_at = ? WHERE id = ?').run(
        adv.adjusted_amount,
        row.amount,
        nowIso(),
        adv.id
      );
      postLedger(db, {
        advanceId: adv.id,
        txnType: 'Adjustment Reversal',
        debit: row.amount,
        referenceType: 'bill',
        referenceId: billId,
        notes: 'Adjustment reversed',
        userId,
      });
      refreshStatus(db, adv.id);
    }
  }
  db.prepare('DELETE FROM bill_advances WHERE bill_id = ?').run(billId);
  db.prepare('UPDATE bills SET advance_adjusted = 0, updated_at = ? WHERE id = ?').run(nowIso(), billId);
}

function availableAdvances(db, vendorId, excludeBillId) {
  const rows = db
    .prepare(
      `SELECT * FROM advances
        WHERE vendor_id = ? AND status IN ('Open','Partially Adjusted')
          AND amount - adjusted_amount > 0.004
        ORDER BY advance_date ASC`
    )
    .all(vendorId);
  const current = excludeBillId
    ? db.prepare('SELECT advance_id, amount FROM bill_advances WHERE bill_id = ?').all(excludeBillId)
    : [];
  return rows.map((a) => {
    const existing = current.find((c) => c.advance_id === a.id);
    return {
      id: a.id,
      advanceNo: a.advance_no,
      advanceDate: a.advance_date,
      amount: a.amount,
      adjustedAmount: a.adjusted_amount,
      available: round2(a.amount - a.adjusted_amount),
      alreadyAdjustedToBill: existing ? existing.amount : 0,
      purpose: a.purpose,
      status: a.status,
    };
  });
}

function closeAdvance(db, advanceId, userId) {
  const adv = db.prepare('SELECT * FROM advances WHERE id = ?').get(advanceId);
  if (!adv) throw badRequest('Advance not found.');
  if (!['Open', 'Partially Adjusted'].includes(adv.status)) {
    throw badRequest('Only approved advances can be closed.');
  }
  const balance = round2(adv.amount - adv.adjusted_amount);
  if (balance > 0.004) {
    postLedger(db, {
      advanceId,
      txnType: 'Advance Closed',
      credit: balance,
      referenceType: 'advance',
      referenceId: advanceId,
      notes: 'Unadjusted balance closed',
      userId,
    });
  }
  db.prepare("UPDATE advances SET status = 'Closed', adjusted_amount = ?, updated_at = ? WHERE id = ?").run(
    adv.amount,
    nowIso(),
    advanceId
  );
}

module.exports = {
  ledgerBalance,
  refreshStatus,
  postLedger,
  createAdvance,
  activateAdvance,
  setBillAdjustments,
  reverseBillAdjustments,
  availableAdvances,
  closeAdvance,
};
