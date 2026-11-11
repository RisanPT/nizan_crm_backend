// Who may change what on a task, in a project whose manager decides the structure.
//
//   project manager / admin     everything
//   department lead             everything on tasks of THEIR department
//   the person a task is given  only how it is going: status, % complete, hours,
//   to                          sub-task ticks and notes — not its title, dates,
//                               assignee, department or place in the plan
//   anyone else on the project  can look, not edit
//
// Projects from before this (no `editMode`) stay open: anyone on the project edits
// any task, exactly as before. The manager can switch a project either way.
//
// Pure — tests/taskPermissions.test.js.

/// What an assignee may change on their own task.
export const PROGRESS_FIELDS = ['status', 'percentComplete', 'actualHours', 'subtasks', 'activityLogs', 'completedAt'];

// Fields a client echoes back that are not changes.
const IGNORED = new Set(['_id', 'id', '__v', 'createdAt', 'updatedAt', 'projectId']);

/// 'managed' (the manager decides) or 'open' (anyone on the project edits). A
/// project saved before the setting existed is open.
export const editModeOf = (project) => (project?.editMode === 'managed' ? 'managed' : 'open');

const comparable = (v) => {
  if (v == null) return null;
  if (v instanceof Date) return v.getTime();
  if (Array.isArray(v)) return JSON.stringify(v.map(comparable));
  if (typeof v === 'object') {
    if (v._id != null && Object.keys(v).length <= 3) return String(v._id); // a populated reference
    if (typeof v.toHexString === 'function') return v.toHexString(); // an ObjectId
    return JSON.stringify(Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, x]) => [k, comparable(x)])));
  }
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v)) {
    const t = Date.parse(v);
    if (!Number.isNaN(t)) return t;
  }
  return v;
};

/**
 * The fields in [body] that are NOT progress fields and really differ from what is
 * stored. A form that sends the whole task back changes nothing by doing so.
 * @param {object} existing  the stored task (plain object or document)
 * @param {object} body      the request body
 */
export const structureChanges = (existing, body) => {
  const plain = typeof existing?.toObject === 'function' ? existing.toObject() : existing ?? {};
  return Object.keys(body ?? {}).filter((k) => {
    if (IGNORED.has(k) || PROGRESS_FIELDS.includes(k)) return false;
    return comparable(body[k]) !== comparable(plain[k]);
  });
};
