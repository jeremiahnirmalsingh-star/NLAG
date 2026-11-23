export const state = {
  user: null,
  settings: {
    orgName: 'New Life AG Church',
    orgDepartment: 'Administration Department',
    currency: '\u20B9',
    reportFooter: '',
    publicBaseUrl: '',
    defaultGstRate: 18,
    defaultTransportGstRate: 18,
  },
  roles: [],
  departments: [],
  categories: [],
  units: [],
  memberUnitIds: [],
  currentUnitIds: [],
  pendingApprovals: 0,
  unread: 0,
};

const UNIT_KEY = 'abmdas.units';

export function unitStorageKey() {
  return state.user ? `${UNIT_KEY}.${state.user.id}` : UNIT_KEY;
}

export function setCurrentUnits(ids) {
  state.currentUnitIds = ids.map(Number);
  try {
    localStorage.setItem(unitStorageKey(), state.currentUnitIds.join(','));
  } catch {
    /* storage unavailable: the server default is used */
  }
}

export function memberUnits() {
  return state.units.filter((u) => u.active && state.memberUnitIds.includes(Number(u.id)));
}

export function can(permission) {
  const perms = (state.user && state.user.permissions) || [];
  return perms.includes('*') || perms.includes(permission);
}

export function canAny(list) {
  return list.some((p) => can(p));
}

export function applyBootstrap(data) {
  state.user = data.user;
  state.settings = data.settings || state.settings;
  state.roles = data.roles || [];
  state.departments = data.departments || [];
  state.categories = data.categories || [];
  state.units = data.units || [];
  state.memberUnitIds = data.memberUnitIds || [];
  let stored = [];
  try {
    stored = (localStorage.getItem(`${UNIT_KEY}.${data.user.id}`) || '')
      .split(',')
      .map(Number)
      .filter((id) => state.memberUnitIds.includes(id));
  } catch {
    stored = [];
  }
  state.currentUnitIds = stored.length ? stored : (data.currentUnitIds || []).map(Number);
  state.pendingApprovals = data.pendingApprovals || 0;
  state.unread = data.unreadNotifications || 0;
}
