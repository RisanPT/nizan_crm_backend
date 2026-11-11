import mongoose from 'mongoose';
import Lead from '../models/Lead.js';
import LeadActivity from '../models/LeadActivity.js';
import { ENQUIRY_CHANNELS } from '../models/EnquiryCount.js';
import {
  attachCredit,
  bookingFilters,
  denyNonDashboard,
  isSale,
  isSelfScoped,
  leadMatch,
  loadBookings,
  orderValue,
  outstandingOf,
  resolveRange,
  salespeople,
} from './dashboardController.js';
import { coerceChannel, manualCountsByDay, salesLeadsSaved } from './enquiryCountController.js';
import { monthTargetLookup } from './salesTargetController.js';
import { addDays, istDayKey, istStart, todayIst } from '../utils/istDate.js';

// ── Sales Dashboard (redesigned) — one server-side source for every figure ──
//
// GET /api/dashboard/sales-overview?from&to&prevFrom&prevTo&salesPersonId
//
// Same rules as the rest of the CRM, so nothing here can disagree with the
// EOD, the enquiry check or Sales Targets:
//  • Bookings count on the day they were MADE (createdAt, IST) — same as the
//    Sales EOD and Sales Targets. Sales = not cancelled/rejected/lost/draft/
//    pending and not entered by users excluded from sales totals.
//  • Order value = totalPrice (package + add-ons), no discount deducted.
//    Outstanding = net of discount − advance − collected (what is still owed).
//  • Credit = booking.salesPersonId, else the converted lead's assignedTo.
//  • Leads = leads with leadDate (else createdAt) in the window, territory-
//    scoped; a salesperson filter means leads assigned to them.
//  • Enquiries = the TEAM's manual morning count (one shared number). The
//    "saved vs counted" check is always team-wide, exactly as on the EOD and
//    the enquiry count card (leads entered by sales staff, same days).
//  • Target bar = Sales Targets' own figures for the month of `to`.
//  • Sales / sales_executive users only ever see their own sales figures.

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const lc = (v) => String(v ?? '').trim().toLowerCase();
const idOf = (v) => (v == null ? null : String(v._id ?? v));
const pct = (a, b) => (b > 0 ? round2((a / b) * 100) : 0);

const dayList = (from, to) => {
  const out = [];
  for (let d = from; d <= to && out.length <= 400; d = addDays(d, 1)) out.push(d);
  return out;
};

/// Working days (Mon–Sat, Sundays off — the Sales EOD's rule) in a month,
/// and how many of them have passed by `asOf` (inclusive).
export const workingDays = (year, month, asOfDay) => {
  const total = new Date(Date.UTC(year, month, 0)).getUTCDate();
  let all = 0;
  let elapsed = 0;
  for (let d = 1; d <= total; d++) {
    if (new Date(Date.UTC(year, month - 1, d)).getUTCDay() === 0) continue;
    all += 1;
    if (d <= asOfDay) elapsed += 1;
  }
  return { all, elapsed };
};

/// Funnel from lead stages: a lead in a later stage has passed earlier ones.
export const funnelOf = (leads) => {
  const st = (l) => lc(l.status);
  return {
    leads: leads.length,
    contacted: leads.filter((l) => st(l) !== 'new').length,
    followUp: leads.filter((l) => ['follow-up', 'qualified', 'converted'].includes(st(l))).length,
    qualified: leads.filter((l) => ['qualified', 'converted'].includes(st(l))).length,
    converted: leads.filter((l) => st(l) === 'converted').length,
    lost: leads.filter((l) => ['lost', 'pending lost approval'].includes(st(l))).length,
  };
};

const sumSales = (bookings) => {
  const sales = bookings.filter((b) => isSale(b) && b.counts !== false);
  return {
    sales,
    bookings: sales.length,
    orderValue: round2(sales.reduce((s, b) => s + orderValue(b), 0)),
    advance: round2(sales.reduce((s, b) => s + (Number(b.advanceAmount) || 0), 0)),
    collected: round2(sales.reduce((s, b) => s + (Number(b.collectedAmount) || 0), 0)),
    outstanding: round2(sales.reduce((s, b) => s + outstandingOf(b), 0)),
  };
};

export const getSalesOverview = async (req, res) => {
  if (denyNonDashboard(req, res)) return;
  try {
    const range = resolveRange(req.query);
    const today = todayIst();
    const selfScoped = isSelfScoped(req.user);
    const spRaw = selfScoped ? String(req.user._id) : req.query.salesPersonId;
    const salesPersonId = spRaw && spRaw !== 'all' && mongoose.isValidObjectId(spRaw) ? String(spRaw) : null;

    const and = await bookingFilters(req);
    const [lm, lmPrev] = await Promise.all([
      leadMatch(req, range.from, range.to),
      leadMatch(req, range.prevFrom, range.prevTo),
    ]);
    const [cur, prev, leads, prevLeadCount, team, manual, saved] = await Promise.all([
      loadBookings(and, 'createdAt', range.from, range.to),
      loadBookings(and, 'createdAt', range.prevFrom, range.prevTo),
      Lead.find(lm)
        .select('name customerName phone source status assignedTo leadDate createdAt followUpDate')
        .lean(),
      Lead.countDocuments(lmPrev),
      salespeople(),
      manualCountsByDay(range.from, range.to),
      salesLeadsSaved(range.from, range.to),
    ]);
    await attachCredit(cur);

    // ── Sales figures ──
    const now = sumSales(cur);
    const before = sumSales(prev);
    const days = dayList(range.from, range.to);

    // ── Team enquiry count vs saved (always team-wide, like the EOD) ──
    const manualDays = days.filter((d) => manual.has(d));
    const manualSet = new Set(manualDays);
    const enquiries = manualDays.reduce(
      (s, d) => s + Object.values(manual.get(d)).reduce((a, n) => a + n, 0),
      0
    );
    const savedOnManualDays = saved.filter((l) => manualSet.has(l.day)).length;

    // ── Leads (scoped) ──
    const leadDay = (l) => istDayKey(l.leadDate || l.createdAt);
    const funnel = funnelOf(leads);

    // ── Follow-ups overdue (scoped, any age) ──
    const overdueMatch = {
      status: 'Follow-up',
      followUpDate: { $lt: istStart(today) },
      ...(salesPersonId ? { assignedTo: new mongoose.Types.ObjectId(salesPersonId) } : {}),
    };
    const overdue = await Lead.find(overdueMatch).select('assignedTo').lean();

    // ── Booking source (via the converted lead) ──
    const leadIds = [...new Set(now.sales.map((b) => idOf(b.leadId)).filter(Boolean))];
    const bookingLeads = leadIds.length
      ? await Lead.find({ _id: { $in: leadIds } }).select('source').lean()
      : [];
    const sourceOfLead = new Map(bookingLeads.map((l) => [String(l._id), coerceChannel(l.source)]));

    // ── Sources table: one row per channel ──
    const src = new Map(
      ENQUIRY_CHANNELS.map((c) => [c, { channel: c, enquiries: 0, saved: 0, leads: 0, converted: 0, bookings: 0, orderValue: 0 }])
    );
    for (const d of manualDays) {
      for (const [ch, n] of Object.entries(manual.get(d))) src.get(ch).enquiries += n;
    }
    for (const l of saved) if (manualSet.has(l.day)) src.get(l.channel).saved += 1;
    for (const l of leads) {
      const r = src.get(coerceChannel(l.source));
      r.leads += 1;
      if (lc(l.status) === 'converted') r.converted += 1;
    }
    let directBookings = 0;
    let directValue = 0;
    for (const b of now.sales) {
      const ch = sourceOfLead.get(idOf(b.leadId));
      if (!ch) {
        directBookings += 1;
        directValue += orderValue(b);
        continue;
      }
      const r = src.get(ch);
      r.bookings += 1;
      r.orderValue += orderValue(b);
    }
    const sources = [...src.values()].map((r) => ({
      ...r,
      orderValue: round2(r.orderValue),
      notSaved: r.enquiries - r.saved,
      conversion: pct(r.converted, r.leads),
    }));

    // ── Daily trend ──
    const trendMap = new Map(days.map((d) => [d, { day: d, enquiries: null, saved: 0, leads: 0, bookings: 0, orderValue: 0 }]));
    for (const d of manualDays) {
      trendMap.get(d).enquiries = Object.values(manual.get(d)).reduce((a, n) => a + n, 0);
    }
    for (const l of saved) if (trendMap.has(l.day)) trendMap.get(l.day).saved += 1;
    for (const l of leads) {
      const t = trendMap.get(leadDay(l));
      if (t) t.leads += 1;
    }
    for (const b of now.sales) {
      const t = trendMap.get(istDayKey(b.createdAt));
      if (!t) continue;
      t.bookings += 1;
      t.orderValue += orderValue(b);
    }
    const trend = [...trendMap.values()].map((t) => ({ ...t, orderValue: round2(t.orderValue) }));

    // ── Team leaderboard ──
    const teamIds = salesPersonId ? team.filter((t) => t.id === salesPersonId) : team;
    const activities = await LeadActivity.find({
      createdAt: { $gte: istStart(range.from), $lte: new Date(istStart(addDays(range.to, 1)).getTime() - 1) },
      ...(salesPersonId ? { createdBy: new mongoose.Types.ObjectId(salesPersonId) } : {}),
    })
      .select('type createdBy')
      .lean();
    const month = Number(range.to.slice(5, 7));
    const year = Number(range.to.slice(0, 4));
    const targetOf = await monthTargetLookup({ month, year });
    const teamRows = await Promise.all(
      teamIds.map(async (p) => {
        const mine = now.sales.filter((b) => b.creditId === p.id);
        const acts = activities.filter((a) => idOf(a.createdBy) === p.id);
        const t = targetOf(p.id);
        const myLeads = leads.filter((l) => idOf(l.assignedTo) === p.id);
        return {
          id: p.id,
          name: p.name,
          role: p.role,
          leads: myLeads.length,
          converted: myLeads.filter((l) => lc(l.status) === 'converted').length,
          calls: acts.filter((a) => a.type === 'call').length,
          followUps: acts.filter((a) => a.type === 'followup').length,
          overdueFollowUps: overdue.filter((l) => idOf(l.assignedTo) === p.id).length,
          bookings: mine.length,
          orderValue: round2(mine.reduce((s, b) => s + orderValue(b), 0)),
          monthTarget: { salesTarget: t.salesTarget, salesValue: t.salesValue, bookingsTarget: t.bookingsTarget, bookings: t.bookings },
        };
      })
    );
    teamRows.sort((a, b) => b.orderValue - a.orderValue || b.bookings - a.bookings || a.name.localeCompare(b.name));
    const credited = new Set(teamRows.map((r) => r.id));
    const others = now.sales.filter((b) => !credited.has(b.creditId));

    // ── Target bar (month of `to`, Sales Targets' own figures) ──
    const target = targetOf(salesPersonId);
    const asOfDay = range.to < today ? Number(range.to.slice(8, 10)) : Number(today.slice(8, 10));
    const isCurrentOrPast = range.to.slice(0, 7) <= today.slice(0, 7);
    const wd = workingDays(year, month, range.to.slice(0, 7) < today.slice(0, 7) ? 31 : asOfDay);
    const share = isCurrentOrPast && wd.all > 0 ? wd.elapsed / wd.all : 0;

    // ── Today's team count status ──
    const todayCount = await manualCountsByDay(today, today);

    // ── Recent leads ──
    const nameOf = new Map(team.map((t) => [t.id, t.name]));
    const recentLeads = [...leads]
      .sort((a, b) => new Date(b.leadDate || b.createdAt) - new Date(a.leadDate || a.createdAt))
      .slice(0, 10)
      .map((l) => ({
        id: String(l._id),
        name: l.customerName || l.name || 'Lead',
        phone: l.phone || '',
        source: coerceChannel(l.source),
        status: l.status || 'New',
        assignedTo: nameOf.get(idOf(l.assignedTo)) || '',
        date: leadDay(l),
      }));

    res.json({
      range,
      basis: 'booked',
      selfScoped,
      salesPersonId,
      kpis: {
        enquiries: manualDays.length ? enquiries : null,
        enquiryDays: manualDays.length,
        days: days.length,
        savedOnCountDays: savedOnManualDays,
        notSaved: manualDays.length ? enquiries - savedOnManualDays : 0,
        leads: leads.length,
        converted: funnel.converted,
        bookings: now.bookings,
        orderValue: now.orderValue,
        avgOrderValue: now.bookings ? round2(now.orderValue / now.bookings) : 0,
        advance: now.advance,
        collected: now.collected,
        outstanding: now.outstanding,
        // Bookings ÷ enquiries when the team count covers the whole window,
        // else bookings ÷ leads.
        conversion: manualDays.length === days.length && enquiries > 0 ? pct(now.bookings, enquiries) : pct(now.bookings, leads.length),
        conversionBasis: manualDays.length === days.length && enquiries > 0 ? 'enquiries' : 'leads',
      },
      previous: { leads: prevLeadCount, bookings: before.bookings, orderValue: before.orderValue },
      alerts: {
        notSaved: manualDays.length ? Math.max(0, enquiries - savedOnManualDays) : 0,
        overdueFollowUps: overdue.length,
        todayCountEntered: todayCount.has(today),
      },
      target: {
        month,
        year,
        scope: target.scope,
        bookingsTarget: target.bookingsTarget,
        bookings: target.bookings,
        valueTarget: target.salesTarget,
        value: round2(target.salesValue),
        workingDays: wd.all,
        workingDaysElapsed: wd.elapsed,
        expectedBookings: round2(target.bookingsTarget * share),
        expectedValue: round2(target.salesTarget * share),
      },
      funnel,
      sources,
      direct: { bookings: directBookings, orderValue: round2(directValue) },
      trend,
      team: teamRows,
      othersCredited: { bookings: others.length, orderValue: round2(others.reduce((s, b) => s + orderValue(b), 0)) },
      recentLeads,
      salespeople: selfScoped ? [] : team.map(({ id, name }) => ({ id, name })),
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
