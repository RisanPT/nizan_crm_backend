// TeamN Chat (WhatsApp dashboard) client — see CRM-Integration-Guide.pdf.
// The connection key lives ONLY here on the server (TEAMN_CHAT_KEY in .env);
// the Flutter app (web / Windows / mobile) talks to /api/whatsapp instead.

// Read per call: server.js loads .env after its imports have run.
const baseUrl = () => (process.env.TEAMN_CHAT_URL || 'https://chat.nizantech.com').replace(/\/+$/, '');
// Uploads usually take 1–5 s; the guide asks for at least 60 s.
const TIMEOUT_MS = 90 * 1000;

export const isTeamnChatConfigured = () => Boolean(String(process.env.TEAMN_CHAT_KEY || '').trim());

/// Digits only with country code. A bare 10-digit Indian number (or one with
/// a leading 0) gets 91; anything else keeps the country code it was typed with.
export const toWhatsAppPhone = (raw) => {
  let d = String(raw ?? '').replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  if (d.length === 10) d = `91${d}`;
  return d;
};

const authHeaders = () => ({ Authorization: `Bearer ${String(process.env.TEAMN_CHAT_KEY).trim()}` });

// TeamN Chat always answers JSON with { ok, error? }. Anything else (proxy page,
// network failure, timeout) is turned into the same shape so callers have one path.
const call = async (path, init) => {
  if (!isTeamnChatConfigured()) {
    return { status: 503, body: { ok: false, error: 'WhatsApp is not connected yet — TEAMN_CHAT_KEY is missing on the server.' } };
  }
  try {
    const res = await fetch(`${baseUrl()}${path}`, {
      ...init,
      headers: { ...authHeaders(), ...(init?.headers || {}) },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    let body;
    try {
      body = await res.json();
    } catch (_) {
      body = { ok: false, error: `TeamN Chat answered HTTP ${res.status} without a readable reply.` };
    }
    if (body?.ok !== true && !body?.error) body = { ...body, ok: false, error: `TeamN Chat answered HTTP ${res.status}.` };
    return { status: res.status, body };
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return {
      status: 504,
      body: {
        ok: false,
        error: timedOut
          ? 'TeamN Chat did not answer in time. Check TeamN Chat before trying again — it may already have gone through.'
          : `Could not reach TeamN Chat (${err?.message || 'network error'}).`,
      },
    };
  }
};

export const pingTeamnChat = () => call('/api/integrations/ping', { method: 'GET' });

/**
 * Sends one PDF. mode 'handover' → waits in the customer's chat for staff
 * (/documents); mode 'send' → delivered to the customer at once (/send-document).
 * `channel` is never sent — TeamN Chat picks the WhatsApp number itself.
 */
export const sendTeamnChatDocument = (mode, { pdf, filename, phone, kind, reference, customerName, bookingDate, sentBy }) => {
  const form = new FormData();
  form.append('phone', phone);
  form.append('kind', kind);
  if (reference) form.append('reference', reference);
  if (customerName) form.append('customer_name', customerName);
  if (bookingDate) form.append('booking_date', bookingDate);
  if (sentBy) form.append('sent_by', sentBy);
  form.append('filename', filename);
  form.append('file', new Blob([pdf], { type: 'application/pdf' }), filename);
  const path = mode === 'send' ? '/api/integrations/send-document' : '/api/integrations/documents';
  return call(path, { method: 'POST', body: form });
};
