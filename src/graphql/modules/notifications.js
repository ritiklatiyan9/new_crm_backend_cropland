// GraphQL module: Notification Center (PRD §10, §12).
// Channels: PUSH (FCM, Farmer App) · EMAIL (Nodemailer) · SMS (stub).

import { query } from '../../db/index.js';
import { assertRole } from '../context.js';
import { httpError, logActivity } from '../helpers.js';
import { dispatch, channelStatus } from '../../services/notify/index.js';

export const notificationTypeDefs = /* GraphQL */ `
  type Notification {
    id: ID!
    audience: String!
    channels: [String!]!
    campaignType: String
    title: String!
    body: String!
    status: String!
    recipients: Int!
    result: JSON
    sentAt: DateTime
    createdAt: DateTime!
  }

  type ChannelStatus {
    email: Boolean!
    push: Boolean!
    sms: Boolean!
  }

  input SendNotificationInput {
    audience: String!          # FARMERS / DISTRIBUTORS / USERS / ALL
    channels: [String!]!       # PUSH / EMAIL / SMS
    campaignType: String
    title: String!
    body: String!
    targetFarmerId: ID
    targetUserId: ID
  }

  extend type Query {
    notifications(limit: Int = 50): [Notification!]!
    notificationChannels: ChannelStatus!
  }

  extend type Mutation {
    sendNotification(input: SendNotificationInput!): Notification!
  }
`;

const mapNotification = (r) => ({
  id: r.id,
  audience: r.audience,
  channels: r.channels ?? [],
  campaignType: r.campaign_type,
  title: r.title,
  body: r.body,
  status: r.status,
  recipients: r.recipients ?? 0,
  result: r.result,
  sentAt: r.sent_at,
  createdAt: r.created_at,
});

// Resolve the email / FCM-token / phone recipient lists for an audience.
async function resolveRecipients(input) {
  const emails = [];
  const tokens = [];
  const phones = [];
  const { audience, targetFarmerId, targetUserId } = input;

  if (targetUserId) {
    const u = await query('SELECT email FROM users WHERE id = $1', [targetUserId]);
    if (u.rows[0]?.email) emails.push(u.rows[0].email);
  }
  if (targetFarmerId) {
    const f = await query('SELECT fcm_token, phone, email FROM farmers WHERE id = $1', [targetFarmerId]);
    if (f.rows[0]?.fcm_token) tokens.push(f.rows[0].fcm_token);
    if (f.rows[0]?.phone) phones.push(f.rows[0].phone);
    if (f.rows[0]?.email) emails.push(f.rows[0].email);
  }
  if (targetUserId || targetFarmerId) return { emails, tokens, phones };

  if (audience === 'USERS' || audience === 'ALL') {
    const u = await query("SELECT email FROM users WHERE is_active AND email IS NOT NULL");
    emails.push(...u.rows.map((r) => r.email));
  }
  if (audience === 'DISTRIBUTORS' || audience === 'ALL') {
    const d = await query("SELECT email, phone FROM distributors WHERE is_active");
    emails.push(...d.rows.map((r) => r.email).filter(Boolean));
    phones.push(...d.rows.map((r) => r.phone).filter(Boolean));
  }
  if (audience === 'FARMERS' || audience === 'ALL') {
    const f = await query('SELECT fcm_token, phone, email FROM farmers');
    tokens.push(...f.rows.map((r) => r.fcm_token).filter(Boolean));
    phones.push(...f.rows.map((r) => r.phone).filter(Boolean));
    emails.push(...f.rows.map((r) => r.email).filter(Boolean));
  }
  return { emails, tokens, phones };
}

export function notificationResolvers() {
  return {
    Query: {
      notifications: async (_p, { limit }, ctx) => {
        assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN');
        const { rows } = await query('SELECT * FROM notifications ORDER BY created_at DESC LIMIT $1', [limit]);
        return rows.map(mapNotification);
      },
      notificationChannels: async (_p, _a, ctx) => {
        assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN');
        return { email: channelStatus.EMAIL, push: channelStatus.PUSH, sms: channelStatus.SMS };
      },
    },
    Mutation: {
      sendNotification: async (_p, { input }, ctx) => {
        const actor = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN');
        if (!input.channels?.length) throw httpError('Select at least one channel', 400);

        const { emails, tokens, phones } = await resolveRecipients(input);
        const { results, sent, status } = await dispatch({
          channels: input.channels,
          title: input.title,
          body: input.body,
          emails,
          tokens,
          phones,
        });

        const { rows } = await query(
          `INSERT INTO notifications
             (audience, channels, campaign_type, title, body, target_user_id, target_farmer_id, status, result, recipients, created_by, sent_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now()) RETURNING *`,
          [
            input.audience,
            input.channels,
            input.campaignType ?? null,
            input.title,
            input.body,
            input.targetUserId ?? null,
            input.targetFarmerId ?? null,
            status,
            JSON.stringify(results),
            sent,
            actor.sub,
          ],
        );
        await logActivity(actor.sub, 'SEND_NOTIFICATION', 'notification', rows[0].id, { channels: input.channels, sent });
        return mapNotification(rows[0]);
      },
    },
  };
}
