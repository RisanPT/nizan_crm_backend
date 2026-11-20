import ITTask from '../models/ITTask.js';
import Project from '../models/Project.js';
import { accessSummary } from '../utils/projectAccess.js';
import { cleanAmount, money, toPaise } from '../utils/projectCost.js';
import { TASK_COST_KEYS, checkGuard, planCeiling, planLevel, raiseCost, resolveTaskCost, rollup } from '../utils/taskCost.js';
import { planCostChange, submitCostChange } from './projectCostRequest.js';

// TASK COSTS AGAINST THE PROJECT'S BUDGET — the database half of utils/taskCost.js (read that for the rules).
//
// Every task save that could move a task's cost goes through prepareTaskCost first: it works the planned cost out, adds up the plan as it
// would be after the save, and — when that goes above the project's ceiling and ADDS to the plan — refuses the save (409
// TASK_COST_OVER_BUDGET) unless it carries a budget increase for the finance head (`budgetIncrease: { reason, amount? }`), which is then
// sent through the same flow as any change to a project's cost. Nothing is half-done: everything that can be refused is refused BEFORE
// the task is written.

/// Fields of the tasks that the plan is added up from.
const PLAN_FIELDS = 'parentTaskId plannedCost departmentName';

export const loadPlanTasks = (projectId) => ITTask.find({ projectId }).select(PLAN_FIELDS).lean();

const idStr = (v) => (v == null ? '' : String(v._id ?? v));
const plain = (v) => (typeof v?.toObject === 'function' ? v.toObject() : v);

/**
 * Where the plan by tasks stands against the project's budget — what the app shows to those who may see money.
 * @param {object} project  a Project document / plain object
 * @param {Array} tasks     the project's tasks (needs _id, parentTaskId, plannedCost, departmentName)
 */
export const taskPlanSummary = (project, tasks) => {
  const r = rollup(tasks, { ownerDepartment: project.targetDepartment });
  const ceiling = planCeiling(project);
  const level = planLevel(r.planned, ceiling);
  return {
    planned: r.planned,
    ceiling,
    level,
    over: level === 'over' ? Math.round((r.planned - ceiling) * 100) / 100 : 0,
    leaves: r.leaves,
    priced: r.priced,
    unpriced: r.unpriced,
    byDepartment: r.byDepartment,
    // a request to the finance head is waiting (the first one, or an increase): the ceiling is what is ASKED for until it is decided —
    // so the app must not call it "approved"
    awaiting: project.costStatus === 'pending' && ceiling > 0,
  };
};

const refuse = (status, body) => ({ error: { status, body } });

/**
 * Check a task save against the budget BEFORE it is written, and work out what it stores.
 *
 * @param {object} p
 * @param {object} p.project   the Project document
 * @param {object} p.ctx       the caller's access context (utils/projectAccess.loadAccessContext)
 * @param {object|null} p.existing  the stored task when updating, null when creating
 * @param {object} p.body      the request body — CHANGED IN PLACE: the server-owned and request-only keys are removed from it
 * @returns {Promise<{ error: { status, body } } | { fields: object, parentToRelease: string|null, request: object|null }>}
 *   fields = cost fields to write with the task · parentToRelease = a task that gives up its own cost because it gains a sub-task ·
 *   request = a budget increase to send once the task is saved
 */
export const prepareTaskCost = async ({ project, ctx, existing = null, body }) => {
  const access = accessSummary(project, ctx);
  delete body.plannedCost; // the server's alone
  const increase = body.budgetIncrease;
  delete body.budgetIncrease;

  const creating = !existing;
  const existingPlain = plain(existing) ?? {};
  const sent = TASK_COST_KEYS.filter((k) => k in body);

  // A client that cannot change costs may echo back what it was given (it is not given any, so it sends nothing); anything else is refused.
  if (sent.length) {
    const unchanged = !creating && sent.every((k) => (k === 'costMode' ? String(body[k] ?? '') === String(existingPlain[k] ?? '') : Number(body[k] ?? 0) === Number(existingPlain[k] ?? 0)));
    const emptyOnCreate = creating && sent.every((k) => (k === 'costMode' ? !body[k] : !Number(body[k])));
    if (unchanged || emptyOnCreate) for (const k of sent) delete body[k];
    else if (!access.canEditCost) {
      return refuse(403, { message: 'Only the project manager, or the head of the owning department, can set what a task costs.', code: 'TASK_COST_FORBIDDEN' });
    }
  }
  const costKeysNow = TASK_COST_KEYS.filter((k) => k in body);

  // What moves a cost: the cost keys; the hours an hours-based cost is worked out from; a task gaining its first sub-task.
  const newParent = body.parentTaskId ? idStr(body.parentTaskId) : '';
  const gainsParent = !!newParent && newParent !== idStr(existingPlain.parentTaskId);
  const hoursMoved = 'estimatedHours' in body && !creating && existingPlain.costMode === 'rate' && Number(body.estimatedHours) !== Number(existingPlain.estimatedHours);
  const none = { fields: {}, parentToRelease: null, request: null };
  if (!costKeysNow.length && !hoursMoved && !gainsParent) return none;

  const tasks = await loadPlanTasks(project._id);
  const hasChildren = !creating && tasks.some((t) => idStr(t.parentTaskId) === idStr(existing._id));

  let fields = {};
  let planned = Number(existingPlain.plannedCost) || 0;
  if (costKeysNow.length || hoursMoved) {
    if (hasChildren && costKeysNow.length && (body.costMode || Number(body.costAmount) || Number(body.costRate))) {
      return refuse(400, { message: 'This task is split into sub-tasks. Give the cost to the sub-tasks; a phase shows their total.', code: 'TASK_COST_PARENT' });
    }
    const resolved = resolveTaskCost({
      costMode: 'costMode' in body ? body.costMode : existingPlain.costMode,
      costAmount: 'costAmount' in body ? body.costAmount : existingPlain.costAmount,
      costRate: 'costRate' in body ? body.costRate : existingPlain.costRate,
      estimatedHours: 'estimatedHours' in body ? body.estimatedHours : existingPlain.estimatedHours,
    });
    if (resolved.error) return refuse(400, { message: resolved.error, code: resolved.code });
    fields = resolved;
    planned = resolved.plannedCost;
  }

  // the plan as it is now, and as it would be after this save
  const dept = 'departmentName' in body ? body.departmentName : existingPlain.departmentName;
  const parentAfter = 'parentTaskId' in body ? body.parentTaskId || null : existingPlain.parentTaskId ?? null;
  const after = tasks.map((t) => ({ ...t }));
  const me = creating ? null : after.find((t) => idStr(t._id) === idStr(existing._id));
  if (me) Object.assign(me, { plannedCost: planned, parentTaskId: parentAfter, departmentName: dept });
  else after.push({ _id: '__new__', plannedCost: planned, parentTaskId: parentAfter, departmentName: dept });
  // a task that gains its first sub-task gives its own cost up to it
  let parentToRelease = null;
  if (gainsParent) {
    const parent = after.find((t) => idStr(t._id) === newParent);
    if (parent && !(tasks.some((t) => idStr(t.parentTaskId) === newParent))) {
      parentToRelease = newParent;
      parent.plannedCost = 0;
    }
  }
  const owner = project.targetDepartment;
  const beforeTotal = rollup(tasks, { ownerDepartment: owner }).planned;
  const afterTotal = rollup(after, { ownerDepartment: owner }).planned;
  const ceiling = planCeiling(project);
  const guard = checkGuard({ before: beforeTotal, after: afterTotal, ceiling });
  if (!guard.held) return { fields, parentToRelease, request: null };

  // ── over the budget, and adding to the plan ──
  if (!increase) {
    const seer = access.canSeeCost;
    return refuse(409, {
      message: seer
        ? `With this the tasks add up to ${money(afterTotal)}, which is ${money(guard.over)} above the ${money(ceiling)} the project has. ${
            access.canEditCost ? 'A budget increase has to be asked of the finance head.' : 'Ask the project manager to raise the budget.'
          }`
        : 'This change would take the project over its approved budget. Ask the project manager to raise the budget first.',
      code: 'TASK_COST_OVER_BUDGET',
      // the amounts only for those who may see money
      ...(seer ? { plan: { planned: afterTotal, ceiling, over: guard.over, approved: project.approvedBudget ?? 0, canRequest: access.canEditCost } } : {}),
    });
  }
  if (!access.canEditCost) {
    return refuse(403, { message: 'Only the project manager, or the head of the owning department, can ask for a budget increase.', code: 'TASK_COST_FORBIDDEN' });
  }
  const amount = increase.amount === undefined || increase.amount === null || increase.amount === '' ? afterTotal : cleanAmount(increase.amount);
  if (amount === null || toPaise(amount) < toPaise(afterTotal)) {
    return refuse(400, { message: `The new budget has to cover the tasks: at least ${money(afterTotal)}.`, code: 'INCREASE_TOO_LOW' });
  }
  const raised = raiseCost({ budget: project.budget, plan: plain(project).costPlan ?? [] }, amount);
  if (raised.error) return refuse(400, { message: raised.error, code: raised.code });
  const cost = { budget: raised.budget, plan: raised.costPlan };
  const check = planCostChange(project, cost, increase.reason);
  if (check.error) return refuse(400, { message: check.error, code: check.code });
  return { fields, parentToRelease, request: { cost, reason: increase.reason, amount: cost.budget } };
};

/// After the task is saved: a task that gained its first sub-task gives its own cost up, and a budget increase is sent to the finance head.
/// → { sent, amount, status } for the response, or null when nothing was sent.
export const finishTaskCost = async ({ project, prepared, user }) => {
  if (prepared.parentToRelease) {
    await ITTask.updateOne(
      { _id: prepared.parentToRelease, $or: [{ costMode: { $ne: '' } }, { plannedCost: { $gt: 0 } }] },
      { $set: { costMode: '', costAmount: 0, costRate: 0, plannedCost: 0 } },
    );
  }
  if (!prepared.request) return null;
  const fresh = (await Project.findById(project._id)) ?? project;
  const sent = await submitCostChange(fresh, prepared.request.cost, { reason: prepared.request.reason, user });
  return { sent: !sent.unchanged && !sent.error, amount: prepared.request.amount, status: fresh.costStatus };
};

/// The cost fields of a task, taken away from anybody who may not see money. Works on one task or a list; a plain copy is returned.
export const COST_FIELDS = ['costMode', 'costAmount', 'costRate', 'plannedCost'];
const strip = (t) => {
  const o = { ...plain(t) };
  for (const k of COST_FIELDS) delete o[k];
  return o;
};

/**
 * Hide the cost fields of tasks from those who may not see money in the task's project. [projectsById] maps a project id to a project
 * object when the caller has them already; the rest are loaded.
 */
export const redactTaskCosts = async (tasks, ctx, projectsById = new Map()) => {
  const list = Array.isArray(tasks) ? tasks : [tasks];
  if (ctx.full) return Array.isArray(tasks) ? list.map(plain) : plain(tasks);
  const ids = [...new Set(list.map((t) => idStr(t.projectId)).filter(Boolean))].filter((id) => !projectsById.has(id));
  if (ids.length) for (const p of await Project.find({ _id: { $in: ids } }).lean()) projectsById.set(String(p._id), p);
  const seen = new Map();
  const mayKnow = (pid) => {
    if (!seen.has(pid)) {
      const p = projectsById.get(pid);
      seen.set(pid, !!p && accessSummary(p, ctx).canSeeCost);
    }
    return seen.get(pid);
  };
  const out = list.map((t) => (mayKnow(idStr(t.projectId)) ? plain(t) : strip(t)));
  return Array.isArray(tasks) ? out : out[0];
};
