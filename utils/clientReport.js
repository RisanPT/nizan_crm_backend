// The stylist's client report (PDF): who the client is, the look agreed so
// far, and every completed call with what was discussed and the client's
// reference images. One neutral header for both companies.
//
// buildClientReportHtml is pure — no database, no network — so it is tested
// offline (tests/clientReport.test.js). Images arrive already embedded as
// data: URIs because the PDF renderer (utils/htmlToPdf.js) refuses every
// network request.

// The after-call sections, in the order the app shows them
// (Nizan_crm/lib/features/consultations/presentation/widgets/consultation_ui.dart).
export const REPORT_SECTIONS = [
  ['preferences', "Client's requirements"],
  ['conveyed', 'What we conveyed'],
  ['lookMakeup', 'Makeup look'],
  ['lookHair', 'Hairstyle'],
  ['lookOutfit', 'Outfit and jewellery'],
  ['skinNotes', 'Skin and allergy notes'],
  ['nextSteps', 'Next steps'],
  ['notes', 'Other notes'],
];

// Shown together at the top as "the agreed look": the latest value of each.
const LOOK_FIELDS = ['lookMakeup', 'lookHair', 'lookOutfit', 'skinNotes'];

const IST_DAY = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric' });
const IST_TIME = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit', hour12: true });

export const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/// Text with its line breaks kept.
const para = (s) => esc(s).replace(/\r?\n/g, '<br>');

const fmtDay = (d) => (d ? IST_DAY.format(new Date(d)) : '');
const fmtTime = (d) => (d ? IST_TIME.format(new Date(d)).toUpperCase() : '');

/// 'YYYY-MM-DD' (IST day) → "14 Dec 2026".
const fmtDayKey = (k) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(k ?? ''));
  return m ? IST_DAY.format(new Date(`${k}T12:00:00+05:30`)) : '';
};

const callTitle = (call, requiredCalls) => {
  const n = call.callNumber;
  if (!n) return 'Call';
  return n <= requiredCalls ? `Call ${n} of ${requiredCalls}` : `Extra call ${n}`;
};

/// The latest non-empty value of each look field across completed calls
/// (oldest → newest), so later decisions replace earlier ones.
export const agreedLook = (calls) => {
  const look = {};
  for (const c of calls) {
    for (const f of LOOK_FIELDS) {
      const v = String(c[f] ?? '').trim();
      if (v) look[f] = v;
    }
  }
  return look;
};

const labelOf = (key) => REPORT_SECTIONS.find(([k]) => k === key)?.[1] ?? key;

/**
 * @param {object} p
 * @param {object} p.client     the client file (plain object, stylistId populated or not)
 * @param {object[]} p.calls    the client's calls, oldest first; each with `canRead`
 *                              (false = notes hidden from this user) and full notes fields
 * @param {Map<string,string>} p.images  image url → data: URI (missing = not embedded)
 * @param {string} p.generatedBy
 * @param {Date} p.generatedAt
 * @returns {string} a complete HTML document
 */
export const buildClientReportHtml = ({ client, calls, images = new Map(), generatedBy = '', generatedAt = new Date() }) => {
  const required = client.requiredCalls || 4;
  const completed = calls.filter((c) => c.status === 'Completed');
  const upcoming = calls.filter((c) => c.status === 'Scheduled' && new Date(c.scheduledAt) >= generatedAt);
  const readable = completed.filter((c) => c.canRead);
  const look = agreedLook(readable);

  const eventDays = (client.eventDates ?? []).map(fmtDayKey).filter(Boolean);
  const details = [
    ['Company', client.company],
    ['Phone', client.phone],
    ['Alternate phone', client.altPhone],
    ['Email', client.email],
    ['Event', client.eventType],
    ['Event dates', eventDays.join(', ')],
    ['Time slot', client.eventSlot],
    ['Venue', client.venue],
    ['District', client.district],
    ['Culture', client.culture],
    ['Package', client.packageName],
    ['Booking no.', client.bookingNumber],
    ['Artists', (client.artistNames ?? []).join(', ')],
    ['Stylist', client.stylistId?.name ?? ''],
    ['Client no.', client.clientNo],
  ].filter(([, v]) => String(v ?? '').trim());

  const detailRows = details
    .map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`)
    .join('');

  const wide = [
    ['Outfit details', client.outfitDetails],
    ['Notes about the client', client.notes],
  ]
    .filter(([, v]) => String(v ?? '').trim())
    .map(([k, v]) => `<div class="block"><div class="label">${esc(k)}</div><div>${para(v)}</div></div>`)
    .join('');

  const lookHtml = Object.keys(look).length
    ? `<section class="look"><h2>Agreed look so far</h2>${LOOK_FIELDS.filter((f) => look[f])
        .map((f) => `<div class="block"><div class="label">${esc(labelOf(f))}</div><div>${para(look[f])}</div></div>`)
        .join('')}</section>`
    : '';

  const imageHtml = (imgs) => {
    if (!imgs?.length) return '';
    const cells = imgs
      .map((img) => {
        const src = images.get(img.url);
        const caption = img.caption ? `<figcaption>${esc(img.caption)}</figcaption>` : '';
        return src
          ? `<figure><img src="${esc(src)}" alt="${esc(img.caption || 'Reference image')}">${caption}</figure>`
          : `<figure class="missing"><div class="ph">Image not available</div>${caption}</figure>`;
      })
      .join('');
    return `<div class="label">Reference images (${imgs.length})</div><div class="grid">${cells}</div>`;
  };

  const callsHtml = completed.length
    ? completed
        .map((c) => {
          const head = `<div class="call-head"><span class="call-no">${esc(callTitle(c, required))}</span>
            <span>${esc(fmtDay(c.scheduledAt))}, ${esc(fmtTime(c.scheduledAt))}</span>
            <span>${esc(c.mode === 'In-person' ? 'In person' : 'Video')}</span>
            ${c.stylistId?.name ? `<span>${esc(c.stylistId.name)}</span>` : ''}</div>`;
          if (!c.canRead) {
            return `<section class="call">${head}<p class="muted">The details of this call are only visible to its stylist.</p></section>`;
          }
          const sections = REPORT_SECTIONS.filter(([k]) => String(c[k] ?? '').trim())
            .map(([k, label]) => `<div class="block"><div class="label">${esc(label)}</div><div>${para(c[k])}</div></div>`)
            .join('');
          const body = sections || (c.referenceImages?.length ? '' : '<p class="muted">Nothing was recorded for this call.</p>');
          return `<section class="call">${head}${body}${imageHtml(c.referenceImages)}</section>`;
        })
        .join('')
    : '<p class="muted">No calls have been completed yet.</p>';

  const upcomingHtml = upcoming.length
    ? `<section><h2>Upcoming calls</h2><ul>${upcoming
        .map((c) => `<li>${esc(callTitle(c, required))} · ${esc(fmtDay(c.scheduledAt))}, ${esc(fmtTime(c.scheduledAt))}</li>`)
        .join('')}</ul></section>`
    : '';

  const subtitle = [client.eventType, eventDays.length ? eventDays.join(', ') : '', client.venue]
    .filter(Boolean)
    .map(esc)
    .join(' · ');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Client report – ${esc(client.name)}</title>
<style>
  * { box-sizing: border-box; }
  html, body { background: #fff; }
  body { font-family: "Segoe UI", Roboto, Arial, sans-serif; color: #1c1a19; font-size: 11.5pt; line-height: 1.45; margin: 0; }
  header { border-bottom: 2px solid #1c1a19; padding-bottom: 10px; margin-bottom: 14px; display: flex; justify-content: space-between; align-items: flex-end; gap: 16px; }
  .kicker { font-size: 9pt; letter-spacing: .08em; text-transform: uppercase; color: #6b625b; }
  h1 { font-size: 20pt; margin: 2px 0 2px; }
  .sub { color: #4a433e; }
  .meta { text-align: right; font-size: 9pt; color: #6b625b; white-space: nowrap; }
  h2 { font-size: 12.5pt; margin: 18px 0 8px; border-bottom: 1px solid #d8d1c8; padding-bottom: 3px; }
  table.details { width: 100%; border-collapse: collapse; }
  table.details th { text-align: left; width: 28%; color: #6b625b; font-weight: 500; padding: 3px 8px 3px 0; vertical-align: top; }
  table.details td { padding: 3px 0; }
  .block { margin: 8px 0; page-break-inside: avoid; }
  .label { font-size: 9pt; color: #6b625b; text-transform: uppercase; letter-spacing: .04em; margin-bottom: 2px; }
  .look { border: 1px solid #d8d1c8; border-radius: 6px; padding: 4px 12px 8px; margin-top: 14px; }
  .look h2 { border: 0; margin-top: 8px; }
  .call { border-top: 1px solid #d8d1c8; padding-top: 8px; margin-top: 12px; }
  h2 + .call { border-top: 0; padding-top: 0; margin-top: 0; }
  .call-head { display: flex; flex-wrap: wrap; gap: 4px 14px; font-size: 10pt; color: #4a433e; margin-bottom: 4px; }
  .call-no { font-weight: 700; color: #1c1a19; }
  .grid { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 4px; }
  figure { margin: 0; width: 31%; page-break-inside: avoid; }
  figure img { width: 100%; height: 170px; object-fit: cover; border-radius: 4px; border: 1px solid #d8d1c8; }
  figcaption { font-size: 9pt; color: #4a433e; margin-top: 2px; }
  .ph { height: 170px; border: 1px dashed #b9b0a6; border-radius: 4px; display: flex; align-items: center; justify-content: center; color: #8c837b; font-size: 9pt; }
  .muted { color: #8c837b; }
  ul { margin: 4px 0 0 18px; padding: 0; }
  footer { margin-top: 22px; font-size: 8.5pt; color: #8c837b; border-top: 1px solid #d8d1c8; padding-top: 6px; }
</style></head>
<body>
  <header>
    <div>
      <div class="kicker">Client consultation report</div>
      <h1>${esc(client.name)}</h1>
      <div class="sub">${subtitle}</div>
    </div>
    <div class="meta">${esc(`${completed.length} of ${required} calls done`)}<br>Generated ${esc(fmtDay(generatedAt))}${generatedBy ? `<br>by ${esc(generatedBy)}` : ''}</div>
  </header>
  <section><h2>Client details</h2><table class="details">${detailRows}</table>${wide}</section>
  ${lookHtml}
  <section><h2>Calls</h2>${callsHtml}</section>
  ${upcomingHtml}
  <footer>Confidential — for the styling team only.</footer>
</body></html>`;
};

// ── Images ──────────────────────────────────────────────────────────────────
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
export const MAX_REPORT_IMAGES = 60;

/// Only images we stored ourselves on Cloudinary are fetched — never an
/// arbitrary address from the database (no server-side request forgery).
export const isReportImageUrl = (url) => /^https:\/\/res\.cloudinary\.com\/[^/?#]+\/image\/upload\//.test(String(url ?? ''));

/// A smaller JPEG of the image, enough for print.
export const printSizedUrl = (url) => url.replace('/image/upload/', '/image/upload/c_limit,w_900,q_auto,f_jpg/');

/// Fetches one image as a data: URI, or null. Never throws.
export const fetchImageDataUri = async (url) => {
  if (!isReportImageUrl(url)) return null;
  try {
    const res = await fetch(printSizedUrl(url), { signal: AbortSignal.timeout(15000), redirect: 'error' });
    if (!res.ok) return null;
    const type = String(res.headers.get('content-type') ?? '').split(';')[0].trim();
    if (!/^image\/(jpeg|png|webp)$/.test(type)) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0 || buf.length > MAX_IMAGE_BYTES) return null;
    return `data:${type};base64,${buf.toString('base64')}`;
  } catch {
    return null;
  }
};
