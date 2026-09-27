// Liveness/readiness endpoints. Readiness checks the DB, plus Redis only when it is configured.

export default async function healthRoutes(fastify) {
  fastify.get('/health', async () => ({ status: 'ok', service: 'agroerp-backend-crm' }));

  fastify.get('/ready', async (_req, reply) => {
    const checks = { db: false };
    try {
      checks.db = await fastify.db.ping();
    } catch {
      checks.db = false;
    }
    if (fastify.redis) {
      try {
        checks.redis = (await fastify.redis.ping()) === 'PONG';
      } catch {
        checks.redis = false;
      }
    }
    const healthy = Object.values(checks).every(Boolean);
    reply.code(healthy ? 200 : 503).send({ status: healthy ? 'ready' : 'degraded', checks });
  });
}
