'use strict';

/**
 * Common documents for employees, fleet masters/bookings, departments and users.
 * Files are always uploaded as base64 JSON; the server generates the stored
 * name and never accepts a client-supplied path.
 */

const fs = require('node:fs');
const path = require('node:path');
const auth = require('../auth');
const { HttpError, saveUpload } = require('../http');
const { DATA_DIR } = require('../db');
const { audit, nowIso, badRequest } = require('../util');

const MAX_BYTES = 5 * 1024 * 1024;
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads', 'common-documents');

const MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
const MIME_EXTENSIONS = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'application/pdf': '.pdf',
};

/* No new permission keys are introduced here. Fleet vehicles are masters, so
 * fleet.master.manage is accepted for them in addition to booking management. */
const ENTITY_PERMISSIONS = {
  employee: { view: 'employee.view', manage: ['employee.manage'] },
  fleet_vehicle: { view: 'fleet.view', manage: ['fleet.booking.manage', 'fleet.master.manage'] },
  fleet_booking: { view: 'fleet.view', manage: ['fleet.booking.manage'] },
  department: { view: 'org.view', manage: ['org.manage'] },
  user: { view: 'user.manage', manage: ['user.manage'] },
};

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const STORED_NAME_RE = /^[0-9a-f]{32}\.[a-z0-9]{1,10}$/;

function validateEntityType(value) {
  const entityType = String(value ?? '').trim();
  if (!Object.prototype.hasOwnProperty.call(ENTITY_PERMISSIONS, entityType)) {
    throw badRequest('Unknown entity type.');
  }
  return entityType;
}

function positiveId(value, label) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw badRequest(`A valid ${label} is required.`);
  return id;
}

function requireAuthenticated(ctx) {
  if (!ctx.user) throw new HttpError(401, 'Authentication required.');
}

function requireView(ctx, entityType) {
  requireAuthenticated(ctx);
  const permissions = ENTITY_PERMISSIONS[entityType];
  if (permissions && permissions.view) auth.guard(ctx.user, permissions.view);
}

function canManage(ctx, entityType) {
  const permissions = ENTITY_PERMISSIONS[entityType];
  if (!permissions) return !!ctx.user;
  return (permissions.manage || []).some((permission) => auth.can(ctx.user, permission));
}

function magicMatches(buffer, mime) {
  if (mime === 'image/jpeg') {
    return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  }
  if (mime === 'image/png') {
    return buffer.length >= 8 && buffer.subarray(0, 8).equals(PNG_SIGNATURE);
  }
  if (mime === 'image/webp') {
    return buffer.length >= 12
      && buffer.subarray(0, 4).toString('ascii') === 'RIFF'
      && buffer.subarray(8, 12).toString('ascii') === 'WEBP';
  }
  if (mime === 'application/pdf') {
    return buffer.length >= 5 && buffer.subarray(0, 5).toString('ascii') === '%PDF-';
  }
  return false;
}

function documentOut(row) {
  return {
    id: row.id,
    entityType: row.entity_type,
    entityId: row.entity_id,
    kind: row.kind || 'document',
    title: row.title || '',
    fileName: row.file_name,
    storedName: row.stored_name,
    mimeType: row.mime_type,
    sizeBytes: Number(row.size_bytes) || 0,
    uploadedBy: row.uploaded_by,
    createdAt: row.created_at,
    deletedAt: row.deleted_at || null,
    deletedBy: row.deleted_by || null,
  };
}

function getDocument(ctx, id) {
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(404, 'Document not found.');
  const row = ctx.db
    .prepare('SELECT * FROM common_documents WHERE id = ? AND deleted_at IS NULL')
    .get(id);
  if (!row) throw new HttpError(404, 'Document not found.');
  return row;
}

function registerDocumentsRoutes(router) {
  router.get('/api/documents', async (ctx) => {
    const entityType = validateEntityType(ctx.query?.entityType);
    const entityId = positiveId(ctx.query?.entityId, 'entity id');
    requireView(ctx, entityType);
    const documents = ctx.db
      .prepare(
        `SELECT * FROM common_documents
          WHERE entity_type = ? AND entity_id = ? AND deleted_at IS NULL
          ORDER BY created_at DESC, id DESC`
      )
      .all(entityType, entityId)
      .map(documentOut);
    return { documents };
  });

  router.post('/api/documents', async (ctx) => {
    const body = ctx.body || {};
    const entityType = validateEntityType(body.entityType);
    const entityId = positiveId(body.entityId, 'entity id');
    requireView(ctx, entityType);

    const mime = String(body.mimeType || '').toLowerCase();
    if (!MIME_TYPES.includes(mime)) throw badRequest('Only JPEG, PNG, WebP and PDF files are allowed.');
    const fileName = path.basename(String(body.fileName || '').trim()).slice(0, 200);
    if (!fileName) throw badRequest('Choose a file to upload.');
    const rawData = String(body.data ?? '').trim();
    if (!rawData) throw badRequest('Choose a file to upload.');

    const buffer = Buffer.from(rawData, 'base64');
    if (!buffer.length) throw badRequest('The file is empty.');
    if (buffer.length > MAX_BYTES) throw badRequest('Files must be 5 MB or smaller.');
    if (!magicMatches(buffer, mime)) throw badRequest('The file content does not match its type.');

    /* The extension comes from the validated MIME type, never from the client
     * file name. saveUpload generates a random stored name. */
    const saved = saveUpload(
      { name: `document${MIME_EXTENSIONS[mime]}`, data: rawData },
      UPLOAD_DIR
    );
    const kind = String(body.kind ?? 'document').trim().slice(0, 100) || 'document';
    const title = String(body.title ?? '').trim().slice(0, 200);
    const now = nowIso();
    const result = ctx.db
      .prepare(
        `INSERT INTO common_documents(entity_type, entity_id, kind, title, file_name,
           stored_name, mime_type, size_bytes, uploaded_by, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        entityType, entityId, kind, title, fileName,
        saved.stored, mime, saved.size, ctx.user.id, now
      );
    const id = Number(result.lastInsertRowid);
    const document = documentOut(
      ctx.db.prepare('SELECT * FROM common_documents WHERE id = ?').get(id)
    );
    audit(ctx, 'CREATE', 'common_document', id, null, {
      entityType, entityId, kind, title, fileName, mimeType: mime, sizeBytes: saved.size,
    });
    return { id, document };
  });

  router.delete('/api/documents/:id', async (ctx) => {
    requireAuthenticated(ctx);
    const row = getDocument(ctx, Number(ctx.params.id));
    if (Number(row.uploaded_by) !== Number(ctx.user.id) && !canManage(ctx, row.entity_type)) {
      throw new HttpError(403, 'You do not have permission to delete this document.');
    }
    const now = nowIso();
    ctx.db
      .prepare('UPDATE common_documents SET deleted_at = ?, deleted_by = ? WHERE id = ?')
      .run(now, ctx.user.id, row.id);
    audit(ctx, 'DELETE', 'common_document', row.id, {
      entityType: row.entity_type, entityId: row.entity_id, fileName: row.file_name,
    }, { deletedAt: now });
    return { ok: true };
  });

  router.get('/api/files/common-document/:id', async (ctx) => {
    requireAuthenticated(ctx);
    const row = getDocument(ctx, Number(ctx.params.id));
    requireView(ctx, row.entity_type);

    /* stored_name is generated by saveUpload; validating its shape keeps any
     * corrupted database value from becoming a traversal path. */
    if (!STORED_NAME_RE.test(String(row.stored_name || ''))) {
      throw new HttpError(404, 'The stored file is missing.');
    }
    const filePath = path.join(DATA_DIR, 'uploads', 'common-documents', row.stored_name);
    if (!fs.existsSync(filePath)) throw new HttpError(404, 'The stored file is missing.');

    const data = fs.readFileSync(filePath);
    const safeName = encodeURIComponent(row.file_name || 'document');
    ctx.res.writeHead(200, {
      'Content-Type': row.mime_type || 'application/octet-stream',
      'Content-Length': data.length,
      'Content-Disposition': `inline; filename*=UTF-8''${safeName}`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, max-age=60',
    });
    ctx.res.end(data);
    return undefined;
  });
}

module.exports = registerDocumentsRoutes;
module.exports.registerDocumentsRoutes = registerDocumentsRoutes;
