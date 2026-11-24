'use strict';

/**
 * Procurement master data API — Phase 0b.
 *
 * Organization hierarchy, employee master, stores/bins and vendor evaluation.
 * Additive only: new tables created by server/procurement/schema.js and new
 * endpoints under /api/procurement. Existing ABMDAS modules are untouched.
 */

const auth = require('../auth');
const { inUseMessage } = require('../shared-masters');
const { HttpError } = require('../http');
const {
  audit, nowIso, nextEmployeeCode, badRequest, round2,
} = require('../util');

const STORE_TYPES = ['main', 'sub', 'transit'];
const EMPLOYEE_STATUSES = ['Active', 'Inactive'];

/* ------------------------------------------------------------------ */
/* Shared helpers                                                      */
/* ------------------------------------------------------------------ */
function unitScope(ctx) {
  const ids = [...new Set((ctx.unitIds || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  if (!ids.length) throw new HttpError(403, 'You do not have access to any unit.');
  return ids;
}

function inList(ids) {
  return ids.map(() => '?').join(',');
}

/* Employees follow the same multi-unit model as users: employee_units holds
   the assignments while employees.unit_id stays as the home/default unit. */
function visibleEmployeeClause(ids) {
  const list = ids.join(',');
  return `(EXISTS (SELECT 1 FROM employee_units eu WHERE eu.employee_id = e.id AND eu.unit_id IN (${list}))
           OR (NOT EXISTS (SELECT 1 FROM employee_units eu WHERE eu.employee_id = e.id) AND e.unit_id IN (${list})))`;
}

function activeUnitCount(db) {
  return Number(db.prepare('SELECT COUNT(*) AS c FROM units WHERE active = 1').get().c || 0);
}

function saveEmployeeUnits(db, employeeId, unitIds) {
  if (!unitIds) return;
  db.prepare('DELETE FROM employee_units WHERE employee_id = ?').run(employeeId);
  const insert = db.prepare('INSERT OR IGNORE INTO employee_units(employee_id, unit_id) VALUES (?,?)');
  for (const unitId of unitIds) insert.run(employeeId, unitId);
}

function requireText(body, field, label, max = 200) {
  const value = String(body[field] || '').trim();
  if (!value) throw badRequest(`${label} is required.`);
  if (value.length > max) throw badRequest(`${label} is too long.`);
  return value;
}

function optionalText(body, field, max = 500) {
  return String(body[field] || '').trim().slice(0, max);
}

function optionalId(body, field) {
  if (body[field] === undefined || body[field] === null || body[field] === '') return null;
  const n = Number(body[field]);
  if (!Number.isInteger(n) || n <= 0) throw badRequest(`${field} is invalid.`);
  return n;
}

function activeFlag(body) {
  if (body.active === false) return 0;
  if (body.active === true) return 1;
  return String(body.status || 'active').toLowerCase() === 'inactive' ? 0 : 1;
}

function ensureUnit(ctx, unitId) {
  const ids = unitScope(ctx);
  if (!ids.includes(Number(unitId))) throw new HttpError(403, 'You are not a member of the selected unit.');
  return Number(unitId);
}

/* Access checks walk up the hierarchy so a record can only be reached     */
/* through a branch belonging to one of the caller's units.                */
function getBranch(ctx, id) {
  const ids = unitScope(ctx);
  const row = ctx.db
    .prepare(
      `SELECT b.*, u.name AS unit_name FROM branches b JOIN units u ON u.id = b.unit_id
        WHERE b.id = ? AND b.deleted_at IS NULL AND b.unit_id IN (${inList(ids)})`
    )
    .get(Number(id), ...ids);
  if (!row) throw new HttpError(404, 'Branch not found.');
  return row;
}

function getCampus(ctx, id) {
  const ids = unitScope(ctx);
  const row = ctx.db
    .prepare(
      `SELECT c.*, b.name AS branch_name, b.unit_id
         FROM campuses c JOIN branches b ON b.id = c.branch_id
        WHERE c.id = ? AND c.deleted_at IS NULL AND b.deleted_at IS NULL AND b.unit_id IN (${inList(ids)})`
    )
    .get(Number(id), ...ids);
  if (!row) throw new HttpError(404, 'Campus not found.');
  return row;
}

function getBuilding(ctx, id) {
  const ids = unitScope(ctx);
  const row = ctx.db
    .prepare(
      `SELECT bd.*, c.name AS campus_name, c.branch_id, b.unit_id
         FROM buildings bd
         JOIN campuses c ON c.id = bd.campus_id
         JOIN branches b ON b.id = c.branch_id
        WHERE bd.id = ? AND bd.deleted_at IS NULL AND c.deleted_at IS NULL AND b.deleted_at IS NULL
          AND b.unit_id IN (${inList(ids)})`
    )
    .get(Number(id), ...ids);
  if (!row) throw new HttpError(404, 'Building not found.');
  return row;
}

function getFloor(ctx, id) {
  const ids = unitScope(ctx);
  const row = ctx.db
    .prepare(
      `SELECT f.*, bd.name AS building_name, bd.campus_id, c.branch_id, b.unit_id
         FROM floors f
         JOIN buildings bd ON bd.id = f.building_id
         JOIN campuses c ON c.id = bd.campus_id
         JOIN branches b ON b.id = c.branch_id
        WHERE f.id = ? AND f.deleted_at IS NULL AND bd.deleted_at IS NULL
          AND c.deleted_at IS NULL AND b.deleted_at IS NULL AND b.unit_id IN (${inList(ids)})`
    )
    .get(Number(id), ...ids);
  if (!row) throw new HttpError(404, 'Floor not found.');
  return row;
}

function getRoom(ctx, id) {
  const ids = unitScope(ctx);
  const row = ctx.db
    .prepare(
      `SELECT r.*, f.name AS floor_name, f.building_id, bd.campus_id, c.branch_id, b.unit_id
         FROM rooms r
         JOIN floors f ON f.id = r.floor_id
         JOIN buildings bd ON bd.id = f.building_id
         JOIN campuses c ON c.id = bd.campus_id
         JOIN branches b ON b.id = c.branch_id
        WHERE r.id = ? AND r.deleted_at IS NULL AND f.deleted_at IS NULL
          AND bd.deleted_at IS NULL AND c.deleted_at IS NULL AND b.deleted_at IS NULL
          AND b.unit_id IN (${inList(ids)})`
    )
    .get(Number(id), ...ids);
  if (!row) throw new HttpError(404, 'Room not found.');
  return row;
}

function getCostCenter(ctx, id) {
  const ids = unitScope(ctx);
  const row = ctx.db
    .prepare(
      `SELECT cc.*, u.name AS unit_name FROM cost_centers cc JOIN units u ON u.id = cc.unit_id
        WHERE cc.id = ? AND cc.deleted_at IS NULL AND cc.unit_id IN (${inList(ids)})`
    )
    .get(Number(id), ...ids);
  if (!row) throw new HttpError(404, 'Cost centre not found.');
  return row;
}

function ensureCodeUnique(ctx, table, code, id, extraWhere = '', extraParams = []) {
  let sql = `SELECT id FROM ${table} WHERE code = ? COLLATE NOCASE`;
  const params = [code];
  if (extraWhere) {
    sql += ` AND ${extraWhere}`;
    params.push(...extraParams);
  }
  if (id) {
    sql += ' AND id <> ?';
    params.push(Number(id));
  }
  const dup = ctx.db.prepare(sql).get(...params);
  if (dup) throw new HttpError(409, 'A record with this code already exists.');
}

/* ------------------------------------------------------------------ */
/* Organization configuration                                          */
/* ------------------------------------------------------------------ */
const ORG_LEVELS = [
  {
    key: 'branches',
    table: 'branches',
    entity: 'branch',
    columns: ['unit_id', 'code', 'name', 'address', 'active'],
    access: getBranch,
    child: { table: 'campuses', column: 'branch_id', label: 'campuses' },
    validate(ctx, body, existing) {
      const unitId = ensureUnit(ctx, body.unitId ?? existing?.unit_id);
      const code = requireText(body, 'code', 'Branch code', 40);
      const name = requireText(body, 'name', 'Branch name', 160);
      ensureCodeUnique(ctx, 'branches', code, existing?.id);
      return { unitId, code, name, address: optionalText(body, 'address'), active: activeFlag(body) };
    },
    values(d) {
      return [d.unitId, d.code, d.name, d.address, d.active];
    },
  },
  {
    key: 'campuses',
    table: 'campuses',
    entity: 'campus',
    columns: ['branch_id', 'code', 'name', 'address', 'active'],
    access: getCampus,
    child: { table: 'buildings', column: 'campus_id', label: 'buildings' },
    validate(ctx, body, existing) {
      const branchId = Number(body.branchId ?? existing?.branch_id);
      getBranch(ctx, branchId);
      const code = requireText(body, 'code', 'Campus code', 40);
      const name = requireText(body, 'name', 'Campus name', 160);
      ensureCodeUnique(ctx, 'campuses', code, existing?.id);
      return { branchId, code, name, address: optionalText(body, 'address'), active: activeFlag(body) };
    },
    values(d) {
      return [d.branchId, d.code, d.name, d.address, d.active];
    },
  },
  {
    key: 'buildings',
    table: 'buildings',
    entity: 'building',
    columns: ['campus_id', 'code', 'name', 'active'],
    access: getBuilding,
    child: { table: 'floors', column: 'building_id', label: 'floors' },
    validate(ctx, body, existing) {
      const campusId = Number(body.campusId ?? existing?.campus_id);
      getCampus(ctx, campusId);
      const code = requireText(body, 'code', 'Building code', 40);
      const name = requireText(body, 'name', 'Building name', 160);
      ensureCodeUnique(ctx, 'buildings', code, existing?.id);
      return { campusId, code, name, active: activeFlag(body) };
    },
    values(d) {
      return [d.campusId, d.code, d.name, d.active];
    },
  },
  {
    key: 'floors',
    table: 'floors',
    entity: 'floor',
    columns: ['building_id', 'code', 'name', 'active'],
    access: getFloor,
    child: { table: 'rooms', column: 'floor_id', label: 'rooms' },
    validate(ctx, body, existing) {
      const buildingId = Number(body.buildingId ?? existing?.building_id);
      getBuilding(ctx, buildingId);
      const code = requireText(body, 'code', 'Floor code', 40);
      const name = requireText(body, 'name', 'Floor name', 160);
      ensureCodeUnique(ctx, 'floors', code, existing?.id, 'building_id = ?', [buildingId]);
      return { buildingId, code, name, active: activeFlag(body) };
    },
    values(d) {
      return [d.buildingId, d.code, d.name, d.active];
    },
  },
  {
    key: 'rooms',
    table: 'rooms',
    entity: 'room',
    columns: ['floor_id', 'code', 'name', 'room_type', 'active'],
    access: getRoom,
    child: null,
    validate(ctx, body, existing) {
      const floorId = Number(body.floorId ?? existing?.floor_id);
      getFloor(ctx, floorId);
      const code = requireText(body, 'code', 'Room code', 40);
      const name = requireText(body, 'name', 'Room name', 160);
      ensureCodeUnique(ctx, 'rooms', code, existing?.id, 'floor_id = ?', [floorId]);
      return {
        floorId, code, name,
        roomType: optionalText(body, 'roomType', 80),
        active: activeFlag(body),
      };
    },
    values(d) {
      return [d.floorId, d.code, d.name, d.roomType, d.active];
    },
  },
  {
    key: 'cost-centers',
    table: 'cost_centers',
    entity: 'cost_center',
    columns: ['unit_id', 'code', 'name', 'active'],
    access: getCostCenter,
    child: null,
    validate(ctx, body, existing) {
      const unitId = ensureUnit(ctx, body.unitId ?? existing?.unit_id);
      const code = requireText(body, 'code', 'Cost centre code', 40);
      const name = requireText(body, 'name', 'Cost centre name', 160);
      ensureCodeUnique(ctx, 'cost_centers', code, existing?.id);
      return { unitId, code, name, active: activeFlag(body) };
    },
    values(d) {
      return [d.unitId, d.code, d.name, d.active];
    },
  },
];

function registerOrgLevel(router, cfg) {
  const base = `/api/procurement/org/${cfg.key}`;

  router.post(base, async (ctx) => {
    auth.guard(ctx.user, 'org.manage');
    const data = cfg.validate(ctx, ctx.body || {});
    const now = nowIso();
    const res = ctx.db
      .prepare(
        `INSERT INTO ${cfg.table}(${cfg.columns.join(',')}, created_at, updated_at)
         VALUES (${cfg.columns.map(() => '?').join(',')}, ?, ?)`
      )
      .run(...cfg.values(data), now, now);
    const id = Number(res.lastInsertRowid);
    audit(ctx, 'CREATE', cfg.entity, id, null, { code: data.code, name: data.name });
    return { id, code: data.code };
  });

  router.put(`${base}/:id`, async (ctx) => {
    auth.guard(ctx.user, 'org.manage');
    const existing = cfg.access(ctx, ctx.params.id);
    const data = cfg.validate(ctx, ctx.body || {}, existing);
    ctx.db
      .prepare(
        `UPDATE ${cfg.table} SET ${cfg.columns.map((c) => `${c} = ?`).join(', ')}, updated_at = ?
          WHERE id = ?`
      )
      .run(...cfg.values(data), nowIso(), existing.id);
    audit(ctx, 'UPDATE', cfg.entity, existing.id, { code: existing.code, name: existing.name }, {
      code: data.code, name: data.name, active: !!data.active,
    });
    return { ok: true };
  });

  router.delete(`${base}/:id`, async (ctx) => {
    auth.guard(ctx.user, 'org.manage');
    const existing = cfg.access(ctx, ctx.params.id);
    if (cfg.child) {
      const count = ctx.db
        .prepare(`SELECT COUNT(*) AS c FROM ${cfg.child.table} WHERE ${cfg.child.column} = ? AND deleted_at IS NULL`)
        .get(existing.id).c;
      if (count > 0) {
        throw new HttpError(400, `Retire the ${cfg.child.label} under this record first.`);
      }
    }
    const now = nowIso();
    ctx.db
      .prepare(`UPDATE ${cfg.table} SET deleted_at = ?, deleted_by = ?, active = 0, updated_at = ? WHERE id = ?`)
      .run(now, ctx.user.id, now, existing.id);
    audit(ctx, 'DELETE', cfg.entity, existing.id, { code: existing.code, name: existing.name }, { deletedAt: now });
    return { ok: true };
  });
}

/* ------------------------------------------------------------------ */
/* Employee mapping                                                    */
/* ------------------------------------------------------------------ */
function employeeOut(row, totalUnits = 0) {
  const unitIds = row.unit_ids
    ? String(row.unit_ids).split(',').map(Number).filter((id) => Number.isInteger(id) && id > 0)
    : (row.unit_id ? [Number(row.unit_id)] : []);
  return {
    id: row.id,
    userId: row.user_id,
    employeeCode: row.employee_code,
    name: row.name,
    departmentId: row.department_id,
    departmentName: row.department_name || '',
    designation: row.designation || '',
    email: row.email || '',
    mobile: row.mobile || '',
    reportingManagerId: row.reporting_manager_id,
    reportingManagerName: row.manager_name || '',
    unitId: row.unit_id,
    unitIds,
    allUnits: totalUnits > 0 && unitIds.length >= totalUnits,
    unitName: row.unit_name || '',
    unitNames: row.unit_names || row.unit_name || '',
    username: row.username || '',
    status: row.status,
    active: row.status === 'Active',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function getEmployee(ctx, id) {
  const ids = unitScope(ctx);
  const row = ctx.db
    .prepare(
      `SELECT e.*, d.name AS department_name, m.name AS manager_name,
              u.username, un.name AS unit_name,
              (SELECT GROUP_CONCAT(eu.unit_id) FROM employee_units eu WHERE eu.employee_id = e.id) AS unit_ids,
              (SELECT GROUP_CONCAT(mu.name, ', ') FROM employee_units eu JOIN units mu ON mu.id = eu.unit_id WHERE eu.employee_id = e.id) AS unit_names
         FROM employees e
         LEFT JOIN departments d ON d.id = e.department_id
         LEFT JOIN employees m ON m.id = e.reporting_manager_id
         LEFT JOIN users u ON u.id = e.user_id
         LEFT JOIN units un ON un.id = e.unit_id
        WHERE e.id = ? AND e.deleted_at IS NULL AND ${visibleEmployeeClause(ids)}`
    )
    .get(Number(id));
  if (!row) throw new HttpError(404, 'Employee not found.');
  return row;
}

function employeeUnitIds(ctx, body, existing) {
  const scope = unitScope(ctx);
  const all = body.allUnits === true || String(body.allUnits) === 'true' || String(body.allUnits) === '1';
  if (all) return scope;
  if (body.unitIds === undefined && body.unitId === undefined && existing) return null;
  let raw = body.unitIds;
  if (raw === undefined) raw = [body.unitId];
  if (!Array.isArray(raw)) raw = [raw];
  const ids = [...new Set(raw.map(Number).filter((id) => Number.isInteger(id) && id > 0))];
  if (!ids.length) throw badRequest('Select at least one unit.');
  for (const id of ids) {
    if (!scope.includes(id)) throw new HttpError(403, 'You are not a member of the selected unit.');
  }
  return ids;
}

function employeePayload(ctx, body, existing) {
  const name = requireText(body, 'name', 'Employee name', 160);
  const unitIds = employeeUnitIds(ctx, body, existing);
  const unitId = unitIds ? unitIds[0] : (existing ? existing.unit_id : null);
  const departmentId = optionalId(body, 'departmentId');
  if (departmentId) {
    const dept = ctx.db.prepare('SELECT id FROM departments WHERE id = ?').get(departmentId);
    if (!dept) throw badRequest('Department was not found.');
  }
  const managerId = optionalId(body, 'reportingManagerId');
  if (managerId) {
    if (existing && managerId === existing.id) throw badRequest('An employee cannot report to themselves.');
    getEmployee(ctx, managerId);
  }
  const userId = optionalId(body, 'userId');
  if (userId) {
    const user = ctx.db.prepare("SELECT id FROM users WHERE id = ? AND status = 'Active'").get(userId);
    if (!user) throw badRequest('User account was not found.');
    const linked = ctx.db
      .prepare('SELECT id FROM employees WHERE user_id = ? AND id <> ?')
      .get(userId, existing?.id || 0);
    if (linked) throw new HttpError(409, 'That user account is already linked to another employee.');
  }
  const status = String(body.status || existing?.status || 'Active');
  if (!EMPLOYEE_STATUSES.includes(status)) throw badRequest('Employee status must be Active or Inactive.');
  const email = optionalText(body, 'email', 160);
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw badRequest('Email address is invalid.');
  return {
    employeeCode: optionalText(body, 'employeeCode', 40) || null,
    name,
    departmentId,
    designation: optionalText(body, 'designation', 120),
    email,
    mobile: optionalText(body, 'mobile', 40),
    managerId,
    unitId,
    unitIds,
    userId,
    status,
  };
}

/* ------------------------------------------------------------------ */
/* Store mapping                                                       */
/* ------------------------------------------------------------------ */
const STORE_CONTACT_FIELDS = [
  ['addressLine1', 'address_line1'],
  ['addressLine2', 'address_line2'],
  ['city', 'city'],
  ['state', 'state'],
  ['pincode', 'pincode'],
  ['inchargeName', 'incharge_name'],
  ['inchargeDesignation', 'incharge_designation'],
  ['inchargeMobile', 'incharge_mobile'],
  ['inchargeEmail', 'incharge_email'],
];

function storeFieldsFromBody(body, existing) {
  const out = {};
  for (const [camel, snake] of STORE_CONTACT_FIELDS) {
    const source = body[camel] !== undefined ? body[camel] : body[snake];
    out[camel] = source === undefined || source === null
      ? (existing ? String(existing[snake] || '') : '')
      : String(source).trim().slice(0, 200);
  }
  return out;
}

function storeFieldsFromRow(row) {
  const out = {};
  for (const [camel, snake] of STORE_CONTACT_FIELDS) out[camel] = String(row[snake] || '');
  return out;
}

function storeOut(row) {
  return {
    id: row.id,
    unitId: row.unit_id,
    unitName: row.unit_name || '',
    code: row.code,
    name: row.name,
    storeType: row.store_type,
    active: !!row.active,
    ...storeFieldsFromRow(row),
    bins: [],
    createdAt: row.created_at,
  };
}

function getStore(ctx, id) {
  const ids = unitScope(ctx);
  const row = ctx.db
    .prepare(
      `SELECT s.*, u.name AS unit_name FROM stores s JOIN units u ON u.id = s.unit_id
        WHERE s.id = ? AND s.deleted_at IS NULL AND s.unit_id IN (${inList(ids)})`
    )
    .get(Number(id), ...ids);
  if (!row) throw new HttpError(404, 'Store not found.');
  return row;
}

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */
module.exports = function registerProcurementMasterRoutes(router) {
  /* ---------------------------- Organization ---------------------- */
  router.get('/api/procurement/org', async (ctx) => {
    auth.guard(ctx.user, 'org.view');
    const ids = unitScope(ctx);
    const ph = inList(ids);

    const units = ctx.db
      .prepare(`SELECT id, code, name FROM units WHERE id IN (${ph}) ORDER BY name`)
      .all(...ids);

    const branches = ctx.db
      .prepare(
        `SELECT b.*, u.name AS unit_name FROM branches b JOIN units u ON u.id = b.unit_id
          WHERE b.deleted_at IS NULL AND b.unit_id IN (${ph}) ORDER BY b.name`
      )
      .all(...ids)
      .map((r) => ({
        id: r.id, unitId: r.unit_id, unitName: r.unit_name,
        code: r.code, name: r.name, address: r.address || '', active: !!r.active,
      }));

    const campuses = ctx.db
      .prepare(
        `SELECT c.*, b.name AS branch_name FROM campuses c JOIN branches b ON b.id = c.branch_id
          WHERE c.deleted_at IS NULL AND b.deleted_at IS NULL AND b.unit_id IN (${ph}) ORDER BY c.name`
      )
      .all(...ids)
      .map((r) => ({
        id: r.id, branchId: r.branch_id, branchName: r.branch_name,
        code: r.code, name: r.name, address: r.address || '', active: !!r.active,
      }));

    const buildings = ctx.db
      .prepare(
        `SELECT bd.*, c.name AS campus_name, b.name AS branch_name
           FROM buildings bd
           JOIN campuses c ON c.id = bd.campus_id
           JOIN branches b ON b.id = c.branch_id
          WHERE bd.deleted_at IS NULL AND c.deleted_at IS NULL AND b.deleted_at IS NULL
            AND b.unit_id IN (${ph}) ORDER BY bd.name`
      )
      .all(...ids)
      .map((r) => ({
        id: r.id, campusId: r.campus_id, campusName: r.campus_name, branchName: r.branch_name,
        code: r.code, name: r.name, active: !!r.active,
      }));

    const floors = ctx.db
      .prepare(
        `SELECT f.*, bd.name AS building_name, c.name AS campus_name
           FROM floors f
           JOIN buildings bd ON bd.id = f.building_id
           JOIN campuses c ON c.id = bd.campus_id
           JOIN branches b ON b.id = c.branch_id
          WHERE f.deleted_at IS NULL AND bd.deleted_at IS NULL AND c.deleted_at IS NULL
            AND b.deleted_at IS NULL AND b.unit_id IN (${ph}) ORDER BY f.name`
      )
      .all(...ids)
      .map((r) => ({
        id: r.id, buildingId: r.building_id, buildingName: r.building_name, campusName: r.campus_name,
        code: r.code, name: r.name, active: !!r.active,
      }));

    const rooms = ctx.db
      .prepare(
        `SELECT r.*, f.name AS floor_name, bd.name AS building_name
           FROM rooms r
           JOIN floors f ON f.id = r.floor_id
           JOIN buildings bd ON bd.id = f.building_id
           JOIN campuses c ON c.id = bd.campus_id
           JOIN branches b ON b.id = c.branch_id
          WHERE r.deleted_at IS NULL AND f.deleted_at IS NULL AND bd.deleted_at IS NULL
            AND c.deleted_at IS NULL AND b.deleted_at IS NULL AND b.unit_id IN (${ph})
          ORDER BY r.name`
      )
      .all(...ids)
      .map((r) => ({
        id: r.id, floorId: r.floor_id, floorName: r.floor_name, buildingName: r.building_name,
        code: r.code, name: r.name, roomType: r.room_type || '', active: !!r.active,
      }));

    const costCenters = ctx.db
      .prepare(
        `SELECT cc.*, u.name AS unit_name FROM cost_centers cc JOIN units u ON u.id = cc.unit_id
          WHERE cc.deleted_at IS NULL AND cc.unit_id IN (${ph}) ORDER BY cc.name`
      )
      .all(...ids)
      .map((r) => ({
        id: r.id, unitId: r.unit_id, unitName: r.unit_name,
        code: r.code, name: r.name, active: !!r.active,
      }));

    return { units, branches, campuses, buildings, floors, rooms, costCenters };
  });

  for (const cfg of ORG_LEVELS) registerOrgLevel(router, cfg);

  /* ------------------------------ Employees ----------------------- */
  router.get('/api/procurement/employees/meta', async (ctx) => {
    auth.guard(ctx.user, 'employee.view');
    const ids = unitScope(ctx);
    return {
      units: ctx.db.prepare(`SELECT id, code, name FROM units WHERE id IN (${inList(ids)}) ORDER BY name`).all(...ids),
      departments: ctx.db.prepare('SELECT id, name, active FROM departments ORDER BY name').all(),
      managers: ctx.db
        .prepare(
          `SELECT id, employee_code, name FROM employees e
            WHERE deleted_at IS NULL AND status = 'Active' AND ${visibleEmployeeClause(ids)}
            ORDER BY name`
        )
        .all(),
      users: ctx.db
        .prepare(
          `SELECT u.id, u.name, u.username, r.name AS role_name, e.id AS linked_employee_id
             FROM users u JOIN roles r ON r.id = u.role_id
             LEFT JOIN employees e ON e.user_id = u.id
            WHERE u.status = 'Active' ORDER BY u.name`
        )
        .all(),
    };
  });

  router.get('/api/procurement/employees', async (ctx) => {
    auth.guard(ctx.user, 'employee.view');
    const ids = unitScope(ctx);
    const q = ctx.query || {};
    const where = ['e.deleted_at IS NULL', visibleEmployeeClause(ids)];
    const params = [];

    if (q.search) {
      where.push('(e.employee_code LIKE ? OR e.name LIKE ? OR e.designation LIKE ? OR e.email LIKE ? OR e.mobile LIKE ?)');
      const like = `%${String(q.search).trim()}%`;
      params.push(like, like, like, like, like);
    }
    if (q.department) {
      where.push('e.department_id = ?');
      params.push(Number(q.department));
    }
    if (q.status === 'active') where.push("e.status = 'Active'");
    if (q.status === 'inactive') where.push("e.status = 'Inactive'");

    const rows = ctx.db
      .prepare(
        `SELECT e.*, d.name AS department_name, m.name AS manager_name,
                u.username, un.name AS unit_name,
                (SELECT GROUP_CONCAT(eu.unit_id) FROM employee_units eu WHERE eu.employee_id = e.id) AS unit_ids,
                (SELECT GROUP_CONCAT(mu.name, ', ') FROM employee_units eu JOIN units mu ON mu.id = eu.unit_id WHERE eu.employee_id = e.id) AS unit_names
           FROM employees e
           LEFT JOIN departments d ON d.id = e.department_id
           LEFT JOIN employees m ON m.id = e.reporting_manager_id
           LEFT JOIN users u ON u.id = e.user_id
           LEFT JOIN units un ON un.id = e.unit_id
          WHERE ${where.join(' AND ')}
          ORDER BY e.name COLLATE NOCASE`
      )
      .all(...params);

    const totalUnits = activeUnitCount(ctx.db);
    return { employees: rows.map((row) => employeeOut(row, totalUnits)) };
  });

  router.get('/api/procurement/employees/:id', async (ctx) => {
    auth.guard(ctx.user, 'employee.view');
    return { employee: employeeOut(getEmployee(ctx, ctx.params.id), activeUnitCount(ctx.db)) };
  });

  /* A driving qualification is an additive profile on the common employee
     master. Fleet Desk reads the same rows instead of keeping a driver master. */
  router.get('/api/procurement/employees/:id/driver-profile', async (ctx) => {
    auth.guard(ctx.user, 'employee.view');
    const employee = getEmployee(ctx, ctx.params.id);
    const row = ctx.db
      .prepare('SELECT * FROM employee_driver_profiles WHERE employee_id = ?')
      .get(employee.id);
    return {
      driverProfile: {
        isDriver: !!row && !!row.active,
        licenseNo: row ? row.license_no || '' : '',
        licenseExpiry: row ? row.license_expiry || '' : '',
      },
    };
  });

  router.put('/api/procurement/employees/:id/driver-profile', async (ctx) => {
    auth.guard(ctx.user, 'employee.manage');
    const employee = getEmployee(ctx, ctx.params.id);
    const b = ctx.body || {};
    const isDriver = !!b.isDriver;
    const licenseNo = String(b.licenseNo || '').trim().slice(0, 60);
    const licenseExpiry = String(b.licenseExpiry || '').trim().slice(0, 10);
    if (isDriver && !licenseNo) throw badRequest('Licence number is required when an employee is marked as a driver.');
    const now = nowIso();
    ctx.db
      .prepare(
        `INSERT INTO employee_driver_profiles(employee_id, license_no, license_expiry, active, created_at, updated_at)
         VALUES (?,?,?,?,?,?)
         ON CONFLICT(employee_id) DO UPDATE SET
           license_no = excluded.license_no,
           license_expiry = excluded.license_expiry,
           active = excluded.active,
           updated_at = excluded.updated_at`
      )
      .run(employee.id, licenseNo, licenseExpiry || null, isDriver ? 1 : 0, now, now);
    audit(
      ctx, 'UPDATE', 'employee_driver_profile', employee.id,
      null, { isDriver, licenseNo, licenseExpiry }
    );
    return { ok: true };
  });

  router.post('/api/procurement/employees', async (ctx) => {
    auth.guard(ctx.user, 'employee.manage');
    const data = employeePayload(ctx, ctx.body || {});
    let code = data.employeeCode;
    if (!code) {
      code = nextEmployeeCode();
      let guard = 0;
      while (ctx.db.prepare('SELECT 1 FROM employees WHERE employee_code = ?').get(code) && guard < 50) {
        code = nextEmployeeCode();
        guard += 1;
      }
    }
    const dup = ctx.db.prepare('SELECT id FROM employees WHERE employee_code = ?').get(code);
    if (dup) throw new HttpError(409, 'An employee with this code already exists.');
    const now = nowIso();
    const res = ctx.db
      .prepare(
        `INSERT INTO employees(user_id, employee_code, name, department_id, designation, email, mobile,
           reporting_manager_id, unit_id, status, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        data.userId, code, data.name, data.departmentId, data.designation, data.email, data.mobile,
        data.managerId, data.unitId, data.status, now, now
      );
    const id = Number(res.lastInsertRowid);
    saveEmployeeUnits(ctx.db, id, data.unitIds);
    audit(ctx, 'CREATE', 'employee', id, null, { employeeCode: code, name: data.name, unitIds: data.unitIds });
    return { id, employeeCode: code };
  });

  router.put('/api/procurement/employees/:id', async (ctx) => {
    auth.guard(ctx.user, 'employee.manage');
    const existing = getEmployee(ctx, ctx.params.id);
    const data = employeePayload(ctx, ctx.body || {}, existing);
    if (data.status !== existing.status) {
      const inUse = inUseMessage(ctx.db, 'employee', existing.id);
      if (inUse) throw new HttpError(409, inUse);
    }
    const code = data.employeeCode || existing.employee_code;
    if (code !== existing.employee_code) {
      const dup = ctx.db.prepare('SELECT id FROM employees WHERE employee_code = ? AND id <> ?').get(code, existing.id);
      if (dup) throw new HttpError(409, 'An employee with this code already exists.');
    }
    ctx.db
      .prepare(
        `UPDATE employees SET user_id=?, employee_code=?, name=?, department_id=?, designation=?,
           email=?, mobile=?, reporting_manager_id=?, unit_id=?, status=?, updated_at=?
         WHERE id=?`
      )
      .run(
        data.userId, code, data.name, data.departmentId, data.designation, data.email, data.mobile,
        data.managerId, data.unitId, data.status, nowIso(), existing.id
      );
    saveEmployeeUnits(ctx.db, existing.id, data.unitIds);
    audit(ctx, 'UPDATE', 'employee', existing.id, { employeeCode: existing.employee_code, name: existing.name }, {
      employeeCode: code, name: data.name, status: data.status, unitIds: data.unitIds,
    });
    return { ok: true };
  });

  router.delete('/api/procurement/employees/:id', async (ctx) => {
    auth.guard(ctx.user, 'employee.manage');
    const existing = getEmployee(ctx, ctx.params.id);
    const inUse = inUseMessage(ctx.db, 'employee', existing.id);
    if (inUse) throw new HttpError(409, inUse);
    const reports = ctx.db
      .prepare('SELECT COUNT(*) AS c FROM employees WHERE reporting_manager_id = ? AND deleted_at IS NULL')
      .get(existing.id).c;
    if (reports > 0) throw new HttpError(400, 'Reassign employees who report to this person before retiring them.');
    const now = nowIso();
    ctx.db
      .prepare('UPDATE employees SET deleted_at = ?, deleted_by = ?, status = ?, updated_at = ? WHERE id = ?')
      .run(now, ctx.user.id, 'Inactive', now, existing.id);
    audit(ctx, 'DELETE', 'employee', existing.id, { employeeCode: existing.employee_code, name: existing.name }, { deletedAt: now });
    return { ok: true };
  });

  /* ------------------------------- Stores ------------------------- */
  router.get('/api/procurement/stores/meta', async (ctx) => {
    auth.guard(ctx.user, 'store.view');
    const ids = unitScope(ctx);
    return {
      units: ctx.db.prepare(`SELECT id, code, name FROM units WHERE id IN (${inList(ids)}) ORDER BY name`).all(...ids),
      storeTypes: [
        { value: 'main', label: 'Main store' },
        { value: 'sub', label: 'Sub store' },
        { value: 'transit', label: 'Transit store' },
      ],
    };
  });

  router.get('/api/procurement/stores', async (ctx) => {
    auth.guard(ctx.user, 'store.view');
    const ids = unitScope(ctx);
    const stores = ctx.db
      .prepare(
        `SELECT s.*, u.name AS unit_name FROM stores s JOIN units u ON u.id = s.unit_id
          WHERE s.deleted_at IS NULL AND s.unit_id IN (${inList(ids)}) ORDER BY s.name`
      )
      .all(...ids)
      .map(storeOut);

    if (stores.length) {
      const bins = ctx.db
        .prepare(
          `SELECT * FROM bins WHERE deleted_at IS NULL
            AND store_id IN (${stores.map(() => '?').join(',')}) ORDER BY name`
        )
        .all(...stores.map((s) => s.id));
      for (const store of stores) {
        store.bins = bins
          .filter((b) => b.store_id === store.id)
          .map((b) => ({ id: b.id, code: b.code, name: b.name, active: !!b.active }));
      }
    }
    return { stores };
  });

  router.post('/api/procurement/stores', async (ctx) => {
    auth.guard(ctx.user, 'store.manage');
    const body = ctx.body || {};
    const unitId = ensureUnit(ctx, body.unitId);
    const code = requireText(body, 'code', 'Store code', 40);
    const name = requireText(body, 'name', 'Store name', 160);
    const storeType = String(body.storeType || 'main');
    if (!STORE_TYPES.includes(storeType)) throw badRequest('Store type is invalid.');
    ensureCodeUnique(ctx, 'stores', code, null);
    const fields = storeFieldsFromBody(body);
    const now = nowIso();
    const res = ctx.db
      .prepare(
        `INSERT INTO stores(unit_id, code, name, store_type, active,
           address_line1, address_line2, city, state, pincode,
           incharge_name, incharge_designation, incharge_mobile, incharge_email,
           created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        unitId, code, name, storeType, activeFlag(body),
        fields.addressLine1, fields.addressLine2, fields.city, fields.state, fields.pincode,
        fields.inchargeName, fields.inchargeDesignation, fields.inchargeMobile, fields.inchargeEmail,
        now, now
      );
    const id = Number(res.lastInsertRowid);
    audit(ctx, 'CREATE', 'store', id, null, { code, name, storeType, ...fields });
    return { id, code };
  });

  router.put('/api/procurement/stores/:id', async (ctx) => {
    auth.guard(ctx.user, 'store.manage');
    const existing = getStore(ctx, ctx.params.id);
    const body = ctx.body || {};
    const unitId = ensureUnit(ctx, body.unitId ?? existing.unit_id);
    const code = requireText(body, 'code', 'Store code', 40);
    const name = requireText(body, 'name', 'Store name', 160);
    const storeType = String(body.storeType || existing.store_type);
    if (!STORE_TYPES.includes(storeType)) throw badRequest('Store type is invalid.');
    ensureCodeUnique(ctx, 'stores', code, existing.id);
    const fields = storeFieldsFromBody(body, existing);
    ctx.db
      .prepare(
        `UPDATE stores SET unit_id=?, code=?, name=?, store_type=?, active=?,
           address_line1=?, address_line2=?, city=?, state=?, pincode=?,
           incharge_name=?, incharge_designation=?, incharge_mobile=?, incharge_email=?,
           updated_at=? WHERE id=?`
      )
      .run(
        unitId, code, name, storeType, activeFlag(body),
        fields.addressLine1, fields.addressLine2, fields.city, fields.state, fields.pincode,
        fields.inchargeName, fields.inchargeDesignation, fields.inchargeMobile, fields.inchargeEmail,
        nowIso(), existing.id
      );
    audit(
      ctx, 'UPDATE', 'store', existing.id,
      { code: existing.code, name: existing.name, storeType: existing.store_type, ...storeFieldsFromRow(existing) },
      { code, name, storeType, ...fields }
    );
    return { ok: true };
  });

  router.delete('/api/procurement/stores/:id', async (ctx) => {
    auth.guard(ctx.user, 'store.manage');
    const existing = getStore(ctx, ctx.params.id);
    const bins = ctx.db
      .prepare('SELECT COUNT(*) AS c FROM bins WHERE store_id = ? AND deleted_at IS NULL')
      .get(existing.id).c;
    if (bins > 0) throw new HttpError(400, 'Retire the bins under this store first.');
    const now = nowIso();
    ctx.db
      .prepare('UPDATE stores SET deleted_at = ?, deleted_by = ?, active = 0, updated_at = ? WHERE id = ?')
      .run(now, ctx.user.id, now, existing.id);
    audit(ctx, 'DELETE', 'store', existing.id, { code: existing.code, name: existing.name }, { deletedAt: now });
    return { ok: true };
  });

  router.post('/api/procurement/stores/:id/bins', async (ctx) => {
    auth.guard(ctx.user, 'store.manage');
    const store = getStore(ctx, ctx.params.id);
    const body = ctx.body || {};
    const code = requireText(body, 'code', 'Bin code', 40);
    const name = requireText(body, 'name', 'Bin name', 160);
    const dup = ctx.db
      .prepare('SELECT id FROM bins WHERE store_id = ? AND code = ? COLLATE NOCASE')
      .get(store.id, code);
    if (dup) throw new HttpError(409, 'A bin with this code already exists in this store.');
    const now = nowIso();
    const res = ctx.db
      .prepare(
        `INSERT INTO bins(store_id, code, name, active, created_at, updated_at) VALUES (?,?,?,?,?,?)`
      )
      .run(store.id, code, name, activeFlag(body), now, now);
    const id = Number(res.lastInsertRowid);
    audit(ctx, 'CREATE', 'bin', id, null, { storeId: store.id, code, name });
    return { id, code };
  });

  router.put('/api/procurement/stores/:id/bins/:binId', async (ctx) => {
    auth.guard(ctx.user, 'store.manage');
    const store = getStore(ctx, ctx.params.id);
    const bin = ctx.db
      .prepare('SELECT * FROM bins WHERE id = ? AND store_id = ? AND deleted_at IS NULL')
      .get(Number(ctx.params.binId), store.id);
    if (!bin) throw new HttpError(404, 'Bin not found.');
    const body = ctx.body || {};
    const code = requireText(body, 'code', 'Bin code', 40);
    const name = requireText(body, 'name', 'Bin name', 160);
    const dup = ctx.db
      .prepare('SELECT id FROM bins WHERE store_id = ? AND code = ? COLLATE NOCASE AND id <> ?')
      .get(store.id, code, bin.id);
    if (dup) throw new HttpError(409, 'A bin with this code already exists in this store.');
    ctx.db
      .prepare('UPDATE bins SET code=?, name=?, active=?, updated_at=? WHERE id=?')
      .run(code, name, activeFlag(body), nowIso(), bin.id);
    audit(ctx, 'UPDATE', 'bin', bin.id, { code: bin.code, name: bin.name }, { code, name });
    return { ok: true };
  });

  router.delete('/api/procurement/stores/:id/bins/:binId', async (ctx) => {
    auth.guard(ctx.user, 'store.manage');
    const store = getStore(ctx, ctx.params.id);
    const bin = ctx.db
      .prepare('SELECT * FROM bins WHERE id = ? AND store_id = ? AND deleted_at IS NULL')
      .get(Number(ctx.params.binId), store.id);
    if (!bin) throw new HttpError(404, 'Bin not found.');
    const now = nowIso();
    ctx.db
      .prepare('UPDATE bins SET deleted_at = ?, deleted_by = ?, active = 0, updated_at = ? WHERE id = ?')
      .run(now, ctx.user.id, now, bin.id);
    audit(ctx, 'DELETE', 'bin', bin.id, { code: bin.code, name: bin.name }, { deletedAt: now });
    return { ok: true };
  });

  /* --------------------------- Vendor evaluation ------------------ */
  router.get('/api/procurement/vendor-evaluations', async (ctx) => {
    auth.guard(ctx.user, 'vendor.view');
    const q = ctx.query || {};
    const where = [];
    const params = [];
    if (q.search) {
      where.push('(v.name LIKE ? OR v.code LIKE ?)');
      const like = `%${String(q.search).trim()}%`;
      params.push(like, like);
    }
    if (q.status) {
      where.push('v.status = ?');
      params.push(String(q.status));
    }
    const rows = ctx.db
      .prepare(
        `SELECT v.id, v.code, v.name, v.status,
                COUNT(e.id) AS evaluation_count,
                MAX(e.evaluated_at) AS last_evaluated_at,
                ROUND(AVG(e.delivery_rating), 2) AS delivery_rating,
                ROUND(AVG(e.quality_rating), 2) AS quality_rating,
                ROUND(AVG(e.pricing_rating), 2) AS pricing_rating,
                ROUND(AVG(e.service_rating), 2) AS service_rating
           FROM vendors v
           LEFT JOIN vendor_evaluations e ON e.vendor_id = v.id
          ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
          GROUP BY v.id
          ORDER BY v.name COLLATE NOCASE`
      )
      .all(...params);

    return {
      vendors: rows.map((r) => {
        const count = Number(r.evaluation_count) || 0;
        const overall = count
          ? round2(
              ((Number(r.delivery_rating) || 0) + (Number(r.quality_rating) || 0) +
                (Number(r.pricing_rating) || 0) + (Number(r.service_rating) || 0)) / 4
            )
          : null;
        return {
          id: r.id,
          code: r.code,
          name: r.name,
          status: r.status,
          evaluationCount: count,
          lastEvaluatedAt: r.last_evaluated_at,
          overall,
          deliveryRating: r.delivery_rating,
          qualityRating: r.quality_rating,
          pricingRating: r.pricing_rating,
          serviceRating: r.service_rating,
        };
      }),
    };
  });

  router.get('/api/procurement/vendor-evaluations/:vendorId/history', async (ctx) => {
    auth.guard(ctx.user, 'vendor.view');
    const vendorId = Number(ctx.params.vendorId);
    const vendor = ctx.db.prepare('SELECT id, code, name FROM vendors WHERE id = ?').get(vendorId);
    if (!vendor) throw new HttpError(404, 'Vendor not found.');
    const evaluations = ctx.db
      .prepare(
        `SELECT e.*, u.name AS evaluated_by_name
           FROM vendor_evaluations e
           LEFT JOIN users u ON u.id = e.evaluated_by
          WHERE e.vendor_id = ?
          ORDER BY e.evaluated_at DESC`
      )
      .all(vendorId)
      .map((e) => ({
        id: e.id,
        deliveryRating: e.delivery_rating,
        qualityRating: e.quality_rating,
        pricingRating: e.pricing_rating,
        serviceRating: e.service_rating,
        comments: e.comments || '',
        evaluatedByName: e.evaluated_by_name || '',
        evaluatedAt: e.evaluated_at,
      }));
    return { vendor, evaluations };
  });

  router.post('/api/procurement/vendor-evaluations/:vendorId', async (ctx) => {
    auth.guard(ctx.user, 'vendor.evaluate');
    const vendorId = Number(ctx.params.vendorId);
    const vendor = ctx.db.prepare('SELECT id, code, name FROM vendors WHERE id = ?').get(vendorId);
    if (!vendor) throw new HttpError(404, 'Vendor not found.');

    const body = ctx.body || {};
    const rating = (field, label) => {
      const n = Number(body[field]);
      if (!Number.isInteger(n) || n < 0 || n > 5) throw badRequest(`${label} must be a whole number from 0 to 5.`);
      return n;
    };
    const data = {
      delivery: rating('deliveryRating', 'Delivery rating'),
      quality: rating('qualityRating', 'Quality rating'),
      pricing: rating('pricingRating', 'Pricing rating'),
      service: rating('serviceRating', 'Service rating'),
      comments: optionalText(body, 'comments', 1000),
    };
    const now = nowIso();
    const res = ctx.db
      .prepare(
        `INSERT INTO vendor_evaluations(vendor_id, delivery_rating, quality_rating, pricing_rating,
           service_rating, comments, evaluated_by, evaluated_at, created_at)
         VALUES (?,?,?,?,?,?,?,?,?)`
      )
      .run(vendorId, data.delivery, data.quality, data.pricing, data.service, data.comments, ctx.user.id, now, now);
    const id = Number(res.lastInsertRowid);
    audit(ctx, 'CREATE', 'vendor_evaluation', id, null, {
      vendorId, delivery: data.delivery, quality: data.quality, pricing: data.pricing, service: data.service,
    });
    return { id };
  });
};
