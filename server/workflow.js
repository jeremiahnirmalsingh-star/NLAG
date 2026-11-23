'use strict';

const { nowIso, userIdsByRole, notify, nextBillNo } = require('./util');

/**
 * Resolve the approval chain that applies to an amount.
 * Rules are matched by inclusive range; the most specific (highest minimum) wins.
 */
function resolveRule(db, amount) {
  const value = Number(amount) || 0;
  return db
    .prepare(
      `SELECT * FROM workflow_rules
        WHERE active = 1
          AND min_amount <= ?
          AND (max_amount IS NULL OR max_amount >= ?)
        ORDER BY min_amount DESC
        LIMIT 1`
    )
    .get(value, value);
}

function ruleStages(db, ruleId) {
  return db
    .prepare('SELECT * FROM workflow_stages WHERE rule_id = ? ORDER BY sequence ASC')
    .all(ruleId);
}

/**
 * Snapshot the resolved approval chain onto a record (bill, advance, ...).
 * Called on submit and on re-submit after a "return for correction".
 */
function buildStages(db, { table, foreignKey, id, amount, creatorUserId, excludeRoleCodes = [] }) {
  const rule = resolveRule(db, amount);
  let stages = rule ? ruleStages(db, rule.id) : [];
  // Skip approval stages whose role matches the record creator's role:
  // the person who entered the record has already performed that step.
  if (creatorUserId) {
    const creator = db.prepare('SELECT role_id FROM users WHERE id = ?').get(Number(creatorUserId));
    if (creator && creator.role_id) {
      stages = stages.filter((st) => Number(st.role_id) !== Number(creator.role_id));
    }
  }
  if (excludeRoleCodes.length) {
    const placeholders = excludeRoleCodes.map(() => '?').join(',');
    const excluded = db
      .prepare(`SELECT id FROM roles WHERE code IN (${placeholders})`)
      .all(...excludeRoleCodes)
      .map((r) => Number(r.id));
    if (excluded.length) stages = stages.filter((st) => !excluded.includes(Number(st.role_id)));
  }
  db.prepare(`DELETE FROM ${table} WHERE ${foreignKey} = ?`).run(id);
  const insert = db.prepare(
    `INSERT INTO ${table}(${foreignKey}, sequence, name, role_id, user_id, alt_user_id,
                          status, escalation_days)
     VALUES (?,?,?,?,?,?,'pending',?)`
  );
  if (!stages.length && rule) {
    // Fallback: if all stages were filtered out, add administrator approval
    const adminRole = db.prepare("SELECT id FROM roles WHERE code = 'administrator'").get();
    if (adminRole) {
      stages = [{ name: 'Administrator Approval', role_id: adminRole.id, user_id: null, alt_user_id: null, escalation_days: 3 }];
    }
  }
  stages.forEach((stage, index) => {
    insert.run(
      id,
      index + 1,
      stage.name,
      stage.role_id,
      stage.user_id || null,
      stage.alt_user_id || null,
      stage.escalation_days || 3
    );
  });
  return { rule, stages };
}

function buildBillStages(db, billId, amount, creatorUserId) {
  return buildStages(db, {
    table: 'bill_stages',
    foreignKey: 'bill_id',
    id: billId,
    amount,
    creatorUserId,
  });
}

/**
 * Ensure a pending Administrative Pastor approval stage exists on a bill.
 * Workflow rules normally supply this stage; it is added here when an expense
 * category requires it or when an Administrator explicitly forwards the bill.
 * Pass afterSequence to place it immediately after that stage; omit it to
 * append the stage at the end of the chain.
 */
function ensureAdminPastorStage(db, billId, { afterSequence = null } = {}) {
  const pastorRole = db.prepare("SELECT id FROM roles WHERE code = 'admin_pastor'").get();
  if (!pastorRole) return null;
  const existing = db
    .prepare("SELECT * FROM bill_stages WHERE bill_id = ? AND role_id = ? AND status = 'pending' ORDER BY sequence LIMIT 1")
    .get(billId, pastorRole.id);
  if (existing) return existing;

  let sequence;
  if (afterSequence != null) {
    sequence = Number(afterSequence) + 1;
    db.prepare('UPDATE bill_stages SET sequence = sequence + 1 WHERE bill_id = ? AND sequence >= ?')
      .run(billId, sequence);
  } else {
    const max = db
      .prepare('SELECT COALESCE(MAX(sequence), 0) AS m FROM bill_stages WHERE bill_id = ?')
      .get(billId).m;
    sequence = Number(max) + 1;
  }

  db.prepare(
    `INSERT INTO bill_stages(bill_id, sequence, name, role_id, user_id, alt_user_id, status, escalation_days)
     VALUES (?,?,?,?,?,?,'pending',3)`
  ).run(billId, sequence, 'Administrative Pastor Approval', pastorRole.id, null, null);
  return db.prepare('SELECT * FROM bill_stages WHERE bill_id = ? AND sequence = ?').get(billId, sequence);
}

function buildAdvanceStages(db, advanceId, amount, creatorUserId) {  return buildStages(db, {
    table: 'advance_stages',
    foreignKey: 'advance_id',
    id: advanceId,
    amount,
    creatorUserId,
    excludeRoleCodes: ['admin_assistant'],
  });
}

function activeStageFor(db, table, foreignKey, id) {
  return db
    .prepare(
      `SELECT bs.*, r.code AS role_code, r.name AS role_name
         FROM ${table} bs
         JOIN roles r ON r.id = bs.role_id
        WHERE bs.${foreignKey} = ? AND bs.status = 'pending'
        ORDER BY bs.sequence ASC
        LIMIT 1`
    )
    .get(id);
}

function activeStage(db, billId) {
  return activeStageFor(db, 'bill_stages', 'bill_id', billId);
}

function canAct(user, stage) {
  if (!user || !stage) return false;
  if (user.role_code === 'super_admin') return true;
  if (stage.user_id && Number(stage.user_id) === Number(user.id)) return true;
  return user.role_code === stage.role_code;
}

/** Notify everyone who can act on the current stage. */
function notifyStage(db, bill, stage) {
  if (!stage) return;
  let ids = [];
  if (stage.user_id) ids = [stage.user_id];
  else ids = userIdsByRole(stage.role_code);
  const link = `#/bills/${bill.id}`;
  notify(
    ids,
    stage.role_code === 'admin_assistant' ? 'Bill pending your verification' : 'Bill pending your approval',
    `${bill.bill_no} from ${bill.vendor_name} for ${bill.net_amount.toFixed(2)} is awaiting ${stage.name}.`,
    link
  );
}

/** Notify everyone who can act on the current advance stage. */
function notifyAdvanceStage(db, advance, stage) {
  if (!stage) return;
  let ids = [];
  if (stage.user_id) ids = [stage.user_id];
  else ids = userIdsByRole(stage.role_code);
  notify(
    ids,
    'Vendor advance pending your approval',
    `${advance.advance_no} to ${advance.vendor_name} for ${Number(advance.amount).toFixed(2)} is awaiting ${stage.name}.`,
    `#/advances/${advance.id}`
  );
}

function ensureFallbackChain(db) {
  const count = db.prepare('SELECT COUNT(*) AS c FROM workflow_rules WHERE active = 1').get().c;
  if (count > 0) return;
  const adminRole = db.prepare("SELECT id FROM roles WHERE code = 'administrator'").get();
  const now = nowIso();
  const res = db
    .prepare(
      'INSERT INTO workflow_rules(name, min_amount, max_amount, active, created_at, updated_at) VALUES (?,?,NULL,1,?,?)'
    )
    .run('All amounts', 0, now, now);
  db.prepare(
    'INSERT INTO workflow_stages(rule_id, sequence, name, role_id, escalation_days) VALUES (?,?,?,?,?)'
  ).run(res.lastInsertRowid, 1, 'Administrator Approval', adminRole.id, 3);
}

module.exports = {
  resolveRule,
  ruleStages,
  buildStages,
  buildBillStages,
  buildAdvanceStages,
  ensureAdminPastorStage,
  activeStage,
  activeStageFor,
  canAct,
  notifyStage,
  notifyAdvanceStage,
  ensureFallbackChain,
  nextBillNo,
};
