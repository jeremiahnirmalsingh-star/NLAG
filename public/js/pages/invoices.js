import { api } from '../api.js';
import { can } from '../state.js';
import { navigate, withQuery } from '../router.js';
import {
  esc, icon, money, num, statusBadge, emptyState, toast, field, modal, confirmDialog, actionDialog, fmtDate,
  roundRupee, roundOffAmount, roundOffControl, syncRoundOffInput, bindRoundOffControl,
} from '../ui.js';

const INVOICE_STATUS = {
  draft: 'Draft',
  validated: 'Validated',
  billed: 'Billed',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
};

const GST_LABEL = {
  cgst_sgst: 'CGST + SGST',
  igst: 'IGST',
  non_gst: 'Non-GST',
};

const PO_STATUS = {
  draft: 'Draft',
  issued: 'Issued',
  partially_received: 'Partially Received',
  received: 'Received',
  closed: 'Closed',
  cancelled: 'Cancelled',
};

function statusOf(status) {
  return statusBadge(status, INVOICE_STATUS[status] || status);
}

function todayInput() {
  const d = new Date();
  const offset = d.getTimezoneOffset();
  return new Date(d.getTime() - offset * 60000).toISOString().slice(0, 10);
}

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/* Mirrors the shared procurement tax rule: discounts before tax, with tax
 * extracted from the discounted price when the inclusive flag is set. */
function calcInvoiceLine(input) {
  const quantity = round2(input.quantity);
  const unitPrice = round2(input.unitPrice);
  const grossAmount = round2(quantity * unitPrice);
  const discountPercent = round2(input.discountPercent);
  const flatDiscount = round2(input.discountAmount);
  const discountAmount = round2(Math.min(grossAmount, round2((grossAmount * discountPercent) / 100) + flatDiscount));
  const discounted = round2(grossAmount - discountAmount);
  const taxRate = round2(input.taxRate);
  const taxInclusive = !!input.taxInclusive;
  let taxableAmount;
  let taxAmount;
  let totalAmount;
  if (taxInclusive) {
    taxableAmount = taxRate > 0 ? round2(discounted / (1 + taxRate / 100)) : discounted;
    taxAmount = round2(discounted - taxableAmount);
    totalAmount = discounted;
  } else {
    taxableAmount = discounted;
    taxAmount = round2((discounted * taxRate) / 100);
    totalAmount = round2(discounted + taxAmount);
  }
  return {
    quantity, unitPrice, grossAmount, discountPercent, discountAmount,
    taxableAmount, taxRate, taxInclusive, taxAmount, totalAmount,
  };
}

function calcInvoiceDocument(lines, headerDiscount = {}) {
  const taxable = round2(lines.reduce((sum, l) => sum + l.taxableAmount, 0));
  const lineTax = round2(lines.reduce((sum, l) => sum + l.taxAmount, 0));
  const lineDiscount = round2(lines.reduce((sum, l) => sum + l.discountAmount, 0));
  const gross = round2(lines.reduce((sum, l) => sum + l.totalAmount, 0));
  const pct = round2(headerDiscount.discountPercent);
  const flat = round2(headerDiscount.discountAmount);
  const discount = round2(Math.min(gross, round2((gross * pct) / 100) + flat));
  return {
    taxable, lineTax, lineDiscount, gross, discount,
    total: round2(gross - discount),
  };
}

/* Stored discount_amount is the APPLIED total (percent + flat). Invoice form
 * fields hold the flat portion only; recover it so the percentage is not
 * applied a second time when the PO basis is copied into a new invoice. */
function invoiceFlatDiscount(line) {
  if (line.flatDiscountAmount !== undefined && line.flatDiscountAmount !== null) {
    return Math.max(0, round2(Number(line.flatDiscountAmount) || 0));
  }
  const gross = round2((Number(line.quantity) || 0) * (Number(line.unitPrice) || 0));
  const percentAmount = round2((gross * (Number(line.discountPercent) || 0)) / 100);
  return Math.max(0, round2((Number(line.discountAmount) || 0) - percentAmount));
}

function invoiceHeaderFlatDiscount(invoice, items) {
  if (!invoice) return 0;
  const percent = Number(invoice.discountPercent) || 0;
  const gross = round2(items.reduce((sum, line) => sum + (Number(line.totalAmount) || 0), 0));
  const percentAmount = round2((gross * percent) / 100);
  return Math.max(0, round2((Number(invoice.discountAmount) || 0) - percentAmount));
}

function categoryOptions(categories) {
  return (categories || []).map((c) => ({ value: c.id, label: c.name }));
}

/* ================================================================== */
/* LIST                                                                */
/* ================================================================== */
export async function renderList(ctx) {
  const q = ctx.route.query || {};
  const params = new URLSearchParams();
  for (const key of ['search', 'status']) {
    if (q[key]) params.set(key, q[key]);
  }
  ctx.view.innerHTML = `<div class="empty">Loading procurement invoices\u2026</div>`;
  const [meta, res] = await Promise.all([
    api.get('/api/procurement/invoices/meta'),
    api.get(`/api/procurement/invoices?${params.toString()}`),
  ]);
  const rows = res.invoices || [];

  ctx.view.innerHTML = `
    <div class="page-head">
      <div><h1>Procurement Invoices</h1><div class="sub">Validate supplier invoices and raise the linked ABMDAS bill</div></div>
      <div class="page-actions">
        <a class="btn" href="#/purchase-orders">${icon('briefcase')} Purchase Orders</a>
        ${can('invoice.manage') ? `<a class="btn btn-primary" href="#/invoices/new">${icon('plus')} New Invoice</a>` : ''}
      </div>
    </div>

    <div class="card">
      <form class="toolbar" id="invoice-filters">
        <div class="search">${icon('search')}<input class="input" name="search" value="${esc(q.search || '')}" placeholder="Invoice number, supplier invoice, vendor or PO..." /></div>
        <select class="select" name="status">
          <option value="">All statuses</option>
          ${(meta.statuses || []).map((s) => `<option value="${esc(s.value)}" ${q.status === s.value ? 'selected' : ''}>${esc(INVOICE_STATUS[s.value] || s.label)}</option>`).join('')}
        </select>
        <button class="btn btn-sm" type="submit">${icon('filter')} Apply</button>
        <button class="btn btn-sm btn-ghost" type="button" data-reset>Reset</button>
      </form>
      <div class="table-wrap">
        ${rows.length
          ? `<table class="tbl">
              <thead><tr><th>Invoice</th><th>Supplier invoice</th><th>Purchase order</th><th>Vendor</th><th>Dates</th><th class="num">Net amount</th><th>ABMDAS bill</th><th>Status</th><th></th></tr></thead>
              <tbody>${rows.map((r) => `<tr>
                <td><a class="strong" href="#/invoices/${r.id}">${esc(r.invoiceNo)}</a>
                  <div class="small muted">${esc(r.unitName)}${r.departmentName ? ` \u00b7 ${esc(r.departmentName)}` : ''}</div></td>
                <td><span class="strong">${esc(r.supplierInvoiceNo)}</span>
                  <div class="small muted">${fmtDate(r.supplierInvoiceDate)}</div></td>
                <td class="small">${r.poId ? `<a href="#/purchase-orders/${r.poId}">${esc(r.poNo)}</a>` : '\u2014'}</td>
                <td>${esc(r.vendorName)}<div class="small muted mono">${esc(r.vendorCode)}</div></td>
                <td class="small">${r.dueDate ? `Due ${fmtDate(r.dueDate)}` : '\u2014'}<div class="small muted">${num(r.itemCount)} line${r.itemCount === 1 ? '' : 's'}</div></td>
                <td class="num">${money(r.netAmount)}<div class="small muted">tax ${money(r.taxAmount)}</div></td>
                <td class="small">${r.abmdasBillId ? `<a href="#/bills/${r.abmdasBillId}">${esc(r.abmdasBillNo)}</a>` : '<span class="muted">\u2014</span>'}</td>
                <td>${statusOf(r.status)}</td>
                <td class="actions"><a class="btn btn-sm btn-ghost" href="#/invoices/${r.id}">${icon('eye')}</a></td>
              </tr>`).join('')}</tbody></table>`
          : emptyState(
              'No procurement invoices found',
              'Record an invoice once goods have been received and the receipt posted.',
              can('invoice.manage') ? '<a class="btn btn-sm btn-primary" href="#/invoices/new">New Invoice</a>' : '',
              'file'
            )}
      </div>
      <div class="small muted" style="padding:10px 14px">Showing ${num(rows.length)} of ${num(res.total)} invoice${res.total === 1 ? '' : 's'}.</div>
    </div>`;

  const form = document.getElementById('invoice-filters');
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    navigate(withQuery('/invoices', Object.fromEntries(new FormData(form).entries())));
  });
  form.querySelector('[data-reset]').addEventListener('click', () => navigate('/invoices'));
}

/* ================================================================== */
/* INVOICE BASIS (preview of accepted quantities)                      */
/* ================================================================== */
async function loadBasis(meta, poId) {
  const poDetail = await api.get(`/api/procurement/purchase-orders/${poId}`);
  const po = poDetail.purchaseOrder;
  const receipts = (meta.grns || []).filter((g) => Number(g.poId) === Number(poId));
  const details = await Promise.all(
    receipts.map((g) => api.get(`/api/procurement/grns/${g.id}`).catch(() => null))
  );
  const accepted = new Map();
  for (const detail of details) {
    if (!detail) continue;
    for (const line of detail.items || []) {
      if (line.acceptedQuantity > 0) {
        const current = accepted.get(line.poItemId) || { qty: 0, grnItemId: null };
        current.qty = Math.round((current.qty + line.acceptedQuantity) * 100) / 100;
        if (!current.grnItemId && line.id) current.grnItemId = line.id;
        accepted.set(line.poItemId, current);
      }
    }
  }
  const lines = (poDetail.items || []).map((line) => {
    const received = accepted.get(line.id);
    const acceptedQty = received ? received.qty : 0;
    const remaining = Math.max(acceptedQty - (line.invoicedQuantity || 0), 0);
    const flatDiscount = invoiceFlatDiscount(line);
    return {
      ...line,
      discountAmount: flatDiscount,
      flatDiscountAmount: flatDiscount,
      appliedDiscountAmount: round2(line.discountAmount),
      grnItemId: received ? received.grnItemId : null,
      acceptedQuantity: acceptedQty,
      availableQuantity: Math.round(remaining * 100) / 100,
    };
  });
  return { po, receipts, lines };
}

/* ================================================================== */
/* FORM                                                                */
/* ================================================================== */
export async function renderForm(ctx, options = {}) {
  const id = options.id ? Number(options.id) : null;
  ctx.view.innerHTML = `<div class="empty">Loading procurement invoice\u2026</div>`;

  const meta = await api.get('/api/procurement/invoices/meta');
  let detail = null;
  let invoice = null;
  if (id) {
    detail = await api.get(`/api/procurement/invoices/${id}`);
    invoice = detail.invoice;
    if (invoice.status !== 'draft') throw new Error('Only draft procurement invoices can be edited.');
  }
  const existingItems = detail?.items || [];

  let purchaseOrders = meta.purchaseOrders || [];
  if (invoice && !purchaseOrders.some((p) => Number(p.id) === Number(invoice.poId))) {
    purchaseOrders = [
      {
        id: invoice.poId, poNo: invoice.poNo, status: 'issued', vendorName: invoice.vendorName, unitId: invoice.unitId,
      },
      ...purchaseOrders,
    ];
  }
  const presetPo = ctx.route.query?.poId ? Number(ctx.route.query.poId) : null;
  const selectedPoId = id ? invoice.poId : (presetPo || (purchaseOrders.length === 1 ? purchaseOrders[0].id : ''));

  const gstTypes = meta.gstTypes || Object.keys(GST_LABEL).map((value) => ({ value, label: GST_LABEL[value] }));
  const gstValue = invoice?.gstType || 'cgst_sgst';

  ctx.view.innerHTML = `
    <div class="page-head">
      <div><h1>${id ? `Edit ${esc(invoice.invoiceNo)}` : 'New Procurement Invoice'}</h1>
        <div class="sub">${id ? `${esc(invoice.supplierInvoiceNo)} \u00b7 ${esc(invoice.vendorName)}` : 'Invoices are built from accepted receipt quantities'}</div></div>
      <div class="page-actions">
        <a class="btn" href="${id ? `#/invoices/${id}` : '#/invoices'}">${icon('arrowLeft')} Cancel</a>
        <button class="btn btn-primary" type="button" data-save>${icon('check')} ${id ? 'Save changes' : 'Create invoice'}</button>
      </div>
    </div>
    <div id="invoice-alert" class="alert alert-danger hidden"></div>

    <form id="invoice-form" autocomplete="off" data-saved-round-off="${esc(detail?.invoice.roundOff ?? '')}">
      <div class="grid grid-2" style="align-items:start">
        <div class="stack">
          <div class="card">
            <div class="card-head"><div><h3>Invoice Details</h3><div class="sub">Supplier invoice and the purchase it relates to</div></div></div>
            <div class="form-section">
              <div class="form-grid">
                ${id
                  ? `<div class="field span-2"><label>Purchase order</label>
                      <div class="help-block"><b>${esc(invoice.poNo)}</b> \u00b7 ${esc(invoice.vendorName)}</div></div>`
                  : `<div class="field span-2"><label>Purchase order<span class="req">*</span></label>
                      <select class="select" name="poId" data-po>
                        <option value="">\u2014 Select purchase order \u2014</option>
                        ${purchaseOrders.map((p) => `<option value="${p.id}" ${String(p.id) === String(selectedPoId) ? 'selected' : ''}>${esc(p.poNo)} \u00b7 ${esc(p.vendorName)} \u00b7 ${PO_STATUS[p.status] || p.status}</option>`).join('')}
                      </select>
                      <div class="hint">Only issued or received purchase orders with posted receipts can be invoiced.</div>
                    </div>`}
                ${field({ label: 'Supplier invoice number', name: 'supplierInvoiceNo', required: true, value: invoice?.supplierInvoiceNo || '', placeholder: 'Invoice number printed by the vendor' })}
                ${field({ label: 'Supplier invoice date', name: 'supplierInvoiceDate', type: 'date', value: invoice?.supplierInvoiceDate || meta.today || todayInput() })}
                ${field({ label: 'Due date', name: 'dueDate', type: 'date', value: invoice?.dueDate || '' })}
                ${field({ label: 'GST type', name: 'gstType', type: 'select', value: gstValue, options: gstTypes.map((g) => ({ value: g.value, label: GST_LABEL[g.value] || g.label })) })}
                ${field({ label: 'Header discount %', name: 'discountPercent', type: 'number', value: invoice?.discountPercent ?? 0, attrs: 'min="0" max="100" step="0.01"' })}
                ${field({ label: 'Header discount amount', name: 'discountAmount', type: 'number', value: invoiceHeaderFlatDiscount(invoice, existingItems), attrs: 'min="0" step="0.01"' })}
                <div class="field span-2"><label>Goods receipt <span class="hint">Optional</span></label>
                  <select class="select" name="grnId" data-grn>
                    <option value="">\u2014 All posted receipts for this order \u2014</option>
                  </select>
                  <div class="hint">Choose a receipt to invoice only the quantities accepted on that receipt.</div>
                </div>
                ${field({ label: 'Remarks', name: 'remarks', type: 'textarea', value: invoice?.remarks || '', span: true })}
              </div>
            </div>
          </div>

          <div class="card">
            <div class="card-head"><div><h3>Invoice Lines</h3><div class="sub">Accepted receipt quantities available for invoicing</div></div></div>
            <div class="table-wrap" id="invoice-basis">
              <div class="empty small" style="padding:24px">Select a purchase order to preview the invoice basis.</div>
            </div>
            <div class="row" style="justify-content:flex-end;padding:10px 14px;border-top:1px solid var(--border)">
              <div style="text-align:right" class="small">
                <div class="row"><span class="muted">Taxable value</span><span data-inv-taxable>${money(0)}</span></div>
                <div class="row"><span class="muted">Discount</span><span data-inv-line-discount>${money(0)}</span></div>
                <div class="row"><span class="muted">Header discount</span><span data-inv-discount>${money(0)}</span></div>
                <div class="row"><span class="muted">Tax</span><span data-inv-tax>${money(0)}</span></div>
                <div class="row"><span class="muted">Net before round off</span><span data-inv-total>${money(0)}</span></div>
                ${roundOffControl({ value: detail?.invoice.roundOff ?? 0 })}
                <div class="row"><span class="muted">Net amount (rounded)</span><span class="strong" data-inv-final>${money(0)}</span></div>
              </div>
            </div>
            <div class="small muted" style="padding:10px 14px;border-top:1px solid var(--border)">
              Prices and taxes are prefilled from the purchase order and can be adjusted per line. Quantities remain capped by the accepted receipt balance; any draft invoices already raised reduce availability.
            </div>
          </div>
        </div>

        <div class="stack">
          <div class="card">
            <div class="card-head"><div><h3>How it works</h3></div></div>
            <div class="form-section">
              <div class="hint">
                Procurement invoices never bypass ABMDAS approval. Validating an invoice can create a linked draft ABMDAS bill;
                the normal ABMDAS workflow then remains the source of truth for approval and payment.
              </div>
              <div class="stack small mt-12">
                <div class="row"><span class="muted" style="width:120px">Step 1</span><span>Post a goods receipt</span></div>
                <div class="row"><span class="muted" style="width:120px">Step 2</span><span>Record the supplier invoice</span></div>
                <div class="row"><span class="muted" style="width:120px">Step 3</span><span>Validate and raise the draft bill</span></div>
              </div>
            </div>
          </div>
          <div class="card">
            <div class="card-head"><div><h3>Order Snapshot</h3><div class="sub">Populated when a purchase order is selected</div></div></div>
            <div class="form-section" id="invoice-po-info">
              <div class="hint">No purchase order selected.</div>
            </div>
          </div>
        </div>
      </div>
    </form>`;

  const form = document.getElementById('invoice-form');
  const alertBox = document.getElementById('invoice-alert');
  const basisBox = form.querySelector('#invoice-basis');
  const poInfo = form.querySelector('#invoice-po-info');
  const grnSelect = form.querySelector('[data-grn]');
  const poSelect = form.querySelector('[data-po]');

  const showError = (message) => {
    alertBox.innerHTML = `${icon('alert')} ${esc(message)}`;
    alertBox.classList.remove('hidden');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  let basis = null;
  let savedEdits = {};
  const editKey = (poItemId, grnItemId) => `${poItemId}:${grnItemId || ''}`;

  function readLineInputs(row) {
    const raw = {
      poItemId: row.dataset.poItem,
      grnItemId: row.dataset.grnItem || null,
      itemId: row.dataset.itemId || null,
      description: row.dataset.desc || '',
      uomId: row.dataset.uomId || null,
      quantity: row.querySelector('[data-qty]')?.value,
      unitPrice: row.querySelector('[data-price]')?.value,
      discountPercent: row.querySelector('[data-discpct]')?.value,
      discountAmount: row.querySelector('[data-disamt]')?.value,
      taxRate: row.querySelector('[data-tax]')?.value,
      taxInclusive: !!row.querySelector('[data-taxinc]')?.checked,
      max: row.dataset.max,
    };
    return { ...raw, ...calcInvoiceLine(raw) };
  }

  function captureEdits() {
    basisBox.querySelectorAll('[data-inv-line]').forEach((row) => {
      const line = readLineInputs(row);
      savedEdits[editKey(line.poItemId, line.grnItemId)] = {
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        discountPercent: line.discountPercent,
        discountAmount: line.discountAmount,
        taxRate: line.taxRate,
        taxInclusive: line.taxInclusive,
      };
    });
  }

  function readInvoiceLines(onlyPositive = false) {
    const lines = [];
    basisBox.querySelectorAll('[data-inv-line]').forEach((row) => {
      const line = readLineInputs(row);
      if (onlyPositive && !(Number(line.quantity) > 0)) return;
      lines.push(line);
    });
    return lines;
  }

  function recalcInvoiceForm() {
    const lines = readInvoiceLines();
    const doc = calcInvoiceDocument(lines, {
      discountPercent: form.discountPercent?.value,
      discountAmount: form.discountAmount?.value,
    });
    lines.forEach((line) => {
      const row = basisBox.querySelector(`[data-inv-line][data-po-item="${line.poItemId}"][data-grn-item="${line.grnItemId || ''}"]`);
      const set = (sel, value) => {
        const cell = row?.querySelector(sel);
        if (cell) cell.textContent = money(value);
      };
      set('[data-line-disc]', line.discountAmount);
      set('[data-line-taxable]', line.taxableAmount);
      set('[data-line-tax]', line.taxAmount);
      set('[data-line-total]', line.totalAmount);
    });
    const setDoc = (sel, value) => {
      const el = form.querySelector(sel);
      if (el) el.textContent = money(value);
    };
    setDoc('[data-inv-taxable]', doc.taxable);
    setDoc('[data-inv-line-discount]', doc.lineDiscount);
    setDoc('[data-inv-discount]', doc.discount);
    setDoc('[data-inv-tax]', doc.lineTax);
    const roundOff = syncRoundOffInput(
      form.querySelector('[name="roundOff"]'), doc.total, form.dataset.savedRoundOff
    );
    const finalTotal = round2(doc.total + roundOff);
    setDoc('[data-inv-total]', doc.total);
    setDoc('[data-inv-final]', finalTotal);
    return { ...doc, roundOff, final: finalTotal };
  }

  ['discountPercent','discountAmount'].forEach((n) => {
    form.querySelector(`[name="${n}"]`)?.addEventListener('input', () => recalcInvoiceForm());
  });
  basisBox.addEventListener('input', (e) => {
    if (e.target.closest('[data-inv-line]')) recalcInvoiceForm();
  });
  basisBox.addEventListener('change', (e) => {
    if (e.target.closest('[data-inv-line]')) recalcInvoiceForm();
  });
  bindRoundOffControl(form, recalcInvoiceForm);

  function renderBasis() {
    if (!basis) {
      basisBox.innerHTML = `<div class="empty small" style="padding:24px">Select a purchase order to preview the invoice basis.</div>`;
      recalcInvoiceForm();
      return;
    }
    const { po, receipts, lines } = basis;
    poInfo.innerHTML = `
      <div class="stack small">
        <div class="row"><span class="muted" style="width:120px">Purchase order</span><span><b>${esc(po.poNo)}</b></span></div>
        <div class="row"><span class="muted" style="width:120px">Vendor</span><span>${esc(po.vendorName)}</span></div>
        <div class="row"><span class="muted" style="width:120px">Order value</span><span>${money(po.totalAmount)}</span></div>
        <div class="row"><span class="muted" style="width:120px">Posted receipts</span><span>${num(receipts.length)}</span></div>
        <div class="row"><span class="muted" style="width:120px">Status</span><span>${PO_STATUS[po.status] || po.status}</span></div>
      </div>`;

    const grnValue = grnSelect.value;
    grnSelect.innerHTML = `<option value="">\u2014 All posted receipts for this order \u2014</option>${receipts
      .map((g) => `<option value="${g.id}" ${String(g.id) === String(grnValue) ? 'selected' : ''}>${esc(g.grnNo)} \u00b7 ${fmtDate(g.receivedDate)}</option>`)
      .join('')}`;

    if (!receipts.length) {
      basisBox.innerHTML = `<div class="empty small" style="padding:24px">${icon('alert')}No posted goods receipt exists for this order. Post a receipt before raising an invoice.</div>`;
      recalcInvoiceForm();
      return;
    }

    const rows = lines.filter((line) => line.acceptedQuantity > 0 || line.availableQuantity > 0);
    basisBox.innerHTML = rows.length
      ? `<table class="tbl">
          <thead><tr><th>Item</th><th class="num">Available</th><th style="width:90px">Qty</th><th style="width:100px">Price</th><th style="width:80px">Disc %</th><th style="width:90px">Flat disc</th><th style="width:80px">Tax %</th><th>Incl. tax</th><th class="num">Disc</th><th class="num">Taxable</th><th class="num">Tax</th><th class="num">Total</th></tr></thead>
          <tbody>${rows.map((line) => {
            const key = editKey(line.id, line.grnItemId);
            const edit = savedEdits[key] || {};
            const prior = existingItems.find((i) => String(i.poItemId) === String(line.id));
            const values = {
              quantity: edit.quantity ?? prior?.quantity ?? line.availableQuantity,
              unitPrice: edit.unitPrice ?? prior?.unitPrice ?? line.unitPrice ?? 0,
              discountPercent: edit.discountPercent ?? prior?.discountPercent ?? line.discountPercent ?? 0,
              discountAmount: edit.discountAmount ?? (prior ? invoiceFlatDiscount(prior) : line.discountAmount ?? 0),
              taxRate: edit.taxRate ?? prior?.taxRate ?? line.taxRate ?? 0,
              taxInclusive: edit.taxInclusive ?? prior?.taxInclusive ?? line.taxInclusive ?? false,
            };
            const calc = calcInvoiceLine(values);
            return `<tr data-inv-line data-po-item="${line.id}" data-grn-item="${line.grnItemId || ''}"
                data-item-id="${line.itemId || ''}" data-uom-id="${line.uomId || line.itemUomId || ''}"
                data-desc="${esc(line.description || line.itemName || '')}" data-max="${line.availableQuantity}">
              <td><span class="strong">${esc(line.itemName)}</span><div class="small muted mono">${esc(line.itemCode)}</div></td>
              <td class="num"><b>${num(line.availableQuantity)}</b> <span class="small muted">${esc(line.uomCode)}</span></td>
              <td><input class="input" data-qty type="number" min="0.01" max="${line.availableQuantity}" step="0.01" value="${esc(values.quantity)}" /></td>
              <td><input class="input" data-price type="number" min="0" step="0.01" value="${esc(values.unitPrice)}" /></td>
              <td><input class="input" data-discpct type="number" min="0" max="100" step="0.01" value="${esc(values.discountPercent)}" /></td>
              <td><input class="input" data-disamt type="number" min="0" step="0.01" value="${esc(values.discountAmount)}" /></td>
              <td><input class="input" data-tax type="number" min="0" max="100" step="0.01" value="${esc(values.taxRate)}" /></td>
              <td><label class="row" style="gap:6px;align-items:center"><input type="checkbox" data-taxinc ${values.taxInclusive ? 'checked' : ''} /> <span class="small">Incl.</span></label></td>
              <td class="num small" data-line-disc>${money(calc.discountAmount)}</td>
              <td class="num small" data-line-taxable>${money(calc.taxableAmount)}</td>
              <td class="num small" data-line-tax>${money(calc.taxAmount)}</td>
              <td class="num small" data-line-total>${money(calc.totalAmount)}</td>
            </tr>`;
          }).join('')}</tbody>
        </table>`
      : `<div class="empty small" style="padding:24px">There is no accepted quantity left to invoice on this order.</div>`;
    recalcInvoiceForm();
  }

  async function refreshBasis() {
    captureEdits();
    const poId = poSelect ? poSelect.value : (invoice ? invoice.poId : '');
    basis = null;
    if (!poId) {
      renderBasis();
      return;
    }
    basisBox.innerHTML = `<div class="empty small" style="padding:24px">Loading receipt basis\u2026</div>`;
    try {
      basis = await loadBasis(meta, poId);
      renderBasis();
    } catch (e) {
      basisBox.innerHTML = `<div class="empty small" style="padding:24px">${esc(e.message)}</div>`;
    }
  }

  poSelect?.addEventListener('change', () => { savedEdits = {}; });
  poSelect?.addEventListener('change', refreshBasis);
  await refreshBasis();

  ctx.view.querySelector('[data-save]').addEventListener('click', async () => {
    alertBox.classList.add('hidden');
    const poId = poSelect ? poSelect.value : invoice?.poId;
    if (!poId) return showError('Select a purchase order.');
    if (!form.supplierInvoiceNo.value.trim()) return showError('Supplier invoice number is required.');
    if (!form.supplierInvoiceDate.value) return showError('Supplier invoice date is required.');

    const invoiceLines = readInvoiceLines(true);
    if (!invoiceLines.length) return showError('Enter a quantity on at least one invoice line.');
    for (const line of invoiceLines) {
      const max = Number(line.max) || 0;
      if (Number(line.quantity) > max + 0.004) {
        return showError(`${line.description || 'A line'} exceeds the accepted quantity available for invoicing (${max}).`);
      }
    }
    const doc = recalcInvoiceForm();
    /* `lines` is the new override shape; `items` is kept for older servers. */
    const linePayload = invoiceLines.map((l) => ({
      poItemId: l.poItemId,
      grnItemId: l.grnItemId,
      itemId: l.itemId,
      description: l.description,
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      discountPercent: l.discountPercent,
      discountAmount: l.discountAmount,
      taxRate: l.taxRate,
      taxInclusive: l.taxInclusive,
    }));
    const body = {
      poId,
      grnId: grnSelect.value || null,
      supplierInvoiceNo: form.supplierInvoiceNo.value.trim(),
      supplierInvoiceDate: form.supplierInvoiceDate.value || null,
      dueDate: form.dueDate.value || null,
      gstType: form.gstType.value,
      discountPercent: Number(form.discountPercent?.value) || 0,
      discountAmount: Number(form.discountAmount?.value) || 0,
      roundOff: doc.roundOff,
      remarks: form.remarks.value.trim(),
      lines: linePayload,
      items: linePayload,
    };

    try {
      if (id) {
        await api.put(`/api/procurement/invoices/${id}`, body);
        toast('Procurement invoice updated.');
        navigate(`/invoices/${id}`);
      } else {
        const res = await api.post('/api/procurement/invoices', body);
        toast(`Procurement invoice ${res.invoiceNo} created.`);
        navigate(`/invoices/${res.id}`);
      }
    } catch (e) {
      showError(e.message || 'Unable to save the procurement invoice.');
    }
  });
}

/* ================================================================== */
/* DETAIL                                                              */
/* ================================================================== */
export async function renderDetail(ctx, options = {}) {
  const id = Number(options.id);
  ctx.view.innerHTML = `<div class="empty">Loading procurement invoice\u2026</div>`;
  const [detail, meta] = await Promise.all([
    api.get(`/api/procurement/invoices/${id}`),
    api.get('/api/procurement/invoices/meta'),
  ]);
  const invoice = detail.invoice;
  const actions = detail.actions || {};
  const items = detail.items || [];
  const bill = detail.bill;
  const categories = categoryOptions(meta.categories || []);
  // Older invoice output does not expose roundOff; derive it from the saved lines.
  const invoiceBase = invoice.baseTotalAmount ?? round2(items.reduce((s, l) => s + (Number(l.totalAmount) || 0), 0) - (Number(invoice.discountAmount) || 0));
  const invoiceRoundOff = invoice.roundOff ?? roundOffAmount(invoiceBase);
  const refresh = () => renderDetail(ctx, { id });
  const act = async (fn, message, type = 'success') => {
    try {
      await fn();
      toast(message, type);
      await refresh();
    } catch (err) {
      toast(err.message || 'Action failed.', 'error');
    }
  };

  ctx.view.innerHTML = `
    <div class="page-head">
      <div><h1>${esc(invoice.invoiceNo)}</h1>
        <div class="sub">${esc(invoice.vendorName)} \u00b7 ${esc(invoice.unitName)}${invoice.departmentName ? ` \u00b7 ${esc(invoice.departmentName)}` : ''}</div></div>
      <div class="page-actions">
        <a class="btn" href="#/invoices">${icon('arrowLeft')} Back</a>
        ${invoice.poId ? `<a class="btn" href="#/purchase-orders/${invoice.poId}">${icon('briefcase')} View PO</a>` : ''}
        ${actions.canEdit ? `<a class="btn" href="#/invoices/${invoice.id}/edit">${icon('edit')} Edit</a>` : ''}
        ${actions.canValidate ? `<button class="btn btn-primary" type="button" data-validate>${icon('checkCircle')} Validate</button>` : ''}
        ${actions.canCreateBill ? `<button class="btn btn-primary" type="button" data-create-bill>${icon('file')} Create Bill</button>` : ''}
        ${actions.canViewBill ? `<a class="btn" href="#/bills/${invoice.abmdasBillId}">${icon('file')} View Bill</a>` : ''}
        ${actions.canDelete ? `<button class="btn btn-danger" type="button" data-delete>${icon('trash')} Delete</button>` : ''}
        ${!actions.canDelete && ['draft', 'validated'].includes(invoice.status) && can('invoice.manage') ? `<button class="btn btn-danger" type="button" data-cancel>${icon('xCircle')} Cancel</button>` : ''}
      </div>
    </div>

    <div class="grid grid-4 mb-16">
      <div class="card"><div class="kpi"><div class="chip gray">${icon('file')}</div><div><div class="label">Status</div><div class="value small-value">${statusOf(invoice.status)}</div><div class="meta">${invoice.validatedAt ? `Validated ${fmtDate(invoice.validatedAt)}` : 'Awaiting validation'}</div></div></div></div>
      <div class="card"><div class="kpi"><div class="chip blue">${icon('layers')}</div><div><div class="label">Net amount</div><div class="value small-value">${money(invoice.netAmount)}</div><div class="meta">tax ${money(invoice.taxAmount)}</div></div></div></div>
      <div class="card"><div class="kpi"><div class="chip amber">${icon('calendar')}</div><div><div class="label">Supplier invoice</div><div class="value small-value">${esc(invoice.supplierInvoiceNo)}</div><div class="meta">${fmtDate(invoice.supplierInvoiceDate)}${invoice.dueDate ? ` \u00b7 due ${fmtDate(invoice.dueDate)}` : ''}</div></div></div></div>
      <div class="card"><div class="kpi"><div class="chip teal">${icon('briefcase')}</div><div><div class="label">Purchase order</div><div class="value small-value">${esc(invoice.poNo || '\u2014')}</div><div class="meta">${invoice.grnNo ? `Receipt ${esc(invoice.grnNo)}` : `${num(invoice.itemCount)} line${invoice.itemCount === 1 ? '' : 's'}`}</div></div></div></div>
    </div>

    <div class="grid grid-2" style="align-items:start">
      <div class="stack">
        <div class="card">
          <div class="card-head"><div><h3>Invoice Lines</h3><div class="sub">Accepted receipt quantities being invoiced</div></div></div>
          <div class="table-wrap">
            <table class="tbl">
              <thead><tr><th>Item</th><th class="num">Qty</th><th class="num">Unit Price</th><th class="num">Disc</th><th class="num">Taxable</th><th class="num">Tax %</th><th class="num">Basis</th><th class="num">Tax</th><th class="num">Total</th></tr></thead>
              <tbody>${items.map((line) => `<tr>
                <td><span class="strong">${esc(line.itemName)}</span><div class="small muted mono">${esc(line.itemCode)}</div>
                  ${line.description && line.description !== line.itemName ? `<div class="small muted">${esc(line.description)}</div>` : ''}</td>
                <td class="num">${num(line.quantity)} <span class="small muted">${esc(line.uomCode)}</span></td>
                <td class="num">${money(line.unitPrice)}</td>
                <td class="num">${money(line.discountAmount)}${line.discountPercent ? `<div class="small muted">${num(line.discountPercent)}%</div>` : ''}</td>
                <td class="num">${money(line.taxableAmount)}</td>
                <td class="num">${num(line.taxRate)}</td>
                <td class="num small">${line.taxInclusive ? 'Incl.' : 'Excl.'}</td>
                <td class="num">${money(line.taxAmount)}</td>
                <td class="num">${money(line.totalAmount)}</td>
              </tr>`).join('')}</tbody>
            </table>
          </div>
          <div class="row" style="justify-content:flex-end;padding:12px 14px;border-top:1px solid var(--border)">
            <div style="text-align:right" class="small">
              <div class="row"><span class="muted">Taxable value</span><span>${money(invoice.subtotal)}</span></div>
              <div class="row"><span class="muted">Discount</span><span>${money(items.reduce((s, l) => s + (Number(l.discountAmount) || 0), 0))}</span></div>
              <div class="row"><span class="muted">Header discount${invoice.discountPercent ? ` (${num(invoice.discountPercent)}%)` : ''}</span><span>${money(invoice.discountAmount)}</span></div>
              <div class="row"><span class="muted">GST (${num(invoice.gstRate)}%)</span><span>${money(invoice.taxAmount)}</span></div>
              ${invoice.gstType === 'cgst_sgst'
                ? `<div class="row"><span class="muted">CGST</span><span>${money(invoice.cgstAmount)}</span></div>
                   <div class="row"><span class="muted">SGST</span><span>${money(invoice.sgstAmount)}</span></div>`
                : invoice.gstType === 'igst'
                  ? `<div class="row"><span class="muted">IGST</span><span>${money(invoice.igstAmount)}</span></div>`
                  : ''}
              <div class="row"><span class="muted">Net before round off</span><span>${money(invoiceBase)}</span></div>
              <div class="row"><span class="muted">Round off</span><span>${money(invoiceRoundOff)}</span></div>
              <div class="row"><span class="muted">Net amount (rounded)</span><span class="strong">${money(invoice.netAmount)}</span></div>
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card-head"><div><h3>Linked ABMDAS Bill</h3><div class="sub">The bill remains the approval and payment source of truth</div></div></div>
          <div class="form-section">
            ${bill
              ? `<div class="row" style="gap:12px;align-items:center">
                  <div style="flex:1">
                    <div class="strong">${esc(bill.billNo)}</div>
                    <div class="small muted">${statusBadge(bill.status)} \u00b7 ${money(bill.netAmount)}</div>
                  </div>
                  <a class="btn btn-sm" href="#/bills/${bill.id}">${icon('externalLink')} Open bill</a>
                </div>`
              : `<div class="row" style="gap:12px;align-items:center">
                  <div style="flex:1" class="hint">${actions.canCreateBill
                    ? 'This invoice is validated. Create the linked draft bill so ABMDAS approval can continue.'
                    : 'A linked draft bill is created when the invoice is validated.'}</div>
                  ${actions.canCreateBill ? `<button class="btn btn-sm btn-primary" type="button" data-create-bill>Create bill</button>` : ''}
                </div>`}
          </div>
        </div>
      </div>

      <div class="stack">
        <div class="card">
          <div class="card-head"><div><h3>Invoice Details</h3></div></div>
          <div class="form-section">
            <div class="stack small">
              <div class="row"><span class="muted" style="width:140px">Purchase order</span><span>${invoice.poId ? `<a href="#/purchase-orders/${invoice.poId}">${esc(invoice.poNo)}</a>` : '\u2014'}</span></div>
              <div class="row"><span class="muted" style="width:140px">Goods receipt</span><span>${invoice.grnId ? `<a href="#/grns/${invoice.grnId}">${esc(invoice.grnNo)}</a>` : '<span class="muted">All posted receipts</span>'}</span></div>
              <div class="row"><span class="muted" style="width:140px">Supplier invoice</span><span>${esc(invoice.supplierInvoiceNo)}</span></div>
              <div class="row"><span class="muted" style="width:140px">Invoice date</span><span>${fmtDate(invoice.supplierInvoiceDate)}</span></div>
              <div class="row"><span class="muted" style="width:140px">Due date</span><span>${invoice.dueDate ? fmtDate(invoice.dueDate) : '\u2014'}</span></div>
              <div class="row"><span class="muted" style="width:140px">GST type</span><span>${esc(GST_LABEL[invoice.gstType] || invoice.gstType)}</span></div>
              <div class="row"><span class="muted" style="width:140px">Header discount</span><span>${invoice.discountPercent ? `${num(invoice.discountPercent)}% + ` : ''}${money(invoice.discountAmount)}</span></div>
              <div class="row"><span class="muted" style="width:140px">Price basis</span><span>${items.some((l) => l.taxInclusive) ? `${items.filter((l) => l.taxInclusive).length} inclusive tax line(s)` : 'Tax exclusive'}</span></div>
              <div class="row"><span class="muted" style="width:140px">Created</span><span>${fmtDate(invoice.createdAt, true)}</span></div>
              ${invoice.validatedAt ? `<div class="row"><span class="muted" style="width:140px">Validated</span><span>${fmtDate(invoice.validatedAt, true)}${invoice.validatedByName ? ` \u00b7 ${esc(invoice.validatedByName)}` : ''}</span></div>` : ''}
              ${invoice.validationRemarks ? `<div class="row"><span class="muted" style="width:140px">Validation notes</span><span>${esc(invoice.validationRemarks)}</span></div>` : ''}
              ${invoice.rejectionReason ? `<div class="row"><span class="muted" style="width:140px">Rejection reason</span><span>${esc(invoice.rejectionReason)}</span></div>` : ''}
              ${invoice.remarks ? `<div class="row"><span class="muted" style="width:140px">Remarks</span><span>${esc(invoice.remarks)}</span></div>` : ''}
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card-head"><div><h3>Progress</h3><div class="sub">Procurement to payment</div></div></div>
          <div class="form-section">
            <div class="stack small">
              <div class="row"><span class="muted" style="width:140px">Requisition</span><span>${invoice.poId ? `<a href="#/purchase-orders/${invoice.poId}">Purchase order ${esc(invoice.poNo)}</a>` : '\u2014'}</span></div>
              <div class="row"><span class="muted" style="width:140px">Receipt</span><span>${invoice.grnId ? `<a href="#/grns/${invoice.grnId}">${esc(invoice.grnNo)}</a>` : 'Covered by posted receipts'}</span></div>
              <div class="row"><span class="muted" style="width:140px">Invoice</span><span>${statusOf(invoice.status)}</span></div>
              <div class="row"><span class="muted" style="width:140px">Bill</span><span>${bill ? `<a href="#/bills/${bill.id}">${esc(bill.billNo)}</a> \u00b7 ${statusBadge(bill.status)}` : 'Not raised'}</span></div>
            </div>
          </div>
        </div>
      </div>
    </div>`;

  /* ------------------------------ Actions ------------------------- */
  function openValidate() {
    modal({
      title: 'Validate procurement invoice',
      subtitle: `${invoice.invoiceNo} \u00b7 ${invoice.vendorName}`,
      body: `<div class="field">
          <label class="row" style="gap:8px;align-items:center">
            <input type="checkbox" data-create-bill checked /> Create the linked draft ABMDAS bill
          </label>
          <div class="hint">ABMDAS approval and payment stay on the normal bill workflow.</div>
        </div>
        <div class="field" data-category-field style="display:none">
          <label>ABMDAS category<span class="req">*</span></label>
          <select class="select" data-category>
            ${categories.map((c) => `<option value="${c.value}">${esc(c.label)}</option>`).join('')}
          </select>
          <div class="hint">The bill must use an active ABMDAS category.</div>
        </div>
        <div class="field"><label>Validation remarks</label>
          <textarea class="textarea" data-remarks rows="3" placeholder="Any notes recorded with this validation..."></textarea></div>
        <div class="alert alert-danger hidden" data-err></div>`,
      footer: `<button class="btn" data-modal-close>Cancel</button><button class="btn btn-primary" data-save>Validate invoice</button>`,
      onMount(el, close) {
        const check = el.querySelector('[data-create-bill]');
        const categoryField = el.querySelector('[data-category-field]');
        const errBox = el.querySelector('[data-err]');
        if (categories.length) {
          categoryField.style.display = 'block';
        } else {
          check.checked = false;
          categoryField.style.display = 'none';
        }
        check.addEventListener('change', () => {
          categoryField.style.display = check.checked && categories.length ? 'block' : 'none';
        });
        el.querySelector('[data-save]').addEventListener('click', async () => {
          errBox.classList.add('hidden');
          const createBill = check.checked;
          if (createBill && !categories.length) {
            errBox.textContent = 'No active ABMDAS category is available. Add a category first or validate without a bill.';
            errBox.classList.remove('hidden');
            return;
          }
          try {
            const res = await api.post(`/api/procurement/invoices/${id}/validate`, {
              createBill,
              categoryId: createBill ? el.querySelector('[data-category]').value : undefined,
              validationRemarks: el.querySelector('[data-remarks]').value.trim(),
            });
            close();
            toast(res.billNo
              ? `Invoice validated and linked to bill ${res.billNo}.`
              : 'Invoice validated. Create the linked bill to continue ABMDAS approval.');
            await refresh();
          } catch (e) {
            errBox.textContent = e.message;
            errBox.classList.remove('hidden');
          }
        });
      },
    });
  }

  function openCreateBill() {
    if (!categories.length) {
      toast('No active ABMDAS category is available. Add a category first.', 'error');
      return;
    }
    modal({
      title: 'Create linked ABMDAS bill',
      subtitle: `${invoice.invoiceNo} \u00b7 ${invoice.vendorName}`,
      body: `<div class="field"><label>ABMDAS category<span class="req">*</span></label>
          <select class="select" data-category>
            ${categories.map((c) => `<option value="${c.value}">${esc(c.label)}</option>`).join('')}
          </select></div>
        <div class="help-block mt-12">A draft bill is created with the invoice amounts and GST. ABMDAS approval remains the source of truth.</div>
        <div class="alert alert-danger hidden" data-err style="margin-top:10px"></div>`,
      footer: `<button class="btn" data-modal-close>Cancel</button><button class="btn btn-primary" data-save>Create bill</button>`,
      onMount(el, close) {
        el.querySelector('[data-save]').addEventListener('click', async () => {
          const errBox = el.querySelector('[data-err]');
          errBox.classList.add('hidden');
          try {
            const res = await api.post(`/api/procurement/invoices/${id}/create-bill`, {
              categoryId: el.querySelector('[data-category]').value,
            });
            close();
            toast(`Bill ${res.billNo} created.`);
            await refresh();
          } catch (e) {
            errBox.textContent = e.message;
            errBox.classList.remove('hidden');
          }
        });
      },
    });
  }

  ctx.view.querySelector('[data-validate]')?.addEventListener('click', openValidate);
  ctx.view.querySelectorAll('[data-create-bill]').forEach((btn) => btn.addEventListener('click', openCreateBill));

  ctx.view.querySelector('[data-cancel]')?.addEventListener('click', async () => {
    const result = await actionDialog({ title: 'Cancel procurement invoice', subtitle: 'The invoice remains in the audit trail.', requireComment: true, confirmText: 'Cancel invoice', danger: true });
    if (!result) return;
    await act(() => api.post(`/api/procurement/invoices/${id}/cancel`, { reason: result.comments }), 'Procurement invoice cancelled.');
  });

  ctx.view.querySelector('[data-delete]')?.addEventListener('click', async () => {
    const ok = await confirmDialog({ title: 'Delete draft invoice', message: 'Delete this draft? It is retained for audit and hidden from lists.', confirmText: 'Delete draft', danger: true });
    if (!ok) return;
    await act(async () => {
      await api.del(`/api/procurement/invoices/${id}`);
      navigate('/invoices');
    }, 'Draft invoice deleted.');
  });
}
