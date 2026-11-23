'use strict';

const crypto = require('node:crypto');
const { HttpError } = require('./http');

const SESSION_COOKIE = 'abmdas_session';
/* Idle timeout: every authenticated request extends the session by 30 minutes. */
const SESSION_IDLE_MS = 30 * 60 * 1000;
const SESSION_MAX_AGE_SECONDS = Math.ceil(SESSION_IDLE_MS / 1000);

function hashPassword(password, salt) {
  const useSalt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), useSalt, 64).toString('hex');
  return `${useSalt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const candidate = crypto.scryptSync(String(password), salt, 64);
  const expected = Buffer.from(hash, 'hex');
  if (candidate.length !== expected.length) return false;
  return crypto.timingSafeEqual(candidate, expected);
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function randomToken() {
  return crypto.randomBytes(32).toString('hex');
}

function sign(payload, secret) {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

function sessionExpiry() {
  return new Date(Date.now() + SESSION_IDLE_MS).toISOString();
}

function createSession(db, userId, ip, userAgent) {
  const token = randomToken();
  const now = new Date().toISOString();
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);
  db.prepare(
    'INSERT INTO sessions(token_hash, user_id, ip, user_agent, created_at, expires_at) VALUES (?,?,?,?,?,?)'
  ).run(sha256(token), userId, ip || '', userAgent || '', now, sessionExpiry());
  return token;
}

function destroySession(db, token) {
  if (!token) return;
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
}

function permissionsForRole(db, roleId) {
  return db
    .prepare('SELECT permission_key FROM role_permissions WHERE role_id = ?')
    .all(roleId)
    .map((r) => r.permission_key);
}

function loadUser(db, userId) {
  const user = db
    .prepare(
      `SELECT u.*, r.code AS role_code, r.name AS role_name, un.name AS unit_name
         FROM users u JOIN roles r ON r.id = u.role_id
         LEFT JOIN units un ON un.id = u.unit_id
        WHERE u.id = ?`
    )
    .get(userId);
  if (!user) return null;
  user.permissions = permissionsForRole(db, user.role_id);
  return user;
}

function userFromRequest(db, req) {
  const token = req.cookies[SESSION_COOKIE];
  if (!token) return null;
  const row = db
    .prepare('SELECT user_id, expires_at FROM sessions WHERE token_hash = ?')
    .get(sha256(token));
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
    return null;
  }
  /* Sliding expiry: any authenticated request starts a fresh 30-minute window. */
  db.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?').run(sessionExpiry(), sha256(token));
  return loadUser(db, row.user_id);
}

function can(user, permission) {
  if (!user) return false;
  if (user.role_code === 'super_admin') return true;
  return (user.permissions || []).includes(permission);
}

function guard(user, permission) {
  if (!can(user, permission)) {
    const err = new Error('You do not have permission to perform this action.');
    err.status = 403;
    throw err;
  }
}

/* Roles at administrator level and above see bills from every unit together.
   Everyone else sees only their own unit. */
const ALL_UNIT_ROLES = ['super_admin', 'administrator', 'admin_pastor', 'accounts_viewer'];

function seesAllUnits(user) {
  return !!user && ALL_UNIT_ROLES.includes(user.role_code);
}

/* The units a request works in. The X-Unit-Id header may hold one or more comma
   separated unit ids; every one must be a membership of the user. Without the
   header, administrator-level roles get all their units and everyone else gets
   their home unit. */
function currentUnitIds(db, user, requested) {
  if (!user) return [];
  if (requested !== undefined && requested !== null && String(requested).trim() !== '') {
    const ids = [...new Set(String(requested).split(',').map((v) => Number(v.trim())))];
    if (ids.some((id) => !Number.isInteger(id) || id <= 0)) throw new HttpError(400, 'Invalid unit selection.');
    for (const id of ids) {
      const member = db.prepare('SELECT 1 FROM user_units WHERE user_id = ? AND unit_id = ?').get(user.id, id);
      if (!member) throw new HttpError(403, 'You are not a member of the selected unit.');
    }
    return ids;
  }
  if (seesAllUnits(user)) return memberUnitIds(db, user.id);
  if (user.unit_id) return [Number(user.unit_id)];
  const first = db.prepare('SELECT unit_id FROM user_units WHERE user_id = ? ORDER BY unit_id LIMIT 1').get(user.id);
  return first ? [Number(first.unit_id)] : [];
}

function memberUnitIds(db, userId) {
  return db
    .prepare('SELECT unit_id FROM user_units WHERE user_id = ? ORDER BY unit_id')
    .all(userId)
    .map((r) => Number(r.unit_id));
}

function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    employeeId: user.employee_id,
    name: user.name,
    department: user.department,
    designation: user.designation,
    mobile: user.mobile,
    email: user.email,
    username: user.username,
    roleId: user.role_id,
    roleCode: user.role_code,
    roleName: user.role_name,
    unitId: user.unit_id,
    unitName: user.unit_name,
    status: user.status,
    signatureImage: user.signature_image,
    permissions: user.role_code === 'super_admin' ? ['*'] : user.permissions,
    lastLoginAt: user.last_login_at,
    mustChangePassword: !!user.must_change_password,
  };
}

module.exports = {
  SESSION_COOKIE,
  SESSION_IDLE_MS,
  SESSION_MAX_AGE_SECONDS,
  seesAllUnits,
  currentUnitIds,
  memberUnitIds,
  hashPassword,
  verifyPassword,
  sha256,
  sign,
  createSession,
  destroySession,
  loadUser,
  userFromRequest,
  can,
  guard,
  publicUser,
  permissionsForRole,
  randomToken,
};
