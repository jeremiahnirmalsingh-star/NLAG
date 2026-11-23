import { api } from '../api.js';
import { can, state } from '../state.js';
import { navigate } from '../router.js';
import {
  esc, icon, statusBadge, emptyState, toast, field, modal, confirmDialog,
} from '../ui.js';

const TYPE_LABEL = { main: 'Main store', sub: 'Sub store', transit: 'Transit store' };
const STATUS_OPTIONS = [
  { value: 'active', label: 'Active' },
  { value: 'inactive', label: 'Inactive' },
];

function defaultUnitId(units) {
  const ids = state.currentUnitIds.length ? state.currentUnitIds : state.memberUnitIds;
  const found = units.find((u) => String(u.id) === String(ids[0]));
  return found ? String(found.id) : (units.length ? String(units[0].id) : '');
}

function optionsHtml(options, selected) {
  return options
    .map((o) => `<option value="${esc(o.value)}" ${String(o.value) === String(selected) ? 'selected' : ''}>${esc(o.label)}</option>`)
    .join('');
}

// Master data may arrive in camelCase (API) or snake_case (raw row).
function readField(row, camel, snake) {
  if (!row) return '';
  const v = row[camel] !== undefined && row[camel] !== null ? row[camel] : row[snake];
  return v === undefined || v === null ? '' : String(v).trim();
}

function storeAddress(store) {
  return [readField(store, 'addressLine1', 'address_line1'), readField(store, 'addressLine2', 'address_line2'),
    readField(store, 'city', 'city'), readField(store, 'state', 'state'), readField(store, 'pincode', 'pincode')]
    .filter(Boolean)
    .join(', ');
}

function storeIncharge(store) {
  const person = [readField(store, 'inchargeName', 'incharge_name'), readField(store, 'inchargeDesignation', 'incharge_designation')]
    .filter(Boolean)
    .join(' \u00b7 ');
  const contact = [readField(store, 'inchargeMobile', 'incharge_mobile'), readField(store, 'inchargeEmail', 'incharge_email')]
    .filter(Boolean)
    .join(' \u00b7 ');
  return { person, contact };
}

/* ================================================================== */
/* Page                                                                */
/* ================================================================== */
export async function render(ctx) {
  ctx.view.innerHTML = `<div class="empty">Loading stores\u2026</div>`;
  const [meta, res] = await Promise.all([
    api.get('/api/procurement/stores/meta'),
    api.get('/api/procurement/stores'),
  ]);

  const stores = res.stores || [];
  const binCount = stores.reduce((sum, s) => sum + (s.bins || []).length, 0);
  const unitOptions = meta.units.map((u) => ({ value: u.id, label: `${u.code} \u2014 ${u.name}` }));
  const typeOptions = meta.storeTypes.map((t) => ({ value: t.value, label: t.label }));

  ctx.view.innerHTML = `
    <div class="page-head">
      <div><h1>Stores</h1><div class="sub">Stores and storage bins used for stock receipts, issues and transfers</div></div>
      <div class="page-actions">
        ${can('store.manage') ? `<button class="btn btn-primary" type="button" data-new-store>${icon('plus')} New Store</button>` : ''}
      </div>
    </div>

    <div class="grid grid-3 mb-16">
      <div class="card"><div class="kpi"><div class="chip blue">${icon('database')}</div><div><div class="label">Stores</div><div class="value">${stores.length}</div><div class="meta">Across the selected units</div></div></div></div>
      <div class="card"><div class="kpi"><div class="chip green">${icon('layers')}</div><div><div class="label">Bins</div><div class="value">${binCount}</div><div class="meta">Storage locations configured</div></div></div></div>
      <div class="card"><div class="kpi"><div class="chip amber">${icon('home')}</div><div><div class="label">Main stores</div><div class="value">${stores.filter((s) => s.storeType === 'main').length}</div><div class="meta">Primary receipt points</div></div></div></div>
    </div>

    ${stores.length
      ? `<div class="stack">${stores.map((store) => `
          <div class="card">
            <div class="card-head">
              <div>
                <h3>${esc(store.name)} <span class="chip gray">${esc(TYPE_LABEL[store.storeType] || store.storeType)}</span></h3>
                <div class="sub">${esc(store.code)} \u00b7 ${esc(store.unitName)} \u00b7 ${(store.bins || []).length} bin${(store.bins || []).length === 1 ? '' : 's'}</div>
              </div>
              <div style="margin-left:auto;display:flex;gap:6px;align-items:center">
                ${statusBadge(store.active ? 'active' : 'inactive')}
                ${can('store.manage') ? `<button class="btn btn-sm" type="button" data-add-bin="${store.id}">${icon('plus')} Bin</button>
                <button class="btn btn-sm btn-ghost" type="button" data-edit-store="${store.id}" title="Edit store">${icon('edit')}</button>
                <button class="btn btn-sm btn-ghost" type="button" data-retire-store="${store.id}" title="Retire store">${icon('trash')}</button>` : ''}
              </div>
            </div>
            ${(() => {
              const address = storeAddress(store);
              const incharge = storeIncharge(store);
              if (!address && !incharge.person && !incharge.contact) return '';
              return `<div class="card-body" style="padding-top:0;padding-bottom:10px">
                <div class="row" style="gap:6px 22px;flex-wrap:wrap">
                  ${address ? `<div class="small muted" style="display:flex;gap:6px;align-items:flex-start">${icon('home')}<span>${esc(address)}</span></div>` : ''}
                  ${incharge.person ? `<div class="small muted" style="display:flex;gap:6px;align-items:flex-start">${icon('user')}<span>In-charge: ${esc(incharge.person)}${incharge.contact ? ` \u00b7 ${esc(incharge.contact)}` : ''}</span></div>` : ''}
                  ${!incharge.person && incharge.contact ? `<div class="small muted" style="display:flex;gap:6px;align-items:flex-start">${icon('user')}<span>In-charge: ${esc(incharge.contact)}</span></div>` : ''}
                </div>
              </div>`;
            })()}
            <div class="table-wrap">
              ${(store.bins || []).length
                ? `<table class="tbl">
                    <thead><tr><th>Bin</th><th>Code</th><th>Status</th><th></th></tr></thead>
                    <tbody>${store.bins.map((bin) => `<tr>
                      <td class="strong">${esc(bin.name)}</td>
                      <td class="mono small">${esc(bin.code)}</td>
                      <td>${statusBadge(bin.active ? 'active' : 'inactive')}</td>
                      <td class="actions">
                        ${can('store.manage') ? `<button class="btn btn-sm btn-ghost" type="button" data-edit-bin="${store.id}:${bin.id}" title="Edit bin">${icon('edit')}</button>
                        <button class="btn btn-sm btn-ghost" type="button" data-retire-bin="${store.id}:${bin.id}" title="Retire bin">${icon('trash')}</button>` : ''}
                      </td>
                    </tr>`).join('')}</tbody></table>`
                : `<div class="empty" style="padding:22px">${icon('layers')}<h4>No bins</h4><div class="small">Add bins to organise stock within this store.</div></div>`}
            </div>
          </div>`).join('')}</div>`
      : `<div class="card">${emptyState(
          'No stores configured',
          'Create a store so receipts, issues and stock balances can be tracked.',
          can('store.manage') ? `<button class="btn btn-sm btn-primary" type="button" data-new-store>New Store</button>` : '',
          'database'
        )}</div>`}`;

  const findStore = (id) => stores.find((s) => String(s.id) === String(id));

  const openStoreForm = (row = null) => {
    const body = `<form id="store-form" class="form-grid" autocomplete="off">
      ${field({ label: 'Store Name', name: 'name', value: row?.name || '', required: true, span: true })}
      ${field({ label: 'Store Code', name: 'code', value: row?.code || '', required: true, placeholder: 'e.g. ST-MAIN' })}
      <div class="field">
        <label>Store Type<span class="req">*</span></label>
        <select class="select" name="storeType" required>${optionsHtml(typeOptions, row?.storeType || 'main')}</select>
      </div>
      <div class="field">
        <label>Unit<span class="req">*</span></label>
        <select class="select" name="unitId" required>${optionsHtml(unitOptions, row ? row.unitId : defaultUnitId(meta.units))}</select>
      </div>
      ${field({ label: 'Status', name: 'status', type: 'select', value: row?.active === false ? 'inactive' : 'active', options: STATUS_OPTIONS })}
      ${field({ label: 'Address line 1', name: 'addressLine1', value: readField(row, 'addressLine1', 'address_line1'), span: true })}
      ${field({ label: 'Address line 2', name: 'addressLine2', value: readField(row, 'addressLine2', 'address_line2'), span: true })}
      ${field({ label: 'City', name: 'city', value: readField(row, 'city', 'city') })}
      ${field({ label: 'State', name: 'state', value: readField(row, 'state', 'state') })}
      ${field({ label: 'Pincode', name: 'pincode', value: readField(row, 'pincode', 'pincode') })}
      ${field({ label: 'In-charge Name', name: 'inchargeName', value: readField(row, 'inchargeName', 'incharge_name') })}
      ${field({ label: 'In-charge Designation', name: 'inchargeDesignation', value: readField(row, 'inchargeDesignation', 'incharge_designation') })}
      ${field({ label: 'In-charge Mobile', name: 'inchargeMobile', value: readField(row, 'inchargeMobile', 'incharge_mobile') })}
      ${field({ label: 'In-charge Email', name: 'inchargeEmail', type: 'email', value: readField(row, 'inchargeEmail', 'incharge_email') })}
    </form>`;

    const m = modal({
      title: `${row ? 'Edit' : 'New'} store`,
      subtitle: row ? `${row.code} \u00b7 ${row.name}` : 'Add a store to the selected unit',
      body,
      footer: `<button class="btn" data-cancel>Cancel</button>
               <button class="btn btn-primary" data-save>${icon('check')} ${row ? 'Save changes' : 'Create store'}</button>`,
      size: 'wide',
    });

    m.el.querySelector('[data-cancel]').addEventListener('click', m.close);
    m.el.querySelector('[data-save]').addEventListener('click', async () => {
      const form = m.el.querySelector('#store-form');
      const data = {
        name: form.name.value.trim(),
        code: form.code.value.trim(),
        storeType: form.storeType.value,
        unitId: form.unitId.value,
        active: form.status.value === 'active',
        addressLine1: form.addressLine1.value.trim(),
        addressLine2: form.addressLine2.value.trim(),
        city: form.city.value.trim(),
        state: form.state.value.trim(),
        pincode: form.pincode.value.trim(),
        inchargeName: form.inchargeName.value.trim(),
        inchargeDesignation: form.inchargeDesignation.value.trim(),
        inchargeMobile: form.inchargeMobile.value.trim(),
        inchargeEmail: form.inchargeEmail.value.trim(),
      };
      if (!data.name || !data.code) {
        toast('Store name and code are required.', 'error');
        return;
      }
      try {
        if (row) {
          await api.put(`/api/procurement/stores/${row.id}`, data);
          toast('Store updated.');
        } else {
          await api.post('/api/procurement/stores', data);
          toast('Store created.');
        }
        m.close();
        navigate('/stores');
      } catch (e) {
        toast(e.message || 'Unable to save the store.', 'error');
      }
    });
  };

  const openBinForm = (store, bin = null) => {
    const body = `<form id="bin-form" class="form-grid" autocomplete="off">
      ${field({ label: 'Bin Name', name: 'name', value: bin?.name || '', required: true, span: true })}
      ${field({ label: 'Bin Code', name: 'code', value: bin?.code || '', required: true, placeholder: 'e.g. A-01-01' })}
      ${field({ label: 'Status', name: 'status', type: 'select', value: bin?.active === false ? 'inactive' : 'active', options: STATUS_OPTIONS })}
    </form>`;

    const m = modal({
      title: `${bin ? 'Edit' : 'New'} bin`,
      subtitle: `${store.code} \u00b7 ${store.name}`,
      body,
      footer: `<button class="btn" data-cancel>Cancel</button>
               <button class="btn btn-primary" data-save>${icon('check')} ${bin ? 'Save changes' : 'Create bin'}</button>`,
    });

    m.el.querySelector('[data-cancel]').addEventListener('click', m.close);
    m.el.querySelector('[data-save]').addEventListener('click', async () => {
      const form = m.el.querySelector('#bin-form');
      const data = {
        name: form.name.value.trim(),
        code: form.code.value.trim(),
        active: form.status.value === 'active',
      };
      if (!data.name || !data.code) {
        toast('Bin name and code are required.', 'error');
        return;
      }
      try {
        if (bin) {
          await api.put(`/api/procurement/stores/${store.id}/bins/${bin.id}`, data);
          toast('Bin updated.');
        } else {
          await api.post(`/api/procurement/stores/${store.id}/bins`, data);
          toast('Bin created.');
        }
        m.close();
        navigate('/stores');
      } catch (e) {
        toast(e.message || 'Unable to save the bin.', 'error');
      }
    });
  };

  for (const btn of ctx.view.querySelectorAll('[data-new-store]')) btn.addEventListener('click', () => openStoreForm());
  for (const btn of ctx.view.querySelectorAll('[data-edit-store]')) {
    btn.addEventListener('click', () => openStoreForm(findStore(btn.dataset.editStore)));
  }
  for (const btn of ctx.view.querySelectorAll('[data-add-bin]')) {
    btn.addEventListener('click', () => openBinForm(findStore(btn.dataset.addBin)));
  }
  for (const btn of ctx.view.querySelectorAll('[data-edit-bin]')) {
    const [storeId, binId] = btn.dataset.editBin.split(':');
    const store = findStore(storeId);
    btn.addEventListener('click', () => openBinForm(store, (store.bins || []).find((b) => String(b.id) === binId)));
  }
  for (const btn of ctx.view.querySelectorAll('[data-retire-bin]')) {
    const [storeId, binId] = btn.dataset.retireBin.split(':');
    const store = findStore(storeId);
    const bin = (store.bins || []).find((b) => String(b.id) === binId);
    btn.addEventListener('click', async () => {
      const ok = await confirmDialog({
        title: 'Retire bin',
        message: `Retire ${bin.code} \u00b7 ${bin.name}? Existing stock history is preserved.`,
        confirmText: 'Retire bin',
        danger: true,
      });
      if (!ok) return;
      try {
        await api.del(`/api/procurement/stores/${store.id}/bins/${bin.id}`);
        toast('Bin retired.');
        navigate('/stores');
      } catch (e) {
        toast(e.message || 'Unable to retire the bin.', 'error');
      }
    });
  }
  for (const btn of ctx.view.querySelectorAll('[data-retire-store]')) {
    const store = findStore(btn.dataset.retireStore);
    btn.addEventListener('click', async () => {
      const ok = await confirmDialog({
        title: 'Retire store',
        message: `Retire ${store.code} \u00b7 ${store.name}? Retire its bins first. Existing stock history is preserved.`,
        confirmText: 'Retire store',
        danger: true,
      });
      if (!ok) return;
      try {
        await api.del(`/api/procurement/stores/${store.id}`);
        toast('Store retired.');
        navigate('/stores');
      } catch (e) {
        toast(e.message || 'Unable to retire the store.', 'error');
      }
    });
  }
}

export function renderList(ctx) {
  return render(ctx);
}
