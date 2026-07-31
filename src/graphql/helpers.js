// Shared helpers for GraphQL resolver modules.

import { query } from '../db/index.js';
import { getRequestIp } from '../utils/requestContext.js';

/** Build an Error carrying an HTTP status code (surfaced by Mercurius). */
export function httpError(message, statusCode) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

/** Best-effort audit log; never blocks the primary operation. */
export async function logActivity(actorId, action, entity, entityId, metadata = {}) {
  try {
    // Normalise IPv4-mapped IPv6 (::ffff:127.0.0.1 -> 127.0.0.1) for a clean inet value.
    let ip = getRequestIp();
    if (ip && ip.startsWith('::ffff:')) ip = ip.slice(7);
    await query(
      `INSERT INTO activity_logs (user_id, action, entity, entity_id, ip_address, metadata)
       VALUES ($1, $2, $3, $4, $5::inet, $6)`,
      [actorId ?? null, action, entity, entityId ?? null, ip ?? null, JSON.stringify(metadata)],
    );
  } catch {
    /* swallow */
  }
}

/** Normalise a DB DATE/timestamp to an ISO yyyy-mm-dd string. */
export function isoDate(d) {
  if (!d) return null;
  return d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10);
}

/** Coerce numeric/“null” DB values to a JS number or null. */
export function num(v) {
  return v == null ? null : Number(v);
}
