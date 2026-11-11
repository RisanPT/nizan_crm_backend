// Which departments a project involves, and the rules for inviting them.
//
// A project has ONE owning department (`targetDepartment`, the one that approves
// and is accountable) and any number of participating departments. Each
// participant is invited by the project manager and must accept: its head sees the
// project (to answer) the moment it is invited, but its people only start working
// on it once the head accepts. `targetDepartment` stays in step with the owner
// entry so everything written before this existed keeps working.
//
// Pure — tests/projectDepartments.test.js.

export const eqCI = (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();

export const DEPT_STATUSES = ['invited', 'accepted', 'declined'];

/// A project's departments, owner first. A project from before departments existed
/// has none stored: its single `targetDepartment` stands in as the accepted owner.
/// Once added by the project manager, departments are directly included (no approval delay).
export const departmentsOf = (project) => {
  const stored = Array.isArray(project?.departments)
    ? project.departments
        .filter((d) => d?.name)
        .map((d) => ({
          ...(typeof d === 'object' ? (d.toObject ? d.toObject() : d) : { name: String(d) }),
          status: d.status === 'declined' ? 'declined' : 'accepted',
        }))
    : [];
  if (stored.length > 0) return stored;
  const owner = String(project?.targetDepartment ?? '').trim();
  return owner ? [{ name: owner, role: 'owner', leadId: null, status: 'accepted' }] : [];
};

/// Names of the departments actually on the project (a declined invitation is out).
export const activeDepartmentNames = (project) =>
  departmentsOf(project)
    .filter((d) => d.status !== 'declined')
    .map((d) => d.name);

export const hasDepartment = (project, name) => activeDepartmentNames(project).some((n) => eqCI(n, name));

/**
 * The department list after the project manager (or an admin) edits it.
 *
 * @param {object}   o
 * @param {Array}    o.requested   [{ name, leadId? }] or [name] — the participants wanted
 *                                 (the owner may be included; it is ignored here)
 * @param {Array}    o.existing    the current entries (keeps each one's status)
 * @param {string}   o.ownerName   the owning department
 * @param {string}   [o.actorDept] the department of whoever is saving: inviting your OWN
 *                                 department needs no acceptance
 * @param {Date}     [o.now]
 * @returns {{ departments, added: string[], removed: string[] }}
 */
export const normalizeDepartments = ({ requested = [], existing = [], ownerName, actorDept = '', now = new Date() }) => {
  const owner = String(ownerName ?? '').trim();
  const had = (existing ?? []).filter((d) => d?.name);
  const prior = (name) => had.find((d) => eqCI(d.name, name));

  const wanted = [];
  for (const r of requested ?? []) {
    const name = String(typeof r === 'string' ? r : r?.name ?? '').trim();
    if (!name || eqCI(name, owner) || wanted.some((w) => eqCI(w.name, name))) continue;
    wanted.push({ name, leadId: typeof r === 'object' ? r?.leadId ?? null : null });
  }

  const departments = [];
  if (owner) {
    const o = prior(owner);
    departments.push({
      name: owner,
      role: 'owner',
      leadId: o?.leadId ?? null,
      status: 'accepted',
      invitedAt: o?.invitedAt ?? null,
      respondedAt: o?.respondedAt ?? null,
    });
  }
  const added = [];
  for (const w of wanted) {
    const p = prior(w.name);
    departments.push({
      name: w.name,
      role: 'participant',
      leadId: w.leadId ?? p?.leadId ?? null,
      status: 'accepted',
      invitedAt: p?.invitedAt ?? now,
      respondedAt: p?.respondedAt ?? now,
    });
    if (!p || p.status === 'declined') added.push(w.name);
  }

  const removed = had
    .filter((d) => !eqCI(d.name, owner) && !wanted.some((w) => eqCI(w.name, d.name)))
    .map((d) => d.name);
  return { departments, added, removed };
};
