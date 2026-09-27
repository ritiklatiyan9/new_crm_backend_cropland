// GraphQL module: GST Returns — GSTR-1 (outward supplies) + GSTR-3B (summary)
// generated from books (invoices / order_lines / credit_debit_notes), plus the
// E-Way Bill register. Produces both on-screen sections and portal-ready JSON
// in the GSTN offline-tool shape so it can be uploaded directly to gst.gov.in.

import { buildGstDrilldown } from './gstDrilldown.js';
import { query, withTransaction } from '../../db/index.js';
import { assertRole } from '../context.js';
import { num, isoDate, logActivity } from '../helpers.js';
import { resolveStateCode, stateCodeFromGstin, stateCodeFromName, stateName } from '../../services/gst/stateCodes.js';
import {
  roundGst, zeroAmt, addAmt as addAmtCalc, roundAmt as roundAmtCalc, splitTax,
  computeCdnTax, B2CL_THRESHOLD, netLiability, utiliseItc, interest88B, lateFee,
} from '../../services/gst/calc.js';
import { statutoryQty } from '../../services/units.js';
import { validatePayload } from '../../services/gst/validate.js';
import { gstProvider, getGstProviderName } from '../../services/gst/index.js';

const GSTR1_VERSION = 'GST3.0.4';

export const gstReturnsTypeDefs = /* GraphQL */ `
  type GstTaxAmt { taxable: Float!, igst: Float!, cgst: Float!, sgst: Float!, cess: Float!, total: Float! }

  type Gstr1B2bRow { ctin: String!, tradeName: String, invoiceNo: String!, invoiceDate: String!, pos: String, posName: String, invoiceValue: Float!, reverseCharge: String!, invoiceType: String!, rate: Float!, taxable: Float!, igst: Float!, cgst: Float!, sgst: Float!, cess: Float!, total: Float! }
  type Gstr1B2clRow { pos: String!, posName: String, invoiceNo: String!, invoiceDate: String!, invoiceValue: Float!, rate: Float!, taxable: Float!, igst: Float!, cess: Float!, total: Float! }
  type Gstr1B2csRow { supplyType: String!, pos: String!, posName: String, rate: Float!, taxable: Float!, igst: Float!, cgst: Float!, sgst: Float!, cess: Float!, total: Float! }
  type Gstr1CdnrRow { ctin: String!, tradeName: String, noteNo: String!, noteDate: String!, noteType: String!, refInvoiceNo: String, pos: String, posName: String, rate: Float!, taxable: Float!, igst: Float!, cgst: Float!, sgst: Float!, cess: Float!, total: Float! }
  type Gstr1HsnRow { supplyType: String!, hsnCode: String, description: String, uqc: String!, qty: Float!, rate: Float!, taxable: Float!, igst: Float!, cgst: Float!, sgst: Float!, cess: Float!, total: Float! }
  type Gstr1DocRow { docNum: Int!, docType: String!, fromNo: String, toNo: String, totalCount: Int!, cancelled: Int!, net: Int! }

  type Gstr1Report {
    period: String!
    periodLabel: String!
    gstin: String
    fromDate: String!
    toDate: String!
    generatedAt: DateTime!
    totals: GstTaxAmt!
    counts: JSON!
    b2b: [Gstr1B2bRow!]!
    b2cl: [Gstr1B2clRow!]!
    b2cs: [Gstr1B2csRow!]!
    cdnr: [Gstr1CdnrRow!]!
    hsn: [Gstr1HsnRow!]!
    docs: [Gstr1DocRow!]!
  }

  type Gstr3bLine { code: String!, label: String!, taxable: Float!, igst: Float!, cgst: Float!, sgst: Float!, cess: Float!, total: Float! }
  type Gstr3bPosRow { pos: String!, posName: String, supplyType: String!, taxable: Float!, igst: Float! }
  type Gstr3bReport {
    period: String!
    periodLabel: String!
    gstin: String
    fromDate: String!
    toDate: String!
    generatedAt: DateTime!
    itcSource: String!
    outward: [Gstr3bLine!]!
    interstateSupplies: [Gstr3bPosRow!]!
    itc: [Gstr3bLine!]!
    taxPayable: Gstr3bLine!
    itcAvailed: Gstr3bLine!
    challanPaid: Gstr3bLine!
    netPayable: Gstr3bLine!
    interest: Gstr3bLine!
    lateFee: Float!
  }

  type EWayBillRow {
    id: ID!, invoiceId: ID!, invoiceNo: String, invoiceDate: String, distributorName: String, gstin: String,
    ewbNo: String, ewbDate: DateTime, validUntil: DateTime, distanceKm: Int, transportMode: String,
    vehicleNo: String, transporterId: String, status: String!, totalAmount: Float
  }

  type GstPeriodOption { period: String!, label: String!, invoiceCount: Int! }
  type GstReturnLog { id: ID!, returnType: String!, period: String!, status: String!, createdAt: DateTime! }
  type GstValidation { valid: Boolean!, errors: [String!]!, warnings: [String!]! }

  extend type Query {
    gstTransactionDetails(period: String!, report: String!, section: String, filters: JSON): JSON!
    gstr1Report(period: String!): Gstr1Report!
    gstr1PortalJson(period: String!): JSON!
    gstr3bReport(period: String!): Gstr3bReport!
    gstr3bPortalJson(period: String!): JSON!
    ewayBillRegister(dateFrom: String, dateTo: String): [EWayBillRow!]!
    gstPeriods(limit: Int = 12): [GstPeriodOption!]!
    gstReturnLogs: [GstReturnLog!]!
    validateGstReturn(returnType: String!, period: String!): GstValidation!
    gstFilingProvider: String!
  }

  extend type Mutation {
    saveGstReturn(returnType: String!, period: String!): GstReturnLog!
    markGstReturnFiled(returnType: String!, period: String!, filedRef: String!): GstReturnLog!
    fileGstReturn(returnType: String!, period: String!): GstReturnLog!
  }
`;

const guard = (ctx) => assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN', 'SALES');
const round2 = roundGst;                 // central GST rounding (see services/gst/calc.js)
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Parse a GST period key 'MMYYYY' into a concrete date range + display label. */
function parsePeriod(period) {
  const p = String(period || '').trim();
  if (!/^\d{6}$/.test(p)) throw Object.assign(new Error('Period must be MMYYYY (e.g. 062026)'), { statusCode: 400 });
  const mm = Number(p.slice(0, 2));
  const yyyy = Number(p.slice(2));
  if (mm < 1 || mm > 12) throw Object.assign(new Error('Invalid month in period'), { statusCode: 400 });
  const from = `${yyyy}-${String(mm).padStart(2, '0')}-01`;
  const lastDay = new Date(Date.UTC(yyyy, mm, 0)).getUTCDate();
  const to = `${yyyy}-${String(mm).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
  return { period: p, from, to, label: `${MONTHS[mm - 1]} ${yyyy}` };
}

/** dd-mm-yyyy for portal JSON. */
function dmy(d) {
  const iso = isoDate(d);
  if (!iso) return null;
  const [y, m, day] = iso.split('-');
  return `${day}-${m}-${y}`;
}

const emptyAmt = zeroAmt;       // from services/gst/calc.js
const addAmt = addAmtCalc;
const roundAmt = roundAmtCalc;

async function companyState() {
  const c = (await query('SELECT gstin, state FROM company_settings WHERE id = 1')).rows[0] || {};
  return { gstin: c.gstin || null, stateCode: resolveStateCode({ gstin: c.gstin, stateName: c.state }) };
}

// Share of a line's value left after the order's bill-level discount (spread pro-rata,
// exactly as orders.priceOrder charges GST on the post-discount value).
const DISC_FACTOR = `CASE WHEN o.sub_total > 0 THEN (o.sub_total - o.discount_total) / o.sub_total ELSE 1 END`;

/** Push rounding residue (≤ ₹1) onto the largest item so items reconcile to the invoice header. */
function reconcileToHeader(items, key, headerValue) {
  if (!items.length) return;
  const diff = round2(headerValue - items.reduce((a, it) => a + it[key], 0));
  if (diff !== 0 && Math.abs(diff) <= 1) {
    const big = items.reduce((m, it) => (it.taxable > m.taxable ? it : m), items[0]);
    big[key] = round2(big[key] + diff);
  }
}

/**
 * Load every GST tax invoice in the period with recipient details and a
 * rate-wise tax split derived from its order lines (net of bill-level discount).
 */
async function loadInvoiceLines(from, to, supplierStateCode) {
  const { rows: heads } = await query(
    `SELECT i.id, i.invoice_no, i.invoice_date, i.order_id, i.is_interstate, i.place_of_supply,
            i.taxable_value, i.cgst, i.sgst, i.igst, i.total_amount, i.customer_type, i.status,
            d.name d_name, d.gstin d_gstin, d.state d_state,
            f.name f_name, f.state f_state
     FROM invoices i
     LEFT JOIN distributors d ON d.id = i.distributor_id
     LEFT JOIN farmers f ON f.id = i.farmer_id
     WHERE i.bill_type = 'GST' AND i.status <> 'CANCELLED'
       AND i.invoice_date >= $1 AND i.invoice_date <= $2
     ORDER BY i.invoice_date, i.invoice_no`,
    [from, to],
  );
  if (heads.length === 0) return [];

  const orderIds = heads.map((h) => h.order_id);
  const { rows: lines } = await query(
    `SELECT ol.order_id, ol.gst_percent rate,
            SUM(ol.line_total * ${DISC_FACTOR}) taxable,
            SUM(ROUND(ol.line_total * ${DISC_FACTOR} * ol.gst_percent / 100, 2)) tax
     FROM order_lines ol JOIN orders o ON o.id = ol.order_id
     WHERE ol.order_id = ANY($1::uuid[])
     GROUP BY ol.order_id, ol.gst_percent`,
    [orderIds],
  );
  const byOrder = new Map();
  for (const l of lines) {
    if (!byOrder.has(l.order_id)) byOrder.set(l.order_id, []);
    byOrder.get(l.order_id).push({ rate: num(l.rate) ?? 0, taxable: round2(num(l.taxable) || 0), tax: round2(num(l.tax) || 0) });
  }

  return heads.map((h) => {
    const gstin = h.customer_type === 'DISTRIBUTOR' && h.d_gstin ? h.d_gstin : null;
    const recipientStateName = h.customer_type === 'DISTRIBUTOR' ? h.d_state : h.f_state;
    // POS: the place of supply frozen on the invoice (it decided IGST vs CGST+SGST) → GSTIN state → party state.
    const pos = stateCodeFromName(h.place_of_supply) || stateCodeFromGstin(gstin) || stateCodeFromName(recipientStateName) || supplierStateCode;
    const interstate = h.is_interstate != null ? h.is_interstate : pos !== supplierStateCode;
    const headerTax = num(h.cgst) + num(h.sgst) + num(h.igst);
    const headerTaxable = num(h.taxable_value) || 0;
    let rateLines = byOrder.get(h.order_id) || [];
    if (rateLines.length === 0) {
      // Fall back to the invoice header if order lines are missing.
      rateLines = [{ rate: headerTaxable > 0 ? round2((headerTax / headerTaxable) * 100) : 0, taxable: headerTaxable, tax: headerTax }];
    }
    reconcileToHeader(rateLines, 'taxable', headerTaxable);
    reconcileToHeader(rateLines, 'tax', headerTax);
    const itms = rateLines.map((rl) => {
      const half = round2(rl.tax / 2);
      return {
        rate: rl.rate,
        taxable: rl.taxable,
        igst: interstate ? rl.tax : 0,
        cgst: interstate ? 0 : half,
        sgst: interstate ? 0 : round2(rl.tax - half),
        cess: 0,
        total: round2(rl.taxable + rl.tax),
      };
    });
    return {
      id: h.id,
      invoiceNo: h.invoice_no,
      invoiceDate: isoDate(h.invoice_date),
      invoiceValue: num(h.total_amount) || 0,
      gstin,
      tradeName: h.customer_type === 'DISTRIBUTOR' ? h.d_name : h.f_name,
      pos,
      interstate,
      itms,
    };
  });
}

/**
 * Credit/debit notes issued in the period. Registered recipients (ctin set) go to
 * GSTR-1 CDNR; notes to unregistered recipients are netted into B2CS.
 * Uses captured tax (taxable_value/gst_rate/heads) when present; else derives a
 * blended rate from the linked invoice (legacy fallback) — see calc.computeCdnTax.
 */
async function loadNotes(from, to, supplierStateCode) {
  const { rows: notes } = await query(
    `SELECT n.note_no, n.note_type, n.amount, n.created_at,
            n.taxable_value, n.gst_rate, n.cgst, n.sgst, n.igst, n.is_interstate,
            d.name d_name, NULLIF(d.gstin, '') d_gstin, d.state d_state,
            ri.invoice_no ref_no, ri.place_of_supply ri_pos, ri.is_interstate ri_inter, ri.taxable_value ri_tax, ri.cgst ri_cgst, ri.sgst ri_sgst, ri.igst ri_igst
     FROM credit_debit_notes n
     JOIN distributors d ON d.id = n.distributor_id
     LEFT JOIN invoices ri ON ri.id = n.ref_invoice_id
     WHERE n.created_at >= $1::date AND n.created_at < $2::date + 1
     ORDER BY n.created_at`,
    [from, to],
  );
  return notes.map((n) => {
    const hasCaptured = n.taxable_value != null;
    const t = computeCdnTax({
      amount: num(n.amount) || 0,
      taxable: hasCaptured ? num(n.taxable_value) : null,
      rate: hasCaptured ? num(n.gst_rate) : null,
      cgst: hasCaptured ? num(n.cgst) : null, sgst: hasCaptured ? num(n.sgst) : null, igst: hasCaptured ? num(n.igst) : null,
      refInterstate: hasCaptured ? !!n.is_interstate : !!n.ri_inter,
      refTaxable: num(n.ri_tax) || 0, refTaxTotal: num(n.ri_cgst) + num(n.ri_sgst) + num(n.ri_igst),
    });
    const pos = stateCodeFromName(n.ri_pos) || stateCodeFromGstin(n.d_gstin) || stateCodeFromName(n.d_state) || supplierStateCode;
    return {
      interstate: t.igst > 0 || (hasCaptured ? !!n.is_interstate : !!n.ri_inter),
      ctin: n.d_gstin, tradeName: n.d_name, noteNo: n.note_no, noteDate: isoDate(n.created_at),
      noteType: n.note_type === 'CREDIT' ? 'C' : 'D', refInvoiceNo: n.ref_no || null, pos, posName: stateName(pos), rate: t.rate,
      taxable: t.taxable, igst: t.igst, cgst: t.cgst, sgst: t.sgst, cess: 0, total: t.total,
    };
  });
}

/** Build all GSTR-1 sections for a period. */
async function buildGstr1(period) {
  const { from, to, label } = parsePeriod(period);
  const { gstin, stateCode: supplierStateCode } = await companyState();
  // Aggregate turnover April→period (cur_gt) for the GSTR-1 envelope.
  const fyStart = `${Number(from.slice(0, 4)) - (Number(from.slice(5, 7)) >= 4 ? 0 : 1)}-04-01`;
  // Independent reads — run concurrently.
  const [invoices, curGtRes, notes, { rows: hsnRows }, { rows: invSeries }, { rows: noteSeries }] = await Promise.all([
    loadInvoiceLines(from, to, supplierStateCode),
    query(`SELECT COALESCE(SUM(taxable_value),0) gt FROM invoices WHERE status<>'CANCELLED' AND invoice_date >= $1 AND invoice_date <= $2`, [fyStart, to]),
    loadNotes(from, to, supplierStateCode),
    // HSN summary (Table 12, split B2B / B2C). Quantity goes out in the statutory
    // UQC: packs × pack size (40 × 250ml, uom L → 10 LTR).
    query(
      `SELECT ol.hsn_code, ol.uom, COALESCE(ol.packing_size, p.packing_size) pack, ol.gst_percent rate, i.is_interstate,
              (i.customer_type = 'DISTRIBUTOR' AND COALESCE(d.gstin, '') <> '') b2b,
              MIN(COALESCE(p.name, ol.product_name)) descr,
              SUM(ol.quantity) qty,
              SUM(ol.line_total * ${DISC_FACTOR}) taxable,
              SUM(ROUND(ol.line_total * ${DISC_FACTOR} * ol.gst_percent / 100, 2)) tax
       FROM order_lines ol
       JOIN invoices i ON i.order_id = ol.order_id
       JOIN orders o ON o.id = ol.order_id
       LEFT JOIN products p ON p.id = ol.product_id
       LEFT JOIN distributors d ON d.id = i.distributor_id
       WHERE i.bill_type = 'GST' AND i.status <> 'CANCELLED'
         AND i.invoice_date >= $1 AND i.invoice_date <= $2
       GROUP BY 1, 2, 3, 4, 5, 6`,
      [from, to],
    ),
    // Documents issued (Table 13): one series per bill type + credit / debit notes.
    query(
      `SELECT bill_type, MIN(invoice_no) from_no, MAX(invoice_no) to_no, COUNT(*)::int total,
              COUNT(*) FILTER (WHERE status = 'CANCELLED')::int cancelled
       FROM invoices WHERE invoice_date >= $1 AND invoice_date <= $2 GROUP BY bill_type ORDER BY bill_type DESC`,
      [from, to],
    ),
    query(
      `SELECT note_type, MIN(note_no) from_no, MAX(note_no) to_no, COUNT(*)::int total
       FROM credit_debit_notes WHERE created_at >= $1::date AND created_at < $2::date + 1 GROUP BY note_type`,
      [from, to],
    ),
  ]);
  const curGt = round2(num(curGtRes.rows[0].gt));

  const b2b = [];
  const b2cl = [];
  const b2csMap = new Map(); // key supplyType|pos|rate
  const totals = emptyAmt();

  for (const inv of invoices) {
    for (const it of inv.itms) addAmt(totals, it);
    const posName = stateName(inv.pos);
    if (inv.gstin) {
      for (const it of inv.itms) {
        b2b.push({
          ctin: inv.gstin, tradeName: inv.tradeName, invoiceNo: inv.invoiceNo, invoiceDate: inv.invoiceDate,
          pos: inv.pos, posName, invoiceValue: inv.invoiceValue, reverseCharge: 'N', invoiceType: 'R',
          rate: it.rate, taxable: it.taxable, igst: it.igst, cgst: it.cgst, sgst: it.sgst, cess: it.cess, total: it.total,
        });
      }
    } else if (inv.interstate && inv.invoiceValue > B2CL_THRESHOLD) {
      for (const it of inv.itms) {
        b2cl.push({
          pos: inv.pos, posName, invoiceNo: inv.invoiceNo, invoiceDate: inv.invoiceDate, invoiceValue: inv.invoiceValue,
          rate: it.rate, taxable: it.taxable, igst: it.igst, cess: it.cess, total: it.total,
        });
      }
    } else {
      const supplyType = inv.interstate ? 'INTER' : 'INTRA';
      for (const it of inv.itms) {
        const key = `${supplyType}|${inv.pos}|${it.rate}`;
        const cur = b2csMap.get(key) || { supplyType, pos: inv.pos, posName, rate: it.rate, ...emptyAmt() };
        addAmt(cur, it);
        b2csMap.set(key, cur);
      }
    }
  }
  // ── Credit / Debit notes: registered → CDNR; unregistered → netted into B2CS ──
  // ponytail: a note against a B2CL invoice should go to CDNUR; netted into B2CS until that case shows up.
  const cdnr = [];
  for (const t of notes) {
    // Credit notes reduce liability, debit notes add to it.
    const sign = t.noteType === 'C' ? -1 : 1;
    const signed = { taxable: sign * t.taxable, igst: sign * t.igst, cgst: sign * t.cgst, sgst: sign * t.sgst, cess: 0, total: sign * t.total };
    addAmt(totals, signed);
    if (t.ctin) { cdnr.push(t); continue; }
    const supplyType = t.interstate ? 'INTER' : 'INTRA';
    const key = `${supplyType}|${t.pos}|${t.rate}`;
    const cur = b2csMap.get(key) || { supplyType, pos: t.pos, posName: t.posName, rate: t.rate, ...emptyAmt() };
    addAmt(cur, signed);
    b2csMap.set(key, cur);
  }
  const b2cs = [...b2csMap.values()].map(roundAmt2).sort((a, b) => a.pos.localeCompare(b.pos) || a.rate - b.rate);

  const hsnMap = new Map();
  for (const r of hsnRows) {
    const st = statutoryQty(num(r.qty) || 0, r.pack, r.uom);
    const supplyType = r.b2b ? 'B2B' : 'B2C';
    const rate = num(r.rate) || 0;
    const key = `${supplyType}|${r.hsn_code || ''}|${st.uqc}|${rate}`;
    const tax = round2(num(r.tax) || 0);
    const taxable = num(r.taxable) || 0;
    const half = round2(tax / 2);
    const cur = hsnMap.get(key) || { supplyType, hsnCode: r.hsn_code || null, description: r.descr || null, uqc: st.uqc, rate, qty: 0, ...emptyAmt() };
    cur.qty += st.qty;
    cur.taxable += taxable;
    if (r.is_interstate) cur.igst += tax; else { cur.cgst += half; cur.sgst += tax - half; }
    cur.total += taxable + tax;
    hsnMap.set(key, cur);
  }
  const hsn = [...hsnMap.values()]
    .map((h) => ({ ...h, qty: Math.round(h.qty * 1000) / 1000, ...roundAmt(h) }))
    .sort((a, b) => a.supplyType.localeCompare(b.supplyType) || String(a.hsnCode).localeCompare(String(b.hsnCode)) || a.rate - b.rate);

  const docs = [
    ...invSeries.map((d) => ({
      docNum: 1, docType: d.bill_type === 'NON_GST' ? 'Invoices for outward supply (Bill of Supply)' : 'Invoices for outward supply',
      fromNo: d.from_no, toNo: d.to_no, totalCount: d.total, cancelled: d.cancelled, net: d.total - d.cancelled,
    })),
    ...noteSeries.map((d) => ({
      docNum: d.note_type === 'DEBIT' ? 4 : 5, docType: d.note_type === 'DEBIT' ? 'Debit Note' : 'Credit Note',
      fromNo: d.from_no, toNo: d.to_no, totalCount: d.total, cancelled: 0, net: d.total,
    })),
  ];

  return {
    period, periodLabel: label, gstin, fromDate: from, toDate: to, generatedAt: new Date(), curGt,
    totals: roundAmt(totals),
    counts: {
      b2bInvoices: new Set(b2b.map((r) => r.invoiceNo)).size,
      b2clInvoices: new Set(b2cl.map((r) => r.invoiceNo)).size,
      b2csEntries: b2cs.length,
      cdnNotes: new Set(cdnr.map((r) => r.noteNo)).size,
      hsnEntries: hsn.length,
      totalInvoices: invoices.length,
    },
    b2b, b2cl, b2cs, cdnr, hsn, docs,
  };
}

function roundAmt2(a) {
  return { ...a, ...roundAmt(a) };
}

/** GSTN offline-tool shaped GSTR-1 JSON. */
function gstr1ToPortal(r) {
  // B2B grouped by CTIN → invoice → items.
  const b2bByCtin = new Map();
  for (const row of r.b2b) {
    if (!b2bByCtin.has(row.ctin)) b2bByCtin.set(row.ctin, new Map());
    const invMap = b2bByCtin.get(row.ctin);
    if (!invMap.has(row.invoiceNo)) {
      invMap.set(row.invoiceNo, { inum: row.invoiceNo, idt: dmy(row.invoiceDate), val: row.invoiceValue, pos: row.pos, rchrg: 'N', inv_typ: 'R', itms: [] });
    }
    const inv = invMap.get(row.invoiceNo);
    inv.itms.push({ num: inv.itms.length + 1, itm_det: { rt: row.rate, txval: row.taxable, iamt: row.igst, camt: row.cgst, samt: row.sgst, csamt: row.cess } });
  }
  const b2b = [...b2bByCtin.entries()].map(([ctin, invMap]) => ({ ctin, inv: [...invMap.values()] }));

  // B2CL grouped by POS → invoice.
  const b2clByPos = new Map();
  for (const row of r.b2cl) {
    if (!b2clByPos.has(row.pos)) b2clByPos.set(row.pos, new Map());
    const invMap = b2clByPos.get(row.pos);
    if (!invMap.has(row.invoiceNo)) invMap.set(row.invoiceNo, { inum: row.invoiceNo, idt: dmy(row.invoiceDate), val: row.invoiceValue, itms: [] });
    const inv = invMap.get(row.invoiceNo);
    inv.itms.push({ num: inv.itms.length + 1, itm_det: { rt: row.rate, txval: row.taxable, iamt: row.igst, csamt: row.cess } });
  }
  const b2cl = [...b2clByPos.entries()].map(([pos, invMap]) => ({ pos, inv: [...invMap.values()] }));

  const b2cs = r.b2cs.map((row) => ({
    sply_ty: row.supplyType, pos: row.pos, typ: 'OE', rt: row.rate,
    txval: row.taxable, iamt: row.igst, camt: row.cgst, samt: row.sgst, csamt: row.cess,
  }));

  // CDNR grouped by CTIN.
  const cdnrByCtin = new Map();
  for (const row of r.cdnr) {
    if (!cdnrByCtin.has(row.ctin)) cdnrByCtin.set(row.ctin, []);
    cdnrByCtin.get(row.ctin).push({
      ntty: row.noteType, nt_num: row.noteNo, nt_dt: dmy(row.noteDate), pos: row.pos, rchrg: 'N', inv_typ: 'R', val: row.total,
      itms: [{ num: 1, itm_det: { rt: row.rate, txval: row.taxable, iamt: row.igst, camt: row.cgst, samt: row.sgst, csamt: row.cess } }],
    });
  }
  const cdnr = [...cdnrByCtin.entries()].map(([ctin, nt]) => ({ ctin, nt }));

  // Table 12 is reported in two parts (B2B / B2C) — GSTN advisory, GSTR-1 from May 2025.
  const hsnPart = (type) => r.hsn.filter((h) => h.supplyType === type)
    .map((h, i) => ({ num: i + 1, hsn_sc: h.hsnCode || '', desc: '', uqc: h.uqc, qty: h.qty, rt: h.rate, txval: h.taxable, iamt: h.igst, camt: h.cgst, samt: h.sgst, csamt: h.cess }));
  const hsn = { hsn_b2b: hsnPart('B2B'), hsn_b2c: hsnPart('B2C') };

  const docNums = [...new Set(r.docs.map((d) => d.docNum))];
  const doc_issue = { doc_det: docNums.map((dn) => ({ doc_num: dn, docs: r.docs.filter((d) => d.docNum === dn).map((d, i) => ({ num: i + 1, from: d.fromNo, to: d.toNo, totnum: d.totalCount, cancel: d.cancelled, net_issue: d.net })) })) };

  return {
    gstin: r.gstin, fp: r.period, version: GSTR1_VERSION, hash: 'hash',
    gt: 0, cur_gt: r.curGt ?? 0,   // gt = preceding-FY turnover (manual on portal); cur_gt = Apr→period
    b2b, b2cl, b2cs, cdnr, hsn, doc_issue,
  };
}

/** Due date for a GSTR-3B period = 20th of the next month. */
function gstr3bDueDate(period) {
  const mm = Number(period.slice(0, 2));
  const yyyy = Number(period.slice(2));
  const next = mm === 12 ? { m: 1, y: yyyy + 1 } : { m: mm + 1, y: yyyy };
  return new Date(Date.UTC(next.y, next.m - 1, 20));
}

/**
 * Build the full GSTR-3B for a period (roadmap P1.2/P1.3):
 *  3.1(a) outward taxable · (b) zero-rated · (c) nil/exempt · (d) inward RCM · (e) non-GST
 *  3.2 inter-state supplies to unregistered (POS-wise)
 *  4  ITC: (A)(3) RCM · (A)(5) all other (2B-preferred, else books split) · (B) reversal · (C) net · (D) ineligible
 *  5.1 interest (Rule 88B) + late fee
 */
export async function buildGstr3b(period) {
  const { from, to, label } = parsePeriod(period);
  const { gstin, stateCode } = await companyState();
  const L = (code, lbl, a = {}) => ({ code, label: lbl, taxable: a.taxable || 0, igst: a.igst || 0, cgst: a.cgst || 0, sgst: a.sgst || 0, cess: a.cess || 0, total: (a.igst || 0) + (a.cgst || 0) + (a.sgst || 0) + (a.cess || 0) + (a.includeTaxableInTotal ? a.taxable || 0 : 0) });
  const one = (sql, params) => query(sql, params).then((r) => r.rows[0]);

  // Independent reads — run concurrently.
  const [out, notes, exempt, rcm, { rows: posRows }, imp2b, inel, ch, filed] = await Promise.all([
    // 3.1(a) Outward taxable.
    one(`SELECT COALESCE(SUM(taxable_value),0) taxable, COALESCE(SUM(igst),0) igst, COALESCE(SUM(cgst),0) cgst, COALESCE(SUM(sgst),0) sgst
         FROM invoices WHERE bill_type='GST' AND status<>'CANCELLED' AND invoice_date >= $1 AND invoice_date <= $2`, [from, to]),
    loadNotes(from, to, stateCode),
    // 3.1(c) Nil/exempt (Bill of Supply).
    one(`SELECT COALESCE(SUM(taxable_value),0) taxable FROM invoices WHERE bill_type='NON_GST' AND status<>'CANCELLED' AND invoice_date >= $1 AND invoice_date <= $2`, [from, to]),
    // 3.1(d) Inward supplies liable to reverse charge (output liability).
    one(`SELECT COALESCE(SUM(taxable_value),0) taxable, COALESCE(SUM(igst),0) igst, COALESCE(SUM(cgst),0) cgst, COALESCE(SUM(sgst),0) sgst
         FROM purchase_invoices WHERE is_rcm = TRUE AND invoice_date >= $1 AND invoice_date <= $2`, [from, to]),
    // 3.2 Inter-state supplies to unregistered persons (POS-wise).
    query(
      `SELECT COALESCE(i.place_of_supply,'') pos_name, COALESCE(SUM(i.taxable_value),0) taxable, COALESCE(SUM(i.igst),0) igst
       FROM invoices i LEFT JOIN distributors d ON d.id = i.distributor_id
       WHERE i.bill_type='GST' AND i.status<>'CANCELLED' AND i.is_interstate = TRUE
         AND (i.customer_type='FARMER' OR COALESCE(d.gstin,'') = '')
         AND i.invoice_date >= $1 AND i.invoice_date <= $2
       GROUP BY i.place_of_supply HAVING SUM(i.taxable_value) > 0 ORDER BY taxable DESC`,
      [from, to],
    ),
    one(`SELECT id FROM gst_recon_imports WHERE source='GSTR2B' AND period=$1 ORDER BY created_at DESC LIMIT 1`, [period]),
    // 4(D) Ineligible ITC (books).
    one(`SELECT COALESCE(SUM(igst),0) igst, COALESCE(SUM(cgst),0) cgst, COALESCE(SUM(sgst),0) sgst
         FROM purchase_invoices WHERE itc_eligibility = 'INELIGIBLE' AND invoice_date >= $1 AND invoice_date <= $2`, [from, to]),
    // Challan paid (cash ledger / PMT-06).
    one(`SELECT COALESCE(SUM(igst),0) igst, COALESCE(SUM(cgst),0) cgst, COALESCE(SUM(sgst),0) sgst, COALESCE(SUM(cess),0) cess, COALESCE(SUM(amount),0) total FROM gst_challans WHERE period=$1`, [period]),
    one(`SELECT updated_at FROM gst_returns WHERE return_type='GSTR3B' AND period=$1 AND status='FILED'`, [period]),
  ]);

  const o31a = { code: '3.1(a)', label: 'Outward taxable supplies (other than zero rated, nil & exempted)', taxable: num(out.taxable), igst: num(out.igst), cgst: num(out.cgst), sgst: num(out.sgst), cess: 0, total: 0 };
  // Net of credit / debit notes issued in the period (same notes GSTR-1 reports, so 3B ties to GSTR-1).
  for (const n of notes) {
    const sign = n.noteType === 'C' ? -1 : 1;
    o31a.taxable += sign * n.taxable; o31a.igst += sign * n.igst; o31a.cgst += sign * n.cgst; o31a.sgst += sign * n.sgst;
  }
  // 3.1(b) Zero-rated (exports/SEZ) — not tracked yet; reported as 0.
  const o31b = L('3.1(b)', 'Outward zero-rated supplies (exports / SEZ)');
  const o31c = { code: '3.1(c)', label: 'Other outward supplies (nil rated, exempted)', taxable: num(exempt.taxable), igst: 0, cgst: 0, sgst: 0, cess: 0, total: 0 };
  const o31d = { code: '3.1(d)', label: 'Inward supplies liable to reverse charge', taxable: num(rcm.taxable), igst: num(rcm.igst), cgst: num(rcm.cgst), sgst: num(rcm.sgst), cess: 0, total: 0 };
  const o31e = L('3.1(e)', 'Non-GST outward supplies');
  const interstateSupplies = posRows.map((r) => ({ pos: stateCodeFromName(r.pos_name) || '', posName: r.pos_name || stateName(stateCodeFromName(r.pos_name)) || '—', supplyType: 'Unregistered', taxable: round2(num(r.taxable)), igst: round2(num(r.igst)) }));

  // 4 ITC — (A)(5) all other ITC: prefer GSTR-2B, else books split (non-RCM, eligible).
  const itcSource = imp2b ? 'GSTR2B' : 'BOOKS';
  const s = imp2b
    // Supplier credit notes (CN) in 2B reduce ITC.
    ? await one(
      `SELECT COALESCE(SUM(igst * sg),0) igst, COALESCE(SUM(cgst * sg),0) cgst, COALESCE(SUM(sgst * sg),0) sgst, COALESCE(SUM(cess * sg),0) cess
       FROM gst_recon_docs, LATERAL (SELECT CASE WHEN doc_type = 'CN' THEN -1 ELSE 1 END sg) x
       WHERE import_id=$1 AND COALESCE(itc_eligible,true) AND COALESCE(ims_action,'') <> 'REJECTED'`, [imp2b.id])
    : await one(
      `SELECT COALESCE(SUM(igst),0) igst, COALESCE(SUM(cgst),0) cgst, COALESCE(SUM(sgst),0) sgst, COALESCE(SUM(cess),0) cess
       FROM purchase_invoices WHERE is_rcm = FALSE AND itc_eligibility = 'ELIGIBLE' AND invoice_date >= $1 AND invoice_date <= $2`, [from, to]);
  const other = { igst: num(s.igst), cgst: num(s.cgst), sgst: num(s.sgst), cess: num(s.cess) };

  const itcRcm = { code: '4(A)(3)', label: 'ITC Available — inward supplies (reverse charge)', taxable: 0, igst: num(rcm.igst), cgst: num(rcm.cgst), sgst: num(rcm.sgst), cess: 0, total: num(rcm.igst) + num(rcm.cgst) + num(rcm.sgst) };
  const itcOther = { code: '4(A)(5)', label: 'ITC Available — all other ITC', taxable: 0, ...other, total: other.igst + other.cgst + other.sgst + other.cess };
  const itcReversed = L('4(B)', 'ITC Reversed (Rule 42/43 & others)');
  const net = { igst: itcRcm.igst + itcOther.igst, cgst: itcRcm.cgst + itcOther.cgst, sgst: itcRcm.sgst + itcOther.sgst, cess: itcRcm.cess + itcOther.cess };
  const itcNet = { code: '4(C)', label: 'Net ITC Available (A − B)', taxable: 0, ...net, total: net.igst + net.cgst + net.sgst + net.cess };
  const itcIneligible = { code: '4(D)', label: 'Ineligible ITC', taxable: 0, igst: num(inel.igst), cgst: num(inel.cgst), sgst: num(inel.sgst), cess: 0, total: num(inel.igst) + num(inel.cgst) + num(inel.sgst) };

  // Output liability = 3.1(a) + 3.1(d) RCM (RCM is paid in cash, then ITC claimed in 4A3).
  const outputTax = { igst: o31a.igst + o31d.igst, cgst: o31a.cgst + o31d.cgst, sgst: o31a.sgst + o31d.sgst };
  const pay = utiliseItc(outputTax, net);  // s.49 cross-utilisation order (IGST credit first)
  const taxPayable = { code: '6.1', label: 'Tax payable in cash (output − ITC, s.49 set-off)', taxable: 0, igst: pay.igst, cgst: pay.cgst, sgst: pay.sgst, cess: 0, total: round2(pay.igst + pay.cgst + pay.sgst) };

  const challanPaid = { code: '6.1*', label: 'Tax paid by challan (PMT-06)', taxable: 0, igst: num(ch.igst), cgst: num(ch.cgst), sgst: num(ch.sgst), cess: num(ch.cess), total: num(ch.total) };

  const balance = netLiability({ igst: taxPayable.igst, cgst: taxPayable.cgst, sgst: taxPayable.sgst }, challanPaid);
  const netPayable = { code: 'NET', label: 'Balance payable in cash', taxable: 0, igst: balance.igst, cgst: balance.cgst, sgst: balance.sgst, cess: 0, total: round2(balance.igst + balance.cgst + balance.sgst) };

  // 5.1 Interest (Rule 88B) + late fee — days past the due date, up to the filing date once filed.
  const due = gstr3bDueDate(period);
  const asOf = filed ? new Date(filed.updated_at).getTime() : Date.now();
  const daysLate = Math.max(0, Math.floor((asOf - due.getTime()) / 86400000));
  const interestObj = interest88B({ igst: taxPayable.igst, cgst: taxPayable.cgst, sgst: taxPayable.sgst }, daysLate);
  const interest = { code: '5.1', label: `Interest @18% (${daysLate} day(s) late)`, taxable: 0, igst: interestObj.igst, cgst: interestObj.cgst, sgst: interestObj.sgst, cess: 0, total: interestObj.total };
  const isNil = o31a.taxable === 0 && o31a.igst + o31a.cgst + o31a.sgst === 0 && o31c.taxable === 0 && o31d.taxable === 0 && itcNet.total === 0;
  const lateFeeAmt = lateFee(daysLate, isNil);

  // "Total tax" column = tax heads only (taxable value has its own column).
  o31a.total = round2(o31a.igst + o31a.cgst + o31a.sgst);
  o31d.total = round2(o31d.igst + o31d.cgst + o31d.sgst);

  return {
    period, periodLabel: label, gstin, fromDate: from, toDate: to, generatedAt: new Date(), itcSource,
    outward: [o31a, o31b, o31c, o31d, o31e].map(roundLine),
    interstateSupplies,
    itc: [itcRcm, itcOther, itcReversed, itcNet, itcIneligible].map(roundLine),
    taxPayable: roundLine(taxPayable), itcAvailed: roundLine(itcNet), challanPaid: roundLine(challanPaid),
    netPayable: roundLine(netPayable), interest: roundLine(interest), lateFee: round2(lateFeeAmt),
  };
}

const roundLine = (l) => ({ ...l, taxable: round2(l.taxable), igst: round2(l.igst), cgst: round2(l.cgst), sgst: round2(l.sgst), cess: round2(l.cess), total: round2(l.total) });

function gstr3bToPortal(r) {
  const a = r.outward[0], zero = r.outward[1], nil = r.outward[2], rev = r.outward[3], nongst = r.outward[4];
  const net = r.itcAvailed;
  const unreg = r.interstateSupplies.filter((p) => p.pos).map((p) => ({ pos: p.pos, txval: p.taxable, iamt: p.igst }));
  return {
    gstin: r.gstin,
    ret_period: r.period,
    sup_details: {
      osup_det: { txval: a.taxable, iamt: a.igst, camt: a.cgst, samt: a.sgst, csamt: a.cess },
      osup_zero: { txval: zero.taxable, iamt: zero.igst, csamt: zero.cess },
      osup_nil_exmp: { txval: nil.taxable },
      isup_rev: { txval: rev.taxable, iamt: rev.igst, camt: rev.cgst, samt: rev.sgst, csamt: rev.cess },
      osup_nongst: { txval: nongst.taxable },
    },
    inter_sup: { unreg_details: unreg, comp_details: [], uin_details: [] },
    itc_elg: {
      itc_avl: [
        { ty: 'RC', iamt: r.itc[0].igst, camt: r.itc[0].cgst, samt: r.itc[0].sgst, csamt: r.itc[0].cess },
        { ty: 'OTH', iamt: r.itc[1].igst, camt: r.itc[1].cgst, samt: r.itc[1].sgst, csamt: r.itc[1].cess },
      ],
      itc_rev: [{ ty: 'OTH', iamt: r.itc[2].igst, camt: r.itc[2].cgst, samt: r.itc[2].sgst, csamt: r.itc[2].cess }],
      itc_net: { iamt: net.igst, camt: net.cgst, samt: net.sgst, csamt: net.cess },
      itc_inelg: [{ ty: 'OTH', iamt: r.itc[4].igst, camt: r.itc[4].cgst, samt: r.itc[4].sgst, csamt: r.itc[4].cess }],
    },
    intr_ltfee: { intr_details: { iamt: r.interest.igst, camt: r.interest.cgst, samt: r.interest.sgst, csamt: 0 }, ltfee_details: { camt: round2(r.lateFee / 2), samt: round2(r.lateFee / 2) } },
  };
}

/** Build the portal-ready payload + summary for a return type. */
async function buildPayload(returnType, period) {
  const type = String(returnType).toUpperCase();
  if (type === 'GSTR1') { const r = await buildGstr1(period); return { type, payload: gstr1ToPortal(r), summary: { totals: r.totals, counts: r.counts }, gstin: r.gstin }; }
  if (type === 'GSTR3B') { const r = await buildGstr3b(period); return { type, payload: gstr3bToPortal(r), summary: { taxPayable: r.taxPayable, netPayable: r.netPayable }, gstin: r.gstin }; }
  throw Object.assign(new Error('returnType must be GSTR1 or GSTR3B'), { statusCode: 400 });
}

export function gstReturnsResolvers() {
  return {
    Query: {
      gstTransactionDetails: async (_p, args, ctx) => {
        guard(ctx);
        const { gstReconResolvers } = await import('./gstRecon.js');
        return buildGstDrilldown(args, ctx, { parsePeriod, companyState, loadInvoiceLines, loadNotes, buildGstr3b, buildGstr1, resolvers: { ...gstReturnsResolvers().Query, ...gstReconResolvers().Query } });
      },
      gstr1Report: async (_p, { period }, ctx) => { guard(ctx); return buildGstr1(period); },
      gstr1PortalJson: async (_p, { period }, ctx) => { guard(ctx); return gstr1ToPortal(await buildGstr1(period)); },
      gstr3bReport: async (_p, { period }, ctx) => { guard(ctx); return buildGstr3b(period); },
      gstr3bPortalJson: async (_p, { period }, ctx) => { guard(ctx); return gstr3bToPortal(await buildGstr3b(period)); },

      validateGstReturn: async (_p, { returnType, period }, ctx) => {
        guard(ctx);
        const { type, payload } = await buildPayload(returnType, period);
        return validatePayload(type, payload);
      },
      gstFilingProvider: async (_p, _a, ctx) => { guard(ctx); return getGstProviderName(); },

      ewayBillRegister: async (_p, { dateFrom, dateTo }, ctx) => {
        guard(ctx);
        const { rows } = await query(
          `SELECT e.*, i.invoice_no, i.invoice_date, i.total_amount, COALESCE(d.name, f.name) d_name, d.gstin d_gstin
           FROM eway_bills e
           JOIN invoices i ON i.id = e.invoice_id
           LEFT JOIN distributors d ON d.id = i.distributor_id
           LEFT JOIN farmers f ON f.id = i.farmer_id
           WHERE ($1::date IS NULL OR i.invoice_date >= $1) AND ($2::date IS NULL OR i.invoice_date <= $2)
           ORDER BY e.created_at DESC LIMIT 1000`,
          [dateFrom || null, dateTo || null],
        );
        return rows.map((r) => ({
          id: r.id, invoiceId: r.invoice_id, invoiceNo: r.invoice_no, invoiceDate: isoDate(r.invoice_date), distributorName: r.d_name, gstin: r.d_gstin,
          ewbNo: r.ewb_no, ewbDate: r.ewb_date, validUntil: r.valid_until, distanceKm: r.distance_km, transportMode: r.transport_mode,
          vehicleNo: r.vehicle_no, transporterId: r.transporter_id, status: r.status, totalAmount: num(r.total_amount),
        }));
      },

      // Contiguous months (current → back), so empty months are selectable for a nil return —
      // but never before the first invoice (months before the business started aren't "overdue").
      gstPeriods: async (_p, { limit }, ctx) => {
        guard(ctx);
        const n = Math.min(Math.max(Number(limit) || 12, 1), 60);
        const now = new Date();
        const keys = Array.from({ length: n }, (_, k) => {
          const d = new Date(Date.UTC(now.getFullYear(), now.getMonth() - k, 1));
          return `${String(d.getUTCMonth() + 1).padStart(2, '0')}${d.getUTCFullYear()}`;
        });
        const { from } = parsePeriod(keys[n - 1]);
        const [{ rows }, { rows: [first] }] = await Promise.all([
          query(
            `SELECT to_char(invoice_date,'MMYYYY') period, COUNT(*)::int cnt
             FROM invoices WHERE status <> 'CANCELLED' AND invoice_date >= $1
             GROUP BY 1`,
            [from],
          ),
          query(`SELECT to_char(MIN(invoice_date),'YYYYMM') ym FROM invoices`),
        ]);
        const cnt = new Map(rows.map((r) => [r.period, r.cnt]));
        const ym = (p) => p.slice(2) + p.slice(0, 2);
        const live = first?.ym ? keys.filter((p, i) => i === 0 || ym(p) >= first.ym) : keys.slice(0, 1);
        return live.map((p) => ({ period: p, label: parsePeriod(p).label, invoiceCount: cnt.get(p) ?? 0 }));
      },

      gstReturnLogs: async (_p, _a, ctx) => {
        guard(ctx);
        const { rows } = await query('SELECT id, return_type, period, status, created_at FROM gst_returns ORDER BY created_at DESC LIMIT 100');
        return rows.map((r) => ({ id: r.id, returnType: r.return_type, period: r.period, status: r.status, createdAt: r.created_at }));
      },
    },

    Mutation: {
      saveGstReturn: async (_p, { returnType, period }, ctx) => {
        const actor = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN');
        const { type, payload, summary, gstin } = await buildPayload(returnType, period);
        const { rows } = await withTransaction(async (client) => client.query(
          `INSERT INTO gst_returns (return_type, period, gstin, payload, summary, status, generated_by)
           VALUES ($1,$2,$3,$4,$5,'GENERATED',$6)
           ON CONFLICT (return_type, period) DO UPDATE SET payload=EXCLUDED.payload, summary=EXCLUDED.summary,
             gstin=EXCLUDED.gstin, status='GENERATED', generated_by=EXCLUDED.generated_by, updated_at=now()
           RETURNING id, return_type, period, status, created_at`,
          [type, period, gstin, JSON.stringify(payload), JSON.stringify(summary), actor.sub],
        ));
        await logActivity(actor.sub, 'SAVE_GST_RETURN', 'gst_return', rows[0].id, { type, period });
        return { id: rows[0].id, returnType: rows[0].return_type, period: rows[0].period, status: rows[0].status, createdAt: rows[0].created_at };
      },

      // File via the configured GST provider (mock = demo ARN; GSP = real, when credentials are set).
      // Blocks on validation errors so an invalid return is never filed.
      fileGstReturn: async (_p, { returnType, period }, ctx) => {
        const actor = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN');
        const { type, payload, summary, gstin } = await buildPayload(returnType, period);
        const v = validatePayload(type, payload);
        if (!v.valid) throw Object.assign(new Error(`Return has ${v.errors.length} validation error(s): ${v.errors.slice(0, 3).join('; ')}`), { statusCode: 400 });
        const res = await gstProvider.fileReturn({ returnType: type, period, gstin, payload });
        const { rows } = await withTransaction(async (client) => client.query(
          `INSERT INTO gst_returns (return_type, period, gstin, payload, summary, status, filed_ref, generated_by)
           VALUES ($1,$2,$3,$4,$5,'FILED',$6,$7)
           ON CONFLICT (return_type, period) DO UPDATE SET payload=EXCLUDED.payload, summary=EXCLUDED.summary,
             gstin=EXCLUDED.gstin, status='FILED', filed_ref=EXCLUDED.filed_ref, generated_by=EXCLUDED.generated_by, updated_at=now()
           RETURNING id, return_type, period, status, created_at`,
          [type, period, gstin, JSON.stringify(payload), JSON.stringify(summary), res.arn, actor.sub],
        ));
        await logActivity(actor.sub, 'FILE_GST_RETURN_GSP', 'gst_return', rows[0].id, { type, period, arn: res.arn, provider: res.provider });
        return { id: rows[0].id, returnType: rows[0].return_type, period: rows[0].period, status: rows[0].status, createdAt: rows[0].created_at };
      },

      markGstReturnFiled: async (_p, { returnType, period, filedRef }, ctx) => {
        const actor = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN');
        filedRef = String(filedRef || '').trim().toUpperCase();
        if (!filedRef) throw Object.assign(new Error('Enter the ARN from the GST portal'), { statusCode: 400 });
        const { rows } = await query(
          `UPDATE gst_returns SET status='FILED', filed_ref=$3, updated_at=now()
           WHERE return_type=$1 AND period=$2 RETURNING id, return_type, period, status, created_at`,
          [returnType.toUpperCase(), period, filedRef],
        );
        if (!rows[0]) throw Object.assign(new Error('Save the return before marking it filed'), { statusCode: 404 });
        await logActivity(actor.sub, 'FILE_GST_RETURN', 'gst_return', rows[0].id, { filedRef });
        return { id: rows[0].id, returnType: rows[0].return_type, period: rows[0].period, status: rows[0].status, createdAt: rows[0].created_at };
      },
    },
  };
}
