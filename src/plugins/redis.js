// Fastify plugin exposing a shared ioredis client as `fastify.redis`.
// Optional: `fastify.redis` is null when REDIS_URL is unset or unreachable at boot,
// so the API never depends on Redis to serve requests.

import fp from 'fastify-plugin';
import Redis from 'ioredis';
import { env } from '../config/env.js';

async function redisPlugin(fastify) {
  if (!env.redis.url) {
    fastify.decorate('redis', null);
    return;
  }

  const client = new Redis(env.redis.url, {
    lazyConnect: true,
    maxRetriesPerRequest: 3,
    enableOfflineQueue: false, // fail fast instead of queueing while disconnected
    retryStrategy: (times) => Math.min(times * 1000, 30_000), // back off up to 30s between reconnects
  });

  // Log once per outage, not once per reconnect attempt (a boot failure is logged below instead).
  let down = true;
  client.on('error', (err) => {
    if (!down) fastify.log.warn({ err: err.message }, 'redis unavailable');
    down = true;
  });
  client.on('ready', () => {
    fastify.log.info('redis connected');
    down = false;
  });

  try {
    await client.connect();
  } catch (err) {
    fastify.log.warn({ err: err.message }, 'redis connection failed at boot; continuing without redis');
    client.disconnect();
    fastify.decorate('redis', null);
    return;
  }

  fastify.decorate('redis', client);

  fastify.addHook('onClose', async () => {
    await client.quit().catch(() => client.disconnect());
  });
}

export default fp(redisPlugin, { name: 'redis' });
