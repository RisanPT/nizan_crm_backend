import Booking from '../models/Booking.js';
import Conversation from '../models/Conversation.js';
import CrmCase from '../models/CrmCase.js';
import Message from '../models/Message.js';
import Review from '../models/Review.js';
import Trial from '../models/Trial.js';
import WhatsAppSend from '../models/WhatsAppSend.js';
import { bookingsByPhone, chatEpisodes, kpisOf, measure } from '../utils/crmStats.js';
import { istDayKey, istEnd, istStart, todayIst } from '../utils/istDate.js';
import { previousWindow } from '../utils/periodCompare.js';
import { NON_REVENUE_FILTER } from '../utils/reEngagement.js';
import { getCrmSettings } from './crmSettings.js';
import { crmTeamUsers } from './crmTeam.js';
import { emptyLoad, loadQueue, workloadByOwner } from './crmWork.js';
import { recentCrmActivity, upcomingCrmTrials } from './crmFeed.js';

// THE CRM DASHBOARD'S FIGURES for a period — the team's, or one member's — with the period before for comparison, a trend, each member's
// line (team view), the open work now and what is overdue. Loads the records ONCE for both periods; the sums are in utils/crmStats.js.
// Used by GET /api/crm/overview and the CRM report (services/crmReportFiles.js).

const DAY_MS = 24 * 3600 * 1000;
const idOf = (v) => (v == null ? '' : String(v._id ?? v));
const max = (a, b) => (a > b ? a : b);
const min = (a, b) => (a < b ? a : b);

/// Everything the figures for [range] = { start, end } need. [now] bounds what can have happened.
export const loadCrmData = async ({ start, end }, settings, now = new Date()) => {
  const inRange = { $gte: start, $lte: end };
  const lookahead = min(now, new Date(end.getTime() + max(settings.trialConversionDays, settings.reEngagementWinDays) * DAY_MS));
  const [requests, messages, confirmations, reviews, cases, reCases, trials, bookings] = await Promise.all([
    Booking.find({ origin: 'public', $or: [{ createdAt: inRange }, { requestDecidedAt: inRange }] })
      .select({ statusHistory: { $slice: 1 }, createdAt: 1, crmOwnerId: 1, crmOwnerName: 1, requestDecision: 1, requestDecidedAt: 1, requestDecidedBy: 1, requestDecidedByName: 1, decidedOwnerId: 1, customerName: 1, phone: 1, bookingNumber: 1 })
      .lean(),
    // a day before (to know whether the first message in the period continues a wait) and a week after (to see it answered)
    Message.find({ createdAt: { $gte: new Date(start.getTime() - DAY_MS), $lte: min(now, new Date(end.getTime() + 7 * DAY_MS)) } })
      .select('conversationId senderType senderId senderName createdAt')
      .lean(),
    WhatsAppSend.find({ kind: 'confirmation', ok: true, createdAt: inRange }).select('createdAt sentBy').lean(),
    Review.find({ $or: [{ sentAt: inRange }, { submittedAt: inRange }] })
      .select('booking bookingNumber brideName sentAt sentByName manualSentByName submittedAt nps overall complaint')
      .lean(),
    CrmCase.find({ $or: [{ createdAt: inRange }, { resolvedAt: inRange }, { closedAt: inRange }] })
      .select('caseNumber kind title customerName priority status ownerId ownerName createdAt dueAt resolvedAt closedAt outcome resolutionNote')
      .lean(),
    CrmCase.find({ kind: 're_engagement', 'activities.at': inRange }).select('caseNumber customerName phone status ownerId ownerName outcome wonBookingId activities.type activities.at activities.by').lean(),
    Trial.find({ trialDate: { $gte: istDayKey(start), $lte: istDayKey(end) } })
      .select('trialNumber clientName phone status trialDate bookingId convertedBookingId crmOwnerId crmOwnerName')
      .lean(),
    // what the client booked afterwards (trial conversion, re-engagement wins)
    Booking.find({ createdAt: { $gte: start, $lte: lookahead }, status: NON_REVENUE_FILTER }).select('phone createdAt').lean(),
  ]);
  const episodes = chatEpisodes(messages);
  const convoIds = [...new Set(episodes.map((e) => e.conversationId))];
  const reviewBookingIds = [...new Set(reviews.map((r) => idOf(r.booking)).filter(Boolean))];
  const [convos, reviewBookings] = await Promise.all([
    convoIds.length ? Conversation.find({ _id: { $in: convoIds } }).select('assignedStaffId clientName clientPhone').lean() : [],
    reviewBookingIds.length ? Booking.find({ _id: { $in: reviewBookingIds } }).select('crmOwnerId crmOwnerName').lean() : [],
  ]);
  const assignee = new Map(convos.map((c) => [idOf(c._id), idOf(c.assignedStaffId)]));
  const convoName = new Map(convos.map((c) => [idOf(c._id), c.clientName || c.clientPhone || '']));
  const owner = new Map(reviewBookings.map((b) => [idOf(b._id), idOf(b.crmOwnerId)]));
  const ownerName = new Map(reviewBookings.map((b) => [idOf(b._id), b.crmOwnerName || '']));
  return {
    data: { requests, episodes, confirmations, reviews, cases, reCases, trials, byPhone: bookingsByPhone(bookings) },
    assigneeOf: (id) => assignee.get(String(id)) ?? '',
    ownerOf: (id) => owner.get(String(id)) ?? '',
    // for the report's rows
    conversationNameOf: (id) => convoName.get(String(id)) ?? '',
    ownerNameOf: (id) => ownerName.get(String(id)) ?? '',
  };
};

/// The windows: the period asked for, and the earlier one it is compared with (null for a period wholly in the future).
export const windowsOf = (period, today = todayIst()) => {
  const cur = { from: period.from, to: period.to, start: istStart(period.from), end: istEnd(period.to) };
  const p = previousWindow(period.from, period.to, today);
  const prev = p ? { from: p.from, to: p.to, mode: p.mode, start: istStart(p.from), end: istEnd(p.to) } : null;
  return { cur, prev };
};

/// The trend buckets of a period: days for up to two months, months beyond.
const bucketsOf = ({ from, to }) => {
  const out = [];
  const days = Math.round((istStart(to) - istStart(from)) / DAY_MS) + 1;
  if (days <= 62) {
    for (let t = istStart(from).getTime(); t <= istStart(to).getTime(); t += DAY_MS) {
      const key = istDayKey(new Date(t));
      out.push({ key, start: istStart(key), end: istEnd(key) });
    }
    return out;
  }
  let [y, m] = from.split('-').map(Number);
  for (;;) {
    const key = `${y}-${String(m).padStart(2, '0')}`;
    if (key > to.slice(0, 7)) break;
    const first = key === from.slice(0, 7) ? from : `${key}-01`;
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const last = key === to.slice(0, 7) ? to : `${key}-${String(lastDay).padStart(2, '0')}`;
    out.push({ key, start: istStart(first), end: istEnd(last) });
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
};

const MEMBER_KPIS = ['requestsDecided', 'requestMedianHours', 'requestWithinSlaPct', 'chatWaits', 'chatMedianReplyMins', 'chatWithinSlaPct', 'casesResolved', 'caseOnTimePct', 'reCalls', 'reWins', 'nps', 'trialConversionPct'];

/**
 * The overview of [period] (from utils/reportPeriod.js) for the team, or for [member] = { userId, name }.
 * → { range, previous, scope, trackingSince, partial, kpis, sections, now, unassigned, trend, members, breaches }
 */
export const crmOverview = async (args) => (await buildCrmOverview(args)).overview;

/// The overview and what it was made from (`loaded`, `cur` window, `settings`) — the report's rows come from the same records.
export const buildCrmOverview = async ({ period, member = null, now = new Date(), withMembers = true, withTrend = true, withFeed = withTrend }) => {
  const settings = await getCrmSettings();
  const { cur, prev } = windowsOf(period, istDayKey(now));
  const range = { start: prev ? min(prev.start, cur.start) : cur.start, end: cur.end };
  const loaded = await loadCrmData(range, settings, now);
  const base = { settings, trackingSince: settings.trackingSince, now, assigneeOf: loaded.assigneeOf, ownerOf: loaded.ownerOf };
  const memberId = member ? String(member.userId) : null;
  const curM = measure(loaded.data, cur, { ...base, memberId });
  const prevM = prev ? measure(loaded.data, prev, { ...base, memberId }) : null;

  const loads = await workloadByOwner(settings, now);
  let nowLoad;
  if (memberId) nowLoad = loads.get(memberId) ?? { ...emptyLoad(), name: '' };
  else {
    nowLoad = emptyLoad();
    for (const w of loads.values()) for (const k of Object.keys(nowLoad)) nowLoad[k] += w[k];
  }
  const strip = ({ name, ...w }) => w;

  const trend = withTrend
    ? bucketsOf(cur).map((b) => {
        const m = measure(loaded.data, b, { ...base, memberId });
        return {
          key: b.key,
          requestsReceived: m.requests.received,
          requestsDecided: m.requests.decided,
          chatWaits: m.chats.waits,
          chatAnswered: m.chats.answered,
          casesOpened: m.cases.opened,
          casesResolved: m.cases.resolved,
        };
      })
    : [];

  let members = [];
  if (!memberId && withMembers) {
    const team = await crmTeamUsers();
    members = team.map((u) => {
      const k = kpisOf(measure(loaded.data, cur, { ...base, memberId: idOf(u._id) }), null);
      return {
        userId: idOf(u._id),
        name: u.name,
        isHead: u.isHead,
        workload: strip(loads.get(idOf(u._id)) ?? { ...emptyLoad(), name: '' }),
        kpis: Object.fromEntries(MEMBER_KPIS.map((key) => [key, k[key]])),
      };
    });
  }

  // the dashboard's recent activities and upcoming trials (not the report's)
  const [recent, upcomingTrials] = withFeed ? await Promise.all([recentCrmActivity({ memberId, now }), upcomingCrmTrials({ memberId, now })]) : [[], []];

  const overdue = (await loadQueue(memberId ? { scope: 'member', ownerId: memberId } : { scope: 'all', ownerId: null }, ['booking', 'conversation', 'case', 'trial'], settings, now)).filter((i) => i.overdue);

  const overview = {
    range: { from: period.from, to: period.to, label: period.label, days: period.days },
    previous: prev ? { from: prev.from, to: prev.to, mode: prev.mode } : null,
    scope: memberId ? { kind: 'member', userId: memberId, name: member.name ?? '' } : { kind: 'team' },
    trackingSince: settings.trackingSince,
    partial: cur.start < new Date(settings.trackingSince),
    settings: {
      requestSlaHours: settings.requestSlaHours,
      chatResponseSlaMins: settings.chatResponseSlaMins,
      chatUnansweredHours: settings.chatUnansweredHours,
      lowNps: settings.lowNps,
      trialConversionDays: settings.trialConversionDays,
      reEngagementWinDays: settings.reEngagementWinDays,
    },
    kpis: kpisOf(curM, prevM),
    sections: curM,
    now: strip(nowLoad),
    unassigned: memberId ? null : strip(loads.get('') ?? { ...emptyLoad(), name: '' }),
    trend,
    members,
    breaches: overdue.slice(0, 50),
    breachCount: overdue.length,
    recent,
    upcomingTrials,
  };
  return { overview, loaded, cur, settings, memberId };
};
