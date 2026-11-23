import { api } from '../api.js';
import { can } from '../state.js';
import { navigate, withQuery } from '../router.js';
import {
  esc, icon, fmtDate, statusBadge, emptyState, toast, field, modal,
} from '../ui.js';

const STATUS_OPTIONS = ['Active', 'Inactive', 'Blacklisted'];
const RATING_OPTIONS = [0, 1, 2, 3, 4, 5].map((n) => ({
  value: n,
  label: n === 0 ? '0 \u2014 Not rated' : `${n} \u2014 ${['Poor', 'Below average', 'Average', 'Good', 'Excellent'][n - 1]}`,
}));

function ratingCell(value) {
  if (value === null || value === undefined) return '<span class="muted">\u2014</span>';
  const n = Number(value);
  return `<span class="mono">${n.toFixed(2)}</span><span class="small muted"> / 5</span>`;
}

function overallBadge(value) {
  if (value === null || value === undefined) return '<span class="muted">Not evaluated</span>';
  const n = Number(value);
  const chip = n >= 4 ? 'green' : n >= 3 ? 'amber' : 'red';
  return `<span class="chip ${chip}">${n.toFixed(2)} / 5</span>`;
}

/* ================================================================== */
/* Page                                                                */
/* ================================================================== */
export async function render(ctx) {
  const q = ctx.route.query || {};
  const params = new URLSearchParams();
  if (q.search) params.set('search', q.search);
  if (q.status) params.set('status', q.status);

  ctx.view.innerHTML = `<div class="empty">Loading vendor performance\u2026</div>`;
  const res = await api.get(`/api/procurement/vendor-evaluations?${params.toString()}`);
  const vendors = res.vendors || [];
  const evaluated = vendors.filter((v) => v.evaluationCount > 0);

  ctx.view.innerHTML = `
    <div class="page-head">
      <div><h1>Vendor Evaluation</h1><div class="sub">Append-only vendor performance ratings for delivery, quality, pricing and service</div></div>
      <div class="page-actions">
        <a class="btn" href="#/vendors">${icon('briefcase')} Vendor Master</a>
      </div>
    </div>

    <div class="grid grid-3 mb-16">
      <div class="card"><div class="kpi"><div class="chip blue">${icon('briefcase')}</div><div><div class="label">Vendors</div><div class="value">${vendors.length}</div><div class="meta">Available for evaluation</div></div></div></div>
      <div class="card"><div class="kpi"><div class="chip green">${icon('checkCircle')}</div><div><div class="label">Evaluated</div><div class="value">${evaluated.length}</div><div class="meta">Have at least one rating</div></div></div></div>
      <div class="card"><div class="kpi"><div class="chip amber">${icon('trend')}</div><div><div class="label">Evaluations</div><div class="value">${vendors.reduce((sum, v) => sum + v.evaluationCount, 0)}</div><div class="meta">Total ratings recorded</div></div></div></div>
    </div>

    <div class="card">
      <form class="toolbar" id="evaluation-filters">
        <div class="search">${icon('search')}<input class="input" name="search" value="${esc(q.search || '')}" placeholder="Vendor name or code..." /></div>
        <select class="select" name="status">
          <option value="">All statuses</option>
          ${STATUS_OPTIONS.map((s) => `<option value="${s}" ${q.status === s ? 'selected' : ''}>${s}</option>`).join('')}
        </select>
        <button class="btn btn-sm" type="submit">${icon('filter')} Apply</button>
        <button class="btn btn-sm btn-ghost" type="button" data-reset>Reset</button>
      </form>
      <div class="table-wrap">
        ${vendors.length
          ? `<table class="tbl">
              <thead><tr><th>Vendor</th><th>Status</th><th class="num">Evaluations</th><th class="num">Delivery</th><th class="num">Quality</th><th class="num">Pricing</th><th class="num">Service</th><th>Overall</th><th>Last evaluated</th><th></th></tr></thead>
              <tbody>${vendors.map((v) => `<tr>
                <td><div class="strong">${esc(v.name)}</div><div class="small muted mono">${esc(v.code)}</div></td>
                <td>${statusBadge(String(v.status || '').toLowerCase())}</td>
                <td class="num">${v.evaluationCount}</td>
                <td class="num">${ratingCell(v.deliveryRating)}</td>
                <td class="num">${ratingCell(v.qualityRating)}</td>
                <td class="num">${ratingCell(v.pricingRating)}</td>
                <td class="num">${ratingCell(v.serviceRating)}</td>
                <td>${overallBadge(v.overall)}</td>
                <td class="small">${v.lastEvaluatedAt ? fmtDate(v.lastEvaluatedAt) : '\u2014'}</td>
                <td class="actions">
                  <button class="btn btn-sm btn-ghost" type="button" data-history="${v.id}" title="History">${icon('clock')}</button>
                  ${can('vendor.evaluate') ? `<button class="btn btn-sm btn-primary" type="button" data-evaluate="${v.id}">${icon('plus')} Evaluate</button>` : ''}
                </td>
              </tr>`).join('')}</tbody></table>`
          : emptyState(
              'No vendors found',
              'Vendors created in the vendor master appear here for performance evaluation.',
              '<a class="btn btn-sm" href="#/vendors">Go to Vendor Master</a>',
              'briefcase'
            )}
      </div>
      <div class="small muted" style="padding:10px 14px">Evaluations are append-only. Existing ratings cannot be edited or deleted, preserving the performance history.</div>
    </div>`;

  const form = document.getElementById('evaluation-filters');
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    navigate(withQuery('/vendor-evaluations', Object.fromEntries(new FormData(form).entries())));
  });
  form.querySelector('[data-reset]').addEventListener('click', () => navigate('/vendor-evaluations'));

  const openEvaluate = (vendor) => {
    const body = `<form id="evaluation-form" class="form-grid" autocomplete="off">
      <div class="field span-2">
        <label>Vendor</label>
        <div class="input" style="background:#f6f8fb;display:flex;align-items:center">${esc(vendor.name)} \u00b7 ${esc(vendor.code)}</div>
      </div>
      ${field({ label: 'Delivery Rating', name: 'deliveryRating', type: 'select', value: 3, options: RATING_OPTIONS, required: true, hint: 'Timeliness and completeness of deliveries' })}
      ${field({ label: 'Quality Rating', name: 'qualityRating', type: 'select', value: 3, options: RATING_OPTIONS, required: true, hint: 'Conformance to specification' })}
      ${field({ label: 'Pricing Rating', name: 'pricingRating', type: 'select', value: 3, options: RATING_OPTIONS, required: true, hint: 'Competitiveness and invoice accuracy' })}
      ${field({ label: 'Service Rating', name: 'serviceRating', type: 'select', value: 3, options: RATING_OPTIONS, required: true, hint: 'Responsiveness and support' })}
      ${field({ label: 'Comments', name: 'comments', type: 'textarea', value: '', span: true, placeholder: 'Optional notes on this evaluation' })}
    </form>`;

    const m = modal({
      title: 'New vendor evaluation',
      subtitle: 'Ratings are permanent once submitted',
      body,
      footer: `<button class="btn" data-cancel>Cancel</button>
               <button class="btn btn-primary" data-save>${icon('check')} Submit evaluation</button>`,
      size: 'wide',
    });

    m.el.querySelector('[data-cancel]').addEventListener('click', m.close);
    m.el.querySelector('[data-save]').addEventListener('click', async () => {
      const el = m.el.querySelector('#evaluation-form');
      const data = {
        deliveryRating: Number(el.deliveryRating.value),
        qualityRating: Number(el.qualityRating.value),
        pricingRating: Number(el.pricingRating.value),
        serviceRating: Number(el.serviceRating.value),
        comments: el.comments.value.trim(),
      };
      try {
        await api.post(`/api/procurement/vendor-evaluations/${vendor.id}`, data);
        toast('Evaluation recorded.');
        m.close();
        navigate('/vendor-evaluations');
      } catch (e) {
        toast(e.message || 'Unable to record the evaluation.', 'error');
      }
    });
  };

  const openHistory = async (vendor) => {
    let data;
    try {
      data = await api.get(`/api/procurement/vendor-evaluations/${vendor.id}/history`);
    } catch (e) {
      toast(e.message || 'Unable to load the evaluation history.', 'error');
      return;
    }
    const evaluations = data.evaluations || [];
    const m = modal({
      title: `Evaluation history`,
      subtitle: `${vendor.name} \u00b7 ${vendor.code}`,
      size: 'wide',
      body: evaluations.length
        ? `<div class="stack">${evaluations.map((e) => `
            <div class="card" style="margin:0">
              <div class="card-head">
                <div>
                  <h3>${overallBadge(((Number(e.deliveryRating) + Number(e.qualityRating) + Number(e.pricingRating) + Number(e.serviceRating)) / 4))}</h3>
                  <div class="sub">${esc(e.evaluatedByName || 'Unknown user')} \u00b7 ${fmtDate(e.evaluatedAt, true)}</div>
                </div>
              </div>
              <div class="card-body">
                <div class="grid grid-4">
                  <div><div class="small muted">Delivery</div><div>${ratingCell(e.deliveryRating)}</div></div>
                  <div><div class="small muted">Quality</div><div>${ratingCell(e.qualityRating)}</div></div>
                  <div><div class="small muted">Pricing</div><div>${ratingCell(e.pricingRating)}</div></div>
                  <div><div class="small muted">Service</div><div>${ratingCell(e.serviceRating)}</div></div>
                </div>
                ${e.comments ? `<div class="help-block mt-12">${esc(e.comments)}</div>` : ''}
              </div>
            </div>`).join('')}</div>`
        : emptyState('No evaluations yet', 'Record the first performance evaluation for this vendor.', '', 'clipboard'),
      footer: `<button class="btn" data-close-modal>Close</button>`,
    });
    m.el.querySelector('[data-close-modal]').addEventListener('click', m.close);
  };

  for (const btn of ctx.view.querySelectorAll('[data-evaluate]')) {
    btn.addEventListener('click', () => openEvaluate(vendors.find((v) => String(v.id) === btn.dataset.evaluate)));
  }
  for (const btn of ctx.view.querySelectorAll('[data-history]')) {
    btn.addEventListener('click', () => openHistory(vendors.find((v) => String(v.id) === btn.dataset.history)));
  }
}

export function renderList(ctx) {
  return render(ctx);
}
