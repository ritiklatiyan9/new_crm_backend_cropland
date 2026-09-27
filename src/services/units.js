// Pack-size / unit helpers. Products are sold in packs (packing_size e.g. "250ml");
// line quantity counts packs. Mirrors crm-cropland-admin/src/lib/units.ts.

const UNIT_MAP = {
  ml: ['volume', 0.001], l: ['volume', 1], lt: ['volume', 1], ltr: ['volume', 1], litre: ['volume', 1], liter: ['volume', 1],
  g: ['mass', 0.001], gm: ['mass', 0.001], gms: ['mass', 0.001], gram: ['mass', 0.001], kg: ['mass', 1], kgs: ['mass', 1],
  nos: ['count', 1], pcs: ['count', 1],
};

/** "250ml" | "1 Ltr" | "1.5kg" → { value, dim, base } (base in L / kg / nos); unparseable → null. */
export function parsePackSize(s) {
  const m = String(s ?? '').trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*([a-z]+)\.?$/);
  if (!m || !UNIT_MAP[m[2]]) return null;
  const value = Number(m[1]);
  if (!(value > 0)) return null;
  const [dim, toBase] = UNIT_MAP[m[2]];
  return { value, dim, base: value * toBase };
}

// GST Unit Quantity Codes (UQC) for the product master UOMs.
const UQC = { L: 'LTR', LTR: 'LTR', ML: 'MLT', KG: 'KGS', KGS: 'KGS', G: 'GMS', GM: 'GMS', PCS: 'NOS', NOS: 'NOS', BAG: 'BAG', BOX: 'BOX', BTL: 'BTL', PKT: 'PAC' };
export const uqcFor = (uom) => UQC[String(uom ?? '').trim().toUpperCase()] ?? 'NOS';

/**
 * Statutory quantity for GST documents (HSN summary, e-invoice): `qty` packs of
 * `packingSize` expressed in the product UOM's UQC. 40 × "250ml" with uom L → { qty: 10, uqc: 'LTR' }.
 * When the pack size is unknown or its dimension doesn't match the UOM, packs are counted as NOS.
 */
export function statutoryQty(qty, packingSize, uom) {
  const n = Number(qty) || 0;
  const pack = parsePackSize(packingSize);
  const uqc = uqcFor(uom);
  const dimOf = { LTR: 'volume', MLT: 'volume', KGS: 'mass', GMS: 'mass' }[uqc];
  if (!pack) return { qty: n, uqc };
  if (dimOf !== pack.dim) return { qty: n, uqc: 'NOS' };
  const perBase = uqc === 'MLT' || uqc === 'GMS' ? 1000 : 1;
  return { qty: Math.round(n * pack.base * perBase * 1000) / 1000, uqc };
}
