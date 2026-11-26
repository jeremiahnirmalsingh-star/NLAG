import { api } from '../api.js';
import { withQuery } from '../router.js';
import {
  esc, icon, statusBadge, emptyState, toast, field, modal,
  actionDialog, fmtDate, serializeForm,
} from '../ui.js';

const LABELS = {
  OPEN: 'Open',
  IN_PROGRESS: 'In progress',
  RESOLVED: 'Resolved',
  CLOSED: 'Closed',
};
const SEVERITY_CLASS = { LOW: 'active', NORMAL: '', HIGH: 'pending', CRITICAL: 'rejected' };

function localDateTime(date) {
  const value = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return value.toISOString().slice(0, 16);
}

function statusCell(status) {
  return statusBadge(status, LABELS[status] || status);
}

export async function renderIssues(ctx) {
  ctx.view.innerHTML = '<div class="empty">Loading vehicle issues…</div>';
  const [res, bookingRes, meta] = await Promise.all([
    api.get('/api/fleet/issues'),
    api.get('/api/fleet/bookings'),
    api.get('/api/fleet/meta'),
  ]);
  const issues = res.issues || [];
  const vehicles = res.vehicles || [];
  const assignees = res.assignees || [];
  const trips = bookingRes.bookings || [];
  const canManage = !!res.canManage;
  const q = ctx.route.query || {};
  const statusFilter = String(q.status || '').toUpperCase();
  const vehicleFilter = Number(q.vehicleId || 0);
  const tripFilter = Number(q.tripId || 0);
  const filtered = issues.filter((issue) => {
    if (statusFilter && issue.status !== statusFilter) return false;
    if (vehicleFilter && issue.vehicleId !== vehicleFilter) return false;
    if (tripFilter && issue.tripId !== tripFilter) return false;
    return true;
  });

  const filters = `
    <form class="toolbar" data-filters>
      ${field({
        label: 'Status', name: 'status', type: 'select', value: statusFilter,
        options: [
          { value: '', label: 'All statuses' },
          ...Object.entries(LABELS).map(([value, label]) => ({ value, label })),
        ],
      })}
      ${field({
        label: 'Vehicle', name: 'vehicleId', type: 'select', value: vehicleFilter || '',
        options: [{ value: '', label: 'All vehicles' }, ...vehicles.map((v) => ({ value: v.id, label: v.regNo }))],
      })}
      <div class="field"><label>&nbsp;</label><button class="btn btn-sm" type="submit">${icon('search')} Apply</button></div>
      <div class="field"><label>&nbsp;</label><a class="btn btn-sm" href="#/fleet/issues">Clear</a></div>
    </form>`;

  const refresh = () => renderIssues(ctx);

  const openForm = () => {
    modal({
      title: 'Report vehicle issue',
      subtitle: 'Linked to a vehicle and, when relevant, the trip during which it occurred',
      size: 'wide',
      body: `<form id="fleet-issue-form" class="form-grid">
        ${field({
          label: 'Vehicle', name: 'vehicleId', type: 'select', required: true,
          options: [{ value: '', label: '— Select vehicle —' }, ...vehicles.map((v) => ({ value: v.id, label: v.regNo }))],
        })}
        ${field({
          label: 'Trip (optional)', name: 'tripId', type: 'select', value: tripFilter || '',
          options: [{ value: '', label: '— Not linked to a trip —' }, ...trips.map((t) => ({ value: t.id, label: `${t.bookingNo} · ${t.purpose}` }))],
        })}
        ${field({
          label: 'Issue type', name: 'issueType', type: 'select', required: true, value: 'MECHANICAL',
          options: (res.issueTypes || []).map((item) => ({ value: item.value, label: item.label })),
        })}
        ${field({
          label: 'Severity', name: 'severity', type: 'select', required: true, value: 'NORMAL',
          options: (res.severities || []).map((item) => ({ value: item.value, label: item.label })),
        })}
        ${field({ label: 'Reported at', name: 'reportedAt', type: 'datetime-local', value: localDateTime(new Date()), required: true })}
        ${field({ label: 'Location', name: 'locationName', placeholder: 'Where the issue was noticed' })}
        ${field({ label: 'Description', name: 'description', type: 'textarea', span: true, required: true, placeholder: 'What happened? Include symptoms and any immediate action taken.' })}
        <div class="alert alert-danger hidden span-2" data-err></div>
      </form>`,
      footer: `<button class="btn" data-modal-close>Cancel</button><button class="btn btn-primary" data-save>${icon('plus')} Report issue</button>`,
      onMount(el, close) {
        el.querySelector('[data-save]').addEventListener('click', async () => {
          const err = el.querySelector('[data-err]');
          err.classList.add('hidden');
          const values = serializeForm(el.querySelector('#fleet-issue-form'));
          try {
            await api.post('/api/fleet/issues', values);
            close();
            toast('Vehicle issue reported.');
            await refresh();
          } catch (e) {
            err.textContent = e.message;
            err.classList.remove('hidden');
          }
        });
      },
    });
  };

  const decide = async (issue, action, title) => {
    let remarks = '';
    if (['resolve', 'close'].includes(action)) {
      const answer = await actionDialog({
        title,
        subtitle: `${issue.vehicleRegNo} · ${issue.description.slice(0, 100)}`,
        requireComment: true,
        confirmText: title,
      });
      if (!answer) return;
      remarks = answer.comments;
    } else {
      const answer = await actionDialog({
        title,
        subtitle: `${issue.vehicleRegNo} · ${issue.description.slice(0, 100)}`,
        confirmText: title,
      });
      if (!answer) return;
      remarks = answer.comments || '';
    }
    try {
      await api.patch(`/api/fleet/issues/${issue.id}`, { action, remarks });
      toast(`Issue ${action === 'reopen' ? 'reopened' : `${action}d`}.`);
      await refresh();
    } catch (e) {
      toast(e.message || 'Action failed.', 'error');
    }
  };

  const assignIssue = (issue) => {
    modal({
      title: 'Assign issue for repair',
      subtitle: `${issue.vehicleRegNo} · ${issue.description.slice(0, 100)}`,
      body: `<form id="fleet-issue-assign" class="form-grid">
        ${field({
          label: 'Assign to', name: 'assignedTo', type: 'select', required: true,
          options: [{ value: '', label: '— Select user —' }, ...assignees.map((u) => ({ value: u.id, label: `${u.name}${u.role ? ` · ${u.role}` : ''}` }))],
        })}
        ${field({ label: 'Remarks', name: 'remarks', type: 'textarea', span: true, value: issue.resolutionRemarks || '' })}
      </form>`,
      footer: `<button class="btn" data-modal-close>Cancel</button><button class="btn btn-primary" data-save>${icon('check')} Assign</button>`,
      onMount(el, close) {
        el.querySelector('[data-save]').addEventListener('click', async () => {
          const values = serializeForm(el.querySelector('#fleet-issue-assign'));
          if (!values.assignedTo) {
            toast('Choose a user.', 'error');
            return;
          }
          try {
            await api.patch(`/api/fleet/issues/${issue.id}`, {
              action: 'assign', assignedTo: Number(values.assignedTo), remarks: values.remarks,
            });
            close();
            toast('Issue assigned.');
            await refresh();
          } catch (e) {
            toast(e.message || 'Could not assign the issue.', 'error');
          }
        });
      },
    });
  };

  ctx.view.innerHTML = `
    <div class="page-head">
      <div><h1>Vehicle Issues</h1><div class="sub">Report defects and track repair action by vehicle and trip</div></div>
      <div class="page-actions"><button class="btn btn-primary" data-add-issue>${icon('plus')} Report issue</button></div>
    </div>
    <div class="card">
      ${filters}
      ${filtered.length
        ? `<div class="table-wrap"><table class="table">
            <thead><tr><th>Reported</th><th>Vehicle</th><th>Trip</th><th>Type / severity</th><th>Issue</th><th>Status</th><th>Assigned to</th>${canManage ? '<th></th>' : ''}</tr></thead>
            <tbody>${filtered.map((issue) => `<tr>
              <td>${esc(fmtDate(issue.reportedAt, true))}<div class="small muted">${esc(issue.reportedByName || '—')}</div></td>
              <td><b>${esc(issue.vehicleRegNo || '—')}</b>${issue.locationName ? `<div class="small muted">${esc(issue.locationName)}</div>` : ''}</td>
              <td>${issue.bookingNo ? `<a href="#/fleet/bookings/${issue.tripId}">${esc(issue.bookingNo)}</a>` : '<span class="muted">—</span>'}</td>
              <td>${esc(issue.issueType)}<div><span class="badge ${SEVERITY_CLASS[issue.severity] || ''}">${esc(issue.severity)}</span></div></td>
              <td>${esc(issue.description)}${issue.resolutionRemarks ? `<div class="small muted">${esc(issue.resolutionRemarks)}</div>` : ''}</td>
              <td>${statusCell(issue.status)}</td>
              <td>${esc(issue.assignedToName || '—')}</td>
              ${canManage ? `<td class="actions">
                ${issue.status === 'OPEN' || issue.status === 'IN_PROGRESS' ? `<button class="btn btn-sm btn-ghost" data-issue-action="assign" data-id="${issue.id}" title="Assign">${icon('user')}</button>` : ''}
                ${issue.status !== 'RESOLVED' && issue.status !== 'CLOSED' ? `<button class="btn btn-sm btn-ghost" data-issue-action="resolve" data-id="${issue.id}" title="Mark resolved">${icon('checkCircle')}</button>` : ''}
                ${issue.status === 'RESOLVED' ? `<button class="btn btn-sm btn-ghost" data-issue-action="close" data-id="${issue.id}" title="Close">${icon('check')}</button>` : ''}
                ${issue.status !== 'OPEN' ? `<button class="btn btn-sm btn-ghost" data-issue-action="reopen" data-id="${issue.id}" title="Reopen">${icon('undo')}</button>` : ''}
              </td>` : ''}
            </tr>`).join('')}</tbody>
          </table></div>`
        : emptyState('No vehicle issues', 'Report a mechanical, tyre, fuel or compliance issue against a vehicle.', '<button class="btn btn-sm btn-primary" data-add-issue>Report issue</button>', 'alert')}
    </div>`;

  ctx.view.querySelectorAll('[data-add-issue]').forEach((button) => button.addEventListener('click', openForm));
  ctx.view.querySelector('[data-filters]')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const values = serializeForm(e.currentTarget);
    const query = {};
    if (values.status) query.status = values.status;
    if (values.vehicleId) query.vehicleId = values.vehicleId;
    if (tripFilter) query.tripId = tripFilter;
    window.location.hash = `#${withQuery('/fleet/issues', query)}`;
  });
  ctx.view.querySelectorAll('[data-issue-action]').forEach((button) => {
    button.addEventListener('click', () => {
      const issue = issues.find((item) => item.id === Number(button.dataset.id));
      if (!issue) return;
      if (button.dataset.issueAction === 'assign') assignIssue(issue);
      else decide(issue, button.dataset.issueAction, {
        resolve: 'Mark issue resolved', close: 'Close issue', reopen: 'Reopen issue',
      }[button.dataset.issueAction]);
    });
  });
}
