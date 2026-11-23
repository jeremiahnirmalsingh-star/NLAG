'use strict';

const auth = require('../auth');
const { HttpError } = require('../http');
const { audit, nowIso, today, round2, nextServiceAcceptanceNo } = require('../util');
const { unitScope, inList, optionalText, optionalId, optionalDate, transaction, pageParams, rowOr404 } = require('../procurement/shared');

module.exports = function registerServiceAcceptanceRoutes(router) {
  /* ------------------------------ Meta ---------------------------- */
  router.get('/api/procurement/service-acceptances/meta', async (ctx) => {
    auth.guard(ctx.user, 'invoice.view');
    const ids = unitScope(ctx);
    const ph = inList(ids);
    const purchaseOrders = ctx.db
      .prepare(
        `SELECT p.id, p.po_no, p.status, p.vendor_id, v.name AS vendor_name, p.unit_id
           FROM purchase_orders p JOIN vendors v ON v.id = p.vendor_id
          WHERE p.deleted_at IS NULL AND p.status IN ('issued','partially_received')
            AND p.unit_id IN (${ph})
            AND EXISTS (SELECT 1 FROM po_items pi JOIN items i ON i.id = pi.item_id
                          WHERE pi.po_id = p.id AND i.item_type = 'service')
          ORDER BY p.po_date DESC, p.id DESC`
      )
      .all(...ids)
      .map((row) => ({ id: row.id, poNo: row.po_no, status: row.status, vendorId: row.vendor_id, vendorName: row.vendor_name, unitId: row.unit_id }));
    return { purchaseOrders, today: today() };
  });

  /* ------------------------------ List ---------------------------- */
  router.get('/api/procurement/service-acceptances', async (ctx) => {
    auth.guard(ctx.user, 'invoice.view');
    const ids = unitScope(ctx);
    const q = ctx.query || {};
    const where = [`sa.unit_id IN (${inList(ids)})`, 'sa.deleted_at IS NULL'];
    const params = [...ids];
    if (q.poId) { where.push('sa.po_id = ?'); params.push(Number(q.poId)); }
    if (q.status) { where.push('sa.status = ?'); params.push(String(q.status)); }
    const { page, pageSize, offset } = pageParams(q);
    const total = ctx.db.prepare(`SELECT COUNT(*) AS c FROM service_acceptances sa WHERE ${where.join(' AND ')}`).get(...params).c;
    const rows = ctx.db
      .prepare(
        `SELECT sa.*, p.po_no, v.name AS vendor_name, u.name AS unit_name,
                (SELECT COUNT(*) FROM service_acceptance_items sai WHERE sai.sa_id = sa.id) AS item_count
           FROM service_acceptances sa
           JOIN purchase_orders p ON p.id = sa.po_id
           JOIN vendors v ON v.id = p.vendor_id
           JOIN units u ON u.id = sa.unit_id
          WHERE ${where.join(' AND ')}
          ORDER BY sa.id DESC LIMIT ? OFFSET ?`
      )
      .all(...params, pageSize, offset)
      .map((r) => ({
        id: r.id, saNo: r.sa_no, poId: r.po_id, poNo: r.po_no, vendorName: r.vendor_name,
        unitId: r.unit_id, unitName: r.unit_name, acceptedDate: r.accepted_date,
        status: r.status, itemCount: r.item_count, remarks: r.remarks || '',
        createdAt: r.created_at,
      }));
    return { serviceAcceptances: rows, total, page, pageSize };
  });

  /* ------------------------------ Create -------------------------- */
  router.post('/api/procurement/service-acceptances', async (ctx) => {
    auth.guard(ctx.user, 'invoice.manage');
    const body = ctx.body || {};
    const poId = optionalId(body, 'poId');
    if (!poId) throw new HttpError(400, 'Select a purchase order.');
    const ids = unitScope(ctx);
    const po = rowOr404(
      ctx.db.prepare(`SELECT * FROM purchase_orders WHERE id = ? AND deleted_at IS NULL AND unit_id IN (${inList(ids)})`).get(poId, ...ids),
      'Purchase order not found.'
    );
    if (!['issued', 'partially_received'].includes(po.status)) {
      throw new HttpError(400, 'Service acceptance can only be recorded against an issued purchase order.');
    }
    const acceptedDate = optionalDate(body, 'acceptedDate') || today();
    const list = Array.isArray(body.items) ? body.items : [];
    if (!list.length) throw new HttpError(400, 'Add at least one accepted line.');
    const poItems = ctx.db
      .prepare(`SELECT pi.id, pi.item_id, pi.quantity, pi.unit_price, pi.tax_rate, i.item_type, i.name AS item_name
                FROM po_items pi LEFT JOIN items i ON i.id = pi.item_id
               WHERE pi.po_id = ?`)
      .all(po.id);
    const poLineMap = new Map(poItems.map((l) => [l.id, l]));
    const seen = new Set();
    const lines = list.map((line, index) => {
      const poItemId = Number(line.poItemId);
      const poLine = poLineMap.get(poItemId);
      if (!poLine) throw new HttpError(400, `Line ${index + 1}: purchase order line was not found.`);
      if (seen.has(poItemId)) throw new HttpError(400, `Line ${index + 1}: purchase order line is repeated.`);
      seen.add(poItemId);
      if (poLine.item_type !== 'service') throw new HttpError(400, `Line ${index + 1}: only service items can be accepted here.`);
      const qty = Number(line.acceptedQuantity ?? line.quantity);
      if (!Number.isFinite(qty) || qty <= 0) throw new HttpError(400, `Line ${index + 1}: accepted quantity must be greater than zero.`);
      if (qty > Number(poLine.quantity) + 0.004) throw new HttpError(400, `Line ${index + 1}: accepted quantity exceeds the ordered quantity.`);
      return { poItemId, itemId: poLine.item_id, acceptedQuantity: round2(qty), remarks: optionalText(line, 'remarks', 300) };
    });

    const saNo = nextServiceAcceptanceNo();
    const now = nowIso();
    let id;
    transaction(ctx.db, () => {
      const res = ctx.db
        .prepare(
          `INSERT INTO service_acceptances(sa_no, po_id, unit_id, accepted_date, accepted_by, status, remarks, created_by, created_at, updated_at)
           VALUES (?,?,?,?,?,'accepted',?,?,?,?)`
        )
        .run(saNo, po.id, po.unit_id, acceptedDate, ctx.user.id, optionalText(body, 'remarks', 1000), ctx.user.id, now, now);
      id = Number(res.lastInsertRowid);
      const insert = ctx.db.prepare(
        `INSERT INTO service_acceptance_items(sa_id, po_item_id, item_id, accepted_quantity, remarks, created_at)
         VALUES (?,?,?,?,?,?)`
      );
      for (const line of lines) {
        insert.run(id, line.poItemId, line.itemId, line.acceptedQuantity, line.remarks, now);
      }
    });
    audit(ctx, 'CREATE', 'service_acceptance', id, null, { saNo, poId: po.id, itemCount: lines.length });
    return { id, saNo, status: 'accepted' };
  });

  /* ------------------------------ Detail -------------------------- */
  router.get('/api/procurement/service-acceptances/:id', async (ctx) => {
    auth.guard(ctx.user, 'invoice.view');
    const ids = unitScope(ctx);
    const sa = rowOr404(
      ctx.db
        .prepare(
          `SELECT sa.*, p.po_no, v.name AS vendor_name, u.name AS unit_name
             FROM service_acceptances sa
             JOIN purchase_orders p ON p.id = sa.po_id
             JOIN vendors v ON v.id = p.vendor_id
             JOIN units u ON u.id = sa.unit_id
            WHERE sa.id = ? AND sa.deleted_at IS NULL AND sa.unit_id IN (${inList(ids)})`
        )
        .get(Number(ctx.params.id), ...ids),
      'Service acceptance not found.'
    );
    const items = ctx.db
      .prepare(
        `SELECT sai.*, pi.description, pi.unit_price, pi.tax_rate, i.name AS item_name, i.item_code
           FROM service_acceptance_items sai
           JOIN po_items pi ON pi.id = sai.po_item_id
           LEFT JOIN items i ON i.id = sai.item_id
          WHERE sai.sa_id = ? ORDER BY sai.id`
      )
      .all(sa.id)
      .map((r) => ({
        id: r.id, poItemId: r.po_item_id, itemId: r.item_id, itemName: r.item_name || '',
        itemCode: r.item_code || '', description: r.description || '', quantity: r.accepted_quantity,
        unitPrice: r.unit_price, taxRate: r.tax_rate, remarks: r.remarks || '',
      }));
    return {
      serviceAcceptance: {
        id: sa.id, saNo: sa.sa_no, poId: sa.po_id, poNo: sa.po_no, vendorName: sa.vendor_name,
        unitId: sa.unit_id, unitName: sa.unit_name, acceptedDate: sa.accepted_date,
        status: sa.status, remarks: sa.remarks || '', createdAt: sa.created_at,
      },
      items,
    };
  });
};
