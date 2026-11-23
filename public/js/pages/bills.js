import { api, queryString } from '../api.js';
import { state, can } from '../state.js';
import { navigate, reloadPage, withQuery } from '../router.js';
import {
  esc, icon, money, num, fmtDate, statusBadge, priorityBadge, emptyState,
  toast, modal, actionDialog, confirmDialog, fileSize, initials, downloadUrl,
} from '../ui.js';

export { renderForm } from './bill-form.js';

/* ================================================================== */
/* LIST                                                                */
/* ================================================================== */
export async function renderList(ctx) {
  const q = ctx.route.query;
  const filter = {
    search: q.search || '',
    status: q.status || '',
    vendorId: q.vendorId || '',
    departmentId: q.departmentId || '',
    from: q.from || '',
    to: q.to || '',
    pendingForMe: q.pendingForMe || '',
    page: q.page || '1',
  };
  const params = new URLSearchParams();
  Object.entries(filter).forEach(([k, v]) => { if (v) params.set(k, v); });
  params.set('pageSize', '15');

  ctx.view.innerHTML = `<div class="empty">Loading bills\u2026</div>`;
  const [res, vendorsRes] = await Promise.all([
    api.get(`/api/bills?${params.toString()}`),
    api.get('/api/vendors').catch(() => ({ vendors: [] })),
  ]);
  const s = res.summary || {};

  const statusOptions = [
    { value: '', label: 'All statuses' },
    { value: 'draft', label: 'Draft' },
    { value: 'pending', label: 'Pending Approval' },
    { value: 'approved', label: 'Approved' },
    { value: 'rejected', label: 'Rejected' },
    { value: 'returned', label: 'Returned' },
    { value: 'hold', label: 'Awaiting Clarification' },
  ];

  ctx.view.innerHTML = `
    <div class="page-head">
      <div>
        <h1>Bills</h1>
        <div class="sub">Register, track and approve vendor bills from receipt to handover</div>
      </div>
      <div class="page-actions">
        <a class="btn" href="/api/reports/bill-register?format=csv" data-export>${icon('download')} Export</a>
        ${can('bill.create') ? `<a class="btn btn-primary" href="#/bills/new">${icon('plus')} New Bill</a>` : ''}
      </div>
    </div>

    <div class="grid grid-4 mb-16">
      <div class="card"><div class="kpi"><div class="chip blue">${icon('file')}</div><div><div class="label">Matching bills</div><div class="value">${num(s.total || 0)}</div><div class="meta">${money(s.value || 0)} total value</div></div></div></div>
      <div class="card"><div class="kpi"><div class="chip amber">${icon('clock')}</div><div><div class="label">Pending approval</div><div class="value">${num(s.pending || 0)}</div><div class="meta">Drafts: ${num(s.draft || 0)}</div></div></div></div>
      <div class="card"><div class="kpi"><div class="chip green">${icon('checkCircle')}</div><div><div class="label">Approved</div><div class="value">${num(s.approved || 0)}</div><div class="meta">Ready for Accounts</div></div></div></div>
      <div class="card"><div class="kpi"><div class="chip red">${icon('xCircle')}</div><div><div class="label">Rejected</div><div class="value">${num(s.rejected || 0)}</div><div class="meta">Closed this period</div></div></div></div>
    </div>

    <div class="card">
      <form class="toolbar" id="bill-filters">
        <div class="search">${icon('search')}
          <input class="input" name="search" value="${esc(filter.search)}" placeholder="Bill no, invoice no, vendor\u2026" />
        </div>
        <select class="select" name="status">
          ${statusOptions.map((o) => `<option value="${o.value}" ${o.value === filter.status ? 'selected' : ''}>${o.label}</option>`).join('')}
        </select>
        <select class="select" name="vendorId">
          <option value="">All vendors</option>
          ${vendorsRes.vendors.map((v) => `<option value="${v.id}" ${String(v.id) === String(filter.vendorId) ? 'selected' : ''}>${esc(v.name)}</option>`).join('')}
        </select>
        <select class="select" name="departmentId">
          <option value="">All departments</option>
          ${state.departments.map((d) => `<option value="${d.id}" ${String(d.id) === String(filter.departmentId) ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}
        </select>
        <input class="input" type="date" name="from" value="${esc(filter.from)}" title="From date" style="width:140px" />
        <input class="input" type="date" name="to" value="${esc(filter.to)}" title="To date" style="width:140px" />
        ${can('bill.approve') ? `<label class="check"><input type="checkbox" name="pendingForMe" ${filter.pendingForMe ? 'checked' : ''} /> My approvals</label>` : ''}
        <button class="btn btn-sm" type="submit">${icon('filter')} Apply</button>
        <button class="btn btn-sm btn-ghost" type="button" data-reset>Reset</button>
      </form>

      <div class="table-wrap">
        ${
          res.bills.length
            ? `<table class="tbl">
                <thead><tr>
                  <th>Bill / Invoice</th><th>Vendor</th><th>Unit</th><th>Department</th>
                  <th class="num">Net Amount</th><th class="num">Advance</th>
                  <th>Status</th><th>Current Stage</th><th></th>
                </tr></thead>
                <tbody>
                  ${res.bills
                    .map(
                      (b) => `<tr>
                        <td>
                          <a class="strong" href="#/bills/${b.id}">${esc(b.billNo)}</a>
                          <div class="small muted">${esc(b.invoiceNumber)} \u00b7 ${fmtDate(b.invoiceDate)}</div>
                        </td>
                        <td>${esc(b.vendorName)}<div class="small muted">${esc(b.vendorCode || '')}</div></td>
                        <td>${esc(b.unitName || '\u2014')}</td>
                        <td>${esc(b.departmentName || '\u2014')}<div class="small muted">${esc(b.categoryName || '')}</div></td>
                        <td class="num strong">${money(b.netAmount)}${b.payableAmount !== b.netAmount ? `<div class="small muted">Payable ${money(b.payableAmount)}</div>` : ''}</td>
                        <td class="num">${b.advanceAdjusted ? money(b.advanceAdjusted) : '\u2014'}</td>
                        <td>${statusBadge(b.status, b.statusLabel)}${b.priority === 'High' ? ' ' + priorityBadge('High') : ''}</td>
                        <td class="small">${esc(b.currentStageName || (b.status === 'approved' ? 'Completed' : '\u2014'))}</td>
                        <td class="actions">
                          <a class="btn btn-sm btn-ghost" href="#/bills/${b.id}" title="View">${icon('eye')}</a>
                        </td>
                      </tr>`
                    )
                    .join('')}
                </tbody>
              </table>`
            : emptyState('No bills found', 'Try adjusting your filters or register a new bill.', can('bill.create') ? '<a class="btn btn-sm btn-primary" href="#/bills/new">New Bill</a>' : '', 'file')
        }
      </div>
      ${res.pages > 1 ? `<div class="pager">
        <span>Showing page ${res.page} of ${res.pages} \u00b7 ${num(res.total)} bills</span>
        <span class="spacer"></span>
        <button class="btn btn-sm" data-page="${res.page - 1}" ${res.page <= 1 ? 'disabled' : ''}>${icon('chevronLeft')} Previous</button>
        <button class="btn btn-sm" data-page="${res.page + 1}" ${res.page >= res.pages ? 'disabled' : ''}>Next ${icon('chevronRight')}</button>
      </div>` : ''}
    </div>`;

  const filterForm = document.getElementById('bill-filters');
  filterForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(filterForm).entries());
    if (!filterForm.pendingForMe.checked) delete data.pendingForMe;
    navigate(withQuery('/bills', data));
  });
  filterForm.querySelector('[data-reset]').addEventListener('click', () => navigate('/bills'));
  ctx.view.querySelectorAll('[data-page]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const data = { ...filter, page: btn.dataset.page };
      navigate(withQuery('/bills', data));
    });
  });
  const exportLink = ctx.view.querySelector('[data-export]');
  if (exportLink) {
    const exportParams = new URLSearchParams();
    ['search', 'status', 'vendorId', 'departmentId', 'from', 'to'].forEach((k) => {
      if (filter[k]) exportParams.set(k, filter[k]);
    });
    exportParams.set('format', 'csv');
    exportLink.href = `/api/reports/bill-register?${exportParams.toString()}`;
  }
}

/* ================================================================== */
/* DETAIL                                                              */
/* ================================================================== */
export async function renderDetail(ctx, { id }) {
  ctx.view.innerHTML = `<div class="empty">Loading bill\u2026</div>`;
  const data = await api.get(`/api/bills/${id}`);
  const b = data.bill;
  const baseTotalAmount = Number(b.baseTotalAmount ?? ((Number(b.netAmount) || 0) - (Number(b.roundOff) || 0))) || 0;
  const roundOff = Number(b.roundOff) || 0;
  const totalWithheld = Math.round((b.retentionWithheld + b.holdWithheld + b.creditNoteAmount) * 100) / 100;
  const editable = ['draft', 'returned', 'hold'].includes(b.status);
  const lastRejected = [...data.stages].reverse().find((s) => s.status === 'rejected');
  const lastReturned = [...data.stages].reverse().find((s) => s.status === 'returned');
  const lastClarify = [...data.stages].reverse().find((s) => s.status === 'clarification');
  const isVerifierStage = data.activeStageRoleCode === 'admin_assistant';
  const isAdminStage = data.activeStageRoleCode === 'administrator';
  const stageBadge = (s) =>
    statusBadge(s.status, s.roleCode === 'admin_assistant' && s.status === 'approved' ? 'Verified' : undefined);

  const stageIcon = (status) => {
    if (status === 'approved') return icon('check');
    if (status === 'rejected') return icon('x');
    if (status === 'returned') return icon('undo');
    if (status === 'clarification') return icon('message');
    return icon('clock');
  };

  ctx.view.innerHTML = `
    <div class="page-head">
      <div>
        <div class="small muted" style="margin-bottom:4px"><a href="#/bills">Bills</a> / ${esc(b.billNo)}</div>
        <h1 style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">${esc(b.billNo)} ${statusBadge(b.status, b.statusLabel)} ${priorityBadge(b.priority)}</h1>
        <div class="sub">${esc(b.vendorName)} \u00b7 Invoice ${esc(b.invoiceNumber)} dated ${fmtDate(b.invoiceDate)}</div>
      </div>
      <div class="page-actions">
        <a class="btn" href="#/bills">${icon('arrowLeft')} Back</a>
        ${editable && can('bill.edit') ? `<a class="btn" href="#/bills/${b.id}/edit">${icon('edit')} Edit</a>` : ''}
        ${editable && can('bill.create') ? `<button class="btn btn-primary" data-submit>${icon('send')} ${b.status === 'draft' ? 'Submit for Approval' : 'Resubmit'}</button>` : ''}
        <a class="btn" href="#/bills/${b.id}/report">${icon('printer')} Approval Report</a>
      </div>
    </div>

    ${lastRejected ? `<div class="alert alert-danger">${icon('xCircle')}<div><b>Rejected by ${esc(lastRejected.actedByName || 'approver')} on ${fmtDate(lastRejected.actedAt, true)}.</b><div>${esc(lastRejected.comments || 'No remarks provided.')}</div></div></div>` : ''}
    ${lastReturned && b.status === 'returned' ? `<div class="alert alert-warn">${icon('undo')}<div><b>Returned for correction by ${esc(lastReturned.actedByName || 'approver')} on ${fmtDate(lastReturned.actedAt, true)}.</b><div>${esc(lastReturned.comments || 'No remarks provided.')}</div></div></div>` : ''}
    ${lastClarify && b.status === 'hold' ? `<div class="alert alert-info">${icon('message')}<div><b>Clarification requested by ${esc(lastClarify.actedByName || 'approver')}.</b><div>${esc(lastClarify.comments || '')}</div>
      ${b.createdBy === state.user.id || can('bill.edit') ? `<button class="btn btn-sm mt-8" data-respond>Respond to clarification</button>` : ''}</div></div>` : ''}

    ${data.canAct ? `<div class="card mb-16" style="border-color:#b9e6df;background:linear-gradient(90deg,#f2fbf9,#fff)">
      <div class="card-body" style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
        <div class="chip teal">${icon('checkSquare')}</div>
        <div><b>This bill is awaiting your ${isVerifierStage ? 'verification' : 'decision'} as ${esc(data.activeStageName)}.</b>
          <div class="small muted">Review the documents, advance adjustment and amounts before acting.</div></div>
        <div class="spacer"></div>
        ${isAdminStage ? `<label class="check small" style="white-space:nowrap" title="Send this bill to the Administrative Pastor even when the amount is outside his approval category">
          <input type="checkbox" data-forward-pastor /> Forward to Administrative Pastor
        </label>` : ''}
        <button class="btn btn-accent" data-approve>${icon('check')} ${isVerifierStage ? 'Verify' : 'Approve'}</button>
        <button class="btn" data-clarify>${icon('message')} Request Clarification</button>
        <button class="btn" data-return>${icon('undo')} Return</button>
        <button class="btn btn-danger" data-reject>${icon('x')} Reject</button>
      </div>
    </div>` : ''}

    <div class="split">
      <div class="stack">
        <div class="card">
          <div class="card-head"><div><h3>Invoice &amp; Bill Information</h3><div class="sub">Registered ${fmtDate(b.createdAt, true)} by ${esc(b.createdByName || '\u2014')}</div></div>
            <div class="actions">${statusBadge(b.status, b.statusLabel)}</div>
          </div>
          <div class="card-body">
            <div class="grid grid-2">
              <dl class="dl compact">
                <dt>Bill Number</dt><dd class="mono">${esc(b.billNo)}</dd>
                <dt>Invoice Number</dt><dd class="mono">${esc(b.invoiceNumber)}</dd>
                <dt>Invoice Date</dt><dd>${fmtDate(b.invoiceDate)}</dd>
                <dt>Entry Date</dt><dd>${fmtDate(b.entryDate)}</dd>
                <dt>Vendor</dt><dd>${esc(b.vendorName)} <span class="muted">(${esc(b.vendorCode)})</span></dd>
                <dt>GST Number</dt><dd class="mono">${esc(b.vendorGst || '\u2014')}</dd>
                <dt>Department</dt><dd>${esc(b.departmentName || '\u2014')}</dd>
                <dt>Unit</dt><dd>${esc(b.unitName || '\u2014')}</dd>
                <dt>Bill Type</dt><dd>${esc(b.billType === 'cash' ? 'Cash Bill' : 'Credit Bill')}${b.cashSettlementType ? ` \u2014 ${esc(b.cashSettlementType)}` : ''}${b.imprestReference ? ` (${esc(b.imprestReference)})` : ''}</dd>
                <dt>Category</dt><dd>${esc(b.categoryName || '\u2014')}</dd>
                <dt>Budget Head</dt><dd>${esc(b.budgetHead || '\u2014')}</dd>
                <dt>Cost Center</dt><dd>${esc(b.costCenter || '\u2014')}</dd>
              </dl>
              <div>
                <div class="stat-strip" style="flex-direction:column">
                  <div class="cell" style="display:flex;justify-content:space-between;align-items:center"><span class="k">${b.taxInclusive ? 'Taxable amount (derived)' : 'Basic amount'}</span><span class="v" style="font-size:15px">${money(b.invoiceAmount)}</span></div>
                  ${b.taxInclusive ? `
                  <div class="cell" style="display:flex;justify-content:space-between;align-items:center"><span class="k">Price basis</span><span class="v" style="font-size:15px">Tax inclusive</span></div>` : ''}
                  ${b.discountPercent || b.discountAmount ? `
                  <div class="cell" style="display:flex;justify-content:space-between;align-items:center"><span class="k">Header discount${b.discountPercent ? ` (${b.discountPercent}%)` : ''}</span><span class="v" style="font-size:15px">\u2014 ${money(b.discountAmount)}</span></div>` : ''}
                  ${(b.taxLines && b.taxLines.length ? b.taxLines : []).map((l) => `
                  <div class="cell" style="display:flex;justify-content:space-between;align-items:center"><span class="k">Taxable ${money(l.taxableAmount)} @ ${l.gstRate}%${l.taxInclusive ? ' (incl.)' : ''}${b.gstType === 'cgst_sgst' ? ` (CGST ${l.gstRate / 2}% + SGST ${l.gstRate / 2}%)` : b.gstType === 'igst' ? ' (IGST)' : ''}</span><span class="v" style="font-size:15px">${money(l.taxAmount)}</span></div>`).join('')}
                  ${(!b.taxLines || !b.taxLines.length) && b.gstType === 'cgst_sgst' ? `
                  <div class="cell" style="display:flex;justify-content:space-between;align-items:center"><span class="k">CGST${b.gstRate ? ` (${b.gstRate / 2}%)` : ''}</span><span class="v" style="font-size:15px">${money(b.cgstAmount)}</span></div>
                  <div class="cell" style="display:flex;justify-content:space-between;align-items:center"><span class="k">SGST${b.gstRate ? ` (${b.gstRate / 2}%)` : ''}</span><span class="v" style="font-size:15px">${money(b.sgstAmount)}</span></div>` : ''}
                  ${(!b.taxLines || !b.taxLines.length) && b.gstType === 'igst' ? `
                  <div class="cell" style="display:flex;justify-content:space-between;align-items:center"><span class="k">IGST${b.gstRate ? ` (${b.gstRate}%)` : ''}</span><span class="v" style="font-size:15px">${money(b.igstAmount)}</span></div>` : ''}
                  ${b.gstType === 'non_gst' ? `
                  <div class="cell" style="display:flex;justify-content:space-between;align-items:center"><span class="k">GST treatment</span><span class="v" style="font-size:15px">Non-GST bill</span></div>` : ''}
                  ${b.transportType !== 'none' || b.transportAmount ? `
                  <div class="cell" style="display:flex;justify-content:space-between;align-items:center"><span class="k">Transport charges${b.transportType === 'gst' ? ' (GST)' : b.transportType === 'non_gst' ? ' (Non-GST)' : ''}</span><span class="v" style="font-size:15px">${money(b.transportAmount)}</span></div>` : ''}
                  ${b.transportTaxAmount ? `
                  <div class="cell" style="display:flex;justify-content:space-between;align-items:center"><span class="k">GST on transport${b.transportGstRate ? ` (${b.transportGstRate}%)` : ''}</span><span class="v" style="font-size:15px">${money(b.transportTaxAmount)}</span></div>` : ''}
                  <div class="cell" style="display:flex;justify-content:space-between;align-items:center"><span class="k">Total tax</span><span class="v" style="font-size:15px">${money(b.taxAmount)}</span></div>
                  <div class="cell" style="display:flex;justify-content:space-between;align-items:center"><span class="k">Net before round off</span><span class="v" style="font-size:15px">${money(baseTotalAmount)}</span></div>
                  <div class="cell" style="display:flex;justify-content:space-between;align-items:center"><span class="k">Round off</span><span class="v" style="font-size:15px">${money(roundOff)}</span></div>
                  <div class="cell" style="display:flex;justify-content:space-between;align-items:center"><span class="k">Net amount (rounded)</span><span class="v" style="font-size:15px;font-weight:700">${money(b.netAmount)}</span></div>
                  <div class="cell" style="display:flex;justify-content:space-between;align-items:center"><span class="k">Advance adjusted</span><span class="v text-green" style="font-size:15px">${money(b.advanceAdjusted)}</span></div>
                  <div class="cell" style="display:flex;justify-content:space-between;align-items:center"><span class="k">Retention withheld${b.retentionPercentage ? ` <span class="muted">(${b.retentionPercentage}%)</span>` : ''}</span><span class="v" style="font-size:15px">${money(b.retentionWithheld)}</span></div>
                  <div class="cell" style="display:flex;justify-content:space-between;align-items:center"><span class="k">Snag hold withheld</span><span class="v" style="font-size:15px">${money(b.holdWithheld)}</span></div>
                  <div class="cell" style="display:flex;justify-content:space-between;align-items:center"><span class="k">Credit note</span><span class="v" style="font-size:15px">${money(b.creditNoteAmount)}</span></div>
                  <div class="cell" style="display:flex;justify-content:space-between;align-items:center;background:#f6fbfa"><span class="k">Payable balance</span><span class="v" style="font-size:16px">${money(b.payableAmount)}</span></div>
                </div>
              </div>
            </div>
            <div class="divider"></div>
            <dl class="dl">
              <dt>Particulars</dt><dd>${esc(b.particulars || '\u2014')}</dd>
              <dt>Description</dt><dd style="white-space:pre-wrap">${esc(b.description || '\u2014')}</dd>
            </dl>
          </div>
        </div>

        <div class="card">
          <div class="card-head"><div><h3>Advance Adjustment</h3><div class="sub">Applied from vendor advances</div></div></div>
          <div class="card-body">
            ${
              data.adjustments.length
                ? `<table class="tbl">
                    <thead><tr><th>Advance No</th><th>Advance Date</th><th class="num">Adjusted Amount</th></tr></thead>
                    <tbody>${data.adjustments
                      .map(
                        (a) => `<tr><td class="mono">${esc(a.advanceNo)}</td><td>${fmtDate(a.advanceDate)}</td><td class="num">${money(a.amount)}</td></tr>`
                      )
                      .join('')}</tbody>
                    <tfoot><tr><td colspan="2">Total adjusted</td><td class="num">${money(b.advanceAdjusted)}</td></tr></tfoot>
                  </table>`
                : '<div class="small muted">No advance was adjusted against this bill.</div>'
            }
          </div>
        </div>

        <div class="card">
          <div class="card-head"><div><h3>Retention, Snag Hold &amp; Credit Note</h3><div class="sub">Withholdings and adjustments applied to this bill</div></div></div>
          <div class="card-body">
            <div class="table-wrap">
              <table class="tbl">
                <thead><tr>
                  <th>Item</th><th class="num">Amount</th><th class="num">Released</th>
                  <th class="num">Withheld</th><th>Release Date</th><th>Remarks</th>
                </tr></thead>
                <tbody>
                  <tr>
                    <td>Retention${b.retentionPercentage ? ` <span class="muted">(${b.retentionPercentage}%)</span>` : ''}</td>
                    <td class="num">${money(b.retentionAmount)}</td>
                    <td class="num">${money(b.retentionReleasedAmount)}</td>
                    <td class="num strong">${money(b.retentionWithheld)}</td>
                    <td>${b.retentionReleaseDate ? fmtDate(b.retentionReleaseDate) : '\u2014'}</td>
                    <td>${esc(b.retentionReleaseRemarks || '\u2014')}</td>
                  </tr>
                  <tr>
                    <td>Snag work hold</td>
                    <td class="num">${money(b.holdAmount)}</td>
                    <td class="num">${money(b.holdReleasedAmount)}</td>
                    <td class="num strong">${money(b.holdWithheld)}</td>
                    <td>${b.holdReleaseDate ? fmtDate(b.holdReleaseDate) : '\u2014'}</td>
                    <td>${esc(b.holdReleaseRemarks || '\u2014')}</td>
                  </tr>
                  <tr>
                    <td>Credit note${b.creditNoteNumber ? ` <span class="mono small">${esc(b.creditNoteNumber)}</span>` : ''}</td>
                    <td class="num">${money(b.creditNoteAmount)}</td>
                    <td class="num">\u2014</td>
                    <td class="num strong">${money(b.creditNoteAmount)}</td>
                    <td>${b.creditNoteDate ? fmtDate(b.creditNoteDate) : '\u2014'}</td>
                    <td>${esc(b.creditNoteRemarks || '\u2014')}</td>
                  </tr>
                </tbody>
                <tfoot><tr>
                  <td colspan="3">Total withheld / deducted</td>
                  <td class="num strong">${money(totalWithheld)}</td>
                  <td colspan="2"></td>
                </tr></tfoot>
              </table>
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card-head"><div><h3>Attachments</h3><div class="sub">${data.attachments.length} document${data.attachments.length === 1 ? '' : 's'}</div></div></div>
          <div class="card-body">
            ${
              data.attachments.length
                ? `<div class="file-list">${data.attachments
                    .map(
                      (a) => `<div class="file-item">
                        <div class="ficon">${icon('file')}</div>
                        <div style="min-width:0"><div class="fname">${esc(a.fileName)}</div><div class="fmeta">${esc(a.docType)} \u00b7 ${fileSize(a.size)}</div></div>
                        <div class="factions"><a class="btn btn-sm btn-ghost" href="${a.url}" target="_blank" rel="noopener">${icon('eye')} View</a>
                        <a class="btn btn-sm btn-ghost" href="${a.url}" download="${esc(a.fileName)}">${icon('download')}</a></div>
                      </div>`
                    )
                    .join('')}</div>`
                : '<div class="small muted">No attachments uploaded.</div>'
            }
          </div>
        </div>
      </div>

      <div class="stack">
        <div class="card">
          <div class="card-head"><div><h3>Approval Timeline</h3><div class="sub">${esc(data.activeStageName || (b.status === 'approved' ? 'Completed' : 'Workflow status'))}</div></div></div>
          <div class="card-body">
            <div class="timeline">
              <div class="timeline-item">
                <div class="timeline-dot done">${icon('file')}</div>
                <div class="timeline-body">
                  <div class="name">Bill Entry <span class="badge ${b.status === 'draft' ? 'draft' : 'approved'}">${b.status === 'draft' ? 'Draft' : 'Completed'}</span></div>
                  <div class="meta">${esc(b.createdByName || '')} \u00b7 ${fmtDate(b.createdAt, true)}</div>
                  ${b.submittedAt ? `<div class="meta">Submitted ${fmtDate(b.submittedAt, true)}</div>` : ''}
                </div>
              </div>
              ${data.stages
                .map((s) => {
                  const dotClass = s.status === 'approved' ? 'done' : s.status === 'rejected' ? 'rejected' : s.status === 'pending' ? 'active' : 'returned';
                  return `<div class="timeline-item">
                    <div class="timeline-dot ${dotClass}">${stageIcon(s.status)}</div>
                    <div class="timeline-body">
                      <div class="name">${esc(s.name)} ${stageBadge(s)}</div>
                      <div class="meta">${esc(s.roleName)}${s.actedByName ? ` \u00b7 ${esc(s.actedByName)}${s.actedByDesignation ? `, ${esc(s.actedByDesignation)}` : ''}` : ''}${s.actedAt ? ` \u00b7 ${fmtDate(s.actedAt, true)}` : ''}</div>
                      ${s.comments ? `<div class="comment">${esc(s.comments)}</div>` : ''}
                      ${s.signatureImage ? `<img class="signature-thumb" src="${s.signatureImage.startsWith('data:') ? s.signatureImage : `data:image/png;base64,${s.signatureImage}`}" alt="Digital signature" />` : ''}
                    </div>
                  </div>`;
                })
                .join('')}
              ${
                b.status === 'approved'
                  ? `<div class="timeline-item">
                      <div class="timeline-dot done">${icon('send')}</div>
                      <div class="timeline-body"><div class="name">Handed over to Accounts</div>
                      <div class="meta">${data.handover ? `${esc(data.handover.handover_no)} \u00b7 ${fmtDate(data.handover.forwarded_at, true)}` : fmtDate(b.approvedAt, true)}</div></div>
                    </div>`
                  : ''
              }
              ${!data.stages.length && b.status === 'draft' ? `<div class="small muted">The approval chain is created when the bill is submitted.</div>` : ''}
            </div>
          </div>
        </div>

        ${
          data.handover
            ? `<div class="card">
                <div class="card-head"><div><h3>Accounts Handover</h3><div class="sub">${esc(data.handover.handover_no)}</div></div></div>
                <div class="card-body">
                  <dl class="dl compact">
                    <dt>Status</dt><dd>${statusBadge(data.handover.status)}</dd>
                    <dt>Forwarded</dt><dd>${fmtDate(data.handover.forwarded_at, true)}</dd>
                    <dt>Forwarded by</dt><dd>${esc(data.handover.forwarded_by_name || '\u2014')}</dd>
                    <dt>Received by</dt><dd>${esc(data.handover.received_by_name || '\u2014')}</dd>
                    <dt>Received on</dt><dd>${data.handover.received_at ? fmtDate(data.handover.received_at, true) : '\u2014'}</dd>
                    ${data.handover.remarks ? `<dt>Remarks</dt><dd>${esc(data.handover.remarks)}</dd>` : ''}
                  </dl>
                  ${data.handover.status === 'forwarded' && can('handover.acknowledge') ? `<button class="btn btn-accent btn-block mt-12" data-ack>${icon('check')} Acknowledge handover</button>` : ''}
                </div>
              </div>`
            : ''
        }

        <div class="card">
          <div class="card-head"><div><h3>Record</h3></div></div>
          <div class="card-body">
            <dl class="dl compact">
              <dt>Created by</dt><dd>${esc(b.createdByName || '\u2014')}</dd>
              <dt>Created at</dt><dd>${fmtDate(b.createdAt, true)}</dd>
              <dt>Last updated</dt><dd>${fmtDate(b.updatedAt, true)}</dd>
              <dt>Submitted</dt><dd>${b.submittedAt ? fmtDate(b.submittedAt, true) : '\u2014'}</dd>
              <dt>Approved</dt><dd>${b.approvedAt ? fmtDate(b.approvedAt, true) : '\u2014'}</dd>
            </dl>
            ${b.status === 'draft' && can('bill.delete') ? `<button class="btn btn-danger btn-block mt-12" data-delete>${icon('trash')} Delete draft</button>` : ''}
          </div>
        </div>
      </div>
    </div>`;

  /* Actions */
  const doAction = async (action, options) => {
    const dialog = await actionDialog(options);
    if (!dialog) return;
    try {
      const forwardToPastor = action === 'approve' && isAdminStage
        && !!ctx.view.querySelector('[data-forward-pastor]')?.checked;
      const res = await api.post(`/api/bills/${b.id}/action`, {
        action,
        comments: dialog.comments,
        forwardToAdminPastor: forwardToPastor,
      });
      toast(res.message || 'Action recorded.');
      reloadPage();
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  ctx.view.querySelector('[data-approve]')?.addEventListener('click', () =>
    doAction('approve', {
      title: isVerifierStage ? 'Verify bill' : 'Approve bill',
      subtitle: `${b.billNo} \u00b7 ${money(b.netAmount)}`,
      confirmText: isVerifierStage ? 'Verify' : 'Approve',
      signature: true,
    })
  );
  ctx.view.querySelector('[data-reject]')?.addEventListener('click', () =>
    doAction('reject', {
      title: 'Reject bill',
      subtitle: 'This will close the workflow. The creator will be notified.',
      confirmText: 'Reject bill',
      danger: true,
      requireComment: true,
    })
  );
  ctx.view.querySelector('[data-return]')?.addEventListener('click', () =>
    doAction('return', {
      title: 'Return for correction',
      subtitle: 'The bill goes back to the creator for changes.',
      confirmText: 'Return bill',
      requireComment: true,
    })
  );
  ctx.view.querySelector('[data-clarify]')?.addEventListener('click', () =>
    doAction('clarify', {
      title: 'Request clarification',
      subtitle: 'The bill will be placed on hold until the creator responds.',
      confirmText: 'Request clarification',
      requireComment: true,
    })
  );

  ctx.view.querySelector('[data-submit]')?.addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: b.status === 'draft' ? 'Submit bill for approval' : 'Resubmit bill',
      message: 'The approval chain will be determined by the bill amount and the configured workflow matrix.',
      confirmText: 'Submit',
    });
    if (!ok) return;
    try {
      const res = await api.post(`/api/bills/${b.id}/submit`);
      toast(res.rule ? `Submitted. Approval chain: ${res.rule}.` : 'Bill submitted for approval.');
      reloadPage();
    } catch (e) {
      toast(e.message, 'error');
    }
  });

  ctx.view.querySelector('[data-delete]')?.addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: 'Delete draft bill',
      message: `Delete ${b.billNo}? Any advance adjustments applied to it will be reversed.`,
      confirmText: 'Delete',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.del(`/api/bills/${b.id}`);
      toast('Draft bill deleted.');
      navigate('/bills');
    } catch (e) {
      toast(e.message, 'error');
    }
  });

  ctx.view.querySelector('[data-respond]')?.addEventListener('click', () => {
    modal({
      title: 'Respond to clarification',
      subtitle: `${b.billNo} \u00b7 ${data.activeStageName || ''}`,
      body: `<div class="field"><label>Your response</label>
        <textarea class="textarea" data-msg rows="4" placeholder="Provide the clarification requested by the approver..."></textarea></div>`,
      footer: `<button class="btn" data-modal-close>Cancel</button><button class="btn btn-primary" data-send>Send response</button>`,
      onMount(el, close) {
        el.querySelector('[data-send]').addEventListener('click', async () => {
          const message = el.querySelector('[data-msg]').value.trim();
          if (!message) return;
          try {
            await api.post(`/api/bills/${b.id}/respond`, { message });
            close();
            toast('Response sent. The bill is back with the approver.');
            reloadPage();
          } catch (e) {
            toast(e.message, 'error');
          }
        });
      },
    });
  });

  ctx.view.querySelector('[data-ack]')?.addEventListener('click', () => {
    modal({
      title: 'Acknowledge handover',
      subtitle: `${data.handover.handover_no} \u00b7 ${b.billNo}`,
      body: `<p class="small muted">Confirm that the Accounts Department has received this bill and its documents.</p>
        <div class="field"><label>Remarks (optional)</label><textarea class="textarea" data-msg rows="3"></textarea></div>`,
      footer: `<button class="btn" data-modal-close>Cancel</button><button class="btn btn-accent" data-ok>${icon('check')} Acknowledge</button>`,
      onMount(el, close) {
        el.querySelector('[data-ok]').addEventListener('click', async () => {
          try {
            await api.post(`/api/handover/${data.handover.id}/acknowledge`, { remarks: el.querySelector('[data-msg]').value });
            close();
            toast('Handover acknowledged.');
            reloadPage();
          } catch (e) {
            toast(e.message, 'error');
          }
        });
      },
    });
  });

  void downloadUrl;
  void initials;
}

/* ================================================================== */
/* APPROVAL REPORT                                                     */
/* ================================================================== */
export async function renderApprovalReport(ctx, { id }) {
  ctx.view.innerHTML = `<div class="empty">Preparing approval report\u2026</div>`;
  const data = await api.get(`/api/bills/${id}/report`);
  const b = data.bill;
  const baseTotalAmount = Number(b.baseTotalAmount ?? ((Number(b.netAmount) || 0) - (Number(b.roundOff) || 0))) || 0;
  const roundOff = Number(b.roundOff) || 0;
  const totalWithheld = Math.round((b.retentionWithheld + b.holdWithheld + b.creditNoteAmount) * 100) / 100;

  let qrImg = '';
  try {
    const qr = window.qrcode(0, 'M');
    qr.addData(data.verifyUrl);
    qr.make();
    qrImg = `<img src="${qr.createDataURL(4, 8)}" alt="Verification QR code" />`;
  } catch (e) {
    qrImg = `<div class="small">QR unavailable</div>`;
  }

  const stageRows = data.stages
    .map(
      (s) => `<tr>
        <td>${esc(s.name)}</td>
        <td>${esc(s.actedByName || '')}${s.actedByDesignation ? `<br><span style="color:#666">${esc(s.actedByDesignation)}</span>` : ''}</td>
        <td>${esc(s.status === 'approved' && s.roleCode === 'admin_assistant' ? 'Verified' : s.status.charAt(0).toUpperCase() + s.status.slice(1))}</td>
        <td>${s.actedAt ? fmtDate(s.actedAt, true) : '\u2014'}</td>
        <td>${esc(s.comments || '')}</td>
        <td style="width:90px">${s.signatureImage ? `<img src="${s.signatureImage.startsWith('data:') ? s.signatureImage : `data:image/png;base64,${s.signatureImage}`}" style="max-height:28px" alt="Signature" />` : ''}</td>
      </tr>`
    )
    .join('');

  ctx.view.innerHTML = `
    <div class="page-head no-print">
      <div>
        <h1>Approval Report</h1>
        <div class="sub">${esc(b.billNo)} \u00b7 ${esc(b.vendorName)}</div>
      </div>
      <div class="page-actions">
        <a class="btn" href="#/bills/${b.id}">${icon('arrowLeft')} Back to bill</a>
        <button class="btn" data-copy>${icon('copy')} Copy verification link</button>
        <button class="btn" data-print>${icon('printer')} Print</button>
        <button class="btn btn-primary" data-pdf>${icon('download')} Save as PDF</button>
      </div>
    </div>

    <div class="print-report">
      <div class="report-sheet card" style="box-shadow:var(--shadow)">
        <div class="report-header">
          <div class="org">
            <h2>${esc(data.org.name)}</h2>
            <p>${esc(data.org.department)}</p>
            <p style="margin-top:6px"><b>BILL APPROVAL REPORT</b></p>
            <p>Report generated: ${fmtDate(new Date().toISOString(), true)}</p>
          </div>
          <div class="qr">${qrImg}<div>Scan to verify</div></div>
        </div>

        <div class="report-title">${esc(b.billNo)}</div>

        <div class="rp-section">
          <h3>Bill Information</h3>
          <div class="rp-grid">
            <div><span class="k">Bill Number</span><b>${esc(b.billNo)}</b></div>
            <div><span class="k">Entry Date</span><b>${fmtDate(b.entryDate)}</b></div>
            <div><span class="k">Vendor</span><b>${esc(b.vendorName)}</b></div>
            <div><span class="k">Vendor Code</span><b>${esc(b.vendorCode)}</b></div>
            <div><span class="k">Invoice Number</span><b>${esc(b.invoiceNumber)}</b></div>
            <div><span class="k">Invoice Date</span><b>${fmtDate(b.invoiceDate)}</b></div>
            <div><span class="k">Department</span><b>${esc(b.departmentName || '\u2014')}</b></div>
            <div><span class="k">Category</span><b>${esc(b.categoryName || '\u2014')}</b></div>
            <div><span class="k">${b.taxInclusive ? 'Taxable Amount (derived)' : 'Basic Amount'}</span><b>${money(b.invoiceAmount)}</b></div>
            <div><span class="k">Price Basis</span><b>${b.taxInclusive ? 'Tax inclusive' : 'Tax exclusive'}</b></div>
            <div><span class="k">Header Discount${b.discountPercent ? ` (${b.discountPercent}%)` : ''}</span><b>\u2014 ${money(b.discountAmount)}</b></div>
            <div><span class="k">Total Tax</span><b>${money(b.taxAmount)}</b></div>
            <div><span class="k">Net Before Round Off</span><b>${money(baseTotalAmount)}</b></div>
            <div><span class="k">Round Off</span><b>${money(roundOff)}</b></div>
            <div><span class="k">Net Amount (Rounded)</span><b>${money(b.netAmount)}</b></div>
            <div><span class="k">Advance Adjusted</span><b>${money(b.advanceAdjusted)}</b></div>
            <div><span class="k">Retention Withheld</span><b>${money(b.retentionWithheld)}</b></div>
            <div><span class="k">Snag Hold Withheld</span><b>${money(b.holdWithheld)}</b></div>
            <div><span class="k">Credit Note</span><b>${money(b.creditNoteAmount)}</b></div>
            <div><span class="k">Payable to Vendor</span><b>${money(b.payableAmount)}</b></div>
            <div><span class="k">Priority</span><b>${esc(b.priority)}</b></div>
            <div><span class="k">Status</span><b>${esc(b.statusLabel)}</b></div>
            <div><span class="k">Created By</span><b>${esc(b.createdByName || '\u2014')}</b></div>
            <div><span class="k">Budget Head</span><b>${esc(b.budgetHead || '\u2014')}</b></div>
            <div><span class="k">Cost Center</span><b>${esc(b.costCenter || '\u2014')}</b></div>
            <div><span class="k">Particulars</span><b>${esc(b.particulars || '\u2014')}</b></div>
            <div><span class="k">Final Approval</span><b>${b.approvedAt ? fmtDate(b.approvedAt, true) : '\u2014'}</b></div>
          </div>
          ${b.description ? `<div class="rp-note"><b>Description / Purpose:</b> ${esc(b.description)}</div>` : ''}
        </div>

        <div class="rp-section">
          <h3>Tax &amp; Transport</h3>
          <table class="rp-table">
            <thead><tr><th>Description</th><th class="num">Rate</th><th class="num">Amount</th></tr></thead>
            <tbody>
              <tr><td>${b.taxInclusive ? 'Taxable invoice amount (derived)' : 'Basic invoice amount'}</td><td class="num">\u2014</td><td class="num">${money(b.invoiceAmount)}</td></tr>
              ${b.discountPercent || b.discountAmount ? `<tr><td>Header discount${b.discountPercent ? ` (${b.discountPercent}%)` : ''}</td><td class="num">\u2014</td><td class="num">\u2014 ${money(b.discountAmount)}</td></tr>` : ''}
              ${(b.taxLines && b.taxLines.length ? b.taxLines : []).map((l) => `
              ${b.gstType === 'cgst_sgst' ? `
              <tr><td>CGST${l.gstRate ? ` (${l.gstRate / 2}%)` : ''}${b.taxLines.length > 1 ? ` \u2014 ${money(l.taxableAmount)}${l.taxInclusive ? ' incl.' : ''}` : ''}</td><td class="num">${l.gstRate ? `${l.gstRate / 2}%` : '\u2014'}</td><td class="num">${money(l.cgstAmount)}</td></tr>
              <tr><td>SGST${l.gstRate ? ` (${l.gstRate / 2}%)` : ''}${b.taxLines.length > 1 ? ` \u2014 ${money(l.taxableAmount)}${l.taxInclusive ? ' incl.' : ''}` : ''}</td><td class="num">${l.gstRate ? `${l.gstRate / 2}%` : '\u2014'}</td><td class="num">${money(l.sgstAmount)}</td></tr>` : ''}
              ${b.gstType === 'igst' ? `
              <tr><td>IGST${l.gstRate ? ` (${l.gstRate}%)` : ''}${b.taxLines.length > 1 ? ` \u2014 ${money(l.taxableAmount)}${l.taxInclusive ? ' incl.' : ''}` : ''}</td><td class="num">${l.gstRate ? `${l.gstRate}%` : '\u2014'}</td><td class="num">${money(l.igstAmount)}</td></tr>` : ''}`).join('')}
              ${(!b.taxLines || !b.taxLines.length) && b.gstType === 'cgst_sgst' ? `
              <tr><td>CGST</td><td class="num">${b.gstRate ? `${b.gstRate / 2}%` : '\u2014'}</td><td class="num">${money(b.cgstAmount)}</td></tr>
              <tr><td>SGST</td><td class="num">${b.gstRate ? `${b.gstRate / 2}%` : '\u2014'}</td><td class="num">${money(b.sgstAmount)}</td></tr>` : ''}
              ${(!b.taxLines || !b.taxLines.length) && b.gstType === 'igst' ? `
              <tr><td>IGST</td><td class="num">${b.gstRate ? `${b.gstRate}%` : '\u2014'}</td><td class="num">${money(b.igstAmount)}</td></tr>` : ''}
              ${b.gstType === 'non_gst' ? '<tr><td>GST</td><td class="num">\u2014</td><td class="num">Non-GST bill</td></tr>' : ''}
              <tr><td>Transport charges${b.transportType === 'gst' ? ' (GST)' : b.transportType === 'non_gst' ? ' (Non-GST)' : ''}</td><td class="num">\u2014</td><td class="num">${money(b.transportAmount)}</td></tr>
              ${b.transportTaxAmount ? `<tr><td>GST on transport</td><td class="num">${b.transportGstRate}%</td><td class="num">${money(b.transportTaxAmount)}</td></tr>` : ''}
            </tbody>
            <tfoot>
              <tr><th colspan="2">Total Tax</th><th class="num">${money(b.taxAmount)}</th></tr>
              <tr><th colspan="2">Net before round off</th><th class="num">${money(baseTotalAmount)}</th></tr>
              <tr><th colspan="2">Round off</th><th class="num">${money(roundOff)}</th></tr>
              <tr><th colspan="2">Net Amount (after header discount, rounded)</th><th class="num">${money(b.netAmount)}</th></tr>
            </tfoot>
          </table>
        </div>

        <div class="rp-section">
          <h3>Advance Details</h3>
          <table class="rp-table">
            <thead><tr><th>Advance Number</th><th>Advance Date</th><th class="num">Amount Adjusted</th><th>Remarks</th></tr></thead>
            <tbody>
              ${
                data.adjustments.length
                  ? data.adjustments
                      .map(
                        (a) => `<tr><td>${esc(a.advanceNo)}</td><td>${fmtDate(a.advanceDate)}</td><td class="num">${money(a.amount)}</td><td>Adjusted against this invoice</td></tr>`
                      )
                      .join('')
                  : '<tr><td colspan="4">No advance adjusted against this bill.</td></tr>'
              }
            </tbody>
            <tfoot><tr><th colspan="2">Total Adjusted</th><th class="num">${money(b.advanceAdjusted)}</th><th></th></tr></tfoot>
          </table>
        </div>

        <div class="rp-section">
          <h3>Retention, Snag Work Hold &amp; Credit Note</h3>
          <table class="rp-table">
            <thead><tr><th>Item</th><th class="num">Amount</th><th class="num">Released</th><th class="num">Withheld / Deducted</th><th>Release / Note Date</th><th>Remarks</th></tr></thead>
            <tbody>
              <tr>
                <td>Retention${b.retentionPercentage ? ` (${b.retentionPercentage}%)` : ''}</td>
                <td class="num">${money(b.retentionAmount)}</td>
                <td class="num">${money(b.retentionReleasedAmount)}</td>
                <td class="num">${money(b.retentionWithheld)}</td>
                <td>${b.retentionReleaseDate ? fmtDate(b.retentionReleaseDate) : '\u2014'}</td>
                <td>${esc(b.retentionReleaseRemarks || '\u2014')}</td>
              </tr>
              <tr>
                <td>Snag work hold</td>
                <td class="num">${money(b.holdAmount)}</td>
                <td class="num">${money(b.holdReleasedAmount)}</td>
                <td class="num">${money(b.holdWithheld)}</td>
                <td>${b.holdReleaseDate ? fmtDate(b.holdReleaseDate) : '\u2014'}</td>
                <td>${esc(b.holdReleaseRemarks || '\u2014')}</td>
              </tr>
              <tr>
                <td>Credit note${b.creditNoteNumber ? ` (${esc(b.creditNoteNumber)})` : ''}</td>
                <td class="num">${money(b.creditNoteAmount)}</td>
                <td class="num">\u2014</td>
                <td class="num">${money(b.creditNoteAmount)}</td>
                <td>${b.creditNoteDate ? fmtDate(b.creditNoteDate) : '\u2014'}</td>
                <td>${esc(b.creditNoteRemarks || '\u2014')}</td>
              </tr>
            </tbody>
            <tfoot><tr><th colspan="3">Total Withheld / Deducted</th><th class="num">${money(totalWithheld)}</th><th colspan="2"></th></tr></tfoot>
          </table>
          <div class="rp-note" style="margin-top:6px"><b>Net payable to vendor after all deductions:</b> ${money(b.payableAmount)}</div>
        </div>

        <div class="rp-section">
          <h3>Attachments</h3>
          ${
            data.attachments.length
              ? `<ol style="margin:0;padding-left:18px;font-size:10.5px">${data.attachments
                  .map((a) => `<li>${esc(a.fileName)} <span style="color:#666">(${esc(a.docType)})</span></li>`)
                  .join('')}</ol>`
              : '<div class="rp-note">No attachments on record.</div>'
          }
        </div>

        <div class="rp-section">
          <h3>Approval Section</h3>
          <table class="rp-table">
            <thead><tr><th>Approval Stage</th><th>Approver / Verifier</th><th>Status</th><th>Date &amp; Time</th><th>Remarks</th><th>Signature</th></tr></thead>
            <tbody>${stageRows || '<tr><td colspan="6">Approval workflow not started.</td></tr>'}</tbody>
          </table>
        </div>

        <div class="rp-section">
          <h3>Verification</h3>
          <div class="rp-note">This report can be verified online using the QR code above or by visiting:<br>
            <span style="word-break:break-all">${esc(data.verifyUrl)}</span></div>
        </div>

        <div class="rp-signs">
          <div><div class="line">Prepared By (Administration)</div></div>
          <div><div class="line">Verified By (Administrative Assistant)</div></div>
          <div><div class="line">Approved By (Administrative Pastor)</div></div>
        </div>

        <div class="rp-foot">
          <span>${esc(data.org.footer || 'System generated approval report.')}</span>
          <span>${esc(b.billNo)}</span>
        </div>
      </div>
    </div>`;

  ctx.view.querySelector('[data-print]').addEventListener('click', () => window.print());
  ctx.view.querySelector('[data-pdf]').addEventListener('click', () => {
    toast('Use "Save as PDF" in the print dialog.', 'info');
    setTimeout(() => window.print(), 350);
  });
  ctx.view.querySelector('[data-copy]').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(data.verifyUrl);
      toast('Verification link copied.');
    } catch {
      toast('Could not copy the link.', 'error');
    }
  });

  void queryString;
}
