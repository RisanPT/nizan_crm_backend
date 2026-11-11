import asyncHandler from 'express-async-handler';
import OKR from '../models/OKR.js';
import Employee from '../models/Employee.js';
import {
  canViewOKR,
  canManageOKR,
  canCheckInOKR,
  accessForOKRs,
  filterViewableOKRs,
  isCompanyOKRDept,
  levelOf,
} from '../utils/okrAccess.js';
import { escapeRegex } from '../utils/projectAccess.js';
import { objectiveProgress } from '../utils/okrProgress.js';

// An objective as the app receives it: its level spelled out, its progress worked out
// from its key results when it has any (so a document saved before this, with a typed
// number, still reads right), and what THIS caller may do to it.
const present = (okr, access) => {
  const o = typeof okr.toObject === 'function' ? okr.toObject() : { ...okr };
  return { ...o, level: levelOf(o), progress: objectiveProgress(o.keyResults, o.progress), ...(access ? { access } : {}) };
};

/// present() for one objective, with the caller's access filled in.
const presentFor = async (user, okr) => {
  const acc = await accessForOKRs(user, [okr]);
  return present(okr, acc.get(String(okr._id)));
};

/// How many reports a key result remembers (the oldest drop off).
const MAX_CHECK_INS = 100;

/// Key results arriving from the app: the log of check-ins is the server's alone, so
/// whatever the client sends for it is dropped, and a key result that already exists
/// keeps the history it had.
const withHistory = (incoming, existing = []) => {
  const prior = new Map((existing ?? []).map((k) => [k.id, k.checkIns ?? []]));
  return (incoming ?? []).map((k) => {
    const { checkIns: _ignored, ...rest } = k ?? {};
    const kept = (prior.get(rest.id) ?? []).map((c) => ({ value: c.value, completed: c.completed, at: c.at, by: c.by }));
    return { ...rest, checkIns: kept };
  });
};

const fail = (res, status, message, code) => {
  res.status(status);
  const err = new Error(message);
  err.code = code;
  throw err;
};

/// Why [parentId] cannot be the parent of [okrId] (itself, a loop, not there), or null.
const parentProblem = async (okrId, parentId) => {
  if (!parentId) return null;
  if (okrId && String(parentId) === String(okrId)) return 'An objective cannot contribute to itself.';
  let cur = await OKR.findById(parentId).select('parentObjectiveId').lean();
  if (!cur) return 'The objective it should contribute to was not found.';
  for (let hops = 0; cur?.parentObjectiveId && hops < 50; hops += 1) {
    if (okrId && String(cur.parentObjectiveId) === String(okrId)) {
      return 'That would make a loop: the objective you picked already contributes to this one.';
    }
    cur = await OKR.findById(cur.parentObjectiveId).select('parentObjectiveId').lean();
  }
  return null;
};

// @desc    Get all OKRs with optional filters
// @route   GET /api/okrs
// @access  Private
export const getOKRs = asyncHandler(async (req, res) => {
  const { projectId, department, status, completed, search, scope } = req.query;
  const filter = {};

  // scope=company → only planning OKRs (company + department level), i.e. those
  // NOT tied to a specific project. Powers the Company Planning Dashboard.
  if (scope === 'company') {
    filter.projectId = null;
  } else if (projectId && projectId !== 'all') {
    filter.projectId = projectId;
  }
  if (department) {
    filter.department = department;
  }
  if (status) {
    filter.status = status;
  }
  if (completed === 'true') {
    filter.status = 'completed';
  } else if (completed === 'false') {
    filter.status = { $ne: 'completed' };
  }
  if (search) {
    filter.objective = { $regex: escapeRegex(search), $options: 'i' };
  }

  const okrs = await OKR.find(filter)
    .populate('projectHeadId', 'name email role department')
    .populate('projectId', 'name status targetDepartment')
    .sort({ order: 1, createdAt: 1 })
    .lean();

  // Scope results to what the caller may view: project OKRs follow project
  // access; company-wide are visible to all; department OKRs to that department.
  const visible = await filterViewableOKRs(req.user, okrs);
  const access = await accessForOKRs(req.user, visible);
  res.json(visible.map((o) => present(o, access.get(String(o._id)))));
});

// @desc    Get single OKR by ID
// @route   GET /api/okrs/:id
// @access  Private
export const getOKRById = asyncHandler(async (req, res) => {
  const okr = await OKR.findById(req.params.id)
    .populate('projectHeadId', 'name email role department')
    .lean();

  if (!okr) {
    res.status(404);
    throw new Error('OKR not found');
  }

  if (!(await canViewOKR(req.user, okr))) {
    res.status(403);
    throw new Error('You do not have access to this objective');
  }

  res.json(await presentFor(req.user, okr));
});

// @desc    Create new OKR / Key Result
// @route   POST /api/okrs
// @access  Private
export const createOKR = asyncHandler(async (req, res) => {
  const {
    projectId,
    department,
    level: requestedLevel,
    objective,
    description,
    projectHeadId,
    projectHeadName,
    startDate,
    deadline,
    status,
    priority,
    progress,
    keyResults,
    documents,
    parentObjectiveId,
    order,
  } = req.body;

  if (!objective || !String(objective).trim()) {
    res.status(400);
    throw new Error('Objective title is required');
  }

  // The level is explicit now. If the client doesn't say, it is worked out the way it
  // always was (a project's; else company-wide by its department text; else a department's).
  const level = requestedLevel || (projectId ? 'project' : isCompanyOKRDept(department) ? 'company' : 'department');
  if (!['company', 'department', 'project'].includes(level)) fail(res, 400, 'Level must be company, department or project.');
  if (level === 'project' && !projectId) fail(res, 400, 'A project objective needs a project.');
  if (level !== 'project' && projectId) fail(res, 400, 'Only a project objective belongs to a project.');
  if (level === 'department' && !String(department ?? '').trim()) fail(res, 400, 'A department objective needs a department.');
  const dept = level === 'company' ? department || 'company' : department || 'research-and-development';

  // Authorize against the TARGET scope: a project OKR needs project access; a
  // company-wide OKR needs leadership; a department OKR needs that dept's head.
  const target = { projectId: projectId || null, department: dept, level };
  if (!(await canManageOKR(req.user, target))) {
    res.status(403);
    throw new Error('You are not authorized to create an objective in this scope');
  }

  const parentIssue = await parentProblem(null, parentObjectiveId);
  if (parentIssue) fail(res, 400, parentIssue);
  if (parentObjectiveId) {
    const parent = await OKR.findById(parentObjectiveId).lean();
    if (!(await canViewOKR(req.user, parent))) fail(res, 400, 'The objective it should contribute to was not found.');
  }

  let headName = projectHeadName || '';
  if (projectHeadId && !headName) {
    const emp = await Employee.findById(projectHeadId);
    if (emp) headName = emp.name;
  }

  const krs = withHistory(Array.isArray(keyResults) ? keyResults : []);
  const okr = await OKR.create({
    projectId: projectId || null,
    department: dept,
    level,
    objective: String(objective).trim(),
    description: description || '',
    projectHeadId: projectHeadId || null,
    projectHeadName: headName,
    startDate: startDate ? new Date(startDate) : null,
    deadline: deadline ? new Date(deadline) : null,
    status: status || 'in-progress',
    priority: priority || 'high',
    progress: objectiveProgress(krs, progress),
    keyResults: krs,
    documents: Array.isArray(documents) ? documents : [],
    parentObjectiveId: parentObjectiveId || null,
    order: typeof order === 'number' ? order : 0,
  });

  res.status(201).json(await presentFor(req.user, okr));
});

// @desc    Update OKR / Key Result
// @route   PUT /api/okrs/:id    (send `expectedUpdatedAt` to refuse overwriting someone else's edit)
// @access  Private
export const updateOKR = asyncHandler(async (req, res) => {
  const okr = await OKR.findById(req.params.id);

  if (!okr) {
    res.status(404);
    throw new Error('OKR not found');
  }

  if (!(await canManageOKR(req.user, okr))) {
    res.status(403);
    throw new Error('You are not authorized to edit this objective');
  }

  const updates = req.body;

  // The editor opened this objective at a moment; if someone saved it since, saving
  // the whole thing now would silently undo their change.
  if (updates.expectedUpdatedAt) {
    const seen = new Date(updates.expectedUpdatedAt).getTime();
    if (Number.isFinite(seen) && Math.abs(seen - okr.updatedAt.getTime()) > 1) {
      fail(res, 409, 'Someone else changed this objective while you were editing it. Reload it and make your change again.', 'OKR_CONFLICT');
    }
  }

  if (updates.projectHeadId !== undefined) {
    okr.projectHeadId = updates.projectHeadId || null;
    if (updates.projectHeadName !== undefined) {
      okr.projectHeadName = updates.projectHeadName;
    } else if (updates.projectHeadId) {
      const emp = await Employee.findById(updates.projectHeadId);
      if (emp) okr.projectHeadName = emp.name;
    } else {
      okr.projectHeadName = '';
    }
  }

  if (updates.objective !== undefined) {
    const objective = String(updates.objective ?? '').trim();
    if (!objective) {
      res.status(400);
      throw new Error('Objective title is required');
    }
    okr.objective = objective;
  }
  if (updates.description !== undefined) okr.description = updates.description;
  if (updates.startDate !== undefined) okr.startDate = updates.startDate ? new Date(updates.startDate) : null;
  if (updates.deadline !== undefined) okr.deadline = updates.deadline ? new Date(updates.deadline) : null;
  if (updates.status !== undefined) okr.status = updates.status;
  if (updates.priority !== undefined) okr.priority = updates.priority;
  if (updates.progress !== undefined) okr.progress = Math.min(100, Math.max(0, Number(updates.progress)));
  if (updates.keyResults !== undefined) okr.keyResults = withHistory(updates.keyResults, okr.keyResults);
  if (updates.documents !== undefined) okr.documents = updates.documents;
  if (updates.order !== undefined) okr.order = updates.order;
  if (updates.parentObjectiveId !== undefined) {
    const parentId = updates.parentObjectiveId || null;
    const issue = await parentProblem(okr._id, parentId);
    if (issue) fail(res, 400, issue);
    okr.parentObjectiveId = parentId;
  }
  // A planning objective can be moved between company-wide and a department (a project
  // objective belongs to its project and never moves). Authorized against the NEW scope too.
  if (!okr.projectId && (updates.level !== undefined || updates.department !== undefined)) {
    const nextLevel =
      updates.level ??
      (updates.department !== undefined ? (isCompanyOKRDept(updates.department) ? 'company' : 'department') : levelOf(okr));
    if (!['company', 'department'].includes(nextLevel)) fail(res, 400, 'A planning objective is company-wide or a department\'s.');
    const nextDept = nextLevel === 'company' ? String(updates.department || 'company') : String(updates.department ?? okr.department ?? '').trim();
    if (nextLevel === 'department' && !nextDept) fail(res, 400, 'A department objective needs a department.');
    if (nextLevel !== levelOf(okr) || nextDept.toLowerCase() !== String(okr.department ?? '').toLowerCase()) {
      if (!(await canManageOKR(req.user, { projectId: null, department: nextDept, level: nextLevel }))) {
        fail(res, 403, 'You are not authorized to move this objective to that scope');
      }
      okr.level = nextLevel;
      okr.department = nextDept;
    }
  }
  // The level is stamped once (old objectives get it the first time they are saved).
  if (!okr.level) okr.level = levelOf(okr);
  // With key results, progress follows them; the typed number is only for an objective without any.
  okr.progress = objectiveProgress(okr.keyResults, okr.progress);

  const saved = await okr.save();
  res.json(await presentFor(req.user, saved));
});

// @desc    Report on ONE key result without rewriting the whole objective (so two people
//          updating different key results never overwrite each other).
// @route   PATCH /api/okrs/:id/key-results/:krId
//          { currentValue?, completed? }  — anyone who may report progress
//          { title?, metric?, targetValue?, unit? } — only who may edit the objective
// @access  Private
export const updateKeyResult = asyncHandler(async (req, res) => {
  const okr = await OKR.findById(req.params.id);
  if (!okr) {
    res.status(404);
    throw new Error('OKR not found');
  }
  const kr = okr.keyResults.find((k) => k.id === req.params.krId);
  if (!kr) {
    res.status(404);
    throw new Error('Key result not found');
  }

  const PLAN = ['title', 'metric', 'targetValue', 'unit'];
  const body = req.body ?? {};
  const touchesPlan = PLAN.some((f) => f in body);
  const allowed = touchesPlan ? await canManageOKR(req.user, okr) : await canCheckInOKR(req.user, okr);
  if (!allowed) {
    res.status(403);
    throw new Error(
      touchesPlan
        ? 'Only the people who manage this objective can change what a key result measures. You can update its progress.'
        : 'You are not allowed to update this objective',
    );
  }

  const before = { value: kr.currentValue, completed: kr.completed };
  if ('currentValue' in body) {
    const n = Number(body.currentValue);
    if (!Number.isFinite(n)) fail(res, 400, 'Current value must be a number.');
    kr.currentValue = n;
  }
  if ('completed' in body) kr.completed = body.completed === true;
  if ('title' in body) {
    const t = String(body.title ?? '').trim();
    if (!t) fail(res, 400, 'A key result needs a title.');
    kr.title = t;
  }
  if ('metric' in body) kr.metric = String(body.metric ?? '');
  if ('unit' in body) kr.unit = String(body.unit ?? '');
  if ('targetValue' in body) {
    const n = Number(body.targetValue);
    if (!Number.isFinite(n) || n <= 0) fail(res, 400, 'The target must be a number above 0.');
    kr.targetValue = n;
  }

  // A report that changes where it stands is remembered (value, who, when) — the
  // timeline plots these; re-sending the same numbers adds nothing.
  if (kr.currentValue !== before.value || kr.completed !== before.completed) {
    kr.checkIns.push({ value: kr.currentValue, completed: kr.completed, at: new Date(), by: req.user?.name ?? '' });
    if (kr.checkIns.length > MAX_CHECK_INS) kr.checkIns.splice(0, kr.checkIns.length - MAX_CHECK_INS);
  }

  okr.progress = objectiveProgress(okr.keyResults, okr.progress);
  const saved = await okr.save();
  res.json(await presentFor(req.user, saved));
});

// @desc    Delete OKR / Key Result
// @route   DELETE /api/okrs/:id
// @access  Private
export const deleteOKR = asyncHandler(async (req, res) => {
  const okr = await OKR.findById(req.params.id);

  if (!okr) {
    res.status(404);
    throw new Error('OKR not found');
  }

  if (!(await canManageOKR(req.user, okr))) {
    res.status(403);
    throw new Error('You are not authorized to delete this objective');
  }

  // Objectives that contributed to this one move up a level (to what this one
  // contributed to) instead of being deleted with it, key results and all.
  const moved = await OKR.updateMany(
    { parentObjectiveId: okr._id },
    { $set: { parentObjectiveId: okr.parentObjectiveId ?? null } },
  );
  await okr.deleteOne();

  res.json({ message: 'OKR removed successfully', reparented: moved.modifiedCount ?? 0 });
});
