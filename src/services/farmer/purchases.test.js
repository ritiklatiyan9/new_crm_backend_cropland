import test from 'node:test';
import assert from 'node:assert/strict';
import { readPurchases } from './purchases.js';

test('purchase history scopes the query to one farmer and preserves balances and order status', async () => {
  let calls = 0;
  const items = [{ productName: 'Crop care', quantity: 2, unitPrice: 100.01, lineTotal: 200.02, packingSize: null }];
  const result = await readPurchases(async (sql, params) => {
    calls++;
    assert.deepEqual(params, ['farmer-1']);
    assert.equal((sql.match(/farmer_id=\$1/g) ?? []).length, 2);
    return { rows: [
      { id: 'o', kind: 'ORDER', status: 'PLACED', date: '2026-09-27', total_amount: '200.02', amount_paid: '100.01', items },
      { id: 's1', kind: 'DIRECT', total_amount: '200', amount_paid: '200' },
      { id: 's2', kind: 'DIRECT', total_amount: '200', amount_paid: '100' },
      { id: 's3', kind: 'DIRECT', total_amount: '200', amount_paid: '0' },
    ] };
  }, 'farmer-1');
  assert.equal(calls, 1);
  assert.equal(result[0].balanceDue, 100.01);
  assert.equal(result[0].status, 'PLACED');
  assert.deepEqual(result[0].items, items);
  assert.deepEqual(result.slice(1).map((r) => r.status), ['PAID', 'PARTIAL', 'DUE']);
  assert.deepEqual(result[1].items, []);
});
