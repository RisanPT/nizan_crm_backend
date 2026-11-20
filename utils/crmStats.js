// THE CRM FIGURES — how well the CRM team (or one member) handled booking requests, client chats, reviews, cases, trials and
// re-engagement calls over a period. Pure: the controller loads the records (controllers/crmOverviewController.js) and these add
// them up. tests/crmStats.test.js.
//
// The rules that run through all of it:
//   • A figure that cannot be known is null — shown as "—" — never 0. (No answered chats → no reply time, not "0 min".)
//   • Some things were not recorded before the CRM records began (`trackingSince`): who owned or decided a request, who owns a review's
//     booking or a trial, cases, re-engagement calls. Those figures are null for a period that ended before then (TRACKED below).
//   • A person is credited with what they OWN: a request's decision goes to whoever owned it when it was decided (else whoever decided);
//     a chat reply to whoever wrote it; a case, a trial and a review to the current owner.

import { decisionCreditOf, requestArrivedAt } from './crmBookingAudit.js';
import { normalizePhone } from './phone.js';
import { npsOf } from './nps.js';

const HOUR_MS = 3600 * 1000;
const MIN_MS = 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const idOf = (v) => (v == null ? '' : String(v._id ?? v));
const ms = (d) => (d == null ? NaN : new Date(d).getTime());
export const inWindow = (d, { start, end }) => {
  const t = ms(d);
  return Number.isFinite(t) && t >= ms(start) && t <= ms(end);
};
const round1 = (n) => Math.round(n * 10) / 10;
/// The IST day ('YYYY-MM-DD') of an instant — a trial is held on a day, not at an instant.
export const dayOf = (d) => new Date(ms(d) + 330 * MIN_MS).toISOString().slice(0, 10);

/// The middle value (the mean of the two middle ones for an even count); null for none.
export const median = (xs) => {
  const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};

/// [num] out of [den] as a percentage with one decimal; null when there is nothing to divide by.
export const pct = (num, den) => (den > 0 ? round1((num / den) * 100) : null);

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

// ── booking requests ────────────────────────────────────────────────────────

/**
 * [bookings]: public requests ({ statusHistory (first entry is enough), createdAt, crmOwnerId, requestDecision, requestDecidedAt,
 * requestDecidedBy, decidedOwnerId }). For a member, [memberId]: the requests they owned / were credited with.
 */
export const requestStats = (bookings, win, { slaHours, memberId = null }) => {
  const mine = (b, credit) => !memberId || idOf(credit) === String(memberId);
  const received = bookings.filter((b) => inWindow(requestArrivedAt(b), win) && mine(b, b.crmOwnerId));
  const decided = bookings.filter((b) => inWindow(b.requestDecidedAt, win) && mine(b, decisionCreditOf(b)));
  const confirmed = decided.filter((b) => String(b.requestDecision).toLowerCase() === 'confirmed');
  const hours = decided.map((b) => (ms(b.requestDecidedAt) - ms(requestArrivedAt(b))) / HOUR_MS).filter((h) => Number.isFinite(h) && h >= 0);
  const median_ = median(hours);
  return {
    received: received.length,
    decided: decided.length,
    confirmed: confirmed.length,
    confirmRate: pct(confirmed.length, decided.length),
    medianHours: median_ == null ? null : round1(median_),
    withinSlaPct: pct(hours.filter((h) => h <= slaHours).length, hours.length),
  };
};

// ── client chat ─────────────────────────────────────────────────────────────

/**
 * The WAITS in the client chat. [messages]: { conversationId, senderType client|staff|system, senderId, createdAt }, in any order.
 * A client message when nobody is waiting starts a wait (more client messages before an answer belong to the same wait); the first STAFF
 * message ends it and is credited to its writer. System messages neither start nor end one. A wait nobody answered has replyAt null.
 * → [{ conversationId, clientAt, replyAt, replierId, replierName }]
 */
export const chatEpisodes = (messages) => {
  const sorted = [...messages].sort((a, b) => idOf(a.conversationId).localeCompare(idOf(b.conversationId)) || ms(a.createdAt) - ms(b.createdAt));
  const out = [];
  let convo = null;
  let waiting = null;
  const flush = () => {
    if (waiting) out.push({ ...waiting, replyAt: null, replierId: null, replierName: '' });
    waiting = null;
  };
  for (const m of sorted) {
    const c = idOf(m.conversationId);
    if (c !== convo) {
      flush();
      convo = c;
    }
    if (m.senderType === 'client') {
      if (!waiting) waiting = { conversationId: c, clientAt: new Date(m.createdAt) };
    } else if (m.senderType === 'staff' && waiting) {
      out.push({ ...waiting, replyAt: new Date(m.createdAt), replierId: m.senderId ? idOf(m.senderId) : null, replierName: m.senderName || '' });
      waiting = null;
    }
  }
  flush();
  return out;
};

/**
 * How the waits that STARTED in the period went. [assigneeOf](conversationId) → who holds the chat now (for a member's unanswered
 * waits). Within the time limit: of the waits whose fate is known (answered, or unanswered past the limit), the share answered in time.
 */
export const chatStats = (episodes, win, { slaMins, unansweredHours, now = new Date(), memberId = null, assigneeOf = () => '' }) => {
  const at = ms(now);
  const mine = (e) => !memberId || (e.replyAt ? e.replierId === String(memberId) : assigneeOf(e.conversationId) === String(memberId));
  const waits = episodes.filter((e) => inWindow(e.clientAt, win) && mine(e));
  const answered = waits.filter((e) => e.replyAt);
  const mins = answered.map((e) => (ms(e.replyAt) - ms(e.clientAt)) / MIN_MS);
  const known = waits.filter((e) => e.replyAt || at - ms(e.clientAt) > slaMins * MIN_MS);
  const inTime = answered.filter((e) => ms(e.replyAt) - ms(e.clientAt) <= slaMins * MIN_MS);
  const m = median(mins);
  return {
    conversations: new Set(waits.map((e) => e.conversationId)).size,
    waits: waits.length,
    answered: answered.length,
    medianReplyMins: m == null ? null : Math.round(m),
    withinSlaPct: pct(inTime.length, known.length),
    unanswered: waits.filter((e) => !e.replyAt && at - ms(e.clientAt) > unansweredHours * HOUR_MS).length,
  };
};

// ── reviews ─────────────────────────────────────────────────────────────────

/**
 * [reviews]: { booking, sentAt, submittedAt, nps, overall, complaint }. [ownerOf](bookingId) → the booking's CRM owner (a member is
 * credited with the reviews of the bookings they own).
 */
export const reviewStats = (reviews, win, { memberId = null, ownerOf = () => '' } = {}) => {
  const mine = (r) => !memberId || ownerOf(idOf(r.booking)) === String(memberId);
  const sent = reviews.filter((r) => inWindow(r.sentAt, win) && mine(r));
  const submitted = reviews.filter((r) => inWindow(r.submittedAt, win) && mine(r));
  const ratings = submitted.map((r) => Number(r.overall)).filter((v) => v > 0);
  const n = npsOf(submitted.map((r) => r.nps));
  return {
    sent: sent.length,
    submitted: submitted.length,
    responseRate: pct(sent.filter((r) => r.submittedAt).length, sent.length),
    nps: n.nps,
    npsResponses: n.responses,
    promoters: n.promoters,
    detractors: n.detractors,
    avgRating: ratings.length ? round1(mean(ratings)) : null,
    complaints: submitted.filter((r) => r.complaint === true).length,
  };
};

// ── cases ───────────────────────────────────────────────────────────────────

/// [cases]: { kind, status, ownerId, createdAt, dueAt, resolvedAt, closedAt }. A member: the cases they own.
export const caseStats = (cases, win, { memberId = null } = {}) => {
  const mine = (c) => !memberId || idOf(c.ownerId) === String(memberId);
  const own = cases.filter(mine);
  const opened = own.filter((c) => inWindow(c.createdAt, win));
  const resolved = own.filter((c) => inWindow(c.resolvedAt, win));
  const onTime = resolved.filter((c) => ms(c.resolvedAt) <= ms(c.dueAt));
  const hours = resolved.map((c) => (ms(c.resolvedAt) - ms(c.createdAt)) / HOUR_MS).filter((h) => Number.isFinite(h) && h >= 0);
  const avg = mean(hours);
  return {
    opened: opened.length,
    complaints: opened.filter((c) => c.kind === 'complaint').length,
    resolved: resolved.length,
    closed: own.filter((c) => inWindow(c.closedAt, win)).length,
    // of the cases opened in the period, how many are resolved by now
    resolutionRate: pct(opened.filter((c) => c.status === 'resolved').length, opened.length),
    onTimePct: pct(onTime.length, resolved.length),
    avgResolveHours: avg == null ? null : round1(avg),
  };
};

// ── trials ──────────────────────────────────────────────────────────────────

/// Bookings by client phone: Map(last 10 digits → [createdAt ms, …]) — what "the client booked" is checked against.
export const bookingsByPhone = (bookings) => {
  const map = new Map();
  for (const b of bookings) {
    const k = normalizePhone(b.phone);
    if (!k) continue;
    const list = map.get(k) ?? [];
    list.push(ms(b.createdAt));
    map.set(k, list);
  }
  return map;
};

export const bookedBetween = (byPhone, phone, from, to) => (byPhone.get(normalizePhone(phone)) ?? []).some((t) => t >= from && t <= to);

/**
 * [trials] held in the period ({ phone, status, trialDate 'YYYY-MM-DD', bookingId, convertedBookingId, crmOwnerId }).
 * Converted: linked to the booking it became, or the client booked within [conversionDays] of the trial. A trial that was for a booking
 * that already existed (bookingId) is not a sale to count. A completed trial still inside its window and not yet converted is
 * MATURING — left out of the rate until its window closes.
 */
export const trialStats = (trials, byPhone, { conversionDays, now = new Date(), memberId = null }) => {
  const at = ms(now);
  const mine = (t) => !memberId || idOf(t.crmOwnerId) === String(memberId);
  const own = trials.filter(mine);
  const completed = own.filter((t) => t.status === 'completed');
  const forSale = completed.filter((t) => !t.bookingId);
  let converted = 0;
  let maturing = 0;
  for (const t of forSale) {
    const day = ms(`${t.trialDate}T00:00:00+05:30`);
    const until = day + conversionDays * DAY_MS;
    if (t.convertedBookingId || bookedBetween(byPhone, t.phone, day, until)) converted += 1;
    else if (until > at) maturing += 1;
  }
  return {
    scheduled: own.filter((t) => t.status !== 'cancelled').length,
    completed: completed.length,
    alreadyBooked: completed.length - forSale.length,
    converted,
    maturing,
    conversionPct: pct(converted, forSale.length - maturing),
  };
};

// ── re-engagement ───────────────────────────────────────────────────────────

const CONTACT = new Set(['call', 'whatsapp']);

/**
 * [cases]: re-engagement cases with their activities. Calls: the calls and WhatsApps logged in the period (by the member, for a
 * member). Contacted: the cases FIRST contacted in the period (each case belongs to one period). Won: a contacted case marked won, or
 * whose client booked within [winDays] of that first contact — even when the booking came after the period ended.
 */
export const reEngagementStats = (cases, byPhone, win, { winDays, memberId = null }) => {
  let calls = 0;
  let contacted = 0;
  let won = 0;
  for (const c of cases) {
    const touches = (c.activities ?? []).filter((a) => CONTACT.has(a.type));
    calls += touches.filter((a) => inWindow(a.at, win) && (!memberId || idOf(a.by) === String(memberId))).length;
    if (!touches.length || (memberId && idOf(c.ownerId) !== String(memberId))) continue;
    const first = Math.min(...touches.map((a) => ms(a.at)));
    if (!inWindow(first, win)) continue;
    contacted += 1;
    if (c.outcome === 'won' || c.wonBookingId || bookedBetween(byPhone, c.phone, first, first + winDays * DAY_MS)) won += 1;
  }
  return { calls, contacted, won, winRate: pct(won, contacted) };
};

// ── putting it together ─────────────────────────────────────────────────────

/// The figures that need records the CRM only keeps since `trackingSince` (team-wide and per person) …
const TRACKED = ['requests', 'cases', 'reEngagement'];
/// … and the ones that are known for the past team-wide but only since then per person.
const TRACKED_PER_PERSON = ['reviews', 'trials'];

/**
 * All the figures of one period: { requests, chats, confirmations, reviews, cases, trials, reEngagement } — each section's values, or
 * nulls for a section that could not have been recorded then (the period ended before `trackingSince`).
 */
export const measure = (data, win, ctx) => {
  const before = ms(win.end) < ms(ctx.trackingSince);
  const blank = (section, obj) => (before && (TRACKED.includes(section) || (ctx.memberId && TRACKED_PER_PERSON.includes(section))) ? Object.fromEntries(Object.keys(obj).map((k) => [k, null])) : obj);
  return {
    requests: blank('requests', requestStats(data.requests, win, { slaHours: ctx.settings.requestSlaHours, memberId: ctx.memberId })),
    chats: chatStats(data.episodes, win, {
      slaMins: ctx.settings.chatResponseSlaMins,
      unansweredHours: ctx.settings.chatUnansweredHours,
      now: ctx.now,
      memberId: ctx.memberId,
      assigneeOf: ctx.assigneeOf,
    }),
    confirmations: { sent: data.confirmations.filter((s) => inWindow(s.createdAt, win) && (!ctx.memberId || idOf(s.sentBy) === String(ctx.memberId))).length },
    reviews: blank('reviews', reviewStats(data.reviews, win, { memberId: ctx.memberId, ownerOf: ctx.ownerOf })),
    cases: blank('cases', caseStats(data.cases, win, { memberId: ctx.memberId })),
    trials: blank('trials', trialStats(data.trials.filter((t) => t.trialDate >= dayOf(win.start) && t.trialDate <= dayOf(win.end)), data.byPhone, { conversionDays: ctx.settings.trialConversionDays, now: ctx.now, memberId: ctx.memberId })),
    reEngagement: blank('reEngagement', reEngagementStats(data.reCases, data.byPhone, win, { winDays: ctx.settings.reEngagementWinDays, memberId: ctx.memberId })),
  };
};

/**
 * The KPI cards: { key: { value, prev, n, unit, better } } — `better` says which way is good ('up' | 'down'), `n` how many records
 * the value rests on (a median of 2 is not a median of 200).
 */
export const KPI_DEFS = [
  ['requestsReceived', 'requests', 'received', 'count', 'up', 'received'],
  ['requestsDecided', 'requests', 'decided', 'count', 'up', 'decided'],
  ['requestConfirmRate', 'requests', 'confirmRate', 'pct', 'up', 'decided'],
  ['requestMedianHours', 'requests', 'medianHours', 'hours', 'down', 'decided'],
  ['requestWithinSlaPct', 'requests', 'withinSlaPct', 'pct', 'up', 'decided'],
  ['chatWaits', 'chats', 'waits', 'count', 'up', 'waits'],
  ['chatMedianReplyMins', 'chats', 'medianReplyMins', 'mins', 'down', 'answered'],
  ['chatWithinSlaPct', 'chats', 'withinSlaPct', 'pct', 'up', 'waits'],
  ['chatUnanswered', 'chats', 'unanswered', 'count', 'down', 'waits'],
  ['confirmationsSent', 'confirmations', 'sent', 'count', 'up', 'sent'],
  ['reviewsSent', 'reviews', 'sent', 'count', 'up', 'sent'],
  ['reviewResponseRate', 'reviews', 'responseRate', 'pct', 'up', 'sent'],
  ['reviewsSubmitted', 'reviews', 'submitted', 'count', 'up', 'submitted'],
  ['nps', 'reviews', 'nps', 'score', 'up', 'npsResponses'],
  ['avgRating', 'reviews', 'avgRating', 'rating', 'up', 'submitted'],
  ['casesOpened', 'cases', 'opened', 'count', 'down', 'opened'],
  ['casesResolved', 'cases', 'resolved', 'count', 'up', 'resolved'],
  ['caseOnTimePct', 'cases', 'onTimePct', 'pct', 'up', 'resolved'],
  ['caseAvgResolveHours', 'cases', 'avgResolveHours', 'hours', 'down', 'resolved'],
  ['trialsScheduled', 'trials', 'scheduled', 'count', 'up', 'scheduled'],
  ['trialsCompleted', 'trials', 'completed', 'count', 'up', 'completed'],
  ['trialConversionPct', 'trials', 'conversionPct', 'pct', 'up', 'completed'],
  ['reCalls', 'reEngagement', 'calls', 'count', 'up', 'calls'],
  ['reWins', 'reEngagement', 'won', 'count', 'up', 'contacted'],
  ['reWinRate', 'reEngagement', 'winRate', 'pct', 'up', 'contacted'],
];

export const kpisOf = (cur, prev) => {
  const out = {};
  for (const [key, section, field, unit, better, nField] of KPI_DEFS) {
    out[key] = {
      value: cur?.[section]?.[field] ?? null,
      prev: prev ? prev[section]?.[field] ?? null : null,
      n: cur?.[section]?.[nField] ?? null,
      unit,
      better,
    };
  }
  return out;
};
