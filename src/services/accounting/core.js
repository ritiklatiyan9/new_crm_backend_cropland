// Pure accounting logic (no DB): voucher validation + numbering, trial-balance
// roll-up and Tally-format final accounts. Sign convention everywhere:
// a signed balance/amount is + Debit / − Credit. Money is compared in paise.

export const VOUCHER_TYPES = ['PAYMENT', 'RECEIPT', 'CONTRA', 'JOURNAL', 'SALES', 'PURCHASE', 'CREDIT_NOTE', 'DEBIT_NOTE'];
const PREFIX = { PAYMENT: 'PV', RECEIPT: 'RV', CONTRA: 'CV', JOURNAL: 'JV', SALES: 'SV', PURCHASE: 'PUV', CREDIT_NOTE: 'CRN', DEBIT_NOTE: 'DRN' };
export const CASH_BANK_GROUPS = new Set(['CASH_IN_HAND', 'BANK_ACCOUNTS', 'BANK_OD']);

export const round2 = (v) => Math.round((Number(v) + Number.EPSILON) * 100) / 100;
const paise = (v) => Math.round(Number(v) * 100);

function bad(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

/** Indian financial year label (Apr–Mar) of a YYYY-MM-DD date → '2026-27'. */
export function fyOf(dateIso) {
  const [y, m] = String(dateIso).slice(0, 10).split('-').map(Number);
  const start = m >= 4 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

/** 'JOURNAL', '2026-27', 7 → 'JV/26-27/0007'. */
export function voucherNo(type, fy, seq) {
  return `${PREFIX[type]}/${fy.slice(2)}/${String(seq).padStart(4, '0')}`;
}

/**
 * Validate + normalise a manual voucher. `groupOf(ledgerKey)` returns the
 * ledger's group id, or undefined for an unknown ledger.
 * Returns { lines:[{ledgerKey, dr, cr, narration}], amount }; throws a 400 Error.
 */
export function validateVoucher({ voucherType, date, lines }, groupOf) {
  if (!VOUCHER_TYPES.includes(voucherType)) throw bad(`Unknown voucher type ${voucherType}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || '')) || Number.isNaN(Date.parse(date))) throw bad('Voucher date must be a valid YYYY-MM-DD date');
  const out = [];
  (lines || []).forEach((l, i) => {
    const dr = round2(l.dr || 0);
    const cr = round2(l.cr || 0);
    if (!l.ledgerKey && !dr && !cr) return; // blank trailing row from the form
    const at = `Line ${i + 1}`;
    if (!l.ledgerKey) throw bad(`${at}: choose a ledger`);
    if (!Number.isFinite(dr) || !Number.isFinite(cr) || dr < 0 || cr < 0) throw bad(`${at}: amounts must be positive numbers`);
    if ((dr > 0) === (cr > 0)) throw bad(`${at}: enter either a Debit or a Credit amount`);
    const group = groupOf(l.ledgerKey);
    if (!group) throw bad(`${at}: ledger not found`);
    out.push({ ledgerKey: l.ledgerKey, dr, cr, narration: l.narration?.trim() || null, group });
  });
  if (out.length < 2) throw bad('A voucher needs at least two lines');
  const drP = out.reduce((s, l) => s + paise(l.dr), 0);
  const crP = out.reduce((s, l) => s + paise(l.cr), 0);
  if (!drP || !crP) throw bad('A voucher needs at least one Debit and one Credit line');
  if (drP !== crP) throw bad(`Debit ₹${(drP / 100).toFixed(2)} and Credit ₹${(crP / 100).toFixed(2)} must be equal (difference ₹${(Math.abs(drP - crP) / 100).toFixed(2)})`);

  const cb = (l) => CASH_BANK_GROUPS.has(l.group);
  if (voucherType === 'CONTRA' && !out.every(cb)) throw bad('A Contra voucher can only use Cash and Bank ledgers');
  if (voucherType === 'PAYMENT' && !out.some((l) => cb(l) && l.cr > 0)) throw bad('A Payment voucher must credit a Cash or Bank ledger');
  if (voucherType === 'RECEIPT' && !out.some((l) => cb(l) && l.dr > 0)) throw bad('A Receipt voucher must debit a Cash or Bank ledger');
  if (voucherType === 'JOURNAL' && out.some(cb)) throw bad('A Journal cannot use Cash or Bank ledgers — use Payment, Receipt or Contra');

  return { lines: out.map(({ group: _g, ...l }) => l), amount: drP / 100 };
}

/**
 * Roll ledger balances up the group tree.
 * groups:  [{id, name, parentId, nature, affectsGrossProfit, sortOrder}]
 * ledgers: [{key, name, groupId, opening, dr, cr}] — opening signed, as at period start; dr/cr within the period.
 * → { groups (only those with ledgers below, each with level/opening/dr/cr/closing),
 *     ledgers (+closing), totals, openingDiff }
 */
export function buildTrialBalance(groups, ledgers) {
  const byId = new Map(groups.map((g) => [g.id, { ...g, opening: 0, dr: 0, cr: 0, closing: 0, ledgerCount: 0 }]));
  const primaryOf = (id) => {
    let g = byId.get(id);
    while (g?.parentId) g = byId.get(g.parentId);
    return g;
  };
  const rows = ledgers.map((l) => ({ ...l, opening: round2(l.opening), dr: round2(l.dr), cr: round2(l.cr), closing: round2(l.opening + l.dr - l.cr) }));
  const totals = { openingDr: 0, openingCr: 0, dr: 0, cr: 0, closingDr: 0, closingCr: 0 };
  for (const l of rows) {
    for (let g = byId.get(l.groupId); g; g = byId.get(g.parentId)) {
      g.opening += l.opening; g.dr += l.dr; g.cr += l.cr; g.closing += l.closing; g.ledgerCount += 1;
    }
    if (l.opening > 0) totals.openingDr += l.opening; else totals.openingCr -= l.opening;
    if (l.closing > 0) totals.closingDr += l.closing; else totals.closingCr -= l.closing;
    totals.dr += l.dr; totals.cr += l.cr;
    l.nature = primaryOf(l.groupId)?.nature ?? null;
  }
  const level = (g) => (g.parentId ? 1 + level(byId.get(g.parentId)) : 0);
  const outGroups = [...byId.values()]
    .filter((g) => g.ledgerCount > 0)
    .map((g) => ({ ...g, level: level(g), opening: round2(g.opening), dr: round2(g.dr), cr: round2(g.cr), closing: round2(g.closing) }))
    .sort((a, b) => a.sortOrder - b.sortOrder);
  for (const k of Object.keys(totals)) totals[k] = round2(totals[k]);
  // Σ closing (signed) ≠ 0 only when ledger opening balances don't net off (Tally: "Difference in opening balances").
  const openingDiff = round2(totals.closingDr - totals.closingCr);
  return { groups: outGroups, ledgers: rows, totals, openingDiff };
}

const line = (label, amount, extra = {}) => ({ label, amount: round2(amount), groupId: null, ledgerKey: null, children: [], ...extra });

/** Detail lines of a group: sub-groups (with their ledgers) then direct ledgers, valued by `val(node)`. */
function groupDetail(tb, groupId, val) {
  const subs = tb.groups.filter((g) => g.parentId === groupId).map((g) =>
    line(g.name, val(g), { groupId: g.id, children: tb.ledgers.filter((l) => l.groupId === g.id && round2(val(l))).map((l) => line(l.name, val(l), { ledgerKey: l.key })) }));
  const own = tb.ledgers.filter((l) => l.groupId === groupId && round2(val(l))).map((l) => line(l.name, val(l), { ledgerKey: l.key }));
  return [...subs.filter((s) => s.amount || s.children.length), ...own];
}

/**
 * Profit & Loss (for the period) and Balance Sheet (as at period end) in Tally
 * format, derived from a buildTrialBalance() result + stock valuation.
 */
export function finalAccounts(tb, { openingStock = 0, closingStock = 0 } = {}) {
  const primaries = tb.groups.filter((g) => !g.parentId);
  const period = (n) => n.dr - n.cr; // period movement, + Dr
  const pick = (nature, gp) => primaries.filter((g) => g.nature === nature && Boolean(g.affectsGrossProfit) === gp);
  const nonEmpty = (ls) => ls.filter((l) => l.amount || l.children.length);
  const incomeLines = (gs) => nonEmpty(gs.map((g) => line(g.name, -period(g), { groupId: g.id, children: groupDetail(tb, g.id, (n) => -period(n)) })));
  const expenseLines = (gs) => nonEmpty(gs.map((g) => line(g.name, period(g), { groupId: g.id, children: groupDetail(tb, g.id, period) })));
  const sum = (ls) => round2(ls.reduce((s, l) => s + l.amount, 0));

  const tradingDr = [line('Opening Stock', openingStock), ...expenseLines(pick('EXPENSE', true))];
  const tradingCr = [...incomeLines(pick('INCOME', true)), line('Closing Stock', closingStock)];
  const grossProfit = round2(sum(tradingCr) - sum(tradingDr));
  const indirectExp = expenseLines(pick('EXPENSE', false));
  const indirectInc = incomeLines(pick('INCOME', false));
  const netProfit = round2(grossProfit + sum(indirectInc) - sum(indirectExp));

  // Balance Sheet: closing balances of asset/liability groups + P&L A/c + stock.
  // PL_AC = income/expense of earlier FYs (not under any group), see trialBalance().
  const isPL = (l) => l.nature === 'INCOME' || l.nature === 'EXPENSE' || l.key === 'PL_AC';
  const plOpening = round2(-tb.ledgers.filter(isPL).reduce((s, l) => s + l.opening, 0));
  const liabilities = nonEmpty(primaries.filter((g) => g.nature === 'LIABILITY')
    .map((g) => line(g.name, -g.closing, { groupId: g.id, children: groupDetail(tb, g.id, (n) => -n.closing) })));
  // ponytail: prior-period profit is carried as P&L A/c opening (stock held at period start counts as retained profit).
  liabilities.push(line('Profit & Loss A/c', plOpening + openingStock + netProfit, {
    children: [line('Opening Balance', plOpening + openingStock), line('Current Period', netProfit)],
  }));
  const assets = nonEmpty(primaries.filter((g) => g.nature === 'ASSET')
    .map((g) => line(g.name, g.closing, { groupId: g.id, children: groupDetail(tb, g.id, (n) => n.closing) })));
  if (closingStock) {
    let ca = assets.find((a) => a.groupId === 'CURRENT_ASSETS');
    if (!ca) assets.push((ca = line('Current Assets', 0, { groupId: 'CURRENT_ASSETS' })));
    ca.children.unshift(line('Closing Stock', closingStock));
    ca.amount = round2(ca.amount + closingStock);
  }
  if (tb.openingDiff > 0) liabilities.push(line('Difference in opening balances', tb.openingDiff));
  if (tb.openingDiff < 0) assets.push(line('Difference in opening balances', -tb.openingDiff));

  return {
    profitLoss: {
      tradingDebit: tradingDr, tradingCredit: tradingCr, grossProfit,
      debit: indirectExp, credit: indirectInc, netProfit,
    },
    balanceSheet: { liabilities, assets, totalLiabilities: sum(liabilities), totalAssets: sum(assets) },
  };
}
