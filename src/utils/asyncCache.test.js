import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAsyncCache } from './asyncCache.js';
import { createCatalog } from '../services/farmer/catalog.js';

test('concurrent callers share one query, expiry loads again', async () => {
  let time = 0, calls = 0;
  const cache = createAsyncCache({ now: () => time });
  const load = async () => ++calls;
  assert.deepEqual(await Promise.all([cache.get('a', load, 10), cache.get('a', load, 10)]), [1, 1]);
  time = 9;
  assert.equal(await cache.get('a', load, 10), 1);
  time = 10;
  assert.equal(await cache.get('a', load, 10), 2);
});

test('failed loads are retried and capacity is bounded', async () => {
  const cache = createAsyncCache({ maxEntries: 1 });
  await assert.rejects(cache.get('a', () => { throw Error('offline'); }, 1000));
  assert.equal(await cache.get('a', async () => 1, 1000), 1);
  await cache.get('b', async () => 2, 1000);
  assert.equal(await cache.get('a', async () => 3, 1000), 3);
});

test('catalog binds search values, caps page size, and separates pages', async () => {
  const calls = [];
  const catalog = createCatalog(async (sql, params) => { calls.push({ sql, params }); return { rows: [{ id: calls.length }] }; });
  await catalog({ search: "a%' OR 1=1 --", category: 'Nutrition', limit: 5000, offset: -2 });
  assert.deepEqual(calls[0].params, ["a\\%' OR 1=1 --", 'Nutrition', 100, 0]);
  assert.ok(!calls[0].sql.includes("OR 1=1 --"));
  assert.match(calls[0].sql, /ORDER BY name, id/);
  await catalog({ limit: 24, offset: 0 });
  await catalog({ limit: 24, offset: 24 });
  await catalog({ limit: 24, offset: 0 });
  assert.equal(calls.length, 3);
});
