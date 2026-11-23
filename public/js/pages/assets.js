import { api } from '../api.js';
import { can } from '../state.js';
import { navigate, withQuery } from '../router.js';
import {
  esc, icon, money, num, statusBadge, emptyState, toast, modal, confirmDialog, actionDialog,
  fmtDate, todayInput,
} from '../ui.js';

const ASSET_STATUS = {
  ordered: 'Ordered',
  received: 'Received',
  created: 'Registered',
  allocated: 'Allocated',
  in_use: 'In Use',
  under_maintenance: 'Under Maintenance',
  under_repair: 'Under Repair',
  transferred: 'Transferred',
  missing: 'Missing',
  disposed: 'Disposed',
};

const MAINTENANCE_STATUS = {
  scheduled: 'Scheduled',
  in_progress: 'In Progress',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

function statusOf(status) {
  return statusBadge(status, ASSET_STATUS[status] || status);
}

function optionList(rows, selected, valueKey = 'id', labelKey = 'name', extra = '') {
  return rows
    .map((row) => `<option value="${esc(row[valueKey])}" ${String(row[valueKey]) === String(selected || '') ? 'selected' : ''}>${esc(row[labelKey])}${extra ? ` \u00b7 ${esc(row[extra])}` : ''}</option>`)
    .join('');
}

function selectOptions(rows, selected, emptyLabel) {
  return `<option value="">${esc(emptyLabel)}</option>${rows
    .map((row) => `<option value="${row.value}" ${row.value === selected ? 'selected' : ''}>${esc(row.label)}</option>`)
    .join('')}`;
}

function assetLocation(asset) {
  return [asset.roomName, asset.storeName, asset.binName].filter(Boolean).join(' \u00b7 ') || '\u2014';
}

function qrDataUrl(payload) {
  try {
    const qr = window.qrcode(0, 'M');
    qr.addData(payload);
    qr.make();
    return qr.createDataURL(4, 4);
  } catch {
    return '';
  }
}

/* ================================================================== */
/* LABELS                                                              */
/* ================================================================== */
function labelMarkup(label) {
  const qr = qrDataUrl(label.qrPayload);
  return `<div class="asset-label" data-label-card>
    <div class="asset-label-head">
      <div>
        <div class="asset-label-code">${esc(label.assetCode)}</div>
        <div class="asset-label-name">${esc(label.assetName)}</div>
        <div class="asset-label-meta">${esc(label.categoryName || '')}${label.unitName ? ` \u00b7 ${esc(label.unitName)}` : ''}</div>
      </div>
      ${qr ? `<img class="asset-label-qr" src="${qr}" alt="QR code for ${esc(label.assetCode)}" />` : ''}
    </div>
    <svg class="asset-label-barcode" data-barcode="${esc(label.barcodeValue)}"></svg>
    <div class="asset-label-foot">Scan the QR code to open this asset in ABMDAS</div>
  </div>`;
}

function printLabels(labels) {
  const win = window.open('', '_blank', 'width=900,height=700');
  if (!win) {
    toast('Allow pop-ups to print asset labels.', 'error');
    return;
  }
  const cards = labels.map((label) => {
    const qr = qrDataUrl(label.qrPayload);
    return `<div class="label">
      <div class="row">
        <div style="min-width:0">
          <div class="code">${esc(label.assetCode)}</div>
          <div class="name">${esc(label.assetName)}</div>
          <div class="meta">${esc(label.categoryName || '')}${label.unitName ? ` \u00b7 ${esc(label.unitName)}` : ''}</div>
        </div>
        ${qr ? `<img src="${qr}" alt="QR" />` : ''}
      </div>
      <svg class="barcode" data-barcode="${esc(label.barcodeValue)}"></svg>
      <div class="foot">Scan the QR code to open this asset in ABMDAS</div>
    </div>`;
  }).join('');
  win.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8" />
    <title>Asset labels</title>
    <style>
      * { box-sizing: border-box; }
      body { font-family: Arial, Helvetica, sans-serif; margin: 10mm; color: #111; }
      .sheet { display: flex; flex-wrap: wrap; gap: 6mm; }
      .label { width: 70mm; min-height: 42mm; border: 1px dashed #999; border-radius: 3mm; padding: 3mm; page-break-inside: avoid; }
      .row { display: flex; gap: 3mm; align-items: flex-start; justify-content: space-between; }
      .code { font-size: 10px; font-weight: 700; letter-spacing: .02em; }
      .name { font-size: 11px; font-weight: 700; margin-top: 2px; }
      .meta { font-size: 7.5px; color: #555; margin-top: 1px; }
      img { width: 19mm; height: 19mm; }
      svg.barcode { width: 100%; height: 13mm; margin-top: 2mm; }
      .foot { font-size: 6.5px; color: #666; margin-top: 1mm; }
      @media print { body { margin: 6mm; } .label { border-color: #bbb; } }
    </style></head><body><div class="sheet">${cards}</div>
    <script src="/vendor/jsbarcode.min.js"><\/script>
    <script>
      document.querySelectorAll('svg.barcode').forEach(function (el) {
        if (window.JsBarcode) {
          try { window.JsBarcode(el, el.getAttribute('data-barcode'), { format: 'CODE128', displayValue: true, width: 1.5, height: 42, margin: 0, fontSize: 11 }); } catch (e) {}
        }
      });
      window.addEventListener('load', function () { setTimeout(function () { window.print(); }, 250); });
    <\/script></body></html>`);
  win.document.close();
}

function openLabelModal(labels) {
  modal({
    title: labels.length === 1 ? 'Asset label' : `${labels.length} asset labels`,
    subtitle: 'Code128 barcode and QR code. The QR resolves to the asset page.',
    size: 'lg',
    body: `<div class="asset-label-sheet">${labels.map(labelMarkup).join('')}</div>`,
    footer: `<button class="btn" data-modal-close>Close</button>
             <button class="btn btn-primary" data-print>${icon('printer')} Print labels</button>`,
    onMount(el, close) {
      if (window.JsBarcode) {
        el.querySelectorAll('svg[data-barcode]').forEach((svg) => {
          try {
            window.JsBarcode(svg, svg.dataset.barcode, {
              format: 'CODE128', displayValue: true, width: 1.5, height: 44, margin: 0, fontSize: 12,
            });
          } catch {
            /* a barcode failure must not block printing the QR */
          }
        });
      }
      el.querySelector('[data-print]').addEventListener('click', () => {
        printLabels(labels);
      });
      void close;
    },
  });
}

async function printAssetLabel(id) {
  try {
    const res = await api.get(`/api/procurement/assets/${id}/label`);
    openLabelModal([res.label]);
  } catch (err) {
    toast(err.message || 'Unable to build the label.', 'error');
  }
}

async function printBulkLabels(ids) {
  if (!ids.length) {
    toast('Select at least one asset first.', 'error');
    return;
  }
  try {
    const res = await api.post('/api/procurement/assets/labels/bulk', { assetIds: ids });
    openLabelModal(res.labels || []);
  } catch (err) {
    toast(err.message || 'Unable to build labels.', 'error');
  }
}

/* ================================================================== */
/* LIST                                                                */
/* ================================================================== */
export async function renderList(ctx) {
  const q = ctx.route.query || {};
  const params = new URLSearchParams();
  for (const key of ['search', 'status', 'unitId', 'categoryId', 'departmentId', 'custodianEmployeeId']) {
    if (q[key]) params.set(key, q[key]);
  }
  ctx.view.innerHTML = '<div class="empty">Loading asset register\u2026</div>';
  const [meta, res] = await Promise.all([
    api.get('/api/procurement/assets/meta'),
    api.get(`/api/procurement/assets?${params.toString()}`),
  ]);
  const rows = res.assets || [];
  const summary = res.summary || {};
  const statuses = meta.statuses || [];

  ctx.view.innerHTML = `
    <div class="page-head">
      <div><h1>Asset Register</h1><div class="sub">Lifecycle, custody and verification of every asset</div></div>
      <div class="page-actions">
        ${can('asset.manage') ? `<a class="btn btn-primary" href="#/assets/new">${icon('plus')} Register Asset</a>` : ''}
      </div>
    </div>

    <div class="grid grid-4 mb-16">
      <div class="card"><div class="kpi"><div class="chip blue">${icon('layers')}</div><div><div class="label">Total assets</div><div class="value">${num(summary.total)}</div><div class="meta">${num(summary.allocated + summary.inUse)} in custody</div></div></div></div>
      <div class="card"><div class="kpi"><div class="chip teal">${icon('users')}</div><div><div class="label">Allocated / in use</div><div class="value">${num(summary.allocated + summary.inUse)}</div><div class="meta">${num(summary.allocated)} allocated \u00b7 ${num(summary.inUse)} in use</div></div></div></div>
      <div class="card"><div class="kpi"><div class="chip amber">${icon('gear')}</div><div><div class="label">Under service</div><div class="value">${num(summary.underMaintenance + summary.underRepair)}</div><div class="meta">${num(summary.underMaintenance)} maintenance \u00b7 ${num(summary.underRepair)} repair</div></div></div></div>
      <div class="card"><div class="kpi"><div class="chip ${summary.missing ? 'red' : 'gray'}">${icon('alert')}</div><div><div class="label">Missing / disposed</div><div class="value">${num(summary.missing)} / ${num(summary.disposed)}</div><div class="meta">Active value ${money(summary.activeValue)}</div></div></div></div>
    </div>

    <div class="card">
      <form class="toolbar" id="asset-filters">
        <div class="search">${icon('search')}<input class="input" name="search" value="${esc(q.search || '')}" placeholder="Asset code, name, serial or custodian..." /></div>
        <select class="select" name="status"><option value="">All statuses</option>
          ${statuses.map((s) => `<option value="${esc(s.value)}" ${q.status === s.value ? 'selected' : ''}>${esc(s.label)}</option>`).join('')}
        </select>
        <select class="select" name="unitId"><option value="">All units</option>
          ${optionList(meta.units || [], q.unitId, 'id', 'name')}
        </select>
        <select class="select" name="categoryId"><option value="">All categories</option>
          ${optionList(meta.categories || [], q.categoryId, 'id', 'name')}
        </select>
        <select class="select" name="custodianEmployeeId"><option value="">Any custodian</option>
          ${optionList(meta.employees || [], q.custodianEmployeeId, 'id', 'name')}
        </select>
        <button class="btn btn-sm" type="submit">${icon('filter')} Apply</button>
        <button class="btn btn-sm btn-ghost" type="button" data-reset>Reset</button>
        ${rows.length ? `<span class="spacer"></span><button class="btn btn-sm" type="button" data-print-selected>${icon('printer')} Print selected</button>` : ''}
      </form>
      <div class="table-wrap">
        ${rows.length
          ? `<table class="tbl">
              <thead><tr>
                <th style="width:32px"><input type="checkbox" data-check-all title="Select all" /></th>
                <th>Asset</th><th>Category / item</th><th>Custodian / location</th>
                <th>Purchase</th><th class="num">Value</th><th>Status</th><th></th>
              </tr></thead>
              <tbody>${rows.map((r) => `<tr>
                <td><input type="checkbox" data-asset-check value="${r.id}" /></td>
                <td><a class="strong" href="#/assets/${r.id}">${esc(r.assetCode)}</a>
                  <div class="small">${esc(r.assetName)}</div>
                  ${r.serialNo ? `<div class="small muted mono">${esc(r.serialNo)}</div>` : ''}</td>
                <td class="small">${esc(r.categoryName || '\u2014')}${r.itemName ? `<div class="small muted">${esc(r.itemName)}</div>` : ''}</td>
                <td class="small">${esc(r.custodianName || 'Unassigned')}<div class="small muted">${esc(assetLocation(r))}</div></td>
                <td class="small">${fmtDate(r.purchaseDate)}<div class="small muted">${esc(r.unitName || '')}</div></td>
                <td class="num">${money(r.purchaseValue)}</td>
                <td>${statusOf(r.status)}</td>
                <td class="actions"><a class="btn btn-sm btn-ghost" href="#/assets/${r.id}">${icon('eye')}</a></td>
              </tr>`).join('')}</tbody></table>`
          : emptyState(
            'No assets found',
            'Post a goods receipt with asset items or register an asset manually.',
            can('asset.manage') ? '<a class="btn btn-sm btn-primary" href="#/assets/new">Register Asset</a>' : '',
            'layers'
          )}
      </div>
      <div class="small muted" style="padding:10px 14px">Showing ${num(rows.length)} of ${num(res.total)} asset${res.total === 1 ? '' : 's'}.</div>
    </div>`;

  const form = document.getElementById('asset-filters');
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    navigate(withQuery('/assets', Object.fromEntries(new FormData(form).entries())));
  });
  form.querySelector('[data-reset]').addEventListener('click', () => navigate('/assets'));

  const checkAll = ctx.view.querySelector('[data-check-all]');
  checkAll?.addEventListener('change', () => {
    ctx.view.querySelectorAll('[data-asset-check]').forEach((box) => { box.checked = checkAll.checked; });
  });
  ctx.view.querySelector('[data-print-selected]')?.addEventListener('click', () => {
    const ids = [...ctx.view.querySelectorAll('[data-asset-check]:checked')].map((box) => Number(box.value));
    printBulkLabels(ids);
  });
}

/* ================================================================== */
/* FORM                                                                */
/* ================================================================== */
function binOptions(meta, storeId, selected) {
  const bins = (meta.bins || []).filter((bin) => !storeId || String(bin.storeId) === String(storeId));
  return `<option value="">\u2014 No bin \u2014</option>${optionList(bins, selected, 'id', 'name')}`;
}

function refreshBins(form, meta) {
  const storeId = form.querySelector('[name="storeId"]').value;
  const binSelect = form.querySelector('[name="binId"]');
  const selected = binSelect.value;
  binSelect.innerHTML = binOptions(meta, storeId, selected);
}

function componentOptionsHtml(meta, selected, excludeItemId) {
  const options = (meta.componentItems || []).filter((item) => String(item.id) !== String(excludeItemId || ''));
  return `<option value="">\u2014 Select component \u2014</option>${options
    .map((item) => `<option value="${item.id}" ${String(item.id) === String(selected || '') ? 'selected' : ''}>${esc(item.name)} (${esc(item.code)})</option>`)
    .join('')}`;
}

function componentRowHtml(row, meta, excludeItemId) {
  return `<div class="component-row">
    <div class="field">
      <label>Component / accessory</label>
      <select class="select" data-component-item>${componentOptionsHtml(meta, row.componentItemId, excludeItemId)}</select>
    </div>
    <div class="field">
      <label>Qty included</label>
      <input class="input" type="number" min="0.01" step="0.01" data-component-qty value="${esc(row.quantity ?? 1)}" />
    </div>
    <div class="field">
      <label>Serial / identifier</label>
      <input class="input" data-component-serial value="${esc(row.serialNo || '')}" placeholder="Optional serial or tag" maxlength="200" />
    </div>
    <div class="field">
      <label>Notes</label>
      <input class="input" data-component-notes value="${esc(row.notes || '')}" placeholder="e.g. 8 GB RAM, drum clamp" maxlength="500" />
    </div>
    <button type="button" class="btn btn-sm btn-ghost" data-remove-component title="Remove component">${icon('trash')}</button>
  </div>`;
}

function componentCardHtml(meta, rows, excludeItemId) {
  return `<div class="card component-card" data-component-card>
    <div class="card-head">
      <div><h3>Asset Components &amp; Accessories</h3>
        <div class="sub">Record what comes under this asset. Each component keeps its own count, serial/identifier and notes. Choosing an asset item loads its component template.</div></div>
      <button class="btn btn-sm" type="button" data-add-component>${icon('plus')} Add component</button>
    </div>
    <div class="component-rows" data-component-rows>${(rows || []).map((row) => componentRowHtml(row, meta, excludeItemId)).join('')}</div>
    <div class="hint" style="padding:10px 14px">Example: Computer system \u2014 mouse (1), keyboard (1), motherboard (1), RAM (2). Drum \u2014 clamps (4), carry bag (1).</div>
  </div>`;
}

function assetFormBody(meta, asset, components = []) {
  const unitId = asset ? asset.unitId : (meta.units[0] ? meta.units[0].id : '');
  const stores = (meta.stores || []).filter((store) => !unitId || String(store.unitId) === String(unitId));
  const rooms = (meta.rooms || []).filter((room) => !unitId || String(room.unitId) === String(unitId));
  const bins = (meta.bins || []).filter((bin) => !asset || !asset.storeId || String(bin.storeId) === String(asset.storeId));
  return `
    <div class="grid grid-2" style="align-items:start">
      <div class="stack">
        <div class="card">
          <div class="card-head"><div><h3>Asset identity</h3><div class="sub">What the asset is and which unit owns it</div></div></div>
          <div class="form-section">
            <div class="form-grid">
              <div class="field span-2"><label>Asset name<span class="req">*</span></label>
                <input class="input" name="assetName" value="${esc(asset?.assetName || '')}" placeholder="e.g. Dell Latitude 5440" /></div>
              <div class="field"><label>Unit<span class="req">*</span></label>
                ${asset
                  ? `<input class="input" value="${esc(asset.unitName)}" disabled /><input type="hidden" name="unitId" value="${asset.unitId}" />`
                  : `<select class="select" name="unitId">${optionList(meta.units || [], unitId, 'id', 'name')}</select>`}</div>
              <div class="field"><label>Department</label>
                <select class="select" name="departmentId"><option value="">\u2014 No department \u2014</option>${optionList(meta.departments || [], asset?.departmentId, 'id', 'name')}</select></div>
              <div class="field"><label>Linked item</label>
                <select class="select" name="itemId"><option value="">\u2014 Not linked \u2014</option>
                  ${(meta.items || []).map((item) => `<option value="${item.id}" data-category="${item.categoryId}" ${String(item.id) === String(asset?.itemId || '') ? 'selected' : ''}>${esc(item.name)} (${esc(item.code)})</option>`).join('')}
                </select></div>
              <div class="field"><label>Asset category${asset ? '' : '<span class="req">*</span>'}</label>
                <select class="select" name="categoryId"><option value="">\u2014 Select category \u2014</option>${optionList(meta.categories || [], asset?.categoryId, 'id', 'name')}</select></div>
              <div class="field"><label>Vendor</label>
                <select class="select" name="vendorId"><option value="">\u2014 No vendor \u2014</option>${optionList(meta.vendors || [], asset?.vendorId, 'id', 'name')}</select></div>
              ${asset ? '' : `<div class="field"><label>Opening status</label>
                <select class="select" name="status">${selectOptions([
                  { value: 'created', label: 'Registered' },
                  { value: 'received', label: 'Received' },
                  { value: 'ordered', label: 'Ordered' },
                ], asset?.status || 'created', 'Use default')}</select></div>`}
              <div class="field"><label>Condition</label>
                <input class="input" name="condition" value="${esc(asset?.condition || '')}" placeholder="Good, fair, damaged..." /></div>
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card-head"><div><h3>Purchase &amp; warranty</h3><div class="sub">Acquisition details used for valuation and warranty alerts</div></div></div>
          <div class="form-section">
            <div class="form-grid">
              <div class="field"><label>Purchase date</label><input class="input" type="date" name="purchaseDate" value="${esc(asset?.purchaseDate || todayInput())}" /></div>
              <div class="field"><label>Purchase value</label><input class="input" type="number" min="0" step="0.01" name="purchaseValue" value="${esc(asset?.purchaseValue ?? '')}" /></div>
              <div class="field"><label>Warranty start</label><input class="input" type="date" name="warrantyStart" value="${esc(asset?.warrantyStart || '')}" /></div>
              <div class="field"><label>Warranty end</label><input class="input" type="date" name="warrantyEnd" value="${esc(asset?.warrantyEnd || '')}" /></div>
              <div class="field"><label>Serial number</label><input class="input" name="serialNo" value="${esc(asset?.serialNo || '')}" /></div>
              <div class="field"><label>Model number</label><input class="input" name="modelNo" value="${esc(asset?.modelNo || '')}" /></div>
              <div class="field span-2"><label>Manufacturer</label><input class="input" name="manufacturer" value="${esc(asset?.manufacturer || '')}" /></div>
            </div>
          </div>
        </div>
      </div>

      <div class="stack">
        <div class="card">
          <div class="card-head"><div><h3>Location</h3><div class="sub">Where the asset is held when it is not allocated</div></div></div>
          <div class="form-section">
            <div class="form-grid">
              <div class="field"><label>Store</label>
                <select class="select" name="storeId"><option value="">\u2014 No store \u2014</option>${optionList(stores, asset?.storeId, 'id', 'name')}</select></div>
              <div class="field"><label>Bin</label>
                <select class="select" name="binId">${binOptions({ bins }, asset?.storeId, asset?.binId)}</select></div>
              <div class="field span-2"><label>Room</label>
                <select class="select" name="roomId"><option value="">\u2014 No room \u2014</option>${optionList(rooms, asset?.roomId, 'id', 'name')}</select></div>
              <div class="field span-2"><label>Remarks</label>
                <textarea class="textarea" name="remarks" rows="4">${esc(asset?.remarks || '')}</textarea></div>
              <div class="field"><label>Insurance Policy No.</label>
                <input class="input" name="insurancePolicyNo" value="${esc(asset?.insurancePolicyNo || '')}" /></div>
              <div class="field"><label>Insurer</label>
                <input class="input" name="insurer" value="${esc(asset?.insurer || '')}" /></div>
              <div class="field"><label>Insurance Premium</label>
                <input class="input" name="insurancePremium" type="number" min="0" step="0.01" value="${esc(asset?.insurancePremium ?? 0)}" /></div>
              <div class="field"><label>Insurance Expiry Date</label>
                <input class="input" name="insuranceExpiryDate" type="date" value="${esc(asset?.insuranceExpiryDate || '')}" /></div>
              <div class="field span-2"><label>Insurance Remarks</label>
                <textarea class="textarea" name="insuranceRemarks" rows="2">${esc(asset?.insuranceRemarks || '')}</textarea></div>
            </div>
          </div>
        </div>
        <div class="card">
          <div class="card-head"><div><h3>Label</h3><div class="sub">Every asset gets a unique code and QR/barcode</div></div></div>
          <div class="form-section small muted">
            Asset codes are generated automatically as <span class="mono">AST-&lt;UNIT&gt;-&lt;YEAR&gt;-&lt;000001&gt;</span>.
            Print the QR and Code128 label from the asset page after saving.
          </div>
        </div>
      </div>
    </div>
    ${componentCardHtml(meta, components, asset?.itemId)}`;
}

export async function renderForm(ctx, options = {}) {
  const id = options.id ? Number(options.id) : null;
  ctx.view.innerHTML = `<div class="empty">${id ? 'Loading asset\u2026' : 'Preparing asset form\u2026'}</div>`;
  const meta = await api.get('/api/procurement/assets/meta');
  const detail = id ? await api.get(`/api/procurement/assets/${id}`) : null;
  const asset = detail?.asset || null;
  if (id && !detail.actions?.canEdit) {
    ctx.view.innerHTML = `<div class="card">${emptyState('Asset cannot be edited', 'This asset is disposed or you do not have permission to edit it.', '<a class="btn btn-sm" href="#/assets">Back to register</a>', 'lock')}</div>`;
    return;
  }

  ctx.view.innerHTML = `
    <div class="page-head">
      <div><h1>${id ? `Edit ${esc(asset.assetCode)}` : 'Register Asset'}</h1>
        <div class="sub">${id ? esc(asset.assetName) : 'Add an asset to the register manually, or let goods receipt create it automatically'}</div></div>
      <div class="page-actions">
        <a class="btn" href="${id ? `#/assets/${id}` : '#/assets'}">${icon('arrowLeft')} Cancel</a>
        <button class="btn btn-primary" type="button" data-save>${icon('check')} ${id ? 'Save changes' : 'Register asset'}</button>
      </div>
    </div>
    <form id="asset-form">${assetFormBody(meta, asset, detail?.components || [])}</form>`;

  const form = document.getElementById('asset-form');
  const unitSelect = form.querySelector('[name="unitId"]');
  const storeSelect = form.querySelector('[name="storeId"]');
  const itemSelect = form.querySelector('[name="itemId"]');
  const categorySelect = form.querySelector('[name="categoryId"]');
  const componentBody = form.querySelector('[data-component-rows]');

  const refreshLocations = () => {
    const unitId = unitSelect?.value;
    const stores = (meta.stores || []).filter((store) => !unitId || String(store.unitId) === String(unitId));
    storeSelect.innerHTML = `<option value="">\u2014 No store \u2014</option>${optionList(stores, storeSelect.value, 'id', 'name')}`;
    const rooms = (meta.rooms || []).filter((room) => !unitId || String(room.unitId) === String(unitId));
    form.querySelector('[name="roomId"]').innerHTML = `<option value="">\u2014 No room \u2014</option>${optionList(rooms, form.querySelector('[name="roomId"]').value, 'id', 'name')}`;
    refreshBins(form, meta);
  };

  unitSelect?.addEventListener('change', refreshLocations);
  storeSelect.addEventListener('change', () => refreshBins(form, meta));
  const loadComponentTemplate = async (itemId) => {
    if (!itemId || id) return;
    try {
      const itemDetail = await api.get(`/api/procurement/items/${itemId}`);
      componentBody.innerHTML = (itemDetail.components || [])
        .map((row) => componentRowHtml(row, meta, itemId))
        .join('');
    } catch (err) {
      toast(err.message || 'Unable to load component template.', 'error');
    }
  };

  itemSelect.addEventListener('change', async () => {
    const option = itemSelect.selectedOptions[0];
    if (option?.dataset.category) categorySelect.value = option.dataset.category;
    await loadComponentTemplate(itemSelect.value);
  });

  form.querySelector('[data-add-component]').addEventListener('click', () => {
    componentBody.insertAdjacentHTML('beforeend', componentRowHtml({}, meta, itemSelect.value));
  });
  componentBody.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-remove-component]');
    if (btn) btn.closest('.component-row').remove();
  });

  const readComponentRows = () => {
    const rows = [];
    componentBody.querySelectorAll('.component-row').forEach((row) => {
      const componentItemId = row.querySelector('[data-component-item]').value;
      if (!componentItemId) return;
      rows.push({
        componentItemId,
        quantity: row.querySelector('[data-component-qty]').value || 1,
        serialNo: row.querySelector('[data-component-serial]').value.trim(),
        notes: row.querySelector('[data-component-notes]').value.trim(),
      });
    });
    return rows;
  };

  document.querySelector('[data-save]').addEventListener('click', async () => {
    const payload = {};
    new FormData(form).forEach((value, key) => { payload[key] = value; });
    payload.components = readComponentRows();
    try {
      if (id) {
        await api.put(`/api/procurement/assets/${id}`, payload);
        toast('Asset updated.');
        navigate(`/assets/${id}`);
      } else {
        const res = await api.post('/api/procurement/assets', payload);
        toast(`Asset ${res.assetCode} registered.`);
        navigate(`/assets/${res.id}`);
      }
    } catch (err) {
      toast(err.message || 'Unable to save the asset.', 'error');
    }
  });
}

/* ================================================================== */
/* ACTION MODALS                                                       */
/* ================================================================== */
function openAllocate(meta, asset, refresh) {
  modal({
    title: `Allocate ${asset.assetCode}`,
    subtitle: 'Record who takes custody. Custody history is never deleted.',
    body: `<div class="form-grid">
      <div class="field span-2"><label>Employee<span class="req">*</span></label>
        <select class="select" data-employee><option value="">\u2014 Select employee \u2014</option>${optionList(meta.employees || [], '', 'id', 'name')}</select></div>
      <div class="field"><label>Department</label>
        <select class="select" data-department><option value="">\u2014 Use employee department \u2014</option>${optionList(meta.departments || [], asset.departmentId, 'id', 'name')}</select></div>
      <div class="field"><label>Allocated on</label><input class="input" type="date" data-date value="${todayInput()}" /></div>
      <div class="field"><label>Store</label>
        <select class="select" data-store><option value="">\u2014 Keep current \u2014</option>${optionList((meta.stores || []).filter((s) => String(s.unitId) === String(asset.unitId)), asset.storeId, 'id', 'name')}</select></div>
      <div class="field"><label>Room</label>
        <select class="select" data-room><option value="">\u2014 Keep current \u2014</option>${optionList((meta.rooms || []).filter((r) => String(r.unitId) === String(asset.unitId)), asset.roomId, 'id', 'name')}</select></div>
      <div class="field span-2"><label><input type="checkbox" data-in-use /> Mark the asset as in use immediately</label></div>
      <div class="field span-2"><label>Remarks</label><textarea class="textarea" data-remarks rows="3"></textarea></div>
    </div>`,
    footer: `<button class="btn" data-modal-close>Cancel</button><button class="btn btn-primary" data-ok>${icon('check')} Allocate</button>`,
    onMount(el, close) {
      el.querySelector('[data-ok]').addEventListener('click', async () => {
        const employeeId = el.querySelector('[data-employee]').value;
        if (!employeeId) {
          toast('Select the employee taking custody.', 'error');
          return;
        }
        try {
          await api.post(`/api/procurement/assets/${asset.id}/allocate`, {
            employeeId,
            departmentId: el.querySelector('[data-department]').value,
            storeId: el.querySelector('[data-store]').value,
            roomId: el.querySelector('[data-room]').value,
            allocatedAt: el.querySelector('[data-date]').value,
            inUse: el.querySelector('[data-in-use]').checked,
            remarks: el.querySelector('[data-remarks]').value,
          });
          close();
          toast('Asset allocated.');
          refresh();
        } catch (err) {
          toast(err.message || 'Unable to allocate the asset.', 'error');
        }
      });
    },
  });
}

function openTransfer(meta, asset, refresh) {
  modal({
    title: `Transfer ${asset.assetCode}`,
    subtitle: 'Move the asset to another custodian, store or room.',
    body: `<div class="form-grid">
      <div class="field span-2"><label>New custodian</label>
        <select class="select" data-employee><option value="">\u2014 Keep current custodian \u2014</option>${optionList(meta.employees || [], '', 'id', 'name')}</select></div>
      <div class="field"><label>Transferred on</label><input class="input" type="date" data-date value="${todayInput()}" /></div>
      <div class="field"><label>Reason</label><input class="input" data-reason placeholder="Relocation, reassignment..." /></div>
      <div class="field"><label>Store</label>
        <select class="select" data-store><option value="">\u2014 Keep current \u2014</option>${optionList((meta.stores || []).filter((s) => String(s.unitId) === String(asset.unitId)), asset.storeId, 'id', 'name')}</select></div>
      <div class="field"><label>Room</label>
        <select class="select" data-room><option value="">\u2014 Keep current \u2014</option>${optionList((meta.rooms || []).filter((r) => String(r.unitId) === String(asset.unitId)), asset.roomId, 'id', 'name')}</select></div>
      <div class="field span-2"><label>Remarks</label><textarea class="textarea" data-remarks rows="3"></textarea></div>
    </div>`,
    footer: `<button class="btn" data-modal-close>Cancel</button><button class="btn btn-primary" data-ok>${icon('send')} Transfer</button>`,
    onMount(el, close) {
      el.querySelector('[data-ok]').addEventListener('click', async () => {
        try {
          await api.post(`/api/procurement/assets/${asset.id}/transfer`, {
            toEmployeeId: el.querySelector('[data-employee]').value,
            toStoreId: el.querySelector('[data-store]').value,
            toRoomId: el.querySelector('[data-room]').value,
            transferredAt: el.querySelector('[data-date]').value,
            reason: el.querySelector('[data-reason]').value,
            remarks: el.querySelector('[data-remarks]').value,
          });
          close();
          toast('Asset transferred.');
          refresh();
        } catch (err) {
          toast(err.message || 'Unable to transfer the asset.', 'error');
        }
      });
    },
  });
}

function openMaintenance(meta, asset, refresh) {
  modal({
    title: `Maintenance for ${asset.assetCode}`,
    subtitle: 'Scheduling maintenance moves the asset under service.',
    body: `<div class="form-grid">
      <div class="field"><label>Type<span class="req">*</span></label>
        <select class="select" data-type>${selectOptions(meta.maintenanceTypes || [], 'preventive', 'Select type')}</select></div>
      <div class="field"><label>Scheduled date</label><input class="input" type="date" data-date value="${todayInput()}" /></div>
      <div class="field"><label>Vendor</label>
        <select class="select" data-vendor><option value="">\u2014 In-house \u2014</option>${optionList(meta.vendors || [], '', 'id', 'name')}</select></div>
      <div class="field"><label>Estimated cost</label><input class="input" type="number" min="0" step="0.01" data-cost value="0" /></div>
      <div class="field span-2"><label>Description<span class="req">*</span></label><textarea class="textarea" data-description rows="3" placeholder="What needs to be done?"></textarea></div>
      <div class="field span-2"><label>Remarks</label><textarea class="textarea" data-remarks rows="2"></textarea></div>
    </div>`,
    footer: `<button class="btn" data-modal-close>Cancel</button><button class="btn btn-primary" data-ok>${icon('gear')} Schedule</button>`,
    onMount(el, close) {
      el.querySelector('[data-ok]').addEventListener('click', async () => {
        try {
          await api.post(`/api/procurement/assets/${asset.id}/maintenance`, {
            maintenanceType: el.querySelector('[data-type]').value,
            vendorId: el.querySelector('[data-vendor]').value,
            cost: el.querySelector('[data-cost]').value,
            scheduledDate: el.querySelector('[data-date]').value,
            description: el.querySelector('[data-description]').value,
            remarks: el.querySelector('[data-remarks]').value,
          });
          close();
          toast('Maintenance scheduled.');
          refresh();
        } catch (err) {
          toast(err.message || 'Unable to schedule maintenance.', 'error');
        }
      });
    },
  });
}

function openMaintenanceUpdate(record, asset, refresh) {
  modal({
    title: 'Update maintenance',
    subtitle: `${asset.assetCode} \u00b7 ${record.description}`,
    body: `<div class="form-grid">
      <div class="field"><label>Status</label>
        <select class="select" data-status>${selectOptions([
          { value: 'scheduled', label: 'Scheduled' },
          { value: 'in_progress', label: 'In Progress' },
          { value: 'completed', label: 'Completed' },
          { value: 'cancelled', label: 'Cancelled' },
        ], record.status, 'Select status')}</select></div>
      <div class="field"><label>Completed date</label><input class="input" type="date" data-completed value="${esc(record.completedDate || '')}" /></div>
      <div class="field"><label>Actual cost</label><input class="input" type="number" min="0" step="0.01" data-cost value="${esc(record.cost ?? 0)}" /></div>
      <div class="field span-2"><label>Remarks</label><textarea class="textarea" data-remarks rows="3">${esc(record.remarks || '')}</textarea></div>
    </div>`,
    footer: `<button class="btn" data-modal-close>Cancel</button><button class="btn btn-primary" data-ok>${icon('check')} Save</button>`,
    onMount(el, close) {
      el.querySelector('[data-ok]').addEventListener('click', async () => {
        try {
          await api.put(`/api/procurement/assets/${asset.id}/maintenance/${record.id}`, {
            status: el.querySelector('[data-status]').value,
            completedDate: el.querySelector('[data-completed]').value,
            cost: el.querySelector('[data-cost]').value,
            remarks: el.querySelector('[data-remarks]').value,
          });
          close();
          toast('Maintenance updated.');
          refresh();
        } catch (err) {
          toast(err.message || 'Unable to update maintenance.', 'error');
        }
      });
    },
  });
}

function openVerify(meta, asset, refresh) {
  modal({
    title: `Verify ${asset.assetCode}`,
    subtitle: 'Physical verification records location accuracy and condition.',
    body: `<div class="form-grid">
      <div class="field"><label>Verification date</label><input class="input" type="date" data-date value="${todayInput()}" /></div>
      <div class="field"><label>Condition</label><input class="input" data-condition value="${esc(asset.condition || '')}" placeholder="Good, fair, damaged..." /></div>
      <div class="field span-2"><label><input type="checkbox" data-location checked /> The asset was found at its recorded location</label></div>
      <div class="field span-2"><label><input type="checkbox" data-missing /> Mark the asset as missing</label></div>
      <div class="field span-2"><label>Remarks</label><textarea class="textarea" data-remarks rows="3"></textarea></div>
    </div>`,
    footer: `<button class="btn" data-modal-close>Cancel</button><button class="btn btn-primary" data-ok>${icon('checkSquare')} Record verification</button>`,
    onMount(el, close) {
      el.querySelector('[data-ok]').addEventListener('click', async () => {
        try {
          await api.post(`/api/procurement/assets/${asset.id}/verify`, {
            verificationDate: el.querySelector('[data-date]').value,
            condition: el.querySelector('[data-condition]').value,
            locationMatch: el.querySelector('[data-location]').checked,
            markMissing: el.querySelector('[data-missing]').checked,
            remarks: el.querySelector('[data-remarks]').value,
          });
          close();
          toast('Verification recorded.');
          refresh();
        } catch (err) {
          toast(err.message || 'Unable to record verification.', 'error');
        }
      });
    },
  });
  void meta;
}

function openDisposal(meta, asset, refresh) {
  modal({
    title: `Request disposal of ${asset.assetCode}`,
    subtitle: 'Disposal takes effect only after an approver accepts the request.',
    body: `<div class="form-grid">
      <div class="field"><label>Method<span class="req">*</span></label>
        <select class="select" data-method>${selectOptions(meta.disposalMethods || [], 'scrap', 'Select method')}</select></div>
      <div class="field span-2"><label>Reason<span class="req">*</span></label><textarea class="textarea" data-reason rows="3" placeholder="Why should this asset be disposed?"></textarea></div>
      <div class="field span-2"><label>Remarks</label><textarea class="textarea" data-remarks rows="2"></textarea></div>
    </div>`,
    footer: `<button class="btn" data-modal-close>Cancel</button><button class="btn btn-danger" data-ok>${icon('trash')} Submit request</button>`,
    onMount(el, close) {
      el.querySelector('[data-ok]').addEventListener('click', async () => {
        try {
          await api.post(`/api/procurement/assets/${asset.id}/disposals`, {
            method: el.querySelector('[data-method]').value,
            reason: el.querySelector('[data-reason]').value,
            remarks: el.querySelector('[data-remarks]').value,
          });
          close();
          toast('Disposal request submitted.');
          refresh();
        } catch (err) {
          toast(err.message || 'Unable to submit the disposal request.', 'error');
        }
      });
    },
  });
}

/* ================================================================== */
/* DETAIL                                                              */
/* ================================================================== */
export async function renderDetail(ctx, options = {}) {
  const id = Number(options.id);
  ctx.view.innerHTML = '<div class="empty">Loading asset\u2026</div>';
  const [meta, detail] = await Promise.all([
    api.get('/api/procurement/assets/meta'),
    api.get(`/api/procurement/assets/${id}`),
  ]);
  const asset = detail.asset;
  const actions = detail.actions || {};
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

  const pendingDisposal = (detail.disposals || []).find((row) => row.status === 'pending') || null;
  const qr = qrDataUrl(asset.qrPayload);
  const active = detail.activeAllocation;
  const openMaintenanceRows = (detail.maintenance || []).filter((row) => ['scheduled', 'in_progress'].includes(row.status));
  const componentRows = detail.components || [];
  const componentTotal = componentRows.reduce((sum, row) => sum + (Number(row.quantity) || 0), 0);

  ctx.view.innerHTML = `
    <div class="page-head">
      <div><h1>${esc(asset.assetCode)}</h1>
        <div class="sub">${esc(asset.assetName)} \u00b7 ${esc(asset.unitName)}${asset.categoryName ? ` \u00b7 ${esc(asset.categoryName)}` : ''}</div></div>
      <div class="page-actions">
        <a class="btn" href="#/assets">${icon('arrowLeft')} Back</a>
        <button class="btn" type="button" data-label>${icon('printer')} Label</button>
        ${actions.canEdit ? `<a class="btn" href="#/assets/${asset.id}/edit">${icon('edit')} Edit</a>` : ''}
        ${actions.canAllocate ? `<button class="btn btn-primary" type="button" data-allocate>${icon('users')} Allocate</button>` : ''}
        ${actions.canReturn ? `<button class="btn" type="button" data-return>${icon('arrowLeft')} Return</button>` : ''}
        ${actions.canTransfer ? `<button class="btn" type="button" data-transfer>${icon('send')} Transfer</button>` : ''}
        ${actions.canMaintain ? `<button class="btn" type="button" data-maintenance>${icon('gear')} Maintenance</button>` : ''}
        ${actions.canVerify ? `<button class="btn" type="button" data-verify>${icon('checkSquare')} Verify</button>` : ''}
        ${actions.canRequestDisposal ? `<button class="btn btn-danger" type="button" data-dispose>${icon('trash')} Dispose</button>` : ''}
        ${actions.canApproveDisposal ? `<button class="btn btn-primary" type="button" data-approve>${icon('check')} Approve disposal</button>
          <button class="btn btn-danger" type="button" data-reject>${icon('xCircle')} Reject</button>` : ''}
        ${actions.canDelete ? `<button class="btn btn-danger" type="button" data-delete>${icon('trash')} Retire</button>` : ''}
      </div>
    </div>

    <div class="grid grid-4 mb-16">
      <div class="card"><div class="kpi"><div class="chip gray">${icon('layers')}</div><div><div class="label">Status</div><div class="value small-value">${statusOf(asset.status)}</div><div class="meta">${esc(asset.condition || 'Condition not recorded')}</div></div></div></div>
      <div class="card"><div class="kpi"><div class="chip blue">${icon('wallet')}</div><div><div class="label">Purchase value</div><div class="value small-value">${money(asset.purchaseValue)}</div><div class="meta">${asset.purchaseDate ? fmtDate(asset.purchaseDate) : 'Date not recorded'}</div></div></div></div>
      <div class="card"><div class="kpi"><div class="chip teal">${icon('users')}</div><div><div class="label">Custodian</div><div class="value small-value">${esc(active?.employeeName || 'Unassigned')}</div><div class="meta">${active ? `since ${fmtDate(active.allocatedAt)}` : 'In the register'}</div></div></div></div>
      <div class="card"><div class="kpi"><div class="chip amber">${icon('gear')}</div><div><div class="label">Open maintenance</div><div class="value">${num(openMaintenanceRows.length)}</div><div class="meta">${num((detail.verifications || []).length)} verification${(detail.verifications || []).length === 1 ? '' : 's'}</div></div></div></div>
    </div>

    ${pendingDisposal ? `<div class="alert alert-warning mb-16" style="margin-bottom:16px">
      <strong>Disposal awaiting approval.</strong> ${esc(pendingDisposal.reason)} \u00b7 requested by ${esc(pendingDisposal.requestedByName)} on ${fmtDate(pendingDisposal.requestedAt)}.
    </div>` : ''}

    <div class="grid grid-2" style="align-items:start">
      <div class="stack">
        <div class="card">
          <div class="card-head"><div><h3>Custody history</h3><div class="sub">Every allocation and return is retained</div></div></div>
          <div class="table-wrap">
            ${(detail.allocations || []).length
              ? `<table class="tbl"><thead><tr><th>Employee</th><th>Allocated</th><th>Returned</th><th>Location</th><th>Remarks</th></tr></thead>
                <tbody>${detail.allocations.map((row) => `<tr>
                  <td><span class="strong">${esc(row.employeeName)}</span><div class="small muted mono">${esc(row.employeeCode || '')}</div></td>
                  <td class="small">${fmtDate(row.allocatedAt)}<div class="small muted">${esc(row.allocatedByName || '')}</div></td>
                  <td class="small">${row.returnedAt ? fmtDate(row.returnedAt) : '<span class="badge allocated">Current</span>'}<div class="small muted">${esc(row.returnedByName || '')}</div></td>
                  <td class="small">${esc([row.roomName, row.storeName, row.binName].filter(Boolean).join(' \u00b7 ') || '\u2014')}</td>
                  <td class="small">${esc(row.remarks || '\u2014')}</td>
                </tr>`).join('')}</tbody></table>`
              : '<div class="empty small" style="padding:24px">This asset has never been allocated.</div>'}
          </div>
        </div>

        <div class="card">
          <div class="card-head"><div><h3>Transfers</h3><div class="sub">Movements between custodians and locations</div></div></div>
          <div class="table-wrap">
            ${(detail.transfers || []).length
              ? `<table class="tbl"><thead><tr><th>Date</th><th>From</th><th>To</th><th>Reason</th><th>By</th></tr></thead>
                <tbody>${detail.transfers.map((row) => `<tr>
                  <td class="small">${fmtDate(row.transferredAt)}</td>
                  <td class="small">${esc([row.fromCustodianName, row.fromRoomName, row.fromStoreName].filter(Boolean).join(' \u00b7 ') || '\u2014')}</td>
                  <td class="small">${esc([row.toCustodianName, row.toRoomName, row.toStoreName].filter(Boolean).join(' \u00b7 ') || '\u2014')}</td>
                  <td class="small">${esc(row.reason || '\u2014')}</td>
                  <td class="small">${esc(row.transferredByName || '\u2014')}</td>
                </tr>`).join('')}</tbody></table>`
              : '<div class="empty small" style="padding:24px">No transfers recorded.</div>'}
          </div>
        </div>

        <div class="card">
          <div class="card-head"><div><h3>Maintenance</h3><div class="sub">Preventive and corrective service history</div></div></div>
          <div class="table-wrap">
            ${(detail.maintenance || []).length
              ? `<table class="tbl"><thead><tr><th>Type</th><th>Scheduled</th><th>Completed</th><th class="num">Cost</th><th>Status</th><th></th></tr></thead>
                <tbody>${detail.maintenance.map((row) => `<tr>
                  <td><span class="strong">${esc(row.maintenanceType)}</span><div class="small muted">${esc(row.description)}</div></td>
                  <td class="small">${fmtDate(row.scheduledDate)}${row.vendorName ? `<div class="small muted">${esc(row.vendorName)}</div>` : ''}</td>
                  <td class="small">${row.completedDate ? fmtDate(row.completedDate) : '\u2014'}</td>
                  <td class="num">${money(row.cost)}</td>
                  <td>${statusBadge(row.status, MAINTENANCE_STATUS[row.status] || row.status)}</td>
                  <td class="actions">${actions.canMaintain && ['scheduled', 'in_progress'].includes(row.status)
                    ? `<button class="btn btn-sm btn-ghost" data-maintenance-update="${row.id}" title="Update">${icon('edit')}</button>` : ''}</td>
                </tr>`).join('')}</tbody></table>`
              : '<div class="empty small" style="padding:24px">No maintenance recorded.</div>'}
          </div>
        </div>

        <div class="card">
          <div class="card-head"><div><h3>Verification history</h3><div class="sub">Physical checks and location accuracy</div></div></div>
          <div class="table-wrap">
            ${(detail.verifications || []).length
              ? `<table class="tbl"><thead><tr><th>Date</th><th>Verified by</th><th>Location</th><th>Condition</th><th>Remarks</th></tr></thead>
                <tbody>${detail.verifications.map((row) => `<tr>
                  <td class="small">${fmtDate(row.verificationDate)}</td>
                  <td class="small">${esc(row.verifiedByName || '\u2014')}</td>
                  <td>${row.locationMatch ? '<span class="badge approved">Matched</span>' : '<span class="badge rejected">Mismatch</span>'}</td>
                  <td class="small">${esc(row.condition || '\u2014')}</td>
                  <td class="small">${esc(row.remarks || '\u2014')}</td>
                </tr>`).join('')}</tbody></table>`
              : '<div class="empty small" style="padding:24px">No verification recorded.</div>'}
          </div>
        </div>

        <div class="card">
          <div class="card-head"><div><h3>Disposal requests</h3><div class="sub">Requests are approved before the asset is written off</div></div></div>
          <div class="table-wrap">
            ${(detail.disposals || []).length
              ? `<table class="tbl"><thead><tr><th>Method</th><th>Reason</th><th>Requested</th><th>Status</th><th>Approved</th></tr></thead>
                <tbody>${detail.disposals.map((row) => `<tr>
                  <td class="small">${esc(row.method)}</td>
                  <td class="small">${esc(row.reason)}${row.rejectionReason ? `<div class="small muted">Rejected: ${esc(row.rejectionReason)}</div>` : ''}</td>
                  <td class="small">${fmtDate(row.requestedAt)}<div class="small muted">${esc(row.requestedByName)}</div></td>
                  <td>${statusBadge(row.status)}</td>
                  <td class="small">${row.approvedAt ? `${fmtDate(row.approvedAt)}<div class="small muted">${esc(row.approvedByName)}</div>` : '\u2014'}</td>
                </tr>`).join('')}</tbody></table>`
              : '<div class="empty small" style="padding:24px">No disposal requested.</div>'}
          </div>
        </div>
      </div>

      <div class="stack">
        <div class="card">
          <div class="card-head"><div><h3>Asset identity</h3><div class="sub">Code, classification and acquisition</div></div></div>
          <div class="form-section">
            <div class="stack small">
              <div class="row"><span class="muted" style="width:135px">Asset code</span><span class="mono strong">${esc(asset.assetCode)}</span></div>
              <div class="row"><span class="muted" style="width:135px">Category</span><span>${esc(asset.categoryName || '\u2014')}</span></div>
              <div class="row"><span class="muted" style="width:135px">Item</span><span>${asset.itemCode ? `${esc(asset.itemName)} <span class="small muted mono">${esc(asset.itemCode)}</span>` : '\u2014'}</span></div>
              <div class="row"><span class="muted" style="width:135px">Serial number</span><span class="mono">${esc(asset.serialNo || '\u2014')}</span></div>
              <div class="row"><span class="muted" style="width:135px">Model</span><span>${esc(asset.modelNo || '\u2014')}</span></div>
              <div class="row"><span class="muted" style="width:135px">Manufacturer</span><span>${esc(asset.manufacturer || '\u2014')}</span></div>
              <div class="row"><span class="muted" style="width:135px">Vendor</span><span>${asset.vendorId ? esc(asset.vendorName) : '\u2014'}</span></div>
              <div class="row"><span class="muted" style="width:135px">Purchase date</span><span>${asset.purchaseDate ? fmtDate(asset.purchaseDate) : '\u2014'}</span></div>
              <div class="row"><span class="muted" style="width:135px">Warranty</span><span>${asset.warrantyStart || asset.warrantyEnd ? `${asset.warrantyStart ? fmtDate(asset.warrantyStart) : '\u2014'} to ${asset.warrantyEnd ? fmtDate(asset.warrantyEnd) : '\u2014'}` : '\u2014'}</span></div>
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card-head"><div><h3>Components &amp; accessories</h3>
            <div class="sub">${num(componentRows.length)} component item${componentRows.length === 1 ? '' : 's'} \u00b7 ${num(componentTotal)} units included under this asset</div></div></div>
          <div class="table-wrap">
            ${componentRows.length
              ? `<table class="tbl"><thead><tr><th>Component</th><th class="num">Qty</th><th>Serial / identifier</th><th>Notes</th></tr></thead>
                <tbody>${componentRows.map((row) => `<tr>
                  <td><span class="strong">${esc(row.itemName)}</span><div class="small muted mono">${esc(row.itemCode || '')}</div></td>
                  <td class="num strong">${num(row.quantity)}</td>
                  <td class="small mono">${esc(row.serialNo || '\u2014')}</td>
                  <td class="small">${esc(row.notes || '\u2014')}</td>
                </tr>`).join('')}</tbody></table>`
              : '<div class="empty small" style="padding:24px">No components recorded under this asset.</div>'}
          </div>
        </div>

        <div class="card">
          <div class="card-head"><div><h3>Location &amp; source</h3><div class="sub">Where it sits and which transaction created it</div></div></div>
          <div class="form-section">
            <div class="stack small">
              <div class="row"><span class="muted" style="width:135px">Unit</span><span>${esc(asset.unitName)}</span></div>
              <div class="row"><span class="muted" style="width:135px">Department</span><span>${esc(asset.departmentName || '\u2014')}</span></div>
              <div class="row"><span class="muted" style="width:135px">Store / bin</span><span>${esc([asset.storeName, asset.binName].filter(Boolean).join(' \u00b7 ') || '\u2014')}</span></div>
              <div class="row"><span class="muted" style="width:135px">Room</span><span>${esc(asset.roomName || '\u2014')}</span></div>
              <div class="row"><span class="muted" style="width:135px">Custodian</span><span>${esc(asset.custodianName || '\u2014')}</span></div>
              <div class="row"><span class="muted" style="width:135px">Purchase order</span><span>${asset.poId ? `<a href="#/purchase-orders/${asset.poId}">${esc(asset.poNo)}</a>` : '\u2014'}</span></div>
              <div class="row"><span class="muted" style="width:135px">Goods receipt</span><span>${asset.grnId ? `<a href="#/grns/${asset.grnId}">${esc(asset.grnNo)}</a>` : '\u2014'}</span></div>
              <div class="row"><span class="muted" style="width:135px">Invoice</span><span>${asset.invoiceId ? `<a href="#/invoices/${asset.invoiceId}">${esc(asset.invoiceNo)}</a>` : '\u2014'}</span></div>
              <div class="row"><span class="muted" style="width:135px">Registered</span><span>${fmtDate(asset.createdAt)}${asset.createdByName ? ` \u00b7 ${esc(asset.createdByName)}` : ''}</span></div>
              ${asset.remarks ? `<div class="row"><span class="muted" style="width:135px">Remarks</span><span>${esc(asset.remarks)}</span></div>` : ''}
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card-head"><div><h3>QR &amp; barcode label</h3><div class="sub">Scanning the QR opens this page</div></div>
            <button class="btn btn-sm" type="button" data-label>${icon('printer')} Print</button></div>
          <div class="form-section">
            <div class="row" style="align-items:flex-start;gap:16px">
              <div style="text-align:center">
                ${qr ? `<img src="${qr}" alt="QR code for ${esc(asset.assetCode)}" style="width:130px;height:130px" />` : '<div class="hint">QR unavailable</div>'}
                <div class="small muted mt-12">${esc(asset.assetCode)}</div>
              </div>
              <div class="stack small" style="min-width:0;flex:1">
                <div><span class="muted">Barcode value</span><div class="mono strong">${esc(asset.barcodeValue)}</div></div>
                <div><span class="muted">QR resolves to</span><div class="small" style="word-break:break-all">${esc(asset.qrPayload || '\u2014')}</div></div>
                <div><span class="muted">Labels printed</span><div>${num((detail.labels || []).length)}</div></div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>`;

  ctx.view.querySelectorAll('[data-label]').forEach((button) => {
    button.addEventListener('click', () => printAssetLabel(id));
  });
  ctx.view.querySelector('[data-allocate]')?.addEventListener('click', () => openAllocate(meta, asset, refresh));
  ctx.view.querySelector('[data-transfer]')?.addEventListener('click', () => openTransfer(meta, asset, refresh));
  ctx.view.querySelector('[data-maintenance]')?.addEventListener('click', () => openMaintenance(meta, asset, refresh));
  ctx.view.querySelector('[data-verify]')?.addEventListener('click', () => openVerify(meta, asset, refresh));
  ctx.view.querySelector('[data-dispose]')?.addEventListener('click', () => openDisposal(meta, asset, refresh));
  ctx.view.querySelectorAll('[data-maintenance-update]').forEach((button) => {
    button.addEventListener('click', () => {
      const record = (detail.maintenance || []).find((row) => String(row.id) === String(button.dataset.maintenanceUpdate));
      if (record) openMaintenanceUpdate(record, asset, refresh);
    });
  });

  ctx.view.querySelector('[data-return]')?.addEventListener('click', async () => {
    const result = await actionDialog({
      title: `Return ${asset.assetCode}`,
      subtitle: 'The asset returns to the register and remains unallocated.',
      confirmText: 'Record return',
    });
    if (!result) return;
    await act(() => api.post(`/api/procurement/assets/${id}/return`, { remarks: result.comments }), 'Asset returned.');
  });

  ctx.view.querySelector('[data-approve]')?.addEventListener('click', async () => {
    if (!pendingDisposal) return;
    const ok = await confirmDialog({
      title: 'Approve disposal',
      message: `Approve the disposal of ${asset.assetCode}? The asset will be marked disposed and can no longer be allocated.`,
      confirmText: 'Approve disposal',
      danger: true,
    });
    if (!ok) return;
    await act(
      () => api.post(`/api/procurement/assets/${id}/disposals/${pendingDisposal.id}/approve`, {}),
      'Disposal approved.'
    );
  });

  ctx.view.querySelector('[data-reject]')?.addEventListener('click', async () => {
    if (!pendingDisposal) return;
    const result = await actionDialog({
      title: 'Reject disposal',
      subtitle: 'The asset remains in the register.',
      requireComment: true,
      confirmText: 'Reject request',
      danger: true,
    });
    if (!result) return;
    await act(
      () => api.post(`/api/procurement/assets/${id}/disposals/${pendingDisposal.id}/reject`, { rejectionReason: result.comments }),
      'Disposal rejected.'
    );
  });

  ctx.view.querySelector('[data-delete]')?.addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: 'Retire asset',
      message: 'Retire this asset from the register? The record is retained for audit.',
      confirmText: 'Retire asset',
      danger: true,
    });
    if (!ok) return;
    await act(async () => {
      await api.del(`/api/procurement/assets/${id}`);
      navigate('/assets');
    }, 'Asset retired.');
  });
}
