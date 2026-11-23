'use strict';

const auth = require('../auth');
const { HttpError } = require('../http');
const { audit, nowIso } = require('../util');

const PASSWORD_MIN = 8;

function rowToUser(r) {
  return {
    id: r.id,
    employeeId: r.employee_id,
    name: r.name,
    department: r.department,
    designation: r.designation,
    mobile: r.mobile,
    email: r.email,
    username: r.username,
    roleId: r.role_id,
    roleName: r.role_name,
    roleCode: r.role_code,
    unitId: r.unit_id,
    unitName: r.unit_name,
    unitIds: r.unit_ids ? r.unit_ids.split(',').map(Number) : (r.unit_id ? [r.unit_id] : []),
    status: r.status,
    lastLoginAt: r.last_login_at,
    createdAt: r.created_at,
  };
}

module.exports = function registerUserRoutes(router) {
  function unitIdFrom(ctx, value, roleId) {
    const id = value === undefined || value === null || value === '' ? null : Number(value);
    if (id) {
      const unit = ctx.db.prepare('SELECT id, active FROM units WHERE id = ?').get(id);
      if (!unit) throw new HttpError(400, 'Selected unit does not exist.');
      if (!unit.active) throw new HttpError(400, 'Selected unit is inactive.');
    }
    const role = ctx.db.prepare('SELECT code FROM roles WHERE id = ?').get(Number(roleId));
    if (!id && role && role.code !== 'super_admin') {
      throw new HttpError(400, 'Select a unit for this user. Only super administrators can be unit-less.');
    }
    return id;
  }

  router.get('/api/users', async (ctx) => {
    auth.guard(ctx.user, 'user.manage');
    const { search = '', status = '' } = ctx.query;
    let sql = `SELECT u.*, r.name AS role_name, r.code AS role_code, un.name AS unit_name
                 FROM users u JOIN roles r ON r.id = u.role_id
                 LEFT JOIN units un ON un.id = u.unit_id WHERE 1=1`;
    const params = [];
    if (search) {
      sql += ` AND (u.name LIKE ? OR u.username LIKE ? OR u.employee_id LIKE ? OR u.email LIKE ?)`;
      const like = `%${search}%`;
      params.push(like, like, like, like);
    }
    if (status) {
      sql += ' AND u.status = ?';
      params.push(status);
    }
    sql += ' ORDER BY u.name ASC';
    return { users: ctx.db.prepare(sql).all(...params).map(rowToUser) };
  });

  router.post('/api/users', async (ctx) => {
    auth.guard(ctx.user, 'user.manage');
    const b = ctx.body || {};
    const required = ['employeeId', 'name', 'username', 'password', 'roleId'];
    for (const field of required) {
      if (!b[field]) throw new HttpError(400, `${field} is required.`);
    }
    if (String(b.password).length < PASSWORD_MIN) {
      throw new HttpError(400, `Password must be at least ${PASSWORD_MIN} characters.`);
    }
    const exists = ctx.db
      .prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE OR employee_id = ? COLLATE NOCASE')
      .get(String(b.username).trim(), String(b.employeeId).trim());
    if (exists) throw new HttpError(409, 'Username or Employee ID already exists.');
    const hasUnitIds = Array.isArray(b.unitIds);
    const requestedUnits = hasUnitIds ? b.unitIds.map(Number).filter(Boolean) : [];
    const unitId = hasUnitIds
      ? (requestedUnits.length ? requestedUnits[0] : unitIdFrom(ctx, b.unitId, b.roleId))
      : unitIdFrom(ctx, b.unitId, b.roleId);

    const now = nowIso();
    const res = ctx.db
      .prepare(
        `INSERT INTO users(employee_id, name, department, designation, mobile, email, username,
                           password_hash, role_id, unit_id, status, signature_image, must_change_password, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)`
      )
      .run(
        String(b.employeeId).trim(),
        String(b.name).trim(),
        b.department || '',
        b.designation || '',
        b.mobile || '',
        b.email || '',
        String(b.username).trim(),
        auth.hashPassword(b.password),
        Number(b.roleId),
        unitId,
        b.status || 'Active',
        b.signatureImage || null,
        now,
        now
      );
    const newId = Number(res.lastInsertRowid);
    if (hasUnitIds && requestedUnits.length) {
      for (const uid of requestedUnits) ctx.db.prepare('INSERT OR IGNORE INTO user_units(user_id, unit_id) VALUES (?,?)').run(newId, uid);
    } else {
      ctx.db.prepare('INSERT OR IGNORE INTO user_units(user_id, unit_id) SELECT ?, id FROM units WHERE active = 1').run(newId);
      if (unitId) ctx.db.prepare('INSERT OR IGNORE INTO user_units(user_id, unit_id) VALUES (?,?)').run(newId, unitId);
    }
    audit(ctx, 'CREATE', 'user', res.lastInsertRowid, null, { username: b.username, name: b.name });
    return { id: Number(res.lastInsertRowid) };
  });

  router.put('/api/users/:id', async (ctx) => {
    auth.guard(ctx.user, 'user.manage');
    const id = Number(ctx.params.id);
    const user = ctx.db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!user) throw new HttpError(404, 'User not found.');
    const b = ctx.body || {};
    if (id === ctx.user.id && b.status && b.status !== 'Active') {
      throw new HttpError(400, 'You cannot deactivate your own account.');
    }
    const dup = ctx.db
      .prepare('SELECT id FROM users WHERE (username = ? COLLATE NOCASE OR employee_id = ? COLLATE NOCASE) AND id <> ?')
      .get(String(b.username || user.username).trim(), String(b.employeeId || user.employee_id).trim(), id);
    if (dup) throw new HttpError(409, 'Username or Employee ID already exists with another user.');

    ctx.db
      .prepare(
        `UPDATE users SET employee_id = ?, name = ?, department = ?, designation = ?, mobile = ?,
                          email = ?, username = ?, role_id = ?, unit_id = ?, status = ?, signature_image = ?,
                          failed_attempts = 0, locked_until = NULL, updated_at = ?
          WHERE id = ?`
      )
      .run(
        String(b.employeeId || user.employee_id).trim(),
        String(b.name || user.name).trim(),
        b.department ?? user.department,
        b.designation ?? user.designation,
        b.mobile ?? user.mobile,
        b.email ?? user.email,
        String(b.username || user.username).trim(),
        Number(b.roleId || user.role_id),
        b.unitIds !== undefined ? (Array.isArray(b.unitIds) && b.unitIds.length ? Number(b.unitIds[0]) : (b.roleId || user.role_id ? null : user.unit_id)) : (b.unitId === undefined ? user.unit_id : unitIdFrom(ctx, b.unitId, b.roleId || user.role_id)),
        b.status || user.status,
        b.signatureImage === undefined ? user.signature_image : b.signatureImage,
        nowIso(),
        id
      );
    if (Array.isArray(b.unitIds)) {
      ctx.db.prepare('DELETE FROM user_units WHERE user_id = ?').run(id);
      for (const uid of b.unitIds.map(Number).filter(Boolean)) {
        ctx.db.prepare('INSERT OR IGNORE INTO user_units(user_id, unit_id) VALUES (?,?)').run(id, uid);
      }
      if (b.unitIds.length === 0 && b.roleId !== undefined) {
        // super admin with no units
      }
    } else {
      ctx.db.prepare('INSERT OR IGNORE INTO user_units(user_id, unit_id) SELECT id, unit_id FROM users WHERE id = ? AND unit_id IS NOT NULL').run(id);
    }
    audit(ctx, 'UPDATE', 'user', id, rowToUser(user), { name: b.name, status: b.status, roleId: b.roleId, unitId: b.unitId });
    return { ok: true };
  });

  router.post('/api/users/:id/reset-password', async (ctx) => {
    auth.guard(ctx.user, 'user.manage');
    const id = Number(ctx.params.id);
    const { password } = ctx.body || {};
    if (!password || String(password).length < PASSWORD_MIN) {
      throw new HttpError(400, `Password must be at least ${PASSWORD_MIN} characters.`);
    }
    const user = ctx.db.prepare('SELECT id FROM users WHERE id = ?').get(id);
    if (!user) throw new HttpError(404, 'User not found.');
    ctx.db
      .prepare('UPDATE users SET password_hash = ?, failed_attempts = 0, locked_until = NULL, must_change_password = 1, updated_at = ? WHERE id = ?')
      .run(auth.hashPassword(password), nowIso(), id);
    ctx.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    audit(ctx, 'RESET_PASSWORD', 'user', id);
    return { ok: true };
  });

  router.delete('/api/users/:id', async (ctx) => {
    auth.guard(ctx.user, 'user.manage');
    const id = Number(ctx.params.id);
    if (id === ctx.user.id) throw new HttpError(400, 'You cannot delete your own account.');
    const user = ctx.db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!user) throw new HttpError(404, 'User not found.');
    const referenced =
      ctx.db.prepare('SELECT COUNT(*) AS c FROM bills WHERE created_by = ?').get(id).c +
      ctx.db.prepare('SELECT COUNT(*) AS c FROM audit_logs WHERE user_id = ?').get(id).c;
    if (referenced > 0) {
      ctx.db.prepare("UPDATE users SET status = 'Inactive', updated_at = ? WHERE id = ?").run(nowIso(), id);
      audit(ctx, 'DEACTIVATE', 'user', id);
      return { ok: true, deactivated: true };
    }
    ctx.db.prepare('DELETE FROM users WHERE id = ?').run(id);
    audit(ctx, 'DELETE', 'user', id, rowToUser(user));
    return { ok: true };
  });
};
