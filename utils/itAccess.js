import { permissionsForRole } from '../controllers/roleController.js';

// Role keys that have full IT Project Manager control (create, edit, delete, view all).
const IT_MANAGER_ROLE_KEYS = new Set([
  'admin',
  'manager',
  'project_manager',
  'it_manager',
  'it_head',
]);

// Role keys that are IT staff (developers, QA, designers, IT staff).
const IT_STAFF_ROLE_KEYS = new Set([
  'it',
  'admin',
  'manager',
  'project_manager',
  'it_manager',
  'it_head',
  'developer',
  'it_developer',
  'it_staff',
  'qa',
  'devops',
]);

export const isITManager = async (u) => {
  if (!u) return false;
  const role = (u.role || '').toLowerCase().trim();
  if (IT_MANAGER_ROLE_KEYS.has(role)) return true;
  if (u.isDepartmentHead) return true;
  try {
    const perms = await permissionsForRole(u.role);
    return perms.includes('it.manage') || (perms.includes('it') && (role.includes('manager') || role.includes('admin') || role.includes('head')));
  } catch {
    return false;
  }
};

export const isITStaff = async (u) => {
  if (!u) return false;
  const role = (u.role || '').toLowerCase().trim();
  if (IT_STAFF_ROLE_KEYS.has(role)) return true;
  if (await isITManager(u)) return true;
  try {
    const perms = await permissionsForRole(u.role);
    return perms.includes('it') || perms.some((p) => p.startsWith('it.'));
  } catch {
    return false;
  }
};

