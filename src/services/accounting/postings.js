// ─────────────────────────────────────────────────────────────────────────────
// DERIVED POSTINGS — the double-entry lines for every commerce document, built
// at READ time from the transaction tables (single source of truth: nothing is
// synced or stored, so the books can never drift from invoices/bills/payments).
//
// postingsSql(from, to) returns one SELECT (UNION ALL of rule branches + manual
// voucher lines) with the columns:
//   voucher_key  'invoice:<uuid>' | 'payment:<uuid>' | … | 'voucher:<uuid>'
//   voucher_type Sales | Receipt | Purchase | Payment | Credit Note | Debit Note | Journal | Contra
//   voucher_no, voucher_date (DATE), source_type, source_id, doc_id (drill target), narration
//   ord          line order inside the voucher
//   ledger_key   system code (CASH, SALES_GST…) | acc_ledgers.id | DISTRIBUTOR:/FARMER:/VENDOR:<uuid>
//   amt          signed amount: + Dr / − Cr   (every voucher sums to 0)
//
// Each rule lists its lines as signed amounts and closes with a ROUND_OFF line
// = −(sum of the others), so a derived voucher balances to the paisa by
// construction (a stored total that disagrees with its parts lands in Round Off).
// `from`/`to` are SQL expressions (e.g. '$1', 'NULL') bound per branch so the
// date indexes on each source table are usable.
//
// ponytail: not a DB VIEW on purpose — a view would pin the column types of
// eight tables other modules own (ALTER COLUMN TYPE fails on viewed columns).
// ─────────────────────────────────────────────────────────────────────────────

const lo = (from) => `COALESCE(${from}::date, '-infinity'::date)`;

/** Branch filter for a DATE column. */
const onDate = (col, from, to) => `${col} >= ${lo(from)} AND ${col} <= ${to}::date`;
/** Branch filter for a TIMESTAMPTZ column, equal to `col::date BETWEEN from AND to` but index-friendly. */
const onTs = (col, from, to) => `${col} >= ${lo(from)}::timestamptz AND ${col} < (${to}::date + 1)::timestamptz`;

const CASH_OR_BANK = (method) => `CASE WHEN upper(trim(COALESCE(${method}, ''))) = 'CASH' THEN 'CASH' ELSE 'BANK' END`;
const INTERSTATE = (partyState) =>
  `(co.state IS NOT NULL AND ${partyState} IS NOT NULL AND lower(trim(co.state)) <> lower(trim(${partyState})))`;

/**
 * Rule table (mirrored in architecture/ACCOUNTING.md). Each entry is a SQL
 * branch producing (voucher header…, ord, ledger_key, amt).
 */
export function postingsSql(from, to) {
  const b = [];

  // 1. Sales invoice / bill of supply: Dr Party · Cr Sales · Cr Output GST · ±Round Off
  b.push(`
    SELECT 'invoice:' || i.id AS voucher_key, 'Sales'::text AS voucher_type, i.invoice_no AS voucher_no, i.invoice_date AS voucher_date,
           'invoice'::text AS source_type, i.id AS source_id, i.id AS doc_id,
           (CASE WHEN i.bill_type = 'NON_GST' THEN 'Bill of supply' ELSE 'Tax invoice' END)::text AS narration, x.ord, x.ledger_key, x.amt
    FROM invoices i
    CROSS JOIN LATERAL (VALUES
      (1, COALESCE(CASE WHEN i.customer_type = 'FARMER' THEN 'FARMER:' || i.farmer_id ELSE 'DISTRIBUTOR:' || i.distributor_id END, 'SUSPENSE'), i.total_amount),
      (2, CASE WHEN i.bill_type = 'NON_GST' THEN 'SALES_NONGST' ELSE 'SALES_GST' END, -i.taxable_value),
      (3, 'OUTPUT_CGST', -i.cgst), (4, 'OUTPUT_SGST', -i.sgst), (5, 'OUTPUT_IGST', -i.igst),
      (9, 'ROUND_OFF', i.taxable_value + i.cgst + i.sgst + i.igst - i.total_amount)
    ) x(ord, ledger_key, amt)
    WHERE i.status <> 'CANCELLED' AND ${onDate('i.invoice_date', from, to)}`);

  // 2. Customer receipt (payments): Dr Cash/Bank · Cr Party
  b.push(`
    SELECT 'payment:' || p.id, 'Receipt', 'RCT-' || upper(left(replace(p.id::text, '-', ''), 8)), p.paid_at::date,
           'payment', p.id, COALESCE(p.invoice_id, p.id),
           concat_ws(' · ', 'Received' || COALESCE(' via ' || NULLIF(p.method, ''), ''), 'against ' || i.invoice_no, NULLIF(p.reference, '')),
           x.ord, x.ledger_key, x.amt
    FROM payments p LEFT JOIN invoices i ON i.id = p.invoice_id
    CROSS JOIN LATERAL (VALUES
      (1, ${CASH_OR_BANK('p.method')}, p.amount),
      -- same party the invoice debited (a farmer invoice may also carry a distributor)
      (2, COALESCE(CASE WHEN i.customer_type = 'FARMER' THEN 'FARMER:' || i.farmer_id END,
                   'DISTRIBUTOR:' || p.distributor_id, 'FARMER:' || p.farmer_id, 'SUSPENSE'), -p.amount)
    ) x(ord, ledger_key, amt)
    WHERE ${onTs('p.paid_at', from, to)}`);

  // 3. Direct party sale (Parties page): Dr Party · Cr Sales · Cr Output GST (split by party state)
  b.push(`
    SELECT 'party_sale:' || s.id, 'Sales', s.sale_no, s.sale_date, 'party_sale', s.id, s.id, 'Direct sale',
           x.ord, x.ledger_key, x.amt
    FROM party_sales s
    LEFT JOIN distributors d ON d.id = s.distributor_id
    LEFT JOIN farmers f ON f.id = s.farmer_id
    LEFT JOIN company_settings co ON co.id = 1
    CROSS JOIN LATERAL (SELECT ${INTERSTATE('COALESCE(d.state, f.state)')} AS inter, round(s.tax_total / 2, 2) AS half) k
    CROSS JOIN LATERAL (VALUES
      (1, COALESCE(CASE WHEN s.party_type = 'FARMER' THEN 'FARMER:' || s.farmer_id ELSE 'DISTRIBUTOR:' || s.distributor_id END, 'SUSPENSE'), s.total_amount),
      (2, CASE WHEN s.tax_total > 0 THEN 'SALES_GST' ELSE 'SALES_NONGST' END, -s.sub_total),
      (3, 'OUTPUT_CGST', CASE WHEN k.inter THEN 0 ELSE -k.half END),
      (4, 'OUTPUT_SGST', CASE WHEN k.inter THEN 0 ELSE -(s.tax_total - k.half) END),
      (5, 'OUTPUT_IGST', CASE WHEN k.inter THEN -s.tax_total ELSE 0 END),
      (9, 'ROUND_OFF', s.sub_total + s.tax_total - s.total_amount)
    ) x(ord, ledger_key, amt)
    WHERE ${onDate('s.sale_date', from, to)}`);

  // 4. Amount collected at the time of a party sale: Dr Cash/Bank · Cr Party
  b.push(`
    SELECT 'party_sale_rcpt:' || s.id, 'Receipt', s.sale_no, s.sale_date, 'party_sale', s.id, s.id,
           'Paid at sale' || COALESCE(' via ' || NULLIF(s.payment_method, ''), ''),
           x.ord, x.ledger_key, x.amt
    FROM party_sales s
    CROSS JOIN LATERAL (VALUES
      (1, ${CASH_OR_BANK('s.payment_method')}, s.amount_paid),
      (2, COALESCE(CASE WHEN s.party_type = 'FARMER' THEN 'FARMER:' || s.farmer_id ELSE 'DISTRIBUTOR:' || s.distributor_id END, 'SUSPENSE'), -s.amount_paid)
    ) x(ord, ledger_key, amt)
    WHERE s.amount_paid > 0 AND ${onDate('s.sale_date', from, to)}`);

  // 5. Credit / debit note to a customer (incl. sales-return credit notes):
  //    CN: Dr Sales Returns (or Discount for reason 02) · Dr Output GST · Cr Party
  //    DN: Dr Party · Cr Sales · Cr Output GST
  b.push(`
    SELECT 'note:' || n.id, CASE WHEN n.note_type = 'CREDIT' THEN 'Credit Note' ELSE 'Debit Note' END, n.note_no, n.created_at::date,
           CASE WHEN n.note_type = 'CREDIT' THEN 'credit_note' ELSE 'debit_note' END, n.id, n.id,
           COALESCE(NULLIF(n.reason, ''), CASE WHEN n.note_type = 'CREDIT' THEN 'Credit note' ELSE 'Debit note' END),
           x.ord, x.ledger_key, x.amt
    FROM credit_debit_notes n
    CROSS JOIN LATERAL (SELECT CASE WHEN n.note_type = 'CREDIT' THEN 1 ELSE -1 END AS sg,
                               COALESCE(n.taxable_value, n.amount - n.cgst - n.sgst - n.igst) AS tv) k
    CROSS JOIN LATERAL (VALUES
      (1, 'DISTRIBUTOR:' || n.distributor_id, -k.sg * n.amount),
      (2, CASE WHEN n.note_type = 'CREDIT' THEN (CASE WHEN n.note_reason = '02' THEN 'DISCOUNT' ELSE 'SALES_RETURNS' END)
               WHEN n.cgst + n.sgst + n.igst > 0 THEN 'SALES_GST' ELSE 'SALES_NONGST' END, k.sg * k.tv),
      (3, 'OUTPUT_CGST', k.sg * n.cgst), (4, 'OUTPUT_SGST', k.sg * n.sgst), (5, 'OUTPUT_IGST', k.sg * n.igst),
      (9, 'ROUND_OFF', -k.sg * (k.tv + n.cgst + n.sgst + n.igst - n.amount))
    ) x(ord, ledger_key, amt)
    WHERE ${onTs('n.created_at', from, to)}`);

  // 6. Legacy approved sales return with no credit-note row: Dr Sales Returns · Dr Output GST · Cr Party
  b.push(`
    SELECT 'sales_return:' || r.id, 'Credit Note', COALESCE(r.credit_note_no, r.return_no), COALESCE(r.approved_at::date, r.return_date),
           'sales_return', r.id, r.id, 'Sales return ' || r.return_no,
           x.ord, x.ledger_key, x.amt
    FROM sales_returns r
    CROSS JOIN LATERAL (SELECT round(r.tax_total / 2, 2) AS half) k
    CROSS JOIN LATERAL (VALUES
      (1, 'DISTRIBUTOR:' || r.distributor_id, -r.total_amount),
      (2, 'SALES_RETURNS', r.sub_total),
      (3, 'OUTPUT_CGST', k.half), (4, 'OUTPUT_SGST', r.tax_total - k.half),
      (9, 'ROUND_OFF', r.total_amount - r.sub_total - r.tax_total)
    ) x(ord, ledger_key, amt)
    WHERE r.status = 'APPROVED' AND r.total_amount > 0
      AND NOT EXISTS (SELECT 1 FROM credit_debit_notes n WHERE n.note_no = r.credit_note_no)
      AND COALESCE(r.approved_at::date, r.return_date) BETWEEN ${lo(from)} AND ${to}::date`);

  // 7. Purchase bill: Dr Purchase · Dr Input GST (ITC; expensed when INELIGIBLE) · Cr Vendor · Cr RCM payable
  //    Legacy bills with only tax_value split by is_interstate.
  b.push(`
    SELECT 'purchase_invoice:' || pi.id, 'Purchase', pi.internal_no, pi.invoice_date, 'purchase_invoice', pi.id, pi.id,
           'Vendor bill ' || pi.bill_no || CASE WHEN pi.is_rcm THEN ' (reverse charge)' ELSE '' END,
           x.ord, x.ledger_key, x.amt
    FROM purchase_invoices pi
    CROSS JOIN LATERAL (SELECT (pi.igst + pi.cgst + pi.sgst = 0 AND pi.tax_value > 0) AS legacy,
                               COALESCE(pi.itc_eligibility, 'ELIGIBLE') <> 'INELIGIBLE' AS itc) l
    CROSS JOIN LATERAL (SELECT
        CASE WHEN NOT l.legacy THEN pi.igst WHEN pi.is_interstate THEN pi.tax_value ELSE 0 END AS ig,
        CASE WHEN NOT l.legacy THEN pi.cgst WHEN pi.is_interstate THEN 0 ELSE round(pi.tax_value / 2, 2) END AS cg,
        CASE WHEN NOT l.legacy THEN pi.sgst WHEN pi.is_interstate THEN 0 ELSE pi.tax_value - round(pi.tax_value / 2, 2) END AS sg) t
    CROSS JOIN LATERAL (SELECT t.ig + t.cg + t.sg AS tax) tt
    CROSS JOIN LATERAL (VALUES
      (1, 'VENDOR:' || pi.vendor_id, -pi.total_amount),
      (2, 'PURCHASE', pi.taxable_value + CASE WHEN l.itc THEN 0 ELSE tt.tax END),
      (3, 'INPUT_CGST', CASE WHEN l.itc THEN t.cg ELSE 0 END),
      (4, 'INPUT_SGST', CASE WHEN l.itc THEN t.sg ELSE 0 END),
      (5, 'INPUT_IGST', CASE WHEN l.itc THEN t.ig ELSE 0 END),
      (6, 'RCM_PAYABLE', CASE WHEN pi.is_rcm THEN -tt.tax ELSE 0 END),
      (9, 'ROUND_OFF', pi.total_amount - pi.taxable_value - tt.tax + CASE WHEN pi.is_rcm THEN tt.tax ELSE 0 END)
    ) x(ord, ledger_key, amt)
    WHERE ${onDate('pi.invoice_date', from, to)}`);

  // 8. Vendor payment: Dr Vendor · Cr Cash/Bank
  b.push(`
    SELECT 'vendor_payment:' || vp.id, 'Payment', 'PMT-' || upper(left(replace(vp.id::text, '-', ''), 8)), vp.paid_at::date,
           'vendor_payment', vp.id, COALESCE(vp.purchase_invoice_id, vp.id),
           concat_ws(' · ', 'Paid' || COALESCE(' via ' || NULLIF(vp.method, ''), ''), 'against ' || pi.bill_no, NULLIF(vp.reference, '')),
           x.ord, x.ledger_key, x.amt
    FROM vendor_payments vp LEFT JOIN purchase_invoices pi ON pi.id = vp.purchase_invoice_id
    CROSS JOIN LATERAL (VALUES
      (1, 'VENDOR:' || vp.vendor_id, vp.amount),
      (2, ${CASH_OR_BANK('vp.method')}, -vp.amount)
    ) x(ord, ledger_key, amt)
    WHERE ${onTs('vp.paid_at', from, to)}`);

  // 9. Approved purchase return (debit note): Dr Vendor · Cr Purchase Returns · Cr Input GST
  b.push(`
    SELECT 'purchase_return:' || r.id, 'Debit Note', COALESCE(r.debit_note_no, r.return_no), COALESCE(r.approved_at::date, r.return_date),
           'purchase_return', r.id, r.id, 'Purchase return ' || r.return_no,
           x.ord, x.ledger_key, x.amt
    FROM purchase_returns r
    LEFT JOIN vendors v ON v.id = r.vendor_id
    LEFT JOIN company_settings co ON co.id = 1
    CROSS JOIN LATERAL (SELECT COALESCE((SELECT pi.is_interstate FROM purchase_invoices pi WHERE pi.po_id = r.po_id LIMIT 1),
                                        ${INTERSTATE('v.state')}) AS inter,
                               round(r.tax_total / 2, 2) AS half) k
    CROSS JOIN LATERAL (VALUES
      (1, 'VENDOR:' || r.vendor_id, r.total_amount),
      (2, 'PURCHASE_RETURNS', -r.sub_total),
      (3, 'INPUT_CGST', CASE WHEN k.inter THEN 0 ELSE -k.half END),
      (4, 'INPUT_SGST', CASE WHEN k.inter THEN 0 ELSE -(r.tax_total - k.half) END),
      (5, 'INPUT_IGST', CASE WHEN k.inter THEN -r.tax_total ELSE 0 END),
      (9, 'ROUND_OFF', r.sub_total + r.tax_total - r.total_amount)
    ) x(ord, ledger_key, amt)
    WHERE r.status = 'APPROVED' AND COALESCE(r.approved_at::date, r.return_date) BETWEEN ${lo(from)} AND ${to}::date`);

  // 10. Manual vouchers (Payment/Receipt/Contra/Journal/…), active only.
  b.push(`
    SELECT 'voucher:' || v.id, initcap(replace(v.voucher_type, '_', ' ')), v.voucher_no, v.voucher_date,
           'voucher', v.id, v.id, COALESCE(NULLIF(l.narration, ''), v.narration),
           l.line_no, l.ledger_key, l.dr - l.cr
    FROM acc_vouchers v JOIN acc_voucher_lines l ON l.voucher_id = v.id
    WHERE v.status = 'ACTIVE' AND ${onDate('v.voucher_date', from, to)}`);

  return `SELECT * FROM (${b.join('\n    UNION ALL')}\n  ) raw WHERE amt <> 0`;
}

/** Ledger keys of the seeded system ledgers the rules above post to. */
export const SYSTEM_CODES = [
  'CASH', 'BANK', 'SALES_GST', 'SALES_NONGST', 'SALES_RETURNS', 'PURCHASE', 'PURCHASE_RETURNS',
  'OUTPUT_CGST', 'OUTPUT_SGST', 'OUTPUT_IGST', 'INPUT_CGST', 'INPUT_SGST', 'INPUT_IGST',
  'RCM_PAYABLE', 'ROUND_OFF', 'DISCOUNT', 'SUSPENSE',
];
