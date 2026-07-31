// GraphQL module: Demand Forecasting (PRD §13, Phase 4).
// Heuristic forecast (recency-weighted moving average + trend) over historical
// sales (distributor/farmer orders + direct party sales), with stock-cover and
// reorder suggestions. No external ML dependency — explainable and deterministic.

import { query } from '../../db/index.js';
import { assertRole } from '../context.js';
import { num } from '../helpers.js';

export const forecastTypeDefs = /* GraphQL */ `
  type ForecastPoint { label: String!, qty: Float! }
  type ForecastItem {
    productId: ID!
    productName: String!
    uom: String
    avgMonthly: Float!
    lastMonth: Float!
    trendPct: Float!
    forecastNext: Float!
    currentStock: Float!
    monthsCover: Float!
    suggestedReorder: Float!
    history: [ForecastPoint!]!
  }
  type DemandForecast {
    months: Int!
    productsAnalyzed: Int!
    forecastUnits: Float!
    stockoutRisks: Int!
    reorderItems: Int!
    trend: [ForecastPoint!]!
    items: [ForecastItem!]!
  }

  extend type Query {
    demandForecast(months: Int = 6): DemandForecast!
  }
`;

const round1 = (n) => Math.round(n * 10) / 10;
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);

export function forecastResolvers() {
  return {
    Query: {
      demandForecast: async (_p, { months }, ctx) => {
        assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN', 'SALES');
        const N = Math.max(3, Math.min(24, months || 6));

        // Month buckets (oldest → newest).
        const now = new Date();
        const buckets = [];
        for (let i = N - 1; i >= 0; i--) {
          const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
          buckets.push({ key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`, label: d.toLocaleString('en-US', { month: 'short' }) });
        }
        const idxOf = new Map(buckets.map((b, i) => [b.key, i]));

        // Monthly sold quantity per product = order lines (non-cancelled) + direct party sales.
        const { rows } = await query(
          `WITH sales AS (
             SELECT ol.product_id, to_char(date_trunc('month', o.order_date),'YYYY-MM') ym, SUM(ol.quantity) qty
             FROM order_lines ol JOIN orders o ON o.id = ol.order_id
             WHERE o.status <> 'CANCELLED' AND o.order_date >= date_trunc('month', CURRENT_DATE) - (($1 - 1) || ' months')::interval
             GROUP BY 1,2
             UNION ALL
             SELECT psl.product_id, to_char(date_trunc('month', ps.sale_date),'YYYY-MM') ym, SUM(psl.quantity) qty
             FROM party_sale_lines psl JOIN party_sales ps ON ps.id = psl.sale_id
             WHERE ps.sale_date >= date_trunc('month', CURRENT_DATE) - (($1 - 1) || ' months')::interval
             GROUP BY 1,2
           )
           SELECT s.product_id, s.ym, SUM(s.qty) qty, p.name, p.uom
           FROM sales s JOIN products p ON p.id = s.product_id
           GROUP BY s.product_id, s.ym, p.name, p.uom`,
          [N],
        );

        // Current stock per product.
        const stockRows = (await query('SELECT product_id, COALESCE(SUM(quantity),0) q FROM stock_levels GROUP BY product_id')).rows;
        const stockMap = new Map(stockRows.map((r) => [r.product_id, num(r.q)]));

        // Assemble per-product series.
        const byProduct = new Map();
        for (const r of rows) {
          let e = byProduct.get(r.product_id);
          if (!e) { e = { productId: r.product_id, name: r.name, uom: r.uom, series: new Array(N).fill(0) }; byProduct.set(r.product_id, e); }
          const i = idxOf.get(r.ym);
          if (i !== undefined) e.series[i] += num(r.qty);
        }

        const items = [];
        const overall = new Array(N).fill(0);
        for (const e of byProduct.values()) {
          e.series.forEach((q, i) => { overall[i] += q; });
          const avgMonthly = mean(e.series);
          const lastMonth = e.series[N - 1];
          const recent3 = mean(e.series.slice(-3));
          const prev3 = mean(e.series.slice(-6, -3));
          const trendPct = prev3 > 0 ? Math.round(((recent3 - prev3) / prev3) * 100) : 0;
          const forecastNext = Math.max(0, Math.round(recent3 * (1 + clamp(trendPct / 100, -0.5, 0.5))));
          const currentStock = stockMap.get(e.productId) ?? 0;
          const monthsCover = forecastNext > 0 ? round1(currentStock / forecastNext) : (currentStock > 0 ? 99 : 0);
          const suggestedReorder = Math.max(0, Math.round(forecastNext * 1.5 - currentStock));
          items.push({
            productId: e.productId, productName: e.name, uom: e.uom,
            avgMonthly: round1(avgMonthly), lastMonth: round1(lastMonth), trendPct,
            forecastNext, currentStock: round1(currentStock), monthsCover, suggestedReorder,
            history: buckets.map((b, i) => ({ label: b.label, qty: round1(e.series[i]) })),
          });
        }
        items.sort((a, b) => b.forecastNext - a.forecastNext);

        return {
          months: N,
          productsAnalyzed: items.length,
          forecastUnits: Math.round(items.reduce((s, it) => s + it.forecastNext, 0)),
          stockoutRisks: items.filter((it) => it.forecastNext > 0 && it.monthsCover < 1).length,
          reorderItems: items.filter((it) => it.suggestedReorder > 0).length,
          trend: buckets.map((b, i) => ({ label: b.label, qty: round1(overall[i]) })),
          items,
        };
      },
    },
  };
}
