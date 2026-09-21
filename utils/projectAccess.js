import { resolveUserDeptName } from './departmentScope.js';
import { permissionsForRole } from '../controllers/roleController.js';
import ITTask from '../models/ITTask.js';

// Roles / permissions that see & manage EVERY project across all departments.
// Keeps existing IT project managers (project_manager / it.manage) from
// regressing when projects go company-wide.
const ALL_PROJECT_ROLE_KEYS = new Set([
  'admin',
  'manager',
  'project_manager',
  // Coordinates every company project across departments.
  'executive_coordinator',
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
    if (dept) or.push({ targetDepartment: new RegExp(`^${escapeRegex(dept)}$`, 'i') });
  }
  if (or.length === 0) return { _id: null }; // nothing visible
  return { $or: or };
};

export const canManageProject = async (u, project) => {
  if (await seesAllProjects(u)) return true;
  const empId = u?.employeeId?.toString();
  const mgr = (project.managerId?._id ?? project.managerId)?.toString();
  if (empId && mgr && empId === mgr) return true;
  if (u?.isDepartmentHead) {
    const dept = await resolveUserDeptName(u);
    if (dept && eqCI(dept, project.targetDepartment)) return true;
  }
  return false;
};

export const canViewProject = async (u, project) => {
  if (await canManageProject(u, project)) return true;
  const empId = u?.employeeId?.toString();
  if (empId) {
    const isMember = (project.members || []).some((m) => (m?._id ?? m)?.toString() === empId);
    if (isMember) return true;
    const hasTask = await ITTask.exists({ projectId: project._id, assignedTo: u.employeeId });
    if (hasTask) return true;
  }
  return false;
};
