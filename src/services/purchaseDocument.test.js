import test from 'node:test';
import assert from 'node:assert/strict';
import { purchaseDocument, purchaseLine } from './purchaseDocument.js';

test('reference invoice: 3,000 kg at 58 = 174,000 before 18% GST', () => {
  const l = purchaseLine({ quantity: 3000, unitCost: 58, entryDetails: { listPrice: 0, discountPct: 0 } });
  assert.equal(l.lineTotal, 174000);
  assert.equal(l.lineTotal * 1.18, 205320);
});
test('discount preserves gross printed rate and net receipt/return cost', () => {
  const l = purchaseLine({ quantity: 200, unitCost: 61.725, entryDetails: { discountPct: 7.5, unitsPerCase: 20, rateBasis: 'CONTENT' } });
  assert.equal(l.entryDetails.grossUnitCost, 61.725);
  assert.equal(l.unitCost, 57.095625);
  assert.equal(l.lineTotal, 11419.13);
});
test('fractional quantities retain three decimal places', () => {
  assert.equal(purchaseLine({ quantity: 1.125, unitCost: 100 }).lineTotal, 112.5);
  assert.throws(() => purchaseLine({ quantity: 1.0001, unitCost: 100 }));
});
test('rejects invalid quantity, price, discount and case conversion', () => {
  for (const patch of [{ quantity: 0 }, { quantity: Infinity }, { unitCost: -1 }, { entryDetails: { discountPct: 101 } }, { entryDetails: { unitsPerCase: 1.5 } }, { entryDetails: { listPrice: -1 } }]) {
    assert.throws(() => purchaseLine({ quantity: 1, unitCost: 100, ...patch }));
  }
});
test('document snapshots whitelist and trim fields; capture RCM and tax mode', () => {
  const d = purchaseDocument({ supplierName: ' Supplier ', reverseCharge: true, taxMode: 'INTERSTATE', bogus: 'no' });
  assert.equal(d.supplierName, 'Supplier'); assert.equal(d.reverseCharge, true); assert.equal(d.taxMode, 'INTERSTATE'); assert.equal(d.bogus, undefined);
});
