// Liveness/readiness endpoints. Readiness checks DB + Redis connectivity.

export default async function healthRoutes(fastify) {
  fastify.get('/health', async () => ({ status: 'ok', service: 'agroerp-backend-crm' }));

  fastify.get('/ready', async (_req, reply) => {
    const checks = { db: false, redis: false };
    try {
      checks.db = await fastify.db.ping();
    } catch {
      checks.db = false;
    }
    try {
      checks.redis = (await fastify.redis.ping()) === 'PONG';
    } catch {
      checks.redis = false;
    }
    const healthy = checks.db && checks.redis;
    reply.code(healthy ? 200 : 503).send({ status: healthy ? 'ready' : 'degraded', checks });
  });
}
