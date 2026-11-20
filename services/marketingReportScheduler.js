import MarketingReportSchedule from '../models/MarketingReportSchedule.js';
import MarketingSavedReport from '../models/MarketingSavedReport.js';
import { notify, NOTIFICATION_TYPES } from '../utils/notify.js';
import { DEFAULT_SCHEDULES, dueRun } from '../utils/marketingReportSchedule.js';
import { managerUserIds } from './marketingEodReminders.js';

// SCHEDULED MARKETING REPORTS, run in the server (there is no cron in this system — the same in-process interval as the EOD reminders).
// Every minute: each switched-on schedule that is due saves a report for the period that has just ended and tells the marketing
// managers it is ready, with a link that opens it. Off with MARKETING_REPORT_SCHEDULER=off.

const LINK = { team: '/marketing/team?tab=reports', campaigns: '/marketing/campaigns?tab=reports', leads: '/marketing/leads-report?tab=reports' };

/// The schedules, made from the spec's defaults the first time (a schedule a manager changed is never reset).
export const ensureSchedules = async () => {
  for (const d of DEFAULT_SCHEDULES) {
    await MarketingReportSchedule.updateOne({ key: d.key }, { $setOnInsert: d }, { upsert: true });
  }
  return MarketingReportSchedule.find({}).sort({ module: 1, key: 1 }).lean();
};

/// Who hears that a report is ready: the marketing managers — the same people the missed-EOD summary goes to.
export const marketingManagerIds = () => managerUserIds();

/**
 * Runs every schedule due at [now]. Each is claimed atomically for its period first (lastPeriodKey), so it runs once even with two
 * servers. → [{ key, period, reportId }]
 */
export const runDueReports = async (now = new Date()) => {
  const done = [];
  for (const s of await ensureSchedules()) {
    const period = dueRun(s, now);
    if (!period) continue;
    const claim = await MarketingReportSchedule.updateOne(
      { _id: s._id, lastPeriodKey: { $ne: period.key } },
      { $set: { lastPeriodKey: period.key, lastRunAt: now } }
    );
    if (claim.modifiedCount !== 1) continue;
    let report;
    try {
      report = await MarketingSavedReport.create({
        module: s.module,
        kind: s.kind,
        name: `${s.label} · ${period.label}`,
        from: period.from,
        to: period.to,
        brand: 'all',
        scheduleKey: s.key,
        createdByName: 'Scheduled',
      });
    } catch (e) {
      if (e?.code !== 11000) throw e; // already saved for this period
      continue;
    }
    try {
      await notify({
        recipients: await marketingManagerIds(),
        type: NOTIFICATION_TYPES.MARKETING_REPORT_READY,
        title: `${s.label} is ready`,
        body: period.label,
        link: `${LINK[s.module]}&report=${report._id}`,
      });
    } catch (e) {
      console.error('marketing report notify failed:', e.message);
    }
    done.push({ key: s.key, period, reportId: String(report._id) });
  }
  return done;
};

/// Starts the minute-by-minute check. Returns the interval handle (tests stop it).
export const startMarketingReportScheduler = () => {
  if (String(process.env.MARKETING_REPORT_SCHEDULER || '').toLowerCase() === 'off') return null;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runDueReports();
    } catch (e) {
      console.error('marketing report scheduler:', e.message);
    } finally {
      running = false;
    }
  };
  const handle = setInterval(tick, 60 * 1000);
  handle.unref?.();
  return handle;
};
