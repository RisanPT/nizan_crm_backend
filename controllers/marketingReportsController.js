import mongoose from 'mongoose';
import MarketingReportSchedule from '../models/MarketingReportSchedule.js';
import MarketingSavedReport from '../models/MarketingSavedReport.js';
import { isManagerOrAdmin } from './marketingEodController.js';
import { cleanSavedReport, cleanScheduleUpdate, describeSchedule, nextRun, REPORT_MODULES } from '../utils/marketingReportSchedule.js';
import { ensureSchedules } from '../services/marketingReportScheduler.js';

// /api/marketing/reports — the Saved reports and Scheduled reports of the Team Dashboard, Campaigns and Lead Report screens.
// Everyone in Marketing sees the schedules and the scheduled reports; a member sees the reports they saved, a manager everyone's.
// Only a marketing manager (or admin) switches a schedule or changes its time; anyone deletes their own saved report, a manager any.

const idOf = (v) => (v == null ? '' : String(v._id ?? v));

const scheduleView = (s, now = new Date()) => ({
  key: s.key,
  module: s.module,
  kind: s.kind,
  label: s.label,
  cadence: s.cadence,
  weekday: s.weekday,
  dayOfMonth: s.dayOfMonth,
  time: s.time,
  enabled: s.enabled === true,
  when: describeSchedule(s),
  nextRunAt: nextRun(s, now),
  lastRunAt: s.lastRunAt ?? null,
  updatedByName: s.updatedByName || '',
});

const savedView = (r, userId) => ({
  id: idOf(r),
  module: r.module,
  kind: r.kind,
  name: r.name,
  from: r.from,
  to: r.to,
  brand: r.brand,
  scheduled: Boolean(r.scheduleKey),
  createdByName: r.createdByName || '',
  createdAt: r.updatedAt ?? r.createdAt, // when it was last generated (making the same report again moves it to the top)
  mine: idOf(r.createdBy) === String(userId),
});

const moduleOf = (req) => {
  const m = String(req.query.module ?? '').trim();
  if (m && !REPORT_MODULES.includes(m)) return { error: `module must be one of ${REPORT_MODULES.join(', ')}.` };
  return { module: m };
};

// @route GET /api/marketing/reports/schedules?module=team|campaigns|leads
export const listSchedules = async (req, res) => {
  const m = moduleOf(req);
  if (m.error) return res.status(400).json({ message: m.error });
  const all = await ensureSchedules();
  res.json({ canManage: isManagerOrAdmin(req.user), schedules: all.filter((s) => !m.module || s.module === m.module).map((s) => scheduleView(s)) });
};

// @route PUT /api/marketing/reports/schedules/:key { enabled, time, weekday, dayOfMonth }
export const updateSchedule = async (req, res) => {
  if (!isManagerOrAdmin(req.user)) return res.status(403).json({ message: 'Only the Marketing Manager or Admin can change a scheduled report.' });
  await ensureSchedules();
  const s = await MarketingReportSchedule.findOne({ key: String(req.params.key) }).lean();
  if (!s) return res.status(404).json({ message: 'No such scheduled report.' });
  const c = cleanScheduleUpdate(req.body ?? {}, s);
  if (c.error) return res.status(400).json({ message: c.error });
  if (!Object.keys(c.set).length) return res.status(400).json({ message: 'Nothing to change.' });
  const fresh = await MarketingReportSchedule.findOneAndUpdate(
    { _id: s._id },
    { $set: { ...c.set, updatedBy: req.user._id, updatedByName: req.user.name || '' } },
    { new: true }
  ).lean();
  res.json(scheduleView(fresh));
};

// @route GET /api/marketing/reports/saved?module=&limit=
export const listSaved = async (req, res) => {
  const m = moduleOf(req);
  if (m.error) return res.status(400).json({ message: m.error });
  const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 20));
  const filter = m.module ? { module: m.module } : {};
  // a member: what they saved, and what the schedules made; a manager: everything
  if (!isManagerOrAdmin(req.user)) filter.$or = [{ createdBy: req.user._id }, { scheduleKey: { $gt: '' } }];
  const rows = await MarketingSavedReport.find(filter).sort({ updatedAt: -1 }).limit(limit).lean();
  res.json({ reports: rows.map((r) => savedView(r, req.user._id)) });
};

// @route POST /api/marketing/reports/saved { module, kind, name, from, to, brand } — keep a report someone generated. The same report
// (same person, module, kind, period and brand) made again is the same saved report, brought back to the top — not a second one.
export const createSaved = async (req, res) => {
  const c = cleanSavedReport(req.body ?? {});
  if (c.error) return res.status(400).json({ message: c.error });
  const { name, ...same } = c.doc;
  const r = await MarketingSavedReport.findOneAndUpdate(
    { ...same, scheduleKey: '', createdBy: req.user._id },
    { $set: { name, createdByName: req.user.name || '' } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  ).lean();
  res.status(201).json(savedView(r, req.user._id));
};

// @route DELETE /api/marketing/reports/saved/:id
export const deleteSaved = async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ message: 'Report not found.' });
  const r = await MarketingSavedReport.findById(req.params.id).lean();
  if (!r) return res.status(404).json({ message: 'Report not found.' });
  if (!isManagerOrAdmin(req.user) && idOf(r.createdBy) !== String(req.user._id)) {
    return res.status(403).json({ message: 'Only the person who saved it, or a manager, can remove it.' });
  }
  await MarketingSavedReport.deleteOne({ _id: r._id });
  res.json({ ok: true });
};
