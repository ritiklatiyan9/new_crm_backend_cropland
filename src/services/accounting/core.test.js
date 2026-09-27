import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fyOf, voucherNo, validateVoucher, buildTrialBalance, finalAccounts } from './core.js';
import { postingsSql } from './postings.js';

const GROUPS = {
  CASH: 'CASH_IN_HAND', BANK: 'BANK_ACCOUNTS', RENT: 'INDIRECT_EXPENSES', 'DISTRIBUTOR:d1': 'SUNDRY_DEBTORS', CAPITAL: 'CAPITAL',
};
const groupOf = (k) => GROUPS[k];

test('Indian FY label + voucher numbering', () => {
  assert.equal(fyOf('2026-03-31'), '2025-26');
  assert.equal(fyOf('2026-04-01'), '2026-27');
  assert.equal(fyOf('2099-12-01'), '2099-00');
  assert.equal(voucherNo('JOURNAL', '2026-27', 7), 'JV/26-27/0007');
});

test('voucher must balance to the paisa', () => {
  const v = validateVoucher({ voucherType: 'PAYMENT', date: '2026-05-01', lines: [
    { ledgerKey: 'RENT', dr: 1000.1 }, { ledgerKey: 'RENT', dr: 0.2 }, { ledgerKey: 'CASH', cr: 1000.3 }, { ledgerKey: '', dr: 0, cr: 0 },
  ] }, groupOf);
  assert.equal(v.amount, 1000.3);
  assert.equal(v.lines.length, 3);
  assert.throws(() => validateVoucher({ voucherType: 'PAYMENT', date: '2026-05-01', lines: [
    { ledgerKey: 'RENT', dr: 100 }, { ledgerKey: 'CASH', cr: 99.99 },
  ] }, groupOf), /difference ₹0.01/);
});

test('voucher type rules (Tally)', () => {
  const run = (voucherType, lines) => () => validateVoucher({ voucherType, date: '2026-05-01', lines }, groupOf);
  assert.throws(run('CONTRA', [{ ledgerKey: 'CASH', dr: 5 }, { ledgerKey: 'RENT', cr: 5 }]), /Contra/);
  assert.doesNotThrow(run('CONTRA', [{ ledgerKey: 'BANK', dr: 5 }, { ledgerKey: 'CASH', cr: 5 }]));
  assert.throws(run('RECEIPT', [{ ledgerKey: 'RENT', dr: 5 }, { ledgerKey: 'CASH', cr: 5 }]), /Receipt/);
  assert.throws(run('JOURNAL', [{ ledgerKey: 'RENT', dr: 5 }, { ledgerKey: 'CASH', cr: 5 }]), /Journal/);
  assert.throws(run('JOURNAL', [{ ledgerKey: 'RENT', dr: 5, cr: 5 }, { ledgerKey: 'CAPITAL', cr: 5 }]), /either/);
  assert.throws(run('JOURNAL', [{ ledgerKey: 'NOPE', dr: 5 }, { ledgerKey: 'CAPITAL', cr: 5 }]), /not found/);
  assert.throws(run('JOURNAL', [{ ledgerKey: 'RENT', dr: 5 }]), /two lines/);
  assert.throws(() => validateVoucher({ voucherType: 'JOURNAL', date: '2026-13-45', lines: [] }, groupOf), /date/);
});

const G = [
  { id: 'CAPITAL', name: 'Capital Account', parentId: null, nature: 'LIABILITY', affectsGrossProfit: false, sortOrder: 10 },
  { id: 'CURRENT_LIAB', name: 'Current Liabilities', parentId: null, nature: 'LIABILITY', affectsGrossProfit: false, sortOrder: 30 },
  { id: 'DUTIES_TAXES', name: 'Duties & Taxes', parentId: 'CURRENT_LIAB', nature: 'LIABILITY', affectsGrossProfit: false, sortOrder: 31 },
  { id: 'CURRENT_ASSETS', name: 'Current Assets', parentId: null, nature: 'ASSET', affectsGrossProfit: false, sortOrder: 70 },
  { id: 'CASH_IN_HAND', name: 'Cash-in-Hand', parentId: 'CURRENT_ASSETS', nature: 'ASSET', affectsGrossProfit: false, sortOrder: 72 },
  { id: 'SUNDRY_DEBTORS', name: 'Sundry Debtors', parentId: 'CURRENT_ASSETS', nature: 'ASSET', affectsGrossProfit: false, sortOrder: 76 },
  { id: 'SALES', name: 'Sales Accounts', parentId: null, nature: 'INCOME', affectsGrossProfit: true, sortOrder: 90 },
  { id: 'PURCHASES', name: 'Purchase Accounts', parentId: null, nature: 'EXPENSE', affectsGrossProfit: true, sortOrder: 100 },
  { id: 'INDIRECT_EXPENSES', name: 'Indirect Expenses', parentId: null, nature: 'EXPENSE', affectsGrossProfit: false, sortOrder: 140 },
];

// Capital 5000 brought in (opening), last year's sale of 200 (pre-period), this period:
// sale 1180 (1000 + 180 GST) on credit, receipt 500, purchase 600 cash, rent 100 cash.
const L = [
  { key: 'CAPITAL', name: 'Capital', groupId: 'CAPITAL', opening: -5000, dr: 0, cr: 0 },
  { key: 'CASH', name: 'Cash', groupId: 'CASH_IN_HAND', opening: 5200, dr: 500, cr: 700 },
  { key: 'DISTRIBUTOR:d1', name: 'Ram Traders', groupId: 'SUNDRY_DEBTORS', opening: 0, dr: 1180, cr: 500 },
  { key: 'SALES_GST', name: 'Sales - GST', groupId: 'SALES', opening: -200, dr: 0, cr: 1000 },
  { key: 'OUTPUT_CGST', name: 'Output CGST', groupId: 'DUTIES_TAXES', opening: 0, dr: 0, cr: 90 },
  { key: 'OUTPUT_SGST', name: 'Output SGST', groupId: 'DUTIES_TAXES', opening: 0, dr: 0, cr: 90 },
  { key: 'PURCHASE', name: 'Purchase', groupId: 'PURCHASES', opening: 0, dr: 600, cr: 0 },
  { key: 'RENT', name: 'Rent', groupId: 'INDIRECT_EXPENSES', opening: 0, dr: 100, cr: 0 },
];

test('trial balance tallies and rolls up groups', () => {
  const tb = buildTrialBalance(G, L);
  assert.equal(tb.totals.dr, tb.totals.cr);
  assert.equal(tb.totals.closingDr, tb.totals.closingCr);
  assert.equal(tb.openingDiff, 0);
  const ca = tb.groups.find((g) => g.id === 'CURRENT_ASSETS');
  assert.equal(ca.closing, 5000 + 680); // cash 5000 + debtor 680
  assert.equal(tb.groups.find((g) => g.id === 'DUTIES_TAXES').level, 1);
});

test('P&L and balance sheet derive from the TB and balance', () => {
  const tb = buildTrialBalance(G, L);
  const { profitLoss: pl, balanceSheet: bs } = finalAccounts(tb, { openingStock: 50, closingStock: 300 });
  assert.equal(pl.grossProfit, 1000 + 300 - 50 - 600);
  assert.equal(pl.netProfit, 650 - 100);
  assert.equal(bs.totalAssets, bs.totalLiabilities);
  const plAc = bs.liabilities.find((l) => l.label === 'Profit & Loss A/c');
  assert.equal(plAc.amount, 200 + 50 + 550);
  assert.ok(bs.assets.find((a) => a.groupId === 'CURRENT_ASSETS').children.some((c) => c.label === 'Closing Stock'));
});

test('unmatched opening balances surface as a difference, BS still balances', () => {
  const tb = buildTrialBalance(G, [...L, { key: 'X', name: 'Old deposit', groupId: 'CURRENT_ASSETS', opening: 75, dr: 0, cr: 0 }]);
  assert.equal(tb.openingDiff, 75);
  const { balanceSheet: bs } = finalAccounts(tb);
  assert.equal(bs.totalAssets, bs.totalLiabilities);
  assert.ok(bs.liabilities.some((l) => l.label === 'Difference in opening balances'));
});

test('earlier-FY profit carried as a group-less PL_AC ledger folds into P&L A/c', () => {
  // Same books as above, but last year's 200 sale is closed into PL_AC.
  const tb = buildTrialBalance(G, [...L.map((l) => (l.key === 'SALES_GST' ? { ...l, opening: 0 } : l)),
    { key: 'PL_AC', name: 'Profit & Loss A/c', groupId: 'PL_AC', opening: -200, dr: 0, cr: 0 }]);
  assert.equal(tb.totals.closingDr, tb.totals.closingCr);
  const { balanceSheet: bs } = finalAccounts(tb, { openingStock: 50, closingStock: 300 });
  assert.equal(bs.totalAssets, bs.totalLiabilities);
  assert.equal(bs.liabilities.find((l) => l.label === 'Profit & Loss A/c').amount, 200 + 50 + 550);
});

test('every derived posting rule ends with a balancing round-off line', () => {
  const sql = postingsSql('$1', '$2');
  const branches = sql.split('UNION ALL');
  assert.equal(branches.length, 10);
  // Branches with 3+ lines must carry a ROUND_OFF plug; two-line rules post one amount both sides.
  for (const b of branches) {
    const lines = (b.match(/\(\d, /g) || []).length;
    if (lines > 2) assert.match(b, /'ROUND_OFF'/);
  }
});
