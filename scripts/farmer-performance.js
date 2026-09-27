import { pool, query } from '../src/db/index.js';
import { createCatalog } from '../src/services/farmer/catalog.js';
import { getWeather } from '../src/services/weather/index.js';

// Safe to run repeatedly. CONCURRENTLY keeps normal reads and writes available.
const indexes = [
  ['idx_app_products_active_name', 'products (name, id) WHERE is_active'],
  ['idx_app_products_active_category', 'products (category, name, id) WHERE is_active'],
  ['idx_app_invoices_farmer_totals', 'invoices (farmer_id) INCLUDE (total_amount, amount_paid)'],
  ['idx_app_invoices_order', 'invoices (order_id) INCLUDE (amount_paid)'],
  ['idx_app_orders_farmer_created', 'orders (farmer_id, created_at DESC)'],
  ['idx_app_advisories_farmer_created', 'advisories (farmer_id, created_at DESC)'],
  ['idx_app_complaints_farmer_created', 'complaints (farmer_id, created_at DESC)'],
  ['idx_app_loyalty_farmer_created', 'loyalty_transactions (farmer_id, created_at DESC)'],
];

try {
  if (process.argv.includes('--apply')) {
    // A dedicated connection holds the timeouts for every index command.
    const client = await pool.connect();
    try {
      await client.query("SET lock_timeout = '5s'");
      await client.query("SET statement_timeout = '120s'");
      for (const [name, definition] of indexes) {
        await client.query(`CREATE INDEX CONCURRENTLY IF NOT EXISTS ${name} ON ${definition}`);
        console.log('Index ready:', name);
      }
      for (const table of ['products', 'invoices', 'orders', 'advisories', 'complaints', 'loyalty_transactions']) {
        await client.query(`ANALYZE ${table}`);
      }
    } finally { client.release(); }
  }
  const valid = await query(`SELECT c.relname AS name, i.indisvalid AS valid FROM pg_index i
    JOIN pg_class c ON c.oid=i.indexrelid WHERE c.relname=ANY($1)`, [indexes.map(([name]) => name)]);
  console.log('Indexes:', JSON.stringify(valid.rows));
  const catalog = createCatalog(query);
  for (const pass of ['cold', 'cached']) {
    const start = performance.now();
    const rows = await catalog({ limit: 24 });
    console.log(`catalog_${pass}: ${(performance.now() - start).toFixed(1)} ms; ${rows.length} products`);
  }
  if (process.argv.includes('--weather')) {
    for (const pass of ['cold', 'cached']) {
      const start = performance.now();
      const weather = await getWeather({ lat: 28.61, lon: 77.21, lang: 'en' });
      console.log(`weather_${pass}: ${(performance.now() - start).toFixed(1)} ms; source=${weather.source}`);
    }
  }
} finally { await pool.end(); }
