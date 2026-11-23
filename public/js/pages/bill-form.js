import { api } from '../api.js';
import { state, can, memberUnits } from '../state.js';
import { navigate, reloadPage } from '../router.js';
import { openQuickAdd } from '../quick-add.js';
import {
  esc, icon, money, todayInput, field, toast, fileSize, readFileAsBase64,
  ALLOWED_UPLOAD_EXT, MAX_UPLOAD_BYTES, roundRupee, roundOffAmount, roundOffControl,
  syncRoundOffInput, bindRoundOffControl,
} from '../ui.js';

export async function renderForm(ctx, options = {}) {
  const id = options.id ? Number(options.id) : null;
  let detail = null;
  if (id) {
    detail = await api.get(`/api/bills/${id}`);
    if (!['draft', 'returned', 'hold'].includes(detail.bill.status)) {
      toast('This bill can no longer be edited.', 'error');
      navigate(`/bills/${id}`, { replace: true });
      return;
    }
  }

  const bill = detail ? detail.bill : {};
  const existingAttachments = detail ? detail.attachments : [];
  const pendingFiles = [];
  let advances = [];
  let adjustments = {};
  if (detail) {
    for (const a of detail.adjustments) adjustments[a.advanceId] = a.amount;
  }

  /* Standard GST slabs. Any other rate can be entered via "Other rate". */
  const GST_SLABS = [
    { value: '0', label: '0% \u2014 Exempt' },
    { value: '5', label: '5%' },
    { value: '12', label: '12%' },
    { value: '18', label: '18%' },
    { value: '28', label: '28%' },
  ];
  const slabForRate = (rate) => (
    GST_SLABS.some((s) => Number(s.value) === Number(rate)) ? String(Number(rate)) : 'custom'
  );
  const rateField = ({ label, name, slabName, rate, hint }) => `
    <div class="field">
      <label>${esc(label)}</label>
      <div style="display:flex;gap:8px;align-items:center">
        <select class="select" name="${esc(slabName)}" style="max-width:150px">
          ${GST_SLABS.map((s) => `<option value="${s.value}" ${slabForRate(rate) === s.value ? 'selected' : ''}>${esc(s.label)}</option>`).join('')}
          <option value="custom" ${slabForRate(rate) === 'custom' ? 'selected' : ''}>Other rate\u2026</option>
        </select>
        <input class="input" type="number" name="${esc(name)}" value="${esc(rate)}" step="0.01" min="0" max="100" placeholder="0.00" style="flex:1" />
      </div>
      <div class="hint">${hint}</div>
    </div>`;
  const defaultGstRate = Number(state.settings.defaultGstRate ?? 18);
  const defaultTransportGstRate = Number(state.settings.defaultTransportGstRate ?? 18);
  const initialTransportGstRate = bill.transportGstRate ?? defaultTransportGstRate;
  const initialLines = (Array.isArray(bill.taxLines) && bill.taxLines.length)
    ? bill.taxLines.map((l) => ({
        /* The server stores the derived taxable value for inclusive lines, so
           rebuild the originally entered gross from taxable + extracted tax. */
        amount: l.grossAmount ?? ((Number(l.taxableAmount) || 0) + (l.taxInclusive ? (Number(l.taxAmount) || 0) : 0)),
        rate: l.gstRate,
        taxInclusive: l.taxInclusive ?? bill.taxInclusive ?? false,
      }))
    : [{ amount: bill.invoiceAmount ?? '', rate: bill.gstRate ?? defaultGstRate, taxInclusive: bill.taxInclusive ?? false }];

  const taxLineRow = (line) => {
    const rate = line.rate === '' || line.rate === null || line.rate === undefined ? defaultGstRate : Number(line.rate);
    const slab = slabForRate(rate);
    const inclusive = line.taxInclusive ?? line.inclusive ?? false;
    return `<tr data-tax-line>
      <td><input class="input" type="number" data-line-amount value="${esc(line.amount === '' || line.amount === null || line.amount === undefined ? '' : Number(line.amount))}" step="0.01" min="0" placeholder="0.00" /></td>
      <td>
        <div style="display:flex;gap:6px;align-items:center">
          <select class="select" data-line-slab style="max-width:130px">
            ${GST_SLABS.map((s) => `<option value="${s.value}" ${slab === s.value ? 'selected' : ''}>${esc(s.label)}</option>`).join('')}
            <option value="custom" ${slab === 'custom' ? 'selected' : ''}>Other rate\u2026</option>
          </select>
          <input class="input" type="number" data-line-rate value="${esc(rate)}" step="0.01" min="0" max="100" placeholder="0.00" style="width:90px" />
        </div>
      </td>
      <td><label class="row" style="gap:6px;align-items:center"><input type="checkbox" data-line-incl ${inclusive ? 'checked' : ''} /> <span class="small">Incl.</span></label></td>
      <td class="num" data-line-tax>${money(0)}</td>
      <td class="num small" data-line-taxable>${money(0)}</td>
      <td class="actions"><button type="button" class="btn btn-sm btn-ghost" data-remove-tax-line title="Remove component">${icon('x')}</button></td>
    </tr>`;
  };

  const getLines = () => Array.from(form.querySelectorAll('[data-tax-line]')).map((row) => {
    const amountInput = row.querySelector('[data-line-amount]');
    const rateInput = row.querySelector('[data-line-rate]');
    const slabSelect = row.querySelector('[data-line-slab]');
    let rate = Math.max(Number(rateInput.value) || 0, 0);
    if (slabSelect && slabSelect.value !== 'custom') rate = Math.max(Number(slabSelect.value) || 0, 0);
    return {
      amount: Math.max(Number(amountInput.value) || 0, 0),
      rate,
      taxInclusive: !!row.querySelector('[data-line-incl]')?.checked,
    };
  });

  const renderTaxLines = (lines) => {
    const tbody = form.querySelector('[data-tax-lines]');
    tbody.innerHTML = lines.map((l) => taxLineRow(l)).join('');
    recalc();
  };

  const syncRowSlab = (slab) => {
    const row = slab.closest('[data-tax-line]');
    const rate = row.querySelector('[data-line-rate]');
    if (slab.value !== 'custom') rate.value = slab.value;
    rate.readOnly = slab.value !== 'custom';
  };

  const syncRowRate = (rate) => {
    const row = rate.closest('[data-tax-line]');
    const slab = row.querySelector('[data-line-slab]');
    const match = GST_SLABS.find((s) => Number(s.value) === Number(rate.value));
    if (match) slab.value = match.value;
  };

  const departmentOptions = [
    { value: '', label: '\u2014 Select department \u2014' },
    ...state.departments.filter((d) => d.active).map((d) => ({ value: d.id, label: d.name })),
  ];
  const categoryOptions = [{ value: '', label: '\u2014 Select category \u2014' }];
  const vendorOptions = [
    { value: '', label: '\u2014 Select vendor \u2014' },
  ];
  const vendorsRes = await api.get('/api/vendors?status=Active');
  for (const v of vendorsRes.vendors) {
    vendorOptions.push({ value: v.id, label: `${v.name} (${v.code})${v.outstandingAdvance ? ` \u00b7 Adv ${money(v.outstandingAdvance)}` : ''}` });
  }
  if (bill.vendorId && !vendorOptions.some((o) => String(o.value) === String(bill.vendorId))) {
    vendorOptions.push({ value: bill.vendorId, label: bill.vendorName });
  }

  ctx.view.innerHTML = `
    <div class="page-head">
      <div>
        <h1>${id ? 'Edit Bill' : 'New Bill Entry'}</h1>
        <div class="sub">${id ? esc(bill.billNo) : 'Register a vendor bill and route it for digital approval'}</div>
      </div>
      <div class="page-actions">
        <a class="btn" href="${id ? `#/bills/${id}` : '#/bills'}">${icon('arrowLeft')} Cancel</a>
        <button class="btn" data-save>${icon('check')} Save Draft</button>
        <button class="btn btn-primary" data-save-submit>${icon('send')} Save &amp; Submit</button>
      </div>
    </div>

    <div id="form-alert" class="alert alert-danger hidden"></div>
    ${detail && detail.bill.status === 'returned' ? `<div class="alert alert-warn">${icon('alert')}<div><b>This bill was returned for correction.</b> Review the approver remarks in the approval timeline, make the necessary changes and resubmit.</div></div>` : ''}
    ${detail && detail.bill.status === 'hold' ? `<div class="alert alert-info">${icon('info')}<div><b>A clarification was requested on this bill.</b> You may update the bill and resubmit, or respond from the bill detail page.</div></div>` : ''}

    <form id="bill-form" novalidate data-saved-round-off="${esc(bill.roundOff ?? '')}">
      <div class="grid grid-1-2" style="align-items:start">
        <div class="stack">
          <div class="card">
            <div class="card-head"><div><h3>Bill Details</h3><div class="sub">Vendor and invoice information</div></div></div>
            <div class="form-section">
              <div class="form-grid">
                ${field({ label: 'Entry Date', name: 'entryDate', type: 'date', value: todayInput(), required: true, attrs: `min="${todayInput()}" max="${todayInput()}" readonly`, hint: 'Entry date is always today.' })}
                ${field({ label: 'Priority', name: 'priority', type: 'select', value: bill.priority || 'Medium', options: [
                  { value: 'High', label: 'High' }, { value: 'Medium', label: 'Medium' }, { value: 'Low', label: 'Low' },
                ] })}
                ${field({ label: 'Department', name: 'departmentId', type: 'select', value: bill.departmentId || '', options: departmentOptions, required: true })}
                <div class="field">
                  <label>Category</label>
                  <select class="select" name="categoryId">
                    <option value="">\u2014 Select category \u2014</option>
                    ${state.categories.filter((c) => c.active && !c.parent_id).map((m) => {
                      const subs = state.categories.filter((c) => c.active && c.parent_id === m.id);
                      if (subs.length === 0) return `<option value="${m.id}" ${String(bill.categoryId || '') === String(m.id) ? 'selected' : ''}>${m.name}</option>`;
                      return `<optgroup label="${m.name}">${subs.map((sub) => `<option value="${sub.id}" ${String(bill.categoryId || '') === String(sub.id) ? 'selected' : ''}>${sub.name}</option>`).join('')}</optgroup>`;
                    }).join('')}
                  </select>
                  <div class="hint">Type a few letters to jump to a category. <button type="button" class="btn btn-sm btn-ghost" data-add-category>${icon('plus')} Add new</button></div>
                </div>
                <div class="field span-2">
                  <label>Vendor<span class="req">*</span></label>
                  <div class="row" style="gap:8px">
                    <select class="select" name="vendorId" required style="flex:1">
                      ${vendorOptions.map((o) => `<option value="${esc(o.value)}" ${String(bill.vendorId || '') === String(o.value) ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}
                    </select>
                    <button type="button" class="btn btn-sm" data-add-vendor>${icon('plus')} Add new</button>
                  </div>
                </div>
        ${field({ label: 'Unit', name: 'unitId', type: 'select', value: bill.unitId || state.currentUnitIds[0] || (state.user && state.user.unitId) || '', options: [{ value: '', label: '\u2014 Select unit \u2014' }, ...memberUnits().map((u) => ({ value: u.id, label: u.name }))], required: true })}
                ${field({ label: 'Bill Type', name: 'billType', type: 'select', value: bill.billType || 'credit', options: [
                  { value: 'credit', label: 'Credit Bill' },
                  { value: 'cash', label: 'Cash Bill' },
                ], hint: 'Cash bills settle imprest or reimburse expenses.' })}
                ${field({ label: 'Invoice Number', name: 'invoiceNumber', value: bill.invoiceNumber || '', required: true, placeholder: 'e.g. INV-1001', hint: 'Invoice numbers must be unique for the same vendor.' })}
                ${field({ label: 'Invoice Date', name: 'invoiceDate', type: 'date', value: bill.invoiceDate || todayInput(), required: true, attrs: `max="${todayInput()}"`, hint: "Future dates are not allowed." })}
                ${field({ label: 'Due Date', name: 'dueDate', type: 'date', value: bill.dueDate || '', hint: 'Optional. Cannot be before the invoice date.' })}
                <div class="form-section" style="grid-column:1/-1">
                  <div class="form-grid">
                    ${field({ label: 'Cash Settlement Type', name: 'cashSettlementType', type: 'select', value: bill.cashSettlementType || '', options: [
                      { value: '', label: '\u2014 Select \u2014' },
                      { value: 'imprest', label: 'Imprest settlement' },
                      { value: 'reimbursement', label: 'Reimbursement' },
                    ], hint: 'For cash bills only.' })}
                    ${field({ label: 'Imprest / Reference No.', name: 'imprestReference', value: bill.imprestReference || '', placeholder: 'e.g. IMP-2026-001' })}
                  </div>
                </div>
                
                </div>
              </div>
            </div>
            <div class="form-section">
              <div class="form-grid">
                ${field({ label: 'Particulars', name: 'particulars', value: bill.particulars || '', placeholder: 'Short description of the expense', required: true, span: true })}
                ${field({ label: 'Description', name: 'description', type: 'textarea', value: bill.description || '', placeholder: 'Detailed description, purpose and context', span: true })}
                ${field({ label: 'Budget Head (optional)', name: 'budgetHead', value: bill.budgetHead || '' })}
                ${field({ label: 'Cost Center (optional)', name: 'costCenter', value: bill.costCenter || '' })}
              </div>
            </div>
          </div>

          <div class="card">
            <div class="card-head"><div><h3>Tax &amp; Transport</h3><div class="sub">GST and direct discounts are calculated automatically from the entered components</div></div></div>
            <div class="form-section">
              <div class="form-grid">
                ${field({ label: 'GST Type', name: 'gstType', type: 'select', value: bill.gstType || 'cgst_sgst', options: [
                  { value: 'cgst_sgst', label: 'GST \u2014 CGST + SGST' },
                  { value: 'igst', label: 'GST \u2014 IGST (inter-state)' },
                  { value: 'non_gst', label: 'Non-GST' },
                ], hint: 'Tax treatment shown on the vendor invoice. Applies to every component below.' })}
                <div class="field">
                  <label>Price basis</label>
                  <label class="row" style="gap:8px;align-items:center;margin-top:6px"><input type="checkbox" name="taxInclusive" ${bill.taxInclusive ? 'checked' : ''} /> Price includes tax</label>
                  <div class="hint">Sets every component below to inclusive; individual components can still be switched.</div>
                </div>
                ${field({ label: 'Discount %', name: 'discountPercent', type: 'number', value: bill.discountPercent ?? 0, attrs: 'min="0" max="100" step="0.01"', hint: 'Applied to the document value after tax.' })}
                ${field({ label: 'Discount amount', name: 'discountAmount', type: 'number', value: bill.discountAmount ?? 0, attrs: 'min="0" step="0.01"', hint: 'Added to the percentage discount, then capped at the document value.' })}
              </div>
            </div>
            <div class="form-section">
              <div class="row" style="justify-content:space-between;align-items:center;margin-bottom:8px">
                <div><b>Tax components</b><div class="small muted">Split the invoice across any number of GST rates (e.g. Rs.2,500 at 18% and Rs.500 at 5%). Tick Incl. when the entered amount already contains tax.</div></div>
                <button type="button" class="btn btn-sm" data-add-tax-line>${icon('plus')} Add component</button>
              </div>
              <div class="table-wrap">
                <table class="tbl" style="font-size:12.5px">
                  <thead><tr><th style="min-width:120px">Amount<br /><span class="small muted">gross when Incl.</span></th><th style="min-width:200px">GST Rate</th><th>Incl. tax</th><th class="num">Tax</th><th class="num">Derived taxable</th><th style="width:40px"></th></tr></thead>
                  <tbody data-tax-lines></tbody>
                  <tfoot><tr><td colspan="4" class="small muted">Taxable value (derived from inclusive amounts)</td><td class="num" data-alloc-total>${money(bill.invoiceAmount || 0)}</td><td></td></tr></tfoot>
                </table>
              </div>
            </div>
            <div class="form-section">
              <div class="form-grid">
                ${field({ label: 'CGST Amount', name: 'cgstAmount', type: 'number', value: bill.cgstAmount ?? 0, attrs: 'step="0.01" readonly', hint: 'Total CGST across all components.' })}
                ${field({ label: 'SGST Amount', name: 'sgstAmount', type: 'number', value: bill.sgstAmount ?? 0, attrs: 'step="0.01" readonly', hint: 'Total SGST across all components.' })}
                ${field({ label: 'IGST Amount', name: 'igstAmount', type: 'number', value: bill.igstAmount ?? 0, attrs: 'step="0.01" readonly', hint: 'Total IGST across all components.' })}
              </div>
            </div>
            <div class="form-section">
              <div class="form-grid">
                ${field({ label: 'Transport Type', name: 'transportType', type: 'select', value: bill.transportType || 'none', options: [
                  { value: 'none', label: 'No transport charge' },
                  { value: 'non_gst', label: 'Transport \u2014 Non-GST' },
                  { value: 'gst', label: 'Transport \u2014 GST' },
                ], hint: 'Freight or transport billed along with the supply.' })}
                ${field({ label: 'Transport Amount', name: 'transportAmount', type: 'number', value: bill.transportAmount ?? 0, attrs: 'step="0.01" min="0" placeholder="0.00"', hint: 'Basic transport charge.' })}
                ${rateField({ label: 'Transport GST Rate', name: 'transportGstRate', slabName: 'transportGstSlab', rate: initialTransportGstRate, hint: 'Applied only to GST transport. Choose a standard slab, or Other rate for a custom percentage.' })}
                ${field({ label: 'Transport GST Amount', name: 'transportTaxAmount', type: 'number', value: bill.transportTaxAmount ?? 0, attrs: 'step="0.01" readonly', hint: 'Auto-calculated.' })}
                <div class="field">
                  <label>Total Tax</label>
                  <div class="input" style="background:#f6f8fb;font-weight:700;display:flex;align-items:center" data-total-tax>${money((bill.cgstAmount || 0) + (bill.sgstAmount || 0) + (bill.igstAmount || 0) + (bill.transportTaxAmount || 0))}</div>
                  <div class="hint">CGST + SGST + IGST + transport GST.</div>
                </div>
                <div class="form-section">
                  <div class="form-grid">
                    ${field({ label: 'Invoice Amount (Total)', name: 'invoiceAmount', type: 'number', value: bill.invoiceAmount ?? '', required: true, attrs: 'step="0.01" min="0.01" placeholder="0.00" readonly', hint: 'Sum of the tax components above (auto-calculated).' })}
                    <div class="field">
                      <label>Net Amount</label>
                      <div class="input" style="background:#f6f8fb;font-weight:700;display:flex;align-items:center" data-net>${money(bill.netAmount || 0)}</div>
                      <div class="hint">Basic + tax + transport.</div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div class="card">
            <div class="card-head"><div><h3>Retention, Snag Hold &amp; Credit Note</h3><div class="sub">Deductions applied to the final amount payable to the vendor</div></div></div>
            <div class="form-section">
              <div class="form-grid">
                ${field({ label: 'Retention % (of basic value)', name: 'retentionPercentage', type: 'number', value: bill.retentionPercentage ?? 0, attrs: 'step="0.01" min="0" max="100" placeholder="0.00"', hint: 'Applied to the invoice amount before tax.' })}
                ${field({ label: 'Retention Amount', name: 'retentionAmount', type: 'number', value: bill.retentionAmount ?? 0, attrs: 'step="0.01" min="0" placeholder="0.00"', hint: 'Calculated from the percentage. Edit to enter a direct amount.' })}
                ${field({ label: 'Retention Released', name: 'retentionReleasedAmount', type: 'number', value: bill.retentionReleasedAmount ?? 0, attrs: 'step="0.01" min="0" placeholder="0.00"', hint: 'Amount released from retention.' })}
                ${field({ label: 'Retention Release Date', name: 'retentionReleaseDate', type: 'date', value: bill.retentionReleaseDate || '', attrs: `max="${todayInput()}"`, hint: "Optional — today's date is captured automatically." })}
                ${field({ label: 'Retention Release Remarks', name: 'retentionReleaseRemarks', value: bill.retentionReleaseRemarks || '', placeholder: 'e.g. Released after the defect-liability period', span: true })}
              </div>
            </div>
            <div class="form-section">
              <div class="form-grid">
                ${field({ label: 'Hold Amount (Pending Snag Works)', name: 'holdAmount', type: 'number', value: bill.holdAmount ?? 0, attrs: 'step="0.01" min="0" placeholder="0.00"', hint: 'Amount held back until snag works are completed.' })}
                ${field({ label: 'Hold Amount Released', name: 'holdReleasedAmount', type: 'number', value: bill.holdReleasedAmount ?? 0, attrs: 'step="0.01" min="0" placeholder="0.00"', hint: 'Amount released after snag works are completed.' })}
                ${field({ label: 'Hold Release Date', name: 'holdReleaseDate', type: 'date', value: bill.holdReleaseDate || '', attrs: `max="${todayInput()}"`, hint: "Optional — today's date is captured automatically." })}
                ${field({ label: 'Hold Release Remarks', name: 'holdReleaseRemarks', value: bill.holdReleaseRemarks || '', placeholder: 'e.g. Snag works completed and verified', span: true })}
              </div>
            </div>
            <div class="form-section">
              <div class="form-grid">
                ${field({ label: 'Credit Note Number', name: 'creditNoteNumber', value: bill.creditNoteNumber || '', placeholder: 'e.g. CN-2026-001' })}
                ${field({ label: 'Credit Note Date', name: 'creditNoteDate', type: 'date', value: bill.creditNoteDate || '' })}
                ${field({ label: 'Credit Note Amount', name: 'creditNoteAmount', type: 'number', value: bill.creditNoteAmount ?? 0, attrs: 'step="0.01" min="0" placeholder="0.00"', hint: 'Reduces the amount payable to the vendor.' })}
                ${field({ label: 'Credit Note Remarks', name: 'creditNoteRemarks', value: bill.creditNoteRemarks || '', placeholder: 'Reason for the credit note', span: true })}
              </div>
            </div>
          </div>

          <div class="card">
            <div class="card-head"><div><h3>Attachments</h3><div class="sub">Invoice copy and supporting documents</div></div>
              <div class="actions"><span class="badge-plain">PDF, JPG, PNG, DOCX, XLSX \u00b7 max 5 MB each</span></div>
            </div>
            <div class="card-body">
              <div class="dropzone" data-dropzone tabindex="0">
                ${icon('upload')}
                <div><b>Click to upload</b> or drag files here</div>
                <div class="small">Multiple attachments allowed</div>
              </div>
              <input type="file" id="bill-files" multiple hidden accept=".pdf,.jpg,.jpeg,.png,.docx,.xlsx" />
              <div class="file-list mt-12" data-attachments>
                ${existingAttachments
                  .map(
                    (a) => `<div class="file-item">
                      <div class="ficon">${icon('file')}</div>
                      <div style="min-width:0"><div class="fname">${esc(a.fileName)}</div>
                        <div class="fmeta">${esc(a.docType)} \u00b7 ${fileSize(a.size)} \u00b7 uploaded ${esc(a.uploadedAt.slice(0, 10))}</div></div>
                      <div class="factions">
                        <a class="btn btn-sm btn-ghost" href="${a.url}" target="_blank" rel="noopener" title="View">${icon('eye')}</a>
                        <button type="button" class="btn btn-sm btn-ghost" data-del-att="${a.id}" title="Remove">${icon('trash')}</button>
                      </div>
                    </div>`
                  )
                  .join('')}
              </div>
            </div>
          </div>
        </div>

        <div class="stack">
          <div class="card">
            <div class="card-head">
              <div><h3>Advance Adjustment</h3><div class="sub">Adjust available vendor advances against this bill</div></div>
              <div class="actions"><button type="button" class="btn btn-sm" data-auto-advance>Apply suggested</button></div>
            </div>
            <div class="card-body" data-advances>
              <div class="small muted">Select a vendor to see available advances.</div>
            </div>
          </div>

          <div class="card">
            <div class="card-head"><div><h3>Summary</h3><div class="sub">Amounts in ${esc(state.settings.currency)}</div></div></div>
            <div class="card-body">
              <dl class="dl compact">
                <dt data-row-gross>Gross (inclusive components)</dt><dd data-row-gross data-sum-gross class="right">${money(bill.invoiceAmount || 0)}</dd>
                <dt>Basic amount (taxable)</dt><dd data-sum-basic class="right">${money(bill.invoiceAmount || 0)}</dd>
                <dt>Discount</dt><dd data-sum-discount class="right">\u2014 ${money(0)}</dd>
                <dt data-row-cgst>CGST</dt><dd data-row-cgst data-sum-cgst class="right">${money(bill.cgstAmount || 0)}</dd>
                <dt data-row-sgst>SGST</dt><dd data-row-sgst data-sum-sgst class="right">${money(bill.sgstAmount || 0)}</dd>
                <dt data-row-igst>IGST</dt><dd data-row-igst data-sum-igst class="right">${money(bill.igstAmount || 0)}</dd>
                <dt data-row-transport>Transport charges</dt><dd data-row-transport data-sum-transport class="right">${money(bill.transportAmount || 0)}</dd>
                <dt data-row-transport-tax>Transport GST</dt><dd data-row-transport-tax data-sum-transport-tax class="right">${money(bill.transportTaxAmount || 0)}</dd>
                <dt>Total tax</dt><dd data-sum-tax class="right">${money(bill.taxAmount || 0)}</dd>
                <dt>Net before round off</dt><dd data-sum-base-net class="right">${money(bill.netAmount || 0)}</dd>
                <dt>Round off
                  <button type="button" class="btn btn-sm btn-ghost" data-round-off-auto style="margin-left:6px;padding:1px 6px">Auto</button>
                </dt>
                <dd class="right">
                  <input class="input" type="number" step="0.01" name="roundOff" data-round-off-input value="${esc(bill.roundOff ?? 0)}" style="width:110px;text-align:right" />
                  <div class="hint" style="text-align:right">Auto-filled; edit if required</div>
                </dd>
                <dt>Net amount (rounded)</dt><dd data-sum-net class="right fw-700">${money(bill.netAmount || 0)}</dd>
                <dt>Advance adjusted</dt><dd data-sum-adv class="right text-green">\u2014 ${money(0)}</dd>
                <dt>Retention withheld</dt><dd data-sum-retention class="right">\u2014 ${money(0)}</dd>
                <dt>Snag hold withheld</dt><dd data-sum-hold class="right">\u2014 ${money(0)}</dd>
                <dt>Credit note</dt><dd data-sum-credit class="right">\u2014 ${money(0)}</dd>
                <dt>Payable balance</dt><dd data-sum-payable class="right fw-700">${money(bill.payableAmount ?? bill.netAmount ?? 0)}</dd>
              </dl>
              <div class="help-block mt-12">
                ${detail ? `Editing bill <b>${esc(bill.billNo)}</b>. Duplicate invoice validation is enforced for the selected vendor.` : 'The bill number is generated automatically when you save.'}
              </div>
            </div>
          </div>
        </div>
      </div>
    </form>
  `;

  const form = document.getElementById('bill-form');
  const alertBox = document.getElementById('form-alert');
  const attachmentsBox = form.querySelector('[data-attachments]');

  const showError = (message, details) => {
    alertBox.innerHTML = `${icon('alert')}<div><b>${esc(message)}</b>${details ? `<div class="small">${esc(details)}</div>` : ''}</div>`;
    alertBox.classList.remove('hidden');
    alertBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  /* Amount summary */
  const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

  const computeAmounts = () => {
    const gstType = form.gstType.value;
    const nonGst = gstType === 'non_gst';
    const taxInclusive = !!form.taxInclusive?.checked;
    const rows = form.querySelectorAll('[data-tax-line]');
    const rowLines = Array.from(rows).map((row) => {
      const amountInput = row.querySelector('[data-line-amount]');
      const rateInput = row.querySelector('[data-line-rate]');
      const slabSelect = row.querySelector('[data-line-slab]');
      let rate = Math.max(Number(rateInput.value) || 0, 0);
      if (slabSelect && slabSelect.value !== 'custom') rate = Math.max(Number(slabSelect.value) || 0, 0);
      const amount = Math.max(Number(amountInput.value) || 0, 0);
      return {
        amount,
        rate: nonGst ? 0 : rate,
        taxInclusive: !nonGst && !!row.querySelector('[data-line-incl]')?.checked,
      };
    });
    let cgst = 0;
    let sgst = 0;
    let igst = 0;
    let basicTax = 0;
    const computedLines = rowLines.map((l) => {
      let taxable = l.amount;
      let c = 0;
      let s = 0;
      let i = 0;
      if (l.taxInclusive && l.rate > 0) {
        /* The entered amount already contains tax: extract the tax component. */
        taxable = round2(l.amount / (1 + l.rate / 100));
        const embedded = round2(l.amount - taxable);
        if (gstType === 'cgst_sgst') {
          c = round2(embedded / 2);
          s = round2(embedded - c);
        } else if (gstType === 'igst') {
          i = embedded;
        }
      } else if (gstType === 'cgst_sgst') {
        c = round2((l.amount * l.rate) / 200);
        s = round2((l.amount * l.rate) / 100 - c);
      } else if (gstType === 'igst') {
        i = round2((l.amount * l.rate) / 100);
      }
      const t = round2(c + s + i);
      cgst = round2(cgst + c);
      sgst = round2(sgst + s);
      igst = round2(igst + i);
      basicTax = round2(basicTax + t);
      return {
        amount: l.amount, taxable, rate: l.rate, taxInclusive: l.taxInclusive,
        cgst: c, sgst: s, igst: i, tax: t,
      };
    });
    rows.forEach((row, i) => {
      const line = computedLines[i];
      const taxCell = row.querySelector('[data-line-tax]');
      if (taxCell && line) taxCell.textContent = money(line.tax);
      const taxableCell = row.querySelector('[data-line-taxable]');
      if (taxableCell && line) taxableCell.textContent = money(line.taxable);
    });
    const basic = round2(computedLines.reduce((sum, l) => sum + l.taxable, 0));
    const grossBasic = round2(computedLines.reduce((sum, l) => sum + l.amount, 0));
    const documentGross = round2(basic + basicTax);
    const transportType = form.transportType.value;
    const transportAmount = transportType === 'none'
      ? 0
      : Math.max(Number(form.transportAmount.value) || 0, 0);
    const transportGstRate = Math.max(Number(form.transportGstRate.value) || 0, 0);
    const transportTax = transportType === 'gst'
      ? round2((transportAmount * transportGstRate) / 100)
      : 0;
    /* Match the server: the header discount is applied to the full gross
       payable (components + tax + transport) and capped at that value. */
    const grossPayable = round2(documentGross + transportAmount + transportTax);
    const discountPercent = Math.max(Number(form.discountPercent?.value) || 0, 0);
    const flatDiscount = Math.max(Number(form.discountAmount?.value) || 0, 0);
    const discount = round2(Math.min(
      grossPayable,
      round2((grossPayable * Math.min(discountPercent, 100)) / 100) + flatDiscount
    ));
    const allocTotal = form.querySelector('[data-alloc-total]');
    if (allocTotal) allocTotal.textContent = money(basic);
    form.invoiceAmount.value = basic.toFixed(2);

    const tax = round2(basicTax + transportTax);
    const baseNet = round2(grossPayable - discount);
    const roundOff = syncRoundOffInput(
      form.querySelector('[name="roundOff"]'), baseNet, form.dataset.savedRoundOff
    );
    /* The final rounded amount is what the bill stores and pays against. */
    const net = round2(baseNet + roundOff);
    const gstRate = basic > 0 ? round2((basicTax / basic) * 100) : 0;
    return {
      basic, grossBasic, documentGross, grossPayable, discount, discountPercent, flatDiscount,
      taxInclusive, gstType, gstRate, cgst, sgst, igst,
      transportType, transportAmount, transportGstRate, transportTax, tax,
      baseNet, roundOff, net,
      lines: computedLines,
    };
  };

  const toggleField = (name, show) => {
    const el = form.querySelector(`[name="${name}"]`);
    if (el && el.closest('.field')) el.closest('.field').classList.toggle('hidden', !show);
  };
  const toggleRow = (key, show) => {
    form.querySelectorAll(`[data-row-${key}]`).forEach((el) => el.classList.toggle('hidden', !show));
  };

  const syncRateControl = (slabName, rateName) => {
    const slab = form[slabName];
    const rate = form[rateName];
    if (slab.value !== 'custom') rate.value = slab.value;
    rate.readOnly = slab.value !== 'custom';
  };

  const refreshRateControls = () => {
    const nonGst = form.gstType.value === 'non_gst';
    const gstTransport = form.transportType.value === 'gst';
    form.transportGstSlab.disabled = !gstTransport;
    form.transportGstRate.disabled = !gstTransport;
    form.querySelectorAll('[data-tax-line]').forEach((row) => {
      const slab = row.querySelector('[data-line-slab]');
      const rate = row.querySelector('[data-line-rate]');
      if (slab) slab.disabled = nonGst;
      if (rate) {
        rate.disabled = nonGst;
        rate.readOnly = !nonGst && slab && slab.value !== 'custom';
      }
      const incl = row.querySelector('[data-line-incl]');
      if (incl) incl.disabled = nonGst;
    });
    syncRateControl('transportGstSlab', 'transportGstRate');
  };

  const refreshBillTypeVisibility = () => {
    const isCash = form.billType.value === 'cash';
    const section = form.querySelector('[name="cashSettlementType"]')?.closest('.form-section');
    if (section) section.classList.toggle('hidden', !isCash);
  };
  const refreshTaxVisibility = () => {
    const gstType = form.gstType.value;
    const transportType = form.transportType.value;
    toggleField('cgstAmount', gstType === 'cgst_sgst');
    toggleField('sgstAmount', gstType === 'cgst_sgst');
    toggleField('igstAmount', gstType === 'igst');
    toggleField('transportGstRate', transportType === 'gst');
    refreshRateControls();
  };

  const recalc = () => {
    const a = computeAmounts();
    form.cgstAmount.value = a.cgst.toFixed(2);
    form.sgstAmount.value = a.sgst.toFixed(2);
    form.igstAmount.value = a.igst.toFixed(2);
    form.transportTaxAmount.value = a.transportTax.toFixed(2);

    form.querySelector('[data-net]').textContent = money(a.net);
    form.querySelector('[data-sum-base-net]').textContent = money(a.baseNet);
    form.querySelector('[data-sum-gross]').textContent = money(a.grossBasic);
    form.querySelector('[data-sum-discount]').textContent = `\u2014 ${money(a.discount)}`;
    form.querySelector('[data-sum-basic]').textContent = money(a.basic);
    form.querySelector('[data-sum-cgst]').textContent = money(a.cgst);
    form.querySelector('[data-sum-sgst]').textContent = money(a.sgst);
    form.querySelector('[data-sum-igst]').textContent = money(a.igst);
    form.querySelector('[data-sum-transport]').textContent = money(a.transportAmount);
    form.querySelector('[data-sum-transport-tax]').textContent = money(a.transportTax);
    form.querySelector('[data-sum-tax]').textContent = money(a.tax);
    form.querySelector('[data-total-tax]').textContent = money(a.tax);
    form.querySelector('[data-sum-net]').textContent = money(a.net);

    toggleRow('gross', a.lines.some((l) => l.taxInclusive));
    toggleRow('cgst', a.gstType === 'cgst_sgst');
    toggleRow('sgst', a.gstType === 'cgst_sgst');
    toggleRow('igst', a.gstType === 'igst');
    toggleRow('transport', a.transportType !== 'none' || a.transportAmount > 0);
    toggleRow('transport-tax', a.transportTax > 0);

    let adv = 0;
    form.querySelectorAll('[data-adv-input]').forEach((input) => {
      adv += Number(input.value) || 0;
    });
    adv = Math.round(adv * 100) / 100;

    const retention = Number(form.retentionAmount.value) || 0;
    const retentionReleased = Number(form.retentionReleasedAmount.value) || 0;
    const retentionWithheld = Math.max(retention - retentionReleased, 0);
    const hold = Number(form.holdAmount.value) || 0;
    const holdReleased = Number(form.holdReleasedAmount.value) || 0;
    const holdWithheld = Math.max(hold - holdReleased, 0);
    const credit = Number(form.creditNoteAmount.value) || 0;

    form.querySelector('[data-sum-adv]').textContent = `\u2014 ${money(adv)}`;
    form.querySelector('[data-sum-retention]').textContent = `\u2014 ${money(retentionWithheld)}`;
    form.querySelector('[data-sum-hold]').textContent = `\u2014 ${money(holdWithheld)}`;
    form.querySelector('[data-sum-credit]').textContent = `\u2014 ${money(credit)}`;
    const payable = Math.max(a.net - adv - retentionWithheld - holdWithheld - credit, 0);
    form.querySelector('[data-sum-payable]').textContent = money(payable);

    form.retentionAmount.max = a.basic.toFixed(2);
    form.retentionReleasedAmount.max = retention.toFixed(2);
    form.holdReleasedAmount.max = hold.toFixed(2);
    form.querySelectorAll('[data-adv-input]').forEach((input) => {
      const max = Number(input.max) || 0;
      if (Number(input.value) > max) input.value = max.toFixed(2);
    });
    return { ...a, adv };
  };

  bindRoundOffControl(form, recalc);

  form.taxInclusive?.addEventListener('change', () => {
    form.querySelectorAll('[data-line-incl]').forEach((box) => { box.checked = form.taxInclusive.checked; });
    recalc();
  });
  form.discountPercent?.addEventListener('input', recalc);
  form.discountAmount?.addEventListener('input', recalc);

  form.billType.addEventListener('change', () => {
    refreshBillTypeVisibility();
    recalc();
  });
  form.transportType.addEventListener('change', () => {
    refreshTaxVisibility();
    recalc();
  });

  /* Transport slab <-> rate sync. */
  form.transportGstSlab.addEventListener('change', () => {
    syncRateControl('transportGstSlab', 'transportGstRate');
    recalc();
  });
  form.transportGstRate.addEventListener('input', () => {
    const match = GST_SLABS.find((s) => Number(s.value) === Number(form.transportGstRate.value));
    if (match) form.transportGstSlab.value = match.value;
  });

  /* Tax component rows: add / remove / sync slab <-> rate. */
  form.addEventListener('click', (e) => {
    const removeBtn = e.target.closest('[data-remove-tax-line]');
    if (removeBtn) {
      const allRows = form.querySelectorAll('[data-tax-line]');
      if (allRows.length <= 1) return;
      removeBtn.closest('[data-tax-line]').remove();
      recalc();
      return;
    }
    if (e.target.closest('[data-add-tax-line]')) {
      const lines = getLines();
      lines.push({ amount: '', rate: defaultGstRate, taxInclusive: !!form.taxInclusive?.checked });
      renderTaxLines(lines);
      const last = form.querySelector('[data-tax-lines] tr:last-child [data-line-amount]');
      if (last) last.focus();
    }
  });

  form.addEventListener('change', (e) => {
    if (e.target.matches('[data-line-slab]')) {
      syncRowSlab(e.target);
      recalc();
    }
    if (e.target.matches('[data-line-incl]')) recalc();
  });

  form.addEventListener('input', (e) => {
    if (e.target.name === 'retentionReleasedAmount' && Number(form.retentionReleasedAmount.value) > 0 && !form.retentionReleaseDate.value) {
      form.retentionReleaseDate.value = todayInput();
    }
    if (e.target.name === 'holdReleasedAmount' && Number(form.holdReleasedAmount.value) > 0 && !form.holdReleaseDate.value) {
      form.holdReleaseDate.value = todayInput();
    }
    if (e.target.matches('[data-line-rate]')) syncRowRate(e.target);
    if (
      e.target.matches('[data-line-amount]') ||
      e.target.matches('[data-line-rate]') ||
      e.target.matches('[data-adv-input]') ||
      ['invoiceAmount', 'transportAmount', 'transportGstRate',
       'retentionAmount', 'retentionReleasedAmount',
       'holdAmount', 'holdReleasedAmount', 'creditNoteAmount'].includes(e.target.name)
    ) {
      recalc();
    }
  });

  form.retentionPercentage.addEventListener('input', () => {
    if (form.retentionPercentage.value === '') {
      recalc();
      return;
    }
    const invoice = Number(form.invoiceAmount.value) || 0;
    const percentage = Number(form.retentionPercentage.value) || 0;
    form.retentionAmount.value = (Math.round(invoice * percentage) / 100).toFixed(2);
    recalc();
  });

  form.addEventListener('input', (e) => {
    if (e.target.name === 'invoiceAmount' && Number(form.retentionPercentage.value) > 0) {
      const invoice = Number(form.invoiceAmount.value) || 0;
      const percentage = Number(form.retentionPercentage.value) || 0;
      form.retentionAmount.value = (Math.round(invoice * percentage) / 100).toFixed(2);
    }
    /* A release date is optional. Capture the current date as soon as a
       release amount is entered and no date has been chosen. */
    if (
      e.target.name === 'retentionReleasedAmount' &&
      Number(form.retentionReleasedAmount.value) > 0 &&
      !form.retentionReleaseDate.value
    ) {
      form.retentionReleaseDate.value = todayInput();
    }
    if (
      e.target.name === 'holdReleasedAmount' &&
      Number(form.holdReleasedAmount.value) > 0 &&
      !form.holdReleaseDate.value
    ) {
      form.holdReleaseDate.value = todayInput();
    }
    const recalculated = [
      'invoiceAmount', 'gstRate', 'transportAmount', 'transportGstRate',
      'retentionAmount', 'retentionReleasedAmount',
      'holdAmount', 'holdReleasedAmount', 'creditNoteAmount',
    ];
    if (recalculated.includes(e.target.name) || e.target.matches('[data-adv-input]')) recalc();
  });

  /* Attachment picker */
  const fileInput = document.getElementById('bill-files');
  const dropzone = form.querySelector('[data-dropzone]');
  const renderPending = () => {
    const html = pendingFiles
      .map(
        (f, i) => `<div class="upload-item">
          ${icon('file')}<span class="grow">${esc(f.name)}</span>
          <span class="small muted">${fileSize(f.size)}</span>
          <button type="button" class="btn btn-sm btn-ghost" data-remove-pending="${i}">${icon('x')}</button>
        </div>`
      )
      .join('');
    let box = form.querySelector('[data-pending-files]');
    if (!box) {
      box = document.createElement('div');
      box.setAttribute('data-pending-files', '');
      attachmentsBox.appendChild(box);
    }
    box.innerHTML = html;
    box.querySelectorAll('[data-remove-pending]').forEach((btn) => {
      btn.addEventListener('click', () => {
        pendingFiles.splice(Number(btn.dataset.removePending), 1);
        renderPending();
      });
    });
  };

  const addFiles = async (files) => {
    for (const file of files) {
      const ext = file.name.split('.').pop().toLowerCase();
      if (!ALLOWED_UPLOAD_EXT.includes(ext)) {
        toast(`${file.name}: file type not allowed.`, 'error');
        continue;
      }
      if (file.size > MAX_UPLOAD_BYTES) {
        toast(`${file.name}: exceeds the 5 MB limit.`, 'error');
        continue;
      }
      pendingFiles.push(await readFileAsBase64(file));
      renderPending();
    }
  };
  dropzone.addEventListener('click', () => fileInput.click());
  dropzone.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') fileInput.click(); });
  dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('drag'); });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag'));
  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('drag');
    addFiles(Array.from(e.dataTransfer.files || []));
  });
  fileInput.addEventListener('change', () => {
    addFiles(Array.from(fileInput.files || []));
    fileInput.value = '';
  });

  form.querySelectorAll('[data-del-att]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('Remove this attachment?')) return;
      try {
        await api.del(`/api/bills/${id}/attachments/${btn.dataset.delAtt}`);
        btn.closest('.file-item').remove();
        toast('Attachment removed.');
      } catch (e) {
        toast(e.message, 'error');
      }
    });
  });

  /* Advances */
  const advancesBox = form.querySelector('[data-advances]');
  const loadAdvances = async (vendorId) => {
    if (!vendorId) {
      advancesBox.innerHTML = '<div class="small muted">Select a vendor to see available advances.</div>';
      advances = [];
      recalc();
      return;
    }
    try {
      const res = await api.get(`/api/advances/available?vendorId=${vendorId}${id ? `&billId=${id}` : ''}`);
      advances = res.advances;
      if (!advances.length) {
        advancesBox.innerHTML = `<div class="small muted">No open advances are available for this vendor.</div>`;
        recalc();
        return;
      }
      advancesBox.innerHTML = `
        <div class="table-wrap">
          <table class="tbl" style="font-size:12.5px">
            <thead><tr><th>Advance</th><th class="num">Available</th><th class="num" style="width:130px">Adjust</th></tr></thead>
            <tbody>
              ${advances
                .map(
                  (a) => `<tr>
                    <td><b>${esc(a.advanceNo)}</b><div class="small muted">${esc(a.advanceDate)} \u00b7 ${esc(a.status)}</div></td>
                    <td class="num">${money(a.available)}</td>
                    <td class="num"><input class="input" type="number" step="0.01" min="0" max="${a.available}" value="${adjustments[a.id] !== undefined ? adjustments[a.id] : 0}" data-adv-input data-adv-id="${a.id}" style="height:34px;min-height:34px;text-align:right;padding:4px 8px" /></td>
                  </tr>`
                )
                .join('')}
            </tbody>
          </table>
        </div>
        <div class="small muted mt-8">Unused advance balances remain available for future bills.</div>`;
      recalc();
    } catch (e) {
      advancesBox.innerHTML = `<div class="small text-red">${esc(e.message)}</div>`;
    }
  };

  form.vendorId.addEventListener('change', () => {
    adjustments = {};
    loadAdvances(form.vendorId.value);
  });

  form.querySelector('[data-add-vendor]')?.addEventListener('click', () => {
    void openQuickAdd('vendor', form.vendorId);
  });

  form.querySelector('[data-add-category]')?.addEventListener('click', () => {
    void openQuickAdd('expenseCategory', form.categoryId);
  });

  form.querySelector('[data-auto-advance]').addEventListener('click', () => {
    const net = computeAmounts().net;
    let remaining = net;
    form.querySelectorAll('[data-adv-input]').forEach((input) => {
      if (remaining <= 0) { input.value = 0; return; }
      const available = Number(input.max) || 0;
      const take = Math.min(available, remaining);
      input.value = take.toFixed(2);
      remaining -= take;
    });
    recalc();
  });

  renderTaxLines(initialLines);
  refreshTaxVisibility();
  refreshBillTypeVisibility();
  if (bill.vendorId) await loadAdvances(bill.vendorId);
  else recalc();

  /* Save */
  const collect = () => {
    const a = computeAmounts();
    const data = {
      entryDate: form.entryDate.value,
      departmentId: form.departmentId.value,
      categoryId: form.categoryId.value,
      vendorId: form.vendorId.value,
      unitId: form.unitId.value,
      invoiceNumber: form.invoiceNumber.value.trim(),
      billType: form.billType.value,
      cashSettlementType: form.cashSettlementType.value,
      imprestReference: form.imprestReference.value.trim(),
      invoiceDate: form.invoiceDate.value,
      dueDate: form.dueDate ? form.dueDate.value : '',
      invoiceAmount: a.basic,
      gstType: a.gstType,
      gstRate: a.gstType === 'non_gst' ? 0 : a.gstRate,
      cgstAmount: a.cgst,
      sgstAmount: a.sgst,
      igstAmount: a.igst,
      taxInclusive: a.taxInclusive,
      discountPercent: a.discountPercent,
      discountAmount: a.flatDiscount,
      taxLines: a.lines.map((l) => ({
        label: '',
        /* For inclusive lines the entered amount is gross. The server expects
           it in `taxableAmount` and derives the taxable/tax components itself;
           `grossAmount`/`totalAmount` carry the same gross for future readers. */
        grossAmount: l.amount,
        taxableAmount: l.amount,
        taxRate: l.rate,
        gstRate: l.rate,
        taxInclusive: l.taxInclusive,
        taxAmount: l.tax,
        totalAmount: l.amount,
      })),
      transportType: a.transportType,
      transportAmount: a.transportAmount,
      transportGstRate: a.transportType === 'gst' ? a.transportGstRate : 0,
      transportTaxAmount: a.transportTax,
      taxAmount: a.tax,
      roundOff: a.roundOff,
      netAmount: a.net,
      particulars: form.particulars.value.trim(),
      description: form.description.value.trim(),
      budgetHead: form.budgetHead.value.trim(),
      costCenter: form.costCenter.value.trim(),
      priority: form.priority.value,
      retentionPercentage: Number(form.retentionPercentage.value) || 0,
      retentionAmount: form.retentionAmount.value === '' ? null : Number(form.retentionAmount.value) || 0,
      retentionReleasedAmount: Number(form.retentionReleasedAmount.value) || 0,
      retentionReleaseDate: (Number(form.retentionReleasedAmount.value) || 0) > 0
        ? (form.retentionReleaseDate.value || todayInput())
        : '',
      retentionReleaseRemarks: form.retentionReleaseRemarks.value.trim(),
      holdAmount: Number(form.holdAmount.value) || 0,
      holdReleasedAmount: Number(form.holdReleasedAmount.value) || 0,
      holdReleaseDate: (Number(form.holdReleasedAmount.value) || 0) > 0
        ? (form.holdReleaseDate.value || todayInput())
        : '',
      holdReleaseRemarks: form.holdReleaseRemarks.value.trim(),
      creditNoteNumber: form.creditNoteNumber.value.trim(),
      creditNoteDate: form.creditNoteDate.value,
      creditNoteAmount: Number(form.creditNoteAmount.value) || 0,
      creditNoteRemarks: form.creditNoteRemarks.value.trim(),
      attachments: pendingFiles,
      advanceAdjustments: Array.from(form.querySelectorAll('[data-adv-input]'))
        .map((input) => ({ advanceId: Number(input.dataset.advId), amount: Number(input.value) || 0 }))
        .filter((a) => a.amount > 0),
    };
    return data;
  };

  const validate = (data) => {
    if (!data.vendorId) return 'Please select a vendor.';
    if (!data.invoiceNumber) return 'Invoice number is required.';
    if (!data.invoiceDate) return 'Invoice date is required.';
    if (data.invoiceDate > todayInput()) return 'Invoice date cannot be in the future. Please enter today or an earlier date.';
    if (data.dueDate && data.dueDate < data.invoiceDate) return 'Due date cannot be before the invoice date.';
    if (data.retentionReleaseDate && data.retentionReleaseDate > todayInput()) {
      return 'Retention release date cannot be in the future.';
    }
    if (data.holdReleaseDate && data.holdReleaseDate > todayInput()) {
      return 'Hold release date cannot be in the future.';
    }
    if (!(data.invoiceAmount > 0)) return 'Invoice amount must be greater than zero.';
    if (data.discountPercent < 0 || data.discountPercent > 100) {
      return 'Discount percentage must be between 0 and 100.';
    }
    if (data.discountAmount < 0) return 'Discount amount cannot be negative.';
    if (!data.taxLines.length) return 'Add at least one tax component.';
    for (const line of data.taxLines) {
      if (!(line.taxableAmount >= 0)) return 'Tax component amounts cannot be negative.';
      if (line.gstRate < 0 || line.gstRate > 100) {
        return 'Tax component GST rate must be between 0 and 100.';
      }
    }
    if (data.gstRate < 0 || data.gstRate > 100) return 'GST rate must be between 0 and 100.';
    if (data.transportAmount < 0) return 'Transport amount cannot be negative.';
    if (data.transportType === 'gst' && (data.transportGstRate < 0 || data.transportGstRate > 100)) {
      return 'Transport GST rate must be between 0 and 100.';
    }
    if (!data.particulars) return 'Particulars are required.';
    if (!data.departmentId) return 'Please select a department.';
    if (data.retentionPercentage < 0 || data.retentionPercentage > 100) {
      return 'Retention percentage must be between 0 and 100.';
    }
    if (data.retentionAmount > data.invoiceAmount + 0.004) {
      return 'Retention amount cannot exceed the basic invoice amount.';
    }
    if (data.retentionReleasedAmount > data.retentionAmount + 0.004) {
      return 'Retention released cannot exceed the retention amount.';
    }
    if (data.holdReleasedAmount > data.holdAmount + 0.004) {
      return 'Hold released cannot exceed the hold amount.';
    }
    const net = data.netAmount;
    if (data.creditNoteAmount > net + 0.004) {
      return 'Credit note amount cannot exceed the net bill amount.';
    }
    const advanceTotal = data.advanceAdjustments.reduce((s, a) => s + a.amount, 0);
    const retentionWithheld = Math.max(data.retentionAmount - data.retentionReleasedAmount, 0);
    const holdWithheld = Math.max(data.holdAmount - data.holdReleasedAmount, 0);
    if (advanceTotal + retentionWithheld + holdWithheld + data.creditNoteAmount > net + 0.004) {
      return 'Advance adjustment, retention, snag-work hold and credit note together cannot exceed the net bill amount.';
    }
    return null;
  };

  const persist = async (submitAfter) => {
    alertBox.classList.add('hidden');
    const data = collect();
    const error = validate(data);
    if (error) {
      showError(error);
      return;
    }
    const buttons = ctx.view.querySelectorAll('[data-save], [data-save-submit]');
    buttons.forEach((btn) => { btn.disabled = true; });
    try {
      let billId = id;
      if (id) await api.put(`/api/bills/${id}`, data);
      else {
        const created = await api.post('/api/bills', data);
        billId = created.id;
      }
      if (submitAfter) {
        await api.post(`/api/bills/${billId}/submit`);
        toast('Bill submitted for approval.');
      } else {
        toast('Draft saved.');
      }
      navigate(`/bills/${billId}`, { replace: true });
    } catch (e) {
      showError(e.message, e.details && e.details.duplicateOf ? `Already registered as ${e.details.duplicateOf}.` : '');
      buttons.forEach((btn) => { btn.disabled = false; });
    }
  };

  ctx.view.querySelector('[data-save]').addEventListener('click', () => persist(false));
  ctx.view.querySelector('[data-save-submit]').addEventListener('click', () => persist(true));
  form.addEventListener('submit', (e) => e.preventDefault());

  void can;
  void reloadPage;

}
