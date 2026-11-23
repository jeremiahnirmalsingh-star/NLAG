import { api } from '../api.js';
import { state, can } from '../state.js';
import { navigate, reloadPage, withQuery } from '../router.js';
import {
  esc, icon, money, num, fmtDate, statusBadge, emptyState, toast, modal,
  confirmDialog, actionDialog,
} from '../ui.js';

/* Imprests are printable once they have received final approval, even if they
   have not been physically issued yet. */
const PRINTABLE_STATUSES = ['approved', 'Open', 'Partially Settled', 'Settled', 'Overdue'];

function canActOn(stage) {
  if (!stage || stage.status !== 'pending') return false;
  if (state.user.roleCode === 'super_admin') return true;
  if (stage.userId && Number(stage.userId) === Number(state.user.id)) return true;
  return state.user.roleCode === stage.roleCode;
}

function stageRow(s) {
  return `<tr>
    <td>${esc(s.sequence)}. ${esc(s.name)}</td>
    <td>${esc(s.roleName || '')}</td>
    <td>${statusBadge(s.status)}</td>
    <td>${esc(s.actedByName || '\u2014')}</td>
    <td>${s.actedAt ? fmtDate(s.actedAt, true) : '\u2014'}</td>
    <td class="small">${esc(s.comments || '')}</td>
  </tr>`;
}

/* ================================================================== */
/* LIST                                                                */
/* ================================================================== */
export async function render(ctx) {
  const q = ctx.route.query || {};
  const params = new URLSearchParams();
  if (q.search) params.set('search', q.search);
  if (q.status) params.set('status', q.status);

  ctx.view.innerHTML = `<div class="empty">Loading imprests\u2026</div>`;
  let data;
  try {
    data = await api.get(`/api/imprests?${params.toString()}`);
  } catch (e) {
    ctx.view.innerHTML = `<div class="card"><div class="empty"><h4>Unable to load imprests</h4><div class="small">${esc(e.message)}</div></div></div>`;
    return;
  }
  const rows = data.imprests || [];
  const s = data.summary || {};

  ctx.view.innerHTML = `
    <div class="page-head">
      <div>
        <h1>Imprests</h1>
        <div class="sub">Track advances issued to employees and their settlement against bills</div>
      </div>
      <div class="page-actions">
        <a class="btn" href="/api/reports/advance-register?format=csv">${icon('download')} Export</a>
        ${can('advance.create') ? `<button class="btn btn-primary" data-new>${icon('plus')} Issue Imprest</button>` : ''}
      </div>
    </div>

    <div class="grid grid-4 mb-16">
      <div class="card"><div class="kpi"><div class="chip blue">${icon('wallet')}</div><div><div class="label">Imprests issued</div><div class="value small-value">${money(s.issued || 0)}</div><div class="meta">${num(s.count || 0)} records</div></div></div></div>
      <div class="card"><div class="kpi"><div class="chip green">${icon('checkCircle')}</div><div><div class="label">Settled</div><div class="value small-value">${money(s.settled || 0)}</div><div class="meta">Against bills</div></div></div></div>
      <div class="card"><div class="kpi"><div class="chip amber">${icon('clock')}</div><div><div class="label">Outstanding</div><div class="value small-value">${money(s.outstanding || 0)}</div><div class="meta">Yet to be settled</div></div></div></div>
      <div class="card"><div class="kpi"><div class="chip purple">${icon('file')}</div><div><div class="label">Open imprests</div><div class="value">${num(rows.filter((i) => ['Open', 'Partially Settled', 'Overdue', 'approved'].includes(i.status)).length)}</div><div class="meta">Not fully settled</div></div></div></div>
    </div>

    <div class="card">
      <form class="toolbar" id="imprest-filters">
        <div class="search">${icon('search')}<input class="input" name="search" value="${esc(q.search || '')}" placeholder="Imprest no, employee, purpose..." /></div>
        <select class="select" name="status">
          <option value="">All statuses</option>
          ${[
            ['draft', 'Draft'],
            ['pending', 'Pending Approval'],
            ['approved', 'Approved'],
            ['returned', 'Returned'],
            ['rejected', 'Rejected'],
            ['Open', 'Open'],
            ['Partially Settled', 'Partially Settled'],
            ['Settled', 'Settled'],
            ['Overdue', 'Overdue'],
          ].map(([value, label]) => `<option value="${value}" ${q.status === value ? 'selected' : ''}>${label}</option>`).join('')}
        </select>
        <button class="btn btn-sm" type="submit">${icon('filter')} Apply</button>
        <button class="btn btn-sm btn-ghost" type="button" data-reset>Reset</button>
      </form>
      <div class="table-wrap">
        ${rows.length
          ? `<table class="tbl">
              <thead><tr>
                <th>Imprest No</th><th>Employee</th><th>Department</th><th>Unit</th><th>Purpose</th>
                <th class="num">Issued</th><th class="num">Settled</th><th class="num">Balance</th>
                <th>Status</th><th>Date Issued</th><th></th>
              </tr></thead>
              <tbody>
                ${rows.map((i) => `<tr>
                  <td><a class="mono strong" href="#/imprests/${i.id}">${esc(i.imprestNo)}</a></td>
                  <td>${esc(i.userName)}</td>
                  <td>${esc(i.departmentName || '\u2014')}</td>
                  <td>${esc(i.unitName || '\u2014')}</td>
                  <td class="small">${esc(i.purpose || '\u2014')}</td>
                  <td class="num">${money(i.amountIssued)}</td>
                  <td class="num">${money(i.settledAmount)}</td>
                  <td class="num fw-700">${money(i.balanceAmount)}</td>
                  <td>${statusBadge(i.status)}${i.status === 'pending' && i.currentStageName ? `<div class="small muted">${esc(i.currentStageName)}</div>` : ''}</td>
                  <td class="small nowrap">${fmtDate(i.dateIssued)}</td>
                  <td class="actions">
                    <a class="btn btn-sm btn-ghost" href="#/imprests/${i.id}" title="Open">${icon('eye')}</a>
                    ${PRINTABLE_STATUSES.includes(i.status) ? `<a class="btn btn-sm btn-ghost" href="#/imprests/${i.id}/print" title="Print voucher">${icon('printer')}</a>` : ''}
                  </td>
                </tr>`).join('')}
              </tbody>
            </table>`
          : emptyState('No imprests issued yet', 'Issue an imprest to track advances given to employees.', can('advance.create') ? '<button class="btn btn-sm btn-primary" data-new>Issue Imprest</button>' : '', 'wallet')}
      </div>
    </div>
  `;

  const form = document.getElementById('imprest-filters');
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    navigate(withQuery('/imprests', Object.fromEntries(new FormData(form).entries())));
  });
  form.querySelector('[data-reset]').addEventListener('click', () => navigate('/imprests'));
  ctx.view.querySelectorAll('[data-new]').forEach((btn) => btn.addEventListener('click', openNew));
  if (q.new === '1') openNew();
}

/* ================================================================== */
/* CREATE                                                              */
/* ================================================================== */
async function openNew() {
  let employees = [];
  try {
    const res = await api.get('/api/imprests/employees');
    employees = res.employees || [];
  } catch (e) {
    toast(e.message, 'error');
    return;
  }
  const departments = state.departments || [];
  const departmentOptions = departments
    .map((d) => `<option value="${d.id}" data-name="${esc(String(d.name).toLowerCase())}">${esc(d.name)}</option>`)
    .join('');
  const employeeOptions = employees
    .map((u) => `<option value="${u.id}" data-department="${esc(String(u.department || '').toLowerCase())}" data-unit="${u.unitId || ''}" ${Number(u.id) === Number(state.user.id) ? 'selected' : ''}>${esc(u.name)}${u.department ? ` \u2014 ${esc(u.department)}` : ''}</option>`)
    .join('');

  modal({
    title: 'Issue Imprest',
    subtitle: 'Record an advance issued to an employee',
    size: 'wide',
    body: `<form id="imprest-form">
      <div class="form-grid">
        <div class="field">
          <label>Employee *</label>
          <select class="select" name="userId" required>
            <option value="">\u2014 Select employee \u2014</option>
            ${employeeOptions}
          </select>
          <div class="hint">The department is filled from the employee record.</div>
        </div>
        <div class="field">
          <label>Department</label>
          <select class="select" name="departmentId">
            <option value="">\u2014 Select \u2014</option>
            ${departmentOptions}
          </select>
        </div>
        <div class="field">
          <label>Unit</label>
          <select class="select" name="unitId">
            <option value="">\u2014 Select \u2014</option>
            ${(state.units || []).map((u) => `<option value="${u.id}" ${u.id === (state.currentUnitIds[0] || 1) ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}
          </select>
        </div>
        <div class="field">
          <label>Amount Issued *</label>
          <input class="input" type="number" name="amountIssued" step="0.01" min="0.01" required placeholder="0.00" />
        </div>
        <div class="field">
          <label>Date Issued *</label>
          <input class="input" type="date" name="dateIssued" value="${new Date().toISOString().slice(0, 10)}" required />
        </div>
        <div class="field">
          <label>Due Date (optional)</label>
          <input class="input" type="date" name="dueDate" />
        </div>
        <div class="field" style="grid-column:1/-1">
          <label>Purpose *</label>
          <textarea class="input" name="purpose" rows="2" required placeholder="Purpose of the imprest"></textarea>
        </div>
      </div>
      <div class="alert alert-danger hidden" data-err></div>
    </form>`,
    footer: `<button class="btn" data-modal-close>Cancel</button>
             <button class="btn btn-primary" data-save>Submit for approval</button>`,
    onMount(el, close) {
      const form = el.querySelector('#imprest-form');
      const errBox = el.querySelector('[data-err]');
      const employeeSelect = form.userId;
      const departmentSelect = form.departmentId;
      const unitSelect = form.unitId;

      const syncEmployee = () => {
        const option = employeeSelect.selectedOptions[0];
        if (!option || !option.value) return;
        const normalize = (value) => String(value || '')
          .trim()
          .toLowerCase()
          .replace(/\s+department$/, '')
          .replace(/\s+/g, ' ');
        const deptName = normalize(option.dataset.department);
        const match = Array.from(departmentSelect.options).find((opt) => {
          if (!opt.value) return false;
          const optionName = normalize(opt.dataset.name);
          return optionName === deptName
            || (deptName && optionName.startsWith(deptName + ' '))
            || (optionName && deptName.startsWith(optionName + ' '));
        });
        departmentSelect.value = match ? match.value : '';
        if (option.dataset.unit) unitSelect.value = option.dataset.unit;
      };

      employeeSelect.addEventListener('change', syncEmployee);
      syncEmployee();

      el.querySelector('[data-save]').addEventListener('click', async () => {
        errBox.classList.add('hidden');
        const body = {
          userId: form.userId.value,
          departmentId: form.departmentId.value,
          unitId: form.unitId.value,
          amountIssued: Number(form.amountIssued.value) || 0,
          dateIssued: form.dateIssued.value,
          dueDate: form.dueDate.value,
          purpose: form.purpose.value.trim(),
        };
        if (!body.userId) {
          errBox.textContent = 'Please select an employee.';
          errBox.classList.remove('hidden');
          return;
        }
        if (!body.purpose || body.amountIssued <= 0 || !body.dateIssued) {
          errBox.textContent = 'Purpose, amount, and date are required.';
          errBox.classList.remove('hidden');
          return;
        }
        const saveBtn = el.querySelector('[data-save]');
        saveBtn.disabled = true;
        try {
          const res = await api.post('/api/imprests', body);
          try {
            await api.post(`/api/imprests/${res.id}/submit`);
            toast(`Imprest ${res.imprestNo} submitted for approval.`);
          } catch (submitError) {
            toast(`Imprest ${res.imprestNo} saved as a draft: ${submitError.message}`, 'info', 6000);
          }
          close();
          navigate(`/imprests/${res.id}`);
        } catch (e) {
          saveBtn.disabled = false;
          errBox.textContent = e.message;
          errBox.classList.remove('hidden');
        }
      });
    },
  });
}

/* ================================================================== */
/* DETAIL                                                              */
/* ================================================================== */
export async function renderDetail(ctx, { id }) {
  ctx.view.innerHTML = `<div class="empty">Loading imprest\u2026</div>`;
  const data = await api.get(`/api/imprests/${id}`);
  const i = data.imprest;
  const currentStage = (data.stages || []).find((s) => s.status === 'pending');
  const printable = PRINTABLE_STATUSES.includes(i.status) || !!i.approvedAt;
  const canSubmit = ['draft', 'returned'].includes(i.status) && can('advance.create');
  const canIssue = i.status === 'approved' && can('bill.approve');
  const canDelete = ['draft', 'returned', 'rejected'].includes(i.status) && can('advance.edit');

  const approvalCard = data.stages.length
    ? `<div class="card mt-16">
        <div class="card-head">
          <div><h3>Approval Workflow</h3><div class="sub">${i.status === 'pending' ? `Waiting on ${esc(currentStage ? currentStage.name : 'approval')}` : 'Approval history for this imprest'}</div></div>
          <div class="actions">${currentStage ? `<span class="badge-plain">Current stage: ${esc(currentStage.name)}</span>` : ''}</div>
        </div>
        <div class="table-wrap">
          <table class="tbl">
            <thead><tr><th>Stage</th><th>Role</th><th>Status</th><th>Approver</th><th>Acted</th><th>Remarks</th></tr></thead>
            <tbody>${data.stages.map(stageRow).join('')}</tbody>
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
        <div class="small muted" style="margin-bottom:4px"><a href="#/imprests">Imprest Register</a> / ${esc(i.imprestNo)}</div>
        <h1 style="display:flex;align-items:center;gap:10px">${esc(i.imprestNo)} ${statusBadge(i.status)}</h1>
        <div class="sub">${esc(i.userName)}${i.departmentName ? ` \u00b7 ${esc(i.departmentName)}` : ''} \u00b7 ${fmtDate(i.dateIssued)}</div>
      </div>
      <div class="page-actions">
        <a class="btn" href="#/imprests">${icon('arrowLeft')} Back</a>
        ${printable ? `<a class="btn" href="#/imprests/${i.id}/print">${icon('printer')} Print voucher</a>` : ''}
        ${canSubmit ? `<button class="btn btn-primary" data-submit>${icon('send')} ${i.status === 'returned' ? 'Resubmit' : 'Submit for approval'}</button>` : ''}
        ${canIssue ? `<button class="btn btn-accent" data-issue>${icon('checkCircle')} Issue imprest</button>` : ''}
        ${canDelete ? `<button class="btn btn-danger" data-delete>${icon('trash')} Delete</button>` : ''}
      </div>
    </div>

    <div class="grid grid-4 mb-16">
      <div class="card"><div class="kpi"><div class="chip blue">${icon('wallet')}</div><div><div class="label">Amount issued</div><div class="value small-value">${money(i.amountIssued)}</div><div class="meta">${i.approvedAt ? `Approved ${fmtDate(i.approvedAt)}` : 'Awaiting approval'}</div></div></div></div>
      <div class="card"><div class="kpi"><div class="chip green">${icon('checkCircle')}</div><div><div class="label">Settled</div><div class="value small-value">${money(i.settledAmount)}</div><div class="meta">${data.bills.length} bill(s)</div></div></div></div>
      <div class="card"><div class="kpi"><div class="chip amber">${icon('clock')}</div><div><div class="label">Balance</div><div class="value small-value">${money(i.balanceAmount)}</div><div class="meta">Yet to be settled</div></div></div></div>
      <div class="card"><div class="kpi"><div class="chip purple">${icon('briefcase')}</div><div><div class="label">Employee</div><div class="value small-value" style="font-size:16px">${esc(i.userName)}</div><div class="meta">${esc(i.departmentName || 'No department')}</div></div></div></div>
    </div>

    <div class="split">
      <div class="stack">
        <div class="card">
          <div class="card-head"><div><h3>Settlement Against Bills</h3><div class="sub">Cash bills settled from this imprest</div></div></div>
          <div class="table-wrap">
            ${data.bills.length
              ? `<table class="tbl"><thead><tr><th>Bill No</th><th>Invoice</th><th class="num">Bill Net</th><th class="num">Settled</th><th>Status</th><th>Notes</th></tr></thead>
                  <tbody>${data.bills.map((b) => `<tr>
                    <td><a class="strong" href="#/bills/${b.id}">${esc(b.billNo)}</a></td>
                    <td class="mono small">${esc(b.invoiceNumber || '\u2014')}</td>
                    <td class="num">${money(b.netAmount)}</td>
                    <td class="num fw-700">${money(b.amount)}</td>
                    <td>${statusBadge(b.status)}</td>
                    <td class="small muted">${esc(b.notes || '')}</td>
                  </tr>`).join('')}</tbody></table>`
              : '<div class="empty small">No bills have been settled from this imprest yet.</div>'}
          </div>
        </div>

        ${approvalCard}
      </div>

      <div class="stack">
        <div class="card">
          <div class="card-head"><div><h3>Imprest Details</h3></div></div>
          <div class="card-body">
            <dl class="dl compact">
              <dt>Imprest No</dt><dd class="mono">${esc(i.imprestNo)}</dd>
              <dt>Employee</dt><dd>${esc(i.userName)}</dd>
              <dt>Department</dt><dd>${esc(i.departmentName || '\u2014')}</dd>
              <dt>Unit</dt><dd>${esc(i.unitName || '\u2014')}</dd>
              <dt>Date Issued</dt><dd>${fmtDate(i.dateIssued)}</dd>
              <dt>Due Date</dt><dd>${i.dueDate ? fmtDate(i.dueDate) : '\u2014'}</dd>
              <dt>Purpose</dt><dd>${esc(i.purpose || '\u2014')}</dd>
              <dt>Status</dt><dd>${statusBadge(i.status)}</dd>
            </dl>
          </div>
        </div>
        <div class="card">
          <div class="card-head"><div><h3>Utilisation</h3></div></div>
          <div class="card-body">
            <div class="progress"><div class="bar" style="width:${i.amountIssued ? Math.min(Math.round((i.settledAmount / i.amountIssued) * 100), 100) : 0}%"></div></div>
            <div class="row mt-8" style="justify-content:space-between">
              <span class="small muted">${i.amountIssued ? Math.round((i.settledAmount / i.amountIssued) * 100) : 0}% settled</span>
              <span class="small">${money(i.balanceAmount)} left</span>
            </div>
            <div class="help-block mt-12">${
              i.status === 'Settled'
                ? 'This imprest is fully settled. No balance remains.'
                : ['Partially Settled', 'Overdue'].includes(i.status)
                  ? 'More cash bills can be settled against this imprest until the balance reaches zero.'
                  : i.status === 'approved'
                    ? 'Issue the imprest so cash bills can be settled against it.'
                    : i.status === 'Open'
                      ? 'Cash bills can be settled from this imprest while it is open.'
                      : 'Cash bills can be settled from this imprest once it is approved and issued.'
            }</div>
          </div>
        </div>
      </div>
    </div>`;

  const post = async (url, body, message) => {
    try {
      const res = await api.post(url, body);
      toast(res.message || message);
      reloadPage();
    } catch (e) { toast(e.message, 'error'); }
  };

  ctx.view.querySelector('[data-submit]')?.addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: i.status === 'returned' ? 'Resubmit imprest' : 'Submit imprest',
      message: 'Submit this imprest for approval? The approval chain is built from the amount.',
      confirmText: i.status === 'returned' ? 'Resubmit' : 'Submit for approval',
    });
    if (!ok) return;
    await post(`/api/imprests/${i.id}/submit`, {}, 'Imprest submitted for approval.');
  });

  ctx.view.querySelector('[data-issue]')?.addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: 'Issue imprest',
      message: `Release ${money(i.amountIssued)} to ${i.userName}? The imprest becomes open for settlement against cash bills.`,
      confirmText: 'Issue imprest',
    });
    if (!ok) return;
    await post(`/api/imprests/${i.id}/issue`, { amountIssued: i.amountIssued }, 'Imprest issued.');
  });

  ctx.view.querySelector('[data-delete]')?.addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: 'Delete imprest',
      message: 'Delete this imprest request? This cannot be undone.',
      confirmText: 'Delete',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.del(`/api/imprests/${i.id}`);
      toast('Imprest deleted.');
      navigate('/imprests');
    } catch (e) { toast(e.message, 'error'); }
  });

  ctx.view.querySelectorAll('[data-act]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const action = btn.dataset.act;
      const verb = action === 'approve' ? 'Approve' : action === 'return' ? 'Return' : 'Reject';
      const dialog = await actionDialog({
        title: `${verb} imprest`,
        subtitle: `${i.imprestNo} \u00b7 ${money(i.amountIssued)}`,
        confirmText: action === 'approve' ? 'Approve imprest' : action === 'return' ? 'Return for correction' : 'Reject imprest',
        requireComment: action !== 'approve',
        danger: action === 'reject',
        signature: true,
      });
      if (!dialog) return;
      const url = action === 'approve' ? `/api/imprests/${i.id}/approve` : action === 'return' ? `/api/imprests/${i.id}/return` : `/api/imprests/${i.id}/reject`;
      await post(url, { comments: dialog.comments, signatureImage: state.user.signatureImage }, 'Imprest updated.');
    });
  });
}

/* ================================================================== */
/* PRINT VOUCHER                                                       */
/* ================================================================== */
export async function renderPrint(ctx, { id }) {
  ctx.view.innerHTML = `<div class="empty">Preparing imprest voucher\u2026</div>`;
  const data = await api.get(`/api/imprests/${id}`);
  const i = data.imprest;
  if (!(PRINTABLE_STATUSES.includes(i.status) || i.approvedAt)) {
    toast('Only approved imprests can be printed for accounts submission.', 'error');
    navigate(`/imprests/${i.id}`);
    return;
  }
  const settings = state.settings || {};
  const printMoney = (value) => (Number(value) ? money(value) : '');
  const statusText = (value) => String(value || '')
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (ch) => ch.toUpperCase());
  const stageRows = data.stages
    .map((s) => `<tr>
      <td>${esc(s.sequence)}. ${esc(s.name)}</td>
      <td>${esc(s.roleName || '')}</td>
      <td>${esc(s.actedByName || '\u2014')}</td>
      <td>${esc(statusText(s.status))}</td>
      <td>${s.actedAt ? fmtDate(s.actedAt, true) : '\u2014'}</td>
      <td>${esc(s.comments || '')}</td>
      <td style="width:80px">${s.signatureImage ? `<img src="${s.signatureImage.startsWith('data:') ? s.signatureImage : `data:image/png;base64,${s.signatureImage}`}" style="max-height:28px" alt="Signature" />` : ''}</td>
    </tr>`)
    .join('');
  const billRows = data.bills
    .map((b) => `<tr>
      <td>${esc(b.billNo)}</td>
      <td>${esc(b.invoiceNumber || '')}</td>
      <td class="num">${printMoney(b.netAmount)}</td>
      <td class="num">${printMoney(b.amount)}</td>
      <td>${esc(statusText(b.status))}</td>
    </tr>`)
    .join('');

  ctx.view.innerHTML = `
    <div class="page-head no-print">
      <div><h1>Imprest Voucher</h1><div class="sub">${esc(i.imprestNo)} \u00b7 ${esc(i.userName)}</div></div>
      <div class="page-actions">
        <a class="btn" href="#/imprests/${i.id}">${icon('arrowLeft')} Back to imprest</a>
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
            <p style="margin-top:6px"><b>EMPLOYEE IMPREST VOUCHER</b></p>
            <p>Generated: ${fmtDate(new Date().toISOString(), true)}</p>
          </div>
          <div class="report-meta">
            <div><b>Voucher No</b><span>${esc(i.imprestNo)}</span></div>
            <div><b>Date Issued</b><span>${fmtDate(i.dateIssued)}</span></div>
            <div><b>Status</b><span>${esc(statusText(i.status))}</span></div>
            <div><b>Approved</b><span>${i.approvedAt ? fmtDate(i.approvedAt) : '\u2014'}</span></div>
          </div>
        </div>

        <div class="report-title">Employee Imprest Voucher</div>

        <div class="rp-section">
          <h3>Imprest Information</h3>
          <div class="rp-grid">
            <div><span class="k">Imprest Number</span><b>${esc(i.imprestNo)}</b></div>
            <div><span class="k">Employee</span><b>${esc(i.userName)}</b></div>
            <div><span class="k">Department</span><b>${esc(i.departmentName || '\u2014')}</b></div>
            <div><span class="k">Unit</span><b>${esc(i.unitName || '\u2014')}</b></div>
            <div><span class="k">Date Issued</span><b>${fmtDate(i.dateIssued)}</b></div>
            <div><span class="k">Due Date</span><b>${i.dueDate ? fmtDate(i.dueDate) : '\u2014'}</b></div>
            <div><span class="k">Amount Issued</span><b>${printMoney(i.amountIssued)}</b></div>
            <div><span class="k">Settled Against Bills</span><b>${printMoney(i.settledAmount)}</b></div>
            <div><span class="k">Balance</span><b>${printMoney(i.balanceAmount)}</b></div>
            <div><span class="k">Final Approval</span><b>${i.approvedAt ? fmtDate(i.approvedAt, true) : '\u2014'}</b></div>
          </div>
          <div class="rp-note"><b>Purpose:</b> ${esc(i.purpose || '\u2014')}</div>
        </div>

        <div class="rp-section">
          <h3>Approval Section</h3>
          <table class="rp-table">
            <thead><tr><th>Approval Stage</th><th>Role</th><th>Approver</th><th>Status</th><th>Date &amp; Time</th><th>Remarks</th><th>Signature</th></tr></thead>
            <tbody>${stageRows || '<tr><td colspan="7">Approval workflow not recorded.</td></tr>'}</tbody>
          </table>
        </div>

        <div class="rp-section">
          <h3>Settlement Against Bills</h3>
          ${data.bills.length
            ? `<table class="rp-table">
                <thead><tr><th>Bill No</th><th>Invoice</th><th class="num">Bill Net</th><th class="num">Settled</th><th>Status</th></tr></thead>
                <tbody>${billRows}</tbody>
              </table>`
            : '<div class="rp-note">No bills have been settled from this imprest.</div>'}
        </div>

        <div class="rp-signs" style="grid-template-columns:repeat(2,1fr)">
          <div><div class="line">Employee Signature</div></div>
          <div><div class="line">Approved By (Administrative Pastor)</div></div>
        </div>

        <div class="rp-foot">
          <span>${esc(settings.reportFooter || 'System generated imprest voucher.')}</span>
          <span>${esc(i.imprestNo)}</span>
        </div>
      </div>
    </div>`;

  ctx.view.querySelector('[data-print]').addEventListener('click', () => window.print());
  ctx.view.querySelector('[data-pdf]').addEventListener('click', () => {
    toast('Use "Save as PDF" in the print dialog.', 'info');
    setTimeout(() => window.print(), 350);
  });
}
