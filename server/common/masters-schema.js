'use strict';

/**
 * Additive schema shared by the bills, procurement and fleet masters screens.
 *
 * Rules for this file:
 *  - only CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS
 *  - never rename, drop or alter an existing ABMDAS table
 *  - the settings marker makes the migration repeat-safe; no records are seeded
 */

function ensureCommonMastersSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS working_days (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      day_date TEXT NOT NULL UNIQUE,
      day_type TEXT NOT NULL CHECK (day_type IN ('HOLIDAY','WORKING_SATURDAY')),
      title TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_working_days_date ON working_days(day_date);
  `);

  db.prepare(
    "INSERT OR IGNORE INTO settings(key, value) VALUES ('migration.common_working_days.v1', '1')"
  ).run();
}

module.exports = { ensureCommonMastersSchema };
