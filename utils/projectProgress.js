// Project and per-department progress, derived from the project's tasks.
//
// The rule is the one the WBS tab already shows as "Overall progress": the average
// of the LEAF tasks' percent-complete (a task nothing else hangs under; phase /
// summary rows don't count), rounded. The project cards and the dashboard now read
// the same number, instead of a stored field nothing ever updated.
//
// Pure — tests/projectProgress.test.js.

const clamp = (n) => Math.min(100, Math.max(0, Number(n) || 0));
const idOf = (t) => String(t?._id ?? t?.id ?? '');

const eqCI = (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();

const isDoneStatus = (st) =>
  ['completed', 'closed', 'deployed', 'done'].includes(String(st ?? '').toLowerCase().trim());

const taskPercent = (t) => {
  if (isDoneStatus(t?.status)) return 100;
  return clamp(t?.percentComplete);
};

/// Tasks that no other task is nested under.
export const leafTasks = (tasks = []) => {
  const parents = new Set(tasks.map((t) => (t.parentTaskId ? String(t.parentTaskId) : '')).filter(Boolean));
  return tasks.filter((t) => !parents.has(idOf(t)));
};

const average = (rows) =>
  rows.length === 0 ? 0 : Math.round(rows.reduce((s, t) => s + taskPercent(t), 0) / rows.length);

/// 0–100 for the whole project.
export const projectProgress = (tasks = []) => average(leafTasks(tasks));

/**
 * Progress of each department's own leaf tasks. A task with no department belongs
 * to the owning department (that is every task of a project from before projects
 * could span departments).
 * @returns [{ name, progress, tasks, done }] in the order of [departments]
 */
export const departmentProgress = (tasks = [], departmentNames = [], ownerName = '') => {
  const leaves = leafTasks(tasks);
  return departmentNames.map((name) => {
    const mine = leaves.filter((t) => eqCI(t.departmentName || ownerName, name));
    return {
      name,
      progress: average(mine),
      tasks: mine.length,
      done: mine.filter((t) => isDoneStatus(t.status) || clamp(t.percentComplete) >= 100).length,
    };
  });
};
