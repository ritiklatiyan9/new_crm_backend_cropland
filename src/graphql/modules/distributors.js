// GraphQL module: Distributor / Dealer Master (PRD §7.2, §8).
// Buyer master for Order-to-Cash; GSTIN/state feed the GST + E-Way Bill engine.

import { query } from '../../db/index.js';
import { assertAuth, assertRole } from '../context.js';
import { httpError, logActivity, num } from '../helpers.js';
import { validateGstin } from '../../services/gst/stateCodes.js';

export const distributorTypeDefs = /* GraphQL */ `
  type Distributor {
    id: ID!
    name: String!
    contactPerson: String
    phone: String
    email: String
    gstin: String
    dealerTier: String
    state: String
    district: String
    address: String
    country: String
    pincode: String
    pan: String
    registrationType: String
    branchId: ID
    branch: Branch
    creditLimit: Float!
    outstanding: Float!
    creditAvailable: Float!
    gpsLat: Float
    gpsLng: Float
    udyamNo: String
    msmeType: String
    msmeRegistered: Boolean!
    msmeRegDate: String
    isActive: Boolean!
    createdAt: DateTime!
  }

  type DistributorStats {
    total: Int!
    active: Int!
    totalOutstanding: Float!
  }

  input DistributorInput {
    name: String!
    contactPerson: String
    phone: String
    email: String
    gstin: String
    dealerTier: String
    state: String
    district: String
    address: String
    country: String
    pincode: String
    pan: String
    registrationType: String
    branchId: ID
    creditLimit: Float = 0
    gpsLat: Float
    gpsLng: Float
    udyamNo: String
    msmeType: String
    msmeRegistered: Boolean
    msmeRegDate: String
  }

  extend type Query {
    distributors(search: String, activeOnly: Boolean, limit: Int = 100, offset: Int = 0): [Distributor!]!
    distributor(id: ID!): Distributor
    distributorStats: DistributorStats!
  }

  extend type Mutation {
    createDistributor(input: DistributorInput!): Distributor!
    updateDistributor(id: ID!, input: DistributorInput!): Distributor!
    setDistributorActive(id: ID!, isActive: Boolean!): Distributor!
    deleteDistributor(id: ID!): Boolean!
  }
`;

export const mapDistributor = (r) =>
  r && {
    id: r.id,
    name: r.name,
    contactPerson: r.contact_person,
    phone: r.phone,
    email: r.email,
    gstin: r.gstin,
    dealerTier: r.dealer_tier,
    state: r.state,
    district: r.district,
    address: r.address,
    country: r.country,
    pincode: r.pincode,
    pan: r.pan,
    registrationType: r.registration_type,
    branchId: r.branch_id,
    creditLimit: num(r.credit_limit) ?? 0,
    outstanding: num(r.outstanding) ?? 0,
    creditAvailable: (num(r.credit_limit) ?? 0) - (num(r.outstanding) ?? 0),
    gpsLat: num(r.gps_lat),
    gpsLng: num(r.gps_lng),
    udyamNo: r.udyam_no,
    msmeType: r.msme_type,
    msmeRegistered: r.msme_registered ?? false,
    msmeRegDate: r.msme_reg_date ? String(r.msme_reg_date).slice(0, 10) : null,
    isActive: r.is_active,
    createdAt: r.created_at,
  };

const TIERS = ['SILVER', 'GOLD', 'PLATINUM'];
const MSME_TYPES = ['MICRO', 'SMALL', 'MEDIUM', 'NA'];

// Trim text, turn "" into null, and reject values the GST/e-way engines can't use.
function normalizeDistributorInput(input) {
  const i = Object.fromEntries(Object.entries(input).map(([k, v]) => [k, typeof v === 'string' ? v.trim() || null : v]));
  if (!i.name) throw httpError('Firm name is required', 400);
  if (i.gstin) {
    i.gstin = i.gstin.toUpperCase();
    const g = validateGstin(i.gstin);
    if (!g.valid) throw httpError(`GSTIN: ${g.reason}`, 400);
    if (i.state && g.stateName && i.state.toLowerCase() !== g.stateName.toLowerCase()) {
      throw httpError('State must match GSTIN', 400);
    }
    i.state ??= g.stateName; // place of supply follows the GSTIN
  }
  if (i.pincode && !/^\d{6}$/.test(i.pincode)) throw httpError('Pincode must be 6 digits', 400);
  if (i.pan) {
    i.pan = i.pan.toUpperCase();
    if (!/^[A-Z]{5}\d{4}[A-Z]$/.test(i.pan)) throw httpError('PAN must be 10 characters in the correct format', 400);
  }
  if (i.pan && i.gstin && i.gstin.slice(2, 12) !== i.pan) throw httpError('PAN does not match GSTIN', 400);
  if (i.country && i.country.toLowerCase() !== 'india') throw httpError('Country must be India for GST billing', 400);
  i.country = 'India';
  if (i.registrationType && !['Regular', 'Composition', 'Unregistered', 'SEZ', 'UIN'].includes(i.registrationType)) throw httpError('Invalid GST registration type', 400);
  if (i.phone) {
    const digits = i.phone.replace(/\D/g, '').replace(/^(91|0)(?=\d{10}$)/, '');
    if (digits.length !== 10) throw httpError('Phone must be a 10-digit number', 400);
    i.phone = digits;
  }
  if (i.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(i.email)) throw httpError('Email address is not valid', 400);
  if (i.email) i.email = i.email.toLowerCase();
  if (i.dealerTier && !TIERS.includes(i.dealerTier)) throw httpError(`Dealer tier must be one of ${TIERS.join(', ')}`, 400);
  if (i.msmeType && !MSME_TYPES.includes(i.msmeType)) throw httpError(`MSME type must be one of ${MSME_TYPES.join(', ')}`, 400);
  if (i.msmeRegDate && Number.isNaN(Date.parse(i.msmeRegDate))) throw httpError('MSME registration date is not a valid date', 400);
  if (i.creditLimit != null && (!Number.isFinite(i.creditLimit) || i.creditLimit < 0)) throw httpError('Credit limit cannot be negative', 400);
  return i;
}

const vals = (i) => [
  i.name,
  i.contactPerson ?? null,
  i.phone ?? null,
  i.email ?? null,
  i.gstin ?? null,
  i.dealerTier ?? null,
  i.state ?? null,
  i.district ?? null,
  i.address ?? null,
  i.branchId ?? null,
  i.creditLimit ?? 0,
  i.gpsLat ?? null,
  i.gpsLng ?? null,
  i.udyamNo ?? null,
  i.msmeType ?? null,
  i.msmeRegistered ?? false,
  i.msmeRegDate ?? null,
  i.country ?? 'India',
  i.pincode ?? null,
  i.pan ?? null,
  i.registrationType ?? 'Regular',
];

export function distributorResolvers() {
  return {
    Query: {
      distributors: async (_p, { search, activeOnly, limit, offset }, ctx) => {
        assertAuth(ctx);
        const { rows } = await query(
          `SELECT * FROM distributors
           WHERE ($1::text IS NULL OR name ILIKE '%' || $1 || '%' OR gstin ILIKE '%' || $1 || '%' OR phone ILIKE '%' || $1 || '%')
             AND ($2::bool IS NULL OR is_active = $2)
           ORDER BY created_at DESC LIMIT $3 OFFSET $4`,
          [search?.trim() || null, activeOnly ?? null, Math.min(Math.max(limit ?? 100, 1), 1000), Math.max(offset ?? 0, 0)],
        );
        return rows.map(mapDistributor);
      },
      distributor: async (_p, { id }, ctx) => {
        assertAuth(ctx);
        const { rows } = await query('SELECT * FROM distributors WHERE id = $1', [id]);
        return mapDistributor(rows[0]);
      },
      distributorStats: async (_p, _a, ctx) => {
        assertAuth(ctx);
        const { rows } = await query(
          `SELECT COUNT(*)::int AS total,
                  COUNT(*) FILTER (WHERE is_active)::int AS active,
                  COALESCE(SUM(outstanding),0) AS total_outstanding
           FROM distributors`,
        );
        return {
          total: rows[0].total,
          active: rows[0].active,
          totalOutstanding: num(rows[0].total_outstanding) ?? 0,
        };
      },
    },
    Mutation: {
      createDistributor: async (_p, { input }, ctx) => {
        const actor = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN', 'SALES');
        const { rows } = await query(
          `INSERT INTO distributors
             (name, contact_person, phone, email, gstin, dealer_tier, state, district, address, branch_id, credit_limit, gps_lat, gps_lng, udyam_no, msme_type, msme_registered, msme_reg_date, country, pincode, pan, registration_type)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21) RETURNING *`,
          vals(normalizeDistributorInput(input)),
        );
        await logActivity(actor.sub, 'CREATE_DISTRIBUTOR', 'distributor', rows[0].id);
        return mapDistributor(rows[0]);
      },
      updateDistributor: async (_p, { id, input }, ctx) => {
        const actor = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN', 'SALES');
        const { rows } = await query(
          `UPDATE distributors SET
             name=$2, contact_person=$3, phone=$4, email=$5, gstin=$6, dealer_tier=$7,
             state=$8, district=$9, address=$10, branch_id=$11, credit_limit=$12, gps_lat=$13, gps_lng=$14,
             udyam_no=$15, msme_type=$16, msme_registered=$17, msme_reg_date=$18,
             country=$19, pincode=$20, pan=$21, registration_type=$22, updated_at=now()
           WHERE id=$1 RETURNING *`,
          [id, ...vals(normalizeDistributorInput(input))],
        );
        if (!rows[0]) throw httpError('Distributor not found', 404);
        await logActivity(actor.sub, 'UPDATE_DISTRIBUTOR', 'distributor', id);
        return mapDistributor(rows[0]);
      },
      setDistributorActive: async (_p, { id, isActive }, ctx) => {
        const actor = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN');
        const { rows } = await query(
          'UPDATE distributors SET is_active = $2, updated_at = now() WHERE id = $1 RETURNING *',
          [id, isActive],
        );
        if (!rows[0]) throw httpError('Distributor not found', 404);
        await logActivity(actor.sub, 'TOGGLE_DISTRIBUTOR', 'distributor', id);
        return mapDistributor(rows[0]);
      },
      deleteDistributor: async (_p, { id }, ctx) => {
        const actor = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN');
        const { rowCount } = await query('DELETE FROM distributors WHERE id = $1', [id]);
        if (!rowCount) throw httpError('Distributor not found', 404);
        await logActivity(actor.sub, 'DELETE_DISTRIBUTOR', 'distributor', id);
        return true;
      },
    },
    Distributor: {
      branch: async (parent) => {
        if (!parent.branchId) return null;
        const { rows } = await query('SELECT * FROM branches WHERE id = $1', [parent.branchId]);
        const { mapBranch } = await import('./users.js');
        return mapBranch(rows[0]);
      },
    },
  };
}
