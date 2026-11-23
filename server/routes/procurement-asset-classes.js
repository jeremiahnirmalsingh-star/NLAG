'use strict';

/**
 * Asset-class defaults API — Phase 5b.
 *
 * An asset class is an asset-type item category. Defaults set here apply to
 * every item in the class unless the item overrides them.
 */

const auth = require('../auth');
const { audit, nowIso } = require('../util');
const { rowOr404 } = require('../procurement/shared');
const assetSettings = require('../procurement/asset-settings');

function classCategory(ctx, id) {
  return rowOr404(
    ctx.db
      .prepare(
        `SELECT c.*, p.name AS parent_name
           FROM item_categories c
           LEFT JOIN item_categories p ON p.id = c.parent_id
          WHERE c.id = ? AND c.deleted_at IS NULL AND c.item_type = 'asset'`
      )
      .get(Number(id)),
    'Asset class not found.'
  );
}

function classOut(ctx, cat) {
  const row = ctx.db.prepare('SELECT * FROM asset_class_defaults WHERE category_id = ?').get(cat.id);
  const defaults = assetSettings.classDefaultsFromRow(row);
  const out = {
    id: cat.id,
    code: cat.code || '',
    name: cat.name,
    parentId: cat.parent_id,
    parentName: cat.parent_name || '',
    saved: !!row,
    updatedAt: row ? row.updated_at : null,
    defaults: {},
  };
  for (const f of assetSettings.FIELDS) out.defaults[f.key] = defaults[f.key];
  return out;
}

module.exports = function registerAssetClassRoutes(router) {
  router.get('/api/procurement/asset-classes', async (ctx) => {
    auth.guard(ctx.user, 'item.view');
    const cats = ctx.db
      .prepare(
        `SELECT c.*, p.name AS parent_name
           FROM item_categories c
           LEFT JOIN item_categories p ON p.id = c.parent_id
          WHERE c.item_type = 'asset' AND c.deleted_at IS NULL AND c.active = 1
          ORDER BY COALESCE(p.name, c.name) COLLATE NOCASE, c.parent_id IS NOT NULL, c.name COLLATE NOCASE`
      )
      .all();
    const departments = ctx.db.prepare('SELECT id, name FROM departments WHERE active = 1 ORDER BY name').all();
    return { classes: cats.map((c) => classOut(ctx, c)), departments };
  });

  router.get('/api/procurement/asset-classes/:id', async (ctx) => {
    auth.guard(ctx.user, 'item.view');
    const cat = classCategory(ctx, ctx.params.id);
    return { class: classOut(ctx, cat) };
  });

  router.put('/api/procurement/asset-classes/:id', async (ctx) => {
    auth.guard(ctx.user, 'item.manage');
    const cat = classCategory(ctx, ctx.params.id);
    const before = classOut(ctx, cat);
    const now = nowIso();
    const next = assetSettings.saveClassDefaults(ctx.db, cat.id, ctx.body || {}, ctx.user.id, now);
    audit(ctx, 'UPDATE', 'asset_class', cat.id, { name: cat.name, defaults: before.defaults }, { name: cat.name, defaults: next });
    return { ok: true };
  });
};
