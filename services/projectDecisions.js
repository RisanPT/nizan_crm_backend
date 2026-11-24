import Project from '../models/Project.js';
import { recordActivity } from '../utils/projectActivity.js';
import { money } from '../utils/projectCost.js';
import { notifyDecision, notifyCostRequest, notifyCostDecision } from './projectNotify.js';
import { afterSpendChange } from './projectSpend.js';

// Deciding on a project — shared by the project screens (the department head, an administrator) and by the leadership decision
// workflow (services/decisions.js), so both end the same way.

/**
 * Approve (→ planning) or reject (→ cancelled) a PROPOSED project. Atomic: only a project still `proposed` is changed, so two deciders
 * cannot both win. → the project, or null when it was not waiting any more.
 */
export const decideProposal = async (projectId, { approve, note = '', user }) => {
  const at = new Date();
  const project = await Project.findOneAndUpdate(
    { _id: projectId, status: 'proposed' },
    { $set: { status: approve ? 'planning' : 'cancelled', decidedBy: user._id, decidedAt: at, decisionNote: String(note ?? '').trim().slice(0, 500) } },
    { new: true },
  );
  if (!project) return null;
  recordActivity(project, 'decision', approve ? 'Project approved' : 'Project not approved', user, at);
  await project.save();
  await notifyDecision(project, approve, user);
  if (approve && project.costStatus === 'pending') await notifyCostRequest(project, user);
  return project;
};

/**
 * Record a decision on a project's cost: approved (the amount becomes the limit spending is held against) or sent back. The caller
 * has checked who may decide; this writes it down, tells the people running the project and re-reads what has been spent.
 */
export const applyCostDecision = async (project, { approve, amount = 0, note = '', user }) => {
  project.costStatus = approve ? 'approved' : 'returned';
  if (approve) project.approvedBudget = amount;
  project.costDecidedBy = user._id;
  project.costDecidedByName = user.name ?? '';
  project.costDecidedAt = new Date();
  project.costDecisionNote = String(note ?? '');
  recordActivity(
    project,
    'cost',
    approve ? `Cost approved: ${money(amount)}${amount !== project.budget ? ` (asked ${money(project.budget)})` : ''}` : 'Cost sent back for changes',
    user,
  );
  await project.save();
  await notifyCostDecision(project, approve, user);
  if (approve) await afterSpendChange(project);
  return project;
};
