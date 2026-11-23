import { api } from '../api.js';
import { can } from '../state.js';
import { navigate, withQuery } from '../router.js';
import {
  esc, icon, money, num, statusBadge, emptyState, toast, field, modal, confirmDialog, actionDialog, fmtDate,
  roundRupee, roundOffAmount, roundOffControl, syncRoundOffInput, readRoundOffOverride, bindRoundOffControl,
} from '../ui.js';

const TYPE_LABEL = { consumable: 'Consumable', asset: 'Asset', service: 'Service' };
const PRIORITY_LABEL = { low: 'Low', normal: 'Normal', high: 'High', urgent: 'Urgent' };
const STATUS_LABEL = {
  draft: 'Draft',
  pending: 'Pending Approval',
  returned: 'Returned',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
  store_verification: 'Store Verification',
  sourcing: 'Sourcing',
  issued: 'Issued',
  closed: 'Closed',
};

function statusOf(status) {
  return statusBadge(status, STATUS_LABEL[status] || status);
}

function priorityChip(priority) {
  return `<span class="chip ${priority === 'urgent' || priority === 'high' ? 'amber' : 'gray'}">${esc(PRIORITY_LABEL[priority] || priority)}</span>`;
}

/* ================================================================== */
/* LIST                                                                */
/* ================================================================== */
export async function renderList(ctx) {
  const q = ctx.route.query || {};
  const params = new URLSearchParams();
  for (const key of ['search', 'status', 'type', 'mine', 'approvals']) {
    if (q[key]) params.set(key, q[key]);
  }

  ctx.view.innerHTML = `<div class="empty">Loading requisitions\u2026</div>`;
  const [meta, res] = await Promise.all([
    api.get('/api/procurement/requisitions/meta'),
    api.get(`/api/procurement/requisitions?${params.toString()}`),
  ]);

  const rows = res.requisitions || [];
  const summary = res.summary || {};
  const approving = q.approvals === '1';

  ctx.view.innerHTML = `
    <div class="page-head">
      <div><h1>Requisitions</h1><div class="sub">Raise requirements, route approvals and fulfil them from stock</div></div>
      <div class="page-actions">
        <a class="btn ${approving ? 'btn-primary' : ''}" href="#/requisitions?approvals=1">${icon('checkSquare')} Awaiting my approval</a>
        ${can('requisition.create') ? `<a class="btn btn-primary" href="#/requisitions/new">${icon('plus')} New Requisition</a>` : ''}
      </div>
    </div>

    <div class="grid grid-4 mb-16">
      <div class="card"><div class="kpi"><div class="chip gray">${icon('clock')}</div><div><div class="label">Pending approval</div><div class="value">${num(summary.pending)}</div><div class="meta">In the approval chain</div></div></div></div>
      <div class="card"><div class="kpi"><div class="chip amber">${icon('database')}</div><div><div class="label">Store verification</div><div class="value">${num(summary.verification)}</div><div class="meta">Awaiting stock check</div></div></div></div>
      <div class="card"><div class="kpi"><div class="chip teal">${icon('checkCircle')}</div><div><div class="label">Issued / closed</div><div class="value">${num(summary.fulfilled)}</div><div class="meta">Fulfilled from stock</div></div></div></div>
      <div class="card"><div class="kpi"><div class="chip blue">${icon('briefcase')}</div><div><div class="label">Sourcing</div><div class="value">${num(summary.sourcing)}</div><div class="meta">Moved to procurement</div></div></div></div>
    </div>

    <div class="card">
      <form class="toolbar" id="req-filters">
        <div class="search">${icon('search')}<input class="input" name="search" value="${esc(q.search || '')}" placeholder="Requisition number, purpose or requester..." /></div>
        <select class="select" name="status">
          <option value="">All statuses</option>
          ${Object.entries(STATUS_LABEL).map(([value, label]) => `<option value="${value}" ${q.status === value ? 'selected' : ''}>${esc(label)}</option>`).join('')}
        </select>
        <select class="select" name="type">
          <option value="">All types</option>
          ${Object.entries(TYPE_LABEL).map(([value, label]) => `<option value="${value}" ${q.type === value ? 'selected' : ''}>${esc(label)}</option>`).join('')}
        </select>
        <label style="display:flex;gap:6px;align-items:center;white-space:nowrap;font-size:13px">
          <input type="checkbox" name="mine" value="1" ${q.mine === '1' ? 'checked' : ''} /> Only mine
        </label>
        <button class="btn btn-sm" type="submit">${icon('filter')} Apply</button>
        <button class="btn btn-sm btn-ghost" type="button" data-reset>Reset</button>
      </form>
      <div class="table-wrap">
        ${rows.length
          ? `<table class="tbl">
              <thead><tr><th>Requisition</th><th>Requester</th><th>Type</th><th class="num">Items</th><th class="num">Estimated</th><th>Status</th><th>Current stage</th><th></th></tr></thead>
              <tbody>${rows.map((r) => `<tr>
                <td><a class="strong" href="#/requisitions/${r.id}">${esc(r.requisitionNo)}</a>
                  <div class="small muted">${esc(r.purpose)}</div></td>
                <td>${esc(r.requestedByName)}<div class="small muted">${esc(r.departmentName || r.unitName)}</div></td>
                <td>${esc(TYPE_LABEL[r.requirementType] || r.requirementType)}<div class="small">${priorityChip(r.priority)}</div></td>
                <td class="num">${num(r.itemCount)}</td>
                <td class="num">${money(r.estimatedTotal)}</td>
                <td>${statusOf(r.status)}</td>
                <td>${esc(r.currentStageName || '\u2014')}</td>
                <td class="actions"><a class="btn btn-sm btn-ghost" href="#/requisitions/${r.id}">${icon('eye')}</a></td>
              </tr>`).join('')}</tbody></table>`
          : emptyState(
              approving ? 'Nothing awaiting your approval' : 'No requisitions found',
              approving
                ? 'Requisitions at your approval stage will appear here.'
                : 'Raise a requisition to request consumables, assets or services.',
              can('requisition.create') && !approving ? '<a class="btn btn-sm btn-primary" href="#/requisitions/new">New Requisition</a>' : '',
              'clipboard'
            )}
      </div>
      <div class="small muted" style="padding:10px 14px">Showing ${num(rows.length)} of ${num(res.total)} requisition${res.total === 1 ? '' : 's'}.</div>
    </div>`;

  const form = document.getElementById('req-filters');
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(form).entries());
    if (!form.mine.checked) delete data.mine;
    if (approving) delete data.approvals;
    navigate(withQuery('/requisitions', data));
  });
  form.querySelector('[data-reset]').addEventListener('click', () => navigate('/requisitions'));
}

/* ================================================================== */
/* FORM                                                                */
/* ================================================================== */
function itemOptions(items, selected) {
  const other = String(selected || '') === '__other__';
  return `<option value="">\u2014 Select item \u2014</option>${items
    .map((item) => `<option value="${item.id}" ${String(item.id) === String(selected || '') ? 'selected' : ''}>${esc(item.name)} (${esc(item.itemCode)}) \u00b7 ${esc(item.uomCode)}</option>`)
    .join('')}<option value="__other__" ${other ? 'selected' : ''}>Other \u2014 item not in the list (type the name)</option>`;
}

const round2 = (value) => Math.round((Number(value) || 0) * 100) / 100;

/* Saved lines store the applied discount; the API expects the raw flat amount. */
function rawFlatDiscount(line, quantity, unitCost) {
  if (line.discountAmount === undefined || line.discountAmount === null || line.discountAmount === '') return undefined;
  const gross = round2(round2(quantity) * round2(unitCost));
  const percentPart = round2((gross * round2(line.discountPercent)) / 100);
  return Math.max(0, round2(Number(line.discountAmount) - percentPart));
}

/* Mirrors the shared server tax rules: discounts first, then tax (which can be
 * back-calculated out of an inclusive price). */
function calculateLine({ quantity, unitCost, discountPercent, discountAmount, taxRate, taxInclusive }) {
  const gross = round2(round2(quantity) * round2(unitCost));
  const pct = round2(discountPercent);
  const appliedDiscount = round2(Math.min(gross, round2((gross * pct) / 100) + round2(discountAmount)));
  const discounted = round2(gross - appliedDiscount);
  const rate = round2(taxRate);
  const taxableAmount = taxInclusive
    ? (rate > 0 ? round2(discounted / (1 + rate / 100)) : discounted)
    : discounted;
  const taxAmount = taxInclusive ? round2(discounted - taxableAmount) : round2((discounted * rate) / 100);
  const totalAmount = taxInclusive ? discounted : round2(discounted + taxAmount);
  return {
    grossAmount: gross,
    discountPercent: pct,
    discountAmount: appliedDiscount,
    taxableAmount,
    taxRate: rate,
    taxInclusive: !!taxInclusive,
    taxAmount,
    totalAmount,
  };
}

/* Header discount is applied to the sum of line totals (after tax). */
function calculateHeader(linesTotal, discountPercent, discountAmount) {
  const gross = round2(linesTotal);
  const applied = round2(Math.min(gross, round2((gross * round2(discountPercent)) / 100) + round2(discountAmount)));
  return { discountAmount: applied, total: round2(gross - applied) };
}

const itemDefaultsCache = new Map();
let defaultsSeq = 0;
function loadItemDefaults(itemId) {
  if (!itemId) return Promise.resolve(null);
  if (!itemDefaultsCache.has(itemId)) {
    itemDefaultsCache.set(itemId, api.get(`/api/procurement/items/${itemId}`)
      .then((res) => (res && (res.item?.details || res.details)) || null)
      .catch(() => null));
  }
  return itemDefaultsCache.get(itemId);
}

function lineRow(items, line = {}) {
  const freeName = line.itemId ? '' : (line.itemName || '');
  const isOther = !line.itemId && !!freeName;
  const quantity = line.quantity !== undefined ? line.quantity : '1';
  const unitCost = line.estimatedUnitCost !== undefined ? line.estimatedUnitCost : '';
  const flatDiscount = rawFlatDiscount(line, quantity, unitCost);
  const calc = calculateLine({
    quantity,
    unitCost,
    discountPercent: line.discountPercent,
    discountAmount: flatDiscount,
    taxRate: line.taxRate ?? line.gstRate,
    taxInclusive: line.taxInclusive,
  });
  return `<tr data-line data-tax-known="${line.id || line.taxRate !== undefined || line.discountPercent !== undefined || line.taxInclusive !== undefined ? '1' : ''}">
    <td style="min-width:240px">
      <select class="select" data-item>${itemOptions(items, isOther ? '__other__' : line.itemId)}</select>
      <input class="input${isOther ? '' : ' hidden'}" data-item-name value="${esc(freeName)}" maxlength="200" placeholder="Type the item name" style="margin-top:6px" />
    </td>
    <td style="min-width:160px"><input class="input" data-desc value="${esc(line.description || '')}" placeholder="Description / specification" /></td>
    <td class="num" style="width:96px;min-width:96px"><input class="input" data-qty type="number" min="0.01" step="0.01" inputmode="decimal" value="${esc(quantity)}" style="text-align:right" /></td>
    <td class="num" style="width:130px;min-width:130px"><input class="input" data-cost type="number" min="0" step="0.01" inputmode="decimal" value="${esc(unitCost)}" style="text-align:right" /></td>
    <td class="num" style="width:84px;min-width:84px"><input class="input" data-discpct type="number" min="0" max="100" step="0.01" inputmode="decimal" value="${line.discountPercent !== undefined ? esc(line.discountPercent) : '0'}" style="text-align:right" /></td>
    <td class="num" style="width:96px;min-width:96px"><input class="input" data-disamt type="number" min="0" step="0.01" inputmode="decimal" value="${flatDiscount !== undefined ? esc(flatDiscount) : '0'}" style="text-align:right" /></td>
    <td class="num" style="width:84px;min-width:84px"><input class="input" data-tax type="number" min="0" max="100" step="0.01" inputmode="decimal" value="${esc(line.taxRate ?? line.gstRate ?? 0)}" style="text-align:right" /></td>
    <td style="width:76px;min-width:76px;text-align:center"><label class="row" style="gap:4px;justify-content:center;font-size:12px"><input type="checkbox" data-inclusive ${line.taxInclusive ? 'checked' : ''} /> Incl.</label></td>
    <td class="num" style="min-width:140px">
      <div class="strong" data-total>${money(calc.totalAmount)}</div>
      <div class="small muted" data-line-break>Taxable ${money(calc.taxableAmount)} \u00b7 Tax ${money(calc.taxAmount)}</div>
    </td>
    <td class="actions"><button class="btn btn-sm btn-ghost" type="button" data-remove title="Remove line">${icon('trash')}</button></td>
  </tr>`;
}

function readLines(form) {
  const lines = [];
  form.querySelectorAll('[data-line]').forEach((row) => {
    const rawItem = row.querySelector('[data-item]').value;
    const itemId = rawItem === '__other__' ? '' : rawItem;
    const itemName = row.querySelector('[data-item-name]').value.trim();
    const quantity = row.querySelector('[data-qty]').value;
    const unitCost = row.querySelector('[data-cost]').value;
    if (!itemId && !itemName && !row.querySelector('[data-desc]').value.trim()) return;
    const discPctInput = row.querySelector('[data-discpct]');
    const disAmtInput = row.querySelector('[data-disamt]');
    const taxInput = row.querySelector('[data-tax]');
    const inclusiveInput = row.querySelector('[data-inclusive]');
    const calc = calculateLine({
      quantity,
      unitCost,
      discountPercent: discPctInput.value,
      discountAmount: disAmtInput.value,
      taxRate: taxInput.value,
      taxInclusive: inclusiveInput.checked,
    });
    const includeAll = row.dataset.taxKnown === '1' || row.dataset.defaultsApplied === '1';
    const line = {
      itemId,
      itemName,
      description: row.querySelector('[data-desc]').value.trim(),
      quantity,
      estimatedUnitCost: unitCost,
      taxableAmount: calc.taxableAmount,
      taxAmount: calc.taxAmount,
      estimatedTotal: calc.totalAmount,
    };
    if (includeAll || discPctInput.dataset.overridden === '1') line.discountPercent = calc.discountPercent;
    if (includeAll || disAmtInput.dataset.overridden === '1') line.discountAmount = disAmtInput.value;
    if (includeAll || taxInput.dataset.overridden === '1') line.taxRate = calc.taxRate;
    if (includeAll || inclusiveInput.dataset.overridden === '1') line.taxInclusive = inclusiveInput.checked;
    lines.push(line);
  });
  return lines;
}

export async function renderForm(ctx, options = {}) {
  const id = options.id ? Number(options.id) : null;
  ctx.view.innerHTML = `<div class="empty">Loading requisition\u2026</div>`;

  const [meta, vendorsRes] = await Promise.all([
    api.get('/api/procurement/requisitions/meta'),
    api.get('/api/vendors?status=Active').catch(() => ({ vendors: [] })),
  ]);
  let detail = null;
  let requisition = null;
  let lines = [];
  if (id) {
    detail = await api.get(`/api/procurement/requisitions/${id}`);
    requisition = detail.requisition;
    lines = detail.items;
    if (!['draft', 'returned'].includes(requisition.status)) {
      throw new Error('Only draft or returned requisitions can be edited.');
    }
  }

  const units = meta.units || [];
  const selectedUnit = requisition ? requisition.unitId : (units.length === 1 ? units[0].id : '');
  const departments = meta.departments || [];
  const costCenters = (meta.costCenters || []).filter((c) => !selectedUnit || Number(c.unitId) === Number(selectedUnit));
  const itemList = meta.items || [];
  const vendors = vendorsRes.vendors || [];
  const vendorById = {};
  for (const v of vendors) vendorById[v.id] = v;
  const vendorOptions = vendors.map((v) => ({ value: v.id, label: `${v.name} (${v.code})` }));
  const initialVendorSelect = requisition?.suggestedVendorId
    ? String(requisition.suggestedVendorId)
    : (requisition?.suggestedVendorName ? '__other__' : '');
  const initialLines = lines.length ? lines : [{ quantity: 1 }];

  ctx.view.innerHTML = `
    <div class="page-head">
      <div><h1>${id ? 'Edit Requisition' : 'New Requisition'}</h1>
        <div class="sub">${id ? `${esc(requisition.requisitionNo)} \u00b7 ${esc(requisition.status)}` : 'Request consumables, assets or services and route them for approval'}</div></div>
      <div class="page-actions">
        <a class="btn" href="${id ? `#/requisitions/${id}` : '#/requisitions'}">${icon('arrowLeft')} Cancel</a>
        <button class="btn" type="button" data-save>${icon('check')} Save draft</button>
        <button class="btn btn-primary" type="button" data-submit>${icon('send')} Save &amp; submit</button>
      </div>
    </div>
    <div id="req-alert" class="alert alert-danger hidden"></div>

    <form id="req-form" autocomplete="off" data-saved-round-off="${esc(requisition?.roundOff ?? '')}">
      <div class="stack">
        <div class="card">
          <div class="card-head"><div><h3>Requirement</h3><div class="sub">Who needs what and by when</div></div></div>
          <div class="form-section">
            <div class="form-grid">
              ${field({ label: 'Unit', name: 'unitId', type: 'select', required: true, value: selectedUnit, options: units.map((u) => ({ value: u.id, label: u.name })), attrs: 'data-unit' })}
              ${field({ label: 'Department', name: 'departmentId', type: 'select', value: requisition?.departmentId || '', options: [{ value: '', label: '\u2014 No department \u2014' }, ...departments.map((d) => ({ value: d.id, label: d.code ? `${d.code} · ${d.name}` : d.name }))] })}
              <div class="field">
                <label>Cost Centre</label>
                <select class="select" name="costCenterId" data-cost-centre>
                  ${[{ value: '', label: '\u2014 No cost centre \u2014' }, ...costCenters.map((c) => ({ value: c.id, label: `${c.name} (${c.code})` }))]
                    .map((o) => `<option value="${esc(o.value)}" ${String(o.value) === String(requisition?.costCenterId || '') ? 'selected' : ''}>${esc(o.label)}</option>`)
                    .join('')}
                </select>
              </div>
              ${field({ label: 'Requirement Type', name: 'requirementType', type: 'select', required: true, value: requisition?.requirementType || 'consumable', options: meta.requirementTypes })}
              ${field({ label: 'Priority', name: 'priority', type: 'select', value: requisition?.priority || 'normal', options: meta.priorities })}
              ${field({ label: 'Required By', name: 'requiredBy', type: 'date', value: requisition?.requiredBy || '' })}
              ${field({ label: 'Purpose', name: 'purpose', type: 'textarea', required: true, span: true, value: requisition?.purpose || '', placeholder: 'What is this requirement for?' })}
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card-head"><div><h3>Items</h3><div class="sub">Pick from the item master, or choose <b>Other</b> and type a name if the item is not listed</div></div>
            <button class="btn btn-sm" type="button" data-add-line>${icon('plus')} Add line</button></div>
          <div class="table-wrap">
            <table class="tbl" id="req-lines">
              <thead><tr><th style="min-width:240px">Item</th><th style="min-width:160px">Description</th><th class="num" style="width:96px;min-width:96px">Qty</th><th class="num" style="width:130px;min-width:130px">Unit Cost</th><th class="num" style="width:84px;min-width:84px">Disc %</th><th class="num" style="width:96px;min-width:96px">Flat disc</th><th class="num" style="width:84px;min-width:84px">Tax %</th><th style="width:76px;min-width:76px">Incl. tax</th><th class="num" style="min-width:140px">Estimated</th><th style="width:56px"></th></tr></thead>
              <tbody>${initialLines.map((line) => lineRow(itemList, line)).join('')}</tbody>
            </table>
          </div>
          <div class="form-grid" style="padding:12px 14px;border-top:1px solid var(--border)">
            ${field({ label: 'Header discount %', name: 'discountPercent', type: 'number', value: requisition?.discountPercent ?? 0, attrs: 'min="0" max="100" step="0.01"' })}
            ${field({ label: 'Header flat discount', name: 'discountAmount', type: 'number', value: requisition?.discountAmount ?? 0, attrs: 'min="0" step="0.01"' })}
          </div>
          <div class="row" style="justify-content:space-between;gap:12px;padding:10px 14px;border-top:1px solid var(--border)">
            <div class="small muted">Line total after tax <span data-lines-total class="strong">${money(0)}</span></div>
            <div class="small muted">Header discount <span data-header-discount class="strong">${money(0)}</span></div>
            ${roundOffControl({ value: requisition?.roundOff ?? 0 })}
            <div style="text-align:right"><div class="small muted">Total before round off</div><div class="strong" data-grand-total>${money(0)}</div>
              <div class="small muted">Estimated total (rounded)</div><div class="strong" data-req-final>${money(0)}</div></div>
          </div>
        </div>

        <div class="card">
          <div class="card-head"><div><h3>Suggested Vendor</h3><div class="sub">Optional \u2014 a supplier you already know for these items</div></div></div>
          <div class="form-section">
            <div class="form-grid">
              ${field({ label: 'Suggested Vendor', name: 'suggestedVendorId', type: 'select', value: initialVendorSelect, options: [{ value: '', label: '\u2014 None / not suggested \u2014' }, ...vendorOptions, { value: '__other__', label: 'Other \u2014 not listed (type the name)' }] })}
            </div>
            <div data-vendor-registered class="hidden" style="padding-top:12px">
              <div class="stack small" style="gap:6px">
                <div class="row"><span class="muted" style="width:130px">Contact</span><span data-vendor-contact>\u2014</span></div>
                <div class="row"><span class="muted" style="width:130px">Mobile</span><span data-vendor-mobile>\u2014</span></div>
                <div class="row"><span class="muted" style="width:130px">Email</span><span data-vendor-email>\u2014</span></div>
                <div class="row"><span class="muted" style="width:130px">Address</span><span data-vendor-address>\u2014</span></div>
              </div>
              <div class="hint" style="margin-top:10px">Details are taken from the vendor master record.</div>
            </div>
            <div data-vendor-other class="hidden" style="padding-top:12px">
              <div class="form-grid">
                ${field({ label: 'Vendor Name', name: 'suggestedVendorName', value: requisition?.suggestedVendorName || '', placeholder: 'Supplier or shop name' })}
                ${field({ label: 'Contact Person', name: 'suggestedVendorContact', value: requisition?.suggestedVendorContact || '', placeholder: 'Who to speak to' })}
                ${field({ label: 'Mobile', name: 'suggestedVendorMobile', value: requisition?.suggestedVendorMobile || '', placeholder: 'Phone number' })}
                ${field({ label: 'Email', name: 'suggestedVendorEmail', type: 'email', value: requisition?.suggestedVendorEmail || '', placeholder: 'name@supplier.com' })}
                ${field({ label: 'Address', name: 'suggestedVendorAddress', type: 'textarea', span: true, value: requisition?.suggestedVendorAddress || '', placeholder: 'Address or location of the supplier' })}
                ${field({ label: 'Notes', name: 'suggestedVendorNotes', type: 'textarea', span: true, value: requisition?.suggestedVendorNotes || '', placeholder: 'Why this vendor? Quotation reference, lead time, etc.' })}
              </div>
            </div>
            <div class="hint" style="margin-top:10px">For Procurement\u2019s reference only. It does not create a vendor record or bypass sourcing.</div>
          </div>
        </div>

        <div class="card">
          <div class="card-head"><div><h3>Approval Route</h3><div class="sub">Configured procurement workflow</div></div></div>
          <div class="form-section">
            ${(meta.workflow || []).length
              ? `<ol style="margin:0;padding-left:18px">${meta.workflow.map((s) => `<li style="margin-bottom:6px"><b>${esc(s.name)}</b><div class="small muted">${esc(s.role_name)}</div></li>`).join('')}</ol>`
              : '<div class="hint">No procurement workflow is configured. The fallback approval stage will be used.</div>'}
            <div class="hint" style="margin-top:10px">Consumable requests move to store verification after approval. Assets and services move to sourcing.</div>
          </div>
        </div>

        <div class="card">
          <div class="card-head"><div><h3>Submission</h3><div class="sub">Draft first, then submit when ready</div></div></div>
          <div class="form-section">
            <div class="hint">Saving as a draft lets you revise the requirement. Submitting starts the approval workflow and locks the lines until a stage returns the request for correction.</div>
          </div>
        </div>
      </div>
    </form>`;

  const form = document.getElementById('req-form');
  const alertBox = document.getElementById('req-alert');
  const tbody = form.querySelector('#req-lines tbody');

  const regBox = form.querySelector('[data-vendor-registered]');
  const otherBox = form.querySelector('[data-vendor-other]');
  function updateVendorMode() {
    const val = form.suggestedVendorId.value;
    if (val && val !== '__other__') {
      regBox.classList.remove('hidden');
      otherBox.classList.add('hidden');
      const v = vendorById[val];
      if (v) {
        const set = (sel, text) => { const el = form.querySelector(sel); if (el) el.textContent = text; };
        set('[data-vendor-contact]', v.contactPerson || '\u2014');
        set('[data-vendor-mobile]', v.mobile || '\u2014');
        set('[data-vendor-email]', v.email || '\u2014');
        set('[data-vendor-address]', [v.addressLine1, v.addressLine2, v.city, v.state, v.pincode].filter(Boolean).join(', ') || '\u2014');
      }
    } else if (val === '__other__') {
      regBox.classList.add('hidden');
      otherBox.classList.remove('hidden');
    } else {
      regBox.classList.add('hidden');
      otherBox.classList.add('hidden');
    }
  }
  if (form.suggestedVendorId) {
    form.suggestedVendorId.addEventListener('change', updateVendorMode);
    updateVendorMode();
  }

  function recalc() {
    let linesTotal = 0;
    tbody.querySelectorAll('[data-line]').forEach((row) => {
      const calc = calculateLine({
        quantity: row.querySelector('[data-qty]').value,
        unitCost: row.querySelector('[data-cost]').value,
        discountPercent: row.querySelector('[data-discpct]').value,
        discountAmount: row.querySelector('[data-disamt]').value,
        taxRate: row.querySelector('[data-tax]').value,
        taxInclusive: row.querySelector('[data-inclusive]').checked,
      });
      linesTotal += calc.totalAmount;
      row.querySelector('[data-total]').textContent = money(calc.totalAmount);
      row.querySelector('[data-line-break]').textContent = `Taxable ${money(calc.taxableAmount)} \u00b7 Tax ${money(calc.taxAmount)}`;
    });
    const header = calculateHeader(linesTotal, form.discountPercent.value, form.discountAmount.value);
    form.querySelector('[data-lines-total]').textContent = money(linesTotal);
    form.querySelector('[data-header-discount]').textContent = money(header.discountAmount);
    const roundOff = syncRoundOffInput(
      form.querySelector('[name="roundOff"]'), header.total, form.dataset.savedRoundOff
    );
    const finalTotal = round2(header.total + roundOff);
    form.querySelector('[data-grand-total]').textContent = money(header.total);
    form.querySelector('[data-req-final]').textContent = money(finalTotal);
    return { ...header, roundOff, final: finalTotal };
  }

  bindRoundOffControl(form, recalc);

  function applyItemDefaults(row, defaults, token) {
    if (!defaults || row.dataset.defaultToken !== token) return;
    const set = (selector, value) => {
      const el = row.querySelector(selector);
      if (!el || el.dataset.overridden === '1' || value === undefined || value === null || value === '') return;
      el.value = value;
    };
    set('[data-discpct]', defaults.defaultDiscountPercent ?? 0);
    set('[data-disamt]', defaults.defaultDiscountAmount ?? 0);
    set('[data-tax]', defaults.taxRate ?? defaults.gstRate ?? 0);
    const inclusive = row.querySelector('[data-inclusive]');
    if (inclusive && inclusive.dataset.overridden !== '1' && defaults.taxInclusive !== undefined) {
      inclusive.checked = !!defaults.taxInclusive;
    }
    row.dataset.defaultsApplied = '1';
    recalc();
  }

  function syncLine(row) {
    const select = row.querySelector('[data-item]');
    const nameInput = row.querySelector('[data-item-name]');
    const isOther = select.value === '__other__';
    nameInput.classList.toggle('hidden', !isOther);
    if (isOther) {
      nameInput.focus();
      recalc();
      return;
    }
    nameInput.value = '';
    const item = itemList.find((i) => String(i.id) === String(select.value));
    if (item) {
      const desc = row.querySelector('[data-desc]');
      const cost = row.querySelector('[data-cost]');
      if (!desc.value.trim()) desc.value = item.name;
      if (!cost.value) cost.value = item.standardCost || 0;
    }
    const token = String(++defaultsSeq);
    row.dataset.defaultToken = token;
    row.dataset.defaultsApplied = '';
    if (select.value) loadItemDefaults(select.value).then((defaults) => applyItemDefaults(row, defaults, token));
    recalc();
  }

  function bindRow(row) {
    row.querySelector('[data-item]').addEventListener('change', () => syncLine(row));
    row.querySelector('[data-qty]').addEventListener('input', recalc);
    row.querySelector('[data-cost]').addEventListener('input', recalc);
    ['[data-discpct]', '[data-disamt]', '[data-tax]'].forEach((selector) => {
      const el = row.querySelector(selector);
      el.addEventListener('input', () => { el.dataset.overridden = '1'; recalc(); });
    });
    const inclusive = row.querySelector('[data-inclusive]');
    inclusive.addEventListener('change', () => { inclusive.dataset.overridden = '1'; recalc(); });
    row.querySelector('[data-remove]').addEventListener('click', () => {
      if (tbody.querySelectorAll('[data-line]').length === 1) {
        toast('A requisition needs at least one line.', 'error');
        return;
      }
      row.remove();
      recalc();
    });
  }

  form.discountPercent.addEventListener('input', recalc);
  form.discountAmount.addEventListener('input', recalc);
  tbody.querySelectorAll('[data-line]').forEach(bindRow);
  recalc();

  form.querySelector('[data-add-line]').addEventListener('click', () => {
    tbody.insertAdjacentHTML('beforeend', lineRow(itemList));
    bindRow(tbody.querySelector('[data-line]:last-child'));
    recalc();
  });

  form.querySelector('[data-unit]').addEventListener('change', () => {
    const unitId = Number(form.unitId.value);
    const select = form.querySelector('[data-cost-centre]');
    const options = costCenters.filter((c) => Number(c.unitId) === unitId);
    select.innerHTML = [{ value: '', label: '\u2014 No cost centre \u2014' }, ...options.map((c) => ({ value: c.id, label: `${c.name} (${c.code})` }))]
      .map((o) => `<option value="${esc(o.value)}">${esc(o.label)}</option>`)
      .join('');
  });

  function showError(message) {
    alertBox.innerHTML = `${icon('alert')} ${esc(message)}`;
    alertBox.classList.remove('hidden');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function payload() {
    const linesOut = readLines(form);
    if (!linesOut.length) throw new Error('Add at least one item.');
    if (linesOut.some((l) => !l.itemId && !l.itemName)) throw new Error('Select an item or type an item name on every line.');
    const vendorSel = form.suggestedVendorId.value;
    const isOther = vendorSel === '__other__';
    const freeText = isOther;
    const linesTotal = round2(linesOut.reduce((sum, line) => sum + (Number(line.estimatedTotal) || 0), 0));
    const header = calculateHeader(linesTotal, form.discountPercent.value, form.discountAmount.value);
    return {
      unitId: form.unitId.value,
      departmentId: form.departmentId.value || null,
      costCenterId: form.costCenterId.value || null,
      requirementType: form.requirementType.value,
      priority: form.priority.value,
      requiredBy: form.requiredBy.value || null,
      purpose: form.purpose.value.trim(),
      discountPercent: form.discountPercent.value,
      discountAmount: form.discountAmount.value,
      roundOff: readRoundOffOverride(form.querySelector('[name="roundOff"]'), header.total),
      suggestedVendorId: (vendorSel && vendorSel !== '__other__') ? Number(vendorSel) : null,
      suggestedVendorName: freeText ? form.suggestedVendorName.value.trim() : '',
      suggestedVendorContact: freeText ? form.suggestedVendorContact.value.trim() : '',
      suggestedVendorMobile: freeText ? form.suggestedVendorMobile.value.trim() : '',
      suggestedVendorEmail: freeText ? form.suggestedVendorEmail.value.trim() : '',
      suggestedVendorAddress: freeText ? form.suggestedVendorAddress.value.trim() : '',
      suggestedVendorNotes: freeText ? form.suggestedVendorNotes.value.trim() : (form.suggestedVendorNotes?.value?.trim() || ''),
      items: linesOut,
    };
  }

  async function save(submitAfter) {
    alertBox.classList.add('hidden');
    let data;
    try {
      data = payload();
    } catch (err) {
      return showError(err.message);
    }
    if (!data.purpose) return showError('Purpose is required.');
    const vendorExtras = data.suggestedVendorContact || data.suggestedVendorMobile
      || data.suggestedVendorEmail || data.suggestedVendorAddress || data.suggestedVendorNotes;
    if (!data.suggestedVendorName && vendorExtras) {
      return showError('Enter the suggested vendor name, or clear the other suggested vendor details.');
    }
    if (data.suggestedVendorEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.suggestedVendorEmail)) {
      return showError('Suggested vendor email is not valid.');
    }
    try {
      let savedId = id;
      if (id) {
        await api.put(`/api/procurement/requisitions/${id}`, data);
      } else {
        const res = await api.post('/api/procurement/requisitions', data);
        savedId = res.id;
      }
      if (submitAfter) {
        await api.post(`/api/procurement/requisitions/${savedId}/submit`);
        toast('Requisition submitted for approval.');
      } else {
        toast(id ? 'Requisition updated.' : 'Requisition saved as draft.');
      }
      navigate(`/requisitions/${savedId}`);
    } catch (err) {
      showError(err.message || 'Unable to save the requisition.');
    }
  }

  ctx.view.querySelector('[data-save]').addEventListener('click', () => save(false));
  ctx.view.querySelector('[data-submit]').addEventListener('click', () => save(true));
}

/* ================================================================== */
/* DETAIL                                                              */
/* ================================================================== */
export async function renderDetail(ctx, options = {}) {
  const id = Number(options.id);
  ctx.view.innerHTML = `<div class="empty">Loading requisition\u2026</div>`;
  const detail = await api.get(`/api/procurement/requisitions/${id}`);
  const r = detail.requisition;
  const actions = detail.actions || {};
  let verifyStores = [];
  if (actions.canVerify) {
    try {
      const stockMeta = await api.get('/api/procurement/stock/meta');
      verifyStores = (stockMeta.stores || []).filter((s) => Number(s.unitId) === Number(r.unitId));
    } catch {
      verifyStores = [];
    }
  }

  const refresh = () => renderDetail(ctx, { id });
  const act = async (fn, message, type = 'success') => {
    try {
      await fn();
      toast(message, type);
      await refresh();
    } catch (err) {
      toast(err.message || 'Action failed.', 'error');
    }
  };

  ctx.view.innerHTML = `
    <div class="page-head">
      <div><h1>${esc(r.requisitionNo)}</h1>
        <div class="sub">${esc(r.purpose)} \u00b7 ${esc(r.unitName)}${r.departmentName ? ` \u00b7 ${esc(r.departmentName)}` : ''}</div></div>
      <div class="page-actions">
        <a class="btn" href="#/requisitions">${icon('arrowLeft')} Back</a>
        ${actions.canEdit ? `<a class="btn" href="#/requisitions/${r.id}/edit">${icon('edit')} Edit</a>` : ''}
        ${actions.canSubmit ? `<button class="btn btn-primary" type="button" data-submit>${icon('send')} Submit</button>` : ''}
        ${actions.canApprove ? `<button class="btn btn-primary" type="button" data-approve>${icon('check')} Approve</button>
          <button class="btn" type="button" data-return>${icon('undo')} Return</button>
          <button class="btn btn-danger" type="button" data-reject>${icon('x')} Reject</button>` : ''}
        ${actions.canVerify ? `<button class="btn btn-primary" type="button" data-verify>${icon('database')} Verify Stock</button>` : ''}
        ${actions.canAcknowledge ? `<button class="btn btn-primary" type="button" data-acknowledge>${icon('checkCircle')} Acknowledge</button>` : ''}
        ${actions.canCancel ? `<button class="btn btn-danger" type="button" data-cancel>${icon('xCircle')} Cancel</button>` : ''}
        ${actions.canDelete ? `<button class="btn btn-danger" type="button" data-delete>${icon('trash')} Delete</button>` : ''}
      </div>
    </div>

    <div class="grid grid-4 mb-16">
      <div class="card"><div class="kpi"><div class="chip gray">${icon('clipboard')}</div><div><div class="label">Status</div><div class="value small-value">${statusOf(r.status)}</div><div class="meta">${esc(r.currentStageName || 'No pending stage')}</div></div></div></div>
      <div class="card"><div class="kpi"><div class="chip blue">${icon('layers')}</div><div><div class="label">Estimated value</div><div class="value small-value">${money(r.estimatedTotal)}</div><div class="meta">${num(r.itemCount)} line${r.itemCount === 1 ? '' : 's'}</div></div></div></div>
      <div class="card"><div class="kpi"><div class="chip amber">${icon('user')}</div><div><div class="label">Requested by</div><div class="value small-value">${esc(r.requestedByName)}</div><div class="meta">${fmtDate(r.createdAt)}</div></div></div></div>
      <div class="card"><div class="kpi"><div class="chip teal">${icon('calendar')}</div><div><div class="label">Required by</div><div class="value small-value">${r.requiredBy ? esc(fmtDate(r.requiredBy)) : '\u2014'}</div><div class="meta">${esc(TYPE_LABEL[r.requirementType] || r.requirementType)}</div></div></div></div>
    </div>

    <div class="grid grid-2" style="align-items:start">
      <div class="stack">
        <div class="card">
          <div class="card-head"><div><h3>Requisition Items</h3><div class="sub">Requested quantities and estimated cost</div></div></div>
          <div class="table-wrap">
            <table class="tbl">
              <thead><tr><th>Item</th><th>Description</th><th class="num">Qty</th><th class="num">Unit Cost</th><th class="num">Estimated</th></tr></thead>
              <tbody>${detail.items.map((line) => `<tr>
                <td><span class="strong">${esc(line.itemName)}</span>${line.itemCode
                  ? `<div class="small muted mono">${esc(line.itemCode)}</div>`
                  : '<div class="small muted">Not in item master</div>'}</td>
                <td class="small">${esc(line.description || '\u2014')}</td>
                <td class="num">${num(line.quantity)} <span class="small muted">${esc(line.uomCode)}</span></td>
                <td class="num">${money(line.estimatedUnitCost)}</td>
                <td class="num">${money(line.estimatedTotal)}</td>
              </tr>`).join('')}</tbody>
            </table>
          </div>
          <div class="row" style="justify-content:flex-end;padding:12px 14px;border-top:1px solid var(--border)">
            <div style="text-align:right" class="small">
              <div class="row"><span class="muted">Total before round off</span><span>${money(r.baseTotalAmount ?? round2((r.estimatedTotal || 0) - (r.roundOff || 0)))}</span></div>
              <div class="row"><span class="muted">Round off</span><span>${money(r.roundOff || 0)}</span></div>
              <div class="row"><span class="muted">Estimated total (rounded)</span><span class="strong">${money(r.estimatedTotal)}</span></div>
            </div>
          </div>
        </div>

        ${detail.issue ? `<div class="card">
          <div class="card-head"><div><h3>Stock Issue ${esc(detail.issue.issue.issueNo)}</h3><div class="sub">${esc(detail.issue.issue.storeName)} \u00b7 issued ${fmtDate(detail.issue.issue.issuedAt, true)}</div></div>${statusOf(detail.issue.issue.status)}</div>
          <div class="table-wrap">
            <table class="tbl">
              <thead><tr><th>Item</th><th>Bin</th><th class="num">Qty</th><th class="num">Unit Cost</th></tr></thead>
              <tbody>${detail.issue.items.map((line) => `<tr>
                <td>${esc(line.itemName)}<div class="small muted mono">${esc(line.itemCode)}</div></td>
                <td>${esc(line.binName || '\u2014')}</td>
                <td class="num">${num(line.quantity)}</td>
                <td class="num">${money(line.unitCost)}</td>
              </tr>`).join('')}</tbody>
            </table>
          </div>
          <div class="small muted" style="padding:10px 14px">Issued by ${esc(detail.issue.issue.issuedByName)} to ${esc(detail.issue.issue.issuedToName)}${detail.issue.issue.acknowledgedAt ? ` \u00b7 acknowledged ${fmtDate(detail.issue.issue.acknowledgedAt, true)}` : ''}.</div>
        </div>` : ''}
      </div>

      <div class="stack">
        <div class="card">
          <div class="card-head"><div><h3>Approval History</h3><div class="sub">Stages resolved from the procurement workflow</div></div></div>
          <div class="form-section">
            ${detail.stages.length
              ? `<div class="stack">${detail.stages.map((stage) => `<div class="row" style="align-items:flex-start;gap:10px;padding:8px 0;border-bottom:1px solid var(--border)">
                  <div class="chip ${stage.status === 'approved' ? 'teal' : stage.status === 'pending' ? 'amber' : 'gray'}">${stage.sequence}</div>
                  <div style="flex:1;min-width:0">
                    <div class="strong">${esc(stage.name)} ${statusOf(stage.status)}</div>
                    <div class="small muted">${esc(stage.roleName)}${stage.actedByName ? ` \u00b7 ${esc(stage.actedByName)}` : ''}${stage.actedAt ? ` \u00b7 ${fmtDate(stage.actedAt, true)}` : ''}</div>
                    ${stage.comments ? `<div class="small" style="margin-top:4px">${esc(stage.comments)}</div>` : ''}
                  </div>
                </div>`).join('')}</div>`
              : '<div class="hint">The workflow is snapshotted when the requisition is submitted.</div>'}
          </div>
        </div>

        <div class="card">
          <div class="card-head"><div><h3>Details</h3></div></div>
          <div class="form-section">
            <div class="stack small">
              <div class="row"><span class="muted" style="width:130px">Type</span><span>${esc(TYPE_LABEL[r.requirementType] || r.requirementType)}</span></div>
              <div class="row"><span class="muted" style="width:130px">Priority</span><span>${priorityChip(r.priority)}</span></div>
              <div class="row"><span class="muted" style="width:130px">Cost centre</span><span>${esc(r.costCenterName || '\u2014')}</span></div>
              <div class="row"><span class="muted" style="width:130px">Submitted</span><span>${r.submittedAt ? fmtDate(r.submittedAt, true) : '\u2014'}</span></div>
              <div class="row"><span class="muted" style="width:130px">Final approval</span><span>${r.approvedAt ? fmtDate(r.approvedAt, true) : '\u2014'}</span></div>
              <div class="row"><span class="muted" style="width:130px">Verification</span><span>${esc(r.verificationStatus.replace(/_/g, ' ') || '\u2014')}${r.verifiedByName ? ` \u00b7 ${esc(r.verifiedByName)}` : ''}</span></div>
              ${r.verificationRemarks ? `<div class="row"><span class="muted" style="width:130px">Remarks</span><span>${esc(r.verificationRemarks)}</span></div>` : ''}
              ${r.cancelReason ? `<div class="row"><span class="muted" style="width:130px">Cancel reason</span><span>${esc(r.cancelReason)}</span></div>` : ''}
              ${r.closedAt ? `<div class="row"><span class="muted" style="width:130px">Closed</span><span>${fmtDate(r.closedAt, true)}</span></div>` : ''}
            </div>
          </div>
        </div>

        ${r.suggestedVendorName ? `<div class="card">
          <div class="card-head"><div><h3>Suggested Vendor</h3><div class="sub">Provided by the requester for reference</div></div></div>
          <div class="form-section">
            <div class="stack small">
              <div class="row"><span class="muted" style="width:130px">Vendor</span><span>${esc(r.suggestedVendorName)}${r.suggestedVendorId ? ' <span class="chip gray">registered</span>' : ''}</span></div>
              ${r.suggestedVendorContact ? `<div class="row"><span class="muted" style="width:130px">Contact</span><span>${esc(r.suggestedVendorContact)}</span></div>` : ''}
              ${r.suggestedVendorMobile ? `<div class="row"><span class="muted" style="width:130px">Mobile</span><span>${esc(r.suggestedVendorMobile)}</span></div>` : ''}
              ${r.suggestedVendorEmail ? `<div class="row"><span class="muted" style="width:130px">Email</span><span>${esc(r.suggestedVendorEmail)}</span></div>` : ''}
              ${r.suggestedVendorAddress ? `<div class="row"><span class="muted" style="width:130px">Address</span><span>${esc(r.suggestedVendorAddress)}</span></div>` : ''}
              ${r.suggestedVendorNotes ? `<div class="row"><span class="muted" style="width:130px">Notes</span><span>${esc(r.suggestedVendorNotes)}</span></div>` : ''}
            </div>
          </div>
        </div>` : ''}
      </div>
    </div>`;

  ctx.view.querySelector('[data-submit]')?.addEventListener('click', async () => {
    const ok = await confirmDialog({ title: 'Submit requisition', message: 'Submit this requisition for approval now?', confirmText: 'Submit' });
    if (ok) await act(() => api.post(`/api/procurement/requisitions/${id}/submit`), 'Requisition submitted for approval.');
  });

  ctx.view.querySelector('[data-approve]')?.addEventListener('click', async () => {
    const result = await actionDialog({ title: 'Approve requisition', subtitle: `${r.requisitionNo} \u00b7 ${r.currentStageName || ''}`, confirmText: 'Approve' });
    if (!result) return;
    await act(() => api.post(`/api/procurement/requisitions/${id}/approve`, result), 'Requisition approved.');
  });

  ctx.view.querySelector('[data-return]')?.addEventListener('click', async () => {
    const result = await actionDialog({ title: 'Return requisition', subtitle: 'The requester can revise and resubmit.', requireComment: true, confirmText: 'Return' });
    if (!result) return;
    await act(() => api.post(`/api/procurement/requisitions/${id}/return`, result), 'Requisition returned for correction.');
  });

  ctx.view.querySelector('[data-reject]')?.addEventListener('click', async () => {
    const result = await actionDialog({ title: 'Reject requisition', subtitle: 'Rejection ends this workflow.', requireComment: true, confirmText: 'Reject', danger: true });
    if (!result) return;
    await act(() => api.post(`/api/procurement/requisitions/${id}/reject`, result), 'Requisition rejected.');
  });

  ctx.view.querySelector('[data-cancel]')?.addEventListener('click', async () => {
    const result = await actionDialog({ title: 'Cancel requisition', subtitle: 'Cancelled requisitions remain in the audit trail.', confirmText: 'Cancel requisition', danger: true });
    if (!result) return;
    await act(() => api.post(`/api/procurement/requisitions/${id}/cancel`, result), 'Requisition cancelled.');
  });

  ctx.view.querySelector('[data-delete]')?.addEventListener('click', async () => {
    const ok = await confirmDialog({ title: 'Delete draft', message: 'Delete this draft requisition? It is retained for audit and hidden from lists.', confirmText: 'Delete draft', danger: true });
    if (!ok) return;
    await act(async () => {
      await api.del(`/api/procurement/requisitions/${id}`, { reason: 'Draft deleted' });
      navigate('/requisitions');
    }, 'Draft deleted.');
  });

  ctx.view.querySelector('[data-acknowledge]')?.addEventListener('click', async () => {
    const ok = await confirmDialog({ title: 'Acknowledge stock', message: 'Confirm that the issued items were received. This closes the requisition.', confirmText: 'Acknowledge & close' });
    if (ok) await act(() => api.post(`/api/procurement/requisitions/${id}/acknowledge`), 'Receipt acknowledged and requisition closed.');
  });

  ctx.view.querySelector('[data-verify]')?.addEventListener('click', () => {
    const stores = verifyStores;
    const storeOptions = (stores || []).map((s) => `<option value="${s.id}">${esc(s.name)} (${esc(s.code)})</option>`).join('');
    const m = modal({
      title: 'Verify stock availability',
      subtitle: `${r.requisitionNo} \u00b7 ${r.unitName}`,
      body: `
        <div class="field"><label>Store<span class="req">*</span></label><select class="select" data-store>${storeOptions}</select></div>
        <div class="field"><label>Bin</label><select class="select" data-bin><option value="">\u2014 Any bin \u2014</option></select></div>
        <div class="field"><label>Decision<span class="req">*</span></label>
          <select class="select" data-decision>
            <option value="available">Stock available \u2014 issue now</option>
            <option value="unavailable">Stock unavailable \u2014 move to sourcing</option>
          </select>
        </div>
        <div class="field"><label>Remarks</label><textarea class="textarea" data-remarks rows="3" placeholder="Verification notes..."></textarea></div>
        <div data-availability class="help-block">Select a store to see available stock.</div>
        <div class="alert alert-danger hidden" data-err></div>`,
      footer: `<button class="btn" data-modal-close>Cancel</button><button class="btn btn-primary" data-confirm>Record verification</button>`,
      onMount(el, close) {
        const storeSelect = el.querySelector('[data-store]');
        const binSelect = el.querySelector('[data-bin]');
        const decision = el.querySelector('[data-decision]');
        const availability = el.querySelector('[data-availability]');
        const errBox = el.querySelector('[data-err]');

        async function loadAvailability() {
          const store = stores.find((s) => String(s.id) === String(storeSelect.value));
          binSelect.innerHTML = `<option value="">\u2014 Any bin \u2014</option>${(store?.bins || []).map((b) => `<option value="${b.id}">${esc(b.name)} (${esc(b.code)})</option>`).join('')}`;
          if (!store) { availability.textContent = 'Select a store to see available stock.'; return; }
          availability.innerHTML = 'Loading stock\u2026';
          try {
            const res = await api.get(`/api/procurement/stock/balances?storeId=${store.id}&pageSize=200`);
            const balances = res.balances || [];
            availability.innerHTML = `<table class="tbl" style="margin-top:4px"><thead><tr><th>Item</th><th class="num">Available</th></tr></thead><tbody>${
              detail.items.map((line) => {
                const available = balances.filter((b) => b.itemId === line.itemId).reduce((sum, b) => sum + b.quantity, 0);
                return `<tr><td>${esc(line.itemName)}</td><td class="num">${available >= line.quantity ? '<span class="badge active">' : '<span class="badge rejected">'}${num(available)}</span> <span class="small muted">of ${num(line.quantity)}</span></td></tr>`;
              }).join('')
            }</tbody></table>`;
          } catch (e) {
            availability.textContent = e.message;
          }
        }

        storeSelect.addEventListener('change', loadAvailability);
        decision.addEventListener('change', () => {
          availability.style.display = decision.value === 'available' ? '' : 'none';
        });
        loadAvailability();

        el.querySelector('[data-confirm]').addEventListener('click', async () => {
          errBox.classList.add('hidden');
          if (!storeSelect.value) {
            errBox.textContent = 'Select a store.';
            errBox.classList.remove('hidden');
            return;
          }
          try {
            const res = await api.post(`/api/procurement/requisitions/${id}/verify`, {
              storeId: storeSelect.value,
              binId: binSelect.value || null,
              decision: decision.value,
              remarks: el.querySelector('[data-remarks]').value.trim(),
            });
            close();
            toast(res.status === 'issued' ? 'Stock verified and issued.' : 'Requisition moved to sourcing.');
            await refresh();
          } catch (e) {
            errBox.textContent = e.message;
            errBox.classList.remove('hidden');
          }
        });
      },
    });
    void m;
  });
}
