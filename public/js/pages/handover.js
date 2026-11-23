import { api } from '../api.js';
import { can, state } from '../state.js';
import { navigate, reloadPage, withQuery } from '../router.js';
import {
  esc, icon, money, num, fmtDate, statusBadge, emptyState, toast, modal,
} from '../ui.js';

/* Handover tables are wide, so their printable documents use landscape pages. */
function printInLandscape() {
  const style = document.createElement('style');
  style.textContent = '@page { size: A4 landscape; margin: 10mm; }';
  document.head.appendChild(style);
  const cleanup = () => {
    style.remove();
    window.removeEventListener('afterprint', cleanup);
  };
  window.addEventListener('afterprint', cleanup);
  window.print();
  setTimeout(cleanup, 2000);
}

export async function render(ctx) {
  const q = ctx.route.query;
  const params = new URLSearchParams();
  ['search', 'status', 'from', 'to'].forEach((k) => {
    if (q[k]) params.set(k, q[k]);
  });

  ctx.view.innerHTML = `<div class="empty">Loading handover register\u2026</div>`;
  const res = await api.get(`/api/handover?${params.toString()}`);
  const s = res.summary || {};
  const rows = res.handovers || [];

  ctx.view.innerHTML = `
    <div class="page-head">
      <div>
        <h1>Accounts Handover Register</h1>
        <div class="sub">Approved bills forwarded to the Accounts Department for processing</div>
      </div>
      <div class="page-actions">
        ${can('report.export') ? `<button class="btn" data-print>${icon('printer')} Print</button>
        <a class="btn" href="/api/reports/handover-register?format=csv" data-export>${icon('download')} Export</a>` : ''}
        ${can('handover.view') ? `<a class="btn btn-primary" href="#/handover/statement">${icon('file')} Consolidated Statement</a>` : ''}
        ${can('report.view') ? `<a class="btn" href="#/reports/handover-register">${icon('chart')} Handover report</a>` : ''}
      </div>
    </div>

    <div class="grid grid-3 mb-16 no-print">
      <div class="card"><div class="kpi"><div class="chip blue">${icon('send')}</div>
        <div><div class="label">Total handovers</div><div class="value">${num(s.total || 0)}</div>
        <div class="meta">Bills forwarded to Accounts</div></div></div></div>
      <div class="card"><div class="kpi"><div class="chip amber">${icon('clock')}</div>
        <div><div class="label">Awaiting acknowledgement</div><div class="value">${num(s.pending || 0)}</div>
        <div class="meta">Pending with Accounts</div></div></div></div>
      <div class="card"><div class="kpi"><div class="chip green">${icon('checkCircle')}</div>
        <div><div class="label">Acknowledged</div><div class="value">${num(s.acknowledged || 0)}</div>
        <div class="meta">Confirmed received by Accounts</div></div></div></div>
    </div>

    <div class="card print-register">
      <form class="toolbar no-print" id="handover-filters">
        <div class="search">${icon('search')}
          <input class="input" name="search" value="${esc(q.search || '')}" placeholder="Handover no, bill no, invoice or vendor\u2026" />
        </div>
        <select class="select" name="status">
          <option value="">All statuses</option>
          ${[['forwarded', 'Pending Handover'], ['acknowledged', 'Acknowledged']]
            .map(([value, label]) => `<option value="${value}" ${q.status === value ? 'selected' : ''}>${label}</option>`)
            .join('')}
        </select>
        <select class="select" name="unitId">
          <option value="">All units</option>
          ${(state.units || []).map((u) => `<option value="${u.id}" ${String(q.unitId || '') === String(u.id) ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}
        </select>
        <input class="input" type="date" name="from" value="${esc(q.from || '')}" title="Forwarded from" style="width:140px" />
        <input class="input" type="date" name="to" value="${esc(q.to || '')}" title="Forwarded to" style="width:140px" />
        <button class="btn btn-sm" type="submit">${icon('filter')} Apply</button>
        <button class="btn btn-sm btn-ghost" type="button" data-reset>Reset</button>
      </form>

      <div class="table-wrap">
        ${rows.length
          ? `<table class="tbl">
              <thead><tr>
                <th style="width:32px"><input type="checkbox" id="handover-select-all" title="Select all" /></th>
                <th>Handover No</th><th>Bill</th><th>Vendor</th><th>Invoice</th>
                <th class="num">Basic</th><th class="num">Tax</th><th class="num">Transport</th><th class="num">Net Amount</th>
                <th class="num">Retention</th>
                <th class="num">Snag Hold</th><th class="num">Credit Note</th><th class="num">Payable</th>
                <th>Forwarded</th><th>Received</th><th>Status</th><th></th>
              </tr></thead>
              <tbody>
                ${rows
                  .map(
                    (h) => `<tr>
                      <td><input type="checkbox" class="handover-cb" value="${h.id}" ${h.status === 'forwarded' ? '' : 'disabled'} /></td>
                      <td><span class="mono strong">${esc(h.handoverNo)}</span>
                        <div class="small muted">${h.approvalDate ? `Approved ${fmtDate(h.approvalDate)}` : ''}</div></td>
                      <td><a class="strong" href="#/bills/${h.billId}">${esc(h.billNo)}</a></td>
                      <td>${esc(h.vendorName)}<div class="small muted mono">${esc(h.vendorCode || '')}</div></td>
                      <td><span class="mono small">${esc(h.invoiceNumber)}</span>
                        <div class="small muted">${fmtDate(h.invoiceDate)}</div></td>
                      <td class="num">${money(h.invoiceAmount)}</td>
                      <td class="num">${money(h.taxAmount)}</td>
                      <td class="num">${money(h.transportAmount)}</td>
                      <td class="num strong">${money(h.netAmount)}
                        ${h.advanceAdjusted ? `<div class="small muted">Adv ${money(h.advanceAdjusted)}</div>` : ''}</td>
                      <td class="num">${money(h.retentionWithheld)}
                        ${h.retentionReleasedAmount ? `<div class="small muted">Rel ${money(h.retentionReleasedAmount)}</div>` : ''}</td>
                      <td class="num">${money(h.holdWithheld)}
                        ${h.holdReleasedAmount ? `<div class="small muted">Rel ${money(h.holdReleasedAmount)}</div>` : ''}</td>
                      <td class="num">${money(h.creditNoteAmount)}
                        ${h.creditNoteNumber ? `<div class="small muted mono">${esc(h.creditNoteNumber)}</div>` : ''}</td>
                      <td class="num strong">${money(h.payableAmount)}</td>
                      <td class="small">${fmtDate(h.forwardedAt, true)}
                        <div class="muted">${esc(h.forwardedBy || '\u2014')}</div></td>
                      <td class="small">${h.receivedAt ? fmtDate(h.receivedAt, true) : '\u2014'}
                        <div class="muted">${esc(h.receivedBy || '')}</div></td>
                      <td>${statusBadge(h.status)}</td>
                      <td class="actions">
                        <a class="btn btn-sm btn-ghost" href="#/bills/${h.billId}" title="View bill">${icon('eye')}</a>
                        ${h.status === 'forwarded' && can('handover.acknowledge')
                          ? `<button class="btn btn-sm btn-accent" data-ack="${h.id}" data-no="${esc(h.handoverNo)}" data-bill="${esc(h.billNo)}">${icon('check')} Acknowledge</button>`
                          : ''}
                      </td>
                    </tr>`
                  )
                  .join('')}
              </tbody>
            </table>
             <div class="row mt-8" id="bulk-ack-bar" style="display:none;gap:8px;align-items:center">
               <span class="small muted" id="bulk-ack-count">0 selected</span>
               <button class="btn btn-sm btn-accent" id="bulk-ack-btn">Acknowledge selected</button>
             </div>`
          : emptyState(
              'No handovers found',
              'Approved bills are forwarded to Accounts automatically once final approval is granted.',
              can('bill.view') ? '<a class="btn btn-sm" href="#/bills?status=approved">View approved bills</a>' : '',
              'send'
            )}
      </div>
    </div>

    <div class="card mt-16">
      <div class="card-body" style="display:flex;gap:14px;align-items:flex-start">
        <div class="chip teal">${icon('info')}</div>
        <div class="small muted">
          <b style="color:var(--text)">About the handover register.</b>
          When a bill receives final approval, Administration forwards it to Accounts automatically with a unique handover number.
          Accounts then acknowledges receipt here. Each handover links to the bill's digitally signed approval report and verification QR code.
        </div>
      </div>
    </div>`;

  // Bulk acknowledge
  const selectAll = document.getElementById('handover-select-all');
  const bulkBar = document.getElementById('bulk-ack-bar');
  const bulkBtn = document.getElementById('bulk-ack-btn');
  const bulkCount = document.getElementById('bulk-ack-count');
  function updateBulkBar() {
    const checked = [...document.querySelectorAll('.handover-cb:checked')];
    if (bulkBar) bulkBar.style.display = checked.length ? 'flex' : 'none';
    if (bulkCount) bulkCount.textContent = checked.length + ' selected';
  }
  if (selectAll) {
    selectAll.addEventListener('change', () => {
      document.querySelectorAll('.handover-cb:not(:disabled)').forEach((cb) => { cb.checked = selectAll.checked; });
      updateBulkBar();
    });
  }
  document.querySelectorAll('.handover-cb').forEach((cb) => cb.addEventListener('change', updateBulkBar));
  if (bulkBtn) {
    bulkBtn.addEventListener('click', async () => {
      const ids = [...document.querySelectorAll('.handover-cb:checked')].map((cb) => Number(cb.value));
      if (!ids.length) return;
      try {
        const res = await api.post('/api/handover/bulk-acknowledge', { ids });
        toast(res.acknowledged + ' handover(s) acknowledged.', 'success');
        reloadPage();
      } catch (e) {
        toast(e.message || 'Bulk acknowledge failed.', 'error');
      }
    });
  }

  const filterForm = document.getElementById('handover-filters');
  filterForm.addEventListener('submit', (e) => {
    e.preventDefault();
    navigate(withQuery('/handover', Object.fromEntries(new FormData(filterForm).entries())));
  });
  filterForm.querySelector('[data-reset]').addEventListener('click', () => navigate('/handover'));

  const exportLink = ctx.view.querySelector('[data-export]');
  if (exportLink) {
    const exportParams = new URLSearchParams();
    ['search', 'from', 'to'].forEach((k) => {
      if (q[k]) exportParams.set(k, q[k]);
    });
    exportParams.set('format', 'csv');
    exportLink.href = `/api/reports/handover-register?${exportParams.toString()}`;
  }
  ctx.view.querySelector('[data-print]')?.addEventListener('click', printInLandscape);

  ctx.view.querySelectorAll('[data-ack]').forEach((btn) => {
    btn.addEventListener('click', () => acknowledge(btn.dataset.ack, btn.dataset.no, btn.dataset.bill));
  });

  void reloadPage;
}

function acknowledge(id, handoverNo, billNo) {
  modal({
    title: 'Acknowledge handover',
    subtitle: `${handoverNo} \u00b7 ${billNo}`,
    body: `<p class="small muted">Confirm that the Accounts Department has received this bill, its invoice copy and supporting documents.</p>
      <div class="field">
        <label>Remarks (optional)</label>
        <textarea class="textarea" data-remarks rows="3" placeholder="e.g. Received in order"></textarea>
      </div>`,
    footer: `<button class="btn" data-modal-close>Cancel</button>
             <button class="btn btn-accent" data-ok>${icon('check')} Acknowledge receipt</button>`,
    onMount(el, close) {
      const ok = el.querySelector('[data-ok]');
      ok.addEventListener('click', async () => {
        ok.disabled = true;
        try {
          await api.post(`/api/handover/${id}/acknowledge`, {
            remarks: el.querySelector('[data-remarks]').value.trim(),
          });
          close();
          toast('Handover acknowledged.');
          reloadPage();
        } catch (e) {
          ok.disabled = false;
          toast(e.message, 'error');
        }
      });
    },
  });
}

/* ------------------------------------------------------------------ */
/* Consolidated handover statement                                     */
/* ------------------------------------------------------------------ */
export async function renderStatement(ctx) {
  const q = ctx.route.query;
  const params = new URLSearchParams();
  ['search', 'status', 'from', 'to'].forEach((k) => {
    if (q[k]) params.set(k, q[k]);
  });

  ctx.view.innerHTML = `<div class="empty">Preparing consolidated statement\u2026</div>`;
  const data = await api.get(`/api/handover/statement?${params.toString()}`);
  const rows = data.rows || [];
  const summary = data.summary || {};
  const org = data.org || {};

  const statusLabel = q.status === 'forwarded'
    ? 'Pending handover'
    : q.status === 'acknowledged'
      ? 'Acknowledged'
      : 'All statuses';
  const rangeLabel = q.from || q.to
    ? `${q.from ? fmtDate(q.from) : 'Beginning'} \u2013 ${q.to ? fmtDate(q.to) : 'Today'}`
    : 'All dates';

  const printMoney = (value) => (Number(value) ? money(value) : '');
  const numCell = (value) => `<td class="num nowrap">${printMoney(value)}</td>`;
  const deductionParts = (r) => {
    const parts = [];
    if (Number(r.advanceAdjusted)) parts.push(`Adv ${money(r.advanceAdjusted)}`);
    if (Number(r.retentionWithheld)) parts.push(`Ret ${money(r.retentionWithheld)}`);
    if (Number(r.holdWithheld)) parts.push(`Hold ${money(r.holdWithheld)}`);
    if (Number(r.creditNoteAmount)) parts.push(`CN ${money(r.creditNoteAmount)}`);
    return parts.join(' \u00b7 ');
  };
  const unitNames = [...new Set(rows.map((r) => r.unitName).filter(Boolean))];
  const selectedUnitName = q.unitId
    ? (state.units || []).find((u) => String(u.id) === String(q.unitId))?.name || ''
    : '';
  const unitHeading = q.unitId ? selectedUnitName : (unitNames.length === 1 ? unitNames[0] : '');

  ctx.view.innerHTML = `
    <div class="page-head no-print">
      <div>
        <h1>Consolidated Handover Statement</h1>
        <div class="sub">A single printable statement of approved bills forwarded to Accounts</div>
      </div>
      <div class="page-actions">
        <a class="btn" href="#/handover">${icon('arrowLeft')} Back to register</a>
        <button class="btn btn-primary" data-print-statement>${icon('printer')} Print / Save PDF</button>
      </div>
    </div>

    <div class="card no-print">
      <form class="toolbar" id="statement-filters">
        <div class="search">${icon('search')}
          <input class="input" name="search" value="${esc(q.search || '')}" placeholder="Handover no, bill no, invoice or vendor\u2026" />
        </div>
        <select class="select" name="status">
          <option value="">All statuses</option>
          ${[['forwarded', 'Pending Handover'], ['acknowledged', 'Acknowledged']]
            .map(([value, label]) => `<option value="${value}" ${q.status === value ? 'selected' : ''}>${label}</option>`)
            .join('')}
        </select>
        <input class="input" type="date" name="from" value="${esc(q.from || '')}" title="Forwarded from" style="width:140px" />
        <input class="input" type="date" name="to" value="${esc(q.to || '')}" title="Forwarded to" style="width:140px" />
        <button class="btn btn-sm" type="submit">${icon('filter')} Apply</button>
        <button class="btn btn-sm btn-ghost" type="button" data-reset>Reset</button>
      </form>
    </div>

    <div class="print-report print-landscape mt-16">
      <div class="report-sheet">
        <div class="report-header">
          <div class="org">
            <h2>${esc(org.name || 'New Life AG Church')}</h2>
            <p>${esc(org.department || 'Administration Department')}</p>
            <p>Consolidated Accounts Handover Statement</p>
          </div>
          <div class="report-meta">
            <div><b>Generated</b><span>${fmtDate(data.generatedAt, true)}</span></div>
            <div><b>Status</b><span>${esc(statusLabel)}</span></div>
            <div><b>Period</b><span>${esc(rangeLabel)}</span></div>
            <div><b>Handovers</b><span>${num(summary.count || rows.length)}</span></div>
          </div>
        </div>

        <div class="report-title">Consolidated Handover Statement</div>
        ${unitHeading ? `<div class="report-unit">Unit: ${esc(unitHeading)}</div>` : ''}

        ${q.search ? `<div class="rp-note"><b>Search:</b> ${esc(q.search)}</div>` : ''}

        <div class="rp-section">
          <h3>Summary</h3>
          <table class="rp-table rp-summary">
            <colgroup>
              <col style="width:16%" /><col style="width:18%" />
              <col style="width:16%" /><col style="width:18%" />
              <col style="width:16%" /><col style="width:16%" />
            </colgroup>
            <tbody>
              <tr>
                <th>Handovers</th><td class="num">${num(summary.count || 0)}</td>
                <th>Pending</th><td class="num">${num(summary.pending || 0)}</td>
                <th>Acknowledged</th><td class="num">${num(summary.acknowledged || 0)}</td>
              </tr>
              <tr>
                <th>Basic amount</th><td class="num">${printMoney(summary.basicTotal)}</td>
                <th>CGST</th><td class="num">${printMoney(summary.cgstTotal)}</td>
                <th>SGST</th><td class="num">${printMoney(summary.sgstTotal)}</td>
              </tr>
              <tr>
                <th>IGST</th><td class="num">${printMoney(summary.igstTotal)}</td>
                <th>Total tax</th><td class="num">${printMoney(summary.taxTotal)}</td>
                <th>Transport charges</th><td class="num">${printMoney(summary.transportTotal)}</td>
              </tr>
              <tr>
                <th>GST on transport</th><td class="num">${printMoney(summary.transportTaxTotal)}</td>
                <th>Net amount</th><td class="num">${printMoney(summary.netTotal)}</td>
                <th>Advances adjusted</th><td class="num">${printMoney(summary.advanceTotal)}</td>
              </tr>
              <tr>
                <th>Retention withheld</th><td class="num">${printMoney(summary.retentionTotal)}</td>
                <th>Snag-work hold</th><td class="num">${printMoney(summary.holdTotal)}</td>
                <th>Credit notes</th><td class="num">${printMoney(summary.creditTotal)}</td>
              </tr>
              <tr class="rp-grand">
                <th colspan="5">Total payable to vendors</th>
                <td class="num">${printMoney(summary.payableTotal)}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div class="rp-section">
          <h3>Handover details</h3>
          ${rows.length
            ? `<table class="rp-table rp-statement">
                <colgroup>
                  <col style="width:2%" />
                  <col style="width:9%" />
                  <col style="width:12%" />
                  <col style="width:9%" />
                  <col style="width:4%" />
                  <col style="width:10%" />
                  <col style="width:10%" />
                  <col style="width:9%" />
                  <col style="width:10%" />
                  <col style="width:10%" />
                  <col style="width:10%" />
                  <col style="width:5%" />
                </colgroup>
                <thead>
                  <tr>
                    <th style="width:28px">#</th>
                    <th>Handover / Bill</th>
                    <th>Vendor</th>
                    <th>Invoice</th>
                <th>Unit</th>
                    <th class="num">Basic</th>
                    <th class="num">Tax</th>
                    <th class="num">Transport</th>
                    <th class="num">Net</th>
                    <th class="num">Deductions</th>
                    <th class="num">Payable</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  ${rows
                    .map(
                      (r) => `<tr>
                        <td class="num">${r.slNo}</td>
                        <td><b>${esc(r.handoverNo)}</b><div class="small muted">${esc(r.billNo)}</div></td>
                        <td>${esc(r.vendorName)}<div class="small muted mono">${esc(r.vendorCode || '')}</div></td>
                        <td><span class="mono">${esc(r.invoiceNumber)}</span><div class="small muted">${fmtDate(r.invoiceDate)}</div></td>
                         <td class="small">${esc(r.unitName || '')}</td>
                        ${numCell(r.invoiceAmount)}
                        ${numCell(r.taxAmount)}
                        ${numCell(r.transportAmount)}
                        ${numCell(r.netAmount)}
                        <td class="num deductions">
                          ${printMoney(r.deductions)}
                          ${deductionParts(r) ? `<div class="small muted">${deductionParts(r)}</div>` : ''}
                        </td>
                        <td class="num nowrap"><b>${printMoney(r.payableAmount)}</b></td>
                        <td class="small">${esc(r.status === 'acknowledged' ? 'Acknowledged' : 'Pending')}</td>
                      </tr>`
                    )
                    .join('')}
                </tbody>
                <tfoot>
                  <tr>
                    <th colspan="5">Totals (${num(summary.count || rows.length)} handovers)</th>
                    <th class="num nowrap">${money(summary.basicTotal || 0)}</th>
                    <th class="num nowrap">${money(summary.taxTotal || 0)}</th>
                    <th class="num nowrap">${money(summary.transportTotal || 0)}</th>
                    <th class="num nowrap">${money(summary.netTotal || 0)}</th>
                    <th class="num nowrap">${money((summary.advanceTotal || 0) + (summary.retentionTotal || 0) + (summary.holdTotal || 0) + (summary.creditTotal || 0))}</th>
                    <th class="num nowrap">${money(summary.payableTotal || 0)}</th>
                    <th></th>
                  </tr>
                </tfoot>
              </table>`
            : '<div class="empty small">No handovers match the selected filters.</div>'}
        </div>

        <div class="rp-section">
          <h3>Certification</h3>
          <p class="rp-note">
            This consolidated statement lists approved bills forwarded by the Administration Department to the Accounts Department.
            Amounts are stated in ${esc(org.currency || 'INR')} and reflect the records held in ABMDAS at the time of generation.
            Tax amounts include GST on the basic invoice value and, where applicable, GST on transport charges.
          </p>
        </div>

        <div class="rp-signs">
          <div class="line">Prepared by \u2014 Administration</div>
          <div class="line">Received by \u2014 Accounts</div>
          <div class="line">Authorised Signatory</div>
        </div>

        <div class="rp-foot">
          <span>${esc(org.footer || `${org.name || 'New Life AG Church'} \u00b7 ${org.department || 'Administration Department'}`)}</span>
          <span>Generated ${fmtDate(data.generatedAt, true)} \u00b7 ABMDAS</span>
        </div>
      </div>
    </div>`;

  const filterForm = document.getElementById('statement-filters');
  filterForm.addEventListener('submit', (e) => {
    e.preventDefault();
    navigate(withQuery('/handover/statement', Object.fromEntries(new FormData(filterForm).entries())));
  });
  filterForm.querySelector('[data-reset]').addEventListener('click', () => navigate('/handover/statement'));
  ctx.view.querySelector('[data-print-statement]')?.addEventListener('click', printInLandscape);
}
