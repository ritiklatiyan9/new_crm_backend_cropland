// JWT authentication plugin.
// Registers @fastify/jwt and adds an `authenticate` decorator used as a preHandler,
// plus a `requireRole` factory for role-based access control (PRD §2).

import fp from 'fastify-plugin';
import fastifyJwt from '@fastify/jwt';
import { env } from '../config/env.js';

async function authPlugin(fastify) {
  fastify.register(fastifyJwt, {
    secret: env.jwt.secret,
    sign: { expiresIn: env.jwt.accessExpires },
  });

  // Verify a bearer access token; attaches payload to request.user. Returns false after replying 401.
  async function verify(request, reply) {
    try {
      await request.jwtVerify();
      if (request.user?.type !== 'refresh') return true; // refresh tokens are not access tokens
    } catch (err) {
      if (err.code === 'FST_JWT_AUTHORIZATION_TOKEN_EXPIRED') {
        reply.code(401).send({ error: 'Unauthorized', code: 'UNAUTHENTICATED', message: 'Session expired' });
        return false;
      }
    }
    reply.code(401).send({ error: 'Unauthorized', code: 'UNAUTHENTICATED', message: 'Invalid or missing token' });
    return false;
  }

  fastify.decorate('authenticate', async function (request, reply) {
    if (!(await verify(request, reply))) return reply;
  });

  // Factory: ensure the authenticated user holds one of the allowed roles.
  fastify.decorate('requireRole', function (...roles) {
    return async function (request, reply) {
      if (!(await verify(request, reply))) return reply;
      if (!roles.includes(request.user?.role)) {
        return reply.code(403).send({ error: 'Forbidden', message: 'Insufficient role' });
      }
    };
  });
}

export default fp(authPlugin, { name: 'auth' });
 