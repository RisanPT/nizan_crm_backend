// Pure rules (no database) for the website's own visitor counter.
// Only anonymous data: random browser/visit ids, page path, traffic source, device type.

export const VISIT_RETENTION_DAYS = 90;
export const STATS_RANGES = [7, 30, 90];

const ID_RE = /^[a-z0-9-]{8,40}$/i;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001F\u007F]/g;

// Crawlers, link previews and test tools — not people.
const BOT_RE =
  /bot|crawl|spider|slurp|scrap|headless|lighthouse|pagespeed|preview|facebookexternalhit|embedly|curl|wget|python|java\/|go-http|axios|node-fetch|^whatsapp\//i;

export const isBot = (ua) => !ua || BOT_RE.test(String(ua));

export const deviceFromUa = (ua) => {
  const s = String(ua || '');
  if (/ipad|tablet|kindle|silk|(android(?!.*mobile))/i.test(s)) return 'tablet';
  if (/mobi|iphone|ipod|android|blackberry|opera mini|iemobile/i.test(s)) return 'mobile';
  return 'desktop';
};

const clean = (v, max) => {
  const s = String(v ?? '').replace(CONTROL, '').trim();
  return s.slice(0, max);
};

// Referrer host → a friendly source name.
const KNOWN_HOSTS = [
  [/(^|\.)google\./, 'google'],
  [/(^|\.)bing\.com$/, 'bing'],
  [/(^|\.)instagram\.com$/, 'instagram'],
  [/(^|\.)(facebook\.com|fb\.com|fb\.me)$/, 'facebook'],
  [/(^|\.)(whatsapp\.com|wa\.me)$/, 'whatsapp'],
  [/(^|\.)(youtube\.com|youtu\.be)$/, 'youtube'],
  [/(^|\.)(t\.co|twitter\.com|x\.com)$/, 'twitter'],
  [/(^|\.)linkedin\.com$/, 'linkedin'],
  [/(^|\.)pinterest\./, 'pinterest'],
  [/(^|\.)(duckduckgo\.com|yahoo\.com)$/, 'search'],
];

/** Where a visit came from: utm_source wins, then the referrer host, else "direct". */
export const classifySource = ({ utmSource = '', refHost = '', siteHost = '' } = {}) => {
  const utm = clean(utmSource, 40).toLowerCase();
  if (utm) {
    for (const [, name] of KNOWN_HOSTS) if (utm.includes(name)) return name;
    if (utm === 'ig') return 'instagram';
    if (utm === 'fb') return 'facebook';
    return utm;
  }
  const host = clean(refHost, 120).toLowerCase().replace(/^www\./, '');
  if (!host) return 'direct';
  if (siteHost && host === String(siteHost).toLowerCase().replace(/^www\./, '')) return 'direct';
  for (const [re, name] of KNOWN_HOSTS) if (re.test(host)) return name;
  return host;
};

/**
 * Checks a page-view ping from the website.
 * body: { vid, sid, path, refHost?, utm?: { source, medium, campaign }, newVisitor? }
 * → { ok: false } or { ok: true, value } ready to store (day/device added by the caller).
 */
export function validateVisit(body) {
  const b = body && typeof body === 'object' ? body : {};
  const vid = String(b.vid ?? '');
  const sid = String(b.sid ?? '');
  if (!ID_RE.test(vid) || !ID_RE.test(sid)) return { ok: false };

  // Path only — never the query string (it can hold preview tokens or personal data).
  let path = clean(b.path, 200).split(/[?#]/)[0] || '/';
  if (!path.startsWith('/')) return { ok: false };
  path = path.replace(/\/{2,}/g, '/');
  if (path.length > 1) path = path.replace(/\/$/, '');

  const utm = b.utm && typeof b.utm === 'object' ? b.utm : {};
  return {
    ok: true,
    value: {
      vid,
      sid,
      path,
      source: classifySource({ utmSource: utm.source, refHost: b.refHost, siteHost: b.siteHost }),
      medium: clean(utm.medium, 40).toLowerCase(),
      campaign: clean(utm.campaign, 80),
      newVisitor: b.newVisitor === true,
    },
  };
}

/** ?days=7|30|90 → a whole number of days (default 30). */
export const parseRange = (v) => {
  const n = Number.parseInt(v, 10);
  return STATS_RANGES.includes(n) ? n : 30;
};

const pct = (part, whole) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0);

/**
 * Shapes the $facet result into the dashboard response.
 *   facet     first document of WebsiteVisit.aggregate([...$facet])
 *   days      ordered list of 'YYYY-MM-DD' in the range (oldest first)
 *   today     'YYYY-MM-DD'
 *   enquiries { booking, contact } counts in the same range
 */
export function buildVisitorStats({ facet = {}, days = [], today = '', enquiries = {} } = {}) {
  const first = (arr) => (Array.isArray(arr) && arr[0]) || {};
  const totals = first(facet.totals);
  const todayRow = first(facet.today);
  const byDay = new Map((facet.daily || []).map((d) => [d._id, d]));
  const visitors = totals.visitors || 0;
  const booking = enquiries.booking || 0;
  const contact = enquiries.contact || 0;

  const list = (rows, key = 'name') =>
    (rows || []).map((r) => ({ [key]: r._id || (key === 'path' ? '/' : 'direct'), views: r.views || 0, visitors: r.visitors || 0 }));

  return {
    range: { from: days[0] || today, to: days[days.length - 1] || today, days: days.length },
    totals: {
      visitors,
      newVisitors: totals.newVisitors || 0,
      visits: totals.visits || 0,
      pageViews: totals.pageViews || 0,
      pagesPerVisit: totals.visits ? Math.round((totals.pageViews / totals.visits) * 10) / 10 : 0,
    },
    today: { visitors: todayRow.visitors || 0, pageViews: todayRow.pageViews || 0 },
    enquiries: {
      booking,
      contact,
      // Share of visitors who sent a booking request / any enquiry.
      bookingRate: pct(booking, visitors),
      enquiryRate: pct(booking + contact, visitors),
    },
    daily: days.map((day) => {
      const d = byDay.get(day) || {};
      return { day, visitors: d.visitors || 0, pageViews: d.pageViews || 0 };
    }),
    pages: list(facet.pages, 'path'),
    sources: list(facet.sources),
    devices: list(facet.devices),
    retentionDays: VISIT_RETENTION_DAYS,
  };
}
