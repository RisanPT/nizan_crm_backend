// Meta Lead Ads → CRM leads: the pure rules (no database, no network). services/metaLeads.js does the work.
//
// How a lead travels: a bride fills a Lead Ads form on Facebook / Instagram → Meta calls POST /api/meta/webhook with the lead's id
// (never the answers) → we check Meta's signature, note the id, answer 200 at once → we fetch the answers from the Graph API and make
// a CRM lead (or, when her number is already a lead, note on that lead that she came again).
//
// Settings come from the server's environment, never from the app (the token can read every lead):
//   META_APP_SECRET            the Meta app's secret: checks the webhook's signature and signs our Graph calls (appsecret_proof)
//   META_ACCESS_TOKEN          a system-user (or Page) token with leads_retrieval + pages_show_list + pages_read_engagement
//   META_WEBHOOK_VERIFY_TOKEN  any long random text, typed into Meta's webhook setup too
//   META_GRAPH_VERSION         optional, e.g. v25.0 (Meta refuses calls without a version)
//   META_PAGE_IDS              optional, comma-separated Facebook Page ids for "Check for missed leads" (pages that send a lead are
//                              remembered on their own)
import crypto from 'node:crypto';

export const META_GRAPH_VERSION_DEFAULT = 'v25.0';
export const META_LEAD_SOURCE = 'Paid Ads Leads'; // the CRM's own source for ad leads (sourceKeyOf → meta_ads; the app's kLeadSources)
export const META_LEAD_BY = 'Meta Lead Ads'; // createdByName of a lead made from a form
export const META_MAX_ATTEMPTS = 6;
export const META_CHECK_MAX_DAYS = 90; // Meta keeps a form's leads for 90 days

const trim = (v) => String(v ?? '').trim();
const isGraphId = (v) => /^\d{1,30}$/.test(trim(v));

/** What the environment provides. `ready` = leads can be received and fetched. Never returns the secrets themselves. */
export const metaConfig = (env = process.env) => {
  const appSecret = trim(env.META_APP_SECRET);
  const token = trim(env.META_ACCESS_TOKEN);
  const verifyToken = trim(env.META_WEBHOOK_VERIFY_TOKEN);
  const v = trim(env.META_GRAPH_VERSION);
  const version = /^v\d{1,3}\.\d{1,2}$/.test(v) ? v : META_GRAPH_VERSION_DEFAULT;
  const pageIds = trim(env.META_PAGE_IDS).split(/[\s,]+/).filter(isGraphId);
  return {
    appSecret,
    token,
    verifyToken,
    version,
    pageIds,
    has: { appSecret: !!appSecret, token: !!token, verifyToken: !!verifyToken },
    ready: !!(appSecret && token && verifyToken),
  };
};

/** Meta signs each webhook body with the app secret: header `X-Hub-Signature-256: sha256=<hex>`. Compared in constant time. */
export const verifyMetaSignature = (rawBody, header, appSecret) => {
  if (!appSecret || !Buffer.isBuffer(rawBody)) return false;
  const m = /^sha256=([0-9a-f]{64})$/i.exec(trim(header));
  if (!m) return false;
  const want = crypto.createHmac('sha256', appSecret).update(rawBody).digest();
  const got = Buffer.from(m[1], 'hex');
  return got.length === want.length && crypto.timingSafeEqual(got, want);
};

/** The proof Meta accepts beside a token, so a stolen token alone cannot be used from elsewhere. */
export const appSecretProof = (token, appSecret) => crypto.createHmac('sha256', appSecret).update(token).digest('hex');

/** The new leads in one webhook body: [{leadgenId, pageId, formId, adId, adsetId, createdTime}]. Anything else is ignored. */
export const readLeadgenChanges = (body) => {
  if (!body || body.object !== 'page' || !Array.isArray(body.entry)) return [];
  const out = [];
  const seen = new Set();
  for (const entry of body.entry) {
    for (const change of Array.isArray(entry?.changes) ? entry.changes : []) {
      if (change?.field !== 'leadgen') continue;
      const v = change.value ?? {};
      const leadgenId = trim(v.leadgen_id);
      if (!isGraphId(leadgenId) || seen.has(leadgenId)) continue;
      seen.add(leadgenId);
      const t = Number(v.created_time);
      out.push({
        leadgenId,
        pageId: isGraphId(v.page_id) ? trim(v.page_id) : isGraphId(entry.id) ? trim(entry.id) : '',
        formId: isGraphId(v.form_id) ? trim(v.form_id) : '',
        adId: isGraphId(v.ad_id) ? trim(v.ad_id) : '',
        adsetId: isGraphId(v.adgroup_id) ? trim(v.adgroup_id) : '',
        createdTime: Number.isFinite(t) && t > 0 ? new Date(t * 1000) : null,
      });
    }
  }
  return out;
};

// ── the form's answers ──────────────────────────────────────────────────────

/** Meta's field_data → [{key, value}]: one value per question (several picked options joined). */
export const answersOf = (fieldData) =>
  (Array.isArray(fieldData) ? fieldData : [])
    .map((f) => ({
      key: trim(f?.name).toLowerCase(),
      value: (Array.isArray(f?.values) ? f.values : [f?.values]).map(trim).filter(Boolean).join(', '),
    }))
    .filter((a) => a.key && a.value);

/** "when_is_your_wedding?" → "When is your wedding" — how an unmapped question is written into the lead's remarks. */
export const questionLabel = (key) => {
  const s = trim(key).replace(/[_?]+/g, ' ').replace(/\s+/g, ' ').trim();
  return s ? s[0].toUpperCase() + s.slice(1) : '';
};

const pick = (answers, test) => answers.find((a) => test(a.key));
const keyIs = (...names) => (k) => names.includes(k);
const keyHas = (...parts) => (k) => parts.some((p) => k.includes(p));

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const IST_MS = 330 * 60 * 1000;
const istToday = (now) => {
  const d = new Date(now.getTime() + IST_MS);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
};
/** IST midnight of y-m-d as an instant (how the app stores a date-only value), or null when no such day. */
const istMidnight = (y, m, d) => {
  const t = Date.UTC(y, m - 1, d);
  const back = new Date(t);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== m - 1 || back.getUTCDate() !== d) return null;
  return new Date(t - IST_MS);
};

/**
 * A date typed or picked in a form → the IST day as a Date, or null when it cannot be read for certain or is not a coming event
 * (yesterday or earlier, or more than 3 years away): the answer then stays in the remarks for Sales to read.
 * Indian order (day first): 15/12/2026, 15-12-2026, 15.12.2026; ISO 2026-12-15; 15 Dec 2026; Dec 15, 2026; without a year → the next one.
 */
export const parseFormDate = (text, now = new Date()) => {
  const s = trim(text).toLowerCase().replace(/(\d)(st|nd|rd|th)\b/g, '$1').replace(/,/g, ' ').replace(/\s+/g, ' ');
  if (!s) return null;
  let y = null;
  let m = null;
  let d = null;
  let iso = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[t ].*)?$/.exec(s);
  if (iso) [y, m, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
  else if ((iso = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/.exec(s))) {
    [d, m, y] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
    if (y < 100) y += 2000;
  } else {
    const mi = (w) => MONTHS.indexOf(String(w).slice(0, 3));
    let t = /^(\d{1,2}) ([a-z]+)(?: (\d{4}))?$/.exec(s);
    if (t && mi(t[2]) >= 0) [d, m, y] = [Number(t[1]), mi(t[2]) + 1, t[3] ? Number(t[3]) : null];
    else if ((t = /^([a-z]+) (\d{1,2})(?: (\d{4}))?$/.exec(s)) && mi(t[1]) >= 0) [m, d, y] = [mi(t[1]) + 1, Number(t[2]), t[3] ? Number(t[3]) : null];
    else return null;
  }
  const today = istToday(now);
  if (y == null) {
    const n = new Date(today);
    y = n.getUTCFullYear();
    const cand = istMidnight(y, m, d);
    if (cand && cand.getTime() + IST_MS < today) y += 1;
  }
  const out = istMidnight(y, m, d);
  if (!out) return null;
  const day = out.getTime() + IST_MS;
  if (day < today || day > today + 3 * 366 * 864e5) return null;
  return out;
};

/**
 * The form's answers → the lead's fields. Meta's standard questions have fixed keys (full_name, phone_number, email, city, zip_code…);
 * our own questions are recognised by their words (date / wedding → the event date, event / occasion → the event type). Every answer
 * that fills no field — and one that was recognised but could not be used, such as an unreadable date — is returned in `extra`, so
 * the remarks keep it.
 */
export const mapAnswers = (answers, now = new Date()) => {
  const used = new Set();
  const take = (a) => {
    if (a) used.add(a.key);
    return a?.value ?? '';
  };
  const first = take(pick(answers, keyIs('first_name')));
  const last = take(pick(answers, keyIs('last_name')));
  const full = take(pick(answers, keyIs('full_name', 'name', 'your_name')));
  const name = (full || [first, last].filter(Boolean).join(' ')).slice(0, 120);
  const phone = take(pick(answers, keyIs('phone_number', 'phone', 'mobile', 'mobile_number', 'contact_number')));
  const whatsappA = pick(answers, keyHas('whatsapp'));
  const whatsapp = take(whatsappA);
  const email = take(pick(answers, keyIs('email', 'work_email', 'email_address')));
  const pinA = pick(answers, keyIs('zip_code', 'post_code', 'postal_code', 'zip', 'pincode', 'pin_code'));
  const pinRaw = take(pinA);
  const pincode = /^\d{6}$/.test(pinRaw.replace(/\s+/g, '')) ? pinRaw.replace(/\s+/g, '') : '';
  const placeParts = [
    take(pick(answers, keyIs('street_address'))),
    take(pick(answers, keyIs('city', 'location', 'place', 'venue', 'your_location'))),
    take(pick(answers, keyIs('state', 'province'))),
  ].filter(Boolean);
  const country = take(pick(answers, keyIs('country')));
  if (country && !/^(in|india)$/i.test(country)) placeParts.push(country);
  const location = placeParts.join(', ').slice(0, 200);
  const typeA = pick(answers, (k) => !used.has(k) && /(event_?type|occasion|function_?type|type_of_(event|function)|service)/.test(k));
  const eventType = take(typeA).slice(0, 80);
  const dateA = pick(answers, (k) => !used.has(k) && /(date|wedding|when|function|event|marriage)/.test(k));
  const dateText = dateA?.value ?? '';
  const probableDate = dateA ? parseFormDate(dateText, now) : null;
  if (dateA && probableDate) used.add(dateA.key);

  const extra = answers.filter((a) => !used.has(a.key)).map((a) => ({ key: a.key, label: questionLabel(a.key), value: a.value }));
  if (pinRaw && !pincode) extra.push({ key: pinA.key, label: 'Pincode (not a 6-digit pincode)', value: pinRaw });
  return { name, phone: phone.replace(/\s+/g, ''), whatsapp: whatsapp.replace(/\s+/g, ''), email, pincode, location, eventType, probableDate, extra };
};

/** Enough digits to be a phone number at all (a foreign number may be shorter than India's 10). */
export const usablePhone = (phone) => String(phone ?? '').replace(/\D/g, '').length >= 8;

/** The remarks a Meta lead starts with: where it came from, then every answer not already a field. */
export const remarksFor = ({ formName, adName, campaignName, platform, isOrganic, extra = [], notes = [] }) => {
  const where = isOrganic ? 'Meta form (no ad)' : 'Meta Lead Ads';
  const on = platform === 'ig' ? ' on Instagram' : platform === 'fb' ? ' on Facebook' : '';
  const lines = [`${where}${on}${formName ? ` · form "${formName}"` : ''}${adName ? ` · ad "${adName}"` : ''}${campaignName ? ` · campaign "${campaignName}"` : ''}`];
  for (const a of extra) lines.push(`${a.label}: ${a.value}`);
  for (const n of notes) lines.push(n);
  return lines.join('\n').slice(0, 2000);
};

// ── Graph API answers ──────────────────────────────────────────────────────

/** Why a Graph call failed, in words the Marketing team can act on, and whether trying again later can help. */
export const META_PROBLEMS = {
  token: { retry: true, text: 'Meta refused the access token (expired, changed or withdrawn). Make a new system-user token and put it in META_ACCESS_TOKEN on the server.' },
  permission: { retry: true, text: 'The token may not read this lead. Give the system user the Page and the leads_retrieval permission (and finish App Review).' },
  rate_limit: { retry: true, text: 'Meta asked us to slow down. It will be tried again shortly.' },
  missing: { retry: false, text: 'Meta no longer has this lead (it was deleted, or is older than 90 days).' },
  meta_down: { retry: true, text: 'Meta had a problem answering. It will be tried again shortly.' },
  unreachable: { retry: true, text: 'Our server could not reach Meta. It will be tried again shortly.' },
  refused: { retry: true, text: 'Meta refused the request.' },
  no_phone: { retry: false, text: 'The form had no phone number, so no CRM lead could be made. Call or e-mail her from the details shown.' },
  not_configured: { retry: true, text: 'The Meta settings are missing on the server (META_APP_SECRET, META_ACCESS_TOKEN, META_WEBHOOK_VERIFY_TOKEN).' },
  save_failed: { retry: true, text: 'The lead could not be saved in the CRM. It will be tried again.' },
};

export const problem = (code, detail = '') => {
  const p = META_PROBLEMS[code] ?? META_PROBLEMS.refused;
  return { code: META_PROBLEMS[code] ? code : 'refused', retry: p.retry, text: detail ? `${p.text} (${detail})` : p.text };
};

/** A failed Graph answer (HTTP status + Meta's `{error:{code, error_subcode, message}}`) → a problem. */
export const classifyGraphError = (status, body) => {
  const e = body?.error ?? {};
  const code = Number(e.code);
  const sub = Number(e.error_subcode);
  const detail = trim(e.message).slice(0, 200);
  if (code === 190 || code === 102 || [458, 459, 460, 463, 464, 467].includes(sub)) return problem('token', detail);
  if ([4, 17, 32, 613, 80001, 80004].includes(code) || status === 429) return problem('rate_limit');
  if (code === 100 && sub === 33) return problem('missing', detail);
  if (code === 10 || code === 3 || (code >= 200 && code < 300) || status === 403) return problem('permission', detail);
  if (status >= 500 || code === 1 || code === 2) return problem('meta_down', detail);
  return problem('refused', detail);
};

/** The next try of a failed lead: 5 min, 10, 20, 40… capped at 6 hours; null when it should not be tried again. */
export const nextTryAt = (attempts, now = new Date(), retry = true) => {
  if (!retry || attempts >= META_MAX_ATTEMPTS) return null;
  const minutes = Math.min(5 * 2 ** Math.max(0, attempts - 1), 360);
  return new Date(now.getTime() + minutes * 60 * 1000);
};

/** "Take turns": the person whose turn [counter] (1, 2, 3…) is among [ids]; null when there is nobody. */
export const turnOf = (ids, counter) => (ids.length ? ids[(((counter - 1) % ids.length) + ids.length) % ids.length] : null);

/** The "Check for missed leads" window: a whole number of days, 1–90 (default 7). */
export const checkDays = (v) => {
  const n = Number(v ?? 7);
  return Number.isInteger(n) && n >= 1 && n <= META_CHECK_MAX_DAYS ? n : null;
};

/** Graph's next-page links are followed only on Meta's own Graph host. */
export const isGraphUrl = (url) => {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.hostname === 'graph.facebook.com';
  } catch {
    return false;
  }
};
