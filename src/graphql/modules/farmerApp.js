import { readPurchases } from '../../services/farmer/purchases.js';
// GraphQL module: Farmer App backend (PRD §9).
// Farmer authentication (email/password + Google) and farmer-scoped data —
// the same `farmers` table used by the admin panel, so admin-created farmers and
// app self-signups are one and the same record.

import bcrypt from 'bcryptjs';
import { createCatalog } from '../../services/farmer/catalog.js';
import { cropPhotoInput } from '../../services/farmer/cropPhoto.js';
import { query } from '../../db/index.js';
import { assertAuth } from '../context.js';
import { httpError, logActivity, num, isoDate } from '../helpers.js';
import { getWeather, weatherConfigured } from '../../services/weather/index.js';
import { diagnoseCrop } from '../../services/ai/index.js';
import { getTrainingReferences } from './ai.js';
import { isAwsConfigured, getDownloadUrl } from '../../utils/aws.js';
import { env } from '../../config/env.js';
import { sendEmail } from '../../services/notify/email.js';

// Resolve a stored S3 key (or pass-through URL) to a viewable URL.
async function imgUrl(value) {
  if (!value) return null;
  if (/^https?:\/\//.test(value) || value.startsWith('data:')) return value;
  if (env.aws.s3PublicBaseUrl) return `${env.aws.s3PublicBaseUrl.replace(/\/$/, '')}/${value}`;
  if (isAwsConfigured) { try { return await getDownloadUrl(value, 3600); } catch { return null; } }
  return null;
}

export const farmerAppTypeDefs = /* GraphQL */ `
  type FarmerProfile {
    id: ID!
    farmerCode: String!
    name: String!
    phone: String
    email: String
    village: String
    tehsil: String
    district: String
    state: String
    crops: [String!]!
    landSizeAcres: Float
    language: String
    pointsBalance: Int!
    photoUrl: String
    authProvider: String!
    deletionStatus: String
  }
  type FarmerAuthPayload { token: String!, farmer: FarmerProfile! }

  type AppLoyaltyTxn { id: ID!, points: Int!, type: String!, note: String, createdAt: DateTime! }
  type AppAdvisory { id: ID!, advisoryNo: String!, crop: String!, disease: String, type: String!, title: String!, body: String!, status: String!, products: [String!]!, createdAt: DateTime! }
  type AppComplaintEvent { type: String!, detail: String, at: DateTime! }
  type AppComplaint { id: ID!, ticketNo: String!, category: String!, description: String!, status: String!, priority: String, resolutionNote: String, createdAt: DateTime!, events: [AppComplaintEvent!]! }
  type AccountSummary { totalPurchased: Float!, totalPaid: Float!, balance: Float! }
  type AppOrder { id: ID!, orderNo: String!, billType: String!, status: String!, orderDate: String!, totalAmount: Float!, itemCount: Int! }
  type AppPurchaseLine { productName: String!, quantity: Float!, unitPrice: Float!, lineTotal: Float!, uom: String, packingSize: String }
  type AppPurchase {
    id: ID!
    refNo: String!
    kind: String!          # ORDER / DIRECT
    date: String!
    status: String
    totalAmount: Float!
    amountPaid: Float!
    balanceDue: Float!
    items: [AppPurchaseLine!]!
  }
  type AppProduct { id: ID!, name: String!, category: String, technicalName: String, uom: String, packingSize: String, mrp: Float, imageUrl: String, recommendedDosage: String, applicationFrequency: String, targetCrops: [String!]!, targetDiseases: [String!]! }
  type AppDiagnosisProduct { id: ID!, name: String! }
  type AppNotification { id: ID!, title: String!, body: String!, campaignType: String, createdAt: DateTime! }
  type AppDiagnosis { id: ID!, sessionNo: String!, crop: String!, detectedDisease: String, pathogen: String, confidence: Float, severity: String, symptoms: String, recommendation: String, source: String, products: [String!]!, recommendedProducts: [AppDiagnosisProduct!]!, imageUrl: String, createdAt: DateTime! }

  input FarmerSignupInput { name: String!, email: String!, password: String!, phone: String, village: String, district: String, state: String, language: String }
  input FarmerProfileInput { name: String, phone: String, village: String, tehsil: String, district: String, state: String, crops: [String!], landSizeAcres: Float, language: String }
  input AppComplaintInput { category: String!, description: String! }

  extend type Query {
    meFarmer: FarmerProfile
    myLoyaltyTransactions(limit: Int = 50): [AppLoyaltyTxn!]!
    myAdvisories: [AppAdvisory!]!
    myComplaints: [AppComplaint!]!
    myOrders: [AppOrder!]!
    myPurchases: [AppPurchase!]!
    myDiagnoses: [AppDiagnosis!]!
    myNotifications(limit: Int = 50): [AppNotification!]!
    appProducts(search: String, category: String, limit: Int = 100, offset: Int = 0): [AppProduct!]!
    appWeather(lat: Float, lng: Float, language: String): Weather!
    myAccountSummary: AccountSummary!
  }

  extend type Mutation {
    farmerSignup(input: FarmerSignupInput!): FarmerAuthPayload!
    farmerLogin(email: String!, password: String!): FarmerAuthPayload!
    farmerGoogleAuth(idToken: String!): FarmerAuthPayload!
    updateMyProfile(input: FarmerProfileInput!): FarmerProfile!
    changeMyPassword(oldPassword: String!, newPassword: String!): Boolean!
    registerMyDevice(fcmToken: String!): Boolean!
    setMyProfilePhoto(imageUrl: String!): FarmerProfile!
    raiseComplaint(input: AppComplaintInput!): AppComplaint!
    runMyDiagnosis(crop: String!, imageUrl: String, language: String): AppDiagnosis!
    markAdvisoryRead(id: ID!): Boolean!
    requestMyAccountDeletion(reason: String): Boolean!
  }
`;

const genCode = () => `FRM${Math.floor(100000 + Math.random() * 900000)}`;

const mapFarmer = (r) => r && {
  id: r.id, farmerCode: r.farmer_code, name: r.name, phone: r.phone, email: r.email,
  village: r.village, tehsil: r.tehsil, district: r.district, state: r.state,
  crops: r.crops ?? [], landSizeAcres: num(r.land_size_acres), language: r.language,
  pointsBalance: r.points_balance ?? 0, photoKey: r.photo_url, authProvider: r.auth_provider ?? 'ADMIN',
  deletionStatus: r.deletion_status ?? null,
};

// Resolve the authenticated farmer's id from a FARMER-kind JWT.
function farmerId(ctx) {
  const u = assertAuth(ctx);
  if (u.kind !== 'FARMER') throw httpError('Farmer authentication required', 403);
  return u.sub;
}

async function productNames(ids) {
  if (!ids?.length) return [];
  const { rows } = await query('SELECT name FROM products WHERE id = ANY($1)', [ids]);
  return rows.map((r) => r.name);
}

async function productRefs(ids) {
  if (!ids?.length) return [];
  const { rows } = await query('SELECT id, name FROM products WHERE id = ANY($1)', [ids]);
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.map((id) => byId.get(id)).filter(Boolean);
}

// One lookup for every row's product_ids (avoids a products query per advisory/diagnosis).
async function productNamesFor(rows) {
  const ids = [...new Set(rows.flatMap((r) => r.product_ids ?? []))];
  const byId = new Map(ids.length ? (await query('SELECT id, name FROM products WHERE id = ANY($1)', [ids])).rows.map((p) => [p.id, p.name]) : []);
  return (r) => (r.product_ids ?? []).map((pid) => byId.get(pid)).filter(Boolean);
}

// Best-effort product match for an app diagnosis: trained class → catalog targets → recent.
async function matchProductsForApp(crop, disease) {
  const trained = (await query(
    `SELECT product_ids FROM ai_training_classes WHERE is_active AND crop ILIKE $1 AND disease ILIKE '%'||$2||'%' LIMIT 1`,
    [crop, disease ?? ''],
  )).rows[0];
  if (trained?.product_ids?.length) return trained.product_ids;
  const tgt = (await query(
    `SELECT id FROM products WHERE is_active AND (
       EXISTS (SELECT 1 FROM unnest(target_crops) tc WHERE tc ILIKE $1)
       OR EXISTS (SELECT 1 FROM unnest(target_diseases) td WHERE $2 ILIKE '%'||td||'%' OR td ILIKE '%'||$2||'%')
     ) LIMIT 3`,
    [crop, disease ?? ''],
  )).rows;
  if (tgt.length) return tgt.map((r) => r.id);
  return (await query('SELECT id FROM products WHERE is_active ORDER BY created_at DESC LIMIT 3')).rows.map((r) => r.id);
}

export function farmerAppResolvers(app) {
  const catalog = createCatalog(query);
  // Mobile apps need long-lived tokens; 30-day expiry replaces the default 15-min access window.
  const sign = (farmer) => app.jwt.sign({ sub: farmer.id, kind: 'FARMER', role: 'FARMER' }, { expiresIn: '30d' });
  const authPayload = (farmer) => ({ token: sign(farmer), farmer: mapFarmer(farmer) });

  return {
    Query: {
      meFarmer: async (_p, _a, ctx) => {
        const id = farmerId(ctx);
        const { rows } = await query('SELECT * FROM farmers WHERE id = $1', [id]);
        return mapFarmer(rows[0]);
      },
      myLoyaltyTransactions: async (_p, { limit }, ctx) => {
        const id = farmerId(ctx);
        const { rows } = await query('SELECT * FROM loyalty_transactions WHERE farmer_id = $1 ORDER BY created_at DESC LIMIT $2', [id, limit]);
        return rows.map((r) => ({ id: r.id, points: r.points, type: r.type, note: r.note, createdAt: r.created_at }));
      },
      myAdvisories: async (_p, _a, ctx) => {
        const id = farmerId(ctx);
        // Farmer-specific advisories + broadcast advisories (no specific farmer).
        const { rows } = await query("SELECT * FROM advisories WHERE (farmer_id = $1 OR farmer_id IS NULL) AND status IN ('SENT','READ') ORDER BY created_at DESC", [id]);
        const names = await productNamesFor(rows);
        return rows.map((r) => ({
          id: r.id, advisoryNo: r.advisory_no, crop: r.crop, disease: r.disease, type: r.type, title: r.title,
          body: r.body, status: r.status, products: names(r), createdAt: r.created_at,
        }));
      },
      myComplaints: async (_p, _a, ctx) => {
        const id = farmerId(ctx);
        const { rows } = await query('SELECT * FROM complaints WHERE farmer_id = $1 ORDER BY created_at DESC', [id]);
        return rows.map((r) => ({ id: r.id, ticketNo: r.ticket_no, category: r.category, description: r.description, status: r.status, priority: r.priority, resolutionNote: r.resolution_note, createdAt: r.created_at }));
      },
      myAccountSummary: async (_p, _a, ctx) => {
        const id = farmerId(ctx);
        const { rows } = await query(
          `SELECT COALESCE(SUM(total_amount),0) total_purchased, COALESCE(SUM(amount_paid),0) total_paid
           FROM (SELECT total_amount, amount_paid FROM invoices WHERE farmer_id=$1
                 UNION ALL SELECT total_amount, amount_paid FROM party_sales WHERE farmer_id=$1) purchases`,
          [id],
        );
        const tp = num(rows[0].total_purchased) ?? 0, paid = num(rows[0].total_paid) ?? 0;
        return { totalPurchased: tp, totalPaid: paid, balance: Math.round((tp - paid) * 100) / 100 };
      },
      myOrders: async (_p, _a, ctx) => {
        const id = farmerId(ctx);
        const { rows } = await query(
          `SELECT o.id, o.order_no, o.bill_type, o.status, o.order_date, o.total_amount,
                  (SELECT COUNT(*)::int FROM order_lines ol WHERE ol.order_id = o.id) item_count
           FROM orders o WHERE o.farmer_id = $1 ORDER BY o.created_at DESC`,
          [id],
        );
        return rows.map((r) => ({ id: r.id, orderNo: r.order_no, billType: r.bill_type ?? 'GST', status: r.status, orderDate: isoDate(r.order_date), totalAmount: num(r.total_amount), itemCount: r.item_count }));
      },
      // Unified purchase history: GST/Non-GST orders + direct sales, each with its
      // product line items and payment status. Powers the Purchases screen and the
      // per-product transaction sheet in the farmer app.
      myPurchases: async (_p, _a, ctx) => readPurchases(query, farmerId(ctx)),
      myDiagnoses: async (_p, _a, ctx) => {
        const id = farmerId(ctx);
        const { rows } = await query('SELECT * FROM crop_diagnoses WHERE farmer_id = $1 ORDER BY created_at DESC LIMIT 50', [id]);
        const names = await productNamesFor(rows);
        return rows.map((r) => ({
          id: r.id, sessionNo: r.session_no, crop: r.crop, detectedDisease: r.detected_disease, pathogen: r.pathogen,
          confidence: num(r.confidence), severity: r.severity, symptoms: r.symptoms, recommendation: r.recommendation,
          source: r.source, products: names(r), productIds: r.product_ids ?? [], imageUrl: r.image_url, createdAt: r.created_at,
        }));
      },
      myNotifications: async (_p, { limit }, ctx) => {
        const id = farmerId(ctx);
        // Unified feed: admin notifications + the farmer's advisories (so the bell
        // shows advisories too), newest first.
        const { rows } = await query(
          `SELECT id, title, body, campaign_type, created_at FROM (
             SELECT id, title, body, campaign_type, created_at FROM notifications
               WHERE status = 'SENT' AND (target_farmer_id = $1 OR audience IN ('FARMERS','ALL'))
             UNION ALL
             SELECT id, title, body, 'ADVISORY' AS campaign_type, created_at FROM advisories
               WHERE status IN ('SENT','READ') AND (farmer_id = $1 OR farmer_id IS NULL)
           ) feed
           ORDER BY created_at DESC LIMIT $2`,
          [id, limit],
        );
        return rows.map((r) => ({ id: r.id, title: r.title, body: r.body, campaignType: r.campaign_type, createdAt: r.created_at }));
      },
      appProducts: async (_p, args, ctx) => {
        farmerId(ctx);
        const rows = await catalog(args);
        return rows.map((r) => ({
          id: r.id, name: r.name, category: r.category, technicalName: r.technical_name, uom: r.uom, packingSize: r.packing_size,
          mrp: num(r.mrp), imageKey: r.image_key, recommendedDosage: r.recommended_dosage, applicationFrequency: r.application_frequency,
          targetCrops: r.target_crops ?? [], targetDiseases: r.target_diseases ?? [],
        }));
      },
      appWeather: async (_p, { lat, lng, language }, ctx) => {
        const id = farmerId(ctx);
        if ((lat == null) !== (lng == null) || (lat != null && (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180))) {
          throw httpError('Provide valid latitude and longitude together', 400);
        }
        const f = (await query('SELECT village, district, state, gps_lat, gps_lng, language FROM farmers WHERE id = $1', [id])).rows[0];
        if (!f) throw httpError('Farmer not found', 404);
        // Prefer the device's live coordinates (and remember them); else stored GPS; else region name.
        let la = lat, ln = lng;
        const locationUpdate = la != null && ln != null
          ? query('UPDATE farmers SET gps_lat=$2, gps_lng=$3 WHERE id=$1 AND (gps_lat IS DISTINCT FROM $2 OR gps_lng IS DISTINCT FROM $3)', [id, la, ln])
          : Promise.resolve();
        if (la == null || ln == null) {
          la = num(f.gps_lat); ln = num(f.gps_lng);
        }
        const city = f.district || f.village || f.state;
        if ((la == null || ln == null) && !city) throw httpError('Add your village in Profile or use your location for local weather', 400);
        const lang = ['en', 'hi'].includes(language) ? language : f.language === 'hi' ? 'hi' : 'en';
        const [w] = await Promise.all([
          la != null && ln != null
            ? getWeather({ lat: la, lon: ln, lang })
            : getWeather({ city: `${city},IN`, lang }),
          locationUpdate,
        ]);
        return { ...w, configured: weatherConfigured };
      },
    },

    Mutation: {
      farmerSignup: async (_p, { input }, _ctx) => {
        const email = input.email.trim().toLowerCase();
        if (!email || !input.password) throw httpError('Email and password are required', 400);
        if (input.password.length < 6) throw httpError('Password must be at least 6 characters', 400);
        const existing = await query('SELECT id FROM farmers WHERE lower(email) = $1', [email]);
        if (existing.rows[0]) throw httpError('An account with this email already exists', 409);
        const hash = await bcrypt.hash(input.password, 10);
        for (let attempt = 0; attempt < 5; attempt += 1) {
          try {
            const { rows } = await query(
              `INSERT INTO farmers (farmer_code, name, email, phone, village, district, state, language, password_hash, auth_provider)
               VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8,'en'),$9,'EMAIL') RETURNING *`,
              [genCode(), input.name.trim(), email, input.phone ?? null, input.village ?? null, input.district ?? null, input.state ?? null, input.language ?? null, hash],
            );
            await logActivity(null, 'FARMER_SIGNUP', 'farmer', rows[0].id, { via: 'EMAIL' });
            return authPayload(rows[0]);
          } catch (err) {
            if (err.code === '23505' && /farmer_code/.test(err.detail ?? '') && attempt < 4) continue;
            throw err;
          }
        }
        throw httpError('Could not create account', 500);
      },

      farmerLogin: async (_p, { email, password }, _ctx) => {
        const { rows } = await query('SELECT * FROM farmers WHERE lower(email) = $1', [email.trim().toLowerCase()]);
        const f = rows[0];
        if (!f || !f.password_hash || !(await bcrypt.compare(password, f.password_hash))) {
          throw httpError('Invalid email or password', 401);
        }
        return authPayload(f);
      },

      farmerGoogleAuth: async (_p, { idToken }, _ctx) => {
        // Verify the Google ID token server-side.
        const res = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`);
        if (!res.ok) throw httpError('Invalid Google token', 401);
        const info = await res.json();
        const wantAud = process.env.GOOGLE_CLIENT_ID;
        if (wantAud && info.aud !== wantAud) throw httpError('Google token audience mismatch', 401);
        const email = (info.email || '').toLowerCase();
        if (!email) throw httpError('Google account has no email', 400);

        const existing = (await query('SELECT * FROM farmers WHERE lower(email) = $1', [email])).rows[0];
        if (existing) {
          // Link Google to an existing (possibly admin-created) farmer.
          const { rows } = await query(
            "UPDATE farmers SET google_id = COALESCE(google_id,$2), auth_provider = CASE WHEN auth_provider='ADMIN' THEN 'GOOGLE' ELSE auth_provider END, photo_url = COALESCE(photo_url,$3) WHERE id = $1 RETURNING *",
            [existing.id, info.sub, info.picture ?? null],
          );
          return authPayload(rows[0]);
        }
        for (let attempt = 0; attempt < 5; attempt += 1) {
          try {
            const { rows } = await query(
              `INSERT INTO farmers (farmer_code, name, email, google_id, photo_url, language, auth_provider)
               VALUES ($1,$2,$3,$4,$5,'en','GOOGLE') RETURNING *`,
              [genCode(), info.name || email.split('@')[0], email, info.sub, info.picture ?? null],
            );
            await logActivity(null, 'FARMER_SIGNUP', 'farmer', rows[0].id, { via: 'GOOGLE' });
            return authPayload(rows[0]);
          } catch (err) {
            if (err.code === '23505' && /farmer_code/.test(err.detail ?? '') && attempt < 4) continue;
            throw err;
          }
        }
        throw httpError('Could not create account', 500);
      },

      updateMyProfile: async (_p, { input }, ctx) => {
        const id = farmerId(ctx);
        const { rows } = await query(
          `UPDATE farmers SET
             name = COALESCE($2,name), phone = COALESCE($3,phone), village = COALESCE($4,village),
             tehsil = COALESCE($5,tehsil), district = COALESCE($6,district), state = COALESCE($7,state),
             crops = COALESCE($8,crops), land_size_acres = COALESCE($9,land_size_acres), language = COALESCE($10,language),
             updated_at = now()
           WHERE id = $1 RETURNING *`,
          [id, input.name ?? null, input.phone ?? null, input.village ?? null, input.tehsil ?? null, input.district ?? null, input.state ?? null, input.crops ?? null, input.landSizeAcres ?? null, input.language ?? null],
        );
        return mapFarmer(rows[0]);
      },

      changeMyPassword: async (_p, { oldPassword, newPassword }, ctx) => {
        const id = farmerId(ctx);
        const f = (await query('SELECT password_hash FROM farmers WHERE id = $1', [id])).rows[0];
        if (f.password_hash && !(await bcrypt.compare(oldPassword, f.password_hash))) throw httpError('Current password is incorrect', 400);
        if (newPassword.length < 6) throw httpError('Password must be at least 6 characters', 400);
        await query("UPDATE farmers SET password_hash = $2, auth_provider = CASE WHEN auth_provider='ADMIN' THEN 'EMAIL' ELSE auth_provider END WHERE id = $1", [id, await bcrypt.hash(newPassword, 10)]);
        return true;
      },

      registerMyDevice: async (_p, { fcmToken }, ctx) => {
        const id = farmerId(ctx);
        await query('UPDATE farmers SET fcm_token = $2 WHERE id = $1', [id, fcmToken]);
        return true;
      },

      setMyProfilePhoto: async (_p, { imageUrl }, ctx) => {
        const id = farmerId(ctx);
        const { rows } = await query('UPDATE farmers SET photo_url = $2, updated_at = now() WHERE id = $1 RETURNING *', [id, imageUrl]);
        await logActivity(null, 'SET_FARMER_PHOTO', 'farmer', id, { via: 'farmer-app' });
        return mapFarmer(rows[0]);
      },

      raiseComplaint: async (_p, { input }, ctx) => {
        const id = farmerId(ctx);
        if (!input.category?.trim()) throw httpError('Complaint category is required', 400);
        const ticketNo = `CMP-${String((await query("SELECT nextval('complaint_seq') n")).rows[0].n).padStart(6, '0')}`;
        // Same priority scale as the admin panel (LOW / NORMAL / HIGH).
        const { rows } = await query(
          `INSERT INTO complaints (ticket_no, farmer_id, category, description, status, priority)
           VALUES ($1,$2,$3,$4,'OPEN','NORMAL') RETURNING *`,
          [ticketNo, id, input.category.trim(), input.description],
        );
        await query("INSERT INTO complaint_events (complaint_id, event_type, detail) VALUES ($1,'CREATED',$2)", [rows[0].id, `Complaint ${ticketNo} raised from the Farmer App`]);
        await logActivity(null, 'RAISE_COMPLAINT', 'complaint', rows[0].id, { ticketNo, via: 'farmer-app' });
        const r = rows[0];
        return { id: r.id, ticketNo: r.ticket_no, category: r.category, description: r.description, status: r.status, priority: r.priority, resolutionNote: r.resolution_note, createdAt: r.created_at };
      },

      runMyDiagnosis: async (_p, { crop, imageUrl, language }, ctx) => {
        const id = farmerId(ctx);
        const { analysisImage, storedImage } = cropPhotoInput(imageUrl);
        // Full RAG grounding: Pinecone → in-memory cosine → recent fallback (same as admin).
        const { references } = await getTrainingReferences(crop, analysisImage, { fast: true });
        // Farmer-facing diagnosis and management instructions are always Hindi.
        const d = await diagnoseCrop({ crop, imageUrl: analysisImage, references, lang: language === 'en' ? 'en' : 'hi', fast: true });
        // Prefer the model's catalog-grounded choices; only fall back when it did
        // not select a matching Cropland product.
        const productIds = d.productIds?.length ? d.productIds : await matchProductsForApp(crop, d.disease);
        const sessionNo = `CD-${String((await query("SELECT nextval('diag_seq') n")).rows[0].n).padStart(5, '0')}`;
        const { rows } = await query(
          `INSERT INTO crop_diagnoses (session_no, farmer_id, crop, image_url, detected_disease, pathogen, confidence, severity, symptoms, recommendation, product_ids, source)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
          [sessionNo, id, crop, storedImage, d.disease, d.pathogen, d.confidence, d.severity, d.symptoms, d.recommendation, productIds, d.source],
        );
        await logActivity(null, 'CROP_DIAGNOSIS', 'crop_diagnosis', rows[0].id, { crop, via: 'farmer-app' });
        const r = rows[0];
        return {
          id: r.id, sessionNo: r.session_no, crop: r.crop, detectedDisease: r.detected_disease, pathogen: r.pathogen,
          confidence: num(r.confidence), severity: r.severity, symptoms: r.symptoms, recommendation: r.recommendation,
          source: r.source, products: await productNames(productIds), productIds, imageUrl: r.image_url, createdAt: r.created_at,
        };
      },

      markAdvisoryRead: async (_p, { id }, ctx) => {
        const fid = farmerId(ctx);
        // Farmer-specific advisories: mark as READ. Broadcast (farmer_id IS NULL) stay SENT — shared record, not personal.
        await query("UPDATE advisories SET status='READ' WHERE id=$1 AND farmer_id=$2 AND status='SENT'", [id, fid]);
        return true;
      },

      requestMyAccountDeletion: async (_p, { reason }, ctx) => {
        const id = farmerId(ctx);
        const cleanReason = reason?.trim() || null;
        const { rows } = await query(
          `UPDATE farmers SET
             deletion_status = 'REQUESTED',
             deletion_requested_at = COALESCE(deletion_requested_at, now()),
             deletion_reason = $2,
             updated_at = now()
           WHERE id = $1 AND COALESCE(deletion_status,'') <> 'DELETED'
           RETURNING farmer_code, name, email, phone`,
          [id, cleanReason],
        );
        if (!rows[0]) throw httpError('Account not found', 404);
        await logActivity(null, 'REQUEST_ACCOUNT_DELETION', 'farmer', id, { via: 'farmer-app', reason: cleanReason });
        try {
          const to = process.env.ACCOUNT_DELETION_NOTIFY_EMAIL || process.env.SMTP_USER;
          if (to) {
            const f = rows[0];
            await sendEmail(
              [to],
              `Account deletion request — ${f.name} (${f.farmer_code})`,
              `A farmer has requested account deletion from the app.\n\n`
                + `Name: ${f.name}\nFarmer code: ${f.farmer_code}\n`
                + `Email: ${f.email || '—'}\nPhone: ${f.phone || '—'}\n`
                + `Reason: ${cleanReason || '—'}\n\n`
                + 'Review it in Admin → Farmers → Account deletion requests.',
            );
          }
        } catch { /* notification is best-effort */ }
        return true;
      },
    },

    FarmerProfile: { photoUrl: (parent) => imgUrl(parent.photoKey) },
    AppDiagnosis: { recommendedProducts: (parent) => productRefs(parent.productIds) },
    AppProduct: { imageUrl: (parent) => imgUrl(parent.imageKey) },
    AppComplaint: {
      events: async (parent) => {
        const { rows } = await query('SELECT event_type, detail, created_at FROM complaint_events WHERE complaint_id=$1 ORDER BY created_at', [parent.id]);
        return rows.map((r) => ({ type: r.event_type, detail: r.detail, at: r.created_at }));
      },
    },
  };
}
