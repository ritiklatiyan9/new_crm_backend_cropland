// GraphQL module: Pricing Engine (PRD §4.3).
// Rule-based pricing (region/season/promo/dealer-tier/quantity slabs) + schemes.

import { query } from '../../db/index.js';
import { assertAuth, assertRole } from '../context.js';
import { httpError, logActivity, num, isoDate } from '../helpers.js';
import { mapProduct } from './products.js';

export const pricingTypeDefs = /* GraphQL */ `
  type PriceRule {
    id: ID!
    productId: ID!
    product: Product
    scope: String!
    state: String
    district: String
    dealerTier: String
    price: Float!
    minQuantity: Int!
    discountPct: Float!
    validFrom: String
    validTo: String
    isActive: Boolean!
    createdAt: DateTime!
  }

  type Scheme {
    id: ID!
    name: String!
    schemeType: String!
    description: String
    config: JSON
    validFrom: String
    validTo: String
    isActive: Boolean!
    createdAt: DateTime!
  }

  type ResolvedPrice {
    productId: ID!
    basePrice: Float!
    appliedRuleId: ID
    discountPct: Float!
    unitPrice: Float!
  }

  input PriceRuleInput {
    productId: ID!
    scope: String!
    state: String
    district: String
    dealerTier: String
    price: Float!
    minQuantity: Int = 1
    discountPct: Float = 0
    validFrom: String
    validTo: String
  }

  input SchemeInput {
    name: String!
    schemeType: String!
    description: String
    config: JSON
    validFrom: String
    validTo: String
  }

  extend type Query {
    priceRules(productId: ID, scope: String, activeOnly: Boolean): [PriceRule!]!
    schemes(activeOnly: Boolean): [Scheme!]!
    resolvePrice(productId: ID!, dealerTier: String, state: String, quantity: Float = 1): ResolvedPrice!
  }

  extend type Mutation {
    createPriceRule(input: PriceRuleInput!): PriceRule!
    updatePriceRule(id: ID!, input: PriceRuleInput!): PriceRule!
    setPriceRuleActive(id: ID!, isActive: Boolean!): PriceRule!
    deletePriceRule(id: ID!): Boolean!

    createScheme(input: SchemeInput!): Scheme!
    updateScheme(id: ID!, input: SchemeInput!): Scheme!
    setSchemeActive(id: ID!, isActive: Boolean!): Scheme!
    deleteScheme(id: ID!): Boolean!
  }
`;

const mapRule = (r) =>
  r && {
    id: r.id,
    productId: r.product_id,
    scope: r.scope,
    state: r.state,
    district: r.district,
    dealerTier: r.dealer_tier,
    price: num(r.price),
    minQuantity: r.min_quantity,
    discountPct: num(r.discount_pct),
    validFrom: isoDate(r.valid_from),
    validTo: isoDate(r.valid_to),
    isActive: r.is_active,
    createdAt: r.created_at,
  };

const mapScheme = (r) =>
  r && {
    id: r.id,
    name: r.name,
    schemeType: r.scheme_type,
    description: r.description,
    config: r.config,
    validFrom: isoDate(r.valid_from),
    validTo: isoDate(r.valid_to),
    isActive: r.is_active,
    createdAt: r.created_at,
  };

const SCOPES = ['BASE', 'REGION', 'SEASON', 'PROMO', 'DEALER_TIER'];
const t = (v) => (typeof v === 'string' ? v.trim() || null : v ?? null);

function checkValidity(from, to) {
  if (from && to && to < from) throw httpError('"Valid to" must be on or after "Valid from"', 400);
}

// Validate + normalise ("" → null, upper-case tier to match distributors.dealer_tier).
const ruleValues = (i) => {
  if (!i.productId) throw httpError('Select a product', 400);
  const scope = String(i.scope ?? 'BASE').trim().toUpperCase();
  if (!SCOPES.includes(scope)) throw httpError(`Scope must be one of ${SCOPES.join(', ')}`, 400);
  if (!(i.price >= 0 && i.price < 1e10)) throw httpError('Price must be 0 or more', 400);
  const minQty = i.minQuantity ?? 1;
  if (minQty < 1) throw httpError('Min quantity must be at least 1', 400);
  const disc = i.discountPct ?? 0;
  if (!(disc >= 0 && disc <= 100)) throw httpError('Discount % must be between 0 and 100', 400);
  const from = t(i.validFrom);
  const to = t(i.validTo);
  checkValidity(from, to);
  return [i.productId, scope, t(i.state), t(i.district), t(i.dealerTier)?.toUpperCase() ?? null, i.price, minQty, disc, from, to];
};

const schemeValues = (i) => {
  const name = t(i.name);
  if (!name) throw httpError('Scheme name is required', 400);
  const from = t(i.validFrom);
  const to = t(i.validTo);
  checkValidity(from, to);
  return [name, t(i.schemeType) ?? 'DISCOUNT', t(i.description), JSON.stringify(i.config ?? {}), from, to];
};

export function pricingResolvers() {
  return {
    Query: {
      priceRules: async (_p, { productId, scope, activeOnly }, ctx) => {
        assertAuth(ctx);
        const { rows } = await query(
          `SELECT * FROM price_rules
           WHERE ($1::uuid IS NULL OR product_id = $1)
             AND ($2::text IS NULL OR scope = $2)
             AND ($3::bool IS NULL OR is_active = $3)
           ORDER BY created_at DESC`,
          [productId || null, scope || null, activeOnly ?? null],
        );
        return rows.map(mapRule);
      },
      schemes: async (_p, { activeOnly }, ctx) => {
        assertAuth(ctx);
        const { rows } = await query(
          `SELECT * FROM schemes WHERE ($1::bool IS NULL OR is_active = $1) ORDER BY created_at DESC`,
          [activeOnly ?? null],
        );
        return rows.map(mapScheme);
      },
      // Picks the best active price rule for a product/dealer/state/quantity (used by Order-to-Cash).
      resolvePrice: async (_p, { productId, dealerTier, state, quantity }, ctx) => {
        assertAuth(ctx);
        const prod = await query('SELECT distributor_price, dealer_price, mrp FROM products WHERE id = $1', [
          productId,
        ]);
        if (!prod.rows[0]) throw httpError('Product not found', 404);
        const basePrice = num(prod.rows[0].distributor_price ?? prod.rows[0].dealer_price ?? prod.rows[0].mrp ?? 0) ?? 0;

        const { rows } = await query(
          `SELECT * FROM price_rules
           WHERE product_id = $1 AND is_active = TRUE
             AND min_quantity <= $2::numeric
             AND (valid_from IS NULL OR valid_from <= CURRENT_DATE)
             AND (valid_to IS NULL OR valid_to >= CURRENT_DATE)
             AND (dealer_tier IS NULL OR upper(dealer_tier) = upper($3))
             AND (state IS NULL OR lower(state) = lower($4))
           -- specificity: dealer-tier & state matches first, then larger qty slab, then cheaper
           ORDER BY (dealer_tier IS NOT NULL)::int + (state IS NOT NULL)::int DESC,
                    min_quantity DESC, price ASC
           LIMIT 1`,
          [productId, quantity ?? 1, t(dealerTier), t(state)],
        );

        const rule = rows[0];
        const rulePrice = rule ? num(rule.price) : basePrice;
        const discountPct = rule ? num(rule.discount_pct) : 0;
        const unitPrice = Math.round(rulePrice * (1 - discountPct / 100) * 100) / 100;
        return {
          productId,
          basePrice,
          appliedRuleId: rule?.id ?? null,
          discountPct,
          unitPrice,
        };
      },
    },

    Mutation: {
      createPriceRule: async (_p, { input }, ctx) => {
        const actor = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN');
        const { rows } = await query(
          `INSERT INTO price_rules
             (product_id, scope, state, district, dealer_tier, price, min_quantity, discount_pct, valid_from, valid_to)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
          ruleValues(input),
        );
        await logActivity(actor.sub, 'CREATE_PRICE_RULE', 'price_rule', rows[0].id);
        return mapRule(rows[0]);
      },
      updatePriceRule: async (_p, { id, input }, ctx) => {
        const actor = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN');
        const { rows } = await query(
          `UPDATE price_rules SET
             product_id=$2, scope=$3, state=$4, district=$5, dealer_tier=$6, price=$7,
             min_quantity=$8, discount_pct=$9, valid_from=$10, valid_to=$11, updated_at=now()
           WHERE id=$1 RETURNING *`,
          [id, ...ruleValues(input)],
        );
        if (!rows[0]) throw httpError('Price rule not found', 404);
        await logActivity(actor.sub, 'UPDATE_PRICE_RULE', 'price_rule', id);
        return mapRule(rows[0]);
      },
      setPriceRuleActive: async (_p, { id, isActive }, ctx) => {
        const actor = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN');
        const { rows } = await query(
          'UPDATE price_rules SET is_active = $2, updated_at = now() WHERE id = $1 RETURNING *',
          [id, isActive],
        );
        if (!rows[0]) throw httpError('Price rule not found', 404);
        await logActivity(actor.sub, 'TOGGLE_PRICE_RULE', 'price_rule', id);
        return mapRule(rows[0]);
      },
      deletePriceRule: async (_p, { id }, ctx) => {
        const actor = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN');
        const { rowCount } = await query('DELETE FROM price_rules WHERE id = $1', [id]);
        if (!rowCount) throw httpError('Price rule not found', 404);
        await logActivity(actor.sub, 'DELETE_PRICE_RULE', 'price_rule', id);
        return true;
      },

      createScheme: async (_p, { input }, ctx) => {
        const actor = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN');
        const { rows } = await query(
          `INSERT INTO schemes (name, scheme_type, description, config, valid_from, valid_to)
           VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
          schemeValues(input),
        );
        await logActivity(actor.sub, 'CREATE_SCHEME', 'scheme', rows[0].id);
        return mapScheme(rows[0]);
      },
      updateScheme: async (_p, { id, input }, ctx) => {
        const actor = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN');
        const { rows } = await query(
          `UPDATE schemes SET name=$2, scheme_type=$3, description=$4, config=$5,
             valid_from=$6, valid_to=$7, updated_at=now() WHERE id=$1 RETURNING *`,
          [id, ...schemeValues(input)],
        );
        if (!rows[0]) throw httpError('Scheme not found', 404);
        await logActivity(actor.sub, 'UPDATE_SCHEME', 'scheme', id);
        return mapScheme(rows[0]);
      },
      setSchemeActive: async (_p, { id, isActive }, ctx) => {
        const actor = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN');
        const { rows } = await query(
          'UPDATE schemes SET is_active = $2, updated_at = now() WHERE id = $1 RETURNING *',
          [id, isActive],
        );
        if (!rows[0]) throw httpError('Scheme not found', 404);
        await logActivity(actor.sub, 'TOGGLE_SCHEME', 'scheme', id);
        return mapScheme(rows[0]);
      },
      deleteScheme: async (_p, { id }, ctx) => {
        const actor = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN');
        const { rowCount } = await query('DELETE FROM schemes WHERE id = $1', [id]);
        if (!rowCount) throw httpError('Scheme not found', 404);
        await logActivity(actor.sub, 'DELETE_SCHEME', 'scheme', id);
        return true;
      },
    },

    PriceRule: {
      product: async (parent) => {
        const { rows } = await query('SELECT * FROM products WHERE id = $1', [parent.productId]);
        return rows[0] ? mapProduct(rows[0]) : null;
      },
    },
  };
}
