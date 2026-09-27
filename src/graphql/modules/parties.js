// GraphQL module: Parties — unified counterparties (distributors + farmers + vendors).
// Sell any product to anyone (direct party sale) and view a consolidated LEDGER
// that aggregates from the existing modules (invoices, payments, credit/debit
// notes, purchase bills, vendor payments, returns) + direct sales.

import { query, withTransaction } from '../../db/index.js';
import { assertAuth, assertRole } from '../context.js';
import { httpError, logActivity, num, isoDate } from '../helpers.js';

export const partyTypeDefs = /* GraphQL */ `
  type Party {
    id: ID!
    partyType: String!          # DISTRIBUTOR / FARMER / VENDOR
    name: String!
    phone: String
    email: String
    gstin: String
    location: String
    balance: Float!
    balanceKind: String!        # RECEIVABLE (they owe us) / PAYABLE (we owe them)
    isActive: Boolean!
  }

  type PartyLedgerEntry {
    date: String!
    type: String!               # INVOICE / PAYMENT / CREDIT NOTE / DIRECT SALE / PURCHASE BILL / ...
    refNo: String
    description: String
    debit: Float!
    credit: Float!
    balance: Float!             # absolute running balance amount after this entry
    balanceSide: String!        # DR / CR / NONE
  }

  type PartyLedger {
    partyId: ID!
    partyType: String!
    name: String!
    balanceKind: String!
    fromDate: String
    toDate: String
    openingBalance: Float!
    openingBalanceSide: String! # DR / CR / NONE
    totalDebit: Float!
    totalCredit: Float!
    closingBalance: Float!
    closingBalanceSide: String! # DR / CR / NONE
    currentBalance: Float!
    currentBalanceSide: String! # DR / CR / NONE
    totalBilled: Float!         # total sold to / purchased from the party
    totalPaid: Float!
    totalReturns: Float!
    entryCount: Int!
    entries: [PartyLedgerEntry!]!
  }

  type PartiesStats { total: Int!, distributors: Int!, farmers: Int!, vendors: Int!, receivable: Float!, payable: Float! }

  # Filter-independent header KPIs for the Outstanding view — computed over the FULL
  # receivables set (every distributor/farmer with a positive balance) so the tiles,
  # split bar, tab counts and progress-bar scale stay stable while paging or searching.
  type OutstandingSummary {
    partiesWithDues: Int!
    distributorCount: Int!
    farmerCount: Int!
    distributorDue: Float!
    farmerDue: Float!
    maxBalance: Float!
  }

  # One page of outstanding receivables + pagination meta + the summary above.
  type OutstandingPage {
    data: [Party!]!
    currentPage: Int!
    totalPages: Int!
    totalRecords: Int!
    limit: Int!
    hasNextPage: Boolean!
    hasPrevPage: Boolean!
    summary: OutstandingSummary!
  }

  type PartySaleLine { id: ID!, productId: ID!, productName: String!, packingSize: String, batchNumber: String, quantity: Float!, unitPrice: Float!, gstPercent: Float!, lineTotal: Float! }
  type PartySale {
    id: ID!
    saleNo: String!
    partyType: String!
    partyName: String
    warehouseName: String
    saleDate: String!
    subTotal: Float!
    taxTotal: Float!
    totalAmount: Float!
    amountPaid: Float!
    balanceDue: Float!
    paymentMethod: String
    notes: String
    itemCount: Int!
    lines: [PartySaleLine!]!
    createdAt: DateTime!
  }

  input PartySaleLineInput { productId: ID!, batchNumber: String, quantity: Float!, unitPrice: Float! }
  input CreatePartySaleInput {
    partyType: String!          # DISTRIBUTOR / FARMER
    partyId: ID!
    warehouseId: ID!
    amountPaid: Float = 0
    paymentMethod: String
    notes: String
    lines: [PartySaleLineInput!]!
  }

  extend type Query {
    parties(search: String, type: String, limit: Int = 200): [Party!]!
    "Server-side paginated Outstanding (receivables) list. type = DISTRIBUTOR | FARMER | null (all)."
    outstandingReceivables(page: Int = 1, limit: Int = 20, type: String, search: String): OutstandingPage!
    partyLedger(partyType: String!, partyId: ID!, fromDate: String, toDate: String): PartyLedger!
    partiesStats: PartiesStats!
    partySales(limit: Int = 100): [PartySale!]!
    partySale(id: ID!): PartySale
  }

  extend type Mutation {
    createPartySale(input: CreatePartySaleInput!): PartySale!
  }
`;

const round2 = (n) => Math.round(n * 100) / 100;
const LEDGER_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function normalizeLedgerDate(value, field) {
  if (value == null || value === '') return null;
  const date = String(value).trim();
  if (!LEDGER_DATE_RE.test(date)) throw httpError(`${field} must be an ISO date (YYYY-MM-DD)`, 400);
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw httpError(`${field} is not a valid calendar date`, 400);
  }
  return date;
}

function ledgerDelta(entry, balanceKind) {
  // A receivable is a debit balance; a payable is a credit balance. Keeping
  // this sign convention makes the displayed Dr/Cr side match Tally for both.
  return balanceKind === 'PAYABLE' ? entry.credit - entry.debit : entry.debit - entry.credit;
}

function balanceSide(signed, balanceKind) {
  if (Math.abs(signed) < 0.005) return 'NONE';
  if (balanceKind === 'PAYABLE') return signed > 0 ? 'CR' : 'DR';
  return signed > 0 ? 'DR' : 'CR';
}

function balanceSnapshot(signed, balanceKind) {
  return { amount: round2(Math.abs(signed)), side: balanceSide(signed, balanceKind) };
}

function pushLedgerEntry(raw, entry) {
  const date = isoDate(entry.date);
  if (!date) return;
  raw.push({
    date,
    type: entry.type,
    refNo: entry.refNo ?? null,
    description: entry.description ?? null,
    debit: round2(num(entry.debit) ?? 0),
    credit: round2(num(entry.credit) ?? 0),
    order: raw.length,
  });
}

function calculatePartyLedger({ raw, balanceKind, sourceExposure, fromDate, toDate }) {
  raw.sort((a, b) => a.date.localeCompare(b.date) || a.order - b.order);

  // The denormalised party outstanding is the authoritative present-day
  // balance for distributors/vendors. Reconcile it against the full journal
  // so old/imported balances become a genuine opening balance instead of being
  // silently dropped from the statement. Farmers have no master outstanding;
  // their opening is zero unless an explicit opening transaction is added.
  const fullExposure = raw.reduce((sum, entry) => sum + ledgerDelta(entry, balanceKind), 0);
  const baseline = sourceExposure == null ? 0 : round2(sourceExposure - fullExposure);
  const beforePeriod = fromDate
    ? raw.filter((entry) => entry.date < fromDate).reduce((sum, entry) => sum + ledgerDelta(entry, balanceKind), 0)
    : 0;
  const openingSigned = round2(baseline + beforePeriod);
  const periodEntries = raw.filter((entry) => (!fromDate || entry.date >= fromDate) && (!toDate || entry.date <= toDate));

  let running = openingSigned;
  const entries = periodEntries.map((entry) => {
    running = round2(running + ledgerDelta(entry, balanceKind));
    const snap = balanceSnapshot(running, balanceKind);
    return {
      date: entry.date,
      type: entry.type,
      refNo: entry.refNo,
      description: entry.description,
      debit: entry.debit,
      credit: entry.credit,
      balance: snap.amount,
      balanceSide: snap.side,
    };
  });

  const opening = balanceSnapshot(openingSigned, balanceKind);
  const closing = balanceSnapshot(running, balanceKind);
  const sum = (predicate, field) => round2(periodEntries.filter(predicate).reduce((total, entry) => total + entry[field], 0));
  const isReturn = (entry) => entry.type.includes('RETURN') || entry.type === 'CREDIT NOTE';
  const isPayment = (entry) => entry.type === 'PAYMENT' || entry.type === 'SALE PAYMENT';

  return {
    fromDate: fromDate ?? null,
    toDate: toDate ?? null,
    openingBalance: opening.amount,
    openingBalanceSide: opening.side,
    totalDebit: sum(() => true, 'debit'),
    totalCredit: sum(() => true, 'credit'),
    closingBalance: closing.amount,
    closingBalanceSide: closing.side,
    currentBalance: closing.amount,
    currentBalanceSide: closing.side,
    totalBilled: balanceKind === 'PAYABLE'
      ? sum((entry) => entry.type === 'PURCHASE BILL', 'credit')
      : sum((entry) => entry.type === 'INVOICE' || entry.type === 'DIRECT SALE', 'debit'),
    totalPaid: balanceKind === 'PAYABLE'
      ? sum(isPayment, 'debit')
      : sum(isPayment, 'credit'),
    totalReturns: sum(isReturn, balanceKind === 'PAYABLE' ? 'debit' : 'credit'),
    entryCount: entries.length,
    entries,
  };
}

function fy(d) {
  const dt = d ? new Date(d) : new Date();
  const start = dt.getMonth() >= 3 ? dt.getFullYear() : dt.getFullYear() - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

const mapSale = (r) => r && {
  id: r.id, saleNo: r.sale_no, partyType: r.party_type, partyName: r.party_name ?? null, warehouseName: r.warehouse_name ?? null,
  saleDate: isoDate(r.sale_date), subTotal: num(r.sub_total), taxTotal: num(r.tax_total), totalAmount: num(r.total_amount),
  amountPaid: num(r.amount_paid), balanceDue: round2(num(r.total_amount) - num(r.amount_paid)), paymentMethod: r.payment_method,
  notes: r.notes, createdAt: r.created_at,
};
const SALE_SELECT = `SELECT s.*, w.name warehouse_name, COALESCE(d.name, f.name) party_name
  FROM party_sales s LEFT JOIN warehouses w ON w.id = s.warehouse_id
  LEFT JOIN distributors d ON d.id = s.distributor_id LEFT JOIN farmers f ON f.id = s.farmer_id`;

export function partyResolvers() {
  return {
    Query: {
      parties: async (_p, { search, type, limit }, ctx) => {
        assertAuth(ctx);
        const { rows } = await query(
          `SELECT * FROM (
             SELECT d.id::text id, 'DISTRIBUTOR' party_type, d.name, d.phone, d.email, d.gstin, d.state location,
               d.outstanding + COALESCE((SELECT SUM(total_amount-amount_paid) FROM party_sales WHERE distributor_id=d.id),0) balance,
               'RECEIVABLE' balance_kind, d.is_active
             FROM distributors d
             UNION ALL
             SELECT v.id::text, 'VENDOR', v.name, v.phone, v.email, v.gstin, COALESCE(v.city, v.state),
               v.outstanding, 'PAYABLE', v.is_active FROM vendors v
             UNION ALL
             SELECT f.id::text, 'FARMER', f.name, f.phone, f.email, NULL, COALESCE(f.village, f.district),
               COALESCE((SELECT SUM(total_amount-amount_paid) FROM party_sales WHERE farmer_id=f.id),0)
                 + COALESCE((SELECT SUM(total_amount-amount_paid) FROM invoices WHERE farmer_id=f.id),0), 'RECEIVABLE', true
             FROM farmers f
           ) p
           WHERE ($1::text IS NULL OR p.party_type = $1)
             AND ($2::text IS NULL OR p.name ILIKE '%'||$2||'%' OR p.phone ILIKE '%'||$2||'%' OR p.gstin ILIKE '%'||$2||'%')
           ORDER BY p.name LIMIT $3`,
          [type || null, search?.trim() || null, Math.min(Math.max(limit ?? 200, 1), 1000)],
        );
        return rows.map((r) => ({
          id: r.id, partyType: r.party_type, name: r.name, phone: r.phone, email: r.email, gstin: r.gstin,
          location: r.location, balance: num(r.balance) ?? 0, balanceKind: r.balance_kind, isActive: r.is_active ?? true,
        }));
      },

      partiesStats: async (_p, _a, ctx) => {
        assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN', 'SALES');
        const { rows } = await query(
          `SELECT (SELECT COUNT(*) FROM distributors)::int distributors,
                  (SELECT COUNT(*) FROM vendors)::int vendors,
                  (SELECT COUNT(*) FROM farmers)::int farmers,
                  COALESCE((SELECT SUM(outstanding) FROM distributors),0)
                    + COALESCE((SELECT SUM(total_amount-amount_paid) FROM party_sales),0)
                    + COALESCE((SELECT SUM(total_amount-amount_paid) FROM invoices WHERE customer_type='FARMER'),0) receivable,
                  COALESCE((SELECT SUM(outstanding) FROM vendors),0) payable`,
        );
        const r = rows[0];
        return { total: r.distributors + r.vendors + r.farmers, distributors: r.distributors, farmers: r.farmers, vendors: r.vendors, receivable: num(r.receivable), payable: num(r.payable) };
      },

      // Server-side paginated Outstanding view. Receivables = distributors + farmers
      // with a positive balance (vendors are PAYABLE, so excluded — also a perf win vs.
      // the full `parties` union). Returns the requested page slice (largest dues first),
      // pagination meta, and a filter-independent `summary` so the header tiles / split
      // bar / tab counts stay stable across pages and searches. The expensive per-party
      // balance subqueries run once: the `positive` CTE is materialised and reused for
      // counting, the summary, and the page slice — a single round-trip to the DB.
      outstandingReceivables: async (_p, args, ctx) => {
        assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN', 'SALES');
        const type = ['DISTRIBUTOR', 'FARMER'].includes(args.type) ? args.type : null;
        const search = args.search?.trim() || null;
        const limit = Math.min(Math.max(args.limit ?? 20, 1), 100);
        const page = Math.max(args.page ?? 1, 1);
        const offset = (page - 1) * limit;

        const { rows } = await query(
          `WITH recv AS (
             SELECT d.id::text AS id, 'DISTRIBUTOR' AS party_type, d.name, d.phone, d.email, d.gstin, d.state AS location,
               d.outstanding + COALESCE((SELECT SUM(total_amount-amount_paid) FROM party_sales WHERE distributor_id=d.id),0) AS balance
             FROM distributors d
             UNION ALL
             SELECT f.id::text, 'FARMER', f.name, f.phone, f.email, NULL, COALESCE(f.village, f.district),
               COALESCE((SELECT SUM(total_amount-amount_paid) FROM party_sales WHERE farmer_id=f.id),0)
                 + COALESCE((SELECT SUM(total_amount-amount_paid) FROM invoices WHERE farmer_id=f.id AND status <> 'CANCELLED'),0)
             FROM farmers f
           ),
           positive AS (SELECT * FROM recv WHERE balance > 0),
           filtered AS (
             SELECT * FROM positive
             WHERE ($1::text IS NULL OR party_type = $1)
               AND ($2::text IS NULL OR name ILIKE '%'||$2||'%' OR phone ILIKE '%'||$2||'%')
           ),
           page_rows AS (SELECT * FROM filtered ORDER BY balance DESC, name LIMIT $3 OFFSET $4)
           SELECT
             (SELECT COUNT(*) FROM filtered)::int AS total_records,
             (SELECT row_to_json(s) FROM (
                SELECT COUNT(*)::int AS parties_with_dues,
                       COUNT(*) FILTER (WHERE party_type='DISTRIBUTOR')::int AS distributor_count,
                       COUNT(*) FILTER (WHERE party_type='FARMER')::int AS farmer_count,
                       COALESCE(SUM(balance) FILTER (WHERE party_type='DISTRIBUTOR'),0) AS distributor_due,
                       COALESCE(SUM(balance) FILTER (WHERE party_type='FARMER'),0) AS farmer_due,
                       COALESCE(MAX(balance),0) AS max_balance
                FROM positive
              ) s) AS summary,
             COALESCE((SELECT json_agg(p) FROM page_rows p), '[]'::json) AS data`,
          [type, search, limit, offset],
        );

        const r = rows[0];
        const sm = r.summary;
        const totalRecords = r.total_records;
        const totalPages = Math.max(1, Math.ceil(totalRecords / limit));
        return {
          data: (r.data ?? []).map((p) => ({
            id: p.id, partyType: p.party_type, name: p.name, phone: p.phone, email: p.email, gstin: p.gstin,
            location: p.location, balance: num(p.balance) ?? 0, balanceKind: 'RECEIVABLE', isActive: true,
          })),
          currentPage: page,
          totalPages,
          totalRecords,
          limit,
          hasNextPage: page < totalPages,
          hasPrevPage: page > 1,
          summary: {
            partiesWithDues: sm.parties_with_dues,
            distributorCount: sm.distributor_count,
            farmerCount: sm.farmer_count,
            distributorDue: num(sm.distributor_due),
            farmerDue: num(sm.farmer_due),
            maxBalance: num(sm.max_balance),
          },
        };
      },

      partyLedger: async (_p, { partyType, partyId, fromDate: fromArg, toDate: toArg }, ctx) => {
        assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN', 'SALES');
        const fromDate = normalizeLedgerDate(fromArg, 'fromDate');
        const toDate = normalizeLedgerDate(toArg, 'toDate');
        if (fromDate && toDate && fromDate > toDate) throw httpError('fromDate cannot be after toDate', 400);

        const raw = []; // { date, type, refNo, description, debit, credit, order }
        let name = '';
        let balanceKind = 'RECEIVABLE';
        let sourceExposure = null;

        if (partyType === 'DISTRIBUTOR') {
          const [party, invoices, payments, notes, sales, salesReturns] = await Promise.all([
            query('SELECT name, outstanding FROM distributors WHERE id=$1', [partyId]),
            query("SELECT invoice_no, invoice_date, total_amount FROM invoices WHERE distributor_id=$1 AND COALESCE(status,'ISSUED') <> 'CANCELLED'", [partyId]),
            query('SELECT amount, method, reference, paid_at FROM payments WHERE distributor_id=$1', [partyId]),
            query('SELECT note_no, note_type, amount, reason, created_at FROM credit_debit_notes WHERE distributor_id=$1', [partyId]),
            query(`${SALE_SELECT} WHERE s.distributor_id=$1`, [partyId]),
            query("SELECT return_no, credit_note_no, total_amount, COALESCE(approved_at::date, return_date) AS dt FROM sales_returns WHERE distributor_id=$1 AND status='APPROVED'", [partyId]),
          ]);
          const d = party.rows[0];
          if (!d) throw httpError('Distributor not found', 404);
          name = d.name;

          invoices.rows.forEach((r) => pushLedgerEntry(raw, { date: r.invoice_date, type: 'INVOICE', refNo: r.invoice_no, description: 'Tax invoice', debit: r.total_amount, credit: 0 }));
          payments.rows.forEach((r) => pushLedgerEntry(raw, { date: r.paid_at, type: 'PAYMENT', refNo: r.reference || r.method, description: `Payment received${r.method ? ` (${r.method})` : ''}`, debit: 0, credit: r.amount }));
          notes.rows.forEach((r) => pushLedgerEntry(raw, { date: r.created_at, type: r.note_type === 'CREDIT' ? 'CREDIT NOTE' : 'DEBIT NOTE', refNo: r.note_no, description: r.reason || (r.note_type === 'CREDIT' ? 'Credit note' : 'Debit note'), debit: r.note_type === 'CREDIT' ? 0 : r.amount, credit: r.note_type === 'CREDIT' ? r.amount : 0 }));
          pushSales(raw, sales);

          // Approved sales returns normally create a credit_debit_notes row. Add
          // legacy returns that do not have that note, without double-counting.
          const noteRefs = new Set(notes.rows.map((r) => r.note_no));
          salesReturns.rows.filter((r) => !r.credit_note_no || !noteRefs.has(r.credit_note_no)).forEach((r) => pushLedgerEntry(raw, {
            date: r.dt, type: 'CREDIT NOTE', refNo: r.credit_note_no || r.return_no,
            description: `Sales return ${r.return_no}`, debit: 0, credit: r.total_amount,
          }));

          const directSalesDue = sales.rows.reduce((sum, r) => sum + (num(r.total_amount) || 0) - (num(r.amount_paid) || 0), 0);
          sourceExposure = (num(d.outstanding) || 0) + directSalesDue;
        } else if (partyType === 'FARMER') {
          const [party, invoices, payments, sales] = await Promise.all([
            query('SELECT name FROM farmers WHERE id=$1', [partyId]),
            query("SELECT invoice_no, invoice_date, total_amount FROM invoices WHERE farmer_id=$1 AND COALESCE(status,'ISSUED') <> 'CANCELLED'", [partyId]),
            query('SELECT amount, method, reference, paid_at FROM payments WHERE farmer_id=$1', [partyId]),
            query(`${SALE_SELECT} WHERE s.farmer_id=$1`, [partyId]),
          ]);
          const f = party.rows[0];
          if (!f) throw httpError('Farmer not found', 404);
          name = f.name;
          invoices.rows.forEach((r) => pushLedgerEntry(raw, { date: r.invoice_date, type: 'INVOICE', refNo: r.invoice_no, description: 'Tax invoice', debit: r.total_amount, credit: 0 }));
          payments.rows.forEach((r) => pushLedgerEntry(raw, { date: r.paid_at, type: 'PAYMENT', refNo: r.reference || r.method, description: `Payment received${r.method ? ` (${r.method})` : ''}`, debit: 0, credit: r.amount }));
          pushSales(raw, sales);
        } else if (partyType === 'VENDOR') {
          balanceKind = 'PAYABLE';
          const [party, bills, payments, returns] = await Promise.all([
            query('SELECT name, outstanding FROM vendors WHERE id=$1', [partyId]),
            query('SELECT internal_no, bill_no, invoice_date, total_amount FROM purchase_invoices WHERE vendor_id=$1', [partyId]),
            query('SELECT amount, method, reference, paid_at FROM vendor_payments WHERE vendor_id=$1', [partyId]),
            query("SELECT return_no, debit_note_no, total_amount, COALESCE(approved_at::date, return_date) AS dt FROM purchase_returns WHERE vendor_id=$1 AND status='APPROVED'", [partyId]),
          ]);
          const v = party.rows[0];
          if (!v) throw httpError('Vendor not found', 404);
          name = v.name;
          bills.rows.forEach((r) => pushLedgerEntry(raw, { date: r.invoice_date, type: 'PURCHASE BILL', refNo: r.bill_no || r.internal_no, description: 'Vendor bill', debit: 0, credit: r.total_amount }));
          payments.rows.forEach((r) => pushLedgerEntry(raw, { date: r.paid_at, type: 'PAYMENT', refNo: r.reference || r.method, description: `Paid to vendor${r.method ? ` (${r.method})` : ''}`, debit: r.amount, credit: 0 }));
          returns.rows.forEach((r) => pushLedgerEntry(raw, { date: r.dt, type: 'PURCHASE RETURN', refNo: r.debit_note_no || r.return_no, description: 'Goods returned to vendor', debit: r.total_amount, credit: 0 }));
          // For a payable, positive exposure means a credit balance (we owe the
          // vendor), which is the same sign used by ledgerDelta(PAYABLE).
          sourceExposure = num(v.outstanding) || 0;
        } else {
          throw httpError('Invalid party type', 400);
        }

        const calculated = calculatePartyLedger({ raw, balanceKind, sourceExposure, fromDate, toDate });
        return { partyId, partyType, name, balanceKind, ...calculated };
      },

      partySales: async (_p, { limit }, ctx) => { assertAuth(ctx); const { rows } = await query(`${SALE_SELECT} ORDER BY s.created_at DESC LIMIT $1`, [limit]); return rows.map(mapSale); },
      partySale: async (_p, { id }, ctx) => { assertAuth(ctx); const { rows } = await query(`${SALE_SELECT} WHERE s.id=$1`, [id]); return mapSale(rows[0]); },
    },

    Mutation: {
      createPartySale: async (_p, { input }, ctx) => {
        const a = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN', 'SALES');
        if (!input.lines?.length) throw httpError('A sale needs at least one line', 400);
        if (!['DISTRIBUTOR', 'FARMER'].includes(input.partyType)) throw httpError('partyType must be DISTRIBUTOR or FARMER', 400);
        return withTransaction(async (client) => {
          const table = input.partyType === 'DISTRIBUTOR' ? 'distributors' : 'farmers';
          if (!(await client.query(`SELECT id FROM ${table} WHERE id=$1`, [input.partyId])).rows[0]) throw httpError('Party not found', 404);
          if (!(await client.query('SELECT id FROM warehouses WHERE id=$1', [input.warehouseId])).rows[0]) throw httpError('Warehouse not found', 404);

          let subTotal = 0, taxTotal = 0;
          const prepared = [];
          const ids = [...new Set(input.lines.map((l) => l.productId))];
          const byId = new Map((await client.query('SELECT id, name, gst_percent, packing_size FROM products WHERE id = ANY($1::uuid[])', [ids])).rows.map((p) => [p.id, p]));
          for (const l of input.lines) {
            const p = byId.get(l.productId);
            if (!p) throw httpError('Product not found', 404);
            // quantity / unit_price are NUMERIC(…,2): compute on the values that get stored.
            const quantity = round2(l.quantity), unitPrice = round2(l.unitPrice);
            if (!(quantity > 0)) throw httpError(`Quantity for ${p.name} must be greater than 0`, 400);
            if (!(unitPrice >= 0)) throw httpError(`Price for ${p.name} cannot be negative`, 400);
            const lineTotal = round2(quantity * unitPrice);
            const gst = num(p.gst_percent ?? 0);
            subTotal += lineTotal; taxTotal += round2(lineTotal * gst / 100);
            prepared.push({ l: { ...l, quantity, unitPrice }, name: p.name, pack: p.packing_size ?? null, gst, lineTotal });
          }
          subTotal = round2(subTotal); taxTotal = round2(taxTotal);
          const total = round2(subTotal + taxTotal);
          const paid = Math.min(Math.max(round2(input.amountPaid ?? 0), 0), total);

          // FIFO stock-out per line (prefer named batch, else by expiry) with negative-stock prevention.
          const saleNo = `PS-${fy()}-${String((await client.query("SELECT nextval('psale_seq') n")).rows[0].n).padStart(5, '0')}`;
          const sale = (await client.query(
            `INSERT INTO party_sales (sale_no, party_type, distributor_id, farmer_id, warehouse_id, sub_total, tax_total, total_amount, amount_paid, payment_method, notes, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
            [saleNo, input.partyType, input.partyType === 'DISTRIBUTOR' ? input.partyId : null, input.partyType === 'FARMER' ? input.partyId : null,
              input.warehouseId, subTotal, taxTotal, total, paid, input.paymentMethod ?? null, input.notes ?? null, a.sub],
          )).rows[0];

          for (const { l, name, pack, gst, lineTotal } of prepared) {
            let remaining = l.quantity;
            const stock = (await client.query(
              `SELECT sl.*, b.batch_number FROM stock_levels sl JOIN batches b ON b.id = sl.batch_id
               WHERE sl.product_id=$1 AND sl.warehouse_id=$2 AND sl.quantity>0
               ORDER BY (b.batch_number = $3) DESC, b.expiry_date ASC NULLS LAST FOR UPDATE`,
              [l.productId, input.warehouseId, l.batchNumber?.trim() ?? ''],
            )).rows;
            const avail = stock.reduce((s, r) => s + num(r.quantity), 0);
            if (avail < remaining) throw httpError(`Insufficient stock for ${name} in this warehouse: need ${remaining}, have ${avail}`, 400);
            for (const sl of stock) {
              if (remaining <= 0) break;
              const take = Math.min(num(sl.quantity), remaining);
              await client.query('UPDATE stock_levels SET quantity = quantity - $2, updated_at=now() WHERE id=$1', [sl.id, take]);
              await client.query(
                `INSERT INTO stock_movements (warehouse_id, product_id, batch_id, movement_type, quantity, reason, ref_type, ref_id, created_by)
                 VALUES ($1,$2,$3,'OUT',$4,'Direct party sale','party_sale',$5,$6)`,
                [input.warehouseId, l.productId, sl.batch_id, -take, sale.id, a.sub],
              );
              remaining -= take;
            }
            await client.query(
              `INSERT INTO party_sale_lines (sale_id, product_id, product_name, packing_size, batch_number, quantity, unit_price, gst_percent, line_total)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
              [sale.id, l.productId, name, pack, l.batchNumber || null, l.quantity, l.unitPrice, gst, lineTotal],
            );
          }
          // Auto-generate a CRM lead when a farmer buys — a fresh upsell/follow-up
          // opportunity. Skip if the farmer already has an open lead, so the
          // pipeline doesn't flood with one lead per purchase.
          if (input.partyType === 'FARMER') {
            const hasOpen = (await client.query(
              "SELECT 1 FROM crm_leads WHERE farmer_id=$1 AND status IN ('NEW','CONTACTED') LIMIT 1",
              [input.partyId],
            )).rows[0];
            if (!hasOpen) {
              const crops = (await client.query('SELECT crops FROM farmers WHERE id=$1', [input.partyId])).rows[0]?.crops ?? [];
              const leadNo = `LEAD-${String((await client.query("SELECT nextval('lead_seq') n")).rows[0].n).padStart(5, '0')}`;
              await client.query(
                `INSERT INTO crm_leads (lead_no, farmer_id, crop, disease, product_ids, prior_purchase, notes)
                 VALUES ($1,$2,$3,NULL,$4,TRUE,$5)`,
                [leadNo, input.partyId, crops[0] ?? null, prepared.map((p) => p.l.productId), `Auto-created from direct sale ${saleNo}`],
              );
            }
          }
          void logActivity(a.sub, 'CREATE_PARTY_SALE', 'party_sale', sale.id, { saleNo, party: input.partyType });
          return mapSale((await client.query(`${SALE_SELECT} WHERE s.id=$1`, [sale.id])).rows[0]);
        });
      },
    },

    PartySale: {
      itemCount: async (parent) => (await query('SELECT COUNT(*)::int n FROM party_sale_lines WHERE sale_id=$1', [parent.id])).rows[0].n,
      lines: async (parent) => {
        const { rows } = await query('SELECT * FROM party_sale_lines WHERE sale_id=$1 ORDER BY product_name', [parent.id]);
        return rows.map((r) => ({ id: r.id, productId: r.product_id, productName: r.product_name, packingSize: r.packing_size ?? null, batchNumber: r.batch_number, quantity: num(r.quantity), unitPrice: num(r.unit_price), gstPercent: num(r.gst_percent), lineTotal: num(r.line_total) }));
      },
    },
  };
}

// Push a party_sales result set into the ledger as a DIRECT SALE (debit) + optional SALE PAYMENT (credit).
function pushSales(raw, res) {
  for (const r of res.rows) {
    pushLedgerEntry(raw, { date: r.sale_date, type: 'DIRECT SALE', refNo: r.sale_no, description: 'Direct sale', debit: r.total_amount, credit: 0 });
    if (num(r.amount_paid) > 0) pushLedgerEntry(raw, { date: r.sale_date, type: 'SALE PAYMENT', refNo: r.sale_no, description: `Paid at sale${r.payment_method ? ` (${r.payment_method})` : ''}`, debit: 0, credit: r.amount_paid });
  }
}
