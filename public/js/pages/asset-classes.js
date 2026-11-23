import { api } from '../api.js';
import { navigate } from '../router.js';
import { esc, icon, toast, field, statusBadge } from '../ui.js';
import { can } from '../state.js';
import { openQuickAdd } from '../quick-add.js';

const METHOD_LABEL = {
  straight_line: 'Straight line',
  written_down_value: 'Written-down value',
  not_depreciated: 'Not depreciated',
};
const CLASS_LABEL = { asset: 'Asset (capital)', expense: 'Expense' };
const YES_NO = [{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }];

function yn(v) {
  return v ? 'Yes' : 'No';
}

export async function renderList(ctx) {
  ctx.view.innerHTML = `<div class="empty">Loading asset classes\u2026</div>`;
  const res = await api.get('/api/procurement/asset-classes');
  const deptName = new Map((res.departments || []).map((d) => [String(d.id), d.name]));
  const rows = res.classes || [];

  ctx.view.innerHTML = `
    <div class="page-head">
      <div><h1>Asset Classes</h1><div class="sub">Default depreciation, warranty, AMC and serial rules inherited by every item in the class</div></div>
      ${can('item.manage') ? `<div class="page-actions"><button class="btn btn-primary" type="button" data-new-class>${icon('plus')} New asset class</button></div>` : ''}
    </div>
    <div class="card">
      <div class="table-wrap">
        ${rows.length
          ? `<table class="tbl">
              <thead><tr><th>Class</th><th>Classification</th><th>Depreciation</th><th class="num">Life (yrs)</th><th class="num">Warranty (mo)</th><th>AMC</th><th>Serial</th><th>Asset tag</th><th>Default department</th><th>Status</th><th></th></tr></thead>
              <tbody>${rows.map((c) => {
                const d = c.defaults;
                return `<tr>
                  <td><span class="strong">${esc(c.name)}</span>${c.parentName ? `<div class="small muted">${esc(c.parentName)}</div>` : ''}</td>
                  <td>${esc(CLASS_LABEL[d.expenseClassification] || d.expenseClassification)}</td>
                  <td class="small">${d.depreciationApplicable ? esc(METHOD_LABEL[d.depreciationMethod] || d.depreciationMethod) : 'Not applicable'}</td>
                  <td class="num">${d.depreciationApplicable ? esc(d.usefulLifeYears) : '\u2014'}</td>
                  <td class="num">${esc(d.warrantyMonths)}</td>
                  <td>${yn(d.amcApplicable)}</td>
                  <td>${yn(d.serialRequired)}</td>
                  <td>${yn(d.assetTagRequired)}</td>
                  <td class="small">${d.defaultDepartmentId ? esc(deptName.get(String(d.defaultDepartmentId)) || '\u2014') : '\u2014'}</td>
                  <td>${c.saved ? statusBadge('active', 'Configured') : statusBadge('draft', 'Built-in defaults')}</td>
                  <td class="actions"><a class="btn btn-sm btn-ghost" href="#/asset-classes/${c.id}">${icon('edit')}</a></td>
                </tr>`;
              }).join('')}</tbody>
            </table>`
          : '<div class="empty small" style="padding:24px">No asset classes yet. Use "New asset class" to add one, or create an asset-type category under Items.</div>'}
      </div>
      <div class="small muted" style="padding:10px 14px">Items can override any value on their own asset settings. Built-in defaults apply until a class is configured.</div>
    </div>`;

  ctx.view.querySelector('[data-new-class]')?.addEventListener('click', () => {
    void openQuickAdd('itemCategory', null, {
      context: { itemType: 'asset' },
      title: 'New asset class',
      submitLabel: 'Create class',
      successMessage: 'Asset class created. Set its defaults below.',
      onCreated(record) {
        if (record && record.id) navigate(`/asset-classes/${record.id}`);
      },
    });
  });
}

export async function renderForm(ctx, options = {}) {
  const id = Number(options.id);
  ctx.view.innerHTML = `<div class="empty">Loading asset class\u2026</div>`;
  const [detail, list] = await Promise.all([
    api.get(`/api/procurement/asset-classes/${id}`),
    api.get('/api/procurement/asset-classes'),
  ]);
  const cls = detail.class;
  const d = cls.defaults;
  const deptOptions = [
    { value: '', label: '\u2014 No default department \u2014' },
    ...(list.departments || []).map((x) => ({ value: x.id, label: x.name })),
  ];
  const yesNo = (v) => (v ? 'yes' : 'no');

  ctx.view.innerHTML = `
    <div class="page-head">
      <div><h1>${esc(cls.name)}</h1><div class="sub">${cls.parentName ? `${esc(cls.parentName)} \u00b7 ` : ''}Asset class defaults</div></div>
      <div class="page-actions">
        <a class="btn" href="#/asset-classes">${icon('arrowLeft')} Back</a>
        <button class="btn btn-primary" type="button" data-save>${icon('check')} Save defaults</button>
      </div>
    </div>
    <div id="class-alert" class="alert alert-danger hidden"></div>
    <form id="class-form">
      <div class="grid grid-2" style="align-items:start">
        <div class="stack">
          <div class="card">
            <div class="card-head"><div><h3>Classification</h3><div class="sub">How items in this class are accounted for</div></div></div>
            <div class="form-section"><div class="form-grid">
              ${field({ label: 'Expense classification', name: 'expenseClassification', type: 'select', value: d.expenseClassification, options: [
                { value: 'asset', label: 'Asset (capital)' }, { value: 'expense', label: 'Expense' },
              ] })}
              ${field({ label: 'Budget category', name: 'budgetCategory', value: d.budgetCategory || '', placeholder: 'e.g. Equipment & Maintenance' })}
              ${field({ label: 'Default department', name: 'defaultDepartmentId', type: 'select', value: d.defaultDepartmentId || '', options: deptOptions, span: true })}
            </div></div>
          </div>
          <div class="card">
            <div class="card-head"><div><h3>Depreciation</h3><div class="sub">Recorded for classification and reporting. ABMDAS does not post depreciation entries.</div></div></div>
            <div class="form-section"><div class="form-grid">
              ${field({ label: 'Depreciation applicable', name: 'depreciationApplicable', type: 'select', value: yesNo(d.depreciationApplicable), options: YES_NO })}
              ${field({ label: 'Depreciation method', name: 'depreciationMethod', type: 'select', value: d.depreciationMethod, options: Object.entries(METHOD_LABEL).map(([value, label]) => ({ value, label })) })}
              ${field({ label: 'Useful life (years)', name: 'usefulLifeYears', type: 'number', value: d.usefulLifeYears, attrs: 'min="1" max="50" step="1"' })}
            </div></div>
          </div>
        </div>
        <div class="stack">
          <div class="card">
            <div class="card-head"><div><h3>Warranty &amp; AMC</h3><div class="sub">Warranty expiry is calculated from the receipt date when assets are created</div></div></div>
            <div class="form-section"><div class="form-grid">
              ${field({ label: 'Warranty period (months)', name: 'warrantyMonths', type: 'number', value: d.warrantyMonths, attrs: 'min="0" max="240" step="1"' })}
              ${field({ label: 'AMC applicable', name: 'amcApplicable', type: 'select', value: yesNo(d.amcApplicable), options: YES_NO })}
            </div></div>
          </div>
          <div class="card">
            <div class="card-head"><div><h3>Identification</h3><div class="sub">Rules applied when assets are received</div></div></div>
            <div class="form-section"><div class="form-grid">
              ${field({ label: 'Serial number required', name: 'serialRequired', type: 'select', value: yesNo(d.serialRequired), options: YES_NO, hint: 'Goods receipts must record one serial per accepted unit.' })}
              ${field({ label: 'Asset tag required', name: 'assetTagRequired', type: 'select', value: yesNo(d.assetTagRequired), options: YES_NO, hint: 'Recorded on each asset. Labels are generated for every asset.' })}
            </div></div>
          </div>
        </div>
      </div>
    </form>`;

  const form = document.getElementById('class-form');
  const alertBox = document.getElementById('class-alert');
  const bool = (name) => form[name].value === 'yes';
  ctx.view.querySelector('[data-save]').addEventListener('click', async () => {
    alertBox.classList.add('hidden');
    const body = {
      expenseClassification: form.expenseClassification.value,
      budgetCategory: form.budgetCategory.value.trim(),
      defaultDepartmentId: form.defaultDepartmentId.value || null,
      depreciationApplicable: bool('depreciationApplicable'),
      depreciationMethod: form.depreciationMethod.value,
      usefulLifeYears: form.usefulLifeYears.value,
      warrantyMonths: form.warrantyMonths.value,
      amcApplicable: bool('amcApplicable'),
      serialRequired: bool('serialRequired'),
      assetTagRequired: bool('assetTagRequired'),
    };
    try {
      await api.put(`/api/procurement/asset-classes/${id}`, body);
      toast('Asset class defaults saved.');
      navigate('/asset-classes');
    } catch (e) {
      alertBox.innerHTML = `${icon('alert')} ${esc(e.message || 'Unable to save.')}`;
      alertBox.classList.remove('hidden');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  });
}
