'use strict';

/**
 * Asset-class defaults and item-level overrides — Phase 5b.
 *
 * Resolution order for every field: item override -> asset class default ->
 * built-in default. A class is an asset-type item category (or its parent).
 * Additive only: both tables are new and no existing table is altered.
 */

const { badRequest } = require('../util');

const ENUMS = {
  expenseClassification: ['asset', 'expense'],
  depreciationMethod: ['straight_line', 'written_down_value', 'not_depreciated'],
};

const FIELDS = [
  { key: 'expenseClassification', column: 'expense_classification', type: 'enum', builtin: 'asset', label: 'Expense classification' },
  { key: 'budgetCategory', column: 'budget_category', type: 'text', builtin: '', label: 'Budget category' },
  { key: 'depreciationMethod', column: 'depreciation_method', type: 'enum', builtin: 'straight_line', label: 'Depreciation method' },
  { key: 'usefulLifeYears', column: 'useful_life_years', type: 'int', min: 1, max: 50, builtin: 5, label: 'Useful life (years)' },
  { key: 'depreciationApplicable', column: 'depreciation_applicable', type: 'bool', builtin: true, label: 'Depreciation applicable' },
  { key: 'warrantyMonths', column: 'warranty_months', type: 'int', min: 0, max: 240, builtin: 0, label: 'Warranty period (months)' },
  { key: 'amcApplicable', column: 'amc_applicable', type: 'bool', builtin: false, label: 'AMC applicable' },
  { key: 'serialRequired', column: 'serial_required', type: 'bool', builtin: false, label: 'Serial number required' },
  { key: 'assetTagRequired', column: 'asset_tag_required', type: 'bool', builtin: true, label: 'Asset tag required' },
  { key: 'defaultDepartmentId', column: 'default_department_id', type: 'int', min: 1, max: 1e9, builtin: null, label: 'Default department' },
];

function normalize(field, value) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (field.type === 'enum') {
    const v = String(value);
    if (!ENUMS[field.key].includes(v)) throw badRequest(`${field.label}: choose a valid option.`);
    return v;
  }
  if (field.type === 'text') return String(value).trim().slice(0, 100);
  if (field.type === 'int') {
    const n = Number(value);
    if (!Number.isInteger(n) || n < field.min || n > field.max) {
      throw badRequest(`${field.label} must be a whole number from ${field.min} to ${field.max}.`);
    }
    return n;
  }
  if (field.type === 'bool') {
    if (value === true || value === 1 || value === '1' || value === 'yes' || value === 'true') return true;
    if (value === false || value === 0 || value === '0' || value === 'no' || value === 'false') return false;
    throw badRequest(`${field.label}: choose yes or no.`);
  }
  return value;
}

function toStored(field, value) {
  if (value === null || value === undefined) return null;
  if (field.type === 'bool') return value ? 1 : 0;
  return value;
}

function fromRow(field, raw) {
  if (raw === null || raw === undefined) return null;
  if (field.type === 'bool') return !!raw;
  if (field.type === 'int') return Number(raw);
  return raw;
}

function ensureDepartment(db, id) {
  const dept = db.prepare('SELECT id FROM departments WHERE id = ? AND active = 1').get(id);
  if (!dept) throw badRequest('Default department was not found or is inactive.');
}

function classRowFor(db, categoryId, subCategoryId) {
  for (const id of [subCategoryId, categoryId]) {
    if (!id) continue;
    const row = db.prepare('SELECT * FROM asset_class_defaults WHERE category_id = ?').get(id);
    if (row) return row;
  }
  return null;
}

function resolveAssetSettings(db, itemId) {
  const item = db.prepare('SELECT id, category_id, sub_category_id FROM items WHERE id = ?').get(Number(itemId));
  if (!item) return null;
  const override = db.prepare('SELECT * FROM item_asset_settings WHERE item_id = ?').get(item.id) || {};
  const cls = classRowFor(db, item.category_id, item.sub_category_id);
  const effective = {};
  const source = {};
  const overrides = {};
  for (const f of FIELDS) {
    const o = override[f.column];
    overrides[f.key] = o === undefined || o === null ? null : fromRow(f, o);
    if (o !== undefined && o !== null) {
      effective[f.key] = fromRow(f, o);
      source[f.key] = 'item';
      continue;
    }
    const c = cls ? cls[f.column] : null;
    if (c !== undefined && c !== null) {
      effective[f.key] = fromRow(f, c);
      source[f.key] = 'class';
      continue;
    }
    effective[f.key] = f.builtin;
    source[f.key] = 'default';
  }
  return { effective, overrides, source };
}

function saveItemOverrides(db, itemId, input, now) {
  const src = input && typeof input === 'object' ? input : {};
  const cols = [];
  const vals = [];
  for (const f of FIELDS) {
    const v = normalize(f, src[f.key]);
    if (v === undefined) continue;
    if (f.key === 'defaultDepartmentId' && v !== null) ensureDepartment(db, v);
    cols.push(f.column);
    vals.push(toStored(f, v));
  }
  if (!cols.length) return;
  db.prepare(
    'INSERT INTO item_asset_settings(item_id, created_at, updated_at) VALUES (?,?,?) ON CONFLICT(item_id) DO NOTHING'
  ).run(itemId, now, now);
  const sets = cols.map((c) => `${c} = ?`).join(', ');
  db.prepare(`UPDATE item_asset_settings SET ${sets}, updated_at = ? WHERE item_id = ?`).run(...vals, now, itemId);
}

function clearItemOverrides(db, itemId, now) {
  const sets = FIELDS.map((f) => `${f.column} = NULL`).join(', ');
  db.prepare(`UPDATE item_asset_settings SET ${sets}, updated_at = ? WHERE item_id = ?`).run(now, itemId);
}

function classDefaultsFromRow(row) {
  const out = {};
  for (const f of FIELDS) out[f.key] = row ? fromRow(f, row[f.column]) ?? f.builtin : f.builtin;
  return out;
}

function saveClassDefaults(db, categoryId, input, userId, now) {
  const src = input && typeof input === 'object' ? input : {};
  const existing = db.prepare('SELECT * FROM asset_class_defaults WHERE category_id = ?').get(categoryId);
  const current = classDefaultsFromRow(existing);
  const next = {};
  for (const f of FIELDS) {
    const v = normalize(f, src[f.key]);
    next[f.key] = v === undefined ? current[f.key] : v;
    if (next[f.key] === null && f.builtin !== null) next[f.key] = f.builtin;
    if (f.type === 'text' && next[f.key] === null) next[f.key] = '';
  }
  if (next.defaultDepartmentId !== null) ensureDepartment(db, next.defaultDepartmentId);

  const cols = FIELDS.map((f) => f.column);
  const vals = FIELDS.map((f) => toStored(f, next[f.key]));
  db.prepare(
    `INSERT INTO asset_class_defaults(category_id, ${cols.join(', ')}, updated_by, created_at, updated_at)
     VALUES (?, ${cols.map(() => '?').join(', ')}, ?, ?, ?)
     ON CONFLICT(category_id) DO UPDATE SET ${cols.map((c) => `${c} = excluded.${c}`).join(', ')},
       updated_by = excluded.updated_by, updated_at = excluded.updated_at`
  ).run(categoryId, ...vals, userId, now, now);
  return next;
}

module.exports = {
  FIELDS,
  normalize,
  resolveAssetSettings,
  saveItemOverrides,
  clearItemOverrides,
  saveClassDefaults,
  classDefaultsFromRow,
  classRowFor,
};
