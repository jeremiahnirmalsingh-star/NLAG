import { api } from '../api.js';
import { esc, icon, num, money, fmtDate, statusBadge, emptyState } from '../ui.js';

const STATUS_LABELS = {
  PENDING: 'Pending',
  FORWARDED: 'Forwarded',
  ASSIGNED: 'Assigned',
  REJECTED: 'Rejected',
  COMPLETED: 'Completed',
};

function bookingBadge(status, forwardedAt) {
  const effective = status === 'PENDING' && forwardedAt ? 'FORWARDED' : status;
  return statusBadge(effective, STATUS_LABELS[effective] || status);
}

function expiryBadge(days) {
  if (days < 0) return '<span class="badge rejected">Expired</span>';
  if (days <= 30) return '<span class="badge pending">Due soon</span>';
  return '<span class="badge hold">Upcoming</span>';
}

const hoursText = (value) => (Number(value) || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });

const ATTENDANCE_LABELS = {
  PENDING: 'Pending Approval',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
};

export async function render(ctx) {
  ctx.view.innerHTML = '<div class="empty">Loading fleet dashboard…</div>';
  const data = await api.get('/api/fleet/dashboard');
  const counts = data.counts || {};
  const fleet = data.fleet || {};
  const upcoming = data.upcoming || [];
  const expiries = data.expiries || [];
  const attendance = data.attendance || {};
  const attendanceSummary = attendance.summary || {};
  const attendanceRows = (attendance.recent || []).map((row) => `
    <tr>
      <td>${esc(fmtDate(row.date))}</td>
      ${data.canManage ? `<td>${esc(row.driverName || '—')}</td>` : ''}
      <td>${esc(row.checkIn)} – ${esc(row.checkOut)}</td>
      <td class="num">${hoursText(row.hours)}</td>
      <td class="num">${row.extraHours > 0 ? `<span class="badge forwarded">+${hoursText(row.extraHours)}</span>` : '—'}</td>
      <td>${statusBadge(row.status, ATTENDANCE_LABELS[row.status] || row.status)}</td>
    </tr>`).join('');

  const upcomingRows = upcoming.map((trip) => `
    <tr>
      <td><a class="strong" href="#/fleet/bookings/${trip.id}">${esc(trip.bookingNo)}</a>${trip.isMine ? '<div class="small">Assigned to you</div>' : ''}</td>
      <td>${esc(trip.requesterName || '—')}</td>
      <td>${esc(trip.pickupName)} → ${esc(trip.dropName)}</td>
      <td>${esc(fmtDate(trip.startAt, true))}</td>
      <td>${esc(trip.vehicleRegNo || '—')}<div class="small muted">${esc(trip.driverName || '—')}</div></td>
      <td>${bookingBadge(trip.status, trip.forwardedAt)}</td>
    </tr>`).join('');

  const expiryRows = expiries.map((item) => `
    <tr>
      <td><a class="strong" href="#/fleet/masters?model=vehicles&amp;vehicleId=${item.id}">${esc(item.regNo)}</a></td>
      <td>${esc(item.label)}</td>
      <td>${esc(item.date)}</td>
      <td>${expiryBadge(item.days)}</td>
    </tr>`).join('');

  const statusRows = ['FORWARDED', 'ASSIGNED', 'COMPLETED', 'REJECTED'].map((status) => `
    <tr><td>${STATUS_LABELS[status]}</td><td class="num">${num(counts[status] || 0)}</td></tr>`).join('');

  const myTrips = upcoming.filter((trip) => trip.isMine);
  const myTripRows = myTrips.map((trip) => `
    <tr>
      <td><a class="strong" href="#/fleet/bookings/${trip.id}">${esc(trip.bookingNo)}</a></td>
      <td>${esc(trip.pickupName)} → ${esc(trip.dropName)}</td>
      <td>${esc(fmtDate(trip.startAt, true))}</td>
      <td>${esc(trip.vehicleRegNo || '—')}</td>
    </tr>`).join('');

  ctx.view.innerHTML = `
    <div class="page-head">
      <div><h1>Fleet Dashboard</h1><div class="sub">${data.canManage ? 'Booking allotments, vehicle readiness and document expiries' : 'Your assigned trips and fleet schedule'}</div></div>
      <div class="page-actions">
        <a class="btn" href="#/fleet">${icon('car')} Vehicle Bookings</a>
        ${data.canManage ? `<a class="btn" href="#/fleet/operations">${icon('chart')} Fleet Operations</a>` : ''}
        ${data.canManage ? `<a class="btn" href="#/fleet/masters">${icon('gear')} Fleet Masters</a>` : ''}
      </div>
    </div>

    <div class="grid grid-4">
      <div class="card"><div class="kpi"><div class="chip amber">${icon('send')}</div><div><div class="label">Awaiting allotment</div><div class="value">${num(counts.PENDING || 0)}</div><div class="meta">${num(counts.FORWARDED || 0)} forwarded to Transport</div></div></div></div>
      <div class="card"><div class="kpi"><div class="chip blue">${icon('car')}</div><div><div class="label">Assigned trips</div><div class="value">${num(counts.ASSIGNED || 0)}</div><div class="meta">${num(counts.COMPLETED || 0)} completed</div></div></div></div>
      <div class="card"><div class="kpi"><div class="chip teal">${icon('layers')}</div><div><div class="label">Vehicles ready</div><div class="value">${num(fleet.readyVehicles || 0)}</div><div class="meta">of ${num(fleet.vehicles || 0)} · ${num(fleet.inServiceVehicles || 0)} in service</div></div></div></div>
      <div class="card"><div class="kpi"><div class="chip purple">${icon('users')}</div><div><div class="label">Active drivers</div><div class="value">${num(fleet.drivers || 0)}</div><div class="meta">from the common employee master</div></div></div></div>
    </div>

    ${data.canManage && data.cost ? `<div class="alert alert-info mt-16">Fleet cost to date ${money(data.cost.totalExpenses)} over ${num(data.cost.distanceKm)} measured km · ${money(data.cost.costPerKm)} per km. ${num(data.cost.unallocatedTrips)} trip${data.cost.unallocatedTrips === 1 ? '' : 's'} still need km readings.</div>` : ''}

    <div class="card mt-16">
      <div class="card-head">
        <div><h3>Driver attendance &amp; extra hours</h3><div class="sub">Worked beyond ${hoursText(attendance.standardHours || 9)} hours per duty day · approved entries</div></div>
        <a class="btn btn-sm" href="#/fleet/attendance">${icon('clock')} Attendance register</a>
      </div>
      <div class="grid grid-4">
        <div class="kpi"><div class="chip blue">${icon('clock')}</div><div><div class="label">Hours worked</div><div class="value">${hoursText(attendanceSummary.hours)}</div><div class="meta">${hoursText(attendanceSummary.todayHours)} today</div></div></div>
        <div class="kpi"><div class="chip amber">${icon('trend')}</div><div><div class="label">Extra hours worked</div><div class="value">${hoursText(attendanceSummary.extraHours)}</div><div class="meta">+${hoursText(attendanceSummary.todayExtraHours)} today</div></div></div>
        <div class="kpi"><div class="chip teal">${icon('checkCircle')}</div><div><div class="label">Approved days</div><div class="value">${num(attendanceSummary.approvedRecords || 0)}</div><div class="meta">of ${num(attendanceSummary.records || 0)} recorded</div></div></div>
        <div class="kpi"><div class="chip purple">${icon('send')}</div><div><div class="label">Pending approval</div><div class="value">${num(attendanceSummary.pendingRecords || 0)}</div><div class="meta">self-entered attendance</div></div></div>
      </div>
      <div class="table-wrap"><table class="tbl">
        <thead><tr><th>Date</th>${data.canManage ? '<th>Driver</th>' : ''}<th>Duty time</th><th class="num">Worked</th><th class="num">Extra</th><th>Status</th></tr></thead>
        <tbody>${attendanceRows || `<tr><td colspan="${data.canManage ? 6 : 5}" class="small muted">No attendance recorded yet</td></tr>`}</tbody>
      </table></div>
    </div>

    <div class="grid grid-2 mt-16" style="align-items:start">
      <div class="card">
        <div class="card-head"><div><h3>Upcoming &amp; awaiting trips</h3><div class="sub">Next scheduled bookings and pending allotments</div></div></div>
        <div class="table-wrap"><table class="tbl">
          <thead><tr><th>Booking</th><th>Requester</th><th>Route</th><th>Start</th><th>Allotment</th><th>Status</th></tr></thead>
          <tbody>${upcomingRows || '<tr><td colspan="6" class="small muted">No upcoming trips</td></tr>'}</tbody>
        </table></div>
      </div>
      <div class="card">
        <div class="card-head"><div><h3>${data.canManage ? 'Vehicle document expiries' : 'Your assigned trips'}</h3><div class="sub">${data.canManage ? 'Registration, insurance, permit, tax and pollution' : 'Trips where you are the allotted driver'}</div></div></div>
        <div class="table-wrap"><table class="tbl">
          ${data.canManage
            ? '<thead><tr><th>Vehicle</th><th>Document</th><th>Expiry</th><th>Status</th></tr></thead>'
            : '<thead><tr><th>Booking</th><th>Route</th><th>Start</th><th>Vehicle</th></tr></thead>'}
          <tbody>${data.canManage
            ? (expiryRows || '<tr><td colspan="4" class="small muted">No document expiries in the next 90 days</td></tr>')
            : (myTripRows || '<tr><td colspan="4" class="small muted">No trips are currently allotted to you</td></tr>')}</tbody>
        </table></div>
      </div>
    </div>

    <div class="grid grid-2 mt-16" style="align-items:start">
      <div class="card">
        <div class="card-head"><div><h3>Booking register snapshot</h3></div></div>
        <div class="table-wrap"><table class="tbl"><thead><tr><th>Status</th><th class="num">Count</th></tr></thead><tbody>${statusRows}</tbody></table></div>
      </div>
      <div class="card">
        <div class="card-head"><div><h3>Fleet readiness</h3></div></div>
        <div class="form-section">
          <div class="detail-grid">
            <div><div class="label muted">Total vehicles</div><div>${num(fleet.vehicles || 0)}</div></div>
            <div><div class="label muted">Active vehicles</div><div>${num(fleet.activeVehicles || 0)}</div></div>
            <div><div class="label muted">Ready for allotment</div><div>${num(fleet.readyVehicles || 0)}</div></div>
            <div><div class="label muted">In service</div><div>${num(fleet.inServiceVehicles || 0)}</div></div>
            <div><div class="label muted">Active drivers</div><div>${num(fleet.drivers || 0)}</div></div>
            <div><div class="label muted">Completed trips</div><div>${num(counts.COMPLETED || 0)}</div></div>
          </div>
        </div>
      </div>
    </div>
  `;
}
