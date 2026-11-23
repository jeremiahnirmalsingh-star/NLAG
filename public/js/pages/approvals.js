import { api } from '../api.js';
import { state } from '../state.js';
import { reloadPage } from '../router.js';
import {
  esc, icon, money, num, fmtDate, statusBadge, priorityBadge, emptyState, toast, actionDialog,
} from '../ui.js';

function daysSince(dateStr) {
  if (!dateStr) return 0;
  return Math.max(0, Math.floor((Date.now() - new Date(dateStr).getTime()) / 86400000));
}

function waitingCell(dateStr) {
  const days = daysSince(dateStr);
  return `<td><span class="${days > 3 ? 'text-red fw-700' : 'small'}">${days === 0 ? 'Today' : `${days} day${days === 1 ? '' : 's'}`}</span>
    <div class="small muted">${fmtDate(dateStr)}</div></td>`;
}

export async function render(ctx) {
  ctx.view.innerHTML = `<div class="empty">Loading approval inbox\u2026</div>`;
  const [billsRes, advancesRes, imprestsRes] = await Promise.all([
    api.get('/api/bills?pendingForMe=1&pageSize=100'),
    api.get('/api/advances?pendingForMe=1'),
    api.get('/api/imprests?pendingForMe=1'),
  ]);
  const bills = billsRes.bills || [];
  const advances = advancesRes.advances || [];
  const imprests = imprestsRes.imprests || [];
  const billValue = bills.reduce((s, b) => s + (b.netAmount || 0), 0);
  const advanceValue = advances.reduce((s, a) => s + (a.amount || 0), 0);
  const imprestValue = imprests.reduce((s, i) => s + (i.amountIssued || 0), 0);
  const totalValue = billValue + advanceValue + imprestValue;
  const totalPending = bills.length + advances.length + imprests.length;
  const overdue = [
    ...bills.map((b) => b.submittedAt),
    ...advances.map((a) => a.submittedAt),
    ...imprests.map((i) => i.submittedAt),
  ].filter((d) => daysSince(d) > 3).length;

  ctx.view.innerHTML = `
    <div class="page-head">
      <div><h1>Approval Inbox</h1>
        <div class="sub">Bills, vendor advances and imprests awaiting your decision as ${esc(state.user.roleName)}</div></div>
      <div class="page-actions">
        <a class="btn" href="${state.pendingApprovals ? '#/bills?pendingForMe=1' : '#/bills'}">${icon('file')} View in Bills</a>
      </div>
    </div>

    <div class="grid grid-3 mb-16">
      <div class="card"><div class="kpi"><div class="chip amber">${icon('checkSquare')}</div>
        <div><div class="label">Awaiting your action</div><div class="value">${num(totalPending)}</div><div class="meta">Bills ${num(bills.length)} \u00b7 Advances ${num(advances.length)} \u00b7 Imprests ${num(imprests.length)}</div></div></div></div>
      <div class="card"><div class="kpi"><div class="chip blue">${icon('wallet')}</div>
        <div><div class="label">Value in queue</div><div class="value small-value">${money(totalValue)}</div><div class="meta">Net bills, advances and imprests</div></div></div></div>
      <div class="card"><div class="kpi"><div class="chip red">${icon('clock')}</div>
        <div><div class="label">Pending over 3 days</div><div class="value">${num(overdue)}</div><div class="meta">Escalation attention needed</div></div></div></div>
    </div>

    <div class="card">
      <div class="card-head"><div><h3>Pending Bills</h3><div class="sub">Oldest submissions first</div></div>
        <div class="actions">
          <span class="badge-plain" data-selected-count>0 selected</span>
          <button class="btn btn-sm btn-accent" data-bulk-approve disabled>${icon('check')} Approve selected</button>
          <span class="badge-plain">${esc(state.user.roleName)}</span>
        </div></div>
      <div class="table-wrap">
        ${bills.length
          ? `<table class="tbl">
              <thead><tr>
                <th style="width:34px"><input type="checkbox" data-select-all aria-label="Select all bills" /></th>
                <th>Bill</th><th>Vendor</th><th>Unit</th><th>Department</th><th class="num">Net Amount</th><th>Current Stage</th><th>Waiting</th><th></th>
              </tr></thead>
              <tbody>
                ${bills
                  .sort((a, b) => String(a.submittedAt).localeCompare(String(b.submittedAt)))
                  .map(
                    (b) => {
                      const days = daysSince(b.submittedAt);
                      const isVerify = b.currentStageRoleCode === 'admin_assistant';
                      const isAdmin = b.currentStageRoleCode === 'administrator';
                      const actionLabel = isVerify ? 'Verify' : 'Approve';
                      return `<tr>
                        <td><input type="checkbox" data-select value="${b.id}" data-bill="${esc(b.billNo)}" data-amount="${b.netAmount}" data-stage-role="${esc(b.currentStageRoleCode || '')}" aria-label="Select ${esc(b.billNo)}" /></td>
                        <td><a class="strong" href="#/bills/${b.id}">${esc(b.billNo)}</a>
                          <div class="small muted">${esc(b.invoiceNumber)} \u00b7 ${fmtDate(b.invoiceDate)} ${priorityBadge(b.priority)}</div></td>
                        <td>${esc(b.vendorName)}<div class="small muted">${esc(b.vendorCode || '')}</div></td>
                        <td>${esc(b.departmentName || '\u2014')}<div class="small muted">${esc(b.categoryName || '')}</div></td>
                        <td class="num strong">${money(b.netAmount)}${b.advanceAdjusted ? `<div class="small muted">Adv ${money(b.advanceAdjusted)}</div>` : ''}</td>
                        <td>${esc(b.currentStageName || '\u2014')}</td>
                        <td><span class="${days > 3 ? 'text-red fw-700' : 'small'}">${days === 0 ? 'Today' : `${days} day${days === 1 ? '' : 's'}`}</span>
                          <div class="small muted">${fmtDate(b.submittedAt)}</div></td>
                        <td class="actions">
                          <a class="btn btn-sm" href="#/bills/${b.id}">${icon('eye')} Review</a>
                          <button class="btn btn-sm btn-accent" data-approve="${b.id}" data-bill="${esc(b.billNo)}" data-amount="${b.netAmount}" data-stage-role="${esc(b.currentStageRoleCode || '')}">${icon('check')} ${actionLabel}</button>
                          ${isAdmin ? `<button class="btn btn-sm" data-forward="${b.id}" data-bill="${esc(b.billNo)}" data-amount="${b.netAmount}" title="Approve and send to the Administrative Pastor regardless of his approval category">${icon('send')} To Pastor</button>` : ''}
                        </td>
                      </tr>`;
                    }
                  )
                  .join('')}
              </tbody>
            </table>`
          : emptyState('No bills pending', 'There are no bills waiting for your action right now.', '<a class="btn btn-sm" href="#/bills">Browse all bills</a>', 'checkCircle')}
      </div>
    </div>

    <div class="card mt-16">
      <div class="card-head"><div><h3>Pending Vendor Advances</h3><div class="sub">Advances follow the standard approval chain; no Administrative Assistant verification</div></div>
        <div class="actions"><a class="btn btn-sm" href="#/advances">${icon('wallet')} Advance register</a></div></div>
      <div class="table-wrap">
        ${advances.length
          ? `<table class="tbl">
              <thead><tr><th>Advance</th><th>Vendor</th><th>Unit</th><th class="num">Amount</th><th>Current Stage</th><th>Waiting</th><th></th></tr></thead>
              <tbody>${advances.map((a) => `<tr>
                <td><a class="strong mono" href="#/advances/${a.id}">${esc(a.advanceNo)}</a>
                  <div class="small muted">${fmtDate(a.advanceDate)}</div></td>
                <td>${esc(a.vendorName)}<div class="small muted">${esc(a.vendorCode || '')}</div></td>
                <td>${esc(a.unitName || '\u2014')}</td>
                <td class="num strong">${money(a.amount)}</td>
                <td>${esc(a.currentStageName || '\u2014')}<div class="small muted">${statusBadge(a.status)}</div></td>
                ${waitingCell(a.submittedAt)}
                <td class="actions">
                  <a class="btn btn-sm" href="#/advances/${a.id}">${icon('eye')} Review</a>
                  <button class="btn btn-sm btn-accent" data-adv-approve="${a.id}" data-no="${esc(a.advanceNo)}" data-amount="${a.amount}">${icon('check')} Approve</button>
                </td>
              </tr>`).join('')}</tbody>
            </table>`
          : emptyState('No advances pending', 'Vendor advances awaiting approval will appear here.', '<a class="btn btn-sm" href="#/advances">Browse advances</a>', 'wallet')}
      </div>
    </div>

    <div class="card mt-16">
      <div class="card-head"><div><h3>Pending Imprests</h3><div class="sub">Employee imprest requests awaiting approval</div></div>
        <div class="actions"><a class="btn btn-sm" href="#/imprests">${icon('wallet')} Imprest register</a></div></div>
      <div class="table-wrap">
        ${imprests.length
          ? `<table class="tbl">
              <thead><tr><th>Imprest</th><th>Employee</th><th>Department</th><th>Unit</th><th class="num">Amount</th><th>Current Stage</th><th>Waiting</th><th></th></tr></thead>
              <tbody>${imprests.map((i) => `<tr>
                <td><a class="strong mono" href="#/imprests/${i.id}">${esc(i.imprestNo)}</a>
                  <div class="small muted">${fmtDate(i.dateIssued)}</div></td>
                <td>${esc(i.userName)}</td>
                <td>${esc(i.departmentName || '\u2014')}</td>
                <td>${esc(i.unitName || '\u2014')}</td>
                <td class="num strong">${money(i.amountIssued)}</td>
                <td>${esc(i.currentStageName || '\u2014')}<div class="small muted">${statusBadge(i.status)}</div></td>
                ${waitingCell(i.submittedAt)}
                <td class="actions">
                  <a class="btn btn-sm" href="#/imprests/${i.id}">${icon('eye')} Review</a>
                  <button class="btn btn-sm btn-accent" data-imp-approve="${i.id}" data-no="${esc(i.imprestNo)}" data-amount="${i.amountIssued}">${icon('check')} Approve</button>
                </td>
              </tr>`).join('')}</tbody>
            </table>`
          : emptyState('No imprests pending', 'Employee imprest requests awaiting approval will appear here.', '<a class="btn btn-sm" href="#/imprests">Browse imprests</a>', 'wallet')}
      </div>
    </div>

    <div class="card mt-16">
      <div class="card-body" style="display:flex;gap:16px;align-items:flex-start">
        <div class="chip teal">${icon('info')}</div>
        <div class="small muted">
          <b style="color:var(--text)">Approval guidance.</b> Verify the invoice or request against the supporting documents, confirm the vendor or employee and amounts,
          and check any advance or imprest adjustments before acting. Rejections and returns notify the creator immediately and are recorded in the audit trail.
        </div>
      </div>
    </div>`;

  const selectAll = ctx.view.querySelector('[data-select-all]');
  const bulkBtn = ctx.view.querySelector('[data-bulk-approve]');
  const selectedLabel = ctx.view.querySelector('[data-selected-count]');
  const checkboxes = () => Array.from(ctx.view.querySelectorAll('[data-select]'));

  const updateSelection = () => {
    const boxes = checkboxes();
    const selected = boxes.filter((box) => box.checked);
    if (selectedLabel) selectedLabel.textContent = `${selected.length} selected`;
    if (bulkBtn) {
      bulkBtn.disabled = selected.length === 0;
      const allVerify = selected.length > 0 && selected.every((box) => box.dataset.stageRole === 'admin_assistant');
      bulkBtn.innerHTML = `${icon('check')} ${allVerify ? 'Verify' : 'Approve'} selected`;
    }
    if (selectAll) {
      selectAll.checked = boxes.length > 0 && selected.length === boxes.length;
      selectAll.indeterminate = selected.length > 0 && selected.length < boxes.length;
    }
  };

  if (selectAll) {
    selectAll.addEventListener('change', () => {
      checkboxes().forEach((box) => { box.checked = selectAll.checked; });
      updateSelection();
    });
  }
  checkboxes().forEach((box) => box.addEventListener('change', updateSelection));
  updateSelection();

  if (bulkBtn) {
    bulkBtn.addEventListener('click', async () => {
      const selected = checkboxes().filter((box) => box.checked);
      if (!selected.length) return;
      const total = selected.reduce((sum, box) => sum + (Number(box.dataset.amount) || 0), 0);
      const allVerify = selected.every((box) => box.dataset.stageRole === 'admin_assistant');
      const verb = allVerify ? 'Verify' : 'Approve';
      const dialog = await actionDialog({
        title: `${verb} ${selected.length} bill${selected.length === 1 ? '' : 's'}`,
        subtitle: `Combined net amount ${money(total)}`,
        confirmText: `${verb} ${selected.length} bill${selected.length === 1 ? '' : 's'}`,
        signature: true,
      });
      if (!dialog) return;
      bulkBtn.disabled = true;
      try {
        const result = await api.post('/api/bills/bulk-action', {
          ids: selected.map((box) => Number(box.value)),
          action: 'approve',
          comments: dialog.comments,
        });
        toast(result.message || 'Bills processed.');
        if (result.failed) {
          const failedRows = (result.results || []).filter((r) => !r.ok);
          failedRows.slice(0, 5).forEach((r) => toast(`Bill #${r.id}: ${r.error}`, 'error', 6000));
        }
        reloadPage();
      } catch (e) {
        bulkBtn.disabled = false;
        toast(e.message, 'error');
      }
    });
  }

  ctx.view.querySelectorAll('[data-approve]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const isVerify = btn.dataset.stageRole === 'admin_assistant';
      const verb = isVerify ? 'Verify' : 'Approve';
      const dialog = await actionDialog({
        title: `${verb} bill`,
        subtitle: `${btn.dataset.bill} \u00b7 ${money(Number(btn.dataset.amount))}`,
        confirmText: `${verb} bill`,
        signature: true,
      });
      if (!dialog) return;
      try {
        const result = await api.post(`/api/bills/${btn.dataset.approve}/action`, {
          action: 'approve',
          comments: dialog.comments,
        });
        toast(result.message || (isVerify ? 'Bill verified.' : 'Bill approved.'));
        reloadPage();
      } catch (e) {
        toast(e.message, 'error');
      }
    });
  });

  ctx.view.querySelectorAll('[data-forward]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const dialog = await actionDialog({
        title: 'Forward to Administrative Pastor',
        subtitle: `${btn.dataset.bill} \u00b7 ${money(Number(btn.dataset.amount))}`,
        confirmText: 'Approve and forward',
        signature: true,
      });
      if (!dialog) return;
      try {
        const result = await api.post(`/api/bills/${btn.dataset.forward}/action`, {
          action: 'approve',
          comments: dialog.comments,
          forwardToAdminPastor: true,
        });
        toast(result.message || 'Forwarded to the Administrative Pastor.');
        reloadPage();
      } catch (e) {
        toast(e.message, 'error');
      }
    });
  });

  ctx.view.querySelectorAll('[data-adv-approve]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const dialog = await actionDialog({
        title: 'Approve vendor advance',
        subtitle: `${btn.dataset.no} \u00b7 ${money(Number(btn.dataset.amount))}`,
        confirmText: 'Approve advance',
        signature: true,
      });
      if (!dialog) return;
      try {
        const result = await api.post(`/api/advances/${btn.dataset.advApprove}/action`, {
          action: 'approve',
          comments: dialog.comments,
          signatureImage: state.user.signatureImage,
        });
        toast(result.message || 'Advance approved.');
        reloadPage();
      } catch (e) {
        toast(e.message, 'error');
      }
    });
  });

  ctx.view.querySelectorAll('[data-imp-approve]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const dialog = await actionDialog({
        title: 'Approve imprest',
        subtitle: `${btn.dataset.no} \u00b7 ${money(Number(btn.dataset.amount))}`,
        confirmText: 'Approve imprest',
        signature: true,
      });
      if (!dialog) return;
      try {
        const result = await api.post(`/api/imprests/${btn.dataset.impApprove}/approve`, {
          comments: dialog.comments,
          signatureImage: state.user.signatureImage,
        });
        toast(result.message || 'Imprest approved.');
        reloadPage();
      } catch (e) {
        toast(e.message, 'error');
      }
    });
  });
}
