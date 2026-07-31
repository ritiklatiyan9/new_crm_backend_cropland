// Seeds branches and demo users for local development.
// Usage: node --env-file=.env scripts/seed.js

import bcrypt from 'bcryptjs';
import pg from 'pg';

async function main() {
  const client = new pg.Client({
    connectionString: process.env.DATABASE_URL,
    ssl: ['1', 'true', 'yes', 'on'].includes(String(process.env.PGSSL).toLowerCase())
      ? { rejectUnauthorized: false }
      : false,
  });
  await client.connect();
  try {
    // Branches
    await client.query(
      `INSERT INTO branches (name, code, state, district) VALUES
         ('Head Office', 'HO', 'Maharashtra', 'Pune'),
         ('Nashik Branch', 'NSK', 'Maharashtra', 'Nashik'),
         ('Guntur Branch', 'GNT', 'Andhra Pradesh', 'Guntur')
       ON CONFLICT (code) DO NOTHING`,
    );

    const ho = await client.query("SELECT id FROM branches WHERE code = 'HO'");
    const nsk = await client.query("SELECT id FROM branches WHERE code = 'NSK'");
    const hoId = ho.rows[0]?.id ?? null;
    const nskId = nsk.rows[0]?.id ?? null;

    // Owner / head account (SUPER_ADMIN)
    const ownerHash = await bcrypt.hash('owner@123', 10);
    await client.query(
      `INSERT INTO users (name, email, phone, role, branch_id, password_hash, is_active)
       VALUES ('Owner', 'owner@gmail.com', '9000000000', 'SUPER_ADMIN', $1, $2, TRUE)
       ON CONFLICT (email) DO UPDATE
         SET role = 'SUPER_ADMIN', is_active = TRUE, password_hash = EXCLUDED.password_hash`,
      [hoId, ownerHash],
    );

    // Demo users (password for all: Admin@123)
    const passwordHash = await bcrypt.hash('Admin@123', 10);
    await client.query(
      `INSERT INTO users (name, email, phone, role, branch_id, password_hash, is_active) VALUES
         ('Asha Verma',  'asha.admin@agroerp.example', '9811112222', 'ADMIN', $1, $2, TRUE),
         ('Ravi Branch', 'ravi.sub@agroerp.example', '9822223333', 'SUB_ADMIN', $3, $2, TRUE),
         ('Sales Rep One','sales1@agroerp.example', '9833334444', 'SALES', $3, $2, TRUE),
         ('Inactive User','inactive@agroerp.example', '9844445555', 'SALES', $3, $2, FALSE)
       ON CONFLICT (email) DO NOTHING`,
      [hoId, passwordHash, nskId],
    );

    // Demo products (Product Master)
    await client.query(
      `INSERT INTO products
         (name, sku, category, technical_name, uom, packing_size, hsn_code, gst_percent,
          mrp, dealer_price, distributor_price, target_crops, target_diseases, season_tags,
          recommended_dosage, application_frequency, hazard_category, shelf_life_months)
       VALUES
         ('CropShield 50 EC','CS50EC-250','INSECTICIDE','Chlorpyrifos 50% EC','L','250ml','38089199',18,
          480,410,370, ARRAY['Paddy','Cotton'], ARRAY['Aphids','Brown Planthopper'], ARRAY['Kharif'],
          '2 ml/litre water','2 sprays per season','WHO Class II',24),
         ('FungiCare WP','FCWP-500','FUNGICIDE','Mancozeb 75% WP','KG','500g','38089290',18,
          650,560,510, ARRAY['Tomato','Potato'], ARRAY['Early Blight','Late Blight'], ARRAY['Rabi'],
          '2.5 g/litre water','3 sprays per season','WHO Class III',36),
         ('NutriGrow GR','NG-GR-1KG','FERTILIZER','NPK 19:19:19','KG','1Kg','31051000',5,
          320,290,270, ARRAY['All Crops'], ARRAY[]::text[], ARRAY['Kharif','Rabi'],
          '25 kg/acre','As required','Non-hazardous',48),
         ('WeedClear SL','WC-SL-1L','HERBICIDE','Glyphosate 41% SL','L','1L','38089300',18,
          890,790,720, ARRAY['Wheat','Soybean'], ARRAY['Broadleaf Weeds'], ARRAY['Rabi'],
          '5 ml/litre water','1 spray','WHO Class III',24),
         ('BioSafe Bio','BS-BIO-500','BIO_PRODUCT','Trichoderma viride','KG','500g','31010099',12,
          540,470,430, ARRAY['Vegetables'], ARRAY['Soil-borne fungi'], ARRAY['Kharif'],
          '5 g/litre water','2 applications','Non-hazardous',12)
       ON CONFLICT (sku) DO NOTHING`,
    );

    // eslint-disable-next-line no-console
    console.log('✅ seed complete — owner login: owner@gmail.com / owner@123');
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('❌ seed failed:', err.message);
  process.exit(1);
});
