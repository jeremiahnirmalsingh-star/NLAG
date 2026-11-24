import { api } from '../api.js';
import { state, can, applyBootstrap } from '../state.js';
import { navigate, reloadPage, withQuery } from '../router.js';
import { stopSessionTimeout, broadcastLogout } from '../session.js';
import {
  esc, icon, money, num, fmtDate, statusBadge, emptyState, toast, modal, field,
  confirmDialog, initials, readFileAsBase64, fileSize,
} from '../ui.js';

/* ================================================================== */
/* Shared helpers                                                      */
/* ================================================================== */
function signatureSrc(value) {
  if (!value) return '';
  return value.startsWith('data:') ? value : `data:image/png;base64,${value}`;
}

function errorBox(el, message) {
  const box = el.querySelector('[data-err]');
  if (!box) return;
  box.textContent = message;
  box.classList.remove('hidden');
}

async function refreshMeta() {
  const boot = await api.get('/api/meta/bootstrap', { silent: true });
  applyBootstrap(boot);
}

/* ================================================================== */
/* USERS                                                               */
/* ================================================================== */
export async function renderUsers(ctx) {
  const q = ctx.route.query;
  const params = new URLSearchParams();
  if (q.search) params.set('search', q.search);
  if (q.status) params.set('status', q.status);

  ctx.view.innerHTML = `<div class="empty">Loading users\u2026</div>`;
  const [usersRes, rolesRes] = await Promise.all([
    api.get(`/api/users?${params.toString()}`),
    api.get('/api/roles'),
  ]);
  const users = usersRes.users;
  const roles = rolesRes.roles;

  const active = users.filter((u) => u.status === 'Active').length;
  const inactive = users.filter((u) => u.status !== 'Active').length;

  ctx.view.innerHTML = `
    <div class="page-head">
      <div><h1>User Management</h1><div class="sub">Create accounts, assign roles and manage access to the system</div></div>
      <div class="page-actions">
        ${can('user.manage') ? `<button class="btn btn-primary" data-new>${icon('plus')} New User</button>` : ''}
      </div>
    </div>

    <div class="grid grid-4 mb-16">
      <div class="card"><div class="kpi"><div class="chip blue">${icon('users')}</div>
        <div><div class="label">Total users</div><div class="value">${num(users.length)}</div><div class="meta">All accounts</div></div></div></div>
      <div class="card"><div class="kpi"><div class="chip green">${icon('checkCircle')}</div>
        <div><div class="label">Active</div><div class="value">${num(active)}</div><div class="meta">Can sign in</div></div></div></div>
      <div class="card"><div class="kpi"><div class="chip gray">${icon('lock')}</div>
        <div><div class="label">Inactive / locked</div><div class="value">${num(inactive)}</div><div class="meta">Access blocked</div></div></div></div>
      <div class="card"><div class="kpi"><div class="chip purple">${icon('shield')}</div>
        <div><div class="label">Roles defined</div><div class="value">${num(roles.length)}</div><div class="meta">Access profiles</div></div></div></div>
    </div>

    <div class="card">
      <form class="toolbar" id="user-filters">
        <div class="search">${icon('search')}
          <input class="input" name="search" value="${esc(q.search || '')}" placeholder="Name, username, employee ID or email\u2026" />
        </div>
        <select class="select" name="status">
          <option value="">All statuses</option>
          ${['Active', 'Inactive', 'Locked'].map((s) => `<option value="${s}" ${q.status === s ? 'selected' : ''}>${s}</option>`).join('')}
        </select>
        <button class="btn btn-sm" type="submit">${icon('filter')} Apply</button>
        <button class="btn btn-sm btn-ghost" type="button" data-reset>Reset</button>
      </form>
      <div class="table-wrap">
        ${users.length
          ? `<table class="tbl">
              <thead><tr><th>Employee</th><th>Role</th><th>Unit</th><th>Department</th><th>Contact</th><th>Last login</th><th>Status</th><th></th></tr></thead>
              <tbody>
                ${users
                  .map(
                    (u) => `<tr>
                      <td>
                        <div class="row" style="gap:10px;flex-wrap:nowrap">
                          <span class="avatar" style="width:32px;height:32px">${esc(initials(u.name))}</span>
                          <div style="min-width:0">
                            <div class="strong">${esc(u.name)}</div>
                            <div class="small muted mono">${esc(u.username)} \u00b7 ${esc(u.employeeId)}</div>
                          </div>
                        </div>
                      </td>
                      <td>${esc(u.roleName)}<div class="small muted mono">${esc(u.roleCode)}</div></td>
        <td>${esc(u.unitName || '\u2014')}</td>
                      <td>${esc(u.department || '\u2014')}<div class="small muted">${esc(u.designation || '')}</div></td>
                      <td class="small">${esc(u.email || '\u2014')}<div class="muted">${esc(u.mobile || '')}</div></td>
                      <td class="small">${u.lastLoginAt ? fmtDate(u.lastLoginAt, true) : '\u2014'}</td>
                      <td>${statusBadge(u.status === 'Active' ? 'active' : u.status === 'Locked' ? 'locked' : 'inactive', u.status)}</td>
                      <td class="actions">
                        <button class="btn btn-sm btn-ghost" data-edit="${u.id}" title="Edit user">${icon('edit')}</button>
                        <button class="btn btn-sm btn-ghost" data-reset-pass="${u.id}" data-name="${esc(u.name)}" title="Reset password">${icon('lock')}</button>
                        ${u.id !== state.user.id
                          ? `<button class="btn btn-sm btn-ghost" data-delete="${u.id}" data-name="${esc(u.name)}" title="Deactivate / delete">${icon('trash')}</button>`
                          : ''}
                      </td>
                    </tr>`
                  )
                  .join('')}
              </tbody>
            </table>`
          : emptyState('No users found', 'Create the first user account or adjust the filters.', '<button class="btn btn-sm btn-primary" data-new>New User</button>', 'users')}
      </div>
    </div>`;

  const filterForm = document.getElementById('user-filters');
  filterForm.addEventListener('submit', (e) => {
    e.preventDefault();
    navigate(withQuery('/users', Object.fromEntries(new FormData(filterForm).entries())));
  });
  filterForm.querySelector('[data-reset]').addEventListener('click', () => navigate('/users'));

  ctx.view.querySelectorAll('[data-new]').forEach((b) => b.addEventListener('click', () => openUserDialog(null, roles)));
  ctx.view.querySelectorAll('[data-edit]').forEach((b) => {
    b.addEventListener('click', () => openUserDialog(users.find((u) => String(u.id) === b.dataset.edit), roles));
  });
  ctx.view.querySelectorAll('[data-reset-pass]').forEach((b) => {
    b.addEventListener('click', () => openResetPassword(b.dataset.resetPass, b.dataset.name));
  });
  ctx.view.querySelectorAll('[data-delete]').forEach((b) => {
    b.addEventListener('click', () => deleteUser(b.dataset.delete, b.dataset.name));
  });
}

function openUserDialog(user, roles) {
  const editing = Boolean(user);
  const roleOptions = roles.map((r) => ({ value: r.id, label: r.name }));

  modal({
    title: editing ? 'Edit user' : 'New user',
    subtitle: editing ? `${user.name} \u00b7 ${user.employeeId}` : 'Create an account for a staff member',
    size: 'wide',
    body: `<form id="user-form">
      <div class="form-grid">
        ${field({ label: 'Employee ID', name: 'employeeId', value: user ? user.employeeId : '', required: true, placeholder: 'e.g. NL-1007' })}
        ${field({ label: 'Full Name', name: 'name', value: user ? user.name : '', required: true })}
        ${field({ label: 'Username', name: 'username', value: user ? user.username : '', required: true, placeholder: 'lowercase, no spaces' })}
        ${field({ label: 'Role', name: 'roleId', type: 'select', value: user ? user.roleId : '', required: true, options: [{ value: '', label: '\u2014 Select role \u2014' }, ...roleOptions] })}
        <div class="field">
          <label>Units <span class="req">*</span></label>
          <div style="display:flex;flex-wrap:wrap;gap:10px;padding:8px 0">
            ${state.units.filter((u) => u.active || (user && (user.unitIds || []).includes(u.id))).map((u) => {
              const checked = user && (user.unitIds || []).includes(u.id) ? 'checked' : '';
              return `<label style="display:flex;align-items:center;gap:6px;font-size:13px"><input type="checkbox" name="unitIds" value="${u.id}" ${checked} /> ${u.name}</label>`;
            }).join('')}
          </div>
          <div class="hint">Staff see only their own unit's bills. Administrator-level roles see all units together. Only super administrators can be unit-less. Select at least one unit.</div>
        </div>
        ${editing ? '' : field({ label: 'Temporary Password', name: 'password', type: 'password', required: true, hint: 'Minimum 8 characters. The user can change it after signing in.' })}
        ${field({ label: 'Status', name: 'status', type: 'select', value: user ? user.status : 'Active', options: [
          { value: 'Active', label: 'Active' }, { value: 'Inactive', label: 'Inactive' }, { value: 'Locked', label: 'Locked' },
        ] })}
        ${field({ label: 'Department', name: 'department', value: user ? user.department || '' : '' })}
        ${field({ label: 'Designation', name: 'designation', value: user ? user.designation || '' : '' })}
        ${field({ label: 'Mobile', name: 'mobile', value: user ? user.mobile || '' : '' })}
        ${field({ label: 'Email', name: 'email', type: 'email', value: user ? user.email || '' : '' })}
      </div>
      <div class="field">
        <label>Digital signature (optional)</label>
        <input class="input" type="file" data-signature accept="image/png,image/jpeg" />
        <div class="hint">PNG or JPG, up to 5 MB. The saved signature is stamped on approvals.</div>
        <div data-sig-preview class="mt-8">
          ${user && user.signatureImage ? `<img class="signature-thumb" src="${signatureSrc(user.signatureImage)}" alt="Signature" />` : ''}
        </div>
      </div>
      <div class="alert alert-danger hidden" data-err></div>
    </form>`,
    footer: `<button class="btn" data-modal-close>Cancel</button>
             <button class="btn btn-primary" data-save>${editing ? 'Save changes' : 'Create user'}</button>`,
    onMount(el, close) {
      const form = el.querySelector('#user-form');
      let signatureData = user ? user.signatureImage || null : null;

      el.querySelector('[data-signature]').addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        if (file.size > 5 * 1024 * 1024) {
          toast('Signature image must be under 5 MB.', 'error');
          e.target.value = '';
          return;
        }
        const fileData = await readFileAsBase64(file);
        signatureData = `data:${fileData.mime};base64,${fileData.data}`;
        el.querySelector('[data-sig-preview]').innerHTML = `<img class="signature-thumb" src="${signatureData}" alt="Signature" />`;
      });

      el.querySelector('[data-save]').addEventListener('click', async () => {
        const body = {
          employeeId: form.employeeId.value.trim(),
          name: form.name.value.trim(),
          username: form.username.value.trim(),
          roleId: form.roleId.value,
          unitIds: [...form.querySelectorAll('input[name="unitIds"]:checked')].map((el) => Number(el.value)),
          status: form.status.value,
          department: form.department.value.trim(),
          designation: form.designation.value.trim(),
          mobile: form.mobile.value.trim(),
          email: form.email.value.trim(),
          signatureImage: signatureData,
        };
        if (!body.employeeId || !body.name || !body.username || !body.roleId) {
          errorBox(el, 'Employee ID, name, username and role are required.');
          return;
        }
        if (!editing) {
          body.password = form.password.value;
          if (!body.password || body.password.length < 8) {
            errorBox(el, 'The temporary password must be at least 8 characters.');
            return;
          }
        }
        const btn = el.querySelector('[data-save]');
        btn.disabled = true;
        try {
          if (editing) await api.put(`/api/users/${user.id}`, body);
          else await api.post('/api/users', body);
          close();
          toast(editing ? 'User updated.' : 'User account created.');
          reloadPage();
        } catch (e) {
          btn.disabled = false;
          errorBox(el, e.message);
        }
      });
    },
  });
}

function openResetPassword(id, name) {
  modal({
    title: 'Reset password',
    subtitle: name,
    body: `<form id="rp-form">
      <div class="field"><label>New password</label>
        <input class="input" type="password" name="password" minlength="8" required />
        <div class="hint">Minimum 8 characters. All active sessions for this user will be signed out.</div>
      </div>
      <div class="alert alert-danger hidden" data-err></div>
    </form>`,
    footer: `<button class="btn" data-modal-close>Cancel</button>
             <button class="btn btn-primary" data-save>Reset password</button>`,
    onMount(el, close) {
      const form = el.querySelector('#rp-form');
      el.querySelector('[data-save]').addEventListener('click', async () => {
        const password = form.password.value;
        if (!password || password.length < 8) {
          errorBox(el, 'Password must be at least 8 characters.');
          return;
        }
        try {
          await api.post(`/api/users/${id}/reset-password`, { password });
          close();
          toast('Password reset. The user must change it at next sign-in.');
        } catch (e) {
          errorBox(el, e.message);
        }
      });
    },
  });
}

async function deleteUser(id, name) {
  const ok = await confirmDialog({
    title: 'Remove user',
    message: `Remove access for ${name}? Users with existing records are deactivated instead of deleted, preserving the audit trail.`,
    confirmText: 'Remove user',
    danger: true,
  });
  if (!ok) return;
  try {
    const res = await api.del(`/api/users/${id}`);
    toast(res.deactivated ? 'User deactivated (historical records retained).' : 'User deleted.');
    reloadPage();
  } catch (e) {
    toast(e.message, 'error');
  }
}

/* ================================================================== */
/* ROLES                                                               */
/* ================================================================== */
export async function renderRoles(ctx) {
  ctx.view.innerHTML = `<div class="empty">Loading roles\u2026</div>`;
  const [rolesRes, permsRes] = await Promise.all([
    api.get('/api/roles'),
    api.get('/api/permissions'),
  ]);
  const roles = rolesRes.roles;
  const permissions = permsRes.permissions;

  ctx.view.innerHTML = `
    <div class="page-head">
      <div><h1>Roles &amp; Permissions</h1><div class="sub">Define access profiles and control what each role can do</div></div>
      <div class="page-actions">
        ${can('role.manage') ? `<button class="btn btn-primary" data-new>${icon('plus')} New Role</button>` : ''}
      </div>
    </div>

    <div class="grid grid-2">
      ${roles
        .map(
          (r) => `<div class="card">
            <div class="card-head">
              <div class="chip ${r.code === 'super_admin' ? 'purple' : 'teal'}">${icon('shield')}</div>
              <div><h3>${esc(r.name)}</h3><div class="sub mono">${esc(r.code)} \u00b7 ${num(r.userCount)} user${r.userCount === 1 ? '' : 's'}</div></div>
              <div class="actions">
                ${r.is_system ? '<span class="badge-plain">System role</span>' : ''}
                ${r.code !== 'super_admin' && can('role.manage')
                  ? `<button class="btn btn-sm" data-edit="${r.id}">${icon('edit')} Edit</button>`
                  : ''}
                ${!r.is_system && can('role.manage')
                  ? `<button class="btn btn-sm btn-ghost" data-delete="${r.id}" data-name="${esc(r.name)}">${icon('trash')}</button>`
                  : ''}
              </div>
            </div>
            <div class="card-body">
              <div class="small muted mb-8">${esc(r.description || 'No description provided.')}</div>
              ${
                r.code === 'super_admin'
                  ? `<div class="alert alert-info" style="margin:0">${icon('info')}<div>Full access to every module. This role cannot be modified.</div></div>`
                  : `<div class="row">${
                      r.permissions.length
                        ? r.permissions
                            .slice(0, 12)
                            .map((p) => `<span class="tag">${esc(p)}</span>`)
                            .join('') + (r.permissions.length > 12 ? `<span class="tag">+${r.permissions.length - 12} more</span>` : '')
                        : '<span class="small muted">No permissions granted.</span>'
                    }</div>`
              }
            </div>
          </div>`
        )
        .join('')}
    </div>`;

  ctx.view.querySelectorAll('[data-new]').forEach((b) => b.addEventListener('click', () => openRoleDialog(null, permissions)));
  ctx.view.querySelectorAll('[data-edit]').forEach((b) => {
    b.addEventListener('click', () => openRoleDialog(roles.find((r) => String(r.id) === b.dataset.edit), permissions));
  });
  ctx.view.querySelectorAll('[data-delete]').forEach((b) => {
    b.addEventListener('click', () => deleteRole(b.dataset.delete, b.dataset.name));
  });
}

function permissionGroups(permissions) {
  const groups = [];
  const map = new Map();
  for (const p of permissions) {
    if (!map.has(p.module)) {
      map.set(p.module, []);
      groups.push({ module: p.module, items: map.get(p.module) });
    }
    map.get(p.module).push(p);
  }
  return groups;
}

function openRoleDialog(role, permissions) {
  const editing = Boolean(role);
  const selected = new Set(role ? role.permissions : ['dashboard.view']);
  const groups = permissionGroups(permissions);

  modal({
    title: editing ? 'Edit role' : 'New role',
    subtitle: editing ? role.name : 'Create a custom access profile',
    size: 'wide',
    body: `<form id="role-form">
      <div class="form-grid">
        ${field({ label: 'Role Code', name: 'code', value: role ? role.code : '', required: !editing, placeholder: 'e.g. finance_reviewer', attrs: editing ? 'disabled' : '', hint: 'Lowercase letters, numbers and underscores only.' })}
        ${field({ label: 'Role Name', name: 'name', value: role ? role.name : '', required: true })}
        ${field({ label: 'Description', name: 'description', value: role ? role.description || '' : '', span: true })}
      </div>
      <div class="section-title">Permissions</div>
      <div class="perm-grid">
        ${groups
          .map(
            (g) => `<div class="perm-module">${esc(g.module)}</div>
              ${g.items
                .map(
                  (p) => `<label class="perm-item">
                    <input type="checkbox" name="perm" value="${esc(p.key)}" ${selected.has(p.key) ? 'checked' : ''} />
                    <span><b style="font-weight:600">${esc(p.label)}</b><br><span class="small muted mono">${esc(p.key)}</span></span>
                  </label>`
                )
                .join('')}`
          )
          .join('')}
      </div>
      <div class="alert alert-danger hidden mt-12" data-err></div>
    </form>`,
    footer: `<button class="btn" data-modal-close>Cancel</button>
             <button class="btn btn-primary" data-save>${editing ? 'Save role' : 'Create role'}</button>`,
    onMount(el, close) {
      const form = el.querySelector('#role-form');
      el.querySelector('[data-save]').addEventListener('click', async () => {
        const perms = Array.from(form.querySelectorAll('[name=perm]:checked')).map((c) => c.value);
        const body = {
          name: form.name.value.trim(),
          description: form.description.value.trim(),
          permissions: perms,
        };
        if (!body.name) {
          errorBox(el, 'Role name is required.');
          return;
        }
        if (!editing) {
          body.code = form.code.value.trim();
          if (!/^[a-z0-9_]+$/.test(body.code)) {
            errorBox(el, 'Role code may contain lowercase letters, numbers and underscores only.');
            return;
          }
        }
        try {
          if (editing) await api.put(`/api/roles/${role.id}`, body);
          else await api.post('/api/roles', body);
          close();
          toast(editing ? 'Role updated.' : 'Role created.');
          reloadPage();
        } catch (e) {
          errorBox(el, e.message);
        }
      });
    },
  });
}

async function deleteRole(id, name) {
  const ok = await confirmDialog({
    title: 'Delete role',
    message: `Delete the role "${name}"? Roles assigned to users cannot be deleted.`,
    confirmText: 'Delete role',
    danger: true,
  });
  if (!ok) return;
  try {
    await api.del(`/api/roles/${id}`);
    toast('Role deleted.');
    reloadPage();
  } catch (e) {
    toast(e.message, 'error');
  }
}

/* ================================================================== */
/* WORKFLOW                                                            */
/* ================================================================== */
export async function renderWorkflow(ctx) {
  ctx.view.innerHTML = `<div class="empty">Loading approval workflow\u2026</div>`;
  const [wf, usersRes] = await Promise.all([
    api.get('/api/workflow'),
    can('user.manage') ? api.get('/api/users?status=Active').catch(() => ({ users: [] })) : Promise.resolve({ users: [] }),
  ]);
  const rules = wf.rules;
  const users = usersRes.users;
  const roles = state.roles;

  const totalStages = rules.reduce((s, r) => s + r.stages.length, 0);

  ctx.view.innerHTML = `
    <div class="page-head">
      <div><h1>Approval Workflow</h1>
        <div class="sub">Amount-based approval chains applied automatically when a bill is submitted</div></div>
      <div class="page-actions">
        <button class="btn btn-primary" data-new>${icon('plus')} New Rule</button>
      </div>
    </div>

    <div class="alert alert-info">
      ${icon('info')}
      <div><b>How the workflow works.</b> When a bill is submitted, the highest-value matching rule determines its approval chain.
      The lowest matching threshold wins; if no rule matches, a fallback single-stage approval is used. Rules are evaluated using the bill's net amount.</div>
    </div>

    <div class="grid grid-3 mb-16">
      <div class="card"><div class="kpi"><div class="chip blue">${icon('branch')}</div>
        <div><div class="label">Workflow rules</div><div class="value">${num(rules.length)}</div><div class="meta">${num(rules.filter((r) => r.active).length)} active</div></div></div></div>
      <div class="card"><div class="kpi"><div class="chip teal">${icon('layers')}</div>
        <div><div class="label">Approval stages</div><div class="value">${num(totalStages)}</div><div class="meta">Across all rules</div></div></div></div>
      <div class="card"><div class="kpi"><div class="chip purple">${icon('shield')}</div>
        <div><div class="label">Approver roles</div><div class="value">${num(new Set(rules.flatMap((r) => r.stages.map((s) => s.role_id))).size)}</div><div class="meta">Distinct roles involved</div></div></div></div>
    </div>

    <div class="stack">
      ${rules.length
        ? rules
            .map(
              (r) => `<div class="card">
                <div class="card-head">
                  <div class="chip ${r.active ? 'teal' : 'gray'}">${icon('branch')}</div>
                  <div>
                    <h3>${esc(r.name)} ${statusBadge(r.active ? 'active' : 'inactive', r.active ? 'Active' : 'Inactive')}</h3>
                    <div class="sub">${money(r.min_amount)} ${r.max_amount === null ? 'and above' : `\u2013 ${money(r.max_amount)}`} \u00b7 ${r.stages.length} stage${r.stages.length === 1 ? '' : 's'}</div>
                  </div>
                  <div class="actions">
                    <button class="btn btn-sm" data-edit="${r.id}">${icon('edit')} Edit</button>
                    <button class="btn btn-sm btn-ghost" data-delete="${r.id}" data-name="${esc(r.name)}">${icon('trash')}</button>
                  </div>
                </div>
                <div class="table-wrap">
                  <table class="tbl">
                    <thead><tr><th style="width:70px">Stage</th><th>Approval Step</th><th>Approver Role</th><th>Specific Approver</th><th>Escalation</th></tr></thead>
                    <tbody>
                      ${r.stages
                        .map(
                          (s) => `<tr>
                            <td><span class="badge-plain">${s.sequence}</span></td>
                            <td class="strong">${esc(s.name)}</td>
                            <td>${esc(s.role_name)}</td>
                            <td>${esc(s.user_name || '\u2014')}${s.alt_user_name ? `<div class="small muted">Alt: ${esc(s.alt_user_name)}</div>` : ''}</td>
                            <td>${s.escalation_days ? `${s.escalation_days} day${s.escalation_days === 1 ? '' : 's'}` : '\u2014'}</td>
                          </tr>`
                        )
                        .join('')}
                    </tbody>
                  </table>
                </div>
              </div>`
            )
            .join('')
        : `<div class="card">${emptyState('No workflow rules', 'Create an amount-based rule to define who approves each bill.', '<button class="btn btn-sm btn-primary" data-new>New Rule</button>', 'branch')}</div>`}
    </div>`;

  ctx.view.querySelectorAll('[data-new]').forEach((b) => b.addEventListener('click', () => openRuleDialog(null, roles, users)));
  ctx.view.querySelectorAll('[data-edit]').forEach((b) => {
    b.addEventListener('click', () => openRuleDialog(rules.find((r) => String(r.id) === b.dataset.edit), roles, users));
  });
  ctx.view.querySelectorAll('[data-delete]').forEach((b) => {
    b.addEventListener('click', () => deleteRule(b.dataset.delete, b.dataset.name));
  });
}

function stageRowHtml(index, stage, roles, users) {
  const roleOptions = roles
    .map((r) => `<option value="${r.id}" ${stage && String(stage.role_id) === String(r.id) ? 'selected' : ''}>${esc(r.name)}</option>`)
    .join('');
  return `<div class="stage-row" style="border:1px solid var(--border);border-radius:10px;padding:12px;margin-bottom:10px;background:#fafbfd">
    <div class="row" style="justify-content:space-between;margin-bottom:8px">
      <b class="small" data-stage-label>Stage ${index + 1}</b>
      <button type="button" class="btn btn-sm btn-ghost" data-remove-stage>${icon('x')} Remove</button>
    </div>
    <div class="form-grid-3">
      <div class="field" style="margin:0"><label>Stage name</label>
        <input class="input" data-stage-name value="${esc(stage ? stage.name : '')}" placeholder="e.g. Departmental Verification" /></div>
      <div class="field" style="margin:0"><label>Approver role</label>
        <select class="select" data-stage-role>${roleOptions}</select></div>
      <div class="field" style="margin:0"><label>Escalation (days)</label>
        <input class="input" type="number" min="1" max="30" data-stage-days value="${stage ? stage.escalation_days || 3 : 3}" /></div>
      ${
        users.length
          ? `<div class="field" style="margin:0;grid-column:span 2"><label>Specific approver (optional)</label>
              <select class="select" data-stage-user>
                <option value="">Any user with the selected role</option>
                ${users
                  .map((u) => `<option value="${u.id}" ${stage && String(stage.user_id) === String(u.id) ? 'selected' : ''}>${esc(u.name)} \u2014 ${esc(u.roleName)}</option>`)
                  .join('')}
              </select></div>`
          : ''
      }
    </div>
  </div>`;
}

function openRuleDialog(rule, roles, users) {
  const editing = Boolean(rule);
  const stages = rule ? rule.stages.slice() : [{ name: 'Departmental Verification', role_id: roles[0] ? roles[0].id : '', escalation_days: 3 }];

  modal({
    title: editing ? 'Edit workflow rule' : 'New workflow rule',
    subtitle: 'Choose the amount band and the approval chain that applies to it',
    size: 'xwide',
    body: `<form id="rule-form">
      <div class="form-grid">
        ${field({ label: 'Rule Name', name: 'name', value: rule ? rule.name : '', required: true, span: true, placeholder: 'e.g. Bills above 50,000' })}
        ${field({ label: 'Minimum Amount', name: 'minAmount', type: 'number', value: rule ? rule.min_amount : 0, required: true, attrs: 'step="0.01" min="0"' })}
        ${field({ label: 'Maximum Amount', name: 'maxAmount', type: 'number', value: rule && rule.max_amount !== null ? rule.max_amount : '', attrs: 'step="0.01" min="0"', hint: 'Leave blank for no upper limit.' })}
      </div>
      <label class="check mb-16"><input type="checkbox" name="active" ${!rule || rule.active ? 'checked' : ''} /> Rule is active</label>

      <div class="row" style="justify-content:space-between">
        <div class="section-title" style="margin:0">Approval Stages</div>
        <button type="button" class="btn btn-sm" data-add-stage>${icon('plus')} Add stage</button>
      </div>
      <div data-stages class="mt-8">
        ${stages.map((s, i) => stageRowHtml(i, s, roles, users)).join('')}
      </div>
      <div class="alert alert-danger hidden mt-8" data-err></div>
    </form>`,
    footer: `<button class="btn" data-modal-close>Cancel</button>
             <button class="btn btn-primary" data-save>${editing ? 'Save rule' : 'Create rule'}</button>`,
    onMount(el, close) {
      const form = el.querySelector('#rule-form');
      const container = el.querySelector('[data-stages]');

      const renumber = () => {
        const rows = Array.from(container.querySelectorAll('.stage-row'));
        rows.forEach((row, i) => {
          row.querySelector('[data-stage-label]').textContent = `Stage ${i + 1}`;
          row.querySelector('[data-remove-stage]').style.display = rows.length === 1 ? 'none' : '';
        });
      };
      const bindRemove = () => {
        container.querySelectorAll('[data-remove-stage]').forEach((btn) => {
          btn.onclick = () => {
            const rows = container.querySelectorAll('.stage-row');
            if (rows.length === 1) return;
            btn.closest('.stage-row').remove();
            renumber();
          };
        });
      };

      el.querySelector('[data-add-stage]').addEventListener('click', () => {
        const index = container.querySelectorAll('.stage-row').length;
        container.insertAdjacentHTML('beforeend', stageRowHtml(index, null, roles, users));
        renumber();
        bindRemove();
      });
      bindRemove();
      renumber();

      el.querySelector('[data-save]').addEventListener('click', async () => {
        const body = {
          name: form.name.value.trim(),
          minAmount: Number(form.minAmount.value) || 0,
          maxAmount: form.maxAmount.value === '' ? null : Number(form.maxAmount.value),
          active: form.active.checked,
          stages: [],
        };
        if (!body.name) {
          errorBox(el, 'Rule name is required.');
          return;
        }
        if (body.maxAmount !== null && body.maxAmount < body.minAmount) {
          errorBox(el, 'Maximum amount cannot be less than the minimum amount.');
          return;
        }
        let invalid = false;
        container.querySelectorAll('.stage-row').forEach((row, i) => {
          const name = row.querySelector('[data-stage-name]').value.trim();
          const roleId = row.querySelector('[data-stage-role]').value;
          const days = Number(row.querySelector('[data-stage-days]').value) || 3;
          const userSelect = row.querySelector('[data-stage-user]');
          if (!name || !roleId) invalid = true;
          body.stages.push({
            name: name || `Stage ${i + 1}`,
            roleId: Number(roleId),
            userId: userSelect && userSelect.value ? Number(userSelect.value) : null,
            escalationDays: days,
          });
        });
        if (invalid || !body.stages.length) {
          errorBox(el, 'Every stage needs a name and an approver role.');
          return;
        }
        try {
          if (editing) await api.put(`/api/workflow/rules/${rule.id}`, body);
          else await api.post('/api/workflow/rules', body);
          close();
          toast(editing ? 'Workflow rule updated.' : 'Workflow rule created.');
          reloadPage();
        } catch (e) {
          errorBox(el, e.message);
        }
      });
    },
  });
}

async function deleteRule(id, name) {
  const ok = await confirmDialog({
    title: 'Delete workflow rule',
    message: `Delete the workflow rule "${name}"? Existing bills keep their approval history.`,
    confirmText: 'Delete rule',
    danger: true,
  });
  if (!ok) return;
  try {
    await api.del(`/api/workflow/rules/${id}`);
    toast('Workflow rule deleted.');
    reloadPage();
  } catch (e) {
    toast(e.message, 'error');
  }
}

/* ================================================================== */
/* AUDIT TRAIL                                                         */
/* ================================================================== */
export async function renderAudit(ctx) {
  const q = ctx.route.query;
  const params = new URLSearchParams();
  ['search', 'action', 'entityType', 'from', 'to', 'page'].forEach((k) => {
    if (q[k]) params.set(k, q[k]);
  });
  params.set('pageSize', '50');

  ctx.view.innerHTML = `<div class="empty">Loading audit trail\u2026</div>`;
  const res = await api.get(`/api/audit?${params.toString()}`);
  const pages = Math.max(1, Math.ceil(res.total / res.pageSize));

  ctx.view.innerHTML = `
    <div class="page-head">
      <div><h1>Audit Trail</h1><div class="sub">Immutable record of every action taken in the system</div></div>
      <div class="page-actions"><span class="badge-plain">${num(res.total)} entries</span></div>
    </div>

    <div class="card">
      <form class="toolbar" id="audit-filters">
        <div class="search">${icon('search')}
          <input class="input" name="search" value="${esc(q.search || '')}" placeholder="Action, entity or user\u2026" />
        </div>
        <input class="input" name="action" value="${esc(q.action || '')}" placeholder="Action e.g. LOGIN" style="width:150px" />
        <select class="select" name="entityType">
          <option value="">All entities</option>
          ${['bill', 'vendor', 'advance', 'user', 'role', 'workflow_rule', 'settings', 'handover']
            .map((t) => `<option value="${t}" ${q.entityType === t ? 'selected' : ''}>${t}</option>`)
            .join('')}
        </select>
        <input class="input" type="date" name="from" value="${esc(q.from || '')}" title="From date" style="width:140px" />
        <input class="input" type="date" name="to" value="${esc(q.to || '')}" title="To date" style="width:140px" />
        <button class="btn btn-sm" type="submit">${icon('filter')} Apply</button>
        <button class="btn btn-sm btn-ghost" type="button" data-reset>Reset</button>
      </form>

      <div class="table-wrap">
        ${res.logs.length
          ? `<table class="tbl">
              <thead><tr><th>When</th><th>User</th><th>Action</th><th>Entity</th><th>Details</th><th></th></tr></thead>
              <tbody>
                ${res.logs
                  .map(
                    (l, i) => `<tr>
                      <td class="small nowrap">${fmtDate(l.created_at, true)}
                        <div class="small muted mono">${esc(l.ip_address || '')}</div></td>
                      <td>${esc(l.user_name || 'System')}<div class="small muted">${esc(l.user_designation || '')}</div></td>
                      <td><span class="badge-plain">${esc(l.action)}</span></td>
                      <td class="small">${esc(l.entity_type)}${l.entity_id ? `<span class="muted mono"> #${esc(l.entity_id)}</span>` : ''}</td>
                      <td class="small muted">${summary(l)}</td>
                      <td class="actions"><button class="btn btn-sm btn-ghost" data-detail="${i}" title="View details">${icon('eye')}</button></td>
                    </tr>`
                  )
                  .join('')}
              </tbody>
            </table>`
          : emptyState('No audit entries found', 'Try clearing the filters or widening the date range.', '', 'clock')}
      </div>

      ${pages > 1
        ? `<div class="pager">
            <span>Page ${res.page} of ${pages} \u00b7 ${num(res.total)} entries</span>
            <span class="spacer"></span>
            <button class="btn btn-sm" data-page="${res.page - 1}" ${res.page <= 1 ? 'disabled' : ''}>${icon('chevronLeft')} Previous</button>
            <button class="btn btn-sm" data-page="${res.page + 1}" ${res.page >= pages ? 'disabled' : ''}>Next ${icon('chevronRight')}</button>
          </div>`
        : ''}
    </div>`;

  const filterForm = document.getElementById('audit-filters');
  filterForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(filterForm).entries());
    delete data.page;
    navigate(withQuery('/audit', data));
  });
  filterForm.querySelector('[data-reset]').addEventListener('click', () => navigate('/audit'));

  ctx.view.querySelectorAll('[data-page]').forEach((btn) => {
    btn.addEventListener('click', () => navigate(withQuery('/audit', { ...q, page: btn.dataset.page })));
  });

  ctx.view.querySelectorAll('[data-detail]').forEach((btn) => {
    const log = res.logs[Number(btn.dataset.detail)];
    btn.addEventListener('click', () => {
      modal({
        title: 'Audit entry details',
        subtitle: `${log.action} \u00b7 ${log.entity_type}${log.entity_id ? ` #${log.entity_id}` : ''}`,
        size: 'wide',
        body: `<dl class="dl compact">
            <dt>Timestamp</dt><dd>${fmtDate(log.created_at, true)}</dd>
            <dt>User</dt><dd>${esc(log.user_name || 'System')}</dd>
            <dt>Action</dt><dd>${esc(log.action)}</dd>
            <dt>Entity</dt><dd>${esc(log.entity_type)}${log.entity_id ? ` #${esc(log.entity_id)}` : ''}</dd>
            <dt>IP address</dt><dd class="mono">${esc(log.ip_address || '\u2014')}</dd>
          </dl>
          <div class="divider"></div>
          <div class="section-title">Previous value</div>
          <pre class="help-block" style="max-height:200px;overflow:auto;white-space:pre-wrap">${esc(log.old_value ? JSON.stringify(log.old_value, null, 2) : '\u2014')}</pre>
          <div class="section-title">New value</div>
          <pre class="help-block" style="max-height:200px;overflow:auto;white-space:pre-wrap">${esc(log.new_value ? JSON.stringify(log.new_value, null, 2) : '\u2014')}</pre>`,
        footer: '<button class="btn" data-modal-close>Close</button>',
      });
    });
  });
}

function summary(log) {
  const value = log.new_value || log.old_value;
  if (!value) return '\u2014';
  try {
    const text = JSON.stringify(value);
    return text.length > 90 ? `${text.slice(0, 87)}\u2026` : text;
  } catch {
    return '\u2014';
  }
}

/* ================================================================== */
/* SETTINGS                                                            */
/* ================================================================== */
export async function renderSettings(ctx) {
  ctx.view.innerHTML = `<div class="empty">Loading settings\u2026</div>`;
  const [res, unitsRes] = await Promise.all([api.get('/api/settings'), api.get('/api/units')]);
  const s = res.settings;
  const units = unitsRes.units;

  ctx.view.innerHTML = `
    <div class="page-head">
      <div><h1>System Settings</h1><div class="sub">Organisation details, reporting options and master data</div></div>
      <div class="page-actions">
        <button class="btn btn-primary" data-save>${icon('check')} Save settings</button>
      </div>
    </div>

    <div id="settings-alert" class="alert alert-danger hidden"></div>

    <form id="settings-form">
      <div class="grid grid-2" style="align-items:start">
        <div class="stack">
          <div class="card">
            <div class="card-head"><div><h3>Organisation</h3><div class="sub">Shown on approval reports and in the app shell</div></div></div>
            <div class="form-section">
              <div class="form-grid">
                ${field({ label: 'Organisation Name', name: 'org.name', value: s['org.name'] || '', required: true, span: true })}
                ${field({ label: 'Department', name: 'org.department', value: s['org.department'] || '' })}
                ${field({ label: 'Currency Symbol', name: 'currency', value: s.currency || '\u20B9' })}
                ${field({ label: 'Address', name: 'org.address', type: 'textarea', value: s['org.address'] || '', span: true })}
                ${field({ label: 'Phone', name: 'org.phone', value: s['org.phone'] || '' })}
                ${field({ label: 'Email', name: 'org.email', type: 'email', value: s['org.email'] || '' })}
                ${field({ label: 'Website', name: 'org.website', value: s['org.website'] || '' })}
                ${field({ label: 'GST No', name: 'org.gstin', value: s['org.gstin'] || '' })}
                ${field({ label: 'PAN No', name: 'org.pan', value: s['org.pan'] || '' })}
                ${field({ label: 'GST State', name: 'org.gst_state', value: s['org.gst_state'] || '' })}
              </div>
            </div>
          </div>

          <div class="card">
            <div class="card-head"><div><h3>Tax Defaults</h3><div class="sub">Default GST rates applied to new bills</div></div></div>
            <div class="form-section">
              <div class="form-grid">
                ${field({
                  label: 'Default GST Rate (%)',
                  name: 'tax.default_gst_rate',
                  type: 'number',
                  value: s['tax.default_gst_rate'] || '18',
                  attrs: 'step="0.01" min="0" max="100" list="settings-gst-slabs" placeholder="18"',
                  hint: 'Pre-filled on new bills. Staff can change it per bill, including to 5%, 12%, 18% or 28%.',
                })}
                ${field({
                  label: 'Default Transport GST Rate (%)',
                  name: 'tax.default_transport_gst_rate',
                  type: 'number',
                  value: s['tax.default_transport_gst_rate'] || '18',
                  attrs: 'step="0.01" min="0" max="100" list="settings-gst-slabs" placeholder="18"',
                  hint: 'Used when transport is marked as GST on a new bill.',
                })}
              </div>
              <datalist id="settings-gst-slabs">
                <option value="0">0% — Exempt</option>
                <option value="5">5%</option>
                <option value="12">12%</option>
                <option value="18">18%</option>
                <option value="28">28%</option>
              </datalist>
            </div>
          </div>

          <div class="card">
            <div class="card-head"><div><h3>Reports &amp; Verification</h3><div class="sub">Print footer and public QR base URL</div></div></div>
            <div class="form-section">
              <div class="form-grid">
                ${field({
                  label: 'Public Base URL',
                  name: 'public_base_url',
                  value: s['public_base_url'] || '',
                  span: true,
                  placeholder: 'https://abmdas.church.local',
                  hint: 'Used to build verification links inside QR codes. Leave blank to use the current host.',
                })}
                ${field({ label: 'Report Footer', name: 'report.footer', type: 'textarea', value: s['report.footer'] || '', span: true })}
                ${field({
                  label: 'Email Notifications',
                  name: 'notify.email',
                  type: 'select',
                  value: s['notify.email'] || '0',
                  options: [{ value: '0', label: 'Disabled' }, { value: '1', label: 'Enabled' }],
                  hint: 'In-app notifications are always enabled. Email delivery requires SMTP configuration.',
                })}
                ${field({
                  label: 'Google Maps Browser API Key',
                  name: 'maps.google_api_key',
                  value: s['maps.google_api_key'] || '',
                  span: true,
                  placeholder: 'AIza…',
                  hint: 'Enables the interactive pickup/drop map in Fleet Desk. Enable Maps JavaScript API and restrict this browser key to abmdas.vercel.app and your local host. It is visible to signed-in browsers by design.',
                })}
              </div>
            </div>
          </div>
        </div>

        <div class="stack">
          <div class="card">
            <div class="card-head"><div><h3>Departments</h3><div class="sub">Codes are used in purchase order numbers</div></div></div>
            <div class="card-body">
              <div class="row" style="gap:6px;flex-wrap:wrap">
                ${state.departments.map((d) => `<span class="kv-pill" style="display:inline-flex;align-items:center;gap:4px"><span class="mono">${esc(d.code || '—')}</span> ${esc(d.name)} <button type="button" class="btn btn-sm btn-ghost" data-edit-department="${d.id}" title="Edit department" style="padding:0 4px;font-size:11px">${icon('edit')}</button><button type="button" class="btn btn-sm btn-ghost" data-del-department="${d.id}" title="Delete department" style="padding:0 4px;font-size:11px">${icon('x')}</button></span>`).join('') || '<span class="small muted">No departments yet.</span>'}
              </div>
              <div class="inline-form mt-12">
                <input class="input" name="newDepartmentCode" placeholder="Code" style="max-width:120px;text-transform:uppercase" />
                <input class="input" name="newDepartment" placeholder="New department name" />
                <button type="button" class="btn btn-sm" data-add-department>${icon('plus')} Add</button>
              </div>
            </div>
          </div>

          <div class="card">
            <div class="card-head"><div><h3>Units</h3><div class="sub">Each unit raises and approves its own invoices. Vendors and departments are shared by all units.</div></div></div>
            <div class="card-body">
              <table class="tbl" style="font-size:12.5px">
                <thead><tr><th>Code</th><th>Unit</th><th class="num">Users</th><th class="num">Bills</th><th>Status</th><th></th></tr></thead>
                <tbody>
                  ${units.map((u) => `<tr>
                    <td class="mono">${esc(u.code)}</td>
                    <td>${esc(u.name)}</td>
                    <td class="num">${num(u.userCount || 0)}</td>
                    <td class="num">${num(u.billCount || 0)}</td>
                    <td>${statusBadge(u.active ? 'active' : 'inactive', u.active ? 'Active' : 'Inactive')}</td>
                    <td class="actions">${can('settings.manage') ? `<button type="button" class="btn btn-sm btn-ghost" data-unit-edit="${u.id}" title="Edit unit">${icon('edit')}</button>
                      <button type="button" class="btn btn-sm btn-ghost" data-unit-toggle="${u.id}" data-active="${u.active ? 1 : 0}">${u.active ? 'Deactivate' : 'Activate'}</button>` : ''}</td>
                  </tr>`).join('') || '<tr><td colspan="6" class="small muted">No units yet.</td></tr>'}
                </tbody>
              </table>
              <div class="form-grid mt-12">
                ${field({ label: 'Unit name', name: 'newUnitName', placeholder: 'e.g. Chennai Unit' })}
                ${field({ label: 'Code', name: 'newUnitCode', placeholder: 'e.g. CHN' })}
                ${field({ label: 'Address line 1', name: 'newUnitAddressLine1', placeholder: 'Street / building' })}
                ${field({ label: 'Address line 2', name: 'newUnitAddressLine2', placeholder: 'Area / landmark' })}
                ${field({ label: 'City', name: 'newUnitCity' })}
                ${field({ label: 'State', name: 'newUnitState' })}
                ${field({ label: 'Pincode', name: 'newUnitPincode' })}
                ${field({ label: 'Phone', name: 'newUnitPhone' })}
                ${field({ label: 'Email', name: 'newUnitEmail', type: 'email' })}
                <div class="field span-2" style="margin-bottom:0">
                  <button type="button" class="btn btn-sm" data-add-unit>${icon('plus')} Add unit</button>
                </div>
              </div>
            </div>
          </div>

          <div class="card">
            <div class="card-head"><div><h3>Expense Categories</h3><div class="sub">Classification for reporting and budgets</div></div></div>
            <div class="card-body" data-cat-body>
              <div class="stack" style="gap:10px">
                ${state.categories.filter((c) => !c.parent_id).map((main) => {
                  const subs = state.categories.filter((c) => c.parent_id === main.id);
                  return `<div class="card" style="padding:10px 12px">
                    <div class="row" style="justify-content:space-between;align-items:center">
                      <b>${esc(main.name)}</b>
                      <div class="actions">
                        <label class="check small" title="Route bills in this category to the Administrative Pastor regardless of amount">
                          <input type="checkbox" data-cat-pastor="${main.id}" ${main.requires_admin_pastor ? 'checked' : ''} /> Admin Pastor
                        </label>
                        <button type="button" class="btn btn-sm btn-danger" data-del-category="${main.id}" title="Delete main category">Delete</button>
                      </div>
                    </div>
                    <div class="stack" style="margin-top:6px;margin-left:14px;gap:4px">
                      ${subs.length
                        ? subs.map((sub) => `<div class="row" style="justify-content:space-between;align-items:center">
                            <span class="small">${esc(sub.name)}</span>
                            <div class="actions">
                              <label class="check small" title="Route bills in this category to the Administrative Pastor regardless of amount">
                                <input type="checkbox" data-cat-pastor="${sub.id}" ${sub.requires_admin_pastor ? 'checked' : ''} /> Admin Pastor
                              </label>
                              <button type="button" class="btn btn-sm btn-ghost" data-del-category="${sub.id}" title="Delete sub-category">Delete</button>
                            </div>
                          </div>`).join('')
                        : '<span class="small muted">No sub-categories yet.</span>'}
                    </div>
                    <div class="inline-form mt-8">
                      <input class="input" data-sub-name="${main.id}" placeholder="New sub-category under ${esc(main.name)}" />
                      <label class="check small" style="white-space:nowrap"><input type="checkbox" data-sub-pastor="${main.id}" /> Admin Pastor</label>
                      <button type="button" class="btn btn-sm" data-add-sub="${main.id}">${icon('plus')} Add sub</button>
                    </div>
                  </div>`;
                }).join('') || '<span class="small muted">No categories yet. Add a main category below.</span>'}
              </div>
              <div class="inline-form mt-12">
                <input class="input" name="newCategory" placeholder="New main category name" />
                <label class="check small" style="white-space:nowrap"><input type="checkbox" name="newCategoryPastor" /> Admin Pastor</label>
                <button type="button" class="btn btn-sm" data-add-category>${icon('plus')} Add main</button>
              </div>
            </div>
          </div>

          <div class="card">
            <div class="card-head"><div><h3>System</h3><div class="sub">Deployment and data safety</div></div></div>
            <div class="card-body">
              <dl class="dl compact">
                <dt>Application</dt><dd>ABMDAS v1.0</dd>
                <dt>Database</dt><dd class="mono">data/abmdas.db</dd>
                <dt>Uploads</dt><dd class="mono">data/uploads/</dd>
                <dt>Session life</dt><dd>12 hours</dd>
              </dl>
              <div class="help-block mt-12">
                Back up the entire <b>data</b> folder regularly. It contains the database and all uploaded documents.
                Stop the server before taking a file-level backup of the database.
              </div>
            </div>
          </div>
        </div>
      </div>

      <div class="card mt-16">
        <div class="card-head"><div><h3>General Terms</h3><div class="sub">Default terms pre-filled on RFQs, quotations and purchase orders</div></div></div>
        <div class="form-section">
          <div class="form-grid">
            ${field({
              label: 'General Terms',
              name: 'procurement.general_terms',
              type: 'textarea',
              value: s['procurement.general_terms'] || state.generalTerms || '',
              span: true,
              attrs: 'rows="10"',
              hint: 'One clause per line. Applies to new procurement documents; existing documents keep their own terms.',
            })}
          </div>
        </div>
      </div>
    </form>`;

  const form = document.getElementById('settings-form');
  const alertBox = document.getElementById('settings-alert');

  form.querySelector('[data-save]')?.addEventListener('click', () => form.requestSubmit?.());
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    alertBox.classList.add('hidden');
    const body = {
      'org.name': form['org.name'].value.trim(),
      'org.department': form['org.department'].value.trim(),
      'org.address': form['org.address'].value.trim(),
      'org.phone': form['org.phone'].value.trim(),
      'org.email': form['org.email'].value.trim(),
      'org.website': form['org.website'].value.trim(),
      'org.gstin': form['org.gstin'].value.trim(),
      'org.pan': form['org.pan'].value.trim(),
      'org.gst_state': form['org.gst_state'].value.trim(),
      currency: form.currency.value.trim() || '\u20B9',
      public_base_url: form.public_base_url.value.trim(),
      'report.footer': form['report.footer'].value.trim(),
      'procurement.general_terms': form['procurement.general_terms'].value.trim(),
      'notify.email': form['notify.email'].value,
      'tax.default_gst_rate': form['tax.default_gst_rate'].value,
      'tax.default_transport_gst_rate': form['tax.default_transport_gst_rate'].value,
    };
    if (!body['org.name']) {
      alertBox.textContent = 'Organisation name is required.';
      alertBox.classList.remove('hidden');
      return;
    }
    const rateChecks = [
      ['tax.default_gst_rate', 'Default GST rate'],
      ['tax.default_transport_gst_rate', 'Default transport GST rate'],
    ];
    for (const [key, label] of rateChecks) {
      const rate = Number(body[key]);
      if (!Number.isFinite(rate) || rate < 0 || rate > 100) {
        alertBox.textContent = `${label} must be between 0 and 100.`;
        alertBox.classList.remove('hidden');
        return;
      }
      body[key] = String(rate);
    }
    try {
      await api.put('/api/settings', body);
      await refreshMeta();
      toast('Settings saved.');
      reloadPage();
    } catch (err) {
      alertBox.textContent = err.message;
      alertBox.classList.remove('hidden');
    }
  });

  ctx.view.querySelector('[data-save]').addEventListener('click', () => form.requestSubmit());
  // Delete category handlers (event delegation)
  const catContainer = ctx.view.querySelector('[data-cat-body]');
  if (catContainer) {
    catContainer.addEventListener('change', async (e) => {
      const box = e.target.closest('[data-cat-pastor]');
      if (!box) return;
      try {
        await api.put(`/api/meta/categories/${box.dataset.catPastor}`, { requiresAdminPastor: box.checked });
        await refreshMeta();
        toast(box.checked ? 'Administrative Pastor approval enabled for this category.' : 'Administrative Pastor approval disabled for this category.');
      } catch (err) {
        box.checked = !box.checked;
        toast(err.message, 'error');
      }
    });
    catContainer.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-del-category]');
      if (!btn) return;
      if (!confirm('Delete this category? Sub-categories will be removed too.')) return;
      try {
        const res = await api.del('/api/meta/categories/' + btn.dataset.delCategory);
        toast(res.message || 'Category removed.');
        await refreshMeta();
        reloadPage();
      } catch (e) {
        toast(e.message, 'error');
      }
    });
  }

  // Add sub-category handlers
  ctx.view.querySelectorAll('[data-add-sub]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const parentId = btn.dataset.addSub;
      const input = ctx.view.querySelector(`[data-sub-name="${parentId}"]`);
      const pastorBox = ctx.view.querySelector(`[data-sub-pastor="${parentId}"]`);
      if (!input || !input.value.trim()) {
        toast('Sub-category name is required.', 'error');
        return;
      }
      try {
        await api.post('/api/meta/categories', {
          name: input.value.trim(),
          parentId: Number(parentId),
          requiresAdminPastor: !!(pastorBox && pastorBox.checked),
        });
        await refreshMeta();
        toast('Sub-category added.');
        reloadPage();
      } catch (e) {
        toast(e.message, 'error');
      }
    });
  });

  ctx.view.querySelector('[data-add-department]').addEventListener('click', async () => {
    const input = form.newDepartment;
    const codeInput = form.newDepartmentCode;
    if (!input.value.trim()) return;
    try {
      await api.post('/api/meta/departments', {
        name: input.value.trim(),
        code: codeInput.value.trim() || undefined,
      });
      await refreshMeta();
      toast('Department added.');
      reloadPage();
    } catch (e) {
      toast(e.message, 'error');
    }
  });

  const openDepartmentDialog = (dept) => {
    if (!dept) return;
    modal({
      title: 'Edit department',
      subtitle: dept.name,
      body: `<form id="department-edit-form">
        <div class="form-grid">
          ${field({ label: 'Department name', name: 'name', value: dept.name || '', required: true, span: true })}
          ${field({ label: 'Code', name: 'code', value: dept.code || '', required: true, hint: 'Letters, numbers, hyphen and underscore (max 20). Used in PO numbers.' })}
          ${field({ label: 'Status', name: 'active', type: 'select', value: dept.active ? '1' : '0', options: [{ value: '1', label: 'Active' }, { value: '0', label: 'Inactive' }] })}
        </div>
        <div class="alert alert-danger hidden mt-12" data-err></div>
      </form>`,
      footer: `<button class="btn" data-modal-close>Cancel</button>
               <button class="btn btn-primary" data-save>${icon('check')} Save changes</button>`,
      onMount(el, close) {
        const formEl = el.querySelector('#department-edit-form');
        el.querySelector('[data-save]').addEventListener('click', async () => {
          const body = {
            name: formEl.name.value.trim(),
            code: formEl.code.value.trim(),
            active: formEl.active.value === '1',
          };
          if (!body.name || !body.code) {
            errorBox(el, 'Department name and code are required.');
            return;
          }
          const btn = el.querySelector('[data-save]');
          btn.disabled = true;
          try {
            await api.put(`/api/meta/departments/${dept.id}`, body);
            await refreshMeta();
            close();
            toast('Department updated.');
            reloadPage();
          } catch (e) {
            btn.disabled = false;
            errorBox(el, e.message);
          }
        });
      },
    });
  };

  ctx.view.querySelectorAll('[data-edit-department]').forEach((btn) => {
    btn.addEventListener('click', () => openDepartmentDialog(
      state.departments.find((d) => String(d.id) === btn.dataset.editDepartment)
    ));
  });
  // Delete department handlers (event delegation)
  const deptContainer = ctx.view.querySelector('.card-body .row');
  if (deptContainer) {
    deptContainer.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-del-department]');
      if (!btn) return;
      if (!confirm('Delete this department?')) return;
      try {
        const res = await api.del('/api/meta/departments/' + btn.dataset.delDepartment);
        toast(res.message || 'Department removed.');
        await refreshMeta();
        reloadPage();
      } catch (e) {
        toast(e.message, 'error');
      }
    });
  }
  ctx.view.querySelector('[data-add-unit]').addEventListener('click', async () => {
    const name = form.newUnitName.value.trim();
    const code = form.newUnitCode.value.trim();
    if (!name || !code) {
      toast('Unit name and code are required.', 'error');
      return;
    }
    try {
      await api.post('/api/units', {
        name,
        code,
        addressLine1: form.newUnitAddressLine1.value.trim(),
        addressLine2: form.newUnitAddressLine2.value.trim(),
        city: form.newUnitCity.value.trim(),
        state: form.newUnitState.value.trim(),
        pincode: form.newUnitPincode.value.trim(),
        phone: form.newUnitPhone.value.trim(),
        email: form.newUnitEmail.value.trim(),
      });
      await refreshMeta();
      toast('Unit added.');
      reloadPage();
    } catch (e) {
      toast(e.message, 'error');
    }
  });
  ctx.view.querySelectorAll('[data-unit-toggle]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const active = btn.dataset.active === '1';
      try {
        await api.put(`/api/units/${btn.dataset.unitToggle}`, { active: !active });
        await refreshMeta();
        toast(active ? 'Unit deactivated.' : 'Unit activated.');
        reloadPage();
      } catch (e) {
        toast(e.message, 'error');
      }
    });
  });

  const openUnitDialog = (unit) => {
    if (!unit) return;
    const read = (camel, snake) => {
      const v = unit[camel] !== undefined && unit[camel] !== null ? unit[camel] : unit[snake];
      return v === undefined || v === null ? '' : String(v);
    };
    modal({
      title: 'Edit unit',
      subtitle: `${unit.code} \u00b7 ${unit.name}`,
      size: 'wide',
      body: `<form id="unit-edit-form">
        <div class="form-grid">
          ${field({ label: 'Unit Name', name: 'name', value: unit.name || '', required: true })}
          ${field({ label: 'Code', name: 'code', value: unit.code || '', required: true, hint: 'Letters, numbers, hyphen and underscore (max 20).' })}
          ${field({ label: 'Address line 1', name: 'addressLine1', value: read('addressLine1', 'address_line1'), span: true })}
          ${field({ label: 'Address line 2', name: 'addressLine2', value: read('addressLine2', 'address_line2'), span: true })}
          ${field({ label: 'City', name: 'city', value: read('city', 'city') })}
          ${field({ label: 'State', name: 'state', value: read('state', 'state') })}
          ${field({ label: 'Pincode', name: 'pincode', value: read('pincode', 'pincode') })}
          ${field({ label: 'Phone', name: 'phone', value: read('phone', 'phone') })}
          ${field({ label: 'Email', name: 'email', type: 'email', value: read('email', 'email') })}
          ${field({ label: 'Status', name: 'active', type: 'select', value: unit.active ? '1' : '0', options: [{ value: '1', label: 'Active' }, { value: '0', label: 'Inactive' }] })}
        </div>
        <div class="alert alert-danger hidden mt-12" data-err></div>
      </form>`,
      footer: `<button class="btn" data-modal-close>Cancel</button>
               <button class="btn btn-primary" data-save>${icon('check')} Save changes</button>`,
      onMount(el, close) {
        const form = el.querySelector('#unit-edit-form');
        el.querySelector('[data-save]').addEventListener('click', async () => {
          const body = {
            name: form.name.value.trim(),
            code: form.code.value.trim(),
            active: form.active.value === '1',
            addressLine1: form.addressLine1.value.trim(),
            addressLine2: form.addressLine2.value.trim(),
            city: form.city.value.trim(),
            state: form.state.value.trim(),
            pincode: form.pincode.value.trim(),
            phone: form.phone.value.trim(),
            email: form.email.value.trim(),
          };
          if (!body.name || !body.code) {
            errorBox(el, 'Unit name and code are required.');
            return;
          }
          const btn = el.querySelector('[data-save]');
          btn.disabled = true;
          try {
            await api.put(`/api/units/${unit.id}`, body);
            await refreshMeta();
            close();
            toast('Unit updated.');
            reloadPage();
          } catch (e) {
            btn.disabled = false;
            errorBox(el, e.message);
          }
        });
      },
    });
  };

  ctx.view.querySelectorAll('[data-unit-edit]').forEach((btn) => {
    btn.addEventListener('click', () => openUnitDialog(units.find((u) => String(u.id) === btn.dataset.unitEdit)));
  });

  ctx.view.querySelector('[data-add-category]').addEventListener('click', async () => {
    const input = form.newCategory;
    if (!input.value.trim()) return;
    try {
      await api.post('/api/meta/categories', {
        name: input.value.trim(),
        requiresAdminPastor: !!(form.newCategoryPastor && form.newCategoryPastor.checked),
      });
      await refreshMeta();
      toast('Category added.');
      reloadPage();
    } catch (e) {
      toast(e.message, 'error');
    }
  });
}

/* ================================================================== */
/* PROFILE                                                             */
/* ================================================================== */
export async function renderProfile(ctx) {
  const user = state.user;
  const signature = signatureSrc(user.signatureImage);
  const perms = user.permissions || [];

  ctx.view.innerHTML = `
    <div class="page-head">
      <div><h1>My Profile</h1><div class="sub">Personal details, digital signature and access rights</div></div>
      <div class="page-actions">
        <button class="btn btn-primary" data-save>${icon('check')} Save profile</button>
      </div>
    </div>

    <div id="profile-alert" class="alert alert-danger hidden"></div>

    <div class="split">
      <div class="stack">
        <div class="card">
          <div class="card-head">
            <div class="avatar avatar-lg">${esc(initials(user.name))}</div>
            <div><h3>${esc(user.name)}</h3><div class="sub">${esc(user.designation || user.roleName)} \u00b7 ${esc(user.employeeId)}</div></div>
            <div class="actions">${statusBadge('active', user.status || 'Active')}</div>
          </div>
          <div class="card-body">
            <form id="profile-form">
              <div class="form-grid">
                ${field({ label: 'Full Name', name: 'name', value: user.name, required: true, span: true })}
                ${field({ label: 'Mobile Number', name: 'mobile', value: user.mobile || '' })}
                ${field({ label: 'Email Address', name: 'email', type: 'email', value: user.email || '' })}
              </div>
              <dl class="dl compact mt-16">
                <dt>Username</dt><dd class="mono">${esc(user.username)}</dd>
                <dt>Employee ID</dt><dd class="mono">${esc(user.employeeId)}</dd>
                <dt>Role</dt><dd>${esc(user.roleName)}</dd>
                <dt>Department</dt><dd>${esc(user.department || '\u2014')}</dd>
                <dt>Last sign-in</dt><dd>${user.lastLoginAt ? fmtDate(user.lastLoginAt, true) : '\u2014'}</dd>
              </dl>
            </form>
          </div>
        </div>

        <div class="card">
          <div class="card-head"><div><h3>Digital Signature</h3><div class="sub">Applied automatically when you approve a bill</div></div></div>
          <div class="card-body">
            <div data-sig-preview class="mb-16">
              ${signature ? `<img src="${signature}" alt="Saved signature" style="max-height:90px;background:#fff;border:1px solid var(--border);border-radius:8px;padding:6px" />` : '<div class="small muted">No signature uploaded yet.</div>'}
            </div>
            <div class="field">
              <label>Upload signature image</label>
              <input class="input" type="file" data-signature accept="image/png,image/jpeg" />
              <div class="hint">PNG or JPG, up to 5 MB. Use a clear image on a white background.</div>
            </div>
            ${signature ? `<button class="btn btn-sm" data-remove-sig>${icon('trash')} Remove signature</button>` : ''}
          </div>
        </div>
      </div>

      <div class="stack">
        <div class="card">
          <div class="card-head"><div><h3>Access Rights</h3><div class="sub">${perms.includes('*') ? 'Full system access' : `${perms.length} permissions granted`}</div></div></div>
          <div class="card-body">
            ${perms.includes('*')
              ? `<div class="alert alert-info" style="margin:0">${icon('shield')}<div>You are a Super Administrator with full access to all modules.</div></div>`
              : `<div class="row">${perms.map((p) => `<span class="tag">${esc(p)}</span>`).join('') || '<span class="small muted">No permissions granted.</span>'}</div>`}
          </div>
        </div>

        <div class="card">
          <div class="card-head"><div><h3>Security</h3></div></div>
          <div class="card-body">
            <p class="small muted">Change your password regularly. You will be signed out of all sessions after a password change.</p>
            <button class="btn btn-block" data-change-pass>${icon('lock')} Change password</button>
          </div>
        </div>
      </div>
    </div>`;

  const form = document.getElementById('profile-form');
  const alertBox = document.getElementById('profile-alert');
  let signatureData = user.signatureImage || null;
  let signatureTouched = false;

  ctx.view.querySelector('[data-signature]').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      toast('Signature image must be under 5 MB.', 'error');
      e.target.value = '';
      return;
    }
    const fileData = await readFileAsBase64(file);
    signatureData = `data:${fileData.mime};base64,${fileData.data}`;
    signatureTouched = true;
    ctx.view.querySelector('[data-sig-preview]').innerHTML = `<img src="${signatureData}" alt="Signature preview" style="max-height:90px;background:#fff;border:1px solid var(--border);border-radius:8px;padding:6px" />`;
  });

  ctx.view.querySelector('[data-remove-sig]')?.addEventListener('click', () => {
    signatureData = null;
    signatureTouched = true;
    ctx.view.querySelector('[data-sig-preview]').innerHTML = '<div class="small muted">No signature uploaded yet.</div>';
    toast('Signature will be removed when you save.', 'info');
  });

  ctx.view.querySelector('[data-save]').addEventListener('click', async () => {
    alertBox.classList.add('hidden');
    const body = {
      name: form.name.value.trim(),
      mobile: form.mobile.value.trim(),
      email: form.email.value.trim(),
      signatureImage: signatureTouched ? signatureData : user.signatureImage || null,
    };
    if (!body.name) {
      alertBox.textContent = 'Name is required.';
      alertBox.classList.remove('hidden');
      return;
    }
    try {
      const res = await api.post('/api/auth/profile', body);
      state.user = res.user;
      const nameEl = document.querySelector('#user-btn .who b');
      if (nameEl) nameEl.textContent = res.user.name;
      const avatarEl = document.querySelector('#user-btn .avatar');
      if (avatarEl) avatarEl.textContent = initials(res.user.name);
      toast('Profile updated.');
      reloadPage();
    } catch (e) {
      alertBox.textContent = e.message;
      alertBox.classList.remove('hidden');
    }
  });

  ctx.view.querySelector('[data-change-pass]').addEventListener('click', openChangePasswordDialog);
}

function openChangePasswordDialog() {
  modal({
    title: 'Change password',
    subtitle: 'Choose a new password of at least 8 characters.',
    body: `<form id="pw-form">
      <div class="field"><label>Current password</label><input class="input" type="password" name="currentPassword" required /></div>
      <div class="field"><label>New password</label><input class="input" type="password" name="newPassword" minlength="8" required /></div>
      <div class="field"><label>Confirm new password</label><input class="input" type="password" name="confirm" minlength="8" required /></div>
      <div class="alert alert-danger hidden" data-err></div>
    </form>`,
    footer: `<button class="btn" data-modal-close>Cancel</button><button class="btn btn-primary" data-save>Update password</button>`,
    onMount(el, close) {
      const form = el.querySelector('#pw-form');
      el.querySelector('[data-save]').addEventListener('click', async () => {
        if (form.newPassword.value !== form.confirm.value) {
          errorBox(el, 'New passwords do not match.');
          return;
        }
        try {
          await api.post('/api/auth/change-password', {
            currentPassword: form.currentPassword.value,
            newPassword: form.newPassword.value,
          });
          close();
          toast('Password updated. Please sign in again.');
          stopSessionTimeout();
          broadcastLogout();
          window.location.reload();
        } catch (e) {
          errorBox(el, e.message);
        }
      });
    },
  });
}

void fileSize;
