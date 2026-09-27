// Read-only transaction provenance for GST reports. Use the report's own loaders
// and classifications so discount allocation, notes and ITC source stay aligned.
import { query } from '../../db/index.js';
import { isoDate } from '../helpers.js';
import { B2CL_THRESHOLD, roundGst } from '../../services/gst/calc.js';
import { statutoryQty } from '../../services/units.js';

const n = (v) => Number(v || 0);
const heads = ['taxable', 'igst', 'cgst', 'sgst', 'cess', 'tax', 'total'];
function amounts(r) {
  const a = { taxable: n(r.taxable ?? r.taxable_value), igst: n(r.igst), cgst: n(r.cgst), sgst: n(r.sgst), cess: n(r.cess) };
  a.tax = roundGst(a.igst + a.cgst + a.sgst + a.cess);
  a.total = n(r.total ?? r.total_amount ?? a.taxable + a.tax);
  return a;
}
export function signedNote(note, signed = true) {
  const a = amounts(note);
  const sign = signed && note.noteType === 'C' ? -1 : 1;
  return { ...note, ...Object.fromEntries(heads.map((k) => [k, roundGst(a[k] * sign)])), docNo: note.noteNo, date: note.noteDate, party: note.tradeName, gstin: note.ctin, type: note.noteType === 'C' ? 'Credit note' : 'Debit note', reference: note.refInvoiceNo, section: note.ctin ? 'cdnr' : 'b2cs', supplyType: note.interstate ? 'INTER' : 'INTRA' };
}
// Tax heads in Table 12 are rounded at HSN-group level. Allocate only the
// resulting rounding residue to the largest line so drilldown totals reconcile.
export function reconcileHsnDetails(rows, summary) {
  const key = (r) => JSON.stringify([r.supplyType, r.hsnCode || '', r.uqc, Number(r.rate)]);
  const groups = new Map();
  for (const row of rows) {
    const k = key(row);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(row);
  }
  for (const total of summary) {
    const group = groups.get(key(total));
    if (!group?.length) continue;
    const largest = group.reduce((a, b) => a.taxable >= b.taxable ? a : b);
    for (const head of ['taxable', 'igst', 'cgst', 'sgst', 'cess']) {
      for (const row of group) row[head] = roundGst(row[head]);
      largest[head] = roundGst(largest[head] + total[head] - group.reduce((sum, row) => sum + row[head], 0));
    }
    for (const row of group) {
      row.tax = roundGst(row.igst + row.cgst + row.sgst + row.cess);
      row.total = roundGst(row.taxable + row.tax);
    }
  }
  return rows;
}

export function selectDetailRows(rows, filters = {}) {
  // Only report dimensions, never SQL fragments, are accepted from the URL.
  const allowed = ['id', 'docNo', 'rate', 'pos', 'posName', 'supplyType', 'hsnCode', 'uqc', 'status', 'imsAction', 'docType', 'bookInvoiceNo'];
  return rows.filter((r) => allowed.every((k) => filters[k] == null || String(r[k] ?? '') === String(filters[k])));
}

export async function buildGstDrilldown({ period, report, section = 'all', filters = {} }, ctx, loaders) {
  if (!filters || typeof filters !== 'object' || Array.isArray(filters)) throw new Error('Invalid GST detail filters');
  const { parsePeriod, companyState, loadInvoiceLines, loadNotes, buildGstr3b, buildGstr1, resolvers } = loaders;
  const { from, to } = parsePeriod(period);
  const { stateCode } = await companyState();
  let rows = [], calculation = [], note = '';
  const invoiceRows = async (billType = 'GST') => (await query(`
    SELECT i.*, COALESCE(d.name, f.name) party, d.gstin
    FROM invoices i LEFT JOIN distributors d ON d.id=i.distributor_id LEFT JOIN farmers f ON f.id=i.farmer_id
    WHERE i.bill_type=$3 AND i.status<>'CANCELLED' AND i.invoice_date >= $1 AND i.invoice_date <= $2
    ORDER BY i.invoice_date, i.invoice_no`, [from, to, billType])).rows.map((r) => ({
      ...amounts(r), id: r.id, invoiceId: r.id, docNo: r.invoice_no, date: isoDate(r.invoice_date), party: r.party, gstin: r.gstin,
      type: billType === 'GST' ? 'Sales invoice' : 'Bill of supply', posName: r.place_of_supply || '—', interstate: r.is_interstate, customerType: r.customer_type,
    }));
  const purchaseRows = async () => (await query(`
    SELECT p.*, v.name party, v.gstin FROM purchase_invoices p LEFT JOIN vendors v ON v.id=p.vendor_id
    WHERE p.invoice_date >= $1 AND p.invoice_date <= $2 ORDER BY p.invoice_date, p.bill_no`, [from, to])).rows.map((r) => ({
      ...amounts(r), id: r.id, docNo: r.bill_no, date: isoDate(r.invoice_date), party: r.party, gstin: r.gstin, type: 'Purchase invoice', isRcm: r.is_rcm, eligibility: r.itc_eligibility,
    }));
  const challanRows = async () => (await resolvers.gstChallans(null, { period }, ctx)).map((r) => ({ ...r, ...amounts({ ...r, total: r.amount }), docNo: r.challanNo || r.cpin, date: r.paidDate, party: 'GST cash ledger', type: 'Challan' }));
  if (report === 'GSTR3B') {
    const r = await buildGstr3b(period);
    const line = [...r.outward, ...r.itc, r.taxPayable, r.challanPaid, r.netPayable, r.interest].find((l) => l.code === section);
    if (!line && !['lateFee', '3.2', 'challanBalance'].includes(section)) throw new Error('Unknown GSTR-3B section');
    const out = async () => [...await invoiceRows(), ...(await loadNotes(from, to, stateCode)).map((r) => signedNote(r))];
    const otherItc = async () => {
      if (r.itcSource !== 'GSTR2B') return (await purchaseRows()).filter((p) => p.isRcm === false && p.eligibility === 'ELIGIBLE');
      const docs = (await query(`SELECT d.* FROM gst_recon_docs d WHERE d.import_id=(SELECT id FROM gst_recon_imports WHERE source='GSTR2B' AND period=$1 ORDER BY created_at DESC LIMIT 1)
        AND COALESCE(d.itc_eligible,true) AND COALESCE(d.ims_action,'') <> 'REJECTED' ORDER BY d.doc_date, d.doc_no`, [period])).rows;
      return docs.map((d) => {
        const a = amounts(d), sign = d.doc_type === 'CN' ? -1 : 1;
        return { ...Object.fromEntries(heads.map((k) => [k, roundGst(a[k] * sign)])), id: d.id, docNo: d.doc_no, date: isoDate(d.doc_date), party: d.trade_name, gstin: d.ctin, type: `GSTR-2B ${d.doc_type}`, status: d.ims_action || 'NO_ACTION' };
      });
    };
    const rcm = async () => (await purchaseRows()).filter((p) => p.isRcm);
    if (section === '3.1(a)') rows = await out();
    else if (section === '3.1(c)') rows = await invoiceRows('NON_GST');
    else if (['3.1(d)', '4(A)(3)'].includes(section)) rows = await rcm();
    else if (section === '4(A)(5)') rows = await otherItc();
    else if (section === '4(C)') rows = [...await rcm(), ...await otherItc()];
    else if (section === '4(D)') rows = (await purchaseRows()).filter((p) => p.eligibility === 'INELIGIBLE');
    else if (section === '6.1*') rows = await challanRows();
    else if (section === '3.2') rows = (await invoiceRows()).filter((p) => p.interstate && (p.customerType === 'FARMER' || !p.gstin));
    else if (['6.1', 'NET', '5.1', 'lateFee', 'challanBalance'].includes(section)) {
      rows = [
        ...(await out()).map((p) => ({ ...p, basis: 'Output tax' })),
        ...(await rcm()).map((p) => ({ ...p, basis: 'Reverse charge / ITC' })),
        ...(await otherItc()).map((p) => ({ ...p, basis: 'Available ITC' })),
        ...(await challanRows()).map((p) => ({ ...p, basis: 'Cash paid' })),
      ];
      calculation = [r.outward[0], r.outward[3], r.itcAvailed, r.taxPayable, r.challanPaid, r.netPayable, r.interest,
        { label: 'Late fee', cgst: r.lateFee / 2, sgst: r.lateFee / 2, total: r.lateFee }];
      if (section === 'challanBalance') calculation.push({ label: 'Challan reconciliation balance (liability − paid)', igst: r.taxPayable.igst - r.challanPaid.igst, cgst: r.taxPayable.cgst - r.challanPaid.cgst, sgst: r.taxPayable.sgst - r.challanPaid.sgst, total: r.taxPayable.total - r.challanPaid.igst - r.challanPaid.cgst - r.challanPaid.sgst });
      note = 'This is a calculated amount. The calculation below uses the same return values and ITC set-off as the summary. Supporting transactions are grouped by their role; their combined value is not the balance payable.';
    } else note = 'This section is currently reported as zero and has no underlying transactions in the return.';
    if (section.startsWith('4')) note = `ITC source: ${r.itcSource === 'GSTR2B' ? 'latest imported GSTR-2B' : 'purchase books'}. Credit notes reduce available ITC. Reverse-charge ITC comes from purchase books.`;
    if (!calculation.length && line) calculation = [{ ...line, label: `Reported amount · ${line.label}` }];
  } else if (report === 'GSTR1') {
    const invs = await loadInvoiceLines(from, to, stateCode);
    rows = invs.flatMap((inv) => inv.itms.map((it) => ({
      ...amounts(it), id: inv.id, invoiceId: inv.id, docNo: inv.invoiceNo, date: inv.invoiceDate, party: inv.tradeName, gstin: inv.gstin, type: 'Sales invoice',
      rate: it.rate, pos: inv.pos, supplyType: inv.interstate ? 'INTER' : 'INTRA', invoiceValue: inv.invoiceValue,
      section: inv.gstin ? 'b2b' : inv.interstate && inv.invoiceValue > B2CL_THRESHOLD ? 'b2cl' : 'b2cs',
    })));
    rows.push(...(await loadNotes(from, to, stateCode)).map((r) => signedNote(r, section !== 'cdnr')));
    if (section === 'hsn') {
      const raw = (await query(`SELECT i.id, i.invoice_no, i.invoice_date, i.is_interstate, COALESCE(d.name,f.name) party, d.gstin,
        (i.customer_type='DISTRIBUTOR' AND COALESCE(d.gstin,'')<>'') b2b, ol.hsn_code, ol.uom, COALESCE(ol.packing_size,p.packing_size) pack,
        ol.gst_percent rate, ol.quantity qty, ol.line_total * CASE WHEN o.sub_total>0 THEN (o.sub_total-o.discount_total)/o.sub_total ELSE 1 END taxable
        FROM order_lines ol JOIN orders o ON o.id=ol.order_id JOIN invoices i ON i.order_id=ol.order_id
        LEFT JOIN products p ON p.id=ol.product_id LEFT JOIN distributors d ON d.id=i.distributor_id LEFT JOIN farmers f ON f.id=i.farmer_id
        WHERE i.bill_type='GST' AND i.status<>'CANCELLED' AND i.invoice_date >= $1 AND i.invoice_date <= $2
        ORDER BY i.invoice_date, i.invoice_no`, [from, to])).rows;
      rows = raw.map((r) => {
        const tax = roundGst(n(r.taxable) * n(r.rate) / 100), half = roundGst(tax / 2), qty = statutoryQty(n(r.qty), r.pack, r.uom);
        return { ...amounts({ taxable: r.taxable, igst: r.is_interstate ? tax : 0, cgst: r.is_interstate ? 0 : half, sgst: r.is_interstate ? 0 : tax-half }), invoiceId: r.id, docNo: r.invoice_no, date: isoDate(r.invoice_date), party: r.party, gstin: r.gstin, type: 'Sales item', rate: n(r.rate), hsnCode: r.hsn_code, supplyType: r.b2b ? 'B2B' : 'B2C', qty: qty.qty, uqc: qty.uqc };
      });
      rows = reconcileHsnDetails(rows, (await buildGstr1(period)).hsn);
    } else if (section === 'filing-invoices') rows = [...await invoiceRows(), ...await invoiceRows('NON_GST')];
    else if (section === 'invoices') rows = rows.filter((r) => r.type === 'Sales invoice');
    else if (section !== 'all') rows = rows.filter((r) => r.section === section);
    note = section === 'hsn' ? 'Tax rounding is allocated within each HSN, rate and unit group to match the reported HSN summary.' : section === 'cdnr' ? 'Note values are shown as reported in CDNR. Credit notes reduce the net outward totals.' : 'Credit notes are negative and debit notes are positive. Invoice rows are split by GST rate.';
  } else if (report === 'RECON') {
    if (!['GSTR1', 'GSTR2A', 'GSTR2B'].includes(filters.source)) throw new Error('Invalid reconciliation source');
    const r = await resolvers.gstReconResult(null, { period, source: filters.source }, ctx);
    rows = r.rows.map((r) => ({ ...r, party: r.supplierName, gstin: r.ctin, date: r.docDate, type: r.docType }));
  } else if (report === 'IMS') {
    const r = await resolvers.imsInbox(null, { period }, ctx);
    rows = r.rows.map((r) => ({ ...r, party: r.supplierName, gstin: r.ctin, date: r.docDate, type: r.docType }));
    if (section === 'pending') rows = rows.filter((r) => ['PENDING', 'NO_ACTION'].includes(r.imsAction));
  } else if (report === 'CHALLAN') rows = await challanRows();
  else if (report === 'EWAY') {
    rows = (await resolvers.ewayBillRegister(null, { dateFrom: filters.from || null, dateTo: filters.to || null }, ctx)).map((r) => ({ ...r, docNo: r.invoiceNo, date: r.invoiceDate, party: r.distributorName, type: 'E-Way bill', total: r.totalAmount }));
    if (section === 'active' || section === 'expiring') rows = rows.filter((r) => r.status === 'GENERATED' && (!r.validUntil || new Date(r.validUntil).getTime() >= Date.now()));
    if (section === 'expiring') rows = rows.filter((r) => r.validUntil && new Date(r.validUntil).getTime() - Date.now() < 2 * 86400000);
  } else throw new Error('Unknown GST report');
  return { rows: selectDetailRows(rows, filters), calculation, note };
}
