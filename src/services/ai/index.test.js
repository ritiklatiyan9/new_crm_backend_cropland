// Pure helpers of the AI service: tolerant JSON parsing + catalog-code decoding.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ??= 'postgres://x';
process.env.JWT_SECRET ??= 'x';
const { parseJsonLoose, decodeCodes, labelFits } = await import('./index.js');

test('parseJsonLoose handles fences, prose and garbage', () => {
  assert.deepEqual(parseJsonLoose('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseJsonLoose('Sure! {"disease":"Early Blight"} hope it helps'), { disease: 'Early Blight' });
  assert.deepEqual(parseJsonLoose('not json'), {});
  assert.deepEqual(parseJsonLoose(''), {});
});

test('decodeCodes swaps leaked catalog codes for brand names only', () => {
  const cat = [{ name: 'FungiCare WP' }, { name: 'NutriGrow GR' }];
  assert.equal(decodeCodes('Mancozeb 75% WP (P1) then P2', cat), 'Mancozeb 75% WP (FungiCare WP) then NutriGrow GR');
  assert.equal(decodeCodes('P2O5, PHI 7 days, P9', cat), 'P2O5, PHI 7 days, P9');
  assert.equal(decodeCodes(null, cat), null);
});

test('labelFits keeps off-label products away from a crop', () => {
  assert.equal(labelFits(['Tomato', 'Potato'], 'Paddy'), false);
  assert.equal(labelFits(['Paddy', 'Cotton'], ' cotton '), true);
  assert.equal(labelFits(['Paddy'], 'Rice'), true);
  assert.equal(labelFits(['All Crops'], 'Wheat'), true);
  assert.equal(labelFits(['Vegetables'], 'Tomato'), true);
  assert.equal(labelFits(['Vegetables'], 'Paddy'), false);
  assert.equal(labelFits([], 'Wheat'), true);
  assert.equal(labelFits(null, 'Wheat'), true);
});
