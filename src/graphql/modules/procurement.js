// GraphQL module: Procurement / Purchase.
// Vendors + Purchase Orders -> Goods Receipt (real stock inflow) -> vendor bill -> payment.

import { query, withTransaction } from '../../db/index.js';
import { assertAuth, assertRole } from '../context.js';
import { httpError, logActivity, num, isoDate } from '../helpers.js';
import { splitTax, roundGst } from '../../services/gst/calc.js';
import { resolveStateCode, stateName } from '../../services/gst/stateCodes.js';

export const procurementTypeDefs = /* GraphQL */ `
  type Vendor {
    id: ID!
    name: String!
    contactPerson: String
    phone: String
    email: String
    gstin: String
    address: String
    city: String
    state: String
    outstanding: Float!
    udyamNo: String
    msmeType: String
    msmeRegistered: Boolean!
    msmeRegDate: String
    paymentTermsDays: Int!
    isActive: Boolean!
    createdAt: DateTime!
  }

  type POLine {
    id: ID!
    productId: ID!
    productName: String!
    hsnCode: String
    uom: String
    packingSize: String
    quantity: Float!
    receivedQty: Float!
    unitCost: Float!
    gstPercent: Float!
    lineTotal: Float!
  }

  type PurchaseOrder {
    id: ID!
    poNo: String!
    vendorId: ID!
    vendorName: String
    status: String!
    orderDate: String!
    expectedDate: String
    subTotal: Float!
    taxTotal: Float!
    totalAmount: Float!
    notes: String
    itemCount: Int!
    lines: [POLine!]!
    hasBill: Boolean!
    createdAt: DateTime!
  }

  type PurchaseInvoice {
    id: ID!
    billNo: String!
    internalNo: String!
    poId: ID
    vendorId: ID!
    vendorName: String
    invoiceDate: String!
    taxableValue: Float!
    igst: Float!
    cgst: Float!
    sgst: Float!
    isInterstate: Boolean!
    isRcm: Boolean!
    itcEligibility: String!
    totalAmount: Float!
    amountPaid: Float!
    balanceDue: Float!
    createdAt: DateTime!
  }

  # Default figures for a vendor bill against a PO (received value, tax split by vendor vs company state).
  type PurchaseBillDraft {
    basis: String!            # RECEIVED (goods received so far) or ORDERED (nothing received yet)
    taxableValue: Float!
    igst: Float!
    cgst: Float!
    sgst: Float!
    totalAmount: Float!
    isInterstate: Boolean!
    vendorState: String
    companyState: String
  }

  type PurchaseStats { vendors: Int!, openPos: Int!, purchasesMtd: Float!, vendorOutstanding: Float! }

  input VendorInput {
    name: String!
    contactPerson: String
    phone: String
    email: String
    gstin: String
    address: String
    city: String
    state: String
    udyamNo: String
    msmeType: String
    msmeRegistered: Boolean
    msmeRegDate: String
    paymentTermsDays: Int
  }
  input POLineInput { productId: ID!, quantity: Float!, unitCost: Float! }
  input CreatePOInput { vendorId: ID!, orderDate: String, expectedDate: String, notes: String, lines: [POLineInput!]! }
  input ReceiveLineInput { poLineId: ID!, batchNumber: String!, manufacturingDate: String, expiryDate: String, quantity: Float! }
  input ReceivePOInput { poId: ID!, warehouseId: ID!, lines: [ReceiveLineInput!]! }
  input VendorPaymentInput { vendorId: ID!, purchaseInvoiceId: ID, amount: Float!, method: String, reference: String }

  extend type Query {
    vendors(search: String, activeOnly: Boolean, limit: Int = 100): [Vendor!]!
    vendor(id: ID!): Vendor
    purchaseOrders(status: String, vendorId: ID, search: String, limit: Int = 100): [PurchaseOrder!]!
    purchaseOrder(id: ID!): PurchaseOrder
    purchaseInvoices(vendorId: ID, openOnly: Boolean, limit: Int = 100): [PurchaseInvoice!]!
    purchaseBillDraft(poId: ID!): PurchaseBillDraft!
    purchaseStats: PurchaseStats!
  }

  extend type Mutation {
    createVendor(input: VendorInput!): Vendor!
    updateVendor(id: ID!, input: VendorInput!): Vendor!
    setVendorActive(id: ID!, isActive: Boolean!): Vendor!
    deleteVendor(id: ID!): Boolean!

    createPurchaseOrder(input: CreatePOInput!): PurchaseOrder!
    approvePurchaseOrder(id: ID!): PurchaseOrder!
    cancelPurchaseOrder(id: ID!): PurchaseOrder!
    receivePurchaseOrder(input: ReceivePOInput!): PurchaseOrder!
    # taxableValue/igst/cgst/sgst override the computed draft (manual correction to match the vendor's invoice).
    recordPurchaseBill(poId: ID!, billNo: String!, invoiceDate: String, isRcm: Boolean, itcEligibility: String,
      taxableValue: Float, igst: Float, cgst: Float, sgst: Float): PurchaseInvoice!
    recordVendorPayment(input: VendorPaymentInput!): Boolean!
  }
`;

const round2 = (n) => Math.round(n * 100) / 100;
const round3 = (n) => Math.round(n * 1000) / 1000;
/** Trimmed string or null ("" / whitespace → null) — forms send "" for untouched optional fields. */
const str = (v) => (v == null || String(v).trim() === '' ? null : String(v).trim());
function fy(d) {
  const dt = d ? new Date(d) : new Date();
  const start = dt.getMonth() >= 3 ? dt.getFullYear() : dt.getFullYear() - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

// Item count + billed flag are computed in SQL so the PO list doesn't fire 2 queries per row.
const PO_SELECT = `SELECT po.*, v.name vendor_name,
    (SELECT COUNT(*)::int FROM purchase_order_lines l WHERE l.po_id = po.id) item_count,
    EXISTS (SELECT 1 FROM purchase_invoices pi WHERE pi.po_id = po.id) has_bill
  FROM purchase_orders po JOIN vendors v ON v.id = po.vendor_id`;
const PINV_SELECT = 'SELECT pi.*, v.name vendor_name FROM purchase_invoices pi JOIN vendors v ON v.id = pi.vendor_id';

const mapVendor = (r) =>
  r && {
    id: r.id, name: r.name, contactPerson: r.contact_person, phone: r.phone, email: r.email,
    gstin: r.gstin, address: r.address, city: r.city, state: r.state,
    outstanding: num(r.outstanding) ?? 0,
    udyamNo: r.udyam_no, msmeType: r.msme_type, msmeRegistered: r.msme_registered ?? false,
    msmeRegDate: r.msme_reg_date ? isoDate(r.msme_reg_date) : null,
    paymentTermsDays: r.payment_terms_days ?? 45,
    isActive: r.is_active, createdAt: r.created_at,
  };
const mapPO = (r) =>
  r && {
    id: r.id, poNo: r.po_no, vendorId: r.vendor_id, vendorName: r.vendor_name ?? null,
    status: r.status, orderDate: isoDate(r.order_date), expectedDate: isoDate(r.expected_date),
    subTotal: num(r.sub_total), taxTotal: num(r.tax_total), totalAmount: num(r.total_amount),
    notes: r.notes, createdAt: r.created_at, itemCount: r.item_count ?? 0, hasBill: Boolean(r.has_bill),
  };
const mapPInv = (r) =>
  r && {
    id: r.id, billNo: r.bill_no, internalNo: r.internal_no, poId: r.po_id, vendorId: r.vendor_id, vendorName: r.vendor_name ?? null,
    invoiceDate: isoDate(r.invoice_date), taxableValue: num(r.taxable_value) ?? 0,
    igst: num(r.igst) ?? 0, cgst: num(r.cgst) ?? 0, sgst: num(r.sgst) ?? 0,
    isInterstate: Boolean(r.is_interstate), isRcm: Boolean(r.is_rcm), itcEligibility: r.itc_eligibility ?? 'ELIGIBLE',
    totalAmount: num(r.total_amount), amountPaid: num(r.amount_paid),
    balanceDue: round2(num(r.total_amount) - num(r.amount_paid)), createdAt: r.created_at,
  };
function vVals(i) {
  const name = str(i.name);
  if (!name) throw httpError('Vendor name is required', 400);
  const days = i.paymentTermsDays ?? 45;
  if (!Number.isInteger(days) || days < 0) throw httpError('Payment terms must be whole days (0 or more)', 400);
  const msme = Boolean(i.msmeRegistered);
  return [name, str(i.contactPerson), str(i.phone), str(i.email), str(i.gstin)?.toUpperCase() ?? null, str(i.address), str(i.city), str(i.state),
    msme ? str(i.udyamNo)?.toUpperCase() ?? null : null, msme ? str(i.msmeType) ?? 'NA' : 'NA', msme, msme ? str(i.msmeRegDate) : null, days];
}

/**
 * Vendor-bill figures for a PO: goods received so far (3-way match), or the
 * ordered quantities when nothing is received yet. Tax is split per line at the
 * line's GST rate — IGST when vendor and company are in different states, else CGST+SGST.
 */
async function billDraft(db, po) {
  const lines = (await db.query('SELECT quantity, received_qty, unit_cost, gst_percent FROM purchase_order_lines WHERE po_id=$1', [po.id])).rows;
  const company = (await db.query('SELECT gstin, state FROM company_settings WHERE id = 1')).rows[0] || {};
  const vendor = (await db.query('SELECT gstin, state FROM vendors WHERE id = $1', [po.vendor_id])).rows[0] || {};
  const coState = resolveStateCode({ gstin: company.gstin, stateName: company.state });
  const vState = resolveStateCode({ gstin: vendor.gstin, stateName: vendor.state });
  const isInterstate = !!coState && !!vState && coState !== vState;
  const basis = lines.some((l) => num(l.received_qty) > 0) ? 'RECEIVED' : 'ORDERED';
  let taxableValue = 0, igst = 0, cgst = 0, sgst = 0;
  for (const l of lines) {
    const qty = basis === 'RECEIVED' ? num(l.received_qty) : num(l.quantity);
    const taxable = roundGst(qty * num(l.unit_cost));
    const t = splitTax(taxable, num(l.gst_percent), isInterstate);
    taxableValue += taxable; igst += t.igst; cgst += t.cgst; sgst += t.sgst;
  }
  [taxableValue, igst, cgst, sgst] = [taxableValue, igst, cgst, sgst].map(roundGst);
  return {
    basis, taxableValue, igst, cgst, sgst, totalAmount: roundGst(taxableValue + igst + cgst + sgst), isInterstate,
    vendorState: vendor.state || (vState ? stateName(vState) : null), companyState: company.state || (coState ? stateName(coState) : null),
  };
}

export function procurementResolvers() {
  return {
    Query: {
      vendors: async (_p, { search, activeOnly, limit }, ctx) => {
        assertAuth(ctx);
        const { rows } = await query(
          `SELECT * FROM vendors
           WHERE ($1::text IS NULL OR name ILIKE '%'||$1||'%' OR gstin ILIKE '%'||$1||'%')
             AND ($2::bool IS NULL OR is_active = $2)
           ORDER BY created_at DESC LIMIT $3`,
          [str(search), activeOnly ?? null, Math.min(limit ?? 100, 1000)],
        );
        return rows.map(mapVendor);
      },
      vendor: async (_p, { id }, ctx) => { assertAuth(ctx); const { rows } = await query('SELECT * FROM vendors WHERE id=$1', [id]); return mapVendor(rows[0]); },
      purchaseOrders: async (_p, { status, vendorId, search, limit }, ctx) => {
        assertAuth(ctx);
        const { rows } = await query(
          `${PO_SELECT}
           WHERE ($1::text IS NULL OR po.status = $1)
             AND ($2::uuid IS NULL OR po.vendor_id = $2)
             AND ($3::text IS NULL OR po.po_no ILIKE '%'||$3||'%' OR v.name ILIKE '%'||$3||'%')
           ORDER BY po.created_at DESC LIMIT $4`,
          [str(status), str(vendorId), str(search), Math.min(limit ?? 100, 1000)],
        );
        return rows.map(mapPO);
      },
      purchaseOrder: async (_p, { id }, ctx) => {
        assertAuth(ctx);
        const { rows } = await query(`${PO_SELECT} WHERE po.id=$1`, [id]);
        return mapPO(rows[0]);
      },
      purchaseInvoices: async (_p, { vendorId, openOnly, limit }, ctx) => {
        assertAuth(ctx);
        const { rows } = await query(
          `${PINV_SELECT}
           WHERE ($1::uuid IS NULL OR pi.vendor_id = $1) AND (NOT COALESCE($2::bool, false) OR pi.total_amount - pi.amount_paid > 0.005)
           ORDER BY pi.invoice_date DESC, pi.created_at DESC LIMIT $3`,
          [str(vendorId), openOnly ?? null, Math.min(limit ?? 100, 1000)],
        );
        return rows.map(mapPInv);
      },
      purchaseBillDraft: async (_p, { poId }, ctx) => {
        assertAuth(ctx);
        const po = (await query('SELECT * FROM purchase_orders WHERE id=$1', [poId])).rows[0];
        if (!po) throw httpError('PO not found', 404);
        return billDraft({ query }, po);
      },
      purchaseStats: async (_p, _a, ctx) => {
        assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN');
        const { rows } = await query(
          `SELECT (SELECT COUNT(*) FROM vendors WHERE is_active)::int vendors,
                  (SELECT COUNT(*) FROM purchase_orders WHERE status IN ('DRAFT','APPROVED','PARTIAL'))::int open_pos,
                  COALESCE((SELECT SUM(total_amount) FROM purchase_invoices WHERE date_trunc('month',invoice_date)=date_trunc('month',CURRENT_DATE)),0) purchases_mtd,
                  COALESCE((SELECT SUM(outstanding) FROM vendors),0) vendor_outstanding`,
        );
        const r = rows[0];
        return { vendors: r.vendors, openPos: r.open_pos, purchasesMtd: num(r.purchases_mtd), vendorOutstanding: num(r.vendor_outstanding) };
      },
    },

    Mutation: {
      createVendor: async (_p, { input }, ctx) => {
        const a = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN');
        const { rows } = await query(
          `INSERT INTO vendors (name, contact_person, phone, email, gstin, address, city, state, udyam_no, msme_type, msme_registered, msme_reg_date, payment_terms_days)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`, vVals(input));
        await logActivity(a.sub, 'CREATE_VENDOR', 'vendor', rows[0].id);
        return mapVendor(rows[0]);
      },
      updateVendor: async (_p, { id, input }, ctx) => {
        const a = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN');
        const { rows } = await query(
          `UPDATE vendors SET name=$2, contact_person=$3, phone=$4, email=$5, gstin=$6, address=$7, city=$8, state=$9,
             udyam_no=$10, msme_type=$11, msme_registered=$12, msme_reg_date=$13, payment_terms_days=$14, updated_at=now() WHERE id=$1 RETURNING *`,
          [id, ...vVals(input)]);
        if (!rows[0]) throw httpError('Vendor not found', 404);
        await logActivity(a.sub, 'UPDATE_VENDOR', 'vendor', id);
        return mapVendor(rows[0]);
      },
      setVendorActive: async (_p, { id, isActive }, ctx) => {
        const a = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN');
        const { rows } = await query('UPDATE vendors SET is_active=$2, updated_at=now() WHERE id=$1 RETURNING *', [id, isActive]);
        if (!rows[0]) throw httpError('Vendor not found', 404);
        await logActivity(a.sub, 'TOGGLE_VENDOR', 'vendor', id);
        return mapVendor(rows[0]);
      },
      deleteVendor: async (_p, { id }, ctx) => {
        const a = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN');
        const used = (await query(
          `SELECT EXISTS (SELECT 1 FROM purchase_orders WHERE vendor_id=$1) OR EXISTS (SELECT 1 FROM purchase_invoices WHERE vendor_id=$1)
             OR EXISTS (SELECT 1 FROM vendor_payments WHERE vendor_id=$1) OR EXISTS (SELECT 1 FROM purchase_returns WHERE vendor_id=$1) used`, [id])).rows[0].used;
        if (used) throw httpError('This vendor has purchase orders, bills or payments — deactivate it instead of deleting', 409);
        const { rowCount } = await query('DELETE FROM vendors WHERE id=$1', [id]);
        if (!rowCount) throw httpError('Vendor not found', 404);
        await logActivity(a.sub, 'DELETE_VENDOR', 'vendor', id);
        return true;
      },

      createPurchaseOrder: async (_p, { input }, ctx) => {
        const a = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN');
        if (!input.lines?.length) throw httpError('PO must have at least one line', 400);
        for (const l of input.lines) {
          if (!(l.quantity > 0)) throw httpError('Each line needs a quantity greater than 0', 400);
          if (!(l.unitCost >= 0)) throw httpError('Unit cost cannot be negative', 400);
        }
        return withTransaction(async (client) => {
          const v = await client.query('SELECT id FROM vendors WHERE id=$1', [input.vendorId]);
          if (!v.rows[0]) throw httpError('Vendor not found', 404);
          const prods = new Map((await client.query('SELECT * FROM products WHERE id = ANY($1::uuid[])', [input.lines.map((l) => l.productId)])).rows.map((p) => [p.id, p]));
          let subTotal = 0, taxTotal = 0;
          const lines = [];
          for (const l of input.lines) {
            const p = prods.get(l.productId);
            if (!p) throw httpError('Product not found', 404);
            const lineTotal = round2(l.quantity * l.unitCost);
            const gst = num(p.gst_percent ?? 0);
            subTotal += lineTotal; taxTotal += roundGst(lineTotal * gst / 100);
            lines.push({ p, l, lineTotal, gst });
          }
          subTotal = round2(subTotal); taxTotal = round2(taxTotal);
          const total = round2(subTotal + taxTotal);
          const orderDate = str(input.orderDate);
          const poNo = `PO-${fy(orderDate)}-${String((await client.query("SELECT nextval('po_seq') n")).rows[0].n).padStart(5, '0')}`;
          const po = await client.query(
            `INSERT INTO purchase_orders (po_no, vendor_id, status, order_date, expected_date, sub_total, tax_total, total_amount, notes, created_by)
             VALUES ($1,$2,'DRAFT',COALESCE($3::date,CURRENT_DATE),$4,$5,$6,$7,$8,$9) RETURNING *`,
            [poNo, input.vendorId, orderDate, str(input.expectedDate), subTotal, taxTotal, total, str(input.notes), a.sub]);
          for (const { p, l, lineTotal, gst } of lines) {
            await client.query(
              `INSERT INTO purchase_order_lines (po_id, product_id, product_name, hsn_code, uom, packing_size, quantity, unit_cost, gst_percent, line_total)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
              [po.rows[0].id, p.id, p.name, p.hsn_code, p.uom, p.packing_size ?? null, l.quantity, l.unitCost, gst, lineTotal]);
          }
          await logActivity(a.sub, 'CREATE_PO', 'purchase_order', po.rows[0].id, { poNo });
          const full = await client.query(`${PO_SELECT} WHERE po.id=$1`, [po.rows[0].id]);
          return mapPO(full.rows[0]);
        });
      },

      approvePurchaseOrder: async (_p, { id }, ctx) => {
        const a = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN');
        const { rows } = await query("UPDATE purchase_orders SET status='APPROVED', updated_at=now() WHERE id=$1 AND status='DRAFT' RETURNING *", [id]);
        if (!rows[0]) throw httpError('Only DRAFT purchase orders can be approved', 400);
        await logActivity(a.sub, 'APPROVE_PO', 'purchase_order', id);
        const full = await query(`${PO_SELECT} WHERE po.id=$1`, [id]);
        return mapPO(full.rows[0]);
      },
      cancelPurchaseOrder: async (_p, { id }, ctx) => {
        const a = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN');
        const cur = await query('SELECT status FROM purchase_orders WHERE id=$1', [id]);
        if (!cur.rows[0]) throw httpError('PO not found', 404);
        if (['RECEIVED', 'PARTIAL'].includes(cur.rows[0].status)) throw httpError('Cannot cancel a (partially) received PO', 400);
        await query("UPDATE purchase_orders SET status='CANCELLED', updated_at=now() WHERE id=$1", [id]);
        await logActivity(a.sub, 'CANCEL_PO', 'purchase_order', id);
        const full = await query(`${PO_SELECT} WHERE po.id=$1`, [id]);
        return mapPO(full.rows[0]);
      },

      receivePurchaseOrder: async (_p, { input }, ctx) => {
        const a = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN');
        const recv = (input.lines ?? []).filter((l) => l.quantity > 0);
        if (!recv.length) throw httpError('Enter a received quantity for at least one line', 400);
        if (recv.some((l) => !str(l.batchNumber))) throw httpError('Batch number is required for every line being received', 400);
        return withTransaction(async (client) => {
          const po = (await client.query('SELECT * FROM purchase_orders WHERE id=$1 FOR UPDATE', [input.poId])).rows[0];
          if (!po) throw httpError('PO not found', 404);
          if (!['APPROVED', 'PARTIAL'].includes(po.status)) throw httpError('PO must be APPROVED to receive', 400);
          const wh = (await client.query('SELECT id FROM warehouses WHERE id=$1', [input.warehouseId])).rows[0];
          if (!wh) throw httpError('Warehouse not found', 404);

          const grnNo = `GRN-${String((await client.query("SELECT nextval('grn_seq') n")).rows[0].n).padStart(6, '0')}`;
          const grn = await client.query(
            `INSERT INTO goods_receipts (grn_no, po_id, vendor_id, warehouse_id, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
            [grnNo, po.id, po.vendor_id, input.warehouseId, a.sub]);

          for (const rl of recv) {
            const line = (await client.query('SELECT * FROM purchase_order_lines WHERE id=$1 AND po_id=$2 FOR UPDATE', [rl.poLineId, po.id])).rows[0];
            if (!line) throw httpError('PO line not found', 404);
            const pending = round3(num(line.quantity) - num(line.received_qty));
            if (rl.quantity > pending + 0.0005) throw httpError(`${line.product_name}: receiving ${rl.quantity} but only ${pending} pending on this PO`, 400);
            const mfg = str(rl.manufacturingDate), exp = str(rl.expiryDate);
            if (mfg && exp && exp < mfg) throw httpError(`${line.product_name}: expiry date is before the manufacturing date`, 400);
            // create/find batch, add stock, log movement IN
            const batch = await client.query(
              `INSERT INTO batches (product_id, batch_number, manufacturing_date, expiry_date)
               VALUES ($1,$2,$3,$4) ON CONFLICT (product_id, batch_number) DO UPDATE SET
                 manufacturing_date=COALESCE(EXCLUDED.manufacturing_date, batches.manufacturing_date),
                 expiry_date=COALESCE(EXCLUDED.expiry_date, batches.expiry_date) RETURNING id`,
              [line.product_id, str(rl.batchNumber), mfg, exp]);
            await client.query(
              `INSERT INTO stock_levels (warehouse_id, product_id, batch_id, quantity)
               VALUES ($1,$2,$3,$4) ON CONFLICT (warehouse_id, product_id, batch_id) DO UPDATE SET
                 quantity = stock_levels.quantity + EXCLUDED.quantity, updated_at=now()`,
              [input.warehouseId, line.product_id, batch.rows[0].id, rl.quantity]);
            await client.query(
              `INSERT INTO stock_movements (warehouse_id, product_id, batch_id, movement_type, quantity, reason, ref_type, ref_id, created_by)
               VALUES ($1,$2,$3,'IN',$4,'Goods receipt (GRN)','grn',$5,$6)`,
              [input.warehouseId, line.product_id, batch.rows[0].id, rl.quantity, grn.rows[0].id, a.sub]);
            await client.query('UPDATE purchase_order_lines SET received_qty = received_qty + $2 WHERE id=$1', [line.id, rl.quantity]);
          }

          // recompute PO status
          const lines = (await client.query('SELECT quantity, received_qty FROM purchase_order_lines WHERE po_id=$1', [po.id])).rows;
          const allDone = lines.every((l) => num(l.received_qty) >= num(l.quantity));
          const newStatus = allDone ? 'RECEIVED' : 'PARTIAL';
          await client.query('UPDATE purchase_orders SET status=$2, updated_at=now() WHERE id=$1', [po.id, newStatus]);
          await logActivity(a.sub, 'RECEIVE_PO', 'purchase_order', po.id, { grnNo, status: newStatus });
          const full = await client.query(`${PO_SELECT} WHERE po.id=$1`, [po.id]);
          return mapPO(full.rows[0]);
        });
      },

      recordPurchaseBill: async (_p, { poId, billNo, invoiceDate, isRcm, itcEligibility, taxableValue, igst, cgst, sgst }, ctx) => {
        const a = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN');
        const bill = str(billNo);
        if (!bill) throw httpError('Vendor invoice number is required', 400);
        if ([taxableValue, igst, cgst, sgst].some((v) => v != null && !(v >= 0))) throw httpError('Bill amounts cannot be negative', 400);
        return withTransaction(async (client) => {
          const po = (await client.query('SELECT * FROM purchase_orders WHERE id=$1 FOR UPDATE', [poId])).rows[0];
          if (!po) throw httpError('PO not found', 404);
          if (['DRAFT', 'CANCELLED'].includes(po.status)) throw httpError(`Cannot bill a ${po.status.toLowerCase()} PO`, 400);
          const exists = await client.query('SELECT id FROM purchase_invoices WHERE po_id=$1', [poId]);
          if (exists.rows[0]) throw httpError('A bill already exists for this PO', 409);
          const dup = await client.query('SELECT 1 FROM purchase_invoices WHERE vendor_id=$1 AND upper(bill_no)=upper($2)', [po.vendor_id, bill]);
          if (dup.rows[0]) throw httpError(`Bill no. ${bill} is already recorded for this vendor`, 409);
          const date = str(invoiceDate);
          const internalNo = `PINV-${fy(date)}-${String((await client.query("SELECT nextval('pbill_seq') n")).rows[0].n).padStart(5, '0')}`;

          // Computed draft (received value, per-line rate split by state), with manual overrides from the vendor's invoice.
          const d = await billDraft(client, po);
          const taxable = roundGst(taxableValue ?? d.taxableValue);
          const heads = { igst: roundGst(igst ?? d.igst), cgst: roundGst(cgst ?? d.cgst), sgst: roundGst(sgst ?? d.sgst) };
          const tax = roundGst(heads.igst + heads.cgst + heads.sgst);
          const interstate = heads.igst > 0 ? true : heads.cgst + heads.sgst > 0 ? false : d.isInterstate;
          // Under reverse charge the vendor doesn't charge GST — we pay it to the government, so the payable is the taxable value.
          const total = roundGst(taxable + (isRcm ? 0 : tax));
          const elig = ['ELIGIBLE', 'INELIGIBLE', 'PARTIAL'].includes(String(itcEligibility || '').toUpperCase()) ? itcEligibility.toUpperCase() : 'ELIGIBLE';

          const inv = await client.query(
            `INSERT INTO purchase_invoices (bill_no, internal_no, po_id, vendor_id, invoice_date, taxable_value, tax_value, igst, cgst, sgst, is_interstate, is_rcm, itc_eligibility, total_amount, created_by)
             VALUES ($1,$2,$3,$4,COALESCE($5::date,CURRENT_DATE),$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
            [bill, internalNo, poId, po.vendor_id, date, taxable, tax, heads.igst, heads.cgst, heads.sgst, interstate, !!isRcm, elig, total, a.sub]);
          await client.query('UPDATE vendors SET outstanding = outstanding + $2 WHERE id=$1', [po.vendor_id, total]);
          await logActivity(a.sub, 'RECORD_PURCHASE_BILL', 'purchase_invoice', inv.rows[0].id, { billNo: bill });
          const full = await client.query(`${PINV_SELECT} WHERE pi.id=$1`, [inv.rows[0].id]);
          return mapPInv(full.rows[0]);
        });
      },

      recordVendorPayment: async (_p, { input }, ctx) => {
        const a = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN');
        const amount = round2(input.amount);
        if (!(amount > 0)) throw httpError('Amount must be positive', 400);
        const billId = str(input.purchaseInvoiceId);
        return withTransaction(async (client) => {
          const v = await client.query('SELECT id FROM vendors WHERE id=$1', [input.vendorId]);
          if (!v.rows[0]) throw httpError('Vendor not found', 404);
          // Bill-wise allocation: against the chosen bill, else oldest open bills first; any remainder is an on-account advance.
          const open = (await client.query(
            `SELECT id, bill_no, total_amount - amount_paid bal FROM purchase_invoices
             WHERE vendor_id=$1 AND total_amount - amount_paid > 0.005 AND ($2::uuid IS NULL OR id=$2)
             ORDER BY invoice_date, created_at FOR UPDATE`, [input.vendorId, billId])).rows;
          if (billId && !open[0]) throw httpError('That bill is not open for this vendor', 400);
          if (billId && amount > num(open[0].bal) + 0.005) throw httpError(`Amount exceeds the bill balance of ₹${num(open[0].bal).toFixed(2)}`, 400);
          let remaining = amount;
          const ins = (invId, amt) => client.query(
            'INSERT INTO vendor_payments (vendor_id, purchase_invoice_id, amount, method, reference, created_by) VALUES ($1,$2,$3,$4,$5,$6)',
            [input.vendorId, invId, amt, str(input.method), str(input.reference), a.sub]);
          for (const b of open) {
            if (remaining <= 0) break;
            const take = round2(Math.min(remaining, num(b.bal)));
            await ins(b.id, take);
            await client.query('UPDATE purchase_invoices SET amount_paid = amount_paid + $2 WHERE id=$1', [b.id, take]);
            remaining = round2(remaining - take);
          }
          if (remaining > 0) await ins(null, remaining);
          await client.query('UPDATE vendors SET outstanding = GREATEST(outstanding - $2, 0) WHERE id=$1', [input.vendorId, amount]);
          await logActivity(a.sub, 'VENDOR_PAYMENT', 'vendor', input.vendorId, { amount });
          return true;
        });
      },
    },

    PurchaseOrder: {
      lines: async (parent) => {
        const { rows } = await query('SELECT * FROM purchase_order_lines WHERE po_id=$1 ORDER BY product_name', [parent.id]);
        return rows.map((r) => ({
          id: r.id, productId: r.product_id, productName: r.product_name, hsnCode: r.hsn_code, uom: r.uom, packingSize: r.packing_size ?? null,
          quantity: num(r.quantity), receivedQty: num(r.received_qty), unitCost: num(r.unit_cost),
          gstPercent: num(r.gst_percent), lineTotal: num(r.line_total),
        }));
      },
    },
  };
}
