// Builds the per-request GraphQL context.
// Decodes the JWT (if present) so resolvers can read `context.user`. No DB access here.

export async function buildContext(request) {
  let user = null;
  let authError = null;
  if (request.headers.authorization) {
    try {
      await request.jwtVerify();
      // Refresh tokens share the signing secret; never accept one as an access token.
      if (request.user?.type === 'refresh') authError = 'invalid';
      else user = request.user;
    } catch (err) {
      // Public queries still work with a bad token; assertAuth reports why it was rejected.
      authError = err.code === 'FST_JWT_AUTHORIZATION_TOKEN_EXPIRED' ? 'expired' : 'invalid';
    }
  }
  return { user, authError, log: request.log };
}

function gqlError(message, code) {
  const err = new Error(message);
  err.extensions = { code };
  return err;
}

/** Throw a GraphQL-friendly error if the request is unauthenticated.
 *  Always extensions.code = 'UNAUTHENTICATED'; message is 'Session expired' for an expired token.
 *  No statusCode — keeps HTTP 200 so graphql_flutter parses errors correctly. */
export function assertAuth(context) {
  if (!context.user) {
    throw gqlError(context.authError === 'expired' ? 'Session expired' : 'Unauthorized', 'UNAUTHENTICATED');
  }
  return context.user;
}

/** Throw if the authenticated user is not in `roles`. */
export function assertRole(context, ...roles) {
  const user = assertAuth(context);
  if (!roles.includes(user.role)) throw gqlError('Forbidden: insufficient role available', 'FORBIDDEN');
  return user;
}
