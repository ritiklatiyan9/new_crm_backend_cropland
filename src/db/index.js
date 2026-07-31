// PostgreSQL connection pool (node-postgres).
// We use raw SQL against the schema defined in `database.sql` (no ORM, per project decision).

import pg from 'pg';
import { env } from '../config/env.js';

const { Pool } = pg;

// Return DATE (OID 1082) columns as raw 'YYYY-MM-DD' strings rather than JS Date
// objects, so timezone conversion never shifts a calendar date by a day.
pg.types.setTypeParser(1082, (v) => v);

export const pool = new Pool({
  connectionString: env.db.connectionString,
  max: env.db.poolMax,
  ssl: env.db.ssl ? { rejectUnauthorized: false } : false,
});

pool.on('error', (err) => {
  // Surface unexpected idle-client errors instead of crashing silently.
  // eslint-disable-next-line no-console
  console.error('[pg] unexpected idle client error', err);
});

/**
 * Run a parameterised query against the pool.
 * @param {string} text - SQL with $1..$n placeholders.
 * @param {unknown[]} [params] - bound parameters.
 */
export function query(text, params) {
  return pool.query(text, params);
}

/**
 * Acquire a client and run `fn` inside a transaction.
 * Commits on success, rolls back on throw, always releases.
 * @template T
 * @param {(client: import('pg').PoolClient) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function pingDb() {
  const { rows } = await pool.query('SELECT 1 AS ok');
  return rows[0]?.ok === 1;
}

export async function closeDb() {
  await pool.end();
}
