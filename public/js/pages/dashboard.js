import { api } from '../api.js';
import { state, can } from '../state.js';
import {
  esc, icon, money, compactMoney, num, fmtDate, statusBadge, priorityBadge,
  lineChart, barList, initials, relTime,
} from '../ui.js';

function kpi({ label, value, meta, iconName, tone, small }) {
  return `<div class="card"><div class="kpi">
    <div class="chip ${tone}">${icon(iconName)}</div>
    <div style="min-width:0">
      <div class="label">${esc(label)}</div>
      <div class="value ${small ? 'small-value' : ''}">${value}</div>
      ${meta ? `<div class="meta">${meta}</div>` : ''}
    </div>
  </div></div>`;
}

export async function render(ctx) {
  ctx.view.innerHTML = `<div class="empty">Loading dashboard\u2026</div>`;
  const data = await api.get('/api/dashboard');

  const b = data.bills;
  const stageChips = (b.stages || [])
    .map((s) => `<span class="kv-pill">${esc(s.role_name)} <b>${num(s.count)}</b></span>`)
    .join('');

  const greeting = (() => {
    const h = new Date().getHours();
    if (h < 12) return 'Good morning';
    if (h < 17) return 'Good afternoon';
    return 'Good evening';
  })();

  ctx.view.innerHTML = `
    <div class="page-head">
      <div>
        <h1>${greeting}, ${esc(state.user.name.split(' ')[0])}</h1>
        <div class="sub">${esc(state.settings.orgDepartment || 'Administration Department')} \u00b7 ${fmtDate(new Date().toISOString())}</div>
      </div>
      <div class="page-actions">
        ${can('bill.create') ? `<a class="btn btn-primary" href="#/bills/new">${icon('plus')} New Bill</a>` : ''}
        ${can('bill.approve') && state.pendingApprovals ? `<a class="btn" href="#/approvals">${icon('checkSquare')} Review Approvals <span class="badge-count" style="background:var(--gold);color:#2b1d00;border-radius:99px;padding:1px 7px;font-size:11px;font-weight:700">${state.pendingApprovals}</span></a>` : ''}
      </div>
    </div>

    ${
      b.pendingForMe
        ? `<div class="alert alert-warn">
             ${icon('alert')}
             <div><b>${b.pendingForMe} bill${b.pendingForMe === 1 ? '' : 's'} awaiting your approval.</b>
             <div class="small">Review the invoices, supporting documents and advance adjustments before taking a decision.</div>
             <a class="btn btn-sm mt-8" href="#/approvals">Open approval inbox</a></div>
           </div>`
        : ''
    }

    <div class="grid grid-4">
      ${kpi({
        label: 'Total Bills Received',
        value: num(b.total),
        meta: `${money(b.pipeline_value)} in pipeline`,
        iconName: 'file',
        tone: 'blue',
      })}
      ${kpi({
        label: 'Pending Approval',
        value: num(b.pending),
        meta: stageChips || 'No bills pending',
        iconName: 'clock',
        tone: 'amber',
      })}
      ${kpi({
        label: 'Approved Bills',
        value: num(b.approved),
        meta: `${money(b.approved_value)} approved value`,
        iconName: 'checkCircle',
        tone: 'green',
      })}
      ${kpi({
        label: 'Outstanding Advances',
        value: money(data.advances.outstanding, { decimals: 0 }),
        meta: `${money(data.advances.adjustedThisMonth)} adjusted this month`,
        iconName: 'wallet',
        tone: 'teal',
        small: true,
      })}
    </div>

    <div class="grid grid-2 mt-16">
      ${kpi({
        label: 'Total Vendors',
        value: num(data.vendors.total),
        meta: `${num(data.vendors.active)} active \u00b7 ${num(data.vendors.inactive)} inactive`,
        iconName: 'briefcase',
        tone: 'purple',
      })}
      ${kpi({
        label: 'Pending Handover to Accounts',
        value: num(data.handover.pending),
        meta: `${num(data.handover.acknowledged)} acknowledged by Accounts`,
        iconName: 'send',
        tone: 'amber',
      })}
    </div>

    <div class="grid grid-2-1 mt-16">
      <div class="card">
        <div class="card-head">
          <div><h3>Monthly Bills Trend</h3><div class="sub">Value of bills entered over the last 12 months</div></div>
          <div class="actions"><span class="badge-plain">${esc(state.settings.currency)} value</span></div>
        </div>
        <div class="card-body">${lineChart(data.monthlyTrend, { valueKey: 'value', labelKey: 'label', format: compactMoney })}</div>
      </div>
      <div class="card">
        <div class="card-head"><div><h3>Department-wise Expenses</h3><div class="sub">Excluding drafts</div></div></div>
        <div class="card-body">${barList(data.departmentWise, { nameKey: 'name', valueKey: 'value', metaKey: 'count' })}</div>
      </div>
    </div>

    <div class="grid grid-2-1 mt-16">
      <div class="card">
        <div class="card-head">
          <div><h3>Recent Bills</h3><div class="sub">Latest entries across the department</div></div>
          <div class="actions"><a class="btn btn-sm" href="#/bills">View all ${icon('arrowRight')}</a></div>
        </div>
        <div class="table-wrap">
          ${
            data.recentBills.length
              ? `<table class="tbl">
                  <thead><tr><th>Bill</th><th>Vendor</th><th class="num">Amount</th><th>Status</th><th></th></tr></thead>
                  <tbody>${data.recentBills
                    .map(
                      (r) => `<tr>
                        <td><a class="strong" href="#/bills/${r.id}">${esc(r.bill_no)}</a>
                          <div class="small muted">${esc(r.invoice_number)}</div></td>
                        <td>${esc(r.vendor_name)}<div class="small muted">${relTime(r.created_at)}</div></td>
                        <td class="num strong">${money(r.net_amount)}</td>
                        <td>${statusBadge(r.status)}</td>
                        <td class="actions"><a class="btn btn-sm btn-ghost" href="#/bills/${r.id}">${icon('eye')}</a></td>
                      </tr>`
                    )
                    .join('')}</tbody>
                </table>`
              : `<div class="empty"><h4>No bills yet</h4><div class="small">Start by registering your first bill.</div></div>`
          }
        </div>
      </div>

      <div class="stack">
        <div class="card">
          <div class="card-head"><div><h3>Approval Turnaround</h3><div class="sub">Average time to final approval</div></div></div>
          <div class="card-body">
            <div style="font-size:30px;font-weight:700;letter-spacing:-.02em">
              ${data.turnaround.hours ? data.turnaround.hours.toFixed(1) : '\u2014'} <span style="font-size:14px;font-weight:500;color:var(--muted)">hours</span>
            </div>
            <div class="small muted mt-8">Based on ${num(data.turnaround.count)} fully approved bills.</div>
            <div class="divider"></div>
            <div class="bar-list">
              <div class="bar-row">
                <div class="bar-top"><span class="name">Bills in progress</span><span class="muted">${num(b.pending)}</span></div>
                <div class="progress"><div class="bar" style="width:${b.total ? Math.round((b.approved / b.total) * 100) : 0}%"></div></div>
                <div class="small muted mt-8">${b.total ? Math.round((b.approved / b.total) * 100) : 0}% of all bills approved</div>
              </div>
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card-head"><div><h3>Top Vendors</h3><div class="sub">By billed value</div></div></div>
          <div class="card-body">${barList(data.vendorWise.slice(0, 5), { nameKey: 'name', valueKey: 'value', metaKey: 'count' })}</div>
        </div>
      </div>
    </div>

    ${
      data.procurement
        ? `<div class="page-head" style="margin-top:8px"><div><h2>Procurement</h2><div class="sub">Purchase, receiving, inventory and asset KPIs</div></div>
           <div class="page-actions"><a class="btn btn-sm" href="#/purchase-orders">Purchase Orders</a><a class="btn btn-sm" href="#/assets">Assets</a></div></div>
           <div class="grid grid-4">
             ${kpi({ label: 'Purchase Orders', value: num(data.procurement.purchaseOrders.total), meta: `${num(data.procurement.purchaseOrders.issued)} issued \\u00b7 ${num(data.procurement.purchaseOrders.received)} received`, iconName: 'briefcase', tone: 'blue' })}
             ${kpi({ label: 'PO Value', value: compactMoney(data.procurement.purchaseOrders.total_value), meta: `${num(data.procurement.purchaseOrders.draft)} draft`, iconName: 'chart', tone: 'teal' })}
             ${kpi({ label: 'Goods Receipts', value: num(data.procurement.goodsReceipts.total), meta: `${num(data.procurement.goodsReceipts.posted)} posted`, iconName: 'database', tone: 'amber' })}
             ${kpi({ label: 'Procurement Invoices', value: num(data.procurement.invoices.total), meta: `${num(data.procurement.invoices.billed)} billed`, iconName: 'file', tone: 'purple' })}
           </div>
           <div class="grid grid-4 mt-16">
             ${kpi({ label: 'Requisitions', value: num(data.procurement.requisitions.total), meta: `${num(data.procurement.requisitions.pending)} pending \\u00b7 ${num(data.procurement.requisitions.approved)} approved`, iconName: 'layers', tone: 'blue' })}
             ${kpi({ label: 'Assets', value: num(data.procurement.assets.total), meta: `${num(data.procurement.assets.in_custody)} in custody \\u00b7 ${num(data.procurement.assets.missing)} missing`, iconName: 'layers', tone: 'teal' })}
             ${kpi({ label: 'Asset Value', value: compactMoney(data.procurement.assets.total_value), meta: `${num(data.procurement.assets.disposed)} disposed`, iconName: 'chart', tone: 'amber' })}
             ${kpi({ label: 'Stock Quantity', value: num(data.procurement.stock.quantity), meta: 'units on hand', iconName: 'database', tone: 'purple' })}
           </div>`
        : ''
    }

    <div class="card mt-16">
      <div class="card-head"><div><h3>Recent Activity</h3><div class="sub">Audit trail highlights</div></div>
        ${can('audit.view') ? `<div class="actions"><a class="btn btn-sm" href="#/audit">Full audit trail</a></div>` : ''}
      </div>
      <div class="card-body">
        ${
          data.recentActivity.length
            ? `<div class="row" style="gap:18px;align-items:flex-start">
                ${data.recentActivity
                  .map(
                    (a) => `<div style="flex:1 1 180px;min-width:150px">
                      <div class="small"><b>${esc(a.user_name || 'System')}</b> ${esc(
                        a.action.toLowerCase().replace(/_/g, ' ')
                      )} <span class="muted">${esc(a.entity_type)}</span></div>
                      <div class="small muted">${relTime(a.created_at)}</div>
                    </div>`
                  )
                  .join('')}
              </div>`
            : '<div class="small muted">No activity recorded yet.</div>'
        }
      </div>
    </div>

    <div class="grid grid-2 mt-16">
      <div class="card">
        <div class="card-head"><div><h3>Vendor Snapshot</h3><div class="sub">Master data health</div></div></div>
        <div class="card-body">
          <div class="stat-strip">
            <div class="cell"><div class="k">Total</div><div class="v">${num(data.vendors.total)}</div></div>
            <div class="cell"><div class="k">Active</div><div class="v text-green">${num(data.vendors.active)}</div></div>
            <div class="cell"><div class="k">Inactive</div><div class="v">${num(data.vendors.inactive)}</div></div>
            <div class="cell"><div class="k">Blacklisted</div><div class="v text-red">${num(data.vendors.blacklisted)}</div></div>
          </div>
          <div class="section-title">Advances</div>
          <div class="stat-strip">
            <div class="cell"><div class="k">Issued</div><div class="v">${money(data.advances.issued, { decimals: 0 })}</div></div>
            <div class="cell"><div class="k">Outstanding</div><div class="v text-amber">${money(data.advances.outstanding, { decimals: 0 })}</div></div>
            <div class="cell"><div class="k">Open advances</div><div class="v">${num(data.advances.count)}</div></div>
          </div>
        </div>
      </div>
      <div class="card">
        <div class="card-head"><div><h3>Bills Pipeline</h3><div class="sub">Current distribution</div></div></div>
        <div class="card-body">
          <div class="stat-strip">
            <div class="cell"><div class="k">Draft</div><div class="v">${num(b.draft)}</div></div>
            <div class="cell"><div class="k">Pending</div><div class="v text-amber">${num(b.pending)}</div></div>
            <div class="cell"><div class="k">Approved</div><div class="v text-green">${num(b.approved)}</div></div>
            <div class="cell"><div class="k">Rejected</div><div class="v text-red">${num(b.rejected)}</div></div>
          </div>
          <div class="mt-16 small muted">Returned for correction: <b>${num(b.returned)}</b> \u00b7 Awaiting clarification: <b>${num(b.hold)}</b></div>
          ${stageChips ? `<div class="section-title">Pending by stage</div><div class="row">${stageChips}</div>` : ''}
        </div>
      </div>
    </div>

    <div class="small muted mt-16" style="text-align:right">${esc(state.settings.reportFooter || '')}</div>
  `;

  void priorityBadge;
  void initials;
}
