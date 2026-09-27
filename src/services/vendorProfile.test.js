import test from 'node:test';
import assert from 'node:assert/strict';
import { vendorProfile } from './vendorProfile.js';

test('invoice supplier identity supports country-code phone, PIN and derived PAN', () => {
  const result = vendorProfile({ name: ' Tejas Rasayan LLP ', gstin: '09AALFT1437H1ZZ', phone: '+91 8057871868', pincode: '251001', email: 'tejasrasayan@gmail.com' });
  assert.equal(result.name, 'Tejas Rasayan LLP');
  assert.equal(result.pan, 'AALFT1437H');
  assert.equal(result.state, 'Uttar Pradesh');
  assert.equal(result.phone, '+91 8057871868');
});
test('unregistered supplier can store PAN and landline independently', () => {
  assert.equal(vendorProfile({ name: 'Supplier', pan: 'AALFT1437H', phone: '0131-2400000' }).pan, 'AALFT1437H');
  assert.equal(vendorProfile({ name: 'Supplier' }).gstin, null);
});
test('validates PAN mismatch, PIN, phone, email and GSTIN', () => {
  for (const patch of [{ name: ' ' }, { pan: 'wrong' }, { gstin: 'invalid' }, { pincode: '123' }, { phone: '+91letters' }, { email: 'no-at' }, { gstin: '09AALFT1437H1ZZ', pan: 'ABCDE1234F' }]) {
    assert.throws(() => vendorProfile({ name: 'Supplier', ...patch }));
  }
});
test('persists only reusable invoice defaults; ignores transaction and unknown fields', () => {
  const result = vendorProfile({ name: 'Supplier', invoiceDefaults: { transport: ' PARTY VEHICLE ', station: 'PINNA', vehicleNo: 'UP82AT4053', terms: 'E. & O.E.', copyLabel: 'Duplicate Copy', reverseCharge: true, invoiceNo: 'INV/1', unexpected: '<script>' } });
  assert.equal(result.invoiceDefaults.transport, 'PARTY VEHICLE');
  assert.equal(result.invoiceDefaults.reverseCharge, true);
  assert.equal(result.invoiceDefaults.copyLabel, 'Duplicate Copy');
  assert.equal(result.invoiceDefaults.invoiceNo, undefined);
  assert.equal(result.invoiceDefaults.unexpected, undefined);
});
test('empty invoice defaults restore safe defaults and clear optional text', () => {
  const result = vendorProfile({ name: 'Supplier', invoiceDefaults: {} });
  assert.equal(result.invoiceDefaults.copyLabel, 'Original Copy');
  assert.equal(result.invoiceDefaults.reverseCharge, false);
  assert.equal(result.invoiceDefaults.terms, '');
});
