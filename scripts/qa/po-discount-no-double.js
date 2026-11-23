'use strict';

/* Regression gate for the PO 0058 discount bug.
 *
 * A percentage discount is stored as an applied total in `discount_amount`.
 * The editable form field is the flat portion only. This QA creates a
 * percentage-only PO and repeatedly saves/revises it with client-shaped
 * payloads that explicitly carry `flatDiscountAmount: 0`. If any save path
 * mistakes the applied total for the flat amount, the discount grows and the
 * assertions below fail.
 */

const BASE = process.env.ABMDAS_BASE || 'http://127.0.0.1:3000';
const DB_PATH = process.env.ABMDAS_DB || 'C:/abmdas-data/abmdas.db';
let cookie = '';
let poId = null;
let poNo = null;
const failures = [];

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

function today() {
  return new Date().toISOString().slice(0, 10);
}

function futureDate() {
  return new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
}

function clientPayload(detail, extra = {}) {
  return {
    poDate: detail.purchaseOrder.poDate || today(),
    deliveryDate: detail.purchaseOrder.deliveryDate || futureDate(),
    paymentTerms: detail.purchaseOrder.paymentTerms || '',
    deliveryTerms: detail.purchaseOrder.deliveryTerms || '',
    terms: detail.purchaseOrder.terms || '',
    notes: detail.purchaseOrder.notes || '',
    discountPercent: 0,
    /* The form's `Discount amount` field is flat only, never applied. */
    flatDiscountAmount: 0,
    discountAmount: 0,
    freightCharges: 0,
    loadingCharges: 0,
    otherCharges: 0,
    roundOff: 0,
    items: detail.items.map((line) => ({
      id: line.id,
      itemId: line.itemId,
      itemName: line.itemName,
      description: line.description,
      modelNo: line.modelNo,
      make: line.make,
      uomId: line.uomId,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      discountPercent: 10,
      flatDiscountAmount: 0,
      discountAmount: 0,
      taxRate: 0,
      taxInclusive: false,
      taxableAmount: line.taxableAmount,
      taxAmount: line.taxAmount,
      totalAmount: line.totalAmount,
    })),
    ...extra,
  };
}

function assertStable(label, detail) {
  const po = detail.purchaseOrder;
  const line = detail.items[0];
  check(`${label}: flat line discount stays 0`, near(line.flatDiscountAmount, 0), line.flatDiscountAmount);
  check(`${label}: applied line discount stays 200`, near(line.discountAmount, 200), line.discountAmount);
  check(`${label}: taxable stays 1800`, near(line.taxableAmount, 1800), line.taxableAmount);
  check(`${label}: header flat discount stays 0`, near(po.flatDiscountAmount, 0), po.flatDiscountAmount);
  check(`${label}: header applied discount stays 0`, near(po.discountAmount, 0), po.discountAmount);
  check(`${label}: total stays 1800`, near(po.totalAmount, 1800), po.totalAmount);
}

async function softDelete() {
  if (!poId) return;
  try {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(DB_PATH);
    const now = new Date().toISOString();
    const admin = db.prepare("SELECT id FROM users WHERE username = 'admin' LIMIT 1").get();
    db.prepare(
      `UPDATE purchase_orders
          SET deleted_at = ?, deleted_by = ?, delete_reason = ?, updated_at = ?
        WHERE id = ? AND po_no = ?`
    ).run(now, admin?.id ?? null, `QA cleanup ${now}`, now, poId, poNo);
    db.close();
    console.log(`CLEANUP soft-deleted ${poNo} (id ${poId})`);
  } catch (err) {
    console.log(`CLEANUP WARNING ${err.message}`);
  }
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

  const meta = await request('GET', '/api/procurement/purchase-orders/meta');
  const unit = (meta.units || []).find((u) => Number(u.id) === 2) || (meta.units || [])[0];
  const vendor = (meta.vendors || []).find((v) => !/demo/i.test(v.name || '')) || (meta.vendors || [])[0];
  const item = (meta.items || []).find((i) => !/demo/i.test(i.name || '')) || (meta.items || [])[0];
  if (!unit || !vendor || !item) throw new Error('QA needs at least one unit, vendor and item master.');

  const created = await request('POST', '/api/procurement/purchase-orders', {
    unitId: unit.id,
    vendorId: vendor.id,
    departmentId: null,
    poDate: today(),
    deliveryDate: futureDate(),
    paymentTerms: '',
    deliveryTerms: '',
    terms: '',
    notes: 'Discount repeat-save regression QA',
    discountPercent: 0,
    flatDiscountAmount: 0,
    discountAmount: 0,
    freightCharges: 0,
    loadingCharges: 0,
    otherCharges: 0,
    roundOff: 0,
    items: [{
      itemId: item.id,
      itemName: item.name,
      description: item.name,
      uomId: item.uomId,
      quantity: 2,
      unitPrice: 1000,
      discountPercent: 10,
      flatDiscountAmount: 0,
      discountAmount: 0,
      taxRate: 0,
      taxInclusive: false,
    }],
  });
  poId = Number(created.id);
  poNo = created.poNo;
  check('create PO', poId > 0, created);

  let detail = await request('GET', `/api/procurement/purchase-orders/${poId}`);
  assertStable('create', detail);

  await request('PUT', `/api/procurement/purchase-orders/${poId}`, clientPayload(detail));
  detail = await request('GET', `/api/procurement/purchase-orders/${poId}`);
  assertStable('first edit', detail);

  await request('PUT', `/api/procurement/purchase-orders/${poId}`, clientPayload(detail));
  detail = await request('GET', `/api/procurement/purchase-orders/${poId}`);
  assertStable('second edit', detail);

  await request('POST', `/api/procurement/purchase-orders/${poId}/issue`, {});
  detail = await request('GET', `/api/procurement/purchase-orders/${poId}`);
  assertStable('issue', detail);

  await request('POST', `/api/procurement/purchase-orders/${poId}/revise`,
    clientPayload(detail, { reason: 'Discount repeat-save regression QA' }));
  detail = await request('GET', `/api/procurement/purchase-orders/${poId}`);
  assertStable('revise', detail);

  await request('POST', `/api/procurement/purchase-orders/${poId}/cancel`,
    { reason: 'Discount repeat-save regression QA cleanup' });
}

(async () => {
  try {
    await main();
  } catch (err) {
    failures.push(err.message);
    console.error(err);
  } finally {
    await softDelete();
  }
  console.log(JSON.stringify({ failures, poId, poNo }, null, 2));
  if (failures.length) process.exitCode = 1;
})();
