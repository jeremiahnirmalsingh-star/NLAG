'use strict';

const auth = require('../auth');
const { audit, nowIso } = require('../util');
const alerts = require('../procurement/alerts');

module.exports = function registerProcurementAlertRoutes(router) {
  /* Run all alert checks and generate notifications. */
  router.post('/api/procurement/alerts/run', async (ctx) => {
    auth.guard(ctx.user, 'item.manage');
    const result = alerts.runAll(ctx.db);
    audit(ctx, 'RUN_ALERTS', 'alert', null, null, result);
    return { ok: true, ...result };
  });

  /* List recent alerts/notifications for the current user. */
  router.get('/api/procurement/alerts', async (ctx) => {
    auth.guard(ctx.user, 'item.view');
    const rows = ctx.db
      .prepare(
        `SELECT id, title, message, link, is_read, created_at
           FROM notifications
          WHERE user_id = ?
          ORDER BY created_at DESC
          LIMIT 50`
      )
      .all(ctx.user.id);
    return { alerts: rows };
  });
};