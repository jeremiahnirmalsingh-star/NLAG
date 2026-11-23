import { api } from '../api.js';
import { can, state } from '../state.js';
import { navigate, withQuery } from '../router.js';
import {
  esc, icon, statusBadge, emptyState, toast, field, modal, confirmDialog, initials,
} from '../ui.js';

const STATUS_OPTIONS = [
  { value: 'Active', label: 'Active' },
  { value: 'Inactive', label: 'Inactive' },
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

/* ================================================================== */
/* List                                                                */
/* ================================================================== */
export async function renderList(ctx) {
  const q = ctx.route.query || {};
  const params = new URLSearchParams();
  if (q.search) params.set('search', q.search);
  if (q.department) params.set('department', q.department);
  if (q.status) params.set('status', q.status);

  ctx.view.innerHTML = `<div class="empty">Loading employees\u2026</div>`;
  const [meta, res] = await Promise.all([
    api.get('/api/procurement/employees/meta'),
    api.get(`/api/procurement/employees?${params.toString()}`),
  ]);

  const employees = res.employees || [];
  const active = employees.filter((e) => e.active).length;
  const linked = employees.filter((e) => e.userId).length;

  ctx.view.innerHTML = `
    <div class="page-head">
      <div><h1>Employees</h1><div class="sub">Employee master linked to user accounts, departments and reporting lines</div></div>
      <div class="page-actions">
        ${can('employee.manage') ? `<button class="btn btn-primary" type="button" data-new>${icon('plus')} New Employee</button>` : ''}
      </div>
    </div>

    <div class="grid grid-3 mb-16">
      <div class="card"><div class="kpi"><div class="chip blue">${icon('users')}</div><div><div class="label">Employees</div><div class="value">${employees.length}</div><div class="meta">In the selected units</div></div></div></div>
      <div class="card"><div class="kpi"><div class="chip green">${icon('checkCircle')}</div><div><div class="label">Active</div><div class="value">${active}</div><div class="meta">Currently in service</div></div></div></div>
      <div class="card"><div class="kpi"><div class="chip amber">${icon('lock')}</div><div><div class="label">Linked logins</div><div class="value">${linked}</div><div class="meta">Connected to a user account</div></div></div></div>
    </div>

    <div class="card">
      <form class="toolbar" id="employee-filters">
        <div class="search">${icon('search')}<input class="input" name="search" value="${esc(q.search || '')}" placeholder="Name, code, designation, email or mobile..." /></div>
        <select class="select" name="department">
          <option value="">All departments</option>
          ${meta.departments.map((d) => `<option value="${d.id}" ${String(q.department) === String(d.id) ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}
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
        ${employees.length
          ? `<table class="tbl">
              <thead><tr><th>Employee</th><th>Department</th><th>Designation</th><th>Contact</th><th>Reports to</th><th>Unit</th><th>Login</th><th>Status</th><th></th></tr></thead>
              <tbody>${employees.map((e) => `<tr>
                <td>
                  <div style="display:flex;gap:10px;align-items:center">
                    <span class="avatar">${esc(initials(e.name))}</span>
                    <div><div class="strong">${esc(e.name)}</div><div class="small muted mono">${esc(e.employeeCode)}</div></div>
                  </div>
                </td>
                <td>${esc(e.departmentName || '\u2014')}</td>
                <td>${esc(e.designation || '\u2014')}</td>
                <td class="small">${e.email ? `<div>${esc(e.email)}</div>` : ''}${e.mobile ? `<div class="muted">${esc(e.mobile)}</div>` : ''}${!e.email && !e.mobile ? '\u2014' : ''}</td>
                <td>${esc(e.reportingManagerName || '\u2014')}</td>
                <td>${esc(e.unitName || '\u2014')}</td>
                <td>${e.username ? `<span class="chip gray">${esc(e.username)}</span>` : `<span class="small muted">Not linked</span>`}</td>
                <td>${statusBadge(e.active ? 'active' : 'inactive')}</td>
                <td class="actions">
                  ${can('employee.manage') ? `<button class="btn btn-sm btn-ghost" type="button" data-edit="${e.id}" title="Edit">${icon('edit')}</button>
                  <button class="btn btn-sm btn-ghost" type="button" data-retire="${e.id}" title="Retire">${icon('trash')}</button>` : ''}
                </td>
              </tr>`).join('')}</tbody></table>`
          : emptyState(
              'No employees found',
              'Add employees so requirements, approvals and asset allocations can be assigned.',
              can('employee.manage') ? `<button class="btn btn-sm btn-primary" type="button" data-new>New Employee</button>` : '',
              'users'
            )}
      </div>
      <div class="small muted" style="padding:10px 14px">Showing ${employees.length} employee${employees.length === 1 ? '' : 's'}.</div>
    </div>`;

  const form = document.getElementById('employee-filters');
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    navigate(withQuery('/employees', Object.fromEntries(new FormData(form).entries())));
  });
  form.querySelector('[data-reset]').addEventListener('click', () => navigate('/employees'));

  const openForm = async (row = null) => {
    const driver = row
      ? (await api.get(`/api/procurement/employees/${row.id}/driver-profile`)).driverProfile || {}
      : {};
    const unitOptions = meta.units.map((u) => ({ value: u.id, label: `${u.code} \u2014 ${u.name}` }));
    const deptOptions = [{ value: '', label: '\u2014 No department \u2014' }, ...meta.departments.filter((d) => d.active !== 0).map((d) => ({ value: d.id, label: d.name }))];
    const managerOptions = [
      { value: '', label: '\u2014 No reporting manager \u2014' },
      ...meta.managers.filter((m) => !row || m.id !== row.id).map((m) => ({ value: m.id, label: `${m.name} (${m.employee_code})` })),
    ];
    const userOptions = [
      { value: '', label: '\u2014 No login linked \u2014' },
      ...meta.users
        .filter((u) => !u.linked_employee_id || (row && u.linked_employee_id === row.id))
        .map((u) => ({ value: u.id, label: `${u.name} \u2014 ${u.username} (${u.role_name})` })),
    ];

    const unitId = row ? row.unitId : defaultUnitId(meta.units);

    const body = `<form id="employee-form" class="form-grid" autocomplete="off">
      ${field({ label: 'Employee Name', name: 'name', value: row?.name || '', required: true, span: true })}
      ${field({ label: 'Employee Code', name: 'employeeCode', value: row?.employeeCode || '', hint: 'Leave blank to generate automatically.' })}
      ${field({ label: 'Status', name: 'status', type: 'select', value: row?.status || 'Active', options: STATUS_OPTIONS })}
      <div class="field">
        <label>Unit<span class="req">*</span></label>
        <select class="select" name="unitId" required>${optionsHtml(unitOptions, unitId)}</select>
      </div>
      <div class="field">
        <label>Department</label>
        <select class="select" name="departmentId">${optionsHtml(deptOptions, row?.departmentId || '')}</select>
      </div>
      ${field({ label: 'Designation', name: 'designation', value: row?.designation || '' })}
      ${field({ label: 'Email', name: 'email', type: 'email', value: row?.email || '' })}
      ${field({ label: 'Mobile', name: 'mobile', value: row?.mobile || '' })}
      <div class="field">
        <label>Reporting Manager</label>
        <select class="select" name="reportingManagerId">${optionsHtml(managerOptions, row?.reportingManagerId || '')}</select>
      </div>
      <div class="field">
        <label>User Account</label>
        <select class="select" name="userId">${optionsHtml(userOptions, row?.userId || '')}</select>
        <div class="hint">Links this employee to an existing ABMDAS login without changing it.</div>
      </div>
      <div class="field span-2"><div class="label strong">Fleet Desk qualification</div><div class="hint">Shared employee record — no separate driver master is maintained.</div></div>
      ${field({ label: 'Available as a driver', name: 'isDriver', type: 'select', value: driver.isDriver ? '1' : '0', options: [{ value: '0', label: 'No' }, { value: '1', label: 'Yes' }] })}
      ${field({ label: 'Driving licence number', name: 'licenseNo', value: driver.licenseNo || '' })}
      ${field({ label: 'Licence expiry', name: 'licenseExpiry', type: 'date', value: driver.licenseExpiry || '' })}
    </form>`;

    const m = modal({
      title: `${row ? 'Edit' : 'New'} employee`,
      subtitle: row ? `${row.employeeCode} \u00b7 ${row.name}` : 'Add an employee to the master',
      body,
      footer: `<button class="btn" data-cancel>Cancel</button>
               <button class="btn btn-primary" data-save>${icon('check')} ${row ? 'Save changes' : 'Create employee'}</button>`,
      size: 'wide',
    });

    m.el.querySelector('[data-cancel]').addEventListener('click', m.close);
    m.el.querySelector('[data-save]').addEventListener('click', async () => {
      const form = m.el.querySelector('#employee-form');
      const data = {
        name: form.name.value.trim(),
        employeeCode: form.employeeCode.value.trim(),
        status: form.status.value,
        unitId: form.unitId.value,
        departmentId: form.departmentId.value || null,
        designation: form.designation.value.trim(),
        email: form.email.value.trim(),
        mobile: form.mobile.value.trim(),
        reportingManagerId: form.reportingManagerId.value || null,
        userId: form.userId.value || null,
      };
      if (!data.name) {
        toast('Employee name is required.', 'error');
        form.name.focus();
        return;
      }
      if (!data.unitId) {
        toast('Select a unit.', 'error');
        return;
      }
      const driverData = {
        isDriver: form.isDriver.value === '1',
        licenseNo: form.licenseNo.value.trim(),
        licenseExpiry: form.licenseExpiry.value,
      };
      try {
        let employeeId;
        if (row) {
          await api.put(`/api/procurement/employees/${row.id}`, data);
          employeeId = row.id;
          toast('Employee updated.');
        } else {
          const created = await api.post('/api/procurement/employees', data);
          employeeId = created.id;
          toast('Employee created.');
        }
        await api.put(`/api/procurement/employees/${employeeId}/driver-profile`, driverData);
        m.close();
        navigate('/employees');
      } catch (e) {
        toast(e.message || 'Unable to save the employee.', 'error');
      }
    });
  };

  const openRetire = async (row) => {
    const ok = await confirmDialog({
      title: 'Retire employee',
      message: `Retire ${row.name} (${row.employeeCode})? The record is preserved for history and the linked login is not affected.`,
      confirmText: 'Retire employee',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.del(`/api/procurement/employees/${row.id}`);
      toast('Employee retired.');
      navigate('/employees');
    } catch (e) {
      toast(e.message || 'Unable to retire the employee.', 'error');
    }
  };

  for (const btn of ctx.view.querySelectorAll('[data-new]')) btn.addEventListener('click', () => openForm());
  for (const btn of ctx.view.querySelectorAll('[data-edit]')) {
    btn.addEventListener('click', () => openForm(employees.find((e) => String(e.id) === btn.dataset.edit)));
  }
  for (const btn of ctx.view.querySelectorAll('[data-retire]')) {
    btn.addEventListener('click', () => openRetire(employees.find((e) => String(e.id) === btn.dataset.retire)));
  }
}

export function render(ctx, options = {}) {
  if (options.id) return renderOne(ctx, Number(options.id));
  return renderList(ctx);
}

async function renderOne(ctx, id) {
  await renderList(ctx);
  const edit = ctx.view.querySelector(`[data-edit="${id}"]`);
  if (edit) edit.click();
}
