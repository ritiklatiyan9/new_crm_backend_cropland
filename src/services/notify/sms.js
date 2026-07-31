// SMS channel — stub for the MSG91 gateway (PRD §12). Wired at go-live.

import { env } from '../../config/env.js';

export const smsConfigured = Boolean(process.env.MSG91_AUTH_KEY);

export async function sendSms(numbers, body) {
  const to = (numbers || []).filter(Boolean);
  if (!to.length) return { channel: 'SMS', sent: 0, note: 'no numbers' };
  if (!smsConfigured) return { channel: 'SMS', sent: 0, skipped: true, note: 'SMS gateway not configured' };
  // TODO: integrate MSG91 transactional SMS API.
  void env;
  void body;
  return { channel: 'SMS', sent: 0, skipped: true, note: 'SMS provider not yet implemented' };
}
