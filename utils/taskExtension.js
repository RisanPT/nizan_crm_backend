// EXTENDING A TASK'S DUE DATE — pure rules (controllers/itTaskController.js does the saving; tests/taskExtension.test.js).
//
//   • A task is OVERDUE when it has a due date, the due day is before today (IST) and it is not finished.
//   • The person who plans the task (the project manager, the owning department's head, a department lead for their own tasks, an admin)
//     extends it: a NEW due date later than the current one, and a REASON. Nothing else about the task changes.
//   • Every extension is written down for good (ITTask.extensions, append-only): when, by whom, from which day to which, how many days, how
//     overdue it already was, and why. The task's log gets a line too, and so does the project's activity. The count and the history are read
//     from that list — nothing is typed twice, and nothing can be edited afterwards.
//   • An ordinary edit that moves the due date of an OVERDUE task later is the same thing by another door, so it is written down too
//     (without a reason unless one was given): the count cannot be kept low by editing the date instead.
//
// Days are IST calendar days: a task due on the 12th is overdue from the 13th, at any hour.

const IST_MS = 330 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export const DONE_STATUSES = ['completed', 'closed', 'deployed', 'done'];
export const MAX_REASON = 300;
export const MIN_REASON = 3;
/// A due date further ahead than this is a slip of the finger.
export const MAX_DAYS_AHEAD = 5 * 366;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/// The IST calendar day (YYYY-MM-DD) of an instant, '' for none.
export const istDay = (d) => {
  if (d == null || d === '') return '';
  const t = new Date(d).getTime();
  return Number.isFinite(t) ? new Date(t + IST_MS).toISOString().slice(0, 10) : '';
};

/// How many IST calendar days [a] is after [b] (negative when before). NaN when either is not a date.
export const dayDiff = (a, b) => {
  const x = istDay(a);
  const y = istDay(b);
  if (!x || !y) return NaN;
  return Math.round((Date.parse(`${x}T00:00:00Z`) - Date.parse(`${y}T00:00:00Z`)) / DAY_MS);
};

/// "12 Nov 2026".
export const fmtDay = (d) => {
  const s = istDay(d);
  if (!s) return '';
  const [y, m, day] = s.split('-').map(Number);
  return `${day} ${MONTHS[m - 1]} ${y}`;
};

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/// Is the task finished? (a status that says so, or 100%)
export const isDone = (task) => DONE_STATUSES.includes(String(task?.status ?? '').toLowerCase().trim()) || Number(task?.percentComplete) >= 100;

/// How many days past its due day an unfinished task is (0 when it is not overdue, has no due date, or is finished).
export const overdueDays = (task, now = new Date()) => {
  if (!task?.deadline || isDone(task)) return 0;
  const d = dayDiff(now, task.deadline);
  return Number.isFinite(d) && d > 0 ? d : 0;
};

export const isOverdue = (task, now = new Date()) => overdueDays(task, now) > 0;

/// A new due date as the client sent it: a plain day ("2026-11-20") or a full date-time; null when it is neither.
export const parseDay = (v) => {
  if (v == null || v === '') return null;
  const text = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const d = new Date(`${text}T00:00:00.000Z`);
    return Number.isNaN(d.getTime()) || istDay(d) !== text ? null : d;
  }
  const d = new Date(text);
  return Number.isNaN(d.getTime()) ? null : d;
};

/// A reason as stored: words only, trimmed and capped.
export const cleanReason = (v) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_REASON);

const fail = (error, code) => ({ error, code });

/**
 * May this task be extended to [newDeadline] for [reason]?
 * @returns {{ to: Date, days: number, reason: string, overdueDays: number } | { error: string, code: string }}
 */
export const checkExtension = ({ task, newDeadline, reason, now = new Date() }) => {
  if (isDone(task)) return fail('This task is finished, so it has no due date to extend.', 'TASK_DONE');
  if (!task?.deadline) return fail('This task has no due date yet. Set one first; then it can be extended.', 'NO_DEADLINE');
  const to = parseDay(newDeadline);
  if (!to) return fail('Choose the new due date.', 'DATE_REQUIRED');
  const days = dayDiff(to, task.deadline);
  if (!Number.isFinite(days) || days <= 0) {
    return fail(`The new due date has to be after the current one (${fmtDay(task.deadline)}).`, 'NOT_LATER');
  }
  if (dayDiff(to, now) > MAX_DAYS_AHEAD) return fail('That due date is too far ahead to be right.', 'TOO_FAR');
  const why = cleanReason(reason);
  if (why.length < MIN_REASON) return fail('Say why the time is being extended.', 'REASON_REQUIRED');
  return { to, days, reason: why, overdueDays: overdueDays(task, now) };
};

/// One entry of the task's extension history.
export const buildExtension = ({ task, to, days, reason, overdue, user, at = new Date(), viaEdit = false }) => ({
  at,
  by: user?._id ?? null,
  byName: user?.name ?? '',
  from: task.deadline,
  to,
  days,
  reason: reason ?? '',
  overdueDays: overdue ?? 0,
  viaEdit,
});

/// The line the task's log (and the project's activity) gets for an extension.
export const extensionMessage = (e) => {
  const parts = [`Due date extended by ${plural(e.days, 'day')}: ${fmtDay(e.from)} → ${fmtDay(e.to)}`];
  if (e.overdueDays > 0) parts[0] += ` (it was ${plural(e.overdueDays, 'day')} overdue)`;
  return `${parts[0]}.${e.reason ? ` Reason: ${e.reason}` : ' No reason was given.'}`;
};

/**
 * What the history adds up to: how many times, how many days in all, the first due date, the latest extension.
 * @param {Array<{ at, from, to, days, overdueDays?, byName?, reason? }>} list
 */
export const summarizeExtensions = (list = []) => {
  const items = [...(list ?? [])].sort((a, b) => new Date(a.at) - new Date(b.at));
  return {
    count: items.length,
    totalDays: items.reduce((s, e) => s + (Number(e.days) || 0), 0),
    originalDeadline: items[0]?.from ?? null,
    last: items.length ? items[items.length - 1] : null,
    whileOverdue: items.filter((e) => (Number(e.overdueDays) || 0) > 0).length,
  };
};
