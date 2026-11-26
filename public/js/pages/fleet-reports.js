import { api } from '../api.js';
import { navigate, withQuery } from '../router.js';
import { esc, icon, field, emptyState } from '../ui.js';

const money = (value) => `₹${Number(value || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
const num = (value) => Number(value || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const dateOnly = (value) => (value ? String(value).slice(0, 10) : '');
const labelFor = (categories, value) => categories.find((c) => c.value === value)?.label || value;

const REPORTS = [
  ['trip-cost', 'Trip & Cost'],
  ['expenses', 'Expense Register'],
  ['vehicles', 'Vehicle Summary'],
  ['bookings', 'Booking Register'],
  ['usage', 'Usage by Department / Driver'],
  ['pending', 'Pending & Unmeasured Trips'],
];

function groupUsage(rows, key) {
  const map = new Map();
  for (const row of rows) {
    const name = row[key] || '—';
    const entry = map.get(name) || { name, trips: 0, km: 0 };
    entry.trips += 1;
    entry.km += Number(row.distanceKm) || 0;
    map.set(name, entry);
  }
  return [...map.values()]
    .map((entry) => ({ ...entry, km: Number(entry.km.toFixed(2)) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function renderReports(ctx) {
  ctx.view.innerHTML = '<div class="empty">Loading fleet reports…</div>';
  const report = REPORTS.some(([key]) => key === ctx.route.query.report)
    ? ctx.route.query.report : 'trip-cost';
  const from = ctx.route.query.from || '';
  const to = ctx.route.query.to || '';
  const vehicleId = ctx.route.query.vehicle || '';

  const [costsRes, expensesRes, bookingsRes, meta] = await Promise.all([
    api.get('/api/fleet/trip-costs'),
    api.get('/api/fleet/expenses'),
    api.get('/api/fleet/bookings'),
    api.get('/api/fleet/meta'),
  ]);

  const categories = expensesRes.categories || [];
  const vehicles = expensesRes.vehicles || meta.vehicles || [];
  const inRange = (date) => {
    const day = dateOnly(date);
    if (!day) return report === 'pending';
    if (from && day < from) return false;
    if (to && day > to) return false;
    return true;
  };
  const vehicleMatch = (id) => !vehicleId || String(id || '') === String(vehicleId);
  const vehicleLabel = (id) => vehicles.find((v) => String(v.id) === String(id))?.regNo || '—';

  const costRows = (costsRes.rows || [])
    .filter((row) => vehicleMatch(row.vehicleId) && inRange(row.completedAt || row.startAt));
  const expenses = (expensesRes.expenses || [])
    .filter((row) => vehicleMatch(row.vehicleId) && inRange(row.date));
  const bookings = (bookingsRes.bookings || [])
    .filter((row) => vehicleMatch(row.vehicleId) && inRange(row.startAt));
  const vehicleSummary = (costsRes.vehicles || []).filter((row) => vehicleMatch(row.id));
  const pendingTrips = (costsRes.pendingTrips || []).filter((row) => vehicleMatch(row.vehicleId));
  const completed = bookings.filter((row) => row.status === 'COMPLETED' && row.distanceKm != null);
  const byDepartment = groupUsage(completed, 'departmentName');
  const byDriver = groupUsage(completed, 'driverName');

  const costTotal = costRows.reduce((sum, row) => sum + (Number(row.totalCost) || 0), 0);
  const expenseTotal = expenses.reduce((sum, row) => sum + (Number(row.amount) || 0), 0);
  const kmTotal = costRows.reduce((sum, row) => sum + (Number(row.distanceKm) || 0), 0);
  const dateLabel = from || to
    ? `${from || 'Beginning'} to ${to || 'Today'}`
    : 'All dates';

  let body = '';
  if (report === 'trip-cost') {
    body = `
      <table class="rp-table">
        <thead><tr>
          <th>Booking</th><th>Completed</th><th>Department</th><th>Vehicle</th><th>Driver</th>
          <th>Purpose</th><th class="num">km</th><th class="num">Fuel</th><th class="num">Driver</th>
          <th class="num">Toll</th><th class="num">Service</th><th class="num">Other</th>
          <th class="num">Total</th><th class="num">₹/km</th>
        </tr></thead>
        <tbody>${costRows.length ? costRows.map((row) => {
          const other = ['REPAIR', 'TYRE', 'TAX', 'OTHER'].reduce((sum, key) => sum + (Number(row.costs?.[key]) || 0), 0);
          return `<tr>
            <td><b>${esc(row.bookingNo)}</b></td>
            <td>${esc(dateOnly(row.completedAt))}</td>
            <td>${esc(row.departmentName || '—')}</td>
            <td>${esc(row.vehicleRegNo || '—')}</td>
            <td>${esc(row.driverName || '—')}</td>
            <td>${esc(row.purpose || '—')}</td>
            <td class="num">${num(row.distanceKm)}</td>
            <td class="num">${money(row.costs?.FUEL)}</td>
            <td class="num">${money(row.costs?.DRIVER)}</td>
            <td class="num">${money(row.costs?.TOLL)}</td>
            <td class="num">${money(row.costs?.SERVICE)}</td>
            <td class="num">${money(other)}</td>
            <td class="num"><b>${money(row.totalCost)}</b></td>
            <td class="num">${num(row.costPerKm)}</td>
          </tr>`;
        }).join('') : '<tr><td colspan="14" class="num">No measured trips in this period.</td></tr>'}</tbody>
        <tfoot><tr><th colspan="6">Total</th><th class="num">${num(kmTotal)}</th>
          <th colspan="5"></th><th class="num">${money(costTotal)}</th><th class="num">${kmTotal ? money(costTotal / kmTotal) : '—'}</th></tr></tfoot>
      </table>`;
  } else if (report === 'expenses') {
    body = `
      <table class="rp-table">
        <thead><tr><th>Date</th><th>Vehicle</th><th>Category</th><th class="num">Quantity</th>
          <th class="num">Rate</th><th>Vendor</th><th>Bill / ref</th><th class="num">Odometer</th><th class="num">Amount</th></tr></thead>
        <tbody>${expenses.length ? expenses.map((row) => `<tr>
          <td>${esc(row.date)}</td>
          <td>${esc(row.vehicleRegNo || '—')}</td>
          <td>${esc(labelFor(categories, row.category))}</td>
          <td class="num">${row.quantity == null ? '—' : num(row.quantity)}</td>
          <td class="num">${row.rate == null ? '—' : money(row.rate)}</td>
          <td>${esc(row.vendor || '—')}</td>
          <td>${esc(row.billNo || '—')}</td>
          <td class="num">${row.odometerKm == null ? '—' : num(row.odometerKm)}</td>
          <td class="num"><b>${money(row.amount)}</b></td>
        </tr>`).join('') : '<tr><td colspan="9">No vehicle expenses in this period.</td></tr>'}</tbody>
        <tfoot><tr><th colspan="8">Total</th><th class="num">${money(expenseTotal)}</th></tr></tfoot>
      </table>`;
  } else if (report === 'vehicles') {
    body = `
      <table class="rp-table">
        <thead><tr><th>Vehicle</th><th>Model</th><th class="num">Trips with km</th>
          <th class="num">Km run</th><th class="num">Expenses</th><th class="num">Cost / km</th></tr></thead>
        <tbody>${vehicleSummary.length ? vehicleSummary.map((row) => `<tr>
          <td><b>${esc(row.regNo)}</b></td><td>${esc(row.model || '—')}</td>
          <td class="num">${row.trips}</td><td class="num">${num(row.distanceKm)}</td>
          <td class="num">${money(row.expenseTotal)}</td>
          <td class="num">${row.costPerKm ? money(row.costPerKm) : '—'}</td>
        </tr>`).join('') : '<tr><td colspan="6">No vehicles yet.</td></tr>'}</tbody>
      </table>`;
  } else if (report === 'bookings') {
    body = `
      <table class="rp-table">
        <thead><tr><th>Booking</th><th>Requester</th><th>Department</th><th>Route</th>
          <th class="num">Persons</th><th>Vehicle</th><th>Driver</th><th>Status</th>
          <th>Start</th><th>End</th><th>Purpose</th></tr></thead>
        <tbody>${bookings.length ? bookings.map((row) => `<tr>
          <td><b>${esc(row.bookingNo)}</b></td>
          <td>${esc(row.requesterName || '—')}</td>
          <td>${esc(row.departmentName || '—')}</td>
          <td>${esc(row.pickupName || '—')} → ${esc(row.dropName || '—')}</td>
          <td class="num">${row.passengers}</td>
          <td>${esc(row.vehicleRegNo || '—')}</td>
          <td>${esc(row.driverName || '—')}</td>
          <td>${esc(row.status)}</td>
          <td>${esc(dateOnly(row.startAt))}</td>
          <td>${esc(dateOnly(row.endAt))}</td>
          <td>${esc(row.purpose || '—')}</td>
        </tr>`).join('') : '<tr><td colspan="11">No bookings in this period.</td></tr>'}</tbody>
      </table>`;
  } else if (report === 'usage') {
    const table = (title, rows) => `
      <div class="rp-section"><h3>${title}</h3>
        <table class="rp-table">
          <thead><tr><th>${title.replace(/^By /, '')}</th><th class="num">Completed trips</th><th class="num">Km</th></tr></thead>
          <tbody>${rows.length ? rows.map((row) => `<tr>
            <td>${esc(row.name)}</td><td class="num">${row.trips}</td><td class="num">${num(row.km)}</td>
          </tr>`).join('') : '<tr><td colspan="3">No completed measured trips in this period.</td></tr>'}</tbody>
          <tfoot><tr><th>Total</th><th class="num">${rows.reduce((s, r) => s + r.trips, 0)}</th>
            <th class="num">${num(rows.reduce((s, r) => s + r.km, 0))}</th></tr></tfoot>
        </table>
      </div>`;
    body = table('By department', byDepartment) + table('By driver (A–Z)', byDriver);
  } else {
    body = `
      <table class="rp-table">
        <thead><tr><th>Booking</th><th>Status</th><th>Vehicle</th><th>Department</th>
          <th>Driver</th><th>Purpose</th><th>Starting km</th><th>Closing km</th></tr></thead>
        <tbody>${pendingTrips.length ? pendingTrips.map((row) => `<tr>
          <td><b>${esc(row.bookingNo)}</b></td><td>${esc(row.status)}</td>
          <td>${esc(row.vehicleRegNo || '—')}</td><td>${esc(row.departmentName || '—')}</td>
          <td>${esc(row.driverName || '—')}</td><td>${esc(row.purpose || '—')}</td>
          <td class="num">${row.startKm == null ? '—' : num(row.startKm)}</td>
          <td class="num">${row.endKm == null ? '—' : num(row.endKm)}</td>
        </tr>`).join('') : '<tr><td colspan="8">No pending or unmeasured trips.</td></tr>'}</tbody>
      </table>`;
  }

  const tabs = REPORTS.map(([key, label]) => `
    <a class="btn btn-sm ${key === report ? 'btn-primary' : ''}"
       href="#${withQuery('/fleet/reports', { report: key, from, to, vehicle: vehicleId })}">${label}</a>`).join('');

  ctx.view.innerHTML = `
    <div class="page-head no-print">
      <div><h1>Fleet Reports</h1><div class="sub">A–Z fleet registers and cost reports</div></div>
      <div class="page-actions">
        <a class="btn" href="#/fleet">${icon('arrowLeft')} Back to bookings</a>
        <button class="btn btn-primary" data-print>${icon('file')} Print report</button>
      </div>
    </div>
    <div class="card no-print">
      <div class="form-section">
        <form id="fleet-report-filters" class="form-grid">
          ${field({ label: 'From date', name: 'from', type: 'date', value: from })}
          ${field({ label: 'To date', name: 'to', type: 'date', value: to })}
          ${field({
            label: 'Vehicle', name: 'vehicle', type: 'select', value: vehicleId,
            options: [
              { value: '', label: '— All vehicles —' },
              ...vehicles.map((v) => ({ value: v.id, label: v.regNo })),
            ],
          })}
        </form>
      </div>
    </div>
    <div class="page-actions no-print" style="margin-bottom:12px">${tabs}</div>
    <div class="print-report print-landscape">
      <div class="report-sheet">
        <div class="report-header">
          <div class="org">
            <h2>New Life Assembly of God Community</h2>
            <p>Fleet Desk · Vehicle booking and operating cost register</p>
          </div>
          <div class="report-meta">
            <div><b>Period</b><span>${esc(dateLabel)}</span></div>
            <div><b>Vehicle</b><span>${vehicleId ? esc(vehicleLabel(vehicleId)) : 'All vehicles'}</span></div>
            <div><b>Generated</b><span>${esc(new Date().toLocaleString('en-IN'))}</span></div>
          </div>
        </div>
        <div class="report-title">${esc(REPORTS.find(([key]) => key === report)[1])}</div>
        ${body}
        <div class="rp-section">
          <p class="small muted">Figures are derived from recorded trip km and vehicle expenses. Expenses are apportioned by kilometres run; trips without usable readings are listed separately as not yet apportioned.</p>
        </div>
      </div>
    </div>`;

  ctx.view.querySelector('[data-print]')?.addEventListener('click', () => window.print());
  ctx.view.querySelector('#fleet-report-filters')?.addEventListener('change', (event) => {
    const form = event.currentTarget;
    navigate(withQuery('/fleet/reports', {
      report,
      from: form.elements.from.value,
      to: form.elements.to.value,
      vehicle: form.elements.vehicle.value,
    }));
  });
}
