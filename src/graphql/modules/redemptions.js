// GraphQL module: Loyalty redemption + distributor settlement.
// Farmers earn coins on referenced orders; coins are redeemed for a discount —
// honored by a distributor (or the company), then the company settles (reimburses)
// the distributor. ₹1 per coin.

import { query, withTransaction } from '../../db/index.js';
import { assertAuth, assertRole } from '../context.js';
import { httpError, logActivity, num } from '../helpers.js';

const VALUE_PER_POINT = 1; // ₹ per coin

export const redemptionTypeDefs = /* GraphQL */ `
  type Redemption {
    id: ID!
    redemptionNo: String!
    farmerId: ID!
    farmerName: String
    farmerCode: String
    points: Int!
    value: Float!
    distributorId: ID
    distributorName: String
    channel: String!
    note: String
    settled: Boolean!
    settledAt: DateTime
    createdAt: DateTime!
  }
  type RedemptionStats { totalRedeemed: Int!, unsettledValue: Float!, unsettledCount: Int! }
  type DistributorSettlement { distributorId: ID!, distributorName: String!, points: Int!, value: Float!, count: Int! }
  type SettlementPageInfo { currentPage: Int!, totalPages: Int!, totalRecords: Int!, limit: Int!, hasNextPage: Boolean!, hasPrevPage: Boolean! }
  type RedemptionPage { data: [Redemption!]!, pageInfo: SettlementPageInfo! }
  type DistributorSettlementPage { data: [DistributorSettlement!]!, pageInfo: SettlementPageInfo! }

  extend type Query {
    redemptions(settled: Boolean, distributorId: ID, limit: Int = 200): [Redemption!]!
    redemptionsPage(settled: Boolean, distributorId: ID, search: String, page: Int = 1, limit: Int = 25): RedemptionPage!
    redemptionStats: RedemptionStats!
    distributorSettlements: [DistributorSettlement!]!
    distributorSettlementsPage(search: String, page: Int = 1, limit: Int = 15): DistributorSettlementPage!
    myRedemptions: [Redemption!]!
    # Distributor App: coins this distributor has honored for farmers, newest first.
    distRedemptions: [Redemption!]!
  }

  extend type Mutation {
    # Admin/distributor honor: deduct a farmer's coins (by FARMER-CODE) and log who honored it.
    redeemForFarmer(farmerCode: String!, points: Int!, distributorId: ID, note: String): Redemption!
    # Farmer self-redeem from the app (company-honored).
    createMyRedemption(points: Int!, note: String): Redemption!
    # Distributor App: the logged-in distributor honors a farmer's coins (extra discount).
    distRedeemFarmerCoins(farmerCode: String!, points: Int!, note: String): Redemption!
    settleDistributor(distributorId: ID!): Int!
    markRedemptionSettled(id: ID!, settled: Boolean!): Redemption!
  }
`;

const SELECT = `SELECT r.*, f.name farmer_name, f.farmer_code, d.name distributor_name
  FROM redemptions r JOIN farmers f ON f.id = r.farmer_id LEFT JOIN distributors d ON d.id = r.distributor_id`;

const map = (r) => r && {
  id: r.id, redemptionNo: r.redemption_no, farmerId: r.farmer_id, farmerName: r.farmer_name, farmerCode: r.farmer_code,
  points: r.points, value: num(r.value), distributorId: r.distributor_id, distributorName: r.distributor_name,
  channel: r.channel, note: r.note, settled: r.settled, settledAt: r.settled_at, createdAt: r.created_at,
};

// Deduct points + record the redemption in one transaction.
async function doRedeem({ farmerId: fid, points, distributorId, channel, note, createdBy }) {
  if (!Number.isInteger(points) || points <= 0) throw httpError('Points must be a positive integer', 400);
  return withTransaction(async (client) => {
    const f = (await client.query('SELECT points_balance FROM farmers WHERE id=$1 FOR UPDATE', [fid])).rows[0];
    if (!f) throw httpError('Farmer not found', 404);
    if (num(f.points_balance) < points) throw httpError(`Insufficient coins: balance ${num(f.points_balance)}, requested ${points}`, 400);
    await client.query('UPDATE farmers SET points_balance = points_balance - $2 WHERE id=$1', [fid, points]);
    const no = `RDM-${String((await client.query("SELECT nextval('redemption_seq') n")).rows[0].n).padStart(5, '0')}`;
    const ins = await client.query(
      `INSERT INTO redemptions (redemption_no, farmer_id, points, value, distributor_id, channel, note, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [no, fid, points, points * VALUE_PER_POINT, distributorId ?? null, channel, note ?? null, createdBy ?? null],
    );
    await client.query(
      "INSERT INTO loyalty_transactions (farmer_id, points, type, note, created_by) VALUES ($1,$2,'REDEEM',$3,$4)",
      [fid, -points, note ?? `Redemption ${no}`, createdBy ?? null],
    );
    return map((await client.query(`${SELECT} WHERE r.id=$1`, [ins.rows[0].id])).rows[0]);
  });
}

export function redemptionResolvers() {
  return {
    Query: {
      redemptions: async (_p, { settled, distributorId, limit }, ctx) => {
        assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN', 'SALES');
        const { rows } = await query(
          `${SELECT} WHERE ($1::bool IS NULL OR r.settled=$1) AND ($2::uuid IS NULL OR r.distributor_id=$2)
           ORDER BY r.created_at DESC LIMIT $3`,
          [settled ?? null, distributorId ?? null, limit],
        );
        return rows.map(map);
      },
      redemptionsPage: async (_p, { settled, distributorId, search, page, limit }, ctx) => {
        assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN', 'SALES');
        const safeLimit = Math.min(Math.max(limit ?? 25, 1), 100);
        const requestedPage = Math.max(page ?? 1, 1);
        const offset = (requestedPage - 1) * safeLimit;
        const term = search?.trim() || null;
        const where = `WHERE ($1::bool IS NULL OR r.settled=$1)
          AND ($2::uuid IS NULL OR r.distributor_id=$2)
          AND ($3::text IS NULL OR r.redemption_no ILIKE '%' || $3 || '%'
               OR f.name ILIKE '%' || $3 || '%' OR f.farmer_code ILIKE '%' || $3 || '%'
               OR d.name ILIKE '%' || $3 || '%')`;
        const [countResult, dataResult] = await Promise.all([
          query(`SELECT COUNT(*)::int AS total FROM redemptions r JOIN farmers f ON f.id=r.farmer_id LEFT JOIN distributors d ON d.id=r.distributor_id ${where}`, [settled ?? null, distributorId ?? null, term]),
          query(`${SELECT} ${where} ORDER BY r.created_at DESC LIMIT $4 OFFSET $5`, [settled ?? null, distributorId ?? null, term, safeLimit, offset]),
        ]);
        const totalRecords = countResult.rows[0]?.total ?? 0;
        const totalPages = Math.max(1, Math.ceil(totalRecords / safeLimit));
        return {
          data: dataResult.rows.map(map),
          pageInfo: {
            currentPage: requestedPage,
            totalPages,
            totalRecords,
            limit: safeLimit,
            hasNextPage: requestedPage < totalPages,
            hasPrevPage: requestedPage > 1,
          },
        };
      },
      redemptionStats: async (_p, _a, ctx) => {
        assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN', 'SALES');
        const { rows } = await query(
          `SELECT COALESCE(SUM(points),0)::int total_redeemed,
                  COALESCE(SUM(value) FILTER (WHERE NOT settled AND distributor_id IS NOT NULL),0) unsettled_value,
                  COUNT(*) FILTER (WHERE NOT settled AND distributor_id IS NOT NULL)::int unsettled_count
           FROM redemptions`,
        );
        return { totalRedeemed: rows[0].total_redeemed, unsettledValue: num(rows[0].unsettled_value), unsettledCount: rows[0].unsettled_count };
      },
      distributorSettlements: async (_p, _a, ctx) => {
        assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN', 'SALES');
        const { rows } = await query(
          `SELECT r.distributor_id, d.name distributor_name, SUM(r.points)::int points, SUM(r.value) value, COUNT(*)::int count
           FROM redemptions r JOIN distributors d ON d.id = r.distributor_id
           WHERE NOT r.settled AND r.distributor_id IS NOT NULL
           GROUP BY r.distributor_id, d.name ORDER BY value DESC`,
        );
        return rows.map((r) => ({ distributorId: r.distributor_id, distributorName: r.distributor_name, points: r.points, value: num(r.value), count: r.count }));
      },
      distributorSettlementsPage: async (_p, { search, page, limit }, ctx) => {
        assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN', 'SALES');
        const safeLimit = Math.min(Math.max(limit ?? 15, 1), 100);
        const requestedPage = Math.max(page ?? 1, 1);
        const offset = (requestedPage - 1) * safeLimit;
        const term = search?.trim() || null;
        const base = `FROM redemptions r JOIN distributors d ON d.id=r.distributor_id
          WHERE NOT r.settled AND r.distributor_id IS NOT NULL
            AND ($1::text IS NULL OR d.name ILIKE '%' || $1 || '%')`;
        const [countResult, dataResult] = await Promise.all([
          query(`SELECT COUNT(*)::int AS total FROM (SELECT r.distributor_id ${base} GROUP BY r.distributor_id) grouped`, [term]),
          query(`SELECT r.distributor_id, d.name distributor_name, SUM(r.points)::int points, SUM(r.value) value, COUNT(*)::int count
                 ${base} GROUP BY r.distributor_id, d.name ORDER BY value DESC LIMIT $2 OFFSET $3`, [term, safeLimit, offset]),
        ]);
        const totalRecords = countResult.rows[0]?.total ?? 0;
        const totalPages = Math.max(1, Math.ceil(totalRecords / safeLimit));
        return {
          data: dataResult.rows.map((r) => ({ distributorId: r.distributor_id, distributorName: r.distributor_name, points: r.points, value: num(r.value), count: r.count })),
          pageInfo: {
            currentPage: requestedPage,
            totalPages,
            totalRecords,
            limit: safeLimit,
            hasNextPage: requestedPage < totalPages,
            hasPrevPage: requestedPage > 1,
          },
        };
      },
      myRedemptions: async (_p, _a, ctx) => {
        const u = assertAuth(ctx);
        if (u.kind !== 'FARMER') throw httpError('Farmer authentication required', 403);
        const { rows } = await query(`${SELECT} WHERE r.farmer_id=$1 ORDER BY r.created_at DESC`, [u.sub]);
        return rows.map(map);
      },
      distRedemptions: async (_p, _a, ctx) => {
        const u = assertAuth(ctx);
        if (u.kind !== 'DISTRIBUTOR') throw httpError('Distributor authentication required', 403);
        const { rows } = await query(`${SELECT} WHERE r.distributor_id=$1 ORDER BY r.created_at DESC`, [u.sub]);
        return rows.map(map);
      },
    },

    Mutation: {
      redeemForFarmer: async (_p, { farmerCode, points, distributorId, note }, ctx) => {
        const a = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN', 'SALES');
        const f = (await query('SELECT id FROM farmers WHERE farmer_code=$1', [farmerCode])).rows[0];
        if (!f) throw httpError('No farmer with that reference code', 404);
        const channel = distributorId ? 'DISTRIBUTOR' : 'ADMIN';
        const r = await doRedeem({ farmerId: f.id, points, distributorId, channel, note, createdBy: a.sub });
        await logActivity(a.sub, 'REDEEM_COINS', 'redemption', r.id, { farmerCode, points, distributorId });
        return r;
      },
      createMyRedemption: async (_p, { points, note }, ctx) => {
        const u = assertAuth(ctx);
        if (u.kind !== 'FARMER') throw httpError('Farmer authentication required', 403);
        const r = await doRedeem({ farmerId: u.sub, points, distributorId: null, channel: 'APP', note });
        await logActivity(null, 'REDEEM_COINS', 'redemption', r.id, { points, via: 'farmer-app' });
        return r;
      },
      distRedeemFarmerCoins: async (_p, { farmerCode, points, note }, ctx) => {
        const u = assertAuth(ctx);
        if (u.kind !== 'DISTRIBUTOR') throw httpError('Distributor authentication required', 403);
        const f = (await query('SELECT id FROM farmers WHERE farmer_code=$1', [farmerCode.trim()])).rows[0];
        if (!f) throw httpError('No farmer with that reference code', 404);
        const r = await doRedeem({ farmerId: f.id, points, distributorId: u.sub, channel: 'DISTRIBUTOR', note });
        await logActivity(null, 'REDEEM_COINS', 'redemption', r.id, { farmerCode, points, via: 'distributor-app' });
        return r;
      },
      settleDistributor: async (_p, { distributorId }, ctx) => {
        const a = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN');
        const { rowCount } = await query('UPDATE redemptions SET settled=true, settled_at=now() WHERE distributor_id=$1 AND NOT settled', [distributorId]);
        await logActivity(a.sub, 'SETTLE_DISTRIBUTOR', 'distributor', distributorId, { count: rowCount });
        return rowCount;
      },
      markRedemptionSettled: async (_p, { id, settled }, ctx) => {
        const a = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN');
        const { rows } = await query('UPDATE redemptions SET settled=$2, settled_at=CASE WHEN $2 THEN now() ELSE NULL END WHERE id=$1 RETURNING id', [id, settled]);
        if (!rows[0]) throw httpError('Redemption not found', 404);
        await logActivity(a.sub, 'MARK_REDEMPTION_SETTLED', 'redemption', id, { settled });
        return map((await query(`${SELECT} WHERE r.id=$1`, [id])).rows[0]);
      },
    },
  };
}
