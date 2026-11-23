import { api } from '../api.js';
import { can } from '../state.js';
import { navigate } from '../router.js';
import { esc, icon, money, num, statusBadge, emptyState } from '../ui.js';

const PO_STATUS = { draft: 'Draft', issued: 'Issued', partially_received: 'Partially Received', received: 'Received', closed: 'Closed', cancelled: 'Cancelled' };
const ASSET_STATUS = { ordered: 'Ordered', received: 'Received', created: 'Registered', allocated: 'Allocated', in_use: 'In Use', under_maintenance: 'Under Maintenance', under_repair: 'Under Repair', transferred: 'Transferred', missing: 'Missing', disposed: 'Disposed' };

export async function render(ctx) {
  ctx.view.innerHTML = `<div class="empty">Loading procurement dashboard\u2026</div>`;
  const data = await api.get('/api/procurement/dashboard');

  const poRows = (data.poByStatus || []).map((r) => `<tr><td>${esc(PO_STATUS[r.status] || r.status)}</td><td class="num">${num(r.count)}</td><td class="num">${money(r.value)}</td></tr>`).join('');
  const assetRows = (data.assetByStatus || []).map((r) => `<tr><td>${esc(ASSET_STATUS[r.status] || r.status)}</td><td class="num">${num(r.count)}</td><td class="num">${money(r.value)}</td></tr>`).join('');
  const reqRows = (data.openReqs || []).map((r) => `<tr><td>${esc(r.status)}</td><td class="num">${num(r.count)}</td></tr>`).join('');
  const vendorRows = (data.topVendors || []).map((r) => `<tr><td>${esc(r.name)}</td><td class="num">${num(r.po_count)}</td><td class="num">${money(r.po_value)}</td></tr>`).join('');
  const recentRows = (data.recentPos || []).map((r) => `<tr><td><a class="strong" href="#/purchase-orders/${r.id}">${esc(r.po_no)}</a></td><td>${esc(r.vendor_name)}</td><td>${statusBadge(r.status, PO_STATUS[r.status] || r.status)}</td><td class="num">${money(r.total_amount)}</td><td class="small">${esc(r.po_date)}</td></tr>`).join('');
  const stockRows = (data.stockByStore || []).map((r) => `<tr><td>${esc(r.name)}</td><td class="num">${num(r.quantity)}</td></tr>`).join('');

  ctx.view.innerHTML = `
    <div class="page-head">
      <div><h1>Procurement Dashboard</h1><div class="sub">Purchase, receiving, inventory and asset overview</div></div>
      <div class="page-actions">
        <a class="btn" href="#/purchase-orders">${icon('briefcase')} Purchase Orders</a>
        <a class="btn" href="#/assets">${icon('layers')} Assets</a>
        <a class="btn" href="#/reports">${icon('chart')} Reports</a>
      </div>
    </div>

    <div class="grid grid-4">
      <div class="card"><div class="kpi"><div class="chip blue">${icon('briefcase')}</div><div><div class="label">Purchase Orders</div><div class="value">${num((data.poByStatus || []).reduce((s, r) => s + r.count, 0))}</div><div class="meta">${money((data.poByStatus || []).reduce((s, r) => s + r.value, 0))} total</div></div></div></div>
      <div class="card"><div class="kpi"><div class="chip teal">${icon('database')}</div><div><div class="label">Goods Receipts</div><div class="value">${num(data.grns.total)}</div><div class="meta">${num(data.grns.posted)} posted</div></div></div></div>
      <div class="card"><div class="kpi"><div class="chip amber">${icon('file')}</div><div><div class="label">Procurement Invoices</div><div class="value">${num(data.invoices.total)}</div><div class="meta">${num(data.invoices.billed)} billed \u00b7 ${money(data.invoices.value)}</div></div></div></div>
      <div class="card"><div class="kpi"><div class="chip purple">${icon('layers')}</div><div><div class="label">Assets</div><div class="value">${num((data.assetByStatus || []).reduce((s, r) => s + r.count, 0))}</div><div class="meta">${money((data.assetByStatus || []).reduce((s, r) => s + r.value, 0))} value</div></div></div></div>
    </div>

    <div class="grid grid-2 mt-16" style="align-items:start">
      <div class="card">
        <div class="card-head"><div><h3>Purchase Orders by Status</h3></div></div>
        <div class="table-wrap"><table class="tbl"><thead><tr><th>Status</th><th class="num">Count</th><th class="num">Value</th></tr></thead><tbody>${poRows || '<tr><td colspan="3" class="small muted">No data</td></tr>'}</tbody></table></div>
      </div>
      <div class="card">
        <div class="card-head"><div><h3>Assets by Status</h3></div></div>
        <div class="table-wrap"><table class="tbl"><thead><tr><th>Status</th><th class="num">Count</th><th class="num">Value</th></tr></thead><tbody>${assetRows || '<tr><td colspan="3" class="small muted">No data</td></tr>'}</tbody></table></div>
      </div>
    </div>

    <div class="grid grid-2 mt-16" style="align-items:start">
      <div class="card">
        <div class="card-head"><div><h3>Top Vendors by PO Value</h3></div></div>
        <div class="table-wrap"><table class="tbl"><thead><tr><th>Vendor</th><th class="num">POs</th><th class="num">Value</th></tr></thead><tbody>${vendorRows || '<tr><td colspan="3" class="small muted">No data</td></tr>'}</tbody></table></div>
      </div>
      <div class="card">
        <div class="card-head"><div><h3>Stock by Store</h3></div></div>
        <div class="table-wrap"><table class="tbl"><thead><tr><th>Store</th><th class="num">Quantity</th></tr></thead><tbody>${stockRows || '<tr><td colspan="2" class="small muted">No data</td></tr>'}</tbody></table></div>
      </div>
    </div>

    <div class="grid grid-2 mt-16" style="align-items:start">
      <div class="card">
        <div class="card-head"><div><h3>Recent Purchase Orders</h3></div></div>
        <div class="table-wrap"><table class="tbl"><thead><tr><th>PO</th><th>Vendor</th><th>Status</th><th class="num">Value</th><th>Date</th></tr></thead><tbody>${recentRows || '<tr><td colspan="5" class="small muted">No data</td></tr>'}</tbody></table></div>
      </div>
      <div class="card">
        <div class="card-head"><div><h3>Requisitions by Status</h3></div></div>
        <div class="table-wrap"><table class="tbl"><thead><tr><th>Status</th><th class="num">Count</th></tr></thead><tbody>${reqRows || '<tr><td colspan="2" class="small muted">No data</td></tr>'}</tbody></table></div>
      </div>
    </div>
  `;
}