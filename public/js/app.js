import { api } from './api.js';
import { state, applyBootstrap, can, memberUnits, setCurrentUnits } from './state.js';
import { esc, icon, initials, relTime, fmtDate, toast, modal } from './ui.js';
import { parseHash, navigate, reloadPage, withQuery } from './router.js';
import { installQuickAdds, attachQuickAdds } from './quick-add.js';
import {
  startSessionTimeout, stopSessionTimeout, broadcastLogout, getLastActivityAt,
} from './session.js';

import * as dashboardPage from './pages/dashboard.js';
import * as billsPage from './pages/bills.js';
import * as vendorsPage from './pages/vendors.js';
import * as itemsPage from './pages/items.js';
import * as requisitionsPage from './pages/requisitions.js';
import * as sourcingPage from './pages/sourcing.js';
import * as purchaseOrdersPage from './pages/purchase-orders.js';
import * as invoicesPage from './pages/invoices.js';
import * as assetsPage from './pages/assets.js';
import * as procurementDashboardPage from './pages/procurement-dashboard.js';
import * as assetClassesPage from './pages/asset-classes.js';
import * as alertsPage from './pages/alerts.js';
import * as fleetPage from './pages/fleet.js';

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' })
      .then((reg) => {
        /* Pick up a new service worker on every load. */
        reg.update().catch(() => {});
      })
      .catch(() => {});
  });
}
import * as stocksPage from './pages/stocks.js';
import * as orgPage from './pages/org.js';
import * as employeesPage from './pages/employees.js';
import * as storesPage from './pages/stores.js';
import * as vendorEvaluationsPage from './pages/vendor-evaluations.js';
import * as advancesPage from './pages/advances.js';
import * as imprestsPage from './pages/imprests.js';
import * as approvalsPage from './pages/approvals.js';
import * as handoverPage from './pages/handover.js';
import * as reportsPage from './pages/reports.js';
import * as adminPage from './pages/admin.js';
import * as documentsPage from './pages/documents.js';
import * as workingDaysPage from './pages/working-days.js';
import * as addressesPage from './pages/addresses.js';
import * as verifyPage from './pages/verify.js';

function selectedUnitLabel() {
  const units = memberUnits();
  const selected = units.filter((u) => state.currentUnitIds.includes(Number(u.id)));
  if (!selected.length || selected.length === units.length) return 'All my units';
  if (selected.length <= 2) return selected.map((u) => u.name).join(', ');
  return `${selected.length} units`;
}

const NAV = [
  {
    label: 'Overview',
    items: [{ path: '/', label: 'Dashboard', icon: 'grid', permission: 'dashboard.view' }],
  },
  {
    label: 'Bills & Approvals',
    items: [
      { path: '/bills', label: 'Bills', icon: 'file', permission: 'bill.view' },
      { path: '/approvals', label: 'Approvals', icon: 'checkSquare', permission: 'bill.approve', badge: 'approvals' },
    ],
  },
  {
    label: 'Masters',
    items: [
      { path: '/vendors', label: 'Vendors', icon: 'briefcase', permission: 'vendor.view' },
      { path: '/advances', label: 'Advances', icon: 'wallet', permission: 'advance.view' },
      { path: '/imprests', label: 'Imprests', icon: 'wallet', permission: 'advance.view' },
    ],
  },
  {
    label: 'Accounts Handover',
    items: [
      { path: '/handover', label: 'Handover Register', icon: 'send', permission: 'handover.view' },
      { path: '/reports', label: 'Reports', icon: 'chart', permission: 'report.view' },
    ],
  },
  {
    label: 'Procurement',
    items: [
      { path: '/procurement-dashboard', label: 'Procurement Dashboard', icon: 'grid', permission: 'po.view' },
      { path: '/requisitions', label: 'Requisitions', icon: 'clipboard', permission: 'requisition.view' },
      { path: '/sourcing', label: 'Sourcing', icon: 'send', permission: 'sourcing.view' },
      { path: '/purchase-orders', label: 'Purchase Orders', icon: 'briefcase', permission: 'po.view' },
      { path: '/grns', label: 'Goods Receipts', icon: 'database', permission: 'grn.view' },
      { path: '/invoices', label: 'Procurement Invoices', icon: 'file', permission: 'invoice.view' },
      { path: '/assets', label: 'Assets', icon: 'layers', permission: 'asset.view' },
      { path: '/stocks', label: 'Stock Register', icon: 'database', permission: 'stock.view' },
      { path: '/items', label: 'Items', icon: 'layers', permission: 'item.view' },
      { path: '/asset-classes', label: 'Asset Classes', icon: 'layers', permission: 'item.view' },
      { path: '/alerts', label: 'Alerts', icon: 'bell', permission: 'item.view' },
      { path: '/stores', label: 'Stores', icon: 'database', permission: 'store.view' },
      { path: '/vendor-evaluations', label: 'Vendor Evaluation', icon: 'trend', permission: 'vendor.view' },
    ],
  },
  {
    label: 'People & Organization',
    items: [
      { path: '/employees', label: 'Employees', icon: 'users', permission: 'employee.view' },
      { path: '/org', label: 'Departments & Units', icon: 'branch', permission: 'org.view' },
      { path: '/users', label: 'Users', icon: 'users', permission: 'user.manage' },
      { path: '/documents', label: 'Documents', icon: 'file', permission: 'employee.view' },
      { path: '/addresses', label: 'Addresses & Maps', icon: 'branch', permission: 'org.view' },
      { path: '/working-days', label: 'Working Days & Holidays', icon: 'calendar', permission: 'org.view' },
    ],
  },
  {
    label: 'Fleet Desk',
    items: [
      { path: '/fleet', label: 'Vehicle Bookings', icon: 'car', permission: 'fleet.view' },
      { path: '/fleet/masters', label: 'Fleet Masters', icon: 'gear', permission: 'fleet.view' },
    ],
  },
  {
    label: 'Administration',
    items: [
      { path: '/roles', label: 'Roles & Permissions', icon: 'shield', permission: 'role.manage' },
      { path: '/workflow', label: 'Approval Workflow', icon: 'branch', permission: 'workflow.manage' },
      { path: '/audit', label: 'Audit Trail', icon: 'clock', permission: 'audit.view' },
      { path: '/settings', label: 'Settings', icon: 'gear', permission: 'settings.manage' },
    ],
  },
];

const TITLES = {
  '/': 'Dashboard',
  '/bills': 'Bills',
  '/approvals': 'Approvals',
  '/vendors': 'Vendors',
  '/advances': 'Advance Register',
  '/imprests': 'Imprests',
  '/handover': 'Accounts Handover',
  '/reports': 'Reports',
  '/items': 'Items',
  '/requisitions': 'Requisitions',
  '/sourcing': 'Sourcing',
  '/purchase-orders': 'Purchase Orders',
  '/grns': 'Goods Receipts',
  '/invoices': 'Procurement Invoices',
  '/assets': 'Assets',
'/procurement-dashboard': 'Procurement Dashboard',
'/asset-classes': 'Asset Classes',
'/alerts': 'Alerts',
  '/fleet': 'Vehicle Bookings',
  '/fleet/masters': 'Fleet Masters',
  '/stocks': 'Stock Register',
  '/org': 'Organization',
  '/employees': 'Employees',
  '/documents': 'Documents',
  '/addresses': 'Common Addresses',
  '/working-days': 'Working Days & Holidays',
  '/stores': 'Stores',
  '/vendor-evaluations': 'Vendor Evaluation',
  '/users': 'User Management',
  '/roles': 'Roles & Permissions',
  '/workflow': 'Approval Workflow',
  '/audit': 'Audit Trail',
  '/settings': 'System Settings',
  '/profile': 'My Profile',
};

let shellReady = false;
let unreadTimer = null;

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */
async function boot() {
  installQuickAdds();
  try {
    const me = await api.get('/api/auth/me', { silent: true });
    state.user = me.user;
    startSessionTimeout(me.sessionTimeoutMs);
    await loadBootstrap();
  } catch {
    state.user = null;
  }
  queueRender();
}

async function loadBootstrap() {
  const data = await api.get('/api/meta/bootstrap', { silent: true });
  applyBootstrap(data);
}

async function refreshShell() {
  try {
    const data = await api.get('/api/meta/bootstrap', { silent: true });
    applyBootstrap(data);
    updateBadges();
  } catch {
    /* ignore */
  }
}

/* ------------------------------------------------------------------ */
/* Login                                                               */
/* ------------------------------------------------------------------ */
function renderLogin(message = '') {
  shellReady = false;
  const app = document.getElementById('app');
  app.innerHTML = `
    <div class="auth-page">
      <div class="auth-brand">
        <div class="auth-dotgrid"></div>
        <div class="auth-brand-inner">
          <div class="brand">
            <div class="brand-mark"><img src="/img/logo.png?v=2" alt="Logo" style="width:100%;height:100%;object-fit:contain;display:block" /></div>
            <div class="brand-text">
              <strong>New Life Assembly of God Community</strong>
              <span>Administration Department</span>
            </div>
          </div>
          <div class="auth-hero">
            <h1>Bills, approvals, and <span class="accent-word">accountability</span> \u2014 all in one place.</h1>
            <p>A single, auditable system for vendor bills, advances and digital approvals \u2014 from receipt to handover to Accounts.</p>
            <div class="auth-points">
              <div class="auth-point"><span class="tick">${icon('check')}</span><span>Register bills and verify invoices against duplicate entries.</span></div>
              <div class="auth-point"><span class="tick">${icon('check')}</span><span>Track vendor advances and adjust them against invoices.</span></div>
              <div class="auth-point"><span class="tick">${icon('check')}</span><span>Route approvals by amount with a complete digital audit trail.</span></div>
              <div class="auth-point"><span class="tick">${icon('check')}</span><span>Hand approved bills to Accounts with verifiable approval reports.</span></div>
            </div>
          </div>
          <div class="auth-foot">New Life AG Church \u00b7 Administration Bill Management &amp; Digital Approval System v1.0</div>
        </div>
      </div>
      <div class="auth-panel">
        <div class="auth-card">
          <h2>Sign in</h2>
          <div class="sub">Use your Administration Department credentials.</div>
          <form id="login-form" autocomplete="on">
            <div id="login-error" class="auth-alert ${message ? '' : 'hidden'}">${esc(message)}</div>
            <div class="field">
              <label>Username</label>
              <div class="input-with-icon">
                ${icon('user')}
                <input class="input" name="username" placeholder="Your username" autocomplete="username" required />
              </div>
            </div>
            <div class="field">
              <label>Password</label>
              <div class="input-with-icon">
                ${icon('lock')}
                <input class="input" name="password" type="password" placeholder="Your password" autocomplete="current-password" required />
                <button type="button" class="icon-btn eye" data-toggle-pass aria-label="Show password">${icon('eye')}</button>
              </div>
            </div>
            <button class="btn btn-primary btn-block" type="submit">Sign in</button>
          </form>
          <div class="auth-hint">
            <b>Need access?</b> Your Super Administrator creates accounts. Contact the Administration Department
            if you have forgotten your password or need an account.
          </div>
        </div>
      </div>
    </div>`;



  const form = document.getElementById('login-form');
  const errBox = document.getElementById('login-error');
  form.querySelector('[data-toggle-pass]').addEventListener('click', () => {
    const input = form.querySelector('[name=password]');
    input.type = input.type === 'password' ? 'text' : 'password';
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    btn.textContent = 'Signing in\u2026';
    errBox.classList.add('hidden');
    try {
      const data = await api.post('/api/auth/login', {
        username: form.username.value.trim(),
        password: form.password.value,
      }, { silent: true });
      state.user = data.user;
      startSessionTimeout(data.sessionTimeoutMs);
      await loadBootstrap();
      shellReady = false;
      navigate('/', { replace: true });
    } catch (err) {
      errBox.textContent = err.message;
      errBox.classList.remove('hidden');
      btn.disabled = false;
      btn.textContent = 'Sign in';
    }
  });
}

/* ------------------------------------------------------------------ */
/* Shell                                                               */
/* ------------------------------------------------------------------ */
function navHtml() {
  return NAV.map((group) => {
    const items = group.items.filter((item) => can(item.permission));
    if (!items.length) return '';
    return `<div class="nav-label">${esc(group.label)}</div>
      ${items
        .map(
          (item) => `<a href="#${item.path}" data-nav="${item.path}">
            ${icon(item.icon)}
            <span>${esc(item.label)}</span>
            ${item.badge === 'approvals' && state.pendingApprovals ? `<span class="badge-count" data-badge="approvals">${state.pendingApprovals}</span>` : ''}
          </a>`
        )
        .join('')}`;
  }).join('');
}

function renderShell() {
  const app = document.getElementById('app');
  app.innerHTML = `
    <div class="app">
      <aside class="sidebar" id="sidebar">
        <div class="brand">
          <div class="brand-mark"><img src="/img/logo.png?v=2" alt="Logo" style="width:100%;height:100%;object-fit:contain;display:block" /></div>
          <div class="brand-text">
            <strong>New Life Assembly of God Community</strong>
            <span>${esc(state.settings.orgName || 'New Life AG Church')}</span>
          </div>
        </div>
        <nav class="nav">${navHtml()}</nav>
        <div class="sidebar-foot">
          Administration Department<br />
          v1.0 &middot; Secure internal system
        </div>
      </aside>
      <div class="main">
        <header class="topbar">
          <button class="icon-btn hamburger" data-menu-toggle aria-label="Menu">${icon('menu')}</button>
          <div class="crumbs" id="crumbs"><b>Dashboard</b></div>
          <div class="top-search">
            ${icon('search')}
            <input id="global-search" placeholder="Search bills, invoices, vendors\u2026" />
          </div>
          ${memberUnits().length > 1 ? `<details id="unit-picker" style="position:relative">
            <summary class="btn btn-sm" style="list-style:none;cursor:pointer;white-space:nowrap">${icon('filter')} Units: ${esc(selectedUnitLabel())}</summary>
            <div class="card" style="position:absolute;right:0;top:calc(100% + 6px);z-index:50;min-width:230px;padding:12px">
              ${memberUnits().map((u) => `<label style="display:flex;gap:8px;align-items:center;padding:4px 0"><input type="checkbox" name="unitPick" value="${u.id}" ${state.currentUnitIds.includes(Number(u.id)) ? 'checked' : ''} /> ${esc(u.name)}</label>`).join('')}
              <div class="row" style="justify-content:flex-end;margin-top:8px"><button type="button" class="btn btn-sm btn-primary" id="unit-apply">Apply</button></div>
            </div>
          </details>` : (memberUnits().length === 1 ? `<span class="small muted">${esc(memberUnits()[0].name)}</span>` : '')}
          <div class="dropdown" id="notif-wrap">
            <button class="icon-btn" id="notif-btn" aria-label="Notifications">
              ${icon('bell')}
              <span class="dot ${state.unread ? '' : 'hidden'}" id="notif-dot">${state.unread > 9 ? '9+' : state.unread}</span>
            </button>
          </div>
          <div class="dropdown" id="user-wrap">
            <button class="user-chip" id="user-btn" title="${esc(state.user.name)}">
              <span class="avatar">${esc(initials(state.user.name))}</span>
              <span class="who">
                <b>${esc(state.user.name)}</b>
                <span>${esc(state.user.roleName)}</span>
              </span>
              ${icon('chevronDown', 'icon')}
            </button>
          </div>
        </header>
        <div class="content" id="view"></div>
      </div>
    </div>`;

  document.getElementById('menu-toggle')?.addEventListener('click', () => {});
  document.querySelector('[data-menu-toggle]').addEventListener('click', () => {
    document.getElementById('sidebar').classList.toggle('open');
  });

  document.querySelectorAll('.nav a').forEach((a) => {
    a.addEventListener('click', () => document.getElementById('sidebar').classList.remove('open'));
  });

  const search = document.getElementById('global-search');
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const value = search.value.trim();
      navigate(withQuery('/bills', { search: value }));
    }
  });

  const unitApply = document.getElementById('unit-apply');
  if (unitApply) {
    unitApply.addEventListener('click', () => {
      const picked = [...document.querySelectorAll('input[name="unitPick"]:checked')].map((el) => el.value);
      if (!picked.length) {
        toast('Select at least one unit.', 'error');
        return;
      }
      setCurrentUnits(picked);
      const picker = document.getElementById('unit-picker');
      if (picker) {
        picker.open = false;
        const summary = picker.querySelector('summary');
        if (summary) summary.innerHTML = `${icon('filter')} Units: ${esc(selectedUnitLabel())}`;
      }
      reloadPage();
    });
  }
  document.getElementById('notif-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    openNotifications();
  });
  document.getElementById('user-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    openUserMenu();
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('#notif-wrap')) document.querySelector('#notif-menu')?.remove();
    if (!e.target.closest('#user-wrap') && !e.target.closest('.modal-overlay')) {
      document.querySelector('#user-menu')?.remove();
    }
  });

  shellReady = true;
}

function openUserMenu() {
  document.querySelector('#user-menu')?.remove();
  const wrap = document.getElementById('user-wrap');
  const menu = document.createElement('div');
  menu.id = 'user-menu';
  menu.className = 'dropdown-menu';
  menu.style.width = '230px';
  menu.innerHTML = `
    <div style="padding:12px 14px;border-bottom:1px solid var(--border)">
      <div style="font-weight:650;font-size:13px">${esc(state.user.name)}</div>
      <div class="small muted">${esc(state.user.designation || state.user.roleName)}</div>
      <div class="small muted mono" style="margin-top:2px">${esc(state.user.employeeId)}</div>
    </div>
    <button class="dd-item" data-go="/profile" style="width:100%;border:0;background:none;text-align:left">
      <span>${icon('user')}</span><span class="t">My profile</span>
    </button>
    <button class="dd-item" data-changepass style="width:100%;border:0;background:none;text-align:left">
      <span>${icon('lock')}</span><span class="t">Change password</span>
    </button>
    <button class="dd-item" data-logout style="width:100%;border:0;background:none;text-align:left">
      <span>${icon('logout')}</span><span class="t">Sign out</span>
    </button>`;
  wrap.appendChild(menu);
  menu.querySelector('[data-go]').addEventListener('click', () => { menu.remove(); navigate('/profile'); });
  menu.querySelector('[data-changepass]').addEventListener('click', () => { menu.remove(); openChangePassword(); });
  menu.querySelector('[data-logout]').addEventListener('click', async () => {
    menu.remove();
    stopSessionTimeout();
    broadcastLogout();
    try { await api.post('/api/auth/logout'); } catch { /* ignore */ }
    state.user = null;
    renderLogin('You have been signed out.');
  });
}

function openChangePassword() {
  modal({
    title: 'Change password',
    subtitle: 'Choose a new password of at least 8 characters.',
    body: `<form id="cp-form">
      <div class="field"><label>Current password</label><input class="input" type="password" name="currentPassword" required /></div>
      <div class="field"><label>New password</label><input class="input" type="password" name="newPassword" minlength="8" required /></div>
      <div class="field"><label>Confirm new password</label><input class="input" type="password" name="confirm" minlength="8" required /></div>
      <div class="alert alert-danger hidden" data-err></div>
    </form>`,
    footer: `<button class="btn" data-modal-close>Cancel</button><button class="btn btn-primary" data-save>Update password</button>`,
    onMount(el, close) {
      el.querySelector('[data-save]').addEventListener('click', async () => {
        const form = el.querySelector('#cp-form');
        const err = el.querySelector('[data-err]');
        err.classList.add('hidden');
        if (form.newPassword.value !== form.confirm.value) {
          err.textContent = 'New passwords do not match.';
          err.classList.remove('hidden');
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
          state.user = null;
          renderLogin('Your password was changed. Please sign in with the new password.');
        } catch (e2) {
          err.textContent = e2.message;
          err.classList.remove('hidden');
        }
      });
    },
  });
}

async function openNotifications() {
  document.querySelector('#notif-menu')?.remove();
  const wrap = document.getElementById('notif-wrap');
  const menu = document.createElement('div');
  menu.id = 'notif-menu';
  menu.className = 'dropdown-menu';
  menu.innerHTML = `<div class="dd-head">Notifications <span class="spacer"></span>
      <button class="btn btn-ghost btn-sm" data-readall>Mark all read</button></div>
    <div class="dd-list"><div class="empty small" style="padding:24px">Loading\u2026</div></div>`;
  wrap.appendChild(menu);

  try {
    const data = await api.get('/api/notifications');
    const list = menu.querySelector('.dd-list');
    if (!data.notifications.length) {
      list.innerHTML = '<div class="empty small" style="padding:26px">No notifications yet.</div>';
    } else {
      list.innerHTML = data.notifications
        .map(
          (n) => `<div class="dd-item ${n.is_read ? '' : 'unread'}" data-id="${n.id}" data-link="${esc(n.link || '')}">
            ${n.is_read ? '' : '<span class="notice-dot" style="margin-top:5px"></span>'}
            <div style="min-width:0">
              <div class="t">${esc(n.title)}</div>
              <div class="m">${esc(n.message)}</div>
              <div class="when">${relTime(n.created_at)}</div>
            </div>
          </div>`
        )
        .join('');
      list.querySelectorAll('.dd-item').forEach((item) => {
        item.addEventListener('click', async () => {
          const id = item.dataset.id;
          try { await api.post(`/api/notifications/${id}/read`); } catch { /* ignore */ }
          item.classList.remove('unread');
          const link = item.dataset.link;
          menu.remove();
          await refreshShell();
          if (link) navigate(link.replace(/^#/, ''));
        });
      });
    }
    menu.querySelector('[data-readall]').addEventListener('click', async () => {
      try {
        await api.post('/api/notifications/read-all');
        await refreshShell();
        menu.remove();
      } catch (e) {
        toast(e.message, 'error');
      }
    });
  } catch (e) {
    menu.querySelector('.dd-list').innerHTML = `<div class="empty small">${esc(e.message)}</div>`;
  }
}

function updateBadges() {
  const navBadge = document.querySelector('[data-badge="approvals"]');
  if (state.pendingApprovals) {
    if (navBadge) navBadge.textContent = state.pendingApprovals;
    else {
      const link = document.querySelector('[data-nav="/approvals"]');
      if (link) link.insertAdjacentHTML('beforeend', `<span class="badge-count" data-badge="approvals">${state.pendingApprovals}</span>`);
    }
  } else if (navBadge) navBadge.remove();
  const dot = document.getElementById('notif-dot');
  if (dot) {
    dot.textContent = state.unread > 9 ? '9+' : String(state.unread);
    dot.classList.toggle('hidden', !state.unread);
  }
}

function setActiveNav(path) {
  const base = '/' + (path.split('/')[1] || '');
  document.querySelectorAll('.nav a').forEach((a) => {
    const target = a.dataset.nav;
    const match = target === '/' ? path === '/' : path === target || path.startsWith(target + '/');
    a.classList.toggle('active', match);
    void base;
  });
}

/* ------------------------------------------------------------------ */
/* Router                                                              */
/* ------------------------------------------------------------------ */
async function render() {
  const route = parseHash();
  const isPublic = route.parts[0] === 'verify';

  if (isPublic) {
    shellReady = false;
    await verifyPage.render(document.getElementById('app'), { token: route.parts[1] });
    return;
  }

  if (!state.user) {
    renderLogin();
    return;
  }
  if (route.path === '/login') {
    navigate('/', { replace: true });
    return;
  }

  if (!shellReady) renderShell();

  const view = document.getElementById('view');
  const title = TITLES[`/${route.parts[0] || ''}`] || (route.parts[0] === 'bills' ? 'Bills' : 'New Life Assembly of God Community');
  const crumbs = document.getElementById('crumbs');
  if (crumbs) {
    const extra = route.parts.length > 1 ? ` <span>/</span> <b>${esc(route.parts[1] === 'new' ? 'New' : route.parts[1])}</b>` : '';
    crumbs.innerHTML = `<b>${esc(title)}</b>${extra}`;
  }
  setActiveNav(route.path);
  document.getElementById('po-print-page-style')?.remove();
  view.innerHTML = '';
  const ctx = { route, view };
  try {
    await routePage(route, ctx);
    attachQuickAdds(view);
  } catch (err) {
    if (err.status === 401) return;
    view.innerHTML = `<div class="card"><div class="empty">
      <h4>Something went wrong</h4><div class="small">${esc(err.message || 'Unable to load this page.')}</div>
      <div class="mt-12"><button class="btn btn-sm" data-reload-page>Reload</button></div></div></div>`;
    view.querySelector('[data-reload-page]')?.addEventListener('click', () => window.location.reload());
    console.error(err);
  }
  window.scrollTo({ top: 0 });
  refreshShell();
}

async function routePage(route, ctx) {
  const p = route.parts;
  const guard = (permission) => {
    if (!can(permission)) {
      ctx.view.innerHTML = `<div class="card">${'<div class="empty"><h4>Access denied</h4><div class="small">You do not have permission to view this page.</div></div>'}</div>`;
      return false;
    }
    return true;
  };

  if (p.length === 0) return dashboardPage.render(ctx);
  if (p[0] === 'bills') {
    if (!guard('bill.view')) return;
    if (p[1] === 'new') return billsPage.renderForm(ctx);
    if (p[2] === 'edit') return billsPage.renderForm(ctx, { id: p[1] });
    if (p[2] === 'report') return billsPage.renderApprovalReport(ctx, { id: p[1] });
    if (p[1]) return billsPage.renderDetail(ctx, { id: p[1] });
    return billsPage.renderList(ctx);
  }
  if (p[0] === 'approvals') {
    if (!guard('bill.approve')) return;
    return approvalsPage.render(ctx);
  }
  if (p[0] === 'vendors') {
    if (!guard('vendor.view')) return;
    if (p[1] === 'new') return vendorsPage.renderForm(ctx);
    if (p[2] === 'edit') return vendorsPage.renderForm(ctx, { id: p[1] });
    if (p[1]) return vendorsPage.renderDetail(ctx, { id: p[1] });
    return vendorsPage.renderList(ctx);
  }
  if (p[0] === 'requisitions') {
    if (!guard('requisition.view')) return;
    if (p[1] === 'new') return requisitionsPage.renderForm(ctx);
    if (p[2] === 'edit') return requisitionsPage.renderForm(ctx, { id: p[1] });
    if (p[1]) return requisitionsPage.renderDetail(ctx, { id: p[1] });
    return requisitionsPage.renderList(ctx);
  }
  if (p[0] === 'sourcing') {
    if (!guard('sourcing.view')) return;
    if (p[1] === 'new') return sourcingPage.renderForm(ctx);
    if (p[2] === 'edit') return sourcingPage.renderForm(ctx, { id: p[1] });
    if (p[1]) return sourcingPage.renderDetail(ctx, { id: p[1] });
    return sourcingPage.renderList(ctx);
  }
  if (p[0] === 'purchase-orders') {
    if (!guard('po.view')) return;
    if (p[1] === 'new') return purchaseOrdersPage.renderForm(ctx);
    if (p[2] === 'edit') return purchaseOrdersPage.renderForm(ctx, { id: p[1] });
    if (p[2] === 'print') return purchaseOrdersPage.renderPrint(ctx, { id: p[1] });
    if (p[1]) return purchaseOrdersPage.renderDetail(ctx, { id: p[1] });
    return purchaseOrdersPage.renderList(ctx);
  }
  if (p[0] === 'grns') {
    if (!guard('grn.view')) return;
    if (p[1] === 'new') return purchaseOrdersPage.renderGrnForm(ctx);
    if (p[2] === 'edit') return purchaseOrdersPage.renderGrnForm(ctx, { id: p[1] });
    if (p[1]) return purchaseOrdersPage.renderGrnDetail(ctx, { id: p[1] });
    return purchaseOrdersPage.renderGrnList(ctx);
  }
  if (p[0] === 'invoices') {
    if (!guard('invoice.view')) return;
    if (p[1] === 'new') return invoicesPage.renderForm(ctx);
    if (p[2] === 'edit') return invoicesPage.renderForm(ctx, { id: p[1] });
    if (p[1]) return invoicesPage.renderDetail(ctx, { id: p[1] });
    return invoicesPage.renderList(ctx);
  }
  if (p[0] === 'alerts') {
    if (!guard('item.view')) return;
    return alertsPage.renderList(ctx);
  }
  if (p[0] === 'fleet') {
    if (!guard('fleet.view')) return;
    if (p[1] === 'masters') return fleetPage.renderMasters(ctx);
    if (p[1] === 'bookings' && p[2] === 'new') return fleetPage.renderBookingForm(ctx);
    if (p[1] === 'bookings' && p[2]) return fleetPage.renderBookingDetail(ctx, { id: p[2] });
    return fleetPage.renderBookings(ctx);
  }
  if (p[0] === 'asset-classes') {
    if (!guard('item.view')) return;
    if (p[1]) return assetClassesPage.renderForm(ctx, { id: p[1] });
    return assetClassesPage.renderList(ctx);
  }
  if (p[0] === 'procurement-dashboard') {
    if (!guard('po.view')) return;
    return procurementDashboardPage.render(ctx);
  }
  if (p[0] === 'assets') {
    if (!guard('asset.view')) return;
    if (p[1] === 'new') return assetsPage.renderForm(ctx);
    if (p[2] === 'edit') return assetsPage.renderForm(ctx, { id: p[1] });
    if (p[1]) return assetsPage.renderDetail(ctx, { id: p[1] });
    return assetsPage.renderList(ctx);
  }
  if (p[0] === 'stocks') {
    if (!guard('stock.view')) return;
    return stocksPage.render(ctx);
  }
  if (p[0] === 'items') {
    if (!guard('item.view')) return;
    if (p[1] === 'new') return itemsPage.renderForm(ctx);
    if (p[2] === 'edit') return itemsPage.renderForm(ctx, { id: p[1] });
    if (p[1]) return itemsPage.renderDetail(ctx, { id: p[1] });
    return itemsPage.renderList(ctx);
  }
  if (p[0] === 'org') {
    if (!guard('org.view')) return;
    return orgPage.render(ctx);
  }
  if (p[0] === 'employees') {
    if (!guard('employee.view')) return;
    return employeesPage.render(ctx, { id: p[1] });
  }
  if (p[0] === 'documents') {
    return documentsPage.renderDocuments(ctx, ctx.route.query || {});
  }
  if (p[0] === 'addresses') {
    if (!guard('org.view')) return;
    return addressesPage.render(ctx);
  }
  if (p[0] === 'working-days') {
    if (!guard('org.view')) return;
    return workingDaysPage.render(ctx);
  }
  if (p[0] === 'stores') {
    if (!guard('store.view')) return;
    return storesPage.render(ctx);
  }
  if (p[0] === 'vendor-evaluations') {
    if (!guard('vendor.view')) return;
    return vendorEvaluationsPage.render(ctx);
  }
  if (p[0] === 'advances') {
    if (!guard('advance.view')) return;
    if (p[2] === 'print') return advancesPage.renderPrint(ctx, { id: p[1] });
    if (p[1]) return advancesPage.renderDetail(ctx, { id: p[1] });
    return advancesPage.renderList(ctx);
  }
  if (p[0] === 'imprests') {
    if (!guard('advance.view')) return;
    if (p[2] === 'print') return imprestsPage.renderPrint(ctx, { id: p[1] });
    if (p[1]) return imprestsPage.renderDetail(ctx, { id: p[1] });
    return imprestsPage.render(ctx);
  }
  if (p[0] === 'handover') {
    if (!guard('handover.view')) return;
    if (p[1] === 'statement') return handoverPage.renderStatement(ctx);
    return handoverPage.render(ctx);
  }
  if (p[0] === 'reports') {
    if (!guard('report.view')) return;
    return reportsPage.render(ctx, { type: p[1] });
  }
  if (p[0] === 'users') {
    if (!guard('user.manage')) return;
    return adminPage.renderUsers(ctx);
  }
  if (p[0] === 'roles') {
    if (!guard('role.manage')) return;
    return adminPage.renderRoles(ctx);
  }
  if (p[0] === 'workflow') {
    if (!guard('workflow.manage')) return;
    return adminPage.renderWorkflow(ctx);
  }
  if (p[0] === 'audit') {
    if (!guard('audit.view')) return;
    return adminPage.renderAudit(ctx);
  }
  if (p[0] === 'settings') {
    if (!guard('settings.manage')) return;
    return adminPage.renderSettings(ctx);
  }
  if (p[0] === 'profile') return adminPage.renderProfile(ctx);

  ctx.view.innerHTML = `<div class="card"><div class="empty"><h4>Page not found</h4>
    <div class="small">The page you requested does not exist.</div>
    <div class="mt-12"><a class="btn btn-sm" href="#/">Back to dashboard</a></div></div></div>`;
}

/* ------------------------------------------------------------------ */
let renderChain = Promise.resolve();

function queueRender() {
  const target = parseHash().raw;
  renderChain = renderChain
    .catch(() => {})
    .then(() => {
      if (parseHash().raw !== target) return;
      return render();
    });
  return renderChain;
}

window.addEventListener('hashchange', queueRender);
window.addEventListener('abmdas:session-expired', () => {
  if (!state.user) return;
  stopSessionTimeout();
  state.user = null;
  shellReady = false;
  toast('Your session has expired. Please sign in again.', 'error');
  renderLogin('Your session has expired. Please sign in again.');
});

boot();

setInterval(() => {
  /* Do not poll while idle: background polling would keep the server session alive. */
  if (state.user && Date.now() - getLastActivityAt() < 60000) refreshShell();
}, 60000);

void reloadPage;
void fmtDate;
void unreadTimer;
