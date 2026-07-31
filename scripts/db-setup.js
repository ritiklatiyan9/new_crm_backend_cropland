// Applies database.sql to the configured PostgreSQL database.
// Usage: node --env-file=.env scripts/db-setup.js

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  const sql = await readFile(join(__dirname, '..', 'database.sql'), 'utf8');
  const client = new pg.Client({
    connectionString: process.env.DATABASE_URL,
    ssl: ['1', 'true', 'yes', 'on'].includes(String(process.env.PGSSL).toLowerCase())
      ? { rejectUnauthorized: false }
      : false,
  });
  await client.connect();
  try {
    await client.query(sql);
    // eslint-disable-next-line no-console
    console.log('✅ database.sql applied successfully');
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('❌ db setup failed:', err.message);
  process.exit(1);
});
