import { api } from '../api.js';
import { withQuery } from '../router.js';
import {
  esc, icon, statusBadge, emptyState, toast, field, modal,
  actionDialog, fmtDate, serializeForm,
} from '../ui.js';

const LABELS = {
  REPORTED: 'Reported',
  UNDER_REVIEW: 'Under review',
  CLOSED: 'Closed',
};
const SEVERITY_CLASS = { LOW: 'active', NORMAL: '', HIGH: 'pending', CRITICAL: 'rejected' };

function localDateTime(date) {
  const value = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return value.toISOString().slice(0, 16);
}

export async function renderAccidents(ctx) {
  ctx.view.innerHTML = '<div class="empty">Loading accident reports…</div>';
  const [res, bookingRes, meta] = await Promise.all([
    api.get('/api/fleet/accidents'),
    api.get('/api/fleet/bookings'),
    api.get('/api/fleet/meta'),
  ]);
  const accidents = res.accidents || [];
  const vehicles = res.vehicles || [];
  const trips = bookingRes.bookings || [];
  const canManage = !!res.canManage;
  const q = ctx.route.query || {};
  const statusFilter = String(q.status || '').toUpperCase();
  const tripFilter = Number(q.tripId || 0);
  const filtered = accidents.filter((item) => {
    if (statusFilter && item.status !== statusFilter) return false;
    if (tripFilter && item.tripId !== tripFilter) return false;
    return true;
  });
  const refresh = () => renderAccidents(ctx);

  const openForm = () => {
    modal({
      title: 'Report accident',
      subtitle: 'Records the vehicle, location, injuries and police report details',
      size: 'wide',
      body: `<form id="fleet-accident-form" class="form-grid">
        ${field({
          label: 'Vehicle', name: 'vehicleId', type: 'select', required: true,
          options: [{ value: '', label: '— Select vehicle —' }, ...vehicles.map((v) => ({ value: v.id, label: v.regNo }))],
        })}
        ${field({
          label: 'Trip (optional)', name: 'tripId', type: 'select', value: tripFilter || '',
          options: [{ value: '', label: '— Not linked to a trip —' }, ...trips.map((t) => ({ value: t.id, label: `${t.bookingNo} · ${t.purpose}` }))],
        })}
        ${field({ label: 'Occurred at', name: 'occurredAt', type: 'datetime-local', value: localDateTime(new Date()), required: true })}
        ${field({
          label: 'Severity', name: 'severity', type: 'select', required: true, value: 'NORMAL',
          options: (res.severities || []).map((item) => ({ value: item.value, label: item.label })),
        })}
        ${field({ label: 'Location', name: 'locationName', required: true, placeholder: 'Road, landmark, city' })}
        ${field({ label: 'Latitude', name: 'latitude', type: 'number', attrs: 'step="any"', placeholder: 'Optional' })}
        ${field({ label: 'Longitude', name: 'longitude', type: 'number', attrs: 'step="any"', placeholder: 'Optional' })}
        ${field({ label: 'Description', name: 'description', type: 'textarea', span: true, required: true, placeholder: 'What happened and who was involved?' })}
        ${field({ label: 'Injuries', name: 'injuries', type: 'textarea', span: true, placeholder: 'Describe any injuries, or write None' })}
        ${field({ label: 'Police report number', name: 'policeReportNo', placeholder: 'If available' })}
        <div class="alert alert-danger hidden span-2" data-err></div>
      </form>`,
      footer: `<button class="btn" data-modal-close>Cancel</button><button class="btn btn-primary" data-save>${icon('plus')} Report accident</button>`,
      onMount(el, close) {
        el.querySelector('[data-save]').addEventListener('click', async () => {
          const err = el.querySelector('[data-err]');
          err.classList.add('hidden');
          const values = serializeForm(el.querySelector('#fleet-accident-form'));
          try {
            await api.post('/api/fleet/accidents', values);
            close();
            toast('Accident reported. Transport and senior management have been notified.');
            await refresh();
          } catch (e) {
            err.textContent = e.message;
            err.classList.remove('hidden');
          }
        });
      },
    });
  };

  ctx.view.innerHTML = `
    <div class="page-head">
      <div><h1>Accident Reports</h1><div class="sub">Escalation, review and closure of vehicle accidents</div></div>
      <div class="page-actions"><button class="btn btn-primary" data-add-accident>${icon('plus')} Report accident</button></div>
    </div>
    <div class="card">
      <form class="toolbar" data-filters>
        ${field({
          label: 'Status', name: 'status', type: 'select', value: statusFilter,
          options: [{ value: '', label: 'All statuses' }, ...Object.entries(LABELS).map(([value, label]) => ({ value, label }))],
        })}
        <div class="field"><label>&nbsp;</label><button class="btn btn-sm" type="submit">${icon('search')} Apply</button></div>
        <div class="field"><label>&nbsp;</label><a class="btn btn-sm" href="#/fleet/accidents">Clear</a></div>
      </form>
      ${filtered.length
        ? `<div class="table-wrap"><table class="table">
            <thead><tr><th>Occurred</th><th>Vehicle</th><th>Trip</th><th>Location</th><th>Severity</th><th>Report</th><th>Status</th>${canManage ? '<th></th>' : ''}</tr></thead>
            <tbody>${filtered.map((item) => `<tr>
              <td>${esc(fmtDate(item.occurredAt, true))}<div class="small muted">${esc(item.reportedByName || '—')}</div></td>
              <td><b>${esc(item.vehicleRegNo || '—')}</b></td>
              <td>${item.bookingNo ? `<a href="#/fleet/bookings/${item.tripId}">${esc(item.bookingNo)}</a>` : '<span class="muted">—</span>'}</td>
              <td>${esc(item.locationName || '—')}${item.latitude != null && item.longitude != null ? `<div class="small muted">${item.latitude}, ${item.longitude}</div>` : ''}</td>
              <td><span class="badge ${SEVERITY_CLASS[item.severity] || ''}">${esc(item.severity)}</span></td>
              <td>${esc(item.description)}${item.injuries ? `<div class="small muted">Injuries: ${esc(item.injuries)}</div>` : ''}${item.policeReportNo ? `<div class="small muted">Police: ${esc(item.policeReportNo)}</div>` : ''}${item.closureRemarks ? `<div class="small muted">Closure: ${esc(item.closureRemarks)}</div>` : ''}</td>
              <td>${statusBadge(item.status, LABELS[item.status] || item.status)}</td>
              ${canManage ? `<td class="actions">
                ${item.status !== 'UNDER_REVIEW' && item.status !== 'CLOSED' ? `<button class="btn btn-sm btn-ghost" data-accident-action="review" data-id="${item.id}" title="Mark under review">${icon('eye')}</button>` : ''}
                ${item.status !== 'CLOSED' ? `<button class="btn btn-sm btn-ghost" data-accident-action="close" data-id="${item.id}" title="Close accident">${icon('checkCircle')}</button>` : ''}
                ${item.status === 'CLOSED' ? `<button class="btn btn-sm btn-ghost" data-accident-action="reopen" data-id="${item.id}" title="Reopen accident">${icon('undo')}</button>` : ''}
              </td>` : ''}
            </tr>`).join('')}</tbody>
          </table></div>`
        : emptyState('No accidents reported', 'Accident reports will appear here with escalation and closure details.', '<button class="btn btn-sm btn-primary" data-add-accident>Report accident</button>', 'alert')}
    </div>`;

  ctx.view.querySelectorAll('[data-add-accident]').forEach((button) => button.addEventListener('click', openForm));
  ctx.view.querySelector('[data-filters]')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const values = serializeForm(e.currentTarget);
    const query = {};
    if (values.status) query.status = values.status;
    if (tripFilter) query.tripId = tripFilter;
    window.location.hash = `#${withQuery('/fleet/accidents', query)}`;
  });
  ctx.view.querySelectorAll('[data-accident-action]').forEach((button) => {
    button.addEventListener('click', async () => {
      const item = accidents.find((entry) => entry.id === Number(button.dataset.id));
      if (!item) return;
      const action = button.dataset.accidentAction;
      const title = {
        review: 'Mark accident under review', close: 'Close accident', reopen: 'Reopen accident',
      }[action];
      const answer = await actionDialog({
        title,
        subtitle: `${item.vehicleRegNo} · ${item.locationName || 'Accident'}`,
        requireComment: action === 'close',
        confirmText: title,
      });
      if (!answer) return;
      try {
        await api.patch(`/api/fleet/accidents/${item.id}`, { action, remarks: answer.comments || '' });
        toast('Accident updated.');
        await refresh();
      } catch (e) {
        toast(e.message || 'Action failed.', 'error');
      }
    });
  });
}
