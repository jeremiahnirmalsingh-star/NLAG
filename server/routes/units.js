'use strict';

const auth = require('../auth');
const { HttpError } = require('../http');
const { audit, nowIso } = require('../util');

const UNIT_ADDRESS_FIELDS = [
  ['addressLine1', 'address_line1'],
  ['addressLine2', 'address_line2'],
  ['city', 'city'],
  ['state', 'state'],
  ['pincode', 'pincode'],
  ['phone', 'phone'],
  ['email', 'email'],
];

function addressFromBody(body, existing) {
  const out = {};
  for (const [camel, snake] of UNIT_ADDRESS_FIELDS) {
    const source = body[camel] !== undefined ? body[camel] : body[snake];
    out[camel] = source === undefined || source === null
      ? (existing ? String(existing[snake] || '') : '')
      : String(source).trim().slice(0, 200);
  }
  return out;
}

function addressFromRow(row) {
  const out = {};
  for (const [camel, snake] of UNIT_ADDRESS_FIELDS) out[camel] = String(row[snake] || '');
  return out;
}

function rowToUnit(r) {
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    active: !!r.active,
    ...addressFromRow(r),
    userCount: r.user_count || 0,
    billCount: r.bill_count || 0,
    createdAt: r.created_at,
  };
}

module.exports = function registerUnitRoutes(router) {
  router.get('/api/units', async (ctx) => {
    auth.guard(ctx.user, 'settings.manage');
    const rows = ctx.db
      .prepare(
        `SELECT un.*,
                (SELECT COUNT(*) FROM users u WHERE u.unit_id = un.id) AS user_count,
                (SELECT COUNT(*) FROM bills b WHERE b.unit_id = un.id) AS bill_count
           FROM units un ORDER BY un.name ASC`
      )
      .all();
    return { units: rows.map(rowToUnit) };
  });

  router.post('/api/units', async (ctx) => {
    auth.guard(ctx.user, 'settings.manage');
    const b = ctx.body || {};
    const name = String(b.name || '').trim();
    const code = String(b.code || '').trim().toUpperCase();
    if (!name) throw new HttpError(400, 'Unit name is required.');
    if (!code) throw new HttpError(400, 'Unit code is required.');
    if (!/^[A-Z0-9_-]{1,20}$/.test(code)) {
      throw new HttpError(400, 'Unit code can use letters, numbers, hyphen and underscore (max 20).');
    }
    const dup = ctx.db
      .prepare('SELECT id FROM units WHERE code = ? COLLATE NOCASE OR name = ? COLLATE NOCASE')
      .get(code, name);
    if (dup) throw new HttpError(409, 'A unit with this name or code already exists.');
    const address = addressFromBody(b);
    const now = nowIso();
    const res = ctx.db
      .prepare(
        `INSERT INTO units(code, name, active,
           address_line1, address_line2, city, state, pincode, phone, email,
           created_at, updated_at)
         VALUES (?,?,1,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        code, name,
        address.addressLine1, address.addressLine2, address.city, address.state,
        address.pincode, address.phone, address.email,
        now, now
      );
    ctx.db.prepare('INSERT OR IGNORE INTO user_units(user_id, unit_id) SELECT id, ? FROM users').run(Number(res.lastInsertRowid));
    audit(ctx, 'CREATE', 'unit', res.lastInsertRowid, null, { code, name, ...address });
    return { id: Number(res.lastInsertRowid) };
  });

  router.put('/api/units/:id', async (ctx) => {
    auth.guard(ctx.user, 'settings.manage');
    const id = Number(ctx.params.id);
    const unit = ctx.db.prepare('SELECT * FROM units WHERE id = ?').get(id);
    if (!unit) throw new HttpError(404, 'Unit not found.');
    const b = ctx.body || {};
    const name = b.name === undefined ? unit.name : String(b.name).trim();
    const code = b.code === undefined ? unit.code : String(b.code).trim().toUpperCase();
    const active = b.active === undefined ? unit.active : (b.active ? 1 : 0);
    if (!name) throw new HttpError(400, 'Unit name is required.');
    if (!/^[A-Z0-9_-]{1,20}$/.test(code)) {
      throw new HttpError(400, 'Unit code can use letters, numbers, hyphen and underscore (max 20).');
    }
    const dup = ctx.db
      .prepare('SELECT id FROM units WHERE (code = ? COLLATE NOCASE OR name = ? COLLATE NOCASE) AND id <> ?')
      .get(code, name, id);
    if (dup) throw new HttpError(409, 'A unit with this name or code already exists.');
    if (!active && ctx.unitId === id) {
      throw new HttpError(400, 'You cannot deactivate your own unit.');
    }
    const address = addressFromBody(b, unit);
    ctx.db
      .prepare(
        `UPDATE units SET code = ?, name = ?, active = ?,
           address_line1 = ?, address_line2 = ?, city = ?, state = ?, pincode = ?, phone = ?, email = ?,
           updated_at = ? WHERE id = ?`
      )
      .run(
        code, name, active,
        address.addressLine1, address.addressLine2, address.city, address.state,
        address.pincode, address.phone, address.email,
        nowIso(), id
      );
    audit(
      ctx, 'UPDATE', 'unit', id,
      { code: unit.code, name: unit.name, active: unit.active, ...addressFromRow(unit) },
      { code, name, active, ...address }
    );
    return { ok: true };
  });
};
