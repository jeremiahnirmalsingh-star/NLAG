import { api } from '../api.js';
import { can, state } from '../state.js';
import { navigate } from '../router.js';
import {
  esc, icon, statusBadge, emptyState, toast, field, modal, confirmDialog,
} from '../ui.js';

const ACTIVE_OPTIONS = [
  { value: 'active', label: 'Active' },
  { value: 'inactive', label: 'Inactive' },
];

function defaultUnitId() {
  const ids = state.currentUnitIds.length ? state.currentUnitIds : state.memberUnitIds;
  return ids.length ? String(ids[0]) : '';
}

const LEVELS = {
  branches: {
    label: 'Branches',
    singular: 'branch',
    icon: 'branch',
    columns: [
      { label: 'Unit' },
      { label: 'Code', mono: true },
      { label: 'Name', strong: true },
      { label: 'Address' },
    ],
    fields(data) {
      return [
        { label: 'Unit', name: 'unitId', type: 'select', required: true, options: data.units.map((u) => ({ value: u.id, label: `${u.code} \u2014 ${u.name}` })) },
        { label: 'Branch Code', name: 'code', required: true, placeholder: 'e.g. HQ' },
        { label: 'Branch Name', name: 'name', required: true },
        { label: 'Address', name: 'address', type: 'textarea', span: true },
        { label: 'Status', name: 'status', type: 'select', options: ACTIVE_OPTIONS },
      ];
    },
    cells: (r) => [esc(r.unitName), `<span class="mono small">${esc(r.code)}</span>`, `<span class="strong">${esc(r.name)}</span>`, esc(r.address || '\u2014')],
    payload: (v) => ({ unitId: v.unitId, code: v.code, name: v.name, address: v.address, active: v.status === 'active' }),
  },
  campuses: {
    label: 'Campuses',
    singular: 'campus',
    icon: 'home',
    columns: [
      { label: 'Branch' },
      { label: 'Code', mono: true },
      { label: 'Name', strong: true },
      { label: 'Address' },
    ],
    fields(data) {
      return [
        { label: 'Branch', name: 'branchId', type: 'select', required: true, options: data.branches.map((b) => ({ value: b.id, label: `${b.code} \u2014 ${b.name}` })) },
        { label: 'Campus Code', name: 'code', required: true, placeholder: 'e.g. MAIN' },
        { label: 'Campus Name', name: 'name', required: true },
        { label: 'Address', name: 'address', type: 'textarea', span: true },
        { label: 'Status', name: 'status', type: 'select', options: ACTIVE_OPTIONS },
      ];
    },
    cells: (r) => [esc(r.branchName), `<span class="mono small">${esc(r.code)}</span>`, `<span class="strong">${esc(r.name)}</span>`, esc(r.address || '\u2014')],
    payload: (v) => ({ branchId: v.branchId, code: v.code, name: v.name, address: v.address, active: v.status === 'active' }),
  },
  buildings: {
    label: 'Buildings',
    singular: 'building',
    icon: 'home',
    columns: [
      { label: 'Campus' },
      { label: 'Branch' },
      { label: 'Code', mono: true },
      { label: 'Name', strong: true },
    ],
    fields(data) {
      return [
        { label: 'Campus', name: 'campusId', type: 'select', required: true, options: data.campuses.map((c) => ({ value: c.id, label: `${c.code} \u2014 ${c.name}` })) },
        { label: 'Building Code', name: 'code', required: true, placeholder: 'e.g. B1' },
        { label: 'Building Name', name: 'name', required: true },
        { label: 'Status', name: 'status', type: 'select', options: ACTIVE_OPTIONS },
      ];
    },
    cells: (r) => [esc(r.campusName), esc(r.branchName), `<span class="mono small">${esc(r.code)}</span>`, `<span class="strong">${esc(r.name)}</span>`],
    payload: (v) => ({ campusId: v.campusId, code: v.code, name: v.name, active: v.status === 'active' }),
  },
  floors: {
    label: 'Floors',
    singular: 'floor',
    icon: 'layers',
    columns: [
      { label: 'Building' },
      { label: 'Campus' },
      { label: 'Code', mono: true },
      { label: 'Name', strong: true },
    ],
    fields(data) {
      return [
        { label: 'Building', name: 'buildingId', type: 'select', required: true, options: data.buildings.map((b) => ({ value: b.id, label: `${b.code} \u2014 ${b.name}` })) },
        { label: 'Floor Code', name: 'code', required: true, placeholder: 'e.g. GF, 01' },
        { label: 'Floor Name', name: 'name', required: true },
        { label: 'Status', name: 'status', type: 'select', options: ACTIVE_OPTIONS },
      ];
    },
    cells: (r) => [esc(r.buildingName), esc(r.campusName), `<span class="mono small">${esc(r.code)}</span>`, `<span class="strong">${esc(r.name)}</span>`],
    payload: (v) => ({ buildingId: v.buildingId, code: v.code, name: v.name, active: v.status === 'active' }),
  },
  rooms: {
    label: 'Rooms',
    singular: 'room',
    icon: 'grid',
    columns: [
      { label: 'Floor' },
      { label: 'Building' },
      { label: 'Code', mono: true },
      { label: 'Name', strong: true },
      { label: 'Type' },
    ],
    fields(data) {
      return [
        { label: 'Floor', name: 'floorId', type: 'select', required: true, options: data.floors.map((f) => ({ value: f.id, label: `${f.code} \u2014 ${f.name}` })) },
        { label: 'Room Code', name: 'code', required: true, placeholder: 'e.g. R-101' },
        { label: 'Room Name', name: 'name', required: true },
        { label: 'Room Type', name: 'roomType', placeholder: 'Office, store, meeting room...' },
        { label: 'Status', name: 'status', type: 'select', options: ACTIVE_OPTIONS },
      ];
    },
    cells: (r) => [esc(r.floorName), esc(r.buildingName), `<span class="mono small">${esc(r.code)}</span>`, `<span class="strong">${esc(r.name)}</span>`, esc(r.roomType || '\u2014')],
    payload: (v) => ({ floorId: v.floorId, code: v.code, name: v.name, roomType: v.roomType, active: v.status === 'active' }),
  },
  'cost-centers': {
    label: 'Cost Centres',
    singular: 'cost centre',
    icon: 'wallet',
    columns: [
      { label: 'Unit' },
      { label: 'Code', mono: true },
      { label: 'Name', strong: true },
    ],
    fields(data) {
      return [
        { label: 'Unit', name: 'unitId', type: 'select', required: true, options: data.units.map((u) => ({ value: u.id, label: `${u.code} \u2014 ${u.name}` })) },
        { label: 'Cost Centre Code', name: 'code', required: true, placeholder: 'e.g. CC-ADMIN' },
        { label: 'Cost Centre Name', name: 'name', required: true },
        { label: 'Status', name: 'status', type: 'select', options: ACTIVE_OPTIONS },
      ];
    },
    cells: (r) => [esc(r.unitName), `<span class="mono small">${esc(r.code)}</span>`, `<span class="strong">${esc(r.name)}</span>`],
    payload: (v) => ({ unitId: v.unitId, code: v.code, name: v.name, active: v.status === 'active' }),
  },
};

const DATA_KEY = {
  branches: 'branches',
  campuses: 'campuses',
  buildings: 'buildings',
  floors: 'floors',
  rooms: 'rooms',
  'cost-centers': 'costCenters',
};

function valueFor(row, name) {
  if (name === 'status') return row.active ? 'active' : 'inactive';
  if (name === 'address') return row.address || '';
  if (name === 'roomType') return row.roomType || '';
  if (name === 'code') return row.code || '';
  if (name === 'name') return row.name || '';
  if (name === 'unitId') return row.unitId || '';
  if (name === 'branchId') return row.branchId || '';
  if (name === 'campusId') return row.campusId || '';
  if (name === 'buildingId') return row.buildingId || '';
  if (name === 'floorId') return row.floorId || '';
  return '';
}

function unitDefault(name) {
  if (name === 'unitId') return defaultUnitId();
  return '';
}

/* ================================================================== */
/* Page                                                                */
/* ================================================================== */
export async function render(ctx) {
  const q = ctx.route.query || {};
  const tab = LEVELS[q.tab] ? q.tab : 'branches';
  const level = LEVELS[tab];

  ctx.view.innerHTML = `<div class="empty">Loading organization\u2026</div>`;
  const data = await api.get('/api/procurement/org');
  const rows = data[DATA_KEY[tab]] || [];

  ctx.view.innerHTML = `
    <div class="page-head">
      <div><h1>Organization</h1><div class="sub">Branch, campus, building, floor, room and cost centre hierarchy</div></div>
      <div class="page-actions">
        ${can('org.manage') ? `<button class="btn btn-primary" type="button" data-new>${icon('plus')} New ${esc(level.singular)}</button>` : ''}
      </div>
    </div>

    <div class="card" style="padding:0">
      <div class="tabs">
        ${Object.entries(LEVELS).map(([key, cfg]) => `<button type="button" class="${key === tab ? 'active' : ''}" data-tab="${key}">${esc(cfg.label)}</button>`).join('')}
      </div>
      <div class="table-wrap">
        ${rows.length
          ? `<table class="tbl">
              <thead><tr>${level.columns.map((c) => `<th>${esc(c.label)}</th>`).join('')}<th>Status</th><th></th></tr></thead>
              <tbody>${rows.map((row) => `<tr>
                ${level.cells(row).map((cell) => `<td>${cell}</td>`).join('')}
                <td>${statusBadge(row.active ? 'active' : 'inactive')}</td>
                <td class="actions">
                  ${can('org.manage') ? `<button class="btn btn-sm btn-ghost" type="button" data-edit="${row.id}" title="Edit">${icon('edit')}</button>
                  <button class="btn btn-sm btn-ghost" type="button" data-retire="${row.id}" title="Retire">${icon('trash')}</button>` : ''}
                </td>
              </tr>`).join('')}</tbody></table>`
          : emptyState(
              `No ${level.label.toLowerCase()} yet`,
              `Add a ${level.singular} to build the organization hierarchy.`,
              can('org.manage') ? `<button class="btn btn-sm btn-primary" type="button" data-new>New ${esc(level.singular)}</button>` : '',
              level.icon
            )}
      </div>
      <div class="small muted" style="padding:10px 14px">${rows.length} ${esc(level.label.toLowerCase())} in the selected units.</div>
    </div>`;

  for (const btn of ctx.view.querySelectorAll('[data-tab]')) {
    btn.addEventListener('click', () => navigate(`/org?tab=${btn.dataset.tab}`));
  }

  const openForm = (row = null) => {
    const fields = level.fields(data);
    const body = `<form id="org-form" class="form-grid" autocomplete="off">
      ${fields.map((f) => field({
        ...f,
        value: row ? valueFor(row, f.name) : unitDefault(f.name),
      })).join('')}
    </form>`;
    const m = modal({
      title: `${row ? 'Edit' : 'New'} ${level.singular}`,
      subtitle: row ? `${row.code} \u00b7 ${row.name}` : `Add a ${level.singular} to the hierarchy`,
      body,
      footer: `<button class="btn" data-cancel>Cancel</button>
               <button class="btn btn-primary" data-save>${icon('check')} ${row ? 'Save changes' : 'Create'}</button>`,
      size: 'wide',
    });

    m.el.querySelector('[data-cancel]').addEventListener('click', m.close);
    m.el.querySelector('[data-modal-close]')?.addEventListener('click', m.close);
    m.el.querySelector('[data-save]').addEventListener('click', async () => {
      const form = m.el.querySelector('#org-form');
      const values = {};
      for (const f of fields) values[f.name] = form.elements[f.name].value.trim();
      for (const f of fields) {
        if (f.required && !values[f.name]) {
          toast(`${f.label} is required.`, 'error');
          form.elements[f.name].focus();
          return;
        }
      }
      try {
        if (row) {
          await api.put(`/api/procurement/org/${tab}/${row.id}`, level.payload(values));
          toast(`${level.singular[0].toUpperCase()}${level.singular.slice(1)} updated.`);
        } else {
          await api.post(`/api/procurement/org/${tab}`, level.payload(values));
          toast(`${level.singular[0].toUpperCase()}${level.singular.slice(1)} created.`);
        }
        m.close();
        navigate(`/org?tab=${tab}`);
      } catch (e) {
        toast(e.message || 'Unable to save the record.', 'error');
      }
    });
  };

  const openRetire = async (row) => {
    const ok = await confirmDialog({
      title: `Retire ${level.singular}`,
      message: `Retire ${row.code} \u00b7 ${row.name}? It will no longer be available for new records. Existing records are preserved.`,
      confirmText: 'Retire',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.del(`/api/procurement/org/${tab}/${row.id}`);
      toast(`${level.singular[0].toUpperCase()}${level.singular.slice(1)} retired.`);
      navigate(`/org?tab=${tab}`);
    } catch (e) {
      toast(e.message || 'Unable to retire the record.', 'error');
    }
  };

  for (const btn of ctx.view.querySelectorAll('[data-new]')) {
    btn.addEventListener('click', () => openForm());
  }
  for (const btn of ctx.view.querySelectorAll('[data-edit]')) {
    btn.addEventListener('click', () => openForm(rows.find((r) => String(r.id) === btn.dataset.edit)));
  }
  for (const btn of ctx.view.querySelectorAll('[data-retire]')) {
    btn.addEventListener('click', () => openRetire(rows.find((r) => String(r.id) === btn.dataset.retire)));
  }
}

export function renderList(ctx) {
  return render(ctx);
}
