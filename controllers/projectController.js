import Project from '../models/Project.js';
import ITTask from '../models/ITTask.js';
import Department from '../models/Department.js';
import User from '../models/User.js';
import {
  buildProjectScope,
  canViewProject,
  escapeRegex,
  loadAccessContext,
  accessSummary,
  isOwnerHead,
  isProjectManager,
} from '../utils/projectAccess.js';
import { projectProgress, departmentProgress } from '../utils/projectProgress.js';
import { departmentsOf, normalizeDepartments, activeDepartmentNames, eqCI } from '../utils/projectDepartments.js';
import { resolveUserDeptName } from '../utils/departmentScope.js';
import { checkProjectDates } from '../utils/projectDates.js';
import { buildActivityFeed, recordActivity, reminderWaitMs, statusLabel, idOf } from '../utils/projectActivity.js';
import {
  notifyInvited,
  notifyInvitationReminder,
  notifyDepartmentResponse,
  notifyProposal,
  notifyCostRequest,
} from '../services/projectNotify.js';
import { resolveCost, mayStart, describeCostChange, checkDecision, cleanAmount, money, canSeeCostAmounts, spendingLimit } from '../utils/projectCost.js';
import { spendMap, spendFor } from '../services/projectSpend.js';
import { expenseRow } from '../utils/projectSpend.js';
import AdminExpense from '../models/AdminExpense.js';
import { isApprover } from '../utils/departmentScope.js';
import { decideProposal as decideProposalAtomic, applyCostDecision } from '../services/projectDecisions.js';
import { mirrorProposal, settleProposalRequest, escalate, supersedeFor, withdrawFor, getPolicy } from '../services/decisions.js';
import { needsLeadership, budgetIncrease } from '../utils/decisionRules.js';
import { isLeadershipRole, leadershipTitle } from '../utils/leadership.js';

const POPULATE = [
  { path: 'managerId', select: 'name email role category' },
  { path: 'members', select: 'name email role category' },
  { path: 'departments.leadId', select: 'name' },
];

// What a client may set on a project. Everything else — createdBy, progress (worked
// out from the tasks), the proposal / decision fields — is the server's alone. (It
// used to pass the whole request body straight to the database.)
const PROJECT_FIELDS = [
  'name', 'description', 'type', 'client', 'features', 'managerId', 'members', 'status', 'priority',
  'startDate', 'endDate', 'tags', 'budget', 'estimatedValue', 'phase', 'category', 'targetReleaseDate', 'editMode',
  'horizonNumber', 'strategicPillar', 'targetYear',
];
const pick = (obj, keys) => Object.fromEntries(keys.filter((k) => obj && k in obj).map((k) => [k, obj[k]]));

const TASK_FIELDS = 'percentComplete parentTaskId departmentName status assignedTo';

const fail = (res, status, message, extra = {}) => res.status(status).json({ message, ...extra });

/// The project as the app receives it: progress worked out from the tasks (overall
/// and per department), departments with the legacy single department filled in,
/// and what THIS caller may do on it.
const decorate = (doc, tasks, ctx, spend = null) => {
  // the stored activity is raw material for the feed (see decorateOne), not something a list needs to carry
  const { activity: _stored, budget, estimatedValue, approvedBudget, costPlan, costChanges, costDecisionNote, ...project } =
    typeof doc.toObject === 'function' ? doc.toObject() : { ...doc };
  const departments = departmentsOf(project).map((d) => ({ ...d }));
  const hasTask = !!ctx.empId && tasks.some((t) => String(t.assignedTo ?? '') === ctx.empId);
  const access = accessSummary({ ...project, budget, approvedBudget }, ctx, { hasTask });
  return {
    ...project,
    // everyone who can open the project sees where its cost stands; only those who run it, finance and the overseers see the money
    costStatus: project.costStatus ?? 'none',
    cost: access.canSeeCost
      ? {
          budget: budget ?? 0,
          approvedBudget: approvedBudget ?? 0,
          estimatedValue: estimatedValue ?? 0,
          plan: costPlan ?? [],
          // what has been charged to the project: approved (spent) and waiting for approval (committed)
          spent: spend?.spent ?? 0,
          committed: spend?.committed ?? 0,
          note: costDecisionNote ?? '',
          changes: [...(costChanges ?? [])].slice(-20).reverse(),
        }
      : null,
    departments,
    progress: projectProgress(tasks),
    totalTasks: tasks.length,
    completedTasks: tasks.filter(
      (t) =>
        ['completed', 'closed', 'deployed', 'done'].includes(String(t.status ?? '').toLowerCase().trim()) ||
        Number(t.percentComplete) >= 100,
    ).length,
    departmentProgress: departmentProgress(
      tasks,
      activeDepartmentNames({ ...project, departments }),
      project.targetDepartment,
    ),
    access,
  };
};

/// One project for its own screen: the above plus its activity feed (who did what, when).
const decorateOne = async (doc, tasks, ctx) => {
  const spend = (await spendMap([(doc._id ?? doc.id)])).get(String(doc._id ?? doc.id)) ?? null;
  const project = typeof doc.toObject === 'function' ? doc.toObject() : doc;
  const ids = new Set([project.createdBy, ...(project.departments ?? []).map((d) => d.respondedBy)].map(idOf).filter(Boolean));
  const users = ids.size ? await User.find({ _id: { $in: [...ids] } }).select('name').lean() : [];
  const names = new Map(users.map((u) => [String(u._id), u.name]));
  return { ...decorate(doc, tasks, ctx, spend), activity: buildActivityFeed(project, (id) => names.get(idOf(id)) ?? '') };
};

/// The real department a name refers to (right spelling), or null.
const findDepartment = async (name) =>
  Department.findOne({ name: new RegExp(`^${escapeRegex(String(name || '').trim())}$`, 'i'), active: { $ne: false } })
    .select('name')
    .lean();

/// Participants must be real departments (they have a head who answers).
const canonicalParticipants = async (requested) => {
  const out = [];
  for (const r of requested ?? []) {
    const name = typeof r === 'string' ? r : r?.name;
    if (!String(name ?? '').trim()) continue;
    const dept = await findDepartment(name);
    if (!dept) return { error: `"${String(name).trim()}" is not a department.` };
    out.push({ name: dept.name, leadId: typeof r === 'object' ? r.leadId ?? null : null });
  }
  return { list: out };
};

const loadOne = async (id) => {
  const doc = await Project.findById(id).populate(POPULATE);
  if (!doc) return null;
  const tasks = await ITTask.find({ projectId: doc._id }).select(TASK_FIELDS).lean();
  return { doc, tasks };
};

export const getProjects = async (req, res) => {
  try {
    const { status, priority, search, department, ownerOnly } = req.query;

    // Department-scoped visibility (see utils/projectAccess.js). Any signed-in
    // user may call — they simply get the projects they're allowed to see.
    const and = [await buildProjectScope(req.user)];
    if (status && status !== 'all') and.push({ status });
    if (priority && priority !== 'all') and.push({ priority });
    if (search) and.push({ name: { $regex: escapeRegex(search), $options: 'i' } });
    if (department && department !== 'all') {
      const re = new RegExp(`^${escapeRegex(department)}$`, 'i');
      // "Involves this department": it owns the project or is on it (not declined).
      // ownerOnly=1 is the old meaning — the IT screens use it to stay IT's own.
      and.push(
        ownerOnly === '1' || ownerOnly === 'true'
          ? { targetDepartment: re }
          : { $or: [{ targetDepartment: re }, { departments: { $elemMatch: { name: re, status: { $ne: 'declined' } } } }] },
      );
    }

    const projects = await Project.aggregate([
      { $match: { $and: and } },
      {
        $lookup: {
          from: 'ittasks',
          let: { pid: '$_id' },
          pipeline: [{ $match: { $expr: { $eq: ['$projectId', '$$pid'] } } }, { $project: { percentComplete: 1, parentTaskId: 1, departmentName: 1, status: 1, assignedTo: 1 } }],
          as: 'tasks',
        },
      },
      { $sort: { createdAt: -1 } },
    ]);

    const ctx = await loadAccessContext(req.user);
    const populated = await Project.populate(
      projects.map(({ tasks, ...p }) => p),
      POPULATE,
    );
    const byId = new Map(projects.map((p) => [String(p._id), p.tasks]));
    const spends = await spendMap(populated.map((p) => p._id));
    res.json(populated.map((p) => decorate(p, byId.get(String(p._id)) ?? [], ctx, spends.get(String(p._id)) ?? null)));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const getProjectById = async (req, res) => {
  try {
    const found = await loadOne(req.params.id);
    if (!found) return fail(res, 404, 'Project not found');
    const ctx = await loadAccessContext(req.user);
    if (!(await canViewProject(req.user, found.doc, ctx))) {
      return fail(res, 403, 'Access denied: you cannot view this project');
    }
    res.json(await decorateOne(found.doc, found.tasks, ctx));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const createProject = async (req, res) => {
  try {
    const ctx = await loadAccessContext(req.user);
    const body = pick(req.body, PROJECT_FIELDS);
    // Every project says what it is expected to cost; the finance head approves it before anything is spent or the project starts.
    const cost = resolveCost({ budget: req.body.budget, costPlan: req.body.costPlan });
    if (cost.error) return fail(res, 400, cost.error, { code: cost.code });
    Object.assign(body, {
      budget: cost.budget,
      costPlan: cost.plan,
      costStatus: 'pending',
      costRequestedAt: new Date(),
      approvedBudget: 0,
      estimatedValue: cleanAmount(body.estimatedValue) ?? 0,
    });
    // The start and end decide whether it is a mini, moderate or main project — they must make sense.
    const dates = checkProjectDates(body);
    if (dates.error) return fail(res, 400, dates.error);
    Object.assign(body, dates);
    let owner = String(req.body.targetDepartment ?? '').trim();
    let actorDept = ctx.deptName;

    if (ctx.full) {
      // an administrator / coordinator: any department
    } else if (ctx.isHead) {
      // A department head creates for their OWN department.
      if (ctx.deptName) owner = ctx.deptName;
    } else {
      // Anyone else PROPOSES: it waits for the owning department's head (or an
      // admin) to approve, and the proposer is its manager until then.
      if (!ctx.empId) return fail(res, 400, 'Link your employee profile to propose a project.');
      if (!owner) return fail(res, 400, 'Choose the department this project belongs to.');
      body.status = 'proposed';
      body.managerId = ctx.empId;
      body.proposedBy = req.user._id;
      actorDept = actorDept || (await resolveUserDeptName(req.user));
    }
    if (!owner) return fail(res, 400, 'Choose the department this project belongs to.');
    if (!body.managerId) return fail(res, 400, 'Choose a project manager.');
    // It can be planned, but it does not start before its cost is approved.
    if (!mayStart(body.costStatus) && body.status === 'active') body.status = 'planning';

    const canonicalOwner = (await findDepartment(owner))?.name ?? owner;
    const asked = await canonicalParticipants(req.body.departments);
    if (asked.error) return fail(res, 400, asked.error);
    const { departments, added } = normalizeDepartments({
      requested: asked.list,
      existing: [],
      ownerName: canonicalOwner,
      actorDept,
    });

    const project = await Project.create({
      ...body,
      targetDepartment: canonicalOwner,
      departments,
      editMode: body.editMode === 'open' ? 'open' : 'managed', // new projects: the manager decides
      createdBy: req.user._id,
    });

    recordActivity(project, 'cost', `Estimated cost ${money(project.budget)} sent to the finance head for approval`, req.user);
    await project.save();

    // A proposal goes to its department head first; the finance head hears about it once the head has approved.
    if (project.status === 'proposed') {
      await notifyProposal(project, req.user);
      // the CEO / Executive Director see it on their desk too (nothing is held: the department head still decides in parallel)
      try {
        await mirrorProposal(project);
      } catch (err) {
        console.error('[decisions] could not show the proposal to the leaders:', err.message);
      }
    } else await notifyCostRequest(project, req.user);
    await notifyInvited(project, added, req.user);

    const found = await loadOne(project._id);
    res.status(201).json(await decorateOne(found.doc, found.tasks, ctx));
  } catch (error) {
    res.status(error.name === 'ValidationError' ? 400 : 500).json({ message: error.message });
  }
};

export const updateProject = async (req, res) => {
  try {
    const found = await loadOne(req.params.id);
    if (!found) return fail(res, 404, 'Project not found');
    const existing = found.doc;
    const ctx = await loadAccessContext(req.user);

    const manage = ctx.full || isProjectManager(existing, ctx) || isOwnerHead(existing, ctx);
    if (!manage) return fail(res, 403, 'You cannot edit this project');

    const changes = pick(req.body, PROJECT_FIELDS);
    const dates = checkProjectDates(changes, existing);
    if (dates.error) return fail(res, 400, dates.error);
    Object.assign(changes, dates);
    // A proposal changes status only through approve / reject.
    if (existing.status === 'proposed') delete changes.status;
    // The cost changes only through PUT /:id/cost (logged, and back to the finance head) — never as a side effect of a save.
    delete changes.budget;
    if ('estimatedValue' in changes) {
      const v = cleanAmount(changes.estimatedValue);
      if (v === null) delete changes.estimatedValue;
      else changes.estimatedValue = v;
    }
    if (changes.status === 'active' && existing.status !== 'active' && !mayStart(existing.costStatus)) {
      return fail(
        res,
        409,
        existing.costStatus === 'returned'
          ? 'The finance head sent this project\'s cost back. Revise it and send it again before starting the project.'
          : 'The finance head has not approved this project\'s cost yet, so it cannot start.',
        { code: 'BUDGET_NOT_APPROVED' },
      );
    }

    // Moving a project to another owning department is an administrator's call.
    let owner = existing.targetDepartment;
    if (req.body.targetDepartment !== undefined) {
      const wanted = String(req.body.targetDepartment ?? '').trim();
      if (wanted && !eqCI(wanted, existing.targetDepartment)) {
        if (!ctx.full) return fail(res, 403, 'Only an administrator can move a project to another department.');
        owner = (await findDepartment(wanted))?.name ?? wanted;
      }
    }

    // Departments: who is on the project.
    let added = [];
    let departments = departmentsOf(existing);
    if (req.body.departments !== undefined || !eqCI(owner, existing.targetDepartment)) {
      const asked = await canonicalParticipants(req.body.departments ?? departments.filter((d) => d.role !== 'owner'));
      if (asked.error) return fail(res, 400, asked.error);
      const actorDept = ctx.deptName || (await resolveUserDeptName(req.user));
      const next = normalizeDepartments({
        requested: asked.list,
        existing: departments,
        ownerName: owner,
        actorDept,
      });
      // A department with tasks cannot just be dropped: those tasks would lose their owner.
      for (const name of next.removed) {
        const n = await ITTask.countDocuments({
          projectId: existing._id,
          departmentName: new RegExp(`^${escapeRegex(name)}$`, 'i'),
        });
        if (n > 0) {
          return fail(res, 409, `${name} still has ${n} task${n === 1 ? '' : 's'} on this project. Move them to another department first.`, { code: 'DEPARTMENT_HAS_TASKS' });
        }
      }
      departments = next.departments;
      added = next.added;
    }

    const wasStatus = existing.status;
    existing.set({ ...changes, targetDepartment: owner, departments });
    if (changes.status && changes.status !== wasStatus) {
      recordActivity(existing, 'status', `Project moved to ${statusLabel(changes.status)}`, req.user);
    }
    await existing.save();

    await notifyInvited(existing, added, req.user);
    const fresh = await loadOne(existing._id);
    res.json(await decorateOne(fresh.doc, fresh.tasks, ctx));
  } catch (error) {
    res.status(error.name === 'ValidationError' ? 400 : 500).json({ message: error.message });
  }
};

// @desc    A department answers its invitation to a project
// @route   POST /api/projects/:id/departments/:name/respond   { accept: boolean }
export const respondToInvitation = async (req, res) => {
  try {
    const found = await loadOne(req.params.id);
    if (!found) return fail(res, 404, 'Project not found');
    const project = found.doc;
    const ctx = await loadAccessContext(req.user);

    const name = String(req.params.name || '').trim();
    const entry = project.departments.find((d) => eqCI(d.name, name));
    if (!entry || entry.role === 'owner') return fail(res, 404, `${name} is not an invited department on this project.`);

    // The department's head answers for it (an administrator may too).
    const isItsHead = ctx.isHead && !!ctx.deptName && eqCI(ctx.deptName, entry.name);
    if (!ctx.full && !isItsHead) return fail(res, 403, `Only the head of ${entry.name} can answer this invitation.`);
    if (typeof req.body?.accept !== 'boolean') return fail(res, 400, 'Say whether you accept (true) or decline (false).');

    entry.status = req.body.accept ? 'accepted' : 'declined';
    entry.respondedAt = new Date();
    entry.respondedBy = req.user._id;
    await project.save();

    await notifyDepartmentResponse(project, entry.name, req.body.accept, req.user);
    const fresh = await loadOne(project._id);
    res.json(await decorateOne(fresh.doc, fresh.tasks, ctx));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    The manager nudges a department whose head has not answered its invitation yet
// @route   POST /api/projects/:id/departments/:name/resend
export const resendInvitation = async (req, res) => {
  try {
    const found = await loadOne(req.params.id);
    if (!found) return fail(res, 404, 'Project not found');
    const project = found.doc;
    const ctx = await loadAccessContext(req.user);
    if (!(ctx.full || isProjectManager(project, ctx) || isOwnerHead(project, ctx))) {
      return fail(res, 403, 'Only the project manager or the head of the owning department can resend an invitation.');
    }

    const name = String(req.params.name || '').trim();
    const entry = project.departments.find((d) => eqCI(d.name, name));
    if (!entry || entry.role === 'owner') return fail(res, 404, `${name} is not an invited department on this project.`);
    if (entry.status !== 'invited') {
      return fail(res, 409, `${entry.name} has already ${entry.status === 'accepted' ? 'joined' : 'declined'} this project.`);
    }
    const wait = reminderWaitMs(entry.remindedAt);
    if (wait > 0) {
      const mins = Math.ceil(wait / 60000);
      return fail(res, 429, `${entry.name} was reminded a moment ago. You can remind them again in ${mins} minute${mins === 1 ? '' : 's'}.`, { code: 'REMINDED_RECENTLY' });
    }

    entry.remindedAt = new Date();
    recordActivity(project, 'reminder', `Reminder sent to ${entry.name}`, req.user);
    await project.save();

    await notifyInvitationReminder(project, entry.name, req.user);
    const fresh = await loadOne(project._id);
    res.json(await decorateOne(fresh.doc, fresh.tasks, ctx));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

/// 409 for a proposal somebody has decided already: who, what, when, why.
const alreadyDecided = async (res, project) => {
  const by = project.decidedBy ? await User.findById(project.decidedBy).select('name role').lean() : null;
  const verb = project.status === 'cancelled' ? 'not approved' : project.status === 'proposed' ? 'still waiting' : 'approved';
  const who = by ? ` by ${by.name}${isLeadershipRole(by.role) ? ` (${leadershipTitle(by.role)})` : ''}` : '';
  const note = String(project.decisionNote ?? '').trim();
  return fail(res, 409, by ? `Already ${verb}${who}${note ? `: “${note}”` : '.'}` : 'This project is not waiting for a decision.', {
    code: by ? 'ALREADY_DECIDED' : 'NOT_WAITING',
    decision: by ? { by: { id: String(by._id), name: by.name, role: by.role }, at: project.decidedAt ?? null, note, outcome: verb } : null,
  });
};

const decide = (approve) => async (req, res) => {
  try {
    const found = await loadOne(req.params.id);
    if (!found) return fail(res, 404, 'Project not found');
    const project = found.doc;
    const ctx = await loadAccessContext(req.user);

    if (project.status !== 'proposed') return alreadyDecided(res, project);
    if (!ctx.full && !isOwnerHead(project, ctx)) {
      return fail(res, 403, `Only the head of ${project.targetDepartment} or an administrator can decide on this proposal.`);
    }

    // one decision wins: if a department head and a leader click together, the second gets the 409 below
    const decided = await decideProposalAtomic(project._id, { approve, note: req.body?.note, user: req.user });
    if (!decided) return alreadyDecided(res, (await Project.findById(project._id)) ?? project);
    try {
      await settleProposalRequest(decided, { approve, user: req.user, note: decided.decisionNote });
    } catch (err) {
      console.error('[decisions] could not close the leaders\' request:', err.message); // the repair sweep closes it
    }
    const fresh = await loadOne(project._id);
    res.json(await decorateOne(fresh.doc, fresh.tasks, ctx));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const approveProject = decide(true);
export const rejectProject = decide(false);

// @desc    Change a project's estimated cost (a new cost, a revised one, or a change after approval)
// @route   PUT /api/projects/:id/cost   { budget?, costPlan?, reason? }
export const updateCost = async (req, res) => {
  try {
    const found = await loadOne(req.params.id);
    if (!found) return fail(res, 404, 'Project not found');
    const project = found.doc;
    const ctx = await loadAccessContext(req.user);
    if (ctx.viewOnly || !(ctx.full || isProjectManager(project, ctx) || isOwnerHead(project, ctx))) {
      return fail(res, 403, 'Only the project manager or the head of the owning department can change the cost.');
    }

    const cost = resolveCost({ budget: req.body?.budget, costPlan: req.body?.costPlan });
    if (cost.error) return fail(res, 400, cost.error, { code: cost.code });

    const status = project.costStatus ?? 'none';
    const before = { budget: project.budget ?? 0, plan: (project.costPlan ?? []).map((l) => ({ category: l.category, amount: l.amount })) };
    const lines = describeCostChange(before, { budget: cost.budget, plan: cost.plan });
    // Nothing to change: leave it where it is (and do not bother the finance head).
    if (lines.length === 0 && (status === 'pending' || status === 'approved')) {
      return res.json(await decorateOne(project, found.tasks, ctx));
    }

    const now = new Date();
    if (status === 'approved') {
      // It was approved: a change needs a reason, is logged, and goes back to the finance head. Until it is approved the
      // earlier approved amount stays the limit, so the project is not stopped meanwhile.
      const reason = String(req.body?.reason ?? '').trim().slice(0, 300);
      if (reason.length < 3) return fail(res, 400, 'Say why the cost is changing.', { code: 'CHANGE_NEEDS_REASON' });
      project.costChanges.push({ at: now, byName: req.user.name ?? '', reason, lines });
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
      req.user,
    );
    await project.save();
    // a cost that was with the CEO / Executive Director is not what they were asked about any more: it goes back to the finance head
    if (project.costLeadership?.state === 'awaiting') {
      await supersedeFor('project_budget', project, { user: req.user, reason: 'The cost was changed, so the finance head checks it again', force: true });
    }

    if (resubmit && !['proposed', 'cancelled'].includes(project.status)) await notifyCostRequest(project, req.user, { change: status === 'approved' });
    const fresh = await loadOne(project._id);
    res.json(await decorateOne(fresh.doc, fresh.tasks, ctx));
  } catch (error) {
    res.status(error.name === 'ValidationError' ? 400 : 500).json({ message: error.message });
  }
};

// @desc    The finance head approves a project's cost (as asked, or a different amount) or sends it back
// @route   POST /api/projects/:id/cost/decision   { decision: 'approve' | 'return', approvedAmount?, note? }
export const decideCost = async (req, res) => {
  try {
    const found = await loadOne(req.params.id);
    if (!found) return fail(res, 404, 'Project not found');
    const project = found.doc;
    const ctx = await loadAccessContext(req.user);
    if (!ctx.financeHead) return fail(res, 403, 'Only the finance head can decide on a project\'s cost.');
    if ((project.costStatus ?? 'none') !== 'pending') return fail(res, 409, 'This project\'s cost is not waiting for a decision.', { code: 'NOT_WAITING' });
    if (project.status === 'cancelled') return fail(res, 409, 'This project was cancelled, so its cost needs no decision.', { code: 'PROJECT_CANCELLED' });
    if (project.status === 'proposed') {
      return fail(res, 409, `The head of ${project.targetDepartment} has to approve the project itself first.`, { code: 'PROPOSAL_FIRST' });
    }
    // Nobody signs off a cost they asked for themselves (an administrator can).
    const isAdmin = String(req.user.role ?? '').toLowerCase() === 'admin';
    if (!isAdmin && String(project.createdBy ?? '') === String(req.user._id)) {
      return fail(res, 403, 'You asked for this cost yourself, so someone else has to approve it.', { code: 'OWN_REQUEST' });
    }

    const decision = checkDecision(req.body ?? {}, project.budget ?? 0);
    if (decision.error) return fail(res, 400, decision.error, { code: decision.code });

    const approve = decision.decision === 'approve';

    // With the CEO / Executive Director already: it cannot be approved twice; sending it back takes it off their desk.
    if (project.costLeadership?.state === 'awaiting') {
      if (approve) return fail(res, 409, 'This cost is already with the CEO / Executive Director.', { code: 'AWAITING_LEADERSHIP' });
      await withdrawFor('project_budget', project._id, { user: req.user, reason: 'The finance head sent it back' });
    }
    // Above the limit set in Decision rules: the finance head's approval is the CHECK; the CEO / Executive Director decides.
    if (approve) {
      const increase = budgetIncrease({ proposed: decision.amount, previousApproved: spendingLimit(project) });
      if (needsLeadership(await getPolicy(), 'project_budget', increase)) {
        const held = await escalate({
          kind: 'project_budget',
          source: project,
          checker: req.user,
          checkNote: decision.note,
          payload: { amount: decision.amount, note: decision.note, increase },
        });
        if (held.escalated) {
          const stamped = await Project.findById(project._id);
          recordActivity(stamped, 'cost', `Cost ${money(decision.amount)} checked by the finance head and sent to the CEO / Executive Director`, req.user);
          await stamped.save();
          const fresh = await loadOne(project._id);
          return res.json(await decorateOne(fresh.doc, fresh.tasks, ctx));
        }
      }
    }

    await applyCostDecision(project, { approve, amount: decision.amount, note: decision.note, user: req.user });
    const fresh = await loadOne(project._id);
    res.json(await decorateOne(fresh.doc, fresh.tasks, ctx));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Projects whose cost waits for the finance head (a proposal the department head has not decided is not yet)
// @route   GET /api/projects/cost/pending
export const getPendingCosts = async (req, res) => {
  try {
    const ctx = await loadAccessContext(req.user);
    if (!ctx.finance) return fail(res, 403, 'Only Finance can see the projects waiting for a cost decision.');
    const projects = await Project.find({ costStatus: 'pending', status: { $nin: ['proposed', 'cancelled'] } })
      .populate({ path: 'managerId', select: 'name' })
      .sort({ costRequestedAt: 1 })
      .lean();
    const creators = await User.find({ _id: { $in: projects.map((p) => p.createdBy).filter(Boolean) } }).select('name').lean();
    const nameOf = new Map(creators.map((u) => [String(u._id), u.name]));
    res.json(
      projects.map((p) => {
        const last = (p.costChanges ?? []).slice(-1)[0] ?? null;
        return {
          id: String(p._id),
          name: p.name,
          department: p.targetDepartment,
          status: p.status,
          managerName: p.managerId?.name ?? '',
          requestedByName: last?.byName || nameOf.get(String(p.createdBy)) || '',
          requestedAt: p.costRequestedAt ?? p.createdAt,
          startDate: p.startDate ?? null,
          endDate: p.endDate ?? null,
          budget: p.budget ?? 0,
          approvedBudget: p.approvedBudget ?? 0,
          plan: p.costPlan ?? [],
          // a change after approval, with the reason given
          isChange: (p.approvedBudget ?? 0) > 0,
          changeReason: last?.reason ?? '',
          changeLines: last?.lines ?? [],
          canDecide: !!ctx.financeHead,
        };
      }),
    );
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    What a project has spent against its approved cost: spent, committed, what is left, by head / department / month,
//          and the latest expenses charged to it
// @route   GET /api/projects/:id/spend
export const getProjectSpend = async (req, res) => {
  try {
    const found = await loadOne(req.params.id);
    if (!found) return fail(res, 404, 'Project not found');
    const project = found.doc;
    const ctx = await loadAccessContext(req.user);
    if (!(await canViewProject(req.user, project, ctx)) && !ctx.finance) return fail(res, 403, 'Access denied: you cannot view this project');
    const access = accessSummary(project, ctx);
    if (!access.canSeeCost && !ctx.finance) return fail(res, 403, 'Only those who run the project and Finance can see what it has spent.');
    const summary = await spendFor(project);
    const recent = await AdminExpense.find({ projectId: project._id })
      .sort({ date: -1, createdAt: -1 })
      .limit(50)
      .populate({ path: 'createdBy', select: 'name' })
      .lean();
    res.json({ ...summary, expenses: recent.map(expenseRow) });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    The projects an expense can be charged to by this person: their cost is approved and the project is not a
//          proposal or cancelled; Accounts and administrators may charge any, everyone else the projects they are on
// @route   GET /api/projects/chargeable
export const getChargeableProjects = async (req, res) => {
  try {
    const ctx = await loadAccessContext(req.user);
    const scope = isApprover(req.user) || ctx.full ? {} : await buildProjectScope(req.user);
    const projects = await Project.find({ $and: [scope, { status: { $nin: ['proposed', 'cancelled'] }, approvedBudget: { $gt: 0 } }] })
      .select('name targetDepartment status managerId approvedBudget budget costStatus')
      .sort({ name: 1 })
      .limit(300)
      .lean();
    const spends = await spendMap(projects.map((p) => p._id));
    res.json(
      projects.map((p) => {
        const sp = spends.get(String(p._id)) ?? { spent: 0, committed: 0 };
        const limit = spendingLimit(p);
        const used = Math.round((sp.spent + sp.committed) * 100) / 100;
        const level = limit <= 0 ? 'none' : used > limit ? 'over' : used * 100 >= limit * 80 ? 'warn' : 'ok';
        const mayKnow = canSeeCostAmounts({
          full: ctx.full,
          manager: isProjectManager(p, ctx),
          ownerHead: isOwnerHead(p, ctx),
          finance: ctx.finance,
        });
        return {
          id: String(p._id),
          name: p.name,
          department: p.targetDepartment,
          status: p.status,
          level,
          // the amounts only for those who may see money
          ...(mayKnow ? { limit, used, available: Math.round((limit - used) * 100) / 100 } : {}),
        };
      }),
    );
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const deleteProject = async (req, res) => {
  try {
    const project = await Project.findById(req.params.id);
    if (!project) return fail(res, 404, 'Project not found');

    const ctx = await loadAccessContext(req.user);
    if (!(ctx.full || isProjectManager(project, ctx) || isOwnerHead(project, ctx))) {
      return fail(res, 403, 'You cannot delete this project');
    }

    await project.deleteOne();
    // Cascade: remove the project's tasks so they aren't orphaned.
    await ITTask.deleteMany({ projectId: req.params.id });
    for (const kind of ['project_proposal', 'project_budget']) {
      await withdrawFor(kind, project._id, { user: req.user, reason: 'The project was deleted' }).catch(() => null);
    }
    res.json({ message: 'Project deleted' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

