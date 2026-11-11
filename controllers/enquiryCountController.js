import mongoose from 'mongoose';
import EnquiryCount, { ENQUIRY_CHANNELS } from '../models/EnquiryCount.js';
import Lead from '../models/Lead.js';
import User from '../models/User.js';

// Manual daily enquiry counts — ONE SHARED TEAM COUNT per day per channel
// (see models/EnquiryCount.js).
//
// Who can do what:
//  - Anyone in sales (salesperson, sales head) plus admin/manager can enter or
//    correct the team count for today or any past day (never a future day).
//    If Safana enters it, Malavika sees the same numbers, and vice versa.
//  - Marketing roles see the same numbers, read-only.
//  - Every change is logged in the row's history (who, from → to, when).

const role = (u) => String(u?.role ?? '').toLowerCase();

const isSalesRole = (u) => role(u).startsWith('sales');
const isMarketingRole = (u) => role(u).startsWith('marketing');
export const canEnter = (u) => isSalesRole(u) || role(u) === 'admin' || role(u) === 'manager';
export const canRead = (u) => canEnter(u) || isMarketingRole(u);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const HISTORY_CAP = 50;

/// Today's IST calendar day as 'YYYY-MM-DD'.
export const istToday = () =>
  new Date(Date.now() + 330 * 60 * 1000).toISOString().slice(0, 10);

/// IST day 'YYYY-MM-DD' → [start, end] Date range.
const istDayRange = (from, to) => [
  new Date(`${from}T00:00:00.000+05:30`),
  new Date(`${to}T23:59:59.999+05:30`),
];

/// IST 'YYYY-MM-DD' of a Date.
const istDay = (d) => new Date(new Date(d).getTime() + 330 * 60 * 1000).toISOString().slice(0, 10);

/// Map a raw / legacy lead source onto a channel. Mirrors the Flutter
/// coerceLeadSource() in sales_leads_screen.dart — keep the two in sync.
export const coerceChannel = (s) => {
  if (s == null || String(s).trim() === '') return 'WhatsApp (Organic)';
  const trimmed = String(s).trim();
  if (ENQUIRY_CHANNELS.includes(trimmed)) return trimmed;
  const lower = trimmed.toLowerCase();
  if (lower.includes('whatsapp') || lower === 'wa') return 'WhatsApp (Organic)';
  if (lower.includes('kerala')) return 'IG Leads — Kerala Page';
  if (lower.includes('trial')) return 'Trial Campaign Leads';
  // Whole word "ad"/"ads" — a bare includes('ad') also matched "leads".
  if (lower.includes('paid') || /\bads?\b/.test(lower)) return 'Paid Ads Leads';
  if (lower.includes('main') || lower === 'instagram' || lower === 'ig') return 'IG Leads — Main Page';
  if (lower.includes('youtube')) return 'YouTube';
  if (lower.includes('reference') || lower.includes('referral')) return 'Reference';
  if (lower.includes('walk')) return 'Walk-in';
  return 'Other';
};

const emptyCounts = () => Object.fromEntries(ENQUIRY_CHANNELS.map((c) => [c, 0]));

// ── Shared helpers (also used by the Sales EOD) ──────────────────────────────

/// Team manual counts for [from, to]: Map('YYYY-MM-DD' → { channel: count }).
/// Only days that were actually entered appear in the map.
export const manualCountsByDay = async (from, to) => {
  const rows = await EnquiryCount.find({ date: { $gte: from, $lte: to } })
    .select('date channel count')
    .lean();
  const byDay = new Map();
  for (const r of rows) {
    if (!byDay.has(r.date)) byDay.set(r.date, emptyCounts());
    byDay.get(r.date)[r.channel] = r.count;
  }
  return byDay;
};

/// Leads saved in the CRM by the sales team for [from, to], on the lead's
/// leadDate (else createdAt). Returns [{ day, channel, ownerId }].
/// Only leads entered by sales roles count, so both sides of the cross-check
/// are like-for-like (enquiries only come from sales).
export const salesLeadsSaved = async (from, to) => {
  const [start, end] = istDayRange(from, to);
  const leads = await Lead.find({
    $expr: {
      $and: [
        { $gte: [{ $ifNull: ['$leadDate', '$createdAt'] }, start] },
        { $lte: [{ $ifNull: ['$leadDate', '$createdAt'] }, end] },
      ],
    },
  })
    .select('source createdBy assignedTo leadDate createdAt')
    .lean();
  const ownerIds = [...new Set(leads.map((l) => String(l.createdBy || l.assignedTo || '')).filter(Boolean))];
  const owners = await User.find({ _id: { $in: ownerIds } }).select('name role').lean();
  const sales = new Map(
    owners.filter((u) => String(u.role || '').toLowerCase().startsWith('sales')).map((u) => [String(u._id), u])
  );
  const out = [];
  for (const l of leads) {
    const ownerId = String(l.createdBy || l.assignedTo || '');
    if (!sales.has(ownerId)) continue;
    out.push({
      day: istDay(l.leadDate || l.createdAt),
      channel: coerceChannel(l.source),
      ownerId,
      ownerName: sales.get(ownerId).name || 'Unknown',
    });
  }
  return out;
};

// ── Endpoints ────────────────────────────────────────────────────────────────

const dayPayload = async (date, user) => {
  const rows = await EnquiryCount.find({ date }).lean();
  const counts = emptyCounts();
  let updatedAt = null;
  let updatedByName = '';
  const history = [];
  for (const r of rows) {
    counts[r.channel] = r.count;
    if (!updatedAt || r.updatedAt > updatedAt) {
      updatedAt = r.updatedAt;
      updatedByName = r.updatedByName || '';
    }
    for (const h of r.history || []) {
      history.push({ channel: r.channel, from: h.from, to: h.to, byName: h.byName || '', at: h.at });
    }
  }
  history.sort((a, b) => new Date(b.at) - new Date(a.at));
  return {
    date,
    channels: ENQUIRY_CHANNELS,
    counts,
    entered: rows.length > 0,
    shared: true,
    updatedAt,
    updatedByName,
    history: history.slice(0, 30),
    canEdit: canEnter(user) && date <= istToday(),
  };
};

// GET /api/enquiry-counts/day?date=YYYY-MM-DD   (alias: /me)
// The TEAM's shared counts for one day (every channel, 0 when not entered).
export const getDayCounts = async (req, res) => {
  try {
    if (!canRead(req.user)) {
      return res.status(403).json({ message: 'Only sales and marketing can view enquiry counts.' });
    }
    const date = DATE_RE.test(req.query.date || '') ? req.query.date : istToday();
    res.json(await dayPayload(date, req.user));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// PUT /api/enquiry-counts/day   { date, counts: { channel: number } }   (alias: /me)
// Sets the TEAM's shared counts. Today or any past day; never the future.
// Only channels whose number actually changed are written and logged.
export const saveDayCounts = async (req, res) => {
  try {
    if (!canEnter(req.user)) {
      return res.status(403).json({ message: 'Only the sales team can enter enquiry counts.' });
    }
    const { date, counts } = req.body || {};
    if (!DATE_RE.test(date || '')) {
      return res.status(400).json({ message: 'A valid date (YYYY-MM-DD) is required.' });
    }
    if (date > istToday()) {
      return res.status(400).json({ message: 'You cannot enter counts for a future date.' });
    }
    if (!counts || typeof counts !== 'object') {
      return res.status(400).json({ message: 'counts is required.' });
    }

    const wanted = [];
    for (const [channel, raw] of Object.entries(counts)) {
      if (!ENQUIRY_CHANNELS.includes(channel)) {
        return res.status(400).json({ message: `Unknown channel: ${channel}` });
      }
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 0 || n > 10000) {
        return res.status(400).json({ message: `Count for ${channel} must be a whole number 0–10000.` });
      }
      wanted.push([channel, n]);
    }

    const existing = new Map(
      (await EnquiryCount.find({ date }).select('channel count').lean()).map((r) => [r.channel, r.count])
    );
    const byName = String(req.user?.name || '');
    const now = new Date();
    const ops = [];
    for (const [channel, n] of wanted) {
      const prev = existing.has(channel) ? existing.get(channel) : null;
      if (prev === n) continue; // unchanged — nothing to write or log
      ops.push({
        updateOne: {
          filter: { date, channel },
          update: {
            $set: { count: n, updatedBy: req.user._id, updatedByName: byName },
            $setOnInsert: { createdBy: req.user._id },
            $push: {
              history: {
                $each: [{ from: prev, to: n, by: req.user._id, byName, at: now }],
                $slice: -HISTORY_CAP,
              },
            },
          },
          upsert: true,
        },
      });
    }
    if (ops.length) await EnquiryCount.bulkWrite(ops);
    res.json({ ...(await dayPayload(date, req.user)), changed: ops.length });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Back-compat names for the earlier per-person routes (/me).
export const getMyCounts = getDayCounts;
export const saveMyCounts = saveDayCounts;

// GET /api/enquiry-counts/verification?from=YYYY-MM-DD&to=YYYY-MM-DD
// Team enquiries entered (shared count) vs leads saved by the sales team, per
// channel. `people` lists leads saved per salesperson — the enquiry count is a
// team number, so it is not split by person.
export const getVerification = async (req, res) => {
  try {
    if (!canRead(req.user)) {
      return res.status(403).json({ message: 'Only sales and marketing can view enquiry counts.' });
    }
    const today = istToday();
    const from = DATE_RE.test(req.query.from || '') ? req.query.from : `${today.slice(0, 8)}01`;
    const to = DATE_RE.test(req.query.to || '') ? req.query.to : today;
    if (from > to) return res.status(400).json({ message: '"from" must be on or before "to".' });

    const [manual, saved] = await Promise.all([manualCountsByDay(from, to), salesLeadsSaved(from, to)]);

    // `leads` = every lead saved in the range. `savedOnCountDays` = only those
    // saved on days that HAVE a team count — the gap ("not saved") is always
    // enquiries − savedOnCountDays, the same rule as the Sales EOD and the
    // Sales Dashboard, so a day with no count never inflates the gap.
    const byChannel = new Map(ENQUIRY_CHANNELS.map((c) => [c, { enquiries: 0, leads: 0, savedOnCountDays: 0 }]));
    for (const counts of manual.values()) {
      for (const ch of ENQUIRY_CHANNELS) byChannel.get(ch).enquiries += counts[ch] || 0;
    }
    const people = new Map();
    for (const l of saved) {
      byChannel.get(l.channel).leads += 1;
      if (manual.has(l.day)) byChannel.get(l.channel).savedOnCountDays += 1;
      const p = people.get(l.ownerId) ?? { userId: l.ownerId, name: l.ownerName, leads: 0, byChannel: new Map() };
      p.leads += 1;
      p.byChannel.set(l.channel, (p.byChannel.get(l.channel) ?? 0) + 1);
      people.set(l.ownerId, p);
    }

    const channels = ENQUIRY_CHANNELS.map((ch) => {
      const t = byChannel.get(ch);
      return {
        channel: ch,
        enquiries: t.enquiries,
        leads: t.leads,
        savedOnCountDays: t.savedOnCountDays,
        gap: t.enquiries - t.savedOnCountDays,
      };
    });
    const totals = channels.reduce(
      (acc, c) => ({
        enquiries: acc.enquiries + c.enquiries,
        leads: acc.leads + c.leads,
        savedOnCountDays: acc.savedOnCountDays + c.savedOnCountDays,
      }),
      { enquiries: 0, leads: 0, savedOnCountDays: 0 }
    );

    res.json({
      from,
      to,
      channels,
      totals: { ...totals, gap: totals.enquiries - totals.savedOnCountDays },
      daysEntered: manual.size,
      people: [...people.values()]
        .map((p) => ({
          userId: p.userId,
          name: p.name,
          leads: p.leads,
          channels: ENQUIRY_CHANNELS.filter((c) => p.byChannel.has(c)).map((c) => ({
            channel: c,
            leads: p.byChannel.get(c),
          })),
        }))
        .sort((a, b) => b.leads - a.leads || a.name.localeCompare(b.name)),
      readOnly: !canEnter(req.user),
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
