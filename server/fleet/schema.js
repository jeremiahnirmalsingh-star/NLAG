'use strict';

/**
 * Additive schema for the Fleet Desk module.
 *
 * Rules for this file (same as the procurement foundation):
 *  - only CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS
 *  - never rename, drop or alter an existing ABMDAS table
 *  - no demo records are seeded; masters start empty
 *
 * People and organisation masters are NOT duplicated here. Fleet Desk uses the
 * common `departments` and `employees` tables; only trip-specific data lives in
 * fleet_* tables.
 */

function ensureFleetSchema(db) {
  db.exec(`
    /* A driving qualification is an additive profile on the common employee
       master, not a second people master. */
    CREATE TABLE IF NOT EXISTS employee_driver_profiles (
      employee_id     INTEGER PRIMARY KEY REFERENCES employees(id),
      license_no      TEXT NOT NULL DEFAULT '',
      license_expiry  TEXT,
      active          INTEGER NOT NULL DEFAULT 1,
      created_at      TEXT NOT NULL,
      updated_at      TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS fleet_areas (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL,
      address    TEXT NOT NULL DEFAULT '',
      lat        REAL,
      lng        REAL,
      maps_url   TEXT NOT NULL DEFAULT '',
      active     INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT,
      deleted_by INTEGER REFERENCES users(id)
    );

    CREATE INDEX IF NOT EXISTS idx_fleet_areas_name ON fleet_areas(name COLLATE NOCASE);

    CREATE TABLE IF NOT EXISTS fleet_vehicles (
      id                       INTEGER PRIMARY KEY AUTOINCREMENT,
      reg_no                   TEXT NOT NULL UNIQUE,
      model                    TEXT NOT NULL,
      seats                    INTEGER NOT NULL DEFAULT 1,
      status                   TEXT NOT NULL DEFAULT 'ACTIVE'
                                 CHECK (status IN ('ACTIVE','IN_SERVICE')),
      active                   INTEGER NOT NULL DEFAULT 1,
      engine_no                TEXT NOT NULL DEFAULT '',
      chassis_no               TEXT NOT NULL DEFAULT '',
      fuel_type                TEXT NOT NULL DEFAULT '',
      registered_date          TEXT,
      registration_expiry_date TEXT,
      insurance_policy_no      TEXT NOT NULL DEFAULT '',
      insurer                  TEXT NOT NULL DEFAULT '',
      insurance_date           TEXT,
      insurance_expiry_date    TEXT,
      permit_no                TEXT NOT NULL DEFAULT '',
      permit_authority         TEXT NOT NULL DEFAULT '',
      permit_date              TEXT,
      permit_expiry_date       TEXT,
      road_tax_no              TEXT NOT NULL DEFAULT '',
      road_tax_date            TEXT,
      road_tax_expiry_date     TEXT,
      pollution_cert_no        TEXT NOT NULL DEFAULT '',
      pollution_cert_date      TEXT,
      pollution_expiry_date    TEXT,
      created_at               TEXT NOT NULL,
      updated_at               TEXT NOT NULL,
      deleted_at               TEXT,
      deleted_by               INTEGER REFERENCES users(id)
    );

    /* Named fleet_trips so an older database can keep its legacy table
       physically (no drop/rename) while all live code uses these correct
       shared-master references. Pickup/drop are snapshots of the map point
       chosen by the requester; old saved areas remain supported for reads. */
    CREATE TABLE IF NOT EXISTS fleet_trips (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      booking_no      TEXT NOT NULL UNIQUE,
      requester_id    INTEGER NOT NULL REFERENCES users(id),
      department_id   INTEGER REFERENCES departments(id),
      pickup_id       INTEGER REFERENCES fleet_areas(id),
      drop_id         INTEGER REFERENCES fleet_areas(id),
      pickup_name     TEXT NOT NULL DEFAULT '',
      pickup_address  TEXT NOT NULL DEFAULT '',
      pickup_lat      REAL,
      pickup_lng      REAL,
      pickup_maps_url TEXT NOT NULL DEFAULT '',
      drop_name       TEXT NOT NULL DEFAULT '',
      drop_address    TEXT NOT NULL DEFAULT '',
      drop_lat        REAL,
      drop_lng        REAL,
      drop_maps_url   TEXT NOT NULL DEFAULT '',
      start_at        TEXT NOT NULL,
      end_at          TEXT NOT NULL,
      passengers      INTEGER NOT NULL DEFAULT 1,
      purpose         TEXT NOT NULL DEFAULT '',
      status          TEXT NOT NULL DEFAULT 'PENDING'
                        CHECK (status IN ('PENDING','ASSIGNED','REJECTED','COMPLETED')),
      vehicle_id      INTEGER REFERENCES fleet_vehicles(id),
      driver_id       INTEGER REFERENCES employees(id),
      remarks         TEXT NOT NULL DEFAULT '',
      created_at      TEXT NOT NULL,
      updated_at      TEXT NOT NULL,
      assigned_at     TEXT,
      completed_at    TEXT,
      forwarded_at    TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_fleet_trips_status ON fleet_trips(status);
    CREATE INDEX IF NOT EXISTS idx_fleet_trips_requester ON fleet_trips(requester_id);
    CREATE INDEX IF NOT EXISTS idx_fleet_trips_window ON fleet_trips(start_at, end_at);
  `);

  /* Older fleet_trips required saved areas and had no location snapshot.
     Rebuild it once, preserving every existing row, so bookings can store the
     map point chosen at booking time. The rebuild is repeat-safe. */
  ensureTripLocationColumns(db);

  /* Fleet operating costs are recorded against the vehicle only. They are
     apportioned to trips later by kilometres run, so an expense never has to
     be linked to a booking at entry time. */
  db.exec(`
    CREATE TABLE IF NOT EXISTS fleet_vehicle_expenses (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      vehicle_id   INTEGER NOT NULL REFERENCES fleet_vehicles(id),
      expense_date TEXT NOT NULL,
      category     TEXT NOT NULL
                     CHECK (category IN ('FUEL','DRIVER','TOLL','SERVICE','REPAIR','TYRE','TAX','OTHER')),
      amount       REAL NOT NULL DEFAULT 0,
      quantity     REAL,
      rate         REAL,
      vendor       TEXT NOT NULL DEFAULT '',
      bill_no      TEXT NOT NULL DEFAULT '',
      odometer_km  REAL,
      remarks      TEXT NOT NULL DEFAULT '',
      created_by   INTEGER REFERENCES users(id),
      created_at   TEXT NOT NULL,
      updated_at   TEXT NOT NULL,
      deleted_at   TEXT,
      deleted_by   INTEGER REFERENCES users(id)
    );

    CREATE INDEX IF NOT EXISTS idx_fleet_expenses_vehicle
      ON fleet_vehicle_expenses(vehicle_id, expense_date DESC);
    CREATE INDEX IF NOT EXISTS idx_fleet_expenses_category
      ON fleet_vehicle_expenses(category);

    /* Daily driver attendance. Worked and extra hours are stored so reports do
       not have to re-derive them from time strings. Extra hours are hours over
       the standard 9-hour duty day. */
    CREATE TABLE IF NOT EXISTS fleet_driver_attendance (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      driver_id       INTEGER NOT NULL REFERENCES employees(id),
      attendance_date TEXT NOT NULL,
      check_in        TEXT NOT NULL,
      check_out       TEXT NOT NULL,
      hours           REAL NOT NULL DEFAULT 0,
      extra_hours     REAL NOT NULL DEFAULT 0,
      status          TEXT NOT NULL DEFAULT 'PENDING'
                        CHECK (status IN ('PENDING','APPROVED','REJECTED')),
      remarks         TEXT NOT NULL DEFAULT '',
      unit_id         INTEGER REFERENCES units(id),
      created_by      INTEGER REFERENCES users(id),
      approved_by     INTEGER REFERENCES users(id),
      approved_at     TEXT,
      created_at      TEXT NOT NULL,
      updated_at      TEXT NOT NULL,
      deleted_at      TEXT,
      deleted_by      INTEGER REFERENCES users(id)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_fleet_attendance_driver_date
      ON fleet_driver_attendance(driver_id, attendance_date) WHERE deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_fleet_attendance_unit_date
      ON fleet_driver_attendance(unit_id, attendance_date DESC);
    CREATE INDEX IF NOT EXISTS idx_fleet_attendance_status
      ON fleet_driver_attendance(status);
  `);

  /* Additive links to common masters. SQLite has no ADD COLUMN IF NOT EXISTS,
     so inspect the table first. These are the only ALTER statements and they
     only add a nullable column to the Fleet tables created above. */
  const addColumn = (table, column, definition) => {
    const exists = db
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .some((row) => row.name === column);
    if (!exists) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  };
  addColumn('fleet_areas', 'address_id', 'INTEGER REFERENCES common_addresses(id)');
  addColumn('fleet_areas', 'unit_id', 'INTEGER REFERENCES units(id)');
  addColumn('fleet_vehicles', 'asset_id', 'INTEGER REFERENCES assets(id)');
  addColumn('fleet_vehicles', 'unit_id', 'INTEGER REFERENCES units(id)');
  addColumn('fleet_trips', 'start_km', 'REAL');
  addColumn('fleet_trips', 'end_km', 'REAL');
  addColumn('fleet_trips', 'unit_id', 'INTEGER REFERENCES units(id)');
  addColumn('fleet_trips', 'forwarded_at', 'TEXT');
  addColumn('fleet_vehicle_expenses', 'unit_id', 'INTEGER REFERENCES units(id)');

  /* Vehicle compliance details are stored on the vehicle master, which is the
     record the transport incharge maintains. All additions are nullable or
     defaulted so existing vehicles keep working unchanged. */
  const vehicleTextColumns = [
    'engine_no', 'chassis_no', 'fuel_type', 'insurance_policy_no', 'insurer',
    'permit_no', 'permit_authority', 'road_tax_no', 'pollution_cert_no',
  ];
  for (const column of vehicleTextColumns) addColumn('fleet_vehicles', column, "TEXT NOT NULL DEFAULT ''");
  const vehicleDateColumns = [
    'registered_date', 'registration_expiry_date', 'insurance_date', 'insurance_expiry_date',
    'permit_date', 'permit_expiry_date', 'road_tax_date', 'road_tax_expiry_date',
    'pollution_cert_date', 'pollution_expiry_date',
  ];
  for (const column of vehicleDateColumns) addColumn('fleet_vehicles', column, 'TEXT');

  /* A NULL unit_id means "shared by all units", so older Fleet records stay
     visible while newly created records follow the caller's unit membership. */
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_fleet_areas_unit ON fleet_areas(unit_id);
    CREATE INDEX IF NOT EXISTS idx_fleet_vehicles_unit ON fleet_vehicles(unit_id);
    CREATE INDEX IF NOT EXISTS idx_fleet_trips_unit ON fleet_trips(unit_id);
    CREATE INDEX IF NOT EXISTS idx_fleet_trips_forwarded ON fleet_trips(forwarded_at);
    CREATE INDEX IF NOT EXISTS idx_fleet_expenses_unit ON fleet_vehicle_expenses(unit_id);
    CREATE INDEX IF NOT EXISTS idx_fleet_vehicle_reg_expiry ON fleet_vehicles(registration_expiry_date);
    CREATE INDEX IF NOT EXISTS idx_fleet_vehicle_insurance_expiry ON fleet_vehicles(insurance_expiry_date);
    CREATE INDEX IF NOT EXISTS idx_fleet_vehicle_permit_expiry ON fleet_vehicles(permit_expiry_date);
    CREATE INDEX IF NOT EXISTS idx_fleet_vehicle_tax_expiry ON fleet_vehicles(road_tax_expiry_date);
    CREATE INDEX IF NOT EXISTS idx_fleet_vehicle_pollution_expiry ON fleet_vehicles(pollution_expiry_date);
  `);

  /* Audited marker for the shared-master design. INSERT OR IGNORE keeps restarts
     repeat-safe and never overwrites an administrator's settings. */
  db.prepare(
    'INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)'
  ).run('migration.fleet_shared_masters.v1', new Date().toISOString());
  db.prepare(
    'INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)'
  ).run('migration.fleet_operations.v1', new Date().toISOString());
  db.prepare(
    'INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)'
  ).run('migration.fleet_vehicle_compliance.v1', new Date().toISOString());
  db.prepare(
    'INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)'
  ).run('migration.fleet_booking_workflow.v1', new Date().toISOString());
  db.prepare(
    'INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)'
  ).run('migration.fleet_driver_attendance.v1', new Date().toISOString());
}

function ensureTripLocationColumns(db) {
  const info = db.prepare('PRAGMA table_info(fleet_trips)').all();
  const names = new Set(info.map((c) => c.name));
  const requiredLocationColumns = [
    'pickup_name', 'pickup_address', 'pickup_lat', 'pickup_lng', 'pickup_maps_url',
    'drop_name', 'drop_address', 'drop_lat', 'drop_lng', 'drop_maps_url',
  ];
  const pickupNotNull = Number(info.find((c) => c.name === 'pickup_id')?.notnull || 0) > 0;
  const dropNotNull = Number(info.find((c) => c.name === 'drop_id')?.notnull || 0) > 0;
  const hasAllLocationColumns = requiredLocationColumns.every((name) => names.has(name));
  if (!pickupNotNull && !dropNotNull && hasAllLocationColumns) return;

  const old = (name, fallback = 'NULL') => (names.has(name) ? `t.${name}` : fallback);
  const ref = (name) => `CASE WHEN ${old(name)} IS NULL THEN NULL
      WHEN EXISTS (SELECT 1 FROM fleet_areas a WHERE a.id = ${old(name)}) THEN ${old(name)}
      ELSE NULL END`;

  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`
      CREATE TABLE fleet_trips_map_new (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        booking_no      TEXT NOT NULL UNIQUE,
        requester_id    INTEGER NOT NULL REFERENCES users(id),
        department_id   INTEGER REFERENCES departments(id),
        pickup_id       INTEGER REFERENCES fleet_areas(id),
        drop_id         INTEGER REFERENCES fleet_areas(id),
        pickup_name     TEXT NOT NULL DEFAULT '',
        pickup_address  TEXT NOT NULL DEFAULT '',
        pickup_lat      REAL,
        pickup_lng      REAL,
        pickup_maps_url TEXT NOT NULL DEFAULT '',
        drop_name       TEXT NOT NULL DEFAULT '',
        drop_address    TEXT NOT NULL DEFAULT '',
        drop_lat        REAL,
        drop_lng        REAL,
        drop_maps_url   TEXT NOT NULL DEFAULT '',
        start_at        TEXT NOT NULL,
        end_at          TEXT NOT NULL,
        passengers      INTEGER NOT NULL DEFAULT 1,
        purpose         TEXT NOT NULL DEFAULT '',
        status          TEXT NOT NULL DEFAULT 'PENDING'
                          CHECK (status IN ('PENDING','ASSIGNED','REJECTED','COMPLETED')),
        vehicle_id      INTEGER REFERENCES fleet_vehicles(id),
        driver_id       INTEGER REFERENCES employees(id),
        remarks         TEXT NOT NULL DEFAULT '',
        start_km        REAL,
        end_km          REAL,
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL,
        assigned_at     TEXT,
        completed_at    TEXT
      );

      INSERT INTO fleet_trips_map_new (
        id, booking_no, requester_id, department_id, pickup_id, drop_id,
        pickup_name, pickup_address, pickup_lat, pickup_lng, pickup_maps_url,
        drop_name, drop_address, drop_lat, drop_lng, drop_maps_url,
        start_at, end_at, passengers, purpose, status, vehicle_id, driver_id,
        remarks, start_km, end_km, created_at, updated_at, assigned_at, completed_at
      )
      SELECT
        t.id, t.booking_no, t.requester_id, t.department_id, ${ref('pickup_id')}, ${ref('drop_id')},
        COALESCE(${old('pickup_name')}, pa.name, ''),
        COALESCE(${old('pickup_address')}, pa.address, ''),
        COALESCE(${old('pickup_lat')}, pa.lat),
        COALESCE(${old('pickup_lng')}, pa.lng),
        COALESCE(${old('pickup_maps_url')}, pa.maps_url, ''),
        COALESCE(${old('drop_name')}, da.name, ''),
        COALESCE(${old('drop_address')}, da.address, ''),
        COALESCE(${old('drop_lat')}, da.lat),
        COALESCE(${old('drop_lng')}, da.lng),
        COALESCE(${old('drop_maps_url')}, da.maps_url, ''),
        t.start_at, t.end_at,
        COALESCE(${old('passengers', '1')}, 1),
        COALESCE(${old('purpose', "''")}, ''),
        COALESCE(${old('status', "'PENDING'")}, 'PENDING'),
        t.vehicle_id, t.driver_id,
        COALESCE(${old('remarks', "''")}, ''),
        ${old('start_km')}, ${old('end_km')},
        t.created_at, t.updated_at, t.assigned_at, t.completed_at
      FROM fleet_trips t
      LEFT JOIN fleet_areas pa ON pa.id = t.pickup_id
      LEFT JOIN fleet_areas da ON da.id = t.drop_id;

      DROP TABLE fleet_trips;
      ALTER TABLE fleet_trips_map_new RENAME TO fleet_trips;

      CREATE INDEX IF NOT EXISTS idx_fleet_trips_status ON fleet_trips(status);
      CREATE INDEX IF NOT EXISTS idx_fleet_trips_requester ON fleet_trips(requester_id);
      CREATE INDEX IF NOT EXISTS idx_fleet_trips_window ON fleet_trips(start_at, end_at);
    `);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  db.prepare(
    'INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)'
  ).run('migration.fleet_map_locations.v1', new Date().toISOString());
}

module.exports = { ensureFleetSchema };
