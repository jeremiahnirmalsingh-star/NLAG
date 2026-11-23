'use strict';

const auth = require('../auth');
const { setCookie, HttpError } = require('../http');
const { audit, nowIso } = require('../util');
const alerts = require('../procurement/alerts');

module.exports = function registerAuthRoutes(router) {
  router.post(
    '/api/auth/login',
    async (ctx) => {
      const { username, password } = ctx.body || {};
      if (!username || !password) throw new HttpError(400, 'Username and password are required.');

      const user = ctx.db
        .prepare(
          `SELECT u.*, r.code AS role_code, r.name AS role_name
             FROM users u JOIN roles r ON r.id = u.role_id
            WHERE u.username = ? COLLATE NOCASE`
        )
        .get(String(username).trim());

      const genericError = new HttpError(401, 'Invalid username or password.');

      if (!user) throw genericError;
      if (user.status === 'Locked') throw new HttpError(403, 'This account is locked. Contact the Super Administrator.');
      if (user.status !== 'Active') throw new HttpError(403, 'This account is inactive. Contact the Super Administrator.');

      if (user.locked_until && new Date(user.locked_until).getTime() > Date.now()) {
        const mins = Math.ceil((new Date(user.locked_until).getTime() - Date.now()) / 60000);
        throw new HttpError(423, `Too many failed attempts. Try again in ${mins} minute(s).`);
      }

      if (!auth.verifyPassword(password, user.password_hash)) {
        const attempts = user.failed_attempts + 1;
        const lockedUntil =
          attempts >= 5 ? new Date(Date.now() + 15 * 60 * 1000).toISOString() : null;
        ctx.db
          .prepare('UPDATE users SET failed_attempts = ?, locked_until = ? WHERE id = ?')
          .run(attempts, lockedUntil, user.id);
        await new Promise((r) => setTimeout(r, 150));
        throw genericError;
      }

      ctx.db
        .prepare('UPDATE users SET failed_attempts = 0, locked_until = NULL, last_login_at = ? WHERE id = ?')
        .run(nowIso(), user.id);

      const token = auth.createSession(ctx.db, user.id, ctx.ip, ctx.req.headers['user-agent']);
      const secure = ctx.req.headers['x-forwarded-proto'] === 'https';
      setCookie(ctx.res, auth.SESSION_COOKIE, token, { maxAge: auth.SESSION_MAX_AGE_SECONDS, secure });

      const full = auth.loadUser(ctx.db, user.id);
      audit({ ...ctx, user: full }, 'LOGIN', 'user', user.id, null, { username: user.username });
      /* Run alert checks in the background on login (non-blocking). */
      setImmediate(() => {
        try { alerts.runAll(ctx.db); } catch (e) { /* ignore */ }
      });
      return { user: auth.publicUser(full), sessionTimeoutMs: auth.SESSION_IDLE_MS };
    },
    { auth: false }
  );

  router.post('/api/auth/logout', async (ctx) => {
    auth.destroySession(ctx.db, ctx.req.cookies[auth.SESSION_COOKIE]);
    setCookie(ctx.res, auth.SESSION_COOKIE, '', { maxAge: 0 });
    return { ok: true };
  });

  router.get('/api/auth/me', async (ctx) => ({
    user: auth.publicUser(ctx.user),
    sessionTimeoutMs: auth.SESSION_IDLE_MS,
  }));

  router.post('/api/auth/change-password', async (ctx) => {
    const { currentPassword, newPassword } = ctx.body || {};
    if (!newPassword || String(newPassword).length < 8) {
      throw new HttpError(400, 'New password must be at least 8 characters long.');
    }
    if (!auth.verifyPassword(currentPassword || '', ctx.user.password_hash)) {
      throw new HttpError(400, 'Current password is incorrect.');
    }
    ctx.db
      .prepare('UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = ? WHERE id = ?')
      .run(auth.hashPassword(newPassword), nowIso(), ctx.user.id);
    audit(ctx, 'CHANGE_PASSWORD', 'user', ctx.user.id);
    auth.destroySession(ctx.db, ctx.req.cookies[auth.SESSION_COOKIE]);
    setCookie(ctx.res, auth.SESSION_COOKIE, '', { maxAge: 0 });
    return { ok: true };
  });

  router.post('/api/auth/profile', async (ctx) => {
    const { name, mobile, email, signatureImage } = ctx.body || {};
    if (!name) throw new HttpError(400, 'Name is required.');
    ctx.db
      .prepare('UPDATE users SET name = ?, mobile = ?, email = ?, signature_image = ?, updated_at = ? WHERE id = ?')
      .run(String(name).trim(), mobile || '', email || '', signatureImage || null, nowIso(), ctx.user.id);
    audit(ctx, 'UPDATE_PROFILE', 'user', ctx.user.id);
    const full = auth.loadUser(ctx.db, ctx.user.id);
    return { user: auth.publicUser(full) };
  });
};
