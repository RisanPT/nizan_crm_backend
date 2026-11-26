// WHO IS ON A PROJECT — its manager and its team members — and what a change to them may be. Pure rules; the controller loads
// the employees and the project, and does the writing.
//
// A department's people are the ACTIVE employees whose `department` or `category` is its name (case doesn't matter). When nobody is
// tagged to a department, everyone active counts as its people — the same rule the app's pickers use, so a department with no
// tagged staff is not a dead end. A department LEAD (of a department on the project that is not the owner) gets no such fallback:
// they add and take off only their own department's people.

const norm = (s) => String(s ?? '').trim().toLowerCase();
export const idStr = (v) => (v == null ? '' : String(v._id ?? v));

/// Ids, each once, blanks dropped (objects with an _id count by it).
export const idList = (v) => {
  const out = [];
  for (const x of Array.isArray(v) ? v : []) {
    const id = idStr(x).trim();
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
};

export const isActive = (e) => norm(e?.status || 'active') === 'active';
export const inDepartment = (e, dept) => !!norm(dept) && (norm(e?.department) === norm(dept) || norm(e?.category) === norm(dept));

/// A department's active people; everyone active when nobody is tagged to it.
export const staffOf = (employees, dept) => {
  const active = (employees || []).filter(isActive);
  const own = active.filter((e) => inDepartment(e, dept));
  return own.length ? own : active;
};

/// Who is on the project before → after: [added] and [removed] count the manager and the members together (someone who moves
/// from member to manager, or back, is neither); [managerChanged] with [from] / [to].
export const peopleChange = ({ before = {}, after = {} }) => {
  const mgrBefore = idStr(before.managerId);
  const mgrAfter = idStr(after.managerId);
  const all = (mgr, members) => new Set([mgr, ...idList(members)].filter(Boolean));
  const was = all(mgrBefore, before.members);
  const now = all(mgrAfter, after.members);
  return {
    managerChanged: mgrBefore !== mgrAfter,
    from: mgrBefore,
    to: mgrAfter,
    added: [...now].filter((id) => !was.has(id)),
    removed: [...was].filter((id) => !now.has(id)),
    // the members as they will be stored: never the manager as well
    members: idList(after.members).filter((id) => id !== mgrAfter),
  };
};

const listNames = (names) => (names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);

/// May this change be made? [owner] is the owning department, [departments] every department working on the project (owner
/// included), [leadOf] the departments the caller leads when they do NOT run the project (null when they do), [proposerId] the
/// employee proposing a new project (who manages it whatever their department). Returns { error, code, status } or { ok: true }.
export const checkTeam = ({ employees, owner, departments, change, leadOf = null, proposerId = '' }) => {
  const byId = new Map((employees || []).map((e) => [idStr(e._id ?? e.id), e]));
  const nameOf = (id) => byId.get(id)?.name || 'Someone';
  const fail = (status, code, error) => ({ status, code, error });

  if (leadOf) {
    if (change.managerChanged) {
      return fail(403, 'TEAM_MANAGER_LOCKED', 'Only the project manager or the head of the owning department can hand the project to someone else.');
    }
    const theirs = (id) => leadOf.some((d) => inDepartment(byId.get(id), d));
    const outside = [...change.added, ...change.removed].filter((id) => !theirs(id));
    if (outside.length) {
      return fail(
        403,
        'TEAM_NOT_YOUR_DEPARTMENT',
        `You lead ${listNames(leadOf)}: you can add or take off ${leadOf.length === 1 ? 'its' : 'their'} people only. ${listNames(outside.map(nameOf))} ${outside.length === 1 ? 'is' : 'are'} not in ${listNames(leadOf)}.`,
      );
    }
  }

  if (change.managerChanged) {
    const m = byId.get(change.to);
    if (!change.to) return fail(400, 'TEAM_MANAGER_REQUIRED', 'Choose a project manager.');
    if (!m) return fail(400, 'TEAM_UNKNOWN', 'The project manager picked is not an employee.');
    if (!isActive(m)) return fail(400, 'TEAM_INACTIVE', `${m.name} is not an active employee, so cannot manage the project.`);
    const proposerManages = proposerId && change.to === proposerId;
    if (!proposerManages && !staffOf(employees, owner).some((e) => idStr(e._id ?? e.id) === change.to)) {
      return fail(400, 'TEAM_MANAGER_OUTSIDE', `${m.name} is not in ${owner}. The project manager comes from the owning department.`);
    }
  }

  const pool = new Set(
    (departments || []).flatMap((d) => staffOf(employees, d)).map((e) => idStr(e._id ?? e.id)),
  );
  for (const id of change.added) {
    if (id === change.to) continue; // the manager was checked above
    const e = byId.get(id);
    if (!e) return fail(400, 'TEAM_UNKNOWN', 'Someone picked for the team is not an employee.');
    if (!isActive(e)) return fail(400, 'TEAM_INACTIVE', `${e.name} is not an active employee.`);
    if (!pool.has(id)) {
      return fail(
        400,
        'TEAM_MEMBER_OUTSIDE',
        `${e.name} is not in the departments on this project (${listNames(departments)}). Add their department to the project first.`,
      );
    }
  }
  return { ok: true };
};

/// The project's activity lines for a change (names from [nameOf]); [work] says what happened to the people taken off.
export const teamActivityLines = (change, nameOf, work = {}) => {
  const lines = [];
  if (change.managerChanged && change.from && change.to) lines.push(`Project manager: ${nameOf(change.from)} → ${nameOf(change.to)}`);
  else if (change.managerChanged && change.to) lines.push(`${nameOf(change.to)} manages the project`);
  const joined = change.added.filter((id) => id !== change.to);
  if (joined.length) lines.push(`${listNames(joined.map(nameOf))} joined the team`);
  const left = change.removed;
  if (left.length) {
    const extra = [];
    if (work.unassigned) extra.push(`${work.unassigned} open task${work.unassigned === 1 ? '' : 's'} unassigned`);
    if (work.ended) extra.push(`${work.ended} HR placement${work.ended === 1 ? '' : 's'} ended`);
    lines.push(`${listNames(left.map(nameOf))} taken off the team${extra.length ? ` (${extra.join(', ')})` : ''}`);
  }
  return lines;
};

export { listNames };
