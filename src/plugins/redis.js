// Fastify plugin exposing a shared ioredis client as `fastify.redis`.
// Used for sessions, caching, and background job queues (PRD §3.1).

import fp from 'fastify-plugin';
import Redis from 'ioredis';
import { env } from '../config/env.js';

async function redisPlugin(fastify) {
  const client = new Redis(env.redis.url, {
    lazyConnect: true,
    maxRetriesPerRequest: 3,
  });

  client.on('error', (err) => fastify.log.error({ err }, 'redis error'));

  try {
    await client.connect();
    fastify.log.info('redis connected');
  } catch (err) {
    // Don't hard-fail boot if Redis is briefly unavailable; log and continue.
    fastify.log.warn({ err }, 'redis connection failed at boot (will retry lazily)');
  }

  fastify.decorate('redis', client);

  fastify.addHook('onClose', async () => {
    await client.quit();
  });
}

export default fp(redisPlugin, { name: 'redis' });
