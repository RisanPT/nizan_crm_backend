import mongoose from 'mongoose';
import { BRANDS, ACTIVITY_STATUSES, ACTIVITY_KINDS } from '../models/MarketingActivity.js';
import { TASK_STATUSES, TASK_PRIORITIES } from '../models/MarketingTask.js';

// Checking what the app sends for a log and for a task. Pure (tests/marketingActivityInput.test.js): the controller adds the checks
// that need the database (who may log for whom, the edit window, the member's activity set).

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const str = (v, max) => String(v ?? '').trim().slice(0, max);
const idOrNull = (v) => (v && mongoose.isValidObjectId(String(v)) ? String(v) : null);
const fail = (message, field) => ({ ok: false, message, field });

export const isDay = (v) => {
  if (typeof v !== 'string' || !DAY_RE.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v; // 2026-02-31 is not a day
};

/** Links the app may send: only http(s), so a "link" can never be a script or a file path. */
export const cleanAttachments = (list) => {
  if (list == null) return { ok: true, value: [] };
  if (!Array.isArray(list)) return fail('Attachments must be a list of links.', 'attachments');
  if (list.length > 10) return fail('Attach at most 10 links.', 'attachments');
  const out = [];
  for (const a of list) {
    const url = str(typeof a === 'string' ? a : a?.url, 1000);
    if (!/^https?:\/\/\S+$/i.test(url)) return fail('Each attachment must be a link starting with http:// or https://.', 'attachments');
    out.push({ label: str(typeof a === 'string' ? '' : a?.label, 120), url });
  }
  return { ok: true, value: out };
};

/**
 * One log as sent by the Log Activity form.
 * → { ok: true, value: { entryDate, brand, kind, workedOn, projectLabel, completed, pending, nextPriority, timeSpentMinutes, status,
 *     comment, attachments, values, projectId, taskId, campaignId, shootId, shootStage, contentId, initiativeId, devProjectId, groupId, taskProgress } }
 * | { ok: false, message, field }
 */
export const cleanActivityInput = (body = {}, { today } = {}) => {
  const entryDate = body.entryDate ?? today;
  if (!isDay(entryDate)) return fail('The date must be YYYY-MM-DD.', 'entryDate');
  if (today && entryDate > today) return fail('You cannot log work for a future date.', 'entryDate');
  const workedOn = str(body.workedOn, 300);
  if (workedOn.length < 2) return fail('Say what you worked on.', 'workedOn');
  const brand = body.brand === undefined || body.brand === '' ? 'main' : String(body.brand).toLowerCase();
  if (!BRANDS.includes(brand)) return fail('Brand must be Main or Kerala.', 'brand');
  const kind = body.kind === undefined || body.kind === '' ? 'task' : String(body.kind);
  if (!ACTIVITY_KINDS.includes(kind)) return fail('Unknown kind of activity.', 'kind');
  const status = body.status === undefined || body.status === '' ? 'completed' : String(body.status);
  if (!ACTIVITY_STATUSES.includes(status)) return fail('Unknown status.', 'status');

  let minutes = body.timeSpentMinutes ?? 0;
  if (typeof minutes === 'string' && minutes.trim() !== '') minutes = Number(minutes);
  if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes < 0 || minutes > 1440) return fail('Time spent must be between 0 and 24 hours.', 'timeSpentMinutes');
  minutes = Math.round(minutes);

  const attachments = cleanAttachments(body.attachments);
  if (!attachments.ok) return attachments;

  const values = [];
  if (body.values != null) {
    if (!Array.isArray(body.values)) return fail('Counts must be a list.', 'values');
    const seen = new Set();
    for (const v of body.values) {
      const metricId = idOrNull(v?.metricId);
      if (!metricId) return fail('A count names an unknown activity.', 'values');
      if (seen.has(metricId)) return fail('An activity is counted twice in one log.', 'values');
      seen.add(metricId);
      const value = typeof v.value === 'string' ? Number(v.value) : v.value;
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return fail('Counts cannot be negative.', 'values');
      if (value === 0) continue; // a zero count is no count
      values.push({ metricId, value, details: str(v.details, 500) });
    }
  }

  let taskProgress = null;
  if (body.taskProgress !== undefined && body.taskProgress !== null && body.taskProgress !== '') {
    taskProgress = Number(body.taskProgress);
    if (!Number.isFinite(taskProgress) || taskProgress < 0 || taskProgress > 100) return fail('Progress must be 0 to 100.', 'taskProgress');
    taskProgress = Math.round(taskProgress);
  }

  return {
    ok: true,
    value: {
      entryDate,
      brand,
      kind,
      workedOn,
      projectLabel: str(body.projectLabel, 200),
      completed: str(body.completed, 1000),
      pending: str(body.pending, 1000),
      nextPriority: str(body.nextPriority, 500),
      timeSpentMinutes: minutes,
      status,
      comment: str(body.comment, 1000),
      attachments: attachments.value,
      values,
      projectId: idOrNull(body.projectId),
      taskId: idOrNull(body.taskId),
      campaignId: idOrNull(body.campaignId),
      shootId: idOrNull(body.shootId),
      shootStage: idOrNull(body.shootId) && ['pre_production', 'production', 'post_production'].includes(body.shootStage) ? body.shootStage : null,
      contentId: idOrNull(body.contentId),
      initiativeId: idOrNull(body.initiativeId),
      devProjectId: idOrNull(body.devProjectId),
      groupId: idOrNull(body.groupId),
      taskProgress,
    },
  };
};

/**
 * A task as sent by the task form (create or edit). Progress and status stay consistent: 100% is completed, completed is 100%.
 * `existing` (an edit) supplies what was not sent. → { ok, value } | { ok: false, message, field }
 */
export const cleanTaskInput = (body = {}, existing = null) => {
  const pick = (key, fallback) => (body[key] !== undefined ? body[key] : existing?.[key] ?? fallback);
  const title = str(pick('title', ''), 300);
  if (title.length < 2) return fail('Give the task a title.', 'title');
  const brand = String(pick('brand', 'main') || 'main').toLowerCase();
  if (!BRANDS.includes(brand)) return fail('Brand must be Main or Kerala.', 'brand');
  const priority = String(pick('priority', 'medium') || 'medium');
  if (!TASK_PRIORITIES.includes(priority)) return fail('Priority must be high, medium or low.', 'priority');
  let status = String(pick('status', 'not_started') || 'not_started');
  if (!TASK_STATUSES.includes(status)) return fail('Unknown status.', 'status');
  const dueRaw = pick('dueDate', null);
  const dueDate = dueRaw === null || dueRaw === '' ? null : String(dueRaw);
  if (dueDate !== null && !isDay(dueDate)) return fail('The due date must be YYYY-MM-DD.', 'dueDate');
  let progress = Number(pick('progress', 0));
  if (!Number.isFinite(progress) || progress < 0 || progress > 100) return fail('Progress must be 0 to 100.', 'progress');
  progress = Math.round(progress);
  // keep progress and status telling the same story
  if (status === 'completed') progress = 100;
  else if (progress === 100) status = 'completed';
  else if (status === 'not_started' && progress > 0) status = 'in_progress';
  const attachments = cleanAttachments(body.attachments !== undefined ? body.attachments : existing?.attachments ?? []);
  if (!attachments.ok) return attachments;
  return {
    ok: true,
    value: {
      title,
      description: str(pick('description', ''), 2000),
      brand,
      priority,
      status,
      progress,
      dueDate,
      projectLabel: str(pick('projectLabel', ''), 200),
      projectId: idOrNull(pick('projectId', null)),
      groupId: idOrNull(pick('groupId', null)),
      initiativeId: idOrNull(pick('initiativeId', null)),
      devProjectId: idOrNull(pick('devProjectId', null)),
      assigneeId: idOrNull(pick('assigneeId', null)),
      isDeliverable: pick('isDeliverable', false) === true,
      attachments: attachments.value,
    },
  };
};
