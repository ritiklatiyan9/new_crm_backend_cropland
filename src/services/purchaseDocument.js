// Persist document snapshots separately from mutable vendor/company masters.
const textFields = ['supplierName', 'supplierAddress', 'supplierGstin', 'supplierPan', 'supplierPhone', 'supplierEmail', 'supplierState', 'invoiceNo', 'invoiceDate', 'placeOfSupply', 'grNo', 'transport', 'vehicleNo', 'station', 'billedName', 'billedAddress', 'billedGstin', 'shippedName', 'shippedAddress', 'shippedGstin', 'terms', 'copyLabel'];
export function purchaseDocument(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid purchase document details');
  const result = Object.fromEntries(textFields.map((key) => [key, String(input[key] ?? '').trim().slice(0, key === 'terms' ? 5000 : 1500)]));
  result.reverseCharge = input.reverseCharge === true;
  result.taxMode = input.taxMode === 'INTERSTATE' ? 'INTERSTATE' : 'INTRASTATE';
  return result;
}
const round = (n, places = 2) => Math.round((n + Number.EPSILON) * 10 ** places) / 10 ** places;
export function purchaseLine(input) {
  const quantity = Number(input.quantity), cost = Number(input.unitCost);
  const details = input.entryDetails ?? {};
  const discountPct = Number(details.discountPct ?? 0), listPrice = Number(details.listPrice ?? 0);
  if (!Number.isFinite(quantity) || quantity <= 0 || quantity !== round(quantity, 3)) throw new Error('Quantity must be positive with at most 3 decimal places');
  if (!Number.isFinite(cost) || cost < 0) throw new Error('Price must be 0 or more');
  if (!Number.isFinite(discountPct) || discountPct < 0 || discountPct > 100) throw new Error('Discount must be between 0 and 100%');
  if (!Number.isFinite(listPrice) || listPrice < 0) throw new Error('List price must be 0 or more');
  const unitsPerCase = Number(details.unitsPerCase ?? 0);
  if (!Number.isInteger(unitsPerCase) || unitsPerCase < 0) throw new Error('Units per case must be a positive whole number');
  const unitCost = round(cost * (1 - discountPct / 100), 6);
  return { quantity, unitCost, lineTotal: round(quantity * unitCost), entryDetails: {
    description: String(details.description ?? '').trim().slice(0, 1000),
    hsnCode: String(details.hsnCode ?? '').trim().slice(0, 20),
    listPrice, discountPct, unitsPerCase, grossUnitCost: round(cost, 6),
    rateBasis: details.rateBasis === 'CONTENT' ? 'CONTENT' : 'UNIT',
  } };
}
