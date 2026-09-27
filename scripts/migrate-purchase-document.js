import pg from 'pg';
const client = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: ['1','true','yes','on'].includes(String(process.env.PGSSL).toLowerCase()) ? { rejectUnauthorized: false } : false });
try {
  await client.connect();
  await client.query('BEGIN');
  await client.query("ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS document_details JSONB NOT NULL DEFAULT '{}'::jsonb");
  await client.query("ALTER TABLE purchase_order_lines ADD COLUMN IF NOT EXISTS entry_details JSONB NOT NULL DEFAULT '{}'::jsonb");
  await client.query('ALTER TABLE purchase_order_lines ALTER COLUMN unit_cost TYPE NUMERIC(16,6)');
  await client.query('ALTER TABLE purchase_order_lines ALTER COLUMN quantity TYPE NUMERIC(14,3), ALTER COLUMN received_qty TYPE NUMERIC(14,3)');
  await client.query('ALTER TABLE purchase_invoices ADD COLUMN IF NOT EXISTS print_snapshot JSONB');
  await client.query('COMMIT');
  console.log('Purchase document fields ready.');
} catch (e) { await client.query('ROLLBACK').catch(() => {}); console.error(e.message); process.exitCode = 1; }
finally { await client.end().catch(() => {}); }
