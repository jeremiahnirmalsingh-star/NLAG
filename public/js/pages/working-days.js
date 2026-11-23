import { api } from '../api.js';
import { can } from '../state.js';
import {
  esc, icon, toast, field, serializeForm, emptyState, fmtDate, confirmDialog,
} from '../ui.js';

const TYPE_OPTIONS = [
  { value: 'HOLIDAY', label: 'Holiday' },
  { value: 'WORKING_SATURDAY', label: 'Working Saturday' },
];

/**
 * Shared working-day overrides used by Procurement, Fleet Desk and Bills.
 */
export async function render(ctx) {
  const canManage = can('org.manage');

  async function load() {
    ctx.view.innerHTML = `<div class="empty">Loading working days\u2026</div>`;

    let rows = [];
    try {
      const res = await api.get('/api/masters/working-days');
      rows = Array.isArray(res)
        ? res
        : ((res && (res.days || res.workingDays || res.working_days || res.items || res.data)) || []);
      rows = [...rows].sort((a, b) => String(dayDate(a)).localeCompare(String(dayDate(b))));
    } catch (err) {
      ctx.view.innerHTML = `<div class="card">${emptyState(
        'Unable to load working days',
        err?.message || 'Check your connection and try again.',
        '<button class="btn btn-sm" type="button" data-retry>Try again</button>',
        'alert'
      )}</div>`;
      ctx.view.querySelector('[data-retry]')?.addEventListener('click', () => { void load(); });
      toast(err?.message || 'Unable to load working days.', 'error');
      return;
    }

    const addCard = canManage
      ? `<div class="card">
          <div class="card-head"><div><h3>Add working-day date</h3>
            <div class="sub">Mark a holiday or a working Saturday</div>
          </div></div>
          <div class="form-section">
            <form id="working-day-form" class="form-grid" autocomplete="off">
              ${field({ label: 'Date', name: 'date', type: 'date', required: true })}
              ${field({
                label: 'Type',
                name: 'type',
                type: 'select',
                value: 'HOLIDAY',
                options: TYPE_OPTIONS,
                required: true,
              })}
              ${field({
                label: 'Title',
                name: 'title',
                value: '',
                required: true,
                placeholder: 'e.g. Independence Day',
                span: true,
              })}
              <div class="field span-2" style="display:flex;justify-content:flex-end">
                <button class="btn btn-primary" type="submit" data-add-day>${icon('plus')} Add date</button>
              </div>
            </form>
          </div>
        </div>`
      : '';

    ctx.view.innerHTML = `
      <div class="page-head">
        <div><h1>Working Days</h1>
          <div class="sub">Holidays and working Saturdays${canManage ? '' : ' \u00b7 view only'}</div>
        </div>
      </div>
      <div class="stack">
        <div class="card">
          <div class="card-head"><div><h3>Configured dates</h3>
            <div class="sub">${rows.length} date${rows.length === 1 ? '' : 's'} configured</div>
          </div></div>
          <div class="table-wrap">
            ${rows.length
              ? `<table class="tbl">
                  <thead><tr>
                    <th>Date</th><th>Type</th><th>Title</th>${canManage ? '<th></th>' : ''}
                  </tr></thead>
                  <tbody>${rows.map((row) => {
                    const id = rowField(row, 'id', 'id');
                    const date = dayDate(row);
                    const type = rowField(row, 'dayType', 'day_type')
                      || rowField(row, 'type', 'type')
                      || 'HOLIDAY';
                    const title = rowField(row, 'title', 'title') || rowField(row, 'description', 'description');
                    return `<tr>
                      <td class="strong">${fmtDate(date)}</td>
                      <td>${typeChip(type)}</td>
                      <td>${esc(title || '\u2014')}</td>
                      ${canManage && id
                        ? `<td class="actions"><button class="btn btn-sm btn-ghost" type="button"
                              data-delete-day="${esc(id)}" data-title="${esc(title || date)}"
                              title="Delete working-day date">${icon('trash')}</button></td>`
                        : ''}
                    </tr>`;
                  }).join('')}</tbody>
                </table>`
              : emptyState(
                'No working-day overrides',
                canManage
                  ? 'Add a holiday or working Saturday to start building the shared calendar.'
                  : 'No holidays or working Saturdays have been configured.',
                '',
                'calendar'
              )}
          </div>
        </div>
        ${addCard}
        <div class="card">
          <div class="card-body" style="display:flex;gap:12px;align-items:flex-start">
            <div class="chip blue">${icon('info')}</div>
            <div class="small muted">
              <b style="color:var(--text)">Shared calendar.</b>
              These dates are shared by Procurement, Fleet Desk and Bills, so date calculations and
              due-date reminders stay consistent across all three modules.
            </div>
          </div>
        </div>
        ${canManage ? '' : `<div class="card"><div class="card-body small muted">
          ${icon('lock')} Only users with organisation management access can change these dates.
        </div></div>`}
      </div>`;

    const form = document.getElementById('working-day-form');
    form?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const values = serializeForm(form);
      const payload = {
        date: String(values.date || '').trim(),
        type: String(values.type || 'HOLIDAY').trim(),
        title: String(values.title || '').trim(),
      };
      if (!payload.date || !payload.title) {
        toast('Date and title are required.', 'error');
        return;
      }

      const button = form.querySelector('[data-add-day]');
      button.disabled = true;
      try {
        await api.post('/api/masters/working-days', payload);
        toast('Working-day date added.');
        await load();
      } catch (err) {
        toast(err?.message || 'Unable to add the working-day date.', 'error');
        button.disabled = false;
      }
    });

    ctx.view.querySelectorAll('[data-delete-day]').forEach((button) => {
      button.addEventListener('click', async () => {
        const label = button.dataset.title || 'this date';
        const ok = await confirmDialog({
          title: 'Delete working-day date',
          message: `Delete "${label}" from the shared working-day calendar?`,
          confirmText: 'Delete',
          danger: true,
        });
        if (!ok) return;
        try {
          await api.del(`/api/masters/working-days/${encodeURIComponent(button.dataset.deleteDay)}`);
          toast('Working-day date deleted.');
          await load();
        } catch (err) {
          toast(err?.message || 'Unable to delete the working-day date.', 'error');
        }
      });
    });
  }

  await load();
}

function rowField(row, camel, snake) {
  if (!row) return '';
  const value = row[camel] !== undefined && row[camel] !== null ? row[camel] : row[snake];
  return value === undefined || value === null ? '' : String(value);
}

function dayDate(row) {
  return rowField(row, 'dayDate', 'day_date') || rowField(row, 'date', 'date');
}

function typeChip(type) {
  const key = String(type || '').toUpperCase();
  const label = key === 'WORKING_SATURDAY'
    ? 'Working Saturday'
    : (key === 'HOLIDAY' ? 'Holiday' : key);
  const tone = key === 'HOLIDAY' ? 'red' : 'blue';
  return `<span class="chip ${tone}">${esc(label || '\u2014')}</span>`;
}
