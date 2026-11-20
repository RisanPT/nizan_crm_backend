import Booking from '../models/Booking.js';
import BlockedDate from '../models/BlockedDate.js';
import Conversation from '../models/Conversation.js';
import CrmBookingCare from '../models/CrmBookingCare.js';
import CrmCase from '../models/CrmCase.js';
import CrmWeeklyReport from '../models/CrmWeeklyReport.js';
import Employee from '../models/Employee.js';
import Message from '../models/Message.js';
import Review from '../models/Review.js';
import SlotCapacity from '../models/SlotCapacity.js';
import Trial from '../models/Trial.js';
import { workRows } from '../utils/associateWorks.js';
import { bookingsByPhone, trialStats } from '../utils/crmStats.js';
import {
  clientKey,
  effectiveFigures,
  medicalFigures,
  OVERRIDE_FIELDS,
  nextWeekOf,
  outsourceFigures,
  photosReviewsFigures,
  previousWeekOf,
  supportFigures,
  verificationFigures,
  weekOf,
  workloadFigures,
} from '../utils/crmWeekly.js';
import { addDays, istDayKey, istEnd, istStart } from '../utils/istDate.js';
import { NON_REVENUE_FILTER } from '../utils/reEngagement.js';
import { consumesSlot, dayKey } from '../utils/slots.js';
import { careSince, getCrmSettings } from './crmSettings.js';

// THE CRM WEEKLY REPORT, loaded: the records behind each of the eight items (utils/crmWeekly.js adds them up), and the report itself —
// a draft is worked out fresh every time it is opened; a submitted one shows the figures as they were when it was handed in.

const DAY_MS = 24 * 3600 * 1000;
const idOf = (v) => (v == null ? '' : String(v._id ?? v));
const BOOKING_FIELDS = 'bookingNumber customerName phone status serviceStart bookingDate selectedDates bookingItems.selectedDates';
const DEFAULT_SLOTS = 6; // utils: slotController DEFAULT_MORNING + DEFAULT_EVENING

const daysFrom = (from, to) => {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
};

/// Everything the CRM did for a client between [start] and [end]: chat answers, request decisions, work on cases. → events for
/// utils/crmWeekly.js supportFigures.
const supportEvents = async (start, end) => {
  const range = { $gte: start, $lte: end };
  const [messages, decided, cases] = await Promise.all([
    Message.find({ senderType: 'staff', createdAt: range }).select('conversationId senderId senderName').lean(),
    Booking.find({ requestDecidedAt: range }).select('phone requestDecidedBy requestDecidedByName').lean(),
    CrmCase.find({ 'activities.at': range }).select('phone activities.type activities.at activities.by activities.byName').lean(),
  ]);
  const convoIds = [...new Set(messages.map((m) => idOf(m.conversationId)))];
  const convos = convoIds.length ? await Conversation.find({ _id: { $in: convoIds } }).select('clientPhone').lean() : [];
  const phoneOf = new Map(convos.map((c) => [idOf(c._id), c.clientPhone]));
  const events = [];
  for (const m of messages) {
    const c = idOf(m.conversationId);
    events.push({ client: clientKey(phoneOf.get(c), `chat:${c}`), by: idOf(m.senderId), byName: m.senderName || '' });
  }
  for (const b of decided) events.push({ client: clientKey(b.phone, `booking:${idOf(b)}`), by: idOf(b.requestDecidedBy), byName: b.requestDecidedByName || '' });
  for (const c of cases) {
    for (const a of c.activities ?? []) {
      // what a person did for the client (not the system's own notes, not handing the case out)
      if (!a.by || a.type === 'assign' || !(a.at >= start && a.at <= end)) continue;
      events.push({ client: clientKey(c.phone, `case:${idOf(c)}`), by: idOf(a.by), byName: a.byName || '' });
    }
  }
  return events;
};

/// Bookings, slot capacity and blocked days for [range] — the same rule as the Slots screen (one per booking on its booking date).
const workloadFor = async (range) => {
  const start = dayKey(`${range.from}T00:00:00Z`);
  const end = new Date(dayKey(`${range.to}T00:00:00Z`).getTime() + DAY_MS);
  const [booked, overrides, def, blocked] = await Promise.all([
    Booking.find({ bookingDate: { $gte: start, $lt: end } }).select('bookingDate status').lean(),
    SlotCapacity.find({ date: { $gte: start, $lt: end } }).lean(),
    SlotCapacity.findOne({ date: null }).lean(),
    BlockedDate.find({ active: true, date: { $gte: start, $lt: end } }).select('date').lean(),
  ]);
  const key = (d) => dayKey(d).toISOString().slice(0, 10);
  const count = new Map();
  for (const b of booked) if (consumesSlot(b)) count.set(key(b.bookingDate), (count.get(key(b.bookingDate)) ?? 0) + 1);
  const cap = new Map(overrides.map((o) => [key(o.date), (o.morning || 0) + (o.evening || 0)]));
  const defCap = def ? (def.morning || 0) + (def.evening || 0) : DEFAULT_SLOTS;
  const blockedSet = new Set(blocked.map((b) => key(b.date)));
  return workloadFigures({ range, bookedOn: (d) => count.get(d) ?? 0, capacityOn: (d) => cap.get(d) ?? defCap, blockedOn: (d) => blockedSet.has(d) });
};

/// The figures of [week] (and the coming week where an item looks ahead), as of [now].
export const buildWeeklyFigures = async ({ week, now = new Date() }) => {
  const today = istDayKey(now);
  const settings = await getCrmSettings();
  const since = await careSince(now);
  const next = nextWeekOf(week);
  const prev = previousWeekOf(week);
  const tracked = (range) => istEnd(range.to) >= new Date(since);

  // bookings worked this week or next
  const days = daysFrom(week.from, next.to);
  const bookings = await Booking.find({
    $or: [
      { selectedDates: { $in: days } },
      { 'bookingItems.selectedDates': { $in: days } },
      { serviceStart: { $gte: istStart(week.from), $lte: istEnd(next.to) } },
    ],
  })
    .select(BOOKING_FIELDS)
    .lean();
  const ids = bookings.map((b) => b._id);
  const [cares, reviews] = await Promise.all([
    ids.length ? CrmBookingCare.find({ bookingId: { $in: ids } }).lean() : [],
    ids.length ? Review.find({ booking: { $in: ids }, status: 'submitted' }).select('booking').lean() : [],
  ]);
  const careMap = new Map(cares.map((c) => [idOf(c.bookingId), c]));
  const careOf = (id) => careMap.get(String(id)) ?? null;
  const reviewed = new Set(reviews.map((r) => idOf(r.booking)));

  // trials, and what their clients booked afterwards
  const [trials, prevTrials, laterBookings] = await Promise.all([
    Trial.find({ trialDate: { $gte: week.from, $lte: week.to } }).select('phone status trialDate bookingId convertedBookingId').lean(),
    Trial.countDocuments({ trialDate: { $gte: prev.from, $lte: prev.to }, status: { $ne: 'cancelled' } }),
    Booking.find({ createdAt: { $gte: istStart(week.from), $lte: now }, status: NON_REVENUE_FILTER }).select('phone createdAt').lean(),
  ]);
  const ts = trialStats(trials, bookingsByPhone(laterBookings), { conversionDays: settings.trialConversionDays, now });

  // the clients the CRM handled: the week, the week before, and the month so far
  const monthFrom = `${week.to.slice(0, 7)}-01`;
  const monthTo = week.to < today ? week.to : today;
  const [weekEvents, prevEvents, monthEvents] = await Promise.all([
    supportEvents(istStart(week.from), istEnd(week.to)),
    supportEvents(istStart(prev.from), istEnd(prev.to)),
    supportEvents(istStart(monthFrom), istEnd(monthTo)),
  ]);
  const support = supportFigures(weekEvents);

  // outside artists on the week's works
  const associates = await Employee.find({ isAssociate: true }).select('name phone').lean();
  const assocIds = associates.map((a) => a._id);
  const assocBookings = assocIds.length
    ? await Booking.find({
        serviceStart: { $gte: istStart(week.from), $lte: istEnd(week.to) },
        $or: [{ 'assignedStaff.employeeId': { $in: assocIds } }, { 'bookingItems.assignedStaff.employeeId': { $in: assocIds } }],
      })
        .select('bookingNumber customerName service status serviceStart selectedDates district region assignedStaff bookingItems.service bookingItems.selectedDates bookingItems.assignedStaff')
        .lean()
    : [];
  const outsource = outsourceFigures(
    workRows({ bookings: assocBookings, associates: associates.map((a) => ({ id: idOf(a), name: a.name, phone: a.phone })), canSeeFees: false })
  );

  const [workloadThis, workloadNext] = await Promise.all([workloadFor(week), workloadFor(next)]);

  return {
    week,
    nextWeek: next,
    previousWeek: prev,
    asOf: now,
    careSince: since,
    trials: {
      held: ts.scheduled,
      completed: ts.completed,
      cancelled: trials.filter((t) => t.status === 'cancelled').length,
      postponed: trials.filter((t) => t.status === 'postponed').length,
      converted: ts.converted,
      maturing: ts.maturing,
      conversionPct: ts.conversionPct,
      prevHeld: prevTrials,
    },
    photosReviews: photosReviewsFigures({ bookings, careOf, reviewed, week, today, tracked: tracked(week) }),
    support: {
      clients: support.clients,
      byMember: support.byMember,
      prevClients: supportFigures(prevEvents).clients,
      monthToDate: supportFigures(monthEvents).clients,
      monthTarget: settings.monthlyCustomerTarget ?? 100,
      monthFrom,
      monthTo,
    },
    verification: {
      thisWeek: verificationFigures({ bookings, careOf, range: week, tracked: tracked(week) }),
      nextWeek: verificationFigures({ bookings, careOf, range: next, tracked: tracked(next) }),
    },
    medical: medicalFigures({ bookings, careOf, range: { from: week.from, to: next.to }, week, tracked: tracked(next) }),
    workload: { thisWeek: workloadThis, nextWeek: workloadNext },
    outsource,
  };
};

const TYPED_DEFAULTS = {
  startingMessagesNizan: null,
  startingMessagesTeamN: null,
  startingMessagesNote: '',
  manpowerPlan: '',
  enoughWork: '',
  enoughWorkNote: '',
  notes: '',
};

/// The typed part as the app gets it: only the figures and notes actually typed.
export const typedView = (typed = {}) => ({
  ...TYPED_DEFAULTS,
  ...typed,
  overrides: Object.fromEntries(Object.entries(typed.overrides ?? {}).filter(([, v]) => v != null)),
  sectionNotes: Object.fromEntries(Object.entries(typed.sectionNotes ?? {}).filter(([, v]) => String(v ?? '').trim())),
  outsourceLines: typed.outsourceLines ?? [],
});

/// What the app shows for [week]: the typed part, the status, and the figures (as submitted, or fresh for a draft) with what was typed
/// by hand put in — `records` keeps the records' own figure of each. [fresh] — the figures already worked out for a draft.
export const weeklyReportView = async ({ week, now = new Date(), fresh = null }) => {
  const doc = await CrmWeeklyReport.findOne({ weekStart: week.from }).lean();
  const submitted = doc?.status === 'submitted' && doc.snapshot;
  const typed = typedView(doc?.typed ?? {});
  const eff = effectiveFigures(submitted ? doc.snapshot : (fresh ?? (await buildWeeklyFigures({ week, now }))), typed);
  return {
    week,
    status: doc?.status ?? 'new',
    live: !submitted,
    typed,
    figures: eff.figures,
    records: eff.records,
    fields: OVERRIDE_FIELDS.map(({ key, section, label }) => ({ key, section, label })),
    submittedAt: doc?.submittedAt ?? null,
    submittedByName: doc?.submittedByName ?? '',
    reopenedAt: doc?.reopenedAt ?? null,
    reopenedByName: doc?.reopenedByName ?? '',
    updatedAt: doc?.updatedAt ?? null,
    updatedByName: doc?.updatedByName ?? '',
  };
};

/// The last [n] weeks (newest first) and whether each has a report.
export const weeklyReportList = async ({ n = 12, today }) => {
  const latest = weekOf(addDays(today, -7));
  const weeks = [];
  for (let i = 0; i < n; i += 1) weeks.push(weekOf(addDays(latest.from, -7 * i)));
  const docs = await CrmWeeklyReport.find({ weekStart: { $in: weeks.map((w) => w.from) } }).select('weekStart status submittedAt submittedByName updatedAt').lean();
  const byWeek = new Map(docs.map((d) => [d.weekStart, d]));
  return weeks.map((w) => {
    const d = byWeek.get(w.from);
    return { ...w, status: d?.status ?? 'new', submittedAt: d?.submittedAt ?? null, submittedByName: d?.submittedByName ?? '', updatedAt: d?.updatedAt ?? null };
  });
};
