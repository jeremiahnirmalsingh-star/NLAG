'use strict';

/**
 * Lookup and working-day API shared by the bills, procurement and fleet
 * masters screens. Additive only: existing tables are read, never changed.
 */

const auth = require('../auth');
const { HttpError } = require('../http');
const { audit, badRequest, nowIso } = require('../util');

const DAY_TYPES = ['HOLIDAY', 'WORKING_SATURDAY'];

/* Real table names verified in server/db.js and server/procurement/schema.js:
 * units, departments, employees, stores, uoms, cost_centers (US spelling).
 * There is currently no tax-rate master table, so taxRates is an empty array
 * until one is introduced. */
const LOOKUP_GROUPS = [
  {
    key: 'units',
    permission: 'po.view',
    sql: 'SELECT id, code, name FROM units WHERE active = 1 ORDER BY name',
  },
  {
    key: 'departments',
    permission: 'org.view',
    sql: 'SELECT id, name FROM departments WHERE active = 1 ORDER BY name',
  },
  {
    key: 'employees',
    permission: 'employee.view',
    sql: `SELECT id, employee_code AS code, name FROM employees
           WHERE deleted_at IS NULL AND status = 'Active' ORDER BY name`,
  },
  {
    key: 'stores',
    permission: 'store.view',
    sql: 'SELECT id, code, name FROM stores WHERE deleted_at IS NULL AND active = 1 ORDER BY name',
  },
  {
    key: 'uoms',
    permission: 'item.view',
    sql: 'SELECT id, code, name FROM uoms WHERE active = 1 ORDER BY name',
  },
  {
    key: 'costCentres',
    permission: 'po.view',
    sql: `SELECT id, code, name FROM cost_centers
           WHERE deleted_at IS NULL AND active = 1 ORDER BY name`,
  },
];

/* Only these candidate names are considered; they are constants, never user
 * input, so the generated SQL is safe. */
const TAX_TABLES = ['tax_rates', 'tax_rate', 'taxes', 'tax_slabs', 'tax_master', 'tax_codes', 'gst_rates'];

function normaliseLookup(row) {
  const item = { id: row.id };
  if (row.code !== undefined) item.code = row.code || '';
  item.name = row.name || '';
  return item;
}

function taxRateLookups(db) {
  const table = TAX_TABLES.find((name) =>
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)
  );
  if (!table) return [];
  const columns = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
  if (!columns.has('id')) return [];
  const select = [
    'id',
    columns.has('code') ? 'code' : 'NULL AS code',
    columns.has('name') ? 'name' : "'' AS name",
  ].join(', ');
  let sql = `SELECT ${select} FROM ${table} WHERE 1 = 1`;
  if (columns.has('deleted_at')) sql += ' AND deleted_at IS NULL';
  if (columns.has('active')) sql += ' AND active = 1';
  sql += columns.has('name') ? ' ORDER BY name' : ' ORDER BY id';
  return db.prepare(sql).all().map(normaliseLookup);
}

function parseDate(value) {
  const date = String(value == null ? '' : value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw badRequest('date must be in YYYY-MM-DD format.');
  }
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw badRequest('date must be a valid calendar date.');
  }
  return date;
}

function parseDayType(value) {
  const type = String(value == null ? '' : value).trim().toUpperCase();
  if (!DAY_TYPES.includes(type)) {
    throw badRequest('dayType must be HOLIDAY or WORKING_SATURDAY.');
  }
  return type;
}

function toDay(row) {
  return {
    id: row.id,
    date: row.day_date,
    dayDate: row.day_date,
    type: row.day_type,
    dayType: row.day_type,
    title: row.title || '',
  };
}

function duplicateDate() {
  return new HttpError(409, 'A working-day entry already exists for this date.');
}

function registerCommonMastersRoutes(router) {
  /* One endpoint serves all three modules: each array is gated individually. */
  router.get('/api/masters/lookups', async (ctx) => {
    const result = {};
    for (const group of LOOKUP_GROUPS) {
      if (!auth.can(ctx.user, group.permission)) continue;
      result[group.key] = ctx.db.prepare(group.sql).all().map(normaliseLookup);
    }
    if (auth.can(ctx.user, 'item.view')) {
      result.taxRates = taxRateLookups(ctx.db);
    }
    return result;
  });

  router.get('/api/masters/working-days', async (ctx) => {
    auth.guard(ctx.user, 'org.view');
    const rows = ctx.db
      .prepare('SELECT id, day_date, day_type, title FROM working_days ORDER BY day_date')
      .all();
    return { days: rows.map(toDay) };
  });

  router.post('/api/masters/working-days', async (ctx) => {
    auth.guard(ctx.user, 'org.manage');
    const body = ctx.body || {};
    const date = parseDate(body.date ?? body.dayDate ?? body.day_date);
    const dayType = parseDayType(body.dayType ?? body.day_type ?? body.type);
    const title = String(body.title == null ? '' : body.title).trim().slice(0, 200);

    if (ctx.db.prepare('SELECT id FROM working_days WHERE day_date = ?').get(date)) {
      throw duplicateDate();
    }
    const now = nowIso();
    let inserted;
    try {
      inserted = ctx.db
        .prepare(
          `INSERT INTO working_days(day_date, day_type, title, created_at, updated_at)
           VALUES (?,?,?,?,?)`
        )
        .run(date, dayType, title, now, now);
    } catch (err) {
      /* The UNIQUE constraint is the final guard against a concurrent insert. */
      if (/unique|constraint/i.test(String(err && err.message))) throw duplicateDate();
      throw err;
    }
    const id = Number(inserted.lastInsertRowid);
    const day = { id, date, dayDate: date, type: dayType, dayType, title };
    audit(ctx, 'CREATE', 'working_day', id, null, day);
    return { id, day };
  });

  /* ------------------------------ Addresses -------------------------- */
  function addressOut(row) {
    return {
      id: row.id,
      label: row.label,
      line1: row.line1 || '',
      line2: row.line2 || '',
      city: row.city || '',
      state: row.state || '',
      pincode: row.pincode || '',
      country: row.country || 'India',
      lat: row.lat == null ? null : Number(row.lat),
      lng: row.lng == null ? null : Number(row.lng),
      mapsUrl: row.maps_url || '',
      active: !!row.active,
    };
  }

  function addressPayload(body, existing) {
    const text = (value, key, max) => String(
      value === undefined || value === null ? (existing ? existing[key] || '' : '') : value
    ).trim().slice(0, max);
    const label = text(body.label, 'label', 160);
    if (!label) throw badRequest('Address label is required.');
    const latRaw = body.lat === undefined ? (existing ? existing.lat : null) : body.lat;
    const lngRaw = body.lng === undefined ? (existing ? existing.lng : null) : body.lng;
    const lat = latRaw === '' || latRaw == null ? null : Number(latRaw);
    const lng = lngRaw === '' || lngRaw == null ? null : Number(lngRaw);
    if ((lat !== null && !Number.isFinite(lat)) || (lng !== null && !Number.isFinite(lng))) {
      throw badRequest('Latitude and longitude must be numbers.');
    }
    return {
      label,
      line1: text(body.line1, 'line1', 200),
      line2: text(body.line2, 'line2', 200),
      city: text(body.city, 'city', 120),
      state: text(body.state, 'state', 120),
      pincode: text(body.pincode, 'pincode', 20),
      country: text(body.country, 'country', 80) || 'India',
      lat,
      lng,
      mapsUrl: text(body.mapsUrl ?? body.maps_url, 'maps_url', 500),
      active: body.active === undefined
        ? (existing ? !!existing.active : true)
        : !!body.active,
    };
  }

  router.get('/api/masters/addresses', async (ctx) => {
    auth.guard(ctx.user, 'org.view');
    const rows = ctx.db
      .prepare('SELECT * FROM common_addresses WHERE deleted_at IS NULL ORDER BY label COLLATE NOCASE')
      .all();
    return { addresses: rows.map(addressOut) };
  });

  router.post('/api/masters/addresses', async (ctx) => {
    auth.guard(ctx.user, 'org.manage');
    const data = addressPayload(ctx.body || {}, null);
    const now = nowIso();
    const result = ctx.db
      .prepare(
        `INSERT INTO common_addresses(label, line1, line2, city, state, pincode, country,
           lat, lng, maps_url, active, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        data.label, data.line1, data.line2, data.city, data.state, data.pincode, data.country,
        data.lat, data.lng, data.mapsUrl, data.active ? 1 : 0, now, now
      );
    const id = Number(result.lastInsertRowid);
    const row = ctx.db.prepare('SELECT * FROM common_addresses WHERE id = ?').get(id);
    audit(ctx, 'CREATE', 'common_address', id, null, addressOut(row));
    return { id, address: addressOut(row) };
  });

  router.put('/api/masters/addresses/:id', async (ctx) => {
    auth.guard(ctx.user, 'org.manage');
    const id = Number(ctx.params.id);
    const existing = ctx.db
      .prepare('SELECT * FROM common_addresses WHERE id = ? AND deleted_at IS NULL')
      .get(id);
    if (!existing) throw new HttpError(404, 'Address not found.');
    const data = addressPayload(ctx.body || {}, existing);
    ctx.db
      .prepare(
        `UPDATE common_addresses SET label=?, line1=?, line2=?, city=?, state=?, pincode=?,
           country=?, lat=?, lng=?, maps_url=?, active=?, updated_at=? WHERE id=?`
      )
      .run(
        data.label, data.line1, data.line2, data.city, data.state, data.pincode, data.country,
        data.lat, data.lng, data.mapsUrl, data.active ? 1 : 0, nowIso(), id
      );
    const row = ctx.db.prepare('SELECT * FROM common_addresses WHERE id = ?').get(id);
    audit(ctx, 'UPDATE', 'common_address', id, addressOut(existing), addressOut(row));
    return { ok: true, address: addressOut(row) };
  });

  router.delete('/api/masters/addresses/:id', async (ctx) => {
    auth.guard(ctx.user, 'org.manage');
    const id = Number(ctx.params.id);
    const existing = ctx.db
      .prepare('SELECT * FROM common_addresses WHERE id = ? AND deleted_at IS NULL')
      .get(id);
    if (!existing) throw new HttpError(404, 'Address not found.');
    const now = nowIso();
    ctx.db
      .prepare('UPDATE common_addresses SET deleted_at = ?, deleted_by = ?, active = 0 WHERE id = ?')
      .run(now, ctx.user.id, id);
    audit(ctx, 'DELETE', 'common_address', id, addressOut(existing), { deletedAt: now });
    return { ok: true };
  });

  router.delete('/api/masters/working-days/:id', async (ctx) => {
    auth.guard(ctx.user, 'org.manage');
    const id = Number(ctx.params.id);
    if (!Number.isInteger(id) || id <= 0) throw badRequest('Invalid working day id.');
    const row = ctx.db
      .prepare('SELECT id, day_date, day_type, title FROM working_days WHERE id = ?')
      .get(id);
    if (!row) throw new HttpError(404, 'Working day not found.');
    ctx.db.prepare('DELETE FROM working_days WHERE id = ?').run(id);
    audit(ctx, 'DELETE', 'working_day', id, toDay(row), { deletedAt: nowIso() });
    return { ok: true };
  });
}

module.exports = { registerCommonMastersRoutes };
