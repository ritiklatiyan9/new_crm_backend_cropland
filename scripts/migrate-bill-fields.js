// Add the optional delivery/dispatch columns used by the printed bill header.
// Safe to rerun against an existing database.
import pg from 'pg';

const client = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  ssl: ['1', 'true', 'yes', 'on'].includes(String(process.env.PGSSL).toLowerCase())
    ? { rejectUnauthorized: false }
    : false,
});

try {
  await client.connect();
  await client.query('BEGIN');
  await client.query('ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_note TEXT');
  await client.query('ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_note_date DATE');
  await client.query('ALTER TABLE orders ADD COLUMN IF NOT EXISTS dispatch_doc_no TEXT');
  await client.query('COMMIT');
  process.stdout.write('Bill header fields are ready.\n');
} catch (error) {
  await client.query('ROLLBACK').catch(() => {});
  process.stderr.write(`Bill fields migration failed: ${error.message}\n`);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
