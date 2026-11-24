'use strict';

const http = require('node:http');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const { db, DB_FILE } = require('./db');
const auth = require('./auth');
const { createRouter } = require('./router');
const {
  parseCookies, readJson, sendJson, sendError, serveStatic, clientIp, setCookie, HttpError,
} = require('./http');
const { ensureFallbackChain } = require('./workflow');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

// Guarantee the system always has an approval chain and a verification secret.
ensureFallbackChain(db);
{
  const crypto = require('node:crypto');
  const existing = db.prepare("SELECT value FROM settings WHERE key = 'app.secret'").get();
  if (!existing) {
    db.prepare("INSERT INTO settings(key, value) VALUES ('app.secret', ?)").run(crypto.randomBytes(32).toString('hex'));
  }
}

const router = createRouter();
require('./routes/auth')(router);
require('./routes/users')(router);
require('./routes/units')(router);
require('./routes/vendors')(router);
require('./routes/procurement')(router);
require('./routes/procurement-masters')(router);
require('./routes/procurement-requisitions')(router);
require('./routes/procurement-sourcing')(router);
require('./routes/procurement-orders')(router);
require('./routes/procurement-invoices')(router);
require('./routes/procurement-assets')(router);
require('./routes/procurement-service-acceptances')(router);
require('./routes/procurement-asset-classes')(router);
require('./routes/procurement-alerts')(router);
require('./routes/fleet')(router);
require('./routes/common-masters').registerCommonMastersRoutes(router);
require('./routes/documents')(router);
require('./routes/bills')(router);
require('./routes/advances')(router);
require('./routes/imprests')(router);
require('./routes/reimbursements')(router);
require('./routes/handover')(router);
require('./routes/files')(router);
require('./routes/dashboard')(router);
require('./routes/reports')(router);
require('./routes/admin')(router);

const ALLOWED_ORIGINS = String(process.env.ABMDAS_ALLOWED_ORIGINS || '')
  .split(',')
  .map((value) => value.trim().replace(/\/$/, ''))
  .filter(Boolean);

function sameOrigin(req) {
  const originHeader = req.headers.origin;
  if (!originHeader) return true; // non-browser clients / same-origin navigation

  let origin;
  try {
    origin = new URL(originHeader);
  } catch {
    return false;
  }

  // Explicit public origins are the reliable source of truth when the app is
  // behind Vercel and a tunnel/proxy that rewrites X-Forwarded-Host.
  if (ALLOWED_ORIGINS.includes(origin.origin)) return true;

  // Fallback for direct/local requests and single-proxy setups. Forwarded
  // hosts can be comma-separated chains, so accept any hop, not just the first.
  const hostCandidates = [
    req.headers.host,
    ...String(req.headers['x-forwarded-host'] || '')
      .split(',')
      .map((value) => value.trim()),
  ].filter(Boolean);

  return hostCandidates.includes(origin.host);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = decodeURI(url.pathname);

  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  /* Origin-only referrer satisfies OpenStreetMap/Nominatim usage policies. */
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; "
      + "img-src 'self' data: blob: https://tile.openstreetmap.org https://*.tile.openstreetmap.org; "
      + "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
      + "script-src 'self'; "
      + "font-src 'self' data: https://fonts.gstatic.com; "
      + "connect-src 'self' https://photon.komoot.io https://nominatim.openstreetmap.org; "
      + "frame-ancestors 'self'; base-uri 'self'; form-action 'self'"
  );

  if (!pathname.startsWith('/api/')) {
    if (req.method === 'GET' || req.method === 'HEAD') {
      if (serveStatic(PUBLIC_DIR, pathname === '/' ? '/index.html' : pathname, res)) return;
      if (serveStatic(PUBLIC_DIR, '/index.html', res)) return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }

  const matched = router.match(req.method, pathname);
  if (!matched) {
    sendJson(res, 404, { error: 'Endpoint not found.' });
    return;
  }

  try {
    if (!['GET', 'HEAD'].includes(req.method) && !sameOrigin(req)) {
      throw new HttpError(403, 'Cross-origin request blocked.');
    }

    req.cookies = parseCookies(req.headers.cookie);
    const user = auth.userFromRequest(db, req);
    if (user) {
      const token = req.cookies[auth.SESSION_COOKIE];
      const secure = req.headers['x-forwarded-proto'] === 'https';
      setCookie(res, auth.SESSION_COOKIE, token, { maxAge: auth.SESSION_MAX_AGE_SECONDS, secure });
    }
    if (matched.route.auth && !user) {
      throw new HttpError(401, 'Your session has expired. Please sign in again.');
    }

    const ctx = {
      req,
      res,
      db,
      params: matched.params,
      query: Object.fromEntries(url.searchParams.entries()),
      body: ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) ? await readJson(req) : {},
      ip: clientIp(req),
      user,
      unitIds: user ? auth.currentUnitIds(db, user, req.headers['x-unit-id']) : [],
      unitId: null,
    };
    ctx.unitId = ctx.unitIds[0] ?? null;

    const result = await matched.route.handler(ctx);

    if (res.writableEnded) return;
    if (result && result.__raw) {
      res.writeHead(200, {
        'Content-Type': result.__raw.contentType,
        ...result.__raw.headers,
        'Cache-Control': 'no-store',
      });
      res.end(result.__raw.body);
      return;
    }
    sendJson(res, 200, result === undefined ? { ok: true } : result);
  } catch (err) {
    if (!res.writableEnded) sendError(res, err);
    else console.error(err);
  }
});

server.on('clientError', (err, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});

/* Prevent the server from crashing on unhandled errors. */
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
});

/* Health check endpoint for monitoring. */
router.get('/api/health', async (ctx) => {
  try {
    ctx.db.prepare('SELECT 1').get();
    return { ok: true, uptime: Math.round(process.uptime()), timestamp: new Date().toISOString() };
  } catch (e) {
    throw new HttpError(503, 'Database unavailable.');
  }
}, { auth: false });

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const net of list || []) {
      if (net.family === 'IPv4' && !net.internal) out.push(net.address);
    }
  }
  return out;
}

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  ABMDAS \u2014 Administration Bill Management & Digital Approval System');
  console.log('  ----------------------------------------------------------------');
  console.log(`  Local:    http://localhost:${PORT}`);
  for (const ip of lanAddresses()) console.log(`  Network:  http://${ip}:${PORT}`);
  console.log(`  Database: ${DB_FILE}`);
  console.log('');
});

function shutdown() {
  console.log('\nShutting down...');
  server.close(() => {
    try {
      db.close();
    } catch {
      /* ignore */
    }
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

void fs;
