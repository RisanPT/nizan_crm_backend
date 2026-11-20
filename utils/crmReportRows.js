// THE CRM REPORT's rows — what the Excel workbook and the PDF say, made once from the same records the dashboard adds up
// (services/crmMetrics.js loadCrmData), so the report and the dashboard always agree. Pure — tests/crmReportRows.test.js.
//
// A member's report holds what is CREDITED to them, by the same rules as their figures (utils/crmStats.js): the requests they owned or
// decided, the chats they answered or hold, the reviews and trials of what they own, their cases and calls.

import { decisionCreditOf, requestArrivedAt } from './crmBookingAudit.js';
import { bookedBetween, dayOf, inWindow, KPI_DEFS } from './crmStats.js';
import { resolvedOnTime } from './crmCaseRules.js';

const MIN_MS = 60 * 1000;
const HOUR_MS = 60 * MIN_MS;
const DAY_MS = 24 * HOUR_MS;
const idOf = (v) => (v == null ? '' : String(v._id ?? v));
const ms = (d) => (d == null ? NaN : new Date(d).getTime());
const round1 = (n) => Math.round(n * 10) / 10;
const cap = (s) => (s ? String(s).charAt(0).toUpperCase() + String(s).slice(1).replace(/_/g, ' ') : '');

/// "17 Nov 2026, 3:05 pm" (IST) — or '' for no time.
export const istText = (d) => {
  if (d == null || Number.isNaN(ms(d))) return '';
  return new Date(d).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });
};

// ── the summary ─────────────────────────────────────────────────────────────

export const KPI_LABELS = {
  requestsReceived: 'Booking requests received',
  requestsDecided: 'Booking requests decided',
  requestConfirmRate: 'Requests confirmed (of decided)',
  requestMedianHours: 'Time to decide a request (median)',
  requestWithinSlaPct: 'Requests decided within the time limit',
  chatWaits: 'Client chat messages waiting for an answer',
  chatMedianReplyMins: 'Time to first answer in chat (median)',
  chatWithinSlaPct: 'Chats answered within the time limit',
  chatUnanswered: 'Chats left unanswered',
  confirmationsSent: 'Booking confirmations sent on WhatsApp',
  reviewsSent: 'Review forms sent',
  reviewResponseRate: 'Review forms answered (of sent)',
  reviewsSubmitted: 'Client reviews received',
  nps: 'NPS (net promoter score)',
  avgRating: 'Average overall rating',
  casesOpened: 'Cases opened',
  casesResolved: 'Cases resolved',
  caseOnTimePct: 'Cases resolved on time',
  caseAvgResolveHours: 'Time to resolve a case (average)',
  trialsScheduled: 'Trials in the period (not cancelled)',
  trialsCompleted: 'Trials completed',
  trialConversionPct: 'Trials that became bookings',
  reCalls: 'Re-engagement calls and WhatsApps',
  reWins: 'Re-engagement wins',
  reWinRate: 'Re-engagement win rate',
};

/// A figure as it reads: "12", "66.7%", "9 h", "105 min", "4.5 / 5" — and "—" when it cannot be known.
export const formatKpi = (value, unit) => {
  if (value == null) return '—';
  switch (unit) {
    case 'pct':
      return `${value}%`;
    case 'hours':
      return `${value} h`;
    case 'mins':
      return `${value} min`;
    case 'rating':
      return `${value} / 5`;
    default:
      return String(value);
  }
};

/// The change from the previous period: "+3", "−12.5 pts" (for a percentage), "—" when either side is unknown.
export const changeText = ({ value, prev, unit }) => {
  if (value == null || prev == null) return '—';
  const d = round1(value - prev);
  if (d === 0) return 'no change';
  const sign = d > 0 ? '+' : '−';
  const abs = Math.abs(d);
  if (unit === 'pct') return `${sign}${abs} pts`;
  if (unit === 'hours') return `${sign}${abs} h`;
  if (unit === 'mins') return `${sign}${abs} min`;
  return `${sign}${abs}`;
};

/// Was the change for the better? 'better' | 'worse' | '' (no change / unknown).
export const changeVerdict = ({ value, prev, better }) => {
  if (value == null || prev == null || value === prev) return '';
  return (value > prev) === (better === 'up') ? 'better' : 'worse';
};

/// One line per KPI: { key, label, value, prev, change, verdict, n }.
export const summaryRows = (kpis) =>
  KPI_DEFS.map(([key]) => {
    const k = kpis[key];
    return {
      key,
      label: KPI_LABELS[key],
      value: formatKpi(k.value, k.unit),
      prev: formatKpi(k.prev, k.unit),
      change: changeText(k),
      verdict: changeVerdict(k),
      n: k.n == null ? '' : k.n,
    };
  });

/// One line per team member, from the overview's members.
export const teamRows = (members) =>
  members.map((m) => ({
    name: `${m.name}${m.isHead ? ' (Head)' : ''}`,
    open: m.workload.total,
    overdue: m.workload.overdue,
    decided: formatKpi(m.kpis.requestsDecided.value, 'count'),
    decideTime: formatKpi(m.kpis.requestMedianHours.value, 'hours'),
    decideInTime: formatKpi(m.kpis.requestWithinSlaPct.value, 'pct'),
    chats: formatKpi(m.kpis.chatWaits.value, 'count'),
    replyTime: formatKpi(m.kpis.chatMedianReplyMins.value, 'mins'),
    replyInTime: formatKpi(m.kpis.chatWithinSlaPct.value, 'pct'),
    casesResolved: formatKpi(m.kpis.casesResolved.value, 'count'),
    casesOnTime: formatKpi(m.kpis.caseOnTimePct.value, 'pct'),
    calls: formatKpi(m.kpis.reCalls.value, 'count'),
    wins: formatKpi(m.kpis.reWins.value, 'count'),
    nps: formatKpi(m.kpis.nps.value, 'score'),
  }));

// ── the detail ──────────────────────────────────────────────────────────────

const mineBy = (memberId) => (v) => !memberId || idOf(v) === String(memberId);

/// Each request that arrived or was decided in the period (oldest first).
export const requestRows = (requests, win, { memberId = null, slaHours }) => {
  const mine = mineBy(memberId);
  return requests
    .filter((b) => (inWindow(requestArrivedAt(b), win) && mine(b.crmOwnerId)) || (inWindow(b.requestDecidedAt, win) && mine(decisionCreditOf(b))))
    .sort((a, b) => ms(requestArrivedAt(a)) - ms(requestArrivedAt(b)))
    .map((b) => {
      const arrived = requestArrivedAt(b);
      const hours = b.requestDecidedAt ? round1((ms(b.requestDecidedAt) - ms(arrived)) / HOUR_MS) : null;
      return {
        bookingNo: b.bookingNumber || '',
        client: b.customerName || '',
        phone: b.phone || '',
        arrived: istText(arrived),
        owner: b.crmOwnerName || '',
        decision: b.requestDecidedAt ? cap(b.requestDecision) : 'Waiting',
        decidedAt: istText(b.requestDecidedAt),
        decidedBy: b.requestDecidedByName || '',
        hours,
        inTime: hours == null ? '' : hours <= slaHours ? 'Yes' : 'No',
      };
    });
};

/// Each wait in the client chat that started in the period.
export const chatRows = (episodes, win, { memberId = null, assigneeOf = () => '', nameOf = () => '', slaMins, unansweredHours, now = new Date() }) =>
  episodes
    .filter((e) => inWindow(e.clientAt, win) && (!memberId || (e.replyAt ? e.replierId === String(memberId) : assigneeOf(e.conversationId) === String(memberId))))
    .sort((a, b) => ms(a.clientAt) - ms(b.clientAt))
    .map((e) => {
      const mins = e.replyAt ? Math.round((ms(e.replyAt) - ms(e.clientAt)) / MIN_MS) : null;
      const waitedLong = !e.replyAt && ms(now) - ms(e.clientAt) > unansweredHours * HOUR_MS;
      return {
        client: nameOf(e.conversationId),
        waitingSince: istText(e.clientAt),
        answeredAt: istText(e.replyAt),
        answeredBy: e.replierName || '',
        minutes: mins,
        inTime: mins == null ? (ms(now) - ms(e.clientAt) > slaMins * MIN_MS ? 'No' : '') : mins <= slaMins ? 'Yes' : 'No',
        state: e.replyAt ? 'Answered' : waitedLong ? 'Left unanswered' : 'Waiting',
      };
    });

/// Each review sent or answered in the period.
export const reviewRows = (reviews, win, { memberId = null, ownerOf = () => '', ownerNameOf = () => '' }) =>
  reviews
    .filter((r) => (inWindow(r.sentAt, win) || inWindow(r.submittedAt, win)) && (!memberId || ownerOf(idOf(r.booking)) === String(memberId)))
    .sort((a, b) => ms(a.sentAt) - ms(b.sentAt))
    .map((r) => ({
      bookingNo: r.bookingNumber || '',
      client: r.brideName || '',
      owner: ownerNameOf(idOf(r.booking)),
      sent: istText(r.sentAt),
      sentBy: r.manualSentByName || r.sentByName || '',
      answered: istText(r.submittedAt),
      nps: r.nps ?? null,
      rating: Number(r.overall) > 0 ? Number(r.overall) : null,
      complaint: r.complaint ? 'Yes' : '',
    }));

const KIND = { complaint: 'Complaint', follow_up: 'Follow-up', re_engagement: 'Re-engagement', trial_follow_up: 'Trial follow-up' };

/// Each case opened, resolved or closed in the period.
export const caseRows = (cases, win, { memberId = null, now = new Date() }) => {
  const mine = mineBy(memberId);
  return cases
    .filter((c) => mine(c.ownerId) && (inWindow(c.createdAt, win) || inWindow(c.resolvedAt, win) || inWindow(c.closedAt, win)))
    .sort((a, b) => ms(a.createdAt) - ms(b.createdAt))
    .map((c) => {
      const open = c.status === 'open' || c.status === 'in_progress';
      return {
        caseNo: c.caseNumber || '',
        kind: KIND[c.kind] ?? cap(c.kind),
        client: c.customerName || c.title || '',
        owner: c.ownerName || 'Unassigned',
        priority: cap(c.priority),
        status: cap(c.status),
        opened: istText(c.createdAt),
        due: istText(c.dueAt),
        finished: istText(c.resolvedAt ?? c.closedAt),
        onTime: c.status === 'resolved' ? (resolvedOnTime(c) ? 'Yes' : 'No') : open && ms(c.dueAt) < ms(now) ? 'Overdue' : '',
        outcome: cap(c.outcome),
        note: c.resolutionNote || '',
      };
    });
};

/// Each trial held in the period, and whether it became a booking.
export const trialRows = (trials, byPhone, win, { memberId = null, conversionDays, now = new Date() }) => {
  const mine = mineBy(memberId);
  return trials
    .filter((t) => mine(t.crmOwnerId) && t.trialDate >= dayOf(win.start) && t.trialDate <= dayOf(win.end))
    .sort((a, b) => String(a.trialDate).localeCompare(String(b.trialDate)))
    .map((t) => {
      let result = '';
      if (t.status === 'completed') {
        const day = ms(`${t.trialDate}T00:00:00+05:30`);
        const until = day + conversionDays * DAY_MS;
        if (t.bookingId) result = 'For an existing booking';
        else if (t.convertedBookingId || bookedBetween(byPhone, t.phone, day, until)) result = 'Booked';
        else result = until > ms(now) ? 'Not yet (still in the window)' : 'Did not book';
      }
      return { trialNo: t.trialNumber || '', client: t.clientName || '', phone: t.phone || '', date: t.trialDate, status: cap(t.status), owner: t.crmOwnerName || '', result };
    });
};

/// Each re-engagement case contacted in the period: its calls in the period, the first contact and whether it was won.
export const reEngagementRows = (cases, byPhone, win, { memberId = null, winDays }) => {
  const rows = [];
  for (const c of cases) {
    const touches = (c.activities ?? []).filter((a) => a.type === 'call' || a.type === 'whatsapp');
    const inPeriod = touches.filter((a) => inWindow(a.at, win) && (!memberId || idOf(a.by) === String(memberId)));
    if (!inPeriod.length || (memberId && idOf(c.ownerId) !== String(memberId))) continue;
    const first = Math.min(...touches.map((a) => ms(a.at)));
    const won = c.outcome === 'won' || !!c.wonBookingId || bookedBetween(byPhone, c.phone, first, first + winDays * DAY_MS);
    rows.push({
      caseNo: c.caseNumber || '',
      client: c.customerName || '',
      phone: c.phone || '',
      owner: c.ownerName || '',
      calls: inPeriod.length,
      firstContact: istText(new Date(first)),
      status: cap(c.status),
      outcome: cap(c.outcome),
      won: won ? 'Yes' : '',
    });
  }
  return rows.sort((a, b) => a.client.localeCompare(b.client));
};

// ── the sheets ──────────────────────────────────────────────────────────────

/// The detail sheets: [name, [[header, key, width, kind]]] — kind 'n' for a number column.
export const DETAIL_SHEETS = [
  ['Requests', 'requests', [['Booking No.', 'bookingNo', 16], ['Client', 'client', 22], ['Phone', 'phone', 14], ['Arrived', 'arrived', 20], ['Owner', 'owner', 16], ['Decision', 'decision', 11], ['Decided at', 'decidedAt', 20], ['Decided by', 'decidedBy', 16], ['Hours to decide', 'hours', 14, 'n'], ['Within limit', 'inTime', 12]]],
  ['Chats', 'chats', [['Client', 'client', 22], ['Waiting since', 'waitingSince', 20], ['Answered at', 'answeredAt', 20], ['Answered by', 'answeredBy', 16], ['Minutes to answer', 'minutes', 16, 'n'], ['Within limit', 'inTime', 12], ['State', 'state', 16]]],
  ['Reviews', 'reviews', [['Booking No.', 'bookingNo', 16], ['Client', 'client', 22], ['Owner', 'owner', 16], ['Sent', 'sent', 20], ['Sent by', 'sentBy', 16], ['Answered', 'answered', 20], ['NPS', 'nps', 6, 'n'], ['Rating', 'rating', 8, 'n'], ['Complaint', 'complaint', 10]]],
  ['Cases', 'cases', [['Case No.', 'caseNo', 17], ['Kind', 'kind', 14], ['Client', 'client', 22], ['Owner', 'owner', 16], ['Priority', 'priority', 9], ['Status', 'status', 11], ['Opened', 'opened', 20], ['Due', 'due', 20], ['Resolved / closed', 'finished', 20], ['On time', 'onTime', 9], ['Outcome', 'outcome', 14], ['Resolution note', 'note', 50]]],
  ['Trials', 'trials', [['Trial No.', 'trialNo', 16], ['Client', 'client', 22], ['Phone', 'phone', 14], ['Trial date', 'date', 12], ['Status', 'status', 11], ['Owner', 'owner', 16], ['Became a booking?', 'result', 28]]],
  ['Re-engagement', 'reEngagement', [['Case No.', 'caseNo', 17], ['Client', 'client', 22], ['Phone', 'phone', 14], ['Owner', 'owner', 16], ['Calls in period', 'calls', 14, 'n'], ['First contact', 'firstContact', 20], ['Status', 'status', 11], ['Outcome', 'outcome', 14], ['Won', 'won', 6]]],
];
