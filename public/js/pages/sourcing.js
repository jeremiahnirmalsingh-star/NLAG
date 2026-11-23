import { api } from '../api.js';
import { can, state } from '../state.js';
import { navigate, withQuery } from '../router.js';
import {
  esc, icon, money, num, statusBadge, emptyState, toast, field, modal, confirmDialog, actionDialog, fmtDate,
  roundRupee, roundOffAmount, roundOffControl, syncRoundOffInput, bindRoundOffControl,
} from '../ui.js';

const REQUIREMENT_LABEL = { consumable: 'Consumable', asset: 'Asset', service: 'Service' };
const RFQ_STATUS = { draft: 'Draft', issued: 'Issued', closed: 'Closed', cancelled: 'Cancelled' };
const QUOTE_STATUS = {
  received: 'Received', shortlisted: 'Shortlisted', rejected: 'Rejected', awarded: 'Awarded', withdrawn: 'Withdrawn',
};
const CS_STATUS = {
  draft: 'Draft', pending: 'Pending Approval', approved: 'Approved', rejected: 'Rejected', cancelled: 'Cancelled',
};

function statusOf(status, map) {
  return statusBadge(status, (map && map[status]) || status);
}

function typeLabel(type) {
  return REQUIREMENT_LABEL[type] || type || '\u2014';
}

function isOpenStatement(statements) {
  return (statements || []).some((s) => ['draft', 'pending'].includes(s.status));
}

function hasApprovedStatement(statements) {
  return (statements || []).some((s) => s.status === 'approved');
}

function todayInput() {
  const d = new Date();
  const offset = d.getTimezoneOffset();
  return new Date(d.getTime() - offset * 60000).toISOString().slice(0, 10);
}

const round2 = (value) => Math.round((Number(value) || 0) * 100) / 100;

function generalTermsFallback(meta = {}) {
  return meta.generalTerms
    || meta.settings?.generalTerms
    || state.generalTerms
    || state.settings?.generalTerms
    || '';
}

/* Saved lines store the applied discount; the API expects the raw flat amount. */
function rawFlatDiscount(line, quantity, unitPrice) {
  if (line.discountAmount === undefined || line.discountAmount === null || line.discountAmount === '') return undefined;
  const gross = round2(round2(quantity) * round2(unitPrice));
  const percentPart = round2((gross * round2(line.discountPercent)) / 100);
  return Math.max(0, round2(Number(line.discountAmount) - percentPart));
}

/* Mirrors the shared server tax rules: discounts first, then tax (which can be
 * back-calculated out of an inclusive price). */
function calculateLine({ quantity, unitPrice, discountPercent, discountAmount, taxRate, taxInclusive }) {
  const gross = round2(round2(quantity) * round2(unitPrice));
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

/* ================================================================== */
/* LIST                                                                */
/* ================================================================== */
export async function renderList(ctx) {
  const q = ctx.route.query || {};
  const params = new URLSearchParams();
  for (const key of ['search', 'status']) {
    if (q[key]) params.set(key, q[key]);
  }

  ctx.view.innerHTML = `<div class="empty">Loading sourcing\u2026</div>`;
  const [meta, res] = await Promise.all([
    api.get('/api/procurement/sourcing/meta'),
    api.get(`/api/procurement/rfqs?${params.toString()}`),
  ]);

  const rows = res.rfqs || [];
  const statuses = meta.statuses || [];

  ctx.view.innerHTML = `
    <div class="page-head">
      <div><h1>Sourcing</h1><div class="sub">Request for quotations, vendor offers and comparative statements</div></div>
      <div class="page-actions">
        <a class="btn" href="#/requisitions?status=sourcing">${icon('clipboard')} Awaiting sourcing</a>
        ${can('sourcing.manage') ? `<a class="btn btn-primary" href="#/sourcing/new">${icon('plus')} New RFQ</a>` : ''}
      </div>
    </div>

    <div class="card">
      <form class="toolbar" id="rfq-filters">
        <div class="search">${icon('search')}<input class="input" name="search" value="${esc(q.search || '')}" placeholder="RFQ number, title or requisition..." /></div>
        <select class="select" name="status">
          <option value="">All statuses</option>
          ${statuses.map((s) => `<option value="${esc(s.value)}" ${q.status === s.value ? 'selected' : ''}>${esc(RFQ_STATUS[s.value] || s.label)}</option>`).join('')}
        </select>
        <button class="btn btn-sm" type="submit">${icon('filter')} Apply</button>
        <button class="btn btn-sm btn-ghost" type="button" data-reset>Reset</button>
      </form>
      <div class="table-wrap">
        ${rows.length
          ? `<table class="tbl">
              <thead><tr><th>RFQ</th><th>Requirement</th><th>Source</th><th class="num">Items</th><th class="num">Vendors</th><th class="num">Quotes</th><th>Closing</th><th>Status</th><th></th></tr></thead>
              <tbody>${rows.map((r) => `<tr>
                <td><a class="strong" href="#/sourcing/${r.id}">${esc(r.rfqNo)}</a>
                  <div class="small muted">${esc(r.title)}</div></td>
                <td>${esc(typeLabel(r.requirementType))}
                  <div class="small muted">${esc(r.departmentName || r.unitName)}</div></td>
                <td class="small">${r.requisitionId ? `<a href="#/requisitions/${r.requisitionId}">${esc(r.requisitionNo)}</a>` : '<span class="muted">Direct RFQ</span>'}</td>
                <td class="num">${num(r.itemCount)}</td>
                <td class="num">${num(r.vendorCount)}</td>
                <td class="num">${num(r.quotationCount)}</td>
                <td class="small">${r.closingDate ? fmtDate(r.closingDate) : '\u2014'}</td>
                <td>${statusOf(r.status, RFQ_STATUS)}</td>
                <td class="actions"><a class="btn btn-sm btn-ghost" href="#/sourcing/${r.id}">${icon('eye')}</a></td>
              </tr>`).join('')}</tbody></table>`
          : emptyState(
              'No RFQs found',
              'Create an RFQ directly, or raise it from a requisition awaiting sourcing.',
              can('sourcing.manage') ? '<a class="btn btn-sm btn-primary" href="#/sourcing/new">New RFQ</a>' : '',
              'send'
            )}
      </div>
      <div class="small muted" style="padding:10px 14px">Showing ${num(rows.length)} of ${num(res.total)} RFQ${res.total === 1 ? '' : 's'}.</div>
    </div>`;

  const form = document.getElementById('rfq-filters');
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    navigate(withQuery('/sourcing', Object.fromEntries(new FormData(form).entries())));
  });
  form.querySelector('[data-reset]').addEventListener('click', () => navigate('/sourcing'));
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

function lineRow(items, line = {}) {
  const freeName = line.itemId ? '' : (line.itemName || '');
  const isOther = !line.itemId && !!freeName;
  return `<tr data-line data-req-item="${esc(line.requisitionItemId || '')}">
    <td style="min-width:260px">
      <select class="select" data-item>${itemOptions(items, isOther ? '__other__' : line.itemId)}</select>
      <input class="input${isOther ? '' : ' hidden'}" data-item-name value="${esc(freeName)}" maxlength="200" placeholder="Type the item name" style="margin-top:6px" />
    </td>
    <td style="min-width:180px"><input class="input" data-desc value="${esc(line.description || '')}" placeholder="Description / specification" /></td>
    <td class="num" style="width:120px;min-width:120px"><input class="input" data-qty type="number" min="0.01" step="0.01" inputmode="decimal" value="${line.quantity !== undefined ? esc(line.quantity) : '1'}" style="text-align:right" /></td>
    <td class="num" style="width:160px;min-width:160px"><input class="input" data-cost type="number" min="0" step="0.01" inputmode="decimal" value="${line.estimatedUnitCost !== undefined ? esc(line.estimatedUnitCost) : ''}" style="text-align:right" /></td>
    <td class="num" data-total>${money(line.estimatedUnitCost && line.quantity ? Number(line.quantity) * Number(line.estimatedUnitCost) : 0)}</td>
    <td class="actions"><button class="btn btn-sm btn-ghost" type="button" data-remove title="Remove line">${icon('trash')}</button></td>
  </tr>`;
}

function readLines(form) {
  const lines = [];
  form.querySelectorAll('[data-line]').forEach((row) => {
    const rawItem = row.querySelector('[data-item]').value;
    const itemId = rawItem === '__other__' ? '' : rawItem;
    const itemName = row.querySelector('[data-item-name]').value.trim();
    const description = row.querySelector('[data-desc]').value.trim();
    if (!itemId && !itemName && !description) return;
    const reqItem = row.dataset.reqItem;
    lines.push({
      itemId,
      itemName,
      requisitionItemId: reqItem || null,
      description,
      quantity: row.querySelector('[data-qty]').value,
      estimatedUnitCost: row.querySelector('[data-cost]').value,
    });
  });
  return lines;
}

function bindLine(row, form, itemList) {
  const tbody = form.querySelector('#rfq-lines tbody');
  row.querySelector('[data-item]').addEventListener('change', () => {
    const select = row.querySelector('[data-item]');
    const nameInput = row.querySelector('[data-item-name]');
    const isOther = select.value === '__other__';
    nameInput.classList.toggle('hidden', !isOther);
    if (isOther) {
      nameInput.focus();
      recalcForm(form);
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
    recalcForm(form);
  });
  row.querySelector('[data-qty]').addEventListener('input', () => recalcForm(form));
  row.querySelector('[data-cost]').addEventListener('input', () => recalcForm(form));
  row.querySelector('[data-remove]').addEventListener('click', () => {
    if (tbody.querySelectorAll('[data-line]').length === 1) {
      toast('An RFQ needs at least one line.', 'error');
      return;
    }
    row.remove();
    recalcForm(form);
  });
}

function recalcForm(form) {
  let grand = 0;
  form.querySelectorAll('[data-line]').forEach((row) => {
    const qty = Number(row.querySelector('[data-qty]').value) || 0;
    const cost = Number(row.querySelector('[data-cost]').value) || 0;
    const total = Math.round(qty * cost * 100) / 100;
    grand += total;
    row.querySelector('[data-total]').textContent = money(total);
  });
  form.querySelector('[data-grand-total]').textContent = money(Math.round(grand * 100) / 100);
}

export async function renderForm(ctx, options = {}) {
  const id = options.id ? Number(options.id) : null;
  ctx.view.innerHTML = `<div class="empty">Loading RFQ\u2026</div>`;

  let reqMeta = { items: [], units: [], departments: [] };
  const [meta] = await Promise.all([
    api.get('/api/procurement/sourcing/meta'),
    api.get('/api/procurement/requisitions/meta').then((m) => { reqMeta = m; }).catch(() => {}),
  ]);

  let detail = null;
  let rfq = null;
  let rfqItems = [];
  let invited = [];
  if (id) {
    detail = await api.get(`/api/procurement/rfqs/${id}`);
    rfq = detail.rfq;
    rfqItems = detail.items || [];
    invited = detail.vendors || [];
    if (rfq.status !== 'draft') throw new Error('Only draft RFQs can be edited.');
  }

  const units = (reqMeta.units && reqMeta.units.length ? reqMeta.units : meta.units) || [];
  const departments = (reqMeta.departments && reqMeta.departments.length ? reqMeta.departments : meta.departments) || [];
  const itemList = reqMeta.items || [];
  const selectedUnit = rfq ? rfq.unitId : (units.length === 1 ? units[0].id : '');
  const initialLines = rfqItems.length ? rfqItems : [{ quantity: 1 }];
  const selectedVendors = new Set(invited.map((v) => Number(v.vendorId)));
  const rfqGeneralTerms = rfq?.generalTerms || generalTermsFallback(meta);

  ctx.view.innerHTML = `
    <div class="page-head">
      <div><h1>${id ? 'Edit RFQ' : 'New RFQ'}</h1>
        <div class="sub">${id ? `${esc(rfq.rfqNo)} \u00b7 ${esc(rfq.status)}` : 'Invite vendors to quote for goods or services'}</div></div>
      <div class="page-actions">
        <a class="btn" href="${id ? `#/sourcing/${id}` : '#/sourcing'}">${icon('arrowLeft')} Cancel</a>
        <button class="btn btn-primary" type="button" data-save>${icon('check')} ${id ? 'Save changes' : 'Create RFQ'}</button>
      </div>
    </div>
    <div id="rfq-alert" class="alert alert-danger hidden"></div>

    <form id="rfq-form" autocomplete="off">
      <div class="grid grid-2" style="align-items:start">
        <div class="stack">
          <div class="card">
            <div class="card-head"><div><h3>Requirement</h3><div class="sub">What is being sourced and for whom</div></div></div>
            <div class="form-section">
              <div class="form-grid">
                ${!id ? `<div class="field">
                  <label>Requisition <span class="hint">Optional</span></label>
                  <select class="select" name="requisitionId" data-requisition>
                    <option value="">\u2014 Direct RFQ \u2014</option>
                    ${(meta.requisitions || []).map((r) => `<option value="${r.id}">${esc(r.requisitionNo)} \u00b7 ${esc(typeLabel(r.requirementType))} \u00b7 ${money(r.estimatedTotal)}</option>`).join('')}
                  </select>
                  <div class="hint">Selecting a requisition copies its items and department.</div>
                  <div class="hint hidden" data-req-vendor style="margin-top:4px"></div>
                </div>` : ''}
                ${field({ label: 'Unit', name: 'unitId', type: 'select', required: true, value: selectedUnit, options: units.map((u) => ({ value: u.id, label: u.name })) })}
                ${field({ label: 'Department', name: 'departmentId', type: 'select', value: rfq?.departmentId || '', options: [{ value: '', label: '\u2014 No department \u2014' }, ...departments.map((d) => ({ value: d.id, label: d.code ? `${d.code} · ${d.name}` : d.name }))] })}
                ${field({ label: 'Requirement Type', name: 'requirementType', type: 'select', required: true, value: rfq?.requirementType || 'consumable', options: (meta.requirementTypes || []).map((t) => ({ value: t.value, label: REQUIREMENT_LABEL[t.value] || t.label })) })}
                ${field({ label: 'Closing Date', name: 'closingDate', type: 'date', value: rfq?.closingDate || '' })}
                ${field({ label: 'RFQ Title', name: 'title', required: true, span: true, value: rfq?.title || '', placeholder: 'Short title for this sourcing exercise' })}
                ${field({ label: 'Purpose', name: 'purpose', type: 'textarea', span: true, value: rfq?.purpose || '', placeholder: 'Why is this requirement being sourced?' })}
              </div>
            </div>
          </div>

          <div class="card">
            <div class="card-head"><div><h3>Items</h3><div class="sub">Quantities and estimated cost shared with vendors</div></div>
              <button class="btn btn-sm" type="button" data-add-line>${icon('plus')} Add line</button></div>
            <div class="table-wrap">
              <table class="tbl" id="rfq-lines">
                <thead><tr><th style="min-width:260px">Item</th><th style="min-width:180px">Description</th><th class="num" style="width:120px;min-width:120px">Qty</th><th class="num" style="width:160px;min-width:160px">Est. Cost</th><th class="num" style="min-width:120px">Estimated</th><th style="width:56px"></th></tr></thead>
                <tbody>${initialLines.map((line) => lineRow(itemList, line)).join('')}</tbody>
              </table>
            </div>
            <div class="row" style="justify-content:flex-end;padding:12px 14px;border-top:1px solid var(--border)">
              <div style="text-align:right"><div class="small muted">Estimated total</div><div class="strong" data-grand-total>${money(0)}</div></div>
            </div>
          </div>

          <div class="card">
            <div class="card-head"><div><h3>Terms</h3><div class="sub">Commercial terms included with the RFQ</div></div></div>
            <div class="form-section">
              ${field({ label: 'Terms & conditions', name: 'terms', type: 'textarea', value: rfq?.terms || '', placeholder: 'Delivery, payment, warranty or evaluation terms...' })}
              ${field({ label: 'General terms', name: 'generalTerms', type: 'textarea', value: rfqGeneralTerms, placeholder: 'Terms inherited by quotations and purchase orders' })}
            </div>
          </div>
        </div>

        <div class="stack">
          <div class="card">
            <div class="card-head"><div><h3>Invited Vendors</h3><div class="sub">Only invited vendors can quote</div></div>
              <span class="chip ${selectedVendors.size ? 'teal' : 'gray'}">${selectedVendors.size} selected</span></div>
            <div class="form-section">
              ${(meta.vendors || []).length
                ? `<div class="stack" style="gap:2px">${meta.vendors.map((v) => `<label class="row" style="gap:8px;align-items:center;padding:5px 0;font-size:13px">
                    <input type="checkbox" data-vendor value="${v.id}" ${selectedVendors.has(Number(v.id)) ? 'checked' : ''} />
                    <span style="flex:1">${esc(v.name)}<span class="small muted mono"> ${esc(v.code)}</span></span>
                    <span class="chip gray">${esc(v.status || '')}</span>
                  </label>`).join('')}</div>`
                : '<div class="hint">No vendors are available yet. Add vendors under Masters \u203a Vendors.</div>'}
            </div>
          </div>
          <div class="card">
            <div class="card-head"><div><h3>Next Steps</h3><div class="sub">Draft, issue, then collect quotations</div></div></div>
            <div class="form-section">
              <div class="hint">Save the RFQ as a draft, add vendors and items, then issue it. Quotations and the comparative statement are recorded from the RFQ detail page.</div>
            </div>
          </div>
        </div>
      </div>
    </form>`;

  const form = document.getElementById('rfq-form');
  const alertBox = document.getElementById('rfq-alert');
  const tbody = form.querySelector('#rfq-lines tbody');

  tbody.querySelectorAll('[data-line]').forEach((row) => bindLine(row, form, itemList));
  recalcForm(form);

  form.querySelector('[data-add-line]').addEventListener('click', () => {
    tbody.insertAdjacentHTML('beforeend', lineRow(itemList));
    bindLine(tbody.querySelector('[data-line]:last-child'), form, itemList);
    recalcForm(form);
  });

  function showError(message) {
    alertBox.innerHTML = `${icon('alert')} ${esc(message)}`;
    alertBox.classList.remove('hidden');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  const reqSelect = form.querySelector('[data-requisition]');
  reqSelect?.addEventListener('change', async () => {
    const reqId = reqSelect.value;
    if (!reqId) return;
    try {
      const d = await api.get(`/api/procurement/requisitions/${reqId}`);
      const r = d.requisition;
      form.unitId.value = r.unitId;
      form.departmentId.value = r.departmentId || '';
      form.requirementType.value = r.requirementType;
      if (!form.title.value.trim()) form.title.value = `Sourcing for ${r.requisitionNo}`;
      if (!form.purpose.value.trim()) form.purpose.value = r.purpose || '';
      const vendorHint = form.querySelector('[data-req-vendor]');
      if (vendorHint) {
        const bits = [
          r.suggestedVendorContact,
          r.suggestedVendorMobile,
          r.suggestedVendorEmail,
        ].filter(Boolean);
        vendorHint.textContent = r.suggestedVendorName
          ? `Suggested by requester: ${r.suggestedVendorName}${bits.length ? ` \u00b7 ${bits.join(' \u00b7 ')}` : ''}`
          : '';
        vendorHint.classList.toggle('hidden', !r.suggestedVendorName);
      }
      tbody.innerHTML = d.items.map((line) => lineRow(itemList, {
        itemId: line.itemId,
        itemName: line.itemId ? '' : line.itemName,
        description: line.description,
        quantity: line.quantity,
        estimatedUnitCost: line.estimatedUnitCost,
        requisitionItemId: line.id,
      })).join('');
      tbody.querySelectorAll('[data-line]').forEach((row) => bindLine(row, form, itemList));
      recalcForm(form);
    } catch (e) {
      toast(e.message, 'error');
    }
  });

  function payload() {
    const lines = readLines(form);
    if (!lines.length) throw new Error('Add at least one item.');
    if (lines.some((l) => !l.itemId && !l.itemName)) throw new Error('Select an item or type an item name on every line.');
    const vendors = [...form.querySelectorAll('[data-vendor]:checked')].map((el) => el.value);
    return {
      requisitionId: reqSelect?.value || null,
      unitId: form.unitId.value,
      departmentId: form.departmentId.value || null,
      requirementType: form.requirementType.value,
      closingDate: form.closingDate.value || null,
      title: form.title.value.trim(),
      purpose: form.purpose.value.trim(),
      terms: form.terms.value.trim(),
      generalTerms: form.generalTerms.value.trim(),
      items: lines,
      vendorIds: vendors,
    };
  }

  ctx.view.querySelector('[data-save]').addEventListener('click', async () => {
    alertBox.classList.add('hidden');
    let data;
    try {
      data = payload();
    } catch (e) {
      return showError(e.message);
    }
    if (!data.title) return showError('RFQ title is required.');
    try {
      let savedId = id;
      if (id) {
        await api.put(`/api/procurement/rfqs/${id}`, data);
        toast('RFQ updated.');
      } else {
        const res = await api.post('/api/procurement/rfqs', data);
        savedId = res.id;
        toast('RFQ created as draft.');
      }
      navigate(`/sourcing/${savedId}`);
    } catch (e) {
      showError(e.message || 'Unable to save the RFQ.');
    }
  });
}

/* ================================================================== */
/* QUOTATION DIALOG                                                    */
/* ================================================================== */
function quotationModal({ rfq, items, vendors, quotations, existing, onDone }) {
  const invited = vendors.filter((v) => v.status !== 'withdrawn');
  const quoted = new Set((quotations || []).map((q) => Number(q.vendorId)));
  const vendorOptions = existing
    ? invited.filter((v) => Number(v.vendorId) === Number(existing.quotation.vendorId))
    : invited.filter((v) => !quoted.has(Number(v.vendorId)));
  if (!existing && !vendorOptions.length) {
    toast('Every invited vendor has already quoted, or no vendor is invited.', 'error');
    return;
  }

  const existingLines = new Map((existing?.items || []).map((line) => [Number(line.rfqItemId), line]));
  const quoteGeneralTerms = existing?.quotation.generalTerms || rfq.generalTerms || generalTermsFallback();
  const itemRows = items.map((line) => {
    const prior = existingLines.get(Number(line.id));
    const flatDiscount = prior ? rawFlatDiscount(prior, prior.quantity, prior.unitPrice) : undefined;
    const calc = calculateLine({
      quantity: prior ? prior.quantity : line.quantity,
      unitPrice: prior ? prior.unitPrice : 0,
      discountPercent: prior ? prior.discountPercent : 0,
      discountAmount: flatDiscount,
      taxRate: prior ? prior.taxRate : 0,
      taxInclusive: prior ? prior.taxInclusive : false,
    });
    return `<tr data-qline data-rfq-item="${line.id}" data-item-id="${esc(line.itemId || '')}" data-tax-known="${prior ? '1' : ''}">
      <td><span class="strong">${esc(line.itemName)}</span>
        <div class="small muted mono">${esc(line.itemCode)} \u00b7 ${esc(line.uomCode)}</div></td>
      <td><input class="input" data-qqty type="number" min="0.01" step="0.01" value="${esc(prior ? prior.quantity : line.quantity)}" /></td>
      <td><input class="input" data-qprice type="number" min="0" step="0.01" value="${prior ? esc(prior.unitPrice) : ''}" /></td>
      <td><input class="input" data-qdiscpct type="number" min="0" max="100" step="0.01" value="${prior ? esc(prior.discountPercent ?? 0) : '0'}" /></td>
      <td><input class="input" data-qdisamt type="number" min="0" step="0.01" value="${prior ? esc(flatDiscount ?? 0) : '0'}" /></td>
      <td><input class="input" data-qtax type="number" min="0" max="100" step="0.01" value="${prior ? esc(prior.taxRate ?? 0) : '0'}" /></td>
      <td style="text-align:center"><label class="row" style="gap:4px;justify-content:center;font-size:12px"><input type="checkbox" data-qinclusive ${prior?.taxInclusive ? 'checked' : ''} /> Incl.</label></td>
      <td class="num" style="min-width:130px">
        <div class="strong" data-qtotal>${money(prior ? prior.totalAmount : 0)}</div>
        <div class="small muted" data-qbreak>Taxable ${money(prior ? prior.taxableAmount || 0 : calc.taxableAmount)} \u00b7 Tax ${money(prior ? prior.taxAmount || 0 : calc.taxAmount)}</div>
      </td>
    </tr>`;
  }).join('');

  const m = modal({
    title: existing ? `Edit quotation ${existing.quotation.quotationNo}` : 'Record vendor quotation',
    subtitle: `${rfq.rfqNo} \u00b7 ${rfq.title}`,
    size: 'lg',
    body: `
      <div class="form-grid">
        <div class="field"><label>Vendor<span class="req">*</span></label>
          <select class="select" data-vendor ${existing ? 'disabled' : ''}>
            ${existing ? '' : '<option value="">\u2014 Select vendor \u2014</option>'}
            ${vendorOptions.map((v) => `<option value="${v.vendorId}" ${existing ? 'selected' : ''}>${esc(v.vendorName)} (${esc(v.vendorCode)})</option>`).join('')}
          </select>
        </div>
        <div class="field"><label>Quotation date</label><input class="input" type="date" data-qdate value="${esc(existing?.quotation.quotationDate || todayInput())}" /></div>
        <div class="field"><label>Valid until</label><input class="input" type="date" data-qvalid value="${esc(existing?.quotation.validUntil || '')}" /></div>
        <div class="field"><label>Delivery days</label><input class="input" type="number" min="0" data-qdays value="${esc(existing?.quotation.deliveryDays ?? 0)}" /></div>
        <div class="field"><label>Header discount %</label><input class="input" type="number" min="0" max="100" step="0.01" data-qhdiscpct value="${esc(existing?.quotation.discountPercent ?? 0)}" /></div>
        <div class="field"><label>Header flat discount</label><input class="input" type="number" min="0" step="0.01" data-qhdiscamt value="${esc(existing?.quotation.discountAmount ?? 0)}" /></div>
        <div class="field span-2"><label>Payment terms</label><input class="input" data-qpayment value="${esc(existing?.quotation.paymentTerms || '')}" placeholder="e.g. 30 days from invoice" /></div>
        <div class="field span-2"><label>Warranty / remarks</label><textarea class="textarea" data-qremarks rows="2">${esc(existing?.quotation.remarks || '')}</textarea></div>
        <div class="field span-2"><label>General terms</label><textarea class="textarea" data-qterms rows="3">${esc(quoteGeneralTerms)}</textarea>
          <div class="hint">Copied from the RFQ; passed on to the purchase order.</div></div>
      </div>
      <div class="table-wrap" style="margin-top:8px">
        <table class="tbl">
          <thead><tr><th>Item</th><th style="width:90px">Qty</th><th style="width:110px">Unit Price</th><th style="width:80px">Disc %</th><th style="width:90px">Flat disc</th><th style="width:80px">Tax %</th><th style="width:76px">Incl. tax</th><th class="num" style="min-width:130px">Total</th></tr></thead>
          <tbody>${itemRows}</tbody>
        </table>
      </div>
      <div class="row" style="justify-content:space-between;gap:12px;margin-top:10px">
        <div class="small muted">Line total after tax <b data-qline-total>${money(0)}</b></div>
        <div class="small muted">Header discount <b data-qheader-discount>${money(0)}</b></div>
        ${roundOffControl({ value: existing?.quotation.roundOff ?? 0 })}
        <div style="text-align:right"><div class="small muted">Total before round off</div><div class="strong" data-quote-total>${money(0)}</div>
          <div class="small muted">Total (rounded)</div><div class="strong" data-q-final>${money(0)}</div></div>
      </div>
      <div class="alert alert-danger hidden" data-err style="margin-top:10px"></div>`,
    footer: `<button class="btn" data-modal-close>Cancel</button>
             <button class="btn btn-primary" data-save>${existing ? 'Save quotation' : 'Record quotation'}</button>`,
    onMount(el, close) {
      const errBox = el.querySelector('[data-err]');
      el.dataset.savedRoundOff = existing?.quotation.roundOff ?? '';
      const hdPct = el.querySelector('[data-qhdiscpct]');
      const hdAmt = el.querySelector('[data-qhdiscamt]');
      let quoteTotals = { total: 0 };

      function recalc() {
        let linesTotal = 0;
        el.querySelectorAll('[data-qline]').forEach((row) => {
          const calc = calculateLine({
            quantity: row.querySelector('[data-qqty]').value,
            unitPrice: row.querySelector('[data-qprice]').value,
            discountPercent: row.querySelector('[data-qdiscpct]').value,
            discountAmount: row.querySelector('[data-qdisamt]').value,
            taxRate: row.querySelector('[data-qtax]').value,
            taxInclusive: row.querySelector('[data-qinclusive]').checked,
          });
          linesTotal += calc.totalAmount;
          row.querySelector('[data-qtotal]').textContent = money(calc.totalAmount);
          row.querySelector('[data-qbreak]').textContent = `Taxable ${money(calc.taxableAmount)} \u00b7 Tax ${money(calc.taxAmount)}`;
        });
        const header = calculateHeader(linesTotal, hdPct.value, hdAmt.value);
        const roundOff = syncRoundOffInput(
          el.querySelector('[name="roundOff"]'), header.total, el.dataset.savedRoundOff
        );
        const finalTotal = round2(header.total + roundOff);
        quoteTotals = { ...header, roundOff, final: finalTotal };
        el.querySelector('[data-qline-total]').textContent = money(linesTotal);
        el.querySelector('[data-qheader-discount]').textContent = money(header.discountAmount);
        el.querySelector('[data-quote-total]').textContent = money(header.total);
        el.querySelector('[data-q-final]').textContent = money(finalTotal);
      }
      el.querySelectorAll('input[type=number]').forEach((input) => {
        if (input.name !== 'roundOff') input.addEventListener('input', recalc);
      });
      ['[data-qdiscpct]', '[data-qdisamt]', '[data-qtax]'].forEach((selector) => {
        el.querySelectorAll(selector).forEach((input) => input.addEventListener('input', () => {
          input.dataset.overridden = '1';
        }));
      });
      el.querySelectorAll('[data-qinclusive]').forEach((input) => {
        input.addEventListener('change', () => {
          input.dataset.overridden = '1';
          recalc();
        });
      });
      recalc();
      bindRoundOffControl(el, recalc);

      /* New lines pick up item defaults; saved quotation values are left alone. */
      const defaultsCache = new Map();
      Promise.all([...el.querySelectorAll('[data-qline]')].map(async (row) => {
        if (existingLines.has(Number(row.dataset.rfqItem))) return;
        const itemId = row.dataset.itemId;
        if (!itemId) return;
        if (!defaultsCache.has(itemId)) {
          defaultsCache.set(itemId, api.get(`/api/procurement/items/${itemId}`)
            .then((res) => (res && (res.item?.details || res.details)) || null)
            .catch(() => null));
        }
        const defaults = await defaultsCache.get(itemId);
        if (!defaults) return;
        const set = (selector, value) => {
          const input = row.querySelector(selector);
          if (input && input.dataset.overridden !== '1' && value !== undefined && value !== null && value !== '') {
            input.value = value;
          }
        };
        set('[data-qdiscpct]', defaults.defaultDiscountPercent ?? 0);
        set('[data-qdisamt]', defaults.defaultDiscountAmount ?? 0);
        set('[data-qtax]', defaults.taxRate ?? defaults.gstRate ?? 0);
        const inclusive = row.querySelector('[data-qinclusive]');
        if (inclusive && inclusive.dataset.overridden !== '1' && defaults.taxInclusive !== undefined) {
          inclusive.checked = !!defaults.taxInclusive;
        }
        row.dataset.defaultsApplied = '1';
        recalc();
      })).catch(() => {});

      el.querySelector('[data-save]').addEventListener('click', async () => {
        errBox.classList.add('hidden');
        const vendorId = existing ? existing.quotation.vendorId : el.querySelector('[data-vendor]').value;
        if (!vendorId) {
          errBox.textContent = 'Select the quoting vendor.';
          errBox.classList.remove('hidden');
          return;
        }
        const lines = [];
        let invalid = false;
        el.querySelectorAll('[data-qline]').forEach((row) => {
          const unitPrice = row.querySelector('[data-qprice]').value;
          if (unitPrice === '' || Number(unitPrice) < 0) invalid = true;
          const discPctInput = row.querySelector('[data-qdiscpct]');
          const disAmtInput = row.querySelector('[data-qdisamt]');
          const taxInput = row.querySelector('[data-qtax]');
          const inclusiveInput = row.querySelector('[data-qinclusive]');
          const includeAll = row.dataset.taxKnown === '1' || row.dataset.defaultsApplied === '1';
          const line = {
            rfqItemId: row.dataset.rfqItem,
            quantity: row.querySelector('[data-qqty]').value,
            unitPrice,
          };
          if (includeAll || discPctInput.dataset.overridden === '1') line.discountPercent = discPctInput.value;
          if (includeAll || disAmtInput.dataset.overridden === '1') line.discountAmount = disAmtInput.value;
          if (includeAll || taxInput.dataset.overridden === '1') line.taxRate = taxInput.value;
          if (includeAll || inclusiveInput.dataset.overridden === '1') line.taxInclusive = inclusiveInput.checked;
          lines.push(line);
        });
        if (invalid) {
          errBox.textContent = 'Enter a unit price for every line.';
          errBox.classList.remove('hidden');
          return;
        }
        const body = {
          vendorId,
          discountPercent: hdPct.value,
          discountAmount: hdAmt.value,
          quotationDate: el.querySelector('[data-qdate]').value || null,
          validUntil: el.querySelector('[data-qvalid]').value || null,
          deliveryDays: el.querySelector('[data-qdays]').value,
          paymentTerms: el.querySelector('[data-qpayment]').value.trim(),
          remarks: el.querySelector('[data-qremarks]').value.trim(),
          generalTerms: el.querySelector('[data-qterms]').value.trim(),
          roundOff: quoteTotals.roundOff,
          items: lines,
        };
        try {
          if (existing) {
            await api.put(`/api/procurement/quotations/${existing.quotation.id}`, body);
            toast('Quotation updated.');
          } else {
            await api.post(`/api/procurement/rfqs/${rfq.id}/quotations`, body);
            toast('Quotation recorded.');
          }
          close();
          await onDone();
        } catch (e) {
          errBox.textContent = e.message;
          errBox.classList.remove('hidden');
        }
      });
    },
  });
  void m;
}

/* ================================================================== */
/* DETAIL                                                              */
/* ================================================================== */
export async function renderDetail(ctx, options = {}) {
  const id = Number(options.id);
  ctx.view.innerHTML = `<div class="empty">Loading RFQ\u2026</div>`;
  const detail = await api.get(`/api/procurement/rfqs/${id}`);
  const r = detail.rfq;
  const actions = detail.actions || {};
  const statements = detail.comparativeStatements || [];
  const openStatement = isOpenStatement(statements);
  const approvedStatement = statements.find((s) => s.status === 'approved');
  let matrix = null;
  if ((detail.quotations || []).length) {
    try {
      matrix = await api.get(`/api/procurement/rfqs/${id}/comparative`);
    } catch {
      matrix = null;
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

  const quotations = detail.quotations || [];
  const vendors = detail.vendors || [];
  const quoteColumns = quotations.map((q) => `<th class="num">${esc(q.vendorName)}<div class="small muted mono">${esc(q.quotationNo)}</div></th>`).join('');
  const matrixRows = matrix
    ? matrix.lines.map((line) => `<tr>
        <td><span class="strong">${esc(line.itemName)}</span><div class="small muted mono">${esc(line.itemCode)}</div></td>
        <td class="num">${num(line.quantity)} <span class="small muted">${esc(line.uomCode)}</span></td>
        ${line.offers.map((offer) => `<td class="num">${offer.quoted
          ? `${money(offer.unitPrice)}<div class="small muted">${money(offer.totalAmount)}</div>`
          : '<span class="muted">\u2014</span>'}</td>`).join('')}
      </tr>`).join('')
    : '';

  ctx.view.innerHTML = `
    <div class="page-head">
      <div><h1>${esc(r.rfqNo)}</h1>
        <div class="sub">${esc(r.title)} \u00b7 ${esc(r.unitName)}${r.departmentName ? ` \u00b7 ${esc(r.departmentName)}` : ''}</div></div>
      <div class="page-actions">
        <a class="btn" href="#/sourcing">${icon('arrowLeft')} Back</a>
        ${actions.canEdit ? `<a class="btn" href="#/sourcing/${r.id}/edit">${icon('edit')} Edit</a>` : ''}
        ${actions.canIssue ? `<button class="btn btn-primary" type="button" data-issue>${icon('send')} Issue RFQ</button>` : ''}
        ${actions.canQuote ? `<button class="btn btn-primary" type="button" data-quote>${icon('plus')} Record Quotation</button>` : ''}
        ${actions.canCompare && !openStatement && !hasApprovedStatement(statements) ? `<button class="btn" type="button" data-compare>${icon('checkSquare')} Prepare Comparative</button>` : ''}
        ${actions.canCreatePurchaseOrder && approvedStatement ? `<button class="btn btn-primary" type="button" data-create-po>${icon('briefcase')} Create PO</button>` : ''}
        ${actions.canClose ? `<button class="btn" type="button" data-close>${icon('lock')} Close</button>` : ''}
        ${actions.canCancel ? `<button class="btn btn-danger" type="button" data-cancel>${icon('xCircle')} Cancel</button>` : ''}
        ${actions.canDelete ? `<button class="btn btn-danger" type="button" data-delete>${icon('trash')} Delete</button>` : ''}
      </div>
    </div>

    <div class="grid grid-4 mb-16">
      <div class="card"><div class="kpi"><div class="chip gray">${icon('send')}</div><div><div class="label">Status</div><div class="value small-value">${statusOf(r.status, RFQ_STATUS)}</div><div class="meta">${r.issuedAt ? `Issued ${fmtDate(r.issuedAt)}` : 'Not issued'}</div></div></div></div>
      <div class="card"><div class="kpi"><div class="chip blue">${icon('layers')}</div><div><div class="label">Requirement</div><div class="value small-value">${esc(typeLabel(r.requirementType))}</div><div class="meta">${num(r.itemCount)} item${r.itemCount === 1 ? '' : 's'}</div></div></div></div>
      <div class="card"><div class="kpi"><div class="chip amber">${icon('briefcase')}</div><div><div class="label">Vendors invited</div><div class="value small-value">${num(r.vendorCount)}</div><div class="meta">${num(r.quotationCount)} quotation${r.quotationCount === 1 ? '' : 's'}</div></div></div></div>
      <div class="card"><div class="kpi"><div class="chip teal">${icon('calendar')}</div><div><div class="label">Closing date</div><div class="value small-value">${r.closingDate ? esc(fmtDate(r.closingDate)) : '\u2014'}</div><div class="meta">${r.requisitionId ? `From ${esc(r.requisitionNo)}` : 'Direct RFQ'}</div></div></div></div>
    </div>

    <div class="grid grid-2" style="align-items:start">
      <div class="stack">
        <div class="card">
          <div class="card-head"><div><h3>RFQ Items</h3><div class="sub">Requested quantities and estimated cost</div></div></div>
          <div class="table-wrap">
            <table class="tbl">
              <thead><tr><th>Item</th><th>Description</th><th class="num">Qty</th><th class="num">Est. Cost</th><th class="num">Estimated</th></tr></thead>
              <tbody>${detail.items.map((line) => `<tr>
                <td><span class="strong">${esc(line.itemName)}</span>${line.itemCode
                  ? `<div class="small muted mono">${esc(line.itemCode)}</div>`
                  : '<div class="small muted">Not in item master</div>'}</td>
                <td class="small">${esc(line.description && line.description !== line.itemName ? line.description : '\u2014')}</td>
                <td class="num">${num(line.quantity)} <span class="small muted">${esc(line.uomCode)}</span></td>
                <td class="num">${money(line.estimatedUnitCost)}</td>
                <td class="num">${money(line.quantity * line.estimatedUnitCost)}</td>
              </tr>`).join('')}</tbody>
            </table>
          </div>
        </div>

        ${matrix ? `<div class="card">
          <div class="card-head"><div><h3>Comparative Matrix</h3><div class="sub">Unit price and line total from each vendor</div></div></div>
          <div class="table-wrap">
            <table class="tbl">
              <thead><tr><th>Item</th><th class="num">Qty</th>${quoteColumns}</tr></thead>
              <tbody>${matrixRows}</tbody>
            </table>
          </div>
          <div class="small muted" style="padding:10px 14px">Lowest quotation: ${matrix.lowestQuotationId
            ? `<b>${esc((quotations.find((q) => q.id === matrix.lowestQuotationId) || {}).vendorName || '')}</b> \u00b7 ${money((quotations.find((q) => q.id === matrix.lowestQuotationId) || {}).totalAmount || 0)}`
            : '\u2014'}</div>
        </div>` : ''}

        <div class="card">
          <div class="card-head"><div><h3>Quotations</h3><div class="sub">Vendor offers recorded against this RFQ</div></div></div>
          <div class="table-wrap">
            ${quotations.length
              ? `<table class="tbl">
                  <thead><tr><th>Quotation</th><th>Vendor</th><th>Date</th><th class="num">Total</th><th>Delivery</th><th>Status</th><th></th></tr></thead>
                  <tbody>${quotations.map((q) => `<tr>
                    <td><span class="strong">${esc(q.quotationNo)}</span></td>
                    <td>${esc(q.vendorName)}<div class="small muted mono">${esc(q.vendorCode)}</div></td>
                    <td class="small">${fmtDate(q.quotationDate)}</td>
                    <td class="num">${money(q.totalAmount)}<div class="small muted">tax ${money(q.taxAmount)}</div></td>
                    <td class="small">${q.deliveryDays ? `${num(q.deliveryDays)} days` : '\u2014'}</td>
                    <td>${statusOf(q.status, QUOTE_STATUS)}</td>
                    <td class="actions">
                      <button class="btn btn-sm btn-ghost" type="button" data-view-quote="${q.id}" title="View">${icon('eye')}</button>
                      ${!openStatement && !hasApprovedStatement(statements) && q.status !== 'awarded' ? `<button class="btn btn-sm btn-ghost" type="button" data-edit-quote="${q.id}" title="Edit">${icon('edit')}</button>
                      <button class="btn btn-sm btn-ghost" type="button" data-del-quote="${q.id}" title="Delete">${icon('trash')}</button>` : ''}
                    </td>
                  </tr>`).join('')}</tbody></table>`
              : '<div class="empty small" style="padding:24px">No quotations recorded yet.</div>'}
          </div>
        </div>
      </div>

      <div class="stack">
        <div class="card">
          <div class="card-head"><div><h3>Invited Vendors</h3><div class="sub">Vendors eligible to quote</div></div>
            ${(r.status === 'draft' || r.status === 'issued') && can('sourcing.manage') ? `<button class="btn btn-sm" type="button" data-invite>${icon('plus')} Invite</button>` : ''}</div>
          <div class="table-wrap">
            ${vendors.length
              ? `<table class="tbl"><thead><tr><th>Vendor</th><th>Status</th><th></th></tr></thead><tbody>${vendors.map((v) => `<tr>
                  <td><span class="strong">${esc(v.vendorName)}</span><div class="small muted mono">${esc(v.vendorCode)}</div></td>
                  <td>${statusOf(v.status === 'responded' ? 'acknowledged' : v.status, { invited: 'Invited', responded: 'Responded', withdrawn: 'Withdrawn' })}</td>
                  <td class="actions">${r.status === 'draft' ? `<button class="btn btn-sm btn-ghost" type="button" data-uninvite="${v.vendorId}" title="Remove">${icon('x')}</button>` : ''}</td>
                </tr>`).join('')}</tbody></table>`
              : '<div class="empty small" style="padding:24px">No vendors invited yet.</div>'}
          </div>
        </div>

        <div class="card">
          <div class="card-head"><div><h3>Comparative Statements</h3><div class="sub">Recommendation and approval</div></div></div>
          <div class="form-section">
            ${statements.length
              ? `<div class="stack">${statements.map((s) => `<div style="padding:8px 0;border-bottom:1px solid var(--border)">
                  <div class="row" style="gap:8px"><span class="strong">${esc(s.csNo)}</span>${statusOf(s.status, CS_STATUS)}<span class="spacer"></span><span class="small muted">${money(s.totalQuoted)}</span></div>
                  <div class="small muted">${esc(s.recommendedVendorName || 'No recommendation')}${s.recommendedQuotationNo ? ` \u00b7 ${esc(s.recommendedQuotationNo)}` : ''}</div>
                  ${s.recommendationNotes ? `<div class="small" style="margin-top:3px">${esc(s.recommendationNotes)}</div>` : ''}
                  <div class="small muted">${s.preparedByName ? `Prepared by ${esc(s.preparedByName)}` : ''}${s.approvedByName ? ` \u00b7 approved by ${esc(s.approvedByName)}` : ''}${s.rejectionReason ? ` \u00b7 rejected: ${esc(s.rejectionReason)}` : ''}</div>
                  ${s.status === 'pending' ? `<div class="row mt-12" style="gap:6px">
                    <button class="btn btn-sm btn-primary" type="button" data-approve-cs="${s.id}">${icon('check')} Approve</button>
                    <button class="btn btn-sm btn-danger" type="button" data-reject-cs="${s.id}">${icon('x')} Reject</button>
                  </div>` : ''}
                </div>`).join('')}</div>`
              : '<div class="hint">Record quotations, then prepare a comparative statement for approval.</div>'}
          </div>
        </div>

        <div class="card">
          <div class="card-head"><div><h3>Details</h3></div></div>
          <div class="form-section">
            <div class="stack small">
              <div class="row"><span class="muted" style="width:130px">Source</span><span>${r.requisitionId ? `<a href="#/requisitions/${r.requisitionId}">${esc(r.requisitionNo)}</a>` : 'Direct RFQ'}</span></div>
              <div class="row"><span class="muted" style="width:130px">Created by</span><span>${esc(r.createdByName)} \u00b7 ${fmtDate(r.createdAt)}</span></div>
              <div class="row"><span class="muted" style="width:130px">Issued</span><span>${r.issuedAt ? fmtDate(r.issuedAt, true) : '\u2014'}</span></div>
              <div class="row"><span class="muted" style="width:130px">Closed</span><span>${r.closedAt ? fmtDate(r.closedAt, true) : '\u2014'}</span></div>
              ${r.cancelReason ? `<div class="row"><span class="muted" style="width:130px">Cancel reason</span><span>${esc(r.cancelReason)}</span></div>` : ''}
              <div class="row"><span class="muted" style="width:130px">Purpose</span><span>${esc(r.purpose || '\u2014')}</span></div>
              ${r.terms ? `<div class="row"><span class="muted" style="width:130px">Terms</span><span>${esc(r.terms)}</span></div>` : ''}
              ${r.generalTerms ? `<div class="row"><span class="muted" style="width:130px">General terms</span><span>${esc(r.generalTerms)}</span></div>` : ''}
            </div>
          </div>
        </div>
      </div>
    </div>`;

  /* ------------------------------ Actions ------------------------- */
  ctx.view.querySelector('[data-issue]')?.addEventListener('click', async () => {
    const ok = await confirmDialog({ title: 'Issue RFQ', message: 'Issue this RFQ to the invited vendors? Quotations can then be recorded.', confirmText: 'Issue RFQ' });
    if (ok) await act(() => api.post(`/api/procurement/rfqs/${id}/issue`), 'RFQ issued.');
  });

  ctx.view.querySelector('[data-close]')?.addEventListener('click', async () => {
    const ok = await confirmDialog({ title: 'Close RFQ', message: 'Close this RFQ? No further quotations can be recorded.', confirmText: 'Close RFQ' });
    if (ok) await act(() => api.post(`/api/procurement/rfqs/${id}/close`), 'RFQ closed.');
  });

  ctx.view.querySelector('[data-cancel]')?.addEventListener('click', async () => {
    const result = await actionDialog({ title: 'Cancel RFQ', subtitle: 'The RFQ remains in the audit trail.', requireComment: true, confirmText: 'Cancel RFQ', danger: true });
    if (!result) return;
    await act(() => api.post(`/api/procurement/rfqs/${id}/cancel`, { reason: result.comments }), 'RFQ cancelled.');
  });

  ctx.view.querySelector('[data-delete]')?.addEventListener('click', async () => {
    const ok = await confirmDialog({ title: 'Delete draft RFQ', message: 'Delete this draft? It is retained for audit and hidden from lists.', confirmText: 'Delete draft', danger: true });
    if (!ok) return;
    await act(async () => {
      await api.del(`/api/procurement/rfqs/${id}`);
      navigate('/sourcing');
    }, 'Draft RFQ deleted.');
  });

  ctx.view.querySelector('[data-quote]')?.addEventListener('click', () => {
    quotationModal({ rfq: r, items: detail.items, vendors, quotations, existing: null, onDone: refresh });
  });

  ctx.view.querySelector('[data-view-quote]')?.addEventListener('click', async (e) => {
    const qid = e.currentTarget.dataset.viewQuote;
    try {
      const q = await api.get(`/api/procurement/quotations/${qid}`);
      modal({
        title: q.quotation.quotationNo,
        subtitle: `${q.quotation.vendorName} \u00b7 ${fmtDate(q.quotation.quotationDate)}`,
        size: 'lg',
        body: `<div class="table-wrap"><table class="tbl">
            <thead><tr><th>Item</th><th>Description</th><th class="num">Qty</th><th class="num">Unit Price</th><th class="num">Disc</th><th class="num">Tax</th><th class="num">Total</th></tr></thead>
            <tbody>${q.items.map((line) => `<tr>
              <td>${esc(line.itemName)}<div class="small muted mono">${esc(line.itemCode)}</div>
                <div class="small muted">${line.taxInclusive ? 'incl. tax' : `tax ${num(line.taxRate)}%`}</div></td>
              <td class="small">${esc(line.description || '\u2014')}</td>
              <td class="num">${num(line.quantity)} <span class="small muted">${esc(line.uomCode)}</span></td>
              <td class="num">${money(line.unitPrice)}</td>
              <td class="num">${line.discountPercent ? `${num(line.discountPercent)}% ` : ''}${money(line.discountAmount || 0)}</td>
              <td class="num">${money(line.taxAmount)}</td>
              <td class="num">${money(line.totalAmount)}</td>
            </tr>`).join('')}</tbody></table></div>
          <div class="stack small mt-12">
            <div class="row"><span class="muted" style="width:150px">Subtotal</span><span>${money(q.quotation.subtotal)}</span></div>
            <div class="row"><span class="muted" style="width:150px">Discount</span><span>${money(q.quotation.discountAmount || 0)}${q.quotation.discountPercent ? ` (${num(q.quotation.discountPercent)}%)` : ''}</span></div>
            <div class="row"><span class="muted" style="width:150px">Tax</span><span>${money(q.quotation.taxAmount)}</span></div>
            <div class="row"><span class="muted" style="width:150px">Total before round off</span><span>${money(q.quotation.baseTotalAmount ?? round2((q.quotation.totalAmount || 0) - (q.quotation.roundOff || 0)))}</span></div>
            <div class="row"><span class="muted" style="width:150px">Round off</span><span>${money(q.quotation.roundOff || 0)}</span></div>
            <div class="row"><span class="muted" style="width:150px">Total (rounded)</span><span class="strong">${money(q.quotation.totalAmount)}</span></div>
            <div class="row"><span class="muted" style="width:150px">Payment terms</span><span>${esc(q.quotation.paymentTerms || '\u2014')}</span></div>
            <div class="row"><span class="muted" style="width:150px">Warranty</span><span>${esc(q.quotation.warrantyTerms || '\u2014')}</span></div>
            ${q.quotation.generalTerms ? `<div class="row"><span class="muted" style="width:150px">General terms</span><span>${esc(q.quotation.generalTerms)}</span></div>` : ''}
          </div>`,
        footer: '<button class="btn" data-modal-close>Close</button>',
      });
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  ctx.view.querySelector('[data-edit-quote]')?.addEventListener('click', async (e) => {
    try {
      const q = await api.get(`/api/procurement/quotations/${e.currentTarget.dataset.editQuote}`);
      quotationModal({ rfq: r, items: detail.items, vendors, quotations, existing: q, onDone: refresh });
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  ctx.view.querySelector('[data-del-quote]')?.addEventListener('click', async (e) => {
    const qid = e.currentTarget.dataset.delQuote;
    const ok = await confirmDialog({ title: 'Delete quotation', message: 'Delete this quotation? It is retained for audit and the vendor can quote again.', confirmText: 'Delete quotation', danger: true });
    if (!ok) return;
    await act(() => api.del(`/api/procurement/quotations/${qid}`), 'Quotation deleted.');
  });

  ctx.view.querySelector('[data-compare]')?.addEventListener('click', () => {
    const candidates = quotations.filter((q) => !['rejected', 'withdrawn'].includes(q.status));
    if (!candidates.length) {
      toast('No valid quotation is available for comparison.', 'error');
      return;
    }
    modal({
      title: 'Prepare comparative statement',
      subtitle: `${r.rfqNo} \u00b7 choose the recommended offer`,
      body: `<div class="field"><label>Recommended quotation<span class="req">*</span></label>
          <select class="select" data-cs-quote>
            ${candidates.map((q) => `<option value="${q.id}">${esc(q.vendorName)} \u00b7 ${esc(q.quotationNo)} \u00b7 ${money(q.totalAmount)}</option>`).join('')}
          </select></div>
        <div class="field"><label>Recommendation notes</label>
          <textarea class="textarea" data-cs-notes rows="4" placeholder="Why is this the recommended offer?"></textarea></div>
        <div class="alert alert-danger hidden" data-err></div>`,
      footer: `<button class="btn" data-modal-close>Cancel</button><button class="btn btn-primary" data-save>Send for approval</button>`,
      onMount(el, close) {
        el.querySelector('[data-save]').addEventListener('click', async () => {
          const errBox = el.querySelector('[data-err]');
          errBox.classList.add('hidden');
          try {
            await api.post(`/api/procurement/rfqs/${id}/comparative`, {
              recommendedQuotationId: el.querySelector('[data-cs-quote]').value,
              recommendationNotes: el.querySelector('[data-cs-notes]').value.trim(),
            });
            close();
            toast('Comparative statement sent for approval.');
            await refresh();
          } catch (err) {
            errBox.textContent = err.message;
            errBox.classList.remove('hidden');
          }
        });
      },
    });
  });

  ctx.view.querySelectorAll('[data-approve-cs]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const sid = btn.dataset.approveCs;
      const result = await actionDialog({ title: 'Approve comparative statement', subtitle: 'The recommended quotation will be awarded.', confirmText: 'Approve' });
      if (!result) return;
      await act(() => api.post(`/api/procurement/comparative-statements/${sid}/approve`, result), 'Comparative statement approved.');
    });
  });

  ctx.view.querySelectorAll('[data-reject-cs]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const sid = btn.dataset.rejectCs;
      const result = await actionDialog({ title: 'Reject comparative statement', subtitle: 'The RFQ reopens for comparison.', requireComment: true, confirmText: 'Reject', danger: true });
      if (!result) return;
      await act(() => api.post(`/api/procurement/comparative-statements/${sid}/reject`, { reason: result.comments }), 'Comparative statement rejected.');
    });
  });

  ctx.view.querySelector('[data-create-po]')?.addEventListener('click', async () => {
    if (!approvedStatement) {
      toast('Approve a comparative statement before creating a purchase order.', 'error');
      return;
    }
    let poGeneralTerms = r.generalTerms || generalTermsFallback();
    if (approvedStatement.recommendedQuotationId) {
      try {
        const qd = await api.get(`/api/procurement/quotations/${approvedStatement.recommendedQuotationId}`);
        poGeneralTerms = qd.quotation?.generalTerms || poGeneralTerms;
      } catch {
        /* Keep RFQ / setting terms when the quotation cannot be loaded. */
      }
    }
    modal({
      title: 'Create purchase order',
      subtitle: `${approvedStatement.csNo} \u00b7 ${approvedStatement.recommendedVendorName || ''}`,
      body: `<div class="form-grid">
          <div class="field"><label>PO date</label><input class="input" type="date" data-po-date value="${todayInput()}" /></div>
          <div class="field"><label>Delivery date</label><input class="input" type="date" data-po-delivery value="" /></div>
          <div class="field span-2"><label>Payment terms</label><input class="input" data-po-payment placeholder="e.g. 30 days from invoice" /></div>
          <div class="field span-2"><label>Delivery terms</label><input class="input" data-po-dterms placeholder="Place and mode of delivery" /></div>
          <div class="field span-2"><label>Notes</label><textarea class="textarea" data-po-notes rows="2"></textarea></div>
          <div class="field span-2"><label>General terms</label><textarea class="textarea" data-po-terms rows="3">${esc(poGeneralTerms)}</textarea></div>
        </div>
        <div class="help-block mt-12">The PO lines, quantities, prices and taxes are copied from the awarded quotation.</div>
        <div class="alert alert-danger hidden" data-err style="margin-top:10px"></div>`,
      footer: `<button class="btn" data-modal-close>Cancel</button><button class="btn btn-primary" data-save>Create purchase order</button>`,
      onMount(el, close) {
        el.querySelector('[data-save]').addEventListener('click', async () => {
          const errBox = el.querySelector('[data-err]');
          errBox.classList.add('hidden');
          try {
            const res = await api.post('/api/procurement/purchase-orders', {
              comparativeStatementId: approvedStatement.id,
              poDate: el.querySelector('[data-po-date]').value || null,
              deliveryDate: el.querySelector('[data-po-delivery]').value || null,
              paymentTerms: el.querySelector('[data-po-payment]').value.trim(),
              deliveryTerms: el.querySelector('[data-po-dterms]').value.trim(),
              notes: el.querySelector('[data-po-notes]').value.trim(),
              generalTerms: el.querySelector('[data-po-terms]').value.trim(),
            });
            close();
            toast(`Purchase order ${res.poNo} created.`);
            navigate(`/purchase-orders/${res.id}`);
          } catch (err) {
            errBox.textContent = err.message;
            errBox.classList.remove('hidden');
          }
        });
      },
    });
  });

  ctx.view.querySelector('[data-invite]')?.addEventListener('click', async () => {
    try {
      const meta = await api.get('/api/procurement/sourcing/meta');
      const invitedIds = new Set(vendors.map((v) => Number(v.vendorId)));
      const available = (meta.vendors || []).filter((v) => !invitedIds.has(Number(v.id)));
      if (!available.length) {
        toast('All available vendors are already invited.', 'info');
        return;
      }
      modal({
        title: 'Invite vendor',
        subtitle: r.rfqNo,
        body: `<div class="field"><label>Vendor<span class="req">*</span></label>
            <select class="select" data-vendor>${available.map((v) => `<option value="${v.id}">${esc(v.name)} (${esc(v.code)})</option>`).join('')}</select></div>
          <div class="field"><label>Remarks</label><input class="input" data-remarks /></div>
          <div class="alert alert-danger hidden" data-err></div>`,
        footer: `<button class="btn" data-modal-close>Cancel</button><button class="btn btn-primary" data-save>Invite</button>`,
        onMount(el, close) {
          el.querySelector('[data-save]').addEventListener('click', async () => {
            const errBox = el.querySelector('[data-err]');
            errBox.classList.add('hidden');
            try {
              await api.post(`/api/procurement/rfqs/${id}/vendors`, {
                vendorId: el.querySelector('[data-vendor]').value,
                remarks: el.querySelector('[data-remarks]').value.trim(),
              });
              close();
              toast('Vendor invited.');
              await refresh();
            } catch (err) {
              errBox.textContent = err.message;
              errBox.classList.remove('hidden');
            }
          });
        },
      });
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  ctx.view.querySelectorAll('[data-uninvite]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const vendorId = btn.dataset.uninvite;
      const ok = await confirmDialog({ title: 'Remove vendor', message: 'Remove this vendor from the draft RFQ?', confirmText: 'Remove', danger: true });
      if (!ok) return;
      await act(() => api.del(`/api/procurement/rfqs/${id}/vendors/${vendorId}`), 'Vendor removed.');
    });
  });
}
