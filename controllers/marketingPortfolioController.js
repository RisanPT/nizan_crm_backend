import asyncHandler from 'express-async-handler';
import WorkFootage from '../models/WorkFootage.js';
import { footageState, sizeLabel } from '../utils/workFootage.js';
import { addToMoodboard, checkPdf, utf8Name, cleanLogistics, cleanMoodboardItems, DOC_PART_NAMES, DOC_PARTS, makeDocKey, MAX_DOCS_PER_PART, mergeStoryboard, moodboardKind, relabelMoodboard, removeFromMoodboard, shiftMilestones, shotProgress, withFrameKeys } from '../utils/shootBoard.js';
import { getPdf, putPdf, removePdf } from '../services/shootFiles.js';
import mongoose from 'mongoose';
import MarketingShoot, { MILESTONE_KEYS } from '../models/MarketingShoot.js';
import MarketingAsset from '../models/MarketingAsset.js';
import MarketingActivity from '../models/MarketingActivity.js';
import ContentItem from '../models/ContentItem.js';
import Booking from '../models/Booking.js';
import Employee from '../models/Employee.js';
import Attendance from '../models/Attendance.js';
import { MarketingTeamMember, MarketingMemberRole } from '../models/MarketingEod.js';
import LeaveRequest from '../models/LeaveRequest.js';
import User from '../models/User.js';
import { toDateStr, canManageCreative, isCreativeDirector, canViewTeam, findOwnMember } from './marketingEodController.js';
import { isDay } from '../utils/marketingActivityInput.js';
import { cleanShootInput, defaultMilestoneDates } from '../utils/marketingPortfolioInput.js';
import * as P from '../utils/marketingPortfolioStats.js';
import * as T from '../utils/marketingTeamStats.js';
import { shootFromLogs, syncShootFromLogs } from '../services/marketingShootSync.js';

// The Creative Portfolio — Shoot Planner, Production Calendar, Shoot Reports (the Gallery reads the shared asset library in the Socials
// controller). Routes: routes/marketingPortfolioRoutes.js, /api/marketing/portfolio. Every number is defined in
// utils/marketingPortfolioStats.js; a shoot's progress is moved by the work members LOG against it (services/marketingShootSync.js).

const idOf = (v) => (v == null ? '' : String(v._id ?? v));
const bad = (res, message, status = 400) => {
  res.status(status);
  throw new Error(message);
};

const weekOf = (day) => {
  const dow = new Date(Date.parse(`${day}T00:00:00Z`)).getUTCDay();
  const monday = T.addDays(day, -((dow + 6) % 7));
  return { from: monday, to: T.addDays(monday, 6) };
};

/** ?from=&to=&brand= → the checked range. The planner and reports default to this month; the calendar to the month too. */
const readRange = (req, res) => {
  const today = toDateStr();
  const first = `${today.slice(0, 8)}01`;
  const last = T.addDays(`${T.addDays(first, 31).slice(0, 8)}01`, -1);
  const from = req.query.from ?? first;
  const to = req.query.to ?? last;
  if (!isDay(from) || !isDay(to)) bad(res, 'The dates must be YYYY-MM-DD.');
  if (to < from) bad(res, 'The end date is before the start date.');
  if (T.daysBetween(from, to) > 366) bad(res, 'Choose a range of a year or less.');
  const brand = String(req.query.brand ?? 'all').toLowerCase();
  if (!['all', 'main', 'kerala'].includes(brand)) bad(res, 'Choose All, Main or Kerala.');
  return { from, to, brand, today };
};

const assetBrief = (a) => ({ id: idOf(a), title: a.title, kind: a.kind, media: a.media, stage: a.stage, url: a.url, thumbUrl: a.thumbUrl || '', isFinal: !!a.isFinal, durationSec: a.durationSec ?? 0, sizeMb: a.sizeMb ?? 0, approvedAt: a.approvedAt ?? null, createdAt: a.createdAt });
const postBrief = (p) => ({ id: idOf(p), title: p.title, platform: p.platform, contentType: p.contentType, status: p.status, brand: p.brand ?? 'main', scheduledDate: p.scheduledDate, publishedDate: p.publishedDate ?? null, permalink: p.permalink ?? '', assetId: p.assetId ? idOf(p.assetId) : null });
const POST_FIELDS = 'shootId assetId title platform contentType status brand scheduledDate publishedDate permalink';
const ASSET_FIELDS = 'shootId kind media stage tags isFinal sizeMb durationSec approvedAt createdAt title url thumbUrl';

const DEAD_BOOKING = new Set(['cancelled', 'canceled', 'rejected', 'lost', 'postponed']);
const BOOKING_FIELDS = 'bookingNumber customerName service status selectedDates bookingDate serviceStart district contentCreationRequired';
/** A work (CRM booking) as the shoot screens name it — never the client's phone or address. */
const bookingBrief = (b) => (b ? { id: idOf(b), bookingNumber: b.bookingNumber ?? '', customerName: b.customerName ?? '', service: b.service ?? '', status: b.status ?? '', eventDate: P.bookingDays(b)[0] ?? null, eventDates: P.bookingDays(b), district: b.district ?? '', contentRequired: !!b.contentCreationRequired } : null);

const summary = (s, assets = []) => {
  const r = P.reportRow(s, assets);
  return {
    id: idOf(s),
    title: s.title,
    brand: s.brand ?? 'main',
    category: s.category ?? '',
    shootType: s.shootType ?? '',
    status: s.status,
    shootDate: s.shootDate,
    startTime: s.startTime ?? '',
    endTime: s.endTime ?? '',
    location: s.location ?? '',
    coverUrl: s.coverUrl ?? '',
    crewCount: (s.crew ?? []).length,
    progress: r.progress,
    planned: r.planned,
    plannedTotal: r.plannedTotal,
    delivered: r.delivered,
    deliveredPosts: r.deliveredPosts,
    deliveredTotal: r.deliveredTotal,
    turnaround: r.turnaround,
    rescheduleCount: s.rescheduleCount ?? 0,
    delayed: P.isDelayed(s, toDateStr()),
    bookingId: s.bookingId ? idOf(s.bookingId) : null,
  };
};

/** For each shoot: its assets and the posts linked to it, as the counts read them (utils/marketingPortfolioStats.js assetsByShoot). */
const loadAssetsFor = async (shoots) => {
  const ids = shoots.map((s) => s._id);
  if (!ids.length) return new Map();
  const [assets, posts] = await Promise.all([MarketingAsset.find({ shootId: { $in: ids } }).select(ASSET_FIELDS).lean(), ContentItem.find({ shootId: { $in: ids } }).select(POST_FIELDS).lean()]);
  return P.assetsByShoot(assets, posts);
};

/** Whose logged work a viewer may see: a manager (or management) the whole team's, a member only their own. → a query part, or null. */
const logScope = async (user) => {
  if (canViewTeam(user) || isCreativeDirector(user)) return { scope: 'team', query: {} }; // the Creative Director sees the team's work on shoots too
  const own = await findOwnMember(user);
  return own ? { scope: 'own', query: { memberId: own._id } } : { scope: 'own', query: null };
};

// ── Shoot Planner ─────────────────────────────────────────────────────────────

export const listShoots = asyncHandler(async (req, res) => {
  const range = readRange(req, res);
  const { status } = req.query;
  const text = String(req.query.q ?? '').trim();
  const pageSize = Math.min(Math.max(parseInt(req.query.limit, 10) || 8, 1), 50);
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);

  // the KPI strip counts the range; "this week" is always the week of today
  const week = weekOf(range.today);
  const windowFrom = range.from < week.from ? range.from : week.from;
  const windowTo = range.to > week.to ? range.to : week.to;
  const all = await MarketingShoot.find({ shootDate: { $gte: windowFrom, $lte: windowTo } }).lean();
  const counts = P.shootCounts(all, range, { today: range.today, weekFrom: week.from, weekTo: week.to });

  let list = P.shootsInRange(all, range);
  if (status && status !== 'all') list = list.filter((s) => (status === 'planned' ? ['planned', 'pre_production'].includes(s.status) : s.status === status));
  if (text) {
    const rx = new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    list = list.filter((s) => rx.test(s.title) || rx.test(s.category ?? '') || rx.test(s.pillar ?? '') || rx.test(s.location ?? ''));
  }
  list.sort((a, b) => (a.shootDate < b.shootDate ? -1 : a.shootDate > b.shootDate ? 1 : (a.startTime ?? '') < (b.startTime ?? '') ? -1 : 1));
  const total = list.length;
  const paged = list.slice((page - 1) * pageSize, page * pageSize);
  const byShoot = await loadAssetsFor(paged);
  res.json({ from: range.from, to: range.to, brand: range.brand, counts, total, page, pageSize, items: paged.map((s) => summary(s, byShoot.get(idOf(s)) ?? [])) });
});

export const getShoot = asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) bad(res, 'That shoot was not found.', 404);
  const s = await MarketingShoot.findById(req.params.id).lean();
  if (!s) bad(res, 'That shoot was not found.', 404);
  // frames saved before frames had keys get one now (a frame is ticked by its key) — once, only if nobody changed them meanwhile
  const keyed = withFrameKeys(s.storyboard ?? []);
  if (keyed.changed) {
    await MarketingShoot.updateOne({ _id: s._id, storyboard: s.storyboard }, { $set: { storyboard: keyed.frames } });
    s.storyboard = keyed.frames;
  }
  const [assets, posts, booking, logView, footage] = await Promise.all([
    MarketingAsset.find({ shootId: s._id }).sort({ createdAt: -1 }).limit(200).lean(),
    ContentItem.find({ shootId: s._id }).select(POST_FIELDS).sort({ scheduledDate: -1 }).limit(200).lean(),
    s.bookingId ? Booking.findById(s.bookingId).select(BOOKING_FIELDS).lean() : null,
    logScope(req.user),
    // the raw footage the artists handed in for the work this shoot covers (routes /api/work-footage)
    s.bookingId ? WorkFootage.find({ bookingId: s.bookingId }).sort({ day: 1 }).lean() : [],
  ]);
  const outputs = P.mergeOutputs(assets, posts);
  // the work logged against the shoot: a member sees only their own entries
  const logs = logView.query ? await MarketingActivity.find({ shootId: s._id, ...logView.query }).sort({ loggedAt: -1 }).limit(12).lean() : [];
  const members = logs.length ? await MarketingTeamMember.find({ _id: { $in: [...new Set(logs.map((l) => idOf(l.memberId)))] } }).select('name').lean() : [];
  const nameOf = new Map(members.map((m) => [idOf(m), m.name]));
  const done = new Map((s.milestones ?? []).map((m) => [m.key, m]));
  res.json({
    ...summary(s, outputs),
    pillar: s.pillar ?? '',
    brief: s.brief ?? {},
    crew: (s.crew ?? []).map((c) => ({ memberId: c.memberId ? idOf(c.memberId) : null, employeeId: c.employeeId ? idOf(c.employeeId) : null, name: c.name, role: c.role })),
    references: refsView(s.references),
    cameraRefs: refsView(s.cameraRefs),
    logistics: logisticsView(s.logistics),
    storyboard: storyboardView(s.storyboard),
    documents: documentsView(s.documents),
    shotProgress: shotProgress(s.storyboard),
    booking: bookingBrief(booking),
    milestones: P.MILESTONES.map((m) => ({ key: m.key, label: m.label, date: done.get(m.key)?.date ?? null, doneAt: done.get(m.key)?.doneAt ?? null })),
    currentMilestone: P.currentMilestone(s),
    assets: assets.map(assetBrief),
    posts: posts.map(postBrief),
    checklist: P.contentChecklist(s, assets, posts),
    footageMb: assets.reduce((t, a) => t + (a.sizeMb ?? 0), 0),
    takeaways: P.takeaways(s, outputs),
    activity: logs.map((l) => ({ id: idOf(l), member: nameOf.get(idOf(l.memberId)) ?? '', workedOn: l.workedOn, stage: l.shootStage ?? '', status: l.status, day: l.entryDate })),
    activityScope: logView.scope,
    footage: footage.map((f) => ({ id: idOf(f), day: f.day, folderName: f.folderName, state: footageState(f), size: sizeLabel(f.totalBytes), editorName: f.editorName ?? '', links: (f.links ?? []).map((l) => ({ url: l.url, label: l.label ?? '', kind: l.kind, addedByName: l.addedByName ?? '', summary: l.summary ?? '' })) })),
  });
});

/** A linked booking must exist. */
const checkBooking = async (res, bookingId) => {
  if (bookingId && !(await Booking.exists({ _id: bookingId }))) bad(res, 'That booking no longer exists.');
};

const crewFromMembers = async (crew) => {
  // a crew line that names a team member gets that member's own name and current role (so the plan cannot disagree with the team list)
  const ids = crew.filter((c) => c.memberId).map((c) => c.memberId);
  if (!ids.length) return crew;
  const members = await MarketingTeamMember.find({ _id: { $in: ids } }).select('name').lean();
  const month = toDateStr().slice(0, 7);
  const roles = await MarketingMemberRole.find({ memberId: { $in: ids }, fromMonth: { $lte: month } }).sort({ fromMonth: -1 }).populate('roleId').lean();
  const role = new Map();
  for (const r of roles) if (!role.has(idOf(r.memberId))) role.set(idOf(r.memberId), r.roleId?.name ?? '');
  const name = new Map(members.map((m) => [idOf(m), m.name]));
  return crew.map((c) => (c.memberId && name.has(c.memberId) ? { memberId: c.memberId, employeeId: null, name: name.get(c.memberId), role: c.role || role.get(c.memberId) || '' } : c));
};

/** A crew line that names a makeup artist gets the artist's own name (and "Makeup Artist" when no role is typed). */
const crewFromArtists = async (crew) => {
  const ids = crew.filter((c) => c.employeeId && !c.memberId).map((c) => c.employeeId);
  if (!ids.length) return crew;
  const emps = await Employee.find({ _id: { $in: ids } }).select('name artistRole').lean();
  const by = new Map(emps.map((e) => [idOf(e), e]));
  return crew
    .filter((c) => !c.employeeId || c.memberId || by.has(c.employeeId))
    .map((c) => (c.employeeId && by.has(c.employeeId) ? { ...c, name: by.get(c.employeeId).name, role: c.role || (by.get(c.employeeId).artistRole === 'assistant' ? 'Makeup Assistant' : 'Makeup Artist') } : c));
};
const cleanCrew = async (crew) => crewFromArtists(await crewFromMembers(crew));

export const createShoot = asyncHandler(async (req, res) => {
  const v = cleanShootInput(req.body);
  if (!v.ok) bad(res, v.message);
  const { milestoneDates, ...fields } = v.value;
  await checkBooking(res, fields.bookingId);
  const dates = { ...defaultMilestoneDates(fields.shootDate, T.addDays), ...Object.fromEntries((milestoneDates ?? []).filter((m) => m.date).map((m) => [m.key, m.date])) };
  const now = new Date();
  const shoot = await MarketingShoot.create({
    ...fields,
    ...(fields.storyboard ? { storyboard: mergeStoryboard([], fields.storyboard) } : {}),
    crew: await cleanCrew(fields.crew ?? []),
    // the brief is done the moment the plan exists; the rest move when work is logged
    milestones: MILESTONE_KEYS.map((key) => ({ key, date: dates[key] ?? null, doneAt: key === 'brief' ? now : null })),
    createdBy: req.user._id,
  });
  res.status(201).json(summary(shoot.toObject()));
});

export const updateShoot = asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) bad(res, 'That shoot was not found.', 404);
  const shoot = await MarketingShoot.findById(req.params.id);
  if (!shoot) bad(res, 'That shoot was not found.', 404);
  const v = cleanShootInput(req.body, shoot);
  if (!v.ok) bad(res, v.message);
  const { milestoneDates, crew, ...fields } = v.value;
  await checkBooking(res, fields.bookingId);
  const oldDay = shoot.shootDate;
  const moved = !!fields.shootDate && fields.shootDate !== oldDay;
  if (moved) shoot.rescheduleCount = (shoot.rescheduleCount ?? 0) + 1;
  // an edit of the frames (text, order, pictures) keeps the "shot" ticks of the frames that stay
  if (fields.storyboard) fields.storyboard = mergeStoryboard(plain(shoot.storyboard), fields.storyboard);
  Object.assign(shoot, fields);
  // a shoot moved to another day takes its milestones not yet done with it (unless the dates were sent) — else it reads "Delayed"
  if (moved && !milestoneDates) shoot.milestones = shiftMilestones(shoot.milestones.map((m) => (m.toObject ? m.toObject() : m)), oldDay, fields.shootDate);
  if (crew) shoot.crew = await cleanCrew(crew);
  if (milestoneDates) {
    const by = new Map(milestoneDates.map((m) => [m.key, m.date]));
    shoot.milestones = shoot.milestones.map((m) => ({ key: m.key, doneAt: m.doneAt, date: by.has(m.key) ? by.get(m.key) : m.date }));
  }
  // marking it complete (or taking it back) moves the distribution milestone; logs decide the production ones
  const logs = await MarketingActivity.find({ shootId: shoot._id, shootStage: { $ne: null } }).select('shootStage status loggedAt createdAt').lean();
  const next = shootFromLogs(shoot.toObject(), logs);
  shoot.milestones = next.milestones;
  await shoot.save();
  res.json(summary(shoot.toObject()));
});

// ── moodboard and logistics (anyone on the team, like the plan itself) ─────────

const refsView = (refs) => (refs ?? []).map((r) => ({ url: r.url, label: r.label ?? '', kind: r.kind || moodboardKind(r.url), addedByName: r.addedByName ?? '', addedAt: r.addedAt ?? null }));
const logisticsView = (l) => ({ callTime: l?.callTime ?? '', mapUrl: l?.mapUrl ?? '', notes: l?.notes ?? '', checklist: (l?.checklist ?? []).map((c) => ({ text: c.text, done: !!c.done, byName: c.byName ?? '', at: c.at ?? null })) });
const plain = (list) => (list ?? []).map((x) => (x?.toObject ? x.toObject() : x));
/** The PDFs as the app sees them — never where they are kept. */
const documentsView = (docs) =>
  // a name saved garbled before the upload read names right ("Flow Â· Team N") is shown right
  (docs ?? []).map((d) => ({ key: d.key, part: d.part, name: utf8Name(d.name ?? ''), label: d.label ?? '', sizeBytes: d.sizeBytes ?? 0, pages: d.pages ?? null, addedByName: d.addedByName ?? '', addedAt: d.addedAt ?? null }));
const storyboardView = (frames) =>
  (frames ?? []).map((f, i) => ({ key: f.key ?? '', shotNo: f.shotNo || String(i + 1), description: f.description, shotType: f.shotType ?? '', durationSec: f.durationSec ?? 0, referenceUrl: f.referenceUrl ?? '', imageUrl: f.imageUrl ?? '', notes: f.notes ?? '', shotAt: f.shotAt ?? null, shotByName: f.shotByName ?? '' }));

const shootOr404 = async (res, id) => {
  if (!mongoose.isValidObjectId(id)) bad(res, 'That shoot was not found.', 404);
  const shoot = await MarketingShoot.findById(id);
  if (!shoot) bad(res, 'That shoot was not found.', 404);
  return shoot;
};

// the two boards of pictures and links: the moodboard (references) and the Camera Movement plan (cameraRefs) — the same rules each
const BOARDS = {
  moodboard: { field: 'references', name: 'the moodboard', what: 'A moodboard' },
  camera: { field: 'cameraRefs', name: 'the camera movement plan', what: 'The camera movement plan' },
};

/** Add pictures and links to a board ({ items: [{ url, label }] }) — a picture uploaded from the phone arrives as its link. */
const addToBoard = (board) => asyncHandler(async (req, res) => {
  const b = BOARDS[board];
  const shoot = await shootOr404(res, req.params.id);
  const v = cleanMoodboardItems(req.body?.items ?? (req.body?.url ? [req.body] : []));
  if (!v.ok) bad(res, v.message);
  const r = addToMoodboard(plain(shoot[b.field]), v.value, { byName: req.user?.name ?? '', what: b.what });
  if (!r.ok) bad(res, r.message);
  shoot[b.field] = r.list;
  await shoot.save();
  res.status(201).json({ [b.field]: refsView(shoot[b.field]), added: r.added, skipped: r.skipped });
});

/** An item's label on a board ({ url, label }). */
const renameOnBoard = (board) => asyncHandler(async (req, res) => {
  const b = BOARDS[board];
  const shoot = await shootOr404(res, req.params.id);
  const url = String(req.body?.url ?? '');
  if (!plain(shoot[b.field]).some((r) => r.url === url)) bad(res, `That picture or link is not on ${b.name}.`, 404);
  shoot[b.field] = relabelMoodboard(plain(shoot[b.field]), url, req.body?.label);
  await shoot.save();
  res.json({ [b.field]: refsView(shoot[b.field]) });
});

/** Take an item off a board (?url=); a moodboard picture that was the shoot's cover takes the cover with it. */
const removeFromBoard = (board) => asyncHandler(async (req, res) => {
  const b = BOARDS[board];
  const shoot = await shootOr404(res, req.params.id);
  const url = String(req.query.url ?? req.body?.url ?? '');
  const r = removeFromMoodboard(plain(shoot[b.field]), url);
  if (!r.removed) bad(res, `That picture or link is not on ${b.name}.`, 404);
  shoot[b.field] = r.list;
  if (board === 'moodboard' && shoot.coverUrl && url === shoot.coverUrl) shoot.coverUrl = '';
  await shoot.save();
  res.json({ [b.field]: refsView(shoot[b.field]), coverUrl: shoot.coverUrl ?? '' });
});

export const addMoodboard = addToBoard('moodboard');
export const renameMoodboardItem = renameOnBoard('moodboard');
export const removeMoodboard = removeFromBoard('moodboard');
export const addCameraRefs = addToBoard('camera');
export const renameCameraRef = renameOnBoard('camera');
export const removeCameraRef = removeFromBoard('camera');

/**
 * A storyboard frame ticked as filmed on the shoot day ({ shot: true | false }) — that frame alone, in one step, so two people ticking
 * at once never undo each other.
 */
export const markFrameShot = asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) bad(res, 'That shoot was not found.', 404);
  const shot = req.body?.shot === true;
  if (typeof req.body?.shot !== 'boolean') bad(res, 'Say whether the frame was shot (shot: true or false).');
  const r = await MarketingShoot.updateOne(
    { _id: req.params.id, 'storyboard.key': String(req.params.key) },
    { $set: { 'storyboard.$.shotAt': shot ? new Date() : null, 'storyboard.$.shotByName': shot ? (req.user?.name ?? '') : '' } },
  );
  if (!r.matchedCount) bad(res, (await MarketingShoot.exists({ _id: req.params.id })) ? 'That frame is no longer on the storyboard — refresh.' : 'That shoot was not found.', 404);
  const s = await MarketingShoot.findById(req.params.id).select('storyboard').lean();
  res.json({ storyboard: storyboardView(s.storyboard), shotProgress: shotProgress(s.storyboard) });
});

/** One checklist line ticked or unticked ({ text, done }) — that line alone, in one step (a tick never undoes another person's). */
export const tickChecklist = asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) bad(res, 'That shoot was not found.', 404);
  const text = String(req.body?.text ?? '').trim();
  if (!text || typeof req.body?.done !== 'boolean') bad(res, 'Say which line (text) and whether it is done.');
  const done = req.body.done;
  const r = await MarketingShoot.updateOne(
    { _id: req.params.id, 'logistics.checklist.text': text },
    { $set: { 'logistics.checklist.$.done': done, 'logistics.checklist.$.byName': done ? (req.user?.name ?? '') : '', 'logistics.checklist.$.at': done ? new Date() : null } },
  );
  if (!r.matchedCount) bad(res, (await MarketingShoot.exists({ _id: req.params.id })) ? 'That line is no longer on the checklist — refresh.' : 'That shoot was not found.', 404);
  const s = await MarketingShoot.findById(req.params.id).select('logistics').lean();
  res.json({ logistics: logisticsView(s.logistics) });
});

// ── PDFs on the moodboard and the storyboard ──────────────────────────────────

/** A PDF uploaded to the moodboard or the storyboard (multipart: file, part = moodboard | storyboard, label). */
export const uploadShootDocument = asyncHandler(async (req, res) => {
  const shoot = await shootOr404(res, req.params.id);
  const part = String(req.body?.part ?? '');
  if (!DOC_PARTS.includes(part)) bad(res, 'Say where the PDF goes: the moodboard, the storyboard or the camera movement plan.');
  if ((shoot.documents ?? []).filter((d) => d.part === part).length >= MAX_DOCS_PER_PART) bad(res, `The ${DOC_PART_NAMES[part]} holds up to ${MAX_DOCS_PER_PART} PDFs — remove one first.`);
  const v = checkPdf({ buffer: req.file?.buffer, name: req.file?.originalname });
  if (!v.ok) bad(res, v.message, v.status);
  let kept;
  try {
    kept = await putPdf(req.file.buffer, v.name);
  } catch (e) {
    console.error('Shoot PDF upload failed:', e?.message ?? e);
    bad(res, 'The PDF could not be stored just now. Try again in a minute.', 502);
  }
  const doc = { key: makeDocKey(), part, name: v.name, label: String(req.body?.label ?? '').trim().slice(0, 120), fileUrl: kept.url, fileId: kept.id, sizeBytes: req.file.buffer.length, pages: v.pages, addedByName: req.user?.name ?? '', addedAt: new Date() };
  // added in one step — two uploads at once both stay
  await MarketingShoot.updateOne({ _id: shoot._id }, { $push: { documents: doc } });
  const after = await MarketingShoot.findById(shoot._id).select('documents').lean();
  res.status(201).json({ documents: documentsView(after.documents), added: documentsView([doc])[0] });
});

const docOr404 = async (res, id, key) => {
  if (!mongoose.isValidObjectId(id)) bad(res, 'That shoot was not found.', 404);
  const s = await MarketingShoot.findOne({ _id: id }).select('documents').lean();
  if (!s) bad(res, 'That shoot was not found.', 404);
  const doc = (s.documents ?? []).find((d) => d.key === String(key));
  if (!doc) bad(res, 'That PDF is no longer on the shoot.', 404);
  return doc;
};

/** The PDF itself, to read in the app (inline) or save (?download=1). */
export const getShootDocument = asyncHandler(async (req, res) => {
  const doc = await docOr404(res, req.params.id, req.params.key);
  let bytes;
  try {
    bytes = await getPdf(doc.fileUrl, doc.fileId);
  } catch (e) {
    console.error('Shoot PDF fetch failed:', e?.message ?? e);
    bad(res, 'The PDF could not be fetched just now. Try again in a minute.', 502);
  }
  const name = (utf8Name(doc.name) || 'document.pdf').replace(/[^\w .()-]+/g, '_');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `${String(req.query.download ?? '') === '1' ? 'attachment' : 'inline'}; filename="${name}"`);
  res.setHeader('Content-Length', bytes.length);
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.send(bytes);
});

/** A PDF's label ({ label }). */
export const renameShootDocument = asyncHandler(async (req, res) => {
  await docOr404(res, req.params.id, req.params.key);
  await MarketingShoot.updateOne({ _id: req.params.id, 'documents.key': String(req.params.key) }, { $set: { 'documents.$.label': String(req.body?.label ?? '').trim().slice(0, 120) } });
  const after = await MarketingShoot.findById(req.params.id).select('documents').lean();
  res.json({ documents: documentsView(after.documents) });
});

/** A PDF off the shoot (and out of storage). */
export const removeShootDocument = asyncHandler(async (req, res) => {
  const doc = await docOr404(res, req.params.id, req.params.key);
  await MarketingShoot.updateOne({ _id: req.params.id }, { $pull: { documents: { key: doc.key } } });
  await removePdf(doc.fileId);
  const after = await MarketingShoot.findById(req.params.id).select('documents').lean();
  res.json({ documents: documentsView(after.documents) });
});

/** Crew & Logistics: call time, map link, checklist (ticks), notes — only what is sent changes. */
export const saveLogistics = asyncHandler(async (req, res) => {
  const shoot = await shootOr404(res, req.params.id);
  const v = cleanLogistics(req.body ?? {}, shoot.logistics?.toObject ? shoot.logistics.toObject() : shoot.logistics ?? {}, { byName: req.user?.name ?? '' });
  if (!v.ok) bad(res, v.message);
  shoot.logistics = v.value;
  await shoot.save();
  res.json({ logistics: logisticsView(shoot.logistics) });
});

export const deleteShoot = asyncHandler(async (req, res) => {
  if (!canManageCreative(req.user)) bad(res, 'Only a Marketing Manager or the Creative Director can delete a shoot.', 403);
  if (!mongoose.isValidObjectId(req.params.id)) bad(res, 'That shoot was not found.', 404);
  const shoot = await MarketingShoot.findById(req.params.id);
  if (!shoot) bad(res, 'That shoot was not found.', 404);
  const [assets, logs] = await Promise.all([MarketingAsset.countDocuments({ shootId: shoot._id }), MarketingActivity.countDocuments({ shootId: shoot._id })]);
  if (assets || logs) bad(res, `This shoot has ${assets ? `${assets} asset${assets === 1 ? '' : 's'}` : ''}${assets && logs ? ' and ' : ''}${logs ? `${logs} logged ${logs === 1 ? 'entry' : 'entries'}` : ''}. Cancel it instead, so the record stays.`, 409);
  await shoot.deleteOne();
  res.json({ message: 'Shoot deleted' });
});

/** What the shoot form needs: the team (with roles) to pick a crew from, and the categories, pillars and types used so far. */
export const getSetup = asyncHandler(async (_req, res) => {
  const month = toDateStr().slice(0, 7);
  const members = await MarketingTeamMember.find({ isActive: true }).sort({ sortOrder: 1, name: 1 }).select('name').lean();
  const roles = await MarketingMemberRole.find({ memberId: { $in: members.map((m) => m._id) }, fromMonth: { $lte: month } }).sort({ fromMonth: -1 }).populate('roleId').lean();
  const role = new Map();
  for (const r of roles) if (!role.has(idOf(r.memberId))) role.set(idOf(r.memberId), r.roleId?.name ?? '');
  const [categories, pillars, types, artists] = await Promise.all([MarketingShoot.distinct('category'), MarketingShoot.distinct('pillar'), MarketingShoot.distinct('shootType'), makeupArtists()]);
  res.json({
    members: members.map((m) => ({ id: idOf(m), name: m.name, role: role.get(idOf(m)) ?? '' })),
    // the makeup artists on the staff list, for a shoot's crew (their bookings and leave show in Crew & Resource Availability)
    artists: artists.map((a) => ({ id: idOf(a), name: a.name, role: a.artistRole === 'assistant' ? 'Makeup Assistant' : 'Makeup Artist' })),
    categories: categories.filter(Boolean).sort(),
    pillars: pillars.filter(Boolean).sort(),
    shootTypes: [...new Set(['Full Shoot', 'Quick', 'Standard', ...types.filter(Boolean)])],
  });
});

// ── Production Calendar ───────────────────────────────────────────────────────

/**
 * The makeup artists and assistants on the staff list (Employees): active, the company's own (not outside associates), and not
 * Marketing staff. Sorted by name.
 */
const makeupArtists = async (excludeEmployeeIds = []) =>
  Employee.find({ status: 'active', artistRole: { $in: ['artist', 'assistant'] }, isAssociate: { $ne: true }, department: { $not: /marketing/i }, category: { $ne: 'marketing' }, ...(excludeEmployeeIds.length ? { _id: { $nin: excludeEmployeeIds } } : {}) })
    .select('name artistRole')
    .sort({ name: 1 })
    .limit(500)
    .lean();

/**
 * Everyone Crew & Resource Availability counts for [day]: the Marketing team (with their role) and the makeup artists — each with
 * whether they are on approved full-day leave, marked Absent in attendance, and (artists) assigned to a client booking that day.
 */
const membersForDay = async (day) => {
  const month = day.slice(0, 7);
  const members = await MarketingTeamMember.find({ isActive: true }).select('name userId activeFrom activeTo').lean();
  const live = members.filter((m) => (!m.activeFrom || T.istDay(m.activeFrom) <= day) && (!m.activeTo || T.istDay(m.activeTo) >= day));
  const roles = await MarketingMemberRole.find({ memberId: { $in: live.map((m) => m._id) }, fromMonth: { $lte: month } }).sort({ fromMonth: -1 }).populate('roleId').lean();
  const role = new Map();
  for (const r of roles) if (!role.has(idOf(r.memberId))) role.set(idOf(r.memberId), r.roleId?.name ?? '');
  const users = await User.find({ _id: { $in: live.map((m) => m.userId).filter(Boolean) } }).select('employeeId').lean();
  const empOf = new Map(users.filter((u) => u.employeeId).map((u) => [idOf(u), idOf(u.employeeId)]));
  const memberEmps = [...empOf.values()];
  const artists = await makeupArtists(memberEmps);
  const artistIds = artists.map((a) => a._id);
  const IST = 5.5 * 3600 * 1000;
  const start = new Date(Date.parse(`${day}T00:00:00Z`) - IST);
  const end = new Date(start.getTime() + 86400000);
  const emps = [...memberEmps, ...artistIds.map(idOf)];
  const [leaves, absences, bookings] = await Promise.all([
    emps.length ? LeaveRequest.find({ employeeId: { $in: emps }, status: 'approved', fromDate: { $lt: end }, toDate: { $gte: start }, halfDay: { $in: ['none', null] } }).select('employeeId').lean() : [],
    emps.length ? Attendance.find({ employeeId: { $in: emps }, date: { $gte: start, $lt: end }, status: 'Absent' }).select('employeeId').lean() : [],
    artistIds.length
      ? Booking.find({
          $and: [
            { $or: [{ 'assignedStaff.employeeId': { $in: artistIds } }, { 'bookingItems.assignedStaff.employeeId': { $in: artistIds } }] },
            { $or: [{ selectedDates: day }, { 'bookingItems.selectedDates': day }, { serviceStart: { $gte: start, $lt: end } }] },
          ],
        }).select('status selectedDates bookingDate serviceStart assignedStaff bookingItems.selectedDates bookingItems.assignedStaff').lean()
      : [],
  ]);
  const away = new Set(leaves.map((l) => idOf(l.employeeId)));
  const absent = new Set(absences.map((a) => idOf(a.employeeId)));
  const onWork = P.artistsOnWorkDay(bookings, day);
  return [
    ...live.map((m) => {
      const emp = empOf.get(idOf(m.userId)) ?? null;
      return { id: idOf(m), employeeId: emp, role: role.get(idOf(m)) ?? '', onLeave: !!emp && away.has(emp), absent: !!emp && absent.has(emp) };
    }),
    ...artists.map((a) => ({ id: idOf(a), employeeId: idOf(a), role: a.artistRole === 'assistant' ? 'Makeup Assistant' : 'Makeup Artist', onLeave: away.has(idOf(a)), absent: absent.has(idOf(a)), onWork: onWork.has(idOf(a)) })),
  ];
};

export const getCalendar = asyncHandler(async (req, res) => {
  const range = readRange(req, res);
  const day = req.query.day && isDay(req.query.day) ? req.query.day : range.today >= range.from && range.today <= range.to ? range.today : range.from;
  const week = weekOf(range.today);
  // the month on screen, this week, and the day picked — which may be outside both (its crew availability needs its shoots)
  const lo = [range.from, week.from, day].reduce((a, b) => (b < a ? b : a));
  const hi = [range.to, week.to, day].reduce((a, b) => (b > a ? b : a));
  const shoots = await MarketingShoot.find({ shootDate: { $gte: lo, $lte: hi } }).lean();
  const inRange = P.shootsInRange(shoots, range).sort((a, b) => (a.shootDate < b.shootDate ? -1 : 1));
  const upcomingAll = await MarketingShoot.find({ shootDate: { $gt: range.today }, status: { $nin: ['cancelled', 'completed'] }, ...(range.brand === 'all' ? {} : { brand: range.brand }) }).sort({ shootDate: 1 }).limit(5).lean();
  const todays = shoots.filter((s) => s.shootDate === range.today && s.status !== 'cancelled' && (range.brand === 'all' || s.brand === range.brand));
  const dayShoots = shoots.filter((s) => s.shootDate === day && s.status !== 'cancelled');
  const byShoot = await loadAssetsFor([...inRange, ...todays, ...upcomingAll]);
  const pick = (s) => summary(s, byShoot.get(idOf(s)) ?? []);
  res.json({
    from: range.from,
    to: range.to,
    brand: range.brand,
    day,
    counts: P.shootCounts(shoots, range, { today: range.today, weekFrom: week.from, weekTo: week.to }),
    items: inRange.map(pick),
    today: todays.map((s) => ({ ...pick(s), milestones: P.MILESTONES.map((m) => ({ key: m.key, label: m.label, doneAt: (s.milestones ?? []).find((x) => x.key === m.key)?.doneAt ?? null })) })),
    upcoming: upcomingAll.map(pick),
    load: P.productionLoad(shoots, range),
    availability: P.crewAvailability({ members: await membersForDay(day), shootsOnDay: dayShoots }),
  });
});

// ── Shoot Reports ─────────────────────────────────────────────────────────────

export const getReports = asyncHandler(async (req, res) => {
  const range = readRange(req, res);
  const prev = T.previousRange(range);
  const lookback = T.addDays(range.to, -190);
  const earliest = prev.from < lookback ? prev.from : lookback;
  const shoots = await MarketingShoot.find({ shootDate: { $gte: earliest, $lte: range.to } }).lean();
  const byShoot = await loadAssetsFor(shoots);
  const list = P.shootsInRange(shoots, range).sort((a, b) => (a.shootDate < b.shootDate ? 1 : -1));
  const filter = req.query.filter ?? 'all';
  const shown = list.filter((s) => filter === 'all' || (filter === 'completed' && s.status === 'completed') || (filter === 'in_production' && ['in_production', 'post_production', 'pre_production'].includes(s.status)) || (filter === 'delayed' && P.isDelayed(s, range.today)));
  const text = String(req.query.q ?? '').trim().toLowerCase();
  const searched = text ? shown.filter((s) => `${s.title} ${s.category ?? ''} ${s.pillar ?? ''}`.toLowerCase().includes(text)) : shown;
  // ?all=1 (the Export button): every row that matches, not one page
  const all = ['1', 'true'].includes(String(req.query.all ?? ''));
  const limit = all ? Math.max(searched.length, 1) : Math.min(Math.max(parseInt(req.query.limit, 10) || 8, 1), 50);
  const page = all ? 1 : Math.max(parseInt(req.query.page, 10) || 1, 1);
  res.json({
    from: range.from,
    to: range.to,
    brand: range.brand,
    kpis: P.reportKpis(shoots, byShoot, range),
    monthly: P.monthlyReport(shoots, byShoot, range.to, 5, range.brand),
    distribution: P.outputDistribution(shoots, byShoot, range),
    filters: { all: list.length, completed: list.filter((s) => s.status === 'completed').length, in_production: list.filter((s) => ['in_production', 'post_production', 'pre_production'].includes(s.status)).length, delayed: list.filter((s) => P.isDelayed(s, range.today)).length },
    total: searched.length,
    page,
    pageSize: limit,
    rows: searched.slice((page - 1) * limit, page * limit).map((s) => summary(s, byShoot.get(idOf(s)) ?? [])),
  });
});

// ── Links: bookings and shoots to pick from, and a booking's content ──────────

/** The works (CRM bookings) a shoot can be linked to: those matching the search, or with an event within 30 days of ?around=. */
export const getBookingOptions = asyncHandler(async (req, res) => {
  const text = String(req.query.q ?? '').trim();
  const around = isDay(req.query.around) ? req.query.around : toDateStr();
  let q;
  if (text) {
    const rx = new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    q = { $or: [{ bookingNumber: rx }, { customerName: rx }, { service: rx }] };
  } else {
    const a = T.addDays(around, -30);
    const z = T.addDays(around, 30);
    const IST = 5.5 * 3600 * 1000;
    q = { $or: [{ selectedDates: { $gte: a, $lte: z } }, { serviceStart: { $gte: new Date(Date.parse(`${a}T00:00:00Z`) - IST), $lt: new Date(Date.parse(`${T.addDays(z, 1)}T00:00:00Z`) - IST) } }] };
  }
  const rows = await Booking.find(q).select(BOOKING_FIELDS).sort({ serviceStart: -1 }).limit(60).lean();
  res.json({ items: rows.filter((b) => !DEAD_BOOKING.has(String(b.status ?? '').toLowerCase())).slice(0, 30).map(bookingBrief) });
});

/** The shoots a post or an asset can be attached to: not cancelled, newest first, matching the search. */
export const getShootOptions = asyncHandler(async (req, res) => {
  const text = String(req.query.q ?? '').trim();
  const q = { status: { $ne: 'cancelled' } };
  if (text) q.title = new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  const rows = await MarketingShoot.find(q).select('title brand category shootDate status').sort({ shootDate: -1 }).limit(40).lean();
  res.json({ items: rows.map((s) => ({ id: idOf(s), title: s.title, brand: s.brand ?? 'main', category: s.category ?? '', shootDate: s.shootDate, status: s.status })) });
});

/**
 * A booking's content (the booking screen's Content card — the document's "the content checklist per work feeds Shoots and Posting"):
 * the shoots linked to the work, each with its planned outputs against what was delivered (assets and posts) and posted.
 */
export const getBookingContent = asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) bad(res, 'That booking was not found.', 404);
  const booking = await Booking.findById(req.params.id).select(BOOKING_FIELDS).lean();
  if (!booking) bad(res, 'That booking was not found.', 404);
  const shoots = await MarketingShoot.find({ bookingId: booking._id }).sort({ shootDate: 1 }).lean();
  const ids = shoots.map((x) => x._id);
  const [assets, posts] = ids.length ? await Promise.all([MarketingAsset.find({ shootId: { $in: ids } }).select(ASSET_FIELDS).lean(), ContentItem.find({ shootId: { $in: ids } }).select(POST_FIELDS).sort({ scheduledDate: 1 }).lean()]) : [[], []];
  const of = (list, sid) => list.filter((x) => idOf(x.shootId) === idOf(sid));
  res.json({
    booking: bookingBrief(booking),
    shoots: shoots.map((x) => {
      const a = of(assets, x._id);
      const p = of(posts, x._id);
      return { ...summary(x, P.mergeOutputs(a, p)), checklist: P.contentChecklist(x, a, p), posts: p.map(postBrief) };
    }),
  });
});

export { syncShootFromLogs };
