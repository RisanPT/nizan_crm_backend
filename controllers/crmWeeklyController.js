import CrmWeeklyReport from '../models/CrmWeeklyReport.js';
import { canAssignCrmWork, seesWholeCrmTeam } from '../utils/crmAccess.js';
import { cleanTyped, effectiveFigures, missingForSubmit, overrideProblems, resolveWeek, typedSetPaths } from '../utils/crmWeekly.js';
import { istDayKey } from '../utils/istDate.js';
import { buildWeeklyFigures, weeklyReportList, weeklyReportView } from '../services/crmWeekly.js';
import { crmWeeklyFileName, crmWeeklyXlsx, writeCrmWeeklyPdf } from '../services/crmWeeklyFiles.js';
import { newFinancePdf } from '../services/financeReportFiles.js';
import { fail, lc, requireWriter, route } from './crmHttp.js';

// The CRM WEEKLY REPORT (/api/crm/weekly): the CRM Head fills in and hands in the team's report for a week; management and leadership
// read it. The figures come from the records (services/crmWeekly.js); the Head types the starting-message counts and the manpower
// answers — and can type any figure by hand where the records missed something. A submitted report keeps the figures it was handed in
// with; the Head (or management) can reopen it.

const mayRead = (req) => {
  if (!seesWholeCrmTeam(req.crmViewer)) fail(403, 'The weekly report is the CRM Head\'s.');
};
const mayEdit = (req) => {
  requireWriter(req);
  if (!canAssignCrmWork(req.crmViewer)) fail(403, 'Only the CRM Head can fill in the weekly report.');
};
const weekOfReq = (req) => {
  const w = resolveWeek(req.query.week ?? req.body?.week, istDayKey(new Date()));
  if (w.error) fail(400, w.error);
  return w;
};

// @route GET /api/crm/weekly?week=YYYY-MM-DD (any day of the week; default: last week)
export const getWeekly = route(async (req, res) => {
  mayRead(req);
  res.json(await weeklyReportView({ week: weekOfReq(req) }));
});

// @route GET /api/crm/weekly/list — the last 12 weeks and whether each was handed in
export const listWeekly = route(async (req, res) => {
  mayRead(req);
  res.json(await weeklyReportList({ n: 12, today: istDayKey(new Date()) }));
});

/// Typed figures that do not add up with the rest (a part bigger than its whole) → 400.
const checkTyped = (figures, typed) => {
  const eff = effectiveFigures(figures, typed);
  const problems = overrideProblems(eff.figures, eff.typedKeys);
  if (problems.length) fail(400, problems.join(' '));
};

// @route PUT /api/crm/weekly { week, startingMessagesNizan, startingMessagesTeamN, startingMessagesNote, manpowerPlan, enoughWork,
//   enoughWorkNote, notes, overrides: { key: count|null }, sectionNotes: { item: text }, outsourceLines: [...] }
export const saveWeekly = route(async (req, res) => {
  mayEdit(req);
  const week = weekOfReq(req);
  const t = cleanTyped(req.body ?? {});
  if (t.error) fail(400, t.error);
  const existing = await CrmWeeklyReport.findOne({ weekStart: week.from }).select('status typed').lean();
  if (existing?.status === 'submitted') fail(409, 'This week\'s report is handed in. Reopen it to change it.');
  let fresh = null;
  if ('overrides' in t.set) {
    fresh = await buildWeeklyFigures({ week });
    const was = existing?.typed ?? {};
    checkTyped(fresh, { ...was, overrides: { ...(was.overrides ?? {}), ...t.set.overrides } });
  }
  await CrmWeeklyReport.findOneAndUpdate(
    { weekStart: week.from },
    { $set: { ...typedSetPaths(t.set), updatedBy: req.user._id, updatedByName: req.user.name || '' }, $setOnInsert: { weekStart: week.from, status: 'draft' } },
    { upsert: true, new: true, runValidators: true }
  );
  res.json(await weeklyReportView({ week, fresh }));
});

// @route POST /api/crm/weekly/submit { week } — hand the report in: the figures are kept as they are now
export const submitWeekly = route(async (req, res) => {
  mayEdit(req);
  const week = weekOfReq(req);
  if (week.to >= istDayKey(new Date())) fail(400, 'The week is not over yet — hand its report in from Monday.');
  const doc = await CrmWeeklyReport.findOne({ weekStart: week.from });
  if (doc?.status === 'submitted') fail(409, 'This week\'s report is already handed in.');
  const missing = missingForSubmit(doc?.typed ?? {});
  if (missing.length) fail(400, `Fill in ${missing.join(', ')} first.`);
  const snapshot = JSON.parse(JSON.stringify(await buildWeeklyFigures({ week })));
  checkTyped(snapshot, doc.typed?.toObject?.() ?? doc.typed);
  // only a draft becomes submitted (two clicks at once hand it in once)
  const r = await CrmWeeklyReport.updateOne(
    { _id: doc._id, status: 'draft' },
    { $set: { status: 'submitted', snapshot, submittedAt: new Date(), submittedBy: req.user._id, submittedByName: req.user.name || '' } }
  );
  if (r.modifiedCount !== 1) fail(409, 'This week\'s report is already handed in.');
  res.json(await weeklyReportView({ week }));
});

// @route POST /api/crm/weekly/reopen { week } — back to a draft (the figures are worked out fresh again)
export const reopenWeekly = route(async (req, res) => {
  mayEdit(req);
  const week = weekOfReq(req);
  const r = await CrmWeeklyReport.updateOne(
    { weekStart: week.from, status: 'submitted' },
    { $set: { status: 'draft', snapshot: null, reopenedAt: new Date(), reopenedByName: req.user.name || '' } }
  );
  if (r.modifiedCount !== 1) fail(409, 'That report is not handed in.');
  res.json(await weeklyReportView({ week }));
});

// @route GET /api/crm/weekly/file?week&format=xlsx|pdf
export const weeklyFile = route(async (req, res) => {
  mayRead(req);
  const format = lc(req.query.format) || 'pdf';
  if (!['xlsx', 'pdf'].includes(format)) fail(400, 'format must be xlsx or pdf.');
  const view = await weeklyReportView({ week: weekOfReq(req) });
  res.attachment(crmWeeklyFileName(view, format));
  if (format === 'xlsx') return res.send(await crmWeeklyXlsx(view));
  const doc = newFinancePdf();
  res.header('Content-Type', 'application/pdf');
  doc.pipe(res);
  writeCrmWeeklyPdf(doc, view);
  doc.end();
});
