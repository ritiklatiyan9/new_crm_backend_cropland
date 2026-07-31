// Email channel — Nodemailer SMTP transport (Notification Center, PRD §12).
// Degrades gracefully to a no-op when SMTP isn't configured.
// Deliverability hardening (so Gmail keeps it out of Spam):
//   * single recipient -> real "To" (not bulk BCC)
//   * List-Unsubscribe + one-click headers (Google sender guidelines)
//   * Reply-To, a clean branded HTML body and a plain-text alternative

import nodemailer from 'nodemailer';
import { env } from '../../config/env.js';

export const emailConfigured = Boolean(env.smtp.host && env.smtp.user);

let transporter = null;
function getTransport() {
  if (transporter) return transporter;
  if (!emailConfigured) return null;
  transporter = nodemailer.createTransport({
    host: env.smtp.host,
    port: env.smtp.port,
    secure: env.smtp.secure,
    auth: { user: env.smtp.user, pass: env.smtp.pass },
  });
  return transporter;
}

const BRAND = 'Cropland Agritech India';

function wrapHtml(body) {
  const safe = (body || '').replace(/\n/g, '<br/>');
  return `<!doctype html><html><body style="margin:0;background:#f6faf8;padding:24px;font-family:Arial,Helvetica,sans-serif">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;border:1px solid #e5e7eb">
      <tr><td style="padding:20px 24px;border-bottom:1px solid #eef2f0">
        <span style="font-size:16px;font-weight:700;color:#059669">${BRAND}</span>
      </td></tr>
      <tr><td style="padding:24px;font-size:14px;line-height:1.6;color:#1f2937">${safe}</td></tr>
      <tr><td style="padding:16px 24px;border-top:1px solid #eef2f0;font-size:11px;color:#9ca3af">
        You received this email because you are registered with ${BRAND}.<br/>
        आपको यह ईमेल इसलिए मिला क्योंकि आप क्रॉपलैंड एग्रीटेक इंडिया के साथ पंजीकृत हैं।
      </td></tr>
    </table>
  </body></html>`;
}

/** Send an email to one or more recipients. Returns a dispatch summary. */
export async function sendEmail(recipients, subject, body, html) {
  const to = (recipients || []).filter(Boolean);
  if (!to.length) return { channel: 'EMAIL', sent: 0, note: 'no recipients' };
  const t = getTransport();
  if (!t) return { channel: 'EMAIL', sent: 0, skipped: true, note: 'SMTP not configured' };

  const unsub = `<mailto:${env.smtp.user}?subject=unsubscribe>`;
  const message = {
    from: env.smtp.from,
    replyTo: env.smtp.from,
    subject,
    text: body,
    html: html || wrapHtml(body),
    headers: {
      'List-Unsubscribe': unsub,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
  };
  // Single recipient => direct To (much better inbox placement than BCC).
  if (to.length === 1) message.to = to[0];
  else { message.to = env.smtp.from; message.bcc = to; }

  await t.sendMail(message);
  return { channel: 'EMAIL', sent: to.length };
}
