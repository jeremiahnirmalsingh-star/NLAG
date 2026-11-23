import { api } from '../api.js';
import { state, can } from '../state.js';
import { navigate, reloadPage, withQuery } from '../router.js';
import {
  esc, icon, money, num, fmtDate, statusBadge, emptyState, toast, field, modal,
  confirmDialog, actionDialog,
} from '../ui.js';

const OPERATIONAL_STATUSES = ['Open', 'Partially Adjusted', 'Fully Adjusted', 'Closed'];

function canActOn(stage) {
  if (!stage || stage.status !== 'pending') return false;
  if (state.user.roleCode === 'super_admin') return true;
  if (stage.user_id && Number(stage.user_id) === Number(state.user.id)) return true;
  return state.user.roleCode === stage.roleCode;
}

function stageRow(s, withSignature = false) {
  return `<tr>
    <td>${esc(s.sequence)}. ${esc(s.name)}</td>
    <td>${esc(s.roleName || '')}</td>
    <td>${statusBadge(s.status)}</td>
    <td>${esc(s.actedByName || '\u2014')}</td>
    <td>${s.actedAt ? fmtDate(s.actedAt, true) : '\u2014'}</td>
    <td class="small">${esc(s.comments || '')}</td>
    ${withSignature ? `<td style="width:80px">${s.signatureImage ? `<img src="${s.signatureImage.startsWith('data:') ? s.signatureImage : `data:image/png;base64,${s.signatureImage}`}" style="max-height:26px" alt="Signature" />` : ''}</td>` : ''}
  </tr>`;
}

/* ================================================================== */
/* LIST                                                                */
/* ================================================================== */
export async function renderList(ctx) {
  const q = ctx.route.query;
  const params = new URLSearchParams();
  if (q.search) params.set('search', q.search);
  if (q.status) params.set('status', q.status);
  if (q.from) params.set('from', q.from);
  if (q.to) params.set('to', q.to);

  ctx.view.innerHTML = `<div class="empty">Loading advances\u2026</div>`;
  const res = await api.get(`/api/advances?${params.toString()}`);
  const s = res.summary || {};

  ctx.view.innerHTML = `
    <div class="page-head">
      <div><h1>Advance Register</h1><div class="sub">Record vendor advances and track adjustments against bills</div></div>
      <div class="page-actions">
        <a class="btn" href="/api/reports/advance-register?format=csv">${icon('download')} Export</a>
        ${can('advance.create') ? `<button class="btn btn-primary" data-new>${icon('plus')} Record Advance</button>` : ''}
      </div>
    </div>

    <div class="grid grid-4 mb-16">
      <div class="card"><div class="kpi"><div class="chip blue">${icon('wallet')}</div><div><div class="label">Advances issued</div><div class="value small-value">${money(s.total || 0)}</div><div class="meta">${num(s.count || 0)} records</div></div></div></div>
      <div class="card"><div class="kpi"><div class="chip green">${icon('checkCircle')}</div><div><div class="label">Adjusted</div><div class="value small-value">${money(s.adjusted || 0)}</div><div class="meta">Against invoices</div></div></div></div>
      <div class="card"><div class="kpi"><div class="chip amber">${icon('clock')}</div><div><div class="label">Outstanding</div><div class="value small-value">${money(s.outstanding || 0)}</div><div class="meta">Available for adjustment</div></div></div></div>
      <div class="card"><div class="kpi"><div class="chip purple">${icon('file')}</div><div><div class="label">Open advances</div><div class="value">${num(res.advances.filter((a) => !['Closed', 'Fully Adjusted'].includes(a.status)).length)}</div><div class="meta">Not fully utilised</div></div></div></div>
    </div>

    <div class="card">
      <form class="toolbar" id="adv-filters">
        <div class="search">${icon('search')}<input class="input" name="search" value="${esc(q.search || '')}" placeholder="Advance no, vendor, purpose..." /></div>
        <select class="select" name="status">
          <option value="">All statuses</option>
          ${[
            ['pending', 'Pending Approval'],
            ['returned', 'Returned'],
            ['rejected', 'Rejected'],
            ['Open', 'Open'],
            ['Partially Adjusted', 'Partially Adjusted'],
            ['Fully Adjusted', 'Fully Adjusted'],
            ['Closed', 'Closed'],
          ].map(([value, label]) => `<option value="${value}" ${q.status === value ? 'selected' : ''}>${label}</option>`).join('')}
        </select>
        <input class="input" type="date" name="from" value="${esc(q.from || '')}" style="width:140px" />
        <input class="input" type="date" name="to" value="${esc(q.to || '')}" style="width:140px" />
        <button class="btn btn-sm" type="submit">${icon('filter')} Apply</button>
        <button class="btn btn-sm btn-ghost" type="button" data-reset>Reset</button>
      </form>
      <div class="table-wrap">
        ${res.advances.length
          ? `<table class="tbl">
              <thead><tr><th>Advance No</th><th>Vendor</th><th>Date</th><th class="num">Amount</th><th class="num">Adjusted</th><th class="num">Balance</th><th>Status</th><th>Purpose</th><th></th></tr></thead>
              <tbody>${res.advances
                .map(
                  (a) => `<tr>
                    <td><a class="strong mono" href="#/advances/${a.id}">${esc(a.advanceNo)}</a></td>
                    <td>${esc(a.vendorName)}<div class="small muted">${esc(a.vendorCode)}</div></td>
                    <td>${fmtDate(a.advanceDate)}</td>
                    <td class="num">${money(a.amount)}</td>
                    <td class="num">${money(a.adjustedAmount)}</td>
                    <td class="num fw-700">${money(a.balance)}</td>
                    <td>${statusBadge(a.status)}</td>
                    <td class="small">${esc(a.purpose || '\u2014')}</td>
                    <td class="actions"><a class="btn btn-sm btn-ghost" href="#/advances/${a.id}">${icon('eye')}</a></td>
                  </tr>`
                )
                .join('')}</tbody></table>`
          : emptyState('No advances recorded', 'Record an advance paid to a vendor to track it against future invoices.', can('advance.create') ? '<button class="btn btn-sm btn-primary" data-new>Record Advance</button>' : '', 'wallet')}
      </div>
    </div>`;

  const form = document.getElementById('adv-filters');
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    navigate(withQuery('/advances', Object.fromEntries(new FormData(form).entries())));
  });
  form.querySelector('[data-reset]').addEventListener('click', () => navigate('/advances'));
  ctx.view.querySelectorAll('[data-new]').forEach((btn) => btn.addEventListener('click', () => openAdvanceDialog()));
  if (q.new === '1') openAdvanceDialog(q.vendorId);
}

/* ================================================================== */
/* CREATE / EDIT DIALOG                                                */
/* ================================================================== */
export async function openAdvanceDialog(presetVendorId) {
  const [vendorsRes, departments] = await Promise.all([
    api.get('/api/vendors?status=Active'),
    Promise.resolve(state.departments),
  ]);
  const vendorOptions = vendorsRes.vendors.map((v) => ({ value: v.id, label: `${v.name} (${v.code})` }));
  const deptOptions = [{ value: '', label: '\u2014 Select department \u2014' }, ...departments.map((d) => ({ value: d.id, label: d.name }))];

  modal({
    title: 'Record vendor advance',
    subtitle: 'Advances are tracked for adjustment against future bills.',
    size: 'wide',
    body: `<form id="adv-form">
      <div class="form-grid">
        ${field({ label: 'Vendor', name: 'vendorId', type: 'select', value: presetVendorId || '', options: [{ value: '', label: '\u2014 Select vendor \u2014' }, ...vendorOptions], required: true, span: true })}
        ${field({ label: 'Advance Date', name: 'advanceDate', type: 'date', value: new Date().toISOString().slice(0, 10), required: true })}
        ${field({ label: 'Advance Amount', name: 'amount', type: 'number', required: true, attrs: 'step="0.01" min="0.01" placeholder="0.00"' })}
        ${field({ label: 'Department', name: 'departmentId', type: 'select', value: '', options: deptOptions })}
        ${field({ label: 'Purpose', name: 'purpose', value: '', placeholder: 'e.g. Annual maintenance advance' })}
        ${field({ label: 'Remarks', name: 'remarks', type: 'textarea', value: '', span: true })}
      </div>
      <div class="alert alert-danger hidden" data-err></div>
    </form>`,
    footer: `<button class="btn" data-modal-close>Cancel</button><button class="btn btn-primary" data-save>Record advance</button>`,
    onMount(el, close) {
      const form = el.querySelector('#adv-form');
      el.querySelector('[data-save]').addEventListener('click', async () => {
        const err = el.querySelector('[data-err]');
        err.classList.add('hidden');
        const data = {
          vendorId: form.vendorId.value,
          advanceDate: form.advanceDate.value,
          amount: Number(form.amount.value) || 0,
          departmentId: form.departmentId.value,
          purpose: form.purpose.value.trim(),
          remarks: form.remarks.value.trim(),
        };
        if (!data.vendorId) { err.textContent = 'Please select a vendor.'; err.classList.remove('hidden'); return; }
        if (!(data.amount > 0)) { err.textContent = 'Advance amount must be greater than zero.'; err.classList.remove('hidden'); return; }
        try {
          const res = await api.post('/api/advances', data);
          close();
          toast(`Advance ${res.advanceNo} recorded.`);
          reloadPage();
        } catch (e) {
          err.textContent = e.message;
          err.classList.remove('hidden');
        }
      });
    },
  });
}

/* ================================================================== */
/* DETAIL                                                              */
/* ================================================================== */
export async function renderDetail(ctx, { id }) {
  ctx.view.innerHTML = `<div class="empty">Loading advance\u2026</div>`;
  const data = await api.get(`/api/advances/${id}`);
  const a = data.advance;
  const currentStage = data.stages.find((s) => s.status === 'pending');
  const approved = !!a.approvedAt || OPERATIONAL_STATUSES.includes(a.status);
  const approvalCard = data.stages.length
    ? `<div class="card mt-16">
        <div class="card-head">
          <div><h3>Approval Workflow</h3><div class="sub">${a.status === 'pending' ? `Waiting on ${esc(currentStage ? currentStage.name : 'approval')}` : 'Approval history for this advance'}</div></div>
          <div class="actions">${currentStage ? `<span class="badge-plain">Current stage: ${esc(currentStage.name)}</span>` : ''}</div>
        </div>
        <div class="table-wrap">
          <table class="tbl">
            <thead><tr><th>Stage</th><th>Role</th><th>Status</th><th>Approver</th><th>Acted</th><th>Remarks</th></tr></thead>
            <tbody>${data.stages.map((s) => stageRow(s)).join('')}</tbody>
          </table>
        </div>
        ${currentStage && canActOn(currentStage) ? `<div class="card-body" style="display:flex;gap:8px;flex-wrap:wrap;border-top:1px solid var(--border)">
          <button class="btn btn-accent" data-act="approve">${icon('check')} Approve</button>
          <button class="btn" data-act="return">${icon('arrowLeft')} Return for correction</button>
          <button class="btn btn-danger" data-act="reject">${icon('x')} Reject</button>
        </div>` : ''}
      </div>`
    : '';

  ctx.view.innerHTML = `
    <div class="page-head">
      <div>
        <div class="small muted" style="margin-bottom:4px"><a href="#/advances">Advance Register</a> / ${esc(a.advanceNo)}</div>
        <h1 style="display:flex;align-items:center;gap:10px">${esc(a.advanceNo)} ${statusBadge(a.status)}</h1>
        <div class="sub">${esc(a.vendorName)} \u00b7 ${fmtDate(a.advanceDate)}</div>
      </div>
      <div class="page-actions">
        <a class="btn" href="#/advances">${icon('arrowLeft')} Back</a>
        ${approved ? `<a class="btn" href="#/advances/${a.id}/print">${icon('printer')} Print voucher</a>` : ''}
        ${a.status === 'returned' && can('advance.create') ? `<button class="btn btn-primary" data-resubmit>${icon('send')} Resubmit</button>` : ''}
        ${can('advance.edit') && ['Open', 'Partially Adjusted'].includes(a.status) ? `<button class="btn" data-close-adv>${icon('lock')} Close advance</button>` : ''}
        ${can('advance.edit') && ['pending', 'returned', 'rejected'].includes(a.status) ? `<button class="btn btn-danger" data-delete>${icon('trash')} Delete</button>` : ''}
      </div>
    </div>

    <div class="grid grid-4 mb-16">
      <div class="card"><div class="kpi"><div class="chip blue">${icon('wallet')}</div><div><div class="label">Advance amount</div><div class="value small-value">${money(a.amount)}</div><div class="meta">Recorded ${fmtDate(a.createdAt)}</div></div></div></div>
      <div class="card"><div class="kpi"><div class="chip green">${icon('checkCircle')}</div><div><div class="label">Adjusted</div><div class="value small-value">${money(a.adjustedAmount)}</div><div class="meta">${data.bills.length} invoice(s)</div></div></div></div>
      <div class="card"><div class="kpi"><div class="chip amber">${icon('clock')}</div><div><div class="label">Balance</div><div class="value small-value">${money(a.balance)}</div><div class="meta">Available for future bills</div></div></div></div>
      <div class="card"><div class="kpi"><div class="chip purple">${icon('briefcase')}</div><div><div class="label">Vendor</div><div class="value small-value" style="font-size:16px">${esc(a.vendorName)}</div><div class="meta mono">${esc(a.vendorCode)}</div></div></div></div>
    </div>

    <div class="split">
      <div class="stack">
        <div class="card">
          <div class="card-head"><div><h3>Advance Ledger</h3><div class="sub">Running balance for this advance</div></div></div>
          <div class="table-wrap">
            <table class="tbl">
              <thead><tr><th>Date</th><th>Transaction</th><th class="num">Debit</th><th class="num">Credit</th><th class="num">Balance</th><th>Notes</th></tr></thead>
              <tbody>
                ${data.ledger
                  .map(
                    (l) => `<tr>
                      <td class="nowrap">${fmtDate(l.date)}</td>
                      <td><b>${esc(l.type)}</b>${l.user ? `<div class="small muted">${esc(l.user)}</div>` : ''}</td>
                      <td class="num">${l.debit ? money(l.debit) : '\u2014'}</td>
                      <td class="num">${l.credit ? money(l.credit) : '\u2014'}</td>
                      <td class="num fw-700">${money(l.balance)}</td>
                      <td class="small muted">${esc(l.notes || '')}</td>
                    </tr>`
                  )
                  .join('')}
              </tbody>
              <tfoot><tr><td colspan="4">Closing balance</td><td class="num">${money(a.balance)}</td><td></td></tr></tfoot>
            </table>
          </div>
        </div>

        <div class="card">
          <div class="card-head"><div><h3>Bills Adjusted</h3><div class="sub">Invoices this advance has been applied to</div></div></div>
          <div class="table-wrap">
            ${data.bills.length
              ? `<table class="tbl"><thead><tr><th>Bill No</th><th>Invoice</th><th>Bill Date</th><th class="num">Bill Amount</th><th class="num">Adjusted</th><th>Status</th></tr></thead>
                  <tbody>${data.bills
                    .map(
                      (b) => `<tr><td><a class="strong" href="#/bills/${b.id}">${esc(b.bill_no)}</a></td>
                        <td class="mono small">${esc(b.invoice_number)}</td><td>${fmtDate(b.entry_date)}</td>
                        <td class="num">${money(b.net_amount)}</td><td class="num fw-700">${money(b.amount)}</td>
                        <td>${statusBadge(b.status)}</td></tr>`
                    )
                    .join('')}</tbody></table>`
              : '<div class="empty small">No bills have been adjusted against this advance yet.</div>'}
          </div>
        </div>
      </div>

      <div class="stack">
        <div class="card">
          <div class="card-head"><div><h3>Advance Details</h3></div></div>
          <div class="card-body">
            <dl class="dl compact">
              <dt>Advance No</dt><dd class="mono">${esc(a.advanceNo)}</dd>
              <dt>Vendor</dt><dd><a href="#/vendors/${a.vendorId}">${esc(a.vendorName)}</a></dd>
              <dt>Date</dt><dd>${fmtDate(a.advanceDate)}</dd>
              <dt>Department</dt><dd>${esc(a.departmentName || '\u2014')}</dd>
              <dt>Purpose</dt><dd>${esc(a.purpose || '\u2014')}</dd>
              <dt>Remarks</dt><dd>${esc(a.remarks || '\u2014')}</dd>
              <dt>Status</dt><dd>${statusBadge(a.status)}</dd>
            </dl>
          </div>
        </div>
        <div class="card">
          <div class="card-head"><div><h3>Utilisation</h3></div></div>
          <div class="card-body">
            <div class="progress"><div class="bar" style="width:${a.amount ? Math.min(Math.round((a.adjustedAmount / a.amount) * 100), 100) : 0}%"></div></div>
            <div class="row mt-8" style="justify-content:space-between">
              <span class="small muted">${a.amount ? Math.round((a.adjustedAmount / a.amount) * 100) : 0}% adjusted</span>
              <span class="small">${money(a.balance)} left</span>
            </div>
            <div class="help-block mt-12">Remaining balances are offered automatically when a bill is entered for this vendor.</div>
          </div>
        </div>
      </div>
    </div>

    ${approvalCard}`;

  ctx.view.querySelector('[data-close-adv]')?.addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: 'Close advance',
      message: 'Closing writes off the remaining unadjusted balance. It can no longer be adjusted against bills.',
      confirmText: 'Close advance',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.post(`/api/advances/${a.id}/close`);
      toast('Advance closed.');
      reloadPage();
    } catch (e) { toast(e.message, 'error'); }
  });

  ctx.view.querySelector('[data-delete]')?.addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: 'Delete advance',
      message: 'Delete this advance record? Only advances with no adjustments can be deleted.',
      confirmText: 'Delete',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.del(`/api/advances/${a.id}`);
      toast('Advance deleted.');
      navigate('/advances');
    } catch (e) { toast(e.message, 'error'); }
  });

  ctx.view.querySelector('[data-resubmit]')?.addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: 'Resubmit advance',
      message: 'Resubmit this advance for approval? The approval chain will be rebuilt.',
      confirmText: 'Resubmit',
    });
    if (!ok) return;
    try {
      await api.post(`/api/advances/${a.id}/submit`);
      toast('Advance resubmitted for approval.');
      reloadPage();
    } catch (e) { toast(e.message, 'error'); }
  });

  ctx.view.querySelectorAll('[data-act]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const action = btn.dataset.act;
      const dialog = await actionDialog({
        title: `${action === 'approve' ? 'Approve' : action === 'return' ? 'Return' : 'Reject'} advance`,
        subtitle: `${a.advanceNo} \u00b7 ${money(a.amount)}`,
        confirmText: action === 'approve' ? 'Approve advance' : action === 'return' ? 'Return for correction' : 'Reject advance',
        requireComment: action !== 'approve',
        danger: action === 'reject',
        signature: action === 'approve',
      });
      if (!dialog) return;
      try {
        const res = await api.post(`/api/advances/${a.id}/action`, {
          action,
          comments: dialog.comments,
          signatureImage: state.user.signatureImage,
        });
        toast(res.message || 'Advance updated.');
        reloadPage();
      } catch (e) { toast(e.message, 'error'); }
    });
  });
}

/* ================================================================== */
/* PRINT VOUCHER                                                       */
/* ================================================================== */
export async function renderPrint(ctx, { id }) {
  ctx.view.innerHTML = `<div class="empty">Preparing advance voucher\u2026</div>`;
  const data = await api.get(`/api/advances/${id}`);
  const a = data.advance;
  const approved = !!a.approvedAt || OPERATIONAL_STATUSES.includes(a.status);
  if (!approved) {
    toast('Only approved advances can be printed for accounts submission.', 'error');
    navigate(`/advances/${a.id}`);
    return;
  }
  const settings = state.settings || {};
  const printMoney = (value) => (Number(value) ? money(value) : '');
  const stageRows = data.stages
    .map((s) => `<tr>
      <td>${esc(s.sequence)}. ${esc(s.name)}</td>
      <td>${esc(s.roleName || '')}</td>
      <td>${esc(s.actedByName || '\u2014')}</td>
      <td>${esc((s.status || '').charAt(0).toUpperCase() + (s.status || '').slice(1))}</td>
      <td>${s.actedAt ? fmtDate(s.actedAt, true) : '\u2014'}</td>
      <td>${esc(s.comments || '')}</td>
      <td style="width:80px">${s.signatureImage ? `<img src="${s.signatureImage.startsWith('data:') ? s.signatureImage : `data:image/png;base64,${s.signatureImage}`}" style="max-height:28px" alt="Signature" />` : ''}</td>
    </tr>`)
    .join('');
  const billRows = data.bills
    .map((b) => `<tr>
      <td>${esc(b.bill_no)}</td>
      <td>${esc(b.invoice_number || '')}</td>
      <td>${fmtDate(b.entry_date)}</td>
      <td class="num">${printMoney(b.net_amount)}</td>
      <td class="num">${printMoney(b.amount)}</td>
    </tr>`)
    .join('');

  ctx.view.innerHTML = `
    <div class="page-head no-print">
      <div><h1>Advance Voucher</h1><div class="sub">${esc(a.advanceNo)} \u00b7 ${esc(a.vendorName)}</div></div>
      <div class="page-actions">
        <a class="btn" href="#/advances/${a.id}">${icon('arrowLeft')} Back to advance</a>
        <button class="btn" data-print>${icon('printer')} Print</button>
        <button class="btn btn-primary" data-pdf>${icon('download')} Save as PDF</button>
      </div>
    </div>

    <div class="print-report">
      <div class="report-sheet card" style="box-shadow:var(--shadow)">
        <div class="report-header">
          <div class="org">
            <h2>${esc(settings.orgName || '')}</h2>
            <p>${esc(settings.orgDepartment || '')}</p>
            <p style="margin-top:6px"><b>VENDOR ADVANCE VOUCHER</b></p>
            <p>Generated: ${fmtDate(new Date().toISOString(), true)}</p>
          </div>
          <div class="report-meta">
            <div><b>Voucher No</b><span>${esc(a.advanceNo)}</span></div>
            <div><b>Advance Date</b><span>${fmtDate(a.advanceDate)}</span></div>
            <div><b>Status</b><span>${esc(a.status)}</span></div>
            <div><b>Approved</b><span>${a.approvedAt ? fmtDate(a.approvedAt) : '\u2014'}</span></div>
          </div>
        </div>

        <div class="report-title">Vendor Advance Voucher</div>

        <div class="rp-section">
          <h3>Advance Information</h3>
          <div class="rp-grid">
            <div><span class="k">Advance Number</span><b>${esc(a.advanceNo)}</b></div>
            <div><span class="k">Vendor Code</span><b>${esc(a.vendorCode || '\u2014')}</b></div>
            <div><span class="k">Vendor</span><b>${esc(a.vendorName)}</b></div>
            <div><span class="k">Unit</span><b>${esc(a.unitName || '\u2014')}</b></div>
            <div><span class="k">Department</span><b>${esc(a.departmentName || '\u2014')}</b></div>
            <div><span class="k">Advance Date</span><b>${fmtDate(a.advanceDate)}</b></div>
            <div><span class="k">Advance Amount</span><b>${printMoney(a.amount)}</b></div>
            <div><span class="k">Adjusted Against Bills</span><b>${printMoney(a.adjustedAmount)}</b></div>
            <div><span class="k">Balance Available</span><b>${printMoney(a.balance)}</b></div>
            <div><span class="k">Final Approval</span><b>${a.approvedAt ? fmtDate(a.approvedAt, true) : '\u2014'}</b></div>
          </div>
          ${a.purpose ? `<div class="rp-note"><b>Purpose:</b> ${esc(a.purpose)}</div>` : ''}
          ${a.remarks ? `<div class="rp-note"><b>Remarks:</b> ${esc(a.remarks)}</div>` : ''}
        </div>

        <div class="rp-section">
          <h3>Approval Section</h3>
          <table class="rp-table">
            <thead><tr><th>Approval Stage</th><th>Role</th><th>Approver</th><th>Status</th><th>Date &amp; Time</th><th>Remarks</th><th>Signature</th></tr></thead>
            <tbody>${stageRows || '<tr><td colspan="7">Approval workflow not recorded.</td></tr>'}</tbody>
          </table>
        </div>

        <div class="rp-section">
          <h3>Adjustments Against Bills</h3>
          ${data.bills.length
            ? `<table class="rp-table">
                <thead><tr><th>Bill No</th><th>Invoice</th><th>Bill Date</th><th class="num">Bill Net</th><th class="num">Adjusted</th></tr></thead>
                <tbody>${billRows}</tbody>
              </table>`
            : '<div class="rp-note">No adjustments have been recorded against this advance.</div>'}
        </div>

        <div class="rp-signs" style="grid-template-columns:repeat(2,1fr)">
          <div><div class="line">Prepared By (Accounts)</div></div>
          <div><div class="line">Approved By (Administrative Pastor)</div></div>
        </div>

        <div class="rp-foot">
          <span>${esc(settings.reportFooter || 'System generated advance voucher.')}</span>
          <span>${esc(a.advanceNo)}</span>
        </div>
      </div>
    </div>`;

  ctx.view.querySelector('[data-print]').addEventListener('click', () => window.print());
  ctx.view.querySelector('[data-pdf]').addEventListener('click', () => {
    toast('Use "Save as PDF" in the print dialog.', 'info');
    setTimeout(() => window.print(), 350);
  });
}
