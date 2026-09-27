// Read-only smoke check against the configured DB. No personal data is printed.
// Run: node --env-file=.env scripts/check-farmer-reads.js
import assert from 'node:assert/strict';
import { pool, query } from '../src/db/index.js';
import { farmerAppResolvers } from '../src/graphql/modules/farmerApp.js';
import { getWeather } from '../src/services/weather/index.js';

try {
  const { rows } = await query(`SELECT f.id FROM farmers f
    ORDER BY (SELECT count(*) FROM orders o WHERE o.farmer_id=f.id) DESC LIMIT 1`);
  assert.ok(rows.length, 'A farmer is required for this read-only smoke check');
  const ctx = { user: { sub: rows[0].id, kind: 'FARMER', role: 'FARMER' } };
  const { Query: reads } = farmerAppResolvers({});
  const cases = {
    myAccountSummary: {}, myPurchases: {}, appProducts: { limit: 24, offset: 0 },
    myAdvisories: {}, myComplaints: {}, myNotifications: { limit: 10 }, myDiagnoses: {},
  };
  for (const [name, args] of Object.entries(cases)) {
    const start = performance.now();
    const result = await reads[name](null, args, ctx);
    assert.ok(result != null, `${name} returned no data`);
    if (name === 'myPurchases') {
      for (const purchase of result) {
        assert.ok(Array.isArray(purchase.items));
        assert.ok(Math.abs(purchase.totalAmount - purchase.amountPaid - purchase.balanceDue) < .02);
      }
    }
    console.log(`${name}: PASS (${Math.round(performance.now() - start)}ms; ${Array.isArray(result) ? result.length + ' rows' : 'summary'})`);
  }
  const start = performance.now();
  await reads.appProducts(null, { limit: 24, offset: 0 }, ctx);
  console.log(`cached catalog: PASS (${(performance.now() - start).toFixed(1)}ms)`);
  const first = await reads.appProducts(null, { limit: 1 }, ctx);
  const next = await reads.appProducts(null, { limit: 1, offset: 1 }, ctx);
  if (first.length && next.length) assert.notEqual(first[0].id, next[0].id);
  if (first[0]?.category) {
    const filtered = await reads.appProducts(null, { category: first[0].category }, ctx);
    assert.ok(filtered.every((p) => p.category === first[0].category));
  }
  await reads.appProducts(null, { search: "%_'\\" }, ctx);
  await assert.rejects(reads.appWeather(null, { lat: 91, lng: 0 }, ctx), /valid latitude/);
  await assert.rejects(reads.appWeather(null, { lat: 20 }, ctx), /valid latitude/);
  console.log('pagination, filters, literal search, coordinate validation: PASS');
  for (const pass of ['cold', 'cached']) {
    const start = performance.now();
    const weather = await getWeather({ lat: 28.61, lon: 77.21, lang: 'en' });
    assert.ok(['openweathermap', 'mock'].includes(weather.source));
    console.log(`weather ${pass}: ${Math.round(performance.now() - start)}ms (${weather.source})`);
  }
} finally { await pool.end(); }
