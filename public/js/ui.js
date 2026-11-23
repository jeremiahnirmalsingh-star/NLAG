import { state } from './state.js';

/* ------------------------------------------------------------------ */
/* Procurement round-off & general terms                               */
/* ------------------------------------------------------------------ */
// state.js is owned by the bootstrap layer; seed the general-terms slot here
// so every page can safely read `state.generalTerms || ''`.
if (state.generalTerms === undefined || state.generalTerms === null) {
  state.generalTerms = '';
}

/**
 * Round a monetary value to the nearest whole rupee using half-up
 * semantics: a .50 fraction always moves away from zero.
 * 1234.49 -> 1234, 1234.50 -> 1235, 950.60 -> 951.
 */
export function roundRupee(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  const sign = n < 0 ? -1 : 1;
  const abs = Math.abs(n);
  // Tiny relative epsilon cancels binary-float noise at exact .5 boundaries.
  const epsilon = Math.max(Number.EPSILON, abs * Number.EPSILON * 8);
  const rounded = sign * Math.floor(abs + 0.5 + epsilon);
  return rounded === 0 ? 0 : rounded;
}

/**
 * Round-off adjustment stored with the FINAL rounded document total.
 * round_off = roundedTotal - preRoundTotal, persisted to 2 decimals.
 * 1234.49 -> -0.49, 1234.50 -> +0.50, 950.60 -> +0.40.
 */
export function roundOffAmount(value, roundedTotal) {
  const pre = Number(value);
  if (!Number.isFinite(pre)) return 0;
  const rounded = roundedTotal === undefined ? roundRupee(pre) : roundRupee(roundedTotal);
  const diff = rounded - pre;
  const cents = Math.round((diff + Number.EPSILON) * 100) / 100;
  return cents === 0 ? 0 : cents;
}

const roundCents = (value) => Math.round((Number(value) || 0) * 100) / 100;
const roundOffText = (value) => String(roundCents(value));

/**
 * Editable round-off control used by every procurement form.
 * The value is auto-filled from the current base total, but can be changed.
 * Leaving it blank or pressing Auto restores the calculated half-up value.
 */
export function roundOffControl({ value = 0, label = 'Round off' } = {}) {
  return `<div class="field" data-round-off-control style="min-width:180px">
    <label>${esc(label)}
      <button type="button" class="btn btn-sm btn-ghost" data-round-off-auto style="margin-left:6px;padding:1px 6px">Auto</button>
    </label>
    <input class="input" type="number" step="0.01" name="roundOff" data-round-off-input value="${esc(roundOffText(value))}" />
    <div class="hint">Auto-filled. Edit if required; clear or press Auto to reset.</div>
  </div>`;
}

/* Return the saved adjustment when it differs from the automatic value. */
function savedRoundOff(saved) {
  if (saved === undefined || saved === null || saved === '') return null;
  const n = Number(saved);
  return Number.isFinite(n) ? roundCents(n) : null;
}

/* Seed and then maintain an editable round-off input. The first sync keeps a
 * saved manual adjustment; later syncs refresh only auto-filled values. */
export function syncRoundOffInput(input, baseTotal, saved) {
  const base = roundCents(baseTotal);
  const auto = roundOffAmount(base);
  if (!input) return auto;
  input.dataset.baseTotal = String(base);
  if (input.dataset.seeded !== '1') {
    const savedValue = savedRoundOff(saved);
    if (savedValue !== null && Math.abs(savedValue - auto) >= 0.005) {
      input.value = roundOffText(savedValue);
      input.dataset.manual = '1';
    } else {
      input.value = roundOffText(auto);
      delete input.dataset.manual;
    }
    input.dataset.seeded = '1';
  } else if (input.dataset.manual !== '1') {
    input.value = roundOffText(auto);
  }
  return readRoundOffOverride(input, base);
}

/* Read the adjustment to submit. Blank/Auto means "use calculated value". */
export function readRoundOffOverride(input, baseTotal) {
  const base = roundCents(baseTotal);
  const auto = roundOffAmount(base);
  if (!input) return auto;
  const raw = String(input.value ?? '').trim();
  if (!raw || raw.toLowerCase() === 'auto') return auto;
  const n = Number(raw);
  return Number.isFinite(n) ? roundCents(n) : auto;
}

export function resetRoundOffInput(input, baseTotal) {
  if (!input) return roundOffAmount(baseTotal);
  const auto = roundOffAmount(roundCents(baseTotal));
  delete input.dataset.manual;
  input.value = roundOffText(auto);
  return auto;
}

/* Wire the manual-edit flag and Auto reset button once per rendered form. */
export function bindRoundOffControl(root, recalc) {
  if (!root || typeof recalc !== 'function') return;
  const input = root.querySelector('[data-round-off-input]');
  if (!input) return;
  if (input.dataset.bound !== '1') {
    input.dataset.bound = '1';
    input.addEventListener('input', () => {
      input.dataset.manual = '1';
      recalc();
    });
  }
  const autoButton = root.querySelector('[data-round-off-auto]');
  if (autoButton && autoButton.dataset.bound !== '1') {
    autoButton.dataset.bound = '1';
    autoButton.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      resetRoundOffInput(input, input.dataset.baseTotal);
      recalc();
    });
  }
}

/* ------------------------------------------------------------------ */
/* Escaping & formatting                                               */
/* ------------------------------------------------------------------ */
export function esc(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function money(value, options = {}) {
  const n = Number(value) || 0;
  const symbol = state.settings.currency || '\u20B9';
  const formatted = n.toLocaleString('en-IN', {
    minimumFractionDigits: options.decimals === undefined ? 2 : options.decimals,
    maximumFractionDigits: 2,
  });
  return symbol + formatted;
}

export function compactMoney(value) {
  const n = Number(value) || 0;
  const symbol = state.settings.currency || '\u20B9';
  if (Math.abs(n) >= 10000000) return `${symbol}${(n / 10000000).toFixed(2)} Cr`;
  if (Math.abs(n) >= 100000) return `${symbol}${(n / 100000).toFixed(2)} L`;
  if (Math.abs(n) >= 1000) return `${symbol}${(n / 1000).toFixed(1)}K`;
  return symbol + n.toFixed(0);
}

export function num(value) {
  return (Number(value) || 0).toLocaleString('en-IN');
}

export function fmtDate(value, withTime = false) {
  if (!value) return '\u2014';
  const str = String(value);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(str) ? new Date(`${str}T00:00:00`) : new Date(str);
  if (Number.isNaN(date.getTime())) return esc(str);
  const opts = withTime
    ? { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }
    : { day: '2-digit', month: 'short', year: 'numeric' };
  return date.toLocaleDateString('en-IN', opts);
}

export function fmtTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
}

export function relTime(value) {
  if (!value) return '';
  const date = new Date(value);
  const diff = Date.now() - date.getTime();
  if (Number.isNaN(diff)) return '';
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return fmtDate(value);
}

export function initials(name) {
  return String(name || '?')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join('');
}

export function fileSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export function todayInput() {
  const d = new Date();
  const offset = d.getTimezoneOffset();
  return new Date(d.getTime() - offset * 60000).toISOString().slice(0, 10);
}

/* ------------------------------------------------------------------ */
/* Icons                                                               */
/* ------------------------------------------------------------------ */
const ICONS = {
  grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/>',
  briefcase: '<rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/>',
  card: '<rect x="1" y="4" width="22" height="16" rx="2"/><line x1="1" y1="10" x2="23" y2="10"/>',
  checkSquare: '<polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
  send: '<line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>',
  chart: '<line x1="12" y1="20" x2="12" y2="10"/><line x1="18" y1="20" x2="18" y2="4"/><line x1="6" y1="20" x2="6" y2="16"/>',
  users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  branch: '<line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  bell: '<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>',
  search: '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
  plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
  printer: '<polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/>',
  check: '<polyline points="20 6 9 17 4 12"/>',
  x: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
  chevronLeft: '<polyline points="15 18 9 12 15 6"/>',
  chevronRight: '<polyline points="9 18 15 12 9 6"/>',
  chevronDown: '<polyline points="6 9 12 15 18 9"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>',
  eye: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>',
  trash: '<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>',
  edit: '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4z"/>',
  filter: '<polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>',
  arrowLeft: '<line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>',
  arrowRight: '<line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>',
  mail: '<path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/>',
  phone: '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"/>',
  alert: '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
  info: '<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>',
  lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>',
  refresh: '<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  external: '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>',
  menu: '<line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="18" x2="21" y2="18"/>',
  pen: '<path d="M12 19l7-7 3 3-7 7-3-3z"/><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"/><path d="M2 2l7.586 7.586"/><circle cx="11" cy="11" r="2"/>',
  message: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  undo: '<polyline points="9 14 4 9 9 4"/><path d="M20 20v-7a4 4 0 0 0-4-4H4"/>',
  wallet: '<path d="M21 12V7H5a2 2 0 0 1 0-4h14v4"/><path d="M3 5v14a2 2 0 0 0 2 2h16v-5"/><path d="M18 12a2 2 0 0 0 0 4h4v-4z"/>',
  trend: '<polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/>',
  layers: '<polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/>',
  clipboard: '<path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1"/>',
  car: '<rect x="3" y="11" width="18" height="7" rx="2"/><path d="M5 11l1.5-5a2 2 0 0 1 2-1.5h7a2 2 0 0 1 2 1.5L19 11"/><circle cx="7" cy="18" r="1.5"/><circle cx="17" cy="18" r="1.5"/>',
  book: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>',
  database: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/>',
  checkCircle: '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>',
  xCircle: '<circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>',
  sliders: '<line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/>',
  hash: '<line x1="4" y1="9" x2="20" y2="9"/><line x1="4" y1="15" x2="20" y2="15"/><line x1="10" y1="3" x2="8" y2="21"/><line x1="16" y1="3" x2="14" y2="21"/>',
  home: '<path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>',
};

export function icon(name, cls = 'icon') {
  const path = ICONS[name] || ICONS.file;
  return `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
}

/* ------------------------------------------------------------------ */
/* Badges                                                              */
/* ------------------------------------------------------------------ */
export function slug(value) {
  return String(value || '').trim().toLowerCase().replace(/[\s_]+/g, '-');
}

export function statusBadge(status, label) {
  const map = {
    draft: 'Draft',
    pending: 'Pending Approval',
    approved: 'Approved',
    rejected: 'Rejected',
    returned: 'Returned',
    hold: 'Clarification',
    cancelled: 'Cancelled',
    forwarded: 'Pending Handover',
    acknowledged: 'Acknowledged',
    active: 'Active',
    inactive: 'Inactive',
    blacklisted: 'Blacklisted',
    locked: 'Locked',
    open: 'Open',
    issued: 'Issued',
    closed: 'Closed',
    settled: 'Settled',
    overdue: 'Overdue',
    'partially-settled': 'Partially Settled',
    'partially-adjusted': 'Partially Adjusted',
    'fully-adjusted': 'Fully Adjusted',
    clarification: 'Clarification',
  };
  const key = slug(status);
  return `<span class="badge ${key}">${esc(label || map[key] || status)}</span>`;
}

export function priorityBadge(priority) {
  const key = slug(priority);
  return `<span class="badge ${key}">${esc(priority || 'Medium')}</span>`;
}

/* ------------------------------------------------------------------ */
/* Toasts & modals                                                     */
/* ------------------------------------------------------------------ */
export function toast(message, type = 'success', timeout = 4200) {
  const stack = document.getElementById('toasts');
  if (!stack) return;
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  const iconName = type === 'error' ? 'xCircle' : type === 'info' ? 'info' : 'checkCircle';
  el.innerHTML = `${icon(iconName)}<div class="msg">${esc(message)}</div>
    <button class="close" aria-label="Dismiss">${icon('x', 'icon')}</button>`;
  stack.appendChild(el);
  const dismiss = () => el.remove();
  el.querySelector('.close').addEventListener('click', dismiss);
  setTimeout(dismiss, timeout);
}

export function modal({ title, subtitle = '', body = '', footer = '', size = '', onMount, onClose, closable = true }) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal ${size}" role="dialog" aria-modal="true">
      <div class="modal-head">
        <div>
          <h3>${esc(title)}</h3>
          ${subtitle ? `<div class="sub">${esc(subtitle)}</div>` : ''}
        </div>
        ${closable ? `<button class="icon-btn" data-modal-close style="margin-left:auto">${icon('x')}</button>` : ''}
      </div>
      <div class="modal-body">${body}</div>
      ${footer ? `<div class="modal-foot">${footer}</div>` : ''}
    </div>`;
  document.body.appendChild(overlay);
  overlay.style.overflowY = 'auto';

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    overlay.remove();
    document.removeEventListener('keydown', onKey);
    if (onClose) onClose();
  };
  const onKey = (e) => {
    if (e.key === 'Escape' && closable) close();
  };
  document.addEventListener('keydown', onKey);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay && closable) close();
    if (e.target.closest('[data-modal-close]')) close();
  });
  if (onMount) onMount(overlay, close);
  return { el: overlay, close };
}

export function confirmDialog({
  title = 'Confirm action',
  message = 'Are you sure?',
  confirmText = 'Confirm',
  danger = false,
  details = '',
} = {}) {
  return new Promise((resolve) => {
    const m = modal({
      title,
      body: `<p style="margin:0;color:#46546a">${esc(message)}</p>
             ${details ? `<div class="help-block mt-12">${details}</div>` : ''}`,
      footer: `<button class="btn" data-cancel>Cancel</button>
               <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-ok>${esc(confirmText)}</button>`,
      onMount(el, close) {
        el.querySelector('[data-cancel]').addEventListener('click', () => {
          close();
          resolve(false);
        });
        el.querySelector('[data-ok]').addEventListener('click', () => {
          close();
          resolve(true);
        });
      },
    });
    void m;
  });
}

/* ------------------------------------------------------------------ */
/* Modals for approval actions                                         */
/* ------------------------------------------------------------------ */
export function actionDialog({ title, subtitle, requireComment = false, confirmText, danger = false, signature = false }) {
  return new Promise((resolve) => {
    const m = modal({
      title,
      subtitle,
      body: `
        <div class="field">
          <label>${requireComment ? 'Remarks' : 'Remarks (optional)'}</label>
          <textarea class="textarea" data-comment rows="4" placeholder="Add your remarks..."></textarea>
          <div class="hint" data-err style="color:#d64545;display:none">Remarks are required for this action.</div>
        </div>
        ${
          signature
            ? `<div class="field">
                 <label>Digital signature</label>
                 <div class="help-block" data-sig-note>Your saved signature will be applied to this approval.</div>
               </div>`
            : ''
        }`,
      footer: `<button class="btn" data-cancel>Cancel</button>
               <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-ok>${esc(confirmText)}</button>`,
      onMount(el, close) {
        const comment = el.querySelector('[data-comment]');
        el.querySelector('[data-cancel]').addEventListener('click', () => {
          close();
          resolve(null);
        });
        el.querySelector('[data-ok]').addEventListener('click', () => {
          if (requireComment && !comment.value.trim()) {
            el.querySelector('[data-err]').style.display = 'block';
            comment.focus();
            return;
          }
          close();
          resolve({ comments: comment.value.trim() });
        });
        setTimeout(() => comment.focus(), 40);
      },
    });
    void m;
  });
}

/* ------------------------------------------------------------------ */
/* Charts                                                              */
/* ------------------------------------------------------------------ */
let chartSeq = 0;

function niceMax(value) {
  if (value <= 0) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(value)));
  const n = value / pow;
  const mult = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return mult * pow;
}

export function lineChart(rows, { valueKey = 'value', labelKey = 'label', format = compactMoney, height = 250 } = {}) {
  if (!rows || !rows.length) return `<div class="empty">No data available.</div>`;
  const width = 760;
  const pad = { left: 58, right: 16, top: 18, bottom: 30 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const max = niceMax(Math.max(...rows.map((r) => Number(r[valueKey]) || 0)));
  const stepX = rows.length > 1 ? innerW / (rows.length - 1) : 0;
  const pts = rows.map((r, i) => ({
    x: pad.left + i * stepX,
    y: pad.top + innerH - ((Number(r[valueKey]) || 0) / max) * innerH,
    label: r[labelKey],
    value: Number(r[valueKey]) || 0,
  }));
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const id = `grad${(chartSeq += 1)}`;
  const area = `${line} L${pts[pts.length - 1].x.toFixed(1)},${(pad.top + innerH).toFixed(1)} L${pts[0].x.toFixed(1)},${(pad.top + innerH).toFixed(1)} Z`;

  const grid = [];
  for (let i = 0; i <= 4; i += 1) {
    const y = pad.top + (innerH / 4) * i;
    const val = max - (max / 4) * i;
    grid.push(`<line x1="${pad.left}" y1="${y}" x2="${width - pad.right}" y2="${y}" stroke="#eef2f7" stroke-width="1"/>`);
    grid.push(`<text x="${pad.left - 9}" y="${y + 3.5}" text-anchor="end" class="chart-label">${esc(format(val))}</text>`);
  }

  const labels = pts.map((p, i) => {
    const show = pts.length <= 8 || i % 2 === 0 || i === pts.length - 1;
    if (!show) return '';
    return `<text x="${p.x}" y="${height - 8}" text-anchor="middle" class="chart-label">${esc(p.label)}</text>`;
  });

  const dots = pts.map(
    (p) => `<circle cx="${p.x}" cy="${p.y}" r="3.5" fill="#fff" stroke="#0f9d8f" stroke-width="2">
      <title>${esc(p.label)}: ${esc(format(p.value))}</title></circle>`
  );

  return `<div class="chart-wrap">
    <svg class="chart-svg" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="Monthly trend">
      <defs>
        <linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#0f9d8f" stop-opacity="0.22"/>
          <stop offset="100%" stop-color="#0f9d8f" stop-opacity="0.01"/>
        </linearGradient>
      </defs>
      ${grid.join('')}
      <path d="${area}" fill="url(#${id})"/>
      <path d="${line}" fill="none" stroke="#0f9d8f" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round"/>
      ${dots.join('')}
      ${labels.join('')}
    </svg>
  </div>`;
}

export function barList(rows, { nameKey = 'name', valueKey = 'value', metaKey = 'count', max: maxOverride } = {}) {
  if (!rows || !rows.length) return `<div class="empty">No data available.</div>`;
  const max = maxOverride || Math.max(...rows.map((r) => Number(r[valueKey]) || 0), 1);
  return `<div class="bar-list">${rows
    .map(
      (r) => `
      <div class="bar-row">
        <div class="bar-top">
          <span class="name" title="${esc(r[nameKey])}">${esc(r[nameKey])}</span>
          <span class="muted nowrap">${money(r[valueKey])}${r[metaKey] !== undefined ? ` <span class="muted-2">· ${num(r[metaKey])}</span>` : ''}</span>
        </div>
        <div class="bar-track"><div class="bar-fill" style="width:${Math.max((Number(r[valueKey]) / max) * 100, 1.5).toFixed(1)}%"></div></div>
      </div>`
    )
    .join('')}</div>`;
}

/* ------------------------------------------------------------------ */
/* Mini components                                                     */
/* ------------------------------------------------------------------ */
export function emptyState(title, message = '', actionHtml = '', iconName = 'file') {
  return `<div class="empty">${icon(iconName)}
    <h4>${esc(title)}</h4>
    ${message ? `<div class="small">${esc(message)}</div>` : ''}
    ${actionHtml ? `<div class="mt-12">${actionHtml}</div>` : ''}
  </div>`;
}

export function field({ label, name, type = 'text', value = '', required = false, placeholder = '', options = null, hint = '', span = false, attrs = '' }) {
  const req = required ? '<span class="req">*</span>' : '';
  let control;
  if (type === 'select') {
    control = `<select class="select" name="${esc(name)}" ${required ? 'required' : ''} ${attrs}>
      ${options
        .map(
          (o) =>
            `<option value="${esc(o.value)}" ${String(o.value) === String(value) ? 'selected' : ''}>${esc(o.label)}</option>`
        )
        .join('')}
    </select>`;
  } else if (type === 'textarea') {
    control = `<textarea class="textarea" name="${esc(name)}" placeholder="${esc(placeholder)}" ${required ? 'required' : ''} ${attrs}>${esc(value)}</textarea>`;
  } else {
    control = `<input class="input" type="${esc(type)}" name="${esc(name)}" value="${esc(value)}" placeholder="${esc(placeholder)}" ${required ? 'required' : ''} ${attrs} />`;
  }
  return `<div class="field ${span ? 'span-2' : ''}">
    <label>${esc(label)}${req}</label>
    ${control}
    ${hint ? `<div class="hint">${hint}</div>` : ''}
  </div>`;
}

export function statusPillForBill(bill) {
  return statusBadge(bill.status, bill.statusLabel);
}

export function downloadUrl(url) {
  const a = document.createElement('a');
  a.href = url;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export function debounce(fn, delay = 320) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

export function serializeForm(formEl) {
  const data = {};
  for (const el of formEl.querySelectorAll('input[name], select[name], textarea[name]')) {
    if (el.type === 'checkbox') {
      data[el.name] = el.checked;
    } else if (el.type === 'file') {
      // handled separately
    } else {
      data[el.name] = el.value;
    }
  }
  return data;
}

export function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result);
      resolve({
        name: file.name,
        mime: file.type || 'application/octet-stream',
        size: file.size,
        data: result.split(',')[1] || '',
      });
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export const ALLOWED_UPLOAD_EXT = ['pdf', 'jpg', 'jpeg', 'png', 'docx', 'xlsx'];
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

export function fileTypeIcon(name) {
  const ext = String(name || '').split('.').pop().toLowerCase();
  if (ext === 'pdf') return icon('file');
  if (['jpg', 'jpeg', 'png', 'gif'].includes(ext)) return icon('image');
  return icon('file');
}

