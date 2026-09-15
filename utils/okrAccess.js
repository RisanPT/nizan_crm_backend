import Project from '../models/Project.js';
import { seesAllProjects, buildProjectScope, canViewProject } from './projectAccess.js';
import { resolveUserDeptName } from './departmentScope.js';

const eqCI = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();

// Planning OKRs (projectId = null) with these department values are treated as
// COMPANY-WIDE — matching the Company Planning Dashboard's "Company-wide"
// bucket ('research-and-development' is the legacy schema default).
export const isCompanyOKRDept = (d) => {
  const s = String(d || '').trim().toLowerCase();
  return s === '' || s === 'company' || s === 'research-and-development';
};

// Can the user VIEW this OKR?
//  - project OKR  → they can view the project
//  - company-wide → anyone signed in (company objectives are visible to all)
//  - department   → members of that department (+ leadership)
export const canViewOKR = async (u, okr) => {
  if (await seesAllProjects(u)) return true;
  if (okr?.projectId) {
    const project = await Project.findById(okr.projectId);
    return project ? canViewProject(u, project) : false;
  }
  if (isCompanyOKRDept(okr?.department)) return true;
  const dept = await resolveUserDeptName(u);
  return eqCI(dept, okr?.department);
};

// Can the user CREATE / EDIT / DELETE this OKR?
//  - project OKR  → project members (collaborative, same as the task board)
//  - company-wide → leadership only
//  - department   → that department's head (+ leadership)
export const canManageOKR = async (u, okr) => {
  if (await seesAllProjects(u)) return true;
  if (okr?.projectId) {
    const project = await Project.findById(okr.projectId);
    return project ? canViewProject(u, project) : false;
  }
  if (isCompanyOKRDept(okr?.department)) return false; // leadership handled above
  if (u?.isDepartmentHead) {
    const dept = await resolveUserDeptName(u);
    return eqCI(dept, okr?.department);
  }
  return false;
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
    if (o.projectId) return viewableIds.has(String(o.projectId));
    if (isCompanyOKRDept(o.department)) return true;
    return eqCI(dept, o.department);
  });
};
