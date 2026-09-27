// GraphQL module: Returns Management (PRD §7.3).
// Sales returns -> goods back into stock + credit note (reduces distributor outstanding).
// Purchase returns -> goods out of stock + debit note (reduces vendor payable).

import { query, withTransaction } from '../../db/index.js';
import { assertAuth, assertRole } from '../context.js';
import { httpError, logActivity, num, isoDate } from '../helpers.js';
import { splitTax, roundGst } from '../../services/gst/calc.js';
import { resolveStateCode } from '../../services/gst/stateCodes.js';

export const returnsTypeDefs = /* GraphQL */ `
  type SalesReturnLine {
    id: ID!
    productId: ID!
    productName: String!
    uom: String
    packingSize: String
    batchNumber: String
    quantity: Float!
    unitPrice: Float!
    gstPercent: Float!
    lineTotal: Float!
  }
  type SalesReturn {
    id: ID!
    returnNo: String!
    orderId: ID
    orderNo: String
    distributorId: ID!
    distributorName: String
    warehouseId: ID
    warehouseName: String
    status: String!
    returnDate: String!
    reason: String
    subTotal: Float!
    taxTotal: Float!
    totalAmount: Float!
    creditNoteNo: String
    notes: String
    itemCount: Int!
    lines: [SalesReturnLine!]!
    createdAt: DateTime!
    approvedAt: DateTime
  }

  type PurchaseReturnLine {
    id: ID!
    productId: ID!
    productName: String!
    uom: String
    packingSize: String
    batchNumber: String
    quantity: Float!
    unitCost: Float!
    gstPercent: Float!
    lineTotal: Float!
  }
  type PurchaseReturn {
    id: ID!
    returnNo: String!
    poId: ID
    poNo: String
    vendorId: ID!
    vendorName: String
    warehouseId: ID
    warehouseName: String
    status: String!
    returnDate: String!
    reason: String
    subTotal: Float!
    taxTotal: Float!
    totalAmount: Float!
    debitNoteNo: String
    notes: String
    itemCount: Int!
    lines: [PurchaseReturnLine!]!
    createdAt: DateTime!
    approvedAt: DateTime
  }

  # A line of the original order / PO that can still be returned (maxQty = sold or received − already returned).
  type ReturnableLine {
    productId: ID!
    productName: String!
    uom: String
    packingSize: String
    batchNumber: String
    maxQty: Float!
    unitPrice: Float!
    gstPercent: Float!
  }

  type ReturnsStats {
    salesReturns: Int!
    purchaseReturns: Int!
    pendingSales: Int!
    pendingPurchase: Int!
    creditIssued: Float!
    debitIssued: Float!
  }

  input SalesReturnLineInput { productId: ID!, batchNumber: String, quantity: Float!, unitPrice: Float! }
  input CreateSalesReturnInput { distributorId: ID!, orderId: ID, warehouseId: ID!, reason: String, notes: String, lines: [SalesReturnLineInput!]! }
  input PurchaseReturnLineInput { productId: ID!, batchNumber: String, quantity: Float!, unitCost: Float! }
  input CreatePurchaseReturnInput { vendorId: ID!, poId: ID, warehouseId: ID!, reason: String, notes: String, lines: [PurchaseReturnLineInput!]! }

  extend type Query {
    salesReturns(status: String, search: String, limit: Int = 100): [SalesReturn!]!
    salesReturn(id: ID!): SalesReturn
    purchaseReturns(status: String, search: String, limit: Int = 100): [PurchaseReturn!]!
    purchaseReturn(id: ID!): PurchaseReturn
    returnsStats: ReturnsStats!
    salesReturnSource(orderId: ID!, excludeReturnId: ID): [ReturnableLine!]!
    purchaseReturnSource(poId: ID!, excludeReturnId: ID): [ReturnableLine!]!
  }

  extend type Mutation {
    createSalesReturn(input: CreateSalesReturnInput!): SalesReturn!
    updateSalesReturn(id: ID!, input: CreateSalesReturnInput!): SalesReturn!
    deleteSalesReturn(id: ID!): Boolean!
    approveSalesReturn(id: ID!): SalesReturn!
    cancelSalesReturn(id: ID!): SalesReturn!
    createPurchaseReturn(input: CreatePurchaseReturnInput!): PurchaseReturn!
    updatePurchaseReturn(id: ID!, input: CreatePurchaseReturnInput!): PurchaseReturn!
    deletePurchaseReturn(id: ID!): Boolean!
    approvePurchaseReturn(id: ID!): PurchaseReturn!
    cancelPurchaseReturn(id: ID!): PurchaseReturn!
  }
`;

const round2 = (n) => Math.round(n * 100) / 100;
const round3 = (n) => Math.round(n * 1000) / 1000;
const str = (v) => (v == null || String(v).trim() === '' ? null : String(v).trim());
function fy(d) {
  const dt = d ? new Date(d) : new Date();
  const start = dt.getMonth() >= 3 ? dt.getFullYear() : dt.getFullYear() - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

const SR_SELECT = `SELECT sr.*, d.name distributor_name, o.order_no, w.name warehouse_name,
    (SELECT COUNT(*)::int FROM sales_return_lines l WHERE l.return_id = sr.id) item_count
  FROM sales_returns sr JOIN distributors d ON d.id = sr.distributor_id
  LEFT JOIN orders o ON o.id = sr.order_id LEFT JOIN warehouses w ON w.id = sr.warehouse_id`;
const PR_SELECT = `SELECT pr.*, v.name vendor_name, po.po_no, w.name warehouse_name,
    (SELECT COUNT(*)::int FROM purchase_return_lines l WHERE l.return_id = pr.id) item_count
  FROM purchase_returns pr JOIN vendors v ON v.id = pr.vendor_id
  LEFT JOIN purchase_orders po ON po.id = pr.po_id LEFT JOIN warehouses w ON w.id = pr.warehouse_id`;

const mapSR = (r) => r && {
  id: r.id, returnNo: r.return_no, orderId: r.order_id, orderNo: r.order_no ?? null,
  distributorId: r.distributor_id, distributorName: r.distributor_name ?? null,
  warehouseId: r.warehouse_id, warehouseName: r.warehouse_name ?? null, status: r.status,
  returnDate: isoDate(r.return_date), reason: r.reason, subTotal: num(r.sub_total), taxTotal: num(r.tax_total),
  totalAmount: num(r.total_amount), creditNoteNo: r.credit_note_no, notes: r.notes, createdAt: r.created_at, approvedAt: r.approved_at,
  itemCount: r.item_count ?? 0,
};
const mapPR = (r) => r && {
  id: r.id, returnNo: r.return_no, poId: r.po_id, poNo: r.po_no ?? null,
  vendorId: r.vendor_id, vendorName: r.vendor_name ?? null,
  warehouseId: r.warehouse_id, warehouseName: r.warehouse_name ?? null, status: r.status,
  returnDate: isoDate(r.return_date), reason: r.reason, subTotal: num(r.sub_total), taxTotal: num(r.tax_total),
  totalAmount: num(r.total_amount), debitNoteNo: r.debit_note_no, notes: r.notes, createdAt: r.created_at, approvedAt: r.approved_at,
  itemCount: r.item_count ?? 0,
};

// What can still be returned against a sales order: ordered qty − qty on other (non-cancelled) returns, at the net (post-discount) price.
async function salesSource(db, orderId, excludeReturnId = null) {
  const { rows } = await db.query(
    `SELECT ol.product_id, MIN(ol.product_name) product_name, MIN(ol.uom) uom, MIN(COALESCE(ol.packing_size, p.packing_size)) packing_size,
            SUM(ol.quantity) qty, SUM(ol.line_total) / NULLIF(SUM(ol.quantity), 0) unit_price,
            CASE WHEN MIN(o.bill_type) = 'NON_GST' THEN 0 ELSE MAX(ol.gst_percent) END gst_percent,
            COALESCE((SELECT SUM(l.quantity) FROM sales_return_lines l JOIN sales_returns r ON r.id = l.return_id
                      WHERE r.order_id = $1 AND r.status <> 'CANCELLED' AND ($2::uuid IS NULL OR r.id <> $2) AND l.product_id = ol.product_id), 0) returned
     FROM order_lines ol JOIN orders o ON o.id = ol.order_id LEFT JOIN products p ON p.id = ol.product_id
     WHERE ol.order_id = $1 GROUP BY ol.product_id ORDER BY MIN(ol.product_name)`,
    [orderId, excludeReturnId],
  );
  return rows.map((r) => ({
    productId: r.product_id, productName: r.product_name, uom: r.uom, packingSize: r.packing_size, batchNumber: null,
    maxQty: Math.max(round3(num(r.qty) - num(r.returned)), 0), unitPrice: round2(num(r.unit_price) || 0), gstPercent: num(r.gst_percent) || 0,
  }));
}
// What can still be returned against a PO: received qty − qty on other (non-cancelled) returns; batch = latest GRN batch.
async function purchaseSource(db, poId, excludeReturnId = null) {
  const { rows } = await db.query(
    `SELECT pl.product_id, MIN(pl.product_name) product_name, MIN(pl.uom) uom, MIN(pl.packing_size) packing_size,
            SUM(pl.received_qty) qty, SUM(pl.received_qty * pl.unit_cost) / NULLIF(SUM(pl.received_qty), 0) unit_cost, MAX(pl.gst_percent) gst_percent,
            COALESCE((SELECT SUM(l.quantity) FROM purchase_return_lines l JOIN purchase_returns r ON r.id = l.return_id
                      WHERE r.po_id = $1 AND r.status <> 'CANCELLED' AND ($2::uuid IS NULL OR r.id <> $2) AND l.product_id = pl.product_id), 0) returned,
            (SELECT b.batch_number FROM stock_movements sm JOIN goods_receipts g ON g.id = sm.ref_id JOIN batches b ON b.id = sm.batch_id
              WHERE sm.ref_type = 'grn' AND g.po_id = $1 AND sm.product_id = pl.product_id ORDER BY sm.created_at DESC LIMIT 1) batch_number
     FROM purchase_order_lines pl WHERE pl.po_id = $1 GROUP BY pl.product_id ORDER BY MIN(pl.product_name)`,
    [poId, excludeReturnId],
  );
  return rows.map((r) => ({
    productId: r.product_id, productName: r.product_name, uom: r.uom, packingSize: r.packing_size, batchNumber: r.batch_number,
    maxQty: Math.max(round3(num(r.qty) - num(r.returned)), 0), unitPrice: round2(num(r.unit_cost) || 0), gstPercent: num(r.gst_percent) || 0,
  }));
}

/** Validate + price return lines. With a source document, qty per product is capped at what's still returnable. */
async function prepareLines(client, lines, priceKey, source) {
  if (!lines?.length) throw httpError('A return needs at least one line', 400);
  const prods = new Map((await client.query('SELECT id, name, gst_percent, uom, packing_size FROM products WHERE id = ANY($1::uuid[])', [lines.map((l) => l.productId)])).rows.map((p) => [p.id, p]));
  const src = source && new Map(source.map((s) => [s.productId, s]));
  const qtyByProduct = new Map();
  let subTotal = 0, taxTotal = 0;
  const prepared = [];
  for (const l of lines) {
    const p = prods.get(l.productId);
    if (!p) throw httpError('Product not found', 404);
    if (!(l.quantity > 0)) throw httpError(`${p.name}: quantity must be greater than 0`, 400);
    if (!(l[priceKey] >= 0)) throw httpError(`${p.name}: rate cannot be negative`, 400);
    let gst = num(p.gst_percent ?? 0);
    if (src) {
      const s = src.get(l.productId);
      if (!s) throw httpError(`${p.name} is not on the original document`, 400);
      const q = round3((qtyByProduct.get(l.productId) ?? 0) + l.quantity);
      if (q > s.maxQty + 0.0005) throw httpError(`${p.name}: returning ${q} but only ${s.maxQty} can still be returned against the original document`, 400);
      qtyByProduct.set(l.productId, q);
      gst = s.gstPercent; // follow the original document (0 for a bill of supply)
    }
    const lineTotal = round2(l.quantity * l[priceKey]);
    subTotal += lineTotal; taxTotal += roundGst(lineTotal * gst / 100);
    prepared.push({ l, p, gst, lineTotal });
  }
  return { prepared, subTotal: round2(subTotal), taxTotal: round2(taxTotal) };
}

const lineOut = (r, priceKey, col) => ({
  id: r.id, productId: r.product_id, productName: r.product_name, uom: r.uom ?? null, packingSize: r.packing_size ?? null,
  batchNumber: r.batch_number, quantity: num(r.quantity), [priceKey]: num(r[col]), gstPercent: num(r.gst_percent), lineTotal: num(r.line_total),
});

export function returnsResolvers() {
  return {
    Query: {
      salesReturns: async (_p, { status, search, limit }, ctx) => {
        assertAuth(ctx);
        const { rows } = await query(
          `${SR_SELECT} WHERE ($1::text IS NULL OR sr.status=$1)
             AND ($2::text IS NULL OR sr.return_no ILIKE '%'||$2||'%' OR d.name ILIKE '%'||$2||'%')
           ORDER BY sr.created_at DESC LIMIT $3`,
          [str(status), str(search), Math.min(limit ?? 100, 1000)],
        );
        return rows.map(mapSR);
      },
      salesReturn: async (_p, { id }, ctx) => { assertAuth(ctx); const { rows } = await query(`${SR_SELECT} WHERE sr.id=$1`, [id]); return mapSR(rows[0]); },
      purchaseReturns: async (_p, { status, search, limit }, ctx) => {
        assertAuth(ctx);
        const { rows } = await query(
          `${PR_SELECT} WHERE ($1::text IS NULL OR pr.status=$1)
             AND ($2::text IS NULL OR pr.return_no ILIKE '%'||$2||'%' OR v.name ILIKE '%'||$2||'%')
           ORDER BY pr.created_at DESC LIMIT $3`,
          [str(status), str(search), Math.min(limit ?? 100, 1000)],
        );
        return rows.map(mapPR);
      },
      purchaseReturn: async (_p, { id }, ctx) => { assertAuth(ctx); const { rows } = await query(`${PR_SELECT} WHERE pr.id=$1`, [id]); return mapPR(rows[0]); },
      salesReturnSource: async (_p, { orderId, excludeReturnId }, ctx) => { assertAuth(ctx); return salesSource({ query }, orderId, excludeReturnId); },
      purchaseReturnSource: async (_p, { poId, excludeReturnId }, ctx) => { assertAuth(ctx); return purchaseSource({ query }, poId, excludeReturnId); },
      returnsStats: async (_p, _a, ctx) => {
        assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN');
        const { rows } = await query(
          `SELECT (SELECT COUNT(*) FROM sales_returns)::int sales_returns,
                  (SELECT COUNT(*) FROM purchase_returns)::int purchase_returns,
                  (SELECT COUNT(*) FROM sales_returns WHERE status='DRAFT')::int pending_sales,
                  (SELECT COUNT(*) FROM purchase_returns WHERE status='DRAFT')::int pending_purchase,
                  COALESCE((SELECT SUM(total_amount) FROM sales_returns WHERE status='APPROVED'),0) credit_issued,
                  COALESCE((SELECT SUM(total_amount) FROM purchase_returns WHERE status='APPROVED'),0) debit_issued`,
        );
        const r = rows[0];
        return {
          salesReturns: r.sales_returns, purchaseReturns: r.purchase_returns,
          pendingSales: r.pending_sales, pendingPurchase: r.pending_purchase,
          creditIssued: num(r.credit_issued), debitIssued: num(r.debit_issued),
        };
      },
    },

    Mutation: {
      createSalesReturn: async (_p, { input }, ctx) => {
        const a = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN', 'SALES');
        const orderId = str(input.orderId);
        return withTransaction(async (client) => {
          if (!(await client.query('SELECT id FROM distributors WHERE id=$1', [input.distributorId])).rows[0]) throw httpError('Distributor not found', 404);
          if (!(await client.query('SELECT id FROM warehouses WHERE id=$1', [input.warehouseId])).rows[0]) throw httpError('Warehouse not found', 404);
          let source = null;
          if (orderId) {
            const o = (await client.query('SELECT distributor_id FROM orders WHERE id=$1', [orderId])).rows[0];
            if (!o) throw httpError('Order not found', 404);
            if (o.distributor_id !== input.distributorId) throw httpError('That order belongs to a different distributor', 400);
            source = await salesSource(client, orderId);
          }
          const { prepared, subTotal, taxTotal } = await prepareLines(client, input.lines, 'unitPrice', source);
          const returnNo = `SRN-${fy()}-${String((await client.query("SELECT nextval('srn_seq') n")).rows[0].n).padStart(5, '0')}`;
          const sr = (await client.query(
            `INSERT INTO sales_returns (return_no, order_id, distributor_id, warehouse_id, reason, notes, sub_total, tax_total, total_amount, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
            [returnNo, orderId, input.distributorId, input.warehouseId, str(input.reason), str(input.notes), subTotal, taxTotal, round2(subTotal + taxTotal), a.sub],
          )).rows[0];
          for (const { l, p, gst, lineTotal } of prepared) {
            await client.query(
              `INSERT INTO sales_return_lines (return_id, product_id, product_name, packing_size, batch_number, quantity, unit_price, gst_percent, line_total)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
              [sr.id, l.productId, p.name, p.packing_size ?? null, str(l.batchNumber), l.quantity, l.unitPrice, gst, lineTotal],
            );
          }
          await logActivity(a.sub, 'CREATE_SALES_RETURN', 'sales_return', sr.id, { returnNo });
          return mapSR((await client.query(`${SR_SELECT} WHERE sr.id=$1`, [sr.id])).rows[0]);
        });
      },

      updateSalesReturn: async (_p, { id, input }, ctx) => {
        const a = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN', 'SALES');
        const orderId = str(input.orderId);
        const result = await withTransaction(async (client) => {
          const current = (await client.query('SELECT status FROM sales_returns WHERE id=$1 FOR UPDATE', [id])).rows[0];
          if (!current) throw httpError('Sales return not found', 404);
          if (current.status !== 'DRAFT') throw httpError('Only draft returns can be edited', 400);
          if (!(await client.query('SELECT id FROM distributors WHERE id=$1', [input.distributorId])).rows[0]) throw httpError('Distributor not found', 404);
          if (!(await client.query('SELECT id FROM warehouses WHERE id=$1', [input.warehouseId])).rows[0]) throw httpError('Warehouse not found', 404);
          let source = null;
          if (orderId) {
            const order = (await client.query('SELECT distributor_id FROM orders WHERE id=$1', [orderId])).rows[0];
            if (!order) throw httpError('Order not found', 404);
            if (order.distributor_id !== input.distributorId) throw httpError('That order belongs to a different distributor', 400);
            source = await salesSource(client, orderId, id);
          }
          const { prepared, subTotal, taxTotal } = await prepareLines(client, input.lines, 'unitPrice', source);
          await client.query(`UPDATE sales_returns SET order_id=$2, distributor_id=$3, warehouse_id=$4, reason=$5, notes=$6,
            sub_total=$7, tax_total=$8, total_amount=$9 WHERE id=$1`,
            [id, orderId, input.distributorId, input.warehouseId, str(input.reason), str(input.notes), subTotal, taxTotal, round2(subTotal + taxTotal)]);
          await client.query('DELETE FROM sales_return_lines WHERE return_id=$1', [id]);
          for (const { l, p, gst, lineTotal } of prepared) {
            await client.query(`INSERT INTO sales_return_lines (return_id, product_id, product_name, packing_size, batch_number, quantity, unit_price, gst_percent, line_total)
              VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
              [id, l.productId, p.name, p.packing_size ?? null, str(l.batchNumber), l.quantity, l.unitPrice, gst, lineTotal]);
          }
          return mapSR((await client.query(`${SR_SELECT} WHERE sr.id=$1`, [id])).rows[0]);
        });
        await logActivity(a.sub, 'UPDATE_SALES_RETURN', 'sales_return', id);
        return result;
      },

      deleteSalesReturn: async (_p, { id }, ctx) => {
        const a = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN', 'SALES');
        const { rows } = await query("DELETE FROM sales_returns WHERE id=$1 AND status='DRAFT' RETURNING id", [id]);
        if (!rows[0]) throw httpError('Only draft sales returns can be deleted', 400);
        await logActivity(a.sub, 'DELETE_SALES_RETURN', 'sales_return', id);
        return true;
      },

      approveSalesReturn: async (_p, { id }, ctx) => {
        const a = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN');
        return withTransaction(async (client) => {
          const sr = (await client.query('SELECT * FROM sales_returns WHERE id=$1 FOR UPDATE', [id])).rows[0];
          if (!sr) throw httpError('Sales return not found', 404);
          if (sr.status !== 'DRAFT') throw httpError('Only DRAFT returns can be approved', 400);
          if (!sr.warehouse_id) throw httpError('This return has no warehouse to restock into', 400);
          const lines = (await client.query('SELECT * FROM sales_return_lines WHERE return_id=$1', [id])).rows;

          // Goods back into stock.
          for (const ln of lines) {
            const batchNo = ln.batch_number || `RET-${sr.return_no}`;
            const batch = (await client.query(
              `INSERT INTO batches (product_id, batch_number) VALUES ($1,$2)
               ON CONFLICT (product_id, batch_number) DO UPDATE SET batch_number=EXCLUDED.batch_number RETURNING id`,
              [ln.product_id, batchNo],
            )).rows[0];
            await client.query(
              `INSERT INTO stock_levels (warehouse_id, product_id, batch_id, quantity)
               VALUES ($1,$2,$3,$4) ON CONFLICT (warehouse_id, product_id, batch_id) DO UPDATE SET
                 quantity = stock_levels.quantity + EXCLUDED.quantity, updated_at=now()`,
              [sr.warehouse_id, ln.product_id, batch.id, ln.quantity],
            );
            await client.query(
              `INSERT INTO stock_movements (warehouse_id, product_id, batch_id, movement_type, quantity, reason, ref_type, ref_id, created_by)
               VALUES ($1,$2,$3,'IN',$4,'Sales return','sales_return',$5,$6)`,
              [sr.warehouse_id, ln.product_id, batch.id, num(ln.quantity), sr.id, a.sub],
            );
          }

          // Credit note (GSTR-1 CDNR reason 01 "Sales Return") with tax captured per head, linked to the original invoice.
          let noteNo = null;
          const total = num(sr.total_amount);
          if (total > 0) {
            const ref = sr.order_id ? (await client.query(
              "SELECT id, is_interstate FROM invoices WHERE order_id=$1 AND status <> 'CANCELLED' ORDER BY created_at DESC LIMIT 1", [sr.order_id])).rows[0] : null;
            let interstate = ref ? !!ref.is_interstate : false;
            if (!ref) {
              const co = (await client.query('SELECT gstin, state FROM company_settings WHERE id = 1')).rows[0] || {};
              const d = (await client.query('SELECT gstin, state FROM distributors WHERE id=$1', [sr.distributor_id])).rows[0] || {};
              const cs = resolveStateCode({ gstin: co.gstin, stateName: co.state }), ds = resolveStateCode({ gstin: d.gstin, stateName: d.state });
              interstate = !!cs && !!ds && cs !== ds;
            }
            const heads = { igst: 0, cgst: 0, sgst: 0 };
            for (const ln of lines) {
              const t = splitTax(num(ln.line_total), num(ln.gst_percent), interstate);
              heads.igst += t.igst; heads.cgst += t.cgst; heads.sgst += t.sgst;
            }
            const rates = [...new Set(lines.map((l) => num(l.gst_percent)))];
            noteNo = `CN-${fy()}-${String((await client.query("SELECT nextval('note_seq') n")).rows[0].n).padStart(5, '0')}`;
            await client.query(
              `INSERT INTO credit_debit_notes (note_no, distributor_id, note_type, amount, taxable_value, gst_rate, cgst, sgst, igst, is_interstate, note_reason, reason, ref_invoice_id, created_by)
               VALUES ($1,$2,'CREDIT',$3,$4,$5,$6,$7,$8,$9,'01',$10,$11,$12)`,
              [noteNo, sr.distributor_id, total, num(sr.sub_total), rates.length === 1 ? rates[0] : null,
                roundGst(heads.cgst), roundGst(heads.sgst), roundGst(heads.igst), interstate, `Sales return ${sr.return_no}`, ref?.id ?? null, a.sub],
            );
            await client.query('UPDATE distributors SET outstanding = GREATEST(outstanding - $2, 0) WHERE id=$1', [sr.distributor_id, total]);
          }
          await client.query("UPDATE sales_returns SET status='APPROVED', credit_note_no=$2, approved_at=now() WHERE id=$1", [id, noteNo]);
          await logActivity(a.sub, 'APPROVE_SALES_RETURN', 'sales_return', id, { noteNo });
          return mapSR((await client.query(`${SR_SELECT} WHERE sr.id=$1`, [id])).rows[0]);
        });
      },

      cancelSalesReturn: async (_p, { id }, ctx) => {
        const a = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN');
        const { rows } = await query("UPDATE sales_returns SET status='CANCELLED' WHERE id=$1 AND status='DRAFT' RETURNING id", [id]);
        if (!rows[0]) throw httpError('Only DRAFT returns can be cancelled', 400);
        await logActivity(a.sub, 'CANCEL_SALES_RETURN', 'sales_return', id);
        return mapSR((await query(`${SR_SELECT} WHERE sr.id=$1`, [id])).rows[0]);
      },

      createPurchaseReturn: async (_p, { input }, ctx) => {
        const a = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN');
        const poId = str(input.poId);
        return withTransaction(async (client) => {
          if (!(await client.query('SELECT id FROM vendors WHERE id=$1', [input.vendorId])).rows[0]) throw httpError('Vendor not found', 404);
          if (!(await client.query('SELECT id FROM warehouses WHERE id=$1', [input.warehouseId])).rows[0]) throw httpError('Warehouse not found', 404);
          let source = null;
          if (poId) {
            const po = (await client.query('SELECT vendor_id FROM purchase_orders WHERE id=$1', [poId])).rows[0];
            if (!po) throw httpError('PO not found', 404);
            if (po.vendor_id !== input.vendorId) throw httpError('That PO belongs to a different vendor', 400);
            source = await purchaseSource(client, poId);
          }
          const { prepared, subTotal, taxTotal } = await prepareLines(client, input.lines, 'unitCost', source);
          const returnNo = `PRN-${fy()}-${String((await client.query("SELECT nextval('prn_seq') n")).rows[0].n).padStart(5, '0')}`;
          const pr = (await client.query(
            `INSERT INTO purchase_returns (return_no, po_id, vendor_id, warehouse_id, reason, notes, sub_total, tax_total, total_amount, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
            [returnNo, poId, input.vendorId, input.warehouseId, str(input.reason), str(input.notes), subTotal, taxTotal, round2(subTotal + taxTotal), a.sub],
          )).rows[0];
          for (const { l, p, gst, lineTotal } of prepared) {
            await client.query(
              `INSERT INTO purchase_return_lines (return_id, product_id, product_name, packing_size, batch_number, quantity, unit_cost, gst_percent, line_total)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
              [pr.id, l.productId, p.name, p.packing_size ?? null, str(l.batchNumber), l.quantity, l.unitCost, gst, lineTotal],
            );
          }
          await logActivity(a.sub, 'CREATE_PURCHASE_RETURN', 'purchase_return', pr.id, { returnNo });
          return mapPR((await client.query(`${PR_SELECT} WHERE pr.id=$1`, [pr.id])).rows[0]);
        });
      },

      updatePurchaseReturn: async (_p, { id, input }, ctx) => {
        const a = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN');
        const poId = str(input.poId);
        const result = await withTransaction(async (client) => {
          const current = (await client.query('SELECT status FROM purchase_returns WHERE id=$1 FOR UPDATE', [id])).rows[0];
          if (!current) throw httpError('Purchase return not found', 404);
          if (current.status !== 'DRAFT') throw httpError('Only draft returns can be edited', 400);
          if (!(await client.query('SELECT id FROM vendors WHERE id=$1', [input.vendorId])).rows[0]) throw httpError('Vendor not found', 404);
          if (!(await client.query('SELECT id FROM warehouses WHERE id=$1', [input.warehouseId])).rows[0]) throw httpError('Warehouse not found', 404);
          let source = null;
          if (poId) {
            const po = (await client.query('SELECT vendor_id FROM purchase_orders WHERE id=$1', [poId])).rows[0];
            if (!po) throw httpError('PO not found', 404);
            if (po.vendor_id !== input.vendorId) throw httpError('That PO belongs to a different vendor', 400);
            source = await purchaseSource(client, poId, id);
          }
          const { prepared, subTotal, taxTotal } = await prepareLines(client, input.lines, 'unitCost', source);
          await client.query(`UPDATE purchase_returns SET po_id=$2, vendor_id=$3, warehouse_id=$4, reason=$5, notes=$6,
            sub_total=$7, tax_total=$8, total_amount=$9 WHERE id=$1`,
            [id, poId, input.vendorId, input.warehouseId, str(input.reason), str(input.notes), subTotal, taxTotal, round2(subTotal + taxTotal)]);
          await client.query('DELETE FROM purchase_return_lines WHERE return_id=$1', [id]);
          for (const { l, p, gst, lineTotal } of prepared) {
            await client.query(`INSERT INTO purchase_return_lines (return_id, product_id, product_name, packing_size, batch_number, quantity, unit_cost, gst_percent, line_total)
              VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
              [id, l.productId, p.name, p.packing_size ?? null, str(l.batchNumber), l.quantity, l.unitCost, gst, lineTotal]);
          }
          return mapPR((await client.query(`${PR_SELECT} WHERE pr.id=$1`, [id])).rows[0]);
        });
        await logActivity(a.sub, 'UPDATE_PURCHASE_RETURN', 'purchase_return', id);
        return result;
      },

      deletePurchaseReturn: async (_p, { id }, ctx) => {
        const a = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN');
        const { rows } = await query("DELETE FROM purchase_returns WHERE id=$1 AND status='DRAFT' RETURNING id", [id]);
        if (!rows[0]) throw httpError('Only draft purchase returns can be deleted', 400);
        await logActivity(a.sub, 'DELETE_PURCHASE_RETURN', 'purchase_return', id);
        return true;
      },

      approvePurchaseReturn: async (_p, { id }, ctx) => {
        const a = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN');
        return withTransaction(async (client) => {
          const pr = (await client.query('SELECT * FROM purchase_returns WHERE id=$1 FOR UPDATE', [id])).rows[0];
          if (!pr) throw httpError('Purchase return not found', 404);
          if (pr.status !== 'DRAFT') throw httpError('Only DRAFT returns can be approved', 400);
          if (!pr.warehouse_id) throw httpError('This return has no warehouse to take stock from', 400);
          const lines = (await client.query('SELECT * FROM purchase_return_lines WHERE return_id=$1', [id])).rows;

          // Goods out of stock (prefer the named batch, else FIFO by expiry).
          for (const ln of lines) {
            let remaining = num(ln.quantity);
            const stock = (await client.query(
              `SELECT sl.*, b.batch_number FROM stock_levels sl JOIN batches b ON b.id = sl.batch_id
               WHERE sl.product_id=$1 AND sl.warehouse_id=$2 AND sl.quantity>0
               ORDER BY (b.batch_number = $3) DESC, b.expiry_date ASC NULLS LAST FOR UPDATE OF sl`,
              [ln.product_id, pr.warehouse_id, ln.batch_number ?? ''],
            )).rows;
            const avail = round3(stock.reduce((s, r) => s + num(r.quantity), 0));
            if (avail < remaining - 0.0005) throw httpError(`Insufficient stock to return ${ln.product_name}: need ${remaining}, have ${avail} in this warehouse`, 400);
            for (const sl of stock) {
              if (remaining <= 0.0005) break;
              const take = round3(Math.min(num(sl.quantity), remaining));
              await client.query('UPDATE stock_levels SET quantity = quantity - $2, updated_at=now() WHERE id=$1', [sl.id, take]);
              await client.query(
                `INSERT INTO stock_movements (warehouse_id, product_id, batch_id, movement_type, quantity, reason, ref_type, ref_id, created_by)
                 VALUES ($1,$2,$3,'OUT',$4,'Purchase return','purchase_return',$5,$6)`,
                [pr.warehouse_id, ln.product_id, sl.batch_id, -take, pr.id, a.sub],
              );
              remaining = round3(remaining - take);
            }
          }

          // Debit note -> reduces vendor payable.
          const noteNo = `DN-${fy()}-${String((await client.query("SELECT nextval('prn_seq') n")).rows[0].n).padStart(5, '0')}`;
          await client.query('UPDATE vendors SET outstanding = GREATEST(outstanding - $2, 0) WHERE id=$1', [pr.vendor_id, num(pr.total_amount)]);
          await client.query("UPDATE purchase_returns SET status='APPROVED', debit_note_no=$2, approved_at=now() WHERE id=$1", [id, noteNo]);
          await logActivity(a.sub, 'APPROVE_PURCHASE_RETURN', 'purchase_return', id, { noteNo });
          return mapPR((await client.query(`${PR_SELECT} WHERE pr.id=$1`, [id])).rows[0]);
        });
      },

      cancelPurchaseReturn: async (_p, { id }, ctx) => {
        const a = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN');
        const { rows } = await query("UPDATE purchase_returns SET status='CANCELLED' WHERE id=$1 AND status='DRAFT' RETURNING id", [id]);
        if (!rows[0]) throw httpError('Only DRAFT returns can be cancelled', 400);
        await logActivity(a.sub, 'CANCEL_PURCHASE_RETURN', 'purchase_return', id);
        return mapPR((await query(`${PR_SELECT} WHERE pr.id=$1`, [id])).rows[0]);
      },
    },

    SalesReturn: {
      lines: async (parent) => {
        const { rows } = await query('SELECT l.*, p.uom FROM sales_return_lines l LEFT JOIN products p ON p.id = l.product_id WHERE l.return_id=$1 ORDER BY l.product_name', [parent.id]);
        return rows.map((r) => lineOut(r, 'unitPrice', 'unit_price'));
      },
    },
    PurchaseReturn: {
      lines: async (parent) => {
        const { rows } = await query('SELECT l.*, p.uom FROM purchase_return_lines l LEFT JOIN products p ON p.id = l.product_id WHERE l.return_id=$1 ORDER BY l.product_name', [parent.id]);
        return rows.map((r) => lineOut(r, 'unitCost', 'unit_cost'));
      },
    },
  };
}
