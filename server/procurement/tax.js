/* Shared tax and discount rules for procurement documents.
 *
 * A line price can be tax-exclusive (default) or tax-inclusive. Discounts are
 * always applied before tax. Both a percentage and a flat amount can be given;
 * they are additive and the combined discount is capped at the gross line
 * value. For inclusive prices the tax is extracted from the discounted value:
 *   taxable = discounted / (1 + rate / 100)
 *   tax     = discounted - taxable
 */

const { round2, badRequest, calculateRoundOff } = require('../util');

function number(value, label, index, { min = 0, max = Infinity, fallback = 0 } = {}) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) throw badRequest(`${label} must be a number.`);
  if (n < min || n > max) throw badRequest(`${label} must be between ${min} and ${max}.`);
  return n;
}

function flag(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return value === true || value === 1 || value === '1' || value === 'true';
}

/* Callers pass both mapped API lines (camelCase) and raw SQLite rows
 * (snake_case), so every aggregate accepts either shape. */
function field(line, camel, snake) {
  if (line && line[camel] !== undefined && line[camel] !== null) return line[camel];
  if (line && line[snake] !== undefined && line[snake] !== null) return line[snake];
  return 0;
}

function itemDefaults(db, itemId) {
  if (!itemId) return { taxRate: 0, taxInclusive: false, discountPercent: 0, discountAmount: 0 };
  const row = db.prepare(
    `SELECT gst_rate, tax_inclusive, default_discount_percent, default_discount_amount
       FROM item_details WHERE item_id = ?`
  ).get(itemId);
  return {
    taxRate: Number(row?.gst_rate) || 0,
    taxInclusive: !!row?.tax_inclusive,
    discountPercent: Number(row?.default_discount_percent) || 0,
    discountAmount: Number(row?.default_discount_amount) || 0,
  };
}

function calculateLine(input) {
  const quantity = round2(input.quantity || 0);
  const unitPrice = round2(input.unitPrice || 0);
  const gross = round2(quantity * unitPrice);
  const discountPercent = round2(input.discountPercent || 0);
  /* An explicit flat value always wins. `discountAmount` may be the applied
   * total on a stored row, so it must never override a saved flat component. */
  const flatDiscount = round2(input.flatDiscountAmount ?? input.flat_discount_amount ?? input.discountAmount ?? 0);
  const percentDiscount = round2((gross * discountPercent) / 100);
  const discountAmount = round2(Math.min(gross, percentDiscount + flatDiscount));
  const discounted = round2(gross - discountAmount);
  const taxRate = round2(input.taxRate || 0);
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
    quantity,
    unitPrice,
    grossAmount: gross,
    discountPercent,
    /* `discountAmount` is the applied total (percent + flat). Keep the raw flat
     * part explicitly so forms and repairs never have to infer it again. */
    flatDiscountAmount: flatDiscount,
    discountAmount,
    taxableAmount,
    taxRate,
    taxInclusive,
    taxAmount,
    totalAmount,
  };
}

/* Normalises the tax/discount fields on one submitted line and calculates it.
 * `defaults` normally comes from itemDefaults(). `prefix` is used in errors. */
function parseLine(line, index, defaults = {}, prefix = 'Line') {
  const label = `${prefix} ${index + 1}`;
  const parsed = calculateLine({
    quantity: number(line.quantity, `${label} quantity`, index, { min: 0, fallback: 0 }),
    unitPrice: number(line.unitPrice, `${label} unit price`, index, { fallback: 0 }),
    discountPercent: number(
      line.discountPercent ?? defaults.discountPercent,
      `${label} discount percent`, index, { min: 0, max: 100, fallback: 0 }
    ),
    discountAmount: number(
      line.flatDiscountAmount ?? line.discountAmount ?? defaults.discountAmount,
      `${label} discount amount`, index, { fallback: 0 }
    ),
    taxRate: number(
      line.taxRate ?? defaults.taxRate,
      `${label} tax rate`, index, { min: 0, max: 100, fallback: 0 }
    ),
    taxInclusive: flag(line.taxInclusive ?? defaults.taxInclusive, !!defaults.taxInclusive),
  });
  return parsed;
}

function parseHeaderDiscount(body, prefix = 'Document') {
  const discountPercent = number(body.discountPercent, `${prefix} discount percent`, 0, { min: 0, max: 100, fallback: 0 });
  const flatDiscountAmount = number(
    body.flatDiscountAmount ?? body.discountAmount,
    `${prefix} discount amount`, 0, { fallback: 0 }
  );
  return {
    discountPercent: round2(discountPercent),
    flatDiscountAmount: round2(flatDiscountAmount),
    discountAmount: round2(flatDiscountAmount),
  };
}

/* Header discount is applied to the payable line value after tax has been
 * determined. Charges are added afterwards. */
function calculateDocument(lines, options = {}) {
  /* Callers may pass mapped camelCase payloads or raw SQLite rows, so accept
   * both spellings for the document-level options as well. */
  const charges = round2(options.charges ?? options.chargesAmount ?? options.charges_amount ?? 0);
  const discountPercent = options.discountPercent ?? options.discount_percent ?? 0;
  /* `discount_amount` columns hold the applied total after recalculation.
   * Prefer the raw flat component when a stored row supplies one. */
  const discountAmount = options.flatDiscountAmount ?? options.flat_discount_amount
    ?? options.discountAmount ?? options.discount_amount ?? 0;
  const subtotal = round2(lines.reduce((sum, line) => sum + Number(field(line, 'taxableAmount', 'taxable_amount')), 0));
  const taxAmount = round2(lines.reduce((sum, line) => sum + Number(field(line, 'taxAmount', 'tax_amount')), 0));
  const gross = round2(lines.reduce((sum, line) => sum + Number(field(line, 'totalAmount', 'total_amount')), 0));
  const percentDiscount = round2((gross * discountPercent) / 100);
  const appliedDiscount = round2(Math.min(gross, percentDiscount + round2(discountAmount || 0)));

  /* Line discounts, header discounts, taxes and charges are all applied
   * above. Only now do we round to the nearest rupee (half-up) and persist
   * the FINAL rounded value in the document total column. */
  const roundOffOverride = options.roundOff ?? options.round_off;
  const {
    baseTotalAmount, roundOff, totalAmount, manual: manualRoundOff,
  } = calculateRoundOff(gross - appliedDiscount + charges, roundOffOverride);
  return {
    subtotal,
    taxAmount,
    grossAmount: gross,
    discountPercent: round2(discountPercent),
    discountAmount: appliedDiscount,
    charges,
    baseTotalAmount,
    roundOff,
    totalAmount,
    manual: manualRoundOff,
  };
}

function auditSummary(lines, document) {
  const count = lines.length;
  const inclusiveCount = lines.filter((line) => flag(field(line, 'taxInclusive', 'tax_inclusive'))).length;
  const lineDiscount = round2(lines.reduce((sum, line) => sum + Number(field(line, 'discountAmount', 'discount_amount')), 0));
  const summary = {
    lineCount: count,
    inclusiveLineCount: inclusiveCount,
    lineDiscountAmount: lineDiscount,
    taxAmount: document ? document.taxAmount : round2(lines.reduce((sum, line) => sum + Number(field(line, 'taxAmount', 'tax_amount')), 0)),
  };
  if (document) {
    summary.documentDiscountAmount = document.discountAmount;
    summary.baseTotalAmount = document.baseTotalAmount;
    summary.roundOff = document.roundOff;
    summary.manualRoundOff = !!document.manual;
    summary.totalAmount = document.totalAmount;
  }
  return summary;
}

module.exports = {
  number,
  flag,
  field,
  round2,
  itemDefaults,
  calculateLine,
  parseLine,
  parseHeaderDiscount,
  calculateDocument,
  auditSummary,
};
