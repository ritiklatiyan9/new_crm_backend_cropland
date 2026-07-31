// Fastify plugin exposing the pg pool + helpers as `fastify.db`.

import fp from 'fastify-plugin';
import { pool, query, withTransaction, pingDb, closeDb } from '../db/index.js';

async function dbPlugin(fastify) {
  fastify.decorate('db', { pool, query, withTransaction, ping: pingDb });

  fastify.addHook('onClose', async () => {
    await closeDb();
  });
}

export default fp(dbPlugin, { name: 'db' });
