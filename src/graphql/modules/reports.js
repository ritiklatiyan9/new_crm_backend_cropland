// GraphQL module: Reports & Analytics (PRD §11).
// Read-only aggregations over existing transactional data.

import { query } from '../../db/index.js';
import { assertRole } from '../context.js';
import { num, isoDate } from '../helpers.js';

export const reportTypeDefs = /* GraphQL */ `
  type SalesByProductRow { productName: String!, hsnCode: String, qty: Float!, taxable: Float!, tax: Float!, total: Float! }
  type SalesByDistributorRow { distributorName: String!, orders: Int!, total: Float! }
  type AgingRow { distributorName: String!, b0_30: Float!, b30_60: Float!, b60_90: Float!, b90: Float!, total: Float! }
  type InventoryValuationRow { productName: String!, sku: String!, qty: Float!, rate: Float!, value: Float! }
  type ExpiryRow { productName: String!, sku: String!, batchNumber: String!, expiryDate: String, quantity: Float!, warehouseName: String! }
  type SlowMovingRow { productName: String!, sku: String!, qty: Float!, lastOut: String }
  type LowStockRow { productName: String!, sku: String!, warehouseName: String!, quantity: Float!, reorderLevel: Float! }
  type GstRegisterRow { invoiceNo: String!, invoiceDate: String!, billType: String!, distributorName: String!, gstin: String, taxable: Float!, cgst: Float!, sgst: Float!, igst: Float!, total: Float!, irn: String, ewayBillNo: String }
  type HsnSummaryRow { hsnCode: String, qty: Float!, taxable: Float!, tax: Float! }
  type TopFarmerRow { name: String!, farmerCode: String!, balance: Int! }
  type LoyaltyReport { pointsIssued: Int!, pointsRedeemed: Int!, redemptionRate: Float!, liability: Int!, topFarmers: [TopFarmerRow!]! }

  extend type Query {
    rptSalesByProduct(dateFrom: String, dateTo: String): [SalesByProductRow!]!
    rptSalesByDistributor(dateFrom: String, dateTo: String): [SalesByDistributorRow!]!
    rptOutstandingAging: [AgingRow!]!
    rptInventoryValuation: [InventoryValuationRow!]!
    rptNearExpiry(days: Int = 30): [ExpiryRow!]!
    rptSlowMoving(days: Int = 60): [SlowMovingRow!]!
    rptLowStock: [LowStockRow!]!
    rptGstRegister(dateFrom: String, dateTo: String): [GstRegisterRow!]!
    rptHsnSummary(dateFrom: String, dateTo: String): [HsnSummaryRow!]!
    rptLoyalty: LoyaltyReport!
  }
`;

const guard = (ctx) => assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN', 'SALES');

export function reportResolvers() {
  return {
    Query: {
      rptSalesByProduct: async (_p, { dateFrom, dateTo }, ctx) => {
        guard(ctx);
        const { rows } = await query(
          `SELECT ol.product_name, ol.hsn_code,
                  SUM(ol.quantity) qty, SUM(ol.line_total) taxable,
                  SUM(ol.line_total * ol.gst_percent / 100) tax
           FROM order_lines ol JOIN orders o ON o.id = ol.order_id
           WHERE o.status <> 'CANCELLED'
             AND ($1::date IS NULL OR o.order_date >= $1) AND ($2::date IS NULL OR o.order_date <= $2)
           GROUP BY ol.product_name, ol.hsn_code ORDER BY taxable DESC`,
          [dateFrom ?? null, dateTo ?? null],
        );
        return rows.map((r) => ({
          productName: r.product_name, hsnCode: r.hsn_code, qty: num(r.qty),
          taxable: num(r.taxable), tax: num(r.tax), total: num(r.taxable) + num(r.tax),
        }));
      },

      rptSalesByDistributor: async (_p, { dateFrom, dateTo }, ctx) => {
        guard(ctx);
        const { rows } = await query(
          `SELECT d.name, COUNT(o.id)::int orders, SUM(o.total_amount) total
           FROM orders o JOIN distributors d ON d.id = o.distributor_id
           WHERE o.status <> 'CANCELLED'
             AND ($1::date IS NULL OR o.order_date >= $1) AND ($2::date IS NULL OR o.order_date <= $2)
           GROUP BY d.name ORDER BY total DESC`,
          [dateFrom ?? null, dateTo ?? null],
        );
        return rows.map((r) => ({ distributorName: r.name, orders: r.orders, total: num(r.total) }));
      },

      rptOutstandingAging: async (_p, _a, ctx) => {
        guard(ctx);
        const { rows } = await query(
          `SELECT d.name,
             SUM(CASE WHEN age <= 30 THEN bal ELSE 0 END) b0_30,
             SUM(CASE WHEN age > 30 AND age <= 60 THEN bal ELSE 0 END) b30_60,
             SUM(CASE WHEN age > 60 AND age <= 90 THEN bal ELSE 0 END) b60_90,
             SUM(CASE WHEN age > 90 THEN bal ELSE 0 END) b90,
             SUM(bal) total
           FROM (
             SELECT i.distributor_id, (i.total_amount - i.amount_paid) bal,
                    (CURRENT_DATE - i.invoice_date) age
             FROM invoices i WHERE i.total_amount > i.amount_paid AND i.status <> 'CANCELLED'
           ) x JOIN distributors d ON d.id = x.distributor_id
           GROUP BY d.name HAVING SUM(bal) > 0 ORDER BY total DESC`,
        );
        return rows.map((r) => ({
          distributorName: r.name, b0_30: num(r.b0_30), b30_60: num(r.b30_60),
          b60_90: num(r.b60_90), b90: num(r.b90), total: num(r.total),
        }));
      },

      rptInventoryValuation: async (_p, _a, ctx) => {
        guard(ctx);
        const { rows } = await query(
          `SELECT p.name, p.sku, SUM(sl.quantity) qty, COALESCE(p.distributor_price,0) rate,
                  SUM(sl.quantity) * COALESCE(p.distributor_price,0) value
           FROM stock_levels sl JOIN products p ON p.id = sl.product_id
           GROUP BY p.id, p.name, p.sku, p.distributor_price ORDER BY value DESC`,
        );
        return rows.map((r) => ({ productName: r.name, sku: r.sku, qty: num(r.qty), rate: num(r.rate), value: num(r.value) }));
      },

      rptNearExpiry: async (_p, { days }, ctx) => {
        guard(ctx);
        const { rows } = await query(
          `SELECT p.name, p.sku, b.batch_number, b.expiry_date, sl.quantity, w.name wname
           FROM stock_levels sl JOIN batches b ON b.id = sl.batch_id
             JOIN products p ON p.id = sl.product_id JOIN warehouses w ON w.id = sl.warehouse_id
           WHERE sl.quantity > 0 AND b.expiry_date IS NOT NULL
             AND b.expiry_date <= CURRENT_DATE + ($1 || ' days')::interval
           ORDER BY b.expiry_date ASC`,
          [days],
        );
        return rows.map((r) => ({
          productName: r.name, sku: r.sku, batchNumber: r.batch_number,
          expiryDate: isoDate(r.expiry_date), quantity: num(r.quantity), warehouseName: r.wname,
        }));
      },

      rptSlowMoving: async (_p, { days }, ctx) => {
        guard(ctx);
        const { rows } = await query(
          `SELECT p.name, p.sku, SUM(sl.quantity) qty, m.last_out
           FROM stock_levels sl JOIN products p ON p.id = sl.product_id
           LEFT JOIN (SELECT product_id, MAX(created_at) last_out FROM stock_movements WHERE movement_type = 'OUT' GROUP BY product_id) m
             ON m.product_id = sl.product_id
           WHERE sl.quantity > 0
           GROUP BY p.id, p.name, p.sku, m.last_out
           HAVING m.last_out IS NULL OR m.last_out < now() - ($1 || ' days')::interval
           ORDER BY qty DESC`,
          [days],
        );
        return rows.map((r) => ({ productName: r.name, sku: r.sku, qty: num(r.qty), lastOut: r.last_out ? new Date(r.last_out).toISOString().slice(0, 10) : null }));
      },

      rptLowStock: async (_p, _a, ctx) => {
        guard(ctx);
        const { rows } = await query(
          `SELECT p.name, p.sku, w.name wname, sl.quantity, sl.reorder_level
           FROM stock_levels sl JOIN products p ON p.id = sl.product_id JOIN warehouses w ON w.id = sl.warehouse_id
           WHERE sl.quantity <= sl.reorder_level ORDER BY sl.quantity ASC`,
        );
        return rows.map((r) => ({ productName: r.name, sku: r.sku, warehouseName: r.wname, quantity: num(r.quantity), reorderLevel: num(r.reorder_level) }));
      },

      rptGstRegister: async (_p, { dateFrom, dateTo }, ctx) => {
        guard(ctx);
        const { rows } = await query(
          `SELECT i.invoice_no, i.invoice_date, i.bill_type, d.name dname, d.gstin,
                  i.taxable_value, i.cgst, i.sgst, i.igst, i.total_amount, i.irn, i.eway_bill_no
           FROM invoices i JOIN distributors d ON d.id = i.distributor_id
           WHERE i.status <> 'CANCELLED'
             AND ($1::date IS NULL OR i.invoice_date >= $1) AND ($2::date IS NULL OR i.invoice_date <= $2)
           ORDER BY i.invoice_date DESC, i.invoice_no DESC`,
          [dateFrom ?? null, dateTo ?? null],
        );
        return rows.map((r) => ({
          invoiceNo: r.invoice_no, invoiceDate: isoDate(r.invoice_date), billType: r.bill_type,
          distributorName: r.dname, gstin: r.gstin, taxable: num(r.taxable_value),
          cgst: num(r.cgst), sgst: num(r.sgst), igst: num(r.igst), total: num(r.total_amount),
          irn: r.irn, ewayBillNo: r.eway_bill_no,
        }));
      },

      rptHsnSummary: async (_p, { dateFrom, dateTo }, ctx) => {
        guard(ctx);
        const { rows } = await query(
          `SELECT ol.hsn_code, SUM(ol.quantity) qty, SUM(ol.line_total) taxable,
                  SUM(ol.line_total * ol.gst_percent / 100) tax
           FROM order_lines ol JOIN orders o ON o.id = ol.order_id JOIN invoices i ON i.order_id = o.id
           WHERE i.bill_type = 'GST' AND i.status <> 'CANCELLED'
             AND ($1::date IS NULL OR i.invoice_date >= $1) AND ($2::date IS NULL OR i.invoice_date <= $2)
           GROUP BY ol.hsn_code ORDER BY taxable DESC`,
          [dateFrom ?? null, dateTo ?? null],
        );
        return rows.map((r) => ({ hsnCode: r.hsn_code, qty: num(r.qty), taxable: num(r.taxable), tax: num(r.tax) }));
      },

      rptLoyalty: async (_p, _a, ctx) => {
        guard(ctx);
        const t = await query(
          `SELECT COALESCE(SUM(points) FILTER (WHERE points > 0),0)::int issued,
                  COALESCE(-SUM(points) FILTER (WHERE points < 0),0)::int redeemed
           FROM loyalty_transactions`,
        );
        const liab = await query('SELECT COALESCE(SUM(points_balance),0)::int bal FROM farmers');
        const top = await query('SELECT name, farmer_code, points_balance FROM farmers ORDER BY points_balance DESC LIMIT 10');
        const issued = t.rows[0].issued;
        const redeemed = t.rows[0].redeemed;
        return {
          pointsIssued: issued,
          pointsRedeemed: redeemed,
          redemptionRate: issued > 0 ? Math.round((redeemed / issued) * 1000) / 10 : 0,
          liability: liab.rows[0].bal,
          topFarmers: top.rows.map((r) => ({ name: r.name, farmerCode: r.farmer_code, balance: r.points_balance })),
        };
      },
    },
  };
}
