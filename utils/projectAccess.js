import { resolveUserDeptName } from './departmentScope.js';
import { permissionsForRole } from '../controllers/roleController.js';
import ITTask from '../models/ITTask.js';
import { departmentsOf, eqCI as sameName } from './projectDepartments.js';
import { editModeOf } from './taskPermissions.js';
import { canSeeCostAmounts } from './projectCost.js';
import { LEADERSHIP_ROLES, isLeadership } from './leadership.js';

// Roles / permissions that see & manage EVERY project across all departments.
// Keeps existing IT project managers (project_manager / it.manage) from
// regressing when projects go company-wide.
const ALL_PROJECT_ROLE_KEYS = new Set([
  'admin',
  'manager',
  'project_manager',
  // Coordinates every company project across departments.
  'executive_coordinator',
  // The CEO and the Executive Director see all of them — to decide on proposals, not to run them (see `viewOnly` below).
  ...LEADERSHIP_ROLES,
]);

export const escapeRegex = (s) => String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const eqCI = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();

export const seesAllProjects = async (u) => {
  if (!u) return false;
  const role = (u.role || '').toLowerCase().trim();
  if (ALL_PROJECT_ROLE_KEYS.has(role)) return true;
  try {
    const perms = await permissionsForRole(u.role);
    return perms.includes('it.manage') || perms.includes('planning.manage');
  } catch {
    return false;
  }
};

// Mongo filter that scopes getProjects for a user:
//  - full-access → {} (everything)
//  - dept head → their department's projects + anything they manage/are on
//  - regular staff → only projects they manage / are a member of / have a task in
export const buildProjectScope = async (u) => {
  if (await seesAllProjects(u)) return {};
  const or = [];
  const empId = u?.employeeId;
  if (empId) {
    const taskProjectIds = await ITTask.distinct('projectId', { assignedTo: empId });
    or.push({ managerId: empId }, { members: empId }, { _id: { $in: taskProjectIds } });
  }
  if (u?.isDepartmentHead) {
    const dept = await resolveUserDeptName(u);
    if (dept) {
      const re = new RegExp(`^${escapeRegex(dept)}$`, 'i');
      or.push({ targetDepartment: re });
      // …and every project that INVITED their department (so the head can answer),
      // until they decline.
      or.push({ departments: { $elemMatch: { name: re, status: { $ne: 'declined' } } } });
    }
  }
  // The person a department named as its lead on a project sees it too.
  if (empId) or.push({ departments: { $elemMatch: { leadId: empId, status: { $ne: 'declined' } } } });
  if (or.length === 0) return { _id: null }; // nothing visible
  return { $or: or };
};

// ── who is who on a project ─────────────────────────────────────────────────

/// What we need to know about the caller, resolved once per request.
export const loadAccessContext = async (u) => ({
  full: await seesAllProjects(u),
  // the finance head decides a project's cost; Accounts can see it
  financeHead: ['finance_head', 'admin'].includes(String(u?.role ?? '').trim().toLowerCase()),
  finance: ['finance_head', 'accounts', 'admin'].includes(String(u?.role ?? '').trim().toLowerCase()),
  // a leadership login (CEO, Executive Director) looks and decides; it does not plan (no managing, no adding or changing tasks)
  viewOnly: isLeadership(u),
  empId: u?.employeeId ? String(u.employeeId) : '',
  isHead: !!u?.isDepartmentHead,
  // only a department head's department matters for access (saves two lookups per request)
  deptName: u?.isDepartmentHead ? await resolveUserDeptName(u) : '',
});

const idStr = (v) => (v?._id ?? v)?.toString?.() ?? '';

export const isProjectManager = (project, ctx) => !!ctx.empId && idStr(project.managerId) === ctx.empId;

/// The head of the project's OWNING department.
export const isOwnerHead = (project, ctx) =>
  ctx.isHead && !!ctx.deptName && sameName(ctx.deptName, project.targetDepartment);

/// The project's departments (not declined) the caller leads: as the department's
/// head, or as the person it named as lead. [acceptedOnly] drops the invitations
/// not yet answered — an invited department can look, but not yet work.
export const departmentsLedBy = (project, ctx, { acceptedOnly = false } = {}) =>
  departmentsOf(project)
    .filter((d) => d.status !== 'declined' && (!acceptedOnly || d.status === 'accepted'))
    .filter(
      (d) =>
        (ctx.isHead && !!ctx.deptName && sameName(ctx.deptName, d.name)) ||
        (!!ctx.empId && idStr(d.leadId) === ctx.empId),
    )
    .map((d) => d.name);

/// Edit the project itself (settings, departments, its objectives): an admin, the
/// project manager, or the head of the owning department.
export const canManageProject = async (u, project, ctx = null) => {
  const c = ctx ?? (await loadAccessContext(u));
  return c.full || isProjectManager(project, c) || isOwnerHead(project, c);
};

/// See the project: those who manage it, the heads / leads of the departments it
/// involves, its members, and anyone given a task on it.
export const canViewProject = async (u, project, ctx = null) => {
  const c = ctx ?? (await loadAccessContext(u));
  if (c.full || isProjectManager(project, c) || isOwnerHead(project, c)) return true;
  if (departmentsLedBy(project, c).length > 0) return true;
  if (c.empId) {
    const isMember = (project.members || []).some((m) => idStr(m) === c.empId);
    if (isMember) return true;
    const hasTask = await ITTask.exists({ projectId: project._id, assignedTo: c.empId });
    if (hasTask) return true;
  }
  return false;
};

// ── what a person may do to the project's TASKS ─────────────────────────────
// (projects saved before the manager-decides setting are 'open': anyone who can
// see the project edits anything, as before — see utils/taskPermissions.js)

const taskDepartment = (project, task) => String(task?.departmentName || '').trim() || project.targetDepartment;

/// May they create a task for [departmentName] (blank = the owning department)?
export const canCreateTaskIn = (project, ctx, departmentName = '') => {
  if (editModeOf(project) === 'open') return true;
  if (ctx.full || isProjectManager(project, ctx) || isOwnerHead(project, ctx)) return true;
  const dept = String(departmentName || '').trim() || project.targetDepartment;
  return departmentsLedBy(project, ctx, { acceptedOnly: true }).some((n) => sameName(n, dept));
};

/**
 * What they may do to an existing task: { all, progress, delete }
 *   all       change anything (the plan: title, dates, assignee, department, …)
 *   progress  change how it is going (status, %, hours, sub-tasks, notes)
 *   delete    remove it
 */
export const taskRights = (project, ctx, task) => {
  if (editModeOf(project) === 'open') return { all: true, progress: true, delete: true };
  if (ctx.full || isProjectManager(project, ctx) || isOwnerHead(project, ctx)) {
    return { all: true, progress: true, delete: true };
  }
  const dept = taskDepartment(project, task);
  if (departmentsLedBy(project, ctx, { acceptedOnly: true }).some((n) => sameName(n, dept))) {
    return { all: true, progress: true, delete: true };
  }
  const mine = !!ctx.empId && idStr(task?.assignedTo) === ctx.empId;
  return { all: false, progress: mine, delete: false };
};

/// A summary of the caller's standing on a project, for the app to decide what to
/// show (the server enforces the same rules on every request).
export const accessSummary = (project, ctx, { hasTask = false } = {}) => {
  const manager = isProjectManager(project, ctx);
  const ownerHead = isOwnerHead(project, ctx);
  const manage = !ctx.viewOnly && (ctx.full || manager || ownerHead);
  const leads = ctx.viewOnly ? [] : departmentsLedBy(project, ctx);
  const working = ctx.viewOnly ? [] : departmentsLedBy(project, ctx, { acceptedOnly: true });
  const isMember = (project.members || []).some((m) => idStr(m) === ctx.empId) || hasTask;
  const mode = editModeOf(project);
  return {
    role: ctx.viewOnly ? 'viewer' : ctx.full ? 'admin' : manager ? 'manager' : ownerHead ? 'owner_head' : leads.length ? 'dept_lead' : isMember ? 'member' : 'viewer',
    canManage: manage,
    editMode: ctx.viewOnly ? 'managed' : mode, // so the app never offers an "open" project's edit controls to the CEO
    // may add tasks (anywhere, or only in a department they lead)
    canCreateTasks: !ctx.viewOnly && (mode === 'open' || manage || working.length > 0),
    // may change the plan of every task / only how their own are going
    canEditAllTasks: !ctx.viewOnly && (mode === 'open' || manage),
    leadDepartments: working,
    // may approve / reject this proposal (the owning department's head or an admin — never the proposer as such)
    canDecide: project.status === 'proposed' && (ctx.full || ownerHead),
    // the cost: see the amounts, change it (those who run the project), and decide on it (the finance head)
    canSeeCost: canSeeCostAmounts({ full: ctx.full, manager, ownerHead, finance: ctx.finance }),
    canEditCost: manage,
    // (not while the CEO / Executive Director are deciding on it)
    canDecideCost: !!ctx.financeHead && project.costStatus === 'pending' && !['proposed', 'cancelled'].includes(project.status) && project.costLeadership?.state !== 'awaiting',
    awaitingLeadership: project.costLeadership?.state === 'awaiting',
    pendingInvitations: departmentsOf(project)
      .filter((d) => d.status === 'invited' && (ctx.full || leads.some((n) => sameName(n, d.name))))
      .map((d) => d.name),
  };
};
