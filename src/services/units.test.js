import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePackSize, statutoryQty, uqcFor } from './units.js';

test('parsePackSize handles common spellings', () => {
  assert.deepEqual(parsePackSize('250ml'), { value: 250, dim: 'volume', base: 0.25 });
  assert.equal(parsePackSize('1 Ltr').base, 1);
  assert.equal(parsePackSize('500 gm').base, 0.5);
  assert.equal(parsePackSize('1.5KG').base, 1.5);
  assert.equal(parsePackSize('bottle'), null);
  assert.equal(parsePackSize(''), null);
  assert.equal(parsePackSize(null), null);
});

test('statutoryQty converts packs into the UOM quantity (the "200ml shows 1L" bug)', () => {
  assert.deepEqual(statutoryQty(40, '250ml', 'L'), { qty: 10, uqc: 'LTR' });
  assert.deepEqual(statutoryQty(1, '200ml', 'L'), { qty: 0.2, uqc: 'LTR' });
  assert.deepEqual(statutoryQty(3, '200ml', 'ML'), { qty: 600, uqc: 'MLT' });
  assert.deepEqual(statutoryQty(4, '500g', 'KG'), { qty: 2, uqc: 'KGS' });
});

test('statutoryQty falls back to counting packs', () => {
  assert.deepEqual(statutoryQty(5, null, 'L'), { qty: 5, uqc: 'LTR' });
  assert.deepEqual(statutoryQty(5, '250ml', 'KG'), { qty: 5, uqc: 'NOS' }); // dimension mismatch
  assert.deepEqual(statutoryQty(5, '1 L', 'PCS'), { qty: 5, uqc: 'NOS' });
  assert.equal(uqcFor('box'), 'BOX');
  assert.equal(uqcFor(undefined), 'NOS');
});
