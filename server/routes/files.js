'use strict';

const fs = require('node:fs');
const path = require('node:path');
const auth = require('../auth');
const { HttpError } = require('../http');
const { DATA_DIR } = require('../db');

const KINDS = {
  'bill-document': {
    table: 'bill_attachments',
    permission: 'bill.view',
    entity: 'bill',
  },
  'vendor-document': {
    table: 'vendor_documents',
    permission: 'vendor.view',
    entity: 'vendor',
  },
  'item-attachment': {
    table: 'item_attachments',
    permission: 'item.view',
    entity: 'item',
    folder: 'items',
  },
};

module.exports = function registerFileRoutes(router) {
  router.get('/api/files/:kind/:id', async (ctx) => {
    const kind = KINDS[ctx.params.kind];
    if (!kind) throw new HttpError(404, 'Unknown file type.');
    auth.guard(ctx.user, kind.permission);

    const row = ctx.db.prepare(`SELECT * FROM ${kind.table} WHERE id = ?`).get(Number(ctx.params.id));
    if (!row || row.deleted_at) throw new HttpError(404, 'File not found.');

    const folder = kind.folder || (ctx.params.kind === 'bill-document' ? 'bills' : 'vendors');
    const filePath = path.join(DATA_DIR, 'uploads', folder, row.stored_name);
    if (!fs.existsSync(filePath)) throw new HttpError(404, 'The stored file is missing.');

    const data = fs.readFileSync(filePath);
    const safeName = encodeURIComponent(row.file_name);
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

  void auth;
};
