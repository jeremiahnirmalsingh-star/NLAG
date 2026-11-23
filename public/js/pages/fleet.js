import { api } from '../api.js';
import { can } from '../state.js';
import { navigate, withQuery } from '../router.js';
import {
  esc, icon, statusBadge, emptyState, toast, field, modal, confirmDialog, actionDialog,
  fmtDate, serializeForm,
} from '../ui.js';

const BOOKING_STATUS = {
  PENDING: 'Pending',
  ASSIGNED: 'Assigned',
  REJECTED: 'Rejected',
  COMPLETED: 'Completed',
};

/* Departments, Employees and Users are common ABMDAS masters maintained in the
   People & Organization group. Fleet Masters only owns trip-specific data. */
const MASTER_MODELS = {
  areas: {
    label: 'Areas',
    singular: 'Area',
    columns: ['Name', 'Address', 'Common address', 'Map', 'Status'],
  },
  vehicles: {
    label: 'Vehicles',
    singular: 'Vehicle',
    columns: ['Registration', 'Model', 'Seats', 'Linked asset', 'Status'],
  },
};

function badge(status) {
  return statusBadge(status, BOOKING_STATUS[status] || status);
}

function localDateTime(date) {
  const d = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return d.toISOString().slice(0, 16);
}

function defaultStart() {
  const d = new Date();
  d.setHours(d.getHours() + 1, 0, 0, 0);
  return localDateTime(d);
}

function defaultEnd() {
  const d = new Date();
  d.setHours(d.getHours() + 3, 0, 0, 0);
  return localDateTime(d);
}

/* ------------------------------ Bookings ---------------------------- */

export async function renderBookings(ctx) {
  ctx.view.innerHTML = '<div class="empty">Loading vehicle bookings…</div>';
  const [meta, res] = await Promise.all([
    api.get('/api/fleet/meta'),
    api.get('/api/fleet/bookings'),
  ]);
  const bookings = res.bookings || [];
  const p = meta.permissions || {};

  ctx.view.innerHTML = `
    <div class="page-head">
      <div><h1>Vehicle Bookings</h1><div class="sub">Request, assign and track fleet trips for NLAGC departments</div></div>
      <div class="page-actions">
        <a class="btn" href="#/fleet/masters">${icon('gear')} Fleet Masters</a>
        ${p.create ? `<a class="btn btn-primary" href="#/fleet/bookings/new">${icon('plus')} New Booking</a>` : ''}
      </div>
    </div>
    <div class="card">
      ${bookings.length
        ? `<div class="table-wrap"><table class="table">
            <thead><tr><th>Booking</th><th>Requester</th><th>Route</th><th>Trip start</th><th>Persons</th><th>Status</th><th></th></tr></thead>
            <tbody>${bookings.map((b) => `<tr>
              <td><a href="#/fleet/bookings/${b.id}"><b>${esc(b.bookingNo)}</b></a><div class="small muted">${esc(b.departmentName || '—')}</div></td>
              <td>${esc(b.requesterName || '—')}</td>
              <td>${esc(b.pickupName)} → ${esc(b.dropName)}<div class="small muted">${esc(b.purpose)}</div></td>
              <td>${esc(fmtDate(b.startAt, true))}</td>
              <td>${b.passengers}</td>
              <td>${badge(b.status)}</td>
              <td class="actions"><a class="btn btn-sm btn-ghost" href="#/fleet/bookings/${b.id}" title="View booking">${icon('eye')}</a></td>
            </tr>`).join('')}</tbody>
          </table></div>`
        : emptyState(
            'No vehicle bookings yet',
            'Booking requests raised through Fleet Desk will appear here.',
            p.create ? '<a class="btn btn-sm btn-primary" href="#/fleet/bookings/new">New Booking</a>' : '',
            'car'
          )}
    </div>`;
}

export async function renderBookingForm(ctx) {
  const meta = await api.get('/api/fleet/meta');
  const areas = meta.areas || [];
  const departments = meta.departments || [];
  const noAreas = areas.filter((a) => a.active);

  ctx.view.innerHTML = `
    <div class="page-head">
      <div><h1>New Vehicle Booking</h1><div class="sub">Request transport for an official trip</div></div>
      <div class="page-actions"><a class="btn" href="#/fleet">${icon('arrowLeft')} Back to bookings</a></div>
    </div>
    <div class="card" style="max-width:820px">
      ${noAreas.length < 2
        ? `<div class="alert alert-danger">At least two active pickup/drop areas are needed before a booking can be raised. ${meta.permissions && meta.permissions.manageMasters ? '<a href="#/fleet/masters">Set up fleet masters</a>' : 'Please ask the transport incharge to set up fleet areas.'}</div>`
        : `<form id="fleet-booking-form" class="form-section">
            <div class="form-grid">
              ${field({ label: 'Department', name: 'departmentId', type: 'select', options: [{ value: '', label: '— Optional —' }, ...departments.filter((d) => d.active).map((d) => ({ value: d.id, label: d.name }))] })}
              ${field({ label: 'Number of persons', name: 'passengers', type: 'number', value: 1, required: true, attrs: 'min="1" max="60"' })}
              ${field({ label: 'Pickup location', name: 'pickupId', type: 'select', options: [{ value: '', label: '— Select pickup —' }, ...noAreas.map((a) => ({ value: a.id, label: a.name }))], required: true })}
              ${field({ label: 'Drop location', name: 'dropId', type: 'select', options: [{ value: '', label: '— Select drop —' }, ...noAreas.map((a) => ({ value: a.id, label: a.name }))], required: true })}
              ${field({ label: 'Trip start', name: 'startAt', type: 'datetime-local', value: defaultStart(), required: true })}
              ${field({ label: 'Trip end', name: 'endAt', type: 'datetime-local', value: defaultEnd(), required: true })}
              ${field({ label: 'Purpose', name: 'purpose', type: 'textarea', required: true, span: true, placeholder: 'Reason for the trip' })}
            </div>
            <div class="alert alert-danger hidden" data-err></div>
            <div class="form-actions"><button class="btn btn-primary" type="submit">${icon('send')} Submit request</button></div>
          </form>`}
    </div>`;

  const form = ctx.view.querySelector('#fleet-booking-form');
  if (!form) return;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = ctx.view.querySelector('[data-err]');
    err.classList.add('hidden');
    const data = serializeForm(form);
    data.passengers = Number(data.passengers) || 0;
    if (data.pickupId === data.dropId) {
      err.textContent = 'Pickup and drop locations must be different.';
      err.classList.remove('hidden');
      return;
    }
    try {
      const res = await api.post('/api/fleet/bookings', data);
      toast(`Booking ${res.bookingNo} submitted.`);
      navigate(`/fleet/bookings/${res.id}`);
    } catch (e2) {
      err.textContent = e2.message;
      err.classList.remove('hidden');
    }
  });
}

export async function renderBookingDetail(ctx, options = {}) {
  const id = Number(options.id);
  ctx.view.innerHTML = '<div class="empty">Loading booking…</div>';
  const [res, meta] = await Promise.all([
    api.get(`/api/fleet/bookings/${id}`),
    api.get('/api/fleet/meta'),
  ]);
  const b = res.booking;
  const p = meta.permissions || {};
  const canManage = !!p.manageBookings;
  let availability = null;
  if (canManage && b.status === 'PENDING') {
    availability = (await api.get(`/api/fleet/bookings/${id}/availability`)).availability;
  }

  const routeLink = (() => {
    const origin = b.pickup && b.pickup.lat != null && b.pickup.lng != null
      ? `${b.pickup.lat},${b.pickup.lng}` : encodeURIComponent(b.pickupName);
    const destination = b.drop && b.drop.lat != null && b.drop.lng != null
      ? `${b.drop.lat},${b.drop.lng}` : encodeURIComponent(b.dropName);
    return `https://www.google.com/maps/dir/?api=1&origin=${origin}&destination=${destination}`;
  })();

  const refresh = () => renderBookingDetail(ctx, { id });
  const act = async (action, body, message) => {
    try {
      await api.patch(`/api/fleet/bookings/${id}`, { action, ...(body || {}) });
      toast(message);
      await refresh();
    } catch (err) {
      toast(err.message || 'Action failed.', 'error');
    }
  };

  ctx.view.innerHTML = `
    <div class="page-head">
      <div><h1>${esc(b.bookingNo)} ${badge(b.status)}</h1>
        <div class="sub">Requested by ${esc(b.requesterName || '—')} · ${esc(b.departmentName || 'No department')}</div></div>
      <div class="page-actions">
        <a class="btn" href="#/fleet">${icon('arrowLeft')} Back to bookings</a>
        <a class="btn" href="#/documents?entityType=fleet_booking&amp;entityId=${b.id}">${icon('file')} Documents</a>
      </div>
    </div>

    <div class="two-col">
      <div>
        <div class="card">
          <div class="card-head"><div><h3>Trip details</h3></div></div>
          <div class="form-section">
            <div class="detail-grid">
              <div><div class="label muted">Pickup</div><div>${esc(b.pickupName)}</div></div>
              <div><div class="label muted">Drop</div><div>${esc(b.dropName)}</div></div>
              <div><div class="label muted">Start</div><div>${esc(fmtDate(b.startAt, true))}</div></div>
              <div><div class="label muted">End</div><div>${esc(fmtDate(b.endAt, true))}</div></div>
              <div><div class="label muted">Persons</div><div>${b.passengers}</div></div>
              <div><div class="label muted">Purpose</div><div>${esc(b.purpose || '—')}</div></div>
            </div>
            <a class="btn btn-sm" href="${esc(routeLink)}" target="_blank" rel="noopener noreferrer">${icon('external')} View route on Google Maps</a>
          </div>
        </div>

        ${b.status === 'ASSIGNED' || b.status === 'COMPLETED' ? `
        <div class="card">
          <div class="card-head"><div><h3>Assignment</h3></div></div>
          <div class="form-section">
            <div class="detail-grid">
              <div><div class="label muted">Vehicle</div><div>${esc(b.vehicleRegNo ? `${b.vehicleRegNo} · ${b.vehicleModel}` : '—')}</div></div>
              <div><div class="label muted">Driver</div><div>${esc(b.driverName || '—')}</div></div>
              <div><div class="label muted">Assigned at</div><div>${esc(b.assignedAt ? fmtDate(b.assignedAt, true) : '—')}</div></div>
              <div><div class="label muted">Completed at</div><div>${esc(b.completedAt ? fmtDate(b.completedAt, true) : '—')}</div></div>
            </div>
            ${b.remarks ? `<div class="help-block">${esc(b.remarks)}</div>` : ''}
          </div>
        </div>` : ''}
      </div>

      <div>
        ${canManage && b.status === 'PENDING' ? `
        <div class="card">
          <div class="card-head"><div><h3>Assign vehicle & driver</h3><div class="sub">Only resources free for this time slot are listed</div></div></div>
          <div class="form-section">
            ${availability && !availability.vehicles.length || availability && !availability.drivers.length
              ? '<div class="alert alert-danger">No free vehicle or driver is available for this time slot. Adjust the trip time or add a fleet master.</div>' : ''}
            <form id="fleet-assign-form" class="form-grid">
              ${field({
                label: 'Vehicle', name: 'vehicleId', type: 'select', required: true,
                options: [
                  { value: '', label: '— Select vehicle —' },
                  ...(availability ? availability.vehicles.map((v) => ({ value: v.id, label: `${v.regNo} · ${v.model} (${v.seats} seats)` })) : []),
                ],
              })}
              ${field({
                label: 'Driver', name: 'driverId', type: 'select', required: true,
                options: [
                  { value: '', label: '— Select driver —' },
                  ...(availability ? availability.drivers.map((d) => ({ value: d.id, label: `${d.name}${d.employeeCode ? ` · ${d.employeeCode}` : ''}` })) : []),
                ],
              })}
              <div class="field span-2 form-actions">
                <button class="btn btn-primary" type="submit">${icon('check')} Assign trip</button>
                <button class="btn btn-danger" type="button" data-reject>${icon('x')} Reject request</button>
              </div>
            </form>
          </div>
        </div>` : ''}

        ${canManage && b.status === 'ASSIGNED' ? `
        <div class="card">
          <div class="card-head"><div><h3>Complete trip</h3></div></div>
          <div class="form-section"><button class="btn btn-primary" data-complete>${icon('checkCircle')} Mark as completed</button></div>
        </div>` : ''}
      </div>
    </div>`;

  ctx.view.querySelector('#fleet-assign-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const data = serializeForm(form);
    if (!data.vehicleId || !data.driverId) {
      toast('Choose both a vehicle and a driver.', 'error');
      return;
    }
    await act('assign', { vehicleId: Number(data.vehicleId), driverId: Number(data.driverId) }, 'Trip assigned.');
  });
  ctx.view.querySelector('[data-reject]')?.addEventListener('click', async () => {
    const answer = await actionDialog({
      title: 'Reject booking request',
      subtitle: `Booking ${b.bookingNo}`,
      requireComment: true,
      confirmText: 'Reject request',
      danger: true,
    });
    if (answer) await act('reject', { remarks: answer.comments }, 'Booking request rejected.');
  });
  ctx.view.querySelector('[data-complete]')?.addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: 'Complete trip',
      message: `Mark ${b.bookingNo} as completed?`,
      confirmText: 'Complete trip',
    });
    if (ok) await act('complete', {}, 'Trip marked as completed.');
  });
}

/* ------------------------------- Masters ---------------------------- */

function masterFields(model, record, meta = {}) {
  const v = (key, fallback = '') => (record ? record[key] ?? fallback : fallback);
  const activeOptions = [
    { value: 1, label: 'Active' },
    { value: 0, label: 'Inactive' },
  ];
  if (model === 'areas') {
    return `
      ${field({ label: 'Name', name: 'name', value: v('name'), required: true })}
      ${field({
        label: 'Common address', name: 'addressId', type: 'select', value: v('addressId', ''),
        options: [{ value: '', label: '— Not linked —' }, ...(meta.addresses || []).map((a) => ({ value: a.id, label: a.label }))],
        hint: 'Selecting an address fills the fields below. It is maintained once in People & Organization.',
      })}
      ${field({ label: 'Address', name: 'address', value: v('address') })}
      ${field({ label: 'Latitude', name: 'lat', value: v('lat', ''), attrs: 'step="any"' })}
      ${field({ label: 'Longitude', name: 'lng', value: v('lng', ''), attrs: 'step="any"' })}
      ${field({ label: 'Google Maps link', name: 'mapsUrl', value: v('mapsUrl'), span: true, placeholder: 'https://maps.google.com/…' })}
      ${field({ label: 'Status', name: 'active', type: 'select', value: v('active', 1), options: activeOptions })}`;
  }
  if (model === 'vehicles') {
    return `
      ${field({ label: 'Registration number', name: 'regNo', value: v('regNo'), required: true, placeholder: 'NL-01-AB-1234' })}
      ${field({ label: 'Model', name: 'model', value: v('model'), required: true })}
      ${field({ label: 'Seats', name: 'seats', type: 'number', value: v('seats', 4), required: true, attrs: 'min="1" max="100"' })}
      ${field({
        label: 'Linked asset', name: 'assetId', type: 'select', value: v('assetId', ''),
        options: [{ value: '', label: '— Not linked —' }, ...(meta.assets || []).map((a) => ({ value: a.id, label: `${a.code} · ${a.name}` }))],
        hint: 'Optional. Links this vehicle to the common fixed-asset register.',
      })}
      ${field({ label: 'Status', name: 'status', type: 'select', value: v('status', 'ACTIVE'), options: [{ value: 'ACTIVE', label: 'Active' }, { value: 'IN_SERVICE', label: 'In service' }] })}
      ${field({ label: 'Availability', name: 'active', type: 'select', value: v('active', 1), options: activeOptions })}`;
  }
  return '';
}

function masterValues(model, form) {
  const data = serializeForm(form);
  const out = {};
  for (const [key, value] of Object.entries(data)) {
    const column = key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
    out[column] = value;
  }
  if (model === 'vehicles') out.seats = Number(out.seats) || 0;
  if (model === 'areas') {
    for (const key of ['lat', 'lng']) {
      out[key] = out[key] === '' ? null : Number(out[key]);
      if (out[key] !== null && !Number.isFinite(out[key])) out[key] = null;
    }
  }
  for (const key of ['address_id', 'asset_id']) {
    if (key in out) out[key] = out[key] === '' || out[key] == null ? null : Number(out[key]);
  }
  out.active = Number(out.active) ? 1 : 0;
  return out;
}

function masterCell(model, record, meta = {}) {
  if (model === 'areas') {
    const linked = record.addressId
      ? esc((meta.addresses || []).find((a) => String(a.id) === String(record.addressId))?.label || `#${record.addressId}`)
      : '—';
    return [
      record.name,
      record.address || '—',
      linked,
      record.mapsUrl ? `<a href="${esc(record.mapsUrl)}" target="_blank" rel="noopener noreferrer">${icon('external')}</a>` : '—',
      record.active ? 'Active' : 'Inactive',
    ];
  }
  if (model === 'vehicles') {
    const asset = record.assetId
      ? esc((meta.assets || []).find((a) => String(a.id) === String(record.assetId))?.code || `#${record.assetId}`)
      : '—';
    return [record.regNo, record.model, record.seats, asset, `${record.status}${record.active ? '' : ' · Inactive'}`];
  }
  return [];
}

export async function renderMasters(ctx) {
  const model = MASTER_MODELS[ctx.route.query.model] ? ctx.route.query.model : 'areas';
  const config = MASTER_MODELS[model];
  ctx.view.innerHTML = '<div class="empty">Loading fleet masters…</div>';
  const meta = await api.get('/api/fleet/meta');
  const res = await api.get(`/api/fleet/masters/${model}`);
  const records = res.records || [];
  const canEdit = !!meta.permissions.manageMasters;

  const tabs = Object.entries(MASTER_MODELS).map(([key, value]) => `
    <a class="btn btn-sm ${key === model ? 'btn-primary' : ''}" href="${withQuery('/fleet/masters', { model: key })}">${value.label}</a>`).join('');

  ctx.view.innerHTML = `
    <div class="page-head">
      <div><h1>Fleet Masters</h1><div class="sub">Maintain pickup/drop areas and vehicles. Employees, departments and users are common masters.</div></div>
      <div class="page-actions"><a class="btn" href="#/fleet">${icon('arrowLeft')} Back to bookings</a></div>
    </div>
    <div class="alert alert-info">Departments and drivers come from the shared <a href="#/employees">Employees</a> and <a href="#/org">Organization</a> masters. Mark an employee as a driver in their employee record.</div>
    <div class="page-actions" style="margin-bottom:12px">${tabs}</div>
    <div class="card">
      <div class="card-head">
        <div><h3>${config.label}</h3><div class="sub">${records.length} record${records.length === 1 ? '' : 's'}</div></div>
        ${canEdit ? `<button class="btn btn-sm btn-primary" data-add>${icon('plus')} Add ${config.singular}</button>` : ''}
      </div>
      ${records.length
        ? `<div class="table-wrap"><table class="table">
            <thead><tr>${config.columns.map((c) => `<th>${esc(c)}</th>`).join('')}${canEdit ? '<th></th>' : ''}</tr></thead>
            <tbody>${records.map((r) => `<tr>
              ${masterCell(model, r, meta).map((value) => `<td>${value}</td>`).join('')}
              ${canEdit ? `<td class="actions">
                <button class="btn btn-sm btn-ghost" data-edit="${r.id}" title="Edit">${icon('edit')}</button>
                <button class="btn btn-sm btn-ghost" data-delete="${r.id}" title="Remove">${icon('trash')}</button>
              </td>` : ''}
            </tr>`).join('')}</tbody>
          </table></div>`
        : emptyState(`No ${config.label.toLowerCase()} yet`, canEdit ? `Add the first ${config.singular.toLowerCase()} to start using Fleet Desk.` : 'Ask the transport incharge to add fleet masters.', canEdit ? `<button class="btn btn-sm btn-primary" data-add>Add ${config.singular}</button>` : '', 'car')}
    </div>`;

  const openForm = (record) => {
    modal({
      title: `${record ? 'Edit' : 'Add'} ${config.singular}`,
      size: 'wide',
      body: `<form id="fleet-master-form"><div class="form-grid">${masterFields(model, record, meta)}</div>
        <div class="alert alert-danger hidden" data-err></div></form>`,
      footer: `<button class="btn" data-modal-close>Cancel</button><button class="btn btn-primary" data-save>Save</button>`,
      onMount(el, close) {
        const form = el.querySelector('#fleet-master-form');
        form?.querySelector('[name="addressId"]')?.addEventListener('change', (e) => {
          const address = (meta.addresses || []).find((a) => String(a.id) === String(e.target.value));
          if (!address) return;
          const line = [address.label, address.city].filter(Boolean).join(', ');
          form.querySelector('[name="address"]').value = line;
          form.querySelector('[name="lat"]').value = address.lat == null ? '' : address.lat;
          form.querySelector('[name="lng"]').value = address.lng == null ? '' : address.lng;
          form.querySelector('[name="mapsUrl"]').value = address.mapsUrl || '';
        });
        el.querySelector('[data-save]').addEventListener('click', async () => {
          const err = el.querySelector('[data-err]');
          err.classList.add('hidden');
          const values = masterValues(model, form);
          try {
            if (record) await api.put(`/api/fleet/masters/${model}/${record.id}`, values);
            else await api.post(`/api/fleet/masters/${model}`, values);
            close();
            toast(`${config.singular} saved.`);
            await renderMasters(ctx);
          } catch (e) {
            err.textContent = e.message;
            err.classList.remove('hidden');
          }
        });
      },
    });
  };

  ctx.view.querySelectorAll('[data-add]').forEach((b) => b.addEventListener('click', () => openForm(null)));
  ctx.view.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => {
    openForm(records.find((r) => r.id === Number(b.dataset.edit)));
  }));
  ctx.view.querySelectorAll('[data-delete]').forEach((b) => b.addEventListener('click', async () => {
    const record = records.find((r) => r.id === Number(b.dataset.delete));
    const ok = await confirmDialog({
      title: `Remove ${config.singular}`,
      message: `Remove ${record.name || record.regNo}? Existing bookings are not affected.`,
      confirmText: 'Remove',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.del(`/api/fleet/masters/${model}/${record.id}`);
      toast(`${config.singular} removed.`);
      await renderMasters(ctx);
    } catch (e) {
      toast(e.message || 'Could not remove record.', 'error');
    }
  }));
}
