import { api } from '../api.js';
import { withQuery } from '../router.js';
import {
  esc, icon, toast, field, modal, confirmDialog, serializeForm, emptyState,
} from '../ui.js';

const money = (value) => `₹${Number(value || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
const num = (value) => Number(value || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const labelFor = (categories, value) => categories.find((c) => c.value === value)?.label || value;

const otherCost = (costs) => ['REPAIR', 'TYRE', 'TAX', 'OTHER']
  .reduce((sum, key) => sum + (Number(costs?.[key]) || 0), 0);

export async function renderOperations(ctx) {
  ctx.view.innerHTML = '<div class="empty">Loading fleet operations…</div>';
  const tab = ctx.route.query.tab || 'trips';
  const [meta, costs, expensesRes] = await Promise.all([
    api.get('/api/fleet/meta'),
    api.get('/api/fleet/trip-costs'),
    api.get('/api/fleet/expenses'),
  ]);

  const canManage = !!meta.permissions?.manageBookings;
  const categories = expensesRes.categories || [];
  const vehicles = expensesRes.vehicles || meta.vehicles || [];
  const expenses = expensesRes.expenses || [];
  const rows = costs.rows || [];
  const totals = costs.totals || {};
  const unallocated = costs.unallocated || [];
  const vehicleSummary = costs.vehicles || [];

  const tabs = [
    ['trips', 'Trips & cost'],
    ['expenses', 'Expenses'],
    ['summary', 'Vehicle summary'],
  ].map(([key, label]) => `
    <a class="btn btn-sm ${key === tab ? 'btn-primary' : ''}"
       href="#${withQuery('/fleet/operations', { tab: key })}">${label}</a>`).join('');

  let content = '';

  if (tab === 'expenses') {
    content = `
      <div class="alert alert-info">Expenses are recorded against a vehicle only. They are shared across that vehicle’s measured trips by kilometres run — no booking link is required.</div>
      <div class="card">
        <div class="card-head">
          <div><h3>Vehicle expenses</h3><div class="sub">${expenses.length} entry${expenses.length === 1 ? '' : 'ies'}</div></div>
          ${canManage ? `<button class="btn btn-sm btn-primary" data-add-expense>${icon('plus')} Add expense</button>` : ''}
        </div>
        ${expenses.length
          ? `<div class="table-wrap"><table class="table">
              <thead><tr><th>Date</th><th>Vehicle</th><th>Category</th><th>Details</th><th class="num">Odometer</th><th class="num">Amount</th>${canManage ? '<th></th>' : ''}</tr></thead>
              <tbody>${expenses.map((expense) => {
                const detail = [
                  expense.category === 'FUEL' && expense.quantity
                    ? `${num(expense.quantity)} L${expense.rate ? ` @ ${money(expense.rate)}` : ''}` : '',
                  expense.vendor,
                  expense.billNo ? `Bill ${expense.billNo}` : '',
                ].filter(Boolean).join(' · ');
                return `<tr>
                  <td>${esc(expense.date)}</td>
                  <td>${esc(expense.vehicleRegNo || '—')}</td>
                  <td>${esc(labelFor(categories, expense.category))}</td>
                  <td>${detail ? esc(detail) : '<span class="muted">—</span>'}</td>
                  <td class="num">${expense.odometerKm == null ? '—' : num(expense.odometerKm)}</td>
                  <td class="num"><b>${money(expense.amount)}</b></td>
                  ${canManage ? `<td class="actions">
                    <button class="btn btn-sm btn-ghost" data-edit-expense="${expense.id}" title="Edit">${icon('edit')}</button>
                    <button class="btn btn-sm btn-ghost" data-delete-expense="${expense.id}" title="Remove">${icon('trash')}</button>
                  </td>` : ''}
                </tr>`;
              }).join('')}</tbody>
            </table></div>`
          : emptyState('No vehicle expenses yet', 'Add fuel, driver charges, toll, service and other running costs here.', canManage ? '<button class="btn btn-sm btn-primary" data-add-expense>Add expense</button>' : '', 'card')}
      </div>`;
  } else if (tab === 'summary') {
    content = `
      <div class="card">
        <div class="card-head"><div><h3>Vehicle summary</h3><div class="sub">Lifetime apportionment across measured trips</div></div></div>
        ${vehicleSummary.length
          ? `<div class="table-wrap"><table class="table">
              <thead><tr><th>Vehicle</th><th class="num">Trips with km</th><th class="num">Km run</th><th class="num">Expenses</th><th class="num">Cost / km</th></tr></thead>
              <tbody>${vehicleSummary.map((v) => `<tr>
                <td><b>${esc(v.regNo)}</b><div class="small muted">${esc(v.model || '')}</div></td>
                <td class="num">${v.trips}</td>
                <td class="num">${num(v.distanceKm)}</td>
                <td class="num">${money(v.expenseTotal)}</td>
                <td class="num">${v.costPerKm ? money(v.costPerKm) : '—'}</td>
              </tr>`).join('')}</tbody>
            </table></div>`
          : emptyState('No vehicles yet', 'Add a vehicle in Fleet Masters first.', '', 'car')}
      </div>`;
  } else {
    content = `
      <div class="card" style="margin-bottom:12px">
        <div class="form-section">
          <div class="detail-grid">
            <div><div class="label muted">Measured trips</div><b>${totals.trips || 0}</b></div>
            <div><div class="label muted">Total km</div><b>${num(totals.distanceKm)}</b></div>
            <div><div class="label muted">Total apportioned cost</div><b>${money(totals.totalCost)}</b></div>
            <div><div class="label muted">Overall cost / km</div><b>${totals.costPerKm ? money(totals.costPerKm) : '—'}</b></div>
          </div>
        </div>
      </div>
      <div class="alert alert-info">For each vehicle, total expenses are divided by the kilometres recorded on its completed trips. Every trip receives its share of fuel, driver charges, toll, service and other costs.</div>
      <div class="card">
        <div class="card-head"><div><h3>Trip cost by booking</h3><div class="sub">Only completed trips with both km readings are apportioned</div></div></div>
        ${rows.length
          ? `<div class="table-wrap"><table class="table">
              <thead><tr>
                <th>Booking</th><th>Vehicle</th><th>Trip</th><th class="num">km</th>
                <th class="num">Fuel</th><th class="num">Driver</th><th class="num">Toll</th>
                <th class="num">Service</th><th class="num">Other</th>
                <th class="num">Total</th><th class="num">₹/km</th>${canManage ? '<th></th>' : ''}
              </tr></thead>
              <tbody>${rows.map((row) => `<tr>
                <td><a href="#/fleet/bookings/${row.id}"><b>${esc(row.bookingNo)}</b></a><div class="small muted">${esc(row.departmentName || '—')}</div></td>
                <td>${esc(row.vehicleRegNo || '—')}</td>
                <td>${esc(row.purpose || '—')}<div class="small muted">${esc(row.driverName || '—')}</div></td>
                <td class="num">${num(row.distanceKm)}</td>
                <td class="num">${money(row.costs.FUEL)}</td>
                <td class="num">${money(row.costs.DRIVER)}</td>
                <td class="num">${money(row.costs.TOLL)}</td>
                <td class="num">${money(row.costs.SERVICE)}</td>
                <td class="num">${money(otherCost(row.costs))}</td>
                <td class="num"><b>${money(row.totalCost)}</b></td>
                <td class="num">${money(row.costPerKm)}</td>
                ${canManage ? `<td class="actions"><button class="btn btn-sm btn-ghost" data-edit-km="${row.id}" title="Edit km readings">${icon('edit')}</button></td>` : ''}
              </tr>`).join('')}</tbody>
            </table></div>`
          : emptyState('No trip costs yet', 'Complete a trip and record its starting and closing km. Then add vehicle expenses to see the cost split.', '', 'car')}
      </div>
      ${unallocated.length ? `
        <div class="card">
          <div class="card-head"><div><h3>Not yet apportioned</h3><div class="sub">No km readings are available for these vehicles yet</div></div></div>
          <div class="table-wrap"><table class="table">
            <thead><tr><th>Date</th><th>Vehicle</th><th>Category</th><th class="num">Amount</th></tr></thead>
            <tbody>${unallocated.map((expense) => `<tr>
              <td>${esc(expense.date)}</td>
              <td>${esc(expense.vehicleRegNo || '—')}</td>
              <td>${esc(labelFor(categories, expense.category))}</td>
              <td class="num">${money(expense.amount)}</td>
            </tr>`).join('')}</tbody>
          </table></div>
        </div>` : ''}`;
  }

  ctx.view.innerHTML = `
    <div class="page-head">
      <div><h1>Fleet Operations</h1><div class="sub">Vehicle expenses and per-trip costs shared by kilometres used</div></div>
      <div class="page-actions"><a class="btn" href="#/fleet">${icon('arrowLeft')} Back to bookings</a></div>
    </div>
    <div class="page-actions" style="margin-bottom:12px">${tabs}</div>
    ${content}`;

  const refresh = () => renderOperations(ctx);

  /* ----------------------------- Expenses ---------------------------- */
  const openExpenseForm = (record) => {
    const today = new Date().toISOString().slice(0, 10);
    modal({
      title: `${record ? 'Edit' : 'Add'} vehicle expense`,
      size: 'wide',
      body: `<form id="fleet-expense-form"><div class="form-grid">
        ${field({
          label: 'Vehicle', name: 'vehicleId', type: 'select', required: true,
          value: record?.vehicleId || '',
          options: [{ value: '', label: '— Select vehicle —' }, ...vehicles.map((v) => ({ value: v.id, label: v.regNo }))],
        })}
        ${field({ label: 'Date', name: 'date', type: 'date', value: record?.date || today, required: true })}
        ${field({
          label: 'Category', name: 'category', type: 'select', required: true,
          value: record?.category || 'FUEL',
          options: categories.map((c) => ({ value: c.value, label: c.label })),
        })}
        ${field({ label: 'Amount (₹)', name: 'amount', type: 'number', value: record?.amount ?? '', required: true, attrs: 'min="0.01" step="0.01"' })}
        ${field({ label: 'Quantity / litres', name: 'quantity', type: 'number', value: record?.quantity ?? '', attrs: 'min="0" step="0.01"' })}
        ${field({ label: 'Rate per unit (₹)', name: 'rate', type: 'number', value: record?.rate ?? '', attrs: 'min="0" step="0.01"' })}
        ${field({ label: 'Vendor / garage / driver', name: 'vendor', value: record?.vendor || '', placeholder: 'e.g. Indian Oil, MG Road garage' })}
        ${field({ label: 'Bill / reference no.', name: 'billNo', value: record?.billNo || '' })}
        ${field({ label: 'Odometer (km)', name: 'odometerKm', type: 'number', value: record?.odometerKm ?? '', attrs: 'min="0" step="0.01"' })}
        ${field({ label: 'Remarks', name: 'remarks', type: 'textarea', span: true, value: record?.remarks || '', placeholder: 'Optional details' })}
      </div><div class="alert alert-danger hidden" data-err></div></form>`,
      footer: `<button class="btn" data-modal-close>Cancel</button><button class="btn btn-primary" data-save>Save expense</button>`,
      onMount(el, close) {
        el.querySelector('[data-save]').addEventListener('click', async () => {
          const err = el.querySelector('[data-err]');
          err.classList.add('hidden');
          const values = serializeForm(el.querySelector('#fleet-expense-form'));
          try {
            if (record) await api.put(`/api/fleet/expenses/${record.id}`, values);
            else await api.post('/api/fleet/expenses', values);
            close();
            toast('Expense saved.');
            await refresh();
          } catch (e) {
            err.textContent = e.message;
            err.classList.remove('hidden');
          }
        });
      },
    });
  };

  ctx.view.querySelector('[data-add-expense]')?.addEventListener('click', () => openExpenseForm(null));
  ctx.view.querySelectorAll('[data-edit-expense]').forEach((button) => {
    button.addEventListener('click', () => {
      const record = expenses.find((e) => e.id === Number(button.dataset.editExpense));
      if (record) openExpenseForm(record);
    });
  });
  ctx.view.querySelectorAll('[data-delete-expense]').forEach((button) => {
    button.addEventListener('click', async () => {
      const record = expenses.find((e) => e.id === Number(button.dataset.deleteExpense));
      if (!record) return;
      const ok = await confirmDialog({
        title: 'Remove expense',
        message: `Remove ${labelFor(categories, record.category)} of ${money(record.amount)} dated ${record.date}?`,
        confirmText: 'Remove',
        danger: true,
      });
      if (!ok) return;
      try {
        await api.del(`/api/fleet/expenses/${record.id}`);
        toast('Expense removed.');
        await refresh();
      } catch (e) {
        toast(e.message || 'Could not remove the expense.', 'error');
      }
    });
  });

  /* ------------------------------- km -------------------------------- */
  ctx.view.querySelectorAll('[data-edit-km]').forEach((button) => {
    button.addEventListener('click', () => {
      const row = rows.find((r) => r.id === Number(button.dataset.editKm));
      if (!row) return;
      modal({
        title: 'Edit km readings',
        subtitle: `${row.bookingNo} · ${row.vehicleRegNo}`,
        body: `<form id="fleet-km-form"><div class="form-grid">
          ${field({ label: 'Starting km', name: 'startKm', type: 'number', value: row.startKm, required: true, attrs: 'min="0" step="0.01"' })}
          ${field({ label: 'Closing km', name: 'endKm', type: 'number', value: row.endKm, required: true, attrs: 'min="0" step="0.01"' })}
        </div><div class="alert alert-danger hidden" data-err></div></form>`,
        footer: `<button class="btn" data-modal-close>Cancel</button><button class="btn btn-primary" data-save>Save readings</button>`,
        onMount(el, close) {
          el.querySelector('[data-save]').addEventListener('click', async () => {
            const err = el.querySelector('[data-err]');
            err.classList.add('hidden');
            const values = serializeForm(el.querySelector('#fleet-km-form'));
            const start = Number(values.startKm);
            const end = Number(values.endKm);
            if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
              err.textContent = 'Closing km must be a number not less than starting km.';
              err.classList.remove('hidden');
              return;
            }
            try {
              await api.patch(`/api/fleet/bookings/${row.id}`, { action: 'odometer', startKm: start, endKm: end });
              close();
              toast('Km readings saved. Costs recalculated.');
              await refresh();
            } catch (e) {
              err.textContent = e.message;
              err.classList.remove('hidden');
            }
          });
        },
      });
    });
  });
}
