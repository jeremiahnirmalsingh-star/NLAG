'use strict';

const auth = require('../auth');
const { round2 } = require('../util');
const { unitScope, inList } = require('../procurement/shared');

function monthKey(dateStr) {
  return String(dateStr || '').slice(0, 7);
}

module.exports = function registerDashboardRoutes(router) {
  router.get('/api/dashboard', async (ctx) => {
    auth.guard(ctx.user, 'dashboard.view');
    const db = ctx.db;

    const billCounts = db
      .prepare(
        `SELECT
           COUNT(*) AS total,
           SUM(CASE WHEN status='draft' THEN 1 ELSE 0 END) AS draft,
           SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS pending,
           SUM(CASE WHEN status='approved' THEN 1 ELSE 0 END) AS approved,
           SUM(CASE WHEN status='rejected' THEN 1 ELSE 0 END) AS rejected,
           SUM(CASE WHEN status='returned' THEN 1 ELSE 0 END) AS returned,
           SUM(CASE WHEN status='hold' THEN 1 ELSE 0 END) AS hold,
           COALESCE(SUM(CASE WHEN status IN ('pending','approved') THEN net_amount ELSE 0 END),0) AS pipeline_value,
           COALESCE(SUM(CASE WHEN status='approved' THEN net_amount ELSE 0 END),0) AS approved_value
         FROM bills`
      )
      .get();

    const stageCounts = db
      .prepare(
        `SELECT bs.role_id, r.code AS role_code, r.name AS role_name, COUNT(*) AS count
           FROM bill_stages bs
           JOIN bills b ON b.id = bs.bill_id
           JOIN roles r ON r.id = bs.role_id
          WHERE bs.status = 'pending' AND b.status = 'pending'
          GROUP BY bs.role_id, r.code, r.name
          ORDER BY count DESC`
      )
      .all();

    const vendorCounts = db
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN status='Active' THEN 1 ELSE 0 END) AS active,
                SUM(CASE WHEN status='Inactive' THEN 1 ELSE 0 END) AS inactive,
                SUM(CASE WHEN status='Blacklisted' THEN 1 ELSE 0 END) AS blacklisted
           FROM vendors`
      )
      .get();

    const advanceTotals = db
      .prepare(
        `SELECT COUNT(*) AS count,
                COALESCE(SUM(amount),0) AS issued,
                COALESCE(SUM(amount - adjusted_amount),0) AS outstanding
           FROM advances WHERE status <> 'Closed'`
      )
      .get();

    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);
    const adjustedThisMonth = db
      .prepare(
        `SELECT COALESCE(SUM(l.credit - l.debit),0) AS total FROM advance_ledger l
          WHERE l.txn_type = 'Invoice Adjustment' AND l.created_at >= ?`
      )
      .get(monthStart.toISOString()).total;

    const handoverCounts = db
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN status='forwarded' THEN 1 ELSE 0 END) AS pending,
                SUM(CASE WHEN status='acknowledged' THEN 1 ELSE 0 END) AS acknowledged
           FROM handovers`
      )
      .get();

    const pendingForMe = db
      .prepare(
        `SELECT COUNT(*) AS c FROM bills b
           JOIN bill_stages bs ON bs.bill_id = b.id AND bs.status = 'pending'
          WHERE b.status = 'pending' AND (bs.role_id = ? OR ? = 'super_admin')`
      )
      .get(ctx.user.role_id, ctx.user.role_code).c;

    /* Monthly trend: last 12 months */
    const months = [];
    const cursor = new Date();
    cursor.setDate(1);
    for (let i = 11; i >= 0; i -= 1) {
      const d = new Date(cursor.getFullYear(), cursor.getMonth() - i, 1);
      months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
    }
    const billRows = db
      .prepare("SELECT entry_date, net_amount FROM bills WHERE status <> 'cancelled'")
      .all();
    const trendMap = Object.fromEntries(months.map((m) => [m, { count: 0, value: 0 }]));
    for (const row of billRows) {
      const key = monthKey(row.entry_date);
      if (trendMap[key]) {
        trendMap[key].count += 1;
        trendMap[key].value = round2(trendMap[key].value + row.net_amount);
      }
    }
    const monthlyTrend = months.map((m) => ({
      month: m,
      label: new Date(`${m}-01T00:00:00`).toLocaleString('en-IN', { month: 'short', year: '2-digit' }),
      ...trendMap[m],
    }));

    const deptRows = db
      .prepare(
        `SELECT COALESCE(d.name,'Unassigned') AS name, COUNT(b.id) AS count, COALESCE(SUM(b.net_amount),0) AS value
           FROM bills b LEFT JOIN departments d ON d.id = b.department_id
          WHERE b.status NOT IN ('draft','cancelled')
          GROUP BY d.name ORDER BY value DESC`
      )
      .all();

    const vendorRows = db
      .prepare(
        `SELECT v.id, v.name, COUNT(b.id) AS count, COALESCE(SUM(b.net_amount),0) AS value
           FROM bills b JOIN vendors v ON v.id = b.vendor_id
          WHERE b.status NOT IN ('draft','cancelled')
          GROUP BY v.id ORDER BY value DESC LIMIT 8`
      )
      .all();

    const turnaround = db
      .prepare(
        `SELECT AVG((julianday(approved_at) - julianday(submitted_at)) * 24) AS hours,
                COUNT(*) AS count
           FROM bills WHERE approved_at IS NOT NULL AND submitted_at IS NOT NULL`
      )
      .get();

    const recentBills = db
      .prepare(
        `SELECT b.id, b.bill_no, b.invoice_number, b.net_amount, b.status, b.created_at,
                v.name AS vendor_name
           FROM bills b JOIN vendors v ON v.id = b.vendor_id ORDER BY b.id DESC LIMIT 8`
      )
      .all();

    const recentActivity = db
      .prepare(
        `SELECT a.action, a.entity_type, a.entity_id, a.created_at, u.name AS user_name
           FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id
          ORDER BY a.id DESC LIMIT 8`
      )
      .all();

    /* Procurement aggregates (Phase 3). */
    const poCounts = db
      .prepare(
        `SELECT COUNT(*) AS total,
                COALESCE(SUM(CASE WHEN status='draft' THEN 1 ELSE 0 END),0) AS draft,
                COALESCE(SUM(CASE WHEN status='issued' THEN 1 ELSE 0 END),0) AS issued,
                COALESCE(SUM(CASE WHEN status='partially_received' THEN 1 ELSE 0 END),0) AS partial,
                COALESCE(SUM(CASE WHEN status='received' THEN 1 ELSE 0 END),0) AS received,
                COALESCE(SUM(CASE WHEN status='closed' THEN 1 ELSE 0 END),0) AS closed,
                COALESCE(SUM(CASE WHEN status='cancelled' THEN 1 ELSE 0 END),0) AS cancelled,
                COALESCE(SUM(total_amount),0) AS total_value
           FROM purchase_orders WHERE deleted_at IS NULL`
      )
      .get();
    const grnCounts = db
      .prepare(
        `SELECT COUNT(*) AS total,
                COALESCE(SUM(CASE WHEN status='draft' THEN 1 ELSE 0 END),0) AS draft,
                COALESCE(SUM(CASE WHEN status='posted' THEN 1 ELSE 0 END),0) AS posted,
                COALESCE(SUM(CASE WHEN status='cancelled' THEN 1 ELSE 0 END),0) AS cancelled
           FROM grns`
      )
      .get();
    const invoiceCounts = db
      .prepare(
        `SELECT COUNT(*) AS total,
                COALESCE(SUM(CASE WHEN status='draft' THEN 1 ELSE 0 END),0) AS draft,
                COALESCE(SUM(CASE WHEN status='validated' THEN 1 ELSE 0 END),0) AS validated,
                COALESCE(SUM(CASE WHEN status='billed' THEN 1 ELSE 0 END),0) AS billed,
                COALESCE(SUM(CASE WHEN status='cancelled' THEN 1 ELSE 0 END),0) AS cancelled,
                COALESCE(SUM(net_amount),0) AS total_value
           FROM invoices WHERE deleted_at IS NULL`
      )
      .get();
    const stockValue = db
      .prepare(`SELECT COALESCE(SUM(quantity),0) AS qty FROM stock_balances`)
      .get();
    const assetCounts = db
      .prepare(
        `SELECT COUNT(*) AS total,
                COALESCE(SUM(CASE WHEN status='created' THEN 1 ELSE 0 END),0) AS registered,
                COALESCE(SUM(CASE WHEN status IN ('allocated','in_use') THEN 1 ELSE 0 END),0) AS in_custody,
                COALESCE(SUM(CASE WHEN status='under_maintenance' THEN 1 ELSE 0 END),0) AS maintenance,
                COALESCE(SUM(CASE WHEN status='under_repair' THEN 1 ELSE 0 END),0) AS repair,
                COALESCE(SUM(CASE WHEN status='missing' THEN 1 ELSE 0 END),0) AS missing,
                COALESCE(SUM(CASE WHEN status='disposed' THEN 1 ELSE 0 END),0) AS disposed,
                COALESCE(SUM(purchase_value),0) AS total_value
           FROM assets WHERE deleted_at IS NULL`
      )
      .get();
    const requisitionCounts = db
      .prepare(
        `SELECT COUNT(*) AS total,
                COALESCE(SUM(CASE WHEN status='draft' THEN 1 ELSE 0 END),0) AS draft,
                COALESCE(SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END),0) AS pending,
                COALESCE(SUM(CASE WHEN status='approved' THEN 1 ELSE 0 END),0) AS approved,
                COALESCE(SUM(CASE WHEN status='rejected' THEN 1 ELSE 0 END),0) AS rejected,
                COALESCE(SUM(CASE WHEN status='closed' THEN 1 ELSE 0 END),0) AS closed
           FROM requisitions WHERE deleted_at IS NULL`
      )
      .get();

    return {
      bills: { ...billCounts, pendingForMe, stages: stageCounts },
      vendors: vendorCounts,
      advances: { ...advanceTotals, adjustedThisMonth: round2(adjustedThisMonth) },
      handover: handoverCounts,
      monthlyTrend,
      departmentWise: deptRows,
      vendorWise: vendorRows,
      turnaround: {
        hours: turnaround.hours ? round2(turnaround.hours) : 0,
        count: turnaround.count,
      },
      recentBills,
      recentActivity,
      procurement: {
        purchaseOrders: poCounts,
        goodsReceipts: grnCounts,
        invoices: invoiceCounts,
        stock: { quantity: stockValue.qty },
        assets: assetCounts,
        requisitions: requisitionCounts,
      },
    };
  });

  /* Dedicated procurement dashboard (Phase 3). */
  router.get('/api/procurement/dashboard', async (ctx) => {
    auth.guard(ctx.user, 'dashboard.view');
    const db = ctx.db;
    const ids = unitScope(ctx);
    const ph = inList(ids);
    const poByStatus = db.prepare(`SELECT status, COUNT(*) AS count, COALESCE(SUM(total_amount),0) AS value FROM purchase_orders WHERE deleted_at IS NULL AND unit_id IN (${ph}) GROUP BY status`).all(...ids);
    const topVendors = db.prepare(`SELECT v.id, v.name, COUNT(p.id) AS po_count, COALESCE(SUM(p.total_amount),0) AS po_value FROM purchase_orders p JOIN vendors v ON v.id=p.vendor_id WHERE p.deleted_at IS NULL AND p.unit_id IN (${ph}) GROUP BY v.id ORDER BY po_value DESC LIMIT 8`).all(...ids);
    const recentPos = db.prepare(`SELECT p.id, p.po_no, p.status, p.total_amount, p.po_date, v.name AS vendor_name FROM purchase_orders p JOIN vendors v ON v.id=p.vendor_id WHERE p.deleted_at IS NULL AND p.unit_id IN (${ph}) ORDER BY p.id DESC LIMIT 8`).all(...ids);
    const assetByStatus = db.prepare(`SELECT status, COUNT(*) AS count, COALESCE(SUM(purchase_value),0) AS value FROM assets WHERE deleted_at IS NULL AND unit_id IN (${ph}) GROUP BY status`).all(...ids);
    const stockByStore = db.prepare(`SELECT s.id, s.name, COALESCE(SUM(sb.quantity),0) AS quantity FROM stores s LEFT JOIN stock_balances sb ON sb.store_id=s.id WHERE s.deleted_at IS NULL AND s.unit_id IN (${ph}) GROUP BY s.id ORDER BY s.name`).all(...ids);
    const openReqs = db.prepare(`SELECT status, COUNT(*) AS count FROM requisitions WHERE deleted_at IS NULL AND unit_id IN (${ph}) GROUP BY status`).all(...ids);
    const grnCounts = db.prepare(`SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN status='posted' THEN 1 ELSE 0 END),0) AS posted FROM grns WHERE unit_id IN (${ph})`).get(...ids);
    const invoiceCounts = db.prepare(`SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN status='billed' THEN 1 ELSE 0 END),0) AS billed, COALESCE(SUM(net_amount),0) AS value FROM invoices WHERE deleted_at IS NULL AND unit_id IN (${ph})`).get(...ids);
    return {
      poByStatus, topVendors, recentPos, assetByStatus, stockByStore, openReqs,
      grns: { total: grnCounts.total || 0, posted: grnCounts.posted || 0 },
      invoices: { total: invoiceCounts.total || 0, billed: invoiceCounts.billed || 0, value: round2(invoiceCounts.value || 0) },
    };
  });
};
