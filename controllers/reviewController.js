import crypto from 'crypto';
import Review from '../models/Review.js';
import Booking from '../models/Booking.js';
import { notify, NOTIFICATION_TYPES, getUserIdsByRoles } from '../utils/notify.js';
import { TEAM_N_LOGO } from '../assets/teamNLogo.js';

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
// readable role + employee id, deduped by name.
const collectTeamMembers = (booking) => {
  const seen = new Map();
  const add = (arr) =>
    (arr || []).forEach((s) => {
      if (s && s.roleType !== 'driver' && s.artistName && !seen.has(s.artistName)) {
        seen.set(s.artistName, {
          name: s.artistName,
          role: readableRole(s),
          employeeId: s.employeeId || null,
        });
      }
    });
  add(booking.assignedStaff);
  (booking.bookingItems || []).forEach((it) => add(it.assignedStaff));
  return [...seen.values()];
};

// The lead artist's employee id (the "team member review" section rates them).
const primaryArtistId = (booking) => {
  const lead = (booking.assignedStaff || []).find(
    (s) => s.roleType === 'lead' && s.employeeId,
  );
  if (lead) return lead.employeeId;
  const first = (booking.assignedStaff || []).find(
    (s) => s.roleType !== 'driver' && s.employeeId,
  );
  return first?.employeeId || null;
};

// Every assigned artist's employee id (excludes drivers).
const artistIdsOf = (booking) => {
  const ids = new Set();
  const add = (arr) =>
    (arr || []).forEach((s) => {
      if (s && s.roleType !== 'driver' && s.employeeId) ids.add(String(s.employeeId));
    });
  add(booking.assignedStaff);
  (booking.bookingItems || []).forEach((it) => add(it.assignedStaff));
  return [...ids];
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
    primaryArtistId: primaryArtistId(booking),
    artistIds: artistIdsOf(booking),
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

// @route GET /api/reviews/artist/:employeeId  (auth)
// Aggregate a single artist's client-review performance (from the per-artist
// "team member" ratings of submitted reviews they led).
export const getArtistReviewPerformance = async (req, res) => {
  try {
    const reviews = await Review.find({
      status: 'submitted',
      primaryArtistId: req.params.employeeId,
    }).lean();

    const avg = (pick) => {
      const vals = reviews.map(pick).filter((v) => v > 0);
      return vals.length
        ? Math.round((vals.reduce((s, v) => s + v, 0) / vals.length) * 10) / 10
        : 0;
    };
    const tm = (k) => avg((r) => r.teamMember?.[k] || 0);

    const testimonials = reviews
      .filter((r) => (r.testimonial || '').trim())
      .sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt))
      .slice(0, 5)
      .map((r) => ({
        text: r.testimonial,
        bride: r.brideName,
        date: r.submittedAt,
        rating: r.teamMember?.overall || 0,
        consent: !!r.marketingConsent,
      }));

    res.json({
      reviewCount: reviews.length,
      avgClientRating: tm('overall'),
      avgBrideScore: avg((r) => r.brideScore || 0),
      breakdown: {
        skill: tm('skill'),
        attentionToDetail: tm('attention'),
        timeManagement: tm('timeManagement'),
        professionalism: tm('professionalism'),
        communication: tm('communication'),
        overall: tm('overall'),
      },
      testimonials,
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
//
// A step-by-step form: only the first question is visible at first; answering
// a question reveals the next one. Field names are unchanged, so the submit
// payload (and everything that reads reviews) stays exactly the same.

const BRAND = '#7A1220';
const BRAND_DK = '#4A0B14';
const GOLD = '#C9A66B';

function pageShell(title, inner) {
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"/>
<meta name="theme-color" content="${BRAND}"/>
<title>${esc(title)} · Team N Makeovers</title>
<script>document.documentElement.className+=' js';</script>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@600;700&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
:root{--brand:${BRAND};--brand-dk:${BRAND_DK};--gold:${GOLD};--ink:#2a1d20;--muted:#85777b;--line:#ebe1e3;--soft:#fbf3f4;--bg:#f7f2ef;--ok:#1f7a4d}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;background:var(--bg);color:var(--ink);line-height:1.5}
h1,h2,.serif{font-family:'Playfair Display',Georgia,'Times New Roman',serif}

/* Hero */
.hero{position:relative;background:radial-gradient(120% 90% at 50% 0%,#9a1a2c 0%,var(--brand) 45%,var(--brand-dk) 100%);color:#fff;text-align:center;padding:34px 20px 88px;overflow:hidden}
.hero:after{content:'';position:absolute;inset:auto -20% -60px;height:120px;background:var(--bg);border-radius:50% 50% 0 0/100% 100% 0 0}
.logo{width:92px;height:92px;margin:0 auto 14px;background:#fff;border-radius:50%;padding:6px;box-shadow:0 10px 30px rgba(0,0,0,.28),0 0 0 4px rgba(201,166,107,.45)}
.logo img{width:100%;height:100%;object-fit:contain;border-radius:50%;display:block}
.eyebrow{display:inline-block;font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:var(--gold);margin-bottom:6px}
.hero h1{margin:0;font-size:clamp(26px,6vw,38px);line-height:1.15}
.hero p{margin:10px auto 0;max-width:460px;font-size:14.5px;opacity:.9}

.wrap{max-width:720px;margin:0 auto;padding:0 16px 56px;position:relative}
.meta{position:relative;z-index:1;margin-top:-64px;background:#fff;border-radius:18px;padding:16px;box-shadow:0 10px 30px rgba(74,11,20,.10);display:flex;flex-wrap:wrap;gap:8px;justify-content:center}
.chip{display:inline-flex;align-items:center;gap:6px;background:var(--soft);border:1px solid var(--line);border-radius:999px;padding:6px 12px;font-size:13px;color:var(--ink)}
.chip b{color:var(--brand);font-weight:600}

/* Sticky progress */
.topbar{position:sticky;top:0;z-index:5;background:rgba(247,242,239,.92);-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);padding:12px 0 10px;margin:14px 0 4px}
.topbar .row{display:flex;justify-content:space-between;align-items:center;font-size:12.5px;color:var(--muted);font-weight:600;margin-bottom:7px}
.topbar .row b{color:var(--brand)}
.track{height:6px;background:#eadfe1;border-radius:99px;overflow:hidden}
.bar{height:100%;width:0;background:linear-gradient(90deg,var(--brand),var(--gold));border-radius:99px;transition:width .5s ease}

/* Steps */
.step{background:#fff;border-radius:20px;padding:20px 18px 18px;margin-top:14px;border:1px solid var(--line);box-shadow:0 2px 10px rgba(74,11,20,.04);transition:border-color .3s,box-shadow .3s}
.step.current{border-color:rgba(122,18,32,.35);box-shadow:0 10px 28px rgba(74,11,20,.10)}
.step-head{display:flex;gap:12px;align-items:flex-start}
.badge{flex:none;width:32px;height:32px;border-radius:50%;display:grid;place-items:center;background:var(--soft);color:var(--brand);font-weight:700;font-size:13.5px;border:1px solid var(--line);transition:.3s}
.badge svg{display:none;width:16px;height:16px}
.step.done .badge{background:var(--brand);border-color:var(--brand);color:#fff}
.step.done .badge .num{display:none}
.step.done .badge svg{display:block}
.step-title{margin:3px 0 0;font-size:clamp(18px,4.6vw,21px);line-height:1.3;color:var(--ink)}
.hint{margin:4px 0 0 44px;font-size:13px;color:var(--muted)}
.body{margin-top:16px}

/* 1-5 rating */
.scale{display:grid;grid-template-columns:repeat(5,1fr);gap:8px}
.scale.has-na{grid-template-columns:repeat(6,1fr)}
.opt{position:relative;display:block;cursor:pointer;-webkit-tap-highlight-color:transparent}
.opt input{position:absolute;opacity:0;width:1px;height:1px}
.opt>span{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;min-height:64px;padding:8px 4px;border:1.5px solid var(--line);border-radius:14px;background:#fff;text-align:center;transition:transform .15s,background .2s,border-color .2s,color .2s}
.opt>span b{font-size:19px;line-height:1;color:var(--ink)}
.opt>span small{font-size:11px;color:var(--muted);font-weight:500}
.opt:hover>span{border-color:#d3b9be;background:var(--soft)}
.opt:active>span{transform:scale(.96)}
.opt input:focus-visible+span{outline:3px solid rgba(201,166,107,.7);outline-offset:2px}
.opt input:checked+span{background:var(--brand);border-color:var(--brand);box-shadow:0 6px 16px rgba(122,18,32,.28)}
.opt input:checked+span b,.opt input:checked+span small{color:#fff}

/* Matrix (team behaviour) */
.mrow{padding:12px 0;border-top:1px dashed var(--line)}
.mrow:first-child{border-top:none;padding-top:0}
.mlabel{display:flex;justify-content:space-between;align-items:center;font-size:14.5px;font-weight:600;margin-bottom:8px}
.mlabel .tick{color:var(--ok);font-size:13px;opacity:0;transition:.3s}
.mrow.answered .tick{opacity:1}
.scale.compact .opt>span{min-height:46px}
.scale.compact .opt>span b{font-size:16px}
.scale-legend{display:flex;justify-content:space-between;font-size:11.5px;color:var(--muted);margin-top:6px}

/* Choices */
.choices{display:grid;grid-template-columns:1fr;gap:8px}
.choices .opt>span{flex-direction:row;justify-content:flex-start;gap:10px;min-height:52px;padding:12px 14px;font-size:15px;font-weight:600;color:var(--ink);text-align:left}
.choices .opt>span:before{content:'';flex:none;width:18px;height:18px;border-radius:50%;border:2px solid #cdbfc2;transition:.2s}
.choices .opt input:checked+span{color:#fff}
.choices .opt input:checked+span:before{border-color:#fff;background:radial-gradient(circle,#fff 38%,transparent 42%)}

/* NPS */
.nps{display:grid;grid-template-columns:repeat(6,1fr);gap:7px}
.nps .opt>span{min-height:46px}
.nps .opt>span b{font-size:16px}

/* Text inputs */
textarea,input[type=text]{width:100%;border:1.5px solid var(--line);border-radius:14px;padding:12px 14px;font-size:16px;font-family:inherit;color:var(--ink);background:#fff;transition:border-color .2s,box-shadow .2s}
textarea{min-height:96px;resize:vertical}
textarea:focus,input[type=text]:focus{outline:none;border-color:var(--brand);box-shadow:0 0 0 4px rgba(122,18,32,.10)}
.field{margin-top:14px}
.field label{display:block;font-size:13.5px;font-weight:600;margin-bottom:6px}
.chk{display:flex;align-items:flex-start;gap:12px;margin-top:12px;padding:12px 14px;border:1.5px solid var(--line);border-radius:14px;font-size:14px;cursor:pointer}
.chk input{flex:none;width:20px;height:20px;margin:1px 0 0;accent-color:var(--brand)}

/* Buttons */
.actions{display:flex;gap:10px;margin-top:14px}
.btn{appearance:none;border:none;border-radius:14px;padding:13px 20px;font-size:15px;font-weight:700;font-family:inherit;cursor:pointer;transition:transform .15s,opacity .2s}
.btn:active{transform:scale(.98)}
.btn.primary{background:var(--brand);color:#fff;box-shadow:0 8px 20px rgba(122,18,32,.25)}
.btn.ghost{background:transparent;color:var(--muted)}
.step.done .actions{display:none}

.submit-card{margin-top:18px;text-align:center;background:linear-gradient(135deg,var(--brand),var(--brand-dk));color:#fff;border-radius:22px;padding:26px 20px}
.submit-card h2{margin:0 0 4px;font-size:22px}
.submit-card p{margin:0 0 16px;opacity:.85;font-size:14px}
.submit-card .btn{width:100%;max-width:360px;background:var(--gold);color:var(--brand-dk);font-size:16px;padding:15px}
.submit-card .btn:disabled{opacity:.6}
.note{font-size:12px;color:var(--muted);text-align:center;margin-top:18px}

/* Reveal */
.js .step:not(.shown),.js .submit-card:not(.shown),.js .mrow:not(.shown){display:none}
.step.shown,.submit-card.shown,.mrow.shown{animation:rise .5s cubic-bezier(.2,.7,.2,1) both}
@keyframes rise{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:none}}

/* Thank-you / message pages */
.ty{text-align:center;padding:64px 20px}
.ty .big{width:84px;height:84px;margin:0 auto 18px;border-radius:50%;display:grid;place-items:center;font-size:40px;background:#fff;box-shadow:0 10px 30px rgba(74,11,20,.12)}
.ty h2{color:var(--brand);margin:0 0 8px;font-size:28px}
.ty p{max-width:420px;margin:0 auto;color:var(--muted)}

@media (min-width:560px){
  .step{padding:24px 24px 22px}
  .choices{grid-template-columns:1fr 1fr}
  .nps{grid-template-columns:repeat(11,1fr)}
  .opt>span small{font-size:11.5px}
}
@media (max-width:380px){
  .scale.has-na{grid-template-columns:repeat(3,1fr)}
  .opt>span small{font-size:10px}
  .hint{margin-left:0}
}
@media (prefers-reduced-motion:reduce){
  *,*:before,*:after{animation:none!important;transition:none!important}
}
</style></head><body>${inner}</body></html>`;
}

function thankYouInner() {
  return `<div class="wrap"><div class="ty">
    <div class="big">💖</div>
    <h2>Thank you!</h2>
    <p>Your feedback has been received. It means the world to the Team N Makeovers family.</p>
  </div></div>`;
}

const CHECK_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';

const RATING_WORDS = { 1: 'Poor', 2: 'Fair', 3: 'Good', 4: 'Great', 5: 'Loved it' };

// One question card. kind: 'auto' (advances on selection), 'manual'
// (Continue / Skip buttons) or 'matrix' (advances when every row is rated).
function step(n, title, body, opts = {}) {
  const kind = opts.kind || 'auto';
  const actions =
    kind === 'manual'
      ? `<div class="actions"><button type="button" class="btn primary next">Continue</button><button type="button" class="btn ghost skip">Skip</button></div>`
      : '';
  return `<section class="step" data-kind="${kind}" aria-labelledby="t${n}">
    <div class="step-head"><span class="badge"><span class="num">${n}</span>${CHECK_SVG}</span><h2 class="step-title" id="t${n}">${title}</h2></div>
    ${opts.hint ? `<p class="hint">${opts.hint}</p>` : ''}
    <div class="body">${body}</div>
    ${actions}
  </section>`;
}

function opt(name, value, inner) {
  return `<label class="opt"><input type="radio" name="${name}" value="${value}"><span>${inner}</span></label>`;
}

// 1-5 rating, with optional N/A (= 0).
function ratingScale(name, { na = false } = {}) {
  const pills = [1, 2, 3, 4, 5]
    .map((v) => opt(name, v, `<b>${v}</b><small>${RATING_WORDS[v]}</small>`))
    .join('');
  const naPill = na ? opt(name, 0, '<b>N/A</b><small>Not taken</small>') : '';
  return `<div class="scale${na ? ' has-na' : ''}" role="radiogroup">${pills}${naPill}</div>`;
}

// Rows revealed one by one: [{name,label}]
function matrix(rows) {
  return `<div class="matrix">${rows
    .map(
      (r, i) => `<div class="mrow${i === 0 ? ' shown' : ''}">
        <div class="mlabel"><span>${r.label}</span><span class="tick">✓</span></div>
        <div class="scale compact" role="radiogroup">${[1, 2, 3, 4, 5]
          .map((v) => opt(r.name, v, `<b>${v}</b>`))
          .join('')}</div>
      </div>`,
    )
    .join('')}<div class="scale-legend"><span>1 · Poor</span><span>5 · Excellent</span></div></div>`;
}

// Single choice for string enums: options=[{value,text}]
function choices(name, options) {
  return `<div class="choices" role="radiogroup">${options
    .map((o) => opt(name, o.value, o.text))
    .join('')}</div>`;
}

export function renderForm(review) {
  const wed = review.weddingDate
    ? new Date(review.weddingDate).toLocaleDateString('en-IN', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
      })
    : '';
  const firstName = String(review.brideName || '').trim().split(/\s+/)[0] || '';

  const team =
    review.teamMembers && review.teamMembers.length
      ? review.teamMembers
          .map((m) => `${esc(m.name)}${m.role ? ` (${esc(m.role)})` : ''}`)
          .join(', ')
      : esc(review.artistName || '');

  const chips = [
    review.brideName && `<span class="chip">👰 <b>${esc(review.brideName)}</b></span>`,
    wed && `<span class="chip">📅 ${esc(wed)}</span>`,
    review.venue && `<span class="chip">📍 ${esc(review.venue)}</span>`,
    team && `<span class="chip">💄 ${team}</span>`,
    review.bookingNumber && `<span class="chip">#${esc(review.bookingNumber)}</span>`,
  ]
    .filter(Boolean)
    .join('');

  const steps = [
    step(1, 'How was your overall experience?', ratingScale('overall')),
    step(2, 'How would you rate the makeup?', ratingScale('makeup')),
    step(3, 'How was the hair styling?', ratingScale('hair', { na: true }), {
      hint: 'Choose N/A if you didn’t take this service.',
    }),
    step(4, 'How was the saree draping / styling?', ratingScale('saree', { na: true }), {
      hint: 'Choose N/A if you didn’t take this service.',
    }),
    step(
      5,
      'How was our team’s behaviour?',
      matrix([
        { name: 'teamBehaviour.punctuality', label: 'Punctuality' },
        { name: 'teamBehaviour.professionalism', label: 'Professionalism' },
        { name: 'teamBehaviour.communication', label: 'Communication' },
        { name: 'teamBehaviour.politeness', label: 'Politeness & attitude' },
        { name: 'teamBehaviour.handlingRequests', label: 'Handling your requests' },
      ]),
      { kind: 'matrix', hint: 'Rate each one — the next appears as you go.' },
    ),
    step(
      6,
      'Did the final look match your expectation?',
      choices('lookMatch', [
        { value: 'much_better', text: 'Much better ✨' },
        { value: 'exactly', text: 'Exactly' },
        { value: 'mostly', text: 'Mostly' },
        { value: 'not', text: 'Not what I expected' },
      ]),
    ),
    step(
      7,
      'What did you like the most?',
      '<textarea name="likedMost" placeholder="The look, the team, a special moment…"></textarea>',
      { kind: 'manual' },
    ),
    step(
      8,
      'Did you feel comfortable & confident with our team?',
      choices('comfortable', [
        { value: 'definitely_yes', text: 'Definitely yes' },
        { value: 'yes', text: 'Yes' },
        { value: 'not_completely', text: 'Not completely' },
        { value: 'no', text: 'No' },
      ]),
    ),
    step(
      9,
      'Would you recommend Team N Makeovers?',
      choices('recommend', [
        { value: 'definitely_yes', text: 'Definitely 💖' },
        { value: 'yes', text: 'Yes' },
        { value: 'maybe', text: 'Maybe' },
        { value: 'no', text: 'No' },
      ]),
    ),
    step(
      10,
      'Would you book us again?',
      choices('bookAgain', [
        { value: 'definitely_yes', text: 'Definitely' },
        { value: 'yes', text: 'Yes' },
        { value: 'maybe', text: 'Maybe' },
        { value: 'no', text: 'No' },
      ]),
    ),
    step(
      11,
      'How likely are you to recommend us to a friend?',
      `<div class="nps" role="radiogroup">${Array.from({ length: 11 }, (_, i) =>
        opt('nps', i, `<b>${i}</b>`),
      ).join('')}</div><div class="scale-legend"><span>0 · Not likely</span><span>10 · Extremely likely</span></div>`,
    ),
    step(
      12,
      'Share a few words for other brides',
      `<textarea name="testimonial" placeholder="Your testimonial (optional)"></textarea>
      <label class="chk"><input type="checkbox" name="marketingConsent"><span>You may use my review, photos or video for marketing.</span></label>
      <label class="chk"><input type="checkbox" name="tagConsent"><span>You may tag my social media when sharing.</span></label>
      <div class="field"><label for="ig">Instagram / social username (optional)</label><input id="ig" type="text" name="instagram" placeholder="@username" autocomplete="off"></div>`,
      { kind: 'manual', hint: 'Optional — but it truly makes our day.' },
    ),
  ].join('');

  const inner = `
<header class="hero">
  <div class="logo"><img src="${TEAM_N_LOGO}" alt="Team N Makeovers"></div>
  <div class="eyebrow">Bridal Service Review</div>
  <h1>${firstName ? `Hi ${esc(firstName)}, how was your big day?` : 'How was your big day?'}</h1>
  <p>Thank you for choosing Team N Makeovers. This takes about 2 minutes — answer one question and the next appears.</p>
</header>
<main class="wrap">
  ${chips ? `<div class="meta">${chips}</div>` : ''}

  <div class="topbar" aria-live="polite">
    <div class="row"><span>Your review</span><span><b id="count">0</b> of 12 answered</span></div>
    <div class="track"><div class="bar" id="bar"></div></div>
  </div>

  <form id="f" novalidate>
    ${steps}
    <div class="submit-card" id="submitCard">
      <h2 class="serif">All done 💖</h2>
      <p>You can scroll up to change any answer before submitting.</p>
      <button class="btn" id="sb" type="submit">Submit review</button>
    </div>
    <div class="note">Team N Makeovers · Thank you for choosing us</div>
  </form>
</main>
<script>
(function(){
  var TOKEN=${JSON.stringify(review.token)};
  function setPath(o,p,v){var k=p.split('.'),c=o;for(var i=0;i<k.length-1;i++){c[k[i]]=c[k[i]]||{};c=c[k[i]];}c[k[k.length-1]]=v;}
  var reduce=window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var steps=[].slice.call(document.querySelectorAll('.step'));
  var total=steps.length, submitCard=document.getElementById('submitCard');
  var bar=document.getElementById('bar'), count=document.getElementById('count');

  function focusOn(el){
    setTimeout(function(){
      try{el.scrollIntoView({behavior:reduce?'auto':'smooth',block:'center'});}catch(e){el.scrollIntoView();}
    },140);
  }
  function setCurrent(el){
    steps.forEach(function(s){s.classList.remove('current');});
    if(el&&el.classList.contains('step'))el.classList.add('current');
  }
  function reveal(el){
    if(el.classList.contains('shown'))return;
    el.classList.add('shown');setCurrent(el);focusOn(el);
  }
  function progress(){
    var d=steps.filter(function(s){return s.classList.contains('done');}).length;
    bar.style.width=(d/total*100)+'%';count.textContent=d;
  }
  function complete(i){
    steps[i].classList.add('done');progress();
    var next=steps[i+1];reveal(next||submitCard);
  }

  steps.forEach(function(s,i){
    var kind=s.getAttribute('data-kind');
    if(kind==='matrix'){
      var rows=[].slice.call(s.querySelectorAll('.mrow'));
      rows.forEach(function(r,j){
        r.addEventListener('change',function(){
          r.classList.add('answered');
          var nr=rows[j+1];
          if(nr&&!nr.classList.contains('shown')){nr.classList.add('shown');
            setTimeout(function(){try{nr.scrollIntoView({behavior:reduce?'auto':'smooth',block:'nearest'});}catch(e){}},120);}
          if(!s.classList.contains('done')&&rows.every(function(x){return x.classList.contains('answered');}))complete(i);
        });
      });
    }else if(kind==='manual'){
      s.querySelector('.next').addEventListener('click',function(){complete(i);});
      s.querySelector('.skip').addEventListener('click',function(){complete(i);});
    }else{
      s.addEventListener('change',function(e){
        if(e.target.type==='radio'&&!s.classList.contains('done'))complete(i);
      });
    }
  });
  steps[0].classList.add('shown');setCurrent(steps[0]);progress();

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
        if(res.ok){document.body.innerHTML=${JSON.stringify(thankYouInner())};window.scrollTo(0,0);}
        else{btn.disabled=false;btn.textContent='Submit review';alert((res.j&&res.j.message)||'Could not submit. Please try again.');}
      })
      .catch(function(){btn.disabled=false;btn.textContent='Submit review';alert('Network error. Please try again.');});
  });
})();
</script>`;
  return pageShell('Bridal Service Review', inner);
}
