// GraphQL module: double-entry ACCOUNTING core (Tally parity).
// Chart of accounts (acc_groups / acc_ledgers + virtual party ledgers), manual
// vouchers (numbered per type per Indian FY, Dr = Cr to the paisa, cancel-not-
// delete, books lock date) and the books: Day Book, Ledger / Cash / Bank book,
// Trial Balance, Profit & Loss and Balance Sheet. Commerce documents post
// through rules derived at read time (services/accounting/postings.js).

import { query, withTransaction } from '../../db/index.js';
import { assertRole } from '../context.js';
import { httpError, logActivity } from '../helpers.js';
import { resolvePeriod } from '../../services/finance/period.js';
import { validateGstin } from '../../services/gst/stateCodes.js';
import { postingsSql } from '../../services/accounting/postings.js';
import { fyOf, voucherNo, validateVoucher, buildTrialBalance, finalAccounts, round2 } from '../../services/accounting/core.js';

export const accountingTypeDefs = /* GraphQL */ `
  type AccGroup { id: ID!, name: String!, parentId: ID, nature: String!, affectsGrossProfit: Boolean!, sortOrder: Int! }

  type AccLedger {
    key: ID!                  # CASH | <uuid> | DISTRIBUTOR:<uuid> | FARMER:<uuid> | VENDOR:<uuid>
    id: ID
    code: String              # system ledger code
    name: String!
    groupId: ID!
    groupName: String!
    nature: String!
    openingBalance: Float!    # signed: + Dr / − Cr
    partyType: String
    partyId: ID
    gstin: String
    state: String
    isActive: Boolean!
    isSystem: Boolean!
  }
  input AccLedgerInput { name: String, groupId: ID, openingBalance: Float, gstin: String, state: String, isActive: Boolean }

  type AccSettings { booksLockDate: String }

  type AccVoucherLine { ledgerKey: ID!, ledgerName: String!, dr: Float!, cr: Float!, narration: String }
  type AccVoucher {
    key: ID!                  # voucher:<uuid> (manual) or invoice:/payment:/… (derived)
    id: ID                    # manual voucher id
    typeCode: String          # PAYMENT | RECEIPT | CONTRA | JOURNAL | SALES | PURCHASE | CREDIT_NOTE | DEBIT_NOTE (manual only)
    voucherType: String!      # display type, e.g. "Credit Note"
    voucherNo: String!
    date: String!
    narration: String
    refNo: String
    amount: Float!
    status: String!           # ACTIVE | CANCELLED
    cancelReason: String
    sourceType: String!       # voucher | invoice | payment | party_sale | credit_note | debit_note | sales_return | purchase_invoice | vendor_payment | purchase_return
    sourceId: ID
    docId: ID                 # id to open for drill-down (e.g. the invoice of a receipt)
    particulars: String
    lines: [AccVoucherLine!]!
    createdAt: DateTime
  }
  type AccVoucherPage { items: [AccVoucher!]!, total: Int!, totalAmount: Float! }
  input AccVoucherLineInput { ledgerKey: ID!, dr: Float, cr: Float, narration: String }
  input AccVoucherInput { voucherType: String!, date: String!, refNo: String, narration: String, lines: [AccVoucherLineInput!]! }

  type AccLedgerStatementRow {
    date: String!, voucherKey: ID!, voucherType: String!, voucherNo: String!, particulars: String, narration: String,
    sourceType: String!, sourceId: ID, docId: ID, dr: Float!, cr: Float!, balance: Float!
  }
  type AccLedgerStatement {
    ledger: AccLedger!, fromDate: String!, toDate: String!,
    opening: Float!, totalDr: Float!, totalCr: Float!, closing: Float!, rows: [AccLedgerStatementRow!]!
  }

  type AccTbGroup { id: ID!, name: String!, parentId: ID, nature: String!, level: Int!, opening: Float!, dr: Float!, cr: Float!, closing: Float! }
  type AccTbLedger { key: ID!, name: String!, groupId: ID!, partyType: String, opening: Float!, dr: Float!, cr: Float!, closing: Float! }
  type AccTbTotals { openingDr: Float!, openingCr: Float!, dr: Float!, cr: Float!, closingDr: Float!, closingCr: Float! }
  type AccUnbalanced { voucherKey: ID!, voucherNo: String, diff: Float! }
  type AccTrialBalance {
    fromDate: String!, toDate: String!, groups: [AccTbGroup!]!, ledgers: [AccTbLedger!]!, totals: AccTbTotals!,
    openingDiff: Float!          # Σ closing ≠ 0 → opening balances don't net off
    unbalanced: [AccUnbalanced!]! # integrity check: vouchers whose Dr ≠ Cr (should always be empty)
  }

  type AccStatementLine { label: String!, amount: Float!, groupId: ID, ledgerKey: ID, children: [AccStatementLine!]! }
  type AccProfitLoss {
    tradingDebit: [AccStatementLine!]!, tradingCredit: [AccStatementLine!]!, grossProfit: Float!,
    debit: [AccStatementLine!]!, credit: [AccStatementLine!]!, netProfit: Float!
  }
  type AccBalanceSheet { liabilities: [AccStatementLine!]!, assets: [AccStatementLine!]!, totalLiabilities: Float!, totalAssets: Float! }
  type AccFinalAccounts {
    fromDate: String!, toDate: String!, openingStock: Float!, closingStock: Float!,
    profitLoss: AccProfitLoss!, balanceSheet: AccBalanceSheet!
  }

  extend type Query {
    accGroups: [AccGroup!]!
    accLedgers(search: String, groupId: ID, includeParties: Boolean, limit: Int): [AccLedger!]!
    accLedger(key: ID!): AccLedger
    accSettings: AccSettings!
    "Manual vouchers (incl. cancelled)."
    accVouchers(fromDate: String, toDate: String, voucherType: String, status: String, search: String, limit: Int, offset: Int): AccVoucherPage!
    accVoucher(id: ID!): AccVoucher
    "Every voucher in the books (derived + manual), oldest first."
    accDayBook(fromDate: String, toDate: String, voucherType: String, search: String, limit: Int, offset: Int): AccVoucherPage!
    accLedgerStatement(ledgerKey: ID!, fromDate: String, toDate: String): AccLedgerStatement!
    accTrialBalance(fromDate: String, toDate: String): AccTrialBalance!
    accFinalAccounts(fromDate: String, toDate: String): AccFinalAccounts!
  }

  extend type Mutation {
    createAccLedger(input: AccLedgerInput!): AccLedger!
    updateAccLedger(key: ID!, input: AccLedgerInput!): AccLedger!
    deleteAccLedger(key: ID!): Boolean!
    createAccVoucher(input: AccVoucherInput!): AccVoucher!
    updateAccVoucher(id: ID!, input: AccVoucherInput!): AccVoucher!
    cancelAccVoucher(id: ID!, reason: String!): AccVoucher!
    setAccBooksLock(lockDate: String): AccSettings!
  }
`;

const READ = ['SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN'];
const blank = (v) => (v == null || String(v).trim() === '' ? null : String(v).trim());
const n = (v) => (v == null ? 0 : Number(v));
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PARTY_TYPES = ['DISTRIBUTOR', 'FARMER', 'VENDOR'];
const partyOf = (key) => {
  const [t, id] = String(key).split(':');
  return id && PARTY_TYPES.includes(t) ? { type: t, id } : null;
};

/** Report period: explicit dates, else the Indian FY containing `to` (default today). */
function period(fromDate, toDate) {
  const from = blank(fromDate);
  const to = blank(toDate);
  for (const d of [from, to]) if (d && (!DATE_RE.test(d) || Number.isNaN(Date.parse(d)))) throw httpError('Dates must be YYYY-MM-DD', 400);
  const fy = resolvePeriod('YEARLY', null, to);
  const p = { from: from ?? fy.from, to: to ?? fy.to };
  if (p.from > p.to) throw httpError('From date cannot be after To date', 400);
  return p;
}

// Every ledger (system + user + virtual party ledgers) in one directory.
// ponytail: key filters on party branches scan the master (fine to ~100k farmers); split by prefix if it grows.
const LEDGERS_SQL = `
  SELECT m.*, g.name AS group_name, g.nature FROM (
    SELECT COALESCE(l.code, l.id::text) AS key, l.id, l.code, l.name, l.group_id, l.opening_balance,
           NULL::text AS party_type, NULL::uuid AS party_id, l.gstin, l.state, l.is_active
    FROM acc_ledgers l WHERE l.party_type IS NULL
    UNION ALL
    SELECT 'DISTRIBUTOR:' || d.id, l.id, NULL, d.name, COALESCE(l.group_id, 'SUNDRY_DEBTORS'), COALESCE(l.opening_balance, 0),
           'DISTRIBUTOR', d.id, d.gstin, d.state, d.is_active
    FROM distributors d LEFT JOIN acc_ledgers l ON l.party_type = 'DISTRIBUTOR' AND l.party_id = d.id
    UNION ALL
    SELECT 'FARMER:' || f.id, l.id, NULL, f.name, COALESCE(l.group_id, 'SUNDRY_DEBTORS'), COALESCE(l.opening_balance, 0),
           'FARMER', f.id, NULL, f.state, TRUE
    FROM farmers f LEFT JOIN acc_ledgers l ON l.party_type = 'FARMER' AND l.party_id = f.id
    UNION ALL
    SELECT 'VENDOR:' || v.id, l.id, NULL, v.name, COALESCE(l.group_id, 'SUNDRY_CREDITORS'), COALESCE(l.opening_balance, 0),
           'VENDOR', v.id, v.gstin, v.state, v.is_active
    FROM vendors v LEFT JOIN acc_ledgers l ON l.party_type = 'VENDOR' AND l.party_id = v.id
  ) m JOIN acc_groups g ON g.id = m.group_id`;

const mapLedger = (r) => ({
  key: r.key, id: r.id, code: r.code, name: r.name, groupId: r.group_id, groupName: r.group_name, nature: r.nature,
  openingBalance: n(r.opening_balance), partyType: r.party_type, partyId: r.party_id, gstin: r.gstin, state: r.state,
  isActive: r.is_active !== false, isSystem: !!r.code,
});

/** Ledger rows by key (plus any with a non-zero opening balance when withOpening). */
async function ledgersByKey(keys, withOpening = false) {
  const { rows } = await query(`${LEDGERS_SQL} WHERE m.key = ANY($1::text[]) OR ($2 AND m.opening_balance <> 0)`, [keys, withOpening]);
  return new Map(rows.map((r) => [r.key, r]));
}

async function getLedger(key) {
  const row = (await ledgersByKey([key])).get(key);
  if (!row) throw httpError('Ledger not found', 404);
  return row;
}

async function lockDate(client = { query }) {
  const r = (await client.query('SELECT books_lock_date FROM acc_settings WHERE id = 1')).rows[0];
  return r?.books_lock_date ?? null;
}
function assertOpen(lock, date) {
  if (lock && date <= lock) throw httpError(`Books are locked up to ${lock}. Vouchers dated on or before it cannot be added, edited or cancelled.`, 400);
}

const TYPE_LABEL = (t) => t.split('_').map((w) => w[0] + w.slice(1).toLowerCase()).join(' ');

async function loadManualVouchers(where, params, extra = '') {
  const { rows } = await query(`SELECT * FROM acc_vouchers v ${where} ${extra}`, params);
  if (!rows.length) return [];
  const lines = (await query('SELECT * FROM acc_voucher_lines WHERE voucher_id = ANY($1::uuid[]) ORDER BY voucher_id, line_no', [rows.map((r) => r.id)])).rows;
  const names = await ledgersByKey([...new Set(lines.map((l) => l.ledger_key))]);
  const byV = new Map();
  for (const l of lines) {
    if (!byV.has(l.voucher_id)) byV.set(l.voucher_id, []);
    byV.get(l.voucher_id).push({ ledgerKey: l.ledger_key, ledgerName: names.get(l.ledger_key)?.name ?? `Unknown ledger (${l.ledger_key})`, dr: n(l.dr), cr: n(l.cr), narration: l.narration });
  }
  return rows.map((r) => {
    const ls = byV.get(r.id) ?? [];
    return {
      key: `voucher:${r.id}`, id: r.id, typeCode: r.voucher_type, voucherType: TYPE_LABEL(r.voucher_type), voucherNo: r.voucher_no,
      date: r.voucher_date, narration: r.narration, refNo: r.ref_no, amount: n(r.amount), status: r.status, cancelReason: r.cancel_reason,
      sourceType: 'voucher', sourceId: r.id, docId: r.id, particulars: ls[0]?.ledgerName ?? null, lines: ls, createdAt: r.created_at,
    };
  });
}

async function saveVoucher(actor, id, input) {
  const date = blank(input.date);
  const keys = [...new Set((input.lines || []).map((l) => l.ledgerKey).filter(Boolean))];
  const ledgers = await ledgersByKey(keys);
  const { lines, amount } = validateVoucher({ voucherType: input.voucherType, date, lines: input.lines }, (k) => ledgers.get(k)?.group_id);
  const fy = fyOf(date);
  const saved = await withTransaction(async (client) => {
    const lock = await lockDate(client);
    assertOpen(lock, date);
    const nextNo = async () => {
      const seq = (await client.query(
        `INSERT INTO acc_voucher_counters (voucher_type, fy, last_seq) VALUES ($1, $2, 1)
         ON CONFLICT (voucher_type, fy) DO UPDATE SET last_seq = acc_voucher_counters.last_seq + 1 RETURNING last_seq`,
        [input.voucherType, fy])).rows[0].last_seq;
      return { seq, no: voucherNo(input.voucherType, fy, seq) };
    };
    let vid = id;
    if (id) {
      const cur = (await client.query('SELECT * FROM acc_vouchers WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!cur) throw httpError('Voucher not found', 404);
      if (cur.status !== 'ACTIVE') throw httpError('A cancelled voucher cannot be edited', 400);
      assertOpen(lock, cur.voucher_date);
      // Renumber only when the series (type / FY) changes.
      const num = cur.voucher_type === input.voucherType && cur.fy === fy ? { seq: cur.seq, no: cur.voucher_no } : await nextNo();
      await client.query(
        `UPDATE acc_vouchers SET voucher_type=$2, fy=$3, seq=$4, voucher_no=$5, voucher_date=$6, ref_no=$7, narration=$8, amount=$9,
                updated_by=$10, updated_at=now() WHERE id=$1`,
        [id, input.voucherType, fy, num.seq, num.no, date, blank(input.refNo), blank(input.narration), amount, actor.sub]);
      await client.query('DELETE FROM acc_voucher_lines WHERE voucher_id = $1', [id]);
    } else {
      const num = await nextNo();
      vid = (await client.query(
        `INSERT INTO acc_vouchers (voucher_type, fy, seq, voucher_no, voucher_date, ref_no, narration, amount, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9) RETURNING id`,
        [input.voucherType, fy, num.seq, num.no, date, blank(input.refNo), blank(input.narration), amount, actor.sub])).rows[0].id;
    }
    for (const [i, l] of lines.entries()) {
      await client.query(
        'INSERT INTO acc_voucher_lines (voucher_id, line_no, ledger_key, dr, cr, narration) VALUES ($1,$2,$3,$4,$5,$6)',
        [vid, i + 1, l.ledgerKey, l.dr, l.cr, l.narration]);
    }
    return vid;
  });
  await logActivity(actor.sub, id ? 'UPDATE_VOUCHER' : 'CREATE_VOUCHER', 'acc_voucher', saved, { voucherType: input.voucherType, date, amount });
  return (await loadManualVouchers('WHERE v.id = $1', [saved]))[0];
}

async function ledgerInputRow(input, { isNew, current }) {
  const name = blank(input.name);
  if (isNew && !name) throw httpError('Ledger name is required', 400);
  if (input.name !== undefined && !name) throw httpError('Ledger name cannot be empty', 400);
  const groupId = blank(input.groupId);
  if (isNew && !groupId) throw httpError('Choose the group this ledger belongs under', 400);
  if (groupId && !(await query('SELECT 1 FROM acc_groups WHERE id = $1', [groupId])).rows[0]) throw httpError('Unknown group', 400);
  if (current?.code && groupId && groupId !== current.group_id) throw httpError('The group of a system ledger cannot be changed', 400);
  const ob = input.openingBalance == null ? null : Number(input.openingBalance);
  if (ob != null && !Number.isFinite(ob)) throw httpError('Opening balance must be a number', 400);
  const gstin = blank(input.gstin)?.toUpperCase() ?? null;
  if (gstin) {
    const v = validateGstin(gstin);
    if (!v.valid) throw httpError(`GSTIN: ${v.reason}`, 400);
  }
  return { name, groupId, ob: ob == null ? null : round2(ob), gstin, state: blank(input.state) };
}

async function assertUniqueName(name, exceptId = null) {
  const dup = await query('SELECT 1 FROM acc_ledgers WHERE lower(name) = lower($1) AND party_type IS NULL AND ($2::uuid IS NULL OR id <> $2)', [name, exceptId]);
  if (dup.rows[0]) throw httpError(`A ledger named "${name}" already exists`, 409);
}

export function accountingResolvers() {
  return {
    Query: {
      accGroups: async (_p, _a, ctx) => {
        assertRole(ctx, ...READ);
        const { rows } = await query('SELECT * FROM acc_groups ORDER BY sort_order, name');
        return rows.map((g) => ({ id: g.id, name: g.name, parentId: g.parent_id, nature: g.nature, affectsGrossProfit: g.affects_gross_profit, sortOrder: g.sort_order }));
      },

      accLedgers: async (_p, { search, groupId, includeParties, limit }, ctx) => {
        assertRole(ctx, ...READ);
        const s = blank(search);
        const { rows } = await query(
          `${LEDGERS_SQL}
           WHERE ($1::text IS NULL OR m.name ILIKE $1 OR m.key = $4)
             AND ($2::text IS NULL OR m.group_id = $2 OR g.parent_id = $2)
             AND ($3 OR m.party_type IS NULL)
           ORDER BY (m.party_type IS NOT NULL), g.sort_order, m.name LIMIT $5`,
          [s ? `%${s}%` : null, blank(groupId), includeParties !== false && (!!s || !!blank(groupId)), s, Math.min(Math.max(limit ?? 200, 1), 1000)],
        );
        return rows.map(mapLedger);
      },

      accLedger: async (_p, { key }, ctx) => {
        assertRole(ctx, ...READ);
        const row = (await ledgersByKey([key])).get(key);
        return row ? mapLedger(row) : null;
      },

      accSettings: async (_p, _a, ctx) => {
        assertRole(ctx, ...READ);
        return { booksLockDate: await lockDate() };
      },

      accVouchers: async (_p, { fromDate, toDate, voucherType, status, search, limit, offset }, ctx) => {
        assertRole(ctx, ...READ);
        const { from, to } = period(fromDate, toDate);
        const s = blank(search);
        const params = [from, to, blank(voucherType), blank(status), s ? `%${s}%` : null];
        const where = `WHERE v.voucher_date BETWEEN $1 AND $2 AND ($3::text IS NULL OR v.voucher_type = $3)
          AND ($4::text IS NULL OR v.status = $4) AND ($5::text IS NULL OR v.voucher_no ILIKE $5 OR v.narration ILIKE $5 OR v.ref_no ILIKE $5)`;
        const [agg, items] = await Promise.all([
          query(`SELECT COUNT(*)::int total, COALESCE(SUM(amount) FILTER (WHERE status = 'ACTIVE'), 0) amt FROM acc_vouchers v ${where}`, params),
          loadManualVouchers(where, [...params, Math.min(Math.max(limit ?? 50, 1), 500), Math.max(offset ?? 0, 0)],
            'ORDER BY v.voucher_date DESC, v.created_at DESC LIMIT $6 OFFSET $7'),
        ]);
        return { items, total: agg.rows[0].total, totalAmount: n(agg.rows[0].amt) };
      },

      accVoucher: async (_p, { id }, ctx) => {
        assertRole(ctx, ...READ);
        return (await loadManualVouchers('WHERE v.id = $1', [id]))[0] ?? null;
      },

      accDayBook: async (_p, { fromDate, toDate, voucherType, search, limit, offset }, ctx) => {
        assertRole(ctx, ...READ);
        const { from, to } = period(fromDate, toDate);
        const s = blank(search);
        const { rows } = await query(
          `WITH p AS (${postingsSql('$1', '$2')}),
           v AS (SELECT voucher_key, MIN(voucher_date) d, MIN(voucher_no) no, SUM(GREATEST(amt, 0)) amount
                 FROM p WHERE ($3::text IS NULL OR voucher_type = $3) GROUP BY voucher_key
                 HAVING $4::text IS NULL OR bool_or(voucher_no ILIKE $4 OR narration ILIKE $4)),
           pg AS (SELECT v.*, COUNT(*) OVER () total, SUM(amount) OVER () total_amount FROM v
                  ORDER BY d, no, voucher_key LIMIT $5 OFFSET $6)
           SELECT p.*, pg.total, pg.total_amount, pg.amount FROM p JOIN pg USING (voucher_key)
           ORDER BY pg.d, pg.no, p.voucher_key, p.ord`,
          [from, to, blank(voucherType), s ? `%${s}%` : null, Math.min(Math.max(limit ?? 100, 1), 1000), Math.max(offset ?? 0, 0)],
        );
        const names = await ledgersByKey([...new Set(rows.map((r) => r.ledger_key))]);
        const items = [];
        const byKey = new Map();
        for (const r of rows) {
          let v = byKey.get(r.voucher_key);
          if (!v) {
            v = {
              key: r.voucher_key, id: r.source_type === 'voucher' ? r.source_id : null, typeCode: null, voucherType: r.voucher_type,
              voucherNo: r.voucher_no, date: r.voucher_date, narration: null, refNo: null, amount: n(r.amount), status: 'ACTIVE',
              sourceType: r.source_type, sourceId: r.source_id, docId: r.doc_id, particulars: null, lines: [],
            };
            byKey.set(r.voucher_key, v);
            items.push(v);
          }
          const name = names.get(r.ledger_key)?.name ?? `Unknown ledger (${r.ledger_key})`;
          v.narration ??= r.narration;
          v.particulars ??= name;
          v.lines.push({ ledgerKey: r.ledger_key, ledgerName: name, dr: Math.max(n(r.amt), 0), cr: Math.max(-n(r.amt), 0), narration: r.narration });
        }
        return { items, total: Number(rows[0]?.total ?? 0), totalAmount: n(rows[0]?.total_amount) };
      },

      accLedgerStatement: async (_p, { ledgerKey, fromDate, toDate }, ctx) => {
        assertRole(ctx, ...READ);
        const { from, to } = period(fromDate, toDate);
        const ledger = await getLedger(ledgerKey);
        const { rows } = await query(
          `WITH p AS (${postingsSql('NULL', '$2')}),
           mine AS (SELECT voucher_key, voucher_type, voucher_no, voucher_date, source_type, source_id, doc_id, MIN(narration) narration, SUM(amt) amt
                    FROM p WHERE ledger_key = $1 GROUP BY 1, 2, 3, 4, 5, 6, 7),
           ctr AS (SELECT DISTINCT ON (o.voucher_key) o.voucher_key, o.ledger_key
                   FROM p o JOIN mine m ON m.voucher_key = o.voucher_key AND m.voucher_date >= $3
                   WHERE o.ledger_key <> $1 ORDER BY o.voucher_key, abs(o.amt) DESC)
           SELECT m.*, ctr.ledger_key AS counter_key FROM mine m LEFT JOIN ctr USING (voucher_key)
           -- within a day: documents, then receipts/payments (Dr first), then contra/journal — no false intra-day negatives
           ORDER BY m.voucher_date,
                    CASE WHEN m.voucher_type IN ('Receipt', 'Payment') THEN 2 WHEN m.voucher_type IN ('Contra', 'Journal') THEN 3 ELSE 1 END,
                    m.amt DESC, m.voucher_no, m.voucher_key`,
          [ledgerKey, to, from],
        );
        const counters = await ledgersByKey([...new Set(rows.map((r) => r.counter_key).filter(Boolean))]);
        const opening = round2(rows.reduce((s, r) => (r.voucher_date < from ? s + n(r.amt) : s), n(ledger.opening_balance)));
        let bal = opening;
        let totalDr = 0;
        let totalCr = 0;
        const out = [];
        for (const r of rows) {
          if (r.voucher_date < from) continue;
          const amt = n(r.amt);
          const dr = Math.max(amt, 0);
          const cr = Math.max(-amt, 0);
          totalDr += dr; totalCr += cr; bal = round2(bal + amt);
          out.push({
            date: r.voucher_date, voucherKey: r.voucher_key, voucherType: r.voucher_type, voucherNo: r.voucher_no,
            particulars: counters.get(r.counter_key)?.name ?? null, narration: r.narration, sourceType: r.source_type,
            sourceId: r.source_id, docId: r.doc_id, dr, cr, balance: bal,
          });
        }
        return { ledger: mapLedger(ledger), fromDate: from, toDate: to, opening, totalDr: round2(totalDr), totalCr: round2(totalCr), closing: bal, rows: out };
      },

      accTrialBalance: async (_p, { fromDate, toDate }, ctx) => {
        assertRole(ctx, ...READ);
        const { from, to } = period(fromDate, toDate);
        return { fromDate: from, toDate: to, ...(await trialBalance(from, to)) };
      },

      accFinalAccounts: async (_p, { fromDate, toDate }, ctx) => {
        assertRole(ctx, ...READ);
        const { from, to } = period(fromDate, toDate);
        const [tb, stock] = await Promise.all([trialBalance(from, to), stockValues(from, to)]);
        return { fromDate: from, toDate: to, ...stock, ...finalAccounts(tb, stock) };
      },
    },

    Mutation: {
      createAccLedger: async (_p, { input }, ctx) => {
        const actor = assertRole(ctx, ...READ);
        const v = await ledgerInputRow(input, { isNew: true });
        await assertUniqueName(v.name);
        const r = (await query(
          `INSERT INTO acc_ledgers (name, group_id, opening_balance, gstin, state, is_active, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
          [v.name, v.groupId, v.ob ?? 0, v.gstin, v.state, input.isActive !== false, actor.sub])).rows[0];
        await logActivity(actor.sub, 'CREATE_LEDGER', 'acc_ledger', r.id, { name: v.name, groupId: v.groupId, openingBalance: v.ob ?? 0 });
        return mapLedger(await getLedger(r.id));
      },

      updateAccLedger: async (_p, { key, input }, ctx) => {
        const actor = assertRole(ctx, ...READ);
        const cur = await getLedger(key);
        const v = await ledgerInputRow(input, { isNew: false, current: cur });
        const party = partyOf(key);
        if (party) {
          // Party masters own name/GSTIN; the books only keep group + opening balance (row created lazily).
          await query(
            `INSERT INTO acc_ledgers (name, group_id, opening_balance, party_type, party_id, created_by) VALUES ($1,$2,$3,$4,$5,$6)
             ON CONFLICT (party_type, party_id) DO UPDATE SET group_id = EXCLUDED.group_id, opening_balance = EXCLUDED.opening_balance, updated_at = now()`,
            [cur.name, v.groupId ?? cur.group_id, v.ob ?? n(cur.opening_balance), party.type, party.id, actor.sub]);
        } else {
          if (v.name) await assertUniqueName(v.name, cur.id);
          await query(
            `UPDATE acc_ledgers SET name = COALESCE($2, name), group_id = COALESCE($3, group_id), opening_balance = COALESCE($4, opening_balance),
                    gstin = CASE WHEN $7 THEN $5 ELSE gstin END, state = CASE WHEN $8 THEN $6 ELSE state END,
                    is_active = COALESCE($9, is_active), updated_at = now() WHERE id = $1`,
            [cur.id, v.name, v.groupId, v.ob, v.gstin, v.state, input.gstin !== undefined, input.state !== undefined, input.isActive ?? null]);
        }
        await logActivity(actor.sub, 'UPDATE_LEDGER', 'acc_ledger', cur.id ?? null, {
          key, before: { name: cur.name, groupId: cur.group_id, openingBalance: n(cur.opening_balance) }, after: input,
        });
        return mapLedger(await getLedger(key));
      },

      deleteAccLedger: async (_p, { key }, ctx) => {
        const actor = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN');
        const cur = await getLedger(key);
        if (cur.code || cur.party_type) throw httpError('System and party ledgers cannot be deleted', 400);
        const used = await query('SELECT 1 FROM acc_voucher_lines WHERE ledger_key = $1 LIMIT 1', [key]);
        if (used.rows[0]) throw httpError('This ledger is used in vouchers — mark it inactive instead', 400);
        await query('DELETE FROM acc_ledgers WHERE id = $1', [cur.id]);
        await logActivity(actor.sub, 'DELETE_LEDGER', 'acc_ledger', cur.id, { name: cur.name, openingBalance: n(cur.opening_balance) });
        return true;
      },

      createAccVoucher: async (_p, { input }, ctx) => saveVoucher(assertRole(ctx, ...READ), null, input),
      updateAccVoucher: async (_p, { id, input }, ctx) => saveVoucher(assertRole(ctx, ...READ), id, input),

      cancelAccVoucher: async (_p, { id, reason }, ctx) => {
        const actor = assertRole(ctx, ...READ);
        const why = blank(reason);
        if (!why) throw httpError('Give a reason for cancelling', 400);
        await withTransaction(async (client) => {
          const cur = (await client.query('SELECT * FROM acc_vouchers WHERE id = $1 FOR UPDATE', [id])).rows[0];
          if (!cur) throw httpError('Voucher not found', 404);
          if (cur.status === 'CANCELLED') throw httpError('Voucher is already cancelled', 400);
          assertOpen(await lockDate(client), cur.voucher_date);
          await client.query(
            "UPDATE acc_vouchers SET status = 'CANCELLED', cancel_reason = $2, cancelled_by = $3, cancelled_at = now(), updated_at = now() WHERE id = $1",
            [id, why, actor.sub]);
        });
        await logActivity(actor.sub, 'CANCEL_VOUCHER', 'acc_voucher', id, { reason: why });
        return (await loadManualVouchers('WHERE v.id = $1', [id]))[0];
      },

      setAccBooksLock: async (_p, { lockDate: d }, ctx) => {
        const actor = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN');
        const date = blank(d);
        if (date && (!DATE_RE.test(date) || Number.isNaN(Date.parse(date)))) throw httpError('Lock date must be YYYY-MM-DD', 400);
        await query('UPDATE acc_settings SET books_lock_date = $1, updated_by = $2, updated_at = now() WHERE id = 1', [date, actor.sub]);
        await logActivity(actor.sub, 'SET_BOOKS_LOCK', 'acc_settings', null, { lockDate: date });
        return { booksLockDate: date };
      },
    },
  };
}

/** Ledger-wise opening (as at `from`), period Dr/Cr, rolled up by group + integrity check. */
async function trialBalance(from, to) {
  const post = `WITH p AS (${postingsSql('NULL', '$2')})`;
  const fyStart = `${fyOf(from).slice(0, 4)}-04-01`;
  const [bal, unb, groups] = await Promise.all([
    query(
      `${post} SELECT ledger_key,
         COALESCE(SUM(amt) FILTER (WHERE voucher_date < $1), 0) pre,
         COALESCE(SUM(amt) FILTER (WHERE voucher_date < $3), 0) pre_fy,
         COALESCE(SUM(GREATEST(amt, 0)) FILTER (WHERE voucher_date >= $1), 0) dr,
         COALESCE(SUM(GREATEST(-amt, 0)) FILTER (WHERE voucher_date >= $1), 0) cr
       FROM p GROUP BY ledger_key`, [from, to, fyStart]),
    query(
      `${post} SELECT voucher_key, MIN(voucher_no) voucher_no, SUM(amt) diff FROM p
       WHERE voucher_date >= $1 GROUP BY voucher_key HAVING abs(SUM(amt)) >= 0.005`, [from, to]),
    query('SELECT * FROM acc_groups'),
  ]);
  const master = await ledgersByKey(bal.rows.map((r) => r.ledger_key), true);
  const moves = new Map(bal.rows.map((r) => [r.ledger_key, r]));
  const keys = new Set([...master.keys(), ...moves.keys()]);
  // Tally closes income/expense ledgers into Profit & Loss A/c at every FY end: their
  // opening keeps only this FY's earlier postings; older ones carry in a PL_AC line.
  let carried = 0;
  const ledgers = [...keys].map((key) => {
    const m = master.get(key);
    const mv = moves.get(key);
    let opening = n(m?.opening_balance) + n(mv?.pre);
    if (m?.nature === 'INCOME' || m?.nature === 'EXPENSE') {
      const old = n(m.opening_balance) + n(mv?.pre_fy);
      carried += old;
      opening -= old;
    }
    return {
      key, name: m?.name ?? `Unknown ledger (${key})`, groupId: m?.group_id ?? 'SUSPENSE', partyType: m?.party_type ?? null,
      opening, dr: n(mv?.dr), cr: n(mv?.cr),
    };
  }).filter((l) => round2(l.opening) || round2(l.dr) || round2(l.cr))
    .sort((a, b) => a.name.localeCompare(b.name));
  if (round2(carried)) ledgers.unshift({ key: 'PL_AC', name: 'Profit & Loss A/c', groupId: 'PL_AC', partyType: null, opening: carried, dr: 0, cr: 0 });
  const tb = buildTrialBalance(
    groups.rows.map((g) => ({ id: g.id, name: g.name, parentId: g.parent_id, nature: g.nature, affectsGrossProfit: g.affects_gross_profit, sortOrder: g.sort_order })),
    ledgers,
  );
  return { ...tb, unbalanced: unb.rows.map((r) => ({ voucherKey: r.voucher_key, voucherNo: r.voucher_no, diff: n(r.diff) })) };
}

// Same valuation as services/finance/financials.js STOCK_AS_AT: stock at the end of a day =
// on-hand today − movements after that day, × standard cost (else distributor price).
// Both ends use the same basis, so stock loaded without movements counts as opening, not profit.
const STOCK_AS_AT = (d) => `(SELECT COALESCE(SUM(GREATEST(q.qty, 0) * COALESCE(NULLIF(p.standard_cost, 0), p.distributor_price, 0)), 0)
  FROM (SELECT product_id, SUM(qty) qty FROM (
          SELECT product_id, quantity qty FROM stock_levels
          UNION ALL
          SELECT product_id, -quantity FROM stock_movements WHERE created_at >= (${d}::date + 1)::timestamptz
        ) m GROUP BY product_id) q JOIN products p ON p.id = q.product_id)`;
async function stockValues(from, to) {
  const r = (await query(`SELECT ${STOCK_AS_AT('($1::date - 1)')} AS opening, ${STOCK_AS_AT('$2')} AS closing`, [from, to])).rows[0];
  return { openingStock: round2(n(r.opening)), closingStock: round2(n(r.closing)) };
}
