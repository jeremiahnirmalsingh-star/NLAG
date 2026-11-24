'use strict';

/**
 * Fleet Desk API — vehicle booking and trip management.
 *
 * Additive only: all endpoints live under /api/fleet and only touch the new
 * fleet_* tables. Authentication and roles are the existing ABMDAS ones.
 */

const auth = require('../auth');
const { HttpError } = require('../http');
const {
  audit, nowIso, nextSequence, badRequest, round2,
} = require('../util');
const { transaction, rowOr404 } = require('../procurement/shared');

/* People and departments are common ABMDAS masters. Fleet Masters only owns
   trip-specific data: pickup/drop areas and vehicles. */
const MASTERS = {
  areas: {
    table: 'fleet_areas',
    label: 'Area',
    fields: ['name', 'address', 'address_id', 'lat', 'lng', 'maps_url', 'active'],
    required: ['name'],
  },
  vehicles: {
    table: 'fleet_vehicles',
    label: 'Vehicle',
    fields: ['reg_no', 'model', 'seats', 'status', 'asset_id', 'active'],
    unique: ['reg_no'],
    required: ['reg_no', 'model', 'seats'],
  },
};

const COLUMN_MAP = {
  name: 'name', address: 'address', address_id: 'address_id', lat: 'lat', lng: 'lng',
  maps_url: 'maps_url', reg_no: 'reg_no', model: 'model', seats: 'seats',
  status: 'status', asset_id: 'asset_id', active: 'active',
};

/* The API speaks camelCase everywhere else; accept both spellings so a master
   can be posted with either its API name or its database column name. */
const API_TO_COLUMN = {
  regNo: 'reg_no',
  licenseNo: 'license_no',
  licenseExpiry: 'license_expiry',
  mapsUrl: 'maps_url',
  addressId: 'address_id',
  assetId: 'asset_id',
};

function normalizeMasterBody(body) {
  const out = {};
  for (const [key, value] of Object.entries(body || {})) {
    out[API_TO_COLUMN[key] || key] = value;
  }
  return out;
}

function text(value, max = 200) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

function integer(value, field, { min = 1, max = 1000, required = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw badRequest(`${field} is required.`);
    return null;
  }
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw badRequest(`${field} must be a whole number between ${min} and ${max}.`);
  }
  return n;
}

function decimal(value, field, { min = 0, required = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw badRequest(`${field} is required.`);
    return null;
  }
  const n = Number(value);
  if (!Number.isFinite(n) || n < min) {
    throw badRequest(`${field} must be a number of at least ${min}.`);
  }
  return round2(n);
}

/* Operating cost categories. Stored as short codes; the labels are shared
   with the frontend through /api/fleet/expenses. */
const EXPENSE_CATEGORIES = [
  { value: 'FUEL', label: 'Fuel' },
  { value: 'DRIVER', label: 'Driver charges' },
  { value: 'TOLL', label: 'Toll & parking' },
  { value: 'SERVICE', label: 'Service' },
  { value: 'REPAIR', label: 'Repairs' },
  { value: 'TYRE', label: 'Tyres' },
  { value: 'TAX', label: 'Tax & insurance' },
  { value: 'OTHER', label: 'Other' },
];

function expenseOut(db, row) {
  if (!row) return null;
  const vehicle = row.vehicle_id
    ? db.prepare('SELECT reg_no FROM fleet_vehicles WHERE id = ?').get(row.vehicle_id)
    : null;
  return {
    id: row.id,
    vehicleId: row.vehicle_id,
    vehicleRegNo: vehicle ? vehicle.reg_no : '',
    date: row.expense_date,
    category: row.category,
    amount: round2(Number(row.amount) || 0),
    quantity: row.quantity == null ? null : Number(row.quantity),
    rate: row.rate == null ? null : Number(row.rate),
    vendor: row.vendor || '',
    billNo: row.bill_no || '',
    odometerKm: row.odometer_km == null ? null : Number(row.odometer_km),
    remarks: row.remarks || '',
    createdAt: row.created_at,
  };
}

function expenseValues(db, body) {
  const b = body || {};
  const vehicleId = integer(b.vehicleId, 'Vehicle', { required: true, min: 1, max: 100000000 });
  if (!db.prepare('SELECT id FROM fleet_vehicles WHERE id = ? AND deleted_at IS NULL').get(vehicleId)) {
    throw badRequest('Choose a valid vehicle.');
  }
  const date = text(b.date, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw badRequest('Expense date is required (YYYY-MM-DD).');
  const category = text(b.category, 20).toUpperCase();
  if (!EXPENSE_CATEGORIES.some((item) => item.value === category)) {
    throw badRequest('Choose a valid expense category.');
  }
  const amount = decimal(b.amount, 'Amount', { required: true, min: 0.01 });
  return {
    vehicle_id: vehicleId,
    expense_date: date,
    category,
    amount,
    quantity: decimal(b.quantity, 'Quantity'),
    rate: decimal(b.rate, 'Rate'),
    vendor: text(b.vendor, 200),
    bill_no: text(b.billNo, 100),
    odometer_km: decimal(b.odometerKm, 'Odometer'),
    remarks: text(b.remarks, 500),
  };
}

function masterOut(row, model) {
  if (!row) return null;
  const base = {
    id: row.id,
    active: !!row.active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (model === 'areas') {
    return {
      ...base,
      name: row.name,
      address: row.address || '',
      lat: row.lat == null ? null : Number(row.lat),
      lng: row.lng == null ? null : Number(row.lng),
      mapsUrl: row.maps_url || '',
      addressId: row.address_id || null,
    };
  }
  if (model === 'vehicles') {
    return {
      ...base,
      regNo: row.reg_no,
      model: row.model,
      seats: Number(row.seats) || 0,
      status: row.status,
      assetId: row.asset_id || null,
    };
  }
  return base;
}

/* Drivers are common employees with an additive driving qualification. A
   driver is offered only in the units where that employee is assigned. */
function employeeUnitClause(unitIds) {
  const ids = [...new Set((unitIds || []).map(Number).filter((id) => Number.isInteger(id) && id > 0))];
  if (!ids.length) return '0';
  const list = ids.join(',');
  return `(EXISTS (SELECT 1 FROM employee_units eu WHERE eu.employee_id = e.id AND eu.unit_id IN (${list}))
           OR (NOT EXISTS (SELECT 1 FROM employee_units eu WHERE eu.employee_id = e.id) AND e.unit_id IN (${list})))`;
}

function driverRows(db, unitIds = []) {
  return db
    .prepare(
      `SELECT e.id, e.employee_code, e.name, e.mobile, p.license_no, p.license_expiry
         FROM employees e
         JOIN employee_driver_profiles p ON p.employee_id = e.id
        WHERE e.deleted_at IS NULL AND e.status = 'Active' AND p.active = 1
          AND ${employeeUnitClause(unitIds)}
        ORDER BY e.name COLLATE NOCASE`
    )
    .all()
    .map((row) => ({
      id: row.id,
      employeeCode: row.employee_code,
      name: row.name,
      phone: row.mobile || '',
      licenseNo: row.license_no || '',
      licenseExpiry: row.license_expiry || '',
    }));
}

function activeDriver(db, id, unitIds = []) {
  return db
    .prepare(
      `SELECT e.id, e.name FROM employees e
         JOIN employee_driver_profiles p ON p.employee_id = e.id
        WHERE e.id = ? AND e.deleted_at IS NULL AND e.status = 'Active' AND p.active = 1
          AND ${employeeUnitClause(unitIds)}`
    )
    .get(Number(id));
}

function normalizeLinks(values) {
  for (const key of ['address_id', 'asset_id']) {
    if (values[key] === undefined) continue;
    values[key] = values[key] === '' || values[key] == null
      ? null
      : integer(values[key], key.replace('_', ' '), { min: 1, max: 100000000 });
  }
}

function masterRows(db, model) {
  const config = MASTERS[model];
  return db
    .prepare(`SELECT * FROM ${config.table} WHERE deleted_at IS NULL ORDER BY id ASC`)
    .all()
    .map((row) => masterOut(row, model));
}

function masterById(db, model, id) {
  const config = MASTERS[model];
  return rowOr404(
    db.prepare(`SELECT * FROM ${config.table} WHERE id = ? AND deleted_at IS NULL`).get(Number(id)),
    `${config.label} not found.`
  );
}

/* A booking normally stores the address typed by the requester. Coordinates
   are optional: when a Google Maps share link is used they can be supplied,
   otherwise the address itself is used to open the route in Google Maps. */
function coordinate(value, label) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || Math.abs(n) > 180) {
    throw badRequest(`${label} map coordinates are invalid.`);
  }
  return n;
}

function locationFromBody(body, kind) {
  const label = kind === 'pickup' ? 'Pickup location' : 'Drop location';
  const name = text(body[`${kind}Name`], 200);
  const address = text(body[`${kind}Address`], 500);
  const lat = coordinate(body[`${kind}Lat`], label);
  const lng = coordinate(body[`${kind}Lng`], label);
  if ((lat == null) !== (lng == null)) {
    throw badRequest(`${label} must have both latitude and longitude, or neither.`);
  }
  if (!name && !address) throw badRequest(`${label} is required.`);
  const place = address || name;
  return {
    name: name || address,
    address: place,
    lat,
    lng,
    mapsUrl: text(body[`${kind}MapsUrl`], 1000)
      || (lat != null
        ? `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`
        : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(place)}`),
  };
}

function locationFromArea(db, areaId, kind) {
  const area = db
    .prepare('SELECT id, name, address, lat, lng, maps_url FROM fleet_areas WHERE id = ? AND deleted_at IS NULL AND active = 1')
    .get(Number(areaId));
  if (!area) throw badRequest(`Choose a valid ${kind} location.`);
  return {
    id: area.id,
    name: area.name,
    address: area.address || '',
    lat: area.lat == null ? null : Number(area.lat),
    lng: area.lng == null ? null : Number(area.lng),
    mapsUrl: area.maps_url || '',
  };
}

function bookingOut(db, row) {
  if (!row) return null;
  const user = db.prepare('SELECT name FROM users WHERE id = ?').get(row.requester_id);
  const dept = row.department_id
    ? db.prepare('SELECT name FROM departments WHERE id = ?').get(row.department_id)
    : null;
  const savedPickup = row.pickup_id
    ? db.prepare('SELECT name, address, lat, lng, maps_url FROM fleet_areas WHERE id = ?').get(row.pickup_id)
    : null;
  const savedDrop = row.drop_id
    ? db.prepare('SELECT name, address, lat, lng, maps_url FROM fleet_areas WHERE id = ?').get(row.drop_id)
    : null;
  const pickup = {
    name: row.pickup_name || savedPickup?.name || '',
    address: row.pickup_address || savedPickup?.address || '',
    lat: row.pickup_lat ?? savedPickup?.lat ?? null,
    lng: row.pickup_lng ?? savedPickup?.lng ?? null,
    mapsUrl: row.pickup_maps_url || savedPickup?.maps_url || '',
  };
  const drop = {
    name: row.drop_name || savedDrop?.name || '',
    address: row.drop_address || savedDrop?.address || '',
    lat: row.drop_lat ?? savedDrop?.lat ?? null,
    lng: row.drop_lng ?? savedDrop?.lng ?? null,
    mapsUrl: row.drop_maps_url || savedDrop?.maps_url || '',
  };
  const vehicle = row.vehicle_id
    ? db.prepare('SELECT reg_no, model FROM fleet_vehicles WHERE id = ?').get(row.vehicle_id)
    : null;
  const driver = row.driver_id
    ? db.prepare('SELECT name, employee_code FROM employees WHERE id = ?').get(row.driver_id)
    : null;
  return {
    id: row.id,
    bookingNo: row.booking_no,
    requesterId: row.requester_id,
    requesterName: (user && user.name) || '',
    departmentId: row.department_id,
    departmentName: (dept && dept.name) || '',
    pickupId: row.pickup_id,
    pickupName: pickup.name,
    pickupAddress: pickup.address,
    pickupMapsUrl: pickup.mapsUrl,
    dropId: row.drop_id,
    dropName: drop.name,
    dropAddress: drop.address,
    dropMapsUrl: drop.mapsUrl,
    pickup,
    drop,
    startAt: row.start_at,
    endAt: row.end_at,
    passengers: Number(row.passengers) || 0,
    purpose: row.purpose || '',
    status: row.status,
    vehicleId: row.vehicle_id,
    vehicleModel: vehicle ? vehicle.model : '',
    vehicleRegNo: vehicle ? vehicle.reg_no : '',
    driverId: row.driver_id,
    driverName: driver ? driver.name : '',
    driverCode: driver ? driver.employee_code || '' : '',
    startKm: row.start_km == null ? null : Number(row.start_km),
    endKm: row.end_km == null ? null : Number(row.end_km),
    distanceKm: row.start_km == null || row.end_km == null || Number(row.end_km) <= Number(row.start_km)
      ? null
      : round2(Number(row.end_km) - Number(row.start_km)),
    remarks: row.remarks || '',
    createdAt: row.created_at,
    assignedAt: row.assigned_at,
    completedAt: row.completed_at,
  };
}

function busyResources(db, startAt, endAt, excludeId) {
  const rows = db
    .prepare(
      `SELECT vehicle_id, driver_id FROM fleet_trips
        WHERE status = 'ASSIGNED' AND id <> ?
          AND start_at < ? AND end_at > ?`
    )
    .all(excludeId || 0, endAt, startAt);
  return {
    vehicles: new Set(rows.map((r) => r.vehicle_id).filter(Boolean)),
    drivers: new Set(rows.map((r) => r.driver_id).filter(Boolean)),
  };
}

function freeResources(db, booking, unitIds = []) {
  const busy = busyResources(db, booking.start_at, booking.end_at, booking.id);
  const vehicles = db
    .prepare(
      `SELECT id, reg_no, model, seats FROM fleet_vehicles
        WHERE deleted_at IS NULL AND active = 1 AND status = 'ACTIVE' AND seats >= ?
        ORDER BY seats ASC, model COLLATE NOCASE`
    )
    .all(booking.passengers)
    .filter((v) => !busy.vehicles.has(v.id))
    .map((v) => ({
      id: v.id,
      regNo: v.reg_no,
      model: v.model,
      seats: Number(v.seats) || 0,
    }));
  const drivers = driverRows(db, unitIds)
    .filter((d) => !busy.drivers.has(d.id))
    .map((d) => ({ id: d.id, name: d.name, phone: d.phone || '' }));
  return { vehicles, drivers };
}

/**
 * Apportion vehicle expenses to trips using kilometres run.
 *
 * For each vehicle: cost per km = total expenses / total km of trips that have
 * both odometer readings. Each trip receives a share of every expense in
 * proportion to its distance. Nothing is linked at expense-entry time.
 * Expenses on a vehicle with no measured km are reported as unallocated.
 */
function tripCostReport(db) {
  const trips = db
    .prepare(
      `SELECT t.*, v.reg_no, v.model, d.name AS department_name, e.name AS driver_name
         FROM fleet_trips t
         LEFT JOIN fleet_vehicles v ON v.id = t.vehicle_id
         LEFT JOIN departments d ON d.id = t.department_id
         LEFT JOIN employees e ON e.id = t.driver_id
        WHERE t.status = 'COMPLETED'
          AND t.start_km IS NOT NULL AND t.end_km IS NOT NULL
          AND t.end_km > t.start_km
        ORDER BY t.completed_at DESC, t.id DESC`
    )
    .all();

  const expenses = db
    .prepare('SELECT * FROM fleet_vehicle_expenses WHERE deleted_at IS NULL ORDER BY expense_date DESC, id DESC')
    .all();

  const rows = trips.map((row) => ({
    id: row.id,
    bookingNo: row.booking_no,
    vehicleId: row.vehicle_id,
    vehicleRegNo: row.reg_no || '',
    vehicleModel: row.model || '',
    departmentName: row.department_name || '',
    driverName: row.driver_name || '',
    purpose: row.purpose || '',
    startAt: row.start_at,
    completedAt: row.completed_at,
    startKm: round2(Number(row.start_km)),
    endKm: round2(Number(row.end_km)),
    distanceKm: round2(Number(row.end_km) - Number(row.start_km)),
    costs: Object.fromEntries(EXPENSE_CATEGORIES.map((c) => [c.value, 0])),
    totalCost: 0,
    costPerKm: 0,
  }));

  const byVehicle = new Map();
  for (const row of rows) {
    if (!byVehicle.has(row.vehicleId)) byVehicle.set(row.vehicleId, []);
    byVehicle.get(row.vehicleId).push(row);
  }

  const unallocated = [];
  for (const expense of expenses) {
    const targets = byVehicle.get(expense.vehicle_id) || [];
    const km = targets.reduce((sum, row) => sum + row.distanceKm, 0);
    if (!targets.length || km <= 0) {
      unallocated.push(expenseOut(db, expense));
      continue;
    }
    const amount = Number(expense.amount) || 0;
    for (const row of targets) {
      const share = amount * (row.distanceKm / km);
      row.costs[expense.category] = (row.costs[expense.category] || 0) + share;
      row.totalCost += share;
    }
  }

  const totals = {
    trips: rows.length,
    distanceKm: 0,
    totalCost: 0,
  };
  for (const category of EXPENSE_CATEGORIES) totals[category.value] = 0;

  for (const row of rows) {
    for (const category of EXPENSE_CATEGORIES) {
      row.costs[category.value] = round2(row.costs[category.value] || 0);
      totals[category.value] += row.costs[category.value];
    }
    row.totalCost = round2(row.totalCost);
    row.costPerKm = row.distanceKm > 0 ? round2(row.totalCost / row.distanceKm) : 0;
    totals.distanceKm += row.distanceKm;
    totals.totalCost += row.totalCost;
  }
  totals.distanceKm = round2(totals.distanceKm);
  totals.totalCost = round2(totals.totalCost);
  for (const category of EXPENSE_CATEGORIES) totals[category.value] = round2(totals[category.value]);
  totals.costPerKm = totals.distanceKm > 0 ? round2(totals.totalCost / totals.distanceKm) : 0;

  /* Per-vehicle summary, including vehicles that only have expenses. */
  const vehicleRows = db
    .prepare('SELECT id, reg_no, model FROM fleet_vehicles WHERE deleted_at IS NULL ORDER BY reg_no COLLATE NOCASE')
    .all();
  const vehicles = vehicleRows.map((vehicle) => {
    const targets = byVehicle.get(vehicle.id) || [];
    const km = round2(targets.reduce((sum, row) => sum + row.distanceKm, 0));
    const spent = expenses
      .filter((expense) => expense.vehicle_id === vehicle.id)
      .reduce((sum, expense) => sum + (Number(expense.amount) || 0), 0);
    return {
      id: vehicle.id,
      regNo: vehicle.reg_no,
      model: vehicle.model,
      trips: targets.length,
      distanceKm: km,
      expenseTotal: round2(spent),
      costPerKm: km > 0 ? round2(spent / km) : 0,
    };
  });

  return { rows, totals, unallocated, vehicles, categories: EXPENSE_CATEGORIES };
}

module.exports = function registerFleetRoutes(router) {
  router.get('/api/fleet/meta', async (ctx) => {
    auth.guard(ctx.user, 'fleet.view');
    return {
      permissions: {
        view: true,
        create: auth.can(ctx.user, 'fleet.booking.create'),
        manageBookings: auth.can(ctx.user, 'fleet.booking.manage'),
        manageMasters: auth.can(ctx.user, 'fleet.master.manage'),
      },
      /* Common masters: Fleet never keeps its own copy of people or departments. */
      departments: ctx.db
        .prepare('SELECT id, name, active FROM departments ORDER BY name COLLATE NOCASE')
        .all()
        .map((d) => ({ ...d, active: !!d.active })),
      areas: masterRows(ctx.db, 'areas'),
      vehicles: masterRows(ctx.db, 'vehicles'),
      drivers: driverRows(ctx.db, ctx.unitIds),
      addresses: ctx.db
        .prepare('SELECT id, label, city, lat, lng, maps_url FROM common_addresses WHERE deleted_at IS NULL AND active = 1 ORDER BY label COLLATE NOCASE')
        .all()
        .map((a) => ({
          id: a.id, label: a.label, city: a.city || '',
          lat: a.lat == null ? null : Number(a.lat),
          lng: a.lng == null ? null : Number(a.lng),
          mapsUrl: a.maps_url || '',
        })),
      assets: auth.can(ctx.user, 'asset.view')
        ? ctx.db
          .prepare('SELECT id, asset_code, asset_name FROM assets WHERE deleted_at IS NULL ORDER BY asset_name COLLATE NOCASE')
          .all()
          .map((a) => ({ id: a.id, code: a.asset_code, name: a.asset_name }))
        : [],
    };
  });

  /* ----------------------------- Bookings ---------------------------- */
  router.get('/api/fleet/bookings', async (ctx) => {
    auth.guard(ctx.user, 'fleet.view');
    const admin = auth.can(ctx.user, 'fleet.booking.manage');
    const rows = admin
      ? ctx.db.prepare('SELECT * FROM fleet_trips ORDER BY start_at DESC, id DESC').all()
      : ctx.db.prepare('SELECT * FROM fleet_trips WHERE requester_id = ? ORDER BY start_at DESC, id DESC').all(ctx.user.id);
    return { bookings: rows.map((row) => bookingOut(ctx.db, row)) };
  });

  router.get('/api/fleet/bookings/:id', async (ctx) => {
    auth.guard(ctx.user, 'fleet.view');
    const row = rowOr404(
      ctx.db.prepare('SELECT * FROM fleet_trips WHERE id = ?').get(Number(ctx.params.id)),
      'Booking not found.'
    );
    if (!auth.can(ctx.user, 'fleet.booking.manage') && row.requester_id !== ctx.user.id) {
      throw new HttpError(403, 'You do not have permission to view this booking.');
    }
    return { booking: bookingOut(ctx.db, row) };
  });

  router.post('/api/fleet/bookings', async (ctx) => {
    auth.guard(ctx.user, 'fleet.booking.create');
    const b = ctx.body || {};
    const startAt = text(b.startAt, 40);
    const endAt = text(b.endAt, 40);
    if (!startAt || !endAt) throw badRequest('Start and end date/time are required.');
    const start = new Date(startAt);
    const end = new Date(endAt);
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) {
      throw badRequest('Enter a valid start and end date/time.');
    }
    if (start.getTime() >= end.getTime()) throw badRequest('End date/time must be after the start.');

    /* Legacy clients may still post pickupId/dropId. New bookings normally
       post the map point chosen in the Google Maps picker. */
    const pickupId = b.pickupId === undefined || b.pickupId === null || b.pickupId === ''
      ? null : integer(b.pickupId, 'Pickup location', { min: 1, max: 100000000 });
    const dropId = b.dropId === undefined || b.dropId === null || b.dropId === ''
      ? null : integer(b.dropId, 'Drop location', { min: 1, max: 100000000 });
    const pickup = pickupId ? locationFromArea(ctx.db, pickupId, 'pickup') : locationFromBody(b, 'pickup');
    const drop = dropId ? locationFromArea(ctx.db, dropId, 'drop') : locationFromBody(b, 'drop');
    if (pickupId && dropId && pickupId === dropId) {
      throw badRequest('Pickup and drop locations must be different.');
    }
    if (!pickupId && !dropId) {
      const samePoint = pickup.lat != null && drop.lat != null
        && Math.abs(pickup.lat - drop.lat) < 0.00001
        && Math.abs(pickup.lng - drop.lng) < 0.00001;
      const sameAddress = pickup.address.trim().toLowerCase() === drop.address.trim().toLowerCase();
      if (samePoint || sameAddress) {
        throw badRequest('Pickup and drop locations must be different.');
      }
    }

    const passengers = integer(b.passengers, 'Number of persons', { min: 1, max: 60, required: true });
    const departmentId = integer(b.departmentId, 'Department', { min: 1, max: 1000000 });
    if (departmentId && !ctx.db.prepare('SELECT id FROM departments WHERE id = ?').get(departmentId)) {
      throw badRequest('Choose a valid department from the common master.');
    }
    const purpose = text(b.purpose, 500);
    if (!purpose) throw badRequest('Purpose is required.');

    const now = nowIso();
    const bookingNo = nextSequence('fleet_booking', { prefix: 'FD', year: false, pad: 4 });
    const result = ctx.db
      .prepare(
        `INSERT INTO fleet_trips(
           booking_no, requester_id, department_id, pickup_id, drop_id,
           pickup_name, pickup_address, pickup_lat, pickup_lng, pickup_maps_url,
           drop_name, drop_address, drop_lat, drop_lng, drop_maps_url,
           start_at, end_at, passengers, purpose, status, created_at, updated_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'PENDING',?,?)`
      )
      .run(
        bookingNo, ctx.user.id, departmentId, pickupId, dropId,
        pickup.name, pickup.address, pickup.lat, pickup.lng, pickup.mapsUrl,
        drop.name, drop.address, drop.lat, drop.lng, drop.mapsUrl,
        start.toISOString(), end.toISOString(), passengers, purpose, now, now
      );
    const id = Number(result.lastInsertRowid);
    audit(ctx, 'CREATE', 'fleet_booking', id, null, {
      bookingNo, purpose, passengers, pickup: pickup.name, drop: drop.name,
    });
    return { id, bookingNo, status: 'PENDING' };
  });

  router.get('/api/fleet/bookings/:id/availability', async (ctx) => {
    auth.guard(ctx.user, 'fleet.booking.manage');
    const booking = rowOr404(
      ctx.db.prepare('SELECT * FROM fleet_trips WHERE id = ?').get(Number(ctx.params.id)),
      'Booking not found.'
    );
    return { availability: freeResources(ctx.db, booking, ctx.unitIds) };
  });

  router.patch('/api/fleet/bookings/:id', async (ctx) => {
    auth.guard(ctx.user, 'fleet.booking.manage');
    const id = Number(ctx.params.id);
    const action = text((ctx.body || {}).action, 30).toLowerCase();
    if (!['assign', 'reject', 'complete', 'odometer'].includes(action)) throw badRequest('Unknown booking action.');

    transaction(ctx.db, () => {
      const booking = rowOr404(
        ctx.db.prepare('SELECT * FROM fleet_trips WHERE id = ?').get(id),
        'Booking not found.'
      );
      const now = nowIso();
      if (action === 'assign') {
        if (booking.status !== 'PENDING') throw badRequest('Only pending requests can be assigned.');
        const vehicleId = integer((ctx.body || {}).vehicleId, 'Vehicle', { required: true });
        const driverId = integer((ctx.body || {}).driverId, 'Driver', { required: true });
        const vehicle = ctx.db
          .prepare('SELECT * FROM fleet_vehicles WHERE id = ? AND deleted_at IS NULL AND active = 1 AND status = ?')
          .get(vehicleId, 'ACTIVE');
        if (!vehicle) throw badRequest('Choose an active vehicle.');
        if ((Number(vehicle.seats) || 0) < booking.passengers) {
          throw badRequest('The selected vehicle does not have enough seats.');
        }
        const driver = activeDriver(ctx.db, driverId, ctx.unitIds);
        if (!driver) throw badRequest('Choose an active driver from the common employee master.');
        const busy = busyResources(ctx.db, booking.start_at, booking.end_at, booking.id);
        if (busy.vehicles.has(vehicleId)) throw badRequest('That vehicle is already booked for this time.');
        if (busy.drivers.has(driverId)) throw badRequest('That driver is already booked for this time.');
        const startKm = decimal((ctx.body || {}).startKm, 'Starting km');
        ctx.db
          .prepare(
            `UPDATE fleet_trips
                SET status = 'ASSIGNED', vehicle_id = ?, driver_id = ?, start_km = ?, assigned_at = ?, updated_at = ?
              WHERE id = ?`
          )
          .run(vehicleId, driverId, startKm, now, now, id);
        audit(ctx, 'UPDATE', 'fleet_booking', id, { status: booking.status }, { status: 'ASSIGNED', vehicleId, driverId, startKm });
        return;
      }
      if (action === 'reject') {
        if (booking.status !== 'PENDING') throw badRequest('Only pending requests can be rejected.');
        ctx.db
          .prepare("UPDATE fleet_trips SET status = 'REJECTED', remarks = ?, updated_at = ? WHERE id = ?")
          .run(text((ctx.body || {}).remarks, 500) || 'Rejected by transport incharge', now, id);
        audit(ctx, 'UPDATE', 'fleet_booking', id, { status: booking.status }, { status: 'REJECTED' });
        return;
      }
      if (action === 'odometer') {
        const startKm = decimal((ctx.body || {}).startKm, 'Starting km');
        const endKm = decimal((ctx.body || {}).endKm, 'Closing km');
        if (startKm === null && endKm === null) {
          throw badRequest('Enter a starting or closing km reading.');
        }
        const nextStart = startKm ?? (booking.start_km == null ? null : Number(booking.start_km));
        const nextEnd = endKm ?? (booking.end_km == null ? null : Number(booking.end_km));
        if (nextStart != null && nextEnd != null && nextEnd < nextStart) {
          throw badRequest('Closing km cannot be less than starting km.');
        }
        ctx.db
          .prepare('UPDATE fleet_trips SET start_km = ?, end_km = ?, updated_at = ? WHERE id = ?')
          .run(nextStart, nextEnd, now, id);
        audit(ctx, 'UPDATE', 'fleet_booking', id,
          { startKm: booking.start_km, endKm: booking.end_km },
          { startKm: nextStart, endKm: nextEnd });
        return;
      }
      if (booking.status !== 'ASSIGNED') throw badRequest('Only assigned trips can be completed.');
      const endKm = decimal((ctx.body || {}).endKm, 'Closing km');
      if (endKm !== null && booking.start_km != null && endKm < Number(booking.start_km)) {
        throw badRequest('Closing km cannot be less than starting km.');
      }
      ctx.db
        .prepare("UPDATE fleet_trips SET status = 'COMPLETED', end_km = ?, completed_at = ?, updated_at = ? WHERE id = ?")
        .run(endKm, now, now, id);
      audit(ctx, 'UPDATE', 'fleet_booking', id, { status: booking.status }, { status: 'COMPLETED', endKm });
    });
    return { ok: true };
  });

  /* ---------------------------- Operations --------------------------- */
  router.get('/api/fleet/expenses', async (ctx) => {
    auth.guard(ctx.user, 'fleet.view');
    const rows = ctx.db
      .prepare('SELECT * FROM fleet_vehicle_expenses WHERE deleted_at IS NULL ORDER BY expense_date DESC, id DESC')
      .all();
    return {
      expenses: rows.map((row) => expenseOut(ctx.db, row)),
      categories: EXPENSE_CATEGORIES,
      vehicles: masterRows(ctx.db, 'vehicles'),
    };
  });

  router.post('/api/fleet/expenses', async (ctx) => {
    auth.guard(ctx.user, 'fleet.booking.manage');
    const values = expenseValues(ctx.db, ctx.body);
    const now = nowIso();
    const columns = [...Object.keys(values), 'created_by', 'created_at', 'updated_at'];
    const result = ctx.db
      .prepare(
        `INSERT INTO fleet_vehicle_expenses(${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`
      )
      .run(...Object.values(values), ctx.user.id, now, now);
    const id = Number(result.lastInsertRowid);
    const out = expenseOut(ctx.db, ctx.db.prepare('SELECT * FROM fleet_vehicle_expenses WHERE id = ?').get(id));
    audit(ctx, 'CREATE', 'fleet_expense', id, null, out);
    return { id, expense: out };
  });

  router.put('/api/fleet/expenses/:id', async (ctx) => {
    auth.guard(ctx.user, 'fleet.booking.manage');
    const id = Number(ctx.params.id);
    const existing = rowOr404(
      ctx.db.prepare('SELECT * FROM fleet_vehicle_expenses WHERE id = ? AND deleted_at IS NULL').get(id),
      'Expense not found.'
    );
    const values = expenseValues(ctx.db, ctx.body);
    const keys = Object.keys(values);
    ctx.db
      .prepare(
        `UPDATE fleet_vehicle_expenses SET ${keys.map((key) => `${key} = ?`).join(', ')}, updated_at = ? WHERE id = ?`
      )
      .run(...Object.values(values), nowIso(), id);
    const updated = ctx.db.prepare('SELECT * FROM fleet_vehicle_expenses WHERE id = ?').get(id);
    audit(ctx, 'UPDATE', 'fleet_expense', id, expenseOut(ctx.db, existing), expenseOut(ctx.db, updated));
    return { ok: true, expense: expenseOut(ctx.db, updated) };
  });

  router.delete('/api/fleet/expenses/:id', async (ctx) => {
    auth.guard(ctx.user, 'fleet.booking.manage');
    const id = Number(ctx.params.id);
    const existing = rowOr404(
      ctx.db.prepare('SELECT * FROM fleet_vehicle_expenses WHERE id = ? AND deleted_at IS NULL').get(id),
      'Expense not found.'
    );
    const now = nowIso();
    ctx.db
      .prepare('UPDATE fleet_vehicle_expenses SET deleted_at = ?, deleted_by = ? WHERE id = ?')
      .run(now, ctx.user.id, id);
    audit(ctx, 'DELETE', 'fleet_expense', id, expenseOut(ctx.db, existing), { deletedAt: now });
    return { ok: true };
  });

  router.get('/api/fleet/trip-costs', async (ctx) => {
    auth.guard(ctx.user, 'fleet.view');
    return tripCostReport(ctx.db);
  });

  /* ------------------------------ Masters ---------------------------- */
  router.get('/api/fleet/masters/:model', async (ctx) => {
    auth.guard(ctx.user, 'fleet.view');
    const model = ctx.params.model;
    if (!MASTERS[model]) throw new HttpError(404, 'Unknown fleet master.');
    return { model, records: masterRows(ctx.db, model) };
  });

  router.post('/api/fleet/masters/:model', async (ctx) => {
    auth.guard(ctx.user, 'fleet.master.manage');
    const model = ctx.params.model;
    const config = MASTERS[model];
    if (!config) throw new HttpError(404, 'Unknown fleet master.');
    const b = normalizeMasterBody(ctx.body);
    const values = {};
    for (const field of config.required) {
      const value = b[field];
      if (value === undefined || value === null || String(value).trim() === '') {
        throw badRequest(`${config.label} ${field.replace(/_/g, ' ')} is required.`);
      }
      values[field] = value;
    }
    for (const field of config.fields) {
      if (!(field in values) && b[field] !== undefined) values[field] = b[field];
    }
    if (model === 'vehicles') {
      values.seats = integer(values.seats, 'Seats', { min: 1, max: 100, required: true });
      values.status = ['ACTIVE', 'IN_SERVICE'].includes(text(values.status || 'ACTIVE')) ? text(values.status || 'ACTIVE') : 'ACTIVE';
    }
    if (model === 'areas') {
      for (const key of ['lat', 'lng']) {
        const raw = values[key];
        if (raw === '' || raw === undefined || raw === null) {
          values[key] = null;
        } else {
          const n = Number(raw);
          if (!Number.isFinite(n)) throw badRequest('Latitude and longitude must be numbers.');
          values[key] = round2(n);
        }
      }
    }
    normalizeLinks(values);
    values.active = values.active === undefined || values.active === null || values.active === '' ? 1 : (Number(values.active) ? 1 : 0);
    for (const key of Object.keys(values)) {
      if (!COLUMN_MAP[key] || !config.fields.includes(key)) delete values[key];
    }

    const now = nowIso();
    for (const uniqueField of config.unique || []) {
      const existing = ctx.db
        .prepare(`SELECT id FROM ${config.table} WHERE ${uniqueField} = ? COLLATE NOCASE AND deleted_at IS NULL`)
        .get(String(values[uniqueField]).trim());
      if (existing) throw badRequest(`${config.label} with this ${uniqueField.replace(/_/g, ' ')} already exists.`);
    }
    const columns = [...Object.keys(values), 'created_at', 'updated_at'];
    const placeholders = columns.map(() => '?').join(', ');
    const result = ctx.db
      .prepare(`INSERT INTO ${config.table}(${columns.join(', ')}) VALUES (${placeholders})`)
      .run(...Object.values(values), now, now);
    const id = Number(result.lastInsertRowid);
    audit(ctx, 'CREATE', `fleet_${model}`, id, null, masterOut(masterById(ctx.db, model, id), model));
    return { id, record: masterOut(masterById(ctx.db, model, id), model) };
  });

  router.put('/api/fleet/masters/:model/:id', async (ctx) => {
    auth.guard(ctx.user, 'fleet.master.manage');
    const model = ctx.params.model;
    const config = MASTERS[model];
    if (!config) throw new HttpError(404, 'Unknown fleet master.');
    const existing = masterById(ctx.db, model, ctx.params.id);
    const b = normalizeMasterBody(ctx.body);
    const values = {};
    for (const field of config.fields) {
      if (b[field] !== undefined) values[field] = b[field];
    }
    if (model === 'vehicles' && values.seats !== undefined) {
      values.seats = integer(values.seats, 'Seats', { min: 1, max: 100, required: true });
    }
    if (model === 'areas') {
      for (const key of ['lat', 'lng']) {
        if (values[key] !== undefined) {
          if (values[key] === '' || values[key] === null) values[key] = null;
          else {
            const n = Number(values[key]);
            if (!Number.isFinite(n)) throw badRequest('Latitude and longitude must be numbers.');
            values[key] = round2(n);
          }
        }
      }
    }
    normalizeLinks(values);
    if (values.active !== undefined) values.active = Number(values.active) ? 1 : 0;
    for (const key of Object.keys(values)) {
      if (!COLUMN_MAP[key] || !config.fields.includes(key)) delete values[key];
    }
    for (const uniqueField of config.unique || []) {
      if (values[uniqueField] === undefined) continue;
      const existingUnique = ctx.db
        .prepare(`SELECT id FROM ${config.table} WHERE ${uniqueField} = ? COLLATE NOCASE AND deleted_at IS NULL AND id <> ?`)
        .get(String(values[uniqueField]).trim(), existing.id);
      if (existingUnique) throw badRequest(`${config.label} with this ${uniqueField.replace(/_/g, ' ')} already exists.`);
    }
    if (Object.keys(values).length) {
      const assignments = Object.keys(values).map((key) => `${key} = ?`).join(', ');
      ctx.db
        .prepare(`UPDATE ${config.table} SET ${assignments}, updated_at = ? WHERE id = ?`)
        .run(...Object.values(values), nowIso(), existing.id);
    }
    audit(ctx, 'UPDATE', `fleet_${model}`, existing.id, masterOut(existing, model), masterOut(masterById(ctx.db, model, existing.id), model));
    return { ok: true, record: masterOut(masterById(ctx.db, model, existing.id), model) };
  });

  router.delete('/api/fleet/masters/:model/:id', async (ctx) => {
    auth.guard(ctx.user, 'fleet.master.manage');
    const model = ctx.params.model;
    const config = MASTERS[model];
    if (!config) throw new HttpError(404, 'Unknown fleet master.');
    const existing = masterById(ctx.db, model, ctx.params.id);
    const now = nowIso();
    ctx.db
      .prepare(`UPDATE ${config.table} SET deleted_at = ?, deleted_by = ?, active = 0 WHERE id = ?`)
      .run(now, ctx.user.id, existing.id);
    audit(ctx, 'DELETE', `fleet_${model}`, existing.id, masterOut(existing, model), { deletedAt: now });
    return { ok: true };
  });
};
