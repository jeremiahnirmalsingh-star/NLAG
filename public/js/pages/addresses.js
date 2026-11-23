import { api } from '../api.js';
import { can } from '../state.js';
import { esc, icon, field, modal, confirmDialog, toast, emptyState, serializeForm } from '../ui.js';

/** Common address and map-point master shared by all modules. */
export async function render(ctx) {
  ctx.view.innerHTML = '<div class="empty">Loading addresses…</div>';
  const res = await api.get('/api/masters/addresses');
  const addresses = res.addresses || [];
  const editable = can('org.manage');

  ctx.view.innerHTML = `
    <div class="page-head">
      <div><h1>Common Addresses</h1><div class="sub">One address and map point per place, reused by Procurement, Fleet Desk and Bills</div></div>
      <div class="page-actions">
        ${editable ? `<button class="btn btn-primary" data-add>${icon('plus')} New address</button>` : ''}
      </div>
    </div>
    <div class="card">
      ${addresses.length
        ? `<div class="table-wrap"><table class="table">
            <thead><tr><th>Label</th><th>Location</th><th>Map</th><th>Status</th>${editable ? '<th></th>' : ''}</tr></thead>
            <tbody>${addresses.map((a) => `<tr>
              <td><b>${esc(a.label)}</b></td>
              <td>${esc([a.line1, a.line2, a.city, a.state, a.pincode].filter(Boolean).join(', ') || '—')}</td>
              <td>${a.mapsUrl ? `<a href="${esc(a.mapsUrl)}" target="_blank" rel="noopener noreferrer">${icon('external')}</a>` : '—'}</td>
              <td>${a.active ? 'Active' : 'Inactive'}</td>
              ${editable ? `<td class="actions">
                <button class="btn btn-sm btn-ghost" data-edit="${a.id}" title="Edit">${icon('edit')}</button>
                <button class="btn btn-sm btn-ghost" data-delete="${a.id}" title="Remove">${icon('trash')}</button>
              </td>` : ''}
            </tr>`).join('')}</tbody>
          </table></div>`
        : emptyState('No common addresses yet', 'Add an address once and link it wherever that place is needed.', editable ? '<button class="btn btn-sm btn-primary" data-add>New address</button>' : '', 'branch')}
    </div>`;

  const openForm = (row) => {
    const v = (key, fallback = '') => (row && row[key] != null ? row[key] : fallback);
    const m = modal({
      title: `${row ? 'Edit' : 'New'} address`,
      size: 'wide',
      body: `<form id="address-form" class="form-grid">
        ${field({ label: 'Label', name: 'label', value: v('label'), required: true, placeholder: 'e.g. Main Campus — Godown 1', span: true })}
        ${field({ label: 'Address line 1', name: 'line1', value: v('line1') })}
        ${field({ label: 'Address line 2', name: 'line2', value: v('line2') })}
        ${field({ label: 'City', name: 'city', value: v('city') })}
        ${field({ label: 'State', name: 'state', value: v('state') })}
        ${field({ label: 'PIN code', name: 'pincode', value: v('pincode') })}
        ${field({ label: 'Country', name: 'country', value: v('country', 'India') })}
        ${field({ label: 'Latitude', name: 'lat', value: v('lat', ''), attrs: 'step="any"' })}
        ${field({ label: 'Longitude', name: 'lng', value: v('lng', ''), attrs: 'step="any"' })}
        ${field({ label: 'Google Maps link', name: 'mapsUrl', value: v('mapsUrl'), span: true })}
        ${field({ label: 'Status', name: 'active', type: 'select', value: row && !row.active ? '0' : '1', options: [{ value: '1', label: 'Active' }, { value: '0', label: 'Inactive' }] })}
        <div class="alert alert-danger hidden" data-err></div>
      </form>`,
      footer: `<button class="btn" data-modal-close>Cancel</button><button class="btn btn-primary" data-save>${icon('check')} Save</button>`,
      onMount(el, close) {
        el.querySelector('[data-save]').addEventListener('click', async () => {
          const form = el.querySelector('#address-form');
          const err = el.querySelector('[data-err]');
          err.classList.add('hidden');
          const data = serializeForm(form);
          data.active = data.active === '1';
          try {
            if (row) await api.put(`/api/masters/addresses/${row.id}`, data);
            else await api.post('/api/masters/addresses', data);
            close();
            toast('Address saved.');
            await render(ctx);
          } catch (e) {
            err.textContent = e.message;
            err.classList.remove('hidden');
          }
        });
      },
    });
    void m;
  };

  ctx.view.querySelectorAll('[data-add]').forEach((b) => b.addEventListener('click', () => openForm(null)));
  ctx.view.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => {
    openForm(addresses.find((a) => String(a.id) === b.dataset.edit));
  }));
  ctx.view.querySelectorAll('[data-delete]').forEach((b) => b.addEventListener('click', async () => {
    const row = addresses.find((a) => String(a.id) === b.dataset.delete);
    const ok = await confirmDialog({
      title: 'Remove address',
      message: `Remove "${row.label}"? Existing records keep their own address text.`,
      confirmText: 'Remove',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.del(`/api/masters/addresses/${row.id}`);
      toast('Address removed.');
      await render(ctx);
    } catch (e) {
      toast(e.message || 'Could not remove address.', 'error');
    }
  }));
}
