// GraphQL module: GST Compliance Engine — E-Invoice (IRN) + E-Way Bill.
// Provider-abstracted (see services/gst). Persists e-docs + updates the invoice.

import { query, withTransaction } from '../../db/index.js';
import { assertRole } from '../context.js';
import { httpError, logActivity, num, isoDate } from '../helpers.js';
import { gstProvider, getGstProviderName } from '../../services/gst/index.js';
import { ewbValidUntil } from '../../services/gst/calc.js';

export const gstTypeDefs = /* GraphQL */ `
  type EInvoice {
    id: ID!
    invoiceId: ID!
    irn: String
    ackNo: String
    ackDate: DateTime
    signedQr: String
    status: String!
    provider: String!
    cancelReason: String
    createdAt: DateTime!
  }

  type EWayBill {
    id: ID!
    invoiceId: ID!
    ewbNo: String
    ewbDate: DateTime
    validUntil: DateTime
    distanceKm: Int
    transportMode: String
    vehicleNo: String
    transporterId: String
    status: String!
    provider: String!
    createdAt: DateTime!
  }

  input EWayBillInput {
    invoiceId: ID!
    distanceKm: Int!
    transportMode: String!
    vehicleNo: String
    transporterId: String
  }

  extend type Invoice {
    eInvoice: EInvoice
    ewayBill: EWayBill
  }

  extend type Query {
    gstProvider: String!
  }

  extend type Mutation {
    generateEInvoice(invoiceId: ID!): EInvoice!
    cancelEInvoice(invoiceId: ID!, reason: String!): EInvoice!
    generateEWayBill(input: EWayBillInput!): EWayBill!
    "Part-B update — change of vehicle / conveyance in transit."
    updateEWayBillVehicle(invoiceId: ID!, vehicleNo: String!, reason: String!): EWayBill!
    cancelEWayBill(invoiceId: ID!, reason: String!): EWayBill!
  }
`;

const EWB_THRESHOLD = 50000; // PRD §7.1: E-Way Bill required above ₹50,000
const MODES = ['ROAD', 'RAIL', 'AIR', 'SHIP'];
// Indian registration plate (e.g. MH12AB1234, DL1CAB1234), Bharat series (22BH1234AB) or a temporary TR number.
const VEHICLE_RE = /^([A-Z]{2}\d{1,2}[A-Z]{0,3}\d{4}|\d{2}BH\d{4}[A-Z]{1,2}|TR[A-Z0-9]{6,12})$/;
const normVehicle = (v) => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
/** NIC allows cancelling an IRN / e-way bill only within 24 hours of generation. */
function assertWithin24h(at, what, alt) {
  if (at && Date.now() - new Date(at).getTime() > 24 * 3600e3) throw httpError(`${what} can only be cancelled within 24 hours of generation — ${alt}`, 400);
}

const mapEInvoice = (r) =>
  r && {
    id: r.id,
    invoiceId: r.invoice_id,
    irn: r.irn,
    ackNo: r.ack_no,
    ackDate: r.ack_date,
    signedQr: r.signed_qr,
    status: r.status,
    provider: r.provider,
    cancelReason: r.cancel_reason,
    createdAt: r.created_at,
  };

const mapEwb = (r) =>
  r && {
    id: r.id,
    invoiceId: r.invoice_id,
    ewbNo: r.ewb_no,
    ewbDate: r.ewb_date,
    validUntil: r.valid_until,
    distanceKm: r.distance_km,
    transportMode: r.transport_mode,
    vehicleNo: r.vehicle_no,
    transporterId: r.transporter_id,
    status: r.status,
    provider: r.provider,
    createdAt: r.created_at,
  };

async function loadInvoiceContext(invoiceId) {
  const inv = (await query('SELECT * FROM invoices WHERE id = $1', [invoiceId])).rows[0];
  if (!inv) throw httpError('Invoice not found', 404);
  const [{ rows: [company] }, { rows: [distributor] }, { rows: lines }] = await Promise.all([
    query('SELECT * FROM company_settings WHERE id = 1'),
    query('SELECT * FROM distributors WHERE id = $1', [inv.distributor_id]),
    query('SELECT * FROM order_lines WHERE order_id = $1', [inv.order_id]),
  ]);
  return {
    invoice: {
      invoiceNo: inv.invoice_no,
      invoiceDate: isoDate(inv.invoice_date),
      totalAmount: num(inv.total_amount),
      taxableValue: num(inv.taxable_value),
    },
    company,
    distributor,
    lines,
    raw: inv,
  };
}

export function gstResolvers() {
  return {
    Query: {
      gstProvider: () => getGstProviderName(),
    },

    Mutation: {
      generateEInvoice: async (_p, { invoiceId }, ctx) => {
        const actor = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN', 'SALES');
        const existing = await query("SELECT * FROM e_invoices WHERE invoice_id = $1 AND status = 'GENERATED'", [invoiceId]);
        if (existing.rows[0]) throw httpError('E-Invoice already generated for this invoice', 409);
        const ctxData = await loadInvoiceContext(invoiceId);
        if (ctxData.raw.bill_type === 'NON_GST') throw httpError('E-Invoice (IRN) applies only to GST tax invoices, not a Bill of Supply', 400);
        if (!ctxData.company?.gstin) throw httpError('Set the company GSTIN (Company Details) before generating an E-Invoice', 400);

        const res = await gstProvider.generateIRN(ctxData);
        const row = await withTransaction(async (client) => {
          const { rows } = await client.query(
            `INSERT INTO e_invoices (invoice_id, irn, ack_no, ack_date, signed_qr, signed_invoice, status, provider)
             VALUES ($1,$2,$3,$4,$5,$6,'GENERATED',$7)
             ON CONFLICT (invoice_id) DO UPDATE SET
               irn=EXCLUDED.irn, ack_no=EXCLUDED.ack_no, ack_date=EXCLUDED.ack_date,
               signed_qr=EXCLUDED.signed_qr, signed_invoice=EXCLUDED.signed_invoice,
               status='GENERATED', provider=EXCLUDED.provider, cancel_reason=NULL, updated_at=now()
             RETURNING *`,
            [invoiceId, res.irn, res.ackNo, res.ackDate, res.signedQr, res.signedInvoice, res.provider],
          );
          await client.query('UPDATE invoices SET irn = $2 WHERE id = $1', [invoiceId, res.irn]);
          return rows[0];
        });
        await logActivity(actor.sub, 'GENERATE_EINVOICE', 'invoice', invoiceId, { provider: res.provider });
        return mapEInvoice(row);
      },

      cancelEInvoice: async (_p, { invoiceId, reason }, ctx) => {
        const actor = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN');
        reason = String(reason || '').trim();
        if (!reason) throw httpError('Enter a reason for cancelling the E-Invoice', 400);
        const cur = (await query("SELECT ack_date, created_at FROM e_invoices WHERE invoice_id=$1 AND status='GENERATED'", [invoiceId])).rows[0];
        if (!cur) throw httpError('No active E-Invoice to cancel', 404);
        assertWithin24h(cur.ack_date || cur.created_at, 'An IRN', 'issue a credit note instead');
        await gstProvider.cancelIRN({ invoiceId, reason });
        const { rows } = await query(
          "UPDATE e_invoices SET status='CANCELLED', cancel_reason=$2, updated_at=now() WHERE invoice_id=$1 RETURNING *",
          [invoiceId, reason],
        );
        if (!rows[0]) throw httpError('No E-Invoice to cancel', 404);
        await query('UPDATE invoices SET irn = NULL WHERE id = $1', [invoiceId]);
        await logActivity(actor.sub, 'CANCEL_EINVOICE', 'invoice', invoiceId, { reason });
        return mapEInvoice(rows[0]);
      },

      generateEWayBill: async (_p, { input }, ctx) => {
        const actor = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN', 'SALES');
        const mode = String(input.transportMode || 'ROAD').toUpperCase();
        if (!MODES.includes(mode)) throw httpError(`Transport mode must be one of ${MODES.join(', ')}`, 400);
        if (!(input.distanceKm >= 1 && input.distanceKm <= 4000)) throw httpError('Distance must be between 1 and 4000 km', 400);
        const vehicleNo = normVehicle(input.vehicleNo) || null;
        if (mode === 'ROAD' && !vehicleNo) throw httpError('Vehicle number is required for road transport (Part-B)', 400);
        if (vehicleNo && mode === 'ROAD' && !VEHICLE_RE.test(vehicleNo)) throw httpError(`"${input.vehicleNo}" is not a valid vehicle number (e.g. MH12AB1234)`, 400);
        const transporterId = String(input.transporterId || '').trim().toUpperCase() || null;
        const ctxData = await loadInvoiceContext(input.invoiceId);
        if (ctxData.raw.bill_type === 'NON_GST') throw httpError('E-Way Bill applies only to GST tax invoices, not a Bill of Supply', 400);
        // ponytail: below EWB_THRESHOLD (₹50,000) an EWB is optional — allowed, not blocked.
        const res = await gstProvider.generateEWB({ invoice: ctxData.invoice, distanceKm: input.distanceKm, transportMode: mode, vehicleNo, transporterId });
        // Validity per Rule 138(10) when the GSP doesn't echo it: 1 day per 200 km.
        const validUntil = res.validUntil || ewbValidUntil(res.ewbDate, input.distanceKm);
        const row = await withTransaction(async (client) => {
          const { rows } = await client.query(
            `INSERT INTO eway_bills (invoice_id, ewb_no, ewb_date, valid_until, distance_km, transport_mode, vehicle_no, transporter_id, status, provider)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'GENERATED',$9)
             ON CONFLICT (invoice_id) DO UPDATE SET
               ewb_no=EXCLUDED.ewb_no, ewb_date=EXCLUDED.ewb_date, valid_until=EXCLUDED.valid_until,
               distance_km=EXCLUDED.distance_km, transport_mode=EXCLUDED.transport_mode,
               vehicle_no=EXCLUDED.vehicle_no, transporter_id=EXCLUDED.transporter_id,
               status='GENERATED', provider=EXCLUDED.provider, cancel_reason=NULL, updated_at=now()
             RETURNING *`,
            [input.invoiceId, res.ewbNo, res.ewbDate, validUntil, input.distanceKm, mode, vehicleNo, transporterId, res.provider],
          );
          await client.query('UPDATE invoices SET eway_bill_no = $2 WHERE id = $1', [input.invoiceId, res.ewbNo]);
          return rows[0];
        });
        await logActivity(actor.sub, 'GENERATE_EWAYBILL', 'invoice', input.invoiceId, { provider: res.provider });
        return mapEwb(row);
      },

      updateEWayBillVehicle: async (_p, { invoiceId, vehicleNo, reason }, ctx) => {
        const actor = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN', 'SALES');
        const v = normVehicle(vehicleNo);
        if (!VEHICLE_RE.test(v)) throw httpError(`"${vehicleNo}" is not a valid vehicle number (e.g. MH12AB1234)`, 400);
        reason = String(reason || '').trim();
        if (!reason) throw httpError('Enter the reason for changing the vehicle', 400);
        const cur = (await query("SELECT * FROM eway_bills WHERE invoice_id=$1 AND status='GENERATED'", [invoiceId])).rows[0];
        if (!cur) throw httpError('No active E-Way Bill for this invoice', 404);
        if (cur.valid_until && new Date(cur.valid_until) < new Date()) throw httpError('This E-Way Bill has expired — extend it on the EWB portal first', 400);
        await gstProvider.updatePartB({ ewbNo: cur.ewb_no, vehicleNo: v, transportMode: 'ROAD', reason });
        const { rows } = await query(
          "UPDATE eway_bills SET vehicle_no=$2, transport_mode='ROAD', updated_at=now() WHERE id=$1 RETURNING *",
          [cur.id, v],
        );
        await logActivity(actor.sub, 'UPDATE_EWAYBILL_VEHICLE', 'invoice', invoiceId, { from: cur.vehicle_no, to: v, reason });
        return mapEwb(rows[0]);
      },

      cancelEWayBill: async (_p, { invoiceId, reason }, ctx) => {
        const actor = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN');
        reason = String(reason || '').trim();
        if (!reason) throw httpError('Enter a reason for cancelling the E-Way Bill', 400);
        const cur = (await query("SELECT ewb_date, created_at FROM eway_bills WHERE invoice_id=$1 AND status='GENERATED'", [invoiceId])).rows[0];
        if (!cur) throw httpError('No active E-Way Bill to cancel', 404);
        assertWithin24h(cur.ewb_date || cur.created_at, 'An E-Way Bill', 'let it lapse or reject it on the EWB portal');
        await gstProvider.cancelEWB({ invoiceId, reason });
        const { rows } = await query(
          "UPDATE eway_bills SET status='CANCELLED', cancel_reason=$2, updated_at=now() WHERE invoice_id=$1 RETURNING *",
          [invoiceId, reason],
        );
        if (!rows[0]) throw httpError('No E-Way Bill to cancel', 404);
        await query('UPDATE invoices SET eway_bill_no = NULL WHERE id = $1', [invoiceId]);
        await logActivity(actor.sub, 'CANCEL_EWAYBILL', 'invoice', invoiceId, { reason });
        return mapEwb(rows[0]);
      },
    },

    Invoice: {
      eInvoice: async (parent) => {
        const { rows } = await query('SELECT * FROM e_invoices WHERE invoice_id = $1', [parent.id]);
        return mapEInvoice(rows[0]);
      },
      ewayBill: async (parent) => {
        const { rows } = await query('SELECT * FROM eway_bills WHERE invoice_id = $1', [parent.id]);
        return mapEwb(rows[0]);
      },
    },
  };
}
