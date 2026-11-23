'use strict';

const auth = require('../auth');
const { HttpError, saveUpload, fileUrlFor } = require('../http');
const { audit, nowIso, nextVendorCode, badRequest } = require('../util');

const { DATA_DIR } = require('../db');
const path = require('node:path');

const UPLOAD_DIR = path.join(DATA_DIR, 'uploads', 'vendors');

function vendorOut(v) {
  return {
    id: v.id,
    code: v.code,
    name: v.name,
    category: v.category,
    contactPerson: v.contact_person,
    designation: v.designation,
    mobile: v.mobile,
    email: v.email,
    gstNumber: v.gst_number,
    panNumber: v.pan_number,
    addressLine1: v.address_line1,
    addressLine2: v.address_line2,
    city: v.city,
    state: v.state,
    pincode: v.pincode,
    bankName: v.bank_name,
    accountNumber: v.account_number,
    ifscCode: v.ifsc_code,
    accountHolder: v.account_holder,
    status: v.status,
    createdAt: v.created_at,
    updatedAt: v.updated_at,
    billCount: v.bill_count,
    outstandingAdvance: v.outstanding_advance || 0,
  };
}

function vendorFromBody(b) {
  return [
    b.name, b.category, b.contactPerson, b.designation, b.mobile, b.email,
    b.gstNumber, b.panNumber, b.addressLine1, b.addressLine2, b.city, b.state,
    b.pincode, b.bankName, b.accountNumber, b.ifscCode, b.accountHolder,
    b.status || 'Active',
  ];
}

function saveVendorDocuments(ctx, vendorId, documents) {
  if (!Array.isArray(documents)) return;
  const stmt = ctx.db.prepare(
    `INSERT INTO vendor_documents(vendor_id, doc_type, file_name, stored_name, mime_type, size, uploaded_by, uploaded_at)
     VALUES (?,?,?,?,?,?,?,?)`
  );
  for (const doc of documents) {
    if (!doc || !doc.data || !doc.name) continue;
    const saved = saveUpload(doc, UPLOAD_DIR);
    stmt.run(vendorId, doc.docType || 'Other', doc.name, saved.stored, doc.mime || 'application/octet-stream',
      saved.size, ctx.user.id, nowIso());
  }
}

module.exports = function registerVendorRoutes(router) {
  router.get('/api/vendors', async (ctx) => {
    auth.guard(ctx.user, 'vendor.view');
    const { search = '', status = '', category = '' } = ctx.query;
    let sql = `
      SELECT v.*,
        (SELECT COUNT(*) FROM bills b WHERE b.vendor_id = v.id) AS bill_count,
        (SELECT COALESCE(SUM(a.amount - a.adjusted_amount),0) FROM advances a
          WHERE a.vendor_id = v.id AND a.status <> 'Closed') AS outstanding_advance
        FROM vendors v WHERE 1=1`;
    const params = [];
    if (search) {
      sql += ' AND (v.name LIKE ? OR v.code LIKE ? OR v.gst_number LIKE ? OR v.contact_person LIKE ?)';
      const like = `%${search}%`;
      params.push(like, like, like, like);
    }
    if (status) {
      sql += ' AND v.status = ?';
      params.push(status);
    }
    if (category) {
      sql += ' AND v.category = ?';
      params.push(category);
    }
    sql += ' ORDER BY v.name ASC';
    return { vendors: ctx.db.prepare(sql).all(...params).map(vendorOut) };
  });

  router.get('/api/vendors/:id', async (ctx) => {
    auth.guard(ctx.user, 'vendor.view');
    const id = Number(ctx.params.id);
    const v = ctx.db.prepare('SELECT * FROM vendors WHERE id = ?').get(id);
    if (!v) throw new HttpError(404, 'Vendor not found.');
    const documents = ctx.db
      .prepare('SELECT * FROM vendor_documents WHERE vendor_id = ? ORDER BY id DESC')
      .all(id)
      .map((d) => ({
        id: d.id,
        docType: d.doc_type,
        fileName: d.file_name,
        mimeType: d.mime_type,
        size: d.size,
        uploadedAt: d.uploaded_at,
        url: fileUrlFor('vendor-document', d.id),
      }));
    const advances = ctx.db
      .prepare('SELECT * FROM advances WHERE vendor_id = ? ORDER BY advance_date DESC')
      .all(id)
      .map((a) => ({
        id: a.id,
        advanceNo: a.advance_no,
        advanceDate: a.advance_date,
        amount: a.amount,
        adjustedAmount: a.adjusted_amount,
        balance: Math.round((a.amount - a.adjusted_amount) * 100) / 100,
        status: a.status,
        purpose: a.purpose,
      }));
    const bills = ctx.db
      .prepare(
        `SELECT b.id, b.bill_no, b.invoice_number, b.invoice_date, b.net_amount, b.status, b.created_at
           FROM bills b WHERE b.vendor_id = ? ORDER BY b.id DESC LIMIT 50`
      )
      .all(id);
    return { vendor: vendorOut(v), documents, advances, bills };
  });

  router.post('/api/vendors', async (ctx) => {
    if (
      !auth.can(ctx.user, 'vendor.create') && !auth.can(ctx.user, 'bill.create') &&
      !auth.can(ctx.user, 'po.manage') && !auth.can(ctx.user, 'requisition.create') &&
      !auth.can(ctx.user, 'sourcing.manage') && !auth.can(ctx.user, 'advance.create')
    ) {
      throw new HttpError(403, 'You do not have permission to perform this action.');
    }
    const b = ctx.body || {};
    if (!b.name) throw badRequest('Vendor name is required.');
    const dup = ctx.db.prepare('SELECT id FROM vendors WHERE name = ? COLLATE NOCASE').get(String(b.name).trim());
    if (dup) throw new HttpError(409, 'A vendor with this name already exists.');
    const code = nextVendorCode();
    const now = nowIso();
    const res = ctx.db
      .prepare(
        `INSERT INTO vendors(code, name, category, contact_person, designation, mobile, email,
           gst_number, pan_number, address_line1, address_line2, city, state, pincode,
           bank_name, account_number, ifsc_code, account_holder, status, created_by, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(code, ...vendorFromBody(b), ctx.user.id, now, now);
    const id = Number(res.lastInsertRowid);
    saveVendorDocuments(ctx, id, b.documents);
    audit(ctx, 'CREATE', 'vendor', id, null, { code, name: b.name });
    return { id, code };
  });

  router.put('/api/vendors/:id', async (ctx) => {
    auth.guard(ctx.user, 'vendor.edit');
    const id = Number(ctx.params.id);
    const vendor = ctx.db.prepare('SELECT * FROM vendors WHERE id = ?').get(id);
    if (!vendor) throw new HttpError(404, 'Vendor not found.');
    const b = ctx.body || {};
    if (!b.name) throw badRequest('Vendor name is required.');
    const dup = ctx.db
      .prepare('SELECT id FROM vendors WHERE name = ? COLLATE NOCASE AND id <> ?')
      .get(String(b.name).trim(), id);
    if (dup) throw new HttpError(409, 'Another vendor with this name already exists.');
    ctx.db
      .prepare(
        `UPDATE vendors SET name=?, category=?, contact_person=?, designation=?, mobile=?, email=?,
           gst_number=?, pan_number=?, address_line1=?, address_line2=?, city=?, state=?, pincode=?,
           bank_name=?, account_number=?, ifsc_code=?, account_holder=?, status=?, updated_at=?
         WHERE id=?`
      )
      .run(...vendorFromBody(b), nowIso(), id);
    saveVendorDocuments(ctx, id, b.documents);
    audit(ctx, 'UPDATE', 'vendor', id, vendorOut(vendor), { name: b.name, status: b.status });
    return { ok: true };
  });

  router.delete('/api/vendors/:id', async (ctx) => {
    auth.guard(ctx.user, 'vendor.delete');
    const id = Number(ctx.params.id);
    const vendor = ctx.db.prepare('SELECT * FROM vendors WHERE id = ?').get(id);
    if (!vendor) throw new HttpError(404, 'Vendor not found.');
    const bills = ctx.db.prepare('SELECT COUNT(*) AS c FROM bills WHERE vendor_id = ?').get(id).c;
    const advances = ctx.db.prepare('SELECT COUNT(*) AS c FROM advances WHERE vendor_id = ?').get(id).c;
    if (bills > 0 || advances > 0) {
      ctx.db.prepare("UPDATE vendors SET status = 'Inactive', updated_at = ? WHERE id = ?").run(nowIso(), id);
      audit(ctx, 'DEACTIVATE', 'vendor', id, { status: vendor.status }, { status: 'Inactive' });
      return { ok: true, deactivated: true };
    }
    ctx.db.prepare('DELETE FROM vendors WHERE id = ?').run(id);
    audit(ctx, 'DELETE', 'vendor', id, { code: vendor.code, name: vendor.name });
    return { ok: true };
  });

  router.post('/api/vendors/:id/documents', async (ctx) => {
    auth.guard(ctx.user, 'vendor.edit');
    const id = Number(ctx.params.id);
    const vendor = ctx.db.prepare('SELECT id FROM vendors WHERE id = ?').get(id);
    if (!vendor) throw new HttpError(404, 'Vendor not found.');
    saveVendorDocuments(ctx, id, [ctx.body]);
    audit(ctx, 'UPLOAD_DOCUMENT', 'vendor', id, null, { fileName: ctx.body.name });
    return { ok: true };
  });

  router.delete('/api/vendors/:id/documents/:docId', async (ctx) => {
    auth.guard(ctx.user, 'vendor.edit');
    const id = Number(ctx.params.id);
    const doc = ctx.db
      .prepare('SELECT * FROM vendor_documents WHERE id = ? AND vendor_id = ?')
      .get(Number(ctx.params.docId), id);
    if (!doc) throw new HttpError(404, 'Document not found.');
    ctx.db.prepare('DELETE FROM vendor_documents WHERE id = ?').run(doc.id);
    audit(ctx, 'DELETE_DOCUMENT', 'vendor', id, { fileName: doc.file_name });
    return { ok: true };
  });
};
