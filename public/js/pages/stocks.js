import { api } from '../api.js';
import { can } from '../state.js';
import { navigate, withQuery } from '../router.js';
import {
  esc, icon, money, num, statusBadge, emptyState, toast, modal, fmtDate,
} from '../ui.js';

const TABS = [
  { key: 'balances', label: 'Balances', icon: 'layers' },
  { key: 'ledger', label: 'Stock Ledger', icon: 'book' },
  { key: 'issues', label: 'Issues', icon: 'send' },
  { key: 'adjustments', label: 'Adjustments', icon: 'sliders' },
];

function tabLink(tab, current) {
  return `<a class="btn btn-sm ${tab.key === current ? 'btn-primary' : ''}" href="#/stocks?tab=${tab.key}">${icon(tab.icon)} ${esc(tab.label)}</a>`;
}

function openAdjustment(meta, onDone) {
  modal({
    title: 'Stock adjustment',
    subtitle: 'Increase opening stock or write off a decrease. Every movement is audited.',
    body: `
      <div class="form-grid">
        <div class="field"><label>Store<span class="req">*</span></label><select class="select" data-store>
          ${meta.stores.map((s) => `<option value="${s.id}">${esc(s.name)} (${esc(s.code)})</option>`).join('')}
        </select></div>
        <div class="field"><label>Bin</label><select class="select" data-bin><option value="">\u2014 Unassigned \u2014</option></select></div>
        <div class="field"><label>Item<span class="req">*</span></label><select class="select" data-item>
          ${meta.items.map((i) => `<option value="${i.id}">${esc(i.name)} (${esc(i.itemCode)})</option>`).join('')}
        </select></div>
        <div class="field"><label>Adjustment<span class="req">*</span></label><select class="select" data-type>
          <option value="increase">Increase stock</option>
          <option value="decrease">Decrease stock</option>
        </select></div>
        <div class="field"><label>Quantity<span class="req">*</span></label><input class="input" type="number" min="0.01" step="0.01" value="1" data-qty /></div>
        <div class="field span-2"><label>Reason<span class="req">*</span></label><textarea class="textarea" data-reason rows="3" placeholder="Opening balance, physical count correction, damage, expiry..."></textarea></div>
      </div>
      <div class="alert alert-danger hidden" data-err></div>`,
    footer: `<button class="btn" data-modal-close>Cancel</button><button class="btn btn-primary" data-confirm>${icon('check')} Record adjustment</button>`,
    onMount(el, close) {
      const storeSelect = el.querySelector('[data-store]');
      const binSelect = el.querySelector('[data-bin]');
      const errBox = el.querySelector('[data-err]');

      function refreshBins() {
        const store = meta.stores.find((s) => String(s.id) === String(storeSelect.value));
        binSelect.innerHTML = `<option value="">\u2014 Unassigned \u2014</option>${(store?.bins || [])
          .map((b) => `<option value="${b.id}">${esc(b.name)} (${esc(b.code)})</option>`).join('')}`;
      }
      storeSelect.addEventListener('change', refreshBins);
      refreshBins();

      el.querySelector('[data-confirm]').addEventListener('click', async () => {
        errBox.classList.add('hidden');
        const reason = el.querySelector('[data-reason]').value.trim();
        if (!reason) {
          errBox.textContent = 'A reason is required.';
          errBox.classList.remove('hidden');
          return;
        }
        try {
          const res = await api.post('/api/procurement/stock/adjustments', {
            storeId: storeSelect.value,
            binId: binSelect.value || null,
            itemId: el.querySelector('[data-item]').value,
            adjustmentType: el.querySelector('[data-type]').value,
            quantity: el.querySelector('[data-qty]').value,
            reason,
          });
          close();
          toast(`Adjustment ${res.adjustmentNo} recorded. Balance now ${num(res.balanceAfter)}.`);
          onDone();
        } catch (e) {
          errBox.textContent = e.message;
          errBox.classList.remove('hidden');
        }
      });
    },
  });
}

function openIssue(id) {
  modal({
    title: 'Stock issue',
    size: 'lg',
    body: '<div class="empty small">Loading issue\u2026</div>',
    footer: '<button class="btn" data-modal-close>Close</button>',
    async onMount(el) {
      try {
        const { issue, items } = await api.get(`/api/procurement/stock/issues/${id}`);
        el.querySelector('.modal-body').innerHTML = `
          <div class="grid grid-2 mb-16">
            <div><div class="small muted">Issue number</div><div class="strong mono">${esc(issue.issueNo)}</div></div>
            <div><div class="small muted">Status</div><div>${statusBadge(issue.status)}</div></div>
            <div><div class="small muted">Store</div><div>${esc(issue.storeName)}</div></div>
            <div><div class="small muted">Issued</div><div>${fmtDate(issue.issuedAt, true)}</div></div>
            <div><div class="small muted">Issued to</div><div>${esc(issue.issuedToName)}</div></div>
            <div><div class="small muted">Issued by</div><div>${esc(issue.issuedByName)}</div></div>
          </div>
          <div class="table-wrap"><table class="tbl">
            <thead><tr><th>Item</th><th>Bin</th><th class="num">Qty</th><th class="num">Unit Cost</th></tr></thead>
            <tbody>${items.map((line) => `<tr>
              <td>${esc(line.itemName)}<div class="small muted mono">${esc(line.itemCode)}</div></td>
              <td>${esc(line.binName || '\u2014')}</td>
              <td class="num">${num(line.quantity)}</td>
              <td class="num">${money(line.unitCost)}</td>
            </tr>`).join('')}</tbody>
          </table></div>
          ${issue.remarks ? `<div class="hint mt-12">${esc(issue.remarks)}</div>` : ''}`;
      } catch (e) {
        el.querySelector('.modal-body').innerHTML = `<div class="alert alert-danger">${esc(e.message)}</div>`;
      }
    },
  });
}

export async function render(ctx) {
  const q = ctx.route.query || {};
  const tab = TABS.some((t) => t.key === q.tab) ? q.tab : 'balances';

  ctx.view.innerHTML = `<div class="empty">Loading stock register\u2026</div>`;
  const meta = await api.get('/api/procurement/stock/meta');
  const stores = meta.stores || [];
  const items = meta.items || [];
  const storeOptions = stores.map((s) => ({ value: s.id, label: s.name }));
  const itemOptions = items.map((i) => ({ value: i.id, label: `${i.name} (${i.itemCode})` }));

  let bodyHtml = '';
  let summaryHtml = '';

  if (tab === 'balances') {
    const params = new URLSearchParams();
    for (const key of ['storeId', 'itemId', 'search', 'belowReorder']) if (q[key]) params.set(key, q[key]);
    const res = await api.get(`/api/procurement/stock/balances?${params.toString()}`);
    const rows = res.balances || [];
    summaryHtml = `
      <div class="grid grid-4 mb-16">
        <div class="card"><div class="kpi"><div class="chip gray">${icon('database')}</div><div><div class="label">Total quantity</div><div class="value">${num(res.summary.quantity)}</div><div class="meta">Across matching balances</div></div></div></div>
        <div class="card"><div class="kpi"><div class="chip teal">${icon('wallet')}</div><div><div class="label">Stock value</div><div class="value small-value">${money(res.summary.value)}</div><div class="meta">At standard cost</div></div></div></div>
        <div class="card"><div class="kpi"><div class="chip amber">${icon('alert')}</div><div><div class="label">At or below reorder</div><div class="value">${num(res.summary.belowReorder)}</div><div class="meta">Need replenishment</div></div></div></div>
        <div class="card"><div class="kpi"><div class="chip blue">${icon('layers')}</div><div><div class="label">Balance lines</div><div class="value">${num(rows.length)}</div><div class="meta">By store and bin</div></div></div></div>
      </div>`;
    bodyHtml = `
      <div class="card">
        <form class="toolbar" id="stock-filters">
          <div class="search">${icon('search')}<input class="input" name="search" value="${esc(q.search || '')}" placeholder="Item, code or store..." /></div>
          <select class="select" name="storeId"><option value="">All stores</option>${storeOptions.map((o) => `<option value="${o.value}" ${String(q.storeId) === String(o.value) ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select>
          <select class="select" name="itemId"><option value="">All items</option>${itemOptions.map((o) => `<option value="${o.value}" ${String(q.itemId) === String(o.value) ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select>
          <label style="display:flex;gap:6px;align-items:center;font-size:13px;white-space:nowrap"><input type="checkbox" name="belowReorder" value="1" ${q.belowReorder === '1' ? 'checked' : ''} /> Below reorder</label>
          <button class="btn btn-sm" type="submit">${icon('filter')} Apply</button>
          <button class="btn btn-sm btn-ghost" type="button" data-reset>Reset</button>
        </form>
        <div class="table-wrap">${rows.length
          ? `<table class="tbl"><thead><tr><th>Item</th><th>Store / Bin</th><th class="num">Quantity</th><th class="num">Reorder</th><th class="num">Value</th><th>Updated</th></tr></thead><tbody>${rows.map((r) => `<tr>
              <td><span class="strong">${esc(r.itemName)}</span><div class="small muted mono">${esc(r.itemCode)}</div></td>
              <td>${esc(r.storeName)}<div class="small muted">${esc(r.binName || 'Unassigned')}</div></td>
              <td class="num">${num(r.quantity)} <span class="small muted">${esc(r.uomCode)}</span>${r.quantity <= r.reorderLevel ? ' <span class="chip amber">Low</span>' : ''}</td>
              <td class="num">${num(r.reorderLevel)}</td>
              <td class="num">${money(r.value)}</td>
              <td class="small">${fmtDate(r.updatedAt, true)}</td>
            </tr>`).join('')}</tbody></table>`
          : emptyState('No stock balances', 'Record an opening adjustment or receive goods into a store.', '', 'database')}</div>
        <div class="small muted" style="padding:10px 14px">Showing ${num(rows.length)} of ${num(res.total)} balance line${res.total === 1 ? '' : 's'}.</div>
      </div>`;
  }

  if (tab === 'ledger') {
    const params = new URLSearchParams();
    for (const key of ['storeId', 'itemId', 'type', 'from', 'to']) if (q[key]) params.set(key, q[key]);
    const res = await api.get(`/api/procurement/stock/ledger?${params.toString()}`);
    const rows = res.entries || [];
    bodyHtml = `
      <div class="card">
        <form class="toolbar" id="stock-filters">
          <select class="select" name="storeId"><option value="">All stores</option>${storeOptions.map((o) => `<option value="${o.value}" ${String(q.storeId) === String(o.value) ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select>
          <select class="select" name="itemId"><option value="">All items</option>${itemOptions.map((o) => `<option value="${o.value}" ${String(q.itemId) === String(o.value) ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select>
          <select class="select" name="type">
            <option value="">All movements</option>
            <option value="adjustment" ${q.type === 'adjustment' ? 'selected' : ''}>Adjustment</option>
            <option value="issue" ${q.type === 'issue' ? 'selected' : ''}>Issue</option>
          </select>
          <input class="input" type="date" name="from" value="${esc(q.from || '')}" />
          <input class="input" type="date" name="to" value="${esc(q.to || '')}" />
          <button class="btn btn-sm" type="submit">${icon('filter')} Apply</button>
          <button class="btn btn-sm btn-ghost" type="button" data-reset>Reset</button>
        </form>
        <div class="table-wrap">${rows.length
          ? `<table class="tbl"><thead><tr><th>Date</th><th>Item</th><th>Store / Bin</th><th>Movement</th><th class="num">In</th><th class="num">Out</th><th class="num">Balance</th><th>By</th></tr></thead><tbody>${rows.map((r) => `<tr>
              <td class="small">${fmtDate(r.transactionDate)}</td>
              <td><span class="strong">${esc(r.itemName)}</span><div class="small muted mono">${esc(r.itemCode)}</div></td>
              <td>${esc(r.storeName)}<div class="small muted">${esc(r.binName || 'Unassigned')}</div></td>
              <td>${statusBadge(r.transactionType)}<div class="small muted">${esc(r.referenceType)} #${esc(r.referenceId || '')}</div></td>
              <td class="num">${r.quantityIn ? num(r.quantityIn) : '\u2014'}</td>
              <td class="num">${r.quantityOut ? num(r.quantityOut) : '\u2014'}</td>
              <td class="num"><b>${num(r.balanceAfter)}</b></td>
              <td class="small">${esc(r.createdByName || '\u2014')}</td>
            </tr>`).join('')}</tbody></table>`
          : emptyState('No stock movements', 'Adjustments and issues will appear here as an append-only ledger.', '', 'book')}</div>
        <div class="small muted" style="padding:10px 14px">Showing ${num(rows.length)} of ${num(res.total)} ledger entr${res.total === 1 ? 'y' : 'ies'}. The ledger is append-only.</div>
      </div>`;
  }

  if (tab === 'issues') {
    const res = await api.get('/api/procurement/stock/issues?pageSize=100');
    const rows = res.issues || [];
    bodyHtml = `
      <div class="card">
        <div class="table-wrap">${rows.length
          ? `<table class="tbl"><thead><tr><th>Issue</th><th>Store</th><th>Issued to</th><th>Issued by</th><th>Date</th><th>Status</th><th></th></tr></thead><tbody>${rows.map((r) => `<tr>
              <td><span class="strong mono">${esc(r.issueNo)}</span><div class="small muted">${esc(r.requisitionNo)}</div></td>
              <td>${esc(r.storeName)}</td>
              <td>${esc(r.issuedToName)}</td>
              <td>${esc(r.issuedByName)}</td>
              <td class="small">${fmtDate(r.issuedAt, true)}</td>
              <td>${statusBadge(r.status)}</td>
              <td class="actions"><button class="btn btn-sm btn-ghost" type="button" data-issue="${r.id}">${icon('eye')}</button></td>
            </tr>`).join('')}</tbody></table>`
          : emptyState('No stock issues', 'Issues are created when a store verifies a consumable requisition as available.', '', 'send')}</div>
      </div>`;
  }

  if (tab === 'adjustments') {
    const res = await api.get('/api/procurement/stock/adjustments');
    const rows = res.adjustments || [];
    bodyHtml = `
      <div class="card">
        <div class="table-wrap">${rows.length
          ? `<table class="tbl"><thead><tr><th>Adjustment</th><th>Item</th><th>Store / Bin</th><th>Type</th><th class="num">Qty</th><th>Reason</th><th>By</th><th>Date</th></tr></thead><tbody>${rows.map((r) => `<tr>
              <td class="mono">${esc(r.adjustmentNo)}</td>
              <td><span class="strong">${esc(r.itemName)}</span><div class="small muted mono">${esc(r.itemCode)}</div></td>
              <td>${esc(r.storeName)}<div class="small muted">${esc(r.binName || 'Unassigned')}</div></td>
              <td>${statusBadge(r.adjustmentType)}</td>
              <td class="num">${num(r.quantity)}</td>
              <td class="small">${esc(r.reason)}</td>
              <td class="small">${esc(r.adjustedByName)}</td>
              <td class="small">${fmtDate(r.adjustedAt, true)}</td>
            </tr>`).join('')}</tbody></table>`
          : emptyState('No adjustments', 'Record opening stock or corrections to keep balances accurate.', '', 'sliders')}</div>
      </div>`;
  }

  ctx.view.innerHTML = `
    <div class="page-head">
      <div><h1>Stock Register</h1><div class="sub">Balances, append-only ledger, issues and adjustments</div></div>
      <div class="page-actions">
        ${can('stock.manage') ? `<button class="btn btn-primary" type="button" data-adjust>${icon('plus')} Stock Adjustment</button>` : ''}
      </div>
    </div>
    <div class="toolbar mb-16">${TABS.map((t) => tabLink(t, tab)).join('')}</div>
    ${summaryHtml}
    ${bodyHtml}`;

  const filterForm = document.getElementById('stock-filters');
  if (filterForm) {
    filterForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const data = Object.fromEntries(new FormData(filterForm).entries());
      if (!filterForm.belowReorder?.checked) delete data.belowReorder;
      navigate(withQuery('/stocks', { tab, ...data }));
    });
    filterForm.querySelector('[data-reset]').addEventListener('click', () => navigate(`/stocks?tab=${tab}`));
  }

  ctx.view.querySelector('[data-adjust]')?.addEventListener('click', () => {
    if (!stores.length) {
      toast('Create a store before recording stock.', 'error');
      return;
    }
    if (!items.length) {
      toast('Create a stocked consumable item first.', 'error');
      return;
    }
    openAdjustment(meta, () => navigate(`/stocks?tab=${tab}`));
  });

  ctx.view.querySelectorAll('[data-issue]').forEach((btn) => {
    btn.addEventListener('click', () => openIssue(btn.dataset.issue));
  });
}
