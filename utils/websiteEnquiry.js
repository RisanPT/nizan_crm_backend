// Pure rules (no database) for enquiries sent from the public website.
import crypto from 'crypto';

export const ENQUIRY_TYPES = ['booking', 'contact'];
export const ENQUIRY_STATUSES = ['new', 'contacted', 'closed', 'spam'];
export const WEBSITE_LEAD_SOURCE = 'Website';
// A form sent faster than this after it was shown is almost certainly a bot.
export const MIN_FILL_MS = 3000;

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;
const SLOTS = {
  morning: 'Morning',
  day: 'Church Wedding / Daytime', // older website versions
  evening: 'Evening',
  fullday: 'Full Day Multi-Event Coverage',
};

const text = (v, max, { multiline = false } = {}) => {
  let s = String(v ?? '').replace(CONTROL, '');
  if (!multiline) s = s.replace(/\s+/g, ' ');
  s = s.trim();
  return s.length > max ? null : s; // null = too long
};

export const phoneDigits = (v) => String(v ?? '').replace(/\D/g, '');
export const last10 = (v) => phoneDigits(v).slice(-10);

// Visitor IPs are stored only as a salted hash: enough to spot abuse, not to identify anyone.
export const hashIp = (ip, secret = '') =>
  crypto.createHash('sha256').update(`${secret}:${ip}`).digest('hex').slice(0, 32);

/**
 * Validates a website enquiry body.
 * → { ok, spam, value, errors }  — `spam: true` means accept quietly but do nothing.
 */
export function validateEnquiry(body = {}, { todayIso, now = Date.now() } = {}) {
  const errors = [];
  const b = body && typeof body === 'object' ? body : {};

  // Bots fill every field (honeypot "company") or submit instantly.
  const startedAt = Number(b.startedAt);
  const spam =
    Boolean(String(b.company ?? '').trim()) ||
    (Number.isFinite(startedAt) && startedAt > 0 && now - startedAt < MIN_FILL_MS);

  const type = ENQUIRY_TYPES.includes(b.type) ? b.type : 'contact';
  const name = text(b.name, 80);
  const phone = text(b.phone, 20);
  const email = text(b.email, 120);
  const venue = text(b.venue, 120);
  const message = text(b.message, 1000, { multiline: true });

  if (!name || name.length < 2) errors.push(name === null ? 'Name is too long.' : 'Please enter your name.');
  const digits = phoneDigits(phone);
  if (!phone || digits.length < 10 || digits.length > 15) errors.push('Please enter a valid phone number.');
  if (email === null || (email && !EMAIL_RE.test(email))) errors.push('Please enter a valid email address.');
  if (venue === null) errors.push('Venue is too long.');
  if (message === null) errors.push('Message is too long (max 1000 characters).');

  let eventDate = null;
  if (b.eventDate) {
    if (!DAY_RE.test(String(b.eventDate))) errors.push('Wedding date is not valid.');
    else if (todayIso && b.eventDate < todayIso) errors.push('Wedding date is in the past.');
    else eventDate = String(b.eventDate);
  }

  const slot = Object.prototype.hasOwnProperty.call(SLOTS, b.slot) ? b.slot : '';
  const packageId = OBJECT_ID_RE.test(String(b.packageId ?? '')) ? String(b.packageId) : null;
  const districtId = OBJECT_ID_RE.test(String(b.districtId ?? '')) ? String(b.districtId) : null;
  const addonIds = Array.isArray(b.addonIds)
    ? [...new Set(b.addonIds.map(String).filter((id) => OBJECT_ID_RE.test(id)))].slice(0, 10)
    : [];

  const utm = {};
  for (const k of ['source', 'medium', 'campaign']) {
    const v = text(b.utm?.[k], 80);
    if (v) utm[k] = v;
  }

  return {
    ok: errors.length === 0,
    spam,
    errors,
    value: {
      type,
      name: name || '',
      phone: phone || '',
      email: email || '',
      venue: venue || '',
      message: message || '',
      eventDate,
      slot,
      slotLabel: SLOTS[slot] || '',
      packageId,
      districtId,
      addonIds,
      utm,
      page: text(b.page, 120) || '',
    },
  };
}

/** The remarks text staff see on the Lead. */
const inr = (n) => `₹${Number(n || 0).toLocaleString('en-IN')}`;

export function leadRemarks(e, { packageName = '', addonNames = [], location = null, quotedTotal = null } = {}) {
  return [
    `Website ${e.type === 'booking' ? 'booking request' : 'enquiry'}`,
    e.eventDate && `Wedding date: ${e.eventDate}`,
    e.slotLabel && `Slot: ${e.slotLabel}`,
    location?.district && `Location: ${location.district}${location.region ? `, ${location.region}` : ''}`,
    packageName && `Package: ${packageName}`,
    addonNames.length && `Add-ons: ${addonNames.join(', ')}`,
    quotedTotal != null && `Website total shown: ${inr(quotedTotal)} (CRM prices for this location)`,
    e.venue && `Venue: ${e.venue}`,
    e.email && `Email: ${e.email}`,
    e.message && `Message: ${e.message}`,
    Object.keys(e.utm || {}).length && `Ad/UTM: ${Object.entries(e.utm).map(([k, v]) => `${k}=${v}`).join(', ')}`,
  ]
    .filter(Boolean)
    .join('\n');
}

/** Fields for a NEW Lead created from a website enquiry. */
export function leadFromEnquiry(e, extras = {}) {
  return {
    name: e.name,
    phone: e.phone,
    email: e.email || undefined,
    source: WEBSITE_LEAD_SOURCE,
    location: e.venue,
    eventType: e.type === 'booking' ? 'Wedding' : '',
    eventDate: e.eventDate ? new Date(`${e.eventDate}T00:00:00+05:30`) : null,
    enquiryDate: new Date(),
    leadDate: new Date(),
    status: 'New',
    remarks: leadRemarks(e, extras),
    ...(extras.location?.districtId
      ? {
          districtId: extras.location.districtId,
          regionId: extras.location.regionId || null,
          district: extras.location.district || '',
          region: extras.location.region || '',
        }
      : {}),
    createdByName: 'Website',
    auditLog: [{ action: 'created_from_website', byName: 'Website', note: e.type }],
  };
}
