// GraphQL module: Operations — Audit Log viewer + Alerts center.

import { query } from '../../db/index.js';
import { assertRole } from '../context.js';
import { num } from '../helpers.js';

export const opsTypeDefs = /* GraphQL */ `
  type AuditLog {
    id: ID!
    action: String!
    entity: String
    entityId: ID
    actorName: String
    actorEmail: String
    actorRole: String
    ipAddress: String
    metadata: JSON
    createdAt: DateTime!
  }

  type Alert {
    type: String!        # LOW_STOCK / EXPIRY / OVERDUE / CREDIT_BREACH
    severity: String!    # HIGH / MEDIUM / LOW
    title: String!
    detail: String
    amount: Float
  }

  type AlertCounts {
    lowStock: Int!
    expiring: Int!
    overdue: Int!
    creditBreach: Int!
    total: Int!
  }

  extend type Query {
    auditLogs(action: String, entity: String, search: String, limit: Int = 25, offset: Int = 0): [AuditLog!]!
    auditLogCount(action: String, entity: String, search: String): Int!
    auditLogFilters: AuditFilters!
    alerts: [Alert!]!
    alertCounts: AlertCounts!
  }

  type AuditFilters {
    actions: [String!]!
    entities: [String!]!
  }
`;

export function opsResolvers() {
  return {
    Query: {
      auditLogs: async (_p, { action, entity, search, limit, offset }, ctx) => {
        assertRole(ctx, 'SUPER_ADMIN', 'ADMIN');
        const { rows } = await query(
          `SELECT a.*, u.name actor_name, u.email actor_email, u.role actor_role
           FROM activity_logs a LEFT JOIN users u ON u.id = a.user_id
           WHERE ($1::text IS NULL OR a.action = $1)
             AND ($2::text IS NULL OR a.entity = $2)
             AND ($3::text IS NULL OR a.action ILIKE '%' || $3 || '%' OR u.name ILIKE '%' || $3 || '%' OR a.entity ILIKE '%' || $3 || '%')
           ORDER BY a.created_at DESC LIMIT $4 OFFSET $5`,
          [action ?? null, entity ?? null, search ?? null, limit, offset],
        );
        return rows.map((r) => ({
          id: r.id, action: r.action, entity: r.entity, entityId: r.entity_id,
          actorName: r.actor_name, actorEmail: r.actor_email, actorRole: r.actor_role,
          ipAddress: r.ip_address, metadata: r.metadata, createdAt: r.created_at,
        }));
      },
      auditLogCount: async (_p, { action, entity, search }, ctx) => {
        assertRole(ctx, 'SUPER_ADMIN', 'ADMIN');
        const { rows } = await query(
          `SELECT COUNT(*)::int AS n
           FROM activity_logs a LEFT JOIN users u ON u.id = a.user_id
           WHERE ($1::text IS NULL OR a.action = $1)
             AND ($2::text IS NULL OR a.entity = $2)
             AND ($3::text IS NULL OR a.action ILIKE '%' || $3 || '%' OR u.name ILIKE '%' || $3 || '%' OR a.entity ILIKE '%' || $3 || '%')`,
          [action ?? null, entity ?? null, search ?? null],
        );
        return rows[0].n;
      },
      auditLogFilters: async (_p, _a, ctx) => {
        assertRole(ctx, 'SUPER_ADMIN', 'ADMIN');
        const actions = await query('SELECT DISTINCT action FROM activity_logs ORDER BY action');
        const entities = await query("SELECT DISTINCT entity FROM activity_logs WHERE entity IS NOT NULL ORDER BY entity");
        return { actions: actions.rows.map((r) => r.action), entities: entities.rows.map((r) => r.entity) };
      },

      alerts: async (_p, _a, ctx) => {
        assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN', 'SALES');
        const out = [];

        const low = await query(
          `SELECT p.name, w.name wname, sl.quantity, sl.reorder_level
           FROM stock_levels sl JOIN products p ON p.id = sl.product_id JOIN warehouses w ON w.id = sl.warehouse_id
           WHERE sl.quantity <= sl.reorder_level ORDER BY sl.quantity ASC LIMIT 25`,
        );
        for (const r of low.rows) {
          out.push({
            type: 'LOW_STOCK', severity: num(r.quantity) <= 0 ? 'HIGH' : 'MEDIUM',
            title: `Low stock: ${r.name}`,
            detail: `${num(r.quantity)} ≤ reorder ${num(r.reorder_level)} at ${r.wname}`,
            amount: null,
          });
        }

        const exp = await query(
          `SELECT p.name, b.batch_number, b.expiry_date, sl.quantity,
                  (b.expiry_date - CURRENT_DATE) days
           FROM stock_levels sl JOIN batches b ON b.id = sl.batch_id JOIN products p ON p.id = sl.product_id
           WHERE sl.quantity > 0 AND b.expiry_date IS NOT NULL AND b.expiry_date <= CURRENT_DATE + INTERVAL '30 days'
           ORDER BY b.expiry_date ASC LIMIT 25`,
        );
        for (const r of exp.rows) {
          const d = Number(r.days);
          out.push({
            type: 'EXPIRY', severity: d <= 7 ? 'HIGH' : 'MEDIUM',
            title: `Expiring: ${r.name} (${r.batch_number})`,
            detail: `${num(r.quantity)} units · expires in ${d} day(s)`,
            amount: null,
          });
        }

        const over = await query(
          `SELECT d.name, (i.total_amount - i.amount_paid) bal, (CURRENT_DATE - i.invoice_date) age, i.invoice_no
           FROM invoices i JOIN distributors d ON d.id = i.distributor_id
           WHERE i.total_amount > i.amount_paid AND i.status <> 'CANCELLED' AND (CURRENT_DATE - i.invoice_date) > 30
           ORDER BY age DESC LIMIT 25`,
        );
        for (const r of over.rows) {
          out.push({
            type: 'OVERDUE', severity: Number(r.age) > 90 ? 'HIGH' : 'MEDIUM',
            title: `Overdue: ${r.name}`,
            detail: `${r.invoice_no} · ${Number(r.age)} days overdue`,
            amount: num(r.bal),
          });
        }

        const credit = await query(
          `SELECT name, outstanding, credit_limit FROM distributors
           WHERE credit_limit > 0 AND outstanding > credit_limit ORDER BY (outstanding - credit_limit) DESC LIMIT 25`,
        );
        for (const r of credit.rows) {
          out.push({
            type: 'CREDIT_BREACH', severity: 'HIGH',
            title: `Credit breach: ${r.name}`,
            detail: `Outstanding ${num(r.outstanding)} > limit ${num(r.credit_limit)}`,
            amount: num(r.outstanding) - num(r.credit_limit),
          });
        }

        return out;
      },

      alertCounts: async (_p, _a, ctx) => {
        assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN', 'SALES');
        const { rows } = await query(
          `SELECT
             (SELECT COUNT(*) FROM stock_levels WHERE quantity <= reorder_level)::int low_cnt,
             (SELECT COUNT(*) FROM stock_levels sl JOIN batches b ON b.id = sl.batch_id
              WHERE sl.quantity > 0 AND b.expiry_date IS NOT NULL AND b.expiry_date <= CURRENT_DATE + INTERVAL '30 days')::int exp_cnt,
             (SELECT COUNT(*) FROM invoices WHERE total_amount > amount_paid AND status <> 'CANCELLED' AND (CURRENT_DATE - invoice_date) > 30)::int over_cnt,
             (SELECT COUNT(*) FROM distributors WHERE credit_limit > 0 AND outstanding > credit_limit)::int credit_cnt`,
        );
        const r = rows[0];
        return {
          lowStock: r.low_cnt, expiring: r.exp_cnt, overdue: r.over_cnt, creditBreach: r.credit_cnt,
          total: r.low_cnt + r.exp_cnt + r.over_cnt + r.credit_cnt,
        };
      },
    },
  };
}
