// GraphQL module: Inventory (PRD §6) — multi-warehouse, batch-aware stock.
// Phase 1 inflow is manual stock-in (GRN); stock-out happens on dispatch later.

import { query, withTransaction } from '../../db/index.js';
import { assertAuth, assertRole } from '../context.js';
import { httpError, logActivity, num, isoDate } from '../helpers.js';

export const inventoryTypeDefs = /* GraphQL */ `
  type Warehouse {
    id: ID!
    name: String!
    code: String
    branchId: ID
    isActive: Boolean!
    createdAt: DateTime!
  }

  type StockLevel {
    id: ID!
    warehouseId: ID!
    warehouseName: String!
    productId: ID!
    productName: String!
    productSku: String!
    uom: String
    batchId: ID!
    batchNumber: String!
    expiryDate: String
    quantity: Float!
    reserved: Float!
    available: Float!
    reorderLevel: Float!
    isLow: Boolean!
    unitPrice: Float!     # valuation price (distributor → dealer → MRP)
    stockValue: Float!    # unitPrice × available quantity
    updatedAt: DateTime!
  }

  type StockMovement {
    id: ID!
    warehouseName: String
    productName: String
    batchNumber: String
    movementType: String!
    quantity: Float!
    reason: String
    createdAt: DateTime!
    # Counterparty / document this movement relates to (e.g. who the stock was billed to).
    refType: String
    documentNo: String
    invoiceId: ID         # the bill/invoice for this dispatch, if any
    recipientType: String
    recipientName: String
    recipientPhone: String
    recipientContact: String
    recipientGstin: String
  }

  type InventoryStats {
    skuLines: Int!
    totalUnits: Float!
    lowStock: Int!
    expiringSoon: Int!
  }

  input WarehouseInput {
    name: String!
    code: String
    branchId: ID
  }

  input StockInInput {
    warehouseId: ID!
    productId: ID!
    batchNumber: String!
    manufacturingDate: String
    expiryDate: String
    quantity: Float!
    reorderLevel: Float = 0
  }

  input StockAdjustInput {
    stockLevelId: ID!
    quantityDelta: Float!
    reason: String!
  }

  extend type Query {
    warehouses(activeOnly: Boolean): [Warehouse!]!
    stockLevels(warehouseId: ID, productId: ID, search: String, lowOnly: Boolean, expiringDays: Int): [StockLevel!]!
    stockMovements(productId: ID, limit: Int = 50): [StockMovement!]!
    inventoryStats: InventoryStats!
  }

  extend type Mutation {
    createWarehouse(input: WarehouseInput!): Warehouse!
    stockIn(input: StockInInput!): StockLevel!
    stockAdjust(input: StockAdjustInput!): StockLevel!
  }
`;

const mapWarehouse = (r) =>
  r && {
    id: r.id,
    name: r.name,
    code: r.code,
    branchId: r.branch_id,
    isActive: r.is_active,
    createdAt: r.created_at,
  };

const mapStock = (r) => {
  const available = (num(r.quantity) ?? 0) - (num(r.reserved) ?? 0);
  const unitPrice = num(r.distributor_price) ?? num(r.dealer_price) ?? num(r.mrp) ?? 0;
  return {
    id: r.id,
    warehouseId: r.warehouse_id,
    warehouseName: r.warehouse_name,
    productId: r.product_id,
    productName: r.product_name,
    productSku: r.product_sku,
    uom: r.uom,
    batchId: r.batch_id,
    batchNumber: r.batch_number,
    expiryDate: isoDate(r.expiry_date),
    quantity: num(r.quantity) ?? 0,
    reserved: num(r.reserved) ?? 0,
    available,
    reorderLevel: num(r.reorder_level) ?? 0,
    isLow: (num(r.quantity) ?? 0) <= (num(r.reorder_level) ?? 0),
    unitPrice,
    stockValue: Math.round(unitPrice * available * 100) / 100,
    updatedAt: r.updated_at,
  };
};

const STOCK_SELECT = `
  SELECT sl.*, w.name AS warehouse_name, p.name AS product_name, p.sku AS product_sku, p.uom AS uom,
         p.distributor_price, p.dealer_price, p.mrp,
         b.batch_number, b.expiry_date
  FROM stock_levels sl
  JOIN warehouses w ON w.id = sl.warehouse_id
  JOIN products p ON p.id = sl.product_id
  JOIN batches b ON b.id = sl.batch_id
`;

export function inventoryResolvers() {
  return {
    Query: {
      warehouses: async (_p, { activeOnly }, ctx) => {
        assertAuth(ctx);
        const { rows } = await query(
          `SELECT * FROM warehouses WHERE ($1::bool IS NULL OR is_active = $1) ORDER BY name ASC`,
          [activeOnly ?? null],
        );
        return rows.map(mapWarehouse);
      },
      stockLevels: async (_p, { warehouseId, productId, search, lowOnly, expiringDays }, ctx) => {
        assertAuth(ctx);
        const { rows } = await query(
          `${STOCK_SELECT}
           WHERE ($1::uuid IS NULL OR sl.warehouse_id = $1)
             AND ($2::uuid IS NULL OR sl.product_id = $2)
             AND ($3::text IS NULL OR p.name ILIKE '%' || $3 || '%' OR p.sku ILIKE '%' || $3 || '%' OR b.batch_number ILIKE '%' || $3 || '%')
             AND ($4::bool IS NOT TRUE OR sl.quantity <= sl.reorder_level)
             AND ($5::int IS NULL OR (b.expiry_date IS NOT NULL AND b.expiry_date <= CURRENT_DATE + ($5 || ' days')::interval))
           ORDER BY p.name ASC, b.expiry_date ASC NULLS LAST`,
          [warehouseId ?? null, productId ?? null, search ?? null, lowOnly ?? null, expiringDays ?? null],
        );
        return rows.map(mapStock);
      },
      stockMovements: async (_p, { productId, limit }, ctx) => {
        assertAuth(ctx);
        // OUT movements carry ref_id = order_id (dispatch on invoice). Resolve the
        // order's counterparty (distributor or farmer) so the timeline shows who got the stock.
        const { rows } = await query(
          `SELECT m.*, w.name AS warehouse_name, p.name AS product_name, b.batch_number,
                  o.order_no AS document_no, o.customer_type, iv.id AS invoice_id,
                  d.name AS distributor_name, d.phone AS distributor_phone,
                  d.contact_person AS distributor_contact, d.gstin AS distributor_gstin,
                  f.name AS farmer_name, f.phone AS farmer_phone, f.village AS farmer_village
           FROM stock_movements m
           JOIN warehouses w ON w.id = m.warehouse_id
           JOIN products p ON p.id = m.product_id
           LEFT JOIN batches b ON b.id = m.batch_id
           LEFT JOIN orders o ON m.ref_type = 'invoice' AND o.id = m.ref_id
           LEFT JOIN invoices iv ON iv.order_id = m.ref_id AND m.ref_type = 'invoice'
           LEFT JOIN distributors d ON o.customer_type <> 'FARMER' AND d.id = o.distributor_id
           LEFT JOIN farmers f ON o.customer_type = 'FARMER' AND f.id = o.farmer_id
           WHERE ($1::uuid IS NULL OR m.product_id = $1)
           ORDER BY m.created_at DESC LIMIT $2`,
          [productId ?? null, limit],
        );
        return rows.map((r) => {
          const isFarmer = r.customer_type === 'FARMER';
          return {
            id: r.id,
            warehouseName: r.warehouse_name,
            productName: r.product_name,
            batchNumber: r.batch_number,
            movementType: r.movement_type,
            quantity: num(r.quantity),
            reason: r.reason,
            createdAt: r.created_at,
            refType: r.ref_type,
            documentNo: r.document_no ?? null,
            invoiceId: r.invoice_id ?? null,
            recipientType: r.document_no ? (isFarmer ? 'FARMER' : 'DISTRIBUTOR') : null,
            recipientName: isFarmer ? r.farmer_name : r.distributor_name,
            recipientPhone: isFarmer ? r.farmer_phone : r.distributor_phone,
            recipientContact: isFarmer ? r.farmer_village : r.distributor_contact,
            recipientGstin: isFarmer ? null : r.distributor_gstin,
          };
        });
      },
      inventoryStats: async (_p, _a, ctx) => {
        assertAuth(ctx);
        const { rows } = await query(
          `SELECT
             COUNT(*)::int AS sku_lines,
             COALESCE(SUM(sl.quantity),0) AS total_units,
             COUNT(*) FILTER (WHERE sl.quantity <= sl.reorder_level)::int AS low_stock,
             COUNT(*) FILTER (WHERE b.expiry_date IS NOT NULL AND b.expiry_date <= CURRENT_DATE + INTERVAL '30 days')::int AS expiring_soon
           FROM stock_levels sl JOIN batches b ON b.id = sl.batch_id`,
        );
        return {
          skuLines: rows[0].sku_lines,
          totalUnits: num(rows[0].total_units) ?? 0,
          lowStock: rows[0].low_stock,
          expiringSoon: rows[0].expiring_soon,
        };
      },
    },

    Mutation: {
      createWarehouse: async (_p, { input }, ctx) => {
        const actor = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN');
        const { rows } = await query(
          `INSERT INTO warehouses (name, code, branch_id) VALUES ($1,$2,$3) RETURNING *`,
          [input.name, input.code ?? null, input.branchId ?? null],
        );
        await logActivity(actor.sub, 'CREATE_WAREHOUSE', 'warehouse', rows[0].id);
        return mapWarehouse(rows[0]);
      },

      stockIn: async (_p, { input }, ctx) => {
        const actor = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN');
        if (input.quantity <= 0) throw httpError('Quantity must be positive', 400);
        return withTransaction(async (client) => {
          // find or create the batch for this product
          const batch = await client.query(
            `INSERT INTO batches (product_id, batch_number, manufacturing_date, expiry_date)
             VALUES ($1,$2,$3,$4)
             ON CONFLICT (product_id, batch_number) DO UPDATE SET
               manufacturing_date = COALESCE(EXCLUDED.manufacturing_date, batches.manufacturing_date),
               expiry_date = COALESCE(EXCLUDED.expiry_date, batches.expiry_date)
             RETURNING id`,
            [input.productId, input.batchNumber, input.manufacturingDate ?? null, input.expiryDate ?? null],
          );
          const batchId = batch.rows[0].id;

          // upsert stock level
          await client.query(
            `INSERT INTO stock_levels (warehouse_id, product_id, batch_id, quantity, reorder_level)
             VALUES ($1,$2,$3,$4,$5)
             ON CONFLICT (warehouse_id, product_id, batch_id) DO UPDATE SET
               quantity = stock_levels.quantity + EXCLUDED.quantity,
               reorder_level = EXCLUDED.reorder_level,
               updated_at = now()`,
            [input.warehouseId, input.productId, batchId, input.quantity, input.reorderLevel ?? 0],
          );

          await client.query(
            `INSERT INTO stock_movements (warehouse_id, product_id, batch_id, movement_type, quantity, reason, ref_type, created_by)
             VALUES ($1,$2,$3,'IN',$4,'Stock in (GRN)','grn',$5)`,
            [input.warehouseId, input.productId, batchId, input.quantity, actor.sub],
          );

          const { rows } = await client.query(
            `${STOCK_SELECT} WHERE sl.warehouse_id=$1 AND sl.product_id=$2 AND sl.batch_id=$3`,
            [input.warehouseId, input.productId, batchId],
          );
          return mapStock(rows[0]);
        });
      },

      stockAdjust: async (_p, { input }, ctx) => {
        const actor = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN');
        return withTransaction(async (client) => {
          const cur = await client.query('SELECT * FROM stock_levels WHERE id = $1 FOR UPDATE', [
            input.stockLevelId,
          ]);
          if (!cur.rows[0]) throw httpError('Stock line not found', 404);
          const newQty = num(cur.rows[0].quantity) + input.quantityDelta;
          if (newQty < 0) throw httpError('Adjustment would make stock negative', 400);
          await client.query(
            'UPDATE stock_levels SET quantity = $2, updated_at = now() WHERE id = $1',
            [input.stockLevelId, newQty],
          );
          await client.query(
            `INSERT INTO stock_movements (warehouse_id, product_id, batch_id, movement_type, quantity, reason, ref_type, created_by)
             VALUES ($1,$2,$3,'ADJUST',$4,$5,'adjust',$6)`,
            [
              cur.rows[0].warehouse_id,
              cur.rows[0].product_id,
              cur.rows[0].batch_id,
              input.quantityDelta,
              input.reason,
              actor.sub,
            ],
          );
          const { rows } = await client.query(`${STOCK_SELECT} WHERE sl.id = $1`, [input.stockLevelId]);
          await logActivity(actor.sub, 'STOCK_ADJUST', 'stock_level', input.stockLevelId, {
            delta: input.quantityDelta,
          });
          return mapStock(rows[0]);
        });
      },
    },
  };
}
