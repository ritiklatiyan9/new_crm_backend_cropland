// WhatsApp channel — provider-abstracted (Meta WhatsApp Cloud API), with a
// graceful mock fallback when credentials aren't configured.
// Env: WHATSAPP_TOKEN, WHATSAPP_PHONE_ID (Meta Cloud API phone-number id).

const TOKEN = process.env.WHATSAPP_TOKEN || '';
const PHONE_ID = process.env.WHATSAPP_PHONE_ID || '';
const GRAPH = process.env.WHATSAPP_API_BASE || 'https://graph.facebook.com/v20.0';

export const whatsappConfigured = Boolean(TOKEN && PHONE_ID);

export function whatsappStatus() {
  return { configured: whatsappConfigured, provider: whatsappConfigured ? 'meta_cloud' : 'mock' };
}

const normalize = (phone) => String(phone || '').replace(/[^\d]/g, '');

/** Send one WhatsApp message (text, optionally with an image header). */
export async function sendWhatsApp({ to, body, mediaUrl }) {
  const phone = normalize(to);
  if (!phone) return { ok: false, error: 'no phone' };
  // 10-digit Indian numbers → prefix country code.
  const wa = phone.length === 10 ? `91${phone}` : phone;

  if (!whatsappConfigured) return { ok: true, mock: true }; // demo mode

  try {
    const message = mediaUrl
      ? { messaging_product: 'whatsapp', to: wa, type: 'image', image: { link: mediaUrl, caption: body } }
      : { messaging_product: 'whatsapp', to: wa, type: 'text', text: { body } };
    const res = await fetch(`${GRAPH}/${PHONE_ID}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(message),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      return { ok: false, error: `WhatsApp ${res.status}: ${txt.slice(0, 140)}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'send failed' };
  }
}
