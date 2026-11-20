import MarketingActivity from '../models/MarketingActivity.js';
import { MarketingEodEntry } from '../models/MarketingEod.js';

// The member's EOD day entry is the ROLL-UP of the day's logs. Every Log Activity save / edit / delete rebuilds it, so the EOD
// dashboards, targets, missed-EOD list, month close and exports — which all read the day entry — follow the logs with nothing typed twice.

const round2 = (n) => Math.round(n * 100) / 100;
const idOf = (v) => (v == null ? '' : String(v._id ?? v));

/** Sum a day's logs: hours (from minutes), the count per activity, the notes, and the day check. Pure. */
export const sumLogs = (logs = []) => {
  const totals = new Map();
  let minutes = 0;
  const lines = [];
  for (const a of logs) {
    minutes += a.timeSpentMinutes || 0;
    for (const v of a.values ?? []) {
      const key = idOf(v.metricId);
      totals.set(key, (totals.get(key) ?? 0) + (Number(v.value) || 0));
    }
    const line = [a.workedOn, a.comment].filter(Boolean).join(' — ');
    if (line) lines.push(line);
  }
  const values = [...totals.entries()].map(([metricId, value]) => ({ metricId, value }));
  const hasCount = values.some((v) => v.value > 0);
  const hours = round2(minutes / 60);
  let checkStatus = 'OK';
  let checkMessage = 'OK';
  if (hours === 0 && hasCount) {
    checkStatus = 'WARNING';
    checkMessage = 'Hours missing: counts were logged but no time was.';
  } else if (hours === 0) {
    checkStatus = 'WARNING';
    checkMessage = 'No hours or counts reported for this day.';
  } else if (hours > 24) {
    checkStatus = 'WARNING';
    checkMessage = 'More than 24 hours logged for one day.';
  }
  return { hours, minutes, values, notes: lines.join('\n'), checkStatus, checkMessage, hasCount };
};

/**
 * Turn the day's earlier whole-day EOD entry (typed on the old form) into a log the first time the day gets a log, so what was already
 * entered is kept and counted. Returns true when it did.
 */
const keepEarlierEntry = async (memberId, entryDate) => {
  const entry = await MarketingEodEntry.findOne({ memberId, entryDate });
  if (!entry || entry.source === 'logs') return false;
  const hasContent = (entry.values ?? []).some((v) => v.value > 0) || entry.hoursWorked > 0 || entry.notes;
  if (hasContent) {
    await MarketingActivity.create({
      memberId,
      entryDate,
      loggedAt: entry.submittedAt ?? new Date(),
      workedOn: 'Earlier daily entry',
      comment: entry.notes ?? '',
      timeSpentMinutes: Math.min(1440, Math.round((entry.hoursWorked || 0) * 60)),
      values: (entry.values ?? []).filter((v) => v.value > 0).map((v) => ({ metricId: v.metricId, value: v.value })),
      status: 'completed',
      legacy: true,
      createdBy: entry.lastEditedBy ?? null,
    });
  }
  return true;
};

/**
 * Rebuild the member's EOD entry for the day from its logs. Call after every log save / edit / delete. Idempotent.
 * → the entry, or null when the day has no logs (a roll-up row with nothing under it is removed).
 */
const signature = (logs) => `${logs.length}|${logs.reduce((m, l) => Math.max(m, new Date(l.updatedAt ?? l.createdAt ?? 0).getTime()), 0)}|${logs.map((l) => String(l._id)).join(',')}`;

export const rebuildDay = async (memberId, entryDate, { editedBy = null } = {}) => {
  // two logs saved at the same moment each rebuild the day: repeat until the logs stop changing under us (a few tries at most)
  let result = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const before = signature(await MarketingActivity.find({ memberId, entryDate }).select('updatedAt createdAt').lean());
    result = await rebuildOnce(memberId, entryDate, { editedBy });
    const after = signature(await MarketingActivity.find({ memberId, entryDate }).select('updatedAt createdAt').lean());
    if (before === after) break;
  }
  return result;
};

const rebuildOnce = async (memberId, entryDate, { editedBy = null } = {}) => {
  let logs = await MarketingActivity.find({ memberId, entryDate }).sort({ loggedAt: 1 }).lean();
  // first log of a day that already has an old-style entry: keep that entry as a log, then roll up
  if (logs.length && !logs.some((l) => l.legacy)) {
    if (await keepEarlierEntry(memberId, entryDate)) logs = await MarketingActivity.find({ memberId, entryDate }).sort({ loggedAt: 1 }).lean();
  }
  if (!logs.length) {
    await MarketingEodEntry.deleteOne({ memberId, entryDate, source: 'logs' });
    return null;
  }
  const sum = sumLogs(logs);
  const existing = await MarketingEodEntry.findOne({ memberId, entryDate }).select('submittedAt').lean();
  return MarketingEodEntry.findOneAndUpdate(
    { memberId, entryDate },
    {
      memberId,
      entryDate,
      hoursWorked: sum.hours,
      notes: sum.notes,
      checkStatus: sum.checkStatus,
      checkMessage: sum.checkMessage,
      values: sum.values,
      source: 'logs',
      submittedAt: existing?.submittedAt ?? logs[0].loggedAt ?? new Date(),
      lastEditedBy: editedBy,
      lastEditedAt: new Date(),
    },
    { upsert: true, new: true },
  );
};
