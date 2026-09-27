// GraphQL module: Manufacturing ERP (PRD §5) — robust edition.
// Multi-level Bill of Materials + recursive cost rollup, Production Orders
// (FIFO raw-material consumption, costing), and QC with Certificate of Analysis.

import { query, withTransaction } from '../../db/index.js';
import { assertAuth, assertRole } from '../context.js';
import { httpError, logActivity, num, isoDate } from '../helpers.js';
import { statutoryQty } from '../../services/units.js';

export const manufacturingTypeDefs = /* GraphQL */ `
  type BomComponent {
    id: ID!
    componentProductId: ID!
    componentName: String!
    uom: String
    packingSize: String
    quantity: Float!           # in the component's UOM (e.g. 0.2 L), not packs
    isManufactured: Boolean!   # component is itself produced from a sub-BOM
    unitCost: Float!           # per UOM (₹/L, ₹/kg)
    lineCost: Float!
  }
  type Bom {
    id: ID!
    productId: ID!
    productName: String!
    uom: String
    packingSize: String
    outputQuantity: Float!     # stock units (packs) of the finished product per batch
    version: Int!
    isActive: Boolean!
    notes: String
    labourCost: Float!
    overheadCost: Float!
    materialCost: Float!       # rolled up (recursive) from components
    totalCost: Float!          # material + labour + overhead, per output batch
    unitCost: Float!           # totalCost / outputQuantity
    standardCost: Float!       # the product's own set standard cost (for comparison)
    components: [BomComponent!]!
    componentCount: Int!
    createdAt: DateTime!
  }

  # Multi-level explosion tree node.
  type BomNode {
    productId: ID!
    productName: String!
    uom: String
    quantity: Float!
    isManufactured: Boolean!
    unitCost: Float!
    lineCost: Float!
    level: Int!
    children: [BomNode!]!
  }

  type CostedProduct {
    id: ID!
    name: String!
    uom: String
    packingSize: String
    category: String
    standardCost: Float!
    hasBom: Boolean!
    manufacturedCost: Float!   # rolled-up unit cost when it has a BOM, else 0
  }

  type MaterialNeed {
    componentProductId: ID!
    componentName: String!
    uom: String
    packingSize: String
    required: Float!           # all three in the component's UOM
    available: Float!
    shortfall: Float!
    isManufactured: Boolean!
  }

  type QcTest { id: ID!, parameter: String!, specification: String, result: String, status: String! }

  type ProductionOrder {
    id: ID!
    prodNo: String!
    productId: ID!
    productName: String!
    uom: String
    packingSize: String
    warehouseId: ID
    warehouseName: String
    bomId: ID
    plannedQuantity: Float!
    producedQuantity: Float!
    status: String!
    qcStatus: String!
    qcNotes: String
    batchNumber: String
    mfgDate: String
    expiryDate: String
    notes: String
    coaNo: String
    analyst: String
    approvedBy: String
    estimatedCost: Float!      # planned unit cost × planned qty
    actualMaterialCost: Float! # cost of materials actually consumed
    materials: [MaterialNeed!]!
    qcTests: [QcTest!]!
    createdAt: DateTime!
    startedAt: DateTime
    completedAt: DateTime
  }

  type ProductionStats { activeBoms: Int!, planned: Int!, inProgress: Int!, completedMtd: Float! }

  input BomComponentInput { componentProductId: ID!, quantity: Float! }
  input BomInput { productId: ID!, outputQuantity: Float!, notes: String, labourCost: Float = 0, overheadCost: Float = 0, components: [BomComponentInput!]! }
  input CreateProductionInput { productId: ID!, plannedQuantity: Float!, warehouseId: ID!, notes: String }
  input QcTestInput { parameter: String!, specification: String, result: String, status: String! }
  input CompleteProductionInput {
    productionOrderId: ID!
    producedQuantity: Float!
    batchNumber: String!
    mfgDate: String
    expiryDate: String
    qcStatus: String!
    qcNotes: String
    analyst: String
    approvedBy: String
    qcTests: [QcTestInput!]
  }

  extend type Query {
    boms(productId: ID, activeOnly: Boolean): [Bom!]!
    bom(id: ID!): Bom
    bomForProduct(productId: ID!): Bom
    bomTree(productId: ID!): BomNode
    costedProducts(search: String, limit: Int = 200): [CostedProduct!]!
    productionOrders(status: String, search: String, limit: Int = 100): [ProductionOrder!]!
    productionOrder(id: ID!): ProductionOrder
    productionStats: ProductionStats!
  }

  extend type Mutation {
    createBom(input: BomInput!): Bom!
    updateBom(id: ID!, input: BomInput!): Bom!
    setBomActive(id: ID!, isActive: Boolean!): Bom!
    deleteBom(id: ID!): Boolean!
    setProductStandardCost(productId: ID!, cost: Float!): Boolean!

    createProductionOrder(input: CreateProductionInput!): ProductionOrder!
    startProduction(id: ID!): ProductionOrder!
    completeProduction(input: CompleteProductionInput!): ProductionOrder!
    cancelProductionOrder(id: ID!): ProductionOrder!
  }
`;

const PO_SELECT = `SELECT po.*, p.name product_name, p.uom, p.packing_size, w.name warehouse_name
  FROM production_orders po JOIN products p ON p.id = po.product_id
  LEFT JOIN warehouses w ON w.id = po.warehouse_id`;
const BOM_SELECT = `SELECT b.*, p.name product_name, p.uom, p.packing_size, p.standard_cost,
    (SELECT COUNT(*)::int FROM bom_components c WHERE c.bom_id = b.id) component_count
  FROM bom b JOIN products p ON p.id = b.product_id`;

const round2 = (n) => Math.round(n * 100) / 100;
const round3 = (n) => Math.round(n * 1000) / 1000;
const str = (v) => (v == null || String(v).trim() === '' ? null : String(v).trim());

/**
 * Content of one stock unit in the product's UOM. Stock (and PO/production
 * quantities) count packs, BOM component quantities are in the UOM:
 * "250ml" with uom L → 0.25, so 0.2 L of it = 0.8 packs. No/mismatched pack → 1.
 */
const perPack = (packingSize, uom) => statutoryQty(1000, packingSize, uom).qty / 1000 || 1;

const mapBom = (r) => r && {
  id: r.id, productId: r.product_id, productName: r.product_name, uom: r.uom ?? null, packingSize: r.packing_size ?? null,
  outputQuantity: num(r.output_quantity), version: r.version, isActive: r.is_active, notes: r.notes,
  labourCost: num(r.labour_cost) ?? 0, overheadCost: num(r.overhead_cost) ?? 0, createdAt: r.created_at,
  componentCount: r.component_count ?? 0, standardCost: num(r.standard_cost) ?? 0,
};
const mapPO = (r) => r && {
  id: r.id, prodNo: r.prod_no, productId: r.product_id, productName: r.product_name, uom: r.uom ?? null, packingSize: r.packing_size ?? null,
  warehouseId: r.warehouse_id, warehouseName: r.warehouse_name, bomId: r.bom_id,
  plannedQuantity: num(r.planned_quantity), producedQuantity: num(r.produced_quantity),
  status: r.status, qcStatus: r.qc_status, qcNotes: r.qc_notes, batchNumber: r.batch_number,
  mfgDate: isoDate(r.mfg_date), expiryDate: isoDate(r.expiry_date), notes: r.notes,
  coaNo: r.coa_no, analyst: r.analyst, approvedBy: r.approved_by,
  createdAt: r.created_at, startedAt: r.started_at, completedAt: r.completed_at,
};

// ── Costing helpers (recursive, cycle-guarded, memoised per call) ─────────────
async function latestPurchaseCost(productId) {
  const r = await query(
    `SELECT pol.unit_cost FROM purchase_order_lines pol JOIN purchase_orders po ON po.id = pol.po_id
     WHERE pol.product_id = $1 ORDER BY po.created_at DESC LIMIT 1`,
    [productId],
  );
  return r.rows[0] ? num(r.rows[0].unit_cost) : 0;
}

// Memoised per request via `cache` (key 'bom:<productId>').
async function activeBomId(productId, cache) {
  const key = `bom:${productId}`;
  if (cache?.has(key)) return cache.get(key);
  const r = await query('SELECT id FROM bom WHERE product_id=$1 AND is_active ORDER BY version DESC LIMIT 1', [productId]);
  const id = r.rows[0]?.id ?? null;
  cache?.set(key, id);
  return id;
}

// Cost of ONE STOCK UNIT (pack) of a product: rolled up from its BOM if it has
// one, else its standard cost (falling back to the latest purchase cost).
async function productUnitCost(productId, guard = new Set(), cache = new Map()) {
  if (cache.has(productId)) return cache.get(productId);
  if (guard.has(productId)) return 0; // cycle protection
  guard.add(productId);
  let cost;
  const bomId = await activeBomId(productId, cache);
  if (bomId) {
    cost = (await bomRollup(bomId, guard, cache)).unitCost;
  } else {
    const p = (await query('SELECT standard_cost FROM products WHERE id=$1', [productId])).rows[0];
    cost = num(p?.standard_cost) || 0;
    if (!cost) cost = await latestPurchaseCost(productId);
  }
  guard.delete(productId);
  cache.set(productId, cost);
  return cost;
}

async function bomRollup(bomId, guard = new Set(), cache = new Map()) {
  const bom = (await query('SELECT * FROM bom WHERE id=$1', [bomId])).rows[0];
  if (!bom) return { materialCost: 0, totalCost: 0, unitCost: 0, components: [] };
  const comps = (await query(
    `SELECT bc.id, bc.component_product_id, bc.quantity, p.name, p.uom, p.packing_size
     FROM bom_components bc JOIN products p ON p.id = bc.component_product_id WHERE bc.bom_id=$1 ORDER BY p.name`,
    [bomId],
  )).rows;
  let materialCost = 0;
  const components = [];
  for (const c of comps) {
    // Component qty is in its UOM; cost is per pack → cost per UOM = pack cost / pack content.
    const perUom = (await productUnitCost(c.component_product_id, guard, cache)) / perPack(c.packing_size, c.uom);
    const lineCost = round2(num(c.quantity) * perUom);
    materialCost += lineCost;
    components.push({
      id: c.id, componentProductId: c.component_product_id, componentName: c.name, uom: c.uom, packingSize: c.packing_size ?? null,
      quantity: num(c.quantity), unitCost: round2(perUom), lineCost,
      isManufactured: Boolean(await activeBomId(c.component_product_id, cache)),
    });
  }
  materialCost = round2(materialCost);
  const totalCost = round2(materialCost + num(bom.labour_cost) + num(bom.overhead_cost));
  const outputQuantity = num(bom.output_quantity);
  const unitCost = outputQuantity > 0 ? round2(totalCost / outputQuantity) : 0;
  return { materialCost, totalCost, unitCost, components, outputQuantity };
}

// Multi-level explosion tree. `qty` is in the product's UOM.
async function buildBomNode(productId, qty, level, guard, cache) {
  const p = (await query('SELECT name, uom, packing_size FROM products WHERE id=$1', [productId])).rows[0] || { name: 'Unknown', uom: null };
  const pp = perPack(p.packing_size, p.uom);
  const bomId = await activeBomId(productId, cache);
  const unitCost = (await productUnitCost(productId, new Set(guard), cache)) / pp;
  const node = {
    productId, productName: p.name, uom: p.uom, quantity: round3(qty), isManufactured: Boolean(bomId),
    unitCost: round2(unitCost), lineCost: round2(qty * unitCost), level, children: [],
  };
  if (bomId && !guard.has(productId)) {
    guard.add(productId);
    const bom = (await query('SELECT output_quantity FROM bom WHERE id=$1', [bomId])).rows[0];
    const factor = qty / pp / num(bom.output_quantity); // packs needed ÷ packs per batch
    const comps = (await query('SELECT component_product_id, quantity FROM bom_components WHERE bom_id=$1', [bomId])).rows;
    for (const c of comps) {
      node.children.push(await buildBomNode(c.component_product_id, num(c.quantity) * factor, level + 1, guard, cache));
    }
    guard.delete(productId);
  }
  return node;
}

// Direct (level-1) component requirement for `qty` finished units (packs) — what a
// production order actually consumes. `required` is in the component's UOM, `packs` in stock units.
async function explodeBom(client, bomId, qty) {
  const bom = (await client.query('SELECT * FROM bom WHERE id=$1', [bomId])).rows[0];
  if (!bom) throw httpError('BOM not found', 404);
  const factor = qty / num(bom.output_quantity);
  const comps = (await client.query(
    `SELECT bc.component_product_id, bc.quantity, p.name, p.uom, p.packing_size
     FROM bom_components bc JOIN products p ON p.id = bc.component_product_id WHERE bc.bom_id=$1 ORDER BY p.name`,
    [bomId],
  )).rows;
  return comps.map((c) => {
    const pp = perPack(c.packing_size, c.uom);
    const required = round3(num(c.quantity) * factor);
    return {
      componentProductId: c.component_product_id, componentName: c.name, uom: c.uom, packingSize: c.packing_size ?? null,
      required, perPack: pp, packs: round3(required / pp),
    };
  });
}

function validateBom(input) {
  if (!(input.outputQuantity > 0)) throw httpError('Output quantity must be greater than 0', 400);
  if (!input.components?.length) throw httpError('A BOM needs at least one component', 400);
  if (input.components.some((c) => c.componentProductId === input.productId)) throw httpError('A product cannot be a component of itself', 400);
  if (input.components.some((c) => !(c.quantity > 0))) throw httpError('Each component needs a quantity greater than 0', 400);
  if (new Set(input.components.map((c) => c.componentProductId)).size !== input.components.length) throw httpError('A component is listed twice — combine it into one line', 400);
  if ([input.labourCost, input.overheadCost].some((v) => v != null && v < 0)) throw httpError('Costs cannot be negative', 400);
}

const rollupOf = (bom) => (bom._rollup ??= bomRollup(bom.id));

export function manufacturingResolvers() {
  return {
    Query: {
      boms: async (_p, { productId, activeOnly }, ctx) => {
        assertAuth(ctx);
        const { rows } = await query(
          `${BOM_SELECT}
           WHERE ($1::uuid IS NULL OR b.product_id=$1) AND ($2::bool IS NULL OR b.is_active=$2)
           ORDER BY b.created_at DESC`,
          [str(productId), activeOnly ?? null],
        );
        return rows.map(mapBom);
      },
      bom: async (_p, { id }, ctx) => { assertAuth(ctx); const { rows } = await query(`${BOM_SELECT} WHERE b.id=$1`, [id]); return mapBom(rows[0]); },
      bomForProduct: async (_p, { productId }, ctx) => {
        assertAuth(ctx);
        const { rows } = await query(`${BOM_SELECT} WHERE b.product_id=$1 AND b.is_active ORDER BY b.version DESC LIMIT 1`, [productId]);
        return mapBom(rows[0]);
      },
      bomTree: async (_p, { productId }, ctx) => {
        assertAuth(ctx);
        const cache = new Map();
        const bomId = await activeBomId(productId, cache);
        if (!bomId) return null;
        const bom = (await query('SELECT b.output_quantity, p.uom, p.packing_size FROM bom b JOIN products p ON p.id = b.product_id WHERE b.id=$1', [bomId])).rows[0];
        return buildBomNode(productId, num(bom.output_quantity) * perPack(bom.packing_size, bom.uom), 0, new Set(), cache);
      },
      costedProducts: async (_p, { search, limit }, ctx) => {
        assertAuth(ctx);
        const { rows } = await query(
          `SELECT p.id, p.name, p.uom, p.packing_size, p.category, p.standard_cost,
                  (SELECT b.id FROM bom b WHERE b.product_id = p.id AND b.is_active ORDER BY b.version DESC LIMIT 1) bom_id
           FROM products p WHERE p.is_active AND ($1::text IS NULL OR p.name ILIKE '%'||$1||'%') ORDER BY p.name LIMIT $2`,
          [str(search), Math.min(limit ?? 200, 500)],
        );
        const cache = new Map();
        const out = [];
        for (const r of rows) {
          const bomId = r.bom_id;
          cache.set(`bom:${r.id}`, bomId ?? null);
          out.push({
            id: r.id, name: r.name, uom: r.uom, packingSize: r.packing_size ?? null, category: r.category, standardCost: num(r.standard_cost) ?? 0,
            hasBom: Boolean(bomId), manufacturedCost: bomId ? (await bomRollup(bomId, new Set(), cache)).unitCost : 0,
          });
        }
        return out;
      },
      productionOrders: async (_p, { status, search, limit }, ctx) => {
        assertAuth(ctx);
        const { rows } = await query(
          `${PO_SELECT} WHERE ($1::text IS NULL OR po.status=$1)
             AND ($2::text IS NULL OR po.prod_no ILIKE '%'||$2||'%' OR p.name ILIKE '%'||$2||'%')
           ORDER BY po.created_at DESC LIMIT $3`,
          [str(status), str(search), Math.min(limit ?? 100, 1000)],
        );
        return rows.map(mapPO);
      },
      productionOrder: async (_p, { id }, ctx) => { assertAuth(ctx); const { rows } = await query(`${PO_SELECT} WHERE po.id=$1`, [id]); return mapPO(rows[0]); },
      productionStats: async (_p, _a, ctx) => {
        assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN');
        const { rows } = await query(
          `SELECT (SELECT COUNT(*) FROM bom WHERE is_active)::int active_boms,
                  (SELECT COUNT(*) FROM production_orders WHERE status='PLANNED')::int planned,
                  (SELECT COUNT(*) FROM production_orders WHERE status='IN_PROGRESS')::int in_progress,
                  COALESCE((SELECT SUM(produced_quantity) FROM production_orders WHERE status='COMPLETED' AND date_trunc('month',completed_at)=date_trunc('month',CURRENT_DATE)),0) completed_mtd`,
        );
        const r = rows[0];
        return { activeBoms: r.active_boms, planned: r.planned, inProgress: r.in_progress, completedMtd: num(r.completed_mtd) };
      },
    },

    Mutation: {
      createBom: async (_p, { input }, ctx) => {
        const a = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN');
        validateBom(input);
        return withTransaction(async (client) => {
          const ver = (await client.query('SELECT COALESCE(MAX(version),0)+1 v FROM bom WHERE product_id=$1', [input.productId])).rows[0].v;
          await client.query('UPDATE bom SET is_active=false WHERE product_id=$1', [input.productId]);
          const bom = (await client.query(
            'INSERT INTO bom (product_id, output_quantity, version, notes, labour_cost, overhead_cost, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
            [input.productId, input.outputQuantity, ver, str(input.notes), input.labourCost ?? 0, input.overheadCost ?? 0, a.sub],
          )).rows[0];
          for (const c of input.components) await client.query('INSERT INTO bom_components (bom_id, component_product_id, quantity) VALUES ($1,$2,$3)', [bom.id, c.componentProductId, c.quantity]);
          await logActivity(a.sub, 'CREATE_BOM', 'bom', bom.id);
          const full = await client.query(`${BOM_SELECT} WHERE b.id=$1`, [bom.id]);
          return mapBom(full.rows[0]);
        });
      },
      updateBom: async (_p, { id, input }, ctx) => {
        const a = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN');
        validateBom(input);
        return withTransaction(async (client) => {
          const exists = await client.query('SELECT id FROM bom WHERE id=$1', [id]);
          if (!exists.rows[0]) throw httpError('BOM not found', 404);
          await client.query('UPDATE bom SET output_quantity=$2, notes=$3, labour_cost=$4, overhead_cost=$5, updated_at=now() WHERE id=$1', [id, input.outputQuantity, str(input.notes), input.labourCost ?? 0, input.overheadCost ?? 0]);
          await client.query('DELETE FROM bom_components WHERE bom_id=$1', [id]);
          for (const c of input.components) await client.query('INSERT INTO bom_components (bom_id, component_product_id, quantity) VALUES ($1,$2,$3)', [id, c.componentProductId, c.quantity]);
          await logActivity(a.sub, 'UPDATE_BOM', 'bom', id);
          const full = await client.query(`${BOM_SELECT} WHERE b.id=$1`, [id]);
          return mapBom(full.rows[0]);
        });
      },
      setBomActive: async (_p, { id, isActive }, ctx) => {
        const a = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN');
        const { rows } = await query('UPDATE bom SET is_active=$2, updated_at=now() WHERE id=$1 RETURNING *', [id, isActive]);
        if (!rows[0]) throw httpError('BOM not found', 404);
        await logActivity(a.sub, 'TOGGLE_BOM', 'bom', id);
        const full = await query(`${BOM_SELECT} WHERE b.id=$1`, [id]);
        return mapBom(full.rows[0]);
      },
      deleteBom: async (_p, { id }, ctx) => {
        const a = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN');
        const open = (await query("SELECT 1 FROM production_orders WHERE bom_id=$1 AND status IN ('PLANNED','IN_PROGRESS') LIMIT 1", [id])).rows[0];
        if (open) throw httpError('Open production orders use this BOM — complete or cancel them first (or archive the BOM)', 409);
        const { rowCount } = await query('DELETE FROM bom WHERE id=$1', [id]);
        if (!rowCount) throw httpError('BOM not found', 404);
        await logActivity(a.sub, 'DELETE_BOM', 'bom', id);
        return true;
      },
      setProductStandardCost: async (_p, { productId, cost }, ctx) => {
        const a = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN');
        if (!(cost >= 0)) throw httpError('Cost cannot be negative', 400);
        const { rowCount } = await query('UPDATE products SET standard_cost=$2, updated_at=now() WHERE id=$1', [productId, cost]);
        if (!rowCount) throw httpError('Product not found', 404);
        await logActivity(a.sub, 'SET_PRODUCT_COST', 'product', productId, { cost });
        return true;
      },

      createProductionOrder: async (_p, { input }, ctx) => {
        const a = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN');
        if (!(input.plannedQuantity > 0)) throw httpError('Quantity to produce must be greater than 0', 400);
        return withTransaction(async (client) => {
          const prod = (await client.query('SELECT id FROM products WHERE id=$1', [input.productId])).rows[0];
          if (!prod) throw httpError('Product not found', 404);
          if (!(await client.query('SELECT id FROM warehouses WHERE id=$1', [input.warehouseId])).rows[0]) throw httpError('Warehouse not found', 404);
          const bom = (await client.query('SELECT id FROM bom WHERE product_id=$1 AND is_active ORDER BY version DESC LIMIT 1', [input.productId])).rows[0];
          if (!bom) throw httpError('No active BOM for this product — define a Bill of Materials first', 400);
          const prodNo = `MO-${String((await client.query("SELECT nextval('prod_seq') n")).rows[0].n).padStart(5, '0')}`;
          const po = (await client.query(
            `INSERT INTO production_orders (prod_no, product_id, bom_id, warehouse_id, planned_quantity, notes, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
            [prodNo, input.productId, bom.id, input.warehouseId, input.plannedQuantity, str(input.notes), a.sub],
          )).rows[0];
          await logActivity(a.sub, 'CREATE_PRODUCTION', 'production_order', po.id, { prodNo });
          const full = await client.query(`${PO_SELECT} WHERE po.id=$1`, [po.id]);
          return mapPO(full.rows[0]);
        });
      },

      startProduction: async (_p, { id }, ctx) => {
        const a = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN');
        return withTransaction(async (client) => {
          const po = (await client.query('SELECT * FROM production_orders WHERE id=$1 FOR UPDATE', [id])).rows[0];
          if (!po) throw httpError('Production order not found', 404);
          if (po.status !== 'PLANNED') throw httpError('Only PLANNED orders can be started', 400);
          if (!po.bom_id) throw httpError('This order has no BOM', 400);
          if (!po.warehouse_id) throw httpError('This order has no production warehouse', 400);
          const needs = await explodeBom(client, po.bom_id, num(po.planned_quantity));

          // Stock counts packs: consume need.packs (= required UOM ÷ pack content), FEFO.
          for (const need of needs) {
            let remaining = need.packs;
            const stock = (await client.query(
              `SELECT sl.* FROM stock_levels sl JOIN batches b ON b.id = sl.batch_id
               WHERE sl.product_id=$1 AND sl.warehouse_id=$2 AND sl.quantity>0
               ORDER BY b.expiry_date ASC NULLS LAST FOR UPDATE OF sl`,
              [need.componentProductId, po.warehouse_id],
            )).rows;
            const avail = round3(stock.reduce((s, r) => s + num(r.quantity), 0));
            if (avail < remaining - 0.0005) {
              const u = need.uom ? ` ${need.uom}` : '';
              throw httpError(`Insufficient ${need.componentName}: need ${need.required}${u}, have ${round3(avail * need.perPack)}${u} in this warehouse`, 400);
            }
            for (const sl of stock) {
              if (remaining <= 0.0005) break;
              const take = round3(Math.min(num(sl.quantity), remaining));
              await client.query('UPDATE stock_levels SET quantity = quantity - $2, updated_at=now() WHERE id=$1', [sl.id, take]);
              await client.query(
                `INSERT INTO stock_movements (warehouse_id, product_id, batch_id, movement_type, quantity, reason, ref_type, ref_id, created_by)
                 VALUES ($1,$2,$3,'OUT',$4,'Production consumption','production',$5,$6)`,
                [po.warehouse_id, need.componentProductId, sl.batch_id, -take, po.id, a.sub],
              );
              await client.query('INSERT INTO production_consumptions (production_order_id, component_product_id, batch_id, quantity) VALUES ($1,$2,$3,$4)', [po.id, need.componentProductId, sl.batch_id, take]);
              remaining = round3(remaining - take);
            }
          }
          await client.query("UPDATE production_orders SET status='IN_PROGRESS', started_at=now() WHERE id=$1", [id]);
          await logActivity(a.sub, 'START_PRODUCTION', 'production_order', id);
          const full = await client.query(`${PO_SELECT} WHERE po.id=$1`, [id]);
          return mapPO(full.rows[0]);
        });
      },

      completeProduction: async (_p, { input }, ctx) => {
        const a = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN');
        if (!['PASS', 'FAIL', 'HOLD'].includes(input.qcStatus)) throw httpError('qcStatus must be PASS, FAIL or HOLD', 400);
        if (!(input.producedQuantity > 0)) throw httpError('Produced quantity must be greater than 0', 400);
        const batchNumber = str(input.batchNumber);
        if (!batchNumber) throw httpError('Output batch number is required', 400);
        const mfgDate = str(input.mfgDate), expiryDate = str(input.expiryDate);
        if (mfgDate && expiryDate && expiryDate < mfgDate) throw httpError('Expiry date is before the manufacturing date', 400);
        return withTransaction(async (client) => {
          const po = (await client.query('SELECT * FROM production_orders WHERE id=$1 FOR UPDATE', [input.productionOrderId])).rows[0];
          if (!po) throw httpError('Production order not found', 404);
          if (po.status !== 'IN_PROGRESS') throw httpError('Only IN_PROGRESS orders can be completed', 400);

          if (input.qcStatus === 'PASS') {
            const batch = (await client.query(
              `INSERT INTO batches (product_id, batch_number, manufacturing_date, expiry_date)
               VALUES ($1,$2,$3,$4) ON CONFLICT (product_id, batch_number) DO UPDATE SET
                 manufacturing_date=COALESCE(EXCLUDED.manufacturing_date, batches.manufacturing_date),
                 expiry_date=COALESCE(EXCLUDED.expiry_date, batches.expiry_date) RETURNING id`,
              [po.product_id, batchNumber, mfgDate, expiryDate],
            )).rows[0];
            await client.query(
              `INSERT INTO stock_levels (warehouse_id, product_id, batch_id, quantity)
               VALUES ($1,$2,$3,$4) ON CONFLICT (warehouse_id, product_id, batch_id) DO UPDATE SET
                 quantity = stock_levels.quantity + EXCLUDED.quantity, updated_at=now()`,
              [po.warehouse_id, po.product_id, batch.id, input.producedQuantity],
            );
            await client.query(
              `INSERT INTO stock_movements (warehouse_id, product_id, batch_id, movement_type, quantity, reason, ref_type, ref_id, created_by)
               VALUES ($1,$2,$3,'IN',$4,'Production output','production',$5,$6)`,
              [po.warehouse_id, po.product_id, batch.id, input.producedQuantity, po.id, a.sub],
            );
          }
          const coaNo = `COA-${String((await client.query("SELECT nextval('coa_seq') n")).rows[0].n).padStart(5, '0')}`;
          await client.query(
            `UPDATE production_orders SET status='COMPLETED', produced_quantity=$2, batch_number=$3, mfg_date=$4, expiry_date=$5,
               qc_status=$6, qc_notes=$7, coa_no=$8, analyst=$9, approved_by=$10, completed_at=now() WHERE id=$1`,
            [po.id, input.producedQuantity, batchNumber, mfgDate, expiryDate, input.qcStatus, str(input.qcNotes), coaNo, str(input.analyst), str(input.approvedBy)],
          );
          for (const t of (input.qcTests ?? []).filter((x) => str(x.parameter))) {
            await client.query(
              'INSERT INTO production_qc_tests (production_order_id, parameter, specification, result, status) VALUES ($1,$2,$3,$4,$5)',
              [po.id, str(t.parameter), str(t.specification), str(t.result), ['PASS', 'FAIL'].includes(t.status) ? t.status : 'PASS'],
            );
          }
          await logActivity(a.sub, 'COMPLETE_PRODUCTION', 'production_order', po.id, { qc: input.qcStatus, qty: input.producedQuantity, coaNo });
          const full = await client.query(`${PO_SELECT} WHERE po.id=$1`, [po.id]);
          return mapPO(full.rows[0]);
        });
      },

      cancelProductionOrder: async (_p, { id }, ctx) => {
        const a = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN');
        const { rows } = await query("UPDATE production_orders SET status='CANCELLED' WHERE id=$1 AND status='PLANNED' RETURNING id", [id]);
        if (!rows[0]) throw httpError('Only PLANNED orders can be cancelled (materials already issued otherwise)', 400);
        await logActivity(a.sub, 'CANCEL_PRODUCTION', 'production_order', id);
        const full = await query(`${PO_SELECT} WHERE po.id=$1`, [id]);
        return mapPO(full.rows[0]);
      },
    },

    // One rollup per BOM object, shared by all its cost fields (was 4 rollups per row).
    Bom: {
      components: async (parent) => (await rollupOf(parent)).components,
      materialCost: async (parent) => (await rollupOf(parent)).materialCost,
      totalCost: async (parent) => (await rollupOf(parent)).totalCost,
      unitCost: async (parent) => (await rollupOf(parent)).unitCost,
    },

    ProductionOrder: {
      materials: async (parent) => {
        if (!parent.bomId) return [];
        const needs = await explodeBom({ query }, parent.bomId, parent.plannedQuantity);
        const ids = needs.map((n) => n.componentProductId);
        const [stock, boms] = await Promise.all([
          query('SELECT product_id, SUM(quantity) q FROM stock_levels WHERE warehouse_id=$1 AND product_id = ANY($2::uuid[]) GROUP BY product_id', [parent.warehouseId, ids]),
          query('SELECT DISTINCT product_id FROM bom WHERE is_active AND product_id = ANY($1::uuid[])', [ids]),
        ]);
        const packs = new Map(stock.rows.map((r) => [r.product_id, num(r.q)]));
        const made = new Set(boms.rows.map((r) => r.product_id));
        return needs.map((n) => {
          const available = round3((packs.get(n.componentProductId) ?? 0) * n.perPack); // packs → UOM
          return { ...n, available, shortfall: Math.max(round3(n.required - available), 0), isManufactured: made.has(n.componentProductId) };
        });
      },
      qcTests: async (parent) => {
        const { rows } = await query('SELECT id, parameter, specification, result, status FROM production_qc_tests WHERE production_order_id=$1 ORDER BY created_at', [parent.id]);
        return rows;
      },
      estimatedCost: async (parent) => round2((await productUnitCost(parent.productId)) * num(parent.plannedQuantity)),
      actualMaterialCost: async (parent) => {
        const { rows } = await query('SELECT component_product_id, quantity FROM production_consumptions WHERE production_order_id=$1', [parent.id]);
        const cache = new Map();
        let total = 0;
        for (const r of rows) total += num(r.quantity) * (await productUnitCost(r.component_product_id, new Set(), cache));
        return round2(total);
      },
    },
  };
}
