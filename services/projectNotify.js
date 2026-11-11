import Department from '../models/Department.js';
import { notify, notifyRoles, NOTIFICATION_TYPES, getUserIdsByEmployeeIds } from '../utils/notify.js';
import { money } from '../utils/projectCost.js';
import { escapeRegex } from '../utils/projectAccess.js';

// Company Projects' people-to-people events. Best effort (notify() never throws),
// and — like every notification — never delivered to an admin account (admins only
// get the month-end summary).

const link = (project) => `/projects/${project._id}`;

/// Login accounts to tell for a department: its head, plus the person named as the
/// department's lead on the project, when there is one.
const departmentPeople = async (name, leadId = null) => {
  const dept = await Department.findOne({ name: new RegExp(`^${escapeRegex(name)}$`, 'i'), active: { $ne: false } })
    .select('head')
    .lean();
  return getUserIdsByEmployeeIds([dept?.head, leadId].filter(Boolean));
};

/// The project manager, and whoever created the project.
const projectOwners = async (project) => {
  const managers = await getUserIdsByEmployeeIds([project.managerId?._id ?? project.managerId].filter(Boolean));
  return [...managers, project.createdBy].filter(Boolean);
};

/// Departments just invited: tell each one's head.
export const notifyInvited = async (project, departmentNames, actor) => {
  for (const name of departmentNames) {
    const entry = (project.departments || []).find((d) => d.name.toLowerCase() === name.toLowerCase());
    await notify({
      recipients: await departmentPeople(name, entry?.leadId),
      type: NOTIFICATION_TYPES.PROJECT_INVITE,
      title: `${name} is invited to a project`,
      body: `${project.name} — ${project.targetDepartment} is asking ${name} to take part. Open it to accept or decline.`,
      link: link(project),
      createdBy: actor?._id ?? null,
      excludeUserId: actor?._id ?? null,
    });
  }
};

/// The manager nudges a department whose head has not answered yet.
export const notifyInvitationReminder = async (project, departmentName, actor) => {
  const entry = (project.departments || []).find((d) => d.name.toLowerCase() === departmentName.toLowerCase());
  return notify({
    recipients: await departmentPeople(departmentName, entry?.leadId),
    type: NOTIFICATION_TYPES.PROJECT_INVITE,
    title: `Reminder: ${departmentName} is waiting to answer a project invitation`,
    body: `${project.name} — ${project.targetDepartment} is still waiting for ${departmentName} to accept or decline. Open it to answer.`,
    link: link(project),
    createdBy: actor?._id ?? null,
    excludeUserId: actor?._id ?? null,
  });
};

/// A department accepted or declined: tell the project manager.
export const notifyDepartmentResponse = async (project, departmentName, accepted, actor) =>
  notify({
    recipients: await projectOwners(project),
    type: NOTIFICATION_TYPES.PROJECT_RESPONSE,
    title: `${departmentName} ${accepted ? 'joined' : 'declined'} ${project.name}`,
    body: accepted ? `${departmentName} can now be given tasks on this project.` : `${departmentName} will not take part. You can invite another department or ask again.`,
    link: link(project),
    createdBy: actor?._id ?? null,
    excludeUserId: actor?._id ?? null,
  });

/// A staff proposal: tell the owning department's head, who approves it.
export const notifyProposal = async (project, actor) =>
  notify({
    recipients: await departmentPeople(project.targetDepartment),
    type: NOTIFICATION_TYPES.PROJECT_PROPOSAL,
    title: `New project proposal: ${project.name}`,
    body: `${actor?.name ?? 'A colleague'} proposed a project for ${project.targetDepartment}. Approve or reject it in Company Projects.`,
    link: link(project),
    createdBy: actor?._id ?? null,
    excludeUserId: actor?._id ?? null,
  });

/// The decision on a proposal: tell whoever proposed it.
export const notifyDecision = async (project, approved, actor) =>
  notify({
    recipients: [project.proposedBy, project.createdBy].filter(Boolean),
    type: NOTIFICATION_TYPES.PROJECT_DECISION,
    title: `${project.name} was ${approved ? 'approved' : 'not approved'}`,
    body: approved ? 'You can start planning it.' : project.decisionNote || 'The proposal was not approved.',
    link: link(project),
    createdBy: actor?._id ?? null,
    excludeUserId: actor?._id ?? null,
  });

/// A project's cost is waiting for the finance head (a new project, a revised one, or a change after approval).
export const notifyCostRequest = async (project, actor, { change = false } = {}) =>
  notifyRoles({
    roles: ['finance_head'],
    type: NOTIFICATION_TYPES.PROJECT_COST_REQUEST,
    title: change ? `Budget change waiting: ${project.name}` : `Project budget waiting for approval: ${project.name}`,
    body: `${project.targetDepartment} asks for ${money(project.budget)}${change && project.approvedBudget > 0 ? ` (approved so far: ${money(project.approvedBudget)})` : ''}. Open Project budgets to decide.`,
    link: '/project-budgets',
    createdBy: actor?._id ?? null,
    excludeUserId: actor?._id ?? null,
  });

/// The finance head approved the cost (maybe a different amount) or sent it back: tell whoever runs the project.
export const notifyCostDecision = async (project, approved, actor) =>
  notify({
    recipients: [...(await projectOwners(project)), project.proposedBy],
    type: NOTIFICATION_TYPES.PROJECT_COST_DECISION,
    title: approved ? `Budget approved: ${project.name}` : `Budget sent back: ${project.name}`,
    body: approved
      ? `${money(project.approvedBudget)} approved${project.costDecisionNote ? ` — ${project.costDecisionNote}` : ''}. You can start the project.`
      : `${project.costDecisionNote || 'Please revise the estimated cost.'} Update it and send it again.`,
    link: link(project),
    createdBy: actor?._id ?? null,
    excludeUserId: actor?._id ?? null,
  });

