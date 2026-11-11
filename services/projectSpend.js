import mongoose from 'mongoose';
import Project from '../models/Project.js';
import AdminExpense from '../models/AdminExpense.js';
import Department from '../models/Department.js';
import { spendingLimit, money, toPaise, toRupees } from '../utils/projectCost.js';
import { summarize, checkSpend, canOverspend, alertFor } from '../utils/projectSpend.js';
import { canViewProject, escapeRegex } from '../utils/projectAccess.js';
import { isApprover } from '../utils/departmentScope.js';
import { notify, notifyRoles, NOTIFICATION_TYPES, getUserIdsByEmployeeIds } from '../utils/notify.js';

// Charging expenses to a project and keeping track of what it has spent against its approved cost. The rules are in
// utils/projectSpend.js (pure); this reads and writes the database and tells people.

const FIELDS = 'amount status expenseHead department date';

/// Every expense charged to a project (approved, pending and rejected), without [exceptId] (the one being checked).
export const expensesOf = (projectId, exceptId = null) =>
  AdminExpense.find({ projectId, ...(exceptId ? { _id: { $ne: exceptId } } : {}) })
    .select(FIELDS)
    .lean();

/// Where a project stands: spent, committed, what is left, by head / department / month.
export const spendFor = async (project, exceptId = null) =>
  summarize({ limit: spendingLimit(project), requested: project.budget, expenses: await expensesOf(project._id, exceptId) });

/// Spent and committed for many projects at once (the project list): Map projectId → { spent, committed }.
/// (An aggregate's $match does not cast ids: they must be real ObjectIds.)
export const spendMap = async (ids) => {
  const oids = ids.filter((i) => mongoose.isValidObjectId(i)).map((i) => new mongoose.Types.ObjectId(String(i)));
  const out = new Map();
  if (oids.length === 0) return out;
  const rows = await AdminExpense.aggregate([
    { $match: { projectId: { $in: oids }, status: { $in: ['approved', 'pending'] } } },
    { $group: { _id: { p: '$projectId', s: '$status' }, total: { $sum: '$amount' } } },
  ]);
  for (const r of rows) {
    const key = String(r._id.p);
    const cur = out.get(key) ?? { spent: 0, committed: 0 };
    const rupees = toRupees(toPaise(r.total));
    if (r._id.s === 'approved') cur.spent = rupees;
    else cur.committed = rupees;
    out.set(key, cur);
  }
  return out;
};

const problem = (status, code, message, extra = {}) => ({ error: { status, code, message, ...extra } });

/**
 * Can [user] charge [amount] to the project, and what would it do to it?
 * @returns {{ project, spend, check } | { error: { status, code, message } }}
 */
export const prepareCharge = async ({ projectId, user, amount, exceptId = null }) => {
  if (!mongoose.isValidObjectId(projectId)) return problem(400, 'PROJECT_INVALID', 'Choose a project from the list.');
  const project = await Project.findById(projectId);
  if (!project) return problem(404, 'PROJECT_NOT_FOUND', 'That project is not there any more.');
  if (['proposed', 'cancelled'].includes(project.status)) {
    return problem(409, 'PROJECT_CLOSED', `${project.name} is ${project.status === 'proposed' ? 'still a proposal' : 'cancelled'}, so nothing can be charged to it.`);
  }
  if (spendingLimit(project) <= 0) {
    return problem(409, 'PROJECT_NOT_APPROVED', `The finance head has not approved the cost of ${project.name} yet, so nothing can be charged to it.`);
  }
  if (!isApprover(user) && !(await canViewProject(user, project))) {
    return problem(403, 'PROJECT_FORBIDDEN', 'You are not on that project, so you cannot charge an expense to it.');
  }
  const spend = await spendFor(project, exceptId);
  const check = checkSpend({ limit: spendingLimit(project), spent: spend.spent, committed: spend.committed, amount });
  return { project, spend, check };
};

/**
 * An expense that takes the project past its limit may be APPROVED only by the finance head (or an administrator), with a
 * reason. Returns the refusal to send, or null when it is fine.
 */
export const overBudgetGate = ({ check, user, reason }) => {
  if (!check.over) return null;
  const detail = { limit: check.limit, used: check.used, after: check.after };
  if (!canOverspend(user?.role)) {
    return {
      status: 409,
      code: 'OVER_BUDGET',
      message: `This would take the project to ${money(check.after)} of its approved ${money(check.limit)}. Only the finance head can approve an expense that goes over the budget.`,
      ...detail,
    };
  }
  if (String(reason ?? '').trim().length < 3) {
    return {
      status: 409,
      code: 'OVER_BUDGET_REASON',
      message: `This takes the project to ${money(check.after)} of its approved ${money(check.limit)}. Say why it is approved over the budget.`,
      ...detail,
    };
  }
  return null;
};

const headUsers = async (name) => {
  const dept = await Department.findOne({ name: new RegExp(`^${escapeRegex(name)}$`, 'i') }).select('head').lean();
  return dept?.head ? getUserIdsByEmployeeIds([dept.head]) : [];
};

/**
 * Spending on a project changed: if it has crossed 80% of its approved cost, or gone past it, tell the people running it
 * (and Finance) once. Coming back down (a larger budget was approved, an expense was rejected) is silent and re-arms the warning.
 */
export const afterSpendChange = async (projectOrId) => {
  try {
    const id = projectOrId?._id ?? projectOrId;
    if (!mongoose.isValidObjectId(id)) return;
    const project = await Project.findById(id);
    if (!project) return;
    const spend = await spendFor(project);
    const alert = alertFor(project.costAlertLevel, spend.level);
    if (spend.level !== 'none' && spend.level !== (project.costAlertLevel ?? 'ok')) {
      await Project.updateOne({ _id: project._id }, { $set: { costAlertLevel: spend.level } });
    }
    if (!alert) return;
    const over = alert === 'over';
    const title = over ? `Over budget: ${project.name}` : `${project.name}: ${spend.usedPercent}% of the budget is used`;
    const body = over
      ? `${money(spend.used)} is charged against the approved ${money(spend.limit)} (${money(-spend.available)} over). Further expenses need the finance head.`
      : `${money(spend.used)} of the approved ${money(spend.limit)} is spent or committed; ${money(spend.available)} is left.`;
    const manager = project.managerId ? await getUserIdsByEmployeeIds([project.managerId]) : [];
    await notify({
      recipients: [...manager, ...(await headUsers(project.targetDepartment)), project.createdBy].filter(Boolean),
      type: NOTIFICATION_TYPES.PROJECT_BUDGET_ALERT,
      title,
      body,
      link: `/projects/${project._id}`,
    });
    await notifyRoles({ roles: ['finance_head'], type: NOTIFICATION_TYPES.PROJECT_BUDGET_ALERT, title, body, link: '/project-budgets' });
  } catch (err) {
    console.error('afterSpendChange failed:', err.message);
  }
};
