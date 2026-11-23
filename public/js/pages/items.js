import { api } from '../api.js';
import { can } from '../state.js';
import { navigate, withQuery } from '../router.js';
import {
  esc, icon, money, num, statusBadge, emptyState, toast, field, confirmDialog,
} from '../ui.js';

const TYPE_LABEL = { consumable: 'Consumable', asset: 'Asset', service: 'Service' };
const TYPE_CHIP = { consumable: 'gray', asset: 'blue', service: 'teal' };

function typeChip(itemType) {
  return `<span class="chip ${TYPE_CHIP[itemType] || 'gray'}">${esc(TYPE_LABEL[itemType] || itemType)}</span>`;
}

function loadMeta() {
  return api.get('/api/procurement/meta');
}

/* ================================================================== */
/* LIST                                                                */
/* ================================================================== */
export async function renderList(ctx) {
  const q = ctx.route.query || {};
  const params = new URLSearchParams();
  if (q.search) params.set('search', q.search);
  if (q.type) params.set('type', q.type);
  if (q.category) params.set('category', q.category);
  if (q.status) params.set('status', q.status);

  ctx.view.innerHTML = `<div class="empty">Loading items\u2026</div>`;
  const [meta, res] = await Promise.all([
    loadMeta(),
    api.get(`/api/procurement/items?${params.toString()}`),
  ]);

  const items = res.items || [];
  const masterValue = items.reduce((sum, item) => sum + item.standardCost, 0);
  const topCategories = meta.categories.filter((c) => !c.parentId);

  ctx.view.innerHTML = `
    <div class="page-head">
      <div><h1>Items</h1><div class="sub">Item master for consumables, assets and services</div></div>
      <div class="page-actions">
        ${can('item.manage') ? `<a class="btn btn-primary" href="#/items/new">${icon('plus')} New Item</a>` : ''}
      </div>
    </div>

    <div class="grid grid-4 mb-16">
      <div class="card"><div class="kpi"><div class="chip gray">${icon('layers')}</div><div><div class="label">Consumables</div><div class="value">${num(meta.counts.consumable)}</div><div class="meta">Stocked and issued</div></div></div></div>
      <div class="card"><div class="kpi"><div class="chip blue">${icon('briefcase')}</div><div><div class="label">Assets</div><div class="value">${num(meta.counts.asset)}</div><div class="meta">Tracked by code and location</div></div></div></div>
      <div class="card"><div class="kpi"><div class="chip teal">${icon('clipboard')}</div><div><div class="label">Services</div><div class="value">${num(meta.counts.service)}</div><div class="meta">No stock or asset created</div></div></div></div>
      <div class="card"><div class="kpi"><div class="chip amber">${icon('wallet')}</div><div><div class="label">Standard cost</div><div class="value small-value">${money(masterValue, { decimals: 0 })}</div><div class="meta">For the items listed below</div></div></div></div>
    </div>

    <div class="card">
      <form class="toolbar" id="item-filters">
        <div class="search">${icon('search')}<input class="input" name="search" value="${esc(q.search || '')}" placeholder="Item code, name or specification..." /></div>
        <select class="select" name="type">
          <option value="">All types</option>
          ${Object.entries(TYPE_LABEL).map(([value, label]) => `<option value="${value}" ${q.type === value ? 'selected' : ''}>${label}</option>`).join('')}
        </select>
        <select class="select" name="category">
          <option value="">All categories</option>
          ${Object.entries(TYPE_LABEL).map(([type, label]) => {
            const list = topCategories.filter((c) => c.itemType === type);
            if (!list.length) return '';
            return `<optgroup label="${esc(label)}">${list.map((c) => `<option value="${c.id}" ${String(q.category) === String(c.id) ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</optgroup>`;
          }).join('')}
        </select>
        <select class="select" name="status">
          <option value="">All statuses</option>
          <option value="active" ${q.status === 'active' ? 'selected' : ''}>Active</option>
          <option value="inactive" ${q.status === 'inactive' ? 'selected' : ''}>Inactive</option>
        </select>
        <button class="btn btn-sm" type="submit">${icon('filter')} Apply</button>
        <button class="btn btn-sm btn-ghost" type="button" data-reset>Reset</button>
      </form>
      <div class="table-wrap">
        ${items.length
          ? `<table class="tbl">
              <thead><tr><th>Item</th><th>Type</th><th>Category</th><th>UOM</th><th class="num">Reorder</th><th class="num">Min / Max</th><th class="num">Std Cost</th><th>Status</th><th></th></tr></thead>
              <tbody>${items
                .map(
                  (item) => `<tr>
                    <td><a class="strong" href="#/items/${item.id}">${esc(item.name)}</a><div class="small muted mono">${esc(item.itemCode)}</div></td>
                    <td>${typeChip(item.itemType)}</td>
                    <td>${esc(item.categoryName || '\u2014')}${item.subCategoryName ? `<div class="small muted">${esc(item.subCategoryName)}</div>` : ''}</td>
                    <td class="mono small">${esc(item.uomCode)}</td>
                    <td class="num">${num(item.reorderLevel)}</td>
                    <td class="num small">${num(item.minStock)} / ${num(item.maxStock)}</td>
                    <td class="num">${item.standardCost ? money(item.standardCost) : '\u2014'}</td>
                    <td>${statusBadge(item.active ? 'active' : 'inactive')}</td>
                    <td class="actions"><a class="btn btn-sm btn-ghost" href="#/items/${item.id}">${icon('eye')}</a></td>
                  </tr>`
                )
                .join('')}</tbody></table>`
          : emptyState(
              'No items found',
              'Create the item master so requirements, purchase orders and stock can reference it.',
              can('item.manage') ? '<a class="btn btn-sm btn-primary" href="#/items/new">New Item</a>' : '',
              'layers'
            )}
      </div>
      <div class="small muted" style="padding:10px 14px">Showing ${num(items.length)} of ${num(res.total)} item${res.total === 1 ? '' : 's'}.</div>
    </div>`;

  const form = document.getElementById('item-filters');
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    navigate(withQuery('/items', Object.fromEntries(new FormData(form).entries())));
  });
  form.querySelector('[data-reset]').addEventListener('click', () => navigate('/items'));
}

/* ================================================================== */
/* FORM                                                                */
/* ================================================================== */
function attachmentsHtml(list) {
  const rows = list.length
    ? list.map((a) => `<div class="row" style="justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid var(--border)">
        <span><b>${a.kind === 'image' ? 'Image' : a.kind === 'compliance' ? 'Compliance cert' : 'Datasheet'}</b> \u00b7 <a href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.fileName)}</a></span>
        <button type="button" class="btn btn-sm btn-ghost" data-del-attachment="${a.id}" title="Remove file">${icon('trash')}</button>
      </div>`).join('')
    : '<div class="small muted">No files attached yet.</div>';
  return `${rows}
    <div class="inline-form mt-12">
      <select class="select" data-att-kind>
        <option value="image">Product image</option>
        <option value="datasheet">Technical datasheet</option>
        <option value="compliance">Compliance certificate</option>
      </select>
      <input class="input" type="file" data-att-file accept="image/jpeg,image/png,image/webp,application/pdf" />
      <button type="button" class="btn btn-sm" data-att-upload>${icon('plus')} Upload</button>
    </div>`;
}

function readBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(new Error('Could not read the file.'));
    reader.readAsDataURL(file);
  });
}

const CLASS_OPTIONS = [
  { value: 'asset', label: 'Asset (capital)' },
  { value: 'expense', label: 'Expense' },
];
const METHOD_OPTIONS = [
  { value: 'straight_line', label: 'Straight line' },
  { value: 'written_down_value', label: 'Written-down value' },
  { value: 'not_depreciated', label: 'Not depreciated' },
];
const SOURCE_TEXT = { item: 'set on this item', class: 'from asset class', default: 'built-in default' };

function assetValueText(key, value, meta) {
  if (value === null || value === undefined || value === '') return '\u2014';
  if (key === 'expenseClassification') return (CLASS_OPTIONS.find((o) => o.value === value) || {}).label || value;
  if (key === 'depreciationMethod') return (METHOD_OPTIONS.find((o) => o.value === value) || {}).label || value;
  if (key === 'defaultDepartmentId') {
    const dept = (meta.departments || []).find((d) => String(d.id) === String(value));
    return dept ? dept.name : '\u2014';
  }
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return String(value);
}

function assetInherit(key, as, meta) {
  const eff = as.effective || {};
  const src = as.source || {};
  if (eff[key] === undefined) return 'Inherit from asset class';
  const shown = assetValueText(key, eff[key], meta);
  return `Inherit (${shown}, ${SOURCE_TEXT[src[key]] || 'default'})`;
}

function assetSelect(key, label, as, meta, options, boolean = false) {
  const current = as.overrides ? as.overrides[key] : null;
  const toValue = (v) => (v === null || v === undefined ? '' : (boolean ? (v ? 'yes' : 'no') : String(v)));
  const opts = [{ value: '', label: assetInherit(key, as, meta) }, ...options];
  return field({ label, name: key, type: 'select', value: toValue(current), options: opts });
}

function assetSettingsCardHtml(meta, as, hidden) {
  const ov = as.overrides || {};
  const num = (v) => (v === null || v === undefined ? '' : String(v));
  const inheritNum = (key) => ((as.effective || {})[key] === undefined
    ? 'Inherit from asset class'
    : `Inherit (${assetValueText(key, (as.effective || {})[key], meta)})`);
  return `<div class="card ${hidden ? 'hidden' : ''}" data-asset-card style="margin-top:16px">
    <div class="card-head"><div><h3>Asset Settings</h3><div class="sub">Leave a field on Inherit to use the asset class default. Set a value only when this item differs.</div></div></div>
    <div class="form-section">
      <div class="form-grid">
        ${assetSelect('expenseClassification', 'Expense classification', as, meta, CLASS_OPTIONS)}
        ${field({ label: 'Budget category', name: 'budgetCategory', value: ov.budgetCategory || '', placeholder: (as.effective || {}).budgetCategory ? `Inherit (${(as.effective || {}).budgetCategory})` : 'Inherit from asset class' })}
        ${assetSelect('depreciationApplicable', 'Depreciation applicable', as, meta, [{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }], true)}
        ${assetSelect('depreciationMethod', 'Depreciation method', as, meta, METHOD_OPTIONS)}
        ${field({ label: 'Useful life (years)', name: 'usefulLifeYears', type: 'number', value: num(ov.usefulLifeYears), placeholder: inheritNum('usefulLifeYears'), attrs: 'min="1" max="50" step="1"' })}
        ${field({ label: 'Warranty period (months)', name: 'warrantyMonths', type: 'number', value: num(ov.warrantyMonths), placeholder: inheritNum('warrantyMonths'), attrs: 'min="0" max="240" step="1"' })}
        ${assetSelect('amcApplicable', 'AMC applicable', as, meta, [{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }], true)}
        ${assetSelect('serialRequired', 'Serial number required', as, meta, [{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }], true)}
        ${assetSelect('assetTagRequired', 'Asset tag required', as, meta, [{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }], true)}
        ${assetSelect('defaultDepartmentId', 'Default department', as, meta, (meta.departments || []).map((d) => ({ value: d.id, label: d.name })), false)}
      </div>
    </div>
  </div>`;
}

function componentOptionsHtml(meta, selected, excludeId) {
  const options = (meta.componentItems || []).filter((item) => String(item.id) !== String(excludeId || ''));
  return `<option value="">\u2014 Select component \u2014</option>${options
    .map((item) => `<option value="${item.id}" ${String(item.id) === String(selected || '') ? 'selected' : ''}>${esc(item.name)} (${esc(item.code)}) \u00b7 ${esc(TYPE_LABEL[item.itemType] || item.itemType)}</option>`)
    .join('')}`;
}

function componentRowHtml(row, meta, excludeId) {
  return `<div class="component-row">
    <div class="field">
      <label>Component / accessory</label>
      <select class="select" data-component-item>${componentOptionsHtml(meta, row.componentItemId, excludeId)}</select>
    </div>
    <div class="field">
      <label>Qty included</label>
      <input class="input" type="number" min="0.01" step="0.01" data-component-qty value="${esc(row.quantity ?? 1)}" />
    </div>
    <div class="field">
      <label>Notes / identifier</label>
      <input class="input" data-component-notes value="${esc(row.notes || '')}" placeholder="e.g. 8 GB RAM, clamp size" maxlength="500" />
    </div>
    <button type="button" class="btn btn-sm btn-ghost" data-remove-component title="Remove component">${icon('trash')}</button>
  </div>`;
}

function componentCardHtml(meta, rows, hidden, excludeId) {
  return `<div class="card component-card ${hidden ? 'hidden' : ''}" data-component-card>
    <div class="card-head">
      <div><h3>Asset Components &amp; Accessories</h3>
        <div class="sub">Define what is included with this asset. Each component keeps its own count; these rows are copied to every asset received from this item.</div></div>
      <button class="btn btn-sm" type="button" data-add-component>${icon('plus')} Add component</button>
    </div>
    <div class="component-rows" data-component-rows>${(rows || []).map((row) => componentRowHtml(row, meta, excludeId)).join('')}</div>
    <div class="hint" style="padding:10px 14px">Example: a computer system includes a mouse (1), keyboard (1), motherboard (1) and RAM (2). A drum can include clamps (4) and a carry bag (1).</div>
  </div>`;
}

export async function renderForm(ctx, options = {}) {
  const id = options.id ? Number(options.id) : null;
  ctx.view.innerHTML = `<div class="empty">Loading item\u2026</div>`;

  const meta = await loadMeta();
  const detail = id ? await api.get(`/api/procurement/items/${id}`) : null;
  const item = detail ? detail.item : null;
  if (id && !item) throw new Error('Item not found.');
  const extras = detail || { details: {}, vendors: [], attachments: [] };
  const d = extras.details || {};
  const as = extras.assetSettings || { overrides: {}, effective: {}, source: {} };

  const allCategories = meta.categories;
  const topLevel = (type) => allCategories.filter((c) => !c.parentId && c.itemType === type);
  const childrenOf = (parentId) => allCategories.filter((c) => String(c.parentId) === String(parentId));

  let itemType = item ? item.itemType : 'consumable';
  let categoryId = '';
  let subCategoryId = '';

  if (item) {
    if (item.subCategoryId) {
      const sub = allCategories.find((c) => c.id === item.subCategoryId);
      categoryId = sub && sub.parentId ? String(sub.parentId) : String(item.categoryId);
      subCategoryId = String(item.subCategoryId);
    } else {
      categoryId = String(item.categoryId);
    }
  }

  const vendorOptionsHtml = (selected) => `<option value="">\u2014 Select vendor \u2014</option>${(meta.vendors || [])
    .map((v) => `<option value="${v.id}" ${String(v.id) === String(selected) ? 'selected' : ''}>${esc(v.name)} (${esc(v.code)})</option>`)
    .join('')}`;
  const vendorRowHtml = (row) => `<tr>
    <td><select class="select" data-vendor-id>${vendorOptionsHtml(row.vendorId)}</select></td>
    <td><input class="input" data-vendor-code value="${esc(row.vendorItemCode || '')}" placeholder="Vendor's code" /></td>
    <td><input class="input" data-vendor-cost type="number" min="0" step="0.01" value="${esc(row.unitCost ?? 0)}" /></td>
    <td><input class="input" data-vendor-lead type="number" min="0" step="1" value="${esc(row.leadTimeDays ?? 0)}" /></td>
    <td><input type="radio" name="preferredVendor" data-preferred title="Preferred vendor" ${row.isPreferred ? 'checked' : ''} /></td>
    <td class="actions"><button type="button" class="btn btn-sm btn-ghost" data-remove-vendor title="Remove">${icon('trash')}</button></td>
  </tr>`;

  const typeOptions = meta.itemTypes.map((t) => ({ value: t.value, label: t.label }));
  const uomOptions = [{ value: '', label: '\u2014 Select UOM \u2014' }, ...meta.uoms.map((u) => ({ value: u.id, label: `${u.code} \u2014 ${u.name}` }))];

  const activeCategories = topLevel(itemType);
  if (!categoryId && activeCategories.length === 1) categoryId = String(activeCategories[0].id);

  const categoryOptions = (type, selected) => [
    { value: '', label: '\u2014 Select category \u2014' },
    ...topLevel(type).map((c) => ({ value: c.id, label: c.name })),
  ].map((o) => `<option value="${esc(o.value)}" ${String(o.value) === String(selected) ? 'selected' : ''}>${esc(o.label)}</option>`).join('');

  const subOptions = (parent, selected) => [
    { value: '', label: '\u2014 No sub category \u2014' },
    ...childrenOf(parent).map((c) => ({ value: c.id, label: c.name })),
  ].map((o) => `<option value="${esc(o.value)}" ${String(o.value) === String(selected) ? 'selected' : ''}>${esc(o.label)}</option>`).join('');

  ctx.view.innerHTML = `
    <div class="page-head">
      <div><h1>${id ? 'Edit Item' : 'New Item'}</h1>
        <div class="sub">${id ? `${esc(item.name)} \u00b7 ${esc(item.itemCode)}` : 'Add an item to the master with its category, UOM and stock levels'}</div></div>
      <div class="page-actions">
        <a class="btn" href="${id ? `#/items/${id}` : '#/items'}">${icon('arrowLeft')} Cancel</a>
        ${id ? `<button class="btn btn-danger" type="button" data-retire>${icon('trash')} Retire</button>` : ''}
        <button class="btn btn-primary" type="button" data-save>${icon('check')} ${id ? 'Save changes' : 'Create item'}</button>
      </div>
    </div>
    <div id="item-alert" class="alert alert-danger hidden"></div>

    <form id="item-form" autocomplete="off">
      <div class="grid grid-2" style="align-items:start">
        <div class="stack">
          <div class="card">
            <div class="card-head"><div><h3>Item Information</h3><div class="sub">Identity, classification and unit of measure</div></div></div>
            <div class="form-section">
              <div class="form-grid">
                ${field({ label: 'Item Name', name: 'name', value: item?.name || '', required: true, span: true })}
                ${field({ label: 'Item Type', name: 'itemType', type: 'select', value: itemType, options: typeOptions, required: true, attrs: 'data-item-type' })}
                <div class="field">
                  <label>Category<span class="req">*</span></label>
                  <select class="select" name="categoryId" data-category required>${categoryOptions(itemType, categoryId)}</select>
                </div>
                <div class="field">
                  <label>Sub Category</label>
                  <select class="select" name="subCategoryId" data-subcategory>${subOptions(categoryId, subCategoryId)}</select>
                </div>
                ${field({ label: 'Unit of Measure', name: 'uomId', type: 'select', value: item?.uomId || '', options: uomOptions, required: true })}
                ${field({ label: 'Approval Required', name: 'approvalRequired', type: 'select', value: d.approvalRequired ? 'yes' : 'no', options: [{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }], hint: 'Requisitions for this item require approval.' })}
                <div class="field span-2">
                  <label>Item Code</label>
                  <div class="input" style="background:#f6f8fb;display:flex;align-items:center">${esc(item?.itemCode || 'Auto-generated on save')}</div>
                </div>
                ${field({ label: 'Specification', name: 'specification', type: 'textarea', value: item?.specification || '', span: true, placeholder: 'Brand, model, size, grade or other identifying detail' })}
              </div>
            </div>
          </div>
        </div>

        <div class="stack">
          <div class="card">
            <div class="card-head"><div><h3>Stock Controls</h3><div class="sub">Used for reorder alerts and consumption reporting</div></div></div>
            <div class="form-section">
              <div class="form-grid">
                ${field({ label: 'Minimum Stock', name: 'minStock', type: 'number', value: item?.minStock ?? 0, attrs: 'min="0" step="0.01"' })}
                ${field({ label: 'Maximum Stock', name: 'maxStock', type: 'number', value: item?.maxStock ?? 0, attrs: 'min="0" step="0.01"' })}
                ${field({ label: 'Reorder Level', name: 'reorderLevel', type: 'number', value: item?.reorderLevel ?? 0, attrs: 'min="0" step="0.01"' })}
                ${field({ label: 'Standard Cost', name: 'standardCost', type: 'number', value: item?.standardCost ?? 0, attrs: 'min="0" step="0.01"' })}
                ${field({ label: 'Status', name: 'status', type: 'select', value: item?.active === false ? 'inactive' : 'active', options: [
                  { value: 'active', label: 'Active' },
                  { value: 'inactive', label: 'Inactive' },
                ] })}
              </div>
              <div class="hint" style="margin-top:10px">
                ${itemType === 'service'
                  ? 'Services do not create stock or asset records.'
                  : itemType === 'asset'
                    ? 'Assets create an asset record, code and label after receipt.'
                    : 'Consumables reduce stock when issued to a department.'}
              </div>
            </div>
          </div>
        </div>
      </div>

      <div class="grid grid-2 mt-16" style="align-items:start">
        <div class="stack">
          <div class="card">
            <div class="card-head"><div><h3>Identification</h3><div class="sub">Brand, model and tax classification</div></div></div>
            <div class="form-section">
              <div class="form-grid">
                ${field({ label: 'Brand', name: 'brand', value: d.brand || '' })}
                ${field({ label: 'Model Number', name: 'modelNo', value: d.modelNo || '' })}
                ${field({ label: 'Make', name: 'make', value: d.make || '' })}
                ${field({ label: 'Manufacturer', name: 'manufacturer', value: d.manufacturer || '', span: true })}
                ${field({ label: 'HSN / SAC Code', name: 'hsnCode', value: d.hsnCode || '', placeholder: '2 to 8 digits' })}
                ${field({ label: 'GST Rate (%)', name: 'gstRate', type: 'number', value: d.gstRate ?? 0, attrs: 'min="0" max="100" step="0.01"' })}
              </div>
            </div>
          </div>
          <div class="card">
            <div class="card-head"><div><h3>Tax &amp; discount defaults</h3><div class="sub">Prefilled on requisition and quotation lines when this item is selected</div></div></div>
            <div class="form-section">
              <div class="form-grid">
                <div class="field">
                  <label>Price includes tax (tax inclusive)</label>
                  <label class="row" style="gap:8px;align-items:center;font-size:13px;padding:6px 0">
                    <input type="checkbox" name="taxInclusive" ${d.taxInclusive ? 'checked' : ''} />
                    <span class="small muted">Checked when the price already includes tax</span>
                  </label>
                </div>
                ${field({ label: 'Default discount %', name: 'defaultDiscountPercent', type: 'number', value: d.defaultDiscountPercent ?? 0, attrs: 'min="0" max="100" step="0.01"' })}
                ${field({ label: 'Default flat discount amount', name: 'defaultDiscountAmount', type: 'number', value: d.defaultDiscountAmount ?? 0, attrs: 'min="0" step="0.01"' })}
              </div>
              <div class="hint" style="margin-top:10px">Discounts are applied before tax. Inclusive prices are back-calculated to show taxable value and tax.</div>
            </div>
          </div>
          <div class="card">
            <div class="card-head"><div><h3>Technical Specifications</h3><div class="sub">Color, capacity, power and configuration details</div></div></div>
            <div class="form-section">
              <div class="form-grid">
                ${field({ label: 'Color', name: 'color', value: d.color || '' })}
                ${field({ label: 'Capacity', name: 'capacity', value: d.capacity || '', placeholder: 'e.g. 16 GB, 500 L' })}
                ${field({ label: 'Power Rating', name: 'powerRating', value: d.powerRating || '', placeholder: 'e.g. 1.5 kW, 220V' })}
                ${field({ label: 'Configuration Details', name: 'configurationDetails', type: 'textarea', value: d.configurationDetails || '', span: true, placeholder: 'Processor, RAM, storage, ports, or other config details' })}
              </div>
            </div>
          </div>
          <div class="card">
            <div class="card-head"><div><h3>Procurement &amp; Packaging</h3><div class="sub">Ordering quantities, lead time and pack size</div></div></div>
            <div class="form-section">
              <div class="form-grid">
                ${field({ label: 'Minimum Order Qty (MOQ)', name: 'moq', type: 'number', value: d.moq ?? 0, attrs: 'min="0" step="0.01"' })}
                ${field({ label: 'Reorder Quantity', name: 'reorderQty', type: 'number', value: d.reorderQty ?? 0, attrs: 'min="0" step="0.01"' })}
                ${field({ label: 'Lead Time (days)', name: 'leadTimeDays', type: 'number', value: d.leadTimeDays ?? 0, attrs: 'min="0" step="1"' })}
                ${field({ label: 'Last Purchase Cost', name: 'lastPurchaseCost', type: 'number', value: d.lastPurchaseCost ?? 0, attrs: 'min="0" step="0.01"' })}
                ${field({ label: 'Pack Size', name: 'packSize', type: 'number', value: d.packSize ?? 1, attrs: 'min="0.01" step="0.01"' })}
                ${field({ label: 'Pack Description', name: 'packDescription', value: d.packDescription || '', placeholder: 'e.g. Box of 500' })}
                ${field({ label: 'Safety Stock', name: 'safetyStock', type: 'number', value: d.safetyStock ?? 0, attrs: 'min="0" step="0.01"', span: true })}
                ${field({ label: 'Rack Number', name: 'rackNumber', value: d.rackNumber || '', placeholder: 'e.g. R-01' })}
                ${field({ label: 'Bin Location', name: 'binLocation', value: d.binLocation || '', placeholder: 'e.g. B-12' })}
                ${field({ label: 'Storage Conditions', name: 'storageConditions', value: d.storageConditions || '', span: true, placeholder: 'e.g. Cool, dry place; away from sunlight' })}
              </div>
            </div>
          </div>
        </div>
        <div class="stack">
          <div class="card">
            <div class="card-head">
              <div><h3>Vendors</h3><div class="sub">Who supplies this item. Mark one as preferred.</div></div>
              <button class="btn btn-sm" type="button" data-add-vendor-row>${icon('plus')} Add vendor</button>
            </div>
            <div class="table-wrap">
              <table class="tbl">
                <thead><tr><th style="min-width:200px">Vendor</th><th>Vendor item code</th><th style="width:110px">Unit cost</th><th style="width:90px">Lead days</th><th style="width:80px">Preferred</th><th></th></tr></thead>
                <tbody data-vendor-rows>${extras.vendors.map(vendorRowHtml).join('')}</tbody>
              </table>
            </div>
            <div class="hint" style="padding:10px 14px">Blacklisted vendors cannot be mapped.</div>
          </div>
          <div class="card" data-amc-card style="display:${itemType === 'asset' ? 'block' : 'none'}">
            <div class="card-head"><div><h3>AMC &amp; Compliance</h3><div class="sub">Warranty, AMC, insurance and compliance settings</div></div></div>
            <div class="form-section">
              <div class="form-grid">
                ${field({ label: 'AMC Vendor', name: 'amcVendorId', type: 'select', value: d.amcVendorId || '', options: [{ value: '', label: '\\u2014 No AMC vendor \\u2014' }].concat((meta.vendors || []).map((v) => ({ value: v.id, label: `${v.name} (${v.code})` }))) }) }
                ${field({ label: 'AMC Start Date', name: 'amcStartDate', type: 'date', value: d.amcStartDate || '' })}
                ${field({ label: 'AMC End Date', name: 'amcEndDate', type: 'date', value: d.amcEndDate || '' })}
                ${field({ label: 'Insurance Required', name: 'insuranceRequired', type: 'select', value: d.insuranceRequired ? 'yes' : 'no', options: [{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }] }) }
                ${field({ label: 'Compliance Cert Required', name: 'complianceCertRequired', type: 'select', value: d.complianceCertRequired ? 'yes' : 'no', options: [{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }] }) }
                ${field({ label: 'Default Store', name: 'defaultStoreId', type: 'select', value: d.defaultStoreId || '', options: [{ value: '', label: '\\u2014 No default store \\u2014' }].concat((meta.stores || []).map((s) => ({ value: s.id, label: `${s.name} (${s.code})` }))) }) }
              </div>
            </div>
          </div>
          <div class="card" data-consumable-card style="display:${itemType === 'consumable' ? 'block' : 'none'}">
            <div class="card-head"><div><h3>Consumable Settings</h3><div class="sub">Expiry tracking and storage conditions</div></div></div>
            <div class="form-section">
              <div class="form-grid">
                ${field({ label: 'Expiry Tracking', name: 'expiryTracking', type: 'select', value: d.expiryTracking ? 'yes' : 'no', options: [{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }], hint: 'Track expiry dates for this consumable.' }) }
                ${field({ label: 'Shelf Life (days)', name: 'shelfLifeDays', type: 'number', value: d.shelfLifeDays ?? 0, attrs: 'min="0" step="1"' }) }
              </div>
            </div>
          </div>
          <div class="card">
            <div class="card-head"><div><h3>Product Image &amp; Datasheet</h3><div class="sub">JPEG, PNG or WebP image, or PDF datasheet. Up to 5 MB each.</div></div></div>
            <div class="form-section" data-attachments>
              ${id ? attachmentsHtml(extras.attachments) : '<div class="hint">Save the item first, then attach its image and datasheet.</div>'}
            </div>
          </div>
        </div>
      </div>
      ${componentCardHtml(meta, extras.components || [], itemType !== 'asset', id)}
      ${assetSettingsCardHtml(meta, as, itemType !== 'asset')}
    </form>`;

  const form = document.getElementById('item-form');
  const alertBox = document.getElementById('item-alert');
  const typeSelect = form.querySelector('[data-item-type]');
  const categorySelect = form.querySelector('[data-category]');
  const subSelect = form.querySelector('[data-subcategory]');

  function refreshCategories() {
    itemType = typeSelect.value;
    const previous = categorySelect.value;
    const options = topLevel(itemType);
    const keep = options.some((c) => String(c.id) === String(previous)) ? previous : (options.length === 1 ? String(options[0].id) : '');
    categorySelect.innerHTML = categoryOptions(itemType, keep);
    refreshSubCategories();
  }

  function refreshSubCategories() {
    subSelect.innerHTML = subOptions(categorySelect.value, subSelect.value);
  }

  typeSelect.addEventListener('change', refreshCategories);
  const assetCard = form.querySelector('[data-asset-card]');
  const componentCard = form.querySelector('[data-component-card]');
  const amcCard = form.querySelector('[data-amc-card]');
  const consumableCard = form.querySelector('[data-consumable-card]');
  const syncCards = () => {
    const isAsset = typeSelect.value === 'asset';
    const isConsumable = typeSelect.value === 'consumable';
    if (assetCard) {
      assetCard.style.display = isAsset ? 'block' : 'none';
      assetCard.classList.toggle('hidden', !isAsset);
    }
    if (componentCard) {
      componentCard.style.display = isAsset ? 'block' : 'none';
      componentCard.classList.toggle('hidden', !isAsset);
    }
    if (amcCard) amcCard.style.display = isAsset ? 'block' : 'none';
    if (consumableCard) consumableCard.style.display = isConsumable ? 'block' : 'none';
  };
  typeSelect.addEventListener('change', syncCards);
  categorySelect.addEventListener('change', refreshSubCategories);

  function showError(message) {
    alertBox.innerHTML = `${icon('alert')} ${esc(message)}`;
    alertBox.classList.remove('hidden');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  const vendorBody = form.querySelector('[data-vendor-rows]');
  form.querySelector('[data-add-vendor-row]').addEventListener('click', () => {
    vendorBody.insertAdjacentHTML('beforeend', vendorRowHtml({ isPreferred: false, unitCost: 0, leadTimeDays: 0 }));
  });
  vendorBody.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-remove-vendor]');
    if (btn) btn.closest('tr').remove();
  });

  const componentBody = form.querySelector('[data-component-rows]');
  form.querySelector('[data-add-component]').addEventListener('click', () => {
    componentBody.insertAdjacentHTML('beforeend', componentRowHtml({}, meta, id));
  });
  componentBody.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-remove-component]');
    if (btn) btn.closest('.component-row').remove();
  });

  const attBox = form.querySelector('[data-attachments]');
  attBox.addEventListener('click', async (e) => {
    const del = e.target.closest('[data-del-attachment]');
    if (del && id) {
      const ok = await confirmDialog({
        title: 'Remove file',
        message: 'Remove this file from the item? It stays in the audit trail.',
        confirmText: 'Remove',
        danger: true,
      });
      if (!ok) return;
      try {
        await api.del(`/api/procurement/items/${id}/attachments/${del.dataset.delAttachment}`);
        toast('File removed.');
        await renderForm(ctx, options);
      } catch (err) {
        toast(err.message || 'Unable to remove the file.', 'error');
      }
      return;
    }
    if (e.target.closest('[data-att-upload]') && id) {
      const file = attBox.querySelector('[data-att-file]').files[0];
      if (!file) {
        toast('Choose a file to upload.', 'error');
        return;
      }
      try {
        const data = await readBase64(file);
        await api.post(`/api/procurement/items/${id}/attachments`, {
          kind: attBox.querySelector('[data-att-kind]').value,
          name: file.name,
          mime: file.type,
          data,
        });
        toast('File uploaded.');
        await renderForm(ctx, options);
      } catch (err) {
        toast(err.message || 'Upload failed.', 'error');
      }
    }
  });

  function readAssetSettings() {
    const out = {};
    const keys = ['expenseClassification', 'budgetCategory', 'depreciationApplicable', 'depreciationMethod',
      'usefulLifeYears', 'warrantyMonths', 'amcApplicable', 'serialRequired', 'assetTagRequired', 'defaultDepartmentId'];
    for (const key of keys) {
      const raw = form[key] ? String(form[key].value ?? '').trim() : '';
      out[key] = raw === '' ? null : raw;
    }
    return out;
  }

  function readComponentRows() {
    const rows = [];
    componentBody.querySelectorAll('.component-row').forEach((row) => {
      const componentItemId = row.querySelector('[data-component-item]').value;
      if (!componentItemId) return;
      rows.push({
        componentItemId,
        quantity: row.querySelector('[data-component-qty]').value || 1,
        notes: row.querySelector('[data-component-notes]').value.trim(),
      });
    });
    return rows;
  }

  function readVendorRows() {
    const rows = [];
    vendorBody.querySelectorAll('tr').forEach((tr) => {
      const vendorId = tr.querySelector('[data-vendor-id]').value;
      if (!vendorId) return;
      rows.push({
        vendorId,
        vendorItemCode: tr.querySelector('[data-vendor-code]').value.trim(),
        unitCost: tr.querySelector('[data-vendor-cost]').value || 0,
        leadTimeDays: tr.querySelector('[data-vendor-lead]').value || 0,
        isPreferred: tr.querySelector('[data-preferred]').checked,
      });
    });
    return rows;
  }

  ctx.view.querySelector('[data-save]').addEventListener('click', async () => {
    alertBox.classList.add('hidden');
    const data = {
      name: form.name.value.trim(),
      itemType: form.itemType.value,
      categoryId: form.categoryId.value,
      subCategoryId: form.subCategoryId.value || null,
      uomId: form.uomId.value,
      specification: form.specification.value.trim(),
      reorderLevel: form.reorderLevel.value,
      minStock: form.minStock.value,
      maxStock: form.maxStock.value,
      standardCost: form.standardCost.value,
      active: form.status.value === 'active',
      details: {
        brand: form.brand.value.trim(),
        modelNo: form.modelNo.value.trim(),
        manufacturer: form.manufacturer.value.trim(),
        hsnCode: form.hsnCode.value.trim(),
        gstRate: form.gstRate.value,
        taxInclusive: form.taxInclusive.checked,
        defaultDiscountPercent: form.defaultDiscountPercent.value,
        defaultDiscountAmount: form.defaultDiscountAmount.value,
        moq: form.moq.value,
        reorderQty: form.reorderQty.value,
        leadTimeDays: form.leadTimeDays.value,
        packSize: form.packSize.value,
        packDescription: form.packDescription.value.trim(),
        safetyStock: form.safetyStock.value,
        lastPurchaseCost: form.lastPurchaseCost.value,
        color: form.color.value.trim(),
        capacity: form.capacity.value.trim(),
        powerRating: form.powerRating.value.trim(),
        configurationDetails: form.configurationDetails.value.trim(),
        make: form.make.value.trim(),
        expiryTracking: form.expiryTracking ? form.expiryTracking.value === 'yes' : false,
        shelfLifeDays: form.shelfLifeDays ? form.shelfLifeDays.value : 0,
        amcVendorId: form.amcVendorId ? form.amcVendorId.value : '',
        amcStartDate: form.amcStartDate ? form.amcStartDate.value : '',
        amcEndDate: form.amcEndDate ? form.amcEndDate.value : '',
        insuranceRequired: form.insuranceRequired ? form.insuranceRequired.value === 'yes' : false,
        complianceCertRequired: form.complianceCertRequired ? form.complianceCertRequired.value === 'yes' : false,
        defaultStoreId: form.defaultStoreId ? form.defaultStoreId.value : '',
        storageConditions: form.storageConditions.value.trim(),
        rackNumber: form.rackNumber.value.trim(),
        binLocation: form.binLocation.value.trim(),
        approvalRequired: form.approvalRequired ? form.approvalRequired.value === 'yes' : false,
        approvalMatrixId: null,
      },
      vendors: readVendorRows(),
      components: form.itemType.value === 'asset' ? readComponentRows() : [],
      assetSettings: form.itemType.value === 'asset' ? readAssetSettings() : {},
    };
    if (!data.name) return showError('Item name is required.');
    if (!data.categoryId) return showError('Select a category for this item.');
    if (!data.uomId) return showError('Select a unit of measure for this item.');
    try {
      if (id) {
        await api.put(`/api/procurement/items/${id}`, data);
        toast('Item updated.');
      } else {
        const res = await api.post('/api/procurement/items', data);
        toast(`Item created (${res.itemCode}).`);
      }
      navigate('/items');
    } catch (e) {
      showError(e.message || 'Unable to save the item.');
    }
  });

  const retireBtn = ctx.view.querySelector('[data-retire]');
  if (retireBtn) {
    retireBtn.addEventListener('click', async () => {
      const ok = await confirmDialog({
        title: 'Retire item',
        message: 'Retire this item? It will no longer be available for new requirements or purchase orders. Existing records are preserved.',
        confirmText: 'Retire item',
        danger: true,
      });
      if (!ok) return;
      try {
        await api.del(`/api/procurement/items/${id}`);
        toast('Item retired.');
        navigate('/items');
      } catch (e) {
        toast(e.message || 'Unable to retire the item.', 'error');
      }
    });
  }
}

/* ================================================================== */
/* DETAIL                                                              */
/* ================================================================== */
export async function renderDetail(ctx, options = {}) {
  return renderForm(ctx, options);
}
