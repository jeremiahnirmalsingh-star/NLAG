'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const JSON_LIMIT = 30 * 1024 * 1024; // 30 MB (attachments are sent base64 encoded)

class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      out[key] = value;
    }
  }
  return out;
}

function readBody(req, limit = JSON_LIMIT) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new HttpError(413, 'Request payload too large. Maximum size is 30 MB.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const raw = await readBody(req);
  if (!raw.length) return {};
  const text = raw.toString('utf8');
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'Invalid JSON body.');
  }
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload === undefined ? null : payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

function sendError(res, err) {
  const status = Number(err && err.status) || 500;
  if (status >= 500) console.error(err);
  sendJson(res, status, {
    error: status >= 500 ? 'Internal server error.' : err.message,
    details: err && err.details,
  });
}

function setCookie(res, name, value, opts = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${opts.path || '/'}`);
  if (opts.maxAge !== undefined) parts.push(`Max-Age=${opts.maxAge}`);
  parts.push('HttpOnly');
  parts.push('SameSite=Lax');
  if (opts.secure) parts.push('Secure');
  appendHeader(res, 'Set-Cookie', parts.join('; '));
}

function appendHeader(res, name, value) {
  const existing = res.getHeader(name);
  if (!existing) res.setHeader(name, value);
  else if (Array.isArray(existing)) res.setHeader(name, [...existing, value]);
  else res.setHeader(name, [existing, value]);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.pdf': 'application/pdf',
  '.map': 'application/json',
};

function safeJoin(root, urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  const target = path.normalize(path.join(root, decoded));
  if (!target.startsWith(path.normalize(root))) return null;
  return target;
}

function serveStatic(root, urlPath, res) {
  let rel = urlPath === '/' ? '/index.html' : urlPath;
  let file = safeJoin(root, rel);
  if (!file) return false;
  let stat = null;
  try {
    stat = fs.statSync(file);
    if (stat.isDirectory()) {
      file = path.join(file, 'index.html');
      stat = fs.statSync(file);
    }
  } catch {
    return false;
  }
  const ext = path.extname(file).toLowerCase();
  const data = fs.readFileSync(file);
  const etag = '"' + crypto.createHash('sha1').update(data).digest('hex') + '"';
  const headers = {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': data.length,
    ETag: etag,
    'Cache-Control': ['.html', '.js', '.css'].includes(ext) ? 'no-cache' : 'public, max-age=86400',
    'X-Content-Type-Options': 'nosniff',
  };
  if (res.req && res.req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    res.end();
    return true;
  }
  res.writeHead(200, headers);
  res.end(data);
  return true;
}

function fileUrlFor(kind, id) {
  return `/api/files/${kind}/${id}`;
}

function saveUpload(file, folder) {
  const dir = path.join(folder);
  fs.mkdirSync(dir, { recursive: true });
  const ext = path.extname(file.name || '').toLowerCase().slice(0, 10);
  const stored = crypto.randomBytes(16).toString('hex') + ext;
  const buffer = Buffer.from(file.data || '', 'base64');
  fs.writeFileSync(path.join(dir, stored), buffer);
  return { stored, size: buffer.length };
}

function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return String(forwarded).split(',')[0].trim();
  return req.socket.remoteAddress || '';
}

module.exports = {
  HttpError,
  parseCookies,
  readBody,
  readJson,
  sendJson,
  sendError,
  setCookie,
  serveStatic,
  safeJoin,
  saveUpload,
  fileUrlFor,
  clientIp,
  MIME,
};
