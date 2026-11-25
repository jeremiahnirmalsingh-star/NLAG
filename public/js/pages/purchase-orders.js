import { api } from '../api.js';
import { can, state } from '../state.js';
import { navigate, withQuery } from '../router.js';
import { openQuickAdd } from '../quick-add.js';
import {
  esc, icon, money, num, statusBadge, emptyState, toast, field, modal, confirmDialog, actionDialog, fmtDate,
  roundRupee, roundOffAmount, roundOffControl, syncRoundOffInput, readRoundOffOverride, bindRoundOffControl,
} from '../ui.js';

const PO_STATUS = {
  draft: 'Draft',
  issued: 'Issued',
  partially_received: 'Partially Received',
  received: 'Received',
  closed: 'Closed',
  cancelled: 'Cancelled',
};
const GRN_STATUS = { draft: 'Draft', posted: 'Posted', cancelled: 'Cancelled' };
const INVOICE_STATUS = {
  draft: 'Draft', validated: 'Validated', billed: 'Billed', rejected: 'Rejected', cancelled: 'Cancelled',
};

function statusOf(status, map) {
  return statusBadge(status, (map && map[status]) || status);
}

function todayInput() {
  const d = new Date();
  const offset = d.getTimezoneOffset();
  return new Date(d.getTime() - offset * 60000).toISOString().slice(0, 10);
}

function poItemOptions(items, selected) {
  return `<option value="">\u2014 Select item \u2014</option>${items
    .map((item) => `<option value="${item.id}" ${String(item.id) === String(selected || '') ? 'selected' : ''}>${esc(item.name)} (${esc(item.itemCode)}) \u00b7 ${esc(item.uomCode)}</option>`)
    .join('')}`;
}

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/* ------------------------------------------------------------------ */
/* Delivery / round-off / general terms helpers                        */
/* ------------------------------------------------------------------ */
function generalTermsFallback(meta = {}) {
  return meta.generalTerms
    || meta.settings?.generalTerms
    || state.generalTerms
    || state.settings?.generalTerms
    || '';
}

function companyAddressFallback(meta = {}) {
  return meta.companyAddress
    || meta.orgAddress
    || state.settings.orgAddress
    || state.settings.org?.address
    || '';
}

function formatAddress(address) {
  if (!address) return '';
  if (typeof address === 'string') return address;
  return [
    address.addressLine1 || address.line1 || '',
    address.addressLine2 || address.line2 || '',
    [address.city, address.state, address.pincode].filter(Boolean).join(' '),
  ].filter(Boolean).join(', ');
}

function parseContacts(value) {
  if (Array.isArray(value)) return value.filter((c) => c && (c.name || c.mobile || c.email));
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((c) => c && (c.name || c.mobile || c.email)) : [];
  } catch {
    return [];
  }
}

async function loadPoAddressMeta(units = []) {
  let stores = (state.stores && state.stores.length) ? state.stores : [];
  if (!stores.length) {
    try {
      const res = await api.get('/api/procurement/stores');
      if (res?.stores?.length) {
        stores = res.stores;
        state.stores = stores;
      }
    } catch {
      stores = [];
    }
  }
  let unitList = units;
  try {
    const res = await api.get('/api/units');
    if (res?.units?.length) {
      const withAddress = new Map(res.units.map((u) => [String(u.id), u]));
      unitList = units.map((u) => ({ ...u, ...(withAddress.get(String(u.id)) || {}) }));
    }
  } catch {
    unitList = units;
  }
  return { units: unitList, stores };
}

function contactRow(contact = {}, index = 0) {
  return `<div class="form-grid" data-additional-contact style="border:1px solid var(--border);border-radius:8px;padding:10px;margin-top:8px">
    <div class="field"><label>Name</label><input class="input" data-contact-name value="${esc(contact.name || '')}" /></div>
    <div class="field"><label>Designation</label><input class="input" data-contact-designation value="${esc(contact.designation || '')}" /></div>
    <div class="field"><label>Mobile</label><input class="input" data-contact-mobile value="${esc(contact.mobile || '')}" /></div>
    <div class="field"><label>Email</label><input class="input" data-contact-email value="${esc(contact.email || '')}" /></div>
    <button class="btn btn-sm btn-ghost" type="button" data-remove-contact title="Remove contact">${icon('trash')}</button>
  </div>`;
}

function deliveryFieldsHtml({ po = {}, units = [], stores = [], generalTerms = '', companyAddress = '' } = {}) {
  const billingSource = po.billingAddressSource || 'unit';
  const shippingType = po.shippingLocationType || 'billing';
  const billingUnitId = po.billingUnitId || po.unitId || (units.length === 1 ? units[0].id : '');
  const shippingUnitId = shippingType === 'unit' ? (po.shippingLocationId || billingUnitId) : billingUnitId;
  const shippingStoreId = shippingType === 'store' ? po.shippingLocationId : '';
  const unitOptions = units.map((u) => `<option value="${u.id}" ${String(u.id) === String(billingUnitId) ? 'selected' : ''}>${esc(u.name)}</option>`).join('');
  const unitShippingOptions = units.map((u) => `<option value="${u.id}" ${String(u.id) === String(shippingUnitId) ? 'selected' : ''}>${esc(u.name)}</option>`).join('');
  const storeOptions = stores.map((s) => `<option value="${s.id}" ${String(s.id) === String(shippingStoreId) ? 'selected' : ''}>${esc(s.name)}${s.code ? ` (${esc(s.code)})` : ''}</option>`).join('');
  const contacts = parseContacts(po.additionalContacts);
  return `<div data-delivery-block>
    <div class="form-grid">
      <div class="field"><label>Billing address source</label>
        <select class="select" name="billingAddressSource" data-billing-source>
          <option value="company" ${billingSource === 'company' ? 'selected' : ''}>Company address</option>
          <option value="unit" ${billingSource === 'unit' ? 'selected' : ''}>Unit address</option>
          <option value="custom" ${billingSource === 'custom' ? 'selected' : ''}>Custom address</option>
        </select></div>
      <div class="field"><label>Billing unit</label>
        <select class="select" name="billingUnitId" data-billing-unit>${unitOptions}</select></div>
      <div class="field span-2"><label>Billing address</label>
        <textarea class="textarea" name="billingAddress" data-billing-address rows="2" placeholder="Address printed on the order">${esc(po.billingAddress || '')}</textarea></div>
      <div class="field"><label>Shipping address source</label>
        <select class="select" name="shippingLocationType" data-shipping-type>
          <option value="billing" ${shippingType === 'billing' ? 'selected' : ''}>Same as billing</option>
          <option value="unit" ${shippingType === 'unit' ? 'selected' : ''}>Unit address</option>
          <option value="store" ${shippingType === 'store' ? 'selected' : ''}>Store address</option>
          <option value="custom" ${shippingType === 'custom' ? 'selected' : ''}>Custom address</option>
        </select></div>
      <div class="field" data-shipping-unit-block ${shippingType === 'unit' ? '' : 'hidden'}><label>Shipping unit</label>
        <select class="select" data-shipping-unit>${unitShippingOptions}</select></div>
      <div class="field" data-shipping-store-block ${shippingType === 'store' ? '' : 'hidden'}><label>Shipping store</label>
        <select class="select" data-shipping-store><option value="">— Select store —</option>${storeOptions}</select></div>
      <input type="hidden" name="shippingLocationId" value="${esc(po.shippingLocationId || '')}" />
      <input type="hidden" name="shippingLocationLabel" value="${esc(po.shippingLocationLabel || '')}" />
      <div class="field span-2"><label>Shipping address</label>
        <textarea class="textarea" name="shippingAddress" data-shipping-address rows="2" placeholder="Where the materials should be delivered">${esc(po.shippingAddress || '')}</textarea></div>
      <div class="field"><label>Delivery contact name</label><input class="input" name="deliveryContactName" value="${esc(po.deliveryContactName || '')}" /></div>
      <div class="field"><label>Designation</label><input class="input" name="deliveryContactDesignation" value="${esc(po.deliveryContactDesignation || '')}" /></div>
      <div class="field"><label>Mobile</label><input class="input" name="deliveryContactMobile" value="${esc(po.deliveryContactMobile || '')}" /></div>
      <div class="field"><label>Email</label><input class="input" name="deliveryContactEmail" type="email" value="${esc(po.deliveryContactEmail || '')}" /></div>
    </div>
    <div class="row" style="justify-content:space-between;align-items:center;margin-top:10px">
      <div class="small muted">Additional delivery contacts</div>
      <button class="btn btn-sm" type="button" data-add-contact>${icon('plus')} Add contact</button>
    </div>
    <div data-additional-contacts>${contacts.map((c, i) => contactRow(c, i)).join('')}</div>
    <div class="field" style="margin-top:12px"><label>General terms</label>
      <textarea class="textarea" name="generalTerms" rows="5" data-general-terms>${esc(generalTerms || '')}</textarea>
      <div class="hint">Prefilled from procurement settings. Printed on the purchase order.</div></div>
  </div>`;
}

function bindDeliveryFields(root, { units = [], stores = [], companyAddress = '' } = {}) {
  const get = (name) => root.querySelector(`[name="${name}"]`);
  const billingSource = get('billingAddressSource');
  const billingUnit = get('billingUnitId');
  const billingAddress = get('billingAddress');
  const shippingType = get('shippingLocationType');
  const shippingAddress = get('shippingAddress');
  const shippingUnitBlock = root.querySelector('[data-shipping-unit-block]');
  const shippingStoreBlock = root.querySelector('[data-shipping-store-block]');
  const shippingUnit = root.querySelector('[data-shipping-unit]');
  const shippingStore = root.querySelector('[data-shipping-store]');
  const shippingLocationId = get('shippingLocationId');
  const shippingLocationLabel = get('shippingLocationLabel');

  const unitAddress = (id) => formatAddress(units.find((u) => String(u.id) === String(id)));
  const storeById = (id) => stores.find((s) => String(s.id) === String(id));

  const syncBilling = () => {
    if (!billingAddress) return;
    if (billingSource?.value === 'company') billingAddress.value = companyAddress || '';
    else if (billingSource?.value === 'unit') billingAddress.value = unitAddress(billingUnit?.value) || companyAddress || '';
    billingAddress.readOnly = billingSource?.value !== 'custom';
  };

  const syncShipping = (applyContact = true) => {
    if (shippingUnitBlock) shippingUnitBlock.hidden = shippingType?.value !== 'unit';
    if (shippingStoreBlock) shippingStoreBlock.hidden = shippingType?.value !== 'store';
    if (shippingAddress) shippingAddress.readOnly = shippingType?.value !== 'custom';
    const type = shippingType?.value;
    if (type === 'billing') {
      if (shippingAddress) shippingAddress.value = billingAddress?.value || '';
      if (shippingLocationId) shippingLocationId.value = '';
      if (shippingLocationLabel) shippingLocationLabel.value = 'Billing address';
    } else if (type === 'unit') {
      const resolved = unitAddress(shippingUnit?.value) || companyAddress;
      if (shippingAddress && resolved) shippingAddress.value = resolved;
      if (shippingLocationId) shippingLocationId.value = shippingUnit?.value || '';
      if (shippingLocationLabel) shippingLocationLabel.value = shippingUnit?.selectedOptions[0]?.textContent || '';
    } else if (type === 'store') {
      const store = storeById(shippingStore?.value);
      if (shippingAddress && store) shippingAddress.value = formatAddress(store);
      if (shippingLocationId) shippingLocationId.value = store?.id || '';
      if (shippingLocationLabel) shippingLocationLabel.value = store?.name || '';
      if (applyContact && store) {
        const setValue = (name, value) => {
          const el = get(name);
          if (el && value) el.value = value;
        };
        setValue('deliveryContactName', store.inchargeName);
        setValue('deliveryContactDesignation', store.inchargeDesignation);
        setValue('deliveryContactMobile', store.inchargeMobile);
        setValue('deliveryContactEmail', store.inchargeEmail);
      }
    } else {
      if (shippingLocationId) shippingLocationId.value = '';
      if (shippingLocationLabel) shippingLocationLabel.value = '';
    }
  };

  billingSource?.addEventListener('change', () => { syncBilling(); syncShipping(); });
  billingUnit?.addEventListener('change', () => { if (billingSource?.value === 'unit') syncBilling(); if (shippingType?.value === 'billing') syncShipping(false); });
  shippingType?.addEventListener('change', () => syncShipping());
  shippingUnit?.addEventListener('change', () => syncShipping(false));
  shippingStore?.addEventListener('change', () => syncShipping(true));

  root.querySelector('[data-add-contact]')?.addEventListener('click', () => {
    const holder = root.querySelector('[data-additional-contacts]');
    holder.insertAdjacentHTML('beforeend', contactRow({}, holder.children.length));
    const row = holder.querySelector('[data-additional-contact]:last-child');
    bindContactRow(row);
  });
  const bindContactRow = (row) => {
    row?.querySelector('[data-remove-contact]')?.addEventListener('click', () => row.remove());
  };
  root.querySelectorAll('[data-additional-contact]').forEach(bindContactRow);
  syncBilling();
  syncShipping(false);
}

function readDeliveryFields(root) {
  const val = (name) => root.querySelector(`[name="${name}"]`)?.value ?? '';
  const contacts = [];
  root.querySelectorAll('[data-additional-contact]').forEach((row) => {
    const contact = {
      name: row.querySelector('[data-contact-name]')?.value.trim() || '',
      designation: row.querySelector('[data-contact-designation]')?.value.trim() || '',
      mobile: row.querySelector('[data-contact-mobile]')?.value.trim() || '',
      email: row.querySelector('[data-contact-email]')?.value.trim() || '',
    };
    if (contact.name || contact.designation || contact.mobile || contact.email) contacts.push(contact);
  });
  return {
    billingAddressSource: val('billingAddressSource') || 'unit',
    billingUnitId: val('billingUnitId') || null,
    billingAddress: val('billingAddress'),
    shippingLocationType: val('shippingLocationType') || 'billing',
    shippingLocationId: val('shippingLocationId') || null,
    shippingLocationLabel: val('shippingLocationLabel'),
    shippingAddress: val('shippingAddress'),
    deliveryContactName: val('deliveryContactName'),
    deliveryContactDesignation: val('deliveryContactDesignation'),
    deliveryContactMobile: val('deliveryContactMobile'),
    deliveryContactEmail: val('deliveryContactEmail'),
    additionalContacts: contacts,
    generalTerms: val('generalTerms'),
  };
}

/* One calculation rule for POs, GRNs and procurement invoices. */
function calcPriceLine(input) {
  const quantity = round2(input.quantity);
  const unitPrice = round2(input.unitPrice);
  const grossAmount = round2(quantity * unitPrice);
  const discountPercent = round2(input.discountPercent);
  const flatDiscount = round2(input.flatDiscountAmount ?? input.discountAmount);
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
    quantity, unitPrice, grossAmount, discountPercent, flatDiscountAmount: flatDiscount, discountAmount,
    taxableAmount, taxRate, taxInclusive, taxAmount, totalAmount,
  };
}

function calcDocument(lines, headerDiscount = {}, charges = 0) {
  const taxable = round2(lines.reduce((sum, l) => sum + l.taxableAmount, 0));
  const lineTax = round2(lines.reduce((sum, l) => sum + l.taxAmount, 0));
  const lineDiscount = round2(lines.reduce((sum, l) => sum + l.discountAmount, 0));
  const gross = round2(lines.reduce((sum, l) => sum + l.totalAmount, 0));
  const pct = round2(headerDiscount.discountPercent);
  const flat = round2(headerDiscount.flatDiscountAmount ?? headerDiscount.discountAmount);
  const appliedDiscount = round2(Math.min(gross, round2((gross * pct) / 100) + flat));
  const total = round2(gross - appliedDiscount + round2(charges));
  return { taxable, lineTax, lineDiscount, gross, discount: appliedDiscount, total };
}

/* Stored line/header discount_amount is the APPLIED total (percent + flat).
 * The editable form fields are the flat portion only; recover it so saving an
 * existing PO does not add the percentage discount a second time. */
function poFlatDiscount(line) {
  if (line.flatDiscountAmount !== undefined && line.flatDiscountAmount !== null) {
    return Math.max(0, round2(Number(line.flatDiscountAmount) || 0));
  }
  const gross = round2((Number(line.quantity) || 0) * (Number(line.unitPrice) || 0));
  const percentAmount = round2((gross * (Number(line.discountPercent) || 0)) / 100);
  return Math.max(0, round2((Number(line.discountAmount) || 0) - percentAmount));
}

function poLineForForm(line) {
  const flatDiscountAmount = poFlatDiscount(line);
  return { ...line, flatDiscountAmount, discountAmount: flatDiscountAmount };
}

function poHeaderFlatDiscount(po, lines) {
  if (po.flatDiscountAmount !== undefined && po.flatDiscountAmount !== null) {
    return Math.max(0, round2(Number(po.flatDiscountAmount) || 0));
  }
  const gross = round2((lines || []).reduce(
    (sum, line) => sum + (Number(line.totalAmount) || 0), 0
  ));
  const percentAmount = round2((gross * (Number(po.discountPercent) || 0)) / 100);
  return Math.max(0, round2((Number(po.discountAmount) || 0) - percentAmount));
}

function uomOptions(selected) {
  const list = window.__poUoms || [];
  return `<option value="">\u2014 UOM \u2014</option>${list.map((u) => `<option value="${u.id}" ${String(u.id) === String(selected || '') ? 'selected' : ''}>${esc(u.code)}</option>`).join('')}`;
}

function poLineRow(items, line = {}) {
  const calc = calcPriceLine(line);
  const label = line.itemName || line.description || 'New line';
  const inclusive = line.taxInclusive === true || line.taxInclusive === 1 || line.taxInclusive === '1' || line.taxInclusive === 'true';
  return `<div class="po-line" data-po-line data-line-id="${esc(line.id || '')}">
    <div class="po-line-head">
      <div class="po-line-title">${icon('layers')} <span class="po-line-no">1</span><span class="po-line-label">${esc(label)}</span></div>
      <div class="po-line-totals">
        <span>Disc <b data-linedisc>${money(calc.discountAmount)}</b></span>
        <span>Taxable <b data-taxable>${money(calc.taxableAmount)}</b></span>
        <span>Tax <b data-taxamt>${money(calc.taxAmount)}</b></span>
        <span class="po-line-grand">Line total <b data-total>${money(calc.totalAmount)}</b></span>
      </div>
      <button class="btn btn-sm btn-ghost" type="button" data-remove title="Remove line">${icon('trash')}</button>
    </div>
    <div class="po-line-grid">
      <div class="field span-2"><label>Item<span class="req">*</span></label><select class="select" data-item>${poItemOptions(items, line.itemId)}</select></div>
      <div class="field span-2"><label>Item name</label><input class="input" data-name value="${esc(line.itemName || '')}" placeholder="Name shown on the order" /></div>
      <div class="field span-2"><label>Description</label><textarea class="textarea" data-desc rows="2" placeholder="Full description of the item">${esc(line.description || '')}</textarea></div>
      <div class="field"><label>Model no</label><input class="input" data-model value="${esc(line.modelNo || '')}" placeholder="Model" /></div>
      <div class="field"><label>Make</label><input class="input" data-make value="${esc(line.make || '')}" placeholder="Make / brand" /></div>
      <div class="field"><label>UOM</label><select class="select" data-uom>${uomOptions(line.uomId)}</select></div>
      <div class="field"><label>Quantity</label><input class="input" data-qty type="number" min="0.01" step="0.01" value="${line.quantity !== undefined ? esc(line.quantity) : '1'}" /></div>
      <div class="field"><label>Rate</label><input class="input" data-price type="number" min="0" step="0.01" value="${line.unitPrice !== undefined ? esc(line.unitPrice) : ''}" /></div>
      <div class="field"><label>Discount %</label><input class="input" data-discpct type="number" min="0" max="100" step="0.01" value="${line.discountPercent !== undefined ? esc(line.discountPercent) : '0'}" /></div>
      <div class="field"><label>Flat discount</label><input class="input" data-disamt type="number" min="0" step="0.01" value="${line.discountAmount !== undefined ? esc(line.discountAmount) : '0'}" /></div>
      <div class="field"><label>Tax %</label><input class="input" data-tax type="number" min="0" max="100" step="0.01" value="${line.taxRate !== undefined ? esc(line.taxRate) : '0'}" /></div>
      <div class="field"><label class="row" style="gap:8px;align-items:center"><input type="checkbox" data-taxinc ${inclusive ? 'checked' : ''} /> Incl. tax</label>
        <div class="hint">Rate embedded in the price; tax is derived from the discounted value.</div></div>
    </div>
  </div>`;
}

function renumberPoLines(root) {
  root.querySelectorAll('[data-po-line]').forEach((row, index) => {
    const no = row.querySelector('.po-line-no');
    if (no) no.textContent = String(index + 1);
  });
}

function recalcPoForm(form) {
  const lines = [];
  form.querySelectorAll('[data-po-line]').forEach((row) => {
    const flatDiscountAmount = round2(Number(row.querySelector('[data-disamt]')?.value) || 0);
    const calc = calcPriceLine({
      quantity: row.querySelector('[data-qty]')?.value,
      unitPrice: row.querySelector('[data-price]')?.value,
      discountPercent: row.querySelector('[data-discpct]')?.value,
      flatDiscountAmount,
      taxRate: row.querySelector('[data-tax]')?.value,
      taxInclusive: row.querySelector('[data-taxinc]')?.checked,
    });
    lines.push(calc);
    const set = (sel, value) => {
      const el = row.querySelector(sel);
      if (el) el.textContent = money(value);
    };
    set('[data-linedisc]', calc.discountAmount);
    set('[data-taxable]', calc.taxableAmount);
    set('[data-taxamt]', calc.taxAmount);
    set('[data-total]', calc.totalAmount);
  });
  const charges = round2(
    (Number(form.querySelector('[name="freightCharges"]')?.value) || 0)
    + (Number(form.querySelector('[name="loadingCharges"]')?.value) || 0)
    + (Number(form.querySelector('[name="otherCharges"]')?.value) || 0)
  );
  const doc = calcDocument(lines, {
    discountPercent: form.querySelector('[name="discountPercent"]')?.value,
    flatDiscountAmount: round2(Number(form.querySelector('[name="discountAmount"]')?.value) || 0),
    discountAmount: form.querySelector('[name="discountAmount"]')?.value,
  }, charges);
  const setDoc = (sel, value) => {
    const el = form.querySelector(sel);
    if (el) el.textContent = money(value);
  };
  setDoc('[data-po-subtotal]', doc.taxable);
  setDoc('[data-po-line-discount]', doc.lineDiscount);
  setDoc('[data-po-discount]', doc.discount);
  setDoc('[data-po-tax]', doc.lineTax);
  setDoc('[data-po-charges]', charges);
  const roundOff = syncRoundOffInput(
    form.querySelector('[name="roundOff"]'), doc.total, form.dataset.savedRoundOff
  );
  const finalTotal = round2(doc.total + roundOff);
  setDoc('[data-po-grand]', doc.total);
  setDoc('[data-po-final]', finalTotal);
  return { ...doc, roundOff, final: finalTotal };
}

function bindPoLine(row, form, itemList) {
  const lines = form.querySelector('#po-lines') || form.querySelector('#rev-lines');
  const label = row.querySelector('.po-line-label');
  const updateLabel = () => {
    if (!label) return;
    const name = row.querySelector('[data-name]')?.value.trim();
    const desc = row.querySelector('[data-desc]')?.value.trim();
    const chosen = row.querySelector('[data-item]')?.selectedOptions[0]?.textContent.trim();
    label.textContent = name || desc || (chosen && chosen !== '\u2014 Select item \u2014' ? chosen : 'New line');
  };
  row.querySelector('[data-item]').addEventListener('change', () => {
    const item = itemList.find((i) => String(i.id) === String(row.querySelector('[data-item]').value));
    if (item) {
      const desc = row.querySelector('[data-desc]');
      const name = row.querySelector('[data-name]');
      const price = row.querySelector('[data-price]');
      if (name && !name.value.trim()) name.value = item.name;
      if (desc && !desc.value.trim()) desc.value = item.name;
      if (price && !price.value) price.value = item.standardCost || 0;
      const uomSel = row.querySelector('[data-uom]');
      if (uomSel && !uomSel.value) uomSel.value = item.uomId;
    }
    updateLabel();
    recalcPoForm(form);
  });
  ['[data-name]','[data-desc]'].forEach((sel) => {
    row.querySelector(sel)?.addEventListener('input', updateLabel);
  });
  ['[data-qty]','[data-price]','[data-discpct]','[data-disamt]','[data-tax]','[data-taxinc]'].forEach((sel) => {
    const el = row.querySelector(sel);
    if (!el) return;
    el.addEventListener('input', () => recalcPoForm(form));
    el.addEventListener('change', () => recalcPoForm(form));
  });
  row.querySelector('[data-remove]').addEventListener('click', () => {
    if (lines && lines.querySelectorAll('[data-po-line]').length === 1) {
      toast('A purchase order needs at least one line.', 'error');
      return;
    }
    row.remove();
    renumberPoLines(form);
    recalcPoForm(form);
  });
  updateLabel();
}

function readPoLines(form) {
  const lines = [];
  form.querySelectorAll('[data-po-line]').forEach((row) => {
    const itemId = row.querySelector('[data-item]').value;
    if (!itemId) return;
    const flatDiscountAmount = round2(Number(row.querySelector('[data-disamt]')?.value) || 0);
    const calc = calcPriceLine({
      quantity: row.querySelector('[data-qty]').value,
      unitPrice: row.querySelector('[data-price]').value,
      discountPercent: row.querySelector('[data-discpct]')?.value,
      flatDiscountAmount,
      taxRate: row.querySelector('[data-tax]').value,
      taxInclusive: row.querySelector('[data-taxinc]')?.checked,
    });
    lines.push({
      id: row.dataset.lineId || null,
      itemId,
      itemName: row.querySelector('[data-name]')?.value.trim() || '',
      description: row.querySelector('[data-desc]').value.trim(),
      modelNo: row.querySelector('[data-model]')?.value.trim() || '',
      make: row.querySelector('[data-make]')?.value.trim() || '',
      uomId: row.querySelector('[data-uom]')?.value || null,
      quantity: row.querySelector('[data-qty]').value,
      unitPrice: row.querySelector('[data-price]').value,
      discountPercent: row.querySelector('[data-discpct]')?.value || 0,
      flatDiscountAmount,
      discountAmount: flatDiscountAmount,
      taxRate: row.querySelector('[data-tax]').value,
      taxInclusive: !!row.querySelector('[data-taxinc]')?.checked,
      taxableAmount: calc.taxableAmount,
      taxAmount: calc.taxAmount,
      totalAmount: calc.totalAmount,
    });
  });
  return lines;
}

/* ================================================================== */
/* PURCHASE ORDER LIST                                                 */
/* ================================================================== */
export async function renderList(ctx) {
  const q = ctx.route.query || {};
  const params = new URLSearchParams();
  for (const key of ['search', 'status']) {
    if (q[key]) params.set(key, q[key]);
  }
  ctx.view.innerHTML = `<div class="empty">Loading purchase orders\u2026</div>`;
  const [meta, res] = await Promise.all([
    api.get('/api/procurement/purchase-orders/meta'),
    api.get(`/api/procurement/purchase-orders?${params.toString()}`),
  ]);
  const rows = res.purchaseOrders || [];
  const statuses = meta.statuses || [];

  ctx.view.innerHTML = `
    <div class="page-head">
      <div><h1>Purchase Orders</h1><div class="sub">Raise orders directly or from an approved comparison, then record receipts and track invoicing</div></div>
      <div class="page-actions">
        <a class="btn" href="#/grns">${icon('database')} Goods Receipts</a>
        ${can('po.manage') ? `<a class="btn btn-primary" href="#/purchase-orders/new">${icon('plus')} New Purchase Order</a>` : ''}
      </div>
    </div>

    <div class="card">
      <form class="toolbar" id="po-filters">
        <div class="search">${icon('search')}<input class="input" name="search" value="${esc(q.search || '')}" placeholder="PO number, vendor or notes..." /></div>
        <select class="select" name="status">
          <option value="">All statuses</option>
          ${statuses.map((s) => `<option value="${esc(s.value)}" ${q.status === s.value ? 'selected' : ''}>${esc(PO_STATUS[s.value] || s.label)}</option>`).join('')}
        </select>
        <button class="btn btn-sm" type="submit">${icon('filter')} Apply</button>
        <button class="btn btn-sm btn-ghost" type="button" data-reset>Reset</button>
      </form>
      <div class="table-wrap">
        ${rows.length
          ? `<table class="tbl">
              <thead><tr><th>Purchase order</th><th>Vendor</th><th>Source</th><th>PO date</th><th class="num">Items</th><th class="num">Receipts</th><th class="num">Amount</th><th>Status</th><th></th></tr></thead>
              <tbody>${rows.map((r) => `<tr>
                <td><a class="strong" href="#/purchase-orders/${r.id}">${esc(r.poNo)}</a>
                  <div class="small muted">${esc(r.unitName)}${r.departmentName ? ` \u00b7 ${esc(r.departmentName)}` : ''}</div></td>
                <td>${esc(r.vendorName)}<div class="small muted mono">${esc(r.vendorCode)}</div></td>
                <td class="small">${r.rfqId ? `<a href="#/sourcing/${r.rfqId}">${esc(r.rfqNo)}</a>` : '\u2014'}${r.csNo ? `<div class="small muted">${esc(r.csNo)}</div>` : ''}</td>
                <td class="small">${fmtDate(r.poDate)}${r.deliveryDate ? `<div class="small muted">due ${fmtDate(r.deliveryDate)}</div>` : ''}</td>
                <td class="num">${num(r.itemCount)}</td>
                <td class="num">${num(r.grnCount)}</td>
                <td class="num">${money(r.totalAmount)}</td>
                <td>${statusOf(r.status, PO_STATUS)}</td>
                <td class="actions"><a class="btn btn-sm btn-ghost" href="#/purchase-orders/${r.id}">${icon('eye')}</a></td>
              </tr>`).join('')}</tbody></table>`
          : emptyState(
              'No purchase orders found',
              'Raise a direct purchase order, or approve a comparative statement in sourcing and create one from it.',
              can('po.manage') ? '<a class="btn btn-sm btn-primary" href="#/purchase-orders/new">New Purchase Order</a>' : '',
              'briefcase'
            )}
      </div>
      <div class="small muted" style="padding:10px 14px">Showing ${num(rows.length)} of ${num(res.total)} purchase order${res.total === 1 ? '' : 's'}.</div>
    </div>`;

  const form = document.getElementById('po-filters');
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    navigate(withQuery('/purchase-orders', Object.fromEntries(new FormData(form).entries())));
  });
  form.querySelector('[data-reset]').addEventListener('click', () => navigate('/purchase-orders'));
}

/* ================================================================== */
/* PURCHASE ORDER FORM                                                 */
/* ================================================================== */
export async function renderForm(ctx, options = {}) {
  const id = options.id ? Number(options.id) : null;
  ctx.view.innerHTML = `<div class="empty">Loading purchase order\u2026</div>`;

  if (!id) {
    const meta = await api.get('/api/procurement/purchase-orders/meta');
    const available = (meta.comparativeStatements || []).filter((s) => !s.used);
    const vendors = meta.vendors || [];
    const units = meta.units || [];
    const departments = meta.departments || [];
    const itemList = meta.items || [];
    const uoms = meta.uoms || [];
    window.__poUoms = uoms;
    const addressMeta = await loadPoAddressMeta(units);
    const deliveryUnits = addressMeta.units.length ? addressMeta.units : units;
    const deliveryStores = addressMeta.stores;
    const defaultGeneralTerms = generalTermsFallback(meta);
    const defaultMode = available.length ? 'comparative' : 'direct';
    const selectedUnit = units.length === 1 ? units[0].id : '';
    ctx.view.innerHTML = `
      <div class="page-head">
        <div><h1>New Purchase Order</h1><div class="sub">Create a purchase order directly, or from an approved comparative statement</div></div>
        <div class="page-actions"><a class="btn" href="#/purchase-orders">${icon('arrowLeft')} Cancel</a>
          <button class="btn btn-primary" type="button" data-save>${icon('check')} Create purchase order</button></div>
      </div>
      <div id="po-alert" class="alert alert-danger hidden"></div>
      <form id="po-create-form">
        <div class="stack">
            <div class="card">
              <div class="card-head"><div><h3>Source</h3><div class="sub">Order directly, or award an approved comparison</div></div></div>
              <div class="form-section">
                ${field({
                  label: 'Create from', name: 'sourceMode', type: 'select', value: defaultMode,
                  options: [
                    { value: 'direct', label: 'Direct purchase order (no comparison)' },
                    ...(available.length ? [{ value: 'comparative', label: 'Approved comparative statement' }] : []),
                  ],
                  attrs: 'data-mode',
                })}
                <div data-direct-block>
                  <div class="form-grid">
                    ${field({ label: 'Unit', name: 'unitId', type: 'select', required: true, value: selectedUnit, options: units.map((u) => ({ value: u.id, label: u.name })) })}
                    ${field({ label: 'Vendor', name: 'vendorId', type: 'select', required: true, value: '', options: [{ value: '', label: '\u2014 Select vendor \u2014' }, ...vendors.map((v) => ({ value: v.id, label: `${v.name} (${v.code})` }))] })}
                    <button class="btn btn-sm" type="button" data-add-vendor style="margin-top:4px">+ New vendor</button>
                    ${field({ label: 'Department', name: 'departmentId', type: 'select', value: '', span: true, options: [{ value: '', label: '\u2014 No department \u2014' }, ...departments.map((d) => ({ value: d.id, label: d.code ? `${d.code} · ${d.name}` : d.name }))] })}
                  </div>
                  <div class="help-block">A direct purchase order is not linked to a requisition, RFQ or comparative statement.</div>
                </div>
                <div data-comp-block class="hidden">
                  ${available.length
                    ? `<div class="field"><label>Comparative statement<span class="req">*</span></label>
                        <select class="select" name="comparativeStatementId" data-cs>
                          <option value="">\u2014 Select comparative statement \u2014</option>
                          ${available.map((s) => `<option value="${s.id}">${esc(s.csNo)} \u00b7 ${esc(s.vendorName)} \u00b7 ${money(s.totalQuoted)}</option>`).join('')}
                        </select></div>
                      <div class="help-block" data-cs-info>Select a comparative statement to see the awarded vendor.</div>`
                    : `<div class="hint">No approved comparative statement is waiting for a purchase order. Approve one in Sourcing first, or create a direct purchase order.</div>`}
                </div>
              </div>
            </div>
            <div class="card" data-direct-block>
              <div class="card-head"><div><h3>Items</h3><div class="sub">Each line is a full-width card so every field stays readable while you type</div></div>
                <div class="btn-group">
                  <button class="btn btn-sm" type="button" data-add-line>${icon('plus')} Add line</button>
                  <button class="btn btn-sm btn-ghost" type="button" data-add-item>+ New item</button>
                </div>
              </div>
              <div class="po-lines" id="po-lines">${poLineRow(itemList)}</div>
              <div class="row" style="justify-content:flex-end;padding:12px 14px;border-top:1px solid var(--border)">
                <div style="text-align:right" class="small">
                  <div class="row"><span class="muted">Taxable value</span><span data-po-subtotal>${money(0)}</span></div>
                  <div class="row"><span class="muted">Discount</span><span data-po-line-discount>${money(0)}</span></div>
                  <div class="row"><span class="muted">Header discount</span><span data-po-discount>${money(0)}</span></div>
                  <div class="row"><span class="muted">Tax</span><span data-po-tax>${money(0)}</span></div>
                  <div class="row"><span class="muted">Charges</span><span data-po-charges>${money(0)}</span></div>
                  <div class="row"><span class="muted">Total before round off</span><span data-po-grand>${money(0)}</span></div>
                  ${roundOffControl({ value: 0 })}
                  <div class="row"><span class="muted">Total (rounded)</span><span class="strong" data-po-final>${money(0)}</span></div>
                </div>
              </div>
            </div>
          </div>
          <div class="card" data-direct-block>
            <div class="card-head"><div><h3>Discount &amp; Charges</h3><div class="sub">Header discount applies after tax; charges are added afterwards</div></div></div>
            <div class="form-section">
              <div class="form-grid">
                ${field({ label: 'Discount %', name: 'discountPercent', type: 'number', value: '0', attrs: 'min="0" max="100" step="0.01"' })}
                ${field({ label: 'Discount amount', name: 'discountAmount', type: 'number', value: '0', attrs: 'min="0" step="0.01"', hint: 'Added to the percentage discount, then capped at the document value.' })}
                ${field({ label: 'Freight Charges', name: 'freightCharges', type: 'number', value: '0' })}
                ${field({ label: 'Loading / Unloading', name: 'loadingCharges', type: 'number', value: '0' })}
                ${field({ label: 'Other Charges', name: 'otherCharges', type: 'number', value: '0' })}
              </div>
            </div>
          </div>
          <div class="card">
            <div class="card-head"><div><h3>Order Details</h3><div class="sub">Dates and commercial terms</div></div></div>
            <div class="form-section">
              <div class="form-grid">
                ${field({ label: 'PO Date', name: 'poDate', type: 'date', value: meta.today || todayInput() })}
                ${field({ label: 'Delivery Date', name: 'deliveryDate', type: 'date', value: '' })}
                ${field({ label: 'Payment Terms', name: 'paymentTerms', value: '', span: true, placeholder: 'e.g. 30 days from invoice' })}
                ${field({ label: 'Delivery Terms', name: 'deliveryTerms', value: '', span: true, placeholder: 'Place and mode of delivery' })}
                ${field({ label: 'Terms & conditions', name: 'terms', type: 'textarea', value: '', span: true })}
                ${field({ label: 'Notes', name: 'notes', type: 'textarea', value: '', span: true })}
              </div>
            </div>
          </div>
          <div class="card">
            <div class="card-head"><div><h3>Billing, Shipping &amp; Delivery Contact</h3><div class="sub">Addresses resolve from masters unless a custom address is chosen</div></div></div>
            <div class="form-section">
              ${deliveryFieldsHtml({
                units: deliveryUnits,
                stores: deliveryStores,
                generalTerms: defaultGeneralTerms,
                companyAddress: companyAddressFallback(meta),
              })}
            </div>
          </div>
      </form>`;

    const form = document.getElementById('po-create-form');
    const alertBox = document.getElementById('po-alert');
    const lines = form.querySelector('#po-lines');
    const modeSelect = form.querySelector('[data-mode]');
    const csSelect = form.querySelector('[data-cs]');
    const info = form.querySelector('[data-cs-info]');
    let generalTermsTouched = false;
    form.querySelector('[data-general-terms]')?.addEventListener('input', () => { generalTermsTouched = true; });
    bindDeliveryFields(form, {
      units: deliveryUnits,
      stores: deliveryStores,
      companyAddress: companyAddressFallback(meta),
    });
    const isDirect = () => modeSelect.value === 'direct';
    const syncMode = () => {
      const direct = isDirect();
      form.querySelectorAll('[data-direct-block]').forEach((el) => el.classList.toggle('hidden', !direct));
      form.querySelector('[data-comp-block]')?.classList.toggle('hidden', direct);
    };
    const showError = (message) => {
      alertBox.innerHTML = `${icon('alert')} ${esc(message)}`;
      alertBox.classList.remove('hidden');
    };

    const bindLine = (row) => bindPoLine(row, form, itemList);
    lines.querySelectorAll('[data-po-line]').forEach(bindLine);
    renumberPoLines(form);
    recalcPoForm(form);
    bindRoundOffControl(form, () => recalcPoForm(form));
    modeSelect.addEventListener('change', syncMode);
    csSelect?.addEventListener('change', async () => {
      const selected = available.find((s) => String(s.id) === String(csSelect.value));
      info.innerHTML = selected
        ? `<b>${esc(selected.vendorName)}</b> \u00b7 ${esc(selected.rfqNo)} \u00b7 ${money(selected.totalQuoted)}<br />Lines, prices and taxes will be copied from the awarded quotation.`
        : 'Select a comparative statement to see the awarded vendor.';
      if (!selected || generalTermsTouched) return;
      const termsField = form.querySelector('[data-general-terms]');
      try {
        if (selected.quotationId) {
          const quotation = await api.get(`/api/procurement/quotations/${selected.quotationId}`);
          if (quotation.quotation?.generalTerms) {
            termsField.value = quotation.quotation.generalTerms;
            return;
          }
        }
        if (selected.rfqId) {
          const rfq = await api.get(`/api/procurement/rfqs/${selected.rfqId}`);
          if (rfq.rfq?.generalTerms) termsField.value = rfq.rfq.generalTerms;
        }
      } catch {
        /* Keep the setting default if source terms cannot be loaded. */
      }
    });
    ['discountPercent','discountAmount','freightCharges','loadingCharges','otherCharges'].forEach((n) => {
      form.querySelector(`[name="${n}"]`)?.addEventListener('input', () => recalcPoForm(form));
    });
    form.querySelector('[data-add-line]').addEventListener('click', () => {
      lines.insertAdjacentHTML('beforeend', poLineRow(itemList));
      bindLine(lines.querySelector('[data-po-line]:last-child'));
      renumberPoLines(form);
      recalcPoForm(form);
    });
    form.querySelector('[data-add-vendor]')?.addEventListener('click', () => {
      void openQuickAdd('vendor', form.vendorId);
    });
    form.querySelector('[data-add-item]')?.addEventListener('click', () => {
      void openQuickAdd('item', lines.querySelector('[data-item]'), {
        onCreated(record, values, freshMeta) {
          itemList.push({
            id: record.id,
            itemCode: record.itemCode || record.code,
            name: record.name,
            uomId: record.uomId,
            uomCode: record.uomCode,
            standardCost: record.standardCost,
          });
          window.__poUoms = freshMeta.uoms || window.__poUoms || [];
        },
      });
    });
    syncMode();

    ctx.view.querySelector('[data-save]').addEventListener('click', async () => {
      alertBox.classList.add('hidden');
      const doc = recalcPoForm(form);
      const common = {
        poDate: form.poDate.value || null,
        deliveryDate: form.deliveryDate.value || null,
        paymentTerms: form.paymentTerms.value.trim(),
        deliveryTerms: form.deliveryTerms.value.trim(),
        terms: form.terms.value.trim(),
        notes: form.notes.value.trim(),
        discountPercent: Number(form.discountPercent?.value) || 0,
        flatDiscountAmount: Number(form.discountAmount?.value) || 0,
        discountAmount: Number(form.discountAmount?.value) || 0,
        freightCharges: Number(form.freightCharges?.value) || 0,
        loadingCharges: Number(form.loadingCharges?.value) || 0,
        otherCharges: Number(form.otherCharges?.value) || 0,
        ...readDeliveryFields(form),
        roundOff: doc.roundOff,
      };
      let payload;
      if (isDirect()) {
        if (!form.unitId.value) return showError('Select a unit for the purchase order.');
        if (!form.vendorId.value) return showError('Select a vendor for the purchase order.');
        const lines = readPoLines(form);
        if (!lines.length) return showError('Add at least one item to the purchase order.');
        payload = {
          ...common,
          unitId: form.unitId.value,
          vendorId: form.vendorId.value,
          departmentId: form.departmentId.value || null,
          items: lines,
        };
      } else {
        if (!csSelect?.value) return showError('Select an approved comparative statement.');
        payload = { ...common, comparativeStatementId: csSelect.value };
      }
      try {
        const res = await api.post('/api/procurement/purchase-orders', payload);
        toast(`Purchase order ${res.poNo} created.`);
        navigate(`/purchase-orders/${res.id}/print?autoprint=1`);
      } catch (e) {
        showError(e.message);
      }
    });
    return;
  }

  const detail = await api.get(`/api/procurement/purchase-orders/${id}`);
  const po = detail.purchaseOrder;
  if (po.status !== 'draft') throw new Error('Only draft purchase orders can be edited.');
  let itemList = [];
  try {
    const reqMeta = await api.get('/api/procurement/requisitions/meta');
    itemList = reqMeta.items || [];
  } catch {
    itemList = [];
  }
  if (!itemList.length) {
    itemList = detail.items.map((line) => ({ id: line.itemId, name: line.itemName, itemCode: line.itemCode, uomId: line.uomId, uomCode: line.uomCode, standardCost: line.unitPrice }));
  }
  const uomMap = {};
  for (const it of itemList) if (it.uomId) uomMap[it.uomId] = it.uomCode;
  // also from detail items
  for (const l of detail.items) if (l.uomId) uomMap[l.uomId] = l.uomCode;
  window.__poUoms = Object.entries(uomMap).map(([id, code]) => ({ id: Number(id), code }));
  const formLines = detail.items.map(poLineForForm);
  const headerFlat = poHeaderFlatDiscount(po, detail.items);
  const initialLines = formLines.length ? formLines : [{ quantity: 1 }];
  const addressMeta = await loadPoAddressMeta([]);
  const deliveryUnits = addressMeta.units.length ? [...addressMeta.units] : [];
  const poUnitId = po.unitId || po.unit_id;
  if (poUnitId && !deliveryUnits.some((u) => String(u.id) === String(poUnitId))) {
    deliveryUnits.unshift({ id: poUnitId, name: po.unitName || 'PO unit' });
  }
  const deliveryStores = addressMeta.stores;
  const editGeneralTerms = generalTermsFallback({ generalTerms: po.generalTerms });

  ctx.view.innerHTML = `
    <div class="page-head">
      <div><h1>Edit ${esc(po.poNo)}</h1><div class="sub">${esc(po.vendorName)} \u00b7 ${esc(po.unitName)}</div></div>
      <div class="page-actions"><a class="btn" href="#/purchase-orders/${id}">${icon('arrowLeft')} Cancel</a>
        <button class="btn btn-primary" type="button" data-save>${icon('check')} Save changes</button></div>
    </div>
    <div id="po-alert" class="alert alert-danger hidden"></div>
    <form id="po-form" data-saved-round-off="${esc(po.roundOff ?? '')}">
      <div class="grid grid-2" style="align-items:start">
        <div class="stack">
          <div class="card">
            <div class="card-head"><div><h3>Order Details</h3><div class="sub">Dates and commercial terms</div></div></div>
            <div class="form-section">
              <div class="form-grid">
                ${field({ label: 'PO Date', name: 'poDate', type: 'date', value: po.poDate || '' })}
                ${field({ label: 'Delivery Date', name: 'deliveryDate', type: 'date', value: po.deliveryDate || '' })}
                ${field({ label: 'Payment Terms', name: 'paymentTerms', value: po.paymentTerms || '', span: true })}
                ${field({ label: 'Delivery Terms', name: 'deliveryTerms', value: po.deliveryTerms || '', span: true })}
                ${field({ label: 'Terms & conditions', name: 'terms', type: 'textarea', value: po.terms || '', span: true })}
                ${field({ label: 'Notes', name: 'notes', type: 'textarea', value: po.notes || '', span: true })}
              </div>
            </div>
          </div>
          <div class="card">
            <div class="card-head"><div><h3>Items</h3><div class="sub">Each line is a full-width card so every field stays readable while you type</div></div>
              <button class="btn btn-sm" type="button" data-add-line>${icon('plus')} Add line</button></div>
            <div class="po-lines" id="po-lines">${initialLines.map((line) => poLineRow(itemList, line)).join('')}</div>
            <div class="row" style="justify-content:flex-end;padding:12px 14px;border-top:1px solid var(--border)">
              <div style="text-align:right" class="small">
                <div class="row"><span class="muted">Taxable value</span><span data-po-subtotal>${money(0)}</span></div>
                <div class="row"><span class="muted">Discount</span><span data-po-line-discount>${money(0)}</span></div>
                <div class="row"><span class="muted">Header discount</span><span data-po-discount>${money(0)}</span></div>
                <div class="row"><span class="muted">Tax</span><span data-po-tax>${money(0)}</span></div>
                <div class="row"><span class="muted">Charges</span><span data-po-charges>${money(0)}</span></div>
                <div class="row"><span class="muted">Total before round off</span><span data-po-grand>${money(0)}</span></div>
                ${roundOffControl({ value: po?.roundOff ?? 0 })}
                <div class="row"><span class="muted">Total (rounded)</span><span class="strong" data-po-final>${money(0)}</span></div>
              </div>
            </div>
          </div>
          <div class="card">
            <div class="card-head"><div><h3>Discount &amp; Charges</h3><div class="sub">Header discount applies after tax; charges are added afterwards</div></div></div>
            <div class="form-section">
              <div class="form-grid">
                ${field({ label: 'Discount %', name: 'discountPercent', type: 'number', value: po.discountPercent ?? 0, attrs: 'min="0" max="100" step="0.01"' })}
                ${field({ label: 'Discount amount', name: 'discountAmount', type: 'number', value: headerFlat, attrs: 'min="0" step="0.01"', hint: 'Flat portion only; the percentage above is added separately.' })}
                ${field({ label: 'Freight Charges', name: 'freightCharges', type: 'number', value: po.freightCharges ?? 0 })}
                ${field({ label: 'Loading / Unloading', name: 'loadingCharges', type: 'number', value: po.loadingCharges ?? 0 })}
                ${field({ label: 'Other Charges', name: 'otherCharges', type: 'number', value: po.otherCharges ?? 0 })}
              </div>
            </div>
          </div>
        </div>
        <div class="stack">
          <div class="card">
            <div class="card-head"><div><h3>Source</h3></div></div>
            <div class="form-section">
              <div class="stack small">
                <div class="row"><span class="muted" style="width:120px">Vendor</span><span>${esc(po.vendorName)}</span></div>
                <div class="row"><span class="muted" style="width:120px">Source</span><span>${po.comparativeStatementId ? 'Comparative statement' : 'Direct entry'}</span></div>
                <div class="row"><span class="muted" style="width:120px">RFQ</span><span>${po.rfqId ? `<a href="#/sourcing/${po.rfqId}">${esc(po.rfqNo)}</a>` : '\u2014'}</span></div>
                <div class="row"><span class="muted" style="width:120px">Comparative</span><span>${esc(po.csNo || '\u2014')}</span></div>
                <div class="row"><span class="muted" style="width:120px">Quotation</span><span>${esc(po.quotationNo || '\u2014')}</span></div>
                <div class="row"><span class="muted" style="width:120px">Requisition</span><span>${po.requisitionId ? `<a href="#/requisitions/${po.requisitionId}">${esc(po.requisitionNo)}</a>` : '\u2014'}</span></div>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div class="card" style="margin-top:14px">
        <div class="card-head"><div><h3>Billing, Shipping &amp; Delivery Contact</h3><div class="sub">Addresses resolve from masters unless a custom address is chosen</div></div></div>
        <div class="form-section">
          ${deliveryFieldsHtml({
            po: { ...po, unitId: poUnitId },
            units: deliveryUnits,
            stores: deliveryStores,
            generalTerms: editGeneralTerms,
            companyAddress: companyAddressFallback(),
          })}
        </div>
      </div>
    </form>`;

  const form = document.getElementById('po-form');
  const alertBox = document.getElementById('po-alert');
  const lines = form.querySelector('#po-lines');
  lines.querySelectorAll('[data-po-line]').forEach((row) => bindPoLine(row, form, itemList));
  bindDeliveryFields(form, {
    units: deliveryUnits,
    stores: deliveryStores,
    companyAddress: companyAddressFallback(),
  });
  renumberPoLines(form);
  ['discountPercent','discountAmount','freightCharges','loadingCharges','otherCharges'].forEach((n) => {
    form.querySelector(`[name="${n}"]`)?.addEventListener('input', () => recalcPoForm(form));
  });
  recalcPoForm(form);
  bindRoundOffControl(form, () => recalcPoForm(form));
  form.querySelector('[data-add-line]').addEventListener('click', () => {
    lines.insertAdjacentHTML('beforeend', poLineRow(itemList));
    bindPoLine(lines.querySelector('[data-po-line]:last-child'), form, itemList);
    renumberPoLines(form);
    recalcPoForm(form);
  });

  ctx.view.querySelector('[data-save]').addEventListener('click', async () => {
    alertBox.classList.add('hidden');
    const lines = readPoLines(form);
    if (!lines.length) {
      alertBox.textContent = 'Add at least one item.';
      alertBox.classList.remove('hidden');
      return;
    }
    const doc = recalcPoForm(form);
    try {
      await api.put(`/api/procurement/purchase-orders/${id}`, {
        poDate: form.poDate.value || null,
        deliveryDate: form.deliveryDate.value || null,
        paymentTerms: form.paymentTerms.value.trim(),
        deliveryTerms: form.deliveryTerms.value.trim(),
        terms: form.terms.value.trim(),
        notes: form.notes.value.trim(),
        discountPercent: Number(form.discountPercent?.value) || 0,
        flatDiscountAmount: Number(form.discountAmount?.value) || 0,
        discountAmount: Number(form.discountAmount?.value) || 0,
        freightCharges: Number(form.freightCharges?.value) || 0,
        loadingCharges: Number(form.loadingCharges?.value) || 0,
        otherCharges: Number(form.otherCharges?.value) || 0,
        ...readDeliveryFields(form),
        roundOff: doc.roundOff,
        items: lines,
      });
      toast('Purchase order updated.');
      navigate(`/purchase-orders/${id}`);
    } catch (e) {
      alertBox.innerHTML = `${icon('alert')} ${esc(e.message)}`;
      alertBox.classList.remove('hidden');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  });
}

/* ================================================================== */
/* PURCHASE ORDER DETAIL                                               */
/* ================================================================== */
export async function renderDetail(ctx, options = {}) {
  const id = Number(options.id);
  ctx.view.innerHTML = `<div class="empty">Loading purchase order\u2026</div>`;
  const detail = await api.get(`/api/procurement/purchase-orders/${id}`);
  const po = detail.purchaseOrder;
  const actions = detail.actions || {};
  const items = detail.items || [];
  const grns = detail.grns || [];
  const invoices = detail.invoices || [];
  const photos = detail.photos || [];
  const canManagePhotos = can('po.manage');
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
      <div><h1>${esc(po.poNo)}</h1>
        <div class="sub">${esc(po.vendorName)} \u00b7 ${esc(po.unitName)}${po.departmentName ? ` \u00b7 ${esc(po.departmentName)}` : ''}</div></div>
      <div class="page-actions">
        <a class="btn" href="#/purchase-orders">${icon('arrowLeft')} Back</a>
        <a class="btn" href="#/purchase-orders/${po.id}/print">${icon('printer')} Print / PDF</a>
        ${actions.canEdit ? `<a class="btn" href="#/purchase-orders/${po.id}/edit">${icon('edit')} Edit</a>` : ''}
        ${actions.canIssue ? `<button class="btn btn-primary" type="button" data-issue>${icon('send')} Issue PO</button>` : ''}
        ${actions.canReceive ? `<a class="btn btn-primary" href="#/grns/new?poId=${po.id}">${icon('database')} Record Receipt</a>` : ''}
        ${actions.canInvoice ? `<a class="btn" href="#/invoices/new?poId=${po.id}">${icon('file')} Raise Invoice</a>` : ''}
        ${actions.canRevise ? `<button class="btn" type="button" data-revise>${icon('edit')} Revise</button>` : ''}
        ${actions.canCancel ? `<button class="btn btn-danger" type="button" data-cancel>${icon('xCircle')} Cancel</button>` : ''}
        ${actions.canDelete ? `<button class="btn btn-danger" type="button" data-delete>${icon('trash')} Delete</button>` : ''}
      </div>
    </div>

    <div class="grid grid-4 mb-16">
      <div class="card"><div class="kpi"><div class="chip gray">${icon('briefcase')}</div><div><div class="label">Status</div><div class="value small-value">${statusOf(po.status, PO_STATUS)}</div><div class="meta">Revision ${num(po.revisionNo)}</div></div></div></div>
      <div class="card"><div class="kpi"><div class="chip blue">${icon('layers')}</div><div><div class="label">Order value</div><div class="value small-value">${money(po.totalAmount)}</div><div class="meta">${num(po.itemCount)} line${po.itemCount === 1 ? '' : 's'}</div></div></div></div>
      <div class="card"><div class="kpi"><div class="chip amber">${icon('database')}</div><div><div class="label">Receipts</div><div class="value small-value">${num(grns.filter((g) => g.status === 'posted').length)}</div><div class="meta">${num(grns.length)} recorded</div></div></div></div>
      <div class="card"><div class="kpi"><div class="chip teal">${icon('file')}</div><div><div class="label">Invoices</div><div class="value small-value">${num(invoices.length)}</div><div class="meta">${invoices.length ? money(invoices.reduce((sum, i) => sum + (i.netAmount || 0), 0)) : 'None raised'}</div></div></div></div>
    </div>

    <div class="grid grid-2" style="align-items:start">
      <div class="stack">
        <div class="card">
          <div class="card-head"><div><h3>Order Items</h3><div class="sub">Ordered, received and invoiced quantities</div></div></div>
          <div class="table-wrap">
            <table class="tbl">
              <thead><tr><th>Item</th><th class="num">Ordered</th><th class="num">Received</th><th class="num">Rejected</th><th class="num">Invoiced</th><th class="num">Price</th><th class="num">Disc</th><th class="num">Taxable</th><th class="num">Basis</th><th class="num">Total</th></tr></thead>
              <tbody>${items.map((line) => `<tr>
                <td><span class="strong">${esc(line.itemName)}</span><div class="small muted mono">${esc(line.itemCode)}</div></td>
                <td class="num">${num(line.quantity)} <span class="small muted">${esc(line.uomCode)}</span></td>
                <td class="num">${num(line.receivedQuantity)}</td>
                <td class="num">${num(line.rejectedQuantity)}</td>
                <td class="num">${num(line.invoicedQuantity)}</td>
                <td class="num">${money(line.unitPrice)}</td>
                <td class="num">${money(line.discountAmount)}${line.discountPercent ? `<div class="small muted">${num(line.discountPercent)}%</div>` : ''}</td>
                <td class="num">${money(line.taxableAmount)}</td>
                <td class="num small">${line.taxInclusive ? 'Incl.' : 'Excl.'}<div class="small muted">${num(line.taxRate)}%</div></td>
                <td class="num">${money(line.totalAmount)}</td>
              </tr>`).join('')}</tbody>
            </table>
          </div>
          <div class="row" style="justify-content:flex-end;padding:12px 14px;border-top:1px solid var(--border)">
            <div style="text-align:right" class="small">
              <div class="row"><span class="muted">Taxable value</span><span>${money(po.subtotal)}</span></div>
              <div class="row"><span class="muted">Discount</span><span>${money(items.reduce((s, l) => s + (Number(l.discountAmount) || 0), 0))}</span></div>
              <div class="row"><span class="muted">Header discount${po.discountPercent ? ` (${num(po.discountPercent)}%)` : ''}</span><span>${money(po.discountAmount)}</span></div>
              <div class="row"><span class="muted">Tax</span><span>${money(po.taxAmount)}</span></div>
              <div class="row"><span class="muted">Charges</span><span>${money((po.freightCharges || 0) + (po.loadingCharges || 0) + (po.otherCharges || 0))}</span></div>
              <div class="row"><span class="muted">Total before round off</span><span>${money(po.baseTotalAmount ?? round2((po.totalAmount || 0) - (po.roundOff || 0)))}</span></div>
              <div class="row"><span class="muted">Round off</span><span>${money(po.roundOff || 0)}</span></div>
              <div class="row"><span class="muted">Total (rounded)</span><span class="strong">${money(po.totalAmount)}</span></div>
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card-head"><div><h3>Goods Receipts</h3><div class="sub">Receipts recorded against this order</div></div>
            ${actions.canReceive ? `<a class="btn btn-sm" href="#/grns/new?poId=${po.id}">${icon('plus')} New receipt</a>` : ''}</div>
          <div class="table-wrap">
            ${grns.length
              ? `<table class="tbl"><thead><tr><th>GRN</th><th>Received</th><th>Store</th><th class="num">Items</th><th>Status</th><th></th></tr></thead>
                <tbody>${grns.map((g) => `<tr>
                  <td><a class="strong" href="#/grns/${g.id}">${esc(g.grnNo)}</a></td>
                  <td class="small">${fmtDate(g.receivedDate)}<div class="small muted">${esc(g.receivedByName)}</div></td>
                  <td class="small">${esc(g.storeName || '\u2014')}</td>
                  <td class="num">${num(g.itemCount)}</td>
                  <td>${statusOf(g.status, GRN_STATUS)}</td>
                  <td class="actions"><a class="btn btn-sm btn-ghost" href="#/grns/${g.id}">${icon('eye')}</a></td>
                </tr>`).join('')}</tbody></table>`
              : '<div class="empty small" style="padding:24px">No receipts recorded yet.</div>'}
          </div>
        </div>

        <div class="card">
          <div class="card-head"><div><h3>Invoices</h3><div class="sub">Procurement invoices raised against this order</div></div>
            ${actions.canInvoice ? `<a class="btn btn-sm" href="#/invoices/new?poId=${po.id}">${icon('plus')} Raise invoice</a>` : ''}</div>
          <div class="table-wrap">
            ${invoices.length
              ? `<table class="tbl"><thead><tr><th>Invoice</th><th>Supplier invoice</th><th class="num">Net</th><th>Status</th><th>ABMDAS bill</th><th></th></tr></thead>
                <tbody>${invoices.map((i) => `<tr>
                  <td><a class="strong" href="#/invoices/${i.id}">${esc(i.invoiceNo)}</a></td>
                  <td class="small">${esc(i.supplierInvoiceNo)}</td>
                  <td class="num">${money(i.netAmount)}</td>
                  <td>${statusBadge(i.status, INVOICE_STATUS[i.status] || i.status)}</td>
                  <td>${i.abmdasBillId ? `<a href="#/bills/${i.abmdasBillId}">View bill</a>` : '<span class="muted">\u2014</span>'}</td>
                  <td class="actions"><a class="btn btn-sm btn-ghost" href="#/invoices/${i.id}">${icon('eye')}</a></td>
                </tr>`).join('')}</tbody></table>`
              : '<div class="empty small" style="padding:24px">No invoices raised yet.</div>'}
          </div>
        </div>
      </div>

      <div class="stack">
        <div class="card">
          <div class="card-head"><div><h3>Terms &amp; Source</h3></div></div>
          <div class="form-section">
            <div class="stack small">
              <div class="row"><span class="muted" style="width:130px">PO date</span><span>${fmtDate(po.poDate)}</span></div>
              <div class="row"><span class="muted" style="width:130px">Delivery date</span><span>${po.deliveryDate ? fmtDate(po.deliveryDate) : '\u2014'}</span></div>
              <div class="row"><span class="muted" style="width:130px">Payment terms</span><span>${esc(po.paymentTerms || '\u2014')}</span></div>
              <div class="row"><span class="muted" style="width:130px">Delivery terms</span><span>${esc(po.deliveryTerms || '\u2014')}</span></div>
              <div class="row"><span class="muted" style="width:130px">Source</span><span>${po.comparativeStatementId ? 'Comparative statement' : 'Direct entry'}</span></div>
              <div class="row"><span class="muted" style="width:130px">RFQ</span><span>${po.rfqId ? `<a href="#/sourcing/${po.rfqId}">${esc(po.rfqNo)}</a>` : '\u2014'}</span></div>
              <div class="row"><span class="muted" style="width:130px">Comparative</span><span>${esc(po.csNo || '\u2014')}</span></div>
              <div class="row"><span class="muted" style="width:130px">Quotation</span><span>${esc(po.quotationNo || '\u2014')}</span></div>
              <div class="row"><span class="muted" style="width:130px">Requisition</span><span>${po.requisitionId ? `<a href="#/requisitions/${po.requisitionId}">${esc(po.requisitionNo)}</a>` : '\u2014'}</span></div>
              <div class="row"><span class="muted" style="width:130px">Issued</span><span>${po.issuedAt ? `${fmtDate(po.issuedAt, true)}${po.issuedByName ? ` \u00b7 ${esc(po.issuedByName)}` : ''}` : '\u2014'}</span></div>
              ${po.cancelReason ? `<div class="row"><span class="muted" style="width:130px">Cancel reason</span><span>${esc(po.cancelReason)}</span></div>` : ''}
              ${po.notes ? `<div class="row"><span class="muted" style="width:130px">Notes</span><span>${esc(po.notes)}</span></div>` : ''}
              ${po.terms ? `<div class="row"><span class="muted" style="width:130px">Terms</span><span>${esc(po.terms)}</span></div>` : ''}
              ${po.generalTerms ? `<div class="row"><span class="muted" style="width:130px">General terms</span><span>${esc(po.generalTerms)}</span></div>` : ''}
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card-head"><div><h3>Billing &amp; Delivery</h3><div class="sub">Address and contact details printed on the order</div></div></div>
          <div class="form-section">
            <div class="stack small">
              <div class="row"><span class="muted" style="width:130px">Billing source</span><span>${esc(po.billingAddressSource || 'unit')}</span></div>
              <div class="row"><span class="muted" style="width:130px">Billing address</span><span>${esc(po.billingAddress || '—')}</span></div>
              <div class="row"><span class="muted" style="width:130px">Shipping source</span><span>${esc(po.shippingLocationType || 'billing')}</span></div>
              <div class="row"><span class="muted" style="width:130px">Shipping location</span><span>${esc(po.shippingLocationLabel || '—')}</span></div>
              <div class="row"><span class="muted" style="width:130px">Shipping address</span><span>${esc(po.shippingAddress || '—')}</span></div>
              <div class="row"><span class="muted" style="width:130px">Delivery contact</span><span>${esc([po.deliveryContactName, po.deliveryContactDesignation].filter(Boolean).join(' · ') || '—')}</span></div>
              <div class="row"><span class="muted" style="width:130px">Mobile</span><span>${esc(po.deliveryContactMobile || '—')}</span></div>
              <div class="row"><span class="muted" style="width:130px">Email</span><span>${esc(po.deliveryContactEmail || '—')}</span></div>
              ${parseContacts(po.additionalContacts).length ? `<div class="row"><span class="muted" style="width:130px">Other contacts</span><span>${parseContacts(po.additionalContacts).map((c) => esc([c.name, c.mobile, c.email].filter(Boolean).join(' · '))).join('<br />')}</span></div>` : ''}
            </div>
          </div>
        </div>

        <div class="card" id="po-photos-card">
          <div class="card-head"><div><h3>Reference Photos</h3><div class="sub">Optional photos printed on the purchase order when attached</div></div></div>
          <div class="form-section">
            <div class="po-photo-list" id="po-photo-list">
              ${photos.length
                ? photos.map((photo) => `<div class="po-photo-item" data-photo-id="${photo.id}">
                    <a href="${esc(photo.url)}" target="_blank" rel="noopener noreferrer" title="Open photo">
                      <img src="${esc(photo.url)}" alt="${esc(photo.caption || photo.fileName)}" />
                    </a>
                    <div class="small muted">${esc(photo.caption || photo.fileName)}</div>
                    ${canManagePhotos ? `<button type="button" class="btn btn-sm btn-ghost" data-remove-photo="${photo.id}" title="Remove photo">${icon('trash')}</button>` : ''}
                  </div>`).join('')
                : '<div class="hint">No reference photos attached. Photos appear in the print only when attached.</div>'}
            </div>
            ${canManagePhotos && photos.length < 6 ? `
              <form id="po-photo-form" class="form-grid" style="margin-top:12px">
                <div class="field span-2"><label>Photo (JPEG, PNG or WebP, up to 5 MB)</label>
                  <input class="input" type="file" name="photo" accept="image/jpeg,image/png,image/webp" required /></div>
                <div class="field span-2"><label>Caption (optional)</label>
                  <input class="input" name="caption" maxlength="200" placeholder="e.g. Product sample" /></div>
                <div class="field span-2"><button class="btn btn-sm btn-primary" type="submit">${icon('plus')} Attach photo</button></div>
              </form>` : ''}
          </div>
        </div>

        <div class="card">
          <div class="card-head"><div><h3>Revisions</h3><div class="sub">Snapshots taken before each revision</div></div></div>
          <div class="form-section">
            ${(detail.revisions || []).length
              ? `<div class="stack">${detail.revisions.map((rev) => `<div style="padding:8px 0;border-bottom:1px solid var(--border)">
                  <div class="row"><span class="strong">Revision ${num(rev.revisionNo)}</span><span class="spacer"></span><span class="small muted">${fmtDate(rev.revisedAt, true)}</span></div>
                  <div class="small">${esc(rev.reason)}</div>
                  <div class="small muted">${esc(rev.revisedByName || '')}</div>
                </div>`).join('')}</div>`
              : '<div class="hint">No revisions. Issued purchase orders can be revised with a recorded reason.</div>'}
          </div>
        </div>
      </div>
    </div>`;

  const photoForm = ctx.view.querySelector('#po-photo-form');
  photoForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = photoForm.querySelector('[name=photo]');
    const file = input.files && input.files[0];
    if (!file) {
      toast('Choose a photo first.', 'error');
      return;
    }
    try {
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(new Error('Could not read the photo.'));
        reader.readAsDataURL(file);
      });
      const data = dataUrl.includes(',') ? dataUrl.slice(dataUrl.indexOf(',') + 1) : '';
      await api.post(`/api/procurement/purchase-orders/${id}/photos`, {
        fileName: file.name,
        mimeType: file.type,
        data,
        caption: photoForm.querySelector('[name=caption]').value.trim(),
      });
      toast('Reference photo attached.');
      await refresh();
    } catch (err) {
      toast(err.message || 'Could not attach the photo.', 'error');
    }
  });
  ctx.view.querySelectorAll('[data-remove-photo]').forEach((button) => {
    button.addEventListener('click', async () => {
      const ok = await confirmDialog({
        title: 'Remove reference photo',
        message: 'Remove this photo from the purchase order? It will no longer appear in the print.',
        confirmText: 'Remove photo',
        danger: true,
      });
      if (!ok) return;
      try {
        await api.del(`/api/procurement/purchase-orders/${id}/photos/${button.dataset.removePhoto}`);
        toast('Reference photo removed.');
        await refresh();
      } catch (err) {
        toast(err.message || 'Could not remove the photo.', 'error');
      }
    });
  });

  ctx.view.querySelector('[data-issue]')?.addEventListener('click', async () => {
    const ok = await confirmDialog({ title: 'Issue purchase order', message: 'Issue this PO to the vendor? Receipts can then be recorded.', confirmText: 'Issue PO' });
    if (ok) {
      try {
        await api.post(`/api/procurement/purchase-orders/${id}/issue`);
        toast('Purchase order issued.', 'success');
        navigate(`/purchase-orders/${id}/print?autoprint=1`);
      } catch (err) {
        toast(err.message || 'Action failed.', 'error');
      }
    }
  });

  ctx.view.querySelector('[data-cancel]')?.addEventListener('click', async () => {
    const result = await actionDialog({ title: 'Cancel purchase order', subtitle: 'The PO remains in the audit trail.', requireComment: true, confirmText: 'Cancel PO', danger: true });
    if (!result) return;
    await act(() => api.post(`/api/procurement/purchase-orders/${id}/cancel`, { reason: result.comments }), 'Purchase order cancelled.');
  });

  ctx.view.querySelector('[data-delete]')?.addEventListener('click', async () => {
    const ok = await confirmDialog({ title: 'Delete draft purchase order', message: 'Delete this draft? It is retained for audit and hidden from lists.', confirmText: 'Delete draft', danger: true });
    if (!ok) return;
    await act(async () => {
      await api.del(`/api/procurement/purchase-orders/${id}`);
      navigate('/purchase-orders');
    }, 'Draft purchase order deleted.');
  });

  ctx.view.querySelector('[data-revise]')?.addEventListener('click', async () => {
    let itemList = [];
    try {
      const reqMeta = await api.get('/api/procurement/requisitions/meta');
      itemList = reqMeta.items || [];
    } catch {
      itemList = [];
    }
    if (!itemList.length) {
      itemList = items.map((line) => ({ id: line.itemId, name: line.itemName, itemCode: line.itemCode, uomCode: line.uomCode, standardCost: line.unitPrice }));
    }
    const formItems = items.map(poLineForForm);
    const headerFlat = poHeaderFlatDiscount(po, items);
    const addressMeta = await loadPoAddressMeta([]);
    const deliveryUnits = addressMeta.units.length ? [...addressMeta.units] : [];
    const poUnitId = po.unitId || po.unit_id;
    if (poUnitId && !deliveryUnits.some((u) => String(u.id) === String(poUnitId))) {
      deliveryUnits.unshift({ id: poUnitId, name: po.unitName || 'PO unit' });
    }
    modal({
      title: `Revise ${po.poNo}`,
      subtitle: `${po.vendorName} \u00b7 revision ${num(po.revisionNo + 1)}`,
      size: 'lg',
      body: `<div class="form-grid">
          <div class="field span-2"><label>Revision reason<span class="req">*</span></label>
            <textarea class="textarea" data-rev-reason rows="2" placeholder="Why is this purchase order being revised?"></textarea></div>
          <div class="field"><label>PO date</label><input class="input" type="date" data-rev-date value="${esc(po.poDate || '')}" /></div>
          <div class="field"><label>Delivery date</label><input class="input" type="date" data-rev-delivery value="${esc(po.deliveryDate || '')}" /></div>
          <div class="field span-2"><label>Payment terms</label><input class="input" data-rev-payment value="${esc(po.paymentTerms || '')}" /></div>
          <div class="field span-2"><label>Delivery terms</label><input class="input" data-rev-dterms value="${esc(po.deliveryTerms || '')}" /></div>
          <div class="field span-2"><label>Notes</label><textarea class="textarea" data-rev-notes rows="2">${esc(po.notes || '')}</textarea></div>
          <div class="field"><label>Discount %</label><input class="input" name="discountPercent" type="number" min="0" max="100" step="0.01" value="${esc(po.discountPercent ?? 0)}" /></div>
          <div class="field"><label>Discount amount</label><input class="input" name="discountAmount" type="number" min="0" step="0.01" value="${esc(headerFlat)}" /></div>
          <div class="field"><label>Freight charges</label><input class="input" name="freightCharges" type="number" min="0" step="0.01" value="${esc(po.freightCharges ?? 0)}" /></div>
          <div class="field"><label>Loading / unloading</label><input class="input" name="loadingCharges" type="number" min="0" step="0.01" value="${esc(po.loadingCharges ?? 0)}" /></div>
          <div class="field"><label>Other charges</label><input class="input" name="otherCharges" type="number" min="0" step="0.01" value="${esc(po.otherCharges ?? 0)}" /></div>
        </div>
        <div class="po-lines compact" id="rev-lines" style="margin-top:8px">${formItems.map((line) => poLineRow(itemList, line)).join('')}</div>
        <div class="row" style="justify-content:flex-end;margin-top:10px">
          <div style="text-align:right" class="small">
            <div class="row"><span class="muted">Taxable value</span><span data-po-subtotal>${money(0)}</span></div>
            <div class="row"><span class="muted">Discount</span><span data-po-line-discount>${money(0)}</span></div>
            <div class="row"><span class="muted">Header discount</span><span data-po-discount>${money(0)}</span></div>
            <div class="row"><span class="muted">Tax</span><span data-po-tax>${money(0)}</span></div>
            <div class="row"><span class="muted">Charges</span><span data-po-charges>${money(0)}</span></div>
            <div class="row"><span class="muted">Total before round off</span><span data-po-grand>${money(0)}</span></div>
            ${roundOffControl({ value: po?.roundOff ?? 0 })}
            <div class="row"><span class="muted">Total (rounded)</span><span class="strong" data-po-final>${money(0)}</span></div>
          </div>
        </div>
        <div style="margin-top:12px;border-top:1px solid var(--border);padding-top:10px">
          <div class="small strong" style="margin-bottom:8px">Billing, shipping &amp; delivery contact</div>
          ${deliveryFieldsHtml({
            po: { ...po, unitId: poUnitId },
            units: deliveryUnits,
            stores: addressMeta.stores,
            generalTerms: generalTermsFallback({ generalTerms: po.generalTerms }),
            companyAddress: companyAddressFallback(),
          })}
        </div>
        <div class="alert alert-danger hidden" data-err style="margin-top:10px"></div>`,
      footer: `<button class="btn" data-modal-close>Cancel</button><button class="btn btn-primary" data-save>Save revision</button>`,
      onMount(el, close) {
        const fakeForm = el;
        el.dataset.savedRoundOff = po.roundOff ?? '';
        // Bind the modal's line cards with the same helpers used by the PO form.
        el.querySelectorAll('[data-po-line]').forEach((row) => bindPoLine(row, fakeForm, itemList));
        bindDeliveryFields(el, {
          units: deliveryUnits,
          stores: addressMeta.stores,
          companyAddress: companyAddressFallback(),
        });
        ['discountPercent','discountAmount','freightCharges','loadingCharges','otherCharges'].forEach((n) => {
          el.querySelector(`[name="${n}"]`)?.addEventListener('input', () => recalcPoForm(fakeForm));
        });
        renumberPoLines(fakeForm);
        recalcPoForm(fakeForm);
        bindRoundOffControl(fakeForm, () => recalcPoForm(fakeForm));

        el.querySelector('[data-save]').addEventListener('click', async () => {
          const errBox = el.querySelector('[data-err]');
          errBox.classList.add('hidden');
          const reason = el.querySelector('[data-rev-reason]').value.trim();
          if (!reason) {
            errBox.textContent = 'A revision reason is required.';
            errBox.classList.remove('hidden');
            return;
          }
          const lines = readPoLines(el);
          if (!lines.length) {
            errBox.textContent = 'A purchase order needs at least one line.';
            errBox.classList.remove('hidden');
            return;
          }
          const doc = recalcPoForm(el);
          try {
            const res = await api.post(`/api/procurement/purchase-orders/${id}/revise`, {
              reason,
              ...readDeliveryFields(el),
              roundOff: doc.roundOff,
              poDate: el.querySelector('[data-rev-date]').value || null,
              deliveryDate: el.querySelector('[data-rev-delivery]').value || null,
              paymentTerms: el.querySelector('[data-rev-payment]').value.trim(),
              deliveryTerms: el.querySelector('[data-rev-dterms]').value.trim(),
              notes: el.querySelector('[data-rev-notes]').value.trim(),
              discountPercent: Number(el.querySelector('[name="discountPercent"]')?.value) || 0,
              flatDiscountAmount: Number(el.querySelector('[name="discountAmount"]')?.value) || 0,
              discountAmount: Number(el.querySelector('[name="discountAmount"]')?.value) || 0,
              freightCharges: Number(el.querySelector('[name="freightCharges"]')?.value) || 0,
              loadingCharges: Number(el.querySelector('[name="loadingCharges"]')?.value) || 0,
              otherCharges: Number(el.querySelector('[name="otherCharges"]')?.value) || 0,
              items: lines,
            });
            close();
            toast(`Revision ${res.revisionNo} recorded.`);
            await refresh();
          } catch (e) {
            errBox.textContent = e.message;
            errBox.classList.remove('hidden');
          }
        });
      },
    });
  });
}

/* ================================================================== */
/* PURCHASE ORDER PRINT                                                */
/* ================================================================== */
/* Amount in words using the Indian numbering system (for the printed PO). */
function amountInWords(value) {
  const total = Math.round((Number(value) || 0) * 100);
  let rupees = Math.floor(total / 100);
  const paise = total % 100;
  const ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
    'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
  const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
  const two = (n) => (n < 20 ? ones[n] : `${tens[Math.floor(n / 10)]}${n % 10 ? ` ${ones[n % 10]}` : ''}`);
  const three = (n) => {
    const hundred = Math.floor(n / 100);
    const rest = n % 100;
    return `${hundred ? `${ones[hundred]} Hundred${rest ? ' ' : ''}` : ''}${rest ? two(rest) : ''}`;
  };
  const parts = [];
  const crore = Math.floor(rupees / 10000000); rupees %= 10000000;
  const lakh = Math.floor(rupees / 100000); rupees %= 100000;
  const thousand = Math.floor(rupees / 1000); rupees %= 1000;
  if (crore) parts.push(`${three(crore)} Crore`);
  if (lakh) parts.push(`${two(lakh)} Lakh`);
  if (thousand) parts.push(`${two(thousand)} Thousand`);
  if (rupees) parts.push(three(rupees));
  let words = `Rupees ${parts.join(' ') || 'Zero'}`;
  if (paise) words += ` and ${two(paise)} Paise`;
  return `${words} Only`;
}

function gstStateCode(value) {
  const match = String(value || '').match(/^\s*(\d{2})/);
  return match ? match[1] : '';
}

function normaliseStateName(value) {
  return String(value || '')
    .replace(/^\s*\d{2}\s*[-–:.]?\s*/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function isSameGstState(orgState, orgGstin, vendorState, vendorGstin) {
  const orgCode = gstStateCode(orgGstin) || gstStateCode(orgState);
  const vendorCode = gstStateCode(vendorGstin) || gstStateCode(vendorState);
  if (orgCode && vendorCode) return orgCode === vendorCode;
  const orgName = normaliseStateName(orgState);
  const vendorName = normaliseStateName(vendorState);
  return !!(orgName && vendorName && orgName === vendorName);
}

export async function renderPrint(ctx, options = {}) {
  const id = Number(options.id);
  ctx.view.innerHTML = `<div class="empty">Loading purchase order…</div>`;
  const detail = await api.get(`/api/procurement/purchase-orders/${id}`);
  const po = detail.purchaseOrder;
  const items = detail.items || [];
  const photos = detail.photos || [];
  const totalQuantity = items.reduce((sum, line) => sum + (Number(line.quantity) || 0), 0);
  const quantityUnits = [...new Set(items.map((line) => String(line.uomCode || '').trim()).filter(Boolean))];
  const quantitySuffix = quantityUnits.length === 1 ? ` ${quantityUnits[0]}` : '';

  const org = await api.get('/api/meta/bootstrap').catch(() => ({}));
  const s = org.settings || {};
  const orgName = s.orgName || 'New Life AG Church';
  const orgAddress = s.orgAddress || companyAddressFallback(org) || '';
  const orgPhone = s.orgPhone || '';
  const orgEmail = s.orgEmail || '';
  const orgWebsite = s.orgWebsite || '';
  const orgGstin = s.orgGstin || '';
  const orgPan = s.orgPan || '';
  const orgGstState = s.orgGstState || '';
  const companyAddress = po.billingAddress || orgAddress;
  const shippingAddress = po.shippingAddress || companyAddress;
  const vendorState = po.vendorState || '';
  const sameState = isSameGstState(orgGstState, orgGstin, vendorState, po.vendorGstin);

  const gstSplit = (line) => {
    const tax = Number(line.taxAmount) || 0;
    if (!tax) return { cgst: 0, sgst: 0, igst: 0 };
    return sameState
      ? { cgst: round2(tax / 2), sgst: round2(tax / 2), igst: 0 }
      : { cgst: 0, sgst: 0, igst: round2(tax) };
  };
  const gstTotals = items.reduce((acc, line) => {
    const split = gstSplit(line);
    acc.cgst = round2(acc.cgst + split.cgst);
    acc.sgst = round2(acc.sgst + split.sgst);
    acc.igst = round2(acc.igst + split.igst);
    return acc;
  }, { cgst: 0, sgst: 0, igst: 0 });

  /* Zero values are suppressed completely - label and value cell - on the
   * vendor-facing purchase order. */
  const nz = (value) => round2(value) !== 0;
  const moneyIf = (value) => (nz(value) ? money(value) : '');
  const rateIf = (value) => (nz(value) ? `${num(value)}%` : '');
  const totalRow = (label, value) => (nz(value)
    ? `<div class="rp-total-row"><span>${esc(label)}</span><span>${money(value)}</span></div>`
    : '');
  const textRow = (label, value) => (value
    ? `<div><span class="k">${esc(label)} :</span> ${esc(value)}</div>`
    : '');

  const lineDiscount = round2(items.reduce((sum, line) => sum + (Number(line.discountAmount) || 0), 0));
  const hasLineDiscount = nz(lineDiscount);
  const lineTaxable = round2(items.reduce((sum, line) => sum + (Number(line.taxableAmount) || 0), 0));
  const taxableValue = Number(po.subtotal) || lineTaxable;
  const hasSplitGst = sameState && items.some((line) => nz(line.taxRate));
  const hasIgst = !sameState && items.some((line) => nz(line.taxRate));
  const hasSgstRate = hasSplitGst;
  const hasCgstRate = hasSplitGst;
  const hasSgstAmount = nz(gstTotals.sgst);
  const hasCgstAmount = nz(gstTotals.cgst);
  const hasIgstAmount = nz(gstTotals.igst);
  const hasLineTotal = items.some((line) => nz(line.totalAmount));

  const docDate = /^\d{4}-\d{2}-\d{2}/.test(String(po.poDate || ''))
    ? String(po.poDate).slice(0, 10).split('-').reverse().join('/')
    : (po.poDate ? fmtDate(po.poDate) : '');

  const vendorAddressLine1 = [po.vendorAddress1, po.vendorAddress2].filter(Boolean).join(', ');
  const vendorAddressLine2 = [po.vendorCity, po.vendorState, po.vendorPincode].filter(Boolean).join(' ');

  const orgLines = [
    orgAddress,
    [orgPhone ? `Phone : ${orgPhone}` : '', orgEmail ? `Email : ${orgEmail}` : ''].filter(Boolean).join(', '),
    orgWebsite ? `Web Site : ${orgWebsite}` : '',
    [
      orgGstin ? `GST No : ${orgGstin}` : '',
      orgPan ? `PAN No : ${orgPan}` : '',
      orgGstState ? `GST State : ${orgGstState}` : '',
    ].filter(Boolean).join('   '),
  ].filter(Boolean);

  const termsLines = [po.generalTerms, po.terms]
    .filter(Boolean)
    .join('\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const contactLine = [po.deliveryContactName, po.deliveryContactMobile].filter(Boolean).join(' · ');
  const shippingBlock = `
    <div class="rp-bottom-shipping">
      <div class="rp-bottom-title">Shipping Address :</div>
      <div>${esc(shippingAddress || orgName)}</div>
      ${textRow('GST No', orgGstin)}
      ${contactLine ? `<div><span class="k">Contact No :</span> ${esc(contactLine)}</div>` : ''}
      ${po.deliveryDate ? `<div><span class="k">Delivery :</span> ${esc(fmtDate(po.deliveryDate))}</div>` : ''}
    </div>`;

  /* Keep Chrome's date/time and URL header/footer off this document even on
     browsers without named-page support: a document-level zero page margin.
     app.js removes this style when the user leaves the PO print route. */
  document.getElementById('po-print-page-style')?.remove();
  const poPrintPageStyle = document.createElement('style');
  poPrintPageStyle.id = 'po-print-page-style';
  poPrintPageStyle.textContent = '@media print{@page{size:A4 portrait;margin:0}}';
  document.head.appendChild(poPrintPageStyle);

  ctx.view.innerHTML = `
    <div class="page-head no-print">
      <div>
        <h1>Purchase Order</h1>
        <div class="sub">${esc(po.poNo)} · ${esc(po.vendorName)}</div>
      </div>
      <div class="page-actions">
        <a class="btn" href="#/purchase-orders/${po.id}">${icon('arrowLeft')} Back to PO</a>
        <button class="btn" data-print>${icon('printer')} Print</button>
        <button class="btn btn-primary" data-pdf>${icon('download')} Save as PDF</button>
      </div>
    </div>

    <div class="print-report print-po">
      <div class="report-sheet card" style="box-shadow:var(--shadow)">
        <div class="rp-topbar">
          <span class="rp-original">ORIGINAL</span>
          <div class="rp-doc-meta">
            <span><span class="k">Doc No :</span> ${esc(po.poNo)}</span>
            <span><span class="k">Doc Date :</span> ${esc(docDate)}</span>
          </div>
        </div>

        <div class="rp-letterhead">
          <img class="rp-logo" src="/img/logo.png?v=3" alt="${esc(orgName)} logo" />
          <h2>${esc(orgName)}</h2>
          ${orgLines.map((line) => `<p>${esc(line)}</p>`).join('')}
          <p class="rp-title-center"><b>PURCHASE ORDER</b></p>
        </div>

        <div class="rp-party-grid">
          <div class="rp-party">
            <h3>To</h3>
            <div class="rp-vendor-name">${esc(po.vendorName)}</div>
            ${vendorAddressLine1 ? `<div>Address : ${esc(vendorAddressLine1)}</div>` : ''}
            ${vendorAddressLine2 ? `<div>${esc(vendorAddressLine2)}</div>` : ''}
            ${textRow('Phone', po.vendorMobile)}
            ${textRow('Email', po.vendorEmail)}
            ${textRow('GST No', po.vendorGstin)}
            ${textRow('PAN No', po.vendorPan)}
          </div>
        </div>

        <div class="rp-section">
          <h3>Order Items</h3>
          <table class="rp-table rp-ref-table">
            <thead><tr>
              <th style="width:5%">S No</th>
              <th>Product Name</th>
              <th class="num" style="width:6%">Qty</th>
              <th style="width:6%">Units</th>
              <th class="num">UnitPrice</th>
              ${hasLineDiscount ? '<th class="num">Disc</th>' : ''}
              <th class="num">Value</th>
              ${hasSgstRate ? '<th class="num">SGST</th>' : ''}
              ${hasCgstRate ? '<th class="num">CGST</th>' : ''}
              ${hasIgst ? '<th class="num">IGST</th>' : ''}
              ${hasSgstAmount ? '<th class="num">SGST Amnt</th>' : ''}
              ${hasCgstAmount ? '<th class="num">CGST Amnt</th>' : ''}
              ${hasIgstAmount ? '<th class="num">IGST Amnt</th>' : ''}
              ${hasLineTotal ? '<th class="num">Total Amount</th>' : ''}
            </tr></thead>
            <tbody>
              ${items.map((line, i) => {
                const split = gstSplit(line);
                const sgstRate = hasSgstRate ? round2((Number(line.taxRate) || 0) / 2) : 0;
                const cgstRate = hasCgstRate ? round2((Number(line.taxRate) || 0) / 2) : 0;
                const igstRate = hasIgst ? round2(Number(line.taxRate) || 0) : 0;
                const modelMake = [
                  line.modelNo ? `Model: ${line.modelNo}` : '',
                  line.make ? `Make: ${line.make}` : '',
                ].filter(Boolean).join(' · ');
                const details = [
                  line.description && line.description !== line.itemName ? line.description : '',
                  modelMake,
                ].filter(Boolean);
                return `<tr>
                  <td class="num">${i + 1}</td>
                  <td><div class="rp-product-name">${esc(line.itemName)}</div>${details.length ? `<div class="small muted">${details.map(esc).join('<br />')}</div>` : ''}</td>
                  <td class="num">${nz(line.quantity) ? num(line.quantity) : ''}</td>
                  <td>${esc(line.uomCode || '')}</td>
                  <td class="num">${moneyIf(line.unitPrice)}</td>
                  ${hasLineDiscount ? `<td class="num">${moneyIf(line.discountAmount)}${nz(line.discountPercent) ? `<div class="small muted">${num(line.discountPercent)}%</div>` : ''}</td>` : ''}
                  <td class="num">${moneyIf(line.taxableAmount)}</td>
                  ${hasSgstRate ? `<td class="num">${rateIf(sgstRate)}</td>` : ''}
                  ${hasCgstRate ? `<td class="num">${rateIf(cgstRate)}</td>` : ''}
                  ${hasIgst ? `<td class="num">${rateIf(igstRate)}</td>` : ''}
                  ${hasSgstAmount ? `<td class="num">${moneyIf(split.sgst)}</td>` : ''}
                  ${hasCgstAmount ? `<td class="num">${moneyIf(split.cgst)}</td>` : ''}
                  ${hasIgstAmount ? `<td class="num">${moneyIf(split.igst)}</td>` : ''}
                  ${hasLineTotal ? `<td class="num">${moneyIf(line.totalAmount)}</td>` : ''}
                </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>

        <div class="rp-total-row rp-item-count"><span>Total Quantity</span><span>${num(totalQuantity)}${esc(quantitySuffix)}</span></div>
        <div class="rp-amount-words"><b>Amount in Words :</b> ${esc(amountInWords(po.totalAmount))}</div>

        ${photos.length ? `
        <div class="rp-reference-photos">
          <h3>Reference Photos</h3>
          <div class="rp-photo-strip">
            ${photos.map((photo) => `<figure>
              <img src="${esc(photo.url)}" alt="${esc(photo.caption || photo.fileName)}" />
              ${photo.caption ? `<figcaption>${esc(photo.caption)}</figcaption>` : ''}
            </figure>`).join('')}
          </div>
        </div>` : ''}

        <div class="rp-terms-totals">
          <div class="rp-terms">
            <h3>Terms and Conditions :</h3>
            ${termsLines.length ? termsLines.map((line) => `<div>${esc(line)}</div>`).join('') : '<div>—</div>'}
            <div class="rp-extra-terms">
              ${textRow('Payment Terms', po.paymentTerms)}
              ${textRow('Delivery Terms', po.deliveryTerms)}
            </div>
          </div>
          <div class="rp-totals">
            ${totalRow('Total Taxable Amount', taxableValue)}
            ${totalRow('SGST Amount', gstTotals.sgst)}
            ${totalRow('CGST Amount', gstTotals.cgst)}
            ${totalRow('IGST Amount', gstTotals.igst)}
            ${totalRow('Discount', po.discountAmount)}
            ${totalRow('Round Off', po.roundOff)}
            ${totalRow('Shipping Charges', po.freightCharges)}
            ${totalRow('Loading Charges', po.loadingCharges)}
            ${totalRow('Others', po.otherCharges)}
            <div class="rp-total-row grand"><span>Total Amount</span><span>${money(po.totalAmount)}</span></div>
          </div>
        </div>

        <div class="rp-bottom-meta rp-bottom-shipping-only">
          ${shippingBlock}
        </div>

        <div class="rp-signs rp-signs-single">
          <div>
            <div class="rp-sign-org">For New Life Assembly of God Community</div>
            <div class="line">Authorized Signatory</div>
          </div>
        </div>
        <div class="rp-page-number" aria-hidden="true">1</div>
      </div>
    </div>`;

  ctx.view.querySelector('[data-print]').addEventListener('click', () => window.print());
  ctx.view.querySelector('[data-pdf]').addEventListener('click', () => {
    toast('Use "Save as PDF" in the print dialog.', 'info');
    setTimeout(() => window.print(), 350);
  });

  /* Auto-print when requested (e.g. right after PO creation or issue). */
  const autoPrint = String((ctx.route.query || {}).autoprint) === '1';
  if (autoPrint) {
    setTimeout(() => {
      toast('Opening print dialog. Choose "Save as PDF" to save or email the PO.', 'info');
      window.print();
    }, 800);
  }
}

/* ================================================================== */
/* GOODS RECEIPT LIST                                                  */
/* ================================================================== */
export async function renderGrnList(ctx) {
  const q = ctx.route.query || {};
  const params = new URLSearchParams();
  for (const key of ['search', 'status']) {
    if (q[key]) params.set(key, q[key]);
  }
  ctx.view.innerHTML = `<div class="empty">Loading goods receipts\u2026</div>`;
  const [meta, res] = await Promise.all([
    api.get('/api/procurement/grns/meta'),
    api.get(`/api/procurement/grns?${params.toString()}`),
  ]);
  const rows = res.grns || [];

  ctx.view.innerHTML = `
    <div class="page-head">
      <div><h1>Goods Receipts</h1><div class="sub">Record received quantities against issued purchase orders</div></div>
      <div class="page-actions">
        <a class="btn" href="#/purchase-orders">${icon('briefcase')} Purchase Orders</a>
        ${can('grn.manage') ? `<a class="btn btn-primary" href="#/grns/new">${icon('plus')} New Receipt</a>` : ''}
      </div>
    </div>

    <div class="card">
      <form class="toolbar" id="grn-filters">
        <div class="search">${icon('search')}<input class="input" name="search" value="${esc(q.search || '')}" placeholder="GRN number, PO or challan..." /></div>
        <select class="select" name="status">
          <option value="">All statuses</option>
          ${(meta.statuses || []).map((s) => `<option value="${esc(s.value)}" ${q.status === s.value ? 'selected' : ''}>${esc(GRN_STATUS[s.value] || s.label)}</option>`).join('')}
        </select>
        <button class="btn btn-sm" type="submit">${icon('filter')} Apply</button>
        <button class="btn btn-sm btn-ghost" type="button" data-reset>Reset</button>
      </form>
      <div class="table-wrap">
        ${rows.length
          ? `<table class="tbl">
              <thead><tr><th>GRN</th><th>Purchase order</th><th>Vendor</th><th>Received</th><th>Store</th><th class="num">Items</th><th>Status</th><th></th></tr></thead>
              <tbody>${rows.map((g) => `<tr>
                <td><a class="strong" href="#/grns/${g.id}">${esc(g.grnNo)}</a>${g.challanNo ? `<div class="small muted">Challan ${esc(g.challanNo)}</div>` : ''}</td>
                <td><a href="#/purchase-orders/${g.poId}">${esc(g.poNo)}</a></td>
                <td>${esc(g.vendorName)}<div class="small muted mono">${esc(g.vendorCode)}</div></td>
                <td class="small">${fmtDate(g.receivedDate)}<div class="small muted">${esc(g.receivedByName)}</div></td>
                <td class="small">${esc(g.storeName || '\u2014')}</td>
                <td class="num">${num(g.itemCount)}</td>
                <td>${statusOf(g.status, GRN_STATUS)}</td>
                <td class="actions"><a class="btn btn-sm btn-ghost" href="#/grns/${g.id}">${icon('eye')}</a></td>
              </tr>`).join('')}</tbody></table>`
          : emptyState(
              'No goods receipts found',
              'Record a receipt against an issued purchase order.',
              can('grn.manage') ? '<a class="btn btn-sm btn-primary" href="#/grns/new">New Receipt</a>' : '',
              'database'
            )}
      </div>
      <div class="small muted" style="padding:10px 14px">Showing ${num(rows.length)} of ${num(res.total)} receipt${res.total === 1 ? '' : 's'}.</div>
    </div>`;

  const form = document.getElementById('grn-filters');
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    navigate(withQuery('/grns', Object.fromEntries(new FormData(form).entries())));
  });
  form.querySelector('[data-reset]').addEventListener('click', () => navigate('/grns'));
}

/* ================================================================== */
/* GOODS RECEIPT FORM                                                  */
/* ================================================================== */
function grnContextCells(line) {
  const flatDiscountAmount = line.flatDiscountAmount !== undefined && line.flatDiscountAmount !== null
    ? Math.max(0, round2(Number(line.flatDiscountAmount) || 0))
    : poFlatDiscount(line);
  const calc = calcPriceLine({
    quantity: line.quantity ?? line.orderedQuantity,
    unitPrice: line.unitPrice,
    discountPercent: line.discountPercent,
    flatDiscountAmount,
    taxRate: line.taxRate,
    taxInclusive: line.taxInclusive,
  });
  return `<td class="num small">${money(calc.unitPrice)}</td>
    <td class="num small">${money(calc.discountAmount)}${calc.discountPercent ? `<div class="small muted">${num(calc.discountPercent)}%</div>` : ''}</td>
    <td class="num small">${num(calc.taxRate)}%</td>
    <td class="num small">${calc.taxInclusive ? 'Incl.' : 'Excl.'}</td>
    <td class="num small">${money(calc.taxableAmount)}</td>
    <td class="num small">${money(calc.taxAmount)}</td>
    <td class="num small">${money(calc.totalAmount)}</td>`;
}

function grnLineRow(line) {
  const flatDiscountAmount = line.flatDiscountAmount !== undefined && line.flatDiscountAmount !== null
    ? Math.max(0, round2(Number(line.flatDiscountAmount) || 0))
    : poFlatDiscount(line);
  const base = `<tr data-grn-line data-po-item="${line.id}"
      data-unit-price="${esc(line.unitPrice || 0)}" data-discpct="${esc(line.discountPercent || 0)}"
      data-disamt="${esc(flatDiscountAmount)}" data-taxrate="${esc(line.taxRate || 0)}"
      data-taxinc="${line.taxInclusive ? '1' : '0'}">
    <td><span class="strong">${esc(line.itemName)}</span><div class="small muted mono">${esc(line.itemCode)}${line.itemType === 'asset' ? ' \u00b7 asset' : ''}</div></td>
    <td class="num">${num(line.quantity)} <span class="small muted">${esc(line.uomCode)}</span></td>
    <td class="num">${num(line.remainingQuantity)}</td>
    <td><input class="input" data-received type="number" min="0" step="0.01" value="${line.remainingQuantity > 0 ? esc(line.remainingQuantity) : 0}" /></td>
    <td><input class="input" data-accepted type="number" min="0" step="0.01" value="${line.remainingQuantity > 0 ? esc(line.remainingQuantity) : 0}" /></td>
    <td><input class="input" data-rejected type="number" min="0" step="0.01" value="0" /></td>
    <td><select class="select" data-bin><option value="">\u2014 Any bin \u2014</option></select></td>
    ${grnContextCells(line)}
  </tr>`;
  if (line.itemType !== 'asset') return base;
  return base + `<tr data-asset-detail data-po-item="${line.id}" class="asset-detail-row">
    <td colspan="14" style="background:var(--bg-alt,#f7f9fc);padding:12px 14px">
      <div class="small muted" style="margin-bottom:8px"><b>Asset details</b> \u2014 captured for each unit registered from this line (serial numbers: one per accepted unit).</div>
      <div class="form-grid">
        <div class="field"><label>Model number</label><input class="input" data-ad-model placeholder="Model" /></div>
        <div class="field"><label>Manufacturer</label><input class="input" data-ad-make placeholder="Make" /></div>
        <div class="field"><label>Warranty start</label><input class="input" type="date" data-ad-ws /></div>
        <div class="field"><label>Warranty end</label><input class="input" type="date" data-ad-we /></div>
        <div class="field"><label>Condition</label><input class="input" data-ad-cond placeholder="Good" value="Good" /></div>
        <div class="field span-2"><label>Serial numbers</label><textarea class="textarea" data-ad-serials rows="2" placeholder="One serial number per line"></textarea></div>
      </div>
    </td>
  </tr>`;
}

function recalcGrnTotals(form, context = {}) {
  const lines = [...form.querySelectorAll('[data-grn-line]')].map((row) => {
    const quantity = Number(row.querySelector('[data-accepted]')?.value) || 0;
    return calcPriceLine({
      quantity,
      unitPrice: row.dataset.unitPrice,
      discountPercent: row.dataset.discpct,
      discountAmount: row.dataset.disamt,
      taxRate: row.dataset.taxrate,
      taxInclusive: row.dataset.taxinc === '1',
    });
  });
  const doc = calcDocument(lines, context);
  const set = (selector, value) => {
    const el = form.querySelector(selector);
    if (el) el.textContent = money(value);
  };
  const roundOff = syncRoundOffInput(
    form.querySelector('[name="roundOff"]'), doc.total, form.dataset.savedRoundOff
  );
  const finalTotal = round2(doc.total + roundOff);
  set('[data-grn-base]', doc.total);
  set('[data-grn-final]', finalTotal);
  return { ...doc, roundOff, final: finalTotal };
}

function bindGrnLines(container, context = {}) {
  function recalc() {
    container.querySelectorAll('[data-grn-line]').forEach((row) => {
      const received = Number(row.querySelector('[data-received]').value) || 0;
      const rejected = Number(row.querySelector('[data-rejected]').value) || 0;
      const accepted = Math.max(received - rejected, 0);
      row.querySelector('[data-accepted]').value = accepted;
    });
    recalcGrnTotals(container, context);
  }
  container.querySelectorAll('[data-grn-line]').forEach((row) => {
    row.querySelector('[data-received]').addEventListener('input', recalc);
    row.querySelector('[data-rejected]').addEventListener('input', recalc);
  });
}

function fillBinOptions(container, bins, storeId) {
  container.querySelectorAll('[data-bin]').forEach((select) => {
    const prior = select.value;
    select.innerHTML = `<option value="">\u2014 Any bin \u2014</option>${bins
      .filter((b) => Number(b.storeId) === Number(storeId))
      .map((b) => `<option value="${b.id}" ${String(b.id) === String(prior) ? 'selected' : ''}>${esc(b.name)} (${esc(b.code)})</option>`)
      .join('')}`;
  });
}

export async function renderGrnForm(ctx, options = {}) {
  const editId = options.id ? Number(options.id) : null;
  const meta = await api.get('/api/procurement/grns/meta');
  let grn = null;
  let po = null;
  let items = [];
  let poContext = po ? {
    discountPercent: po.discountPercent || 0,
    flatDiscountAmount: po.flatDiscountAmount ?? 0,
    discountAmount: po.flatDiscountAmount ?? 0,
  } : null;
  if (editId) {
    const detail = await api.get(`/api/procurement/grns/${editId}`);
    grn = detail.grn;
    po = detail.purchaseOrder;
    items = detail.items || [];
    if (grn.status !== 'draft') throw new Error('Only draft goods receipts can be edited.');
  }

  const purchaseOrders = meta.purchaseOrders || [];
  if (!editId && !purchaseOrders.length) {
    ctx.view.innerHTML = `<div class="card">${emptyState('No open purchase orders', 'Issue a purchase order before recording a goods receipt.', '<a class="btn btn-sm btn-primary" href="#/purchase-orders">Purchase Orders</a>', 'briefcase')}</div>`;
    return;
  }

  const presetPo = ctx.route.query?.poId ? Number(ctx.route.query.poId) : null;
  const selectedPo = editId ? po.id : (presetPo || (purchaseOrders.length === 1 ? purchaseOrders[0].id : ''));
  const stores = (meta.stores || []).filter((s) => !po || Number(s.unitId) === Number(po.unitId));

  ctx.view.innerHTML = `
    <div class="page-head">
      <div><h1>${editId ? `Edit ${esc(grn.grnNo)}` : 'New Goods Receipt'}</h1>
        <div class="sub">${editId ? `${esc(grn.poNo)} \u00b7 ${esc(grn.vendorName)}` : 'Record received, accepted and rejected quantities'}</div></div>
      <div class="page-actions">
        <a class="btn" href="${editId ? `#/grns/${editId}` : '#/grns'}">${icon('arrowLeft')} Cancel</a>
        <button class="btn btn-primary" type="button" data-save>${icon('check')} ${editId ? 'Save changes' : 'Create receipt'}</button>
      </div>
    </div>
    <div id="grn-alert" class="alert alert-danger hidden"></div>
    <form id="grn-form" data-saved-round-off="${esc(grn?.roundOff ?? '')}">
      <div class="grid grid-2" style="align-items:start">
        <div class="stack">
          <div class="card">
            <div class="card-head"><div><h3>Receipt Details</h3><div class="sub">Against which order and where the goods were received</div></div></div>
            <div class="form-section">
              <div class="form-grid">
                ${editId
                  ? `<div class="field span-2"><label>Purchase order</label><div class="help-block"><b>${esc(po.poNo)}</b> \u00b7 ${esc(po.vendorName)}</div></div>`
                  : `<div class="field span-2"><label>Purchase order<span class="req">*</span></label>
                      <select class="select" name="poId" data-po>
                        <option value="">\u2014 Select purchase order \u2014</option>
                        ${purchaseOrders.map((p) => `<option value="${p.id}" ${String(p.id) === String(selectedPo) ? 'selected' : ''}>${esc(p.poNo)} \u00b7 ${esc(p.vendorName)} \u00b7 ${PO_STATUS[p.status] || p.status}</option>`).join('')}
                      </select></div>`}
                <div class="field"><label>Received date</label><input class="input" type="date" name="receivedDate" value="${esc(grn?.receivedDate || meta.today || todayInput())}" /></div>
                <div class="field"><label>Store</label>
                  <select class="select" name="storeId" data-store>
                    <option value="">\u2014 Select store \u2014</option>
                    ${stores.map((s) => `<option value="${s.id}" ${grn?.storeId && Number(grn.storeId) === Number(s.id) ? 'selected' : ''}>${esc(s.name)} (${esc(s.code)})</option>`).join('')}
                  </select>
                  <div class="hint">Required for inventory items.</div>
                </div>
                <div class="field"><label>Challan number</label><input class="input" name="challanNo" value="${esc(grn?.challanNo || '')}" /></div>
                <div class="field"><label>Challan date</label><input class="input" type="date" name="challanDate" value="${esc(grn?.challanDate || '')}" /></div>
                <div class="field"><label>Vehicle number</label><input class="input" name="vehicleNo" value="${esc(grn?.vehicleNo || '')}" /></div>
                <div class="field span-2"><label>Remarks</label><textarea class="textarea" name="remarks" rows="2">${esc(grn?.remarks || '')}</textarea></div>
                <div class="field span-2"><label class="row" style="gap:8px;align-items:center"><input type="checkbox" data-excess ${grn?.excessAuthorized ? 'checked' : ''} /> Excess authorisation (allow receipt above the ordered balance)</label></div>
              </div>
            </div>
          </div>
        </div>
        <div class="stack">
          <div class="card">
            <div class="card-head"><div><h3>Guidance</h3></div></div>
            <div class="form-section">
              <div class="hint">Accepted plus rejected quantity must equal the received quantity. Inventory items are posted to stock when the receipt is posted. A bin is optional; stock then sits at store level.</div>
            </div>
          </div>
        </div>
      </div>

      <div class="card mt-16">
        <div class="card-head"><div><h3>Receipt Lines</h3><div class="sub">Quantities received against each purchase order line; price, discount and tax are carried from the PO read-only</div></div></div>
        <div class="table-wrap">
          <table class="tbl"><thead><tr><th>Item</th><th class="num">Ordered</th><th class="num">Balance</th><th style="width:110px">Received</th><th style="width:110px">Accepted</th><th style="width:110px">Rejected</th><th style="width:170px">Bin</th><th class="num">Price</th><th class="num">Disc</th><th class="num">Tax %</th><th class="num">Basis</th><th class="num">Taxable</th><th class="num">Tax</th><th class="num">Total</th></tr></thead>
            <tbody id="grn-lines">${editId
              ? items.map((line) => `<tr data-grn-line
                    data-unit-price="${esc(line.unitPrice || 0)}" data-discpct="${esc(line.discountPercent || 0)}"
                    data-disamt="${esc(line.discountAmount || 0)}" data-taxrate="${esc(line.taxRate || 0)}"
                    data-taxinc="${line.taxInclusive ? '1' : '0'}">
                  <td><span class="strong">${esc(line.itemName)}</span><div class="small muted mono">${esc(line.itemCode)}</div></td>
                  <td class="num">${num(line.orderedQuantity)} <span class="small muted">${esc(line.uomCode)}</span></td>
                  <td class="num">${num(line.orderedQuantity)}</td>
                  <td class="num">${num(line.receivedQuantity)}</td>
                  <td class="num">${num(line.acceptedQuantity)}</td>
                  <td class="num">${num(line.rejectedQuantity)}</td>
                  <td class="small">${esc(line.binName || '\u2014')}</td>
                  ${grnContextCells(line)}
                </tr>`).join('')
              : ''}</tbody>
          </table>
        </div>
        ${editId ? '<div class="small muted" style="padding:10px 14px">Line quantities are fixed once a receipt is created. Cancel the draft and raise a new receipt to change them.</div>' : ''}
        <div class="row" style="justify-content:flex-end;padding:0 14px 12px">
          <div style="text-align:right" class="small">
            <div class="row"><span class="muted">Total before round off</span><span data-grn-base>${money(0)}</span></div>
            ${roundOffControl({ value: grn?.roundOff ?? 0 })}
            <div class="row"><span class="muted">Total (rounded)</span><span class="strong" data-grn-final>${money(0)}</span></div>
          </div>
        </div>
      </div>
    </form>`;

  const form = document.getElementById('grn-form');
  const alertBox = document.getElementById('grn-alert');
  const linesBody = form.querySelector('#grn-lines');
  const storeSelect = form.querySelector('[data-store]');

  function currentBins() {
    const storeId = storeSelect.value;
    fillBinOptions(form, meta.bins || [], storeId);
  }
  storeSelect?.addEventListener('change', currentBins);
  currentBins();
  recalcGrnTotals(form, poContext || {});
  bindRoundOffControl(form, () => recalcGrnTotals(form, poContext || {}));

  if (!editId) {
    const poSelect = form.querySelector('[data-po]');
    async function loadPo() {
      const poId = poSelect.value;
      linesBody.innerHTML = '';
      if (!poId) return;
      try {
        const detail = await api.get(`/api/procurement/purchase-orders/${poId}`);
        po = detail.purchaseOrder;
        const headerFlat = poHeaderFlatDiscount(po, detail.items || []);
        poContext = {
          discountPercent: po.discountPercent || 0,
          flatDiscountAmount: headerFlat,
          discountAmount: headerFlat,
        };
        const open = (detail.items || []).filter((line) => line.remainingQuantity > 0);
        linesBody.innerHTML = open.length
          ? open.map(grnLineRow).join('')
          : '<tr><td colspan="14"><div class="empty small" style="padding:16px">This purchase order has no open balance.</div></td></tr>';
        bindGrnLines(form, poContext || {});
        recalcGrnTotals(form, poContext || {});
        const filteredStores = (meta.stores || []).filter((s) => Number(s.unitId) === Number(po.unitId));
        storeSelect.innerHTML = `<option value="">\u2014 Select store \u2014</option>${filteredStores.map((s) => `<option value="${s.id}">${esc(s.name)} (${esc(s.code)})</option>`).join('')}`;
        currentBins();
      } catch (e) {
        toast(e.message, 'error');
      }
    }
    poSelect?.addEventListener('change', loadPo);
    if (selectedPo) await loadPo();
  }

  ctx.view.querySelector('[data-save]').addEventListener('click', async () => {
    alertBox.classList.add('hidden');
    const showError = (message) => {
      alertBox.innerHTML = `${icon('alert')} ${esc(message)}`;
      alertBox.classList.remove('hidden');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    };

    const body = {
      receivedDate: form.receivedDate.value || null,
      storeId: form.storeId.value || null,
      challanNo: form.challanNo.value.trim(),
      challanDate: form.challanDate.value || null,
      vehicleNo: form.vehicleNo.value.trim(),
      remarks: form.remarks.value.trim(),
      excessAuthorized: form.querySelector('[data-excess]').checked,
      roundOff: readRoundOffOverride(
        form.querySelector('[name="roundOff"]'),
        recalcGrnTotals(form, poContext || {}).total
      ),
    };

    try {
      if (editId) {
        await api.put(`/api/procurement/grns/${editId}`, body);
        toast('Goods receipt updated.');
        navigate(`/grns/${editId}`);
        return;
      }
      if (!form.poId.value) return showError('Select a purchase order.');
      const lines = [];
      form.querySelectorAll('[data-grn-line]').forEach((row) => {
        const received = Number(row.querySelector('[data-received]').value) || 0;
        if (received <= 0) return;
        const assetRow = form.querySelector(`[data-asset-detail][data-po-item="${row.dataset.poItem}"]`);
        const assetDetails = assetRow
          ? {
              modelNo: assetRow.querySelector('[data-ad-model]').value.trim(),
              manufacturer: assetRow.querySelector('[data-ad-make]').value.trim(),
              serialNumbers: assetRow.querySelector('[data-ad-serials]').value,
              warrantyStart: assetRow.querySelector('[data-ad-ws]').value || null,
              warrantyEnd: assetRow.querySelector('[data-ad-we]').value || null,
              condition: assetRow.querySelector('[data-ad-cond]').value.trim(),
            }
          : null;
        lines.push({
          poItemId: row.dataset.poItem,
          receivedQuantity: received,
          acceptedQuantity: row.querySelector('[data-accepted]').value,
          rejectedQuantity: row.querySelector('[data-rejected]').value,
          binId: row.querySelector('[data-bin]').value || null,
          assetDetails,
          /* PO-derived pricing context. The server recalculates and persists it. */
          unitPrice: Number(row.dataset.unitPrice) || 0,
          discountPercent: Number(row.dataset.discpct) || 0,
          discountAmount: Number(row.dataset.disamt) || 0,
          taxRate: Number(row.dataset.taxrate) || 0,
          taxInclusive: row.dataset.taxinc === '1',
        });
      });
      if (!lines.length) return showError('Enter a received quantity on at least one line.');
      const grnTotals = recalcGrnTotals(form, poContext || {});
      const res = await api.post('/api/procurement/grns', {
        ...body,
        poId: form.poId.value,
        discountPercent: poContext?.discountPercent || 0,
        flatDiscountAmount: poContext?.flatDiscountAmount || 0,
        discountAmount: poContext?.flatDiscountAmount || 0,
        roundOff: grnTotals.roundOff,
        items: lines,
      });
      toast(`Goods receipt ${res.grnNo} created.`);
      navigate(`/grns/${res.id}`);
    } catch (e) {
      showError(e.message || 'Unable to save the goods receipt.');
    }
  });
}

/* ================================================================== */
/* GOODS RECEIPT DETAIL                                                */
/* ================================================================== */
export async function renderGrnDetail(ctx, options = {}) {
  const id = Number(options.id);
  ctx.view.innerHTML = `<div class="empty">Loading goods receipt\u2026</div>`;
  const detail = await api.get(`/api/procurement/grns/${id}`);
  const grn = detail.grn;
  const po = detail.purchaseOrder;
  const actions = detail.actions || {};
  const refresh = () => renderGrnDetail(ctx, { id });
  const act = async (fn, message, type = 'success') => {
    try {
      await fn();
      toast(message, type);
      await refresh();
    } catch (err) {
      toast(err.message || 'Action failed.', 'error');
    }
  };

  const accepted = (detail.items || []).reduce((sum, line) => sum + line.acceptedQuantity, 0);
  const rejected = (detail.items || []).reduce((sum, line) => sum + line.rejectedQuantity, 0);
  const grnGross = round2((detail.items || []).reduce((sum, line) => sum + line.totalAmount, 0));
  const grnPctDiscount = round2((grnGross * (grn.discountPercent || 0)) / 100);
  const grnAppliedDiscount = round2(Math.min(grnGross, grnPctDiscount + round2(grn.discountAmount || 0)));
  const grnBase = round2(grnGross - grnAppliedDiscount);

  ctx.view.innerHTML = `
    <div class="page-head">
      <div><h1>${esc(grn.grnNo)}</h1>
        <div class="sub">${esc(grn.poNo)} \u00b7 ${esc(grn.vendorName)} \u00b7 ${esc(grn.unitName)}</div></div>
      <div class="page-actions">
        <a class="btn" href="#/grns">${icon('arrowLeft')} Back</a>
        <a class="btn" href="#/purchase-orders/${grn.poId}">${icon('briefcase')} View PO</a>
        ${actions.canEdit ? `<a class="btn" href="#/grns/${grn.id}/edit">${icon('edit')} Edit</a>` : ''}
        ${actions.canPost ? `<button class="btn btn-primary" type="button" data-post>${icon('checkCircle')} Post Receipt</button>` : ''}
        ${actions.canCancel ? `<button class="btn btn-danger" type="button" data-cancel>${icon('xCircle')} Cancel</button>` : ''}
      </div>
    </div>

    <div class="grid grid-4 mb-16">
      <div class="card"><div class="kpi"><div class="chip gray">${icon('database')}</div><div><div class="label">Status</div><div class="value small-value">${statusOf(grn.status, GRN_STATUS)}</div><div class="meta">${grn.postedAt ? `Posted ${fmtDate(grn.postedAt)}` : 'Not posted'}</div></div></div></div>
      <div class="card"><div class="kpi"><div class="chip teal">${icon('checkCircle')}</div><div><div class="label">Accepted</div><div class="value small-value">${num(accepted)}</div><div class="meta">${num((detail.items || []).length)} line${(detail.items || []).length === 1 ? '' : 's'}</div></div></div></div>
      <div class="card"><div class="kpi"><div class="chip amber">${icon('alert')}</div><div><div class="label">Rejected</div><div class="value small-value">${num(rejected)}</div><div class="meta">${grn.excessAuthorized ? 'Excess authorised' : 'Within order balance'}</div></div></div></div>
      <div class="card"><div class="kpi"><div class="chip blue">${icon('calendar')}</div><div><div class="label">Received</div><div class="value small-value">${fmtDate(grn.receivedDate)}</div><div class="meta">${esc(grn.receivedByName)}</div></div></div></div>
    </div>

    <div class="grid grid-2" style="align-items:start">
      <div class="stack">
        <div class="card">
          <div class="card-head"><div><h3>Receipt Lines</h3><div class="sub">Received, accepted and rejected quantities</div></div></div>
          <div class="table-wrap">
            <table class="tbl">
              <thead><tr><th>Item</th><th class="num">Ordered</th><th class="num">Received</th><th class="num">Accepted</th><th class="num">Rejected</th><th>Bin</th></tr></thead>
              <tbody>${detail.items.map((line) => `<tr>
                <td><span class="strong">${esc(line.itemName)}</span><div class="small muted mono">${esc(line.itemCode)}</div></td>
                <td class="num">${num(line.orderedQuantity)} <span class="small muted">${esc(line.uomCode)}</span></td>
                <td class="num">${num(line.receivedQuantity)}</td>
                <td class="num">${num(line.acceptedQuantity)}</td>
                <td class="num">${num(line.rejectedQuantity)}</td>
                <td class="small">${esc(line.binName || '\u2014')}</td>
              </tr>`).join('')}</tbody>
            </table>
          </div>
        </div>
      </div>
      <div class="stack">
        <div class="card">
          <div class="card-head"><div><h3>Receipt Details</h3></div></div>
          <div class="form-section">
            <div class="stack small">
              <div class="row"><span class="muted" style="width:130px">Purchase order</span><span><a href="#/purchase-orders/${po.id}">${esc(po.poNo)}</a> \u00b7 ${statusOf(po.status, PO_STATUS)}</span></div>
              <div class="row"><span class="muted" style="width:130px">Store</span><span>${esc(grn.storeName || '\u2014')}</span></div>
              <div class="row"><span class="muted" style="width:130px">Received by</span><span>${esc(grn.receivedByName)}</span></div>
              <div class="row"><span class="muted" style="width:130px">Challan</span><span>${esc(grn.challanNo || '\u2014')}${grn.challanDate ? ` \u00b7 ${fmtDate(grn.challanDate)}` : ''}</span></div>
              <div class="row"><span class="muted" style="width:130px">Vehicle</span><span>${esc(grn.vehicleNo || '\u2014')}</span></div>
              <div class="row"><span class="muted" style="width:130px">Total before round off</span><span>${money(grnBase)}</span></div>
              <div class="row"><span class="muted" style="width:130px">Round off</span><span>${money(grn.roundOff || 0)}</span></div>
              <div class="row"><span class="muted" style="width:130px">Total (rounded)</span><span class="strong">${money(roundRupee(grnBase))}</span></div>
              ${grn.remarks ? `<div class="row"><span class="muted" style="width:130px">Remarks</span><span>${esc(grn.remarks)}</span></div>` : ''}
              ${grn.cancelReason ? `<div class="row"><span class="muted" style="width:130px">Cancel reason</span><span>${esc(grn.cancelReason)}</span></div>` : ''}
              <div class="row"><span class="muted" style="width:130px">Created</span><span>${fmtDate(grn.createdAt, true)}</span></div>
            </div>
          </div>
        </div>
      </div>
    </div>`;

  ctx.view.querySelector('[data-post]')?.addEventListener('click', async () => {
    const ok = await confirmDialog({ title: 'Post goods receipt', message: 'Post this receipt? Accepted inventory quantities will be added to stock and the PO balance updated.', confirmText: 'Post receipt' });
    if (ok) await act(() => api.post(`/api/procurement/grns/${id}/post`), 'Goods receipt posted.');
  });

  ctx.view.querySelector('[data-cancel]')?.addEventListener('click', async () => {
    const result = await actionDialog({ title: 'Cancel goods receipt', subtitle: 'The draft remains in the audit trail.', requireComment: true, confirmText: 'Cancel receipt', danger: true });
    if (!result) return;
    await act(() => api.post(`/api/procurement/grns/${id}/cancel`, { reason: result.comments }), 'Goods receipt cancelled.');
  });
}
