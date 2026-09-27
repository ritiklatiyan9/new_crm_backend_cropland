import pg from 'pg';
const client = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: ['1','true','yes','on'].includes(String(process.env.PGSSL).toLowerCase()) ? { rejectUnauthorized: false } : false });
try {
  await client.connect(); await client.query('BEGIN');
  await client.query("ALTER TABLE vendors ADD COLUMN IF NOT EXISTS pan TEXT, ADD COLUMN IF NOT EXISTS pincode TEXT, ADD COLUMN IF NOT EXISTS invoice_defaults JSONB NOT NULL DEFAULT '{}'::jsonb");
  await client.query('COMMIT'); console.log('Vendor profile fields ready.');
} catch (e) { await client.query('ROLLBACK').catch(() => {}); console.error(e.message); process.exitCode = 1; }
finally { await client.end().catch(() => {}); }
