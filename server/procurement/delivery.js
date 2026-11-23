'use strict';

/**
 * Delivery address / round-off / general-terms helpers for procurement.
 *
 * Additive only. Functions that read master data take an injected `db`
 * (a node:sqlite DatabaseSync) as their first argument; no database module is
 * imported here. `companyAddress()` and `generalTerms()` read settings through
 * the existing util.getSettings() helper and accept an optional settings map
 * so callers that already loaded settings can avoid a second read.
 */

const { getSettings } = require('../util');

/* Kept in sync with the idempotent seed in server/db.js. The seed never
   overwrites an administrator's saved value; this is only a fallback. */
const DEFAULT_GENERAL_TERMS = [
  '1. Any items that are damaged during transportation or unloading and also when noticed during unboxing must be replaced at no cost to NLAGC',
  '2. Materials shall be dispatched with DC, Invoice, without those documents the materials will not be unloaded and the same will be returned.',
  '3. Any variations in size / Product No / quality / appearance / colour will not be acceptable and the same to be replaced without any additional cost and time.',
].join('\n');

function text(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

/* Read a value from either a camelCase API object or a snake_case DB row. */
function pick(source, camel, snake) {
  if (!source || typeof source !== 'object') return '';
  if (source[camel] !== undefined && source[camel] !== null) return text(source[camel]);
  if (snake && source[snake] !== undefined && source[snake] !== null) return text(source[snake]);
  return '';
}

function numberFrom(source, camel, snake) {
  const raw = pick(source, camel, snake);
  if (!raw) return 0;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

function nullableId(value) {
  const raw = text(value);
  if (!raw) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/* Format a master row (or an already formatted string) into an address block.
   Accepts camelCase or snake_case keys. Returns '' for empty addresses. */
function formatAddress(value) {
  if (typeof value === 'string') return text(value);
  if (!value || typeof value !== 'object') return '';

  const line1 = pick(value, 'addressLine1', 'address_line1');
  const line2 = pick(value, 'addressLine2', 'address_line2');
  const city = pick(value, 'city');
  const state = pick(value, 'state');
  const pincode = pick(value, 'pincode');

  const locality = [city, state].filter(Boolean).join(', ');
  const tail = pincode ? (locality ? `${locality} - ${pincode}` : pincode) : locality;
  const lines = [line1, line2, tail].filter(Boolean);
  if (lines.length) return lines.join('\n');

  /* Some organization masters store a single free-text address column. */
  return pick(value, 'address', 'address_line1');
}

/* `dbOrRow` may be an injected db (with .prepare) plus a unit id, or a unit
   row/object to format directly. Keeps both calling styles working. */
function unitAddress(dbOrRow, unitId) {
  if (dbOrRow && typeof dbOrRow.prepare === 'function') {
    const id = Number(unitId);
    if (!Number.isInteger(id) || id <= 0) return '';
    const row = dbOrRow.prepare('SELECT * FROM units WHERE id = ?').get(id);
    return row ? formatAddress(row) : '';
  }
  return formatAddress(dbOrRow);
}

function storeAddress(db, storeId) {
  const id = Number(storeId);
  if (!db || typeof db.prepare !== 'function' || !Number.isInteger(id) || id <= 0) return '';
  const row = db.prepare('SELECT * FROM stores WHERE id = ?').get(id);
  return row ? formatAddress(row) : '';
}

function companyAddress(settings) {
  const s = settings || getSettings();
  return text(s && s['org.address']);
}

function generalTerms(settings) {
  const s = settings || getSettings();
  return text(s && s['procurement.general_terms']) || DEFAULT_GENERAL_TERMS;
}

/* Accepts a JSON string, an already parsed array, or an empty value. Always
   returns a clean array of {name, designation, mobile, email}. */
function parseAdditionalContacts(value) {
  let parsed = value;
  if (typeof value === 'string') {
    const raw = value.trim();
    if (!raw) return [];
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((c) => c && typeof c === 'object' && !Array.isArray(c))
    .map((c) => ({
      name: text(c.name ?? c.contactName),
      designation: text(c.designation),
      mobile: text(c.mobile),
      email: text(c.email),
    }))
    .filter((c) => c.name || c.designation || c.mobile || c.email);
}

/* Billing default: the selected PO unit address; if empty, org.address.
   'company' -> org.address; 'unit' -> billingUnitId (fallback PO unit);
   'custom' -> the submitted billingAddress. */
function resolveBillingAddress(db, input) {
  const src = input || {};
  const settings = getSettings();
  const source = (pick(src, 'billingAddressSource', 'billing_address_source') || 'unit').toLowerCase();
  const unitId = pick(src, 'billingUnitId', 'billing_unit_id') || pick(src, 'unitId', 'unit_id');

  if (source === 'company') return companyAddress(settings);
  if (source === 'custom') return pick(src, 'billingAddress', 'billing_address');

  const resolved = unitAddress(db, unitId);
  return resolved || companyAddress(settings);
}

/* Shipping default: the resolved billing address.
   'unit' -> unit address; 'store' -> store address from shippingLocationId;
   'custom' -> the submitted shippingAddress. */
function resolveShippingAddress(db, input) {
  const src = input || {};
  const type = (pick(src, 'shippingLocationType', 'shipping_location_type') || 'billing').toLowerCase();
  const billing = pick(src, 'billingAddress', 'billing_address');
  const locationId = pick(src, 'shippingLocationId', 'shipping_location_id') || pick(src, 'unitId', 'unit_id');
  const submitted = pick(src, 'shippingAddress', 'shipping_address');

  if (type === 'custom') return submitted;
  if (type === 'unit') return unitAddress(db, locationId) || billing;
  if (type === 'store') return storeAddress(db, locationId) || billing;
  return billing;
}

/* Submitted delivery-contact fields win; for a store shipment, blank fields
   are defaulted from that store's in-charge record. */
function resolveDeliveryContact(db, input) {
  const src = input || {};
  const type = (pick(src, 'shippingLocationType', 'shipping_location_type') || 'billing').toLowerCase();
  const out = {
    name: pick(src, 'deliveryContactName', 'delivery_contact_name'),
    designation: pick(src, 'deliveryContactDesignation', 'delivery_contact_designation'),
    mobile: pick(src, 'deliveryContactMobile', 'delivery_contact_mobile'),
    email: pick(src, 'deliveryContactEmail', 'delivery_contact_email'),
  };

  if (type === 'store') {
    const id = Number(pick(src, 'shippingLocationId', 'shipping_location_id'));
    if (db && typeof db.prepare === 'function' && Number.isInteger(id) && id > 0) {
      const store = db
        .prepare(
          `SELECT incharge_name, incharge_designation, incharge_mobile, incharge_email
             FROM stores WHERE id = ?`
        )
        .get(id);
      if (store) {
        if (!out.name) out.name = text(store.incharge_name);
        if (!out.designation) out.designation = text(store.incharge_designation);
        if (!out.mobile) out.mobile = text(store.incharge_mobile);
        if (!out.email) out.email = text(store.incharge_email);
      }
    }
  }
  return out;
}

/* Canonical camelCase delivery fields for an output mapper. Reads a snake_case
   DB row or an already mapped camelCase object. */
function deliveryFields(row) {
  return {
    roundOff: numberFrom(row, 'roundOff', 'round_off'),
    generalTerms: pick(row, 'generalTerms', 'general_terms'),
    billingAddressSource: pick(row, 'billingAddressSource', 'billing_address_source') || 'unit',
    billingUnitId: nullableId(pick(row, 'billingUnitId', 'billing_unit_id')),
    billingAddress: pick(row, 'billingAddress', 'billing_address'),
    shippingLocationType: pick(row, 'shippingLocationType', 'shipping_location_type') || 'billing',
    shippingLocationId: nullableId(pick(row, 'shippingLocationId', 'shipping_location_id')),
    shippingLocationLabel: pick(row, 'shippingLocationLabel', 'shipping_location_label'),
    shippingAddress: pick(row, 'shippingAddress', 'shipping_address'),
    deliveryContactName: pick(row, 'deliveryContactName', 'delivery_contact_name'),
    deliveryContactDesignation: pick(row, 'deliveryContactDesignation', 'delivery_contact_designation'),
    deliveryContactMobile: pick(row, 'deliveryContactMobile', 'delivery_contact_mobile'),
    deliveryContactEmail: pick(row, 'deliveryContactEmail', 'delivery_contact_email'),
    additionalContacts: parseAdditionalContacts(
      row && row.additionalContacts !== undefined && row.additionalContacts !== null
        ? row.additionalContacts
        : (row && row.additional_contacts)
    ),
  };
}

module.exports = {
  formatAddress,
  unitAddress,
  companyAddress,
  generalTerms,
  parseAdditionalContacts,
  resolveBillingAddress,
  resolveShippingAddress,
  resolveDeliveryContact,
  deliveryFields,
};
