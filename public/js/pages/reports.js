import { api } from '../api.js';
import { state, can } from '../state.js';
import { navigate, withQuery } from '../router.js';
import {
  esc, icon, money, num, fmtDate, statusBadge, emptyState, toast,
} from '../ui.js';

const GROUPS = [
  {
    label: 'Bills & Approvals',
    icon: 'file',
    keys: ['bill-register', 'pending-approvals', 'approved-bills', 'rejected-bills', 'returned-bills'],
  },
  {
    label: 'Vendors & Advances',
    icon: 'wallet',
    keys: ['vendor-master', 'vendor-ledger', 'advance-register', 'outstanding-advances', 'adjustment-report'],
  },
  {
    label: 'Accounts Handover',
    icon: 'send',
    keys: ['handover-register', 'acknowledgment-report'],
  },
];

const FILTERS = {
  'bill-register': ['from', 'to', 'vendorId', 'departmentId', 'search'],
  'pending-approvals': ['from', 'to', 'vendorId', 'departmentId', 'search'],
  'approved-bills': ['from', 'to', 'vendorId', 'departmentId', 'search'],
  'rejected-bills': ['from', 'to', 'vendorId', 'departmentId', 'search'],
  'returned-bills': ['from', 'to', 'vendorId', 'departmentId', 'search'],
  'vendor-master': ['search'],
  'vendor-ledger': ['from', 'to', 'vendorId'],
  'advance-register': ['from', 'to', 'vendorId', 'search'],
  'outstanding-advances': ['vendorId'],
  'adjustment-report': ['from', 'to', 'vendorId'],
  'handover-register': ['from', 'to', 'search'],
  'acknowledgment-report': ['from', 'to'],
};

/* ================================================================== */
/* Report picker                                                       */
/* ================================================================== */
export async function render(ctx, options = {}) {
  if (options.type) return renderReport(ctx, options.type);
  return renderIndex(ctx);
}

async function renderIndex(ctx) {
  ctx.view.innerHTML = `<div class="empty">Loading reports\u2026</div>`;
  const data = await api.get('/api/reports');
  const byKey = Object.fromEntries(data.reports.map((r) => [r.key, r]));

  const groups = GROUPS.map((g) => ({
    ...g,
    reports: g.keys.map((k) => byKey[k]).filter(Boolean),
  })).filter((g) => g.reports.length);

  // Include any report not covered by the groups above.
  const covered = new Set(GROUPS.flatMap((g) => g.keys));
  const extra = data.reports.filter((r) => !covered.has(r.key));
  if (extra.length) groups.push({ label: 'Other Reports', icon: 'chart', reports: extra });

  ctx.view.innerHTML = `
    <div class="page-head">
      <div>
        <h1>Reports</h1>
        <div class="sub">Exportable registers, approval reports and management information</div>
      </div>
      <div class="page-actions">
        <button class="btn" data-print-page>${icon('printer')} Print list</button>
      </div>
    </div>

    <div class="stack">
      ${groups
        .map(
          (g) => `
        <div class="card">
          <div class="card-head">
            <div class="chip teal" style="width:34px;height:34px;border-radius:9px">${icon(g.icon)}</div>
            <div><h3>${esc(g.label)}</h3><div class="sub">${g.reports.length} report${g.reports.length === 1 ? '' : 's'}</div></div>
          </div>
          <div class="card-body">
            <div class="grid grid-3">
              ${g.reports
                .map(
                  (r) => `<a class="card" href="#/reports/${esc(r.key)}" style="text-decoration:none;color:inherit;box-shadow:none">
                    <div class="card-body" style="display:flex;flex-direction:column;gap:6px;height:100%">
                      <div class="row" style="justify-content:space-between">
                        <b style="font-size:13.5px">${esc(r.title)}</b>
                        ${icon('arrowRight', 'icon')}
                      </div>
                      <div class="small muted" style="flex:1">${esc(r.description)}</div>
                      <div class="small" style="color:var(--accent-dark);font-weight:650">Open report</div>
                    </div>
                  </a>`
                )
                .join('')}
            </div>
          </div>
        </div>`
        )
        .join('')}
    </div>

    <div class="card mt-16">
      <div class="card-body small muted" style="display:flex;gap:12px;align-items:flex-start">
        <div class="chip gray">${icon('info')}</div>
        <div>
          <b style="color:var(--text)">Reporting notes.</b>
          Every report can be filtered by date range and exported to CSV for use in spreadsheet software,
          or printed / saved as PDF from the browser. Approval reports for individual bills are available from
          the bill detail page and include a verification QR code.
        </div>
      </div>
    </div>`;

  ctx.view.querySelector('[data-print-page]')?.addEventListener('click', () => window.print());
}

/* ================================================================== */
/* Single report                                                       */
/* ================================================================== */
async function renderReport(ctx, type) {
  ctx.view.innerHTML = `<div class="empty">Loading report\u2026</div>`;

  const [defs, vendorsRes] = await Promise.all([
    api.get('/api/reports'),
    api.get('/api/vendors').catch(() => ({ vendors: [] })),
  ]);
  const def = defs.reports.find((r) => r.key === type);
  if (!def) {
    ctx.view.innerHTML = `<div class="card">${emptyState(
      'Report not found',
      'The requested report does not exist.',
      '<a class="btn btn-sm" href="#/reports">Back to reports</a>',
      'chart'
    )}</div>`;
    return;
  }

  const q = ctx.route.query;
  const allowed = FILTERS[type] || [];
  const params = new URLSearchParams();
  allowed.forEach((k) => {
    if (q[k]) params.set(k, q[k]);
  });

  const res = await api.get(`/api/reports/${type}?${params.toString()}`);
  const report = res.report;
  const rows = res.rows || [];
  const totals = res.totals || {};
  const hasTotals = Object.keys(totals).length > 0;

  const moneyColumns = report.columns.filter((c) => c.type === 'money').map((c) => c.key);

  const filterHtml = allowed.length
    ? `<form class="toolbar no-print" id="report-filters">
        ${
          allowed.includes('search')
            ? `<div class="search">${icon('search')}<input class="input" name="search" value="${esc(q.search || '')}" placeholder="Search\u2026" /></div>`
            : ''
        }
        ${
          allowed.includes('vendorId')
            ? `<select class="select" name="vendorId">
                 <option value="">All vendors</option>
                 ${vendorsRes.vendors
                   .map((v) => `<option value="${v.id}" ${String(v.id) === String(q.vendorId || '') ? 'selected' : ''}>${esc(v.name)}</option>`)
                   .join('')}
               </select>`
            : ''
        }
        ${
          allowed.includes('departmentId')
            ? `<select class="select" name="departmentId">
                 <option value="">All departments</option>
                 ${state.departments
                   .map((d) => `<option value="${d.id}" ${String(d.id) === String(q.departmentId || '') ? 'selected' : ''}>${esc(d.name)}</option>`)
                   .join('')}
               </select>`
            : ''
        }
        ${
          allowed.includes('from')
            ? `<input class="input" type="date" name="from" value="${esc(q.from || '')}" title="From date" style="width:140px" />`
            : ''
        }
        ${
          allowed.includes('to')
            ? `<input class="input" type="date" name="to" value="${esc(q.to || '')}" title="To date" style="width:140px" />`
            : ''
        }
        <button class="btn btn-sm" type="submit">${icon('filter')} Apply</button>
        <button class="btn btn-sm btn-ghost" type="button" data-reset>Reset</button>
      </form>`
    : '';

  ctx.view.innerHTML = `
    <div class="page-head no-print">
      <div>
        <div class="small muted" style="margin-bottom:4px"><a href="#/reports">Reports</a> / ${esc(report.title)}</div>
        <h1>${esc(report.title)}</h1>
        <div class="sub">${esc(report.description)}</div>
      </div>
      <div class="page-actions">
        <a class="btn" href="#/reports">${icon('arrowLeft')} All reports</a>
        ${can('report.export')
          ? `<button class="btn" data-print>${icon('printer')} Print</button>
             <button class="btn btn-primary" data-export>${icon('download')} Export CSV</button>`
          : ''}
      </div>
    </div>

    <div class="card print-report">
      <div class="toolbar no-print" style="justify-content:space-between;background:#f8fafc">
        <div class="row" style="gap:18px">
          <span class="badge-plain">${num(res.count)} record${res.count === 1 ? '' : 's'}</span>
          <span class="small muted">Generated ${fmtDate(res.generatedAt, true)}</span>
        </div>
        <span class="small muted">${esc(state.settings.orgName)} \u00b7 ${esc(state.settings.orgDepartment)}</span>
      </div>

      ${filterHtml}

      <div class="report-print-head" style="display:none">
        <h2 style="font-size:18px;color:#123c69">${esc(state.settings.orgName)}</h2>
        <div class="small">${esc(state.settings.orgDepartment)}</div>
        <h3 style="margin-top:8px">${esc(report.title)}</h3>
      </div>

      <div class="table-wrap">
        ${rows.length
          ? `<table class="tbl">
              <thead><tr>
                ${report.columns.map((c) => `<th class="${c.type === 'money' ? 'num' : ''}">${esc(c.label)}</th>`).join('')}
                <th class="no-print"></th>
              </tr></thead>
              <tbody>
                ${rows
                  .map(
                    (row) => `<tr>
                      ${report.columns
                        .map((c) => `<td class="${c.type === 'money' ? 'num' : ''}">${renderCell(row[c.key], c, row)}</td>`)
                        .join('')}
                      <td class="actions no-print">${rowLink(row, type)}</td>
                    </tr>`
                  )
                  .join('')}
              </tbody>
              ${hasTotals
                ? `<tfoot><tr>
                    ${report.columns
                      .map((c, i) => {
                        if (i === 0) return '<td>Total</td>';
                        return `<td class="${c.type === 'money' ? 'num' : ''}">${totals[c.key] !== undefined ? money(totals[c.key]) : ''}</td>`;
                      })
                      .join('')}
                    <td class="no-print"></td>
                  </tr></tfoot>`
                : ''}
            </table>`
          : `<div class="empty">${icon('chart')}<h4>No records found</h4>
              <div class="small">Try widening the date range or clearing the filters.</div></div>`}
      </div>

      <div class="pager" style="justify-content:space-between">
        <span>${num(res.count)} row${res.count === 1 ? '' : 's'}</span>
        <span>${esc(state.settings.reportFooter || '')}</span>
      </div>
    </div>`;

  const filterForm = document.getElementById('report-filters');
  if (filterForm) {
    filterForm.addEventListener('submit', (e) => {
      e.preventDefault();
      navigate(withQuery(`/reports/${type}`, Object.fromEntries(new FormData(filterForm).entries())));
    });
    filterForm.querySelector('[data-reset]')?.addEventListener('click', () => navigate(`/reports/${type}`));
  }

  const exportBtn = ctx.view.querySelector('[data-export]');
  if (exportBtn) {
    exportBtn.addEventListener('click', () => {
      const exportParams = new URLSearchParams(params.toString());
      exportParams.set('format', 'csv');
      window.location.href = `/api/reports/${type}?${exportParams.toString()}`;
    });
  }

  ctx.view.querySelector('[data-print]')?.addEventListener('click', () => {
    const head = ctx.view.querySelector('.report-print-head');
    if (head) head.style.display = 'block';
    window.print();
    setTimeout(() => {
      if (head) head.style.display = 'none';
    }, 500);
  });

  if (!rows.length) toast('No rows matched the selected filters.', 'info', 2600);

  void moneyColumns;
}

function renderCell(value, column, row) {
  if (value === null || value === undefined || value === '') {
    return `<span class="muted">\u2014</span>`;
  }
  if (column.type === 'money') return money(value);
  if (column.type === 'status') return statusBadge(value);
  if (column.type === 'date') {
    const withTime = String(value).includes('T');
    return fmtDate(value, withTime);
  }
  if (column.key === 'bill_no' && row.id) {
    return `<a class="strong" href="#/bills/${row.id}">${esc(value)}</a>`;
  }
  return esc(value);
}

function rowLink(row, type) {
  if (row.bill_id) return `<a class="btn btn-sm btn-ghost" href="#/bills/${row.bill_id}" title="View bill">${icon('eye')}</a>`;
  if (row.id && ['bill-register', 'pending-approvals', 'approved-bills', 'rejected-bills', 'returned-bills'].includes(type)) {
    return `<a class="btn btn-sm btn-ghost" href="#/bills/${row.id}" title="View bill">${icon('eye')}</a>`;
  }
  if (row.id && ['advance-register', 'outstanding-advances'].includes(type)) {
    return `<a class="btn btn-sm btn-ghost" href="#/advances/${row.id}" title="View advance">${icon('eye')}</a>`;
  }
  if (row.vendor_id) {
    return `<a class="btn btn-sm btn-ghost" href="#/vendors/${row.vendor_id}" title="View vendor">${icon('eye')}</a>`;
  }
  return '';
}
