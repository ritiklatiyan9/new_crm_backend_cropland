import test from 'node:test';
import assert from 'node:assert/strict';
import { selectDetailRows, signedNote, reconcileHsnDetails } from './gstDrilldown.js';
import { gstReturnsResolvers } from './gstReturns.js';

test('credit notes reduce net taxable value and every tax head; CDNR displays face value', () => {
  const note = { noteType: 'C', noteNo: 'CN-1', taxable: 1000, igst: 0, cgst: 90, sgst: 90, cess: 0, total: 1180 };
  const net = signedNote(note);
  assert.equal(net.taxable, -1000);
  assert.equal(net.tax, -180);
  assert.equal(net.total, -1180);
  assert.equal(signedNote(note, false).total, 1180);
  assert.equal(signedNote({ ...note, noteType: 'D' }).total, 1180);
});

test('B2CS drilldown intersects rate, place of supply and supply type', () => {
  const rows = [
    { docNo: 'A', rate: 18, pos: '09', supplyType: 'INTRA' },
    { docNo: 'B', rate: 12, pos: '09', supplyType: 'INTRA' },
    { docNo: 'C', rate: 18, pos: '07', supplyType: 'INTER' },
    { docNo: 'D', rate: 18, pos: '09', supplyType: 'INTRA' },
  ];
  assert.deepEqual(selectDetailRows(rows, { rate: '18', pos: '09', supplyType: 'INTRA' }).map((r) => r.docNo), ['A', 'D']);
  assert.deepEqual(selectDetailRows(rows, { docNo: 'missing' }), []);
});

test('HSN filters include statutory unit, registered status and zero rate', () => {
  const rows = [{ hsnCode: '', uqc: 'LTR', supplyType: 'B2B', rate: 0 }, { hsnCode: '', uqc: 'KGS', supplyType: 'B2B', rate: 0 }, { hsnCode: '', uqc: 'LTR', supplyType: 'B2C', rate: 0 }];
  assert.equal(selectDetailRows(rows, { hsnCode: '', uqc: 'LTR', supplyType: 'B2B', rate: 0 }).length, 1);
});

test('books-only reconciliation records remain selectable without portal IDs', () => {
  const rows = [{ id: null, docNo: 'B1', bookInvoiceNo: 'B1', status: 'BOOKS_ONLY' }, { id: 'p1', docNo: 'B1', status: 'MATCHED' }];
  assert.equal(selectDetailRows(rows, { docNo: 'B1', bookInvoiceNo: 'B1', status: 'BOOKS_ONLY' }).length, 1);
});

test('drilldown query requires existing GST authorization', async () => {
  await assert.rejects(() => gstReturnsResolvers().Query.gstTransactionDetails(null, { period: '092026', report: 'GSTR3B' }, {}));
});


test('HSN detail lines reconcile odd-paisa splits without mixing different groups', () => {
  const rows = [1, 2].map((id) => ({ id, supplyType: 'B2B', hsnCode: '1234', uqc: 'NOS', rate: 5, taxable: 0.6, igst: 0, cgst: 0.02, sgst: 0.01, cess: 0 }));
  const total = { supplyType: 'B2B', hsnCode: '1234', uqc: 'NOS', rate: 5, taxable: 1.2, igst: 0, cgst: 0.03, sgst: 0.03, cess: 0 };
  const result = reconcileHsnDetails(rows, [total]);
  assert.equal(result.reduce((sum, r) => sum + r.cgst, 0), 0.03);
  assert.equal(result.reduce((sum, r) => sum + r.sgst, 0), 0.03);
  assert.equal(result.reduce((sum, r) => sum + r.total, 0), 1.26);
});
