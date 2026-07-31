// GraphQL module: Farmer Engagement Analytics (PRD §11.4).
// Aggregations over the farmer registry, device links, languages and loyalty.

import { query } from '../../db/index.js';
import { assertRole } from '../context.js';
import { num } from '../helpers.js';

export const engagementTypeDefs = /* GraphQL */ `
  type LabelCount { label: String!, count: Int! }
  type MonthCount { label: String!, count: Int! }

  type FarmerEngagement {
    total: Int!
    appLinked: Int!
    appLinkedPct: Float!
    activeFarmers: Int!
    pointsIssued: Int!
    pointsRedeemed: Int!
    complaints: Int!
    registrationsTrend: [MonthCount!]!
    byState: [LabelCount!]!
    byLanguage: [LabelCount!]!
    byDistrict: [LabelCount!]!
  }

  extend type Query {
    farmerEngagement: FarmerEngagement!
  }
`;

export function engagementResolvers() {
  return {
    Query: {
      farmerEngagement: async (_p, _a, ctx) => {
        assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN', 'SALES');

        const totals = await query(
          `SELECT COUNT(*)::int total,
                  COUNT(*) FILTER (WHERE fcm_token IS NOT NULL)::int app_linked
           FROM farmers`,
        );
        const active = await query('SELECT COUNT(DISTINCT farmer_id)::int n FROM loyalty_transactions');
        const pts = await query(
          `SELECT COALESCE(SUM(points) FILTER (WHERE points > 0),0)::int issued,
                  COALESCE(-SUM(points) FILTER (WHERE points < 0),0)::int redeemed
           FROM loyalty_transactions`,
        );
        const comp = await query('SELECT COUNT(*)::int n FROM complaints WHERE farmer_id IS NOT NULL');

        const trend = await query(
          `WITH months AS (
             SELECT date_trunc('month', CURRENT_DATE) - (n || ' months')::interval AS m
             FROM generate_series(5, 0, -1) AS n
           )
           SELECT to_char(months.m, 'Mon') label, COUNT(f.id)::int count
           FROM months LEFT JOIN farmers f ON date_trunc('month', f.created_at) = months.m
           GROUP BY months.m ORDER BY months.m`,
        );
        const byState = await query(
          "SELECT COALESCE(NULLIF(state,''),'Unknown') label, COUNT(*)::int count FROM farmers GROUP BY 1 ORDER BY count DESC LIMIT 10",
        );
        const byLang = await query(
          "SELECT COALESCE(NULLIF(language,''),'en') label, COUNT(*)::int count FROM farmers GROUP BY 1 ORDER BY count DESC",
        );
        const byDistrict = await query(
          "SELECT COALESCE(NULLIF(district,''),'Unknown') label, COUNT(*)::int count FROM farmers GROUP BY 1 ORDER BY count DESC LIMIT 8",
        );

        const total = totals.rows[0].total;
        const appLinked = totals.rows[0].app_linked;
        return {
          total,
          appLinked,
          appLinkedPct: total > 0 ? Math.round((appLinked / total) * 1000) / 10 : 0,
          activeFarmers: active.rows[0].n,
          pointsIssued: pts.rows[0].issued,
          pointsRedeemed: pts.rows[0].redeemed,
          complaints: comp.rows[0].n,
          registrationsTrend: trend.rows.map((r) => ({ label: r.label, count: num(r.count) })),
          byState: byState.rows.map((r) => ({ label: r.label, count: r.count })),
          byLanguage: byLang.rows.map((r) => ({ label: r.label, count: r.count })),
          byDistrict: byDistrict.rows.map((r) => ({ label: r.label, count: r.count })),
        };
      },
    },
  };
}
