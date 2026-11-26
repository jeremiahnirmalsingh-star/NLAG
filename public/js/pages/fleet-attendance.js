import { api, queryString } from '../api.js';
import { navigate, withQuery } from '../router.js';
import {
  esc, icon, toast, field, modal, confirmDialog, actionDialog,
  serializeForm, emptyState, statusBadge, fmtDate, todayInput,
} from '../ui.js';

const STATUS_LABELS = {
  PENDING: 'Pending Approval',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
};

const hoursText = (value) => (Number(value) || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });

function previewHours(checkIn, checkOut, standardHours) {
  if (!/^\d{2}:\d{2}$/.test(checkIn) || !/^\d{2}:\d{2}$/.test(checkOut)) return null;
  const toMinutes = (value) => {
    const [h, m] = value.split(':').map(Number);
    return h * 60 + m;
  };
  const worked = (toMinutes(checkOut) - toMinutes(checkIn)) / 60;
  if (!(worked > 0)) return null;
  const rounded = Math.round(worked * 100) / 100;
  return {
    hours: rounded,
    extraHours: Math.round(Math.max(0, rounded - standardHours) * 100) / 100,
  };
}

export async function renderAttendance(ctx) {
  ctx.view.innerHTML = '<div class="empty">Loading driver attendance…</div>';
  const q = ctx.route.query || {};
  const [meta, res] = await Promise.all([
    api.get('/api/fleet/meta'),
    api.get(`/api/fleet/attendance${queryString({
      from: q.from, to: q.to, driverId: q.driverId, status: q.status,
    })}`),
  ]);

  const canManage = !!res.canManage || !!meta.permissions?.manageBookings;
  const standardHours = Number(res.standardHours) || 9;
  const drivers = res.drivers || [];
  const records = res.attendance || [];
  const units = meta.units || [];
  const summary = res.summary || {};
  const canAdd = canManage || !!meta.viewer?.employeeId;

  const filterForm = `
    <form class="form-grid" data-filter-form>
      ${field({ label: 'From date', name: 'from', type: 'date', value: q.from || '' })}
      ${field({ label: 'To date', name: 'to', type: 'date', value: q.to || '' })}
      ${canManage ? field({
        label: 'Driver', name: 'driverId', type: 'select', value: q.driverId || '',
        options: [
          { value: '', label: 'All drivers' },
          ...drivers.map((d) => ({ value: d.id, label: d.name })),
        ],
      }) : ''}
      ${field({
        label: 'Status', name: 'status', type: 'select', value: q.status || '',
        options: [
          { value: '', label: 'All statuses' },
          ...Object.entries(STATUS_LABELS).map(([value, label]) => ({ value, label })),
        ],
      })}
      <div class="field" style="align-self:end">
        <button class="btn btn-primary" type="submit">${icon('filter')} Apply</button>
        <button class="btn btn-ghost" type="button" data-clear-filters>Clear</button>
      </div>
    </form>`;

  const rows = records.map((row) => {
    const actions = [];
    if (canManage && row.status !== 'APPROVED') {
      actions.push(`<button class="btn btn-sm btn-ghost" data-approve="${row.id}" title="Approve">${icon('check')}</button>`);
    }
    if (canManage && row.status === 'PENDING') {
      actions.push(`<button class="btn btn-sm btn-ghost" data-reject="${row.id}" title="Reject">${icon('x')}</button>`);
    }
    if (canManage || row.status === 'PENDING') {
      actions.push(`<button class="btn btn-sm btn-ghost" data-edit="${row.id}" title="Edit">${icon('edit')}</button>`);
    }
    if (canManage) {
      actions.push(`<button class="btn btn-sm btn-ghost" data-delete="${row.id}" title="Remove">${icon('trash')}</button>`);
    }
    return `<tr>
      <td><b>${esc(fmtDate(row.date))}</b><div class="small muted">${esc(row.driverCode || '—')}</div></td>
      ${canManage ? `<td>${esc(row.driverName || '—')}</td>` : ''}
      <td>${esc(row.checkIn)}</td>
      <td>${esc(row.checkOut)}</td>
      <td class="num"><b>${hoursText(row.hours)}</b></td>
      <td class="num">${row.extraHours > 0 ? `<span class="badge forwarded">+${hoursText(row.extraHours)}</span>` : '—'}</td>
      <td>${statusBadge(row.status, STATUS_LABELS[row.status] || row.status)}</td>
      <td class="small muted">${esc(row.remarks || '—')}</td>
      ${actions.length ? `<td class="actions">${actions.join('')}</td>` : ''}
    </tr>`;
  }).join('');

  ctx.view.innerHTML = `
    <div class="page-head">
      <div>
        <h1>Driver Attendance</h1>
        <div class="sub">Daily drill-in / drill-out with extra hours over a ${standardHours}-hour duty day</div>
      </div>
      <div class="page-actions">
        <a class="btn" href="#/fleet/dashboard">${icon('grid')} Fleet Dashboard</a>
        ${canAdd ? `<button class="btn btn-primary" data-add>${icon('plus')} Add attendance</button>` : ''}
      </div>
    </div>

    <div class="alert alert-info">Drivers can record their own attendance; Transport enters or corrects it for any driver. Self entries stay pending until Transport approves. Extra hours = worked hours minus ${standardHours}, per day.</div>

    <div class="grid grid-4">
      <div class="card"><div class="kpi"><div class="chip blue">${icon('clock')}</div><div><div class="label">Approved hours</div><div class="value">${hoursText(summary.hours)}</div><div class="meta">${hoursText(summary.todayHours)} today</div></div></div></div>
      <div class="card"><div class="kpi"><div class="chip amber">${icon('trend')}</div><div><div class="label">Extra hours worked</div><div class="value">${hoursText(summary.extraHours)}</div><div class="meta">+${hoursText(summary.todayExtraHours)} today</div></div></div></div>
      <div class="card"><div class="kpi"><div class="chip purple">${icon('checkCircle')}</div><div><div class="label">Approved days</div><div class="value">${summary.approvedRecords || 0}</div><div class="meta">of ${summary.records || 0} recorded</div></div></div></div>
      <div class="card"><div class="kpi"><div class="chip amber">${icon('send')}</div><div><div class="label">Awaiting approval</div><div class="value">${summary.pendingRecords || 0}</div><div class="meta">${summary.rejectedRecords || 0} rejected</div></div></div></div>
    </div>

    <div class="card mt-16">
      <div class="card-head"><div><h3>Attendance register</h3><div class="sub">${records.length} record${records.length === 1 ? '' : 's'} in view</div></div></div>
      <div class="form-section">${filterForm}</div>
      ${records.length
        ? `<div class="table-wrap"><table class="table">
            <thead><tr>
              <th>Date</th>${canManage ? '<th>Driver</th>' : ''}<th>Check in</th><th>Check out</th>
              <th class="num">Worked</th><th class="num">Extra</th><th>Status</th><th>Remarks</th>
              ${actionsInRows(rows) ? '<th></th>' : ''}
            </tr></thead><tbody>${rows}</tbody>
          </table></div>`
        : emptyState(
          'No attendance records',
          'Add a daily check-in and check-out to start tracking worked and extra hours.',
          canAdd ? '<button class="btn btn-sm btn-primary" data-add>Add attendance</button>' : '',
          'clock'
        )}
    </div>`;

  const refresh = () => renderAttendance(ctx);

  ctx.view.querySelector('[data-filter-form]')?.addEventListener('submit', (event) => {
    event.preventDefault();
    navigate(withQuery('/fleet/attendance', serializeForm(event.currentTarget)));
  });
  ctx.view.querySelector('[data-clear-filters]')?.addEventListener('click', () => navigate('/fleet/attendance'));

  const openForm = (record) => {
    const editing = !!record;
    const defaultDriverId = record?.driverId || (canManage ? drivers[0]?.id || '' : '');
    const driverField = canManage
      ? field({
        label: 'Driver', name: 'driverId', type: 'select', required: true,
        value: defaultDriverId,
        options: [
          { value: '', label: '— Select driver —' },
          ...drivers.map((d) => ({ value: d.id, label: `${d.name}${d.employeeCode ? ` · ${d.employeeCode}` : ''}` })),
        ],
      })
      : `<div class="help-block">Recording attendance for your own driver account.</div>`;
    const unitField = canManage && units.length
      ? field({
        label: 'Unit', name: 'unitId', type: 'select',
        value: record?.unitId || meta.defaultUnitId || units[0].id,
        options: units.map((u) => ({ value: u.id, label: u.name })),
      })
      : '';

    modal({
      title: editing ? 'Edit attendance' : 'Add driver attendance',
      subtitle: editing ? `${record.driverName} · ${fmtDate(record.date)}` : `Standard duty: ${standardHours} hours per day`,
      body: `<form id="fleet-attendance-form"><div class="form-grid">
        ${driverField}
        ${field({ label: 'Date', name: 'date', type: 'date', value: record?.date || todayInput(), required: !editing, attrs: editing ? 'disabled' : '' })}
        ${field({ label: 'Check in', name: 'checkIn', type: 'time', value: record?.checkIn || '', required: true })}
        ${field({ label: 'Check out', name: 'checkOut', type: 'time', value: record?.checkOut || '', required: true })}
        ${unitField}
        ${field({ label: 'Remarks', name: 'remarks', type: 'textarea', span: true, value: record?.remarks || '', placeholder: 'Optional details' })}
      </div>
      <div class="alert alert-info" data-preview>Enter check-in and check-out times to see calculated hours.</div>
      <div class="alert alert-danger hidden" data-err></div></form>`,
      footer: `<button class="btn" data-modal-close>Cancel</button><button class="btn btn-primary" data-save>Save attendance</button>`,
      onMount(el, close) {
        const err = el.querySelector('[data-err]');
        const preview = el.querySelector('[data-preview]');
        const checkIn = el.querySelector('[name="checkIn"]');
        const checkOut = el.querySelector('[name="checkOut"]');
        const updatePreview = () => {
          const result = previewHours(checkIn.value, checkOut.value, standardHours);
          preview.textContent = result
            ? `Worked ${hoursText(result.hours)} hours · Extra ${hoursText(result.extraHours)} hours over ${standardHours}-hour duty.`
            : `Extra hours are calculated after ${standardHours} hours of duty each day.`;
        };
        checkIn.addEventListener('input', updatePreview);
        checkOut.addEventListener('input', updatePreview);
        updatePreview();

        el.querySelector('[data-save]').addEventListener('click', async () => {
          err.classList.add('hidden');
          const values = serializeForm(el.querySelector('#fleet-attendance-form'));
          try {
            if (editing) {
              await api.patch(`/api/fleet/attendance/${record.id}`, {
                action: 'edit',
                checkIn: values.checkIn,
                checkOut: values.checkOut,
                remarks: values.remarks,
              });
            } else {
              await api.post('/api/fleet/attendance', values);
            }
            close();
            toast(editing ? 'Attendance updated.' : (canManage ? 'Attendance recorded.' : 'Attendance submitted for approval.'));
            await refresh();
          } catch (e) {
            err.textContent = e.message;
            err.classList.remove('hidden');
          }
        });
      },
    });
  };

  ctx.view.querySelectorAll('[data-add]').forEach((button) => button.addEventListener('click', () => openForm(null)));
  ctx.view.querySelectorAll('[data-edit]').forEach((button) => {
    button.addEventListener('click', () => {
      const record = records.find((r) => r.id === Number(button.dataset.edit));
      if (record) openForm(record);
    });
  });

  const decide = (selector, action, label) => {
    ctx.view.querySelectorAll(selector).forEach((button) => {
      button.addEventListener('click', async () => {
        const record = records.find((r) => r.id === Number(button.dataset[action]));
        if (!record) return;
        const decision = await actionDialog({
          title: `${label} attendance`,
          subtitle: `${record.driverName} · ${fmtDate(record.date)} · ${hoursText(record.hours)} hours`,
          confirmText: label,
          danger: action === 'reject',
        });
        if (!decision) return;
        try {
          await api.patch(`/api/fleet/attendance/${record.id}`, {
            action,
            remarks: decision.comments || record.remarks,
          });
          toast(`Attendance ${action === 'approve' ? 'approved' : 'rejected'}.`);
          await refresh();
        } catch (e) {
          toast(e.message || 'Could not update attendance.', 'error');
        }
      });
    });
  };
  decide('[data-approve]', 'approve', 'Approve');
  decide('[data-reject]', 'reject', 'Reject');

  ctx.view.querySelectorAll('[data-delete]').forEach((button) => {
    button.addEventListener('click', async () => {
      const record = records.find((r) => r.id === Number(button.dataset.delete));
      if (!record) return;
      const ok = await confirmDialog({
        title: 'Remove attendance',
        message: `Remove ${record.driverName}'s attendance for ${fmtDate(record.date)}?`,
        confirmText: 'Remove',
        danger: true,
      });
      if (!ok) return;
      try {
        await api.del(`/api/fleet/attendance/${record.id}`);
        toast('Attendance removed.');
        await refresh();
      } catch (e) {
        toast(e.message || 'Could not remove attendance.', 'error');
      }
    });
  });
}

function actionsInRows(rowHtml) {
  return String(rowHtml).includes('class="actions"');
}
