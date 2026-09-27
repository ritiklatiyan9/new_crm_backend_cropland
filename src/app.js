// Builds and configures the Fastify application instance.
// Registers infra plugins, security middleware, GraphQL (Mercurius), and REST routes.

import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import sensible from '@fastify/sensible';
import rateLimit from '@fastify/rate-limit';
import compress from '@fastify/compress';
import mercurius from 'mercurius';
import { GraphQLError } from 'graphql';

import { env } from './config/env.js';
import dbPlugin from './plugins/db.js';
import redisPlugin from './plugins/redis.js';
import authPlugin from './plugins/auth.js';
import { schema } from './graphql/schema.js';
import { buildResolvers } from './graphql/resolvers.js';
import { buildContext } from './graphql/context.js';
import { friendlyError, friendlyGraphqlMessage } from './graphql/helpers.js';
import { requestStore } from './utils/requestContext.js';
import healthRoutes from './routes/health.js';
import uploadRoutes from './routes/uploads.js';
import reportRoutes from './routes/reports.js';
import { startAuditCleanup } from './jobs/auditCleanup.js';

// Operations that check a password: they share a small per-IP bucket (see rateLimit below).
const LOGIN_MUTATION = /\b(login|farmerLogin|farmerSignup|updateMyPassword|changeMyPassword)\b/;

function isLoginRequest(req) {
  if (req.method !== 'POST' || !req.url.startsWith('/graphql')) return false;
  const q = req.body?.query;
  return typeof q === 'string' && LOGIN_MUTATION.test(q);
}

// Translate raw DB / variable-coercion errors into short, human messages (see helpers.js),
// log the original server-side, then defer to Mercurius for status code + serialization.
function errorFormatter(execution, ctx) {
  const log = ctx.reply?.log ?? ctx.app.log;
  const body = ctx.reply?.request?.body;
  execution.errors = execution.errors.map((error) => {
    const friendly = friendlyError(error.originalError, { isProd: env.isProd, variables: body?.variables });
    if (!friendly) return error;
    const operation = body?.operationName ?? body?.query?.match?.(/^\s*(?:query|mutation)\s+(\w+)/)?.[1] ?? null;
    const level = /INTERNAL|UNAVAILABLE|TIMEOUT/.test(friendly.code) ? 'error' : 'warn';
    log[level]({ err: error.originalError, operation, path: error.path?.join('.') }, 'graphql resolver error');
    return new GraphQLError(friendly.message, {
      nodes: error.nodes,
      source: error.source,
      positions: error.positions,
      path: error.path,
      extensions: { code: friendly.code },
    });
  });
  const result = mercurius.defaultErrorFormatter(execution, ctx);
  for (const e of result.response.errors) {
    const message = friendlyGraphqlMessage(e.message);
    if (message) {
      e.message = message;
      e.extensions = { ...e.extensions, code: 'BAD_USER_INPUT' };
    }
  }
  return result;
}

export async function buildApp() {
  const app = Fastify({
    // Honour X-Forwarded-For so the real client IP is captured behind a proxy.
    trustProxy: true,
    logger: {
      level: env.logLevel,
      transport: env.isProd
        ? undefined
        : { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } },
    },
  });

  // Bind a request-scoped store (client IP) for deep helpers like the audit logger.
  app.addHook('onRequest', (request, _reply, done) => {
    requestStore.enterWith({ ip: request.ip });
    done();
  });

  // ── Security & utility middleware ──────────────────────────
  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, { origin: env.corsOrigins, credentials: true });
  await app.register(sensible);
  // Per-IP. Admin pages fire many parallel queries, so the general budget is generous;
  // password logins get their own small bucket to keep brute force meaningful.
  // Runs at preHandler so the GraphQL body is parsed and the operation can be seen.
  await app.register(rateLimit, {
    hook: 'preHandler',
    timeWindow: '1 minute',
    keyGenerator: (req) => (isLoginRequest(req) ? `login:${req.ip}` : req.ip),
    // ponytail: per-IP, so an office behind one NAT shares 3000/min; key by verified user id if that bites.
    max: (_req, key) => (key.startsWith('login:') ? 20 : 3000),
  });
  await app.register(compress); // gzip/br for responses over 1 KB

  // REST routes (reports, uploads) get the same DB-error translation; GraphQL uses errorFormatter.
  app.setErrorHandler((err, request, reply) => {
    const friendly = friendlyError(err, { isProd: env.isProd });
    if (!friendly) return reply.send(err); // Fastify's default handler
    request.log.error({ err }, 'request failed');
    const status = { BAD_USER_INPUT: 400, CONFLICT: 409, SERVICE_UNAVAILABLE: 503, TIMEOUT: 504 }[friendly.code] ?? 500;
    return reply.code(status).send({ statusCode: status, code: friendly.code, message: friendly.message });
  });

  // ── Infrastructure plugins ─────────────────────────────────
  await app.register(dbPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);

  // ── GraphQL (Mercurius) ────────────────────────────────────
  await app.register(mercurius, {
    schema,
    resolvers: buildResolvers(app),
    context: (request) => buildContext(request),
    errorFormatter,
    jit: 1, // compile a query with graphql-jit from its 2nd execution
    graphiql: !env.isProd, // GraphiQL IDE available at /graphiql in dev
    path: '/graphql',
  });

  // ── REST routes ────────────────────────────────────────────
  await app.register(healthRoutes);
  await app.register(uploadRoutes);
  await app.register(reportRoutes);

  app.get('/', async () => ({
    name: 'AgroERP Backend CRM',
    version: '1.0.0',
    graphql: '/graphql',
    graphiql: env.isProd ? null : '/graphiql',
    health: '/health',
  }));

  // ── Scheduled jobs ─────────────────────────────────────────
  const stopAuditCleanup = startAuditCleanup(app); // purge audit logs older than 7 days (daily)
  app.addHook('onClose', async () => stopAuditCleanup());

  return app;
}
