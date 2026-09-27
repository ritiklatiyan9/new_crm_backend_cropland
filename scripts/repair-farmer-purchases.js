import { pool } from '../src/db/index.js';

const client = await pool.connect();
try {
  await client.query("SET lock_timeout = '5s'");
  await client.query('BEGIN');
  // Nullable historical snapshots: existing sales values are never rewritten.
  for (const table of ['order_lines', 'party_sale_lines']) {
    await client.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS packing_size TEXT`);
  }
  await client.query(`ALTER TABLE farmers
    ADD COLUMN IF NOT EXISTS deletion_status TEXT,
    ADD COLUMN IF NOT EXISTS deletion_requested_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS deletion_reason TEXT`);
  await client.query('COMMIT');
  const result = await client.query(`SELECT table_name, column_name, data_type FROM information_schema.columns
    WHERE table_name IN ('order_lines', 'party_sale_lines') AND column_name='packing_size'`);
  console.log(JSON.stringify(result.rows));
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally { client.release(); await pool.end(); }
