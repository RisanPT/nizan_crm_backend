import crypto from 'crypto';
import Review from '../models/Review.js';
import Booking from '../models/Booking.js';
import { notify, NOTIFICATION_TYPES, getUserIdsByRoles } from '../utils/notify.js';

// ── Snapshot helpers ─────────────────────────────────────────────────────────

const collectArtistNames = (booking) => {
  const names = [];
  const add = (arr) =>
    (arr || []).forEach((s) => {
      if (s && s.roleType !== 'driver' && s.artistName) names.push(s.artistName);
    });
  add(booking.assignedStaff);
  (booking.bookingItems || []).forEach((it) => add(it.assignedStaff));
  return [...new Set(names)];
};

const primaryArtistName = (booking) => {
  const lead = (booking.assignedStaff || []).find(
    (s) => s.roleType === 'lead' && s.artistName,
  );
  if (lead) return lead.artistName;
  const all = collectArtistNames(booking);
  return all[0] || '';
};

const readableRole = (s) => {
  if (s?.roleType === 'lead') return 'Lead Artist';
  if (s?.roleType === 'assistant') return 'Assistant';
  if (s?.role) return String(s.role);
  return 'Team member';
};

// All assigned team members (artist + assistants, excluding drivers) with a
// readable role, deduped by name.
const collectTeamMembers = (booking) => {
  const seen = new Map();
  const add = (arr) =>
    (arr || []).forEach((s) => {
      if (s && s.roleType !== 'driver' && s.artistName && !seen.has(s.artistName)) {
        seen.set(s.artistName, { name: s.artistName, role: readableRole(s) });
      }
    });
  add(booking.assignedStaff);
  (booking.bookingItems || []).forEach((it) => add(it.assignedStaff));
  return [...seen.values()];
};

const publicBase = (req) => {
  const env = (process.env.PUBLIC_API_URL || '').replace(/\/+$/, '');
  if (env) return env;
  return `${req.protocol}://${req.get('host')}`;
};

export const reviewFormUrl = (req, token) =>
  `${publicBase(req)}/api/reviews/form/${token}`;

// Create (or return the existing) pending review for a completed booking. Used
// by the completion hook and by an explicit "send review" call. Idempotent.
export const ensureReviewForBooking = async (booking, user) => {
  const weddingDate =
    booking.bookingDate ||
    (Array.isArray(booking.selectedDates) && booking.selectedDates.length
      ? booking.selectedDates[0]
      : null);

  const snapshot = {
    bookingNumber: booking.bookingNumber || '',
    brideName: booking.customerName || '',
    weddingDate,
    venue: booking.address || '',
    artistName: primaryArtistName(booking),
    artistNames: collectArtistNames(booking),
    teamMembers: collectTeamMembers(booking),
    customerPhone: booking.phone || '',
  };

  let review = await Review.findOne({ booking: booking._id });
  if (review) {
    // Keep a still-pending review's snapshot in step with the latest booking
    // (e.g. staff assigned after the first send), so the form always shows the
    // current team. A submitted review is never touched.
    if (review.status === 'pending') {
      Object.assign(review, snapshot);
      await review.save();
    }
    return review;
  }

  review = await Review.create({
    token: crypto.randomBytes(24).toString('hex'),
    booking: booking._id,
    ...snapshot,
    status: 'pending',
    sentBy: user?._id || null,
    sentByName: user?.name || '',
    sentVia: 'whatsapp',
    sentAt: new Date(),
  });
  return review;
};

// @route POST /api/reviews/for-booking/:bookingId  (auth)
// Ensure a review exists for a booking and return its public form URL, so the
// app can send the link on demand (independent of the completion save flow).
export const createReviewForBooking = async (req, res) => {
  try {
    const booking = await Booking.findById(req.params.bookingId);
    if (!booking) return res.status(404).json({ message: 'Booking not found' });
    const review = await ensureReviewForBooking(booking, req.user);
    res.json({ reviewUrl: reviewFormUrl(req, review.token), token: review.token });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ── Public: render + submit the form ─────────────────────────────────────────

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

// @route GET /api/reviews/form/:token  (public)
export const getReviewForm = async (req, res) => {
  const review = await Review.findOne({ token: req.params.token });
  if (!review) {
    return res.status(404).send(pageShell('Link not found',
      '<h2>Link not found</h2><p>This review link is invalid or has expired.</p>'));
  }
  if (review.status === 'submitted') {
    return res.send(pageShell('Thank you', thankYouInner()));
  }
  return res.send(renderForm(review));
};

// @route POST /api/reviews/submit/:token  (public)
export const submitReview = async (req, res) => {
  try {
    const review = await Review.findOne({ token: req.params.token });
    if (!review) return res.status(404).json({ message: 'Invalid link' });
    if (review.status === 'submitted') {
      return res.status(409).json({ message: 'This review was already submitted.' });
    }

    const b = req.body || {};
    const num = (v) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : 0;
    };
    const str = (v) => (v == null ? '' : String(v)).trim();
    const bool = (v) => v === true || v === 'true' || v === 'on' || v === 'yes';

    review.overall = num(b.overall);
    review.makeup = num(b.makeup);
    review.hair = num(b.hair);
    review.saree = num(b.saree);
    const tb = b.teamBehaviour || {};
    review.teamBehaviour = {
      punctuality: num(tb.punctuality),
      professionalism: num(tb.professionalism),
      communication: num(tb.communication),
      politeness: num(tb.politeness),
      handlingRequests: num(tb.handlingRequests),
    };
    review.lookMatch = str(b.lookMatch);
    review.comfortable = str(b.comfortable);
    review.recommend = str(b.recommend);
    review.bookAgain = str(b.bookAgain);
    review.likedMost = str(b.likedMost);
    review.couldBeBetter = str(b.couldBeBetter);

    const tm = b.teamMember || {};
    review.teamMember = {
      skill: num(tm.skill),
      attention: num(tm.attention),
      timeManagement: num(tm.timeManagement),
      professionalism: num(tm.professionalism),
      communication: num(tm.communication),
      overall: num(tm.overall),
    };
    review.teamMemberDidWell = str(b.teamMemberDidWell);
    review.teamMemberImprove = str(b.teamMemberImprove);

    review.testimonial = str(b.testimonial);
    review.marketingConsent = bool(b.marketingConsent);
    review.tagConsent = bool(b.tagConsent);
    review.instagram = str(b.instagram);
    review.nps = b.nps == null || b.nps === '' ? null : num(b.nps);

    review.computeScores();
    // A low overall rating or explicit low NPS auto-flags a complaint for staff.
    review.complaint =
      (review.overall > 0 && review.overall <= 2) ||
      (review.nps != null && review.nps <= 6);
    review.compliment = review.brideScore >= 4.5;

    review.status = 'submitted';
    review.submittedAt = new Date();
    await review.save();

    // Notify CRM + management that a review came in.
    try {
      const ids = await getUserIdsByRoles(['crm', 'manager', 'admin']);
      await notify({
        recipients: ids,
        type: NOTIFICATION_TYPES.REVIEW_SUBMITTED,
        title: 'New client review',
        body: `${review.brideName || 'A client'} rated ${review.brideScore}/5${
          review.nps != null ? ` · NPS ${review.nps}` : ''
        }${review.complaint ? ' · needs follow-up' : ''}.`,
        link: '/reviews',
        bookingId: review.booking,
        createdBy: null,
      });
    } catch (_) {/* best-effort */}

    return res.json({ ok: true });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// ── Staff: list / detail / update internal block ─────────────────────────────

const isFullAccess = (u) => ['admin', 'manager'].includes(String(u?.role || '').toLowerCase());

// @route GET /api/reviews  (auth)
export const getReviews = async (req, res) => {
  try {
    const { status, complaint, followUp, search } = req.query;
    const filter = {};
    if (status && status !== 'all' && status !== 'All') filter.status = status;
    if (complaint === 'true') filter.complaint = true;
    if (followUp === 'true') filter.followUpRequired = true;
    if (search) {
      const rx = new RegExp(String(search).trim(), 'i');
      filter.$or = [
        { brideName: rx },
        { bookingNumber: rx },
        { artistName: rx },
      ];
    }
    const reviews = await Review.find(filter)
      .sort({ submittedAt: -1, createdAt: -1 })
      .limit(500)
      .lean();
    res.json(reviews);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @route GET /api/reviews/analytics  (auth)
// Aggregate metrics over SUBMITTED reviews: average scores, NPS split, and a
// per-artist leaderboard. Computed in JS (modest volumes) to avoid aggregate
// casting pitfalls.
export const getReviewAnalytics = async (req, res) => {
  try {
    const { from, to } = req.query;
    const filter = { status: 'submitted' };
    if (from || to) {
      filter.submittedAt = {};
      if (from) filter.submittedAt.$gte = new Date(from);
      if (to) {
        const end = new Date(to);
        end.setHours(23, 59, 59, 999);
        filter.submittedAt.$lte = end;
      }
    }

    const [reviews, pending] = await Promise.all([
      Review.find(filter).lean(),
      Review.countDocuments({ status: 'pending' }),
    ]);

    const round1 = (v) => Math.round(v * 10) / 10;
    const avgOf = (arr, pick) => {
      const vals = arr.map(pick).filter((v) => v > 0);
      if (vals.length === 0) return 0;
      return round1(vals.reduce((s, v) => s + v, 0) / vals.length);
    };

    // NPS: promoters (9-10), passives (7-8), detractors (0-6).
    const withNps = reviews.filter((r) => r.nps != null);
    const promoters = withNps.filter((r) => r.nps >= 9).length;
    const passives = withNps.filter((r) => r.nps >= 7 && r.nps <= 8).length;
    const detractors = withNps.filter((r) => r.nps <= 6).length;
    const nps = withNps.length
      ? Math.round(((promoters - detractors) / withNps.length) * 100)
      : 0;

    // Per-artist leaderboard.
    const byArtist = {};
    for (const r of reviews) {
      const key = (r.artistName || '').trim() || 'Unassigned';
      const a =
        byArtist[key] ||
        (byArtist[key] = {
          artistName: key,
          count: 0,
          brideSum: 0,
          brideCount: 0,
          teamSum: 0,
          teamCount: 0,
        });
      a.count += 1;
      if (r.brideScore > 0) {
        a.brideSum += r.brideScore;
        a.brideCount += 1;
      }
      if (r.teamMemberScore > 0) {
        a.teamSum += r.teamMemberScore;
        a.teamCount += 1;
      }
    }
    const perArtist = Object.values(byArtist)
      .map((a) => ({
        artistName: a.artistName,
        count: a.count,
        avgBrideScore: a.brideCount ? round1(a.brideSum / a.brideCount) : 0,
        avgTeamScore: a.teamCount ? round1(a.teamSum / a.teamCount) : 0,
      }))
      .sort((x, y) => y.avgTeamScore - x.avgTeamScore || y.count - x.count);

    res.json({
      totalSubmitted: reviews.length,
      pending,
      avgBrideScore: avgOf(reviews, (r) => r.brideScore),
      avgTeamScore: avgOf(reviews, (r) => r.teamMemberScore),
      nps,
      promoters,
      passives,
      detractors,
      npsResponses: withNps.length,
      complaints: reviews.filter((r) => r.complaint).length,
      followUps: reviews.filter((r) => r.followUpRequired).length,
      testimonialsAvailable: reviews.filter(
        (r) => r.marketingConsent && (r.testimonial || '').trim(),
      ).length,
      perArtist,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @route GET /api/reviews/:id  (auth)
export const getReviewById = async (req, res) => {
  try {
    const review = await Review.findById(req.params.id).lean();
    if (!review) return res.status(404).json({ message: 'Review not found' });
    res.json(review);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @route PUT /api/reviews/:id  (auth) — edit the internal management block only.
export const updateReview = async (req, res) => {
  try {
    if (!isFullAccess(req.user) && !['crm', 'accounts'].includes(String(req.user?.role))) {
      return res.status(403).json({ message: 'Not authorized to edit reviews' });
    }
    const review = await Review.findById(req.params.id);
    if (!review) return res.status(404).json({ message: 'Review not found' });

    const b = req.body || {};
    const boolFields = [
      'complaint',
      'compliment',
      'followUpRequired',
      'reviewPosted',
      'referralOpportunity',
    ];
    for (const f of boolFields) {
      if (b[f] !== undefined) review[f] = b[f] === true || b[f] === 'true';
    }
    if (b.managerComments !== undefined) review.managerComments = String(b.managerComments);

    await review.save();
    res.json(review);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ── HTML rendering (self-contained public form) ──────────────────────────────

const BRAND = '#7A1220';
const BRAND_DK = '#5E0E19';

function pageShell(title, inner) {
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${esc(title)} · Team N Makeovers</title>
<style>
:root{--brand:${BRAND};--brand-dk:${BRAND_DK};}
*{box-sizing:border-box}
body{margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;background:#f4f1f2;color:#241a1c;line-height:1.5}
.wrap{max-width:680px;margin:0 auto;padding:0 16px 48px}
.head{background:linear-gradient(135deg,var(--brand),var(--brand-dk));color:#fff;padding:28px 20px;text-align:center;border-radius:0 0 20px 20px}
.head h1{margin:0;font-size:20px;letter-spacing:.5px}
.head p{margin:6px 0 0;opacity:.9;font-size:13px}
.card{background:#fff;border-radius:14px;padding:18px;margin-top:16px;box-shadow:0 1px 3px rgba(0,0,0,.06)}
.meta{display:grid;grid-template-columns:1fr;gap:6px;font-size:14px}
.meta b{color:var(--brand)}
.q{margin:18px 0}
.q-label{font-weight:600;margin-bottom:8px;font-size:15px}
.opts{display:flex;flex-wrap:wrap;gap:8px}
.pill{position:relative;cursor:pointer}
.pill input{position:absolute;opacity:0;inset:0}
.pill span{display:inline-block;min-width:40px;text-align:center;padding:9px 12px;border:1.5px solid #e0d6d8;border-radius:10px;font-size:14px;font-weight:600;color:#5b5054;background:#fff;transition:.15s}
.pill input:checked+span{background:var(--brand);border-color:var(--brand);color:#fff}
.opts.choices .pill span{min-width:auto}
textarea,input[type=text]{width:100%;border:1.5px solid #e0d6d8;border-radius:10px;padding:10px 12px;font-size:15px;font-family:inherit;background:#fff}
textarea{min-height:70px;resize:vertical}
.matrix .row{display:flex;flex-direction:column;align-items:stretch;gap:8px;padding:12px 0;border-bottom:1px solid #f0eaec}
.matrix .row:last-child{border-bottom:none}
.matrix .rl{font-size:14px;font-weight:600}
.matrix .opts{gap:6px}
.matrix .pill{flex:1}
.matrix .pill span{min-width:0;width:100%;padding:10px 0}
.sec-title{font-size:16px;font-weight:800;color:var(--brand);margin:26px 4px 4px}
.chk{display:flex;align-items:center;gap:10px;margin:10px 0;font-size:14px}
.chk input{width:20px;height:20px;accent-color:var(--brand)}
.nps{display:flex;flex-wrap:wrap;gap:6px}
.nps .pill span{min-width:34px;padding:8px 0}
.btn{width:100%;background:var(--brand);color:#fff;border:none;border-radius:12px;padding:15px;font-size:16px;font-weight:700;cursor:pointer;margin-top:22px}
.btn:disabled{opacity:.6}
.note{font-size:12px;color:#8a7f82;text-align:center;margin-top:14px}
.ty{text-align:center;padding:40px 16px}
.ty .big{font-size:52px}
.ty h2{color:var(--brand);margin:12px 0 6px}
</style></head><body>${inner}</body></html>`;
}

function thankYouInner() {
  return `<div class="wrap"><div class="ty">
    <div class="big">💖</div>
    <h2>Thank you!</h2>
    <p>Your feedback has been received. It means the world to the Team N Makeovers family.</p>
  </div></div>`;
}

// 1-5 rating row (optionally with N/A = 0)
function ratingRow(name, label, opts = {}) {
  const scale = [5, 4, 3, 2, 1]
    .map(
      (v) =>
        `<label class="pill"><input type="radio" name="${name}" value="${v}"><span>${v}</span></label>`,
    )
    .join('');
  const na = opts.na
    ? `<label class="pill"><input type="radio" name="${name}" value="0"><span>N/A</span></label>`
    : '';
  return `<div class="q"><div class="q-label">${label}</div><div class="opts">${scale}${na}</div></div>`;
}

// A matrix section: [{name,label}]
function matrix(rows) {
  return `<div class="matrix">${rows
    .map(
      (r) =>
        `<div class="row"><div class="rl">${r.label}</div><div class="opts">${[5, 4, 3, 2, 1]
          .map(
            (v) =>
              `<label class="pill"><input type="radio" name="${r.name}" value="${v}"><span>${v}</span></label>`,
          )
          .join('')}</div></div>`,
    )
    .join('')}</div>`;
}

// Single-choice row for string enums: options=[{value,text}]
function choiceRow(name, label, options) {
  return `<div class="q"><div class="q-label">${label}</div><div class="opts choices">${options
    .map(
      (o) =>
        `<label class="pill"><input type="radio" name="${name}" value="${o.value}"><span>${o.text}</span></label>`,
    )
    .join('')}</div></div>`;
}

function textRow(name, label) {
  return `<div class="q"><div class="q-label">${label}</div><textarea name="${name}"></textarea></div>`;
}

export function renderForm(review) {
  const wed = review.weddingDate
    ? new Date(review.weddingDate).toLocaleDateString('en-IN', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
      })
    : '';

  const inner = `
<div class="head">
  <h1>TEAM N MAKEOVERS</h1>
  <p>Bridal Service Review — your feedback helps us grow 💄</p>
</div>
<div class="wrap">
  <div class="card">
    <div class="meta">
      ${review.brideName ? `<div><b>Bride:</b> ${esc(review.brideName)}</div>` : ''}
      ${wed ? `<div><b>Wedding date:</b> ${esc(wed)}</div>` : ''}
      ${review.venue ? `<div><b>Venue:</b> ${esc(review.venue)}</div>` : ''}
      ${
        review.teamMembers && review.teamMembers.length
          ? `<div><b>Our team:</b> ${review.teamMembers
              .map((m) => `${esc(m.name)}${m.role ? ` (${esc(m.role)})` : ''}`)
              .join(', ')}</div>`
          : review.artistName
          ? `<div><b>Team member:</b> ${esc(review.artistName)}</div>`
          : ''
      }
      ${review.bookingNumber ? `<div><b>Booking #:</b> ${esc(review.bookingNumber)}</div>` : ''}
    </div>
  </div>

  <form id="f">
    <div class="card">
      ${ratingRow('overall', '1. Overall experience')}
      ${ratingRow('makeup', '2. Makeup quality')}
      ${ratingRow('hair', '3. Hair styling', { na: true })}
      ${ratingRow('saree', '4. Saree draping / styling', { na: true })}
    </div>

    <div class="sec-title">5. Team behaviour</div>
    <div class="card">
      ${matrix([
        { name: 'teamBehaviour.punctuality', label: 'Punctuality' },
        { name: 'teamBehaviour.professionalism', label: 'Professionalism' },
        { name: 'teamBehaviour.communication', label: 'Communication' },
        { name: 'teamBehaviour.politeness', label: 'Politeness & attitude' },
        { name: 'teamBehaviour.handlingRequests', label: 'Handling your requests' },
      ])}
    </div>

    <div class="card">
      ${choiceRow('lookMatch', '6. Did the final look match your expectation?', [
        { value: 'much_better', text: 'Much better' },
        { value: 'exactly', text: 'Exactly' },
        { value: 'mostly', text: 'Mostly' },
        { value: 'not', text: 'Not what I expected' },
      ])}
      ${textRow('likedMost', '7. What did you like the MOST?')}
      ${textRow('couldBeBetter', '8. Anything that could have been better?')}
      ${choiceRow('comfortable', '9. Did you feel comfortable & confident with our team?', [
        { value: 'definitely_yes', text: 'Definitely yes' },
        { value: 'yes', text: 'Yes' },
        { value: 'not_completely', text: 'Not completely' },
        { value: 'no', text: 'No' },
      ])}
      ${choiceRow('recommend', '10. Would you recommend Team N Makeovers?', [
        { value: 'definitely_yes', text: 'Definitely 💖' },
        { value: 'yes', text: 'Yes' },
        { value: 'maybe', text: 'Maybe' },
        { value: 'no', text: 'No' },
      ])}
      ${choiceRow('bookAgain', '11. Would you book us again?', [
        { value: 'definitely_yes', text: 'Definitely' },
        { value: 'yes', text: 'Yes' },
        { value: 'maybe', text: 'Maybe' },
        { value: 'no', text: 'No' },
      ])}
    </div>

    <div class="sec-title">Team member review${review.artistName ? ` — ${esc(review.artistName)}` : ''}</div>
    <div class="card">
      ${matrix([
        { name: 'teamMember.skill', label: 'Makeup / service skill' },
        { name: 'teamMember.attention', label: 'Attention to detail' },
        { name: 'teamMember.timeManagement', label: 'Time management' },
        { name: 'teamMember.professionalism', label: 'Professionalism' },
        { name: 'teamMember.communication', label: 'Communication' },
        { name: 'teamMember.overall', label: 'Overall performance' },
      ])}
      ${textRow('teamMemberDidWell', '12. One thing this team member did exceptionally well')}
      ${textRow('teamMemberImprove', '13. One thing they can improve')}
    </div>

    <div class="sec-title">Testimonial & marketing</div>
    <div class="card">
      ${textRow('testimonial', 'Share a short testimonial (optional)')}
      <label class="chk"><input type="checkbox" name="marketingConsent"> May we use your review/photos/video for marketing?</label>
      <label class="chk"><input type="checkbox" name="tagConsent"> May we tag your social media when sharing?</label>
      <div class="q"><div class="q-label">Instagram / social username (optional)</div><input type="text" name="instagram" placeholder="@username"></div>
    </div>

    <div class="card">
      <div class="q-label">On a scale of 0–10, how likely are you to recommend us?</div>
      <div class="nps">${Array.from({ length: 11 }, (_, i) =>
        `<label class="pill"><input type="radio" name="nps" value="${i}"><span>${i}</span></label>`,
      ).join('')}</div>
    </div>

    <button class="btn" id="sb" type="submit">Submit review</button>
    <div class="note">Team N Makeovers · Thank you for choosing us 💖</div>
  </form>
</div>
<script>
(function(){
  var TOKEN=${JSON.stringify(review.token)};
  function setPath(o,p,v){var k=p.split('.'),c=o;for(var i=0;i<k.length-1;i++){c[k[i]]=c[k[i]]||{};c=c[k[i]];}c[k[k.length-1]]=v;}
  var f=document.getElementById('f');
  f.addEventListener('submit',function(e){
    e.preventDefault();
    var data={};
    f.querySelectorAll('input[type=radio]:checked').forEach(function(el){setPath(data,el.name,el.value);});
    f.querySelectorAll('textarea, input[type=text]').forEach(function(el){if(el.name)setPath(data,el.name,el.value);});
    f.querySelectorAll('input[type=checkbox]').forEach(function(el){setPath(data,el.name,el.checked);});
    var btn=document.getElementById('sb');btn.disabled=true;btn.textContent='Submitting…';
    fetch('/api/reviews/submit/'+TOKEN,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)})
      .then(function(r){return r.json().then(function(j){return {ok:r.ok,j:j};});})
      .then(function(res){
        if(res.ok){document.body.innerHTML=${JSON.stringify(thankYouInner())};}
        else{btn.disabled=false;btn.textContent='Submit review';alert((res.j&&res.j.message)||'Could not submit. Please try again.');}
      })
      .catch(function(){btn.disabled=false;btn.textContent='Submit review';alert('Network error. Please try again.');});
  });
})();
</script>`;
  return pageShell('Bridal Service Review', inner);
}
