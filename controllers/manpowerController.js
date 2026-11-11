import mongoose from 'mongoose';
import Project from '../models/Project.js';
import Employee from '../models/Employee.js';
import Department from '../models/Department.js';
import User from '../models/User.js';
import LeaveRequest from '../models/LeaveRequest.js';
import ITTask from '../models/ITTask.js';
import HiringPlan from '../models/HiringPlan.js';
import ManpowerRequest from '../models/ManpowerRequest.js';
import ProjectAllocation from '../models/ProjectAllocation.js';
import { loadAccessContext, canViewProject, isProjectManager, isOwnerHead, departmentsLedBy, escapeRegex } from '../utils/projectAccess.js';
import { departmentsOf } from '../utils/projectDepartments.js';
import { resolveUserDeptName } from '../utils/departmentScope.js';
import { spendFor } from '../services/projectSpend.js';
import { spendingLimit, money, cleanAmount } from '../utils/projectCost.js';
import { recordActivity } from '../utils/projectActivity.js';
import { notify, NOTIFICATION_TYPES, getUserIdsByEmployeeIds } from '../utils/notify.js';
import {
  validateRequest,
  parseDay,
  loadOf,
  levelFor,
  seatsLeft,
  requestStatus,
  needsRelease,
  budgetRoom,
  canHandleManpower,
  mayRaise,
  isHrDepartment,
  OPEN_STATUSES,
  LINE_TYPES,
} from '../utils/manpower.js';

// Manpower requests: a project needs more people and HR sorts it out. The rules are in utils/manpower.js (pure); this is the
// database, the access checks and who is told.

const fail = (res, status, message, extra = {}) => res.status(status).json({ message, ...extra });
const idOf = (v) => String(v?._id ?? v ?? '');
const today = () => parseDay(new Date().toISOString());

// ── who is who ───────────────────────────────────────────────────────────────

const me = async (user) => {
  const deptName = await resolveUserDeptName(user);
  const role = String(user?.role ?? '').trim().toLowerCase();
  return {
    userId: idOf(user?._id),
    empId: user?.employeeId ? idOf(user.employeeId) : '',
    admin: role === 'admin',
    isHr: canHandleManpower({ role, deptName }),
    deptName,
    isHead: !!user?.isDepartmentHead,
    name: user?.name ?? '',
  };
};

/// Login accounts of HR: its head, and everyone in the HR department.
const hrUserIds = async () => {
  const depts = await Department.find({ name: /^(hr|human resources)$/i, active: { $ne: false } }).select('_id head').lean();
  const ids = new Set();
  const byDept = await User.find({ departmentId: { $in: depts.map((d) => d._id) }, active: { $ne: false } }).select('_id').lean();
  byDept.forEach((u) => ids.add(idOf(u._id)));
  const emps = await Employee.find({ department: /^(hr|human resources)$/i, status: { $ne: 'inactive' } }).select('_id').lean();
  const viaEmps = await getUserIdsByEmployeeIds([...emps.map((e) => e._id), ...depts.map((d) => d.head).filter(Boolean)]);
  viaEmps.forEach((u) => ids.add(idOf(u)));
  return [...ids];
};

/// Whoever asked, and the project manager.
const askers = async (r) => [r.requestedBy, ...(r.managerEmp ? await getUserIdsByEmployeeIds([r.managerEmp]) : [])].filter(Boolean);

const projectDepartmentNames = (project) => departmentsOf(project).filter((d) => d.status === 'accepted').map((d) => d.name);

// ── how a request looks to the app ───────────────────────────────────────────

const lineView = (l) => ({
  id: String(l._id),
  type: l.type,
  state: l.state,
  seats: l.seats ?? 1,
  filled: l.filled ?? 0,
  employeeId: idOf(l.employeeId),
  employeeName: l.employeeName ?? '',
  employeeDept: l.employeeDept ?? '',
  percent: l.percent ?? 0,
  from: l.from ?? null,
  to: l.to ?? null,
  hiringPlanId: idOf(l.hiringPlanId),
  vendorName: l.vendorName ?? '',
  cost: l.cost ?? 0,
  note: l.note ?? '',
  releaseNote: l.releaseNote ?? '',
});

const staffed = (r) => r.lines.some((l) => ['assigned', 'hiring', 'awaiting_release'].includes(l.state));

const view = (r, who) => {
  const open = OPEN_STATUSES.includes(r.status);
  const isAsker = who.userId === idOf(r.requestedBy) || (!!who.empId && who.empId === idOf(r.managerEmp));
  const ownerHead = who.isHead && !!who.deptName && who.deptName.toLowerCase() === String(r.department ?? '').toLowerCase();
  return {
    id: String(r._id),
    projectId: idOf(r.projectId),
    projectName: r.projectName ?? '',
    department: r.department ?? '',
    requestedByName: r.requestedByName ?? '',
    requestedAt: r.createdAt,
    roleTitle: r.roleTitle,
    skills: r.skills ?? '',
    headcount: r.headcount,
    startDate: r.startDate,
    endDate: r.endDate,
    allocationPercent: r.allocationPercent,
    urgency: r.urgency,
    reason: r.reason ?? '',
    estimatedCost: r.estimatedCost ?? 0,
    status: r.status,
    seatsLeft: seatsLeft(r.headcount, r.lines),
    lines: r.lines.map(lineView),
    hrOwnerName: r.hrOwnerName ?? '',
    decisionNote: r.decisionNote ?? '',
    decidedAt: r.decidedAt ?? null,
    access: {
      canHandle: who.isHr && open,
      canCancel: open && (isAsker || ownerHead || who.admin) && !staffed(r),
      // the lines this person has to answer (they are the head of the person's department)
      releasable: r.lines.filter((l) => l.state === 'awaiting_release' && (who.admin || (!!who.empId && who.empId === idOf(l.releaseHeadEmp)))).map((l) => String(l._id)),
    },
  };
};

// ── people's time and what is left of the budget ─────────────────────────────

/// For each employee id: how much of their time is spoken for in [from, to], whether they are on leave, and their open tasks.
const workload = async (employeeIds, from, to) => {
  const ids = employeeIds.map(String);
  const oids = ids.filter((i) => mongoose.isValidObjectId(i)).map((i) => new mongoose.Types.ObjectId(i));
  const out = new Map(ids.map((i) => [i, { load: 0, onLeave: false, openTasks: 0 }]));
  if (oids.length === 0) return out;
  const allocs = await ProjectAllocation.find({ employeeId: { $in: oids }, status: 'active', from: { $lte: to }, to: { $gte: from } }).lean();
  for (const i of ids) out.get(i).load = loadOf(allocs.filter((a) => idOf(a.employeeId) === i), from, to);
  const leaves = await LeaveRequest.find({ employeeId: { $in: oids }, status: 'approved', fromDate: { $lte: to }, toDate: { $gte: from } }).select('employeeId').lean();
  for (const l of leaves) {
    const row = out.get(idOf(l.employeeId));
    if (row) row.onLeave = true;
  }
  const tasks = await ITTask.aggregate([
    { $match: { assignedTo: { $in: oids }, percentComplete: { $lt: 100 }, status: { $nin: ['closed', 'deployed', 'completed', 'done'] } } },
    { $group: { _id: '$assignedTo', n: { $sum: 1 } } },
  ]);
  for (const t of tasks) {
    const row = out.get(idOf(t._id));
    if (row) row.openTasks = t.n;
  }
  return out;
};

/// What the money seats of the project's requests have already taken (hires and contractors not yet refused), so the same
/// rupees are not promised twice.
const plannedManpowerCost = async (projectId) => {
  const rows = await ManpowerRequest.find({ projectId, status: { $in: OPEN_STATUSES.concat('fulfilled') } })
    .select('lines')
    .lean();
  let paise = 0;
  for (const r of rows) for (const l of r.lines) if (l.state !== 'refused' && (l.type === 'hire' || l.type === 'contract')) paise += Math.round((Number(l.cost) || 0) * 100);
  return paise / 100;
};

const roomFor = async (project, cost) => {
  const spend = await spendFor(project);
  const planned = await plannedManpowerCost(project._id);
  return budgetRoom({ limit: spendingLimit(project), used: spend.used + planned, cost });
};

/// Puts a person on the project: an allocation, and they become a member (so they see it and can be given tasks).
const placeOnProject = async ({ project, request, line, employee, percent, from, to, user }) => {
  await ProjectAllocation.create({
    projectId: project._id,
    employeeId: employee._id,
    employeeName: employee.name,
    role: request.roleTitle,
    percent,
    from,
    to,
    requestId: request._id,
    lineId: line._id,
    createdByName: user?.name ?? '',
  });
  const doc = await Project.findById(project._id);
  if (doc) {
    doc.members.addToSet(employee._id);
    recordActivity(doc, 'manpower', `${employee.name} joined the project as ${request.roleTitle} (${percent}% of their time)`, user);
    await doc.save();
  }
};

/// Is this person already on the request — as a seat of its own, or because they joined through a hire?
const alreadyOnRequest = async (request, employeeId) =>
  request.lines.some((l) => l.state !== 'refused' && idOf(l.employeeId) === idOf(employeeId)) ||
  !!(await ProjectAllocation.exists({ requestId: request._id, employeeId, status: 'active' }));

const employeeDeptName = async (employee) => {
  if (employee.departmentId) {
    const d = await Department.findById(employee.departmentId).select('name').lean();
    if (d?.name) return d.name;
  }
  return employee.department ?? '';
};

/// The head (an Employee id) who has to let [employee] go, or null when there is none (no department, no head, or the person is the head).
const releaseHeadOf = async (employee, deptName) => {
  const dept = employee.departmentId ? await Department.findById(employee.departmentId).select('head').lean() : await Department.findOne({ name: new RegExp(`^${escapeRegex(deptName)}$`, 'i') }).select('head').lean();
  const head = dept?.head ? idOf(dept.head) : '';
  return head && head !== idOf(employee._id) ? head : null;
};

// ── asking ───────────────────────────────────────────────────────────────────

// @desc    A project asks for more people
// @route   POST /api/projects/:id/manpower
export const createManpowerRequest = async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return fail(res, 404, 'Project not found');
    const project = await Project.findById(req.params.id);
    if (!project) return fail(res, 404, 'Project not found');
    if (['proposed', 'cancelled'].includes(project.status)) return fail(res, 409, `${project.name} is ${project.status === 'proposed' ? 'still a proposal' : 'cancelled'}.`, { code: 'PROJECT_CLOSED' });

    const ctx = await loadAccessContext(req.user);
    const manage = !ctx.viewOnly && (ctx.full || isProjectManager(project, ctx) || isOwnerHead(project, ctx));
    const leads = !ctx.viewOnly && departmentsLedBy(project, ctx, { acceptedOnly: true }).length > 0;
    if (!mayRaise({ manage, leadsDepartment: leads })) return fail(res, 403, 'Only the project manager, the owning head or the lead of a department on the project can ask for more people.');

    const v = validateRequest(req.body ?? {});
    if (v.error) return fail(res, 400, v.error, { code: v.code });

    const request = await ManpowerRequest.create({
      projectId: project._id,
      projectName: project.name,
      department: project.targetDepartment,
      managerEmp: project.managerId ?? null,
      requestedBy: req.user._id,
      requestedByName: req.user.name ?? '',
      ...v,
    });

    recordActivity(project, 'manpower', `${v.headcount} ${v.roleTitle}${v.headcount === 1 ? '' : 's'} asked of HR`, req.user);
    await project.save();

    await notify({
      recipients: await hrUserIds(),
      type: NOTIFICATION_TYPES.MANPOWER_REQUEST,
      title: `${v.urgency === 'urgent' ? 'Urgent: ' : ''}${v.headcount} ${v.roleTitle} needed for ${project.name}`,
      body: `${project.targetDepartment} asks for ${v.headcount} ${v.roleTitle}${v.headcount === 1 ? '' : 's'} at ${v.allocationPercent}% of their time. ${v.reason}`,
      link: '/manpower',
      createdBy: req.user._id,
      excludeUserId: req.user._id,
    });

    const who = await me(req.user);
    const room = v.estimatedCost > 0 ? await roomFor(project, v.estimatedCost) : null;
    res.status(201).json({ ...view(request, who), budget: room });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ── listing ──────────────────────────────────────────────────────────────────

// @desc    Manpower requests: all of them for HR; for everyone else the ones they asked, run, own or have to answer
// @route   GET /api/manpower?scope=open|done|all&projectId=
export const getManpowerRequests = async (req, res) => {
  try {
    const who = await me(req.user);
    const and = [];
    const scope = String(req.query.scope ?? 'all');
    if (scope === 'open') and.push({ status: { $in: OPEN_STATUSES } });
    if (scope === 'done') and.push({ status: { $nin: OPEN_STATUSES } });
    if (req.query.projectId && mongoose.isValidObjectId(req.query.projectId)) and.push({ projectId: req.query.projectId });
    if (!who.isHr) {
      const or = [{ requestedBy: req.user._id }];
      if (who.empId) or.push({ managerEmp: who.empId }, { 'lines.releaseHeadEmp': who.empId });
      if (who.isHead && who.deptName) or.push({ department: new RegExp(`^${escapeRegex(who.deptName)}$`, 'i') });
      and.push({ $or: or });
    }
    const rows = await ManpowerRequest.find(and.length ? { $and: and } : {}).sort({ createdAt: -1 }).limit(300).lean();
    const out = rows.map((r) => view(r, who));
    // urgent first, then the oldest waiting
    const rank = (r) => (OPEN_STATUSES.includes(r.status) ? (r.urgency === 'urgent' ? 0 : 1) : 2);
    out.sort((a, b) => rank(a) - rank(b) || (rank(a) === 2 ? new Date(b.requestedAt) - new Date(a.requestedAt) : new Date(a.requestedAt) - new Date(b.requestedAt)));
    res.json(out);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const loadFor = async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    fail(res, 404, 'Request not found');
    return null;
  }
  const r = await ManpowerRequest.findById(req.params.id);
  if (!r) fail(res, 404, 'Request not found');
  return r;
};

// ── HR answers ───────────────────────────────────────────────────────────────

// @desc    HR covers seats: with people on staff, a hire or a contractor
// @route   POST /api/manpower/:id/handle   { lines: [...], assignAnyway?: boolean }
export const handleManpowerRequest = async (req, res) => {
  try {
    const who = await me(req.user);
    if (!who.isHr) return fail(res, 403, 'Only HR handles manpower requests.');
    const request = await loadFor(req, res);
    if (!request) return;
    if (!OPEN_STATUSES.includes(request.status)) return fail(res, 409, `This request is ${request.status}.`, { code: 'NOT_OPEN' });
    const project = await Project.findById(request.projectId);
    if (!project) return fail(res, 409, 'The project is not there any more.', { code: 'PROJECT_GONE' });

    const asked = Array.isArray(req.body?.lines) ? req.body.lines : [];
    if (asked.length === 0 || asked.length > 20) return fail(res, 400, 'Say how the seats are to be covered.', { code: 'LINES_REQUIRED' });
    const assignAnyway = req.body?.assignAnyway === true;

    // ── check every line first, so a mistake in the last one does not leave the first half done ──
    const left = seatsLeft(request.headcount, request.lines);
    const deptNames = projectDepartmentNames(project);
    const prepared = [];
    let seatsAsked = 0;
    let extraCost = 0;
    for (const raw of asked) {
      const type = String(raw?.type ?? '');
      if (!LINE_TYPES.includes(type)) return fail(res, 400, 'Each seat is covered by a person on staff, a hire or a contractor.', { code: 'LINE_TYPE_INVALID' });

      if (type === 'internal') {
        if (!mongoose.isValidObjectId(raw.employeeId)) return fail(res, 400, 'Choose the person.', { code: 'EMPLOYEE_INVALID' });
        const employee = await Employee.findById(raw.employeeId);
        if (!employee || employee.status === 'inactive') return fail(res, 400, 'That person is not on the staff list.', { code: 'EMPLOYEE_INVALID' });
        const dup = (await alreadyOnRequest(request, employee._id)) || prepared.some((p) => p.employee && idOf(p.employee._id) === idOf(employee._id));
        if (dup) return fail(res, 409, `${employee.name} is already on this request.`, { code: 'ALREADY_ON_REQUEST' });
        const percent = raw.percent === undefined || raw.percent === '' ? request.allocationPercent : Number(raw.percent);
        if (!Number.isInteger(percent) || percent < 5 || percent > 100) return fail(res, 400, 'How much of their time: between 5% and 100%.', { code: 'ALLOCATION_INVALID' });
        const from = parseDay(raw.from) ?? request.startDate;
        const to = parseDay(raw.to) ?? request.endDate;
        if (to < from) return fail(res, 400, 'The end date is before the start date.', { code: 'DATES_INVALID' });
        const w = (await workload([employee._id], from, to)).get(idOf(employee._id));
        if (levelFor({ load: w.load, add: percent, onLeave: w.onLeave }) === 'busy' && !assignAnyway) {
          return fail(res, 409, `${employee.name} ${w.onLeave ? 'is on leave then' : `already has ${w.load}% of their time on other projects then`}. Assign anyway?`, {
            code: 'MANPOWER_CONFLICT',
            employeeId: idOf(employee._id),
            employeeName: employee.name,
            load: w.load,
            percent,
            onLeave: w.onLeave,
          });
        }
        const deptName = await employeeDeptName(employee);
        const headEmp = needsRelease({ employeeDept: deptName, projectDepartments: deptNames }) ? await releaseHeadOf(employee, deptName) : null;
        seatsAsked += 1;
        prepared.push({ type, employee, deptName, percent, from, to, headEmp, note: String(raw.note ?? '').trim().slice(0, 200) });
        continue;
      }

      const seats = raw.seats === undefined || raw.seats === '' ? 1 : Number(raw.seats);
      if (!Number.isInteger(seats) || seats < 1) return fail(res, 400, 'How many seats this covers must be a whole number.', { code: 'SEATS_INVALID' });
      const cost = raw.cost === undefined || raw.cost === '' ? 0 : cleanAmount(raw.cost);
      if (cost === null) return fail(res, 400, 'The cost must be a number.', { code: 'COST_INVALID' });
      if (type === 'contract' && String(raw.vendorName ?? '').trim().length < 2) return fail(res, 400, 'Say who the contractor is.', { code: 'VENDOR_REQUIRED' });
      seatsAsked += seats;
      extraCost += cost;
      prepared.push({ type, seats, cost, vendorName: String(raw.vendorName ?? '').trim().slice(0, 120), note: String(raw.note ?? '').trim().slice(0, 200), designation: String(raw.designation ?? '').trim() });
    }
    if (seatsAsked > left) {
      return fail(res, 409, left === 0 ? 'Every seat of this request is already covered.' : `Only ${left} seat${left === 1 ? ' is' : 's are'} left on this request.`, { code: 'NO_SEATS_LEFT', seatsLeft: left });
    }
    // a seat that costs money must fit what is left of the project's approved budget
    if (extraCost > 0) {
      const room = await roomFor(project, extraCost);
      if (room.short) {
        return fail(
          res,
          409,
          room.available > 0 || spendingLimit(project) > 0
            ? `The project has ${money(Math.max(room.available, 0))} of its approved budget left, and this costs ${money(extraCost)}. The project manager has to raise the project's cost first (the finance head approves it).`
            : 'The project has no approved budget yet. The project manager has to set its cost first (the finance head approves it).',
          { code: 'NEEDS_BUDGET', shortfall: room.shortfall, available: Math.max(room.available, 0) },
        );
      }
    }

    // ── apply ──
    const heads = [];
    for (const p of prepared) {
      if (p.type === 'internal') {
        const line = {
          type: 'internal',
          state: p.headEmp ? 'awaiting_release' : 'assigned',
          seats: 1,
          filled: p.headEmp ? 0 : 1,
          employeeId: p.employee._id,
          employeeName: p.employee.name,
          employeeDept: p.deptName,
          percent: p.percent,
          from: p.from,
          to: p.to,
          releaseHeadEmp: p.headEmp,
          note: p.note,
          addedByName: who.name,
        };
        request.lines.push(line);
        const added = request.lines[request.lines.length - 1];
        if (p.headEmp) heads.push({ headEmp: p.headEmp, employee: p.employee });
        else await placeOnProject({ project, request, line: added, employee: p.employee, percent: p.percent, from: p.from, to: p.to, user: req.user });
      } else if (p.type === 'hire') {
        const plan = await HiringPlan.create({
          designation: p.designation || request.roleTitle,
          department: request.department,
          openings: p.seats,
          businessJustification: `${request.reason} — for the project "${request.projectName}" (manpower request).`,
          requiredSkills: request.skills,
          status: 'raised',
          raisedAt: new Date(),
          createdBy: req.user._id,
        });
        request.lines.push({ type: 'hire', state: 'hiring', seats: p.seats, filled: 0, cost: p.cost, hiringPlanId: plan._id, note: p.note, addedByName: who.name });
      } else {
        request.lines.push({ type: 'contract', state: 'assigned', seats: p.seats, filled: p.seats, cost: p.cost, vendorName: p.vendorName, note: p.note, addedByName: who.name });
      }
    }
    if (!request.hrOwner) {
      request.hrOwner = req.user._id;
      request.hrOwnerName = who.name;
    }
    request.status = requestStatus({ status: request.status, headcount: request.headcount, lines: request.lines });
    await request.save();

    // tell the heads who have to let someone go, and whoever asked
    for (const h of heads) {
      await notify({
        recipients: await getUserIdsByEmployeeIds([h.headEmp]),
        type: NOTIFICATION_TYPES.MANPOWER_RELEASE,
        title: `HR asks to place ${h.employee.name} on ${request.projectName}`,
        body: `${request.roleTitle} at ${request.allocationPercent}% of their time. Open Manpower to let them go or say no.`,
        link: '/manpower',
        createdBy: req.user._id,
        excludeUserId: req.user._id,
      });
    }
    await notify({
      recipients: await askers(request),
      type: NOTIFICATION_TYPES.MANPOWER_UPDATE,
      title: request.status === 'fulfilled' ? `Manpower request fulfilled: ${request.roleTitle}` : `HR is on your request: ${request.roleTitle}`,
      body: prepared.map((p) => (p.type === 'internal' ? `${p.employee.name}${p.headEmp ? ' (waiting for their head to release them)' : ''}` : p.type === 'hire' ? `a new hire (${p.seats})` : `contractor ${p.vendorName}`)).join(', '),
      link: `/projects/${request.projectId}`,
      createdBy: req.user._id,
      excludeUserId: req.user._id,
    });

    res.json(view(request, who));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    The head of a person's department lets them go, or says no
// @route   POST /api/manpower/:id/lines/:lineId/release   { approve: boolean, note? }
export const releaseLine = async (req, res) => {
  try {
    const who = await me(req.user);
    const request = await loadFor(req, res);
    if (!request) return;
    const line = request.lines.id(req.params.lineId);
    if (!line) return fail(res, 404, 'That line is not on this request.');
    if (line.state !== 'awaiting_release') return fail(res, 409, 'Nobody is waiting for a release here.', { code: 'NOT_WAITING' });
    if (!who.admin && !(who.empId && who.empId === idOf(line.releaseHeadEmp))) return fail(res, 403, `Only the head of ${line.employeeDept || 'their department'} can let ${line.employeeName} go.`);
    if (typeof req.body?.approve !== 'boolean') return fail(res, 400, 'Say whether you let them go (true) or not (false).');
    const note = String(req.body?.note ?? '').trim().slice(0, 300);
    if (!req.body.approve && note.length < 3) return fail(res, 400, 'Say why they cannot be released.', { code: 'NOTE_REQUIRED' });

    line.releasedAt = new Date();
    line.releaseNote = note;
    if (req.body.approve) {
      const project = await Project.findById(request.projectId);
      const employee = await Employee.findById(line.employeeId);
      line.state = 'assigned';
      line.filled = 1;
      if (project && employee) await placeOnProject({ project, request, line, employee, percent: line.percent, from: line.from, to: line.to, user: req.user });
    } else {
      line.state = 'refused';
    }
    request.status = requestStatus({ status: request.status, headcount: request.headcount, lines: request.lines });
    await request.save();

    await notify({
      recipients: [...(request.hrOwner ? [request.hrOwner] : await hrUserIds()), ...(await askers(request))],
      type: NOTIFICATION_TYPES.MANPOWER_UPDATE,
      title: req.body.approve ? `${line.employeeName} was released to ${request.projectName}` : `${line.employeeName} cannot be released to ${request.projectName}`,
      body: req.body.approve ? note || `${line.employeeName} is on the project.` : `${note} — that seat is open again.`,
      link: '/manpower',
      createdBy: req.user._id,
      excludeUserId: req.user._id,
    });

    res.json(view(request, who));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    HR puts a new hire on the project once they have joined
// @route   POST /api/manpower/:id/lines/:lineId/allocate   { employeeId, percent?, from?, to?, assignAnyway? }
export const allocateHire = async (req, res) => {
  try {
    const who = await me(req.user);
    if (!who.isHr) return fail(res, 403, 'Only HR places a new hire on a project.');
    const request = await loadFor(req, res);
    if (!request) return;
    const line = request.lines.id(req.params.lineId);
    if (!line || line.type !== 'hire') return fail(res, 404, 'That is not a hire on this request.');
    if (line.state !== 'hiring') return fail(res, 409, 'Everyone for this hire is already placed.', { code: 'NOT_HIRING' });
    if (!mongoose.isValidObjectId(req.body?.employeeId)) return fail(res, 400, 'Choose who joined.', { code: 'EMPLOYEE_INVALID' });
    const employee = await Employee.findById(req.body.employeeId);
    if (!employee || employee.status === 'inactive') return fail(res, 400, 'That person is not on the staff list.', { code: 'EMPLOYEE_INVALID' });
    if (await alreadyOnRequest(request, employee._id)) return fail(res, 409, `${employee.name} is already on this request.`, { code: 'ALREADY_ON_REQUEST' });
    const project = await Project.findById(request.projectId);
    if (!project) return fail(res, 409, 'The project is not there any more.', { code: 'PROJECT_GONE' });

    const percent = req.body.percent === undefined || req.body.percent === '' ? request.allocationPercent : Number(req.body.percent);
    if (!Number.isInteger(percent) || percent < 5 || percent > 100) return fail(res, 400, 'How much of their time: between 5% and 100%.', { code: 'ALLOCATION_INVALID' });
    const from = parseDay(req.body.from) ?? request.startDate;
    const to = parseDay(req.body.to) ?? request.endDate;
    if (to < from) return fail(res, 400, 'The end date is before the start date.', { code: 'DATES_INVALID' });
    const w = (await workload([employee._id], from, to)).get(idOf(employee._id));
    if (levelFor({ load: w.load, add: percent, onLeave: w.onLeave }) === 'busy' && req.body.assignAnyway !== true) {
      return fail(res, 409, `${employee.name} already has ${w.load}% of their time on other projects then. Assign anyway?`, { code: 'MANPOWER_CONFLICT', employeeId: idOf(employee._id), employeeName: employee.name, load: w.load, percent, onLeave: w.onLeave });
    }

    await placeOnProject({ project, request, line, employee, percent, from, to, user: req.user });
    line.filled = (line.filled ?? 0) + 1;
    if (line.filled >= line.seats) line.state = 'assigned';
    request.status = requestStatus({ status: request.status, headcount: request.headcount, lines: request.lines });
    await request.save();
    await notify({
      recipients: await askers(request),
      type: NOTIFICATION_TYPES.MANPOWER_UPDATE,
      title: request.status === 'fulfilled' ? `Manpower request fulfilled: ${request.roleTitle}` : `${employee.name} joined ${request.projectName}`,
      body: `${employee.name} is on the project as ${request.roleTitle}.`,
      link: `/projects/${request.projectId}`,
      createdBy: req.user._id,
      excludeUserId: req.user._id,
    });
    res.json(view(request, who));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    HR cannot cover the request
// @route   POST /api/manpower/:id/decline   { note }
export const declineManpowerRequest = async (req, res) => {
  try {
    const who = await me(req.user);
    if (!who.isHr) return fail(res, 403, 'Only HR can decline a manpower request.');
    const request = await loadFor(req, res);
    if (!request) return;
    if (!OPEN_STATUSES.includes(request.status)) return fail(res, 409, `This request is ${request.status}.`, { code: 'NOT_OPEN' });
    if (staffed(request)) return fail(res, 409, 'Some seats are already covered, so it cannot be declined as a whole.', { code: 'ALREADY_PARTLY_STAFFED' });
    const note = String(req.body?.note ?? '').trim().slice(0, 500);
    if (note.length < 3) return fail(res, 400, 'Say why it cannot be covered.', { code: 'NOTE_REQUIRED' });
    request.status = 'declined';
    request.decisionNote = note;
    request.decidedAt = new Date();
    request.decidedByName = who.name;
    if (!request.hrOwner) {
      request.hrOwner = req.user._id;
      request.hrOwnerName = who.name;
    }
    await request.save();
    await notify({
      recipients: await askers(request),
      type: NOTIFICATION_TYPES.MANPOWER_UPDATE,
      title: `HR cannot cover: ${request.roleTitle} for ${request.projectName}`,
      body: note,
      link: `/projects/${request.projectId}`,
      createdBy: req.user._id,
      excludeUserId: req.user._id,
    });
    res.json(view(request, who));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Whoever asked takes the request back (before anyone is placed)
// @route   POST /api/manpower/:id/cancel
export const cancelManpowerRequest = async (req, res) => {
  try {
    const who = await me(req.user);
    const request = await loadFor(req, res);
    if (!request) return;
    const v = view(request, who);
    if (!OPEN_STATUSES.includes(request.status)) return fail(res, 409, `This request is ${request.status}.`, { code: 'NOT_OPEN' });
    const mine = who.userId === idOf(request.requestedBy) || (!!who.empId && who.empId === idOf(request.managerEmp));
    const ownerHead = who.isHead && !!who.deptName && who.deptName.toLowerCase() === String(request.department ?? '').toLowerCase();
    if (!(mine || ownerHead || who.admin)) return fail(res, 403, 'Only whoever asked, the project manager or the owning head can take this request back.');
    if (staffed(request)) return fail(res, 409, 'HR has already started covering it. Ask HR to change it.', { code: 'ALREADY_PARTLY_STAFFED' });
    request.status = 'cancelled';
    request.decidedAt = new Date();
    request.decidedByName = who.name;
    request.decisionNote = String(req.body?.note ?? '').trim().slice(0, 300);
    await request.save();
    if (request.hrOwner) {
      await notify({
        recipients: [request.hrOwner],
        type: NOTIFICATION_TYPES.MANPOWER_UPDATE,
        title: `Request withdrawn: ${request.roleTitle} for ${request.projectName}`,
        body: request.decisionNote || 'The project no longer needs it.',
        link: '/manpower',
        createdBy: req.user._id,
        excludeUserId: req.user._id,
      });
    }
    res.json({ ...v, ...view(request, who) });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ── HR looks for people ──────────────────────────────────────────────────────

// @desc    People on staff with how much of their time is spoken for in a window — for HR to choose from
// @route   GET /api/manpower/availability?from=&to=&percent=&q=&department=
export const getAvailability = async (req, res) => {
  try {
    const who = await me(req.user);
    if (!who.isHr) return fail(res, 403, 'Only HR looks across the staff for a manpower request.');
    const from = parseDay(req.query.from) ?? today();
    const to = parseDay(req.query.to) ?? from;
    if (to < from) return fail(res, 400, 'The end date is before the start date.', { code: 'DATES_INVALID' });
    const percent = Math.min(100, Math.max(0, Number(req.query.percent) || 100));
    const filter = { status: { $ne: 'inactive' } };
    if (req.query.q) filter.name = new RegExp(escapeRegex(String(req.query.q)), 'i');
    if (req.query.department && req.query.department !== 'all') filter.department = new RegExp(`^${escapeRegex(String(req.query.department))}$`, 'i');
    const employees = await Employee.find(filter).select('name department role').sort({ name: 1 }).limit(300).lean();
    const w = await workload(employees.map((e) => e._id), from, to);
    const rank = { free: 0, tight: 1, busy: 2 };
    const rows = employees.map((e) => {
      const x = w.get(idOf(e._id));
      return {
        id: idOf(e._id),
        name: e.name,
        department: e.department ?? '',
        role: e.role ?? '',
        load: x.load,
        onLeave: x.onLeave,
        openTasks: x.openTasks,
        level: levelFor({ load: x.load, add: percent, onLeave: x.onLeave }),
      };
    });
    rows.sort((a, b) => rank[a.level] - rank[b.level] || a.load - b.load || a.name.localeCompare(b.name));
    res.json(rows);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ── the project's team ───────────────────────────────────────────────────────

// @desc    Who HR has put on a project, for how much of their time and when (no money)
// @route   GET /api/projects/:id/team
export const getProjectTeam = async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return fail(res, 404, 'Project not found');
    const project = await Project.findById(req.params.id);
    if (!project) return fail(res, 404, 'Project not found');
    const who = await me(req.user);
    if (!who.isHr && !(await canViewProject(req.user, project))) return fail(res, 403, 'Access denied: you cannot view this project');
    const rows = await ProjectAllocation.find({ projectId: project._id }).sort({ from: 1, createdAt: 1 }).lean();
    const t = today();
    res.json(
      rows.map((a) => ({
        id: idOf(a._id),
        employeeId: idOf(a.employeeId),
        employeeName: a.employeeName,
        role: a.role,
        percent: a.percent,
        from: a.from,
        to: a.to,
        state: a.status === 'ended' || a.to < t ? 'ended' : a.from > t ? 'upcoming' : 'active',
      })),
    );
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export { isHrDepartment };
