// Notification dispatch — fans a message out across the requested channels.

import { sendEmail, emailConfigured } from './email.js';
import { sendPush, pushConfigured } from './push.js';
import { sendSms, smsConfigured } from './sms.js';

export const channelStatus = {
  EMAIL: emailConfigured,
  PUSH: pushConfigured,
  SMS: smsConfigured,
};

/**
 * Dispatch a notification.
 * @param {object} opts
 * @param {string[]} opts.channels - PUSH/EMAIL/SMS
 * @param {string} opts.title
 * @param {string} opts.body
 * @param {string[]} [opts.emails] - email recipients
 * @param {string[]} [opts.tokens] - FCM device tokens
 * @param {string[]} [opts.phones] - SMS numbers
 * @returns {Promise<{results: object[], sent: number, status: string}>}
 */
export async function dispatch({ channels, title, body, emails = [], tokens = [], phones = [] }) {
  const tasks = [];
  if (channels.includes('EMAIL')) tasks.push(sendEmail(emails, title, body));
  if (channels.includes('PUSH')) tasks.push(sendPush(tokens, title, body));
  if (channels.includes('SMS')) tasks.push(sendSms(phones, body));

  const settled = await Promise.allSettled(tasks);
  const results = settled.map((s) =>
    s.status === 'fulfilled' ? s.value : { error: String(s.reason?.message ?? s.reason) },
  );
  const sent = results.reduce((n, r) => n + (r.sent ?? 0), 0);
  const anyError = results.some((r) => r.error);
  const allSkipped = results.length > 0 && results.every((r) => r.skipped || r.sent === 0);
  const status = anyError ? 'FAILED' : sent > 0 ? 'SENT' : allSkipped ? 'PARTIAL' : 'SENT';
  return { results, sent, status };
}
