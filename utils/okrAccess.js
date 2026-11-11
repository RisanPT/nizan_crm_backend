import Project from '../models/Project.js';
import { seesAllProjects, buildProjectScope, canViewProject, canManageProject, loadAccessContext } from './projectAccess.js';
import { editModeOf } from './taskPermissions.js';
import { resolveUserDeptName } from './departmentScope.js';

const eqCI = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();

// Planning OKRs (projectId = null) with these department values are treated as
// COMPANY-WIDE — matching the Company Planning Dashboard's "Company-wide"
// bucket ('research-and-development' is the legacy schema default). This now
// applies ONLY to objectives saved before they had an explicit `level`.
export const isCompanyOKRDept = (d) => {
  const s = String(d || '').trim().toLowerCase();
  return s === '' || s === 'company' || s === 'research-and-development';
};

/// company | department | project. Explicit when stored; otherwise worked out the
/// way it always was (an objective of a project; else company-wide by its
/// department text; else a department's).
export const levelOf = (okr) => {
  if (okr?.level) return okr.level;
  if (okr?.projectId) return 'project';
  return isCompanyOKRDept(okr?.department) ? 'company' : 'department';
};

// Can the user VIEW this OKR?
//  - project OKR  → they can view the project
//  - company-wide → anyone signed in (company objectives are visible to all)
//  - department   → members of that department (+ leadership)
export const canViewOKR = async (u, okr) => {
  if (await seesAllProjects(u)) return true;
  const level = levelOf(okr);
  if (level === 'project') {
    const project = okr?.projectId ? await Project.findById(okr.projectId) : null;
    return project ? canViewProject(u, project) : false;
  }
  if (level === 'company') return true;
  const dept = await resolveUserDeptName(u);
  return eqCI(dept, okr?.department);
};

// Can the user CREATE / EDIT / DELETE this OKR?
//  - project OKR  → in a project whose manager decides the plan: the manager (and
//                   the owning department's head); in an open project (the way it
//                   was): everyone on the project
//  - company-wide → leadership only
//  - department   → that department's head (+ leadership)
export const canManageOKR = async (u, okr) => {
  if (await seesAllProjects(u)) return true;
  const level = levelOf(okr);
  if (level === 'project') {
    const project = okr?.projectId ? await Project.findById(okr.projectId) : null;
    if (!project) return false;
    return editModeOf(project) === 'managed' ? canManageProject(u, project) : canViewProject(u, project);
  }
  if (level === 'company') return false; // leadership handled above
  if (u?.isDepartmentHead) {
    const dept = await resolveUserDeptName(u);
    return eqCI(dept, okr?.department);
  }
  return false;
};

// Can the user UPDATE THE NUMBERS (check in on a key result)? Everyone who may
// manage the objective, everyone on its project, and the person named as the
// objective's head — they report progress without being able to rewrite the plan.
export const canCheckInOKR = async (u, okr) => {
  if (await canManageOKR(u, okr)) return true;
  if (levelOf(okr) === 'project') return canViewOKR(u, okr);
  const emp = u?.employeeId?.toString();
  return !!emp && (okr?.projectHeadId?._id ?? okr?.projectHeadId)?.toString() === emp;
};

// Filter a fetched list of OKRs down to the ones the user may view. Batches the
// project-scope + department resolution so it costs one project query total,
// not one per OKR.
export const filterViewableOKRs = async (u, okrs) => {
  if (await seesAllProjects(u)) return okrs;
  const scope = await buildProjectScope(u);
  const viewableIds = new Set((await Project.find(scope).distinct('_id')).map(String));
  const dept = await resolveUserDeptName(u);
  return okrs.filter((o) => {
    const level = levelOf(o);
    if (level === 'project') {
      const pId = o?.projectId?._id ? String(o.projectId._id) : (o?.projectId ? String(o.projectId) : '');
      return !!pId && viewableIds.has(pId);
    }
    if (level === 'company') return true;
    return eqCI(dept, o.department);
  });
};

const idOf = (v) => (v?._id ? String(v._id) : v ? String(v) : '');

/// What the caller may do to each of these objectives — { canManage, canCheckIn } by
/// objective id — worked out in one pass (one project query, one department lookup) so
/// the app can hide what would be refused. Same rules as canManageOKR / canCheckInOKR.
export const accessForOKRs = async (u, okrs) => {
  const out = new Map();
  if (!okrs.length) return out;
  const ctx = await loadAccessContext(u);
  const emp = u?.employeeId ? String(u.employeeId) : '';

  const projectIds = [...new Set(okrs.filter((o) => levelOf(o) === 'project').map((o) => idOf(o.projectId)).filter(Boolean))];
  const projects = projectIds.length ? await Project.find({ _id: { $in: projectIds } }).lean() : [];
  const projectInfo = new Map();
  for (const project of projects) {
    const viewable = ctx.full || (await canViewProject(u, project, ctx));
    const manage = ctx.full || (editModeOf(project) === 'managed' ? await canManageProject(u, project, ctx) : viewable);
    projectInfo.set(String(project._id), { viewable, manage });
  }

  for (const o of okrs) {
    const level = levelOf(o);
    let canManage = ctx.full;
    let canCheckIn = ctx.full;
    if (!ctx.full) {
      if (level === 'project') {
        const info = projectInfo.get(idOf(o.projectId));
        canManage = !!info?.manage;
        canCheckIn = canManage || !!info?.viewable;
      } else {
        canManage = level === 'department' && ctx.isHead && eqCI(ctx.deptName, o.department);
        canCheckIn = canManage || (!!emp && idOf(o.projectHeadId) === emp);
      }
    }
    out.set(String(o._id), { canManage, canCheckIn });
  }
  return out;
};
