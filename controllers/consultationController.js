import mongoose from 'mongoose';
import Consultation from '../models/Consultation.js';
import Lead from '../models/Lead.js';
import Role from '../models/Role.js';
import User from '../models/User.js';
import { addDays, isDay, istEnd, istMonthBounds, istStart, todayIst } from '../utils/istDate.js';
import { notifyStylist } from '../utils/consultationNotify.js';
import {
  CONSULTATION_MODES,
  CONSULTATION_STATUSES,
  accessFor,
  canActOn,
  countByStatus,
  countDerivedStatuses,
  deriveClientStatus,
  detectProvider,
  firstInvalidTextField,
  historyEntry,
  initialRemindersSent,
  isFullAccessRole,
  needingOutcome,
  normalizeMeetingLink,
  parseSchedule,
  parseStatusFilter,
  perStylistBreakdown,
  redactConsultation,
  canSeeNotes,
  LIGHT_SELECT,
  MEETING_PROVIDERS,
  NOTE_TEXT_FIELDS,
  referenceImageRoomError,
} from '../utils/consultationRules.js';
import { deleteReferenceImage, uploadReferenceImage } from '../utils/consultationImages.js';
import { sniffImageMime } from '../middleware/selfieUpload.js';
import StylistClient from '../models/StylistClient.js';
import { findOrCreateTeamNClient, renumberClientCalls } from '../services/stylistClients.js';
import { canActOnClient } from '../utils/stylistClientRules.js';

// ── Helpers ─────────────────────────────────────────────────────────────────
// Strings only: a one-element array stringifies to a valid-looking id.
const isId = (v) => typeof v === 'string' && mongoose.Types.ObjectId.isValid(v);
const clean = (v) => String(v ?? '').trim();
const idOf = (v) => (v == null ? null : v._id ?? v);
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const LEAD_FIELDS = 'name phone eventType eventDate location status';
// What a call shows about its client file (see models/StylistClient.js).
export const CLIENT_FIELDS = 'clientNo company name phone eventType eventDates venue requiredCalls status stylistId';

/// Copies the after-call text fields present in [body] onto [consultation].
/// Returns the changed field names, or null when the user may not touch notes
/// (nothing is changed then). Field names, never content, go into history.
const applyNoteFields = (consultation, body, req) => {
  if (!NOTE_TEXT_FIELDS.some((f) => body[f] !== undefined)) return [];
  if (!canSeeNotes(req.consultAccess, req.user, consultation)) return null;
  const changed = [];
  for (const f of NOTE_TEXT_FIELDS) {
    if (body[f] !== undefined && clean(body[f]) !== (consultation[f] ?? '')) {
      consultation[f] = clean(body[f]);
      changed.push(f);
    }
  }
  return changed;
};

const NO_NOTES_ACCESS = 'You do not have access to consultation notes';

// Mounted after protect + attachRolePermissions. Everything in this module needs
// at least one consultations permission (admin/manager always qualify).
export const consultationGuard = (req, res, next) => {
  const access = accessFor(req.user);
  if (!access.hasModule) {
    return res.status(403).json({ message: 'Not authorized for consultations' });
  }
  req.consultAccess = access;
  next();
};

/// Rejects over-long or non-text free-text fields before any handler runs.
export const validateTextFields = (req, res, next) => {
  const bad = firstInvalidTextField(req.body);
  if (bad) return res.status(400).json({ message: bad.message, field: bad.field });
  next();
};

const loadConsultation = async (req, res) => {
  if (!isId(req.params.id)) {
    res.status(404).json({ message: 'Consultation not found' });
    return null;
  }
  const consultation = await Consultation.findById(req.params.id);
  if (!consultation) {
    res.status(404).json({ message: 'Consultation not found' });
    return null;
  }
  if (!canActOn(req.consultAccess, req.user, consultation)) {
    res.status(403).json({ message: 'You can only access your own consultations' });
    return null;
  }
  return consultation;
};

/// True when [userId] is an active user whose role carries any consultations
/// permission (or is admin/manager) — i.e. someone who can be a stylist.
export const isEligibleStylist = async (userId) => {
  if (!isId(userId)) return false;
  const user = await User.findById(userId).select('role active').lean();
  if (!user || user.active === false) return false;
  if (isFullAccessRole(user.role)) return true;
  const role = await Role.findOne({ key: String(user.role ?? '').trim().toLowerCase() })
    .select('permissions active')
    .lean();
  if (!role || role.active === false) return false;
  return (role.permissions ?? []).some((p) => p === 'consultations' || p.startsWith('consultations.'));
};

/// Scheduled consultations of the same stylist that overlap [start, end).
const findConflicts = async (stylistId, start, end, excludeId = null) => {
  const query = {
    stylistId,
    status: 'Scheduled',
    scheduledAt: { $lt: end },
    endsAt: { $gt: start },
  };
  if (excludeId) query._id = { $ne: excludeId };
  const found = await Consultation.find(query)
    .select('consultationNo scheduledAt endsAt leadId clientId')
    .populate('leadId', 'name')
    .populate('clientId', 'name')
    .sort({ scheduledAt: 1 })
    .lean();
  return found.map((c) => ({
    id: c._id,
    consultationNo: c.consultationNo,
    scheduledAt: c.scheduledAt,
    endsAt: c.endsAt,
    clientName: c.clientId?.name || c.leadId?.name || '',
  }));
};

const conflictResponse = (res, conflicts) =>
  res.status(409).json({
    message: 'This stylist already has a consultation at that time',
    code: 'SCHEDULE_CONFLICT',
    conflicts,
  });

/// Resolves the conflict policy for a schedule change. Returns
/// { ok:true, overrode } or sends the response and returns { ok:false }.
const checkConflicts = async (req, res, stylistId, start, end, excludeId) => {
  const conflicts = await findConflicts(stylistId, start, end, excludeId);
  if (conflicts.length === 0) return { ok: true, overrode: false };
  if (req.body.force === true) {
    if (!req.consultAccess.viewAll) {
      res.status(403).json({ message: 'Only a stylist lead can book over a clash' });
      return { ok: false };
    }
    return { ok: true, overrode: true };
  }
  conflictResponse(res, conflicts);
  return { ok: false };
};

/// Fire-and-forget stylist notification for a consultation event. Never throws.
const notifyAbout = async (kind, id, opts) => {
  try {
    const consultation = await Consultation.findById(id).populate('leadId', 'name').populate('clientId', 'name');
    if (consultation) await notifyStylist(kind, consultation, opts);
  } catch (err) {
    console.error('consultation notification failed:', err.message);
  }
};

const sendDetail = async (res, id, req, status = 200) => {
  const fresh = await Consultation.findById(id)
    .populate('leadId', LEAD_FIELDS)
    .populate('clientId', CLIENT_FIELDS)
    .populate('stylistId', 'name');
  res.status(status).json(redactConsultation(fresh, req.consultAccess, req.user));
};

// ── GET /api/consultations ──────────────────────────────────────────────────
// ?from=YYYY-MM-DD&to=YYYY-MM-DD (IST days) &status= &leadId= &stylistId= &limit=
// A stylist only ever receives their own consultations. The list omits the
// notes fields entirely; open one consultation for those.
export const getConsultations = async (req, res) => {
  try {
    const { from, to, status, leadId, clientId, stylistId } = req.query;
    const filter = {};

    if (from || to) {
      if ((from && !isDay(from)) || (to && !isDay(to))) {
        return res.status(400).json({ message: 'from / to must be YYYY-MM-DD' });
      }
      filter.scheduledAt = {};
      if (from) filter.scheduledAt.$gte = istStart(from);
      if (to) filter.scheduledAt.$lte = istEnd(to);
    }
    if (status !== undefined && status !== '') {
      const parsed = parseStatusFilter(status);
      if (!parsed) {
        return res.status(400).json({ message: `status must be one of ${CONSULTATION_STATUSES.join(', ')}` });
      }
      filter.status = parsed;
    }
    if (leadId) {
      if (!isId(leadId)) return res.status(400).json({ message: 'Invalid leadId' });
      filter.leadId = leadId;
    }
    if (clientId) {
      if (!isId(clientId)) return res.status(400).json({ message: 'Invalid clientId' });
      filter.clientId = clientId;
    }
    if (req.consultAccess.viewAll) {
      if (stylistId) {
        if (!isId(stylistId)) return res.status(400).json({ message: 'Invalid stylistId' });
        filter.stylistId = stylistId;
      }
    } else {
      filter.stylistId = req.user._id;
    }

    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 300, 1), 500);
    const items = await Consultation.find(filter)
      .select(LIGHT_SELECT)
      .populate('leadId', LEAD_FIELDS)
      .populate('clientId', CLIENT_FIELDS)
      .populate('stylistId', 'name')
      .sort({ scheduledAt: from ? 1 : -1 })
      .limit(limit)
      .lean();
    res.json(items);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ── GET /api/consultations/summary ──────────────────────────────────────────
// Dashboard + operational report (FR-13). ?from=&to= (IST days, default = the
// current IST month) &stylistId= (stylist leads only). A stylist's numbers
// cover their own consultations; a stylist lead sees the whole team.
const SUMMARY_LIGHT = LIGHT_SELECT;

export const getSummary = async (req, res) => {
  try {
    const now = new Date();
    const today = todayIst();
    const [year, month] = today.split('-').map(Number);
    const monthBounds = istMonthBounds(year, month);

    const from = req.query.from || monthBounds.from;
    const to = req.query.to || monthBounds.to;
    if (!isDay(from) || !isDay(to) || from > to) {
      return res.status(400).json({ message: 'from / to must be valid YYYY-MM-DD days, from ≤ to' });
    }
    const rangeStart = istStart(from);
    const rangeEnd = istEnd(to);

    const { viewAll } = req.consultAccess;
    const scope = {};
    if (!viewAll) scope.stylistId = req.user._id;
    else if (req.query.stylistId) {
      if (!isId(req.query.stylistId)) return res.status(400).json({ message: 'Invalid stylistId' });
      scope.stylistId = req.query.stylistId;
    }

    const lightList = (query) =>
      Consultation.find({ ...scope, ...query })
        .select(SUMMARY_LIGHT)
        .populate('leadId', 'name phone')
        .populate('clientId', CLIENT_FIELDS)
        .populate('stylistId', 'name')
        .lean();

    const [inRange, todayList, upcoming, overdue, scopedLeadIds, activeClients] = await Promise.all([
      Consultation.find({ ...scope, scheduledAt: { $gte: rangeStart, $lte: rangeEnd } })
        .select('leadId stylistId status scheduledAt endsAt')
        .populate('stylistId', 'name')
        .lean(),
      lightList({ scheduledAt: { $gte: istStart(today), $lte: istEnd(today) } }).then((l) =>
        l.sort((a, b) => a.scheduledAt - b.scheduledAt)
      ),
      lightList({ status: 'Scheduled', scheduledAt: { $gt: istEnd(today), $lte: istEnd(addDays(today, 14)) } })
        .then((l) => l.sort((a, b) => a.scheduledAt - b.scheduledAt).slice(0, 10)),
      lightList({
        status: 'Scheduled',
        endsAt: { $lt: now },
        scheduledAt: { $gte: new Date(now.getTime() - 60 * 86400000) },
      }).then((l) => l.sort((a, b) => a.scheduledAt - b.scheduledAt).slice(0, 20)),
      Consultation.distinct('leadId', scope),
      StylistClient.countDocuments({ status: 'Active', ...(scope.stylistId ? { stylistId: scope.stylistId } : {}) }),
    ]);

    // Pending follow-ups on clients this user has consultations with.
    const followUpFilter = {
      _id: { $in: scopedLeadIds },
      status: 'Follow-up',
      followUpDate: { $ne: null },
    };
    const [followUpCount, followUps] = await Promise.all([
      Lead.countDocuments(followUpFilter),
      Lead.find(followUpFilter).select('name phone followUpDate').sort({ followUpDate: 1 }).limit(10).lean(),
    ]);

    // Enquiries by SRS status: clients with a consultation in the range, plus
    // (stylist leads) every enquiry created in the range.
    // Nizan clients have no lead, so their calls don't count here.
    const leadIds = new Set(inRange.filter((c) => c.leadId).map((c) => String(idOf(c.leadId))));
    if (viewAll && !scope.stylistId) {
      const created = await Lead.find({ createdAt: { $gte: rangeStart, $lte: rangeEnd } })
        .select('_id')
        .limit(3000)
        .lean();
      created.forEach((l) => leadIds.add(String(l._id)));
    }
    const ids = [...leadIds].slice(0, 3000);
    const [leads, allForLeads] = await Promise.all([
      Lead.find({ _id: { $in: ids } }).select('status').lean(),
      Consultation.find({ leadId: { $in: ids } }).select('leadId status scheduledAt').lean(),
    ]);
    const byLead = new Map();
    for (const c of allForLeads) {
      const key = String(c.leadId);
      if (!byLead.has(key)) byLead.set(key, []);
      byLead.get(key).push(c);
    }

    res.json({
      range: { from, to },
      scope: viewAll && !scope.stylistId ? 'all' : 'own',
      activeClients,
      statusCounts: countByStatus(inRange),
      perStylist: perStylistBreakdown(inRange),
      enquiryStatus: countDerivedStatuses(leads, byLead),
      today: todayList,
      upcoming,
      needsOutcome: needingOutcome(overdue, now),
      followUps: {
        count: followUpCount,
        items: followUps.map((l) => ({
          leadId: l._id,
          name: l.name,
          phone: l.phone,
          followUpDate: l.followUpDate,
          overdue: new Date(l.followUpDate) < now,
        })),
      },
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ── GET /api/consultations/stylists ─────────────────────────────────────────
// Users that can be assigned a consultation (any role with a consultations
// permission, plus admin/manager). Stylists get their own entry only.
export const getStylists = async (req, res) => {
  try {
    if (!req.consultAccess.viewAll) {
      return res.json([{ _id: req.user._id, name: req.user.name, role: req.user.role }]);
    }
    const roles = await Role.find({
      active: { $ne: false },
      permissions: { $regex: /^consultations(\.|$)/ },
    })
      .select('key')
      .lean();
    const keys = [...new Set([...roles.map((r) => r.key), 'admin', 'manager'])];
    const users = await User.find({ role: { $in: keys }, active: { $ne: false } })
      .select('name role')
      .sort({ name: 1 })
      .lean();
    res.json(users);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ── GET /api/consultations/leads/search?q= ──────────────────────────────────
// Lets a stylist find the enquiry to book a consultation for, without needing
// sales-module access. Returns only the fields needed to pick a client.
export const searchLeads = async (req, res) => {
  try {
    const q = clean(req.query.q);
    if (q.length < 2) return res.json([]);
    const rx = new RegExp(escapeRegex(q), 'i');
    const phoneRx = new RegExp(escapeRegex(q.replace(/\s+/g, '')), 'i');
    const leads = await Lead.find({
      $or: [{ name: rx }, { phone: phoneRx }, { alternateNumber: phoneRx }],
    })
      .select(LEAD_FIELDS)
      .sort({ updatedAt: -1 })
      .limit(20)
      .lean();
    res.json(leads);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ── GET /api/consultations/lead/:leadId ─────────────────────────────────────
// A client's consultation history plus the derived SRS client status.
export const getLeadConsultations = async (req, res) => {
  try {
    if (!isId(req.params.leadId)) return res.status(404).json({ message: 'Lead not found' });
    const lead = await Lead.findById(req.params.leadId).select(LEAD_FIELDS).lean();
    if (!lead) return res.status(404).json({ message: 'Lead not found' });

    const filter = { leadId: lead._id };
    if (!req.consultAccess.viewAll) filter.stylistId = req.user._id;

    const items = await Consultation.find(filter)
      .select(LIGHT_SELECT)
      .populate('stylistId', 'name')
      .sort({ scheduledAt: -1 })
      .lean();

    // The status reflects ALL of the client's consultations, even ones a
    // stylist cannot list, so it is computed from an unfiltered light query.
    const allForStatus = req.consultAccess.viewAll
      ? items
      : await Consultation.find({ leadId: lead._id }).select('status scheduledAt').lean();

    res.json({
      lead,
      derivedStatus: deriveClientStatus(lead, allForStatus),
      consultations: items,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ── GET /api/consultations/:id ──────────────────────────────────────────────
export const getConsultationById = async (req, res) => {
  try {
    const consultation = await loadConsultation(req, res);
    if (!consultation) return;
    await sendDetail(res, consultation._id, req);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ── POST /api/consultations ─────────────────────────────────────────────────
// body: clientId (or, from older app versions, leadId), scheduledAt (ISO with
//       timezone), durationMins?, stylistId?, mode?, meetingLink?,
//       meetingProvider?, location?, force?
export const createConsultation = async (req, res) => {
  try {
    const { mode = 'Video' } = req.body;
    const byLead = req.body.clientId === undefined;

    // The client file the call belongs to. Older app versions send a lead
    // instead; its Team N client file is found or created below.
    let client = null;
    if (!byLead) {
      if (!isId(req.body.clientId)) return res.status(400).json({ message: 'A valid clientId is required' });
      client = await StylistClient.findById(req.body.clientId);
      if (!client) return res.status(404).json({ message: 'Client not found' });
      if (!canActOnClient(req.consultAccess, req.user, client)) {
        return res.status(403).json({ message: 'You can only book calls for your own clients' });
      }
      if (client.status === 'Cancelled') {
        return res.status(409).json({ message: 'This client is cancelled. Reopen the client before booking a call.' });
      }
    } else {
      if (!isId(req.body.leadId)) return res.status(400).json({ message: 'A valid clientId is required' });
      const lead = await Lead.findById(req.body.leadId).select('_id').lean();
      if (!lead) return res.status(404).json({ message: 'Lead not found' });
    }

    const schedule = parseSchedule(req.body);
    if (!schedule.ok) return res.status(400).json({ message: schedule.message });

    if (!CONSULTATION_MODES.includes(mode)) {
      return res.status(400).json({ message: `mode must be one of ${CONSULTATION_MODES.join(', ')}` });
    }

    // Assign to oneself by default; assigning to someone else is for leads.
    let stylistId = req.user._id;
    if (req.body.stylistId && String(req.body.stylistId) !== String(req.user._id)) {
      if (!req.consultAccess.viewAll) {
        return res.status(403).json({ message: 'You can only book consultations for yourself' });
      }
      if (!(await isEligibleStylist(req.body.stylistId))) {
        return res.status(400).json({ message: 'That user cannot be assigned consultations' });
      }
      stylistId = req.body.stylistId;
    }

    const link = normalizeMeetingLink(req.body.meetingLink);
    if (!link.ok) return res.status(400).json({ message: link.message });
    const provider = MEETING_PROVIDERS.includes(req.body.meetingProvider)
      ? req.body.meetingProvider
      : detectProvider(link.value);

    const conflict = await checkConflicts(req, res, stylistId, schedule.start, schedule.end, null);
    if (!conflict.ok) return;

    if (byLead) {
      const found = await findOrCreateTeamNClient({ leadId: req.body.leadId, stylistId, user: req.user });
      if (!found) return res.status(404).json({ message: 'Lead not found' });
      if (!found.created && !canActOnClient(req.consultAccess, req.user, found.client)) {
        return res.status(403).json({ message: 'This client belongs to another stylist' });
      }
      client = found.client;
    }

    const base = {
      clientId: client._id,
      leadId: client.leadId ?? null,
      stylistId,
      scheduledAt: schedule.start,
      durationMins: schedule.durationMins,
      mode,
      meetingProvider: provider,
      meetingLink: link.value,
      location: clean(req.body.location),
      createdBy: req.user._id,
      createdByName: req.user.name ?? '',
      // Booking a slot that is already inside a reminder window needs no
      // immediate reminder for it.
      remindersSent: initialRemindersSent(schedule.start),
      history: [
        historyEntry({
          action: 'Scheduled',
          status: 'Scheduled',
          user: req.user,
          toAt: schedule.start,
          toStylistId: stylistId,
          overrodeConflict: conflict.overrode,
        }),
      ],
    };

    // The number is random; the unique index decides, so retry on a clash.
    let saved = null;
    for (let attempt = 0; attempt < 3 && !saved; attempt += 1) {
      try {
        saved = await new Consultation(base).save();
      } catch (err) {
        if (!(err?.code === 11000 && err?.keyPattern?.consultationNo)) throw err;
      }
    }
    if (!saved) return res.status(500).json({ message: 'Could not allocate a consultation number' });
    await renumberClientCalls(client._id);

    // Booked for someone else → tell them (the actor is never notified).
    await notifyAbout('assigned', saved._id, { actor: req.user });
    await sendDetail(res, saved._id, req, 201);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ── PUT /api/consultations/:id ──────────────────────────────────────────────
// Meeting details and notes only. Time / stylist changes go through /reschedule
// so the clash check and history always run.
export const updateConsultation = async (req, res) => {
  try {
    const consultation = await loadConsultation(req, res);
    if (!consultation) return;
    if (consultation.status === 'Cancelled') {
      return res.status(409).json({ message: 'A cancelled consultation is read-only' });
    }

    const changed = [];
    const body = req.body;

    if (body.mode !== undefined) {
      if (!CONSULTATION_MODES.includes(body.mode)) {
        return res.status(400).json({ message: `mode must be one of ${CONSULTATION_MODES.join(', ')}` });
      }
      if (body.mode !== consultation.mode) {
        consultation.mode = body.mode;
        changed.push('mode');
      }
    }

    if (body.meetingLink !== undefined) {
      const link = normalizeMeetingLink(body.meetingLink);
      if (!link.ok) return res.status(400).json({ message: link.message });
      if (link.value !== consultation.meetingLink) {
        consultation.meetingLink = link.value;
        consultation.meetingProvider = MEETING_PROVIDERS.includes(body.meetingProvider)
          ? body.meetingProvider
          : detectProvider(link.value);
        changed.push('meetingLink');
      }
    } else if (body.meetingProvider !== undefined && MEETING_PROVIDERS.includes(body.meetingProvider)) {
      if (body.meetingProvider !== consultation.meetingProvider) {
        consultation.meetingProvider = body.meetingProvider;
        changed.push('meetingProvider');
      }
    }

    if (body.location !== undefined && clean(body.location) !== consultation.location) {
      consultation.location = clean(body.location);
      changed.push('location');
    }

    const noteChanges = applyNoteFields(consultation, body, req);
    if (noteChanges === null) return res.status(403).json({ message: NO_NOTES_ACCESS });
    changed.push(...noteChanges);

    if (changed.length === 0) return sendDetail(res, consultation._id, req);

    consultation.history.push(
      historyEntry({
        action: 'Updated',
        status: consultation.status,
        user: req.user,
        fields: changed,
      })
    );
    await consultation.save();
    await sendDetail(res, consultation._id, req);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ── PATCH /api/consultations/:id/reschedule ─────────────────────────────────
// body: scheduledAt, durationMins?, stylistId?, reason?, force?
export const rescheduleConsultation = async (req, res) => {
  try {
    const consultation = await loadConsultation(req, res);
    if (!consultation) return;
    if (consultation.status !== 'Scheduled') {
      return res.status(409).json({ message: `A ${consultation.status.toLowerCase()} consultation cannot be rescheduled` });
    }

    const schedule = parseSchedule({
      scheduledAt: req.body.scheduledAt,
      durationMins: req.body.durationMins ?? consultation.durationMins,
    });
    if (!schedule.ok) return res.status(400).json({ message: schedule.message });

    let stylistId = consultation.stylistId;
    if (req.body.stylistId && String(req.body.stylistId) !== String(consultation.stylistId)) {
      if (!req.consultAccess.viewAll) {
        return res.status(403).json({ message: 'Only a stylist lead can reassign a consultation' });
      }
      if (!(await isEligibleStylist(req.body.stylistId))) {
        return res.status(400).json({ message: 'That user cannot be assigned consultations' });
      }
      stylistId = req.body.stylistId;
    }

    const conflict = await checkConflicts(req, res, stylistId, schedule.start, schedule.end, consultation._id);
    if (!conflict.ok) return;

    const reassigned = String(stylistId) !== String(consultation.stylistId);
    const entry = historyEntry({
      action: reassigned ? 'Rescheduled & reassigned' : 'Rescheduled',
      status: 'Scheduled',
      user: req.user,
      reason: req.body.reason,
      fromAt: consultation.scheduledAt,
      toAt: schedule.start,
      fromStylistId: reassigned ? consultation.stylistId : null,
      toStylistId: reassigned ? stylistId : null,
      overrodeConflict: conflict.overrode,
    });

    const previousStylistId = consultation.stylistId;
    const previousSlot = consultation.scheduledAt;

    consultation.scheduledAt = schedule.start;
    consultation.durationMins = schedule.durationMins;
    consultation.stylistId = stylistId;
    consultation.rescheduleCount += 1;
    // Reminders and the invite were for the old slot.
    consultation.remindersSent = initialRemindersSent(schedule.start);
    consultation.inviteSentAt = null;
    consultation.inviteChannel = '';
    consultation.history.push(entry);
    await consultation.save();
    // Moving a call can change its place in the client's series.
    await renumberClientCalls(consultation.clientId);

    if (reassigned) {
      const newStylist = await User.findById(stylistId).select('name').lean();
      await notifyAbout('assigned', consultation._id, { actor: req.user });
      await notifyAbout('reassigned', consultation._id, {
        actor: req.user,
        recipientId: previousStylistId,
        toStylistName: newStylist?.name,
        scheduledAt: previousSlot,
      });
    } else {
      await notifyAbout('rescheduled', consultation._id, { actor: req.user });
    }
    await sendDetail(res, consultation._id, req);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// Shared guard for the one-way transitions out of 'Scheduled'.
const transition = (action, status, apply, after = null) => async (req, res) => {
  try {
    const consultation = await loadConsultation(req, res);
    if (!consultation) return;
    if (consultation.status !== 'Scheduled') {
      return res.status(409).json({
        message: `Only a scheduled consultation can be marked ${status.toLowerCase()} (this one is ${consultation.status.toLowerCase()})`,
      });
    }

    const changedFields = apply(consultation, req, res);
    if (changedFields === false) return; // apply() already responded

    consultation.status = status;
    consultation.history.push(
      historyEntry({
        action,
        status,
        user: req.user,
        reason: req.body.reason,
        fields: changedFields ?? [],
      })
    );
    await consultation.save();
    // A cancelled call or a no-show gives up its number in the series.
    await renumberClientCalls(consultation.clientId);
    if (after) await after(consultation, req);
    await sendDetail(res, consultation._id, req);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ── PATCH /api/consultations/:id/invite-sent ────────────────────────────────
// Staff share the invite to the bride themselves (WhatsApp click-to-chat); this
// only records that they did, and when.
export const markInviteSent = async (req, res) => {
  try {
    const consultation = await loadConsultation(req, res);
    if (!consultation) return;
    if (consultation.status !== 'Scheduled') {
      return res.status(409).json({ message: 'Only a scheduled consultation can have an invite sent' });
    }
    consultation.inviteSentAt = new Date();
    consultation.inviteChannel = clean(req.body.channel) || 'WhatsApp';
    consultation.history.push(
      historyEntry({
        action: 'Invite shared',
        status: consultation.status,
        user: req.user,
        reason: consultation.inviteChannel,
      })
    );
    await consultation.save();
    await sendDetail(res, consultation._id, req);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ── PATCH /api/consultations/:id/cancel ─────────────────────────────────────
export const cancelConsultation = transition(
  'Cancelled',
  'Cancelled',
  (c, req) => {
    c.cancelledAt = new Date();
    c.cancelReason = clean(req.body.reason);
  },
  (c, req) => notifyAbout('cancelled', c._id, { actor: req.user })
);

// ── PATCH /api/consultations/:id/no-show ────────────────────────────────────
export const markNoShow = transition('No-show', 'No-show', () => {});

// ── PATCH /api/consultations/:id/complete ───────────────────────────────────
// body: any of NOTE_TEXT_FIELDS — the consultation outcome (FR-05).
export const completeConsultation = transition('Completed', 'Completed', (c, req, res) => {
  const fields = applyNoteFields(c, req.body, req);
  if (fields === null) {
    res.status(403).json({ message: NO_NOTES_ACCESS });
    return false;
  }
  c.completedAt = new Date();
  return fields;
});

// ── Reference images ────────────────────────────────────────────────────────
// Loads the consultation for an image change: it must exist, be the caller's
// (or a lead's), not be cancelled, and the caller must have notes access.
const loadForImages = async (req, res) => {
  const consultation = await loadConsultation(req, res);
  if (!consultation) return null;
  if (!canSeeNotes(req.consultAccess, req.user, consultation)) {
    res.status(403).json({ message: NO_NOTES_ACCESS });
    return null;
  }
  if (consultation.status === 'Cancelled') {
    res.status(409).json({ message: 'A cancelled consultation is read-only' });
    return null;
  }
  return consultation;
};

// POST /api/consultations/:id/images   multipart: images (1-15 files)
export const addReferenceImages = async (req, res) => {
  try {
    const consultation = await loadForImages(req, res);
    if (!consultation) return;
    const files = Array.isArray(req.files) ? req.files : [];
    const roomError = referenceImageRoomError(consultation.referenceImages.length, files.length);
    if (roomError) return res.status(400).json({ message: roomError });
    // The declared type is client-controlled; check the real file signature.
    if (files.some((f) => !sniffImageMime(f.buffer))) {
      return res.status(415).json({ message: 'Only JPEG, PNG or WebP images can be added.' });
    }

    const uploaded = [];
    try {
      for (const f of files) uploaded.push(await uploadReferenceImage(f.buffer));
    } catch (err) {
      // Don't leave orphans behind when one of a batch fails.
      await Promise.all(uploaded.map((u) => deleteReferenceImage(u.publicId)));
      console.error('reference image upload failed:', err.message);
      return res.status(502).json({ message: 'Could not upload the images. Try again.' });
    }

    const now = new Date();
    for (const u of uploaded) {
      consultation.referenceImages.push({
        url: u.url,
        publicId: u.publicId,
        uploadedBy: req.user._id,
        uploadedByName: req.user.name ?? '',
        uploadedAt: now,
      });
    }
    consultation.history.push(
      historyEntry({
        action: 'Updated',
        status: consultation.status,
        user: req.user,
        fields: ['referenceImages'],
        reason: `${uploaded.length} ${uploaded.length === 1 ? 'image' : 'images'} added`,
      })
    );
    await consultation.save();
    await sendDetail(res, consultation._id, req, 201);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

const findImage = (consultation, imageId) =>
  consultation.referenceImages.find((img) => String(img._id) === String(imageId));

// PATCH /api/consultations/:id/images/:imageId   body: caption
export const updateReferenceImage = async (req, res) => {
  try {
    const consultation = await loadForImages(req, res);
    if (!consultation) return;
    const image = findImage(consultation, req.params.imageId);
    if (!image) return res.status(404).json({ message: 'Image not found' });
    image.caption = clean(req.body.caption);
    await consultation.save();
    await sendDetail(res, consultation._id, req);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// DELETE /api/consultations/:id/images/:imageId
export const removeReferenceImage = async (req, res) => {
  try {
    const consultation = await loadForImages(req, res);
    if (!consultation) return;
    const image = findImage(consultation, req.params.imageId);
    if (!image) return res.status(404).json({ message: 'Image not found' });

    consultation.referenceImages = consultation.referenceImages.filter((img) => img !== image);
    consultation.history.push(
      historyEntry({
        action: 'Updated',
        status: consultation.status,
        user: req.user,
        fields: ['referenceImages'],
        reason: '1 image removed',
      })
    );
    await consultation.save();
    // Best effort: the record no longer points at it either way.
    await deleteReferenceImage(image.publicId);
    await sendDetail(res, consultation._id, req);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};
