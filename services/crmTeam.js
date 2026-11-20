import User from '../models/User.js';
import Department from '../models/Department.js';
import { isCrmHead } from '../utils/crmAccess.js';

// The CRM team's logins: everyone with a CRM role (crm, crm_manager), plus anyone whose department is CRM. Inactive logins are left
// out. Each comes back as { _id, name, role, isHead }.

const CRM_ROLES = ['crm', 'crm_manager'];

let deptIdCache = null;
const crmDepartmentId = async () => {
  if (deptIdCache !== null) return deptIdCache;
  const d = await Department.findOne({ key: 'crm' }).select('_id').lean();
  deptIdCache = d?._id ?? '';
  return deptIdCache;
};

export const crmTeamUsers = async () => {
  const deptId = await crmDepartmentId();
  const or = [{ role: { $in: CRM_ROLES } }];
  if (deptId) or.push({ departmentId: deptId });
  const users = await User.find({ $or: or, active: { $ne: false } }).select('name role isDepartmentHead employeeId').sort({ name: 1 }).lean();
  return users.map((u) => ({ _id: u._id, name: u.name || '', role: u.role || '', employeeId: u.employeeId ?? null, isHead: isCrmHead(u) }));
};

/// The CRM Heads' login ids (for "tell the head").
export const crmHeadIds = async () => (await crmTeamUsers()).filter((u) => u.isHead).map((u) => u._id);

/// Is [userId] a member of the CRM team (the people work can be given to)?
export const isOnCrmTeam = async (userId) => (await crmTeamUsers()).some((u) => String(u._id) === String(userId));

/// Tests only: forget the cached CRM department.
export const _resetCrmTeamCache = () => {
  deptIdCache = null;
};
