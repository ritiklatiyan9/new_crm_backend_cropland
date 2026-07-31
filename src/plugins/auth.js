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

  // Verify a bearer token; attaches payload to request.user.
  fastify.decorate('authenticate', async function (request, reply) {
    try {
      await request.jwtVerify();
    } catch (err) {
      reply.code(401).send({ error: 'Unauthorized', message: 'Invalid or missing token' });
    }
  });

  // Factory: ensure the authenticated user holds one of the allowed roles.
  fastify.decorate('requireRole', function (...roles) {
    return async function (request, reply) {
      try {
        await request.jwtVerify();
      } catch {
        return reply.code(401).send({ error: 'Unauthorized' });
      }
      if (!roles.includes(request.user?.role)) {
        return reply.code(403).send({ error: 'Forbidden', message: 'Insufficient role' });
      }
    };
  });
}

export default fp(authPlugin, { name: 'auth' });
 