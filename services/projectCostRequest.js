import { recordActivity } from '../utils/projectActivity.js';
import { describeCostChange, money } from '../utils/projectCost.js';
import { notifyCostRequest } from './projectNotify.js';
import { supersedeFor } from './decisions.js';

// SENDING A COST (OR A CHANGE TO IT) TO THE FINANCE HEAD — one place, used by "change the project's cost" (controllers/projectController.js
// updateCost) and by the task guardrail (a task plan that goes above the approved budget, services/taskCost.js), so both go the same way:
//
//   - nothing changes → nothing is sent (the finance head is not bothered);
//   - after approval a change needs a reason, is written into the history, and goes back to the finance head — the earlier approved
//     amount stays the limit until it is decided;
//   - the project's budget and breakdown become what is asked for, and its cost is "pending".

const clean = (plan) => (plan ?? []).map((l) => ({ category: l.category, amount: l.amount }));

/**
 * What sending this cost would do, without changing anything: the lines for the history, whether it changes anything, and the problem
 * (if any) that stops it. Use before saving other things that depend on it.
 * @param {object} project  a Project document
 * @param {{ budget: number, plan: Array }} cost  what is asked for
 * @returns {{ unchanged: boolean, lines: string[], status: string, error?: string, code?: string }}
 */
export const planCostChange = (project, cost, reason = '') => {
  const status = project.costStatus ?? 'none';
  const lines = describeCostChange({ budget: project.budget ?? 0, plan: clean(project.costPlan) }, { budget: cost.budget, plan: cost.plan });
  if (lines.length === 0 && (status === 'pending' || status === 'approved')) return { unchanged: true, lines, status };
  if (status === 'approved' && String(reason ?? '').trim().length < 3) {
    return { unchanged: false, lines, status, error: 'Say why the cost is changing.', code: 'CHANGE_NEEDS_REASON' };
  }
  return { unchanged: false, lines, status };
};

/**
 * Send the cost: save it on the project as pending, log the change, take it back from the CEO / Executive Director if it was with
 * them, and tell the finance head. The caller has checked who may do this and that the cost is valid.
 * @returns {{ unchanged: boolean, status: string, resubmit?: boolean, lines: string[], error?: string, code?: string }}
 */
export const submitCostChange = async (project, cost, { reason = '', user }) => {
  const plan = planCostChange(project, cost, reason);
  if (plan.error || plan.unchanged) return plan;
  const { status, lines } = plan;

  const now = new Date();
  if (status === 'approved') {
    // It was approved: a change needs a reason, is logged, and goes back to the finance head. Until it is approved the earlier
    // approved amount stays the limit, so the project is not stopped meanwhile.
    project.costChanges.push({ at: now, byName: user.name ?? '', reason: String(reason).trim().slice(0, 300), lines });
  }
  const resubmit = status !== 'pending';
  project.budget = cost.budget;
  project.costPlan = cost.plan;
  project.costStatus = 'pending';
  if (resubmit) {
    project.costRequestedAt = now;
    project.costDecisionNote = '';
  }
  recordActivity(
    project,
    'cost',
    status === 'approved'
      ? `Cost change to ${money(cost.budget)} sent to the finance head`
      : status === 'pending'
        ? `Estimated cost updated to ${money(cost.budget)}`
        : `Estimated cost ${money(cost.budget)} sent to the finance head for approval`,
    user,
  );
  await project.save();
  // a cost that was with the CEO / Executive Director is not what they were asked about any more: it goes back to the finance head
  if (project.costLeadership?.state === 'awaiting') {
    await supersedeFor('project_budget', project, { user, reason: 'The cost was changed, so the finance head checks it again', force: true });
  }
  if (resubmit && !['proposed', 'cancelled'].includes(project.status)) await notifyCostRequest(project, user, { change: status === 'approved' });
  return { unchanged: false, status, resubmit, lines };
};
