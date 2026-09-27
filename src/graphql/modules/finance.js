// GraphQL module: Finance — credit/debit notes, overdue invoices, payment reminders.
// (Party ledgers live in parties.js → partyLedger.)

import { query, withTransaction } from '../../db/index.js';
import { assertRole } from '../context.js';
import { httpError, logActivity, num, isoDate } from '../helpers.js';
import { dispatch } from '../../services/notify/index.js';
import { splitTax, roundGst } from '../../services/gst/calc.js';
import { resolveStateCode } from '../../services/gst/stateCodes.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// GSTR-1 CDNR reason codes: 01 Sales Return, 02 Post-sale discount, 03 Deficiency in service, 04 Correction in invoice, 05 Others.
const NOTE_REASONS = new Set(['01', '02', '03', '04', '05']);

export const financeTypeDefs = /* GraphQL */ `
  type CreditDebitNote {
    id: ID!
    noteNo: String!
    distributorId: ID!
    distributorName: String
    noteType: String!
    amount: Float!
    taxableValue: Float
    gstRate: Float
    cgst: Float!
    sgst: Float!
    igst: Float!
    isInterstate: Boolean!
    reason: String
    noteReason: String
    refInvoiceNo: String
    createdAt: DateTime!
  }

  type OverdueInvoice {
    invoiceNo: String!
    distributorName: String!
    customerType: String!
    invoiceDate: String!
    balance: Float!
    ageDays: Int!
  }

  type ReminderResult { sent: Int!, status: String!, note: String }

  input CreditDebitNoteInput {
    distributorId: ID!
    noteType: String!     # CREDIT / DEBIT
    amount: Float          # total incl. tax; ignored (derived) when taxableValue + gstRate are given
    taxableValue: Float    # optional — when given with gstRate, tax is split exactly (IGST or CGST+SGST)
    gstRate: Float
    isInterstate: Boolean
    noteReason: String     # 01 Sales Return / 02 Post-sale discount / 03 Deficiency / 04 Correction / 05 Other
    reason: String
    refInvoiceId: ID
  }

  extend type Query {
    creditDebitNotes(distributorId: ID): [CreditDebitNote!]!
    overdueInvoices(distributorId: ID): [OverdueInvoice!]!
  }

  extend type Mutation {
    createCreditDebitNote(input: CreditDebitNoteInput!): CreditDebitNote!
    sendPaymentReminder(distributorId: ID!): ReminderResult!
  }
`;

function fy(dateStr) {
  const d = dateStr ? new Date(dateStr) : new Date();
  const y = d.getFullYear();
  const start = d.getMonth() >= 3 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

const mapNote = (r) => ({
  id: r.id,
  noteNo: r.note_no,
  distributorId: r.distributor_id,
  distributorName: r.dname ?? null,
  noteType: r.note_type,
  amount: num(r.amount),
  taxableValue: num(r.taxable_value),
  gstRate: num(r.gst_rate),
  cgst: num(r.cgst) ?? 0,
  sgst: num(r.sgst) ?? 0,
  igst: num(r.igst) ?? 0,
  isInterstate: !!r.is_interstate,
  reason: r.reason,
  noteReason: r.note_reason ?? null,
  refInvoiceNo: r.ref_invoice_no ?? null,
  createdAt: r.created_at,
});

export function financeResolvers() {
  return {
    Query: {
      creditDebitNotes: async (_p, { distributorId }, ctx) => {
        assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN', 'SALES');
        const { rows } = await query(
          `SELECT n.*, d.name dname, i.invoice_no ref_invoice_no
           FROM credit_debit_notes n JOIN distributors d ON d.id = n.distributor_id
           LEFT JOIN invoices i ON i.id = n.ref_invoice_id
           WHERE ($1::uuid IS NULL OR n.distributor_id = $1)
           ORDER BY n.created_at DESC LIMIT 200`,
          [distributorId || null],
        );
        return rows.map(mapNote);
      },

      overdueInvoices: async (_p, { distributorId }, ctx) => {
        assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN', 'SALES');
        const { rows } = await query(
          `SELECT i.invoice_no, COALESCE(d.name, f.name) dname,
                  COALESCE(i.customer_type, 'DISTRIBUTOR') customer_type,
                  i.invoice_date, (i.total_amount - i.amount_paid) bal,
                  (CURRENT_DATE - i.invoice_date) age
           FROM invoices i
           LEFT JOIN distributors d ON d.id = i.distributor_id
           LEFT JOIN farmers f ON f.id = i.farmer_id
           WHERE i.total_amount > i.amount_paid AND i.status <> 'CANCELLED' AND (CURRENT_DATE - i.invoice_date) > 30
             AND ($1::uuid IS NULL OR i.distributor_id = $1)
           ORDER BY age DESC LIMIT 500`,
          [distributorId || null],
        );
        return rows.map((r) => ({
          invoiceNo: r.invoice_no, distributorName: r.dname ?? '—', customerType: r.customer_type,
          invoiceDate: isoDate(r.invoice_date), balance: num(r.bal), ageDays: Number(r.age),
        }));
      },
    },

    Mutation: {
      createCreditDebitNote: async (_p, { input }, ctx) => {
        const actor = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN');
        const type = input.noteType;
        if (type !== 'CREDIT' && type !== 'DEBIT') throw httpError('Note type must be CREDIT or DEBIT', 400);
        if (!UUID_RE.test(input.distributorId ?? '')) throw httpError('Select a distributor', 400);
        const refInvoiceId = input.refInvoiceId || null;
        if (refInvoiceId && !UUID_RE.test(refInvoiceId)) throw httpError('Invalid reference invoice', 400);
        const noteReason = input.noteReason || null;
        if (noteReason && !NOTE_REASONS.has(noteReason)) throw httpError('Invalid note reason (use 01–05)', 400);
        if ((input.taxableValue == null) !== (input.gstRate == null)) throw httpError('Enter both taxable value and GST rate, or neither', 400);
        const hasTax = input.taxableValue != null;
        if (hasTax && !(input.taxableValue > 0)) throw httpError('Taxable value must be greater than zero', 400);
        if (hasTax && !(input.gstRate >= 0 && input.gstRate <= 40)) throw httpError('GST rate must be between 0 and 40%', 400);

        const [dist, company, ref] = await Promise.all([
          query('SELECT state, gstin FROM distributors WHERE id = $1', [input.distributorId]),
          query('SELECT state, gstin FROM company_settings WHERE id = 1'),
          refInvoiceId ? query('SELECT distributor_id, is_interstate FROM invoices WHERE id = $1', [refInvoiceId]) : { rows: [] },
        ]);
        const d = dist.rows[0];
        if (!d) throw httpError('Distributor not found', 404);
        const ri = ref.rows[0];
        if (refInvoiceId && ri?.distributor_id !== input.distributorId) throw httpError('Reference invoice does not belong to this distributor', 400);

        // Place of supply: explicit flag → linked invoice → company vs distributor state.
        let interstate = input.isInterstate ?? (ri ? !!ri.is_interstate : null);
        if (interstate == null) {
          const c = company.rows[0] ?? {};
          const from = resolveStateCode({ gstin: c.gstin, stateName: c.state });
          const to = resolveStateCode({ gstin: d.gstin, stateName: d.state });
          interstate = !!(from && to && from !== to);
        }

        let taxable = null, rate = null, cgst = 0, sgst = 0, igst = 0;
        let amount = roundGst(input.amount ?? 0);
        if (hasTax) {
          taxable = roundGst(input.taxableValue);
          rate = input.gstRate;
          ({ cgst, sgst, igst } = splitTax(taxable, rate, interstate));
          amount = roundGst(taxable + cgst + sgst + igst); // note value is always taxable + tax
        }
        if (!(amount > 0)) throw httpError('Amount must be greater than zero', 400);

        const row = await withTransaction(async (client) => {
          const seq = (await client.query("SELECT nextval('note_seq') AS n")).rows[0].n;
          const noteNo = `${type === 'CREDIT' ? 'CN' : 'DN'}-${fy()}-${String(seq).padStart(5, '0')}`;
          const { rows } = await client.query(
            `INSERT INTO credit_debit_notes (note_no, distributor_id, note_type, amount, taxable_value, gst_rate, cgst, sgst, igst, is_interstate, note_reason, reason, ref_invoice_id, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
            [noteNo, input.distributorId, type, amount, taxable, rate, cgst, sgst, igst, interstate, noteReason, input.reason?.trim() || null, refInvoiceId, actor.sub],
          );
          // CREDIT note reduces outstanding; DEBIT note increases it.
          await client.query('UPDATE distributors SET outstanding = GREATEST(outstanding + $2, 0) WHERE id = $1', [input.distributorId, type === 'CREDIT' ? -amount : amount]);
          return rows[0];
        });
        await logActivity(actor.sub, 'CREATE_NOTE', 'credit_debit_note', row.id, { type, amount });
        return mapNote(row);
      },

      sendPaymentReminder: async (_p, { distributorId }, ctx) => {
        const actor = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN', 'SALES');
        if (!UUID_RE.test(distributorId ?? '')) throw httpError('Select a distributor', 400);
        // Same balance the Outstanding page shows: running outstanding + unpaid direct sales.
        const d = await query(
          `SELECT d.name, d.email,
                  d.outstanding + COALESCE((SELECT SUM(total_amount - amount_paid) FROM party_sales WHERE distributor_id = d.id), 0) AS due
           FROM distributors d WHERE d.id = $1`,
          [distributorId],
        );
        if (!d.rows[0]) throw httpError('Distributor not found', 404);
        const dist = d.rows[0];
        const due = num(dist.due) ?? 0;
        if (!dist.email) return { sent: 0, status: 'SKIPPED', note: 'No email on file for this distributor — add one on the distributor profile.' };
        if (due <= 0) return { sent: 0, status: 'SKIPPED', note: 'No outstanding balance' };

        const title = 'Payment reminder';
        const amt = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(due);
        const body = `Dear ${dist.name},\n\nOur records show an outstanding balance of ${amt}. Kindly arrange payment at the earliest.\n\nThank you.`;
        const { results, sent, status } = await dispatch({ channels: ['EMAIL'], title, body, emails: [dist.email] });
        const r0 = results?.[0] ?? {};
        if (r0.skipped) return { sent: 0, status: 'SKIPPED', note: 'Email is not configured on the server (SMTP), so the reminder was not sent.' };
        await logActivity(actor.sub, 'PAYMENT_REMINDER', 'distributor', distributorId, { sent });
        return { sent, status, note: r0.error ?? r0.note ?? null };
      },
    },
  };
}
