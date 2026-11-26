// /api/work-footage — footage from works (rules: utils/workFootage.js; Dropbox: services/dropbox.js; record: models/WorkFootage.js).
//
// The ARTISTS who worked a booking (booking-level or package-level assignment) put the day's videos in Dropbox, in the folder named after
// the work, and hand the link in from their work card — or, with Dropbox connected on the server, upload through the work's own upload
// page and let the CRM find the files. Each link becomes a RAW asset in Marketing's library (attached to the shoot that covers the
// booking, when one does), and Marketing is told. Marketing sees every work's footage (and the works still owing it) in Creative
// Portfolio → Footage, and hands it to an editor (a task on the Team Dashboard).
import asyncHandler from 'express-async-handler';
import mongoose from 'mongoose';
import Booking from '../models/Booking.js';
import ContentItem from '../models/ContentItem.js';
import MarketingAsset from '../models/MarketingAsset.js';
import MarketingShoot from '../models/MarketingShoot.js';
import MarketingTask from '../models/MarketingTask.js';
import { MarketingTeamMember } from '../models/MarketingEod.js';
import WorkFootage from '../models/WorkFootage.js';
import { canEnterCreative } from './contentController.js';
import { canManageCreative } from './marketingEodController.js';
import { eventDaysOf, isOnBookingTeam, isWork, worksBetween } from '../utils/crmCare.js';
import { addDays, istEnd, istStart, todayIst } from '../utils/istDate.js';
import { assetFromShoot, portfolioOfBrand } from '../utils/marketingSocialsInput.js';
import { footageDue, footageFiles, footageFolderName, footageFolderPath, footageLinkInfo, footageState, sameFootageLink, sizeLabel } from '../utils/workFootage.js';
import { createFileRequest, dropboxEnabled, dropboxRoot, DropboxProblem, ensureFolder, listFolder, sharedLinkFor } from '../services/dropbox.js';
import { readSharedFolder } from '../services/sharedFolder.js';
import { dropboxFolderLink } from '../utils/dropboxFolder.js';
import { getUserIdsByRoles, notify, NOTIFICATION_TYPES } from '../utils/notify.js';

const idOf = (v) => (v == null ? '' : String(v._id ?? v));
const bad = (res, message, status = 400) => {
  res.status(status);
  throw new Error(message);
};
const BOOKING_FIELDS = 'bookingNumber customerName service status selectedDates bookingDate serviceStart bookingItems.selectedDates assignedStaff.employeeId assignedStaff.artistName bookingItems.assignedStaff.employeeId bookingItems.assignedStaff.artistName contentCreationRequired';
const MB = 1024 * 1024;

const dropboxFailure = (res, e) => {
  if (e instanceof DropboxProblem) bad(res, e.message, e.status === 429 ? 429 : 502);
  throw e;
};

/** The booking, and what this person may do with its footage. */
const access = async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.bookingId)) bad(res, 'That work was not found.', 404);
  const booking = await Booking.findById(req.params.bookingId).select(BOOKING_FIELDS).lean();
  if (!booking) bad(res, 'That work was not found.', 404);
  const marketing = await canEnterCreative(req.user); // Marketing, or the Creative Director
  const onTeam = isOnBookingTeam(booking, req.user?.employeeId);
  if (!marketing && !onTeam) bad(res, 'Only the artists who worked this booking, and Marketing, can see its footage.', 403);
  return { booking, marketing, onTeam };
};

/** The day asked for (?day= / body.day) must be one of the booking's work days; none asked → the latest that has come, else the first. */
const dayOf = (req, res, booking) => {
  const days = eventDaysOf(booking);
  const asked = String(req.query.day ?? req.body?.day ?? '').trim();
  if (asked) {
    if (!days.includes(asked)) bad(res, 'That day is not one of this work\'s days.');
    return asked;
  }
  const today = todayIst();
  return [...days].reverse().find((d) => d <= today) ?? days[0] ?? today;
};

/** The shoot that covers this booking (its footage files under that shoot), if one does. */
const shootOfBooking = (booking) => MarketingShoot.findOne({ bookingId: booking._id }).sort({ shootDate: 1 }).lean();

const recordFor = async (booking, day) =>
  (await WorkFootage.findOne({ bookingId: booking._id, day })) ?? new WorkFootage({ bookingId: booking._id, day, folderName: footageFolderName(booking, day) });

const linkView = (l, me) => ({ id: idOf(l), url: l.url, label: l.label ?? '', provider: l.provider, kind: l.kind, source: l.source, addedByName: l.addedByName ?? '', addedAt: l.addedAt ?? null, summary: l.summary ?? '', mine: !!me && idOf(l.addedBy) === idOf(me) });

/**
 * A Dropbox folder link, opened through the server's Dropbox app (when it has one) as it is handed in: → { ok: true, listing } (what is in
 * it), { ok: false, message } (Dropbox will not open it for anyone — the artist fixes the sharing and adds it again), or null (no app,
 * or Dropbox could not answer — the link is taken as it is; nobody is held up by the server's own trouble).
 */
const checkFolderLink = async (url) => {
  const f = dropboxFolderLink(url);
  if (f.error || !dropboxEnabled()) return null;
  try {
    const r = await readSharedFolder(f.url, '', { fresh: true });
    return r.ok ? { ok: true, listing: r } : { ok: false, message: r.message };
  } catch {
    return null;
  }
};

const dayView = (booking, day, rec, { user, needsContent }) => ({
  day,
  folderName: rec?.folderName || footageFolderName(booking, day),
  state: footageState(rec),
  due: footageDue({ needsContent, day, today: todayIst(), rec }),
  links: (rec?.links ?? []).map((l) => linkView(l, user?._id)),
  files: (rec?.files ?? []).map((f) => ({ name: f.name, size: f.size ?? 0, modifiedAt: f.modifiedAt ?? null })),
  totalBytes: rec?.totalBytes ?? 0,
  size: sizeLabel(rec?.totalBytes),
  uploadPage: rec?.fileRequestUrl ?? '',
  syncedAt: rec?.syncedAt ?? null,
  editorName: rec?.editorName ?? '',
});

const bookingView = async (booking, req, { marketing, onTeam }) => {
  const days = eventDaysOf(booking);
  const [recs, shoot] = await Promise.all([WorkFootage.find({ bookingId: booking._id }).lean(), shootOfBooking(booking)]);
  const byDay = new Map(recs.map((r) => [r.day, r]));
  const needsContent = !!booking.contentCreationRequired || !!shoot;
  return {
    bookingId: idOf(booking),
    bookingNumber: booking.bookingNumber ?? '',
    client: booking.customerName ?? '',
    service: booking.service ?? '',
    needsContent,
    shoot: shoot ? { id: idOf(shoot), title: shoot.title } : null,
    dropbox: { enabled: dropboxEnabled(), root: dropboxRoot() },
    canAdd: onTeam || marketing,
    isMarketing: marketing,
    days: days.map((d) => dayView(booking, d, byDay.get(d), { user: req.user, needsContent })),
  };
};

/** Footage arriving where there was none (again): it starts as new — whoever edited the earlier footage is not editing this. */
const freshStart = (rec) => {
  rec.status = 'new';
  rec.editorMemberId = null;
  rec.editorName = '';
  rec.taskId = null;
  rec.firstAt = new Date();
};

/** The raw asset a footage link becomes in Marketing's library — under the shoot that covers the work, when there is one. */
const assetFor = async (rec, link, booking, user, { sizeMb = 0 } = {}) => {
  const shoot = await shootOfBooking(booking);
  let fields = {
    title: `${rec.folderName}${link.label ? ` — ${link.label}` : ''}`.slice(0, 200),
    url: link.url,
    kind: 'film',
    media: 'video',
    stage: 'raw',
    brand: 'main',
    portfolio: portfolioOfBrand('main'),
    page: String(booking.service ?? '').slice(0, 80),
    tags: ['raw footage', 'work'],
    ownerName: link.addedByName ?? '',
    bookingId: booking._id,
    workDay: rec.day,
    footageId: rec._id,
    sizeMb: Math.round((sizeMb || 0) * 10) / 10,
    createdBy: user?._id ?? null,
  };
  if (shoot) fields = { ...fields, ...assetFromShoot(shoot, fields), shootId: shoot._id };
  const asset = await MarketingAsset.create(fields);
  return asset._id;
};

const tellMarketing = async (rec, booking, by) => {
  const ids = await getUserIdsByRoles(['marketing_admin', 'marketing_manager']);
  await notify({
    recipients: ids,
    type: NOTIFICATION_TYPES.FOOTAGE_UPLOADED,
    title: 'Footage from a work is in',
    body: `${by || 'An artist'} added the footage of ${rec.folderName}. It is in Creative Portfolio → Footage, ready to edit.`,
    bookingId: booking._id,
    link: '/marketing/portfolio?tab=footage',
    excludeUserId: null,
  });
};

// @route GET /api/work-footage/booking/:bookingId — the booking's work days and their footage (the artist's work card; Marketing)
export const getBookingFootage = asyncHandler(async (req, res) => {
  const a = await access(req, res);
  res.json(await bookingView(a.booking, req, a));
});

// @route POST /api/work-footage/booking/:bookingId/links { day, url, label } — a Dropbox link to the uploaded videos (or their folder)
export const addFootageLink = asyncHandler(async (req, res) => {
  const a = await access(req, res);
  const day = dayOf(req, res, a.booking);
  if (day > todayIst()) bad(res, 'Footage is added once the work is done — this day has not come yet.');
  const info = footageLinkInfo(req.body?.url);
  if (!info.ok) bad(res, info.message);
  const rec = await recordFor(a.booking, day);
  if (rec.links.some((l) => sameFootageLink(l.url, info.url))) bad(res, 'That link is already on this work.', 409);
  if (rec.links.length >= 30) bad(res, 'A work day holds up to 30 links — share the folder instead.');
  // a folder link is opened once now (Dropbox connected): one Dropbox will not show to anyone is sent back with how to share it
  const check = info.kind === 'folder' && info.provider === 'dropbox' ? await checkFolderLink(info.url) : null;
  if (check && !check.ok) bad(res, check.message);
  const l = check?.listing;
  const first = footageState(rec) === 'waiting';
  rec.links.push({
    url: info.url,
    label: String(req.body?.label ?? '').trim().slice(0, 120),
    provider: info.provider,
    kind: info.kind,
    source: 'artist',
    addedBy: req.user._id,
    addedByName: req.user.name ?? '',
    ...(l ? { summary: l.summary, videoCount: l.videoCount, pictureCount: l.pictureCount, totalBytes: l.totalBytes, listedAt: new Date() } : {}),
  });
  if (first) freshStart(rec);
  await rec.save();
  const link = rec.links[rec.links.length - 1];
  link.assetId = await assetFor(rec, link, a.booking, req.user, { sizeMb: (l?.totalBytes ?? 0) / MB });
  await rec.save();
  if (first) await tellMarketing(rec, a.booking, req.user.name);
  res.status(201).json(await bookingView(a.booking, req, a));
});

// @route DELETE /api/work-footage/booking/:bookingId/links/:linkId — a wrong link out (who added it, or a Marketing Manager); its raw
// asset goes too, unless it has moved on (edited, approved) or a post uses it
export const removeFootageLink = asyncHandler(async (req, res) => {
  const a = await access(req, res);
  const rec = await WorkFootage.findOne({ bookingId: a.booking._id, 'links._id': req.params.linkId });
  if (!rec) bad(res, 'That link is not on this work.', 404);
  const link = rec.links.id(req.params.linkId);
  if (idOf(link.addedBy) !== idOf(req.user._id) && !canManageCreative(req.user)) bad(res, 'Only the person who added the link, or a Marketing Manager, can take it off.', 403);
  if (link.assetId) {
    const asset = await MarketingAsset.findById(link.assetId).select('stage').lean();
    const used = await ContentItem.countDocuments({ assetId: link.assetId });
    if (asset && asset.stage === 'raw' && !used) await MarketingAsset.deleteOne({ _id: link.assetId });
  }
  link.deleteOne();
  await rec.save();
  res.json(await bookingView(a.booking, req, a));
});

// @route POST /api/work-footage/booking/:bookingId/upload-page { day } — Dropbox connected: the work's own upload page (a Dropbox file
// request into its folder, made once) for uploading from the phone without a Dropbox login
export const uploadPage = asyncHandler(async (req, res) => {
  const a = await access(req, res);
  if (!dropboxEnabled()) bad(res, 'Dropbox is not connected on this server yet — upload to Dropbox yourself and paste the link.', 409);
  const day = dayOf(req, res, a.booking);
  const rec = await recordFor(a.booking, day);
  try {
    if (!rec.fileRequestUrl) {
      const path = footageFolderPath(dropboxRoot(), a.booking, day);
      await ensureFolder(path);
      const fr = await createFileRequest(path, `Footage · ${rec.folderName}`);
      rec.folderPath = path;
      rec.fileRequestId = fr.id;
      rec.fileRequestUrl = fr.url;
      await rec.save();
    }
  } catch (e) {
    dropboxFailure(res, e);
  }
  res.json({ url: rec.fileRequestUrl, folderName: rec.folderName, folderPath: rec.folderPath });
});

// @route POST /api/work-footage/booking/:bookingId/check { day } — Dropbox connected: what is in the work's folder now; the first time
// there are files, the folder is shared and its link added (and Marketing told), so nobody types it
export const checkUpload = asyncHandler(async (req, res) => {
  const a = await access(req, res);
  if (!dropboxEnabled()) bad(res, 'Dropbox is not connected on this server yet — paste the link instead.', 409);
  const day = dayOf(req, res, a.booking);
  const rec = await recordFor(a.booking, day);
  const path = rec.folderPath || footageFolderPath(dropboxRoot(), a.booking, day);
  let entries;
  try {
    entries = await listFolder(path);
  } catch (e) {
    dropboxFailure(res, e);
  }
  const { files, totalBytes } = footageFiles(entries);
  // read before the new files are put on it: was nothing in?
  const wasWaiting = footageState(rec) === 'waiting';
  rec.folderPath = path;
  rec.files = files;
  rec.totalBytes = totalBytes;
  rec.syncedAt = new Date();
  const first = wasWaiting && files.length > 0;
  if (first) freshStart(rec);
  const shared = rec.links.find((l) => l.source === 'dropbox');
  if (files.length && !shared) {
    let url;
    try {
      url = await sharedLinkFor(path);
    } catch (e) {
      dropboxFailure(res, e);
    }
    rec.links.push({ url, label: 'Dropbox folder', provider: 'dropbox', kind: 'folder', source: 'dropbox', addedBy: req.user._id, addedByName: req.user.name ?? '' });
    await rec.save();
    const link = rec.links[rec.links.length - 1];
    link.assetId = await assetFor(rec, link, a.booking, req.user, { sizeMb: totalBytes / MB });
  } else if (shared?.assetId) {
    await MarketingAsset.updateOne({ _id: shared.assetId }, { $set: { sizeMb: Math.round((totalBytes / MB) * 10) / 10 } });
  }
  await rec.save();
  if (first) await tellMarketing(rec, a.booking, req.user.name);
  res.json({ ...(await bookingView(a.booking, req, a)), found: files.length });
});

// ── Marketing ──────────────────────────────────────────────────────────────────

const marketingOnly = async (req, res) => {
  if (!(await canEnterCreative(req.user))) bad(res, 'Only the Marketing team can open this.', 403);
};

// @route GET /api/work-footage/inbox?status=all|new|in_edit|edited&days=14 — every work's footage, newest first, and the works still
// owing footage (they need content — the booking asks for it or a shoot covers it — their day has come, nothing is in)
export const getInbox = asyncHandler(async (req, res) => {
  await marketingOnly(req, res);
  const status = ['new', 'in_edit', 'edited'].includes(req.query.status) ? req.query.status : 'all';
  const days = Math.min(Math.max(parseInt(req.query.days, 10) || 14, 1), 90);
  const today = todayIst();
  const from = addDays(today, -days);
  // only what holds footage now (a work whose links were all taken off is owing again, not "in")
  const holds = { $or: [{ 'links.0': { $exists: true } }, { 'files.0': { $exists: true } }] };
  const recs = await WorkFootage.find({ ...holds, ...(status === 'all' ? {} : { status }) }).sort({ firstAt: -1, updatedAt: -1 }).limit(300).lean();
  const counts = Object.fromEntries((await WorkFootage.aggregate([{ $match: holds }, { $group: { _id: '$status', n: { $sum: 1 } } }])).map((r) => [r._id, r.n]));
  // the works of the last [days] that need content and have nothing in
  const shootBookings = (await MarketingShoot.find({ bookingId: { $ne: null } }).select('bookingId').lean()).map((s) => s.bookingId);
  const recent = await Booking.find({
    $and: [
      { $or: [{ contentCreationRequired: true }, { _id: { $in: shootBookings } }] },
      { $or: [{ selectedDates: { $gte: from, $lte: today } }, { 'bookingItems.selectedDates': { $gte: from, $lte: today } }, { bookingDate: { $gte: istStart(from), $lte: istEnd(today) } }] },
    ],
  })
    .select(BOOKING_FIELDS)
    .limit(500)
    .lean();
  const recentIds = recent.map((b) => b._id);
  const all = recentIds.length ? await WorkFootage.find({ bookingId: { $in: recentIds } }).select('bookingId day links files').lean() : [];
  const have = new Map(all.map((r) => [`${idOf(r.bookingId)}|${r.day}`, r]));
  const waiting = worksBetween(recent.filter(isWork), from, today)
    .filter((w) => footageDue({ needsContent: true, day: w.day, today, rec: have.get(`${idOf(w.booking)}|${w.day}`) }))
    .reverse()
    .slice(0, 100)
    .map((w) => ({
      bookingId: idOf(w.booking),
      bookingNumber: w.booking.bookingNumber ?? '',
      client: w.booking.customerName ?? '',
      service: w.booking.service ?? '',
      day: w.day,
      folderName: footageFolderName(w.booking, w.day),
      artists: [...new Set([...(w.booking.assignedStaff ?? []), ...(w.booking.bookingItems ?? []).flatMap((i) => i.assignedStaff ?? [])].map((s) => s.artistName).filter(Boolean))],
    }));
  const bookings = await Booking.find({ _id: { $in: [...new Set(recs.map((r) => idOf(r.bookingId)))] } }).select('bookingNumber customerName service').lean();
  const bookingOf = new Map(bookings.map((b) => [idOf(b), b]));
  res.json({
    counts: { new: counts.new ?? 0, in_edit: counts.in_edit ?? 0, edited: counts.edited ?? 0, waiting: waiting.length },
    dropbox: { enabled: dropboxEnabled(), root: dropboxRoot() },
    items: recs.map((r) => {
      const b = bookingOf.get(idOf(r.bookingId)) ?? {};
      return {
        id: idOf(r),
        bookingId: idOf(r.bookingId),
        bookingNumber: b.bookingNumber ?? '',
        client: b.customerName ?? '',
        service: b.service ?? '',
        day: r.day,
        folderName: r.folderName,
        status: footageState(r),
        links: (r.links ?? []).map((l) => linkView(l, null)),
        fileCount: (r.files ?? []).length,
        size: sizeLabel(r.totalBytes),
        firstAt: r.firstAt,
        editorName: r.editorName ?? '',
        uploaders: [...new Set((r.links ?? []).map((l) => l.addedByName).filter(Boolean))],
      };
    }),
    waiting,
  });
});

// @route PATCH /api/work-footage/:id { status, editorMemberId } — hand the footage to an editor (a task on their Team Dashboard), or mark it edited
export const setFootageStatus = asyncHandler(async (req, res) => {
  await marketingOnly(req, res);
  if (!mongoose.isValidObjectId(req.params.id)) bad(res, 'That footage was not found.', 404);
  const rec = await WorkFootage.findById(req.params.id);
  if (!rec) bad(res, 'That footage was not found.', 404);
  const status = String(req.body?.status ?? '');
  if (!['new', 'in_edit', 'edited'].includes(status)) bad(res, 'Choose new, in edit or edited.');
  if (status === 'in_edit') {
    const memberId = String(req.body?.editorMemberId ?? '');
    if (!mongoose.isValidObjectId(memberId)) bad(res, 'Choose the editor.');
    const member = await MarketingTeamMember.findById(memberId).select('name').lean();
    if (!member) bad(res, 'That editor is not on the team.', 404);
    rec.editorMemberId = member._id;
    rec.editorName = member.name ?? '';
    if (!rec.taskId) {
      const task = await MarketingTask.create({
        title: `Edit the footage — ${rec.folderName}`.slice(0, 300),
        description: ['The raw footage of this work:', ...rec.links.map((l) => l.url)].join('\n').slice(0, 2000),
        assigneeId: member._id,
        dueDate: addDays(todayIst(), 3),
        priority: 'medium',
        attachments: rec.links.slice(0, 10).map((l) => ({ label: l.label || 'Footage', url: l.url })),
        createdBy: req.user._id,
      });
      rec.taskId = task._id;
    } else {
      await MarketingTask.updateOne({ _id: rec.taskId }, { $set: { assigneeId: member._id } });
    }
  }
  rec.status = status;
  rec.statusAt = new Date();
  rec.statusByName = req.user.name ?? '';
  await rec.save();
  res.json({ id: idOf(rec), status: rec.status, editorName: rec.editorName ?? '', taskId: rec.taskId ? idOf(rec.taskId) : null });
});
