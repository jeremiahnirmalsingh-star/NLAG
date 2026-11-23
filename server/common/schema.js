'use strict';

/**
 * Additive shared schema for common entity documents.
 *
 * Rules for this file (same as the fleet / procurement foundations):
 *  - only CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS
 *  - never drop, alter or rename an existing ABMDAS table
 *  - no demo records are seeded; the settings marker is insert-or-ignore
 */

function ensureCommonSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS common_documents (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_type  TEXT NOT NULL,
      entity_id    INTEGER NOT NULL,
      kind         TEXT NOT NULL DEFAULT 'document',
      title        TEXT NOT NULL DEFAULT '',
      file_name    TEXT NOT NULL,
      stored_name  TEXT NOT NULL,
      mime_type    TEXT NOT NULL,
      size_bytes   INTEGER NOT NULL,
      uploaded_by  INTEGER REFERENCES users(id),
      created_at   TEXT NOT NULL,
      deleted_at   TEXT,
      deleted_by   INTEGER REFERENCES users(id)
    );

    CREATE INDEX IF NOT EXISTS idx_common_documents_entity
      ON common_documents(entity_type, entity_id);

    /* One address/master map point per place, reused by units, stores,
       purchase orders, fleet areas and any future module. */
    CREATE TABLE IF NOT EXISTS common_addresses (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      label      TEXT NOT NULL,
      line1      TEXT NOT NULL DEFAULT '',
      line2      TEXT NOT NULL DEFAULT '',
      city       TEXT NOT NULL DEFAULT '',
      state      TEXT NOT NULL DEFAULT '',
      pincode    TEXT NOT NULL DEFAULT '',
      country    TEXT NOT NULL DEFAULT 'India',
      lat        REAL,
      lng        REAL,
      maps_url   TEXT NOT NULL DEFAULT '',
      active     INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT,
      deleted_by INTEGER REFERENCES users(id)
    );

    CREATE INDEX IF NOT EXISTS idx_common_addresses_label
      ON common_addresses(label COLLATE NOCASE);
  `);

  /* Repeat-safe marker; never overwrites an administrator's settings. */
  db.prepare(
    'INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)'
  ).run('migration.common_documents.v1', new Date().toISOString());
}

module.exports = { ensureCommonSchema };
