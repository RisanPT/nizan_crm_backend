import Department from '../models/Department.js';
import Employee from '../models/Employee.js';
import User from '../models/User.js';
import { getUserIdsByEmployeeIds } from '../utils/notify.js';

const idOf = (v) => (v == null ? '' : String(v._id ?? v));

/// Login accounts of HR: its head, and everyone in the HR department (shared by Manpower and Company Projects).
export const hrUserIds = async () => {
  const depts = await Department.find({ name: /^(hr|human resources)$/i, active: { $ne: false } }).select('_id head').lean();
  const ids = new Set();
  const byDept = await User.find({ departmentId: { $in: depts.map((d) => d._id) }, active: { $ne: false } }).select('_id').lean();
  byDept.forEach((u) => ids.add(idOf(u._id)));
  const emps = await Employee.find({ department: /^(hr|human resources)$/i, status: { $ne: 'inactive' } }).select('_id').lean();
  const viaEmps = await getUserIdsByEmployeeIds([...emps.map((e) => e._id), ...depts.map((d) => d.head).filter(Boolean)]);
  viaEmps.forEach((u) => ids.add(idOf(u)));
  return [...ids];
};
