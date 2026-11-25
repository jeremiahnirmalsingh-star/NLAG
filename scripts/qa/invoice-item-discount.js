'use strict';

/* Regression gate for the New Procurement Invoice item-discount bug.
 *
 * PO line `discountAmount` is the APPLIED total (percent + flat). The invoice
 * form fields carry the FLAT portion only. If the PO applied total is copied
 * into the invoice flat field while the percent is also copied, the percentage
 * discount is applied twice. This gate verifies the recovered flat amount and
 * the resulting invoice line/totals, then removes its temporary invoice.
 */

const BASE = process.env.ABMDAS_BASE || 'http://127.0.0.1:3000';
const PO_ID = Number(process.env.ABMDAS_QA_PO || 8);
const PO_ITEM_ID = Number(process.env.ABMDAS_QA_PO_ITEM || 14);
const failures = [];
let cookie = '';
let invoiceId = null;

async function request(method, path, body) {
  const headers = { Accept: 'application/json' };
  if (cookie) headers.Cookie = cookie;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const err = new Error(`${method} ${path} -> ${res.status}: ${text}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

function check(name, condition, detail) {
  const ok = !!condition;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ` :: ${JSON.stringify(detail)}`}`);
  if (!ok) failures.push(name);
}

function near(actual, expected, tolerance = 0.01) {
  return Math.abs(Number(actual || 0) - Number(expected)) <= tolerance;
}

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

function recoveredFlat(line) {
  if (line.flatDiscountAmount !== undefined && line.flatDiscountAmount !== null) {
    return Math.max(0, round2(Number(line.flatDiscountAmount) || 0));
  }
  const gross = round2((Number(line.quantity) || 0) * (Number(line.unitPrice) || 0));
  const percentAmount = round2((gross * (Number(line.discountPercent) || 0)) / 100);
  return Math.max(0, round2((Number(line.discountAmount) || 0) - percentAmount));
}

async function main() {
  const login = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'Admin@123' }),
  });
  const loginText = await login.text();
  check('login', login.ok, login.ok ? 'ok' : loginText.slice(0, 200));
  if (!login.ok) throw new Error(loginText);
  cookie = (login.headers.get('set-cookie') || '').split(';')[0];

  const po = await request('GET', `/api/procurement/purchase-orders/${PO_ID}`);
  const line = (po.items || []).find((l) => Number(l.id) === PO_ITEM_ID);
  if (!line) throw new Error(`PO ${PO_ID} line ${PO_ITEM_ID} was not found.`);
  const percent = Number(line.discountPercent) || 0;
  const gross = round2(line.quantity * line.unitPrice);
  const percentAmount = round2((gross * percent) / 100);
  const flat = recoveredFlat(line);

  check('PO line percent discount', near(percent, 20), percent);
  check('PO line applied discount', near(line.discountAmount, percentAmount), line.discountAmount);
  check('recovered flat discount is zero', near(flat, 0), flat);

  const supplierInvoiceNo = `QA-INV-DISC-${Date.now()}`;
  const created = await request('POST', '/api/procurement/invoices', {
    poId: PO_ID,
    grnId: null,
    supplierInvoiceNo,
    supplierInvoiceDate: new Date().toISOString().slice(0, 10),
    dueDate: '',
    gstType: 'cgst_sgst',
    discountPercent: 0,
    discountAmount: 0,
    roundOff: 0,
    remarks: 'Invoice item-discount regression QA',
    lines: [{
      poItemId: line.id,
      grnItemId: null,
      itemId: line.itemId,
      description: line.description || line.itemName,
      uomId: line.uomId,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      discountPercent: percent,
      discountAmount: flat,
      taxRate: line.taxRate,
      taxInclusive: line.taxInclusive,
    }],
  });
  invoiceId = Number(created.id);
  check('create invoice', invoiceId > 0, created);

  const detail = await request('GET', `/api/procurement/invoices/${invoiceId}`);
  const item = (detail.items || [])[0];
  if (!item) throw new Error('Invoice line was not saved.');
  const applied = round2(percentAmount + flat);
  const discounted = round2(gross - applied);
  const taxable = line.taxInclusive ? round2(discounted / (1 + (Number(line.taxRate) || 0) / 100)) : discounted;
  const tax = round2(discounted - taxable);
  check('invoice line percent kept once', near(item.discountPercent, 20), item.discountPercent);
  check('invoice line applied discount is once', near(item.discountAmount, applied), item.discountAmount);
  check('invoice line exposes flat portion', near(item.flatDiscountAmount, 0), item.flatDiscountAmount);
  check('invoice line taxable', near(item.taxableAmount, taxable), { actual: item.taxableAmount, expected: taxable });
  check('invoice line tax', near(item.taxAmount, tax), { actual: item.taxAmount, expected: tax });
  check('invoice line total', near(item.totalAmount, discounted), { actual: item.totalAmount, expected: discounted });
  check('invoice net amount', near(detail.invoice.netAmount, discounted), detail.invoice.netAmount);

  /* A draft edit must recover the flat portion from the stored applied total.
   * Without that recovery the percentage is added a second time on save. */
  const editFlat = recoveredFlat(item);
  check('edit form recovers flat discount', near(editFlat, 0), editFlat);
  await request('PUT', `/api/procurement/invoices/${invoiceId}`, {
    poId: PO_ID,
    grnId: detail.invoice.grnId || null,
    supplierInvoiceNo: detail.invoice.supplierInvoiceNo,
    supplierInvoiceDate: detail.invoice.supplierInvoiceDate,
    dueDate: detail.invoice.dueDate || '',
    gstType: detail.invoice.gstType,
    discountPercent: detail.invoice.discountPercent,
    discountAmount: 0,
    roundOff: detail.invoice.roundOff,
    remarks: detail.invoice.remarks,
    lines: [{
      poItemId: item.poItemId,
      grnItemId: item.grnItemId,
      itemId: item.itemId,
      description: item.description,
      uomId: item.uomId,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      discountPercent: item.discountPercent,
      discountAmount: editFlat,
      taxRate: item.taxRate,
      taxInclusive: item.taxInclusive,
    }],
  });
  const afterEdit = await request('GET', `/api/procurement/invoices/${invoiceId}`);
  const editedItem = (afterEdit.items || [])[0] || {};
  check('edit keeps applied discount once', near(editedItem.discountAmount, applied), editedItem.discountAmount);
  check('edit keeps net amount', near(afterEdit.invoice.netAmount, discounted), afterEdit.invoice.netAmount);
}

(async () => {
  try {
    await main();
  } catch (err) {
    failures.push(err.message);
    console.error(err);
  } finally {
    if (invoiceId) {
      try {
        await request('DELETE', `/api/procurement/invoices/${invoiceId}`);
        console.log(`CLEANUP deleted invoice ${invoiceId}`);
      } catch (err) {
        failures.push(`cleanup: ${err.message}`);
      }
    }
  }
  console.log(JSON.stringify({ failures, invoiceId }, null, 2));
  if (failures.length) process.exitCode = 1;
})();
