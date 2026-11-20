import MarketingShoot, { SHOOT_STATUSES } from '../models/MarketingShoot.js';
import MarketingActivity from '../models/MarketingActivity.js';

// Keeps a shoot's progress in step with the work members LOG against it (Log Activity → Shoot + stage): the document's "milestone
// progress moves when members log pre-production, production and post-production work". Rebuilt from the shoot's logs every time, so a
// log that is edited or deleted moves it back — nothing is typed twice and nothing can drift.
//
//  • a log of a stage that is Completed marks that stage's milestone done (the day of the latest such log);
//  • any log of a stage moves the shoot INTO that phase (never backwards on its own — a manager can set the status by hand);
//  • "brief" is done once the shoot exists; "distribution" is done when the shoot is Completed (status is set by hand or by the
//    controller when it is marked complete).

const STAGE_TO_MILESTONE = { pre_production: 'pre_production', production: 'production', post_production: 'post_production' };
const STAGE_TO_STATUS = { pre_production: 'pre_production', production: 'in_production', post_production: 'post_production' };
const rank = (status) => SHOOT_STATUSES.indexOf(status);

/** Pure: from a shoot and its stage logs → the milestones (with doneAt) and the status it should be at. */
export const shootFromLogs = (shoot, logs) => {
  const doneAt = new Map();
  let phase = null;
  for (const l of logs) {
    const m = STAGE_TO_MILESTONE[l.shootStage];
    if (!m) continue;
    const st = STAGE_TO_STATUS[l.shootStage];
    if (phase === null || rank(st) > rank(phase)) phase = st;
    if (l.status === 'completed') {
      const at = new Date(l.loggedAt ?? l.createdAt ?? Date.now());
      if (!doneAt.has(m) || at > doneAt.get(m)) doneAt.set(m, at);
    }
  }
  const existing = new Map((shoot.milestones ?? []).map((m) => [m.key, m]));
  const keys = ['brief', 'pre_production', 'production', 'post_production', 'distribution'];
  const milestones = keys.map((key) => {
    const old = existing.get(key) ?? { key, date: null, doneAt: null };
    let done = old.doneAt ?? null;
    if (key === 'brief') done = done ?? new Date(shoot.createdAt ?? Date.now());
    else if (key === 'distribution') done = shoot.status === 'completed' ? done ?? new Date() : null;
    else done = doneAt.get(key) ?? null; // logs decide the three production milestones
    return { key, date: old.date ?? null, doneAt: done };
  });
  let status = shoot.status;
  if (!['cancelled', 'completed'].includes(status) && phase && rank(phase) > rank(status)) status = phase;
  return { milestones, status };
};

/** Rebuild one shoot from its logs and save it when something changed. */
export const syncShootFromLogs = async (shootId) => {
  if (!shootId) return null;
  const shoot = await MarketingShoot.findById(shootId);
  if (!shoot) return null;
  const logs = await MarketingActivity.find({ shootId: shoot._id, shootStage: { $ne: null } }).select('shootStage status loggedAt createdAt').lean();
  const next = shootFromLogs(shoot.toObject(), logs);
  const same = next.status === shoot.status && JSON.stringify(next.milestones.map((m) => [m.key, m.date, m.doneAt?.toISOString?.() ?? null])) === JSON.stringify(shoot.milestones.map((m) => [m.key, m.date, m.doneAt ? new Date(m.doneAt).toISOString() : null]));
  if (same) return shoot;
  shoot.milestones = next.milestones;
  shoot.status = next.status;
  await shoot.save();
  return shoot;
};
