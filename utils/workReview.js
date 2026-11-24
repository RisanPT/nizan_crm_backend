// A gallery photo / video and the WORK it came from (a CRM booking): who did it, and what the client said in the review sent the
// morning after (models/Review.js — matched by the booking). Every artist on a work gets the work's rating, good or bad (the user's
// rule). Pure — services/workQuality.js loads the records.
import { npsOf } from './nps.js';
import { istDayKey } from './istDate.js';

const idOf = (v) => (v == null ? '' : String(v._id ?? v));
const rating = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
};
const round1 = (n) => Math.round(n * 10) / 10;
const avg = (list) => (list.length ? round1(list.reduce((a, b) => a + b, 0) / list.length) : null);

/** The client-review filters on the gallery, in their order. */
export const REVIEW_FILTERS = ['great', 'good', 'low', 'complaint', 'waiting'];

/** What the client rated, area by area (1–5 stars each) — the quality view finds each artist's weakest. */
export const SCORE_AREAS = [
  { key: 'makeup', label: 'Makeup', get: (r) => r.makeup },
  { key: 'hair', label: 'Hair', get: (r) => r.hair },
  { key: 'saree', label: 'Saree draping', get: (r) => r.saree },
  { key: 'skill', label: 'Artist skill', get: (r) => r.teamMember?.skill },
  { key: 'attention', label: 'Attention to detail', get: (r) => r.teamMember?.attention },
  { key: 'timeManagement', label: 'Time management', get: (r) => r.teamMember?.timeManagement },
  { key: 'punctuality', label: 'Punctuality', get: (r) => r.teamBehaviour?.punctuality },
  { key: 'professionalism', label: 'Professionalism', get: (r) => r.teamBehaviour?.professionalism },
  { key: 'communication', label: 'Communication', get: (r) => r.teamBehaviour?.communication },
  { key: 'politeness', label: 'Politeness', get: (r) => r.teamBehaviour?.politeness },
  { key: 'handlingRequests', label: 'Handling requests', get: (r) => r.teamBehaviour?.handlingRequests },
];

// the review form's multiple-choice answers, in words
const ANSWER_WORDS = {
  much_better: 'Much better than expected',
  exactly: 'Exactly as expected',
  mostly: 'Mostly as expected',
  not: 'Not as expected',
  definitely_yes: 'Definitely yes',
  yes: 'Yes',
  not_completely: 'Not completely',
  maybe: 'Maybe',
  no: 'No',
};
const ANSWERS = [
  ['lookMatch', 'The look matched what she wanted'],
  ['comfortable', 'She felt comfortable with the team'],
  ['recommend', 'Would recommend us'],
  ['bookAgain', 'Would book us again'],
];

/** The work's rating out of 5: the client's overall stars, else the average of her answers. 0 = not rated. */
export const workScore = (r) => rating(r?.overall) || rating(r?.brideScore) || rating(r?.teamMemberScore);

/** 'great' (4.5 and up) · 'good' (3.5 to 4.4) · 'low' (below 3.5) · 'none' (no rating). */
export const bandOf = (score) => (score >= 4.5 ? 'great' : score >= 3.5 ? 'good' : score > 0 ? 'low' : 'none');

/** A submitted review asks for a look at the work: a complaint, or a low rating. */
export const needsAttention = (r) => r?.status === 'submitted' && (!!r.complaint || bandOf(workScore(r)) === 'low');

/** Which gallery review filters a work's review falls under (several can: a low rating that is also a complaint). */
export const reviewFiltersOf = (r) => {
  if (!r) return [];
  if (r.status === 'pending') return ['waiting'];
  if (r.status !== 'submitted') return [];
  const out = [];
  const band = bandOf(workScore(r));
  if (band !== 'none') out.push(band);
  if (r.complaint) out.push('complaint');
  return out;
};

const roleOf = (s) => (s?.roleType === 'lead' ? 'Lead Artist' : s?.roleType === 'assistant' ? 'Assistant' : s?.role ? String(s.role) : 'Team member');

/** A person's key: their employee id, else their name ("n:sana k") for records from before ids were kept. */
export const artistKey = (id, name) => (id ? String(id) : `n:${String(name ?? '').trim().toLowerCase()}`);

/** Adds one person to [team] (deduped by id, else by name; a Lead Artist role wins). */
const addMember = (team, { id = '', name = '', role = 'Team member' }) => {
  const n = String(name ?? '').trim();
  if (!id && !n) return;
  const same = team.find((m) => (id && m.id === id) || (n && m.name.toLowerCase() === n.toLowerCase()));
  if (same) {
    if (!same.id && id) {
      same.id = id;
      same.key = id;
    }
    if (!same.name && n) same.name = n;
    if (role === 'Lead Artist') same.role = role;
    return;
  }
  team.push({ key: artistKey(id, n), id, name: n, role });
};

const leadFirst = (team) => team.sort((a, b) => (a.role === 'Lead Artist' ? 0 : 1) - (b.role === 'Lead Artist' ? 0 : 1));

/** The artists on a booking (the whole booking and each package; drivers left out), the lead first. */
export const teamOfBooking = (booking) => {
  const team = [];
  const add = (list) => {
    for (const s of list ?? []) if (s && s.roleType !== 'driver') addMember(team, { id: s.employeeId ? idOf(s.employeeId) : '', name: s.artistName, role: roleOf(s) });
  };
  add(booking?.assignedStaff);
  for (const it of booking?.bookingItems ?? []) add(it?.assignedStaff);
  return leadFirst(team);
};

/** The artists the client rated (the review's own record of the team when it was sent); [] when it kept none. */
export const teamOfReview = (r) => {
  const team = [];
  for (const m of r?.teamMembers ?? []) if (m) addMember(team, { id: m.employeeId ? idOf(m.employeeId) : '', name: m.name, role: m.role || 'Team member' });
  if (!team.length) for (const n of r?.artistNames ?? []) addMember(team, { name: n, role: n === r.artistName ? 'Lead Artist' : 'Team member' });
  return leadFirst(team);
};

/** Who a work's rating counts for: the team the client rated (a submitted review), else who is on the booking now. */
export const workTeam = (booking, review) => {
  const rated = review?.status === 'submitted' ? teamOfReview(review) : [];
  return rated.length ? rated : booking ? teamOfBooking(booking) : teamOfReview(review);
};

/** The client's review as the gallery shows it. null = no review was sent for the work yet. */
export const reviewView = (r) => {
  if (!r) return null;
  const base = { id: idOf(r), status: r.status, sentAt: r.sentAt ?? r.createdAt ?? null, submittedAt: r.submittedAt ?? null };
  if (r.status !== 'submitted') return base;
  const score = workScore(r);
  return {
    ...base,
    score,
    band: bandOf(score),
    overall: rating(r.overall),
    nps: r.nps ?? null,
    brideScore: rating(r.brideScore),
    teamScore: rating(r.teamMemberScore),
    areas: SCORE_AREAS.map((a) => ({ key: a.key, label: a.label, value: rating(a.get(r)) })).filter((a) => a.value > 0),
    answers: ANSWERS.filter(([k]) => r[k]).map(([k, label]) => ({ label, value: ANSWER_WORDS[r[k]] ?? String(r[k]) })),
    likedMost: r.likedMost ?? '',
    couldBeBetter: r.couldBeBetter ?? '',
    artistDidWell: r.teamMemberDidWell ?? '',
    artistImprove: r.teamMemberImprove ?? '',
    testimonial: r.testimonial ?? '',
    marketingConsent: !!r.marketingConsent,
    complaint: !!r.complaint,
    compliment: !!r.compliment,
    followUpRequired: !!r.followUpRequired,
    needsAttention: needsAttention(r),
  };
};

/** The work's event day ('YYYY-MM-DD'): its first chosen date, else the booking date. */
export const eventDayOf = (booking) => {
  const days = [...(booking?.selectedDates ?? []), ...(booking?.bookingItems ?? []).flatMap((i) => i?.selectedDates ?? [])].map(String).filter((d) => /^\d{4}-\d{2}-\d{2}/.test(d)).map((d) => d.slice(0, 10)).sort();
  if (days.length) return days[0];
  const t = new Date(booking?.bookingDate ?? NaN);
  return Number.isNaN(t.getTime()) ? '' : istDayKey(t);
};

/** The work a gallery item came from, with its artists and the client's review. [workDay] = the day of a multi-day work it shows. */
export const workView = (booking, review, { workDay = '' } = {}) => {
  const services = [...new Set([...(booking?.bookingItems ?? []).map((i) => String(i?.service ?? '').trim()), String(booking?.service ?? '').trim()].filter(Boolean))];
  return {
    bookingId: booking ? idOf(booking) : idOf(review?.booking),
    bookingNumber: booking?.bookingNumber ?? review?.bookingNumber ?? '',
    client: booking?.customerName ?? review?.brideName ?? '',
    eventDay: booking ? eventDayOf(booking) : review?.weddingDate ? istDayKey(new Date(review.weddingDate)) : '',
    workDay,
    services: services.slice(0, 4),
    place: [booking?.district, booking?.address].map((x) => String(x ?? '').trim()).find(Boolean) ?? review?.venue ?? '',
    bookingStatus: booking?.status ?? '',
    artists: workTeam(booking, review).map(({ key, id, name, role }) => ({ key, id, name, role })),
    review: reviewView(review),
  };
};

/**
 * The quality of each artist's work from the clients' reviews — every artist on a work gets its rating. [works] = workView rows
 * (with `assets`: how many gallery items the work has). Names kept without an id are joined to the person whose id another work
 * names. Rows needing a look come first: complaints, then low ratings, then the lowest average.
 */
export const qualityByArtist = (works) => {
  const idByName = new Map();
  for (const w of works) for (const a of w.artists ?? []) if (a.id && a.name) idByName.set(a.name.toLowerCase(), a.id);
  const rows = new Map();
  const rowOf = (a) => {
    const id = a.id || idByName.get(String(a.name ?? '').toLowerCase()) || '';
    const key = artistKey(id, a.name);
    if (!rows.has(key)) rows.set(key, { key, id, name: a.name, works: 0, reviewed: 0, waiting: 0, scores: [], npsValues: [], complaints: 0, low: 0, great: 0, assets: 0, areas: new Map(), lastIssueDay: '' });
    const row = rows.get(key);
    if (!row.name && a.name) row.name = a.name;
    return row;
  };
  for (const w of works) {
    const r = w.review;
    const seen = new Set();
    for (const a of w.artists ?? []) {
      const row = rowOf(a);
      if (seen.has(row.key)) continue; // the same person twice on one work counts once
      seen.add(row.key);
      row.works += 1;
      row.assets += w.assets ?? 0;
      if (r?.status === 'pending') row.waiting += 1;
      if (r?.status !== 'submitted') continue;
      row.reviewed += 1;
      if (r.score > 0) row.scores.push(r.score);
      if (r.nps != null) row.npsValues.push(r.nps);
      if (r.complaint) row.complaints += 1;
      if (r.band === 'low') row.low += 1;
      if (r.band === 'great') row.great += 1;
      if ((r.complaint || r.band === 'low') && w.eventDay > row.lastIssueDay) row.lastIssueDay = w.eventDay;
      for (const ar of r.areas ?? []) row.areas.set(ar.key, [...(row.areas.get(ar.key) ?? []), ar.value]);
    }
  }
  const out = [...rows.values()].map((row) => {
    const areas = SCORE_AREAS.filter((a) => row.areas.has(a.key)).map((a) => ({ key: a.key, label: a.label, avg: avg(row.areas.get(a.key)), count: row.areas.get(a.key).length }));
    // the weakest area (below 4 stars) — where this artist's work loses the clients
    const weakest = [...areas].filter((a) => a.avg < 4).sort((a, b) => a.avg - b.avg)[0] ?? null;
    const n = npsOf(row.npsValues);
    return {
      key: row.key,
      id: row.id,
      name: row.name,
      works: row.works,
      reviewed: row.reviewed,
      waiting: row.waiting,
      avgScore: avg(row.scores),
      nps: n.nps,
      npsResponses: n.responses,
      complaints: row.complaints,
      low: row.low,
      great: row.great,
      assets: row.assets,
      areas,
      weakest,
      lastIssueDay: row.lastIssueDay,
      needsAttention: row.complaints > 0 || row.low > 0,
    };
  });
  return out.sort((a, b) => b.complaints - a.complaints || b.low - a.low || (a.avgScore ?? 99) - (b.avgScore ?? 99) || b.reviewed - a.reviewed || a.name.localeCompare(b.name));
};

/** The figures over every work (each work once, however many artists were on it). */
export const qualityTotals = (works) => {
  const done = works.filter((w) => w.review?.status === 'submitted');
  const scores = done.map((w) => w.review.score).filter((s) => s > 0);
  const n = npsOf(done.map((w) => w.review.nps));
  return {
    works: works.length,
    reviewed: done.length,
    waiting: works.filter((w) => w.review?.status === 'pending').length,
    avgScore: avg(scores),
    nps: n.nps,
    complaints: done.filter((w) => w.review.complaint).length,
    low: done.filter((w) => w.review.band === 'low').length,
    great: done.filter((w) => w.review.band === 'great').length,
  };
};

/** A work comes first when it needs a look: complaints, then the lowest rating, then the ones still waiting, newest first. */
export const worstFirst = (a, b) => {
  const rank = (w) => (w.review?.status === 'submitted' ? (w.review.complaint ? 0 : 1) : 2);
  return rank(a) - rank(b) || (a.review?.score || 9) - (b.review?.score || 9) || String(b.eventDay).localeCompare(String(a.eventDay));
};
