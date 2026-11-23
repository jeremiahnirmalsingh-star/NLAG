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
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      reg_no     TEXT NOT NULL UNIQUE,
      model      TEXT NOT NULL,
      seats      INTEGER NOT NULL DEFAULT 1,
      status     TEXT NOT NULL DEFAULT 'ACTIVE'
                   CHECK (status IN ('ACTIVE','IN_SERVICE')),
      active     INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT,
      deleted_by INTEGER REFERENCES users(id)
    );

    /* Named fleet_trips so an older database can keep its legacy table
       physically (no drop/rename) while all live code uses these correct
       shared-master references. */
    CREATE TABLE IF NOT EXISTS fleet_trips (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      booking_no    TEXT NOT NULL UNIQUE,
      requester_id  INTEGER NOT NULL REFERENCES users(id),
      department_id INTEGER REFERENCES departments(id),
      pickup_id     INTEGER NOT NULL REFERENCES fleet_areas(id),
      drop_id       INTEGER NOT NULL REFERENCES fleet_areas(id),
      start_at      TEXT NOT NULL,
      end_at        TEXT NOT NULL,
      passengers    INTEGER NOT NULL DEFAULT 1,
      purpose       TEXT NOT NULL DEFAULT '',
      status        TEXT NOT NULL DEFAULT 'PENDING'
                      CHECK (status IN ('PENDING','ASSIGNED','REJECTED','COMPLETED')),
      vehicle_id    INTEGER REFERENCES fleet_vehicles(id),
      driver_id     INTEGER REFERENCES employees(id),
      remarks       TEXT NOT NULL DEFAULT '',
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL,
      assigned_at   TEXT,
      completed_at  TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_fleet_trips_status ON fleet_trips(status);
    CREATE INDEX IF NOT EXISTS idx_fleet_trips_requester ON fleet_trips(requester_id);
    CREATE INDEX IF NOT EXISTS idx_fleet_trips_window ON fleet_trips(start_at, end_at);
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
  addColumn('fleet_vehicles', 'asset_id', 'INTEGER REFERENCES assets(id)');

  /* Audited marker for the shared-master design. INSERT OR IGNORE keeps restarts
     repeat-safe and never overwrites an administrator's settings. */
  db.prepare(
    'INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)'
  ).run('migration.fleet_shared_masters.v1', new Date().toISOString());
}

module.exports = { ensureFleetSchema };
