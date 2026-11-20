import Booking from '../models/Booking.js';
import Conversation from '../models/Conversation.js';
import CrmCase, { ACTIVITY_TYPES, CASE_KINDS, CASE_OUTCOMES, CASE_STATUSES } from '../models/CrmCase.js';
import CrmSettings from '../models/CrmSettings.js';
import Trial from '../models/Trial.js';
import { canAssignCrmWork, seesWholeCrmTeam } from '../utils/crmAccess.js';
import { caseChangeRefusal, isOpenCase, isOverdue, normalizePhone } from '../utils/crmCaseRules.js';
import { NON_REVENUE_FILTER, reEngagementCutoff, reEngagementList } from '../utils/reEngagement.js';
import { notify, NOTIFICATION_TYPES } from '../utils/notify.js';
import { caseKindLabel, openCase } from '../services/crmCases.js';
import { getCrmSettings } from '../services/crmSettings.js';
import { sweepQuietly } from '../services/crmSweep.js';
import { crmTeamUsers, isOnCrmTeam } from '../services/crmTeam.js';
import { emptyLoad, loadQueue, workloadByOwner } from '../services/crmWork.js';
import { crmOverview } from '../services/crmMetrics.js';
import { crmGuard, fail, idOf, isId, lc, mayWrite, oid, requireWriter, route } from './crmHttp.js';
import { crmReportData, crmReportFileName, crmXlsx, writeCrmPdf } from '../services/crmReportFiles.js';
import { newFinancePdf } from '../services/financeReportFiles.js';
import { resolveReportPeriod } from '../utils/reportPeriod.js';

// The CRM team's work (/api/crm): who the viewer is, the team and its workload, the queue of work waiting, handing work out, the case
// tracker (complaints, follow-ups, re-engagement and trial calls) and the team's settings.
//
// Viewers (utils/crmAccess.js): admin / manager and the CRM Head see and assign everything; a CRM member sees their own work and the
// unassigned work they may claim; the CEO / Executive Director read everything and change nothing (middleware/ceoGuard.js refuses
// their writes before they reach here).

const HOUR_MS = 3600 * 1000;
const OPEN_CASE = ['open', 'in_progress'];

// ── who am I ────────────────────────────────────────────────────────────────

const settingsView = (s) => ({
  requestSlaHours: s.requestSlaHours,
  chatResponseSlaMins: s.chatResponseSlaMins,
  chatUnansweredHours: s.chatUnansweredHours,
  caseSlaHours: {
    complaint: s.caseSlaHours?.complaint,
    follow_up: s.caseSlaHours?.follow_up,
    re_engagement: s.caseSlaHours?.re_engagement,
    trial_follow_up: s.caseSlaHours?.trial_follow_up,
  },
  lowNps: s.lowNps,
  trialConversionDays: s.trialConversionDays,
  reEngagementWinDays: s.reEngagementWinDays,
  monthlyCustomerTarget: s.monthlyCustomerTarget ?? 100,
  trackingSince: s.trackingSince,
  updatedByName: s.updatedByName || '',
  updatedAt: s.updatedAt ?? null,
});

// @route GET /api/crm/me
export const getMe = route(async (req, res) => {
  await sweepQuietly();
  const settings = await getCrmSettings();
  const viewer = req.crmViewer;
  res.json({
    viewer,
    userId: idOf(req.user._id),
    name: req.user.name || '',
    isHead: viewer === 'head',
    canAssign: canAssignCrmWork(viewer),
    seesTeam: seesWholeCrmTeam(viewer),
    canWrite: mayWrite(viewer),
    onTeam: await isOnCrmTeam(req.user._id),
    trackingSince: settings.trackingSince,
    settings: settingsView(settings),
  });
});

// ── the queue ───────────────────────────────────────────────────────────────

const QUEUE_TYPES = ['booking', 'conversation', 'case', 'trial'];

/**
 * Whose work a request is about: { scope: all|mine|unassigned|member, ownerId }. A member may ask for their own and the unassigned;
 * the head, management and leadership for anyone's.
 */
const resolveScope = (req) => {
  const viewer = req.crmViewer;
  const me = idOf(req.user._id);
  const memberId = String(req.query.memberId ?? '').trim();
  if (memberId) {
    if (!isId(memberId)) fail(400, 'memberId is not a valid id.');
    if (memberId !== me && !seesWholeCrmTeam(viewer)) fail(403, 'You can see your own work only.');
    return { scope: 'member', ownerId: memberId };
  }
  const scope = lc(req.query.scope) || (seesWholeCrmTeam(viewer) ? 'all' : 'mine');
  if (!['all', 'mine', 'unassigned'].includes(scope)) fail(400, 'scope must be all, mine or unassigned.');
  if (scope === 'all' && !seesWholeCrmTeam(viewer)) fail(403, 'Only the CRM Head sees everyone\'s work.');
  return { scope, ownerId: scope === 'mine' ? me : null };
};

const typesOf = (q) => {
  const asked = String(q ?? '').split(',').map(lc).filter(Boolean);
  const types = asked.length ? QUEUE_TYPES.filter((t) => asked.includes(t)) : QUEUE_TYPES;
  if (!types.length) fail(400, `types must be among ${QUEUE_TYPES.join(', ')}.`);
  return types;
};

// @route GET /api/crm/queue?scope=all|mine|unassigned&memberId=&types=booking,conversation,case,trial
export const getQueue = route(async (req, res) => {
  const who = resolveScope(req);
  const types = typesOf(req.query.types);
  await sweepQuietly();
  const settings = await getCrmSettings();
  const items = await loadQueue(who, types, settings);
  const counts = { booking: 0, conversation: 0, case: 0, trial: 0, overdue: 0, total: items.length };
  for (const i of items) {
    counts[i.type] += 1;
    if (i.overdue) counts.overdue += 1;
  }
  res.json({ scope: who.scope, ownerId: who.ownerId, types, counts, items });
});

// ── the team and its workload ───────────────────────────────────────────────

// @route GET /api/crm/team — every member and their open work, the unassigned pile, and work still held by someone off the team
export const getTeam = route(async (req, res) => {
  if (!seesWholeCrmTeam(req.crmViewer)) fail(403, 'Only the CRM Head sees the team.');
  await sweepQuietly();
  const settings = await getCrmSettings();
  const [team, loads] = await Promise.all([crmTeamUsers(), workloadByOwner(settings)]);
  const strip = ({ name, ...w }) => w;
  const members = team.map((u) => ({
    userId: idOf(u._id),
    name: u.name,
    role: u.role,
    isHead: u.isHead,
    workload: strip(loads.get(idOf(u._id)) ?? { ...emptyLoad(), name: '' }),
  }));
  const onTeam = new Set(members.map((m) => m.userId));
  const elsewhere = [...loads.entries()]
    .filter(([id]) => id && !onTeam.has(id))
    .map(([id, w]) => ({ userId: id, name: w.name || '(not on the CRM team)', workload: strip(w) }));
  res.json({
    members,
    unassigned: strip(loads.get('') ?? { ...emptyLoad(), name: '' }),
    elsewhere,
  });
});

// ── handing work out ────────────────────────────────────────────────────────

const ASSIGNABLE = {
  booking: {
    model: Booking,
    owner: 'crmOwnerId',
    label: ['booking request', 'booking requests'],
    timestamps: false,
    update: (to, actor, now) => ({ $set: { crmOwnerId: to?._id ?? null, crmOwnerName: to?.name ?? '', crmAssignedAt: to ? now : null, crmAssignedBy: actor._id } }),
  },
  conversation: {
    model: Conversation,
    owner: 'assignedStaffId',
    label: ['client chat', 'client chats'],
    timestamps: false,
    update: (to, actor, now, claim) => ({
      $set: {
        assignedStaffId: to?._id ?? null,
        assignedStaffName: to?.name ?? '',
        assignedAt: to ? now : null,
        assignedBy: actor._id,
        assignedVia: to ? (claim ? 'claim' : 'head') : '',
      },
    }),
  },
  case: {
    model: CrmCase,
    owner: 'ownerId',
    label: ['case', 'cases'],
    timestamps: true,
    update: (to, actor, now, claim) => ({
      $set: { ownerId: to?._id ?? null, ownerName: to?.name ?? '', assignedAt: to ? now : null, assignedBy: actor._id },
      $push: {
        activities: {
          type: 'assign',
          text: to ? (claim ? `${to.name} took the case` : `Assigned to ${to.name}`) : 'Taken back to Unassigned',
          at: now,
          by: actor._id,
          byName: actor.name || '',
        },
      },
    }),
  },
  trial: {
    model: Trial,
    owner: 'crmOwnerId',
    label: ['trial', 'trials'],
    timestamps: false,
    update: (to, actor, now) => ({ $set: { crmOwnerId: to?._id ?? null, crmOwnerName: to?.name ?? '', crmAssignedAt: to ? now : null, crmAssignedBy: actor._id } }),
  },
};

/**
 * @route POST /api/crm/assign { items: [{ type: booking|conversation|case|trial, id }], ownerId }
 * The CRM Head (or management) gives work to a team member — or, with no ownerId, takes it back to Unassigned. A member may only
 * TAKE unassigned work for themselves. → { assigned, skipped: [{ type, id, reason }] }; the new owner is told once.
 */
export const assignWork = route(async (req, res) => {
  requireWriter(req);
  const viewer = req.crmViewer;
  const actor = req.user;
  const me = idOf(actor._id);
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  if (!items.length) fail(400, 'Choose what to assign.');
  if (items.length > 200) fail(400, 'Assign at most 200 at a time.');
  const ownerId = String(req.body?.ownerId ?? '').trim();
  const head = canAssignCrmWork(viewer);

  let to = null;
  if (ownerId) {
    if (!isId(ownerId)) fail(400, 'ownerId is not a valid id.');
    if (!head && ownerId !== me) fail(403, 'Only the CRM Head can give work to someone else.');
    const member = (await crmTeamUsers()).find((u) => idOf(u._id) === ownerId);
    if (!member) fail(400, 'That person is not on the CRM team.');
    to = { _id: member._id, name: member.name };
  } else if (!head) {
    fail(403, 'Only the CRM Head can take work back.');
  }
  const claim = !head;

  const now = new Date();
  const skipped = [];
  const done = { booking: 0, conversation: 0, case: 0, trial: 0 };
  const seen = new Set();
  for (const it of items) {
    const type = lc(it?.type);
    const id = String(it?.id ?? '');
    const cfg = ASSIGNABLE[type];
    const skip = (reason) => skipped.push({ type, id, reason });
    if (!cfg) {
      skip('Unknown kind of work.');
      continue;
    }
    if (!isId(id)) {
      skip('Not a valid id.');
      continue;
    }
    if (seen.has(`${type}:${id}`)) continue;
    seen.add(`${type}:${id}`);
    const doc = await cfg.model.findById(id).select(`${cfg.owner} status`).lean();
    if (!doc) {
      skip('Not found.');
      continue;
    }
    if (type === 'case' && !isOpenCase(doc)) {
      skip('The case is already finished.');
      continue;
    }
    const current = doc[cfg.owner] ? idOf(doc[cfg.owner]) : '';
    if (current === (to ? idOf(to._id) : '')) {
      skip(to ? `Already with ${to.name}.` : 'Already unassigned.');
      continue;
    }
    if (claim && current) {
      skip('Someone already has it.');
      continue;
    }
    // only if nobody changed the owner since it was read
    const r = await cfg.model.updateOne({ _id: doc._id, [cfg.owner]: doc[cfg.owner] ?? null }, cfg.update(to, actor, now, claim), { timestamps: cfg.timestamps });
    if (r.modifiedCount !== 1) {
      skip('It changed hands just now — refresh and try again.');
      continue;
    }
    done[type] += 1;
  }

  const assigned = Object.values(done).reduce((a, b) => a + b, 0);
  if (to && assigned && idOf(to._id) !== me) {
    const parts = Object.entries(done)
      .filter(([, n]) => n)
      .map(([t, n]) => `${n} ${ASSIGNABLE[t].label[n === 1 ? 0 : 1]}`);
    try {
      await notify({
        recipients: [to._id],
        type: NOTIFICATION_TYPES.CRM_ASSIGNED,
        title: `New CRM work for you: ${parts.join(', ')}`,
        body: `Assigned by ${actor.name || 'the CRM Head'}`,
        link: '/crm/my-work',
        createdBy: actor._id,
      });
    } catch (e) {
      console.error('crm assign notify failed:', e.message);
    }
  }
  res.json({ assigned, byType: done, ownerId: to ? idOf(to._id) : null, ownerName: to?.name ?? '', skipped });
});

// ── cases ───────────────────────────────────────────────────────────────────

const caseView = (c, now = new Date()) => ({
  ...c,
  id: idOf(c._id),
  kindLabel: caseKindLabel(c.kind),
  overdue: isOverdue(c, now),
});

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/// A member may look at a case that is theirs or nobody's.
const mayView = (req, c) => seesWholeCrmTeam(req.crmViewer) || !c.ownerId || idOf(c.ownerId) === idOf(req.user._id);

// @route GET /api/crm/cases?status=open|in_progress|resolved|closed|active&kind&ownerId&overdue=1&from&to&search&reviewId&page&limit
export const listCases = route(async (req, res) => {
  const q = req.query;
  const me = idOf(req.user._id);
  const filter = {};
  const status = lc(q.status);
  if (status === 'active') filter.status = { $in: OPEN_CASE };
  else if (status) {
    if (!CASE_STATUSES.includes(status)) fail(400, `status must be one of ${CASE_STATUSES.join(', ')} or active.`);
    filter.status = status;
  }
  const kind = lc(q.kind);
  if (kind) {
    if (!CASE_KINDS.includes(kind)) fail(400, `kind must be one of ${CASE_KINDS.join(', ')}.`);
    filter.kind = kind;
  }
  for (const link of ['reviewId', 'bookingId']) {
    const v = String(q[link] ?? '').trim();
    if (!v) continue;
    if (!isId(v)) fail(400, `${link} is not a valid id.`);
    filter[link] = oid(v);
  }
  const ownerId = String(q.ownerId ?? '').trim();
  if (ownerId === 'none') filter.ownerId = null;
  else if (ownerId) {
    if (!isId(ownerId)) fail(400, 'ownerId is not a valid id.');
    if (!seesWholeCrmTeam(req.crmViewer) && ownerId !== me) fail(403, 'You can see your own cases only.');
    filter.ownerId = oid(ownerId);
  } else if (!seesWholeCrmTeam(req.crmViewer)) {
    filter.$or = [{ ownerId: oid(me) }, { ownerId: null }];
  }
  if (String(q.overdue ?? '') === '1') {
    filter.status = { $in: OPEN_CASE };
    filter.dueAt = { $lt: new Date() };
  }
  if (q.from || q.to) {
    filter.createdAt = {};
    if (q.from) filter.createdAt.$gte = new Date(`${q.from}T00:00:00+05:30`);
    if (q.to) filter.createdAt.$lte = new Date(`${q.to}T23:59:59.999+05:30`);
    if (Object.values(filter.createdAt).some((d) => Number.isNaN(d.getTime()))) fail(400, 'from / to must be days (YYYY-MM-DD).');
  }
  const search = String(q.search ?? '').trim();
  if (search) {
    const re = new RegExp(escapeRe(search), 'i');
    const digits = normalizePhone(search);
    const or = [{ caseNumber: re }, { customerName: re }, { title: re }];
    if (digits.length >= 4) or.push({ phone: new RegExp(escapeRe(digits)) });
    filter.$and = [...(filter.$and ?? []), { $or: or }];
  }
  await sweepQuietly();
  const page = Math.max(1, Number.parseInt(q.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, Number.parseInt(q.limit, 10) || 25));
  const onlyOpen = filter.status?.$in === OPEN_CASE || OPEN_CASE.includes(filter.status);
  const [rows, totalItems] = await Promise.all([
    CrmCase.find(filter)
      .select('-activities')
      // work still to do: soonest due first; anything else: the latest first
      .sort(onlyOpen ? { dueAt: 1 } : { updatedAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    CrmCase.countDocuments(filter),
  ]);
  // counts by status over the same people (not the status filter), for the tabs
  const { status: _s, dueAt: _d, ...base } = filter;
  const now = new Date();
  const [byStatus, overdue] = await Promise.all([
    CrmCase.aggregate([{ $match: base }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
    CrmCase.countDocuments({ ...base, status: { $in: OPEN_CASE }, dueAt: { $lt: now } }),
  ]);
  const counts = { open: 0, in_progress: 0, resolved: 0, closed: 0, overdue };
  for (const r of byStatus) if (r._id in counts) counts[r._id] = r.n;
  res.json({
    items: rows.map((c) => caseView(c, now)),
    page,
    limit,
    totalItems,
    totalPages: Math.max(1, Math.ceil(totalItems / limit)),
    counts,
  });
});

// @route GET /api/crm/cases/:id
export const getCase = route(async (req, res) => {
  if (!isId(req.params.id)) fail(404, 'Case not found.');
  const c = await CrmCase.findById(req.params.id).lean();
  if (!c) fail(404, 'Case not found.');
  if (!mayView(req, c)) fail(403, 'This case belongs to someone else.');
  res.json(caseView(c));
});

const PRIORITIES = ['low', 'normal', 'high'];
const LINKS = ['bookingId', 'reviewId', 'trialId', 'conversationId'];

// @route POST /api/crm/cases { kind, title, description, priority, customerName, phone, bookingId, reviewId, trialId, conversationId, ownerId, slaHours }
export const createCase = route(async (req, res) => {
  requireWriter(req);
  const b = req.body ?? {};
  const head = canAssignCrmWork(req.crmViewer);
  const me = idOf(req.user._id);
  const kind = lc(b.kind);
  if (!CASE_KINDS.includes(kind)) fail(400, `kind must be one of ${CASE_KINDS.join(', ')}.`);
  const priority = lc(b.priority) || 'normal';
  if (!PRIORITIES.includes(priority)) fail(400, 'priority must be low, normal or high.');
  const links = {};
  for (const k of LINKS) {
    const v = String(b[k] ?? '').trim();
    if (!v) continue;
    if (!isId(v)) fail(400, `${k} is not a valid id.`);
    links[k] = oid(v);
  }
  let customerName = String(b.customerName ?? '').trim().slice(0, 120);
  let phone = String(b.phone ?? '').trim();
  if (links.bookingId && (!customerName || !phone)) {
    const bk = await Booking.findById(links.bookingId).select('customerName phone').lean();
    if (!bk) fail(400, 'That booking does not exist.');
    customerName ||= bk.customerName || '';
    phone ||= bk.phone || '';
  }
  const title = String(b.title ?? '').trim().slice(0, 160) || (customerName ? `${caseKindLabel(kind)}: ${customerName}` : '');
  if (!title) fail(400, 'Give the case a title or a client.');

  let owner = {};
  const ownerId = String(b.ownerId ?? '').trim();
  if (ownerId) {
    if (!isId(ownerId)) fail(400, 'ownerId is not a valid id.');
    if (!head && ownerId !== me) fail(403, 'Only the CRM Head can give a case to someone else.');
    const member = (await crmTeamUsers()).find((u) => idOf(u._id) === ownerId);
    if (!member) fail(400, 'That person is not on the CRM team.');
    owner = { ownerId: member._id, ownerName: member.name };
  } else if (!head) {
    // a member's own case is theirs
    owner = { ownerId: req.user._id, ownerName: req.user.name || '' };
  }
  let slaHours;
  if (b.slaHours !== undefined && b.slaHours !== null && b.slaHours !== '') {
    if (!head) fail(403, 'Only the CRM Head can change a case\'s time limit.');
    slaHours = Number(b.slaHours);
    if (!Number.isFinite(slaHours) || slaHours < 1 || slaHours > 2160) fail(400, 'The time limit must be 1 to 2160 hours.');
  }
  const c = await openCase(
    {
      kind,
      title,
      description: String(b.description ?? '').trim().slice(0, 4000),
      priority,
      customerName,
      phone,
      ...links,
      origin: 'manual',
      ...owner,
      ...(slaHours ? { slaHours } : {}),
    },
    req.user
  );
  res.status(201).json(caseView(c.toObject()));
});

const STATUS_LABEL = { open: 'Open', in_progress: 'In progress', resolved: 'Resolved', closed: 'Closed' };

// @route PATCH /api/crm/cases/:id { status, resolutionNote, outcome, priority, title, description, dueAt, wonBookingId }
export const updateCase = route(async (req, res) => {
  requireWriter(req);
  if (!isId(req.params.id)) fail(404, 'Case not found.');
  const c = await CrmCase.findById(req.params.id);
  if (!c) fail(404, 'Case not found.');
  const b = req.body ?? {};
  const viewer = req.crmViewer;
  const head = canAssignCrmWork(viewer);
  const now = new Date();
  const next = b.status === undefined ? '' : lc(b.status);
  if (next && !CASE_STATUSES.includes(next)) fail(400, `status must be one of ${CASE_STATUSES.join(', ')}.`);
  const note = b.resolutionNote === undefined ? undefined : String(b.resolutionNote ?? '').trim().slice(0, 4000);
  const refusal = caseChangeRefusal(c, { viewer, actorId: req.user._id, next, note });
  if (refusal) fail(/owner or the CRM Head|only look|Only the CRM Head/.test(refusal) ? 403 : 400, refusal);

  if (b.outcome !== undefined) {
    const outcome = lc(b.outcome);
    if (!CASE_OUTCOMES.includes(outcome)) fail(400, `outcome must be one of ${CASE_OUTCOMES.filter(Boolean).join(', ')}.`);
    c.outcome = outcome;
  }
  if (b.priority !== undefined) {
    const p = lc(b.priority);
    if (!PRIORITIES.includes(p)) fail(400, 'priority must be low, normal or high.');
    c.priority = p;
  }
  if (b.title !== undefined) {
    const t = String(b.title ?? '').trim().slice(0, 160);
    if (!t) fail(400, 'A case needs a title.');
    c.title = t;
  }
  if (b.description !== undefined) c.description = String(b.description ?? '').trim().slice(0, 4000);
  if (b.wonBookingId !== undefined) {
    const v = String(b.wonBookingId ?? '').trim();
    if (v && !isId(v)) fail(400, 'wonBookingId is not a valid id.');
    c.wonBookingId = v ? oid(v) : null;
  }
  if (b.dueAt !== undefined) {
    if (!head) fail(403, 'Only the CRM Head can move a due time.');
    const d = new Date(b.dueAt);
    if (Number.isNaN(d.getTime())) fail(400, 'dueAt is not a date.');
    c.dueAt = d;
    if (d > now) c.overdueNotifiedAt = null;
    c.activities.push({ type: 'note', text: `Due time moved to ${d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' })}`, at: now, by: req.user._id, byName: req.user.name || '' });
  }
  if (note !== undefined) c.resolutionNote = note;

  const from = c.status;
  if (next && next !== from) {
    c.status = next;
    if (next === 'resolved') {
      c.resolvedAt = now;
      c.resolvedBy = req.user._id;
      c.resolvedByName = req.user.name || '';
      c.closedAt = null;
    } else if (next === 'closed') {
      c.closedAt = now;
      c.resolvedAt = null;
    } else if (from === 'resolved' || from === 'closed') {
      // reopened: a fresh time limit from now
      c.resolvedAt = null;
      c.closedAt = null;
      c.outcome = b.outcome !== undefined ? c.outcome : '';
      c.dueAt = new Date(now.getTime() + (c.slaHours || 48) * HOUR_MS);
      c.overdueNotifiedAt = null;
    }
    const why = next === 'resolved' || next === 'closed' ? c.resolutionNote : String(b.reason ?? '').trim();
    c.activities.push({ type: 'status', text: `${STATUS_LABEL[from]} → ${STATUS_LABEL[next]}${why ? `: ${why.slice(0, 300)}` : ''}`, at: now, by: req.user._id, byName: req.user.name || '' });
  }
  await c.save();
  res.json(caseView(c.toObject(), now));
});

const LOGGABLE = ACTIVITY_TYPES.filter((t) => t === 'call' || t === 'whatsapp' || t === 'note');

// @route POST /api/crm/cases/:id/activities { type: call|whatsapp|note, text, outcome }
export const addCaseActivity = route(async (req, res) => {
  requireWriter(req);
  if (!isId(req.params.id)) fail(404, 'Case not found.');
  const c = await CrmCase.findById(req.params.id);
  if (!c) fail(404, 'Case not found.');
  const head = canAssignCrmWork(req.crmViewer);
  if (!head && idOf(c.ownerId) !== idOf(req.user._id)) fail(403, c.ownerId ? 'Only the case owner or the CRM Head can add to this case.' : 'Take the case first.');
  const type = lc(req.body?.type) || 'note';
  if (!LOGGABLE.includes(type)) fail(400, 'type must be call, whatsapp or note.');
  const text = String(req.body?.text ?? '').trim().slice(0, 2000);
  const outcome = String(req.body?.outcome ?? '').trim().slice(0, 60);
  if (text.length < 2 && !(type !== 'note' && outcome)) fail(400, 'Write what happened.');
  if (c.activities.length >= 500) fail(400, 'This case has too many entries; open a new one.');
  const now = new Date();
  c.activities.push({ type, text, outcome, at: now, by: req.user._id, byName: req.user.name || '' });
  // the first call or message to the client means the case is being worked on
  if (c.status === 'open' && type !== 'note') {
    c.status = 'in_progress';
    c.activities.push({ type: 'status', text: `${STATUS_LABEL.open} → ${STATUS_LABEL.in_progress}`, at: now, by: req.user._id, byName: req.user.name || '' });
  }
  await c.save();
  res.status(201).json(caseView(c.toObject(), now));
});

// ── re-engagement ───────────────────────────────────────────────────────────

const RE_LIST_LIMIT = 300;

// @route GET /api/crm/re-engagement?months=6 — past clients due a call, each with any open re-engagement case and the last one's outcome
export const getReEngagementList = route(async (req, res) => {
  const { months, cutoff } = reEngagementCutoff(req.query.months);
  const bookings = await Booking.find({ status: NON_REVENUE_FILTER }).select('customerName phone service serviceStart bookingDate').lean();
  const due = reEngagementList(bookings, { cutoff });
  const top = due.slice(0, RE_LIST_LIMIT);
  const keys = top.map((c) => c.phoneKey);
  const since = new Date(Date.now() - 180 * 24 * HOUR_MS);
  const cases = keys.length
    ? await CrmCase.find({ kind: 're_engagement', phone: { $in: keys }, $or: [{ status: { $in: OPEN_CASE } }, { updatedAt: { $gte: since } }] })
        .select('phone status outcome caseNumber ownerId ownerName resolvedAt closedAt updatedAt')
        .sort({ updatedAt: -1 })
        .lean()
    : [];
  const open = new Map();
  const last = new Map();
  for (const c of cases) {
    if (isOpenCase(c)) {
      if (!open.has(c.phone)) open.set(c.phone, { id: idOf(c._id), caseNumber: c.caseNumber, ownerId: c.ownerId ? idOf(c.ownerId) : null, ownerName: c.ownerName || '', status: c.status });
    } else if (!last.has(c.phone)) {
      last.set(c.phone, { id: idOf(c._id), caseNumber: c.caseNumber, outcome: c.outcome || '', status: c.status, at: c.resolvedAt ?? c.closedAt ?? c.updatedAt });
    }
  }
  res.json({
    months,
    cutoff,
    count: due.length,
    clients: top.map((c) => ({ ...c, openCase: open.get(c.phoneKey) ?? null, lastCase: last.get(c.phoneKey) ?? null })),
  });
});

// @route POST /api/crm/re-engagement/cases { clients: [{ phone, customerName, lastBookingId }], ownerId } → { created, skipped }
export const createReEngagementCases = route(async (req, res) => {
  requireWriter(req);
  const head = canAssignCrmWork(req.crmViewer);
  const me = idOf(req.user._id);
  const clients = Array.isArray(req.body?.clients) ? req.body.clients : [];
  if (!clients.length) fail(400, 'Choose the clients to call.');
  if (clients.length > 100) fail(400, 'At most 100 calls at a time.');
  const ownerId = String(req.body?.ownerId ?? '').trim();
  let owner = null;
  if (ownerId) {
    if (!isId(ownerId)) fail(400, 'ownerId is not a valid id.');
    if (!head && ownerId !== me) fail(403, 'Only the CRM Head can give calls to someone else.');
    const member = (await crmTeamUsers()).find((u) => idOf(u._id) === ownerId);
    if (!member) fail(400, 'That person is not on the CRM team.');
    owner = { ownerId: member._id, ownerName: member.name };
  } else if (!head) {
    owner = { ownerId: req.user._id, ownerName: req.user.name || '' };
  }
  const keys = [...new Set(clients.map((c) => normalizePhone(c?.phone)).filter((k) => k.length >= 6))];
  const busy = new Set((await CrmCase.find({ kind: 're_engagement', status: { $in: OPEN_CASE }, phone: { $in: keys } }).select('phone').lean()).map((c) => c.phone));
  const created = [];
  const skipped = [];
  const seen = new Set();
  const now = new Date();
  for (const cl of clients) {
    const key = normalizePhone(cl?.phone);
    if (key.length < 6) {
      skipped.push({ phone: String(cl?.phone ?? ''), reason: 'No phone number.' });
      continue;
    }
    if (busy.has(key) || seen.has(key)) {
      skipped.push({ phone: key, reason: 'A call for this client is already open.' });
      continue;
    }
    seen.add(key);
    const bookingId = isId(cl?.lastBookingId) ? oid(cl.lastBookingId) : null;
    const name = String(cl?.customerName ?? '').trim().slice(0, 120);
    const c = await openCase(
      {
        kind: 're_engagement',
        title: `Re-engagement call: ${name || key}`,
        priority: 'normal',
        customerName: name,
        phone: key,
        bookingId,
        origin: 're_engagement_list',
        ...(owner ?? {}),
      },
      req.user,
      now,
      { notifyOwner: false }
    );
    created.push({ id: idOf(c._id), caseNumber: c.caseNumber, phone: key, customerName: name });
  }
  if (owner && created.length && idOf(owner.ownerId) !== me) {
    try {
      await notify({
        recipients: [owner.ownerId],
        type: NOTIFICATION_TYPES.CRM_ASSIGNED,
        title: `${created.length} re-engagement ${created.length === 1 ? 'call' : 'calls'} for you`,
        body: `From ${req.user.name || 'the CRM Head'}`,
        link: '/crm/cases',
        createdBy: req.user._id,
      });
    } catch (e) {
      console.error('crm re-engagement notify failed:', e.message);
    }
  }
  res.status(201).json({ created, skipped });
});

// ── the dashboard ───────────────────────────────────────────────────────────

/// The longest period the dashboard and the report cover.
export const CRM_MAX_DAYS = 366;

/**
 * Whose figures: a member always their own (asking for someone else's is refused); the head, management and leadership the team's,
 * or one member's with ?memberId. → null (the team) or { userId, name }.
 */
const memberFor = async (req) => {
  const me = idOf(req.user._id);
  const asked = String(req.query.memberId ?? '').trim();
  if (!seesWholeCrmTeam(req.crmViewer)) {
    if (asked && asked !== me) fail(403, 'You can see your own figures only.');
    return { userId: me, name: req.user.name || '' };
  }
  if (!asked) return null;
  if (!isId(asked)) fail(400, 'memberId is not a valid id.');
  const u = (await crmTeamUsers()).find((x) => idOf(x._id) === asked);
  if (!u) fail(404, 'That person is not on the CRM team.');
  return { userId: asked, name: u.name };
};

/// The period from ?from&to (IST days) or ?month&year; this month when neither is given.
export const crmPeriodOf = (query) => {
  const period = resolveReportPeriod(query, { maxDays: CRM_MAX_DAYS, defaultToThisMonth: true });
  if (period.error) fail(400, period.error);
  return period;
};

// @route GET /api/crm/overview?from&to [&memberId] — the CRM dashboard
export const getOverview = route(async (req, res) => {
  const period = crmPeriodOf(req.query);
  const member = await memberFor(req);
  await sweepQuietly();
  res.json(await crmOverview({ period, member }));
});

// @route GET /api/crm/report?from&to&format=xlsx|pdf [&memberId] — the CRM report as a file (the head: the team or one member; a
// member: their own). The app downloads it with its login header; the token never goes in the address.
export const getReport = route(async (req, res) => {
  const format = lc(req.query.format) || 'xlsx';
  if (!['xlsx', 'pdf'].includes(format)) fail(400, 'format must be xlsx or pdf.');
  const period = crmPeriodOf(req.query);
  const member = await memberFor(req);
  const data = await crmReportData({ period, member });
  res.attachment(crmReportFileName(data.overview, period, format));
  if (format === 'xlsx') return res.send(await crmXlsx(data));
  const doc = newFinancePdf();
  res.header('Content-Type', 'application/pdf');
  doc.pipe(res);
  writeCrmPdf(doc, data);
  doc.end();
});

// ── settings ────────────────────────────────────────────────────────────────

// @route GET /api/crm/settings
export const getSettings = route(async (req, res) => {
  res.json(settingsView(await getCrmSettings()));
});

const SETTING_RANGES = {
  requestSlaHours: [1, 720],
  chatResponseSlaMins: [5, 1440],
  chatUnansweredHours: [1, 168],
  'caseSlaHours.complaint': [1, 2160],
  'caseSlaHours.follow_up': [1, 2160],
  'caseSlaHours.re_engagement': [1, 2160],
  'caseSlaHours.trial_follow_up': [1, 2160],
  lowNps: [0, 10],
  trialConversionDays: [1, 365],
  reEngagementWinDays: [1, 365],
  monthlyCustomerTarget: [1, 10000],
};

// @route PUT /api/crm/settings — the CRM Head or management; only the fields sent change
export const updateSettings = route(async (req, res) => {
  requireWriter(req);
  if (!canAssignCrmWork(req.crmViewer)) fail(403, 'Only the CRM Head can change the CRM settings.');
  const b = req.body ?? {};
  const set = {};
  for (const [path, [min, max]] of Object.entries(SETTING_RANGES)) {
    const [a, k] = path.split('.');
    const raw = k ? b[a]?.[k] : b[a];
    if (raw === undefined || raw === null || raw === '') continue;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < min || n > max || (path !== 'lowNps' && !Number.isInteger(n))) {
      fail(400, `${path} must be a whole number from ${min} to ${max}.`);
    }
    set[path] = n;
  }
  if (!Object.keys(set).length) fail(400, 'Nothing to change.');
  await getCrmSettings(); // make sure the record (and its trackingSince) exists
  const s = await CrmSettings.findOneAndUpdate(
    { singleton: 'crm' },
    { $set: { ...set, updatedBy: req.user._id, updatedByName: req.user.name || '' } },
    { new: true, runValidators: true }
  ).lean();
  res.json(settingsView(s));
});

// the guard lives with the other shared helpers; it is exported from here too, where the routes have always taken it
export { crmGuard };
