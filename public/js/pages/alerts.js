import { api } from '../api.js';
import { navigate } from '../router.js';
import { esc, icon, toast, statusBadge } from '../ui.js';

export async function renderList(ctx) {
  ctx.view.innerHTML = `<div class="empty">Loading alerts\\u2026</div>`;
  const res = await api.get('/api/procurement/alerts');
  const alerts = res.alerts || [];

  ctx.view.innerHTML = `
    <div class="page-head">
      <div><h1>Alerts</h1><div class="sub">Warranty, AMC, stock, expiry and vehicle document expiry alerts</div></div>
      <div class="page-actions">
        <button class="btn btn-primary" type="button" data-run>${icon('refresh')} Run alert check</button>
      </div>
    </div>
    <div id="alert-result" class="alert alert-success hidden"></div>
    <div class="card">
      ${alerts.length
        ? `<div class="table-wrap">
            <table class="tbl">
              <thead><tr><th>Title</th><th>Message</th><th>Link</th><th>Read</th><th>Created</th></tr></thead>
              <tbody>${alerts.map((a) => `
                <tr>
                  <td><span class="strong">${esc(a.title)}</span></td>
                  <td class="small">${esc(a.message)}</td>
                  <td class="small">${a.link ? `<a href="#${esc(a.link.replace(/^#/, ''))}">${esc(a.link)}</a>` : '\\u2014'}</td>
                  <td>${a.is_read ? statusBadge('active', 'Read') : statusBadge('draft', 'Unread')}</td>
                  <td class="small muted">${esc(a.created_at)}</td>
                </tr>`).join('')}</tbody>
            </table>
          </div>`
        : '<div class="empty small" style="padding:24px">No alerts yet. Click "Run alert check" to generate notifications.</div>'}
    </div>`;

  const resultBox = document.getElementById('alert-result');
  ctx.view.querySelector('[data-run]').addEventListener('click', async () => {
    try {
      const r = await api.post('/api/procurement/alerts/run', {});
      const total = (r.warranty || 0) + (r.amc || 0) + (r.stock || 0) + (r.expiry || 0) + (r.vehicle || 0);
      resultBox.innerHTML = `${icon('check')} Alert check complete: ${total} new notification(s) generated (warranty: ${r.warranty}, AMC: ${r.amc}, stock: ${r.stock}, expiry: ${r.expiry}, vehicle documents: ${r.vehicle || 0}).`;
      resultBox.classList.remove('hidden');
      setTimeout(() => navigate('/alerts'), 1500);
    } catch (e) {
      resultBox.className = 'alert alert-danger';
      resultBox.innerHTML = `${icon('alert')} ${esc(e.message || 'Unable to run alert check.')}`;
      resultBox.classList.remove('hidden');
    }
  });
}