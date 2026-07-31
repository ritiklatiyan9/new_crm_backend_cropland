// GraphQL module: Purchase Enquiries (buy-intent).
// Farmer taps "Buy" on a product → we find the nearest distributor (by GPS) and
// log an enquiry that surfaces to the admin queue and (optionally) the distributor.
// Admin can disable distributor suggestion (company_settings.distributor_suggestion).

import { query } from '../../db/index.js';
import { assertAuth, assertRole } from '../context.js';
import { httpError, logActivity, num } from '../helpers.js';

export const enquiryTypeDefs = /* GraphQL */ `
  type DistributorLite {
    id: ID!
    name: String!
    phone: String
    address: String
    district: String
    state: String
    gpsLat: Float
    gpsLng: Float
    distanceKm: Float
  }
  type CompanyLocation { name: String!, address: String, phone: String, gpsLat: Float, gpsLng: Float }

  type PurchaseEnquiry {
    id: ID!
    enquiryNo: String!
    productId: ID
    productName: String!
    status: String!
    note: String
    distanceKm: Float
    farmerName: String
    farmerPhone: String
    farmerVillage: String
    distributor: DistributorLite
    createdAt: DateTime!
  }
  type EnquiryStats { total: Int!, newCount: Int!, contacted: Int!, suggestionEnabled: Boolean! }
  type EnquiryResult { enquiry: PurchaseEnquiry!, suggestionEnabled: Boolean!, distributor: DistributorLite }

  extend type Query {
    # Farmer (app)
    nearestDistributors(lat: Float, lng: Float, limit: Int = 5): [DistributorLite!]!
    companyLocation: CompanyLocation!
    myEnquiries: [PurchaseEnquiry!]!
    # Admin
    purchaseEnquiries(status: String, limit: Int = 200): [PurchaseEnquiry!]!
    enquiryStats: EnquiryStats!
  }

  extend type Mutation {
    createPurchaseEnquiry(productId: ID!, lat: Float, lng: Float, note: String): EnquiryResult!
    updateEnquiryStatus(id: ID!, status: String!, note: String): PurchaseEnquiry!
    setEnquiryDistributor(id: ID!, distributorId: ID): PurchaseEnquiry!
    deleteEnquiry(id: ID!): Boolean!
  }
`;

function farmerId(ctx) {
  const u = assertAuth(ctx);
  if (u.kind !== 'FARMER') throw httpError('Farmer authentication required', 403);
  return u.sub;
}

const mapLite = (r) => r && {
  id: r.id, name: r.name, phone: r.phone, address: r.address, district: r.district, state: r.state,
  gpsLat: num(r.gps_lat), gpsLng: num(r.gps_lng), distanceKm: r.dist != null ? Math.round(num(r.dist) * 10) / 10 : (r.distance_km != null ? num(r.distance_km) : null),
};

// Nearest active distributors to a point (haversine), GPS required.
async function nearestByGps(lat, lng, limit) {
  const { rows } = await query(
    `SELECT *, (6371 * acos(LEAST(1, cos(radians($1)) * cos(radians(gps_lat)) * cos(radians(gps_lng) - radians($2))
              + sin(radians($1)) * sin(radians(gps_lat))))) AS dist
     FROM distributors
     WHERE is_active AND gps_lat IS NOT NULL AND gps_lng IS NOT NULL
     ORDER BY dist ASC LIMIT $3`,
    [lat, lng, limit],
  );
  return rows;
}

// Fallback when no GPS: match by district, then state, then any active.
async function nearestByRegion(district, state) {
  for (const [col, val] of [['district', district], ['state', state]]) {
    if (!val) continue;
    const { rows } = await query(`SELECT * FROM distributors WHERE is_active AND ${col} ILIKE $1 ORDER BY created_at LIMIT 1`, [val]);
    if (rows[0]) return rows[0];
  }
  const { rows } = await query('SELECT * FROM distributors WHERE is_active ORDER BY created_at LIMIT 1');
  return rows[0] ?? null;
}

const ENQ_SELECT = `SELECT e.*, f.name farmer_name, f.phone farmer_phone, f.village farmer_village,
    d.name d_name, d.phone d_phone, d.address d_address, d.district d_district, d.state d_state, d.gps_lat d_lat, d.gps_lng d_lng
  FROM purchase_enquiries e
  LEFT JOIN farmers f ON f.id = e.farmer_id
  LEFT JOIN distributors d ON d.id = e.distributor_id`;

const mapEnquiry = (r) => r && {
  id: r.id, enquiryNo: r.enquiry_no, productId: r.product_id, productName: r.product_name,
  status: r.status, note: r.note, distanceKm: num(r.distance_km),
  farmerName: r.farmer_name, farmerPhone: r.farmer_phone, farmerVillage: r.farmer_village,
  distributor: r.distributor_id ? { id: r.distributor_id, name: r.d_name, phone: r.d_phone, address: r.d_address, district: r.d_district, state: r.d_state, gpsLat: num(r.d_lat), gpsLng: num(r.d_lng), distanceKm: num(r.distance_km) } : null,
  createdAt: r.created_at,
};

export function enquiryResolvers() {
  return {
    Query: {
      nearestDistributors: async (_p, { lat, lng, limit }, ctx) => {
        const id = farmerId(ctx);
        let la = lat, ln = lng;
        if (la == null || ln == null) {
          const f = (await query('SELECT gps_lat, gps_lng, district, state FROM farmers WHERE id=$1', [id])).rows[0];
          la = num(f?.gps_lat); ln = num(f?.gps_lng);
          if (la == null || ln == null) {
            const d = await nearestByRegion(f?.district, f?.state);
            return d ? [mapLite(d)] : [];
          }
        }
        return (await nearestByGps(la, ln, limit)).map(mapLite);
      },
      companyLocation: async (_p, _a, ctx) => {
        assertAuth(ctx);
        const c = (await query('SELECT * FROM company_settings WHERE id=1')).rows[0];
        const addr = [c?.address_line1, c?.address_line2, c?.city, c?.state, c?.pincode].filter(Boolean).join(', ');
        return { name: c?.trade_name || c?.legal_name || 'Cropland Agritech India', address: addr || null, phone: c?.phone, gpsLat: num(c?.gps_lat), gpsLng: num(c?.gps_lng) };
      },
      myEnquiries: async (_p, _a, ctx) => {
        const id = farmerId(ctx);
        const { rows } = await query(`${ENQ_SELECT} WHERE e.farmer_id=$1 ORDER BY e.created_at DESC`, [id]);
        return rows.map(mapEnquiry);
      },
      purchaseEnquiries: async (_p, { status, limit }, ctx) => {
        assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN', 'SALES');
        const { rows } = await query(`${ENQ_SELECT} WHERE ($1::text IS NULL OR e.status=$1) ORDER BY e.created_at DESC LIMIT $2`, [status ?? null, limit]);
        return rows.map(mapEnquiry);
      },
      enquiryStats: async (_p, _a, ctx) => {
        assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN', 'SALES');
        const { rows } = await query(
          `SELECT (SELECT COUNT(*) FROM purchase_enquiries)::int total,
                  (SELECT COUNT(*) FROM purchase_enquiries WHERE status='NEW')::int new_count,
                  (SELECT COUNT(*) FROM purchase_enquiries WHERE status='CONTACTED')::int contacted,
                  (SELECT distributor_suggestion FROM company_settings WHERE id=1) suggestion`,
        );
        return { total: rows[0].total, newCount: rows[0].new_count, contacted: rows[0].contacted, suggestionEnabled: rows[0].suggestion ?? true };
      },
    },

    Mutation: {
      createPurchaseEnquiry: async (_p, { productId, lat, lng, note }, ctx) => {
        const id = farmerId(ctx);
        const farmer = (await query('SELECT gps_lat, gps_lng, district, state FROM farmers WHERE id=$1', [id])).rows[0];
        const product = (await query('SELECT name FROM products WHERE id=$1', [productId])).rows[0];
        if (!product) throw httpError('Product not found', 404);

        // Capture the farmer's live location if the app sent it.
        let la = lat, ln = lng;
        if (la != null && ln != null) {
          await query('UPDATE farmers SET gps_lat=$2, gps_lng=$3 WHERE id=$1', [id, la, ln]);
        } else {
          la = num(farmer?.gps_lat); ln = num(farmer?.gps_lng);
        }

        const suggestionEnabled = ((await query('SELECT distributor_suggestion s FROM company_settings WHERE id=1')).rows[0]?.s) ?? true;
        let distributor = null;
        let distanceKm = null;
        if (suggestionEnabled) {
          if (la != null && ln != null) {
            const near = await nearestByGps(la, ln, 1);
            if (near[0]) { distributor = near[0]; distanceKm = Math.round(num(near[0].dist) * 10) / 10; }
          }
          distributor ??= await nearestByRegion(farmer?.district, farmer?.state);
        }

        const enquiryNo = `ENQ-${String((await query("SELECT nextval('enquiry_seq') n")).rows[0].n).padStart(5, '0')}`;
        const { rows } = await query(
          `INSERT INTO purchase_enquiries (enquiry_no, farmer_id, product_id, product_name, distributor_id, distance_km, note)
           VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
          [enquiryNo, id, productId, product.name, distributor?.id ?? null, distanceKm, note ?? null],
        );
        await logActivity(null, 'PURCHASE_ENQUIRY', 'purchase_enquiry', rows[0].id, { product: product.name, via: 'farmer-app' });
        const full = mapEnquiry((await query(`${ENQ_SELECT} WHERE e.id=$1`, [rows[0].id])).rows[0]);
        return { enquiry: full, suggestionEnabled, distributor: full.distributor };
      },

      updateEnquiryStatus: async (_p, { id, status, note }, ctx) => {
        const a = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN', 'SALES');
        if (!['NEW', 'CONTACTED', 'CONVERTED', 'CLOSED'].includes(status)) throw httpError('Invalid status', 400);
        const { rows } = await query('UPDATE purchase_enquiries SET status=$2, note=COALESCE($3,note), updated_at=now() WHERE id=$1 RETURNING id', [id, status, note ?? null]);
        if (!rows[0]) throw httpError('Enquiry not found', 404);
        await logActivity(a.sub, 'UPDATE_ENQUIRY', 'purchase_enquiry', id, { status });
        return mapEnquiry((await query(`${ENQ_SELECT} WHERE e.id=$1`, [id])).rows[0]);
      },

      // Manually assign a distributor (or pass null to remove / turn off the suggestion for this enquiry).
      setEnquiryDistributor: async (_p, { id, distributorId }, ctx) => {
        const a = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN', 'SALES');
        let distanceKm = null;
        if (distributorId) {
          if (!(await query('SELECT id FROM distributors WHERE id=$1', [distributorId])).rows[0]) throw httpError('Distributor not found', 404);
          // Recompute distance if both the enquiry's farmer and the distributor have GPS.
          const d = (await query(
            `SELECT (6371 * acos(LEAST(1, cos(radians(f.gps_lat))*cos(radians(d.gps_lat))*cos(radians(d.gps_lng)-radians(f.gps_lng))+sin(radians(f.gps_lat))*sin(radians(d.gps_lat))))) km
             FROM purchase_enquiries e JOIN farmers f ON f.id=e.farmer_id JOIN distributors d ON d.id=$2
             WHERE e.id=$1 AND f.gps_lat IS NOT NULL AND d.gps_lat IS NOT NULL`,
            [id, distributorId],
          )).rows[0];
          if (d?.km != null) distanceKm = Math.round(num(d.km) * 10) / 10;
        }
        const { rows } = await query('UPDATE purchase_enquiries SET distributor_id=$2, distance_km=$3, updated_at=now() WHERE id=$1 RETURNING id', [id, distributorId ?? null, distanceKm]);
        if (!rows[0]) throw httpError('Enquiry not found', 404);
        await logActivity(a.sub, 'ASSIGN_ENQUIRY_DISTRIBUTOR', 'purchase_enquiry', id, { distributorId });
        return mapEnquiry((await query(`${ENQ_SELECT} WHERE e.id=$1`, [id])).rows[0]);
      },

      deleteEnquiry: async (_p, { id }, ctx) => {
        const a = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN');
        const { rowCount } = await query('DELETE FROM purchase_enquiries WHERE id=$1', [id]);
        if (!rowCount) throw httpError('Enquiry not found', 404);
        await logActivity(a.sub, 'DELETE_ENQUIRY', 'purchase_enquiry', id);
        return true;
      },
    },
  };
}
