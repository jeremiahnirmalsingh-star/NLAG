'use strict';

/**
 * Purchase orders and goods receipt notes — Phase 1b.
 *
 * Additive only. Receipt posting writes to the Phase 1a stock ledger and
 * balances inside one transaction.
 */

const path = require('node:path');
const auth = require('../auth');
const { HttpError, saveUpload } = require('../http');
const { DATA_DIR } = require('../db');
const {
  audit, notify, nowIso, today, round2, calculateRoundOff, nextPurchaseOrderNo, nextGrnNo, badRequest,
} = require('../util');
const {
  unitScope, inList, requireText, optionalText, optionalId, optionalDate,
  transaction, pageParams, ensureVendor, ensureUnit, rowOr404,
} = require('../procurement/shared');
const { createAssetsForGrn } = require('../procurement/assets');
const assetSettings = require('../procurement/asset-settings');
const tax = require('../procurement/tax');
const delivery = require('../procurement/delivery');

const PO_STATUSES = ['draft', 'issued', 'partially_received', 'received', 'closed', 'cancelled'];
const OPEN_PO_STATUSES = ['issued', 'partially_received'];

/* Canonical delivery / terms fields. Keys are API camelCase, columns are the
 * additive schema fields introduced by migration.delivery_roundoff_terms.v1. */
const PO_DELIVERY_KEYS = [
  'billingAddressSource', 'billingUnitId', 'billingAddress',
  'shippingLocationType', 'shippingLocationId', 'shippingLocationLabel', 'shippingAddress',
  'deliveryContactName', 'deliveryContactDesignation', 'deliveryContactMobile', 'deliveryContactEmail',
  'additionalContacts', 'generalTerms',
];
const PO_DELIVERY_COLUMNS = [
  'billing_address_source', 'billing_unit_id', 'billing_address',
  'shipping_location_type', 'shipping_location_id', 'shipping_location_label', 'shipping_address',
  'delivery_contact_name', 'delivery_contact_designation', 'delivery_contact_mobile', 'delivery_contact_email',
  'additional_contacts', 'general_terms',
];
const BILLING_SOURCES = ['company', 'unit', 'custom'];
const SHIPPING_TYPES = ['billing', 'unit', 'store', 'custom'];

/* The delivery helpers accept an options object; the positional variants keep
 * this route compatible while the shared module is being rolled out. */
function callFirst(fn, variants, isValid) {
  if (typeof fn !== 'function') return undefined;
  for (const args of variants) {
    try {
      const value = fn(...args);
      if (isValid(value)) return value;
    } catch {
      /* try the next supported signature */
    }
  }
  return undefined;
}

function helperText(fn, variants) {
  const value = callFirst(
    fn,
    variants,
    (candidate) => candidate !== undefined && candidate !== null && String(candidate).trim()
  );
  return value === undefined ? '' : String(value);
}

function safeId(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function enumValue(value, allowed, fallback) {
  const text = String(value ?? '').trim();
  return allowed.includes(text) ? text : fallback;
}

function textFromResult(result, keys, fallback) {
  if (typeof result === 'string') return result;
  if (result && typeof result === 'object') {
    for (const key of keys) {
      const value = result[key];
      if (value !== undefined && value !== null && String(value).trim()) return String(value);
    }
  }
  return fallback;
}

function mergeContact(result, fallback) {
  const source = {
    ...(result && typeof result === 'object' ? result : {}),
    ...(result?.contact && typeof result.contact === 'object' ? result.contact : {}),
  };
  const pick = (keys, current) => {
    for (const key of keys) {
      const value = source[key];
      if (value !== undefined && value !== null && String(value).trim()) return String(value);
    }
    return current;
  };
  return {
    name: pick(['name', 'deliveryContactName', 'delivery_contact_name'], fallback.name),
    designation: pick(['designation', 'deliveryContactDesignation', 'delivery_contact_designation'], fallback.designation),
    mobile: pick(['mobile', 'deliveryContactMobile', 'delivery_contact_mobile'], fallback.mobile),
    email: pick(['email', 'deliveryContactEmail', 'delivery_contact_email'], fallback.email),
  };
}

function normalizeContacts(value) {
  let list = value;
  if (typeof list === 'string') {
    try {
      list = JSON.parse(list);
    } catch {
      list = [];
    }
  }
  if (!Array.isArray(list)) return '[]';
  return JSON.stringify(list.slice(0, 20).map((entry) => ({
    name: String(entry?.name ?? '').trim().slice(0, 200),
    designation: String(entry?.designation ?? '').trim().slice(0, 200),
    mobile: String(entry?.mobile ?? '').trim().slice(0, 50),
    email: String(entry?.email ?? '').trim().slice(0, 200),
  })).filter((entry) => Object.values(entry).some((value) => value)));
}

function contactsOut(value) {
  let list = value;
  if (typeof list === 'string') {
    try {
      list = JSON.parse(list);
    } catch {
      list = [];
    }
  }
  if (!Array.isArray(list)) return [];
  return list.map((entry) => ({
    name: String(entry?.name ?? ''),
    designation: String(entry?.designation ?? ''),
    mobile: String(entry?.mobile ?? ''),
    email: String(entry?.email ?? ''),
  }));
}

function poDeliveryParams(values) {
  return PO_DELIVERY_KEYS.map((key) => {
    const value = values?.[key];
    if (key === 'billingUnitId' || key === 'shippingLocationId') return safeId(value);
    if (key === 'additionalContacts') return normalizeContacts(value);
    const max = key === 'generalTerms' ? 20000
      : (key === 'billingAddress' || key === 'shippingAddress' ? 4000 : 1000);
    return String(value ?? '').slice(0, max);
  });
}

function deliveryAudit(values) {
  return {
    generalTerms: values?.generalTerms || '',
    billingAddressSource: values?.billingAddressSource || 'unit',
    billingUnitId: safeId(values?.billingUnitId),
    billingAddress: values?.billingAddress || '',
    shippingLocationType: values?.shippingLocationType || 'billing',
    shippingLocationId: safeId(values?.shippingLocationId),
    shippingLocationLabel: values?.shippingLocationLabel || '',
    shippingAddress: values?.shippingAddress || '',
    deliveryContactName: values?.deliveryContactName || '',
    deliveryContactDesignation: values?.deliveryContactDesignation || '',
    deliveryContactMobile: values?.deliveryContactMobile || '',
    deliveryContactEmail: values?.deliveryContactEmail || '',
    additionalContacts: contactsOut(values?.additionalContacts),
  };
}

/* tax.calculateDocument() exposes baseTotalAmount once round-off is enabled.
 * calculateRoundOff() applies the shared nearest-rupee, half-up rule:
 * round_off = roundedTotal - preRoundTotal; total_amount always stores the
 * final rounded value so existing reports and payables stay correct. */
function documentAmounts(document, override) {
  const base = round2(Number(document?.baseTotalAmount ?? document?.totalAmount ?? 0));
  return calculateRoundOff(base, override);
}

function resolvePoDelivery(ctx, body, existing, unitId, termsFallback = '') {
  const db = ctx.db;
  const read = (key) => {
    const column = PO_DELIVERY_COLUMNS[PO_DELIVERY_KEYS.indexOf(key)];
    for (const source of [body, existing]) {
      if (!source) continue;
      for (const name of [key, column]) {
        const value = source[name];
        if (value !== undefined && value !== null && value !== '') return value;
      }
    }
    return undefined;
  };

  const billingSource = enumValue(read('billingAddressSource'), BILLING_SOURCES, 'unit');
  const shippingType = enumValue(read('shippingLocationType'), SHIPPING_TYPES, 'billing');
  const poUnitId = safeId(unitId);
  let billingUnitId = safeId(read('billingUnitId')) || poUnitId;
  if (billingUnitId && billingUnitId !== poUnitId) billingUnitId = ensureUnit(ctx, billingUnitId);
  let shippingLocationId = safeId(read('shippingLocationId'));
  if (shippingType === 'unit' && shippingLocationId && shippingLocationId !== poUnitId) {
    shippingLocationId = ensureUnit(ctx, shippingLocationId);
  }

  const unitRow = poUnitId ? db.prepare('SELECT * FROM units WHERE id = ?').get(poUnitId) : null;
  const billingUnitRow = billingUnitId === poUnitId ? unitRow
    : (billingUnitId ? db.prepare('SELECT * FROM units WHERE id = ?').get(billingUnitId) : unitRow);
  const companyAddress = helperText(delivery.companyAddress, [[], [ctx], [db]]);
  const unitAddress = helperText(delivery.unitAddress, [
    [db, billingUnitId], [ctx, billingUnitId], [billingUnitId],
    [db, billingUnitRow], [ctx, billingUnitRow], [billingUnitRow],
  ]) || (billingUnitRow ? helperText(delivery.formatAddress, [
    [billingUnitRow], [db, billingUnitRow], [ctx, billingUnitRow],
  ]) : '');

  const submittedBilling = String(read('billingAddress') ?? '');
  const billingOptions = {
    db, unitId: poUnitId, billingUnitId, source: billingSource,
    billingAddressSource: billingSource, companyAddress, unitAddress,
    billingAddress: submittedBilling, customAddress: submittedBilling, address: submittedBilling,
  };
  const resolvedBilling = callFirst(
    delivery.resolveBillingAddress,
    [[db, billingOptions], [ctx, billingOptions], [billingOptions]],
    (value) => value !== undefined && value !== null
  );
  const fallbackBilling = billingSource === 'company' ? companyAddress
    : billingSource === 'custom' ? submittedBilling
    : (unitAddress || companyAddress);
  let billingAddress = textFromResult(
    resolvedBilling, ['address', 'billingAddress', 'billing_address', 'formatted'], fallbackBilling
  );
  if (billingSource === 'custom' && submittedBilling) billingAddress = submittedBilling;

  const shippingUnitId = shippingType === 'unit'
    ? (shippingLocationId || billingUnitId || poUnitId)
    : billingUnitId;
  const shippingUnitRow = shippingUnitId === poUnitId ? unitRow
    : (shippingUnitId ? db.prepare('SELECT * FROM units WHERE id = ?').get(shippingUnitId) : null);
  const shippingUnitAddress = shippingUnitId === billingUnitId ? unitAddress
    : (helperText(delivery.unitAddress, [
      [db, shippingUnitId], [ctx, shippingUnitId], [shippingUnitId],
      [db, shippingUnitRow], [ctx, shippingUnitRow], [shippingUnitRow],
    ]) || (shippingUnitRow
      ? helperText(delivery.formatAddress, [
        [shippingUnitRow], [db, shippingUnitRow], [ctx, shippingUnitRow],
      ])
      : ''));

  let storeRow = null;
  if (shippingType === 'store' && shippingLocationId) {
    storeRow = db.prepare('SELECT * FROM stores WHERE id = ? AND deleted_at IS NULL').get(shippingLocationId) || null;
    if (!storeRow || Number(storeRow.unit_id) !== Number(unitId)) {
      throw new HttpError(400, 'Selected shipping store does not belong to the purchase order unit.');
    }
  }
  const storeAddress = storeRow
    ? (helperText(delivery.formatAddress, [[storeRow], [db, storeRow], [ctx, storeRow]])
      || [storeRow.address_line1, storeRow.address_line2, storeRow.city, storeRow.state, storeRow.pincode]
        .filter(Boolean).join(', '))
    : '';

  const submittedShipping = String(read('shippingAddress') ?? '');
  const shippingOptions = {
    db, unitId: poUnitId, billingUnitId, shippingUnitId,
    type: shippingType, shippingLocationType: shippingType,
    locationId: shippingLocationId, shippingLocationId,
    billingAddress, unitAddress: shippingUnitAddress, storeAddress,
    store: storeRow, storeRow, shippingAddress: submittedShipping,
    customAddress: submittedShipping, address: submittedShipping,
  };
  const resolvedShipping = callFirst(
    delivery.resolveShippingAddress,
    [[db, shippingOptions], [ctx, shippingOptions], [shippingOptions]],
    (value) => value !== undefined && value !== null
  );
  const fallbackShipping = shippingType === 'billing' ? billingAddress
    : shippingType === 'unit' ? (shippingUnitAddress || companyAddress)
    : shippingType === 'store' ? (storeAddress || billingAddress)
    : (submittedShipping || billingAddress);
  let shippingAddress = textFromResult(
    resolvedShipping, ['address', 'shippingAddress', 'shipping_address', 'formatted'], fallbackShipping
  );
  if (shippingType === 'custom' && submittedShipping) shippingAddress = submittedShipping;

  const submittedContact = {
    name: String(read('deliveryContactName') ?? ''),
    designation: String(read('deliveryContactDesignation') ?? ''),
    mobile: String(read('deliveryContactMobile') ?? ''),
    email: String(read('deliveryContactEmail') ?? ''),
  };
  const contactFallback = { ...submittedContact };
  if (storeRow) {
    if (!contactFallback.name) contactFallback.name = String(storeRow.incharge_name || '');
    if (!contactFallback.designation) contactFallback.designation = String(storeRow.incharge_designation || '');
    if (!contactFallback.mobile) contactFallback.mobile = String(storeRow.incharge_mobile || '');
    if (!contactFallback.email) contactFallback.email = String(storeRow.incharge_email || '');
  }
  const contactOptions = {
    db, type: shippingType, shippingLocationType: shippingType,
    shippingLocationId, store: storeRow, storeRow,
    name: contactFallback.name, designation: contactFallback.designation,
    mobile: contactFallback.mobile, email: contactFallback.email,
    deliveryContactName: contactFallback.name,
    deliveryContactDesignation: contactFallback.designation,
    deliveryContactMobile: contactFallback.mobile,
    deliveryContactEmail: contactFallback.email,
  };
  const resolvedContact = callFirst(
    delivery.resolveDeliveryContact,
    [[db, contactOptions], [ctx, contactOptions], [contactOptions]],
    (value) => value !== undefined && value !== null
  );
  const contact = mergeContact(resolvedContact, contactFallback);
  /* An explicit delivery contact always wins over store/helper defaults. */
  for (const key of ['name', 'designation', 'mobile', 'email']) {
    if (submittedContact[key]) contact[key] = submittedContact[key];
  }

  const rawContacts = read('additionalContacts');
  const parsedContacts = callFirst(
    delivery.parseAdditionalContacts,
    [[rawContacts], [db, rawContacts], [ctx, rawContacts]],
    (value) => value !== undefined && value !== null
  );
  const additionalContacts = normalizeContacts(parsedContacts ?? rawContacts);

  const suppliedTerms = read('generalTerms');
  const defaultTerms = helperText(delivery.generalTerms, [[], [ctx], [db]])
    || String(db.prepare("SELECT value FROM settings WHERE key = 'procurement.general_terms'").get()?.value || '');
  const generalTerms = String(
    suppliedTerms !== undefined && String(suppliedTerms).trim()
      ? suppliedTerms
      : (termsFallback || defaultTerms)
  );

  const shippingLabel = String(read('shippingLocationLabel') ?? '')
    || (shippingType === 'store' ? String(storeRow?.name || '')
      : shippingType === 'unit' ? String(shippingUnitRow?.name || '') : '');

  return {
    billingAddressSource: billingSource,
    billingUnitId,
    billingAddress,
    shippingLocationType: shippingType,
    shippingLocationId: shippingType === 'store' ? shippingLocationId
      : shippingType === 'unit' ? (shippingLocationId || billingUnitId) : null,
    shippingLocationLabel: shippingLabel,
    shippingAddress,
    deliveryContactName: contact.name,
    deliveryContactDesignation: contact.designation,
    deliveryContactMobile: contact.mobile,
    deliveryContactEmail: contact.email,
    additionalContacts,
    generalTerms,
  };
}

function poDeliveryColumnList() {
  return PO_DELIVERY_COLUMNS.join(', ');
}

function poDeliveryPlaceholders() {
  return PO_DELIVERY_COLUMNS.map(() => '?').join(', ');
}

function poDeliveryAssignments() {
  return PO_DELIVERY_COLUMNS.map((column) => `${column}=?`).join(', ');
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const PO_PHOTO_MAX_BYTES = 5 * 1024 * 1024;
const PO_PHOTO_MAX_COUNT = 50;
const PO_PHOTO_MIMES = ['image/jpeg', 'image/png', 'image/webp'];
const PO_PHOTO_UPLOAD_DIR = path.join(DATA_DIR, 'uploads', 'po-reference-photos');

function photoMagicMatches(buffer, mime) {
  if (mime === 'image/jpeg') return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  if (mime === 'image/png') return buffer.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (mime === 'image/webp') return buffer.slice(0, 4).toString('ascii') === 'RIFF' && buffer.slice(8, 12).toString('ascii') === 'WEBP';
  return false;
}

function poPhotos(db, poId) {
  return db
    .prepare(
      `SELECT id, po_id, po_item_id, file_name, stored_name, mime_type, size, caption, uploaded_at
         FROM po_reference_photos
        WHERE po_id = ? AND deleted_at IS NULL
        ORDER BY id ASC`
    )
    .all(poId)
    .map((row) => ({
      id: row.id,
      poId: row.po_id,
      poItemId: row.po_item_id || null,
      fileName: row.file_name,
      url: `/api/files/po-reference-photo/${row.id}`,
      mimeType: row.mime_type,
      size: Number(row.size) || 0,
      caption: row.caption || '',
      uploadedAt: row.uploaded_at,
    }));
}

function poOut(row) {
  return {
    id: row.id,
    poNo: row.po_no,
    unitId: row.unit_id,
    unitName: row.unit_name || '',
    departmentId: row.department_id,
    departmentName: row.department_name || '',
    requisitionId: row.requisition_id,
    requisitionNo: row.requisition_no || '',
    rfqId: row.rfq_id,
    rfqNo: row.rfq_no || '',
    comparativeStatementId: row.comparative_statement_id,
    csNo: row.cs_no || '',
    quotationId: row.quotation_id,
    quotationNo: row.quotation_no || '',
    vendorId: row.vendor_id,
    vendorCode: row.vendor_code || '',
    vendorName: row.vendor_name || '',
    vendorContactPerson: row.vendor_contact_person || '',
    vendorMobile: row.vendor_mobile || '',
    vendorEmail: row.vendor_email || '',
    vendorGstin: row.vendor_gstin || '',
    vendorPan: row.vendor_pan || '',
    vendorAddress1: row.vendor_address1 || '',
    vendorAddress2: row.vendor_address2 || '',
    vendorCity: row.vendor_city || '',
    vendorState: row.vendor_state || '',
    vendorPincode: row.vendor_pincode || '',
    vendorCategory: row.vendor_category || '',
    poDate: row.po_date,
    deliveryDate: row.delivery_date,
    status: row.status,
    subtotal: round2(row.subtotal),
    taxAmount: round2(row.tax_amount),
    discountPercent: Number(row.discount_percent) || 0,
    flatDiscountAmount: round2(row.flat_discount_amount),
    discountAmount: round2(row.discount_amount),
    totalAmount: round2(row.total_amount),
    ...delivery.deliveryFields(row),
    baseTotalAmount: round2(round2(row.total_amount) - round2(row.round_off)),
    freightCharges: round2(row.freight_charges),
    loadingCharges: round2(row.loading_charges),
    otherCharges: round2(row.other_charges),
    paymentTerms: row.payment_terms || '',
    reference: row.reference || '',
    deliveryTerms: row.delivery_terms || '',
    terms: row.terms || '',
    notes: row.notes || '',
    revisionNo: Number(row.revision_no) || 0,
    issuedBy: row.issued_by,
    issuedByName: row.issued_by_name || '',
    issuedAt: row.issued_at,
    closedAt: row.closed_at,
    cancelReason: row.cancel_reason || '',
    itemCount: Number(row.item_count) || 0,
    grnCount: Number(row.grn_count) || 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function poItemOut(row) {
  return {
    id: row.id,
    requisitionItemId: row.requisition_item_id,
    itemId: row.item_id,
    itemCode: row.item_code || '',
    itemName: row.item_name || row.catalog_item_name || row.description || '',
    description: row.description || '',
    modelNo: row.model_no || '',
    make: row.make || '',
    uomId: row.uom_id,
    uomCode: row.uom_code || '',
    quantity: Number(row.quantity) || 0,
    unitPrice: Number(row.unit_price) || 0,
    discountPercent: Number(row.discount_percent) || 0,
    flatDiscountAmount: Number(row.flat_discount_amount) || 0,
    discountAmount: Number(row.discount_amount) || 0,
    taxRate: Number(row.tax_rate) || 0,
    taxInclusive: !!row.tax_inclusive,
    taxableAmount: Number(row.taxable_amount) || 0,
    taxAmount: Number(row.tax_amount) || 0,
    totalAmount: Number(row.total_amount) || 0,
    receivedQuantity: Number(row.received_quantity) || 0,
    rejectedQuantity: Number(row.rejected_quantity) || 0,
    invoicedQuantity: Number(row.invoiced_quantity) || 0,
    remainingQuantity: round2(Math.max(Number(row.quantity) - Number(row.received_quantity), 0)),
    trackInventory: !!row.track_inventory,
    itemType: row.item_type || '',
  };
}

function getPo(ctx, id) {
  const ids = unitScope(ctx);
  return rowOr404(
    ctx.db
      .prepare(
        `SELECT p.*, u.name AS unit_name, d.name AS department_name,
                rq.requisition_no, r.rfq_no, c.cs_no, q.quotation_no,
                v.code AS vendor_code, v.name AS vendor_name,
                v.contact_person AS vendor_contact_person, v.mobile AS vendor_mobile,
                v.email AS vendor_email, v.gst_number AS vendor_gstin, v.pan_number AS vendor_pan,
                v.address_line1 AS vendor_address1, v.address_line2 AS vendor_address2,
                v.city AS vendor_city, v.state AS vendor_state, v.pincode AS vendor_pincode,
                v.category AS vendor_category,
                iu.name AS issued_by_name,
                (SELECT COUNT(*) FROM po_items pi WHERE pi.po_id = p.id) AS item_count,
                (SELECT COUNT(*) FROM grns g WHERE g.po_id = p.id AND g.status = 'posted') AS grn_count
           FROM purchase_orders p
           JOIN units u ON u.id = p.unit_id
           LEFT JOIN departments d ON d.id = p.department_id
           LEFT JOIN requisitions rq ON rq.id = p.requisition_id
           LEFT JOIN rfqs r ON r.id = p.rfq_id
           LEFT JOIN comparative_statements c ON c.id = p.comparative_statement_id
           LEFT JOIN quotations q ON q.id = p.quotation_id
           JOIN vendors v ON v.id = p.vendor_id
           LEFT JOIN users iu ON iu.id = p.issued_by
          WHERE p.id = ? AND p.deleted_at IS NULL AND p.unit_id IN (${inList(ids)})`
      )
      .get(Number(id), ...ids),
    'Purchase order not found.'
  );
}

function poItems(db, poId) {
  return db
    .prepare(
      `SELECT pi.*, i.item_code, i.name AS catalog_item_name, i.item_type, i.track_inventory,
              u.code AS uom_code
         FROM po_items pi
         LEFT JOIN items i ON i.id = pi.item_id
         LEFT JOIN uoms u ON u.id = COALESCE(pi.uom_id, i.uom_id)
        WHERE pi.po_id = ?
        ORDER BY pi.id`
    )
    .all(poId)
    .map(poItemOut);
}

function getGrn(ctx, id) {
  const ids = unitScope(ctx);
  return rowOr404(
    ctx.db
      .prepare(
        `SELECT g.*, p.po_no, p.vendor_id, v.code AS vendor_code, v.name AS vendor_name,
                u.name AS unit_name, s.name AS store_name,
                ru.name AS received_by_name, cu.name AS created_by_name,
                (SELECT COUNT(*) FROM grn_items gi WHERE gi.grn_id = g.id) AS item_count
           FROM grns g
           JOIN purchase_orders p ON p.id = g.po_id
           JOIN vendors v ON v.id = p.vendor_id
           JOIN units u ON u.id = g.unit_id
           LEFT JOIN stores s ON s.id = g.store_id
           JOIN users ru ON ru.id = g.received_by
           JOIN users cu ON cu.id = g.created_by
          WHERE g.id = ? AND g.unit_id IN (${inList(ids)})`
      )
      .get(Number(id), ...ids),
    'Goods receipt note not found.'
  );
}

function grnOut(row) {
  return {
    id: row.id,
    grnNo: row.grn_no,
    poId: row.po_id,
    poNo: row.po_no || '',
    vendorId: row.vendor_id,
    vendorCode: row.vendor_code || '',
    vendorName: row.vendor_name || '',
    unitId: row.unit_id,
    unitName: row.unit_name || '',
    storeId: row.store_id,
    storeName: row.store_name || '',
    receivedDate: row.received_date,
    receivedBy: row.received_by,
    receivedByName: row.received_by_name || '',
    status: row.status,
    challanNo: row.challan_no || '',
    challanDate: row.challan_date,
    vehicleNo: row.vehicle_no || '',
    remarks: row.remarks || '',
    discountPercent: Number(row.discount_percent) || 0,
    flatDiscountAmount: round2(row.flat_discount_amount),
    discountAmount: round2(row.discount_amount),
    roundOff: round2(row.round_off),
    excessAuthorized: !!row.excess_authorized,
    postedAt: row.posted_at,
    cancelReason: row.cancel_reason || '',
    itemCount: Number(row.item_count) || 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function grnItems(db, grnId) {
  return db
    .prepare(
      `SELECT gi.*, i.item_code, i.name AS item_name, i.track_inventory, b.name AS bin_name,
              u.code AS uom_code
         FROM grn_items gi
         LEFT JOIN items i ON i.id = gi.item_id
         LEFT JOIN bins b ON b.id = gi.bin_id
         LEFT JOIN uoms u ON u.id = i.uom_id
        WHERE gi.grn_id = ?
        ORDER BY gi.id`
    )
    .all(grnId)
    .map((row) => ({
      id: row.id,
      poItemId: row.po_item_id,
      itemId: row.item_id,
      itemCode: row.item_code || '',
      itemName: row.item_name || '',
      binId: row.bin_id,
      binName: row.bin_name || '',
      uomCode: row.uom_code || '',
      orderedQuantity: Number(row.ordered_quantity) || 0,
      receivedQuantity: Number(row.received_quantity) || 0,
      acceptedQuantity: Number(row.accepted_quantity) || 0,
      rejectedQuantity: Number(row.rejected_quantity) || 0,
      unitPrice: Number(row.unit_price) || 0,
      discountPercent: Number(row.discount_percent) || 0,
      discountAmount: Number(row.discount_amount) || 0,
      taxRate: Number(row.tax_rate) || 0,
      taxInclusive: !!row.tax_inclusive,
      taxableAmount: Number(row.taxable_amount) || 0,
      taxAmount: Number(row.tax_amount) || 0,
      totalAmount: Number(row.total_amount) || 0,
      remarks: row.remarks || '',
      trackInventory: !!row.track_inventory,
    }));
}

/* ------------------------------------------------------------------ */
/* PO payload                                                          */
/* ------------------------------------------------------------------ */
function poLines(ctx, body, existingItems) {
  const list = Array.isArray(body.items) ? body.items : [];
  if (!list.length) throw new HttpError(400, 'Add at least one item to the purchase order.');
  if (list.length > 100) throw new HttpError(400, 'A purchase order can hold at most 100 lines.');
  const existing = new Map((existingItems || []).map((line) => [line.id, line]));

  return list.map((line, index) => {
    const existingLine = line.id ? existing.get(Number(line.id)) : null;
    if (line.id && !existingLine) throw new HttpError(400, `Line ${index + 1}: purchase order line was not found.`);

    const itemId = Number(line.itemId || existingLine?.itemId);
    if (!Number.isInteger(itemId) || itemId <= 0) {
      throw new HttpError(400, `Line ${index + 1}: select an item.`);
    }
    const item = ctx.db.prepare('SELECT * FROM items WHERE id = ? AND deleted_at IS NULL AND active = 1').get(itemId);
    if (!item) throw new HttpError(400, `Line ${index + 1}: item was not found or is inactive.`);

    const quantity = Number(line.quantity ?? existingLine?.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new HttpError(400, `Line ${index + 1}: quantity must be greater than zero.`);
    }
    if (existingLine && quantity < existingLine.receivedQuantity) {
      throw new HttpError(400, `Line ${index + 1}: quantity cannot be below the quantity already received.`);
    }
    const unitPrice = Number(line.unitPrice ?? existingLine?.unitPrice);
    if (!Number.isFinite(unitPrice) || unitPrice < 0) {
      throw new HttpError(400, `Line ${index + 1}: unit price cannot be negative.`);
    }
    const defaults = tax.itemDefaults(ctx.db, itemId);
    const calc = tax.parseLine({
      ...line,
      quantity,
      unitPrice,
      discountPercent: line.discountPercent ?? existingLine?.discountPercent,
      flatDiscountAmount: line.flatDiscountAmount
        ?? (line.discountAmount === undefined ? existingLine?.flatDiscountAmount : line.discountAmount),
      discountAmount: line.discountAmount ?? existingLine?.discountAmount,
      taxRate: line.taxRate ?? existingLine?.taxRate,
      taxInclusive: line.taxInclusive ?? existingLine?.taxInclusive,
    }, index, defaults, 'Line');
    return {
      id: existingLine?.id || null,
      requisitionItemId: existingLine?.requisitionItemId ?? (line.requisitionItemId ? Number(line.requisitionItemId) : null),
      itemId,
      itemName: String(line.itemName ?? existingLine?.itemName ?? item.name).trim().slice(0, 200) || item.name,
      description: String(line.description ?? existingLine?.description ?? item.name).trim().slice(0, 300) || item.name,
      modelNo: String(line.modelNo ?? existingLine?.modelNo ?? '').trim().slice(0, 120),
      make: String(line.make ?? existingLine?.make ?? '').trim().slice(0, 120),
      uomId: line.uomId ? Number(line.uomId) : (existingLine?.uomId || item.uom_id),
      ...calc,
    };
  });
}

function recalcPo(db, poId, now, roundOffOverride) {
  const rows = db.prepare('SELECT taxable_amount, tax_amount, total_amount FROM po_items WHERE po_id = ?').all(poId);
  const header = db.prepare(
    `SELECT freight_charges, loading_charges, other_charges, discount_percent,
            flat_discount_amount, discount_amount
       FROM purchase_orders WHERE id = ?`
  ).get(poId);
  const document = tax.calculateDocument(rows, {
    charges: (Number(header?.freight_charges) || 0)
      + (Number(header?.loading_charges) || 0)
      + (Number(header?.other_charges) || 0),
    discountPercent: Number(header?.discount_percent) || 0,
    /* Never feed the applied discount back in as the flat amount. */
    flatDiscountAmount: Number(header?.flat_discount_amount) || 0,
    discountAmount: Number(header?.flat_discount_amount) || 0,
  });
  const amounts = documentAmounts(document, roundOffOverride);
  db.prepare(
    `UPDATE purchase_orders SET subtotal=?, tax_amount=?, discount_amount=?,
       round_off=?, total_amount=?, updated_at=? WHERE id=?`
  ).run(
    document.subtotal, document.taxAmount, document.discountAmount,
    amounts.roundOff, amounts.totalAmount, now, poId
  );
  return { ...document, ...amounts };
}

/* GRN values mirror the PO line basis for the accepted quantity. The PO's flat
 * discount is the whole-order amount, so it is prorated before recalculation. */
function grnLineAmounts(poLine, quantity) {
  const grossPo = round2(Number(poLine.quantity || 0) * Number(poLine.unitPrice || 0));
  const percent = Number(poLine.discountPercent) || 0;
  const percentAmount = round2((grossPo * percent) / 100);
  const flatPo = poLine.flatDiscountAmount !== undefined
    ? round2(Number(poLine.flatDiscountAmount) || 0)
    : Math.max(0, round2(Number(poLine.discountAmount || 0) - percentAmount));
  const ratio = Number(poLine.quantity) > 0 ? quantity / Number(poLine.quantity) : 0;
  return tax.calculateLine({
    quantity,
    unitPrice: poLine.unitPrice,
    discountPercent: percent,
    discountAmount: round2(flatPo * ratio),
    taxRate: poLine.taxRate,
    taxInclusive: poLine.taxInclusive,
  });
}

function replacePoItems(db, poId, lines, now) {
  const existing = db.prepare('SELECT id FROM po_items WHERE po_id = ?').all(poId);
  const existingIds = new Set(existing.map((row) => Number(row.id)));
  const keep = new Set();
  const insert = db.prepare(
    `INSERT INTO po_items(po_id, requisition_item_id, item_id, item_name, description, model_no, make, uom_id,
       quantity, unit_price, discount_percent, flat_discount_amount, discount_amount, tax_rate, tax_inclusive,
       taxable_amount, tax_amount, total_amount, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  const update = db.prepare(
    `UPDATE po_items SET requisition_item_id=?, item_id=?, item_name=?, description=?, model_no=?, make=?, uom_id=?,
       quantity=?, unit_price=?, discount_percent=?, flat_discount_amount=?, discount_amount=?, tax_rate=?, tax_inclusive=?,
       taxable_amount=?, tax_amount=?, total_amount=?, updated_at=?
     WHERE id=? AND po_id=?`
  );
  for (const line of lines) {
    const lineId = line.id ? Number(line.id) : null;
    if (lineId && existingIds.has(lineId)) {
      update.run(
        line.requisitionItemId || null, line.itemId, line.itemName || line.description, line.description, line.modelNo || null, line.make || null, line.uomId,
        line.quantity, line.unitPrice, line.discountPercent || 0, line.flatDiscountAmount || 0, line.discountAmount || 0,
        line.taxRate, line.taxInclusive ? 1 : 0, line.taxableAmount || 0, line.taxAmount, line.totalAmount,
        now, lineId, poId
      );
      keep.add(lineId);
    } else {
      const res = insert.run(
        poId, line.requisitionItemId || null, line.itemId, line.itemName || line.description, line.description, line.modelNo || null, line.make || null, line.uomId,
        line.quantity, line.unitPrice, line.discountPercent || 0, line.flatDiscountAmount || 0, line.discountAmount || 0,
        line.taxRate, line.taxInclusive ? 1 : 0, line.taxableAmount || 0, line.taxAmount, line.totalAmount, now, now
      );
      keep.add(Number(res.lastInsertRowid));
    }
  }
  for (const row of existing) {
    if (!keep.has(Number(row.id))) {
      db.prepare('UPDATE po_reference_photos SET po_item_id = NULL WHERE po_id = ? AND po_item_id = ?').run(poId, row.id);
      db.prepare('DELETE FROM po_items WHERE id = ? AND po_id = ?').run(row.id, poId);
    }
  }
}

function snapshotPo(db, po, items, reason, userId, now) {
  const snapshot = JSON.stringify({
    purchaseOrder: po,
    items,
    capturedAt: now,
  });
  const revisionNo = Number(po.revision_no) + 1;
  db.prepare(
    `INSERT INTO po_revisions(po_id, revision_no, snapshot, reason, revised_by, revised_at, created_at)
     VALUES (?,?,?,?,?,?,?)`
  ).run(po.id, revisionNo, snapshot, reason, userId, now, now);
  db.prepare('UPDATE purchase_orders SET revision_no=?, updated_at=? WHERE id=?').run(revisionNo, now, po.id);
  return revisionNo;
}

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */
module.exports = function registerProcurementOrderRoutes(router) {
  /* ------------------------------ Meta ---------------------------- */
  router.get('/api/procurement/purchase-orders/meta', async (ctx) => {
    auth.guard(ctx.user, 'po.view');
    const ids = unitScope(ctx);
    const ph = inList(ids);
    const statements = ctx.db
      .prepare(
        `SELECT c.id, c.cs_no, c.total_quoted, r.id AS rfq_id, r.rfq_no,
                q.id AS quotation_id, q.quotation_no, q.vendor_id,
                v.name AS vendor_name,
                EXISTS (SELECT 1 FROM purchase_orders p
                         WHERE p.comparative_statement_id = c.id AND p.status <> 'cancelled'
                           AND p.deleted_at IS NULL) AS used
           FROM comparative_statements c
           JOIN rfqs r ON r.id = c.rfq_id
           JOIN quotations q ON q.id = c.recommended_quotation_id
           JOIN vendors v ON v.id = q.vendor_id
          WHERE c.status = 'approved' AND r.unit_id IN (${ph})
          ORDER BY c.approved_at DESC`
      )
      .all(...ids)
      .map((row) => ({
        id: row.id,
        csNo: row.cs_no,
        totalQuoted: round2(row.total_quoted),
        rfqId: row.rfq_id,
        rfqNo: row.rfq_no,
        quotationId: row.quotation_id,
        quotationNo: row.quotation_no,
        vendorId: row.vendor_id,
        vendorName: row.vendor_name,
        used: !!row.used,
      }));
    const units = ctx.db.prepare(`SELECT id, code, name FROM units WHERE id IN (${ph}) ORDER BY name`).all(...ids);
    /* Direct purchase orders need a vendor, an optional department and items. */
    const vendors = ctx.db
      .prepare(
        `SELECT id, code, name, status FROM vendors
          WHERE status <> 'Blacklisted' ORDER BY name COLLATE NOCASE LIMIT 1000`
      )
      .all()
      .map((row) => ({ id: row.id, code: row.code, name: row.name, status: row.status }));
    const departments = ctx.db
      .prepare('SELECT id, code, name FROM departments WHERE active = 1 ORDER BY name')
      .all();
    const uoms = ctx.db.prepare('SELECT id, code, name FROM uoms WHERE active = 1 ORDER BY name').all();
    const items = ctx.db
      .prepare(
        `SELECT i.id, i.item_code, i.name, i.item_type, i.uom_id, i.standard_cost,
                u.code AS uom_code
           FROM items i JOIN uoms u ON u.id = i.uom_id
          WHERE i.deleted_at IS NULL AND i.active = 1
          ORDER BY i.name COLLATE NOCASE
          LIMIT 1000`
      )
      .all()
      .map((row) => ({
        id: row.id,
        itemCode: row.item_code,
        name: row.name,
        itemType: row.item_type,
        uomId: row.uom_id,
        uomCode: row.uom_code,
        standardCost: Number(row.standard_cost) || 0,
      }));
    return {
      comparativeStatements: statements,
      units,
      vendors,
      departments,
      uoms,
      items,
      generalTerms: helperText(delivery.generalTerms, [[], [ctx], [ctx.db]]),
      statuses: PO_STATUSES.map((value) => ({ value, label: value.replace(/_/g, ' ') })),
      today: today(),
    };
  });

  /* ------------------------- Purchase orders ---------------------- */
  router.get('/api/procurement/purchase-orders', async (ctx) => {
    auth.guard(ctx.user, 'po.view');
    const ids = unitScope(ctx);
    const q = ctx.query || {};
    const where = ['p.deleted_at IS NULL', `p.unit_id IN (${inList(ids)})`];
    const params = [...ids];
    if (q.search) {
      const like = `%${String(q.search).trim()}%`;
      where.push('(p.po_no LIKE ? OR v.name LIKE ? OR p.notes LIKE ?)');
      params.push(like, like, like);
    }
    if (q.status && PO_STATUSES.includes(String(q.status))) {
      where.push('p.status = ?');
      params.push(String(q.status));
    }
    if (q.vendorId) {
      where.push('p.vendor_id = ?');
      params.push(Number(q.vendorId));
    }
    const { page, pageSize, offset } = pageParams(q);
    const total = ctx.db
      .prepare(
        `SELECT COUNT(*) AS c FROM purchase_orders p JOIN vendors v ON v.id = p.vendor_id
          WHERE ${where.join(' AND ')}`
      )
      .get(...params).c;
    const rows = ctx.db
      .prepare(
        `SELECT p.*, u.name AS unit_name, d.name AS department_name,
                rq.requisition_no, r.rfq_no, c.cs_no, q.quotation_no,
                v.code AS vendor_code, v.name AS vendor_name,
                v.contact_person AS vendor_contact_person, v.mobile AS vendor_mobile,
                v.email AS vendor_email, v.gst_number AS vendor_gstin, v.pan_number AS vendor_pan,
                v.address_line1 AS vendor_address1, v.address_line2 AS vendor_address2,
                v.city AS vendor_city, v.state AS vendor_state, v.pincode AS vendor_pincode,
                v.category AS vendor_category,
                iu.name AS issued_by_name,
                (SELECT COUNT(*) FROM po_items pi WHERE pi.po_id = p.id) AS item_count,
                (SELECT COUNT(*) FROM grns g WHERE g.po_id = p.id AND g.status = 'posted') AS grn_count
           FROM purchase_orders p
           JOIN units u ON u.id = p.unit_id
           LEFT JOIN departments d ON d.id = p.department_id
           LEFT JOIN requisitions rq ON rq.id = p.requisition_id
           LEFT JOIN rfqs r ON r.id = p.rfq_id
           LEFT JOIN comparative_statements c ON c.id = p.comparative_statement_id
           LEFT JOIN quotations q ON q.id = p.quotation_id
           JOIN vendors v ON v.id = p.vendor_id
           LEFT JOIN users iu ON iu.id = p.issued_by
          WHERE ${where.join(' AND ')}
          ORDER BY p.created_at DESC, p.id DESC
          LIMIT ? OFFSET ?`
      )
      .all(...params, pageSize, offset);
    return { purchaseOrders: rows.map(poOut), total, page, pageSize };
  });

  router.post('/api/procurement/purchase-orders', async (ctx) => {
    auth.guard(ctx.user, 'po.manage');
    const body = ctx.body || {};
    const statementId = optionalId(body, 'comparativeStatementId');
    const ids = unitScope(ctx);
    const poDate = optionalDate(body, 'poDate') || today();
    const deliveryDate = optionalDate(body, 'deliveryDate');
    if (deliveryDate && deliveryDate < poDate) {
      throw new HttpError(400, 'Delivery date cannot be before the purchase order date.');
    }

    let unitId;
    let departmentId = null;
    let requisitionId = null;
    let rfqId = null;
    let quotationId = null;
    let vendorId;
    let lines;
    let paymentTerms;
    let auditSource;
    let discountDefaults = {};
    let termsFallback = '';

    if (statementId) {
      /* Purchase order awarded from an approved comparative statement. */
      const statement = rowOr404(
        ctx.db
          .prepare(
            `SELECT c.*, r.unit_id, r.department_id, r.requisition_id, r.rfq_no,
                    r.general_terms AS rfq_general_terms
               FROM comparative_statements c JOIN rfqs r ON r.id = c.rfq_id
              WHERE c.id = ? AND r.unit_id IN (${inList(ids)})`
          )
          .get(statementId, ...ids),
        'Comparative statement not found.'
      );
      if (statement.status !== 'approved') {
        throw new HttpError(400, 'Only an approved comparative statement can produce a purchase order.');
      }
      const existing = ctx.db
        .prepare(
          `SELECT 1 FROM purchase_orders
            WHERE comparative_statement_id = ? AND status <> 'cancelled' AND deleted_at IS NULL`
        )
        .get(statement.id);
      if (existing) throw new HttpError(400, 'A purchase order already exists for this comparative statement.');

      const quotation = rowOr404(
        ctx.db.prepare('SELECT * FROM quotations WHERE id = ? AND deleted_at IS NULL').get(statement.recommended_quotation_id),
        'Recommended quotation not found.'
      );
      ensureVendor(ctx.db, quotation.vendor_id);
      const quoteLines = ctx.db
        .prepare('SELECT * FROM quotation_items WHERE quotation_id = ? ORDER BY id')
        .all(quotation.id);
      if (!quoteLines.length) throw new HttpError(400, 'The recommended quotation has no lines.');

      const requisitionItems = ctx.db
        .prepare('SELECT * FROM rfq_items WHERE rfq_id = ?')
        .all(statement.rfq_id)
        .reduce((map, row) => map.set(row.id, row.requisition_item_id), new Map());

      unitId = statement.unit_id;
      departmentId = statement.department_id;
      requisitionId = statement.requisition_id;
      rfqId = statement.rfq_id;
      quotationId = quotation.id;
      vendorId = quotation.vendor_id;
      paymentTerms = body.paymentTerms === undefined ? quotation.payment_terms : optionalText(body, 'paymentTerms', 500);
      lines = quoteLines.map((line, index) => {
        /* quotation_items.discount_amount stores the applied total. Recover
         * the flat part so parseLine() does not add the percent twice. */
        const gross = round2(Number(line.quantity) * Number(line.unit_price));
        const percent = Number(line.discount_percent) || 0;
        const percentAmount = round2((gross * percent) / 100);
        return {
          requisitionItemId: line.rfq_item_id ? requisitionItems.get(line.rfq_item_id) || null : null,
          itemId: line.item_id,
          description: line.description,
          modelNo: line.model_no,
          make: line.make,
          uomId: line.uom_id,
          ...tax.parseLine({
            quantity: Number(line.quantity),
            unitPrice: Number(line.unit_price),
            discountPercent: percent,
            discountAmount: Math.max(0, round2(Number(line.discount_amount) - percentAmount)),
            taxRate: line.tax_rate,
            taxInclusive: line.tax_inclusive,
          }, index, tax.itemDefaults(ctx.db, line.item_id), 'Line'),
        };
      });
      /* Quotations store the applied discount total, so recover the flat part
       * before passing both values into the PO calculation. */
      const quoteGross = round2(quoteLines.reduce((sum, line) => sum + Number(line.total_amount || 0), 0));
      const quotePercentAmount = round2((quoteGross * Number(quotation.discount_percent || 0)) / 100);
      discountDefaults = {
        discountPercent: quotation.discount_percent,
        discountAmount: round2(Math.max(0, Number(quotation.discount_amount || 0) - quotePercentAmount)),
      };
      /* POs raised from a comparative statement inherit the terms that the
       * quotation copied from the RFQ; an explicit submission still wins. */
      termsFallback = String(quotation.general_terms || statement.rfq_general_terms || '');
      auditSource = { comparativeStatementId: statement.id, quotationId: quotation.id };
    } else {
      /* Direct purchase order: vendor, unit and lines entered by hand. */
      const requestedUnitId = optionalId(body, 'unitId');
      if (!requestedUnitId) throw new HttpError(400, 'Select a unit for the purchase order.');
      unitId = ensureUnit(ctx, requestedUnitId);
      vendorId = optionalId(body, 'vendorId');
      if (!vendorId) throw new HttpError(400, 'Select a vendor for the purchase order.');
      ensureVendor(ctx.db, vendorId);

      departmentId = optionalId(body, 'departmentId');
      if (departmentId) {
        const department = ctx.db
          .prepare('SELECT id FROM departments WHERE id = ? AND active = 1')
          .get(departmentId);
        if (!department) throw new HttpError(400, 'Selected department was not found or is inactive.');
      }

      lines = poLines(ctx, body);
      paymentTerms = body.paymentTerms === undefined ? '' : optionalText(body, 'paymentTerms', 500);
      auditSource = { direct: true };
    }

    let poNo;
    const headerDiscount = tax.parseHeaderDiscount({
      discountPercent: body.discountPercent ?? discountDefaults.discountPercent ?? 0,
      flatDiscountAmount: body.flatDiscountAmount ?? body.discountAmount ?? discountDefaults.discountAmount ?? 0,
      discountAmount: body.discountAmount ?? discountDefaults.discountAmount ?? 0,
    }, 'Purchase order');
    const deliveryValues = resolvePoDelivery(ctx, body, null, unitId, termsFallback);
    const now = nowIso();
    let id;
    let totals;
    transaction(ctx.db, () => {
      poNo = nextPurchaseOrderNo(unitId, departmentId, poDate);
      const res = ctx.db
        .prepare(
          `INSERT INTO purchase_orders(po_no, unit_id, department_id, requisition_id, rfq_id,
             comparative_statement_id, quotation_id, vendor_id, po_date, delivery_date, status,
             subtotal, tax_amount, discount_percent, flat_discount_amount, discount_amount, total_amount,
             freight_charges, loading_charges, other_charges,
             payment_terms, delivery_terms, terms, notes, reference,
             round_off, ${poDeliveryColumnList()},
             created_by, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,'draft',0,0,?,?,?,0,?,?,?,?,?,?,?,?, ?,${poDeliveryPlaceholders()},?,?,?)`
        )
        .run(
          poNo, unitId, departmentId, requisitionId, rfqId,
          statementId, quotationId, vendorId, poDate, deliveryDate,
          headerDiscount.discountPercent,
          headerDiscount.flatDiscountAmount,
          headerDiscount.discountAmount,
          Number(body.freightCharges) || 0, Number(body.loadingCharges) || 0, Number(body.otherCharges) || 0,
          paymentTerms,
          optionalText(body, 'deliveryTerms', 500), optionalText(body, 'terms', 2000),
          optionalText(body, 'notes', 1000), optionalText(body, 'reference', 200),
          0, ...poDeliveryParams(deliveryValues), ctx.user.id, now, now
        );
      id = Number(res.lastInsertRowid);
      replacePoItems(ctx.db, id, lines, now);
      totals = recalcPo(ctx.db, id, now, body.roundOff);
    });
    audit(ctx, 'CREATE', 'purchase_order', id, null, {
      poNo, ...auditSource, vendorId, itemCount: lines.length,
      discountPercent: headerDiscount.discountPercent,
      ...deliveryAudit(deliveryValues),
      roundOff: totals.roundOff,
      ...tax.auditSummary(lines, totals),
    });
    return { id, poNo, status: 'draft', roundOff: totals.roundOff };
  });

  router.get('/api/procurement/purchase-orders/:id', async (ctx) => {
    auth.guard(ctx.user, 'po.view');
    const po = getPo(ctx, ctx.params.id);
    const items = poItems(ctx.db, po.id);
    const revisions = ctx.db
      .prepare(
        `SELECT pr.id, pr.revision_no, pr.reason, pr.revised_at, u.name AS revised_by_name
           FROM po_revisions pr JOIN users u ON u.id = pr.revised_by
          WHERE pr.po_id = ? ORDER BY pr.revision_no DESC`
      )
      .all(po.id)
      .map((row) => ({
        id: row.id,
        revisionNo: row.revision_no,
        reason: row.reason || '',
        revisedAt: row.revised_at,
        revisedByName: row.revised_by_name || '',
      }));
    const grns = ctx.db
      .prepare(
        `SELECT g.*, s.name AS store_name, u.name AS received_by_name,
                (SELECT COUNT(*) FROM grn_items gi WHERE gi.grn_id = g.id) AS item_count
           FROM grns g
           LEFT JOIN stores s ON s.id = g.store_id
           JOIN users u ON u.id = g.received_by
          WHERE g.po_id = ?
          ORDER BY g.created_at DESC`
      )
      .all(po.id)
      .map(grnOut);
    const invoices = ctx.db
      .prepare(
        `SELECT i.id, i.invoice_no, i.supplier_invoice_no, i.status, i.net_amount, i.abmdas_bill_id
           FROM invoices i WHERE i.po_id = ? AND i.deleted_at IS NULL ORDER BY i.id DESC`
      )
      .all(po.id)
      .map((row) => ({
        id: row.id,
        invoiceNo: row.invoice_no,
        supplierInvoiceNo: row.supplier_invoice_no,
        status: row.status,
        netAmount: round2(row.net_amount),
        abmdasBillId: row.abmdas_bill_id,
      }));
    return {
      purchaseOrder: poOut(po),
      items,
      revisions,
      grns,
      invoices,
      photos: poPhotos(ctx.db, po.id),
      actions: {
        canEdit: po.status === 'draft' && auth.can(ctx.user, 'po.manage'),
        canIssue: po.status === 'draft' && auth.can(ctx.user, 'po.manage'),
        canRevise: ['issued', 'partially_received'].includes(po.status) && auth.can(ctx.user, 'po.manage'),
        canCancel: ['draft', 'issued'].includes(po.status) && auth.can(ctx.user, 'po.manage'),
        canDelete: po.status === 'draft' && auth.can(ctx.user, 'po.manage'),
        canReceive: OPEN_PO_STATUSES.includes(po.status) && auth.can(ctx.user, 'grn.manage'),
        canInvoice: ['issued', 'partially_received', 'received', 'closed'].includes(po.status)
          && auth.can(ctx.user, 'invoice.manage'),
      },
    };
  });

  router.get('/api/procurement/purchase-orders/:id/photos', async (ctx) => {
    auth.guard(ctx.user, 'po.view');
    const po = getPo(ctx, ctx.params.id);
    return { photos: poPhotos(ctx.db, po.id) };
  });

  router.post('/api/procurement/purchase-orders/:id/photos', async (ctx) => {
    auth.guard(ctx.user, 'po.manage');
    const po = getPo(ctx, ctx.params.id);
    const body = ctx.body || {};
    const name = String(body.fileName || body.name || '').trim().slice(0, 200);
    const mime = String(body.mimeType || body.mime || '').toLowerCase();
    if (!name || !body.data) throw badRequest('Choose a photo to upload.');
    if (!PO_PHOTO_MIMES.includes(mime)) throw badRequest('Photos must be JPEG, PNG or WebP images.');
    const buffer = Buffer.from(String(body.data), 'base64');
    if (!buffer.length) throw badRequest('The photo is empty.');
    if (buffer.length > PO_PHOTO_MAX_BYTES) throw badRequest('Photos must be 5 MB or smaller.');
    if (!photoMagicMatches(buffer, mime)) throw badRequest('The file content does not match its type.');
    const used = ctx.db
      .prepare('SELECT COUNT(*) AS c FROM po_reference_photos WHERE po_id = ? AND deleted_at IS NULL')
      .get(po.id).c;
    if (used >= PO_PHOTO_MAX_COUNT) throw badRequest(`A purchase order can carry at most ${PO_PHOTO_MAX_COUNT} reference photos.`);

    const rawPoItemId = body.poItemId ?? body.po_item_id ?? null;
    let poItemId = null;
    if (rawPoItemId !== null && rawPoItemId !== undefined && String(rawPoItemId).trim() !== '') {
      poItemId = Number(rawPoItemId);
      if (!Number.isInteger(poItemId) || poItemId <= 0) throw badRequest('Invalid PO item.');
      const poItem = ctx.db.prepare('SELECT id FROM po_items WHERE id = ? AND po_id = ?').get(poItemId, po.id);
      if (!poItem) throw badRequest('The selected PO item does not belong to this order.');
    }

    const saved = saveUpload({ name, data: String(body.data) }, PO_PHOTO_UPLOAD_DIR);
    const caption = String(body.caption || '').trim().slice(0, 200);
    const now = nowIso();
    const result = ctx.db
      .prepare(
        `INSERT INTO po_reference_photos(po_id, po_item_id, file_name, stored_name, mime_type, size, caption, uploaded_by, uploaded_at)
         VALUES (?,?,?,?,?,?,?,?,?)`
      )
      .run(po.id, poItemId, name, saved.stored, mime, saved.size, caption, ctx.user.id, now);
    const photoId = Number(result.lastInsertRowid);
    audit(ctx, 'CREATE', 'po_reference_photo', photoId, null, { poId: po.id, poItemId, fileName: name, caption });
    return { id: photoId, url: `/api/files/po-reference-photo/${photoId}`, fileName: name, caption, poItemId };
  });

  router.delete('/api/procurement/purchase-orders/:id/photos/:photoId', async (ctx) => {
    auth.guard(ctx.user, 'po.manage');
    const po = getPo(ctx, ctx.params.id);
    const row = ctx.db
      .prepare('SELECT * FROM po_reference_photos WHERE id = ? AND po_id = ? AND deleted_at IS NULL')
      .get(Number(ctx.params.photoId), po.id);
    if (!row) throw new HttpError(404, 'Reference photo not found.');
    const now = nowIso();
    ctx.db
      .prepare('UPDATE po_reference_photos SET deleted_at = ?, deleted_by = ? WHERE id = ?')
      .run(now, ctx.user.id, row.id);
    audit(ctx, 'DELETE', 'po_reference_photo', row.id, { fileName: row.file_name }, { deletedAt: now });
    return { ok: true };
  });

  router.put('/api/procurement/purchase-orders/:id', async (ctx) => {
    auth.guard(ctx.user, 'po.manage');
    const po = getPo(ctx, ctx.params.id);
    if (po.status !== 'draft') throw new HttpError(400, 'Only draft purchase orders can be edited.');
    const body = ctx.body || {};
    const existingItems = poItems(ctx.db, po.id);
    const lines = body.items === undefined ? null : poLines(ctx, body, existingItems);
    const poDate = optionalDate(body, 'poDate') || po.po_date;
    const deliveryDate = body.deliveryDate === undefined ? po.delivery_date : optionalDate(body, 'deliveryDate');
    if (deliveryDate && deliveryDate < poDate) {
      throw new HttpError(400, 'Delivery date cannot be before the purchase order date.');
    }
    const now = nowIso();
    const headerDiscount = tax.parseHeaderDiscount({
      discountPercent: body.discountPercent ?? po.discount_percent ?? 0,
      flatDiscountAmount: body.flatDiscountAmount
        ?? (body.discountAmount === undefined ? po.flat_discount_amount ?? 0 : body.discountAmount),
      discountAmount: body.discountAmount ?? po.discount_amount ?? 0,
    }, 'Purchase order');
    const deliveryValues = resolvePoDelivery(ctx, body, po, po.unit_id);
    let totals;
    transaction(ctx.db, () => {
      ctx.db
        .prepare(
          `UPDATE purchase_orders SET po_date=?, delivery_date=?, freight_charges=?, loading_charges=?, other_charges=?,
              discount_percent=?, flat_discount_amount=?, discount_amount=?,
              payment_terms=?, delivery_terms=?, terms=?, notes=?, reference=?,
              ${poDeliveryAssignments()}, updated_at=? WHERE id=?`
        )
        .run(
          poDate, deliveryDate,
          body.freightCharges === undefined ? po.freight_charges : (Number(body.freightCharges) || 0),
          body.loadingCharges === undefined ? po.loading_charges : (Number(body.loadingCharges) || 0),
          body.otherCharges === undefined ? po.other_charges : (Number(body.otherCharges) || 0),
          headerDiscount.discountPercent, headerDiscount.flatDiscountAmount, headerDiscount.discountAmount,
          body.paymentTerms === undefined ? po.payment_terms : optionalText(body, 'paymentTerms', 500),
          body.deliveryTerms === undefined ? po.delivery_terms : optionalText(body, 'deliveryTerms', 500),
          body.terms === undefined ? po.terms : optionalText(body, 'terms', 2000),
          body.notes === undefined ? po.notes : optionalText(body, 'notes', 1000),
          body.reference === undefined ? (po.reference || '') : optionalText(body, 'reference', 200),
          ...poDeliveryParams(deliveryValues), now, po.id
        );
      if (lines) replacePoItems(ctx.db, po.id, lines, now);
      /* Round-off depends on lines, header discount and charges, so always
       * recalculate — a submitted manual adjustment is preserved. */
      totals = recalcPo(ctx.db, po.id, now, body.roundOff ?? po.round_off);
    });
    audit(ctx, 'UPDATE', 'purchase_order', po.id, { poNo: po.po_no }, {
      itemCount: lines?.length,
      discountPercent: headerDiscount.discountPercent,
      ...deliveryAudit(deliveryValues),
      roundOff: totals.roundOff,
      ...(lines ? tax.auditSummary(lines, totals) : {}),
    });
    return { ok: true, roundOff: totals.roundOff };
  });

  router.delete('/api/procurement/purchase-orders/:id', async (ctx) => {
    auth.guard(ctx.user, 'po.manage');
    const po = getPo(ctx, ctx.params.id);
    if (po.status !== 'draft') throw new HttpError(400, 'Only draft purchase orders can be deleted.');
    const now = nowIso();
    ctx.db
      .prepare('UPDATE purchase_orders SET deleted_at=?, deleted_by=?, delete_reason=?, updated_at=? WHERE id=?')
      .run(now, ctx.user.id, optionalText(ctx.body || {}, 'reason', 300), now, po.id);
    audit(ctx, 'DELETE', 'purchase_order', po.id, { poNo: po.po_no }, { deletedAt: now });
    return { ok: true };
  });

  router.post('/api/procurement/purchase-orders/:id/issue', async (ctx) => {
    auth.guard(ctx.user, 'po.manage');
    const po = getPo(ctx, ctx.params.id);
    if (po.status !== 'draft') throw new HttpError(400, 'Only draft purchase orders can be issued.');
    if (!poItems(ctx.db, po.id).length) throw new HttpError(400, 'Add at least one item before issuing.');
    ensureVendor(ctx.db, po.vendor_id);
    const now = nowIso();
    transaction(ctx.db, () => {
      ctx.db
        .prepare("UPDATE purchase_orders SET status='issued', issued_by=?, issued_at=?, updated_at=? WHERE id=?")
        .run(ctx.user.id, now, now, po.id);
      if (po.requisition_id) {
        ctx.db
          .prepare(
            `UPDATE requisitions SET status='closed', closed_at=COALESCE(closed_at, ?), updated_at=?
              WHERE id=? AND status IN ('sourcing','store_verification','issued','approved')`
          )
          .run(now, now, po.requisition_id);
      }
      if (po.rfq_id) {
        ctx.db
          .prepare("UPDATE rfqs SET status='closed', closed_at=COALESCE(closed_at, ?), updated_at=? WHERE id=?")
          .run(now, now, po.rfq_id);
      }
    });
    notify(
      [po.issued_by || po.created_by],
      'Purchase order issued',
      `${po.po_no} issued to ${po.vendor_name}.`,
      `/purchase-orders/${po.id}`
    );
    audit(ctx, 'ISSUE', 'purchase_order', po.id, { status: 'draft' }, {
      status: 'issued', requisitionId: po.requisition_id, rfqId: po.rfq_id,
    });
    return { ok: true, status: 'issued' };
  });

  router.post('/api/procurement/purchase-orders/:id/revise', async (ctx) => {
    auth.guard(ctx.user, 'po.manage');
    const po = getPo(ctx, ctx.params.id);
    if (!['issued', 'partially_received'].includes(po.status)) {
      throw new HttpError(400, 'Only issued purchase orders can be revised.');
    }
    const invoice = ctx.db
      .prepare("SELECT 1 FROM invoices WHERE po_id = ? AND status <> 'cancelled' AND deleted_at IS NULL")
      .get(po.id);
    if (invoice) throw new HttpError(400, 'A purchase order with invoices cannot be revised.');
    const body = ctx.body || {};
    const reason = requireText(body, 'reason', 'Revision reason', 500);
    const existingItems = poItems(ctx.db, po.id);
    const lines = poLines(ctx, body, existingItems);
    const poDate = optionalDate(body, 'poDate') || po.po_date;
    const deliveryDate = body.deliveryDate === undefined ? po.delivery_date : optionalDate(body, 'deliveryDate');
    if (deliveryDate && deliveryDate < poDate) {
      throw new HttpError(400, 'Delivery date cannot be before the purchase order date.');
    }
    const now = nowIso();
    const headerDiscount = tax.parseHeaderDiscount({
      discountPercent: body.discountPercent ?? po.discount_percent ?? 0,
      flatDiscountAmount: body.flatDiscountAmount
        ?? (body.discountAmount === undefined ? po.flat_discount_amount ?? 0 : body.discountAmount),
      discountAmount: body.discountAmount ?? po.discount_amount ?? 0,
    }, 'Purchase order');
    const deliveryValues = resolvePoDelivery(ctx, body, po, po.unit_id);
    let revisionNo;
    let revisionTotals;
    transaction(ctx.db, () => {
      const snapshotItems = poItems(ctx.db, po.id);
      revisionNo = snapshotPo(ctx.db, po, snapshotItems, reason, ctx.user.id, now);
      ctx.db
        .prepare(
          `UPDATE purchase_orders SET po_date=?, delivery_date=?, payment_terms=?, delivery_terms=?,
             terms=?, notes=?, reference=?, freight_charges=?, loading_charges=?, other_charges=?,
             discount_percent=?, flat_discount_amount=?, discount_amount=?,
            ${poDeliveryAssignments()}, updated_at=? WHERE id=?`
        )
        .run(
          poDate, deliveryDate,
          body.paymentTerms === undefined ? po.payment_terms : optionalText(body, 'paymentTerms', 500),
          body.deliveryTerms === undefined ? po.delivery_terms : optionalText(body, 'deliveryTerms', 500),
          body.terms === undefined ? po.terms : optionalText(body, 'terms', 2000),
          body.notes === undefined ? po.notes : optionalText(body, 'notes', 1000),
          body.reference === undefined ? (po.reference || '') : optionalText(body, 'reference', 200),
          body.freightCharges === undefined ? po.freight_charges : (Number(body.freightCharges) || 0),
          body.loadingCharges === undefined ? po.loading_charges : (Number(body.loadingCharges) || 0),
          body.otherCharges === undefined ? po.other_charges : (Number(body.otherCharges) || 0),
          headerDiscount.discountPercent, headerDiscount.flatDiscountAmount, headerDiscount.discountAmount,
          ...poDeliveryParams(deliveryValues), now, po.id
        );

      const insert = ctx.db.prepare(
        `INSERT INTO po_items(po_id, requisition_item_id, item_id, item_name, description, model_no, make, uom_id,
           quantity, unit_price, discount_percent, flat_discount_amount, discount_amount, tax_rate, tax_inclusive,
           taxable_amount, tax_amount, total_amount, received_quantity,
           rejected_quantity, invoiced_quantity, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      );
      const keep = new Set();
      for (const line of lines) {
        if (line.id) {
          ctx.db
            .prepare(
              `UPDATE po_items SET requisition_item_id=?, item_id=?, item_name=?, description=?, model_no=?, make=?, uom_id=?,
                 quantity=?, unit_price=?, discount_percent=?, flat_discount_amount=?, discount_amount=?, tax_rate=?, tax_inclusive=?,
                 taxable_amount=?, tax_amount=?, total_amount=?, updated_at=?
               WHERE id=? AND po_id=?`
            )
            .run(
              line.requisitionItemId || null, line.itemId, line.itemName || line.description, line.description, line.modelNo || null, line.make || null, line.uomId,
              line.quantity, line.unitPrice, line.discountPercent || 0, line.flatDiscountAmount || 0, line.discountAmount || 0,
              line.taxRate, line.taxInclusive ? 1 : 0, line.taxableAmount || 0,
              line.taxAmount, line.totalAmount,
              now, line.id, po.id
            );
          keep.add(line.id);
        } else {
          const res = insert.run(
            po.id, line.requisitionItemId || null, line.itemId, line.itemName || line.description, line.description,
            line.modelNo || null, line.make || null, line.uomId,
            line.quantity, line.unitPrice, line.discountPercent || 0, line.flatDiscountAmount || 0, line.discountAmount || 0,
            line.taxRate, line.taxInclusive ? 1 : 0, line.taxableAmount || 0,
            line.taxAmount, line.totalAmount,
            0, 0, 0, now, now
          );
          keep.add(Number(res.lastInsertRowid));
        }
      }
      for (const item of existingItems) {
        if (!keep.has(item.id)) {
          if (item.receivedQuantity > 0 || item.invoicedQuantity > 0) {
            throw new HttpError(400, 'A purchase order line with receipts or invoices cannot be removed.');
          }
          ctx.db.prepare('DELETE FROM po_items WHERE id = ? AND po_id = ?').run(item.id, po.id);
        }
      }
      const totals = recalcPo(ctx.db, po.id, now, body.roundOff ?? po.round_off);
      revisionTotals = totals;
    });
    audit(ctx, 'REVISE', 'purchase_order', po.id, { revisionNo: po.revision_no }, {
      revisionNo, reason,
      discountPercent: headerDiscount.discountPercent,
      ...deliveryAudit(deliveryValues),
      roundOff: revisionTotals.roundOff,
      ...tax.auditSummary(lines, revisionTotals),
    });
    return { ok: true, revisionNo, roundOff: revisionTotals.roundOff };
  });

  router.post('/api/procurement/purchase-orders/:id/cancel', async (ctx) => {
    auth.guard(ctx.user, 'po.manage');
    const po = getPo(ctx, ctx.params.id);
    if (!['draft', 'issued'].includes(po.status)) throw new HttpError(400, 'This purchase order cannot be cancelled.');
    const grn = ctx.db.prepare("SELECT 1 FROM grns WHERE po_id = ? AND status = 'posted'").get(po.id);
    if (grn) throw new HttpError(400, 'A purchase order with posted receipts cannot be cancelled.');
    const invoice = ctx.db
      .prepare("SELECT 1 FROM invoices WHERE po_id = ? AND status <> 'cancelled' AND deleted_at IS NULL")
      .get(po.id);
    if (invoice) throw new HttpError(400, 'A purchase order with invoices cannot be cancelled.');
    const reason = requireText(ctx.body || {}, 'reason', 'Cancellation reason', 500);
    const now = nowIso();
    ctx.db
      .prepare("UPDATE purchase_orders SET status='cancelled', cancelled_by=?, cancelled_at=?, cancel_reason=?, updated_at=? WHERE id=?")
      .run(ctx.user.id, now, reason, now, po.id);
    audit(ctx, 'CANCEL', 'purchase_order', po.id, { status: po.status }, { status: 'cancelled', reason });
    return { ok: true, status: 'cancelled' };
  });

  /* --------------------------- Goods receipts --------------------- */
  router.get('/api/procurement/grns/meta', async (ctx) => {
    auth.guard(ctx.user, 'grn.view');
    const ids = unitScope(ctx);
    const ph = inList(ids);
    const purchaseOrders = ctx.db
      .prepare(
        `SELECT p.id, p.po_no, p.status, p.vendor_id, v.name AS vendor_name,
                p.unit_id, p.delivery_date
           FROM purchase_orders p JOIN vendors v ON v.id = p.vendor_id
          WHERE p.deleted_at IS NULL AND p.status IN ('issued','partially_received')
            AND p.unit_id IN (${ph})
          ORDER BY p.po_date DESC, p.id DESC`
      )
      .all(...ids)
      .map((row) => ({
        id: row.id,
        poNo: row.po_no,
        status: row.status,
        vendorId: row.vendor_id,
        vendorName: row.vendor_name,
        unitId: row.unit_id,
        deliveryDate: row.delivery_date,
      }));
    const stores = ctx.db
      .prepare(
        `SELECT s.id, s.unit_id, s.code, s.name FROM stores s
          WHERE s.deleted_at IS NULL AND s.unit_id IN (${ph}) ORDER BY s.name`
      )
      .all(...ids)
      .map((row) => ({ id: row.id, unitId: row.unit_id, code: row.code, name: row.name }));
    const bins = ctx.db
      .prepare(
        `SELECT b.id, b.store_id, b.code, b.name FROM bins b
           JOIN stores s ON s.id = b.store_id
          WHERE b.deleted_at IS NULL AND s.deleted_at IS NULL AND s.unit_id IN (${ph})
          ORDER BY b.name`
      )
      .all(...ids)
      .map((row) => ({ id: row.id, storeId: row.store_id, code: row.code, name: row.name }));
    return {
      purchaseOrders,
      stores,
      bins,
      statuses: ['draft', 'posted', 'cancelled'].map((value) => ({ value, label: value })),
      today: today(),
    };
  });

  router.get('/api/procurement/grns', async (ctx) => {
    auth.guard(ctx.user, 'grn.view');
    const ids = unitScope(ctx);
    const q = ctx.query || {};
    const where = [`g.unit_id IN (${inList(ids)})`];
    const params = [...ids];
    if (q.search) {
      const like = `%${String(q.search).trim()}%`;
      where.push('(g.grn_no LIKE ? OR p.po_no LIKE ? OR g.challan_no LIKE ?)');
      params.push(like, like, like);
    }
    if (q.status && ['draft', 'posted', 'cancelled'].includes(String(q.status))) {
      where.push('g.status = ?');
      params.push(String(q.status));
    }
    if (q.poId) {
      where.push('g.po_id = ?');
      params.push(Number(q.poId));
    }
    const { page, pageSize, offset } = pageParams(q);
    const total = ctx.db
      .prepare(
        `SELECT COUNT(*) AS c FROM grns g JOIN purchase_orders p ON p.id = g.po_id
          WHERE ${where.join(' AND ')}`
      )
      .get(...params).c;
    const rows = ctx.db
      .prepare(
        `SELECT g.*, p.po_no, p.vendor_id, v.code AS vendor_code, v.name AS vendor_name,
                u.name AS unit_name, s.name AS store_name,
                ru.name AS received_by_name, cu.name AS created_by_name,
                (SELECT COUNT(*) FROM grn_items gi WHERE gi.grn_id = g.id) AS item_count
           FROM grns g
           JOIN purchase_orders p ON p.id = g.po_id
           JOIN vendors v ON v.id = p.vendor_id
           JOIN units u ON u.id = g.unit_id
           LEFT JOIN stores s ON s.id = g.store_id
           JOIN users ru ON ru.id = g.received_by
           JOIN users cu ON cu.id = g.created_by
          WHERE ${where.join(' AND ')}
          ORDER BY g.created_at DESC, g.id DESC
          LIMIT ? OFFSET ?`
      )
      .all(...params, pageSize, offset);
    return { grns: rows.map(grnOut), total, page, pageSize };
  });

  router.post('/api/procurement/grns', async (ctx) => {
    auth.guard(ctx.user, 'grn.manage');
    const body = ctx.body || {};
    const poId = optionalId(body, 'poId');
    if (!poId) throw new HttpError(400, 'Select a purchase order.');
    const po = getPo(ctx, poId);
    if (!OPEN_PO_STATUSES.includes(po.status)) {
      throw new HttpError(400, 'Receipts can only be recorded against an issued purchase order.');
    }
    const headerDiscount = tax.parseHeaderDiscount({
      discountPercent: body.discountPercent ?? po.discount_percent ?? 0,
      flatDiscountAmount: body.flatDiscountAmount
        ?? (body.discountAmount === undefined ? po.flat_discount_amount ?? 0 : body.discountAmount),
      discountAmount: body.discountAmount ?? po.discount_amount ?? 0,
    }, 'Goods receipt');
    const storeId = optionalId(body, 'storeId');
    if (storeId) {
      const store = ctx.db
        .prepare('SELECT * FROM stores WHERE id = ? AND deleted_at IS NULL')
        .get(storeId);
      if (!store || Number(store.unit_id) !== Number(po.unit_id)) {
        throw new HttpError(400, 'Store does not belong to the purchase order unit.');
      }
    }
    const receivedDate = optionalDate(body, 'receivedDate') || today();
    const list = Array.isArray(body.items) ? body.items : [];
    if (!list.length) throw new HttpError(400, 'Add at least one received line.');
    const poLines = poItems(ctx.db, po.id);
    const lineMap = new Map(poLines.map((line) => [line.id, line]));
    const seen = new Set();
    const excessAuthorized = body.excessAuthorized === true || body.excessAuthorized === 1 || body.excessAuthorized === '1';

    const lines = list.map((line, index) => {
      const poItemId = Number(line.poItemId);
      const poLine = lineMap.get(poItemId);
      if (!poLine) throw new HttpError(400, `Line ${index + 1}: purchase order line was not found.`);
      if (seen.has(poItemId)) throw new HttpError(400, `Line ${index + 1}: purchase order line is repeated.`);
      seen.add(poItemId);
      const received = Number(line.receivedQuantity ?? line.quantity);
      if (!Number.isFinite(received) || received <= 0) {
        throw new HttpError(400, `Line ${index + 1}: received quantity must be greater than zero.`);
      }
      const accepted = line.acceptedQuantity === undefined || line.acceptedQuantity === ''
        ? received
        : Number(line.acceptedQuantity);
      const rejected = line.rejectedQuantity === undefined || line.rejectedQuantity === ''
        ? 0
        : Number(line.rejectedQuantity);
      if (!Number.isFinite(accepted) || accepted < 0 || !Number.isFinite(rejected) || rejected < 0) {
        throw new HttpError(400, `Line ${index + 1}: accepted and rejected quantities cannot be negative.`);
      }
      if (Math.abs(accepted + rejected - received) > 0.004) {
        throw new HttpError(400, `Line ${index + 1}: accepted plus rejected must equal the received quantity.`);
      }
      if (accepted > 0 && poLine.trackInventory && !storeId) {
        throw new HttpError(400, `Line ${index + 1}: select the receiving store for inventory items.`);
      }
      if (poLine.itemType === 'asset' && accepted > 0) {
        const settings = assetSettings.resolveAssetSettings(ctx.db, poLine.itemId)?.effective || {};
        if (settings.serialRequired) {
          const ad = line.assetDetails && typeof line.assetDetails === 'object'
            ? line.assetDetails
            : { serialNumbers: line.serialNumbers };
          const serials = String(ad.serialNumbers || '').split(/[\n,;]+/).map((s) => s.trim()).filter(Boolean);
          const needed = Math.round(accepted);
          if (new Set(serials).size !== serials.length) {
            throw new HttpError(400, `Line ${index + 1}: serial numbers must be unique.`);
          }
          if (serials.length < needed) {
            throw new HttpError(400, `Line ${index + 1}: enter one serial number per accepted unit (${serials.length} of ${needed} entered).`);
          }
        }
      }
      const binId = optionalId(line, 'binId');
      if (binId) {
        const bin = ctx.db
          .prepare('SELECT * FROM bins WHERE id = ? AND deleted_at IS NULL')
          .get(binId);
        if (!bin || !storeId || Number(bin.store_id) !== Number(storeId)) {
          throw new HttpError(400, `Line ${index + 1}: bin does not belong to the selected store.`);
        }
      } else if (accepted > 0 && poLine.trackInventory && storeId) {
        /* Bin is optional; stock is held at the store level when no bin is chosen. */
      }
      if (received > poLine.remainingQuantity + 0.004 && !excessAuthorized) {
        throw new HttpError(
          400,
          `Line ${index + 1}: received quantity exceeds the ordered balance. Set excess authorisation to continue.`
        );
      }
      return {
        poItemId,
        itemId: poLine.itemId,
        itemType: poLine.itemType || '',
        binId,
        orderedQuantity: poLine.quantity,
        receivedQuantity: round2(received),
        acceptedQuantity: round2(accepted),
        rejectedQuantity: round2(rejected),
        unitPrice: poLine.unitPrice,
        discountPercent: poLine.discountPercent,
        discountAmount: poLine.discountAmount,
        taxRate: poLine.taxRate,
        taxInclusive: poLine.taxInclusive,
        amountBasis: grnLineAmounts(poLine, round2(accepted)),
        remarks: optionalText(line, 'remarks', 300),
        assetDetails: (line.assetDetails && typeof line.assetDetails === 'object')
          ? line.assetDetails
          : {
              modelNo: line.modelNo,
              manufacturer: line.manufacturer,
              serialNumbers: line.serialNumbers,
              warrantyStart: line.warrantyStart,
              warrantyEnd: line.warrantyEnd,
              condition: line.condition,
              remarks: line.assetRemarks,
            },
      };
    });

    const grnNo = nextGrnNo();
    const grnDocument = tax.calculateDocument(lines.map((line) => line.amountBasis), {
      ...headerDiscount,
      roundOff: body.roundOff,
    });
    const grnAmounts = documentAmounts(grnDocument, body.roundOff);
    const now = nowIso();
    let id;
    transaction(ctx.db, () => {
      const res = ctx.db
        .prepare(
          `INSERT INTO grns(grn_no, po_id, unit_id, store_id, received_date, received_by, status,
             challan_no, challan_date, vehicle_no, remarks, discount_percent, flat_discount_amount, discount_amount,
             round_off, excess_authorized, created_by, created_at, updated_at)
           VALUES (?,?,?,?,?,?,'draft',?,?,?,?,?,?,?,?,?,?,?,?)`
        )
        .run(
          grnNo, po.id, po.unit_id, storeId, receivedDate, ctx.user.id,
          optionalText(body, 'challanNo', 100), optionalDate(body, 'challanDate'),
          optionalText(body, 'vehicleNo', 100), optionalText(body, 'remarks', 1000),
          headerDiscount.discountPercent, headerDiscount.flatDiscountAmount, headerDiscount.discountAmount,
          grnAmounts.roundOff,
          excessAuthorized ? 1 : 0, ctx.user.id, now, now
        );
      id = Number(res.lastInsertRowid);
      const insert = ctx.db.prepare(
        `INSERT INTO grn_items(grn_id, po_item_id, item_id, bin_id, ordered_quantity,
           received_quantity, accepted_quantity, rejected_quantity, unit_price,
           discount_percent, discount_amount, tax_rate, tax_inclusive,
           taxable_amount, tax_amount, total_amount, remarks, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      );
      const insertAssetDetails = ctx.db.prepare(
        `INSERT INTO grn_item_asset_details(grn_item_id, model_no, manufacturer, serial_numbers,
           warranty_start, warranty_end, condition, remarks, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`
      );
      for (const line of lines) {
        const res = insert.run(
          id, line.poItemId, line.itemId, line.binId, line.orderedQuantity,
          line.receivedQuantity, line.acceptedQuantity, line.rejectedQuantity,
          line.unitPrice,
          line.amountBasis.discountPercent, line.amountBasis.discountAmount,
          line.amountBasis.taxRate, line.amountBasis.taxInclusive ? 1 : 0,
          line.amountBasis.taxableAmount, line.amountBasis.taxAmount, line.amountBasis.totalAmount,
          line.remarks, now
        );
        const grnItemId = Number(res.lastInsertRowid);
        const ad = line.assetDetails || {};
        const hasAssetDetail = line.itemType === 'asset' && (
          optionalText(ad, 'modelNo', 200) || optionalText(ad, 'manufacturer', 200) ||
          optionalText(ad, 'serialNumbers', 4000) || optionalDate(ad, 'warrantyStart') ||
          optionalDate(ad, 'warrantyEnd') || optionalText(ad, 'condition', 100) ||
          optionalText(ad, 'remarks', 500)
        );
        if (hasAssetDetail) {
          insertAssetDetails.run(
            grnItemId,
            optionalText(ad, 'modelNo', 200) || null,
            optionalText(ad, 'manufacturer', 200) || null,
            optionalText(ad, 'serialNumbers', 4000) || null,
            optionalDate(ad, 'warrantyStart'),
            optionalDate(ad, 'warrantyEnd'),
            optionalText(ad, 'condition', 100) || null,
            optionalText(ad, 'remarks', 500) || null,
            now, now
          );
        }
      }
    });
    audit(ctx, 'CREATE', 'grn', id, null, {
      grnNo, poId: po.id, itemCount: lines.length, roundOff: grnAmounts.roundOff,
      ...tax.auditSummary(lines.map((line) => line.amountBasis), grnDocument),
    });
    return { id, grnNo, status: 'draft', roundOff: grnAmounts.roundOff };
  });

  router.get('/api/procurement/grns/:id', async (ctx) => {
    auth.guard(ctx.user, 'grn.view');
    const grn = getGrn(ctx, ctx.params.id);
    const items = grnItems(ctx.db, grn.id);
    const po = getPo(ctx, grn.po_id);
    return {
      grn: grnOut(grn),
      items,
      purchaseOrder: poOut(po),
      actions: {
        canEdit: grn.status === 'draft' && auth.can(ctx.user, 'grn.manage'),
        canPost: grn.status === 'draft' && auth.can(ctx.user, 'grn.manage'),
        canCancel: grn.status === 'draft' && auth.can(ctx.user, 'grn.manage'),
      },
    };
  });

  router.put('/api/procurement/grns/:id', async (ctx) => {
    auth.guard(ctx.user, 'grn.manage');
    const grn = getGrn(ctx, ctx.params.id);
    if (grn.status !== 'draft') throw new HttpError(400, 'Only draft goods receipts can be edited.');
    const body = ctx.body || {};
    const storeId = body.storeId === undefined ? grn.store_id : optionalId(body, 'storeId');
    if (storeId) {
      const store = ctx.db.prepare('SELECT * FROM stores WHERE id = ? AND deleted_at IS NULL').get(storeId);
      if (!store || Number(store.unit_id) !== Number(grn.unit_id)) {
        throw new HttpError(400, 'Store does not belong to the receipt unit.');
      }
    }
    const now = nowIso();
    const headerDiscount = tax.parseHeaderDiscount({
      discountPercent: body.discountPercent ?? grn.discount_percent ?? 0,
      flatDiscountAmount: body.flatDiscountAmount
        ?? (body.discountAmount === undefined ? grn.flat_discount_amount ?? 0 : body.discountAmount),
      discountAmount: body.discountAmount ?? grn.discount_amount ?? 0,
    }, 'Goods receipt');
    const roundOffOverride = body.roundOff ?? grn.round_off;
    const grnDocument = tax.calculateDocument(grnItems(ctx.db, grn.id), {
      ...headerDiscount,
      roundOff: roundOffOverride,
    });
    const grnAmounts = documentAmounts(grnDocument, roundOffOverride);
    ctx.db
      .prepare(
        `UPDATE grns SET store_id=?, received_date=?, challan_no=?, challan_date=?, vehicle_no=?,
           remarks=?, discount_percent=?, flat_discount_amount=?, discount_amount=?, round_off=?,
           excess_authorized=?, updated_at=? WHERE id=?`
      )
      .run(
        storeId,
        body.receivedDate === undefined ? grn.received_date : (optionalDate(body, 'receivedDate') || grn.received_date),
        body.challanNo === undefined ? grn.challan_no : optionalText(body, 'challanNo', 100),
        body.challanDate === undefined ? grn.challan_date : optionalDate(body, 'challanDate'),
        body.vehicleNo === undefined ? grn.vehicle_no : optionalText(body, 'vehicleNo', 100),
        body.remarks === undefined ? grn.remarks : optionalText(body, 'remarks', 1000),
        headerDiscount.discountPercent, headerDiscount.flatDiscountAmount, headerDiscount.discountAmount,
        grnAmounts.roundOff,
        body.excessAuthorized === undefined ? Number(grn.excess_authorized) : (body.excessAuthorized ? 1 : 0),
        now, grn.id
      );
    audit(ctx, 'UPDATE', 'grn', grn.id, { grnNo: grn.grn_no }, {
      storeId, roundOff: grnAmounts.roundOff, discountPercent: headerDiscount.discountPercent,
    });
    return { ok: true, roundOff: grnAmounts.roundOff };
  });

  router.delete('/api/procurement/grns/:id', async (ctx) => {
    auth.guard(ctx.user, 'grn.manage');
    const grn = getGrn(ctx, ctx.params.id);
    if (grn.status !== 'draft') throw new HttpError(400, 'Only draft goods receipts can be deleted.');
    ctx.db.prepare('DELETE FROM grns WHERE id = ?').run(grn.id);
    audit(ctx, 'DELETE', 'grn', grn.id, { grnNo: grn.grn_no }, null);
    return { ok: true };
  });

  router.post('/api/procurement/grns/:id/cancel', async (ctx) => {
    auth.guard(ctx.user, 'grn.manage');
    const grn = getGrn(ctx, ctx.params.id);
    if (grn.status !== 'draft') throw new HttpError(400, 'Only draft goods receipts can be cancelled.');
    const reason = requireText(ctx.body || {}, 'reason', 'Cancellation reason', 500);
    const now = nowIso();
    ctx.db
      .prepare("UPDATE grns SET status='cancelled', cancelled_by=?, cancelled_at=?, cancel_reason=?, updated_at=? WHERE id=?")
      .run(ctx.user.id, now, reason, now, grn.id);
    audit(ctx, 'CANCEL', 'grn', grn.id, { status: 'draft' }, { status: 'cancelled', reason });
    return { ok: true, status: 'cancelled' };
  });

  router.post('/api/procurement/grns/:id/post', async (ctx) => {
    auth.guard(ctx.user, 'grn.manage');
    const grn = getGrn(ctx, ctx.params.id);
    if (grn.status !== 'draft') throw new HttpError(400, 'Only draft goods receipts can be posted.');
    const po = getPo(ctx, grn.po_id);
    if (!OPEN_PO_STATUSES.includes(po.status)) {
      throw new HttpError(400, 'This purchase order is not open for receipts.');
    }
    const items = grnItems(ctx.db, grn.id);
    if (!items.length) throw new HttpError(400, 'A goods receipt needs at least one line.');
    if (items.some((item) => item.acceptedQuantity > 0 && item.trackInventory) && !grn.store_id) {
      throw new HttpError(400, 'Select the receiving store before posting inventory items.');
    }
    const now = nowIso();
    let assetIds = [];
    transaction(ctx.db, () => {
      for (const line of items) {
        if (line.acceptedQuantity > 0 && line.trackInventory) {
          const storeId = Number(grn.store_id);
          const binId = line.binId ?? null;
          const balance = ctx.db
            .prepare(
              `SELECT * FROM stock_balances
                WHERE store_id = ? AND COALESCE(bin_id, 0) = COALESCE(?, 0) AND item_id = ?`
            )
            .get(storeId, binId, line.itemId);
          let newQty;
          if (balance) {
            newQty = round2(Number(balance.quantity) + line.acceptedQuantity);
            ctx.db
              .prepare('UPDATE stock_balances SET quantity=?, updated_at=? WHERE id=?')
              .run(newQty, now, balance.id);
          } else {
            newQty = round2(line.acceptedQuantity);
            const res = ctx.db
              .prepare(
                `INSERT INTO stock_balances(unit_id, store_id, bin_id, item_id, quantity, created_at, updated_at)
                 VALUES (?,?,?,?,?,?,?)`
              )
              .run(grn.unit_id, storeId, binId, line.itemId, newQty, now, now);
            if (!res || !res.lastInsertRowid) throw new HttpError(500, 'Stock balance could not be recorded.');
          }
          ctx.db
            .prepare(
              `INSERT INTO stock_ledger(unit_id, store_id, bin_id, item_id, transaction_type, reference_type,
                 reference_id, quantity_in, quantity_out, unit_cost, balance_after, transaction_date,
                 created_by, created_at)
               VALUES (?,?,?,?,'receipt','grn',?,?,0,?,?,?,?,?)`
            )
            .run(
              grn.unit_id, storeId, binId, line.itemId, grn.id,
              line.acceptedQuantity, line.unitPrice, newQty, grn.received_date,
              ctx.user.id, now
            );
        }
        ctx.db
          .prepare(
            `UPDATE po_items SET received_quantity = received_quantity + ?,
               rejected_quantity = rejected_quantity + ?, updated_at = ?
             WHERE id = ? AND po_id = ?`
          )
          .run(line.receivedQuantity, line.rejectedQuantity, now, line.poItemId, po.id);
      }

      const remaining = ctx.db
        .prepare(
          `SELECT
             SUM(CASE WHEN received_quantity < quantity - 0.004 THEN 1 ELSE 0 END) AS open_lines,
             SUM(CASE WHEN received_quantity > 0 THEN 1 ELSE 0 END) AS received_lines
           FROM po_items WHERE po_id = ?`
        )
        .get(po.id);
      const nextStatus = Number(remaining.open_lines) > 0 && Number(remaining.received_lines) > 0
        ? 'partially_received'
        : 'received';
      ctx.db
        .prepare("UPDATE purchase_orders SET status=?, updated_at=? WHERE id=?")
        .run(nextStatus, now, po.id);
      ctx.db
        .prepare("UPDATE grns SET status='posted', posted_at=?, updated_at=? WHERE id=?")
        .run(now, now, grn.id);
      assetIds = createAssetsForGrn(ctx.db, grn.id, ctx.user.id);
    });
    notify(
      [po.created_by, po.issued_by].filter(Boolean),
      'Goods receipt posted',
      `${grn.grn_no} posted against ${po.po_no}.`,
      `/purchase-orders/${po.id}`
    );
    audit(ctx, 'POST', 'grn', grn.id, { status: 'draft' }, {
      status: 'posted', poId: po.id, itemCount: items.length, assetsCreated: assetIds.length,
    });
    return { ok: true, status: 'posted', assetsCreated: assetIds.length };
  });
};
