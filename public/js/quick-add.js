/* Inline master creation for entry forms.
 *
 * A small "+" button is placed beside every master-data dropdown. Clicking it
 * opens a modal, saves through the existing master API, then selects the new
 * record in the form without losing anything already typed. */
import { api } from './api.js';
import { state, can } from './state.js';
import { esc, icon, field, modal, toast, serializeForm } from './ui.js';

const ITEM_TYPES = [
  { value: 'consumable', label: 'Consumable' },
  { value: 'asset', label: 'Asset (Non-Consumable)' },
  { value: 'service', label: 'Service' },
];
const STORE_TYPES = [
  { value: 'main', label: 'Main store' },
  { value: 'sub', label: 'Sub store' },
  { value: 'transit', label: 'Transit store' },
];

let metaPromise = null;
let observer = null;
const created = new Map();

function loadMeta() {
  if (!metaPromise) {
    const get = (url) => api.get(url, { silent: true }).catch(() => ({}));
    metaPromise = Promise.all([
      get('/api/procurement/meta'),
      get('/api/procurement/assets/meta'),
      get('/api/procurement/org'),
      get('/api/procurement/stock/meta'),
      get('/api/procurement/employees/meta'),
      get('/api/procurement/stores/meta'),
      get('/api/roles'),
    ]).then(([p, a, o, s, e, st, r]) => ({
      itemCategories: p.categories || [],
      uoms: p.uoms || [],
      itemTypes: p.itemTypes || ITEM_TYPES,
      expenseCategories: state.categories || [],
      units: state.units.length ? state.units : a.units || o.units || st.units || [],
      departments: state.departments.length ? state.departments : p.departments || a.departments || [],
      roles: r.roles || state.roles || [],
      vendors: p.vendors || [],
      items: a.items || s.items || [],
      stores: s.stores || a.stores || [],
      bins: s.bins || a.bins || [],
      rooms: a.rooms || o.rooms || [],
      floors: o.floors || [],
      buildings: o.buildings || [],
      campuses: o.campuses || [],
      branches: o.branches || [],
      costCenters: o.costCenters || [],
      employees: e.employees || [],
    }));
  }
  return metaPromise;
}

function optionList(items, valueKey = 'id', labelKey = 'name', extra = '') {
  return [{ value: '', label: `— Select ${labelKey.replace(/([A-Z])/g, ' $1').toLowerCase()} —` }]
    .concat((items || []).map((row) => ({
      value: row[valueKey],
      label: extra ? `${row[labelKey]} (${extra(row)})` : row[labelKey],
    })));
}

/* Every master the app lets a user pick on an entry form. */
const MASTERS = {
  vendor: {
    label: 'Vendor',
    perms: ['vendor.create', 'bill.create', 'po.manage', 'requisition.create', 'sourcing.manage', 'advance.create'],
    dedupe: ['[data-add-vendor]'],
    endpoint: '/api/vendors',
    fields: () => [
      { label: 'Vendor name', name: 'name', required: true, placeholder: 'Registered name' },
      { label: 'Category', name: 'category', placeholder: 'e.g. IT equipment' },
      { label: 'Contact person', name: 'contactPerson' },
      { label: 'Mobile', name: 'mobile' },
      { label: 'Email', name: 'email', type: 'email' },
      { label: 'GST number', name: 'gstNumber' },
      { label: 'PAN number', name: 'panNumber' },
      { label: 'City', name: 'city' },
      { label: 'State', name: 'state' },
    ],
    payload: (v) => ({ ...v, name: v.name.trim(), status: 'Active' }),
    record: (res, v) => ({ id: res.id, name: v.name.trim(), code: res.code || '' }),
    option: (r) => ({ value: r.id, label: r.code ? `${r.name} (${r.code})` : r.name }),
  },
  expenseCategory: {
    label: 'Expense Category',
    perms: ['settings.manage', 'bill.create', 'invoice.manage'],
    dedupe: ['[data-add-category]', '[data-add-sub]'],
    endpoint: '/api/meta/categories',
    fields: (meta) => [
      { label: 'Category name', name: 'name', required: true },
      { label: 'Code', name: 'code', placeholder: 'Optional short code' },
      { label: 'Parent category', name: 'parentId', type: 'select', options: optionList(meta.expenseCategories.filter((c) => !c.parent_id)) },
      { label: 'Admin Pastor approval', name: 'requiresAdminPastor', type: 'select', options: [{ value: '0', label: 'Not required' }, { value: '1', label: 'Required regardless of amount' }] },
    ],
    payload: (v) => ({
      name: v.name.trim(),
      code: v.code || null,
      parentId: v.parentId ? Number(v.parentId) : null,
      requiresAdminPastor: String(v.requiresAdminPastor) === '1',
    }),
    record: (res, v) => ({ id: res.id, name: v.name.trim() }),
    option: (r) => ({ value: r.id, label: r.name }),
  },
  itemCategory: {
    label: 'Item Category',
    perms: ['item.manage'],
    endpoint: '/api/procurement/item-categories',
    fields: (meta, ctx) => [
      { label: 'Category name', name: 'name', required: true },
      { label: 'Code', name: 'code', placeholder: 'Optional — generated when blank' },
      { label: 'Item type', name: 'itemType', type: 'select', value: ctx.itemType || 'consumable', options: ITEM_TYPES },
      { label: 'Parent category', name: 'parentId', type: 'select', options: [{ value: '', label: '— None (top level) —' }] },
    ],
    payload: (v) => ({
      name: v.name.trim(),
      code: v.code || null,
      itemType: v.itemType,
      parentId: v.parentId ? Number(v.parentId) : null,
    }),
    record: (res, v) => ({ id: res.id, name: v.name.trim(), code: res.code || '', itemType: v.itemType }),
    option: (r) => ({ value: r.id, label: r.code ? `${r.name} (${r.code})` : r.name }),
  },
  uom: {
    label: 'Unit of Measure',
    perms: ['item.manage'],
    endpoint: '/api/procurement/uoms',
    fields: () => [
      { label: 'Code', name: 'code', required: true, placeholder: 'e.g. NOS, KG' },
      { label: 'Name', name: 'name', required: true, placeholder: 'e.g. Number, Kilogram' },
    ],
    payload: (v) => ({ code: v.code.trim(), name: v.name.trim() }),
    record: (res, v) => ({ id: res.id, code: res.code || v.code.trim().toUpperCase(), name: v.name.trim() }),
    option: (r) => ({ value: r.id, label: `${r.code} — ${r.name}` }),
  },
  item: {
    label: 'Item',
    perms: ['item.manage'],
    dedupe: ['[data-add-item]'],
    endpoint: '/api/procurement/items',
    fields: (meta, ctx) => [
      { label: 'Item name', name: 'name', required: true },
      { label: 'Item type', name: 'itemType', type: 'select', value: ctx.itemType || 'consumable', options: ITEM_TYPES },
      { label: 'Category', name: 'categoryId', type: 'select', required: true, options: optionList((meta.itemCategories || []).filter((c) => c.active && c.itemType === (ctx.itemType || 'consumable'))) },
      { label: 'UOM', name: 'uomId', type: 'select', required: true, options: optionList(meta.uoms, 'id', 'name', (u) => u.code) },
      { label: 'Specification', name: 'specification', type: 'textarea', span: true, attrs: 'rows="2"' },
      { label: 'Standard cost', name: 'standardCost', type: 'number', value: '0', attrs: 'min="0" step="0.01"' },
      { label: 'GST rate (%)', name: 'gstRate', type: 'number', value: '0', attrs: 'min="0" max="100" step="0.01"' },
      { label: 'Price includes tax (tax inclusive)', name: 'taxInclusive', type: 'checkbox', hint: 'Discounts are applied before tax; inclusive prices are back-calculated.' },
      { label: 'Default discount %', name: 'defaultDiscountPercent', type: 'number', value: '0', attrs: 'min="0" max="100" step="0.01"' },
      { label: 'Default flat discount amount', name: 'defaultDiscountAmount', type: 'number', value: '0', attrs: 'min="0" step="0.01"' },
    ],
    payload: (v) => ({
      name: v.name.trim(),
      itemType: v.itemType,
      categoryId: Number(v.categoryId),
      uomId: Number(v.uomId),
      specification: v.specification || '',
      standardCost: Number(v.standardCost) || 0,
      trackInventory: v.itemType === 'consumable',
      details: {
        gstRate: Number(v.gstRate) || 0,
        taxInclusive: !!v.taxInclusive,
        defaultDiscountPercent: Number(v.defaultDiscountPercent) || 0,
        defaultDiscountAmount: Number(v.defaultDiscountAmount) || 0,
      },
    }),
    record: (res, v, meta) => {
      const uom = (meta.uoms || []).find((u) => String(u.id) === String(v.uomId));
      return {
        id: res.id,
        name: v.name.trim(),
        code: res.itemCode || '',
        itemCode: res.itemCode || '',
        itemType: v.itemType,
        categoryId: Number(v.categoryId),
        uomId: Number(v.uomId),
        uomCode: uom ? uom.code : '',
        standardCost: Number(v.standardCost) || 0,
        gstRate: Number(v.gstRate) || 0,
        taxInclusive: !!v.taxInclusive,
        defaultDiscountPercent: Number(v.defaultDiscountPercent) || 0,
        defaultDiscountAmount: Number(v.defaultDiscountAmount) || 0,
      };
    },
    option: (r) => ({
      value: r.id,
      label: r.code ? `${r.name} (${r.code})${r.uomCode ? ` · ${r.uomCode}` : ''}` : r.name,
    }),
  },
  department: {
    label: 'Department',
    perms: ['settings.manage'],
    dedupe: ['[data-add-department]'],
    endpoint: '/api/meta/departments',
    fields: () => [{ label: 'Department name', name: 'name', required: true }],
    payload: (v) => ({ name: v.name.trim() }),
    record: (res, v) => ({ id: res.id, name: v.name.trim() }),
    option: (r) => ({ value: r.id, label: r.name }),
  },
  unit: {
    label: 'Unit',
    perms: ['settings.manage'],
    dedupe: ['[data-add-unit]'],
    endpoint: '/api/units',
    fields: () => [
      { label: 'Code', name: 'code', required: true, placeholder: 'e.g. MAIN' },
      { label: 'Name', name: 'name', required: true },
    ],
    payload: (v) => ({ code: v.code.trim(), name: v.name.trim() }),
    record: (res, v) => ({ id: res.id, name: v.name.trim(), code: v.code.trim().toUpperCase() }),
    option: (r) => ({ value: r.id, label: r.name }),
  },
  costCenter: {
    label: 'Cost Centre',
    perms: ['org.manage'],
    endpoint: '/api/procurement/org/cost-centers',
    fields: (meta, ctx) => [
      { label: 'Unit', name: 'unitId', type: 'select', required: true, value: ctx.unitId || '', options: optionList(meta.units) },
      { label: 'Code', name: 'code', required: true },
      { label: 'Name', name: 'name', required: true },
    ],
    payload: (v) => ({ unitId: Number(v.unitId), code: v.code.trim(), name: v.name.trim() }),
    record: (res, v) => ({ id: res.id, name: v.name.trim(), code: res.code || v.code.trim().toUpperCase() }),
    option: (r) => ({ value: r.id, label: r.code ? `${r.name} (${r.code})` : r.name }),
  },
  employee: {
    label: 'Employee',
    perms: ['employee.manage'],
    endpoint: '/api/procurement/employees',
    fields: (meta, ctx) => [
      { label: 'Name', name: 'name', required: true },
      { label: 'Unit', name: 'unitId', type: 'select', required: true, value: ctx.unitId || '', options: optionList(meta.units) },
      { label: 'Employee code', name: 'employeeCode', placeholder: 'Optional — generated when blank' },
      { label: 'Department', name: 'departmentId', type: 'select', options: optionList(meta.departments) },
      { label: 'Designation', name: 'designation' },
      { label: 'Mobile', name: 'mobile' },
      { label: 'Email', name: 'email', type: 'email' },
    ],
    payload: (v) => ({
      name: v.name.trim(),
      employeeCode: v.employeeCode || null,
      unitId: Number(v.unitId),
      departmentId: v.departmentId ? Number(v.departmentId) : null,
      designation: v.designation || '',
      mobile: v.mobile || '',
      email: v.email || '',
    }),
    record: (res, v) => ({ id: res.id, name: v.name.trim(), code: res.employeeCode || '' }),
    option: (r) => ({ value: r.id, label: r.code ? `${r.name} (${r.code})` : r.name }),
  },
  store: {
    label: 'Store',
    perms: ['store.manage'],
    endpoint: '/api/procurement/stores',
    fields: (meta, ctx) => [
      { label: 'Unit', name: 'unitId', type: 'select', required: true, value: ctx.unitId || '', options: optionList(meta.units) },
      { label: 'Code', name: 'code', required: true },
      { label: 'Name', name: 'name', required: true },
      { label: 'Store type', name: 'storeType', type: 'select', value: 'main', options: STORE_TYPES },
    ],
    payload: (v) => ({ unitId: Number(v.unitId), code: v.code.trim(), name: v.name.trim(), storeType: v.storeType }),
    record: (res, v) => ({ id: res.id, name: v.name.trim(), code: res.code || v.code.trim().toUpperCase() }),
    option: (r) => ({ value: r.id, label: r.code ? `${r.name} (${r.code})` : r.name }),
  },
  bin: {
    label: 'Bin',
    perms: ['store.manage'],
    dedupe: ['[data-add-bin]'],
    endpoint: (v) => `/api/procurement/stores/${v.storeId}/bins`,
    fields: (meta, ctx) => [
      { label: 'Store', name: 'storeId', type: 'select', required: true, value: ctx.storeId || '', options: optionList(meta.stores) },
      { label: 'Code', name: 'code', required: true },
      { label: 'Name', name: 'name', required: true },
    ],
    payload: (v) => ({ code: v.code.trim(), name: v.name.trim() }),
    record: (res, v) => ({ id: res.id, name: v.name.trim(), code: res.code || v.code.trim().toUpperCase() }),
    option: (r) => ({ value: r.id, label: r.code ? `${r.name} (${r.code})` : r.name }),
  },
  room: {
    label: 'Room',
    perms: ['org.manage'],
    endpoint: '/api/procurement/org/rooms',
    fields: (meta, ctx) => [
      { label: 'Floor', name: 'floorId', type: 'select', required: true, value: ctx.floorId || '', options: optionList(meta.floors) },
      { label: 'Code', name: 'code', required: true },
      { label: 'Name', name: 'name', required: true },
      { label: 'Room type', name: 'roomType' },
    ],
    payload: (v) => ({ floorId: Number(v.floorId), code: v.code.trim(), name: v.name.trim(), roomType: v.roomType || '' }),
    record: (res, v) => ({ id: res.id, name: v.name.trim(), code: res.code || v.code.trim().toUpperCase() }),
    option: (r) => ({ value: r.id, label: r.code ? `${r.name} (${r.code})` : r.name }),
  },
  branch: {
    label: 'Branch',
    perms: ['org.manage'],
    endpoint: '/api/procurement/org/branches',
    fields: (meta, ctx) => [
      { label: 'Unit', name: 'unitId', type: 'select', required: true, value: ctx.unitId || '', options: optionList(meta.units) },
      { label: 'Code', name: 'code', required: true },
      { label: 'Name', name: 'name', required: true },
      { label: 'Address', name: 'address' },
    ],
    payload: (v) => ({ unitId: Number(v.unitId), code: v.code.trim(), name: v.name.trim(), address: v.address || '' }),
    record: (res, v) => ({ id: res.id, name: v.name.trim(), code: res.code || v.code.trim().toUpperCase() }),
    option: (r) => ({ value: r.id, label: r.code ? `${r.name} (${r.code})` : r.name }),
  },
  campus: {
    label: 'Campus',
    perms: ['org.manage'],
    endpoint: '/api/procurement/org/campuses',
    fields: (meta, ctx) => [
      { label: 'Branch', name: 'branchId', type: 'select', required: true, value: ctx.branchId || '', options: optionList(meta.branches) },
      { label: 'Code', name: 'code', required: true },
      { label: 'Name', name: 'name', required: true },
      { label: 'Address', name: 'address' },
    ],
    payload: (v) => ({ branchId: Number(v.branchId), code: v.code.trim(), name: v.name.trim(), address: v.address || '' }),
    record: (res, v) => ({ id: res.id, name: v.name.trim(), code: res.code || v.code.trim().toUpperCase() }),
    option: (r) => ({ value: r.id, label: r.code ? `${r.name} (${r.code})` : r.name }),
  },
  building: {
    label: 'Building',
    perms: ['org.manage'],
    endpoint: '/api/procurement/org/buildings',
    fields: (meta, ctx) => [
      { label: 'Campus', name: 'campusId', type: 'select', required: true, value: ctx.campusId || '', options: optionList(meta.campuses) },
      { label: 'Code', name: 'code', required: true },
      { label: 'Name', name: 'name', required: true },
    ],
    payload: (v) => ({ campusId: Number(v.campusId), code: v.code.trim(), name: v.name.trim() }),
    record: (res, v) => ({ id: res.id, name: v.name.trim(), code: res.code || v.code.trim().toUpperCase() }),
    option: (r) => ({ value: r.id, label: r.code ? `${r.name} (${r.code})` : r.name }),
  },
  floor: {
    label: 'Floor',
    perms: ['org.manage'],
    endpoint: '/api/procurement/org/floors',
    fields: (meta, ctx) => [
      { label: 'Building', name: 'buildingId', type: 'select', required: true, value: ctx.buildingId || '', options: optionList(meta.buildings) },
      { label: 'Code', name: 'code', required: true },
      { label: 'Name', name: 'name', required: true },
    ],
    payload: (v) => ({ buildingId: Number(v.buildingId), code: v.code.trim(), name: v.name.trim() }),
    record: (res, v) => ({ id: res.id, name: v.name.trim(), code: res.code || v.code.trim().toUpperCase() }),
    option: (r) => ({ value: r.id, label: r.code ? `${r.name} (${r.code})` : r.name }),
  },
  role: {
    label: 'Role',
    perms: ['role.manage'],
    endpoint: '/api/roles',
    fields: () => [
      { label: 'Code', name: 'code', required: true, placeholder: 'lowercase_with_underscores' },
      { label: 'Name', name: 'name', required: true },
      { label: 'Description', name: 'description' },
    ],
    payload: (v) => ({ code: v.code.trim(), name: v.name.trim(), description: v.description || '' }),
    record: (res, v) => ({ id: res.id, name: v.name.trim(), code: v.code.trim() }),
    option: (r) => ({ value: r.id, label: r.name }),
  },
  user: {
    label: 'User',
    perms: ['user.manage'],
    endpoint: '/api/users',
    fields: (meta) => [
      { label: 'Employee ID', name: 'employeeId', required: true },
      { label: 'Name', name: 'name', required: true },
      { label: 'Username', name: 'username', required: true },
      { label: 'Password', name: 'password', type: 'password', required: true },
      { label: 'Role', name: 'roleId', type: 'select', required: true, options: optionList(meta.roles) },
      { label: 'Email', name: 'email', type: 'email' },
      { label: 'Mobile', name: 'mobile' },
    ],
    payload: (v) => ({
      employeeId: v.employeeId.trim(),
      name: v.name.trim(),
      username: v.username.trim(),
      password: v.password,
      roleId: Number(v.roleId),
      email: v.email || '',
      mobile: v.mobile || '',
      status: 'Active',
    }),
    record: (res, v) => ({ id: res.id, name: v.name.trim() }),
    option: (r) => ({ value: r.id, label: r.name }),
  },
};

function allowed(cfg) {
  return cfg.perms.some((p) => can(p));
}

function section() {
  return (location.hash.split('?')[0].split('/')[1] || '').toLowerCase();
}

function inferType(el) {
  if (el.dataset.qaSkip) return null;
  const explicit = el.dataset.master || el.dataset.quickAdd;
  if (explicit && MASTERS[explicit]) return explicit;

  /* Match whole field names, not loose substrings: "storeType" is an enum,
   * while "storeId" is a master dropdown. */
  const keyText = [el.name || '', el.id || '']
    .concat(Object.keys(el.dataset).filter((k) => !['qaDone', 'qaSkip', 'master', 'quickAdd'].includes(k)))
    .join(' ');
  const words = keyText
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[-_]/g, ' ')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .join(' ');

  if (/(^| )(status|type|mode|priority|slab|settlement|transport|method|class|flag)( |$)/.test(words)) return null;

  if (/\b(vendor|supplier)\b/.test(words)) return 'vendor';
  if (/\bsub category\b/.test(words)) return 'itemCategory';
  if (/\bcategory\b/.test(words)) {
    return ['items', 'assets', 'asset-classes'].includes(section()) ? 'itemCategory' : 'expenseCategory';
  }
  if (/\buom\b|\bmeasure\b/.test(words)) return 'uom';
  if (/\bcost centre\b|\bcost center\b/.test(words)) return 'costCenter';
  if (/\broom\b/.test(words)) return 'room';
  if (/\bfloor\b/.test(words)) return 'floor';
  if (/\bbuilding\b/.test(words)) return 'building';
  if (/\bcampus\b/.test(words)) return 'campus';
  if (/\bbranch\b/.test(words)) return 'branch';
  if (/\bbin\b/.test(words)) return 'bin';
  if (/\bstore\b/.test(words)) return 'store';
  if (/\bemployee\b|\bmanager\b|\bcustodian\b|\breporting\b/.test(words)) return 'employee';
  if (/\bunit\b/.test(words)) return 'unit';
  if (/\bdepartment\b/.test(words)) return 'department';
  if (/\brole\b/.test(words)) return 'role';
  if (/\buser\b/.test(words)) return 'user';
  if (/\bitem\b/.test(words)) return 'item';
  return null;
}

function contextFor(type, source) {
  const root = (source && (source.closest('form') || source.closest('.card') || source.closest('#view'))) || document;
  const value = (names) => {
    for (const n of names) {
      const el = root.querySelector(`[name="${n}"], [data-${n.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())}]`);
      if (el && el.value) return el.value;
    }
    return '';
  };
  const ctx = {
    unitId: value(['unitId']),
    storeId: value(['storeId']),
    floorId: value(['floorId']),
    buildingId: value(['buildingId']),
    campusId: value(['campusId']),
    branchId: value(['branchId']),
    itemType: value(['itemType']),
  };
  if (!ctx.unitId && state.currentUnitIds.length) ctx.unitId = state.currentUnitIds[0];
  if (type === 'item' && !ctx.itemType) ctx.itemType = section() === 'assets' ? 'asset' : 'consumable';
  return ctx;
}

function remember(type, record) {
  if (!created.has(type)) created.set(type, []);
  const list = created.get(type);
  if (list.some((r) => String(r.id) === String(record.id))) return;
  list.push(record);
}

function syncState(type, record) {
  if (type === 'department') state.departments.push({ id: record.id, name: record.name, active: 1 });
  if (type === 'unit') {
    state.units.push({ id: record.id, code: record.code, name: record.name, active: 1 });
    if (!state.memberUnitIds.includes(Number(record.id))) state.memberUnitIds.push(Number(record.id));
  }
  if (type === 'expenseCategory') {
    state.categories.push({ id: record.id, name: record.name, parent_id: null, active: 1, requires_admin_pastor: 0 });
  }
  if (type === 'role') state.roles.push({ id: record.id, name: record.name, code: record.code });
}

function appendOption(select, type, record) {
  const cfg = MASTERS[type];
  if (!cfg || !select) return;
  const option = cfg.option(record);
  if (option.value === '' || option.value === undefined) return;
  if (Array.from(select.options).some((o) => String(o.value) === String(option.value))) return;
  const el = document.createElement('option');
  el.value = option.value;
  el.textContent = option.label;
  select.appendChild(el);
}

function syncOptions(root = document) {
  if (!root || !root.querySelectorAll) return;
  const selects = root.matches && root.matches('select') ? [root] : Array.from(root.querySelectorAll('select'));
  for (const select of selects) {
    const type = inferType(select);
    if (!type || !MASTERS[type]) continue;
    for (const record of created.get(type) || []) appendOption(select, type, record);
  }
}

/**
 * Open the inline master dialog. Resolves with the created record, or null if
 * cancelled. `onCreated(record, values, meta)` is called after the save so a
 * page can update its own local arrays (for example PO line item metadata).
 */
export async function openQuickAdd(type, source, { onCreated, context = {}, title, submitLabel = 'Create &amp; select', successMessage } = {}) {
  const cfg = MASTERS[type];
  if (!cfg) return null;
  if (!allowed(cfg)) {
    toast(`You do not have permission to create a ${cfg.label.toLowerCase()}.`, 'error');
    return null;
  }
  const meta = await loadMeta();
  const ctx = { ...contextFor(type, source), ...context };

  return new Promise((resolve) => {
    let settled = false;
    let completed = false;
    const finish = (record) => {
      if (settled) return;
      settled = true;
      resolve(record || null);
    };
    const body = `<form data-qa-form class="form-grid">${cfg.fields(meta, ctx).map((f) => (f.type === 'checkbox'
      ? `<div class="field ${f.span ? 'span-2' : ''}">
           <label class="row" style="gap:8px;align-items:center;font-size:13px">
             <input type="checkbox" name="${esc(f.name)}" ${f.value ? 'checked' : ''} />
             <span>${esc(f.label)}</span>
           </label>
           ${f.hint ? `<div class="hint">${esc(f.hint)}</div>` : ''}
         </div>`
      : field(f))).join('')}</form>`;
    modal({
      size: 'xwide',
      title: title || `New ${cfg.label.toLowerCase()}`,
      subtitle: 'Fill in the full record, then save it to the master list.',
      body,
      footer: `<button class="btn" type="button" data-qa-cancel>Cancel</button>
               <button class="btn btn-primary" type="button" data-qa-submit>${icon('check')} ${submitLabel}</button>`,
      onClose: () => {
        if (!completed) finish(null);
      },
      onMount(overlay, closeModal) {
        overlay.querySelector('.modal').setAttribute('data-qa-modal', '');
        const form = overlay.querySelector('[data-qa-form]');
        const submitBtn = overlay.querySelector('[data-qa-submit]');

        const refreshSelects = () => {
          if (type !== 'item' && type !== 'itemCategory') return;
          const itemType = form.querySelector('[name=itemType]')?.value || ctx.itemType || 'consumable';
          const target = form.querySelector(type === 'item' ? '[name=categoryId]' : '[name=parentId]');
          if (!target) return;
          const pool = (meta.itemCategories || []).filter((c) => c.active && c.itemType === itemType);
          const placeholder = type === 'item'
            ? { value: '', label: '— Select category —' }
            : { value: '', label: '— None (top level) —' };
          target.innerHTML = [placeholder]
            .concat(pool.map((c) => ({ value: c.id, label: c.name })))
            .map((o) => `<option value="${esc(o.value)}">${esc(o.label)}</option>`)
            .join('');
        };
        form.querySelector('[name=itemType]')?.addEventListener('change', refreshSelects);
        refreshSelects();

        overlay.querySelector('[data-qa-cancel]').addEventListener('click', () => closeModal());
        const submit = async () => {
          if (!form.reportValidity()) return;
          const values = serializeForm(form);
          submitBtn.disabled = true;
          try {
            const endpoint = typeof cfg.endpoint === 'function' ? cfg.endpoint(values) : cfg.endpoint;
            const res = await api.post(endpoint, cfg.payload(values));
            metaPromise = null;
            const freshMeta = await loadMeta();
            const record = cfg.record(res || {}, values, freshMeta);
            remember(type, record);
            syncState(type, record);
            syncOptions(document);
            if (onCreated) onCreated(record, values, freshMeta);
            if (source && source.isConnected) {
              appendOption(source, type, record);
              source.value = record.id;
              source.dispatchEvent(new Event('change', { bubbles: true }));
            }
            window.dispatchEvent(new CustomEvent('abmdas:master-created', { detail: { type, record } }));
            completed = true;
            closeModal();
            toast(successMessage || `${cfg.label} created and selected.`);
            finish(record);
          } catch (err) {
            toast(err.message || `Could not create ${cfg.label.toLowerCase()}.`, 'error');
            submitBtn.disabled = false;
          }
        };
        submitBtn.addEventListener('click', submit);
        form.addEventListener('submit', (e) => {
          e.preventDefault();
          submit();
        });
      },
    });
  });
}

function processSelect(select) {
  if (!select || select.tagName !== 'SELECT') return;
  if (select.dataset.qaDone || select.dataset.qaSkip || select.closest('[data-qa-modal]')) return;
  const type = inferType(select);
  if (!type) return;
  const cfg = MASTERS[type];
  if (!cfg || !allowed(cfg)) return;
  const scope = select.closest('form') || select.closest('.card') || document;
  if ((cfg.dedupe || []).some((s) => scope.querySelector(s))) return;

  select.dataset.qaDone = '1';
  const wrap = document.createElement('div');
  wrap.className = 'qa-row';
  select.parentNode.insertBefore(wrap, select);
  wrap.appendChild(select);

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'qa-btn';
  btn.title = `Create a new ${cfg.label.toLowerCase()}`;
  btn.setAttribute('aria-label', btn.title);
  btn.innerHTML = icon('plus');
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    void openQuickAdd(type, select);
  });
  wrap.appendChild(btn);
  syncOptions(select);
}

function processNode(node) {
  if (!node || node.nodeType !== 1) return;
  if (node.matches && node.matches('select')) processSelect(node);
  if (node.querySelectorAll) node.querySelectorAll('select').forEach(processSelect);
}

/** Attach quick-add buttons to selects that are already on the page. */
export function attachQuickAdds(root = document) {
  processNode(root);
}

/** Watch for later renders (including modals and added line-item rows). */
export function installQuickAdds() {
  if (observer) return;
  observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) processNode(node);
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
}
