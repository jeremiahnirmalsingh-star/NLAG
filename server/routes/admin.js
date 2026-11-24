'use strict';

const auth = require('../auth');
const { inUseMessage } = require('../shared-masters');
const { HttpError } = require('../http');
const { audit, nowIso, getSettings, setSetting, round2 } = require('../util');
const { ensureFallbackChain } = require('../workflow');

module.exports = function registerAdminRoutes(router) {
  const normalizeDeptCode = (value) => String(value || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 20);

  const uniqueDeptCode = (db, base, excludeId = 0) => {
    const code = normalizeDeptCode(base) || 'DEPT';
    let candidate = code;
    let suffix = 2;
    while (
      db.prepare('SELECT 1 FROM departments WHERE code = ? AND id <> ?').get(candidate, excludeId)
    ) {
      candidate = `${code.slice(0, 17)}_${suffix++}`;
    }
    return candidate;
  };

  /* ---------------------------------------------------------------- */
  /* Bootstrap data used by the SPA shell                              */
  /* ---------------------------------------------------------------- */
  router.get('/api/meta/bootstrap', async (ctx) => {
    const settings = getSettings();
    const roles = ctx.db.prepare('SELECT id, code, name, description FROM roles ORDER BY id').all();
    const departments = ctx.db.prepare('SELECT id, code, name, active FROM departments ORDER BY name').all();
    const categories = ctx.db.prepare('SELECT id, code, name, parent_id, active, requires_admin_pastor FROM categories ORDER BY name').all();
    const units = ctx.db.prepare('SELECT id, code, name, active FROM units ORDER BY name').all();
    const unitIdList = ctx.unitIds.length ? ctx.unitIds : [0];
    const pendingBillApprovals = ctx.db
      .prepare(
        `SELECT COUNT(*) AS c FROM bills b
           JOIN bill_stages bs ON bs.bill_id = b.id AND bs.status = 'pending'
          WHERE b.status = 'pending'
            AND (bs.role_id = ? OR ? = 'super_admin')
            AND b.unit_id IN (${unitIdList.map(() => '?').join(',')})`
      )
      .get(ctx.user.role_id, ctx.user.role_code, ...unitIdList).c;
    const pendingAdvanceApprovals = ctx.db
      .prepare(
        `SELECT COUNT(*) AS c FROM advances a
           JOIN advance_stages ast ON ast.advance_id = a.id AND ast.status = 'pending'
          WHERE a.status = 'pending'
            AND (ast.role_id = ? OR ? = 'super_admin')
            AND a.unit_id IN (${unitIdList.map(() => '?').join(',')})`
      )
      .get(ctx.user.role_id, ctx.user.role_code, ...unitIdList).c;
    const pendingImprestApprovals = ctx.db
      .prepare(
        `SELECT COUNT(*) AS c FROM imprests i
           JOIN imprest_stages ist ON ist.imprest_id = i.id AND ist.status = 'pending'
          WHERE i.status = 'pending'
            AND (ist.role_id = ? OR ? = 'super_admin')
            AND i.unit_id IN (${unitIdList.map(() => '?').join(',')})`
      )
      .get(ctx.user.role_id, ctx.user.role_code, ...unitIdList).c;
    const pendingApprovals = pendingBillApprovals + pendingAdvanceApprovals + pendingImprestApprovals;
    const unread = ctx.db
      .prepare('SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND is_read = 0')
      .get(ctx.user.id).c;
    return {
      user: auth.publicUser(ctx.user),
      roles,
      departments,
      categories,
      units,
      settings: {
        orgName: settings['org.name'] || '',
        orgDepartment: settings['org.department'] || '',
        orgAddress: settings['org.address'] || '',
        orgPhone: settings['org.phone'] || '',
        orgEmail: settings['org.email'] || '',
        orgWebsite: settings['org.website'] || '',
        orgGstin: settings['org.gstin'] || '',
        orgPan: settings['org.pan'] || '',
        orgGstState: settings['org.gst_state'] || '',
        currency: settings['currency'] || '\u20B9',
        reportFooter: settings['report.footer'] || '',
        publicBaseUrl: settings['public_base_url'] || '',
        defaultGstRate: Number(settings['tax.default_gst_rate'] || 18),
        defaultTransportGstRate: Number(settings['tax.default_transport_gst_rate'] || 18),
        generalTerms: settings['procurement.general_terms'] || '',
      },
      pendingApprovals,
      pendingBillApprovals,
      pendingAdvanceApprovals,
      pendingImprestApprovals,
      unreadNotifications: unread,
      currentUnitIds: ctx.unitIds,
      memberUnitIds: auth.memberUnitIds(ctx.db, ctx.user.id),
    };
  });

  /* ---------------------------------------------------------------- */
  /* Roles & permissions                                               */
  /* ---------------------------------------------------------------- */
  router.get('/api/permissions', async (ctx) => {
    auth.guard(ctx.user, 'role.manage');
    return { permissions: ctx.db.prepare('SELECT * FROM permissions ORDER BY module, key').all() };
  });

  router.get('/api/roles', async (ctx) => {
    if (!auth.can(ctx.user, 'role.manage') && !auth.can(ctx.user, 'user.manage')) {
      throw new HttpError(403, 'Not permitted.');
    }
    const roles = ctx.db.prepare('SELECT * FROM roles ORDER BY id').all();
    const perms = ctx.db.prepare('SELECT role_id, permission_key FROM role_permissions').all();
    return {
      roles: roles.map((r) => ({
        ...r,
        permissions: perms.filter((p) => p.role_id === r.id).map((p) => p.permission_key),
        userCount: ctx.db.prepare('SELECT COUNT(*) AS c FROM users WHERE role_id = ?').get(r.id).c,
      })),
    };
  });

  router.post('/api/roles', async (ctx) => {
    auth.guard(ctx.user, 'role.manage');
    const { code, name, description, permissions = [] } = ctx.body || {};
    if (!code || !name) throw new HttpError(400, 'Role code and name are required.');
    if (!/^[a-z0-9_]+$/.test(code)) throw new HttpError(400, 'Role code may contain lowercase letters, numbers and underscores only.');
    const exists = ctx.db.prepare('SELECT id FROM roles WHERE code = ?').get(code);
    if (exists) throw new HttpError(409, 'Role code already exists.');
    const res = ctx.db
      .prepare('INSERT INTO roles(code, name, description, is_system) VALUES (?,?,?,0)')
      .run(code, name, description || '');
    const grant = ctx.db.prepare('INSERT INTO role_permissions(role_id, permission_key) VALUES (?,?)');
    const valid = new Set(ctx.db.prepare('SELECT key FROM permissions').all().map((p) => p.key));
    for (const p of permissions) if (valid.has(p)) grant.run(res.lastInsertRowid, p);
    audit(ctx, 'CREATE', 'role', res.lastInsertRowid, null, { code, name });
    return { id: Number(res.lastInsertRowid) };
  });

  router.put('/api/roles/:id', async (ctx) => {
    auth.guard(ctx.user, 'role.manage');
    const id = Number(ctx.params.id);
    const role = ctx.db.prepare('SELECT * FROM roles WHERE id = ?').get(id);
    if (!role) throw new HttpError(404, 'Role not found.');
    const { name, description, permissions } = ctx.body || {};
    if (role.code === 'super_admin') {
      throw new HttpError(400, 'The Super Administrator role always has full access and cannot be modified.');
    }
    if (name) ctx.db.prepare('UPDATE roles SET name = ?, description = ? WHERE id = ?').run(name, description || '', id);
    if (Array.isArray(permissions)) {
      ctx.db.prepare('DELETE FROM role_permissions WHERE role_id = ?').run(id);
      const grant = ctx.db.prepare('INSERT INTO role_permissions(role_id, permission_key) VALUES (?,?)');
      const valid = new Set(ctx.db.prepare('SELECT key FROM permissions').all().map((p) => p.key));
      for (const p of permissions) if (valid.has(p)) grant.run(id, p);
    }
    audit(ctx, 'UPDATE', 'role', id, { name: role.name }, { name, permissions });
    return { ok: true };
  });

  router.delete('/api/roles/:id', async (ctx) => {
    auth.guard(ctx.user, 'role.manage');
    const id = Number(ctx.params.id);
    const role = ctx.db.prepare('SELECT * FROM roles WHERE id = ?').get(id);
    if (!role) throw new HttpError(404, 'Role not found.');
    if (role.is_system) throw new HttpError(400, 'System roles cannot be deleted.');
    const users = ctx.db.prepare('SELECT COUNT(*) AS c FROM users WHERE role_id = ?').get(id).c;
    if (users > 0) throw new HttpError(400, 'Reassign users before deleting this role.');
    ctx.db.prepare('DELETE FROM roles WHERE id = ?').run(id);
    audit(ctx, 'DELETE', 'role', id, { code: role.code });
    return { ok: true };
  });

  /* ---------------------------------------------------------------- */
  /* Approval workflow configuration                                   */
  /* ---------------------------------------------------------------- */
  router.get('/api/workflow', async (ctx) => {
    auth.guard(ctx.user, 'workflow.manage');
    const rules = ctx.db.prepare('SELECT * FROM workflow_rules ORDER BY min_amount ASC').all();
    const stages = ctx.db
      .prepare(
        `SELECT ws.*, r.name AS role_name, u.name AS user_name, a.name AS alt_user_name
           FROM workflow_stages ws
           JOIN roles r ON r.id = ws.role_id
           LEFT JOIN users u ON u.id = ws.user_id
           LEFT JOIN users a ON a.id = ws.alt_user_id
          ORDER BY ws.sequence ASC`
      )
      .all();
    return {
      rules: rules.map((r) => ({
        ...r,
        stages: stages.filter((s) => s.rule_id === r.id),
      })),
    };
  });

  function readStages(ctx) {
    const stages = Array.isArray(ctx.body.stages) ? ctx.body.stages : [];
    if (!stages.length) throw new HttpError(400, 'At least one approval stage is required.');
    const validRoles = new Set(ctx.db.prepare('SELECT id FROM roles').all().map((r) => r.id));
    return stages.map((s, i) => {
      if (!s.name) throw new HttpError(400, `Stage ${i + 1} needs a name.`);
      if (!validRoles.has(Number(s.roleId))) throw new HttpError(400, `Stage ${i + 1} has an invalid approver role.`);
      return {
        sequence: i + 1,
        name: String(s.name).trim(),
        roleId: Number(s.roleId),
        userId: s.userId ? Number(s.userId) : null,
        altUserId: s.altUserId ? Number(s.altUserId) : null,
        escalationDays: Number(s.escalationDays) || 3,
      };
    });
  }

  router.post('/api/workflow/rules', async (ctx) => {
    auth.guard(ctx.user, 'workflow.manage');
    const b = ctx.body || {};
    if (!b.name) throw new HttpError(400, 'Rule name is required.');
    const min = round2(b.minAmount ?? 0);
    const max = b.maxAmount === null || b.maxAmount === '' || b.maxAmount === undefined ? null : round2(b.maxAmount);
    if (max !== null && max < min) throw new HttpError(400, 'Maximum amount cannot be less than minimum amount.');
    const stages = readStages(ctx);
    const now = nowIso();
    const res = ctx.db
      .prepare('INSERT INTO workflow_rules(name, min_amount, max_amount, active, created_at, updated_at) VALUES (?,?,?,?,?,?)')
      .run(String(b.name).trim(), min, max, b.active === false ? 0 : 1, now, now);
    const ruleId = Number(res.lastInsertRowid);
    const ins = ctx.db.prepare(
      'INSERT INTO workflow_stages(rule_id, sequence, name, role_id, user_id, alt_user_id, escalation_days) VALUES (?,?,?,?,?,?,?)'
    );
    for (const s of stages) ins.run(ruleId, s.sequence, s.name, s.roleId, s.userId, s.altUserId, s.escalationDays);
    audit(ctx, 'CREATE', 'workflow_rule', ruleId, null, b);
    return { id: ruleId };
  });

  router.put('/api/workflow/rules/:id', async (ctx) => {
    auth.guard(ctx.user, 'workflow.manage');
    const id = Number(ctx.params.id);
    const rule = ctx.db.prepare('SELECT * FROM workflow_rules WHERE id = ?').get(id);
    if (!rule) throw new HttpError(404, 'Workflow rule not found.');
    const b = ctx.body || {};
    if (!b.name) throw new HttpError(400, 'Rule name is required.');
    const min = round2(b.minAmount ?? 0);
    const max = b.maxAmount === null || b.maxAmount === '' || b.maxAmount === undefined ? null : round2(b.maxAmount);
    if (max !== null && max < min) throw new HttpError(400, 'Maximum amount cannot be less than minimum amount.');
    const stages = readStages(ctx);
    ctx.db
      .prepare('UPDATE workflow_rules SET name = ?, min_amount = ?, max_amount = ?, active = ?, updated_at = ? WHERE id = ?')
      .run(String(b.name).trim(), min, max, b.active === false ? 0 : 1, nowIso(), id);
    ctx.db.prepare('DELETE FROM workflow_stages WHERE rule_id = ?').run(id);
    const ins = ctx.db.prepare(
      'INSERT INTO workflow_stages(rule_id, sequence, name, role_id, user_id, alt_user_id, escalation_days) VALUES (?,?,?,?,?,?,?)'
    );
    for (const s of stages) ins.run(id, s.sequence, s.name, s.roleId, s.userId, s.altUserId, s.escalationDays);
    audit(ctx, 'UPDATE', 'workflow_rule', id, { name: rule.name }, b);
    return { ok: true };
  });

  router.delete('/api/workflow/rules/:id', async (ctx) => {
    auth.guard(ctx.user, 'workflow.manage');
    const id = Number(ctx.params.id);
    const rule = ctx.db.prepare('SELECT * FROM workflow_rules WHERE id = ?').get(id);
    if (!rule) throw new HttpError(404, 'Workflow rule not found.');
    ctx.db.prepare('DELETE FROM workflow_rules WHERE id = ?').run(id);
    ensureFallbackChain(ctx.db);
    audit(ctx, 'DELETE', 'workflow_rule', id, { name: rule.name });
    return { ok: true };
  });

  /* ---------------------------------------------------------------- */
  /* Settings                                                          */
  /* ---------------------------------------------------------------- */
  router.get('/api/settings', async (ctx) => {
    auth.guard(ctx.user, 'settings.manage');
    return { settings: getSettings() };
  });

  router.put('/api/settings', async (ctx) => {
    auth.guard(ctx.user, 'settings.manage');
    const body = ctx.body || {};
    const allowed = [
      'org.name', 'org.department', 'org.address', 'org.phone', 'org.email', 'org.website',
      'org.gstin', 'org.pan', 'org.gst_state', 'currency', 'public_base_url',
      'report.footer', 'notify.email', 'tax.default_gst_rate', 'tax.default_transport_gst_rate',
      'procurement.general_terms', 'maps.google_api_key',
    ];
    const rateKeys = ['tax.default_gst_rate', 'tax.default_transport_gst_rate'];
    for (const [key, value] of Object.entries(body)) {
      if (!allowed.includes(key)) continue;
      if (rateKeys.includes(key)) {
        const rate = Number(value);
        if (!Number.isFinite(rate) || rate < 0 || rate > 100) {
          throw new HttpError(400, 'GST rate must be between 0 and 100.');
        }
        setSetting(key, String(rate));
        continue;
      }
      setSetting(key, value);
    }
    audit(ctx, 'UPDATE', 'settings', null, null, body);
    return { ok: true };
  });

  /* ---------------------------------------------------------------- */
  /* Audit trail                                                       */
  /* ---------------------------------------------------------------- */
  router.get('/api/audit', async (ctx) => {
    auth.guard(ctx.user, 'audit.view');
    const { search = '', action = '', entityType = '', from = '', to = '', page = '1', pageSize = '50' } = ctx.query;
    let where = ' WHERE 1=1';
    const params = [];
    if (search) {
      where += ' AND (a.action LIKE ? OR a.entity_type LIKE ? OR u.name LIKE ?)';
      const like = `%${search}%`;
      params.push(like, like, like);
    }
    if (action) {
      where += ' AND a.action = ?';
      params.push(action);
    }
    if (entityType) {
      where += ' AND a.entity_type = ?';
      params.push(entityType);
    }
    if (from) {
      where += ' AND a.created_at >= ?';
      params.push(from + 'T00:00:00.000Z');
    }
    if (to) {
      where += ' AND a.created_at <= ?';
      params.push(to + 'T23:59:59.999Z');
    }
    const total = ctx.db
      .prepare(`SELECT COUNT(*) AS c FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id ${where}`)
      .get(...params).c;
    const limit = Math.min(Number(pageSize) || 50, 200);
    const offset = ((Number(page) || 1) - 1) * limit;
    const logs = ctx.db
      .prepare(
        `SELECT a.*, u.name AS user_name, u.designation AS user_designation
           FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id
           ${where} ORDER BY a.id DESC LIMIT ? OFFSET ?`
      )
      .all(...params, limit, offset);
    return {
      total,
      page: Number(page) || 1,
      pageSize: limit,
      logs: logs.map((l) => ({
        ...l,
        old_value: l.old_value ? JSON.parse(l.old_value) : null,
        new_value: l.new_value ? JSON.parse(l.new_value) : null,
      })),
    };
  });

  /* ---------------------------------------------------------------- */
  /* Lookup lists                                                      */
  /* ---------------------------------------------------------------- */
  router.post('/api/meta/departments', async (ctx) => {
    auth.guard(ctx.user, 'settings.manage');
    const { name, code } = ctx.body || {};
    if (!name || !String(name).trim()) throw new HttpError(400, 'Department name is required.');
    const cleanName = String(name).trim();
    const cleanCode = uniqueDeptCode(ctx.db, code || cleanName);
    try {
      const res = ctx.db
        .prepare('INSERT INTO departments(name, code) VALUES (?, ?)')
        .run(cleanName, cleanCode);
      const id = Number(res.lastInsertRowid);
      audit(ctx, 'CREATE', 'department', id, null, { name: cleanName, code: cleanCode });
      return { id, code: cleanCode };
    } catch {
      throw new HttpError(409, 'Department name or code already exists.');
    }
  });

  router.put('/api/meta/departments/:id', async (ctx) => {
    auth.guard(ctx.user, 'settings.manage');
    const id = Number(ctx.params.id);
    const dept = ctx.db.prepare('SELECT * FROM departments WHERE id = ?').get(id);
    if (!dept) throw new HttpError(404, 'Department not found.');
    const { name, code, active } = ctx.body || {};
    const cleanName = name === undefined ? dept.name : String(name).trim();
    if (!cleanName) throw new HttpError(400, 'Department name is required.');
    const cleanCode = uniqueDeptCode(ctx.db, code === undefined ? dept.code : code, id);
    const cleanActive = active === undefined ? dept.active : (active ? 1 : 0);
    if (!cleanActive && dept.active) {
      const inUse = inUseMessage(ctx.db, 'department', id);
      if (inUse) throw new HttpError(409, inUse);
    }
    try {
      ctx.db
        .prepare('UPDATE departments SET name = ?, code = ?, active = ? WHERE id = ?')
        .run(cleanName, cleanCode, cleanActive, id);
      audit(ctx, 'UPDATE', 'department', id,
        { name: dept.name, code: dept.code, active: dept.active },
        { name: cleanName, code: cleanCode, active: cleanActive });
      return { id, name: cleanName, code: cleanCode, active: cleanActive };
    } catch {
      throw new HttpError(409, 'Department name or code already exists.');
    }
  });

  router.delete('/api/meta/departments/:id', async (ctx) => {
    auth.guard(ctx.user, 'settings.manage');
    const id = Number(ctx.params.id);
    const dept = ctx.db.prepare('SELECT * FROM departments WHERE id = ?').get(id);
    if (!dept) throw new HttpError(404, 'Department not found.');
    const inUse = inUseMessage(ctx.db, 'department', id);
    if (inUse) throw new HttpError(409, inUse);
    // Check if any bills use this department
    const billCount = ctx.db.prepare('SELECT COUNT(*) AS c FROM bills WHERE department_id = ?').get(id).c;
    if (billCount > 0) {
      // Soft delete: just deactivate
      ctx.db.prepare('UPDATE departments SET active = 0 WHERE id = ?').run(id);
      audit(ctx, 'DEACTIVATE', 'department', id, { name: dept.name }, { active: 0 });
      return { ok: true, deactivated: true, message: 'Department deactivated (used by ' + billCount + ' bill(s)).' };
    }
    ctx.db.prepare('DELETE FROM departments WHERE id = ?').run(id);
    audit(ctx, 'DELETE', 'department', id, { name: dept.name }, null);
    return { ok: true, deleted: true };
  });

  router.post('/api/meta/categories', async (ctx) => {
    if (
      !auth.can(ctx.user, 'settings.manage') && !auth.can(ctx.user, 'bill.create') &&
      !auth.can(ctx.user, 'invoice.manage')
    ) {
      throw new HttpError(403, 'You do not have permission to perform this action.');
    }
    const b = ctx.body || {};
    const name = b.name;
    if (!name) throw new HttpError(400, 'Category name is required.');
    try {
      const res = ctx.db
        .prepare('INSERT INTO categories(code, name, parent_id, requires_admin_pastor) VALUES (?,?,?,?)')
        .run(b.code || null, String(name).trim(), b.parentId ? Number(b.parentId) : null, b.requiresAdminPastor ? 1 : 0);
      audit(ctx, 'CREATE', 'category', Number(res.lastInsertRowid), null, {
        name: String(name).trim(),
        requiresAdminPastor: !!b.requiresAdminPastor,
      });
      return { id: Number(res.lastInsertRowid) };
    } catch {
      throw new HttpError(409, 'Category already exists.');
    }
  });

  router.put('/api/meta/categories/:id', async (ctx) => {
    if (!auth.can(ctx.user, 'settings.manage') && !auth.can(ctx.user, 'bill.create')) {
      throw new HttpError(403, 'You do not have permission to perform this action.');
    }
    const id = Number(ctx.params.id);
    const cat = ctx.db.prepare('SELECT * FROM categories WHERE id = ?').get(id);
    if (!cat) throw new HttpError(404, 'Category not found.');
    const b = ctx.body || {};
    const name = b.name !== undefined ? String(b.name).trim() : cat.name;
    if (!name) throw new HttpError(400, 'Category name is required.');
    const requiresAdminPastor = b.requiresAdminPastor !== undefined
      ? (b.requiresAdminPastor ? 1 : 0)
      : (cat.requires_admin_pastor ? 1 : 0);
    ctx.db
      .prepare('UPDATE categories SET name = ?, requires_admin_pastor = ? WHERE id = ?')
      .run(name, requiresAdminPastor, id);
    audit(ctx, 'UPDATE', 'category', id, {
      name: cat.name,
      requiresAdminPastor: !!cat.requires_admin_pastor,
    }, {
      name,
      requiresAdminPastor: !!requiresAdminPastor,
    });
    return { ok: true, requiresAdminPastor: !!requiresAdminPastor };
  });

  router.delete('/api/meta/categories/:id', async (ctx) => {
    auth.guard(ctx.user, 'settings.manage');
    const id = Number(ctx.params.id);
    const cat = ctx.db.prepare('SELECT * FROM categories WHERE id = ?').get(id);
    if (!cat) throw new HttpError(404, 'Category not found.');
    const billCount = ctx.db.prepare('SELECT COUNT(*) AS c FROM bills WHERE category_id = ?').get(id).c;
    if (billCount > 0) {
      ctx.db.prepare('UPDATE categories SET active = 0 WHERE id = ?').run(id);
      audit(ctx, 'DEACTIVATE', 'category', id, { name: cat.name }, { active: 0 });
      return { ok: true, deactivated: true, message: 'Category deactivated (used by ' + billCount + ' bill(s)).' };
    }
    // Delete sub-categories first
    ctx.db.prepare('DELETE FROM categories WHERE parent_id = ?').run(id);
    ctx.db.prepare('DELETE FROM categories WHERE id = ?').run(id);
    audit(ctx, 'DELETE', 'category', id, { name: cat.name }, null);
    return { ok: true, deleted: true };
  });

  /* ---------------------------------------------------------------- */
  /* Notifications                                                     */
  /* ---------------------------------------------------------------- */
  router.get('/api/notifications', async (ctx) => {
    const rows = ctx.db
      .prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 50')
      .all(ctx.user.id);
    return {
      notifications: rows,
      unread: rows.filter((r) => !r.is_read).length,
    };
  });

  router.post('/api/notifications/read-all', async (ctx) => {
    ctx.db.prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ?').run(ctx.user.id);
    return { ok: true };
  });

  router.post('/api/notifications/:id/read', async (ctx) => {
    ctx.db
      .prepare('UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?')
      .run(Number(ctx.params.id), ctx.user.id);
    return { ok: true };
  });
};
